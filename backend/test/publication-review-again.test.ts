/**
 * An administrator's re-review of a reported publication review (ADR 0102, amendment of
 * 2026-11-27; migration 0161).
 *
 * The owner compares review models and efforts on the same requests at the same commits, so an
 * administrator's start may pass `again`: the review that reported is kept as history, marked
 * superseded, and a new first run of the same commit and release kind is the review in force.
 *
 * Real engines only: every migration applied to bun:sqlite behind `realD1`, the production start
 * path, claim and result routes, the production gate and detail view. GitHub is the harness's
 * `Bun.serve()` stand-in, so each dispatch is read off the wire.
 *
 * Mutation checks (each turns a named test red): drop `superseded_at IS NULL` from
 * `readReviewByKey` (the review in force is the superseded one); drop `state = 'reported'` from the
 * supersede guard (a running or declined row is replaced); drop `superseded_at IS NULL` from the
 * override statement; leave the partial unique index as migration 0153 made it.
 */

import { describe, expect, test } from "bun:test";
import { PLATFORM_DAILY_CAP } from "../../shared/publication-review";
import { startConfirmingReview, startPublicationReview } from "../src/services/publication-review";
import {
  RECORD_OVERRIDE_SQL,
  evaluateApprovalReviewGate,
} from "../src/services/publication-review-gate";
import {
  listReviewsOfRequest,
  readReviewByKey,
  readReviewsByKeys,
} from "../src/services/publication-review-rows";
import { publicationReviewDetail } from "../src/services/publication-review-view";
import { realD1, yieldingD1 } from "./helpers/d1";
import { markScreen } from "./helpers/identifier-screen";
import {
  SCREENED_HEAD,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
} from "./helpers/publication-review";
import {
  PROD_DATASET,
  createHarness,
  hookedD1,
  reportFor,
} from "./helpers/publication-review-harness";

const h = createHarness();

const ADMIN_KEY = "again-admin-key-0123456789abcdef0123456789abcdef";
const OWNER_KEY = "again-owner-key-0123456789abcdef0123456789abcdef";

/** A request with a clear screen at SCREENED_HEAD whose review reported `report`. */
async function reportedRequest(report: Record<string, unknown> = failingReport()) {
  const admin = await seedUser(h.db, "againadmin", "admin", ADMIN_KEY);
  const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
  const oldId = seedPublicationReview(h.db, {
    requestId,
    datasetId: PROD_DATASET,
    state: "reported",
    report,
    claimed: true,
  });
  return { admin, requestId, oldId };
}

function again(
  requestId: number,
  admin: number,
  o: { again?: boolean; env?: ReturnType<typeof h.env> } = {},
) {
  return startPublicationReview(
    o.env ?? h.env(),
    { requestId, datasetId: PROD_DATASET, adminUserId: admin },
    { again: o.again ?? true },
  );
}

const columnsOf = (id: number) =>
  h.db
    .query<{ superseded_at: string | null; superseded_by: number | null; state: string }, [number]>(
      "SELECT superseded_at, superseded_by, state FROM publication_reviews WHERE id = ?",
    )
    .get(id) as { superseded_at: string | null; superseded_by: number | null; state: string };

