/**
 * getBidsTreeStats signal-defaults probe tests (epic #1144 Phase 2b, #1153;
 * widened after the #1162 PR review's C2/I4 findings).
 *
 * Exercises the REAL `getBidsTreeStats` -- the entry point (`.rules/testing.md`'s
 * "test the entry point, not the piece") that both the reindex path
 * (dataset-reindex.ts) and the signal-defaults sweep drive -- against a local
 * Bun.serve fake GitHub (`startFakeGithub`, the same real-network-boundary
 * substitute `test/rate-limit-retry.test.ts` and `test/tree-batched-commit.test.ts`
 * already use; not a mock of fetch, a real HTTP server production code talks to
 * unchanged).
 *
 * Four things this file proves with a test that FAILS on a regression, not
 * just passes today:
 *
 *   - Root-level preference for signal_defaults: a subject-level `*_eeg.json`
 *     is a BIDS inheritance OVERRIDE, not the dataset default. The first
 *     describe block proves both resolution and the fallback, checking fetch
 *     COUNTS (not just returned values) so "fetch both, prefer root's
 *     values" -- which would pass a values-only assertion -- still fails.
 *   - EEGChannelCount stays SUBJECT-scoped even when signal_defaults
 *     correctly prefers root (#1162 review, I4): one blob choice must not
 *     serve two purposes with opposite inheritance semantics.
 *   - A swallowed TRANSPORT failure inside the secondary probe is
 *     distinguished from genuine absence via `channelMontageProbeError`,
 *     while the primary modalities/subjectCount walk -- which already
 *     succeeded -- is NOT thrown away (#1162 review, C2; ADR 0005).
 *   - No gratuitous extra network call: the common case (no distinct root
 *     default) still fetches the shared sidecar once; a genuine root+subject
 *     conflict is the only case that costs a second fetch, and that is the
 *     deliberate, disclosed trade-off I4 introduced.
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

// EEGChannelCount deliberately DISTINCT from CHANNELS_TSV's label count (3)
// AND from each other, so a test can tell at a glance which source won.
const ROOT_EEG_JSON = {
  SamplingFrequency: 512,
  PowerLineFrequency: 60,
  EEGReference: "average",
  EEGPlacementScheme: "extended 10-10% system",
  EEGChannelCount: 128,
};
const SUBJECT_EEG_JSON = {
  SamplingFrequency: 256,
  PowerLineFrequency: 50,
  EEGReference: "Cz",
  EEGPlacementScheme: "10-20",
  EEGChannelCount: 19,
};
const CHANNELS_TSV = ["name\ttype", "Fp1\tEEG", "Fp2\tEEG", "Cz\tEEG"].join("\n");

let fake: FakeGithubServer;
/** Whether the root tree fixture includes the root-level `*_eeg.json` entry;
 *  toggled per-test. */
let rootHasEegJson = true;
/** Whether the subject subtree includes its own `*_channels.tsv`; toggled
 *  per-test to isolate the EEGChannelCount sidecar-fallback path (I4),
 *  which `resolveNChannels` only reaches when no channels.tsv exists. */
let subjectHasChannelsTsv = true;
/** When true, the subject's `*_eeg.json` blob GET returns a 500 instead of
 *  content, simulating a transport failure inside probeChannelMontage
 *  (C2). */
let subjectEegJsonTransportFails = false;

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
    [`GET /repos/nemarDatasets/${REPO}/git/trees/${SUBJ_SHA}`]: () => {
      const tree: Array<{ path: string; type: string; sha: string }> = [
        { path: "eeg/sub-01_task-rest_eeg.json", type: "blob", sha: SUBJ_EEG_JSON_SHA },
      ];
      if (subjectHasChannelsTsv) {
        tree.unshift({
          path: "eeg/sub-01_task-rest_channels.tsv",
          type: "blob",
          sha: SUBJ_TSV_SHA,
        });
      }
      return json(200, { tree, truncated: false });
    },
    [`GET /repos/nemarDatasets/${REPO}/git/blobs/${ROOT_EEG_JSON_SHA}`]: () =>
      json(200, {
        sha: ROOT_EEG_JSON_SHA,
        content: btoa(JSON.stringify(ROOT_EEG_JSON)),
        encoding: "base64",
      }),
    [`GET /repos/nemarDatasets/${REPO}/git/blobs/${SUBJ_EEG_JSON_SHA}`]: () => {
      if (subjectEegJsonTransportFails) {
        return json(500, { message: "simulated GitHub 500" });
      }
      return json(200, {
        sha: SUBJ_EEG_JSON_SHA,
        content: btoa(JSON.stringify(SUBJECT_EEG_JSON)),
        encoding: "base64",
      });
    },
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
  subjectHasChannelsTsv = true;
  subjectEegJsonTransportFails = false;
});

