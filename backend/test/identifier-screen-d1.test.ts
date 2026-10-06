/**
 * The identifier screen's SQL on Miniflare D1, the implementation `wrangler
 * --local` runs (epic #1610, phase 4).
 *
 * Every other screen test runs on bun:sqlite, which is more lenient than D1.
 * The statements that carry the feature's guarantees are the ones run here,
 * through the real service functions with only the database swapped: the email
 * claim (an `UPDATE ... RETURNING` read with `.first()`) and its compare-and-set
 * release, the conditional store, both watchdog passes, and the acknowledgment.
 * Resend is the shared capture; nothing leaves the machine.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  notifyAdminsOfScreen,
  recordScreenAcknowledgment,
  storeScreenResult,
  sweepIdentifierScreens,
} from "../src/services/identifier-screen";
import type { Bindings } from "../src/types/bindings";
import { cleanScreenReportBody } from "./helpers/identifier-screen";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { asSend, withFakeResend } from "./helpers/resend";

const DATASET = "nm000470";
let mf: Miniflare;
let counter = 0;

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
  await d1
    .prepare(
      `INSERT INTO publication_requests (id, dataset_id, requested_by, status,
                                         identifier_screen_status, identifier_screen_nonce,
                                         identifier_screen_dispatched_at)
       VALUES (1, ?, 1, 'requested', 'pending', 'n1', datetime('now'))`,
    )
    .bind(DATASET)
    .run();
  return d1;
}

function env(d1: D1Database): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: "production",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

async function screenRow(d1: D1Database) {
  return d1
    .prepare(
      `SELECT identifier_screen_status, identifier_screen_nonce, identifier_screen_emailed_at,
              identifier_screen_mail_claimed_at, identifier_screen_ack_by
         FROM publication_requests WHERE id = 1`,
    )
    .first<{
      identifier_screen_status: string | null;
      identifier_screen_nonce: string | null;
      identifier_screen_emailed_at: string | null;
      identifier_screen_mail_claimed_at: string | null;
      identifier_screen_ack_by: number | null;
    }>();
}

beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB1", "DB2", "DB3", "DB4", "DB5", "DB6"],
  });
});

afterAll(async () => {
  await mf?.dispose();
});

describe("the screen's statements on D1", () => {
  test("store once, claim and send once, and a replay stores nothing", async () => {
    const d1 = await seededD1();
    await withFakeResend(async (calls) => {
      const stored = await storeScreenResult(env(d1), {
        requestId: 1,
        datasetId: DATASET,
        nonce: "n1",
        body: cleanScreenReportBody(DATASET),
      });
      expect(stored).toEqual({ stored: true, state: "clean", blocked: false });
      expect((await screenRow(d1))?.identifier_screen_nonce).toBeNull();

      const again = await storeScreenResult(env(d1), {
        requestId: 1,
        datasetId: DATASET,
        nonce: "n1",
        body: cleanScreenReportBody(DATASET),
      });
      expect(again).toEqual({ stored: false });

      expect(await notifyAdminsOfScreen(env(d1), 1)).toBe("sent");
      expect(await notifyAdminsOfScreen(env(d1), 1)).toBe("not-claimed");
      const sends = calls.filter((c) => c.path === "/emails").map(asSend);
      expect(sends).toHaveLength(1);
      expect(sends[0].subject).toEndWith("IDENTIFIER SCREEN: clean");
      expect((await screenRow(d1))?.identifier_screen_emailed_at).not.toBeNull();
    });
  });

  test("a send that reaches nobody is released by compare-and-set", async () => {
    const d1 = await seededD1();
    await storeScreenResult(env(d1), {
      requestId: 1,
      datasetId: DATASET,
      nonce: "n1",
      body: cleanScreenReportBody(DATASET),
    });
    await withFakeResend(
      async () => {
        expect(await notifyAdminsOfScreen(env(d1), 1)).toBe("undelivered");
      },
      { status: 500 },
    );
    expect((await screenRow(d1))?.identifier_screen_emailed_at).toBeNull();
    expect((await screenRow(d1))?.identifier_screen_mail_claimed_at).toBeNull();
  });

  test("a live lease holds off a second sender; an expired one is taken", async () => {
    const d1 = await seededD1();
    await storeScreenResult(env(d1), {
      requestId: 1,
      datasetId: DATASET,
      nonce: "n1",
      body: cleanScreenReportBody(DATASET),
    });
    await d1
      .prepare(
        "UPDATE publication_requests SET identifier_screen_mail_claimed_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = 1",
      )
      .run();
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(d1), 1)).toBe("not-claimed");
      await d1
        .prepare(
          "UPDATE publication_requests SET identifier_screen_mail_claimed_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-6 minutes') WHERE id = 1",
        )
        .run();
      expect(await notifyAdminsOfScreen(env(d1), 1)).toBe("sent");
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
      const row = await screenRow(d1);
      expect(row?.identifier_screen_emailed_at).not.toBeNull();
      expect(row?.identifier_screen_mail_claimed_at).toBeNull();
    });
  });

  test("the watchdog's two passes: overdue becomes unreported and mailed; a lost mail is retried", async () => {
    const d1 = await seededD1();
    await d1
      .prepare(
        "UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-2 hours') WHERE id = 1",
      )
      .run();
    await withFakeResend(async (calls) => {
      const first = await sweepIdentifierScreens(env(d1));
      expect(first).toMatchObject({ timedOut: 1, emailed: 1, errors: 0 });
      expect((await screenRow(d1))?.identifier_screen_status).toBe("unreported");
      // The nonce stays, so the run's late report is still accepted.
      expect((await screenRow(d1))?.identifier_screen_nonce).toBe("n1");

      // Lose the mail, age the result, and the second pass sends it again.
      await d1
        .prepare(
          `UPDATE publication_requests SET identifier_screen_emailed_at = NULL,
                  identifier_screen_at = datetime('now', '-10 minutes') WHERE id = 1`,
        )
        .run();
      const second = await sweepIdentifierScreens(env(d1));
      expect(second).toMatchObject({ timedOut: 0, emailed: 1, errors: 0 });
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(2);

      const late = await storeScreenResult(env(d1), {
        requestId: 1,
        datasetId: DATASET,
        nonce: "n1",
        body: cleanScreenReportBody(DATASET),
      });
      expect(late).toEqual({ stored: true, state: "clean", blocked: false });
      const row = await screenRow(d1);
      expect(row?.identifier_screen_emailed_at).toBeNull();
      expect(row?.identifier_screen_nonce).toBeNull();
    });
  });

  test("an acknowledgment attaches only to the state it was given for", async () => {
    const d1 = await seededD1();
    await d1
      .prepare("UPDATE publication_requests SET identifier_screen_status = 'review' WHERE id = 1")
      .run();
    const reason = "Read every flagged header by hand; serial numbers only.";
    expect(
      await recordScreenAcknowledgment(d1, {
        requestId: 1,
        datasetId: DATASET,
        adminUserId: 2,
        reason,
        state: "unchecked",
      }),
    ).toBe(false);
    expect(
      await recordScreenAcknowledgment(d1, {
        requestId: 1,
        datasetId: DATASET,
        adminUserId: 2,
        reason,
        state: "review",
      }),
    ).toBe(true);
    expect((await screenRow(d1))?.identifier_screen_ack_by).toBe(2);
    const audit = await d1
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'identifier_screen_acknowledged'",
      )
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });
});
