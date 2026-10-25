/**
 * The dispatch record of the automatic re-pull (epic #1046 phase 7, #1913; ADR 0111, decision 6),
 * through its real entry points: the claims the scheduler and the advance tick will call
 * (`claimOpenDispatch`, `claimFinishDispatch`, `markDispatchSendFailed`), the callback a run posts
 * to (`POST /webhooks/repull-state`, through the real webhooks router), and the watchdog the
 * `*\/30` tick will call (`sweepUnreportedDispatches`).
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied. The cap's UTC day is
 * D1's clock, so "yesterday" and "nine hours ago" are seeded as past `dispatched_at` values,
 * never by moving a clock. The Resend capture is armed around every test and must stay empty:
 * nothing about a dispatch mails anyone. No dataset id here is a real mirror's.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - outside exact production, or with the open switch off, nothing is claimed and nothing is
 *    written; the finish claim needs exact production only;
 *  - the open cap is today's `open` dispatches except those GitHub refused, counted in the
 *    statement that claims, and a refused claim writes nothing;
 *  - one live dispatch per dataset; a first dispatch needs no open re-pull, a resume an automatic
 *    row that stalled before its pull request opened;
 *  - the report's edges, and that every edge but `started` ends the dispatch, so a replay fails;
 *  - another kind's token is refused at this door, and this kind's at another's;
 *  - the watchdog ends a dispatch that said nothing in time (and not one a minute short of it),
 *    only in exact production, and never reports an absent count as zero;
 *  - the callback reads no switch, and a Worker without its secret answers 503 there and refuses
 *    the finish claim;
 *  - a claim that committed and then could not be read back or signed is ended, not stranded;
 *  - the guards behind the service's own checks (the dataset of a linked re-pull, the nonce, a
 *    link made once) hold when a row or a caller disagrees with them.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { DISPATCH_CODES, type DispatchRow } from "../../shared/repull-state";
import webhooks from "../src/routes/webhooks";
import {
  signIdentifierRepullCallbackToken,
  signIdentifierSweepCallbackToken,
  verifyRepullDispatchToken,
} from "../src/services/github";
import {
  DISPATCH_DEADLINE_HOURS,
  DISPATCH_LINK_BY_KEY_SQL,
  DISPATCH_LINK_SQL,
  DISPATCH_REPORT_SQL,
  OPEN_DISPATCHES_TODAY_SQL,
  claimFinishDispatch,
  claimOpenDispatch,
  markDispatchSendFailed,
  sweepUnreportedDispatches,
} from "../src/services/upstream-repull-dispatch";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1, wrapD1, yieldingD1 } from "./helpers/d1";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const SECRET = "repull-dispatch-test-secret";
const DS = "on099991";
const OTHER = "on099992";
const RUN_URL = "https://github.com/nemarDatasets/.github/actions/runs/987654321";

// biome-ignore lint/suspicious/noExplicitAny: a response body read field by field in assertions
type Json = Record<string, any>;

let db: Database;
let app: Hono<{ Bindings: Bindings }>;
let mail: CapturedEmail[] = [];
let releaseMail: (() => void) | null = null;
let mailDone: Promise<void> | null = null;

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings }>();
  app.route("/webhooks", webhooks);
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
  releaseMail = null;
  mailDone = null;
  expect(mail).toEqual([]);
});

/** Production with the open switch on, unless a test says otherwise. */
function env(over: Record<string, string | undefined> = {}): Bindings {
  const bindings: Record<string, unknown> = {
    DB: realD1(db),
    ENVIRONMENT: "production",
    AUTO_REPULL_ENABLED: "1",
    PRESCREEN_CALLBACK_SECRET: SECRET,
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete bindings[k];
    else bindings[k] = v;
  }
  return bindings as unknown as Bindings;
}

const candidate = (datasetId = DS, over: Record<string, unknown> = {}) => ({
  datasetId,
  upstreamDs: "ds099991",
  fromTag: "1.0.0",
  toTag: "1.0.1",
  ...over,
});

const dispatches = () =>
  db.query("SELECT * FROM upstream_repull_dispatches ORDER BY id").all() as DispatchRow[];
const audits = (action: string) =>
  db.query("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action) as Row[];
const tableState = () => ({
  dispatches: dispatches(),
  audit: db.query("SELECT * FROM audit_log").all(),
});

function insert(table: string, row: Row): number {
  const cols = Object.keys(row);
  return Number(
    db
      .query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...(cols.map((c) => row[c]) as never[])).lastInsertRowid,
  );
}

/** An automatic re-pull row of the fixture dataset at `status`. */
function automaticRow(status: Parameters<typeof rowAt>[0], over: Row = {}): number {
  return insert(
    "upstream_repulls",
    rowAt(status, {
      dataset_id: DS,
      upstream_ds: "ds099991",
      origin: "automatic",
      planner: 2,
      ...over,
    }),
  );
}

async function claimed(c = candidate(), e = env()) {
  const claim = await claimOpenDispatch(e, c);
  if (!("id" in claim)) throw new Error(`refused: ${claim.refused}`);
  return claim;
}

async function report(body: Record<string, unknown>, token: string | null, e = env()) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["X-Repull-Token"] = token;
  const res = await app.request(
    "/webhooks/repull-state",
    { method: "POST", headers, body: JSON.stringify(body) },
    e,
  );
  return { status: res.status, body: (await res.json()) as Json };
}

const dispatchRow = (id: number) =>
  db.query("SELECT * FROM upstream_repull_dispatches WHERE id = ?").get(id) as DispatchRow;

// ----------------------------------------------------------------------------
// Claims
// ----------------------------------------------------------------------------

