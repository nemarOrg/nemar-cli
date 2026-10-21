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
  CLASS_KINDS,
  type ClassKind,
  ROLE_OF,
  type RelabelRule,
  isMissingCell,
  isMissingJson,
  parseJson,
  relabelRule,
  ruleWords,
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
    expect(relabelRule("a-b", "a-X-b", cells)).toEqual(rule("insert", ["", "", "X-", ""], "LOL"));
  });

  test("delete: text was removed from between the parts of the value", () => {
    expect(relabelRule("EEGGA_01REF", "GA01", cells)).toEqual(
      rule("delete", ["EEG", "_", "REF"], "LD"),
    );
    expect(relabelRule("a-X-b", "a-b", cells)).toEqual(rule("delete", ["", "", "X-", ""], "LOL"));
  });

  test("the character rule exists only when asked for, and then describes the longer string exactly", () => {
    expect(relabelRule("DCEMBRACE", "DC EMBRACE-REF", cells)).toBeNull();
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
    // 1 is not 10, so no run rule holds.
    expect(relabelRule("A1", "A10", { chars: false })).toBeNull();
    expect(relabelRule("A10", "A1", { chars: false })).toBeNull();
    // With characters allowed, A10 IS A1 with a 0 after it. That is the design's character rule
    // (section 4.3 step 5), asked for only by a keyed pairing whose every other cell is equal.
    expect(relabelRule("A1", "A10", { chars: true })).toEqual(rule("insert", ["", "", "0"], "c2"));
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

  test("digits compare by value only as ASCII digits: a superscript is the text it is", () => {
    // The superscript two is a number character but has no value this module vouches for.
    expect(relabelRule("A\u{B2}", "POL A\u{B2}", { chars: false })).toEqual(
      rule("wrap", ["POL ", ""]),
    );
    expect(relabelRule("A\u{B2}", "A2", { chars: false })).toBeNull();
    // Arabic-Indic digits are compared as text, so they do not repad against ASCII ones.
    expect(relabelRule("A\u{661}", "A01", { chars: false })).toBeNull();
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

  test("a rule is a function of the two strings alone", () => {
    for (const [a, b] of [
      ["GA01", "EEGGA_01REF"],
      ["A1", "POL A01"],
      ["DCEMBRACE", "DC EMBRACE-REF"],
      ["'G1'    ", "'G1'"],
    ] as const) {
      expect(relabelRule(a, b, { chars: true })).toEqual(relabelRule(a, b, { chars: true }));
    }
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
