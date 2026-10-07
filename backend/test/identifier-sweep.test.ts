/**
 * The scheduled identifier sweep, through its real entry points (epic #1610,
 * phase 5, ADR 0087).
 *
 * The tick (`runIdentifierSweepTick`) selects, claims and dispatches; the
 * callback (`POST /webhooks/identifier-sweep-result`) stores; the admin route
 * asks for a rescreen. Every rule below is driven through one of those, never
 * through a helper or a copied SQL string.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the
 * real routes through Hono's `app.request()`, a `Bun.serve()` stand-in for
 * api.github.com (NEMAR_GITHUB_API_URL) that records every request it gets, and
 * the shared Resend capture, which must stay empty: the sweep mails nobody
 * outside its weekly report (`identifier-sweep-report.test.ts`).
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import webhooks from "../src/routes/webhooks";
import {
  signIdentifierScreenCallbackToken,
  signIdentifierSweepCallbackToken,
  signPrescreenCallbackToken,
  verifyIdentifierScreenCallbackToken,
  verifyIdentifierSweepCallbackToken,
  verifyPrescreenCallbackToken,
} from "../src/services/github";
import {
  IDENTIFIER_SWEEP_CALLBACK_PATH,
  IDENTIFIER_SWEEP_MAX_IN_FLIGHT,
  IDENTIFIER_SWEEP_SLICE,
  runIdentifierSweepTick,
} from "../src/services/identifier-sweep";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const SECRET = "sweep-test-secret";
const ADMIN_KEY = "sweep-admin-key-0123456789abcdef0123456789abcdef";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const LEAK = "SMITH";

interface Dispatch {
  event_type: string;
  client_payload: {
    dataset_id: string;
    ref: string;
    request_id: number;
    callback_token: string;
    callback_url: string;
  };
}

let server: Server;
let dispatches: Dispatch[] = [];
let githubRequests: string[] = [];
let dispatchStatus = 204;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;
let adminId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      githubRequests.push(`${req.method} ${url.pathname}`);
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        const body = (await req.json()) as Dispatch;
        if (dispatchStatus < 300) dispatches.push(body);
        return new Response(dispatchStatus < 300 ? null : '{"message":"refused"}', {
          status: dispatchStatus,
        });
      }
      return new Response("not found", { status: 404 });
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
  githubRequests = [];
  dispatchStatus = 204;
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_sweep_test",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

async function seedUser(username: string, role: string, key?: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'approved', ?, 1)`,
    [username, `${username}@example.org`, role],
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  if (key) {
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      id,
      await hashApiKey(key),
      key.slice(0, 8),
    );
  }
  return id;
}

interface SeedOpts {
  visibility?: string;
  status?: string;
  withdrawn?: boolean;
  githubRepo?: string | null;
  versions?: string[];
  stamps?: Record<string, unknown> | null;
}

function seedDataset(id: string, opts: SeedOpts = {}): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo,
                           withdrawn_at, sweep_stamps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `Dataset ${id}`,
      ownerId,
      opts.status ?? "active",
      opts.visibility ?? "public",
      opts.githubRepo === undefined ? `nemarDatasets/${id}` : opts.githubRepo,
      opts.withdrawn ? "2026-10-01 00:00:00" : null,
      opts.stamps ? JSON.stringify(opts.stamps) : null,
    ],
  );
  for (const [i, v] of (opts.versions ?? []).entries()) addVersion(id, v, i);
}

function addVersion(id: string, version: string, offsetDays = 0): void {
  db.run(
    `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
     VALUES (?, ?, ?, datetime('now', ?))`,
    [id, version, `10.82901/${id}.${version}`, `-${30 - offsetDays} days`],
  );
}

function stamps(id: string): Record<string, unknown> {
  const raw = db
    .query<{ s: string | null }, [string]>(
      "SELECT sweep_stamps AS s FROM datasets WHERE dataset_id = ?",
    )
    .get(id)?.s;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function rawStamps(id: string): string | null {
  return (
    db
      .query<{ s: string | null }, [string]>(
        "SELECT sweep_stamps AS s FROM datasets WHERE dataset_id = ?",
      )
      .get(id)?.s ?? null
  );
}

/** Move a stamp time back by `modifier` (an SQLite datetime modifier such as `-7 hours`). */
function age(id: string, key: string, modifier: string): void {
  db.run(
    `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.${key}', datetime('now', ?))
      WHERE dataset_id = ?`,
    [modifier, id],
  );
}

