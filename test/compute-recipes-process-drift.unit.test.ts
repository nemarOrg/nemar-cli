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
 * The same checkout holds each recipe's `STEP_ORDER`, `PRE_CHECKS` and `CHECKPOINTS`, which the registry's
 * step-to-checkpoint map copies (ADR 0134 decision 2). The map's steps are `STEP_ORDER` plus `PRE_CHECKS`:
 * without the pre-checks, every floor step for `nemar-floor`, and the floor's steps it re-runs then its own
 * for `nemar-ica`, in that order; each pre-check at `preprocess`. A `steps.py` that declares `CHECKPOINTS`
 * must declare `PRE_CHECKS` too, and its `CHECKPOINTS` must be the registry's map, step for step.
 *
 * A recipe's quality plugins (ADR 0134 decisions 6 and 7) are steps of the map too, at `quality` and
 * `figures`, declared in nemar-process as `PLUGINS = (("name", "version"), ...)` beside `STEP_ORDER`, which does
 * not list them. Until a `steps.py` declares `PLUGINS` (nemar-process `dev` and its epic branch before phase 5
 * P4), the comparison leaves the registry's plugin steps out, and a checkpoint left empty by that; once it
 * declares them, its plugin names, in order, must be the map's plugin steps and its `CHECKPOINTS` the whole map.
 *
 * The parsing helpers are pinned on literal text by the first cases below.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPUTE_RECIPES,
  RECIPE_PLUGIN_STEPS,
  RECIPE_PRE_CHECKS,
  findRecipe,
} from "../shared/compute-recipes";

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
function stepOrderOf(stepsPy: string, name = "STEP_ORDER"): string[] | null {
  const m = new RegExp(`^${name}\\s*(?::[^=\\n]+)?=\\s*\\(([^)]*)\\)`, "m").exec(stepsPy);
  if (m === null) return null;
  const body = (m[1] as string).replace(/#[^\n]*/g, "");
  return [...body.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)].map((x) => (x[1] ?? x[2]) as string);
}

/**
 * The `CHECKPOINTS = (("name", ("step", ...)), ...)` literal of a `steps.py`, as [name, steps] pairs, or
 * null when there is none: one assignment at the start of a line, comments ignored.
 */
