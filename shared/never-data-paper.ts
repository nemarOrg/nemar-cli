/**
 * Papers that are never a dataset's data paper (#1549): standards, software,
 * platforms, and umbrella initiatives.
 *
 * The citation pipeline (nemarOrg/nemar-citations) credits a dataset with the
 * citations of every DOI its `.nemar/metadata.json` marks as describing the
 * data. A standard, software, or platform paper marked that way turns every
 * paper that cites, say, EEG-BIDS into a "citation" of the dataset. These
 * papers are referenced by hundreds of datasets and describe none of them, so
 * the rule is deterministic instead of being left to the LLM.
 *
 * nemar-citations keeps a matching list on its side; keep the two in step.
 *
 * This file has ZERO dependencies so it can be imported from any context.
 */

/** Normalized DOIs (see {@link normalizeDoiKey}); every entry resolved on
 *  Crossref when the list was written (2026-09-29). Mirrors
 *  nemar-citations' never-anchor list. */
export const NEVER_DATA_PAPER_DOIS: ReadonlySet<string> = new Set([
  // BIDS specification and its modality extensions
  "10.1038/sdata.2016.44", // BIDS
  "10.1038/s41597-019-0104-8", // EEG-BIDS
  "10.1038/sdata.2018.110", // MEG-BIDS
  "10.1038/s41597-019-0105-7", // iEEG-BIDS
  "10.1038/s41597-022-01164-1", // PET-BIDS
  "10.1038/s41597-024-03559-8", // Motion-BIDS
  "10.1038/s41597-024-04136-9", // NIRS-BIDS
  "10.1371/journal.pcbi.1005209", // BIDS Apps
  // Software
  "10.21105/joss.01896", // MNE-BIDS
  "10.21105/joss.01294", // PyBIDS
  "10.3389/fnins.2013.00267", // MNE-Python
  "10.1016/j.neuroimage.2013.10.027", // MNE software
  "10.1016/j.jneumeth.2003.10.009", // EEGLAB
  "10.1155/2011/156869", // FieldTrip
  "10.1155/2011/879716", // Brainstorm
  "10.3389/fninf.2015.00016", // PREP pipeline
  "10.1016/j.neuroimage.2019.05.026", // ICLabel
  "10.1038/s41592-018-0235-4", // fMRIPrep
  "10.1016/j.neuroimage.2012.01.021", // FreeSurfer
  "10.3389/fninf.2011.00013", // Nipype
  "10.1016/j.neuroimage.2011.09.015", // FSL
  // Platforms
  "10.7554/elife.71774", // OpenNeuro
  "10.1093/database/baac096", // NEMAR
  // Hierarchical Event Descriptors (HED)
  "10.1007/s12021-021-09537-4",
  "10.3389/fninf.2024.1292667",
  "10.1109/globalsip.2013.6736796",
  // Umbrella initiative: describes the whole Healthy Brain Network program,
  // not any one release carved out of it. The MIPDB resource paper
  // (10.1038/sdata.2017.40, Langer et al. 2017) is deliberately NOT blocked:
  // it is nm000153's own data descriptor.
  "10.1038/sdata.2017.181", // Healthy Brain Network
]);

/** Relation types that assert a DOI describes or IS this dataset's data. The
 *  citation pipeline treats all of them as data-paper candidates, so a
 *  never-data-paper DOI carrying any of them is demoted to `References`. */
export const DATA_DESCRIBING_RELATION_TYPES: ReadonlySet<string> = new Set([
  "IsDescribedBy",
  "IsSupplementTo",
  "IsDerivedFrom",
  "IsIdenticalTo",
  "IsVersionOf",
]);

/** Trim trailing `)` characters that have no matching `(`, so a DOI captured
 *  from prose like `(see 10.1038/x)` loses the closer while
 *  `10.1016/S0006-3223(99)00000-0` keeps its balanced pair. */
function trimUnbalancedParens(text: string): string {
  let out = text;
  const opens = (out.match(/\(/g) ?? []).length;
  let closes = (out.match(/\)/g) ?? []).length;
  while (closes > opens && out.endsWith(")")) {
    out = out.slice(0, -1);
    closes -= 1;
  }
  return out;
}

/** Comparable form of a DOI, as nemar-citations' `normalize_doi`: `doi:` and
 *  doi.org / dx.doi.org resolver prefixes stripped, unmatched trailing `)`
 *  trimmed, trailing `.,;:` stripped, lowercased. The two trims repeat until
 *  stable, so prose like `(10.1016/S0006-3223(99)00000-0).` also loses the
 *  unmatched `)` exposed by stripping the period. DOIs are case-insensitive,
 *  and metadata carries both `10.1109/TBCAS...` and `10.1109/tbcas...`. */
export function normalizeDoiKey(identifier: string): string {
  let key = identifier.trim().replace(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i, "");
  let previous: string;
  do {
    previous = key;
    key = trimUnbalancedParens(key)
      .replace(/[.,;:]+$/, "")
      .trim();
  } while (key !== previous);
  return key.toLowerCase();
}

export function isNeverDataPaperDoi(identifier: string): boolean {
  return NEVER_DATA_PAPER_DOIS.has(normalizeDoiKey(identifier));
}

/** The name form of a BIDS specification or tool title: `EEG-BIDS, an
 *  extension ...`, `Motion-BIDS: an extension ...`, `BIDS apps: ...`. The
 *  name must be followed by the comma or colon those papers use, so
 *  "BIDS-formatted EEG recordings ..." does not match. */
const BIDS_NAME_TITLE = /^(?:[\w]+-)?bids(?:\s+apps)?\s*[,:]/i;

/** The phrase form, anchored at the start of the title so a data paper that
 *  merely mentions an extension ("A dataset extending the Brain Imaging Data
 *  Structure with HED annotations") does not match. */
const BIDS_SPEC_PHRASE =
  /^(?:the brain imaging data structure, a format for organizing|(?:an? )?extension (?:to|of) the brain imaging data structure|extending the brain imaging data structure)/i;

/** True when `title` reads like a BIDS specification or BIDS tool paper; the
 *  same rule as nemar-citations' `is_spec_title`. */
export function isStandardSpecTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.trim();
  return BIDS_NAME_TITLE.test(t) || BIDS_SPEC_PHRASE.test(t);
}

/** True when `doiKey` (a {@link normalizeDoiKey} result) is the dataset's own
 *  NEMAR DOI: the concept DOI `10.82901/nemar.<id>` or a version DOI
 *  `10.82901/nemar.<id>.v<semver>`. A dataset never relates to itself. */
export function isOwnNemarDoi(doiKey: string, datasetId: string | undefined): boolean {
  if (!datasetId) return false;
  const own = `10.82901/nemar.${datasetId.toLowerCase()}`;
  return doiKey === own || doiKey.startsWith(`${own}.`);
}
