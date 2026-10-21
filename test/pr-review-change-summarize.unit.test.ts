/**
 * The change classes of the mechanical change summary (design `.context/plans/pr-review-change-summary.md`
 * sections 4.2, 5, 6, 7 and 8): how the atoms of every file are grouped into classes, ordered,
 * rendered within their bounds, judged complete, and turned into the files the summary accounts
 * for and the loss facts. Pure: real bytes go through the real parsers and diffs, and nothing here
 * touches git or a file.
 *
 * The bar is the one the required check stands on: a file is accounted for only if everything a
 * reader needs to judge every non-additive change in it was rendered completely. A lenient error
 * here is a false pass, so the tests pin what must NOT be accounted for as carefully as what must.
 */

import { describe, expect, test } from "bun:test";
import {
  type Atom,
  CLASS_KINDS,
  type ChangeClass,
  DISPLAY_OF,
  type FileAtoms,
  KIND_WORDS,
  type PoolFile,
  ROLE_OF,
  SUMMARY_LIMITS,
  buildPools,
  classKeyOf,
  classify,
  diffJson,
  diffTable,
  foldIndices,
  parseJson,
  parseTsv,
  renderClasses,
} from "../scripts/ci/pr-review-summary";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Tab-separated text from rows of cells, with LF endings and a final newline. */
function tsv(...rows: string[][]): string {
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

/** A pool file from text; `before` is null for an added file. */
function pooled(path: string, before: string | null, after: string): PoolFile {
  return { path, before: before === null ? null : enc(before), after: enc(after) };
}

/**
 * The atoms of several table and JSON files diffed in the order given against one pool, through
 * the real parsers: what the summary groups. Throws on a refusal, which no test here expects.
 */
function atomsOf(
  files: readonly { path: string; before: string; after: string }[],
  poolFiles: readonly PoolFile[] = [],
): FileAtoms[] {
  const pools = buildPools(poolFiles);
  return files.map((file) => {
    if (file.path.endsWith(".tsv")) {
      const b = parseTsv(enc(file.before));
      const a = parseTsv(enc(file.after));
      if (!b.ok || !a.ok) throw new Error(`test input is not a table: ${file.path}`);
      const diff = diffTable(file.path, b.value, a.value, pools.rows);
      if (!diff.ok) throw new Error(`diff refused: ${diff.refusal}`);
      return { path: file.path, atoms: diff.value.atoms };
    }
    const b = parseJson(enc(file.before));
    const a = parseJson(enc(file.after));
    if (!b.ok || !a.ok) throw new Error(`test input is not JSON: ${file.path}`);
    const diff = diffJson(file.path, b.value.value, a.value.value, pools.json);
    if (!diff.ok) throw new Error(`diff refused: ${diff.refusal}`);
    return { path: file.path, atoms: diff.value.atoms };
  });
}

/** A class as one line, for expectations a person can read. */
function brief(c: ChangeClass): string {
  const parts = [c.kind, c.shape];
  if (c.field !== null) parts.push(`field=${c.field}`);
  if (c.detail !== null) parts.push(`detail=${c.detail}`);
  if (c.rule !== null) parts.push(`rule=${c.rule.kind}:${JSON.stringify(c.rule.gaps)}`);
  parts.push(`${c.items} in ${c.files.size}`);
  return parts.join(" | ");
}

/** The pairs of a class as `before -> after xN` lines, the separator made visible. */
function pairLines(c: ChangeClass): string[] {
  return [...c.pairs].map(([pair, n]) => `${pair.replace("\u{0}", " -> ")} x${n}`);
}

const CHANNELS = ["name", "type", "units"];

describe("the vocabulary of a class", () => {
  test("every kind has words, no two kinds share them, and they are plain platform words", () => {
    const words = CLASS_KINDS.map((kind) => KIND_WORDS[kind]);
    expect(words.every((w) => typeof w === "string" && w.length > 0)).toBe(true);
    expect(new Set(words).size).toBe(CLASS_KINDS.length);
    for (const w of words) expect(w).toMatch(/^[a-z][a-z ]*[a-z]$/);
    expect(Object.keys(KIND_WORDS).sort()).toEqual([...CLASS_KINDS].sort());
  });

  test("the words the design's example uses", () => {
    expect(KIND_WORDS.row_removed).toBe("rows removed");
    expect(KIND_WORDS.key_relabeled).toBe("rows relabeled");
    expect(KIND_WORDS.rows_reordered).toBe("row order changed");
    expect(KIND_WORDS.row_added).toBe("rows added");
    expect(KIND_WORDS.row_relocated).toBe(
      "rows removed and found verbatim in a row this pull request adds",
    );
  });

  test("the paired kinds are exactly the design's, and additive display is additive role", () => {
    const shownBy = (display: string) =>
      CLASS_KINDS.filter((kind) => DISPLAY_OF[kind] === display).sort();
    expect(shownBy("pairs")).toEqual(
      [
        "cell_replaced",
        "cell_emptied",
        "json_value_changed",
        "json_type_changed",
        "json_emptied",
      ].sort(),
    );
    expect(shownBy("removals")).toEqual(
      ["json_key_removed", "json_empty_key_removed", "row_removed"].sort(),
    );
    expect(shownBy("rule")).toEqual(
      [
        "key_relabeled",
        "cell_templated",
        "json_key_renamed",
        "row_relocated",
        "json_key_moved",
        "column_removed",
        "rows_reordered",
        "columns_reordered",
        "json_keys_reordered",
        "format",
      ].sort(),
    );
    for (const kind of CLASS_KINDS) {
      expect(DISPLAY_OF[kind] === "additive", kind).toBe(ROLE_OF[kind] === "additive");
    }
  });
});

describe("foldIndices: a JSON path with every index written [*]", () => {
  test("indices fold at any depth, names stay", () => {
    expect(foldIndices(".a[0].b[12]")).toBe(".a[*].b[*]");
    expect(foldIndices("[3]")).toBe("[*]");
    expect(foldIndices("[0][1].x")).toBe("[*][*].x");
    expect(foldIndices(".HED.go")).toBe(".HED.go");
    expect(foldIndices("")).toBe("");
  });

  test("a key in brackets is passed over whole: a key that reads [0] is not an index", () => {
    expect(foldIndices('.a["[0]"]')).toBe('.a["[0]"]');
    expect(foldIndices('["x\\"[1]"][2]')).toBe('["x\\"[1]"][*]');
    expect(foldIndices('["0"][0]')).toBe('["0"][*]');
    expect(foldIndices('["a\\\\"][7]')).toBe('["a\\\\"][*]');
  });
});

describe("classify: one class per kind, shape, field, rule and detail", () => {
  const path1 = "sub-01/ses-01/ieeg/sub-01_ses-01_task-sleep_run-01_channels.tsv";
  const path2 = "sub-02/ses-01/ieeg/sub-02_ses-01_task-rest_run-02_channels.tsv";

  test("the same logical change in files with different unrelated rows and offsets is one class", () => {
    const files = atomsOf([
      {
        path: path1,
        before: tsv(CHANNELS, ["Z9", "EEG", "uV"], ["A1", "SEEG", "uV"], ["B2", "SEEG", "uV"]),
        after: tsv(CHANNELS, ["Z9", "EEG", "uV"], ["POL A1", "SEEG", "uV"], ["B2", "SEEG", "mV"]),
      },
      {
        path: path2,
        before: tsv(
          CHANNELS,
          ["Q1", "ECG", "uV"],
          ["Q2", "ECG", "uV"],
          ["Q3", "ECG", "uV"],
          ["C7", "EEG", "uV"],
          ["D4", "EEG", "uV"],
        ),
        after: tsv(
          CHANNELS,
          ["Q1", "ECG", "uV"],
          ["Q2", "ECG", "uV"],
          ["Q3", "ECG", "uV"],
          ["POL C7", "EEG", "uV"],
          ["D4", "EEG", "mV"],
        ),
      },
    ]);
    const classes = classify(files);
    // Two classes of 2 items in 2 files each: the tie is broken by the class key.
    expect(classes.map(brief)).toEqual([
      "cell_replaced | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=units | 2 in 2",
      'key_relabeled | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | rule=wrap:["POL ",""] | 2 in 2',
    ]);
    expect(pairLines(classes[0] as ChangeClass)).toEqual(["uV -> mV x2"]);
  });

  test("a different rule, field, shape or kind is another class", () => {
    const electrodes = "sub-01/ieeg/sub-01_electrodes.tsv";
    const files = atomsOf([
      {
        path: path1,
        before: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["E1", "SEEG", "uV"], ["B1", "SEEG", "uV"]),
        after: tsv(
          CHANNELS,
          ["POL A1", "SEEG", "uV"],
          ["EEG E1-Ref", "SEEG", "uV"],
          ["B1", "MISC", "mV"],
        ),
      },
      {
        path: electrodes,
        before: tsv(["name", "x", "units"], ["A1", "1", "uV"]),
        after: tsv(["name", "x", "units"], ["A1", "1", "mV"]),
      },
    ]);
    expect(classify(files).map(brief)).toEqual([
      "cell_replaced | sub-*/ieeg/sub-*_electrodes.tsv | field=units | 1 in 1",
      "cell_replaced | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=type | 1 in 1",
      "cell_replaced | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=units | 1 in 1",
      'key_relabeled | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | rule=wrap:["EEG ","-Ref"] | 1 in 1',
      'key_relabeled | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | rule=wrap:["POL ",""] | 1 in 1',
    ]);
  });

  test("items counts atoms and files counts each file once, however many atoms it holds", () => {
    const files = atomsOf([
      {
        path: path1,
        before: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["A2", "SEEG", "uV"], ["A3", "SEEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "SEEG", "mV"], ["A2", "SEEG", "mV"], ["A3", "SEEG", "V"]),
      },
    ]);
    const [units] = classify(files);
    expect(units?.items).toBe(3);
    expect(units?.files.size).toBe(1);
    expect(pairLines(units as ChangeClass)).toEqual(["uV -> mV x2", "uV -> V x1"]);
  });

  test("the class key is the JSON text of [kind, shape, field, rule, detail], and it is what classify groups by", () => {
    const [file] = atomsOf([
      {
        path: path1,
        before: tsv(CHANNELS, ["A1", "SEEG", "uV"]),
        after: tsv(CHANNELS, ["POL A1", "SEEG", "uV"]),
      },
    ]);
    const atom = file?.atoms[0] as Atom;
    const id = classKeyOf(path1, atom);
    expect(id.key).toBe(
      JSON.stringify([
        "key_relabeled",
        "sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv",
        "name",
        ["wrap", ["POL ", ""], "", false],
        null,
      ]),
    );
    // A rule built with its fields in another order is the same key.
    const reordered = {
      ...atom,
      rule: { repadded: false, shape: "", gaps: ["POL ", ""], kind: "wrap" },
    };
    expect(classKeyOf(path1, reordered as Atom).key).toBe(id.key);
  });

  test("a removed column's count of values is not part of the key: the column removed is the class", () => {
    const files = atomsOf([
      {
        path: path1,
        before: tsv(
          [...CHANNELS, "notes"],
          ["A1", "SEEG", "uV", "bad"],
          ["A2", "SEEG", "uV", "ok"],
        ),
        after: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["A2", "SEEG", "uV"]),
      },
      {
        path: path2,
        before: tsv([...CHANNELS, "notes"], ["A1", "SEEG", "uV", "n/a"]),
        after: tsv(CHANNELS, ["A1", "SEEG", "uV"]),
      },
    ]);
    const classes = classify(files);
    expect(classes.map(brief)).toEqual([
      "column_removed | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=notes | 2 in 2",
    ]);
    expect(classes[0]?.detail).toBeNull();
    expect(classes[0]?.pairs.size).toBe(0);
  });

  test("a relocated row's target shape, a rename's names and a format word are part of the key", () => {
    const poolFiles = [
      pooled(`sourcedata/older/${path1}`, null, tsv(CHANNELS, ["R1", "SEEG", "uV"])),
      pooled(`sourcedata/old/${path2}`, null, tsv(CHANNELS, ["R1", "SEEG", "uV"])),
    ];
    const files = atomsOf(
      [
        {
          path: path1,
          before: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["R1", "SEEG", "uV"]),
          after: `\u{FEFF}${tsv(CHANNELS, ["A1", "SEEG", "uV"])}`,
        },
        {
          path: path2,
          before: tsv(CHANNELS, ["A1", "SEEG", "uV"], ["R1", "SEEG", "uV"]),
          after: tsv(CHANNELS, ["A1", "SEEG", "uV"]).replace(/\n$/, ""),
        },
        {
          path: "task-sleep_ieeg.json",
          before: '{"MiscChannelCount": 2, "EEGReference": "Cz"}',
          after: '{"MISCChannelCount": 2, "eeg_reference": "Cz"}',
        },
      ],
      poolFiles,
    );
    expect(classify(files).map(brief)).toEqual([
      "row_relocated | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | detail=sourcedata/old/sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | 1 in 1",
      "row_relocated | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | field=name | detail=sourcedata/older/sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | 1 in 1",
      "format | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | detail=bom | 1 in 1",
      "format | sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv | detail=final_newline | 1 in 1",
      "json_key_renamed | task-*_ieeg.json | field= | detail=EEGReference -> eeg_reference | 1 in 1",
      "json_key_renamed | task-*_ieeg.json | field= | detail=MiscChannelCount -> MISCChannelCount | 1 in 1",
    ]);
  });

  test("JSON: a value kind is keyed by its leaf path and a key kind by its parent, indices folded to [*]", () => {
    const files = atomsOf([
      {
        path: "sub-01/eeg/sub-01_task-x_events.json",
        before: JSON.stringify({
          trials: [
            { onset: 1, kind: "go" },
            { onset: 2, kind: "go" },
          ],
          HED: { a: "x", b: "y", c: "z" },
        }),
        after: JSON.stringify({
          trials: [
            { onset: 1, kind: "stop" },
            { onset: 2, kind: "stop" },
          ],
          HED: { a: "x" },
        }),
      },
      {
        path: "sub-02/eeg/sub-02_task-x_events.json",
        before: JSON.stringify({ trials: [{ kind: "go" }], HED: { q: "1" } }),
        after: JSON.stringify({ trials: [{ kind: "stop" }], HED: {} }),
      },
    ]);
    const classes = classify(files);
    expect(classes.map(brief)).toEqual([
      "json_key_removed | sub-*/eeg/sub-*_task-*_events.json | field=.HED | 3 in 2",
      "json_value_changed | sub-*/eeg/sub-*_task-*_events.json | field=.trials[*].kind | 3 in 2",
      // `HED` emptied whole in the second file: `{}` is a leaf at a path the before side did
      // not have (it had `.HED.q`), so it is an added key under the root.
      "json_key_added | sub-*/eeg/sub-*_task-*_events.json | field= | 1 in 1",
    ]);
    // A key kind's pairs are `name = value`; the key names are pairs, never the key of the class.
    expect(pairLines(classes[0] as ChangeClass)).toEqual([
      'b = "y" ->  x1',
      'c = "z" ->  x1',
      'q = "1" ->  x1',
    ]);
    expect(pairLines(classes[1] as ChangeClass)).toEqual(['"go" -> "stop" x3']);
  });

  test("a keyless table's removed rows are paired by their whole row text", () => {
    const events = "sub-01/eeg/sub-01_task-x_events.tsv";
    const files = atomsOf([
      {
        path: events,
        before: tsv(["onset", "trial_type"], ["1.0", "go"], ["2.0", "stop"], ["3.0", "go"]),
        after: tsv(["onset", "trial_type"], ["1.0", "go"]),
      },
    ]);
    const [removed] = classify(files);
    expect(brief(removed as ChangeClass)).toBe(
      "row_removed | sub-*/eeg/sub-*_task-*_events.tsv | 2 in 1",
    );
    expect(pairLines(removed as ChangeClass)).toEqual(["2.0\tstop ->  x1", "3.0\tgo ->  x1"]);
  });
});

