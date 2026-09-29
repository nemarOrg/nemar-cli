/**
 * Papers that are never a dataset's data paper (#1549).
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
 *  Crossref when the list was written. */
export const NEVER_DATA_PAPER_DOIS: ReadonlySet<string> = new Set([
  // BIDS specification and its modality extensions
  "10.1038/sdata.2016.44", // BIDS
  "10.1038/s41597-019-0104-8", // EEG-BIDS
  "10.1038/sdata.2018.110", // MEG-BIDS
  "10.1038/s41597-019-0105-7", // iEEG-BIDS
  "10.1038/s41597-022-01164-1", // PET-BIDS
  "10.1038/s41597-024-03559-8", // Motion-BIDS
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

/** Comparable form of a DOI: resolver prefix stripped, trimmed, lowercased.
 *  DOIs are case-insensitive, and metadata carries both `10.1109/TBCAS...`
 *  and `10.1109/tbcas...` spellings of the same DOI. */
export function normalizeDoiKey(identifier: string): string {
  return identifier
    .trim()
    .replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, "")
    .trim()
    .toLowerCase();
}

export function isNeverDataPaperDoi(identifier: string): boolean {
  return NEVER_DATA_PAPER_DOIS.has(normalizeDoiKey(identifier));
}

/** Titles of BIDS specification papers: `EEG-BIDS, an extension ...`,
 *  `Motion-BIDS: an extension ...`, `BIDS apps: ...`, or a title that extends
 *  "the brain imaging data structure". Deliberately narrow: a data paper whose
 *  title merely mentions BIDS formatting ("An EEG dataset in BIDS format")
 *  does not match. */
export function isStandardSpecTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.trim();
  if (/^(?:[A-Za-z0-9]+-)?BIDS(?:\s+apps)?\s*[,:]/i.test(t)) return true;
  return (
    /brain imaging data structure/i.test(t) &&
    /\b(?:extension|extending|extended)\b|a format for organizing/i.test(t)
  );
}
