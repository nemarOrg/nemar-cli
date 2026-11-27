/**
 * LICENSE's identification (ADR 0142, section 1), over real ScanCode output.
 *
 * Every fixture under test/fixtures/license-scan/<case>/ is a public license text (LICENSE), the
 * `License` field and expected fact it was scanned for (case.json), and the result.json that the
 * workflow's own sandboxed scan step wrote on a GitHub-hosted runner (the run is named in that
 * directory's README). Nothing here is hand-written ScanCode output: the boundary cases below
 * change one field of a real result, or one line of a real text, and say which.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LicenseDocument,
  SCAN_FILES,
  SCAN_OUTPUT_MAX_BYTES,
  type ScanFile,
  type ScanOutput,
  compareLicenseField,
  identifyLicenseFile,
  isCompound,
  licenseFieldOf,
  main,
  parseScanResult,
  readScanOutput,
} from "../scripts/ci/license-file-fact";
import {
  LICENSE_FILE_STATES,
  LICENSE_MATCHER_VERSION,
  type LicenseFileFact,
  MIN_MATCH_COVERAGE,
  MIN_MATCH_SCORE,
} from "../shared/license-file";
import { RECOMMENDED_LICENSES, generateLicenseText } from "../shared/license-text";

const FIXTURES = join(import.meta.dir, "fixtures", "license-scan");
const UID = process.getuid?.() ?? 0;

interface Case {
  name: string;
  text: string;
  field: string;
  expected: LicenseFileFact;
  json: unknown;
}

const CASES: Case[] = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = join(FIXTURES, d.name);
    const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as {
      field: string;
      expected: LicenseFileFact;
    };
    return {
      name: d.name,
      text: readFileSync(join(dir, "LICENSE"), "utf8"),
      field: c.field,
      expected: c.expected,
      json: JSON.parse(readFileSync(join(dir, "result.json"), "utf8")),
    };
  });

function caseOf(name: string): Case {
  const c = CASES.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no fixture ${name}`);
  return c;
}

function scanOf(c: Case | unknown): ScanFile {
  const json = typeof c === "object" && c !== null && "json" in c ? (c as Case).json : c;
  const scan = parseScanResult(json);
  if (scan === null) throw new Error("fixture does not parse");
  return scan;
}

const present = (text: string): LicenseDocument => ({ state: "present", text });
const ran = (scan: ScanFile): ScanOutput => ({ matcher: LICENSE_MATCHER_VERSION, scan });

function identify(text: string, field: string | null, scan: ScanFile) {
  return identifyLicenseFile({ document: present(text), licenseField: field, scan: ran(scan) });
}

/** A deep copy of a real result, to change one field of it. */
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("every runner fixture is identified as the case expects", () => {
  test("the fixtures are there, so an empty loop cannot pass", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(19);
  });

  test.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const id = identify(c.text, c.field, scanOf(c));
    expect(id.fact).toEqual(c.expected);
    expect(id.matcher).toBe(LICENSE_MATCHER_VERSION);
    expect(LICENSE_FILE_STATES).toContain(id.fact.state);
    // Leftover exists exactly when additions are set.
    // Additions are leftover text, or a longest match that covers less than its whole license.
    expect(id.leftover.length > 0 || id.partial).toBe(id.fact.additions);
  });

  test("each fixture's result is the pinned release's, on Linux", () => {
    for (const c of CASES) {
      const header = (c.json as { headers: Record<string, unknown>[] }).headers[0];
      expect(header?.tool_version, c.name).toBe("32.5.0");
      const env = (header?.extra_data as Record<string, Record<string, string>>).system_environment;
      expect(env?.operating_system, c.name).toBe("linux");
      expect(env?.python_version?.startsWith("3.12.16"), c.name).toBe(true);
    }
  });
});