describe("migration 0161: the schema", () => {
  test("the columns exist, and a name is only ever given with a time", () => {
    const names = (
      h.db.query("PRAGMA table_info(publication_reviews)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(names).toContain("superseded_at");
    expect(names).toContain("superseded_by");
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const id = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
    });
    expect(() =>
      h.db.run("UPDATE publication_reviews SET superseded_by = 99 WHERE id = ?", [id]),
    ).toThrow();
    h.db.run(
      "UPDATE publication_reviews SET superseded_at = datetime('now'), superseded_by = 99 WHERE id = ?",
      [id],
    );
    expect(columnsOf(id).superseded_by).toBe(99);
  });

  test("the key index allows one unsuperseded first run, and any number of superseded ones", () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const first = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
    });
    // A second first run of the same commit and kind is still refused while the first stands.
    expect(() =>
      seedPublicationReview(h.db, { requestId, datasetId: PROD_DATASET, state: "reported" }),
    ).toThrow();
    h.db.run("UPDATE publication_reviews SET superseded_at = datetime('now') WHERE id = ?", [
      first,
    ]);
    const second = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
    });
    expect(second).toBeGreaterThan(first);
    h.db.run("UPDATE publication_reviews SET superseded_at = datetime('now') WHERE id = ?", [
      second,
    ]);
    expect(
      seedPublicationReview(h.db, { requestId, datasetId: PROD_DATASET, state: "reported" }),
    ).toBeGreaterThan(second);
  });
});

describe("again supersedes a reported review", () => {
  test("a new first run is dispatched, the old one is history and names it", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    const out = await again(requestId, admin);

    const rows = h.reviews();
    expect(rows).toHaveLength(2);
    const fresh = rows[1];
    expect(out).toEqual({
      started: true,
      reason: "dispatched",
      reviewId: fresh.id as number,
      superseded: oldId,
    });
    // Same request, commit and kind, started by the administrator, with a live nonce of its own.
    expect(fresh).toMatchObject({
      request_id: requestId,
      head_sha: SCREENED_HEAD,
      anonymous: 0,
      state: "dispatched",
      started_by: admin,
      attempts: 1,
      confirm_of: null,
      superseded_at: null,
      superseded_by: null,
    });
    expect(fresh.nonce).toEqual(expect.any(String));
    const old = columnsOf(oldId);
    expect(old.state).toBe("reported");
    expect(old.superseded_at).toEqual(expect.any(String));
    expect(old.superseded_by).toBe(fresh.id as number);
    // The old row keeps what it concluded and loses nothing but its place.
    expect(h.review(oldId)).toMatchObject({ verdict: "fail", nonce: null });

    const dispatches = h.dispatches();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].client_payload).toMatchObject({
      review_id: fresh.id,
      request_id: requestId,
      head_sha: SCREENED_HEAD,
    });
  });

  test("the review in force is the new row, in every read of it", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    await again(requestId, admin);
    const fresh = h.reviews()[1].id as number;

    expect((await readReviewByKey(h.env().DB, requestId, SCREENED_HEAD, false))?.id).toBe(fresh);
    const keyed = await readReviewsByKeys(h.env().DB, [
      { requestId, headSha: SCREENED_HEAD, anonymous: false },
    ]);
    expect([...keyed.values()].map((r) => r.id)).toEqual([fresh]);

    // `show`: the review is the new one, and the history lists both, the old one marked.
    const detail = await publicationReviewDetail(h.env(), PROD_DATASET);
    expect(detail?.review?.id).toBe(fresh);
    expect(detail?.history.map((e) => e.id)).toEqual([fresh, oldId]);
    expect(detail?.history[0]).toMatchObject({ superseded_at: null, superseded_by: null });
    expect(detail?.history[1]).toMatchObject({ superseded_by: fresh });
    expect(detail?.history[1].superseded_at).toEqual(expect.any(String));
    const listed = await listReviewsOfRequest(h.env().DB, requestId, 10);
    expect(listed.map((r) => r.id)).toEqual([fresh, oldId]);
  });

  test("the approval gate reads the new review, not the one it replaced", async () => {
    const { admin, requestId } = await reportedRequest(failingReport());
    const args = { requestId, datasetId: PROD_DATASET, approverId: admin };
    // The review that reported a fail holds the approval.
    expect((await evaluateApprovalReviewGate(h.env(), args)).ok).toBe(false);

    await again(requestId, admin);
    const fresh = h.reviews()[1].id as number;
    // The new review is running: still no pass, and it is the running one the gate sees.
    const running = await evaluateApprovalReviewGate(h.env(), args);
    expect(running.ok).toBe(false);

    expect((await h.claim(fresh)).status).toBe(200);
    expect(
      (await h.result(fresh, { outcome: "reported", report: reportFor(SCREENED_HEAD, false) }))
        .status,
    ).toBe(200);
    const passed = await evaluateApprovalReviewGate(h.env(), args);
    expect(passed).toMatchObject({ ok: true, state: "enforced", outcome: "pass" });
  });

  test("the platform's allowance counts the superseded call and the new one", async () => {
    const { admin, requestId } = await reportedRequest();
    const calls = () =>
      h.db
        .query<{ n: number }, []>("SELECT COALESCE(SUM(attempts), 0) AS n FROM publication_reviews")
        .get()?.n;
    await again(requestId, admin);
    expect(calls()).toBe(2);
    const platform = h.db
      .query<{ n: number }, [number]>(
        `SELECT COUNT(*) AS n FROM publication_reviews WHERE id <= ?
          AND created_at >= datetime('now', '-1 day')`,
      )
      .get(Number.MAX_SAFE_INTEGER);
    expect(platform?.n).toBe(2);
  });

  test("a spent allowance refuses before anything is replaced", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    // PLATFORM_DAILY_CAP - 1 other calls plus the reported one: the new call would be one too many.
    for (let i = 0; i < PLATFORM_DAILY_CAP - 1; i++) {
      const datasetId = `nm${String(2000 + i).padStart(6, "0")}`;
      const r = seedScreenedRequest(h.db, { datasetId });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId,
        state: "reported",
        claimed: true,
      });
    }
    const before = h.reviews().length;
    const out = await again(requestId, admin);
    expect(out).toMatchObject({ started: false, reason: "platform_limit", reviewId: oldId });
    expect(h.reviews()).toHaveLength(before);
    expect(columnsOf(oldId).superseded_at).toBeNull();
    expect(h.dispatches()).toHaveLength(0);
  });

  test("the new row is held by the platform's allowance and not by the depositor's", async () => {
    const { admin, requestId } = await reportedRequest();
    // The depositor has spent their own allowance many times over; an administrator is not held by it.
    const depositor = (
      h.db
        .query<{ requested_by: number }, [number]>(
          "SELECT requested_by FROM publication_requests WHERE id = ?",
        )
        .get(requestId) as { requested_by: number }
    ).requested_by;
    for (let i = 0; i < 12; i++) {
      const datasetId = `nm${String(3000 + i).padStart(6, "0")}`;
      const r = seedScreenedRequest(h.db, { datasetId, requestedBy: depositor });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId,
        state: "reported",
        claimed: true,
      });
    }
    const out = await again(requestId, admin);
    expect(out).toMatchObject({ started: true, reason: "dispatched" });
  });
});

