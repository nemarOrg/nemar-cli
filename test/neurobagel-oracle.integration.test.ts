/**
 * Run Neurobagel's own code over the goldens (epic #1586, phase 1).
 *
 * Needs `uv` and network access (the pinned `bagel` release, its vocabulary and
 * the recipes loader are fetched), so it is an *.integration.test.ts: CI's
 * required unit tier skips that suffix.
 * Opt in with NEUROBAGEL_ORACLE=1:
 *
 *   NEUROBAGEL_ORACLE=1 bun test test/neurobagel-oracle.integration.test.ts
 *
 * It runs `uv run scripts/neurobagel/oracle.py --check`, which fails on any
 * disagreement between the transform and the real `bagel pheno`, `bagel bids`,
 * the recipes graph-mode and catalog-mode loaders, and an RDF expansion of the
 * JSON-LD, and it re-verifies the committed vocabulary snapshot against its
 * pins.
 * Without the opt-in every test below is reported as skipped, not passed.
 * The unit tests check the goldens against RECORDINGS of that run; this is the
 * test that the recordings are true.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const enabled = process.env.NEUROBAGEL_ORACLE === "1";
const hasUv = spawnSync("uv", ["--version"]).status === 0;
if (!enabled || !hasUv) {
  console.warn(
    "neurobagel-oracle.integration: skipped (set NEUROBAGEL_ORACLE=1 and install uv to run bagel over the goldens)",
  );
}

describe.skipIf(!enabled || !hasUv)("the real Neurobagel code agrees with the goldens", () => {
  test("oracle.py --check passes for every golden", () => {
    const result = spawnSync("uv", ["run", "--quiet", "scripts/neurobagel/oracle.py", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 600_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("recipes loaders: graph mode");
    expect(output).toContain("all checks passed");
    expect(result.status).toBe(0);
  }, 600_000);

  test("the committed vocabulary snapshot still matches its pins", () => {
    const result = spawnSync("bun", ["run", "scripts/neurobagel/generate-vocab.ts", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 300_000,
    });
    expect(result.stdout).toContain("vocabulary snapshot matches the pins");
    expect(result.status).toBe(0);
  }, 300_000);
});