describe("the leftover is the text beyond the license", () => {
  test("a rider inside the text: its words, bracketed, and the line ScanCode matched", () => {
    const id = identify(caseOf("rider-middle").text, "CC-BY-4.0", scanOf(caseOf("rider-middle")));
    expect(id.leftover.join(" ")).toContain("non-commercial purposes only");
  });

  test("a rider at the end: the line", () => {
    const id = identify(caseOf("rider-end").text, "CC-BY-4.0", scanOf(caseOf("rider-end")));
    expect(id.leftover.join(" ")).toContain("non-commercial purposes only");
  });

  test("one inserted word: exactly that word", () => {
    const c = caseOf("one-word-insertion");
    expect(identify(c.text, "CC-BY-4.0", scanOf(c)).leftover).toEqual(["NOT"]);
  });

  test("a copyright line alone is not leftover; with other text on it, it is", () => {
    const c = caseOf("copyright-header");
    const scan = scanOf(c);
    expect(scan.copyrights.length).toBeGreaterThan(0);
    expect(identify(c.text, "CC-BY-4.0", scan).fact.additions).toBe(false);
    const line = c.text.split("\n")[0] ?? "";
    expect(line).toContain("Copyright 2024 Example Lab");
    // One line changed: the same statement, and words after it.
    const text = c.text.replace(line, `${line}, for non-commercial use only`);
    const id = identify(text, "CC-BY-4.0", scan);
    expect(id.fact).toMatchObject({ state: "matches", additions: true });
    expect(id.leftover).toEqual([`${line}, for non-commercial use only`]);
  });

  test("an uncovered line of only punctuation is not leftover", () => {
    const c = caseOf("cc-by-4.0");
    const scan = scanOf(c);
    const end = Math.max(...scan.matches.map((m) => m.end_line));
    const lines = c.text.split("\n");
    lines.splice(end, 0, "  ---  ", "");
    expect(identify(lines.join("\n"), "CC-BY-4.0", scan).fact.additions).toBe(false);
    lines.splice(end, 1, "  --- see also our terms ---  ");
    expect(identify(lines.join("\n"), "CC-BY-4.0", scan).fact.additions).toBe(true);
  });

  test("the notice's unknown-reference match is exempt only on lines a match of P covers", () => {
    const c = caseOf("nemar-notice-cc-by-4.0");
    const REF = "LicenseRef-scancode-unknown-license-reference";
    // Every match made full, and the text one byte off NEMAR's notice, so the rule itself runs.
    const full = copy(scanOf(c));
    for (const m of full.matches) {
      m.score = 100;
      m.match_coverage = 100;
    }
    const ref = full.matches.find((m) => m.license_expression_spdx === REF);
    if (ref === undefined) throw new Error("the notice's scan has no unknown-reference match");
    const text = c.text.replace("See the URL", "Read the URL");
    const covered = identify(text, "CC-BY-4.0", full);
    expect(covered.fact.state).toBe("matches");
    expect(covered.leftover).not.toContain(ref.matched_text);
    // The same match moved to the uncovered last line is an addition, with its own text.
    const moved = copy(full);
    const last = text.split("\n").length - 1;
    for (const m of moved.matches) {
      if (m.license_expression_spdx === REF) {
        m.start_line = last;
        m.end_line = last;
      }
    }
    expect(identify(text, "CC-BY-4.0", moved).leftover).toContain(ref.matched_text);
  });
});

