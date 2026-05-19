/**
 * Webhook routes for GitHub Actions integration
 *
 * These endpoints are called by GitHub Actions workflows
 * and authenticated via a shared secret token.
 */

import type { Context } from "hono";
import { Hono } from "hono";

import { runDatasetSync } from "../services/dataset-reindex.js";
import { createEzidVersionDoi, parseDoiProvider } from "../services/doi.js";
import { enrichDataset } from "../services/enrich-dataset.js";
import { TEST_SHOULDER } from "../services/ezid.js";
import { getDatasetsToken, getNemarOrgToken } from "../services/github-auth.js";
import {
  downloadReleaseArchive,
  signManifestCallbackToken,
  triggerManifestGeneration,
  verifyManifestCallbackToken,
} from "../services/github.js";
import { generateManifest } from "../services/manifest.js";
import { errorMessage, extractRepoName, readRepoMetadata } from "../services/repo-metadata.js";
import { headVersionArtifact, uploadManifest } from "../services/s3.js";
import * as zenodo from "../services/zenodo.js";
import type { Bindings } from "../types/bindings.js";

export { buildEnrichmentCommitPayload } from "../services/enrich-dataset.js";
export type { EnrichmentCommitPayload } from "../services/enrich-dataset.js";

type WebhookContext = Context<{ Bindings: Bindings }>;

/** Constant-time string comparison to prevent timing attacks on secret tokens. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

/**
 * Validate a `ref` value supplied to the /webhooks/llm-enrich endpoint.
 * The ref is interpolated into GitHub API URL fragments and into the shell
 * payload emitted by llm-enrichment.yml, so the allowed characters are
 * intentionally narrow.
 *
 * Returns null when the ref is acceptable. Otherwise returns a human-readable
 * error string suitable for a 400 response body. Exported so unit tests can
 * pin the validation table without spinning up a webhook harness.
 *
 * Accepts `undefined` so callers can use it on optional request fields; the
 * function treats `undefined` as "field absent" and returns null.
 */
export function validateEnrichmentRef(ref: unknown): string | null {
  if (ref === undefined) return null;
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 200) {
    return "Invalid 'ref' parameter: must be a non-empty string up to 200 characters";
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.startsWith("/")) {
    return "Invalid 'ref' parameter: contains forbidden characters";
  }
  return null;
}

/**
 * Decide whether to trigger an nemar.org sync after a version-DOI publish.
 *
 * Pure helper so the EZID and Zenodo paths share one rule and we can pin
 * the matrix in unit tests without spinning up the webhook harness.
 *
 * Rules (mirrors the prior inline EZID logic):
 *   - missing NEMAR_USERNAME or NEMAR_PASSWORD: skip with "no_credentials"
 *   - OpenNeuro dataset (`on`-prefix): skip with "openneuro" (nemar.org
 *     pipeline doesn't yet accept alternate_id; see nemarOrg/nemar-cli#339)
 *   - Sandbox dataset (`xx`-prefix): skip with "sandbox" (blocked from
 *     publishing; syncing would write a false-alarm failed row)
 *   - missing DOI string: skip with "no_doi" (Zenodo only; EZID always
 *     returns a DOI on success)
 *   - otherwise: trigger
 */
export type NemarSyncDecision =
  | { trigger: true }
  | { trigger: false; reason: "no_credentials" | "openneuro" | "sandbox" | "no_doi" };

export function shouldSyncToNemarAfterVersionDoi(input: {
  datasetId: string;
  versionDoi: string | null | undefined;
  nemarUsername: string | null | undefined;
  nemarPassword: string | null | undefined;
}): NemarSyncDecision {
  if (!input.nemarUsername || !input.nemarPassword) {
    return { trigger: false, reason: "no_credentials" };
  }
  if (input.datasetId.startsWith("on")) {
    return { trigger: false, reason: "openneuro" };
  }
  if (input.datasetId.startsWith("xx")) {
    return { trigger: false, reason: "sandbox" };
  }
  if (!input.versionDoi) {
    return { trigger: false, reason: "no_doi" };
  }
  return { trigger: true };
}

/**
 * Returns true iff the central manifest workflow path (#557) is enabled
 * for this Worker. Reads `MANIFEST_VIA_CENTRAL_WORKFLOW` from env and
 * coerces to boolean: only the literal string "true" enables; anything
 * else (including undefined, "false", "True", "1") stays on the legacy
 * in-Worker generateManifest() path. Exported so tests can pin the
 * coercion table.
 */
export function isCentralManifestWorkflowEnabled(env: Bindings): boolean {
  return env.MANIFEST_VIA_CENTRAL_WORKFLOW === "true";
}

/**
 * Dispatch a central manifest generation job and persist the
 * `manifest_jobs` row so the eventual `/webhooks/manifest-ready`
 * callback can find it. Returns the generated nonce + callback token
 * for logging/observability.
 *
 * Throws if `MANIFEST_CALLBACK_SECRET` is unset (the central path is
 * unsafe without it -- any caller could spoof the callback) or if the
 * dispatch POST to GitHub fails. The D1 INSERT is best-effort: a
 * UNIQUE collision on (dataset_id, version, nonce) is extraordinarily
 * unlikely (UUID v4 nonce) but we re-raise so the caller surfaces it
 * rather than silently leaking a job row mismatch.
 */
