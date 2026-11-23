/**
 * The recipe registry's tuple against the nemar-process sources it copies (#2329 review round 1).
 *
 * `shared/compute-recipes.ts` declares each recipe's `version` and `engine`, and a finished run whose record
 * names another tuple holds the claimed one (`tuple_mismatch`, then `registry_drift`). Those values are copies:
 * the recipe's `RECIPE_VERSION` in `recipes/nemar_process/<recipe>/steps.py`, and eegprep as the image reports
 * it, `eegprep@<uv.lock version>+<pyproject.toml git rev>` (bare `eegprep@<version>` when eegprep comes from an
 * index; nemar-process `common/versions.py`). This test reads a nemar-process checkout and compares.
 *
 * The checkout is named in `NEMAR_PROCESS_DIR`. Without it the comparison SKIPS VISIBLY on a developer
 * machine; `NEMAR_REQUIRE_PROCESS_RECIPES=1` (set by the CI workflow, which checks out nemar-process `dev`
 * with these files in its sparse list) makes a missing checkout or file FAIL, so a broken checkout cannot
 * quietly disable the comparison.
 *
 * The parsing helpers are pinned on literal text by the first cases below.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTE_RECIPES } from "../shared/compute-recipes";

/** `RECIPE_VERSION = "<v>"` at the start of a line of a recipe's `steps.py`, or null. */
function recipeVersionOf(stepsPy: string): string | null {
  return /^RECIPE_VERSION\s*=\s*"([^"]+)"\s*$/m.exec(stepsPy)?.[1] ?? null;
}

/** The `version` of the `eegprep` package in `uv.lock`, or null. */
function lockedVersionOf(uvLock: string, name: string): string | null {
  for (const block of uvLock.split(/^\[\[package\]\]\s*$/m)) {
    if (new RegExp(`^name = "${name}"\\s*$`, "m").test(block)) {
      return /^version = "([^"]+)"\s*$/m.exec(block)?.[1] ?? null;
    }
  }
  return null;
}

/**
 * The 40-digit git revision `pyproject.toml` pins eegprep to (`eegprep[...] @ git+https://github.com/sccn/eegprep@<rev>`),
 * or null when eegprep is not taken from git (a release from an index). The `eegprep-lean` subdirectory pin is
 * another distribution and is not matched.
 */
function eegprepGitRevOf(pyproject: string): string | null {
  return /"eegprep(?:\[[^\]]*\])?\s*@\s*git\+[^"@]+@([0-9a-f]{40})"/.exec(pyproject)?.[1] ?? null;
}

/** The engine text a record of an image built from these sources names. */
function expectedEngine(uvLock: string, pyproject: string): string | null {
  const version = lockedVersionOf(uvLock, "eegprep");
  if (version === null) return null;
  const rev = eegprepGitRevOf(pyproject);
  return rev === null ? `eegprep@${version}` : `eegprep@${version}+${rev}`;
}

const STEPS: Record<string, string> = {
  "nemar-floor": "recipes/nemar_process/nemar_floor/steps.py",
  "nemar-ica": "recipes/nemar_process/nemar_ica/steps.py",
};

describe("the parsing of the nemar-process sources", () => {
  test("RECIPE_VERSION is read from its own line only", () => {
    expect(recipeVersionOf('X = 1\nRECIPE_VERSION = "1.0.0-b1"\n')).toBe("1.0.0-b1");
    expect(recipeVersionOf('# RECIPE_VERSION = "9"\n')).toBeNull();
  });

  test("the engine is version+rev from a git pin, and bare from an index", () => {
    const lock =
      '[[package]]\nname = "eegprep-lean"\nversion = "0.3.1"\n\n[[package]]\nname = "eegprep"\nversion = "0.5.0"\n';
    const rev = "edf694c8344b9c4c68672eac3acf9a819f1462a8";
    const git = `deps = [\n    "eegprep[mne,torch] @ git+https://github.com/sccn/eegprep@${rev}",\n    "eegprep-lean[zarr] @ git+https://github.com/sccn/eegprep@${"1".repeat(40)}#subdirectory=packages/eegprep-lean",\n]`;
    expect(expectedEngine(lock, git)).toBe(`eegprep@0.5.0+${rev}`);
    expect(expectedEngine(lock, 'deps = ["eegprep[mne]==0.5.0"]')).toBe("eegprep@0.5.0");
    expect(lockedVersionOf(lock, "eegprep")).toBe("0.5.0");
  });
});

describe("the registry matches the nemar-process sources", () => {
  const DIR = process.env.NEMAR_PROCESS_DIR;
  const required = process.env.NEMAR_REQUIRE_PROCESS_RECIPES === "1";
  const files = DIR
    ? [...Object.values(STEPS), "pyproject.toml", "uv.lock"].map((f) => join(DIR, f))
    : null;
  const present = files?.every((f) => existsSync(f)) ?? false;

  test.skipIf(!required && files === null)(
    "NEMAR_PROCESS_DIR names a checkout that holds the recipes, pyproject.toml and uv.lock",
    () => {
      expect(
        files,
        "NEMAR_REQUIRE_PROCESS_RECIPES=1 needs NEMAR_PROCESS_DIR to name a nemar-process checkout",
      ).not.toBeNull();
      for (const f of files ?? []) expect(existsSync(f), `${f} is not there`).toBe(true);
    },
  );

  test.skipIf(!required && !present)(
    "every recipe's version is its RECIPE_VERSION and its engine is the eegprep the image installs",
    () => {
      expect(DIR, "no checkout to compare with").toBeDefined();
      const dir = DIR as string;
      const read = (f: string) => readFileSync(join(dir, f), "utf8");
      const engine = expectedEngine(read("uv.lock"), read("pyproject.toml"));
      expect(engine, "uv.lock names no eegprep").not.toBeNull();
      for (const recipe of COMPUTE_RECIPES) {
        const steps = STEPS[recipe.name];
        expect(steps, `${recipe.name} has no steps.py named in this test`).toBeDefined();
        expect(recipe.version, `${recipe.name}.version`).toBe(
          recipeVersionOf(read(steps as string)) ?? "(no RECIPE_VERSION)",
        );
        expect(recipe.engine, `${recipe.name}.engine`).toBe(engine as string);
      }
    },
  );
});
