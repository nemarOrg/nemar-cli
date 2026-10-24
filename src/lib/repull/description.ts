/**
 * The field-level merge of `dataset_description.json` for a re-pull (ADR 0111, decision 1).
 *
 * NEMAR owns three things in the file and upstream owns the rest:
 *
 * - `DatasetDOI`, the concept DOI, is NEMAR's value (ours);
 * - `Version` is N.0.0;
 * - the `SourceDatasets` entry naming this dataset's own `ds` (`isOwnSourceEntry`) becomes
 *   `{DOI, URL, Version: to_tag}`, the entry the version DOI's mint reads `IsDerivedFrom` from.
 *
 * Every other key is merged three-way by canonical JSON value, so a correction or a conflict is per
 * key, never the whole file. The other `SourceDatasets` entries merge three-way as a set (the
 * lead's ruling of 2026-10-23): an entry either side added is kept, and one upstream removed is not
 * brought back. An entry may be anything, `null` included: `applyConceptDoiToDescription` throws on
 * a `null` entry, so nothing here calls it on these values.
 *
 * A key NEMAR's import blanked (`blankIdentifierJsonKeys`, ADR 0089) is explained, like any other
 * standard edit. A side that does not parse makes the whole file unexplained and unmergeable.
 */

import { blankIdentifierJsonKeys } from "../../../shared/identifier-scrub.js";
import {
  type CanonicalJsonValue,
  canonicalJson,
} from "../../../shared/neurobagel/canonical-json.js";
import { isOwnSourceEntry } from "../../../shared/source-snapshot.js";
import { canonicalValue, stripBom } from "./edits.js";

export const DESCRIPTION_PATH = "dataset_description.json";

/** Keys NEMAR owns; never merged as upstream's. */
const NEMAR_KEYS = new Set(["DatasetDOI", "Version", "SourceDatasets"]);

export type KeyClass = "keep-ours" | "take-theirs" | "conflict" | "correction";

export interface KeyDecision {
  key: string;
  class: KeyClass;
  subtype: string | null;
  /** Canonical JSON of each side's value; null when the side has no such key. */
  base: string | null;
  theirs: string | null;
  ours: string | null;
  /** Which side's value N.0.0 takes. */
  take: "ours" | "theirs";
}

export interface DescriptionMerge {
  status: "merged" | "unparseable" | "absent";
  /** Keys where some side differs, sorted. */
  keys: KeyDecision[];
  /** Every upstream-owned key is explained against base alone (for lineage). */
  explainedBase: boolean;
  /** Every upstream-owned key is explained against base or theirs. */
  explained: boolean;
  upstreamChanged: boolean;
  sourceDatasets: { kept: number; addedByNemar: number; removedByUpstream: number };
  /** The merged description, as canonical JSON; null unless `status` is `merged`. */
  mergedJson: string | null;
  /** The concept DOI NEMAR's description holds (`DatasetDOI`), or null. */
  conceptDoi: string | null;
}

