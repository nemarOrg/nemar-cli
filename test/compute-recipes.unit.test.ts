/**
 * The recipe registry of NEMAR's pipeline dispatch (epic #2005 phase A6, #2011; ADR 0118).
 *
 * The registry's numbers are initial and the owner adjusts them, so what is pinned is not a value
 * but a shape: every entry is a valid job under the strict `JobSpecSchema` and inside the partition
 * table; the command line a recipe job gets is an absolute argument vector that fits the launch
 * specification; the image digest argument is read back exactly or not at all; and the recipe's own
 * record is read only in the shape the recipe writes. The module is pure and import-free, and the
 * test reads its source to hold it to that.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPUTE_RECIPES,
  PIPELINE_LIVE_STAMP_STATES,
  PIPELINE_STAMP_STATES,
  RECIPE_DATASET_ROOT,
  RECIPE_IMAGE_DIGEST_FLAG,
  RECIPE_INPUTS,
  RECIPE_INPUT_EXECUTOR,
  RECIPE_PLACEHOLDER_REFUSAL,
  RECIPE_PLUGIN_STEPS,
  RECIPE_PRE_CHECKS,
  RECIPE_PRODUCT_DIR,
  RECORD_STEP,
  type RecipeExecutor,
  type RecipeInput,
  STAMP_INPUT_FIELDS,
  STAMP_REFUSAL_REASONS,
  STANDARD_CHECKPOINTS,
  STORED_CHECKPOINT,
  checkpointOfStep,
  declaredCheckpoints,
  defaultInput,
  findRecipe,
  placeholderRefusal,
  readRecipeRecord,
  recipeArguments,
  recipeCheckpointMap,
  recipeCommand,
  recipeImageDigestArg,
  recipeLabel,
  recipeRequiredOutputs,
  recipeRunsInput,
  recipeRunsOn,
  stampInputFields,
} from "../shared/compute-recipes";
import {
  COMPUTE_MAX_OUTPUT_FILES,
  JobSpecSchema,
  LAUNCHER_OUTPUTS_DIR,
  PARTITIONS,
  type PartitionName,
  estimateSuMilli,
} from "../shared/contract/compute";
import { launchSpecFits } from "../shared/contract/compute-launch";
import { PROGRESS_STEP_RE } from "../shared/contract/compute-progress";
import { PLUGIN_CHECKPOINTS, PLUGIN_NAME_RE } from "../shared/contract/plugin-manifest";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `ghcr.io/example/nemar-python@${DIGEST}`;

function specOf(recipe: (typeof COMPUTE_RECIPES)[number], over: Record<string, unknown> = {}) {
  return JobSpecSchema.parse({
    name: `${recipe.name} nm000104 v1.0.2`,
    runtime: "image",
    image: IMAGE,
    recipe: recipe.name,
    command: recipeCommand(recipe),
    args: recipeArguments({ datasetId: "nm000104", tag: "v1.0.2", imageDigest: DIGEST }),
    datasets: [{ id: "nm000104", version: "v1.0.2" }],
    partition: recipe.partition,
    nodes: recipe.nodes,
    cores: recipe.cores,
    ...(recipe.memoryMb === undefined ? {} : { memory_mb: recipe.memoryMb }),
    gpus: recipe.gpus,
    minutes: recipe.minutes,
    ...over,
  });
}

describe("the registry", () => {
  test("names are unique, and each is a recipe name the job schema takes", () => {
    const names = COMPUTE_RECIPES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("nemar-floor");
    expect(names).toContain("nemar-ica");
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  });

  test("the floor is automatic on a CPU partition, the ICA is not and needs a GPU", () => {
    const floor = findRecipe("nemar-floor");
    const ica = findRecipe("nemar-ica");
    expect(floor).toMatchObject({ autoDispatch: true, partition: "shared", gpus: 0 });
    expect(ica).toMatchObject({ autoDispatch: false, partition: "gpu-shared" });
    expect(PARTITIONS[ica?.partition as PartitionName].pool).toBe("gpu");
    expect(ica?.gpus).toBeGreaterThanOrEqual(1);
  });

  test("nemar-floor and nemar-ica are each ONE entry for both inputs and both executors (MUTATION: leave zarr or runner out of nemar-ica)", () => {
    for (const name of ["nemar-floor", "nemar-ica"]) {
      expect([name, findRecipe(name)?.inputs, findRecipe(name)?.executors]).toEqual([
        name,
        ["bids", "zarr"],
        ["tapis", "runner"],
      ]);
    }
    // The transition name is gone from the registry.
    expect(findRecipe("nemar-floor-zarr")).toBeNull();
    expect(COMPUTE_RECIPES.map((r) => r.name)).toEqual(["nemar-floor", "nemar-ica"]);
  });

  test("nemar-floor's outputs are desc-nemarfloor_* for both inputs, and no label of the transition name remains", () => {
    const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
    expect(recipeLabel(floor)).toBe("nemarfloor");
    expect(recipeRequiredOutputs(floor)).toEqual({
      record: "product/desc-nemarfloor_signalJourney.json",
      table: "product/desc-nemarfloor_recordings.tsv",
    });
    for (const recipe of COMPUTE_RECIPES) expect(recipeLabel(recipe)).not.toContain("zarr");
  });

  test("every input a recipe lists is a word of the shared list, and the list is the stamp column's", () => {
    for (const recipe of COMPUTE_RECIPES) {
      expect(recipe.inputs.length).toBeGreaterThan(0);
      expect(new Set(recipe.inputs).size).toBe(recipe.inputs.length);
      for (const input of recipe.inputs) expect(RECIPE_INPUTS).toContain(input);
    }
    expect(RECIPE_INPUTS).toEqual(["bids", "zarr"]);
  });

  test("nemar-ica is no longer a placeholder (lifted 2026-11-27): an administrator's run, BIDS on Tapis and Zarr on a runner, never automatic (MUTATION: set it back)", () => {
    const ica = findRecipe("nemar-ica");
    expect(ica?.placeholder).toBe(false);
    expect([ica?.autoDispatch, ica?.executors, ica?.inputs]).toEqual([
      false,
      ["tapis", "runner"],
      ["bids", "zarr"],
    ]);
    expect(findRecipe("nemar-floor")?.placeholder).toBeFalsy();
  });

  test("placeholderRefusal refuses a recipe whose entry says placeholder, and only that (MUTATION: read a missing flag as a placeholder; drop the check)", () => {
    const floor = findRecipe("nemar-floor");
    if (floor === null) throw new Error("no nemar-floor");
    // A registry entry as a future placeholder would be written: the floor's, with the flag set.
    const future = Object.freeze({ ...floor, name: "nemar-future", placeholder: true });
    expect(placeholderRefusal(future)).toBe(RECIPE_PLACEHOLDER_REFUSAL);
    expect(RECIPE_PLACEHOLDER_REFUSAL).toBe("recipe_placeholder");
    expect(placeholderRefusal({ ...floor, placeholder: false })).toBeNull();
    const { placeholder: _absent, ...unflagged } = floor;
    expect(placeholderRefusal(unflagged)).toBeNull();
  });

  test("findRecipe is exact: no case fold, no trim, and a non-string is none", () => {
    for (const bad of ["Nemar-Floor", " nemar-floor", "nemar-floor ", "", null, undefined, 7, {}]) {
      expect(findRecipe(bad)).toBeNull();
    }
    expect(findRecipe("nemar-floor")?.name).toBe("nemar-floor");
    // Own properties only: nothing is looked up by a prototype key.
    expect(findRecipe("constructor")).toBeNull();
  });

  for (const recipe of COMPUTE_RECIPES) {
    describe(recipe.name, () => {
      test("is a valid job under the strict schema and fits the launch specification", () => {
        const spec = specOf(recipe);
        expect(spec.recipe).toBe(recipe.name);
        expect(launchSpecFits(spec)).toBe(true);
      });

      test("is inside the partition table: the pool matches and the ceiling holds", () => {
        const partition = PARTITIONS[recipe.partition as PartitionName];
        expect(partition).toBeDefined();
        // A partition with a ceiling is offered to people too; NEMAR's own jobs may exceed none of it
        // by default, so the entry fits its ceiling where it has one.
        if (partition.ceiling) {
          expect(recipe.nodes).toBeLessThanOrEqual(partition.ceiling.maxNodes);
          expect(recipe.cores).toBeLessThanOrEqual(partition.ceiling.maxCoresPerNode);
          expect(recipe.gpus).toBeLessThanOrEqual(partition.ceiling.maxGpusPerNode);
          expect(recipe.minutes).toBeLessThanOrEqual(partition.ceiling.maxMinutes);
        }
        expect(estimateSuMilli(specOf(recipe))).toBeGreaterThan(0);
      });

      test("its version and engine are plain words the stamp's columns take", () => {
        expect(recipe.version).toMatch(/^[0-9A-Za-z._+-]{1,64}$/);
        expect(recipe.engine).toMatch(/^[0-9A-Za-z._+@-]{1,64}$/);
      });

      test("every plugin step sits in its last declared checkpoint, where a skipped plugin cannot break the cascade (ADR 0134 amendment of 2026-11-26)", () => {
        const plugins: readonly string[] = RECIPE_PLUGIN_STEPS;
        const last = recipe.checkpoints[recipe.checkpoints.length - 1];
        for (const c of recipe.checkpoints) {
          for (const step of c.steps) {
            if (plugins.includes(step))
              expect([step, c.checkpoint]).toEqual([step, last.checkpoint]);
          }
        }
      });

      test("its required outputs are under the product directory and named by its label", () => {
        const out = recipeRequiredOutputs(recipe);
        const label = recipeLabel(recipe);
        expect(out.record).toBe(`product/desc-${label}_signalJourney.json`);
        expect(out.table).toBe(`product/desc-${label}_recordings.tsv`);
        // The product directory the arguments name is that prefix under the launcher's outputs.
        expect(RECIPE_PRODUCT_DIR).toBe(`/${LAUNCHER_OUTPUTS_DIR}/product`);
      });
    });
  }

  test("the stamp's live states are a subset of its states", () => {
    for (const s of PIPELINE_LIVE_STAMP_STATES) {
      expect((PIPELINE_STAMP_STATES as readonly string[]).includes(s)).toBe(true);
    }
  });
});

/**
 * What the image `COMPUTE_RUNTIME_IMAGE` pins (the CUDA image of nemar-process v0.1.2) reports as
 * `nemar-recipe version`, as `test/fixtures/nemar-recipe-version.json` records it: versions, digests, inputs and
 * checkpoints. The file is ASSEMBLED, not printed by the image (its `provenance` says how): the source output at the
 * commit and lock the image's labels name, with the flavor and the amica15 digest read from the image's layers. The
 * registry's tuple is a copy of it, and the inputs the registry lists are the ones the recipe says it reads.
 */
