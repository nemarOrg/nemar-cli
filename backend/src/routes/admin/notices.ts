/**
 * Admin routes: system notices shown to CLI users.
 *
 * Moved verbatim from routes/admin.ts in #903 (epic #902); the only
 * intentional changes are import paths and `adminRoutes` -> `admin`.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import {
  type NoticeLevel,
  createNotice,
  deleteNotice,
  listAllNotices,
  normalizeLevel,
} from "../../services/notices";
import type { AdminRouter } from "./shared";

export function registerNoticeRoutes(admin: AdminRouter): void {
  // ============================================================================
  // Notices
  // ============================================================================

  /**
   * GET /admin/notices - List all notices (including expired)
   */
  admin.get("/notices", async (c) => {
    const db = c.env.DB;
    const notices = await listAllNotices(db);
    return c.json({ notices });
  });

  /**
   * `info` is accepted but is NOT part of the stored vocabulary (#1025,
   * migration 0063 renamed it to `tip`). Keeping it on the input enum means
   * existing `nemar admin notice set --level info` invocations and any
   * scripts built on them keep working; `normalizeLevel` maps it to `tip`
   * before the insert, so nothing reaches the widened CHECK constraint that
   * would violate it.
   */
  const createNoticeSchema = z.object({
    message: z.string().min(1).max(1000),
    level: z
      .enum(["tip", "announcement", "maintenance", "warning", "critical", "info"])
      .default("tip"),
    scope: z.enum(["all", "admins", "members"]).default("all"),
    expires_at: z.string().datetime({ offset: true }).optional(),
  });

  /**
   * POST /admin/notices - Create a notice
   */
  admin.post("/notices", zValidator("json", createNoticeSchema), async (c) => {
    const user = c.get("user");
    const db = c.env.DB;
    const body = c.req.valid("json");

    const notice = await createNotice(
      db,
      { ...body, level: normalizeLevel(body.level) as NoticeLevel },
      user.id,
    );
    return c.json(notice, 201);
  });

  /**
   * DELETE /admin/notices/:id - Delete a notice
   */
  admin.delete("/notices/:id", async (c) => {
    const db = c.env.DB;
    const id = Number.parseInt(c.req.param("id"), 10);

    if (Number.isNaN(id)) {
      return c.json({ error: "Invalid notice ID" }, 400);
    }

    const deleted = await deleteNotice(db, id);
    if (!deleted) {
      return c.json({ error: "Notice not found" }, 404);
    }

    return c.json({ message: "Notice deleted" });
  });
}
