/**
 * getBidsTreeStats signal-defaults probe tests (epic #1144 Phase 2b, #1153).
 *
 * Exercises the REAL `getBidsTreeStats` -- the entry point (`.rules/testing.md`'s
 * "test the entry point, not the piece") that both the reindex path
 * (dataset-reindex.ts) and the signal-defaults sweep drive -- against a local
 * Bun.serve fake GitHub (`startFakeGithub`, the same real-network-boundary
 * substitute `test/rate-limit-retry.test.ts` and `test/tree-batched-commit.test.ts`
 * already use; not a mock of fetch, a real HTTP server production code talks to
 * unchanged).
 *
 * Two things this phase's plan calls out as needing a test that FAILS on a
 * regression, not just passes today:
 *
 *   - Root-level preference: a subject-level `*_eeg.json` is a BIDS
 *     inheritance OVERRIDE, not the dataset default. Publishing it as
 *     signal_defaults would invert the inheritance direction. The first
 *     describe block below proves BOTH resolution and the fallback, and
 *     proves the SUBJECT sidecar is never even fetched when a root one
 *     exists (not just that root's values win) -- swapping `??` for the
 *     wrong operand, or fetching both and preferring root's values, would
 *     fail this file's fetch-count assertions even if the returned values
 *     happened to look right.
 *   - No extra network call: widening probeChannelMontage to parse four more
 *     keys out of the SAME already-fetched blob must not add a request.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import { getBidsTreeStats } from "../backend/src/services/github";
import { type FakeGithubServer, json, startFakeGithub } from "./helpers/fetch-counter";

const REPO = "nm099999";
const PAT = "fake-pat-for-tests";
const ROOT_SHA = "root0000000000000000000000000000000001";
const SUBJ_SHA = "subj0000000000000000000000000000000001";

const ROOT_EEG_JSON_SHA = "blobroot0000000000000000000000000001";
const SUBJ_EEG_JSON_SHA = "blobsubj0000000000000000000000000001";
const SUBJ_TSV_SHA = "blobtsv00000000000000000000000000001";

const ROOT_EEG_JSON = {
  SamplingFrequency: 512,
  PowerLineFrequency: 60,
  EEGReference: "average",
  EEGPlacementScheme: "extended 10-10% system",
};
const SUBJECT_EEG_JSON = {
  SamplingFrequency: 256,
  PowerLineFrequency: 50,
  EEGReference: "Cz",
  EEGPlacementScheme: "10-20",
};
const CHANNELS_TSV = ["name\ttype", "Fp1\tEEG", "Fp2\tEEG", "Cz\tEEG"].join("\n");

let fake: FakeGithubServer;
/** Whether the root tree fixture includes the root-level `*_eeg.json` entry
 *  for this test; toggled per-test via `rootHasEegJson`. */
let rootHasEegJson = true;

