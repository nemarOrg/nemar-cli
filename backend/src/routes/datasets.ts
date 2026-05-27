/**
 * Dataset routes
 *
 * Handles dataset creation, listing, and metadata.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth";
import { cliVersionGuard } from "../middleware/cliVersion";
import { type SearchResult, semanticSearch, textSearch } from "../services/dataset-search";
import { generateDatasetId, isValidDatasetId } from "../services/datasetId";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendPublicationRequestEmail,
} from "../services/email";
import {
  type GitHubRepo,
  addCollaborator,
  applyBranchProtection,
  checkWorkflowExists,
  createRepository,
  deployWorkflows,
  enableAutoMerge,
  ensureMainBranch,
  ensureWorkflowsDeployed,
  getFileContent,
  getWorkflowRuns,
  setRepoVisibility,
} from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import {
  addPublicReadPolicy,
  generateDatasetUploadUrls,
  getManifest,
  listManifests,
  removePublicReadPolicy,
} from "../services/s3";
import { generateDownloadPolicy, generateUploadPolicy, getFederationToken } from "../services/sts";
import { type Bindings, type Variables, hasRole } from "../types/bindings";

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

// User-facing messages for each publication block reason
const BLOCK_MESSAGES: Record<string, string> = {
  bids_validation_failed:
    "BIDS validation is failing on your dataset. Please check the repository CI and fix validation errors, then re-request publication.",
  bids_validation_pending:
    "BIDS validation has not run yet. Please wait for CI to complete, then re-request publication.",
  bids_validation_in_progress:
    "BIDS validation is currently running. Please wait for it to complete, then re-request publication.",
};

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
        // Claim the ID early with a minimal INSERT to close the TOCTOU gap
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
 * GET /datasets - List datasets (unified catalog)
 *
 * Merges managed datasets (D1) with the nemar.org catalog for a complete listing.
 * Managed datasets take precedence for deduplication (LEFT JOIN on nemar_catalog).
 *
 * Visibility rules:
 * - --mine flag: show only the authenticated user's managed datasets (private + public + sandbox)
 * - No --mine flag (public catalog): merge managed + catalog-only datasets
 *   - Sandbox datasets are ALWAYS excluded
 *   - Unauthenticated: public datasets only
 *   - Authenticated non-admin: public datasets only
 *   - Admin: all datasets (including private managed datasets)
 *
 * Filter params: modality, author, task, has_doi, recent, sort, search, owner
 * Pagination: limit (1-200, default 50), offset (>= 0, default 0)
 * Response includes total_count, limit, offset for client-side pagination
 */
