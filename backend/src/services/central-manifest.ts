/**
 * Central manifest workflow dispatch + central-flow version-DOI mint.
 *
 * Extraction from routes/webhooks.ts, behavior-preserving (#905, epic #902;
 * deferred from #915) — fixes the services -> routes layering violation where
 * publication-orchestrator.ts imported these from routes/webhooks. The bodies
 * are moved verbatim; the only intentional changes are import paths and the
 * `export` keyword on dispatchCentralManifestJob (needed by the version-DOI
 * route handlers that stay in routes/callbacks/version-doi.ts).
 */

import type { Bindings } from "../types/bindings.js";
import { createEzidVersionDoi } from "./doi.js";
import { conceptEzidIdentifier } from "./ezid.js";
import { getDatasetsToken } from "./github-auth.js";
import { signManifestCallbackToken, triggerManifestGeneration } from "./github.js";
import { errorMessage, readRepoMetadata } from "./repo-metadata.js";

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
export async function dispatchCentralManifestJob(
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
  } & (
    | {
        /** Promote an existing `accepted` row (async publish path): UPDATE it to
         *  `dispatched` in place, reusing its nonce so the callback token still
         *  verifies. request_source was already set at accept time. */
        promoteNonce: string;
        requestSource?: never;
      }
    | {
        /** Fresh insert (synchronous callers): INSERT a new `dispatched` row. */
        promoteNonce?: never;
        /** Which version-DOI path owns this row (observability + re-drive
         *  recognition). Recorded in manifest_jobs.request_source. */
        requestSource?: "webhook" | "admin";
      }
  ),
): Promise<{ nonce: string; callbackToken: string }> {
  if (!env.MANIFEST_CALLBACK_SECRET) {
    throw new Error(
      "MANIFEST_CALLBACK_SECRET is unset; refusing to dispatch central manifest workflow",
    );
  }
  const nonce = args.promoteNonce ?? crypto.randomUUID();
  const callbackToken = await signManifestCallbackToken(
    { datasetId: args.datasetId, version: args.version, nonce },
    env.MANIFEST_CALLBACK_SECRET,
  );

  // Persist the dispatched state BEFORE dispatch so a slow GitHub round-trip
  // can't deliver the callback to a missing/un-dispatched row. If dispatch
  // fails below we mark the row as failed for observability.
  if (args.promoteNonce) {
    // Promote the pre-created `accepted` row in place (carries the minted DOI
    // now that the EZID mint has run). manifest-ready filters status='dispatched'.
    const promoted = await env.DB.prepare(
      `UPDATE manifest_jobs
       SET status = 'dispatched', doi = ?, concept_doi = ?, doi_provider = ?
       WHERE dataset_id = ? AND version = ? AND nonce = ? AND status = 'accepted'`,
    )
      .bind(
        args.doi,
        args.conceptDoi,
        args.doiProvider,
        args.datasetId,
        args.version,
        args.promoteNonce,
      )
      .run();
    if (promoted.meta.changes === 0) {
      // The accepted row is gone or already left 'accepted' (cleanup cron, or a
      // re-drive race). Dispatching now would fire a workflow whose callback can
      // never find a 'dispatched' row for this nonce — it would poll forever.
      // Throw so the residual's catch records a terminal `failed` state instead.
      throw new Error(
        `promote matched 0 rows for ${args.datasetId}@${args.version} nonce=${args.promoteNonce}; accepted row missing or already promoted`,
      );
    }
  } else {
    await env.DB.prepare(
      `INSERT INTO manifest_jobs (dataset_id, version, nonce, doi, concept_doi, doi_provider, status, request_source)
       VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?)`,
    )
      .bind(
        args.datasetId,
        args.version,
        nonce,
        args.doi,
        args.conceptDoi,
        args.doiProvider,
        args.requestSource ?? null,
      )
      .run();
  }

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
      { skipCanary: args.skipCanary ?? false, s3Bucket: env.S3_BUCKET },
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

/** Dataset shape needed to mint an EZID version DOI (shared by the webhook
 *  async residual and the admin orchestrator). The concept EZID identifier
 *  is derived from concept_doi (conceptEzidIdentifier, #1182), not stored. */
export interface EzidVersionDoiDataset {
  id: number;
  dataset_id: string;
  name: string;
  github_repo: string | null;
  concept_doi: string | null;
}

/**
 * Shared EZID version-DOI mint core: cheap O(1) metadata read (Contents API),
 * existing-version-DOI lookup for the concept HasVersion set, idempotent EZID
 * mint, and latest_version_doi update. Does NOT insert dataset_versions or
 * generate the manifest — under the central flow `/webhooks/manifest-ready`
 * owns the row insert once the dispatched manifest job uploads to S3.
 */
export async function mintEzidVersionDoi(
  env: Bindings,
  params: {
    dataset: EzidVersionDoiDataset;
    repoName: string;
    version: string;
    sandbox: boolean;
    pat: string;
  },
): Promise<{ doi: string; warnings?: string[] }> {
  const { dataset, repoName, version, sandbox, pat } = params;
  if (!dataset.concept_doi) {
    throw new Error(`Dataset ${dataset.dataset_id} has no EZID identifier`);
  }

  // O(1) metadata read so the mint can't scale with file count (the #751 wall).
  const repoMeta = await readRepoMetadata(repoName, pat, undefined, dataset.name, `v${version}`, {
    useContentsApi: true,
  });
  for (const w of repoMeta.warnings) {
    console.warn("[version-doi]", w);
  }

  const versionRows = await env.DB.prepare("SELECT doi FROM dataset_versions WHERE dataset_id = ?")
    .bind(dataset.dataset_id)
    .all<{ doi: string }>();
  const existingVersionDois = versionRows.results.map((r) => r.doi);

  const result = await createEzidVersionDoi(
    {
      EZID_USERNAME: env.EZID_USERNAME,
      EZID_PASSWORD: env.EZID_PASSWORD,
      EZID_SANDBOX_USERNAME: env.EZID_SANDBOX_USERNAME,
      EZID_SANDBOX_PASSWORD: env.EZID_SANDBOX_PASSWORD,
      // Landing-base resolution for the version DOI _target (epic #923).
      FRONTEND_URL: env.FRONTEND_URL,
      DATASET_LANDING_BASE_URL: env.DATASET_LANDING_BASE_URL,
    },
    {
      datasetId: dataset.dataset_id,
      conceptIdentifier: conceptEzidIdentifier(dataset.concept_doi),
      version,
      bidsDescription: repoMeta.bidsDescription,
      githubRepo: dataset.github_repo || `nemarDatasets/${repoName}`,
      sandbox,
      existingVersionDois,
      enrichment: repoMeta.enrichment,
    },
  );

  await env.DB.prepare(
    "UPDATE datasets SET latest_version_doi = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(result.doi, dataset.id)
    .run();

  return { doi: result.doi, warnings: result.warnings };
}

/**
 * Publish an EZID version DOI via the central manifest flow: mint the DOI then
 * dispatch the central manifest job. Used by the admin orchestrator's
 * version_doi step (#751) so it stops generating the manifest inline (O(files));
 * `/webhooks/manifest-ready` then owns the dataset_versions insert. Synchronous
 * (no accepted-row/poll dance) — the admin orchestrator isn't on a curl budget.
 */
export async function publishEzidVersionDoiViaCentral(
  env: Bindings,
  params: {
    dataset: EzidVersionDoiDataset;
    repoName: string;
    version: string;
    sandbox: boolean;
    pat: string;
    requestSource: "webhook" | "admin";
  },
): Promise<{ doi: string; warnings?: string[] }> {
  const { dataset, repoName, version, sandbox, pat, requestSource } = params;
  const minted = await mintEzidVersionDoi(env, { dataset, repoName, version, sandbox, pat });
  await dispatchCentralManifestJob(env, {
    datasetId: dataset.dataset_id,
    version,
    doi: minted.doi,
    conceptDoi: dataset.concept_doi,
    doiProvider: "ezid",
    skipCanary: true,
    requestSource,
  });
  return minted;
}
