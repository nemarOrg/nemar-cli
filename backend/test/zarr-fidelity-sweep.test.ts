/**
 * Real behavioral tests for `runZarrFidelitySweep` (issue #1068, epic #1181
 * phase 8) -- the entry point BOTH real callers
 * (`POST /admin/datasets/zarr-fidelity-sweep` and the daily cron) use.
 *
 * Rewritten for PR #1203 review: tri-state sidecar fetch (item 1), checked
 * only after a real parse (item 2), the two fetch budgets (item 3),
 * store_metadata_invalid (item 4), the commit-fossilisation fix (item 5),
 * mismatch_count/examples_truncated (item 7), modality normalization +
 * once-per-dataset unknown-modality logging (item 8), and the corrected
 * session-dir candidate order (item 9).
 *
 * Drives the REAL function against a real D1 (bun:sqlite behind realD1),
 * substituting the two true network boundaries -- the S3 index GET and the
 * raw.githubusercontent.com sidecar GET -- with ONE real local `Bun.serve()`
 * receiver, via the `s3Options.endpointUrl` / `githubRawBase` DI seams.
 * Everything else -- the candidate query, sample selection, nearest-first
 * resolution, the mismatch rules, the stamp write, the audit row -- runs
 * for real.
 *
 * Per `.rules/testing.md`: never hand-copy a SQL statement -- the assertions
 * below read the stamped `sweep_stamps` JSON back with `json_extract`
 * against the REAL column the sweep wrote, not a re-implemented predicate.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { parseRecordingDuration } from "../src/services/channel-montage";
import { buildDatasetFilterClauses } from "../src/services/dataset-filters";
import {
  ZARR_CATALOG_CANDIDATE_SQL,
  type ZarrCatalogSourceRow,
  buildZarrCatalog,
} from "../src/services/zarr-catalog";
import {
  ZARR_FIDELITY_SWEEP_CANDIDATE_SQL,
  type ZarrFidelityGroupJson,
  bidsSidecarCandidates,
  createZarrFidelityMismatchAccumulator,
  recordZarrFidelityMismatch,
  runZarrFidelitySweep,
  zarrFidelitySelectSample,
  zarrFidelityStoreChannelTotal,
  zarrFidelityStoreDuration,
  zarrFidelityStoreMetadataValid,
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
  test("session-based recording: recording dir -> session dir -> subject dir (no session) -> root (item 9)", () => {
    const candidates = bidsSidecarCandidates(
      "sub-01/ses-01/eeg/sub-01_ses-01_task-rest_run-01_eeg.set",
      "channels.tsv",
    );
    expect(candidates).toEqual([
      "sub-01/ses-01/eeg/sub-01_ses-01_task-rest_run-01_channels.tsv",
      "sub-01/ses-01/sub-01_ses-01_channels.tsv",
      "sub-01/sub-01_channels.tsv",
      "channels.tsv",
    ]);
  });

  test("no session entity: recording dir -> subject dir -> root (no session-dir candidate)", () => {
    const candidates = bidsSidecarCandidates("sub-02/eeg/sub-02_task-x_eeg.set", "eeg.json");
    expect(candidates).toEqual([
      "sub-02/eeg/sub-02_task-x_eeg.json",
      "sub-02/sub-02_eeg.json",
      "eeg.json",
    ]);
  });

  test("no subject entity at all: recording dir -> root only", () => {
    const candidates = bidsSidecarCandidates("weird/path/file_eeg.set", "channels.tsv");
    expect(candidates).toEqual(["weird/path/channels.tsv", "channels.tsv"]);
  });

  test("a root-level recording (no directory) still yields the bare root candidate", () => {
    const candidates = bidsSidecarCandidates("sub-01_task-rest_eeg.set", "channels.tsv");
    expect(candidates[candidates.length - 1]).toBe("channels.tsv");
  });
});

describe("zarrFidelityStoreMetadataValid: item 4", () => {
  test("every group with a numeric n_channels is valid", () => {
    expect(zarrFidelityStoreMetadataValid([{ n_channels: 10 }, { n_channels: 9 }])).toBe(true);
  });

  test("a group missing n_channels is invalid", () => {
    expect(zarrFidelityStoreMetadataValid([{ n_channels: 10 }, { n_channels: undefined }])).toBe(
      false,
    );
  });

  test("a group with a non-numeric n_channels is invalid", () => {
    expect(zarrFidelityStoreMetadataValid([{ n_channels: "ten" }])).toBe(false);
  });

  test("zero groups is vacuously valid (a real, checkable total of 0)", () => {
    expect(zarrFidelityStoreMetadataValid([])).toBe(true);
  });
});

describe("zarrFidelityStoreChannelTotal: sum across groups", () => {
  test("sums n_channels across groups", () => {
    const groups: ZarrFidelityGroupJson[] = [{ n_channels: 10 }, { n_channels: 9 }];
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

  test("exactly 41 stores: 40 spread plus every n_channels===1 store, no duplicates (item 13)", () => {
    // 41 stores; only store #40 (the last) has n_channels === 1. sampleEvenly
    // over 41 items capped to 40 always includes the first AND last item (its
    // own documented contract), so this fixture alone can't distinguish "the
    // spread happened to include it" from "the forced-inclusion rule did" --
    // the second test below (#20, off-spread) is the one that actually
    // exercises the forced-inclusion path.
    const stores = Array.from({ length: 41 }, (_, i) =>
      store(`s${String(i).padStart(3, "0")}`, i === 40 ? 1 : 8),
    );
    const sample = zarrFidelitySelectSample(stores);
    expect(sample.length).toBe(40);
    const ids = sample.map((s) => s.path);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toContain("s040");
  });

  test("a n_channels===1 store OUTSIDE the even spread is still force-included", () => {
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

describe("createZarrFidelityMismatchAccumulator / recordZarrFidelityMismatch (item 7)", () => {
  test("stops appending past 20 entries but keeps counting", () => {
    const acc = createZarrFidelityMismatchAccumulator();
    for (let i = 0; i < 30; i++) {
      recordZarrFidelityMismatch(acc, { path: `p${i}`, code: "channel_count_mismatch" });
    }
    expect(acc.examples.length).toBe(20);
    expect(acc.examples[0].path).toBe("p0");
    expect(acc.examples[19].path).toBe("p19");
    expect(acc.count).toBe(30);
    expect(acc.truncated).toBe(true);
  });

  test("stops appending once the serialized array would exceed 4 KB, even under 20 entries -- count and truncated stay accurate (item 16)", () => {
    const acc = createZarrFidelityMismatchAccumulator();
    const longPath = "x".repeat(500);
    for (let i = 0; i < 20; i++) {
      recordZarrFidelityMismatch(acc, { path: `${longPath}${i}`, code: "channel_count_mismatch" });
    }
    expect(acc.examples.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(acc.examples)).length).toBeLessThanOrEqual(4096);
    expect(acc.count).toBe(20);
    expect(acc.truncated).toBe(true);
  });

  test("under both caps: nothing truncated, count matches examples length", () => {
    const acc = createZarrFidelityMismatchAccumulator();
    recordZarrFidelityMismatch(acc, { path: "a", code: "duration_mismatch" });
    recordZarrFidelityMismatch(acc, { path: "b", code: "rate_mismatch" });
    expect(acc.examples.length).toBe(2);
    expect(acc.count).toBe(2);
    expect(acc.truncated).toBe(false);
  });
});

describe("parseRecordingDuration (item 15)", () => {
  test("missing RecordingDuration -> null", () => {
    expect(parseRecordingDuration(JSON.stringify({ SamplingFrequency: 250 }))).toBeNull();
  });

  test("non-numeric RecordingDuration -> null", () => {
    expect(parseRecordingDuration(JSON.stringify({ RecordingDuration: "120" }))).toBeNull();
  });

  test("zero RecordingDuration -> null", () => {
    expect(parseRecordingDuration(JSON.stringify({ RecordingDuration: 0 }))).toBeNull();
  });

  test("negative RecordingDuration -> null", () => {
    expect(parseRecordingDuration(JSON.stringify({ RecordingDuration: -5 }))).toBeNull();
  });

  test("malformed JSON -> null, does not throw", () => {
    expect(parseRecordingDuration("{not valid json")).toBeNull();
  });

  test("a valid positive RecordingDuration parses", () => {
    expect(parseRecordingDuration(JSON.stringify({ RecordingDuration: 120.5 }))).toBe(120.5);
  });
});

// ---------------------------------------------------------------------------
// Real-engine fixture server: one local Bun.serve() answering both the
// signed S3 index GET (path `/<datasetId>/zarr/index.json`) and the public
// raw.githubusercontent.com sidecar GET (path
// `/<org>/<repo>/<commit>/<sidecar path>`). Both support an explicit status
// override (for transient-infra-error tests, item 11) that wins over any
// registered fixture content.
// ---------------------------------------------------------------------------

let server: Server;
const indexFixtures = new Map<string, unknown>();
const indexStatusOverrides = new Map<string, number>();
const sidecarFixtures = new Map<string, string>();
const sidecarStatusOverrides = new Map<string, number>();

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
        const statusOverride = indexStatusOverrides.get(datasetId);
        if (statusOverride !== undefined) return new Response("error", { status: statusOverride });
        const body = indexFixtures.get(datasetId);
        if (body === undefined) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(body), { status: 200 });
      }

      if (parts[0] === ORG_NAME) {
        const [, repo, commit, ...rest] = parts;
        const key = `${repo}/${commit}/${rest.join("/")}`;
        const statusOverride = sidecarStatusOverrides.get(key);
        if (statusOverride !== undefined) return new Response("error", { status: statusOverride });
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

/** Minimal, valid `datasets` row -- zarr-ready, converted, public, active,
 *  with a repo. */
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
    github_repo: repo.includes("/") ? repo : `${ORG_NAME}/${repo}`,
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
              json_extract(sweep_stamps, '$.zarr_verify_checked') AS zarr_verify_checked,
              json_extract(sweep_stamps, '$.zarr_verify_checked_channels') AS zarr_verify_checked_channels,
              json_extract(sweep_stamps, '$.zarr_verify_checked_duration') AS zarr_verify_checked_duration,
              json_extract(sweep_stamps, '$.zarr_verify_checked_rate') AS zarr_verify_checked_rate,
              json_extract(sweep_stamps, '$.zarr_verify_unchecked') AS zarr_verify_unchecked,
              json_extract(sweep_stamps, '$.zarr_verify_mismatch_count') AS zarr_verify_mismatch_count,
              json_extract(sweep_stamps, '$.zarr_verify_examples_truncated') AS zarr_verify_examples_truncated
       FROM datasets WHERE dataset_id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

