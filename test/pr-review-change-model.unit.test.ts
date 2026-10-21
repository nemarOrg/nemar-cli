/**
 * The change model of the mechanical change summary (design `.context/plans/pr-review-change-summary.md`
 * sections 4, 6.2 and 12): the vocabulary of a change, the relabel rules, the relocation pools, and the
 * table and JSON diffs. Pure: real bytes go through the real `parseTsv` and `parseJson`, and nothing
 * here touches git or a file.
 *
 * The bar for this module is that a diff is TOTAL (every row, column and leaf lands in exactly one
 * bucket) and that every doubtful pairing fails toward more visible change or a loss fact, never
 * toward hiding content. The tests are written against that bar: they pin what each rule accepts,
 * and, as importantly, what it must not.
 */

import { describe, expect, test } from "bun:test";
import {
  type Atom,
  CLASS_KINDS,
  type ClassKind,
  type FileDiff,
  type JsonCounts,
  type PoolFile,
  ROLE_OF,
  type RelabelRule,
  type Table,
  type TableCounts,
  buildPools,
  diffJson,
  diffJsonWith,
  diffTable,
  diffTableWith,
  flattenJson,
  formatAtoms,
  isMissingCell,
  isMissingJson,
  leafKey,
  parseJson,
  parseTsv,
  relabelRule,
  ruleWords,
  sidecarApplies,
  verifyJsonCounts,
  verifyTableCounts,
} from "../scripts/ci/pr-review-summary";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A parsed JSON value, for the truth tables of `isMissingJson`. */
function json(text: string) {
  const parsed = parseJson(enc(text));
  if (!parsed.ok) throw new Error(`test input is not JSON (${parsed.refusal}): ${text}`);
  return parsed.value.value;
}

describe("the vocabulary of a change", () => {
  test("the kinds are the table of design section 4.1, in table order, each once", () => {
    expect([...CLASS_KINDS]).toEqual([
      "column_removed",
      "row_removed",
      "json_key_removed",
      "row_relocated",
      "json_key_moved",
      "key_relabeled",
      "cell_templated",
      "cell_replaced",
      "cell_emptied",
      "json_value_changed",
      "json_type_changed",
      "json_emptied",
      "json_key_renamed",
      "json_empty_key_removed",
      "rows_reordered",
      "columns_reordered",
      "json_keys_reordered",
      "format",
      "column_added",
      "row_added",
      "cell_filled",
      "json_key_added",
      "json_filled",
    ]);
    expect(new Set(CLASS_KINDS).size).toBe(CLASS_KINDS.length);
    for (const kind of CLASS_KINDS) expect(kind).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  test("every kind has a role, and the roles are the design's", () => {
    const roles = new Set(["loss", "relocated", "modification", "additive"]);
    for (const kind of CLASS_KINDS) expect(roles.has(ROLE_OF[kind]), kind).toBe(true);
    // The record has no key that is not a kind either.
    expect(Object.keys(ROLE_OF).sort()).toEqual([...CLASS_KINDS].sort());

    const byRole = (role: string): ClassKind[] => CLASS_KINDS.filter((k) => ROLE_OF[k] === role);
    expect(byRole("loss")).toEqual(["column_removed", "row_removed", "json_key_removed"]);
    expect(byRole("relocated")).toEqual(["row_relocated", "json_key_moved"]);
    expect(byRole("additive")).toEqual([
      "column_added",
      "row_added",
      "cell_filled",
      "json_key_added",
      "json_filled",
    ]);
    // Everything else is a modification, including the removal of a key that held nothing.
    expect(byRole("modification")).toEqual([
      "key_relabeled",
      "cell_templated",
      "cell_replaced",
      "cell_emptied",
      "json_value_changed",
      "json_type_changed",
      "json_emptied",
      "json_key_renamed",
      "json_empty_key_removed",
      "rows_reordered",
      "columns_reordered",
      "json_keys_reordered",
      "format",
    ]);
  });
});

describe("isMissingCell and isMissingJson are deliberately narrow", () => {
  test("a table cell is missing exactly when it is empty or n/a", () => {
    expect(isMissingCell("")).toBe(true);
    expect(isMissingCell("n/a")).toBe(true);
    for (const present of [
      "N/A",
      "NA",
      "na",
      "None",
      "none",
      "unknown",
      "null",
      "nan",
      "0",
      " ",
      "n/a ",
      " n/a",
      "-",
      "n/a\u{200B}",
    ]) {
      expect(isMissingCell(present), JSON.stringify(present)).toBe(false);
    }
  });

  test("a JSON value is missing exactly when it is null, an empty string, n/a, [] or {}, or an array of those", () => {
    for (const missing of [
      "null",
      '""',
      '"n/a"',
      "[]",
      "{}",
      "[null]",
      '[""]',
      '["n/a"]',
      "[[]]",
      "[{}]",
      '[null, "", "n/a", [], {}]',
      '[["n/a"], [null, [""]]]',
    ]) {
      expect(isMissingJson(json(missing)), missing).toBe(true);
    }
    for (const present of [
      "0",
      "false",
      "true",
      '"None"',
      '"unknown"',
      '"NA"',
      '"N/A"',
      '" "',
      '"n/a "',
      '{"a": null}',
      '{"a": ""}',
      '[null, "x"]',
      '["n/a", 0]',
      "[false]",
      '[[], "x"]',
      "[0]",
      "-0",
      "0.0",
    ]) {
      expect(isMissingJson(json(present)), present).toBe(false);
    }
  });

  test("a JSON array's missing-ness is decided by every element, however deep", () => {
    expect(isMissingJson(json("[[[[[[]]]]]]"))).toBe(true);
    expect(isMissingJson(json('[[[[[["x"]]]]]]'))).toBe(false);
  });
});

/** A rule with the fields spelled out, so an expectation reads as the rule it is. */
function rule(
  kind: RelabelRule["kind"],
  gaps: readonly string[] = [],
  shape = "",
  repadded = false,
): RelabelRule {
  return { kind, gaps, shape, repadded };
}

describe("relabelRule: one assertion per rule kind", () => {
  const cells = { chars: false };

  test("case: equal once lower-cased", () => {
    expect(relabelRule("Cz", "CZ", cells)).toEqual(rule("case"));
    expect(relabelRule("fp1", "FP1", cells)).toEqual(rule("case"));
    expect(relabelRule("Left Arm", "left arm", cells)).toEqual(rule("case"));
    // Case wins even where a run rule would also hold.
    expect(relabelRule("A_b", "a_B", cells)).toEqual(rule("case"));
  });

  test("repad: only the zero padding of a number changed", () => {
    expect(relabelRule("A01", "A1", cells)).toEqual(rule("repad", [], "", true));
    expect(relabelRule("A1", "A001", cells)).toEqual(rule("repad", [], "", true));
    expect(relabelRule("sub-001_ses-02", "sub-1_ses-2", cells)).toEqual(
      rule("repad", [], "", true),
    );
  });

  test("wrap: text was added before or after the value", () => {
    expect(relabelRule("Fp1", "EEG Fp1-Ref", cells)).toEqual(rule("wrap", ["EEG ", "-Ref"]));
    expect(relabelRule("Fz", "EEG Fz", cells)).toEqual(rule("wrap", ["EEG ", ""]));
    expect(relabelRule("Fz", "Fz-Ref", cells)).toEqual(rule("wrap", ["", "-Ref"]));
  });

  test("strip: text was removed from around the value", () => {
    expect(relabelRule("EEG Fp1-Ref", "Fp1", cells)).toEqual(rule("strip", ["EEG ", "-Ref"]));
    expect(relabelRule("EEG Fz", "Fz", cells)).toEqual(rule("strip", ["EEG ", ""]));
  });

  test("insert: text was added between the parts of the value", () => {
    expect(relabelRule("GA01", "EEGGA_01REF", cells)).toEqual(
      rule("insert", ["EEG", "_", "REF"], "LD"),
    );
    expect(relabelRule("a-1", "a-X-1", cells)).toEqual(rule("insert", ["", "", "X-", ""], "LOD"));
  });

  test("delete: text was removed from between the parts of the value", () => {
    expect(relabelRule("EEGGA_01REF", "GA01", cells)).toEqual(
      rule("delete", ["EEG", "_", "REF"], "LD"),
    );
    expect(relabelRule("a-X-1", "a-1", cells)).toEqual(rule("delete", ["", "", "X-", ""], "LOD"));
  });

  test("an insertion or a deletion is anchored: the name with fewer runs must hold a digit run", () => {
    // Letters alone are no anchor: Cz is in FCz and Pz in POz, and each is another electrode.
    for (const [a, b] of [
      ["Cz", "FCz"],
      ["Pz", "POz"],
      ["a-b", "a-X-b"],
      ["Fp", "F-x-p"],
    ] as const) {
      expect(relabelRule(a, b, cells), `${a} -> ${b}`).toBeNull();
      expect(relabelRule(b, a, cells), `${b} -> ${a}`).toBeNull();
    }
    // A superscript two is a number character, so it anchors, though it is compared as its text.
    expect(relabelRule("x\u{B2}", "EEGx_\u{B2}REF", cells)).toEqual(
      rule("insert", ["EEG", "_", "REF"], "LD"),
    );
    // The anchor matches only a whole digit run of the same value.
    expect(relabelRule("GA01", "EEGGA_02REF", cells)).toBeNull();
    expect(relabelRule("GA1", "EEGGA_12REF", cells)).toBeNull();
    // The anchor still works when the digit run is repadded, and the rule says so.
    const repadded = relabelRule("GA01", "EEGGA_1REF", cells);
    expect(repadded).toEqual(rule("insert", ["EEG", "_", "REF"], "LD", true));
    expect(ruleWords(repadded as RelabelRule)).toBe(
      'inserted "EEG" at the start, "_" after run 1 and "REF" after run 2 (runs kept: letters, digits), zero padding of numbers changed',
    );
  });

  test("a letter run is matched where a run of the other name starts and ends, if it can be", () => {
    // ab is inside abx and also whole after the hyphen; the whole one is the one the rule keeps.
    expect(relabelRule("ab1c", "abx-ab_1c", cells)).toEqual(
      rule("insert", ["abx-", "_", "", ""], "LDL"),
    );
    // Only a start on a boundary is not enough: the end must be one too.
    expect(relabelRule("ab1c", "xab-ab_1c", cells)).toEqual(
      rule("insert", ["xab-", "_", "", ""], "LDL"),
    );
  });

  test("the character rule exists only when asked for, and then describes the longer string exactly", () => {
    expect(relabelRule("DCEMBRACE", "DC EMBRACE-REF", cells)).toBeNull();
    expect(relabelRule("DCEMBRACE", "DCEMBRACE-REF", { chars: true })).toEqual(
      rule("wrap", ["", "-REF"]),
    );
    expect(relabelRule("DCEMBRACE", "DC EMBRACE-REF", { chars: true })).toEqual(
      rule("insert", ["", "", " ", "", "", "", "", "", "", "-REF"], "c9"),
    );
    expect(relabelRule("DC EMBRACE-REF", "DCEMBRACE", { chars: true })).toEqual(
      rule("delete", ["", "", " ", "", "", "", "", "", "", "-REF"], "c9"),
    );
  });

  test("the run rules come before the character rule: asking for characters never changes a run answer", () => {
    for (const [a, b] of [
      ["Cz", "CZ"],
      ["A01", "A1"],
      ["Fp1", "EEG Fp1-Ref"],
      ["EEG Fz", "Fz"],
      ["GA01", "EEGGA_01REF"],
    ] as const) {
      expect(relabelRule(a, b, { chars: true }), `${a} -> ${b}`).toEqual(
        relabelRule(a, b, { chars: false }),
      );
    }
  });
});

describe("relabelRule: the real pairs from the open pull requests", () => {
  const cells = { chars: false };

  test("A1 becomes POL A01: a prefix, and the number kept its value but gained a zero", () => {
    expect(relabelRule("A1", "POL A01", cells)).toEqual(rule("wrap", ["POL ", ""], "", true));
  });

  test("GA01 becomes EEGGA_01REF: letters and digits kept in order, text added around and between", () => {
    expect(relabelRule("GA01", "EEGGA_01REF", cells)).toEqual(
      rule("insert", ["EEG", "_", "REF"], "LD"),
    );
  });

  test("DCEMBRACE becomes DC EMBRACE-REF only by characters", () => {
    expect(relabelRule("DCEMBRACE", "DC EMBRACE-REF", cells)).toBeNull();
    const byCharacters = relabelRule("DCEMBRACE", "DC EMBRACE-REF", { chars: true });
    expect(byCharacters?.kind).toBe("insert");
    expect(byCharacters?.shape).toBe("c9");
  });

  test("a name quoted and padded with spaces loses the padding: a strip of four spaces", () => {
    expect(relabelRule("'G1'    ", "'G1'", cells)).toEqual(rule("strip", ["", "    "]));
    expect(relabelRule("'G1'", "'G1'    ", cells)).toEqual(rule("wrap", ["", "    "]));
  });

  test("64 becomes 640 and A1 becomes A10: a changed number is not a rule", () => {
    // Both sides are plain numbers.
    expect(relabelRule("64", "640", { chars: false })).toBeNull();
    expect(relabelRule("64", "640", { chars: true })).toBeNull();
    // 1 is not 10, so no run rule holds; and the 0 would join the run 1, so no character rule.
    for (const chars of [false, true]) {
      expect(relabelRule("A1", "A10", { chars })).toBeNull();
      expect(relabelRule("A10", "A1", { chars })).toBeNull();
    }
  });

  test("the character rule inserts or deletes whole runs only: a name that changed a run is another name", () => {
    for (const [a, b] of [
      ["A1", "A10"],
      ["sub-2", "sub-12"],
      ["sub-1", "sub-10"],
      ["Cz", "FCz"],
      ["Pz", "POz"],
      ["Fp1", "Fpz1"],
    ] as const) {
      expect(relabelRule(a, b, { chars: true }), `${a} -> ${b}`).toBeNull();
      expect(relabelRule(b, a, { chars: true }), `${b} -> ${a}`).toBeNull();
    }
    // The real one keeps: a space and -REF are whole runs of the new name, in both directions.
    expect(relabelRule("DC EMBRACE-REF", "DCEMBRACE", { chars: true })?.shape).toBe("c9");
    // A run inserted between two others, even in the middle of letters, is whole.
    expect(relabelRule("AB", "A-B", { chars: true })).toEqual(rule("insert", ["", "-", ""], "c2"));
  });
});

describe("relabelRule: numbers and nothing-to-say pairs never get a rule", () => {
  test("a pair of plain numbers has no rule, whatever the numbers look like", () => {
    for (const [a, b] of [
      ["64", "640"],
      ["1", "01"],
      ["01", "1"],
      ["1.5", "1.50"],
      ["-1", "1"],
      ["+1", "1"],
      [".5", "0.5"],
      ["1e5", "1E5"],
      ["1e5", "10e4"],
      ["100", "1000"],
      ["3.", "3"],
    ] as const) {
      expect(relabelRule(a, b, { chars: false }), `${a} -> ${b}`).toBeNull();
      expect(relabelRule(a, b, { chars: true }), `${a} -> ${b}`).toBeNull();
    }
  });

  test("one number and one word is not a numeric pair", () => {
    // 5 against five: neither a case nor a run rule; with characters, 5 is not a subsequence of five.
    expect(relabelRule("5", "five", { chars: true })).toBeNull();
    // A number with a unit around it is a wrap, not a changed number.
    expect(relabelRule("5", "5 mm", { chars: false })).toEqual(rule("wrap", ["", " mm"]));
  });

  test("equal strings, empty strings and a pair with nothing in common have no rule", () => {
    expect(relabelRule("A", "A", { chars: true })).toBeNull();
    expect(relabelRule("", "A", { chars: true })).toBeNull();
    expect(relabelRule("A", "", { chars: true })).toBeNull();
    expect(relabelRule("", "", { chars: true })).toBeNull();
    expect(relabelRule("Cz", "Pz", { chars: true })).toBeNull();
    expect(relabelRule("left", "right", { chars: false })).toBeNull();
  });

  test("a value that changed a letter is not a prefix, a case change or a padding", () => {
    expect(relabelRule("A1", "B1", { chars: true })).toBeNull();
    expect(relabelRule("good", "bad", { chars: true })).toBeNull();
    expect(relabelRule("Fp1", "Fp2", { chars: true })).toBeNull();
  });

  test("digits next to a decimal point or comma compare as text: 0.05 to 0.5 is not a padding", () => {
    for (const [a, b] of [
      ["A1.05", "A1.5"],
      ["0.05 Hz", "0.5 Hz"],
      ["1.05mV", "1.5mV"],
      ["v1,05", "v1,5"],
      ["05.A", "5.A"],
      ["2020-01-01T10:00:00.050", "2020-01-01T10:00:00.5"],
    ] as const) {
      expect(relabelRule(a, b, { chars: false }), `${a} -> ${b}`).toBeNull();
      expect(relabelRule(b, a, { chars: false }), `${b} -> ${a}`).toBeNull();
    }
    // Any other neighbor leaves the value comparison in place.
    expect(relabelRule("A01-x", "A1-x", { chars: false })).toEqual(rule("repad", [], "", true));
    expect(relabelRule("A01 Hz", "A1 Hz", { chars: false })).toEqual(rule("repad", [], "", true));
  });

  test("digits compare by value only as ASCII digits: a superscript is the text it is", () => {
    // The superscript two is a number character but has no value this module vouches for.
    expect(relabelRule("A\u{B2}", "POL A\u{B2}", { chars: false })).toEqual(
      rule("wrap", ["POL ", ""]),
    );
    expect(relabelRule("A\u{B2}", "A2", { chars: false })).toBeNull();
    // Arabic-Indic digits are compared as text, so they do not repad against ASCII ones, and an
    // ASCII zero in front of one is not padding either.
    expect(relabelRule("A\u{661}", "A01", { chars: false })).toBeNull();
    expect(relabelRule("A00\u{661}", "A0\u{661}", { chars: false })).toBeNull();
  });
});

describe("relabelRule: the bounds", () => {
  test("a string over 128 characters or over 24 runs gets no rule of any kind", () => {
    const long = "A".repeat(129);
    expect(relabelRule(long, `${long}x`, { chars: true })).toBeNull();
    expect(relabelRule(long, long.toLowerCase(), { chars: true })).toBeNull();
    // Exactly at the limit is still a name.
    const edge = "A".repeat(128);
    expect(relabelRule(edge, edge.toLowerCase(), { chars: false })).toEqual(rule("case"));
    expect(relabelRule(edge, `${edge.slice(0, 120)}-xyz`, { chars: false })).toBeNull();

    // Letters and hyphens alternate, so n characters are n runs. 24 runs is the most a name may have.
    const runs = (n: number): string =>
      Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "a" : "-")).join("");
    expect(relabelRule(runs(23), `${runs(23)}-`, { chars: false })).toEqual(
      rule("wrap", ["", "-"]),
    );
    expect(relabelRule(runs(24), `${runs(24)}a`, { chars: false })).toBeNull();
    expect(relabelRule(runs(24), `${runs(24)}a`, { chars: true })).toBeNull();
    expect(relabelRule(runs(25), runs(25).toUpperCase(), { chars: true })).toEqual(rule("case"));
  });

  test("astral characters count as one character each, and no cut splits a pair", () => {
    // U+10400 is a letter outside the basic plane: 100 of them are one run of 100 characters that
    // take 200 UTF-16 units, so a length check in units alone would refuse a name that is allowed.
    const wide = "\u{10400}".repeat(100);
    expect(relabelRule(wide, `${wide}!`, { chars: false })).toEqual(rule("wrap", ["", "!"]));
    // 129 characters in only 158 units: still over the limit, however it is counted.
    const mixed = `${"a".repeat(100)}${"\u{10400}".repeat(29)}`;
    expect(mixed.length).toBeLessThan(2 * 128 + 1);
    expect(relabelRule(mixed, `${mixed}!`, { chars: false })).toBeNull();
    expect(relabelRule(mixed, `${mixed}!`, { chars: true })).toBeNull();
  });

  test("the length bound is checked on each side alone", () => {
    const edge = "A".repeat(128);
    // Within the bound these are a strip and a wrap.
    expect(relabelRule(`x-${edge.slice(2)}`, edge.slice(2), { chars: false })?.kind).toBe("strip");
    expect(relabelRule(edge.slice(2), `x-${edge.slice(2)}`, { chars: false })?.kind).toBe("wrap");
    // One character more on either side, and neither.
    expect(relabelRule(`x-${edge}`, edge, { chars: true })).toBeNull();
    expect(relabelRule(edge, `x-${edge}`, { chars: true })).toBeNull();
    // Lower-casing can change a length: U+0130 lower-cases to i and a combining dot. These two are
    // a case change of each other, but one of them is 129 characters, so it is not a name.
    const dotted = `\u{130}${"a".repeat(127)}`;
    const decomposed = `i\u{307}${"a".repeat(127)}`;
    expect(dotted.toLowerCase()).toBe(decomposed.toLowerCase());
    expect(relabelRule(decomposed, dotted, { chars: false })).toBeNull();
    expect(relabelRule(dotted, decomposed, { chars: false })).toBeNull();
    // At 128 characters the decomposed one is a name again, and the pair is a case change.
    expect(relabelRule(dotted.slice(0, -1), decomposed.slice(0, -1), { chars: false })).toEqual(
      rule("case"),
    );
  });
});