describe("text on a matched line outside the match's span is leftover", () => {
  test("words after a notice on its own line", () => {
    const c = caseOf("short-notice-rider");
    const id = identify(c.text, "CC-BY-4.0", scanOf(c));
    expect(id.fact).toMatchObject({ state: "matches", additions: true });
    expect(id.leftover.join(" ")).toContain(
      "except that the authors must approve every derived publication",
    );
  });

  test("a restriction appended to the last line of the full text", () => {
    const c = caseOf("last-line-rider");
    const id = identify(c.text, "CC-BY-4.0", scanOf(c));
    expect(id.fact).toMatchObject({ state: "matches", additions: true });
    expect(id.leftover.join(" ")).toContain("Commercial use of this dataset is not permitted.");
  });

  test("the words before a notice's span are leftover too", () => {
    const c = caseOf("short-notice");
    expect(identify(c.text, "CC-BY-4.0", scanOf(c)).leftover).toEqual(["This dataset is"]);
  });

  test("a full text whose span is its whole lines has none", () => {
    for (const name of [
      "cc-by-4.0",
      "cc-by-sa-4.0",
      "cc-by-nc-4.0",
      "cc-by-nc-sa-4.0",
      "cc0-1.0",
    ]) {
      const c = caseOf(name);
      expect(identify(c.text, c.field, scanOf(c)).leftover, name).toEqual([]);
    }
  });

  test("a span edge that cannot be found in its line makes the whole line leftover", () => {
    const c = caseOf("short-notice");
    const scan = copy(scanOf(c));
    for (const m of scan.matches) m.matched_text_diagnostics = "nowhere in the line";
    expect(identify(c.text, "CC-BY-4.0", scan).leftover).toEqual([c.text.split("\n")[0]]);
  });
});

describe("a deleted clause sets additions", () => {
  test("one clause deleted: the longest match covers less than 100, so additions", () => {
    const c = caseOf("clause-deleted");
    const scan = scanOf(c);
    const longest = [...scan.matches].sort((a, b) => b.matched_length - a.matched_length)[0];
    expect(longest?.match_coverage).toBeLessThan(100);
    expect(longest?.match_coverage).toBeGreaterThanOrEqual(MIN_MATCH_COVERAGE);
    const id = identify(c.text, "CC-BY-4.0", scan);
    expect(id.fact).toMatchObject({ state: "matches", additions: true });
    expect(id.partial).toBe(true);
  });

  test("a whole section deleted falls below the threshold: unrecognized", () => {
    const c = caseOf("section-deleted");
    expect(identify(c.text, "CC-BY-4.0", scanOf(c)).fact.state).toBe("unrecognized");
  });

  test("coverage 100 is not partial", () => {
    const c = caseOf("cc-by-4.0");
    expect(identify(c.text, c.field, scanOf(c)).partial).toBe(false);
  });
});

describe("a line ScanCode names that is not in the text is a scan of something else", () => {
  const c = caseOf("cc-by-4.0");
  const count = c.text.split("\n").length;
  test.each([
    [
      "an end line of 2^53",
      (s: ScanFile) => ((s.matches[0] as { end_line: number }).end_line = 2 ** 53),
    ],
    [
      "an end line one past the text",
      (s: ScanFile) => ((s.matches[0] as { end_line: number }).end_line = count + 1),
    ],
    [
      "a start line of 0",
      (s: ScanFile) => ((s.matches[0] as { start_line: number }).start_line = 0),
    ],
    [
      "a start after its end",
      (s: ScanFile) => {
        const m = s.matches[0] as { start_line: number; end_line: number };
        m.start_line = m.end_line + 1;
      },
    ],
    [
      "a copyright past the text",
      (s: ScanFile) =>
        s.copyrights.push({ copyright: "Copyright x", start_line: count + 5, end_line: count + 5 }),
    ],
  ] as const)("%s: unreadable, matcher unavailable, no loop", (_label, change) => {
    const scan = copy(scanOf(c));
    change(scan);
    const started = performance.now();
    const id = identify(c.text, c.field, scan);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(id.fact.state).toBe("unreadable");
    expect(id.matcher).toBe("unavailable");
  });

  test("the text's own last line is accepted", () => {
    const scan = copy(scanOf(c));
    (scan.matches[0] as { end_line: number }).end_line = count;
    expect(identify(c.text, c.field, scan).matcher).toBe(LICENSE_MATCHER_VERSION);
  });
});

