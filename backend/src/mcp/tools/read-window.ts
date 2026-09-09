/**
 * `read_window` (epic #1065 phase 4, issue #1296; ADR 0049's recipe-first
 * posture). The last MCP tool, and the one that would move the most bytes
 * through the Worker if implemented naively: recipe mode (the default) hands
 * out a `zarr`/`zarrita`/`s3` read recipe with ZERO signal bytes touched;
 * taste mode decodes a small, capped window inline for a quick sanity check.
 *
 * **Recipe mode makes no reads beyond `index.json`.** Unlike
 * `list_recordings`/`get_events`/`render_overview`, this tool does NOT read
 * or write the `recordings` projection cache (`list-recordings.ts`) --
 * `buildReadRecipe` needs the FULL index document (`contract_base`,
 * `data_base`, `s3_uri`, `layout`, and each group's `chunk_samples`/
 * `shard_samples`), none of which the compact `RecordingsProjection` carries.
 * So this tool calls `readZarrIndex` directly (the same function
 * `loadRecordingsProjection` calls internally on its own cache miss),
 * relying on the zarr sub-app's OWN edge cache for `index.json` -- exactly
 * the design doc's "one index.json read (cached through the zarr sub-app, the
 * phase 3 readZarrIndex path) and nothing else." `buildReadRecipe` is called
 * WITHOUT `arrayMetadata` in recipe mode, so `dtype` is null and `codecs`
 * absent; the envelope's `dtype` is null too (nothing was read).
 *
 * **A v1/v2 index is a typed refusal**, not degraded service: no legacy
 * document carries `layout`/`data_base`/per-group `chunk_samples`/
 * `shard_samples`, so no recipe is computable at all.
 * `list_recordings`/`get_events` still work against that dataset's current
 * index; this tool cannot, until the ADR 0033 engine bump re-converts it.
 * Similarly, a v3 group missing `chunk_samples`/`shard_samples` on its OWN
 * entry answers a typed refusal when `taste` is requested (never a silent
 * downgrade to a recipe result -- the same "an error is impossible to
 * misread" reasoning the taste-cap rejection below uses); the error
 * text says a recipe IS computable for that group by retrying without
 * `taste`.
 *
 * **Taste mode reads inner chunks only, never a whole shard.** Level 0 is a
 * SHARDED array (`sharding.ts`'s module doc has the full geometry); a taste
 * fetches exactly the shard footers and inner-chunk byte ranges the
 * requested window spans, via `Range` requests straight to `index.data_base`
 * (the same path `render_overview`'s chunk fetches use, never through the
 * zarr sub-app). Adjacent, byte-contiguous chunks within one shard coalesce
 * into one `Range` request (`sharding.ts`'s `planShardReads`); an absent
 * inner chunk (the Zarr `2^64 - 1` marker) contributes the fill value with
 * no fetch at all. Two projection-cache kinds back this
 * (`array/<zarr>/<group>/0` for the level-0 `zarr.json`,
 * `shardidx/<zarr>/<group>/0/<j>` for one shard's parsed footer), both
 * immutable per `(dataset_id, source_commit)`; decoded WINDOWS are never
 * cached -- a taste is an inline decode of a specific window on demand.
 *
 * **Three caps guard a taste**, none of them the phase 1 product-only check
 * alone (see `shared/contract/mcp.ts`'s `READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES`
 * doc for the measured reason): `READ_WINDOW_TASTE_MAX_DURATION_S` (60) and
 * `READ_WINDOW_TASTE_MAX_CHANNELS` (64) are schema-level hard caps
 * (`readWindowInputSchema`'s `superRefine`); `READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES`
 * (65,536) cannot be schema-enforced (the schema does not know a group's
 * rate) and is checked here, right after the group's rate is known, naming
 * the rate, the computed `channels.length x n_samples`, the cap, and the two
 * ways to get under it.
 *
 * **The taste response is not duplicated into `content`.** Every other tool
 * puts `JSON.stringify(output)` in both `content` and `structuredContent`;
 * for a taste at the cap that would put ~900 KB of numbers in `content`
 * twice. Taste mode's `content` is a compact one-line summary instead
 * (shape, rate, sample range, bytes/chunks read, the first few values of the
 * first channel); `structuredContent` still carries the full object. Recipe
 * mode keeps the both-places convention -- it is small.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES,
  type ReadWindowInput,
  type ReadWindowOutput,
  buildReadRecipe,
  readWindowOutputSchema,
} from "../../../../shared/contract/mcp.js";
import type { ZarrGroup, ZarrIndex, ZarrStore } from "../../../../shared/contract/zarr-index.js";
import { decodeBloscZstdInt16 } from "../../services/blosc-decode.js";
import { type Level0ArrayMetadata, loadLevel0ArrayMetadata } from "../array-metadata.js";
import {
  type PublicDatasetRow,
  datasetNotFoundResult,
  isZarrReady,
  loadPublicDatasetRow,
  zarrNotReadyResult,
} from "../catalog-row.js";
import { type EnvelopeIndexFacts, buildEnvelopeForStore } from "../envelope.js";
import { isV3Index, readZarrIndex } from "../index-reader.js";
import { projectionUrl, readJsonProjection, writeJsonProjection } from "../projection-cache.js";
import {
  type ChunkRead,
  type ShardIndexEntry,
  chunkSampleSpan,
  footerByteLength,
  innerIndicesForWindowInShard,
  nInnerForShard,
  parseShardFooter,
  planShardReads,
  shardEntriesFromPairs,
  shardEntriesToPairs,
  shardsForWindow,
} from "../sharding.js";
import { type DecodedSegment, TASTE_SIGNIFICANT_DIGITS, assembleTasteValues } from "../taste.js";
import type { RecordingToolDeps, ToolOutcome } from "../tool-types.js";

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function v1RefusalResult(datasetId: string, formatVersion: number): CallToolResult {
  return toolError(
    `Dataset "${datasetId}" still publishes index format v${formatVersion}; read_window needs format_version 3 (no v1/v2 document carries the layout, data_base, or per-group chunk_samples/shard_samples fields a recipe or a taste read requires). Re-conversion under engine version 3 (ADR 0033's engine bump) is pending. list_recordings and get_events still work on this dataset's current index.`,
  );
}

function recordingNotFoundResult(
  datasetId: string,
  recording: string,
  stores: ZarrStore[],
): CallToolResult {
  const sample = stores.slice(0, 20).map((s) => s.zarr);
  const more = stores.length > 20 ? ` (and ${stores.length - 20} more)` : "";
  return toolError(
    `Recording "${recording}" was not found in dataset "${datasetId}" (matched against each ` +
      `recording's path or zarr field). Known recordings: ${sample.join(", ") || "(none)"}${more}.`,
  );
}

function groupNotFoundResult(
  datasetId: string,
  recording: string,
  wanted: string,
  available: string[],
): CallToolResult {
  return toolError(
    `Recording "${recording}" in dataset "${datasetId}" has no group named "${wanted}". ` +
      `Available groups: ${available.join(", ") || "(none)"}.`,
  );
}

function missingGeometryResult(
  datasetId: string,
  recording: string,
  groupName: string,
): CallToolResult {
  return toolError(
    `Group "${groupName}" of recording "${recording}" in dataset "${datasetId}" is missing the sample count, channel count, or sampling rate read_window needs to plan a read.`,
  );
}

function durationOutOfRangeResult(opts: {
  datasetId: string;
  recording: string;
  groupName: string;
  startS: number;
  durationS: number;
  nSamples: number;
  rate: number;
}): CallToolResult {
  const { datasetId, recording, groupName, startS, durationS, nSamples, rate } = opts;
  const recordingDurationS = nSamples / rate;
  const requestedEndS = startS + durationS;
  return toolError(
    `The requested window (start_s ${startS} + duration_s ${durationS} = ${requestedEndS} s) is ` +
      `past group "${groupName}" of recording "${recording}" in dataset "${datasetId}"'s duration ` +
      `(${recordingDurationS} s, ${nSamples} samples at ${rate} Hz). Shorten duration_s or lower start_s.`,
  );
}

function channelOutOfRangeResult(opts: {
  datasetId: string;
  recording: string;
  groupName: string;
  channel: number;
  nChannels: number;
}): CallToolResult {
  const { datasetId, recording, groupName, channel, nChannels } = opts;
  return toolError(
    `Channel index ${channel} is at or past group "${groupName}" of recording "${recording}" in ` +
      `dataset "${datasetId}"'s n_channels (${nChannels}). list_recordings reports the actual channel count.`,
  );
}

function noShardingGeometryResult(
  datasetId: string,
  recording: string,
  groupName: string,
): CallToolResult {
  return toolError(
    `Group "${groupName}" of recording "${recording}" in dataset "${datasetId}" carries no chunk_samples/shard_samples on its v3 index entry, so read_window cannot plan a taste read for it. A recipe is still computable for this group (with those fields null) -- retry with taste omitted.`,
  );
}

function channelSamplesCapResult(opts: {
  datasetId: string;
  recording: string;
  groupName: string;
  channelCount: number;
  windowSamples: number;
  rate: number;
}): CallToolResult {
  const { datasetId, recording, groupName, channelCount, windowSamples, rate } = opts;
  const product = channelCount * windowSamples;
  return toolError(
    `read_window taste for group "${groupName}" of recording "${recording}" in dataset "${datasetId}" would decode ${product} channel-samples (${channelCount} channels x ${windowSamples} samples at ${rate} Hz), over the ${READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES} cap. Ask for fewer channels or a shorter window, or omit taste for a recipe.`,
  );
}

/** Cached shard-footer payload shape: `[offset, nbytes]` pairs, `[-1, -1]`
 *  meaning absent (`sharding.ts`'s `shardEntriesToPairs`/`shardEntriesFromPairs`). */
