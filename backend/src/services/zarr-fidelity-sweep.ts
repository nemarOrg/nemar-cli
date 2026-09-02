/**
 * Zarr fidelity verification sweep (issue #1068, epic #1181 phase 8).
 *
 * The converter's own `channel_count_mismatch` gate (scripts/zarr/generate_zarr.py)
 * withholds an unfaithful store AT CONVERSION TIME, but nothing re-checks a
 * store already published, and `has_zarr` (dataset-filters.ts) means only
 * "converted" -- not "agrees with the dataset's own BIDS metadata". This
 * sweep is the standing verification gate #1068 asked for: it re-derives
 * ground truth per sampled recording from the dataset's own `channels.tsv`
 * and modality sidecar (`*_eeg.json` / `*_ieeg.json` / `*_meg.json` /
 * `*_emg.json`) and compares it against what the published index.json
 * claims, writing a per-dataset verdict into `sweep_stamps` (ADR 0034/0035
 * -- no new column). `has_zarr` itself is UNCHANGED (dataset-filters.ts);
 * `has_zarr_verified` is the new, stricter filter this sweep feeds.
 *
 * WHY RAW.GITHUBUSERCONTENT.COM, NOT THE GITHUB API. `channels.tsv` and
 * every `*_<modality>.json` sidecar are metadata extensions that ADR 0031
 * guarantees NEVER annex (`*_motion.tsv` is the one exception, irrelevant
 * here) -- they are always plain git blobs. Fetching them by RAW CONTENT URL
 * (`raw.githubusercontent.com/<org>/<repo>/<commit>/<path>`) is therefore
 * sufficient, and is a plain unauthenticated public-CDN GET: no GitHub App
 * installation token, no PAT, no shared API rate limit. It is also the
 * reason candidates are restricted to PUBLIC, ACTIVE datasets (the
 * candidate SQL): a private repo cannot be read anonymously, so verifying
 * one would only ever produce `unverifiable` noise, never a real verdict.
 * That is a materially different exposure than `signal-defaults-sweep.ts`'s
 * `getBidsTreeStats`, which is PROD-ONLY specifically because it spends the
 * shared GitHub App/PAT reading the shared `nemarDatasets` org (see that
 * sweep's cron-wiring comment in index.ts). This sweep touches only S3
 * (the index) and this same public, credential-free content host, so --
 * like `recording-stats-sweep.ts` -- it is safe on the non-production cron.
 *
 * FAIL-OPEN ON THE CANDIDATE ROW, NEVER ON THE VERDICT. A transient infra
 * failure (a thrown S3 fetch, a non-404 sidecar response, a network error,
 * or the fetch budget running out mid-dataset) aborts THAT DATASET's
 * verification for this run: nothing is stamped, the failure is recorded in
 * the run's `errors`, and the row is untouched -- still a candidate next
 * time (see `resolveSidecar`'s tri-state result and its callers). Only a
 * clean, confirmed absence (404 at every nearest-first candidate path) is
 * "no ground truth here", and only a value that actually parsed counts as
 * checked (`sidecar_unparseable`/`store_metadata_invalid` below never
 * silently pass as verified).
 *
 * NEAREST-FIRST, NOT A FULL BIDS-INHERITANCE WALK. generate_zarr.py's own
 * `expected_channel_count_for` / `power_line_frequency_for` resolve the
 * winning sidecar against the repo's COMPLETE HEAD file list (an ancestor
 * directory, most-specific-entities-first). That list isn't available here
 * without either a full git tree walk (the GitHub API exposure this module
 * exists to avoid) or the version manifest (versioned by published tag, not
 * by the store's own `source_commit`). `bidsSidecarCandidates` below is the
 * brief's sanctioned fallback: a small, fixed, nearest-first candidate list
 * (recording directory, session directory, subject directory, dataset
 * root) that covers the placements real BIDS datasets actually use, tried
 * in order and cached per dataset run so a repeated session-/subject-/
 * root-level default costs one fetch each.
 *
 * TWO FETCH BUDGETS. `ZARR_FIDELITY_SWEEP_WIDE_BUDGET` bounds the WHOLE
 * invocation (every index fetch plus every sidecar fetch, across every
 * candidate dataset); once it is spent the batch stops and remaining
 * candidates are left completely untouched (never fetched, never errored --
 * `budget_exhausted` in the result says why `processed` came in low).
 * `ZARR_FIDELITY_MAX_SIDECAR_FETCHES_PER_DATASET` additionally bounds ONE
 * dataset's sidecar fetches so a single pathological dataset (nothing but
 * misses) cannot spend the whole sweep-wide budget by itself. Either budget
 * running out mid-dataset surfaces as the SAME "error" outcome
 * `resolveSidecar` already uses for a real infra failure (reason
 * `budget_exhausted`), which is what aborts that one dataset per the
 * fail-open rule above -- it is never turned into "absent".
 *
 * Modelled on recording-stats-sweep.ts's shape: candidate SQL, a bounded
 * per-invocation cap, three-way per-dataset error handling (throw/d1-error
 * keeps the row a candidate; a real verdict stamps it), and NOTHING else
 * written outside `sweep_stamps`.
 */

import { AwsClient } from "aws4fetch";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import {
  parseChannelsTsv,
  parseRecordingDuration,
  parseSamplingFrequency,
} from "./channel-montage.js";
import { ORG_NAME, sampleEvenly } from "./github.js";
import type { PresignedUrlOptions } from "./s3.js";

