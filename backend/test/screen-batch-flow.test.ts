/**
 * The paced re-screen, end to end through the real routes (epic #2182, card D4; ADR 0086,
 * amendment of 2026-11-25).
 *
 * A batch dispatches many screens through the ordinary re-run route; each stores the result a single
 * screen stores, sends no per-request mail to the administrators and none to the depositor, and
 * the batch sends ONE digest when it ends. Real engine only: bun:sqlite behind realD1 with every
 * migration applied, the real auth middleware, the real routes (`/admin`, `/webhooks`) through
 * Hono's `app.request()`. GitHub is a `Bun.serve()` stand-in that records each dispatch; Resend is
 * the shared real-boundary capture (`helpers/resend.ts`), so the mail counted is the mail that
 * would go and nothing is sent.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import webhooks from "../src/routes/webhooks";
import {
  RESET_SCREEN_COLUMNS_SQL,
  SCREEN_REPORT_DEADLINE_MINUTES,
  storeScreenResult,
  sweepIdentifierScreens,
} from "../src/services/identifier-screen";
import {
  DIGEST_AFTER_LAST_DISPATCH_MINUTES,
  parseSelection,
  sendDigestIfDue,
  settleBatchEntry,
} from "../src/services/screen-batch";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1, yieldingD1 } from "./helpers/d1";
import { SCREENED_HEAD, cleanScreenReportBody } from "./helpers/identifier-screen";
import { type CapturedEmail, type ResendSendBody, asSend, withFakeResend } from "./helpers/resend";

const SECRET = "batch-test-secret";
const ADMIN_KEY = "batch-admin-key-0123456789abcdef0123456789abcdef";
const OWNER_KEY = "batch-owner-key-0123456789abcdef0123456789abcdef";
const ADMIN_EMAIL = "batchadmin@example.org";
const OWNER_EMAIL = "batchowner@example.org";

const A = "nm000460";
const B = "nm000461";
const C = "nm000462";
const D = "nm000463";

interface Dispatch {
  client_payload: { dataset_id: string; request_id: number; callback_token: string };
}

let server: Server;
let dispatches: Dispatch[] = [];
let dispatchStatus = 204;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
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
  dispatchStatus = 204;
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_batch_test",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

async function seedUser(username: string, role: string, email: string, key: string) {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1, 'Ada', 'Lovelace')`,
    [username, email, role],
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

/** A dataset with an open publication request, as a depositor's request leaves it before any screen. */
function seedRequest(
  datasetId: string,
  opts: { status?: string; blockReason?: string; screen?: string } = {},
): number {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo)
     VALUES (?, ?, ?, 'active', 'private', 0, ?)`,
    [
      datasetId,
      `A sufficiently descriptive title for ${datasetId}`,
      ownerId,
      `nemarDatasets/${datasetId}`,
    ],
  );
  db.run(
    `INSERT INTO publication_requests (dataset_id, requested_by, status, block_reason)
     VALUES (?, ?, ?, ?)`,
    [datasetId, ownerId, opts.status ?? "requested", opts.blockReason ?? null],
  );
  const id = requestRow(datasetId).id;
  if (opts.screen) {
    db.run(
      `UPDATE publication_requests SET identifier_screen_status = ?,
              identifier_screen_report = ?, identifier_screen_at = datetime('now'),
              identifier_screen_emailed_at = datetime('now') WHERE id = ?`,
      [opts.screen, JSON.stringify(reportBody(datasetId, opts.screen)), id],
    );
  }
  return id;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/webhooks", webhooks);
  ownerId = await seedUser("batchowner", "member", OWNER_EMAIL, OWNER_KEY);
  await seedUser("batchadmin", "admin", ADMIN_EMAIL, ADMIN_KEY);
});

interface RequestRow {
  id: number;
  status: string;
  block_reason: string | null;
  identifier_screen_status: string | null;
  identifier_screen_report: string | null;
  identifier_screen_batch_id: number | null;
  identifier_screen_emailed_at: string | null;
  identifier_screen_nonce: string | null;
}

function requestRow(datasetId: string): RequestRow {
  return db
    .query<RequestRow, [string]>(
      `SELECT id, status, block_reason, identifier_screen_status, identifier_screen_report,
              identifier_screen_batch_id, identifier_screen_emailed_at, identifier_screen_nonce
         FROM publication_requests WHERE dataset_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(datasetId) as RequestRow;
}

interface BatchRow {
  id: number;
  total: number;
  closed_at: string | null;
  reported: number;
  digest_sent_at: string | null;
  digest_claimed_at: string | null;
  refused: string | null;
}

function batchRow(id: number): BatchRow {
  return db
    .query<BatchRow, [number]>(
      "SELECT id, total, closed_at, reported, digest_sent_at, digest_claimed_at, refused FROM screen_batches WHERE id = ?",
    )
    .get(id) as BatchRow;
}

/** A real report, built the way the workflow posts it, with the findings the test cares about. */
function reportBody(datasetId: string, status: string, findings?: Record<string, number>) {
  const body = cleanScreenReportBody(datasetId, SCREENED_HEAD, status);
  if (findings) (body.scan as Record<string, unknown>).findings_by_kind = findings;
  return body;
}

