/**
 * The NIRx reader: the text of NIRx `.hdr` headers (NIRStar, and NIRSport2's `*_config.hdr`) and
 * `.inf` subject files, each read whole up to 1 MiB. The signal files (`.wl1`, `.wl2`), the `.dat`
 * and the `.evt` are never read; they are the header's companions.
 *
 * What it reports:
 *
 * - `nirx-subject-name` (identifier): a person field (the subject's `Name=` in an `.inf`,
 *   NIRSport2's `experiment_subject=`, an operator or experimenter) that is not empty, reads as a
 *   name, and is not the BIDS subject label of the file's path.
 * - `nirx-demographics`: a birth date, by A4's rule: to the day it is an identifier; a year or a
 *   year and month is review; empty or a placeholder is nothing. An age alone is nothing (ages are
 *   routinely public in participants.tsv).
 * - `nirx-freetext` (review) and `local-user-path`: an email address, a phone number or a
 *   home-directory path in a contact or notes field (`Contact Information`, `Notes`, and
 *   NIRSport2's `experiment_subject_contact_info` and `experiment_remarks`).
 * - `nirx-header-date` (a date kind, ADR 0090): the header's acquisition `Date=`, unless it is
 *   empty or a year-only date. A date in a layout the scanner cannot parse is reported too: the
 *   field holds nothing but the acquisition date.
 *
 * **Companions are paired by name** (lead ruling, phase A2): an `.hdr` needs `<base>.wl1` and
 * `<base>.wl2` beside it and claims `<base>.dat`, `.evt` and `.inf` when they are there (NIRSport2's
 * base drops `_config`); an `.inf` needs `<base>.hdr`. A NIRStar header whose `FileName=` is not its
 * own base name carries the note `companion-name-mismatch` (never a gap).
 *
 * A file with the extension that does not start like a NIRx text header (an Analyze `.hdr` of an
 * MRI, a Windows driver `.inf`) is `not-applicable`: counted as unscreened, never `unchecked`.
 */

import type { FormatReader, RangeSource, ReaderResult } from "../identifier-readers";
import {
  type Finding,
  datePrecision,
  hasDateFinerThanYear,
  isNameLike,
  shapeOf,
} from "../identifier-scan";
import {
  type IniSection,
  TEXT_HEADER_LIMITS,
  capText,
  checkReference,
  decodeHeader,
  entryValue,
  freeTextFindings,
  isPersonField,
  pairByName,
  parseIni,
  readHeader,
  splitPath,
  startsBinary,
  stem,
  unplacedTextFindings,
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

/** Values that mean nothing was entered. */
const PLACEHOLDER = /^(|0+(\.0+)?|-+|n\/?a|none|unknown|x+|\?+|00[./-]00[./-]0{2,4})$/i;

/** A birth-date field. */
const BIRTH_FIELD = /birth|\bdob\b/i;
/** A free-text field that may hold contact details. */
const FREE_TEXT_FIELD = /contact|notes|remarks/i;

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

/**
 * Findings from a subject block (an `.inf`'s demographics, or NIRSport2's or NIRStar's experiment
 * notes): person fields, birth dates, and contact or notes text.
 */
function screenSubjectBlock(
  section: IniSection | undefined,
  path: string,
  findings: Finding[],
): { cut: boolean } {
  let cut = false;
  const seen = new Set<string>();
  const once = (finding: Finding) => {
    if (seen.has(finding.kind)) return;
    seen.add(finding.kind);
    findings.push(finding);
  };
  for (const { key, value } of section?.entries ?? []) {
    // Every rule below reads at most the cap of one value.
    const capped = capText(value.trim());
    cut ||= capped.cut;
    const v = capped.text;
    if (v === "") continue;
    if (BIRTH_FIELD.test(key)) {
      if (PLACEHOLDER.test(v)) continue;
      const precision = datePrecision(v);
      once({
        kind: "nirx-demographics",
        severity: precision === "day" ? "identifier" : "review",
        field: "birth date",
        shape: shapeOf(v),
      });
    } else if (FREE_TEXT_FIELD.test(key)) {
      for (const f of freeTextFindings(v, "nirx-freetext", key).findings) once(f);
    } else if (isPersonField(key)) {
      if (PLACEHOLDER.test(v) || !nameIsNameLike(v) || isSubjectLabel(v, path)) continue;
      once({ kind: "nirx-subject-name", severity: "identifier", field: key, shape: shapeOf(v) });
    }
  }
  return { cut };
}

/**
 * Screen one NIRx file's text. `path` decides whether it is a header or an `.inf`; `whole` says
 * whether the text is the whole file.
 */
export function scanNirxText(
  text: string,
  path: string,
  whole: boolean,
  binaryStart = false,
): ReaderResult {
  const findings: Finding[] = [];
  const isHeader = path.toLowerCase().endsWith(HDR);
  const sections = parseIni(text);
  const section = sections.get(isHeader ? "generalinfo" : "subject demographics");
  if (!section) {
    // No NIRx section anywhere. A binary file (an Analyze image header) is another format:
    // unscreened. Text (a Windows driver `.inf`, an edited header) is screened as free text and is
    // a partial read, so a missing section can never hide what the file holds.
    if (binaryStart) return { findings, coverage: "not-applicable" };
    return {
      findings: unplacedTextFindings(text, "nirx-freetext"),
      coverage: "partial",
      incomplete: "unsupported-version",
    };
  }
  let unmatched = false;
  let cut = false;

  if (isHeader) {
    const general = section;
    const dateValue = entryValue(general, "Date");
    const dateCapped = dateValue === undefined ? undefined : capText(dateValue);
    cut ||= dateCapped?.cut ?? false;
    const date = dateCapped?.text;
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
      const capped = capText(fileName);
      cut ||= capped.cut;
      if (checkReference(capped.text, name, name) !== "match") unmatched = true;
    }
    // NIRSport2 keeps the subject in the header's experiment notes; NIRStar keeps notes there.
    cut ||= screenSubjectBlock(sections.get("experimentnotes"), path, findings).cut;
  } else {
    cut ||= screenSubjectBlock(section, path, findings).cut;
  }

  const notes = unmatched ? { notes: ["companion-name-mismatch" as const] } : {};
  // A file past the byte limit, or a value past the free-text cap, was read only in part.
  if (!whole || cut) return { findings, coverage: "partial", incomplete: "limit", ...notes };
  return { findings, coverage: "complete", ...notes };
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
    return scanNirxText(decodeHeader(bytes), path, whole, startsBinary(bytes));
  },
};
