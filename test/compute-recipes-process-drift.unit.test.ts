/**
 * The recipe registry's tuple against the nemar-process sources it copies (#2329 review round 1).
 *
 * `shared/compute-recipes.ts` declares each recipe's `version` and `engine`, and a finished run whose record
 * names another tuple holds the claimed one (`tuple_mismatch`, then `registry_drift`). Those values are copies:
 * the recipe's `RECIPE_VERSION` in `recipes/nemar_process/<recipe>/steps.py`, and eegprep as the image reports
 * it, `eegprep@<version>+<commit>` from the eegprep block of `uv.lock`, which is what the image installs (bare
 * `eegprep@<version>` when eegprep comes from an index; nemar-process `common/versions.py`). This test reads a nemar-process checkout and compares.
 *
 * The checkout is named in `NEMAR_PROCESS_DIR`. Without it the comparison SKIPS VISIBLY on a developer
 * machine; `NEMAR_REQUIRE_PROCESS_RECIPES=1` (set by the CI workflow, which checks out nemar-process `dev`
 * with these files in its sparse list) makes a missing checkout or file FAIL, so a broken checkout cannot
 * quietly disable the comparison.
 *
 * The same checkout holds each recipe's `STEP_ORDER`, which the registry's step-to-checkpoint map copies
 * (ADR 0134 decision 2): every floor step for `nemar-floor`; the floor's steps it re-runs, then its own, for
 * `nemar-ica`. The map must name exactly those steps, in that order.
 *
 * The parsing helpers are pinned on literal text by the first cases below.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTE_RECIPES, findRecipe } from "../shared/compute-recipes";

/**
 * The value of `RECIPE_VERSION` in a recipe's `steps.py`, or null: an assignment at the start of a line, with
 * or without a type annotation (`RECIPE_VERSION: str = ...`, `Final[str]`), in either quote style, and with or
 * without a trailing comment. A commented-out line is not an assignment.
 */
function recipeVersionOf(stepsPy: string): string | null {
  const m = /^RECIPE_VERSION\s*(?::[^=\n]+)?=\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*(?:#.*)?$/m.exec(
    stepsPy,
  );
  return m === null ? null : (m[1] ?? m[2] ?? null);
}

/** The `[[package]]` block of `uv.lock` for one distribution, or null. */
function lockBlockOf(uvLock: string, name: string): string | null {
  for (const block of uvLock.split(/^\[\[package\]\]\s*$/m)) {
    if (new RegExp(`^name = "${name}"\\s*$`, "m").test(block)) return block;
  }
  return null;
}

/**
 * The engine text a record of an image built from this lock names, or null when the lock has no eegprep or
 * its source is neither git nor an index. Read from `uv.lock`, which is what the image installs: the
 * eegprep block's `version`, plus `+<commit>` when its `source` is git (the resolved commit, the fragment
 * after `#` in `source = { git = "...?rev=<sha>#<sha>" }`), as nemar-process `common/versions.py` appends
 * it; bare for an index (`source = { registry = ... }`). `pyproject.toml` is not read: a commented-out or
 * `[tool.uv.sources]` pin there is not what was installed, the lock is.
 */
function expectedEngine(uvLock: string): string | null {
  const block = lockBlockOf(uvLock, "eegprep");
  if (block === null) return null;
  const version = /^version = "([^"]+)"\s*$/m.exec(block)?.[1];
  if (version === undefined) return null;
  const git = /^source = \{ git = "[^"#]*#([0-9a-f]{40})" \}\s*$/m.exec(block);
  if (git !== null) return `eegprep@${version}+${git[1]}`;
  if (/^source = \{ registry = "[^"]+" \}\s*$/m.test(block)) return `eegprep@${version}`;
  return null;
}

/**
 * The names in a `STEP_ORDER = (...)` tuple of a `steps.py`, in order, or null: one assignment at the start
 * of a line, the tuple on one line or several, double or single quotes, comments ignored.
 */
function stepOrderOf(stepsPy: string): string[] | null {
  const m = /^STEP_ORDER\s*(?::[^=\n]+)?=\s*\(([^)]*)\)/m.exec(stepsPy);
  if (m === null) return null;
  const body = (m[1] as string).replace(/#[^\n]*/g, "");
  return [...body.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)].map((x) => (x[1] ?? x[2]) as string);
}

const STEPS: Record<string, string> = {
  "nemar-floor": "recipes/nemar_process/nemar_floor/steps.py",
  "nemar-ica": "recipes/nemar_process/nemar_ica/steps.py",
};

