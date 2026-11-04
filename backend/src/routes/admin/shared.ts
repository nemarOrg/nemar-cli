// Shared plumbing for the routes/admin/* domain files (#903, epic #902).

import type { Hono } from "hono";
import { testS3EndpointOverride } from "../../services/environment";
import type { Bindings, Variables } from "../../types/bindings";

/**
 * The one admin router every domain file registers onto. A single router
 * instance (rather than mounted sub-routers) keeps routing semantics
 * identical to the pre-split monolithic admin.ts. Register functions must
 * call admin.get/post/... directly; do not mount a sub-app via .route(),
 * which has its own basePath/precedence semantics.
 */
export type AdminRouter = Hono<{ Bindings: Bindings; Variables: Variables }>;

export function getS3Config(env: Bindings) {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    // Test-only origin override (#1514), fenced by testS3EndpointOverride: honored only in a
    // recognized non-production environment, so a stray S3_ENDPOINT_URL on the production Worker
    // cannot redirect an admin S3 call, the publication Object Lock step included.
    endpointUrl: testS3EndpointOverride(env),
  };
}