describe("claiming an open dispatch: the fences", () => {
  for (const environment of [
    "development",
    "staging",
    "test",
    "Production",
    " production",
    undefined,
  ]) {
    test(`ENVIRONMENT ${JSON.stringify(environment)} claims nothing, with the switch on`, async () => {
      expect(await claimOpenDispatch(env({ ENVIRONMENT: environment }), candidate())).toEqual({
        refused: "off",
      });
      expect(tableState()).toEqual({ dispatches: [], audit: [] });
    });
  }

  for (const value of [undefined, "true", "0", " 1", ""]) {
    test(`AUTO_REPULL_ENABLED ${JSON.stringify(value)} claims nothing`, async () => {
      expect(await claimOpenDispatch(env({ AUTO_REPULL_ENABLED: value }), candidate())).toEqual({
        refused: "off",
      });
      expect(tableState()).toEqual({ dispatches: [], audit: [] });
    });
  }

  test("no callback secret: nothing is claimed, because no token could be signed", async () => {
    expect(
      await claimOpenDispatch(env({ PRESCREEN_CALLBACK_SECRET: undefined }), candidate()),
    ).toEqual({ refused: "unconfigured" });
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
  });

  test("a candidate that is not an on mirror throws, and nothing is written", async () => {
    for (const bad of [
      candidate("xx090123"),
      candidate("nm000103"),
      candidate(DS, { upstreamDs: "ds12345" }),
      candidate(DS, { repullId: 0 }),
    ]) {
      await expect(claimOpenDispatch(env(), bad)).rejects.toThrow(/candidate/);
    }
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
  });

  test("an upstream tag from outside that is not a tag, or two that name one, is a refusal and writes nothing", async () => {
    for (const bad of [
      candidate(DS, { toTag: "refs/x" }),
      candidate(DS, { fromTag: "has space" }),
      candidate(DS, { toTag: "" }),
      candidate(DS, { toTag: "v1.0.0" }),
      candidate(DS, { toTag: "1.0.0" }),
    ]) {
      expect([bad, await claimOpenDispatch(env(), bad)]).toEqual([bad, { refused: "candidate" }]);
    }
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
  });
});

describe("claiming an open dispatch: what it writes", () => {
  test("a claim is one live row, one audit row with no secret, and a token over its nonce", async () => {
    const claim = await claimed(candidate(DS, { fromTag: "v1.0.0" }));
    const [row] = dispatches();
    expect(row).toMatchObject({
      id: claim.id,
      kind: "open",
      dataset_id: DS,
      upstream_ds: "ds099991",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      repull_id: null,
      status: "dispatched",
      code: null,
      reported_at: null,
    });
    expect(row?.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await verifyRepullDispatchToken(
        claim.token,
        { dispatchId: claim.id, datasetId: DS, nonce: row?.nonce as string },
        SECRET,
      ),
    ).toBe(true);
    const [audit] = audits("repull_dispatch");
    expect(audit).toMatchObject({
      user_id: null,
      resource_type: "upstream_repull_dispatch",
      resource_id: String(claim.id),
    });
    expect(JSON.parse(audit?.details as string)).toEqual({
      dataset_id: DS,
      kind: "open",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      repull_id: null,
    });
    expect(audit?.details).not.toContain(row?.nonce as string);
    expect(audit?.details).not.toContain(claim.token);
  });

  test("a second live dispatch of a dataset is refused as live, and nothing is written", async () => {
    await claimed();
    const before = tableState();
    expect(await claimOpenDispatch(env(), candidate())).toEqual({ refused: "live" });
    expect(tableState()).toEqual(before);
  });

  test("a first dispatch for a dataset with an open re-pull is refused, and nothing is written", async () => {
    automaticRow("prepared");
    expect(await claimOpenDispatch(env(), candidate())).toEqual({ refused: "open-row" });
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
    // A closed one does not block.
    db.run("UPDATE upstream_repulls SET status = 'abandoned', terminal_at = datetime('now')");
    await claimed();
  });
});

describe("the open cap", () => {
  test("cap 2: the third claim of the day is refused and the tables are unchanged", async () => {
    await claimed(candidate("on099991"));
    await claimed(candidate("on099992"));
    const before = tableState();
    expect(await claimOpenDispatch(env(), candidate("on099993"))).toEqual({ refused: "cap" });
    expect(tableState()).toEqual(before);
    expect(db.query(OPEN_DISPATCHES_TODAY_SQL).get()).toEqual({ used: 2 });
  });

  test("a dispatch GitHub refused frees its unit; one whose answer was lost keeps it", async () => {
    const first = await claimed(candidate("on099991"));
    await claimed(candidate("on099992"));
    expect(await claimOpenDispatch(env(), candidate("on099993"))).toEqual({ refused: "cap" });
    expect(await markDispatchSendFailed(realD1(db), first.id, "dispatch-refused")).toBe(true);
    expect(dispatchRow(first.id)).toMatchObject({
      status: "dispatch_failed",
      nonce: null,
      code: "dispatch-refused",
    });
    await claimed(candidate("on099993"));
    // The unit the refused one freed is the only one.
    expect(await claimOpenDispatch(env(), candidate("on099994"))).toEqual({ refused: "cap" });
  });

  test("yesterday's dispatches do not count, and a finish never counts", async () => {
    insert("upstream_repull_dispatches", {
      kind: "open",
      dataset_id: "on099995",
      upstream_ds: "ds099991",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      status: "refused",
      code: "runner-failed",
      reported_at: "2026-10-24 04:00:00",
      dispatched_at: db.query<{ t: string }, []>("SELECT datetime('now', '-1 day') AS t").get()
        ?.t as string,
    });
    const repull = automaticRow("merged", { dataset_id: "on099996" });
    const finish = await claimFinishDispatch(env(), {
      id: repull,
      dataset_id: "on099996",
      origin: "automatic",
      status: "merged",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    });
    expect("id" in finish).toBe(true);
    await claimed(candidate("on099991"));
    await claimed(candidate("on099992"));
    expect(await claimOpenDispatch(env(), candidate("on099993"))).toEqual({ refused: "cap" });
  });

  test("REPULL_DAILY_OPEN_CAP 0 claims nothing; 1 is one", async () => {
    expect(await claimOpenDispatch(env({ REPULL_DAILY_OPEN_CAP: "0" }), candidate())).toEqual({
      refused: "cap",
    });
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
    await claimed(candidate("on099991"), env({ REPULL_DAILY_OPEN_CAP: "1" }));
    expect(
      await claimOpenDispatch(env({ REPULL_DAILY_OPEN_CAP: "1" }), candidate("on099992")),
    ).toEqual({ refused: "cap" });
  });
});