describe("getBidsTreeStats: root-level *_eeg.json preference for signal_defaults (#1153)", () => {
  test("a root-level sidecar's values win over a subject-level one's", async () => {
    const stats = await getBidsTreeStats(REPO, "main", PAT);

    expect(stats.samplingFrequency).toBe(512);
    expect(stats.powerLineFrequency).toBe(60);
    expect(stats.eegReference).toBe("average");
    expect(stats.placementScheme).toBe("extended 10-10% system");
    // Both blobs are legitimately fetched now (I4: the subject's own file is
    // still needed for EEGChannelCount), so this is a values assertion, not
    // a fetch-count one -- the fetch-count regression guard lives in the
    // "no extra network call" describe block below, which asserts the
    // TOTAL count and is what actually catches "fetch both, prefer root's
    // values" (a values-only check here cannot).
    expect(
      fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/git/blobs/${ROOT_EEG_JSON_SHA}`],
    ).toBe(1);
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
  // explicitly: swap the `rootEegJson ?? exemplarEegJson` operand feeding
  // the SIGNAL-DEFAULTS source in bids-tree.ts (prefer subject over root)
  // and this test fails, because the returned sampling_frequency becomes
  // the SUBJECT value (256) while a root-level sidecar is present and
  // should have won.
  test("REGRESSION GUARD: resolved signal_defaults values are the ROOT ones, not the subject ones, when both exist", async () => {
    const stats = await getBidsTreeStats(REPO, "main", PAT);
    expect(stats.samplingFrequency).not.toBe(SUBJECT_EEG_JSON.SamplingFrequency);
    expect(stats.samplingFrequency).toBe(ROOT_EEG_JSON.SamplingFrequency);
  });
});

describe("getBidsTreeStats: EEGChannelCount stays subject-scoped, independent of signal_defaults' root preference (#1162 review, I4)", () => {
  test("channels.tsv wins over any sidecar when present (unaffected baseline)", async () => {
    const stats = await getBidsTreeStats(REPO, "main", PAT);
    // 3 labels in CHANNELS_TSV, all typed EEG -- tsv wins over EITHER
    // sidecar's EEGChannelCount per resolveNChannels's documented
    // precedence, so this alone cannot distinguish root-sourced from
    // subject-sourced. See the next test for that.
    expect(stats.nChannels).toBe(3);
  });

  test("REGRESSION GUARD: with no channels.tsv, EEGChannelCount comes from the SUBJECT's own sidecar, not the root default", async () => {
    // Forces resolveNChannels to fall back to the sidecar's EEGChannelCount
    // (no tsv to prefer). ROOT_EEG_JSON declares 128, SUBJECT_EEG_JSON
    // declares 19 -- distinct enough that sourcing from the wrong one is
    // unambiguous. Before I4's fix, the single root-preferred `eegJson`
    // fed BOTH purposes, so this would have read 128 (root) instead of the
    // correct 19 (the sampled subject's own recording).
    subjectHasChannelsTsv = false;
    const stats = await getBidsTreeStats(REPO, "main", PAT);
    expect(stats.nChannels).toBe(SUBJECT_EEG_JSON.EEGChannelCount);
    expect(stats.nChannels).not.toBe(ROOT_EEG_JSON.EEGChannelCount);
  });
});

describe("getBidsTreeStats: no extra network call beyond the deliberate I4 split (#1153)", () => {
  test("2 blob GETs when no distinct root default exists (dedup case)", async () => {
    rootHasEegJson = false;
    await getBidsTreeStats(REPO, "main", PAT);
    const blobCalls = fake.calls.filter((c) => c.path.includes("/git/blobs/"));
    // channels.tsv + the ONE eeg.json, shared by both purposes -- same
    // count probeChannelMontage made before this phase widened the set of
    // keys it parses out of that one blob.
    expect(blobCalls.length).toBe(2);
  });

  test("3 blob GETs when a genuine root default coexists with the subject's own override (the deliberate I4 trade-off)", async () => {
    // channels.tsv (channel labels) + the subject's own eeg.json
    // (EEGChannelCount, I4) + the root eeg.json (signal_defaults) -- one
    // more than the pre-I4 baseline, and disclosed as such: this is the
    // one scenario where correctly serving two different-inheritance
    // purposes genuinely requires two distinct blobs.
    await getBidsTreeStats(REPO, "main", PAT);
    const blobCalls = fake.calls.filter((c) => c.path.includes("/git/blobs/"));
    expect(blobCalls.length).toBe(3);
  });
});

describe("getBidsTreeStats: a swallowed transport failure is surfaced, not disguised as absence (#1162 review, C2)", () => {
  test("channelMontageProbeError is set, and the four signal_defaults fields stay undefined, on a blob 500", async () => {
    subjectEegJsonTransportFails = true;
    // Force the subject-only path so the failing blob is the one actually
    // fetched for signal_defaults too (no root default to fall back to).
    rootHasEegJson = false;
    const stats = await getBidsTreeStats(REPO, "main", PAT);

    expect(stats.channelMontageProbeError).toBeDefined();
    expect(stats.channelMontageProbeError).toContain("500");
    expect(stats.samplingFrequency).toBeUndefined();
    expect(stats.powerLineFrequency).toBeUndefined();
    expect(stats.eegReference).toBeUndefined();
    expect(stats.placementScheme).toBeUndefined();
    expect(stats.nChannels).toBeUndefined();
  });

  test("the PRIMARY walk (modalities/subjectCount) still succeeds -- getBidsTreeStats itself does not throw", async () => {
    // This is the whole point of surfacing rather than throwing: a
    // transport hiccup fetching ONE secondary blob must not discard the
    // already-completed, more expensive modality/subject walk.
    subjectEegJsonTransportFails = true;
    rootHasEegJson = false;
    const stats = await getBidsTreeStats(REPO, "main", PAT);
    expect(stats.subjectCount).toBe(1);
    expect(stats.modalities).toEqual(["eeg"]);
  });

  test("no probe error on the happy path (sanity check the flag means something)", async () => {
    const stats = await getBidsTreeStats(REPO, "main", PAT);
    expect(stats.channelMontageProbeError).toBeUndefined();
  });
});
