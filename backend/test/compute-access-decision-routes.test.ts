/**
 * The administrator's compute-access routes (epic #2021 phase D1, #2022; ADR 0118, the compute-access
 * addendum): list, grant, deny, suspend and revoke, each by username and by id, through the REAL admin
 * router and its middleware (`app.fetch`) over a real migrated database (bun:sqlite behind `realD1`),
 * with real hashed API keys. No mocks. Resend is a local server, so the decision mail is the real one.
 *
 * What is pinned, each with a test of its own:
 *  - who may do what: no key is 401, a member is 403, an admin decides; the by-id twins work for an
 *    account with no username (a web sign-up) and refuse a malformed id;
 *  - the state machine over the wire: a grant from `none` is 409 `not_requested`, from `active` 409
 *    `already_active`; a deny from anything but `requested` is `not_requested`; a suspend or a revoke of
 *    an account that does not hold access is `not_active`; a body that is not valid is a 400 naming the
 *    fields and never echoing a value, and writes nothing;
 *  - a grant opens the owner's default allocation EXACTLY ONCE across grant, suspend, grant (an
 *    idempotency key per account and pool); a zero default grants nothing and the response says so; a
 *    partial default grants the pool it names; an unreadable policy fails closed (503, nothing written);
 *  - a grant is refused for an account that is not in good standing, so lifting a compute suspension can
 *    never lift the freeze an ACCOUNT revocation put on its pools; a grant from `revoked` or `denied`
 *    (admin only) works and unfreezes;
 *  - a suspension and a revocation freeze the account's pools, end a held job's compute, and leave
 *    another account's pools alone (the jobs and the batch's atomicity are in
 *    `compute-access-cascade.test.ts`);
 *  - every decision is audited with the actor, the states and the reason, and the person is mailed after
 *    the commit (the reason is NOT in the mail); a send that fails leaves the decision standing;
 *  - none of it reads or writes `service_access`, and none of it reads the compute switch.
 *
 * MUTATIONS, each run alone (the results are in the PR): change the default grant's key so a re-grant
 * writes again; make the grant skip the standing check; drop the from-states of the grant; drop the
 * unfreeze; drop the state guard on the release statements; drop the audit statement.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_TERMS_VERSION } from "../../shared/contract/compute-terms";
import { DEFAULT_COMPUTE_POLICY } from "../../shared/contract/compute";
import { putPolicy } from "../src/services/compute-policy";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { totalsDisagreements } from "./helpers/compute-ledger";
import { freshDb, realD1 } from "./helpers/d1";
import { sendsTo, withFakeResend } from "./helpers/resend";

const handle = makeComputeApp();
const PERSON_EMAIL = "cmpdecide-person@nemar.test";
const SECRET_REASON = "REASON-MARKER-7741 the export review notes";

let db: Database;
let ids: Record<ComputeWho, number>;
let personId: number;

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    RESEND_API_KEY: "fake-resend-key",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    APP_BASE_URL: "https://app.example.test",
    WEB_SESSION_COOKIE_DOMAIN: "",
    ...over,
  } as unknown as Bindings;
}

interface Seed {
  username?: string | null;
  email?: string;
  status?: string;
  compute_access?: string;
  deleted_at?: string | null;
  account_kind?: string;
}

/** A person at `compute_access` (requested by default), with a purpose and the stamps a request leaves. */
function seedPerson(o: Seed = {}): number {
  const state = o.compute_access ?? "requested";
  const n = (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified,
                        given_name, family_name, affiliation, city, country, account_kind,
                        compute_access, compute_access_requested_at, compute_purpose,
                        compute_terms_version, compute_terms_accepted_at, deleted_at)
     VALUES (?, ?, 'x', ?, 'member', 'web', 1, 'Ada', 'Rivers', 'Swartz Center', 'San Diego', 'USA', ?,
             ?, ?, ?, ?, ?, ?)`,
    [
      o.username === undefined ? `person${n}` : o.username,
      o.email ?? `cmpdecide-p${n}@nemar.test`,
      o.status ?? "verified",
      o.account_kind ?? "person",
      state,
      state === "none" ? null : "2026-11-01 00:00:00",
      state === "none"
        ? null
        : "Run ICA decompositions on public EEG datasets for a methods paper.",
      state === "none" ? null : COMPUTE_TERMS_VERSION,
      state === "none" ? null : "2026-11-01 00:00:00",
      o.deleted_at ?? null,
    ],
  );
  const row = db.query("SELECT id FROM users ORDER BY id DESC LIMIT 1").get() as { id: number };
  return row.id;
}

async function setDefault(cpu: number, gpu: number): Promise<void> {
  const r = await putPolicy(
    realD1(db),
    ids.owner,
    { ...DEFAULT_COMPUTE_POLICY, defaultGrantMilli: { cpu, gpu } },
    "test",
  );
  if (!r.ok) throw new Error("could not set the policy");
}

interface Called {
  status: number;
  body: Record<string, any>;
  text: string;
}

async function call(
  who: ComputeWho | null,
  method: string,
  path: string,
  o: { body?: unknown; raw?: string; env?: Bindings } = {},
): Promise<Called> {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  if (o.body !== undefined || o.raw !== undefined) headers["Content-Type"] = "application/json";
  const res = await handle(
    new Request(`http://api.test/admin/compute/access${path}`, {
      method,
      headers,
      body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
    }),
    o.env ?? env(),
  );
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, text };
}

