/**
 * The pure half of Part B (design `.context/plans/pr-review-change-summary.md`, sections B1 to B7):
 * what a pull request changed of the README, CHANGES and author fields the original authors
 * published. Bytes and strings in, counts and closed words out; nothing here touches git or a file.
 * Every part's blob id is the real git id of its bytes, so a test that says two parts are one blob
 * means it.
 */

import { describe, expect, test } from "bun:test";
import {
  AUTHOR_OWNED_KEYS,
  type AlignOp,
  type AuthorFieldFacts,
  type DescriptionSide,
  type DocumentKind,
  type DocumentPart,
  MINOR_EDIT_KEYS,
  ORIGINAL_LIMITS,
  PROSE_REFUSALS,
  type ProseDocument,
  type ProseFacts,
  type ProseRead,
  alignLines,
  assembleDocument,
  authorFieldFacts,
  authorFieldsAltered,
  decodeProse,
  hidesText,
  isDocumentName,
  isMinorEdit,
  levenshteinWithin,
  minorBound,
  normalizeProse,
  proseAltered,
  proseFacts,
  protectedMask,
} from "../scripts/ci/pr-review-original";
import { SUMMARY_LIMITS } from "../scripts/ci/pr-review-summary";

const encoder = new TextEncoder();

/** A seeded generator (mulberry32), so a random test fails the same way every time it fails. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One element of `items`, chosen by `random`. */
function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

/** `count` distinct lines that share nothing with another prefix's. */
function distinctLines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
}

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

/** The Levenshtein distance over code points, every cell computed: the oracle for the banded one. */
function fullLevenshtein(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) {
      next[j] = Math.min(
        (row[j - 1] as number) + (x[i - 1] === y[j - 1] ? 0 : 1),
        (row[j] as number) + 1,
        (next[j - 1] as number) + 1,
      );
    }
    row = next;
  }
  return row[y.length] as number;
}

/** A string of `count` code points, each one from `alphabet`. */
function randomText(random: () => number, alphabet: readonly string[], count: number): string {
  return Array.from({ length: count }, () => pick(random, alphabet)).join("");
}

describe("minorBound and isMinorEdit", () => {
  test("the bound is a tenth of the longer line in code points, never under 3 or over 20", () => {
    const table: [number, number][] = [
      [0, 3],
      [1, 3],
      [29, 3],
      [39, 3],
      [40, 4],
      [49, 4],
      [50, 5],
      [99, 9],
      [100, 10],
      [199, 19],
      [200, 20],
      [201, 20],
      [10_000, 20],
    ];
    for (const [length, bound] of table) {
      expect(minorBound("a".repeat(length), "b"), String(length)).toBe(bound);
      expect(minorBound("b", "a".repeat(length)), String(length)).toBe(bound);
    }
  });

  test("an astral character is one code point of the length, not two code units", () => {
    // Forty astral characters are eighty UTF-16 code units, which would give a bound of 8.
    expect(minorBound("𝒜".repeat(40), "")).toBe(4);
    expect(minorBound("e\u{301}".repeat(20), "")).toBe(4);
  });

  test("an edit exactly at the bound is minor, and one more is not", () => {
    for (const length of [30, 100, 150, 1_000]) {
      const line = "a".repeat(length);
      const bound = minorBound(line, line);
      const edited = (count: number) => "b".repeat(count) + line.slice(count);
      expect(isMinorEdit(line, edited(bound)), String(length)).toBe(true);
      expect(isMinorEdit(line, edited(bound + 1)), String(length)).toBe(false);
    }
  });

  test("a typo fix is minor; a rewritten sentence and a case change of a sentence are not", () => {
    const fixed = "Participants were recruited from the community and gave written consent.";
    expect(
      isMinorEdit("Participants were recruted from the comunity and gave writen consent.", fixed),
    ).toBe(true);
    expect(isMinorEdit(fixed, "Volunteers came from a hospital and consented verbally.")).toBe(
      false,
    );
    expect(isMinorEdit(fixed, fixed.toUpperCase())).toBe(false);
  });

  test("a short negation in a line of forty characters is within the bound: the accepted cost", () => {
    // The owner kept minor edits as information the model judges (design B2, Owner Question B2).
    expect(
      isMinorEdit(
        "The recordings in this dataset are valid.",
        "The recordings in this dataset are not valid.",
      ),
    ).toBe(true);
    expect(isMinorEdit("The data are valid.", "The data are not valid.")).toBe(false);
  });
});

describe("levenshteinWithin", () => {
  test("the distance when it is at most k, and k + 1 when it is more", () => {
    expect(levenshteinWithin("kitten", "sitting", 3)).toBe(3);
    expect(levenshteinWithin("kitten", "sitting", 20)).toBe(3);
    expect(levenshteinWithin("kitten", "sitting", 2)).toBe(3);
    expect(levenshteinWithin("kitten", "sitting", 0)).toBe(1);
    expect(levenshteinWithin("same", "same", 0)).toBe(0);
    expect(levenshteinWithin("", "abc", 5)).toBe(3);
    expect(levenshteinWithin("", "abc", 1)).toBe(2);
    expect(levenshteinWithin("abc", "", 3)).toBe(3);
  });

  test("an astral character is one edit and a combining mark is one edit of its own", () => {
    expect(levenshteinWithin("😀", "a", 5)).toBe(1);
    expect(levenshteinWithin("𝒜b", "b", 5)).toBe(1);
    expect(levenshteinWithin("😀x", "😃x", 5)).toBe(1);
    // A precomposed letter against a letter and a combining accent: one replaced, one removed.
    expect(levenshteinWithin("\u{E9}", "e\u{301}", 5)).toBe(2);
  });

  test("it equals the full distance capped at k + 1 over seeded random strings", () => {
    const random = mulberry32(0x1859);
    const alphabet = ["a", "b", "c", "\u{301}", "\u{E9}", "😀", "😃", "𝒜"];
    for (let trial = 0; trial < 400; trial++) {
      const a = randomText(random, alphabet, Math.floor(random() * 24));
      const b =
        random() < 0.5
          ? randomText(random, alphabet, Math.floor(random() * 24))
          : Array.from(a)
              .map((ch) => (random() < 0.15 ? pick(random, alphabet) : ch))
              .join("");
      const full = fullLevenshtein(a, b);
      for (const k of [0, 1, 2, 3, 5, 10, 20]) {
        expect(levenshteinWithin(a, b, k), `${JSON.stringify(a)} ${JSON.stringify(b)} ${k}`).toBe(
          Math.min(full, k + 1),
        );
      }
    }
  });

  test("a megabyte line costs nothing against a short one and one linear pass against another", () => {
    const body = "a".repeat(1024 * 1024);
    let started = performance.now();
    expect(levenshteinWithin(body, "short", 20)).toBe(21);
    expect(performance.now() - started).toBeLessThan(2_000);
    // Different first and last characters, so no prefix or suffix can be cut: the band is walked.
    started = performance.now();
    expect(levenshteinWithin(`x${body}y`, `z${body}w`, 20)).toBe(2);
    expect(levenshteinWithin(`x${body}y`, `${body}`, 20)).toBe(2);
    expect(performance.now() - started).toBeLessThan(20_000);
  });
});

