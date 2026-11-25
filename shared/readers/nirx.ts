/**
 * The NIRx reader: the text of NIRx `.hdr` headers (NIRStar, and NIRSport2's `*_config.hdr`) and
 * `.inf` subject files, each read whole up to 1 MiB. The signal files (`.wl1`, `.wl2`), the `.dat`
 * and the `.evt` are never read; they are the header's companions.
 *
 * What it reports:
 *
 * - `nirx-subject-name` (identifier): the subject's `Name=` in an `.inf` (or NIRSport2's
 *   `experiment_subject=`) when it is not empty, reads as a name, and is not the BIDS subject label
 *   of the file's path.
 * - `nirx-demographics` (review): a birth date finer than the year, or an `Age=` that holds a value
 *   other than empty, `0` or a placeholder.
 * - `nirx-header-date` (a date kind, ADR 0090): the header's acquisition `Date=`, unless it is
 *   empty or a year-only date. A date in a layout the scanner cannot parse is reported too: the
 *   field holds nothing but the acquisition date.
 *
 * **Companions are paired by name** (lead ruling, phase A2): an `.hdr` needs `<base>.wl1` and
 * `<base>.wl2` beside it and claims `<base>.dat`, `.evt` and `.inf` when they are there (NIRSport2's
 * base drops `_config`); an `.inf` needs `<base>.hdr`. A NIRStar header whose `FileName=` is not its
 * own base name is read `partial` with reason `companion-missing`.
 */

import type { FormatReader, RangeSource, ReaderResult } from "../identifier-readers";
import { type Finding, hasDateFinerThanYear, isNameLike, shapeOf } from "../identifier-scan";
import {
  type IniSection,
  TEXT_HEADER_LIMITS,
  checkReference,
  decodeHeader,
  entryValue,
  pairByName,
  parseIni,
  readHeader,
  splitPath,
  stem,
} from "./text-header";

const HDR = ".hdr";
const INF = ".inf";
const CONFIG = "_config";

/** The base name of a NIRx file: its path without the extension, and without NIRSport2's `_config`. */
function nirxBase(path: string): string {
  const lower = path.toLowerCase();
  const withoutExt = lower.endsWith(HDR) ? stem(path, HDR) : stem(path, INF);
  return withoutExt.toLowerCase().endsWith(CONFIG)
    ? withoutExt.slice(0, -CONFIG.length)
    : withoutExt;
}

/** `Age=` values that mean nothing was entered. */
const EMPTY_AGE = /^(|0+(\.0+)?|-|n\/?a|none|unknown|x+|\?+)$/i;

/** The BIDS subject label of a path (`sub-<label>`), lowercased, or null. */
function subjectLabel(path: string): string | null {
  return /(?:^|\/)sub-([\p{L}\p{N}]+)/u.exec(path)?.[1]?.toLowerCase() ?? null;
}

/**
 * Words a NIRx subject field holds that name the device, the software or the recording rather
 * than a person. Compared lowercase; the scanner's own neutral words are added by `isNameLike`.
 */
const NIRX_WORDS = new Set([
  "nirx",
  "nirs",
  "fnirs",
  "nirscout",
  "nirsport",
  "nirsport2",
  "nirstar",
  "aurora",
  "mne",
  "montage",
  "probe",
  "optode",
  "optodes",
  "task",
  "tasks",
  "all",
  "no",
  "saturation",
  "short",
  "long",
  "test",
  "testing",
  "demo",
  "sample",
  "example",
]);

/**
 * A subject name that reads as a person's name. camelCase seams and `_`/`-` split it into words
 * (`TestRecording` is two), words that name the device or the recording are dropped, and the
 * scanner's own name test decides each word left.
 */
function nameIsNameLike(name: string): boolean {
  return name
    .replace(/([\p{Ll}])([\p{Lu}])/gu, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word !== "" && !NIRX_WORDS.has(word.toLowerCase()))
    .some((word) => isNameLike(word));
}

/** True when a name is the path's subject label, with or without `sub-`, in any letter case. */
function isSubjectLabel(name: string, path: string): boolean {
  const label = subjectLabel(path);
  if (label === null) return false;
  const bare = name.trim().toLowerCase().replace(/^sub-/, "");
  return bare === label;
}

/** A demographics entry: the section and the keys its subject name, age and birth date use. */
interface Demographics {
  section: IniSection | undefined;
  name: string;
  age: string;
}

