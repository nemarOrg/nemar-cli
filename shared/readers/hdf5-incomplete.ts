/**
 * The one mapping from the HDF5 walker's reasons (`Hdf5Incomplete`, `shared/hdf5/io.ts`) to the
 * reader registry's (`ReaderIncompleteReason`, `shared/identifier-readers.ts`), and the one way a
 * reader walks an HDF5 file under the registry's contract. The SNIRF and generic HDF5 readers use
 * it, and so do the MATLAB v7.3 readers (card A5): an HDF5 file falls short for the same reasons
 * whatever format sits on top, and says so in the same words (the copy table has one entry per
 * registry reason).
 */

import {
  type Hdf5Entry,
  type Hdf5Incomplete,
  type Hdf5Walk,
  type RangeSource,
  walkHdf5,
} from "../hdf5-meta";
// Types only: the registry imports the readers, so a runtime import back would be a cycle.
import type { LimitExceeded, ReaderIncompleteReason, ReaderLimits } from "../identifier-readers";
import { canonical, identifierKeySeverity } from "../identifier-scan";
import { FREE_TEXT_MAX_CHARS } from "./text-header";

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
 * reads are many per fetched 64 KiB page, so they get room above the fetch cap; its byte count is
 * logical too, and the source refuses first. The measurements behind these numbers are in
 * `test/fixtures/hdf5/README.md`.
 */
export function walkLimits(limits: ReaderLimits): {
  maxBytes: number;
  maxReads: number;
  maxObjects: number;
} {
  return {
    maxBytes: limits.maxBytes * 4,
    maxReads: Math.max(100_000, limits.maxReads * 250),
    // High-density SNIRF files list more than 60,000 entries (fixtures README).
    maxObjects: 100_000,
  };
}

export interface ReaderWalk {
  walk: Hdf5Walk;
  /** Why the file was read only in part; absent when the walk was complete. */
  incomplete?: ReaderIncompleteReason;
}

/** A source that may say it refused a read past its limits, as the registry's page cache does. */
export type LimitedSource = RangeSource & { readonly limited?: boolean };

/**
 * The registry's refusal past a reader's limits. A type-only guard: the class cannot be imported
 * at runtime here (see the imports), so it is told by its name, and counts only together with the
 * source's own `limited` flag.
 */
function isLimitError(e: unknown): e is LimitExceeded {
  return e instanceof Error && e.name === "LimitExceeded";
}

const isStringDtype = (dtype: string | null) => dtype?.includes("string") === true;

/**
 * Entries the walker listed but did not return a value for, where the value could be text a rule
 * must read: a string over the walker's size rules (`limit`) or of a type it does not decode
 * (`unsupported-datatype`), and any value under an identifier-key name (`MRN`, `DateOfBirth`,
 * ...). A numeric value skipped for size is a signal and is not counted. A string longer than
 * the text rules read (`FREE_TEXT_MAX_CHARS`, shared with the text header readers) was read only
 * in part (`limit`). The first such entry names the reason; null when there is none.
 */
export function unscannedReason(entries: readonly Hdf5Entry[]): ReaderIncompleteReason | null {
  for (const e of entries) {
    const values: unknown[] =
      typeof e.value === "string" ? [e.value] : Array.isArray(e.value) ? e.value : [];
    if (values.some((v) => typeof v === "string" && v.length > FREE_TEXT_MAX_CHARS)) {
      return "limit";
    }
    if (e.skipped !== "size" && e.skipped !== "type") continue;
    if (isStringDtype(e.dtype) || identifierKeySeverity(canonical(e.name)) !== null) {
      return e.skipped === "size" ? "limit" : "unsupported-datatype";
    }
  }
  return null;
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
 *   of the file, never a partial or clean one. The first error the source threw decides; it is
 *   `limit` only when it is the registry's refusal and the source says it was limited.
 * - A walk that read everything is still `partial` when a string, or a value under an
 *   identifier-key name, was listed without its value ({@link unscannedReason}): text no rule
 *   read is never clean.
 */
export async function walkForReader(
  src: LimitedSource,
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
  // walker recorded, because it is why the rest of the file was not read.
  if (thrown !== undefined) {
    if (isLimitError(thrown) && src.limited === true) return { walk, incomplete: "limit" };
    if (thrown instanceof WalkDeadline) return { walk, incomplete: "time" };
    // Any other failure of the source fails the file, whatever the walker made of it.
    throw thrown;
  }
  // The walker records `read-failed` only when the source threw, which was handled above.
  if (walk.incomplete === "read-failed") throw new Error("read-failed");
  if (walk.incomplete !== undefined) {
    return { walk, incomplete: HDF5_INCOMPLETE_REASON[walk.incomplete] };
  }
  const unscanned = unscannedReason(walk.entries);
  return unscanned === null ? { walk } : { walk, incomplete: unscanned };
}
