/**
 * Webhook routes for GitHub Actions integration
 *
 * These endpoints are called by GitHub Actions workflows
 * and authenticated via a shared secret token.
 */

import type { Context } from "hono";
import { Hono } from "hono";

import { purgeCacheUrls, zarrPurgeTargets } from "../services/cloudflare.js";
import { runDatasetSync } from "../services/dataset-reindex.js";
import { isValidDatasetId } from "../services/datasetId.js";
import { createEzidVersionDoi, parseDoiProvider } from "../services/doi.js";
import { resolveEmailConfig, sendPublicationBlockedEmail } from "../services/email.js";
import { enrichDataset } from "../services/enrich-dataset.js";
import { TEST_SHOULDER } from "../services/ezid.js";
import { getDatasetsToken } from "../services/github-auth.js";
import {
  downloadReleaseArchive,
  signManifestCallbackToken,
  triggerEnrichmentRun,
  triggerManifestGeneration,
  triggerVersionDoiRun,
  triggerZarrGeneration,
  verifyManifestCallbackToken,
  verifyPrescreenCallbackToken,
} from "../services/github.js";
import { generateManifest } from "../services/manifest.js";
import { errorMessage, extractRepoName, readRepoMetadata } from "../services/repo-metadata.js";
import { getDatasetS3Stats, headVersionArtifact, uploadManifest } from "../services/s3.js";
import { verifyGitHubWebhookSignature } from "../services/webhook-signature.js";
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
 * payload emitted by the central `run-enrichment.yml` on
 * `nemarDatasets/.github` (Phase 1 of #601), so the allowed characters
 * are intentionally narrow.
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
    const pat = await getDatasetsToken(env);
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
 * Requires X-Webhook-Token header matching NEMAR_WEBHOOK_TOKEN (falls back
 * to GITHUB_WEBHOOK_SECRET during the secret-untangle rollout — both held
 * the same value historically, see docs/guides/github-app-setup.md).
 *
 * Routes to EZID or Zenodo based on dataset's doi_provider setting.
 */
webhooks.post("/publish-version-doi", async (c) => {
  // Validate webhook token
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;

  // If webhook secret not configured OR token doesn't match, reject as unauthorized
  // Treat missing secret as "no valid token exists" for better security
  if (!expectedToken) {
    // Distinguish "operator misconfiguration" (no secret set or empty string)
    // from "real token mismatch" so an on-call doesn't spend hours chasing
    // an invalid-token alert when the actual fix is `wrangler secret put`.
    // `??` only falls through on null/undefined; an empty string sticks and
    // produces the same 401 as a real mismatch without this log.
    console.error(
      "[publish-version-doi] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
    );
    return c.json({ error: "Invalid webhook token" }, 401);
  }
  if (!token || !timingSafeEqual(token, expectedToken)) {
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

  // Idempotency guard for duplicate version-DOI dispatches. Phase 2
  // centralization (#606) introduces a brief cutover window where both the
  // legacy per-repo version-doi.yml AND the new central run-version-doi.yml
  // fire on the same tag push. The EZID path catches "already exists" via
  // doi.ts:createEzidVersionDoi, but Zenodo's `createNewVersion` has no
  // such guard — a second call would mint a duplicate draft and, on
  // publish, a permanent second DOI for the same dataset version.
  //
  // Short-circuit here if D1 already records a version DOI for this
  // (dataset_id, version). The dataset_versions row is written on
  // successful publish at the end of this handler, so a successful first
  // dispatch blocks any subsequent dispatch (whether from the cutover
  // window or from an operator retry).
  try {
    const existing = await c.env.DB.prepare(
      "SELECT doi FROM dataset_versions WHERE dataset_id = ? AND version = ?",
    )
      .bind(dataset.dataset_id, version)
      .first<{ doi: string | null }>();
    if (existing?.doi) {
      console.log(
        `[publish-version-doi] zenodo: ${dataset.dataset_id} ${version} already has DOI ${existing.doi}; short-circuiting to prevent duplicate mint`,
      );
      return c.json(
        {
          version_doi: existing.doi,
          dataset_id: dataset.dataset_id,
          version,
          skipped: true,
          reason: "already_published",
        },
        200,
      );
    }
  } catch (lookupErr) {
    // A read failure is non-fatal — we'd rather risk a duplicate mint
    // (rare, detectable, manually correctable) than block legitimate
    // publishes on a transient D1 hiccup. Log loudly and continue.
    console.warn(
      `[publish-version-doi] zenodo: dataset_versions lookup failed for ${dataset.dataset_id} ${version}: ${lookupErr instanceof Error ? lookupErr.message : String(lookupErr)}; proceeding without idempotency guard`,
    );
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
  // Capture the error message separately so the 502 body can distinguish
  // "S3 returned 404 (artifact really missing)" from "HEAD itself threw
  // before getting a status (IAM/credentials/network)". Without this the
  // operator-facing body just says "not found" even when the cause is a
  // credential drift, which sends them on the wrong diagnostic trail.
  let manifestHeadError: string | undefined;
  let summaryHeadError: string | undefined;
  try {
    manifestPresent = await headVersionArtifact(s3Opts, body.dataset_id, body.version, "");
  } catch (err) {
    manifestHeadError = err instanceof Error ? err.message : String(err);
    console.error("[manifest-ready] manifest HEAD failed:", err);
  }
  try {
    summaryPresent = await headVersionArtifact(s3Opts, body.dataset_id, body.version, "-summary");
  } catch (err) {
    summaryHeadError = err instanceof Error ? err.message : String(err);
    console.error("[manifest-ready] summary HEAD failed:", err);
  }

  if (!manifestPresent || !summaryPresent) {
    console.error(
      `[manifest-ready] S3 verification failed dataset=${body.dataset_id} version=${body.version} manifest=${manifestPresent} summary=${summaryPresent}`,
    );
    const hadHeadError = manifestHeadError || summaryHeadError;
    return c.json(
      {
        error: hadHeadError
          ? "S3 HEAD check failed (credentials/permissions error -- not a missing artifact)"
          : "S3 artifacts not found",
        manifest_present: manifestPresent,
        summary_present: summaryPresent,
        ...(manifestHeadError && { manifest_head_error: manifestHeadError }),
        ...(summaryHeadError && { summary_head_error: summaryHeadError }),
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

// ============================================================================
// Publication pre-screen callback (issue #666)
// ============================================================================

export interface PrescreenCallbackBody {
  dataset_id: string;
  request_id: number;
  // "error" = the workflow could not complete (install/claude/parse failure);
  // the Worker resets the screen so the request falls back to manual review.
  verdict: "pass" | "block" | "error";
  reasons?: string[];
  issue_url?: string;
  workflow_run_id?: string;
}

/** Validate the run-prescreen workflow's callback body. */
export function validatePrescreenCallbackBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.dataset_id !== "string" || !b.dataset_id) {
    return "dataset_id must be a non-empty string";
  }
  if (typeof b.request_id !== "number" || !Number.isInteger(b.request_id)) {
    return "request_id must be an integer";
  }
  if (b.verdict !== "pass" && b.verdict !== "block" && b.verdict !== "error") {
    return "verdict must be 'pass', 'block', or 'error'";
  }
  if (
    b.reasons !== undefined &&
    (!Array.isArray(b.reasons) || b.reasons.some((r) => typeof r !== "string"))
  ) {
    return "reasons must be an array of strings";
  }
  if (b.issue_url !== undefined && typeof b.issue_url !== "string") {
    return "issue_url must be a string";
  }
  return null;
}

/**
 * Combine the `claude -p` verdict with an independent server-side S3 check.
 * The workflow judges README/metadata/declared-data quality; the Worker has
 * the AWS credentials to confirm the blobs actually landed. We only treat a
 * literally empty objects/ prefix as "missing data" -- `objectCount` is
 * `undefined` when the page-count cap was hit (i.e. *many* objects), which is
 * emphatically not missing. An S3 read error yields `s3 = null` so infra
 * blips never produce a false block. Pure function: no I/O, fully testable.
 */
export interface PrescreenS3Presence {
  totalSize: number;
  objectCount: number | undefined;
}
export function decidePrescreenOutcome(
  verdict: "pass" | "block",
  reasons: string[],
  s3: PrescreenS3Presence | null,
): { blocked: boolean; reasons: string[] } {
  const out = [...reasons];
  let blocked = verdict === "block";
  const s3Missing = !!s3 && s3.totalSize === 0 && s3.objectCount === 0;
  if (s3Missing) {
    blocked = true;
    if (!out.some((r) => /no data|s3|storage/i.test(r))) {
      out.push("No data files were found in storage for this dataset.");
    }
  }
  return { blocked, reasons: out };
}

/**
 * Callback handler for the run-prescreen workflow. The workflow has already
 * judged the dataset and (on block) opened a GitHub issue; this endpoint
 * verifies the HMAC token, runs the independent S3 presence check, and
 * records the outcome on the publication_requests row -- flipping it to
 * 'blocked' (+ emailing the requester) or marking the screen 'passed'.
 *
 * One-shot: gated on prescreen_status='pending', so a replayed callback for
 * an already-resolved request finds no row and 401s.
 */
webhooks.post("/prescreen-result", async (c) => {
  const token = c.req.header("X-Webhook-Token");
  if (!token) {
    return c.json({ error: "Missing X-Webhook-Token header" }, 401);
  }

  let body: PrescreenCallbackBody;
  try {
    body = (await c.req.json()) as PrescreenCallbackBody;
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  const validationError = validatePrescreenCallbackBody(body);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  if (!c.env.PRESCREEN_CALLBACK_SECRET) {
    console.error("[prescreen-result] PRESCREEN_CALLBACK_SECRET is unset; rejecting callback");
    return c.json({ error: "Server misconfigured: PRESCREEN_CALLBACK_SECRET unset" }, 500);
  }

  // Recover the nonce + requester from the in-flight row. Filter on
  // prescreen_status='pending' so a replay against a resolved request can't
  // re-trigger the block/email.
  const request = await c.env.DB.prepare(
    `SELECT pr.id, pr.dataset_id, pr.prescreen_nonce, pr.requested_by,
            u.username AS requested_by_username, u.email AS requested_by_email
       FROM publication_requests pr
       JOIN users u ON pr.requested_by = u.id
      WHERE pr.id = ? AND pr.dataset_id = ? AND pr.prescreen_status = 'pending'
      LIMIT 1`,
  )
    .bind(body.request_id, body.dataset_id)
    .first<{
      id: number;
      dataset_id: string;
      prescreen_nonce: string | null;
      requested_by: number;
      requested_by_username: string;
      requested_by_email: string;
    }>();

  if (!request || !request.prescreen_nonce) {
    console.warn(
      `[prescreen-result] no pending prescreen for request_id=${body.request_id} dataset=${body.dataset_id}`,
    );
    return c.json({ error: "No in-flight pre-screen for this request" }, 401);
  }

  const ok = await verifyPrescreenCallbackToken(
    token,
    { datasetId: body.dataset_id, requestId: request.id, nonce: request.prescreen_nonce },
    c.env.PRESCREEN_CALLBACK_SECRET,
  );
  if (!ok) {
    console.warn(
      `[prescreen-result] callback token mismatch request_id=${body.request_id} dataset=${body.dataset_id}`,
    );
    return c.json({ error: "Invalid callback token" }, 401);
  }

  // verdict="error": the workflow could not complete. Don't block on an
  // infrastructure failure -- reset the screen to NULL so the request falls
  // back to normal admin review (status stays 'requested'). No S3 check, no
  // email. Gated on 'pending' so it's still one-shot.
  if (body.verdict === "error") {
    const res = await c.env.DB.prepare(
      `UPDATE publication_requests
          SET prescreen_status = NULL, prescreen_nonce = NULL,
              prescreen_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND prescreen_status = 'pending'`,
    )
      .bind(request.id)
      .run();
    console.warn(
      `[prescreen-result] dataset=${body.dataset_id} request_id=${request.id} verdict=error; reset to manual review (changes=${res.meta.changes})`,
    );
    return c.json({ ok: true, dataset_id: body.dataset_id, blocked: false, reset: true });
  }

  // Independent server-side S3 presence check. Capped at one page (1000
  // objects) -- we only need to distinguish "empty" from "non-empty", not
  // the full count. A read error leaves s3=null so we trust the workflow.
  let s3: PrescreenS3Presence | null = null;
  try {
    s3 = await getDatasetS3Stats(
      {
        bucket: c.env.S3_BUCKET,
        region: c.env.AWS_REGION,
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      },
      body.dataset_id,
      1,
    );
  } catch (err) {
    console.error(`[prescreen-result] S3 stats failed for ${body.dataset_id} (non-fatal):`, err);
  }

  const { blocked, reasons } = decidePrescreenOutcome(body.verdict, body.reasons ?? [], s3);
  const issueUrl = body.issue_url ?? null;

  if (blocked) {
    const res = await c.env.DB.prepare(
      `UPDATE publication_requests
          SET status = 'blocked', block_reason = 'prescreen_failed',
              prescreen_status = 'failed', prescreen_issue_url = ?,
              prescreen_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND prescreen_status = 'pending'`,
    )
      .bind(issueUrl, request.id)
      .run();

    // Only email if THIS call did the transition. Guards against a duplicate
    // email if two callbacks race past the 'pending' read (the second sees
    // changes=0 because the first already flipped the row).
    if (res.meta.changes > 0) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      c.executionCtx.waitUntil(
        sendPublicationBlockedEmail(
          request.requested_by_email,
          request.requested_by_username,
          body.dataset_id,
          reasons,
          issueUrl,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
        ).catch((emailErr) => {
          // waitUntil swallows rejections to the runtime log; catch here so the
          // failure is attributable and the dataset id is in the message.
          console.error(
            `[prescreen-result] block email send failed for ${body.dataset_id}:`,
            emailErr,
          );
        }),
      );
    }
  } else {
    await c.env.DB.prepare(
      `UPDATE publication_requests
          SET prescreen_status = 'passed', prescreen_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ? AND prescreen_status = 'pending'`,
    )
      .bind(request.id)
      .run();
  }

  console.log(
    `[prescreen-result] dataset=${body.dataset_id} request_id=${request.id} verdict=${body.verdict} blocked=${blocked} s3_objects=${s3 ? (s3.objectCount ?? "capped") : "unknown"}`,
  );

  return c.json({ ok: true, dataset_id: body.dataset_id, blocked });
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
  // Same secret-untangle as /publish-version-doi: prefer NEMAR_WEBHOOK_TOKEN,
  // fall back to the historically-shared GITHUB_WEBHOOK_SECRET.
  const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;

  if (!expectedToken) {
    // Diagnostic log to distinguish "operator misconfiguration" from "real
    // token mismatch" — same rationale as /publish-version-doi above.
    console.error(
      "[llm-enrich] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
    );
    return c.json({ error: "Invalid webhook token" }, 401);
  }
  if (!token || !timingSafeEqual(token, expectedToken)) {
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

// ─── GitHub App webhook receiver ────────────────────────────────────────────
//
// The nemar-publish-bot App is configured to deliver `push` events from every
// dataset repo under `nemarDatasets` to this endpoint. We decode the event,
// filter it down to enrichment-relevant pushes, and dispatch the central
// `run-enrichment` workflow on `nemarDatasets/.github`.
//
// Phase 1 of epic #601 / sub-issue #602. Until the strip script runs, the
// per-repo `llm-enrichment.yml` will continue to fire on the same push; both
// pipelines hit `/webhooks/llm-enrich`, where the `source_hash` guard makes
// the duplicate a Stage-2 no-op.

/** Paths whose change should trigger an enrichment run.
 *
 *  Includes only sources that *feed* enrichment (README + BIDS description).
 *  Crucially excludes `.nemar/metadata.json` — that file IS the enrichment
 *  output, written by `nemar-publish-bot` on every successful run. Listing
 *  it here turned every enrichment commit into a fresh trigger and Haiku's
 *  non-deterministic prose ensured the file always looked "changed" to the
 *  push filter, so the pipeline self-fired forever (#643, observed on
 *  on007827: ~60 runs/hr, ~$0.01 OpenRouter each, until manually disabled).
 *  Manual recovery / re-enrichment is still available via
 *  `workflow_dispatch` on `nemarDatasets/.github/run-enrichment.yml`. */
const ENRICHMENT_TRIGGER_PATHS: ReadonlySet<string> = new Set([
  "README.md",
  "dataset_description.json",
]);

interface PushEventCommit {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

interface PushEventPayload {
  ref?: string;
  repository?: {
    name?: string;
    owner?: { login?: string };
  };
  commits?: PushEventCommit[];
  head_commit?: PushEventCommit | null;
  deleted?: boolean;
  /** Set when the push rewrote history. We don't use this for filtering
   *  (the `commits`/`head_commit` union below already produces the
   *  correct touched-path set whether or not history was rewritten), but
   *  the field is part of GitHub's push-event payload and is modelled
   *  here so the type matches reality and to anchor the force-push test
   *  cases in `webhook-github-push.test.ts`. */
  forced?: boolean;
}

/** Decide whether a push event should fan out to the enrichment workflow.
 *
 *  Exported for unit testing — keep this pure (no env, no I/O) so the
 *  webhook-github tests can pin the filter table without spinning up a
 *  Hono harness. */
export function shouldDispatchEnrichment(
  event: PushEventPayload,
):
  | { dispatch: false; reason: string }
  | { dispatch: true; datasetId: string; ref: string; force: boolean } {
  if (event.deleted) return { dispatch: false, reason: "branch_deleted" };

  const owner = event.repository?.owner?.login;
  if (owner !== "nemarDatasets") {
    return { dispatch: false, reason: "wrong_owner" };
  }

  const datasetId = event.repository?.name;
  if (!datasetId || !isValidDatasetId(datasetId)) {
    return { dispatch: false, reason: "not_a_dataset_repo" };
  }

  const ref = event.ref ?? "";
  let refName: string;
  let force: boolean;
  if (ref === "refs/heads/main") {
    refName = "main";
    force = false;
  } else if (ref.startsWith("refs/heads/release/")) {
    refName = ref.slice("refs/heads/".length);
    // Release-branch pushes only touch the Version field in
    // dataset_description.json, so the source_hash short-circuit would
    // otherwise skip the run. Force the re-enrichment so the release PR
    // carries fresh `.nemar/metadata.json`. Mirrors the legacy per-repo
    // workflow's FORCE="true" on release/*.
    force = true;
  } else {
    return { dispatch: false, reason: "ref_not_main_or_release" };
  }

  const touched = new Set<string>();
  // `commits[]` lists every commit in the push; `head_commit` is the tip and
  // may carry paths the commits-array entries don't (force-push edge case).
  // Union them so a path mentioned only on the tip isn't missed.
  const sources: Array<PushEventCommit | null | undefined> = [
    ...(event.commits ?? []),
    event.head_commit ?? null,
  ];
  for (const c of sources) {
    if (!c) continue;
    for (const p of c.added ?? []) touched.add(p);
    for (const p of c.modified ?? []) touched.add(p);
    for (const p of c.removed ?? []) touched.add(p);
  }
  let matched = false;
  for (const p of touched) {
    if (ENRICHMENT_TRIGGER_PATHS.has(p)) {
      matched = true;
      break;
    }
  }
  if (!matched) return { dispatch: false, reason: "no_enrichment_paths_touched" };

  return { dispatch: true, datasetId, ref: refName, force };
}

/** Strict version-tag pattern: `v` + semver core + optional pre-release of
 *  the shapes the project's `scripts/bump-version.sh` actually emits
 *  (`-rc<N>`, `-alpha<N>`, `-beta<N>`, with `<N>` optional). Tighter than
 *  the legacy `tags: ['v*']` glob so a typo'd `vfoo` or unrelated `vlatest`
 *  tag doesn't cause an accidental DOI mint. Phase 2 of #601 / #606. */
const VERSION_TAG_REF_RE = /^refs\/tags\/(v\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\d*)?)$/;

/** Decide whether a push event should fan out to the version-DOI workflow.
 *
 *  Filter rules (parallel to `shouldDispatchEnrichment`, exported for unit
 *  testing):
 *    - same owner (`nemarDatasets`) + dataset id (`isValidDatasetId`) gate
 *    - `ref` matches `^refs/tags/v<semver>$` per VERSION_TAG_REF_RE
 *    - `deleted` is falsy (tag deletes must NOT mint a new DOI)
 *
 *  Returns the bare tag (sans `refs/tags/` prefix) on the happy path so
 *  callers can pass it straight to `triggerVersionDoiRun`. Phase 2 of #601.
 */
export function shouldDispatchVersionDoi(
  event: PushEventPayload,
): { dispatch: false; reason: string } | { dispatch: true; datasetId: string; tag: string } {
  if (event.deleted) return { dispatch: false, reason: "tag_deleted" };

  const owner = event.repository?.owner?.login;
  if (owner !== "nemarDatasets") {
    return { dispatch: false, reason: "wrong_owner" };
  }

  const datasetId = event.repository?.name;
  if (!datasetId || !isValidDatasetId(datasetId)) {
    return { dispatch: false, reason: "not_a_dataset_repo" };
  }

  const ref = event.ref ?? "";
  const match = VERSION_TAG_REF_RE.exec(ref);
  if (!match) {
    return { dispatch: false, reason: "ref_not_version_tag" };
  }

  return { dispatch: true, datasetId, tag: match[1] };
}

/** Source-data file extensions whose change should rebuild a recording's Zarr
 *  serving copy (epic #684). Primary recording containers plus the companion
 *  files that carry their samples/markers (EEGLAB `.fdt`; the BrainVision
 *  `.vhdr`/`.vmrk`/`.eeg` triplet), so a change confined to a companion still
 *  triggers a reconversion of its recording. Compared lowercase. */
const ZARR_DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  "set",
  "fdt", // EEGLAB
  "edf",
  "bdf", // European Data Format (+)
  "vhdr",
  "vmrk",
  "eeg", // BrainVision triplet
  "fif", // MEG / Elekta-Neuromag FIFF
]);

/** True if a BIDS path is a recording data file (or its companion) or a curated
 *  `_events.tsv` sidecar. A `_events.tsv` change must refresh the sibling
 *  recording's embedded events; a CTF `.ds` recording is a directory, so any
 *  file under `*.ds/` counts. Exported for unit testing. */
export function isZarrTriggerPath(p: string): boolean {
  if (p.endsWith("_events.tsv")) return true;
  if (p.includes(".ds/")) return true;
  const dot = p.lastIndexOf(".");
  if (dot === -1) return false;
  return ZARR_DATA_EXTENSIONS.has(p.slice(dot + 1).toLowerCase());
}

/** Decide whether a push event should fan out to the Zarr-generation workflow.
 *
 *  Parallels `shouldDispatchEnrichment` (same owner/dataset gate, same
 *  touched-path union over `commits[]` + `head_commit`), but:
 *    - fires ONLY on `refs/heads/main` -- the Zarr copy is latest-only and
 *      tracks main's HEAD; data lands on main after a PR merge. Release-branch
 *      and tag pushes don't carry merged data.
 *    - matches a recording data file / companion / `_events.tsv` instead of the
 *      README/dataset_description enrichment paths.
 *
 *  Returns no file list: the workflow self-diffs HEAD against the last-converted
 *  commit recorded in `index.json`, so a giant PR can't overflow the dispatch
 *  payload and a missed delivery self-heals on the next data push. Exported for
 *  unit testing -- keep pure (no env, no I/O). */
export function shouldDispatchZarr(
  event: PushEventPayload,
): { dispatch: false; reason: string } | { dispatch: true; datasetId: string; ref: string } {
  if (event.deleted) return { dispatch: false, reason: "branch_deleted" };

  const owner = event.repository?.owner?.login;
  if (owner !== "nemarDatasets") {
    return { dispatch: false, reason: "wrong_owner" };
  }

  const datasetId = event.repository?.name;
  if (!datasetId || !isValidDatasetId(datasetId)) {
    return { dispatch: false, reason: "not_a_dataset_repo" };
  }

  if (event.ref !== "refs/heads/main") {
    return { dispatch: false, reason: "ref_not_main" };
  }

  const touched = new Set<string>();
  const sources: Array<PushEventCommit | null | undefined> = [
    ...(event.commits ?? []),
    event.head_commit ?? null,
  ];
  for (const c of sources) {
    if (!c) continue;
    for (const p of c.added ?? []) touched.add(p);
    for (const p of c.modified ?? []) touched.add(p);
    for (const p of c.removed ?? []) touched.add(p);
  }
  for (const p of touched) {
    if (isZarrTriggerPath(p)) return { dispatch: true, datasetId, ref: "main" };
  }
  return { dispatch: false, reason: "no_data_or_events_paths_touched" };
}

/**
 * POST /webhooks/github — entry point for GitHub App webhook deliveries.
 *
 * Verifies the HMAC-SHA256 signature in `X-Hub-Signature-256` against
 * `GITHUB_WEBHOOK_SECRET`, then inspects the event. Today we only act on
 * `push` events; other event types respond 200 so we can subscribe to more
 * event types in the App config later without redeploying the Worker.
 *
 * Always responds 200 (or 401 on bad signature) so GitHub doesn't retry on
 * filter-misses. The response body indicates whether a dispatch happened so
 * operators can correlate with GitHub Actions runs.
 *
 * Errors during dispatch (e.g. rate limit, transient 5xx from GitHub) are
 * logged and surfaced in the response body but DO NOT 5xx the webhook — a
 * retried delivery would just duplicate the dispatch attempt, and the App's
 * single-delivery-per-event guarantee plus the workflow's source_hash guard
 * make a missed-dispatch self-heal on the next push.
 */
webhooks.post("/github", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Hub-Signature-256");
  const eventType = c.req.header("X-GitHub-Event");
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "";

  if (!c.env.GITHUB_WEBHOOK_SECRET) {
    console.error("[github-webhook] GITHUB_WEBHOOK_SECRET is unset; rejecting delivery");
    return c.json({ error: "Server misconfigured" }, 500);
  }

  const sigOk = await verifyGitHubWebhookSignature(
    rawBody,
    signature ?? null,
    c.env.GITHUB_WEBHOOK_SECRET,
  );
  if (!sigOk) {
    console.warn(`[github-webhook] invalid signature on delivery ${deliveryId} event=${eventType}`);
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Only `push` is wired today. Other events (pull_request, release, …) land
  // here without action so the App can subscribe to them in advance of any
  // future centralization phase.
  if (eventType !== "push") {
    return c.json({ ok: true, dispatched: false, reason: "event_ignored", event: eventType });
  }

  let payload: PushEventPayload;
  try {
    payload = JSON.parse(rawBody) as PushEventPayload;
  } catch (err) {
    console.warn(
      `[github-webhook] push delivery ${deliveryId} had unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return c.json({ ok: true, dispatched: false, reason: "unparseable_payload" });
  }

  // Evaluate both decision functions. A given push delivery should only
  // match one (branch pushes carry no tag ref; tag pushes carry no branch
  // ref), but evaluating both keeps the handler symmetric for future
  // phases of #601 and makes the response shape stable for observability
  // tooling.
  const enrichmentDecision = shouldDispatchEnrichment(payload);
  const versionDoiDecision = shouldDispatchVersionDoi(payload);
  const zarrDecision = shouldDispatchZarr(payload);

  if (!enrichmentDecision.dispatch && !versionDoiDecision.dispatch && !zarrDecision.dispatch) {
    // Surface whichever reason is more specific. The enrichment path's
    // reasons are richer (no_enrichment_paths_touched, wrong_owner, …)
    // but it bails at `ref_not_main_or_release` for any tag-shaped ref,
    // hiding the more useful `ref_not_version_tag` from version-doi.
    // When enrichment's reason is the generic ref-category bail, prefer
    // version-doi's reason; otherwise keep enrichment's. Code-review #607.
    // (zarr matches a strict subset of enrichment's main-ref pushes, so its
    // reason is never the more-specific one here.)
    const reason =
      enrichmentDecision.reason === "ref_not_main_or_release"
        ? versionDoiDecision.reason
        : enrichmentDecision.reason;
    return c.json({ ok: true, dispatched: false, reason });
  }

  const pat = await getDatasetsToken(c.env);
  const dispatched: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  if (enrichmentDecision.dispatch) {
    try {
      await triggerEnrichmentRun(
        enrichmentDecision.datasetId,
        enrichmentDecision.ref,
        enrichmentDecision.force,
        pat,
      );
      console.log(
        `[github-webhook] dispatched run-enrichment for ${enrichmentDecision.datasetId}@${enrichmentDecision.ref} force=${enrichmentDecision.force} delivery=${deliveryId}`,
      );
      dispatched.enrichment = {
        dataset_id: enrichmentDecision.datasetId,
        ref: enrichmentDecision.ref,
        force: enrichmentDecision.force,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[github-webhook] enrichment dispatch failed for ${enrichmentDecision.datasetId}@${enrichmentDecision.ref} delivery=${deliveryId}: ${msg}`,
      );
      errors.enrichment = msg;
    }
  }

  if (versionDoiDecision.dispatch) {
    try {
      await triggerVersionDoiRun(versionDoiDecision.datasetId, versionDoiDecision.tag, pat);
      console.log(
        `[github-webhook] dispatched run-version-doi for ${versionDoiDecision.datasetId}@${versionDoiDecision.tag} delivery=${deliveryId}`,
      );
      dispatched.version_doi = {
        dataset_id: versionDoiDecision.datasetId,
        tag: versionDoiDecision.tag,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[github-webhook] version-doi dispatch failed for ${versionDoiDecision.datasetId}@${versionDoiDecision.tag} delivery=${deliveryId}: ${msg}`,
      );
      errors.version_doi = msg;
    }
  }

  if (zarrDecision.dispatch) {
    // The Hallu cron is the Zarr conversion engine (the GitHub Actions path
    // can't sustain bulk/backfill -- a large dataset stalls past the 120-min
    // cap; epic #684). Auto-dispatch is therefore OFF by default; set
    // ZARR_AUTODISPATCH="true" to re-enable the event-driven Actions path. The
    // run-generate-zarr.yml workflow stays available for manual
    // workflow_dispatch recovery regardless.
    if (c.env.ZARR_AUTODISPATCH !== "true") {
      console.log(
        `[github-webhook] zarr autodispatch off (Hallu cron owns conversion); skipping ${zarrDecision.datasetId}@${zarrDecision.ref} delivery=${deliveryId}`,
      );
    } else {
      try {
        await triggerZarrGeneration(zarrDecision.datasetId, zarrDecision.ref, pat);
        console.log(
          `[github-webhook] dispatched run-generate-zarr for ${zarrDecision.datasetId}@${zarrDecision.ref} delivery=${deliveryId}`,
        );
        dispatched.zarr = { dataset_id: zarrDecision.datasetId, ref: zarrDecision.ref };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[github-webhook] zarr dispatch failed for ${zarrDecision.datasetId}@${zarrDecision.ref} delivery=${deliveryId}: ${msg}`,
        );
        errors.zarr = msg;
      }
    }
  }

  const anyDispatched = Object.keys(dispatched).length > 0;
  const anyErrors = Object.keys(errors).length > 0;
  return c.json({
    ok: true,
    dispatched: anyDispatched,
    ...(anyDispatched ? { runs: dispatched } : {}),
    ...(anyErrors ? { errors } : {}),
  });
});

/**
 * POST /webhooks/zarr-ready — callback from nemarDatasets/.github
 * `run-generate-zarr.yml` once a dataset's Zarr serving copy has been
 * (re)built and synced to `s3://nemar/<id>/zarr/...` (epic #684 / Stream C).
 *
 * Authenticated with the shared `X-Webhook-Token` (NEMAR_WEBHOOK_TOKEN), same
 * as /publish-version-doi. Records the latest-only conversion state on the
 * `datasets` row (status, store count, index ETag, source commit, timestamp)
 * and best-effort purges the small shared cache objects (index.json + each
 * changed store's zarr.json) so the viewer sees added/removed stores promptly;
 * the bulk chunk objects ride the edge TTL + ETag revalidation.
 *
 * Idempotent: replaying a callback re-writes the same row state and re-purges
 * the same URLs (both harmless). Always 200 on a valid token + body so the
 * workflow's fire-and-forget POST doesn't see a retryable error.
 */
interface ZarrReadyBody {
  dataset_id: string;
  status?: "ready" | "failed";
  store_count?: number;
  index_etag?: string;
  commit?: string;
  converted?: string[];
  removed?: string[];
  error?: string;
}

webhooks.post("/zarr-ready", async (c) => {
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
  if (!expectedToken) {
    console.error(
      "[zarr-ready] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
    );
    return c.json({ error: "Invalid webhook token" }, 401);
  }
  if (!token || !timingSafeEqual(token, expectedToken)) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  let body: ZarrReadyBody;
  try {
    body = (await c.req.json()) as ZarrReadyBody;
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (typeof body.dataset_id !== "string" || !isValidDatasetId(body.dataset_id)) {
    return c.json({ error: "dataset_id must be a valid dataset id" }, 400);
  }
  const status = body.status === "failed" ? "failed" : "ready";

  // Persist latest-only conversion state. On failure keep the prior
  // store_count/etag/commit (a failed rebuild shouldn't erase the last good
  // copy's bookkeeping) and only flip the status + stamp converted_at.
  let changed = 0;
  try {
    if (status === "ready") {
      const result = await c.env.DB.prepare(
        `UPDATE datasets
         SET zarr_status = 'ready',
             zarr_converted_at = datetime('now'),
             zarr_store_count = ?,
             zarr_index_etag = ?,
             zarr_source_commit = ?
         WHERE dataset_id = ?`,
      )
        .bind(
          typeof body.store_count === "number" ? body.store_count : null,
          body.index_etag ?? null,
          body.commit ?? null,
          body.dataset_id,
        )
        .run();
      changed = result.meta.changes ?? 0;
    } else {
      const result = await c.env.DB.prepare(
        "UPDATE datasets SET zarr_status = 'failed' WHERE dataset_id = ?",
      )
        .bind(body.dataset_id)
        .run();
      changed = result.meta.changes ?? 0;
    }
  } catch (err) {
    console.error(
      `[zarr-ready] D1 update failed dataset=${body.dataset_id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Failed to record zarr state" }, 500);
  }

  // A callback for a dataset that isn't in D1 (deleted, or never registered)
  // matches zero rows and persists nothing. Surface it as a 404 instead of a
  // 200 that silently drops the state -- mirrors the prescreen-result
  // meta.changes guard. The workflow logs the 404 for an operator to chase.
  if (changed === 0) {
    console.error(`[zarr-ready] UPDATE matched 0 rows dataset=${body.dataset_id} -- not in D1`);
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Best-effort cache purge of the freshness-sensitive shared objects. Wrapped
  // so a malformed `converted` entry (a non-string would make `.trim()` throw)
  // can't break the always-200 contract; purgeCacheUrls itself never throws.
  let purge: Awaited<ReturnType<typeof purgeCacheUrls>> | undefined;
  if (status === "ready") {
    try {
      const targets = zarrPurgeTargets(c.env, body.dataset_id, body.converted ?? []);
      if (targets.length === 0 && !c.env.ZARR_CACHE_BASE_URL) {
        console.warn(
          `[zarr-ready] ZARR_CACHE_BASE_URL unset; cache purge skipped dataset=${body.dataset_id}`,
        );
      }
      purge = await purgeCacheUrls(c.env, targets);
      if (!purge.ok) {
        console.warn(
          `[zarr-ready] cache purge incomplete dataset=${body.dataset_id}: ${purge.detail ?? "unknown"}`,
        );
      }
    } catch (err) {
      console.warn(
        `[zarr-ready] cache purge threw dataset=${body.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log(
    `[zarr-ready] dataset=${body.dataset_id} status=${status} stores=${body.store_count ?? "?"} converted=${body.converted?.length ?? 0} removed=${body.removed?.length ?? 0} purged=${purge?.submitted ?? 0}`,
  );

  return c.json({
    ok: true,
    dataset_id: body.dataset_id,
    status,
    ...(purge ? { cache_purge: { ok: purge.ok, submitted: purge.submitted } } : {}),
  });
});

export default webhooks;