function scanBody(datasetId: string, status: string, extra: Record<string, unknown> = {}) {
  const incomplete = status === "unchecked";
  return {
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: HEAD,
    scan: {
      id: datasetId,
      version: null,
      scanned_at: "2026-10-05T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete,
      incomplete_reasons: incomplete ? ["deadline"] : [],
      files: {
        total: 10,
        edf_bdf: 4,
        header_read: incomplete ? 3 : 4,
        header_read_failed: 0,
      },
      ...extra,
    },
  };
}

function postCallback(body: unknown, token: string, bindings: Bindings = env()) {
  return app.request(
    "/webhooks/identifier-sweep-result",
    {
      method: "POST",
      headers: { "X-Webhook-Token": token, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    bindings,
  );
}

/** Answer the dispatch for `datasetId` the way the workflow would. */
async function answer(datasetId: string, report: unknown, bindings: Bindings = env()) {
  const d = dispatches.find((x) => x.client_payload.dataset_id === datasetId);
  if (!d) throw new Error(`no dispatch for ${datasetId}`);
  return postCallback(
    { dataset_id: datasetId, request_id: 0, workflow_run_id: "123", report },
    d.client_payload.callback_token,
    bindings,
  );
}

const dispatchedIds = () => dispatches.map((d) => d.client_payload.dataset_id);

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/webhooks", webhooks);
  app.route("/admin", adminRoutes);
  ownerId = await seedUser("sweepowner", "member");
  adminId = await seedUser("sweepadmin", "admin", ADMIN_KEY);
});