describe("ruleWords", () => {
  test("each kind reads as plain English, with the gap strings exactly as they are", () => {
    expect(ruleWords(rule("case"))).toBe("letter case changed");
    expect(ruleWords(rule("repad", [], "", true))).toBe("zero padding of numbers changed");
    expect(ruleWords(rule("wrap", ["POL ", ""], "", true))).toBe(
      'added prefix "POL ", zero padding of numbers changed',
    );
    expect(ruleWords(rule("wrap", ["EEG ", "-Ref"]))).toBe('added prefix "EEG " and suffix "-Ref"');
    expect(ruleWords(rule("wrap", ["", "-Ref"]))).toBe('added suffix "-Ref"');
    expect(ruleWords(rule("strip", ["", "    "]))).toBe('removed suffix "    "');
    expect(ruleWords(rule("strip", ["EEG ", "-Ref"]))).toBe(
      'removed prefix "EEG " and suffix "-Ref"',
    );
    expect(ruleWords(rule("insert", ["EEG", "_", "REF"], "LD"))).toBe(
      'inserted "EEG" at the start, "_" after run 1 and "REF" after run 2 (runs kept: letters, digits)',
    );
    expect(ruleWords(rule("delete", ["EEG", "_", "REF"], "LD"))).toBe(
      'deleted "EEG" at the start, "_" after run 1 and "REF" after run 2 (runs kept: letters, digits)',
    );
    expect(ruleWords(rule("insert", ["", "", " ", "", "", "", "", "", "", "-REF"], "c9"))).toBe(
      'inserted " " after character 2 and "-REF" after character 9 (characters kept: 9)',
    );
    expect(ruleWords(rule("insert", ["", "", "X-", ""], "LOL"))).toBe(
      'inserted "X-" after run 2 (runs kept: letters, a character, letters)',
    );
  });

  test("every rule the relabel function returns has words, and the words are deterministic", () => {
    const pairs: [string, string][] = [
      ["Cz", "CZ"],
      ["A01", "A1"],
      ["Fp1", "EEG Fp1-Ref"],
      ["EEG Fp1-Ref", "Fp1"],
      ["GA01", "EEGGA_01REF"],
      ["EEGGA_01REF", "GA01"],
      ["DCEMBRACE", "DC EMBRACE-REF"],
      ["'G1'    ", "'G1'"],
      ["A1", "POL A01"],
    ];
    for (const [a, b] of pairs) {
      const found = relabelRule(a, b, { chars: true }) as RelabelRule;
      expect(found, `${a} -> ${b}`).not.toBeNull();
      const words = ruleWords(found);
      expect(words.length).toBeGreaterThan(0);
      expect(ruleWords(found)).toBe(words);
    }
  });

  test("two different rules read differently unless they differ only in a text they hold", () => {
    const rules = [
      rule("case"),
      rule("repad", [], "", true),
      rule("wrap", ["a", ""]),
      rule("wrap", ["", "a"]),
      rule("wrap", ["a", "a"]),
      rule("strip", ["a", ""]),
      rule("wrap", ["a", ""], "", true),
      rule("insert", ["a", ""], "L"),
      rule("insert", ["", "a"], "L"),
      rule("delete", ["a", ""], "L"),
      rule("insert", ["a", ""], "D"),
      rule("insert", ["a", ""], "c1"),
      rule("insert", ["", "", "a"], "c2"),
    ];
    const words = rules.map(ruleWords);
    expect(new Set(words).size).toBe(words.length);
  });
});

/** A small seeded generator (mulberry32): the same seed gives the same sequence on every machine. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zero padding removed from every ASCII digit run: what "digits compared by value" means. */
function byValue(s: string): string {
  return s.replace(/[0-9]+/g, (digits) => digits.replace(/^0+(?=[0-9])/, ""));
}

/** The parts of a name, split independently of the module under test. */
function partsOf(s: string): string[] {
  return s.match(/\p{L}+|\p{N}+|[\s\S]/gu) ?? [];
}

/**
 * Whether a rule keeps the anchoring of design section 4.3: an insertion or deletion of runs keeps a
 * digit run of the shorter name, and a character rule inserts or deletes only whole runs of the
 * longer one. Every other kind holds trivially.
 */
function anchored(found: RelabelRule, before: string, after: string): boolean {
  if (found.kind !== "insert" && found.kind !== "delete") return true;
  const kept = found.kind === "insert" ? before : after;
  const whole = found.kind === "insert" ? after : before;
  if (!found.shape.startsWith("c")) return partsOf(kept).some((part) => /^\p{N}/u.test(part));
  const boundaries = new Set<number>([0]);
  let at = 0;
  for (const part of partsOf(whole)) {
    at += Array.from(part).length;
    boundaries.add(at);
  }
  let position = 0;
  for (const [i, gap] of found.gaps.entries()) {
    const width = Array.from(gap).length;
    if (width > 0 && !(boundaries.has(position) && boundaries.has(position + width))) return false;
    position += width + (i < found.gaps.length - 1 ? 1 : 0);
  }
  return true;
}

/**
 * Rebuild the longer string from the shorter one and the rule alone. This is the property that
 * makes a rule an exact description: if the rebuilt text is not the real one, the class line would
 * tell the model something the files do not say.
 */
function rebuilds(found: RelabelRule, before: string, after: string): boolean {
  switch (found.kind) {
    case "case":
      return before.toLowerCase() === after.toLowerCase();
    case "repad":
      return byValue(before) === byValue(after);
    case "wrap":
      return byValue(after) === byValue(`${found.gaps[0]}${before}${found.gaps[1]}`);
    case "strip":
      return byValue(before) === byValue(`${found.gaps[0]}${after}${found.gaps[1]}`);
    case "insert":
    case "delete": {
      const kept = found.kind === "insert" ? before : after;
      const whole = found.kind === "insert" ? after : before;
      const pieces = found.shape.startsWith("c") ? Array.from(kept) : partsOf(kept);
      if (found.gaps.length !== pieces.length + 1) return false;
      if (found.shape.startsWith("c")) {
        if (found.shape !== `c${pieces.length}`) return false;
      } else {
        const classes = pieces.map((p) =>
          /^\p{L}/u.test(p) ? "L" : /^\p{N}/u.test(p) ? "D" : "O",
        );
        if (found.shape !== classes.join("")) return false;
      }
      const interleaved = pieces.map((piece, i) => `${found.gaps[i]}${piece}`).join("");
      return byValue(`${interleaved}${found.gaps[pieces.length]}`) === byValue(whole);
    }
  }
}