/** Per-modality serving-rate cap the converter applies (generate_zarr.py's
 *  `MODALITY_RATES`, mirrored here -- kept in sync deliberately rather than
 *  imported, since this is Python and this is the TypeScript verification
 *  side reading the SAME published fact back out of the index). Keys are
 *  UPPERCASE; lookup trims and uppercases the index's `modality` value
 *  before matching (issue #1068 PR #1203 review, item 8). */
export const ZARR_FIDELITY_MODALITY_RATE_CAPS: Record<string, number> = {
  EEG: 250,
  MEG: 250,
  IEEG: 1000,
  EMG: 1000,
};

/** Bounded sample size (decision 1): every store when the dataset has 40 or
 *  fewer, else 40 spread evenly by path order. */
export const ZARR_FIDELITY_MAX_SAMPLE_STORES = 40;

/** Hard cap on `zarr_verify_examples`: at most this many {path, code}
 *  entries, and the cap below also bounds the serialized byte size. The
 *  total mismatch count (before truncation) is stamped separately as
 *  `zarr_verify_mismatch_count`, so a truncated list never hides how many
 *  mismatches were actually found (PR #1203 review, item 7). */
export const ZARR_FIDELITY_MAX_EXAMPLES = 20;

/** Hard byte cap on the serialized `zarr_verify_examples` JSON array. */
export const ZARR_FIDELITY_MAX_EXAMPLES_BYTES = 4096;

/** Per-dataset sidecar-fetch cap (PR #1203 review, item 3): 40 sampled
 *  stores x 2 files (channels.tsv + one modality sidecar) plus slack for
 *  multi-modality stores and nearest-first misses, so one pathological
 *  dataset cannot spend the whole sweep-wide budget below by itself. */
export const ZARR_FIDELITY_MAX_SIDECAR_FETCHES_PER_DATASET = 90;

/** Sweep-wide fetch budget (PR #1203 review, item 3): every index fetch
 *  plus every sidecar fetch, summed across the WHOLE invocation. Once
 *  spent, `runZarrFidelitySweep` stops the batch -- remaining candidates
 *  are left completely untouched, not errored, not stamped. */
export const ZARR_FIDELITY_SWEEP_WIDE_BUDGET = 600;

/** Default / max datasets per invocation (decision 1; max lowered from 100
 *  to 25 in PR #1203 review, item 3, so one admin call cannot alone spend
 *  the sweep-wide budget across pathological datasets). */
export const ZARR_FIDELITY_SWEEP_DEFAULT = 25;
export const ZARR_FIDELITY_SWEEP_MAX = 25;

const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com";

export type ZarrFidelityVerdict = "verified" | "failed" | "unverifiable";

export interface ZarrFidelityMismatchExample {
  path: string;
  code: "channel_count_mismatch" | "duration_mismatch" | "rate_mismatch";
}

/**
 * Candidates (decision 1, amended by PR #1203 review items 5): converted,
 * PUBLIC, active datasets never verified, OR verified against a commit that
 * is no longer the dataset's current `zarr_source_commit`, OR stamped with
 * a null/unusable commit. The last clause fixes a fossilisation bug the
 * code reviewer reproduced: `zarr_verified_commit` written as JSON `null`
 * (an unverifiable dataset with no fetchable index commit) makes
 * `... != zarr_source_commit` evaluate to SQL NULL forever after, which is
 * never true, so the row could never become a candidate again even once a
 * real commit appeared. `runZarrFidelitySweep` also now stamps `''`
 * instead of `null` for that case (belt and braces -- new writes never
 * reproduce the fossil, and this predicate still catches any that already
 * did or ever do again).
 *
 * `status = 'active' AND visibility = 'public'` (item 5): a private repo
 * cannot be read anonymously via raw.githubusercontent.com, so including
 * one here would only ever manufacture `unverifiable` noise.
 * `github_repo IS NOT NULL` is a defensive narrowing beyond the brief's
 * literal predicate (not a change to it): a row with no repo has nothing
 * this sweep could ever fetch a sidecar from.
 */
export const ZARR_FIDELITY_SWEEP_CANDIDATE_SQL = `SELECT dataset_id, github_repo FROM datasets
   WHERE status = 'active'
     AND visibility = 'public'
     AND zarr_status = 'ready'
     AND zarr_store_count > 0
     AND github_repo IS NOT NULL
     AND (
       json_extract(sweep_stamps, '$.zarr_verified_at') IS NULL
       OR json_extract(sweep_stamps, '$.zarr_verified_commit') IS NULL
       OR json_extract(sweep_stamps, '$.zarr_verified_commit') != zarr_source_commit
     )
   ORDER BY dataset_id
   LIMIT ?`;

