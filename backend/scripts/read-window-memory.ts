#!/usr/bin/env bun
/**
 * `read_window` taste-mode memory measurement (epic #1065 phase 4, issue
 * #1296's definition of done, item 3).
 *
 * Drives the REAL tool code (`readWindowTool`, `backend/src/mcp/tools/read-window.ts`)
 * against the two LIVE datasets named in the phase's verified-geometry facts:
 * nm000329 (63 channels, the smallest live store this phase measured) and
 * on003392's `sub-06` store (320 channels; wide, though not the archive's
 * widest, which is 415 -- see the note in design doc section 10.4 -- but a
 * taste can request at most `READ_WINDOW_TASTE_MAX_CHANNELS` of them, so the
 * case below asks for 64, the hard cap). Each case's `duration_s`/`channels`
 * sit just under `READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES` (65,536) -- close to
 * the cap without risking a float-rounding rejection exactly at the boundary.
 *
 * A local (bun:sqlite) D1 stands in for Cloudflare D1 -- the SAME
 * `freshDb`/`realD1` helpers the test suite uses -- seeded with one row per
 * dataset so `loadPublicDatasetRow`/`isZarrReady` pass; this is the only
 * thing that is not the real production binding. Every other read
 * (`index.json` through the real `zarr-data.ts` sub-app, the level-0
 * `zarr.json`, every shard footer and chunk) is a REAL network fetch against
 * the live `zarr.nemar.org` / `nemar.s3.us-east-2.amazonaws.com` hosts, with
 * a named User-Agent on every request (a generic UA gets a 403 from these
 * hosts).
 *
 * HONESTY NOTE (read this before trusting a number below): `process.memoryUsage().heapUsed`
 * is a Bun (V8) heap measurement, standing in for a real Cloudflare Workers
 * `workerd` isolate -- Bun's GC pacing, object layout, and heap growth policy
 * are not workerd's, and a single-process Bun script never pays workerd's
 * per-isolate baseline either. The number to actually trust for isolate
 * sizing is the ANALYTIC BOUND printed alongside each case:
 * `n_channels_in_store x chunk_samples x 2` bytes for one decoded inner
 * chunk (the code holds at most one at a time, per store, before copying its
 * requested channels/columns out and letting it go -- see `read-window.ts`'s
 * module doc and `taste.ts`'s `assembleTasteValues`) plus
 * `channels.length x n_samples x 8` bytes for the output `number[][]` (a
 * plain JS array of arrays of doubles). Usage: `bun run backend/scripts/read-window-memory.ts`.
 */

import type { ReadWindowInput, ReadWindowOutput } from "../../shared/contract/mcp.js";
import type { RecordingToolDeps } from "../src/mcp/tool-types.js";
import { readWindowTool } from "../src/mcp/tools/read-window.js";
import { createZarrDataRoutes } from "../src/routes/zarr-data.js";
import type { Bindings } from "../src/types/bindings.js";
import { InMemoryCache } from "../test/helpers/cache.js";
import { freshDb, realD1 } from "../test/helpers/d1.js";

const NAMED_USER_AGENT = "nemar-cli/mcp-phase4";

/** Every request through this fetch carries a named User-Agent -- api.nemar.org
 *  and zarr.nemar.org 403 a generic one (a known, documented fact about
 *  these hosts, not specific to this script). */
function fetchWithUserAgent(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", NAMED_USER_AGENT);
  return fetch(input, { ...init, headers });
}

interface CaseSpec {
  label: string;
  datasetId: string;
  recording: string;
  group: string;
  sourceCommit: string;
  nChannelsInStore: number;
  channels: number[];
  durationS: number;
  /** Window start. Defaults to 0; a case that sets this deliberately lands in
   *  a specific shard (see the boundary-shard case below). */
  startS?: number;
  /** What this case is here to exercise, printed alongside the numbers. */
  why?: string;
}

// Real, live-verified per the plan's own "what I already verified against
// live data" facts and re-confirmed (curl -A, 2026-09-08) immediately before
// writing this script -- both source_commit values still match the live
// index.json.
const CASES: CaseSpec[] = [
  {
    label: "nm000329 sub-1 (63 ch, EEG, chunk_samples 1000)",
    datasetId: "nm000329",
    recording: "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr",
    group: "eeg_250hz",
    sourceCommit: "7172d2d492dad63650f80cdb83352a0e9d4420f7",
    nChannelsInStore: 63,
    channels: Array.from({ length: 63 }, (_, i) => i),
    durationS: 4.12, // -> 1030 samples; 63 x 1030 = 64,890 channel-samples
  },
  {
    label: "on003392 sub-06 (320 ch MEG store; taste capped at 64 channels)",
    datasetId: "on003392",
    recording: "sub-06/meg/sub-06_task-localizer_meg.zarr",
    group: "meg_250hz",
    sourceCommit: "1035360c2cbb5a349cc43a46a58543c5f02a4e38",
    nChannelsInStore: 320,
    channels: Array.from({ length: 64 }, (_, i) => i), // READ_WINDOW_TASTE_MAX_CHANNELS
    durationS: 4.08, // -> 1020 samples; 64 x 1020 = 65,280 channel-samples
  },
  {
    // The BOUNDARY shard. nm000329's array is [63, 138750] with
    // shard_samples 75000, so shard 1 is the truncated one: it covers
    // nominal samples [75000, 150000) with only 63750 real. Starting at
    // exactly sample 75000 (300 s) reads local chunk 0 of that shard, which
    // is the precise request the footer-entry-count defect misread -- it
    // returned local index 11, i.e. sample 86000, 44 s later, with no error.
    // Keeping it in this script means the fixed path is exercised against
    // live production bytes on every run, not just in a one-off check.
    label:
      "nm000329 sub-1 at the BOUNDARY shard (start 300 s = sample 75000, shard 1 local chunk 0)",
    datasetId: "nm000329",
    recording: "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr",
    group: "eeg_250hz",
    sourceCommit: "7172d2d492dad63650f80cdb83352a0e9d4420f7",
    nChannelsInStore: 63,
    channels: [0],
    startS: 300,
    durationS: 4,
    why: "the truncated last shard, where a per-shard entry count silently shifted every chunk by 11",
  },
];

