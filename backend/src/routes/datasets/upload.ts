/**
 * Dataset creation and the upload lifecycle: create, presigned upload URLs,
 * scoped upload/download credentials, and finalize.
 *
 * Moved verbatim from routes/datasets.ts (#906, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { cliVersionGuard } from "../../middleware/cliVersion";
import { generateDatasetId, isValidDatasetId } from "../../services/datasetId";
import {
  type GitHubRepo,
  addCollaborator,
  createRepository,
  enableAutoMerge,
  ensureMainBranch,
  ensureWorkflowsDeployed,
  reconcileCollaborators,
} from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { mirrorReconcileRemovals, resolveRepoCollaborators } from "../../services/repo-spec";
import { generateDatasetUploadUrls, markDatasetPrivate } from "../../services/s3";
import {
  generateDownloadPolicy,
  generateUploadPolicy,
  getFederationToken,
} from "../../services/sts";
import { realDatasetCreateGate, realDatasetServiceGate } from "../../services/upload-gate";
import { type Bindings, hasRole } from "../../types/bindings";
import type { DatasetsRouter } from "./shared";

/**
 * True when `userId` is a collaborator on the dataset identified by its public
 * string id. Centralizes the owner/admin-bypass authorization check shared by
 * POST /:id/upload-urls, POST /:id/upload-credentials, and
 * POST /:id/download-credentials (#190).
 */
async function isDatasetCollaborator(
  db: D1Database,
  datasetId: string,
  userId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE d.dataset_id = ? AND dc.user_id = ?",
    )
    .bind(datasetId, userId)
    .first();
  return row !== null;
}

/**
 * Seed catalog stats from the declared file manifest (#1091). The web GUI
 * runs no enrichment at upload, so without this a fresh draft's dashboard
 * card shows nothing for subjects/size. Both numbers are already in the
 * create request; enrichment later overwrites them with authoritative
 * values, so these are first-paint seeds, not the record.
 */
export function manifestSeedStats(files: { path: string; size: number }[] | undefined): {
  bytes: number | null;
  subjects: number | null;
} {
  if (!files || files.length === 0) return { bytes: null, subjects: null };
  let bytes = 0;
  const subjects = new Set<string>();
  for (const f of files) {
    bytes += f.size;
    // Paths are dataset-root-relative with no leading slash (both the CLI and
    // the web uploader send them that way); a leading "/" would hide the
    // subject from the count, not miscount it.
    const top = f.path.split("/")[0];
    if (/^sub-[^/]+$/.test(top)) subjects.add(top);
  }
  return { bytes, subjects: subjects.size > 0 ? subjects.size : null };
}

// File schema for upload requests
const fileSchema = z.object({
  path: z.string(),
  // Zero-byte files are legal: BIDS folders carry empty placeholder files,
  // an empty-body presigned PUT is valid S3, and the web upload flow sends
  // File.size verbatim — a single empty file must not block the whole
  // create (#1084). Only negative sizes are rejected.
  size: z.number().int().nonnegative(),
  type: z.enum(["metadata", "data"]),
});

// Deposit attestation (#1077): the depositor's acceptance of the Data
// Contributor Terms, recorded on the dataset row (migration 0067). Optional at
// the wire level so pre-attestation CLIs keep working; the CLI collects it for
// every new upload. A 'redistribution' deposit must affirm no_duplicate — the
// dataset is not already on NEMAR or an upstream archive in BIDS form.
const attestationSchema = z
  .object({
    deposit_type: z.enum(["owner", "redistribution"]),
    key_status: z.enum(["destroyed", "retained"]),
    // Literal true: an attestation that does not confirm de-identification is
    // not an attestation; the CLI aborts the upload before ever sending false.
    deidentified: z.literal(true),
    no_duplicate: z.boolean().optional(),
    upstream_source: z.string().max(500).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.deposit_type === "redistribution" && a.no_duplicate !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["no_duplicate"],
        message:
          "Redistribution deposits must affirm the dataset is not already archived in BIDS format",
      });
    }
    if (a.deposit_type === "owner" && a.no_duplicate !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["no_duplicate"],
        message:
          "no_duplicate only applies to redistribution deposits (owner deposits leave it unset)",
      });
    }
  });

// Create dataset schema
const createDatasetSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().optional(),
  files: z.array(fileSchema).optional(),
  sandbox: z.boolean().optional(), // If true, creates sandbox dataset (xx000XXX)
  attestation: attestationSchema.optional(),
});

