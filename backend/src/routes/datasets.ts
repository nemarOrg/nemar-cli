/**
 * Dataset routes
 *
 * Handles dataset creation, listing, and metadata.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth";
import { generateDatasetId, isValidDatasetId } from "../services/datasetId";
import { sendPublicationRequestEmail } from "../services/email";
import { decrypt } from "../services/encryption";
import {
  type GitHubRepo,
  addCollaborator,
  applyBranchProtection,
  checkWorkflowExists,
  createRepository,
  deployWorkflows,
  enableAutoMerge,
  getWorkflowRuns,
} from "../services/github";
import { grantDatasetAccess } from "../services/iam";
import { generateDatasetUploadUrls, getManifest, listManifests } from "../services/s3";
import type { Bindings, Variables } from "../types/bindings";

export const datasetRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Extract repository name from github_repo format "org/repo"
 * Returns null if format is invalid
 */
function extractRepoName(githubRepo: string): string | null {
  if (!githubRepo || !githubRepo.includes("/")) {
    return null;
  }
  const parts = githubRepo.split("/");
  if (parts.length !== 2 || !parts[1]) {
    return null;
  }
  return parts[1];
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
 * POST /datasets - Create a new dataset
 *
 * Creates GitHub repo, assigns dataset ID, and returns presigned URLs for upload.
 * Uses per-user AWS credentials for scoped S3 access.
 */
datasetRoutes.post("/", authMiddleware, zValidator("json", createDatasetSchema), async (c) => {
  const { name, description, files, sandbox } = c.req.valid("json");
  const user = c.get("user");
  const db = c.env.DB;

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

  // Get user's AWS credentials and admin status
  const userCreds = await db
    .prepare(`
      SELECT aws_iam_username, aws_access_key_id_encrypted, aws_secret_access_key_encrypted, is_admin
      FROM users WHERE id = ?
    `)
    .bind(user.id)
    .first<{
      aws_iam_username: string | null;
      aws_access_key_id_encrypted: string | null;
      aws_secret_access_key_encrypted: string | null;
      is_admin: number;
    }>();

  if (!userCreds?.aws_access_key_id_encrypted || !userCreds?.aws_secret_access_key_encrypted) {
    return c.json(
      {
        error: "S3 access not configured for your account",
        message: "Please contact an administrator to set up your S3 credentials.",
      },
      403,
    );
  }

  // Decrypt user's AWS credentials
  let userAccessKeyId: string;
  let userSecretAccessKey: string;
  try {
    if (!c.env.ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY not configured");
    }
    userAccessKeyId = await decrypt(userCreds.aws_access_key_id_encrypted, c.env.ENCRYPTION_KEY);
    userSecretAccessKey = await decrypt(
      userCreds.aws_secret_access_key_encrypted,
      c.env.ENCRYPTION_KEY,
    );
  } catch (error) {
    console.error("Failed to decrypt user credentials:", error);
    return c.json({ error: "Failed to access S3 credentials" }, 500);
  }

  // Generate dataset ID (xx000XXX for sandbox, nm000XXX for regular)
  const datasetId = await generateDatasetId(db, !!sandbox);

  // Create GitHub repository
  let githubRepo: GitHubRepo;
  try {
    githubRepo = await createRepository(
      datasetId,
      `${name} - NEMAR Dataset`,
      true, // Private - owner added as collaborator
      c.env.GITHUB_ADMIN_PAT,
    );
  } catch (error) {
    console.error("Failed to create GitHub repo:", error);
    return c.json({ error: "Failed to create GitHub repository" }, 500);
  }

  // Add dataset owner as maintainer
  try {
    await addCollaborator(datasetId, user.github_username, "maintain", c.env.GITHUB_ADMIN_PAT);
  } catch (error) {
    console.error("Failed to add owner as collaborator:", error);
  }

  // Update user's IAM policy to include this dataset prefix
  // Skip for admins - they already have full bucket access
  if (userCreds.aws_iam_username && !userCreds.is_admin) {
    try {
      // Get user's current prefixes
      const currentPermissions = await db
        .prepare("SELECT s3_prefix FROM user_s3_permissions WHERE user_id = ?")
        .bind(user.id)
        .all<{ s3_prefix: string }>();

      const currentPrefixes = currentPermissions.results?.map((p) => p.s3_prefix) || [];

      // Update IAM policy to include new dataset
      await grantDatasetAccess(
        {
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          region: c.env.AWS_REGION,
        },
        c.env.S3_BUCKET,
        userCreds.aws_iam_username,
        currentPrefixes,
        datasetId,
      );

      // Record the permission in database
      await db
        .prepare(`
          INSERT INTO user_s3_permissions (user_id, s3_prefix, permission, granted_by)
          VALUES (?, ?, 'read_write', ?)
        `)
        .bind(user.id, datasetId, user.id)
        .run();
    } catch (error) {
      console.error("Failed to update IAM policy for dataset:", datasetId, error);
      return c.json(
        {
          error: "Failed to configure S3 access for dataset",
          details: error instanceof Error ? error.message : "Unknown error",
          dataset_id: datasetId,
          github_repo: githubRepo.full_name,
          note: "GitHub repository was created but S3 upload permissions could not be configured. Contact an administrator.",
        },
        500,
      );
    }
  }

  // NOTE: Branch protection is applied in the finalize endpoint after initial upload

  // Generate presigned URLs for data files using user's credentials
  let uploadUrls: Record<string, string> = {};
  if (files && files.length > 0) {
    const dataFiles = files.filter((f) => f.type === "data").map((f) => f.path);
    if (dataFiles.length > 0) {
      try {
        uploadUrls = await generateDatasetUploadUrls(
          {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            accessKeyId: userAccessKeyId,
            secretAccessKey: userSecretAccessKey,
          },
          datasetId,
          dataFiles,
        );
      } catch (error) {
        console.error("Failed to generate presigned URLs:", error);
        return c.json(
          {
            error: "Failed to generate upload URLs",
            details: error instanceof Error ? error.message : "Unknown error",
            dataset_id: datasetId,
            github_repo: githubRepo.full_name,
            note: "Dataset and GitHub repository were created, but upload URLs could not be generated.",
          },
          500,
        );
      }
    }
  }

  // Insert dataset record
  await db
    .prepare(
      `
    INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo, is_sandbox)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .bind(datasetId, name, description || null, user.id, githubRepo.full_name, sandbox ? 1 : 0)
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
});

/**
 * GET /datasets - List datasets
 *
 * Visibility rules:
 * - --mine flag: show only the authenticated user's datasets (private + public + sandbox)
 * - No --mine flag (public catalog):
 *   - Sandbox datasets are ALWAYS excluded (sandbox is for testing workflow only)
 *   - Unauthenticated: public datasets only
 *   - Authenticated non-admin: public datasets only
 *   - Admin: all datasets (public + private from all users, excluding sandbox)
 */
datasetRoutes.get("/", optionalAuthMiddleware, async (c) => {
  const mine = c.req.query("mine") === "true";
  const status = c.req.query("status") || "active";
  const limit = Number.parseInt(c.req.query("limit") || "50", 10);
  const offset = Number.parseInt(c.req.query("offset") || "0", 10);
  const user = c.get("user");
  const db = c.env.DB;

  let query = `
    SELECT
      d.dataset_id,
      d.name,
      d.description,
      d.status,
      d.visibility,
      d.github_repo,
      d.concept_doi,
      d.created_at,
      d.updated_at,
      u.username as owner_username
    FROM datasets d
    JOIN users u ON d.owner_user_id = u.id
    WHERE d.status = ?
  `;
  const params: (string | number)[] = [status];

  if (mine) {
    // User wants to see only their own datasets
    if (!user) {
      return c.json({ error: "Authentication required to view your datasets" }, 401);
    }
    query += " AND d.owner_user_id = ?";
    params.push(user.id);
    // User can see their own datasets regardless of visibility (including sandbox)
  } else {
    // Public catalog view
    // Exclude sandbox datasets from public listings (sandbox is for testing workflow only)
    query += " AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)";

    // Filter by visibility based on user permissions
    if (!user) {
      // Unauthenticated: public datasets only
      query += " AND d.visibility = 'public'";
    } else if (!user.is_admin) {
      // Authenticated non-admin: public datasets only
      // (use --mine to see your own private datasets)
      query += " AND d.visibility = 'public'";
    }
    // Admin: show all datasets (no additional filter)
  }

  query += " ORDER BY d.created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  let queryResult;
  try {
    queryResult = await db
      .prepare(query)
      .bind(...params)
      .all();
  } catch (dbError) {
    const msg = dbError instanceof Error ? dbError.message : String(dbError);
    console.error("Failed to query datasets:", msg, "Query params:", params);
    return c.json(
      {
        error: "Failed to retrieve datasets",
        details: msg,
      },
      500,
    );
  }

  if (!queryResult || !queryResult.results) {
    console.error("Database query returned invalid result structure for datasets list");
    return c.json(
      {
        error: "Database query failed",
        details: "Query did not return expected result structure",
      },
      500,
    );
  }

  return c.json({
    datasets: queryResult.results,
    count: queryResult.results.length,
  });
});

/**
 * GET /datasets/:id - Get dataset details
 *
 * Visibility rules:
 * - Public datasets: accessible to everyone
 * - Private datasets: only accessible to owner or admin
 */
datasetRoutes.get("/:id", optionalAuthMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  if (!isValidDatasetId(datasetId)) {
    return c.json({ error: "Invalid dataset ID format" }, 400);
  }

  const dataset = await db
    .prepare(
      `
    SELECT
      d.*,
      u.username as owner_username,
      u.github_username as owner_github
    FROM datasets d
    JOIN users u ON d.owner_user_id = u.id
    WHERE d.dataset_id = ?
  `,
    )
    .bind(datasetId)
    .first();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Enforce visibility restrictions for private datasets
  if (dataset.visibility !== "public") {
    if (!user || (!user.is_admin && user.id !== dataset.owner_user_id)) {
      // Return 404 instead of 403 to avoid leaking dataset existence
      return c.json({ error: "Dataset not found" }, 404);
    }
  }

  return c.json({ dataset });
});

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

    if (dataset.owner_user_id !== user.id && !user.is_admin) {
      // Check if user is a collaborator
      const isCollaborator = await db
        .prepare(
          "SELECT 1 FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE d.dataset_id = ? AND dc.user_id = ?",
        )
        .bind(datasetId, user.id)
        .first();

      if (!isCollaborator) {
        return c.json(
          { error: "Only dataset owner or collaborators can request upload URLs" },
          403,
        );
      }
    }

    // Get user's encrypted credentials
    const userCreds = await db
      .prepare(`
        SELECT aws_iam_username, aws_access_key_id_encrypted, aws_secret_access_key_encrypted
        FROM users WHERE id = ?
      `)
      .bind(user.id)
      .first<{
        aws_iam_username: string | null;
        aws_access_key_id_encrypted: string | null;
        aws_secret_access_key_encrypted: string | null;
      }>();

    if (!userCreds?.aws_access_key_id_encrypted || !userCreds?.aws_secret_access_key_encrypted) {
      return c.json(
        {
          error: "S3 credentials not configured for your account",
          message: "Contact an administrator to set up your S3 access",
        },
        403,
      );
    }

    // Check if user has permission for this dataset prefix
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

    // Decrypt user credentials
    if (!c.env.ENCRYPTION_KEY) {
      console.error("ENCRYPTION_KEY not configured");
      return c.json({ error: "Server configuration error" }, 500);
    }

    let userAccessKeyId: string;
    let userSecretAccessKey: string;
    try {
      userAccessKeyId = await decrypt(userCreds.aws_access_key_id_encrypted, c.env.ENCRYPTION_KEY);
      userSecretAccessKey = await decrypt(
        userCreds.aws_secret_access_key_encrypted,
        c.env.ENCRYPTION_KEY,
      );
    } catch (error) {
      console.error("Failed to decrypt user credentials:", error);
      return c.json({ error: "Failed to access your S3 credentials" }, 500);
    }

    // Generate presigned URLs using user's credentials
    const uploadUrls = await generateDatasetUploadUrls(
      {
        bucket: c.env.S3_BUCKET,
        region: c.env.AWS_REGION,
        accessKeyId: userAccessKeyId,
        secretAccessKey: userSecretAccessKey,
      },
      datasetId,
      files,
    );

    return c.json({ upload_urls: uploadUrls });
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

    if (dataset.owner_user_id !== user.id && !user.is_admin) {
      return c.json({ error: "Only dataset owner can finalize upload" }, 403);
    }

    // Note: We could track finalization state separately if needed
    // For now, finalize is idempotent - can be called multiple times

    // Track warnings for non-fatal operations
    const warnings: string[] = [];

    // Deploy GitHub Actions workflows
    try {
      const workflowResult = await deployWorkflows(datasetId, c.env.GITHUB_ADMIN_PAT);
      if (!workflowResult.success) {
        console.error("Failed to deploy some workflows:", workflowResult.errors);
        warnings.push(
          "Some GitHub workflows could not be deployed; PR-based uploads may not work correctly",
        );
      }
    } catch (error) {
      console.error("Failed to deploy workflows:", error);
      warnings.push("GitHub workflow deployment failed");
    }

    // Apply branch protection (requires workflows to be deployed first for status checks)
    try {
      await applyBranchProtection(datasetId, c.env.GITHUB_ADMIN_PAT);
    } catch (error) {
      console.error("Failed to apply branch protection:", error);
      warnings.push(
        "Branch protection could not be applied; direct pushes to main may be possible",
      );
    }

    // Enable auto-merge
    try {
      await enableAutoMerge(datasetId, c.env.GITHUB_ADMIN_PAT);
    } catch (error) {
      console.error("Failed to enable auto-merge:", error);
      warnings.push("Auto-merge could not be enabled; PRs will need manual merging");
    }

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
      console.error(`Failed to write audit log for dataset ${datasetId} finalization:`, auditError);
      // Continue; audit log failure should not fail the operation
    }

    const githubUrl = `https://github.com/${dataset.github_repo}`;

    return c.json({
      message:
        warnings.length > 0 ? "Dataset finalized with warnings" : "Dataset finalized successfully",
      warnings: warnings.length > 0 ? warnings : undefined,
      dataset: {
        dataset_id: datasetId,
        status: "active",
        github_url: githubUrl,
      },
    });
  } catch (error) {
    console.error("Error finalizing dataset:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: "Failed to finalize dataset", details: errorMessage }, 500);
  }
});

/**
 * POST /datasets/:id/request-access - Request collaborator access to a dataset
 *
 * Auto-grants access for public repos. User can then push data via git-annex.
 * For metadata-only changes, users can fork and PR without this.
 */
datasetRoutes.post("/:id/request-access", authMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  // Get dataset info
  const dataset = await db
    .prepare(
      "SELECT id, dataset_id, name, github_repo, owner_user_id FROM datasets WHERE dataset_id = ?",
    )
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      github_repo: string | null;
      owner_user_id: number;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  // Check if already a collaborator
  const existing = await db
    .prepare("SELECT id FROM dataset_collaborators WHERE dataset_id = ? AND user_id = ?")
    .bind(dataset.id, user.id)
    .first();

  if (existing) {
    return c.json({ error: "You already have access to this dataset" }, 409);
  }

  // Check if user is the owner
  if (dataset.owner_user_id === user.id) {
    return c.json({ error: "You are the owner of this dataset" }, 409);
  }

  // Extract repo name with defensive check
  const repoName = extractRepoName(dataset.github_repo);
  if (!repoName) {
    console.error(`Invalid github_repo format: ${dataset.github_repo}`);
    return c.json({ error: "Dataset has invalid GitHub repository configuration" }, 500);
  }

  // Add as collaborator on GitHub
  try {
    await addCollaborator(repoName, user.github_username, "push", c.env.GITHUB_ADMIN_PAT);
  } catch (error) {
    console.error("Failed to add collaborator on GitHub:", error);
    return c.json({ error: "Failed to grant access on GitHub" }, 500);
  }

  // Record in our database
  try {
    await db
      .prepare(
        "INSERT INTO dataset_collaborators (dataset_id, user_id, access_type) VALUES (?, ?, 'requested')",
      )
      .bind(dataset.id, user.id)
      .run();

    // Audit log
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'dataset_access_granted', 'dataset', ?, ?)",
      )
      .bind(user.id, datasetId, JSON.stringify({ access_type: "requested" }))
      .run();
  } catch (dbError) {
    // GitHub succeeded but DB failed - log error but don't fail the request
    // User has access on GitHub; DB record can be reconciled later
    console.error("Failed to record collaborator in database:", dbError);
  }

  return c.json({
    message: `Access granted to ${dataset.name}`,
    dataset_id: datasetId,
    github_repo: dataset.github_repo,
  });
});

