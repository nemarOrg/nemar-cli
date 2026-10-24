/**
 * The daily merge cap and the claim to merge (epic #1046 phase 6, #1912; ADR 0111, decision 6),
 * through their real entry point, the transition route's claim edge.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth and admin
 * middleware, the real routes and services. The cap's UTC day is D1's own clock, so
 * "yesterday" is a claim seeded with yesterday's time, never a mocked clock.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - every claim, N.0.0's and N.0.1's alike, takes one unit of the day's cap; a refusal writes
 *    nothing; two claims racing for the last unit cannot both win; an unreadable cap reads 0;
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import type { RepullStatus } from "../../shared/repull-state";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../src/routes/admin/upstream-repulls";
import { hashApiKey } from "../src/services/token";
import {
  REPULL_CAP_MAX,
  REPULL_MERGE_CAP_DEFAULT,
  readRepullCap,
  repullMergeCap,
} from "../src/services/upstream-repull";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "rpm-admin-key-0123456789abcdef0123456789abcdef012";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

// biome-ignore lint/suspicious/noExplicitAny: a response body read field by field in assertions
type Json = Record<string, any>;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId = 0;
let mail: CapturedEmail[] = [];
let releaseMail: (() => void) | null = null;
let mailDone: Promise<void> | null = null;

beforeEach(async () => {
  db = freshDb();
  app = new Hono();
  app.use("*", authMiddleware);
  app.use("*", adminMiddleware);
  registerUpstreamRepullRoutes(app);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('rpmadmin', 'rpmadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'rpmadmin'").get() as Row)
    .id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  await new Promise<void>((armed) => {
    mailDone = withFakeResend(
      (calls) =>
        new Promise<void>((done) => {
          mail = calls;
          releaseMail = done;
          armed();
        }),
    );
  });
});

afterEach(async () => {
  releaseMail?.();
  await mailDone;
  expect(mail).toEqual([]);
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

async function call(path: string, body: unknown, o: { env?: Partial<Bindings> } = {}) {
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(o.env),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

function seedMirror(id: string, o: { anonymous?: boolean; stamps?: Record<string, string> } = {}) {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, sweep_stamps)
     VALUES (?, ?, ?, 'openneuro', 'ds099999', ?, ?)`,
    [id, id, adminId, o.anonymous ? 1 : 0, o.stamps ? JSON.stringify(o.stamps) : null],
  );
}

function seedRepull(status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: "on099999",
    upstream_ds: "ds099999",
    actor_user_id: adminId,
    head_sha: HEAD,
    ...(status === "gates_clear" ? { gates_sha: HEAD } : {}),
    ...over,
  });
  const cols = Object.keys(row);
  return Number(
    db
      .query(
        `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...(cols.map((c) => row[c]) as never[])).lastInsertRowid,
  );
}

/** A stored screen verdict of `sha`, as the callback leaves it. */
function markScreen(repullId: number, status: string, o: { pr?: string; sha?: string } = {}) {
  const sha = o.sha ?? HEAD;
  const report = parseScreenReport({
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: sha,
    scan: {
      id: "on099999",
      version: null,
      scanned_at: "2026-10-24T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    },
  });
  db.run(
    `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, report, reported_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [repullId, o.pr ?? "n0", sha, status, JSON.stringify(report)],
  );
}

/** A mirror with a gates_clear row and a clear screen of its head: ready to claim. */
function ready(datasetId = "on099999", status: RepullStatus = "gates_clear"): number {
  if (!db.query("SELECT 1 FROM datasets WHERE dataset_id = ?").get(datasetId)) {
    seedMirror(datasetId);
  }
  const patch = status === "patch_gates_clear";
  const id = seedRepull(status, {
    dataset_id: datasetId,
    ...(patch ? { patch_head_sha: HEAD, patch_gates_sha: HEAD } : {}),
  });
  markScreen(id, "clean", { pr: patch ? "n1" : "n0" });
  return id;
}

const claim = (id: number, o: { env?: Partial<Bindings> } = {}) =>
  call(
    `/repulls/${id}/transition`,
    {
      from: "gates_clear",
      to: "gates_clear",
      fields: { merge_claim_sha: HEAD },
    },
    o,
  );

const patchClaim = (id: number, o: { env?: Partial<Bindings> } = {}) =>
  call(
    `/repulls/${id}/transition`,
    {
      from: "patch_gates_clear",
      to: "patch_gates_clear",
      fields: { patch_merge_claim_sha: HEAD },
    },
    o,
  );

const rowOf = (id: number) =>
  db.query("SELECT * FROM upstream_repulls WHERE id = ?").get(id) as Row;

const auditCount = () =>
  (db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'repull_%'").get() as Row).n;

// ----------------------------------------------------------------------------
// The cap's reading
// ----------------------------------------------------------------------------

describe("REPULL_DAILY_MERGE_CAP", () => {
  test("absent takes the default; one or two digits up to the maximum are read; anything else is 0", () => {
    expect(readRepullCap(undefined, REPULL_MERGE_CAP_DEFAULT)).toEqual({
      value: 5,
      source: "default",
    });
    expect(REPULL_MERGE_CAP_DEFAULT).toBe(5);
    for (const [raw, value] of [
      ["0", 0],
      ["1", 1],
      ["5", 5],
      [String(REPULL_CAP_MAX), REPULL_CAP_MAX],
    ] as const) {
      expect([raw, readRepullCap(raw, 5)]).toEqual([raw, { value, source: "set" }]);
    }
    for (const raw of [
      String(REPULL_CAP_MAX + 1),
      "100",
      "2.5",
      "-1",
      "",
      " 2",
      "2 ",
      "x",
      "1e1",
    ]) {
      expect([raw, readRepullCap(raw, 5)]).toEqual([raw, { value: 0, source: "unreadable" }]);
    }
    expect(repullMergeCap({ REPULL_DAILY_MERGE_CAP: "3" })).toEqual({ value: 3, source: "set" });
  });
});

// ----------------------------------------------------------------------------
// The claim
// ----------------------------------------------------------------------------

describe("the claim takes a unit of the day's cap", () => {
  test("with a cap of 1 the second claim of the UTC day is refused, and writes nothing", async () => {
    const a = ready("on099999");
    const b = ready("on099998");
    const capped = { env: { REPULL_DAILY_MERGE_CAP: "1" } };
    expect((await claim(a, capped)).status).toBe(200);
    const before = rowOf(b);
    const audits = auditCount();
    const refused = await claim(b, capped);
    expect([refused.status, refused.body.code]).toEqual([429, "merge-cap"]);
    expect(refused.body.merge_cap).toEqual({ value: 1, source: "set", used: 1 });
    expect(rowOf(b)).toEqual(before);
    expect(auditCount()).toBe(audits);
  });

  test("yesterday's claims do not count", async () => {
    const a = ready("on099999");
    const b = ready("on099998");
    expect((await claim(a, { env: { REPULL_DAILY_MERGE_CAP: "1" } })).status).toBe(200);
    db.run(
      "UPDATE upstream_repulls SET merge_claimed_at = datetime('now', '-1 day') WHERE id = ?",
      [a],
    );
    expect((await claim(b, { env: { REPULL_DAILY_MERGE_CAP: "1" } })).status).toBe(200);
  });

  test("an N.0.1 claim takes a unit too, and an N.0.0 claim takes N.0.1's", async () => {
    const patch = ready("on099998", "patch_gates_clear");
    const n0 = ready("on099999");
    const capped = { env: { REPULL_DAILY_MERGE_CAP: "1" } };
    expect((await patchClaim(patch, capped)).status).toBe(200);
    expect((await claim(n0, capped)).body.code).toBe("merge-cap");
    db.run(
      "UPDATE upstream_repulls SET patch_merge_claimed_at = NULL, patch_merge_claim_sha = NULL",
    );
    expect((await claim(n0, capped)).status).toBe(200);
    expect((await patchClaim(patch, capped)).body.code).toBe("merge-cap");
  });

  test("the cap is the number of claims: two of two pass, the third does not", async () => {
    const ids = [ready("on099997"), ready("on099998"), ready("on099999")];
    const capped = { env: { REPULL_DAILY_MERGE_CAP: "2" } };
    expect((await claim(ids[0] as number, capped)).status).toBe(200);
    expect((await claim(ids[1] as number, capped)).status).toBe(200);
    const third = await claim(ids[2] as number, capped);
    expect([third.status, third.body.code, third.body.merge_cap.used]).toEqual([
      429,
      "merge-cap",
      2,
    ]);
  });

  test("two claims racing for the last unit: exactly one wins", async () => {
    const used = ready("on099997");
    const a = ready("on099998");
    const b = ready("on099999");
    const capped = { env: { REPULL_DAILY_MERGE_CAP: "2" } };
    expect((await claim(used, capped)).status).toBe(200);
    const results = await Promise.all([claim(a, capped), claim(b, capped)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
    const held = db
      .query("SELECT COUNT(*) AS n FROM upstream_repulls WHERE merge_claimed_at IS NOT NULL")
      .get() as Row;
    expect(held.n).toBe(2);
  });

  test("absent, the cap is 5; set to 0, or set but unreadable, nothing is claimed", async () => {
    const ids = ["on099990", "on099991", "on099992", "on099993", "on099994", "on099995"].map((d) =>
      ready(d),
    );
    for (const id of ids.slice(0, 5)) expect((await claim(id)).status).toBe(200);
    expect((await claim(ids[5] as number)).body.code).toBe("merge-cap");

    const fresh = ready("on099999");
    const zero = await claim(fresh, { env: { REPULL_DAILY_MERGE_CAP: "0" } });
    expect([zero.status, zero.body.code]).toEqual([429, "merge-cap"]);
    for (const raw of ["x", "21", ""]) {
      const res = await claim(fresh, { env: { REPULL_DAILY_MERGE_CAP: raw } });
      expect([raw, res.status, res.body.code, res.body.merge_cap?.source]).toEqual([
        raw,
        429,
        "merge-cap-unreadable",
        "unreadable",
      ]);
    }
    expect(rowOf(fresh).merge_claimed_at).toBeNull();
  });

  test("a claim needs the screen to pass for the claimed head, and the dataset fences", async () => {
    seedMirror("on099999");
    const id = seedRepull("gates_clear");
    const none = await claim(id);
    expect([none.status, none.body.code]).toEqual([409, "screen-not-clear"]);
    markScreen(id, "review");
    expect((await claim(id)).body.code).toBe("screen-not-clear");
    db.run("DELETE FROM upstream_repull_screens");
    markScreen(id, "clean");
    db.run("UPDATE datasets SET anonymous = 1");
    expect((await claim(id)).body.code).toBe("anonymous-dataset");
    db.run("UPDATE datasets SET anonymous = 0");
    expect((await claim(id)).status).toBe(200);
  });

  test("a screen that changes between the read and the claim is not relied on", async () => {
    const id = ready("on099999");
    const real = realD1(db);
    let done = false;
    const racing = {
      ...real,
      prepare(sql: string) {
        if (!done && sql.startsWith("UPDATE upstream_repulls SET")) {
          done = true;
          db.run("UPDATE upstream_repull_screens SET status = 'direct-identifiers'");
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const res = await app.request(
      `/repulls/${id}/transition`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "gates_clear",
          to: "gates_clear",
          fields: { merge_claim_sha: HEAD },
        }),
      },
      { ...env(), DB: racing },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).code).toBe("screen-changed");
    expect(rowOf(id).merge_claimed_at).toBeNull();
  });
});
