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
 * installation token, no PAT, no shared API rate limit, and it 404s outright
 * for a private repo. That is a materially different exposure than
 * `signal-defaults-sweep.ts`'s `getBidsTreeStats`, which is PROD-ONLY
 * specifically because it spends the shared GitHub App/PAT reading the
 * shared `nemarDatasets` org (see that sweep's cron-wiring comment in
 * index.ts). This sweep touches only S3 (the index) and this same public,
 * credential-free content host, so -- like `recording-stats-sweep.ts` --
 * it is safe on the non-production cron: AGENTS.md's dev-cron fence exists
 * to stop a job from emailing a real user, dispatching GitHub WORK (a
 * mutation, or an authenticated read that spends the shared org's quota)
 * against `nemarDatasets`, or mutating a real DOI/prod-bucket object; this
 * sweep does none of those.
 *
 * NEAREST-FIRST, NOT A FULL BIDS-INHERITANCE WALK. generate_zarr.py's own
 * `expected_channel_count_for` / `power_line_frequency_for` resolve the
 * winning sidecar against the repo's COMPLETE HEAD file list (an ancestor
 * directory, most-specific-entities-first). That list isn't available here
 * without either a full git tree walk (the GitHub API exposure this module
 * exists to avoid) or the version manifest (versioned by published tag, not
 * by the store's own `source_commit`). `bidsSidecarCandidates` below is the
 * brief's sanctioned fallback: a small, fixed, nearest-first candidate list
 * (recording directory, subject directory, dataset root) that covers the
 * placements real BIDS datasets actually use, tried in order and cached per
 * dataset run so repeated subject-/root-level defaults cost one fetch each.
 * `MAX_SIDECAR_FETCHES_PER_DATASET` is a hard safety net on top of that
 * cache so one dataset with nothing but misses can't blow the Worker's
 * subrequest budget.
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
 *  UPPERCASE to match a `group.modality` value uppercased at lookup time. */
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
 *  entries, and the cap below also bounds the serialized byte size. */
export const ZARR_FIDELITY_MAX_EXAMPLES = 20;

/** Hard byte cap on the serialized `zarr_verify_examples` JSON array. */
export const ZARR_FIDELITY_MAX_EXAMPLES_BYTES = 4096;

/** Safety net on top of the per-dataset resolution cache: at most this many
 *  sidecar candidate fetches (across every sampled store) per dataset per
 *  run, so a dataset with nothing but 404s can't consume an unbounded
 *  subrequest budget. Sized generously above the common case (3 candidates
 *  x 2 suffix-kinds x a modest number of distinct directories among the
 *  sample, after subject-/root-level candidates are cached across stores). */
export const ZARR_FIDELITY_MAX_SIDECAR_FETCHES = 150;

/** Default / max datasets per invocation (decision 1). */
export const ZARR_FIDELITY_SWEEP_DEFAULT = 25;
export const ZARR_FIDELITY_SWEEP_MAX = 100;

const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com";

export type ZarrFidelityVerdict = "verified" | "failed" | "unverifiable";

export interface ZarrFidelityMismatchExample {
  path: string;
  code: "channel_count_mismatch" | "duration_mismatch" | "rate_mismatch";
}

/**
 * Candidates (decision 1): converted-with-stores datasets never verified, OR
 * verified against a commit that is no longer the dataset's current
 * `zarr_source_commit` -- a re-conversion re-arms verification. `github_repo
 * IS NOT NULL` is a defensive narrowing beyond the brief's literal predicate
 * (not a change to it): a row with no repo has nothing this sweep could ever
 * fetch a sidecar from, so it would only ever resolve `unverifiable` --
 * excluding it here just avoids wasted candidate slots, same reasoning
 * channel-montage-sweep / signal-defaults-sweep already apply to their own
 * candidate sets.
 */
export const ZARR_FIDELITY_SWEEP_CANDIDATE_SQL = `SELECT dataset_id, github_repo FROM datasets
   WHERE zarr_status = 'ready'
     AND zarr_store_count > 0
     AND github_repo IS NOT NULL
     AND (
       json_extract(sweep_stamps, '$.zarr_verified_at') IS NULL
       OR json_extract(sweep_stamps, '$.zarr_verified_commit') != zarr_source_commit
     )
   ORDER BY dataset_id
   LIMIT ?`;

export const ZARR_FIDELITY_SWEEP_REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets
   WHERE zarr_status = 'ready'
     AND zarr_store_count > 0
     AND github_repo IS NOT NULL
     AND (
       json_extract(sweep_stamps, '$.zarr_verified_at') IS NULL
       OR json_extract(sweep_stamps, '$.zarr_verified_commit') != zarr_source_commit
     )`;

/**
 * The per-candidate stamp write, exported so a test drives the exact SQL
 * text (`.rules/testing.md`: never hand-copy). Writes ONLY `sweep_stamps`
 * (decision 1 / ADR 0034) -- no other `datasets` column changes, on any
 * verdict. `json(?)` wraps the examples parameter so it lands as a nested
 * JSON array, not an escaped string (`json_set(x, '$.k', ?)` with a raw TEXT
 * bind would store the literal characters `[...]`, unreadable by
 * `json_extract('$.k[0]')`). Bind order: commit, status, examples-json,
 * sampled, checked, dataset_id.
 */
export const ZARR_FIDELITY_SWEEP_STAMP_SQL = `UPDATE datasets
   SET sweep_stamps = json_set(
     COALESCE(sweep_stamps, '{}'),
     '$.zarr_verified_at', datetime('now'),
     '$.zarr_verified_commit', ?,
     '$.zarr_verify_status', ?,
     '$.zarr_verify_examples', json(?),
     '$.zarr_verify_sampled', ?,
     '$.zarr_verify_checked', ?
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
 * Three placements, nearest first, deduplicated:
 *  1. the recording's own directory, full BIDS entities (a per-recording
 *     override);
 *  2. the subject directory (session entity included when present), a
 *     dataset's most common "shared default" placement;
 *  3. the dataset root, bare (the dataset-wide default).
 *
 * Exported for direct unit testing.
 */
export function bidsSidecarCandidates(recordingPath: string, suffix: string): string[] {
  const parts = recordingPath.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return [suffix];

  const filename = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join("/");
  const subjectDir = parts[0].startsWith("sub-") ? parts[0] : null;

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

  const candidates: string[] = [];
  const add = (candidateDir: string, entities: string[]): void => {
    const name = entities.length > 0 ? `${entities.join("_")}_${suffix}` : suffix;
    const path = candidateDir ? `${candidateDir}/${name}` : name;
    if (!candidates.includes(path)) candidates.push(path);
  };

  add(dir, entityTokens);
  if (subjectDir) {
    const subjectEntities = [subjectEntity, sessionEntity].filter((e): e is string => e !== null);
    add(subjectDir, subjectEntities);
  }
  add("", []);

  return candidates;
}

/** Total channels a store serves, summed across its groups -- mirrors
 *  generate_zarr.py's `store_total_channels` exactly (the SAME rule the
 *  converter's own conversion-time gate uses), so a post-hoc disagreement
 *  here reflects real drift, not a differently-derived total. */
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

/**
 * One candidate fetch against the public, credential-free content host (see
 * the module doc for why this is dev-safe). A 404 is the expected "not at
 * this candidate" signal; any other non-2xx or network error is logged and
 * treated the same as a miss for resolution purposes -- fail-open, mirroring
 * generate_zarr.py's `expected_channel_count_for`, which turns the gate off
 * for a recording rather than treating an unreadable ground truth as a
 * mismatch.
 */
async function fetchSidecarCandidate(
  base: string,
  repo: string,
  commit: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const url = `${base}/${ORG_NAME}/${repo}/${commit}/${encoded}`;
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    console.warn(
      `[zarr-fidelity-sweep] network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    console.warn(`[zarr-fidelity-sweep] non-2xx ${response.status} fetching ${url}`);
    return null;
  }
  return response.text();
}

/** Per-dataset-run resolution state: a content cache (path -> content, or
 *  null for a confirmed miss) shared across every sampled store so a
 *  subject-/root-level default is fetched at most once, and a hard fetch
 *  budget as the safety net described in the module doc. */
interface FidelityRunContext {
  cache: Map<string, string | null>;
  budget: { remaining: number };
  githubRawBase: string;
  repo: string;
  commit: string;
  fetchImpl: typeof fetch;
}

async function resolveSidecar(
  ctx: FidelityRunContext,
  recordingPath: string,
  suffix: string,
): Promise<{ path: string; content: string } | null> {
  for (const candidate of bidsSidecarCandidates(recordingPath, suffix)) {
    if (ctx.cache.has(candidate)) {
      const cached = ctx.cache.get(candidate) ?? null;
      if (cached !== null) return { path: candidate, content: cached };
      continue;
    }
    if (ctx.budget.remaining <= 0) return null;
    ctx.budget.remaining--;
    const content = await fetchSidecarCandidate(
      ctx.githubRawBase,
      ctx.repo,
      ctx.commit,
      candidate,
      ctx.fetchImpl,
    );
    ctx.cache.set(candidate, content);
    if (content !== null) return { path: candidate, content };
  }
  return null;
}

/**
 * Sample selection (decision 1): every store when the dataset has at most
 * {@link ZARR_FIDELITY_MAX_SAMPLE_STORES}, else that many spread evenly by
 * path order (`sampleEvenly`, reused from bids-tree.ts) plus every store
 * whose group has `n_channels === 1` -- a single-channel recording is the
 * shape most likely to reveal a truncation bug (biosigio#110's own
 * signature), so it is never left to chance by the even spread. Exported
 * for direct unit testing.
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

/**
 * Verify one sampled store against its own ground truth. Returns whether any
 * ground truth was reachable at all (`checked`) and the mismatches found (a
 * store can be `checked` with zero mismatches).
 */
async function verifyStore(
  store: ZarrFidelityStoreJson & { path: string },
  ctx: FidelityRunContext,
): Promise<{ checked: boolean; mismatches: ZarrFidelityMismatchExample[] }> {
  const mismatches: ZarrFidelityMismatchExample[] = [];
  let checked = false;
  const groups = (Array.isArray(store.groups) ? store.groups : []) as ZarrFidelityGroupJson[];

  // Channel count: total store channels vs. channels.tsv's data-row count.
  const channelsHit = await resolveSidecar(ctx, store.path, "channels.tsv");
  if (channelsHit) {
    const parsed = parseChannelsTsv(channelsHit.content);
    if (parsed) {
      checked = true;
      const total = zarrFidelityStoreChannelTotal(groups);
      if (total < parsed.count) {
        mismatches.push({ path: store.path, code: "channel_count_mismatch" });
      }
    }
  }

  // Duration + rate, resolved once per distinct modality among this store's
  // groups (a mixed-modality store is rare, but keeps this correct if one
  // ever exists).
  const byModality = new Map<string, ZarrFidelityGroupJson[]>();
  for (const g of groups) {
    const modality = typeof g.modality === "string" ? g.modality.toLowerCase() : null;
    if (!modality) continue;
    const list = byModality.get(modality) ?? [];
    list.push(g);
    byModality.set(modality, list);
  }

  for (const [modality, modalityGroups] of byModality) {
    const sidecarHit = await resolveSidecar(ctx, store.path, `${modality}.json`);
    if (!sidecarHit) continue;
    checked = true;

    const recordingDuration = parseRecordingDuration(sidecarHit.content);
    if (recordingDuration !== null) {
      const storeDuration = zarrFidelityStoreDuration(modalityGroups);
      if (storeDuration !== null && Math.abs(storeDuration - recordingDuration) > 1) {
        mismatches.push({ path: store.path, code: "duration_mismatch" });
      }
    }

    const samplingFrequency = parseSamplingFrequency(sidecarHit.content);
    const cap = ZARR_FIDELITY_MODALITY_RATE_CAPS[modality.toUpperCase()];
    if (samplingFrequency !== null && cap !== undefined) {
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

  return { checked, mismatches };
}

/** Append to a bounded examples array, respecting both the entry-count cap
 *  and the serialized-byte cap (decision 1: "hard cap 20 entries and 4 KB").
 *  Exported for direct unit testing. */
export function pushZarrFidelityExample(
  examples: ZarrFidelityMismatchExample[],
  entry: ZarrFidelityMismatchExample,
): void {
  if (examples.length >= ZARR_FIDELITY_MAX_EXAMPLES) return;
  const candidate = [...examples, entry];
  const bytes = new TextEncoder().encode(JSON.stringify(candidate)).length;
  if (bytes > ZARR_FIDELITY_MAX_EXAMPLES_BYTES) return;
  examples.push(entry);
}

interface DatasetVerificationOutcome {
  /** null means "could not even produce a verdict" -- an infra error the
   *  caller should record and leave the row an untouched candidate. */
  status: ZarrFidelityVerdict | null;
  commit: string | null;
  sampled: number;
  checked: number;
  examples: ZarrFidelityMismatchExample[];
  error?: string;
}

async function verifyDataset(
  datasetId: string,
  repo: string,
  s3Options: ZarrFidelityS3Options,
  githubRawBase: string,
  fetchIndexImpl: typeof fetch,
  fetchSidecarImpl: typeof fetch,
): Promise<DatasetVerificationOutcome> {
  let index: ZarrFidelityIndexJson | null;
  try {
    index = await fetchFidelityIndex(s3Options, datasetId, fetchIndexImpl);
  } catch (err) {
    return {
      status: null,
      commit: null,
      sampled: 0,
      checked: 0,
      examples: [],
      error: `s3: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!index) {
    return {
      status: null,
      commit: null,
      sampled: 0,
      checked: 0,
      examples: [],
      error: "zarr_status=ready but index.json is absent",
    };
  }

  const commit =
    typeof index.source_commit === "string" && FULL_COMMIT_RE.test(index.source_commit)
      ? index.source_commit
      : null;
  const stores = (Array.isArray(index.stores) ? index.stores : []) as ZarrFidelityStoreJson[];
  const sample = zarrFidelitySelectSample(stores);

  if (!commit) {
    // No fetchable ref -- ADR 0005: report the gap, don't fake a verdict.
    return {
      status: "unverifiable",
      commit: null,
      sampled: sample.length,
      checked: 0,
      examples: [],
    };
  }

  const ctx: FidelityRunContext = {
    cache: new Map(),
    budget: { remaining: ZARR_FIDELITY_MAX_SIDECAR_FETCHES },
    githubRawBase,
    repo,
    commit,
    fetchImpl: fetchSidecarImpl,
  };

  let checkedCount = 0;
  const examples: ZarrFidelityMismatchExample[] = [];
  for (const store of sample) {
    const { checked, mismatches } = await verifyStore(store, ctx);
    if (checked) checkedCount++;
    for (const m of mismatches) pushZarrFidelityExample(examples, m);
  }

  const status: ZarrFidelityVerdict =
    checkedCount === 0 ? "unverifiable" : examples.length > 0 ? "failed" : "verified";
  return { status, commit, sampled: sample.length, checked: checkedCount, examples };
}

export interface ZarrFidelityDatasetResult {
  dataset_id: string;
  verdict: ZarrFidelityVerdict;
  sampled: number;
  checked: number;
  examples: ZarrFidelityMismatchExample[];
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
 * `zarr_status='ready'` but index.json absent) is recorded in `errors` and
 * left completely untouched -- no stamp write, stays a candidate for the
 * next run -- exactly recording-stats-sweep's "throw -> stays a candidate"
 * handling for the identical shape of failure.
 *
 * Test-only DI seams (`s3Options.endpointUrl`, `githubRawBase`,
 * `fetchIndexImpl`, `fetchSidecarImpl`) mirror `zarr-catalog.ts`'s
 * `endpointUrl` / `runRecordingStatsSweep`'s `fetchIndex` idiom: every real
 * caller omits them, so production always resolves the real S3 host and the
 * real `raw.githubusercontent.com`.
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

  let verified = 0;
  let failed = 0;
  let unverifiable = 0;
  const results: ZarrFidelityDatasetResult[] = [];
  const errors: { dataset_id: string; error: string }[] = [];

  for (const { dataset_id, github_repo } of candidates) {
    const repo = github_repo.split("/")[1] ?? github_repo;
    const outcome = await verifyDataset(
      dataset_id,
      repo,
      s3Options,
      githubRawBase,
      fetchIndexImpl,
      fetchSidecarImpl,
    );

    if (outcome.status === null) {
      errors.push({ dataset_id, error: outcome.error ?? "zarr-fidelity-sweep: unknown error" });
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
      examples: outcome.examples,
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
    processed: candidates.length,
    verified,
    failed,
    unverifiable,
    results,
    errors,
    remaining: remainingRow?.n ?? null,
  };
}
