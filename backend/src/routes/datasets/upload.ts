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
import { type Bindings, hasRole } from "../../types/bindings";
import type { DatasetsRouter } from "./shared";

/**
 * True when `userId` is a collaborator on the dataset identified by its public
 * string id. Centralizes the owner/admin-bypass authorization check shared by
 * GET /:id, POST /:id/upload-credentials, and POST /:id/download-credentials
 * (#190).
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

// File schema for upload requests
const fileSchema = z.object({
  path: z.string(),
  size: z.number().int().positive(),
  type: z.enum(["metadata", "data"]),
});

// Create dataset schema
const createDatasetSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().optional(),
  files: z.array(fileSchema).optional(),
  sandbox: z.boolean().optional(), // If true, creates sandbox dataset (xx000XXX)
});

// Sandbox file size limit: 10MB total
const SANDBOX_MAX_TOTAL_SIZE = 10 * 1024 * 1024;

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
      const { name, description, files, sandbox: requestedSandbox } = c.req.valid("json");
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

      // Check if non-sandbox upload requires sandbox training
      if (!sandbox) {
        const userStatus = await db
          .prepare("SELECT sandbox_completed FROM users WHERE id = ?")
          .bind(user.id)
          .first<{ sandbox_completed: number }>();

        if (!userStatus?.sandbox_completed) {
          return c.json(
            {
              error: "Sandbox training required",
              message:
                "You must complete sandbox training before uploading real datasets. Run 'nemar sandbox' to complete training.",
            },
            403,
          );
        }
      }

      // Validate sandbox file size limit
      if (sandbox && files && files.length > 0) {
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        if (totalSize > SANDBOX_MAX_TOTAL_SIZE) {
          const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
          const limitMB = (SANDBOX_MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0);
          return c.json(
            {
              error: "Sandbox file size limit exceeded",
              message: `Sandbox datasets are limited to ${limitMB}MB total. Your dataset is ${sizeMB}MB. Sandbox is for testing the workflow, not storing real data.`,
              total_size: totalSize,
              limit: SANDBOX_MAX_TOTAL_SIZE,
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
      let datasetId: string;
      const MAX_ID_RETRIES = 3;
      for (let attempt = 0; ; attempt++) {
        datasetId = await generateDatasetId(db, !!sandbox);
        try {
          // Claim the ID early with a minimal INSERT to close the TOCTOU gap.
          // license/license_tier are intentionally omitted: no license is known
          // at upload time, so license_tier rests on its NOT NULL DEFAULT
          // 'unknown' (0034) until enrichment sets the real value via
          // writeDatasetCatalogFields. If `license` is ever added here, add
          // license_tier alongside it or the tier will stay stale (#653).
          await db
            .prepare(
              `INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo, is_sandbox, visibility)
             VALUES (?, ?, ?, ?, '', ?, 'private')`,
            )
            .bind(datasetId, name, description || null, user.id, sandbox ? 1 : 0)
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
        .prepare("SELECT owner_user_id FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ owner_user_id: number }>();

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
        .prepare("SELECT owner_user_id FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ owner_user_id: number }>();

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
   * POST /datasets/:id/finalize - Finalize dataset after upload
   *
   * Applies branch protection and marks dataset as published.
   * Should be called after initial upload is complete.
   */
  datasetRoutes.post("/:id/finalize", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const user = c.get("user");
    const db = c.env.DB;

    try {
      // Verify dataset exists and user is owner
      const dataset = await db
        .prepare("SELECT owner_user_id, github_repo, status FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ owner_user_id: number; github_repo: string; status: string }>();

      if (!dataset) {
        return c.json({ error: "Dataset not found" }, 404);
      }

      if (dataset.owner_user_id !== user.id && !hasRole(user.role, "admin")) {
        return c.json({ error: "Only dataset owner can finalize upload" }, 403);
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