describe("the callback token", () => {
  const PAYLOAD = { datasetId: "nm000500", nonce: "11111111-2222-3333-4444-555555555555" };

  test("round-trips and binds the dataset and the nonce", async () => {
    const token = await signIdentifierSweepCallbackToken(PAYLOAD, SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyIdentifierSweepCallbackToken(token, PAYLOAD, SECRET)).toBe(true);
    for (const other of [
      { ...PAYLOAD, datasetId: "nm000501" },
      { ...PAYLOAD, nonce: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    ]) {
      expect(await verifyIdentifierSweepCallbackToken(token, other, SECRET)).toBe(false);
    }
    expect(await verifyIdentifierSweepCallbackToken(token, PAYLOAD, "rotated")).toBe(false);
    expect(signIdentifierSweepCallbackToken(PAYLOAD, "")).rejects.toThrow(/secret is required/);
  });

  test("is its own kind: it opens neither the publication screen's door nor the pre-screen's, nor they its", async () => {
    // Same secret, so the domain tag (and the field layout under it) is what keeps
    // the kinds apart. A request id of 0 is what the sweep's dispatch carries.
    const sweep = await signIdentifierSweepCallbackToken(PAYLOAD, SECRET);
    const asRequest = { datasetId: PAYLOAD.datasetId, requestId: 0, nonce: PAYLOAD.nonce };
    expect(await verifyIdentifierScreenCallbackToken(sweep, asRequest, SECRET)).toBe(false);
    expect(await verifyPrescreenCallbackToken(sweep, asRequest, SECRET)).toBe(false);
    const screen = await signIdentifierScreenCallbackToken(asRequest, SECRET);
    const pre = await signPrescreenCallbackToken(asRequest, SECRET);
    expect(await verifyIdentifierSweepCallbackToken(screen, PAYLOAD, SECRET)).toBe(false);
    expect(await verifyIdentifierSweepCallbackToken(pre, PAYLOAD, SECRET)).toBe(false);
  });
});

describe("what the tick selects", () => {
  test("only active, public, not withdrawn, non-sandbox datasets are dispatched", async () => {
    seedDataset("nm000500");
    seedDataset("on000501");
    seedDataset("nm000502", { visibility: "private" });
    seedDataset("nm000503", { withdrawn: true });
    seedDataset("nm000504", { status: "deleted" });
    seedDataset("xx000505");
    const r = await runIdentifierSweepTick(env());
    expect(r.errors).toEqual([]);
    expect(dispatchedIds().sort()).toEqual(["nm000500", "on000501"]);
    // Nothing out of scope was even claimed.
    for (const id of ["nm000502", "nm000503", "nm000504", "xx000505"]) {
      expect(rawStamps(id)).toBeNull();
    }
  });

  test("the dispatch is the screen workflow's, with the sweep's callback and a token for the stored nonce", async () => {
    seedDataset("nm000500", { versions: ["1.0.0"] });
    await runIdentifierSweepTick(env());
    expect(dispatches).toHaveLength(1);
    const d = dispatches[0] as Dispatch;
    expect(d.event_type).toBe("run-identifier-screen");
    expect(d.client_payload.dataset_id).toBe("nm000500");
    expect(d.client_payload.ref).toBe("main");
    expect(d.client_payload.request_id).toBe(0);
    expect(d.client_payload.callback_url).toBe(
      `https://api.test.nemar.org${IDENTIFIER_SWEEP_CALLBACK_PATH}`,
    );
    const s = stamps("nm000500");
    expect(s.identifier_sweep_attempt).toBe("pending");
    expect(s.identifier_sweep_attempt_version).toBe("1.0.0");
    expect(typeof s.identifier_sweep_attempted_at).toBe("string");
    expect(
      await verifyIdentifierSweepCallbackToken(
        d.client_payload.callback_token,
        { datasetId: "nm000500", nonce: s.identifier_sweep_nonce as string },
        SECRET,
      ),
    ).toBe(true);
    // One mint (a PAT here, so none) and one dispatch: nothing else touched GitHub.
    expect(githubRequests).toEqual(["POST /repos/nemarDatasets/.github/dispatches"]);
  });

  test(`a tick dispatches at most ${IDENTIFIER_SWEEP_SLICE}, and the rest wait for later ticks`, async () => {
    for (let i = 0; i < 8; i++) seedDataset(`nm00051${i}`);
    const r = await runIdentifierSweepTick(env());
    expect(r.dispatched).toBe(IDENTIFIER_SWEEP_SLICE);
    expect(dispatches).toHaveLength(IDENTIFIER_SWEEP_SLICE);
    // The aggregate budget: one dispatch call per dispatched dataset, nothing more.
    expect(githubRequests).toHaveLength(IDENTIFIER_SWEEP_SLICE);
  });

  test(`no more than ${IDENTIFIER_SWEEP_MAX_IN_FLIGHT} sweep screens are ever in flight`, async () => {
    for (let i = 0; i < 9; i++) seedDataset(`nm00052${i}`);
    await runIdentifierSweepTick(env());
    await runIdentifierSweepTick(env());
    expect(dispatches).toHaveLength(IDENTIFIER_SWEEP_MAX_IN_FLIGHT);
    const third = await runIdentifierSweepTick(env());
    expect(third.inFlight).toBe(IDENTIFIER_SWEEP_MAX_IN_FLIGHT);
    expect(third.dispatched).toBe(0);
    expect(dispatches).toHaveLength(IDENTIFIER_SWEEP_MAX_IN_FLIGHT);

    // One of them reports: one slot opens, and only one more is dispatched.
    dispatches = [];
    db.run(
      `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_attempt', 'reported')
        WHERE dataset_id = 'nm000520'`,
    );
    const fourth = await runIdentifierSweepTick(env());
    expect(fourth.inFlight).toBe(IDENTIFIER_SWEEP_MAX_IN_FLIGHT - 1);
    expect(fourth.dispatched).toBe(1);
  });

  test("a tick that cannot count what is in flight dispatches nothing", async () => {
    seedDataset("nm000530");
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql.includes("COUNT(*) AS n FROM datasets d") && sql.includes("= 'pending'")) {
        throw new Error("D1 unavailable");
      }
    });
    const r = await runIdentifierSweepTick({ ...env(), DB: failing });
    expect(r.inFlight).toBeNull();
    expect(r.dispatched).toBe(0);
    expect(dispatches).toHaveLength(0);
    expect(rawStamps("nm000530")).toBeNull();
  });

  test("order: a requested rescreen, then never attempted, then a newer version, then the oldest attempt", async () => {
    // Three datasets screened through the real tick and callback, then moved into
    // the state each case needs; a fourth is never attempted.
    for (const id of ["nm000541", "nm000542", "nm000544"]) seedDataset(id, { versions: ["1.0.0"] });
    await runIdentifierSweepTick(env());
    for (const id of ["nm000541", "nm000542", "nm000544"]) {
      expect((await answer(id, scanBody(id, "clean"))).status).toBe(200);
    }
    seedDataset("nm000543");
    // Due by age: its verdict is past the refresh, and its attempt is the oldest.
    age("nm000541", "identifier_sweep_checked_at", "-22 days");
    age("nm000541", "identifier_sweep_attempted_at", "-22 days");
    // Due by a newer version, attempted more recently than nm000541.
    age("nm000542", "identifier_sweep_attempted_at", "-2 days");
    addVersion("nm000542", "1.1.0", 5);
    // Fresh and current, so due only because an administrator asks.
    age("nm000544", "identifier_sweep_attempted_at", "-1 days");
    const req = await app.request(
      "/admin/identifier-sweep/nm000544/rescreen",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(req.status).toBe(200);

    dispatches = [];
    await runIdentifierSweepTick(env());
    const first = dispatchedIds();
    dispatches = [];
    await runIdentifierSweepTick(env());
    expect([...first, ...dispatchedIds()]).toEqual([
      "nm000544",
      "nm000543",
      "nm000542",
      "nm000541",
    ]);
    // The request was answered by the dispatch, so it is not asked again.
    expect(stamps("nm000544").identifier_sweep_requested_at).toBeUndefined();
  });
});

