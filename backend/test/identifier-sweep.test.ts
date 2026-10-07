/**
 * The scheduled identifier sweep, through its real entry points (epic #1610,
 * phase 5, ADR 0088).
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
import { parseScreenReport } from "../../shared/identifier-screen-report";
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
  IDENTIFIER_SWEEP_CLAIM_SQL,
  IDENTIFIER_SWEEP_DISPATCH_TIMEOUT_MS,
  IDENTIFIER_SWEEP_LATE_REPORT_HOURS,
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
/** When true, the stand-in never answers a dispatch: the lost-answer case a timeout must end. */
let dispatchHang = false;
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
        if (dispatchHang) return new Promise<Response>(() => {});
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
  dispatchHang = false;
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
  // `unchecked` is always incomplete; any status may be, when the caller says so.
  const incomplete = status === "unchecked" || extra.incomplete === true;
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
      // A dataset with no recordings has no EDF/BDF to read; the contract checks it.
      files:
        status === "no-recordings"
          ? { total: 10, edf_bdf: 0, header_read: 0, header_read_failed: 0 }
          : { total: 10, edf_bdf: 4, header_read: incomplete ? 3 : 4, header_read_failed: 0 },
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

/** Ask for a rescreen through the real admin route; the status code. */
async function rescreenAs(id: string): Promise<number> {
  const res = await app.request(
    `/admin/identifier-sweep/${id}/rescreen`,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
  return res.status;
}

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
  test("GitHub refusing the dispatch (a 4xx) is dispatch-failed on the attempt, and the verdict is untouched", async () => {
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
    expect(r.dispatched).toBe(0);
    const s = stamps("nm000620");
    expect(s.identifier_sweep_attempt).toBe("error");
    expect(s.identifier_sweep_attempt_error).toBe("dispatch-failed");
    expect(s.identifier_sweep_nonce).toBeUndefined();
    expect(s.identifier_sweep_failures).toBe(1);
    expect(s.identifier_sweep_status).toBe(before.identifier_sweep_status);
    expect(s.identifier_sweep_checked_at).toBe(agedChecked);
  });

  test("a lost answer (a 5xx) leaves the attempt pending with its nonce, so a run that did start still lands", async () => {
    seedDataset("nm000626");
    dispatchStatus = 502;
    const r = await runIdentifierSweepTick(env());
    expect(r.dispatched).toBe(0);
    expect(r.unconfirmed).toEqual(["nm000626"]);
    expect(r.failed).toEqual([]);
    const s = stamps("nm000626");
    expect(s.identifier_sweep_attempt).toBe("pending");
    const token = await signIdentifierSweepCallbackToken(
      { datasetId: "nm000626", nonce: s.identifier_sweep_nonce as string },
      SECRET,
    );
    const res = await postCallback(
      { dataset_id: "nm000626", request_id: 0, report: scanBody("nm000626", "clean") },
      token,
    );
    expect(res.status).toBe(200);
    expect(stamps("nm000626").identifier_sweep_status).toBe("clean");
  });

  test(
    "a dispatch GitHub never answers is cut off by the timeout and left pending, not hung on",
    async () => {
      seedDataset("nm000629");
      dispatchHang = true;
      const started = Date.now();
      const r = await runIdentifierSweepTick(env());
      expect(Date.now() - started).toBeLessThan(IDENTIFIER_SWEEP_DISPATCH_TIMEOUT_MS + 5_000);
      expect(r.unconfirmed).toEqual(["nm000629"]);
      expect(stamps("nm000629").identifier_sweep_attempt).toBe("pending");
    },
    { timeout: IDENTIFIER_SWEEP_DISPATCH_TIMEOUT_MS + 10_000 },
  );

  test("a Worker without the callback secret or the API base claims nothing, stamps nothing and calls nobody", async () => {
    seedDataset("nm000621");
    seedDataset("nm000622");
    const r1 = await runIdentifierSweepTick(env({ PRESCREEN_CALLBACK_SECRET: undefined }));
    const r2 = await runIdentifierSweepTick(env({ API_BASE_URL: undefined }));
    for (const r of [r1, r2]) {
      expect(r.blocked).toBe("dispatch-unconfigured");
      expect(r.candidates).toBe(2);
      expect(r.dispatched).toBe(0);
      expect(r.failed).toEqual([]);
    }
    expect(githubRequests).toHaveLength(0);
    // No dataset is held back by a fault that is not its own.
    expect(rawStamps("nm000621")).toBeNull();
    expect(rawStamps("nm000622")).toBeNull();
  });

  test("a GitHub App token that cannot be minted blocks the tick as dispatch-failed, before any claim", async () => {
    seedDataset("nm000627");
    const r = await runIdentifierSweepTick(
      env({
        GITHUB_ADMIN_PAT: undefined,
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "not a private key",
        GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "42",
      } as Partial<Bindings>),
    );
    expect(r.blocked).toBe("dispatch-failed");
    expect(dispatches).toHaveLength(0);
    expect(rawStamps("nm000627")).toBeNull();
  });

  test("a dataset with no repository is dispatch-unconfigured; the others in the tick still go", async () => {
    seedDataset("nm000623", { githubRepo: null });
    seedDataset("nm000624");
    const r = await runIdentifierSweepTick(env());
    expect(r.failed).toEqual([{ dataset_id: "nm000623", error: "dispatch-unconfigured" }]);
    expect(r.dispatched).toBe(1);
    expect(dispatchedIds()).toEqual(["nm000624"]);
  });

  test("the backoff grows with failures in a row, and a verdict resets it", async () => {
    // A dataset whose screen always fails is tried every 6 hours at first and then
    // less and less often, never four times a day forever.
    seedDataset("nm000625");
    dispatchStatus = 422;
    const tickAfter = async (hoursAgo: number) => {
      age("nm000625", "identifier_sweep_attempted_at", `-${hoursAgo} hours`);
      dispatches = [];
      githubRequests = [];
      await runIdentifierSweepTick(env());
      return githubRequests.length;
    };
    await runIdentifierSweepTick(env()); // failure 1
    expect(stamps("nm000625").identifier_sweep_failures).toBe(1);
    expect(await tickAfter(5)).toBe(0);
    expect(await tickAfter(7)).toBe(1); // failure 2
    expect(await tickAfter(11)).toBe(0);
    expect(await tickAfter(13)).toBe(1); // failure 3
    expect(await tickAfter(23)).toBe(0);
    expect(await tickAfter(25)).toBe(1); // failure 4
    expect(await tickAfter(47)).toBe(0);
    expect(await tickAfter(49)).toBe(1); // failure 5
    expect(await tickAfter(95)).toBe(0);
    expect(await tickAfter(97)).toBe(1); // failure 6, and it stays at 96 hours
    expect(await tickAfter(95)).toBe(0);
    expect(stamps("nm000625").identifier_sweep_failures).toBe(6);
    // GitHub accepts, the screen reports: the count is gone, and so is the long wait.
    dispatchStatus = 204;
    expect(await tickAfter(97)).toBe(1);
    await answer("nm000625", scanBody("nm000625", "clean"));
    expect(stamps("nm000625").identifier_sweep_failures).toBeUndefined();
  });

  test("an unreported screen counts as a failure once, and a late error report does not count it again", async () => {
    seedDataset("nm000628");
    await runIdentifierSweepTick(env());
    const token = (dispatches[0] as Dispatch).client_payload.callback_token;
    age("nm000628", "identifier_sweep_attempted_at", "-51 minutes");
    await runIdentifierSweepTick(env());
    expect(stamps("nm000628").identifier_sweep_failures).toBe(1);
    await postCallback(
      {
        dataset_id: "nm000628",
        request_id: 0,
        report: { version: 1, scanner: null, head: null, error: "deadline" },
      },
      token,
    );
    const s = stamps("nm000628");
    expect(s.identifier_sweep_attempt_error).toBe("deadline");
    expect(s.identifier_sweep_failures).toBe(1);
  });
});

