/**
 * The one mapping from the HDF5 walker's reasons (`Hdf5Incomplete`, `shared/hdf5/io.ts`) to the
 * reader registry's (`ReaderIncompleteReason`, `shared/identifier-readers.ts`), and the one way a
 * reader walks an HDF5 file under the registry's contract. The SNIRF and generic HDF5 readers use
 * it, and so do the MATLAB v7.3 readers (card A5): an HDF5 file falls short for the same reasons
 * whatever format sits on top, and says so in the same words (the copy table has one entry per
 * registry reason).
 */

import { type Hdf5Incomplete, type Hdf5Walk, type RangeSource, walkHdf5 } from "../hdf5-meta";
// Types only: the registry imports the readers, so a runtime import back would be a cycle.
import type { ReaderIncompleteReason, ReaderLimits } from "../identifier-readers";

/**
 * Each walker reason as the registry says it. `read-failed` has no entry: the walker records it
 * when the source threw, and what the source threw decides (see {@link walkForReader}).
 */
export const HDF5_INCOMPLETE_REASON: Record<
  Exclude<Hdf5Incomplete, "read-failed">,
  ReaderIncompleteReason
> = {
  "limit-bytes": "limit",
  "limit-reads": "limit",
  "limit-objects": "limit",
  "limit-depth": "limit",
  "unsupported-version": "unsupported-version",
  "unsupported-filter": "unsupported-filter",
  "unsupported-datatype": "unsupported-datatype",
  "external-link": "external-link",
  corrupt: "corrupt",
};

/** A reader's own time ran out while it walked: it keeps what it found, as `partial` (`time`). */
class WalkDeadline extends Error {
  constructor() {
    super("time");
    this.name = "WalkDeadline";
  }
}

/**
 * The share of a reader's `timeMs` the walk may use. The builder abandons a scan at `timeMs` and
 * keeps nothing; stopping the walk first lets the reader return what it found so far.
 */
export const WALK_TIME_SHARE = 0.8;

/**
 * The walker's own caps under a reader's limits. The network is bounded by the source
 * (`cachedSource`: bytes and fetches); the walker's caps bound its work in memory. Its logical
 * reads are many per fetched 64 KiB page (measured: 6,292 entries took more than 20,000 logical
 * reads in 40 fetches), so they get room above the fetch cap; its byte count is logical too, and
 * the source refuses first.
 */
export function walkLimits(limits: ReaderLimits): {
  maxBytes: number;
  maxReads: number;
  maxObjects: number;
} {
  return {
    maxBytes: limits.maxBytes * 4,
    maxReads: Math.max(100_000, limits.maxReads * 250),
    // High-density SNIRF files list more than 60,000 entries (measured); see HDF5_READER_LIMITS.
    maxObjects: 100_000,
  };
}

export interface ReaderWalk {
  walk: Hdf5Walk;
  /** Why the file was read only in part; absent when the walk was complete. */
  incomplete?: ReaderIncompleteReason;
}

/**
 * Walk an HDF5 file through a reader's source, under the reader contract:
 *
 * - The walker's own caps are set to the reader's byte budget, so the source's limits
 *   (`cachedSource`) are what bound the network; a source that refuses a read past them ends the
 *   walk with the entries found so far, and the file is `partial` (`limit`).
 * - Past {@link WALK_TIME_SHARE} of `limits.timeMs` the next read is refused, and the file is
 *   `partial` (`time`), with the entries found so far.
 * - Any other failure of the source (a network error, an HTTP status) is rethrown: a failed read
 *   of the file, never a partial or clean one. The walker never throws, so this is the only throw.
 */
export async function walkForReader(
  src: RangeSource,
  limits: ReaderLimits,
  now: () => number = Date.now,
): Promise<ReaderWalk> {
  const deadline = now() + limits.timeMs * WALK_TIME_SHARE;
  let thrown: unknown;
  const guarded: RangeSource = {
    get size() {
      return src.size;
    },
    async read(offset, length) {
      try {
        if (now() >= deadline) throw new WalkDeadline();
        return await src.read(offset, length);
      } catch (e) {
        thrown ??= e;
        throw e;
      }
    },
  };
  const walk = await walkHdf5(guarded, { limits: walkLimits(limits) });
  // A walk the source stopped says why it stopped: that reason outranks an earlier one the
  // walker recorded, because it is why the rest of the file was not read. The registry's page
  // cache (`cachedSource`) says when it refused a read past the limits.
  if (thrown !== undefined && (src as { limited?: unknown }).limited === true) {
    return { walk, incomplete: "limit" };
  }
  if (thrown instanceof WalkDeadline) return { walk, incomplete: "time" };
  // Any other failure of the source fails the file, whatever the walker made of it.
  if (thrown !== undefined) throw thrown;
  if (walk.incomplete === undefined) return { walk };
  // The walker records `read-failed` only when the source threw, which was handled above.
  if (walk.incomplete === "read-failed") throw new Error("read-failed");
  return { walk, incomplete: HDF5_INCOMPLETE_REASON[walk.incomplete] };
}
