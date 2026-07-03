/**
 * The real GitHub webhook: POST /github, HMAC-verified against
 * GITHUB_WEBHOOK_SECRET (a different trust model from the GitHub-Actions
 * callback endpoints in routes/callbacks/, which use bearer or per-job
 * callback tokens).
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { isValidDatasetId } from "../../services/datasetId.js";
import { getDatasetsToken } from "../../services/github-auth.js";
import {
  triggerEnrichmentRun,
  triggerVersionDoiRun,
  triggerZarrGeneration,
} from "../../services/github.js";
import { verifyGitHubWebhookSignature } from "../../services/webhook-signature.js";
import type { WebhookRouter } from "./shared.js";

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

export function registerGithubWebhookRoutes(webhooks: WebhookRouter): void {
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
      console.warn(
        `[github-webhook] invalid signature on delivery ${deliveryId} event=${eventType}`,
      );
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
}
