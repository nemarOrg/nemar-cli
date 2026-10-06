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
 *
 * Every seeded request carries a clean identifier screen of the commit the
 * stand-in reports as `main` (epic #1610 phase 4), whose one read the stand-in
 * answers without recording it as a dispatch; the screen gate on this route is
 * pinned in identifier-screen-gate.test.ts.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1, yieldingD1 } from "./helpers/d1";
import { SCREENED_HEAD, mainRefAnswer, markScreen } from "./helpers/identifier-screen";

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
let memberId: number;
let envOverrides: Partial<Bindings> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      // The identifier screen gate's read of `main` is not a dispatch, and it
      // answers whatever `githubStatus` a case sets for the dispatch itself.
      const ref = mainRefAnswer(request);
      if (ref) return ref;
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
  /** A recorded step failure from an earlier attempt. */
  lastError?: string;
  /** Requested time, to order several requests for one dataset. */
  requestedAt?: string;
  dataset?: string;
}

function seedRequest(seed: Seed = {}): number {
  const modifier = (m: string | undefined) => (m ? `datetime('now', '${m}')` : "NULL");
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at,
        approval_requested_by, approval_dispatched_at, last_error)
     VALUES (?, ?, ?, ${seed.requestedAt ? `datetime('now', '${seed.requestedAt}')` : "datetime('now', '-3 hours')"},
             ${seed.updatedAt ? modifier(seed.updatedAt) : "datetime('now', '-3 hours')"},
             ${seed.requestedBy ?? "NULL"}, ${modifier(seed.dispatchedAt)}, ?)`,
    [seed.dataset ?? DATASET, seed.status ?? "requested", adminId, seed.lastError ?? null],
  );
  const id = db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
  markScreen(db, id, seed.dataset ?? DATASET);
  return id;
}

function row(id: number) {
  return db
    .query<
      {
        status: string;
        approval_requested_by: number | null;
        approval_dispatched_at: string | null;
        updated_at: string;
        last_error: string | null;
      },
      [number]
    >(
      "SELECT status, approval_requested_by, approval_dispatched_at, updated_at, last_error FROM publication_requests WHERE id = ?",
    )
    .get(id);
}

function dispatchWith(
  key: string,
  dataset = DATASET,
  bindings: Bindings = env(),
): Promise<Response> {
  return app.request(
    `/admin/publish/${dataset}/approve-dispatch`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "X-CLI-Version": "99.0.0" },
    },
    bindings,
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
  memberId = await seedUser("dispatchmember", "member", MEMBER_KEY);
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
    //
    // `realD1` runs each statement synchronously, so on its own the two requests
    // would simply run one after the other and a NON-atomic claim would pass.
    // Real D1 is a network round trip per statement, so concurrent requests
    // interleave between a route's statements; `yieldingD1` puts that gap back
    // and is what makes this test able to fail.
    const id = seedRequest();
    const bindings = { ...env(), DB: yieldingD1(realD1(db)) } as Bindings;
    const [a, b] = await Promise.all([
      dispatchWith(ADMIN_KEY, DATASET, bindings),
      dispatchWith(SECOND_ADMIN_KEY, DATASET, bindings),
    ]);

    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect(dispatches).toHaveLength(1);
    const winner = a.status === 202 ? adminId : secondAdminId;
    expect(row(id)?.approval_requested_by).toBe(winner);
  });
});

describe("releasing a claim", () => {
  test("clears only a claim this click made", async () => {
    // The release is conditional on `approval_requested_by` still being the
    // clicker, so a claim some other click made in the meantime is never undone
    // by this click's failure. Another admin's claim is landed on the real row
    // exactly between this click's claim and its release.
    const id = seedRequest();
    githubStatus = 422;
    let landed = false;
    const bindings = {
      ...env(),
      DB: interceptingD1(realD1(db), (sql) => {
        if (!landed && sql.includes("SET approval_requested_by = NULL")) {
          landed = true;
          db.run("UPDATE publication_requests SET approval_requested_by = ? WHERE id = ?", [
            secondAdminId,
            id,
          ]);
        }
      }),
    } as Bindings;

    const res = await dispatchWith(ADMIN_KEY, DATASET, bindings);
    expect(res.status).toBe(502);
    expect(landed).toBe(true);
    // The other admin's claim stands; this click's failure did not undo it.
    expect(row(id)?.approval_requested_by).toBe(secondAdminId);
    expect(row(id)?.approval_dispatched_at).not.toBeNull();
  });

  test("restores the cleared error only while no run has begun since the claim", async () => {
    // The claim clears `last_error`; a not-sent release puts it back. But
    // `/approve` bumps `updated_at` as it starts, so a changed `updated_at`
    // means a run (a person's terminal) began between the claim and the
    // release. Writing the old error back over its fresh state would make that
    // live run read as failed after the grace window.
    const id = seedRequest({ status: "approving", updatedAt: "-20 minutes", lastError: "boom" });
    githubStatus = 422;
    let landed = false;
    const bindings = {
      ...env(),
      DB: interceptingD1(realD1(db), (sql) => {
        if (!landed && sql.includes("SET approval_requested_by = NULL")) {
          landed = true;
          // What `/approve` does as it starts: a fresh heartbeat, error cleared.
          db.run(
            "UPDATE publication_requests SET updated_at = datetime('now', '+5 seconds'), last_error = NULL WHERE id = ?",
            [id],
          );
        }
      }),
    } as Bindings;

    const res = await dispatchWith(ADMIN_KEY, DATASET, bindings);
    expect(res.status).toBe(502);
    expect(landed).toBe(true);
    // The claim is released, but the stale error is not written back.
    expect(row(id)?.approval_requested_by).toBeNull();
    expect(row(id)?.approval_dispatched_at).toBeNull();
    expect(row(id)?.last_error).toBeNull();
  });
});

describe("a run that failed", () => {
  // The orchestrator records a failed step in last_error and answers 500. Once
  // the grace window after that failure has passed, the run is stalled and the
  // page can offer Resume. (Inside the window the CLI's own retry is about to
  // start; approval-in-flight.test.ts pins that.)
  test("is dispatchable again, resuming, and the dispatch clears the old error", async () => {
    const id = seedRequest({
      status: "approving",
      lastError: "EZID 503",
      updatedAt: "-5 minutes",
    });
    const res = await dispatchWith(ADMIN_KEY);

    expect(res.status).toBe(202);
    expect(((await res.json()) as { resume: boolean }).resume).toBe(true);
    expect(dispatches[0].body.client_payload).toMatchObject({ request_id: id, resume: true });
    // A new attempt begins: the previous attempt's error is history.
    expect(row(id)?.last_error).toBeNull();
  });

  test("and the run it launched is then in flight, so a second click is refused", async () => {
    // With the old error cleared and a fresh dispatch, nothing reads as failed.
    // Left in place, the claim would make the new run look failed and let this
    // second click start a second run.
    seedRequest({ status: "approving", lastError: "EZID 503", updatedAt: "-5 minutes" });
    expect((await dispatchWith(ADMIN_KEY)).status).toBe(202);
    const again = await dispatchWith(SECOND_ADMIN_KEY);
    expect(again.status).toBe(409);
    expect((await errorBody(again)).error).toBe("already_in_flight");
    expect(dispatches).toHaveLength(1);
  });

  test("a failure seconds old is not dispatchable: the CLI's retry is about to start", async () => {
    const id = seedRequest({
      status: "approving",
      lastError: "EZID 503",
      updatedAt: "-10 seconds",
    });
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(409);
    expect((await errorBody(res)).error).toBe("already_in_flight");
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.last_error).toBe("EZID 503");
  });

  test("a dispatch that is NOT sent puts the error back, as if nothing had happened", async () => {
    const id = seedRequest({
      status: "approving",
      lastError: "EZID 503",
      updatedAt: "-5 minutes",
    });
    githubStatus = 422;
    expect((await dispatchWith(ADMIN_KEY)).status).toBe(502);
    expect(row(id)?.last_error).toBe("EZID 503");
    expect(row(id)?.approval_requested_by).toBeNull();
    expect(row(id)?.approval_dispatched_at).toBeNull();
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

describe("a request that changes between the route's read and its claim", () => {
  // The route reads the request, then claims it with a conditional UPDATE. Land
  // another writer exactly between the two (through the real database, so the
  // interleaving is real and only deterministic) and check the answer reflects
  // what the request is NOW, not a blanket "already running".
  function bindingsThatChangeTheRequestBeforeTheClaim(newStatus: string): Bindings {
    let done = false;
    return {
      ...env(),
      DB: interceptingD1(realD1(db), (sql) => {
        if (!done && sql.includes("SET approval_requested_by = ?")) {
          done = true;
          db.run("UPDATE publication_requests SET status = ? WHERE dataset_id = ?", [
            newStatus,
            DATASET,
          ]);
        }
      }),
    } as Bindings;
  }

  test("published in between: 404 not_found, not a run that does not exist", async () => {
    const id = seedRequest();
    const res = await dispatchWith(
      ADMIN_KEY,
      DATASET,
      bindingsThatChangeTheRequestBeforeTheClaim("published"),
    );
    expect(res.status).toBe(404);
    expect((await errorBody(res)).error).toBe("not_found");
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.approval_requested_by).toBeNull();
  });

  test("denied in between: 404 not_found", async () => {
    seedRequest();
    const res = await dispatchWith(
      ADMIN_KEY,
      DATASET,
      bindingsThatChangeTheRequestBeforeTheClaim("denied"),
    );
    expect(res.status).toBe(404);
    expect((await errorBody(res)).error).toBe("not_found");
  });

  test("blocked in between: 409 not_dispatchable", async () => {
    const id = seedRequest();
    const res = await dispatchWith(
      ADMIN_KEY,
      DATASET,
      bindingsThatChangeTheRequestBeforeTheClaim("blocked"),
    );
    expect(res.status).toBe(409);
    expect((await errorBody(res)).error).toBe("not_dispatchable");
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.approval_requested_by).toBeNull();
  });

  test("still requested and genuinely in flight: 409 already_in_flight", async () => {
    // The ordinary refusal is unchanged: the re-read finds a request that can
    // still run, so the answer is the lease's.
    seedRequest({ dispatchedAt: "-1 minutes", requestedBy: secondAdminId });
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(409);
    expect((await errorBody(res)).error).toBe("already_in_flight");
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
    githubStatus = 422;
    expect((await dispatchWith(ADMIN_KEY)).status).toBe(502);
    expect(row(id)?.updated_at).toBe(before ?? "");

    githubStatus = 204;
    expect((await dispatchWith(ADMIN_KEY)).status).toBe(202);
  });

  test("every 4xx is a refusal GitHub made before creating an event: released, retry succeeds", async () => {
    // 401 (bad token), 404 (no repository) and 429 (rate limited) are all
    // answered before any event exists, so nothing can be running.
    for (const status of [401, 404, 429]) {
      const id = seedRequest({ dataset: `nm09876${status % 10}` });
      githubStatus = status;
      const failed = await dispatchWith(ADMIN_KEY, `nm09876${status % 10}`);
      expect(failed.status).toBe(502);
      expect((await errorBody(failed)).error).toBe("dispatch_failed");
      expect(row(id)?.approval_requested_by).toBeNull();
      expect(row(id)?.approval_dispatched_at).toBeNull();
    }
  });

  describe("a 5xx answer is not a refusal", () => {
    // GitHub's edge can answer 502, 503 or 504 AFTER it queued the event: the
    // same lost-answer case as a dropped connection. Releasing the claim then
    // would let the next click start a second run beside the first, so the lease
    // is kept and the admin is told the run may have started.
    for (const status of [500, 502, 503, 504]) {
      test(`${status}: dispatch_unconfirmed, the lease kept, a second click refused`, async () => {
        const id = seedRequest();
        githubStatus = status;
        const res = await dispatchWith(ADMIN_KEY);

        expect(res.status).toBe(502);
        const body = await errorBody(res);
        expect(body.error).toBe("dispatch_unconfirmed");
        // The page shows `message`; GitHub's body must not reach it.
        expect(body.message).not.toContain("refused");
        expect(row(id)?.approval_requested_by).toBe(adminId);
        expect(row(id)?.approval_dispatched_at).not.toBeNull();

        githubStatus = 204;
        const again = await dispatchWith(SECOND_ADMIN_KEY);
        expect(again.status).toBe(409);
        expect((await errorBody(again)).error).toBe("already_in_flight");
        // Only the first click ever reached GitHub.
        expect(dispatches).toHaveLength(1);

        // The run that may exist is on record, with the status and nothing else
        // of GitHub's answer, and the launch audit row is not written.
        const rows = db
          .query<{ user_id: number; details: string }, []>(
            "SELECT user_id, details FROM audit_log WHERE action = 'approval_dispatch_unconfirmed'",
          )
          .all();
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBe(adminId);
        expect(JSON.parse(rows[0].details)).toEqual({
          request_id: id,
          resume: false,
          environment: "dev",
          reason: `http_${status}`,
        });
        expect(
          db
            .query<{ n: number }, []>(
              "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'approval_dispatched'",
            )
            .get()?.n,
        ).toBe(0);
      });
    }
  });

  test("no GitHub credential configured: 502 dispatch_unconfigured, retrying will not help, claim released", async () => {
    const id = seedRequest();
    envOverrides = { GITHUB_ADMIN_PAT: undefined };
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(502);
    const body = await errorBody(res);
    expect(body.error).toBe("dispatch_unconfigured");
    // The admin must be told not to retry: the fault is the server's, not theirs.
    expect(body.message).toContain("Retrying will not help");
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.approval_requested_by).toBeNull();
    expect(row(id)?.approval_dispatched_at).toBeNull();
  });

  test("a GitHub App token that cannot be minted is an ordinary failed dispatch, claim released", async () => {
    // Credentials ARE configured (so not dispatch_unconfigured), but minting the
    // installation token fails before anything is sent.
    const id = seedRequest();
    envOverrides = {
      GITHUB_ADMIN_PAT: undefined,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "not a private key",
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "42",
    };
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

describe("when GitHub's answer is lost", () => {
  // GitHub may have ACCEPTED the dispatch and lost only the reply. Releasing the
  // claim then would let the next click start a second run beside the first, so
  // an unknown outcome keeps the lease. It lapses on its own if nothing started.
  let dropper: ReturnType<typeof Bun.listen>;

  beforeAll(() => {
    // Accepts the TCP connection and closes it without a response, except for
    // the identifier screen gate's read of `main` (epic #1610 phase 4), which
    // it answers so the case reaches the dispatch whose answer is lost.
    dropper = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          const head = new TextDecoder().decode(data).split("\r\n")[0] ?? "";
          if (/^GET \/repos\/nemarDatasets\/[^/]+\/git\/ref\/heads\/main /.test(head)) {
            const body = JSON.stringify({ object: { sha: SCREENED_HEAD } });
            socket.write(
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
            );
          }
          socket.end();
        },
      },
    });
  });

  afterAll(() => {
    dropper.stop(true);
  });

  function pointGithubAt(port: number): void {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
      `http://127.0.0.1:${port}`;
  }

  afterEach(() => {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
      `http://127.0.0.1:${server.port}`;
  });

  test("a dropped connection: 502 dispatch_unconfirmed, the lease kept, and a second click is refused", async () => {
    const id = seedRequest();
    pointGithubAt(dropper.port);

    const res = await dispatchWith(ADMIN_KEY);
    expect(res.status).toBe(502);
    const body = await errorBody(res);
    expect(body.error).toBe("dispatch_unconfirmed");
    expect(body.message).toBe(
      "GitHub did not confirm the request. It may have started; check again in a few minutes before trying again.",
    );

    // The claim stands: it may be the only record that a run started.
    expect(row(id)?.approval_requested_by).toBe(adminId);
    expect(row(id)?.approval_dispatched_at).not.toBeNull();

    // And the audit log says a run may exist, with no HTTP status to give.
    const audit = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'approval_dispatch_unconfirmed'",
      )
      .get();
    expect(JSON.parse(audit?.details ?? "{}")).toEqual({
      request_id: id,
      resume: false,
      environment: "dev",
      reason: "no_answer",
    });

    // So a second click is held off by the lease, not allowed to start a second run.
    pointGithubAt(server.port);
    const again = await dispatchWith(SECOND_ADMIN_KEY);
    expect(again.status).toBe(409);
    expect((await errorBody(again)).error).toBe("already_in_flight");
    expect(dispatches).toHaveLength(0);
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

  async function cookieFor(userId: number): Promise<string> {
    const { cookieIdRaw } = await issueSession(
      env(),
      userId,
      false,
      "test-agent",
      "127.0.0.1",
      "orcid",
    );
    return `nemar_session=${cookieIdRaw}`;
  }

  function dispatchWithCookie(cookie: string, origin?: string): Promise<Response> {
    return app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      {
        method: "POST",
        headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
      },
      env(),
    );
  }

  test("a cookie request from a foreign origin is refused 403 origin_not_allowed, and nothing is claimed", async () => {
    // A cookie rides along with any cross-site request a browser can be tricked
    // into making, and this route launches an irreversible publication.
    const id = seedRequest();
    const res = await dispatchWithCookie(await cookieFor(adminId), "https://evil.example");
    expect(res.status).toBe(403);
    expect((await errorBody(res)).error).toBe("origin_not_allowed");
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.approval_requested_by).toBeNull();
    expect(row(id)?.approval_dispatched_at).toBeNull();
  });

  test("a cookie request with no Origin at all is refused too", async () => {
    const id = seedRequest();
    const res = await dispatchWithCookie(await cookieFor(adminId));
    expect(res.status).toBe(403);
    expect((await errorBody(res)).error).toBe("origin_not_allowed");
    expect(row(id)?.approval_requested_by).toBeNull();
  });

  test("a cookie request from the app origin is accepted", async () => {
    const id = seedRequest();
    const res = await dispatchWithCookie(await cookieFor(adminId), APP_ORIGIN);
    expect(res.status).toBe(202);
    expect(row(id)?.approval_requested_by).toBe(adminId);
  });

  test("a bearer key with no Origin is unaffected: a terminal and a workflow send none", async () => {
    seedRequest();
    const res = await dispatchWith(ADMIN_KEY);
    expect(res.headers.get("content-type")).toContain("json");
    expect(res.status).toBe(202);
  });

  test("a member's cookie from the app origin is 403 (admin only), with nothing claimed", async () => {
    const id = seedRequest();
    const res = await dispatchWithCookie(await cookieFor(memberId), APP_ORIGIN);
    expect(res.status).toBe(403);
    expect(dispatches).toHaveLength(0);
    expect(row(id)?.approval_requested_by).toBeNull();
  });

  // The host-scoped sessions (docs, ADR 0056; private, ADR 0079) are credentials
  // for another host. Each reader names the scope it wants, so an admin's docs or
  // private session must open neither the irreversible route nor the list.
  for (const scope of ["docs", "private"] as const) {
    test(`an admin's ${scope}-scope session authenticates nothing here: 401, nothing claimed or listed`, async () => {
      const id = seedRequest();
      const cookie = await cookieFor(adminId);
      db.run("UPDATE web_sessions SET scope = ? WHERE user_id = ?", [scope, adminId]);

      const dispatch = await dispatchWithCookie(cookie, APP_ORIGIN);
      expect(dispatch.status).toBe(401);
      expect(dispatches).toHaveLength(0);
      expect(row(id)?.approval_requested_by).toBeNull();
      expect(row(id)?.approval_dispatched_at).toBeNull();

      const list = await app.request(
        "/admin/publish/requests",
        { method: "GET", headers: { Cookie: cookie } },
        env(),
      );
      expect(list.status).toBe(401);
    });
  }
});