const shardIndexProjectionSchema = z.array(z.tuple([z.number(), z.number()]));

interface ShardFooterLoaded {
  entries: ShardIndexEntry[];
  cacheStatus: "hit" | "miss";
  bytes: number;
}

async function loadShardFooter(
  deps: RecordingToolDeps,
  datasetId: string,
  sourceCommit: string,
  dataBase: string,
  zarr: string,
  groupName: string,
  shardIndex: number,
  nInner: number,
): Promise<ShardFooterLoaded | { error: string }> {
  const cacheKey = projectionUrl(
    datasetId,
    sourceCommit,
    `shardidx/${zarr}/${groupName}/0/${shardIndex}`,
  );
  const cached = await readJsonProjection(deps.cache(), cacheKey, shardIndexProjectionSchema);
  if (cached.status === "hit") {
    return { entries: shardEntriesFromPairs(cached.value), cacheStatus: "hit", bytes: 0 };
  }

  const footerLen = footerByteLength(nInner);
  const url = `${dataBase}${zarr}/${groupName}/0/c/0/${shardIndex}`;
  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { Range: `bytes=-${footerLen}` } });
  } catch (err) {
    return {
      error: `network error fetching shard footer ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (response.status !== 206 && response.status !== 200) {
    return { error: `HTTP ${response.status} fetching shard footer ${url}` };
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.length !== footerLen) {
    return { error: `shard footer ${url} returned ${buf.length} bytes, expected ${footerLen}` };
  }
  let entries: ShardIndexEntry[];
  try {
    entries = parseShardFooter(buf, nInner);
  } catch (err) {
    return {
      error: `shard footer ${url} failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  writeJsonProjection(deps.executionCtx, deps.cache(), cacheKey, shardEntriesToPairs(entries));
  return { entries, cacheStatus: "miss", bytes: buf.length };
}

interface RangeReadResult {
  segments: DecodedSegment[];
  bytes: number;
}

/** Fetch and decode one coalesced `"range"` read -- one HTTP `Range` GET,
 *  possibly covering several inner chunks, sliced apart per {@link entries}'
 *  own recorded byte offsets and decoded individually. */
async function fetchAndDecodeRangeRead(opts: {
  deps: RecordingToolDeps;
  dataBase: string;
  zarr: string;
  groupName: string;
  shardIndex: number;
  read: ChunkRead;
  entries: ShardIndexEntry[];
  nChannelsInStore: number;
  shardSamples: number;
  chunkSamples: number;
  nSamplesTotal: number;
}): Promise<RangeReadResult | { error: string }> {
  const {
    deps,
    dataBase,
    zarr,
    groupName,
    shardIndex,
    read,
    entries,
    nChannelsInStore,
    shardSamples,
    chunkSamples,
    nSamplesTotal,
  } = opts;
  const url = `${dataBase}${zarr}/${groupName}/0/c/0/${shardIndex}`;
  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { Range: `bytes=${read.start}-${read.end}` } });
  } catch (err) {
    return {
      error: `network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (response.status !== 206 && response.status !== 200) {
    return { error: `HTTP ${response.status} fetching ${url}` };
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  const runStart = read.start as number;
  const segments: DecodedSegment[] = [];
  for (const localIndex of read.localIndices) {
    const entry = entries[localIndex];
    const relStart = entry.offset - runStart;
    const chunkBytes = buf.subarray(relStart, relStart + entry.nbytes);
    let decoded: Int16Array;
    try {
      decoded = decodeBloscZstdInt16(chunkBytes);
    } catch (err) {
      return {
        error: `shard ${shardIndex} chunk ${localIndex} failed to decode: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const span = chunkSampleSpan({
      shardIndex,
      localIndex,
      shardSamples,
      chunkSamples,
      nSamples: nSamplesTotal,
    });
    const expectedLen = nChannelsInStore * (span.end - span.start);
    if (decoded.length !== expectedLen) {
      return {
        error:
          `shard ${shardIndex} chunk ${localIndex} decoded to ${decoded.length} values, expected ` +
          `${expectedLen} (${nChannelsInStore} channels x ${span.end - span.start} samples)`,
      };
    }
    segments.push({ start: span.start, end: span.end, data: decoded });
  }
  return { segments, bytes: buf.length };
}