async function dispatchCentralManifestJob(
  env: Bindings,
  args: {
    datasetId: string;
    version: string;
    doi: string | null;
    conceptDoi: string | null;
    doiProvider: "ezid" | "zenodo";
    /** Disables Stream A's raw.githubusercontent.com canary check when
     *  the dataset repo is private/unauthenticated-HEAD-incapable.
     *  Twin of `skipGitBackedVerification` on the inline path. */
    skipCanary?: boolean;
  },
): Promise<{ nonce: string; callbackToken: string }> {
  if (!env.MANIFEST_CALLBACK_SECRET) {
    throw new Error(
      "MANIFEST_CALLBACK_SECRET is unset; refusing to dispatch central manifest workflow",
    );
  }
  const nonce = crypto.randomUUID();
  const callbackToken = await signManifestCallbackToken(
    { datasetId: args.datasetId, version: args.version, nonce },
    env.MANIFEST_CALLBACK_SECRET,
  );

  // Persist the job row BEFORE dispatch so a slow GitHub round-trip
  // can't deliver the callback to a missing row. If dispatch fails
  // below we mark the row as failed for observability.
  await env.DB.prepare(
    `INSERT INTO manifest_jobs (dataset_id, version, nonce, doi, concept_doi, doi_provider, status)
     VALUES (?, ?, ?, ?, ?, ?, 'dispatched')`,
  )
    .bind(args.datasetId, args.version, nonce, args.doi, args.conceptDoi, args.doiProvider)
    .run();

  // Detect double-dispatch: if there are other still-'dispatched' rows
  // for the same (dataset_id, version) but a different nonce, the
  // publisher likely retried (or two callers raced). The UNIQUE
  // constraint is on (dataset_id, version, nonce) so we don't collide
  // at the DB layer, but operators should see a warning so duplicate
  // workflow runs aren't a silent surprise.
  try {
    const supersessions = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM manifest_jobs
       WHERE dataset_id = ? AND version = ? AND status = 'dispatched' AND nonce != ?`,
    )
      .bind(args.datasetId, args.version, nonce)
      .first<{ count: number }>();
    const olderCount = supersessions?.count ?? 0;
    if (olderCount > 0) {
      console.warn(
        `[manifest-dispatch] superseding ${olderCount} older dispatched job(s) for ${args.datasetId}@${args.version}; possible publisher retry`,
      );
    }
  } catch (err) {
    // Detection is best-effort; never block dispatch on it.
    console.warn("[manifest-dispatch] supersession check failed (non-fatal):", err);
  }

  const callbackUrl = `${env.API_BASE_URL}/webhooks/manifest-ready`;

  try {
    const pat = await getNemarOrgToken(env);
    await triggerManifestGeneration(
      args.datasetId,
      args.version,
      args.doi,
      args.conceptDoi,
      callbackToken,
      callbackUrl,
      pat,
      { skipCanary: args.skipCanary ?? false },
    );
  } catch (err) {
    const msg = errorMessage(err);
    try {
      await env.DB.prepare(
        `UPDATE manifest_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now')
         WHERE dataset_id = ? AND version = ? AND nonce = ?`,
      )
        .bind(`dispatch failed: ${msg}`, args.datasetId, args.version, nonce)
        .run();
    } catch (d1Err) {
      console.error("[webhook] manifest_jobs UPDATE after dispatch failure also failed:", d1Err);
    }
    throw err;
  }

  console.log(
    `[manifest-dispatch] dataset=${args.datasetId} version=${args.version} provider=${args.doiProvider} nonce=${nonce}`,
  );
  return { nonce, callbackToken };
}

const webhooks = new Hono<{ Bindings: Bindings }>();

/**
 * Publish a version DOI for a dataset
 *
 * Called by GitHub Actions when a new release is created.
 * Requires X-Webhook-Token header matching GITHUB_WEBHOOK_SECRET.
 *
 * Routes to EZID or Zenodo based on dataset's doi_provider setting.
 */
webhooks.post("/publish-version-doi", async (c) => {
  // Validate webhook token
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.GITHUB_WEBHOOK_SECRET;

  // If webhook secret not configured OR token doesn't match, reject as unauthorized
  // Treat missing secret as "no valid token exists" for better security
  if (!expectedToken || !token || !timingSafeEqual(token, expectedToken)) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  // Parse request body
  let body: { dataset_id: string; version: string; release_url: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.dataset_id || !body.version || !body.release_url) {
    return c.json({ error: "Missing required fields: dataset_id, version, release_url" }, 400);
  }

  const { dataset_id, version: rawVersion, release_url } = body;

  // Normalize version: strip leading "v" or "V" prefix if present
  const version = rawVersion.replace(/^[vV]/, "");

  // Validate semver format: only stable versions get permanent DOIs.
  // Pre-release versions (beta, rc, dev) are transient and must not receive
  // permanent identifiers.
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.info(
      `[webhook] Skipping DOI for ${dataset_id} version "${rawVersion}": not a stable semver`,
    );
    return c.json(
      {
        error: `Invalid version format: "${rawVersion}". Only stable semver versions (e.g., 1.0.0) are supported for DOI minting.`,
        skipped: true,
      },
      200,
    );
  }

  // Get dataset from database
  const dataset = await c.env.DB.prepare("SELECT * FROM datasets WHERE dataset_id = ?")
    .bind(dataset_id)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      description: string | null;
      github_repo: string | null;
      concept_doi: string | null;
      zenodo_concept_id: string | null;
      ezid_identifier: string | null;
      ezid_status: string | null;
      doi_provider: string | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Check if concept DOI exists
  if (!dataset.concept_doi) {
    return c.json(
      {
        error: "No concept DOI exists for this dataset. Admin must create concept DOI first.",
        skipped: true,
      },
      200,
    ); // Return 200 so workflow doesn't fail
  }

  const provider = parseDoiProvider(dataset.doi_provider);

  // Auto-detect sandbox from EZID test shoulder prefix
  const sandboxPrefix = TEST_SHOULDER.replace(/^doi:/, "").split("/")[0];
  const sandbox =
    provider === "ezid" && dataset.ezid_identifier
      ? dataset.ezid_identifier.includes(sandboxPrefix)
      : false;

  // Route to appropriate provider
  if (provider === "ezid") {
    return handleEzidVersionDoi(c, dataset, version, release_url, sandbox);
  }
  return handleZenodoVersionDoi(c, dataset, version, release_url, sandbox);
});

/**
 * Handle EZID version DOI creation: reads BIDS metadata, mints DOI, updates DB, and generates version manifest.
 */
async function handleEzidVersionDoi(
  c: WebhookContext,
  dataset: {
    id: number;
    dataset_id: string;
    name: string;
    description: string | null;
    github_repo: string | null;
    concept_doi: string | null;
    ezid_identifier: string | null;
  },
  version: string,
  _releaseUrl: string,
  sandbox: boolean,
) {
  if (!dataset.ezid_identifier) {
    return c.json(
      {
        error: "No EZID identifier found for this dataset.",
        skipped: true,
      },
      200,
    );
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = extractRepoName(dataset.github_repo);
  if (!repoName) {
    return c.json({ error: "Invalid github_repo format" }, 400);
  }

  try {
    const pat = await getDatasetsToken(c.env);
    // Read BIDS + NEMAR metadata from the release tag (not main)
    const repoMeta = await readRepoMetadata(repoName, pat, undefined, dataset.name, `v${version}`);
    const { bidsDescription, enrichment } = repoMeta;
    for (const w of repoMeta.warnings) {
      console.error("[webhook]", w);
    }

    // Query all existing version DOIs so concept DOI keeps all HasVersion relations
    const versionRows = await c.env.DB.prepare(
      "SELECT doi FROM dataset_versions WHERE dataset_id = ?",
    )
      .bind(dataset.dataset_id)
      .all<{ doi: string }>();
    const existingVersionDois = versionRows.results.map((r) => r.doi);

    const result = await createEzidVersionDoi(
      {
        EZID_USERNAME: c.env.EZID_USERNAME,
        EZID_PASSWORD: c.env.EZID_PASSWORD,
        EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
        EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
      },
      {
        datasetId: dataset.dataset_id,
        conceptIdentifier: dataset.ezid_identifier,
        version,
        bidsDescription,
        githubRepo: dataset.github_repo,
        sandbox,
        existingVersionDois,
        enrichment,
      },
    );

    // DOI is now public and permanent. DB and manifest failures below are
    // non-fatal but must be surfaced in the response for operator awareness.
    let dbError: string | undefined;
    const centralFlow = isCentralManifestWorkflowEnabled(c.env);
    try {
      await c.env.DB.prepare(
        "UPDATE datasets SET latest_version_doi = ?, updated_at = datetime('now') WHERE id = ?",
      )
        .bind(result.doi, dataset.id)
        .run();

      if (!centralFlow) {
        // Legacy path inserts the dataset_versions row inline. Under the
        // central flow the /webhooks/manifest-ready callback owns the
        // insert (so the row appears only once the manifest is on S3).
        await c.env.DB.prepare(
          "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, 'ezid')",
        )
          .bind(dataset.dataset_id, version, result.doi)
          .run();
      }
    } catch (err) {
      dbError = errorMessage(err);
      console.error(`[webhook] DOI ${result.doi} is PUBLIC but DB update failed:`, err);
    }

    // Generate and upload version manifest.
    //   - centralFlow=false: legacy in-Worker generateManifest() path.
    //   - centralFlow=true:  dispatch repository_dispatch on
    //     nemarOrg/nemar-cli; the central workflow uploads manifest +
    //     summary to S3 and POSTs back to /webhooks/manifest-ready
    //     which inserts the dataset_versions row.
    let manifestGenerated = false;
    let manifestErrorMsg: string | undefined;
    let manifestDispatched = false;
    if (centralFlow) {
      try {
        await dispatchCentralManifestJob(c.env, {
          datasetId: dataset.dataset_id,
          version,
          doi: result.doi,
          conceptDoi: dataset.concept_doi,
          doiProvider: "ezid",
          // Published datasets ARE public at DOI-mint time, but the
          // central workflow's raw.githubusercontent.com canary races
          // GitHub Pages propagation. The publish webhook is the
          // authoritative caller; Stream A's canary is duplicative.
          // Twin of `skipGitBackedVerification` on the inline path.
          skipCanary: true,
        });
        manifestDispatched = true;
      } catch (dispatchErr) {
        manifestErrorMsg = errorMessage(dispatchErr);
        console.error(
          `[webhook] Central manifest dispatch failed for ${dataset.dataset_id}@${version}:`,
          dispatchErr,
        );
      }
    } else {
      try {
        const manifest = await generateManifest(
          repoName,
          version,
          pat,
          dataset.dataset_id,
          result.doi,
          dataset.concept_doi,
        );

        await uploadManifest(
          {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          },
          dataset.dataset_id,
          version,
          JSON.stringify(manifest, null, 2),
        );
        manifestGenerated = true;
      } catch (manifestErr) {
        manifestErrorMsg = errorMessage(manifestErr);
        console.error(
          `[webhook] Manifest generation failed for ${dataset.dataset_id}@${version}:`,
          manifestErr,
        );
      }
    }

    // Upload archive to Zenodo as draft backup (non-fatal)
    let zenodoBackup: string | undefined;
    let zenodoBackupError: string | undefined;
    try {
      const zenodoToken = sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;
      if (!zenodoToken) {
        console.info(
          `[webhook] Zenodo backup skipped for ${dataset.dataset_id}: no ${sandbox ? "sandbox " : ""}API key configured`,
        );
      } else if (!dataset.github_repo) {
        console.info(
          `[webhook] Zenodo backup skipped for ${dataset.dataset_id}: no GitHub repo configured`,
        );
      }
      if (zenodoToken && dataset.github_repo) {
        const tag = `v${version}`;
        const archiveData = await downloadReleaseArchive(repoName, tag, pat);

        // Check if dataset already has a Zenodo backup deposition
        const row = await c.env.DB.prepare("SELECT zenodo_concept_id FROM datasets WHERE id = ?")
          .bind(dataset.id)
          .first<{ zenodo_concept_id: string | null }>();

        let depositionId = row?.zenodo_concept_id
          ? Number.parseInt(row.zenodo_concept_id, 10)
          : Number.NaN;

        if (Number.isNaN(depositionId)) {
          // Create initial Zenodo draft deposition
          const deposition = await zenodo.createDeposition(
            {
              title: `${dataset.name} (NEMAR backup archive)`,
              description: `Backup archive for NEMAR dataset ${dataset.dataset_id}. Primary DOI: ${dataset.concept_doi}`,
              creators: [{ name: "NEMAR" }],
              keywords: ["BIDS", "neuroscience", "NEMAR", "backup"],
              version,
            },
            zenodoToken,
            sandbox,
          );
          depositionId = deposition.id;
          await c.env.DB.prepare(
            "UPDATE datasets SET zenodo_concept_id = ?, updated_at = datetime('now') WHERE id = ?",
          )
            .bind(String(depositionId), dataset.id)
            .run();
        } else {
          // Create a new version draft from existing deposition
          const newVersion = await zenodo.createNewVersion(depositionId, zenodoToken, sandbox);
          depositionId = newVersion.id;
          await zenodo.updateDepositionMetadata(
            depositionId,
            {
              title: `${dataset.name} (NEMAR backup archive)`,
              description: `Backup archive v${version}`,
              creators: [{ name: "NEMAR" }],
              version,
            },
            zenodoToken,
            sandbox,
          );
        }

        const deposition = await zenodo.getDeposition(depositionId, zenodoToken, sandbox);
        if (deposition.links.bucket) {
          await zenodo.uploadFile(
            depositionId,
            deposition.links.bucket,
            `${dataset.dataset_id}-v${version}.zip`,
            archiveData,
            zenodoToken,
            sandbox,
          );
          zenodoBackup = `Zenodo draft #${depositionId}`;
        } else {
          console.warn(
            `[webhook] Zenodo deposition #${depositionId} has no bucket URL; file upload skipped`,
          );
          zenodoBackupError = `Zenodo deposition #${depositionId} has no bucket URL`;
        }
      }
    } catch (zenodoErr) {
      zenodoBackupError = errorMessage(zenodoErr);
      console.error(
        `[webhook] Zenodo backup failed for ${dataset.dataset_id}@${version} (non-fatal):`,
        zenodoErr,
      );
    }

    // Sync to nemar.org in the background (non-fatal, non-blocking).
    // Pass the freshly-minted DOI + version through as overrides so a D1
    // read-after-write race (background waitUntil firing before the new
    // dataset_versions row replicates) doesn't drop the version DOI
    // from the nemar.org payload.
    //
    // Under centralFlow, the manifest/summary/dataset_versions row don't
    // exist yet at this point -- the /webhooks/manifest-ready handler
    // owns those writes. Skip the inline sync; manifest-ready will fire
    // sync after the row insert lands.
    if (!centralFlow) {
      const ezidSyncDecision = shouldSyncToNemarAfterVersionDoi({
        datasetId: dataset.dataset_id,
        versionDoi: result.doi,
        nemarUsername: c.env.NEMAR_USERNAME,
        nemarPassword: c.env.NEMAR_PASSWORD,
      });
      if (ezidSyncDecision.trigger) {
        c.executionCtx.waitUntil(syncToNemarAfterVersionDoi(c.env, dataset, version, result.doi));
      } else if (ezidSyncDecision.reason === "no_credentials") {
        console.warn("[webhook] NEMAR_USERNAME/PASSWORD not configured; skipping nemar.org sync");
      } else if (ezidSyncDecision.reason === "openneuro") {
        console.info(
          `[webhook] Skipping nemar.org sync for OpenNeuro dataset ${dataset.dataset_id}`,
        );
      }
    }

    return c.json({
      message: "Version DOI published successfully",
      version,
      version_doi: result.doi,
      concept_doi: dataset.concept_doi,
      provider: "ezid",
      doi_url: `https://doi.org/${result.doi}`,
      manifest_generated: manifestGenerated,
      manifest_dispatched: manifestDispatched,
      ...(zenodoBackup && { zenodo_backup: zenodoBackup }),
      ...(repoMeta.warnings.length > 0 && { metadata_warnings: repoMeta.warnings }),
      ...(dbError && { db_error: dbError }),
      ...(manifestErrorMsg && { manifest_error: manifestErrorMsg }),
      ...(zenodoBackupError && { zenodo_backup_error: zenodoBackupError }),
      ...(result.warnings && { doi_warnings: result.warnings }),
    });
  } catch (error) {
    console.error("EZID version DOI error:", error);
    return c.json(
      {
        error: "Failed to publish version DOI via EZID",
        details: errorMessage(error),
      },
      500,
    );
  }
}

