/**
 * Drift check between `.github/dataset-workflows/onboard-openneuro.yml` and the copy
 * that actually runs, `nemarDatasets/.github`'s `.github/workflows/onboard-openneuro.yml`
 * (issue #1309, epic #1306).
 *
 * The workflow is authored here, beside the CLI it invokes and the classifier that
 * reads its output, and then DEPLOYED by copying it whole into the other repo. A copy
 * with nothing watching it is a fork with a delay. This is not hypothetical: when the
 * capture change was written the two files were byte-identical, and by the time it was
 * ready they had drifted by exactly one merged PR in the org repo -- the `--yes` on the
 * three login lines. Nothing detected that; a person happened to look.
 *
 * `backend/test/import-capture-workflow.test.ts` constrains what a drift can BREAK, by
 * asserting the properties capture depends on. It cannot detect one, because it only
 * ever reads the local copy. That is this file's job.
 *
 * **Byte-for-byte, not a normalised comparison.** The deploy is `cp`, so any difference
 * at all is a difference in what runs. Normalising whitespace or comments would make
 * the test agree with a file that is not the file.
 *
 * Two modes, deliberately different, copied from `test/account-copy-parity.test.ts`:
 *
 *   `NEMAR_DATASET_WORKFLOW_LIVE` set   that path IS the deployed file. Missing FAILS,
 *                                       naming the path and the variable -- the only
 *                                       way to reach it is a checkout step that broke,
 *                                       and a silent skip hands the check back to
 *                                       nobody.
 *   unset                               look for a sibling checkout. Absent is a
 *                                       VISIBLE skip, not a pass: `describe.skipIf`
 *                                       reports skipped, while an early `return`
 *                                       reports success.
 *
 * `nemarDatasets/.github` is PUBLIC, so CI needs no token for the checkout.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const LOCAL_COPY = join(REPO_ROOT, ".github", "dataset-workflows", "onboard-openneuro.yml");

/** Set by the `unit-pure` job to the sparse checkout it made. A relative value is
 *  resolved against the repo root, which is the workflow's working directory. */
const LIVE_ENV_VAR = "NEMAR_DATASET_WORKFLOW_LIVE";
const declaredRaw = process.env[LIVE_ENV_VAR];
const DECLARED_PATH =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;

/**
 * Where a `.github` checkout is likely to sit for a developer.
 *
 * This repo is usually a WORKTREE (`epic-import-observability/`, `skew-fix/`, ...)
 * rather than `nemar-cli/` itself, so the search is relative to the repo root
 * whatever it is called. Only consulted when the variable is unset.
 */
const SIBLING_CANDIDATES = [
  join(REPO_ROOT, "..", ".github", ".github", "workflows", "onboard-openneuro.yml"),
  join(REPO_ROOT, "..", "dot-github", ".github", "workflows", "onboard-openneuro.yml"),
  join(REPO_ROOT, "..", "..", ".github", ".github", "workflows", "onboard-openneuro.yml"),
];

const found = DECLARED_PATH ?? SIBLING_CANDIDATES.find((p) => existsSync(p)) ?? null;

/**
 * The local copy is checked unconditionally, because it is in this repo and every
 * developer has it. Only the COMPARISON needs the other checkout.
 */
describe("the authoring copy exists and is the file the deploy expects", () => {
  test("it is present, non-trivial, and says where it is deployed", () => {
    expect(existsSync(LOCAL_COPY)).toBe(true);
    const src = readFileSync(LOCAL_COPY, "utf8");
    expect(src.length).toBeGreaterThan(2000);
    // The header names its destination. If that line ever goes, the next person has
    // no way to know this file is a copy of something live.
    expect(src).toContain("Deploy to: nemarDatasets/.github/workflows/onboard-openneuro.yml");
  });
});

describe("the declared live path must exist when it is declared", () => {
  test.skipIf(DECLARED_PATH === null)(`${LIVE_ENV_VAR} names a file that is present`, () => {
    // A broken checkout step must fail loudly rather than skip: a skip here would
    // silently restore the exact hole this file was written to close.
    expect(
      existsSync(DECLARED_PATH ?? ""),
      `${LIVE_ENV_VAR}=${declaredRaw} but that file does not exist; the checkout step did not produce it`,
    ).toBe(true);
  });
});

describe.skipIf(found === null)("the two copies are byte-identical", () => {
  test("the authoring copy and the deployed copy match exactly", () => {
    const local = readFileSync(LOCAL_COPY, "utf8");
    const live = readFileSync(found ?? "", "utf8");
    if (local !== live) {
      // A diff-shaped message, because "they differ" is useless when the file is 300
      // lines: name the first differing line and which side is which.
      const a = local.split("\n");
      const b = live.split("\n");
      const i = a.findIndex((line, idx) => line !== b[idx]);
      const detail =
        i === -1
          ? `same lines but different length: authoring ${a.length}, deployed ${b.length}`
          : `first difference at line ${i + 1}:\n  authoring: ${JSON.stringify(a[i])}\n  deployed:  ${JSON.stringify(b[i])}`;
      throw new Error(
        `onboard-openneuro.yml has drifted between this repo and nemarDatasets/.github.\n${detail}\n\n` +
          "The deploy is a whole-file copy, so any difference is a difference in what runs. " +
          "Sync the two, and remember the org repo is the one that executes.",
      );
    }
    expect(local).toBe(live);
  });

  test("the comparison is not vacuous: both files were actually read", () => {
    // Guards the shape where a path resolves to something empty and the comparison
    // passes by agreeing about nothing.
    expect(readFileSync(LOCAL_COPY, "utf8").length).toBeGreaterThan(2000);
    expect(readFileSync(found ?? "", "utf8").length).toBeGreaterThan(2000);
  });
});