/** The attempt stamp, read back off the REAL column the sweep wrote. */
function attemptedAt(id: string): string | null {
  const r = db
    .query(
      "SELECT json_extract(sweep_stamps, '$.zarr_verify_attempted_at') AS a FROM datasets WHERE dataset_id = ?",
    )
    .get(id) as { a: string | null } | null;
  return r?.a ?? null;
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

let warnSpy: typeof console.warn;
let warnCalls: unknown[][];

beforeEach(() => {
  db = freshDb();
  indexFixtures.clear();
  indexStatusOverrides.clear();
  sidecarFixtures.clear();
  sidecarStatusOverrides.clear();
  warnCalls = [];
  warnSpy = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
});

afterEach(() => {
  console.warn = warnSpy;
});

describe("runZarrFidelitySweep: per-dataset verdicts", () => {
  test("VERIFIED: channel count, duration, and rate all agree with ground truth", async () => {
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

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(1);
    expect(result.budget_exhausted).toBe(false);
    expect(result.results).toEqual([
      {
        dataset_id: id,
        verdict: "verified",
        sampled: 1,
        checked: 1,
        checked_channels: 1,
        checked_duration: 1,
        checked_rate: 1,
        unchecked: 0,
        examples: [],
        mismatch_count: 0,
        examples_truncated: false,
      },
    ]);

    const r = row(id);
    expect(r.zarr_verify_status).toBe("verified");
    expect(r.zarr_verified_commit).toBe(COMMIT_A);
    expect(r.zarr_verify_sampled).toBe(1);
    expect(r.zarr_verify_checked).toBe(1);
    expect(r.zarr_verify_checked_channels).toBe(1);
    expect(r.zarr_verify_checked_duration).toBe(1);
    expect(r.zarr_verify_checked_rate).toBe(1);
    expect(r.zarr_verify_unchecked).toBe(0);
    expect(r.zarr_verify_mismatch_count).toBe(0);
    expect(r.zarr_verify_examples_truncated).toBe(0);
    expect(JSON.parse(r.zarr_verify_examples_raw as string)).toEqual([]);
    expect(r.zarr_verified_at).not.toBeNull();
    // Untouched columns: only sweep_stamps changed.
    expect(r.name).toBe(id);
    expect(r.zarr_store_count).toBe(1);
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
    expect(result.results[0].mismatch_count).toBe(1);
    expect(result.results[0].examples_truncated).toBe(false);

    const r = row(id);
    expect(r.zarr_verify_status).toBe("failed");
    expect(JSON.parse(r.zarr_verify_examples_raw as string)).toEqual([
      { path: "sub-01/eeg/sub-01_task-rest_eeg.set", code: "channel_count_mismatch" },
    ]);

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

  test("UNVERIFIABLE: no sidecar is reachable at any candidate path (clean 404s)", async () => {
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
    // No sidecarFixtures registered at all -- every candidate 404s (absent,
    // not error).

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.errors).toEqual([]);
    expect(result.unverifiable).toBe(1);
    expect(result.results[0]).toEqual({
      dataset_id: id,
      verdict: "unverifiable",
      sampled: 1,
      checked: 0,
      checked_channels: 0,
      checked_duration: 0,
      checked_rate: 0,
      unchecked: 1,
      examples: [],
      mismatch_count: 0,
      examples_truncated: false,
    });
    const r = row(id);
    expect(r.zarr_verify_status).toBe("unverifiable");
    expect(r.zarr_verify_checked).toBe(0);
    expect(r.zarr_verify_unchecked).toBe(1);
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

  test("bounded examples: 25 mismatching stores cap examples at 20, but mismatch_count/examples_truncated are honest", async () => {
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
      sidecarFixtures.set(`${id}/${COMMIT_A}/${p}/eeg/${p}_task-x_channels.tsv`, channelsTsv(5));
      sidecarFixtures.set(`${id}/${COMMIT_A}/${p}/eeg/${p}_task-x_eeg.json`, eegJson(250, 10));
    }

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.failed).toBe(1);
    expect(result.results[0].sampled).toBe(25);
    expect(result.results[0].checked).toBe(25);
    expect(result.results[0].examples.length).toBe(20);
    expect(result.results[0].mismatch_count).toBe(25);
    expect(result.results[0].examples_truncated).toBe(true);

    const r = row(id);
    const examples = JSON.parse(r.zarr_verify_examples_raw as string) as unknown[];
    expect(examples.length).toBe(20);
    expect(r.zarr_verify_mismatch_count).toBe(25);
    expect(r.zarr_verify_examples_truncated).toBe(1);
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
    // Item 5: the commit is stamped as '' (never JSON null), so the next
    // sweep can re-arm this row once a real commit appears.
    expect(row(id).zarr_verified_commit).toBe("");
  });

  test("candidates are clamped to ZARR_FIDELITY_SWEEP_MAX (25) and remaining reflects real state", async () => {
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

  test("a requested limit above ZARR_FIDELITY_SWEEP_MAX (25) is clamped down to it", async () => {
    // 30 candidates, none with an index fixture -- every one is a real
    // (absent-index) error, so `processed` reflects exactly how many were
    // attempted, proving the SQL LIMIT bind itself was clamped to 25. None
    // of them get stamped (an error never stamps), so all 30 are still
    // candidates afterwards -- `remaining` here proves nothing about the
    // clamp and is intentionally not asserted.
    for (let i = 0; i < 30; i++) {
      seedDataset(`on802${String(i).padStart(3, "0")}`, `on802${String(i).padStart(3, "0")}`);
    }
    const result = await runZarrFidelitySweep(env(), { ...runOpts(), limit: 999_999 });
    expect(result.processed).toBe(25);
    expect(result.errors.length).toBe(25);
  });

  test("github_repo without an org prefix still resolves the repo correctly (item 17)", async () => {
    const id = "on800011";
    // github_repo stored WITHOUT the "nemarDatasets/" prefix.
    seedDataset(id, "on800011-bare-repo", { github_repo: "on800011-bare-repo" });
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
      `on800011-bare-repo/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `on800011-bare-repo/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(250, 120),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.verified).toBe(1);
  });
});

describe("runZarrFidelitySweep: re-conversion re-arming, including the fossilisation fix (item 5)", () => {
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

    const second = await runZarrFidelitySweep(env(), runOpts());
    expect(second.processed).toBe(0);

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

  test("bad commit stamped, then re-converted with a real commit, then swept again (fossilisation regression)", async () => {
    const id = "on800012";
    seedDataset(id, id, { zarr_source_commit: COMMIT_A });
    // Simulate a row ALREADY fossilised by the pre-fix code path: a stamp
    // whose zarr_verified_commit is JSON null (what the old
    // `outcome.commit` bind -- a raw `null` -- used to write), with
    // zarr_verified_at already set. Without this PR's predicate fix
    // (the added `IS NULL` branch), `json_extract(...) != zarr_source_commit`
    // is SQL NULL when the stored value is JSON null -- never true -- so
    // this row could never become a candidate again, even once a real
    // commit landed.
    db.query(
      `UPDATE datasets
       SET sweep_stamps = json_set(
         COALESCE(sweep_stamps, '{}'),
         '$.zarr_verified_at', datetime('now'),
         '$.zarr_verified_commit', json('null'),
         '$.zarr_verify_status', 'unverifiable'
       )
       WHERE dataset_id = ?`,
    ).run(id);
    expect(row(id).zarr_verified_commit).toBeNull();

    // A genuine re-conversion: the index now has a real, fetchable commit.
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

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.processed).toBe(1); // re-selected despite the null-commit fossil
    expect(result.verified).toBe(1);
    expect(row(id).zarr_verify_status).toBe("verified");
    expect(row(id).zarr_verified_commit).toBe(COMMIT_A);

    // And now it correctly stops being a candidate.
    const second = await runZarrFidelitySweep(env(), runOpts());
    expect(second.processed).toBe(0);
  });
});

describe("runZarrFidelitySweep: tri-state fetch aborts the dataset, never fakes absence (item 1, 11)", () => {
  test("a transient index 500 leaves the dataset in errors, unstamped, still a candidate", async () => {
    const id = "on800020";
    seedDataset(id, id);
    indexStatusOverrides.set(id, 500);

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.results).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].dataset_id).toBe(id);
    expect(row(id).zarr_verify_status).toBeNull();

    const second = await runZarrFidelitySweep(env(), runOpts());
    expect(second.processed).toBe(1); // still a candidate
  });

  test("a transient sidecar 503 aborts that dataset's verification (not stamped, in errors)", async () => {
    const id = "on800021";
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
    // Every channels.tsv candidate 503s.
    for (const p of [
      "sub-01/eeg/sub-01_task-rest_channels.tsv",
      "sub-01/sub-01_channels.tsv",
      "channels.tsv",
    ]) {
      sidecarStatusOverrides.set(`${id}/${COMMIT_A}/${p}`, 503);
    }

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.results).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].dataset_id).toBe(id);
    expect(row(id).zarr_verify_status).toBeNull();
  });

  test("a transient sidecar 429 aborts that dataset's verification the same way", async () => {
    const id = "on800022";
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
    for (const p of [
      "sub-01/eeg/sub-01_task-rest_channels.tsv",
      "sub-01/sub-01_channels.tsv",
      "channels.tsv",
    ]) {
      sidecarStatusOverrides.set(`${id}/${COMMIT_A}/${p}`, 429);
    }

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.results).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(row(id).zarr_verify_status).toBeNull();
  });
});