datasetRoutes.get("/", optionalAuthMiddleware, async (c) => {
  const mine = c.req.query("mine") === "true";
  const status = c.req.query("status") || "active";
  const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 200);
  const rawOffset = Number.parseInt(c.req.query("offset") ?? "", 10);
  const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0);
  const owner = c.req.query("owner");
  const user = c.get("user");
  const db = c.env.DB;

  // Filter params
  const search = c.req.query("search");
  const modality = c.req.query("modality");
  const author = c.req.query("author");
  const task = c.req.query("task");
  const hasDoi = c.req.query("has_doi") === "true";
  const recentParam = c.req.query("recent");
  const recent = recentParam ? Number.parseInt(recentParam, 10) : undefined;
  const sort = c.req.query("sort") || "newest";

  if (mine) {
    // --mine: only managed datasets, no catalog
    if (!user) {
      // Distinguish "no auth header sent" from "auth header sent but token
      // invalid/expired/revoked". The latter is what trips CLI users who
      // `nemar auth login` succeeded weeks ago and then had their token
      // revoked or the backend rotated — `isAuthenticated()` is presence-only
      // so the CLI happily fires the request and the user sees a vague
      // "Authentication required" with no hint to re-login.
      // See nemarOrg/nemar-cli#447.
      const attempted = c.get("authAttempted");
      if (attempted) {
        return c.json(
          {
            error:
              "Your API key was rejected. Run 'nemar auth login' to re-authenticate, or 'nemar auth regenerate-key' if your key was revoked.",
          },
          401,
        );
      }
      return c.json({ error: "Authentication required to view your datasets" }, 401);
    }

    let query = `
      SELECT d.dataset_id, d.name, d.description, d.status, d.visibility,
             d.github_repo, d.concept_doi, d.created_at, d.updated_at,
             u.username AS owner_username, d.nemar_sync_status,
             d.source, d.source_id,
             COALESCE(c.modalities, '') AS modalities,
             COALESCE(c.participants, 0) AS participants,
             COALESCE(c.tasks, '') AS tasks,
             COALESCE(c.authors, '') AS authors,
             COALESCE(c.file_size, 0) AS file_size,
             COALESCE(c.file_size_formatted, '') AS file_size_formatted,
             'managed' AS source_type,
             -- latest_version: most recently minted DOI version for the dataset
             -- (null when none). scripts/hallu-sync.sh reads this to skip the
             -- per-dataset /manifest call; keep the ordering in sync with what
             -- /datasets/:id/manifest reports.
             (
               SELECT version FROM dataset_versions dv
               WHERE dv.dataset_id = d.dataset_id
               ORDER BY created_at DESC
               LIMIT 1
             ) AS latest_version
      FROM datasets d
      JOIN users u ON d.owner_user_id = u.id
      LEFT JOIN nemar_catalog c ON c.id = d.dataset_id
      WHERE d.status = ? AND d.owner_user_id = ?
    `;
    const params: (string | number)[] = [status, user.id];

    query += buildFilterClauses(params, {
      search,
      modality,
      author,
      task,
      hasDoi,
      recent,
      managed: true,
    });
    query += buildSortClause(sort);

    // Authed --mine path: response carries the caller's private datasets,
    // never share at the edge. See #639 + the public-path comment below.
    c.header("Cache-Control", "private, no-store");
    return executeAndReturn(c, db, query, params, { limit, offset });
  }

  // Public catalog: UNION managed datasets + catalog-only
  const managedParams: (string | number)[] = [status];
  let managedQuery = `
    SELECT d.dataset_id, d.dataset_id AS id, d.name, d.description, d.status, d.visibility,
           d.github_repo, d.concept_doi, d.concept_doi AS doi, d.created_at, d.updated_at,
           u.username AS owner_username, d.nemar_sync_status,
           d.source, d.source_id,
           COALESCE(c.modalities, '') AS modalities,
           COALESCE(c.participants, 0) AS participants,
           COALESCE(c.tasks, '') AS tasks,
           COALESCE(c.authors, '') AS authors,
           COALESCE(c.file_size, 0) AS file_size,
           COALESCE(c.file_size_formatted, '') AS file_size_formatted,
           'managed' AS source_type,
           -- latest_version: same contract as the managed-mine branch above.
           (
             SELECT version FROM dataset_versions dv
             WHERE dv.dataset_id = d.dataset_id
             ORDER BY created_at DESC
             LIMIT 1
           ) AS latest_version
    FROM datasets d
    JOIN users u ON d.owner_user_id = u.id
    LEFT JOIN nemar_catalog c ON c.id = d.dataset_id
    WHERE d.status = ?
      AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
  `;

  // Visibility filter for managed datasets
  if (!user) {
    managedQuery += " AND d.visibility = 'public'";
  } else if (!hasRole(user.role, "admin")) {
    managedQuery += " AND d.visibility = 'public'";
  }

  // Owner filter for managed datasets
  if (owner) {
    managedQuery += " AND u.username = ?";
    managedParams.push(owner);
  }

  managedQuery += buildFilterClauses(managedParams, {
    search,
    modality,
    author,
    task,
    hasDoi,
    recent,
    managed: true,
  });

  // Catalog-only datasets (not in managed datasets table)
  const catalogParams: (string | number)[] = [];
  let catalogQuery = `
    SELECT c.id AS dataset_id, c.id, c.name, c.description, NULL AS status, 'public' AS visibility,
           NULL AS github_repo, NULL AS concept_doi, c.doi, COALESCE(c.publish_date, c.created_date) AS created_at, NULL AS updated_at,
           c.uploader AS owner_username, NULL AS nemar_sync_status,
           NULL AS source, NULL AS source_id,
           COALESCE(c.modalities, '') AS modalities,
           COALESCE(c.participants, 0) AS participants,
           COALESCE(c.tasks, '') AS tasks,
           COALESCE(c.authors, '') AS authors,
           COALESCE(c.file_size, 0) AS file_size,
           COALESCE(c.file_size_formatted, '') AS file_size_formatted,
           'catalog' AS source_type,
           NULL AS latest_version
    FROM nemar_catalog c
    WHERE c.id NOT IN (SELECT dataset_id FROM datasets WHERE status = 'active')
      AND c.id NOT IN (
        -- Hide ds* shadows when a managed on* mirror exists. The catalog row
        -- keeps its OpenNeuro id (c.id = "ds002718"); the managed mirror
        -- carries the canonical id (dataset_id = "on002718") and back-points
        -- via source_id = "ds002718". Without this second NOT IN, every
        -- mirrored ds row shows up twice in the list (once as canonical,
        -- once as shadow).
        SELECT source_id FROM datasets
        WHERE status = 'active' AND source = 'openneuro' AND source_id IS NOT NULL
      )
  `;

  // Owner filter for catalog datasets
  if (owner) {
    catalogQuery += " AND c.uploader = ?";
    catalogParams.push(owner);
  }

  catalogQuery += buildFilterClauses(catalogParams, {
    search,
    modality,
    author,
    task,
    hasDoi,
    recent,
    managed: false,
  });

  // Combine with UNION ALL
  const unionQuery = `${managedQuery} UNION ALL ${catalogQuery}${buildSortClause(sort, true)}`;
  const allParams = [...managedParams, ...catalogParams];

  // CF edge cache: anonymous list responses are identical for all callers
  // (no private rows leak — the SQL already filters visibility), so share
  // them at the edge. Authed callers may have additional visibility into
  // private rows their owner / collaborator / admin status grants, so
  // their responses stay private + no-store. Without this header every
  // SSR call from the website's Worker pool hits origin + decrements the
  // per-IP rate-limit bucket; a handful of concurrent visitors of ww2 then
  // trips the cap (#639). Catalog mutations are rare, so s-maxage of 5 min
  // + SWR is plenty fresh.
  if (user) {
    c.header("Cache-Control", "private, no-store");
  } else {
    c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
  }
  return executeAndReturn(c, db, unionQuery, allParams, { limit, offset });
});