/** Findings from a subject block (the `.inf`'s demographics, or NIRSport2's experiment notes). */
function screenDemographics(d: Demographics, path: string, findings: Finding[]): void {
  const name = entryValue(d.section, d.name);
  if (name !== undefined && name !== "" && nameIsNameLike(name) && !isSubjectLabel(name, path)) {
    findings.push({
      kind: "nirx-subject-name",
      severity: "identifier",
      field: d.name,
      shape: shapeOf(name),
    });
  }
  let flagged = false;
  for (const { key, value } of d.section?.entries ?? []) {
    if (flagged) break;
    if (/birth|\bdob\b/i.test(key) && hasDateFinerThanYear(value)) {
      flagged = true;
      findings.push({
        kind: "nirx-demographics",
        severity: "review",
        field: "birth date",
        shape: shapeOf(value),
      });
    }
  }
  const age = entryValue(d.section, d.age);
  if (!flagged && age !== undefined && !EMPTY_AGE.test(age.trim())) {
    findings.push({
      kind: "nirx-demographics",
      severity: "review",
      field: d.age,
      shape: shapeOf(age),
    });
  }
}

/**
 * Screen one NIRx file's text. `path` decides whether it is a header or an `.inf`; `whole` says
 * whether the text is the whole file.
 */
export function scanNirxText(text: string, path: string, whole: boolean): ReaderResult {
  const findings: Finding[] = [];
  const sections = parseIni(text);
  const isHeader = path.toLowerCase().endsWith(HDR);
  let unmatched = false;

  if (isHeader) {
    const general = sections.get("generalinfo");
    if (!general) {
      // An `.hdr` that is not a NIRx header (an Analyze image header, say): nothing here is read.
      return { findings, coverage: "partial", incomplete: "unsupported-version" };
    }
    const date = entryValue(general, "Date");
    if (date !== undefined && date !== "" && !isYearOnlyDate(date)) {
      findings.push({
        kind: "nirx-header-date",
        severity: "review",
        field: "Date",
        shape: shapeOf(date),
      });
    }
    // NIRStar names the recording's base name; NIRSport2 writes no FileName.
    const fileName = entryValue(general, "FileName");
    if (fileName !== undefined && fileName !== "") {
      const { name } = splitPath(nirxBase(path));
      if (checkReference(fileName, name, name) !== "match") unmatched = true;
    }
    // NIRSport2 keeps the subject in the header's experiment notes.
    screenDemographics(
      {
        section: sections.get("experimentnotes"),
        name: "experiment_subject",
        age: "experiment_subject_age",
      },
      path,
      findings,
    );
  } else {
    const demographics = sections.get("subject demographics");
    if (!demographics) {
      return { findings, coverage: "partial", incomplete: "unsupported-version" };
    }
    screenDemographics({ section: demographics, name: "Name", age: "Age" }, path, findings);
  }

  if (!whole) return { findings, coverage: "partial", incomplete: "limit" };
  if (unmatched) return { findings, coverage: "partial", incomplete: "companion-missing" };
  return { findings, coverage: "complete" };
}

/**
 * A NIRx `Date=` that is only a year: `2019`, or 1 January in a layout the scanner reads. A value
 * the scanner reads no date in at all is not year-only (it is reported, see the module comment).
 */
function isYearOnlyDate(value: string): boolean {
  if (/^\s*\d{4}\s*$/.test(value)) return true;
  // NIRStar writes `Wed, Oct 2, 2019`; the scanner reads the day first, so turn `Oct 2, 2019`
  // into `2 Oct 2019` before asking it.
  const normalized = value.replace(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/, "$2 $1 $3");
  return (
    !hasDateFinerThanYear(normalized) && /\b1\s*(jan|january|\.0?1\.)|-01-01\b/i.test(normalized)
  );
}

export const NIRX_READER: FormatReader = {
  id: "nirx",
  extensions: [HDR, INF],
  limits: TEXT_HEADER_LIMITS,
  version: "1",
  companions(path, siblings) {
    const base = nirxBase(path);
    if (path.toLowerCase().endsWith(HDR)) {
      return pairByName(base, [".wl1", ".wl2"], [".dat", ".evt", INF], siblings);
    }
    // An `.inf` belongs to the NIRStar header of the same base name.
    return pairByName(base, [HDR], [], siblings);
  },
  async scan(src: RangeSource, path: string, limits) {
    const { bytes, whole } = await readHeader(src, limits.maxBytes);
    return scanNirxText(decodeHeader(bytes), path, whole);
  },
};
