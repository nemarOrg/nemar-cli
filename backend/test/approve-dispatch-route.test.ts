/**
 * POST /admin/publish/:id/approve-dispatch (ADR 0080).
 *
 * The website cannot drive an approval itself: after the irreversible DOI
 * publish, S3 Object Lock runs in batches the CALLER must keep requesting, and
 * moving that loop into the Worker is a cost the platform chose not to pay. So
 * this route claims the request, records who clicked, and dispatches the run to
 * an executor. What is pinned here is the whole claim protocol: one run at a
 * time (including against a person's own terminal run), a claim that is
 * released when GitHub refuses, and a dispatch that carries exactly the contract
 * and never a credential.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the
 * real auth middleware (hashed API keys, and a real web session for the cookie
 * path the website uses), and the real route via Hono app.request(). GitHub is
 * a `Bun.serve()` stand-in for api.github.com, the pattern the other dispatch
 * tests use, so the request each case sends is read off the wire. Ages are set
 * with SQLite's own `datetime('now', '-N minutes')`, 20 and 1 minutes against
 * the 15-minute lease, so no case sits on the edge.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "dispatch-admin-key-0123456789abcdef0123456789abcdef";
const SECOND_ADMIN_KEY = "dispatch-admin2-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "dispatch-member-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm098765";
const APP_ORIGIN = "https://app.nemar.org";

interface Dispatch {
  path: string;
  authorization: string | null;
  body: { event_type: string; client_payload: Record<string, unknown> };
}

let server: Server;
let dispatches: Dispatch[] = [];
let githubStatus = 204;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;
let secondAdminId: number;
let envOverrides: Partial<Bindings> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      dispatches.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new Response(githubStatus === 204 ? null : '{"message":"refused"}', {
        status: githubStatus,
      });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

afterEach(() => {
  dispatches = [];
  githubStatus = 204;
  envOverrides = {};
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "ghp_dispatch_test_token",
    ...envOverrides,
  } as Bindings;
}

async function seedUser(username: string, role: string, key: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'approved', ?, 1)`,
    [username, `${username}@example.org`, role],
  );
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!u) throw new Error(`seed: ${username} insert failed`);
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return u.id;
}

interface Seed {
  status?: string;
  /** SQLite modifier such as "-20 minutes"; omitted means NULL. */
  dispatchedAt?: string;
  updatedAt?: string;
  requestedBy?: number;
  /** Requested time, to order several requests for one dataset. */
  requestedAt?: string;
  dataset?: string;
}

