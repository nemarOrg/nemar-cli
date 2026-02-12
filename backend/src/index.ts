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

import { rateLimiter } from "./middleware/rateLimit";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { datasetRoutes } from "./routes/datasets";
import { sandboxRoutes } from "./routes/sandbox";
import { userRoutes } from "./routes/users";
import webhooks from "./routes/webhooks";
import { deleteDatasetCascade } from "./services/deletion";
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
      // Allow localhost for development
      if (origin?.includes("localhost")) return origin;
      // Allow nemar.org and osc.earth domains
      if (origin?.endsWith(".nemar.org") || origin === "https://nemar.org") {
        return origin;
      }
      if (origin?.endsWith(".osc.earth") || origin === "https://osc.earth") {
        return origin;
      }
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
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
 * Runs daily at 3 AM UTC.
 *
 * - Sandbox (xx) datasets: delete after 14 days
 * - Stale nm datasets: delete unpublished, no-DOI datasets inactive for 90 days
 */
async function scheduledCleanup(env: Bindings): Promise<void> {
  const db = env.DB;
  const results: Array<{ dataset_id: string; success: boolean; error?: string }> = [];

  // 1. Sandbox datasets older than 14 days
  const sandboxRows = await db
    .prepare(
      "SELECT dataset_id FROM datasets WHERE dataset_id LIKE 'xx%' AND created_at < datetime('now', '-14 days') AND status = 'active'",
    )
    .all<{ dataset_id: string }>();

  for (const row of sandboxRows.results) {
    try {
      const result = await deleteDatasetCascade(db, env, row.dataset_id, {});
      results.push({ dataset_id: row.dataset_id, success: result.deleted });
    } catch (err) {
      results.push({
        dataset_id: row.dataset_id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Stale nm datasets: unpublished, no DOI, inactive for 90 days
  const staleRows = await db
    .prepare(
      "SELECT dataset_id FROM datasets WHERE dataset_id LIKE 'nm%' AND COALESCE(last_activity_at, created_at) < datetime('now', '-90 days') AND status = 'active' AND concept_doi IS NULL AND visibility = 'private'",
    )
    .all<{ dataset_id: string }>();

  for (const row of staleRows.results) {
    try {
      const result = await deleteDatasetCascade(db, env, row.dataset_id, {});
      results.push({ dataset_id: row.dataset_id, success: result.deleted });
    } catch (err) {
      results.push({
        dataset_id: row.dataset_id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Log summary to audit_log
  if (results.length > 0) {
    const deleted = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    await db
      .prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
      .bind("scheduled_cleanup", JSON.stringify({ deleted, failed, datasets: results }))
      .run();
    console.log(`Scheduled cleanup: ${deleted} deleted, ${failed} failed`);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(scheduledCleanup(env));
  },
};