/**
 * Background task: sync dataset metadata to nemar.org after a version DOI is published.
 * Non-fatal; logs errors but never throws.
 */
async function syncToNemarAfterVersionDoi(
  env: Bindings,
  dataset: {
    id: number;
    dataset_id: string;
    name: string;
    github_repo: string | null;
    concept_doi: string | null;
  },
  version: string,
  versionDoi: string,
): Promise<void> {
  // Delegated to runDatasetSync (epic #417 phase 3) so this path stays in
  // step with the admin reindex endpoint. The helper handles tree+S3+
  // participants gathering, syncDatasetToNemar, nemar_sync_* fields, and the
  // Phase 2 metadata columns + metadata_columns_error.
  try {
    const result = await runDatasetSync(env, dataset.dataset_id, {
      versionOverride: version,
      versionDoiOverride: versionDoi,
    });
    if (result.synced) {
      console.log(`[webhook] nemar.org sync succeeded for ${dataset.dataset_id} v${version}`);
    } else {
      console.warn(
        `[webhook] nemar.org sync failed for ${dataset.dataset_id}: ${result.errors.join("; ")}`,
      );
    }
    if (result.metadata_columns_error) {
      console.warn(
        `[webhook] metadata_columns failed for ${dataset.dataset_id}: ${result.metadata_columns_error}`,
      );
    }
  } catch (err) {
    console.error(`[webhook] nemar.org sync error for ${dataset.dataset_id} (non-fatal):`, err);
    // Record both failures together: runDatasetSync threw before reaching
    // either the nemar_sync UPDATE or the metadata-columns UPDATE, so set
    // both so operators querying for stale state get a consistent view.
    const msg = errorMessage(err);
    try {
      await env.DB.prepare(
        "UPDATE datasets SET nemar_sync_status = 'failed', nemar_sync_error = ?, metadata_columns_error = ?, updated_at = datetime('now') WHERE dataset_id = ?",
      )
        .bind(msg, `runDatasetSync threw before metadata-columns write: ${msg}`, dataset.dataset_id)
        .run();
    } catch (d1Err) {
      console.warn(
        `[webhook] Failed to update sync status in D1 for ${dataset.dataset_id}: ${d1Err}`,
      );
    }
  }
}

