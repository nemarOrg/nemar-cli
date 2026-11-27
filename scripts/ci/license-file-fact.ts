#!/usr/bin/env bun
/**
 * LICENSE, identified (ADR 0142, section 1): ScanCode's output, read safely, turned into the closed
 * fact {@link LicenseFileFact} by the decision rule in the ADR's order.
 *
 * **Reading.** The workflow's sandboxed scan step writes `out/result.json` as uid 65534 inside a
 * scan directory the runner user prepared (`/tmp/license-scan` in the job):
 *
 *   matcher          `ok` when the install step installed and checked the pinned matcher
 *   oid              the blob id of the LICENSE that was extracted for the scan
 *   status           `ok` when the scan exited 0 (absent when it did not run or did not finish)
 *   in/LICENSE       the extracted text (the review reads its own copy from git, not this)
 *   out/result.json  ScanCode's JSON, owned by uid 65534
 *
 * {@link readScanOutput} opens each without following a link, and takes `result.json` only when it
 * is a regular file owned by the scan user, with mode no wider than 0644, at most 4 MiB, for the
 * LICENSE blob the review is about, from the pinned ScanCode release. Nothing in it is executed:
 * it is parsed as JSON and validated against the fields used here. Anything else is the matcher
 * word `unavailable`, never a pass and never a denial.
 *
 * **Deciding.** {@link identifyLicenseFile} applies the rule. This module is pure apart from the
 * reads in {@link readScanOutput}, and prints nothing: the review's log carries only the state and
 * the matcher word, never the SPDX identifier or the leftover text.
 *
 *   bun run scripts/ci/license-file-fact.ts --scan-dir DIR --license-field TEXT \
 *     [--license-file PATH --license-oid OID] [--result-owner-uid N]
 *
 * prints `{"license_file": {...}, "matcher": "..."}` for one scan (the runner proof in
 * nemarDatasets/.github runs it). Exit 0 when it printed a fact, 2 for bad arguments.
 */

import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import {
  LICENSE_MATCHER_VERSION,
  type LicenseFileFact,
  MIN_MATCH_COVERAGE,
  MIN_MATCH_SCORE,
  type MatcherWord,
  SCANCODE_TOOLKIT_VERSION,
  SPDX_LICENSE_LIST_VERSION,
} from "../../shared/license-file";
import { normalizeLicense } from "../../shared/license-lineage";
import { RECOMMENDED_LICENSES, generateLicenseText } from "../../shared/license-text";

/** The uid the sandboxed scan runs as (`nobody`), and so the owner its output must have. */
export const SCAN_UID = 65534;
/** The largest ScanCode output read; a larger one is not a scan of one LICENSE. */
export const SCAN_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
/** A control file (`matcher`, `status`, `oid`) is one short line. */
const CONTROL_MAX_BYTES = 128;

/** The files of the scan directory, relative to it. The workflow writes these names. */
export const SCAN_FILES = {
  matcher: "matcher",
  oid: "oid",
  status: "status",
  result: "out/result.json",
} as const;

// ---------------------------------------------------------------------------------------------
// ScanCode's output, the fields this module uses
// ---------------------------------------------------------------------------------------------

export interface ScanMatch {
  license_expression_spdx: string;
  start_line: number;
  end_line: number;
  score: number;
  matched_length: number;
  match_coverage: number;
  matched_text: string;
  matched_text_diagnostics: string;
}

export interface ScanCopyright {
  copyright: string;
  start_line: number;
  end_line: number;
}

/** The one scanned file's results. */
export interface ScanFile {
  detected_license_expression_spdx: string | null;
  /** Every match of every detection, in ScanCode's order. */
  matches: ScanMatch[];
  clues: ScanMatch[];
  copyrights: ScanCopyright[];
  scan_errors: number;
}

