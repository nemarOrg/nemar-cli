// Shared plumbing for the routes/admin/* domain files (#903, epic #902).

import type { Hono } from "hono";
import type { Bindings, Variables } from "../../types/bindings";

/**
 * The one admin router every domain file registers onto. A single router
 * instance (rather than mounted sub-routers) keeps routing semantics
 * identical to the pre-split monolithic admin.ts.
 */
export type AdminRouter = Hono<{ Bindings: Bindings; Variables: Variables }>;

export function getS3Config(env: Bindings) {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}