const IMAGE_VERSION = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "nemar-recipe-version.json"), "utf8"),
) as {
  image: string;
  version: {
    eegprep: string;
    flavor: string;
    recipes: Record<string, string>;
    inputs: Record<string, string[]>;
    checkpoints: Record<string, { checkpoint: string; steps: string[] }[]>;
  };
};

describe("the registry's tuple is the image's (portable compute card Q1z)", () => {
  test("every recipe's version and engine equal the image's version output, and its inputs the image's (MUTATION: nemar-ica's version one step off)", () => {
    expect(Object.keys(IMAGE_VERSION.version.recipes).sort()).toEqual(
      COMPUTE_RECIPES.map((r) => r.name).sort(),
    );
    for (const recipe of COMPUTE_RECIPES) {
      expect([recipe.name, recipe.version, recipe.engine, [...recipe.inputs]]).toEqual([
        recipe.name,
        IMAGE_VERSION.version.recipes[recipe.name],
        `eegprep@${IMAGE_VERSION.version.eegprep}`,
        IMAGE_VERSION.version.inputs[recipe.name],
      ]);
    }
    // Each recipe's checkpoint map is the one the version output reports for the same recipe version.
    for (const recipe of COMPUTE_RECIPES) {
      expect([
        recipe.name,
        recipe.checkpoints.map((c) => ({ checkpoint: c.checkpoint, steps: [...c.steps] })),
      ]).toEqual([recipe.name, IMAGE_VERSION.version.checkpoints[recipe.name]]);
    }
    // The version output is the CUDA image's: the one image every recipe runs on.
    expect(IMAGE_VERSION.version.flavor).toBe("cuda");
    expect(IMAGE_VERSION.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test("nemar-ica's engine names no device: the device is the run's, not the tuple's", () => {
    const engine = (findRecipe("nemar-ica") as NonNullable<ReturnType<typeof findRecipe>>).engine;
    expect(engine).not.toContain("device");
    expect(engine).not.toMatch(/\b(cuda|gpu)\b/i);
  });

  test("nemar-ica asks for one GPU as a ceiling and 16384 MB, the floor's memory (MUTATION: gpus 0; memoryMb removed)", () => {
    const ica = findRecipe("nemar-ica") as NonNullable<ReturnType<typeof findRecipe>>;
    expect([ica.gpus, ica.memoryMb]).toEqual([1, 16384]);
    expect(ica.memoryMb).toBe(findRecipe("nemar-floor")?.memoryMb);
  });
});

describe("which input runs where", () => {
  const EXECUTORS: RecipeExecutor[] = ["tapis", "runner"];

  test("the table pairs exactly bids with tapis and zarr with runner (MUTATION: bids also on a runner)", () => {
    expect(RECIPE_INPUT_EXECUTOR).toEqual({ bids: ["tapis"], zarr: ["runner"] });
    for (const input of RECIPE_INPUTS) {
      for (const executor of EXECUTORS) {
        const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
        const pair = `${input}/${executor}`;
        expect([pair, recipeRunsInput(floor, input, executor)]).toEqual([
          pair,
          (input === "bids") === (executor === "tapis"),
        ]);
      }
    }
    expect(Object.isFrozen(RECIPE_INPUT_EXECUTOR)).toBe(true);
    expect(Object.isFrozen(RECIPE_INPUT_EXECUTOR.bids)).toBe(true);
  });

  test("an executor's default input is bids on tapis and zarr on a runner", () => {
    expect(defaultInput("tapis")).toBe("bids");
    expect(defaultInput("runner")).toBe("zarr");
    // The default is always an input the executor runs.
    for (const executor of EXECUTORS) {
      expect(RECIPE_INPUT_EXECUTOR[defaultInput(executor)]).toContain(executor);
    }
  });

  test("a recipe runs only the inputs it lists, even on the executor that runs them", () => {
    // Every recipe of the registry lists both inputs now, so a synthetic entry that lists one shows the decision.
    const bidsOnly = { inputs: ["bids"] } as const;
    expect(recipeRunsInput(bidsOnly, "bids", "tapis")).toBe(true);
    expect(recipeRunsInput(bidsOnly, "zarr", "runner")).toBe(false);
    expect(recipeRunsInput({ inputs: [] }, "bids", "tapis")).toBe(false);
    // The registry: nemar-ica reads each input on the executor that runs it, and on no other.
    const ica = findRecipe("nemar-ica") as NonNullable<ReturnType<typeof findRecipe>>;
    expect([
      recipeRunsInput(ica, "bids", "tapis"),
      recipeRunsInput(ica, "zarr", "runner"),
      recipeRunsInput(ica, "bids", "runner"),
      recipeRunsInput(ica, "zarr", "tapis"),
    ]).toEqual([true, true, false, false]);
  });
});

describe("where a recipe may run", () => {
  test("a recipe runs only on the executors it lists (MUTATION: always true)", () => {
    // A synthetic entry that lists both inputs and one executor: the registry has no such recipe now, so the
    // decision is shown on its own, and the route, the dispatch and the dry run each take it at their call site.
    const tapisOnly = { inputs: ["bids", "zarr"], executors: ["tapis"] } as const;
    expect(recipeRunsOn(tapisOnly, "tapis")).toBe(true);
    expect(recipeRunsOn(tapisOnly, "runner")).toBe(false);
    expect(recipeRunsOn({ executors: ["runner"] }, "tapis")).toBe(false);
    expect(recipeRunsOn({ executors: [] }, "tapis")).toBe(false);
    expect(recipeRunsOn({ executors: ["tapis", "runner"] }, "runner")).toBe(true);
    // The input decision is separate: listing an input does not make an executor list it.
    expect(recipeRunsInput(tapisOnly, "zarr", "runner")).toBe(true);
    expect(recipeRunsOn(tapisOnly, "runner")).toBe(false);
    // The registry: nemar-floor and nemar-ica list both.
    const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
    const ica = findRecipe("nemar-ica") as NonNullable<ReturnType<typeof findRecipe>>;
    expect([recipeRunsOn(floor, "tapis"), recipeRunsOn(floor, "runner")]).toEqual([true, true]);
    expect([recipeRunsOn(ica, "tapis"), recipeRunsOn(ica, "runner")]).toEqual([true, true]);
  });
});

describe("the command", () => {
  test("a BIDS run's command is what it always was; any other input adds --input after the name", () => {
    expect(recipeCommand({ name: "nemar-floor" })).toEqual(["nemar-recipe", "run", "nemar-floor"]);
    expect(recipeCommand({ name: "nemar-floor" }, "bids")).toEqual([
      "nemar-recipe",
      "run",
      "nemar-floor",
    ]);
    expect(recipeCommand({ name: "nemar-floor" }, "zarr")).toEqual([
      "nemar-recipe",
      "run",
      "nemar-floor",
      "--input",
      "zarr",
    ]);
  });
});

describe("the arguments", () => {
  const args = recipeArguments({ datasetId: "nm000104", tag: "v1.0.2", imageDigest: DIGEST });

  test("are an absolute argument vector: the dataset where the launcher binds it, the product under outputs", () => {
    expect(recipeCommand({ name: "nemar-floor" })).toEqual(["nemar-recipe", "run", "nemar-floor"]);
    expect(args).toEqual([
      "--dataset-dir",
      `${RECIPE_DATASET_ROOT}/nm000104`,
      "--out",
      RECIPE_PRODUCT_DIR,
      "--dataset-id",
      "nm000104",
      "--dataset-version",
      "v1.0.2",
      RECIPE_IMAGE_DIGEST_FLAG,
      DIGEST,
    ]);
    // No variable is expanded by a shell, so none may appear.
    for (const a of args) expect(a).not.toMatch(/[$`]/);
  });

  test("a whole-dataset run selects every recording: it names none", () => {
    expect(args).not.toContain("--recording");
  });

  test("the arguments are within the job schema's argument bounds (64 of 1,024 characters)", () => {
    expect(args.length).toBeLessThanOrEqual(64);
    for (const a of args) expect(a.length).toBeLessThanOrEqual(1024);
  });

  test("the image digest is read back exactly", () => {
    expect(recipeImageDigestArg(args)).toBe(DIGEST);
  });

  test("a missing flag, a malformed value, a missing value and a second flag are all none", () => {
    expect(recipeImageDigestArg([])).toBeNull();
    expect(recipeImageDigestArg(["--dataset-dir", "/data/x"])).toBeNull();
    expect(recipeImageDigestArg([RECIPE_IMAGE_DIGEST_FLAG])).toBeNull();
    for (const bad of [
      "sha256:abc",
      `sha256:${"A".repeat(64)}`,
      `sha1:${"a".repeat(64)}`,
      `${DIGEST} `,
      `${"a".repeat(64)}`,
    ]) {
      expect(recipeImageDigestArg([RECIPE_IMAGE_DIGEST_FLAG, bad])).toBeNull();
    }
    expect(
      recipeImageDigestArg([
        RECIPE_IMAGE_DIGEST_FLAG,
        DIGEST,
        RECIPE_IMAGE_DIGEST_FLAG,
        `sha256:${"b".repeat(64)}`,
      ]),
    ).toBeNull();
    // The value that follows another flag is not this flag's.
    expect(recipeImageDigestArg(["--out", RECIPE_IMAGE_DIGEST_FLAG])).toBeNull();
  });
});

describe("the recipe's own record", () => {
  const record = (over: Record<string, unknown> = {}) => ({
    extensions: {
      nemar: {
        recipe: { id: "nemar-floor", version: "1.0.0" },
        engine: { package: "eegprep", version: "0.5.0" },
        counts: { discovered: 3, succeeded: 2, failed: 1, skipped: 0 },
        ...over,
      },
    },
  });

  test("gives the recipe, its version, the engine and the count of recordings that succeeded, and bids when it names no input", () => {
    expect(readRecipeRecord(record())).toEqual({
      recipe: "nemar-floor",
      version: "1.0.0",
      engine: "eegprep@0.5.0",
      succeeded: 2,
      inputKind: "bids",
    });
  });

  test("names the input it read: the kind of its input block, a plain word", () => {
    expect(readRecipeRecord(record({ input: { kind: "zarr" } }))?.inputKind).toBe("zarr");
    expect(readRecipeRecord(record({ input: { kind: "bids" } }))?.inputKind).toBe("bids");
    // A block with no kind says what an absent block says: bids.
    expect(readRecipeRecord(record({ input: {} }))?.inputKind).toBe("bids");
    // Another word is read as it is: the Worker compares it with the stamp's input and holds the tuple.
    expect(readRecipeRecord(record({ input: { kind: "parquet" } }))?.inputKind).toBe("parquet");
    // Anything that is not a plain word is not a record.
    for (const kind of ["", "zarr store", 7, null, {}, "z".repeat(65)]) {
      expect([kind, readRecipeRecord(record({ input: { kind } }))]).toEqual([kind, null]);
    }
    // A block that is not an object is not the shape the recipe writes.
    for (const input of ["zarr", 7, null, []]) {
      expect([input, readRecipeRecord(record({ input }))]).toEqual([input, null]);
    }
  });

  test("is none unless every field is in the shape the recipe writes", () => {
    for (const bad of [
      null,
      "x",
      [],
      {},
      { extensions: {} },
      { extensions: { nemar: {} } },
      record({ recipe: { id: "nemar-floor" } }),
      record({ recipe: { id: "nemar floor", version: "1.0.0" } }),
      record({ recipe: { id: "nemar-floor", version: "1.0/0" } }),
      record({ engine: { package: "eegprep" } }),
      record({ engine: { package: "eeg prep", version: "0.5.0" } }),
      record({ counts: {} }),
      record({ counts: { succeeded: -1 } }),
      record({ counts: { succeeded: 1.5 } }),
      record({ counts: { succeeded: "2" } }),
    ]) {
      expect(readRecipeRecord(bad)).toBeNull();
    }
  });

  test("is none when package@version would not fit the stamp's 64-character engine column", () => {
    const engine = (version: number) =>
      record({ engine: { package: "e".repeat(10), version: "1".repeat(version) } });
    // package + "@" + version: 64 characters fit, 65 do not.
    expect(readRecipeRecord(engine(53))?.engine).toHaveLength(64);
    expect(readRecipeRecord(engine(54))).toBeNull();
  });

  test("takes no text a record could use to put anything else into a stamp", () => {
    const hostile = record({ recipe: { id: "a".repeat(80), version: "1.0.0" } });
    expect(readRecipeRecord(hostile)).toBeNull();
  });
});

describe("what a run read, for the stamp", () => {
  const SHA = `sha256:${"ab".repeat(32)}`;
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const READER = "eegprep-lean@0.3.1+89abcdef0123456789abcdef0123456789abcdef";
  const STORES = ["sub-01/eeg/a.edf", "sub-02/eeg/b.edf"];
  const rows = (paths: unknown[]) =>
    paths.map((path) => ({ path, group: "eeg", content_sha256: "cd".repeat(32) }));
  /** A Zarr record that read every store it was given in full, unless `over` says otherwise. */
  const zarrRecord = (
    over: {
      reader?: unknown;
      engine?: unknown;
      digest?: unknown;
      stores?: unknown;
      content?: unknown;
      unread?: unknown;
    } = {},
  ) => ({
    extensions: {
      nemar: {
        dataset: { id: "nm000104", source_commit: COMMIT },
        reader: "reader" in over ? over.reader : READER,
        input: {
          kind: "zarr",
          zarr_engine_version: "engine" in over ? over.engine : "0.4.2",
          input_digest: "digest" in over ? over.digest : SHA,
          stores: "stores" in over ? over.stores : STORES,
          stores_content: "content" in over ? over.content : rows(STORES),
          stores_unread: "unread" in over ? over.unread : [],
        },
      },
    },
  });
  const bidsRecord = (sourceCommit: unknown = COMMIT) => ({
    extensions: { nemar: { dataset: { id: "nm000104", source_commit: sourceCommit } } },
  });

  test("a Zarr record gives the reader, the Zarr engine and the input digest as stated", () => {
    expect(stampInputFields(zarrRecord(), "zarr")).toEqual({
      reader: READER,
      input_engine: "0.4.2",
      input_digest: SHA,
      refused: [],
      reasons: {},
      absent: [],
    });
  });

  test("a BIDS record gives the git digest of its source commit, and no reader or Zarr engine", () => {
    expect(stampInputFields(bidsRecord(), "bids")).toEqual({
      reader: null,
      input_engine: null,
      input_digest: `git:${COMMIT}`,
      refused: [],
      reasons: {},
      absent: [],
    });
    // A BIDS stamp never takes what a Zarr block says, and a Zarr stamp never takes the commit.
    expect(stampInputFields(zarrRecord(), "bids")).toMatchObject({
      reader: null,
      input_engine: null,
      input_digest: `git:${COMMIT}`,
    });
    expect(stampInputFields(bidsRecord(), "zarr")).toMatchObject({
      input_digest: null,
      absent: ["reader", "input_engine", "input_digest"],
    });
  });

  test("a value that does not fit its column is left null and named, never stored (the column rules, each)", () => {
    const refused = (over: Parameters<typeof zarrRecord>[0], field: string) => {
      const got = stampInputFields(zarrRecord(over), "zarr");
      expect([over, got.refused]).toEqual([over, [field]]);
      expect(got.reasons).toEqual({ [field]: "bad_shape" });
      expect(got[field as (typeof STAMP_INPUT_FIELDS)[number]]).toBeNull();
      expect(got.absent).toEqual([]);
    };
    for (const reader of [
      "",
      "x".repeat(129),
      "eegprep lean",
      "eegprep-lean@1/2",
      "é",
      7,
      {},
      [],
    ]) {
      refused({ reader }, "reader");
    }
    for (const engine of ["", "x".repeat(129), "0.4 2", "0.4/2", 7, {}]) {
      refused({ engine }, "input_engine");
    }
    for (const digest of [
      "",
      SHA.toUpperCase(),
      SHA.slice(1),
      `${SHA}0`,
      `sha256:${"g".repeat(64)}`,
      `sha512:${"a".repeat(64)}`,
      // A git digest is the BIDS form: a Zarr record may not claim it.
      `git:${COMMIT}`,
      7,
      {},
    ]) {
      refused({ digest }, "input_digest");
    }
    // The longest value the column holds is stored.
    expect(stampInputFields(zarrRecord({ reader: "r".repeat(128) }), "zarr").reader).toHaveLength(
      128,
    );
    // A BIDS source commit is 40 lowercase hexadecimal digits, or it is refused.
    for (const bad of [
      "",
      COMMIT.toUpperCase(),
      COMMIT.slice(1),
      `${COMMIT}0`,
      "z".repeat(40),
      7,
    ]) {
      const got = stampInputFields(bidsRecord(bad), "bids");
      expect([bad, got.refused, got.reasons]).toEqual([
        bad,
        ["input_digest"],
        { input_digest: "bad_shape" },
      ]);
    }
  });

  test("a Zarr digest is stored only when the record shows it covers every store (each condition, MUTATION: skip one)", () => {
    const refusal = (over: Parameters<typeof zarrRecord>[0]) => {
      const got = stampInputFields(zarrRecord(over), "zarr");
      // Whatever the record says, the other two fields are stored as before.
      expect([got.reader, got.input_engine]).toEqual([READER, "0.4.2"]);
      return [got.input_digest, got.refused, got.reasons.input_digest];
    };
    // All three hold: stored, in any order of the rows, and when the stores are listed in another order.
    expect(refusal({})).toEqual([SHA, [], undefined]);
    expect(refusal({ content: rows([...STORES].reverse()) })).toEqual([SHA, [], undefined]);
    expect(refusal({ stores: [...STORES].reverse() })).toEqual([SHA, [], undefined]);
    // stores_unread: anything but an empty list. A stand-in record of a run that left two stores unread, with
    // a digest that looks right, has none.
    for (const unread of [["HUGE", "MISSING"], ["HUGE"], 2, 0, "", null, undefined, {}]) {
      expect([unread, refusal({ unread })]).toEqual([
        unread,
        [null, ["input_digest"], "stores_unread"],
      ]);
    }
    // stores_content: a non-empty list of rows that each have a path.
    // An empty list of rows is no content even when the run named no stores either (the two lists agree and
    // cover nothing): the digest of nothing is not the digest of an input.
    expect(refusal({ stores: [], content: [] })).toEqual([
      null,
      ["input_digest"],
      "no_stores_content",
    ]);
    for (const content of [[], "all", 3, null, undefined, [{ group: "eeg" }], [null], rows([7])]) {
      expect([content, refusal({ content })]).toEqual([
        content,
        [null, ["input_digest"], "no_stores_content"],
      ]);
    }
    // The paths of the rows are the stores the run named, each once.
    for (const [content, stores] of [
      [rows(STORES.slice(0, 1)), STORES],
      [rows([...STORES, "sub-03/eeg/c.edf"]), STORES],
      [rows(["x.edf", "y.edf"]), STORES],
      [rows([STORES[0], STORES[0]]), STORES],
      [rows(STORES), STORES.slice(0, 1)],
      [rows(STORES), undefined],
      [rows(STORES), "sub-01"],
      [rows(STORES), [1, 2]],
      // A store named twice, and a row for it twice: the two lists agree, and still each store is once.
      [rows([STORES[0], STORES[0]]), [STORES[0], STORES[0]]],
    ] as const) {
      expect([content, stores, refusal({ content, stores })]).toEqual([
        content,
        stores,
        [null, ["input_digest"], "stores_differ"],
      ]);
    }
    // A digest that is not even well formed is refused for its shape, before coverage is asked.
    expect(refusal({ digest: SHA.toUpperCase(), unread: ["HUGE"] })).toEqual([
      null,
      ["input_digest"],
      "bad_shape",
    ]);
    // The reasons are a closed list of plain words.
    for (const reason of STAMP_REFUSAL_REASONS) expect(reason).toMatch(/^[a-z_]+$/);
  });

  test("a field the record does not state is null and named absent, not refused", () => {
    expect(stampInputFields({}, "zarr")).toEqual({
      reader: null,
      input_engine: null,
      input_digest: null,
      refused: [],
      reasons: {},
      absent: ["reader", "input_engine", "input_digest"],
    });
    expect(stampInputFields(zarrRecord({ reader: null, digest: undefined }), "zarr")).toMatchObject(
      {
        reader: null,
        input_digest: null,
        absent: ["reader", "input_digest"],
      },
    );
    // A BIDS record names no source commit when the Worker dispatched it (the recipe is not given one): the
    // null digest is the expected case, so it is neither absent nor refused.
    for (const record of [
      null,
      {},
      bidsRecord(null),
      { extensions: { nemar: { dataset: { id: "nm000104" } } } },
    ]) {
      expect(stampInputFields(record, "bids")).toEqual({
        reader: null,
        input_engine: null,
        input_digest: null,
        refused: [],
        reasons: {},
        absent: [],
      });
    }
  });

  test("every value it returns fits the migration's column, whatever the record says", () => {
    const columns = {
      reader: /^[0-9A-Za-z._+@-]{1,128}$/,
      input_engine: /^[0-9A-Za-z._+@-]{1,128}$/,
      input_digest: /^(sha256:[0-9a-f]{64}|git:[0-9a-f]{40})$/,
    };
    const hostile = ["'; DROP TABLE x; --", "a\nb", "../../etc", " ", "%00", "é".repeat(5)];
    for (const text of hostile) {
      for (const input of RECIPE_INPUTS as readonly RecipeInput[]) {
        const got = stampInputFields(
          zarrRecord({ reader: text, engine: text, digest: text }),
          input,
        );
        for (const field of STAMP_INPUT_FIELDS) {
          const value = got[field];
          expect([text, field, value === null || columns[field].test(value)]).toEqual([
            text,
            field,
            true,
          ]);
        }
      }
    }
  });
});

describe("the module", () => {
  test("is pure and import-free", () => {
    const src = readFileSync(join(import.meta.dir, "../shared/compute-recipes.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bfetch\s*\(|Date\.now|Math\.random|process\./);
  });
});

// ADR 0134 decision 2 (epic #2324 phase 2): each recipe version declares its checkpoints and the steps
// that map to each. The step lists below are nemar-process's `STEP_ORDER` plus its `PRE_CHECKS` and, for
// nemar-ica, its `PLUGINS`, in map order (nemar_floor/steps.py and, for nemar-ica, the floor's steps it re-runs
// then nemar_ica/steps.py), written out a second time so a change on either side is a change here.
describe("checkpoint maps (ADR 0134)", () => {
  const FLOOR_STEP_ORDER = [
    "load",
    "signal_channels",
    "flatline",
    "drift",
    "line_noise_measure",
    "line_noise_50",
    "line_noise_60",
    "qc_amplitude",
    "bad_channels",
    "bad_windows",
    "qc",
  ];
  const ICA_STEP_ORDER = [
    ...FLOOR_STEP_ORDER,
    "ica_eligibility",
    "iclabel_locations",
    "asr",
    "reref",
    "ica",
    "iclabel",
    "nemar-quality",
    "nemar-spectrum",
  ];

  test("the standard checkpoints and stored are the ADR's, in order, with no figures (ADR 0137)", () => {
    expect([...STANDARD_CHECKPOINTS]).toEqual([
      "import",
      "preprocess",
      "ica",
      "iclabel",
      "quality",
      "stored",
    ]);
    expect(STANDARD_CHECKPOINTS as readonly string[]).not.toContain("figures");
    expect(STORED_CHECKPOINT).toBe("stored");
  });

  test("the plugin steps are nemar-quality then nemar-spectrum, and every plugin checkpoint is a standard one", () => {
    expect([...RECIPE_PLUGIN_STEPS]).toEqual(["nemar-quality", "nemar-spectrum"]);
    for (const c of PLUGIN_CHECKPOINTS) {
      expect(STANDARD_CHECKPOINTS as readonly string[], c).toContain(c);
    }
  });

  test("nemar-floor maps exactly as the ADR says", () => {
    const floor = findRecipe("nemar-floor");
    expect(floor?.checkpoints.map((c) => [c.checkpoint, [...c.steps]])).toEqual([
      ["import", ["load", "signal_channels"]],
      [
        "preprocess",
        [
          "flatline",
          "drift",
          "line_noise_measure",
          "line_noise_50",
          "line_noise_60",
          "qc_amplitude",
          "bad_channels",
          "bad_windows",
        ],
      ],
      ["quality", ["qc"]],
    ]);
  });

  test("nemar-ica maps its re-run qc to preprocess, then ica, iclabel, and its quality plugins at quality", () => {
    const ica = findRecipe("nemar-ica");
    expect(ica?.checkpoints.map((c) => c.checkpoint)).toEqual([
      "import",
      "preprocess",
      "ica",
      "iclabel",
      "quality",
    ]);
    expect(ica && checkpointOfStep(ica, "qc")).toBe("preprocess");
    expect(ica && checkpointOfStep(ica, "asr")).toBe("preprocess");
    expect(ica && checkpointOfStep(ica, "iclabel")).toBe("iclabel");
    expect(ica && checkpointOfStep(ica, "nemar-quality")).toBe("quality");
    expect(ica && checkpointOfStep(ica, "nemar-spectrum")).toBe("quality");
    expect(ica?.checkpoints.find((c) => c.checkpoint === "quality")?.steps).toEqual([
      "nemar-quality",
      "nemar-spectrum",
    ]);
    // the record is written after the plugins: its step counts at quality
    expect(ica && checkpointOfStep(ica, RECORD_STEP)).toBe("quality");
  });

  test("every recipe's own result limit is a whole number from 1 to the outputs ceiling (owner, 2026-11-23)", () => {
    for (const recipe of COMPUTE_RECIPES) {
      const max = recipe.resultLimits?.maxFiles;
      if (max === undefined) continue;
      expect(Number.isSafeInteger(max), recipe.name).toBe(true);
      expect(max, recipe.name).toBeGreaterThanOrEqual(1);
      expect(max, recipe.name).toBeLessThanOrEqual(COMPUTE_MAX_OUTPUT_FILES);
    }
    expect(findRecipe("nemar-ica")?.resultLimits?.maxFiles).toBe(25_000);
    expect(findRecipe("nemar-floor")?.resultLimits?.maxFiles).toBe(25_000);
  });

  test("every plugin step is a step word and a plugin name, mapped only in nemar-ica, at quality", () => {
    for (const step of RECIPE_PLUGIN_STEPS) {
      expect(PROGRESS_STEP_RE.test(step), step).toBe(true);
      expect(PLUGIN_NAME_RE.test(step), step).toBe(true);
    }
    const ica = findRecipe("nemar-ica");
    const floor = findRecipe("nemar-floor");
    const plugins: readonly string[] = RECIPE_PLUGIN_STEPS;
    expect(ica?.checkpoints.flatMap((c) => c.steps).filter((s) => plugins.includes(s))).toEqual([
      ...RECIPE_PLUGIN_STEPS,
    ]);
    expect(floor?.checkpoints.flatMap((c) => c.steps).filter((s) => plugins.includes(s))).toEqual(
      [],
    );
    for (const step of RECIPE_PLUGIN_STEPS) {
      expect(ica ? checkpointOfStep(ica, step) : null).toBe("quality");
    }
  });

  test("every pre-check counts at preprocess, so a recording it refuses never passed a later checkpoint", () => {
    for (const recipe of COMPUTE_RECIPES) {
      for (const step of recipe.checkpoints.flatMap((c) => c.steps)) {
        if ((RECIPE_PRE_CHECKS as readonly string[]).includes(step)) {
          expect(checkpointOfStep(recipe, step), `${recipe.name} ${step}`).toBe("preprocess");
        }
      }
    }
    const ica = findRecipe("nemar-ica");
    expect(ica && checkpointOfStep(ica, "ica_eligibility")).toBe("preprocess");
    expect(ica && checkpointOfStep(ica, "iclabel_locations")).toBe("preprocess");
    const floor = findRecipe("nemar-floor");
    expect(floor && checkpointOfStep(floor, "qc_amplitude")).toBe("preprocess");
  });

  test.each([
    ["nemar-floor", FLOOR_STEP_ORDER],
    ["nemar-ica", ICA_STEP_ORDER],
  ])("every step of %s maps to exactly one checkpoint, in step order", (name, order) => {
    const recipe = findRecipe(name);
    if (!recipe) throw new Error(name);
    const mapped = recipe.checkpoints.flatMap((c) => c.steps);
    expect(mapped).toEqual(order);
    expect(new Set(mapped).size).toBe(mapped.length);
    for (const step of order) expect(checkpointOfStep(recipe, step)).not.toBeNull();
    expect(checkpointOfStep(recipe, "no_such_step")).toBeNull();
    // `record`, the recipe writing its own record, is a trailing pseudo-step: the last checkpoint.
    expect(mapped).not.toContain(RECORD_STEP);
    expect(checkpointOfStep(recipe, RECORD_STEP)).toBe(
      recipe.checkpoints[recipe.checkpoints.length - 1]?.checkpoint,
    );
  });

  test("checkpoints follow the standard order, never name stored, and each has a step", () => {
    for (const recipe of COMPUTE_RECIPES) {
      const names = recipe.checkpoints.map((c) => c.checkpoint);
      expect(names).not.toContain(STORED_CHECKPOINT);
      const positions = names.map((n) => (STANDARD_CHECKPOINTS as readonly string[]).indexOf(n));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      for (const c of recipe.checkpoints) expect(c.steps.length).toBeGreaterThan(0);
    }
  });

  test("declaredCheckpoints ends with stored", () => {
    const floor = findRecipe("nemar-floor");
    expect(floor && declaredCheckpoints(floor)).toEqual([
      "import",
      "preprocess",
      "quality",
      "stored",
    ]);
  });

  test("the map belongs to the registry's version only", () => {
    const floor = findRecipe("nemar-floor");
    expect(recipeCheckpointMap("nemar-floor", floor?.version)).toBe(floor?.checkpoints ?? null);
    expect(recipeCheckpointMap("nemar-floor", `${floor?.version}-other`)).toBeNull();
    expect(recipeCheckpointMap("no-such-recipe", "1.0.0")).toBeNull();
    expect(recipeCheckpointMap(undefined, undefined)).toBeNull();
  });
});