/**
 * POST /datasets/:id/invite - Invite a user as collaborator (owner/admin only)
 *
 * Works for both public and private repos.
 */
const inviteSchema = z.object({
  username: z.string().min(1, "Username is required"),
});

datasetRoutes.post("/:id/invite", authMiddleware, zValidator("json", inviteSchema), async (c) => {
  const datasetId = c.req.param("id");
  const { username } = c.req.valid("json");
  const currentUser = c.get("user");
  const db = c.env.DB;

  // Get dataset info
  const dataset = await db
    .prepare(
      "SELECT id, dataset_id, name, github_repo, owner_user_id FROM datasets WHERE dataset_id = ?",
    )
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      github_repo: string | null;
      owner_user_id: number;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Only owner or admin can invite
  if (dataset.owner_user_id !== currentUser.id && !currentUser.is_admin) {
    return c.json({ error: "Only dataset owner or admin can invite collaborators" }, 403);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  // Find the user to invite
  const invitee = await db
    .prepare("SELECT id, username, github_username, status FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: number; username: string; github_username: string; status: string }>();

  if (!invitee) {
    return c.json({ error: `User '${username}' not found` }, 404);
  }

  if (invitee.status !== "approved") {
    return c.json({ error: `User '${username}' is not approved yet` }, 400);
  }

  // Check if already a collaborator
  const existing = await db
    .prepare("SELECT id FROM dataset_collaborators WHERE dataset_id = ? AND user_id = ?")
    .bind(dataset.id, invitee.id)
    .first();

  if (existing) {
    return c.json({ error: `User '${username}' already has access to this dataset` }, 409);
  }

  // Check if invitee is the owner
  if (dataset.owner_user_id === invitee.id) {
    return c.json({ error: `User '${username}' is the owner of this dataset` }, 409);
  }

  // Extract repo name with defensive check
  const repoName = extractRepoName(dataset.github_repo);
  if (!repoName) {
    console.error(`Invalid github_repo format: ${dataset.github_repo}`);
    return c.json({ error: "Dataset has invalid GitHub repository configuration" }, 500);
  }

  // Add as collaborator on GitHub
  try {
    await addCollaborator(repoName, invitee.github_username, "push", c.env.GITHUB_ADMIN_PAT);
  } catch (error) {
    console.error("Failed to add collaborator on GitHub:", error);
    return c.json({ error: "Failed to grant access on GitHub" }, 500);
  }

  // Record in our database
  try {
    await db
      .prepare(
        "INSERT INTO dataset_collaborators (dataset_id, user_id, granted_by, access_type) VALUES (?, ?, ?, 'invited')",
      )
      .bind(dataset.id, invitee.id, currentUser.id)
      .run();

    // Audit log
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'dataset_access_granted', 'dataset', ?, ?)",
      )
      .bind(
        currentUser.id,
        datasetId,
        JSON.stringify({ invitee: username, access_type: "invited" }),
      )
      .run();
  } catch (dbError) {
    // GitHub succeeded but DB failed - log error but don't fail the request
    // User has access on GitHub; DB record can be reconciled later
    console.error("Failed to record collaborator in database:", dbError);
  }

  return c.json({
    message: `User '${username}' invited to ${dataset.name}`,
    dataset_id: datasetId,
    invitee: username,
  });
});