function asAdmin(path: string, body?: unknown, bindings: Bindings = env()) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings,
  );
}

async function createBatch(ids: string[], bindings: Bindings = env()): Promise<number> {
  const res = await asAdmin("/admin/publish/screen-batches", { dataset_ids: ids }, bindings);
  expect(res.status).toBe(201);
  return ((await res.json()) as { batch_id: number }).batch_id;
}

function screen(datasetId: string, batchId?: number, bindings: Bindings = env()) {
  return asAdmin(
    `/admin/publish/${datasetId}/identifier-screen`,
    batchId === undefined ? undefined : { batch_id: batchId },
    bindings,
  );
}

function callback(datasetId: string, report: unknown, bindings: Bindings = env()) {
  const d = dispatches.filter((x) => x.client_payload.dataset_id === datasetId).at(-1);
  if (!d) throw new Error(`no dispatch for ${datasetId}`);
  return app.request(
    "/webhooks/identifier-screen-result",
    {
      method: "POST",
      headers: {
        "X-Webhook-Token": d.client_payload.callback_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dataset_id: datasetId,
        request_id: d.client_payload.request_id,
        report,
      }),
    },
    bindings,
  );
}

const subjectsOf = (calls: CapturedEmail[]): string[] =>
  calls.filter((c) => c.path === "/emails").map((c) => asSend(c).subject);
const digestsOf = (calls: CapturedEmail[]): ResendSendBody[] =>
  calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((m) => m.subject.startsWith("[NEMAR] Re-screen batch"));
const perRequestMails = (calls: CapturedEmail[]): ResendSendBody[] =>
  calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((m) => m.subject.startsWith("[NEMAR] Publication request"));
const toOwner = (calls: CapturedEmail[]): ResendSendBody[] =>
  calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((m) => m.to.includes(OWNER_EMAIL));

// ============================================================================

describe("creating a batch", () => {
  test("keeps the selection, and leaves out what has no open request or is never screened", async () => {
    seedRequest(A, { screen: "review" });
    seedRequest(B, { status: "blocked", blockReason: "identifier_screen_findings" });
    const res = await asAdmin("/admin/publish/screen-batches", {
      dataset_ids: [A, B, A, "nm000999", "xx099901"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { batch_id: number; total: number; skipped: string[] };
    expect(body.total).toBe(2);
    expect(body.skipped.sort()).toEqual(["nm000999", "xx099901"]);
    const row = db
      .query<{ selection: string; created_by: number }, [number]>(
        "SELECT selection, created_by FROM screen_batches WHERE id = ?",
      )
      .get(body.batch_id);
    // The state and the status before the batch are what the digest compares with.
    expect(parseSelection(row?.selection ?? "")).toEqual([
      [requestRow(A).id, A, "review", "requested"],
      [requestRow(B).id, B, null, "blocked"],
    ]);
  });

  test("refuses a batch with nothing to screen and one over the bound", async () => {
    const none = await asAdmin("/admin/publish/screen-batches", { dataset_ids: ["nm000999"] });
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: string }).error).toBe("empty_batch");

    // The bound is written out here (500), not read from the constant under test.
    const ids = Array.from({ length: 501 }, (_, i) => `nm${String(i + 1).padStart(6, "0")}`);
    const big = await asAdmin("/admin/publish/screen-batches", { dataset_ids: ids });
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toBe("batch_too_large");
    // A batch of exactly the bound is accepted (the bound is not one short).
    const exact = await asAdmin("/admin/publish/screen-batches", {
      dataset_ids: ids.slice(0, 500),
    });
    expect(((await exact.json()) as { error?: string }).error).toBe("empty_batch");
  });

  test("an administrator only: a member is refused", async () => {
    seedRequest(A);
    const res = await app.request(
      "/admin/publish/screen-batches",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ dataset_ids: [A] }),
      },
      env(),
    );
    expect(res.status).toBe(403);
    expect(db.query("SELECT COUNT(*) AS n FROM screen_batches").get()).toEqual({ n: 0 });
  });
});

