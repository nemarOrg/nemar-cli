/**
 * Webhook routes for GitHub Actions integration
 *
 * These endpoints are called by GitHub Actions workflows
 * and authenticated via a shared secret token.
 */

import type { Context } from "hono";
import { Hono } from "hono";

import { MAX_ARCHIVE_RETRIES, decideArchiveRetry } from "../services/archive-retry.js";
import {
  dispatchCentralManifestJob,
  type EzidVersionDoiDataset,
  isCentralManifestWorkflowEnabled,
  mintEzidVersionDoi,
} from "../services/central-manifest.js";
import { purgeCacheUrls, zarrPurgeTargets } from "../services/cloudflare.js";
import { refreshMetadataAfterVersionDoi } from "../services/dataset-reindex.js";
import { isValidDatasetId } from "../services/datasetId.js";
import { createEzidVersionDoi, parseDoiProvider } from "../services/doi.js";
import { enrichDataset } from "../services/enrich-dataset.js";
import { TEST_SHOULDER } from "../services/ezid.js";
import { getDatasetsToken } from "../services/github-auth.js";
import {
  downloadReleaseArchive,
  triggerArchiveGeneration,
  triggerEnrichmentRun,
  triggerVersionDoiRun,
  triggerZarrGeneration,
  verifyManifestCallbackToken,
  verifyPrescreenCallbackToken,
} from "../services/github.js";
import {
  IMPORT_STATUSES,
  type ImportStatus,
  OPENNEURO_UPSTREAM_MARKER,
  runImportRecovery,
} from "../services/import-recovery.js";
import { generateManifest } from "../services/manifest.js";
import { errorMessage, extractRepoName, readRepoMetadata } from "../services/repo-metadata.js";
import { getDatasetS3Stats, headVersionArtifact, uploadManifest } from "../services/s3.js";
import { verifyGitHubWebhookSignature } from "../services/webhook-signature.js";
import * as zenodo from "../services/zenodo.js";
import type { Bindings } from "../types/bindings.js";

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

const webhooks = new Hono<{ Bindings: Bindings }>();

/**
 * Publish a version DOI for a dataset
 *
 * Called by GitHub Actions when a new release is created.
 * Requires X-Webhook-Token header matching NEMAR_WEBHOOK_TOKEN (falls back
 * to GITHUB_WEBHOOK_SECRET during the secret-untangle rollout — both held
 * the same value historically, see https://docs.nemar.org/admin/github-app-setup/).
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
 * Poll the status of an async version-DOI publish (#751).
 *
 * The run-version-doi.yml "Publish version DOI" step POSTs /publish-version-doi
 * (which returns 202 under the central flow) then polls this endpoint until the
 * latest manifest_jobs row for (dataset_id, version) reaches `ready` (published)
 * or `failed`, instead of holding a 60s synchronous curl. Token-authed the same
 * way as /publish-version-doi.
 */