const decide = (
  decision: string,
  who: ComputeWho | null,
  target: string | number,
  body?: unknown,
) =>
  call(
    who,
    "POST",
    typeof target === "number" ? `/${decision}/by-id/${target}` : `/${decision}/${target}`,
    {
      body,
    },
  );

const row = (id = personId) =>
  db.query("SELECT * FROM users WHERE id = ?").get(id) as Record<string, any>;
const pools = (id = personId) =>
  db
    .query(
      "SELECT pool, granted_milli, held_milli, charged_milli, frozen FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ? ORDER BY pool",
    )
    .all(String(id)) as Array<Record<string, number | string>>;
const ledger = (id = personId) =>
  db
    .query(
      `SELECT l.kind, l.reason, l.granted_delta_milli, l.actor_user_id, l.idempotency_key, p.pool
         FROM compute_ledger l JOIN compute_pools p ON p.id = l.pool_id
        WHERE p.holder_kind = 'account' AND p.holder_ref = ? ORDER BY l.id`,
    )
    .all(String(id)) as Array<Record<string, any>>;
const audits = (action: string) =>
  db.query("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action) as Array<{
    user_id: number | null;
    resource_id: string | null;
    details: string | null;
  }>;

beforeEach(async () => {
  db = freshDb();
  ids = await seedComputeUsers(db);
  personId = seedPerson({ email: PERSON_EMAIL });
});

