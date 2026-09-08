/**
 * `get_events` (epic #1065 phase 3, issue #1295).
 *
 * **Primary path** (`index.events_parquet` present, every v3 index that
 * parsed at least one events.tsv): reads the WHOLE parquet file once with
 * `hyparquet` on a per-store cache miss, groups rows by `store_path` (the
 * producer's own name for the store's `zarr` path --
 * `scripts/zarr/generate_zarr.py`'s `events_schema`), and writes EVERY
 * store's rows (`events/<zarr>`) plus a store-list summary
 * (`events/_stores`) to the projection cache in one pass -- one dataset-wide
 * parquet read serves every recording's future `get_events` call, not just
 * the one this request named, up to {@link MAX_STORE_FANOUT_ENTRIES}
 * stores. `sample_index` comes back from hyparquet as a
 * `BigInt` (parquet INT64); converted to `Number` here, once, before the
 * value is cached or returned, with a `Number.isSafeInteger` guard -- the
 * whole point of the primary path is that `sample_index` is EXACT, so a
 * value that cannot round-trip through `Number` losslessly must throw, not
 * silently publish a wrong index. `source: "events_parquet"`,
 * `estimated: false` always on this path.
 *
 * **The parquet is the data source whenever the index names one; only the
 * PROJECTION CACHE is gated on a usable `source_commit`.** A dataset can, in
 * principle, have `events_parquet` set but no 40-hex commit to key a cache
 * entry on (the schema does not force one to imply the other); in that case
 * the cache is bypassed -- read fresh every call -- but the parquet is still
 * read, never silently swapped for the strictly-worse `events.tsv` fallback.
 *
 * **Codec: a hand-rolled ZSTD-only `compressors` map, not the
 * `hyparquet-compressors` package.** That package's `compressors` export
 * eagerly constructs its `SNAPPY` entry at module load
 * (`snappyUncompressor()` from the `hysnappy` dependency), which compiles a
 * WASM module synchronously -- `WebAssembly.Module(): Wasm code generation
 * disallowed by embedder`, reproduced under real workerd via `bunx wrangler
 * dev --local` against `mcp-smoke-entry.ts`, the SAME failure class
 * `blosc-decode.ts`'s module doc documents for `numcodecs`. This crashes the
 * WHOLE bundle at isolate startup, for every request, not just a
 * `get_events` call -- unacceptable regardless of whether any dataset's
 * parquet ever uses SNAPPY (none does today: every column in the live
 * nm000329 fixture is ZSTD). So `hyparquet-compressors` was removed from
 * `package.json`, and this file builds the one-entry `compressors` map
 * itself, straight from `fzstd` (the same pure-JS decoder `blosc-decode.ts`
 * already uses) -- functionally identical to what the package would have
 * supplied for ZSTD, with none of its SNAPPY baggage. A dataset whose
 * parquet ever used a codec other than ZSTD would throw here (hyparquet's
 * own error for a missing compressor entry), which is preferable to a
 * bundle that cannot start at all.
 *
 * Deliberately reads every column the parquet file has (no `columns` filter
 * on `parquetReadObjects`) rather than restricting to the eight named
 * fields on `eventRowSchema`: the schema is `.passthrough()` specifically
 * so `subject`/`session`/`task`/`run` (and any `x_`-prefixed extra) reach
 * the caller unchanged, which only holds if this read actually fetches
 * them.
 *
 * **A store the parquet has no rows for** (the converter never found or
 * parsed its events.tsv, distinct from a store with a genuinely empty
 * events.tsv, which is indistinguishable from this on the wire either way)
 * still gets a `rowCount: 0` row in `events/_stores` and, below the
 * {@link MAX_STORE_FANOUT_ENTRIES} bound, a `[]` cache entry written in the
 * SAME pass as every other store -- so a repeat call for that store is a
 * cache hit, never a re-read of the whole file. Either way the response
 * carries a `note` saying so explicitly rather than a bare empty list a
 * caller could misread as "this recording truly has no events".
 *
 * **Fallback path** (no `events_parquet` -- every v1/v2 index today):
 * derives the sibling `<prefix>_events.tsv` from the recording's `path`
 * (BIDS naming: replace the trailing `_<suffix>.<ext>` with `_events.tsv`)
 * and fetches it credential-free from `raw.githubusercontent.com` via the
 * SAME URL builder the zarr fidelity sweep uses
 * (`rawContentUrl`, `services/zarr-fidelity-sweep.ts`) rather than
 * duplicating it -- `ref` is the resolved 40-hex `source_commit` when
 * usable, else `main`. `sample_index` is computed locally against the
 * chosen group's SERVING `rate`; `source: "events_tsv_fallback"`,
 * `estimated: true` always -- the estimate is off by a sub-sample amount
 * wherever source and target rates are not integer multiples.
 * **Only a clean 404 means absence** (a missing file, OR a private repo,
 * which reads identically to an anonymous GET): that answers `events: []`
 * with a note; BIDS inheritance (walking up to a session/subject/
 * root-level events.tsv) is explicitly out of scope, and the note says so.
 * ANY OTHER non-2xx, or a thrown fetch (a network failure), is an
 * INFRASTRUCTURE failure, not an absence -- it answers a tool error naming
 * the HTTP status (or the thrown message) and the tsv path, and
 * `total_count` never comes from that failure (there is no total_count at
 * all; the call errors outright, mirroring `render_overview`'s
 * chunk-fetch-failure result).
 *
 * Never the data host (`data.nemar.org`): its file branch is a redirect,
 * not something this Worker can read in-process (`routes/data.ts` has no
 * injectable `fetch`).
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import { decompress as fzstdDecompress } from "fzstd";
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import type { Compressors } from "hyparquet";
import { z } from "zod";
import {
  type EventRow,
  type GetEventsInput,
  type GetEventsOutput,
  eventRowSchema,
  getEventsOutputSchema,
} from "../../../../shared/contract/mcp.js";
import { SOURCE_COMMIT_RE } from "../../../../shared/contract/zarr-index.js";
import { rawContentUrl } from "../../services/zarr-fidelity-sweep.js";
import {
  datasetNotFoundResult,
  isZarrReady,
  loadPublicDatasetRow,
  zarrNotReadyResult,
} from "../catalog-row.js";
import { NO_COMMIT_NOTE, buildEnvelopeForStore } from "../envelope.js";
import { projectionUrl, readJsonProjection, writeJsonProjection } from "../projection-cache.js";
import type { RecordingToolDeps, ToolOutcome } from "../tool-types.js";
import {
  groupNotFoundResult,
  loadRecordingsProjection,
  recordingNotFoundResult,
  resolveRecording,
} from "./list-recordings.js";

const NO_EVENTS_FILE_NOTE =
  "no events file was found next to this recording (BIDS inheritance -- walking up to a " +
  "session/subject/root-level events.tsv -- is out of scope; only the exact sibling path was tried)";
const NO_RATE_NOTE =
  "the resolved recording/group has no known sampling rate, so a sample_index could not be " +
  "computed from events.tsv";
const NO_PARQUET_ROWS_NOTE =
  "events.parquet has no rows for this store (the converter may not have found or parsed its " +
  "events.tsv); the result may be incomplete";

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function parquetReadFailedResult(
  datasetId: string,
  recording: string,
  detail: string,
): CallToolResult {
  return toolError(
    `get_events could not read events.parquet for recording "${recording}" in dataset ` +
      `"${datasetId}": ${detail}`,
  );
}

function tsvFetchFailedResult(
  datasetId: string,
  recording: string,
  tsvPath: string,
  detail: string,
): CallToolResult {
  return toolError(
    `get_events could not read the events.tsv fallback for recording "${recording}" in dataset ` +
      `"${datasetId}" (${tsvPath}): ${detail}`,
  );
}

/** `sample_index` is published as an EXACT int64; a value that cannot
 *  round-trip through `Number` losslessly (beyond `Number.MAX_SAFE_INTEGER`)
 *  would silently publish a wrong index, which is precisely the failure
 *  mode this column exists to prevent (`#1060`'s "exact, not estimated"
 *  promise). Throws with dataset/store context rather than truncating --
 *  this should never happen for a real recording (no dataset in the
 *  catalog is anywhere close to 2^53 samples), so a throw here means the
 *  parquet itself is corrupt, not that a cap was reached in practice. */
