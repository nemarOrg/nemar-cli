/**
 * `get_events` (epic #1065 phase 3, issue #1295; plan decision 7).
 *
 * **Primary path** (`index.events_parquet` present, every v3 index that
 * parsed at least one events.tsv): reads the WHOLE parquet file once with
 * `hyparquet` on a per-store cache miss, groups rows by `store_path` (the
 * producer's own name for the store's `zarr` path --
 * `scripts/zarr/generate_zarr.py`'s `events_schema`), and writes EVERY
 * store's rows (`events/<zarr>`) plus a store-list summary
 * (`events/_stores`) to the projection cache in one pass -- one dataset-wide
 * parquet read serves every recording's future `get_events` call, not just
 * the one this request named. `sample_index` comes back from hyparquet as a
 * `BigInt` (parquet INT64); converted to `Number` here, once, before the
 * value is cached or returned. `source: "events_parquet"`, `estimated: false`
 * always on this path -- the converter's own `sample_index` column
 * (`Math.floor(onset_s * rate + 0.5)` against the SERVING rate) is exact.
 *
 * **Codec: a hand-rolled ZSTD-only `compressors` map, not the
 * `hyparquet-compressors` package.** The plan named `hyparquet-compressors`
 * for zstd support, and its own `ZSTD` entry is exactly `decompressZstd`
 * from `fzstd` (the same pure-JS decoder `blosc-decode.ts` already uses,
 * no WASM). But importing that PACKAGE also eagerly constructs its `SNAPPY`
 * entry at module load (`snappyUncompressor()` from the `hysnappy`
 * dependency), which compiles a WASM module synchronously --
 * `WebAssembly.Module(): Wasm code generation disallowed by embedder`,
 * reproduced under real workerd via `bunx wrangler dev --local` against
 * `mcp-smoke-entry.ts`, the SAME failure class `blosc-decode.ts`'s module
 * doc documents for `numcodecs`. This crashes the WHOLE bundle at
 * isolate startup, for every request, not just a `get_events` call --
 * unacceptable regardless of whether any dataset's parquet ever uses
 * SNAPPY (none does today: every column in the live nm000329 fixture is
 * ZSTD). So `hyparquet-compressors` was removed from `package.json`, and
 * this file builds the one-entry `compressors` map itself, straight from
 * `fzstd` -- functionally identical to what the package would have
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
 * wherever source and target rates are not integer multiples. A 404 (a
 * missing file, OR a private repo, which reads identically to an anonymous
 * GET) answers `events: []` with a note; BIDS inheritance (walking up to a
 * session/subject/root-level events.tsv) is explicitly out of scope, and
 * the note says so.
 *
 * Never the data host (`data.nemar.org`): its file branch is a redirect,
 * not something this Worker can read in-process (`routes/data.ts` has no
 * injectable `fetch`).
 */