describe("the boundaries of the rule, each on a real result", () => {
  const c = caseOf("cc-by-4.0");
  const longestIndex = (s: ScanFile) =>
    s.matches.reduce(
      (best, m, i, all) => (m.matched_length > (all[best]?.matched_length ?? -1) ? i : best),
      0,
    );

  test(`score ${MIN_MATCH_SCORE} is conclusive and 94.9 is not`, () => {
    const at = copy(scanOf(c));
    (at.matches[longestIndex(at)] as { score: number }).score = MIN_MATCH_SCORE;
    expect(identify(c.text, c.field, at).fact.state).toBe("matches");
    const below = copy(scanOf(c));
    (below.matches[longestIndex(below)] as { score: number }).score = 94.9;
    expect(identify(c.text, c.field, below).fact).toEqual({
      state: "unrecognized",
      spdx: null,
      additions: false,
      expression: null,
    });
  });

  test(`coverage ${MIN_MATCH_COVERAGE} is conclusive and 94.9 is not`, () => {
    const at = copy(scanOf(c));
    (at.matches[longestIndex(at)] as { match_coverage: number }).match_coverage =
      MIN_MATCH_COVERAGE;
    expect(identify(c.text, c.field, at).fact.state).toBe("matches");
    const below = copy(scanOf(c));
    (below.matches[longestIndex(below)] as { match_coverage: number }).match_coverage = 94.9;
    expect(identify(c.text, c.field, below).fact.state).toBe("unrecognized");
  });

  test("the longest match decides, not the first: a short full match never makes it conclusive", () => {
    const n = caseOf("nemar-notice-cc-by-4.0");
    const scan = copy(scanOf(n));
    // Put the short 100/100 sentence match first; the longest (the title and URL) stays weak.
    scan.matches.reverse();
    expect(scan.matches[0]?.score).toBe(100);
    const notExact = n.text.replace("See the URL", "Read the URL");
    expect(identify(notExact, "CC-BY-4.0", scan).fact.state).toBe("unrecognized");
  });

  test("the truncated text's longest match is not CC-BY-4.0, whatever its shorter matches say", () => {
    const t = caseOf("truncated-200-lines");
    const scan = scanOf(t);
    expect(scan.matches.some((m) => m.license_expression_spdx === "CC-BY-4.0")).toBe(true);
    expect(identify(t.text, "CC-BY-4.0", scan).fact.state).toBe("unrecognized");
  });

  test("a rider's LicenseRef is an addition, not a compound expression", () => {
    const r = caseOf("rider-middle");
    expect(scanOf(r).detected_license_expression_spdx).toBe(
      "CC-BY-4.0 AND LicenseRef-scancode-proprietary-license",
    );
    expect(isCompound("CC-BY-4.0 AND LicenseRef-scancode-proprietary-license", "CC-BY-4.0")).toBe(
      false,
    );
    expect(isCompound("CC-BY-4.0 OR LicenseRef-scancode-proprietary-license", "CC-BY-4.0")).toBe(
      true,
    );
    expect(isCompound("CC-BY-4.0 AND CC0-1.0", "CC-BY-4.0")).toBe(true);
    expect(isCompound("CC-BY-4.0 WITH Some-exception", "CC-BY-4.0")).toBe(true);
    expect(isCompound("MIT", "CC-BY-4.0")).toBe(true);
    expect(isCompound(null, "CC-BY-4.0")).toBe(false);
  });

  test("a scan error is unreadable, never a pass", () => {
    const scan = { ...scanOf(c), scan_errors: 1 };
    expect(identify(c.text, c.field, scan).fact.state).toBe("unreadable");
  });

  test("no match at all is unrecognized", () => {
    const p = caseOf("prose");
    expect(scanOf(p).matches.length).toBe(0);
    expect(identify(p.text, "CC-BY-4.0", scanOf(p)).fact.state).toBe("unrecognized");
  });
});