function toSafeSampleIndex(value: unknown, datasetId: string, storeZarr: string): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `get_events: sample_index ${String(value)} for store "${storeZarr}" in dataset ` +
        `"${datasetId}" is not a safe integer -- refusing to publish a lossy value`,
    );
  }
  return n;
}

/** ZSTD only -- see the module doc's "Codec" section for why this is not
 *  the `hyparquet-compressors` package. `outputLength` (the second
 *  parameter `Compressors[K]` is typed to accept) is unused, mirroring
 *  that package's own `ZSTD` entry: `fzstd`'s frame already carries its
 *  own decompressed size. */
const EVENTS_PARQUET_COMPRESSORS: Compressors = {
  ZSTD: (input) => fzstdDecompress(input),
};

interface EventsStoresSummaryEntry {
  zarr: string;
  rowCount: number;
}

/** Cached payload schemas (`projection-cache.ts`'s `readJsonProjection`
 *  validates every hit against one), declared next to the payload types
 *  they check -- a cache entry that fails validation (a stale shape from
 *  before `PROJECTION_SCHEMA_VERSION` was bumped, or simple corruption) is
 *  a miss, not a crash. */
/** Upper bound on the per-store `events/<zarr>` entries one parquet miss
 *  fans out into. The requested store's entry is ALWAYS written; the
 *  placeholder pass for every other store is skipped above this bound.
 *
 *  Store counts in the live catalog are not bounded by anything this code
 *  controls: nm000281 publishes 25,253 stores, on005873 10,944 (measured
 *  2026-09-08 from `zarr.nemar.org/catalog.json`). Writing one Response
 *  plus one `JSON.stringify` per store for a dataset that size, inside a
 *  single request's `waitUntil`, is a cost with no ceiling and no cache
 *  benefit proportional to it -- the fan-out exists so a SECOND call for a
 *  neighbouring store is a hit, which pays for itself on an ordinary
 *  dataset and not on a pathological one. Above the bound each store's
 *  first call re-reads the parquet, which is the behaviour that existed
 *  before the fan-out; the read itself is unchanged and still reported as
 *  a miss. */
