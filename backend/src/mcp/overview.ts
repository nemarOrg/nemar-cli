/**
 * Pure helpers for `render_overview` (epic #1065 phase 3, issue #1295):
 * view-level selection, chunk planning, chunk reassembly, and PNG
 * rendering. No I/O here at all -- `backend/src/mcp/tools/render-overview.ts`
 * does the fetching (straight from `data_base`, never `zarr.json`: the
 * geometry is entirely known from `index.json`) and calls into this file for
 * every computation, so the computation itself is unit-testable without a
 * network.
 */

import { encode } from "fast-png";

// ---------------------------------------------------------------------------
// View-level selection
// ---------------------------------------------------------------------------

/** Column count at each pyramid level 1..nViewLevels, via the biosigio rule
 *  (`_pyramid_level_lengths`): each level is `Math.floor(n / 4)` of the
 *  previous, applied ITERATIVELY -- mirroring biosigio's own
 *  implementation line for line, rather than computing
 *  `Math.floor(n0 / 4 ** L)` in one step, which happens to be numerically
 *  identical for these non-negative integer inputs but reads as a
 *  derivation from the source rule rather than a restatement of it.
 *  Returns an array indexed `[level - 1]`. */
export function computeViewLevelColumns(nSamples: number, nViewLevels: number): number[] {
  const columns: number[] = [];
  let n = nSamples;
  for (let level = 1; level <= nViewLevels; level++) {
    n = Math.floor(n / 4);
    columns.push(n);
  }
  return columns;
}

/**
 * The COARSEST view level (highest `L`) whose column count is still
 * `>= widthPx` -- never a level finer than what the requested pixel width
 * can show. Level 0 (the full-resolution signal array) is never a
 * candidate. When even level 1 (the finest view that exists) has fewer
 * columns than `widthPx`, returns level 1 -- the finest available is still
 * the best answer, not an error.
 *
 * Column counts are monotonically non-increasing in `L`, so the set of
 * levels satisfying `columns(L) >= widthPx` is always a prefix `1..k`; this
 * returns that `k` (or 1 when the set is empty).
 */
