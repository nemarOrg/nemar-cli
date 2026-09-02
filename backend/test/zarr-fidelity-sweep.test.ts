/**
 * Real behavioral tests for `runZarrFidelitySweep` (issue #1068, epic #1181
 * phase 8) -- the entry point BOTH real callers
 * (`POST /admin/datasets/zarr-fidelity-sweep` and the daily cron) use.
 *
 * Drives the REAL function against a real D1 (bun:sqlite behind realD1),
 * substituting the two true network boundaries -- the S3 index GET and the
 * raw.githubusercontent.com sidecar GET -- with ONE real local `Bun.serve()`
 * receiver, via the `s3Options.endpointUrl` / `githubRawBase` DI seams
 * (`zarr-catalog.ts`'s `endpointUrl` idiom). Everything else -- the
 * candidate query, sample selection, nearest-first resolution, the mismatch
 * rules, the stamp write, the audit row -- runs for real.
 *
 * Per `.rules/testing.md`: never hand-copy a SQL statement -- the assertions
 * below read the stamped `sweep_stamps` JSON back with `json_extract`
 * against the REAL column the sweep wrote, not a re-implemented predicate.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  type ZarrFidelityGroupJson,
  bidsSidecarCandidates,
  pushZarrFidelityExample,
  runZarrFidelitySweep,
  zarrFidelitySelectSample,
  zarrFidelityStoreChannelTotal,
  zarrFidelityStoreDuration,
} from "../src/services/zarr-fidelity-sweep";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ORG_NAME = "nemarDatasets";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("bidsSidecarCandidates: nearest-first, bounded, deduplicated", () => {
  test("recording directory, subject directory, dataset root -- in that order", () => {
    const candidates = bidsSidecarCandidates(
      "sub-01/ses-01/eeg/sub-01_ses-01_task-rest_run-01_eeg.set",
      "channels.tsv",
    );
    expect(candidates).toEqual([
      "sub-01/ses-01/eeg/sub-01_ses-01_task-rest_run-01_channels.tsv",
      "sub-01/sub-01_ses-01_channels.tsv",
      "channels.tsv",
    ]);
  });

  test("no subject entity and no dashed entity tokens: recording dir collapses to a bare name", () => {
    // "file" has no "-", so it is not treated as a BIDS entity -- the
    // recording-directory candidate is the bare suffix in that directory,
    // and there is no subject-directory candidate at all (no "sub-*" path
    // segment), leaving just the recording dir and the dataset root.
    const candidates = bidsSidecarCandidates("weird/path/file_eeg.set", "channels.tsv");
    expect(candidates).toEqual(["weird/path/channels.tsv", "channels.tsv"]);
  });

  test("a root-level recording (no directory) still yields the bare root candidate", () => {
    const candidates = bidsSidecarCandidates("sub-01_task-rest_eeg.set", "channels.tsv");
    expect(candidates).toContain("channels.tsv");
    expect(candidates[candidates.length - 1]).toBe("channels.tsv");
  });

  test("works identically for a modality sidecar suffix", () => {
    const candidates = bidsSidecarCandidates("sub-02/eeg/sub-02_task-x_eeg.set", "eeg.json");
    expect(candidates).toEqual([
      "sub-02/eeg/sub-02_task-x_eeg.json",
      "sub-02/sub-02_eeg.json",
      "eeg.json",
    ]);
  });
});

describe("zarrFidelityStoreChannelTotal: sum across groups", () => {
  test("sums n_channels across groups, treating missing/invalid as 0", () => {
    const groups: ZarrFidelityGroupJson[] = [
      { n_channels: 10 },
      { n_channels: 9 },
      { n_channels: undefined },
      { n_channels: "not a number" },
    ];
    expect(zarrFidelityStoreChannelTotal(groups)).toBe(19);
  });

  test("zero groups -> zero total", () => {
    expect(zarrFidelityStoreChannelTotal([])).toBe(0);
  });
});

describe("zarrFidelityStoreDuration: max across groups", () => {
  test("takes the max duration_s, never the sum", () => {
    const groups: ZarrFidelityGroupJson[] = [{ duration_s: 60 }, { duration_s: 120 }];
    expect(zarrFidelityStoreDuration(groups)).toBe(120);
  });

  test("null when no group measured a duration", () => {
    expect(zarrFidelityStoreDuration([{ duration_s: undefined }])).toBeNull();
  });
});

describe("zarrFidelitySelectSample: decision 1's sampling rule", () => {
  function store(path: string, nChannels?: number) {
    return {
      path,
      zarr: `${path}.zarr`,
      groups: nChannels != null ? [{ n_channels: nChannels }] : [],
    };
  }

  test("40 or fewer stores: every store is sampled", () => {
    const stores = Array.from({ length: 40 }, (_, i) => store(`s${String(i).padStart(3, "0")}`));
    const sample = zarrFidelitySelectSample(stores);
    expect(sample.length).toBe(40);
  });

  test("more than 40: spread evenly to 40, PLUS every n_channels===1 store outside the spread", () => {
    // 100 stores; only store #50 has n_channels === 1, positioned to be
    // unlikely to land in an even 40-of-100 spread by construction.
    const stores = Array.from({ length: 100 }, (_, i) =>
      store(`s${String(i).padStart(3, "0")}`, i === 50 ? 1 : 8),
    );
    const sample = zarrFidelitySelectSample(stores);
    expect(sample.length).toBeGreaterThanOrEqual(40);
    expect(sample.some((s) => s.path === "s050")).toBe(true);
  });

  test("a store with no string path is excluded", () => {
    const stores = [store("s000"), { path: undefined, groups: [] }];
    const sample = zarrFidelitySelectSample(stores);
    expect(sample.map((s) => s.path)).toEqual(["s000"]);
  });
});

describe("pushZarrFidelityExample: bounded to 20 entries / 4 KB", () => {
  test("stops appending past 20 entries", () => {
    const examples: { path: string; code: "channel_count_mismatch" }[] = [];
    for (let i = 0; i < 30; i++) {
      pushZarrFidelityExample(examples, { path: `p${i}`, code: "channel_count_mismatch" });
    }
    expect(examples.length).toBe(20);
    expect(examples[0].path).toBe("p0");
    expect(examples[19].path).toBe("p19");
  });

  test("stops appending once the serialized array would exceed 4 KB, even under 20 entries", () => {
    const examples: { path: string; code: "channel_count_mismatch" }[] = [];
    const longPath = "x".repeat(500);
    for (let i = 0; i < 20; i++) {
      pushZarrFidelityExample(examples, {
        path: `${longPath}${i}`,
        code: "channel_count_mismatch",
      });
    }
    expect(examples.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(examples)).length).toBeLessThanOrEqual(4096);
  });
});

// ---------------------------------------------------------------------------
// Real-engine fixture server: one local Bun.serve() answering both the
// signed S3 index GET (path `/<datasetId>/zarr/index.json`) and the public
// raw.githubusercontent.com sidecar GET (path
// `/<org>/<repo>/<commit>/<sidecar path>`).
// ---------------------------------------------------------------------------

let server: Server;
const indexFixtures = new Map<string, unknown>();
const sidecarFixtures = new Map<string, string>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname
        .split("/")
        .filter((p) => p.length > 0)
        .map((p) => decodeURIComponent(p));

      if (
        parts.length >= 3 &&
        parts[parts.length - 2] === "zarr" &&
        parts[parts.length - 1] === "index.json"
      ) {
        const datasetId = parts[0];
        const body = indexFixtures.get(datasetId);
        if (body === undefined) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(body), { status: 200 });
      }

      if (parts[0] === ORG_NAME) {
        const [, repo, commit, ...rest] = parts;
        const key = `${repo}/${commit}/${rest.join("/")}`;
        const content = sidecarFixtures.get(key);
        if (content === undefined) return new Response("not found", { status: 404 });
        return new Response(content, { status: 200 });
      }

      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

let db: Database;

function env(): Bindings {
  return {
    DB: realD1(db),
    S3_BUCKET: "test-bucket",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    ENVIRONMENT: "test",
  } as Bindings;
}

function runOpts() {
  return {
    s3Options: { endpointUrl: `http://127.0.0.1:${server.port}` },
    githubRawBase: `http://127.0.0.1:${server.port}`,
  };
}

/** Minimal, valid `datasets` row -- zarr-ready, converted, with a repo. */
function seedDataset(
  id: string,
  repo: string,
  overrides: Record<string, string | number | null> = {},
): void {
  const merged: Record<string, string | number | null> = {
    owner_user_id: -1,
    name: id,
    visibility: "public",
    status: "active",
    is_sandbox: 0,
    zarr_status: "ready",
    zarr_store_count: 1,
    zarr_source_commit: COMMIT_A,
    github_repo: `${ORG_NAME}/${repo}`,
    ...overrides,
  };
  const keys = Object.keys(merged);
  db.query(
    `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
  ).run(id, ...(keys.map((k) => merged[k]) as never[]));
}

function row(id: string): Record<string, unknown> {
  return db
    .query(
      `SELECT *,
              json_extract(sweep_stamps, '$.zarr_verify_status') AS zarr_verify_status,
              json_extract(sweep_stamps, '$.zarr_verified_at') AS zarr_verified_at,
              json_extract(sweep_stamps, '$.zarr_verified_commit') AS zarr_verified_commit,
              json_extract(sweep_stamps, '$.zarr_verify_examples') AS zarr_verify_examples_raw,
              json_extract(sweep_stamps, '$.zarr_verify_sampled') AS zarr_verify_sampled,
              json_extract(sweep_stamps, '$.zarr_verify_checked') AS zarr_verify_checked
       FROM datasets WHERE dataset_id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

function channelsTsv(n: number): string {
  const lines = ["name\ttype"];
  for (let i = 0; i < n; i++) lines.push(`Ch${i}\tEEG`);
  return lines.join("\n");
}

function eegJson(samplingFrequency: number, recordingDuration: number): string {
  return JSON.stringify({
    SamplingFrequency: samplingFrequency,
    RecordingDuration: recordingDuration,
  });
}

beforeEach(() => {
  db = freshDb();
  indexFixtures.clear();
  sidecarFixtures.clear();
});

describe("runZarrFidelitySweep: per-dataset verdicts", () => {
  test("VERIFIED: channel count, duration, and rate all agree with ground truth", () => {
    const id = "on800001";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "sub-01_task-rest_eeg.zarr",
          groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 250 }],
        },
      ],
    });
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(250, 120),
    );

    return runZarrFidelitySweep(env(), runOpts()).then((result) => {
      expect(result.errors).toEqual([]);
      expect(result.verified).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.unverifiable).toBe(0);
      expect(result.results).toEqual([
        { dataset_id: id, verdict: "verified", sampled: 1, checked: 1, examples: [] },
      ]);

      const r = row(id);
      expect(r.zarr_verify_status).toBe("verified");
      expect(r.zarr_verified_commit).toBe(COMMIT_A);
      expect(r.zarr_verify_sampled).toBe(1);
      expect(r.zarr_verify_checked).toBe(1);
      expect(JSON.parse(r.zarr_verify_examples_raw as string)).toEqual([]);
      expect(r.zarr_verified_at).not.toBeNull();
      // Untouched columns: only sweep_stamps changed.
      expect(r.name).toBe(id);
      expect(r.zarr_store_count).toBe(1);
    });
  });

  test("FAILED (channel_count_mismatch): store total channels fall short of channels.tsv", async () => {
    const id = "on800002";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          groups: [{ modality: "eeg", n_channels: 10, duration_s: 120, rate: 250 }],
        },
      ],
    });
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(250, 120),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.failed).toBe(1);
    expect(result.results[0].examples).toEqual([
      { path: "sub-01/eeg/sub-01_task-rest_eeg.set", code: "channel_count_mismatch" },
    ]);

    const r = row(id);
    expect(r.zarr_verify_status).toBe("failed");
    expect(JSON.parse(r.zarr_verify_examples_raw as string)).toEqual([
      { path: "sub-01/eeg/sub-01_task-rest_eeg.set", code: "channel_count_mismatch" },
    ]);

    // An audit_log row was written for the failure (decision 3).
    const audit = db
      .query(
        "SELECT action, resource_id, details FROM audit_log WHERE action = 'zarr_fidelity_failed'",
      )
      .get() as { action: string; resource_id: string; details: string } | null;
    expect(audit).not.toBeNull();
    expect(audit?.resource_id).toBe(id);
    expect(JSON.parse(audit?.details ?? "{}").examples).toEqual([
      { path: "sub-01/eeg/sub-01_task-rest_eeg.set", code: "channel_count_mismatch" },
    ]);
  });

  test("FAILED (duration_mismatch): store duration disagrees with RecordingDuration by more than 1s", async () => {
    const id = "on800003";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          groups: [{ modality: "eeg", n_channels: 19, duration_s: 100, rate: 250 }],
        },
      ],
    });
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    // RecordingDuration 120 vs the store's duration_s 100 -- a 20s gap.
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(250, 120),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.failed).toBe(1);
    expect(result.results[0].examples).toEqual([
      { path: "sub-01/eeg/sub-01_task-rest_eeg.set", code: "duration_mismatch" },
    ]);
  });

  test("FAILED (rate_mismatch): the served rate disagrees with SamplingFrequency after the modality cap", async () => {
    const id = "on800004";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          // SamplingFrequency 500 capped at EEG's 250 -> expected rate 250,
          // but the store serves 500 (as if the cap were never applied).
          groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 500 }],
        },
      ],
    });
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(500, 120),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.failed).toBe(1);
    expect(result.results[0].examples).toEqual([
      { path: "sub-01/eeg/sub-01_task-rest_eeg.set", code: "rate_mismatch" },
    ]);
  });

  test("UNVERIFIABLE: no sidecar is reachable at any candidate path", async () => {
    const id = "on800005";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 250 }],
        },
      ],
    });
    // No sidecarFixtures registered at all -- every candidate 404s.

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.unverifiable).toBe(1);
    expect(result.results[0]).toEqual({
      dataset_id: id,
      verdict: "unverifiable",
      sampled: 1,
      checked: 0,
      examples: [],
    });
    const r = row(id);
    expect(r.zarr_verify_status).toBe("unverifiable");
    expect(r.zarr_verify_checked).toBe(0);
  });

  test("v1/v3 index tolerance: unrelated v3-only top-level and store fields do not break parsing", async () => {
    const id = "on800006";
    seedDataset(id, id);
    indexFixtures.set(id, {
      format: "nemar-zarr-index",
      format_version: 3,
      source_commit: COMMIT_A,
      contract_base: "https://zarr.nemar.org/on800006/zarr/",
      data_base: "https://bucket.s3.region.amazonaws.com/on800006/zarr/",
      discovered_count: 1,
      store_count: 1,
      failure_count: 0,
      pending_count: 0,
      failures: [],
      pending: [],
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          source_tree: "raw",
          derived: false,
          n_events: 4,
          groups: [
            {
              modality: "eeg",
              n_channels: 19,
              duration_s: 120,
              rate: 250,
              n_view_levels: 3,
              chunk_samples: 1000,
            },
          ],
        },
      ],
    });
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(250, 120),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.verified).toBe(1);
  });

  test("bounded examples: 25 mismatching stores cap zarr_verify_examples at 20 entries", async () => {
    const id = "on800007";
    seedDataset(id, id, { zarr_store_count: 25 });
    const stores = Array.from({ length: 25 }, (_, i) => {
      const p = `sub-${String(i).padStart(2, "0")}`;
      return {
        path: `${p}/eeg/${p}_task-x_eeg.set`,
        zarr: `${p}.zarr`,
        groups: [{ modality: "eeg", n_channels: 1, duration_s: 10, rate: 250 }],
      };
    });
    indexFixtures.set(id, { source_commit: COMMIT_A, store_count: 25, stores });
    for (let i = 0; i < 25; i++) {
      const p = `sub-${String(i).padStart(2, "0")}`;
      // 5 channels declared, store only serves 1 -- every store mismatches.
      sidecarFixtures.set(`${id}/${COMMIT_A}/${p}/eeg/${p}_task-x_channels.tsv`, channelsTsv(5));
      sidecarFixtures.set(`${id}/${COMMIT_A}/${p}/eeg/${p}_task-x_eeg.json`, eegJson(250, 10));
    }

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.failed).toBe(1);
    expect(result.results[0].sampled).toBe(25);
    expect(result.results[0].checked).toBe(25);
    expect(result.results[0].examples.length).toBe(20);

    const r = row(id);
    const examples = JSON.parse(r.zarr_verify_examples_raw as string) as unknown[];
    expect(examples.length).toBe(20);
  });

  test("a re-conversion (zarr_source_commit changes) re-arms verification", async () => {
    const id = "on800008";
    seedDataset(id, id);
    const buildIndex = (commit: string) => ({
      source_commit: commit,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 250 }],
        },
      ],
    });
    indexFixtures.set(id, buildIndex(COMMIT_A));
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(250, 120),
    );

    const first = await runZarrFidelitySweep(env(), runOpts());
    expect(first.processed).toBe(1);
    expect(row(id).zarr_verified_commit).toBe(COMMIT_A);

    // Not re-selected while the store's commit is unchanged.
    const second = await runZarrFidelitySweep(env(), runOpts());
    expect(second.processed).toBe(0);

    // Simulate a re-conversion: the dataset's zarr_source_commit advances,
    // and the published index now reflects the new commit.
    db.query("UPDATE datasets SET zarr_source_commit = ? WHERE dataset_id = ?").run(COMMIT_B, id);
    indexFixtures.set(id, buildIndex(COMMIT_B));
    sidecarFixtures.set(
      `${id}/${COMMIT_B}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_B}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(250, 120),
    );

    const third = await runZarrFidelitySweep(env(), runOpts());
    expect(third.processed).toBe(1);
    expect(third.verified).toBe(1);
    expect(row(id).zarr_verified_commit).toBe(COMMIT_B);
  });

  test("index.json absent (zarr_status='ready' but nothing at the S3 key) is an error, not a stamp", async () => {
    const id = "on800009";
    seedDataset(id, id);
    // No indexFixtures entry -- the fixture server 404s.

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.errors).toEqual([
      { dataset_id: id, error: "zarr_status=ready but index.json is absent" },
    ]);
    const r = row(id);
    expect(r.zarr_verify_status).toBeNull();
  });

  test("an index with no fetchable source_commit is unverifiable, not a crash", async () => {
    const id = "on800010";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: "", // pre-phase-7 empty-string bug
      store_count: 1,
      stores: [{ path: "sub-01/eeg/sub-01_task-rest_eeg.set", zarr: "z", groups: [] }],
    });

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.unverifiable).toBe(1);
    expect(row(id).zarr_verify_status).toBe("unverifiable");
  });

  test("candidates are clamped to ZARR_FIDELITY_SWEEP_MAX and remaining reflects real state", async () => {
    for (let i = 0; i < 3; i++) {
      const id = `on80101${i}`;
      seedDataset(id, id);
      indexFixtures.set(id, {
        source_commit: COMMIT_A,
        store_count: 1,
        stores: [
          {
            path: "sub-01/eeg/sub-01_task-rest_eeg.set",
            zarr: "z",
            groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 250 }],
          },
        ],
      });
      sidecarFixtures.set(
        `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
        channelsTsv(19),
      );
      sidecarFixtures.set(
        `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
        eegJson(250, 120),
      );
    }
    const result = await runZarrFidelitySweep(env(), { ...runOpts(), limit: 1 });
    expect(result.processed).toBe(1);
    expect(result.remaining).toBe(2);
  });
});