describe("relabelRule: every rule it returns rebuilds the other string from one string and the rule", () => {
  test("3,000 generated pairs: a rule is exact, deterministic, never numeric, and never claims equal strings", () => {
    const random = seeded(4303);
    const alphabet = ["a", "B", "c", "Z", "0", "1", "2", "7", "-", "_", " ", "."];
    const word = (): string =>
      Array.from(
        { length: 1 + Math.floor(random() * 7) },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join("");
    const mutate = (s: string): string => {
      switch (Math.floor(random() * 7)) {
        case 0:
          return `${word()}${s}`;
        case 1:
          return `${s}${word()}`;
        case 2: {
          const at = Math.floor(random() * (s.length + 1));
          return `${s.slice(0, at)}${word()}${s.slice(at)}`;
        }
        case 3:
          return s.length > 1 ? s.slice(1 + Math.floor(random() * (s.length - 1))) : s;
        case 4:
          return s.toUpperCase();
        case 5:
          return s.replace(/[0-9]+/g, (d) =>
            random() < 0.5 ? `0${d}` : d.replace(/^0+(?=[0-9])/, ""),
          );
        default:
          return word();
      }
    };

    const kinds = new Set<string>();
    let withRule = 0;
    for (let n = 0; n < 3000; n++) {
      const before = word();
      const after = mutate(before);
      for (const chars of [false, true]) {
        const found = relabelRule(before, after, { chars });
        expect(relabelRule(before, after, { chars }), `${before} -> ${after}`).toEqual(found);
        if (found === null) continue;
        withRule++;
        kinds.add(found.kind);
        expect(before === after, `equal strings ${before}`).toBe(false);
        expect(
          rebuilds(found, before, after),
          `${JSON.stringify([before, after, chars, found])}`,
        ).toBe(true);
        expect(anchored(found, before, after), JSON.stringify([before, after, found])).toBe(true);
        expect(ruleWords(found).length).toBeGreaterThan(0);
        const numeric = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
        expect(numeric.test(before) && numeric.test(after), `${before} -> ${after}`).toBe(false);
        if (!chars) expect(found.shape.startsWith("c")).toBe(false);
      }
    }
    // The generator reaches every kind of rule, so the property is not vacuous.
    expect([...kinds].sort()).toEqual(["case", "delete", "insert", "repad", "strip", "wrap"]);
    expect(withRule).toBeGreaterThan(2000);
  });
});

/** A pool file from text; `before` is null for an added file. */
function pooled(path: string, before: string | null, after: string): PoolFile {
  return { path, before: before === null ? null : enc(before), after: enc(after) };
}

describe("flattenJson: the leaves of a document", () => {
  const leaves = (text: string) =>
    flattenJson(json(text)).map((leaf) => [leaf.path, leaf.value] as const);

  test("objects recurse, scalars are leaves, and a list of scalars is one leaf", () => {
    expect(
      leaves('{"Name": "x", "Count": 3, "Nested": {"a": true, "b": null}, "List": [1, 2]}'),
    ).toEqual([
      [".Name", '"x"'],
      [".Count", "3"],
      [".Nested.a", "true"],
      [".Nested.b", "null"],
      [".List", "[1,2]"],
    ]);
  });

  test("an empty object and an empty array are leaves, and so is a scalar document", () => {
    expect(leaves('{"a": {}, "b": [], "c": [[]], "d": [{}]}')).toEqual([
      [".a", "{}"],
      [".b", "[]"],
      [".c[0]", "[]"],
      [".d[0]", "{}"],
    ]);
    expect(leaves("{}")).toEqual([["", "{}"]]);
    expect(leaves("[]")).toEqual([["", "[]"]]);
    expect(leaves("7")).toEqual([["", "7"]]);
    expect(leaves('"x"')).toEqual([["", '"x"']]);
  });

  test("an array with any container element recurses with index paths, scalars included", () => {
    expect(leaves('{"a": [1, {"b": 2}, "c"]}')).toEqual([
      [".a[0]", "1"],
      [".a[1].b", "2"],
      [".a[2]", '"c"'],
    ]);
    expect(leaves("[[1, 2], [3]]")).toEqual([
      ["[0]", "[1,2]"],
      ["[1]", "[3]"],
    ]);
  });

  test("a key that is not a bare name is written in brackets, JSON escaped, so no two places share a path", () => {
    const text = String.raw`{"a.b": 1, "a": {"b": 2}, "x y": 3, "1": 4, "q\"r": 5, "": 6, "caf\u00e9": 7}`;
    const found = leaves(text);
    expect(found.map(([path]) => path)).toEqual([
      '["a.b"]',
      ".a.b",
      '["x y"]',
      '["1"]',
      '["q\\"r"]',
      '[""]',
      '["caf\u{E9}"]',
    ]);
    expect(new Set(found.map(([path]) => path)).size).toBe(found.length);
    // A key "0" is not the index 0.
    expect(leaves('{"a": {"0": 1}}')).toEqual([['.a["0"]', "1"]]);
    expect(leaves('{"a": [1, {"k": 1}]}')).toEqual([
      [".a[0]", "1"],
      [".a[1].k", "1"],
    ]);
  });

  test("a leaf knows its parent, its name and whether it is a key", () => {
    const found = flattenJson(json('{"a": {"b": 1}, "c": [{"d": 2}, 3]}'));
    expect(found.map((l) => [l.path, l.parent, l.name, l.isKey])).toEqual([
      [".a.b", ".a", "b", true],
      [".c[0].d", ".c[0]", "d", true],
      [".c[1]", ".c", "[1]", false],
    ]);
  });

  test("values are canonical text: numbers as written, strings re-encoded, key order kept", () => {
    expect(leaves('{"n": 1.0, "m": 1, "s": "\u0041", "e": 1e400, "z": -0}')).toEqual([
      [".n", "1.0"],
      [".m", "1"],
      [".s", '"A"'],
      [".e", "1e400"],
      [".z", "-0"],
    ]);
  });
});

describe("buildPools: the rows and leaves a pull request adds", () => {
  const rowsOf = (pool: ReturnType<typeof buildPools>, path: string) => {
    const file = pool.rows.files.get(path);
    return file === undefined
      ? undefined
      : { header: file.header, rows: Object.fromEntries(file.rows) };
  };

  test("an added table contributes every row, with how many copies, under its own header", () => {
    const pool = buildPools([
      pooled("sourcedata/old/a_channels.tsv", null, "name\ttype\nA1\tEEG\nA2\tEEG\nA1\tEEG\n"),
    ]);
    expect(rowsOf(pool, "sourcedata/old/a_channels.tsv")).toEqual({
      header: "name\ttype",
      rows: { "A1\tEEG": 2, "A2\tEEG": 1 },
    });
  });

  test("a modified table with the same header contributes the multiset difference only", () => {
    const pool = buildPools([
      pooled(
        "x_channels.tsv",
        "name\ttype\nA1\tEEG\nA2\tEEG\nA2\tEEG\n",
        "name\ttype\nA2\tEEG\nA2\tEEG\nA2\tEEG\nA3\tEMG\nA3\tEMG\n",
      ),
    ]);
    // Before had A2 twice; after has it three times, so one copy is new, and A3 twice is new.
    expect(rowsOf(pool, "x_channels.tsv")).toEqual({
      header: "name\ttype",
      rows: { "A2\tEEG": 1, "A3\tEMG": 2 },
    });
  });

  test("a modified table with a different header contributes every row of its after side", () => {
    const pool = buildPools([
      pooled("x_channels.tsv", "name\ttype\nA1\tEEG\n", "type\tname\nEEG\tA1\nEMG\tA2\n"),
    ]);
    expect(rowsOf(pool, "x_channels.tsv")).toEqual({
      header: "type\tname",
      rows: { "EEG\tA1": 1, "EMG\tA2": 1 },
    });
    // The same columns in another order are a different header, so a row that is unchanged still counts.
    expect(rowsOf(buildPools([pooled("y.tsv", "a\tb\n1\t2\n", "b\ta\n2\t1\n")]), "y.tsv")).toEqual({
      header: "b\ta",
      rows: { "2\t1": 1 },
    });
  });

  test("a table that adds nothing is not in the pool, and neither is one that only lost rows", () => {
    const pool = buildPools([
      pooled("same.tsv", "a\n1\n", "a\n1\n"),
      pooled("lost.tsv", "a\tb\n1\t2\n3\t4\n", "a\tb\n1\t2\n"),
      pooled("header_only.tsv", null, "a\tb\n"),
    ]);
    expect([...pool.rows.files.keys()]).toEqual([]);
  });

  test("tables anywhere in the tree are pooled, and sourcedata ones are indexed by their last segment", () => {
    const pool = buildPools([
      pooled("sub-01/eeg/sub-01_channels.tsv", null, "name\nA1\n"),
      pooled("sourcedata/removed/sub-01/eeg/sub-01_channels.tsv", null, "name\nA1\n"),
      pooled("sourcedata/other/sub-02_channels.tsv", null, "name\nA2\n"),
      pooled("derivatives/x/sub-01_channels.tsv", null, "name\nA3\n"),
      pooled("notsourcedata/sub-01_channels.tsv", null, "name\nA4\n"),
    ]);
    expect([...pool.rows.files.keys()]).toEqual([
      "sub-01/eeg/sub-01_channels.tsv",
      "sourcedata/removed/sub-01/eeg/sub-01_channels.tsv",
      "sourcedata/other/sub-02_channels.tsv",
      "derivatives/x/sub-01_channels.tsv",
      "notsourcedata/sub-01_channels.tsv",
    ]);
    expect(Object.fromEntries(pool.rows.sourcedataByName)).toEqual({
      "sub-01_channels.tsv": ["sourcedata/removed/sub-01/eeg/sub-01_channels.tsv"],
      "sub-02_channels.tsv": ["sourcedata/other/sub-02_channels.tsv"],
    });
  });

  test("files with other extensions are ignored, including a gzipped table", () => {
    const pool = buildPools([
      pooled("a.tsv.gz", null, "x\n1\n"),
      pooled("README.md", null, "x\n1\n"),
      pooled("a.TSV", null, "x\n1\n"),
      pooled("a.csv", null, "x\n1\n"),
    ]);
    expect(pool.rows.files.size).toBe(0);
    expect(pool.json.files.size).toBe(0);
  });

  test("a pool file that does not parse is SKIPPED, on either side, and never an error", () => {
    const ragged = "a\tb\n1\n";
    const bad = new Uint8Array([0x61, 0x09, 0x62, 0x0a, 0xff, 0x09, 0x31, 0x0a]);
    const files: PoolFile[] = [
      pooled("ragged_after.tsv", null, ragged),
      pooled("ragged_before.tsv", ragged, "a\tb\n1\t2\n"),
      { path: "binary_after.tsv", before: null, after: bad },
      { path: "binary_before.tsv", before: bad, after: enc("a\tb\n1\t2\n") },
      pooled("quoted.tsv", null, 'a\n"x"\n'),
      pooled("dup_key.json", null, '{"a": 1, "a": 2}'),
      pooled("bad_json_before.json", "{", '{"a": 1}'),
      pooled("bad_json_after.json", '{"a": 1}', "{"),
      pooled("not_json.json", null, "NaN"),
      pooled("good.tsv", null, "a\tb\n1\t2\n"),
      pooled("good.json", null, '{"a": 1}'),
    ];
    const pool = buildPools(files);
    expect([...pool.rows.files.keys()]).toEqual(["good.tsv"]);
    expect([...pool.json.files.keys()]).toEqual(["good.json"]);
  });

  test("a JSON file contributes the leaves it has now and did not have, by path and value", () => {
    const pool = buildPools([
      pooled(
        "task-rest_eeg.json",
        '{"A": 1, "B": "x", "C": {"d": 1, "e": 2}, "L": [1, 2]}',
        '{"A": 1, "B": "y", "C": {"d": 1, "f": 3}, "L": [1, 2, 3], "N": null}',
      ),
      pooled("added.json", null, '{"Q": {"r": 1}}'),
    ]);
    expect(Object.fromEntries(pool.json.files.get("task-rest_eeg.json") ?? [])).toEqual({
      ".B": '"y"',
      ".C.f": "3",
      ".L": "[1,2,3]",
      ".N": "null",
    });
    expect(Object.fromEntries(pool.json.files.get("added.json") ?? [])).toEqual({ ".Q.r": "1" });
    expect(pool.json.byLeaf.get(leafKey(".B", '"y"'))).toEqual(["task-rest_eeg.json"]);
    // An unchanged leaf is not new, and neither is a leaf at the same path with a changed value at its OLD value.
    expect(pool.json.byLeaf.get(leafKey(".A", "1"))).toBeUndefined();
    expect(pool.json.byLeaf.get(leafKey(".B", '"x"'))).toBeUndefined();
  });

  test("several files adding one leaf are listed in the order given", () => {
    const pool = buildPools([
      pooled("b.json", null, '{"K": 1}'),
      pooled("a.json", '{"K": 2}', '{"K": 1}'),
      pooled("c.json", '{"K": 1}', '{"K": 1}'),
    ]);
    expect(pool.json.byLeaf.get(leafKey(".K", "1"))).toEqual(["b.json", "a.json"]);
  });

  test("a path listed twice uses the first entry", () => {
    const pool = buildPools([pooled("a.tsv", null, "x\n1\n"), pooled("a.tsv", null, "x\n2\n")]);
    expect(rowsOf(pool, "a.tsv")).toEqual({ header: "x", rows: { "1": 1 } });
  });

  test("nothing in the pool depends on the bytes being shared: a pool is its own copy", () => {
    const bytes = enc("a\n1\n");
    const pool = buildPools([{ path: "a.tsv", before: null, after: bytes }]);
    bytes[2] = 0x39;
    expect(rowsOf(pool, "a.tsv")).toEqual({ header: "a", rows: { "1": 1 } });
  });
});

// ---------------------------------------------------------------------------------------------
// The table change model
// ---------------------------------------------------------------------------------------------

/** A table from text, through the real parser. */
function table(text: string): Table {
  const parsed = parseTsv(enc(text));
  if (!parsed.ok) throw new Error(`test input is not a table (${parsed.refusal})`);
  return parsed.value;
}

/** Tab-separated text from rows of cells, with LF endings and a final newline. */
function tsv(...rows: string[][]): string {
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

/**
 * The diff of two table texts at a path, against a pool built from `files`. A fresh pool each call,
 * because a diff uses up the copies it relocates against.
 */
function diffText(
  path: string,
  before: string,
  after: string,
  files: PoolFile[] = [],
): FileDiff<TableCounts> {
  const result = diffTable(path, table(before), table(after), buildPools(files).rows);
  if (!result.ok) throw new Error(`diff refused: ${result.refusal}`);
  return result.value;
}

/** An atom as one line, for expectations that read like the class line a person would see. */
function line(atom: Atom): string {
  const parts: string[] = [atom.kind];
  if (atom.field !== null) parts.push(`field=${atom.field}`);
  if (atom.before !== null) parts.push(`before=${JSON.stringify(atom.before)}`);
  if (atom.after !== null) parts.push(`after=${JSON.stringify(atom.after)}`);
  if (atom.detail !== null) parts.push(`detail=${JSON.stringify(atom.detail)}`);
  if (atom.rule !== null) parts.push(`rule=${ruleWords(atom.rule)}`);
  return parts.join(" | ");
}

const lines = (diff: FileDiff): string[] => diff.atoms.map(line);
const kindsOf = (diff: FileDiff): ClassKind[] => diff.atoms.map((a) => a.kind);

describe("diffTable: the key column comes from the file name, and only if it identifies rows", () => {
  const same = (path: string, header: string[]) => {
    const text = tsv(
      header,
      header.map((_, i) => `v${i}`),
      header.map((_, i) => `w${i}`),
    );
    return diffText(path, text, text);
  };

  test("each key column of design section 2.2", () => {
    expect(same("participants.tsv", ["participant_id", "age"]).keyColumn).toBe("participant_id");
    expect(same("sub-01/eeg/sub-01_task-x_channels.tsv", ["name", "type"]).keyColumn).toBe("name");
    expect(same("sub-01/eeg/sub-01_electrodes.tsv", ["name", "x"]).keyColumn).toBe("name");
    expect(same("sub-01/sub-01_scans.tsv", ["filename", "acq_time"]).keyColumn).toBe("filename");
    expect(same("sub-01/sub-01_sessions.tsv", ["session_id", "age"]).keyColumn).toBe("session_id");
    expect(same("samples.tsv", ["sample_id", "type"]).keyColumn).toBe("sample_id");
  });

  test("any other table has no key, however key-like its first column", () => {
    expect(
      same("sub-01/eeg/sub-01_task-x_events.tsv", ["onset", "trial_type"]).keyColumn,
    ).toBeNull();
    expect(same("phenotype/iq.tsv", ["participant_id", "iq"]).keyColumn).toBeNull();
    // participants.tsv and samples.tsv are the ROOT files; one deeper is a different table.
    expect(same("sourcedata/participants.tsv", ["participant_id", "age"]).keyColumn).toBeNull();
    expect(same("derivatives/samples.tsv", ["sample_id", "type"]).keyColumn).toBeNull();
    // A name that merely ends like a channels file does not have the underscore of one.
    expect(same("channels.tsv", ["name", "type"]).keyColumn).toBeNull();
    expect(same("sub-01_xchannels.tsv", ["name", "type"]).keyColumn).toBeNull();
  });

  test("the key is used only when its values are non-empty, not n/a, and unique on BOTH sides", () => {
    const path = "sub-01_channels.tsv";
    const header = ["name", "type"];
    const good = tsv(header, ["A1", "EEG"], ["A2", "EEG"]);
    expect(diffText(path, good, good).keyColumn).toBe("name");
    for (const bad of [
      tsv(header, ["A1", "EEG"], ["A1", "EMG"]), // a repeated key
      tsv(header, ["A1", "EEG"], ["", "EEG"]), // an empty key
      tsv(header, ["A1", "EEG"], ["n/a", "EEG"]), // a missing key
    ]) {
      expect(diffText(path, bad, good).keyColumn, "bad before").toBeNull();
      expect(diffText(path, good, bad).keyColumn, "bad after").toBeNull();
    }
    // The key column in only one header: keyless.
    expect(diffText(path, good, tsv(["label", "type"], ["A1", "EEG"])).keyColumn).toBeNull();
    expect(diffText(path, tsv(["label", "type"], ["A1", "EEG"]), good).keyColumn).toBeNull();
    // A table with no rows has no key values to doubt.
    expect(diffText(path, tsv(header), tsv(header)).keyColumn).toBe("name");
  });
});

describe("diffTable: a table that did not change has nothing to say", () => {
  test("equal bytes give no atom, and every row is matched", () => {
    const text = tsv(["name", "type"], ["A1", "EEG"], ["A2", "EMG"]);
    for (const path of ["sub-01_channels.tsv", "events.tsv"]) {
      const diff = diffText(path, text, text);
      expect(diff.atoms).toEqual([]);
      expect(diff.family).toBe("tsv");
      expect(diff.counts).toMatchObject({
        beforeRows: 2,
        afterRows: 2,
        matched: 2,
        paired: 0,
        removed: 0,
        added: 0,
      });
    }
  });

  test("a header with no rows, and a table with only a header change", () => {
    expect(diffText("e.tsv", tsv(["a", "b"]), tsv(["a", "b"])).atoms).toEqual([]);
    expect(lines(diffText("e.tsv", tsv(["a", "b"]), tsv(["a", "c"])))).toEqual([
      'column_removed | field=b | detail="0"',
      "column_added | field=c",
    ]);
  });
});

describe("diffTable: columns", () => {
  test("a removed column carries how many non-missing values it held; n/a and empty do not count", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["onset", "note", "tag"], ["1", "x", "n/a"], ["2", "n/a", ""], ["3", "y", "None"]),
      tsv(["onset"], ["1"], ["2"], ["3"]),
    );
    expect(lines(diff)).toEqual([
      'column_removed | field=note | detail="2"',
      'column_removed | field=tag | detail="1"',
    ]);
    expect(diff.counts).toMatchObject({
      beforeColumns: 3,
      afterColumns: 1,
      commonColumns: 1,
      columnsRemoved: 2,
      columnsAdded: 0,
    });
  });

  test("an added column is an atom and its values are not compared", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["onset"], ["1"], ["2"]),
      tsv(["onset", "note"], ["1", "x"], ["2", "y"]),
    );
    expect(lines(diff)).toEqual(["column_added | field=note"]);
  });

  test("the order of the columns both versions have is one atom, naming both orders", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["a", "b", "c"], ["1", "2", "3"]),
      tsv(["c", "a", "b"], ["3", "1", "2"]),
    );
    expect(lines(diff)).toEqual(['columns_reordered | before="a\\tb\\tc" | after="c\\ta\\tb"']);
    // Adding a column between two that kept their order does not reorder them.
    expect(
      kindsOf(
        diffText("events.tsv", tsv(["a", "b"], ["1", "2"]), tsv(["a", "z", "b"], ["1", "9", "2"])),
      ),
    ).toEqual(["column_added"]);
  });

  test("a renamed column is a removal of the old and an addition of the new, never a quiet match", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["onset", "kind"], ["1", "go"]),
      tsv(["onset", "type"], ["1", "go"]),
    );
    expect(kindsOf(diff)).toEqual(["column_removed", "column_added"]);
  });
});