// Escape SQLite LIKE wildcards in user input so a literal '%' or '_' in the
// search term means itself rather than "match everything" / "match any
// character". Paired with `ESCAPE '\\'` on every LIKE predicate that uses
// these patterns. Exported for unit testing.
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, "\\$&");
}

/** Build WHERE clauses for search/filter params */
export function buildFilterClauses(
  params: (string | number)[],
  opts: {
    search?: string;
    modality?: string;
    author?: string;
    task?: string;
    hasDoi?: boolean;
    recent?: number;
    managed: boolean;
  },
): string {
  let clauses = "";

  if (opts.search) {
    // Dataset ids (and the OpenNeuro source_id for mirrored rows) must be
    // searchable directly. nemar_catalog.search_text was not consistently
    // populated with the id across the corpus (nm000103 had it, nm000166
    // did not), so relying on search_text alone produced 0 results for
    // any catalog row whose enrichment missed the id.
    const pattern = `%${escapeLikePattern(opts.search.toLowerCase())}%`;
    if (opts.managed) {
      clauses +=
        " AND (LOWER(d.dataset_id) LIKE ? ESCAPE '\\'" +
        " OR LOWER(COALESCE(d.source_id, '')) LIKE ? ESCAPE '\\'" +
        " OR LOWER(d.name) LIKE ? ESCAPE '\\'" +
        " OR LOWER(d.description) LIKE ? ESCAPE '\\'" +
        " OR LOWER(COALESCE(c.search_text, '')) LIKE ? ESCAPE '\\')";
      params.push(pattern, pattern, pattern, pattern, pattern);
    } else {
      clauses += " AND (LOWER(c.id) LIKE ? ESCAPE '\\' OR LOWER(c.search_text) LIKE ? ESCAPE '\\')";
      params.push(pattern, pattern);
    }
  }

  if (opts.modality) {
    if (opts.managed) {
      clauses += " AND LOWER(COALESCE(c.modalities, '')) LIKE ?";
    } else {
      clauses += " AND LOWER(c.modalities) LIKE ?";
    }
    params.push(`%${opts.modality.toLowerCase()}%`);
  }

  if (opts.author) {
    if (opts.managed) {
      clauses += " AND LOWER(COALESCE(c.authors, '')) LIKE ?";
    } else {
      clauses += " AND LOWER(c.authors) LIKE ?";
    }
    params.push(`%${opts.author.toLowerCase()}%`);
  }

  if (opts.task) {
    if (opts.managed) {
      clauses += " AND LOWER(COALESCE(c.tasks, '')) LIKE ?";
    } else {
      clauses += " AND LOWER(c.tasks) LIKE ?";
    }
    params.push(`%${opts.task.toLowerCase()}%`);
  }

  if (opts.hasDoi) {
    if (opts.managed) {
      clauses += " AND (d.concept_doi IS NOT NULL AND d.concept_doi != '')";
    } else {
      clauses += " AND (c.doi IS NOT NULL AND c.doi != '')";
    }
  }

  if (opts.recent) {
    if (opts.managed) {
      clauses += " AND d.created_at > datetime('now', ?)";
    } else {
      clauses += " AND c.publish_date > datetime('now', ?)";
    }
    params.push(`-${opts.recent} days`);
  }

  return clauses;
}

function buildSortClause(sort: string, forUnion = false): string {
  // For JOIN queries, qualify with table alias to avoid ambiguity.
  // For UNION queries, use the output column name (no prefix).
  const dateCol = forUnion ? "created_at" : "d.created_at";
  const nameCol = forUnion ? "name" : "d.name";
  switch (sort) {
    case "oldest":
      return ` ORDER BY ${dateCol} ASC`;
    case "name":
      return ` ORDER BY ${nameCol} ASC`;
    case "participants":
      return " ORDER BY participants DESC";
    case "size":
      return " ORDER BY file_size DESC";
    default:
      return ` ORDER BY ${dateCol} DESC`;
  }
}