describe("a batch of three screens", () => {
  test("stores three results, mails no request, and sends exactly one digest at the end", async () => {
    seedRequest(A, { screen: "clean" });
    seedRequest(B, { screen: "review" });
    seedRequest(C);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B, C]);
      for (const id of [A, B, C]) expect((await screen(id, batchId)).status).toBe(202);
      expect(dispatches).toHaveLength(3);
      for (const id of [A, B, C]) {
        expect(requestRow(id).identifier_screen_status).toBe("pending");
        expect(requestRow(id).identifier_screen_batch_id).toBe(batchId);
      }

      expect((await callback(A, reportBody(A, "clean"))).status).toBe(200);
      expect(
        (await callback(B, reportBody(B, "review", { "edf-patient-freetext": 3 }))).status,
      ).toBe(200);
      // Two of three have reported: nothing is mailed yet.
      expect(subjectsOf(calls)).toEqual([]);
      expect(batchRow(batchId)).toMatchObject({ reported: 2, total: 3, digest_sent_at: null });
      expect((await callback(C, reportBody(C, "dates-only", { "edf-startdate": 2 }))).status).toBe(
        200,
      );

      // Three stored results, none of them a pending one.
      expect(requestRow(A).identifier_screen_status).toBe("clean");
      expect(requestRow(B).identifier_screen_status).toBe("review");
      expect(requestRow(C).identifier_screen_status).toBe("dates-only");
      // No per-request mail, and no mail to the depositor: one digest.
      expect(perRequestMails(calls)).toHaveLength(0);
      expect(toOwner(calls)).toHaveLength(0);
      const digests = digestsOf(calls);
      expect(digests).toHaveLength(1);
      expect(subjectsOf(calls)).toEqual([
        `[NEMAR] Re-screen batch ${batchId} finished: all 3 reported`,
      ]);
      expect(digests[0].to).toEqual([ADMIN_EMAIL]);
      expect(batchRow(batchId).digest_sent_at).not.toBeNull();

      // What the digest says: the states before and after, the kinds, and what changed.
      const html = digests[0].html;
      expect(html).toContain("Screen states before");
      expect(html).toContain("clean: 1");
      expect(html).toContain("needs review: 1");
      expect(html).toContain("no screen on record: 1");
      expect(html).toContain("clean (acquisition dates only): 1");
      expect(html).toContain("edf-patient-freetext x3");
      expect(html).toContain("edf-startdate x2");
      // B stayed in review and A stayed clean: only C changed.
      expect(html).toContain(
        `<code>${C}</code>: no screen on record to clean (acquisition dates only)`,
      );
      expect(html).not.toContain(`<code>${A}</code>: `);
      expect(html).not.toContain(`<code>${B}</code>: `);
    });
  });

  test("each stored result is what a single screen of the same report stores", async () => {
    seedRequest(A);
    seedRequest(D);
    await withFakeResend(async () => {
      const batchId = await createBatch([A]);
      await screen(A, batchId);
      await screen(D);
      const found = { "edf-patient-name": 4 };
      await callback(A, reportBody(A, "direct-identifiers", found));
      await callback(D, reportBody(D, "direct-identifiers", found));
      const inBatch = requestRow(A);
      const single = requestRow(D);
      expect(inBatch.identifier_screen_status).toBe(single.identifier_screen_status);
      expect(inBatch.status).toBe(single.status);
      expect(inBatch.block_reason).toBe(single.block_reason);
      // The reports differ only by the dataset id they describe.
      expect(JSON.parse(inBatch.identifier_screen_report ?? "{}")).toEqual(
        JSON.parse((single.identifier_screen_report ?? "{}").replaceAll(D, A)),
      );
    });
  });

  test("a request outside the batch still mails as before, beside a batch that does not", async () => {
    seedRequest(A);
    seedRequest(D);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A]);
      await screen(A, batchId);
      await screen(D);
      await callback(D, reportBody(D, "clean"));
      // D's own mail went out at once, with its own subject.
      expect(perRequestMails(calls).map((m) => m.subject)).toEqual([
        `[NEMAR] Publication request: ${D} by batchowner - IDENTIFIER SCREEN: clean`,
      ]);
      expect(requestRow(D).identifier_screen_emailed_at).not.toBeNull();
      await callback(A, reportBody(A, "clean"));
      // A's report completed the batch: the digest, and still only D's per-request mail.
      expect(perRequestMails(calls)).toHaveLength(1);
      expect(digestsOf(calls)).toHaveLength(1);
    });
  });

  test("a block is not mailed to the depositor, and the digest names it", async () => {
    seedRequest(A);
    seedRequest(D);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A]);
      await screen(A, batchId);
      await callback(A, reportBody(A, "direct-identifiers", { "edf-patient-name": 4 }));
      // The request is blocked, as for a single screen, and its depositor is not told by mail.
      expect(requestRow(A)).toMatchObject({
        status: "blocked",
        block_reason: "identifier_screen_findings",
      });
      expect(toOwner(calls)).toHaveLength(0);
      const html = digestsOf(calls)[0].html;
      expect(html).toContain("Blocked by this batch; the depositor was not mailed");
      expect(html).toContain(`<code>${A}</code>`);
      expect(html).toContain("FOUND IDENTIFIERS");

      // The same finding outside a batch mails the depositor, as it always did.
      await screen(D);
      await callback(D, reportBody(D, "direct-identifiers", { "edf-patient-name": 4 }));
      expect(toOwner(calls).map((m) => m.subject)).toEqual([
        `Publication on hold: ${D} - identifying information found`,
      ]);
    });
  });

  test("a blocked request is screened but stays blocked, whatever the result", async () => {
    seedRequest(A, {
      status: "blocked",
      blockReason: "identifier_screen_findings",
      screen: "direct-identifiers",
    });
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A]);
      await screen(A, batchId);
      await callback(A, reportBody(A, "clean"));
      expect(requestRow(A)).toMatchObject({
        identifier_screen_status: "clean",
        status: "blocked",
        block_reason: "identifier_screen_findings",
      });
      // The new result is visible: a clear result on a blocked request is named, still blocked.
      const html = digestsOf(calls)[0].html;
      const still = html.slice(html.indexOf("Still blocked"));
      expect(still).toContain(`<code>${A}</code>: FOUND IDENTIFIERS to clean`);
      expect(html.slice(0, html.indexOf("Still blocked"))).not.toContain(`<code>${A}</code>`);
    });
  });
});