describe("which dispatches keep their unit", () => {
  const today = () =>
    db.query<{ t: string }, []>("SELECT date('now') || ' 00:00:01' AS t").get()?.t as string;

  test("an unreported dispatch (its answer lost) keeps its unit; a dispatch_failed one frees it", async () => {
    const id = insert("upstream_repull_dispatches", {
      kind: "open",
      dataset_id: "on099995",
      upstream_ds: "ds099991",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      status: "unreported",
      dispatched_at: today(),
    });
    const one = env({ REPULL_DAILY_OPEN_CAP: "1" });
    expect(db.query(OPEN_DISPATCHES_TODAY_SQL).get()).toEqual({ used: 1 });
    expect(await claimOpenDispatch(one, candidate())).toEqual({ refused: "cap" });
    db.run(
      "UPDATE upstream_repull_dispatches SET status = 'dispatch_failed', code = 'dispatch-refused' WHERE id = ?",
      [id],
    );
    expect(db.query(OPEN_DISPATCHES_TODAY_SQL).get()).toEqual({ used: 0 });
    await claimed(candidate(), one);
  });
});

describe("an unreadable cap is not a full day", () => {
  test("a cap that is not one or two digits up to 20 is cap-unreadable, carrying the reader's source", async () => {
    for (const cap of ["x", "2.5", "21", " 2", "", "-1", "+1", "02x"]) {
      expect([
        cap,
        await claimOpenDispatch(env({ REPULL_DAILY_OPEN_CAP: cap }), candidate()),
      ]).toEqual([cap, { refused: "cap-unreadable", source: "unreadable" }]);
    }
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
  });

  test("a day's exhaustion still reads cap, and a readable cap claims", async () => {
    const one = env({ REPULL_DAILY_OPEN_CAP: "1" });
    await claimed(candidate("on099991"), one);
    expect(await claimOpenDispatch(one, candidate("on099992"))).toEqual({ refused: "cap" });
    for (const cap of ["02", "20"]) {
      await claimed(candidate("on099993"), env({ REPULL_DAILY_OPEN_CAP: cap }));
      db.run("DELETE FROM upstream_repull_dispatches WHERE dataset_id = 'on099993'");
    }
  });
});

describe("resuming a stalled automatic re-pull", () => {
  test("it names a row of its own dataset and tags that stalled before its pull request, and counts", async () => {
    const id = automaticRow("copied");
    const claim = await claimed(candidate(DS, { repullId: id }));
    expect(dispatchRow(claim.id)).toMatchObject({ kind: "open", repull_id: id });
    expect(db.query(OPEN_DISPATCHES_TODAY_SQL).get()).toEqual({ used: 1 });
  });

  test("an administrator's row, a row past pr_open, or another dataset's or tag's is refused", async () => {
    const admin = automaticRow("copied", { origin: "administrator" });
    expect(await claimOpenDispatch(env(), candidate(DS, { repullId: admin }))).toEqual({
      refused: "row",
    });
    db.run("DELETE FROM upstream_repulls");
    const open = automaticRow("pr_open");
    expect(await claimOpenDispatch(env(), candidate(DS, { repullId: open }))).toEqual({
      refused: "row",
    });
    db.run("DELETE FROM upstream_repulls");
    const mine = automaticRow("registered");
    expect(
      await claimOpenDispatch(env(), candidate(DS, { repullId: mine, toTag: "1.0.2" })),
    ).toEqual({ refused: "row" });
    expect(await claimOpenDispatch(env(), candidate(OTHER, { repullId: mine }))).toEqual({
      refused: "row",
    });
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
  });
});

describe("a resume names the row's own upstream dataset and from-tag", () => {
  test("another ds, or another from_tag, is refused, and nothing is written", async () => {
    const id = automaticRow("copied");
    expect(
      await claimOpenDispatch(env(), candidate(DS, { repullId: id, upstreamDs: "ds099999" })),
    ).toEqual({ refused: "row" });
    expect(
      await claimOpenDispatch(env(), candidate(DS, { repullId: id, fromTag: "0.9.0" })),
    ).toEqual({ refused: "row" });
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
    await claimed(candidate(DS, { repullId: id }));
  });
});

describe("claiming a finish", () => {
  test("it needs exact production, and not the switches", async () => {
    const id = automaticRow("released");
    const row = {
      id,
      dataset_id: DS,
      origin: "automatic" as const,
      status: "released" as const,
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    };
    for (const environment of ["development", "Production", undefined]) {
      expect(await claimFinishDispatch(env({ ENVIRONMENT: environment }), row)).toEqual({
        refused: "off",
      });
    }
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
    const claim = await claimFinishDispatch(
      env({ AUTO_REPULL_ENABLED: undefined, REPULL_DAILY_OPEN_CAP: "0" }),
      row,
    );
    if (!("id" in claim)) throw new Error(`refused: ${claim.refused}`);
    expect(dispatchRow(claim.id)).toMatchObject({
      kind: "finish",
      repull_id: id,
      dataset_id: DS,
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    });
    expect(audits("repull_dispatch")).toHaveLength(1);
    // One live dispatch per dataset.
    expect(await claimFinishDispatch(env(), row)).toEqual({ refused: "live" });
  });

  test("it takes only an automatic row that merged, and the row is read in the claim", async () => {
    const admin = automaticRow("merged", { origin: "administrator" });
    const base = { dataset_id: DS, from_tag: "1.0.0", to_tag: "1.0.1" };
    expect(
      await claimFinishDispatch(env(), {
        ...base,
        id: admin,
        origin: "administrator",
        status: "merged",
      }),
    ).toEqual({ refused: "row" });
    db.run("DELETE FROM upstream_repulls");
    const early = automaticRow("gates_clear");
    expect(
      await claimFinishDispatch(env(), {
        ...base,
        id: early,
        origin: "automatic",
        status: "gates_clear",
      }),
    ).toEqual({ refused: "row" });
    // The caller's word is not taken: the statement reads the row's origin and status.
    db.run("DELETE FROM upstream_repulls");
    const adminMerged = automaticRow("merged", { origin: "administrator" });
    expect(
      await claimFinishDispatch(env(), {
        ...base,
        id: adminMerged,
        origin: "automatic",
        status: "merged",
      }),
    ).toEqual({ refused: "row" });
    db.run("DELETE FROM upstream_repulls");
    const stillGating = automaticRow("gates_clear");
    expect(
      await claimFinishDispatch(env(), {
        ...base,
        id: stillGating,
        origin: "automatic",
        status: "merged",
      }),
    ).toEqual({ refused: "row" });
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
  });
});

