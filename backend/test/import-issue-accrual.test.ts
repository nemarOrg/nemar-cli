/**
 * Accrual control decisions (epic #1306, issue #1310).
 *
 * Three rules, all pure and all tested here rather than through the sweep:
 * when to roll up, what to do with one open issue, and which labels survive.
 *
 * The cap/resume band is the part most likely to be "simplified" later into a
 * single threshold, so the anti-thrash property is asserted directly: no
 * transition happens anywhere inside the band, in either direction.
 */

import { describe, expect, test } from "bun:test";
import {
  IMPORT_FAILURE_ISSUE_LABEL,
  importFailureIssueTitle,
} from "../src/services/import-failure-issue";
import {
  IMPORT_ISSUE_CAP,
  IMPORT_ISSUE_RESUME,
  type IssueVerifyState,
  buildRecoveryCloseComment,
  buildRollupIssueBody,
  buildRollupReleaseComment,
  computeLabelUpdate,
  decideIssueAction,
  decideIssueMode,
  rollupIssueTitle,
} from "../src/services/import-issue-accrual";

const DATASET = "on006136";
const SOURCE = "ds006136";
const TITLE = importFailureIssueTitle(DATASET, SOURCE);

const complete: IssueVerifyState = {
  complete: true,
  version: "1.0.0",
  expectedCount: 4812,
  presentCount: 4812,
};
const incomplete: IssueVerifyState = {
  complete: false,
  version: "1.0.0",
  expectedCount: 3310,
  presentCount: 0,
};
/** Verified, but no manifest resolved -- completeness is UNKNOWN, not false. */
const noManifest: IssueVerifyState = {
  complete: false,
  version: null,
  expectedCount: 0,
  presentCount: 0,
};

// ---------------------------------------------------------------------------
// The mode machine
// ---------------------------------------------------------------------------

describe("decideIssueMode", () => {
  test("below the cap, per-dataset issues are the default", () => {
    for (let n = 0; n < IMPORT_ISSUE_CAP; n++) {
      expect(decideIssueMode({ openPerDatasetCount: n, rollupOpen: false })).toBe("per-dataset");
    }
  });

  test("the cap rolls up, and staying above it stays rolled up", () => {
    expect(decideIssueMode({ openPerDatasetCount: IMPORT_ISSUE_CAP, rollupOpen: false })).toBe(
      "rollup",
    );
    // The real 2026-07-22 burst: 15 at once (#68-#82).
    expect(decideIssueMode({ openPerDatasetCount: 15, rollupOpen: true })).toBe("rollup");
    // And the backlog open when this phase was written.
    expect(decideIssueMode({ openPerDatasetCount: 29, rollupOpen: true })).toBe("rollup");
  });

  test("per-dataset filing resumes only at or below the resume mark", () => {
    expect(decideIssueMode({ openPerDatasetCount: IMPORT_ISSUE_RESUME, rollupOpen: true })).toBe(
      "per-dataset",
    );
    expect(decideIssueMode({ openPerDatasetCount: 0, rollupOpen: true })).toBe("per-dataset");
  });

  test("nothing transitions inside the band -- the anti-thrash property", () => {
    // This is the whole point of having two thresholds instead of one. Inside
    // the band the mode is whatever it already was, in BOTH directions, so a
    // tracker hovering at the threshold cannot flap run to run.
    for (let n = IMPORT_ISSUE_RESUME + 1; n < IMPORT_ISSUE_CAP; n++) {
      expect(decideIssueMode({ openPerDatasetCount: n, rollupOpen: true })).toBe("rollup");
      expect(decideIssueMode({ openPerDatasetCount: n, rollupOpen: false })).toBe("per-dataset");
    }
  });

  /**
   * Do not delete this as trivial. It is what stops the loop above from going
   * vacuous: narrow the band to adjacent constants and that `for` body never
   * executes, silently disarming the only assertion of the anti-thrash property.
   */
  test("the band is non-empty, or there is no hysteresis at all", () => {
    expect(IMPORT_ISSUE_RESUME).toBeLessThan(IMPORT_ISSUE_CAP - 1);
  });
});

// ---------------------------------------------------------------------------
// What to do with one issue
// ---------------------------------------------------------------------------

