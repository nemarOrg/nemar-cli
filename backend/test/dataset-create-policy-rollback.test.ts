/**
 * POST /datasets against a full or failing bucket policy (#2497).
 *
 * In production the public-by-default policy reached 20,431 of AWS's 20,480
 * bytes, so every create claimed an id, created a GitHub repository, and only
 * then failed to carve the new prefix out of public access, leaving an empty
 * D1 row and an empty repository behind. This file drives the real route end
 * to end and asserts on what the stand-ins actually received and what D1
 * actually holds:
 *
 *  - a policy with no headroom is refused with 503 BEFORE any id is claimed
 *    or any repository is created;
 *  - a carve-out write that fails after the repository exists rolls the
 *    create back (repository deleted, permission and row removed) and never
 *    hands out an upload URL;
 *  - the control: a write that succeeds lands the carve-out, compacted.
 *
 * Real engine: bun:sqlite behind realD1, real auth middleware, real Hono
 * dispatch. S3 is the local stand-in reached through S3_ENDPOINT_URL (fenced to
 * non-production by testS3EndpointOverride); GitHub is a local Bun.serve
 * reached through NEMAR_GITHUB_API_URL. Nothing reaches the network.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import {
  type BucketPolicy,
  MAX_BUCKET_POLICY_BYTES,
  PUBLIC_ACCESS_SID,
  buildPublicAccessPolicy,
  isDatasetPrivate,
  prefixArn,
} from "../src/services/bucket-policy";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type S3ManifestStandin, startS3ManifestStandin } from "./helpers/s3-manifest-standin";

const BUCKET = "nemar";
const API_KEY = "policyrollback-key-0123456789abcdef0123456789abcd";
const PAT = "ghp_standin_only_never_real";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let s3: S3ManifestStandin;
let github: Server;
let githubLog: { method: string; path: string }[];
let githubDeleteStatus: number;
let userId: number;

function startGithubStandin(): Server {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      githubLog.push({ method: req.method, path: url.pathname });
      const create = /^\/orgs\/nemarDatasets\/repos$/.exec(url.pathname);
      if (create && req.method === "POST") {
        const body = (await req.json()) as { name: string };
        return Response.json(
          {
            name: body.name,
            full_name: `nemarDatasets/${body.name}`,
            html_url: `https://github.invalid/nemarDatasets/${body.name}`,
            clone_url: `https://github.invalid/nemarDatasets/${body.name}.git`,
            ssh_url: `git@github.invalid:nemarDatasets/${body.name}.git`,
            private: true,
          },
          { status: 201 },
        );
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/repos/nemarDatasets/")) {
        return new Response(githubDeleteStatus === 204 ? null : "forbidden", {
          status: githubDeleteStatus,
        });
      }
      return Response.json({}, { status: 201 });
    },
  });
}

async function seedUser(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access, sandbox_completed)
     VALUES ('policyrollback', 'policyrollback@example.org', 'x', 'policyrollback-gh',
             'approved', 'member', 'cli', 1, 1, 1)`,
  );
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'policyrollback'")
    .get();
  if (!row) throw new Error("seed failed");
  userId = row.id;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(API_KEY),
    API_KEY.slice(0, 8),
  );
}

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    SANDBOX_ID_FLOOR: "90001",
    S3_BUCKET: BUCKET,
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "ASIASTANDINONLY00000",
    AWS_SECRET_ACCESS_KEY: "standin-secret-never-real",
    S3_ENDPOINT_URL: s3.url,
    GITHUB_ADMIN_PAT: PAT,
  } as Bindings;
}

function create(): Promise<Response> {
  return app.request(
    "/datasets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "X-CLI-Version": "99.0.0",
      },
      body: JSON.stringify({
        name: "Policy Rollback Fixture",
        files: [{ path: "sub-01/eeg/sub-01_task-rest_eeg.set", size: 10, type: "data" }],
      }),
    },
    env(),
  );
}

/** A policy whose carve-out is `n` explicit ids that never share a decade. */
function sparsePolicy(n: number): BucketPolicy {
  const ids = Array.from({ length: n }, (_, i) => `nm${String(i * 10).padStart(6, "0")}`);
  return buildPublicAccessPolicy(BUCKET, ids);
}

