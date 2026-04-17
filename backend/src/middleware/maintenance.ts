/**
 * Maintenance-mode middleware
 *
 * Freezes the API during infrastructure migrations (e.g., Epic #314 SCCN).
 * Toggled via the MAINTENANCE_MODE env var in wrangler.toml; redeploy to flip.
 *
 * Modes:
 *   - "off":        normal operation
 *   - "read-only":  block mutating methods (POST/PUT/DELETE/PATCH) except /admin/*
 *                   and /webhooks/* so admins can moderate and GitHub webhooks
 *                   still reach the backend
 *   - "full":       block everything except /health, /notices, GET /
 */

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "../types/bindings";

export type MaintenanceMode = "off" | "read-only" | "full";

type MaintenanceContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ALWAYS_ALLOWED_PATHS = new Set(["/", "/health", "/notices"]);

function parseMode(raw: string | undefined): MaintenanceMode {
  if (raw === "read-only" || raw === "full") return raw;
  return "off";
}

function respond503(c: MaintenanceContext, mode: MaintenanceMode) {
  c.header("Retry-After", "3600");
  return c.json(
    {
      error: "Service Unavailable",
      message:
        "NEMAR is in maintenance mode. Please retry shortly. Updates at https://github.com/nemarOrg/nemar-cli/issues/314",
      mode,
      eta: null,
    },
    503,
  );
}

export async function maintenanceMode(c: MaintenanceContext, next: Next) {
  const mode = parseMode(c.env.MAINTENANCE_MODE);

  if (mode === "off") {
    await next();
    return;
  }

  const path = c.req.path;

  if (ALWAYS_ALLOWED_PATHS.has(path)) {
    await next();
    return;
  }

  if (mode === "full") {
    return respond503(c, mode);
  }

  if (READ_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  if (path.startsWith("/admin/") || path.startsWith("/webhooks/")) {
    await next();
    return;
  }

  return respond503(c, mode);
}
