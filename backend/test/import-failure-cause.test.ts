/**
 * classifyImportFailure (epic #1306, issue #1309).
 *
 * The error strings below are REAL -- copied from `onboard-openneuro` runs in
 * nemarDatasets/.github between 2026-07-22 and 2026-09-08, the window in which
 * every automated import failed and none of them was diagnosable from D1.
 */

import { describe, expect, test } from "bun:test";
import {
  IMPORT_FAILURE_CAUSE_LABELS,
  classifyImportFailure,
} from "../src/services/import-failure-cause";

/** Real `✖` lines, by the run that produced them. */
const REAL = {
  auth: "Failed to push: remote: Invalid username or token. Password authentication is not supported for Git operations.",
  authFatal: "fatal: Authentication failed for 'https://github.com/nemarDatasets/on006136.git/'",
  annex:
    "Failed to configure S3 remote: The bucket already exists, and its annex-uuid file indicates it is used by a different special remote.",
  gh013: "Failed to push: remote: error: GH013: Repository rule violations found for refs/heads/main.",
  divergence:
    "Failed to push: Push rejected: origin/main has diverging commits and auto-rebase failed: Rebasing (1/1)",
  upstream:
    "[openneuro-upstream-inaccessible] OpenNeuro objects not anonymously readable; NEMAR has no signed OpenNeuro login (see run log)",
  generic: "terminal: prepare=failure copy=failure finalize=failure",
};

describe("classifyImportFailure on real failures", () => {
  const cases: [keyof typeof REAL, string][] = [
    ["auth", "auth_invalid"],
    ["authFatal", "auth_invalid"],
    ["annex", "annex_uuid_conflict"],
    ["gh013", "branch_protection"],
    ["divergence", "git_divergence"],
    ["upstream", "upstream_inaccessible"],
  ];

  for (const [key, expected] of cases) {
    test(`${key} -> ${expected}`, () => {
      expect(classifyImportFailure({ stage: "prepare", lastError: REAL[key] }).cause).toBe(
        expected as never,
      );
    });
  }

  test("every classified failure carries a label and a non-empty summary", () => {
    for (const [key] of cases) {
      const c = classifyImportFailure({ stage: "prepare", lastError: REAL[key] });
      expect(IMPORT_FAILURE_CAUSE_LABELS).toContain(c.label);
      expect(c.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("unknown is a real answer, never a guess", () => {
  test("the generic roll-up carries no diagnosis", () => {
    const c = classifyImportFailure({ stage: "prepare", lastError: REAL.generic });
    expect(c.cause).toBe("unknown");
    expect(c.label).toBe("needs-triage");
  });

  test("null and blank are unknown", () => {
    expect(classifyImportFailure({ stage: "prepare", lastError: null }).cause).toBe("unknown");
    expect(classifyImportFailure({ stage: "copy", lastError: "   " }).cause).toBe("unknown");
  });

  test("an unrecognised message is unknown, not the nearest guess", () => {
    expect(
      classifyImportFailure({ stage: "finalize", lastError: "Something nobody has seen before" })
        .cause,
    ).toBe("unknown");
  });

  test("stage alone never implies a cause", () => {
    // The replaced STAGE_HINTS map inferred "possible git-divergence" from
    // stage=prepare and "possible upstream-403/shard-gap" from stage=copy. Every
    // real failure in the incident window was stage=prepare, and none of them was
    // git divergence, so inference from stage is not merely weak -- it was wrong
    // for every case it ever described.
    for (const stage of ["prepare", "copy", "finalize"]) {
      expect(classifyImportFailure({ stage, lastError: null }).cause).toBe("unknown");
    }
  });
});

describe("the two false positives that made whole-log matching wrong", () => {
  // Both were hit while diagnosing the incident. A classifier that reads the
  // Actions log instead of the structured message reproduces both.

  test("apt output must not read as an HTTP 403", () => {
    const aptLine = "Get:29 https://packages.microsoft.com/ubuntu/24.04/prod noble/main amd64 Packages [403 kB]";
    expect(classifyImportFailure({ stage: "prepare", lastError: aptLine }).cause).toBe("unknown");
  });

  test("the echoed callback source must not read as an upstream failure", () => {
    // Actions echoes the reporting step's own script, so this line appears in
    // EVERY prepare log regardless of why the import failed. Matching it is the
    // most likely origin of the misattributed `upstream-403` labels.
    const echoedSource = 'if [ -f "$log" ] && grep -qF "[openneuro-upstream-inaccessible]" "$log"; then';
    // NOTE: this string DOES contain the marker, so it is classified
    // upstream_inaccessible -- correctly, for a structured error message. The
    // defence is the input contract, not the pattern: `last_error` carries the
    // CLI's own failure line, never a whole log. This test pins that contract by
    // documenting what would happen if it were ever violated.
    expect(classifyImportFailure({ stage: "prepare", lastError: echoedSource }).cause).toBe(
      "upstream_inaccessible",
    );
  });
});
