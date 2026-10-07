/**
 * Finalize waits for the identifier screen and approves only a clear verdict (ADR 0089), driven
 * through the real `finalizeImport`.
 *
 * `--skip-data` with an in-memory manifest keeps the run to the API alone, so the only thing
 * replaced is the API itself: a local HTTP server answering each route in the backend's response
 * shape (the same harness the screen's CLI tests use), with a scripted sequence of screen states.
 * Everything the importer decides runs for real, including the CLI's own API client and its error
 * parsing of a gate refusal.
 *
 * The account config is written to a scratch config directory, and TEST_API_URL, which the API
 * client prefers over any config, is pointed at this file's server for the file's duration and
 * restored after: `test/setup.ts` sets it to a blocked address at import time when there is no live
 * target, and in a single-process run that value reaches every later file. The URL is checked before
 * every test, so nothing here can reach a live backend.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiUrl } from "../src/lib/api/client";
import { finalizeImport } from "../src/lib/import-openneuro";
import { IMPORTER_HOLD_REASONS, awaitScreenAndApprove } from "../src/lib/import-publication";
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
  /** The status route's HTTP status when it refuses (404, 401, ...). */
  statusRefuses?: number;
  /** The request route answers 409: an open request in this state already exists. */
  existingRequest?: "requested" | "approving";
  /** The deny route answers with this status. */
  denyStatus?: number;
  /** The re-run route answers with this status. */
  rerunStatus?: number;
}

let script: Script;
const calls: string[] = [];
const denyBodies: string[] = [];
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
      if (route === `POST /admin/publish/${NEMAR_ID}/deny`) {
        denyBodies.push(await req.text());
        return script.denyStatus
          ? Response.json({ error: "boom" }, { status: script.denyStatus })
          : Response.json({ message: "Publication request denied", dataset_id: NEMAR_ID });
      }
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
          if (script.existingRequest) {
            // The backend's own 409 for an open request (routes/datasets/publication.ts).
            return Response.json(
              {
                error: "A publication request already exists",
                status: script.existingRequest,
                message:
                  script.existingRequest === "approving"
                    ? "Publication is in progress"
                    : "Use 'resend' to remind admins",
              },
              { status: 409 },
            );
          }
          return Response.json({
            message: "Publication request submitted",
            dataset_id: NEMAR_ID,
            status: "requested",
            identifier_screen: view("pending"),
          });
        case `GET /datasets/${NEMAR_ID}/publish/status`: {
          if (script.statusFails) return Response.json({ error: "boom" }, { status: 500 });
          if (script.statusRefuses) {
            return Response.json({ error: "Dataset not found" }, { status: script.statusRefuses });
          }
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
          if (script.rerunStatus) {
            return Response.json(
              { error: "identifier_screen_rerun_failed" },
              { status: script.rerunStatus },
            );
          }
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
  savedEnv.TEST_API_URL = process.env.TEST_API_URL;
  process.env.TEST_API_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
  if (savedEnv.NEMAR_CONFIG_DIR === undefined)
    Reflect.deleteProperty(process.env, "NEMAR_CONFIG_DIR");
  else process.env.NEMAR_CONFIG_DIR = savedEnv.NEMAR_CONFIG_DIR;
  // Reflect.deleteProperty, never `= undefined`, which stores the string "undefined".
  if (savedEnv.TEST_API_URL === undefined) Reflect.deleteProperty(process.env, "TEST_API_URL");
  else process.env.TEST_API_URL = savedEnv.TEST_API_URL;
});

