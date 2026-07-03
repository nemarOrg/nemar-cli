/**
 * Admin router (#903, epic #902).
 *
 * The former monolithic routes/admin.ts, split by domain. Each domain file
 * registers its handlers on this single shared router, so routing semantics
 * (middleware order, path matching) are identical to the pre-split monolith.
 * The route inventory is pinned by test/admin-route-inventory.unit.test.ts.
 */

import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../../middleware/auth";
import type { Bindings, Variables } from "../../types/bindings";
import { registerDatasetLifecycleRoutes } from "./datasets-lifecycle";
import { registerDoiRoutes } from "./doi";
import { registerFleetRoutes } from "./fleet";
import { registerImportRoutes } from "./imports";
import { registerNoticeRoutes } from "./notices";
import { registerPublishRoutes } from "./publish";
import { registerUsersRoutes } from "./users";

export const adminRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// All admin routes require authentication and admin role
adminRoutes.use("*", authMiddleware);
adminRoutes.use("*", adminMiddleware);

registerUsersRoutes(adminRoutes);
registerDoiRoutes(adminRoutes);
registerFleetRoutes(adminRoutes);
registerPublishRoutes(adminRoutes);
registerDatasetLifecycleRoutes(adminRoutes);
registerImportRoutes(adminRoutes);
registerNoticeRoutes(adminRoutes);
