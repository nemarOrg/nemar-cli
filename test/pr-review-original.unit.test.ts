/**
 * The pure half of Part B (design `.context/plans/pr-review-change-summary.md`, sections B1 to B7):
 * what a pull request changed of the README, CHANGES and author fields the original authors
 * published. Bytes and strings in, counts and closed words out; nothing here touches git or a file.
 * Every part's blob id is the real git id of its bytes, so a test that says two parts are one blob
 * means it.
 */

import { describe, expect, test } from "bun:test";
import {
  type AlignOp,
  type DocumentPart,
  ORIGINAL_LIMITS,
  PROSE_REFUSALS,
  type ProseDocument,
  type ProseRead,
  alignLines,
  assembleDocument,
  decodeProse,
  isDocumentName,
  isMinorEdit,
  levenshteinWithin,
  minorBound,
  normalizeProse,
} from "../scripts/ci/pr-review-original";

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