// Sandbox file size limit: 10MB total in production (sandbox is for exercising
// the workflow, not storing real data). Non-production staging (epic #923) needs
// realistic exemplars, so it gets a larger cap; the exemplar clone tool bypasses
// this path entirely via server-side S3 copy, but direct CLI staging uploads
// still flow through here.
const SANDBOX_MAX_TOTAL_SIZE = 10 * 1024 * 1024;
const SANDBOX_MAX_TOTAL_SIZE_NONPROD = 500 * 1024 * 1024;

/**
 * Generate presigned upload URLs for data files.
 * Returns { urls, error } where error is set on failure with status and body for the response.
 */
async function generateUploadUrlsForFiles(
  env: Bindings,
  datasetId: string,
  files?: Array<{ path: string; size: number; type: string }>,
): Promise<{
  urls: Record<string, string>;
  error?: {
    status: number;
    body: { error: string; details?: string; dataset_id?: string; note?: string };
  };
}> {
  if (!files || files.length === 0) return { urls: {} };
  const dataFiles = files.filter((f) => f.type === "data").map((f) => f.path);
  if (dataFiles.length === 0) return { urls: {} };

  try {
    const urls = await generateDatasetUploadUrls(
      {
        bucket: env.S3_BUCKET,
        region: env.AWS_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
      datasetId,
      dataFiles,
    );
    return { urls };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("Invalid file path")) {
      return { urls: {}, error: { status: 400, body: { error: message } } };
    }
    console.error(`Failed to generate presigned URLs for ${datasetId}:`, error);
    return {
      urls: {},
      error: {
        status: 500,
        body: {
          error: "Failed to generate upload URLs",
          details: message,
          dataset_id: datasetId,
          note: "Dataset exists but upload URLs could not be generated. Re-run the upload.",
        },
      },
    };
  }
}