describe("storing a result", () => {
  test("a scan becomes the verdict, credited to the version its screen was dispatched for", async () => {
    seedDataset("nm000600", { versions: ["1.0.0"] });
    await runIdentifierSweepTick(env());
    // A version published while the screen ran is NOT credited to it.
    addVersion("nm000600", "1.1.0", 10);
    const res = await answer(
      "nm000600",
      scanBody("nm000600", "direct-identifiers", {
        findings_by_kind: { "edf-patient-name": 4 },
        edf_bdf_files_flagged: 4,
      }),
    );
    expect(res.status).toBe(200);
    // The answer carries no verdict: the workflow does not need it and its logs are public.
    expect(await res.json()).toEqual({ ok: true, dataset_id: "nm000600" });
    const s = stamps("nm000600");
    expect(s.identifier_sweep_status).toBe("direct-identifiers");
    expect(s.identifier_sweep_version).toBe("1.0.0");
    expect(s.identifier_sweep_attempt).toBe("reported");
    expect(s.identifier_sweep_nonce).toBeUndefined();
    expect(typeof s.identifier_sweep_checked_at).toBe("string");
    const report = s.identifier_sweep_report as {
      head: string;
      scan: { findings_by_kind: unknown };
    };
    expect(report.head).toBe(HEAD);
    expect(report.scan.findings_by_kind).toEqual({ "edf-patient-name": 4 });
    // And because the version moved, the dataset is due again at once.
    dispatches = [];
    age("nm000600", "identifier_sweep_attempted_at", "-7 hours");
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000600"]);
  });

  test("one-shot: a replay, a stale token and a wrong token are refused alike", async () => {
    seedDataset("nm000601");
    await runIdentifierSweepTick(env());
    const token = (dispatches[0] as Dispatch).client_payload.callback_token;
    const body = { dataset_id: "nm000601", request_id: 0, report: scanBody("nm000601", "clean") };
    expect((await postCallback(body, "0".repeat(64))).status).toBe(401);
    expect((await postCallback(body, token)).status).toBe(200);
    expect((await postCallback(body, token)).status).toBe(401);
    expect(stamps("nm000601").identifier_sweep_status).toBe("clean");
  });

  test("the body is checked before anything is read: dataset id, request id, size, shape", async () => {
    seedDataset("nm000602");
    await runIdentifierSweepTick(env());
    const token = (dispatches[0] as Dispatch).client_payload.callback_token;
    const report = scanBody("nm000602", "clean");
    expect((await postCallback({ dataset_id: "../x", request_id: 0, report }, token)).status).toBe(
      400,
    );
    // A publication request's id: this is not that door.
    expect(
      (await postCallback({ dataset_id: "nm000602", request_id: 7, report }, token)).status,
    ).toBe(400);
    expect((await postCallback("[1,2]", token)).status).toBe(400);
    expect((await postCallback("{", token)).status).toBe(400);
    const res = await app.request(
      "/webhooks/identifier-sweep-result",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env(),
    );
    expect(res.status).toBe(401);
    expect(stamps("nm000602").identifier_sweep_attempt).toBe("pending");
  });

  test("a body outside the contract is the attempt's workflow-failed, and its text reaches nothing", async () => {
    seedDataset("nm000603");
    // A verdict already on the row must survive a failed attempt untouched.
    await runIdentifierSweepTick(env());
    await answer("nm000603", scanBody("nm000603", "clean"));
    const verdictBefore = {
      status: stamps("nm000603").identifier_sweep_status,
      checked: stamps("nm000603").identifier_sweep_checked_at,
      report: stamps("nm000603").identifier_sweep_report,
    };
    age("nm000603", "identifier_sweep_checked_at", "-22 days");
    age("nm000603", "identifier_sweep_attempted_at", "-22 days");
    const agedChecked = stamps("nm000603").identifier_sweep_checked_at;
    dispatches = [];
    await runIdentifierSweepTick(env());
    const hostile = scanBody("nm000603", "clean", { patient_name: LEAK });
    const res = await answer("nm000603", hostile);
    expect(res.status).toBe(200);
    const s = stamps("nm000603");
    expect(s.identifier_sweep_attempt).toBe("error");
    expect(s.identifier_sweep_attempt_error).toBe("workflow-failed");
    // The verdict is the one from before, and its time did NOT move.
    expect(s.identifier_sweep_status).toBe(verdictBefore.status);
    expect(s.identifier_sweep_report).toEqual(verdictBefore.report);
    expect(s.identifier_sweep_checked_at).toBe(agedChecked);
    expect(rawStamps("nm000603")).not.toContain(LEAK);
  });

  test("a scan of another dataset is refused as workflow-failed, not stored under this one", async () => {
    seedDataset("nm000604");
    await runIdentifierSweepTick(env());
    await answer("nm000604", scanBody("nm000999", "clean"));
    const s = stamps("nm000604");
    expect(s.identifier_sweep_status).toBeUndefined();
    expect(s.identifier_sweep_attempt_error).toBe("workflow-failed");
  });

  test("the workflow's own error word closes the attempt and writes no verdict", async () => {
    seedDataset("nm000605");
    await runIdentifierSweepTick(env());
    await answer("nm000605", { version: 1, scanner: null, head: null, error: "clone-failed" });
    const s = stamps("nm000605");
    expect(s.identifier_sweep_attempt).toBe("error");
    expect(s.identifier_sweep_attempt_error).toBe("clone-failed");
    expect(s.identifier_sweep_status).toBeUndefined();
    expect(s.identifier_sweep_checked_at).toBeUndefined();
    expect(s.identifier_sweep_nonce).toBeUndefined();
  });

  test("nothing in the store path mails anyone", async () => {
    seedDataset("nm000606");
    await withFakeResend(async (calls: CapturedEmail[]) => {
      await runIdentifierSweepTick(env());
      await answer(
        "nm000606",
        scanBody("nm000606", "direct-identifiers", { findings_by_kind: { "edf-patient-name": 1 } }),
      );
      expect(calls).toHaveLength(0);
    });
  });
});

