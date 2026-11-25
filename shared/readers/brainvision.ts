/**
 * The BrainVision reader: the text of `.vhdr` headers and `.vmrk` marker files, each read whole
 * up to 1 MiB. The binary `.eeg` is never read; it is the header's companion.
 *
 * What it reports:
 *
 * - `brainvision-comment-name` (review): a name-like word in the header's `[Comment]` section,
 *   which Recorder fills with the amplifier setup. Recorder's own words, the header's channel
 *   labels and units, electrode labels, short acronyms, and tokens with a digit or a path are not
 *   tested, so a setup that holds no name fires nothing. Measured on 337 public headers from 162
 *   OpenNeuro datasets before merging (the A2 pull request has the counts).
 * - `brainvision-segment-date` (a date kind, ADR 0090): a `New Segment` marker whose timestamp
 *   (`YYYYMMDDhhmmssuuuuuu`) is a date that is not 1 January. One finding per marker file.
 * - `local-user-path` (review): a `DataFile` or `MarkerFile` given as an absolute path or a path
 *   into a home directory.
 *
 * - `brainvision-marker-text` (review) and `local-user-path`: an email address, a phone number or
 *   a home-directory path in a marker description.
 *
 * **Companions are paired by name** (lead rulings, phase A2): a `.vhdr` needs `<base>.eeg` and
 * `<base>.vmrk` beside it, and a `.vmrk` needs `<base>.vhdr`, so an orphan is never clean. Inside
 * the file, a `DataFile` or `MarkerFile` that does not name that companion by its bare file name
 * is the note `companion-name-mismatch`: counted and printed with its remedy, never a gap, since
 * the header was read in full and the `.eeg` is never read. Marker files are read up to 16 MiB,
 * headers up to 1 MiB.
 */

import type { FormatReader, RangeSource, ReaderResult } from "../identifier-readers";
import {
  type Finding,
  hasDateFinerThanYear,
  isNameLike,
  scanTextForLocalPaths,
  shapeOf,
} from "../identifier-scan";
import {
  type IniSection,
  MARKER_FILE_LIMITS,
  TEXT_HEADER_LIMITS,
  checkReference,
  contactIn,
  decodeHeader,
  entryValue,
  pairByName,
  parseIni,
  readHeader,
  splitPath,
  stem,
} from "./text-header";

/**
 * Words BrainVision Recorder (and the converters that copy its header) write into `[Comment]`:
 * the amplifier setup, the channel table, filters and impedances. Compared lowercase. A word here
 * is never a name in this section; the scanner's own neutral words are added by `isNameLike`.
 */
const RECORDER_WORDS = new Set<string>([
  // The setup block and its headings.
  "amplifier",
  "setup",
  "number",
  "channels",
  "sampling",
  "rate",
  "interval",
  "hz",
  "µs",
  "us",
  "ms",
  "khz",
  "phys",
  "chn",
  "resolution",
  "low",
  "high",
  "cutoff",
  "notch",
  "series",
  "res",
  "gradient",
  "offset",
  "software",
  "filters",
  "filter",
  "disabled",
  "enabled",
  "off",
  "on",
  "dc",
  "ac",
  "unit",
  "units",
  "µv",
  "uv",
  "mv",
  "nv",
  "kohm",
  "ohm",
  "kω",
  "mω",
  "electrode",
  "electrodes",
  "selected",
  "impedance",
  "impedances",
  "measurement",
  "range",
  "ground",
  "gnd",
  "reference",
  "data",
  "aux",
  "acc",
  "acceleration",
  "type",
  "mode",
  "model",
  "serial",
  "version",
  "module",
  "modules",
  "auxiliary",
  "trigger",
  "triggers",
  "marker",
  "markers",
  "segment",
  "segmentation",
  "averaging",
  "average",
  "edit",
  "new",
  "out",
  "unknown",
  "not",
  "available",
  "valid",
  "invalid",
  "saturation",
  "bits",
  "bit",
  "volt",
  "voltage",
  "bandpass",
  "band",
  "pass",
  "highpass",
  "lowpass",
  "slope",
  "db",
  "oct",
  "order",
  "frequency",
  "frequencies",
  "seconds",
  "sec",
  "time",
  "constant",
  "use",
  "used",
  "value",
  "values",
  "measured",
  "per",
  "all",
  "no",
  "yes",
  "true",
  "false",
  "none",
  "default",
  "name",
  "label",
  "labels",
  "chan",
  "physical",
  "virtual",
  "bipolar",
  "common",
  "infos",
  "info",
  "information",
  "comment",
  "comments",
  // Vendors, amplifiers and the programs that write or rewrite these headers.
  "brain",
  "vision",
  "products",
  "gmbh",
  "brainamp",
  "brainampdc",
  "brainampmr",
  "actichamp",
  "actichampplus",
  "liveamp",
  "quickamp",
  "vamp",
  "actiview",
  "actiCAP",
  "acticap",
  "easycap",
  "brainvisionrecorder",
  "pycorder",
  "pybv",
  "mne",
  "bids",
  "eeglab",
  "fieldtrip",
  "matlab",
  "python",
  "converted",
  "conversion",
  "exported",
  "export",
  "written",
  "created",
  "generated",
  "file",
  "files",
  "header",
  "exchange",
  "format",
  "binary",
  "multiplexed",
  "vectorized",
  "float",
  "int",
  "ieee",
  "analyzer",
  // Recorder's workspace and device lines, and the impedance verdicts.
  "professional",
  "workspace",
  "workfile",
  "workfiles",
  "base",
  "button",
  "good",
  "bad",
  "level",
  "active",
  "passive",
  "dry",
  "wet",
  "gel",
  "imported",
  "started",
  "stopped",
  "rev",
  "kohms",
  "drv",
  "dsp",
  "dll",
  "fpga",
  "fpgac",
  "fpgam",
  "ctrl",
  "firmware",
  "driver",
  "hardware",
  // LiveAmp's recording lines.
  "recorded",
  "recording",
  "memory",
  "card",
  "free",
  "disk",
  "space",
  "size",
  "fragment",
  "fragments",
  "battery",
  "batteries",
  "levels",
  "signal",
  "signals",
  "is",
  "was",
  "are",
  "be",
  "not",
]);

