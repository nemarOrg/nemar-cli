/**
 * The Neurobagel writer (epic #1586, phase 4; ADR 0084).
 *
 * For each ELIGIBLE dataset (neurobagel-eligibility.ts: one predicate, decided from
 * the D1 row) it gathers the transform's inputs through the data plane
 * (neurobagel-gather.ts), runs the pure transform (shared/neurobagel), and writes the
 * artifacts, then the index, into the private R2 bucket. A dataset that stops being
 * eligible is dropped from the index and its artifacts are deleted.
 *
 * THIS IS THE ONLY MODULE THAT WRITES THE BUCKET. `put` and `delete` on
 * `env.NEUROBAGEL` appear here and nowhere else; a source scan enforces it. It is
 * also the only module that writes the findings ledger (audit_log), and it sends no
 * mail and dispatches nothing to GitHub: a finding in the anonymity class goes to
 * the audit log and stays there (ADR 0067).
 *
 * ORDERING, for a consumer that may read at any moment (the node's loader):
 *   - an ADDITION or a CHANGE writes its artifacts first, then the index;
 *   - a REMOVAL writes the index first, then deletes the artifacts.
 * A run that does both writes artifacts, then the index (which already omits what is
 * leaving), then deletes. `index.json` is always rebuilt from the bucket LISTING
 * (neurobagel-store.ts), never from what this run remembers, and is replaced only
 * when its entries differ, with a conditional write that loses cleanly to a
 * concurrent run, which then rebuilds.
 *
 * IDEMPOTENT: a second run over unchanged inputs writes NOTHING, to the artifacts or
 * to the index. The fingerprint (neurobagel-fingerprint.ts) is what decides.
 *
 * NEVER A BLOCKER: the hooks (publication, import, a new version) call
 * {@link scheduleNeurobagelSync}, which does nothing at all unless the writer is
 * enabled, runs inside `waitUntil`, and catches everything. The daily reconcile
 * ({@link runNeurobagelReconcileCron}) is the safety net and is production-only.
 *
 * OFF BY DEFAULT: nothing here acts unless `NEUROBAGEL_WRITER_ENABLED` is exactly
 * "1", and with no `NEUROBAGEL` binding the writer is a reported no-op.
 */

import {
  NeurobagelRefusal,
  type NeurobagelReport,
  artifactFileNames,
  buildNeurobagelArtifacts,
} from "../../../shared/neurobagel/index.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { CONCEPT_DOI_SQL } from "./anonymity.js";
import { toVersionTag } from "./data-router.js";
import { isNonProductionEnv, resolveDataBaseOrigin } from "./environment.js";
import { manifestCacheKey } from "./manifest-source.js";
import {
  type CurationResolution,
  type CurationResolver,
  applyCuration,
  defaultCurationResolver,
} from "./neurobagel-curation.js";
import {
  couldBeFederated,
  eligibleAmong,
  federationContext,
  loadEligibleRow,
} from "./neurobagel-eligibility.js";
import { inputFingerprint, rowFingerprint, sha256Hex } from "./neurobagel-fingerprint.js";
import { type GatherDeps, GatherRefusal, gatherNeurobagelInput } from "./neurobagel-gather.js";
import {
  LEDGER_ACTIONS,
  type LedgerEntry,
  type PlanRow,
  currentSignature,
  loadPlanRows,
  planWork,
  readLedger,
  recordLedgerState,
  utcDay,
} from "./neurobagel-plan.js";
import {
  ARTIFACT_CONTENT_TYPE,
  type ArtifactKind,
  META,
  NEUROBAGEL_INDEX_KEY,
  type StoreListing,
  type StoredDataset,
  artifactName,
  buildIndexDocument,
  indexProblems,
  listStore,
  readStoredIndex,
  serializeIndex,
  sha256OfBytes,
} from "./neurobagel-store.js";
import { headManifestObject } from "./s3.js";

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

export type WriterMode = "enabled" | "disabled" | "store_unconfigured";

/**
 * Whether the writer may act. The flag is the switch (exactly "1"; absent or
 * anything else is OFF), checked FIRST so a deployment that does not carry the flag
 * does nothing, whatever else it carries. Then the binding: enabled with no bucket
 * is a reported no-op, never an error that reaches a flow.
 */
export function neurobagelWriterMode(
  env: Pick<Bindings, "NEUROBAGEL_WRITER_ENABLED" | "NEUROBAGEL">,
): WriterMode {
  if (env.NEUROBAGEL_WRITER_ENABLED !== "1") return "disabled";
  if (!env.NEUROBAGEL) return "store_unconfigured";
  return "enabled";
}

