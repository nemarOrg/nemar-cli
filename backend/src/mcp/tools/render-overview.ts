/**
 * `render_overview` (epic #1065 phase 3, issue #1295).
 *
 * Reads the `view/*` min-max pyramid, never level 0 and never `zarr.json`
 * -- every fact needed (level count, level-0 sample count, channel count,
 * chunk size) comes off the recording's group entry in the shared
 * `recordings` projection (`list-recordings.ts`), which is itself cached
 * per `(dataset_id, source_commit)`, so a `render_overview` call on a warm
 * dataset costs one D1 read, one `recordings` cache match, and (on an
 * `overview/*` cache MISS) exactly `chunks_read` chunk fetches -- nothing
 * else. `pickViewLevel` (`overview.ts`) always returns the COARSEST level
 * satisfying `width_px`, so the Worker never decodes more samples than the
 * image needs.
 *
 * The rendered PNG is cached whole under
 * `overview/<zarr>/<group>/<width_px>`; a cache HIT skips the chunk fetch,
 * the blosc decode, and the PNG encode entirely -- `level`/`width_px`/
 * `height_px` are still recomputed (cheap, no I/O: pure functions of
 * already-cached group metadata) so the response metadata is always
 * present, but `columns_read`/`chunks_read`/`bytes_read` are all `0` on a
 * hit, since nothing was actually read this call.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  type RenderOverviewInput,
  type RenderOverviewOutput,
  renderOverviewOutputSchema,
} from "../../../../shared/contract/mcp.js";
import type { RecordingGroupSummary } from "../../../../shared/contract/mcp.js";
import { decodeBloscZstdInt16 } from "../../services/blosc-decode.js";
import {
  type PublicDatasetRow,
  datasetNotFoundResult,
  isZarrReady,
  loadPublicDatasetRow,
  zarrNotReadyResult,
} from "../catalog-row.js";
import { buildEnvelopeForStore } from "../envelope.js";
import {
  buildChunkPlan,
  computeRowPx,
  computeViewLevelColumns,
  pickViewLevel,
  reassembleViewChunks,
  renderOverviewPng,
} from "../overview.js";
import { projectionUrl, readBinaryProjection, writeBinaryProjection } from "../projection-cache.js";
import type { RecordingToolDeps, ToolOutcome } from "../tool-types.js";
import {
  type RecordingsProjection,
  groupNotFoundResult,
  loadRecordingsProjection,
  recordingNotFoundResult,
  resolveRecording,
} from "./list-recordings.js";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Distinct from "group not found": the group exists but was converted
 *  before biosigio 1.2.6 (or came from a legacy index), so it has no
 *  `view/*` pyramid to read at all. */
function noPyramidResult(datasetId: string, recording: string, groupName: string): CallToolResult {
  return toolError(
    `Group "${groupName}" of recording "${recording}" in dataset "${datasetId}" has no view/* pyramid published (a legacy index, or a store converted before biosigio 1.2.6). render_overview needs a pyramid; list_recordings reports each group's n_view_levels.`,
  );
}

function missingGeometryResult(
  datasetId: string,
  recording: string,
  groupName: string,
): CallToolResult {
  return toolError(
    `Group "${groupName}" of recording "${recording}" in dataset "${datasetId}" is missing the sample count or channel count render_overview needs to plan a pyramid read.`,
  );
}

function missingIndexFactsResult(datasetId: string): CallToolResult {
  return toolError(
    `Dataset "${datasetId}"'s index.json carries no usable source_commit or data_base; render_overview cannot fetch pyramid chunks for it.`,
  );
}

function chunkFetchFailedResult(
  datasetId: string,
  recording: string,
  detail: string,
): CallToolResult {
  return toolError(
    `render_overview could not read the view pyramid for recording "${recording}" in dataset ` +
      `"${datasetId}": ${detail}`,
  );
}

