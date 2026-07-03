/**
 * Tests for the Zarr-generation dispatch filter (epic #684 / Stream C #685).
 *
 * `POST /webhooks/github` fans a `push` delivery out to the Zarr workflow via
 * the pure decision function `shouldDispatchZarr` (and its path matcher
 * `isZarrTriggerPath`). Keeping both pure lets the filter table be asserted
 * without a Hono app / fake GitHub / env mocks, mirroring
 * webhook-github-push.test.ts.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { isZarrTriggerPath, shouldDispatchZarr } from "../backend/src/routes/webhooks/github";

type PushPayload = Parameters<typeof shouldDispatchZarr>[0];

function dataPush(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    ref: "refs/heads/main",
    repository: {
      name: "nm099999",
      owner: { login: "nemarDatasets" },
    },
    commits: [{ modified: ["sub-01/eeg/sub-01_task-rest_eeg.set"] }],
    head_commit: { modified: ["sub-01/eeg/sub-01_task-rest_eeg.set"] },
    deleted: false,
    ...overrides,
  };
}

describe("isZarrTriggerPath", () => {
  test("matches primary recording containers", () => {
    for (const p of [
      "sub-01/eeg/sub-01_task-x_eeg.set",
      "sub-01/emg/sub-01_task-x_emg.edf",
      "sub-01/ieeg/sub-01_task-x_ieeg.bdf",
      "sub-01/eeg/sub-01_eeg.vhdr",
      "sub-01/meg/sub-01_task-x_meg.fif",
    ]) {
      expect(isZarrTriggerPath(p)).toBe(true);
    }
  });

  test("matches companion files (a change confined to them still reconverts)", () => {
    for (const p of [
      "sub-01/eeg/sub-01_task-x_eeg.fdt", // EEGLAB samples
      "sub-01/eeg/sub-01_eeg.eeg", // BrainVision samples
      "sub-01/eeg/sub-01_eeg.vmrk", // BrainVision markers
    ]) {
      expect(isZarrTriggerPath(p)).toBe(true);
    }
  });

  test("matches the curated BIDS events sidecar", () => {
    expect(isZarrTriggerPath("sub-01/eeg/sub-01_task-x_events.tsv")).toBe(true);
  });

  test("matches any file inside a CTF .ds recording directory", () => {
    expect(isZarrTriggerPath("sub-01/meg/sub-01_task-x_meg.ds/sub-01_task-x_meg.meg4")).toBe(true);
  });

  test("does NOT match a bare .ds directory entry with no trailing slash", () => {
    // GitHub push events list files, not directories, so a `.ds` recording
    // surfaces as the files under it (which carry `.ds/`). Pin the bare-dir
    // path's current behavior (false) so a change to the `.ds/` check is
    // explicit rather than silent.
    expect(isZarrTriggerPath("sub-01/meg/sub-01_task-x_meg.ds")).toBe(false);
  });

  test("does NOT match metadata / sidecar JSON / README / other tsv", () => {
    for (const p of [
      "dataset_description.json",
      "README.md",
      "sub-01/eeg/sub-01_task-x_eeg.json",
      "sub-01/eeg/sub-01_task-x_channels.tsv",
      "participants.tsv",
      "CHANGES",
    ]) {
      expect(isZarrTriggerPath(p)).toBe(false);
    }
  });

  test("extension match is case-insensitive", () => {
    expect(isZarrTriggerPath("sub-01/eeg/sub-01_eeg.EDF")).toBe(true);
  });
});

describe("shouldDispatchZarr", () => {
  test("dispatches when a main push modifies a recording", () => {
    const d = shouldDispatchZarr(dataPush());
    expect(d.dispatch).toBe(true);
    if (d.dispatch) {
      expect(d.datasetId).toBe("nm099999");
      expect(d.ref).toBe("main");
    }
  });

  test("dispatches when a recording is added", () => {
    const d = shouldDispatchZarr(
      dataPush({
        commits: [{ added: ["sub-02/eeg/sub-02_task-x_eeg.set"] }],
        head_commit: { added: ["sub-02/eeg/sub-02_task-x_eeg.set"] },
      }),
    );
    expect(d.dispatch).toBe(true);
  });

  test("dispatches when a recording is removed (store must be deleted)", () => {
    const d = shouldDispatchZarr(
      dataPush({
        commits: [{ removed: ["sub-02/eeg/sub-02_task-x_eeg.set"] }],
        head_commit: { removed: ["sub-02/eeg/sub-02_task-x_eeg.set"] },
      }),
    );
    expect(d.dispatch).toBe(true);
  });

  test("dispatches when only an events.tsv changes (refresh embedded events)", () => {
    const d = shouldDispatchZarr(
      dataPush({
        commits: [{ modified: ["sub-01/eeg/sub-01_task-x_events.tsv"] }],
        head_commit: { modified: ["sub-01/eeg/sub-01_task-x_events.tsv"] },
      }),
    );
    expect(d.dispatch).toBe(true);
  });

  test("does NOT dispatch when only metadata/README changed", () => {
    const d = shouldDispatchZarr(
      dataPush({
        commits: [{ modified: ["README.md", "dataset_description.json"] }],
        head_commit: { modified: ["README.md", "dataset_description.json"] },
      }),
    );
    expect(d.dispatch).toBe(false);
    if (!d.dispatch) expect(d.reason).toBe("no_data_or_events_paths_touched");
  });

  test("unions across commits and head_commit (force-push tip path)", () => {
    const d = shouldDispatchZarr(
      dataPush({
        commits: [{ modified: ["README.md"] }],
        head_commit: { modified: ["sub-01/eeg/sub-01_task-x_eeg.set"] },
      }),
    );
    expect(d.dispatch).toBe(true);
  });

  test("does NOT dispatch on a tag push (zarr tracks main HEAD only)", () => {
    const d = shouldDispatchZarr(dataPush({ ref: "refs/tags/v1.0.0" }));
    expect(d.dispatch).toBe(false);
    if (!d.dispatch) expect(d.reason).toBe("ref_not_main");
  });

  test("does NOT dispatch on a release branch push", () => {
    const d = shouldDispatchZarr(dataPush({ ref: "refs/heads/release/1.0.0" }));
    expect(d.dispatch).toBe(false);
    if (!d.dispatch) expect(d.reason).toBe("ref_not_main");
  });

  test("does NOT dispatch on a branch delete", () => {
    const d = shouldDispatchZarr(dataPush({ deleted: true }));
    expect(d.dispatch).toBe(false);
    if (!d.dispatch) expect(d.reason).toBe("branch_deleted");
  });

  test("rejects non-nemarDatasets owner", () => {
    const d = shouldDispatchZarr(
      dataPush({ repository: { name: "nm099999", owner: { login: "someoneElse" } } }),
    );
    expect(d.dispatch).toBe(false);
    if (!d.dispatch) expect(d.reason).toBe("wrong_owner");
  });

  test("rejects a non-dataset repo name", () => {
    const d = shouldDispatchZarr(
      dataPush({ repository: { name: "nemar-cli", owner: { login: "nemarDatasets" } } }),
    );
    expect(d.dispatch).toBe(false);
    if (!d.dispatch) expect(d.reason).toBe("not_a_dataset_repo");
  });

  test("rejects when repository is missing entirely (malformed payload guard)", () => {
    const d = shouldDispatchZarr(dataPush({ repository: undefined }));
    expect(d.dispatch).toBe(false);
    if (!d.dispatch) expect(d.reason).toBe("wrong_owner");
  });

  test("rejects when repository object lacks an owner field", () => {
    const d = shouldDispatchZarr(dataPush({ repository: { name: "nm099999" } }));
    expect(d.dispatch).toBe(false);
    if (!d.dispatch) expect(d.reason).toBe("wrong_owner");
  });

  test("does NOT dispatch when commits is empty and head_commit is null", () => {
    // GitHub edge case (webhook re-delivery / no-diff push): the path union
    // must short-circuit cleanly to no-dispatch, never throw on the null tip.
    const d = shouldDispatchZarr(dataPush({ commits: [], head_commit: null }));
    expect(d.dispatch).toBe(false);
    if (!d.dispatch) expect(d.reason).toBe("no_data_or_events_paths_touched");
  });
});