/**
 * GET /datasets/:id/collaborators - List collaborators for a dataset
 */
datasetRoutes.get("/:id/collaborators", authMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const currentUser = c.get("user");
  const db = c.env.DB;

  // Get dataset info
  const dataset = await db
    .prepare("SELECT id, owner_user_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ id: number; owner_user_id: number }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Only owner or admin can view collaborators
  if (dataset.owner_user_id !== currentUser.id && !currentUser.is_admin) {
    return c.json({ error: "Only dataset owner or admin can view collaborators" }, 403);
  }

  const collaborators = await db
    .prepare(
      `SELECT u.username, u.github_username, dc.access_type, dc.granted_at,
              g.username as granted_by_username
       FROM dataset_collaborators dc
       JOIN users u ON dc.user_id = u.id
       LEFT JOIN users g ON dc.granted_by = g.id
       WHERE dc.dataset_id = ?
       ORDER BY dc.granted_at DESC`,
    )
    .bind(dataset.id)
    .all();

  return c.json({
    dataset_id: datasetId,
    collaborators: collaborators.results,
    count: collaborators.results.length,
  });
});

// ============================================================================
// Publication Workflow (User-facing)
// ============================================================================

/**
 * POST /datasets/:id/publish/request - Request publication of a dataset
 */
datasetRoutes.post("/:id/publish/request", authMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const currentUser = c.get("user");
  const db = c.env.DB;

  const dataset = await db
    .prepare("SELECT id, dataset_id, owner_user_id, is_sandbox FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ id: number; dataset_id: string; owner_user_id: number; is_sandbox: number | null }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (dataset.owner_user_id !== currentUser.id && !currentUser.is_admin) {
    return c.json({ error: "Only the dataset owner can request publication" }, 403);
  }

  if (dataset.is_sandbox || dataset.dataset_id.startsWith("xx")) {
    return c.json({ error: "Cannot publish sandbox datasets" }, 400);
  }

  // Check for existing active request
  const existing = await db
    .prepare(
      "SELECT id, status FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving') ORDER BY requested_at DESC LIMIT 1",
    )
    .bind(datasetId)
    .first<{ id: number; status: string }>();

  if (existing) {
    return c.json(
      {
        error: "A publication request already exists",
        status: existing.status,
        message:
          existing.status === "approving"
            ? "Publication is in progress"
            : "Use 'resend' to remind admins",
      },
      409,
    );
  }

  // Create publication request
  await db
    .prepare("INSERT INTO publication_requests (dataset_id, requested_by) VALUES (?, ?)")
    .bind(datasetId, currentUser.id)
    .run();

  // Notify admins
  try {
    const admins = await db
      .prepare("SELECT email FROM users WHERE is_admin = 1")
      .all<{ email: string }>();

    const adminEmails = admins.results.map((a) => a.email);
    if (adminEmails.length > 0) {
      await sendPublicationRequestEmail(
        adminEmails,
        datasetId,
        currentUser.username,
        c.env.RESEND_API_KEY,
      );
    }
  } catch (emailError) {
    console.error("Failed to send publication request notification:", emailError);
  }

  return c.json({
    message: "Publication request submitted",
    dataset_id: datasetId,
    status: "requested",
  });
});

