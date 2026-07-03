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

/** Constant-time string comparison to prevent timing attacks on secret tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}
