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
 * "nothing", so no sentence can be built that claims a change nobody made. The two `dates`
 * values are the importer's alone (ADR 0091): it sets a new recording's acquisition dates to
 * 1 January, and ADR 0085's correction of published data never does.
 */
export type ProvenanceChange =
  | "scrubbed-in-place"
  | "files-removed"
  | "both"
  | "dates-set"
  | "scrubbed-and-dates-set";

const SCRUBBED_IN_PLACE =
  "identification fields in the headers of the recording files were scrubbed in place";
const DATES_SET =
  "the acquisition dates in the headers of the recording files were set to 1 January of their year";
const ALSO_DATES_SET = "acquisition dates in the headers were set to 1 January of their year";

/** What was done to the recordings' headers, for the two sentences that are not about removal. */
function headerChange(change: Exclude<ProvenanceChange, "files-removed" | "both">): string {
  if (change === "dates-set") return DATES_SET;
  if (change === "scrubbed-and-dates-set") return `${SCRUBBED_IN_PLACE}, and ${ALSO_DATES_SET}`;
  return SCRUBBED_IN_PLACE;
}

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
  const done = change === "both" ? `${removed}, and ${SCRUBBED_IN_PLACE}` : headerChange(change);
  const copies = change === "dates-set" ? "the copies" : "the scrubbed copies";
  return `${date}: ${done}; the checksums in this file describe the original upstream files, not ${copies} in this dataset.`;
}

/** The note appended to the provenance README, on the same terms as {@link provenanceNote}. */
export function provenanceReadmeNote(date: string, change: ProvenanceChange): string {
  const removed =
    "files that identify a person were removed, with their entries in the provenance file";
  if (change === "files-removed") {
    return `\nPrivacy correction ${date}: ${removed}. The remaining checksums in the provenance file describe the original upstream files.\n`;
  }
  const done = change === "both" ? `${SCRUBBED_IN_PLACE}, and ${removed}` : headerChange(change);
  const copies = change === "dates-set" ? "the copies" : "the scrubbed copies";
  return `\nPrivacy correction ${date}: ${done}. The checksums in the provenance file describe the original upstream files, not ${copies}.\n`;
}