describe("runZarrFidelitySweep: the two fetch budgets (item 3)", () => {
  test("sweep-wide budget exhaustion stops the batch; untouched candidates are neither errored nor stamped", async () => {
    const ids = ["on800090", "on800091", "on800092"];
    for (const id of ids) {
      seedDataset(id, id);
      indexFixtures.set(id, {
        source_commit: COMMIT_A,
        store_count: 1,
        stores: [
          {
            path: "sub-01/eeg/sub-01_task-x_eeg.set",
            zarr: "z",
            groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 250 }],
          },
        ],
      });
      sidecarFixtures.set(
        `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-x_channels.tsv`,
        channelsTsv(19),
      );
      sidecarFixtures.set(`${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-x_eeg.json`, eegJson(250, 120));
    }

    // Budget of 1: the first dataset's index fetch spends it entirely, so
    // its first sidecar resolution immediately sees an exhausted budget --
    // that dataset aborts (errors, unstamped); the other two are never
    // even attempted.
    const result = await runZarrFidelitySweep(env(), { ...runOpts(), sweepWideBudget: 1 });
    expect(result.budget_exhausted).toBe(true);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toBe("sweep_budget_exhausted");
    expect(result.results).toEqual([]);
    expect(result.processed).toBe(1);
    // All three rows are still candidates: the errored one was never
    // stamped, and the other two were never touched at all.
    expect(result.remaining).toBe(3);
    for (const id of ids) {
      expect(row(id).zarr_verify_status).toBeNull();
    }
  });

  test("per-dataset sidecar budget exhaustion (90) aborts that one dataset without touching sweep-wide accounting for others", async () => {
    const id = "on800095";
    const stores = Array.from({ length: 30 }, (_, i) => {
      const p = `sub-${String(i).padStart(2, "0")}`;
      return {
        path: `${p}/eeg/${p}_task-x_eeg.set`,
        zarr: `${p}.zarr`,
        groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 250 }],
      };
    });
    seedDataset(id, id, { zarr_store_count: 30 });
    indexFixtures.set(id, { source_commit: COMMIT_A, store_count: 30, stores });
    // Nothing registered anywhere -- every candidate 404s (absent) until
    // the per-dataset budget (90) is spent partway through the sample,
    // at which point the NEXT resolution attempt reports budget_exhausted.

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.results).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].dataset_id).toBe(id);
    expect(result.errors[0].error).toBe("dataset_budget_exhausted");
    expect(row(id).zarr_verify_status).toBeNull();
    // A single dataset hitting its OWN 90-fetch cap is that dataset's
    // error alone -- the sweep-wide budget (600) still has plenty left, so
    // the top-level flag must NOT read as "the batch was cut short"
    // (PR #1203 review round 2).
    expect(result.budget_exhausted).toBe(false);
  });
});