describe("statement failures", () => {
  test("a failed unreported pass is reported, and the tick still dispatches", async () => {
    seedDataset("nm000690");
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql.includes("'no-report-in-time'") && sql.startsWith("UPDATE")) throw new Error("boom");
    });
    const r = await runIdentifierSweepTick({ ...env(), DB: failing });
    expect(r.timedOut).toBeNull();
    expect(r.errors[0]).toStartWith("unreported pass failed");
    expect(r.dispatched).toBe(1);
  });

  test("a failed candidate query dispatches nothing and says so", async () => {
    seedDataset("nm000691");
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql.includes("LIMIT ?") && sql.includes("d.github_repo")) throw new Error("boom");
    });
    const r = await runIdentifierSweepTick({ ...env(), DB: failing });
    expect(r.errors[0]).toStartWith("candidate query failed");
    expect(dispatches).toHaveLength(0);
    expect(rawStamps("nm000691")).toBeNull();
  });

  test("a failure that cannot be recorded leaves the attempt pending, for the unreported pass to close", async () => {
    seedDataset("nm000692");
    dispatchStatus = 422;
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql.includes("'error'") && sql.startsWith("UPDATE")) throw new Error("boom");
    });
    const r = await runIdentifierSweepTick({ ...env(), DB: failing });
    expect(r.failed).toEqual([{ dataset_id: "nm000692", error: "dispatch-failed" }]);
    expect(r.errors[0]).toStartWith("recording the failed dispatch of nm000692 failed");
    expect(stamps("nm000692").identifier_sweep_attempt).toBe("pending");
    age("nm000692", "identifier_sweep_attempted_at", "-51 minutes");
    expect((await runIdentifierSweepTick(env())).timedOut).toBe(1);
  });

  test("a database error while storing answers 500 and keeps the nonce, so the workflow's retry lands", async () => {
    seedDataset("nm000693");
    await runIdentifierSweepTick(env());
    let fail = true;
    const flaky = interceptingD1(realD1(db), (sql) => {
      if (fail && sql.includes("'reported'")) throw new Error("D1 unavailable");
    });
    const first = await answer("nm000693", scanBody("nm000693", "clean"), { ...env(), DB: flaky });
    expect(first.status).toBe(500);
    expect(stamps("nm000693").identifier_sweep_attempt).toBe("pending");
    fail = false;
    const retry = await answer("nm000693", scanBody("nm000693", "clean"), { ...env(), DB: flaky });
    expect(retry.status).toBe(200);
    expect(stamps("nm000693").identifier_sweep_status).toBe("clean");
  });
});

