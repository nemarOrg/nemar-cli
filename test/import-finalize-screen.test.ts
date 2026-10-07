/**
 * Finalize waits for the identifier screen and approves only a clear verdict (ADR 0087), driven
 * through the real `finalizeImport`.
 *
 * `--skip-data` with an in-memory manifest keeps the run to the API alone, so the only thing
 * replaced is the API itself: a local HTTP server answering each route in the backend's response
 * shape (the same harness the screen's CLI tests use), with a scripted sequence of screen states.
 * Everything the importer decides runs for real, including the CLI's own API client and its error
 * parsing of a gate refusal.
 *
 * The account config is written to a scratch config directory and the API URL is checked before
 * every test, so a leaked environment cannot point this file at a live backend.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiUrl } from "../src/lib/api/client";
import { finalizeImport } from "../src/lib/import-openneuro";
import type { ImportManifest } from "../src/lib/s3-server-copy";

const NEMAR_ID = "on999999";
const UPSTREAM_ID = "ds999999";

interface Script {
  /** Screen states the status route answers with, in order; the last repeats. */
  states: Array<string | null | "omit">;
  /** Answers of the approve route, in order; the last repeats. */
  approve: Array<{ status: number; body: unknown }>;
  visibility?: "public" | "private";
  statusFails?: boolean;
}

let script: Script;
const calls: string[] = [];
let statusReads = 0;
let approveCalls = 0;

const CLEAN_APPROVAL = {
  status: 200,
  body: { message: "Published", dataset_id: NEMAR_ID, status: "published", step_results: [] },
};
const STALE = {
  status: 409,
  body: {
    error: "identifier_screen_not_clear",
    gate: "stale",
    headline: "Identifier screen: clean",
    message: "The identifier screen read a commit main has moved past.",
  },
};

function view(state: string | null) {
  return { state, headline: `Identifier screen: ${state}`, tone: "note", lines: [] };
}

let server: ReturnType<typeof Bun.serve>;
let configDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const route = `${req.method} ${url.pathname}`;
      calls.push(route);
      switch (route) {
        case `POST /admin/datasets/${NEMAR_ID}/ci`:
          return Response.json({ message: "deployed", dataset_id: NEMAR_ID });
        case `GET /datasets/${NEMAR_ID}/ci/status`:
          return Response.json({ bids_validation: { present: true, status: "success" } });
        case `GET /datasets/${NEMAR_ID}`:
          return Response.json({
            dataset: {
              dataset_id: NEMAR_ID,
              status: "active",
              visibility: script.visibility ?? "private",
            },
          });
        case `POST /datasets/${NEMAR_ID}/publish/request`:
          return Response.json({
            message: "Publication request submitted",
            dataset_id: NEMAR_ID,
            status: "requested",
            identifier_screen: view("pending"),
          });
        case `GET /datasets/${NEMAR_ID}/publish/status`: {
          if (script.statusFails) return Response.json({ error: "boom" }, { status: 500 });
          const state = script.states[Math.min(statusReads, script.states.length - 1)];
          statusReads++;
          return Response.json({
            dataset_id: NEMAR_ID,
            status: "requested",
            ...(state === "omit" ? {} : { identifier_screen: view(state ?? null) }),
          });
        }
        case `POST /admin/publish/${NEMAR_ID}/approve`: {
          const answer = script.approve[Math.min(approveCalls, script.approve.length - 1)];
          approveCalls++;
          return Response.json(answer?.body, { status: answer?.status ?? 500 });
        }
        case `POST /admin/publish/${NEMAR_ID}/identifier-screen`:
          // A re-run starts a fresh screen: the next reads see it running, then its verdict.
          script.states = ["pending", script.states[script.states.length - 1] ?? null];
          statusReads = 0;
          return Response.json(
            {
              dataset_id: NEMAR_ID,
              request_id: 1,
              status: "pending",
              identifier_screen: view("pending"),
            },
            { status: 202 },
          );
        case `POST /admin/datasets/${NEMAR_ID}/reindex`:
          return Response.json({
            enrichment: { status: "ok" },
            sync: { metadata_columns_written: true },
          });
        default:
          return Response.json(
            { error: "Not Found", message: `Route ${route} not found` },
            { status: 404 },
          );
      }
    },
  });
  configDir = mkdtempSync(join(tmpdir(), "nemar-finalize-screen-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "importer",
      accounts: { importer: { apiKey: "k", apiUrl: `http://localhost:${server.port}` } },
    }),
  );
  savedEnv.NEMAR_CONFIG_DIR = process.env.NEMAR_CONFIG_DIR;
  process.env.NEMAR_CONFIG_DIR = configDir;
});

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
  if (savedEnv.NEMAR_CONFIG_DIR === undefined)
    Reflect.deleteProperty(process.env, "NEMAR_CONFIG_DIR");
  else process.env.NEMAR_CONFIG_DIR = savedEnv.NEMAR_CONFIG_DIR;
});