describe("runZarrFidelitySweep: checked only after a real parse (item 2)", () => {
  test("a reachable but malformed JSON sidecar logs sidecar_unparseable and never counts as checked", async () => {
    const id = "on800030";
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
      "{not valid json",
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    // Channels checked fine; duration/rate never checked (malformed JSON).
    expect(result.results[0].verdict).toBe("verified"); // checked via channels alone, no mismatch
    expect(result.results[0].checked_channels).toBe(1);
    expect(result.results[0].checked_duration).toBe(0);
    expect(result.results[0].checked_rate).toBe(0);
    expect(warnCalls.some((c) => String(c[0]).includes("sidecar_unparseable"))).toBe(true);
    expect(warnCalls.some((c) => String(c[0]).includes("eeg.json"))).toBe(true);
  });

  test("channels.tsv with zero usable data rows is unverifiable for the channel check, never verified off it", async () => {
    const id = "on800031";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          groups: [{ modality: "eeg", n_channels: 19 }],
        },
      ],
    });
    // Header only, no data rows.
    sidecarFixtures.set(`${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`, "name\ttype");

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.unverifiable).toBe(1);
    expect(result.results[0].checked_channels).toBe(0);
    expect(warnCalls.some((c) => String(c[0]).includes("sidecar_unparseable"))).toBe(true);
  });

  test("per-check-kind checked counts: only channels checked when no modality sidecar exists at all", async () => {
    const id = "on800032";
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
    // No eeg.json anywhere -- absent, not an error.

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.verified).toBe(1);
    expect(result.results[0].checked_channels).toBe(1);
    expect(result.results[0].checked_duration).toBe(0);
    expect(result.results[0].checked_rate).toBe(0);
    expect(row(id).zarr_verify_checked_channels).toBe(1);
    expect(row(id).zarr_verify_checked_duration).toBe(0);
    expect(row(id).zarr_verify_checked_rate).toBe(0);
  });
});

