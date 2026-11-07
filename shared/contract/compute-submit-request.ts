/**
 * The REQUESTS of a person's job submission (epic #2021 phase D3, #2024; ADR 0118, the amendment of this
 * phase): `POST /compute/jobs` and `POST /compute/jobs/:id/finalize`. Strict ON PURPOSE, like the job
 * specification they carry: the Worker validates them as they come IN, and a mistyped key must be refused
 * rather than stripped from the record. No released command-line interface parses one as a response.
 * Every RESPONSE of these routes is open and lives in `./compute-submit.ts`, which imports nothing strict
 * (`test/contract-schemas.test.ts` lists this file in `STRICT_BY_DESIGN` and holds the other files to it).
 *
 * The caps and the one manifest RULE (`checkBundleManifest`) are `./compute-bundle.ts`, which holds no zod
 * schema; the schemas below say the shapes.
 */

import { z } from "zod";
import { BUNDLE_PATH_MAX } from "./compute-bundle.js";
import { COMPUTE_SHA256_RE, JobSpecSchema } from "./compute.js";

/** One file inside the archive. Closed: a typo is refused, not dropped from the record. */
export const BundleManifestFileSchema = z
  .object({
    path: z.string().min(1).max(BUNDLE_PATH_MAX),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(COMPUTE_SHA256_RE),
  })
  .strict();

export type BundleManifestFile = z.infer<typeof BundleManifestFileSchema>;

/** `bundle-manifest.json` as the CLI builds it and the Worker receives it. */
export const BundleManifestSchema = z
  .object({ files: z.array(BundleManifestFileSchema).min(1) })
  .strict();

export type BundleManifest = z.infer<typeof BundleManifestSchema>;

/**
 * `POST /compute/jobs`. `spec` is the job specification exactly as `spec.json` records it (its `name`
 * included: the name is part of the specification, not a column), and `manifest` is the
 * `bundle-manifest.json` of the archive: required when `spec.bundle` is present, refused when it is not.
 * The archive itself is not in the request; the Worker answers with the address to PUT it to.
 */
export const ComputeSubmitRequestSchema = z
  .object({ spec: JobSpecSchema, manifest: BundleManifestSchema.optional() })
  .strict();

export type ComputeSubmitRequest = z.infer<typeof ComputeSubmitRequestSchema>;

/**
 * `POST /compute/jobs/:id/finalize`: `bundle-manifest.json` again (the Worker keeps nothing of the
 * request between the two calls but the specification, so the manifest it records is the one in THIS
 * call, checked against the same caps and the job's `entry`). An empty body is accepted only for a job
 * that is already past the upload, which the Worker answers unchanged.
 */
export const ComputeFinalizeRequestSchema = BundleManifestSchema;

export type ComputeFinalizeRequest = z.infer<typeof ComputeFinalizeRequestSchema>;
