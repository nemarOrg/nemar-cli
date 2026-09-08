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
  IMPORT_UPSTREAM_MARKER_FOR_CLASSIFY,
  classifyImportFailure,
} from "../src/services/import-failure-cause";
import { OPENNEURO_UPSTREAM_MARKER } from "../src/services/import-recovery";

/** Real `✖` lines, by the run that produced them. */
const REAL = {
  auth: "Failed to push: remote: Invalid username or token. Password authentication is not supported for Git operations.",
  authFatal: "fatal: Authentication failed for 'https://github.com/nemarDatasets/on006136.git/'",
  annex:
    "Failed to configure S3 remote: The bucket already exists, and its annex-uuid file indicates it is used by a different special remote.",
  gh013:
    "Failed to push: remote: error: GH013: Repository rule violations found for refs/heads/main.",
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

describe("the marker literal is duplicated, so pin the copies together", () => {
  // import-failure-cause.ts keeps its own copy of the marker rather than importing
  // it from import-recovery.ts, to stay a pure module. Nothing in the type system
  // makes the two agree, and a drift would be SILENT: the classifier would simply
  // stop recognising upstream failures and label them needs-triage. A test can
  // import both without creating the production coupling the duplication avoids.
  test("both copies of the upstream marker are the same string", () => {
    expect(IMPORT_UPSTREAM_MARKER_FOR_CLASSIFY).toBe(OPENNEURO_UPSTREAM_MARKER);
  });

  test("the classifier recognises a message built from the recovery module's copy", () => {
    expect(
      classifyImportFailure({ stage: "prepare", lastError: `${OPENNEURO_UPSTREAM_MARKER} blah` })
        .cause,
    ).toBe("upstream_inaccessible");
  });
});

describe("causes with no failure yet observed in a NEMAR run", () => {
  // rate_limit and timeout have not fired on this pipeline. Unlike the six causes
  // above, their strings are not transcribed from a NEMAR run -- they are the
  // stable wordings GitHub and Actions emit, quoted verbatim so a future NEMAR
  // occurrence classifies on first contact rather than landing in needs-triage.

  test("GitHub's secondary rate limit", () => {
    expect(
      classifyImportFailure({
        stage: "copy",
        lastError:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      }).cause,
    ).toBe("rate_limit");
  });

  test("GitHub's primary rate limit", () => {
    expect(
      classifyImportFailure({
        stage: "copy",
        lastError: "API rate limit exceeded for user ID 12345.",
      }).cause,
    ).toBe("rate_limit");
  });

  test("the Actions job time cap", () => {
    expect(
      classifyImportFailure({
        stage: "copy",
        lastError:
          "The job running on runner GitHub Actions 12 has exceeded the maximum execution time of 360 minutes.",
      }).cause,
    ).toBe("timeout");
  });

  test("a cancelled job", () => {
    expect(
      classifyImportFailure({ stage: "finalize", lastError: "The job was cancelled" }).cause,
    ).toBe("timeout");
  });
});

describe("BIDS-adjacent import failures are not forced into bids_validation", () => {
  // These two ARE emitted by the import CLI (src/lib/import-openneuro.ts), and
  // both mention BIDS validation -- but neither is a validation failure. One says
  // the CI run never registered, the other that every poll attempt errored; both
  // are pipeline or API-health problems. `bids_validation` says "a data problem,
  // not a pipeline problem", so matching them there would assert the opposite of
  // the truth -- the exact misattribution this module exists to end. needs-triage
  // is the honest routing until a real validation failure is seen on this path.
  test("a CI run that never registered is not a data problem", () => {
    expect(
      classifyImportFailure({
        stage: "prepare",
        lastError:
          "BIDS validation run did not register within the bounded poll window. Re-run with --trust-upstream to bypass (OpenNeuro datasets are pre-validated upstream), or investigate why the deployed CI did not trigger.",
      }).cause,
    ).toBe("unknown");
  });

  test("failed validation polls are not a data problem", () => {
    expect(
      classifyImportFailure({
        stage: "prepare",
        lastError:
          "Every BIDS validation poll attempt failed (last error: HTTP 502). Refusing to bypass under --trust-upstream because validation state was never actually observed.",
      }).cause,
    ).toBe("unknown");
  });

  test("an actual validator rejection does classify", () => {
    expect(
      classifyImportFailure({
        stage: "prepare",
        lastError: "BIDS validation failed: 3 errors reported by bids-validator",
      }).cause,
    ).toBe("bids_validation");
  });
});

describe("only real protection codes are branch_protection", () => {
  // `GH0\d{2}:` would match every GitHub push-rejection code. Most of them are
  // not protection rules, and each would be handed branch_protection's summary,
  // which points triage at nemarOrg/nemar-cli#998 -- the wrong issue for a
  // too-large file or a blocked private email.
  test("GH006 protected branch is branch_protection", () => {
    expect(
      classifyImportFailure({
        stage: "prepare",
        lastError: "remote: error: GH006: Protected branch update failed for refs/heads/main.",
      }).cause,
    ).toBe("branch_protection");
  });

  const notProtection: [string, string][] = [
    [
      "GH001 large file",
      "remote: error: GH001: Large files detected. You may want to try Git Large File Storage.",
    ],
    [
      "GH002 large file",
      "remote: error: GH002: Your push would publish a file larger than 100.00 MB.",
    ],
    [
      "GH003 force push",
      "remote: error: GH003: Sorry, force-pushing to refs/heads/main is not allowed.",
    ],
    [
      "GH007 private email",
      "remote: error: GH007: Your push would publish a private email address.",
    ],
  ];

  for (const [name, message] of notProtection) {
    test(`${name} is not branch_protection`, () => {
      expect(classifyImportFailure({ stage: "prepare", lastError: message }).cause).not.toBe(
        "branch_protection",
      );
    });
  }
});

describe("the two false positives that made whole-log matching wrong", () => {
  // Both were hit while diagnosing the incident. A classifier that reads the
  // Actions log instead of the structured message reproduces both.

  test("apt output must not read as an HTTP 403", () => {
    const aptLine =
      "Get:29 https://packages.microsoft.com/ubuntu/24.04/prod noble/main amd64 Packages [403 kB]";
    expect(classifyImportFailure({ stage: "prepare", lastError: aptLine }).cause).toBe("unknown");
  });

  test("the echoed callback source must not read as an upstream failure", () => {
    // Actions echoes the reporting step's own script, so this line appears in
    // EVERY prepare log regardless of why the import failed. Matching it is the
    // most likely origin of the misattributed `upstream-403` labels.
    const echoedSource =
      'if [ -f "$log" ] && grep -qF "[openneuro-upstream-inaccessible]" "$log"; then';
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