describe("classify: examples", () => {
  const shape = (n: number) => `sub-0${n}/eeg/sub-0${n}_task-x_channels.tsv`;

  test("the first atom of each of the first two files, in the order the files were given", () => {
    const files = atomsOf(
      [3, 1, 2].map((n) => ({
        path: shape(n),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"]),
        after: tsv(CHANNELS, ["POL A1", "EEG", "uV"], ["POL A2", "EEG", "uV"]),
      })),
    );
    const [relabel] = classify(files);
    expect(relabel?.examples).toEqual([
      `${shape(3)} row "A1" -> "POL A1"`,
      `${shape(1)} row "A1" -> "POL A1"`,
    ]);
  });

  test("a class in one file shows its first two atoms there", () => {
    const files = atomsOf([
      {
        path: shape(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["A2", "EEG", "uV"], ["A3", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "mV"], ["A2", "EEG", "V"], ["A3", "EEG", "mV"]),
      },
    ]);
    expect(classify(files)[0]?.examples).toEqual([
      `${shape(1)} "uV" -> "mV"`,
      `${shape(1)} "uV" -> "V"`,
    ]);
  });

  test("examples are rendered: a key, a row, a column count, a layout change, a JSON key", () => {
    const files = atomsOf([
      {
        path: shape(1),
        before: tsv([...CHANNELS, "notes"], ["A1", "EEG", "uV", "x"], ["R1", "EEG", "uV", "y"]),
        after: `${tsv(CHANNELS, ["A1", "EEG", "uV"], ["New\u{200B}", "EEG", "uV"])}`.replaceAll(
          "\n",
          "\r\n",
        ),
      },
      {
        path: "task-x_eeg.json",
        before: '{"PowerLineFrequency": 50, "Notes": "x"}',
        after: '{"PowerLineFrequency": 60}',
      },
    ]);
    const examples = classify(files).flatMap((c) => c.examples);
    expect(examples).toEqual([
      `${shape(1)} (2 non-missing values)`,
      'task-x_eeg.json key "Notes"',
      `${shape(1)} row "R1"`,
      `${shape(1)} (lf to crlf)`,
      'task-x_eeg.json key ".PowerLineFrequency"',
      `${shape(1)} row "New\\u{200B}"`,
    ]);
  });
});