describe("NEMAR's own notice", () => {
  const n = caseOf("nemar-notice-cc-by-4.0");

  test("the fixture is byte for byte generateLicenseText", () => {
    expect(n.text).toBe(generateLicenseText("CC-BY-4.0"));
    expect(caseOf("nemar-notice-cc0-1.0").text).toBe(generateLicenseText("CC0-1.0"));
  });

  test("with CRLF line endings it is still the notice", () => {
    const id = identify(n.text.replaceAll("\n", "\r\n"), "CC-BY-4.0", scanOf(n));
    expect(id.fact).toEqual({
      state: "matches",
      spdx: "CC-BY-4.0",
      additions: false,
      expression: null,
    });
  });

  test("one byte changed, it is judged by the rule, and its weak longest match is unrecognized", () => {
    const id = identify(n.text.replace("full license", "full licence"), "CC-BY-4.0", scanOf(n));
    expect(id.fact.state).toBe("unrecognized");
  });

  test("the notice of another license than the field's is not the exception", () => {
    const id = identify(n.text, "CC-BY-SA-4.0", scanOf(n));
    expect(id.fact.state).not.toBe("matches");
  });

  test("only the recommended licenses' notices count, not the generic fallback", () => {
    expect(RECOMMENDED_LICENSES.some((l) => l.spdxId === "MIT")).toBe(false);
    // The fallback text, scanned as the CC-BY notice was: no exception for it.
    const id = identify(generateLicenseText("MIT"), "MIT", scanOf(n));
    expect(id.fact.state).not.toBe("matches");
  });
});

describe("the License field against the file's identifier", () => {
  test.each([
    ["CC-BY-4.0", "CC-BY-4.0", "match"],
    // Only the identifier itself, case aside, or a field that names no version.
    ["cc-by-4.0", "CC-BY-4.0", "match"],
    [" CC-BY-4.0 ", "CC-BY-4.0", "match"],
    ["CC BY 4.0", "CC-BY-4.0", "differ"],
    ["https://creativecommons.org/licenses/by/4.0/", "CC-BY-4.0", "differ"],
    // The review's own examples of a field that is not the file's license.
    ["BSD-3-Clause-Clear", "BSD-3-Clause", "differ"],
    ["BSD-2-Clause-Patent", "BSD-2-Clause", "differ"],
    ["CC-BY-4.0 AND MIT", "CC-BY-4.0", "incomparable"],
    ["CC-BY-4.0 OR MIT", "MIT", "incomparable"],
    ["CC-BY-4.0, no commercial use", "CC-BY-4.0", "differ"],
    ["CC-BY-4.0-NC", "CC-BY-4.0", "differ"],
    ["MIT", "BSD-2-Clause", "differ"],
    ["CC-BY", "CC-BY-4.0", "match"],
    ["CC-BY", "CC-BY-SA-4.0", "differ"],
    ["CC-BY-4.0", "CC-BY-3.0", "differ"],
    ["CC-BY-4.0", "CC-BY-NC-4.0", "differ"],
    ["CC0", "CC0-1.0", "match"],
    ["PD", "CC0-1.0", "match"],
    ["ODC-By-1.0", "ODC-By-1.0", "match"],
    ["ODbL", "ODbL-1.0", "match"],
    ["MIT", "MIT", "match"],
    ["MIT", "BSD-3-Clause", "differ"],
    ["BSD-3-Clause", "MIT", "differ"],
    ["BSD-2-Clause", "BSD-3-Clause", "differ"],
    ["Apache-2.0", "MIT", "differ"],
    ["See the LICENSE file", "CC-BY-4.0", "incomparable"],
    ["All rights reserved", "CC-BY-4.0", "incomparable"],
  ] as const)("%s against %s: %s", (field, spdx, want) => {
    expect(compareLicenseField(field, spdx)).toBe(want);
  });

  test("no field cannot be compared", () => {
    expect(compareLicenseField(null, "CC-BY-4.0")).toBe("incomparable");
  });

  test("the field is read from dataset_description.json, and nothing else is", () => {
    expect(licenseFieldOf(JSON.stringify({ License: "CC0" }))).toBe("CC0");
    expect(licenseFieldOf(JSON.stringify({ License: "  " }))).toBeNull();
    expect(licenseFieldOf(JSON.stringify({ License: 4 }))).toBeNull();
    expect(licenseFieldOf("not json")).toBeNull();
    expect(licenseFieldOf(null)).toBeNull();
  });
});

