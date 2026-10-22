/**
 * The pure half of Part B (design `.context/plans/pr-review-change-summary.md`, sections B1 to B7):
 * what a pull request changed of the README, CHANGES and author fields the original authors
 * published. Bytes and strings in, counts and closed words out; nothing here touches git or a file.
 * Every part's blob id is the real git id of its bytes, so a test that says two parts are one blob
 * means it.
 */

import { describe, expect, test } from "bun:test";
import {
  type DocumentPart,
  ORIGINAL_LIMITS,
  PROSE_REFUSALS,
  type ProseDocument,
  type ProseRead,
  assembleDocument,
  decodeProse,
  isDocumentName,
  normalizeProse,
} from "../scripts/ci/pr-review-original";

const encoder = new TextEncoder();

/** The id git gives a blob of these bytes. */
function gitOid(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(`blob ${bytes.length}\0`);
  hasher.update(bytes);
  return hasher.digest("hex");
}

/** A regular file of the document with this text or these bytes. */
function part(name: string, content: string | Uint8Array, mode = "100644"): DocumentPart {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  return { name, mode, oid: gitOid(bytes), content: bytes };
}

/** The document a side assembles to, or a failed expectation naming the refusal. */
function assembled(read: ProseRead<ProseDocument>): ProseDocument {
  if (!read.ok) throw new Error(`refused: ${read.refusal}`);
  return read.value;
}

const NO_SKIP: ReadonlySet<string> = new Set();

describe("the limits and the refusal words", () => {
  test("the limits are the approved numbers, and every one is a positive integer", () => {
    expect(ORIGINAL_LIMITS).toEqual({
      maxDocumentBytes: 4 * 1024 * 1024,
      maxDocumentParts: 16,
      maxDocumentLines: 20_000,
      maxEditDistance: 2_000,
      minorFloor: 3,
      minorCeiling: 20,
      maxExamples: 3,
      pointerMaxBytes: 1_023,
      maxTagsTried: 32,
    });
    for (const [name, value] of Object.entries(ORIGINAL_LIMITS)) {
      expect(Number.isInteger(value) && value > 0, name).toBe(true);
    }
  });

  test("the refusal words are a closed list, each once and in snake case", () => {
    expect([...PROSE_REFUSALS]).toEqual([
      "too_large",
      "too_many_parts",
      "too_many_lines",
      "binary",
      "not_regular",
      "unreadable",
      "edit_distance_cap",
    ]);
    expect(new Set(PROSE_REFUSALS).size).toBe(PROSE_REFUSALS.length);
    for (const word of PROSE_REFUSALS) expect(word).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
  });
});

describe("document names", () => {
  test("every root README form is one README document, whatever its case or extension", () => {
    for (const name of [
      "README",
      "README.md",
      "README.rst",
      "README.txt",
      "readme.md",
      "ReadMe.TXT",
      "README.markdown",
      "README.pdf",
    ]) {
      expect(isDocumentName("readme", name), name).toBe(true);
      expect(isDocumentName("changes", name), name).toBe(false);
    }
  });

  test("a README below the root, with two extensions or with anything else in its name is not one", () => {
    for (const name of [
      "docs/README.md",
      "sub-01/README",
      "README.md.bak",
      "README.",
      "README-old.md",
      "READMEmd",
      "README.m-d",
      " README",
      "README.md/",
    ]) {
      expect(isDocumentName("readme", name), name).toBe(false);
    }
  });

  test("CHANGES and CHANGELOG are one document, bare or as Markdown, text or reStructuredText", () => {
    for (const name of [
      "CHANGES",
      "CHANGES.md",
      "changes.txt",
      "CHANGELOG",
      "Changelog.rst",
      "CHANGELOG.MD",
    ]) {
      expect(isDocumentName("changes", name), name).toBe(true);
      expect(isDocumentName("readme", name), name).toBe(false);
    }
    for (const name of [
      "CHANGES.json",
      "CHANGES.md.orig",
      "derivatives/CHANGES",
      "CHANGES_old",
      "CHANGE",
      "CHANGELOGS",
    ]) {
      expect(isDocumentName("changes", name), name).toBe(false);
    }
  });
});