describe("the claim's own guard", () => {
  test("a dataset that leaves scope between selection and claim is not dispatched", async () => {
    seedDataset("nm000695");
    const racing = interceptingD1(realD1(db), (sql) => {
      if (sql === IDENTIFIER_SWEEP_CLAIM_SQL) {
        db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000695'");
      }
    });
    const r = await runIdentifierSweepTick({ ...env(), DB: racing });
    expect(r.candidates).toBe(1);
    expect(r.unclaimed).toBe(1);
    expect(dispatches).toHaveLength(0);
    expect(rawStamps("nm000695")).toBeNull();
  });

  test("stamps that turn into a non-object between selection and claim are not claimed", async () => {
    seedDataset("nm000694");
    const racing = interceptingD1(realD1(db), (sql) => {
      if (sql === IDENTIFIER_SWEEP_CLAIM_SQL) {
        db.run("UPDATE datasets SET sweep_stamps = '[]' WHERE dataset_id = 'nm000694'");
      }
    });
    const r = await runIdentifierSweepTick({ ...env(), DB: racing });
    expect(r.unclaimed).toBe(1);
    expect(dispatches).toHaveLength(0);
  });

  test("two ticks racing for the same datasets dispatch each one once", async () => {
    seedDataset("nm000696");
    seedDataset("nm000697");
    let raced = false;
    const racing = interceptingD1(realD1(db), async (sql) => {
      // Between this tick's selection and its first claim, another tick runs whole.
      if (!raced && sql === IDENTIFIER_SWEEP_CLAIM_SQL) {
        raced = true;
        await runIdentifierSweepTick(env());
      }
    });
    const r = await runIdentifierSweepTick({ ...env(), DB: racing });
    expect(r.unclaimed).toBe(2);
    expect(dispatchedIds().sort()).toEqual(["nm000696", "nm000697"]);
  });
});