describe("the parsing of the nemar-process sources", () => {
  test("RECIPE_VERSION is read with an annotation, either quote style and a trailing comment, never from a comment", () => {
    expect(recipeVersionOf('X = 1\nRECIPE_VERSION = "1.0.0-b1"\n')).toBe("1.0.0-b1");
    expect(recipeVersionOf("RECIPE_VERSION = '1.0.0-b2'\n")).toBe("1.0.0-b2");
    expect(recipeVersionOf('RECIPE_VERSION: str = "1.0.0-b3"\n')).toBe("1.0.0-b3");
    expect(recipeVersionOf('RECIPE_VERSION: Final[str] = "1.0.0"  # the floor\n')).toBe("1.0.0");
    expect(recipeVersionOf('# RECIPE_VERSION = "9"\n')).toBeNull();
    expect(recipeVersionOf('# RECIPE_VERSION = "9"\nRECIPE_VERSION = "1.0.0-b1"\n')).toBe(
      "1.0.0-b1",
    );
  });

  const REV = "edf694c8344b9c4c68672eac3acf9a819f1462a8";
  const OLD = "1".repeat(40);
  const lean = `[[package]]\nname = "eegprep-lean"\nversion = "0.3.1"\nsource = { git = "https://github.com/sccn/eegprep?subdirectory=packages%2Feegprep-lean&rev=${OLD}#${OLD}" }\n\n`;
  const gitLock = `${lean}[[package]]\nname = "eegprep"\nversion = "0.5.0"\nsource = { git = "https://github.com/sccn/eegprep?rev=${REV}#${REV}" }\n`;

  test("the engine is the lock's version and resolved commit for a git source, and bare for an index", () => {
    expect(expectedEngine(gitLock)).toBe(`eegprep@0.5.0+${REV}`);
    const indexLock = `${lean}[[package]]\nname = "eegprep"\nversion = "0.5.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
    expect(expectedEngine(indexLock)).toBe("eegprep@0.5.0");
    expect(expectedEngine(lean)).toBeNull();
  });

  test("STEP_ORDER is read on one line or several, in either quote style, comments ignored", () => {
    expect(stepOrderOf('STEP_ORDER = ("asr", "reref", "ica", "iclabel")\n')).toEqual([
      "asr",
      "reref",
      "ica",
      "iclabel",
    ]);
    expect(stepOrderOf("STEP_ORDER = (\n    'load',  # first\n    \"qc\",\n)\n")).toEqual([
      "load",
      "qc",
    ]);
    expect(stepOrderOf('# STEP_ORDER = ("x",)\n')).toBeNull();
  });

  test("a [tool.uv.sources] style pin resolves through the lock, which names the branch's resolved commit", () => {
    // `eegprep = { git = "...", branch = "develop" }` locks as `?branch=develop#<sha>`: the commit after `#`.
    const branchLock = `[[package]]\nname = "eegprep"\nversion = "0.5.0"\nsource = { git = "https://github.com/sccn/eegprep?branch=develop#${REV}" }\n`;
    expect(expectedEngine(branchLock)).toBe(`eegprep@0.5.0+${REV}`);
  });

  test("a commented-out old pin in pyproject.toml cannot decide the engine: only the lock is read, and only eegprep's block", () => {
    // The false pass of review round 2: the earlier parser took the first eegprep pin text in pyproject.toml,
    // commented or not. The engine now has no pyproject input; the lock's eegprep block names REV, and the
    // eegprep-lean block's commit (OLD) is another distribution's.
    expect(expectedEngine(gitLock)).toBe(`eegprep@0.5.0+${REV}`);
    expect(expectedEngine(gitLock)).not.toContain(OLD);
  });
});

describe("the registry matches the nemar-process sources", () => {
  const DIR = process.env.NEMAR_PROCESS_DIR;
  const required = process.env.NEMAR_REQUIRE_PROCESS_RECIPES === "1";
  const files = DIR ? [...Object.values(STEPS), "uv.lock"].map((f) => join(DIR, f)) : null;
  const present = files?.every((f) => existsSync(f)) ?? false;

  test.skipIf(!required && files === null)(
    "NEMAR_PROCESS_DIR names a checkout that holds the recipes and uv.lock",
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
      const engine = expectedEngine(read("uv.lock"));
      expect(engine, "uv.lock names no eegprep from git or an index").not.toBeNull();
      expect(COMPUTE_RECIPES.length).toBeGreaterThan(0);
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

  test.skipIf(!required && !present)(
    "every recipe's checkpoint map names exactly its STEP_ORDER, in order (ADR 0134)",
    () => {
      const dir = DIR as string;
      const read = (f: string) => readFileSync(join(dir, f), "utf8");
      const floorOrder = stepOrderOf(read(STEPS["nemar-floor"] as string));
      const icaOwn = stepOrderOf(read(STEPS["nemar-ica"] as string));
      expect(floorOrder, "nemar_floor/steps.py has no STEP_ORDER").not.toBeNull();
      expect(icaOwn, "nemar_ica/steps.py has no STEP_ORDER").not.toBeNull();
      const expected: Record<string, string[]> = {
        "nemar-floor": floorOrder as string[],
        "nemar-ica": [...(floorOrder as string[]), ...(icaOwn as string[])],
      };
      for (const recipe of COMPUTE_RECIPES) {
        const mapped = (findRecipe(recipe.name)?.checkpoints ?? []).flatMap((c) => [...c.steps]);
        expect(mapped, `${recipe.name} checkpoint map`).toEqual(expected[recipe.name] ?? []);
      }
    },
  );
});