webhooks.get("/version-doi-status", async (c) => {
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
  if (!expectedToken) {
    console.error(
      "[version-doi-status] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
    );
    return c.json({ error: "Invalid webhook token" }, 401);
  }
  if (!token || !timingSafeEqual(token, expectedToken)) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  const datasetId = c.req.query("dataset_id");
  const rawVersion = c.req.query("version");
  if (!datasetId || !rawVersion) {
    return c.json({ error: "Missing required query params: dataset_id, version" }, 400);
  }
  const version = rawVersion.replace(/^[vV]/, "");

  let job: { status: string; doi: string | null; error_message: string | null } | null;
  try {
    job = await c.env.DB.prepare(
      `SELECT status, doi, error_message FROM manifest_jobs
       WHERE dataset_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(datasetId, version)
      .first<{ status: string; doi: string | null; error_message: string | null }>();
  } catch (dbErr) {
    // Distinguish a DB outage from "no row yet" so the CI log doesn't read a
    // transient D1 failure as a stuck publish. 503 -> the poller keeps retrying.
    console.error(`[version-doi-status] D1 query failed for ${datasetId}@${version}:`, dbErr);
    return c.json({ error: "Database unavailable", details: errorMessage(dbErr) }, 503);
  }

  if (!job) {
    // No row yet (the accepted row insert hasn't landed / replicated) — tell the
    // poller to keep waiting rather than treating absence as terminal.
    return c.json({ dataset_id: datasetId, version, status: "unknown", outcome: "wait" });
  }

  return c.json({
    dataset_id: datasetId,
    version,
    status: job.status,
    outcome: versionDoiPollOutcome(job.status),
    ...(job.doi && { version_doi: job.doi }),
    ...(job.error_message && { error_message: job.error_message }),
  });
});

/**
 * Best-effort Zenodo backup of the release archive. Non-fatal: logs and returns
 * the outcome rather than throwing. `skipOpenNeuro` skips the (O(bytes),
 * impossible-for-large) download for `on`-prefix datasets — the async path
 * passes true; the legacy path passes false to preserve prior behavior.
 */
async function maybeZenodoBackup(
  env: Bindings,
  params: {
    dataset: {
      id: number;
      dataset_id: string;
      name: string;
      github_repo: string | null;
      concept_doi: string | null;
    };
    version: string;
    sandbox: boolean;
    repoName: string;
    pat: string;
    skipOpenNeuro: boolean;
  },
): Promise<{ backup?: string; error?: string }> {
  const { dataset, version, sandbox, repoName, pat, skipOpenNeuro } = params;
  if (skipOpenNeuro && dataset.dataset_id.startsWith("on")) {
    console.info(`[version-doi] Zenodo backup skipped for OpenNeuro dataset ${dataset.dataset_id}`);
    return {};
  }
  let backup: string | undefined;
  let error: string | undefined;
  try {
    const zenodoToken = sandbox ? env.ZENODO_SANDBOX_API_KEY : env.ZENODO_API_KEY;
    if (!zenodoToken) {
      console.info(
        `[version-doi] Zenodo backup skipped for ${dataset.dataset_id}: no ${sandbox ? "sandbox " : ""}API key configured`,
      );
      return {};
    }
    if (!dataset.github_repo) {
      console.info(
        `[version-doi] Zenodo backup skipped for ${dataset.dataset_id}: no GitHub repo configured`,
      );
      return {};
    }
    const tag = `v${version}`;
    const archiveData = await downloadReleaseArchive(repoName, tag, pat);

    // Check if dataset already has a Zenodo backup deposition
    const row = await env.DB.prepare("SELECT zenodo_concept_id FROM datasets WHERE id = ?")
      .bind(dataset.id)
      .first<{ zenodo_concept_id: string | null }>();

    let depositionId = row?.zenodo_concept_id
      ? Number.parseInt(row.zenodo_concept_id, 10)
      : Number.NaN;

    if (Number.isNaN(depositionId)) {
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
      await env.DB.prepare(
        "UPDATE datasets SET zenodo_concept_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
        .bind(String(depositionId), dataset.id)
        .run();
    } else {
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
      backup = `Zenodo draft #${depositionId}`;
    } else {
      console.warn(
        `[version-doi] Zenodo deposition #${depositionId} has no bucket URL; file upload skipped`,
      );
      error = `Zenodo deposition #${depositionId} has no bucket URL`;
    }
  } catch (zenodoErr) {
    error = errorMessage(zenodoErr);
    console.error(
      `[version-doi] Zenodo backup failed for ${dataset.dataset_id}@${version} (non-fatal):`,
      zenodoErr,
    );
  }
  return { backup, error };
}

/** Lifecycle of a manifest_jobs row (migration 0042). `unknown` is the
 *  synthetic status the status endpoint returns when no row exists yet. */
export type ManifestJobStatus = "accepted" | "dispatched" | "ready" | "failed" | "unknown";

/** Idempotency: only short-circuit a duplicate publish while a prior attempt is
 *  still in flight (accepted | dispatched). Terminal states (ready | failed)
 *  allow a deliberate re-drive (e.g. remediation). Pure for testing. */
export function shouldShortCircuitInflightPublish(
  existing: { status: ManifestJobStatus | string } | null,
): boolean {
  return existing != null && (existing.status === "accepted" || existing.status === "dispatched");
}

/** Map a manifest_jobs status to the CI poller's decision. Pure for testing.
 *  `ready` = published (success); `failed` = terminal; everything else
 *  (unknown / accepted / dispatched) = keep polling. */
export function versionDoiPollOutcome(
  status: ManifestJobStatus | string | null | undefined,
): "success" | "fail" | "wait" {
  if (status === "ready") return "success";
  if (status === "failed") return "fail";
  return "wait";
}

/**
 * Handle EZID version DOI creation. Routes to the async (202 + poll) path when
 * the central manifest workflow is enabled, else the legacy synchronous path.
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
  releaseUrl: string,
  sandbox: boolean,
) {
  if (isCentralManifestWorkflowEnabled(c.env)) {
    return handleEzidVersionDoiAsync(c, dataset, version, sandbox);
  }
  return handleEzidVersionDoiLegacy(c, dataset, version, releaseUrl, sandbox);
}

/**
 * Async EZID version-DOI publish (#751): validate cheaply, create an `accepted`
 * manifest_jobs row, return 202, and run the heavy residual (cheap metadata read
 * + idempotent EZID mint + central manifest dispatch + Zenodo) off the request
 * path via waitUntil. The CI workflow polls /webhooks/version-doi-status until
 * ready/failed instead of holding the publish on a 60s curl.
 */
async function handleEzidVersionDoiAsync(
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
  sandbox: boolean,
) {
  if (!dataset.ezid_identifier) {
    return c.json({ error: "No EZID identifier found for this dataset.", skipped: true }, 200);
  }
  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }
  const repoName = extractRepoName(dataset.github_repo);
  if (!repoName) {
    return c.json({ error: "Invalid github_repo format" }, 400);
  }
  if (!c.env.MANIFEST_CALLBACK_SECRET) {
    console.error(
      "[publish-version-doi] MANIFEST_CALLBACK_SECRET unset; cannot run central version-DOI flow",
    );
    return c.json({ error: "Server misconfigured: MANIFEST_CALLBACK_SECRET unset" }, 500);
  }

  // Idempotency: don't start a second publish while one is in flight.
  const inflight = await c.env.DB.prepare(
    `SELECT id, status FROM manifest_jobs
     WHERE dataset_id = ? AND version = ? AND status IN ('accepted', 'dispatched')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(dataset.dataset_id, version)
    .first<{ id: number; status: string }>();
  if (shouldShortCircuitInflightPublish(inflight)) {
    return c.json(
      { accepted: true, status: inflight?.status, version, note: "publish already in flight" },
      202,
    );
  }

  // Durable handle for the 202: poll + failure paths need a row immediately.
  const nonce = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO manifest_jobs (dataset_id, version, nonce, doi, concept_doi, doi_provider, status, request_source)
       VALUES (?, ?, ?, NULL, ?, 'ezid', 'accepted', 'webhook')`,
    )
      .bind(dataset.dataset_id, version, nonce, dataset.concept_doi)
      .run();
  } catch (err) {
    console.error(
      `[publish-version-doi] failed to create accepted job row for ${dataset.dataset_id}@${version}:`,
      err,
    );
    return c.json(
      { error: "Failed to enqueue version DOI publish", details: errorMessage(err) },
      500,
    );
  }

  c.executionCtx.waitUntil(
    runEzidVersionDoiResidual(c.env, { dataset, version, sandbox, repoName, nonce }).catch(
      async (err) => {
        // runEzidVersionDoiResidual records failure on the row itself; this is the
        // last-resort guard so an unexpected throw can't reject the waitUntil.
        console.error(
          `[publish-version-doi] residual crashed for ${dataset.dataset_id}@${version}:`,
          err,
        );
        // If the residual's own failed-mark UPDATE also threw, the row is stuck
        // non-terminal (accepted/dispatched) and the poller would wait to its CI
        // timeout. Try once more to record a terminal state. `status != 'ready'`
        // guards against clobbering a row that succeeded between throw and catch.
        try {
          await c.env.DB.prepare(
            `UPDATE manifest_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now')
             WHERE dataset_id = ? AND version = ? AND nonce = ? AND status != 'ready'`,
          )
            .bind(errorMessage(err), dataset.dataset_id, version, nonce)
            .run();
        } catch (d1Err) {
          console.error(
            `[publish-version-doi] last-resort failed-mark also failed for ${dataset.dataset_id}@${version}:`,
            d1Err,
          );
        }
      },
    ),
  );

  return c.json(
    {
      accepted: true,
      status: "accepted",
      version,
      message: "Version DOI publish accepted; poll /webhooks/version-doi-status",
    },
    202,
  );
}

