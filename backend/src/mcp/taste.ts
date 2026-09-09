/**
 * Pure assembly for `read_window` taste mode (epic #1065 phase 4, issue
 * #1296): turn decoded (or fill-valued) inner-chunk segments into a
 * `[channel][sample]` physical-unit array. No I/O -- `read-window.ts` does
 * the fetching, footer parsing, and blosc decode; this file only assembles
 * and converts what it is handed.
 */

/** One inner chunk's contribution to the requested window, in GLOBAL sample
 *  coordinates (not yet trimmed to the window -- {@link assembleTasteValues}
 *  computes the overlap itself, so a caller can hand over whole chunks
 *  without pre-slicing). `data` is `null` for an absent (fill-value) chunk;
 *  otherwise channel-major (`data[ch * length + localCol]`, C order, per the
 *  live-verified decode shape), where `length = end - start`. */
export interface DecodedSegment {
  start: number;
  end: number;
  data: Int16Array | null;
}

/** Round `value` to `digits` significant figures. `0` stays `0` (no
 *  `log10(0)`); everything else uses the standard
 *  `10 ** (digits - 1 - floor(log10(|value|)))` scaling. Deliberately not a
 *  fixed-decimal round: a scale factor around `1e-8` (the real nm000329
 *  fixture's own per-channel `scale[]`) needs many more than six decimal
 *  places to keep six SIGNIFICANT digits. */
export function roundToSignificantDigits(value: number, digits: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = 10 ** (digits - 1 - magnitude);
  return Math.round(value * factor) / factor;
}

export const TASTE_SIGNIFICANT_DIGITS = 6;

export interface AssembleTasteValuesInput {
  /** The requested output channels, in the ORDER requested -- each is an
   *  index into the store's full channel axis (and into `scale`/`offset`). */
  channels: number[];
  /** Window start, global sample index (inclusive). */
  startSample: number;
  /** Window length in samples. */
  nSamples: number;
  /** Every segment touching `[startSample, startSample + nSamples)`, in
   *  ascending order, covering it with no gaps (segments may extend past
   *  either edge -- this function computes the overlap). */
  segments: DecodedSegment[];
  /** Per-FULL-STORE-channel scale/offset (`physical = digital * scale +
   *  offset`), each at least as long as the store's channel count. */
  scale: number[];
  offset: number[];
  /** The digital fill value for an absent chunk (always `0` today, per the
   *  Zarr `fill_value` every served level-0 array declares). */
  fillValue: number;
  significantDigits?: number;
}

/**
 * Assemble `channels.length` rows of `nSamples` physical values each. Throws
 * if `segments` does not fully cover `[startSample, startSample + nSamples)`
 * -- a caller bug (an incomplete chunk plan), not a data condition to degrade
 * around silently.
 */
export function assembleTasteValues(input: AssembleTasteValuesInput): number[][] {
  const {
    channels,
    startSample,
    nSamples,
    segments,
    scale,
    offset,
    fillValue,
    significantDigits = TASTE_SIGNIFICANT_DIGITS,
  } = input;

  const endSample = startSample + nSamples;
  const out: number[][] = channels.map(() => new Array<number>(nSamples));
  const covered = new Uint8Array(nSamples);

  for (const segment of segments) {
    const overlapStart = Math.max(segment.start, startSample);
    const overlapEnd = Math.min(segment.end, endSample);
    if (overlapEnd <= overlapStart) continue;
    const segmentLength = segment.end - segment.start;

    for (let outIdx = 0; outIdx < channels.length; outIdx++) {
      const ch = channels[outIdx];
      const chScale = scale[ch];
      const chOffset = offset[ch];
      for (let globalSample = overlapStart; globalSample < overlapEnd; globalSample++) {
        const digital = segment.data
          ? segment.data[ch * segmentLength + (globalSample - segment.start)]
          : fillValue;
        const physical = digital * chScale + chOffset;
        out[outIdx][globalSample - startSample] = roundToSignificantDigits(
          physical,
          significantDigits,
        );
      }
    }
    for (let s = overlapStart; s < overlapEnd; s++) covered[s - startSample] = 1;
  }

  for (let i = 0; i < nSamples; i++) {
    if (!covered[i]) {
      throw new Error(
        `assembleTasteValues: sample ${startSample + i} (window [${startSample}, ${endSample})) is not covered by any segment`,
      );
    }
  }

  return out;
}