export const RECONCILE_DEFAULT_LIMIT = 25;
/** The most datasets one run examines, whatever a caller or the variable asks for. */
export const RECONCILE_HARD_LIMIT = 200;
/** Datasets whose artifacts one run deletes. The index drops them all at once regardless. */
export const REMOVAL_LIMIT = 200;
/** The loader's per-artifact cap (deploy/neurobagel/README.md: NB_MAX_ARTIFACT_BYTES, 6 MiB). */
export const MAX_ARTIFACT_BYTES = 6 * 1024 * 1024;
/** The loader's whole-release cap (NB_MAX_TOTAL_BYTES, 192 MiB). Reported, not enforced here. */
export const LOADER_TOTAL_CAP_BYTES = 192 * 1024 * 1024;
const R2_METADATA_BUDGET = 1800;
const INDEX_ATTEMPTS = 3;

/** The per-tick bound: `NEUROBAGEL_RECONCILE_MAX`, a positive integer, default 25, never above the hard limit. */
export function reconcileLimit(env: Pick<Bindings, "NEUROBAGEL_RECONCILE_MAX">): number {
  const raw = env.NEUROBAGEL_RECONCILE_MAX?.trim();
  if (raw && /^[0-9]{1,6}$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (n > 0) return Math.min(n, RECONCILE_HARD_LIMIT);
  }
  return RECONCILE_DEFAULT_LIMIT;
}

// ----------------------------------------------------------------------------
// Needs-review flags
// ----------------------------------------------------------------------------

/**
 * The report flags that mean "a person should look at this result", as opposed to the
 * informational ones (`participants_tsv_absent` is ordinary). Every `curation_*` flag
 * is here by prefix, so a flag phase 5 adds is surfaced without a change to this file.
 * A changed result is never published silently: these ride on the stored artifact
 * (R2 custom metadata) and in the run's report, and status lists them.
 */
const NEEDS_REVIEW_EXACT: ReadonlySet<string> = new Set([
  "partial_join",
  "bids_index_empty_fell_back_to_table",
  "participant_ids_do_not_join_bids_index",
  "session_modalities_unreadable",
  "session_modalities_inconsistent",
  "participant_count_disagrees",
  "conflicting_duplicate_participant_ids",
  "dataset_doi_unusable",
]);

export function isNeedsReviewFlag(flag: string): boolean {
  return flag.startsWith("curation_") || NEEDS_REVIEW_EXACT.has(flag);
}

export function needsReviewFlags(report: Pick<NeurobagelReport, "flags">): string[] {
  return report.flags.filter(isNeedsReviewFlag);
}

// ----------------------------------------------------------------------------
// Results
// ----------------------------------------------------------------------------

export type DatasetResult =
  | { id: string; outcome: "unchanged" }
  | { id: string; outcome: "would_write"; reason: string }
  | { id: string; outcome: "written"; fingerprint: string; flags: string[]; wrote: string[] }
  | { id: string; outcome: "refused"; code: string; detail?: string }
  | { id: string; outcome: "error"; error: string }
  | { id: string; outcome: "would_remove" | "removed" };

export interface RunOptions {
  /** Who asked: `cron`, `admin`, `hook:publication`, `hook:import`, `hook:version`. */
  trigger: string;
  /** False is a dry run: nothing is written to the bucket, the ledger or the audit log. */
  execute: boolean;
  /** Examine exactly these ids (an admin's list, or a hook's one dataset). */
  only?: readonly string[];
  limit?: number;
  /** Rewrite even when the fingerprint matches. */
  force?: boolean;
  now?: Date;
  waitUntil?: (work: Promise<unknown>) => void;
  deps?: GatherDeps & { curation?: CurationResolver };
}

export interface RunResult {
  trigger: string;
  dry_run: boolean;
  status: "ok" | "disabled" | "store_unconfigured" | "error";
  writer_enabled: boolean;
  error?: string;
  eligible: number | null;
  examined: number;
  limit: number;
  /** Work found but past the bound: left for the next tick. */
  unexamined: number;
  results: DatasetResult[];
  removed: string[];
  removals_pending: number;
  index: {
    changed: boolean;
    written: boolean;
    entries: number | null;
    contended?: boolean;
    problems?: string[];
    skipped_incomplete?: string[];
  };
  /** Datasets this run refused because their data does not say `anonymous: false`. Counted, never named in status. */
  anonymity_findings: number;
  needs_review: { id: string; flags: string[] }[];
  warnings: string[];
}

