/**
 * repository_dispatch triggers to the central workflow repo
 * (nemarDatasets/.github): archive/zarr/manifest/version-DOI/enrichment/
 * onboard/BIDS-validation/prescreen runs.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

import { GITHUB_API, VALIDATOR_VERSION } from "./shared";

/**
 * Trigger archive generation via repository_dispatch event.
 *
 * Phase 3 of centralization epic #601 (sub-issue #608): the workflow now
 * lives at `nemarDatasets/.github/.github/workflows/run-generate-archive.yml`
 * and dispatches use the central repo, NOT the dataset repo. The legacy
 * `repo` parameter is preserved in the signature for callsite stability
 * (CLI + admin endpoints pass the dataset repo name); it's no longer used
 * to address the dispatch target, only logged for traceability.
 *
 * client_payload shape stays compatible: `dataset_id`, `version`, `public`.
 * The central workflow mints a per-repo App token scoped to `dataset_id`
 * and checks out the dataset repo at `v$VERSION`.
 */
export async function triggerArchiveGeneration(
  repo: string,
  datasetId: string,
  version: string,
  pat: string,
  options?: { public?: boolean; s3Bucket?: string; callbackBaseUrl?: string },
): Promise<void> {
  // Sanity check the legacy parameter so callsites that still pass the
  // dataset's own repo name don't drift from the dataset_id payload.
  if (repo !== datasetId) {
    console.warn(
      `[generate-archive] repo (${repo}) and datasetId (${datasetId}) differ; dispatching with dataset_id=${datasetId}`,
    );
  }
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "generate-archive",
      client_payload: {
        dataset_id: datasetId,
        version,
        public: options?.public ?? false,
        // Env-awareness (epic #923): the central workflow follows the caller's
        // bucket + callback host instead of hardcoding prod. Omitted (prod
        // default) when unset, so existing prod deliveries are unchanged.
        s3_bucket: options?.s3Bucket,
        callback_base_url: options?.callbackBaseUrl,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger archive generation: HTTP ${response.status} - ${error}`);
  }
}

/** Central tooling repo where the manifest workflow lives. Targeted by
 *  `triggerManifestGeneration` regardless of the dataset's own repo.
 *  Relocated from `nemarOrg/nemar-cli` to `nemarDatasets/.github` (#564)
 *  so Actions minutes bill against the dataset org's Team plan rather
 *  than the constrained Free-plan tooling org. */
export const CENTRAL_WORKFLOW_REPO = "nemarDatasets/.github";

/**
 * Trigger central manifest generation via repository_dispatch on
 * `nemarDatasets/.github` (NOT the individual dataset repo). The workflow
 * checks out the dataset repo's version tag, walks the tree, builds the
 * manifest + summary, uploads both to S3, and then POSTs back to
 * `callback_url`.
 *
 * Mirrors `triggerArchiveGeneration` style for error handling. The `pat`
 * must be an App-installation token (or PAT fallback) authorized on the
 * nemarDatasets org -- use `getDatasetsToken()`.
 *
 * `options.skipCanary` (default false) is the dispatch-path twin of the
 * inline `generateManifest()` `skipGitBackedVerification` option: when
 * the dataset repo is private, raw.githubusercontent.com cannot serve
 * an unauthenticated HEAD, so Stream A's Python workflow disables its
 * git-backed canary verification when this flag is set.
 */
export async function triggerManifestGeneration(
  datasetId: string,
  version: string,
  doi: string | null,
  conceptDoi: string | null,
  callbackToken: string,
  callbackUrl: string,
  pat: string,
  options?: { skipCanary?: boolean; skipCallback?: boolean; s3Bucket?: string },
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "generate-manifest",
      client_payload: {
        dataset_id: datasetId,
        version,
        doi,
        concept_doi: conceptDoi,
        callback_token: callbackToken,
        callback_url: callbackUrl,
        // Env-awareness (epic #923): the central workflow writes to this bucket
        // instead of a hardcoded s3://nemar. Omitted (prod default) when unset.
        // callback_url is already caller-built from API_BASE_URL, so no separate
        // callback_base_url is needed here.
        s3_bucket: options?.s3Bucket,
        skip_canary: options?.skipCanary ?? false,
        // skip_callback=true is for manual backfill — the Worker has no
        // in-flight manifest_jobs row to validate against, so the workflow
        // skips its POST to /webhooks/manifest-ready. The workflow still
        // writes manifest.json + summary.json to S3 normally.
        skip_callback: options?.skipCallback ?? false,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger manifest generation: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Trigger the central version-DOI workflow on `nemarDatasets/.github` via
 * `repository_dispatch[run-version-doi]`. The workflow mints a per-repo App
 * token scoped to `datasetId`, checks out that repo at the tag, refreshes
 * enrichment, POSTs to `/webhooks/publish-version-doi`, and dispatches
 * generate-archive against the target dataset repo. No callback handshake —
 * `/webhooks/publish-version-doi` itself is the round-trip that updates D1
 * (and is idempotent on the version-DOI ledger so a duplicate dispatch
 * during the Phase 2 cutover window is safe).
 *
 * Mirrors `triggerEnrichmentRun` and `triggerManifestGeneration`. The `pat`
 * must carry write access on `nemarDatasets/.github`'s dispatch endpoint —
 * use `getDatasetsToken()`. Phase 2 of epic #601 (sub-issue #606).
 */
export async function triggerVersionDoiRun(
  datasetId: string,
  tag: string,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-version-doi",
      client_payload: {
        dataset_id: datasetId,
        tag,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger version-doi run: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Trigger the central LLM-enrichment workflow on `nemarDatasets/.github` via
 * `repository_dispatch[run-enrichment]`. The workflow mints a per-repo App
 * token scoped to `datasetId`, checks out that repo at `ref`, POSTs to
 * `/webhooks/llm-enrich`, and commits the returned `.nemar/metadata.json`
 * back to the dataset repo. No callback handshake — the workflow's POST to
 * `/webhooks/llm-enrich` IS the round-trip that updates D1.
 *
 * Wraps the same dispatch shape as `triggerManifestGeneration`; differs only
 * in the event_type and the (much simpler) client_payload. The `pat` must
 * carry write access on `nemarDatasets/.github`'s dispatch endpoint — use
 * `getDatasetsToken()`.
 *
 * Phase 1 of epic #601 (sub-issue #602). The legacy per-repo
 * `llm-enrichment.yml` is removed in the same PR; existing dataset repos are
 * stripped via `scripts/strip-per-repo-llm-enrichment.ts` as the final
 * cutover step.
 */
export async function triggerEnrichmentRun(
  datasetId: string,
  ref: string,
  force: boolean,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-enrichment",
      client_payload: {
        dataset_id: datasetId,
        ref,
        force,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger enrichment run: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Dispatch the `onboard-openneuro` workflow on `nemarDatasets/.github` to import
 * one or more OpenNeuro datasets (epic #775). Same repository_dispatch shape as
 * `triggerEnrichmentRun`; the workflow's parse-ids reads
 * `client_payload.openneuro_ids`. `pat` must carry dispatch write on
 * `nemarDatasets/.github` -- use `getDatasetsToken()`. `fetchImpl` defaults to
 * the global fetch (injectable for tests).
 */
export async function triggerOpenNeuroOnboard(
  openneuroIds: string,
  pat: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "onboard-openneuro",
      client_payload: { openneuro_ids: openneuroIds },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger OpenNeuro onboard: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Pure builder for the `run-bids-validation` repository_dispatch payload sent to
 * `nemarDatasets/.github`. Mirrors the per-repo shim's dispatch
 * (`getWorkflowTemplates`) so a manual re-validation produces the same central
 * check-run. Extracted as a pure function so the shape is unit-testable without
 * a network call. `pr_number` is empty for branch-level (non-PR) revalidation.
 */
export function buildBidsValidationDispatch(
  datasetId: string,
  headSha: string,
  ref = "main",
): { event_type: string; client_payload: Record<string, string> } {
  return {
    event_type: "run-bids-validation",
    client_payload: {
      dataset_id: datasetId,
      ref,
      head_sha: headSha,
      pr_number: "",
      validator_version: VALIDATOR_VERSION,
    },
  };
}

/**
 * Trigger central BIDS validation on a dataset's branch HEAD by dispatching
 * `run-bids-validation` at `nemarDatasets/.github` (same path the per-repo shim
 * takes). Used by the `revalidate` admin flow to re-post a `Run BIDS Validation`
 * check-run on `main` HEAD when the shim is already deployed (so `ci/sync` is a
 * no-op). `pat` must carry dispatch access on the central repo -- use
 * `getDatasetsToken()`. Mirrors `triggerEnrichmentRun`'s error handling.
 */
export async function triggerBidsValidation(
  datasetId: string,
  headSha: string,
  pat: string,
  ref = "main",
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildBidsValidationDispatch(datasetId, headSha, ref)),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger BIDS validation: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Trigger the publication pre-screen workflow on `nemarDatasets/.github` via
 * `repository_dispatch[run-prescreen]` (issue #666). The workflow mints a
 * per-repo App token, checks out the dataset metadata, runs `claude -p` to
 * judge README / dataset_description / declared-data completeness, opens a
 * GitHub issue on the dataset repo when it blocks, and POSTs a verdict to
 * `callbackUrl` (/webhooks/prescreen-result) carrying `callbackToken`.
 *
 * Mirrors `triggerEnrichmentRun`'s dispatch shape. `pat` must carry write
 * access on the central repo's dispatch endpoint -- use `getDatasetsToken()`.
 */
export async function triggerPrescreenRun(
  datasetId: string,
  ref: string,
  requestId: number,
  callbackToken: string,
  callbackUrl: string,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-prescreen",
      client_payload: {
        dataset_id: datasetId,
        ref,
        request_id: requestId,
        callback_token: callbackToken,
        callback_url: callbackUrl,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger prescreen run: HTTP ${response.status} - ${error}`);
  }
}