describe("classify: the order a class renders in (design section 5.1)", () => {
  test("loss, then relocated, then modification, then additive", () => {
    const path = "sub-01/eeg/sub-01_task-x_channels.tsv";
    const files = atomsOf(
      [
        {
          path,
          before: tsv(
            CHANNELS,
            ["A1", "EEG", "uV"],
            ["GONE", "EEG", "uV"],
            ["KEPT", "EEG", "uV"],
            ["B1", "EEG", "uV"],
          ),
          after: tsv(CHANNELS, ["POL A1", "EEG", "uV"], ["B1", "EEG", "mV"], ["NEW", "EEG", "uV"]),
        },
      ],
      [pooled(`sourcedata/old/${path}`, null, tsv(CHANNELS, ["KEPT", "EEG", "uV"]))],
    );
    expect(classify(files).map((c) => `${ROLE_OF[c.kind]} ${c.kind}`)).toEqual([
      "loss row_removed",
      "relocated row_relocated",
      "modification cell_replaced",
      "modification key_relabeled",
      "additive row_added",
    ]);
  });

  test("within a role, more files first, then more items, then the class key in code-unit order", () => {
    const at = (n: number) => `sub-0${n}/eeg/sub-0${n}_task-x_channels.tsv`;
    const files = atomsOf([
      {
        path: at(1),
        before: tsv(
          ["name", "a", "b", "c", "d"],
          ["A1", "1", "1", "1", "1"],
          ["A2", "1", "1", "1", "1"],
        ),
        after: tsv(
          ["name", "a", "b", "c", "d"],
          ["A1", "2", "2", "2", "2"],
          ["A2", "1", "2", "2", "1"],
        ),
      },
      {
        path: at(2),
        before: tsv(["name", "a", "b", "c", "d"], ["A1", "1", "1", "1", "1"]),
        after: tsv(["name", "a", "b", "c", "d"], ["A1", "1", "2", "1", "1"]),
      },
    ]);
    // b: 3 items in 2 files; c: 2 items in 1 file; a and d: 1 item in 1 file each, by key.
    expect(classify(files).map((c) => `${c.field} ${c.items}/${c.files.size}`)).toEqual([
      "b 3/2",
      "c 2/1",
      "a 1/1",
      "d 1/1",
    ]);
  });

  test("the order is a function of the classes alone: files given in another order give the same classes in the same order", () => {
    const specs = [1, 2, 3, 4].map((n) => ({
      path: `sub-0${n}/eeg/sub-0${n}_task-x_channels.tsv`,
      before: tsv(CHANNELS, ["A1", "EEG", "uV"], [`X${n}`, "EEG", "uV"]),
      after: tsv(CHANNELS, ["A1", n % 2 === 0 ? "EOG" : "EEG", "mV"]),
    }));
    const forward = classify(atomsOf(specs)).map((c) => [c.key, c.items, c.files.size]);
    const backward = classify(atomsOf([...specs].reverse())).map((c) => [
      c.key,
      c.items,
      c.files.size,
    ]);
    expect(backward).toEqual(forward);
  });
});