import { decompress as fzstdDecompress } from "fzstd";
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import type { Compressors } from "hyparquet";
import {
  type EventRow,
  type GetEventsInput,
  type GetEventsOutput,
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
import { buildEnvelopeForStore } from "../envelope.js";
import { projectionUrl, readJsonProjection, writeJsonProjection } from "../projection-cache.js";
import type { RecordingToolDeps, ToolOutcome } from "../tool-types.js";
import {
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

function toNumberSampleIndex(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return Number(value);
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

async function readWholeEventsParquet(
  deps: RecordingToolDeps,
  eventsParquetUrl: string,
): Promise<{ byStore: Map<string, EventRow[]>; bytesFetched: number }> {
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
  for (const raw of rawRows) {
    const storePath = String((raw as { store_path?: unknown }).store_path ?? "");
    const row = {
      ...raw,
      sample_index: toNumberSampleIndex((raw as { sample_index?: unknown }).sample_index),
    } as EventRow;
    const list = byStore.get(storePath);
    if (list) list.push(row);
    else byStore.set(storePath, [row]);
  }
  return { byStore, bytesFetched };
}

/** Primary path: `events/<zarr>` cache entry per store, all written in one
 *  pass on a miss (see module doc). */
async function loadEventsFromParquet(
  deps: RecordingToolDeps,
  datasetId: string,
  sourceCommit: string,
  eventsParquetUrl: string,
  storeZarr: string,
): Promise<{ rows: EventRow[]; cacheStatus: "hit" | "miss"; upstreamBytes: number }> {
  const cacheKey = projectionUrl(datasetId, sourceCommit, `events/${storeZarr}`);
  const cached = await readJsonProjection<EventRow[]>(deps.cache(), cacheKey);
  if (cached.status === "hit") {
    return { rows: cached.value, cacheStatus: "hit", upstreamBytes: 0 };
  }

  const { byStore, bytesFetched } = await readWholeEventsParquet(deps, eventsParquetUrl);
  const storesSummary: EventsStoresSummaryEntry[] = [];
  for (const [zarr, rows] of byStore.entries()) {
    writeJsonProjection(
      deps.executionCtx,
      deps.cache(),
      projectionUrl(datasetId, sourceCommit, `events/${zarr}`),
      rows,
    );
    storesSummary.push({ zarr, rowCount: rows.length });
  }
  writeJsonProjection(
    deps.executionCtx,
    deps.cache(),
    projectionUrl(datasetId, sourceCommit, "events/_stores"),
    storesSummary,
  );

  return { rows: byStore.get(storeZarr) ?? [], cacheStatus: "miss", upstreamBytes: bytesFetched };
}

interface ParsedEventsTsv {
  columns: string[];
  rows: string[][];
}

/** Mirrors `parse_events_tsv` in `scripts/zarr/generate_zarr.py`: strip a
 *  leading UTF-8 BOM (a spreadsheet-exported events.tsv can carry one, which
 *  would otherwise poison the first column's name), drop blank lines
 *  anywhere, tab-split. */
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

async function loadEventsFromTsvFallback(
  deps: RecordingToolDeps,
  datasetId: string,
  storePath: string,
  ref: string,
  storeZarr: string,
  groupName: string,
  rate: number | null,
): Promise<{ rows: EventRow[]; note: string | null }> {
  if (rate === null) {
    return { rows: [], note: NO_RATE_NOTE };
  }
  const tsvPath = siblingEventsTsvPath(storePath);
  const url = rawContentUrl(deps.rawGithubBase, datasetId, ref, tsvPath);
  const response = await deps.fetch(url, { headers: { "User-Agent": "nemar-mcp" } });
  if (response.status === 404) {
    return { rows: [], note: NO_EVENTS_FILE_NOTE };
  }
  if (!response.ok) {
    return {
      rows: [],
      note: `events.tsv fetch for "${tsvPath}" answered HTTP ${response.status}`,
    };
  }
  const text = await response.text();
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
  return { rows, note: null };
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

  const sourceCommitFinal = projection.sourceCommit || null;
  const targetGroup = args.group
    ? matched.groups?.find((g) => g.name === args.group)
    : matched.groups?.[0];

  const eventsParquetUrl = projection.eventsParquetUrl;

  let rows: EventRow[];
  let source: GetEventsOutput["source"];
  let estimated: boolean;
  let note: string | null = null;
  let cacheStatus: "hit" | "miss" = "miss";
  let upstreamBytes = 0;

  if (eventsParquetUrl && sourceCommitFinal) {
    const result = await loadEventsFromParquet(
      deps,
      args.dataset_id,
      sourceCommitFinal,
      eventsParquetUrl,
      matched.zarr,
    );
    rows = result.rows;
    source = "events_parquet";
    estimated = false;
    cacheStatus = result.cacheStatus;
    upstreamBytes = result.upstreamBytes;
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
    rows = fallback.rows;
    source = "events_tsv_fallback";
    estimated = true;
    note = fallback.note;
    // The fallback always reads through raw.githubusercontent.com, which is
    // not the projection cache -- reported as a "miss" every time (never a
    // "hit"), matching the recordings-cache-bypass convention for an
    // unusable commit.
    cacheStatus = "miss";
  }

  if (args.group) {
    rows = rows.filter((r) => r.group_name === args.group);
  }

  const totalCount = rows.length;
  const page = rows.slice(args.offset, args.offset + args.limit);
  const truncated = args.offset + page.length < totalCount;

  if (!sourceCommitFinal) {
    note = note ? `${note} ${projection.note ?? ""}`.trim() : projection.note;
  }

  let envelope: GetEventsOutput["envelope"];
  if (sourceCommitFinal) {
    const built = buildEnvelopeForStore({
      indexFacts: projection.indexFacts,
      sourceCommit: sourceCommitFinal,
      indexEtag: projection.indexEtag,
      row,
      store: { path: matched.path, source_tree: matched.source_tree, derived: matched.derived },
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
    // too) plus the events read.
    metrics: { cacheStatus, upstreamBytes: upstreamBytes + recordingsBytes },
  };
}