/** The length of a longest common subsequence, every cell computed: the oracle for alignLines. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const next = [0];
    for (let j = 1; j <= b.length; j++) {
      next[j] =
        a[i - 1] === b[j - 1]
          ? (row[j - 1] as number) + 1
          : Math.max(row[j] as number, next[j - 1] as number);
    }
    row = next;
  }
  return row[b.length] as number;
}

/** `b` rebuilt from `a` and a script, or a thrown error where the script is not one for them. */
function replay(a: readonly string[], b: readonly string[], ops: readonly AlignOp[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "equal") {
      if (a[i] !== b[j] || i >= a.length)
        throw new Error(`equal op on different lines at ${i}, ${j}`);
      out.push(a[i] as string);
      i++;
      j++;
    } else if (op === "delete") i++;
    else out.push(b[j++] as string);
  }
  if (i !== a.length || j !== b.length) throw new Error("the script does not cover both sides");
  return out;
}

/** Whether nothing is left of one side once the common prefix and suffix are matched. */
function oneSided(a: readonly string[], b: readonly string[]): boolean {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    prefix + suffix < a.length &&
    prefix + suffix < b.length &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  return prefix + suffix === a.length || prefix + suffix === b.length;
}

/** The same lines in a seeded random order (Fisher-Yates). */
function shuffled(lines: readonly string[], random: () => number): string[] {
  const out = [...lines];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as string, out[i] as string];
  }
  return out;
}