describe("who may do what", () => {
  test("no key is a 401 and a member is a 403, on the list and on all eight decision routes", async () => {
    for (const who of [null, "member"] as const) {
      const expected = who === null ? 401 : 403;
      expect([who, (await call(who, "GET", "")).status]).toEqual([who, expected]);
      for (const decision of ["grant", "deny", "suspend", "revoke"]) {
        expect([who, decision, (await decide(decision, who, "person1")).status]).toEqual([
          who,
          decision,
          expected,
        ]);
        expect([who, decision, (await decide(decision, who, personId)).status]).toEqual([
          who,
          decision,
          expected,
        ]);
      }
    }
    expect(row().compute_access).toBe("requested");
  });

  test("an administrator, not only an owner, decides", async () => {
    const res = await withFakeResend(() => decide("deny", "admin", personId));
    expect(res.status).toBe(200);
    expect(row().compute_access).toBe("denied");
  });

  test("the by-id twins reach an account with no username; the username routes cannot", async () => {
    const web = seedPerson({ username: null, email: "cmpdecide-web@nemar.test" });
    expect(row(web).username).toBeNull();
    const res = await withFakeResend(() => decide("grant", "admin", web));
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ id: web, username: null, compute_access: "active" });
    // A name nobody has is a 404, not a crash.
    expect((await decide("grant", "admin", "nobody-by-that-name")).status).toBe(404);
  });

  test("every decision by username reaches the same implementation as by id", async () => {
    const username = row().username as string;
    const res = await withFakeResend(() => decide("grant", "admin", username));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: "grant", from: "requested", to: "active" });
    expect(res.body.account.id).toBe(personId);
  });

  test("a malformed or unknown id is refused, and a deleted account is not found", async () => {
    for (const bad of ["0", "-1", "abc", "1.5", "01", "9999999999999999"]) {
      const res = await call("admin", "POST", `/grant/by-id/${bad}`);
      expect([bad, res.status, res.body.code]).toEqual([bad, 400, "invalid_query"]);
    }
    expect((await decide("grant", "admin", 987654)).status).toBe(404);
    const deleted = seedPerson({ deleted_at: "2026-11-02 00:00:00" });
    expect((await decide("grant", "admin", deleted)).body.code).toBe("account_not_found");
    expect((await decide("grant", "admin", row(deleted).username as string)).body.code).toBe(
      "account_not_found",
    );
  });
});

describe("the state machine over the wire", () => {
  const cases: Array<[string, string, number, string]> = [
    // [decision, state, status, code]
    ["grant", "none", 409, "not_requested"],
    ["grant", "active", 409, "already_active"],
    ["deny", "none", 409, "not_requested"],
    ["deny", "active", 409, "not_requested"],
    ["deny", "denied", 409, "not_requested"],
    ["deny", "revoked", 409, "not_requested"],
    ["suspend", "none", 409, "not_active"],
    ["suspend", "requested", 409, "not_active"],
    ["suspend", "suspended", 409, "not_active"],
    ["suspend", "denied", 409, "not_active"],
    ["revoke", "none", 409, "not_active"],
    ["revoke", "requested", 409, "not_active"],
    ["revoke", "denied", 409, "not_active"],
    ["revoke", "revoked", 409, "not_active"],
  ];
  for (const [decision, state, status, code] of cases) {
    test(`${decision} from ${state} is ${status} ${code} and writes nothing`, async () => {
      const id = seedPerson({ compute_access: state });
      const before = row(id);
      const res = await decide(decision, "admin", id);
      expect([res.status, res.body.code]).toEqual([status, code]);
      expect(row(id)).toEqual(before);
      expect(audits(`compute_access_${decision}ed`)).toHaveLength(0);
      expect(pools(id)).toEqual([]);
    });
  }

  const allowed: Array<[string, string, string]> = [
    ["grant", "requested", "active"],
    ["grant", "suspended", "active"],
    ["grant", "denied", "active"],
    ["grant", "revoked", "active"],
    ["deny", "requested", "denied"],
    ["suspend", "active", "suspended"],
    ["revoke", "active", "revoked"],
    ["revoke", "suspended", "revoked"],
  ];
  for (const [decision, from, to] of allowed) {
    test(`${decision} from ${from} ends ${to}`, async () => {
      const id = seedPerson({ compute_access: from });
      const res = await withFakeResend(() => decide(decision, "admin", id));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ decision, from, to });
      expect(row(id).compute_access).toBe(to);
    });
  }

  test("a body that is not valid is a 400 that names the field and never echoes a value", async () => {
    for (const body of [{ reason: "x".repeat(501) }, { reason: 7 }, { extra: SECRET_REASON }]) {
      const res = await decide("grant", "admin", personId, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_body");
      expect(res.text).not.toContain("REASON-MARKER");
      expect(res.text).not.toContain("xxxxxxxx");
      expect(res.body.fields.length).toBeGreaterThan(0);
    }
    const notJson = await call("admin", "POST", `/grant/by-id/${personId}`, { raw: "{not json" });
    expect([notJson.status, notJson.body.code]).toEqual([400, "invalid_body"]);
    expect(row().compute_access).toBe("requested");
  });

  test("a body may be empty or carry only a reason of up to 500 characters", async () => {
    const empty = await withFakeResend(() => decide("deny", "admin", personId));
    expect(empty.status).toBe(200);
    const id = seedPerson();
    const full = await withFakeResend(() =>
      decide("deny", "admin", id, { reason: "r".repeat(500) }),
    );
    expect(full.status).toBe(200);
  });
});