// ---------------------------------------------------------------------------------------------
// Rendering, bounds and completeness
// ---------------------------------------------------------------------------------------------

/** The fenced block of some files, classified and rendered. */
function rendered(
  files: readonly { path: string; before: string; after: string }[],
  poolFiles: readonly PoolFile[] = [],
) {
  const classes = classify(atomsOf(files, poolFiles));
  return { classes, ...renderClasses(classes) };
}

/** A channel table at sub-0n, from rows of [name, type, units]. */
const channels = (n: number) => `sub-0${n}/eeg/sub-0${n}_task-x_channels.tsv`;

/**
 * Every line of a block is one of the platform's own: a class line, an indented line under it, or
 * the last line that counts the classes left out. Nothing a value holds can start a line.
 */
const LINE = /^(C[0-9]+ \| | {4}(?:"|\(|e\.g\. )|\([0-9]+ more change classes not shown\)$)/;

describe("renderClasses: what a class looks like", () => {
  test("a class line, its pairs with their counts, and its examples", () => {
    const { text, shown, complete, cut } = rendered(
      [1, 2].map((n) => ({
        path: channels(n),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["B1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["POL A1", "EEG", "uV"], ["B1", "EEG", "mV"]),
      })),
    );
    expect(text).toBe(
      [
        'C1 | sub-*/eeg/sub-*_task-*_channels.tsv | column "units" | cells replaced',
        '    "uV" -> "mV" x2',
        `    e.g. ${channels(1)} "uV" -> "mV"`,
        `    e.g. ${channels(2)} "uV" -> "mV"`,
        'C2 | sub-*/eeg/sub-*_task-*_channels.tsv | column "name" | rows relabeled: added prefix "POL "',
        `    e.g. ${channels(1)} row "A1" -> "POL A1"`,
        `    e.g. ${channels(2)} row "A1" -> "POL A1"`,
      ].join("\n"),
    );
    expect(shown.size).toBe(2);
    expect(complete.size).toBe(2);
    expect(cut).toBe(0);
  });

  test("a removal shows one side: a keyed row's key, a keyless row's cells, a JSON key's name = value", () => {
    const { text } = rendered([
      {
        path: "participants.tsv",
        before: tsv(["participant_id", "age"], ["sub-01", "30"], ["sub-02", "40"]),
        after: tsv(["participant_id", "age"], ["sub-01", "30"]),
      },
      {
        path: "sub-01/eeg/sub-01_task-x_events.tsv",
        before: tsv(["onset", "trial_type"], ["1.0", "go"], ["2.0", "stop"]),
        after: tsv(["onset", "trial_type"], ["1.0", "go"]),
      },
      {
        path: "task-x_events.json",
        before: '{"HED": {"go": "Press", "stop": "Halt"}}',
        after: '{"HED": {"go": "Press"}}',
      },
    ]);
    expect(text).toBe(
      [
        'C1 | task-*_events.json | under ".HED" | keys removed',
        '    "stop = \\"Halt\\"" x1',
        '    e.g. task-x_events.json key "stop"',
        'C2 | participants.tsv | column "participant_id" | rows removed',
        '    "sub-02" x1',
        '    e.g. participants.tsv row "sub-02"',
        "C3 | sub-*/eeg/sub-*_task-*_events.tsv | rows removed",
        '    "2.0\\tstop" x1',
        '    e.g. sub-01/eeg/sub-01_task-x_events.tsv row "2.0\\tstop"',
      ].join("\n"),
    );
  });

  test("rule kinds name their rule: a relocation's target, a rename, a layout change, a templated cell", () => {
    const path = channels(1);
    const { text, complete } = rendered(
      [
        {
          path,
          before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["R1", "EEG", "uV"], ["B1", "ECOG1", "uV"]),
          after: tsv(CHANNELS, ["A1", "EEG", "uV"], ["B1", "ECOG01", "uV"]).replaceAll(
            "\n",
            "\r\n",
          ),
        },
        {
          path: "task-x_eeg.json",
          before: '{"MiscChannelCount": 2}',
          after: '{"MISCChannelCount": 2}',
        },
      ],
      [pooled(`sourcedata/old/${path}`, null, tsv(CHANNELS, ["R1", "EEG", "uV"]))],
    );
    expect(text).toBe(
      [
        'C1 | sub-*/eeg/sub-*_task-*_channels.tsv | column "name" | rows removed and found verbatim in a row this pull request adds: to sourcedata/old/sub-*/eeg/sub-*_task-*_channels.tsv',
        `    e.g. ${path} row "R1"`,
        'C2 | sub-*/eeg/sub-*_task-*_channels.tsv | column "type" | cells changed by a rule: zero padding of numbers changed',
        `    e.g. ${path} "ECOG1" -> "ECOG01"`,
        "C3 | sub-*/eeg/sub-*_task-*_channels.tsv | file layout changed: line endings changed",
        `    e.g. ${path} (lf to crlf)`,
        'C4 | task-*_eeg.json | top level | keys renamed: "MiscChannelCount -> MISCChannelCount"',
        '    e.g. task-x_eeg.json key "MiscChannelCount -> MISCChannelCount"',
      ].join("\n"),
    );
    expect(complete.size).toBe(4);
  });

  test("a JSON value class names its leaf path, and a scalar document is the whole document", () => {
    const { text } = rendered([
      {
        path: "dataset_description.json",
        before: '{"Authors": ["A"], "Funding": [{"id": 1}, {"id": 2}]}',
        after: '{"Authors": ["B"], "Funding": [{"id": 3}, {"id": 4}]}',
      },
      { path: "x.json", before: "1", after: '"1"' },
    ]);
    expect(text.split("\n").filter((l) => l.startsWith("C"))).toEqual([
      'C1 | dataset_description.json | key ".Funding[*].id" | values changed',
      "C2 | x.json | the whole document | value types changed",
      'C3 | dataset_description.json | key ".Authors" | values changed',
    ]);
    expect(text).toContain('    "[\\"A\\"]" -> "[\\"B\\"]" x1');
    expect(text).toContain('    "1" -> "\\"1\\"" x1\n    e.g. x.json\n');
  });
});

describe("renderClasses: the bounds", () => {
  /** One channel file whose `units` cell takes `n` distinct new values, and its class. */
  const distinctValues = (n: number) =>
    rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...Array.from({ length: n }, (_, i) => [`A${i + 1}`, "EEG", "uV"])),
        after: tsv(CHANNELS, ...Array.from({ length: n }, (_, i) => [`A${i + 1}`, "EEG", `v${i}`])),
      },
    ]);

  test("12 distinct pairs are all shown and the class is complete", () => {
    const { text, complete, classes } = distinctValues(12);
    expect(text.split("\n").filter((l) => l.includes(" -> ") && !l.includes("e.g.")).length).toBe(
      12,
    );
    expect(text).not.toContain("more distinct values");
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(true);
  });

  test("more than 12 distinct pairs show 12, then how many more, and the class is incomplete", () => {
    const { text, complete, shown, classes } = distinctValues(15);
    const pairs = text.split("\n").filter((l) => /^ {4}"uV" -> /.test(l));
    expect(pairs.length).toBe(SUMMARY_LIMITS.maxPairsPerClass);
    expect(text).toContain("\n    (3 more distinct values not shown)\n");
    const key = (classes[0] as ChangeClass).key;
    expect(shown.has(key)).toBe(true);
    expect(complete.has(key)).toBe(false);
  });

  test("the pairs shown are the most frequent, then by text: a function of the class alone", () => {
    const { text } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...Array.from({ length: 14 }, (_, i) => [`A${i}`, "EEG", "uV"])),
        after: tsv(
          CHANNELS,
          ...Array.from({ length: 14 }, (_, i) => [`A${i}`, "EEG", i < 3 ? "zz" : `v${i}`]),
        ),
      },
    ]);
    const pairs = text.split("\n").filter((l) => /^ {4}"uV" -> /.test(l));
    expect(pairs[0]).toBe('    "uV" -> "zz" x3');
    expect(pairs.slice(1, 3)).toEqual(['    "uV" -> "v10" x1', '    "uV" -> "v11" x1']);
  });

  test("a value over 300 characters is cut, marked after its closing quote, and the class is incomplete", () => {
    const long = "x".repeat(301);
    const { text, complete, classes } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", long]),
        after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
      },
    ]);
    expect(text).toContain(`    "${"x".repeat(300)}"...(cut) -> "uV" x1`);
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(false);
  });

  test("a value of exactly 300 characters, astral ones counted as one, is not cut", () => {
    for (const value of ["x".repeat(300), "\u{1F600}".repeat(300)]) {
      const { text, complete, classes } = rendered([
        {
          path: channels(1),
          before: tsv(CHANNELS, ["A1", "EEG", value]),
          after: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        },
      ]);
      expect(text).not.toContain("...(cut)");
      expect(complete.has((classes[0] as ChangeClass).key)).toBe(true);
    }
  });

  test("a removal whose row text is cut is incomplete too", () => {
    const { complete, classes } = rendered([
      {
        path: "sub-01/eeg/sub-01_task-x_events.tsv",
        before: tsv(["onset", "note"], ["1", "ok"], ["2", "y".repeat(400)]),
        after: tsv(["onset", "note"], ["1", "ok"]),
      },
    ]);
    expect(classes[0]?.kind).toBe("row_removed");
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(false);
  });

  test("at most 120 classes are shown; the rest are counted on the last line", () => {
    const columns = Array.from({ length: 121 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    const { text, shown, cut, classes } = rendered([
      {
        path: channels(1),
        before: tsv(["name", ...columns], ["A1", ...columns.map(() => "1")]),
        after: tsv(["name", ...columns], ["A1", ...columns.map(() => "2")]),
      },
    ]);
    expect(classes.length).toBe(121);
    expect(shown.size).toBe(SUMMARY_LIMITS.maxClasses);
    expect(cut).toBe(1);
    expect([...shown]).toEqual(classes.slice(0, 120).map((c) => c.key));
    expect(text.endsWith("\n(1 more change classes not shown)")).toBe(true);
    expect(text).toContain('\nC120 | sub-*/eeg/sub-*_task-*_channels.tsv | column "c119" |');
    expect(text).not.toContain("C121");
  });

  test("the block never exceeds 30,000 characters, and what is shown is a prefix: rendering stops at the first class that does not fit", () => {
    // Six classes of twelve long pairs each (about 7,000 characters apiece), then a short one.
    const big = (k: number, side: string) =>
      Array.from({ length: 12 }, (_, i) => ({ v: `${side}${k}-${i}-${"w".repeat(280)}` }));
    const before: Record<string, unknown> = { small: "a" };
    const after: Record<string, unknown> = { small: "b" };
    for (let k = 0; k < 6; k++) {
      before[`k${k}`] = big(k, "old");
      after[`k${k}`] = big(k, "new");
    }
    const { text, shown, cut, classes } = rendered([
      { path: "x.json", before: JSON.stringify(before), after: JSON.stringify(after) },
    ]);
    expect(classes.map((c) => c.field)).toEqual([
      ".k0[*].v",
      ".k1[*].v",
      ".k2[*].v",
      ".k3[*].v",
      ".k4[*].v",
      ".k5[*].v",
      ".small",
    ]);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_LIMITS.maxSummaryChars);
    expect(shown.size).toBe(4);
    expect([...shown]).toEqual(classes.slice(0, 4).map((c) => c.key));
    expect(cut).toBe(3);
    expect(text.endsWith("\n(3 more change classes not shown)")).toBe(true);
    // The short class would have fit in what was left; it is still not shown, because the one
    // before it was not.
    const alone = renderClasses([classes[6] as ChangeClass]).text;
    expect(text.length + alone.length + 1).toBeLessThan(SUMMARY_LIMITS.maxSummaryChars);
    expect(shown.has((classes[6] as ChangeClass).key)).toBe(false);
  });

  test("a first class too large to fit leaves the block with the count alone", () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({ v: `${i}${"\u{200B}".repeat(299)}` }));
    const bigBefore = { a: pairs, b: pairs, c: pairs, d: pairs, e: pairs, f: pairs };
    const shifted = (k: number) =>
      Array.from({ length: 12 }, (_, i) => ({ v: `${i + k}${"\u{200C}".repeat(299)}` }));
    const bigAfter = {
      a: shifted(100),
      b: shifted(200),
      c: shifted(300),
      d: shifted(400),
      e: shifted(500),
      f: shifted(600),
    };
    // One class: `.a[*].v`... six of them; each line escapes 299 characters to 10 each.
    const { text, shown, cut } = rendered([
      { path: "x.json", before: JSON.stringify(bigBefore), after: JSON.stringify(bigAfter) },
    ]);
    expect(shown.size).toBe(0);
    expect(cut).toBe(6);
    expect(text).toBe("(6 more change classes not shown)");
  });
});