describe("a screen that never reports", () => {
  test("is unreported after the deadline, keeps its nonce, and a late report still lands", async () => {
    seedDataset("nm000610");
    await runIdentifierSweepTick(env());
    const token = (dispatches[0] as Dispatch).client_payload.callback_token;
    age("nm000610", "identifier_sweep_attempted_at", "-49 minutes");
    expect((await runIdentifierSweepTick(env())).timedOut).toBe(0);
    age("nm000610", "identifier_sweep_attempted_at", "-51 minutes");
    expect((await runIdentifierSweepTick(env())).timedOut).toBe(1);
    const s = stamps("nm000610");
    expect(s.identifier_sweep_attempt).toBe("unreported");
    expect(s.identifier_sweep_attempt_error).toBe("no-report-in-time");
    expect(s.identifier_sweep_status).toBeUndefined();
    const late = await postCallback(
      { dataset_id: "nm000610", request_id: 0, report: scanBody("nm000610", "clean") },
      token,
    );
    expect(late.status).toBe(200);
    expect(stamps("nm000610").identifier_sweep_status).toBe("clean");
  });

  test("a pending attempt with no dispatch time is overdue (NULL-safe)", async () => {
    seedDataset("nm000611", {
      stamps: { identifier_sweep_attempt: "pending", identifier_sweep_nonce: "n" },
    });
    const r = await runIdentifierSweepTick(env());
    expect(r.timedOut).toBe(1);
    // Closed, and then (no verdict, no attempt time) dispatched afresh in the same
    // tick, with a dispatch time and a new nonce.
    expect(dispatchedIds()).toEqual(["nm000611"]);
    const s = stamps("nm000611");
    expect(s.identifier_sweep_attempt).toBe("pending");
    expect(typeof s.identifier_sweep_attempted_at).toBe("string");
    expect(s.identifier_sweep_nonce).not.toBe("n");
  });

  test("a later dispatch replaces the nonce, so the older run can no longer answer", async () => {
    seedDataset("nm000612");
    await runIdentifierSweepTick(env());
    const oldToken = (dispatches[0] as Dispatch).client_payload.callback_token;
    age("nm000612", "identifier_sweep_attempted_at", "-7 hours");
    dispatches = [];
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000612"]);
    const body = { dataset_id: "nm000612", request_id: 0, report: scanBody("nm000612", "clean") };
    expect((await postCallback(body, oldToken)).status).toBe(401);
    expect((await answer("nm000612", scanBody("nm000612", "clean"))).status).toBe(200);
  });
});