describe("claiming a finish without a callback secret", () => {
  test("it is refused as unconfigured and writes nothing, so no orphan holds the dataset's slot", async () => {
    const id = automaticRow("merged");
    const row = {
      id,
      dataset_id: DS,
      origin: "automatic" as const,
      status: "merged" as const,
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    };
    for (const secret of [undefined, ""]) {
      expect(await claimFinishDispatch(env({ PRESCREEN_CALLBACK_SECRET: secret }), row)).toEqual({
        refused: "unconfigured",
      });
    }
    expect(tableState()).toEqual({ dispatches: [], audit: [] });
    // The dataset's one live slot is free for the claim that can be signed.
    expect("id" in (await claimFinishDispatch(env(), row))).toBe(true);
  });
});

describe("a claim that committed and could not be handed out", () => {
  const readBackFails = () =>
    wrapD1(realD1(db), (sql) => {
      if (sql.includes("WHERE nonce = ?")) throw new Error("D1_ERROR: network connection lost");
    });

  test("an open claim whose row cannot be read back is ended as dispatch-failed, freeing its unit and the slot", async () => {
    const e = env({ REPULL_DAILY_OPEN_CAP: "1" });
    (e as unknown as { DB: D1Database }).DB = readBackFails();
    await expect(claimOpenDispatch(e, candidate())).rejects.toThrow(/network connection lost/);
    expect(dispatches()).toHaveLength(1);
    expect(dispatches()[0]).toMatchObject({
      status: "dispatch_failed",
      code: "dispatch-failed",
      nonce: null,
    });
    expect(db.query(OPEN_DISPATCHES_TODAY_SQL).get()).toEqual({ used: 0 });
    // Neither the day's only unit nor the dataset's live slot is held.
    await claimed(candidate(), env({ REPULL_DAILY_OPEN_CAP: "1" }));
  });

  test("a finish claim whose row cannot be read back is ended too, so the merged record can be finished", async () => {
    const id = automaticRow("merged");
    const row = {
      id,
      dataset_id: DS,
      origin: "automatic" as const,
      status: "merged" as const,
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    };
    const e = env();
    (e as unknown as { DB: D1Database }).DB = readBackFails();
    await expect(claimFinishDispatch(e, row)).rejects.toThrow(/network connection lost/);
    expect(dispatches()[0]).toMatchObject({
      kind: "finish",
      status: "dispatch_failed",
      code: "dispatch-failed",
      nonce: null,
    });
    expect("id" in (await claimFinishDispatch(env(), row))).toBe(true);
  });
});

describe("what a claim's audit row says", () => {
  test("it is built from the inserted row, so a caller's stale row cannot change it", async () => {
    const id = automaticRow("merged", { from_tag: "1.0.0", to_tag: "1.0.1" });
    // The caller read other tags and another dataset than the database holds.
    const claim = await claimFinishDispatch(env(), {
      id,
      dataset_id: DS,
      origin: "automatic",
      status: "merged",
      from_tag: "0.1.0",
      to_tag: "0.2.0",
    });
    if (!("id" in claim)) throw new Error(`refused: ${claim.refused}`);
    const [audit] = audits("repull_dispatch");
    expect(JSON.parse(audit?.details as string)).toEqual({
      dataset_id: DS,
      kind: "finish",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      repull_id: id,
    });
    expect(dispatchRow(claim.id)).toMatchObject({ from_tag: "1.0.0", to_tag: "1.0.1" });
  });
});

describe("a send failure", () => {
  test("it ends only a dispatched row, and a code outside the list throws", async () => {
    const claim = await claimed();
    expect(
      await report({ dispatch_id: claim.id, dataset_id: DS, phase: "started" }, claim.token),
    ).toMatchObject({ status: 200 });
    expect(await markDispatchSendFailed(realD1(db), claim.id, "dispatch-refused")).toBe(false);
    expect(dispatchRow(claim.id).status).toBe("started");
    await expect(
      markDispatchSendFailed(realD1(db), claim.id, "a path/like this" as never),
    ).rejects.toThrow(/not a dispatch code/);
  });
});

// ----------------------------------------------------------------------------
// The run's report, through the callback
// ----------------------------------------------------------------------------

