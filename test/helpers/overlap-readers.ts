/**
 * Stand-in readers that record how many of their scans run at once (risk R15: the local scans
 * read at most 2 MAT/EEGLAB, HDF5 or ZIP files at a time). Each scan waits a few milliseconds,
 * so scans the pool starts together overlap; it reads nothing and finds nothing.
 *
 * Registered through the scan's public `readers` option in place of the real reader of the same
 * id; the rest of the registry is the real one.
 */

import {
  DEFAULT_READER_LIMITS,
  type FormatReader,
  READERS,
  type ReaderId,
} from "../../shared/identifier-readers";

export interface Overlap {
  /** Scans running now. */
  now: number;
  /** The most that ever ran at once. */
  max: number;
  /** Scans started. */
  started: number;
}

export function overlapReader(
  id: ReaderId,
  extension: string,
  ms = 15,
): { reader: FormatReader; seen: Overlap } {
  const seen: Overlap = { now: 0, max: 0, started: 0 };
  const reader: FormatReader = {
    id,
    extensions: [extension],
    limits: { ...DEFAULT_READER_LIMITS },
    version: "test-1",
    async scan() {
      seen.started++;
      seen.now++;
      seen.max = Math.max(seen.max, seen.now);
      try {
        await new Promise((resolve) => setTimeout(resolve, ms));
      } finally {
        seen.now--;
      }
      return { findings: [], coverage: "complete" };
    },
  };
  return { reader, seen };
}

/**
 * A heavy class reader (EEGLAB `.set`) and a light one (BrainVision `.vhdr`), each recording its
 * overlap, in a registry that is otherwise the real one.
 */
export function overlapRegistry(): {
  readers: FormatReader[];
  heavy: Overlap;
  light: Overlap;
} {
  const heavy = overlapReader("eeglab", ".set");
  const light = overlapReader("brainvision", ".vhdr");
  return {
    readers: [
      ...READERS.filter((r) => r.id !== "eeglab" && r.id !== "brainvision"),
      heavy.reader,
      light.reader,
    ],
    heavy: heavy.seen,
    light: light.seen,
  };
}

/** Paths for `heavy` `.set` and `light` `.vhdr` recordings, interleaved across subjects. */
export function overlapPaths(heavy: number, light: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < Math.max(heavy, light); i++) {
    const sub = `sub-${String(i + 1).padStart(2, "0")}/eeg/sub-${String(i + 1).padStart(2, "0")}`;
    if (i < heavy) paths.push(`${sub}_task-a_eeg.set`);
    if (i < light) paths.push(`${sub}_task-b_eeg.vhdr`);
  }
  return paths;
}