function checkpointsOf(stepsPy: string): [string, string[]][] | null {
  const start = /^CHECKPOINTS\s*(?::[^=\n]+)?=\s*\(/m.exec(stepsPy);
  if (start === null) return null;
  const text = stepsPy.slice(start.index + start[0].length).replace(/#[^\n]*/g, "");
  let depth = 1;
  let end = 0;
  while (end < text.length && depth > 0) {
    if (text[end] === "(") depth++;
    else if (text[end] === ")") depth--;
    end++;
  }
  const body = text.slice(0, end - 1);
  const entry = /\(\s*["']([^"'\n]+)["']\s*,\s*\(([^()]*)\)\s*,?\s*\)/g;
  return [...body.matchAll(entry)].map((m) => [
    m[1] as string,
    [...(m[2] as string).matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)].map((x) => (x[1] ?? x[2]) as string),
  ]);
}

/**
 * The plugin names of a `PLUGINS = (("name", "version"), ...)` literal of a `steps.py`, in order, or null when
 * there is none: one assignment at the start of a line, on one line or several, comments ignored; `()` is an
 * empty list. Each entry is a pair, and only its first string is a name.
 */
function pluginsOf(stepsPy: string): string[] | null {
  const start = /^PLUGINS\s*(?::[^=\n]+)?=\s*\(/m.exec(stepsPy);
  if (start === null) return null;
  const text = stepsPy.slice(start.index + start[0].length).replace(/#[^\n]*/g, "");
  let depth = 1;
  let end = 0;
  while (end < text.length && depth > 0) {
    if (text[end] === "(") depth++;
    else if (text[end] === ")") depth--;
    end++;
  }
  const body = text.slice(0, end - 1);
  const pair = /\(\s*["']([^"'\n]+)["']\s*,\s*["'][^"'\n]+["']\s*,?\s*\)/g;
  return [...body.matchAll(pair)].map((m) => m[1] as string);
}

/** A checkpoint map with the given steps left out, and any checkpoint that leaves empty. */
function withoutSteps(
  map: readonly { checkpoint: string; steps: readonly string[] }[],
  leave: readonly string[],
): [string, string[]][] {
  return map
    .map((c): [string, string[]] => [c.checkpoint, c.steps.filter((s) => !leave.includes(s))])
    .filter(([, steps]) => steps.length > 0);
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
    expect(stepOrderOf('PRE_CHECKS = ("a", "b")\n', "PRE_CHECKS")).toEqual(["a", "b"]);
  });

  test("CHECKPOINTS is read as name and step pairs across lines, comments ignored, or null", () => {
    const py =
      'CHECKPOINTS = (\n    ("import", ("load", "signal_channels")),\n    (\n        "preprocess",\n' +
      "        (\n            \"flatline\",  # (first)\n            'qc_amplitude',\n        ),\n    ),\n" +
      '    ("quality", ("qc",)),\n)\nSTEP_ORDER = ("x",)\n';
    expect(checkpointsOf(py)).toEqual([
      ["import", ["load", "signal_channels"]],
      ["preprocess", ["flatline", "qc_amplitude"]],
      ["quality", ["qc"]],
    ]);
    expect(checkpointsOf('STEP_ORDER = ("x",)\n# CHECKPOINTS = ()\n')).toBeNull();
  });

  test("PLUGINS is read as the first string of each pair, across lines, comments ignored, or null", () => {
    expect(
      pluginsOf('PLUGINS = (("nemar-quality", "1.0.0-b1"), ("nemar-spectrum", "1.0.0-b1"))\n'),
    ).toEqual(["nemar-quality", "nemar-spectrum"]);
    expect(
      pluginsOf(
        "PLUGINS = (\n    ('nemar-quality', '1.0.0-b1'),  # metrics\n    (\"nemar-segment\", \"2\"),\n)\n",
      ),
    ).toEqual(["nemar-quality", "nemar-segment"]);
    expect(pluginsOf("PLUGINS = ()\n")).toEqual([]);
    expect(pluginsOf('# PLUGINS = (("x", "1"),)\nSTEP_ORDER = ("a",)\n')).toBeNull();
    // a list is not the declared form: unread here, and refused by the comparison below
    expect(pluginsOf('PLUGINS = [("nemar-quality", "1.0.0-b1")]\n')).toBeNull();
  });

  test("withoutSteps leaves the named steps out, and a checkpoint that ends empty", () => {
    const map = [
      { checkpoint: "iclabel", steps: ["iclabel"] },
      { checkpoint: "quality", steps: ["nemar-quality"] },
      { checkpoint: "figures", steps: ["nemar-spectrum", "x"] },
    ];
    expect(withoutSteps(map, ["nemar-quality", "nemar-spectrum"])).toEqual([
      ["iclabel", ["iclabel"]],
      ["figures", ["x"]],
    ]);
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
    "every recipe's checkpoint map is its STEP_ORDER plus its PRE_CHECKS, and its CHECKPOINTS (ADR 0134)",
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
      const pre: readonly string[] = RECIPE_PRE_CHECKS;
      const plugins: readonly string[] = RECIPE_PLUGIN_STEPS;
      for (const recipe of COMPUTE_RECIPES) {
        const map = findRecipe(recipe.name)?.checkpoints ?? [];
        const mapped = map.flatMap((c) => [...c.steps]);
        // the pre-checks are step ids of the table, not of the record, and the plugins are listed apart:
        // STEP_ORDER lists neither
        expect(
          mapped.filter((s) => !pre.includes(s) && !plugins.includes(s)),
          `${recipe.name} checkpoint map`,
        ).toEqual(expected[recipe.name] ?? []);
        for (const step of mapped.filter((s) => pre.includes(s))) {
          expect(
            map.find((c) => c.steps.includes(step))?.checkpoint,
            `${recipe.name} ${step}`,
          ).toBe("preprocess");
        }
        // a steps.py that declares CHECKPOINTS (nemar-process #74 on) declares PRE_CHECKS beside it, equal
        // to the pre-checks this map holds, and its CHECKPOINTS are this map, step for step
        const stepsPy = read(STEPS[recipe.name] as string);
        const declaredMap = checkpointsOf(stepsPy);
        const declared = stepOrderOf(stepsPy, "PRE_CHECKS");
        const declaredPlugins = pluginsOf(stepsPy);
        // a PLUGINS assignment this test cannot read (a list, a name) must not pass as "not declared"
        expect(
          /^PLUGINS\b/m.test(stepsPy) && declaredPlugins === null,
          `${recipe.name}: steps.py assigns PLUGINS in a form this test does not read (a tuple of pairs)`,
        ).toBe(false);
        const mappedPlugins = mapped.filter((s) => plugins.includes(s));
        if (declaredPlugins !== null) {
          // a steps.py that declares PLUGINS (phase 5 P4 on): its names, in order, are the map's plugin steps
          expect(declaredPlugins, `${recipe.name} PLUGINS`).toEqual(mappedPlugins);
        }
        if (declaredMap !== null) {
          expect(
            declared,
            `${recipe.name}: steps.py declares CHECKPOINTS without PRE_CHECKS`,
          ).not.toBeNull();
          // before PLUGINS is declared, nemar-process's CHECKPOINTS do not hold the registry's plugin steps yet
          expect(declaredMap, `${recipe.name} CHECKPOINTS`).toEqual(
            withoutSteps(map, declaredPlugins === null ? mappedPlugins : []),
          );
        }
        if (declared !== null) {
          expect(declared, `${recipe.name} PRE_CHECKS`).toEqual(
            mapped.filter((s) => pre.includes(s)),
          );
        }
      }
    },
  );
});