export type ScanOutput =
  /** The matcher was not installed as pinned, or a scan of a present LICENSE is not usable. */
  | { matcher: "unavailable"; scan: null }
  /** The matcher is installed; no LICENSE was scanned (none was expected). */
  | { matcher: typeof LICENSE_MATCHER_VERSION; scan: null }
  | { matcher: typeof LICENSE_MATCHER_VERSION; scan: ScanFile };

const UNAVAILABLE: ScanOutput = { matcher: "unavailable", scan: null };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const isLine = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;
const isNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function parseMatch(x: unknown): ScanMatch | null {
  if (!isRecord(x)) return null;
  const m = x;
  if (
    typeof m.license_expression_spdx !== "string" ||
    !isLine(m.start_line) ||
    !isLine(m.end_line) ||
    m.end_line < m.start_line ||
    !isNumber(m.score) ||
    !Number.isSafeInteger(m.matched_length) ||
    !isNumber(m.match_coverage) ||
    typeof m.matched_text !== "string" ||
    typeof m.matched_text_diagnostics !== "string"
  ) {
    return null;
  }
  return {
    license_expression_spdx: m.license_expression_spdx,
    start_line: m.start_line,
    end_line: m.end_line,
    score: m.score,
    matched_length: m.matched_length as number,
    match_coverage: m.match_coverage,
    matched_text: m.matched_text,
    matched_text_diagnostics: m.matched_text_diagnostics,
  };
}

function parseMatches(x: unknown): ScanMatch[] | null {
  if (!Array.isArray(x)) return null;
  const out: ScanMatch[] = [];
  for (const item of x) {
    const m = parseMatch(item);
    if (m === null) return null;
    out.push(m);
  }
  return out;
}

/**
 * The scanned file's results from ScanCode's JSON, or null when the document is not a scan of one
 * file by the pinned release (another tool version or SPDX list, a missing field, more than one
 * file).
 */
