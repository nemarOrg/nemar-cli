/**
 * The identifier sweep's SQL on Miniflare D1, the implementation `wrangler
 * --local` runs (epic #1610, phase 5, ADR 0088).
 *
 * Every other sweep test runs on bun:sqlite, which is more lenient than D1
 * (a GLOB pattern-length limit, for one, has bitten this repo before). The
 * statements that carry the sweep's guarantees run here through the real
 * service functions with only the database swapped: the candidate query and
 * its ordering, the claim, the in-flight count, the unreported pass, the
 * store and the failed-attempt compare-and-set, the rescreen request, the
 * weekly rows and due count, and the weekly report's atomic claim.
 * GitHub is a `Bun.serve()` stand-in; Resend is the shared capture.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Miniflare } from "miniflare";
import {
  gatherIdentifierWeek,
  requestRescreen,
  runIdentifierSweepTick,
  sendIdentifierSweepWeeklyReport,
  storeSweepResult,
  weeklyRecordState,
} from "../src/services/identifier-sweep";
import type { Bindings } from "../src/types/bindings";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { asSend, withFakeResend } from "./helpers/resend";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
let mf: Miniflare;
let counter = 0;
let server: Server;
let dispatched: string[] = [];

function scanBody(id: string, status: string, incomplete = false) {
  return {
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: HEAD,
    scan: {
      id,
      version: null,
      scanned_at: "2026-10-05T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete,
      incomplete_reasons: incomplete ? ["deadline"] : [],
      files: { total: 4, edf_bdf: 2, header_read: incomplete ? 1 : 2, header_read_failed: 0 },
      ...(status === "direct-identifiers"
        ? { findings_by_kind: { "edf-patient-name": 2 }, edf_bdf_files_flagged: 2 }
        : {}),
    },
  };
}

async function seededD1(): Promise<D1Database> {
  counter += 1;
  const d1 = (await mf.getD1Database(`DB${counter}`)) as unknown as D1Database;
  await applyMigrations(d1, migrationFiles());
  await d1
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'd1owner', 'd1owner@example.org', 'x', 'approved', 'member', 1),
              (2, 'd1admin', 'd1admin@example.org', 'x', 'approved', 'admin', 1)`,
    )
    .run();
  for (const [id, visibility] of [
    ["nm000800", "public"],
    ["nm000801", "public"],
    ["nm000802", "public"],
    ["nm000803", "private"],
    ["xx000804", "public"],
  ]) {
    await d1
      .prepare(
        `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
         VALUES (?, ?, 1, 'active', ?, ?)`,
      )
      .bind(id, `Dataset ${id}`, visibility, `nemarDatasets/${id}`)
      .run();
  }
  await d1
    .prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
       VALUES ('nm000800', '1.0.0', '10.82901/x', datetime('now', '-30 days'))`,
    )
    .run();
  return d1;
}

function env(d1: D1Database): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_sweep_d1",
    PRESCREEN_CALLBACK_SECRET: "sweep-d1-secret",
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

async function stampsOf(d1: D1Database, id: string): Promise<Record<string, unknown>> {
  const row = await d1
    .prepare("SELECT sweep_stamps AS s FROM datasets WHERE dataset_id = ?")
    .bind(id)
    .first<{ s: string | null }>();
  return row?.s ? (JSON.parse(row.s) as Record<string, unknown>) : {};
}

beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB1", "DB2", "DB3", "DB4", "DB5", "DB6"],
  });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        const body = (await req.json()) as { client_payload: { dataset_id: string } };
        dispatched.push(body.client_payload.dataset_id);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
  await mf?.dispose();
});

afterEach(() => {
  dispatched = [];
});

describe("the sweep's statements on D1", () => {
  test("select, claim and dispatch in scope only; count in flight; store once; the verdict reads back", async () => {
    const d1 = await seededD1();
    const tick = await runIdentifierSweepTick(env(d1));
    expect(tick.errors).toEqual([]);
    expect(tick.inFlight).toBe(0);
    expect(dispatched.sort()).toEqual(["nm000800", "nm000801", "nm000802"]);
    const s = await stampsOf(d1, "nm000800");
    expect(s.identifier_sweep_attempt).toBe("pending");
    expect(s.identifier_sweep_attempt_version).toBe("1.0.0");

    const nonce = s.identifier_sweep_nonce as string;
    const body = scanBody("nm000800", "direct-identifiers");
    // A scan under any other nonce is not this attempt's, and stores nothing.
    expect(
      await storeSweepResult(env(d1), { datasetId: "nm000800", nonce: "not-it", body }),
    ).toEqual({ stored: false });
    expect((await stampsOf(d1, "nm000800")).identifier_sweep_status).toBeUndefined();
    expect(await storeSweepResult(env(d1), { datasetId: "nm000800", nonce, body })).toEqual({
      stored: true,
      kind: "verdict",
      status: "direct-identifiers",
    });
    expect(await storeSweepResult(env(d1), { datasetId: "nm000800", nonce, body })).toEqual({
      stored: false,
    });
    const after = await stampsOf(d1, "nm000800");
    expect(after.identifier_sweep_version).toBe("1.0.0");
    expect(after.identifier_sweep_nonce).toBeUndefined();
    expect((after.identifier_sweep_report as { head: string }).head).toBe(HEAD);

    // The second tick counts the two still in flight and selects nothing new.
    const second = await runIdentifierSweepTick(env(d1));
    expect(second.inFlight).toBe(2);
    expect(second.dispatched).toBe(0);
  });

  test("unreported after the deadline with the nonce kept; a failed attempt by compare-and-set", async () => {
    const d1 = await seededD1();
    await runIdentifierSweepTick(env(d1));
    await d1
      .prepare(
        `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_attempted_at', datetime('now', '-2 hours'))
          WHERE dataset_id = 'nm000801'`,
      )
      .run();
    const nonce = (await stampsOf(d1, "nm000801")).identifier_sweep_nonce as string;
    const tick = await runIdentifierSweepTick(env(d1));
    expect(tick.timedOut).toBe(1);
    const s = await stampsOf(d1, "nm000801");
    expect(s.identifier_sweep_attempt).toBe("unreported");
    expect(s.identifier_sweep_nonce).toBe(nonce);

    const wrong = await storeSweepResult(env(d1), {
      datasetId: "nm000801",
      nonce: "not-it",
      body: { version: 1, scanner: null, head: null, error: "deadline" },
    });
    expect(wrong).toEqual({ stored: false });
    const right = await storeSweepResult(env(d1), {
      datasetId: "nm000801",
      nonce,
      body: { version: 1, scanner: null, head: null, error: "deadline" },
    });
    expect(right).toEqual({ stored: true, kind: "error", error: "deadline" });
    const closed = await stampsOf(d1, "nm000801");
    expect(closed.identifier_sweep_attempt_error).toBe("deadline");
    expect(closed.identifier_sweep_status).toBeUndefined();
  });

  test("a rescreen request lands only in scope, and the weekly rows and due count read on D1", async () => {
    const d1 = await seededD1();
    expect(await requestRescreen(env(d1), { datasetId: "nm000803", adminUserId: 2 })).toBe(
      "out-of-scope",
    );
    expect(await requestRescreen(env(d1), { datasetId: "nm000999", adminUserId: 2 })).toBe(
      "not-found",
    );
    expect(await requestRescreen(env(d1), { datasetId: "nm000802", adminUserId: 2 })).toBe(
      "requested",
    );
    const facts = await gatherIdentifierWeek(d1, new Date());
    expect(facts.errors).toEqual([]);
    expect(facts.scope).toBe(3);
    expect(facts.due).toBe(3);
    expect(facts.unchecked).toBe(3);
  });

  test("ordering and the slice, a kept finding, the growing backoff and the late bound, on D1", async () => {
    const d1 = await seededD1();
    // Two more in scope, so the slice of 3 leaves some for later and the order shows.
    for (const id of ["nm000805", "nm000806"]) {
      await d1
        .prepare(
          `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
           VALUES (?, ?, 1, 'active', 'public', ?)`,
        )
        .bind(id, `Dataset ${id}`, `nemarDatasets/${id}`)
        .run();
    }
    const first = await runIdentifierSweepTick(env(d1));
    expect(first.candidates).toBe(3);
    expect(dispatched).toEqual(["nm000800", "nm000801", "nm000802"]);

    // A finding, then an incomplete screen: the finding is carried forward.
    const n800 = (await stampsOf(d1, "nm000800")).identifier_sweep_nonce as string;
    await storeSweepResult(env(d1), {
      datasetId: "nm000800",
      nonce: n800,
      body: scanBody("nm000800", "direct-identifiers"),
    });
    await requestRescreen(env(d1), { datasetId: "nm000800", adminUserId: 2 });
    dispatched = [];
    const second = await runIdentifierSweepTick(env(d1));
    // The request first, then the two never attempted, in id order.
    expect(dispatched).toEqual(["nm000800", "nm000805", "nm000806"]);
    expect(second.inFlight).toBe(2);
    const n800b = (await stampsOf(d1, "nm000800")).identifier_sweep_nonce as string;
    await storeSweepResult(env(d1), {
      datasetId: "nm000800",
      nonce: n800b,
      body: scanBody("nm000800", "unchecked", true),
    });
    const kept = (await stampsOf(d1, "nm000800")).identifier_sweep_finding as { status: string };
    expect(kept.status).toBe("direct-identifiers");
    const facts = await gatherIdentifierWeek(d1, new Date());
    expect(facts.errors).toEqual([]);
    expect(facts.flagged?.map((f) => [f.dataset_id, f.standing])).toEqual([
      ["nm000800", "earlier"],
    ]);

    // Two failures in a row: the second backoff is 12 hours, read through the CASE on D1.
    const n801 = (await stampsOf(d1, "nm000801")).identifier_sweep_nonce as string;
    await storeSweepResult(env(d1), {
      datasetId: "nm000801",
      nonce: n801,
      body: { version: 1, scanner: null, head: null, error: "clone-failed" },
    });
    await d1
      .prepare(
        `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps,
            '$.identifier_sweep_failures', 2,
            '$.identifier_sweep_attempted_at', datetime('now', '-11 hours'))
          WHERE dataset_id = 'nm000801'`,
      )
      .run();
    dispatched = [];
    await runIdentifierSweepTick(env(d1));
    expect(dispatched).not.toContain("nm000801");
    await d1
      .prepare(
        `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_attempted_at', datetime('now', '-13 hours'))
          WHERE dataset_id = 'nm000801'`,
      )
      .run();
    dispatched = [];
    await runIdentifierSweepTick(env(d1));
    expect(dispatched).toContain("nm000801");

    // An unreported screen older than the late bound no longer answers on D1.
    const n802 = (await stampsOf(d1, "nm000802")).identifier_sweep_nonce as string;
    await d1
      .prepare(
        `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps,
            '$.identifier_sweep_attempt', 'unreported',
            '$.identifier_sweep_attempted_at', datetime('now', '-25 hours'))
          WHERE dataset_id = 'nm000802'`,
      )
      .run();
    expect(
      await storeSweepResult(env(d1), {
        datasetId: "nm000802",
        nonce: n802,
        body: scanBody("nm000802", "clean"),
      }),
    ).toEqual({ stored: false });
  });

  test("a send refused outright marks its claim on D1, and the cap does not count it", async () => {
    const d1 = await seededD1();
    const when = new Date(Date.now() + 7 * 86_400_000);
    await withFakeResend(
      async () => {
        expect(await sendIdentifierSweepWeeklyReport(env(d1), when)).toMatchObject({
          claimed: true,
          delivered: 0,
          ambiguous: 0,
        });
      },
      { status: 401 },
    );
    const claim = await d1
      .prepare("SELECT details FROM audit_log WHERE action = 'identifier_sweep_report_claim'")
      .first<{ details: string | null }>();
    expect(claim?.details).toBe('{"delivered":0}');
    const state = await weeklyRecordState(d1, when);
    expect(state).toMatchObject({ sent: false, counted: 0, exhausted: false });
  });

  test("the weekly report's claim is atomic and once per week on D1", async () => {
    const d1 = await seededD1();
    await withFakeResend(async (calls) => {
      const when = new Date(Date.now() + 7 * 86_400_000);
      const first = await sendIdentifierSweepWeeklyReport(env(d1), when);
      expect(first).toMatchObject({ claimed: true, delivered: 1 });
      const second = await sendIdentifierSweepWeeklyReport(env(d1), when);
      expect(second?.claimed).toBe(false);
      const sends = calls.filter((c) => c.path === "/emails").map(asSend);
      expect(sends).toHaveLength(1);
      expect(sends[0]?.subject).toContain("0 with identifiers, 3 unchecked");
    });
  });
});
