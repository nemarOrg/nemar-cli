/**
 * `shared/compute-naming.ts`, the port of nemar-process `common/naming.py` (epic #2324 N1b), and
 * `shared/contract/compute-naming-vectors.json`, its answers for nemar-process to replay against `naming.py`.
 *
 * The literal cases below are `tests/recipes/test_naming.py` at nemar-process d090d84e, plus the cases the
 * live views need (an existing `desc-x` under nemar-ica, a recording at the dataset root) and the edges
 * where a port could drift (an empty `desc`, a second `desc`, slashes, a name with `_eeg.` twice).
 * The vectors file is what this test computes from {@link CASES}; `NEMAR_WRITE_NAMING_VECTORS=1` rewrites it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NotARecordingError,
  datasetPath,
  label,
  matchRecording,
  productPath,
  productStem,
} from "../shared/compute-naming";
import { COMPUTE_RECIPES, recipeLabel, recipeRequiredOutputs } from "../shared/compute-recipes";

const RECORDING = "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf";

describe("the port of naming.py's own tests", () => {
  test("the label is the recipe id without its hyphens", () => {
    expect(label("nemar-floor")).toBe("nemarfloor");
    expect(label("nemar-ica")).toBe("nemarica");
    expect(label("a-b-c")).toBe("abc");
  });

  test("the stem is the source name without its suffix and with the label last", () => {
    expect(productStem(RECORDING, "nemarfloor")).toBe("sub-CUCOV076_task-COVID_desc-nemarfloor");
  });

  test("a product file sits beside its recording in the same directory", () => {
    expect(productPath(RECORDING, "nemarfloor", "channels", "tsv")).toBe(
      "sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_desc-nemarfloor_channels.tsv",
    );
    expect(
      productPath(
        "sub-01/ses-pre/eeg/sub-01_ses-pre_task-rest_run-02_eeg.vhdr",
        "nemarica",
        "signalJourney",
        "json",
      ),
    ).toBe("sub-01/ses-pre/eeg/sub-01_ses-pre_task-rest_run-02_desc-nemarica_signalJourney.json");
  });

  test("a source that already has a desc entity keeps it inside the label", () => {
    const source = "sub-01/eeg/sub-01_task-rest_desc-clean_eeg.set";
    expect(productStem(source, "nemarfloor")).toBe("sub-01_task-rest_desc-cleannemarfloor");
    expect(productPath(source, "nemarfloor", "qc", "json")).toBe(
      "sub-01/eeg/sub-01_task-rest_desc-cleannemarfloor_qc.json",
    );
  });

  test("an edf and a set of one recording share a stem", () => {
    expect(productStem(RECORDING, "nemarfloor")).toBe(
      productStem(RECORDING.replace(".edf", ".set"), "nemarfloor"),
    );
  });

  test("the dataset-level files have no subject", () => {
    expect(datasetPath("nemarfloor", "signalJourney", "json")).toBe(
      "desc-nemarfloor_signalJourney.json",
    );
    expect(datasetPath("nemarfloor", "recordings", "tsv")).toBe("desc-nemarfloor_recordings.tsv");
  });

  test.each(["sub-01/eeg/sub-01_task-x_channels.tsv", "sub-01/eeg/notarecording.edf", "eeg.edf"])(
    "a path that is not a recording is refused: %s",
    (bad) => {
      expect(() => productStem(bad, "nemarfloor")).toThrow(NotARecordingError);
      expect(() => productStem(bad, "nemarfloor")).toThrow(/not a recording/);
      expect(() => productPath(bad, "nemarfloor", "qc", "json")).toThrow(NotARecordingError);
    },
  );
});

describe("the cases the live views need", () => {
  test("an existing desc-x becomes desc-xnemarica", () => {
    expect(
      productPath("sub-01/eeg/sub-01_task-rest_desc-x_eeg.edf", "nemarica", "spectrum", "tsv"),
    ).toBe("sub-01/eeg/sub-01_task-rest_desc-xnemarica_spectrum.tsv");
  });

  test("a recording at the dataset root has its product at the root", () => {
    expect(productPath("sub-01_task-rest_eeg.edf", "nemarica", "chanlocs", "tsv")).toBe(
      "sub-01_task-rest_desc-nemarica_chanlocs.tsv",
    );
  });

  test("only the first desc entity carries the label, and an empty desc still does", () => {
    expect(productStem("sub-01_desc-a_acq-b_desc-c_eeg.edf", "nemarica")).toBe(
      "sub-01_desc-anemarica_acq-b_desc-c",
    );
    expect(productStem("sub-01_desc-_eeg.edf", "nemarica")).toBe("sub-01_desc-nemarica");
    // `description-x` is not a desc entity
    expect(productStem("sub-01_description-x_eeg.edf", "nemarica")).toBe(
      "sub-01_description-x_desc-nemarica",
    );
  });

  test("the label and the dataset record agree with the recipe registry", () => {
    for (const recipe of COMPUTE_RECIPES) {
      expect(label(recipe.name)).toBe(recipeLabel(recipe));
      expect(`product/${datasetPath(label(recipe.name), "signalJourney", "json")}`).toBe(
        recipeRequiredOutputs(recipe).record,
      );
      expect(`product/${datasetPath(label(recipe.name), "recordings", "tsv")}`).toBe(
        recipeRequiredOutputs(recipe).table,
      );
    }
  });

  test("matchRecording takes the last _eeg. and refuses a slash", () => {
    expect(matchRecording("a_eeg.b_eeg.edf")).toEqual({ stem: "a_eeg.b", extension: "edf" });
    expect(matchRecording("x_eeg.edf")).toEqual({ stem: "x", extension: "edf" });
    expect(matchRecording("_eeg.edf")).toBeNull();
    expect(matchRecording("x_eeg.")).toBeNull();
    expect(matchRecording("x/y_eeg.edf")).toBeNull();
  });
});

type Call =
  | { fn: "label"; args: [string] }
  | { fn: "product_stem"; args: [string, string] }
  | { fn: "product_path"; args: [string, string, string, string] }
  | { fn: "dataset_path"; args: [string, string, string] };

/** Each case: a name, the `naming.py` function and its arguments. */
const CASES: Array<[string, Call]> = [
  ["label_floor", { fn: "label", args: ["nemar-floor"] }],
  ["label_ica", { fn: "label", args: ["nemar-ica"] }],
  ["label_no_hyphen", { fn: "label", args: ["abc"] }],
  ["label_many_hyphens", { fn: "label", args: ["a-b--c-"] }],
  ["stem_plain", { fn: "product_stem", args: [RECORDING, "nemarfloor"] }],
  [
    "stem_existing_desc",
    { fn: "product_stem", args: ["sub-01/eeg/sub-01_task-rest_desc-clean_eeg.set", "nemarfloor"] },
  ],
  [
    "stem_first_desc_only",
    { fn: "product_stem", args: ["sub-01_desc-a_desc-c_eeg.edf", "nemarica"] },
  ],
  ["stem_empty_desc", { fn: "product_stem", args: ["sub-01_desc-_eeg.edf", "nemarica"] }],
  [
    "stem_description_is_not_desc",
    { fn: "product_stem", args: ["sub-01_description-x_eeg.edf", "nemarica"] },
  ],
  ["stem_eeg_twice", { fn: "product_stem", args: ["a_eeg.b_eeg.edf", "nemarica"] }],
  [
    "path_session_run",
    {
      fn: "product_path",
      args: [
        "sub-01/ses-pre/eeg/sub-01_ses-pre_task-rest_run-02_eeg.vhdr",
        "nemarica",
        "signalJourney",
        "json",
      ],
    },
  ],
  [
    "path_existing_desc_x_ica",
    {
      fn: "product_path",
      args: ["sub-01/eeg/sub-01_task-rest_desc-x_eeg.edf", "nemarica", "spectrum", "tsv"],
    },
  ],
  [
    "path_root_level_recording",
    { fn: "product_path", args: ["sub-01_task-rest_eeg.edf", "nemarica", "chanlocs", "tsv"] },
  ],
  [
    "path_ic_classes_json",
    { fn: "product_path", args: [RECORDING, "nemarica", "icclasses", "json"] },
  ],
  [
    "path_repeated_slash",
    { fn: "product_path", args: ["sub-01//eeg/sub-01_task-x_eeg.edf", "nemarica", "qc", "json"] },
  ],
  [
    "path_trailing_slash_in_directory",
    { fn: "product_path", args: ["sub-01/eeg//sub-01_task-x_eeg.edf", "nemarica", "qc", "json"] },
  ],
  [
    "path_leading_slash",
    { fn: "product_path", args: ["/sub-01_task-x_eeg.edf", "nemarica", "qc", "json"] },
  ],
  [
    "path_not_a_recording_channels",
    {
      fn: "product_path",
      args: ["sub-01/eeg/sub-01_task-x_channels.tsv", "nemarica", "qc", "json"],
    },
  ],
  [
    "path_not_a_recording_no_suffix",
    { fn: "product_path", args: ["sub-01/eeg/notarecording.edf", "nemarica", "qc", "json"] },
  ],
  [
    "path_not_a_recording_bare",
    { fn: "product_path", args: ["eeg.edf", "nemarica", "qc", "json"] },
  ],
  [
    "path_not_a_recording_directory",
    { fn: "product_path", args: ["sub-01/eeg/", "nemarica", "qc", "json"] },
  ],
  ["dataset_record", { fn: "dataset_path", args: ["nemarfloor", "signalJourney", "json"] }],
  ["dataset_table", { fn: "dataset_path", args: ["nemarica", "recordings", "tsv"] }],
  ["dataset_quality", { fn: "dataset_path", args: ["nemarica", "dataquality", "json"] }],
];

