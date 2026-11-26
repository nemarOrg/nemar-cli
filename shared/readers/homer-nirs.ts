/**
 * The Homer2 `.nirs` reader (publication-queue plan, card A5). A `.nirs` file is a MAT-file
 * (Homer2 saves it with `save -mat`; a v7.3 one is read the same way, through the shared
 * MATLAB layer in `mat-generic.ts`).
 *
 * Homer2's variables: `SD` (the probe: positions, wavelengths, `SpatialUnit`, sometimes source and
 * detector labels), the signals `t`, `d`, `s` and `aux`, which are numeric and skipped by size,
 * and sometimes `CondNames`, `subject`, `notes`, `procInput` or `userdata`. Every character array
 * goes through the free-text rules (`scanMatText`): identifier-key fields, person fields, and
 * home-directory paths or contact details anywhere; a small numeric array only under an
 * identifier-key name. Findings carry the field word `nirs.variable`.
 */

import type { FormatReader } from "../identifier-readers";
import type { Finding } from "../identifier-scan";
import type { MatEntry } from "../mat-meta";
import { MAT_READER_LIMITS, matResult, scanMatText, walkMatForReader } from "./mat-generic";

/** The free-text rules over every array of a Homer2 file. */
export function scanHomerEntries(entries: readonly MatEntry[]): Finding[] {
  return entries.flatMap((e) => scanMatText(e, "nirs.variable"));
}

export const HOMER_NIRS_READER: FormatReader = {
  id: "homer-nirs",
  extensions: [".nirs"],
  limits: MAT_READER_LIMITS,
  version: "1",
  async scan(src, _path, limits) {
    const walk = await walkMatForReader(src, limits);
    return matResult(scanHomerEntries(walk.entries), walk);
  },
};