describe("the digest is sent exactly once", () => {
  test("two callbacks racing for the last two reports send one", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      const racing = { ...env(), DB: yieldingD1(realD1(db)) } as Bindings;
      const batchId = await createBatch([A, B], racing);
      await screen(A, batchId, racing);
      await screen(B, batchId, racing);
      const answers = await Promise.all([
        callback(A, reportBody(A, "clean"), racing),
        callback(B, reportBody(B, "clean"), racing),
      ]);
      expect(answers.map((r) => r.status)).toEqual([200, 200]);
      expect(digestsOf(calls)).toHaveLength(1);
      expect(batchRow(batchId).reported).toBe(2);
    });
  });

  test("two senders claiming a due digest: one sends, the other finds it held", async () => {
    seedRequest(A);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A]);
      db.run("UPDATE screen_batches SET reported = total WHERE id = ?", [batchId]);
      const racing = { ...env(), DB: yieldingD1(realD1(db)) } as Bindings;
      const outcomes = await Promise.all([
        sendDigestIfDue(racing, batchId),
        sendDigestIfDue(racing, batchId),
        sendDigestIfDue(racing, batchId),
      ]);
      expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "not-due")).toHaveLength(2);
      expect(digestsOf(calls)).toHaveLength(1);
      // And once it is sent, nothing sends it again.
      expect(await sendDigestIfDue(env(), batchId)).toBe("not-due");
      expect(digestsOf(calls)).toHaveLength(1);
    });
  });

  test("a digest that reached nobody is released, and the watchdog sends it", async () => {
    seedRequest(A);
    const batchId = await withFakeResend(async () => {
      const id = await createBatch([A]);
      await screen(A, id);
      // No administrator can be reached: the digest is claimed, found no recipient, and released.
      db.run("UPDATE users SET status = 'revoked' WHERE role = 'admin'");
      await callback(A, reportBody(A, "clean"));
      return id;
    });
    expect(batchRow(batchId)).toMatchObject({ digest_sent_at: null, digest_claimed_at: null });
    db.run("UPDATE users SET status = 'approved' WHERE role = 'admin'");
    await withFakeResend(async (calls) => {
      const swept = await sweepIdentifierScreens(env());
      expect(swept.digests).toBe(1);
      expect(digestsOf(calls)).toHaveLength(1);
      expect(batchRow(batchId).digest_sent_at).not.toBeNull();
    });
  });
});

describe("a screen that never reports", () => {
  test("the watchdog sends the digest two hours after the last dispatch, naming it, with no per-request mail", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B]);
      await screen(A, batchId);
      await screen(B, batchId);
      await callback(A, reportBody(A, "clean"));
      expect(digestsOf(calls)).toHaveLength(0);

      // Inside the two hours the digest is not due, even once B's screen is overdue.
      db.run(
        `UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-${
          SCREEN_REPORT_DEADLINE_MINUTES + 1
        } minutes') WHERE dataset_id = ?`,
        [B],
      );
      let swept = await sweepIdentifierScreens(env());
      expect(swept).toMatchObject({ timedOut: 1, emailed: 0, digests: 0 });
      expect(requestRow(B).identifier_screen_status).toBe("unreported");
      expect(subjectsOf(calls)).toEqual([]);

      db.run(
        `UPDATE screen_batches SET last_dispatch_at = datetime('now', '-${
          DIGEST_AFTER_LAST_DISPATCH_MINUTES + 1
        } minutes') WHERE id = ?`,
        [batchId],
      );
      swept = await sweepIdentifierScreens(env());
      expect(swept.digests).toBe(1);
      // One mail, the digest: not the per-request mail of the timed-out screen.
      expect(subjectsOf(calls)).toEqual([
        `[NEMAR] Re-screen batch ${batchId} finished: 1 of 2 reported, 1 did not report`,
      ]);
      const html = digestsOf(calls)[0].html;
      expect(html).toContain("Did not report by the deadline");
      expect(html).toContain(`<code>${B}</code>`);
      expect(html).not.toMatch(new RegExp(`Did not report[\\s\\S]*<code>${A}</code>`));
      // A later tick sends nothing more.
      swept = await sweepIdentifierScreens(env());
      expect(swept.digests).toBe(0);
      expect(subjectsOf(calls)).toHaveLength(1);
    });
  });

  test("a report that arrives after the digest is mailed as an ordinary one", async () => {
    seedRequest(A);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A]);
      await screen(A, batchId);
      db.run(
        `UPDATE screen_batches SET last_dispatch_at = datetime('now', '-${
          DIGEST_AFTER_LAST_DISPATCH_MINUTES + 1
        } minutes') WHERE id = ?`,
        [batchId],
      );
      await sendDigestIfDue(env(), batchId);
      expect(digestsOf(calls)).toHaveLength(1);
      expect(digestsOf(calls)[0].html).toContain(`<code>${A}</code>`);

      await callback(A, reportBody(A, "clean"));
      // The digest said it did not report, so its result is mailed on its own now.
      expect(perRequestMails(calls)).toHaveLength(1);
      expect(digestsOf(calls)).toHaveLength(1);
    });
  });

  test("stopping the batch closes it on the screens already started, and the rest are named", async () => {
    seedRequest(A);
    seedRequest(B);
    seedRequest(C);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B, C]);
      await screen(A, batchId);
      const closed = await asAdmin(`/admin/publish/screen-batches/${batchId}/close`);
      expect(closed.status).toBe(200);
      // Closing records the stop and leaves the total alone.
      expect(batchRow(batchId)).toMatchObject({ total: 3, digest_sent_at: null });
      expect(batchRow(batchId).closed_at).not.toBeNull();
      expect(digestsOf(calls)).toHaveLength(0);
      await callback(A, reportBody(A, "clean"));
      const digests = digestsOf(calls);
      expect(digests).toHaveLength(1);
      expect(digests[0].html).toContain(`<code>${B}</code>: the batch never dispatched it`);
      expect(digests[0].html).toContain(`<code>${C}</code>: the batch never dispatched it`);
      // Closing a batch whose digest has gone out, or one that does not exist, is a 404.
      const again = await asAdmin(`/admin/publish/screen-batches/${batchId}/close`);
      expect(again.status).toBe(404);
      const nobody = await asAdmin("/admin/publish/screen-batches/9999/close");
      expect(nobody.status).toBe(404);
    });
  });
});