/** The smallest sparse policy with no room for one more carve-out. */
function policyAtCap(): BucketPolicy {
  let n = 1;
  while (JSON.stringify(sparsePolicy(n + 1)).length <= MAX_BUCKET_POLICY_BYTES) n++;
  return sparsePolicy(n);
}

function datasetRows(): number {
  return (
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM datasets WHERE is_sandbox = 1").get()
      ?.n ?? -1
  );
}

function permissionRows(): number {
  return (
    db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM user_s3_permissions WHERE user_id = ?",
      )
      .get(userId)?.n ?? -1
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  await seedUser();
  s3 = startS3ManifestStandin();
  githubLog = [];
  githubDeleteStatus = 204;
  github = startGithubStandin();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${github.port}`;
});

afterEach(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  github.stop(true);
  s3.stop();
});

describe("POST /datasets: bucket-policy headroom (#2497)", () => {
  test("a full policy is refused with 503 before any id is claimed or repo created", async () => {
    s3.setBucketPolicy(policyAtCap());
    const res = await create();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Storage policy full, administrators notified");
    expect(datasetRows()).toBe(0);
    expect(githubLog).toEqual([]);
    expect(s3.log.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("POST /datasets: a failed carve-out rolls the create back (#2497)", () => {
  test("repository deleted, permission and row removed, no upload URL", async () => {
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, ["nm000111"]));
    s3.setPolicyPutStatus(500);
    const res = await create();
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error?: string;
      dataset_id?: string;
      rolled_back?: boolean;
      upload_urls?: unknown;
    };
    expect(body.error).toBe("Failed to secure dataset storage");
    expect(body.rolled_back).toBe(true);
    expect(body.upload_urls).toBeUndefined();
    const id = body.dataset_id;
    expect(id).toMatch(/^xx\d{6}$/);
    // The repository was created, then deleted.
    expect(githubLog).toContainEqual({ method: "POST", path: "/orgs/nemarDatasets/repos" });
    expect(githubLog).toContainEqual({ method: "DELETE", path: `/repos/nemarDatasets/${id}` });
    // Nothing is left in D1.
    expect(datasetRows()).toBe(0);
    expect(permissionRows()).toBe(0);
  });

  test("a repository that cannot be deleted keeps its row, named, and the permission still goes", async () => {
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, ["nm000111"]));
    s3.setPolicyPutStatus(500);
    githubDeleteStatus = 403;
    const res = await create();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { dataset_id?: string; rolled_back?: boolean };
    expect(body.rolled_back).toBe(false);
    const row = db
      .query<{ github_repo: string }, [string]>(
        "SELECT github_repo FROM datasets WHERE dataset_id = ?",
      )
      .get(body.dataset_id as string);
    expect(row?.github_repo).toBe(`nemarDatasets/${body.dataset_id}`);
    expect(permissionRows()).toBe(0);
  });

  test("control: a carve-out that lands keeps the dataset and writes it private", async () => {
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, ["nm000111"]));
    const res = await create();
    const body = (await res.json()) as { dataset?: { dataset_id?: string } };
    const id = body.dataset?.dataset_id;
    expect(res.status).toBeLessThan(300);
    expect(id).toMatch(/^xx\d{6}$/);
    const written = s3.getBucketPolicy() as BucketPolicy;
    expect(isDatasetPrivate(written, BUCKET, id as string)).toBe(true);
    expect(isDatasetPrivate(written, BUCKET, "nm000111")).toBe(true);
    const stmt = written.Statement.find((s) => s.Sid === PUBLIC_ACCESS_SID);
    expect(stmt?.NotResource).toContain(prefixArn(BUCKET, id as string));
    expect(githubLog.some((r) => r.method === "DELETE")).toBe(false);
    expect(datasetRows()).toBe(1);
    expect(permissionRows()).toBe(1);
  });
});
