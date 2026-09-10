/**
 * The capture half of issue #1309, checked against the classify half.
 *
 * `nemarDatasets/.github`'s `onboard-openneuro.yml` posts the failing phase's real
 * error line; `classifyImportFailure` turns that text into a cause. The two halves
 * live in different repositories and are joined only by the WORDING of a message, so
 * nothing in either repo's own tests can catch them drifting apart. That is what this
 * file is for.
 *
 * Two things are pinned:
 *
 *   1. The messages the workflow actually produces classify to the causes triage
 *      needs. The strings below are not invented: each was extracted by running the
 *      workflow's own shell pipeline over a log in the shape the CLI writes.
 *   2. The workflow file kept in this repo (`.github/dataset-workflows/`) still has
 *      the properties the capture depends on. It is a copy that an owner deploys by
 *      hand, so a well-meaning edit here is the likeliest way for capture to regress.
 *
 * Before this, every machine-filed tracking issue read `terminal: prepare=failure
 * copy=failure finalize=failure` -- a stage roll-up with no error text -- and a human
 * read Actions logs and applied labels by hand.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyImportFailure } from "../src/services/import-failure-cause";

const WORKFLOW = join(
  import.meta.dir,
  "..",
  "..",
  ".github",
  "dataset-workflows",
  "onboard-openneuro.yml",
);

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

describe("what the workflow captures is what the classifier can read", () => {
  /**
   * The three causes behind the 2026-07/09 outage, in the wording the CLI emits.
   * These are the cases the taxonomy was transcribed FROM, so if any stops
   * classifying, the epic's premise has broken rather than merely a test.
   */
  const REAL_INCIDENT_CASES: { label: string; message: string; cause: string }[] = [
    {
      label: "expired NEMAR_GITHUB_PAT",
      message:
        "Failed to clone: fatal: Authentication failed for https://github.com/nemarDatasets/on008065",
      cause: "auth_invalid",
    },
    {
      label: "annex-uuid collision on re-import",
      message:
        "Failed to enable s3-PUBLIC remote: git-annex: Unable to use this special remote the annex-uuid file indicates it is used by a different special remote",
      cause: "annex_uuid_conflict",
    },
    {
      label: "branch-protection ruleset",
      message:
        "Failed to push: remote: error: GH013: Repository rule violations found for refs/heads/main.",
      cause: "branch_protection",
    },
    {
      label: "git divergence, auto-rebase failed",
      message: "Failed to push: hint: Updates were rejected because the tip has diverging commits",
      cause: "git_divergence",
    },
  ];

  for (const c of REAL_INCIDENT_CASES) {
    test(`${c.label} classifies as ${c.cause}`, () => {
      expect(classifyImportFailure({ stage: "prepare", lastError: c.message }).cause).toBe(c.cause);
    });
  }

  test("the upstream marker the workflow forwards verbatim still matches", () => {
    // The workflow sends this sentence unchanged rather than an extracted line,
    // because the marker IS the signal and the wording tells triage to re-check with
    // an anonymous ranged GET before believing it. So the literal must stay in step.
    const sent =
      "[openneuro-upstream-inaccessible] OpenNeuro objects not anonymously readable; NEMAR has no signed OpenNeuro login (see run log)";
    expect(workflow()).toContain(sent);
    expect(classifyImportFailure({ stage: "prepare", lastError: sent }).cause).toBe(
      "upstream_inaccessible",
    );
  });

  test("the no-line fallback is unknown, not a guess", () => {
    // Reachable whenever the CLI dies without printing a failure line -- an OOM, a
    // runner eviction. It must route to needs-triage rather than borrow whichever
    // cause happens to match some substring of the sentence.
    for (const stage of ["prepare", "copy", "finalize"]) {
      const fallback = `${stage} failed with no CLI failure line captured (see run log)`;
      expect(workflow()).toContain(fallback);
      const r = classifyImportFailure({ stage, lastError: fallback });
      expect(r.cause).toBe("unknown");
      expect(r.label).toBe("needs-triage");
    }
  });

  test("the roll-up the report job still posts remains unknown", () => {
    // It is the backstop, not the diagnosis, and `lastErrorAssignmentSql` keeps it
    // from overwriting a specific message. If it ever classified as something
    // confident, every failure would acquire that label.
    expect(
      classifyImportFailure({
        stage: "prepare",
        lastError: "terminal: prepare=failure copy=failure finalize=failure",
      }).cause,
    ).toBe("unknown");
  });
});

describe("the deployable copy keeps the properties capture depends on", () => {
  /**
   * `.github/dataset-workflows/onboard-openneuro.yml` is deployed by copying it into
   * `nemarDatasets/.github`. Nothing in CI runs it, so these are the invariants worth
   * asserting statically.
   */
  test("every phase job tees the CLI output it later reads", () => {
    const src = workflow();
    // Without the tee there is no file to extract from, and the reporter silently
    // falls back to "no CLI failure line captured" on every failure -- which looks
    // like a working capture that never captures anything.
    expect(src).toContain('tee "/tmp/prepare-${DATASET_ID}.log"');
    expect(src).toContain('tee "/tmp/copy-${DATASET_ID}-${{ matrix.shard }}.log"');
    expect(src).toContain('tee "/tmp/finalize-${DATASET_ID}.log"');
    // `set -o pipefail` is what keeps the step's exit code the CLI's rather than
    // tee's, so a failure still fails the job.
    expect(src.match(/set -o pipefail/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("each phase has a failure reporter, and each names its own stage", () => {
    const src = workflow();
    for (const stage of ["prepare", "copy", "finalize"]) {
      expect(src).toContain(`- name: Report ${stage} failure`);
      expect(src).toContain(`stage:"${stage}"`);
    }
  });

  test("the failure payloads are built with jq, never string-interpolated", () => {
    const src = workflow();
    // An extracted error line can contain a quote, a backslash or a newline. The
    // hand-rolled JSON this replaced only ever carried fixed strings, so it worked
    // until the day the message stopped being fixed -- and the failure mode is a
    // silent 400 on the one callback that carries the diagnosis.
    expect(src.match(/jq -nc/g)?.length).toBeGreaterThanOrEqual(3);
    // No reporter may fall back to interpolating the message into a JSON literal.
    expect(src).not.toContain('\\"error_message\\":\\"$msg');
  });

  test("extraction reads the tee'd log, never the Actions log", () => {
    const src = workflow();
    // Two false positives make whole-log matching wrong, and both were met while
    // diagnosing this epic: a bare `403` matches apt's "Packages [403 kB]", and the
    // marker appears in every Actions log because the step's own source is echoed.
    expect(src).toContain("grep -nF '✖' \"$log\"");
    expect(src).not.toContain("gh run view");
    expect(src).not.toContain("--log |");
  });

  test("the marker check uses grep -F, so the brackets are not a character class", () => {
    expect(workflow()).toContain('grep -qF "[openneuro-upstream-inaccessible]"');
  });
});