export function pickViewLevel(nSamples: number, nViewLevels: number, widthPx: number): number {
  if (nViewLevels < 1) {
    throw new Error("pickViewLevel: nViewLevels must be >= 1 (no view pyramid is published)");
  }
  const columns = computeViewLevelColumns(nSamples, nViewLevels);
  let chosen = 1;
  for (let level = 1; level <= nViewLevels; level++) {
    if (columns[level - 1] >= widthPx) chosen = level;
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Chunk planning
// ---------------------------------------------------------------------------

export interface ChunkPlan {
  level: number;
  levelColumns: number;
  chunkColumns: number;
  /** Relative object keys under the store/group, e.g. `"view/5/c/0/0/0"`. */
  chunkKeys: string[];
}

/** `chunkColumns` defaults to 1024 (the producer's own default) when the
 *  group carries no `view_chunk_columns`. A level whose own column count is
 *  <= `chunkColumns` naturally produces exactly one key covering the whole
 *  level -- no special-casing "is this the last level" is needed; the
 *  `ceil` below already does the right thing for nm000329's level 5 (135
 *  columns, one chunk of `chunk_columns: 135`) and level 4 (541 columns,
 *  also one chunk) alike. */
export function buildChunkPlan(opts: {
  level: number;
  levelColumns: number;
  viewChunkColumns?: number | null;
}): ChunkPlan {
  const chunkColumns =
    opts.viewChunkColumns && opts.viewChunkColumns > 0 ? opts.viewChunkColumns : 1024;
  const nChunks = Math.max(1, Math.ceil(opts.levelColumns / chunkColumns));
  const chunkKeys = Array.from({ length: nChunks }, (_, k) => `view/${opts.level}/c/0/0/${k}`);
  return { level: opts.level, levelColumns: opts.levelColumns, chunkColumns, chunkKeys };
}

// ---------------------------------------------------------------------------
// Chunk reassembly
// ---------------------------------------------------------------------------

/**
 * Reassemble decoded chunks (each `[2, nChannels, chunkCols]`, C order --
 * axis0 (min/max) slowest, then channel, then column) into one
 * `[2, nChannels, totalColumns]` buffer. Chunks must arrive in `k` order
 * (column-ascending); the last chunk may be shorter than `chunkColumns`.
 */
export function reassembleViewChunks(opts: {
  nChannels: number;
  totalColumns: number;
  chunks: Int16Array[];
}): Int16Array {
  const { nChannels, totalColumns, chunks } = opts;
  const out = new Int16Array(2 * nChannels * totalColumns);
  let colOffset = 0;
  for (const chunk of chunks) {
    const chunkCols = chunk.length / (2 * nChannels);
    if (!Number.isInteger(chunkCols)) {
      throw new Error(
        `reassembleViewChunks: chunk length ${chunk.length} is not a multiple of 2 * n_channels (${2 * nChannels})`,
      );
    }
    for (let axis0 = 0; axis0 < 2; axis0++) {
      for (let ch = 0; ch < nChannels; ch++) {
        const srcStart = (axis0 * nChannels + ch) * chunkCols;
        const dstStart = (axis0 * nChannels + ch) * totalColumns + colOffset;
        out.set(chunk.subarray(srcStart, srcStart + chunkCols), dstStart);
      }
    }
    colOffset += chunkCols;
  }
  if (colOffset !== totalColumns) {
    throw new Error(
      `reassembleViewChunks: chunks covered ${colOffset} columns, expected ${totalColumns}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG rendering
// ---------------------------------------------------------------------------

/** `rowPx = clamp(floor(1200 / n_channels), 2, 24)`, so the image is at
 *  most about 1200 px tall (before the 1px inter-band separators): 63 EEG
 *  channels give 19px rows, 320 MEG channels give 3px rows. */
export function computeRowPx(nChannels: number): number {
  return Math.min(24, Math.max(2, Math.floor(1200 / nChannels)));
}

const BACKGROUND_GRAY = 235;
const BAR_GRAY = 20;
const BAND_SEPARATOR_PX = 1;
const SEPARATOR_GRAY = 128;

export interface RenderOverviewPngInput {
  nChannels: number;
  totalColumns: number;
  widthPx: number;
  /** `[2, nChannels, totalColumns]`, C order (axis0 = min/max), exactly the
   *  shape {@link reassembleViewChunks} produces. */
  data: Int16Array;
}

export interface RenderedOverview {
  widthPx: number;
  heightPx: number;
  png: Uint8Array;
}

/**
 * Render the min-max envelope pyramid data into a grayscale PNG: one band
 * per channel, `widthPx` column buckets (min of mins, max of maxes per
 * bucket), each channel scaled to its OWN min/max over the level, a
 * min-max bar drawn dark on a light background, a 1px separator between
 * bands.
 */
export function renderOverviewPng(input: RenderOverviewPngInput): RenderedOverview {
  const { nChannels, totalColumns, widthPx, data } = input;
  if (nChannels < 1) throw new Error("renderOverviewPng: nChannels must be >= 1");
  if (totalColumns < 1) throw new Error("renderOverviewPng: totalColumns must be >= 1");
  if (data.length !== 2 * nChannels * totalColumns) {
    throw new Error(
      `renderOverviewPng: data.length ${data.length} does not match 2 * ${nChannels} * ${totalColumns}`,
    );
  }

  const rowPx = computeRowPx(nChannels);
  const bandStride = rowPx + BAND_SEPARATOR_PX;
  const heightPx = nChannels * rowPx + (nChannels - 1) * BAND_SEPARATOR_PX;
  const img = new Uint8Array(widthPx * heightPx).fill(BACKGROUND_GRAY);

  // Inter-band separator rows (skipped for the last channel, which has none
  // below it).
  for (let ch = 0; ch < nChannels - 1; ch++) {
    const y = ch * bandStride + rowPx;
    img.fill(SEPARATOR_GRAY, y * widthPx, y * widthPx + widthPx);
  }

  for (let ch = 0; ch < nChannels; ch++) {
    const minRowOffset = (0 * nChannels + ch) * totalColumns;
    const maxRowOffset = (1 * nChannels + ch) * totalColumns;

    let channelMin = Number.POSITIVE_INFINITY;
    let channelMax = Number.NEGATIVE_INFINITY;
    for (let col = 0; col < totalColumns; col++) {
      const mn = data[minRowOffset + col];
      const mx = data[maxRowOffset + col];
      if (mn < channelMin) channelMin = mn;
      if (mx > channelMax) channelMax = mx;
    }
    const span = channelMax > channelMin ? channelMax - channelMin : 1;

    const bandTop = ch * bandStride;
    const scaleToRow = (value: number): number => {
      const t = (value - channelMin) / span;
      const rowFromTop = Math.round((1 - t) * (rowPx - 1));
      return Math.min(rowPx - 1, Math.max(0, rowFromTop));
    };

    for (let b = 0; b < widthPx; b++) {
      const start = Math.floor((totalColumns * b) / widthPx);
      const end = Math.min(
        totalColumns,
        Math.max(start + 1, Math.floor((totalColumns * (b + 1)) / widthPx)),
      );
      let bucketMin = Number.POSITIVE_INFINITY;
      let bucketMax = Number.NEGATIVE_INFINITY;
      for (let col = start; col < end; col++) {
        const mn = data[minRowOffset + col];
        const mx = data[maxRowOffset + col];
        if (mn < bucketMin) bucketMin = mn;
        if (mx > bucketMax) bucketMax = mx;
      }
      if (!Number.isFinite(bucketMin)) continue;
      const topRow = scaleToRow(bucketMax);
      const bottomRow = scaleToRow(bucketMin);
      for (let r = topRow; r <= bottomRow; r++) {
        img[(bandTop + r) * widthPx + b] = BAR_GRAY;
      }
    }
  }

  const png = encode({ width: widthPx, height: heightPx, data: img, channels: 1, depth: 8 });
  return { widthPx, heightPx, png };
}
