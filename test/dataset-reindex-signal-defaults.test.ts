/**
 * Real entry-point coverage for refreshDatasetMetadata's signal_defaults
 * override threading (#1162 PR review, I7).
 *
 * Before this file, `refreshDatasetMetadata` itself had ZERO test coverage
 * anywhere in the suite -- deleting all four `samplingFrequencyOverride`-
 * style assignment lines (or transposing which named `computeDatasetMetadataColumns`
 * parameter each `stats.*` value feeds) left every existing test green,
 * including a full `bun test` run. This is pre-existing debt shared by the
 * OLDER overrides (`nChannelsOverride`, `electrodeSystemOverride`,
 * `hasHedOverride`, `hedVersionOverride` are equally unexercised before and
 * after this file) -- scoped here to the four NEW ones because a
 * transposition among them would be silent, per the review.
 *
 * Drives the REAL `refreshDatasetMetadata` -- the entry point both the
 * version-DOI webhook and the admin reindex route use -- against a real D1
 * (bun:sqlite behind realD1) and a real local Bun.serve fake GitHub
 * (`startFakeGithub`, same real-network-boundary substitute as
 * `test/bids-tree-signal-defaults.test.ts`). `env.GITHUB_ADMIN_PAT` is set
 * to a fake string so `getDatasetsToken` resolves via the synchronous PAT
 * fallback path (`getDefaultGitHubAuth`) with no App-token network call.
 * S3 (`getDatasetS3Stats`) and Vectorize (`reembedDatasetVector`) are left
 * genuinely unconfigured/unreachable -- both are internally guarded
 * (getDatasetS3Stats's failure is caught and logged; reembedDatasetVector
 * short-circuits when `env.AI`/`env.VECTORIZE` are undefined) so neither
 * blocks or fails this test, matching real production behavior for a
 * dataset whose S3 lookup transiently fails.
 *
 * The seeded dataset has no `dataset_versions` row, so
 * `verifyDatasetVersionS3` is never reached either (see
 * refreshDatasetMetadata's `targetVersion` guard) -- keeping this test's
 * only real network dependency the fake GitHub server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import { refreshDatasetMetadata } from "../backend/src/services/dataset-reindex";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { type FakeGithubServer, json, startFakeGithub } from "./helpers/fetch-counter";

const REPO = "nm000860";
const ROOT_SHA = "root0860000000000000000000000000000001";
const SUBJ_SHA = "subj0860000000000000000000000000000001";
const SUBJ_EEG_JSON_SHA = "blobeeg0860000000000000000000000000001";

// Four distinct, recognizable values so a transposition among the four
// named `computeDatasetMetadataColumns` parameters (e.g. eegReference
// landing where placementScheme should) is observable, not masked by two
// fields sharing a value.
const SUBJECT_EEG_JSON = {
  SamplingFrequency: 333,
  PowerLineFrequency: 50,
  EEGReference: "linked-mastoid",
  EEGPlacementScheme: "custom cap layout",
};

let fake: FakeGithubServer;
let db: Database;

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
      json(200, { sha: "commitsha1", commit: { tree: { sha: ROOT_SHA } } }),
    // Serves BOTH getTreeAtRef's recursive request and getBidsTreeStats's
    // non-recursive root-tree request -- the fake server routes by
    // pathname only, ignoring `?recursive=1`. A tree containing just the
    // `sub-01` directory is valid input to both callers: getTreeAtRef
    // filters to blob entries only (none here, so treePaths is empty and
    // every getBidsTreeStats override below wins instead), and
    // getBidsTreeStats reads `sub-01` as its one sampled subject.
    [`GET /repos/nemarDatasets/${REPO}/git/trees/${ROOT_SHA}`]: () =>
      json(200, { tree: [{ path: "sub-01", type: "tree", sha: SUBJ_SHA }], truncated: false }),
    [`GET /repos/nemarDatasets/${REPO}/git/trees/${SUBJ_SHA}`]: () =>
      json(200, {
        tree: [{ path: "eeg/sub-01_task-rest_eeg.json", type: "blob", sha: SUBJ_EEG_JSON_SHA }],
        truncated: false,
      }),
    [`GET /repos/nemarDatasets/${REPO}/git/blobs/${SUBJ_EEG_JSON_SHA}`]: () =>
      json(200, {
        sha: SUBJ_EEG_JSON_SHA,
        content: btoa(JSON.stringify(SUBJECT_EEG_JSON)),
        encoding: "base64",
      }),
  });
  setGithubApiOverride(fake.url);
});

afterAll(() => {
  fake.stop();
  setGithubApiOverride(undefined);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    // Synchronous PAT fallback -- no GitHub App token mint, no network call
    // for auth itself.
    GITHUB_ADMIN_PAT: "fake-pat-for-tests",
    // Deliberately absent/bogus: S3 and Vectorize are internally guarded
    // (see module doc) so refreshDatasetMetadata must complete without
    // them.
    S3_BUCKET: "test-bucket",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
  } as Bindings;
}

beforeEach(() => {
  fake.reset();
  db = freshDb();
  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, github_username, status)
     VALUES (1, 'reindexowner', 'reindexowner@example.org', 'x', 'reindexowner', 'approved')`,
  ).run();
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
     VALUES (?, ?, 1, 'active', 'public', ?)`,
  ).run(REPO, REPO, `nemarDatasets/${REPO}`);
});

describe("refreshDatasetMetadata: signal_defaults override threading (#1162 review, I7)", () => {
  test("all four getBidsTreeStats override values reach the datasets row, unswapped", async () => {
    const result = await refreshDatasetMetadata(env(), REPO);

    expect(result.metadata_columns_written).toBe(true);
    expect(result.metadata_columns_error).toBeUndefined();

    const row = db
      .query(
        "SELECT sampling_frequency, power_line_frequency, eeg_reference, placement_scheme FROM datasets WHERE dataset_id = ?",
      )
      .get(REPO) as {
      sampling_frequency: number;
      power_line_frequency: number;
      eeg_reference: string;
      placement_scheme: string;
    };

    expect(row.sampling_frequency).toBe(SUBJECT_EEG_JSON.SamplingFrequency);
    expect(row.power_line_frequency).toBe(SUBJECT_EEG_JSON.PowerLineFrequency);
    expect(row.eeg_reference).toBe(SUBJECT_EEG_JSON.EEGReference);
    expect(row.placement_scheme).toBe(SUBJECT_EEG_JSON.EEGPlacementScheme);
  });

  test("signal_defaults_at is NOT stamped by reindex -- that stamp is owned only by the sweep", async () => {
    await refreshDatasetMetadata(env(), REPO);
    const row = db
      .query("SELECT signal_defaults_at FROM datasets WHERE dataset_id = ?")
      .get(REPO) as { signal_defaults_at: string | null };
    expect(row.signal_defaults_at).toBeNull();
  });
});