describe("rows the sweep cannot write", () => {
  test("stamps that are not an object are never claimed, and a rescreen says why", async () => {
    // json_set on a JSON array changes nothing yet counts the row as changed, so a
    // claim would report a write it never made and dispatch with a nonce it never stored.
    seedDataset("nm000698", { stamps: null });
    db.run("UPDATE datasets SET sweep_stamps = '[]' WHERE dataset_id = 'nm000698'");
    const r = await runIdentifierSweepTick(env());
    expect(r.candidates).toBe(0);
    expect(dispatches).toHaveLength(0);
    const res = await app.request(
      "/admin/identifier-sweep/nm000698/rescreen",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("not a JSON object");
    expect(rawStamps("nm000698")).toBe("[]");
  });

  test("a verdict with no report object is no verdict: the dataset is due", async () => {
    seedDataset("nm000689");
    await runIdentifierSweepTick(env());
    await answer("nm000689", scanBody("nm000689", "clean"));
    age("nm000689", "identifier_sweep_attempted_at", "-7 hours");
    db.run(
      `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_report', 'gone')
        WHERE dataset_id = 'nm000689'`,
    );
    dispatches = [];
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000689"]);
  });

  test("a verdict time in the future is no verdict: the dataset is due", async () => {
    seedDataset("nm000699");
    await runIdentifierSweepTick(env());
    await answer("nm000699", scanBody("nm000699", "clean"));
    age("nm000699", "identifier_sweep_attempted_at", "-7 hours");
    age("nm000699", "identifier_sweep_checked_at", "+30 days");
    dispatches = [];
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000699"]);
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
    // pointed out to anyone reading it (ADR 0088).
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

describe("scope edges", () => {
  test("only a well-formed xx id is exempt; a malformed one is screened", async () => {
    // The GLOB is the publication screen's own rule. A `LIKE 'xx%'` would wave
    // through a row that merely starts with the letters.
    seedDataset("xx12345");
    seedDataset("xxabc123");
    seedDataset("xx000123");
    await runIdentifierSweepTick(env());
    expect(dispatchedIds().sort()).toEqual(["xx12345", "xxabc123"]);
  });

  test("an anonymous deposit (a public row over a private repository) is screened", async () => {
    seedDataset("nm000700");
    db.run("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000700'");
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000700"]);
  });

  test("a pending screen of a dataset made private still holds its in-flight slot", async () => {
    for (let i = 0; i < 6; i++) seedDataset(`nm00071${i}`);
    await runIdentifierSweepTick(env());
    await runIdentifierSweepTick(env());
    expect(dispatches).toHaveLength(6);
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000710'");
    seedDataset("nm000719");
    const r = await runIdentifierSweepTick(env());
    expect(r.inFlight).toBe(6);
    expect(r.dispatched).toBe(0);
  });
});

describe("late reports and the verdict", () => {
  test("unreported leaves a standing verdict exactly as it was", async () => {
    seedDataset("nm000720", { versions: ["1.0.0"] });
    await runIdentifierSweepTick(env());
    await answer(
      "nm000720",
      scanBody("nm000720", "direct-identifiers", { findings_by_kind: { "edf-patient-name": 1 } }),
    );
    const before = stamps("nm000720");
    expect(await rescreenAs("nm000720")).toBe(200);
    dispatches = [];
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000720"]);
    age("nm000720", "identifier_sweep_attempted_at", "-51 minutes");
    expect((await runIdentifierSweepTick(env())).timedOut).toBe(1);
    const after = stamps("nm000720");
    expect(after.identifier_sweep_attempt).toBe("unreported");
    for (const key of [
      "identifier_sweep_status",
      "identifier_sweep_report",
      "identifier_sweep_checked_at",
      "identifier_sweep_version",
    ]) {
      expect(after[key]).toEqual(before[key]);
    }
  });

  test(`a report for an unreported screen is refused once it is older than ${IDENTIFIER_SWEEP_LATE_REPORT_HOURS} hours`, async () => {
    seedDataset("nm000721");
    await runIdentifierSweepTick(env());
    const token = (dispatches[0] as Dispatch).client_payload.callback_token;
    age("nm000721", "identifier_sweep_attempted_at", "-51 minutes");
    await runIdentifierSweepTick(env());
    expect(stamps("nm000721").identifier_sweep_attempt).toBe("unreported");
    age(
      "nm000721",
      "identifier_sweep_attempted_at",
      `-${IDENTIFIER_SWEEP_LATE_REPORT_HOURS + 1} hours`,
    );
    const body = { dataset_id: "nm000721", request_id: 0, report: scanBody("nm000721", "clean") };
    expect((await postCallback(body, token)).status).toBe(401);
    expect(stamps("nm000721").identifier_sweep_status).toBeUndefined();
    age(
      "nm000721",
      "identifier_sweep_attempted_at",
      `-${IDENTIFIER_SWEEP_LATE_REPORT_HOURS - 1} hours`,
    );
    expect((await postCallback(body, token)).status).toBe(200);
  });

  test("what is stored is a projection that still parses: no sampling, read failures or distinct counts", async () => {
    seedDataset("nm000722");
    await runIdentifierSweepTick(env());
    await answer(
      "nm000722",
      scanBody("nm000722", "clean", {
        sampling: {
          edf_headers: { candidates: 4, oversize: 0, selected: 4, scanned: 4 },
          scans_tables: { candidates: 0, oversize: 0, selected: 0, scanned: 0 },
          json_files: { candidates: 1, oversize: 0, selected: 1, scanned: 1 },
          text_files: { candidates: 0, oversize: 0, selected: 0, scanned: 0 },
        },
        distinct_patient_field_values: 3,
        read_failures: { "json/timeout": 0 },
      }),
    );
    const report = stamps("nm000722").identifier_sweep_report as { scan: Record<string, unknown> };
    expect(Object.keys(report.scan).sort()).toEqual([
      "files",
      "id",
      "incomplete",
      "incomplete_reasons",
      "scanned_at",
      "status",
      "version",
    ]);
    expect(parseScreenReport(report).scan?.status).toBe("clean");
  });
});

describe("a finding is not retracted by a screen that read less", () => {
  test("an incomplete re-screen keeps the finding; a complete one that finds nothing clears it", async () => {
    seedDataset("nm000730");
    await runIdentifierSweepTick(env());
    await answer(
      "nm000730",
      scanBody("nm000730", "direct-identifiers", { findings_by_kind: { "edf-patient-name": 2 } }),
    );
    const found = stamps("nm000730");
    // The next screen runs out of time and finds nothing.
    expect(await rescreenAs("nm000730")).toBe(200);
    dispatches = [];
    await runIdentifierSweepTick(env());
    await answer("nm000730", scanBody("nm000730", "unchecked"));
    let s = stamps("nm000730");
    expect(s.identifier_sweep_status).toBe("unchecked");
    const kept = s.identifier_sweep_finding as {
      status: string;
      checked_at: string;
      report: unknown;
    };
    expect(kept.status).toBe("direct-identifiers");
    expect(kept.checked_at).toBe(found.identifier_sweep_checked_at as string);
    expect(kept.report).toEqual(found.identifier_sweep_report);
    // A second incomplete screen carries the same finding forward.
    expect(await rescreenAs("nm000730")).toBe(200);
    dispatches = [];
    await runIdentifierSweepTick(env());
    await answer("nm000730", scanBody("nm000730", "unchecked"));
    s = stamps("nm000730");
    expect((s.identifier_sweep_finding as { status: string }).status).toBe("direct-identifiers");
    // A complete screen that finds nothing is the evidence the finding is gone.
    expect(await rescreenAs("nm000730")).toBe(200);
    dispatches = [];
    await runIdentifierSweepTick(env());
    await answer("nm000730", scanBody("nm000730", "clean"));
    expect(stamps("nm000730").identifier_sweep_finding).toBeNull();
  });
});

describe("round two: a finding outlives screens that read less", () => {
  test("an incomplete review does not displace a complete direct finding", async () => {
    seedDataset("nm000731");
    await runIdentifierSweepTick(env());
    await answer(
      "nm000731",
      scanBody("nm000731", "direct-identifiers", { findings_by_kind: { "edf-patient-name": 3 } }),
    );
    expect(await rescreenAs("nm000731")).toBe(200);
    dispatches = [];
    await runIdentifierSweepTick(env());
    await answer(
      "nm000731",
      scanBody("nm000731", "review", {
        incomplete: true,
        findings_by_kind: { "participants-identifier-column": 1 },
      }),
    );
    const s = stamps("nm000731");
    expect(s.identifier_sweep_status).toBe("review");
    expect((s.identifier_sweep_finding as { status: string }).status).toBe("direct-identifiers");
    const res = await app.request(
      "/admin/identifier-sweep",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    const body = (await res.json()) as {
      facts: { flagged: { dataset_id: string; standing: string }[]; review: unknown[] };
    };
    expect(body.facts.flagged.map((f) => [f.dataset_id, f.standing])).toEqual([
      ["nm000731", "earlier"],
    ]);
    expect(body.facts.review).toEqual([]);
  });

  test("a complete review does replace it: the complete screen is the whole answer", async () => {
    seedDataset("nm000732");
    await runIdentifierSweepTick(env());
    await answer("nm000732", scanBody("nm000732", "direct-identifiers"));
    expect(await rescreenAs("nm000732")).toBe(200);
    dispatches = [];
    await runIdentifierSweepTick(env());
    await answer("nm000732", scanBody("nm000732", "review"));
    expect(stamps("nm000732").identifier_sweep_finding).toBeNull();
  });

  test("a finding whose report no longer reads back is carried as its status, so it stays named", async () => {
    seedDataset("nm000733");
    await runIdentifierSweepTick(env());
    await answer("nm000733", scanBody("nm000733", "direct-identifiers"));
    db.run(
      `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_report', json('{"version":99}'))
        WHERE dataset_id = 'nm000733'`,
    );
    expect(await rescreenAs("nm000733")).toBe(200);
    dispatches = [];
    await runIdentifierSweepTick(env());
    await answer("nm000733", scanBody("nm000733", "unchecked"));
    const kept = stamps("nm000733").identifier_sweep_finding as {
      status: string;
      report: unknown;
    };
    expect(kept.status).toBe("direct-identifiers");
    expect(kept.report).toBeNull();
    const res = await app.request(
      "/admin/identifier-sweep",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    const body = (await res.json()) as {
      facts: { flagged: { dataset_id: string; standing: string; findings_by_kind: unknown }[] };
    };
    expect(body.facts.flagged).toEqual([
      expect.objectContaining({
        dataset_id: "nm000733",
        standing: "earlier",
        findings_by_kind: null,
      }),
    ]);
  });
});

describe("round two: what a carried finding may hold", () => {
  test("a carried finding holds a stored time only in the shape the sweep writes", async () => {
    seedDataset("nm000740");
    await runIdentifierSweepTick(env());
    await answer("nm000740", scanBody("nm000740", "direct-identifiers"));
    db.run(
      `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_checked_at', ?)
        WHERE dataset_id = 'nm000740'`,
      [LEAK],
    );
    expect(await rescreenAs("nm000740")).toBe(200);
    dispatches = [];
    await runIdentifierSweepTick(env());
    await answer("nm000740", scanBody("nm000740", "unchecked"));
    const kept = stamps("nm000740").identifier_sweep_finding as {
      status: string;
      checked_at: unknown;
    };
    expect(kept.status).toBe("direct-identifiers");
    expect(kept.checked_at).toBeNull();
    expect(rawStamps("nm000740")).not.toContain(LEAK);
  });

  test("the unparsed-format map is not stored: its keys are a pattern, not a closed list", async () => {
    seedDataset("nm000741");
    await runIdentifierSweepTick(env());
    await answer(
      "nm000741",
      scanBody("nm000741", "not-screened", { unscreened_formats: { ".set": 2 } }),
    );
    const report = stamps("nm000741").identifier_sweep_report as { scan: Record<string, unknown> };
    expect(report.scan.status).toBe("not-screened");
    expect(report.scan.unscreened_formats).toBeUndefined();
  });
});

describe("round two: dispatch edges", () => {
  test("a refused credential (401) closes one attempt without counting it and claims nobody else", async () => {
    seedDataset("nm000734");
    seedDataset("nm000735");
    seedDataset("nm000736");
    dispatchStatus = 401;
    const r = await runIdentifierSweepTick(env());
    expect(r.blocked).toBe("dispatch-failed");
    expect(r.failed).toEqual([{ dataset_id: "nm000734", error: "dispatch-failed" }]);
    expect(githubRequests).toHaveLength(1);
    expect(stamps("nm000734").identifier_sweep_failures).toBe(0);
    expect(rawStamps("nm000735")).toBeNull();
    expect(rawStamps("nm000736")).toBeNull();
  });

  test("no GitHub credential at all (no PAT, no App) blocks the tick as dispatch-unconfigured", async () => {
    seedDataset("nm000737");
    const r = await runIdentifierSweepTick(env({ GITHUB_ADMIN_PAT: undefined }));
    expect(r.blocked).toBe("dispatch-unconfigured");
    expect(githubRequests).toHaveLength(0);
    expect(rawStamps("nm000737")).toBeNull();
  });

  test("an attempt time in the future holds nothing back, and a pending one with it times out", async () => {
    seedDataset("nm000738", {
      stamps: {
        identifier_sweep_attempt: "error",
        identifier_sweep_attempted_at: "2099-01-01 00:00:00",
      },
    });
    seedDataset("nm000739", {
      stamps: {
        identifier_sweep_attempt: "pending",
        identifier_sweep_nonce: "n",
        identifier_sweep_attempted_at: "2099-01-01 00:00:00",
      },
    });
    const r = await runIdentifierSweepTick(env());
    expect(r.timedOut).toBe(1);
    expect(dispatchedIds().sort()).toEqual(["nm000738", "nm000739"]);
  });
});

describe("the cadence never depends on the verdict", () => {
  const ALL = [
    "direct-identifiers",
    "dates-only",
    "review",
    "clean",
    "clean-edf-only-others-unscreened",
    "not-screened",
    "no-recordings",
    "unchecked",
  ] as const;

  async function screenedAt(id: string, status: string, daysAgo: number) {
    seedDataset(id, { versions: ["1.0.0"] });
    await runIdentifierSweepTick(env());
    await answer(id, scanBody(id, status));
    age(id, "identifier_sweep_checked_at", `-${daysAgo} days`);
    age(id, "identifier_sweep_attempted_at", `-${daysAgo} days`);
    dispatches = [];
  }

  test("every verdict, at 3 and at 20 days, is not due; at 22 days every one is", async () => {
    // A rule that re-screened a flagged dataset sooner would show up here as a
    // dispatch at 3 or 20 days; one that held a flagged dataset back, as a missing
    // dispatch at 22.
    for (const [i, status] of ALL.entries()) await screenedAt(`nm00074${i}`, status, 3);
    expect((await runIdentifierSweepTick(env())).candidates).toBe(0);
    for (const [i] of ALL.entries()) {
      age(`nm00074${i}`, "identifier_sweep_checked_at", "-20 days");
    }
    expect((await runIdentifierSweepTick(env())).candidates).toBe(0);
    const due: string[] = [];
    for (const [i] of ALL.entries()) {
      age(`nm00074${i}`, "identifier_sweep_checked_at", "-22 days");
    }
    for (let t = 0; t < 3; t++) {
      dispatches = [];
      await runIdentifierSweepTick(env());
      due.push(...dispatchedIds());
      db.run(
        `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_attempt', 'reported')
          WHERE json_extract(sweep_stamps, '$.identifier_sweep_attempt') = 'pending'`,
      );
    }
    expect(due.sort()).toEqual(ALL.map((_, i) => `nm00074${i}`).sort());
  });

  test("a flagged and a clean dataset aged alike come out by attempt time and id only", async () => {
    await screenedAt("nm000751", "direct-identifiers", 22);
    await screenedAt("nm000750", "clean", 22);
    db.run(
      `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_attempted_at', datetime('now', '-22 days'))
        WHERE dataset_id IN ('nm000750', 'nm000751')`,
    );
    await runIdentifierSweepTick(env());
    expect(dispatchedIds()).toEqual(["nm000750", "nm000751"]);
  });
});

describe("the callback's size bound", () => {
  test("a body over the bound is refused 413, by its declared length and by what arrived", async () => {
    seedDataset("nm000760");
    await runIdentifierSweepTick(env());
    const token = (dispatches[0] as Dispatch).client_payload.callback_token;
    const huge = JSON.stringify({
      dataset_id: "nm000760",
      request_id: 0,
      pad: "x".repeat(300_000),
    });
    expect((await postCallback(huge, token)).status).toBe(413);
    const lying = await app.request(
      "/webhooks/identifier-sweep-result",
      {
        method: "POST",
        headers: {
          "X-Webhook-Token": token,
          "Content-Type": "application/json",
          "Content-Length": "10",
        },
        body: huge,
      },
      env(),
    );
    expect(lying.status).toBe(413);
    expect(stamps("nm000760").identifier_sweep_attempt).toBe("pending");
  });
});

describe("the mail category through the route", () => {
  test("PUT identifier_sweep false persists and reads back; other keys are untouched", async () => {
    const put = await app.request(
      "/admin/email-preferences",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ identifier_sweep: false }),
      },
      env(),
    );
    expect(put.status).toBe(200);
    const got = (await (
      await app.request(
        "/admin/email-preferences",
        { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env(),
      )
    ).json()) as Record<string, unknown>;
    expect(got.identifier_sweep).toBe(false);
    expect(got.publication_request).toBe(true);
    expect(got.dataset_anonymity).toBe(true);
  });
});