export function parseScanResult(json: unknown): ScanFile | null {
  if (!isRecord(json) || !Array.isArray(json.headers) || json.headers.length !== 1) return null;
  const header = json.headers[0];
  if (
    !isRecord(header) ||
    header.tool_name !== "scancode-toolkit" ||
    header.tool_version !== SCANCODE_TOOLKIT_VERSION ||
    !isRecord(header.extra_data) ||
    header.extra_data.spdx_license_list_version !== SPDX_LICENSE_LIST_VERSION
  ) {
    return null;
  }
  if (!Array.isArray(json.files)) return null;
  const files = json.files.filter((f) => isRecord(f) && f.type === "file");
  if (files.length !== 1) return null;
  const f = files[0] as Record<string, unknown>;
  const expr = f.detected_license_expression_spdx;
  if (expr !== null && typeof expr !== "string") return null;
  if (!Array.isArray(f.license_detections) || !Array.isArray(f.scan_errors)) return null;
  const matches: ScanMatch[] = [];
  for (const d of f.license_detections) {
    if (!isRecord(d)) return null;
    const ms = parseMatches(d.matches);
    if (ms === null) return null;
    matches.push(...ms);
  }
  const clues = parseMatches(f.license_clues);
  if (clues === null || !Array.isArray(f.copyrights)) return null;
  const copyrights: ScanCopyright[] = [];
  for (const c of f.copyrights) {
    if (
      !isRecord(c) ||
      typeof c.copyright !== "string" ||
      !isLine(c.start_line) ||
      !isLine(c.end_line)
    ) {
      return null;
    }
    copyrights.push({ copyright: c.copyright, start_line: c.start_line, end_line: c.end_line });
  }
  return {
    detected_license_expression_spdx: expr,
    matches,
    clues,
    copyrights,
    scan_errors: f.scan_errors.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the scan directory
// ---------------------------------------------------------------------------------------------

interface FileRule {
  ownerUid: number;
  maxBytes: number;
  /** The mode bits the file may have; any other bit refuses it. */
  allowedMode: number;
}

/**
 * One file's bytes, or null. Never follows a link: the path is lstat'ed and then opened with
 * O_NOFOLLOW, and the open file is checked again (a regular file, its owner, its mode, its size),
 * so a file swapped between the two is judged by what was opened.
 */
function readGuarded(path: string, rule: FileRule): Buffer | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.uid !== rule.ownerUid) return null;
    if ((st.mode & 0o7777 & ~rule.allowedMode) !== 0) return null;
    if (st.size > rule.maxBytes) return null;
    const buf = Buffer.alloc(rule.maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n > rule.maxBytes) return null;
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export interface ReadScanOptions {
  /** The owner `result.json` must have. The job's is {@link SCAN_UID}; a test passes its own. */
  resultOwnerUid?: number;
  /** The owner of the control files: the runner user, which is this process's user. */
  controlOwnerUid?: number;
}

/**
 * The scan directory's verdict for one review. `licenseOid` is the blob id of a LICENSE that is
 * text in git and was read in full, or null when there is none to scan (absent, annexed, too
 * large, not UTF-8): then only the install's word is read.
 */
export function readScanOutput(
  dir: string,
  licenseOid: string | null,
  options: ReadScanOptions = {},
): ScanOutput {
  const controlOwner = options.controlOwnerUid ?? process.getuid?.() ?? -1;
  const control: FileRule = {
    ownerUid: controlOwner,
    maxBytes: CONTROL_MAX_BYTES,
    allowedMode: 0o644,
  };
  const word = (name: string): string | null =>
    readGuarded(join(dir, name), control)?.toString("utf8").trim() ?? null;

  if (word(SCAN_FILES.matcher) !== "ok") return UNAVAILABLE;
  if (licenseOid === null) return { matcher: LICENSE_MATCHER_VERSION, scan: null };
  if (!/^[0-9a-f]{40,64}$/.test(licenseOid)) return UNAVAILABLE;
  if (word(SCAN_FILES.oid) !== licenseOid) return UNAVAILABLE;
  if (word(SCAN_FILES.status) !== "ok") return UNAVAILABLE;
  const bytes = readGuarded(join(dir, SCAN_FILES.result), {
    ownerUid: options.resultOwnerUid ?? SCAN_UID,
    maxBytes: SCAN_OUTPUT_MAX_BYTES,
    allowedMode: 0o644,
  });
  if (bytes === null) return UNAVAILABLE;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return UNAVAILABLE;
  }
  const scan = parseScanResult(json);
  return scan === null ? UNAVAILABLE : { matcher: LICENSE_MATCHER_VERSION, scan };
}

// ---------------------------------------------------------------------------------------------
// The License field against an SPDX identifier
// ---------------------------------------------------------------------------------------------

/** The licenses a field can name that a file can be compared with. */
const COMPARABLE = new Set([
  "cc0",
  "pddl",
  "cc-by",
  "permissive-attribution",
  "odc-by",
  "cc-by-sa",
  "odbl",
  "cc-by-nc",
  "cc-by-nc-sa",
  "cc-by-nd",
  "cc-by-nc-nd",
]);

const CC_SUFFIX: Record<string, string> = {
  "cc-by": "",
  "cc-by-sa": "-SA",
  "cc-by-nc": "-NC",
  "cc-by-nc-sa": "-NC-SA",
  "cc-by-nd": "-ND",
  "cc-by-nc-nd": "-NC-ND",
};

/** The software license a `permissive-attribution` field names, as its SPDX identifier. */
function permissiveSpdx(field: string): string | null {
  const t = field.trim().toLowerCase();
  if (/\bmit\b|expat/.test(t)) return "MIT";
  if (/bsd[- ]?2/.test(t)) return "BSD-2-Clause";
  if (/bsd[- ]?3/.test(t)) return "BSD-3-Clause";
  if (/apache/.test(t)) return "Apache-2.0";
  return null;
}