export const ZARR_FIDELITY_SWEEP_REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets
   WHERE status = 'active'
     AND visibility = 'public'
     AND zarr_status = 'ready'
     AND zarr_store_count > 0
     AND github_repo IS NOT NULL
     AND (
       json_extract(sweep_stamps, '$.zarr_verified_at') IS NULL
       OR json_extract(sweep_stamps, '$.zarr_verified_commit') IS NULL
       OR json_extract(sweep_stamps, '$.zarr_verified_commit') != zarr_source_commit
     )`;

/**
 * The per-candidate stamp write, exported so a test drives the exact SQL
 * text (`.rules/testing.md`: never hand-copy). Writes ONLY `sweep_stamps`
 * (decision 1 / ADR 0034) -- no other `datasets` column changes, on any
 * verdict. `json(?)` wraps the examples parameter so it lands as a nested
 * JSON array, not an escaped string. Bind order: commit (never null --
 * `''` when the index has no usable commit, PR #1203 review item 5),
 * status, examples-json, sampled, checked, checked_channels,
 * checked_duration, checked_rate, unchecked, mismatch_count,
 * examples_truncated (0/1), dataset_id.
 */
export const ZARR_FIDELITY_SWEEP_STAMP_SQL = `UPDATE datasets
   SET sweep_stamps = json_set(
     COALESCE(sweep_stamps, '{}'),
     '$.zarr_verified_at', datetime('now'),
     '$.zarr_verified_commit', ?,
     '$.zarr_verify_status', ?,
     '$.zarr_verify_examples', json(?),
     '$.zarr_verify_sampled', ?,
     '$.zarr_verify_checked', ?,
     '$.zarr_verify_checked_channels', ?,
     '$.zarr_verify_checked_duration', ?,
     '$.zarr_verify_checked_rate', ?,
     '$.zarr_verify_unchecked', ?,
     '$.zarr_verify_mismatch_count', ?,
     '$.zarr_verify_examples_truncated', ?
   )
   WHERE dataset_id = ?`;

/** `PresignedUrlOptions` plus a TEST-ONLY origin override, same idiom as
 *  `zarr-catalog.ts`'s `ZarrCatalogS3Options` -- a test points signing at a
 *  local `Bun.serve()` receiver instead of mocking `fetch`. */
export interface ZarrFidelityS3Options extends PresignedUrlOptions {
  endpointUrl?: string;
}

/** Shape of a single channel-group entry this module reads out of a zarr
 *  index store (biosigIO's `store_metadata` contract, unchanged between
 *  index format v1 and v3 per the phase 7 brief -- only NEW top-level/store
 *  fields were added in v3, so reading only these four keys and ignoring
 *  everything else is tolerant of both, mirroring s3.ts's
 *  `ZarrIndexGroupJson`/`ZarrIndexStoreJson` version-agnostic subset
 *  approach). */
export interface ZarrFidelityGroupJson {
  n_channels?: unknown;
  duration_s?: unknown;
  rate?: unknown;
  modality?: unknown;
}

export interface ZarrFidelityStoreJson {
  path?: unknown;
  zarr?: unknown;
  groups?: unknown;
}

/** Shape of the parsed `<id>/zarr/index.json` this module reads (subset,
 *  v1/v3-tolerant -- see the module doc). */
export interface ZarrFidelityIndexJson {
  source_commit?: unknown;
  store_count?: unknown;
  stores?: unknown;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 40 lowercase hex characters: the phase 7 invariant for a valid, fetchable
 *  git ref. An index whose `source_commit` fails this (absent, empty, or the
 *  pre-phase-7 empty-string bug) has nothing this sweep can check a sample
 *  against. */
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;

/**
 * Nearest-first BIDS sidecar candidate paths for one recording (decision 1's
 * "reuse the existing sidecar resolution helper if one exists, otherwise
 * implement nearest-first resolution" -- see the module doc for why this is
 * a bounded heuristic rather than generate_zarr.py's full HEAD-file-list
 * walk). `suffix` is the sidecar's own trailing name, e.g. `"channels.tsv"`
 * or `"eeg.json"`.
 *
 * Four placements, nearest first, deduplicated (PR #1203 review, item 9):
 *  1. the recording's own directory, full BIDS entities (a per-recording
 *     override);
 *  2. the SESSION directory (`sub-XX/ses-YY/sub-XX_ses-YY_<suffix>`), only
 *     when the recording carries both a `sub-` and a `ses-` entity -- a
 *     session-scoped default lives IN the session directory, never
 *     combined with the subject directory (the earlier, wrong shape this
 *     replaces: `sub-XX/sub-XX_ses-YY_<suffix>` is not a path any BIDS
 *     writer produces);
 *  3. the SUBJECT directory, WITHOUT the session entity
 *     (`sub-XX/sub-XX_<suffix>`) -- a cross-session subject default;
 *  4. the dataset root, bare (the dataset-wide default).
 *
 * Exported for direct unit testing.
 */
export function bidsSidecarCandidates(recordingPath: string, suffix: string): string[] {
  const parts = recordingPath.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return [suffix];

  const filename = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join("/");

  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  // Every underscore-token except the last (the suffix, e.g. "eeg") that
  // looks like a BIDS entity (`key-value`), in filename order.
  const entityTokens = stem
    .split("_")
    .slice(0, -1)
    .filter((t) => t.includes("-"));
  const subjectEntity = entityTokens.find((t) => t.startsWith("sub-")) ?? null;
  const sessionEntity = entityTokens.find((t) => t.startsWith("ses-")) ?? null;

  const subjectDir = parts[0].startsWith("sub-") ? parts[0] : null;
  const sessionDir = subjectDir && parts[1]?.startsWith("ses-") ? `${parts[0]}/${parts[1]}` : null;

  const candidates: string[] = [];
  const add = (candidateDir: string, entities: string[]): void => {
    const name = entities.length > 0 ? `${entities.join("_")}_${suffix}` : suffix;
    const path = candidateDir ? `${candidateDir}/${name}` : name;
    if (!candidates.includes(path)) candidates.push(path);
  };

  add(dir, entityTokens); // 1: recording-level override
  if (sessionDir && subjectEntity && sessionEntity) {
    add(sessionDir, [subjectEntity, sessionEntity]); // 2: session-level default
  }
  if (subjectDir && subjectEntity) {
    add(subjectDir, [subjectEntity]); // 3: subject-level default, no session entity
  }
  add("", []); // 4: dataset-wide default

  return candidates;
}

/**
 * Whether every group's `n_channels` is present and numeric (PR #1203
 * review, item 4). A store with zero groups is vacuously valid (its total
 * is legitimately 0, a real fact to compare against channels.tsv); a store
 * with a group whose `n_channels` is missing or non-numeric cannot be
 * trusted for ANY check (not just the channel count), since the same
 * malformed-metadata condition casts doubt on the rest of that group's
 * fields too -- see `verifyStore`'s `store_metadata_invalid` branch.
 */
export function zarrFidelityStoreMetadataValid(groups: readonly ZarrFidelityGroupJson[]): boolean {
  return groups.every((g) => toFiniteNumber(g.n_channels) !== null);
}

/** Total channels a store serves, summed across its groups -- mirrors
 *  generate_zarr.py's `store_total_channels` exactly (the SAME rule the
 *  converter's own conversion-time gate uses), so a post-hoc disagreement
 *  here reflects real drift, not a differently-derived total. Callers must
 *  check {@link zarrFidelityStoreMetadataValid} first; this assumes every
 *  group's `n_channels` is already known-numeric. */
export function zarrFidelityStoreChannelTotal(groups: readonly ZarrFidelityGroupJson[]): number {
  return groups.reduce((sum, g) => sum + (toFiniteNumber(g.n_channels) ?? 0), 0);
}

/** Longest `duration_s` across a set of groups (MAX within a store, mirroring
 *  s3.ts's `aggregateRecordingStats` rule for the identical shape), or null
 *  when none of them measured a duration. */
export function zarrFidelityStoreDuration(groups: readonly ZarrFidelityGroupJson[]): number | null {
  let max: number | null = null;
  for (const g of groups) {
    const d = toFiniteNumber(g.duration_s);
    if (d === null) continue;
    max = max === null ? d : Math.max(max, d);
  }
  return max;
}

function indexObjectUrl(options: ZarrFidelityS3Options, datasetId: string): string {
  const origin = (
    options.endpointUrl ?? `https://${options.bucket}.s3.${options.region}.amazonaws.com`
  ).replace(/\/+$/, "");
  const key = `${datasetId}/zarr/index.json`;
  const encodedKey = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${origin}/${encodedKey}`;
}

/**
 * Signed GET of a dataset's `index.json`, own implementation rather than
 * `s3.ts`'s `getZarrIndex` (which this module must not edit, and which does
 * not expose the full `stores[]`/`groups[]` shape this sweep needs) --
 * mirrors that function's 404/403-as-absent, other-non-2xx-throws contract.
 * `fetchImpl` is the DI seam a test substitutes with a local receiver.
 */
async function fetchFidelityIndex(
  options: ZarrFidelityS3Options,
  datasetId: string,
  fetchImpl: typeof fetch,
): Promise<ZarrFidelityIndexJson | null> {
  const aws = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
    service: "s3",
  });
  const signed = await aws.sign(indexObjectUrl(options, datasetId), { method: "GET" });
  const response = await fetchImpl(signed);
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(
      `zarr-fidelity-sweep: HTTP ${response.status} fetching index.json for ${datasetId}`,
    );
  }
  return (await response.json()) as ZarrFidelityIndexJson;
}

/** Tri-state result of one candidate-path fetch attempt (PR #1203 review,
 *  item 1): a 404 is the expected "not at this candidate" signal; any other
 *  non-2xx (5xx, 429, ...) or a network throw is an infra ERROR, never
 *  folded into "absent" -- the caller must abort, not guess. */
type SidecarFetchOutcome =
  | { kind: "content"; body: string }
  | { kind: "absent" }
  | { kind: "error"; reason: string };

function rawContentUrl(base: string, repo: string, commit: string, path: string): string {
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${base}/${ORG_NAME}/${repo}/${commit}/${encoded}`;
}