beforeEach(() => {
  calls.length = 0;
  denyBodies.length = 0;
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
  test("a scrub that left originals in the pushed history is held, and the hold is written on the request", async () => {
    script = { states: ["clean"], approve: [CLEAN_APPROVAL] };
    expect(await finalize({ version: 1, historyHoldsOriginals: true })).toEqual({
      outcome: "review",
      reason: "history-holds-originals",
    });
    expect(count(approveRoute)).toBe(0);
    // A clean verdict would otherwise be approved by the next admin who reads the mail: the
    // request is denied with the importer's fixed reason, before any approval is asked for.
    expect(denyBodies.map((b) => JSON.parse(b).reason)).toEqual([
      IMPORTER_HOLD_REASONS["history-holds-originals"],
    ]);
  }, 30_000);

  test("a manifest with no scrub record (an older prepare) is held, and the hold written", async () => {
    script = { states: ["clean"], approve: [CLEAN_APPROVAL] };
    expect(await finalize("no-record")).toEqual({ outcome: "review", reason: "no-scrub-record" });
    expect(count(approveRoute)).toBe(0);
    expect(denyBodies.map((b) => JSON.parse(b).reason)).toEqual([
      IMPORTER_HOLD_REASONS["no-scrub-record"],
    ]);
  }, 30_000);

  test("a record that is not exactly version 1 with a boolean is no record at all", async () => {
    // Inert values: a cast from S3 JSON, so `{}` or a missing field would otherwise read as false.
    for (const bad of [{}, { version: 1 }, { version: 2, historyHoldsOriginals: false }]) {
      calls.length = 0;
      denyBodies.length = 0;
      script = { states: ["clean"], approve: [CLEAN_APPROVAL] };
      expect(await finalize(bad as ImportManifest["privacy"])).toEqual({
        outcome: "review",
        reason: "no-scrub-record",
      });
      expect(count(approveRoute)).toBe(0);
      expect(denyBodies).toHaveLength(1);
    }
  }, 30_000);

  test("no clean screen is approved on a dataset whose hold cannot be written", async () => {
    // Driven below finalize, because finalize exits the process on this failure by design: an open
    // request that a clean verdict would get approved is worse than a loud failed import.
    script = { states: ["clean"], approve: [CLEAN_APPROVAL], denyStatus: 500 };
    await expect(
      awaitScreenAndApprove({
        nemarId: NEMAR_ID,
        skipCiCheck: false,
        privacy: { version: 1, historyHoldsOriginals: true },
        waitMs: 1_000,
        pollMs: 10,
        approveRetryMs: 1,
      }),
    ).rejects.toThrow("could not record the importer's hold");
    expect(denyBodies).toHaveLength(3);
    expect(count(approveRoute)).toBe(0);
  }, 30_000);
});

describe("waits that cannot end in a verdict", () => {
  test("a status the backend refuses ends the wait at once", async () => {
    script = { states: ["clean"], approve: [CLEAN_APPROVAL], statusRefuses: 404 };
    const started = Date.now();
    expect(await finalize(SCRUBBED, 5_000)).toEqual({
      outcome: "unchecked",
      reason: "status-refused",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(count(approveRoute)).toBe(0);
  }, 30_000);

  test("a re-run that cannot start is said, not waited on", async () => {
    script = { states: ["clean"], approve: [STALE], rerunStatus: 500 };
    expect(await finalize()).toEqual({ outcome: "unchecked", reason: "rerun-failed" });
    expect(count(approveRoute)).toBe(1);
  }, 30_000);

  test("a sandbox exemption is never the importer's reason to approve", async () => {
    script = { states: ["exempt"], approve: [CLEAN_APPROVAL] };
    expect(await finalize()).toEqual({ outcome: "unchecked", reason: "no-verdict" });
    expect(count(approveRoute)).toBe(0);
  }, 30_000);
});

describe("a dataset that already has an open request", () => {
  test("is waited on and approved like a fresh one when its screen is clean", async () => {
    script = { states: ["clean"], approve: [CLEAN_APPROVAL], existingRequest: "requested" };
    expect(await finalize()).toEqual({ outcome: "published" });
    expect(count(approveRoute)).toBe(1);
  }, 30_000);

  test("is not approved a second time while an approval runs", async () => {
    script = { states: ["clean"], approve: [CLEAN_APPROVAL], existingRequest: "approving" };
    expect(await finalize()).toEqual({ outcome: "unchecked", reason: "approval-in-progress" });
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