describe("diffTable: cells of paired rows", () => {
  const cell = (before: string, after: string): string[] =>
    lines(diffText("events.tsv", tsv(["id", "v"], ["1", before]), tsv(["id", "v"], ["1", after])));

  test("a changed value, an emptied cell, a filled cell", () => {
    expect(cell("good", "bad")).toEqual(['cell_replaced | field=v | before="good" | after="bad"']);
    expect(cell("good", "n/a")).toEqual(['cell_emptied | field=v | before="good" | after="n/a"']);
    expect(cell("good", "")).toEqual(['cell_emptied | field=v | before="good" | after=""']);
    expect(cell("n/a", "good")).toEqual(['cell_filled | field=v | before="n/a" | after="good"']);
    expect(cell("", "good")).toEqual(['cell_filled | field=v | before="" | after="good"']);
  });

  test("n/a and empty are both missing, so one becoming the other is a replaced value, not a quiet pass", () => {
    expect(cell("n/a", "")).toEqual(['cell_replaced | field=v | before="n/a" | after=""']);
    expect(cell("", "n/a")).toEqual(['cell_replaced | field=v | before="" | after="n/a"']);
  });

  test("None, unknown and NA are values: overwriting one is a replacement, never a fill", () => {
    expect(cell("None", "F")).toEqual(['cell_replaced | field=v | before="None" | after="F"']);
    expect(cell("unknown", "n/a")).toEqual([
      'cell_emptied | field=v | before="unknown" | after="n/a"',
    ]);
    expect(cell("NA", "5")).toEqual(['cell_replaced | field=v | before="NA" | after="5"']);
  });

  test("a cell's letter case is part of its value: a case change in a cell is a replaced value", () => {
    // mV is millivolts and MV megavolts; a key's case only spells a name, a cell's can mean a unit.
    expect(cell("mV", "MV")).toEqual(['cell_replaced | field=v | before="mV" | after="MV"']);
    expect(cell("Cz", "CZ")).toEqual(['cell_replaced | field=v | before="Cz" | after="CZ"']);
  });

  test("a cell changed by wrap, strip or repad is a template with its rule", () => {
    expect(cell("A01", "A1")).toEqual([
      'cell_templated | field=v | before="A01" | after="A1" | rule=zero padding of numbers changed',
    ]);
    expect(cell("5", "5 mm")).toEqual([
      'cell_templated | field=v | before="5" | after="5 mm" | rule=added suffix " mm"',
    ]);
    expect(cell("'G1'    ", "'G1'")).toEqual([
      'cell_templated | field=v | before="\'G1\'    " | after="\'G1\'" | rule=removed suffix "    "',
    ]);
  });

  test("an insertion, a deletion and a character rule are for names: in a cell they are a replaced value", () => {
    expect(cell("GA01", "EEGGA_01REF")).toEqual([
      'cell_replaced | field=v | before="GA01" | after="EEGGA_01REF"',
    ]);
    expect(cell("EEGGA_01REF", "GA01")).toEqual([
      'cell_replaced | field=v | before="EEGGA_01REF" | after="GA01"',
    ]);
    expect(cell("DCEMBRACE", "DC EMBRACE-REF")).toEqual([
      'cell_replaced | field=v | before="DCEMBRACE" | after="DC EMBRACE-REF"',
    ]);
  });

  test("a changed number is a replaced value, not a suffix or a padding", () => {
    expect(cell("64", "640")).toEqual(['cell_replaced | field=v | before="64" | after="640"']);
    expect(cell("1", "01")).toEqual(['cell_replaced | field=v | before="1" | after="01"']);
    expect(cell("1.5", "1.50")).toEqual(['cell_replaced | field=v | before="1.5" | after="1.50"']);
  });

  test("whitespace is data: a cell gaining a trailing space is a change", () => {
    expect(cell("good", "good ")).toEqual([
      'cell_templated | field=v | before="good" | after="good " | rule=added suffix " "',
    ]);
  });

  test("a cell is compared in the column it is in, not at its position", () => {
    const diff = diffText(
      "events.tsv",
      tsv(["id", "a", "b"], ["1", "x", "y"]),
      tsv(["b", "id", "a"], ["z", "1", "x"]),
    );
    expect(lines(diff)).toEqual(
      expect.arrayContaining(['cell_replaced | field=b | before="y" | after="z"']),
    );
    expect(kindsOf(diff)).toEqual(["columns_reordered", "cell_replaced"]);
  });
});

describe("diffTable: keyed rows", () => {
  const path = "sub-01_task-x_channels.tsv";
  const header = ["name", "type"];

  test("a row with a key only the before side has is removed, and one only the after side has is added", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["Z9", "EMG"]),
      tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["Q7", "EOG"]),
    );
    expect(lines(diff)).toEqual([
      'row_removed | field=name | before="Z9"',
      'row_added | field=name | after="Q7"',
    ]);
    expect(diff.counts).toMatchObject({
      matched: 2,
      removed: 1,
      added: 1,
      paired: 0,
      relocated: 0,
    });
  });

  test("a key kept is the same row: its other cells are compared, and moving it is a reorder", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A3", "EEG"]),
      tsv(header, ["A3", "EEG"], ["A1", "EMG"], ["A2", "EEG"]),
    );
    expect(lines(diff)).toEqual([
      'cell_replaced | field=type | before="EEG" | after="EMG"',
      "rows_reordered",
    ]);
  });

  test("rows that only moved are a reorder and nothing else", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["A2", "EEG"]),
      tsv(header, ["A2", "EEG"], ["A1", "EEG"]),
    );
    expect(lines(diff)).toEqual(["rows_reordered"]);
  });

  test("a removed row among kept rows does not make the others a reorder", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A3", "EEG"]),
      tsv(header, ["A1", "EEG"], ["A3", "EEG"]),
    );
    expect(lines(diff)).toEqual(['row_removed | field=name | before="A2"']);
  });

  test("the real prefix: every name gained POL, with the number's padding changed, other cells equal", () => {
    const before = tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A10", "EEG"]);
    const after = tsv(header, ["POL A01", "EEG"], ["POL A02", "EEG"], ["POL A10", "EEG"]);
    const diff = diffText(path, before, after);
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A01" | rule=added prefix "POL ", zero padding of numbers changed',
      'key_relabeled | field=name | before="A2" | after="POL A02" | rule=added prefix "POL ", zero padding of numbers changed',
      'key_relabeled | field=name | before="A10" | after="POL A10" | rule=added prefix "POL "',
    ]);
    expect(diff.counts).toMatchObject({ matched: 0, paired: 3, removed: 0, added: 0 });
  });

  test("the real wrap on both sides: EEG and -Ref around a name", () => {
    const diff = diffText(
      path,
      tsv(header, ["Fp1", "EEG"], ["Fz", "EEG"]),
      tsv(header, ["EEG Fp1-Ref", "EEG"], ["EEG Fz-Ref", "EEG"]),
    );
    expect(kindsOf(diff)).toEqual(["key_relabeled", "key_relabeled"]);
    expect((diff.atoms[0] as Atom).rule).toEqual({
      kind: "wrap",
      gaps: ["EEG ", "-Ref"],
      shape: "",
      repadded: false,
    });
  });

  test("the real insert: GA01 became EEGGA_01REF, found by position with every other cell equal", () => {
    const diff = diffText(
      path,
      tsv(header, ["GA01", "EEG"], ["GA02", "EEG"]),
      tsv(header, ["EEGGA_01REF", "EEG"], ["EEGGA_02REF", "EEG"]),
    );
    expect(kindsOf(diff)).toEqual(["key_relabeled", "key_relabeled"]);
    expect((diff.atoms[0] as Atom).rule).toEqual({
      kind: "insert",
      gaps: ["EEG", "_", "REF"],
      shape: "LD",
      repadded: false,
    });
    expect(diff.counts).toMatchObject({ paired: 2, removed: 0, added: 0 });
  });

  test("the real characters: DCEMBRACE became DC EMBRACE-REF, paired because every other cell is equal", () => {
    const diff = diffText(
      path,
      tsv(header, ["DCEMBRACE", "EEG"]),
      tsv(header, ["DC EMBRACE-REF", "EEG"]),
    );
    expect(kindsOf(diff)).toEqual(["key_relabeled"]);
    expect((diff.atoms[0] as Atom).rule?.shape).toBe("c9");
  });

  test("a character rule needs the other cells to be equal: with one changed, it is a removal and an addition", () => {
    const diff = diffText(
      path,
      tsv(header, ["DCEMBRACE", "EEG"]),
      tsv(header, ["DC EMBRACE-REF", "EMG"]),
    );
    expect(kindsOf(diff)).toEqual(["row_removed", "row_added"]);
  });

  test("a key changed into something unrelated gets no rule: the old row is removed, the new one added", () => {
    const diff = diffText(path, tsv(header, ["A1", "EEG"]), tsv(header, ["Q7", "EEG"]));
    expect(lines(diff)).toEqual([
      'row_removed | field=name | before="A1"',
      'row_added | field=name | after="Q7"',
    ]);
  });

  test("a relabeled row whose other cells changed too shows the key and the cells", () => {
    // Lenient pairing: the name alone is a prefix, the type is not equal, so it pairs last.
    const diff = diffText(path, tsv(header, ["Fz", "EEG"]), tsv(header, ["EEG Fz", "EMG"]));
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="Fz" | after="EEG Fz" | rule=added prefix "EEG "',
      'cell_replaced | field=type | before="EEG" | after="EMG"',
    ]);
  });

  test("a removed row among 500 relabeled rows is still a row_removed atom", () => {
    const names = Array.from({ length: 501 }, (_, i) => `A${i + 1}`);
    const before = tsv(header, ...names.map((n) => [n, "EEG"]));
    // The row for A250 is gone; every other name gained the prefix POL.
    const after = tsv(header, ...names.filter((n) => n !== "A250").map((n) => [`POL ${n}`, "EEG"]));
    const diff = diffText(path, before, after);
    const removed = diff.atoms.filter((a) => a.kind === "row_removed");
    expect(removed.map(line)).toEqual(['row_removed | field=name | before="A250"']);
    expect(diff.atoms.filter((a) => a.kind === "key_relabeled")).toHaveLength(500);
    expect(diff.counts).toMatchObject({ paired: 500, removed: 1, added: 0 });
    // Every relabel is the same rule, so they are one class; the removal is not among them.
    const rules = new Set(
      diff.atoms
        .filter((a) => a.kind === "key_relabeled")
        .map((a) => ruleWords(a.rule as RelabelRule)),
    );
    expect(rules.size).toBe(1);
  });

  test("a removed row whose key looks like a relabeled one is still removed when its cells differ and nothing is left to pair", () => {
    const diff = diffText(
      path,
      tsv(header, ["A1", "EEG"], ["B1", "EMG"]),
      tsv(header, ["POL A1", "EEG"]),
    );
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A1" | rule=added prefix "POL "',
      'row_removed | field=name | before="B1"',
    ]);
  });
});

describe("diffTable: the same change gives the same atoms whatever else is in the file", () => {
  const path = "sub-01_task-x_channels.tsv";
  const header = ["name", "type", "units"];

  test("different unrelated rows, offsets and row counts around one relabel, one removal and one cell edit", () => {
    const changed = (extra: string[][]) => {
      const before = tsv(
        header,
        ...extra,
        ["A1", "EEG", "uV"],
        ["B7", "EEG", "uV"],
        ["C3", "EEG", "uV"],
      );
      const after = tsv(header, ...extra, ["POL A01", "EEG", "uV"], ["C3", "EMG", "uV"]);
      return diffText(path, before, after).atoms;
    };
    const base = changed([]);
    expect(base.map(line)).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A01" | rule=added prefix "POL ", zero padding of numbers changed',
      'row_removed | field=name | before="B7"',
      'cell_replaced | field=type | before="EEG" | after="EMG"',
    ]);
    expect(changed([["Z1", "EEG", "uV"]])).toEqual(base);
    expect(
      changed([
        ["Z1", "EEG", "uV"],
        ["Z2", "ECG", "mV"],
        ["Z3", "n/a", "n/a"],
      ]),
    ).toEqual(base);
    expect(changed(Array.from({ length: 40 }, (_, i) => [`Y${i}`, "EEG", "uV"]))).toEqual(base);
  });

  test("the same keyless edit in two files with different rows around it", () => {
    const edit = (rows: string[][]) =>
      diffText(
        "events.tsv",
        tsv(["onset", "duration", "trial_type"], ...rows, ["5", "1", "go"]),
        tsv(["onset", "duration", "trial_type"], ...rows, ["5", "1", "stop"]),
      ).atoms;
    const base = edit([]);
    expect(base.map(line)).toEqual([
      'cell_replaced | field=trial_type | before="go" | after="stop"',
    ]);
    expect(
      edit([
        ["1", "1", "x"],
        ["2", "1", "y"],
      ]),
    ).toEqual(base);
    expect(edit(Array.from({ length: 30 }, (_, i) => [String(i), "1", "z"]))).toEqual(base);
  });
});

describe("diffTable: a strict relabel needs a cell that says something, not just equal cells", () => {
  // Equal cells that are all missing, or no cell but the key, are equal vacuously. Pairing `sub-1`
  // removed with `sub-10` added on that ground would call a participant that is gone a renamed one
  // and raise no loss fact.
  test("a table of ids alone: sub-1 removed and sub-10 added are a removed row and an added one", () => {
    const diff = diffText(
      "participants.tsv",
      tsv(["participant_id"], ["sub-1"], ["sub-2"]),
      tsv(["participant_id"], ["sub-2"], ["sub-10"]),
    );
    expect(kindsOf(diff)).toEqual(["row_removed", "row_added"]);
  });

  test("equal cells that are all missing are not evidence either", () => {
    const diff = diffText(
      "participants.tsv",
      tsv(["participant_id", "age"], ["sub-1", "n/a"], ["sub-2", "n/a"]),
      tsv(["participant_id", "age"], ["sub-2", "n/a"], ["sub-10", "n/a"]),
    );
    expect(kindsOf(diff)).toEqual(["row_removed", "row_added"]);
  });

  test("an equal cell that says something is evidence: the same age under the new name is a relabel", () => {
    const diff = diffText(
      "participants.tsv",
      tsv(["participant_id", "age"], ["1", "30"], ["sub-2", "31"]),
      tsv(["participant_id", "age"], ["sub-2", "31"], ["sub-1", "30"]),
    );
    expect(lines(diff)).toEqual([
      'key_relabeled | field=participant_id | before="1" | after="sub-1" | rule=added prefix "sub-"',
      "rows_reordered",
    ]);
  });

  test("sub-1 and sub-10 are two participants, whatever the other cells say", () => {
    const diff = diffText(
      "participants.tsv",
      tsv(
        ["participant_id", "age", "sex", "handedness"],
        ["sub-1", "23", "M", "R"],
        ["sub-2", "30", "F", "R"],
      ),
      tsv(
        ["participant_id", "age", "sex", "handedness"],
        ["sub-2", "30", "F", "R"],
        ["sub-10", "23", "M", "R"],
      ),
    );
    expect(kindsOf(diff)).toEqual(["row_removed", "row_added"]);
  });

  test("a rule that keeps the name's letters and digit values still pairs without cell evidence", () => {
    // Zero padding and case change a participant's spelling, not the participant.
    expect(
      kindsOf(
        diffText(
          "participants.tsv",
          tsv(["participant_id"], ["sub-1"]),
          tsv(["participant_id"], ["sub-01"]),
        ),
      ),
    ).toEqual(["key_relabeled"]);
    expect(
      kindsOf(
        diffText(
          "participants.tsv",
          tsv(["participant_id"], ["sub-a"]),
          tsv(["participant_id"], ["SUB-A"]),
        ),
      ),
    ).toEqual(["key_relabeled"]);
  });
});