/**
 * Whether a `License` field and a file's SPDX identifier name the same license.
 * - `incomparable`: the field does not normalize (absent, free text, restricted, unknown).
 * - `match`: the same SPDX identifier, or a field with no version (`CC-BY`) and a file of its
 *   family. MIT, BSD and Apache are compared by identifier only, never by family.
 * - `differ`: anything else.
 */
export function compareLicenseField(
  field: string | null,
  spdx: string,
): "match" | "differ" | "incomparable" {
  if (field === null) return "incomparable";
  const f = normalizeLicense(field);
  if (!COMPARABLE.has(f.license)) return "incomparable";
  if (field.trim().toLowerCase() === spdx.toLowerCase()) return "match";
  if (f.license === "permissive-attribution") {
    return permissiveSpdx(field) === spdx ? "match" : "differ";
  }
  const p = normalizeLicense(spdx);
  if (p.license !== f.license) return "differ";
  if (f.version === null) return "match";
  let canonical: string;
  switch (f.license) {
    case "cc0":
      canonical = `CC0-${f.version}`;
      break;
    case "pddl":
      canonical = `PDDL-${f.version}`;
      break;
    case "odc-by":
      canonical = `ODC-By-${f.version}`;
      break;
    case "odbl":
      canonical = `ODbL-${f.version}`;
      break;
    default:
      canonical = `CC-BY${CC_SUFFIX[f.license]}-${f.version}`;
  }
  return canonical === spdx ? "match" : "differ";
}

// ---------------------------------------------------------------------------------------------
// The decision rule
// ---------------------------------------------------------------------------------------------

/** The LICENSE as the review read it from git. */
export interface LicenseDocument {
  state: "present" | "absent" | "annexed" | "unreadable" | "not_utf8";
  text: string | null;
}

export interface LicenseIdentification {
  fact: LicenseFileFact;
  matcher: MatcherWord;
  /**
   * The text beyond the license, in file order: bracketed tokens, other matches and clues, and
   * uncovered lines. Empty unless `fact.additions`. Untrusted depositor text: never logged.
   */
  leftover: string[];
}

