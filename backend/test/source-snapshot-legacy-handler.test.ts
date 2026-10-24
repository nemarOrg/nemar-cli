/**
 * Site D of the snapshot insert: the legacy EZID version-DOI handler, driven through its route
 * (`POST /webhooks/publish-version-doi`) with real SQLite and a local stand-in for GitHub, S3
 * and the registrar (epic #1046 phase 2, #1908; ADR 0111, decision 4).
 *
 * WHY THE TESTS RUN IN A PROCESS OF THEIR OWN. The handler reads the tagged description with
 * the REAL `getTreeAtRef`, and several other backend tests install a process-wide
 * `mock.module("../src/services/github", ...)` whose `getTreeAtRef` returns an empty tree.
 * `mock.module` cannot be undone, and `test/` and `backend/test/` share one Bun process, so in a
 * full run this handler would read an empty tree and record NULL/NULL for a description that is
 * there: the assertions pass alone and fail in a full run (see
 * `doi-attribution-routes.test.ts` for the same gap). So the assertions live in the first
 * describe, which runs only when `SOURCE_SNAPSHOT_ISOLATED=1`, and the second describe spawns
 * this very file in a child process with that variable set and requires it to pass. The
 * assertions therefore always run, and always in a process no mock has touched.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import worker from "../src/index";
import { __resetInstallationTokenCacheForTests } from "../src/services/github-auth";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { startStandin } from "./helpers/source-snapshot-standin";

const ISOLATED = process.env.SOURCE_SNAPSHOT_ISOLATED === "1";
const API = "https://api.nemar.org";
const WEBHOOK = "snap-legacy-webhook-token-0123456789abcdef";
const realFetch = globalThis.fetch;
const quiet = { error: console.error, warn: console.warn, log: console.log };
const NOT_EXAMINED = { source_version: null, source_version_basis: null };
/** How many tests the isolated describe holds; the wrapper requires the child to run them all. */
const ISOLATED_TESTS = 4;

describe.skipIf(!ISOLATED)("the legacy version-DOI handler records the snapshot it read", () => {
  let standin: ReturnType<typeof startStandin>;
  let db: ReturnType<typeof freshDb>;

  beforeAll(() => {
    standin = startStandin();
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = standin.base;
    // The registrar: the stand-in answers every EZID verb with success.
    (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL = standin.base;
  });
  afterAll(() => {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
    (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL = undefined;
    standin.stop();
  });
  beforeEach(() => {
    db = freshDb();
    standin.reset();
    __resetRateLimitStateForTests();
    __resetInstallationTokenCacheForTests();
    console.error = () => {};
    // S3 lives on an amazonaws.com host the code builds itself; send it to the stand-in.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname.endsWith(".amazonaws.com")) {
        return realFetch(`${standin.base}${url.pathname}`, {
          method: input instanceof Request ? input.method : (init?.method ?? "GET"),
          headers: input instanceof Request ? input.headers : new Headers(init?.headers),
          body: input instanceof Request ? undefined : init?.body,
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = quiet.error;
    console.warn = quiet.warn;
    console.log = quiet.log;
  });

  const legacyEnv = (): Bindings =>
    ({
      DB: realD1(db),
      ENVIRONMENT: "test",
      GITHUB_RAW_BASE: standin.base,
      GITHUB_ADMIN_PAT: "snap-test-pat",
      S3_BUCKET: "nemar",
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "AKIATEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      NEMAR_WEBHOOK_TOKEN: WEBHOOK,
      EZID_USERNAME: "apitest",
      EZID_PASSWORD: "apitest",
      EZID_SANDBOX_USERNAME: "apitest",
      EZID_SANDBOX_PASSWORD: "apitest",
    }) as Bindings;

  async function publishVersionDoi(id: string) {
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, concept_doi, visibility)
       VALUES (?, ?, -1, ?, ?, 'public')`,
    ).run(id, `Dataset ${id}`, `nemarDatasets/${id}`, `10.82901/nemar.${id}`);
    const work: Promise<unknown>[] = [];
    const res = await worker.fetch(
      new Request(`${API}/webhooks/publish-version-doi`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": WEBHOOK },
        body: JSON.stringify({
          dataset_id: id,
          version: "1.0.0",
          release_url: `https://github.com/nemarDatasets/${id}/releases/tag/v1.0.0`,
        }),
      }),
      legacyEnv(),
      {
        waitUntil: (p: Promise<unknown>) => {
          work.push(p);
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
    await Promise.all(work);
    const snapshot = db
      .query<{ source_version: string | null; source_version_basis: string | null }, [string]>(
        "SELECT source_version, source_version_basis FROM dataset_versions WHERE dataset_id = ? AND version = '1.0.0'",
      )
      .get(id);
    return { res, snapshot };
  }

  test("a description with a DOI gives its tag", async () => {
    standin.gitDescribe("on000090", "v1.0.0", {
      Name: "x",
      BIDSVersion: "1.9.0",
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000090.v5.0.1" }],
    });
    const { res, snapshot } = await publishVersionDoi("on000090");
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { message: string; metadata_warnings?: string[] };
    expect(answer.message).toBe("Version DOI published successfully");
    // Name the cause when the description could not be read, instead of a bare NULL/NULL.
    expect(answer.metadata_warnings).toBeUndefined();
    expect(snapshot).toEqual({ source_version: "5.0.1", source_version_basis: "doi" });
  });

  test("a description that names no upstream is unknown", async () => {
    standin.gitDescribe("on000091", "v1.0.0", { Name: "x", BIDSVersion: "1.9.0" });
    const { res, snapshot } = await publishVersionDoi("on000091");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual({ source_version: null, source_version_basis: "unknown" });
  });

  test("a tree with no description file leaves NULL/NULL: the { Name } fallback is not a description", async () => {
    const { res, snapshot } = await publishVersionDoi("on000092");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
  });

  test("a description that is not JSON leaves NULL/NULL here: only the raw-reading sites call it unknown", async () => {
    standin.gitDescribe("on000093", "v1.0.0", "<<not json>>");
    const { res, snapshot } = await publishVersionDoi("on000093");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
  });
});

describe.skipIf(ISOLATED)("the legacy version-DOI handler tests, in a process of their own", () => {
  test("pass when this file is run alone with the isolation switch on", async () => {
    const proc = spawn({
      cmd: [
        "bun",
        "test",
        `./${import.meta.path.slice(import.meta.path.indexOf("backend/test/"))}`,
      ],
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, SOURCE_SNAPSHOT_ISOLATED: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
    const exitCode = await proc.exited;
    expect(out).toMatch(new RegExp(`\\b${ISOLATED_TESTS} pass\\b`));
    expect(out).toMatch(/\b0 fail\b/);
    expect(exitCode).toBe(0);
  }, 60_000);
});