describe("decodeProse", () => {
  test("UTF-8 is read as UTF-8, and a leading byte order mark is dropped", () => {
    expect(decodeProse(encoder.encode("café ☃ 𝒜"))).toEqual({ text: "café ☃ 𝒜", notUtf8: false });
    expect(decodeProse(encoder.encode("\u{FEFF}Title"))).toEqual({
      text: "Title",
      notUtf8: false,
    });
    // Only one is a byte order mark; a second U+FEFF is text.
    expect(decodeProse(encoder.encode("\u{FEFF}\u{FEFF}x")).text).toBe("\u{FEFF}x");
  });

  test("bytes that are not UTF-8 are ISO-8859-1, not windows-1252, and say so", () => {
    const decoded = decodeProse(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x9f]));
    expect(decoded.notUtf8).toBe(true);
    // windows-1252 would read 0x80 as the euro sign and 0x9F as Y with a diaeresis.
    expect(decoded.text).toBe("caf\u{E9} \u{80}\u{9F}");
    expect(decoded.text).not.toContain("\u{20AC}");
  });

  test("a byte order mark before bytes that are not UTF-8 is still dropped", () => {
    expect(decodeProse(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xe9]))).toEqual({
      text: "A\u{E9}",
      notUtf8: true,
    });
  });

  test("a long ISO-8859-1 text is decoded whole, byte for byte", () => {
    const bytes = new Uint8Array(70_001).map((_, i) => (i % 3 === 0 ? 0xe9 : 0x41 + (i % 26)));
    const decoded = decodeProse(bytes);
    expect(decoded.notUtf8).toBe(true);
    expect(decoded.text.length).toBe(bytes.length);
    for (const i of [0, 1, 0x1fff, 0x2000, 0x2001, 70_000]) {
      expect(decoded.text.charCodeAt(i), String(i)).toBe(bytes[i] as number);
    }
  });
});

describe("normalizeProse", () => {
  test("LF, CRLF and a lone CR each end a line, and the kind of break is named", () => {
    expect(normalizeProse("a\nb\n").breaks).toBe("lf");
    expect(normalizeProse("a\r\nb\r\n").breaks).toBe("crlf");
    expect(normalizeProse("a\rb\r").breaks).toBe("cr");
    expect(normalizeProse("a\r\nb\nc").breaks).toBe("mixed");
    expect(normalizeProse("a\rb\nc").breaks).toBe("mixed");
    expect(normalizeProse("one line").breaks).toBe("none");
    for (const text of ["a\nb\n", "a\r\nb\r\n", "a\rb\r", "a\r\nb\rc", "a\nb"]) {
      const texts = normalizeProse(text).lines.map((line) => line.text);
      expect(texts[0], JSON.stringify(text)).toBe("a");
      expect(texts[1], JSON.stringify(text)).toBe("b");
      for (const line of texts) expect(line).not.toContain("\r");
    }
  });

  test("the same text with CRLF, LF or CR breaks normalizes to the same lines", () => {
    const lf = normalizeProse("# Title\n\nFirst line\nsecond line\n\nNext\n").lines;
    expect(
      normalizeProse("# Title\r\n\r\nFirst line\r\nsecond line\r\n\r\nNext\r\n").lines,
    ).toEqual(lf);
    expect(normalizeProse("# Title\r\rFirst line\rsecond line\r\rNext").lines).toEqual(lf);
  });

  test("trailing spaces and tabs go; leading indentation, inner spacing, case and NBSP stay", () => {
    const { lines } = normalizeProse("  indented \t \nInner  two\u{A0}spaces\t\nCASE\n");
    expect(lines.map((line) => line.text)).toEqual([
      "  indented",
      "Inner  two\u{A0}spaces",
      "CASE",
    ]);
    // A no-break space at the end of a line is a character, not trailing space.
    expect(normalizeProse("x\u{A0}").lines[0]?.text).toBe("x\u{A0}");
  });

  test("a blank line, or one of only spaces and tabs, is dropped and starts the next paragraph", () => {
    const { lines } = normalizeProse("First\nsame paragraph\n\nSecond\n \t \nThird\nmore\n");
    expect(lines).toEqual([
      { text: "First", paragraphStart: true },
      { text: "same paragraph", paragraphStart: false },
      { text: "Second", paragraphStart: true },
      { text: "Third", paragraphStart: true },
      { text: "more", paragraphStart: false },
    ]);
  });

  test("the first line kept starts a paragraph even after leading blank lines", () => {
    expect(normalizeProse("\n\n  \nStart\nnext").lines).toEqual([
      { text: "Start", paragraphStart: true },
      { text: "next", paragraphStart: false },
    ]);
  });

  test("whether the text ends with a break is kept, so a final newline added can be told", () => {
    expect(normalizeProse("a\nb").endsWithBreak).toBe(false);
    expect(normalizeProse("a\nb\n").endsWithBreak).toBe(true);
    expect(normalizeProse("a\r\n").endsWithBreak).toBe(true);
    expect(normalizeProse("a\r").endsWithBreak).toBe(true);
    expect(normalizeProse("").endsWithBreak).toBe(false);
    expect(normalizeProse("a\nb").lines).toEqual(normalizeProse("a\nb\n").lines);
  });

  test("a hostile megabyte of spaces before a letter is normalized in linear time", () => {
    const spaces = " ".repeat(1024 * 1024);
    const started = performance.now();
    const { lines } = normalizeProse(`${spaces}x${spaces}\n${spaces}\nend`);
    // A backtracking expression for trailing blanks takes hours here; the loop takes milliseconds.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(lines).toEqual([
      { text: `${spaces}x`, paragraphStart: true },
      { text: "end", paragraphStart: true },
    ]);
  });
});

