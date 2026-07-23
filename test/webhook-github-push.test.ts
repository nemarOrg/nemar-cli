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
import {
  shouldDispatchEnrichment,
  shouldDispatchVersionDoi,
} from "../backend/src/routes/webhooks/github";

type PushPayload = Parameters<typeof shouldDispatchEnrichment>[0];

function tagPushEvent(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    ref: "refs/tags/v1.0.0",
    repository: {
      name: "nm099999",
      owner: { login: "nemarDatasets" },
    },
    commits: [],
    head_commit: null,
    deleted: false,
    ...overrides,
  };
}

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

    test("does NOT dispatch when only .nemar/metadata.json changed (#643)", () => {
      // `.nemar/metadata.json` is the enrichment output, not an input.
      // Treating it as a trigger turned every enrichment commit into a
      // fresh enrichment run — observed on on007827, ~60 runs/hr until
      // disabled manually. The filter now ignores this path.
      const decision = shouldDispatchEnrichment(
        pushEvent({
          commits: [{ modified: [".nemar/metadata.json"] }],
          head_commit: { modified: [".nemar/metadata.json"] },
        }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) {
        expect(decision.reason).toBe("no_enrichment_paths_touched");
      }
    });

    test("DOES dispatch when README and .nemar/metadata.json both changed", () => {
      // The metadata-only filter must not gate out pushes that ALSO touch
      // a real source (e.g. user edited README and the bot committed an
      // updated metadata.json in the same push).
      const decision = shouldDispatchEnrichment(
        pushEvent({
          commits: [{ modified: ["README.md", ".nemar/metadata.json"] }],
          head_commit: { modified: ["README.md", ".nemar/metadata.json"] },
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

    test("does not dispatch when the repository object lacks an owner field", () => {
      // Malformed payload guard (and future-proofing if GitHub ever ships a
      // push event without owner): the missing-owner case must fall through
      // the same code path as the wrong-owner case so we don't accidentally
      // dispatch on a payload we can't fully validate. Code-review #605.
      const decision = shouldDispatchEnrichment(
        pushEvent({ repository: { name: "nm099999" } } as Partial<Parameters<typeof shouldDispatchEnrichment>[0]>),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("wrong_owner");
    });

    test("does not dispatch when the repository object is missing entirely", () => {
      const decision = shouldDispatchEnrichment(pushEvent({ repository: undefined }));
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

  describe("force-push behavior", () => {
    test("force push that touches README.md still dispatches", () => {
      // GitHub's push event for a force-push carries `forced: true` AND
      // the `commits`/`head_commit` arrays reflect the new history. The
      // decision function shouldn't gate on `forced` — it should fall
      // through to the path-union logic on the post-force-push state.
      // Cross-PR review of epic #601 flagged the missing coverage.
      const decision = shouldDispatchEnrichment(
        pushEvent({
          forced: true,
          commits: [{ modified: ["README.md"] }],
          head_commit: { modified: ["README.md"] },
        }),
      );
      expect(decision.dispatch).toBe(true);
    });

    test("force push that rewrites history without touching enrichment paths does not dispatch", () => {
      // Same `forced: true` flag, but the post-force-push commits don't
      // change README / dataset_description / .nemar/metadata.json — so
      // no enrichment is needed. Confirms `forced` is not an
      // unconditional dispatch signal.
      const decision = shouldDispatchEnrichment(
        pushEvent({
          forced: true,
          commits: [{ modified: ["sub-01/eeg/sub-01_task-rest_eeg.bdf"] }],
          head_commit: { modified: ["sub-01/eeg/sub-01_task-rest_eeg.bdf"] },
        }),
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

// shouldDispatchVersionDoi is the Phase 2 sibling that fans out to the
// run-version-doi workflow on tag pushes. Same owner/dataset-id guards as
// the enrichment path but with a strict version-tag regex on the ref.
describe("shouldDispatchVersionDoi", () => {
  describe("happy paths", () => {
    test("dispatches on a v-prefixed semver tag push", () => {
      const decision = shouldDispatchVersionDoi(tagPushEvent());
      expect(decision.dispatch).toBe(true);
      if (decision.dispatch) {
        expect(decision.datasetId).toBe("nm099999");
        expect(decision.tag).toBe("v1.0.0");
      }
    });

    test("dispatches on a release-candidate tag", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ ref: "refs/tags/v1.2.3-rc1" }),
      );
      expect(decision.dispatch).toBe(true);
      if (decision.dispatch) expect(decision.tag).toBe("v1.2.3-rc1");
    });

    test("dispatches on an alpha tag (no trailing number)", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ ref: "refs/tags/v0.1.0-alpha" }),
      );
      expect(decision.dispatch).toBe(true);
      if (decision.dispatch) expect(decision.tag).toBe("v0.1.0-alpha");
    });

    test("dispatches on a beta tag with a number", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ ref: "refs/tags/v2.0.0-beta3" }),
      );
      expect(decision.dispatch).toBe(true);
      if (decision.dispatch) expect(decision.tag).toBe("v2.0.0-beta3");
    });

    test("accepts on-prefix dataset repos", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({
          repository: { name: "on002778", owner: { login: "nemarDatasets" } },
        }),
      );
      expect(decision.dispatch).toBe(true);
    });
  });

  describe("non-dispatch paths", () => {
    test("does not dispatch when the tag was deleted", () => {
      const decision = shouldDispatchVersionDoi(tagPushEvent({ deleted: true }));
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("tag_deleted");
    });

    test("does not dispatch on a branch push (no refs/tags/ prefix)", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ ref: "refs/heads/main" }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("ref_not_version_tag");
    });

    test("does not dispatch on a tag missing the v prefix", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ ref: "refs/tags/1.0.0" }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("ref_not_version_tag");
    });

    test("does not dispatch on a non-semver tag", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ ref: "refs/tags/vfoo" }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("ref_not_version_tag");
    });

    test("does not dispatch on a tag with too few version components", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ ref: "refs/tags/v1.0" }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("ref_not_version_tag");
    });

    test("does not dispatch on an unsupported pre-release suffix", () => {
      // We only allow rc/alpha/beta — `v1.0.0-snapshot` is rejected.
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ ref: "refs/tags/v1.0.0-snapshot" }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("ref_not_version_tag");
    });

    test("does not dispatch when the owner is not nemarDatasets", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ repository: { name: "nm099999", owner: { login: "nemarOrg" } } }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("wrong_owner");
    });

    test("does not dispatch when the repo name is not a dataset id", () => {
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ repository: { name: ".github", owner: { login: "nemarDatasets" } } }),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("not_a_dataset_repo");
    });

    test("does not dispatch when repository is missing entirely", () => {
      const decision = shouldDispatchVersionDoi(tagPushEvent({ repository: undefined }));
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("wrong_owner");
    });

    test("does not dispatch when the repository object lacks an owner field", () => {
      // Defensive guard against malformed payloads / a future GitHub API
      // change. Parallel to the enrichment-side coverage; pin both so a
      // refactor can't accidentally break one while keeping the other.
      const decision = shouldDispatchVersionDoi(
        tagPushEvent({ repository: { name: "nm099999" } } as Partial<Parameters<typeof shouldDispatchVersionDoi>[0]>),
      );
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.reason).toBe("wrong_owner");
    });
  });

  describe("dispatch-handler reason picker", () => {
    test("on tag push, falls through enrichment's ref bail to version-doi's reason", () => {
      // Smoke test for the picker at /webhooks/github: when enrichment
      // rejects a tag push with the generic `ref_not_main_or_release`, the
      // operator-facing reason should expose version-doi's more specific
      // ref-shape verdict instead. We don't drive the Hono handler here
      // (that requires env wiring); we assert the two decision outputs
      // line up with the picker's invariant.
      const tagOnDataset = tagPushEvent({ ref: "refs/tags/vfoo" });
      const enrichmentDecision = shouldDispatchEnrichment(tagOnDataset);
      const versionDoiDecision = shouldDispatchVersionDoi(tagOnDataset);

      // Both decisions reject this payload.
      expect(enrichmentDecision.dispatch).toBe(false);
      expect(versionDoiDecision.dispatch).toBe(false);
      if (enrichmentDecision.dispatch || versionDoiDecision.dispatch) return;

      // Enrichment bails at the ref category, version-doi at the ref shape.
      expect(enrichmentDecision.reason).toBe("ref_not_main_or_release");
      expect(versionDoiDecision.reason).toBe("ref_not_version_tag");

      // The handler's picker should surface version-doi's reason (more
      // informative for an operator debugging a tag-shape bug).
      const surfaced =
        enrichmentDecision.reason === "ref_not_main_or_release"
          ? versionDoiDecision.reason
          : enrichmentDecision.reason;
      expect(surfaced).toBe("ref_not_version_tag");
    });
  });
});