describe("the report: edges", () => {
  test("started, then opened for the row this dispatch created, at pr_open", async () => {
    const claim = await claimed();
    const started = await report(
      { dispatch_id: claim.id, dataset_id: DS, phase: "started", workflow_run_url: RUN_URL },
      claim.token,
    );
    expect(started).toEqual({ status: 200, body: { ok: true, code: "stored" } });
    expect(dispatchRow(claim.id)).toMatchObject({ status: "started", workflow_run_url: RUN_URL });
    expect(dispatchRow(claim.id).nonce).not.toBeNull();
    expect(dispatchRow(claim.id).reported_at).not.toBeNull();

    const id = automaticRow("pr_open");
    db.run("UPDATE upstream_repull_dispatches SET repull_id = ? WHERE id = ?", [id, claim.id]);
    const opened = await report(
      { dispatch_id: claim.id, dataset_id: DS, phase: "opened", repull_id: id },
      claim.token,
    );
    expect(opened).toEqual({ status: 200, body: { ok: true, code: "stored" } });
    expect(dispatchRow(claim.id)).toMatchObject({ status: "opened", nonce: null, repull_id: id });
    // A run URL is kept once set.
    expect(dispatchRow(claim.id).workflow_run_url).toBe(RUN_URL);
  });

  test("a repeated started is 409; a replay after a terminal edge is 401", async () => {
    const claim = await claimed();
    const body = { dispatch_id: claim.id, dataset_id: DS, phase: "started" };
    expect((await report(body, claim.token)).status).toBe(200);
    expect(await report(body, claim.token)).toMatchObject({
      status: 409,
      body: { code: "already-started" },
    });
    const refused = {
      dispatch_id: claim.id,
      dataset_id: DS,
      phase: "refused",
      code: "auto-not-clean-plan",
    };
    expect((await report(refused, claim.token)).status).toBe(200);
    expect(dispatchRow(claim.id)).toMatchObject({
      status: "refused",
      code: "auto-not-clean-plan",
      nonce: null,
    });
    for (const again of [refused, body, { ...refused, phase: "failed", code: "runner-failed" }]) {
      expect(await report(again, claim.token)).toMatchObject({
        status: 401,
        body: { code: "invalid-token" },
      });
    }
    expect(dispatchRow(claim.id).status).toBe("refused");
  });

  test("a failure is stored straight from dispatched, with its code", async () => {
    const claim = await claimed();
    expect(
      await report(
        { dispatch_id: claim.id, dataset_id: DS, phase: "failed", code: "runner-disk" },
        claim.token,
      ),
    ).toMatchObject({ status: 200 });
    expect(dispatchRow(claim.id)).toMatchObject({
      status: "failed",
      code: "runner-disk",
      nonce: null,
    });
  });

  test("the callback reads no switch: a dispatched run still says how it ended", async () => {
    for (const switchValue of [undefined, "0"]) {
      db.run("DELETE FROM upstream_repulls");
      db.run("DELETE FROM upstream_repull_dispatches");
      const off = env({ AUTO_REPULL_ENABLED: switchValue, REPULL_DAILY_OPEN_CAP: "0" });
      const claim = await claimed();
      const ok = async (body: Record<string, unknown>) =>
        expect([switchValue, body.phase, (await report(body, claim.token, off)).status]).toEqual([
          switchValue,
          body.phase,
          200,
        ]);
      await ok({ dispatch_id: claim.id, dataset_id: DS, phase: "started" });
      const id = automaticRow("pr_open");
      db.run("UPDATE upstream_repull_dispatches SET repull_id = ? WHERE id = ?", [id, claim.id]);
      await ok({ dispatch_id: claim.id, dataset_id: DS, phase: "opened", repull_id: id });
      expect(dispatchRow(claim.id).status).toBe("opened");

      db.run("DELETE FROM upstream_repulls");
      db.run("DELETE FROM upstream_repull_dispatches");
      const failing = await claimed();
      expect(
        (
          await report(
            { dispatch_id: failing.id, dataset_id: DS, phase: "failed", code: "runner-failed" },
            failing.token,
            off,
          )
        ).status,
      ).toBe(200);
      expect(dispatchRow(failing.id).status).toBe("failed");
    }
  });

  test("a Worker without its callback secret answers 503, and stores nothing", async () => {
    const claim = await claimed();
    for (const secret of [undefined, ""]) {
      expect(
        await report(
          { dispatch_id: claim.id, dataset_id: DS, phase: "started" },
          claim.token,
          env({ PRESCREEN_CALLBACK_SECRET: secret }),
        ),
      ).toMatchObject({ status: 503, body: { code: "dispatch-unconfigured" } });
    }
    expect(dispatchRow(claim.id)).toMatchObject({ status: "dispatched", reported_at: null });
  });

  test("two reports racing on one dispatch: one is stored, the other finds it moved", async () => {
    const claim = await claimed();
    const racing = env();
    (racing as unknown as { DB: D1Database }).DB = yieldingD1(realD1(db));
    const results = await Promise.all([
      report(
        { dispatch_id: claim.id, dataset_id: DS, phase: "failed", code: "runner-failed" },
        claim.token,
        racing,
      ),
      report(
        { dispatch_id: claim.id, dataset_id: DS, phase: "refused", code: "auto-not-clean-plan" },
        claim.token,
        racing,
      ),
    ]);
    expect(results.map((r) => [r.status, r.body.code]).sort()).toEqual([
      [200, "stored"],
      [409, "stale-dispatch"],
    ]);
    const stored = results.find((r) => r.status === 200);
    const status = dispatchRow(claim.id).status;
    expect(status).toBe(stored && results[0] === stored ? "failed" : "refused");
    expect(dispatchRow(claim.id).nonce).toBeNull();
  });

  test("a run URL is kept once set: a later, different one does not replace it", async () => {
    const claim = await claimed();
    const other = "https://github.com/nemarDatasets/.github/actions/runs/111";
    await report(
      { dispatch_id: claim.id, dataset_id: DS, phase: "started", workflow_run_url: RUN_URL },
      claim.token,
    );
    expect(
      (
        await report(
          {
            dispatch_id: claim.id,
            dataset_id: DS,
            phase: "failed",
            code: "runner-failed",
            workflow_run_url: other,
          },
          claim.token,
        )
      ).status,
    ).toBe(200);
    expect(dispatchRow(claim.id)).toMatchObject({ status: "failed", workflow_run_url: RUN_URL });
  });

  test("opened is refused for a row that ended after pr_open (abandoned, failed, superseded)", async () => {
    for (const status of ["abandoned", "failed", "superseded"] as const) {
      db.run("DELETE FROM upstream_repulls");
      db.run("DELETE FROM upstream_repull_dispatches");
      const claim = await claimed();
      const id = automaticRow("pr_open");
      db.run("UPDATE upstream_repull_dispatches SET repull_id = ? WHERE id = ?", [id, claim.id]);
      db.run(
        `UPDATE upstream_repulls SET status = '${status}', terminal_at = datetime('now'), last_error = 'x' WHERE id = ?`,
        [id],
      );
      const res = await report(
        { dispatch_id: claim.id, dataset_id: DS, phase: "opened", repull_id: id },
        claim.token,
      );
      expect([status, res.status, res.body.code]).toEqual([status, 409, "repull-not-ready"]);
      expect(dispatchRow(claim.id)).toMatchObject({ status: "dispatched" });
    }
  });

  test("opened needs this dispatch's own row, automatic, at pr_open or later", async () => {
    const claim = await claimed();
    const notMine = automaticRow("pr_open", { dataset_id: OTHER });
    expect(
      await report(
        { dispatch_id: claim.id, dataset_id: DS, phase: "opened", repull_id: notMine },
        claim.token,
      ),
    ).toMatchObject({ status: 409, body: { code: "repull-mismatch" } });

    const early = automaticRow("registered");
    db.run("UPDATE upstream_repull_dispatches SET repull_id = ? WHERE id = ?", [early, claim.id]);
    expect(
      await report(
        { dispatch_id: claim.id, dataset_id: DS, phase: "opened", repull_id: early },
        claim.token,
      ),
    ).toMatchObject({ status: 409, body: { code: "repull-not-ready" } });
    // An administrator's row at pr_open is not an automatic run's pull request either.
    db.run(
      "UPDATE upstream_repulls SET status = 'pr_open', branch = 'release/v2.0.0', pr_number = 7, head_sha = ?, origin = 'administrator' WHERE id = ?",
      ["a".repeat(40), early],
    );
    expect(
      await report(
        { dispatch_id: claim.id, dataset_id: DS, phase: "opened", repull_id: early },
        claim.token,
      ),
    ).toMatchObject({ status: 409, body: { code: "repull-not-ready" } });
    expect(dispatchRow(claim.id)).toMatchObject({ status: "dispatched" });
    expect(dispatchRow(claim.id).nonce).not.toBeNull();
  });

  test("finished is a finish dispatch's word, and needs its row complete", async () => {
    const open = await claimed();
    expect(
      await report({ dispatch_id: open.id, dataset_id: DS, phase: "finished" }, open.token),
    ).toMatchObject({ status: 409, body: { code: "kind-mismatch" } });
    db.run("DELETE FROM upstream_repull_dispatches");

    const id = automaticRow("released");
    const claim = await claimFinishDispatch(env(), {
      id,
      dataset_id: DS,
      origin: "automatic",
      status: "released",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    });
    if (!("id" in claim)) throw new Error(`refused: ${claim.refused}`);
    const finished = { dispatch_id: claim.id, dataset_id: DS, phase: "finished" };
    expect(await report(finished, claim.token)).toMatchObject({
      status: 409,
      body: { code: "repull-not-ready" },
    });
    expect(
      await report({ ...finished, phase: "opened", repull_id: id }, claim.token),
    ).toMatchObject({ status: 409, body: { code: "kind-mismatch" } });
    db.run(
      "UPDATE upstream_repulls SET status = 'complete', terminal_at = datetime('now') WHERE id = ?",
      [id],
    );
    expect(await report(finished, claim.token)).toMatchObject({ status: 200 });
    expect(dispatchRow(claim.id)).toMatchObject({ status: "finished", nonce: null });
  });
});