describe("assembleDocument", () => {
  test("parts are read in code-unit order of their names, each starting a paragraph", () => {
    const doc = assembled(
      assembleDocument(
        "readme",
        [part("README.rst", "rst\n"), part("readme.txt", "lower\n"), part("README", "a\nb\n")],
        NO_SKIP,
      ),
    );
    // Upper case sorts before lower case in code units, whatever a locale would say.
    expect(doc.lines).toEqual([
      { text: "a", paragraphStart: true, part: "README" },
      { text: "b", paragraphStart: false, part: "README" },
      { text: "rst", paragraphStart: true, part: "README.rst" },
      { text: "lower", paragraphStart: true, part: "readme.txt" },
    ]);
  });

  test("the end of one part and the start of the next are never one paragraph", () => {
    // Without a final newline the two files would read as one line run if they were joined as text.
    const doc = assembled(
      assembleDocument(
        "readme",
        [part("README", "end of one"), part("README.md", "start")],
        NO_SKIP,
      ),
    );
    expect(doc.lines.map((line) => line.paragraphStart)).toEqual([true, true]);
  });

  test("a part that is not a regular file is not_regular; an executable file is regular", () => {
    for (const mode of ["120000", "160000", "040000", "100664"]) {
      expect(assembleDocument("readme", [part("README.md", "x", mode)], NO_SKIP), mode).toEqual({
        ok: false,
        refusal: "not_regular",
      });
    }
    expect(assembleDocument("readme", [part("README.md", "x", "100755")], NO_SKIP).ok).toBe(true);
  });

  test("a part the caller could not read is unreadable, never an empty part", () => {
    const missing: DocumentPart = {
      name: "README",
      mode: "100644",
      oid: "0".repeat(40),
      content: "unreadable",
    };
    expect(assembleDocument("readme", [part("README.md", "x"), missing], NO_SKIP)).toEqual({
      ok: false,
      refusal: "unreadable",
    });
  });

  test("the refusal word depends on the parts, not on the order they are listed", () => {
    const link = part("README", "target", "120000");
    const missing: DocumentPart = {
      name: "README.md",
      mode: "100644",
      oid: "0".repeat(40),
      content: "unreadable",
    };
    for (const parts of [
      [link, missing],
      [missing, link],
    ]) {
      expect(assembleDocument("readme", parts, NO_SKIP)).toEqual({
        ok: false,
        refusal: "not_regular",
      });
    }
  });

  test("more than sixteen parts is too_many_parts; sixteen are read", () => {
    const names = Array.from({ length: 17 }, (_, i) => `README.x${i}`);
    const parts = names.map((name) => part(name, `${name}\n`));
    expect(assembleDocument("readme", parts, NO_SKIP)).toEqual({
      ok: false,
      refusal: "too_many_parts",
    });
    expect(assembled(assembleDocument("readme", parts.slice(0, 16), NO_SKIP)).lines.length).toBe(
      16,
    );
  });

  test("more than 4 MiB over every part of a side is too_large; exactly 4 MiB is read", () => {
    const half = ORIGINAL_LIMITS.maxDocumentBytes / 2;
    const exact = [part("README", "a".repeat(half)), part("README.md", "b".repeat(half))];
    expect(assembleDocument("readme", exact, NO_SKIP).ok).toBe(true);
    const over = [part("README", "a".repeat(half)), part("README.md", "b".repeat(half + 1))];
    expect(assembleDocument("readme", over, NO_SKIP)).toEqual({ ok: false, refusal: "too_large" });
  });

  test("a NUL byte is binary, unless the part is the same blob on both sides and is skipped", () => {
    const pdf = part("README.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]));
    const text = part("README.md", "# Title\n");
    expect(assembleDocument("readme", [text, pdf], NO_SKIP)).toEqual({
      ok: false,
      refusal: "binary",
    });
    const doc = assembled(assembleDocument("readme", [text, pdf], new Set([pdf.oid])));
    expect(doc.lines).toEqual([{ text: "# Title", paragraphStart: true, part: "README.md" }]);
    // The skip set holds ids of blobs found on both sides; a text part in it is still read.
    expect(assembled(assembleDocument("readme", [text], new Set([text.oid]))).lines.length).toBe(1);
  });

  test("more than 20,000 normalized lines is too_many_lines; blank lines are not counted", () => {
    const limit = ORIGINAL_LIMITS.maxDocumentLines;
    const atLimit = part("CHANGES", "entry\n\n".repeat(limit));
    expect(assembled(assembleDocument("changes", [atLimit], NO_SKIP)).lines.length).toBe(limit);
    const over = [part("CHANGES", "entry\n".repeat(limit)), part("CHANGELOG", "one more\n")];
    expect(assembleDocument("changes", over, NO_SKIP)).toEqual({
      ok: false,
      refusal: "too_many_lines",
    });
  });

  test("line breaks are named over every part together, and a part not UTF-8 is said", () => {
    const lf = part("README", "a\nb\n");
    const crlf = part("README.md", "c\r\n");
    const none = part("README.txt", "d");
    expect(assembled(assembleDocument("readme", [lf, none], NO_SKIP)).breaks).toBe("lf");
    expect(assembled(assembleDocument("readme", [lf, crlf], NO_SKIP)).breaks).toBe("mixed");
    expect(assembled(assembleDocument("readme", [none], NO_SKIP)).breaks).toBe("none");
    expect(assembled(assembleDocument("readme", [lf, crlf], NO_SKIP)).notUtf8).toBe(false);
    const latin = part("README.rst", new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const doc = assembled(assembleDocument("readme", [lf, latin], NO_SKIP));
    expect(doc.notUtf8).toBe(true);
    expect(doc.lines.map((line) => line.text)).toEqual(["a", "b", "caf\u{E9}"]);
  });

  test("whether each part that is not empty ends with a break is kept by name", () => {
    const doc = assembled(
      assembleDocument(
        "readme",
        [part("README", "a\nb"), part("README.md", "c\n"), part("README.txt", "")],
        NO_SKIP,
      ),
    );
    expect([...doc.finalBreak]).toEqual([
      ["README", false],
      ["README.md", true],
    ]);
  });

  test("no part at all is an empty document, not a refusal", () => {
    expect(assembled(assembleDocument("changes", [], NO_SKIP))).toEqual({
      lines: [],
      breaks: "none",
      notUtf8: false,
      finalBreak: new Map(),
    });
  });

  test("a part that is not the document's, or a name given twice, is a defect and throws", () => {
    expect(() => assembleDocument("readme", [part("CHANGES", "x")], NO_SKIP)).toThrow();
    expect(() => assembleDocument("changes", [part("docs/CHANGES", "x")], NO_SKIP)).toThrow();
    expect(() =>
      assembleDocument("readme", [part("README", "x"), part("README", "y")], NO_SKIP),
    ).toThrow();
  });
});