const SCANCODE_REF = /^LicenseRef-scancode-/;
const UNKNOWN_REFERENCE = "LicenseRef-scancode-unknown-license-reference";
/** One identifier on the SPDX license list: no `LicenseRef-`, no operator, no space. */
const SPDX_ID = /^(?!LicenseRef-)[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const OPERATORS = new Set(["AND", "OR", "WITH"]);

function fact(
  state: LicenseFileFact["state"],
  spdx: string | null = null,
  expression: string | null = null,
): LicenseFileFact {
  return { state, spdx, additions: false, expression };
}

/**
 * Whether ScanCode's file expression joins `p` with another license. `p` joined by `AND` only to
 * `LicenseRef-scancode-*` terms is not: those are additions (the measured rider gives
 * `CC-BY-4.0 AND LicenseRef-scancode-proprietary-license`). An expression that does not name `p`
 * at all is compound too.
 */
export function isCompound(expression: string | null, p: string): boolean {
  if (expression === null) return false;
  const tokens = expression.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  const ops = tokens.filter((t) => OPERATORS.has(t.toUpperCase()));
  const ids = tokens.filter((t) => !OPERATORS.has(t.toUpperCase()));
  if (!ids.includes(p)) return true;
  const others = ids.filter((t) => t !== p);
  if (others.length === 0) return false;
  return !(
    others.every((t) => SCANCODE_REF.test(t)) && ops.every((o) => o.toUpperCase() === "AND")
  );
}

/** The lines of a text as ScanCode numbers them, 1-based (index 0 is line 1). */
function linesOf(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

const ONLY_PUNCTUATION = /^[\s\p{P}\p{S}]*$/u;
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The text beyond `p`'s matches, in file order (ADR 0142, "Additions"):
 * - each bracketed (unmatched) token in a `p` match's diagnostics;
 * - the matched text of a match of any other license, except an unknown-license-reference match
 *   whose lines a `p` match also covers (the "licensed under the" of a notice);
 * - the matched text of each license clue;
 * - each line no match covers, unless it is blank, only punctuation, or nothing but a copyright
 *   statement ScanCode reported.
 */
export function leftoverOf(scan: ScanFile, p: string, text: string): string[] {
  const lines = linesOf(text);
  const out: { line: number; text: string }[] = [];
  const own = scan.matches.filter((m) => m.license_expression_spdx === p);
  const ownCovers = (line: number) => own.some((m) => m.start_line <= line && line <= m.end_line);

  for (const m of own) {
    for (const hit of m.matched_text_diagnostics.matchAll(/\[([^\]\n]*)\]/g)) {
      out.push({ line: m.start_line, text: hit[1] ?? "" });
    }
  }
  for (const m of scan.matches) {
    if (m.license_expression_spdx === p) continue;
    if (m.license_expression_spdx === UNKNOWN_REFERENCE) {
      let covered = true;
      for (let l = m.start_line; l <= m.end_line; l++) if (!ownCovers(l)) covered = false;
      if (covered) continue;
    }
    out.push({ line: m.start_line, text: m.matched_text });
  }
  for (const c of scan.clues) out.push({ line: c.start_line, text: c.matched_text });

  const covered = new Set<number>();
  for (const m of [...scan.matches, ...scan.clues]) {
    for (let l = m.start_line; l <= m.end_line; l++) covered.add(l);
  }
  // A copyright statement's lines are exempt when, with the statement taken out, nothing but
  // punctuation is left on them. ScanCode may normalize the statement (`(c)` for `©`); then it is
  // not found in the line and the line is leftover, which is the safe direction.
  const exempt = new Set<number>();
  for (const c of scan.copyrights) {
    const span = collapse(lines.slice(c.start_line - 1, c.end_line).join(" "));
    const statement = collapse(c.copyright);
    if (statement.length > 0 && span.includes(statement)) {
      if (ONLY_PUNCTUATION.test(span.replace(statement, ""))) {
        for (let l = c.start_line; l <= c.end_line; l++) exempt.add(l);
      }
    }
  }
  lines.forEach((line, i) => {
    const n = i + 1;
    if (covered.has(n) || exempt.has(n) || ONLY_PUNCTUATION.test(line)) return;
    out.push({ line: n, text: line });
  });
  return out.sort((a, b) => a.line - b.line).map((o) => o.text);
}

/** The longest match by `matched_length`; the first of equals, in ScanCode's order. */
function longestMatch(matches: ScanMatch[]): ScanMatch | null {
  let best: ScanMatch | null = null;
  for (const m of matches) if (best === null || m.matched_length > best.matched_length) best = m;
  return best;
}

/** NEMAR's own generated notice for the field's license, byte for byte, line endings normalized. */
function nemarNoticeOf(text: string, field: string | null): string | null {
  const normalized = text.replace(/\r\n|\r/g, "\n");
  for (const info of RECOMMENDED_LICENSES) {
    if (
      compareLicenseField(field, info.spdxId) === "match" &&
      normalized === generateLicenseText(info.spdxId)
    ) {
      return info.spdxId;
    }
  }
  return null;
}

export interface IdentifyInputs {
  /** The root LICENSE as read from git. */
  document: LicenseDocument;
  /** `dataset_description.json`'s `License`, or null when it has none. */
  licenseField: string | null;
  /** The scan directory's verdict, or null when the job passed no scan directory. */
  scan: ScanOutput | null;
}

/** ADR 0142 section 1's rule, in order. */
export function identifyLicenseFile(inputs: IdentifyInputs): LicenseIdentification {
  const done = (f: LicenseFileFact, matcher: MatcherWord, leftover: string[] = []) => ({
    fact: f,
    matcher,
    leftover,
  });
  const { document, licenseField, scan } = inputs;
  // No scan directory: the workflow predates the matcher (ADR 0142 decision 2, deploys 1 and 2).
  if (scan === null) return done(fact("unreadable"), "unavailable");
  const matcher = scan.matcher;
  if (document.state === "absent") return done(fact("absent"), matcher);
  if (document.state === "annexed") return done(fact("annexed"), matcher);
  if (document.state !== "present" || document.text === null) {
    return done(fact("unreadable"), matcher);
  }
  if (scan.scan === null) return done(fact("unreadable"), "unavailable");
  const result = scan.scan;
  if (result.scan_errors > 0) return done(fact("unreadable"), matcher);
  const text = document.text;

  const notice = nemarNoticeOf(text, licenseField);
  if (notice !== null) return done(fact("matches", notice), matcher);

  const longest = longestMatch(result.matches);
  if (longest === null) return done(fact("unrecognized"), matcher);
  const p = longest.license_expression_spdx;
  if (!SPDX_ID.test(p)) {
    // A longest match that is itself an expression (`MIT OR Apache-2.0` from one identifier line)
    // is a compound result, recorded as ScanCode's words; a `LicenseRef-` term is not one.
    const compound = p.split(/[\s()]+/).some((t) => OPERATORS.has(t.toUpperCase()));
    const expression = compound ? (result.detected_license_expression_spdx ?? p) : null;
    return done(fact("unrecognized", null, expression), matcher);
  }
  if (longest.score < MIN_MATCH_SCORE || longest.match_coverage < MIN_MATCH_COVERAGE) {
    return done(fact("unrecognized"), matcher);
  }
  const expression = result.detected_license_expression_spdx;
  if (isCompound(expression, p)) return done(fact("unrecognized", p, expression), matcher);
  const compared = compareLicenseField(licenseField, p);
  if (compared === "incomparable") return done(fact("unrecognized", p), matcher);
  const leftover = leftoverOf(result, p, text);
  return done(
    {
      state: compared === "match" ? "matches" : "matches_other",
      spdx: p,
      additions: leftover.length > 0,
      expression: null,
    },
    matcher,
    leftover,
  );
}

/** The `License` field of a `dataset_description.json` text, or null. */
export function licenseFieldOf(descriptionText: string | null): string | null {
  if (descriptionText === null) return null;
  try {
    const parsed: unknown = JSON.parse(descriptionText);
    return isRecord(parsed) && typeof parsed.License === "string" && parsed.License.trim()
      ? parsed.License
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Read a LICENSE file from disk the way the review reads it from git. */
function documentFromFile(path: string | undefined): LicenseDocument {
  if (path === undefined) return { state: "absent", text: null };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { state: "absent", text: null };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? { state: "not_utf8", text: null } : { state: "present", text };
  } catch {
    return { state: "not_utf8", text: null };
  }
}

export function main(argv: string[]): number {
  const scanDir = flag(argv, "scan-dir");
  const field = flag(argv, "license-field");
  const file = flag(argv, "license-file");
  const oid = flag(argv, "license-oid");
  const owner = flag(argv, "result-owner-uid");
  if (
    scanDir === undefined ||
    field === undefined ||
    (file !== undefined) !== (oid !== undefined)
  ) {
    console.error(
      "usage: license-file-fact.ts --scan-dir DIR --license-field TEXT [--license-file PATH --license-oid OID] [--result-owner-uid N]",
    );
    return 2;
  }
  if (owner !== undefined && !/^\d{1,10}$/.test(owner)) {
    console.error("bad --result-owner-uid");
    return 2;
  }
  const document = documentFromFile(file);
  const scan = readScanOutput(scanDir, document.state === "present" ? (oid ?? null) : null, {
    resultOwnerUid: owner === undefined ? undefined : Number(owner),
  });
  const id = identifyLicenseFile({ document, licenseField: field === "" ? null : field, scan });
  console.log(JSON.stringify({ license_file: id.fact, matcher: id.matcher }));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
