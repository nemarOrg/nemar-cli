/**
 * The availability report must never create `main` (issue #1643), proven
 * through the real entry points: the single-dataset route
 * (`POST /admin/datasets/:id/availability-report`) and the sweep route
 * (`POST /admin/datasets/availability-report-sweep`).
 *
 * nm000358 (2026-10-07): the sweep committed the report through the Contents
 * API to a repository nothing had been pushed to yet. That PUT created `main`
 * as an unrelated ROOT commit, and every push of the depositor's upload was
 * then rejected as non-fast-forward. What matters is therefore not a return
 * value but what GitHub is asked to do: with no `main`, the number of PUTs it
 * receives is ZERO.
 *
 * Two real local servers stand in for the outside world, no mocks:
 *
 *  - GitHub, through the `NEMAR_GITHUB_API_URL` override the other
 *    GitHub-facing suites use. It counts every request, and its ref lookup
 *    answers the three shapes a dataset repository can have: `main` present,
 *    `main` absent (404), and an empty repository (409 "Git Repository is
 *    empty", the shape the contributor's stand-in documents; it is not yet
 *    confirmed against a real empty repository).
 *  - S3, through `S3_ENDPOINT_URL`, answering the LIST and the version
 *    manifest read that `verifyDatasetVersionS3` makes. It counts requests so
 *    the ORDER is observable: a refused row must not have paid for the S3
 *    walk, which is the most expensive thing a sweep row does.
 *
 * Mutation checks these tests were written against (each applied alone):
 * deleting the `branchExists` guard in `writeAvailabilityReport` fails the
 * absent-main and empty-repository cases on the PUT count; moving the guard
 * back below `verifyDatasetVersionS3` fails them on the S3 request count.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "avail-nomain-admin-key-0123456789abcdef0123456789abcdef";

type MainState = "present" | "absent" | "empty";

interface GithubRequest {
  method: string;
  path: string;
  /** Parsed JSON body of a PUT; `null` for anything else. */
  body: { branch?: string; message?: string } | null;
}

let github: Server;
let s3: Server;
let githubLog: GithubRequest[];
let s3Log: string[];
const mainState = new Map<string, MainState>();
let previousGithubUrl: string | undefined;

/** One complete object, so a successful report has something real to compare. */
const ANNEX_KEY = "SHA256E-s5--abc.edf";

