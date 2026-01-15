/**
 * NEMAR API - Cloudflare Workers Backend
 *
 * Handles user authentication, dataset management, and admin workflows.
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
import { rateLimiter } from "./middleware/rateLimit";

// Create Hono app with typed bindings
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Global middleware
app.use("*", logger());
app.use("*", secureHeaders());
app.use(
  "*",
  cors({
    origin: (origin) => {
      // Allow localhost for development
      if (origin?.includes("localhost")) return origin;
      // Allow nemar.org domains
      if (origin?.endsWith(".nemar.org") || origin === "https://nemar.org") {
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
app.use("*", rateLimiter);

// Health check endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  });
});

// API info endpoint
app.get("/", (c) => {
  return c.json({
    name: "NEMAR API",
    version: "0.1.0",
    description: "Backend API for NEMAR CLI",
    endpoints: {
      auth: "/auth/*",
      users: "/users/*",
      admin: "/admin/*",
      datasets: "/datasets/*",
    },
  });
});

// Mount route handlers
app.route("/auth", authRoutes);
app.route("/users", userRoutes);
app.route("/admin", adminRoutes);
app.route("/datasets", datasetRoutes);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: "Not Found",
      message: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404
  );
});

// Global error handler
app.onError((err, c) => {
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

export default app;