describe("alignLines", () => {
  test("the script is a shortest one, against an independent LCS over seeded random sequences", () => {
    const random = mulberry32(0x7353);
    for (let trial = 0; trial < 600; trial++) {
      const alphabet = "abcdef".slice(0, 1 + Math.floor(random() * 6)).split("");
      const a = Array.from({ length: Math.floor(random() * 30) }, () => pick(random, alphabet));
      const b = Array.from({ length: Math.floor(random() * 30) }, () => pick(random, alphabet));
      const label = `${a.join("")} ${b.join("")}`;
      const alignment = alignLines(a, b, a.length + b.length);
      if (alignment === null) throw new Error(`capped below its own size: ${label}`);
      expect(replay(a, b, alignment.ops), label).toEqual(b);
      const lcs = lcsLength(a, b);
      expect(alignment.distance, label).toBe(a.length + b.length - 2 * lcs);
      expect(alignment.ops.filter((op) => op === "equal").length, label).toBe(lcs);
      // At its own distance the script is found; one less is over the cap unless a side is empty.
      expect(alignLines(a, b, alignment.distance), label).toEqual(alignment);
      if (alignment.distance > 0) {
        expect(alignLines(a, b, alignment.distance - 1) === null, label).toBe(!oneSided(a, b));
      }
    }
  });

  test("the tie-break is pinned, so the same pull request always pairs the same lines", () => {
    expect(alignLines(["x"], ["y"])?.ops).toEqual(["delete", "insert"]);
    expect(alignLines(["a", "b"], ["b", "a"])?.ops).toEqual(["delete", "equal", "insert"]);
    expect(alignLines(["b", "a"], ["c", "b"])?.ops).toEqual(["insert", "equal", "delete"]);
    expect(alignLines(["a", "a"], ["b", "a", "c"])?.ops).toEqual([
      "insert",
      "equal",
      "delete",
      "insert",
    ]);
  });

  test("lines are compared exactly, with no normalization of their own", () => {
    expect(alignLines(["a "], ["a"])?.distance).toBe(2);
    expect(alignLines(["A"], ["a"])?.distance).toBe(2);
  });

  test("an edit distance of exactly 2,000 is aligned and 2,001 is capped", () => {
    const aligned = alignLines(distinctLines("old", 1000), distinctLines("new", 1000));
    expect(aligned?.distance).toBe(2000);
    expect(alignLines(distinctLines("old", 1001), distinctLines("new", 1000))).toBeNull();
    // The same boundary at a small cap, where it is easy to read.
    expect(alignLines(["a"], ["b"], 2)?.distance).toBe(2);
    expect(alignLines(["a"], ["b"], 1)).toBeNull();
  });

  test("pure insertion or pure removal is never capped, however long", () => {
    const base = distinctLines("original", 10);
    const appended = [...base, ...distinctLines("new section", 5_000)];
    const end = alignLines(base, appended);
    expect(end?.distance).toBe(5_000);
    expect(end?.ops.slice(0, 10)).toEqual(new Array(10).fill("equal"));
    const middle = [...base.slice(0, 5), ...distinctLines("inserted", 5_000), ...base.slice(5)];
    expect(alignLines(base, middle, 0)?.distance).toBe(5_000);
    expect(alignLines(appended, base, 0)?.distance).toBe(5_000);
  });

  test("20,000 shuffled lines stop at the cap after a bounded number of steps", () => {
    const random = mulberry32(0x20000);
    const lines = distinctLines("line", 20_000);
    const meter = { steps: 0 };
    const started = performance.now();
    expect(alignLines(lines, shuffled(lines, random), undefined, meter)).toBeNull();
    const elapsed = performance.now() - started;
    const maxD = ORIGINAL_LIMITS.maxEditDistance;
    // One step per diagonal tried at each distance up to the cap, and at most one per matching
    // cell: with distinct lines a line matches exactly one other, so 20,000 cells at most.
    expect(meter.steps).toBeLessThanOrEqual(((maxD + 1) * (maxD + 2)) / 2 + lines.length);
    expect(meter.steps).toBeGreaterThan(((maxD + 1) * (maxD + 2)) / 2 - 1);
    expect(elapsed).toBeLessThan(10_000);
  });

  test("a two-line alphabet, the most matches per diagonal, stays within the O((N + M) D) bound", () => {
    const random = mulberry32(0x2);
    const a = Array.from({ length: 20_000 }, () => (random() < 0.5 ? "0" : "1"));
    const b = Array.from({ length: 20_000 }, () => (random() < 0.5 ? "0" : "1"));
    const meter = { steps: 0 };
    const started = performance.now();
    expect(alignLines(a, b, undefined, meter)).toBeNull();
    const maxD = ORIGINAL_LIMITS.maxEditDistance;
    // A diagonal's furthest point only moves forward, so each of the 2D + 1 diagonals walks at most
    // N matching lines in all.
    expect(meter.steps).toBeLessThanOrEqual(
      ((maxD + 1) * (maxD + 2)) / 2 + (2 * maxD + 1) * a.length,
    );
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

/** A document's parts, from file names to texts or bytes. */
type Files = Record<string, string | Uint8Array>;

function parts(files: Files): DocumentPart[] {
  return Object.entries(files).map(([name, content]) => part(name, content));
}

/** The facts of a document, or a failed expectation naming the refusal. */
function factsOf(
  document: DocumentKind,
  base: Files,
  head: Files,
  anchor: Files | null = null,
): ProseFacts {
  const result = proseFacts({
    document,
    base: parts(base),
    head: parts(head),
    anchor: anchor === null ? null : parts(anchor),
  });
  if (!result.ok) throw new Error(`refused: ${result.refusal}`);
  return result.facts;
}

const readme = (base: Files, head: Files, anchor: Files | null = null): ProseFacts =>
  factsOf("readme", base, head, anchor);

/** A README as original authors publish one: a title and three paragraphs under headings. */
const ORIGINAL_LINES = [
  "# Visual oddball EEG", // 0
  "",
  "This dataset contains EEG recordings from 24 healthy adults", // 2
  "performing a visual oddball task with 20% rare targets.", // 3
  "",
  "## Participants", // 5
  "",
  "Participants were recruited from the university community", // 7
  "and gave written informed consent before the session.", // 8
  "",
  "## Recording", // 10
  "",
  "Data were recorded with a 64-channel system at 512 Hz.", // 12
];
const ORIGINAL = `${ORIGINAL_LINES.join("\n")}\n`;
const ORIGINAL_PROTECTED = 8;

/** The original README with its raw lines (blank ones included, numbered above) edited. */
function edited(edit: (lines: string[]) => void, text = ORIGINAL): string {
  const lines = text.replace(/\n$/, "").split("\n");
  edit(lines);
  return `${lines.join("\n")}\n`;
}

/** The facts of a README whose every protected line is kept and nothing else happened. */
function untouched(protectedLines: number, overrides: Partial<ProseFacts> = {}): ProseFacts {
  return {
    document: "readme",
    anchor: "merge_base",
    preserved: true,
    protectedLines,
    protectedAltered: 0,
    minorEdits: 0,
    laterAltered: 0,
    moved: false,
    movedLines: 0,
    insertedInsideParagraph: 0,
    insertedLines: 0,
    lineEndingsChanged: false,
    finalNewlineAdded: false,
    notUtf8: false,
    partsBefore: 1,
    partsAfter: 1,
    hidingMarkupInserted: 0,
    shownPartReplaced: false,
    examples: [],
    ...overrides,
  };
}

describe("protectedMask", () => {
  test("every CHANGES line is protected, with an anchor or without one", () => {
    expect(protectedMask("changes", ["a", "b", "a"], null)).toEqual([true, true, true]);
    expect(protectedMask("changes", ["a", "b", "a"], [])).toEqual([true, true, true]);
  });

  test("with no anchor every README line at the merge base is protected", () => {
    expect(protectedMask("readme", ["a", "b"], null)).toEqual([true, true]);
  });

  test("a README line is protected when the anchor has it, the first copies first", () => {
    expect(protectedMask("readme", ["a", "new", "b"], ["a", "b"])).toEqual([true, false, true]);
    // One copy at the anchor protects one copy at the base: the first, and no rebalancing.
    expect(protectedMask("readme", ["a", "x", "a"], ["a"])).toEqual([true, false, false]);
    expect(protectedMask("readme", ["a"], ["a", "a"])).toEqual([true]);
    expect(protectedMask("readme", ["a", "a", "a"], ["a", "a"])).toEqual([true, true, false]);
  });
});

describe("proseFacts: the cases of design B7", () => {
  test("a README whose last line gains a final newline and a new section is preserved (on005398)", () => {
    const base = ORIGINAL.replace(/\n$/, "");
    const head = `${base}\n\n## Changes in 1.0.1\n\nEvent codes were corrected; see CHANGES.\n`;
    const facts = readme({ "README.md": base }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, { insertedLines: 2, finalNewlineAdded: true }),
    );
    expect(proseAltered(facts)).toBe(false);
  });

  test("a README turned from CRLF to LF with a section appended is preserved and says so (on004703)", () => {
    const base = ORIGINAL.replaceAll("\n", "\r\n");
    const head = `${ORIGINAL}\n## Derivatives\n\nNone yet.\n`;
    const facts = readme({ README: base }, { README: head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, { insertedLines: 2, lineEndingsChanged: true }),
    );
    expect(proseAltered(facts)).toBe(false);
  });

  test("removing an original paragraph is an alteration, with the removed lines as examples", () => {
    const head = edited((lines) => lines.splice(7, 3));
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        protectedAltered: 2,
        examples: [ORIGINAL_LINES[7] as string, ORIGINAL_LINES[8] as string],
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  const CURATION =
    "\n## NEMAR curation changes (2026-05-21)\n\n- Events were re-aligned to the photodiode.\n- Channel labels were made BIDS compliant.\n";
  const CURATION_REWORDED =
    "\n## NEMAR curation changes (2026-05-21)\n\n- Onsets now come from light sensor timestamps, not triggers.\n- Every electrode name follows the BIDS label rules now.\n";

  test("rewording a section added after the version tag is information, not an alteration (on002578)", () => {
    const facts = readme(
      { "README.md": ORIGINAL + CURATION },
      { "README.md": ORIGINAL + CURATION_REWORDED },
      { "README.md": ORIGINAL },
    );
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        anchor: "first_version_tag",
        laterAltered: 2,
        insertedLines: 2,
      }),
    );
    expect(proseAltered(facts)).toBe(false);
  });

  test("with no version tag every merge-base line is protected, later sections included", () => {
    const facts = readme(
      { "README.md": ORIGINAL + CURATION },
      { "README.md": ORIGINAL + CURATION_REWORDED },
    );
    expect(facts.anchor).toBe("merge_base");
    expect(facts.protectedLines).toBe(ORIGINAL_PROTECTED + 3);
    expect(facts.protectedAltered).toBe(2);
    expect(facts.laterAltered).toBe(0);
    expect(facts.examples).toEqual([
      "- Events were re-aligned to the photodiode.",
      "- Channel labels were made BIDS compliant.",
    ]);
    expect(proseAltered(facts)).toBe(true);
  });

  test("an anchor with no README part, or one that cannot be read, protects every base line", () => {
    const base = { "README.md": ORIGINAL + CURATION };
    const head = { "README.md": ORIGINAL + CURATION_REWORDED };
    const strict = readme(base, head);
    const anchors: Files[] = [
      {},
      { "README.md": new Uint8Array([0x41, 0x00]) }, // binary, and not a blob of either side
    ];
    for (const anchor of anchors) {
      expect(readme(base, head, anchor)).toEqual(strict);
    }
    const link = proseFacts({
      document: "readme",
      base: parts(base),
      head: parts(head),
      anchor: [part("README.md", "target", "120000")],
    });
    expect(link).toEqual({ ok: true, facts: strict });
  });

  test("a typo fixed within the minor bound is information; a sentence rewritten is altered", () => {
    const typo = edited((lines) => {
      lines[7] = "Participants were recruted from the univeristy community";
    });
    const fixed = readme({ "README.md": typo }, { "README.md": ORIGINAL });
    expect(fixed).toEqual(
      untouched(ORIGINAL_PROTECTED, { preserved: false, minorEdits: 1, insertedLines: 1 }),
    );
    expect(proseAltered(fixed)).toBe(false);
    const rewritten = edited((lines) => {
      lines[7] = "Volunteers answered an advertisement in the local newspaper";
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": rewritten });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        protectedAltered: 1,
        insertedLines: 1,
        examples: [ORIGINAL_LINES[7] as string],
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  test("a line inserted between two lines of an original paragraph is an alteration", () => {
    const head = edited((lines) => lines.splice(8, 0, "Consent forms were later lost."));
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        insertedInsideParagraph: 1,
        insertedLines: 1,
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  test("a new paragraph between original ones is preserved", () => {
    const head = edited((lines) => lines.splice(9, 0, "", "Consent forms are kept by the lab."));
    expect(readme({ "README.md": ORIGINAL }, { "README.md": head })).toEqual(
      untouched(ORIGINAL_PROTECTED, { insertedLines: 1 }),
    );
  });

  test("a sentence added at the end of a paragraph without a blank line is left to the model", () => {
    // The base line after it starts a paragraph, so no original paragraph is split.
    const head = edited((lines) => lines.splice(9, 0, "Consent forms are kept by the lab."));
    expect(readme({ "README.md": ORIGINAL }, { "README.md": head })).toEqual(
      untouched(ORIGINAL_PROTECTED, { insertedLines: 1 }),
    );
  });

  test("a line inserted after a minor edit inside a paragraph is still inside the paragraph", () => {
    const head = edited((lines) => {
      lines[7] = "Participants were recruited from the University community";
      lines.splice(8, 0, "(most of them were psychology students)");
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        minorEdits: 1,
        insertedInsideParagraph: 1,
        insertedLines: 2,
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  test("a hunk pairs its j-th removed line of any kind with its j-th inserted line", () => {
    // The later line before the original one is paired too, so the original line's partner is its
    // own edited form; pairing only protected lines would give it the later line's replacement.
    const base = edited((lines) => lines.splice(12, 0, "A line added after the tag."));
    const head = edited((lines) => {
      lines.splice(
        12,
        1,
        "A later line, reworded.",
        "Data were recorded with a 64-channel system at 500 Hz.",
      );
    });
    const facts = readme({ "README.md": base }, { "README.md": head }, { "README.md": ORIGINAL });
    expect(facts.laterAltered).toBe(1);
    expect(facts.minorEdits).toBe(1);
    expect(facts.protectedAltered).toBe(0);
    expect(proseAltered(facts)).toBe(false);
  });

  test("a paragraph line rewritten as two lines is one alteration, not also an insertion inside", () => {
    // The extra line follows a line that did not survive, so it is counted once, as the alteration.
    const head = edited((lines) => {
      lines.splice(7, 1, "Volunteers answered an advertisement in the paper", "and were paid.");
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        protectedAltered: 1,
        insertedLines: 2,
        examples: [ORIGINAL_LINES[7] as string],
      }),
    );
  });

  test("an original section moved below a new one is moved, and moved fails", () => {
    const head = edited((lines) => {
      const recording = lines.splice(10, 3);
      lines.splice(5, 0, ...recording, "");
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, {
        preserved: false,
        moved: true,
        movedLines: 2,
        insertedLines: 2,
        examples: [ORIGINAL_LINES[10] as string, ORIGINAL_LINES[12] as string],
      }),
    );
    expect(proseAltered(facts)).toBe(true);
  });

  test("README.md renamed to README.rst, or README to README.md, with the same text is preserved", () => {
    expect(readme({ "README.md": ORIGINAL }, { "README.rst": ORIGINAL })).toEqual(
      untouched(ORIGINAL_PROTECTED),
    );
    expect(readme({ README: ORIGINAL }, { "README.md": ORIGINAL })).toEqual(
      untouched(ORIGINAL_PROTECTED),
    );
  });

  const CHANGES =
    "1.0.1 2024-03-01\n  - Fixed event onsets.\n\n1.0.0 2023-11-15\n  - Initial release.\n";

  test("a new CHANGES entry at the top is fine; editing an old entry, even by one letter, fails", () => {
    const top = factsOf(
      "changes",
      { CHANGES },
      { CHANGES: `1.0.2 2026-10-01\n  - Added a derivative.\n\n${CHANGES}` },
    );
    expect(top).toEqual(untouched(4, { document: "changes", insertedLines: 2 }));
    expect(proseAltered(top)).toBe(false);
    const typo = factsOf(
      "changes",
      { CHANGES },
      { CHANGES: CHANGES.replace("Fixed event onsets.", "Fixed event onset.") },
    );
    expect(typo).toEqual(
      untouched(4, {
        document: "changes",
        preserved: false,
        protectedAltered: 1,
        insertedLines: 1,
        examples: ["  - Fixed event onsets."],
      }),
    );
    expect(proseAltered(typo)).toBe(true);
  });

  test("CHANGES ignores an anchor: its whole history at the merge base is protected", () => {
    const facts = factsOf("changes", { CHANGES }, { CHANGES }, { CHANGES: "1.0.0\n" });
    expect(facts.anchor).toBe("merge_base");
    expect(facts.protectedLines).toBe(4);
  });

  test("an entry put between CHANGES lines with no blank line between them is not an alteration", () => {
    const tight = "1.0.1 fixed onsets\n1.0.0 initial release\n";
    const facts = factsOf(
      "changes",
      { "CHANGES.md": tight },
      { "CHANGES.md": "1.0.1 fixed onsets\n1.0.0.1 a backport\n1.0.0 initial release\n" },
    );
    expect(facts.insertedInsideParagraph).toBe(1);
    expect(facts.preserved).toBe(false);
    expect(proseAltered(facts)).toBe(false);
  });
});

describe("proseFacts: the adversarial cases of design B6", () => {
  test("trailing whitespace and line endings cleaned up everywhere is preserved", () => {
    const messy = ORIGINAL_LINES.map((line, i) => (i % 2 === 0 ? `${line} \t` : line)).join("\r\n");
    const facts = readme({ "README.md": messy }, { "README.md": ORIGINAL });
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, { lineEndingsChanged: true, finalNewlineAdded: true }),
    );
  });

  test("indentation is significant: a small change is a minor edit", () => {
    const head = edited((lines) => {
      lines[12] = `    ${lines[12]}`;
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts.minorEdits).toBe(1);
    expect(facts.preserved).toBe(false);
    expect(proseAltered(facts)).toBe(false);
  });

  test("case is significant: one letter is a minor edit, a whole sentence is an alteration", () => {
    const one = edited((lines) => {
      lines[12] = "Data were recorded with a 64-Channel system at 512 Hz.";
    });
    expect(readme({ "README.md": ORIGINAL }, { "README.md": one }).minorEdits).toBe(1);
    const all = edited((lines) => {
      lines[12] = (lines[12] as string).toUpperCase();
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": all });
    expect(facts.protectedAltered).toBe(1);
    expect(proseAltered(facts)).toBe(true);
  });

  test("a README re-encoded from ISO-8859-1 to UTF-8 with a byte order mark compares its text", () => {
    const latin = new Uint8Array([...encoder.encode("Caf"), 0xe9, ...encoder.encode(" study\n")]);
    const facts = readme({ README: latin }, { README: "\u{FEFF}Café study\n" });
    expect(facts).toEqual(untouched(1, { notUtf8: true }));
  });

  test("a README removed, with its text moved below the root, is every protected line altered", () => {
    const facts = readme({ "README.md": ORIGINAL }, {});
    expect(facts.protectedAltered).toBe(ORIGINAL_PROTECTED);
    expect(facts.partsAfter).toBe(0);
    expect(facts.examples.length).toBe(ORIGINAL_LIMITS.maxExamples);
    expect(proseAltered(facts)).toBe(true);
  });

  test("a README added where there was none is only insertion", () => {
    const facts = readme({}, { "README.md": ORIGINAL });
    expect(facts).toEqual(untouched(0, { partsBefore: 0, insertedLines: ORIGINAL_PROTECTED }));
  });

  test("a line added after the anchor that repeats an original one is not protected", () => {
    // The original line appears once at the tag and twice at the base; removing the later copy
    // removes text added after the tag. Protecting by set instead of by count would fail it.
    const repeated = `${ORIGINAL}\n## Notes\n\n${ORIGINAL_LINES[12]}\n`;
    const head = `${ORIGINAL}\n## Notes\n\nSee the recording section.\n`;
    const facts = readme(
      { "README.md": repeated },
      { "README.md": head },
      { "README.md": ORIGINAL },
    );
    expect(facts.protectedAltered).toBe(0);
    expect(facts.laterAltered).toBe(1);
    expect(proseAltered(facts)).toBe(false);
  });

  test("two copies of a protected line removed and one put back elsewhere: one moved, one altered", () => {
    // Both copies of line 2 go (with the Notes heading), and one copy comes back as a new paragraph:
    // one copy found elsewhere is moved, and the other has nothing left to be found as.
    const twice = `${ORIGINAL}\n## Notes\n\n${ORIGINAL_LINES[2]}\n`;
    const head = edited((lines) => {
      lines.splice(9, 0, "", ORIGINAL_LINES[2] as string);
      lines.splice(2, 1, "A new opening sentence.");
    });
    const facts = readme({ "README.md": twice }, { "README.md": head });
    expect(facts.movedLines).toBe(1);
    expect(facts.protectedAltered).toBe(2);
    expect(facts.examples).toEqual([
      "## Notes",
      ORIGINAL_LINES[2] as string,
      ORIGINAL_LINES[2] as string,
    ]);
    expect(proseAltered(facts)).toBe(true);
  });

  test("a line inserted at the end of one part is not inside the paragraph of the next part", () => {
    const base = {
      README: "First part, line one\nfirst part, line two\n",
      "README.md": "Second\npart\n",
    };
    const head = {
      README: "First part, line one\nfirst part, line two\nan added third line\n",
      "README.md": "Second\npart\n",
    };
    const facts = readme(base, head);
    expect(facts).toEqual(untouched(4, { partsBefore: 2, partsAfter: 2, insertedLines: 1 }));
  });

  test("a final newline added to a renamed part is not one added to the same part", () => {
    const base = ORIGINAL.replace(/\n$/, "");
    expect(readme({ README: base }, { "README.md": ORIGINAL }).finalNewlineAdded).toBe(false);
    expect(readme({ README: base }, { README: ORIGINAL }).finalNewlineAdded).toBe(true);
  });
});

describe("proseFacts: the tripwires", () => {
  test("original paragraphs wrapped in an HTML comment are preserved but trip the markup fact", () => {
    const head = edited((lines) => {
      lines.splice(9, 0, "-->");
      lines.splice(7, 0, "<!--");
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts.protectedAltered + facts.movedLines + facts.minorEdits).toBe(0);
    expect(facts.hidingMarkupInserted).toBe(2);
    // Not an alteration by itself: what the tripwire does is the caller's to decide.
    expect(proseAltered(facts)).toBe(false);
  });

  test("a details block around an original section trips the markup fact", () => {
    const head = edited((lines) => {
      lines.splice(10, 0, "<details><summary>Old notes</summary>", "");
      lines.push("", "</details>");
    });
    expect(readme({ "README.md": ORIGINAL }, { "README.md": head }).hidingMarkupInserted).toBe(2);
  });

  test("hiding markup put into original lines by minor edits trips the markup fact too", () => {
    const head = edited((lines) => {
      lines[2] = `<!-- ${lines[2]}`;
      lines[3] = `${lines[3]} -->`;
    });
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts.minorEdits).toBe(2);
    expect(facts.hidingMarkupInserted).toBe(2);
  });

  test("a new README.md beside the original README hides it from the shown README", () => {
    const facts = readme(
      { README: ORIGINAL },
      { README: ORIGINAL, "README.md": "# Visual oddball EEG\n\nSee the new documentation.\n" },
    );
    // Read whole, the document is the original plus an appended part: preserved.
    expect(facts.preserved).toBe(true);
    expect(facts.shownPartReplaced).toBe(true);
    expect(proseAltered(facts)).toBe(false);
  });

  test("the original moved from the shown README.md into a README beside it is shadowed too", () => {
    const facts = readme(
      { "README.md": ORIGINAL },
      { README: ORIGINAL, "README.md": "# A rewritten introduction\n" },
    );
    expect(facts.shownPartReplaced).toBe(true);
  });

  test("a rename keeps the shown part, and a lowercase readme is never the shown part", () => {
    expect(readme({ README: ORIGINAL }, { "README.md": ORIGINAL }).shownPartReplaced).toBe(false);
    expect(
      readme({ "readme.md": ORIGINAL }, { "readme.md": `${ORIGINAL}\nMore.\n` }).shownPartReplaced,
    ).toBe(false);
    // With no README the platform shows at the base, every base part counts as shown.
    expect(
      readme({ "readme.md": ORIGINAL }, { "readme.md": ORIGINAL, "README.md": "# New\n" })
        .shownPartReplaced,
    ).toBe(true);
  });

  test("only a protected line kept in a part no longer shown trips it", () => {
    // The later note stays verbatim but moves into README.txt, which the platform does not show.
    const base = { "README.md": `${ORIGINAL}\nLater note.\n` };
    const head = { "README.md": ORIGINAL, "README.txt": "Later note.\n" };
    const tagged = readme(base, head, { "README.md": ORIGINAL });
    expect(tagged.preserved).toBe(true);
    expect(tagged.shownPartReplaced).toBe(false);
    // Without a tag the note is protected, and the same pull request hides a protected line.
    expect(readme(base, head).shownPartReplaced).toBe(true);
  });
});

describe("hidesText", () => {
  test("comments, hiding elements and hiding attributes are markup that hides", () => {
    for (const line of [
      "<!--",
      "text <!-- hidden",
      "-->",
      "<details>",
      "</DETAILS>",
      "<details open>",
      "<script>x</script>",
      "<style>",
      "<template>",
      "<noscript>",
      "<textarea>",
      "<iframe src=x>",
      "<object data=x>",
      "<div hidden>",
      '<p class="x" hidden="">',
      '<span style="display:none">',
      '<div style="display : none">',
      '<span style="visibility: hidden">',
      "<div\thidden",
    ]) {
      expect(hidesText(line), line).toBe(true);
    }
  });

  test("other markup, a code span and plain words are not", () => {
    for (const line of [
      "`<s>`",
      "<s>struck</s>",
      "<strong>bold</strong>",
      "<sub>2</sub>",
      "<summary>Notes</summary>",
      "<objects>",
      "<detailsx>",
      "This was hidden in plain sight.",
      "a < b and hidden > c",
      "Set display: none in the stylesheet.",
      "<br> hidden",
      "",
    ]) {
      expect(hidesText(line), line).toBe(false);
    }
  });

  test("a hostile line of unclosed tags is read in one pass", () => {
    const hostile = `${"<a ".repeat(400_000)}hidden`;
    const started = performance.now();
    expect(hidesText(hostile)).toBe(true);
    expect(hidesText("<a ".repeat(400_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe("proseFacts: bounds and refusals", () => {
  test("two sides more than 2,000 lines apart are refused, never half compared", () => {
    const base = `${distinctLines("old", 1001).join("\n")}\n`;
    const head = `${distinctLines("new", 1000).join("\n")}\n`;
    expect(
      proseFacts({
        document: "readme",
        base: parts({ README: base }),
        head: parts({ README: head }),
        anchor: null,
      }),
    ).toEqual({ ok: false, refusal: "edit_distance_cap" });
  });

  test("5,000 lines appended are compared, however far past the cap", () => {
    const head = `${ORIGINAL}\n${distinctLines("appended", 5_000).join("\n")}\n`;
    const facts = readme({ "README.md": ORIGINAL }, { "README.md": head });
    expect(facts).toEqual(untouched(ORIGINAL_PROTECTED, { insertedLines: 5_000 }));
  });

  test("a binary part that changed refuses the document; one that did not is skipped", () => {
    const pdfBefore = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]);
    const pdfAfter = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x02]);
    const changed = proseFacts({
      document: "readme",
      base: parts({ "README.md": ORIGINAL, "README.pdf": pdfBefore }),
      head: parts({ "README.md": ORIGINAL, "README.pdf": pdfAfter }),
      anchor: null,
    });
    expect(changed).toEqual({ ok: false, refusal: "binary" });
    const facts = readme(
      { "README.md": ORIGINAL, "README.pdf": pdfBefore },
      { "README.md": `${ORIGINAL}\nAdded.\n`, "README.pdf": pdfBefore },
    );
    expect(facts).toEqual(
      untouched(ORIGINAL_PROTECTED, { partsBefore: 2, partsAfter: 2, insertedLines: 1 }),
    );
  });

  test("a side's refusal is the document's refusal", () => {
    const link = proseFacts({
      document: "readme",
      base: parts({ "README.md": ORIGINAL }),
      head: [part("README.md", "elsewhere", "120000")],
      anchor: null,
    });
    expect(link).toEqual({ ok: false, refusal: "not_regular" });
  });

  test("an example is cut after 301 code points, never inside a surrogate pair", () => {
    const long = "x".repeat(1_000);
    const astral = "😀".repeat(400);
    const facts = readme({ "README.md": `${long}\n\n${astral}\n` }, { "README.md": "" });
    const max = SUMMARY_LIMITS.maxValueChars + 1;
    expect(facts.examples).toEqual(["x".repeat(max), "😀".repeat(max)]);
    expect(Array.from(facts.examples[1] as string).length).toBe(max);
  });
});

/** Whether `needle` is a subsequence of `hay`, taking the first match each time. */
function isSubsequence(needle: readonly string[], hay: readonly string[]): boolean {
  let k = 0;
  for (const line of hay) if (k < needle.length && line === needle[k]) k++;
  return k === needle.length;
}

/** A random README: paragraphs of one to four lines drawn from a small vocabulary, so lines repeat. */
function randomReadme(random: () => number): string[][] {
  const vocabulary = distinctLines("Sentence", 9);
  return Array.from({ length: 1 + Math.floor(random() * 6) }, () =>
    Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(random, vocabulary)),
  );
}

/** The text of paragraphs, a blank line between each two. */
function joinParagraphs(paragraphs: readonly (readonly string[])[]): string {
  return `${paragraphs.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}

describe("proseFacts: properties over seeded random READMEs", () => {
  test("new paragraphs inserted between original ones always leave the README preserved", () => {
    const random = mulberry32(0x5398);
    for (let trial = 0; trial < 300; trial++) {
      const paragraphs = randomReadme(random);
      const anchor = random() < 0.5 ? null : { README: joinParagraphs(paragraphs.slice(0, 2)) };
      const head: string[][] = [];
      let added = 0;
      for (const lines of [...paragraphs, null]) {
        if (random() < 0.4) {
          const fresh = distinctLines(`New ${trial} ${added}`, 1 + Math.floor(random() * 3));
          head.push(fresh);
          added += fresh.length;
        }
        if (lines) head.push(lines);
      }
      const label = `${trial}: ${JSON.stringify(head)}`;
      const facts = readme(
        { README: joinParagraphs(paragraphs) },
        { README: joinParagraphs(head) },
        anchor,
      );
      expect(facts.preserved, label).toBe(true);
      expect(facts.insertedLines, label).toBe(added);
      expect(facts.laterAltered + facts.insertedInsideParagraph, label).toBe(0);
    }
  });

  test("a line inserted between two lines of one original paragraph is always inside it", () => {
    const random = mulberry32(0x4703);
    let checked = 0;
    for (let trial = 0; trial < 300; trial++) {
      const paragraphs = randomReadme(random);
      const at = paragraphs.findIndex((lines) => lines.length >= 2);
      if (at < 0) continue;
      const head = paragraphs.map((lines) => [...lines]);
      (head[at] as string[]).splice(1, 0, `Inserted ${trial}`);
      const facts = readme(
        { README: joinParagraphs(paragraphs) },
        { README: joinParagraphs(head) },
      );
      expect(facts.insertedInsideParagraph, JSON.stringify(head)).toBe(1);
      expect(proseAltered(facts)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("whenever the protected lines are no longer a subsequence of the head, something is reported", () => {
    const random = mulberry32(0x2578);
    let reported = 0;
    for (let trial = 0; trial < 400; trial++) {
      const paragraphs = randomReadme(random);
      const baseLines = paragraphs.flat();
      const anchorLines = random() < 0.5 ? null : baseLines.filter(() => random() < 0.7);
      const head = paragraphs.map((lines) => [...lines]);
      const deleteOnly = random() < 0.5;
      for (let edit = 0; edit < 1 + Math.floor(random() * 3); edit++) {
        const lines = pick(random, head);
        const at = Math.floor(random() * lines.length);
        if (deleteOnly || random() < 0.4) lines.splice(at, 1);
        else if (random() < 0.5) lines.splice(at, 0, pick(random, baseLines));
        else lines.splice(at, 1, `Replacement ${edit}`);
      }
      const remaining = head.filter((lines) => lines.length > 0);
      // Protection recomputed here, as the definition states it: an anchor copy for each base copy.
      const left = new Map<string, number>();
      for (const line of anchorLines ?? []) left.set(line, (left.get(line) ?? 0) + 1);
      const protectedTexts = baseLines.filter((line) => {
        if (anchorLines === null) return true;
        const count = left.get(line) ?? 0;
        left.set(line, count - 1);
        return count > 0;
      });
      const headLines = remaining.flat();
      const facts = readme(
        { README: joinParagraphs(paragraphs) },
        { README: remaining.length > 0 ? joinParagraphs(remaining) : "" },
        anchorLines === null ? null : { README: `${anchorLines.join("\n")}\n` },
      );
      const label = `${trial}: ${JSON.stringify(paragraphs)} -> ${JSON.stringify(remaining)}`;
      if (!isSubsequence(protectedTexts, headLines)) {
        expect(facts.preserved, label).toBe(false);
        expect(facts.protectedAltered + facts.movedLines + facts.minorEdits, label).toBeGreaterThan(
          0,
        );
        if (deleteOnly) expect(facts.protectedAltered, label).toBeGreaterThan(0);
        reported++;
      }
    }
    expect(reported).toBeGreaterThan(150);
  });
});

/** A dataset description as a contributor's tool writes it: indented JSON. */
function description(fields: Record<string, unknown>): Uint8Array {
  return encoder.encode(`${JSON.stringify(fields, null, 2)}\n`);
}

/** Facts with nothing changed, for tests to override. */
function noFieldChange(overrides: Partial<AuthorFieldFacts> = {}): AuthorFieldFacts {
  return {
    altered: [],
    removed: [],
    minor: [],
    grown: [],
    added: [],
    unparsed: false,
    ...overrides,
  };
}

const DESCRIPTION = {
  Name: "Visual oddball EEG",
  BIDSVersion: "1.8.0",
  DatasetType: "raw",
  License: "CC-BY-4.0",
  Authors: ["Ada Lovelace", "Alan Turing", "Grace Hopper"],
  Funding: [
    "This work was supported by the National Institute of Mental Health grant R01MH000000 to the lab.",
  ],
  ReferencesAndLinks: ["https://example.org/paper"],
  DatasetDOI: "doi:10.18112/openneuro.ds000000.v1.0.0",
  GeneratedBy: [{ Name: "a converter", Version: "1.0" }],
};

/** The description with some fields replaced (`undefined` deletes a key). */
function changed(fields: Record<string, unknown>): Uint8Array {
  const out: Record<string, unknown> = { ...DESCRIPTION };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return description(out);
}

describe("author-owned fields: the closed lists", () => {
  test("the nine author-owned keys and the five that take a minor edit, none with an underscore", () => {
    expect([...AUTHOR_OWNED_KEYS]).toEqual([
      "Name",
      "Authors",
      "License",
      "ReferencesAndLinks",
      "Funding",
      "Acknowledgements",
      "HowToAcknowledge",
      "DatasetDOI",
      "EthicsApprovals",
    ]);
    expect([...MINOR_EDIT_KEYS]).toEqual([
      "Funding",
      "Acknowledgements",
      "HowToAcknowledge",
      "EthicsApprovals",
      "ReferencesAndLinks",
    ]);
    for (const key of AUTHOR_OWNED_KEYS) expect(key).toMatch(/^[A-Za-z]+$/);
    for (const key of ["Name", "Authors", "License", "DatasetDOI"] as const) {
      expect(MINOR_EDIT_KEYS.includes(key), key).toBe(false);
    }
  });
});

describe("authorFieldFacts", () => {
  test("empty placeholders removed are not an alteration (on004022)", () => {
    const before = description({
      ...DESCRIPTION,
      Acknowledgements: "",
      HowToAcknowledge: "",
      Funding: [""],
      EthicsApprovals: [],
    });
    const after = changed({ Funding: undefined });
    const facts = authorFieldFacts(before, after);
    expect(facts).toEqual(noFieldChange());
    expect(authorFieldsAltered(facts)).toBe(false);
  });

  test('an empty placeholder normalized from [""] to [] is not an alteration (on004855)', () => {
    const facts = authorFieldFacts(
      changed({ ReferencesAndLinks: [""] }),
      changed({ ReferencesAndLinks: [] }),
    );
    expect(facts).toEqual(noFieldChange());
  });

  test("a link removed from ReferencesAndLinks is removed, and removed fails (on006126)", () => {
    for (const after of [
      changed({ ReferencesAndLinks: [] }),
      changed({ ReferencesAndLinks: undefined }),
    ]) {
      const facts = authorFieldFacts(description(DESCRIPTION), after);
      expect(facts).toEqual(noFieldChange({ removed: ["ReferencesAndLinks"] }));
      expect(authorFieldsAltered(facts)).toBe(true);
    }
  });

  test("a Funding typo fixed within the minor bound is minor (on007353)", () => {
    const fixed = DESCRIPTION.Funding[0] as string;
    const typo =
      "This work was suported by the Natinal Institue of Mentl Helth grant R01MH00000 to the lab";
    expect(levenshteinWithin(typo, fixed, 20)).toBe(7);
    const facts = authorFieldFacts(changed({ Funding: [typo] }), description(DESCRIPTION));
    expect(facts).toEqual(noFieldChange({ minor: ["Funding"] }));
    expect(authorFieldsAltered(facts)).toBe(false);
    // The same fix as a lone string is minor too, and a rewritten sentence is not.
    expect(authorFieldFacts(changed({ Funding: typo }), changed({ Funding: fixed })).minor).toEqual(
      ["Funding"],
    );
    expect(
      authorFieldFacts(
        description(DESCRIPTION),
        changed({ Funding: ["Funded by a private donor."] }),
      ).altered,
    ).toEqual(["Funding"]);
  });

  test("License changed by one character fails: it takes no minor edit", () => {
    const facts = authorFieldFacts(description(DESCRIPTION), changed({ License: "CC-BY-4.1" }));
    expect(facts).toEqual(noFieldChange({ altered: ["License"] }));
    expect(authorFieldsAltered(facts)).toBe(true);
  });

  test("an author appended is grown; reordered, inserted in the middle or respelled is altered", () => {
    const [ada, alan, grace] = DESCRIPTION.Authors as [string, string, string];
    const appended = authorFieldFacts(
      description(DESCRIPTION),
      changed({ Authors: [ada, alan, grace, "Katherine Johnson"] }),
    );
    expect(appended).toEqual(noFieldChange({ grown: ["Authors"] }));
    expect(authorFieldsAltered(appended)).toBe(false);
    for (const authors of [
      [alan, ada, grace],
      [ada, "Katherine Johnson", alan, grace],
      ["Katherine Johnson", ada, alan, grace],
      [ada, alan, "Grace B. Hopper"],
      [ada, alan],
    ]) {
      const facts = authorFieldFacts(description(DESCRIPTION), changed({ Authors: authors }));
      expect(facts, JSON.stringify(authors)).toEqual(noFieldChange({ altered: ["Authors"] }));
    }
  });

  test("missing elements are dropped before an array is compared", () => {
    const [ada, alan, grace] = DESCRIPTION.Authors as [string, string, string];
    expect(
      authorFieldFacts(
        description(DESCRIPTION),
        changed({ Authors: [ada, "", alan, "n/a", grace] }),
      ),
    ).toEqual(noFieldChange());
    expect(
      authorFieldFacts(
        changed({ Authors: ["", ada, alan, grace] }),
        changed({ Authors: [ada, alan, grace, "Katherine Johnson"] }),
      ),
    ).toEqual(noFieldChange({ grown: ["Authors"] }));
  });

  test("an array grown and with an element minor-edited is both, in a minor-edit key", () => {
    const fixed = DESCRIPTION.Funding[0] as string;
    const facts = authorFieldFacts(
      changed({ Funding: [fixed.replace("supported", "suported")] }),
      changed({ Funding: [fixed, "A second grant."] }),
    );
    expect(facts).toEqual(noFieldChange({ minor: ["Funding"], grown: ["Funding"] }));
  });

  test("a lone string is a one-element array beside an array, and nothing else is", () => {
    expect(
      authorFieldFacts(
        changed({ Authors: "Ada Lovelace" }),
        changed({ Authors: ["Ada Lovelace"] }),
      ),
    ).toEqual(noFieldChange());
    expect(
      authorFieldFacts(
        changed({ Authors: "Ada Lovelace" }),
        changed({ Authors: ["Ada Lovelace", "Alan Turing"] }),
      ),
    ).toEqual(noFieldChange({ grown: ["Authors"] }));
    expect(
      authorFieldFacts(changed({ Funding: "Grant 1" }), changed({ Funding: { grant: "Grant 1" } })),
    ).toEqual(noFieldChange({ altered: ["Funding"] }));
    expect(authorFieldFacts(changed({ Name: "Study" }), changed({ Name: 7 }))).toEqual(
      noFieldChange({ altered: ["Name"] }),
    );
  });

  test("a key added where there was none, or a missing value replaced, is added", () => {
    const facts = authorFieldFacts(
      changed({ HowToAcknowledge: "" }),
      changed({ HowToAcknowledge: "Please cite the paper.", EthicsApprovals: ["IRB 2020-01"] }),
    );
    expect(facts).toEqual(noFieldChange({ added: ["HowToAcknowledge", "EthicsApprovals"] }));
    expect(authorFieldsAltered(facts)).toBe(false);
  });

  test("Name and DatasetDOI changed are altered; tool-managed keys and nested names are not looked at", () => {
    expect(
      authorFieldFacts(
        description(DESCRIPTION),
        changed({
          Name: "Visual oddball EEG (revised)",
          DatasetDOI: "doi:10.18112/openneuro.ds000000.v1.0.1",
        }),
      ),
    ).toEqual(noFieldChange({ altered: ["Name", "DatasetDOI"] }));
    expect(
      authorFieldFacts(
        description(DESCRIPTION),
        changed({
          BIDSVersion: "1.9.0",
          GeneratedBy: [{ Name: "another tool" }],
          DatasetType: "derivative",
        }),
      ),
    ).toEqual(noFieldChange());
  });

  test("key order and whitespace are no change, and the lists follow the closed order", () => {
    const reversed = Object.fromEntries(Object.entries(DESCRIPTION).reverse());
    expect(
      authorFieldFacts(description(DESCRIPTION), encoder.encode(JSON.stringify(reversed))),
    ).toEqual(noFieldChange());
    const facts = authorFieldFacts(
      description(DESCRIPTION),
      description({ ...reversed, License: "CC0", Name: "Other" }),
    );
    expect(facts.altered).toEqual(["Name", "License"]);
  });

  test("a description added is every value added; one deleted is every value removed", () => {
    expect(authorFieldFacts("absent", description(DESCRIPTION))).toEqual(
      noFieldChange({
        added: ["Name", "Authors", "License", "ReferencesAndLinks", "Funding", "DatasetDOI"],
      }),
    );
    const deleted = authorFieldFacts(description(DESCRIPTION), "absent");
    expect(deleted).toEqual(
      noFieldChange({
        removed: ["Name", "Authors", "License", "ReferencesAndLinks", "Funding", "DatasetDOI"],
      }),
    );
    expect(authorFieldsAltered(deleted)).toBe(true);
    expect(authorFieldFacts("absent", "absent")).toEqual(noFieldChange());
  });

  test("a side that cannot be read, does not parse or is not an object is unparsed, never clean", () => {
    const unparsed = noFieldChange({ unparsed: true });
    for (const [label, bad] of [
      ["unreadable", "unreadable"],
      ["trailing comma", encoder.encode('{"Name": "x",}')],
      ["duplicate key", encoder.encode('{"License": "CC0", "License": "CC-BY-4.0"}')],
      ["not UTF-8", new Uint8Array([0x7b, 0x22, 0xe9, 0x22, 0x3a, 0x31, 0x7d])],
      ["array root", encoder.encode('["Name"]')],
      ["string root", encoder.encode('"Name"')],
    ] as [string, DescriptionSide][]) {
      expect(authorFieldFacts(description(DESCRIPTION), bad), label).toEqual(unparsed);
      expect(authorFieldFacts(bad, description(DESCRIPTION)), label).toEqual(unparsed);
    }
    // Unknown is not an alteration here: the caller says what unknown does.
    expect(authorFieldsAltered(unparsed)).toBe(false);
  });
});