describe("again is exact about what it replaces", () => {
  test("two re-reviews at once leave one review in force: one supersedes, the other finds it running", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    const env = h.env({ DB: yieldingD1(realD1(h.db)) });
    const [a, b] = await Promise.all([
      again(requestId, admin, { env }),
      again(requestId, admin, { env }),
    ]);
    const outs = [a, b];
    expect(outs.filter((o) => o.started)).toHaveLength(1);
    expect(outs.filter((o) => !o.started)).toEqual([
      expect.objectContaining({ started: false, reason: "running" }),
    ]);
    const rows = h.reviews();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.superseded_at === null)).toHaveLength(1);
    expect(columnsOf(oldId).superseded_by).toBe(rows[1].id as number);
    expect(h.dispatches()).toHaveLength(1);
  });

  test("a re-review of a re-review stacks: the history keeps every earlier one", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    await again(requestId, admin);
    const second = h.reviews()[1].id as number;
    await h.claim(second);
    await h.result(second, { outcome: "reported", report: reportFor(SCREENED_HEAD, false) });

    const out = await again(requestId, admin);
    expect(out).toMatchObject({ started: true, superseded: second });
    const third = h.reviews()[2].id as number;
    expect(columnsOf(oldId).superseded_by).toBe(second);
    expect(columnsOf(second).superseded_by).toBe(third);
    expect(columnsOf(third).superseded_at).toBeNull();
    expect((await readReviewByKey(h.env().DB, requestId, SCREENED_HEAD, false))?.id).toBe(third);
  });

  test("a review that is running answers running and nothing changes", async () => {
    const { admin, requestId } = await reportedRequest();
    await again(requestId, admin);
    const before = JSON.stringify(h.reviews());
    const out = await again(requestId, admin);
    expect(out).toMatchObject({ started: false, reason: "running" });
    expect(JSON.stringify(h.reviews())).toBe(before);
    expect(h.dispatches()).toHaveLength(1);
  });

  test("a row that has not reported restarts as it always did, and nothing is superseded", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const admin = await seedUser(h.db, "againadmin", "admin", ADMIN_KEY);
    const id = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "errored",
      detail: "dispatch_failed",
    });
    const out = await again(requestId, admin);
    expect(out).toEqual({ started: true, reason: "redispatched", reviewId: id });
    expect(h.reviews()).toHaveLength(1);
    expect(columnsOf(id).superseded_at).toBeNull();
  });

  test("with no review on record it is an ordinary start", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const admin = await seedUser(h.db, "againadmin", "admin", ADMIN_KEY);
    const out = await again(requestId, admin);
    expect(out).toMatchObject({ started: true, reason: "dispatched" });
    expect(out).not.toHaveProperty("superseded");
    expect(h.reviews()).toHaveLength(1);
  });

  test("without again a reported review still answers has_result", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    const out = await again(requestId, admin, { again: false });
    expect(out).toEqual({ started: false, reason: "has_result", reviewId: oldId });
    expect(h.reviews()).toHaveLength(1);
    expect(columnsOf(oldId).superseded_at).toBeNull();
  });

  test("a screen result's start cannot pass it, and writes nothing", async () => {
    const { requestId } = await reportedRequest();
    await expect(
      startPublicationReview(
        h.env(),
        { requestId, datasetId: PROD_DATASET },
        { again: true, mail: false },
      ),
    ).rejects.toThrow("administrator");
    expect(h.reviews()).toHaveLength(1);
    expect(h.dispatches()).toHaveLength(0);
  });

  test("a review that stops having reported between the read and the write is not replaced", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    // Another writer takes the row back to a running attempt just before the batch begins.
    let moved = false;
    const db = hookedD1(realD1(h.db), {
      batch: (sqls) => {
        if (moved || !sqls.some((q) => q.includes("SET superseded_at"))) return;
        moved = true;
        h.db.run(
          `UPDATE publication_reviews
              SET state = 'dispatched', verdict = NULL, report = NULL, decided_at = NULL,
                  nonce = 'live', created_at = datetime('now')
            WHERE id = ?`,
          [oldId],
        );
      },
    });
    const out = await again(requestId, admin, { env: h.env({ DB: db }) });
    expect(moved).toBe(true);
    expect(out).toMatchObject({ started: false, reason: "running", reviewId: oldId });
    expect(h.reviews()).toHaveLength(1);
    expect(columnsOf(oldId)).toMatchObject({ state: "dispatched", superseded_at: null });
    expect(h.dispatches()).toHaveLength(0);
  });

  test("a request that is not waiting for its decision is refused", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    h.db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [requestId]);
    const out = await again(requestId, admin);
    expect(out).toMatchObject({ started: false, reason: "request_not_requested" });
    expect(h.reviews()).toHaveLength(1);
    expect(columnsOf(oldId).superseded_at).toBeNull();
  });

  test("a Worker that cannot hand a review over replaces nothing", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    const out = await again(requestId, admin, { env: h.env({ PRESCREEN_CALLBACK_SECRET: "" }) });
    expect(out).toMatchObject({ started: false, reason: "dispatch_unconfigured" });
    expect(h.reviews()).toHaveLength(1);
    expect(columnsOf(oldId).superseded_at).toBeNull();
  });

  test("a hand-over that fails leaves the old review history and the new row errored, to start again", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    h.dispatchStatus = 500;
    const out = await again(requestId, admin);
    expect(out).toMatchObject({ started: false, reason: "dispatch_failed", superseded: oldId });
    const fresh = h.reviews()[1];
    expect(fresh).toMatchObject({ state: "errored", detail: "dispatch_failed" });
    expect(columnsOf(oldId).superseded_by).toBe(fresh.id as number);
    // The new row restarts like any errored row, and is still the one in force.
    h.dispatchStatus = 204;
    const retry = await again(requestId, admin, { again: false });
    expect(retry).toMatchObject({ started: true, reason: "redispatched", reviewId: fresh.id });
    expect(h.reviews()).toHaveLength(2);
  });
});