/** A 10-20 (10-10, 10-5) electrode label such as `Cz`, `FCz`, `AF7` or `CCP5h`: never a name. */
const ELECTRODE_LABEL =
  /^(n|nz|fp|afp|af|aff|f|ffc|fc|fct|ft|ftt|t|tt|tpp|c|cc|ccp|cp|cpp|tp|p|pp|ppo|po|poo|o|oi|i|a|m|lm|rm)(z|\d{1,2})h?$/i;

/** A heading Recorder writes with its letters spaced out (`S o f t w a r e  F i l t e r s`). */
const SPACED_HEADING = /^\s*(\S\s{1,2}){3,}\S\s*$/;

/**
 * A token of the comment, read the way the scanner's name test reads it, minus what Recorder
 * writes. A token with a digit (a version, a serial number, an impedance), a path, a bracketed unit
 * or a single letter is not tested; the rest is split on camelCase seams and on `.`/`_`, and each
 * part that is neither a Recorder word, one of this header's channel labels, an electrode label nor
 * a short acronym goes to the scanner's name test.
 */
function commentTokenIsNameLike(token: string, exempt: ReadonlySet<string>): boolean {
  if (/\p{N}/u.test(token) || /[\\/]/.test(token) || /^[[(].*[\])]:?$/.test(token)) return false;
  // A Recorder word written in its own letter case (`actiCHamp`, `PyCorder`) is one word.
  if (exempt.has(token.replace(/[^\p{L}]+$/u, "").toLowerCase())) return false;
  const parts = token
    .replace(/([\p{Ll}])([\p{Lu}])/gu, "$1 $2")
    .split(/[^\p{L}'._-]+/u)
    .flatMap((p) => p.split(/[._-]+/))
    .filter(
      (p) =>
        /\p{L}{2,}/u.test(p) &&
        !exempt.has(p.toLowerCase()) &&
        !ELECTRODE_LABEL.test(p) &&
        !/^\p{Lu}{2,3}$/u.test(p),
    );
  return parts.some((p) => isNameLike(p));
}

/** Channel labels (`Ch1=Fp1,...`) and their units, lowercased: never a name in this header. */
function channelWords(section: IniSection | undefined): Set<string> {
  const out = new Set<string>();
  for (const { key, value } of section?.entries ?? []) {
    if (!/^ch\d+$/i.test(key)) continue;
    const fields = value.split(",");
    for (const field of [fields[0], fields[3]]) {
      const word = field?.replace(/\\1/g, ",").trim().toLowerCase();
      if (word) out.add(word);
    }
  }
  return out;
}

/** Every name-like token of a header's `[Comment]` section, in order. */
function commentNameTokens(sections: Map<string, IniSection>): string[] {
  const exempt = new Set([...RECORDER_WORDS, ...channelWords(sections.get("channel infos"))]);
  const out: string[] = [];
  for (const line of sections.get("comment")?.lines ?? []) {
    if (SPACED_HEADING.test(line)) continue;
    for (const token of line.split(/\s+/)) {
      if (token !== "" && commentTokenIsNameLike(token, exempt)) out.push(token);
    }
  }
  return out;
}

/** The first marker description with a home-directory path, and the first with contact details. */
function markerText(markers: IniSection | undefined): {
  path: string | null;
  contact: string | null;
} {
  let path: string | null = null;
  let contact: string | null = null;
  for (const { key, value } of markers?.entries ?? []) {
    if (path !== null && contact !== null) break;
    if (!/^mk\d+$/i.test(key)) continue;
    const description = (value.split(",")[1] ?? "").replace(/\\1/g, ",").trim();
    if (description === "") continue;
    if (path === null && scanTextForLocalPaths(description).length > 0) path = description;
    if (contact === null && contactIn(description) !== null) contact = description;
  }
  return { path, contact };
}

/** The first `New Segment` marker whose timestamp is a date that is not 1 January, or null. */
function segmentDate(markers: IniSection | undefined): string | null {
  for (const { key, value } of markers?.entries ?? []) {
    if (!/^mk\d+$/i.test(key)) continue;
    const fields = value.split(",");
    if ((fields[0] ?? "").trim().toLowerCase() !== "new segment") continue;
    const stamp = (fields[5] ?? "").trim();
    const m = /^(\d{4})(\d{2})(\d{2})\d*$/.exec(stamp);
    if (!m) continue;
    // `YYYY-MM-DD` is a layout the scanner's date rule reads; it says whether it is finer than year.
    if (hasDateFinerThanYear(`${m[1]}-${m[2]}-${m[3]}`)) return stamp;
  }
  return null;
}

const VHDR = ".vhdr";
const VMRK = ".vmrk";
const EEG = ".eeg";

/**
 * The first line of a marker file and of a header (Data Exchange, and the Core Data Exchange that
 * Analyzer exports); anything else (an AppleDouble `._` file, say) is not text this reader reads.
 */
const VMRK_MAGIC = /^brain ?vision (core )?data (exchange|format) marker file/i;
const VHDR_MAGIC = /^brain ?vision (core )?data (exchange|format) header file/i;

/**
 * Screen one file's text. `path` decides whether it is a header or a marker file; `whole` says
 * whether the text is the whole file.
 */
export function scanBrainVisionText(text: string, path: string, whole: boolean): ReaderResult {
  const isHeader = path.toLowerCase().endsWith(VHDR);
  const findings: Finding[] = [];
  const firstLine = text.slice(0, 200).trimStart();
  if (!(isHeader ? VHDR_MAGIC : VMRK_MAGIC).test(firstLine)) {
    // Not a BrainVision file (an AppleDouble `._` file, say): unscreened, never a gap in a read.
    return { findings, coverage: "not-applicable" };
  }
  const sections = parseIni(text);
  const common = sections.get("common infos");
  const { name } = splitPath(path);
  const base = stem(name, isHeader ? VHDR : VMRK);

  // The companions the file names should be the ones beside it, by their bare file names. When
  // they are not, the header was still read in full: a note, not a gap.
  let unmatched = false;
  const references: [string, string][] = isHeader
    ? [
        ["DataFile", `${base}${EEG}`],
        ["MarkerFile", `${base}${VMRK}`],
      ]
    : [["DataFile", `${base}${EEG}`]];
  let pathFlagged = false;
  for (const [field, expected] of references) {
    const value = entryValue(common, field);
    if (value === undefined || value === "") {
      // A header must name its data file; a missing MarkerFile is allowed by the format.
      if (isHeader && field === "DataFile") unmatched = true;
      continue;
    }
    const check = checkReference(value, base, expected);
    if (check !== "match") unmatched = true;
    if (pathFlagged) continue;
    const local = scanTextForLocalPaths(value);
    if (check === "absolute" || local.length > 0) {
      pathFlagged = true;
      findings.push({ kind: "local-user-path", severity: "review", field, shape: shapeOf(value) });
    }
  }

  if (isHeader) {
    const token = commentNameTokens(sections)[0];
    if (token !== undefined) {
      findings.push({
        kind: "brainvision-comment-name",
        severity: "review",
        field: "Comment",
        shape: shapeOf(token),
      });
    }
  } else {
    const markers = sections.get("marker infos");
    const text = markerText(markers);
    if (text.path !== null && !pathFlagged) {
      findings.push({
        kind: "local-user-path",
        severity: "review",
        field: "Marker",
        shape: shapeOf(text.path),
      });
    }
    if (text.contact !== null) {
      findings.push({
        kind: "brainvision-marker-text",
        severity: "review",
        field: "Marker",
        shape: shapeOf(text.contact),
      });
    }
    const stamp = segmentDate(markers);
    if (stamp !== null) {
      findings.push({
        kind: "brainvision-segment-date",
        severity: "review",
        field: "New Segment",
        shape: shapeOf(stamp),
      });
    }
  }

  const notes = unmatched ? { notes: ["companion-name-mismatch" as const] } : {};
  if (!whole) return { findings, coverage: "partial", incomplete: "limit", ...notes };
  return { findings, coverage: "complete", ...notes };
}

export const BRAINVISION_READER: FormatReader = {
  id: "brainvision",
  extensions: [VHDR, VMRK],
  limits: TEXT_HEADER_LIMITS,
  extensionLimits: { [VMRK]: MARKER_FILE_LIMITS },
  version: "1",
  companions(path, siblings) {
    const lower = path.toLowerCase();
    if (lower.endsWith(VHDR)) return pairByName(stem(path, VHDR), [EEG, VMRK], [], siblings);
    return pairByName(stem(path, VMRK), [VHDR], [], siblings);
  },
  async scan(src: RangeSource, path: string, limits) {
    const { bytes, whole } = await readHeader(src, limits.maxBytes);
    return scanBrainVisionText(decodeHeader(bytes), path, whole);
  },
};