describe("decideIssueAction", () => {
  const base = {
    datasetId: DATASET,
    sourceId: SOURCE,
    issueTitle: TITLE,
    currentLabels: [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"],
    causeLabel: "auth-invalid",
  };

  test("a verified-complete import closes, and says what was verified", () => {
    const action = decideIssueAction({ ...base, verify: complete });
    expect(action.kind).toBe("close");
    expect(action.reason).toContain("4812/4812");
  });

  test("a still-incomplete import is kept", () => {
    const action = decideIssueAction({ ...base, verify: incomplete });
    expect(action.kind).toBe("keep");
    expect(action.reason).toContain("0/3310");
  });

  test("NO published manifest is unknown, not clean -- never closes", () => {
    // The one mistake here that silently discards a live problem: a dataset
    // that never published has nothing to compare against, and reading that
    // as "complete" would close its issue forever.
    const action = decideIssueAction({ ...base, verify: noManifest });
    expect(action.kind).toBe("keep");
    expect(action.reason).toContain("completeness unknown");
  });

  /**
   * The third refusal, and the subtlest. `complete` upstream is `missingKeys
   * .length === 0` over the manifest's annex-keyed entries, so a manifest with
   * none of them -- `files: {}` (which `parseManifestFiles` accepts, it only
   * rejects a MISSING key), or every entry `git:`-keyed -- yields `complete:
   * true` having compared nothing at all. Closing on that writes "0 of 0
   * annex-keyed objects are present" as a recovery claim over an empty set.
   */
  test("complete over ZERO declared objects verified nothing -- never closes", () => {
    const action = decideIssueAction({
      ...base,
      verify: { complete: true, version: "1.0.0", expectedCount: 0, presentCount: 0 },
    });
    expect(action.kind).toBe("keep");
    expect(action.reason).toContain("no annex-keyed objects");
  });

  test("failed verification is kept, never closed (fail-open)", () => {
    const action = decideIssueAction({ ...base, verify: null });
    expect(action.kind).toBe("keep");
    expect(action.reason).toContain("unavailable");
  });

  test("a changed cause relabels rather than appending under a stale label", () => {
    const action = decideIssueAction({
      ...base,
      currentLabels: [IMPORT_FAILURE_ISSUE_LABEL, "upstream-403"],
      causeLabel: "upstream-inaccessible",
      verify: incomplete,
    });
    expect(action.kind).toBe("relabel");
    expect(action.reason).toContain("upstream-403 -> upstream-inaccessible");
    expect(action.labels).toContain("upstream-inaccessible");
    expect(action.labels).not.toContain("upstream-403");
  });

  test("recovery beats relabelling -- a closed issue needs no new label", () => {
    const action = decideIssueAction({
      ...base,
      currentLabels: [IMPORT_FAILURE_ISSUE_LABEL, "upstream-403"],
      causeLabel: "auth-invalid",
      verify: complete,
    });
    expect(action.kind).toBe("close");
  });

  describe("a human-authored issue is never touched", () => {
    test("a hand-written title is left alone even when verified complete", () => {
      const action = decideIssueAction({
        ...base,
        issueTitle: "on006136 is broken, please look",
        verify: complete,
      });
      expect(action.kind).toBe("keep");
      expect(action.reason).toContain("human-authored");
    });

    test("a missing tracking label is left alone even when verified complete", () => {
      const action = decideIssueAction({
        ...base,
        currentLabels: ["bug"],
        verify: complete,
      });
      expect(action.kind).toBe("keep");
      expect(action.reason).toContain("human-authored");
    });

    test("the title must match the dataset it claims -- no cross-dataset close", () => {
      const action = decideIssueAction({
        ...base,
        issueTitle: importFailureIssueTitle("on000001", "ds000001"),
        verify: complete,
      });
      expect(action.kind).toBe("keep");
    });
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe("computeLabelUpdate", () => {
  test("replaces the owned cause label and keeps the tracking label", () => {
    const next = computeLabelUpdate([IMPORT_FAILURE_ISSUE_LABEL, "git-divergence"], "auth-invalid");
    expect(next).toEqual([IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"].sort());
  });

  test("retires the legacy upstream-403 spelling", () => {
    const next = computeLabelUpdate(
      [IMPORT_FAILURE_ISSUE_LABEL, "upstream-403"],
      "upstream-inaccessible",
    );
    expect(next).not.toContain("upstream-403");
    expect(next).toContain("upstream-inaccessible");
  });

  test("preserves labels this module does not own", () => {
    // `no-import-row` is applied by a human during triage and no classifier
    // emits it, so an automated relabel must not strip it.
    const next = computeLabelUpdate(
      [IMPORT_FAILURE_ISSUE_LABEL, "git-divergence", "no-import-row"],
      "auth-invalid",
    );
    expect(next).toContain("no-import-row");
    expect(next).not.toContain("git-divergence");
  });

  test("returns null when nothing would change, so no pointless API write", () => {
    expect(computeLabelUpdate([IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"], "auth-invalid")).toBe(
      null,
    );
    // Order must not matter.
    expect(computeLabelUpdate(["auth-invalid", IMPORT_FAILURE_ISSUE_LABEL], "auth-invalid")).toBe(
      null,
    );
  });

  test("adds the tracking label when an issue somehow lost it", () => {
    const next = computeLabelUpdate(["auth-invalid"], "auth-invalid");
    expect(next).toContain(IMPORT_FAILURE_ISSUE_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

describe("content builders", () => {
  test("the close comment does not claim checksum verification", () => {
    // verifyDatasetVersionS3 compares presence and declared SIZE; nothing
    // re-hashes object bytes. Saying otherwise would overstate the guarantee.
    const body = buildRecoveryCloseComment(complete, "2026-09-09T00:00:00Z");
    expect(body).toContain("declared size");
    expect(body).toContain("Size-level verification, not checksum-level");
    expect(body).toContain("4812");
  });

  test("the rollup title is deterministic and cause-scoped", () => {
    expect(rollupIssueTitle("auth_invalid")).toBe(rollupIssueTitle("auth_invalid"));
    expect(rollupIssueTitle("auth_invalid")).not.toBe(rollupIssueTitle("git_divergence"));
  });

  test("the rollup body lists every affected dataset and says how to get back", () => {
    const body = buildRollupIssueBody(
      "auth_invalid",
      "GitHub rejected the credential.",
      [
        { datasetId: "on000001", sourceId: "ds000001", workflowRunUrl: "https://example/1" },
        { datasetId: "on000002", sourceId: "ds000002", workflowRunUrl: null },
      ],
      "2026-09-09T00:00:00Z",
    );
    expect(body).toContain("on000001 (ds000001)");
    expect(body).toContain("https://example/1");
    expect(body).toContain("on000002 (ds000002)");
    expect(body).toContain(String(IMPORT_ISSUE_RESUME));
  });

  /**
   * The body is written once, at creation, and later datasets join as comments.
   * So it must not state a running total: an earlier version opened with "1
   * dataset(s) affected" and that line stayed frozen at 1 while a dozen comments
   * accumulated below it. The old test asserted only that the dataset lines were
   * present, which is why the frozen count was invisible to it.
   */
  test("the rollup body states no total, because it is never rewritten", () => {
    const body = buildRollupIssueBody(
      "auth_invalid",
      "GitHub rejected the credential.",
      [{ datasetId: "on000001", sourceId: "ds000001", workflowRunUrl: null }],
      "2026-09-09T00:00:00Z",
    );
    expect(body).not.toContain("dataset(s) affected");
    // ...and says where the rest of the set actually lives.
    expect(body).toContain("appended as a comment");
  });

  test("the rollup body says the cap is a floor, not a strict threshold", () => {
    // The rule is `>= CAP`, so the rollup opens exactly when the count REACHES
    // the cap. "more than 10" was false in precisely the case that creates it.
    const body = buildRollupIssueBody("auth_invalid", "s", [], "2026-09-09T00:00:00Z");
    expect(body).toContain(`${IMPORT_ISSUE_CAP} or more`);
  });

  test("the release comment disclaims being a verdict on the datasets", () => {
    const body = buildRollupReleaseComment(3, "2026-09-09T00:00:00Z");
    expect(body).toContain(String(IMPORT_ISSUE_RESUME));
    expect(body).toContain("NOT a verdict on the datasets");
    // Closing a GitHub issue does not delete it, and a reader needs to know the
    // records are still there.
    expect(body).toContain("Nothing here is deleted");
  });
});