/** `chunk_samples` for every store measured here (both are 1000, per the
 *  index.json geometry printed alongside each case's result). */
const CHUNK_SAMPLES = 1000;

function insertRow(db: ReturnType<typeof freshDb>, datasetId: string, sourceCommit: string): void {
  db.query(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, status, is_sandbox, zarr_status, zarr_store_count, zarr_source_commit)
     VALUES (?, -1, ?, 'public', 'active', 0, 'ready', 1, ?)`,
  ).run(datasetId, datasetId, sourceCommit);
}

async function measureCase(spec: CaseSpec): Promise<void> {
  const db = freshDb();
  insertRow(db, spec.datasetId, spec.sourceCommit);

  const cache = new InMemoryCache();
  const zarrRoutes = createZarrDataRoutes({ cache: () => cache, fetch: fetchWithUserAgent });
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      p.catch(() => {});
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const env = {
    DB: realD1(db),
    ENVIRONMENT: "production",
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
  } as unknown as Bindings;
  const deps: RecordingToolDeps = {
    env,
    executionCtx,
    cache: () => cache,
    fetch: fetchWithUserAgent,
    zarrRoutes,
    rawGithubBase: "https://raw.githubusercontent.com",
  };

  const input: ReadWindowInput = {
    dataset_id: spec.datasetId,
    recording: spec.recording,
    group: spec.group,
    start_s: spec.startS ?? 0,
    duration_s: spec.durationS,
    channels: spec.channels,
    taste: true,
  };

  if (typeof globalThis.gc === "function") globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;

  const outcome = await readWindowTool(deps, input);

  const heapAfter = process.memoryUsage().heapUsed;

  console.log(`\n=== ${spec.label} ===`);
  console.log(`recording: ${spec.recording}  group: ${spec.group}`);
  console.log(`requested: ${spec.channels.length} channels x ${spec.durationS} s`);
  if (spec.why) console.log(`exercises: ${spec.why}`);

  if (outcome.result.isError) {
    console.error("FAILED -- tool returned isError:true:");
    console.error(JSON.stringify(outcome.result, null, 2));
    process.exitCode = 1;
    return;
  }

  const output = outcome.result.structuredContent as ReadWindowOutput;
  if (output.mode !== "taste") {
    console.error(`FAILED -- expected mode: "taste", got "${output.mode}"`);
    process.exitCode = 1;
    return;
  }

  const windowSamples = output.values[0]?.length ?? 0;
  const channelSamples = output.channels.length * windowSamples;
  const analyticBoundBytes =
    spec.nChannelsInStore * CHUNK_SAMPLES * 2 + // one decoded inner chunk, all its channels, int16
    output.channels.length * windowSamples * 8; // the output number[][] (JS doubles)

  console.log(
    `window: [${output.start_s}s, ${(output.start_s + output.duration_s).toFixed(3)}s) -- ${windowSamples} samples`,
  );
  console.log(`channel-samples: ${channelSamples} (cap: 65536)`);
  console.log(`chunks_read (tool-reported): ${output.chunks_read}`);
  console.log(`bytes_read (tool-reported, upstream): ${output.bytes_read.toLocaleString()}`);
  console.log(
    `metrics: cacheStatus=${outcome.metrics?.cacheStatus ?? "none"} upstreamBytes=${(outcome.metrics?.upstreamBytes ?? 0).toLocaleString()}`,
  );
  console.log(
    `Bun heapUsed delta: ${(heapAfter - heapBefore).toLocaleString()} bytes ` +
      `(${heapBefore.toLocaleString()} -> ${heapAfter.toLocaleString()})`,
  );
  console.log(
    `Analytic bound: ${analyticBoundBytes.toLocaleString()} bytes (${spec.nChannelsInStore} store channels x ${CHUNK_SAMPLES} chunk_samples x 2 bytes for one decoded inner chunk, plus ${output.channels.length} requested channels x ${windowSamples} samples x 8 bytes for the output array)`,
  );
}

async function main(): Promise<void> {
  console.log("read_window taste-mode memory measurement (backend/scripts/read-window-memory.ts)");
  console.log(
    "See this file's module doc for the honesty note: process.memoryUsage().heapUsed is a Bun " +
      "heap measurement standing in for a real workerd isolate; trust the analytic bound for sizing.",
  );
  for (const spec of CASES) {
    await measureCase(spec);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