describe("diffTable: the pairing order is strict relabel, then relocation, then lenient relabel", () => {
  const path = "sub-01_channels.tsv";
  const header = ["name", "v"];

  test("strict before lenient: the candidate whose other cells are equal is the one paired, not the first", () => {
    // Both Cz and cz are the case-only relabel of CZ; only cz has the same value, so only it is the
    // same row. Pairing the first in file order would call v 1 -> 2 an edit and remove the right row.
    const diff = diffText(path, tsv(header, ["Cz", "1"], ["cz", "2"]), tsv(header, ["CZ", "2"]));
    expect(lines(diff)).toEqual([
      'row_removed | field=name | before="Cz"',
      'key_relabeled | field=name | before="cz" | after="CZ" | rule=letter case changed',
    ]);
  });

  test("strict by position before lenient: the pair whose cells are equal wins over the nearer name", () => {
    const diff = diffText(
      path,
      tsv(header, ["GA01", "1"], ["GA02", "2"]),
      tsv(header, ["EEGGA_02REF", "2"], ["EEGGA_01REF", "1"]),
    );
    // Each new name is the relabel of BOTH old names' shapes; the equal value says which.
    expect(lines(diff)).toEqual([
      expect.stringContaining('before="GA01" | after="EEGGA_01REF"'),
      expect.stringContaining('before="GA02" | after="EEGGA_02REF"'),
      "rows_reordered",
    ]);
  });

  test("relocation before lenient relabel: a removed row found verbatim in sourcedata is not paired with a look-alike", () => {
    const copy = pooled(`sourcedata/removed/${path}`, null, tsv(header, ["A1", "7"]));
    // A1 was removed and kept in sourcedata. POL A1 is a NEW row that happens to wrap the name.
    const diff = diffText(
      path,
      tsv(header, ["A1", "7"], ["B1", "1"]),
      tsv(header, ["B1", "1"], ["POL A1", "9"]),
      [copy],
    );
    expect(lines(diff)).toEqual([
      'row_relocated | field=name | before="A1" | detail="sourcedata/removed/sub-*_channels.tsv"',
      'row_added | field=name | after="POL A1"',
    ]);
    // Without the copy the same rows are paired by the name alone: the lenient pass.
    const without = diffText(
      path,
      tsv(header, ["A1", "7"], ["B1", "1"]),
      tsv(header, ["B1", "1"], ["POL A1", "9"]),
    );
    expect(lines(without)).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A1" | rule=added prefix "POL "',
      'cell_replaced | field=v | before="7" | after="9"',
      "rows_reordered",
    ]);
  });

  test("strict relabel before relocation: a renamed row is paired even when an identical copy exists elsewhere", () => {
    // The first prototype relocated first and matched renamed rows to identical copies in other
    // subjects' files. Here the row is relabeled (every other cell equal), and the copy stays unused.
    const copies = [pooled(`sourcedata/removed/${path}`, null, tsv(header, ["A1", "7"]))];
    const diff = diffText(path, tsv(header, ["A1", "7"]), tsv(header, ["POL A1", "7"]), copies);
    expect(lines(diff)).toEqual([
      'key_relabeled | field=name | before="A1" | after="POL A1" | rule=added prefix "POL "',
    ]);
    expect(diff.counts.relocated).toBe(0);
  });
});

describe("diffTable: keyless tables", () => {
  const path = "sub-01_task-x_events.tsv";
  const header = ["onset", "duration", "trial_type"];

  test("rows are a multiset on the common columns: order does not matter, duplicates count", () => {
    const diff = diffText(
      path,
      tsv(header, ["1", "1", "go"], ["1", "1", "go"], ["2", "1", "stop"]),
      tsv(header, ["2", "1", "stop"], ["1", "1", "go"]),
    );
    // One go was removed; the rest moved.
    expect(lines(diff)).toEqual(['row_removed | before="1\\t1\\tgo"', "rows_reordered"]);
    expect(diff.counts).toMatchObject({ matched: 2, removed: 1 });
  });

  test("a deleted event and an unrelated new event are a removal and an addition, not an edit", () => {
    const diff = diffText(
      path,
      tsv(header, ["1", "1", "go"], ["5", "1", "stop"]),
      tsv(header, ["1", "1", "go"], ["9", "2", "rest"]),
    );
    expect(lines(diff)).toEqual([
      'row_removed | before="5\\t1\\tstop"',
      'row_added | after="9\\t2\\trest"',
    ]);
  });

  test("a pair is accepted only when at most half the common columns differ", () => {
    const four = ["a", "b", "c", "d"];
    const run = (after: string[]) =>
      diffText("t.tsv", tsv(four, ["1", "2", "3", "4"]), tsv(four, after));
    // Two of four differ: exactly half, so one row, edited in two cells.
    expect(kindsOf(run(["1", "2", "x", "y"]))).toEqual(["cell_replaced", "cell_replaced"]);
    // Three of four differ: more than half, so removed and added.
    expect(kindsOf(run(["1", "x", "y", "z"]))).toEqual(["row_removed", "row_added"]);
    // One of two differs: half. One of one: more than half.
    expect(
      kindsOf(diffText("t.tsv", tsv(["a", "b"], ["1", "2"]), tsv(["a", "b"], ["1", "x"]))),
    ).toEqual(["cell_replaced"]);
    expect(kindsOf(diffText("t.tsv", tsv(["a"], ["1"]), tsv(["a"], ["x"])))).toEqual([
      "row_removed",
      "row_added",
    ]);
  });

  test("an edited onset pairs the row, and the cell is shown", () => {
    const diff = diffText(path, tsv(header, ["1", "1", "go"]), tsv(header, ["1.5", "1", "go"]));
    expect(lines(diff)).toEqual(['cell_replaced | field=onset | before="1" | after="1.5"']);
  });

  test("pairing skips a row that belongs to nothing so the ones after it still pair", () => {
    const diff = diffText(
      path,
      tsv(header, ["1", "1", "go"], ["7", "7", "gone"], ["3", "1", "stop"]),
      tsv(header, ["1", "1", "go"], ["3", "1", "stop"]),
    );
    // The middle row matched nothing, but the others are kept; no spurious pairs.
    expect(lines(diff)).toEqual(['row_removed | before="7\\t7\\tgone"']);
    const edited = diffText(
      path,
      tsv(header, ["5", "1", "go"], ["7", "7", "gone"], ["3", "1", "stop"]),
      tsv(header, ["5.5", "1", "go"], ["3", "1", "stop"]),
    );
    expect(lines(edited)).toEqual([
      'cell_replaced | field=onset | before="5" | after="5.5"',
      'row_removed | before="7\\t7\\tgone"',
    ]);
  });

  test("a column only one version has is not part of the row identity, and the column is reported", () => {
    const diff = diffText(
      path,
      tsv([...header, "note"], ["1", "1", "go", "x"]),
      tsv(header, ["1", "1", "go"]),
    );
    expect(lines(diff)).toEqual(['column_removed | field=note | detail="1"']);
  });

  test("a keyed file whose keys are not usable is diffed as a multiset and loses nothing", () => {
    const diff = diffText(
      "sub-01_channels.tsv",
      tsv(["name", "type"], ["A1", "EEG"], ["A1", "EMG"]),
      tsv(["name", "type"], ["A1", "EMG"]),
    );
    expect(diff.keyColumn).toBeNull();
    expect(lines(diff)).toEqual(['row_removed | before="A1\\tEEG"']);
  });
});

describe("diffTable: relocation is exact and corresponding", () => {
  const path = "sub-01/eeg/sub-01_channels.tsv";
  const header = ["name", "type"];
  const before = tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A3", "EEG"]);
  const after = tsv(header, ["A1", "EEG"]);
  const target = `sourcedata/removed/${path}`;

  test("a removed row found verbatim at the corresponding sourcedata path is relocated, naming the shape it went to", () => {
    const diff = diffText(path, before, after, [
      pooled(target, null, tsv(header, ["A2", "EEG"], ["A3", "EEG"])),
    ]);
    expect(lines(diff)).toEqual([
      'row_relocated | field=name | before="A2" | detail="sourcedata/removed/sub-*/eeg/sub-*_channels.tsv"',
      'row_relocated | field=name | before="A3" | detail="sourcedata/removed/sub-*/eeg/sub-*_channels.tsv"',
    ]);
    expect(diff.counts).toMatchObject({ matched: 1, relocated: 2, removed: 0 });
  });

  test("a copy that differs in one byte is not a relocation", () => {
    for (const changed of [
      ["A2", "EEG "],
      ["A2", "EEg"],
      ["a2", "EEG"],
      ["A2", "EEG\u{200B}"],
    ]) {
      const diff = diffText(path, before, after, [
        pooled(target, null, tsv(header, changed, ["A3", "EEG"])),
      ]);
      expect(kindsOf(diff), JSON.stringify(changed)).toEqual(["row_removed", "row_relocated"]);
    }
  });

  test("a copy in a file that was already there is not new, so it proves nothing", () => {
    const same = tsv(header, ["A2", "EEG"], ["A3", "EEG"]);
    const diff = diffText(path, before, after, [pooled(target, same, same)]);
    expect(kindsOf(diff)).toEqual(["row_removed", "row_removed"]);
  });

  test("a copy under a path that does not correspond is not a relocation", () => {
    const rows = tsv(header, ["A2", "EEG"], ["A3", "EEG"]);
    for (const elsewhere of [
      "sourcedata/removed/sub-01/eeg/sub-02_channels.tsv", // another subject's file
      "sourcedata/removed/sub-01/sub-01_channels.tsv", // a shorter path
      `sourcedata/removed/${path}.bak`, // a different name
      `sourcedata/removed/x${path}`, // the directory name differs
      "sourcedata/removed/channels.tsv",
      "other/removed/sub-01/eeg/sub-01_channels.tsv", // not under sourcedata
      `derivatives/${path}`,
      `notsourcedata/removed/${path}`,
      `Sourcedata/removed/${path}`,
      path, // the file itself
    ]) {
      const diff = diffText(path, before, after, [pooled(elsewhere, null, rows)]);
      expect(kindsOf(diff), elsewhere).toEqual(["row_removed", "row_removed"]);
    }
  });

  test("any directory under sourcedata may hold the corresponding path, however deep", () => {
    const rows = tsv(header, ["A2", "EEG"], ["A3", "EEG"]);
    for (const where of [
      `sourcedata/${path}`,
      `sourcedata/a/${path}`,
      `sourcedata/a/b/c/${path}`,
    ]) {
      const diff = diffText(path, before, after, [pooled(where, null, rows)]);
      expect(kindsOf(diff), where).toEqual(["row_relocated", "row_relocated"]);
    }
  });

  test("a copy under a different header is not a relocation, even with the same cells in another order", () => {
    for (const other of [
      tsv(["name", "type", "units"], ["A2", "EEG", "uV"], ["A3", "EEG", "uV"]),
      tsv(["type", "name"], ["EEG", "A2"], ["EEG", "A3"]),
      tsv(["Name", "type"], ["A2", "EEG"], ["A3", "EEG"]),
    ]) {
      const diff = diffText(path, before, after, [pooled(target, null, other)]);
      expect(kindsOf(diff)).toEqual(["row_removed", "row_removed"]);
    }
  });

  test("two identical removed rows and one copy give one relocated row and one removed", () => {
    const events = "sub-01_events.tsv";
    const hdr = ["onset", "trial_type"];
    const diff = diffText(
      events,
      tsv(hdr, ["1", "go"], ["1", "go"], ["2", "stop"]),
      tsv(hdr, ["2", "stop"]),
      [pooled(`sourcedata/removed/${events}`, null, tsv(hdr, ["1", "go"]))],
    );
    expect(kindsOf(diff)).toEqual(["row_relocated", "row_removed"]);
    expect(diff.counts).toMatchObject({ matched: 1, relocated: 1, removed: 1 });
    // Two copies: both relocated.
    const both = diffText(
      events,
      tsv(hdr, ["1", "go"], ["1", "go"], ["2", "stop"]),
      tsv(hdr, ["2", "stop"]),
      [pooled(`sourcedata/removed/${events}`, null, tsv(hdr, ["1", "go"], ["1", "go"]))],
    );
    expect(kindsOf(both)).toEqual(["row_relocated", "row_relocated"]);
  });

  test("one copy is never used twice, across files either", () => {
    const hdr = ["name", "type"];
    const pool = buildPools([
      pooled("sourcedata/old/sub-01/x_channels.tsv", null, tsv(hdr, ["A2", "EEG"])),
    ]).rows;
    // sub-01/x_channels.tsv and x_channels.tsv both correspond to that one file.
    const first = diffTable(
      "sub-01/x_channels.tsv",
      table(tsv(hdr, ["A1", "EEG"], ["A2", "EEG"])),
      table(tsv(hdr, ["A1", "EEG"])),
      pool,
    );
    const second = diffTable(
      "x_channels.tsv",
      table(tsv(hdr, ["A1", "EEG"], ["A2", "EEG"])),
      table(tsv(hdr, ["A1", "EEG"])),
      pool,
    );
    expect(first.ok && kindsOf(first.value)).toEqual(["row_relocated"]);
    expect(second.ok && kindsOf(second.value)).toEqual(["row_removed"]);
  });

  test("a diff that is refused does not use up the copies it found", () => {
    const hdr = ["name", "type"];
    const pool = buildPools([pooled(`sourcedata/old/${path}`, null, tsv(hdr, ["A2", "EEG"]))]).rows;
    const refused = diffTableWith(path, table(before), table(after), pool, () => false);
    expect(refused).toEqual({ ok: false, refusal: "internal_mismatch" });
    expect(pool.files.get(`sourcedata/old/${path}`)?.rows.get("A2\tEEG")).toBe(1);
    const used = diffTable(path, table(before), table(after), pool);
    expect(used.ok && used.value.counts.relocated).toBe(1);
    expect(pool.files.get(`sourcedata/old/${path}`)?.rows.get("A2\tEEG")).toBe(0);
  });

  test("a keyless removed row is relocated by its whole row text", () => {
    const events = "sub-01_events.tsv";
    const hdr = ["onset", "trial_type"];
    const diff = diffText(events, tsv(hdr, ["1", "go"], ["2", "stop"]), tsv(hdr, ["1", "go"]), [
      pooled(`sourcedata/x/${events}`, null, tsv(hdr, ["2", "stop"])),
    ]);
    expect(lines(diff)).toEqual([
      'row_relocated | before="2\\tstop" | detail="sourcedata/x/sub-*_events.tsv"',
    ]);
  });
});

describe("diffTable: the layout of the file", () => {
  const same = tsv(["a", "b"], ["1", "2"]);

  test("a byte order mark, line endings and the final newline are one atom each, with both states", () => {
    expect(lines(diffText("e.tsv", same, `\u{FEFF}${same}`))).toEqual([
      'format | before="absent" | after="present" | detail="bom"',
    ]);
    expect(lines(diffText("e.tsv", same, same.replace(/\n/g, "\r\n")))).toEqual([
      'format | before="lf" | after="crlf" | detail="line_endings"',
    ]);
    expect(lines(diffText("e.tsv", same, same.slice(0, -1)))).toEqual([
      'format | before="present" | after="absent" | detail="final_newline"',
    ]);
  });

  test("mixed line endings: WHICH lines end in CRLF is a difference of its own", () => {
    const a = "a\tb\r\n1\t2\n3\t4\n";
    const b = "a\tb\n1\t2\r\n3\t4\n";
    expect(lines(diffText("e.tsv", a, b))).toEqual([
      'format | before="100" | after="010" | detail="line_ending_pattern"',
    ]);
    // Mixed to LF changes the class of ending and the pattern.
    expect(lines(diffText("e.tsv", a, "a\tb\n1\t2\n3\t4\n"))).toEqual([
      'format | before="mixed" | after="lf" | detail="line_endings"',
      'format | before="100" | after="" | detail="line_ending_pattern"',
    ]);
  });

  test("a layout change does not touch the rows: they stay matched", () => {
    const diff = diffText("e.tsv", same, `\u{FEFF}${same.replace(/\n/g, "\r\n")}`);
    expect(diff.atoms.map((a) => a.detail)).toEqual(["bom", "line_endings"]);
    expect(diff.counts.matched).toBe(1);
  });

  test("formatAtoms of equal layouts is empty and of every field differing is four atoms in a fixed order", () => {
    const base = { bom: false, eol: "lf", crPattern: "", finalNewline: true } as const;
    expect(formatAtoms(base, base)).toEqual([]);
    const all = formatAtoms(base, {
      bom: true,
      eol: "mixed",
      crPattern: "01",
      finalNewline: false,
    });
    expect(all.map((a) => a.detail)).toEqual([
      "bom",
      "line_endings",
      "line_ending_pattern",
      "final_newline",
    ]);
  });
});