describe("the guards of the supersede batch itself hold against a writer between the read and the write", () => {
  /** A D1 that runs `act` once, just before the supersede batch begins. */
  function beforeSupersede(act: () => void) {
    let done = false;
    return hookedD1(realD1(h.db), {
      batch: (sqls) => {
        if (done || !sqls.some((q) => q.includes("SET superseded_at"))) return;
        done = true;
        act();
      },
    });
  }
  const nothingReplaced = (oldId: number) => {
    expect(h.reviews().filter((r) => r.id !== oldId && r.confirm_of === null)).toEqual([]);
    expect(columnsOf(oldId)).toMatchObject({ state: "reported", superseded_at: null });
    expect(h.dispatches()).toHaveLength(0);
  };

  test("a confirming run that lands in between holds the review", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    const db = beforeSupersede(() =>
      h.db.run(
        `INSERT INTO publication_reviews
           (request_id, dataset_id, head_sha, anonymous, requested_by, state, nonce, confirm_of)
         VALUES (?, ?, ?, 0, 1, 'dispatched', 'n', ?)`,
        [requestId, PROD_DATASET, SCREENED_HEAD, oldId],
      ),
    );
    const out = await again(requestId, admin, { env: h.env({ DB: db }) });
    expect(out).toMatchObject({ started: false, reason: "auto_deny_active", reviewId: oldId });
    nothingReplaced(oldId);
  });

  test("an automatic denial that lands in between holds the review", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    const db = beforeSupersede(() =>
      h.db.run(
        "UPDATE publication_reviews SET auto_deny_state = 'denied', auto_deny_at = datetime('now') WHERE id = ?",
        [oldId],
      ),
    );
    const out = await again(requestId, admin, { env: h.env({ DB: db }) });
    expect(out).toMatchObject({ started: false, reason: "auto_deny_active", reviewId: oldId });
    nothingReplaced(oldId);
  });

  test("a request that becomes approving in between is not reviewed again", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    const db = beforeSupersede(() =>
      h.db.run("UPDATE publication_requests SET status = 'approving' WHERE id = ?", [requestId]),
    );
    const out = await again(requestId, admin, { env: h.env({ DB: db }) });
    expect(out).toMatchObject({ started: false, reason: "request_not_requested" });
    nothingReplaced(oldId);
  });
});