describe("the default allocation", () => {
  test("a grant opens the policy's default in each pool, once, with the actor and the fixed reason", async () => {
    await setDefault(10_000, 2_000);
    const res = await withFakeResend(() => decide("grant", "admin", personId));
    expect(res.status).toBe(200);
    expect(res.body.allocation).toMatchObject({
      granted: true,
      cpu_milli: 10_000,
      gpu_milli: 2_000,
    });
    expect(res.body.allocation.policy_version).toBe(1);
    expect(pools()).toEqual([
      { pool: "cpu", granted_milli: 10_000, held_milli: 0, charged_milli: 0, frozen: 0 },
      { pool: "gpu", granted_milli: 2_000, held_milli: 0, charged_milli: 0, frozen: 0 },
    ]);
    expect(ledger()).toEqual([
      {
        kind: "grant",
        reason: "grant",
        granted_delta_milli: 10_000,
        actor_user_id: ids.admin,
        idempotency_key: `compute_access_grant:${personId}:cpu`,
        pool: "cpu",
      },
      {
        kind: "grant",
        reason: "grant",
        granted_delta_milli: 2_000,
        actor_user_id: ids.admin,
        idempotency_key: `compute_access_grant:${personId}:gpu`,
        pool: "gpu",
      },
    ]);
    expect(await totalsDisagreements(realD1(db))).toEqual([]);
    // The state and the stamps.
    const r = row();
    expect(r.compute_access).toBe("active");
    expect(r.compute_access_granted_by).toBe(ids.admin);
    expect(r.compute_access_granted_at).toBeTruthy();
    expect(r.service_access).toBe(0);
  });

  test("grant, suspend, grant opens the allocation exactly once", async () => {
    // MUTATION: make `defaultGrantKey` unique per call (add Math.random()), and the second grant
    // writes two more entries.
    await setDefault(10_000, 2_000);
    await withFakeResend(async () => {
      expect((await decide("grant", "admin", personId)).status).toBe(200);
      expect((await decide("suspend", "admin", personId)).status).toBe(200);
      expect(pools().map((p) => p.frozen)).toEqual([1, 1]);
      const again = await decide("grant", "admin", personId);
      expect(again.status).toBe(200);
      expect(again.body.allocation).toMatchObject({
        granted: false,
        cpu_milli: 0,
        gpu_milli: 0,
        reason: "already_granted",
      });
    });
    expect(ledger()).toHaveLength(2);
    expect(pools().map((p) => [p.granted_milli, p.frozen])).toEqual([
      [10_000, 0],
      [2_000, 0],
    ]);
    expect(await totalsDisagreements(realD1(db))).toEqual([]);
  });

  test("a zero default grants nothing and the response says so", async () => {
    const res = await withFakeResend(() => decide("grant", "admin", personId));
    expect(res.status).toBe(200);
    expect(res.body.allocation).toMatchObject({
      granted: false,
      cpu_milli: 0,
      gpu_milli: 0,
      reason: "policy_default_zero",
      policy_version: null,
    });
    expect(ledger()).toEqual([]);
    expect(pools()).toEqual([]);
    expect(row().compute_access).toBe("active");
  });

  test("a default for one pool opens that pool only", async () => {
    await setDefault(0, 5_000);
    const res = await withFakeResend(() => decide("grant", "admin", personId));
    expect(res.body.allocation).toMatchObject({ granted: true, cpu_milli: 0, gpu_milli: 5_000 });
    expect(pools().map((p) => p.pool)).toEqual(["gpu"]);
  });

  test("a grant to a person who already holds a pool adds the default to it", async () => {
    // An administrator's pool grant may precede compute access (it needs none): the default is added.
    await setDefault(1_000, 0);
    db.run(
      "INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('account', ?, 'cpu')",
      [String(personId)],
    );
    await withFakeResend(() => decide("grant", "admin", personId));
    expect(pools()[0]).toMatchObject({ pool: "cpu", granted_milli: 1_000 });
  });

  test("an unreadable policy fails closed: 503, and nothing is written", async () => {
    // A stored row the strict schema cannot parse (valid JSON, wrong shape).
    db.run("INSERT INTO compute_policy (policy_json, set_by) VALUES ('{}', ?)", [ids.owner]);
    const res = await decide("grant", "admin", personId);
    expect([res.status, res.body.code]).toEqual([503, "policy_unreadable"]);
    expect(row().compute_access).toBe("requested");
    expect(ledger()).toEqual([]);
  });

  test("a deny, a suspend and a revoke read no policy: an unreadable one does not stop them", async () => {
    db.run("INSERT INTO compute_policy (policy_json, set_by) VALUES ('{}', ?)", [ids.owner]);
    expect((await withFakeResend(() => decide("deny", "admin", personId))).status).toBe(200);
    const a = seedPerson({ compute_access: "active" });
    expect((await withFakeResend(() => decide("suspend", "admin", a))).status).toBe(200);
  });
});