/** Parse a side: absent is null, an unparseable side is `"unparseable"`. */
function parseSide(
  bytes: Buffer | null | undefined,
  present: boolean,
): Record<string, unknown> | null | "unparseable" {
  if (!present) return null;
  if (!bytes) return "unparseable";
  try {
    const text = stripBom(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : "unparseable";
  } catch {
    return "unparseable";
  }
}

/** The description as the import's JSON blank leaves it, for the explained check. */
function blanked(
  bytes: Buffer | null | undefined,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  if (!bytes) return parsed;
  try {
    const r = blankIdentifierJsonKeys(bytes);
    if (r.status !== "blanked" || !r.bytes) return parsed;
    const v = JSON.parse(stripBom(new TextDecoder().decode(r.bytes)));
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : parsed;
  } catch {
    return parsed;
  }
}

function entriesOf(desc: Record<string, unknown>): unknown[] {
  const sd = desc.SourceDatasets;
  if (Array.isArray(sd)) return sd;
  if (sd !== undefined && sd !== null && typeof sd === "object") return [sd];
  return [];
}

/** The `SourceDatasets` entry a re-pull to `toTag` writes for the dataset's own `ds`. */
export function ownSourceEntry(ds: string, toTag: string): Record<string, string> {
  return {
    DOI: `doi:10.18112/openneuro.${ds}.v${toTag}`,
    URL: `https://openneuro.org/datasets/${ds}/versions/${toTag}`,
    Version: toTag,
  };
}

function conflictSubtype(b: string | null, t: string | null, o: string | null): string {
  if (b === null) return "both-added";
  if (t === null) return "upstream-deleted/nemar-changed";
  if (o === null) return "nemar-deleted/upstream-changed";
  return "both-modified";
}

function correctionSubtype(b: string | null, o: string | null): string {
  if (b === null) return "nemar-added";
  if (o === null) return "nemar-deleted";
  return "nemar-modified";
}

/** Merge the three sides of `dataset_description.json`; see the module comment for the rule. */
export function mergeDescription(args: {
  base: { present: boolean; bytes: Buffer | null };
  theirs: { present: boolean; bytes: Buffer | null };
  ours: { present: boolean; bytes: Buffer | null };
  ds: string;
  toTag: string;
  nextVersion: string;
}): DescriptionMerge {
  const empty = { kept: 0, addedByNemar: 0, removedByUpstream: 0 };
  const b = parseSide(args.base.bytes, args.base.present);
  const t = parseSide(args.theirs.bytes, args.theirs.present);
  const o = parseSide(args.ours.bytes, args.ours.present);
  if (b === "unparseable" || t === "unparseable" || o === "unparseable") {
    return {
      status: "unparseable",
      keys: [],
      explainedBase: false,
      explained: false,
      upstreamChanged: true,
      sourceDatasets: empty,
      mergedJson: null,
      conceptDoi:
        o && o !== "unparseable" && typeof o.DatasetDOI === "string" ? o.DatasetDOI : null,
    };
  }
  if (t === null) {
    // Upstream deleted its description: nothing to merge onto. Never executable.
    return {
      status: "absent",
      keys: [],
      explainedBase: false,
      explained: false,
      upstreamChanged: b !== null,
      sourceDatasets: empty,
      mergedJson: null,
      conceptDoi: o && typeof o.DatasetDOI === "string" ? o.DatasetDOI : null,
    };
  }
  const base = b ?? {};
  const theirs = t;
  const ours = o ?? {};
  const baseBlanked = blanked(args.base.bytes, base);
  const theirsBlanked = blanked(args.theirs.bytes, theirs);

  const order: string[] = [];
  for (const k of [...Object.keys(theirs), ...Object.keys(ours), ...Object.keys(base)]) {
    if (!order.includes(k) && !NEMAR_KEYS.has(k)) order.push(k);
  }

  const canon = (obj: Record<string, unknown>, k: string) =>
    Object.hasOwn(obj, k) ? canonicalValue(obj[k]) : null;
  const keys: KeyDecision[] = [];
  const merged: Record<string, unknown> = {};
  let explainedBase = true;
  let explained = true;
  let upstreamChanged = false;
  for (const k of order) {
    const bv = canon(base, k);
    const tv = canon(theirs, k);
    const ov = canon(ours, k);
    const viaBase = ov === bv || ov === canon(baseBlanked, k);
    const viaTheirs = ov === tv || ov === canon(theirsBlanked, k);
    const changed = bv !== tv;
    if (changed) upstreamChanged = true;
    if (!viaBase) explainedBase = false;
    if (!viaBase && !viaTheirs) explained = false;
    let cls: KeyClass;
    let take: "ours" | "theirs";
    let subtype: string | null = null;
    if (!changed && (viaBase || viaTheirs)) {
      cls = "keep-ours";
      take = "ours";
    } else if (changed && (viaBase || viaTheirs)) {
      cls = "take-theirs";
      take = viaTheirs ? "ours" : "theirs";
    } else if (changed) {
      cls = "conflict";
      take = "theirs";
      subtype = conflictSubtype(bv, tv, ov);
    } else {
      cls = "correction";
      take = "theirs";
      subtype = correctionSubtype(bv, ov);
    }
    const from = take === "ours" ? ours : theirs;
    if (Object.hasOwn(from, k)) merged[k] = from[k];
    if (bv !== tv || bv !== ov) {
      keys.push({ key: k, class: cls, subtype, base: bv, theirs: tv, ours: ov, take });
    }
  }

  // SourceDatasets: the own entry is NEMAR's; the others merge three-way as a set.
  const others = (desc: Record<string, unknown>) =>
    entriesOf(desc).filter((e) => !isOwnSourceEntry(e, args.ds));
  const B = new Set(others(base).map(canonicalValue));
  const T = others(theirs);
  const O = others(ours);
  const Tset = new Set(T.map(canonicalValue));
  const Oset = new Set(O.map(canonicalValue));
  const sources: unknown[] = [];
  const seen = new Set<string>();
  let kept = 0;
  let addedByNemar = 0;
  for (const e of T) {
    const c = canonicalValue(e);
    // An entry upstream kept that NEMAR removed stays removed only if NEMAR's removal is the
    // change; the set rule keeps what either side added and drops what either side removed.
    if (seen.has(c) || (B.has(c) && !Oset.has(c))) continue;
    seen.add(c);
    sources.push(e);
    kept++;
  }
  for (const e of O) {
    const c = canonicalValue(e);
    if (seen.has(c) || B.has(c)) continue;
    seen.add(c);
    sources.push(e);
    addedByNemar++;
  }
  const removedByUpstream = [...B].filter((c) => !Tset.has(c) && Oset.has(c)).length;
  sources.push(ownSourceEntry(args.ds, args.toTag));

  const conceptDoi = typeof ours.DatasetDOI === "string" ? ours.DatasetDOI : null;
  const final: Record<string, unknown> = { ...merged };
  if (conceptDoi !== null) final.DatasetDOI = conceptDoi;
  final.Version = args.nextVersion;
  final.SourceDatasets = sources;

  keys.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return {
    status: "merged",
    keys,
    explainedBase,
    explained,
    upstreamChanged,
    sourceDatasets: { kept, addedByNemar, removedByUpstream },
    mergedJson: canonicalJson(final as CanonicalJsonValue),
    conceptDoi,
  };
}
