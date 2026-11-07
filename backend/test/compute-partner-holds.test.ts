/**
 * `POST /compute/holds` (epic #2021 phase D4, #2025; ADR 0118, the amendment of this phase), through the
 * REAL Worker over real migrated SQLite, Miniflare's R2 through the Worker's own bindings and a partner
 * client registered by the owner's route. The credential matrix is `compute-partner-credentials.test.ts`.
 *
 * What is pinned:
 *  1. THE HAPPY PATH. 201 `{ job_id, hold_id, tag, expires_at }`; the job is the partner's reservation for
 *     THIS person and THIS client (`created`, no Tapis job, the person's Tapis username recorded), its hold
 *     is on the person's pool and counted against the people budget, nothing is charged, the hold body is
 *     kept BYTE FOR BYTE as `records/<id>/spec.json` and its digest is `spec_digest`, and the identity
 *     snapshot is written. The routes work with the compute switch OFF (a hold is taken and expires, as
 *     for a person's submission).
 *  2. ONE REQUEST PER REFUSAL WORD of the order, each writing nothing: `no_compute_access` (none,
 *     requested, denied, revoked), `suspended`, `invalid_spec` (naming the field), `partition_not_offered`,
 *     `over_job_limit`, `over_concurrency`, `insufficient_balance`, `platform_budget_exhausted`,
 *     `client_cap_reached` (open reservations, the UTC-day cap, and a client the owner listed nowhere),
 *     `compute_disabled`, `policy_unavailable`. A request that fails two checks reports the FIRST.
 *  3. RACES, decided in the hold's own statement: two holds for the last SU (one wins, the loser wrote
 *     nothing), two for a client cap of one open reservation, two for a daily cap that fits one, and two with
 *     the same key (one hold).
 *  4. IDEMPOTENCY: the same key and body is the same reservation (`Idempotent-Replayed`), another body under
 *     the key is 422 `idempotency_conflict`, another person under it is the same conflict, and another
 *     client's key is its own.
 *
 * MUTATIONS (each applied, run, restored): drop the client open guard from the hold; drop the daily guard;
 * decide the client cap with a read before the insert and drop it from the statement; drop the idempotency
 * claim from the batch; drop the access guard from the hold's statement.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEFAULT_COMPUTE_POLICY, PARTITION_NAMES } from "../../shared/contract/compute";
import {
  COMPUTE_PARTNER_ERROR_STATUS,
  type ComputePartnerErrorCode,
  ComputePartnerHoldResponseSchema,
  holdIdForJob,
} from "../../shared/contract/compute-partner";
import { adjustPool, platformPool } from "../src/services/compute-ledger";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  type PartnerPerson,
  type PartnerWorld,
  buildPartnerWorld,
  entries,
  holdBody,
  newPartnerPerson,
  partnerCall,
  poolOf,
  reserve,
  row,
} from "./helpers/compute-partner-world";
import { setPolicy } from "./helpers/compute-seed";
import { registerClient } from "./helpers/oidc-flow";

let fx: LifecycleFixture;
let w: PartnerWorld;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 60_000);
afterAll(async () => {
  await fx?.dispose();
}, 30_000);
beforeEach(async () => {
  await fx.reset();
  w = await buildPartnerWorld(fx);
}, 60_000);

const count = (table: string) =>
  (w.h.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = () => [
  count("compute_ledger"),
  count("compute_jobs"),
  count("compute_idempotency_keys"),
];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const post = (
  person: PartnerPerson,
  json: unknown,
  key?: string | null,
  env?: Record<string, unknown>,
) =>
  partnerCall(w, "POST", "/compute/holds", { token: person.token, json, key, env: env as never });

/** One request that must be refused with `code`, and must write nothing. */
async function refused(
  person: PartnerPerson,
  json: unknown,
  code: ComputePartnerErrorCode,
  field?: string,
) {
  const before = snapshot();
  const res = await post(person, json);
  expect([res.status, res.json?.code]).toEqual([COMPUTE_PARTNER_ERROR_STATUS[code], code]);
  if (field !== undefined) expect(res.json?.field).toBe(field);
  expect(snapshot()).toEqual(before);
  return res;
}