function setGithubApiOverride(url: string | undefined): void {
  if (url === undefined) {
    delete (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  } else {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = url;
  }
}

beforeAll(() => {
  fake = startFakeGithub({
    [`GET /repos/nemarDatasets/${REPO}/commits/main`]: () =>
      json(200, { commit: { tree: { sha: ROOT_SHA } } }),
    [`GET /repos/nemarDatasets/${REPO}/git/trees/${ROOT_SHA}`]: () => {
      const tree: Array<{ path: string; type: string; sha: string }> = [
        { path: "sub-01", type: "tree", sha: SUBJ_SHA },
      ];
      if (rootHasEegJson) {
        tree.push({ path: "task-rest_eeg.json", type: "blob", sha: ROOT_EEG_JSON_SHA });
      }
      return json(200, { tree, truncated: false });
    },
    [`GET /repos/nemarDatasets/${REPO}/git/trees/${SUBJ_SHA}`]: () =>
      json(200, {
        tree: [
          { path: "eeg/sub-01_task-rest_channels.tsv", type: "blob", sha: SUBJ_TSV_SHA },
          { path: "eeg/sub-01_task-rest_eeg.json", type: "blob", sha: SUBJ_EEG_JSON_SHA },
        ],
        truncated: false,
      }),
    [`GET /repos/nemarDatasets/${REPO}/git/blobs/${ROOT_EEG_JSON_SHA}`]: () =>
      json(200, {
        sha: ROOT_EEG_JSON_SHA,
        content: btoa(JSON.stringify(ROOT_EEG_JSON)),
        encoding: "base64",
      }),
    [`GET /repos/nemarDatasets/${REPO}/git/blobs/${SUBJ_EEG_JSON_SHA}`]: () =>
      json(200, {
        sha: SUBJ_EEG_JSON_SHA,
        content: btoa(JSON.stringify(SUBJECT_EEG_JSON)),
        encoding: "base64",
      }),
    [`GET /repos/nemarDatasets/${REPO}/git/blobs/${SUBJ_TSV_SHA}`]: () =>
      json(200, { sha: SUBJ_TSV_SHA, content: btoa(CHANNELS_TSV), encoding: "base64" }),
  });
  setGithubApiOverride(fake.url);
});

afterAll(() => {
  fake.stop();
  setGithubApiOverride(undefined);
});

beforeEach(() => {
  fake.reset();
  rootHasEegJson = true;
});

describe("getBidsTreeStats: root-level *_eeg.json preference (#1153)", () => {
  test("a root-level sidecar wins over a subject-level one -- AND the subject sidecar is never fetched", async () => {
    const stats = await getBidsTreeStats(REPO, "main", PAT);

    expect(stats.samplingFrequency).toBe(512);
    expect(stats.powerLineFrequency).toBe(60);
    expect(stats.eegReference).toBe("average");
    expect(stats.placementScheme).toBe("extended 10-10% system");

    // The regression this guards against: fetching BOTH sidecars and
    // preferring root's VALUES would still pass the assertions above. Only
    // checking the fetch count catches that -- and catches the `??`
    // operand being flipped (subject preferred over root), which would
    // fetch the subject blob and return ITS values instead.
    expect(
      fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/git/blobs/${ROOT_EEG_JSON_SHA}`],
    ).toBe(1);
    expect(
      fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/git/blobs/${SUBJ_EEG_JSON_SHA}`],
    ).toBeUndefined();
  });

  test("falls back to the subject-level exemplar when no root-level sidecar exists", async () => {
    rootHasEegJson = false;
    const stats = await getBidsTreeStats(REPO, "main", PAT);

    expect(stats.samplingFrequency).toBe(256);
    expect(stats.powerLineFrequency).toBe(50);
    expect(stats.eegReference).toBe("Cz");
    expect(stats.placementScheme).toBe("10-20");
    expect(
      fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/git/blobs/${SUBJ_EEG_JSON_SHA}`],
    ).toBe(1);
  });

  // This is the inheritance-direction assertion the plan calls out
  // explicitly: swap the `rootEegJson ?? exemplarEegJson` operands in
  // bids-tree.ts (prefer subject over root) and this test fails, because
  // the returned sampling_frequency becomes the SUBJECT value (256) while a
  // root-level sidecar is present and should have won.
  test("REGRESSION GUARD: resolved values are the ROOT ones, not the subject ones, when both exist", async () => {
    const stats = await getBidsTreeStats(REPO, "main", PAT);
    expect(stats.samplingFrequency).not.toBe(SUBJECT_EEG_JSON.SamplingFrequency);
    expect(stats.samplingFrequency).toBe(ROOT_EEG_JSON.SamplingFrequency);
  });
});

describe("getBidsTreeStats: no extra network call from the widened probe (#1153)", () => {
  test("exactly one *_eeg.json blob GET total, whether root or subject-only", async () => {
    // Root case: exactly 2 blob GETs total (channels.tsv + the one eeg.json),
    // same count probeChannelMontage made before this phase widened the set
    // of keys it parses out of that one blob.
    await getBidsTreeStats(REPO, "main", PAT);
    const blobCalls = fake.calls.filter((c) => c.path.includes("/git/blobs/"));
    expect(blobCalls.length).toBe(2);

    fake.reset();
    rootHasEegJson = false;
    await getBidsTreeStats(REPO, "main", PAT);
    const blobCallsFallback = fake.calls.filter((c) => c.path.includes("/git/blobs/"));
    expect(blobCallsFallback.length).toBe(2);
  });
});

describe("getBidsTreeStats: n_channels/electrode_system are unaffected by the root-eeg.json change", () => {
  test("still sourced from the subject exemplar's channels.tsv, not the root sidecar", async () => {
    const stats = await getBidsTreeStats(REPO, "main", PAT);
    // 3 labels in CHANNELS_TSV, all typed EEG.
    expect(stats.nChannels).toBe(3);
  });
});