describe("every way out of a dispatch settles the request, and is named", () => {
  test("a screen that cannot start stores its error, mails nobody, and the digest says it did not run", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B]);
      dispatchStatus = 500;
      const res = await screen(A, batchId);
      expect(res.status).toBe(202);
      expect(requestRow(A)).toMatchObject({
        identifier_screen_status: "error",
        identifier_screen_batch_id: batchId,
      });
      // No per-request mail for a failed start, either, not even from the watchdog's retry of
      // a result whose mail never went out.
      expect(subjectsOf(calls)).toEqual([]);
      db.run(
        "UPDATE publication_requests SET identifier_screen_at = datetime('now', '-10 minutes') WHERE dataset_id = ?",
        [A],
      );
      expect((await sweepIdentifierScreens(env())).emailed).toBe(0);
      expect(subjectsOf(calls)).toEqual([]);
      expect(batchRow(batchId).reported).toBe(1);
      dispatchStatus = 204;
      await screen(B, batchId);
      await callback(B, reportBody(B, "clean"));
      expect(perRequestMails(calls)).toHaveLength(0);
      const html = digestsOf(calls)[0].html;
      // Not a report: its own section, with the reason the screen could not start.
      expect(subjectsOf(calls)).toEqual([
        `[NEMAR] Re-screen batch ${batchId} finished: 1 of 2 reported, 1 not started`,
      ]);
      expect(html).toContain("not started: 1");
      expect(html).toContain(`<code>${A}</code>: GitHub refused to start the screen workflow`);
    });
  });

  test("a dispatch the Worker refuses settles the request; a repeat call is not counted twice", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B]);
      // A's request ends (denied) after the batch selected it: refused, and settled.
      db.run("UPDATE publication_requests SET status = 'denied' WHERE dataset_id = ?", [A]);
      const refused = await screen(A, batchId);
      expect(refused.status).toBe(404);
      expect(batchRow(batchId).reported).toBe(1);

      await screen(B, batchId);
      // The CLI asks again for B: its screen is pending (a recent run), so the Worker refuses and
      // does not count B a second time.
      const again = await screen(B, batchId);
      expect(again.status).toBe(409);
      expect(batchRow(batchId).reported).toBe(1);
      expect(digestsOf(calls)).toHaveLength(0);
      await callback(B, reportBody(B, "clean"));
      expect(digestsOf(calls)).toHaveLength(1);
      expect(digestsOf(calls)[0].html).toContain(
        `<code>${A}</code>: it has no active publication request`,
      );
    });
  });

  test("the digest keeps reported, not started or refused, and did not report apart, each with its own count and list", async () => {
    seedRequest(A);
    seedRequest(B);
    seedRequest(C);
    seedRequest(D);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B, C, D]);
      // A reports.
      await screen(A, batchId);
      await callback(A, reportBody(A, "clean"));
      // B is refused: its request ended after the batch selected it.
      db.run("UPDATE publication_requests SET status = 'denied' WHERE dataset_id = ?", [B]);
      await screen(B, batchId);
      // C cannot start: GitHub refuses the dispatch.
      dispatchStatus = 500;
      await screen(C, batchId);
      dispatchStatus = 204;
      // D is dispatched and never reports.
      await screen(D, batchId);
      expect(digestsOf(calls)).toHaveLength(0);
      db.run(
        `UPDATE screen_batches SET last_dispatch_at = datetime('now', '-${
          DIGEST_AFTER_LAST_DISPATCH_MINUTES + 1
        } minutes') WHERE id = ?`,
        [batchId],
      );
      await sendDigestIfDue(env(), batchId);

      const digests = digestsOf(calls);
      expect(digests).toHaveLength(1);
      expect(digests[0].subject).toBe(
        `[NEMAR] Re-screen batch ${batchId} finished: 1 of 4 reported, 2 not started, 1 did not report`,
      );
      const html = digests[0].html;
      const section = (heading: string, next: string): string =>
        html.slice(html.indexOf(heading), html.indexOf(next));
      const started = "Could not start, or refused (not screened by this batch)";
      const notReported = "Did not report by the deadline";
      const notStarted = section(started, notReported);
      expect(notStarted).toContain(`<code>${B}</code>: it has no active publication request`);
      expect(notStarted).toContain(
        `<code>${C}</code>: GitHub refused to start the screen workflow`,
      );
      expect(notStarted).not.toContain(`<code>${A}</code>`);
      expect(notStarted).not.toContain(`<code>${D}</code>`);
      const late = html.slice(html.indexOf(notReported));
      expect(late).toContain(`<code>${D}</code>`);
      expect(late).not.toContain(`<code>${A}</code>`);
      expect(late).not.toContain(`<code>${B}</code>`);
      expect(late).not.toContain(`<code>${C}</code>`);
      // The states after count them apart as well.
      expect(html).toContain("clean: 1");
      expect(html).toContain("not started: 2");
      expect(html).toContain("did not report: 1");
    });
  });

  test("a request replaced since the batch selected it is not screened under the batch", async () => {
    const first = seedRequest(A);
    await withFakeResend(async () => {
      const batchId = await createBatch([A]);
      db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [first]);
      db.run(
        "INSERT INTO publication_requests (dataset_id, requested_by, status) VALUES (?, ?, 'requested')",
        [A, ownerId],
      );
      const res = await screen(A, batchId);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("batch_request_changed");
      expect(dispatches).toHaveLength(0);
    });
  });
});