describe("runZarrFidelitySweep: store_metadata_invalid never produces a false mismatch (item 4)", () => {
  test("a group with a missing n_channels makes the store unverifiable, never channel_count_mismatch", async () => {
    const id = "on800040";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          // n_channels missing entirely -- malformed, must not be treated as 0.
          groups: [{ modality: "eeg", duration_s: 120, rate: 250 }],
        },
      ],
    });
    // channels.tsv genuinely has rows, which WOULD trivially "mismatch"
    // against a naive total-of-0 -- the invalid-metadata guard must fire
    // before that comparison is ever made.
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(250, 120),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.unverifiable).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results[0].examples).toEqual([]);
    expect(result.results[0].checked).toBe(0);
    expect(warnCalls.some((c) => String(c[0]).includes("store_metadata_invalid"))).toBe(true);
  });
});

describe("runZarrFidelitySweep: modality normalization and once-per-dataset unknown-modality logging (item 8)", () => {
  test("a modality with surrounding whitespace and mixed case still matches its rate cap", async () => {
    const id = "on800050";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          groups: [{ modality: " Eeg ", n_channels: 19, duration_s: 120, rate: 250 }],
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
    expect(result.results[0].checked_rate).toBe(1);
  });

  test("an unknown modality logs once per dataset and skips only the rate check", async () => {
    const id = "on800051";
    seedDataset(id, id, { zarr_store_count: 2 });
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 2,
      stores: [
        {
          path: "sub-01/eyetrack/sub-01_task-x_eyetrack.set",
          zarr: "z1",
          groups: [{ modality: "eyetrack", n_channels: 4, duration_s: 60 }],
        },
        {
          path: "sub-02/eyetrack/sub-02_task-x_eyetrack.set",
          zarr: "z2",
          groups: [{ modality: "eyetrack", n_channels: 4, duration_s: 60 }],
        },
      ],
    });
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eyetrack/sub-01_task-x_channels.tsv`,
      channelsTsv(4),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eyetrack/sub-01_task-x_eyetrack.json`,
      eegJson(60, 60),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-02/eyetrack/sub-02_task-x_channels.tsv`,
      channelsTsv(4),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-02/eyetrack/sub-02_task-x_eyetrack.json`,
      eegJson(60, 60),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.verified).toBe(1);
    // Duration checked fine for both stores; rate is never checked (unknown cap).
    expect(result.results[0].checked_duration).toBe(2);
    expect(result.results[0].checked_rate).toBe(0);
    const unknownModalityWarnings = warnCalls.filter((c) =>
      String(c[0]).includes('unknown modality "eyetrack"'),
    );
    expect(unknownModalityWarnings.length).toBe(1); // once per dataset, not once per store
  });
});