beforeEach(() => {
  calls.length = 0;
  statusReads = 0;
  approveCalls = 0;
  // Refuse to run against anything but this file's server.
  expect(getApiUrl()).toBe(`http://localhost:${server.port}`);
});

function manifest(privacy: ImportManifest["privacy"]): ImportManifest {
  return {
    openneuroId: UPSTREAM_ID,
    nemarId: NEMAR_ID,
    nemarUuid: "",
    items: [],
    ...(privacy === undefined ? {} : { privacy }),
  };
}

const SCRUBBED = { version: 1 as const, historyHoldsOriginals: false };

/** `"no-record"` writes a manifest without the field, the way an older prepare did. */
async function finalize(
  privacy: ImportManifest["privacy"] | "no-record" = SCRUBBED,
  waitMs = 2_000,
) {
  return finalizeImport(
    UPSTREAM_ID,
    {
      skipData: true,
      trustUpstream: true,
      screenWaitMs: waitMs,
      screenPollMs: 20,
      // finalize makes its work directory here; with --skip-data it never clones into it.
      workDir: configDir,
    },
    manifest(privacy === "no-record" ? undefined : privacy),
  );
}

const approveRoute = `POST /admin/publish/${NEMAR_ID}/approve`;
const rerunRoute = `POST /admin/publish/${NEMAR_ID}/identifier-screen`;
const count = (route: string) => calls.filter((c) => c === route).length;