describe("the screen route's batch id", () => {
  test("a bad id, an unknown batch, a dataset outside it and a finished batch are refused", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async () => {
      const batchId = await createBatch([A]);
      for (const bad of [0, -1, 1.5, "1", null]) {
        const res = await asAdmin(`/admin/publish/${A}/identifier-screen`, { batch_id: bad });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("body_invalid");
      }
      // A mistyped key, a key that is not ours and a body that is not JSON are refused, not read
      // as a single screen.
      for (const text of ['{"batchid":1}', '{"batch_id":1,"x":1}', "not json", "[]", "null"]) {
        const res = await app.request(
          `/admin/publish/${A}/identifier-screen`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
            body: text,
          },
          env(),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("body_invalid");
      }
      expect(dispatches).toHaveLength(0);
      expect((await screen(A, 9999)).status).toBe(404);
      const outside = await screen(B, batchId);
      expect(outside.status).toBe(400);
      expect(((await outside.json()) as { error: string }).error).toBe("not_in_batch");
      expect(dispatches).toHaveLength(0);

      db.run("UPDATE screen_batches SET digest_sent_at = datetime('now') WHERE id = ?", [batchId]);
      const closed = await screen(A, batchId);
      expect(closed.status).toBe(409);
      expect(((await closed.json()) as { error: string }).error).toBe("screen_batch_closed");
      expect(dispatches).toHaveLength(0);
    });
  });

  test("every reset of a request's screen (a re-request, a re-pull) takes it out of its batch", () => {
    seedRequest(A, { screen: "clean" });
    db.run("UPDATE publication_requests SET identifier_screen_batch_id = 7 WHERE dataset_id = ?", [
      A,
    ]);
    db.run(`UPDATE publication_requests SET ${RESET_SCREEN_COLUMNS_SQL} WHERE dataset_id = ?`, [A]);
    expect(requestRow(A)).toMatchObject({
      identifier_screen_batch_id: null,
      identifier_screen_status: null,
    });
  });

  test("a later single screen resets the batch id, so it mails as one always did", async () => {
    seedRequest(A);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A]);
      await screen(A, batchId);
      await callback(A, reportBody(A, "clean"));
      expect(requestRow(A).identifier_screen_batch_id).toBe(batchId);
      expect(digestsOf(calls)).toHaveLength(1);

      await screen(A);
      expect(requestRow(A).identifier_screen_batch_id).toBeNull();
      await callback(A, reportBody(A, "clean"));
      expect(perRequestMails(calls)).toHaveLength(1);
    });
  });
});

