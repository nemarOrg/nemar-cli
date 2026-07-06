/**
 * NEMAR API - Cloudflare Workers Backend
 *
 * Handles user authentication, dataset management, and admin workflows.
 *
 * Production route: api.nemar.org (SCCN account)
 * Dev route: nemar-api-dev.sccn-org.workers.dev (SCCN account)
 * Legacy route: api.osc.earth/nemar (personal account, read-only buffer)
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";

// Single source of truth for the version. The worker reads the repo-root
// package.json (the npm-published CLI's manifest). backend/package.json is
// private and exists only for wrangler tooling; scripts/bump-version.sh
// keeps both in lockstep and asserts equality post-bump, so drift between
// the two manifests fails the bump rather than silently shipping.
import pkg from "../../package.json" with { type: "json" };
import { optionalAuthMiddleware } from "./middleware/auth";
import { maintenanceMode } from "./middleware/maintenance";
import { rateLimiter } from "./middleware/rateLimit";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { authOrcidRoutes } from "./routes/auth-orcid";
import { authWebRoutes } from "./routes/auth-web";
import { catalogIndexResponse, dataRoutes } from "./routes/data";
import { datasetRoutes } from "./routes/datasets";
import { sandboxRoutes } from "./routes/sandbox";
import { userRoutes } from "./routes/users";
import webhooks from "./routes/webhooks";
import { zarrDataRoutes } from "./routes/zarr-data";
import { archiveRetrySweep } from "./services/archive-retry";
import { AUTO_IMPORT_CRON, autoImportTick } from "./services/auto-import";
import { fetchAndSyncCitationCounts } from "./services/citation-counts-sync";
import { drainEmbeddingDirty } from "./services/dataset-search";
import { deleteDatasetCascade } from "./services/deletion";
import { reconcileReservedVersionDois } from "./services/doi-reconcile";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendStalenessAdminReviewEmail,
  sendStalenessWarningEmail,
} from "./services/email";
import { OPENNEURO_UPSTREAM_MARKER, runImportRecovery } from "./services/import-recovery";
import { getActiveNotices } from "./services/notices";
import { sweepBlockedBidsValidationRequests } from "./services/publication-sweep";
import {
  FIRST_WARNING_DAYS,
  STALENESS_LIMIT_DAYS,
  daysUntilDeletion,
  deletionDate,
  warningStageForDaysLeft,
} from "./services/staleness";
import type { Bindings, Variables } from "./types/bindings";

// Create the API app with all routes
const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Global middleware
api.use("*", logger());
api.use("*", secureHeaders());
api.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      try {
        const { hostname } = new URL(origin);
        // Allow localhost for development
        if (hostname === "localhost" || hostname === "127.0.0.1") return origin;
        // Allow nemar.org and osc.earth domains
        if (hostname === "nemar.org" || hostname.endsWith(".nemar.org")) return origin;
        if (hostname === "osc.earth" || hostname.endsWith(".osc.earth")) return origin;
      } catch (err) {
        console.warn(`CORS: rejected unparseable origin: ${origin}`, err);
      }
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-CLI-Version"],
    exposeHeaders: ["X-Request-Id"],
    credentials: true,
    maxAge: 86400,
  }),
);
api.use("*", rateLimiter);
api.use("*", maintenanceMode);

// Health check endpoint
api.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: pkg.version,
  });
});

// API info endpoint
api.get("/", (c) => {
  return c.json({
    name: "NEMAR API",
    version: pkg.version,
    description: "Backend API for NEMAR CLI",
    base_url: c.env.API_BASE_URL,
    endpoints: {
      auth: "/auth/*",
      users: "/users/*",
      admin: "/admin/*",
      datasets: "/datasets/*",
      sandbox: "/sandbox/*",
      webhooks: "/webhooks/*",
    },
  });
});

// Public notices endpoint (uses optional auth to filter by role)
api.get("/notices", optionalAuthMiddleware, async (c) => {
  try {
    const user = c.get("user");
    const notices = await getActiveNotices(c.env.DB, user?.role);
    return c.json({ notices });
  } catch (err) {
    console.error("[notices] Failed to fetch active notices:", err);
    return c.json({ notices: [] });
  }
});

// Mount route handlers
api.route("/auth", authRoutes);
// Web-dashboard auth (#569). Mounted at the same /auth prefix as the
// CLI flow; no path overlap with authRoutes (existing /signup, /login,
// /verify, etc. vs new /code/request, /code/verify, /logout, /me).
api.route("/auth", authWebRoutes);
// ORCID SSO (#832). Same /auth prefix; new paths under /auth/orcid/*.
api.route("/auth", authOrcidRoutes);
api.route("/users", userRoutes);
api.route("/admin", adminRoutes);
api.route("/datasets", datasetRoutes);
api.route("/sandbox", sandboxRoutes);
api.route("/webhooks", webhooks);
// Path-based mount of the data sub-app so it's reachable on every hostname
// (api.nemar.org, *.workers.dev dev fallback, etc.). The Worker also serves
// the same handlers at the root path when the request hits data.nemar.org;
// see the hostname fork in `app` below.
api.route("/data", dataRoutes);

// Hono v4 sub-app quirk: `dataRoutes.get("/")` mounted at `/data` only
// matches `/data` (no trailing slash). The trailing-slash form `/data/`
// is the natural directory-style URL machine clients append, so register
// the catalog handler directly here for that path. (The data.nemar.org
// dispatcher above normalizes its own root case before forwarding, so
// requests via the custom domain hit the sub-app form.)
api.get("/data/", (c) => catalogIndexResponse(c.env, c.req.raw));

// 404 handler
api.notFound((c) => {
  return c.json(
    {
      error: "Not Found",
      message: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404,
  );
});

// Global error handler
api.onError((err, c) => {
  console.error("Unhandled error:", err);

  // Check if it's a validation error from zValidator
  if (err.message.includes("Malformed") || err.message.includes("JSON")) {
    return c.json(
      {
        error: "Bad Request",
        message: "Invalid JSON in request body",
      },
      400,
    );
  }

  // Don't expose internal error details in production
  const isDev = c.env.API_BASE_URL?.includes("dev") || c.env.API_BASE_URL?.includes("localhost");

  return c.json(
    {
      error: "Internal Server Error",
      message: isDev ? err.message : "An unexpected error occurred",
    },
    500,
  );
});

// Mount the API at both / and /nemar so the same worker answers
// api.nemar.org/* (and *.workers.dev/*) at root and the legacy
// api.osc.earth/nemar/* prefix.
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// data.nemar.org dispatches to the data sub-app at root, so the public
// contract is `data.nemar.org/<id>/<version>/...` without a /data/ prefix.
// We rewrite the URL to /data/<rest> and re-enter `api.fetch` so the
// request inherits the full middleware stack (logger, secureHeaders, cors,
// rateLimiter, maintenanceMode) and the global `api.onError` sanitizer.
// Reading the hostname from c.req.url -- not the Host header -- prevents
// a forged Host: from steering an api.nemar.org request into this branch.
app.use("*", async (c, next) => {
  const host = new URL(c.req.url).hostname.toLowerCase();
  if (host === "data.nemar.org") {
    const url = new URL(c.req.url);
    // Mounted-root quirk: Hono v4 sub-apps treat `/data` (no trailing
    // slash) and `/data/` (trailing) as distinct match targets for
    // `dataRoutes.get("/")`. Only the no-trailing form matches the
    // mounted root, so naive `${"/data"}${"/"}` would 404 the most
    // common public URL on this host (`data.nemar.org/`). Normalize
    // the root path before prepending.
    url.pathname = url.pathname === "/" ? "/data" : `/data${url.pathname}`;
    return api.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
  }
  // zarr.nemar.org is the authoritative browser gateway for the Zarr serving
  // copies. It dispatches to a self-contained sub-app (its own restricted-origin
  // CORS, Range pass-through, and edge caching) rather than the api middleware
  // stack -- the global cors() allows *.nemar.org broadly, but the zarr host
  // must scope CORS tightly and expose Range/ETag headers zarrita needs.
  if (host === "zarr.nemar.org") {
    return zarrDataRoutes.fetch(c.req.raw, c.env, c.executionCtx);
  }
  return next();
});

// Dev / workers.dev access to the zarr proxy (prod uses the zarr.nemar.org host
// fork above). Must precede the catch-all api mount.
app.route("/zarrproxy", zarrDataRoutes);
app.route("/nemar", api);
app.route("/", api);

/**
 * Scheduled cleanup handler (Cloudflare Workers cron trigger).
 * Runs daily at 3 AM UTC (production only, see wrangler-sccn.toml [triggers]).
 *
 * - Sandbox (xx) datasets: delete after 14 days (disposable, auto-deleted).
 * - Stale nm datasets: private, no DOI, no active pub requests, inactive 90 days.
 *   These are NEVER auto-deleted (#662). The cron emails the owner an escalating
 *   warning runway (30/14/7/2/1 days) and, at the deadline, asks admins to
 *   delete manually via `nemar admin delete-dataset`. Real archive data is only
 *   ever removed by a deliberate human action.
 */
