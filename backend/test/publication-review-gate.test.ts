/**
 * The publication review as a gate on approval (ADR 0102, sections 8 and 9; epic #1726, phase 2).
 *
 * `POST /admin/publish/:id/approve` and `approve-dispatch` run the review gate after the identifier
 * screen's gate and before the request is marked `approving`. These tests drive those two routes,
 * the places an approval starts, and read the result off the database and the wire.
 *
 * Approvals use the golden resume path of publication-approve-golden.test.ts: every step done but
 * the two logged no-ops, so a run the gate lets through reaches `published` without touching an
 * external service, and a refused one provably never marked the request `approving`. The requests
 * are `requested` and the runs pass `resume: true` on purpose: a resume of a request that never
 * started is how the import pipeline retries, and it must not be a way around either gate.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration, the real auth middleware and
 * routes, review rows seeded through the production parser, and a `Bun.serve()` stand-in for
 * api.github.com (the screen gate's read of `main`, the BIDS validation run, and the dispatch the
 * web route sends). Nothing of the gate or the derivation is replaced.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import type {
  PublicationReviewDetail,
  PublicationReviewGateRefusalBody,
} from "../../shared/contract/publication-review-admin";
import {
  REASONS,
  type ReasonCode,
  parsePublicationReviewReport,
  reviewGateRefusalText,
} from "../../shared/publication-review";
import { PUBLICATION_STEPS } from "../../shared/publication-steps";
import { adminRoutes } from "../src/routes/admin";
import {
  startPublicationReview,
  storePublicationReviewResult,
} from "../src/services/publication-review";
import { RECORD_OVERRIDE_SQL } from "../src/services/publication-review-gate";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import {
  type SeedScreenedRequest,
  evidenceFor,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
} from "./helpers/publication-review";
import { hookedD1 } from "./helpers/publication-review-harness";

const ADMIN_A_KEY = "review-gate-admin-a-0123456789abcdef0123456789abcdef";
const ADMIN_B_KEY = "review-gate-admin-b-0123456789abcdef0123456789abcdef";
const DATASET = "nm000481";
const MIRROR = "nm000482";
const EXEMPLAR = "xx099960";
const DONE = PUBLICATION_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");

let server: Server;
let calls: { method: string; path: string }[] = [];
let mainHead = SCREENED_HEAD;
let bidsConclusion = "success";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminA: number;
let adminB: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      calls.push({ method: req.method, path: p });
      if (req.method === "GET" && /\/git\/ref\/heads\/main$/.test(p)) {
        return Response.json({ object: { sha: mainHead } });
      }
      if (req.method === "POST" && p === "/repos/nemarDatasets/.github/dispatches") {
        return new Response(null, { status: 204 });
      }
      if (/\/actions\/workflows\/bids-validation\.yml\/runs$/.test(p)) {
        return Response.json({
          workflow_runs: [{ status: "completed", conclusion: bidsConclusion, html_url: "x" }],
        });
      }
      if (/\/contents\/\.github\/workflows\/bids-validation\.yml$/.test(p)) {
        return Response.json({ name: "bids-validation.yml" });
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
  calls = [];
  mainHead = SCREENED_HEAD;
  bidsConclusion = "success";
});

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminA = await seedUser(db, "gateadmina", "admin", ADMIN_A_KEY);
  adminB = await seedUser(db, "gateadminb", "admin", ADMIN_B_KEY);
});

/** The Worker's bindings: the review is lit unless a test says otherwise. */
function env(over: Partial<Bindings> = {}, lit = true): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_review_gate_test",
    PRESCREEN_CALLBACK_SECRET: "review-gate-secret",
    PUBLICATION_REVIEW_ENABLED: lit ? "1" : undefined,
    API_BASE_URL: "https://api.test.nemar.org",
    ...over,
  } as Bindings;
}

interface Seed extends Omit<SeedScreenedRequest, "datasetId"> {
  datasetId?: string;
  /** The approval's completed steps. Default: every step but the two no-ops. */
  steps?: readonly string[];
}

