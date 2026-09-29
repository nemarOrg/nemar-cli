// Shared plumbing for the routes/admin/* domain files (#903, epic #902).

import type { Hono } from "hono";
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
    // Test-only origin override (#1514), unset in every deployment; mirrors
    // routes/data.ts's s3OptionsFromEnv so every admin S3 call can be driven
    // by a local Bun.serve stand-in at its real route, not just data.ts's.
    endpointUrl: env.S3_ENDPOINT_URL,
  };
}