/**
 * GET /datasets/:id/publish/status - Get publication status
 */
datasetRoutes.get("/:id/publish/status", authMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const currentUser = c.get("user");
  const db = c.env.DB;

  const dataset = await db
    .prepare("SELECT id, owner_user_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ id: number; owner_user_id: number }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (dataset.owner_user_id !== currentUser.id && !currentUser.is_admin) {
    return c.json({ error: "Only the dataset owner or admin can view publication status" }, 403);
  }

  const request = await db
    .prepare(
      `SELECT pr.*, u.username as requested_by_username
       FROM publication_requests pr
       JOIN users u ON pr.requested_by = u.id
       WHERE pr.dataset_id = ?
       ORDER BY pr.requested_at DESC
       LIMIT 1`,
    )
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      status: string;
      requested_at: string;
      requested_by_username: string;
      approved_at: string | null;
      denied_at: string | null;
      denied_reason: string | null;
      steps_completed: string;
      current_step: string | null;
      last_error: string | null;
      updated_at: string;
    }>();

  if (!request) {
    return c.json({
      dataset_id: datasetId,
      status: "none",
      message: "No publication request found",
    });
  }

  return c.json({
    dataset_id: datasetId,
    status: request.status,
    requested_at: request.requested_at,
    requested_by: request.requested_by_username,
    approved_at: request.approved_at,
    denied_at: request.denied_at,
    denied_reason: request.denied_reason,
    steps_completed: JSON.parse(request.steps_completed || "[]"),
    current_step: request.current_step,
    last_error: request.last_error,
    updated_at: request.updated_at,
  });
});