describe("the states that come before the scan", () => {
  const c = caseOf("cc-by-4.0");
  const scan = ran(scanOf(c));

  test("no scan directory: unreadable, matcher unavailable", () => {
    expect(
      identifyLicenseFile({ document: present(c.text), licenseField: c.field, scan: null }),
    ).toEqual({
      fact: { state: "unreadable", spdx: null, additions: false, expression: null },
      matcher: "unavailable",
      leftover: [],
      partial: false,
    });
  });

  test.each([
    ["absent", "absent"],
    ["annexed", "annexed"],
    ["unreadable", "unreadable"],
    ["not_utf8", "unreadable"],
  ] as const)("a LICENSE that is %s is %s, with the matcher's word", (docState, want) => {
    const id = identifyLicenseFile({
      document: { state: docState, text: null },
      licenseField: c.field,
      scan: { matcher: LICENSE_MATCHER_VERSION, scan: null },
    });
    expect(id.fact).toEqual({ state: want, spdx: null, additions: false, expression: null });
    expect(id.matcher).toBe(LICENSE_MATCHER_VERSION);
  });

  test("a present LICENSE with no usable scan: unreadable, matcher unavailable", () => {
    const id = identifyLicenseFile({
      document: present(c.text),
      licenseField: c.field,
      scan: { matcher: "unavailable", scan: null },
    });
    expect(id).toMatchObject({ fact: { state: "unreadable" }, matcher: "unavailable" });
    expect(
      identifyLicenseFile({
        document: present(c.text),
        licenseField: c.field,
        scan: { matcher: LICENSE_MATCHER_VERSION, scan: null },
      }).matcher,
    ).toBe("unavailable");
    expect(
      identifyLicenseFile({ document: present(c.text), licenseField: c.field, scan }).fact.state,
    ).toBe("matches");
  });
});