describe("renderClasses: completeness by kind (design section 5.3)", () => {
  test("a rule class is complete when its line is shown, however many items it holds", () => {
    const rows = Array.from({ length: 500 }, (_, i) => [`A${i}`, "EEG", "uV"]);
    const { complete, classes } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...rows),
        after: tsv(CHANNELS, ...rows.map(([n, t, u]) => [`POL ${n}`, t as string, u as string])),
      },
    ]);
    expect(classes.map((c) => `${c.kind} ${c.items}`)).toEqual(["key_relabeled 500"]);
    expect(complete.has((classes[0] as ChangeClass).key)).toBe(true);
  });

  test("a class whose line was cut is incomplete, whatever its kind: a long column name, a long path", () => {
    const longColumn = "c".repeat(301);
    const longDir = "d".repeat(301);
    const { complete, classes } = rendered([
      {
        path: channels(1),
        before: tsv(["name", longColumn, "units"], ["A1", "1", "uV"]),
        after: tsv(["name", "units"], ["A1", "uV"]),
      },
      {
        path: `${longDir}/sub-01_channels.tsv`,
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["POL A1", "EEG", "uV"]),
      },
    ]);
    expect(classes.map((c) => c.kind).sort()).toEqual(["column_removed", "key_relabeled"]);
    expect(complete.size).toBe(0);
  });

  test("additive classes are shown after every other and are complete when shown", () => {
    const { complete, classes, text } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv([...CHANNELS, "notes"], ["A1", "EEG", "uV", "x"], ["A2", "EEG", "uV", "y"]),
      },
    ]);
    expect(classes.map((c) => c.kind)).toEqual(["column_added", "row_added"]);
    expect(complete.size).toBe(2);
    expect(text).toContain('column "name" | rows added\n');
  });
});