export const MAX_STORE_FANOUT_ENTRIES = 2000;

const eventRowsProjectionSchema = z.array(eventRowSchema);
const eventsStoresSummarySchema = z.array(
  z.object({ zarr: z.string(), rowCount: z.number().int().nonnegative() }),
);

async function readWholeEventsParquet(
  deps: RecordingToolDeps,
  datasetId: string,
  eventsParquetUrl: string,
): Promise<{
  byStore: Map<string, EventRow[]>;
  bytesFetched: number;
  invalidRowCountByStore: Map<string, number>;
}> {
  let bytesFetched = 0;
  const countingFetch: typeof fetch = async (input, init) => {
    const res = await deps.fetch(input, init);
    const len = Number(res.headers.get("content-length") ?? 0);
    bytesFetched += len;
    return res;
  };
  const file = await asyncBufferFromUrl({
    url: eventsParquetUrl,
    fetch: countingFetch,
    requestInit: { headers: { "User-Agent": "nemar-mcp" } },
  });
  const metadata = await parquetMetadataAsync(file);
  // No `columns` filter: every column (the eight named on eventRowSchema
  // plus subject/session/task/run and any x_-prefixed extra) is wanted, so
  // `.passthrough()` on the wire schema has something real to pass through.
  const rawRows = await parquetReadObjects({
    file,
    metadata,
    compressors: EVENTS_PARQUET_COMPRESSORS,
  });

  const byStore = new Map<string, EventRow[]>();
  const invalidRowCountByStore = new Map<string, number>();
  let totalInvalid = 0;
  for (const raw of rawRows) {
    const storePath = String((raw as { store_path?: unknown }).store_path ?? "");
    const candidate = {
      ...raw,
      sample_index: toSafeSampleIndex(
        (raw as { sample_index?: unknown }).sample_index,
        datasetId,
        storePath,
      ),
    };
    // Never cache an unvalidated row: a row that fails eventRowSchema (a
    // malformed store_path, a negative sample_index toSafeSampleIndex's
    // narrower "is it a safe integer" check would not have caught, ...) is
    // dropped and counted rather than written to the cache or returned.
    const parsed = eventRowSchema.safeParse(candidate);
    if (!parsed.success) {
      invalidRowCountByStore.set(storePath, (invalidRowCountByStore.get(storePath) ?? 0) + 1);
      totalInvalid++;
      continue;
    }
    const row = parsed.data as EventRow;
    const list = byStore.get(storePath);
    if (list) list.push(row);
    else byStore.set(storePath, [row]);
  }
  if (totalInvalid > 0) {
    console.warn(
      `[get_events] ${datasetId}: ${totalInvalid} parquet row(s) failed eventRowSchema validation and were omitted`,
    );
  }
  return { byStore, bytesFetched, invalidRowCountByStore };
}