function resolveIndexFacts(index: ZarrIndex): EnvelopeIndexFacts {
  return {
    datasetId: index.dataset_id,
    engineVersion: index.engine_version,
    doi: index.doi ?? null,
    license: index.license ?? null,
    citation: index.citation ?? null,
    isLegacy: false,
  };
}

function envelopeStoreInput(store: ZarrStore) {
  return {
    path: store.path,
    source_tree: store.source_tree,
    derived: store.derived,
    sss: store.sss,
    units_report: store.units_report,
  };
}

function buildTasteSummary(output: Extract<ReadWindowOutput, { mode: "taste" }>): string {
  const nSamples = output.values[0]?.length ?? 0;
  const head = output.values[0]?.slice(0, 5) ?? [];
  return (
    `read_window taste: shape=[${output.channels.length},${nSamples}] rate_hz=${output.sample_rate_hz} ` +
    `start_s=${output.start_s} duration_s=${output.duration_s} bytes_read=${output.bytes_read} ` +
    `chunks_read=${output.chunks_read} first_channel_head=${JSON.stringify(head)}`
  );
}

export async function readWindowTool(
  deps: RecordingToolDeps,
  args: ReadWindowInput,
): Promise<ToolOutcome> {
  const row: PublicDatasetRow | null = await loadPublicDatasetRow(deps.env.DB, args.dataset_id);
  if (!row) {
    return { result: datasetNotFoundResult(args.dataset_id) };
  }
  if (!isZarrReady(row)) {
    return { result: zarrNotReadyResult(args.dataset_id, row) };
  }

  const indexResult = await readZarrIndex(deps, deps.env, deps.executionCtx, args.dataset_id);
  if (indexResult.status === "not_found") {
    return {
      result: toolError(
        `Dataset "${args.dataset_id}" reports zarr_status "${row.zarr_status}" but its index.json could not be found -- this is a transient inconsistency; try again shortly.`,
      ),
    };
  }
  if (indexResult.status === "invalid") {
    return {
      result: toolError(
        `index.json for "${args.dataset_id}" could not be read: ${indexResult.detail}`,
      ),
    };
  }
  if (!isV3Index(indexResult.index)) {
    return { result: v1RefusalResult(args.dataset_id, indexResult.formatVersion) };
  }
  const index: ZarrIndex = indexResult.index;

  const store = index.stores.find((s) => s.path === args.recording || s.zarr === args.recording);
  if (!store) {
    return { result: recordingNotFoundResult(args.dataset_id, args.recording, index.stores) };
  }

  const groups: ZarrGroup[] = store.groups ?? [];
  const targetGroup = args.group ? groups.find((g) => g.name === args.group) : groups[0];
  if (!targetGroup) {
    return {
      result: groupNotFoundResult(
        args.dataset_id,
        args.recording,
        args.group ?? "(default: first group)",
        groups.map((g) => g.name),
      ),
    };
  }

  const rate = targetGroup.rate;
  const nSamplesGroup = targetGroup.n_samples;
  const nChannelsGroup = targetGroup.n_channels;
  if (
    !rate ||
    rate <= 0 ||
    !nSamplesGroup ||
    nSamplesGroup < 1 ||
    !nChannelsGroup ||
    nChannelsGroup < 1
  ) {
    return { result: missingGeometryResult(args.dataset_id, args.recording, targetGroup.name) };
  }

  // The converter's own sample_index_for rounding rule (scripts/zarr/generate_zarr.py):
  // ties round UP, deliberately not Math.round's banker's rounding.
  const startSample = Math.floor(args.start_s * rate + 0.5);
  const requestedSamples = Math.floor(args.duration_s * rate + 0.5);
  const endSample = startSample + requestedSamples;
  if (startSample >= nSamplesGroup || endSample > nSamplesGroup) {
    return {
      result: durationOutOfRangeResult({
        datasetId: args.dataset_id,
        recording: args.recording,
        groupName: targetGroup.name,
        startS: args.start_s,
        durationS: args.duration_s,
        nSamples: nSamplesGroup,
        rate,
      }),
    };
  }
  if (args.channels) {
    const badChannel = args.channels.find((c) => c >= nChannelsGroup);
    if (badChannel !== undefined) {
      return {
        result: channelOutOfRangeResult({
          datasetId: args.dataset_id,
          recording: args.recording,
          groupName: targetGroup.name,
          channel: badChannel,
          nChannels: nChannelsGroup,
        }),
      };
    }
  }

  const indexFacts = resolveIndexFacts(index);

  if (!args.taste) {
    const sampleSlice = { start: startSample, end: endSample };
    const channelSlice =
      args.channels && args.channels.length > 0
        ? { start: Math.min(...args.channels), end: Math.max(...args.channels) + 1 }
        : undefined;
    const recipe = buildReadRecipe({
      index,
      store,
      groupName: targetGroup.name,
      level: "0",
      sampleSlice,
      channelSlice,
    });
    const built = buildEnvelopeForStore({
      indexFacts,
      sourceCommit: index.source_commit,
      indexEtag: indexResult.etag,
      row,
      store: envelopeStoreInput(store),
      group: targetGroup,
      dtype: null,
    });
    if (!built.envelope) {
      return {
        result: toolError(
          `internal: dataset "${args.dataset_id}" has a v3 index but no usable source_commit for its envelope`,
        ),
      };
    }
    const output = readWindowOutputSchema.parse({
      mode: "recipe",
      recipe,
      envelope: built.envelope,
    } satisfies ReadWindowOutput);
    return {
      result: {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      },
      metrics: { cacheStatus: "none", upstreamBytes: 0 },
    };
  }

  // Taste mode from here.
  const channels = args.channels as number[]; // schema guarantees presence when taste is true
  if (!targetGroup.chunk_samples || !targetGroup.shard_samples) {
    return { result: noShardingGeometryResult(args.dataset_id, args.recording, targetGroup.name) };
  }
  const chunkSamples = targetGroup.chunk_samples;
  const shardSamples = targetGroup.shard_samples;

  const windowSamples = endSample - startSample;
  if (channels.length * windowSamples > READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES) {
    return {
      result: channelSamplesCapResult({
        datasetId: args.dataset_id,
        recording: args.recording,
        groupName: targetGroup.name,
        channelCount: channels.length,
        windowSamples,
        rate,
      }),
    };
  }

  const arrayMeta = await loadLevel0ArrayMetadata(
    deps,
    args.dataset_id,
    index.source_commit,
    index.data_base,
    store.zarr,
    targetGroup.name,
  );
  if (!arrayMeta.ok) {
    return {
      result: toolError(
        `read_window could not read the level-0 array metadata for recording "${args.recording}" ` +
          `in dataset "${args.dataset_id}": ${arrayMeta.detail}`,
      ),
    };
  }
  const metadata: Level0ArrayMetadata = arrayMeta.metadata;
  if (metadata.scale.length < nChannelsGroup || metadata.offset.length < nChannelsGroup) {
    return {
      result: toolError(
        `level-0 array metadata for recording "${args.recording}" in dataset "${args.dataset_id}" carries scale[]/offset[] shorter than n_channels (${nChannelsGroup}); read_window cannot convert digital values to physical units.`,
      ),
    };
  }

  let cacheHitEverywhere = arrayMeta.cacheStatus === "hit";
  let bytesRead = arrayMeta.upstreamBytes;
  let chunksRead = 0;
  const segments: DecodedSegment[] = [];

  const shardIndices = shardsForWindow(startSample, endSample, shardSamples);
  for (const shardIndex of shardIndices) {
    const nInner = nInnerForShard({
      shardIndex,
      shardSamples,
      chunkSamples,
      nSamples: nSamplesGroup,
    });
    const footer = await loadShardFooter(
      deps,
      args.dataset_id,
      index.source_commit,
      index.data_base,
      store.zarr,
      targetGroup.name,
      shardIndex,
      nInner,
    );
    if ("error" in footer) {
      return {
        result: toolError(
          `read_window could not read the shard index for recording "${args.recording}" in dataset ` +
            `"${args.dataset_id}": ${footer.error}`,
        ),
      };
    }
    cacheHitEverywhere = cacheHitEverywhere && footer.cacheStatus === "hit";
    bytesRead += footer.bytes;

    const localIndices = innerIndicesForWindowInShard({
      shardIndex,
      shardSamples,
      chunkSamples,
      nInnerThisShard: nInner,
      startSample,
      endSampleExclusive: endSample,
    });
    const reads = planShardReads(footer.entries, localIndices);
    for (const read of reads) {
      if (read.kind === "absent") {
        const localIndex = read.localIndices[0];
        const span = chunkSampleSpan({
          shardIndex,
          localIndex,
          shardSamples,
          chunkSamples,
          nSamples: nSamplesGroup,
        });
        segments.push({ start: span.start, end: span.end, data: null });
        continue;
      }
      const fetched = await fetchAndDecodeRangeRead({
        deps,
        dataBase: index.data_base,
        zarr: store.zarr,
        groupName: targetGroup.name,
        shardIndex,
        read,
        entries: footer.entries,
        nChannelsInStore: nChannelsGroup,
        shardSamples,
        chunkSamples,
        nSamplesTotal: nSamplesGroup,
      });
      if ("error" in fetched) {
        return {
          result: toolError(
            `read_window could not read a chunk for recording "${args.recording}" in dataset ` +
              `"${args.dataset_id}": ${fetched.error}`,
          ),
        };
      }
      segments.push(...fetched.segments);
      bytesRead += fetched.bytes;
      chunksRead += read.localIndices.length;
    }
  }

  let values: number[][];
  try {
    values = assembleTasteValues({
      channels,
      startSample,
      nSamples: windowSamples,
      segments,
      scale: metadata.scale,
      offset: metadata.offset,
      fillValue: 0,
      significantDigits: TASTE_SIGNIFICANT_DIGITS,
    });
  } catch (err) {
    return {
      result: toolError(
        `read_window failed to assemble the taste for recording "${args.recording}" in dataset ` +
          `"${args.dataset_id}": ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  const channelSlice = { start: Math.min(...channels), end: Math.max(...channels) + 1 };
  const recipe = buildReadRecipe({
    index,
    store,
    groupName: targetGroup.name,
    level: "0",
    sampleSlice: { start: startSample, end: endSample },
    channelSlice,
    arrayMetadata: { data_type: metadata.dataType, codecs: metadata.codecs },
  });

  const built = buildEnvelopeForStore({
    indexFacts,
    sourceCommit: index.source_commit,
    indexEtag: indexResult.etag,
    row,
    store: envelopeStoreInput(store),
    group: targetGroup,
    dtype: metadata.dataType,
  });
  if (!built.envelope) {
    return {
      result: toolError(
        `internal: dataset "${args.dataset_id}" has a v3 index but no usable source_commit for its envelope`,
      ),
    };
  }

  const output = readWindowOutputSchema.parse({
    mode: "taste",
    start_s: startSample / rate,
    duration_s: windowSamples / rate,
    channels,
    sample_rate_hz: rate,
    values,
    recipe,
    chunks_read: chunksRead,
    bytes_read: bytesRead,
    note: "values are rounded to six significant digits; see recipe for the exact byte-level read",
    envelope: built.envelope,
  } satisfies ReadWindowOutput);

  return {
    result: {
      content: [
        {
          type: "text",
          text: buildTasteSummary(output as Extract<ReadWindowOutput, { mode: "taste" }>),
        },
      ],
      structuredContent: output,
    },
    metrics: { cacheStatus: cacheHitEverywhere ? "hit" : "miss", upstreamBytes: bytesRead },
  };
}