export function registerUploadRoutes(datasetRoutes: DatasetsRouter): void {
  /**
   * POST /datasets - Create a new dataset
   *
   * Creates GitHub repo, assigns dataset ID, and returns presigned URLs for upload.
   * Uses backend-scoped credentials for presigned URL generation.
   * Authorization enforced via user_s3_permissions in D1.
   */
  datasetRoutes.post(
    "/",
    authMiddleware,
    cliVersionGuard,
    zValidator("json", createDatasetSchema),
    async (c) => {
      const {
        name,
        description,
        files,
        sandbox: requestedSandbox,
        attestation,
      } = c.req.valid("json");
      const user = c.get("user");
      const db = c.env.DB;

      // Non-production environments can only create sandbox (xx-prefix) datasets.
      // This prevents dev from minting real nm-prefix dataset IDs.
      const environment = c.env.ENVIRONMENT;
      if (!environment) {
        console.warn(
          "[datasets] ENVIRONMENT not configured; defaulting to non-production (sandbox-only)",
        );
      }
      const isProduction = environment === "production";
      const sandbox = isProduction ? !!requestedSandbox : true;

      if (!isProduction && !requestedSandbox) {
        console.warn(
          `[datasets] Non-production env: forcing sandbox=true for user ${user.username} (requested: ${requestedSandbox})`,
        );
      }

      // Non-sandbox (real) dataset creation is gated on service access then
      // sandbox training (ADR 0010, #1013). See services/upload-gate.ts.
      if (!sandbox) {
        const userStatus = await db
          .prepare("SELECT service_access, sandbox_completed FROM users WHERE id = ?")
          .bind(user.id)
          .first<{ service_access: number; sandbox_completed: number }>();

        const gate = realDatasetCreateGate({
          service_access: userStatus?.service_access ?? 0,
          sandbox_completed: userStatus?.sandbox_completed ?? 0,
        });
        if (gate) return c.json(gate, 403);
      }

      // Validate sandbox file size limit (larger outside production, see const)
      const sandboxMaxTotalSize = isProduction
        ? SANDBOX_MAX_TOTAL_SIZE
        : SANDBOX_MAX_TOTAL_SIZE_NONPROD;
      if (sandbox && files && files.length > 0) {
        const totalSize = manifestSeedStats(files).bytes ?? 0;
        if (totalSize > sandboxMaxTotalSize) {
          const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
          const limitMB = (sandboxMaxTotalSize / (1024 * 1024)).toFixed(0);
          return c.json(
            {
              error: "Sandbox file size limit exceeded",
              message: `Sandbox datasets are limited to ${limitMB}MB total. Your dataset is ${sizeMB}MB. Sandbox is for testing the workflow, not storing real data.`,
              total_size: totalSize,
              limit: sandboxMaxTotalSize,
            },
            400,
          );
        }
      }

      // S3 credentials: use backend-owned credentials for presigned URL generation.
      // Authorization is enforced via user_s3_permissions in D1, not IAM policies.

      // Server-side dedup: if this user already has an incomplete dataset with the
      // same name, return it instead of creating a new one. This prevents phantom
      // datasets when the CLI loses .nemar/config.json and retries.
      // "Incomplete" = private, no DOI, no version records, has a GitHub repo.
      const existingIncomplete = await db
        .prepare(
          `SELECT d.dataset_id, d.github_repo
           FROM datasets d
           WHERE d.owner_user_id = ?
             AND d.name = ?
             AND d.is_sandbox = ?
             AND d.visibility = 'private'
             AND d.concept_doi IS NULL
             AND d.github_repo IS NOT NULL AND d.github_repo != ''
             AND NOT EXISTS (
               SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id
             )
           ORDER BY d.created_at DESC
           LIMIT 1`,
        )
        .bind(user.id, name, sandbox ? 1 : 0)
        .first<{ dataset_id: string; github_repo: string }>();

      if (existingIncomplete) {
        console.log(
          `[datasets] Dedup hit: returning existing incomplete dataset ${existingIncomplete.dataset_id} for user ${user.username}, name "${name}"`,
        );

        const datasetId = existingIncomplete.dataset_id;
        const githubRepo = existingIncomplete.github_repo;

        // A resumed create is the same depositor re-affirming: record the
        // attestation they sent now (also backfills rows whose original
        // create predated attestation collection). Failure here must not
        // block the resume; the columns stay NULL and the next attempt
        // records it.
        if (attestation) {
          try {
            await db
              .prepare(
                `UPDATE datasets SET
                   attestation_deposit_type = ?,
                   attestation_key_status = ?,
                   attestation_deidentified = ?,
                   attestation_no_duplicate = ?,
                   attestation_upstream_source = ?,
                   attestation_accepted_at = datetime('now')
                 WHERE dataset_id = ?`,
              )
              .bind(
                attestation.deposit_type,
                attestation.key_status,
                attestation.deidentified ? 1 : 0,
                attestation.no_duplicate === undefined ? null : attestation.no_duplicate ? 1 : 0,
                attestation.upstream_source ?? null,
                datasetId,
              )
              .run();
          } catch (err) {
            console.error(`Failed to record attestation on resumed ${datasetId}:`, err);
          }
        }

        // Re-seed subjects/size from the manifest sent with this resume
        // (#1091): the row predates the seed columns or carries a stale
        // selection. The dedup WHERE does NOT prove enrichment never ran (a
        // pushed-then-lost-config dataset can be enriched while still
        // "incomplete"), so the metadata_updated_at guard keeps this seed off
        // any row writeDatasetMetadataColumns has already stamped. Non-fatal.
        const resumeSeed = manifestSeedStats(files);
        if (resumeSeed.bytes !== null) {
          try {
            await db
              .prepare(
                "UPDATE datasets SET subject_count = ?, file_size = ? WHERE dataset_id = ? AND metadata_updated_at IS NULL",
              )
              .bind(resumeSeed.subjects, resumeSeed.bytes, datasetId)
              .run();
          } catch (err) {
            console.error(`Failed to seed manifest stats on resumed ${datasetId}:`, err);
          }
        }

        // Ensure the resumed dataset is still carved out of public access before
        // re-issuing upload URLs (idempotent; covers rows created before this
        // invariant existed or whose carve-out was lost). Fail closed.
        try {
          await markDatasetPrivate(
            {
              bucket: c.env.S3_BUCKET,
              region: c.env.AWS_REGION,
              accessKeyId: c.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
            },
            datasetId,
          );
        } catch (s3Error) {
          const s3Msg = s3Error instanceof Error ? s3Error.message : String(s3Error);
          console.error(`Failed to mark resumed dataset ${datasetId} private:`, s3Msg);
          return c.json(
            {
              error: "Failed to secure dataset storage",
              dataset_id: datasetId,
              note: "Could not confirm the dataset's S3 storage is private, so upload was not resumed. Retry shortly; an administrator should check the bucket policy if this persists.",
            },
            500,
          );
        }

        // Generate fresh presigned URLs for the resumed upload
        const { urls: uploadUrls, error: urlError } = await generateUploadUrlsForFiles(
          c.env,
          datasetId,
          files,
        );
        if (urlError) {
          return c.json(urlError.body, urlError.status as 400 | 500);
        }

        return c.json(
          {
            message: "Resuming existing incomplete dataset",
            resumed: true,
            dataset: {
              id: datasetId,
              dataset_id: datasetId,
              name,
              description: description || null,
              github_repo: githubRepo,
              github_url: `https://github.com/${githubRepo}`,
              ssh_url: `git@github.com:${githubRepo}.git`,
              s3_prefix: datasetId,
            },
            upload_urls: uploadUrls,
            s3_config: {
              bucket: c.env.S3_BUCKET,
              region: c.env.AWS_REGION,
              public_url: `https://${c.env.S3_BUCKET}.s3.${c.env.AWS_REGION}.amazonaws.com`,
            },
          },
          200,
        );
      }

      // Generate dataset ID (xx000XXX for sandbox, nm000XXX for regular).
      // There is a TOCTOU gap between ID generation (SELECT) and the INSERT
      // below. The UNIQUE constraint on datasets.dataset_id prevents duplicates;
      // we retry on conflict to handle the rare concurrent-creation case.
      // Sandbox ID range partition (epic #923): prod caps at SANDBOX_ID_CEILING
      // (89999), dev/test floors at SANDBOX_ID_FLOOR (90001), so the shared
      // nemarDatasets org never has xx repo-name collisions. Unset -> full range.
      const parseRangeBound = (v: string | undefined, name: string): number | undefined => {
        if (!v) return undefined;
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n)) {
          // A typo'd bound must not silently revert to the full xx range and let
          // prod/dev collide again unnoticed; surface it (mirrors the ENVIRONMENT
          // warning above).
          console.warn(
            `[datasets] ${name}="${v}" is not a valid number; ignoring (sandbox ID partition weakened for this bound)`,
          );
          return undefined;
        }
        return n;
      };
      const sandboxIdFloor = parseRangeBound(c.env.SANDBOX_ID_FLOOR, "SANDBOX_ID_FLOOR");
      const sandboxIdCeiling = parseRangeBound(c.env.SANDBOX_ID_CEILING, "SANDBOX_ID_CEILING");

      let datasetId: string;
      const MAX_ID_RETRIES = 3;
      for (let attempt = 0; ; attempt++) {
        datasetId = await generateDatasetId(db, !!sandbox, { sandboxIdFloor, sandboxIdCeiling });
        try {
          // Claim the ID early with a minimal INSERT to close the TOCTOU gap.
          // license/license_tier are intentionally omitted: no license is known
          // at upload time, so license_tier rests on its NOT NULL DEFAULT
          // 'unknown' (0034) until enrichment sets the real value via
          // writeDatasetCatalogFields. If `license` is ever added here, add
          // license_tier alongside it or the tier will stay stale (#653).
          // Attestation columns (0067) ride the claim INSERT because they are
          // known at create time; NULLs mean "no attestation on record"
          // (pre-attestation CLIs, server-side imports).
          // Manifest-derived seeds (#1091): subjects/size are known from the
          // declared file list, so the dashboard card is populated from the
          // first render; enrichment overwrites with authoritative values.
          const seed = manifestSeedStats(files);
          await db
            .prepare(
              `INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo, is_sandbox, visibility,
                subject_count, file_size,
                attestation_deposit_type, attestation_key_status, attestation_deidentified,
                attestation_no_duplicate, attestation_upstream_source, attestation_accepted_at)
             VALUES (?, ?, ?, ?, '', ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              datasetId,
              name,
              description || null,
              user.id,
              sandbox ? 1 : 0,
              seed.subjects,
              seed.bytes,
              attestation?.deposit_type ?? null,
              attestation?.key_status ?? null,
              attestation ? 1 : null,
              attestation
                ? attestation.no_duplicate === undefined
                  ? null
                  : attestation.no_duplicate
                    ? 1
                    : 0
                : null,
              attestation?.upstream_source ?? null,
              attestation ? new Date().toISOString().replace("T", " ").slice(0, 19) : null,
            )
            .run();
          break; // ID claimed successfully
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_ID_RETRIES - 1 && msg.includes("UNIQUE constraint failed")) {
            continue; // Retry with a new ID
          }
          console.error("Failed to reserve dataset ID:", err);
          return c.json({ error: "Failed to reserve dataset ID" }, 500);
        }
      }

      // Create GitHub repository
      const pat = await getDatasetsToken(c.env);
      let githubRepo: GitHubRepo;
      try {
        githubRepo = await createRepository(
          datasetId,
          `${name} - NEMAR Dataset`,
          true, // Private - owner added as collaborator
          pat,
        );
      } catch (error) {
        console.error("Failed to create GitHub repo:", error);
        // Clean up the claimed dataset row
        await db.prepare("DELETE FROM datasets WHERE dataset_id = ?").bind(datasetId).run();
        return c.json({ error: "Failed to create GitHub repository" }, 500);
      }

      // Add dataset owner as maintainer
      try {
        await addCollaborator(datasetId, user.github_username, "maintain", pat);
      } catch (error) {
        console.error("Failed to add owner as collaborator:", error);
      }

      // Record S3 permission in D1 (sole authorization source; skip for admins)
      if (!hasRole(user.role, "admin")) {
        try {
          await db
            .prepare(
              "INSERT INTO user_s3_permissions (user_id, s3_prefix, permission, granted_by) VALUES (?, ?, 'read_write', ?)",
            )
            .bind(user.id, datasetId, user.id)
            .run();
        } catch (error) {
          console.error("Failed to record S3 permission for dataset:", datasetId, error);
          return c.json(
            {
              error: "Failed to configure S3 access for dataset",
              dataset_id: datasetId,
              github_repo: githubRepo.full_name,
              note: "GitHub repository was created but S3 upload permissions could not be configured. Contact an administrator.",
            },
            500,
          );
        }
      }

      // NOTE: Branch protection is applied in the finalize endpoint after initial upload

      // Carve the new dataset out of public access BEFORE issuing any upload
      // URL. The bucket is public-by-default; objects are anonymously readable
      // unless their prefix is listed private in the bucket policy. We must add
      // that carve-out before the client can upload anything, so fail closed
      // here rather than hand out upload URLs for an un-secured prefix.
      try {
        await markDatasetPrivate(
          {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          },
          datasetId,
        );
      } catch (s3Error) {
        const s3Msg = s3Error instanceof Error ? s3Error.message : String(s3Error);
        console.error(`Failed to mark new dataset ${datasetId} private:`, s3Msg);
        return c.json(
          {
            error: "Failed to secure dataset storage",
            dataset_id: datasetId,
            github_repo: githubRepo.full_name,
            note: "The GitHub repository was created but the dataset's S3 storage could not be marked private, so upload was not started. Retry `nemar dataset upload`; an administrator should check the bucket policy if this persists.",
          },
          500,
        );
      }

      // Generate presigned URLs for data files using backend credentials
      const { urls: uploadUrls, error: urlError } = await generateUploadUrlsForFiles(
        c.env,
        datasetId,
        files,
      );
      if (urlError) {
        return c.json(urlError.body, urlError.status as 400 | 500);
      }

      // Update the claimed dataset record with the GitHub repo info
      await db
        .prepare("UPDATE datasets SET github_repo = ? WHERE dataset_id = ?")
        .bind(githubRepo.full_name, datasetId)
        .run();

      // Audit log
      await db
        .prepare(
          `
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
      VALUES (?, 'dataset_created', 'dataset', ?, ?)
    `,
        )
        .bind(user.id, datasetId, JSON.stringify({ name, file_count: files?.length || 0 }))
        .run();

      // Note: We no longer return AWS credentials to the CLI
      // The CLI will use the presigned URLs for upload
      return c.json(
        {
          message: "Dataset created successfully",
          resumed: false,
          dataset: {
            id: datasetId,
            dataset_id: datasetId,
            name,
            description: description || null,
            github_repo: githubRepo.full_name,
            github_url: githubRepo.html_url,
            ssh_url: githubRepo.ssh_url,
            s3_prefix: datasetId,
          },
          upload_urls: uploadUrls,
          s3_config: {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            public_url: `https://${c.env.S3_BUCKET}.s3.${c.env.AWS_REGION}.amazonaws.com`,
          },
        },
        201,
      );
    },
  );

  /**
   * POST /datasets/:id/upload-urls - Get presigned URLs for additional uploads
   */
  const uploadUrlsSchema = z.object({
    files: z.array(z.string()).min(1, "At least one file path required"),
  });

  datasetRoutes.post(
    "/:id/upload-urls",
    authMiddleware,
    zValidator("json", uploadUrlsSchema),
    async (c) => {
      const datasetId = c.req.param("id");
      const { files } = c.req.valid("json");
      const user = c.get("user");
      const db = c.env.DB;

      // Verify dataset exists and user is owner or collaborator
      const dataset = await db
        .prepare("SELECT owner_user_id, is_sandbox FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ owner_user_id: number; is_sandbox: number }>();

      if (!dataset) {
        return c.json({ error: "Dataset not found" }, 404);
      }

      if (dataset.owner_user_id !== user.id && !hasRole(user.role, "admin")) {
        // Check if user is a collaborator
        const isCollaborator = await isDatasetCollaborator(db, datasetId, user.id);

        if (!isCollaborator) {
          return c.json(
            { error: "Only dataset owner or collaborators can request upload URLs" },
            403,
          );
        }
      }

      // Check if user has permission for this dataset prefix
      if (!hasRole(user.role, "admin")) {
        const hasPermission = await db
          .prepare("SELECT 1 FROM user_s3_permissions WHERE user_id = ? AND s3_prefix = ?")
          .bind(user.id, datasetId)
          .first();

        if (!hasPermission) {
          return c.json(
            {
              error: "You do not have S3 upload permission for this dataset",
              message: "Request access to this dataset first",
            },
            403,
          );
        }

        // Pushing bytes to a real dataset requires service access (ADR 0010,
        // #1013), even for collaborators: a collaborator keeps download but
        // cannot upload without passing export-control review. Sandbox datasets
        // are exempt (capped training playground).
        if (!dataset.is_sandbox) {
          const su = await db
            .prepare("SELECT service_access FROM users WHERE id = ?")
            .bind(user.id)
            .first<{ service_access: number }>();
          const gate = realDatasetServiceGate({ service_access: su?.service_access ?? 0 });
          if (gate) return c.json(gate, 403);
        }
      }

      // Generate presigned URLs using backend credentials
      let uploadUrls: Record<string, string>;
      try {
        uploadUrls = await generateDatasetUploadUrls(
          {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          },
          datasetId,
          files,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (message.includes("Invalid file path")) {
          return c.json({ error: message }, 400);
        }
        throw error;
      }

      return c.json({ upload_urls: uploadUrls });
    },
  );

  // Schema for upload credentials request
  const uploadCredentialsSchema = z.object({
    duration_seconds: z.number().int().min(900).max(7200).optional(),
  });

  /**
   * POST /datasets/:id/upload-credentials - Get temporary S3 credentials
   *
   * Returns STS temporary credentials scoped to PutObject on the dataset's
   * objects/ prefix. Intended for use with `aws s3 sync` for faster uploads
   * than presigned URLs.
   */
  datasetRoutes.post(
    "/:id/upload-credentials",
    authMiddleware,
    cliVersionGuard,
    zValidator("json", uploadCredentialsSchema),
    async (c) => {
      const datasetId = c.req.param("id");
      const { duration_seconds } = c.req.valid("json");
      const user = c.get("user");
      const db = c.env.DB;

      if (!isValidDatasetId(datasetId)) {
        return c.json({ error: "Invalid dataset ID format" }, 400);
      }

      // Verify dataset exists and user is owner or collaborator
      const dataset = await db
        .prepare("SELECT owner_user_id, is_sandbox FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ owner_user_id: number; is_sandbox: number }>();

      if (!dataset) {
        return c.json({ error: "Dataset not found" }, 404);
      }

      if (dataset.owner_user_id !== user.id && !hasRole(user.role, "admin")) {
        const isCollaborator = await isDatasetCollaborator(db, datasetId, user.id);

        if (!isCollaborator) {
          return c.json(
            { error: "Only dataset owner or collaborators can request upload credentials" },
            403,
          );
        }
      }

      // Non-admin users need explicit S3 permission for this prefix
      if (!hasRole(user.role, "admin")) {
        const hasPermission = await db
          .prepare("SELECT 1 FROM user_s3_permissions WHERE user_id = ? AND s3_prefix = ?")
          .bind(user.id, datasetId)
          .first();

        if (!hasPermission) {
          return c.json(
            {
              error: "You do not have S3 upload permission for this dataset",
              message: "Request access to this dataset first",
            },
            403,
          );
        }

        // Real-dataset uploads require service access (ADR 0010, #1013).
        // Collaborators keep download but cannot push bytes without passing
        // export-control review. Sandbox datasets are exempt.
        if (!dataset.is_sandbox) {
          const su = await db
            .prepare("SELECT service_access FROM users WHERE id = ?")
            .bind(user.id)
            .first<{ service_access: number }>();
          const gate = realDatasetServiceGate({ service_access: su?.service_access ?? 0 });
          if (gate) return c.json(gate, 403);
        }
      }

      // Update last_activity_at to prevent staleness cleanup
      await db
        .prepare("UPDATE datasets SET last_activity_at = datetime('now') WHERE dataset_id = ?")
        .bind(datasetId)
        .run();

      const policy = generateUploadPolicy(c.env.S3_BUCKET, datasetId);

      // Sanitize federation token name ([\w+=,.@-]{2,32})
      const tokenName = `upload-${datasetId}`.replace(/[^\w=,.@-]/g, "").slice(0, 32);
      if (tokenName.length < 2) {
        return c.json({ error: `Cannot generate token name from dataset ID: ${datasetId}` }, 400);
      }

      try {
        const token = await getFederationToken(
          {
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
            region: c.env.AWS_REGION,
          },
          {
            name: tokenName,
            policy,
            durationSeconds: duration_seconds ?? 7200,
          },
        );

        return c.json({
          credentials: {
            access_key_id: token.accessKeyId,
            secret_access_key: token.secretAccessKey,
            session_token: token.sessionToken,
            expiration: token.expiration,
          },
          s3: {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            prefix: `${datasetId}/objects`,
          },
        });
      } catch (error) {
        console.error("Failed to generate upload credentials:", error);
        return c.json({ error: "Failed to generate upload credentials" }, 502);
      }
    },
  );

  // Schema for download credentials request
  const downloadCredentialsSchema = z.object({
    duration_seconds: z.number().int().min(900).max(7200).optional(),
  });

  /**
   * POST /datasets/:id/download-credentials - Get temporary read-only S3 credentials
   *
   * Returns STS temporary credentials scoped to GetObject on the dataset's
   * objects/ prefix. Required for downloading private datasets via git-annex.
   * Public datasets use the publicurl path and don't need this endpoint.
   */
  datasetRoutes.post(
    "/:id/download-credentials",
    authMiddleware,
    zValidator("json", downloadCredentialsSchema),
    async (c) => {
      const datasetId = c.req.param("id");
      const { duration_seconds } = c.req.valid("json");
      const user = c.get("user");
      const db = c.env.DB;

      if (!isValidDatasetId(datasetId)) {
        return c.json({ error: "Invalid dataset ID format" }, 400);
      }

      const dataset = await db
        .prepare("SELECT owner_user_id, visibility FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ owner_user_id: number; visibility: string }>();

      if (!dataset) {
        return c.json({ error: "Dataset not found" }, 404);
      }

      if (dataset.visibility === "public") {
        return c.json({ error: "Public datasets do not require download credentials" }, 400);
      }

      // Owner or admin can always download; otherwise check collaborator status
      if (dataset.owner_user_id !== user.id && !hasRole(user.role, "admin")) {
        const isCollaborator = await isDatasetCollaborator(db, datasetId, user.id);

        if (!isCollaborator) {
          return c.json(
            { error: "Only dataset owner or collaborators can download this dataset" },
            403,
          );
        }
      }

      const policy = generateDownloadPolicy(c.env.S3_BUCKET, datasetId);

      const tokenName = `dl-${datasetId}`.replace(/[^\w=,.@-]/g, "").slice(0, 32);
      if (tokenName.length < 2) {
        return c.json({ error: `Cannot generate token name from dataset ID: ${datasetId}` }, 400);
      }

      try {
        const token = await getFederationToken(
          {
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
            region: c.env.AWS_REGION,
          },
          {
            name: tokenName,
            policy,
            durationSeconds: duration_seconds ?? 7200,
          },
        );

        return c.json({
          credentials: {
            access_key_id: token.accessKeyId,
            secret_access_key: token.secretAccessKey,
            session_token: token.sessionToken,
            expiration: token.expiration,
          },
          s3: {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            prefix: `${datasetId}/objects`,
          },
        });
      } catch (error) {
        console.error("Failed to generate download credentials:", error);
        return c.json({ error: "Failed to generate download credentials" }, 502);
      }
    },
  );

  /**
   * POST /datasets/:id/finalize - Finalize dataset repo setup after upload
   *
   * Pre-publish setup on a still-private repo: ensures the default branch is
   * "main", deploys the CI workflow shims, enables auto-merge, and applies the
   * private-repo collaborator spec. Branch protection is NOT applied here; it is
   * applied at make-public and removed at make-private (epic #713). Refuses on an
   * already-public dataset, whose repo spec is owned by the publication flow.
   */
  datasetRoutes.post("/:id/finalize", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const user = c.get("user");
    const db = c.env.DB;

    try {
      // Verify dataset exists and user is owner
      const dataset = await db
        .prepare(
          "SELECT owner_user_id, github_repo, status, visibility FROM datasets WHERE dataset_id = ?",
        )
        .bind(datasetId)
        .first<{
          owner_user_id: number;
          github_repo: string;
          status: string;
          visibility: string;
        }>();

      if (!dataset) {
        return c.json({ error: "Dataset not found" }, 404);
      }

      if (dataset.owner_user_id !== user.id && !hasRole(user.role, "admin")) {
        return c.json({ error: "Only dataset owner can finalize upload" }, 403);
      }

      // Finalize is a pre-publish step: it renames the default branch, re-commits
      // workflow templates, and applies the PRIVATE-repo collaborator spec. Running
      // it on an already-published dataset would push through the published-repo
      // ruleset and re-apply the private spec to a public repo. Publication and its
      // spec enforcement own the published repo instead.
      // `visibility` is NOT NULL CHECK ('private','public') (migration 0006), so
      // `=== "public"` is exhaustive today; revisit if a third state is ever added.
      if (dataset.visibility === "public") {
        return c.json(
          {
            error: "Cannot finalize a published dataset",
            message:
              "This dataset is already public; its repository spec is managed by the publication flow.",
          },
          409,
        );
      }

      // Note: We could track finalization state separately if needed
      // For now, finalize is idempotent - can be called multiple times

      // Track warnings for non-fatal operations
      const warnings: string[] = [];
      const pat = await getDatasetsToken(c.env);

      // Ensure default branch is "main" (handles DataLad or legacy repos)
      try {
        const branchResult = await ensureMainBranch(datasetId, pat);
        if (branchResult.renamed) {
          warnings.push(`Default branch renamed from "${branchResult.previousBranch}" to "main"`);
        }
      } catch (error) {
        console.error(`Failed to check/rename default branch for ${datasetId}:`, error);
        warnings.push("Could not verify default branch is 'main'; CI and protection may not work");
      }

      // Deploy GitHub Actions workflows (idempotent: only writes the missing
      // templates; in the steady state this is a single Contents API list call).
      let workflowDeployed: string[] = [];
      let workflowAlreadyPresent: string[] = [];
      try {
        const workflowResult = await ensureWorkflowsDeployed(datasetId, "main", pat);
        workflowDeployed = workflowResult.deployed;
        workflowAlreadyPresent = workflowResult.alreadyPresent;
        if (workflowResult.errors.length > 0) {
          console.error("Failed to deploy some workflows:", workflowResult.errors);
          warnings.push(
            `Some GitHub workflows could not be deployed: ${workflowResult.errors.join("; ")}`,
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("Failed to deploy workflows:", error);
        warnings.push(`GitHub workflow deployment failed: ${msg}`);
      }

      // No branch protection here (epic #713): a newly finalized dataset is
      // PRIVATE/unpublished and must stay open-push for curation. Protection is
      // applied at make-public and removed at make-private, not at creation.

      // Enable auto-merge
      try {
        await enableAutoMerge(datasetId, pat);
      } catch (error) {
        console.error("Failed to enable auto-merge:", error);
        warnings.push("Auto-merge could not be enabled; PRs will need manual merging");
      }

      // Ensure the owner holds maintain on their repo (the create-time grant is
      // non-fatal and can silently fail). Private reconcile: owner=maintain +
      // ledger writers=push, no ruleset.
      let finalizeRemoved: string[] | undefined;
      try {
        const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);
        const rec = await reconcileCollaborators(
          { repo: datasetId, visibility: "private", ownerLogin, approvedWriters },
          pat,
        );
        finalizeRemoved = rec.removed;
        if (rec.errors.length > 0) {
          warnings.push(`Collaborator reconcile: ${rec.errors.join("; ")}`);
        }
      } catch (error) {
        console.error("Failed to reconcile collaborators on finalize:", error);
      }
      // Mirror any reconcile removals into D1 (own try/catch; flags a divergence).
      await mirrorReconcileRemovals(db, datasetId, finalizeRemoved);

      // Update dataset timestamp (status remains 'active' per schema constraint)
      await db
        .prepare("UPDATE datasets SET updated_at = CURRENT_TIMESTAMP WHERE dataset_id = ?")
        .bind(datasetId)
        .run();

      // Audit log (non-fatal; don't fail the operation if this fails)
      try {
        await db
          .prepare(
            `
          INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
          VALUES (?, 'dataset_finalized', 'dataset', ?, ?)
        `,
          )
          .bind(user.id, datasetId, JSON.stringify({ finalized: true, warnings }))
          .run();
      } catch (auditError) {
        console.error(
          `Failed to write audit log for dataset ${datasetId} finalization:`,
          auditError,
        );
        // Continue; audit log failure should not fail the operation
      }

      const githubUrl = `https://github.com/${dataset.github_repo}`;

      return c.json({
        message:
          warnings.length > 0
            ? "Dataset finalized with warnings"
            : "Dataset finalized successfully",
        warnings: warnings.length > 0 ? warnings : undefined,
        dataset: {
          dataset_id: datasetId,
          status: "active",
          github_url: githubUrl,
        },
        workflows: {
          deployed: workflowDeployed,
          already_present: workflowAlreadyPresent,
        },
      });
    } catch (error) {
      console.error("Error finalizing dataset:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return c.json({ error: "Failed to finalize dataset", details: errorMessage }, 500);
    }
  });
}