describe("the freeze has two causes and one bit: only a grant to an account in good standing lifts it", () => {
  test("a suspension freezes the pools and a grant unfreezes them", async () => {
    await setDefault(10_000, 0);
    await withFakeResend(async () => {
      await decide("grant", "admin", personId);
      expect(pools().map((p) => p.frozen)).toEqual([0]);
      await decide("suspend", "admin", personId);
      expect(pools().map((p) => p.frozen)).toEqual([1]);
      await decide("grant", "admin", personId);
      expect(pools().map((p) => p.frozen)).toEqual([0]);
    });
  });

  test("a revocation freezes the pools, and only an admin's grant reopens the account", async () => {
    await setDefault(10_000, 0);
    await withFakeResend(async () => {
      await decide("grant", "admin", personId);
      expect((await decide("revoke", "admin", personId)).status).toBe(200);
      expect(pools().map((p) => p.frozen)).toEqual([1]);
      expect((await decide("grant", "admin", personId)).status).toBe(200);
      expect(pools().map((p) => p.frozen)).toEqual([0]);
    });
  });

  test("an account revoked by an administrator cannot be granted compute until it is back in good standing", async () => {
    // MUTATION: drop GOOD_STANDING from the grant's UPDATE and this grant lands, unfreezing a pool
    // the ACCOUNT's revocation froze.
    await setDefault(10_000, 0);
    await withFakeResend(async () => {
      await decide("grant", "admin", personId);
      // The account is revoked as `finalizeRevocation` leaves it (the route itself is driven in
      // compute-access-cascade.test.ts): status revoked, compute revoked, pools frozen.
      db.run("UPDATE users SET status = 'revoked', compute_access = 'revoked' WHERE id = ?", [
        personId,
      ]);
      db.run("UPDATE compute_pools SET frozen = 1 WHERE holder_ref = ?", [String(personId)]);
      const refused = await decide("grant", "admin", personId);
      expect([refused.status, refused.body.code]).toEqual([409, "account_not_in_good_standing"]);
      expect(row().compute_access).toBe("revoked");
      expect(pools().map((p) => p.frozen)).toEqual([1]);
      // Put back in good standing, the grant is the administrator's decision and lifts the freeze.
      db.run("UPDATE users SET status = 'approved' WHERE id = ?", [personId]);
      expect((await decide("grant", "admin", personId)).status).toBe(200);
      expect(pools().map((p) => p.frozen)).toEqual([0]);
    });
  });

  test("an account that is pending or revoked is not granted; a deleted one is not found", async () => {
    for (const status of ["pending", "revoked"]) {
      const id = seedPerson({ status });
      const res = await decide("grant", "admin", id);
      expect([status, res.status, res.body.code]).toEqual([
        status,
        409,
        "account_not_in_good_standing",
      ]);
      expect(row(id).compute_access).toBe("requested");
    }
    const gone = seedPerson({ deleted_at: "2026-11-02 00:00:00" });
    expect((await decide("grant", "admin", gone)).status).toBe(404);
  });

  test("a suspension does not freeze another account's pools", async () => {
    await setDefault(10_000, 0);
    const other = seedPerson();
    await withFakeResend(async () => {
      await decide("grant", "admin", personId);
      await decide("grant", "admin", other);
      await decide("suspend", "admin", personId);
    });
    expect(pools(personId).map((p) => p.frozen)).toEqual([1]);
    expect(pools(other).map((p) => p.frozen)).toEqual([0]);
  });
});