/** A request with its steps done, in the state `over` says. */
function seed(over: Seed = {}): { requestId: number; datasetId: string } {
  const datasetId = over.datasetId ?? DATASET;
  const { requestId } = seedScreenedRequest(db, { ...over, datasetId });
  db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    JSON.stringify(over.steps ?? DONE),
    requestId,
  ]);
  return { requestId, datasetId };
}

function approve(
  body: Record<string, unknown> = { resume: true },
  o: { key?: string; dataset?: string; bindings?: Bindings } = {},
): Promise<Response> {
  return app.request(
    `/admin/publish/${o.dataset ?? DATASET}/approve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${o.key ?? ADMIN_A_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    o.bindings ?? env(),
  );
}

type Row = Record<string, unknown>;

function requestRow(id: number): Row {
  return db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Row;
}

function reviewRows(): Row[] {
  return db.query("SELECT * FROM publication_reviews ORDER BY id").all() as Row[];
}

function auditRows(action: string): { user_id: number; details: Record<string, unknown> }[] {
  return (
    db.query("SELECT user_id, details FROM audit_log WHERE action = ? ORDER BY id").all(action) as {
      user_id: number;
      details: string;
    }[]
  ).map((r) => ({ user_id: r.user_id, details: JSON.parse(r.details) }));
}

function published(): { user_id: number; details: Record<string, unknown> } {
  const rows = auditRows("dataset_published");
  expect(rows).toHaveLength(1);
  return rows[0];
}

// ============================================================================

describe("with the review off the gate reads nothing", () => {
  test("1. a failing review does not gate; the run publishes and records that the gate was off", async () => {
    const { requestId } = seed();
    seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
      report: failingReport(),
    });
    const res = await approve({ resume: true }, { bindings: env({}, false) });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(published().details).toMatchObject({ review_gate: "off", skip_ci_check: false });
    expect(auditRows("publication_review_overridden")).toHaveLength(0);
  });

  test("1. with every read of the review table failing the run still publishes: the gate read nothing", async () => {
    const { requestId } = seed();
    seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
      report: failingReport(),
    });
    const reads: string[] = [];
    const broken = hookedD1(realD1(db), {
      statement: (sql) => {
        // The gate's two reads: the request with its dataset (the detail's shape, which carries
        // the dataset's size), and the review's own table.
        if (/ds_total_files/.test(sql)) reads.push("request");
        if (/publication_reviews/.test(sql)) {
          reads.push("review");
          throw new Error("the review table is unreadable");
        }
      },
    });
    const res = await approve({ resume: true }, { bindings: env({ DB: broken }, false) });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(reads).toEqual([]);
  });
});

describe("a blocked request is refused by the mechanical rules, whatever the flag says", () => {
  for (const lit of [true, false] as const) {
    for (const [what, over] of [
      ["a native dataset", {}],
      ["a mirror", { source: "openneuro", datasetId: MIRROR }],
    ] as const) {
      for (const [steps, body] of [
        [[], { resume: false }],
        [PUBLICATION_STEPS, { resume: true }],
      ] as const) {
        test(`2. ${what}, flag ${lit ? "on" : "off"}, ${steps.length === 0 ? "a fresh run" : "every step done"}: 409 request_blocked, nothing started`, async () => {
          const { requestId, datasetId } = seed({
            ...over,
            requestStatus: "blocked",
            blockReason: "min_requirements_failed",
            steps,
          });
          const res = await approve(body, { dataset: datasetId, bindings: env({}, lit) });
          expect(res.status).toBe(409);
          const out = (await res.json()) as Record<string, unknown>;
          expect(out).toMatchObject({
            error: "request_blocked",
            block_reason: "min_requirements_failed",
          });
          expect(String(out.message)).toStartWith("The request is blocked.");
          const row = requestRow(requestId);
          expect(row.status).toBe("blocked");
          expect(row.approved_by).toBeNull();
          expect(JSON.parse(String(row.steps_completed))).toEqual([...steps]);
          expect(row.current_step).toBeNull();
          expect(auditRows("dataset_published")).toHaveLength(0);
          // The refusal comes before the screen gate's read of main.
          expect(calls.filter((c) => /\/git\/ref\//.test(c.path))).toHaveLength(0);
        });
      }
    }
  }
});

describe("a dataset the review does not apply to, and one it passes", () => {
  test("3. a mirror and an exemplar publish with no override, and the gate says n/a", async () => {
    const mirror = seed({ source: "openneuro", datasetId: MIRROR });
    const res = await approve({ resume: true }, { dataset: MIRROR });
    expect(res.status).toBe(200);
    expect(requestRow(mirror.requestId).status).toBe("published");
    expect(published().details).toMatchObject({ review_gate: "n/a" });

    const exemplar = seed({ isExemplar: 1, datasetId: EXEMPLAR });
    const second = await approve(
      { resume: true, sandbox: true },
      { dataset: EXEMPLAR, bindings: env({ ENVIRONMENT: "staging" }) },
    );
    expect(second.status).toBe(200);
    expect(requestRow(exemplar.requestId).status).toBe("published");
    const rows = auditRows("dataset_published");
    expect(rows).toHaveLength(2);
    expect(rows[1].details).toMatchObject({ review_gate: "n/a" });
    // No review was read or written for either.
    expect(reviewRows()).toHaveLength(0);
    expect(auditRows("publication_review_overridden")).toHaveLength(0);
  });

  test("4. a reported pass publishes with nothing recorded, and the gate says enforced", async () => {
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
    });
    const res = await approve();
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(published().details).toMatchObject({ review_gate: "enforced", skip_ci_check: false });
    expect(reviewRows()).toHaveLength(1);
    expect(reviewRows()[0]).toMatchObject({
      id: reviewId,
      override_by: null,
      override_at: null,
      override_reasons: null,
    });
    expect(auditRows("publication_review_overridden")).toHaveLength(0);
  });
});

describe("--skip-ci-check is recorded", () => {
  test("19. a run that skips the CI check says so in the approval's row and in a row of its own", async () => {
    // Only the CI check and the enrichment check left, so the run reaches the skip with no network.
    const { requestId } = seed({
      steps: DONE.filter((s) => s !== "ci_check"),
    });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const res = await approve({ resume: true, skip_ci_check: true });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(published().details).toMatchObject({ skip_ci_check: true });
    const skipped = auditRows("publication_ci_check_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].user_id).toBe(adminA);
    expect(skipped[0].details).toEqual({ request_id: requestId });
    // The BIDS conclusion was never asked for.
    expect(calls.filter((c) => /bids-validation/.test(c.path))).toHaveLength(0);
  });
});

// ============================================================================
// The gate's decisions
// ============================================================================

const OTHER_HEAD = "d".repeat(40);

/** The 409 body of the review gate. */
async function refusalOf(res: Response): Promise<PublicationReviewGateRefusalBody> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as PublicationReviewGateRefusalBody;
  expect(body.error).toBe("publication_review_not_clear");
  return body;
}

/** A request with a review that reported `report` (the failing one unless told otherwise). */
function seedFailing(
  over: Seed = {},
  report: Record<string, unknown> = failingReport(),
): { requestId: number; datasetId: string; reviewId: number } {
  const { requestId, datasetId } = seed(over);
  const reviewId = seedPublicationReview(db, {
    requestId,
    datasetId,
    state: "reported",
    report,
  });
  return { requestId, datasetId, reviewId };
}

/** What the administrator is shown: the detail view of the dataset's active request. */
async function detailOf(datasetId = DATASET, key = ADMIN_A_KEY): Promise<PublicationReviewDetail> {
  const res = await app.request(
    `/admin/publish/${datasetId}/review`,
    { headers: { Authorization: `Bearer ${key}` } },
    env(),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as PublicationReviewDetail;
}

function overrideRows() {
  return auditRows("publication_review_overridden");
}

function reviewRow(id: number): Row {
  return db.query("SELECT * FROM publication_reviews WHERE id = ?").get(id) as Row;
}

describe("a review that is not a pass needs the administrator's override", () => {
  test("6. a failing report is refused, in the words the detail shows, with the override-class codes uncovered", async () => {
    const { requestId, reviewId } = seedFailing();
    const res = await approve();
    const body = await refusalOf(res);
    expect(body.refusal).toBe("needs_override");
    expect(body.message).toBe(reviewGateRefusalText("needs_override", DATASET));
    expect(body.outcome).toBe("fail");
    expect(body.review_id).toBe(reviewId);
    expect(body.uncovered).toEqual(["question_failed"]);
    // The same words the administrator was shown, from the same function.
    const detail = await detailOf();
    expect(body.reasons).toEqual(detail.reasons);
    expect(body.headline).toBe(detail.description.headline);
    // Nothing started, nothing recorded.
    expect(requestRow(requestId).status).toBe("requested");
    expect(requestRow(requestId).approved_by).toBeNull();
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
    expect(auditRows("dataset_published")).toHaveLength(0);
  });

  test("7. an override that covers publishes and is recorded on the row, by code, with its audit row", async () => {
    const { requestId, reviewId } = seedFailing();
    const res = await approve({
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        // A hard code and the screen's own are not an override's to clear: they are not stored.
        reasons: ["question_failed", "request_blocked", "identifier_screen_needs_acknowledgment"],
      },
    });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    const row = reviewRow(reviewId);
    expect(row.override_by).toBe(adminA);
    expect(row.override_at).not.toBeNull();
    expect(row.override_reasons).toBe(JSON.stringify(["question_failed"]));
    const audit = overrideRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(adminA);
    expect(audit[0].details).toEqual({
      request_id: requestId,
      review_id: reviewId,
      head_sha: SCREENED_HEAD,
      outcome: "fail",
      reasons: ["question_failed"],
      via: "approve",
    });
    expect(published().details).toMatchObject({ review_gate: "enforced" });
  });

  test("4. an override sent for a review that needs none is ignored and not recorded", async () => {
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
    });
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    expect(res.status).toBe(200);
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("4. a screen that needed an acknowledgment, with a pass review, publishes: the screen's gate decided", async () => {
    const { requestId } = seed({ status: "review" });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const reason = "Looked at every flagged file; the free text is a device serial.";
    const res = await approve({ resume: true, acknowledge_identifier_screen: reason });
    expect(res.status).toBe(200);
    expect(overrideRows()).toHaveLength(0);
    expect(published().details).toMatchObject({ review_gate: "enforced" });
  });

  test("5. a failed submission minimum is refused whatever the override says, with the hard reason's words", async () => {
    // Seeded directly, so the store's re-block (which would have moved the request to blocked)
    // did not run: the gate still stands between this request and a publication.
    const { requestId, reviewId } = seedFailing(
      {},
      goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 5,
        }),
      }),
    );
    const res = await approve({
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        reasons: ["submission_minimum_failed", "question_failed"],
      },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("hard_reason");
    const hard = REASONS.submission_minimum_failed;
    expect(body.message).toBe(
      `${reviewGateRefusalText("hard_reason", DATASET)} ${hard.sentence} ${hard.cure}`,
    );
    expect(body.reasons.map((r) => r.code)).toContain("submission_minimum_failed");
    expect(requestRow(requestId).status).toBe("requested");
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("5. a named request that keeps the version an anonymous release used is refused the same way", async () => {
    // An earlier anonymous release left its version row; this named request would reuse it.
    seed({ anonymous: true, requestStatus: "published" });
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      "10.82901/nm.test",
    ]);
    const { requestId, reviewId } = seedFailing({}, goodPublicationReport());
    const res = await approve({
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        reasons: ["version_kept_after_anonymous_release", "version_already_released"],
      },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("hard_reason");
    expect(body.message).toContain(REASONS.version_kept_after_anonymous_release.sentence);
    expect(requestRow(requestId).status).toBe("requested");
    expect(overrideRows()).toHaveLength(0);
  });

  test("8. an override given for another review than the one in force is refused, and nothing is recorded", async () => {
    const { requestId, reviewId } = seedFailing();
    // A row of an earlier head of the same request: the administrator read that one.
    const earlier = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      head: OTHER_HEAD,
      state: "reported",
      report: failingReport(OTHER_HEAD),
    });
    expect(earlier).not.toBe(reviewId);
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: earlier, reasons: ["question_failed"] },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("review_changed");
    expect(body.review_id).toBe(reviewId);
    expect(requestRow(requestId).status).toBe("requested");
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(reviewRow(earlier).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("9. a reason that came up after it was shown is not covered, and the refusal says which", async () => {
    const { requestId, reviewId } = seedFailing();
    // The release of this very version lands after the administrator read the review.
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      "10.82901/nm.test",
    ]);
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("override_not_covering");
    expect(body.uncovered).toEqual(["version_already_released"]);
    expect(body.reasons.map((r) => r.code)).toEqual([
      "question_failed",
      "version_already_released",
    ]);
    expect(requestRow(requestId).status).toBe("requested");
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("an override that names a code it does not cover, and misses another, is refused for the missing one", async () => {
    const { reviewId } = seedFailing();
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      "10.82901/nm.test",
    ]);
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["version_already_released"] },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("override_not_covering");
    expect(body.uncovered).toEqual(["question_failed"]);
  });

  test("15. with no review on record the override carries no review id, and is recorded in the audit row alone", async () => {
    const { requestId } = seed();
    const refused = await approve();
    const refusal = await refusalOf(refused);
    expect(refusal.refusal).toBe("needs_override");
    expect(refusal.review_id).toBeNull();
    expect(refusal.uncovered).toEqual(["review_not_started"]);

    // A review id where there is no review is not the one in force.
    const wrong = await approve({
      resume: true,
      override_publication_review: { review_id: 1, reasons: ["review_not_started"] },
    });
    expect((await refusalOf(wrong)).refusal).toBe("review_changed");

    const res = await approve({
      resume: true,
      override_publication_review: { review_id: null, reasons: ["review_not_started"] },
    });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(reviewRows()).toHaveLength(0);
    const audit = overrideRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      request_id: requestId,
      review_id: null,
      head_sha: SCREENED_HEAD,
      reasons: ["review_not_started"],
      via: "approve",
    });
  });

  test("15. an approving request whose screen was re-run to a new head has no review to attach to: same rule", async () => {
    // No review can start for an approving request, so a run stopped before it published whose
    // screen was re-run reads review_not_started and can only be approved over from a terminal.
    bidsConclusion = "failure";
    const { requestId } = seed({ requestStatus: "approving", steps: [] });
    const refused = await approve({ resume: true });
    expect((await refusalOf(refused)).refusal).toBe("needs_override");
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: null, reasons: ["review_not_started"] },
    });
    // Past the gate: the run stopped at the BIDS check, which is not the gate's.
    expect(res.status).toBe(422);
    expect(((await res.json()) as { step?: string }).step).toBe("ci_check");
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(overrideRows()).toHaveLength(1);
    expect(reviewRows()).toHaveLength(0);
  });
});

describe("an override is its approver's, and it is recorded once", () => {
  test("11. an override recorded by an administrator satisfies that administrator's run and nobody else's", async () => {
    const { requestId, reviewId } = seedFailing();
    db.run(
      `UPDATE publication_reviews
          SET override_by = ?, override_at = datetime('now'), override_reasons = ?
        WHERE id = ?`,
      [adminA, JSON.stringify(["question_failed"]), reviewId],
    );
    // Administrator B has no lease on this request and no override of their own.
    const asB = await approve({ resume: true }, { key: ADMIN_B_KEY });
    const body = await refusalOf(asB);
    expect(body.refusal).toBe("needs_override");
    expect(body.uncovered).toEqual(["question_failed"]);
    expect(requestRow(requestId).status).toBe("requested");

    // The one who gave it passes on it, with nothing in the body and nothing written.
    const before = reviewRow(reviewId);
    const asA = await approve({ resume: true });
    expect(asA.status).toBe(200);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(reviewRow(reviewId)).toEqual(before);
    expect(overrideRows()).toHaveLength(0);
  });

  test("11. a recorded override does not cover a reason it was not given for", async () => {
    const { reviewId } = seedFailing();
    db.run(
      `UPDATE publication_reviews
          SET override_by = ?, override_at = datetime('now'), override_reasons = ?
        WHERE id = ?`,
      [adminA, JSON.stringify(["review_running"]), reviewId],
    );
    const body = await refusalOf(await approve());
    expect(body.refusal).toBe("needs_override");
    expect(body.uncovered).toEqual(["question_failed"]);
  });

  test("an override sent again with the same codes by the same administrator is not recorded again", async () => {
    // The CLI sends the override on every call of a run, and a retry must not write a second row.
    bidsConclusion = "failure";
    const { requestId, reviewId } = seedFailing({ requestStatus: "approving", steps: [] });
    const body = {
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    };
    const first = await approve(body);
    expect(first.status).toBe(422);
    const recorded = reviewRow(reviewId);
    expect(recorded.override_by).toBe(adminA);
    expect(overrideRows()).toHaveLength(1);
    const second = await approve(body);
    expect(second.status).toBe(422);
    expect(reviewRow(reviewId)).toEqual(recorded);
    expect(overrideRows()).toHaveLength(1);
    expect(requestRow(requestId).status).toBe("approving");
  });

  test("an override from another administrator for the same review replaces the recorded one", async () => {
    const { reviewId } = seedFailing();
    db.run(
      `UPDATE publication_reviews
          SET override_by = ?, override_at = datetime('now'), override_reasons = ?
        WHERE id = ?`,
      [adminA, JSON.stringify(["question_failed"]), reviewId],
    );
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
      },
      { key: ADMIN_B_KEY },
    );
    expect(res.status).toBe(200);
    expect(reviewRow(reviewId).override_by).toBe(adminB);
    expect(overrideRows()).toHaveLength(1);
    expect(overrideRows()[0].user_id).toBe(adminB);
  });

  test("23. #1604 as it stands: a terminal approval by B inside A's live web lease is A's, and rides on A's override", async () => {
    // Pinned so Phase 3 flips it on purpose: until a dispatch token makes attribution exact
    // (ADR 0102 section 9, #1604), a run inside a live lease is attributed to the clicker, and so
    // satisfies the gate on the clicker's recorded override and records new ones under the
    // clicker's id.
    const { requestId, reviewId } = seedFailing();
    db.run(
      `UPDATE publication_reviews
          SET override_by = ?, override_at = datetime('now'), override_reasons = ?
        WHERE id = ?`,
      [adminA, JSON.stringify(["question_failed"]), reviewId],
    );
    db.run(
      `UPDATE publication_requests
          SET approval_requested_by = ?, approval_dispatched_at = datetime('now', '-1 minutes')
        WHERE id = ?`,
      [adminA, requestId],
    );
    const res = await approve({ resume: true }, { key: ADMIN_B_KEY });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(published().user_id).toBe(adminA);
    expect(published().details).toMatchObject({
      approved_by: "gateadmina",
      executed_by: "gateadminb",
    });
  });
});

describe("the gate runs on a resume that has not started publishing, and only on that one", () => {
  test("16. a run that has started publishing is not gated, whatever the review says", async () => {
    const { requestId } = seedFailing({ requestStatus: "approving", steps: DONE });
    mainHead = OTHER_HEAD;
    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(calls.filter((c) => /\/git\/ref\//.test(c.path))).toHaveLength(0);
    expect(overrideRows()).toHaveLength(0);
  });

  test("17. the CLI's own retry before publishing passes on an override for a review that was running", async () => {
    // The request is `approving` with no step done, and its review was dispatched ten minutes ago.
    // The surfaces read a dispatched row of any request that is not `requested` as one that did not
    // report; the gate reads it by time alone, as it was shown, or the first transient failure of a
    // forced approval would be refused on its retry.
    bidsConclusion = "failure";
    const { requestId } = seed({ requestStatus: "approving", steps: [] });
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "dispatched",
      createdMinutesAgo: 10,
      claimed: true,
    });
    // Gated: no override, no pass.
    const refused = await approve({ resume: true });
    const body = await refusalOf(refused);
    expect(body.refusal).toBe("needs_override");
    expect(body.uncovered).toEqual(["review_running"]);
    expect(requestRow(requestId).approved_by).toBeNull();

    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["review_running"] },
    });
    // Past the gate, and stopped by the BIDS check: positive proof that the gate let it through.
    expect(res.status).toBe(422);
    expect(((await res.json()) as { step?: string }).step).toBe("ci_check");
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(reviewRow(reviewId).override_reasons).toBe(JSON.stringify(["review_running"]));
  });

  test("17. a dispatched row past the time window is a review that did not report, which the override did not name", async () => {
    const { requestId } = seed({ requestStatus: "approving", steps: [] });
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "dispatched",
      createdMinutesAgo: 90,
      claimed: true,
    });
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["review_running"] },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("override_not_covering");
    expect(body.uncovered).toEqual(["review_did_not_report"]);
    expect(requestRow(requestId).approved_by).toBeNull();
  });
});

describe("the gate refuses what it cannot establish", () => {
  test("18. with the review table unreadable the gate refuses, as unverified, and starts nothing", async () => {
    const { requestId } = seedFailing();
    const broken = hookedD1(realD1(db), {
      statement: (sql) => {
        if (/FROM publication_reviews/.test(sql)) throw new Error("the review table is unreadable");
      },
    });
    const res = await approve({ resume: true }, { bindings: env({ DB: broken }) });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("unverified");
    expect(body.fact).toBe("review");
    expect(body.message).toBe(reviewGateRefusalText("unverified", DATASET));
    expect(body.reasons).toEqual([]);
    expect(body.outcome).toBeNull();
    expect(requestRow(requestId).status).toBe("requested");
    expect(auditRows("dataset_published")).toHaveLength(0);
  });

  test("18. with the request unreadable it refuses as unverified too, naming the request", async () => {
    const { requestId } = seedFailing();
    const broken = hookedD1(realD1(db), {
      statement: (sql) => {
        // The gate's read of the request with its dataset (the detail's shape).
        if (/ds_total_files/.test(sql)) throw new Error("the request is unreadable");
      },
    });
    const res = await approve({ resume: true }, { bindings: env({ DB: broken }) });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("unverified");
    expect(body.fact).toBe("request");
    expect(requestRow(requestId).status).toBe("requested");
  });
});

describe("--skip-ci-check never clears a reason about the reviewed commit", () => {
  test("19. a review whose BIDS run failed still needs the override when the CI check is skipped", async () => {
    const { requestId, reviewId } = seedFailing(
      { steps: DONE.filter((s) => s !== "ci_check") },
      goodPublicationReport({ evidence: evidenceFor(SCREENED_HEAD, false, { bids: "fail" }) }),
    );
    const refused = await approve({ resume: true, skip_ci_check: true });
    const body = await refusalOf(refused);
    expect(body.refusal).toBe("needs_override");
    expect(body.uncovered).toEqual(["bids_failed_at_review"]);
    expect(auditRows("publication_ci_check_skipped")).toHaveLength(0);

    const res = await approve({
      resume: true,
      skip_ci_check: true,
      override_publication_review: { review_id: reviewId, reasons: ["bids_failed_at_review"] },
    });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(auditRows("publication_ci_check_skipped")).toHaveLength(1);
    expect(published().details).toMatchObject({ skip_ci_check: true, review_gate: "enforced" });
  });
});

describe("an override attaches to the result it was shown with, or to nothing", () => {
  const OVERRIDE_CODES = ["review_could_not_run"] as ReasonCode[];

  test("10. a restart that lands between the gate's read and the record refuses the override, and records nothing", async () => {
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "errored",
      detail: "model_unavailable",
      claimed: true,
    });
    const real = realD1(db);
    const racing = interceptingD1(real, async (sql) => {
      if (sql === RECORD_OVERRIDE_SQL) {
        // An administrator's start of a new attempt, through the real start path.
        const started = await startPublicationReview(env({ DB: real }), {
          requestId,
          datasetId: DATASET,
          adminUserId: adminB,
        });
        expect(started).toMatchObject({ started: true, reason: "redispatched" });
      }
    });
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: OVERRIDE_CODES },
      },
      { bindings: env({ DB: racing }) },
    );
    const body = await refusalOf(res);
    expect(body.refusal).toBe("review_changed");
    expect(body.message).toBe(reviewGateRefusalText("review_changed", DATASET));
    // The refusal reads the request again: the new attempt is running now.
    expect(body.reasons.map((r) => r.code)).toEqual(["review_running"]);
    const row = reviewRow(reviewId);
    expect(row).toMatchObject({ state: "dispatched", override_by: null, override_reasons: null });
    expect(requestRow(requestId).status).toBe("requested");
    expect(overrideRows()).toHaveLength(0);
  });

  test("10. a result that lands between the read and the record refuses it too", async () => {
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "dispatched",
      createdMinutesAgo: 5,
      claimed: true,
    });
    const nonce = (
      db.query("SELECT nonce FROM publication_reviews WHERE id = ?").get(reviewId) as {
        nonce: string;
      }
    ).nonce;
    const real = realD1(db);
    const racing = interceptingD1(real, async (sql) => {
      if (sql === RECORD_OVERRIDE_SQL) {
        // The job's report lands: a failing one, which the override for "running" never saw.
        const stored = await storePublicationReviewResult(
          env({ DB: real }),
          reviewId,
          DATASET,
          nonce,
          {
            kind: "reported",
            report: parsePublicationReviewReport(failingReport()),
          },
        );
        expect(stored.stored).toBe(true);
      }
    });
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["review_running"] },
      },
      { bindings: env({ DB: racing }) },
    );
    expect((await refusalOf(res)).refusal).toBe("review_changed");
    expect(reviewRow(reviewId)).toMatchObject({ state: "reported", override_by: null });
    expect(requestRow(requestId).status).toBe("requested");
    expect(overrideRows()).toHaveLength(0);
  });
});

describe("the override comes from an API key", () => {
  // Every claim of the gate is about an administrator's own act; a session cookie rides on any
  // cross-site request a browser can be made to send, so the website records an override through
  // approve-dispatch, which asks for a NEMAR origin.
  test("20. an override in the body of a cookie request is refused whatever the Origin, a bearer key's is accepted", async () => {
    const { issueSession } = await import("../src/services/web-session");
    const { reviewId } = seedFailing();
    const { cookieIdRaw } = await issueSession(
      env(),
      adminA,
      false,
      "test-agent",
      "127.0.0.1",
      "orcid",
    );
    const withCookie = (origin?: string, withOverride = true) =>
      app.request(
        `/admin/publish/${DATASET}/approve`,
        {
          method: "POST",
          headers: {
            Cookie: `nemar_session=${cookieIdRaw}`,
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify({
            resume: true,
            ...(withOverride
              ? {
                  override_publication_review: {
                    review_id: reviewId,
                    reasons: ["question_failed"],
                  },
                }
              : {}),
          }),
        },
        env(),
      );
    for (const origin of [undefined, "https://app.nemar.org", "https://evil.example"]) {
      const res = await withCookie(origin);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("origin_not_allowed");
      expect(body.message).toContain("approve-dispatch");
    }
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(auditRows("dataset_published")).toHaveLength(0);

    // Without an override a cookie request is unchanged: it reaches the gate and is refused there.
    expect((await refusalOf(await withCookie("https://app.nemar.org", false))).refusal).toBe(
      "needs_override",
    );

    const bearer = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    expect(bearer.status).toBe(200);
  });
});

describe("the override is shape-checked before anything is read", () => {
  test("a malformed override is a 400 before anything is read", async () => {
    const { requestId, reviewId } = seedFailing();
    for (const bad of [
      { review_id: reviewId },
      { review_id: reviewId, reasons: ["not_a_reason"] },
      { review_id: 0, reasons: [] },
      { review_id: reviewId, reasons: [], extra: true },
      "yes",
    ]) {
      const res = await approve({ resume: true, override_publication_review: bad });
      expect(res.status).toBe(400);
    }
    expect(requestRow(requestId).status).toBe("requested");
  });
});