describe("the report: what it refuses", () => {
  test("a wrong token, another dispatch's token, another dataset or no header is one answer, 401", async () => {
    const claim = await claimed();
    const other = await claimed(candidate(OTHER));
    const body = { dispatch_id: claim.id, dataset_id: DS, phase: "started" };
    for (const [b, token] of [
      [body, "0".repeat(64)],
      [body, other.token],
      [{ ...body, dataset_id: OTHER }, claim.token],
      [{ ...body, dispatch_id: 999_999 }, claim.token],
      [body, null],
    ] as const) {
      expect(await report(b, token)).toEqual({
        status: 401,
        body: { error: "Invalid or expired dispatch token.", code: "invalid-token" },
      });
    }
    expect(dispatchRow(claim.id).status).toBe("dispatched");
  });

  test("another kind's token over the dispatch's own fields is refused here", async () => {
    const claim = await claimed();
    const nonce = dispatchRow(claim.id).nonce as string;
    const sweep = await signIdentifierSweepCallbackToken({ datasetId: DS, nonce }, SECRET);
    const screen = await signIdentifierRepullCallbackToken(
      { datasetId: DS, repullId: claim.id, pr: "n0", sha: "a".repeat(40), nonce },
      SECRET,
    );
    for (const token of [sweep, screen]) {
      expect(
        await report({ dispatch_id: claim.id, dataset_id: DS, phase: "started" }, token),
      ).toMatchObject({ status: 401 });
    }
    expect(dispatchRow(claim.id).status).toBe("dispatched");
  });

  test("a dispatch token is refused at the sweep's door, over the very nonce the sweep waits on", async () => {
    const claim = await claimed();
    const nonce = dispatchRow(claim.id).nonce as string;
    db.run(
      "INSERT INTO users (username, email, password_hash, status, role, email_verified) VALUES ('rpldsp', 'rpldsp@example.org', 'x', 'approved', 'admin', 1)",
    );
    db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, sweep_stamps) VALUES (?, ?, 1, ?)",
    ).run(
      DS,
      DS,
      JSON.stringify({ identifier_sweep_attempt: "pending", identifier_sweep_nonce: nonce }),
    );
    const post = (token: string) =>
      app.request(
        "/webhooks/identifier-sweep-result",
        {
          method: "POST",
          headers: { "X-Webhook-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({ dataset_id: DS, request_id: 0, report: {} }),
        },
        env(),
      );
    expect((await post(claim.token)).status).toBe(401);
    // The control: the sweep's own token over the same nonce is let through the token check.
    const sweep = await signIdentifierSweepCallbackToken({ datasetId: DS, nonce }, SECRET);
    expect((await post(sweep)).status).not.toBe(401);
  });

  test("a body outside the contract is 400, names no value, and writes nothing", async () => {
    const claim = await claimed();
    const base = { dispatch_id: claim.id, dataset_id: DS };
    for (const b of [
      { ...base, phase: "refused", code: "not-a-word-we-know" },
      { ...base, phase: "refused", code: "Sub-01" },
      { ...base, phase: "refused" },
      { ...base, phase: "failed" },
      { ...base, phase: "started", code: "runner-failed" },
      { ...base, phase: "opened" },
      { ...base, phase: "started", repull_id: 3 },
      { ...base, phase: "unreported" },
      { ...base, phase: "dispatch_failed", code: "dispatch-refused" },
      { ...base, phase: "started", workflow_run_url: "https://example.org/actions/runs/1" },
      {
        ...base,
        phase: "started",
        workflow_run_url: "https://github.com/other/repo/actions/runs/1",
      },
      { ...base, phase: "started", workflow_run_url: `${RUN_URL}?attempt=1` },
      { ...base, phase: "started", workflow_run_url: `${RUN_URL}/jobs/1` },
      {
        ...base,
        phase: "started",
        workflow_run_url: `https://github.com/nemarDatasets/.github/actions/runs/${"9".repeat(21)}`,
      },
      { ...base, phase: "started", extra: 1 },
      { ...base, dataset_id: "xx090123", phase: "started" },
      { ...base, dispatch_id: "1", phase: "started" },
    ]) {
      const res = await report(b, claim.token);
      expect([b, res.status, res.body.code]).toEqual([b, 400, "invalid-body"]);
      expect(JSON.stringify(res.body)).not.toContain("not-a-word-we-know");
    }
    expect(dispatchRow(claim.id)).toMatchObject({ status: "dispatched", reported_at: null });
  });

  test("a body over the bound is refused before it is read", async () => {
    const claim = await claimed();
    const res = await app.request(
      "/webhooks/repull-state",
      {
        method: "POST",
        headers: { "X-Repull-Token": claim.token, "Content-Type": "application/json" },
        body: JSON.stringify({
          dispatch_id: claim.id,
          dataset_id: DS,
          phase: "started",
          pad: "x".repeat(5000),
        }),
      },
      env(),
    );
    expect(res.status).toBe(413);
  });

  test("outside exact production the callback stores nothing", async () => {
    const claim = await claimed();
    for (const environment of ["development", "Production", undefined]) {
      expect(
        await report(
          { dispatch_id: claim.id, dataset_id: DS, phase: "started" },
          claim.token,
          env({ ENVIRONMENT: environment }),
        ),
      ).toMatchObject({ status: 403, body: { code: "auto-production-only" } });
    }
    expect(dispatchRow(claim.id)).toMatchObject({ status: "dispatched", reported_at: null });
  });

  test("the closed list of codes holds only fixed words", () => {
    // The shape is what keeps a path or a message out of the column; that the callback stores
    // nothing outside the list is the 400 on an unknown word in the test above.
    for (const code of DISPATCH_CODES) expect(code).toMatch(/^[a-z0-9-]{1,64}$/);
  });
});