/**
 * A D1 that runs `then()` right AFTER a read of `when(sql)` returns, to land another writer exactly
 * between a decision's read of the account and its batch. The writer works through the real database; only
 * the interleaving is arranged. Statements that are not matched are the real ones, untouched, and the
 * batch is the real batch.
 */
function racing(base: D1Database, when: (sql: string) => boolean, then: () => void): D1Database {
  return {
    prepare(sql: string) {
      const inner = base.prepare(sql) as unknown as {
        bind(...a: unknown[]): unknown;
        first(): Promise<unknown>;
      };
      if (!when(sql)) return inner;
      const api = {
        bind(...a: unknown[]) {
          inner.bind(...a);
          return api;
        },
        async first() {
          const r = await inner.first();
          then();
          return r;
        },
      };
      return api;
    },
    batch: (stmts: unknown[]) => (base as unknown as { batch(s: unknown[]): unknown }).batch(stmts),
  } as unknown as D1Database;
}

const isAccountRead = (sql: string) =>
  sql.includes("FROM users") && sql.includes("compute_purpose");

describe("a decision that loses a race changes nothing", () => {
  test("a grant whose account is revoked between the read and the batch is refused, and writes nothing (MUTATION: drop GOOD_STANDING from the grant's UPDATE)", async () => {
    await setDefault(10_000, 0);
    const e = env();
    e.DB = racing(realD1(db), isAccountRead, () =>
      db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [personId]),
    );
    const raced = await call("admin", "POST", `/grant/by-id/${personId}`, { env: e });
    expect([raced.status, raced.body.code]).toEqual([409, "account_not_in_good_standing"]);
    expect(row().compute_access).toBe("requested");
    expect(ledger()).toEqual([]);
    expect(audits("compute_access_granted")).toHaveLength(0);
  });

  test("a grant whose state moved between the read and the batch is a stale_state, with no allocation", async () => {
    await setDefault(10_000, 0);
    const e = env();
    // A state a grant cannot start from (`none`; `denied` would let it land).
    e.DB = racing(realD1(db), isAccountRead, () =>
      db.run("UPDATE users SET compute_access = 'none' WHERE id = ?", [personId]),
    );
    const raced = await call("admin", "POST", `/grant/by-id/${personId}`, { env: e });
    expect([raced.status, raced.body.code]).toEqual([409, "stale_state"]);
    expect(row().compute_access).toBe("none");
    expect(ledger()).toEqual([]);
    // The pool the grant made ready is there with zero totals (an idempotent insert made before the
    // batch): nothing was granted into it, and nothing is frozen.
    expect(pools()).toEqual([
      { pool: "cpu", granted_milli: 0, held_milli: 0, charged_milli: 0, frozen: 0 },
    ]);
  });

  test("a suspension whose state moved changes no pool and no job: the release statements are guarded (MUTATION: drop the state guard)", async () => {
    const id = seedPerson({ compute_access: "active" });
    db.run(
      "INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('account', ?, 'cpu')",
      [String(id)],
    );
    const e = env();
    e.DB = racing(realD1(db), isAccountRead, () =>
      db.run("UPDATE users SET compute_access = 'revoked' WHERE id = ?", [id]),
    );
    const raced = await call("admin", "POST", `/suspend/by-id/${id}`, { env: e });
    expect([raced.status, raced.body.code]).toEqual([409, "stale_state"]);
    expect(row(id).compute_access).toBe("revoked");
    expect(pools(id).map((p) => p.frozen)).toEqual([0]);
    expect(audits("compute_access_suspended")).toHaveLength(0);
  });
});