/**
 * Handle Zenodo version DOI creation: downloads release, uploads to Zenodo, publishes, and generates version manifest.
 */
async function handleZenodoVersionDoi(
  c: WebhookContext,
  dataset: {
    id: number;
    dataset_id: string;
    name: string;
    description: string | null;
    github_repo: string | null;
    concept_doi: string | null;
    zenodo_concept_id: string | null;
  },
  version: string,
  release_url: string,
  sandbox: boolean,
) {
  if (!dataset.zenodo_concept_id) {
    return c.json(
      {
        error: "No Zenodo concept ID found. Cannot create version DOI.",
        skipped: true,
      },
      200,
    );
  }

  const zenodoToken = sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;
  if (!zenodoToken) {
    return c.json({ error: `Zenodo ${sandbox ? "sandbox " : ""}API key not configured` }, 500);
  }

  try {
    // Create a new version from the concept deposition
    const conceptId = Number.parseInt(dataset.zenodo_concept_id);
    const newVersion = await zenodo.createNewVersion(conceptId, zenodoToken, sandbox);

    // Verify we have a bucket URL for upload
    if (!newVersion.links.bucket) {
      throw new Error("New version deposition has no upload bucket");
    }

    // Download the release zip from GitHub
    const releaseZipUrl = `${release_url.replace("/tag/", "/archive/refs/tags/")}.zip`;
    const zipResponse = await fetch(releaseZipUrl);
    if (!zipResponse.ok) {
      throw new Error(`Failed to download release: ${zipResponse.status}`);
    }
    const zipBuffer = await zipResponse.arrayBuffer();
    const zipFilename = `${dataset.dataset_id}-${version}.zip`;

    // Upload the file to Zenodo
    await zenodo.uploadFile(
      newVersion.id,
      newVersion.links.bucket,
      zipFilename,
      new Uint8Array(zipBuffer),
      zenodoToken,
      sandbox,
    );

    // Update metadata for the new version
    const updatedMetadata: Partial<zenodo.ZenodoMetadata> = {
      title: `${dataset.name} - Version ${version}`,
      description: dataset.description || `BIDS dataset: ${dataset.name}`,
      creators: [{ name: "NEMAR Team" }],
      version: version,
    };

    // Update the deposition metadata
    await zenodo.updateDepositionMetadata(newVersion.id, updatedMetadata, zenodoToken, sandbox);

    // Publish the new version
    const published = await zenodo.publishDeposition(newVersion.id, zenodoToken, sandbox);

    // DOI is now published and permanent. DB and manifest failures below are
    // non-fatal but must be surfaced in the response for operator awareness.
    const baseUrl = sandbox ? "https://sandbox.zenodo.org" : "https://zenodo.org";
    let dbError: string | undefined;
    const centralFlow = isCentralManifestWorkflowEnabled(c.env);
    try {
      await c.env.DB.prepare("UPDATE datasets SET zenodo_latest_version_id = ? WHERE id = ?")
        .bind(published.id.toString(), dataset.id)
        .run();

      if (!centralFlow && published.doi) {
        // Legacy path inserts the dataset_versions row inline. Under the
        // central flow the /webhooks/manifest-ready callback owns the
        // insert (so the row appears only once the manifest is on S3).
        await c.env.DB.prepare(
          "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, 'zenodo')",
        )
          .bind(dataset.dataset_id, version, published.doi)
          .run();
      }
    } catch (err) {
      dbError = errorMessage(err);
      console.error(
        `[webhook] Zenodo DOI ${published.doi} is PUBLISHED but DB update failed:`,
        err,
      );
    }

    // Generate and upload version manifest. See EZID path for the full
    // contract; same legacy-vs-central branch here.
    let manifestGenerated = false;
    let manifestErrorMsg: string | undefined;
    let manifestDispatched = false;
    const zenodoRepoName = dataset.github_repo ? extractRepoName(dataset.github_repo) : null;
    if (centralFlow) {
      try {
        await dispatchCentralManifestJob(c.env, {
          datasetId: dataset.dataset_id,
          version,
          doi: published.doi ?? null,
          conceptDoi: dataset.concept_doi,
          doiProvider: "zenodo",
          // Published datasets ARE public at DOI-mint time, but the
          // central workflow's raw.githubusercontent.com canary races
          // GitHub Pages propagation. The publish webhook is the
          // authoritative caller; Stream A's canary is duplicative.
          // Twin of `skipGitBackedVerification` on the inline path.
          skipCanary: true,
        });
        manifestDispatched = true;
      } catch (dispatchErr) {
        manifestErrorMsg = errorMessage(dispatchErr);
        console.error(
          `[webhook] Central manifest dispatch failed for ${dataset.dataset_id}@${version}:`,
          dispatchErr,
        );
      }
    } else if (zenodoRepoName) {
      try {
        const manifest = await generateManifest(
          zenodoRepoName,
          version,
          await getDatasetsToken(c.env),
          dataset.dataset_id,
          published.doi ?? null,
          dataset.concept_doi,
        );

        await uploadManifest(
          {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          },
          dataset.dataset_id,
          version,
          JSON.stringify(manifest, null, 2),
        );
        manifestGenerated = true;
      } catch (manifestErr) {
        manifestErrorMsg = errorMessage(manifestErr);
        console.error(
          `[webhook] Manifest generation failed for ${dataset.dataset_id}@${version}:`,
          manifestErr,
        );
      }
    }

    // Issue #339: keep nemar.org in step with the latest version DOI.
    // Mirrors the EZID path: non-fatal, runs in the background via
    // waitUntil, and skips OpenNeuro datasets (alternate_id not yet
    // supported by the nemar.org pipeline).
    //
    // Under centralFlow, the manifest/summary/dataset_versions row don't
    // exist yet at this point -- the /webhooks/manifest-ready handler
    // owns those writes. Skip the inline sync; manifest-ready will fire
    // sync after the row insert lands.
    if (!centralFlow) {
      const zenodoSyncDecision = shouldSyncToNemarAfterVersionDoi({
        datasetId: dataset.dataset_id,
        versionDoi: published.doi ?? null,
        nemarUsername: c.env.NEMAR_USERNAME,
        nemarPassword: c.env.NEMAR_PASSWORD,
      });
      if (zenodoSyncDecision.trigger) {
        // trigger: true guarantees versionDoi is non-null (no_doi guard in predicate)
        c.executionCtx.waitUntil(
          syncToNemarAfterVersionDoi(c.env, dataset, version, published.doi!),
        );
      } else {
        if (zenodoSyncDecision.reason === "no_credentials") {
          console.warn("[webhook] NEMAR_USERNAME/PASSWORD not configured; skipping nemar.org sync");
        } else if (zenodoSyncDecision.reason === "openneuro") {
          console.info(
            `[webhook] Skipping nemar.org sync for OpenNeuro dataset ${dataset.dataset_id}`,
          );
        } else if (zenodoSyncDecision.reason === "sandbox") {
          console.info(
            `[webhook] Skipping nemar.org sync for sandbox dataset ${dataset.dataset_id}`,
          );
        } else if (zenodoSyncDecision.reason === "no_doi") {
          console.warn(
            `[webhook] Skipping nemar.org sync for ${dataset.dataset_id}: Zenodo returned no DOI`,
          );
        }
      }
    }

    return c.json({
      message: "Version DOI published successfully",
      version,
      version_doi: published.doi,
      concept_doi: dataset.concept_doi,
      provider: "zenodo",
      zenodo_url: `${baseUrl}/records/${published.id}`,
      manifest_generated: manifestGenerated,
      manifest_dispatched: manifestDispatched,
      ...(dbError && { db_error: dbError }),
      ...(manifestErrorMsg && { manifest_error: manifestErrorMsg }),
    });
  } catch (error) {
    console.error("Zenodo publish error:", error);
    return c.json(
      {
        error: "Failed to publish version DOI",
        details: errorMessage(error),
      },
      500,
    );
  }
}