function emptyResult(options: RunOptions, limit: number, mode: WriterMode): RunResult {
  return {
    trigger: options.trigger,
    dry_run: !options.execute,
    status: "ok",
    writer_enabled: mode !== "disabled",
    eligible: null,
    examined: 0,
    limit,
    unexamined: 0,
    results: [],
    removed: [],
    removals_pending: 0,
    index: { changed: false, written: false, entries: null },
    anonymity_findings: 0,
    needs_review: [],
    warnings: [],
  };
}

/** Refusal codes that are transient: reported in the run, never recorded as a standing finding. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["fetch_failed", "manifest_unavailable"]);

function clip(text: string, n = 300): string {
  return text.length > n ? `${text.slice(0, n)}...` : text;
}

function s3Options(env: Bindings) {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpointUrl: env.S3_ENDPOINT_URL,
  };
}

// ----------------------------------------------------------------------------
// One dataset
// ----------------------------------------------------------------------------

interface DatasetDetail {
  name: string | null;
  subject_count: number | null;
  license: string | null;
  concept_doi: string | null;
  enrichment_json: string | null;
  enrichment_length: number | null;
  latest_version: string | null;
}

/** The fields a fingerprint is built from, for ONE dataset. `concept_doi` only through the blinded projection. */
async function loadDetail(db: D1Database, id: string): Promise<DatasetDetail | null> {
  return db
    .prepare(
      `SELECT d.name, d.subject_count, d.license, ${CONCEPT_DOI_SQL} AS concept_doi,
              d.enrichment_json, length(d.enrichment_json) AS enrichment_length,
              (SELECT dv.version FROM dataset_versions dv
                WHERE dv.dataset_id = d.dataset_id
                ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) AS latest_version
         FROM datasets d
        WHERE d.dataset_id = ?`,
    )
    .bind(id)
    .first<DatasetDetail>();
}

type Prepared =
  | {
      kind: "ready";
      detail: DatasetDetail;
      latestVersion: string;
      rowFp: string;
      fingerprint: string;
      etag: string;
      curationHash: string | null;
    }
  | { kind: "refused"; code: string; detail?: string }
  | { kind: "transient"; error: string };

/**
 * Everything a dataset's fingerprint needs, and nothing that moves bytes: one D1
 * read, one curation lookup, one S3 HEAD. Used by a dry run as well as a real one.
 */