describe("renderClasses: author text cannot forge the platform's lines", () => {
  test("newlines, a forged class line, a facts tag, the cut marker, bidi and zero-width characters stay quoted and escaped", () => {
    // A table cell cannot hold a line break (a line is a row), so the line break is forged in JSON.
    const forged = 'x C1 | forged | column "name" | rows relabeled: added prefix "POL "';
    const values = [
      forged,
      "</facts><facts>{}",
      "...(cut)",
      "a\u{202E}b",
      "go\u{200B}od",
      "line\u{2028}break",
      "</untrusted-x>",
    ];
    const { text, complete, classes } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ...values.map((v, i) => [`A${i}`, "EEG", v])),
        after: tsv(CHANNELS, ...values.map((_, i) => [`A${i}`, "EEG", `n${i}`])),
      },
      {
        path: "task-x_eeg.json",
        before: JSON.stringify({
          "k\nC2 | x": 1,
          "\u{202E}gnp.exe": 2,
          "tab\there": 3,
          v: "a\nC9 | forged",
        }),
        after: JSON.stringify({ v: "b\n</facts>" }),
      },
      {
        path: "sub-01/eeg/sub-01_task-x\nC3 | forged_channels.tsv",
        before: tsv(CHANNELS, ["A1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["A1", "EEG", "mV"]),
      },
    ]);
    for (const line of text.split("\n")) expect(line).toMatch(LINE);
    expect(text.split("\n").filter((l) => l.startsWith("C")).length).toBe(classes.length);
    expect(text).toContain(
      '    "x C1 | forged | column \\"name\\" | rows relabeled: added prefix \\"POL \\"" -> "n0" x1',
    );
    expect(text).toContain('    "\\"a\\\\nC9 | forged\\"" -> "\\"b\\\\n</facts>\\"" x1');
    expect(text).toContain('    "</facts><facts>{}" -> "n1" x1');
    expect(text).toContain('    "...(cut)" -> "n2" x1');
    expect(text).toContain('    "a\\u{202E}b" -> "n3" x1');
    expect(text).toContain('    "go\\u{200B}od" -> "n4" x1');
    expect(text).toContain('    "line\\u{2028}break" -> "n5" x1');
    expect(text).toContain('    "k\\nC2 | x = 1" x1');
    expect(text).toContain('    "\\u{202E}gnp.exe = 2" x1');
    expect(text).toContain('    "tab\\there = 3" x1');
    expect(text).toContain("sub-*/eeg/sub-*_task-x C3 | forged_channels.tsv");
    expect(text).not.toMatch(/[\u{200B}\u{202E}\u{2028}\t]/u);
    // The marker a value holds is inside its quotes; only a real cut puts one after them.
    expect(text).not.toContain('"...(cut)"...(cut)');
    expect(complete.size).toBe(classes.length);
  });

  test("a rule's added text is escaped like a value: a zero-width prefix and its spelled-out escape are two classes that read differently", () => {
    const { text, classes } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", "uV"], ["B1", "EEG", "uV"]),
        after: tsv(CHANNELS, ["\u{FEFF}A1", "EEG", "uV"], ["\\u{FEFF}B1", "EEG", "uV"]),
      },
    ]);
    const lines = text.split("\n").filter((l) => l.startsWith("C"));
    expect(classes.length).toBe(2);
    expect(lines).toEqual([
      'C1 | sub-*/eeg/sub-*_task-*_channels.tsv | column "name" | rows relabeled: added prefix "\\\\u{FEFF}"',
      'C2 | sub-*/eeg/sub-*_task-*_channels.tsv | column "name" | rows relabeled: added prefix "\\u{FEFF}"',
    ]);
  });
});