// ----------------------------------------------------------------------------
// The watchdog
// ----------------------------------------------------------------------------

describe("the watchdog", () => {
  const age = (id: number, hours: number) =>
    db.run(
      `UPDATE upstream_repull_dispatches SET dispatched_at = datetime('now', '-${hours} hours') WHERE id = ?`,
      [id],
    );

  test(`a live dispatch older than ${DISPATCH_DEADLINE_HOURS} hours ends unreported, and its late report is refused`, async () => {
    const old = await claimed(candidate("on099991"));
    const started = await claimed(candidate("on099992"));
    const fresh = await claimed(candidate("on099993"), env({ REPULL_DAILY_OPEN_CAP: "5" }));
    expect(
      (
        await report(
          { dispatch_id: started.id, dataset_id: "on099992", phase: "started" },
          started.token,
        )
      ).status,
    ).toBe(200);
    age(old.id, DISPATCH_DEADLINE_HOURS + 1);
    age(started.id, DISPATCH_DEADLINE_HOURS + 1);
    age(fresh.id, DISPATCH_DEADLINE_HOURS - 1);

    expect(await sweepUnreportedDispatches(env())).toEqual({ marked: 2 });
    expect(dispatchRow(old.id)).toMatchObject({ status: "unreported", nonce: null });
    expect(dispatchRow(started.id)).toMatchObject({ status: "unreported", nonce: null });
    expect(dispatchRow(fresh.id)).toMatchObject({ status: "dispatched" });
    const [audit] = audits("repull_dispatch_unreported");
    expect(JSON.parse(audit?.details as string)).toEqual({ marked: 2, deadline_hours: 8 });

    expect(
      await report(
        { dispatch_id: old.id, dataset_id: "on099991", phase: "failed", code: "runner-failed" },
        old.token,
      ),
    ).toMatchObject({ status: 401 });
    // A sweep that marks nothing writes no audit row.
    expect(await sweepUnreportedDispatches(env())).toEqual({ marked: 0 });
    expect(audits("repull_dispatch_unreported")).toHaveLength(1);
    // The dataset's live slot is free again.
    await claimed(candidate("on099991"), env({ REPULL_DAILY_OPEN_CAP: "5" }));
  });

  test("the bound is eight hours: seven and a half hours ends nothing, eight and a half ends it", async () => {
    const claim = await claimed();
    const ageBy = (interval: string) =>
      db.run(
        `UPDATE upstream_repull_dispatches SET dispatched_at = datetime('now', ${interval}) WHERE id = ?`,
        [claim.id],
      );
    for (const interval of [
      "'-7 hours'",
      "'-7 hours', '-30 minutes'",
      "'-7 hours', '-59 minutes'",
    ]) {
      ageBy(interval);
      expect([interval, await sweepUnreportedDispatches(env())]).toEqual([interval, { marked: 0 }]);
      expect(dispatchRow(claim.id).status).toBe("dispatched");
    }
    expect(audits("repull_dispatch_unreported")).toEqual([]);
    ageBy("'-8 hours', '-30 minutes'");
    expect(await sweepUnreportedDispatches(env())).toEqual({ marked: 1 });
    expect(dispatchRow(claim.id)).toMatchObject({ status: "unreported", nonce: null });
  });

  test("a count the database does not report is an error, never zero marked", async () => {
    const claim = await claimed();
    db.run(
      "UPDATE upstream_repull_dispatches SET dispatched_at = datetime('now', '-9 hours') WHERE id = ?",
      [claim.id],
    );
    const real = realD1(db);
    const silent = {
      prepare: real.prepare.bind(real),
      // The real results of the real batch, with the count the caller reads left out.
      batch: async (stmts: unknown[]) =>
        ((await real.batch(stmts as never)) as unknown as Array<{ meta: object }>).map((r) => ({
          ...r,
          meta: {},
        })),
    } as unknown as D1Database;
    const e = env();
    (e as unknown as { DB: D1Database }).DB = silent;
    await expect(sweepUnreportedDispatches(e)).rejects.toThrow(/did not report how many/);
  });

  test("outside exact production it is null and writes nothing; it does not read the switches", async () => {
    const claim = await claimed();
    age(claim.id, DISPATCH_DEADLINE_HOURS + 1);
    const before = tableState();
    for (const environment of ["development", "staging", "Production", undefined]) {
      expect(await sweepUnreportedDispatches(env({ ENVIRONMENT: environment }))).toBeNull();
    }
    expect(tableState()).toEqual(before);
    expect(await sweepUnreportedDispatches(env({ AUTO_REPULL_ENABLED: undefined }))).toEqual({
      marked: 1,
    });
  });
});