async function scheduledCleanup(env: Bindings): Promise<void> {
  const db = env.DB;
  const now = new Date();
  const results: Array<{
    dataset_id: string;
    success: boolean;
    error?: string;
    warnings?: string[];
  }> = [];
  const MAX_DELETIONS_PER_RUN = 10;

  /** Delete each dataset in `rows`, pushing outcomes into `results`. */
  async function deleteRows(rows: Array<{ dataset_id: string }>): Promise<void> {
    for (const row of rows) {
      try {
        const result = await deleteDatasetCascade(db, env, row.dataset_id, {});
        results.push({
          dataset_id: row.dataset_id,
          success: result.deleted,
          warnings: result.warnings.length > 0 ? result.warnings : undefined,
        });
      } catch (err) {
        results.push({
          dataset_id: row.dataset_id,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 1. Sandbox datasets older than 14 days
  try {
    const sandboxRows = await db
      .prepare(
        "SELECT dataset_id FROM datasets WHERE dataset_id LIKE 'xx%' AND created_at < datetime('now', '-14 days') AND status = 'active' LIMIT ?",
      )
      .bind(MAX_DELETIONS_PER_RUN)
      .all<{ dataset_id: string }>();

    await deleteRows(sandboxRows.results);
  } catch (err) {
    console.error("Scheduled cleanup: sandbox query failed:", err);
  }

  // 2. Stale nm datasets: warn the owner on an escalating runway, then hand
  //    off to admins for a manual delete. The cron NEVER auto-deletes nm
  //    datasets (#662) — removing real archive data always needs a human.
  //    Folded legacy catalog rows (#646) are excluded by the LIKE 'nm%' +
  //    visibility='private' filters below (sentinel rows are ds*/on* + public).
  const staleness = { warned: 0, adminNotified: 0, reset: 0 };
  // Datasets become warning candidates once within FIRST_WARNING_DAYS of the
  // 90-day deadline, i.e. inactive for at least (90 - 30) days.
  const warnWindow = `-${STALENESS_LIMIT_DAYS - FIRST_WARNING_DAYS} days`;
  try {
    // Reset tracking for anything no longer stale (fresh activity, a DOI, a
    // pending pub request, or made public) so a later cycle re-warns cleanly.
    const resetRes = await db
      .prepare(
        `UPDATE datasets
            SET staleness_warn_stage = NULL, staleness_admin_notified_at = NULL
          WHERE (staleness_warn_stage IS NOT NULL OR staleness_admin_notified_at IS NOT NULL)
            AND NOT (
              dataset_id LIKE 'nm%' AND status = 'active' AND concept_doi IS NULL
              AND visibility = 'private'
              AND COALESCE(last_activity_at, created_at) < datetime('now', ?)
              AND dataset_id NOT IN (
                SELECT dataset_id FROM publication_requests WHERE status NOT IN ('published','denied')
              )
            )`,
      )
      .bind(warnWindow)
      .run();
    staleness.reset = resetRes.meta.changes ?? 0;

    // Candidates inside the warning window, oldest (most urgent) first.
    // Already-handled past-deadline rows (admins already notified) are excluded
    // so a growing awaiting-deletion backlog can't fill the LIMIT and starve a
    // newly-past-deadline dataset out of ever reaching an admin.
    const MAX_STALE_EMAILS_PER_RUN = 30;
    const staleLimit = `-${STALENESS_LIMIT_DAYS} days`;
    const candidates = await db
      .prepare(
        `SELECT d.dataset_id, d.name,
                COALESCE(d.last_activity_at, d.created_at) AS effective_activity,
                d.staleness_warn_stage AS warn_stage,
                d.staleness_admin_notified_at AS admin_notified_at,
                u.email AS owner_email
           FROM datasets d
           LEFT JOIN users u ON u.id = d.owner_user_id
          WHERE d.dataset_id LIKE 'nm%' AND d.status = 'active' AND d.concept_doi IS NULL
            AND d.visibility = 'private'
            AND COALESCE(d.last_activity_at, d.created_at) < datetime('now', ?)
            AND d.dataset_id NOT IN (
              SELECT dataset_id FROM publication_requests WHERE status NOT IN ('published','denied')
            )
            AND NOT (
              COALESCE(d.last_activity_at, d.created_at) < datetime('now', ?)
              AND d.staleness_admin_notified_at IS NOT NULL
            )
          ORDER BY effective_activity ASC
          LIMIT ?`,
      )
      .bind(warnWindow, staleLimit, MAX_STALE_EMAILS_PER_RUN)
      .all<{
        dataset_id: string;
        name: string;
        effective_activity: string;
        warn_stage: number | null;
        admin_notified_at: string | null;
        owner_email: string | null;
      }>();

    if (candidates.results.length > 0) {
      const emailCfg = resolveEmailConfig(env);
      const canEmail = Boolean(env.RESEND_API_KEY);
      if (!canEmail) {
        console.error(
          "Scheduled cleanup: RESEND_API_KEY is not set — staleness notifications are skipped and will retry next run.",
        );
      }
      // Fetch admin emails in its own boundary: a D1 hiccup here must not abort
      // the per-dataset owner warnings below.
      let adminEmails: string[] = [];
      if (canEmail) {
        try {
          adminEmails = await getAdminEmailsForCategory(db, "publication_request");
        } catch (err) {
          console.error("Scheduled cleanup: failed to fetch admin emails:", err);
        }
      }

      for (const row of candidates.results) {
        // Per-row boundary: a single failing row must not abandon the rest.
        try {
          const daysLeft = daysUntilDeletion(row.effective_activity, now);

          if (daysLeft <= 0) {
            // Past the deadline: notify admins once, then leave it for a manual
            // `nemar admin delete-dataset`. Advance the flag ONLY when an admin
            // was actually reached, so a transient send failure or a missing
            // RESEND key retries next run instead of silently burying the
            // dataset (the failure mode that lost nm000111/116/117 one step up).
            if (!row.admin_notified_at) {
              let handled = false;
              if (!canEmail) {
                // Infra missing — leave unflagged so the next run retries.
              } else if (adminEmails.length === 0) {
                // No admins exist to notify; advance so we don't loop forever.
                handled = true;
              } else {
                const delivered = await sendStalenessAdminReviewEmail(
                  adminEmails,
                  row.dataset_id,
                  row.name,
                  row.owner_email,
                  row.warn_stage,
                  env.RESEND_API_KEY,
                  emailCfg.fromEmail,
                  emailCfg.replyTo,
                  emailCfg.isDev,
                );
                handled = delivered > 0;
              }
              if (handled) {
                await db
                  .prepare(
                    "UPDATE datasets SET staleness_admin_notified_at = datetime('now') WHERE dataset_id = ?",
                  )
                  .bind(row.dataset_id)
                  .run();
                staleness.adminNotified++;
              }
            }
            continue;
          }

          // Inside the window: email the owner once per threshold crossed.
          // Advance the stage ONLY when the warning was actually delivered (or
          // there is no owner address to reach), so a Resend outage retries.
          const stage = warningStageForDaysLeft(daysLeft);
          if (stage !== null && stage !== row.warn_stage) {
            let handled = false;
            if (!canEmail) {
              // Infra missing — leave the stage so the next run retries.
            } else if (!row.owner_email) {
              // No address to warn; advance so we move on (admins still get the
              // day-0 notice). Nothing to retry.
              handled = true;
            } else {
              try {
                await sendStalenessWarningEmail(
                  row.owner_email,
                  row.dataset_id,
                  row.name,
                  daysLeft,
                  deletionDate(row.effective_activity),
                  env.RESEND_API_KEY,
                  emailCfg.fromEmail,
                  emailCfg.replyTo,
                  emailCfg.isDev,
                );
                handled = true;
              } catch (err) {
                console.error(
                  `Scheduled cleanup: warning email failed for ${row.dataset_id}:`,
                  err,
                );
              }
            }
            if (handled) {
              await db
                .prepare("UPDATE datasets SET staleness_warn_stage = ? WHERE dataset_id = ?")
                .bind(stage, row.dataset_id)
                .run();
              staleness.warned++;
            }
          }
        } catch (err) {
          console.error(`Scheduled cleanup: failed processing ${row.dataset_id}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("Scheduled cleanup: stale dataset warning failed:", err);
  }

  // 3. Stuck manifest_jobs detection (#557). The central workflow is
  //    expected to call back within minutes; a row stuck in 'dispatched'
  //    for more than an hour means the workflow timed out, was
  //    cancelled, or the callback never landed. Operators page off
  //    these log lines -- no D1 mutation here, just visibility.
  try {
    const stuck = await db
      .prepare(
        `SELECT dataset_id, version, created_at FROM manifest_jobs
         WHERE status = 'dispatched' AND created_at < datetime('now', '-1 hour')`,
      )
      .all<{ dataset_id: string; version: string; created_at: string }>();

    if (stuck.results && stuck.results.length > 0) {
      console.error(
        `[manifest-cleanup] ${stuck.results.length} stuck manifest_jobs rows:`,
        stuck.results.map((r) => `${r.dataset_id}@${r.version} (${r.created_at})`).join(", "),
      );
    }
  } catch (err) {
    console.error("Scheduled cleanup: stuck manifest_jobs query failed:", err);
  }

  // 4. Stuck import_jobs (#754). An import row in an in-flight state that
  //    hasn't advanced in 6h means the workflow hit the 6h runner cap, crashed,
  //    or the report job / callback was lost (the on004395 orphan signature).
  //    Mark it failed, then run the SAME rollback-or-quarantine decision as the
  //    webhook so the orphan is surfaced (and, behind the flag, cleaned) instead
  //    of left silent. This is the durable backstop for the cases the report
  //    job can't cover: a whole-run operator-cancel (GitHub doesn't start a
  //    queued `if: always()` job), every callback failing, or the webhook's
  //    waitUntil recovery being dropped on Worker eviction.
  let importsSwept = 0;
  try {
    const stuckImports = await db
      .prepare(
        `SELECT dataset_id FROM import_jobs
         WHERE status IN ('preparing', 'copying', 'finalizing')
           AND updated_at < datetime('now', '-6 hours')
         LIMIT ?`,
      )
      .bind(MAX_DELETIONS_PER_RUN)
      .all<{ dataset_id: string }>();
    for (const row of stuckImports.results ?? []) {
      try {
        const upd = await db
          .prepare(
            // Preserve a sticky upstream marker (#808): a row can be in-flight
            // here yet already carry the OpenNeuro-inaccessible marker (a racing
            // finalize POST moved it off `failed` before the webhook's dropped
            // waitUntil recovery ran -- the very eviction case this sweep backstops).
            // Overwriting it would make runImportRecovery below misclassify the
            // upstream failure as a generic stuck import. [ ] are literal in LIKE.
            `UPDATE import_jobs
               SET status = 'failed',
                   last_error = CASE
                     WHEN last_error LIKE '%${OPENNEURO_UPSTREAM_MARKER}%' THEN last_error
                     ELSE 'stuck > 6h (scheduled sweep)' END,
                   completed_at = datetime('now'), updated_at = datetime('now')
             WHERE dataset_id = ? AND status IN ('preparing', 'copying', 'finalizing')`,
          )
          .bind(row.dataset_id)
          .run();
        if (upd.meta.changes > 0) {
          await runImportRecovery(db, env, row.dataset_id);
          importsSwept++;
        }
      } catch (err) {
        console.error(`[import-sweep] recovery for ${row.dataset_id} failed:`, err);
      }
    }
  } catch (err) {
    console.error("Scheduled cleanup: stuck import_jobs query failed:", err);
  }

  // 5. Re-evaluate publication requests blocked on BIDS validation (#428). A
  //    request blocked while CI was pending/running never re-checked itself when
  //    CI later went green, so requests sat in 'blocked' indefinitely. Re-read
  //    the latest run for each and transition: green -> 'requested', failing ->
  //    'bids_validation_failed'. Defense-in-depth; never throws.
  let blockedSweep = { scanned: 0, unblocked: 0, reblocked: 0, errors: 0 };
  try {
    blockedSweep = await sweepBlockedBidsValidationRequests(env);
  } catch (err) {
    console.error("Scheduled cleanup: blocked publication-request sweep failed:", err);
  }

  // Log summary to audit_log. `deleted`/`failed` cover only sandbox (xx)
  // datasets now; nm datasets are warned, not deleted, by this job.
  const deleted = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  try {
    await db
      .prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
      .bind(
        "scheduled_cleanup",
        JSON.stringify({
          deleted,
          failed,
          datasets: results,
          staleness,
          importsSwept,
          blockedSweep,
        }),
      )
      .run();
  } catch (err) {
    console.error("Scheduled cleanup: failed to write audit log:", err);
  }
  console.log(
    `Scheduled cleanup: ${deleted} deleted, ${failed} failed; staleness warned=${staleness.warned} adminNotified=${staleness.adminNotified} reset=${staleness.reset}; importsSwept=${importsSwept}; blockedSweep unblocked=${blockedSweep.unblocked} reblocked=${blockedSweep.reblocked} errors=${blockedSweep.errors}`,
  );
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    // Two cron schedules share this handler; branch on which one fired so the
    // daily jobs don't run on the frequent auto-import tick (#775). The
    // frequent tick self-gates to ~90 min, so it's cheap on the off-ticks.
    if (event.cron === AUTO_IMPORT_CRON) {
      ctx.waitUntil(
        autoImportTick(env).catch((err) =>
          // Log the stack on an unattended tick so the failing call is locatable
          // in Workers logs, not just the message (#784 review).
          console.error(
            "[auto-import] tick failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          ),
        ),
      );
      return;
    }
    // Daily (0 3 * * *):
    // Catalog sync runs via GitHub Action, not Worker cron
    ctx.waitUntil(scheduledCleanup(env));
    // #646 Phase 4: drain stale vectors (embedding_dirty=1) — the backstop for
    // changes that don't go through the inline enrich/reindex re-embed.
    ctx.waitUntil(drainEmbeddingDirty(env.DB, env.AI, env.VECTORIZE));
    // #736 Phase 3: backstop re-dispatch of still-failed archive generations
    // whose webhook retry chain broke (e.g. a lost archive-ready callback).
    ctx.waitUntil(archiveRetrySweep(env));
    // #900: backstop for a version-DOI mint that crashed after createIdentifier
    // (reserved) but before makePublic, leaving a permanent non-resolving DOI.
    ctx.waitUntil(reconcileReservedVersionDois(env));
    // #804: refresh per-dataset citation counts from the citations dashboard
    // manifest so GET /datasets?sort=citations and the listing pills reflect the
    // latest pipeline run. Best-effort; a dashboard outage just skips this tick.
    ctx.waitUntil(
      fetchAndSyncCitationCounts(env.DB)
        .then((r) =>
          console.log(
            `[citation-sync] fetched ${r.fetched}, updated ${r.updated}, skipped ${r.skipped}`,
          ),
        )
        .catch((err) =>
          console.error(
            "[citation-sync] failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          ),
        ),
    );
  },
};
