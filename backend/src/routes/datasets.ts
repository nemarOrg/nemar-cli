/**
 * Dataset routes
 *
 * Handles dataset creation, listing, and metadata.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Bindings, Variables } from "../types/bindings";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth";
import { generateDatasetId, isValidDatasetId } from "../services/datasetId";
import { createRepository, addCollaborator, applyBranchProtection, enableAutoMerge, deployWorkflows } from "../services/github";
import { generateDatasetUploadUrls } from "../services/s3";
import { decrypt } from "../services/encryption";
import { grantDatasetAccess } from "../services/iam";

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
      return c.json({
        error: "Sandbox training required",
        message: "You must complete sandbox training before uploading real datasets. Run 'nemar sandbox' to complete training.",
      }, 403);
    }
  }

  // Get user's AWS credentials
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
    return c.json({
      error: "S3 access not configured for your account",
      message: "Please contact an administrator to set up your S3 credentials.",
    }, 403);
  }

  // Decrypt user's AWS credentials
  let userAccessKeyId: string;
  let userSecretAccessKey: string;
  try {
    if (!c.env.ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY not configured");
    }
    userAccessKeyId = await decrypt(userCreds.aws_access_key_id_encrypted, c.env.ENCRYPTION_KEY);
    userSecretAccessKey = await decrypt(userCreds.aws_secret_access_key_encrypted, c.env.ENCRYPTION_KEY);
  } catch (error) {
    console.error("Failed to decrypt user credentials:", error);
    return c.json({ error: "Failed to access S3 credentials" }, 500);
  }

  // Generate dataset ID (xx000XXX for sandbox, nm000XXX for regular)
  const datasetId = await generateDatasetId(db, !!sandbox);

  // Create GitHub repository
  let githubRepo;
  try {
    githubRepo = await createRepository(
      datasetId,
      `${name} - NEMAR Dataset`,
      true, // Private - owner added as collaborator
      c.env.GITHUB_ADMIN_PAT
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
  if (userCreds.aws_iam_username) {
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
  `
    )
    .bind(datasetId, name, description || null, user.id, githubRepo.full_name, sandbox ? 1 : 0)
    .run();

  // Audit log
  await db
    .prepare(
      `
    INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
    VALUES (?, 'dataset_created', 'dataset', ?, ?)
  `
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
    201
  );
});

/**
 * GET /datasets - List datasets
 *
 * Public endpoint with optional auth for filtering to own datasets.
 */
datasetRoutes.get("/", optionalAuthMiddleware, async (c) => {
  const mine = c.req.query("mine") === "true";
  const status = c.req.query("status") || "active";
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const user = c.get("user");
  const db = c.env.DB;

  let query = `
    SELECT
      d.dataset_id,
      d.name,
      d.description,
      d.status,
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
    if (!user) {
      return c.json({ error: "Authentication required to view your datasets" }, 401);
    }
    query += " AND d.owner_user_id = ?";
    params.push(user.id);
  }

  query += " ORDER BY d.created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const datasets = await db.prepare(query).bind(...params).all();

  return c.json({
    datasets: datasets.results,
    count: datasets.results.length,
  });
});

/**
 * GET /datasets/:id - Get dataset details
 */
datasetRoutes.get("/:id", optionalAuthMiddleware, async (c) => {
  const datasetId = c.req.param("id");
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
  `
    )
    .bind(datasetId)
    .first();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
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
        return c.json({ error: "Only dataset owner or collaborators can request upload URLs" }, 403);
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
      userSecretAccessKey = await decrypt(userCreds.aws_secret_access_key_encrypted, c.env.ENCRYPTION_KEY);
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

    // Deploy GitHub Actions workflows
    try {
      const workflowResult = await deployWorkflows(datasetId, c.env.GITHUB_ADMIN_PAT);
      if (!workflowResult.success) {
        console.error("Failed to deploy some workflows:", workflowResult.errors);
      }
    } catch (error) {
      console.error("Failed to deploy workflows:", error);
      // Continue anyway; not a fatal error
    }

    // Apply branch protection (requires workflows to be deployed first for status checks)
    try {
      await applyBranchProtection(datasetId, c.env.GITHUB_ADMIN_PAT);
    } catch (error) {
      console.error("Failed to apply branch protection:", error);
      // Continue anyway; not a fatal error
    }

    // Enable auto-merge
    try {
      await enableAutoMerge(datasetId, c.env.GITHUB_ADMIN_PAT);
    } catch (error) {
      console.error("Failed to enable auto-merge:", error);
      // Continue anyway; not a fatal error
    }

    // Update dataset timestamp (status remains 'active' per schema constraint)
    await db
      .prepare("UPDATE datasets SET updated_at = CURRENT_TIMESTAMP WHERE dataset_id = ?")
      .bind(datasetId)
      .run();

    // Audit log
    await db
      .prepare(
        `
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
      VALUES (?, 'dataset_finalized', 'dataset', ?, ?)
    `
      )
      .bind(user.id, datasetId, JSON.stringify({ finalized: true }))
      .run();

    const githubUrl = `https://github.com/${dataset.github_repo}`;

    return c.json({
      message: "Dataset finalized successfully",
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
    .prepare("SELECT id, dataset_id, name, github_repo, owner_user_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ id: number; dataset_id: string; name: string; github_repo: string | null; owner_user_id: number }>();

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
        "INSERT INTO dataset_collaborators (dataset_id, user_id, access_type) VALUES (?, ?, 'requested')"
      )
      .bind(dataset.id, user.id)
      .run();

    // Audit log
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'dataset_access_granted', 'dataset', ?, ?)"
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
    .prepare("SELECT id, dataset_id, name, github_repo, owner_user_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ id: number; dataset_id: string; name: string; github_repo: string | null; owner_user_id: number }>();

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
        "INSERT INTO dataset_collaborators (dataset_id, user_id, granted_by, access_type) VALUES (?, ?, ?, 'invited')"
      )
      .bind(dataset.id, invitee.id, currentUser.id)
      .run();

    // Audit log
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'dataset_access_granted', 'dataset', ?, ?)"
      )
      .bind(currentUser.id, datasetId, JSON.stringify({ invitee: username, access_type: "invited" }))
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
       ORDER BY dc.granted_at DESC`
    )
    .bind(dataset.id)
    .all();

  return c.json({
    dataset_id: datasetId,
    collaborators: collaborators.results,
    count: collaborators.results.length,
  });
});