async function executeAndReturn(
  c: { json: (data: unknown, status?: number) => Response },
  db: D1Database,
  baseQuery: string,
  baseParams: (string | number)[],
  pagination: { limit: number; offset: number },
) {
  const { limit, offset } = pagination;
  try {
    const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;
    const countQuery = `SELECT COUNT(*) AS total FROM (${baseQuery})`;

    // Run main query and count in parallel; use allSettled so a count
    // failure does not prevent returning the main results.
    const [mainSettled, countSettled] = await Promise.allSettled([
      db
        .prepare(paginatedQuery)
        .bind(...baseParams, limit, offset)
        .all(),
      db
        .prepare(countQuery)
        .bind(...baseParams)
        .first<{ total: number }>(),
    ]);

    if (mainSettled.status === "rejected") {
      throw mainSettled.reason;
    }

    const result = mainSettled.value;
    if (!result?.results) {
      return c.json({ error: "Database query failed" }, 500);
    }

    let totalCount = result.results.length;
    if (countSettled.status === "fulfilled" && countSettled.value?.total != null) {
      totalCount = countSettled.value.total;
    } else if (countSettled.status === "rejected") {
      console.warn(
        "[datasets] COUNT query failed, using result length:",
        countSettled.reason instanceof Error
          ? countSettled.reason.message
          : String(countSettled.reason),
      );
    }

    return c.json({
      datasets: result.results,
      count: result.results.length,
      total_count: totalCount,
      limit,
      offset,
    });
  } catch (dbError) {
    const msg = dbError instanceof Error ? dbError.message : String(dbError);

    // Graceful fallback: if nemar_catalog table doesn't exist yet (migration
    // 0018 not applied), fall back to the basic datasets-only query.
    if (msg.includes("no such table: nemar_catalog")) {
      console.warn("[datasets] nemar_catalog table not found, falling back to basic query");
      try {
        const fallback = await db
          .prepare(
            `SELECT d.dataset_id, d.name, d.description, d.status, d.visibility,
                    d.github_repo, d.concept_doi, d.created_at, d.updated_at,
                    u.username AS owner_username,
                    -- API contract: every list entry exposes latest_version
                    -- (null when no minted DOI version yet) so callers
                    -- (e.g. scripts/hallu-sync.sh) can rely on its presence
                    -- without falling back to per-dataset /manifest calls.
                    (
                      SELECT version FROM dataset_versions dv
                      WHERE dv.dataset_id = d.dataset_id
                      ORDER BY created_at DESC
                      LIMIT 1
                    ) AS latest_version
             FROM datasets d
             JOIN users u ON d.owner_user_id = u.id
             WHERE d.status = 'active' AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
               AND d.visibility = 'public'
             ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
          )
          .bind(limit, offset)
          .all();
        return c.json({
          datasets: fallback.results || [],
          count: fallback.results?.length || 0,
          total_count: fallback.results?.length || 0,
          limit,
          offset,
          fallback: true,
          warning: "Catalog not available; filters and catalog datasets not included",
        });
      } catch (fallbackErr) {
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return c.json({ error: "Failed to retrieve datasets", details: fallbackMsg }, 500);
      }
    }

    console.error("Failed to query datasets:", msg);
    return c.json({ error: "Failed to retrieve datasets", details: msg }, 500);
  }
}

/**
 * GET /datasets/search - Semantic dataset search
 *
 * Combines three strategies:
 *  - Exact dataset-ID lookup (nm###### / ds######) via D1, since embeddings
 *    cannot meaningfully match literal IDs.
 *  - Vectorize semantic similarity (when bindings are configured).
 *  - D1 LIKE text search as a fallback, also used to backfill semantic
 *    results when Vectorize returns no hits.
 *
 * Semantic and text hits are merged on `id`; semantic ranking is preserved
 * and text-only hits are appended.
 */
datasetRoutes.get("/search", optionalAuthMiddleware, async (c) => {
  const query = c.req.query("q");
  if (!query) {
    return c.json({ error: "Search query parameter 'q' is required" }, 400);
  }

  const limit = Math.min(Number.parseInt(c.req.query("limit") || "20", 10), 100);
  const modality = c.req.query("modality");
  const db = c.env.DB;
  const trimmed = query.trim();
  const exactIdMatch = /^(nm|ds)\d{6}$/i.test(trimmed);

  // Relevance floor for semantic results. bge-small cosine scores under
  // ~0.65 against this catalog tend to be topic-adjacent noise rather
  // than real matches (e.g. any EEG dataset coming back for "sleep eeg").
  // Override per-request with ?min_score=0 to inspect the long tail.
  const DEFAULT_MIN_SCORE = 0.65;
  const minScoreParam = c.req.query("min_score");
  const parsedMinScore =
    minScoreParam === undefined ? Number.NaN : Number.parseFloat(minScoreParam);
  const minScore = Number.isFinite(parsedMinScore)
    ? Math.max(0, Math.min(parsedMinScore, 1))
    : DEFAULT_MIN_SCORE;

  const applyModality = (rows: SearchResult[]): SearchResult[] => {
    if (!modality) return rows;
    const mod = modality.toLowerCase();
    return rows.filter((r) => r.modalities.toLowerCase().includes(mod));
  };

  // textSearch hits have score=1.0 (no embedding ranking), so the score
  // floor only filters semantic results in practice.
  const applyMinScore = (rows: SearchResult[]): SearchResult[] =>
    minScore <= 0 ? rows : rows.filter((r) => r.score >= minScore);

  const respond = (rows: SearchResult[], method: string) => {
    const filtered = applyModality(applyMinScore(rows));
    return c.json({
      results: filtered.slice(0, limit),
      count: filtered.length,
      method,
      min_score: minScore,
    });
  };

  try {
    // Exact dataset-ID hits skip the embedding step entirely. Embeddings
    // can't match literal IDs, so we always try this first.
    if (exactIdMatch) {
      const idHit = await textSearch(db, trimmed, 1);
      if (idHit.length > 0) {
        return respond(idHit, "exact_id");
      }
    }

    const hasVectorize = Boolean(c.env.AI && c.env.VECTORIZE);
    if (!hasVectorize) {
      console.warn("[search] AI or VECTORIZE binding not available, using text search");
      const rows = await textSearch(db, trimmed, limit * 2);
      return respond(rows, "text");
    }

    const semantic = await semanticSearch(c.env.AI!, c.env.VECTORIZE!, trimmed, limit * 2);

    // Vectorize can return zero hits when the index is empty or when the
    // query has no semantic signal (e.g. a literal ID). In those cases the
    // D1 LIKE search still finds real matches against the catalog.
    if (semantic.length === 0) {
      const rows = await textSearch(db, trimmed, limit * 2);
      return respond(rows, "text_fallback");
    }

    // Merge in text matches the semantic search missed, preserving the
    // ranked semantic order at the head of the list.
    const textRows = await textSearch(db, trimmed, limit * 2);
    if (textRows.length > 0) {
      const seen = new Set(semantic.map((r) => r.id));
      for (const row of textRows) {
        if (!seen.has(row.id)) {
          semantic.push(row);
          seen.add(row.id);
        }
      }
    }

    return respond(semantic, "semantic");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Dataset search failed:", msg);

    // Last-ditch fall back to text search on any unexpected failure.
    try {
      const rows = await textSearch(db, trimmed, limit);
      return respond(rows, "text_fallback");
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      if (fallbackMsg.includes("no such table")) {
        return c.json({ results: [], count: 0, method: "unavailable" });
      }
      return c.json({ error: "Search failed", details: msg }, 500);
    }
  }
});

/**
 * GET /datasets/resolve/:sourceId - Resolve an OpenNeuro source ID to its NEMAR counterpart
 *
 * Returns the NEMAR dataset_id if a dataset was imported from the given source_id.
 * Used by the CLI to redirect ds###### downloads to the NEMAR backend when available.
 * Returns { found: true, ... } on match, or { found: false } when no match exists.
 * Always returns 200 (except on validation or server errors).
 */
datasetRoutes.get("/resolve/:sourceId", optionalAuthMiddleware, async (c) => {
  const sourceId = c.req.param("sourceId");

  if (!/^ds\d{6}$/.test(sourceId)) {
    return c.json({ error: "Invalid source ID format. Expected ds followed by 6 digits." }, 400);
  }

  const db = c.env.DB;

  try {
    const match = await db
      .prepare(
        `SELECT d.dataset_id, d.name, d.github_repo, u.username as owner_username
         FROM datasets d
         JOIN users u ON d.owner_user_id = u.id
         WHERE d.source_id = ? AND d.status = 'active' AND d.visibility = 'public'
         LIMIT 1`,
      )
      .bind(sourceId)
      .first<{
        dataset_id: string;
        name: string;
        github_repo: string | null;
        owner_username: string;
      }>();

    // CF edge cache: the query is restricted to `visibility = 'public'`
    // and `status = 'active'`, so the response is identical for any
    // caller regardless of auth — safe to share at the edge. The
    // canonical-resolve mapping changes only when a dataset is
    // re-published, which is rare; s-maxage of 5 min + SWR is plenty.
    // Issue #639.
    c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
    if (!match) {
      return c.json({ found: false });
    }

    return c.json({
      found: true,
      dataset_id: match.dataset_id,
      name: match.name,
      github_repo: match.github_repo,
      owner_username: match.owner_username,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[resolve] Failed to resolve source_id ${sourceId}:`, msg);
    return c.json({ error: "Failed to resolve dataset", details: msg }, 500);
  }
});

/**
 * GET /datasets/:id - Get dataset details
 *
 * Visibility rules:
 * - Public datasets: accessible to everyone
 * - Private datasets: accessible to owner, admin, or collaborator
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
    if (!user || (!hasRole(user.role, "admin") && user.id !== dataset.owner_user_id)) {
      // Check if user is a collaborator before returning 404
      const isCollaborator = user
        ? await db
            .prepare(
              "SELECT 1 FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE d.dataset_id = ? AND dc.user_id = ?",
            )
            .bind(datasetId, user.id)
            .first()
        : null;
      if (!isCollaborator) {
        // If the caller sent a Bearer token that was rejected, give a
        // re-login hint instead of "Dataset not found" — same bug class
        // as nemarOrg/nemar-cli#447 but for the single-dataset route.
        if (!user && c.get("authAttempted")) {
          return c.json(
            {
              error:
                "Your API key was rejected. Run 'nemar auth login' to re-authenticate, or 'nemar auth regenerate-key' if your key was revoked.",
            },
            401,
          );
        }
        return c.json({ error: "Dataset not found" }, 404);
      }
    }
  }

  // CF edge cache only for anonymous traffic. Authed responses may include
  // private-dataset rows scoped to the caller's permissions — must stay
  // private + no-store so the edge doesn't share one user's view with
  // another. See the list handler at line ~431 for the same pattern + the
  // rationale (#639: Worker-egress IP pooling on the website SSR path).
  if (user) {
    c.header("Cache-Control", "private, no-store");
  } else {
    c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
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

    if (dataset.owner_user_id !== user.id && !hasRole(user.role, "admin")) {
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
      const isCollaborator = await db
        .prepare(
          "SELECT 1 FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE d.dataset_id = ? AND dc.user_id = ?",
        )
        .bind(datasetId, user.id)
        .first();

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
      const isCollaborator = await db
        .prepare(
          "SELECT 1 FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE d.dataset_id = ? AND dc.user_id = ?",
        )
        .bind(datasetId, user.id)
        .first();

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

    // Apply branch protection (requires workflows to be deployed first for status checks)
    try {
      await applyBranchProtection(datasetId, pat);
    } catch (error) {
      console.error("Failed to apply branch protection:", error);
      warnings.push(
        "Branch protection could not be applied; direct pushes to main may be possible",
      );
    }

    // Enable auto-merge
    try {
      await enableAutoMerge(datasetId, pat);
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
    await addCollaborator(repoName, user.github_username, "push", await getDatasetsToken(c.env));
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
  } catch (dbError) {
    // GitHub succeeded but DB failed -- log but continue to S3 permission
    console.error("Failed to record collaborator in database:", dbError);
  }

  // S3 permission is critical: sole authorization source for uploads.
  // Must not be swallowed in a shared catch block.
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO user_s3_permissions (user_id, s3_prefix, permission, granted_by) VALUES (?, ?, 'read_write', ?)",
      )
      .bind(user.id, datasetId, user.id)
      .run();
  } catch (s3Error) {
    console.error("CRITICAL: Failed to grant S3 permission for", datasetId, s3Error);
    return c.json(
      {
        error: "Failed to configure S3 upload permission",
        message:
          "GitHub access was granted but S3 upload permission could not be set. Contact an administrator.",
        dataset_id: datasetId,
      },
      500,
    );
  }

  // Audit log (non-critical)
  try {
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'dataset_access_granted', 'dataset', ?, ?)",
      )
      .bind(user.id, datasetId, JSON.stringify({ access_type: "requested" }))
      .run();
  } catch (logError) {
    console.error("Failed to write audit log:", logError);
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
  if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
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
    await addCollaborator(repoName, invitee.github_username, "push", await getDatasetsToken(c.env));
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
  } catch (dbError) {
    // GitHub succeeded but DB failed -- log but continue to S3 permission
    console.error("Failed to record collaborator in database:", dbError);
  }

  // S3 permission is critical: sole authorization source for uploads.
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO user_s3_permissions (user_id, s3_prefix, permission, granted_by) VALUES (?, ?, 'read_write', ?)",
      )
      .bind(invitee.id, datasetId, currentUser.id)
      .run();
  } catch (s3Error) {
    console.error("CRITICAL: Failed to grant S3 permission for", datasetId, s3Error);
    return c.json(
      {
        error: "Failed to configure S3 upload permission",
        message:
          "GitHub access was granted but S3 upload permission could not be set. Contact an administrator.",
        dataset_id: datasetId,
      },
      500,
    );
  }

  // Audit log (non-critical)
  try {
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
  } catch (logError) {
    console.error("Failed to write audit log:", logError);
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
  if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
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
    .prepare(
      "SELECT id, dataset_id, owner_user_id, is_sandbox, github_repo, visibility FROM datasets WHERE dataset_id = ?",
    )
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      owner_user_id: number;
      is_sandbox: number | null;
      github_repo: string | null;
      visibility: string | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
    return c.json({ error: "Only the dataset owner can request publication" }, 403);
  }

  if (dataset.is_sandbox || dataset.dataset_id.startsWith("xx")) {
    return c.json({ error: "Cannot publish sandbox datasets" }, 400);
  }

  if (dataset.visibility === "public") {
    return c.json({ error: "Dataset is already published" }, 409);
  }

  // Check for existing active request (allow re-checking blocked requests)
  const existing = await db
    .prepare(
      "SELECT id, status, block_reason FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked') ORDER BY requested_at DESC LIMIT 1",
    )
    .bind(datasetId)
    .first<{ id: number; status: string; block_reason: string | null }>();

  if (existing && existing.status !== "blocked") {
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

  // For blocked requests, re-run readiness checks instead of creating a new one
  const requestId = existing?.id;

  // Run readiness checks: deploy CI if missing, check BIDS validation
  const repoName = dataset.github_repo?.split("/")[1];
  let blocked = false;
  let blockReason: string | null = null;
  const ciUrl = repoName ? `https://github.com/nemarDatasets/${repoName}/actions` : undefined;

  // Resolve auth inside the try so a missing or unconfigured token blocks
  // the request the same way other CI infrastructure failures do, rather
  // than 500-ing the request before we've even recorded a row.
  let pat: string | null = null;
  if (repoName) {
    try {
      pat = await getDatasetsToken(c.env);
      // Deploy CI workflows if missing
      const hasWorkflow = await checkWorkflowExists(
        repoName,
        ".github/workflows/bids-validation.yml",
        pat,
      );
      if (!hasWorkflow) {
        const deployResult = await deployWorkflows(repoName, pat);
        if (!deployResult.success) {
          throw new Error(
            `Failed to deploy CI workflows to ${repoName}: ${deployResult.errors.join("; ")}`,
          );
        }
      }

      // Check latest BIDS validation run
      const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
      if (runs.length === 0) {
        blocked = true;
        blockReason = "bids_validation_pending";
      } else if (runs[0].conclusion === "failure") {
        blocked = true;
        blockReason = "bids_validation_failed";
      } else if (runs[0].conclusion === null) {
        blocked = true;
        blockReason = "bids_validation_in_progress";
      }
    } catch (err) {
      // CI infrastructure failure (GitHub API outage, PAT expired, auth
      // misconfig, etc.). Block the request so it can be retried rather
      // than bypassing validation.
      console.error(
        `[publish-request] CI readiness check failed for ${datasetId}:`,
        err instanceof Error ? err.message : err,
      );
      blocked = true;
      blockReason = "bids_validation_pending";
    }
  } else {
    console.warn(`[publish-request] Skipping CI checks for ${datasetId}: no GitHub repo`);
  }

  if (requestId) {
    // Update existing blocked request
    if (blocked) {
      await db
        .prepare(
          "UPDATE publication_requests SET status = 'blocked', block_reason = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(blockReason, requestId)
        .run();
    } else {
      // Unblock: transition to requested
      await db
        .prepare(
          "UPDATE publication_requests SET status = 'requested', block_reason = NULL, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(requestId)
        .run();
    }
  } else {
    // Create new publication request
    await db
      .prepare(
        "INSERT INTO publication_requests (dataset_id, requested_by, status, block_reason) VALUES (?, ?, ?, ?)",
      )
      .bind(datasetId, currentUser.id, blocked ? "blocked" : "requested", blockReason)
      .run();
  }

  if (blocked) {
    return c.json(
      {
        status: "blocked",
        block_reason: blockReason,
        message: BLOCK_MESSAGES[blockReason || ""] || "Publication request blocked.",
        dataset_id: datasetId,
        ci_url: ciUrl,
      },
      422,
    );
  }

  // Notify admins who have publication_request notifications enabled
  try {
    const adminEmails = await getAdminEmailsForCategory(db, "publication_request");
    if (adminEmails.length > 0) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendPublicationRequestEmail(
        adminEmails,
        datasetId,
        currentUser.username,
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
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

  if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
    return c.json({ error: "Only the dataset owner or admin can view publication status" }, 403);
  }

  const request = await db
    .prepare(
      `SELECT pr.*, u.username as requested_by_username, d.github_repo
       FROM publication_requests pr
       JOIN users u ON pr.requested_by = u.id
       JOIN datasets d ON pr.dataset_id = d.dataset_id
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
      block_reason: string | null;
      steps_completed: string;
      current_step: string | null;
      last_error: string | null;
      updated_at: string;
      github_repo: string | null;
    }>();

  if (!request) {
    return c.json({
      dataset_id: datasetId,
      status: "none",
      message: "No publication request found",
    });
  }

  const repoName = request.github_repo?.split("/")[1];

  return c.json({
    dataset_id: datasetId,
    status: request.status,
    requested_at: request.requested_at,
    requested_by: request.requested_by_username,
    approved_at: request.approved_at,
    denied_at: request.denied_at,
    denied_reason: request.denied_reason,
    block_reason: request.block_reason,
    ...(request.status === "blocked" && repoName
      ? {
          message: BLOCK_MESSAGES[request.block_reason || ""] || "Publication request blocked.",
          ci_url: `https://github.com/nemarDatasets/${repoName}/actions`,
        }
      : {}),
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

  if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
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

  // Resend notification to admins who have publication_request notifications enabled
  try {
    const adminEmails = await getAdminEmailsForCategory(db, "publication_request");
    if (adminEmails.length > 0) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendPublicationRequestEmail(
        adminEmails,
        datasetId,
        currentUser.username,
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
      );
    }
  } catch (emailError) {
    console.error("Failed to resend publication notification:", emailError);
    return c.json(
      {
        error: "Failed to resend notification email",
        message:
          "The notification could not be sent. Please try again later or contact an administrator directly.",
      },
      500,
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
  if (dataset.owner_username !== currentUser.username && !hasRole(currentUser.role, "admin")) {
    return c.json({ error: "Access denied" }, 403);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = extractRepoName(dataset.github_repo);
  if (!repoName) {
    return c.json({ error: "Invalid repository format" }, 500);
  }

  const pat = await getDatasetsToken(c.env);

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
    if (!user || (!hasRole(user.role, "admin") && user.id !== dataset.owner_user_id)) {
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
    if (!user || (!hasRole(user.role, "admin") && user.id !== dataset.owner_user_id)) {
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

/**
 * GET /datasets/:id/versions - Get version history for a dataset
 *
 * Returns the current version from dataset_description.json and all
 * recorded version DOIs from the dataset_versions table.
 *
 * Authorization: Owner, collaborator, or admin
 */
datasetRoutes.get("/:id/versions", authMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  const dataset = await db
    .prepare("SELECT id, dataset_id, owner_user_id, github_repo FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      owner_user_id: number;
      github_repo: string | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Check access: owner, admin, or collaborator
  if (!hasRole(user.role, "admin") && user.id !== dataset.owner_user_id) {
    const collabResult = await db
      .prepare("SELECT 1 FROM dataset_collaborators WHERE dataset_id = ? AND user_id = ?")
      .bind(dataset.id, user.id)
      .first();
    if (!collabResult) {
      return c.json({ error: "Access denied" }, 403);
    }
  }

  // Get current version from dataset_description.json via GitHub
  let currentVersion = "1.0.0";
  if (dataset.github_repo) {
    const repoName = extractRepoName(dataset.github_repo);
    if (repoName) {
      try {
        const content = await getFileContent(
          repoName,
          "dataset_description.json",
          await getDatasetsToken(c.env),
        );
        if (content) {
          const desc = JSON.parse(content);
          if (typeof desc.Version === "string") {
            currentVersion = desc.Version;
          }
        }
      } catch (err) {
        console.error(`[versions] Failed to read version for ${datasetId}:`, err);
      }
    }
  }

  // Get version DOIs from database
  const versions = await db
    .prepare(
      "SELECT version, doi, provider, created_at FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
    )
    .bind(datasetId)
    .all<{ version: string; doi: string; provider: string; created_at: string }>();

  return c.json({
    dataset_id: datasetId,
    current_version: currentVersion,
    versions: versions.results ?? [],
  });
});

/**
 * POST /datasets/:id/publish - Publish a dataset (make public)
 *
 * Authorization: Owner or admin only
 * One-way operation: Cannot unpublish
 *
 * Effects:
 * 1. Changes GitHub repo from private to public
 * 2. Updates S3 bucket policy for public read
 * 3. Sets visibility='public' in database
 * 4. Logs action in audit_log
 */
datasetRoutes.post("/:id/publish", authMiddleware, async (c) => {
  const datasetId = c.req.param("id");
  const user = c.get("user");
  const db = c.env.DB;

  // Validate dataset ID format
  if (!isValidDatasetId(datasetId)) {
    return c.json({ error: "Invalid dataset ID" }, 400);
  }

  // Fetch dataset with ownership check
  const dataset = await db
    .prepare(`
      SELECT id, dataset_id, name, owner_user_id, github_repo, visibility, is_sandbox
      FROM datasets
      WHERE dataset_id = ? AND status = 'active'
    `)
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      owner_user_id: number;
      github_repo: string | null;
      visibility: string;
      is_sandbox: number;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Authorization: owner or admin
  if (dataset.owner_user_id !== user.id && !hasRole(user.role, "admin")) {
    return c.json({ error: "Forbidden: Only dataset owner or admin can publish" }, 403);
  }

  // Prevent publishing sandbox datasets
  if (dataset.is_sandbox) {
    return c.json(
      {
        error: "Cannot publish sandbox datasets",
        message: "Sandbox datasets are for training only and cannot be made public",
      },
      400,
    );
  }

  // Already public (idempotent)
  if (dataset.visibility === "public") {
    return c.json(
      {
        message: "Dataset is already public",
        dataset_id: datasetId,
      },
      200,
    );
  }

  // Validate GitHub repo exists
  if (!dataset.github_repo) {
    return c.json(
      {
        error: "Dataset has no GitHub repository",
        message: "Cannot publish a dataset without a repository",
      },
      400,
    );
  }

  // Extract repo name from full name (e.g., "nemarDatasets/nm000104" -> "nm000104")
  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return c.json({ error: "Invalid GitHub repository format" }, 500);
  }

  // Step 1: Update GitHub repository visibility
  const pat = await getDatasetsToken(c.env);
  const ghResult = await setRepoVisibility(repoName, false, pat);
  if (!ghResult.ok) {
    console.error(`GitHub visibility update failed for ${datasetId}:`, ghResult.error);
    return c.json(
      {
        error: "Failed to update GitHub repository visibility",
        details: ghResult.error,
        dataset_id: datasetId,
      },
      500,
    );
  }

  // Step 2: Update S3 bucket policy for public read
  try {
    await addPublicReadPolicy(
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
    console.error(`S3 policy update failed for ${datasetId}:`, s3Msg);

    // Revert GitHub to private on S3 failure
    const revertResult = await setRepoVisibility(repoName, true, pat);
    if (revertResult.ok) {
      return c.json(
        {
          error: "Failed to update S3 bucket policy, reverted GitHub repository to private",
          details: s3Msg,
          dataset_id: datasetId,
        },
        500,
      );
    }

    return c.json(
      {
        error: "CRITICAL: S3 policy update failed AND GitHub revert failed",
        details: s3Msg,
        dataset_id: datasetId,
        github_visibility: "public",
        s3_public: false,
        revert_error: revertResult.error,
        action_required: `Manually revert GitHub repo to private OR manually add S3 public read policy for ${datasetId}`,
      },
      500,
    );
  }

  // Step 3: Update database
  try {
    await db
      .prepare(
        "UPDATE datasets SET visibility = 'public', updated_at = datetime('now') WHERE id = ?",
      )
      .bind(dataset.id)
      .run();
  } catch (dbError) {
    const dbMsg = dbError instanceof Error ? dbError.message : String(dbError);
    console.error(`Database update failed for ${datasetId}:`, dbMsg);

    // Revert both GitHub and S3 on database failure
    const ghRevertResult = await setRepoVisibility(repoName, true, pat);

    let s3Reverted = false;
    try {
      await removePublicReadPolicy(
        {
          bucket: c.env.S3_BUCKET,
          region: c.env.AWS_REGION,
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        },
        datasetId,
      );
      s3Reverted = true;
    } catch (s3RevertError) {
      console.error(`S3 policy revert failed for ${datasetId}:`, s3RevertError);
    }

    return c.json(
      {
        error: "CRITICAL: Database update failed, attempted rollback",
        details: dbMsg,
        dataset_id: datasetId,
        github_reverted: ghRevertResult.ok,
        s3_reverted: s3Reverted,
        action_required:
          ghRevertResult.ok && s3Reverted
            ? "Rollback successful, but database update failed. Contact administrator."
            : `Manually revert: ${!ghRevertResult.ok ? "GitHub repo to private" : ""} ${!s3Reverted ? "Remove S3 public read policy" : ""}`.trim(),
      },
      500,
    );
  }

  // Step 4: Audit log
  await db
    .prepare(`
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(
      user.id,
      "dataset_publish",
      "dataset",
      datasetId,
      JSON.stringify({
        dataset_name: dataset.name,
        github_repo: dataset.github_repo,
      }),
    )
    .run();

  return c.json({
    success: true,
    message: "Dataset published successfully",
    dataset_id: datasetId,
    github_url: `https://github.com/${dataset.github_repo}`,
    s3_url: `https://${c.env.S3_BUCKET}.s3.${c.env.AWS_REGION}.amazonaws.com/${datasetId}/`,
  });
});