/**
 * POST /datasets/:id/publish/resend - Resend publication request notification
 */
datasetRoutes.post("/:id/publish/resend", authMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const currentUser = c.get("user");
  const db = c.env.DB;

  const dataset = await db
    .prepare("SELECT id, owner_user_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ id: number; owner_user_id: number }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (dataset.owner_user_id !== currentUser.id && !currentUser.is_admin) {
    return c.json({ error: "Only the dataset owner can resend notifications" }, 403);
  }

  const request = await db
    .prepare(
      "SELECT id, status, updated_at FROM publication_requests WHERE dataset_id = ? AND status = 'requested' ORDER BY requested_at DESC LIMIT 1",
    )
    .bind(datasetId)
    .first<{ id: number; status: string; updated_at: string }>();

  if (!request) {
    return c.json({ error: "No pending publication request found" }, 404);
  }

  // Rate limit: 30 minutes between resends
  const lastUpdate = new Date(request.updated_at).getTime();
  const cooldownMs = 30 * 60 * 1000;
  if (Date.now() - lastUpdate < cooldownMs) {
    return c.json({ error: "Please wait before resending (30 min cooldown)" }, 429);
  }

  // Update timestamp for rate limiting
  await db
    .prepare("UPDATE publication_requests SET updated_at = datetime('now') WHERE id = ?")
    .bind(request.id)
    .run();

  // Resend notification to admins
  const admins = await db
    .prepare("SELECT email FROM users WHERE is_admin = 1")
    .all<{ email: string }>();

  const adminEmails = admins.results.map((a) => a.email);
  if (adminEmails.length > 0) {
    await sendPublicationRequestEmail(
      adminEmails,
      datasetId,
      currentUser.username,
      c.env.RESEND_API_KEY,
    );
  }

  return c.json({
    message: "Notification resent to admins",
    dataset_id: datasetId,
  });
});