describe("a request settles once, and the digest waits for what was stored", () => {
  test("a store, then the close, then the settle: the digest waits for the settle", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B]);
      await screen(A, batchId);
      const requestId = requestRow(A).id;
      // The report is stored (as the callback's first statement does) ...
      const stored = await storeScreenResult(env(), {
        requestId,
        datasetId: A,
        nonce: requestRow(A).identifier_screen_nonce as string,
        body: reportBody(A, "clean"),
      });
      expect(stored).toMatchObject({ stored: true, batchId });
      // ... and the administrator stops the batch before it is counted: the result is not lost.
      expect((await asAdmin(`/admin/publish/screen-batches/${batchId}/close`)).status).toBe(200);
      expect(digestsOf(calls)).toHaveLength(0);
      expect(batchRow(batchId)).toMatchObject({ reported: 0, total: 2 });
      // The settle is the last statement, and sends the digest.
      await settleBatchEntry(env(), batchId, requestId);
      expect(digestsOf(calls)).toHaveLength(1);
      expect(batchRow(batchId).reported).toBe(1);
    });
  });

  test("counting the same request twice counts it once, and never completes the batch early", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B]);
      await screen(A, batchId);
      await callback(A, reportBody(A, "clean"));
      const requestId = requestRow(A).id;
      await settleBatchEntry(env(), batchId, requestId);
      await settleBatchEntry(env(), batchId, requestId);
      expect(batchRow(batchId).reported).toBe(1);
      // B was never dispatched: a double count of A must not look like "everything settled".
      expect(digestsOf(calls)).toHaveLength(0);
      // Nor does another batch's settle count this one's request.
      const other = await createBatch([B]);
      await settleBatchEntry(env(), other, requestId);
      expect(batchRow(batchId).reported).toBe(1);
    });
  });

  test("a batch closed with nothing dispatched sends its digest at once, naming every request", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B]);
      expect(digestsOf(calls)).toHaveLength(0);
      await asAdmin(`/admin/publish/screen-batches/${batchId}/close`);
      const digests = digestsOf(calls);
      expect(digests).toHaveLength(1);
      expect(digests[0].subject).toBe(
        `[NEMAR] Re-screen batch ${batchId} finished: 0 of 2 reported, 2 not started`,
      );
      expect(digests[0].html).toContain(`<code>${A}</code>: the batch never dispatched it`);
      expect(digests[0].html).toContain(`<code>${B}</code>: the batch never dispatched it`);
    });
  });

  test("a request the batch already screened is refused a second dispatch, and nothing is settled", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B]);
      await screen(A, batchId);
      await callback(A, reportBody(A, "clean"));
      expect(batchRow(batchId).reported).toBe(1);
      const again = await screen(A, batchId);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe("already_screened");
      expect(dispatches).toHaveLength(1);
      expect(batchRow(batchId).reported).toBe(1);
      expect(requestRow(A).identifier_screen_status).toBe("clean");
      expect(digestsOf(calls)).toHaveLength(0);
    });
  });

  test("an overdue screen the batch dispatched can be dispatched again by it, and is counted once", async () => {
    seedRequest(A);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A]);
      await screen(A, batchId);
      db.run(
        `UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-${
          SCREEN_REPORT_DEADLINE_MINUTES + 1
        } minutes') WHERE dataset_id = ?`,
        [A],
      );
      // Not settled, so not "already screened": the second dispatch goes out.
      expect((await screen(A, batchId)).status).toBe(202);
      expect(dispatches).toHaveLength(2);
      expect(batchRow(batchId).reported).toBe(0);
      await callback(A, reportBody(A, "clean"));
      expect(batchRow(batchId).reported).toBe(1);
      expect(digestsOf(calls)).toHaveLength(1);
    });
  });

  test("a single screen of a request an open batch dispatched settles its entry as screened again", async () => {
    seedRequest(A);
    seedRequest(B);
    seedRequest(C);
    await withFakeResend(async (calls) => {
      const batchId = await createBatch([A, B, C]);
      await screen(A, batchId);
      await callback(A, reportBody(A, "clean"));
      await screen(B, batchId);
      // A had reported and B is overdue: a plain single screen may replace each.
      db.run(
        `UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-${
          SCREEN_REPORT_DEADLINE_MINUTES + 1
        } minutes') WHERE dataset_id = ?`,
        [B],
      );
      expect((await screen(A)).status).toBe(202);
      expect((await screen(B)).status).toBe(202);
      expect(requestRow(A).identifier_screen_batch_id).toBeNull();
      // A was counted when it reported and is not counted again; B is counted now.
      expect(batchRow(batchId).reported).toBe(2);
      expect(digestsOf(calls)).toHaveLength(0);

      await screen(C, batchId);
      await callback(C, reportBody(C, "clean"));
      const digests = digestsOf(calls);
      expect(digests).toHaveLength(1);
      expect(digests[0].subject).toBe(
        `[NEMAR] Re-screen batch ${batchId} finished: 1 of 3 reported, 2 screened again elsewhere`,
      );
      const html = digests[0].html;
      const section = html.slice(html.indexOf("Screened again outside the batch"));
      expect(section).toContain(`<code>${A}</code>`);
      expect(section).toContain(`<code>${B}</code>`);
      expect(section).not.toContain(`<code>${C}</code>`);
      expect(html).toContain("screened again outside the batch: 2");
      // The single screens mail as a single screen does, when they report.
      await callback(A, reportBody(A, "clean"));
      expect(perRequestMails(calls)).toHaveLength(1);
    });
  });

  test("a recent screen outside the batch refuses the dispatch, and the digest says why with the real deadline", async () => {
    seedRequest(A);
    await withFakeResend(async (calls) => {
      expect((await screen(A)).status).toBe(202);
      const batchId = await createBatch([A]);
      const refused = await screen(A, batchId);
      expect(refused.status).toBe(409);
      const digests = digestsOf(calls);
      expect(digests).toHaveLength(1);
      expect(digests[0].html).toContain(
        `<code>${A}</code>: it could not be started now (a recent screen may still be running; one dispatched less than ${SCREEN_REPORT_DEADLINE_MINUTES} minutes before had not reported)`,
      );
      expect(digests[0].html).toContain("while this digest is being sent");
    });
  });

  test("a settle landing between the route's read and its claim makes the claim lose, atomically", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async () => {
      const batchId = await createBatch([A, B]);
      await screen(A, batchId);
      // The screen is overdue, so the claim's own guard would let a second dispatch through.
      db.run(
        `UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-${
          SCREEN_REPORT_DEADLINE_MINUTES + 1
        } minutes') WHERE dataset_id = ?`,
        [A],
      );
      let landed = false;
      const racing = {
        ...env(),
        DB: interceptingD1(realD1(db), (sql) => {
          // Just before the claim: the first dispatch's report is stored and counted.
          if (
            !landed &&
            sql.includes("identifier_screen_status = 'pending', identifier_screen_nonce = ?")
          ) {
            landed = true;
            db.run(
              `UPDATE publication_requests
                  SET identifier_screen_status = 'clean', identifier_screen_nonce = NULL,
                      identifier_screen_batch_settled_at = datetime('now')
                WHERE dataset_id = ?`,
              [A],
            );
            db.run("UPDATE screen_batches SET reported = reported + 1 WHERE id = ?", [batchId]);
          }
        }),
      } as Bindings;
      const res = await screen(A, batchId, racing);
      expect(landed).toBe(true);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("already_screened");
      // Nothing was dispatched over the counted result, and nothing was counted again.
      expect(dispatches).toHaveLength(1);
      expect(requestRow(A).identifier_screen_status).toBe("clean");
      expect(batchRow(batchId).reported).toBe(1);
    });
  });

  test("a refused request the batch later dispatches and settles is counted once, as reported", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      // A has a screen running that is not the batch's: the batch's dispatch is refused.
      expect((await screen(A)).status).toBe(202);
      const batchId = await createBatch([A, B]);
      expect((await screen(A, batchId)).status).toBe(409);
      expect(batchRow(batchId).reported).toBe(1);
      expect(JSON.parse(batchRow(batchId).refused ?? "[]")).toEqual([[A, "screen-running"]]);
      // The other screen goes overdue, and the batch dispatches A after all.
      db.run(
        `UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-${
          SCREEN_REPORT_DEADLINE_MINUTES + 1
        } minutes') WHERE dataset_id = ?`,
        [A],
      );
      expect((await screen(A, batchId)).status).toBe(202);
      await callback(A, reportBody(A, "clean"));
      // Counted when it was refused; its settle does not count it again.
      expect(batchRow(batchId).reported).toBe(1);
      expect(digestsOf(calls)).toHaveLength(0);
      await screen(B, batchId);
      await callback(B, reportBody(B, "clean"));
      const digests = digestsOf(calls);
      expect(digests).toHaveLength(1);
      // The later outcome replaces the refusal: A reported, and is not listed as not started.
      expect(digests[0].subject).toBe(
        `[NEMAR] Re-screen batch ${batchId} finished: all 2 reported`,
      );
      const html = digests[0].html;
      const notStarted = html.slice(
        html.indexOf("Could not start, or refused"),
        html.indexOf("Screened again outside the batch"),
      );
      expect(notStarted).not.toContain(`<code>${A}</code>`);
    });
  });

  test("a refused request the batch dispatched and a single screen then replaced is named as screened again, not as refused", async () => {
    seedRequest(A);
    seedRequest(B);
    await withFakeResend(async (calls) => {
      expect((await screen(A)).status).toBe(202);
      const batchId = await createBatch([A, B]);
      expect((await screen(A, batchId)).status).toBe(409);
      db.run(
        `UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-${
          SCREEN_REPORT_DEADLINE_MINUTES + 1
        } minutes') WHERE dataset_id = ?`,
        [A],
      );
      expect((await screen(A, batchId)).status).toBe(202);
      // The batch's screen is overdue again, and a single screen replaces it.
      db.run(
        `UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-${
          SCREEN_REPORT_DEADLINE_MINUTES + 1
        } minutes') WHERE dataset_id = ?`,
        [A],
      );
      expect((await screen(A)).status).toBe(202);
      expect(batchRow(batchId).reported).toBe(1);
      expect(JSON.parse(batchRow(batchId).refused ?? "[]")).toEqual([[A, "rescreened"]]);
      await screen(B, batchId);
      await callback(B, reportBody(B, "clean"));
      const html = digestsOf(calls)[0].html;
      const notStarted = html.slice(
        html.indexOf("Could not start, or refused"),
        html.indexOf("Screened again outside the batch"),
      );
      expect(notStarted).not.toContain(`<code>${A}</code>`);
      expect(html.slice(html.indexOf("Screened again outside the batch"))).toContain(
        `<code>${A}</code>`,
      );
    });
  });
});