describe("a screen that cannot start", () => {
  test("GitHub refusing the dispatch is dispatch-failed on the attempt, and the verdict is untouched", async () => {
    seedDataset("nm000620");
    await runIdentifierSweepTick(env());
    await answer("nm000620", scanBody("nm000620", "clean"));
    const before = stamps("nm000620");
    age("nm000620", "identifier_sweep_checked_at", "-22 days");
    age("nm000620", "identifier_sweep_attempted_at", "-22 days");
    const agedChecked = stamps("nm000620").identifier_sweep_checked_at;
    dispatchStatus = 422;
    const r = await runIdentifierSweepTick(env());
    expect(r.failed).toEqual([{ dataset_id: "nm000620", error: "dispatch-failed" }]);
    const s = stamps("nm000620");
    expect(s.identifier_sweep_attempt).toBe("error");
    expect(s.identifier_sweep_attempt_error).toBe("dispatch-failed");
    expect(s.identifier_sweep_nonce).toBeUndefined();
    expect(s.identifier_sweep_status).toBe(before.identifier_sweep_status);
    expect(s.identifier_sweep_checked_at).toBe(agedChecked);
  });

  test("a Worker without the callback secret or the API base records dispatch-unconfigured, and calls nobody", async () => {
    seedDataset("nm000621");
    seedDataset("nm000622");
    const r1 = await runIdentifierSweepTick(env({ PRESCREEN_CALLBACK_SECRET: undefined }));
    const r2 = await runIdentifierSweepTick(env({ API_BASE_URL: undefined }));
    expect([...r1.failed, ...r2.failed].map((f) => f.error)).toEqual([
      "dispatch-unconfigured",
      "dispatch-unconfigured",
    ]);
    expect(githubRequests).toHaveLength(0);
    expect(stamps("nm000621").identifier_sweep_attempt_error).toBe("dispatch-unconfigured");
  });

  test("a dataset with no repository is dispatch-unconfigured; the others in the tick still go", async () => {
    seedDataset("nm000623", { githubRepo: null });
    seedDataset("nm000624");
    const r = await runIdentifierSweepTick(env());
    expect(r.failed).toEqual([{ dataset_id: "nm000623", error: "dispatch-unconfigured" }]);
    expect(dispatchedIds()).toEqual(["nm000624"]);
  });

  test("a failed attempt waits out the backoff, then is tried again", async () => {
    seedDataset("nm000625");
    dispatchStatus = 500;
    await runIdentifierSweepTick(env());
    dispatchStatus = 204;
    await runIdentifierSweepTick(env());
    expect(dispatches).toHaveLength(0);
    age("nm000625", "identifier_sweep_attempted_at", "-5 hours");
    await runIdentifierSweepTick(env());
    expect(dispatches).toHaveLength(0);
    age("nm000625", "identifier_sweep_attempted_at", "-7 hours");
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000625"]);
  });
});