describe("diffTable: the totality assertion", () => {
  const path = "sub-01_channels.tsv";
  const header = ["name", "type"];
  const before = table(tsv(header, ["A1", "EEG"], ["A2", "EEG"], ["A3", "EEG"]));
  const after = table(tsv(header, ["A1", "EEG"], ["Q9", "EEG"]));
  const emptyPool = buildPools([]).rows;

  test("a count check that fails turns the file into internal_mismatch, never into a summary", () => {
    expect(diffTableWith(path, before, after, emptyPool, () => false)).toEqual({
      ok: false,
      refusal: "internal_mismatch",
    });
    expect(diffTableWith(path, before, after, emptyPool, () => true).ok).toBe(true);
  });

  test("the entry point runs the real check: diffTable is diffTableWith over verifyTableCounts", () => {
    // The guard cannot fire on real input, so no input proves the wiring; the source of the entry
    // point is the only place the wiring is visible. A diffTable that passed a check that always
    // holds would turn every internal_mismatch into a summary, and this is what notices.
    expect(String(diffTable)).toContain("verifyTableCounts");
    expect(String(diffTable)).not.toContain("=> true");
  });

  test("the check is given the tallies of what was emitted", () => {
    let seen: TableCounts | null = null;
    diffTableWith(path, before, after, emptyPool, (counts) => {
      seen = counts;
      return true;
    });
    expect(seen).toEqual({
      beforeRows: 3,
      afterRows: 2,
      matched: 1,
      paired: 0,
      relocated: 0,
      removed: 2,
      afterMatched: 1,
      afterPaired: 0,
      added: 1,
      conflicts: 0,
      beforeColumns: 2,
      afterColumns: 2,
      commonColumns: 2,
      columnsRemoved: 0,
      columnsAdded: 0,
    });
  });

  test("the real check accepts a total count and rejects each way a count can fail to add up", () => {
    const good: TableCounts = {
      beforeRows: 10,
      afterRows: 9,
      matched: 4,
      paired: 3,
      relocated: 2,
      removed: 1,
      afterMatched: 4,
      afterPaired: 3,
      added: 2,
      conflicts: 0,
      beforeColumns: 5,
      afterColumns: 6,
      commonColumns: 4,
      columnsRemoved: 1,
      columnsAdded: 2,
    };
    expect(verifyTableCounts(good)).toBe(true);
    const broken: Partial<TableCounts>[] = [
      { beforeRows: 11 },
      { beforeRows: 9 },
      { afterRows: 10 },
      { afterRows: 8 },
      { removed: 2 },
      { relocated: 1 },
      { added: 1 },
      { matched: 5 },
      { afterPaired: 2 },
      { conflicts: 1 },
      { beforeColumns: 6 },
      { afterColumns: 5 },
      { columnsRemoved: 2 },
      { columnsAdded: 1 },
      { commonColumns: 5 },
    ];
    for (const change of broken) {
      expect(verifyTableCounts({ ...good, ...change }), JSON.stringify(change)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Generated tables: the diff is total, and it never hides a change
// ---------------------------------------------------------------------------------------------

interface Layout {
  bom: boolean;
  /** "lf", "crlf" or "mixed" (the first line CRLF, the rest LF). */
  eol: "lf" | "crlf" | "mixed";
  finalNewline: boolean;
}

/** Text from a header and rows in the given layout. */
function render(header: string[], rows: string[][], layout: Layout): string {
  const lines = [header, ...rows].map((cells) => cells.join("\t"));
  let text = "";
  lines.forEach((content, i) => {
    text += content;
    const last = i === lines.length - 1;
    if (!last || layout.finalNewline) {
      text += layout.eol === "crlf" || (layout.eol === "mixed" && i === 0) ? "\r\n" : "\n";
    }
  });
  return `${layout.bom ? "\u{FEFF}" : ""}${text}`;
}

/** A tool kit over a seeded generator: pick, chance, shuffle. */
function toolkit(random: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const chance = (p: number): boolean => random() < p;
  const int = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));
  const shuffled = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  return { pick, chance, int, shuffled };
}

const VALUES = [
  "EEG",
  "EMG",
  "uV",
  "n/a",
  "",
  "1",
  "01",
  "64",
  "640",
  "A1",
  "a1",
  "x y",
  "good",
  "bad",
  "None",
  "'G1'    ",
  "'G1'",
];
const NAMES = [
  "A1",
  "A2",
  "A01",
  "Cz",
  "cz",
  "CZ",
  "Fp1",
  "EEG Fp1-Ref",
  "POL A01",
  "GA01",
  "EEGGA_01REF",
  "DCEMBRACE",
  "DC EMBRACE-REF",
  "B7",
  "a1",
  "POL A1",
];
const TABLE_FILES: { path: string; key: string | null }[] = [
  { path: "sub-01/eeg/sub-01_task-x_channels.tsv", key: "name" },
  { path: "participants.tsv", key: "participant_id" },
  { path: "sub-01/sub-01_scans.tsv", key: "filename" },
  { path: "sub-01/eeg/sub-01_electrodes.tsv", key: "name" },
  { path: "sub-01/eeg/sub-01_task-x_events.tsv", key: null },
  { path: "phenotype/iq.tsv", key: null },
];
const OTHER_COLUMNS = ["type", "units", "onset", "duration", "status", "note", "x"];

interface GeneratedTables {
  path: string;
  before: string;
  after: string;
  pool: PoolFile[];
  beforeRows: string[][];
  afterRows: string[][];
  beforeHeader: string[];
  afterHeader: string[];
}

function generateTables(random: () => number): GeneratedTables {
  const { pick, chance, int, shuffled } = toolkit(random);
  const file = pick(TABLE_FILES);
  const keyName = file.key ?? "id";
  const extra = shuffled(OTHER_COLUMNS).slice(0, int(0, 4));
  const beforeHeader = chance(0.8) ? [keyName, ...extra] : shuffled([keyName, ...extra]);
  const cell = (column: string): string => (column === keyName ? pick(NAMES) : pick(VALUES));

  const count = int(0, 10);
  const duplicate = chance(0.12);
  const used = new Set<string>();
  const beforeRows: string[][] = [];
  for (let i = 0; i < count; i++) {
    const row = beforeHeader.map(cell);
    const at = beforeHeader.indexOf(keyName);
    while (!duplicate && used.has(row[at] as string)) row[at] = `${pick(NAMES)}-${int(0, 99)}`;
    used.add(row[at] as string);
    beforeRows.push(row);
  }

  // The after table: edit a copy of the before rows.
  let afterHeader = [...beforeHeader];
  if (chance(0.2) && afterHeader.length > 1) {
    const drop = pick(afterHeader.filter((c) => c !== keyName));
    afterHeader = afterHeader.filter((c) => c !== drop);
  }
  if (chance(0.2)) afterHeader.push("added_column");
  if (chance(0.05)) afterHeader[afterHeader.length - 1] = "renamed_column";
  if (chance(0.15)) afterHeader = shuffled(afterHeader);
  const mutateKey = (key: string): string => {
    switch (int(0, 4)) {
      case 0:
        return `POL ${key}`;
      case 1:
        return key.toUpperCase();
      case 2:
        return `EEG ${key}-Ref`;
      case 3:
        return key.replace(/[0-9]+/, (d) => `0${d}`);
      default:
        return `${key}x`;
    }
  };
  const removedForCopies: string[][] = [];
  let carried: string[][] = [];
  for (const row of beforeRows) {
    if (chance(0.2)) {
      removedForCopies.push(row);
      continue;
    }
    const next = [...row];
    const at = beforeHeader.indexOf(keyName);
    if (chance(0.25)) next[at] = mutateKey(next[at] as string);
    for (let i = 0; i < next.length; i++) if (i !== at && chance(0.15)) next[i] = pick(VALUES);
    carried.push(next);
    if (chance(0.05)) carried.push([...next]);
  }
  for (let i = int(0, 3); i > 0; i--)
    carried.push(beforeHeader.map((c) => (c === keyName ? `N${int(0, 999)}` : pick(VALUES))));
  if (chance(0.3)) carried = shuffled(carried);
  const afterRows = carried.map((row) =>
    afterHeader.map((column) => {
      const at = beforeHeader.indexOf(column);
      return at >= 0 ? (row[at] as string) : pick(VALUES);
    }),
  );

  const layout = (): Layout => ({
    bom: chance(0.1),
    eol: pick(["lf", "lf", "lf", "crlf", "mixed"] as const),
    finalNewline: chance(0.9),
  });
  const beforeLayout = layout();
  const afterLayout = chance(0.5) ? beforeLayout : layout();

  const pool: PoolFile[] = [];
  if (removedForCopies.length > 0 && chance(0.6)) {
    const copies = removedForCopies
      .filter(() => chance(0.7))
      .map((row) => (chance(0.25) ? row.map((c, i) => (i === 0 ? `${c}!` : c)) : row));
    pool.push(
      pooled(
        `sourcedata/removed/${file.path}`,
        null,
        render(beforeHeader, copies, { bom: false, eol: "lf", finalNewline: true }),
      ),
    );
  }
  if (chance(0.3))
    pool.push(
      pooled(
        `sourcedata/other/${file.path}`,
        null,
        render(beforeHeader, removedForCopies, { bom: false, eol: "lf", finalNewline: true }),
      ),
    );

  return {
    path: file.path,
    before: render(beforeHeader, beforeRows, beforeLayout),
    after: render(afterHeader, afterRows, afterLayout),
    pool,
    beforeRows,
    afterRows,
    beforeHeader,
    afterHeader,
  };
}

/** The rows projected on the columns both headers have, as a multiset keyed by text. */
function projected(header: string[], rows: string[][], columns: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const text = columns.map((c) => row[header.indexOf(c)]).join("\t");
    map.set(text, (map.get(text) ?? 0) + 1);
  }
  return map;
}

describe("diffTable on generated tables", () => {
  test("1,800 generated pairs: the diff is always total, its tallies match its atoms, and it is deterministic", () => {
    const random = seeded(2024);
    let checked = 0;
    let skipped = 0;
    const seen = new Set<ClassKind>();
    for (let n = 0; n < 1800; n++) {
      const g = generateTables(random);
      const b = parseTsv(enc(g.before));
      const a = parseTsv(enc(g.after));
      if (!b.ok || !a.ok) {
        skipped++;
        continue;
      }
      const result = diffTable(g.path, b.value, a.value, buildPools(g.pool).rows);
      if (!result.ok)
        throw new Error(`case ${n} refused: ${result.refusal}\n${g.before}\n---\n${g.after}`);
      const { atoms, counts } = result.value;
      checked++;
      for (const atom of atoms) seen.add(atom.kind);

      // Total: the real assertion, and the sums it is made of, against the real row counts.
      expect(verifyTableCounts(counts), `case ${n}`).toBe(true);
      expect(counts.beforeRows, `case ${n}`).toBe(b.value.rows.length);
      expect(counts.afterRows, `case ${n}`).toBe(a.value.rows.length);
      expect(counts.matched + counts.paired + counts.relocated + counts.removed, `case ${n}`).toBe(
        b.value.rows.length,
      );
      expect(counts.afterMatched + counts.afterPaired + counts.added, `case ${n}`).toBe(
        a.value.rows.length,
      );

      // The tallies are the atoms.
      const tally = (kind: ClassKind): number => atoms.filter((x) => x.kind === kind).length;
      expect(tally("row_removed"), `case ${n}`).toBe(counts.removed);
      expect(tally("row_relocated"), `case ${n}`).toBe(counts.relocated);
      expect(tally("row_added"), `case ${n}`).toBe(counts.added);
      expect(tally("column_removed"), `case ${n}`).toBe(counts.columnsRemoved);
      expect(tally("column_added"), `case ${n}`).toBe(counts.columnsAdded);
      expect(tally("key_relabeled"), `case ${n}`).toBeLessThanOrEqual(counts.paired);

      // Deterministic: a second run against a fresh pool says the same.
      const again = diffTable(g.path, b.value, a.value, buildPools(g.pool).rows);
      expect(again.ok && again.value.atoms, `case ${n}`).toEqual(atoms);

      // Nothing is hidden: if the rows differ on the columns both versions have, a row atom says so.
      const common = g.beforeHeader.filter((c) => g.afterHeader.includes(c));
      const before = projected(g.beforeHeader, g.beforeRows, common);
      const after = projected(g.afterHeader, g.afterRows, common);
      const same =
        before.size === after.size && [...before].every(([text, k]) => after.get(text) === k);
      const rowKinds: ClassKind[] = [
        "row_removed",
        "row_relocated",
        "row_added",
        "key_relabeled",
        "cell_replaced",
        "cell_emptied",
        "cell_filled",
        "cell_templated",
      ];
      const rowAtoms = atoms.filter((x) => rowKinds.includes(x.kind));
      if (same) expect(rowAtoms, `case ${n}: equal rows, but ${rowAtoms.map(line)}`).toEqual([]);
      else
        expect(
          rowAtoms.length,
          `case ${n}: different rows, no atom\n${g.before}\n---\n${g.after}`,
        ).toBeGreaterThan(0);
    }
    expect(skipped).toBeLessThan(180);
    expect(checked).toBeGreaterThan(1500);
    // The generator reaches the interesting kinds, so the checks above are not vacuous.
    for (const kind of [
      "row_removed",
      "row_added",
      "row_relocated",
      "key_relabeled",
      "cell_replaced",
      "cell_emptied",
      "cell_filled",
      "cell_templated",
      "column_removed",
      "column_added",
      "columns_reordered",
      "rows_reordered",
      "format",
    ] as ClassKind[]) {
      expect(seen.has(kind), kind).toBe(true);
    }
  });

  test("a table diffed against itself has no atoms, however it is laid out", () => {
    const random = seeded(77);
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const g = generateTables(random);
      const parsed = parseTsv(enc(g.before));
      if (!parsed.ok) continue;
      const result = diffTable(g.path, parsed.value, parsed.value, buildPools(g.pool).rows);
      expect(result.ok && result.value.atoms, `case ${n}`).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  test("shuffled rows with unique keys are only a reorder; appended rows are only additions", () => {
    const random = seeded(31337);
    const { shuffled, int } = toolkit(random);
    let reordered = 0;
    for (let n = 0; n < 300; n++) {
      const header = ["name", "type"];
      const rows = Array.from({ length: int(2, 9) }, (_, i) => [
        `K${i}`,
        VALUES[i % VALUES.length] as string,
      ]);
      const layout: Layout = { bom: false, eol: "lf", finalNewline: true };
      const path = "sub-01_channels.tsv";
      const order = shuffled(rows);
      const moved = diffText(path, render(header, rows, layout), render(header, order, layout));
      const sameOrder = order.every((row, i) => row === rows[i]);
      expect(
        moved.atoms.map((a) => a.kind),
        `case ${n}`,
      ).toEqual(sameOrder ? [] : ["rows_reordered"]);
      if (!sameOrder) reordered++;
      const extra = Array.from({ length: int(1, 3) }, (_, i) => [`Z${i}`, "EEG"]);
      const grown = diffText(
        path,
        render(header, rows, layout),
        render(header, [...rows, ...extra], layout),
      );
      expect(
        grown.atoms.map((a) => a.kind),
        `case ${n}`,
      ).toEqual(extra.map(() => "row_added"));
    }
    expect(reordered).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------------------------
// The JSON change model
// ---------------------------------------------------------------------------------------------

/**
 * The diff of two JSON texts at a path, against a pool built from `files`, through the real parser.
 * JSON moves consume nothing, so the pool could be shared, but a fresh one per call keeps the tests
 * independent.
 */
function diffJsonText(
  path: string,
  before: string,
  after: string,
  files: PoolFile[] = [],
): FileDiff<JsonCounts> {
  const result = diffJson(path, json(before), json(after), buildPools(files).json);
  if (!result.ok) throw new Error(`diff refused: ${result.refusal}`);
  return result.value;
}

const jsonLines = (before: string, after: string, files: PoolFile[] = []): string[] =>
  diffJsonText("sub-01/eeg/sub-01_task-x_eeg.json", before, after, files).atoms.map(line);

describe("diffJson: leaves at the same path", () => {
  test("a document that did not change has no atoms, whatever its layout", () => {
    const diff = diffJsonText(
      "a.json",
      '{"a": 1, "b": [1, 2], "c": {"d": null}}',
      '{\n  "a": 1,\n  "b": [1,2],\n  "c": {"d": null}\n}',
    );
    expect(diff.atoms).toEqual([]);
    expect(diff.family).toBe("json");
    expect(diff.keyColumn).toBeNull();
    expect(diff.counts).toMatchObject({ beforeLeaves: 3, afterLeaves: 3, unchanged: 3 });
  });

  test("a changed value of the same type, and a changed type", () => {
    expect(jsonLines('{"a": "x"}', '{"a": "y"}')).toEqual([
      'json_value_changed | field=.a | before="\\"x\\"" | after="\\"y\\""',
    ]);
    expect(jsonLines('{"a": 1}', '{"a": 2}')).toEqual([
      'json_value_changed | field=.a | before="1" | after="2"',
    ]);
    expect(jsonLines('{"a": "1"}', '{"a": 1}')).toEqual([
      'json_type_changed | field=.a | before="\\"1\\"" | after="1"',
    ]);
    expect(jsonLines('{"a": true}', '{"a": "true"}')).toEqual([
      'json_type_changed | field=.a | before="true" | after="\\"true\\""',
    ]);
    expect(jsonLines('{"a": 1}', '{"a": [1]}')).toEqual([
      'json_type_changed | field=.a | before="1" | after="[1]"',
    ]);
  });

  test("numbers are compared as written: 1.0 is not 1", () => {
    expect(jsonLines('{"a": 1}', '{"a": 1.0}')).toEqual([
      'json_value_changed | field=.a | before="1" | after="1.0"',
    ]);
    expect(jsonLines('{"a": 1e2}', '{"a": 100}')).toEqual([
      'json_value_changed | field=.a | before="1e2" | after="100"',
    ]);
  });

  test("a value that became missing is emptied; a missing one that got a value is filled", () => {
    for (const empty of ["null", '""', '"n/a"', "[]", "{}", "[null]"]) {
      expect(jsonLines('{"a": "x"}', `{"a": ${empty}}`), empty).toEqual([
        expect.stringContaining("json_emptied | field=.a"),
      ]);
      expect(jsonLines(`{"a": ${empty}}`, '{"a": "x"}'), empty).toEqual([
        expect.stringContaining("json_filled | field=.a"),
      ]);
    }
    // None and 0 are values: replacing one is a change, never a fill.
    expect(jsonLines('{"a": "None"}', '{"a": "x"}')).toEqual([
      expect.stringContaining("json_value_changed"),
    ]);
    expect(jsonLines('{"a": 0}', '{"a": "x"}')).toEqual([
      expect.stringContaining("json_type_changed"),
    ]);
    expect(jsonLines('{"a": "x"}', '{"a": "None"}')).toEqual([
      expect.stringContaining("json_value_changed"),
    ]);
  });

  test("a missing value replaced by another missing value is still a change, never a quiet pass", () => {
    expect(jsonLines('{"a": ""}', '{"a": "n/a"}')).toEqual([
      expect.stringContaining("json_value_changed | field=.a"),
    ]);
    expect(jsonLines('{"a": null}', '{"a": ""}')).toEqual([
      expect.stringContaining("json_type_changed | field=.a"),
    ]);
    expect(jsonLines('{"a": []}', '{"a": {}}')).toEqual([
      expect.stringContaining("json_type_changed | field=.a"),
    ]);
  });

  test("a list of scalars is one value: losing an element is a changed value shown whole", () => {
    expect(jsonLines('{"a": [1, 2, 3]}', '{"a": [1, 3]}')).toEqual([
      'json_value_changed | field=.a | before="[1,2,3]" | after="[1,3]"',
    ]);
    expect(jsonLines('{"a": ["x"]}', '{"a": ["x", "y"]}')).toEqual([
      expect.stringContaining('json_value_changed | field=.a | before="[\\"x\\"]"'),
    ]);
  });

  test("a list of objects is diffed per index", () => {
    expect(jsonLines('{"a": [{"k": 1}, {"k": 2}]}', '{"a": [{"k": 1}, {"k": 3}]}')).toEqual([
      'json_value_changed | field=.a[1].k | before="2" | after="3"',
    ]);
    // A removed element of a list of objects is a removed key under that list.
    expect(jsonLines('{"a": [{"k": 1}, {"k": 2}]}', '{"a": [{"k": 1}]}')).toEqual([
      'json_key_removed | field=.a[1] | before="2" | detail="k"',
    ]);
  });

  test("a key that needs brackets keeps its path through a change", () => {
    expect(jsonLines('{"a.b": 1}', '{"a.b": 2}')).toEqual([
      'json_value_changed | field=["a.b"] | before="1" | after="2"',
    ]);
  });

  test("a scalar document changes at the root", () => {
    expect(jsonLines("1", "2")).toEqual([
      'json_value_changed | field= | before="1" | after="2"'.replace("field= ", "field= "),
    ]);
  });
});

describe("diffJson: added and removed keys", () => {
  test("an added key is additive and names its parent, its name and its value", () => {
    expect(jsonLines('{"a": 1}', '{"a": 1, "b": {"c": 2}}')).toEqual([
      'json_key_added | field=.b | after="2" | detail="c"',
    ]);
  });

  test("a removed key with a value is a removed key, shown as parent, name and value", () => {
    expect(jsonLines('{"a": 1, "b": {"c": 2, "d": "x"}}', '{"a": 1}')).toEqual([
      'json_key_removed | field=.b | before="2" | detail="c"',
      'json_key_removed | field=.b | before="\\"x\\"" | detail="d"',
    ]);
  });

  test("214 keys removed from one object share a parent, so they are one class's worth of atoms", () => {
    const keys = Array.from({ length: 214 }, (_, i) => [`HED${i}`, `tag ${i}`]);
    const before = JSON.stringify({ trial_type: Object.fromEntries(keys) });
    const diff = diffJsonText("task-x_events.json", before, JSON.stringify({ trial_type: {} }));
    // The object itself is still there, now empty.
    expect(diff.atoms.filter((a) => a.kind === "json_key_removed")).toHaveLength(214);
    expect(
      new Set(diff.atoms.filter((a) => a.kind === "json_key_removed").map((a) => a.field)),
    ).toEqual(new Set([".trial_type"]));
    expect(diff.counts).toMatchObject({ removed: 214, added: 1 });
  });

  test("a removed key whose value held nothing is a modification, not a loss", () => {
    for (const empty of ["null", '""', '"n/a"', "[]", "{}", '["n/a", null]']) {
      expect(jsonLines(`{"a": 1, "b": ${empty}}`, '{"a": 1}'), empty).toEqual([
        expect.stringContaining("json_empty_key_removed | field= | before="),
      ]);
    }
    // Zero, false and None are values.
    for (const value of ["0", "false", '"None"', '"unknown"', '{"x": 0}']) {
      expect(jsonLines(`{"a": 1, "b": ${value}}`, '{"a": 1}')[0], value).toContain(
        "json_key_removed",
      );
    }
  });

  test("a key replaced by a differently named key with another value is a removal and an addition", () => {
    expect(jsonLines('{"a": 1}', '{"b": 2}')).toEqual([
      'json_key_removed | field= | before="1" | detail="a"',
      'json_key_added | field= | after="2" | detail="b"',
    ]);
  });

  test("an object replaced by a scalar loses its children and gains a leaf", () => {
    expect(jsonLines('{"a": {"b": 1}}', '{"a": "x"}')).toEqual([
      'json_key_removed | field=.a | before="1" | detail="b"',
      'json_key_added | field= | after="\\"x\\"" | detail="a"',
    ]);
  });

  test("an empty object that grew children: the empty leaf is gone (it held nothing) and the children are new", () => {
    expect(jsonLines('{"a": {}}', '{"a": {"b": 1}}')).toEqual([
      'json_empty_key_removed | field= | before="{}" | detail="a"',
      'json_key_added | field=.a | after="1" | detail="b"',
    ]);
  });

  test("a key named __proto__ is an ordinary key", () => {
    expect(jsonLines('{"__proto__": 1, "a": 1}', '{"a": 1}')).toEqual([
      'json_key_removed | field= | before="1" | detail="__proto__"',
    ]);
  });
});

describe("diffJson: renamed keys", () => {
  test("a key respelled by case or punctuation, with the same value under the same parent, is a rename", () => {
    expect(jsonLines('{"MiscChannelCount": 3}', '{"MISCChannelCount": 3}')).toEqual([
      'json_key_renamed | field= | before="3" | after="3" | detail="MiscChannelCount -> MISCChannelCount"',
    ]);
    expect(jsonLines('{"Sampling_Frequency": 250}', '{"SamplingFrequency": 250}')).toEqual([
      expect.stringContaining('detail="Sampling_Frequency -> SamplingFrequency"'),
    ]);
    expect(jsonLines('{"a": {"x y": "v"}}', '{"a": {"X-Y": "v"}}')).toEqual([
      'json_key_renamed | field=.a | before="\\"v\\"" | after="\\"v\\"" | detail="x y -> X-Y"',
    ]);
  });

  test("a key renamed by a relabel rule is a rename", () => {
    expect(jsonLines('{"Fz": 1}', '{"EEG_Fz": 1}')).toEqual([
      expect.stringContaining('detail="Fz -> EEG_Fz"'),
    ]);
    expect(jsonLines('{"EEG_Fz": 1}', '{"Fz": 1}')).toEqual([
      expect.stringContaining('detail="EEG_Fz -> Fz"'),
    ]);
  });

  test("a rename needs the same value, and the same parent", () => {
    expect(jsonLines('{"MiscChannelCount": 3}', '{"MISCChannelCount": 4}')).toEqual([
      'json_key_removed | field= | before="3" | detail="MiscChannelCount"',
      'json_key_added | field= | after="4" | detail="MISCChannelCount"',
    ]);
    // Different parents: the key left .a and a key appeared in .b, so nothing is a rename.
    expect(jsonLines('{"a": {"Key": 3}, "b": {}}', '{"a": {}, "b": {"KEY": 3}}')).toEqual([
      'json_key_removed | field=.a | before="3" | detail="Key"',
      'json_empty_key_removed | field= | before="{}" | detail="b"',
      'json_key_added | field= | after="{}" | detail="a"',
      'json_key_added | field=.b | after="3" | detail="KEY"',
    ]);
  });

  test("two names that are not one name respelled are not a rename", () => {
    expect(jsonLines('{"Fz": 1}', '{"Pz": 1}')).toEqual([
      expect.stringContaining("json_key_removed"),
      expect.stringContaining("json_key_added"),
    ]);
    expect(jsonLines('{"count": 3}', '{"counts": 3}')).toEqual([
      expect.stringContaining("json_key_removed"),
      expect.stringContaining("json_key_added"),
    ]);
  });

  test("an added key is used by at most one rename, taken in before order", () => {
    // Both old names fold to the new one. The first in before order takes it; the second is removed.
    expect(jsonLines('{"a_b": 1, "A-B": 1}', '{"AB": 1}')).toEqual([
      'json_key_renamed | field= | before="1" | after="1" | detail="a_b -> AB"',
      'json_key_removed | field= | before="1" | detail="A-B"',
    ]);
  });

  test("among several added candidates the first in after order is taken, whichever way it matches", () => {
    expect(jsonLines('{"x": 1}', '{"X": 1, "x_": 1}')).toEqual([
      expect.stringContaining('detail="x -> X"'),
      expect.stringContaining('json_key_added | field= | after="1" | detail="x_"'),
    ]);
    // A rule match that comes first in after order wins over a case match that comes later.
    expect(jsonLines('{"Fz": 1}', '{"EEG_Fz": 1, "FZ": 1}')).toEqual([
      expect.stringContaining('detail="Fz -> EEG_Fz"'),
      expect.stringContaining('json_key_added | field= | after="1" | detail="FZ"'),
    ]);
  });

  test("an added leaf that two removed keys both match by a rule is used by the first only", () => {
    // A_Fz_B is Fz wrapped, and also Fz_B wrapped; once Fz has taken it, Fz_B must go on to Q_Fz_B,
    // past the unrelated Zz before it and the used leaf in the middle.
    expect(jsonLines('{"Fz": 1, "Fz_B": 1}', '{"Zz": 1, "A_Fz_B": 1, "Q_Fz_B": 1}')).toEqual([
      expect.stringContaining('detail="Fz -> A_Fz_B"'),
      expect.stringContaining('detail="Fz_B -> Q_Fz_B"'),
      'json_key_added | field= | after="1" | detail="Zz"',
    ]);
  });

  test("a leaf in a list of objects can be renamed under its element", () => {
    expect(jsonLines('{"a": [{"Key": 1}]}', '{"a": [{"key": 1}]}')).toEqual([
      expect.stringContaining('field=.a[0] | before="1" | after="1" | detail="Key -> key"'),
    ]);
  });

  test("an element of a list is not a key and is never renamed", () => {
    // The two elements swapped places. Nothing is a rename, so the old places are removed keys and the
    // new places added ones: more change shown, never less.
    expect(jsonLines('{"a": [1, {"k": 1}]}', '{"a": [{"k": 1}, 1]}')).toEqual([
      'json_key_removed | field=.a | before="1" | detail="[0]"',
      'json_key_removed | field=.a[1] | before="1" | detail="k"',
      'json_key_added | field=.a[0] | after="1" | detail="k"',
      'json_key_added | field=.a | after="1" | detail="[1]"',
    ]);
  });

  test("thousands of keys with one value rename in linear time, and unmatched ones stay unpaired", () => {
    const n = 4000;
    const before = JSON.stringify(
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`key${i}`, "n/a"])),
    );
    const after = JSON.stringify(
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`KEY${i}`, "n/a"])),
    );
    const started = performance.now();
    const diff = diffJsonText("a.json", before, after);
    expect(diff.counts).toMatchObject({ renamed: n, removed: 0, added: 0 });
    const hostile = JSON.stringify(
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`zz${i}`, "n/a"])),
    );
    const unmatched = diffJsonText("a.json", before, hostile);
    expect(unmatched.counts.renamed).toBe(0);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("sidecarApplies: BIDS inheritance, as far as the change model reads it", () => {
  const file = "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-1_eeg.json";

  test("a sidecar in the file's directory or an ancestor, with the same suffix and extension and only entities the file has", () => {
    for (const sidecar of [
      "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_eeg.json",
      "sub-01/ses-02/eeg/sub-01_task-rest_eeg.json",
      "sub-01/ses-02/eeg/task-rest_eeg.json",
      "sub-01/task-rest_eeg.json",
      "task-rest_eeg.json",
      "eeg.json",
      "sub-01/ses-02/eeg/eeg.json",
      "sub-01/ses-02/eeg/run-1_eeg.json",
      "ses-02_eeg.json",
    ]) {
      expect(sidecarApplies(sidecar, file), sidecar).toBe(true);
    }
  });

  test("not another suffix, an entity the file does not have, another value, a sibling or deeper directory, or another extension", () => {
    for (const sidecar of [
      "task-rest_events.json", // another suffix
      "task-rest_channels.json",
      "task-sleep_eeg.json", // another value of an entity the file has
      "acq-hi_eeg.json", // an entity the file does not have
      "sub-01_task-rest_run-2_eeg.json",
      "sub-01_task-rest_acq-a_eeg.json",
      "sub-02/task-rest_eeg.json", // a sibling directory
      "sub-01/eeg/task-rest_eeg.json", // a sibling of the session directory
      "sub-01/ses-03/task-rest_eeg.json",
      "sub-01/ses-02/eeg/deeper/task-rest_eeg.json", // deeper than the file
      "sub-01/ses-02/eeg/task-rest_eeg.tsv", // another extension
      "sourcedata/task-rest_eeg.json",
      "sub-01/ses-02/eeg/sub-01_ses-02_task-rest_run-1_eeg.json", // the file itself
      "sub-01/ses-02/eeg2/task-rest_eeg.json",
      "sub-0/task-rest_eeg.json", // a directory that is a prefix of nothing here
      "sub-01/ses-02/ee/task-rest_eeg.json",
    ]) {
      expect(sidecarApplies(sidecar, file), sidecar).toBe(false);
    }
  });

  test("a name that is not a BIDS name applies to nothing and receives nothing", () => {
    expect(sidecarApplies("notes_eeg.json", file)).toBe(false); // a part before the suffix is not key-value
    expect(sidecarApplies("task-rest_eeg.json", "sub-01_notes_eeg.json")).toBe(false);
    expect(sidecarApplies("dataset_description.json", "x/dataset_description.json")).toBe(false);
    expect(sidecarApplies("task-rest.json", "sub-01_task-rest.json")).toBe(false); // no suffix
    expect(sidecarApplies("noextension", "sub-01_eeg.json")).toBe(false);
    // A single-part name is a suffix: the root eeg.json applies to every eeg sidecar below it.
    expect(sidecarApplies("eeg.json", "sub-01/sub-01_eeg.json")).toBe(true);
    expect(sidecarApplies("participants.json", "participants.json")).toBe(false);
  });
});

describe("diffJson: moved keys", () => {
  const target = "sub-01/eeg/sub-01_task-x_run-1_eeg.json";
  const before = '{"Manufacturer": "BioSemi", "Keep": 1}';
  const after = '{"Keep": 1}';
  const run = (files: PoolFile[], at = target) =>
    diffJsonText(at, before, after, files).atoms.map((a) => a.kind);

  test("a removed key found with the same path and value in a sidecar that applies is moved, not lost", () => {
    const moved = pooled("task-x_eeg.json", null, '{"Manufacturer": "BioSemi"}');
    expect(run([moved])).toEqual(["json_key_moved"]);
    expect(diffJsonText(target, before, after, [moved]).atoms.map(line)).toEqual([
      'json_key_moved | field= | before="\\"BioSemi\\"" | detail="Manufacturer"',
    ]);
    expect(diffJsonText(target, before, after, [moved]).counts).toMatchObject({
      moved: 1,
      removed: 0,
    });
  });

  test("the sidecar may be new or modified, as long as it did not already have that leaf", () => {
    expect(
      run([pooled("eeg.json", '{"Other": 1}', '{"Other": 1, "Manufacturer": "BioSemi"}')]),
    ).toEqual(["json_key_moved"]);
    expect(
      run([pooled("eeg.json", '{"Manufacturer": "BioSemi"}', '{"Manufacturer": "BioSemi"}')]),
    ).toEqual(["json_key_removed"]);
    // It had the key with another value before: the new value is what it has now, so it counts.
    expect(
      run([pooled("eeg.json", '{"Manufacturer": "Other"}', '{"Manufacturer": "BioSemi"}')]),
    ).toEqual(["json_key_moved"]);
  });

  test("not when the value differs, the path differs, or the file is the file itself", () => {
    expect(run([pooled("task-x_eeg.json", null, '{"Manufacturer": "Biosemi"}')])).toEqual([
      "json_key_removed",
    ]);
    expect(run([pooled("task-x_eeg.json", null, '{"manufacturer": "BioSemi"}')])).toEqual([
      "json_key_removed",
    ]);
    expect(
      run([pooled("task-x_eeg.json", null, '{"Hardware": {"Manufacturer": "BioSemi"}}')]),
    ).toEqual(["json_key_removed"]);
    expect(run([pooled(target, null, '{"Manufacturer": "BioSemi"}')])).toEqual([
      "json_key_removed",
    ]);
  });

  test("not into a different suffix, an entity the file does not have, or a sibling directory", () => {
    const content = '{"Manufacturer": "BioSemi"}';
    expect(run([pooled("task-x_events.json", null, content)])).toEqual(["json_key_removed"]);
    expect(run([pooled("task-x_acq-hi_eeg.json", null, content)])).toEqual(["json_key_removed"]);
    expect(run([pooled("task-y_eeg.json", null, content)])).toEqual(["json_key_removed"]);
    expect(run([pooled("sub-02/task-x_eeg.json", null, content)])).toEqual(["json_key_removed"]);
    expect(run([pooled("sub-01/eeg/deeper/task-x_eeg.json", null, content)])).toEqual([
      "json_key_removed",
    ]);
    expect(run([pooled("sub-01/eeg/sub-01_task-x_run-2_eeg.json", null, content)])).toEqual([
      "json_key_removed",
    ]);
  });

  test("a sidecar that does not parse is skipped, so its keys are not found", () => {
    expect(
      run([pooled("task-x_eeg.json", null, '{"Manufacturer": "BioSemi", "Manufacturer": "x"}')]),
    ).toEqual(["json_key_removed"]);
  });

  test("moves consume nothing: one sidecar can account for many files", () => {
    const files = [pooled("task-x_eeg.json", null, '{"Manufacturer": "BioSemi"}')];
    const pool = buildPools(files).json;
    for (const at of [
      target,
      "sub-02/eeg/sub-02_task-x_eeg.json",
      "sub-03/eeg/sub-03_task-x_eeg.json",
    ]) {
      const result = diffJson(at, json(before), json(after), pool);
      expect(result.ok && result.value.atoms.map((a) => a.kind), at).toEqual(["json_key_moved"]);
    }
  });

  test("a rename wins over a move: the key is still in this file", () => {
    const diff = diffJsonText(
      target,
      '{"Manufacturer": "BioSemi"}',
      '{"MANUFACTURER": "BioSemi"}',
      [pooled("task-x_eeg.json", null, '{"Manufacturer": "BioSemi"}')],
    );
    expect(diff.atoms.map((a) => a.kind)).toEqual(["json_key_renamed"]);
  });
});

describe("diffJson: order", () => {
  test("keys that only changed order are a reorder and nothing else", () => {
    expect(jsonLines('{"a": 1, "b": 2}', '{"b": 2, "a": 1}')).toEqual(["json_keys_reordered"]);
    expect(jsonLines('{"x": {"a": 1, "b": 2}, "y": 1}', '{"x": {"b": 2, "a": 1}, "y": 1}')).toEqual(
      ["json_keys_reordered"],
    );
    expect(jsonLines('{"x": 1, "y": 2}', '{"y": 2, "x": 1}')).toEqual(["json_keys_reordered"]);
  });

  test("adding or removing a key does not make the others a reorder; a rename keeps its place", () => {
    expect(jsonLines('{"a": 1, "b": 2, "c": 3}', '{"a": 1, "c": 3, "d": 4}')).toEqual([
      expect.stringContaining("json_key_removed"),
      expect.stringContaining("json_key_added"),
    ]);
    expect(jsonLines('{"a": 1, "Bb": 2, "c": 3}', '{"a": 1, "BB": 2, "c": 3}')).toEqual([
      expect.stringContaining("json_key_renamed"),
    ]);
    expect(jsonLines('{"a": 1, "Bb": 2, "c": 3}', '{"c": 3, "BB": 2, "a": 1}')).toEqual([
      expect.stringContaining("json_key_renamed"),
      "json_keys_reordered",
    ]);
  });

  test("a reorder is reported next to the changes that came with it", () => {
    expect(jsonLines('{"a": 1, "b": 2}', '{"b": 3, "a": 1}')).toEqual([
      expect.stringContaining("json_value_changed | field=.b"),
      "json_keys_reordered",
    ]);
  });
});

describe("diffJson: the totality assertion", () => {
  const empty = buildPools([]).json;
  const before = json('{"a": 1, "b": 2, "c": {"d": 3}}');
  const after = json('{"a": 1, "b": 5, "e": 4}');

  test("a count check that fails turns the file into internal_mismatch", () => {
    expect(diffJsonWith("a.json", before, after, empty, () => false)).toEqual({
      ok: false,
      refusal: "internal_mismatch",
    });
    expect(diffJsonWith("a.json", before, after, empty, () => true).ok).toBe(true);
  });

  test("the entry point runs the real check: diffJson is diffJsonWith over verifyJsonCounts", () => {
    expect(String(diffJson)).toContain("verifyJsonCounts");
    expect(String(diffJson)).not.toContain("=> true");
  });

  test("the check is given the tallies of what was emitted", () => {
    let seen: JsonCounts | null = null;
    diffJsonWith("a.json", before, after, empty, (counts) => {
      seen = counts;
      return true;
    });
    expect(seen).toEqual({
      beforeLeaves: 3,
      afterLeaves: 3,
      unchanged: 1,
      changed: 1,
      emptied: 0,
      filled: 0,
      renamed: 0,
      afterRenamed: 0,
      moved: 0,
      removed: 1,
      emptyRemoved: 0,
      added: 1,
      afterUnchanged: 1,
      afterChanged: 1,
      afterEmptied: 0,
      afterFilled: 0,
      conflicts: 0,
    });
  });

  test("the real check accepts a total count and rejects each way a count can fail to add up", () => {
    const good: JsonCounts = {
      beforeLeaves: 12,
      afterLeaves: 9,
      unchanged: 3,
      changed: 2,
      emptied: 1,
      filled: 1,
      renamed: 1,
      afterRenamed: 1,
      moved: 1,
      removed: 2,
      emptyRemoved: 1,
      added: 1,
      afterUnchanged: 3,
      afterChanged: 2,
      afterEmptied: 1,
      afterFilled: 1,
      conflicts: 0,
    };
    expect(verifyJsonCounts(good)).toBe(true);
    const broken: Partial<JsonCounts>[] = [
      { beforeLeaves: 13 },
      { beforeLeaves: 11 },
      { afterLeaves: 10 },
      { afterLeaves: 8 },
      { removed: 3 },
      { moved: 0 },
      { emptyRemoved: 0 },
      { added: 2 },
      { afterRenamed: 2 },
      { afterChanged: 1 },
      { afterUnchanged: 4 },
      { afterEmptied: 0 },
      { afterFilled: 2 },
      { conflicts: 1 },
    ];
    for (const change of broken) {
      expect(verifyJsonCounts({ ...good, ...change }), JSON.stringify(change)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Generated JSON: the diff is total, and every leaf is accounted for
// ---------------------------------------------------------------------------------------------

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

const JSON_KEYS = [
  "Name",
  "name",
  "MiscChannelCount",
  "MISCChannelCount",
  "Sampling_Frequency",
  "SamplingFrequency",
  "a",
  "b",
  "c",
  "EEGReference",
  "EEG_Reference",
  "x y",
  "a.b",
  "0",
  "K1",
  "K2",
  "__proto__",
];
const JSON_STRINGS = ["", "n/a", "x", "good", "None", "A1", "1", "BioSemi", " "];

function randomPlain(random: () => number, depth: number): Plain {
  const { pick, chance, int } = toolkit(random);
  const scalar = (): Plain => {
    switch (int(0, 5)) {
      case 0:
        return null;
      case 1:
        return chance(0.5);
      case 2:
        return int(0, 3);
      default:
        return pick(JSON_STRINGS);
    }
  };
  if (depth >= 3 || chance(0.4)) return scalar();
  if (chance(0.25)) {
    // A list: of scalars, or of objects.
    const length = int(0, 3);
    if (chance(0.5)) return Array.from({ length }, scalar);
    return Array.from({ length }, () => randomPlain(random, depth + 1));
  }
  const object: { [key: string]: Plain } = {};
  for (let i = int(0, 4); i > 0; i--)
    Object.defineProperty(object, pick(JSON_KEYS), {
      value: randomPlain(random, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return object;
}

/** Every container of a value, so a mutation can pick one. */
function containers(value: Plain, out: (Plain[] | { [key: string]: Plain })[] = []) {
  if (value !== null && typeof value === "object") {
    out.push(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) containers(child, out);
  }
  return out;
}

function clone(value: Plain): Plain {
  return JSON.parse(JSON.stringify(value)) as Plain;
}

/** JSON text for a plain value; `JSON.stringify` keeps a `__proto__` key defined with defineProperty. */
const textOf = (value: Plain): string => JSON.stringify(value);

function mutatePlain(random: () => number, root: Plain): Plain {
  const { pick, chance, int, shuffled } = toolkit(random);
  let value = clone(root);
  for (let step = int(0, 5); step > 0; step--) {
    const nodes = containers(value);
    if (nodes.length === 0) {
      value = randomPlain(random, 1);
      continue;
    }
    const node = pick(nodes);
    if (Array.isArray(node)) {
      if (node.length > 0 && chance(0.5)) node[int(0, node.length - 1)] = randomPlain(random, 2);
      else node.push(randomPlain(random, 2));
      continue;
    }
    const keys = Object.keys(node);
    const target = keys.length > 0 ? pick(keys) : undefined;
    switch (int(0, 6)) {
      case 0:
        if (target !== undefined) delete node[target];
        break;
      case 1:
        Object.defineProperty(node, pick(JSON_KEYS), {
          value: randomPlain(random, 2),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        break;
      case 2:
        if (target !== undefined) node[target] = randomPlain(random, 2);
        break;
      case 3: {
        // Rename a key in place, to a respelling or to another name.
        if (target === undefined) break;
        const renamed = pick([
          target.toUpperCase(),
          `${target}_`,
          `EEG_${target}`,
          target.replace(/_/g, ""),
          pick(JSON_KEYS),
        ]);
        if (renamed === target || renamed in node) break;
        const entries = Object.entries(node).map(
          ([k, v]) => [k === target ? renamed : k, v] as const,
        );
        for (const k of keys) delete node[k];
        for (const [k, v] of entries)
          Object.defineProperty(node, k, {
            value: v,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        break;
      }
      case 4: {
        const entries = shuffled(Object.entries(node));
        for (const k of keys) delete node[k];
        for (const [k, v] of entries)
          Object.defineProperty(node, k, {
            value: v,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        break;
      }
      case 5:
        if (target !== undefined) node[target] = pick([null, "", "n/a", [], {}]);
        break;
      default:
        if (target !== undefined) node[target] = pick(["filled", 7, true]);
    }
  }
  return value;
}

describe("diffJson on generated documents", () => {
  test("1,800 generated pairs: the diff is total, every leaf has exactly one account, and it is deterministic", () => {
    const random = seeded(8675309);
    const { pick, chance } = toolkit(random);
    const seen = new Set<ClassKind>();
    let checked = 0;
    for (let n = 0; n < 1800; n++) {
      const root: Plain = { ...(randomPlain(random, 0) as object), Keep: 1 };
      const next = mutatePlain(random, root);
      const beforeText = textOf(root);
      const afterText = textOf(next);
      const b = parseJson(enc(beforeText));
      const a = parseJson(enc(afterText));
      if (!b.ok || !a.ok)
        throw new Error(`generated text is not JSON: ${beforeText} / ${afterText}`);

      // A sidecar that holds some of the removed top-level keys, applying to the file or not.
      const file = "sub-01/eeg/sub-01_task-x_eeg.json";
      const files: PoolFile[] = [];
      if (chance(0.5) && root !== null && typeof root === "object" && !Array.isArray(root)) {
        const kept: { [key: string]: Plain } = {};
        for (const [key, value] of Object.entries(root))
          if (chance(0.5))
            Object.defineProperty(kept, key, {
              value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
        const where = pick([
          "task-x_eeg.json",
          "eeg.json",
          "sub-01/task-x_eeg.json",
          "task-y_eeg.json",
          "task-x_events.json",
          "sub-02/task-x_eeg.json",
        ]);
        files.push(pooled(where, null, textOf(kept)));
      }
      const pool = buildPools(files).json;
      const result = diffJson(file, b.value.value, a.value.value, pool);
      if (!result.ok)
        throw new Error(`case ${n} refused: ${result.refusal}\n${beforeText}\n${afterText}`);
      checked++;
      const { atoms, counts } = result.value;
      for (const atom of atoms) seen.add(atom.kind);

      expect(verifyJsonCounts(counts), `case ${n}`).toBe(true);
      const beforeLeaves = flattenJson(b.value.value);
      const afterLeaves = flattenJson(a.value.value);
      expect(counts.beforeLeaves).toBe(beforeLeaves.length);
      expect(counts.afterLeaves).toBe(afterLeaves.length);

      // Every before leaf that is not identical in the after document has exactly one account.
      const afterPairs = new Set(afterLeaves.map((leaf) => leafKey(leaf.path, leaf.value)));
      const beforePaths = new Set(beforeLeaves.map((leaf) => leaf.path));
      const lost = beforeLeaves.filter(
        (leaf) => !afterPairs.has(leafKey(leaf.path, leaf.value)),
      ).length;
      const accounts: ClassKind[] = [
        "json_value_changed",
        "json_type_changed",
        "json_emptied",
        "json_filled",
        "json_key_renamed",
        "json_key_moved",
        "json_key_removed",
        "json_empty_key_removed",
      ];
      expect(
        atoms.filter((x) => accounts.includes(x.kind)).length,
        `case ${n}\n${beforeText}\n${afterText}`,
      ).toBe(lost);
      // Every after leaf at a new path is an addition or the new name of a rename.
      const fresh = afterLeaves.filter((leaf) => !beforePaths.has(leaf.path)).length;
      expect(
        atoms.filter((x) => x.kind === "json_key_added" || x.kind === "json_key_renamed").length,
        `case ${n}`,
      ).toBe(fresh);
      // The tallies are the atoms.
      const tally = (kind: ClassKind): number => atoms.filter((x) => x.kind === kind).length;
      expect(tally("json_key_removed"), `case ${n}`).toBe(counts.removed);
      expect(tally("json_key_moved"), `case ${n}`).toBe(counts.moved);
      expect(tally("json_empty_key_removed"), `case ${n}`).toBe(counts.emptyRemoved);
      expect(tally("json_key_added"), `case ${n}`).toBe(counts.added);
      expect(tally("json_key_renamed"), `case ${n}`).toBe(counts.renamed);

      // The same leaves give no atom but possibly a reorder.
      if (lost === 0 && fresh === 0)
        expect(
          atoms.every((x) => x.kind === "json_keys_reordered"),
          `case ${n}`,
        ).toBe(true);

      const again = diffJson(file, b.value.value, a.value.value, buildPools(files).json);
      expect(again.ok && again.value.atoms, `case ${n}`).toEqual(atoms);
    }
    expect(checked).toBe(1800);
    for (const kind of [
      "json_value_changed",
      "json_type_changed",
      "json_emptied",
      "json_filled",
      "json_key_renamed",
      "json_key_moved",
      "json_key_removed",
      "json_empty_key_removed",
      "json_key_added",
      "json_keys_reordered",
    ] as ClassKind[]) {
      expect(seen.has(kind), kind).toBe(true);
    }
  });

  test("a document diffed against itself, however it is laid out, has no atoms", () => {
    const random = seeded(5);
    for (let n = 0; n < 300; n++) {
      const value = randomPlain(random, 0);
      const compact = parseJson(enc(JSON.stringify(value)));
      const spread = parseJson(enc(JSON.stringify(value, null, n % 3 === 0 ? 2 : "\t")));
      if (!compact.ok || !spread.ok) throw new Error("generated text is not JSON");
      const result = diffJson(
        "a.json",
        compact.value.value,
        spread.value.value,
        buildPools([]).json,
      );
      expect(result.ok && result.value.atoms, `case ${n}`).toEqual([]);
    }
  });
});
