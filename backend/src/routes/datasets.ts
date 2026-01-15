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
import { createRepository, addCollaborator, applyBranchProtection, enableAutoMerge } from "../services/github";
import { generateDatasetUploadUrls } from "../services/s3";

export const datasetRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
});

/**
 * POST /datasets - Create a new dataset
 *
 * Creates GitHub repo, assigns dataset ID, and returns presigned URLs for upload.
 */
datasetRoutes.post("/", authMiddleware, zValidator("json", createDatasetSchema), async (c) => {
  const { name, description, files } = c.req.valid("json");
  const user = c.get("user");
  const db = c.env.DB;

  // Generate dataset ID
  const datasetId = await generateDatasetId(db);

  // Create GitHub repository
  let githubRepo;
  try {
    githubRepo = await createRepository(
      datasetId,
      `${name} - NEMAR Dataset`,
      false, // Public for collaboration
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

  // Add all other approved users as collaborators
  try {
    const approvedUsers = await db
      .prepare("SELECT github_username FROM users WHERE status = 'approved' AND id != ?")
      .bind(user.id)
      .all<{ github_username: string }>();

    for (const u of approvedUsers.results) {
      await addCollaborator(datasetId, u.github_username, "push", c.env.GITHUB_ADMIN_PAT);
    }
  } catch (error) {
    console.error("Failed to add collaborators:", error);
  }

  // NOTE: Branch protection is applied in the finalize endpoint after initial upload
  // We don't apply it here because the repo needs content before protection can be set

  // Generate presigned URLs for data files
  let uploadUrls: Record<string, string> = {};
  if (files && files.length > 0) {
    const dataFiles = files.filter((f) => f.type === "data").map((f) => f.path);
    if (dataFiles.length > 0) {
      uploadUrls = await generateDatasetUploadUrls(
        {
          bucket: c.env.S3_BUCKET,
          region: c.env.AWS_REGION,
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        },
        datasetId,
        dataFiles
      );
    }
  }

  // Insert dataset record
  await db
    .prepare(
      `
    INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .bind(datasetId, name, description || null, user.id, githubRepo.full_name)
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

    // Verify dataset exists and user is owner
    const dataset = await db
      .prepare("SELECT owner_user_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ owner_user_id: number }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== user.id && !user.is_admin) {
      return c.json({ error: "Only dataset owner can request upload URLs" }, 403);
    }

    const uploadUrls = await generateDatasetUploadUrls(
      {
        bucket: c.env.S3_BUCKET,
        region: c.env.AWS_REGION,
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      },
      datasetId,
      files
    );

    return c.json({ upload_urls: uploadUrls });
  }
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

  if (dataset.status === "published") {
    return c.json({ error: "Dataset is already published" }, 400);
  }

  // Apply branch protection
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

  // Update dataset status
  await db
    .prepare("UPDATE datasets SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE dataset_id = ?")
    .bind(datasetId)
    .run();

  // Audit log
  await db
    .prepare(
      `
    INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
    VALUES (?, 'dataset_published', 'dataset', ?, ?)
  `
    )
    .bind(user.id, datasetId, JSON.stringify({ status: "published" }))
    .run();

  const githubUrl = `https://github.com/${dataset.github_repo}`;

  return c.json({
    message: "Dataset published successfully",
    dataset: {
      dataset_id: datasetId,
      status: "published",
      github_url: githubUrl,
    },
  });
});