describe("finalize approves only a clear screen", () => {
  test("waits while the screen runs, then approves a clean verdict", async () => {
    script = { states: ["pending", "pending", "clean"], approve: [CLEAN_APPROVAL] };
    expect(await finalize()).toEqual({ outcome: "published" });
    expect(statusReads).toBe(3);
    expect(count(approveRoute)).toBe(1);
    // The request came before the wait, and the approval after it.
    expect(calls.indexOf(`POST /datasets/${NEMAR_ID}/publish/request`)).toBeLessThan(
      calls.indexOf(approveRoute),
    );
  }, 30_000);

  test("acquisition dates only, and no recordings, are clear too", async () => {
    script = { states: ["dates-only"], approve: [CLEAN_APPROVAL] };
    expect((await finalize()).outcome).toBe("published");
    script = { states: ["no-recordings"], approve: [CLEAN_APPROVAL] };
    expect((await finalize()).outcome).toBe("published");
  }, 30_000);

  test("direct identifiers: blocked, and no approval is attempted", async () => {
    script = { states: ["pending", "direct-identifiers"], approve: [CLEAN_APPROVAL] };
    expect(await finalize()).toEqual({ outcome: "blocked" });
    expect(count(approveRoute)).toBe(0);
  }, 30_000);

  test("a screen that needs a person is left for one", async () => {
    for (const state of [
      "review",
      "not-screened",
      "unchecked",
      "clean-edf-only-others-unscreened",
    ]) {
      calls.length = 0;
      statusReads = 0;
      script = { states: [state], approve: [CLEAN_APPROVAL] };
      expect(await finalize()).toEqual({ outcome: "review", reason: "acknowledgment-needed" });
      expect(count(approveRoute)).toBe(0);
    }
  }, 30_000);

  test("a screen that did not run or report is unchecked, never clear", async () => {
    for (const state of ["error", "unreported", null]) {
      calls.length = 0;
      statusReads = 0;
      script = { states: [state], approve: [CLEAN_APPROVAL] };
      expect(await finalize()).toEqual({ outcome: "unchecked", reason: "no-verdict" });
      expect(count(approveRoute)).toBe(0);
    }
  }, 30_000);

  test("a state that is not one, however clean it sounds, is unchecked", async () => {
    // Inert value: the parse-and-read-back trap. `clear` is the GATE's word, not a state.
    for (const state of ["clear", "Clean", "clean "]) {
      calls.length = 0;
      statusReads = 0;
      script = { states: [state], approve: [CLEAN_APPROVAL] };
      expect(await finalize()).toEqual({ outcome: "unchecked", reason: "no-verdict" });
      expect(count(approveRoute)).toBe(0);
    }
  }, 30_000);

  test("a screen still running when the wait runs out is unchecked", async () => {
    script = { states: ["pending"], approve: [CLEAN_APPROVAL] };
    const started = Date.now();
    expect(await finalize(SCRUBBED, 300)).toEqual({ outcome: "unchecked", reason: "timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(statusReads).toBeGreaterThan(1);
    expect(count(approveRoute)).toBe(0);
  }, 30_000);

  test("a status that cannot be read is unchecked, not clear", async () => {
    script = { states: ["clean"], approve: [CLEAN_APPROVAL], statusFails: true };
    expect(await finalize(SCRUBBED, 200)).toEqual({
      outcome: "unchecked",
      reason: "status-unreadable",
    });
    expect(count(approveRoute)).toBe(0);
  }, 30_000);

  test("a backend that sends no screen view is unchecked", async () => {
    script = { states: ["omit"], approve: [CLEAN_APPROVAL] };
    expect(await finalize()).toEqual({ outcome: "unchecked", reason: "no-screen-view" });
    expect(count(approveRoute)).toBe(0);
  }, 30_000);
});

describe("what a clear screen cannot see", () => {
  test("a scrub that left originals in the pushed history is held for a person", async () => {
    script = { states: ["clean"], approve: [CLEAN_APPROVAL] };
    expect(await finalize({ version: 1, historyHoldsOriginals: true })).toEqual({
      outcome: "review",
      reason: "history-holds-originals",
    });
    expect(count(approveRoute)).toBe(0);
  }, 30_000);

  test("a manifest with no scrub record (an older prepare) is held for a person", async () => {
    script = { states: ["clean"], approve: [CLEAN_APPROVAL] };
    expect(await finalize("no-record")).toEqual({ outcome: "review", reason: "no-scrub-record" });
    expect(count(approveRoute)).toBe(0);
  }, 30_000);
});

describe("a screen whose commit main moved past", () => {
  test("is re-run once, and a clean re-run is approved", async () => {
    script = { states: ["clean", "clean"], approve: [STALE, CLEAN_APPROVAL] };
    expect(await finalize()).toEqual({ outcome: "published" });
    expect(count(rerunRoute)).toBe(1);
    expect(count(approveRoute)).toBe(2);
    // The re-run's own wait was read: pending, then its verdict.
    expect(calls.lastIndexOf(rerunRoute)).toBeLessThan(calls.lastIndexOf(approveRoute));
  }, 30_000);

  test("is unchecked when the re-run is stale too: one re-run, never a loop", async () => {
    script = { states: ["clean"], approve: [STALE] };
    expect(await finalize()).toEqual({ outcome: "unchecked", reason: "stale" });
    expect(count(rerunRoute)).toBe(1);
    expect(count(approveRoute)).toBe(2);
  }, 30_000);
});

describe("a dataset that was already public", () => {
  test("is not requested or approved again", async () => {
    script = { states: ["clean"], approve: [CLEAN_APPROVAL], visibility: "public" };
    expect(await finalize()).toEqual({ outcome: "already-published" });
    expect(count(`POST /datasets/${NEMAR_ID}/publish/request`)).toBe(0);
    expect(count(approveRoute)).toBe(0);
    expect(statusReads).toBe(0);
  }, 30_000);
});
