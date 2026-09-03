/**
 * Shared plumbing for the webhooks router (#905, epic #902).
 *
 * A single router instance (rather than mounted sub-routers) keeps routing
 * semantics identical to the pre-split monolithic webhooks.ts. Register
 * functions must call webhooks.get/post/... directly; do not mount a sub-app
 * via .route(), which has its own basePath/precedence semantics.
 */

import type { Context, Hono } from "hono";
import type { Bindings } from "../../types/bindings.js";

export type WebhookRouter = Hono<{ Bindings: Bindings }>;

export type WebhookContext = Context<{ Bindings: Bindings }>;
