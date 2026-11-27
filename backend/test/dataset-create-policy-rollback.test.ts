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
import { type CapturedEmail, sendsTo, withFakeResend } from "./helpers/resend";
import { type S3ManifestStandin, startS3ManifestStandin } from "./helpers/s3-manifest-standin";

const BUCKET = "nemar";
const API_KEY = "policyrollback-key-0123456789abcdef0123456789abcd";
const PAT = "ghp_standin_only_never_real";
const ADMIN_EMAIL = "policy-admin@example.org";

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
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('policyadmin', ?, 'x', 'approved', 'admin', 1)`,
    [ADMIN_EMAIL],
  );
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(API_KEY),
    API_KEY.slice(0, 8),
  );
}

/** Admin mail is opted in only inside `withFakeResend`, so nothing can reach Resend. */
let notify = false;

function env(): Bindings {
  const mail = notify
    ? {
        DEV_ADMIN_NOTIFICATIONS: "1",
        DEV_EMAIL_ALLOWLIST: ADMIN_EMAIL,
        RESEND_API_KEY: "re_test",
        FROM_EMAIL: "NEMAR <noreply@nemar.org>",
      }
    : {};
  return {
    ...mail,
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

function create(
  files: Array<{ path: string; size: number; type: string }> = [
    { path: "sub-01/eeg/sub-01_task-rest_eeg.set", size: 10, type: "data" },
  ],
): Promise<Response> {
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
        files,
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
  notify = false;
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

/** Run `fn` with admin mail opted in and captured by the local Resend stand-in. */
async function withAdminMail(fn: (calls: CapturedEmail[]) => Promise<void>): Promise<void> {
  notify = true;
  try {
    await withFakeResend(fn);
  } finally {
    notify = false;
  }
}

function adminSubjects(calls: CapturedEmail[]): string[] {
  return sendsTo(calls, ADMIN_EMAIL).map((m) => m.subject);
}

describe("POST /datasets: a failed S3 permission rolls the create back (#2497)", () => {
  test("repository deleted and row removed when the permission INSERT fails", async () => {
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, ["nm000111"]));
    // Real engine fault: the permission INSERT itself aborts.
    db.run(
      "CREATE TRIGGER fail_perm BEFORE INSERT ON user_s3_permissions BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const res = await create();
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error?: string;
      dataset_id?: string;
      rolled_back?: boolean;
      upload_urls?: unknown;
    };
    expect(body.error).toBe("Failed to configure S3 access for dataset");
    expect(body.rolled_back).toBe(true);
    expect(body.upload_urls).toBeUndefined();
    expect(githubLog).toContainEqual({
      method: "DELETE",
      path: `/repos/nemarDatasets/${body.dataset_id}`,
    });
    expect(datasetRows()).toBe(0);
    expect(s3.log.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("POST /datasets: an upload-URL failure after the carve-out rolls back (#2497)", () => {
  test("repository deleted, permission and row removed, no upload URL", async () => {
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, ["nm000111"]));
    const res = await create([{ path: "../escape.set", size: 10, type: "data" }]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      dataset_id?: string;
      rolled_back?: boolean;
      upload_urls?: unknown;
    };
    expect(body.rolled_back).toBe(true);
    expect(body.upload_urls).toBeUndefined();
    expect(githubLog).toContainEqual({
      method: "DELETE",
      path: `/repos/nemarDatasets/${body.dataset_id}`,
    });
    expect(datasetRows()).toBe(0);
    expect(permissionRows()).toBe(0);
    // The carve-out landed before the failure and stays (harmless, ADR 0145).
    expect(
      isDatasetPrivate(s3.getBucketPolicy() as BucketPolicy, BUCKET, body.dataset_id as string),
    ).toBe(true);
  });
});

describe("POST /datasets: admin alerts (#2497)", () => {
  test("a full policy mails the admins once a day, however many creates are refused", async () => {
    s3.setBucketPolicy(policyAtCap());
    await withAdminMail(async (calls) => {
      expect((await create()).status).toBe(503);
      expect((await create()).status).toBe(503);
      expect(adminSubjects(calls)).toEqual([
        "[NEMAR] ALERT: bucket policy full, dataset creation refused",
      ]);
    });
    const stamps = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'storage_policy_alert' AND resource_id = 'full'",
      )
      .get();
    expect(stamps?.n).toBe(1);
  });

  test("an incomplete rollback logs its tag and mails the admins, naming what was left", async () => {
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, ["nm000111"]));
    s3.setPolicyPutStatus(500);
    githubDeleteStatus = 403;
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
      realError(...args);
    };
    try {
      await withAdminMail(async (calls) => {
        const res = await create();
        const body = (await res.json()) as { dataset_id?: string; rolled_back?: boolean };
        expect(body.rolled_back).toBe(false);
        const mails = sendsTo(calls, ADMIN_EMAIL);
        expect(mails.map((m) => m.subject)).toEqual([
          `[NEMAR] ALERT: incomplete rollback of ${body.dataset_id}`,
        ]);
        expect(mails[0]?.html).toContain("github_repository");
        expect(
          errors.some(
            (e) =>
              e.startsWith("[datasets:rollback-incomplete]") &&
              e.includes(body.dataset_id as string),
          ),
        ).toBe(true);
      });
    } finally {
      console.error = realError;
    }
  });

  test("a carve-out written above 80% of the cap mails the near-cap alert", async () => {
    // Just above 80%, with room for more.
    let n = 1;
    while (JSON.stringify(sparsePolicy(n)).length <= MAX_BUCKET_POLICY_BYTES * 0.81) n++;
    s3.setBucketPolicy(sparsePolicy(n));
    await withAdminMail(async (calls) => {
      const res = await create();
      expect(res.status).toBeLessThan(300);
      expect(adminSubjects(calls)).toEqual(["[NEMAR] Bucket policy above 80% of its size cap"]);
    });
  });

  test("below 80% nothing is mailed", async () => {
    s3.setBucketPolicy(buildPublicAccessPolicy(BUCKET, ["nm000111"]));
    await withAdminMail(async (calls) => {
      expect((await create()).status).toBeLessThan(300);
      expect(adminSubjects(calls)).toEqual([]);
    });
  });
});