function run(call: Call): { result: string } | { refused: "not_a_recording" } {
  try {
    switch (call.fn) {
      case "label":
        return { result: label(...call.args) };
      case "product_stem":
        return { result: productStem(...call.args) };
      case "product_path":
        return { result: productPath(...call.args) };
      case "dataset_path":
        return { result: datasetPath(...call.args) };
    }
  } catch (e) {
    if (e instanceof NotARecordingError) return { refused: "not_a_recording" };
    throw e;
  }
}

const VECTORS_PATH = join(import.meta.dir, "../shared/contract/compute-naming-vectors.json");

const computed = {
  format: "nemar.compute-naming-vectors.v1",
  note: "Generated by test/compute-naming.unit.test.ts from shared/compute-naming.ts, the port of nemar-process recipes/nemar_process/common/naming.py; do not hand-edit (NEMAR_WRITE_NAMING_VECTORS=1 rewrites it). Each vector calls the naming.py function `fn` with `args`: `result` is its return value, `refused: not_a_recording` a ValueError whose text starts with 'not a recording'.",
  vectors: CASES.map(([name, call]) => ({ name, fn: call.fn, args: call.args, ...run(call) })),
};

describe("the naming vectors", () => {
  test("cover every function, the live-views cases and a refusal", () => {
    const v = computed.vectors;
    for (const fn of ["label", "product_stem", "product_path", "dataset_path"]) {
      expect(
        v.some((c) => c.fn === fn),
        fn,
      ).toBe(true);
    }
    expect(v.find((c) => c.name === "path_existing_desc_x_ica")).toMatchObject({
      result: "sub-01/eeg/sub-01_task-rest_desc-xnemarica_spectrum.tsv",
    });
    expect(v.find((c) => c.name === "path_root_level_recording")).toMatchObject({
      result: "sub-01_task-rest_desc-nemarica_chanlocs.tsv",
    });
    expect(v.find((c) => c.name === "path_repeated_slash")).toMatchObject({
      result: "sub-01//eeg/sub-01_task-x_desc-nemarica_qc.json",
    });
    expect(v.find((c) => c.name === "path_trailing_slash_in_directory")).toMatchObject({
      result: "sub-01/eeg/sub-01_task-x_desc-nemarica_qc.json",
    });
    expect(v.find((c) => c.name === "path_leading_slash")).toMatchObject({
      result: "/sub-01_task-x_desc-nemarica_qc.json",
    });
    expect(v.filter((c) => "refused" in c).length).toBe(4);
    expect(new Set(v.map((c) => c.name)).size).toBe(v.length);
  });

  test("the file equals what the code computes", () => {
    if (process.env.NEMAR_WRITE_NAMING_VECTORS === "1") {
      writeFileSync(VECTORS_PATH, `${JSON.stringify(computed, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(VECTORS_PATH, "utf8"))).toEqual(computed);
  });
});