/** Primary path: `events/<zarr>` cache entry per store, all written in one
 *  pass on a miss (see module doc), including a `[]` placeholder for every
 *  store the recordings projection knows about that the parquet had no
 *  rows for -- so a repeat call for THAT store is a cache hit too, never a
 *  re-read of the whole file. Bounded by {@link MAX_STORE_FANOUT_ENTRIES};
 *  above it only the requested store's entry is written.
 *
 *  `sourceCommit` gates the CACHE only (decision: the parquet is the data
 *  source whenever `eventsParquetUrl` is set, unconditionally) -- when it
 *  is `null`, this reads the parquet fresh every call and never touches
 *  `readJsonProjection`/`writeJsonProjection` at all. Throws (parquet
 *  parse/decode failures, an unsafe `sample_index`) rather than catching
 *  internally; the caller wraps this call and turns a throw into a typed
 *  tool error, mirroring `render_overview`'s chunk-fetch-failure handling. */
async function loadEventsFromParquet(
  deps: RecordingToolDeps,
  datasetId: string,
  sourceCommit: string | null,
  eventsParquetUrl: string,
  storeZarr: string,
  allStoreZarrs: string[],
): Promise<{
  rows: EventRow[];
  cacheStatus: "hit" | "miss";
  upstreamBytes: number;
  /** Rows dropped for THIS store by `eventRowSchema` validation, this call.
   *  Always `0` on a cache hit -- the cached rows already passed validation
   *  when they were written, so there is nothing new to report. */
  invalidRowCount: number;
}> {
  if (sourceCommit) {
    const cacheKey = projectionUrl(datasetId, sourceCommit, `events/${storeZarr}`);
    const cached = await readJsonProjection(deps.cache(), cacheKey, eventRowsProjectionSchema);
    if (cached.status === "hit") {
      return { rows: cached.value, cacheStatus: "hit", upstreamBytes: 0, invalidRowCount: 0 };
    }
  }

  const { byStore, bytesFetched, invalidRowCountByStore } = await readWholeEventsParquet(
    deps,
    datasetId,
    eventsParquetUrl,
  );
  for (const zarr of allStoreZarrs) {
    if (!byStore.has(zarr)) byStore.set(zarr, []);
  }

  if (sourceCommit) {
    const fanOut = byStore.size <= MAX_STORE_FANOUT_ENTRIES;
    const storesSummary: EventsStoresSummaryEntry[] = [];
    for (const [zarr, rows] of byStore.entries()) {
      // The requested store is always cached; the rest only below the
      // fan-out bound. The summary is one entry either way, so it stays
      // complete regardless.
      if (fanOut || zarr === storeZarr) {
        writeJsonProjection(
          deps.executionCtx,
          deps.cache(),
          projectionUrl(datasetId, sourceCommit, `events/${zarr}`),
          rows,
        );
      }
      storesSummary.push({ zarr, rowCount: rows.length });
    }
    writeJsonProjection(
      deps.executionCtx,
      deps.cache(),
      projectionUrl(datasetId, sourceCommit, "events/_stores"),
      storesSummary,
    );
  }

  return {
    rows: byStore.get(storeZarr) ?? [],
    cacheStatus: "miss",
    upstreamBytes: bytesFetched,
    invalidRowCount: invalidRowCountByStore.get(storeZarr) ?? 0,
  };
}