describe("runZarrFidelitySweep: BIDS inheritance end-to-end (item 10)", () => {
  function baseIndex(path: string) {
    return {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path,
          zarr: "z",
          groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 250 }],
        },
      ],
    };
  }

  test("sidecar only at the dataset root -> verified", async () => {
    const id = "on800060";
    seedDataset(id, id);
    indexFixtures.set(id, baseIndex("sub-01/ses-01/eeg/sub-01_ses-01_task-rest_eeg.set"));
    sidecarFixtures.set(`${id}/${COMMIT_A}/channels.tsv`, channelsTsv(19));
    sidecarFixtures.set(`${id}/${COMMIT_A}/eeg.json`, eegJson(250, 120));

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.verified).toBe(1);
    expect(result.results[0].checked).toBe(1);
  });

  test("sidecar only at the session level -> verified", async () => {
    const id = "on800061";
    seedDataset(id, id);
    indexFixtures.set(id, baseIndex("sub-01/ses-01/eeg/sub-01_ses-01_task-rest_eeg.set"));
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/ses-01/sub-01_ses-01_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/ses-01/sub-01_ses-01_eeg.json`,
      eegJson(250, 120),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.verified).toBe(1);
  });

  test("sidecar only at the subject level (no session entity) -> verified", async () => {
    const id = "on800062";
    seedDataset(id, id);
    indexFixtures.set(id, baseIndex("sub-01/eeg/sub-01_task-rest_eeg.set")); // no session
    sidecarFixtures.set(`${id}/${COMMIT_A}/sub-01/sub-01_channels.tsv`, channelsTsv(19));
    sidecarFixtures.set(`${id}/${COMMIT_A}/sub-01/sub-01_eeg.json`, eegJson(250, 120));

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.verified).toBe(1);
  });
});

describe("runZarrFidelitySweep: partial reachability (item 12)", () => {
  test("2 of 3 sampled stores checked, 1 absent everywhere -> verdict from the 2 checked, unchecked=1", async () => {
    const id = "on800070";
    seedDataset(id, id, { zarr_store_count: 3 });
    const stores = ["a", "b", "c"].map((s) => ({
      path: `sub-${s}/eeg/sub-${s}_task-x_eeg.set`,
      zarr: `${s}.zarr`,
      groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 250 }],
    }));
    indexFixtures.set(id, { source_commit: COMMIT_A, store_count: 3, stores });
    for (const s of ["a", "b"]) {
      sidecarFixtures.set(
        `${id}/${COMMIT_A}/sub-${s}/eeg/sub-${s}_task-x_channels.tsv`,
        channelsTsv(19),
      );
      sidecarFixtures.set(
        `${id}/${COMMIT_A}/sub-${s}/eeg/sub-${s}_task-x_eeg.json`,
        eegJson(250, 120),
      );
    }
    // sub-c: nothing registered anywhere -- clean absence, not an error.

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.verified).toBe(1);
    expect(result.results[0].sampled).toBe(3);
    expect(result.results[0].checked).toBe(2);
    expect(result.results[0].unchecked).toBe(1);
    expect(row(id).zarr_verify_unchecked).toBe(1);
  });
});

describe("runZarrFidelitySweep: a store with two groups of different modalities (item 13)", () => {
  test("both modalities' sidecars are fetched separately; channel totals are summed", async () => {
    const id = "on800080";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/ieeg/sub-01_task-x_ieeg.set",
          zarr: "z",
          groups: [
            { modality: "eeg", n_channels: 10, duration_s: 120, rate: 250 },
            { modality: "ieeg", n_channels: 8, duration_s: 120, rate: 1000 },
          ],
        },
      ],
    });
    // 18 total channels (10 + 8) declared in channels.tsv.
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/ieeg/sub-01_task-x_channels.tsv`,
      channelsTsv(18),
    );
    sidecarFixtures.set(`${id}/${COMMIT_A}/sub-01/ieeg/sub-01_task-x_eeg.json`, eegJson(250, 120));
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/ieeg/sub-01_task-x_ieeg.json`,
      eegJson(1000, 120),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.verified).toBe(1);
    expect(result.results[0].checked_channels).toBe(1);
    expect(result.results[0].checked_duration).toBe(1);
    expect(result.results[0].checked_rate).toBe(1);
    expect(result.results[0].examples).toEqual([]);
  });

  test("a mismatch in EITHER modality's rate is still caught after two separate fetches", async () => {
    const id = "on800081";
    seedDataset(id, id);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/ieeg/sub-01_task-x_ieeg.set",
          zarr: "z",
          groups: [
            { modality: "eeg", n_channels: 10, duration_s: 120, rate: 250 },
            { modality: "ieeg", n_channels: 8, duration_s: 120, rate: 5000 }, // wrong: cap is 1000
          ],
        },
      ],
    });
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/ieeg/sub-01_task-x_channels.tsv`,
      channelsTsv(18),
    );
    sidecarFixtures.set(`${id}/${COMMIT_A}/sub-01/ieeg/sub-01_task-x_eeg.json`, eegJson(250, 120));
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/ieeg/sub-01_task-x_ieeg.json`,
      eegJson(1000, 120),
    );

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.failed).toBe(1);
    expect(result.results[0].examples).toEqual([
      { path: "sub-01/ieeg/sub-01_task-x_ieeg.set", code: "rate_mismatch" },
    ]);
  });
});

describe("an always-erroring dataset does not starve the rest of the catalog", () => {
  /**
   * The queue is "every converted dataset with no verdict for its current
   * commit", and only a VERDICT clears candidacy. A dataset that errors every
   * run therefore never leaves the queue -- correct, and by itself harmless.
   * What was not harmless is the ORDER: `ORDER BY dataset_id` re-selected the
   * same alphabetically-earliest candidates on every run, so a handful of
   * permanently unreachable datasets occupied the whole 25-row batch forever
   * and nothing behind them was ever swept. Each run still reported those as
   * errors and looked like it was working.
   *
   * `zarr_verify_attempted_at` is stamped on every attempt, verdict or not, and
   * the batch is ordered by it (never-attempted first, then oldest attempt), so
   * the failing dataset costs one slot per cycle instead of all of them.
   */
  const A = "on800100"; // alphabetically first, and permanently unreachable
  const B = "on800101"; // healthy, and behind it in the old ordering

  function seedPair(): void {
    seedDataset(A, A);
    seedDataset(B, B);
    indexStatusOverrides.set(A, 500); // every run, forever
    indexFixtures.set(B, {
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
      `${B}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(`${B}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`, eegJson(250, 120));
  }

  test("with a quota of one, run 1 takes the erroring dataset and run 2 takes the next", async () => {
    seedPair();

    const first = await runZarrFidelitySweep(env(), { ...runOpts(), limit: 1 });
    expect(first.errors.map((e) => e.dataset_id)).toEqual([A]);
    // Attempted, but with NO verdict: an unreachable dataset must never end up
    // claiming one.
    expect(attemptedAt(A)).not.toBeNull();
    expect(row(A).zarr_verify_status).toBeNull();
    expect(row(A).zarr_verified_at).toBeNull();
    expect(attemptedAt(B)).toBeNull();

    const second = await runZarrFidelitySweep(env(), { ...runOpts(), limit: 1 });
    // The whole point: B is reached on the very next run, rather than never.
    expect(second.results.map((r) => r.dataset_id)).toEqual([B]);
    expect(row(B).zarr_verify_status).toBe("verified");
    // And A is still a candidate -- the attempt stamp changes the ORDER, not
    // who is eligible.
    expect(row(A).zarr_verify_status).toBeNull();
  });

  test("the erroring dataset is retried once the rest of the batch has had a turn", async () => {
    seedPair();
    await runZarrFidelitySweep(env(), { ...runOpts(), limit: 1 }); // A errors
    await runZarrFidelitySweep(env(), { ...runOpts(), limit: 1 }); // B verified

    // B now has a verdict for its current commit, so it is no longer a
    // candidate at all and A comes back around: a permanently failing dataset
    // is retried forever, just never at the expense of everything behind it.
    const third = await runZarrFidelitySweep(env(), { ...runOpts(), limit: 1 });
    expect(third.errors.map((e) => e.dataset_id)).toEqual([A]);
  });

  test("a never-attempted dataset outranks one that was attempted", () => {
    // Ordering is by the stamp, not by id: B sorts AFTER A by dataset_id, so if
    // the never-attempted rule were missing, the REAL candidate query would
    // hand back A again. Driven through the exported SQL rather than a copy of
    // it (.rules/testing.md), so a change to the ordering has to change this.
    seedPair();
    db.query(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps,'{}'), '$.zarr_verify_attempted_at', '2026-01-01T00:00:00Z') WHERE dataset_id = ?",
    ).run(A);
    const rows = db.query(ZARR_FIDELITY_SWEEP_CANDIDATE_SQL).all(10) as { dataset_id: string }[];
    expect(rows.map((r) => r.dataset_id)).toEqual([B, A]);
  });
});

