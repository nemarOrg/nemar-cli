/**
 * Which upstream snapshot tag a dataset's `dataset_description.json` records (epic #1046 Phase 3,
 * ADR 0111 decisions 4 and 10).
 *
 * Read from the `SourceDatasets` entries that name the dataset's own OpenNeuro id, never from the
 * top-level `Version`: that key is NEMAR's own version of the dataset (`1.0.0` on a mirror that
 * mirrors upstream `2.0.2`). Within such an entry it reads `Version`, then a DOI of the form
 * `10.18112/openneuro.<ds>.v<tag>`, then a URL `.../datasets/<ds>/versions/<tag>`, so a legacy entry
 * that names the tag only in its DOI or its URL counts too. Every tag those name must agree; any
 * disagreement is unknown, never a guess.
 *
 * Phase 2 (#1908) builds the shared parser ADR 0111 decision 4 names, `sourceSnapshotOf`, for the
 * version rows. This reader is the contract the import's guard needs until then; once both are
 * merged its body becomes `sourceSnapshotOf(desc, sourceId).tag ?? null`, and the tests in
 * test/import-upstream-tag.test.ts stay as that contract.
 */

import { isOpenNeuroTag, normalizeUpstreamTag } from "../../shared/openneuro-tag.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A tag from one field, without its leading `v`, or null when the field holds none. */
function asTag(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const tag = normalizeUpstreamTag(raw.trim());
  return isOpenNeuroTag(tag) ? tag : null;
}

/** What one `SourceDatasets` entry says about `sourceId`: whether it names it, and which tags. */
function readEntry(entry: unknown, sourceId: string): { names: boolean; tags: string[] } {
  if (!isRecord(entry)) return { names: false, tags: [] };
  const ds = escapeRegExp(sourceId);
  const tags: string[] = [];
  let names = false;

  const doi = typeof entry.DOI === "string" ? entry.DOI.trim() : "";
  if (doi) {
    const bare = doi.replace(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i, "");
    // `10.18112/openneuro.<ds>` alone is the concept DOI: it names the dataset and no tag.
    const m = new RegExp(`^10\\.18112/openneuro\\.${ds}(?:\\.(v[^/\\s]+))?$`, "i").exec(bare);
    if (m) {
      names = true;
      const tag = asTag(m[1]);
      if (tag) tags.push(tag);
    }
  }

  const url = typeof entry.URL === "string" ? entry.URL.trim() : "";
  if (url) {
    const m = new RegExp(`/datasets/${ds}(?:/versions/([^/?#\\s]+))?(?:[/?#]|$)`, "i").exec(url);
    if (m) {
      names = true;
      const tag = asTag(m[1]);
      if (tag) tags.push(tag);
    }
  }

  // `Version` says nothing about WHICH dataset, so it counts only in an entry the DOI or URL tied
  // to this one.
  if (names && typeof entry.Version === "string") {
    const tag = asTag(entry.Version);
    if (tag) tags.push(tag);
  }
  return { names, tags };
}

/**
 * The upstream tag `desc` records for `sourceId` (an OpenNeuro `ds######` id), or null when it
 * records none, or when what it records disagrees with itself.
 */
export function recordedUpstreamTag(desc: unknown, sourceId: string): string | null {
  if (!isRecord(desc) || !Array.isArray(desc.SourceDatasets)) return null;
  const found = new Set<string>();
  for (const entry of desc.SourceDatasets) {
    for (const tag of readEntry(entry, sourceId).tags) found.add(tag);
  }
  if (found.size !== 1) return null;
  return [...found][0] as string;
}

/** Whether any `SourceDatasets` entry names `sourceId`, tagged or not. */
export function hasSourceEntryFor(desc: unknown, sourceId: string): boolean {
  if (!isRecord(desc) || !Array.isArray(desc.SourceDatasets)) return false;
  return desc.SourceDatasets.some((entry) => readEntry(entry, sourceId).names);
}
