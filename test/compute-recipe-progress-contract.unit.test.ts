/**
 * The recipe's progress file, `nemar.recipe-progress.v1` (ADR 0134 decisions 3 and 8, epic #2324
 * phase 6).
 *
 * Agreement with the reader: `test/fixtures/compute/recipe-progress-corpus.json` holds files the
 * nemar-process recipe layer wrote and mutations of them, each with the verdict nemar-process's launcher
 * reader (`check_recipe_progress`) gave. zod must give every verdict; Ajv on the shared JSON Schema must
 * give every verdict except the two rules a schema cannot state (a checkpoint named twice, a step in two
 * checkpoints), which it accepts. Pins: the words and numbers, and the definitions shared with
 * `compute-progress.schema.json`, value for value.
 */

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import progressSchema from "../shared/contract/compute-progress.schema.json";
import {
  RECIPE_PROGRESS_DIRECTORY,
  RECIPE_PROGRESS_FILE,
  RECIPE_PROGRESS_FORMAT,
  RECIPE_PROGRESS_MAX_BYTES,
  RECIPE_PROGRESS_MAX_STEPS,
  RECIPE_PROGRESS_RECIPE_ID_RE,
  RECIPE_PROGRESS_RUNNING_PATH_MAX,
  RECIPE_PROGRESS_STORED,
  RECIPE_PROGRESS_TABLE_RE,
  RECIPE_PROGRESS_VERSION_RE,
  RecipeProgressSchema,
} from "../shared/contract/compute-recipe-progress";
import recipeSchema from "../shared/contract/compute-recipe-progress.schema.json";
import * as contractIndex from "../shared/contract/index";
import corpus from "./fixtures/compute/recipe-progress-corpus.json";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(recipeSchema);
const ajvRecipe = ajv.getSchema(`${recipeSchema.$id}#/$defs/RecipeProgress`);
if (!ajvRecipe) throw new Error("recipe progress schema member not found");

/** The reader's rules a JSON Schema cannot state: Ajv accepts these, zod and the reader refuse them. */
const SCHEMA_CANNOT_STATE = new Set(["a checkpoint named twice", "a step in two checkpoints"]);

describe("the words and numbers", () => {
  test("are the contract's", () => {
    expect(RECIPE_PROGRESS_FORMAT).toBe("nemar.recipe-progress.v1");
    expect(RECIPE_PROGRESS_DIRECTORY).toBe(".nemar-progress");
    expect(RECIPE_PROGRESS_FILE).toBe("progress.json");
    expect(RECIPE_PROGRESS_MAX_BYTES).toBe(65536);
    expect(RECIPE_PROGRESS_STORED).toBe("stored");
    expect(RECIPE_PROGRESS_MAX_STEPS).toBe(64);
    expect(RECIPE_PROGRESS_RUNNING_PATH_MAX).toBe(4096);
    const defs = recipeSchema.$defs;
    expect(defs.RecipeProgress.properties.format.const).toBe(RECIPE_PROGRESS_FORMAT);
    expect(defs.RecipeProgress.properties.running.items.properties.path.maxLength).toBe(
      RECIPE_PROGRESS_RUNNING_PATH_MAX,
    );
    expect(defs.CheckpointMap.items.properties.steps.maxItems).toBe(RECIPE_PROGRESS_MAX_STEPS);
    const strip = (re: RegExp) => re.source.replace(/\$$/, "").replaceAll("\\/", "/");
    const end = "(?![\\s\\S])";
    expect(defs.RecipeProgress.properties.recipe.properties.id.pattern).toBe(
      strip(RECIPE_PROGRESS_RECIPE_ID_RE) + end,
    );
    expect(defs.RecipeProgress.properties.recipe.properties.version.pattern).toBe(
      strip(RECIPE_PROGRESS_VERSION_RE) + end,
    );
    expect(defs.RecipeProgress.properties.table.pattern).toBe(
      strip(RECIPE_PROGRESS_TABLE_RE) + end,
    );
  });

  test("the definitions shared with the live progress schema are its own, value for value", () => {
    for (const name of ["CheckpointName", "StepId", "Count"] as const) {
      expect(recipeSchema.$defs[name], name).toEqual(progressSchema.$defs[name]);
    }
  });

  test("the contract index re-exports the module", () => {
    expect(contractIndex.RecipeProgressSchema).toBe(RecipeProgressSchema);
  });
});

describe("Ajv and zod give the launcher reader's verdicts", () => {
  test("the corpus holds the recipe layer's own files and both verdicts", () => {
    const written = corpus.cases.filter((c) => c.name.startsWith("written by the recipe layer"));
    expect(written.length).toBe(8);
    expect(written.every((c) => c.valid)).toBe(true);
    expect(corpus.cases.some((c) => !c.valid)).toBe(true);
    for (const name of SCHEMA_CANNOT_STATE) {
      expect(corpus.cases.find((c) => c.name === name)?.valid, name).toBe(false);
    }
  });

  for (const c of corpus.cases) {
    test(c.name, () => {
      expect(RecipeProgressSchema.safeParse(c.document).success, "zod").toBe(c.valid);
      const ajvVerdict = SCHEMA_CANNOT_STATE.has(c.name) ? true : c.valid;
      expect(ajvRecipe(c.document) as boolean, "ajv").toBe(ajvVerdict);
    });
  }
});