/**
 * The heavy residual of the async EZID publish, run via waitUntil. On any
 * failure it records `failed` + error_message on the accepted row so the CI
 * poller sees a terminal state instead of polling to timeout.
 */
async function runEzidVersionDoiResidual(
  env: Bindings,
  params: {
    dataset: EzidVersionDoiDataset;
    version: string;
    sandbox: boolean;
    repoName: string;
    nonce: string;
  },
): Promise<void> {
  const { dataset, version, sandbox, repoName, nonce } = params;
  try {
    const pat = await getDatasetsToken(env);
    const minted = await mintEzidVersionDoi(env, { dataset, repoName, version, sandbox, pat });

    // Promote the accepted row -> dispatched and trigger the central manifest
    // workflow. manifest-ready inserts the dataset_versions row + flips the data
    // plane to published once the manifest lands on S3.
    await dispatchCentralManifestJob(env, {
      datasetId: dataset.dataset_id,
      version,
      doi: minted.doi,
      conceptDoi: dataset.concept_doi,
      doiProvider: "ezid",
      skipCanary: true,
      // request_source was set to 'webhook' on the accepted row at accept time.
      promoteNonce: nonce,
    });

    // Non-fatal backup; OpenNeuro skipped (O(bytes); Phase 3 archive policy).
    await maybeZenodoBackup(env, { dataset, version, sandbox, repoName, pat, skipOpenNeuro: true });
  } catch (err) {
    const msg = errorMessage(err);
    console.error(
      `[publish-version-doi] residual failed for ${dataset.dataset_id}@${version}:`,
      err,
    );
    try {
      await env.DB.prepare(
        `UPDATE manifest_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now')
         WHERE dataset_id = ? AND version = ? AND nonce = ?`,
      )
        .bind(msg, dataset.dataset_id, version, nonce)
        .run();
    } catch (d1Err) {
      console.error(
        `[publish-version-doi] failed to mark job failed for ${dataset.dataset_id}@${version}:`,
        d1Err,
      );
    }
  }
}

/**
 * LEGACY synchronous EZID version-DOI path (used when the central manifest
 * workflow is disabled, e.g. prod before the #751 cutover): reads BIDS metadata
 * via the full repo tree, mints the DOI, updates DB, and generates the manifest
 * inline. Retained unchanged for the pre-cutover env; removable after the prod
 * MANIFEST_VIA_CENTRAL_WORKFLOW flip soaks.
 */