describe("the listing", () => {
  test("lists every account with a state but none, oldest id first, with a cursor", async () => {
    const a = seedPerson({ compute_access: "active" });
    const b = seedPerson({ compute_access: "denied" });
    seedPerson({ compute_access: "none" });
    const all = await call("admin", "GET", "");
    expect(all.status).toBe(200);
    expect(all.body.accounts.map((x: { id: number }) => x.id)).toEqual([personId, a, b]);
    expect(all.body.next_after).toBeNull();
    expect(all.body.accounts[0]).toMatchObject({
      id: personId,
      compute_access: "requested",
      compute_terms_version: COMPUTE_TERMS_VERSION,
    });
    // The purpose is the administrator's to read here, and the password hash is nowhere.
    expect(all.body.accounts[0].compute_purpose).toContain("ICA");
    expect(all.text).not.toContain("password");

    const page = await call("admin", "GET", "?limit=2");
    expect(page.body.accounts).toHaveLength(2);
    expect(page.body.next_after).toBe(a);
    const next = await call("admin", "GET", `?limit=2&after=${page.body.next_after}`);
    expect(next.body.accounts.map((x: { id: number }) => x.id)).toEqual([b]);
    expect(next.body.next_after).toBeNull();
  });

  test("filters by state, refuses `none`, an unknown state and a bad limit", async () => {
    seedPerson({ compute_access: "active" });
    const requested = await call("admin", "GET", "?state=requested");
    expect(
      requested.body.accounts.map((x: { compute_access: string }) => x.compute_access),
    ).toEqual(["requested"]);
    for (const q of [
      "?state=none",
      "?state=granted",
      "?limit=0",
      "?limit=201",
      "?after=-1",
      "?x=1",
    ]) {
      const res = await call("admin", "GET", q);
      expect([q, res.status, res.body.code]).toEqual([q, 400, "invalid_query"]);
    }
  });

  test("a deleted account is not listed", async () => {
    seedPerson({ compute_access: "active", deleted_at: "2026-11-02" });
    expect((await call("admin", "GET", "")).body.accounts).toHaveLength(1);
  });
});