describe("a confirming run is not spent on a first run that was superseded in between", () => {
  test("the insert writes nothing, and nothing is marked", async () => {
    const { requestId, oldId } = await reportedRequest();
    const first = (await readReviewByKey(
      h.env().DB,
      requestId,
      SCREENED_HEAD,
      false,
    )) as NonNullable<Awaited<ReturnType<typeof readReviewByKey>>>;
    expect(first.id).toBe(oldId);
    // The first run is read, then an administrator's re-review supersedes it before the insert.
    let done = false;
    const db = hookedD1(realD1(h.db), {
      statement: (sql) => {
        if (done || !sql.includes("confirm_of")) return;
        if (!sql.trimStart().startsWith("INSERT")) return;
        done = true;
        h.db.run("UPDATE publication_reviews SET superseded_at = datetime('now') WHERE id = ?", [
          oldId,
        ]);
      },
    });
    const out = await startConfirmingReview(h.env({ DB: db }), first);
    expect(done).toBe(true);
    expect(out).toMatchObject({ started: false, reason: "duplicate" });
    expect(h.reviews()).toHaveLength(1);
    expect(h.review(oldId)).toMatchObject({ auto_deny_state: "none" });
    expect(h.dispatches()).toHaveLength(0);
  });

  test("a first run that stands still gets its confirming run", async () => {
    const { requestId, oldId } = await reportedRequest();
    const first = (await readReviewByKey(
      h.env().DB,
      requestId,
      SCREENED_HEAD,
      false,
    )) as NonNullable<Awaited<ReturnType<typeof readReviewByKey>>>;
    const out = await startConfirmingReview(h.env(), first);
    expect(out).toMatchObject({ started: true });
    expect(h.reviews().find((r) => r.confirm_of === oldId)).toMatchObject({ state: "dispatched" });
  });
});