/**
 * Validate the manifest_ready / manifest_failed request body shape.
 * Exported so unit tests can pin the validation table without spinning
 * up the webhook harness.
 */
export interface ManifestCallbackBody {
  dataset_id: string;
  version: string;
  manifest_url?: string;
  summary_url?: string;
  totals?: { files?: number; bytes?: number; annex?: number; git?: number };
  workflow_run_id?: string;
  workflow_run_url?: string;
  error_message?: string;
  /** Stream A fix round: workflow echoes back the `skip_canary` dispatch
   *  flag so operators can confirm the canary was disabled on this run.
   *  Optional for back-compat with older Stream A runs that predate the
   *  field. Logged on the manifest-ready handler; not persisted (no
   *  column on manifest_jobs in migration 0025). */
  canary_skipped?: boolean;
}

export function validateManifestCallbackBody(
  body: unknown,
  required: ReadonlyArray<keyof ManifestCallbackBody>,
): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;
  for (const field of required) {
    if (b[field] === undefined || b[field] === null) {
      return `Missing required field: ${field}`;
    }
  }
  if (typeof b.dataset_id !== "string" || !b.dataset_id) {
    return "dataset_id must be a non-empty string";
  }
  if (typeof b.version !== "string" || !b.version) {
    return "version must be a non-empty string";
  }
  return null;
}

