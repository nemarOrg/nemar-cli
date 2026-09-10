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
// Served width quantization
// ---------------------------------------------------------------------------

/** The widths this tool actually renders at. Ascending, and the last entry is
 *  `RENDER_OVERVIEW_MAX_WIDTH_PX`, so every accepted request has a bucket. */
export const OVERVIEW_WIDTH_BUCKETS = [200, 400, 800, 1200, 1600, 2000, 2400, 3200, 4000] as const;

/**
 * Round a requested `width_px` UP to the next served bucket.
 *
 * Rounding up rather than to the nearest is deliberate: the caller always gets
 * at least the detail it asked for, never less. The response reports the SERVED
 * width, so nothing is misdescribed -- `width_px` on the output has always
 * meant the PNG's actual width.
 *
 * This exists because the render cache was keyed on the raw `width_px`, which a
 * caller can vary 1..4000: up to 4000 distinct renders and cache writes per
 * (recording, group), every one of them re-fetching the same view chunks
 * straight from S3 with no edge cache in front. Nine buckets bound it.
 */
export function quantizeWidthPx(widthPx: number): number {
  for (const bucket of OVERVIEW_WIDTH_BUCKETS) {
    if (widthPx <= bucket) return bucket;
  }
  return OVERVIEW_WIDTH_BUCKETS[OVERVIEW_WIDTH_BUCKETS.length - 1];
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

/**
 * Hard ceiling on how many view chunks one `render_overview` call may fetch.
 *
 * In today's catalog the real figure is 1 to about 16, because `pickViewLevel`
 * returns a level whose column count is within roughly 4x of `width_px` and
 * `width_px` is capped at 4000. But the chunk count is `ceil(levelColumns /
 * chunkColumns)` and `levelColumns` comes from the INDEX, not from anything this
 * code controls: a group publishing a shallow pyramid (`n_view_levels: 1`) for a
 * long recording -- a converter regression, or a future widening of the pyramid
 * rule -- makes level 1 the only candidate no matter how small `width_px` is,
 * and one anonymous call then fans out to tens of thousands of simultaneous
 * fetches. Past Cloudflare's 1000-subrequest ceiling that surfaces as an opaque
 * exception rather than an answer.
 *
 * 64 is comfortably above every legitimate plan and far below any platform
 * limit. The same reasoning as `MAX_STORE_FANOUT_ENTRIES` in `get-events.ts`.
 */
export const MAX_OVERVIEW_CHUNKS = 64;

/** `chunkColumns` defaults to 1024 (the producer's own default) when the
 *  group carries no `view_chunk_columns`, and is then CLAMPED to the level's
 *  own column count, because that is the chunk shape the producer actually
 *  writes. Measured against nm000329's `eeg_250hz` view arrays, whose
 *  `zarr.json` chunk grids are:
 *
 *      view/1  shape [2, 63, 34687]  chunk [2, 63, 1024]
 *      view/2  shape [2, 63,  8671]  chunk [2, 63, 1024]
 *      view/3  shape [2, 63,  2167]  chunk [2, 63, 1024]
 *      view/4  shape [2, 63,   541]  chunk [2, 63,  541]   <- clamped
 *      view/5  shape [2, 63,   135]  chunk [2, 63,  135]   <- clamped
 *
 *  So a level at or below `view_chunk_columns` is one chunk whose shape IS the
 *  level, and `chunkColumns` has to say 541 rather than 1024 for level 4 --
 *  {@link reassembleViewChunks} uses it as the per-chunk stride, and an
 *  unclamped 1024 there would reject a perfectly good single-chunk level. */
export function buildChunkPlan(opts: {
  level: number;
  levelColumns: number;
  viewChunkColumns?: number | null;
}): ChunkPlan {
  const configured =
    opts.viewChunkColumns && opts.viewChunkColumns > 0 ? opts.viewChunkColumns : 1024;
  const chunkColumns = Math.max(1, Math.min(configured, opts.levelColumns));
  const nChunks = Math.max(1, Math.ceil(opts.levelColumns / chunkColumns));
  const chunkKeys = Array.from({ length: nChunks }, (_, k) => `view/${opts.level}/c/0/0/${k}`);
  return { level: opts.level, levelColumns: opts.levelColumns, chunkColumns, chunkKeys };
}

// ---------------------------------------------------------------------------
// Chunk reassembly
// ---------------------------------------------------------------------------

/**
 * Reassemble decoded chunks (each `[2, nChannels, chunkColumns]`, C order --
 * axis0 (min/max) slowest, then channel, then column) into one
 * `[2, nChannels, totalColumns]` buffer. Chunks must arrive in `k` order,
 * column-ascending.
 *
 * `chunkColumns` IS THE STRIDE OF EVERY CHUNK, INCLUDING THE LAST ONE, and it
 * is passed in rather than derived from a chunk's length. That distinction is
 * the whole point of this signature. An earlier version computed
 * `chunk.length / (2 * nChannels)` per chunk and documented "the last chunk may
 * be shorter than `chunkColumns`", which is false: Zarr never emits a narrower
 * chunk. A boundary chunk is stored FULL SIZE and fill-padded, so its decoded
 * length is the nominal stride while only `totalColumns - colOffset` of its
 * columns are real. Trusting the length as the width therefore advanced
 * `colOffset` past the end and wrote each channel's slice over the NEXT
 * channel's region, then ran off the end of `out` with a `RangeError`.
 *
 * Verified against nm000329's `eeg_250hz` level 3 (2167 columns, chunk 1024):
 * all three real objects carry blosc `nbytes` 258048 = 2 x 63 x 1024 int16, so
 * the third holds 1024 columns of which 119 are real. That is the `width_px:
 * 800` default for that recording, i.e. this was the ordinary path, not an edge
 * case. It is the same nominal-stride versus valid-span split that
 * `sharding.ts` documents for level 0 (see its "A PRESENT boundary chunk is
 * still stored FULL SIZE" note); the trap simply had not been carried across to
 * the view path.
 *
 * The tests could not catch it either: both real captured fixtures are
 * single-chunk levels where the chunk shape equals the level shape, and the one
 * multi-chunk fixture was synthetic with a genuinely truncated tail.
 */
export function reassembleViewChunks(opts: {
  nChannels: number;
  totalColumns: number;
  chunkColumns: number;
  chunks: Int16Array[];
}): Int16Array {
  const { nChannels, totalColumns, chunkColumns, chunks } = opts;
  if (!Number.isInteger(chunkColumns) || chunkColumns <= 0) {
    throw new Error(
      `reassembleViewChunks: chunkColumns must be a positive integer, got ${chunkColumns}`,
    );
  }
  const out = new Int16Array(2 * nChannels * totalColumns);
  const expectedLength = 2 * nChannels * chunkColumns;
  let colOffset = 0;
  for (const [k, chunk] of chunks.entries()) {
    // Every chunk, boundary included, must decode to exactly the nominal size.
    // A short chunk means the store does not match the geometry the index
    // reported, which is a fidelity problem to surface rather than to paper
    // over by inferring a width from it -- inferring was the original bug.
    if (chunk.length !== expectedLength) {
      throw new Error(
        `reassembleViewChunks: chunk ${k} decoded to ${chunk.length} values, expected ` +
          `${expectedLength} (2 x ${nChannels} channels x ${chunkColumns} columns)`,
      );
    }
    const validColumns = Math.min(chunkColumns, totalColumns - colOffset);
    if (validColumns <= 0) {
      throw new Error(
        `reassembleViewChunks: chunk ${k} starts at column ${colOffset}, at or past the ` +
          `level's ${totalColumns} columns`,
      );
    }
    for (let axis0 = 0; axis0 < 2; axis0++) {
      for (let ch = 0; ch < nChannels; ch++) {
        const srcStart = (axis0 * nChannels + ch) * chunkColumns;
        const dstStart = (axis0 * nChannels + ch) * totalColumns + colOffset;
        out.set(chunk.subarray(srcStart, srcStart + validColumns), dstStart);
      }
    }
    colOffset += validColumns;
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