describe("the depositor's status after a re-review", () => {
  const OTHER = "e".repeat(40);
  test("shows the newest reported record, superseded or not, until the new run reports", async () => {
    const { admin, requestId } = await reportedRequest();
    // The commit changed and its own review reported; the older review stays below it.
    markScreen(h.db, requestId, PROD_DATASET, { head: OTHER });
    const h2 = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      head: OTHER,
      state: "reported",
      report: reportFor(OTHER, false),
      claimed: true,
    });
    h.db.run(
      "UPDATE publication_reviews SET input_digest = ?, models = ?, prompt_version = 'publication-review-prompt/1' WHERE id = ?",
      ["d".repeat(64), JSON.stringify([{ model: "claude-haiku-5-5", effort: "high" }]), h2],
    );
    const owner = (
      h.db
        .query<{ owner_user_id: number }, [string]>(
          "SELECT owner_user_id FROM datasets WHERE dataset_id = ?",
        )
        .get(PROD_DATASET) as { owner_user_id: number }
    ).owner_user_id;
    await seedUser(h.db, "againowner", "member", OWNER_KEY);
    h.db.run(
      "UPDATE datasets SET owner_user_id = (SELECT id FROM users WHERE username = 'againowner') WHERE dataset_id = ?",
      [PROD_DATASET],
    );
    expect(owner).toBeGreaterThan(0);

    const status = async () => {
      const res = await h.app.request(
        `/datasets/${PROD_DATASET}/publish/status`,
        { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        h.env(),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { review_record: { head_sha?: string; head?: string } | null };
    };
    const before = JSON.stringify((await status()).review_record);
    expect(before).toContain(OTHER);

    const out = await again(requestId, admin);
    expect(out).toMatchObject({ started: true, superseded: h2 });
    // The new run is only dispatched: the record is still the superseded review of H2, not H1's.
    const during = JSON.stringify((await status()).review_record);
    expect(during).toBe(before);
    expect(during).not.toContain(SCREENED_HEAD);
  });
});