/**
 * GET /datasets/:id/ci/status - Check CI status for a dataset (user-accessible)
 *
 * Returns CI workflow presence and latest run status.
 * Authenticated users can check any dataset they own or collaborate on.
 */
datasetRoutes.get("/:id/ci/status", authMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;
  const currentUser = c.get("user");

  const dataset = await db
    .prepare(
      `SELECT d.dataset_id, d.github_repo, u.username as owner_username
       FROM datasets d
       JOIN users u ON d.owner_user_id = u.id
       WHERE d.dataset_id = ?`,
    )
    .bind(datasetId)
    .first<{ dataset_id: string; github_repo: string | null; owner_username: string }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Check ownership or admin status
  if (dataset.owner_username !== currentUser.username && !currentUser.is_admin) {
    return c.json({ error: "Access denied" }, 403);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = extractRepoName(dataset.github_repo);
  if (!repoName) {
    return c.json({ error: "Invalid repository format" }, 500);
  }

  const pat = c.env.GITHUB_ADMIN_PAT;

  let bidsWorkflowExists = false;
  let latestRunStatus = "unknown";
  let latestRunUrl: string | null = null;

  try {
    bidsWorkflowExists = await checkWorkflowExists(
      repoName,
      ".github/workflows/bids-validation.yml",
      pat,
    );

    if (bidsWorkflowExists) {
      const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
      if (runs.length > 0) {
        const latest = runs[0];
        latestRunStatus = latest.conclusion || latest.status;
        latestRunUrl = latest.html_url;
      } else {
        latestRunStatus = "no_runs";
      }
    }
  } catch (githubError) {
    const msg = githubError instanceof Error ? githubError.message : String(githubError);
    console.error(`[ci/status] GitHub API error for ${datasetId} (repo: ${repoName}):`, msg);
    return c.json({ error: `GitHub API error: ${msg}` }, 502);
  }

  return c.json({
    dataset_id: datasetId,
    bids_validation: {
      present: bidsWorkflowExists,
      status: bidsWorkflowExists ? latestRunStatus : "missing",
      url: latestRunUrl,
    },
  });
});