describe("the sweep's verdict reaches every reader of it", () => {
  /**
   * The seam nothing crossed. The verdict lives at ONE JSON path inside
   * `sweep_stamps`, written here and read -- until this pass, spelled out by
   * hand -- by three unrelated queries: the catalog projection, the zarr
   * catalog document, and the `has_zarr_verified` filter. `json_extract` on a
   * path that matches nothing returns NULL rather than erroring, so a typo in
   * any one of them reads as "never swept" forever, silently, and every
   * component's own tests still pass.
   *
   * This runs the REAL sweep against the real local upstream, then drives the
   * REAL SQL of both readers over the same row -- no hand-copied predicate on
   * either side (`.rules/testing.md`), which is what makes a divergence fail
   * here.
   */
  const VERIFIED = "on800200";
  const UNSWEPT = "on800201";

  test("a stamped verdict is visible to the zarr catalog and to has_zarr_verified", async () => {
    seedDataset(VERIFIED, VERIFIED);
    seedDataset(UNSWEPT, UNSWEPT);
    indexFixtures.set(VERIFIED, {
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
      `${VERIFIED}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      channelsTsv(19),
    );
    sidecarFixtures.set(
      `${VERIFIED}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      eegJson(250, 120),
    );
    // The other dataset has no index fixture, so it stays unverified -- the
    // negative half: a reader that matched everything would pass otherwise.
    indexStatusOverrides.set(UNSWEPT, 500);

    const result = await runZarrFidelitySweep(env(), runOpts());
    expect(result.results.map((r) => r.dataset_id)).toEqual([VERIFIED]);

    // Reader 1: the published zarr catalog document, through its own candidate
    // SQL and the real builder.
    const rows = db.query(ZARR_CATALOG_CANDIDATE_SQL).all() as ZarrCatalogSourceRow[];
    const catalog = buildZarrCatalog(rows, {
      contractBase: "https://zarr.nemar.org/",
      generatedUtc: "2026-09-02T00:00:00Z",
    });
    const entry = catalog.datasets.find((d) => d.dataset_id === VERIFIED);
    expect(entry?.zarr_verify_status).toBe("verified");
    expect(entry?.zarr_verified_at).toBeTruthy();
    expect(catalog.datasets.find((d) => d.dataset_id === UNSWEPT)?.zarr_verify_status).toBeNull();

    // Reader 2: the has_zarr_verified filter, through the real clause builder.
    const params: (string | number)[] = [];
    const clauses = buildDatasetFilterClauses(params, { hasZarrVerified: true });
    const filtered = db
      .query(`SELECT d.dataset_id FROM datasets d WHERE 1=1${clauses} ORDER BY d.dataset_id`)
      .all(...(params as never[])) as { dataset_id: string }[];
    expect(filtered.map((r) => r.dataset_id)).toEqual([VERIFIED]);
  });
});