describe("again is refused while the automatic denial holds the review", () => {
  /** A confirming run of `firstId`, in `state`. */
  function seedConfirming(requestId: number, firstId: number, state = "dispatched") {
    const reported = state === "reported";
    h.db.run(
      `INSERT INTO publication_reviews
         (request_id, dataset_id, head_sha, anonymous, requested_by, state, verdict, report,
          nonce, confirm_of, decided_at)
       VALUES (?, ?, ?, 0, 1, ?, ?, (SELECT report FROM publication_reviews WHERE id = ?), ?, ?,
               CASE WHEN ? = 'dispatched' THEN NULL ELSE datetime('now') END)`,
      [
        requestId,
        PROD_DATASET,
        SCREENED_HEAD,
        state,
        reported ? "fail" : null,
        reported ? firstId : -1,
        reported ? null : "n",
        firstId,
        state,
      ],
    );
  }
  const setWord = (id: number, word: string) =>
    h.db.run(
      "UPDATE publication_reviews SET auto_deny_state = ?, auto_deny_at = datetime('now') WHERE id = ?",
      [word, id],
    );

  test("while a confirming run is on record and the word is still none", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    seedConfirming(requestId, oldId);
    const before = h.reviews().length;
    const out = await again(requestId, admin);
    expect(out).toEqual({ started: false, reason: "auto_deny_active", reviewId: oldId });
    expect(h.reviews()).toHaveLength(before);
    expect(columnsOf(oldId).superseded_at).toBeNull();
    expect(h.dispatches()).toHaveLength(0);
  });

  for (const word of ["denied", "would_deny", "capped", "no_service_account", "restored"]) {
    test(`once it acted or is waiting on the cap and the digest (${word})`, async () => {
      const { admin, requestId, oldId } = await reportedRequest();
      setWord(oldId, word);
      const out = await again(requestId, admin);
      expect(out).toEqual({ started: false, reason: "auto_deny_active", reviewId: oldId });
      expect(columnsOf(oldId).superseded_at).toBeNull();
      expect(h.reviews()).toHaveLength(1);
    });
  }

  for (const word of ["not_eligible", "disagreed", "confirm_failed"]) {
    test(`not once it ended with a person to decide (${word}), and the cap still counts it`, async () => {
      const { admin, requestId, oldId } = await reportedRequest();
      setWord(oldId, word);
      seedConfirming(requestId, oldId, "reported");
      const out = await again(requestId, admin);
      expect(out).toMatchObject({ started: true, superseded: oldId });
      // The word and its place under the daily cap stay on the superseded row.
      expect(h.review(oldId)).toMatchObject({ auto_deny_state: word });
      expect(columnsOf(oldId).superseded_at).toEqual(expect.any(String));
    });
  }

  test("a confirming row is never superseded", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    setWord(oldId, "disagreed");
    seedConfirming(requestId, oldId, "reported");
    await again(requestId, admin);
    const confirming = h.reviews().find((r) => r.confirm_of === oldId);
    expect(confirming).toMatchObject({ superseded_at: null, superseded_by: null });
  });
});

describe("an override never attaches to a superseded review", () => {
  test("the statement that records one matches no row once the review is replaced", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    const row = h.review(oldId);
    const run = () =>
      h.db.run(RECORD_OVERRIDE_SQL, [
        admin,
        JSON.stringify(["review_failed"]),
        oldId,
        requestId,
        SCREENED_HEAD,
        0,
        "reported",
        row.created_at as string,
        row.decided_at as string | null,
        null,
      ]).changes;
    await again(requestId, admin);
    expect(run()).toBe(0);
    expect(h.review(oldId).override_by).toBeNull();
    // The same statement on a row that stands does record, so the 0 above is the guard's.
    h.db.run("DELETE FROM publication_reviews WHERE id <> ?", [oldId]);
    h.db.run(
      "UPDATE publication_reviews SET superseded_at = NULL, superseded_by = NULL WHERE id = ?",
      [oldId],
    );
    expect(run()).toBe(1);
  });
});

describe("a report of a good review is still stored once it is the review in force", () => {
  test("the new row reports and the old row is untouched by it", async () => {
    const { admin, requestId, oldId } = await reportedRequest();
    await again(requestId, admin);
    const fresh = h.reviews()[1].id as number;
    await h.claim(fresh);
    const res = await h.result(fresh, {
      outcome: "reported",
      report: reportFor(SCREENED_HEAD, false),
    });
    expect(res.status).toBe(200);
    expect(h.review(fresh)).toMatchObject({ state: "reported", verdict: "pass" });
    expect(h.review(oldId)).toMatchObject({ state: "reported", verdict: "fail" });
  });
});
