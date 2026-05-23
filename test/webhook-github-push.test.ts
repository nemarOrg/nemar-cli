/**
 * Tests for the GitHub App webhook dispatch filter.
 *
 * The endpoint logic at `POST /webhooks/github` is composed of:
 *   1. HMAC signature verification (covered by webhook-signature.test.ts)
 *   2. Event type filter (only `push` is acted on today)
 *   3. The pure decision function `shouldDispatchEnrichment` (covered here)
 *   4. The outbound `triggerEnrichmentRun` call (covered by trigger-enrichment.test.ts)
 *
 * Keeping `shouldDispatchEnrichment` pure means the full filter table can be
 * asserted without spinning up a Hono app, fake GitHub, or env mocks. Phase
 * 1 of epic #601 / sub-issue #602.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { shouldDispatchEnrichment } from "../backend/src/routes/webhooks";

type PushPayload = Parameters<typeof shouldDispatchEnrichment>[0];

function pushEvent(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    ref: "refs/heads/main",
    repository: {
      name: "nm099999",
      owner: { login: "nemarDatasets" },
    },
    commits: [{ modified: ["README.md"] }],
    head_commit: { modified: ["README.md"] },
    deleted: false,
    ...overrides,
  };
}

describe("shouldDispatchEnrichment", () => {
  describe("happy paths", () => {
    test("dispatches when main-branch push touches README.md", () => {
      const decision = shouldDispatchEnrichment(pushEvent());
      expect(decision.dispatch).toBe(true);
      if (decision.dispatch) {
        expect(decision.datasetId).toBe("nm099999");
        expect(decision.ref).toBe("main");
        expect(decision.force).toBe(false);
      }
    });

    test("dispatches when main-branch push touches dataset_description.json", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({
          commits: [{ modified: ["dataset_description.json"] }],
          head_commit: { modified: ["dataset_description.json"] },
        }),
      );
      expect(decision.dispatch).toBe(true);
    });

    test("dispatches when main-branch push touches .nemar/metadata.json", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({
          commits: [{ modified: [".nemar/metadata.json"] }],
          head_commit: { modified: [".nemar/metadata.json"] },
        }),
      );
      expect(decision.dispatch).toBe(true);
    });

    test("dispatches when README is in `added` (new file) instead of `modified`", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({
          commits: [{ added: ["README.md"] }],
          head_commit: { added: ["README.md"] },
        }),
      );
      expect(decision.dispatch).toBe(true);
    });

    test("dispatches when README is only in `removed`", () => {
      // Removing the README still warrants re-enrichment so D1's stale
      // enrichment_json doesn't keep advertising the deleted content.
      const decision = shouldDispatchEnrichment(
        pushEvent({
          commits: [{ removed: ["README.md"] }],
          head_commit: { removed: ["README.md"] },
        }),
      );
      expect(decision.dispatch).toBe(true);
    });

    test("dispatches with force=true on a release branch push", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({ ref: "refs/heads/release/v1.0.0" }),
      );
      expect(decision.dispatch).toBe(true);
      if (decision.dispatch) {
        expect(decision.ref).toBe("release/v1.0.0");
        expect(decision.force).toBe(true);
      }
    });

    test("merges paths across commits + head_commit (path on head_commit only)", () => {
      // Force-push edge case where head_commit lists paths not in the
      // commits[] entries; both sides must be considered.
      const decision = shouldDispatchEnrichment(
        pushEvent({
          commits: [{ modified: ["sub-01/x.tsv"] }],
          head_commit: { modified: ["README.md"] },
        }),
      );
      expect(decision.dispatch).toBe(true);
    });
  });

  describe("non-dispatch paths", () => {
    test("does not dispatch when the branch was deleted", () => {
      const decision = shouldDispatchEnrichment(pushEvent({ deleted: true }));
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("branch_deleted");
    });

    test("does not dispatch when the owner is not nemarDatasets", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({ repository: { name: "nm099999", owner: { login: "nemarOrg" } } }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("wrong_owner");
    });

    test("does not dispatch when the repo name is not a dataset id", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({ repository: { name: ".github", owner: { login: "nemarDatasets" } } }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("not_a_dataset_repo");
    });

    test("does not dispatch when the dataset id has wrong shape", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({
          repository: { name: "nm99999", owner: { login: "nemarDatasets" } },
        }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("not_a_dataset_repo");
    });

    test("does not dispatch on a tag push (refs/tags/...)", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({ ref: "refs/tags/v1.0.0" }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("ref_not_main_or_release");
    });

    test("does not dispatch on a feature-branch push", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({ ref: "refs/heads/feature/x" }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("ref_not_main_or_release");
    });

    test("does not dispatch when no relevant path is touched", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({
          commits: [{ modified: ["sub-01/eeg/sub-01_task-rest_eeg.bdf"] }],
          head_commit: { modified: ["sub-01/eeg/sub-01_task-rest_eeg.bdf"] },
        }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("no_enrichment_paths_touched");
    });

    test("does not dispatch when ref is missing entirely", () => {
      const decision = shouldDispatchEnrichment(pushEvent({ ref: undefined }));
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("ref_not_main_or_release");
    });

    test("does not dispatch when commits + head_commit are both empty", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({ commits: [], head_commit: null }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("no_enrichment_paths_touched");
    });
  });

  describe("dataset id prefixes", () => {
    test("accepts nm-prefix repos", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({ repository: { name: "nm000132", owner: { login: "nemarDatasets" } } }),
      );
      expect(decision.dispatch).toBe(true);
    });

    test("accepts on-prefix repos", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({ repository: { name: "on002778", owner: { login: "nemarDatasets" } } }),
      );
      expect(decision.dispatch).toBe(true);
    });

    test("accepts xx-prefix sandbox repos", () => {
      const decision = shouldDispatchEnrichment(
        pushEvent({ repository: { name: "xx000001", owner: { login: "nemarDatasets" } } }),
      );
      expect(decision.dispatch).toBe(true);
    });
  });
});