interface ParsedEventsTsv {
  columns: string[];
  rows: string[][];
}

/** Mirrors `parse_events_tsv` in `scripts/zarr/generate_zarr.py`: strip a
 *  leading UTF-8 BOM (a spreadsheet-exported events.tsv can carry one, which
 *  would otherwise poison the first column's name), drop blank lines
 *  anywhere (also handles a CRLF file: the `\r` is not part of any cell,
 *  since the split is on `\r?\n`, and a trailing `\r` a lone `\r?\n` split
 *  might otherwise leave on the last cell of a line never occurs because
 *  the split consumes it), tab-split.
 */
function parseEventsTsvText(text: string): ParsedEventsTsv {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((ln) => ln.trim().length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  return {
    columns: lines[0].split("\t").map((c) => c.trim()),
    rows: lines.slice(1).map((ln) => ln.split("\t")),
  };
}

function cellOrNull(fields: string[], col: number): string | null {
  if (col < 0 || col >= fields.length) return null;
  const value = fields[col].trim();
  return !value || value.toLowerCase() === "n/a" ? null : value;
}

/** BIDS: replace the trailing `_<suffix>.<ext>` with `_events.tsv`, e.g.
 *  `sub-1_task-x_eeg.bdf` -> `sub-1_task-x_events.tsv`. */
function siblingEventsTsvPath(storePath: string): string {
  return storePath.replace(/_[^_/.]+\.[^./]+$/, "_events.tsv");
}

type TsvFallbackResult =
  | { kind: "rows"; rows: EventRow[]; note: string | null; bytesFetched: number }
  | { kind: "error"; detail: string; tsvPath: string };

async function loadEventsFromTsvFallback(
  deps: RecordingToolDeps,
  datasetId: string,
  storePath: string,
  ref: string,
  storeZarr: string,
  groupName: string,
  rate: number | null,
): Promise<TsvFallbackResult> {
  if (rate === null) {
    return { kind: "rows", rows: [], note: NO_RATE_NOTE, bytesFetched: 0 };
  }
  const tsvPath = siblingEventsTsvPath(storePath);
  const url = rawContentUrl(deps.rawGithubBase, datasetId, ref, tsvPath);

  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { "User-Agent": "nemar-mcp" } });
  } catch (err) {
    return {
      kind: "error",
      tsvPath,
      detail: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Only a clean 404 is "absent" -- BIDS inheritance is out of scope, so a
  // missing sibling file is a normal, expected outcome for a v1 dataset,
  // not an error. A private repo reads identically to a missing file
  // (anonymous raw.githubusercontent.com access), which is exactly the
  // ambiguity the note below is honest about.
  if (response.status === 404) {
    return { kind: "rows", rows: [], note: NO_EVENTS_FILE_NOTE, bytesFetched: 0 };
  }
  if (!response.ok) {
    return { kind: "error", tsvPath, detail: `HTTP ${response.status}` };
  }

  const text = await response.text();
  const contentLengthHeader = response.headers.get("content-length");
  const bytesFetched = contentLengthHeader
    ? Number(contentLengthHeader)
    : new TextEncoder().encode(text).length;

  const parsed = parseEventsTsvText(text);
  const lower = parsed.columns.map((c) => c.toLowerCase());
  const onsetCol = lower.indexOf("onset");
  const durationCol = lower.indexOf("duration");
  const trialTypeCol = lower.indexOf("trial_type");
  const valueCol = lower.indexOf("value");
  const hedCol = lower.indexOf("hed");

  const rows: EventRow[] = [];
  for (const fields of parsed.rows) {
    const onsetRaw = cellOrNull(fields, onsetCol);
    if (onsetRaw === null) continue;
    const onsetS = Number(onsetRaw);
    if (!Number.isFinite(onsetS)) continue;
    const durationRaw = cellOrNull(fields, durationCol);
    const durationS = durationRaw === null ? null : Number(durationRaw);
    rows.push({
      store_path: storeZarr,
      group_name: groupName,
      onset_s: onsetS,
      duration_s: durationS !== null && Number.isFinite(durationS) ? durationS : null,
      sample_index: Math.floor(onsetS * rate + 0.5),
      trial_type: cellOrNull(fields, trialTypeCol),
      value: cellOrNull(fields, valueCol),
      hed: cellOrNull(fields, hedCol),
    });
  }
  return { kind: "rows", rows, note: null, bytesFetched };
}

export async function getEventsTool(
  deps: RecordingToolDeps,
  args: GetEventsInput,
): Promise<ToolOutcome> {
  const row = await loadPublicDatasetRow(deps.env.DB, args.dataset_id);
  if (!row) {
    return { result: datasetNotFoundResult(args.dataset_id) };
  }
  if (!isZarrReady(row)) {
    return { result: zarrNotReadyResult(args.dataset_id, row) };
  }

  const loaded = await loadRecordingsProjection(deps, row, args.dataset_id);
  if (!loaded.ok) {
    return { result: loaded.result };
  }
  const { projection, upstreamBytes: recordingsBytes } = loaded;

  const matched = resolveRecording(projection, args.recording);
  if (!matched) {
    return { result: recordingNotFoundResult(args.dataset_id, args.recording, projection) };
  }

  // Resolve `group` exactly as render_overview does: an explicit group that
  // does not exist on this recording is a tool error naming the real group
  // names, never a confident-looking empty result (found in PR review --
  // previously a typo in `group` silently answered `events: []`).
  const groups = matched.groups ?? [];
  let targetGroup: (typeof groups)[number] | undefined;
  if (args.group) {
    targetGroup = groups.find((g) => g.name === args.group);
    if (!targetGroup) {
      return {
        result: groupNotFoundResult(
          args.dataset_id,
          args.recording,
          args.group,
          groups.map((g) => g.name),
        ),
      };
    }
  } else {
    targetGroup = groups[0];
  }

  const sourceCommitFinal = projection.sourceCommit || null;
  const eventsParquetUrl = projection.eventsParquetUrl;

  let rows: EventRow[];
  let source: GetEventsOutput["source"];
  let estimated: boolean;
  let note: string | null = null;
  let cacheStatus: "hit" | "miss" = "miss";
  let upstreamBytes = 0;

  if (eventsParquetUrl) {
    // The parquet is the data source whenever the index names one --
    // `sourceCommitFinal` gates the CACHE only (see the module doc); never
    // fall through to the strictly-worse tsv fallback just because a
    // commit happens to be unusable for caching.
    let result: Awaited<ReturnType<typeof loadEventsFromParquet>>;
    try {
      result = await loadEventsFromParquet(
        deps,
        args.dataset_id,
        sourceCommitFinal,
        eventsParquetUrl,
        matched.zarr,
        projection.recordings.map((r) => r.zarr),
      );
    } catch (err) {
      return {
        result: parquetReadFailedResult(
          args.dataset_id,
          args.recording,
          err instanceof Error ? err.message : String(err),
        ),
      };
    }
    rows = result.rows;
    source = "events_parquet";
    estimated = false;
    cacheStatus = result.cacheStatus;
    upstreamBytes = result.upstreamBytes;
    const notes: string[] = [];
    if (rows.length === 0) notes.push(NO_PARQUET_ROWS_NOTE);
    if (result.invalidRowCount > 0) {
      notes.push(`${result.invalidRowCount} row(s) failed validation and were omitted`);
    }
    if (notes.length > 0) note = notes.join(" ");
  } else {
    const ref =
      sourceCommitFinal && SOURCE_COMMIT_RE.test(sourceCommitFinal) ? sourceCommitFinal : "main";
    const fallback = await loadEventsFromTsvFallback(
      deps,
      args.dataset_id,
      matched.path,
      ref,
      matched.zarr,
      targetGroup?.name ?? "",
      targetGroup?.rate ?? null,
    );
    if (fallback.kind === "error") {
      return {
        result: tsvFetchFailedResult(
          args.dataset_id,
          args.recording,
          fallback.tsvPath,
          fallback.detail,
        ),
      };
    }
    rows = fallback.rows;
    source = "events_tsv_fallback";
    estimated = true;
    note = fallback.note;
    upstreamBytes = fallback.bytesFetched;
    // The fallback always reads through raw.githubusercontent.com, which is
    // not the projection cache -- reported as a "miss" every time (never a
    // "hit"), matching the recordings-cache-bypass convention for an
    // unusable commit.
    cacheStatus = "miss";
  }

  if (args.group) {
    // Filter by the RESOLVED group name, not the raw `args.group` string --
    // identical today (a match was required above), but this is the
    // correct source of truth going forward.
    const resolvedName = (targetGroup as (typeof groups)[number]).name;
    rows = rows.filter((r) => r.group_name === resolvedName);
  }

  const totalCount = rows.length;
  const page = rows.slice(args.offset, args.offset + args.limit);
  const truncated = args.offset + page.length < totalCount;

  if (!sourceCommitFinal) {
    note = note ? `${note} ${NO_COMMIT_NOTE}` : NO_COMMIT_NOTE;
  }

  let envelope: GetEventsOutput["envelope"];
  if (sourceCommitFinal) {
    const built = buildEnvelopeForStore({
      indexFacts: projection.indexFacts,
      sourceCommit: sourceCommitFinal,
      indexEtag: projection.indexEtag,
      row,
      store: {
        path: matched.path,
        source_tree: matched.source_tree,
        derived: matched.derived,
        sss: matched.sss,
        units_report: matched.units_report,
      },
      group: targetGroup,
      dtype: null,
    });
    envelope = built.envelope ?? undefined;
    if (built.note && !note) note = built.note;
  }

  const output = getEventsOutputSchema.parse({
    dataset_id: args.dataset_id,
    recording: args.recording,
    events: page,
    source,
    estimated,
    total_count: totalCount,
    limit: args.limit,
    offset: args.offset,
    truncated,
    note,
    envelope,
  } satisfies GetEventsOutput);

  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    },
    // `cacheStatus` reflects the EVENTS cache specifically (the fact the
    // definition-of-done test cares about: "the second call served from
    // the per-store cache entry"); `upstreamBytes` sums whatever bytes were
    // actually fetched -- the recordings-projection read (when it missed
    // too) plus the events read (parquet OR the tsv fallback).
    metrics: { cacheStatus, upstreamBytes: upstreamBytes + recordingsBytes },
  };
}

/** Re-exported for tests that need to assert on the `_stores` summary
 *  schema shape directly. */
export { eventsStoresSummarySchema };