// ============================================================================
// Version Manifests
// ============================================================================

/**
 * GET /datasets/:id/manifest - List available version manifests
 */
datasetRoutes.get("/:id/manifest", optionalAuthMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;

  const dataset = await db
    .prepare("SELECT dataset_id, visibility, owner_user_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; visibility: string; owner_user_id: number }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Public datasets: anyone can view manifests
  // Private datasets: only owner/admin
  if (dataset.visibility !== "public") {
    const user = c.get("user");
    if (!user || (!user.is_admin && user.id !== dataset.owner_user_id)) {
      return c.json({ error: "Access denied" }, 403);
    }
  }

  const s3Options = {
    bucket: c.env.S3_BUCKET,
    region: c.env.AWS_REGION,
    accessKeyId: c.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
  };

  const versions = await listManifests(s3Options, datasetId);

  return c.json({
    dataset_id: datasetId,
    versions,
  });
});

/**
 * GET /datasets/:id/manifest/:version - Get a specific version manifest
 */
datasetRoutes.get("/:id/manifest/:version", optionalAuthMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const version = c.req.param("version");
  const db = c.env.DB;

  const dataset = await db
    .prepare("SELECT dataset_id, visibility, owner_user_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; visibility: string; owner_user_id: number }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (dataset.visibility !== "public") {
    const user = c.get("user");
    if (!user || (!user.is_admin && user.id !== dataset.owner_user_id)) {
      return c.json({ error: "Access denied" }, 403);
    }
  }

  const s3Options = {
    bucket: c.env.S3_BUCKET,
    region: c.env.AWS_REGION,
    accessKeyId: c.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
  };

  const manifestJson = await getManifest(s3Options, datasetId, version);
  if (!manifestJson) {
    return c.json({ error: "Manifest not found for this version" }, 404);
  }

  return c.json(JSON.parse(manifestJson));
});
