/**
 * The SNIRF reader (publication-queue plan, card A4). SNIRF is HDF5; the walker
 * (`shared/hdf5-meta.ts`) lists its groups, datasets and attributes, and never reads the
 * `dataTimeSeries` signal (it skips any numeric value over 64 elements without fetching it).
 *
 * The SNIRF specification v1.1 puts text in `/formatVersion`, in each `/nirs{i}/metaDataTags/`
 * (`SubjectID`, `MeasurementDate`, `MeasurementTime`, the units, and any user tag), in the probe's
 * `sourceLabels`, `detectorLabels` and `landmarkLabels`, and in `/nirs{i}/stim{k}/name` and
 * `/nirs{i}/aux{k}/name`. A file can hold several `nirs{i}` groups; each is screened.
 *
 * - `SubjectID` ({@link readSubjectId}): nothing for a placeholder, the BIDS subject label or a
 *   short code; `snirf-subject-name` (identifier) for a name-like word of letters only;
 *   `snirf-subject-freetext` (review) otherwise.
 * - `MeasurementDate` at day precision: `snirf-measurement-date`, a date kind (ADR 0090): it never
 *   gates on its own.
 * - Stimulus and aux names: labels, so the local-path rule only (condition names never fire).
 *   Probe labels (`sourceLabels`, ...) need no case of their own: their field names name no
 *   person, so the generic rules give them the local-path rule only too (`S1`, `D3`, `Nz` never
 *   fire).
 * - Everything else: the generic HDF5 text rules (`hdf5-generic.ts`).
 */

import type { Hdf5Entry } from "../hdf5-meta";
import type { FormatReader } from "../identifier-readers";
import { type Finding, datePrecision, isNameLike, shapeOf } from "../identifier-scan";
import {
  EMPTY_VALUES,
  type FieldRole,
  HDF5_READER_LIMITS,
  readerResult,
  scanEntryText,
  stringsOf,
} from "./hdf5-generic";
import { walkForReader } from "./hdf5-incomplete";

/** The longest `SubjectID` that passes as a short code. */
export const SHORT_CODE_MAX = 12;
const SHORT_CODE = new RegExp(`^[\\p{L}\\p{N}][\\p{L}\\p{N}_-]{0,${SHORT_CODE_MAX - 1}}$`, "u");

const NIRS = String.raw`/nirs\d*`;
const SUBJECT_ID = new RegExp(`^${NIRS}/metaDataTags/SubjectID$`);
const MEASUREMENT_DATE = new RegExp(`^${NIRS}/metaDataTags/MeasurementDate$`);
const STIM_OR_AUX_NAME = new RegExp(`^${NIRS}/(stim|aux)\\d+/name$`);

/** The BIDS subject label in a path (`sub-<label>`, the last one), or null. */
export function bidsSubjectLabel(path: string): string | null {
  const all = [...path.matchAll(/(?:^|\/)sub-([\p{L}\p{N}]+)/gu)];
  const last = all[all.length - 1];
  return last ? (last[1] as string) : null;
}

/** How a subject identifier reads: nothing to report, a name, or other text. */
export type SubjectIdReading = "none" | "name" | "freetext";

/** A whitespace token of letters only (and the `' . -` a name may hold). */
const ALL_LETTERS = /^[\p{L}'.-]+$/u;

/**
 * The one rule for a recording's own subject identifier: SNIRF's `SubjectID` here, and EEGLAB's
 * `subject` field (card A5) through this same function.
 *
 * - `none`: a placeholder, the BIDS subject label of the file's path (with or without `sub-`), or
 *   a short code (at most {@link SHORT_CODE_MAX} letters, digits, `-` or `_`, that the slot name
 *   test does not flag).
 * - `name`: a whitespace token of letters only that the slot name test flags (`Marlow`).
 * - `freetext`: anything else, including letters fused with digits that the name test flags
 *   (`john3`, or a cohort word and a number): a person decides (lead ruling, 2026-11-25).
 */
export function readSubjectId(value: string, path: string): SubjectIdReading {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (EMPTY_VALUES.has(lower)) return "none";
  const label = bidsSubjectLabel(path)?.toLowerCase();
  if (label !== undefined && (lower === label || lower === `sub-${label}`)) return "none";
  const tokens = v.split(/\s+/);
  if (tokens.some((t) => ALL_LETTERS.test(t) && isNameLike(t, true))) return "name";
  if (SHORT_CODE.test(v) && !tokens.some((t) => isNameLike(t, true))) return "none";
  return "freetext";
}

/** The `SubjectID` rule, as findings. */
export function scanSubjectId(value: string, path: string): Finding[] {
  const reading = readSubjectId(value, path);
  if (reading === "none") return [];
  const name = reading === "name";
  return [
    {
      kind: name ? "snirf-subject-name" : "snirf-subject-freetext",
      severity: name ? "identifier" : "review",
      field: "snirf.SubjectID",
      shape: shapeOf(value.trim()),
    },
  ];
}

/** The fixed field word and role of a SNIRF entry the generic rules check. */
function roleOf(entry: Hdf5Entry): { field: string; role: FieldRole } {
  if (entry.kind === "dataset" && STIM_OR_AUX_NAME.test(entry.path)) {
    return { field: "snirf.stim-aux-name", role: "label" };
  }
  return { field: entry.kind === "attribute" ? "hdf5.attribute" : "hdf5.dataset", role: "field" };
}

/** The SNIRF rules over a walk's entries, for the file at `path`. */
export function scanSnirfEntries(entries: readonly Hdf5Entry[], path: string): Finding[] {
  const out: Finding[] = [];
  for (const entry of entries) {
    if (entry.kind === "dataset" && SUBJECT_ID.test(entry.path)) {
      for (const v of stringsOf(entry)) out.push(...scanSubjectId(v, path));
      continue;
    }
    if (entry.kind === "dataset" && MEASUREMENT_DATE.test(entry.path)) {
      const dated = stringsOf(entry).find((v) => datePrecision(v) === "day");
      if (dated !== undefined) {
        out.push({
          kind: "snirf-measurement-date",
          severity: "review",
          field: "snirf.MeasurementDate",
          shape: shapeOf(dated),
        });
      }
      continue;
    }
    const { field, role } = roleOf(entry);
    out.push(...scanEntryText(entry, field, role));
  }
  return out;
}

export const SNIRF_READER: FormatReader = {
  id: "snirf",
  extensions: [".snirf"],
  limits: HDF5_READER_LIMITS,
  version: "1",
  async scan(src, path, limits) {
    const { walk, incomplete } = await walkForReader(src, limits);
    return readerResult(scanSnirfEntries(walk.entries, path), incomplete);
  },
};