async function prepareDataset(
  env: Bindings,
  id: string,
  curation: Exclude<CurationResolution, { kind: "failed" }>,
): Promise<Prepared> {
  const detail = await loadDetail(env.DB, id);
  if (!detail) return { kind: "refused", code: "dataset_gone" };
  if (!detail.latest_version) return { kind: "refused", code: "no_latest_version" };
  // The tag form the data plane uses everywhere (legacy rows hold a bare `1.0.0`).
  const latestVersion = toVersionTag(detail.latest_version);

  let head: Awaited<ReturnType<typeof headManifestObject>>;
  try {
    head = await headManifestObject(s3Options(env), id, latestVersion);
  } catch (err) {
    return {
      kind: "transient",
      error: `manifest HEAD failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (head.kind === "absent") return { kind: "refused", code: "manifest_absent" };
  if (!head.etag) return { kind: "refused", code: "manifest_etag_unavailable" };

  const curationHash = curation.kind === "entry" ? curation.hash : null;
  const rowFp = await rowFingerprint(
    {
      dataset_id: id,
      name: detail.name,
      subject_count: detail.subject_count,
      license: detail.license,
      concept_doi: detail.concept_doi,
      latest_version: latestVersion,
    },
    await sha256Hex(detail.enrichment_json ?? ""),
    curationHash,
  );
  return {
    kind: "ready",
    detail,
    latestVersion,
    rowFp,
    fingerprint: await inputFingerprint(rowFp, head.etag),
    etag: head.etag,
    curationHash,
  };
}

/** R2 custom metadata, kept inside R2's 2 KiB: the flags are what gives way. */
function fitMetadata(meta: Record<string, string>): Record<string, string> {
  const size = (m: Record<string, string>) =>
    Object.entries(m).reduce((n, [k, v]) => n + k.length + v.length, 0);
  if (size(meta) <= R2_METADATA_BUDGET) return meta;
  const trimmed = { ...meta };
  const flags = (trimmed[META.flags] ?? "").split(",").filter(Boolean);
  while (flags.length > 0 && size(trimmed) > R2_METADATA_BUDGET) {
    flags.pop();
    trimmed[META.flags] = `${flags.join(",")}+`;
  }
  return trimmed;
}

/**
 * Write one dataset's set: the companions first, the JSON-LD LAST (it carries the
 * fingerprint, so it is the commit marker: a run interrupted before it leaves the
 * old marker and the next run redoes the set). An artifact whose bytes the store
 * already holds is not written again, except the JSON-LD, whose metadata is the
 * record of what it was built from.
 */
async function writeSet(
  bucket: R2Bucket,
  id: string,
  files: Record<string, string>,
  stored: StoredDataset | undefined,
  stamp: Record<string, string>,
): Promise<string[]> {
  const names = artifactFileNames(id);
  const plan: { kind: ArtifactKind; text: string }[] = [
    { kind: "dictionary", text: files[names.dictionary] as string },
    { kind: "description", text: files[names.datasetDescription] as string },
    { kind: "jsonld", text: files[names.jsonld] as string },
  ];
  const wrote: string[] = [];
  for (const { kind, text } of plan) {
    const bytes = new TextEncoder().encode(text);
    const sha = await sha256OfBytes(bytes);
    const existing = stored?.[kind];
    if (kind !== "jsonld" && existing?.sha256 === sha) continue;
    const customMetadata = fitMetadata({
      [META.sha256]: sha,
      [META.kind]: kind,
      ...(kind === "jsonld" ? stamp : {}),
    });
    await bucket.put(artifactName(id, kind), bytes, {
      sha256: sha,
      httpMetadata: { contentType: ARTIFACT_CONTENT_TYPE[kind] },
      customMetadata,
    });
    wrote.push(artifactName(id, kind));
  }
  return wrote;
}

interface RunContext {
  env: Bindings;
  bucket: R2Bucket;
  options: RunOptions;
  listing: StoreListing;
  ledger: Map<string, LedgerEntry>;
  result: RunResult;
  signatures: Map<string, string>;
  curations: Map<string, CurationResolution>;
  now: Date;
  /** Datasets whose data said anonymous. Treated as not eligible for the rest of the run. */
  anonymityRefused: Set<string>;
}

async function ledgerNote(
  rc: RunContext,
  id: string,
  label: Parameters<typeof recordLedgerState>[3],
  detail?: Record<string, string | number | boolean | null>,
): Promise<void> {
  if (!rc.options.execute) return;
  try {
    await recordLedgerState(rc.env.DB, rc.ledger, id, label, detail);
  } catch (err) {
    rc.result.warnings.push(
      `ledger write failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function refuse(
  rc: RunContext,
  id: string,
  code: string,
  detail?: string,
): Promise<DatasetResult> {
  if (code === "anonymity_disagreement") {
    rc.anonymityRefused.add(id);
    rc.result.anonymity_findings++;
    // The audit log only: no GitHub issue, no mail (ADR 0067). The detail names the
    // KIND of disagreement and never carries the metadata it came from.
    await ledgerNote(rc, id, { state: "anonymity" }, { phase: "gather" });
    return { id, outcome: "refused", code };
  }
  if (!TRANSIENT_CODES.has(code)) {
    await ledgerNote(rc, id, { state: "refused", code }, detail ? { detail } : {});
  }
  return { id, outcome: "refused", code, ...(detail ? { detail } : {}) };
}

/**
 * Make the data plane read a manifest at least as new as `currentEtag`.
 *
 * The data plane trusts an edge copy of a manifest for 60 seconds without asking S3
 * (ADR 0072). A writer that fingerprints a dataset by the manifest's CURRENT ETag but
 * builds its artifacts from a copy that is up to a minute older would stamp new
 * metadata on old content, and since the stamp matches the ETag, nothing would ever
 * correct it. So the writer asks first: if the edge copy's ETag is not the current
 * one, the copy is evicted and the data plane reads S3. A copy that is current, or
 * none, is left alone. Content is then never OLDER than the ETag it is stamped with
 * (a manifest that moves again after this check only makes the stamp older than the
 * content, which the next examination notices and redoes).
 *
 * Returns what it did. `unsupported` means a stale copy exists and the cache cannot
 * delete it: the caller must not gather, because the data plane would answer from it.
 */
async function evictStaleManifestCopy(
  env: Bindings,
  datasetId: string,
  version: string,
  currentEtag: string,
): Promise<"none" | "current" | "evicted" | "unsupported"> {
  const cache = (globalThis as { caches?: { default?: Partial<Cache> } }).caches?.default;
  if (!cache?.match) return "none";
  const request = new Request(manifestCacheKey(resolveDataBaseOrigin(env), datasetId, version));
  const hit = await cache.match(request);
  if (!hit) return "none";
  const copyEtag = hit.headers.get("ETag");
  await hit.body?.cancel().catch(() => {});
  if (copyEtag === currentEtag) return "current";
  if (typeof cache.delete !== "function") return "unsupported";
  await cache.delete(request);
  return "evicted";
}

/** Examine one dataset and, on a real run, write it when it changed. */
async function processDataset(rc: RunContext, row: PlanRow): Promise<DatasetResult> {
  const { env, options } = rc;
  const id = row.dataset_id;
  const federation = federationContext(env);

  // The row again, now: the bulk query was a moment ago, and eligibility is cheap to
  // ask twice. A dataset that stopped being eligible in between is a removal, not a write.
  const fresh = await loadEligibleRow(env.DB, id, federation);
  if (!fresh.eligible) return { id, outcome: "refused", code: "no_longer_eligible" };

  // A dataset with a curation entry is NEVER converted without it, and a lookup that
  // fails stops this dataset: no artifact is written and the existing one is left as it
  // is. There is no fallback to converting un-curated (neurobagel-curation.ts).
  const curation =
    rc.curations.get(id) ?? (await (options.deps?.curation ?? defaultCurationResolver)(id));
  if (curation.kind === "failed") {
    return refuse(rc, id, "curation_unavailable", clip(curation.reason));
  }
  const prepared = await prepareDataset(env, id, curation);
  if (prepared.kind === "refused") return refuse(rc, id, prepared.code, prepared.detail);
  if (prepared.kind === "transient") {
    return { id, outcome: "error", error: prepared.error };
  }

  const stored = rc.listing.datasets.get(id);
  const storedFp = stored?.jsonld?.meta[META.fingerprint];
  const complete = Boolean(stored?.jsonld && stored.dictionary && stored.description);
  if (!options.force && complete && storedFp === prepared.fingerprint) {
    await ledgerNote(rc, id, { state: "clear" });
    return { id, outcome: "unchanged" };
  }
  if (!options.execute) {
    return {
      id,
      outcome: "would_write",
      reason: options.force
        ? "forced"
        : !complete
          ? stored?.jsonld
            ? "incomplete set"
            : "not in the store"
          : "inputs changed",
    };
  }

  // The data plane may answer from a manifest copy up to a minute old; the fingerprint
  // is stamped with the CURRENT ETag, so a stale copy is evicted first (see
  // evictStaleManifestCopy for why content must never be older than its stamp).
  try {
    const evicted = await evictStaleManifestCopy(env, id, prepared.latestVersion, prepared.etag);
    if (evicted === "unsupported") {
      return {
        id,
        outcome: "error",
        error: "a stale manifest copy is cached and cannot be evicted",
      };
    }
  } catch (err) {
    return { id, outcome: "error", error: clip(err instanceof Error ? err.message : String(err)) };
  }

  // Gather: the anonymity guard inside it runs before any depositor file is read.
  let gathered: Awaited<ReturnType<typeof gatherNeurobagelInput>>;
  try {
    gathered = await gatherNeurobagelInput(env, id, {
      waitUntil: options.waitUntil,
      ...options.deps,
    });
  } catch (err) {
    if (err instanceof GatherRefusal) return refuse(rc, id, err.code, clip(err.message));
    return { id, outcome: "error", error: clip(err instanceof Error ? err.message : String(err)) };
  }

  const input = applyCuration(gathered.input, curation);

  let built: Awaited<ReturnType<typeof buildNeurobagelArtifacts>>;
  try {
    built = await buildNeurobagelArtifacts(input);
  } catch (err) {
    if (err instanceof NeurobagelRefusal) {
      // The transform's own backstop saying anonymous is the same class of finding.
      if (err.code === "anonymous_not_false") return refuse(rc, id, "anonymity_disagreement");
      return refuse(rc, id, `transform_${err.code}`, clip(err.message));
    }
    return { id, outcome: "error", error: clip(err instanceof Error ? err.message : String(err)) };
  }

  const names = artifactFileNames(id);
  for (const name of [names.jsonld, names.dictionary, names.datasetDescription]) {
    const size = new TextEncoder().encode(built.files[name] as string).length;
    // The loader refuses the WHOLE load for one artifact over its cap; such a file is
    // never written, so one dataset cannot stop every other from being loaded.
    if (size > MAX_ARTIFACT_BYTES) {
      return refuse(rc, id, "artifact_too_large", `${name} is ${size} bytes`);
    }
  }

  const flags = needsReviewFlags(built.report);
  const signature = await currentSignature(row, prepared.curationHash);
  const wrote = await writeSet(rc.bucket, id, built.files, stored, {
    [META.fingerprint]: prepared.fingerprint,
    [META.rowFingerprint]: prepared.rowFp,
    [META.manifestEtag]: prepared.etag,
    [META.signature]: signature,
    [META.version]: prepared.latestVersion,
    [META.transformVersion]: String(built.report.transform_version),
    [META.flags]: flags.join(","),
    [META.generatedAt]: rc.now.toISOString(),
  });
  await ledgerNote(rc, id, { state: "clear" });
  if (flags.length > 0) rc.result.needs_review.push({ id, flags });
  return { id, outcome: "written", fingerprint: prepared.fingerprint, flags, wrote };
}

// ----------------------------------------------------------------------------
// The index, and removal
// ----------------------------------------------------------------------------

/**
 * Bring `index.json` to what the listing says, for the datasets eligible now.
 * Conditional on the index not having changed since it was read; a run that loses
 * rebuilds from a fresh listing, up to a few attempts.
 */
async function syncIndex(
  rc: RunContext,
  eligibleIds: ReadonlySet<string>,
): Promise<RunResult["index"]> {
  const { bucket, options } = rc;
  let listing = rc.listing;
  for (let attempt = 1; attempt <= INDEX_ATTEMPTS; attempt++) {
    if (attempt > 1 || options.execute) listing = await listStore(bucket);
    const previous = await readStoredIndex(bucket);
    const built = await buildIndexDocument(
      listing,
      eligibleIds,
      previous.document,
      rc.now.toISOString(),
    );
    const summary = {
      changed: built.changed,
      written: false,
      entries: built.document.datasets.length,
      ...(built.skippedIncomplete.length > 0
        ? { skipped_incomplete: built.skippedIncomplete }
        : {}),
    };
    if (!built.changed) return summary;
    const problems = indexProblems(built.document);
    if (problems.length > 0) return { ...summary, problems };
    if (!options.execute) return summary;
    // No index yet: a plain write. Two runs creating the first index each build it
    // from the same bucket, and either result is the right one.
    const written = await bucket.put(NEUROBAGEL_INDEX_KEY, serializeIndex(built.document), {
      httpMetadata: { contentType: "application/json" },
      ...(previous.etag ? { onlyIf: { etagMatches: previous.etag } } : {}),
    });
    if (written) return { ...summary, written: true };
    // Another run replaced the index between our read and our write.
  }
  return {
    changed: true,
    written: false,
    entries: null,
    contended: true,
  };
}

async function removeArtifacts(rc: RunContext, ids: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const id of ids) {
    const stored = rc.listing.datasets.get(id);
    if (!stored) continue;
    const keys = (["jsonld", "dictionary", "description"] as const)
      .map((k) => stored[k]?.key)
      .filter((k): k is string => Boolean(k));
    if (keys.length === 0) continue;
    await rc.bucket.delete(keys);
    removed.push(id);
  }
  return removed;
}

// ----------------------------------------------------------------------------
// A run
// ----------------------------------------------------------------------------

/**
 * One run of the writer: examine up to `limit` datasets, write what changed, bring
 * the index to the listing, delete what left. Never throws for an expected failure;
 * the failure is the result's `status` and `error`.
 */
export async function runNeurobagelWriter(env: Bindings, options: RunOptions): Promise<RunResult> {
  const mode = neurobagelWriterMode(env);
  const limit = Math.min(RECONCILE_HARD_LIMIT, Math.max(1, options.limit ?? reconcileLimit(env)));
  const result = emptyResult(options, limit, mode);
  const now = options.now ?? new Date();

  // A real run needs the switch. A dry run only reads, so it needs the bucket and
  // not the switch: an operator can see what enabling would do.
  if (options.execute && mode !== "enabled") {
    result.status = mode === "disabled" ? "disabled" : "store_unconfigured";
    return result;
  }
  const bucket = env.NEUROBAGEL;
  if (!bucket) {
    result.status = "store_unconfigured";
    return result;
  }

  try {
    const federation = federationContext(env);
    // A run for named datasets reads only those; the whole catalog only for an unscoped run.
    const only = options.only ? [...new Set(options.only)] : undefined;
    const { rows, refusedByRecheck } = await loadPlanRows(env.DB, federation, only);
    if (refusedByRecheck > 0) {
      result.warnings.push(
        `${refusedByRecheck} row(s) selected by the SQL predicate failed its TypeScript re-check`,
      );
    }
    const listing = await listStore(bucket);
    // `eligible` is the catalog's count, which a scoped run does not read: null, not zero.
    result.eligible = only === undefined ? rows.length : null;
    // Who is eligible among everything this run may touch: the whole catalog when unscoped,
    // else what the store holds plus what was named. The index is judged against this.
    const eligibleIds =
      only === undefined
        ? new Set(rows.map((r) => r.dataset_id))
        : await eligibleAmong(
            env.DB,
            [...new Set([...listing.datasets.keys(), ...only])],
            federation,
          );
    const ledger = options.execute ? await readLedger(env.DB) : new Map<string, LedgerEntry>();

    const resolver = options.deps?.curation ?? defaultCurationResolver;
    const curations = new Map<string, CurationResolution>();
    const signatures = new Map<string, string>();
    for (const row of rows) {
      let resolution: CurationResolution;
      try {
        resolution = await resolver(row.dataset_id);
      } catch (err) {
        resolution = {
          kind: "failed",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      curations.set(row.dataset_id, resolution);
      // A failed lookup has no hash: a signature that cannot match, so it is examined.
      signatures.set(
        row.dataset_id,
        resolution.kind === "failed"
          ? "curation-failed"
          : await currentSignature(row, resolution.kind === "entry" ? resolution.hash : null),
      );
    }

    const plan = planWork({
      rows,
      stored: listing.datasets,
      signatures,
      limit,
      day: utcDay(now),
      requested: only,
    });
    result.unexamined = plan.unexamined;

    const rc: RunContext = {
      env,
      bucket,
      options,
      listing,
      ledger,
      result,
      signatures,
      curations,
      now,
      anonymityRefused: new Set(),
    };

    // Work. Sequential on purpose: each dataset moves a manifest digest and two small
    // files through a shared isolate, and the subrequest budget is shared with every
    // other job on the tick (ADR 0054).
    const rowsById = new Map(rows.map((r) => [r.dataset_id, r]));
    for (const item of plan.work) {
      result.examined++;
      const row = rowsById.get(item.id) as PlanRow;
      let outcome: DatasetResult;
      try {
        outcome = await processDataset(rc, row);
      } catch (err) {
        outcome = {
          id: item.id,
          outcome: "error",
          error: clip(err instanceof Error ? err.message : String(err)),
        };
      }
      result.results.push(outcome);
    }

    // What leaves: datasets the store holds that are not eligible now, that proved
    // ineligible while being examined, or whose data said anonymous. Scoped to the
    // requested ids when there are some. Computed from the LISTING, not from memory.
    const droppedWhileExamining = new Set(
      result.results
        .filter((r) => r.outcome === "refused" && r.code === "no_longer_eligible")
        .map((r) => r.id),
    );
    const notIndexable = (id: string): boolean =>
      !eligibleIds.has(id) || rc.anonymityRefused.has(id) || droppedWhileExamining.has(id);
    const leaving = [...listing.datasets.keys()]
      .filter((id) => notIndexable(id) && (only === undefined || only.includes(id)))
      .sort();
    const indexable = new Set([...eligibleIds].filter((id) => !notIndexable(id)));

    // Index first (it omits what leaves); artifacts of what leaves go after.
    const index = await syncIndex(rc, indexable);
    result.index = index;

    const batch = leaving.slice(0, REMOVAL_LIMIT);
    result.removals_pending = leaving.length - batch.length;
    if (options.execute) {
      if (index.written || !index.changed) {
        result.removed = await removeArtifacts(rc, batch);
        for (const id of result.removed) result.results.push({ id, outcome: "removed" });
      } else {
        result.warnings.push(
          "artifacts of leaving datasets were kept: the index could not be updated first",
        );
        result.removals_pending = leaving.length;
      }
    } else {
      for (const id of batch) result.results.push({ id, outcome: "would_remove" });
    }
    await recordRun(env, result);
  } catch (err) {
    result.status = "error";
    result.error = clip(err instanceof Error ? err.message : String(err));
    console.error(`[neurobagel] run failed trigger=${options.trigger}:`, result.error);
  }
  return result;
}

/** One audit row per notable real run: the "last reconcile" status reads. */
async function recordRun(env: Bindings, result: RunResult): Promise<void> {
  if (result.dry_run) return;
  const wrote = result.results.filter((r) => r.outcome === "written").length;
  const refused = result.results.filter((r) => r.outcome === "refused").length;
  const errors = result.results.filter((r) => r.outcome === "error").length;
  const activity =
    wrote + result.removed.length + refused + errors + (result.index.written ? 1 : 0);
  const isHook = result.trigger.startsWith("hook:");
  if (isHook && activity === 0) return;
  try {
    await auditLogStatement(env.DB, {
      userId: null,
      action: LEDGER_ACTIONS.run,
      resourceType: "neurobagel",
      resourceId: result.trigger,
      details: JSON.stringify({
        eligible: result.eligible,
        examined: result.examined,
        unexamined: result.unexamined,
        written: wrote,
        unchanged: result.results.filter((r) => r.outcome === "unchanged").length,
        refused,
        errors,
        removed: result.removed.length,
        removals_pending: result.removals_pending,
        index_written: result.index.written,
        index_entries: result.index.entries,
        anonymity_findings: result.anonymity_findings,
        needs_review: result.needs_review.length,
        status: result.status,
      }),
    }).run();
  } catch (err) {
    result.warnings.push(`run record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ----------------------------------------------------------------------------
// The entry points
// ----------------------------------------------------------------------------

/** One dataset: the hook's work. Also removes it when it is no longer eligible. */
export function syncNeurobagelDataset(
  env: Bindings,
  datasetId: string,
  trigger: string,
  waitUntil?: (work: Promise<unknown>) => void,
  deps?: RunOptions["deps"],
): Promise<RunResult> {
  return runNeurobagelWriter(env, {
    trigger,
    execute: true,
    only: [datasetId],
    limit: 1,
    waitUntil,
    deps,
  });
}

/**
 * The hook publication, import and a new version call. It must NEVER fail, block or
 * delay the flow that calls it:
 *   - with the writer off (the default) it returns before doing any I/O;
 *   - an id that can never be federated (an `xx` sandbox, a reserved fixture) returns
 *     before any read;
 *   - the work is handed to `waitUntil` and never awaited by the caller;
 *   - every failure, including one thrown synchronously here, is caught and logged.
 *
 * `after` is work the caller has already started and that this sync must follow (the
 * metadata refresh that writes the D1 columns a fingerprint reads). Its failure is the
 * refresh's own business and never stops the sync.
 */
export function scheduleNeurobagelSync(
  env: Bindings,
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
  datasetId: string,
  trigger: string,
  options: { after?: Promise<unknown>; deps?: RunOptions["deps"] } = {},
): void {
  try {
    const mode = neurobagelWriterMode(env);
    if (mode === "disabled") return;
    if (!couldBeFederated(datasetId, federationContext(env))) return;
    if (mode === "store_unconfigured") {
      console.warn(`[neurobagel] store_unconfigured: ${trigger} for ${datasetId} did nothing`);
      return;
    }
    const work = (options.after ?? Promise.resolve())
      .catch(() => {})
      .then(() => syncNeurobagelDataset(env, datasetId, trigger, waitUntil, options.deps))
      .then((r) => {
        if (r.status === "error") {
          console.error(`[neurobagel] ${trigger} ${datasetId}: ${r.error}`);
        }
      })
      .catch((err) =>
        console.error(
          `[neurobagel] ${trigger} ${datasetId} failed:`,
          err instanceof Error ? (err.stack ?? err.message) : err,
        ),
      );
    if (waitUntil) waitUntil(work);
  } catch (err) {
    console.error(
      `[neurobagel] could not schedule ${trigger} for ${datasetId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The daily reconcile, the safety net: bounded by `NEUROBAGEL_RECONCILE_MAX`, in the
 * deterministic order of neurobagel-plan.ts. PRODUCTION ONLY and absent from
 * `DEV_CRON_ALLOWLIST` (a new daily job is production-only by default, AGENTS.md):
 * this is the cron fence, and the fence lives HERE so the admin route, which calls
 * `runNeurobagelWriter` directly, still works on staging.
 */
export async function runNeurobagelReconcileCron(env: Bindings): Promise<RunResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[neurobagel] reconcile skipped (non-production)");
    return null;
  }
  return runNeurobagelWriter(env, { trigger: "cron", execute: true });
}