beforeAll(() => {
  previousGithubUrl = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  github = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body =
        req.method === "PUT"
          ? ((await req.json().catch(() => null)) as GithubRequest["body"])
          : null;
      githubLog.push({ method: req.method, path: url.pathname, body });

      const ref = /^\/repos\/nemarDatasets\/([^/]+)\/git\/ref\/heads\/main$/.exec(url.pathname);
      if (ref && req.method === "GET") {
        const state = mainState.get(ref[1] ?? "") ?? "absent";
        if (state === "present") {
          return Response.json({ ref: "refs/heads/main", object: { sha: "a".repeat(40) } });
        }
        if (state === "empty") {
          return Response.json({ message: "Git Repository is empty." }, { status: 409 });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (/^\/repos\/nemarDatasets\/[^/]+\/contents\//.test(url.pathname)) {
        if (req.method === "PUT")
          return Response.json({ content: { sha: "c".repeat(40) } }, { status: 201 });
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      // The repository probe branchExists makes after a 404 on the ref: these
      // repositories are all visible to NEMAR.
      if (/^\/repos\/nemarDatasets\/[^/]+$/.test(url.pathname) && req.method === "GET") {
        return Response.json({ full_name: "nemarDatasets/x" });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${github.port}`;

  s3 = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      s3Log.push(`${req.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Contents><Key>${prefix}${ANNEX_KEY}</Key><Size>5</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
          { status: 200 },
        );
      }
      if (/^\/[^/]+\/version\/v1\.0\.0\.json$/.test(url.pathname)) {
        return Response.json({ files: { "sub-01/eeg/a.edf": { key: ANNEX_KEY, size: 5 } } });
      }
      return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    },
  });
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = previousGithubUrl;
  github.stop(true);
  s3.stop(true);
});

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "development",
    GITHUB_ADMIN_PAT: "test-pat",
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    S3_ENDPOINT_URL: `http://127.0.0.1:${s3.port}`,
  } as Bindings;
}

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('nomainadmin', 'nomainadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='nomainadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

/** A reportable dataset: public, non-sandbox, has a repo and a version DOI. */
function seedDataset(id: string, githubRepo: string | null = `nemarDatasets/${id}`): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox, latest_version_doi)
     VALUES (?, ?, 1, ?, 0, ?)`,
  ).run(id, id, githubRepo, `10.82901/nemar.${id}.v1.0.0`);
}

function post(path: string): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
}

const puts = () => githubLog.filter((r) => r.method === "PUT");

function stamp(id: string): string | null {
  return (
    db
      .query(
        "SELECT json_extract(sweep_stamps, '$.availability_report_at') AS at FROM datasets WHERE dataset_id = ?",
      )
      .get(id) as { at: string | null }
  ).at;
}

beforeEach(async () => {
  db = freshDb();
  githubLog = [];
  s3Log = [];
  mainState.clear();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

const NO_MAIN_CASES: ReadonlyArray<{ label: string; state: MainState }> = [
  { label: "main absent (ref lookup 404)", state: "absent" },
  { label: "empty repository (ref lookup 409 'Git Repository is empty')", state: "empty" },
];

for (const { label, state } of NO_MAIN_CASES) {
  describe(`${label}: the report is refused, not written`, () => {
    test("single-dataset route answers 409 naming the missing branch, and sends no PUT", async () => {
      seedDataset("nm000358");
      mainState.set("nm000358", state);

      const res = await post("/admin/datasets/nm000358/availability-report");

      expect(res.status).toBe(409);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain("nemarDatasets/nm000358");
      expect(error).toContain("has no main branch");
      expect(error).toContain("Nothing was written");
      // The line under test: the Contents API is never asked to write, so it
      // cannot create `main` as a root commit.
      expect(puts()).toEqual([]);
    });

    test("the refusal happens before the S3 LIST and manifest walk", async () => {
      seedDataset("nm000358");
      mainState.set("nm000358", state);

      await post("/admin/datasets/nm000358/availability-report");

      expect(s3Log).toEqual([]);
    });

    test("the sweep reports the refusal per dataset, sends no PUT, no S3 request, and leaves the row unstamped", async () => {
      seedDataset("nm000358");
      mainState.set("nm000358", state);

      const res = await post("/admin/datasets/availability-report-sweep");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        processed: number;
        written: number;
        errors: { dataset_id: string; error: string }[];
        remaining: number;
      };
      expect(body.processed).toBe(1);
      expect(body.written).toBe(0);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]?.dataset_id).toBe("nm000358");
      expect(body.errors[0]?.error).toContain("has no main branch");
      expect(puts()).toEqual([]);
      expect(s3Log).toEqual([]);
      // Unstamped: the row stays a candidate and is retried once main exists.
      expect(stamp("nm000358")).toBeNull();
      expect(body.remaining).toBe(1);
    });

    test("one refused dataset does not stop a later one with main from being written", async () => {
      seedDataset("nm000358");
      seedDataset("nm000360");
      mainState.set("nm000358", state);
      mainState.set("nm000360", "present");

      const res = await post("/admin/datasets/availability-report-sweep");

      const body = (await res.json()) as { processed: number; written: number; remaining: number };
      expect(body.processed).toBe(2);
      expect(body.written).toBe(1);
      expect(puts().map((r) => r.path)).toEqual([
        "/repos/nemarDatasets/nm000360/contents/.nemar/availability-report.json",
      ]);
      expect(stamp("nm000358")).toBeNull();
      expect(stamp("nm000360")).not.toBeNull();
      expect(body.remaining).toBe(1);
    });
  });
}

describe("main present: the report is written exactly once", () => {
  test("single-dataset route commits one PUT to main and walks S3 first", async () => {
    seedDataset("nm000360");
    mainState.set("nm000360", "present");

    const res = await post("/admin/datasets/nm000360/availability-report");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { written: boolean }).written).toBe(true);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.path).toBe(
      "/repos/nemarDatasets/nm000360/contents/.nemar/availability-report.json",
    );
    expect(puts()[0]?.body?.branch).toBe("main");
    // The cheap GitHub check is first, but the S3 walk still happens for a
    // row that passes it: the report is built from it.
    expect(s3Log.some((l) => l.includes("list-type=2"))).toBe(true);
    expect(s3Log.some((l) => l.includes("/nm000360/version/v1.0.0.json"))).toBe(true);
  });

  test("the sweep writes exactly one PUT and stamps the row", async () => {
    seedDataset("nm000360");
    mainState.set("nm000360", "present");

    const res = await post("/admin/datasets/availability-report-sweep");

    const body = (await res.json()) as {
      processed: number;
      written: number;
      errors: unknown[];
      remaining: number;
    };
    expect(body).toEqual({ processed: 1, written: 1, errors: [], remaining: 0 });
    expect(puts()).toHaveLength(1);
    expect(stamp("nm000360")).not.toBeNull();
  });
});

describe("paths that never need GitHub's branch", () => {
  test("?dry_run=1 on a dataset with no main still returns the report and makes no GitHub request", async () => {
    seedDataset("nm000358");
    mainState.set("nm000358", "empty");

    const res = await post("/admin/datasets/nm000358/availability-report?dry_run=1");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { dataset_id: string }).dataset_id).toBe("nm000358");
    expect(githubLog).toEqual([]);
    expect(s3Log.length).toBeGreaterThan(0);
  });

  test("a dataset with no github_repo is refused 400 before any S3 or GitHub request", async () => {
    seedDataset("ds000303", null);

    const res = await post("/admin/datasets/ds000303/availability-report");

    expect(res.status).toBe(400);
    expect(s3Log).toEqual([]);
    expect(githubLog).toEqual([]);
  });
});
