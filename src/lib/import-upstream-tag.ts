/**
 * Which upstream snapshot tag a dataset's `dataset_description.json` records (epic #1046 Phase 3,
 * ADR 0111 decisions 4 and 10).
 *
 * Read from the `SourceDatasets` entries that name the dataset's own OpenNeuro id, never from the
 * top-level `Version`: that key is NEMAR's own version of the dataset (`1.0.0` on a mirror that
 * mirrors upstream `2.0.2`). Within such an entry it reads `Version`, then a DOI of the form
 * `10.18112/openneuro.<ds>.v<tag>`, then a URL of OpenNeuro's (`.../datasets/<ds>/versions/<tag>`)
 * or of its GitHub mirror (`github.com/OpenNeuroDatasets/<ds>/tree/<tag>`), so a legacy entry that
 * names the tag only in its DOI or its URL counts too. Every tag those name must agree; any
 * disagreement is unknown, never a guess.
 *
 * Phase 2 (#1908) builds the shared parser ADR 0111 decision 4 names, `sourceSnapshotOf`, for the
 * version rows. This reader is the contract the import's guard needs until then; once both are
 * merged its body becomes `sourceSnapshotOf(desc, sourceId).tag ?? null`, and the tests in
 * test/import-upstream-tag.test.ts stay as that contract. Three behaviors differ from Phase 2's
 * parser, so the swap has to settle each of them deliberately:
 *   1. the tag shape: this reader takes any OpenNeuro tag (`OPENNEURO_TAG_PATTERN`, legacy `00006`
 *      and 24-hex snapshot ids included), where Phase 2's takes a numeric dotted tag only;
 *   2. an entry whose fields name two datasets (a DOI for this one and a URL for another): this
 *      reader counts the field naming this dataset, and the import never completes such an entry
 *      in place;
 *   3. GitHub mirror URLs: this reader accepts `github.com/OpenNeuroDatasets/<ds>` forms, which
 *      Phase 2's does not.
 */

import {
  isOpenNeuroTag,
  normalizeUpstreamTag,
  openNeuroDoiParts,
  openNeuroUrlParts,
} from "../../shared/openneuro-tag.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A tag from one field, without its leading `v`, or null when the field holds none. */
function asTag(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const tag = normalizeUpstreamTag(raw.trim());
  return isOpenNeuroTag(tag) ? tag : null;
}

interface EntryReading {
  /** Some field of the entry names `sourceId`. */
  names: boolean;
  /** Every DOI or URL field present names `sourceId` and nothing else. */
  namesOnly: boolean;
  /** The tags the entry's fields give for `sourceId`. */
  tags: string[];
}

/** What one `SourceDatasets` entry says about `sourceId`. Tolerates any value, `null` included. */
function readEntry(entry: unknown, sourceId: string): EntryReading {
  if (!isRecord(entry)) return { names: false, namesOnly: false, tags: [] };
  const ds = sourceId.toLowerCase();
  const tags: string[] = [];
  let names = false;
  let namesOther = false;

  if (typeof entry.DOI === "string" && entry.DOI.trim()) {
    const parts = openNeuroDoiParts(entry.DOI);
    if (parts?.ds === ds) {
      names = true;
      const tag = asTag(parts.tag);
      if (tag) tags.push(tag);
    } else {
      namesOther = true;
    }
  }
  if (typeof entry.URL === "string" && entry.URL.trim()) {
    const parts = openNeuroUrlParts(entry.URL);
    if (parts?.ds === ds) {
      names = true;
      const tag = asTag(parts.tag);
      if (tag) tags.push(tag);
    } else {
      namesOther = true;
    }
  }
  // `Version` says nothing about WHICH dataset, so it counts only in an entry the DOI or URL tied
  // to this one.
  if (names && typeof entry.Version === "string") {
    const tag = asTag(entry.Version);
    if (tag) tags.push(tag);
  }
  return { names, namesOnly: names && !namesOther, tags };
}

/** The upstream tag a description records, and why there is none when there is none. */
export type RecordedUpstreamTag =
  | { state: "recorded"; tag: string }
  /** No entry names the dataset with a tag. */
  | { state: "none"; tag: null }
  /** Entries for the dataset name more than one tag. */
  | { state: "disagree"; tag: null; tags: string[] };

/** {@link recordedUpstreamTag}, with the reason when it answers nothing. */
export function readRecordedUpstreamTag(desc: unknown, sourceId: string): RecordedUpstreamTag {
  if (!isRecord(desc) || !Array.isArray(desc.SourceDatasets)) return { state: "none", tag: null };
  const found = new Set<string>();
  for (const entry of desc.SourceDatasets) {
    for (const tag of readEntry(entry, sourceId).tags) found.add(tag);
  }
  if (found.size === 0) return { state: "none", tag: null };
  if (found.size > 1) return { state: "disagree", tag: null, tags: [...found].sort() };
  return { state: "recorded", tag: [...found][0] as string };
}

/**
 * The upstream tag `desc` records for `sourceId` (an OpenNeuro `ds######` id), or null when it
 * records none, or when what it records disagrees with itself.
 */
export function recordedUpstreamTag(desc: unknown, sourceId: string): string | null {
  return readRecordedUpstreamTag(desc, sourceId).tag;
}

/** Whether any `SourceDatasets` entry names `sourceId`, tagged or not. */
export function hasSourceEntryFor(desc: unknown, sourceId: string): boolean {
  if (!isRecord(desc) || !Array.isArray(desc.SourceDatasets)) return false;
  return desc.SourceDatasets.some((entry) => readEntry(entry, sourceId).names);
}
