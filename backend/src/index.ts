/**
 * NEMAR API - Cloudflare Workers Backend
 *
 * Handles user authentication, dataset management, and admin workflows.
 *
 * Production route: api.osc.earth/nemar/*
 * Dev route: nemar-api-dev.shirazi-10f.workers.dev/*
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";

import { optionalAuthMiddleware } from "./middleware/auth";
import { rateLimiter } from "./middleware/rateLimit";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { datasetRoutes } from "./routes/datasets";
import { sandboxRoutes } from "./routes/sandbox";
import { userRoutes } from "./routes/users";
import webhooks from "./routes/webhooks";
import { syncCatalog } from "./services/catalog-sync";
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

// Health check endpoint
api.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  });
});

// API info endpoint
api.get("/", (c) => {
  return c.json({
    name: "NEMAR API",
    version: "0.1.0",
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

// Create root app that mounts API at both /nemar (production) and / (dev)
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Mount at /nemar for production (api.osc.earth/nemar/*)
app.route("/nemar", api);

// Also mount at root for dev environment and workers.dev domain
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

/**
 * Scheduled catalog sync handler.
 * Pulls the full dataset catalog from nemar.org and indexes into D1 + Vectorize.
 */
async function scheduledCatalogSync(env: Bindings): Promise<void> {
  try {
    const result = await syncCatalog(env.DB, env.AI, env.VECTORIZE);
    console.log(
      `[catalog-sync] Completed: ${result.recordsSynced} synced, ${result.recordsIndexed} indexed, ${result.errors.length} errors, ${result.durationMs}ms`,
    );
  } catch (err) {
    console.error("[catalog-sync] Scheduled sync failed:", err);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    if (event.cron === "0 3 * * *") {
      ctx.waitUntil(scheduledCleanup(env));
    } else if (event.cron === "0 */4 * * *") {
      ctx.waitUntil(scheduledCatalogSync(env));
    } else {
      // Unknown cron, run both as fallback
      ctx.waitUntil(scheduledCleanup(env));
      ctx.waitUntil(scheduledCatalogSync(env));
    }
  },
};