async function handleEzidVersionDoiLegacy(
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

    // Upload archive to Zenodo as draft backup (non-fatal). Shared with the
    // async path; skipOpenNeuro=false preserves the legacy "backup all" behavior.
    const { backup: zenodoBackup, error: zenodoBackupError } = await maybeZenodoBackup(c.env, {
      dataset,
      version,
      sandbox,
      repoName,
      pat,
      skipOpenNeuro: false,
    });

    // Sync to nemar.org in the background (non-fatal, non-blocking).
    // Refresh D1 metadata columns from the new version's tree (the legacy
    // nemar.org datapipeline sync was removed in epic #837). Background +
    // non-fatal. Under centralFlow the dataset_versions row doesn't exist yet
    // here -- the /webhooks/manifest-ready handler triggers the refresh after
    // the row insert lands.
    if (!centralFlow) {
      c.executionCtx.waitUntil(refreshMetadataAfterVersionDoi(c.env, dataset.dataset_id, version));
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

    // Refresh D1 metadata columns from the new version's tree (the legacy
    // nemar.org datapipeline sync was removed in epic #837). Background +
    // non-fatal. Under centralFlow the dataset_versions row doesn't exist yet
    // here -- manifest-ready triggers the refresh after the row insert lands.
    if (!centralFlow) {
      c.executionCtx.waitUntil(refreshMetadataAfterVersionDoi(c.env, dataset.dataset_id, version));
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

  // Issue #557: under centralFlow the dataset_versions row + manifest/summary
  // on S3 don't exist when the DOI is minted, so refresh the D1 metadata
  // columns HERE, after the row insert lands. (The legacy nemar.org sync was
  // removed in epic #837.) Background + non-fatal.
  if (job.doi) {
    // Pass body.version so the per-version HED row (#869) is written for exactly
    // this just-published version, not just the latest-by-created_at fallback.
    c.executionCtx.waitUntil(refreshMetadataAfterVersionDoi(c.env, body.dataset_id, body.version));
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
  if (b.issue_url !== undefined && b.issue_url !== null && typeof b.issue_url !== "string") {
    return "issue_url must be a string";
  }
  return null;
}

/**
 * Combine the `claude -p` verdict with an independent server-side S3 check.
 * The workflow judges README/metadata/declared-data quality; the Worker has
 * the AWS credentials and is the source of truth for whether the data blobs
 * actually landed. The S3 check is therefore authoritative on the DATA
 * question in BOTH directions:
 *   - empty objects/ prefix -> add a "missing data" block (catches a workflow
 *     that passed but the blobs never uploaded);
 *   - real blobs present -> a "no real data / too small" verdict was a false
 *     negative (e.g. the workflow's git-tree heuristic was annex-blind for
 *     symlink-stored annex content, #753), so strip the data-shortage reasons
 *     and, if that was the ONLY reason to block, downgrade to pass.
 * Non-data reasons (missing README / Name / Authors) the Worker cannot judge,
 * so they always stand. `objectCount` is `undefined` when the page-count cap
 * was hit (i.e. *many* objects), which is emphatically data-present. An S3
 * read error yields `s3 = null` so infra blips never flip the verdict either
 * way. Pure function: no I/O, fully testable.
 */
export interface PrescreenS3Presence {
  totalSize: number;
  objectCount: number | undefined;
}

/**
 * A pre-screen block reason the authoritative S3 data check can refute. Covers
 * the workflow's data-shortage phrasings ("no real data", "too small",
 * "0 annexed files", "binary data ... not found") plus the synthetic storage
 * reason this function adds on an empty prefix.
 */
export function isDataShortageReason(reason: string): boolean {
  // Whole-word `annex`/`0 ... files` (not bare substrings) so a non-data block
  // reason that merely contains those letters isn't silently stripped. `s3` is
  // word-bounded for the same reason. No bare `storage`: the only storage
  // phrasing is the synthetic reason this module adds in the (mutually
  // exclusive) s3Missing branch, which never reaches the stripping path.
  return /no (real )?data|too small|implausibl|\b0 (annexed |data )?files\b|binary data|\bannexed?\b|\bs3\b/i.test(
    reason,
  );
}

/**
 * Decide whether the pre-screen result should be surfaced as an advisory
 * concern. `flagged` only FLAGS (the screen found a gap) -- it never blocks
 * publication (#756); the handler records it as prescreen_status='concern'. The
 * S3-authority logic is unchanged: storage with real blobs refutes a
 * data-shortage reason (and can clear an all-data-shortage flag), an empty
 * prefix adds one.
 */
export function decidePrescreenOutcome(
  verdict: "pass" | "block",
  reasons: string[],
  s3: PrescreenS3Presence | null,
): { flagged: boolean; reasons: string[] } {
  let out = [...reasons];
  let flagged = verdict === "block";

  const s3Missing = !!s3 && s3.totalSize === 0 && s3.objectCount === 0;
  // objectCount === undefined => first-page cap hit => many objects => present.
  const s3Present = !!s3 && (s3.totalSize > 0 || s3.objectCount === undefined);

  if (s3Present) {
    // Storage confirms real blobs: any data-shortage reason is a false
    // negative. Drop those; keep README/metadata reasons. Clear the flag only
    // when it carried data-shortage reason(s) that ALL got stripped -- never
    // silently clear a reasonless or non-data flag.
    const kept = out.filter((r) => !isDataShortageReason(r));
    if (flagged && kept.length === 0 && out.length > 0) flagged = false;
    out = kept;
  } else if (s3Missing) {
    flagged = true;
    if (!out.some((r) => /no data|\bs3\b|storage/i.test(r))) {
      out.push("No data files were found in storage for this dataset.");
    }
  }

  return { flagged, reasons: out };
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

  const { flagged, reasons } = decidePrescreenOutcome(body.verdict, body.reasons ?? [], s3);
  // Audit the S3 override: if the authoritative S3 check changed the workflow's
  // raw verdict (e.g. cleared an annex-blind false flag, #753), record what was
  // dropped so the change is never silent.
  const effectiveVerdict = flagged ? "block" : "pass";
  if (body.verdict !== effectiveVerdict) {
    const stripped = (body.reasons ?? []).filter((r) => !reasons.includes(r));
    console.log(
      `[prescreen-result] S3 override for ${body.dataset_id}: ${body.verdict} -> ${effectiveVerdict}; stripped=${JSON.stringify(stripped)} s3_size=${s3?.totalSize ?? "unknown"}`,
    );
  }
  // `|| null` (not `?? null`): the advisory workflow sends issue_url="" now, and
  // we want NULL in the column, not an empty string.
  const issueUrl = body.issue_url || null;

  let res: D1Result;
  if (flagged) {
    // Advisory (#756): record the concern but DO NOT block. The request stays in
    // the normal admin-review queue; the concern + reasons are surfaced in the
    // publish-status views. No status flip, no block email, no repo issue (the
    // workflow no longer opens one). Real blockers (BIDS) keep status='blocked'.
    res = await c.env.DB.prepare(
      `UPDATE publication_requests
          SET prescreen_status = 'concern', prescreen_reasons = ?, prescreen_issue_url = ?,
              prescreen_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND prescreen_status = 'pending'`,
    )
      .bind(JSON.stringify(reasons), issueUrl, request.id)
      .run();
  } else {
    res = await c.env.DB.prepare(
      `UPDATE publication_requests
          SET prescreen_status = 'passed', prescreen_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ? AND prescreen_status = 'pending'`,
    )
      .bind(request.id)
      .run();
  }
  if (res.meta.changes === 0) {
    // One-shot guard: the screen was no longer 'pending' (a duplicate/late
    // callback). Harmless, but log so a double-dispatch is explicable.
    console.warn(
      `[prescreen-result] no-op for ${body.dataset_id} request_id=${request.id}: prescreen_status was not 'pending' (duplicate callback?)`,
    );
  }

  console.log(
    `[prescreen-result] dataset=${body.dataset_id} request_id=${request.id} verdict=${body.verdict} prescreen_status=${flagged ? "concern" : "passed"} s3_objects=${s3 ? (s3.objectCount ?? "capped") : "unknown"}`,
  );

  return c.json({
    ok: true,
    dataset_id: body.dataset_id,
    prescreen_status: flagged ? "concern" : "passed",
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

// ============================================================================
// Import state callback (issue #754)
// ============================================================================

export interface ImportStateBody {
  dataset_id: string;
  source: string;
  source_id: string;
  stage: string; // prepare | copy | finalize
  status: string; // one of IMPORT_STATUSES
  error_message?: string;
  workflow_run_url?: string;
  shards_total?: number;
}

/** Validate the onboard-openneuro.yml import-state callback body. */
export function validateImportStateBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.dataset_id !== "string" || !b.dataset_id) {
    return "dataset_id must be a non-empty string";
  }
  if (typeof b.source !== "string" || !b.source) return "source must be a non-empty string";
  if (typeof b.source_id !== "string" || !b.source_id)
    return "source_id must be a non-empty string";
  if (typeof b.stage !== "string" || !b.stage) return "stage must be a non-empty string";
  if (typeof b.status !== "string" || !IMPORT_STATUSES.includes(b.status as ImportStatus)) {
    return `status must be one of: ${IMPORT_STATUSES.join(", ")}`;
  }
  if (b.error_message !== undefined && typeof b.error_message !== "string") {
    return "error_message must be a string";
  }
  if (b.workflow_run_url !== undefined && typeof b.workflow_run_url !== "string") {
    return "workflow_run_url must be a string";
  }
  if (
    b.shards_total !== undefined &&
    (typeof b.shards_total !== "number" || !Number.isInteger(b.shards_total))
  ) {
    return "shards_total must be an integer";
  }
  return null;
}

/**
 * Import-state callback from onboard-openneuro.yml (#754). Bearer-authed with
 * NEMAR_WEBHOOK_TOKEN. Upserts the single import_jobs row per dataset_id. A
 * `preparing` POST unconditionally (re)seeds the row so a re-import after
 * rollback self-heals; every other transition is monotonic and never regresses
 * past a terminal state. On a landed terminal `failed`, the rollback-or-
 * quarantine decision runs in the background (waitUntil) so the callback
 * returns promptly.
 */
webhooks.post("/import-state", async (c) => {
  const token = c.req.header("X-Webhook-Token");
  // Same secret-untangle as /llm-enrich: prefer NEMAR_WEBHOOK_TOKEN, fall back
  // to the historically-shared GITHUB_WEBHOOK_SECRET.
  const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
  if (!expectedToken) {
    console.error(
      "[import-state] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset)",
    );
    return c.json({ error: "Invalid webhook token" }, 401);
  }
  if (!token || !timingSafeEqual(token, expectedToken)) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  let body: ImportStateBody;
  try {
    body = (await c.req.json()) as ImportStateBody;
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  const validationError = validateImportStateBody(body);
  if (validationError) return c.json({ error: validationError }, 400);
  if (!isValidDatasetId(body.dataset_id)) {
    return c.json({ error: `Invalid dataset_id: ${body.dataset_id}` }, 400);
  }

  const status = body.status as ImportStatus;
  const stage = body.stage;
  const runUrl = body.workflow_run_url ?? null;
  const shardsTotal = body.shards_total ?? null;
  const errorMsg = body.error_message ?? null;

  try {
    if (status === "preparing") {
      // A fresh import attempt: unconditionally (re)seed the row, clearing any
      // prior terminal state so a re-import after rollback/quarantine heals.
      await c.env.DB.prepare(
        `INSERT INTO import_jobs
           (dataset_id, source, source_id, stage, status, shards_total, workflow_run_url,
            last_error, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'preparing', ?, ?, NULL, NULL, datetime('now'), datetime('now'))
         ON CONFLICT(dataset_id) DO UPDATE SET
           source = excluded.source, source_id = excluded.source_id,
           stage = excluded.stage, status = 'preparing',
           shards_total = COALESCE(excluded.shards_total, import_jobs.shards_total),
           workflow_run_url = COALESCE(excluded.workflow_run_url, import_jobs.workflow_run_url),
           last_error = NULL, completed_at = NULL, updated_at = datetime('now')`,
      )
        .bind(body.dataset_id, body.source, body.source_id, stage, shardsTotal, runUrl)
        .run();
    } else {
      // Monotonic: `failed` may upgrade an in-flight row; complete/rolled_back/
      // quarantined are sticky (the WHERE refuses a regressing update). The
      // 9th bind feeds the completed_at CASE on a fresh insert.
      await c.env.DB.prepare(
        `INSERT INTO import_jobs
           (dataset_id, source, source_id, stage, status, shards_total, workflow_run_url,
            last_error, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                 CASE WHEN ? IN ('complete','failed','quarantined','rolled_back')
                      THEN datetime('now') ELSE NULL END,
                 datetime('now'), datetime('now'))
         ON CONFLICT(dataset_id) DO UPDATE SET
           stage = excluded.stage, status = excluded.status,
           shards_total = COALESCE(excluded.shards_total, import_jobs.shards_total),
           workflow_run_url = COALESCE(excluded.workflow_run_url, import_jobs.workflow_run_url),
           -- Sticky upstream marker (#808): once a prepare leg records the
           -- OpenNeuro-inaccessible marker, the doomed copy/finalize legs that
           -- still run under \`if: !cancelled()\` MUST NOT clobber it with their
           -- generic terminal error (or the finalizing POST's NULL). classifyRecovery
           -- reads last_error, so keeping the marker guarantees the quarantine is
           -- classified \`upstream_inaccessible\` regardless of POST ordering vs the
           -- async waitUntil recovery. A fresh attempt clears it via the 'preparing'
           -- branch above ([ ] are literal in SQLite LIKE, not wildcards).
           last_error = CASE
             WHEN import_jobs.last_error LIKE '%${OPENNEURO_UPSTREAM_MARKER}%'
                  AND COALESCE(excluded.last_error, '') NOT LIKE '%${OPENNEURO_UPSTREAM_MARKER}%'
             THEN import_jobs.last_error
             ELSE excluded.last_error END,
           completed_at = CASE WHEN excluded.status IN ('complete','failed','quarantined','rolled_back')
                               THEN datetime('now') ELSE import_jobs.completed_at END,
           updated_at = datetime('now')
         WHERE import_jobs.status NOT IN ('complete','rolled_back','quarantined')`,
      )
        .bind(
          body.dataset_id,
          body.source,
          body.source_id,
          stage,
          status,
          shardsTotal,
          runUrl,
          errorMsg,
          status,
        )
        .run();
    }
  } catch (err) {
    console.error(`[import-state] upsert failed for ${body.dataset_id}:`, err);
    return c.json({ error: "Failed to record import state" }, 500);
  }

  // On a landed terminal failure, run the rollback-or-quarantine decision. Only
  // when the row is actually `failed` now (the monotonic guard may have refused
  // to regress a row that already reached complete).
  if (status === "failed") {
    const cur = await c.env.DB.prepare("SELECT status FROM import_jobs WHERE dataset_id = ?")
      .bind(body.dataset_id)
      .first<{ status: string }>();
    if (cur?.status === "failed") {
      c.executionCtx.waitUntil(
        runImportRecovery(c.env.DB, c.env, body.dataset_id).catch((err) =>
          console.error(`[import-state] recovery failed for ${body.dataset_id}:`, err),
        ),
      );
    }
  }

  console.log(
    `[import-state] dataset=${body.dataset_id} stage=${stage} status=${status}${errorMsg ? ` error=${errorMsg}` : ""}`,
  );
  return c.json({ ok: true, dataset_id: body.dataset_id, status });
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
interface ZarrDataFailure {
  path?: string;
  code?: string;
  reason?: string;
}

interface ZarrReadyBody {
  dataset_id: string;
  // 'converting' is the live in-progress signal the Hallu driver POSTs when it
  // starts a dataset, so the dashboard's "Processing" tile reflects conversions
  // actually running (the cron has no Actions dispatch to set it). 'ready' /
  // 'failed' are the terminal outcomes. See #774.
  status?: "ready" | "failed" | "converting";
  store_count?: number;
  index_etag?: string;
  commit?: string;
  converted?: string[];
  removed?: string[];
  error?: string;
  // Failure detail (#774). The converter now reports these on EVERY callback,
  // including a total failure (status='failed') which previously sent none.
  errors?: number; // recordings that failed this run (0 = clean)
  failed?: string[]; // their source paths
  failure_count?: number; // subset that are TYPED data failures
  data_failures?: ZarrDataFailure[]; // typed failures [{path, code, reason}]
  deterministic?: boolean; // all failures are typed data failures (won't retry)
}

/**
 * Derive the Zarr failure-tracking columns persisted by /webhooks/zarr-ready
 * (#774). A 'ready' run can still be PARTIAL (errors>0 while the index has the
 * stores that converted); a 'failed' run is a total failure. `hadErrors` drives
 * `zarr_failed_at`, so a clean run clears the failure detail and the dashboard
 * can sort/filter recent failures. Defensive against missing/garbage fields so
 * the always-200 callback contract holds.
 */
export function zarrFailureColumns(body: {
  errors?: number;
  failure_count?: number;
  deterministic?: boolean;
  data_failures?: unknown;
}): {
  errors: number;
  failureCount: number;
  deterministic: 0 | 1;
  dataFailuresJson: string | null;
  hadErrors: boolean;
} {
  const errors =
    typeof body.errors === "number" && Number.isFinite(body.errors)
      ? Math.max(0, Math.trunc(body.errors))
      : 0;
  const dataFailures = Array.isArray(body.data_failures) ? body.data_failures : [];
  const rawFailureCount =
    typeof body.failure_count === "number" && Number.isFinite(body.failure_count)
      ? Math.max(0, Math.trunc(body.failure_count))
      : dataFailures.length;
  // Typed data failures are a SUBSET of total errors; clamp so a converter bug
  // (or a missing failure_count) can never render "3 data failures of 1 error".
  const failureCount = Math.min(rawFailureCount, errors);
  // Store only the known fields, length-capped: the values are display-only on
  // the dashboard and `datasets` is heavily queried, so a malformed/huge
  // data_failures item must not bloat the row's TEXT column.
  const sanitized = dataFailures.map((item) => {
    if (typeof item !== "object" || item === null) return {};
    const i = item as Record<string, unknown>;
    return {
      ...(typeof i.path === "string" ? { path: i.path.slice(0, 512) } : {}),
      ...(typeof i.code === "string" ? { code: i.code.slice(0, 64) } : {}),
      ...(typeof i.reason === "string" ? { reason: i.reason.slice(0, 256) } : {}),
    };
  });
  return {
    errors,
    failureCount,
    deterministic: body.deterministic === true ? 1 : 0,
    dataFailuresJson: sanitized.length > 0 ? JSON.stringify(sanitized) : null,
    hadErrors: errors > 0,
  };
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
  const status =
    body.status === "failed" ? "failed" : body.status === "converting" ? "converting" : "ready";

  // Persist latest-only conversion state. On failure keep the prior
  // store_count/etag/commit (a failed rebuild shouldn't erase the last good
  // copy's bookkeeping) and only flip the status + stamp converted_at.
  // Failure detail for the observability dashboard (#774). Recorded on BOTH
  // terminal branches: a 'ready' run can be partial (some recordings failed) and
  // a 'failed' run is a total failure. `zarr_failed_at` is stamped only when this
  // run had errors, so a clean run clears the detail.
  const f = zarrFailureColumns(body);
  let changed = 0;
  try {
    if (status === "converting") {
      // In-progress signal (#774): the Hallu driver POSTs this when it starts a
      // dataset so the dashboard "Processing" tile reflects live conversions.
      // Mark zarr_status='pending' (the dashboard's processing state) and clear
      // any prior failure detail -- this is a fresh attempt in flight. Leave the
      // last-good store_count/etag/commit untouched. A terminal ready/failed
      // callback overwrites this when the conversion finishes.
      const result = await c.env.DB.prepare(
        `UPDATE datasets
         SET zarr_status = 'pending',
             zarr_errors = NULL,
             zarr_failure_count = NULL,
             zarr_deterministic = NULL,
             zarr_data_failures = NULL,
             zarr_failed_at = NULL
         WHERE dataset_id = ?`,
      )
        .bind(body.dataset_id)
        .run();
      changed = result.meta.changes ?? 0;
    } else if (status === "ready") {
      const result = await c.env.DB.prepare(
        `UPDATE datasets
         SET zarr_status = 'ready',
             zarr_converted_at = datetime('now'),
             zarr_store_count = ?,
             zarr_index_etag = ?,
             zarr_source_commit = ?,
             zarr_errors = ?,
             zarr_failure_count = ?,
             zarr_deterministic = ?,
             zarr_data_failures = ?,
             zarr_failed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
         WHERE dataset_id = ?`,
      )
        .bind(
          typeof body.store_count === "number" ? body.store_count : null,
          body.index_etag ?? null,
          body.commit ?? null,
          f.errors,
          f.failureCount,
          f.deterministic,
          f.dataFailuresJson,
          f.hadErrors ? 1 : 0,
          body.dataset_id,
        )
        .run();
      changed = result.meta.changes ?? 0;
    } else {
      // Record failure for the observability dashboard only -- do NOT auto-retry
      // zarr here. Conversion is owned by the hourly Hallu cron (workflow
      // autodispatch is intentionally off), which re-attempts on its own
      // schedule; many zarr failures are the mixed-rate EDF/BDF reader bug
      // (#737) that a re-dispatch wouldn't fix. This is the deliberate contrast
      // with the archive-ready auto-retry (epic #736, Phase 3 decision). Keep
      // the prior store_count/etag/commit (a failed rebuild shouldn't erase the
      // last good copy's bookkeeping) and only flip status + the failure detail.
      const result = await c.env.DB.prepare(
        `UPDATE datasets
         SET zarr_status = 'failed',
             zarr_errors = ?,
             zarr_failure_count = ?,
             zarr_deterministic = ?,
             zarr_data_failures = ?,
             zarr_failed_at = datetime('now')
         WHERE dataset_id = ?`,
      )
        .bind(f.errors, f.failureCount, f.deterministic, f.dataFailuresJson, body.dataset_id)
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

/**
 * POST /webhooks/archive-ready — callback from nemarDatasets/.github
 * `run-generate-archive.yml` once a dataset's downloadable zip archive has been
 * (re)built and uploaded to `s3://nemar/<id>/archives/v<version>.zip`
 * (epic #695, dashboard.nemar.org/observability).
 *
 * Mirror of /zarr-ready: same shared `X-Webhook-Token` (NEMAR_WEBHOOK_TOKEN)
 * auth, records the latest-only archive state on the `datasets` row. No cache
 * purge: archives are served via a presigned S3 302 with `no-store` (data.ts),
 * so there is no shared edge object to invalidate.
 *
 * Responses: 200 once state is recorded; 400 for a bad body or a missing/unknown
 * `status` (deliberately STRICTER than /zarr-ready -- a missing status must NOT
 * silently mark an archive 'ready', which would poison the dashboard's
 * "% with archive"); 404 when the dataset isn't in D1 (surfaces a stale callback
 * to operators rather than swallowing it).
 *
 * Idempotent: replaying re-writes the same row state.
 */
interface ArchiveReadyBody {
  dataset_id: string;
  status?: "ready" | "failed" | "skipped";
  /** Bytes of the generated zip; persisted to datasets.archive_size on 'ready'. */
  size?: number;
  /** The published version the archive was built for (logged, not stored). */
  version?: string;
  error?: string;
  /** Why archive generation was skipped (status='skipped', #752). Persisted to
   *  datasets.archive_skip_reason; its presence is what marks a dataset
   *  "archive skipped" (archive_status stays NULL). */
  reason?: string;
}

webhooks.post("/archive-ready", async (c) => {
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
  if (!expectedToken) {
    console.error(
      "[archive-ready] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
    );
    return c.json({ error: "Invalid webhook token" }, 401);
  }
  if (!token || !timingSafeEqual(token, expectedToken)) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  let body: ArchiveReadyBody;
  try {
    body = (await c.req.json()) as ArchiveReadyBody;
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (typeof body.dataset_id !== "string" || !isValidDatasetId(body.dataset_id)) {
    return c.json({ error: "dataset_id must be a valid dataset id" }, 400);
  }
  // Require an explicit status: a missing/unknown value must not default to
  // 'ready' (that would mark a failed generation as having an archive).
  if (body.status !== "ready" && body.status !== "failed" && body.status !== "skipped") {
    return c.json({ error: "status must be 'ready', 'failed', or 'skipped'" }, 400);
  }
  const status = body.status;
  if (status === "failed" && body.error) {
    console.error(`[archive-ready] workflow failure dataset=${body.dataset_id}: ${body.error}`);
  }

  // Persist latest-only archive state. On failure keep the prior archive_size
  // (a failed rebuild shouldn't erase the last good zip's size) and only flip
  // the status + stamp checked_at. A 'failed' callback also drives the bounded
  // auto-retry (epic #736, Phase 3): re-dispatch generation while under the cap,
  // counting dispatches in archive_retry_count (reset to 0 on 'ready'). The
  // daily archiveRetrySweep is the backstop. See services/archive-retry.ts.
  let changed = 0;
  let retry: ReturnType<typeof decideArchiveRetry> | null = null;
  try {
    if (status === "ready") {
      const result = await c.env.DB.prepare(
        // Clear archive_skip_reason: a real zip now exists, so a stale skip from
        // an earlier (larger) version must not keep the UI on the direct-download
        // recipe (#752).
        `UPDATE datasets
         SET archive_status = 'ready',
             archive_checked_at = datetime('now'),
             archive_size = ?,
             archive_retry_count = 0,
             archive_skip_reason = NULL
         WHERE dataset_id = ?`,
      )
        .bind(typeof body.size === "number" ? body.size : null, body.dataset_id)
        .run();
      changed = result.meta.changes ?? 0;
    } else if (status === "skipped") {
      // Over the size/file-count policy (#752): the workflow built no zip and
      // steers users to direct download. Record the reason; leave archive_status
      // NULL (skipped is intentional, NOT a failed generation -> no auto-retry).
      // Reset archive_retry_count too (cross-epic with #736): a skip is a clean
      // state transition, so a prior failed-retry history must not block a future
      // auto-retry if the dataset later shrinks and a `failed` arrives.
      const result = await c.env.DB.prepare(
        `UPDATE datasets
         SET archive_skip_reason = ?,
             archive_status = NULL,
             archive_retry_count = 0,
             archive_checked_at = datetime('now')
         WHERE dataset_id = ?`,
      )
        .bind(body.reason ?? "archive skipped (size policy)", body.dataset_id)
        .run();
      changed = result.meta.changes ?? 0;
    } else {
      // Read the current dispatch count to decide whether to re-dispatch. The
      // count is NOT advanced here -- it is incremented only after a successful
      // dispatch (in the waitUntil below), so a failed dispatch can't consume a
      // retry slot. Matches archiveRetrySweep's dispatch-then-increment order.
      const row = await c.env.DB.prepare(
        "SELECT archive_retry_count FROM datasets WHERE dataset_id = ?",
      )
        .bind(body.dataset_id)
        .first<{ archive_retry_count: number }>();
      retry = decideArchiveRetry("failed", row?.archive_retry_count ?? 0, body.version);
      const result = await c.env.DB.prepare(
        `UPDATE datasets
         SET archive_status = 'failed',
             archive_checked_at = datetime('now')
         WHERE dataset_id = ?`,
      )
        .bind(body.dataset_id)
        .run();
      changed = result.meta.changes ?? 0;
    }
  } catch (err) {
    console.error(
      `[archive-ready] D1 update failed dataset=${body.dataset_id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Failed to record archive state" }, 500);
  }

  // A callback for a dataset that isn't in D1 (deleted, or never registered)
  // matches zero rows and persists nothing. Surface it as a 404 instead of a
  // silent 200 -- mirrors the zarr-ready / prescreen-result guards.
  if (changed === 0) {
    console.error(
      `[archive-ready] UPDATE matched 0 rows dataset=${body.dataset_id} status=${status} -- not in D1`,
    );
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Bounded auto-retry: re-dispatch a fresh archive build, fire-and-forget via
  // waitUntil (like the other post-write side-effects in this file) so a slow
  // GitHub /dispatches call can't delay or time out the workflow's callback. The
  // retry-count increment happens HERE, only after a successful dispatch
  // (mirrors archiveRetrySweep) -- a failed dispatch (GitHub 422 / rate-limit)
  // must not consume a retry slot, which would otherwise exhaust the cap without
  // ever running an archive. Phase 2 deletes the partial on failure, so no force.
  if (retry?.retry && body.version) {
    const retryDatasetId = body.dataset_id;
    const retryVersion = body.version;
    const retryAttempt = retry.nextCount;
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const pat = await getDatasetsToken(c.env);
          await triggerArchiveGeneration(retryDatasetId, retryDatasetId, retryVersion, pat);
          await c.env.DB.prepare("UPDATE datasets SET archive_retry_count = ? WHERE dataset_id = ?")
            .bind(retryAttempt, retryDatasetId)
            .run();
          console.log(
            `[archive-ready] auto-retry dispatched dataset=${retryDatasetId} version=${retryVersion} attempt=${retryAttempt}/${MAX_ARCHIVE_RETRIES}`,
          );
        } catch (err) {
          console.error(
            `[archive-ready] auto-retry dispatch failed dataset=${retryDatasetId} (retry slot not consumed):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      })(),
    );
  }

  console.log(
    `[archive-ready] dataset=${body.dataset_id} status=${status} size=${body.size ?? "?"} version=${body.version ?? "?"}${retry ? ` retry=${retry.reason} count=${retry.nextCount}` : ""}`,
  );

  return c.json({ ok: true, dataset_id: body.dataset_id, status });
});

/**
 * POST /webhooks/records-ready — callback from nemarDatasets/.github
 * `generate-records.yml` once a dataset version's records.json has been built and
 * uploaded to `s3://nemar/<id>/version/v<version>-records.json` (epic #736 Phase 5
 * / #742). Until now the workflow was never dispatched on publish and had no
 * callback, so records.json 404'd for every dataset.
 *
 * Mirror of /archive-ready: same `X-Webhook-Token` (NEMAR_WEBHOOK_TOKEN) auth,
 * records the latest-only records state on the `datasets` row. The records.json
 * artifact is served from S3 directly (loadRecords), so this column is
 * observability-only -- no serving dependency, and (unlike archive) no retry.
 *
 * Responses: 200 once state is recorded; 400 for a bad body or missing/unknown
 * `status`; 404 when the dataset isn't in D1. Idempotent.
 */
interface RecordsReadyBody {
  dataset_id: string;
  status?: "ready" | "failed";
  /** The published version the records were built for (logged, not stored). */
  version?: string;
  error?: string;
}

webhooks.post("/records-ready", async (c) => {
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
  if (!expectedToken) {
    console.error(
      "[records-ready] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
    );
    return c.json({ error: "Invalid webhook token" }, 401);
  }
  if (!token || !timingSafeEqual(token, expectedToken)) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  let body: RecordsReadyBody;
  try {
    body = (await c.req.json()) as RecordsReadyBody;
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (typeof body.dataset_id !== "string" || !isValidDatasetId(body.dataset_id)) {
    return c.json({ error: "dataset_id must be a valid dataset id" }, 400);
  }
  // Require an explicit status: a missing/unknown value must not default to
  // 'ready' (that would mark a failed generation as having records).
  if (body.status !== "ready" && body.status !== "failed") {
    return c.json({ error: "status must be 'ready' or 'failed'" }, 400);
  }
  const status = body.status;
  if (status === "failed" && body.error) {
    console.error(`[records-ready] workflow failure dataset=${body.dataset_id}: ${body.error}`);
  }

  let changed = 0;
  try {
    const result = await c.env.DB.prepare(
      "UPDATE datasets SET records_status = ?, records_checked_at = datetime('now') WHERE dataset_id = ?",
    )
      .bind(status, body.dataset_id)
      .run();
    changed = result.meta.changes ?? 0;
  } catch (err) {
    console.error(
      `[records-ready] D1 update failed dataset=${body.dataset_id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Failed to record records state" }, 500);
  }

  // A callback for a dataset that isn't in D1 (deleted, or never registered)
  // matches zero rows; surface it as a 404 rather than a silent 200.
  if (changed === 0) {
    console.error(`[records-ready] UPDATE matched 0 rows dataset=${body.dataset_id} -- not in D1`);
    return c.json({ error: "Dataset not found" }, 404);
  }

  console.log(
    `[records-ready] dataset=${body.dataset_id} status=${status} version=${body.version ?? "?"}`,
  );

  return c.json({ ok: true, dataset_id: body.dataset_id, status });
});

export default webhooks;
