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

import type { Bindings, Variables } from "./types/bindings";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/users";
import { adminRoutes } from "./routes/admin";
import { datasetRoutes } from "./routes/datasets";
import webhooks from "./routes/webhooks";
import { rateLimiter } from "./middleware/rateLimit";

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
  })
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
      webhooks: "/webhooks/*",
    },
  });
});

// Mount route handlers
api.route("/auth", authRoutes);
api.route("/users", userRoutes);
api.route("/admin", adminRoutes);
api.route("/datasets", datasetRoutes);
api.route("/webhooks", webhooks);

// 404 handler
api.notFound((c) => {
  return c.json(
    {
      error: "Not Found",
      message: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404
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
      400
    );
  }

  // Don't expose internal error details in production
  const isDev = c.env.API_BASE_URL?.includes("dev") || c.env.API_BASE_URL?.includes("localhost");

  return c.json(
    {
      error: "Internal Server Error",
      message: isDev ? err.message : "An unexpected error occurred",
    },
    500
  );
});

// Create root app that mounts API at both /nemar (production) and / (dev)
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Mount at /nemar for production (api.osc.earth/nemar/*)
app.route("/nemar", api);

// Also mount at root for dev environment and workers.dev domain
app.route("/", api);

export default app;
