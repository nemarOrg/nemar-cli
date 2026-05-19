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
import { dataRoutes } from "./routes/data";
import { datasetRoutes } from "./routes/datasets";
import { sandboxRoutes } from "./routes/sandbox";
import { userRoutes } from "./routes/users";
import webhooks from "./routes/webhooks";
import { deleteDatasetCascade } from "./services/deletion";
import { getActiveNotices } from "./services/notices";
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
    url.pathname = `/data${url.pathname}`;
    return api.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
  }
  return next();
});

app.route("/nemar", api);
app.route("/", api);

/**
 * Scheduled cleanup handler (Cloudflare Workers cron trigger).
 * Runs daily at 3 AM UTC (production only, see wrangler.toml [triggers]).
 *
 * - Sandbox (xx) datasets: delete after 14 days
 * - Stale nm datasets: private, no DOI, no active pub requests, inactive for 90 days
 */
async function scheduledCleanup(env: Bindings): Promise<void> {
  const db = env.DB;
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

  // 2. Stale nm datasets: unpublished, no DOI, inactive for 90 days
  const remaining = MAX_DELETIONS_PER_RUN - results.length;
  if (remaining > 0) {
    try {
      const staleRows = await db
        .prepare(
          "SELECT dataset_id FROM datasets WHERE dataset_id LIKE 'nm%' AND COALESCE(last_activity_at, created_at) < datetime('now', '-90 days') AND status = 'active' AND concept_doi IS NULL AND visibility = 'private' AND dataset_id NOT IN (SELECT dataset_id FROM publication_requests WHERE status NOT IN ('published', 'denied')) LIMIT ?",
        )
        .bind(remaining)
        .all<{ dataset_id: string }>();

      await deleteRows(staleRows.results);
    } catch (err) {
      console.error("Scheduled cleanup: stale datasets query failed:", err);
    }
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

  // Log summary to audit_log
  const deleted = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  try {
    await db
      .prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
      .bind("scheduled_cleanup", JSON.stringify({ deleted, failed, datasets: results }))
      .run();
  } catch (err) {
    console.error("Scheduled cleanup: failed to write audit log:", err);
  }
  console.log(`Scheduled cleanup: ${deleted} deleted, ${failed} failed`);
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    // Catalog sync runs via GitHub Action, not Worker cron
    ctx.waitUntil(scheduledCleanup(env));
  },
};