describe("reading the scan directory", () => {
  let root: string;
  let seq = 0;
  const c = caseOf("cc-by-4.0");
  const OID = "a".repeat(40);
  const RESULT = JSON.stringify(c.json);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "license-scan-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A scan directory as the workflow leaves it, with one thing changed. */
  function scanDir(
    over: Partial<Record<keyof typeof SCAN_FILES, string | null>> = {},
    resultMode = 0o644,
  ): string {
    const dir = join(root, `d${++seq}`);
    mkdirSync(join(dir, "out"), { recursive: true });
    const files = { matcher: "ok\n", oid: `${OID}\n`, status: "ok\n", result: RESULT, ...over };
    for (const [k, v] of Object.entries(files)) {
      if (v === null) continue;
      const path = join(dir, SCAN_FILES[k as keyof typeof SCAN_FILES]);
      writeFileSync(path, v);
      chmodSync(path, k === "result" ? resultMode : 0o644);
    }
    return dir;
  }
  const read = (dir: string, oid: string | null = OID, owner = UID) =>
    readScanOutput(dir, oid, { resultOwnerUid: owner, controlOwnerUid: UID });

  test("a scan as the workflow leaves it is read", () => {
    const out = read(scanDir());
    expect(out.matcher).toBe(LICENSE_MATCHER_VERSION);
    expect(out.scan).not.toBeNull();
  });

  test("the job's default owner is uid 65534, so a file this user wrote is refused", () => {
    const dir = scanDir();
    if (UID !== 65534) {
      expect(readScanOutput(dir, OID, { controlOwnerUid: UID })).toEqual({
        matcher: "unavailable",
        scan: null,
      });
    }
  });

  test("a result owned by another uid is refused", () => {
    expect(read(scanDir(), OID, UID + 1).matcher).toBe("unavailable");
  });

  test.each([0o664, 0o646, 0o744, 0o4644])("mode %o is refused", (mode) => {
    expect(read(scanDir({}, mode)).matcher).toBe("unavailable");
  });

  test("mode 0600 is narrower than 0644 and accepted", () => {
    expect(read(scanDir({}, 0o600)).matcher).toBe(LICENSE_MATCHER_VERSION);
  });

  test("a symlinked result is never followed", () => {
    const dir = scanDir({ result: null });
    const target = join(root, `target-${seq}.json`);
    writeFileSync(target, RESULT);
    chmodSync(target, 0o644);
    symlinkSync(target, join(dir, SCAN_FILES.result));
    expect(read(dir).matcher).toBe("unavailable");
  });

  test("a scan of another blob is refused", () => {
    expect(read(scanDir({ oid: `${"b".repeat(40)}\n` })).matcher).toBe("unavailable");
    expect(read(scanDir({ oid: null })).matcher).toBe("unavailable");
  });

  test("a scan that did not finish, or an install that failed, is unavailable", () => {
    expect(read(scanDir({ status: null })).matcher).toBe("unavailable");
    expect(read(scanDir({ status: "failed\n" })).matcher).toBe("unavailable");
    expect(read(scanDir({ matcher: "failed\n" })).matcher).toBe("unavailable");
    expect(read(scanDir({ matcher: null }), null).matcher).toBe("unavailable");
  });

  test("with no LICENSE to scan, only the install's word is read", () => {
    expect(read(scanDir({ status: null, oid: null, result: null }), null)).toEqual({
      matcher: LICENSE_MATCHER_VERSION,
      scan: null,
    });
  });

  test("4 MiB is read and 4 MiB + 1 is refused", () => {
    const pad = (n: number) => `${RESULT}${" ".repeat(n - Buffer.byteLength(RESULT))}`;
    expect(read(scanDir({ result: pad(SCAN_OUTPUT_MAX_BYTES) })).matcher).toBe(
      LICENSE_MATCHER_VERSION,
    );
    expect(read(scanDir({ result: pad(SCAN_OUTPUT_MAX_BYTES + 1) })).matcher).toBe("unavailable");
  });

  test("another tool version or SPDX list is refused", () => {
    const other = copy(c.json) as { headers: Record<string, unknown>[] };
    (other.headers[0] as Record<string, unknown>).tool_version = "32.4.1";
    expect(read(scanDir({ result: JSON.stringify(other) })).matcher).toBe("unavailable");
    const list = copy(c.json) as { headers: { extra_data: Record<string, unknown> }[] };
    (
      list.headers[0] as { extra_data: Record<string, unknown> }
    ).extra_data.spdx_license_list_version = "3.26";
    expect(read(scanDir({ result: JSON.stringify(list) })).matcher).toBe("unavailable");
  });

  test("output that is not JSON, or misses a field this module uses, is refused", () => {
    expect(read(scanDir({ result: "{not json" })).matcher).toBe("unavailable");
    const missing = copy(c.json) as { files: Record<string, unknown>[] };
    for (const f of missing.files) Reflect.deleteProperty(f, "license_clues");
    expect(read(scanDir({ result: JSON.stringify(missing) })).matcher).toBe("unavailable");
  });

  test("the CLI prints the fact and the matcher, and nothing else", () => {
    const dir = scanDir();
    const license = join(dir, "LICENSE");
    writeFileSync(license, c.text);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      const code = main([
        "--scan-dir",
        dir,
        "--license-field",
        c.field,
        "--license-file",
        license,
        "--license-oid",
        OID,
        "--result-owner-uid",
        String(UID),
      ]);
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { license_file: c.expected, matcher: LICENSE_MATCHER_VERSION },
    ]);
  });
});