/**
 * One candidate fetch against the public, credential-free content host (see
 * the module doc for why this is dev-safe). Only a 404 is "absent"; a 5xx,
 * a 429, any other non-2xx, or a network throw is `{kind:"error"}` (PR
 * #1203 review, item 1) -- the caller (`resolveSidecar`) must abort that
 * dataset's verification rather than silently treating an infra hiccup as
 * "nothing here".
 */
async function fetchSidecarCandidate(
  base: string,
  repo: string,
  commit: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<SidecarFetchOutcome> {
  const url = rawContentUrl(base, repo, commit, path);
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    return {
      kind: "error",
      reason: `network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (response.status === 404) return { kind: "absent" };
  if (!response.ok) {
    return { kind: "error", reason: `HTTP ${response.status} fetching ${url}` };
  }
  return { kind: "content", body: await response.text() };
}

/** Per-dataset-run resolution state: a content cache (path -> the tri-state
 *  outcome, minus "error" which is never cached -- see `resolveSidecar`)
 *  shared across every sampled store so a session-/subject-/root-level
 *  default is fetched at most once, plus the two fetch budgets (sweep-wide
 *  and per-dataset) and the "already logged this unknown modality" set
 *  (PR #1203 review, item 8). */
interface FidelityRunContext {
  datasetId: string;
  cache: Map<string, { kind: "content"; body: string } | { kind: "absent" }>;
  perDatasetBudget: { remaining: number };
  sweepBudget: { remaining: number };
  githubRawBase: string;
  repo: string;
  commit: string;
  fetchImpl: typeof fetch;
  loggedUnknownModalities: Set<string>;
}

/** Resolution result for one sidecar suffix against one recording: a hit
 *  (with the WINNING candidate path, for logging), a clean absence at every
 *  candidate, or an error that must abort the dataset (PR #1203 review,
 *  item 1). */
type SidecarResolution =
  | { kind: "content"; path: string; body: string }
  | { kind: "absent" }
  | { kind: "error"; reason: string };

async function resolveSidecar(
  ctx: FidelityRunContext,
  recordingPath: string,
  suffix: string,
): Promise<SidecarResolution> {
  for (const candidate of bidsSidecarCandidates(recordingPath, suffix)) {
    const cached = ctx.cache.get(candidate);
    if (cached) {
      if (cached.kind === "content") return { kind: "content", path: candidate, body: cached.body };
      continue; // cached "absent" -- try the next candidate
    }
    if (ctx.sweepBudget.remaining <= 0 || ctx.perDatasetBudget.remaining <= 0) {
      return { kind: "error", reason: "budget_exhausted" };
    }
    ctx.sweepBudget.remaining--;
    ctx.perDatasetBudget.remaining--;
    const outcome = await fetchSidecarCandidate(
      ctx.githubRawBase,
      ctx.repo,
      ctx.commit,
      candidate,
      ctx.fetchImpl,
    );
    if (outcome.kind === "error") return outcome; // never cached; the caller aborts
    ctx.cache.set(candidate, outcome);
    if (outcome.kind === "content") return { kind: "content", path: candidate, body: outcome.body };
  }
  return { kind: "absent" };
}

/**
 * Sample selection (decision 1): every store when the dataset has at most
 * {@link ZARR_FIDELITY_MAX_SAMPLE_STORES}, else that many spread evenly by
 * path order (`sampleEvenly`, reused from bids-tree.ts) plus every store
 * whose group has `n_channels === 1` -- a single-channel recording is the
 * shape most likely to reveal a truncation bug (biosigio#110's own
 * signature, later confirmed genuine for nm000182/nm000183 -- see issue
 * #1068), so it is never left to chance by the even spread. Exported for
 * direct unit testing.
 */
export function zarrFidelitySelectSample(
  stores: readonly ZarrFidelityStoreJson[],
): (ZarrFidelityStoreJson & { path: string })[] {
  const withPath = stores.filter(
    (s): s is ZarrFidelityStoreJson & { path: string } => typeof s.path === "string",
  );
  const sorted = [...withPath].sort((a, b) => a.path.localeCompare(b.path));
  const spread = sampleEvenly(sorted, ZARR_FIDELITY_MAX_SAMPLE_STORES);
  const forced = sorted.filter((s) => {
    const groups = Array.isArray(s.groups) ? (s.groups as ZarrFidelityGroupJson[]) : [];
    return groups.some((g) => toFiniteNumber(g.n_channels) === 1);
  });

  const seen = new Set<string>();
  const sample: (ZarrFidelityStoreJson & { path: string })[] = [];
  for (const s of [...spread, ...forced]) {
    const key = `${s.path}::${typeof s.zarr === "string" ? s.zarr : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sample.push(s);
  }
  return sample;
}

/** Bounded accumulator for mismatch examples (PR #1203 review, item 7):
 *  `count` is the TOTAL number of mismatches found, independent of
 *  truncation, so a truncated `examples` list never hides how many
 *  mismatches were actually found; `truncated` is set the moment either
 *  cap (20 entries, 4 KB serialized) would be exceeded. Exported for
 *  direct unit testing. */
export interface ZarrFidelityMismatchAccumulator {
  examples: ZarrFidelityMismatchExample[];
  count: number;
  truncated: boolean;
}

export function createZarrFidelityMismatchAccumulator(): ZarrFidelityMismatchAccumulator {
  return { examples: [], count: 0, truncated: false };
}

export function recordZarrFidelityMismatch(
  acc: ZarrFidelityMismatchAccumulator,
  entry: ZarrFidelityMismatchExample,
): void {
  acc.count++;
  if (acc.truncated) return;
  if (acc.examples.length >= ZARR_FIDELITY_MAX_EXAMPLES) {
    acc.truncated = true;
    return;
  }
  const candidate = [...acc.examples, entry];
  if (
    new TextEncoder().encode(JSON.stringify(candidate)).length > ZARR_FIDELITY_MAX_EXAMPLES_BYTES
  ) {
    acc.truncated = true;
    return;
  }
  acc.examples.push(entry);
}

/** Per-store verification result (PR #1203 review, items 1, 2, 4): `"ok"`
 *  carries per-CHECK-KIND checked flags (item 2) so a store that merely got
 *  a 200 it could not parse never silently counts as checked; `"invalid"`
 *  is `store_metadata_invalid` (item 4) -- no checks were even attempted;
 *  `"error"` must abort the whole dataset (item 1). */
type StoreVerification =
  | {
      kind: "ok";
      checkedChannels: boolean;
      checkedDuration: boolean;
      checkedRate: boolean;
      mismatches: ZarrFidelityMismatchExample[];
    }
  | { kind: "invalid" }
  | { kind: "error"; reason: string };

function logSidecarUnparseable(ctx: FidelityRunContext, path: string, detail: string): void {
  console.warn(
    `[zarr-fidelity-sweep] sidecar_unparseable dataset=${ctx.datasetId} url=${rawContentUrl(ctx.githubRawBase, ctx.repo, ctx.commit, path)} detail=${detail}`,
  );
}

/**
 * Verify one sampled store against its own ground truth.
 *
 * `store_metadata_invalid` (item 4): a group with a missing/non-numeric
 * `n_channels` makes the WHOLE store unverifiable -- not just the channel
 * check -- because the same malformed field casts doubt on the group
 * array's integrity in general, and the brief is explicit that this must
 * never produce `channel_count_mismatch` or a `failed` verdict.
 *
 * `sidecar_unparseable` (item 2): a reachable (200) body that fails to
 * parse -- `channels.tsv` with no usable data rows, or JSON that does not
 * even parse -- is logged with the resolved URL and contributes nothing
 * checked; it must never read as "verified".
 */
async function verifyStore(
  store: ZarrFidelityStoreJson & { path: string },
  ctx: FidelityRunContext,
): Promise<StoreVerification> {
  const groups = (Array.isArray(store.groups) ? store.groups : []) as ZarrFidelityGroupJson[];

  if (!zarrFidelityStoreMetadataValid(groups)) {
    console.warn(
      `[zarr-fidelity-sweep] store_metadata_invalid dataset=${ctx.datasetId} store=${store.path}`,
    );
    return { kind: "invalid" };
  }

  let checkedChannels = false;
  let checkedDuration = false;
  let checkedRate = false;
  const mismatches: ZarrFidelityMismatchExample[] = [];

  // Channel count: total store channels vs. channels.tsv's data-row count.
  const channelsRes = await resolveSidecar(ctx, store.path, "channels.tsv");
  if (channelsRes.kind === "error") return { kind: "error", reason: channelsRes.reason };
  if (channelsRes.kind === "content") {
    const parsed = parseChannelsTsv(channelsRes.body);
    if (parsed && parsed.count >= 1) {
      checkedChannels = true;
      const total = zarrFidelityStoreChannelTotal(groups);
      if (total < parsed.count) {
        mismatches.push({ path: store.path, code: "channel_count_mismatch" });
      }
    } else {
      logSidecarUnparseable(ctx, channelsRes.path, "channels.tsv has no usable data rows");
    }
  }

  // Duration + rate, resolved once per distinct (trimmed, lowercased)
  // modality among this store's groups (a mixed-modality store is rare,
  // but keeps this correct if one ever exists).
  const byModality = new Map<string, ZarrFidelityGroupJson[]>();
  for (const g of groups) {
    const raw = typeof g.modality === "string" ? g.modality.trim() : "";
    if (!raw) continue;
    const modality = raw.toLowerCase();
    const list = byModality.get(modality) ?? [];
    list.push(g);
    byModality.set(modality, list);
  }

  for (const [modality, modalityGroups] of byModality) {
    const sidecarRes = await resolveSidecar(ctx, store.path, `${modality}.json`);
    if (sidecarRes.kind === "error") return { kind: "error", reason: sidecarRes.reason };
    if (sidecarRes.kind !== "content") continue;

    try {
      JSON.parse(sidecarRes.body);
    } catch {
      logSidecarUnparseable(ctx, sidecarRes.path, "invalid JSON");
      continue;
    }

    const recordingDuration = parseRecordingDuration(sidecarRes.body);
    if (recordingDuration !== null) {
      checkedDuration = true;
      const storeDuration = zarrFidelityStoreDuration(modalityGroups);
      if (storeDuration !== null && Math.abs(storeDuration - recordingDuration) > 1) {
        mismatches.push({ path: store.path, code: "duration_mismatch" });
      }
    }

    const samplingFrequency = parseSamplingFrequency(sidecarRes.body);
    const cap = ZARR_FIDELITY_MODALITY_RATE_CAPS[modality.toUpperCase()];
    if (cap === undefined) {
      // Unknown modality (item 8): log once per DATASET (loggedUnknownModalities
      // is per-dataset-run scoped, unlike the per-store cache), and skip only
      // the rate check -- channel/duration checks above are unaffected.
      if (!ctx.loggedUnknownModalities.has(modality)) {
        ctx.loggedUnknownModalities.add(modality);
        console.warn(
          `[zarr-fidelity-sweep] unknown modality "${modality}" dataset=${ctx.datasetId}; skipping rate check`,
        );
      }
    } else if (samplingFrequency !== null) {
      checkedRate = true;
      const expectedRate = Math.min(samplingFrequency, cap);
      for (const g of modalityGroups) {
        const rate = toFiniteNumber(g.rate);
        if (rate === null) continue;
        if (Math.abs(rate - expectedRate) > 0.5) {
          mismatches.push({ path: store.path, code: "rate_mismatch" });
          break; // one example per store per code is enough
        }
      }
    }
  }

  return { kind: "ok", checkedChannels, checkedDuration, checkedRate, mismatches };
}

interface DatasetVerificationOutcome {
  /** null means "could not even produce a verdict" -- an infra error the
   *  caller should record and leave the row an untouched candidate. */
  status: ZarrFidelityVerdict | null;
  /** Never null when `status` is non-null: `''` when the index has no
   *  usable commit (PR #1203 review, item 5 -- never JSON null, which
   *  fossilises the candidate predicate). */
  commit: string;
  sampled: number;
  checked: number;
  checkedChannels: number;
  checkedDuration: number;
  checkedRate: number;
  unchecked: number;
  examples: ZarrFidelityMismatchExample[];
  mismatchCount: number;
  examplesTruncated: boolean;
  error?: string;
}

async function verifyDataset(
  datasetId: string,
  repo: string,
  s3Options: ZarrFidelityS3Options,
  githubRawBase: string,
  fetchIndexImpl: typeof fetch,
  fetchSidecarImpl: typeof fetch,
  sweepBudget: { remaining: number },
): Promise<DatasetVerificationOutcome> {
  const empty = {
    commit: "",
    sampled: 0,
    checked: 0,
    checkedChannels: 0,
    checkedDuration: 0,
    checkedRate: 0,
    unchecked: 0,
    examples: [],
    mismatchCount: 0,
    examplesTruncated: false,
  };

  if (sweepBudget.remaining <= 0) {
    return { status: null, ...empty, error: "budget_exhausted" };
  }
  sweepBudget.remaining--;

  let index: ZarrFidelityIndexJson | null;
  try {
    index = await fetchFidelityIndex(s3Options, datasetId, fetchIndexImpl);
  } catch (err) {
    return {
      status: null,
      ...empty,
      error: `s3: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!index) {
    return { status: null, ...empty, error: "zarr_status=ready but index.json is absent" };
  }

  const commit =
    typeof index.source_commit === "string" && FULL_COMMIT_RE.test(index.source_commit)
      ? index.source_commit
      : "";
  const stores = (Array.isArray(index.stores) ? index.stores : []) as ZarrFidelityStoreJson[];
  const sample = zarrFidelitySelectSample(stores);

  if (!commit) {
    // No fetchable ref -- ADR 0005: report the gap, don't fake a verdict.
    return { status: "unverifiable", ...empty, sampled: sample.length, unchecked: sample.length };
  }

  const ctx: FidelityRunContext = {
    datasetId,
    cache: new Map(),
    perDatasetBudget: { remaining: ZARR_FIDELITY_MAX_SIDECAR_FETCHES_PER_DATASET },
    sweepBudget,
    githubRawBase,
    repo,
    commit,
    fetchImpl: fetchSidecarImpl,
    loggedUnknownModalities: new Set(),
  };

  let checkedCount = 0;
  let checkedChannelsCount = 0;
  let checkedDurationCount = 0;
  let checkedRateCount = 0;
  const acc = createZarrFidelityMismatchAccumulator();

  for (const store of sample) {
    const result = await verifyStore(store, ctx);
    if (result.kind === "error") {
      return { status: null, ...empty, commit, sampled: sample.length, error: result.reason };
    }
    if (result.kind === "invalid") continue; // unverifiable for this store; not checked
    if (result.checkedChannels) checkedChannelsCount++;
    if (result.checkedDuration) checkedDurationCount++;
    if (result.checkedRate) checkedRateCount++;
    if (result.checkedChannels || result.checkedDuration || result.checkedRate) checkedCount++;
    for (const m of result.mismatches) recordZarrFidelityMismatch(acc, m);
  }

  const status: ZarrFidelityVerdict =
    checkedCount === 0 ? "unverifiable" : acc.count > 0 ? "failed" : "verified";
  return {
    status,
    commit,
    sampled: sample.length,
    checked: checkedCount,
    checkedChannels: checkedChannelsCount,
    checkedDuration: checkedDurationCount,
    checkedRate: checkedRateCount,
    unchecked: sample.length - checkedCount,
    examples: acc.examples,
    mismatchCount: acc.count,
    examplesTruncated: acc.truncated,
  };
}

export interface ZarrFidelityDatasetResult {
  dataset_id: string;
  verdict: ZarrFidelityVerdict;
  sampled: number;
  checked: number;
  checked_channels: number;
  checked_duration: number;
  checked_rate: number;
  unchecked: number;
  examples: ZarrFidelityMismatchExample[];
  mismatch_count: number;
  examples_truncated: boolean;
}

export interface ZarrFidelitySweepResult {
  processed: number;
  verified: number;
  failed: number;
  unverifiable: number;
  /** Per-dataset outcomes for every candidate a verdict was actually reached
   *  for (decision 3: "include the dataset in the sweep's response ... so
   *  the observability dashboard can pick it up"). Datasets that errored
   *  before a verdict was reached are in `errors` instead, not here. */
  results: ZarrFidelityDatasetResult[];
  errors: { dataset_id: string; error: string }[];
  /** Candidates still unverified after this run; null if the count query
   *  failed. */
  remaining: number | null;
  /** True when the sweep-wide fetch budget ran out before every requested
   *  candidate could be attempted (PR #1203 review, item 3): datasets past
   *  this point were never touched at all. */
  budget_exhausted: boolean;
}

/**
 * Run one bounded pass of the zarr fidelity sweep (decision 1): fetch up to
 * `limit` candidates' full index, sample a bounded set of stores, verify
 * each against its own ground truth, and stamp a verdict. Shared by
 * `POST /admin/datasets/zarr-fidelity-sweep` and the daily cron (both prod
 * and non-prod -- see the module doc for why this is dev-safe) so the two
 * callers can never drift.
 *
 * A dataset whose index can't even be fetched (S3 infra error, or
 * `zarr_status='ready'` but index.json absent), or whose sample hits an
 * infra error or a spent fetch budget partway through verification, is
 * recorded in `errors` and left completely untouched -- no stamp write,
 * stays a candidate for the next run (PR #1203 review, item 1).
 *
 * Test-only DI seams (`s3Options.endpointUrl`, `githubRawBase`,
 * `fetchIndexImpl`, `fetchSidecarImpl`, `sweepWideBudget`) mirror
 * `zarr-catalog.ts`'s `endpointUrl` / `runRecordingStatsSweep`'s
 * `fetchIndex` idiom: every real caller omits them, so production always
 * resolves the real S3 host, the real `raw.githubusercontent.com`, and the
 * real {@link ZARR_FIDELITY_SWEEP_WIDE_BUDGET}.
 *
 * Throws only if the candidate query itself fails. Per-dataset failures are
 * collected into `errors`, never thrown.
 */
export async function runZarrFidelitySweep(
  env: Bindings,
  opts?: {
    limit?: number;
    s3Options?: { endpointUrl?: string };
    githubRawBase?: string;
    fetchIndexImpl?: typeof fetch;
    fetchSidecarImpl?: typeof fetch;
    sweepWideBudget?: number;
  },
): Promise<ZarrFidelitySweepResult> {
  const requested = opts?.limit ?? ZARR_FIDELITY_SWEEP_DEFAULT;
  const limit = Math.min(Math.max(requested, 1), ZARR_FIDELITY_SWEEP_MAX);

  const rows = await env.DB.prepare(ZARR_FIDELITY_SWEEP_CANDIDATE_SQL)
    .bind(limit)
    .all<{ dataset_id: string; github_repo: string }>();
  const candidates = rows.results ?? [];

  const s3Options: ZarrFidelityS3Options = {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpointUrl: opts?.s3Options?.endpointUrl,
  };
  const githubRawBase = opts?.githubRawBase ?? GITHUB_RAW_ORIGIN;
  const fetchIndexImpl = opts?.fetchIndexImpl ?? fetch;
  const fetchSidecarImpl = opts?.fetchSidecarImpl ?? fetch;
  const sweepBudget = { remaining: opts?.sweepWideBudget ?? ZARR_FIDELITY_SWEEP_WIDE_BUDGET };

  let verified = 0;
  let failed = 0;
  let unverifiable = 0;
  let budgetExhausted = false;
  const results: ZarrFidelityDatasetResult[] = [];
  const errors: { dataset_id: string; error: string }[] = [];

  for (const { dataset_id, github_repo } of candidates) {
    if (sweepBudget.remaining <= 0) {
      // Sweep-wide budget already spent by an earlier candidate: this and
      // every remaining candidate are left completely untouched (PR #1203
      // review, item 3) -- no error entry, no stamp, no fetch attempted.
      budgetExhausted = true;
      break;
    }

    const repo = github_repo.split("/")[1] ?? github_repo;
    const outcome = await verifyDataset(
      dataset_id,
      repo,
      s3Options,
      githubRawBase,
      fetchIndexImpl,
      fetchSidecarImpl,
      sweepBudget,
    );

    if (outcome.status === null) {
      errors.push({ dataset_id, error: outcome.error ?? "zarr-fidelity-sweep: unknown error" });
      if (outcome.error === "budget_exhausted") budgetExhausted = true;
      continue;
    }

    try {
      await env.DB.prepare(ZARR_FIDELITY_SWEEP_STAMP_SQL)
        .bind(
          outcome.commit,
          outcome.status,
          JSON.stringify(outcome.examples),
          outcome.sampled,
          outcome.checked,
          outcome.checkedChannels,
          outcome.checkedDuration,
          outcome.checkedRate,
          outcome.unchecked,
          outcome.mismatchCount,
          outcome.examplesTruncated ? 1 : 0,
          dataset_id,
        )
        .run();
    } catch (err) {
      errors.push({
        dataset_id,
        error: `d1 write: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (outcome.status === "verified") verified++;
    else if (outcome.status === "failed") failed++;
    else unverifiable++;
    results.push({
      dataset_id,
      verdict: outcome.status,
      sampled: outcome.sampled,
      checked: outcome.checked,
      checked_channels: outcome.checkedChannels,
      checked_duration: outcome.checkedDuration,
      checked_rate: outcome.checkedRate,
      unchecked: outcome.unchecked,
      examples: outcome.examples,
      mismatch_count: outcome.mismatchCount,
      examples_truncated: outcome.examplesTruncated,
    });

    if (outcome.status === "failed") {
      // Escalation (decision 3): audit row + the dataset already rides along
      // in `results` above for the response/cron log line. Best-effort --
      // an audit-write failure must not undo the verdict just stamped.
      try {
        await auditLogStatement(env.DB, {
          userId: null,
          action: "zarr_fidelity_failed",
          resourceType: "dataset",
          resourceId: dataset_id,
          details: JSON.stringify({
            sampled: outcome.sampled,
            checked: outcome.checked,
            mismatch_count: outcome.mismatchCount,
            examples: outcome.examples,
          }),
        }).run();
      } catch (err) {
        console.error(`[zarr-fidelity-sweep] audit log write failed for ${dataset_id}:`, err);
      }
    }
  }

  const remainingRow = await env.DB.prepare(ZARR_FIDELITY_SWEEP_REMAINING_SQL)
    .first<{ n: number }>()
    .catch(() => null);

  return {
    processed: results.length + errors.length,
    verified,
    failed,
    unverifiable,
    results,
    errors,
    remaining: remainingRow?.n ?? null,
    budget_exhausted: budgetExhausted,
  };
}