/** The owner's policy with this client's caps (and any other change). */
async function caps(open: number, milli: number, over: Record<string, unknown> = {}) {
  await setPolicy(w.env().DB, fx.ownerId, {
    clients: { [w.client.clientId]: { maxOpenReservations: open, maxReservedMilliPerDay: milli } },
    ...over,
  });
}

describe("a reservation", () => {
  test("is the partner's hold for this person and this client, kept byte for byte", async () => {
    const person = await newPartnerPerson(w);
    // Indented on purpose: the same fields with other whitespace are another request.
    const text = `{\n  "app_id": "partner-app",\n  "app_version": "2.1.0",\n  "kind": "batch",\n  "partition": "shared",\n  "nodes": 1,\n  "cores": 4,\n  "memory_mb": 8000,\n  "gpus": 0,\n  "minutes": 60\n}`;
    const res = await partnerCall(w, "POST", "/compute/holds", { token: person.token, raw: text });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = ComputePartnerHoldResponseSchema.parse(res.json);
    const job = row(w, body.job_id);
    expect(body).toMatchObject({
      hold_id: holdIdForJob(body.job_id),
      tag: `nemar_job:${body.job_id}`,
    });
    expect(body.hold_id).toMatch(/^hold_[0-9a-f]{24}$/);
    expect(job).toMatchObject({
      source: "partner",
      client_id: w.client.clientId,
      account_id: person.id,
      tapis_owner: person.sub,
      kind: "batch",
      state: "created",
      tapis_uuid: null,
      partner_state: null,
      app_id: "partner-app",
      app_version: "2.1.0",
      partition: "shared",
      pool: "cpu",
      nodes: 1,
      cores_per_node: 4,
      memory_mb: 8000,
      minutes: 60,
      held_milli: 4000,
      charged_milli: 0,
      flag_unreserved: 0,
      spec_digest: sha256(text),
    });
    expect(job.gateway_user).toMatch(/^gw_[a-z2-7]{20}$/);
    // Expiry is the owner's reservation wait (30 minutes by default) after the creation.
    const made = Date.parse(`${job.created_at.replace(" ", "T")}Z`);
    expect(Date.parse(`${body.expires_at.replace(" ", "T")}Z`) - made).toBe(30 * 60_000);

    const [hold] = entries(w, body.job_id);
    const people = poolOf(w, "platform", "people") as Record<string, number>;
    expect(hold).toMatchObject({
      kind: "hold",
      held_delta_milli: 4000,
      budget_pool_id: people.id,
      idempotency_key: `job:${body.job_id}:hold`,
    });
    const own = poolOf(w, "account", String(person.id)) as Record<string, number>;
    expect([own.held_milli, own.charged_milli]).toEqual([4000, 0]);
    expect(people.held_milli).toBe(4000);
    // The records: the exact text, and the identity snapshot.
    const spec = await fx.harness.records.get(`records/${body.job_id}/spec.json`);
    expect(await spec?.text()).toBe(text);
    expect(await fx.harness.records.head(`records/${body.job_id}/identity.json`)).not.toBeNull();
    // The key is claimed for the client, with the hash of the request.
    const claim = w.h.db.query("SELECT * FROM compute_idempotency_keys").get() as Record<
      string,
      string
    >;
    expect(claim).toMatchObject({ scope: `client:${w.client.clientId}`, job_id: body.job_id });
    expect(claim.request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("works with the compute switch OFF: the hold is taken and waits, as a person's submission does", async () => {
    const person = await newPartnerPerson(w);
    const res = await post(person, holdBody(), undefined, { COMPUTE_ENABLED: undefined });
    expect(res.status).toBe(201);
    expect(row(w, res.json?.job_id as string).state).toBe("created");
  });

  test("the GPU form reserves on the gpu pool", async () => {
    const person = await newPartnerPerson(w);
    // The pool of a person who was granted only cpu does not exist for gpu: no balance.
    await refused(
      person,
      holdBody({ partition: "gpu-shared", cores: 10, gpus: 1, memory_mb: 90_000 }),
      "insufficient_balance",
    );
  });
});

describe("one request per refusal word, and a refusal writes nothing", () => {
  test("no_compute_access for none, requested, denied, revoked; suspended for suspended", async () => {
    for (const state of ["none", "requested", "denied", "revoked"]) {
      const person = await newPartnerPerson(w, { access: state });
      const res = await refused(person, holdBody(), "no_compute_access");
      expect(res.json?.error).toBe("The person does not have compute access.");
    }
    const paused = await newPartnerPerson(w, { access: "suspended" });
    await refused(paused, holdBody(), "suspended");
    // A deleted account has none.
    const gone = await newPartnerPerson(w);
    w.h.db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(gone.id);
    expect((await post(gone, holdBody())).status).toBeGreaterThanOrEqual(401);
  });

  test("invalid_spec names the field and never echoes a value", async () => {
    const person = await newPartnerPerson(w);
    const secret = "PARTNER-SECRET-VALUE";
    const cases: Array<[unknown, string]> = [
      [holdBody({ partition: "nowhere" }), "partition"],
      [holdBody({ nodes: 0 }), "nodes"],
      [holdBody({ nodes: 1.5 }), "nodes"],
      [holdBody({ cores: -1 }), "cores"],
      [holdBody({ minutes: 100_000 }), "minutes"],
      [holdBody({ kind: "service" }), "kind"],
      [holdBody({ app_id: `bad id ${secret}` }), "app_id"],
      [holdBody({ gpus: 1 }), "gpus"],
      [holdBody({ extra_key: secret }), "body"],
      [{ ...holdBody(), app_version: undefined }, "app_version"],
      [[1, 2], "body"],
      ["not an object", "body"],
    ];
    for (const [json, field] of cases) {
      const res = await refused(person, json, "invalid_spec", field);
      expect(res.text).not.toContain(secret);
    }
    const notJson = await partnerCall(w, "POST", "/compute/holds", {
      token: person.token,
      raw: "{nope",
    });
    expect([notJson.status, notJson.json?.code, notJson.json?.field]).toEqual([
      400,
      "invalid_spec",
      "body",
    ]);
    const huge = await partnerCall(w, "POST", "/compute/holds", {
      token: person.token,
      raw: JSON.stringify(holdBody({ app_id: "a".repeat(9000) })),
    });
    expect([huge.status, huge.json?.code]).toEqual([400, "invalid_spec"]);
    const bom = await partnerCall(w, "POST", "/compute/holds", {
      token: person.token,
      raw: `﻿${JSON.stringify(holdBody())}`,
    });
    expect([bom.status, bom.json?.code]).toEqual([400, "invalid_spec"]);
    expect(snapshot()[1]).toBe(0);
  });

  test("partition_not_offered and over_job_limit follow the owner's ceilings", async () => {
    const person = await newPartnerPerson(w);
    const pipelinesOnly = PARTITION_NAMES.find(
      (n) => DEFAULT_COMPUTE_POLICY.ceilings[n] === undefined,
    ) as string;
    await refused(person, holdBody({ partition: pipelinesOnly }), "partition_not_offered");
    await refused(person, holdBody({ nodes: 4 }), "over_job_limit");
    await refused(person, holdBody({ minutes: 49 * 60 }), "over_job_limit");
    await refused(person, holdBody({ cores: 129 }), "over_job_limit");
  });

  test("over_concurrency: a person's live jobs against the owner's limit, whichever door made them", async () => {
    const person = await newPartnerPerson(w);
    for (let i = 0; i < 4; i++) await reserve(w, person, { cores: 1, memory_mb: 1000 });
    await refused(person, holdBody({ cores: 1, memory_mb: 1000 }), "over_concurrency");
    // A job made through another front door counts too.
    const other = await newPartnerPerson(w);
    for (let i = 0; i < 4; i++) {
      w.h.db
        .query(
          `INSERT INTO compute_jobs (id, account_id, source, kind, state, app_id, app_version, spec_digest,
             partition, pool, nodes, cores_per_node, minutes)
           VALUES (?, ?, 'cli', 'batch', 'running', 'a', '1', ?, 'shared', 'cpu', 1, 1, 1)`,
        )
        .run(`job_${(0xabc000 + i).toString(16).padStart(24, "0")}`, other.id, "0".repeat(64));
    }
    await refused(other, holdBody(), "over_concurrency");
  });

  test("insufficient_balance: the person's pool, and a person with no pool at all", async () => {
    const poor = await newPartnerPerson(w, { grant: 3999 });
    await refused(poor, holdBody(), "insufficient_balance");
    const exact = await newPartnerPerson(w, { grant: 4000 });
    expect((await post(exact, holdBody())).status).toBe(201);
    const nothing = await newPartnerPerson(w, { grant: 1 });
    await refused(nothing, holdBody(), "insufficient_balance");
  });

  test("platform_budget_exhausted: the shared people budget, told apart from the person's balance", async () => {
    const person = await newPartnerPerson(w);
    const people = (await platformPool(w.env().DB, "people", "cpu")) as { id: number };
    const r = await adjustPool(w.env().DB, {
      poolId: people.id,
      chargedDeltaMilli: 1_000_000_000 - 2000,
      actorUserId: fx.ownerId,
      reason: "test_correction",
      idempotencyKey: "budget-down-1",
    });
    expect(r.ok).toBe(true);
    await refused(person, holdBody(), "platform_budget_exhausted");
  });

  test("client_cap_reached: open reservations, the UTC-day cap, and a client the owner listed nowhere", async () => {
    const person = await newPartnerPerson(w);
    const second = await newPartnerPerson(w);
    // Open reservations: a cap of one.
    await caps(1, 1_000_000);
    await reserve(w, person);
    await refused(second, holdBody(), "client_cap_reached");
    // The daily cap: 4 SU fit once (every hold taken today counts, a released one included).
    await caps(10, 4000);
    w.h.db.exec("UPDATE compute_jobs SET state = 'cancelled' WHERE source = 'partner'");
    const third = await newPartnerPerson(w);
    // The first hold above is already in today's sum (4000): nothing more fits.
    await refused(third, holdBody(), "client_cap_reached");
    // A client the owner's policy does not list has no reservations (closed by default).
    const stranger = await registerClient(w.h, {
      allowed_scopes: ["openid", "compute.reserve"],
      allowed_grants: ["authorization_code"],
      audience: "https://api.nemar.org/compute",
    });
    const { tokenFor } = await import("./helpers/compute-partner-world");
    const token = await tokenFor(w, third, "openid compute.reserve", stranger);
    const res = await partnerCall(w, "POST", "/compute/holds", { token, json: holdBody() });
    expect([res.status, res.json?.code]).toEqual([409, "client_cap_reached"]);
  });

  test("the client's own record is a second ceiling: the smaller of it and the policy stands", async () => {
    const person = await newPartnerPerson(w);
    const second = await newPartnerPerson(w);
    await caps(10, 1_000_000);
    w.h.db
      .query("UPDATE oidc_clients SET cap_open_reservations = 1 WHERE client_id = ?")
      .run(w.client.clientId);
    await reserve(w, person);
    await refused(second, holdBody(), "client_cap_reached");
    w.h.db
      .query(
        "UPDATE oidc_clients SET cap_open_reservations = NULL, cap_su_per_day = 5 WHERE client_id = ?",
      )
      .run(w.client.clientId);
    // 5 SU a day, 4 reserved: the next 4 SU do not fit.
    await refused(second, holdBody(), "client_cap_reached");
  });

  test("compute_disabled when the records bucket is not bound, policy_unavailable when the policy cannot be read", async () => {
    const person = await newPartnerPerson(w);
    const off = await post(person, holdBody(), undefined, { COMPUTE_RECORDS: undefined });
    expect([off.status, off.json?.code]).toEqual([503, "compute_disabled"]);
    w.h.db
      .query("INSERT INTO compute_policy (policy_json, set_by, note) VALUES (?, 1, 'broken')")
      .run('{"defaultGrantMilli": 1}');
    const broken = await post(person, holdBody());
    expect([broken.status, broken.json?.code]).toEqual([503, "policy_unavailable"]);
    expect(snapshot()[1]).toBe(0);
  });

  test("a request that fails two checks reports the first", async () => {
    // Access before the body: no access AND a bad body is no_compute_access.
    const none = await newPartnerPerson(w, { access: "none" });
    await refused(none, holdBody({ partition: "nowhere" }), "no_compute_access");
    // The body before the ceilings: a bad body AND an over-limit request is invalid_spec.
    const person = await newPartnerPerson(w);
    await refused(person, holdBody({ nodes: 99 }), "invalid_spec", "nodes");
    // The ceilings before the person's concurrency: over the ceiling AND at the limit is over_job_limit.
    for (let i = 0; i < 4; i++) await reserve(w, person, { cores: 1, memory_mb: 1000 });
    await refused(person, holdBody({ nodes: 4 }), "over_job_limit");
    // The person's concurrency before the client's cap: at the limit AND the cap is reached.
    await caps(0, 0);
    await refused(person, holdBody({ cores: 1, memory_mb: 1000 }), "over_concurrency");
    // The balance before the client's cap: no balance AND the cap is reached.
    const poor = await newPartnerPerson(w, { grant: 100 });
    await refused(poor, holdBody(), "insufficient_balance");
  });
});

describe("compute access is read in the hold's own statement too", () => {
  test("a person whose access ended after the route read it is refused by the hold itself, with the pools UNfrozen", async () => {
    const { createJob } = await import("../src/services/compute-jobs");
    const text = JSON.stringify(holdBody());
    for (const [state, word] of [
      ["suspended", "suspended"],
      ["revoked", "no_compute_access"],
      ["denied", "no_compute_access"],
      ["none", "no_compute_access"],
    ] as const) {
      const person = await newPartnerPerson(w);
      w.h.db.query("UPDATE users SET compute_access = ? WHERE id = ?").run(state, person.id);
      const before = snapshot();
      const made = await createJob(w.env(), {
        source: "partner",
        accountId: person.id,
        clientId: w.client.clientId,
        tapisOwner: person.sub,
        holdBody: text,
        requireActiveAccess: true,
        caps: { maxOpenReservations: 10, maxReservedMilliPerDay: 1_000_000_000 },
      });
      expect([state, made.ok === false ? made.code : "made"]).toEqual([state, word]);
      expect(snapshot()).toEqual(before);
    }
  });
});

describe("races are decided in the hold's own statement", () => {
  test("two holds for the last SU: one wins and the loser wrote nothing", async () => {
    const person = await newPartnerPerson(w, { grant: 4000 });
    const [a, b] = await Promise.all([post(person, holdBody()), post(person, holdBody())]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json?.code).toBe("insufficient_balance");
    expect(count("compute_jobs")).toBe(1);
    expect(
      (
        w.h.db.query("SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'hold'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(count("compute_idempotency_keys")).toBe(1);
    const own = poolOf(w, "account", String(person.id)) as Record<string, number>;
    expect(own.held_milli).toBe(4000);
  });

  test("two for a client cap of one open reservation: one wins", async () => {
    await caps(1, 1_000_000_000);
    const a = await newPartnerPerson(w);
    const b = await newPartnerPerson(w);
    const [x, y] = await Promise.all([post(a, holdBody()), post(b, holdBody())]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect([x, y].find((r) => r.status === 409)?.json?.code).toBe("client_cap_reached");
    expect(count("compute_jobs")).toBe(1);
  });

  test("two for a daily cap that fits one: one wins", async () => {
    await caps(10, 4000);
    const a = await newPartnerPerson(w);
    const b = await newPartnerPerson(w);
    const [x, y] = await Promise.all([post(a, holdBody()), post(b, holdBody())]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect([x, y].find((r) => r.status === 409)?.json?.code).toBe("client_cap_reached");
    expect(count("compute_jobs")).toBe(1);
  });

  test("two with the same key make one hold, and both are answered with it", async () => {
    const person = await newPartnerPerson(w);
    const [x, y] = await Promise.all([
      post(person, holdBody(), "same-key-1"),
      post(person, holdBody(), "same-key-1"),
    ]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.json?.job_id).toBe(y.json?.job_id);
    expect([x, y].filter((r) => r.json?.replayed === true)).toHaveLength(1);
    expect(count("compute_jobs")).toBe(1);
    expect(
      (
        w.h.db.query("SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'hold'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(count("compute_idempotency_keys")).toBe(1);
  });
});

describe("idempotency", () => {
  test("the same key and body is the same reservation; replayed is said; nothing is written", async () => {
    const person = await newPartnerPerson(w);
    const first = await post(person, holdBody(), "replay-key");
    const before = snapshot();
    const again = await post(person, holdBody(), "replay-key");
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(again.json).toMatchObject({
      job_id: first.json?.job_id,
      hold_id: first.json?.hold_id,
      replayed: true,
    });
    expect(first.json?.replayed).toBeUndefined();
    expect(snapshot()).toEqual(before);
  });

  test("a replay does not depend on the world having stayed the same", async () => {
    const person = await newPartnerPerson(w, { grant: 4000 });
    const first = await post(person, holdBody(), "world-key");
    // The balance is gone now; a new request would be refused, the repeat is not.
    expect((await post(person, holdBody())).status).toBe(409);
    const again = await post(person, holdBody(), "world-key");
    expect([again.status, again.json?.job_id]).toEqual([201, first.json?.job_id]);
  });

  test("another body under the key is 422 idempotency_conflict and writes nothing", async () => {
    const person = await newPartnerPerson(w);
    await post(person, holdBody(), "conflict-key");
    const before = snapshot();
    const res = await post(person, holdBody({ minutes: 30 }), "conflict-key");
    expect([res.status, res.json?.code]).toEqual([422, "idempotency_conflict"]);
    // The same fields with other whitespace are another request.
    const spaced = await partnerCall(w, "POST", "/compute/holds", {
      token: person.token,
      raw: `${JSON.stringify(holdBody())} `,
      key: "conflict-key",
    });
    expect([spaced.status, spaced.json?.code]).toEqual([422, "idempotency_conflict"]);
    expect(snapshot()).toEqual(before);
  });

  test("another person under the same key is a conflict, never the first person's reservation", async () => {
    const a = await newPartnerPerson(w);
    const b = await newPartnerPerson(w);
    const first = await post(a, holdBody(), "shared-key");
    const res = await post(b, holdBody(), "shared-key");
    expect([res.status, res.json?.code]).toEqual([422, "idempotency_conflict"]);
    expect(res.text).not.toContain(first.json?.job_id as string);
  });

  test("another client's key is its own", async () => {
    const person = await newPartnerPerson(w);
    const other = await registerClient(w.h, {
      allowed_scopes: ["openid", "compute.reserve"],
      allowed_grants: ["authorization_code"],
      audience: "https://api.nemar.org/compute",
    });
    await setPolicy(w.env().DB, fx.ownerId, {
      clients: {
        [w.client.clientId]: { maxOpenReservations: 10, maxReservedMilliPerDay: 1_000_000_000 },
        [other.clientId]: { maxOpenReservations: 10, maxReservedMilliPerDay: 1_000_000_000 },
      },
    });
    const { tokenFor } = await import("./helpers/compute-partner-world");
    const first = await post(person, holdBody(), "client-key");
    const token = await tokenFor(w, person, "openid compute.reserve", other);
    const second = await partnerCall(w, "POST", "/compute/holds", {
      token,
      json: holdBody(),
      key: "client-key",
    });
    expect(second.status).toBe(201);
    expect(second.json?.job_id).not.toBe(first.json?.job_id);
    expect(count("compute_idempotency_keys")).toBe(2);
  });
});