// ----------------------------------------------------------------------------
// The guards behind the service's own checks
// ----------------------------------------------------------------------------

describe("the statements hold when a row or a caller disagrees with the service", () => {
  test("a dispatch linked to another dataset's re-pull cannot report opened or finished", async () => {
    // Opened: the dispatch (of DS) is linked, by direct SQL, to a pr_open row of OTHER.
    const open = await claimed();
    const foreign = automaticRow("pr_open", { dataset_id: OTHER });
    db.run("UPDATE upstream_repull_dispatches SET repull_id = ? WHERE id = ?", [foreign, open.id]);
    expect(
      await report(
        { dispatch_id: open.id, dataset_id: DS, phase: "opened", repull_id: foreign },
        open.token,
      ),
    ).toMatchObject({ status: 409, body: { code: "repull-not-ready" } });
    expect(dispatchRow(open.id)).toMatchObject({ status: "dispatched" });
    expect(dispatchRow(open.id).nonce).not.toBeNull();

    // Finished: a finish dispatch of DS whose row is changed to a complete row of OTHER.
    db.run("DELETE FROM upstream_repull_dispatches");
    const mine = automaticRow("released");
    const finish = await claimFinishDispatch(env(), {
      id: mine,
      dataset_id: DS,
      origin: "automatic",
      status: "released",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    });
    if (!("id" in finish)) throw new Error(`refused: ${finish.refused}`);
    const theirs = automaticRow("complete", { dataset_id: OTHER, attempt: 2 });
    db.run("UPDATE upstream_repull_dispatches SET repull_id = ? WHERE id = ?", [theirs, finish.id]);
    expect(
      await report({ dispatch_id: finish.id, dataset_id: DS, phase: "finished" }, finish.token),
    ).toMatchObject({ status: 409, body: { code: "repull-not-ready" } });
    expect(dispatchRow(finish.id).status).toBe("dispatched");
  });

  test("a report statement applies only under the nonce that verified", async () => {
    const claim = await claimed();
    const row = dispatchRow(claim.id);
    const bind = (nonce: string) => [row.id, nonce, "dispatched", "runner-failed", null, null];
    expect(
      db.query(DISPATCH_REPORT_SQL.failed).run(...(bind(`${row.nonce}0`) as never[])).changes,
    ).toBe(0);
    expect(dispatchRow(claim.id).status).toBe("dispatched");
    expect(
      db.query(DISPATCH_REPORT_SQL.failed).run(...(bind(row.nonce as string) as never[])).changes,
    ).toBe(1);
    expect(dispatchRow(claim.id)).toMatchObject({ status: "failed", nonce: null });
  });

  test("a dispatch is linked once, to a live dispatch, under its own nonce", async () => {
    const claim = await claimed();
    const nonce = dispatchRow(claim.id).nonce as string;
    const id = automaticRow("planned");
    const link = (repull: number, dispatch: number, n: string) =>
      db.query(DISPATCH_LINK_SQL).run(repull, dispatch, n).changes;
    // Another nonce links nothing, by either statement.
    expect(link(id, claim.id, `${nonce}0`)).toBe(0);
    const key = db
      .query("SELECT dataset_id, to_tag, attempt FROM upstream_repulls WHERE id = ?")
      .get(id) as { dataset_id: string; to_tag: string; attempt: number };
    expect(
      db
        .query(DISPATCH_LINK_BY_KEY_SQL)
        .run(key.dataset_id, key.to_tag, key.attempt, claim.id, `${nonce}0`).changes,
    ).toBe(0);
    expect(dispatchRow(claim.id).repull_id).toBeNull();
    expect(
      db
        .query(DISPATCH_LINK_BY_KEY_SQL)
        .run(key.dataset_id, key.to_tag, key.attempt, claim.id, nonce).changes,
    ).toBe(1);
    db.run("UPDATE upstream_repull_dispatches SET repull_id = NULL WHERE id = ?", [claim.id]);
    expect(link(id, claim.id, nonce)).toBe(1);
    // Already linked: a second link, even to another row, changes nothing.
    const other = automaticRow("planned", { dataset_id: OTHER });
    expect(link(other, claim.id, nonce)).toBe(0);
    expect(dispatchRow(claim.id).repull_id).toBe(id);

    // An ended dispatch is not linked, by either statement.
    db.run("DELETE FROM upstream_repull_dispatches");
    db.run("DELETE FROM upstream_repulls");
    const ended = await claimed();
    const target = automaticRow("planned");
    const endedNonce = dispatchRow(ended.id).nonce as string;
    db.run("UPDATE upstream_repull_dispatches SET status = 'unreported', nonce = NULL");
    expect(link(target, ended.id, endedNonce)).toBe(0);
    expect(
      db.query(DISPATCH_LINK_BY_KEY_SQL).run(DS, "1.0.1", 1, ended.id, endedNonce).changes,
    ).toBe(0);
    expect(dispatchRow(ended.id).repull_id).toBeNull();
  });
});