function seedRequest(seed: Seed = {}): number {
  const modifier = (m: string | undefined) => (m ? `datetime('now', '${m}')` : "NULL");
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at,
        approval_requested_by, approval_dispatched_at)
     VALUES (?, ?, ?, ${seed.requestedAt ? `datetime('now', '${seed.requestedAt}')` : "datetime('now', '-3 hours')"},
             ${seed.updatedAt ? modifier(seed.updatedAt) : "datetime('now', '-3 hours')"},
             ${seed.requestedBy ?? "NULL"}, ${modifier(seed.dispatchedAt)})`,
    [seed.dataset ?? DATASET, seed.status ?? "requested", adminId],
  );
  return db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
}

function row(id: number) {
  return db
    .query<
      {
        status: string;
        approval_requested_by: number | null;
        approval_dispatched_at: string | null;
        updated_at: string;
      },
      [number]
    >(
      "SELECT status, approval_requested_by, approval_dispatched_at, updated_at FROM publication_requests WHERE id = ?",
    )
    .get(id);
}

function dispatchWith(key: string, dataset = DATASET): Promise<Response> {
  return app.request(
    `/admin/publish/${dataset}/approve-dispatch`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "X-CLI-Version": "99.0.0" },
    },
    env(),
  );
}

async function errorBody(res: Response): Promise<{ error: string; message: string }> {
  return (await res.json()) as { error: string; message: string };
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedUser("dispatchadmin", "admin", ADMIN_KEY);
  secondAdminId = await seedUser("dispatchadmin2", "admin", SECOND_ADMIN_KEY);
  await seedUser("dispatchmember", "member", MEMBER_KEY);
});

describe("a pending request", () => {
  test("is claimed for the admin who clicked and dispatched once, answering 202", async () => {
    const id = seedRequest();
    const res = await dispatchWith(ADMIN_KEY);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: "dispatched",
      dataset_id: DATASET,
      request_id: id,
      resume: false,
    });

    const claimed = row(id);
    expect(claimed?.approval_requested_by).toBe(adminId);
    expect(claimed?.approval_dispatched_at).not.toBeNull();
    // Still `requested`: only the orchestrator moves a request to `approving`.
    expect(claimed?.status).toBe("requested");

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].path).toBe("/repos/nemarDatasets/.github/dispatches");
    expect(dispatches[0].authorization).toBe("Bearer ghp_dispatch_test_token");
    expect(dispatches[0].body).toEqual({
      event_type: "approve-publication",
      client_payload: {
        dataset_id: DATASET,
        request_id: id,
        resume: false,
        environment: "dev",
      },
    });
  });

  test("names production only when the Worker is the production Worker", async () => {
    seedRequest();
    envOverrides = { ENVIRONMENT: "production" };
    await dispatchWith(ADMIN_KEY);
    expect(dispatches[0].body.client_payload.environment).toBe("production");
  });

  test("leaves an audit row naming the admin who clicked", async () => {
    const id = seedRequest();
    await dispatchWith(ADMIN_KEY);
    const audit = db
      .query<{ user_id: number; resource_id: string; details: string }, []>(
        "SELECT user_id, resource_id, details FROM audit_log WHERE action = 'approval_dispatched'",
      )
      .get();
    expect(audit?.user_id).toBe(adminId);
    expect(audit?.resource_id).toBe(DATASET);
    expect(JSON.parse(audit?.details ?? "{}")).toEqual({
      request_id: id,
      resume: false,
      environment: "dev",
    });
  });

  test("does not touch updated_at, which is the orchestrator's progress heartbeat", async () => {
    const id = seedRequest({ updatedAt: "-3 hours" });
    const before = row(id)?.updated_at;
    await dispatchWith(ADMIN_KEY);
    expect(row(id)?.updated_at).toBe(before ?? "");
  });
});

describe("an approving request", () => {
  test("whose run died resumes: the payload says so", async () => {
    // Stopped partway, quiet for 20 minutes: nothing is driving it.
    const id = seedRequest({ status: "approving", updatedAt: "-20 minutes" });
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { resume: boolean }).resume).toBe(true);
    expect(dispatches[0].body.client_payload).toMatchObject({ request_id: id, resume: true });
  });
});

describe("the lease: one run at a time", () => {
  test("a second click while a web run is in flight is refused, with no dispatch and no change", async () => {
    const id = seedRequest({
      dispatchedAt: "-1 minutes",
      requestedBy: secondAdminId,
    });
    const res = await dispatchWith(ADMIN_KEY);

    expect(res.status).toBe(409);
    expect((await errorBody(res)).error).toBe("already_in_flight");
    expect(dispatches).toHaveLength(0);
    // The live run's owner is not displaced by the refused click.
    expect(row(id)?.approval_requested_by).toBe(secondAdminId);
  });

  test("a person's own terminal run blocks the web: approving, fresh updated_at, no dispatch", async () => {
    // A direct CLI approval never sets approval_dispatched_at. Without the
    // second clause of the predicate the web would start a second run beside it.
    const id = seedRequest({ status: "approving", updatedAt: "-1 minutes" });
    expect(row(id)?.approval_dispatched_at).toBeNull();

    const res = await dispatchWith(ADMIN_KEY);

    expect(res.status).toBe(409);
    expect((await errorBody(res)).error).toBe("already_in_flight");
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.approval_requested_by).toBeNull();
  });

  test("the same terminal-run row, quiet for 20 minutes, is released and may be dispatched", async () => {
    const id = seedRequest({ status: "approving", updatedAt: "-20 minutes" });
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(202);
    expect(row(id)?.approval_requested_by).toBe(adminId);
    expect(dispatches).toHaveLength(1);
  });

  test("a dispatch that never started is released once it is older than the lease", async () => {
    const id = seedRequest({ dispatchedAt: "-20 minutes", requestedBy: secondAdminId });
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(202);
    // The new click owns the run: each dispatch records who launched it.
    expect(row(id)?.approval_requested_by).toBe(adminId);
  });

  test("two simultaneous clicks dispatch exactly once", async () => {
    // The claim is one conditional UPDATE, so it is atomic where a read-then-
    // write would let both through. Different admins, so the winner is visible.
    const id = seedRequest();
    const [a, b] = await Promise.all([dispatchWith(ADMIN_KEY), dispatchWith(SECOND_ADMIN_KEY)]);

    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect(dispatches).toHaveLength(1);
    const winner = a.status === 202 ? adminId : secondAdminId;
    expect(row(id)?.approval_requested_by).toBe(winner);
  });
});

describe("a request that cannot be dispatched", () => {
  test("no request for the dataset: 404 not_found", async () => {
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).error).toBe("not_found");
    expect(dispatches).toHaveLength(0);
  });

  test.each(["published", "denied"])("a %s request is not active: 404", async (status) => {
    seedRequest({ status });
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(404);
    expect(dispatches).toHaveLength(0);
  });

  test("a blocked request: 409 not_dispatchable, nothing claimed", async () => {
    const id = seedRequest({ status: "blocked" });
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(409);
    expect((await errorBody(res)).error).toBe("not_dispatchable");
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.approval_requested_by).toBeNull();
    expect(row(id)?.approval_dispatched_at).toBeNull();
  });

  test("acts on the SAME request /approve would: the newest active one", async () => {
    // An older `requested` row sits behind a newer `blocked` one. The executor's
    // /approve call picks the newest, so the dispatch must judge that one, not
    // reach past it to the older row.
    const older = seedRequest({ requestedAt: "-5 hours" });
    seedRequest({ status: "blocked", requestedAt: "-1 hours" });
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(409);
    expect((await errorBody(res)).error).toBe("not_dispatchable");
    expect(row(older)?.approval_requested_by).toBeNull();
  });

  test("claims the newest active request when several exist", async () => {
    seedRequest({ requestedAt: "-5 hours" });
    const newer = seedRequest({ requestedAt: "-1 hours" });
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { request_id: number }).request_id).toBe(newer);
  });
});

describe("when GitHub refuses the dispatch", () => {
  test("502 dispatch_failed, the claim released, and a retry then succeeds", async () => {
    const id = seedRequest();
    githubStatus = 422;
    const failed = await dispatchWith(ADMIN_KEY);

    expect(failed.status).toBe(502);
    const body = await errorBody(failed);
    expect(body.error).toBe("dispatch_failed");
    // The page shows `message`; it must not carry GitHub's body or the token.
    expect(body.message).not.toContain("refused");
    expect(body.message).not.toContain("ghp_");
    expect(row(id)?.approval_requested_by).toBeNull();
    expect(row(id)?.approval_dispatched_at).toBeNull();

    githubStatus = 204;
    const retried = await dispatchWith(ADMIN_KEY);
    expect(retried.status).toBe(202);
  });

  test("a failed dispatch on an approving row does not make it read as in flight", async () => {
    // updated_at is the heartbeat the second clause reads. A claim that bumped
    // it would leave this row "running" for the whole lease after a failure.
    const id = seedRequest({ status: "approving", updatedAt: "-20 minutes" });
    const before = row(id)?.updated_at;
    githubStatus = 500;
    expect((await dispatchWith(ADMIN_KEY)).status).toBe(502);
    expect(row(id)?.updated_at).toBe(before ?? "");

    githubStatus = 204;
    expect((await dispatchWith(ADMIN_KEY)).status).toBe(202);
  });

  test("no GitHub credential configured is the same refusal, with the claim released", async () => {
    const id = seedRequest();
    envOverrides = { GITHUB_ADMIN_PAT: undefined };
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(502);
    expect((await errorBody(res)).error).toBe("dispatch_failed");
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.approval_requested_by).toBeNull();
  });

  test("a failed audit write does not report the launch as failed", async () => {
    // The run is already dispatched; losing the audit row must not turn a real
    // launch into an error the admin would answer by clicking again.
    const id = seedRequest();
    db.run("DROP TABLE audit_log");
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(202);
    expect(dispatches).toHaveLength(1);
    expect(row(id)?.approval_requested_by).toBe(adminId);
  });
});

describe("who may dispatch", () => {
  test("a member is refused with 403 before anything is claimed or sent", async () => {
    const id = seedRequest();
    const res = await dispatchWith(MEMBER_KEY);
    expect(res.status).toBe(403);
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.approval_requested_by).toBeNull();
  });

  test("an unauthenticated caller is refused with 401", async () => {
    seedRequest();
    const res = await app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      { method: "POST" },
      env(),
    );
    expect(res.status).toBe(401);
    expect(dispatches).toHaveLength(0);
  });

  test("an admin on a web session cookie, which is how the website calls it, is the clicker", async () => {
    // The website authenticates with the nemar_session cookie, the executor
    // with an API key. Both must reach this route, and the clicker recorded is
    // the cookie's account.
    const id = seedRequest();
    const { cookieIdRaw } = await issueSession(
      env(),
      secondAdminId,
      false,
      "test-agent",
      "127.0.0.1",
      "orcid",
    );
    const res = await app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      {
        method: "POST",
        headers: { Cookie: `nemar_session=${cookieIdRaw}`, Origin: APP_ORIGIN },
      },
      env(),
    );
    expect(res.status).toBe(202);
    expect(row(id)?.approval_requested_by).toBe(secondAdminId);
  });
});