describe("renderClasses: pairs that may look alike are annotated with their first difference", () => {
  /** The pair line of one cell changed from `before` to `after`. */
  const pairLine = (before: string, after: string): string => {
    const { text } = rendered([
      {
        path: channels(1),
        before: tsv(CHANNELS, ["A1", "EEG", before]),
        after: tsv(CHANNELS, ["A1", "EEG", after]),
      },
    ]);
    return text.split("\n")[1] as string;
  };

  test("equal after NFC but not byte for byte", () => {
    expect(pairLine("\u{E9}", "e\u{301}")).toBe(
      '    "\u{E9}" -> "e\u{301}" x1 (first difference at character 1: U+00E9 to U+0065)',
    );
  });

  test("differing only in escaped characters: a zero-width space, a no-break space, a control character", () => {
    expect(pairLine("good", "go\u{200B}od")).toBe(
      '    "good" -> "go\\u{200B}od" x1 (first difference at character 3: U+006F to U+200B)',
    );
    expect(pairLine("a b", "a\u{A0}b")).toBe(
      '    "a b" -> "a\\u{A0}b" x1 (first difference at character 2: U+0020 to U+00A0)',
    );
    expect(pairLine("ab", "a\u{7}b")).toBe(
      '    "ab" -> "a\\u0007b" x1 (first difference at character 2: U+0062 to U+0007)',
    );
  });

  test("a look-alike from another script", () => {
    expect(pairLine("a", "\u{430}")).toBe(
      '    "a" -> "\u{430}" x1 (first difference at character 1: U+0061 to U+0430)',
    );
  });

  test("two values cut at the same place render alike, and the note says where they differ", () => {
    const stem = "s".repeat(300);
    expect(pairLine(`${stem}A`, `${stem}B`)).toBe(
      `    "${stem}"...(cut) -> "${stem}"...(cut) x1 (first difference at character 301: U+0041 to U+0042)`,
    );
  });

  test("an ordinary change gets no note", () => {
    expect(pairLine("uV", "mV")).toBe('    "uV" -> "mV" x1');
    expect(pairLine("1", "10")).toBe('    "1" -> "10" x1');
  });

  test("JSON values are compared as their canonical text", () => {
    const { text } = rendered([
      { path: "x.json", before: '{"a": "x y"}', after: '{"a": "x\\u00a0y"}' },
    ]);
    expect(text.split("\n")[1]).toBe(
      '    "\\"x y\\"" -> "\\"x\\u{A0}y\\"" x1 (first difference at character 3: U+0020 to U+00A0)',
    );
  });
});