/**
 * Callback handler for the central manifest workflow (#557, Stream A).
 * Invoked by the GitHub Actions job once both manifest.json and
 * summary.json are uploaded to S3. Validates the HMAC callback token
 * the worker signed at dispatch time, HEAD-checks both S3 artifacts to
 * confirm presence, then INSERTs the dataset_versions row that the
 * legacy in-Worker path used to write inline.
 *
 * Idempotent on the dataset_versions INSERT via OR IGNORE; idempotent
 * on the manifest_jobs row via status='dispatched' -> 'ready' transition
 * gate. Replaying a callback for an already-completed job is a no-op
 * (200 still returned to keep the workflow's exit happy).
 */
webhooks.post("/manifest-ready", async (c) => {
  const token = c.req.header("X-Webhook-Token");
  if (!token) {
    return c.json({ error: "Missing X-Webhook-Token header" }, 401);
  }

  let body: ManifestCallbackBody;
  try {
    body = (await c.req.json()) as ManifestCallbackBody;
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  const validationError = validateManifestCallbackBody(body, [
    "dataset_id",
    "version",
    "manifest_url",
    "summary_url",
    "totals",
    "workflow_run_id",
  ]);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  if (!c.env.MANIFEST_CALLBACK_SECRET) {
    console.error("[manifest-ready] MANIFEST_CALLBACK_SECRET is unset; rejecting callback");
    return c.json({ error: "Server misconfigured: MANIFEST_CALLBACK_SECRET unset" }, 500);
  }

  // Find the in-flight job. Callback token is HMAC over (dataset_id,
  // version, nonce); we must look up the row first to recover the nonce
  // before we can verify the signature. Filter by status='dispatched'
  // so a replay attack against a stale nonce can't reach the INSERT.
  const job = await c.env.DB.prepare(
    `SELECT id, nonce, doi, concept_doi, doi_provider, status
     FROM manifest_jobs
     WHERE dataset_id = ? AND version = ? AND status = 'dispatched'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(body.dataset_id, body.version)
    .first<{
      id: number;
      nonce: string;
      doi: string | null;
      concept_doi: string | null;
      doi_provider: string | null;
      status: string;
    }>();

  if (!job) {
    // No dispatched job for this (dataset, version). Either we've
    // already processed the callback, or the dispatch row was never
    // written. Either way: don't trust the caller; 401.
    console.warn(
      `[manifest-ready] no dispatched manifest_jobs row for dataset=${body.dataset_id} version=${body.version}`,
    );
    return c.json({ error: "No in-flight manifest job for this dataset+version" }, 401);
  }

  const ok = await verifyManifestCallbackToken(
    token,
    { datasetId: body.dataset_id, version: body.version, nonce: job.nonce },
    c.env.MANIFEST_CALLBACK_SECRET,
  );
  if (!ok) {
    console.warn(
      `[manifest-ready] callback token mismatch dataset=${body.dataset_id} version=${body.version}`,
    );
    return c.json({ error: "Invalid callback token" }, 401);
  }

  // HEAD-check both S3 artifacts. The workflow tells us the URLs but we
  // verify by signed HEAD against our own bucket -- the contract is
  // {datasetId}/version/v{X.Y.Z}.json and the sibling -summary.json
  // key, so we don't need to trust the caller's manifest_url/summary_url
  // for the HEAD. (We still record what the caller sent for audit.)
  const s3Opts = {
    bucket: c.env.S3_BUCKET,
    region: c.env.AWS_REGION,
    accessKeyId: c.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
  };

  let manifestPresent = false;
  let summaryPresent = false;
  try {
    manifestPresent = await headVersionArtifact(s3Opts, body.dataset_id, body.version, "");
  } catch (err) {
    console.error("[manifest-ready] manifest HEAD failed:", err);
  }
  try {
    summaryPresent = await headVersionArtifact(s3Opts, body.dataset_id, body.version, "-summary");
  } catch (err) {
    console.error("[manifest-ready] summary HEAD failed:", err);
  }

  if (!manifestPresent || !summaryPresent) {
    console.error(
      `[manifest-ready] S3 verification failed dataset=${body.dataset_id} version=${body.version} manifest=${manifestPresent} summary=${summaryPresent}`,
    );
    return c.json(
      {
        error: "S3 artifacts not found",
        manifest_present: manifestPresent,
        summary_present: summaryPresent,
      },
      502,
    );
  }

  // Insert dataset_versions row (the contract piece that USED to live
  // inline in publish-version-doi). OR IGNORE makes this idempotent if
  // the legacy path already wrote the row (paranoid double-write
  // protection during the soak period).
  //
  // Critical: if this INSERT fails we MUST return 500 BEFORE flipping
  // manifest_jobs.status to 'ready'. Otherwise the row stays missing,
  // the job becomes unreplayable (status != 'dispatched' on retry), and
  // the central workflow has no signal to retry from.
  const provider = job.doi_provider === "zenodo" ? "zenodo" : "ezid";
  if (job.doi) {
    try {
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, ?)",
      )
        .bind(body.dataset_id, body.version, job.doi, provider)
        .run();
    } catch (err) {
      const dbError = errorMessage(err);
      console.error("[manifest-ready] dataset_versions insert failed:", err);
      return c.json({ error: "Failed to insert dataset_versions row", db_error: dbError }, 500);
    }
  } else {
    console.warn(
      `[manifest-ready] dataset=${body.dataset_id} version=${body.version} has no DOI on the manifest_jobs row; skipping dataset_versions insert`,
    );
  }

  // Mark the job as ready. We do this AFTER the insert so a failed
  // insert leaves the job in 'dispatched' for a retry / manual fix.
  try {
    await c.env.DB.prepare(
      `UPDATE manifest_jobs
       SET status = 'ready', completed_at = datetime('now')
       WHERE id = ? AND status = 'dispatched'`,
    )
      .bind(job.id)
      .run();
  } catch (err) {
    console.error("[manifest-ready] manifest_jobs UPDATE to 'ready' failed:", err);
  }

  // Issue #557: under centralFlow the EZID/Zenodo publish handlers
  // intentionally skip the nemar.org sync because the
  // dataset_versions row + manifest/summary on S3 don't exist yet
  // when the DOI is minted. Fire the sync HERE, after the row insert
  // lands, so the nemar.org payload sees the new version DOI.
  // Non-fatal: log + carry on (legacy behavior).
  if (job.doi) {
    try {
      const dataset = await c.env.DB.prepare(
        "SELECT id, dataset_id, name, github_repo, concept_doi FROM datasets WHERE dataset_id = ?",
      )
        .bind(body.dataset_id)
        .first<{
          id: number;
          dataset_id: string;
          name: string;
          github_repo: string | null;
          concept_doi: string | null;
        }>();
      if (dataset) {
        const syncDecision = shouldSyncToNemarAfterVersionDoi({
          datasetId: dataset.dataset_id,
          versionDoi: job.doi,
          nemarUsername: c.env.NEMAR_USERNAME,
          nemarPassword: c.env.NEMAR_PASSWORD,
        });
        if (syncDecision.trigger) {
          c.executionCtx.waitUntil(
            syncToNemarAfterVersionDoi(c.env, dataset, body.version, job.doi),
          );
        } else if (syncDecision.reason === "no_credentials") {
          console.warn(
            "[manifest-ready] NEMAR_USERNAME/PASSWORD not configured; skipping nemar.org sync",
          );
        } else if (syncDecision.reason === "openneuro") {
          console.info(
            `[manifest-ready] Skipping nemar.org sync for OpenNeuro dataset ${dataset.dataset_id}`,
          );
        } else if (syncDecision.reason === "sandbox") {
          console.info(
            `[manifest-ready] Skipping nemar.org sync for sandbox dataset ${dataset.dataset_id}`,
          );
        }
      } else {
        console.warn(
          `[manifest-ready] dataset row not found for ${body.dataset_id}; skipping nemar.org sync`,
        );
      }
    } catch (err) {
      console.error("[manifest-ready] nemar.org sync scheduling failed (non-fatal):", err);
    }
  }

  const fileCount = body.totals?.files ?? 0;
  // canary_skipped echoed back from Stream A so operators can grep
  // confirmation that the dispatch-side skipCanary flag took effect.
  // Absent on older Stream A runs that predate the field.
  const canarySkipped =
    typeof body.canary_skipped === "boolean" ? String(body.canary_skipped) : "(unset)";
  console.log(
    `[manifest-ready] dataset=${body.dataset_id} version=${body.version} totals.files=${fileCount} canary_skipped=${canarySkipped}`,
  );

  return c.json({
    ok: true,
    dataset_id: body.dataset_id,
    version: body.version,
  });
});

/**
 * Failure-callback handler for the central manifest workflow. Invoked
 * when the workflow itself failed (build error, S3 upload error, etc.)
 * before it could write artifacts. Updates the manifest_jobs row to
 * status='failed' and records the workflow run URL for operator
 * follow-up. Returns 200 best-effort so the central workflow doesn't
 * see a 4xx and retry on its own.
 */
webhooks.post("/manifest-failed", async (c) => {
  const token = c.req.header("X-Webhook-Token");
  if (!token) {
    return c.json({ error: "Missing X-Webhook-Token header" }, 401);
  }

  let body: ManifestCallbackBody;
  try {
    body = (await c.req.json()) as ManifestCallbackBody;
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  const validationError = validateManifestCallbackBody(body, ["dataset_id", "version"]);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  if (!c.env.MANIFEST_CALLBACK_SECRET) {
    console.error("[manifest-failed] MANIFEST_CALLBACK_SECRET is unset; rejecting callback");
    return c.json({ error: "Server misconfigured: MANIFEST_CALLBACK_SECRET unset" }, 500);
  }

  const job = await c.env.DB.prepare(
    `SELECT id, nonce, status FROM manifest_jobs
     WHERE dataset_id = ? AND version = ? AND status = 'dispatched'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(body.dataset_id, body.version)
    .first<{ id: number; nonce: string; status: string }>();

  if (!job) {
    console.warn(
      `[manifest-failed] no dispatched manifest_jobs row for dataset=${body.dataset_id} version=${body.version}`,
    );
    return c.json({ ok: true, no_job: true });
  }

  const ok = await verifyManifestCallbackToken(
    token,
    { datasetId: body.dataset_id, version: body.version, nonce: job.nonce },
    c.env.MANIFEST_CALLBACK_SECRET,
  );
  if (!ok) {
    console.warn(
      `[manifest-failed] callback token mismatch dataset=${body.dataset_id} version=${body.version}`,
    );
    return c.json({ error: "Invalid callback token" }, 401);
  }

  const errorMsg = body.error_message ?? "unknown error";
  const runUrl = body.workflow_run_url ?? null;
  if (runUrl === null) {
    console.warn(
      `[manifest-failed] dataset=${body.dataset_id} version=${body.version} workflow_run_url=null; operator follow-up will need to grep recent Actions runs manually`,
    );
  }
  try {
    await c.env.DB.prepare(
      `UPDATE manifest_jobs
       SET status = 'failed', error_message = ?, workflow_run_url = ?, completed_at = datetime('now')
       WHERE id = ? AND status = 'dispatched'`,
    )
      .bind(errorMsg, runUrl, job.id)
      .run();
  } catch (err) {
    console.error("[manifest-failed] manifest_jobs UPDATE to 'failed' failed:", err);
  }

  console.error(
    `[manifest-failed] dataset=${body.dataset_id} version=${body.version} error=${errorMsg} run_url=${runUrl ?? "(none)"}`,
  );

  return c.json({ ok: true, dataset_id: body.dataset_id, version: body.version });
});

/**
 * Trigger LLM-based metadata enrichment for a dataset. Called by GitHub
 * Actions when README.md or dataset_description.json changes. Authenticates
 * via X-Webhook-Token, validates the request shape, and delegates the
 * pipeline work to enrichDataset() in services/enrich-dataset.ts.
 */
webhooks.post("/llm-enrich", async (c) => {
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.GITHUB_WEBHOOK_SECRET;

  if (!expectedToken || !token || !timingSafeEqual(token, expectedToken)) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  let body: {
    dataset_id: string;
    force?: boolean;
    client_commits?: boolean;
    ref?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.dataset_id) {
    return c.json({ error: "Missing required field: dataset_id" }, 400);
  }
  if (body.force !== undefined && typeof body.force !== "boolean") {
    return c.json({ error: "Invalid 'force' parameter: must be a boolean (true/false)" }, 400);
  }
  if (body.client_commits !== undefined && typeof body.client_commits !== "boolean") {
    return c.json(
      { error: "Invalid 'client_commits' parameter: must be a boolean (true/false)" },
      400,
    );
  }
  const refValidationError = validateEnrichmentRef(body.ref);
  if (refValidationError) {
    return c.json({ error: refValidationError }, 400);
  }

  const outcome = await enrichDataset(c.env, {
    datasetId: body.dataset_id,
    force: body.force,
    clientCommits: body.client_commits,
    ref: body.ref,
  });
  return c.json(outcome.body, outcome.status);
});

export default webhooks;