describe("when a screened dataset is due again", () => {
  async function screened(id: string, status: string, versions: string[] = ["1.0.0"]) {
    seedDataset(id, { versions });
    await runIdentifierSweepTick(env());
    await answer(id, scanBody(id, status));
    age(id, "identifier_sweep_attempted_at", "-7 hours");
    dispatches = [];
  }

  test("a fresh verdict of the current version is not due, whatever it found", async () => {
    // The cadence must not depend on the verdict: the public run list names the
    // dataset each screen reads, so a flagged dataset screened more often would be
    // pointed out to anyone reading it (ADR 0087).
    for (const [id, status] of [
      ["nm000630", "clean"],
      ["nm000631", "direct-identifiers"],
      ["nm000632", "review"],
      ["nm000633", "unchecked"],
      ["nm000634", "not-screened"],
    ] as const) {
      await screened(id, status);
    }
    await runIdentifierSweepTick(env());
    expect(dispatches).toHaveLength(0);
  });

  test("a verdict past the refresh is due again", async () => {
    await screened("nm000635", "clean");
    age("nm000635", "identifier_sweep_checked_at", "-20 days");
    await runIdentifierSweepTick(env());
    expect(dispatches).toHaveLength(0);
    age("nm000635", "identifier_sweep_checked_at", "-22 days");
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000635"]);
  });

  test("a dataset with no versions on either side is not re-armed (NULL-safe), and gains one when it is", async () => {
    await screened("nm000636", "clean", []);
    await runIdentifierSweepTick(env());
    expect(dispatches).toHaveLength(0);
    addVersion("nm000636", "1.0.0");
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000636"]);
  });

  test("a stored status that is not a status reads as no verdict, so the dataset is due", async () => {
    await screened("nm000637", "clean");
    db.run(
      `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_status', 'fine')
        WHERE dataset_id = 'nm000637'`,
    );
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000637"]);
  });
});

describe("an administrator's rescreen", () => {
  function rescreen(id: string, bindings: Bindings = env()) {
    return app.request(
      `/admin/identifier-sweep/${id}/rescreen`,
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      bindings,
    );
  }

  test("404 for no dataset, 409 out of scope, 400 for a malformed id; audited when it lands", async () => {
    seedDataset("nm000640", { visibility: "private" });
    seedDataset("nm000641");
    expect((await rescreen("nm000999")).status).toBe(404);
    expect((await rescreen("nm000640")).status).toBe(409);
    expect((await rescreen("abc")).status).toBe(400);
    expect((await rescreen("nm000641")).status).toBe(200);
    const audit = db
      .query<{ user_id: number; resource_id: string }, []>(
        "SELECT user_id, resource_id FROM audit_log WHERE action = 'identifier_sweep_rescreen_requested'",
      )
      .all();
    expect(audit).toEqual([{ user_id: adminId, resource_id: "nm000641" }]);
  });

  test("bypasses the backoff but never a screen in flight", async () => {
    seedDataset("nm000642");
    await runIdentifierSweepTick(env());
    const first = dispatches[0] as Dispatch;
    expect((await rescreen("nm000642")).status).toBe(200);
    dispatches = [];
    await runIdentifierSweepTick(env());
    expect(dispatches).toHaveLength(0); // still pending, within the deadline
    dispatches = [first];
    await answer("nm000642", scanBody("nm000642", "clean"));
    dispatches = [];
    await runIdentifierSweepTick(env());
    // The verdict is minutes old and the attempt inside the backoff; the request moves it.
    expect(dispatchedIds()).toEqual(["nm000642"]);
  });

  test("on a dev worker it is a D1 write only: nothing is dispatched", async () => {
    seedDataset("nm000643");
    expect((await rescreen("nm000643", env({ ENVIRONMENT: "staging" }))).status).toBe(200);
    await runIdentifierSweepTick(env({ ENVIRONMENT: "staging" }));
    expect(githubRequests).toHaveLength(0);
  });
});

describe("production only", () => {
  for (const environment of ["development", "staging", "test"]) {
    test(`ENVIRONMENT=${environment}: no dispatch, no mail, no write`, async () => {
      seedDataset("nm000650");
      seedDataset("nm000651", {
        stamps: {
          identifier_sweep_attempt: "pending",
          identifier_sweep_nonce: "n",
          identifier_sweep_attempted_at: "2026-01-01 00:00:00",
        },
      });
      const before = [rawStamps("nm000650"), rawStamps("nm000651")];
      await withFakeResend(async (calls: CapturedEmail[]) => {
        const r = await runIdentifierSweepTick(env({ ENVIRONMENT: environment }));
        expect(r.skipped).toBe(true);
        expect(calls).toHaveLength(0);
      });
      expect(githubRequests).toHaveLength(0);
      expect([rawStamps("nm000650"), rawStamps("nm000651")]).toEqual(before);
    });
  }

  test("an unset ENVIRONMENT is treated as production (the fail-closed helper), so the fence is that helper", async () => {
    seedDataset("nm000652");
    const r = await runIdentifierSweepTick(env({ ENVIRONMENT: undefined }));
    expect(r.skipped).toBe(false);
    expect(dispatchedIds()).toEqual(["nm000652"]);
  });
});
