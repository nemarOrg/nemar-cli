/**
 * Sandbox training routes
 *
 * Handles sandbox training status, completion, and reset.
 */

import { Hono } from "hono";
import type { Bindings, Variables } from "../types/bindings";
import { authMiddleware } from "../middleware/auth";

export const sandboxRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// All sandbox routes require authentication
sandboxRoutes.use("*", authMiddleware);

/**
 * GET /sandbox/status - Get sandbox training status
 */
sandboxRoutes.get("/status", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  const status = await db
    .prepare(
      `
    SELECT sandbox_completed, sandbox_completed_at, sandbox_dataset_id
    FROM users
    WHERE id = ?
  `
    )
    .bind(user.id)
    .first<{
      sandbox_completed: number;
      sandbox_completed_at: string | null;
      sandbox_dataset_id: string | null;
    }>();

  return c.json({
    sandbox_completed: !!status?.sandbox_completed,
    sandbox_completed_at: status?.sandbox_completed_at,
    sandbox_dataset_id: status?.sandbox_dataset_id,
  });
});

/**
 * POST /sandbox/complete - Mark sandbox training as complete
 */
sandboxRoutes.post("/complete", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  const body = await c.req.json<{ dataset_id: string }>();
  const { dataset_id } = body;

  if (!dataset_id) {
    return c.json({ error: "dataset_id is required" }, 400);
  }

  // Verify the dataset exists and belongs to this user
  const dataset = await db
    .prepare(
      `
    SELECT id, is_sandbox, owner_user_id
    FROM datasets
    WHERE dataset_id = ?
  `
    )
    .bind(dataset_id)
    .first<{ id: number; is_sandbox: number; owner_user_id: number }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (dataset.owner_user_id !== user.id) {
    return c.json({ error: "Dataset does not belong to you" }, 403);
  }

  if (!dataset.is_sandbox) {
    return c.json({ error: "Dataset is not a sandbox dataset" }, 400);
  }

  // Mark sandbox as complete
  await db
    .prepare(
      `
    UPDATE users
    SET sandbox_completed = 1,
        sandbox_completed_at = datetime('now'),
        sandbox_dataset_id = ?
    WHERE id = ?
  `
    )
    .bind(dataset_id, user.id)
    .run();

  return c.json({
    message: "Sandbox training completed",
    sandbox_completed: true,
    sandbox_dataset_id: dataset_id,
  });
});

/**
 * POST /sandbox/reset - Reset sandbox training status
 */
sandboxRoutes.post("/reset", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  // Reset sandbox status
  await db
    .prepare(
      `
    UPDATE users
    SET sandbox_completed = 0,
        sandbox_completed_at = NULL,
        sandbox_dataset_id = NULL
    WHERE id = ?
  `
    )
    .bind(user.id)
    .run();

  return c.json({
    message: "Sandbox status reset",
    sandbox_completed: false,
  });
});
