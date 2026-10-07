/**
 * The sentences a privacy correction writes into a mirror's provenance file and its README
 * (ADR 0085, amendment of 2026-10-06 "A mirror's provenance file keeps the upstream checksums").
 *
 * Shared by the two writers: ADR 0085's git plan (`scripts/scrub/plan/build-git-plan.ts`), which
 * corrects every commit of a published dataset, and the importer's prepare step (ADR 0089), which
 * scrubs a tree before its first push. One spelling, so a dataset corrected by either says the same
 * thing. Fixed words and a date only: no file name, no count, no value.
 */

/**
 * The provenance file of a dataset that mirrors upstream recordings under `sourcedata/`: a JSON
 * object whose top-level `files` array lists each mirrored file, with the `sha256` of the ORIGINAL
 * upstream file. Those checksums are kept as provenance (ADR 0085).
 */
export const PROVENANCE_PATH = "sourcedata/sourcedata_provenance.json";

/** The README beside it, which gets the same note. */
export const PROVENANCE_README_PATH = "sourcedata/README_sourcedata_provenance.md";

/** The top-level key whose sentence says the checksums describe the files before the correction. */
export const PROVENANCE_NOTE_KEY = "privacy_correction";

/**
 * What the scrub changed in the files a provenance file describes. There is no value for
 * "nothing", so no sentence can be built that claims a change nobody made.
 */
export type ProvenanceChange = "scrubbed-in-place" | "files-removed" | "both";

const SCRUBBED_IN_PLACE =
  "identification fields in the headers of the recording files were scrubbed in place";

/**
 * The `privacy_correction` sentence of the provenance file: what the scrub changed, and what its
 * checksums still describe. It names removed files only when some were removed.
 */
export function provenanceNote(date: string, change: ProvenanceChange): string {
  const removed =
    "files whose names or contents identify a person were removed, with their entries in this file";
  if (change === "files-removed") {
    return `${date}: ${removed}; the remaining checksums describe the original upstream files.`;
  }
  const done = change === "both" ? `${removed}, and ${SCRUBBED_IN_PLACE}` : SCRUBBED_IN_PLACE;
  return `${date}: ${done}; the checksums in this file describe the original upstream files, not the scrubbed copies in this dataset.`;
}

/** The note appended to the provenance README, on the same terms as {@link provenanceNote}. */
export function provenanceReadmeNote(date: string, change: ProvenanceChange): string {
  const removed =
    "files that identify a person were removed, with their entries in the provenance file";
  if (change === "files-removed") {
    return `\nPrivacy correction ${date}: ${removed}. The remaining checksums in the provenance file describe the original upstream files.\n`;
  }
  const done = change === "both" ? `${SCRUBBED_IN_PLACE}, and ${removed}` : SCRUBBED_IN_PLACE;
  return `\nPrivacy correction ${date}: ${done}. The checksums in the provenance file describe the original upstream files, not the scrubbed copies.\n`;
}
