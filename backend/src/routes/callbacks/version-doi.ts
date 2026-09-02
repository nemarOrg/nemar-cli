/**
 * Version-DOI publish callbacks: POST /publish-version-doi (called by the
 * run-version-doi.yml GitHub Actions workflow when a release tag is pushed)
 * and GET /version-doi-status (the workflow's poll loop for the async path).
 * Bearer-token authed (X-Webhook-Token vs NEMAR_WEBHOOK_TOKEN).
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 * The mint/dispatch machinery lives in services/central-manifest.ts.
 */

import {
  type EzidVersionDoiDataset,
  dispatchCentralManifestJob,
  isCentralManifestWorkflowEnabled,
  mintEzidVersionDoi,
} from "../../services/central-manifest.js";
import { refreshMetadataAfterVersionDoi } from "../../services/dataset-reindex.js";
import { createEzidVersionDoi } from "../../services/doi.js";
import { TEST_SHOULDER, conceptEzidIdentifier } from "../../services/ezid.js";
import { getDatasetsToken } from "../../services/github-auth.js";
import { downloadReleaseArchive } from "../../services/github.js";
import { generateManifest } from "../../services/manifest.js";
import { errorMessage, extractRepoName, readRepoMetadata } from "../../services/repo-metadata.js";
import { uploadManifest } from "../../services/s3.js";
import * as zenodo from "../../services/zenodo.js";
import type { Bindings } from "../../types/bindings.js";
import { type WebhookContext, type WebhookRouter, timingSafeEqual } from "../webhooks/shared.js";

export function registerVersionDoiRoutes(webhooks: WebhookRouter): void {
  /**
   * Publish a version DOI for a dataset
   *
   * Called by GitHub Actions when a new release is created.
   * Requires X-Webhook-Token header matching NEMAR_WEBHOOK_TOKEN (falls back
   * to GITHUB_WEBHOOK_SECRET during the secret-untangle rollout — both held
   * the same value historically, see https://docs.nemar.org/admin/github-app-setup/).
   *
   * EZID-only since #1182 (ADR 0007): the doi_provider column is gone.
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
        ezid_status: string | null;
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

    // EZID is the sole provider (ADR 0007); the doi_provider column is gone
    // (#1182) and the identifier derives from concept_doi. The zenodo
    // handler below is unreachable and kept only until the follow-up removes
    // the retired zenodo paths. Auto-detect sandbox from the EZID test
    // shoulder prefix.
    const sandboxPrefix = TEST_SHOULDER.replace(/^doi:/, "").split("/")[0];
    const sandbox = conceptEzidIdentifier(dataset.concept_doi).includes(sandboxPrefix);

    return handleEzidVersionDoi(c, dataset, version, release_url, sandbox);
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
}

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
  },
  version: string,
  sandbox: boolean,
) {
  // The identifier derives from concept_doi (#1182): no concept DOI means
  // no EZID identifier.
  if (!dataset.concept_doi) {
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
  },
  version: string,
  _releaseUrl: string,
  sandbox: boolean,
) {
  // The identifier derives from concept_doi (#1182): no concept DOI means
  // no EZID identifier.
  if (!dataset.concept_doi) {
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
        // Landing-base resolution for the version DOI _target (epic #923).
        FRONTEND_URL: c.env.FRONTEND_URL,
        DATASET_LANDING_BASE_URL: c.env.DATASET_LANDING_BASE_URL,
      },
      {
        datasetId: dataset.dataset_id,
        conceptIdentifier: conceptEzidIdentifier(dataset.concept_doi),
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
          `[webhook][manifest-missing] Central manifest dispatch failed for ${dataset.dataset_id}@${version} (manifest_jobs row marked failed; no dataset_versions row yet, so the daily manifest-sweep cannot see this — re-drive backstop tracked as #1136):`,
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
          `[webhook][manifest-missing] Manifest generation failed for ${dataset.dataset_id}@${version} (legacy inline path: dataset_versions row exists, daily manifest-sweep retries, #1130):`,
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
      // zenodo_latest_version_id was dropped in #1182; nothing to record on
      // the datasets row here any more (this whole handler is unreachable —
      // see the EZID-only routing above).
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
          `[webhook][manifest-missing] Central manifest dispatch failed for ${dataset.dataset_id}@${version} (manifest_jobs row marked failed; no dataset_versions row yet, so the daily manifest-sweep cannot see this — re-drive backstop tracked as #1136):`,
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
          `[webhook][manifest-missing] Manifest generation failed for ${dataset.dataset_id}@${version} (legacy inline path: dataset_versions row exists, daily manifest-sweep retries, #1130):`,
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