describe("the audit row and the mail", () => {
  test("every decision is audited with the actor, the states and the reason, and a lost race writes none", async () => {
    // MUTATION: drop the audit statement from the batch.
    const reason = SECRET_REASON;
    const cases: Array<[string, string, string]> = [
      ["grant", "requested", "compute_access_granted"],
      ["suspend", "active", "compute_access_suspended"],
      ["revoke", "suspended", "compute_access_revoked"],
    ];
    await withFakeResend(async () => {
      for (const [decision, , action] of cases) {
        const res = await decide(decision, "admin", personId, { reason });
        expect([decision, res.status]).toEqual([decision, 200]);
        const [a] = audits(action).slice(-1);
        expect(a?.user_id).toBe(ids.admin);
        expect(a?.resource_id).toBe(String(personId));
        expect(JSON.parse(a?.details ?? "{}")).toMatchObject({
          decision,
          reason,
          via: "cli",
        });
      }
      const id = seedPerson();
      await decide("deny", "admin", id);
      expect(JSON.parse(audits("compute_access_denied")[0]?.details ?? "{}")).toMatchObject({
        decision: "deny",
        from: "requested",
        to: "denied",
        reason: null,
      });
      // A refused decision leaves no audit row.
      await decide("deny", "admin", id);
      expect(audits("compute_access_denied")).toHaveLength(1);
    });
  });

  test("the person is mailed what was decided, with no reason in it, and a grant links to the compute page", async () => {
    const kinds: Array<[string, string, RegExp]> = [
      ["grant", "requested", /granted/i],
      ["suspend", "active", /suspended/i],
      ["revoke", "suspended", /ended/i],
    ];
    for (const [decision, , expected] of kinds) {
      const calls = await withFakeResend(async (captured) => {
        const res = await decide(decision, "admin", personId, { reason: SECRET_REASON });
        expect(res.body.email_sent).toBe(true);
        return captured;
      });
      const sent = sendsTo(calls, PERSON_EMAIL);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toMatch(expected);
      expect(sent[0]?.html).not.toContain("REASON-MARKER");
      if (decision === "grant") expect(sent[0]?.html).toContain("https://app.example.test/compute");
    }
    const id = seedPerson({ email: "cmpdecide-denied@nemar.test" });
    const calls = await withFakeResend(async (captured) => {
      await decide("deny", "admin", id);
      return captured;
    });
    expect(sendsTo(calls, "cmpdecide-denied@nemar.test")[0]?.subject).toMatch(/request/i);
  });

  test("a send that fails leaves the decision standing, and the response says so", async () => {
    const res = await withFakeResend(() => decide("grant", "admin", personId), { status: 500 });
    expect(res.status).toBe(200);
    expect(res.body.email_sent).toBe(false);
    expect(row().compute_access).toBe("active");
  });

  test("a service account is not mailed", async () => {
    const id = seedPerson({ account_kind: "service" });
    const calls = await withFakeResend(async (captured) => {
      const res = await decide("grant", "admin", id);
      expect(res.body.email_sent).toBe(false);
      return captured;
    });
    expect(calls).toEqual([]);
  });
});

describe("independence from upload access and from the compute switch", () => {
  test("a decision never reads or writes service_access", async () => {
    db.run("UPDATE users SET service_access = 1, status = 'approved' WHERE id = ?", [personId]);
    await withFakeResend(async () => {
      await decide("grant", "admin", personId);
      expect(row().service_access).toBe(1);
      await decide("suspend", "admin", personId);
      await decide("revoke", "admin", personId);
    });
    expect(row().service_access).toBe(1);
    // And the reverse: a person without upload access is granted compute.
    const id = seedPerson();
    db.run("UPDATE users SET service_access = 0 WHERE id = ?", [id]);
    await withFakeResend(() => decide("grant", "admin", id));
    expect(row(id).service_access).toBe(0);
    expect(row(id).compute_access).toBe("active");
  });

  test("every decision works with the compute switch off, unset or on", async () => {
    for (const COMPUTE_ENABLED of [undefined, "0", "1"]) {
      const id = seedPerson();
      const e = env({ COMPUTE_ENABLED });
      await withFakeResend(async () => {
        for (const d of ["grant", "suspend", "revoke"]) {
          const res = await call("admin", "POST", `/${d}/by-id/${id}`, { env: e });
          expect([COMPUTE_ENABLED, d, res.status]).toEqual([COMPUTE_ENABLED, d, 200]);
        }
      });
    }
  });
});
