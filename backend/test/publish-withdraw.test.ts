/**
 * POST /datasets/:id/publish/withdraw: the depositor takes their own publication
 * request back, with no administrator involved.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the
 * real auth middleware, and the real routes through Hono's `app.request()`.
 * Ages are set with SQLite's own `datetime('now', '-N minutes')`, well clear of
 * the 15-minute approval lease edge, so no clock is faked.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "withdraw-owner-key-0123456789abcdef0123456789abcdef";
const OTHER_KEY = "withdraw-other-key-0123456789abcdef0123456789abcdef";
const ADMIN_KEY = "withdraw-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000490";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;
let ownerId: number;

async function addUser(username: string, role: string, key: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('${username}', '${username}@example.org', 'x', 'approved', '${role}', 1)`,
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return id;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  app.route("/admin", adminRoutes);
  env = { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
  ownerId = await addUser("wdowner", "member", OWNER_KEY);
  await addUser("wdother", "member", OTHER_KEY);
  await addUser("wdadmin", "admin", ADMIN_KEY);
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
     VALUES ('${DATASET}', 'Withdraw me', ${ownerId}, 'nemarDatasets/${DATASET}', 'private')`,
  );
});

function seedRequest(
  status: string,
  extra: { dispatchedAt?: string; ageMinutes?: number } = {},
): number {
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at, approval_dispatched_at)
     VALUES ('${DATASET}', '${status}', ${ownerId}, datetime('now', '-3 hours'),
             datetime('now', '-${extra.ageMinutes ?? 180} minutes'),
             ${extra.dispatchedAt ? `datetime('now', '${extra.dispatchedAt}')` : "NULL"})`,
  );
  return db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
}

function row(id: number) {
  return db
    .query<
      {
        status: string;
        withdrawn_at: string | null;
        denied_by: number | null;
        denied_reason: string | null;
      },
      [number]
    >(
      "SELECT status, withdrawn_at, denied_by, denied_reason FROM publication_requests WHERE id = ?",
    )
    .get(id) as {
    status: string;
    withdrawn_at: string | null;
    denied_by: number | null;
    denied_reason: string | null;
  };
}

function withdraw(key = OWNER_KEY, dataset = DATASET): Promise<Response> {
  return app.request(
    `/datasets/${dataset}/publish/withdraw`,
    { method: "POST", headers: { Authorization: `Bearer ${key}`, "X-CLI-Version": "99.0.0" } },
    env,
  );
}

describe("a request nobody has acted on", () => {
  for (const status of ["requested", "blocked"]) {
    test(`a ${status} request is withdrawn by its owner`, async () => {
      const id = seedRequest(status);
      const res = await withdraw();
      expect(res.status).toBe(200);
      const r = row(id);
      expect(r.status).toBe("denied");
      expect(r.withdrawn_at).not.toBeNull();
      // The requester's own act: no administrator and no reason are recorded.
      expect(r.denied_by).toBeNull();
      expect(r.denied_reason).toBeNull();
    });
  }

  test("a stale dispatch (lease lapsed, nothing followed) does not block a withdrawal", async () => {
    const id = seedRequest("requested", { dispatchedAt: "-16 minutes" });
    expect((await withdraw()).status).toBe(200);
    expect(row(id).withdrawn_at).not.toBeNull();
  });

  test("withdrawing twice is a 404 the second time, not a second write", async () => {
    seedRequest("requested");
    expect((await withdraw()).status).toBe(200);
    expect((await withdraw()).status).toBe(404);
  });

  test("a withdrawn request is not active: an admin cannot approve it", async () => {
    seedRequest("requested");
    await withdraw();
    const res = await app.request(
      `/admin/publish/${DATASET}/approve`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("a request an administrator has started on", () => {
  test("an approving request is refused with 409 and left alone", async () => {
    const id = seedRequest("approving", { ageMinutes: 1 });
    const res = await withdraw();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("withdraw_too_late");
    expect(row(id)).toMatchObject({ status: "approving", withdrawn_at: null });
  });

  test("a dispatched approval still inside its lease is refused with 409", async () => {
    const id = seedRequest("requested", { dispatchedAt: "-5 minutes" });
    expect((await withdraw()).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "requested", withdrawn_at: null });
  });

  test("a published request cannot be withdrawn", async () => {
    const id = seedRequest("published");
    expect((await withdraw()).status).toBe(404);
    expect(row(id)).toMatchObject({ status: "published", withdrawn_at: null });
  });
});

describe("who may withdraw", () => {
  test("another user is refused", async () => {
    const id = seedRequest("requested");
    expect((await withdraw(OTHER_KEY)).status).toBe(403);
    expect(row(id).withdrawn_at).toBeNull();
  });

  test("an administrator who is not the owner is refused and pointed at deny", async () => {
    const id = seedRequest("requested");
    const res = await withdraw(ADMIN_KEY);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("publish deny");
    expect(row(id).withdrawn_at).toBeNull();
  });

  test("an unknown dataset is a 404", async () => {
    expect((await withdraw(OWNER_KEY, "nm000491")).status).toBe(404);
  });

  test("no key is a 401", async () => {
    seedRequest("requested");
    const res = await app.request(`/datasets/${DATASET}/publish/withdraw`, { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  test("a dataset with no request at all is a 404", async () => {
    expect((await withdraw()).status).toBe(404);
  });
});

describe("how a withdrawal reads afterwards", () => {
  test("status stays denied for older clients and says withdrawn", async () => {
    seedRequest("requested");
    await withdraw();
    const res = await app.request(
      `/datasets/${DATASET}/publish/status`,
      { headers: { Authorization: `Bearer ${OWNER_KEY}`, "X-CLI-Version": "99.0.0" } },
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("denied");
    expect(body.withdrawn).toBe(true);
    expect(body.withdrawn_at).toBeTruthy();
    expect(body.denied_reason).toBeNull();
  });

  test("an administrator's denial is not reported as withdrawn", async () => {
    seedRequest("requested");
    const denied = await app.request(
      `/admin/publish/${DATASET}/deny`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "incomplete" }),
      },
      env,
    );
    expect(denied.status).toBe(200);
    const res = await app.request(
      `/datasets/${DATASET}/publish/status`,
      { headers: { Authorization: `Bearer ${OWNER_KEY}`, "X-CLI-Version": "99.0.0" } },
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.withdrawn).toBe(false);
    expect(body.denied_reason).toBe("incomplete");
  });

  test("the admin list carries withdrawn_at, and a denied-only filter includes it", async () => {
    seedRequest("requested");
    await withdraw();
    const res = await app.request(
      "/admin/publish/requests?status=denied",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}`, "X-CLI-Version": "99.0.0" } },
      env,
    );
    const body = (await res.json()) as {
      requests: Array<{ dataset_id: string; status: string; withdrawn_at: string | null }>;
    };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ dataset_id: DATASET, status: "denied" });
    expect(body.requests[0].withdrawn_at).toBeTruthy();
  });
});