export async function renderOverviewTool(
  deps: RecordingToolDeps,
  args: RenderOverviewInput,
): Promise<ToolOutcome> {
  const row: PublicDatasetRow | null = await loadPublicDatasetRow(deps.env.DB, args.dataset_id);
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

  const groups: RecordingGroupSummary[] = matched.groups ?? [];
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

  const nViewLevels = targetGroup.n_view_levels ?? 0;
  if (nViewLevels < 1) {
    return { result: noPyramidResult(args.dataset_id, args.recording, targetGroup.name) };
  }
  const nSamples = targetGroup.n_samples;
  const nChannels = targetGroup.n_channels;
  if (!nSamples || nSamples < 1 || !nChannels || nChannels < 1) {
    return { result: missingGeometryResult(args.dataset_id, args.recording, targetGroup.name) };
  }

  const sourceCommitFinal = projection.sourceCommit || null;
  const dataBase = projection.dataBase;
  if (!sourceCommitFinal || !dataBase) {
    return { result: missingIndexFactsResult(args.dataset_id) };
  }

  const level = pickViewLevel(nSamples, nViewLevels, args.width_px);
  const levelColumns = computeViewLevelColumns(nSamples, nViewLevels)[level - 1];

  const cacheKey = projectionUrl(
    args.dataset_id,
    sourceCommitFinal,
    `overview/${matched.zarr}/${targetGroup.name}/${args.width_px}`,
  );
  const cached = await readBinaryProjection(deps.cache(), cacheKey);

  const rowPx = computeRowPx(nChannels);
  const heightPx = nChannels * rowPx + Math.max(0, nChannels - 1);

  let pngBytes: Uint8Array;
  let cacheStatus: "hit" | "miss";
  let columnsRead = 0;
  let chunksRead = 0;
  let bytesRead = 0;

  if (cached.status === "hit") {
    pngBytes = cached.bytes;
    cacheStatus = "hit";
  } else {
    const chunkPlan = buildChunkPlan({
      level,
      levelColumns,
      viewChunkColumns: targetGroup.view_chunk_columns,
    });

    let decodedChunks: Int16Array[];
    try {
      decodedChunks = await Promise.all(
        chunkPlan.chunkKeys.map(async (key) => {
          const url = `${dataBase}${matched.zarr}/${targetGroup.name}/${key}`;
          const response = await deps.fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} fetching ${url}`);
          }
          const buf = new Uint8Array(await response.arrayBuffer());
          bytesRead += buf.byteLength;
          return decodeBloscZstdInt16(buf);
        }),
      );
    } catch (err) {
      return {
        result: chunkFetchFailedResult(
          args.dataset_id,
          args.recording,
          err instanceof Error ? err.message : String(err),
        ),
      };
    }

    const reassembled = reassembleViewChunks({
      nChannels,
      totalColumns: levelColumns,
      chunks: decodedChunks,
    });
    const rendered = renderOverviewPng({
      nChannels,
      totalColumns: levelColumns,
      widthPx: args.width_px,
      data: reassembled,
    });
    pngBytes = rendered.png;
    columnsRead = levelColumns;
    chunksRead = chunkPlan.chunkKeys.length;
    cacheStatus = "miss";

    writeBinaryProjection(deps.executionCtx, deps.cache(), cacheKey, pngBytes, "image/png");
  }

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
    // "int16" only when this call actually decoded a view array (a cache
    // MISS); a cache HIT reused the already-rendered PNG and decoded
    // nothing this call, so dtype must be null there -- the envelope's
    // dtype field means "was read this call", not "is int16 in general".
    dtype: cacheStatus === "miss" ? "int16" : null,
  });

  const metadata = renderOverviewOutputSchema.parse({
    dataset_id: args.dataset_id,
    recording: args.recording,
    group: targetGroup.name,
    level,
    width_px: args.width_px,
    height_px: heightPx,
    mime_type: "image/png",
    columns_read: columnsRead,
    chunks_read: chunksRead,
    bytes_read: bytesRead,
    envelope: built.envelope ?? undefined,
  } satisfies RenderOverviewOutput);

  return {
    result: {
      content: [
        { type: "image", data: bytesToBase64(pngBytes), mimeType: "image/png" },
        { type: "text", text: JSON.stringify(metadata) },
      ],
      structuredContent: metadata,
    },
    metrics: { cacheStatus, upstreamBytes: bytesRead + recordingsBytes },
  };
}

/** Re-exported for `mcp-overview.test.ts`, which drives `render_overview`
 *  through the real route and needs the projection type to build fixtures
 *  in the same shape this tool reads. */
export type { RecordingsProjection };
