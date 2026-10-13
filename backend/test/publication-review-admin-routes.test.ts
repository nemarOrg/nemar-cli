/**
 * What an administrator reads about a publication review (ADR 0101, section 8), through the real
 * `/admin` router: `GET /admin/publish/requests` (each row gains `publication_review`) and
 * `GET /admin/publish/:id/review` (the detail, with history).
 *
 * The outcome shown is re-derived now from the stored report and the live facts, and is the
 * stricter of the stored verdict and the re-derived one: either can lower it and neither can raise
 * it. Nothing a viewer reads carries a nonce, and the model's own words (its summary and the notes
 * of its findings) appear in the detail response and nowhere else.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth
 * middleware with a bearer key, review rows seeded through the production parser
 * (`helpers/publication-review.ts`). No stand-in answers anything here.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type {
  PublicationReviewDetail,
  PublicationReviewSummary,
} from "../../shared/contract/publication-review-admin";
import {
  NOT_ASSESSED_LINE,
  REASONS,
  REASON_CODES,
  REVIEW_OVERDUE_VIEW_MINUTES,
  type ReasonCode,
} from "../../shared/publication-review";
import { adminRoutes } from "../src/routes/admin";
import { isScreenExempt } from "../src/services/identifier-screen";
import {
  HISTORY_LIMIT,
  overrideReasonsOf,
  screenExempt,
} from "../src/services/publication-review-view";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import {
  type SeedReview,
  type SeedScreenedRequest,
  evidenceFor,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
} from "./helpers/publication-review";

const ADMIN_KEY = "review-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "review-member-key-0123456789abcdef0123456789abcd";
const OTHER_HEAD = "f".repeat(40);
const SUMMARY_SENTINEL = "SUMMARY-SENTINEL-the-model-wrote-this";
const NOTE_SENTINEL = "NOTE-SENTINEL-the-model-wrote-this-too";
const NONCE_SENTINEL = "NONCE-SENTINEL-0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let counter = 0;

async function seedUser(username: string, role: string, key: string) {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1, 'Ada', 'Lovelace')`,
    [username, `${username}@example.org`, role],
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
}

beforeEach(async () => {
  db = freshDb();
  counter = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedUser("reviewadmin", "admin", ADMIN_KEY);
  await seedUser("reviewmember", "member", MEMBER_KEY);
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    PUBLICATION_REVIEW_ENABLED: "1",
    ...over,
  } as Bindings;
}

function nextDataset(): string {
  counter += 1;
  return `nm0007${String(counter).padStart(2, "0")}`;
}

/** A native request whose screen reported (clean, at SCREENED_HEAD) unless told otherwise. */
function request(over: Partial<SeedScreenedRequest> = {}) {
  const datasetId = over.datasetId ?? nextDataset();
  const { requestId } = seedScreenedRequest(db, { ...over, datasetId });
  return { requestId, datasetId };
}

function get(path: string, key = ADMIN_KEY, bindings: Bindings = env()) {
  return app.request(path, { headers: { Authorization: `Bearer ${key}` } }, bindings);
}

type ListRow = Record<string, unknown> & {
  dataset_id: string;
  status: string;
  publication_review: PublicationReviewSummary;
};

async function listBody(bindings: Bindings = env()): Promise<{ text: string; rows: ListRow[] }> {
  const res = await get("/admin/publish/requests", ADMIN_KEY, bindings);
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, rows: (JSON.parse(text) as { requests: ListRow[] }).requests };
}

/** The review of the dataset's active request in the list (the newest one still open, else the newest). */
async function review(datasetId: string, bindings: Bindings = env()) {
  const { rows } = await listBody(bindings);
  const mine = rows.filter((r) => r.dataset_id === datasetId);
  expect(mine.length).toBeGreaterThan(0);
  const open = mine.find((r) => ["requested", "approving", "blocked"].includes(r.status as string));
  return (open ?? mine[0]).publication_review;
}

async function detail(datasetId: string, bindings: Bindings = env()) {
  const res = await get(`/admin/publish/${datasetId}/review`, ADMIN_KEY, bindings);
  expect(res.status).toBe(200);
  return (await res.json()) as PublicationReviewDetail;
}

function failingReport(head = SCREENED_HEAD) {
  return goodPublicationReport({
    summary: SUMMARY_SENTINEL,
    questions: {
      complete_and_honest: "fail",
      meets_standards: "pass",
      authors_and_license: "pass",
      name_adequate: "pass",
    },
    findings: [
      {
        question: "complete_and_honest",
        severity: "blocker",
        code: "readme_mismatch",
        document: "readme",
        note: NOTE_SENTINEL,
      },
    ],
    evidence: evidenceFor(head),
  });
}

function addVersionRow(datasetId: string, version = "1.0.0") {
  db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, ?, ?)", [
    datasetId,
    version,
    "10.82901/nm.test",
  ]);
}

// ============================================================================

describe("GET /admin/publish/requests: the review of each request", () => {
  test("a mirror and an exemplar are not applicable: no row is read and no outcome is claimed", async () => {
    const mirror = request({ source: "openneuro" });
    const exemplar = request({ isExemplar: 1 });
    for (const { datasetId } of [mirror, exemplar]) {
      expect(await review(datasetId)).toEqual({
        kind: "not_applicable",
        enabled: true,
        gate: "n/a",
        outcome: null,
        headline: "Publication review: not applicable",
        tone: "note",
        reasons: [],
        review_id: null,
        head_sha: null,
      });
    }
  });

  test("with the review off the row says off, gates nothing and is never a pass", async () => {
    const { datasetId } = request();
    const off = await review(datasetId, env({ PUBLICATION_REVIEW_ENABLED: undefined }));
    expect(off.kind).toBe("off");
    expect(off.enabled).toBe(false);
    expect(off.gate).toBe("off");
    expect(off.headline).toBe("Publication review: not reviewed (the automated review is off)");
    expect(off.outcome).not.toBe("pass");
    // Exactly "1" turns it on: nothing else does.
    for (const flag of ["0", "true", "yes", " 1", "1 "]) {
      expect((await review(datasetId, env({ PUBLICATION_REVIEW_ENABLED: flag }))).kind).toBe("off");
    }
  });

  test("a stored review is still shown with the review off, as advice that gates nothing", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const r = await review(datasetId, env({ PUBLICATION_REVIEW_ENABLED: undefined }));
    expect(r.kind).toBe("off");
    expect(r.gate).toBe("off");
    expect(r.headline).toBe("Publication review (advice only, the automated review is off): pass");
    expect(r.review_id).not.toBeNull();
  });

  test("a clear screen with no review is not reviewed: action required, never a pass", async () => {
    const { datasetId } = request();
    expect(await review(datasetId)).toMatchObject({
      kind: "not_reviewed",
      enabled: true,
      gate: "enforced",
      outcome: "action_required",
      reasons: ["review_not_started"],
      review_id: null,
      head_sha: null,
    });
  });

  test("a young dispatched review is running; the same row past the view's bound did not report", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 5 });
    const running = await review(datasetId);
    expect(running).toMatchObject({
      kind: "running",
      outcome: "action_required",
      reasons: ["review_running"],
      head_sha: SCREENED_HEAD,
    });
    expect(running.review_id).not.toBeNull();

    // The dev Worker runs no watchdog, so age alone must say it: the deadline plus one tick.
    db.run("UPDATE publication_reviews SET created_at = datetime('now', ?)", [
      `-${REVIEW_OVERDUE_VIEW_MINUTES - 5} minutes`,
    ]);
    expect((await review(datasetId)).reasons).toEqual(["review_running"]);
    db.run("UPDATE publication_reviews SET created_at = datetime('now', ?)", [
      `-${REVIEW_OVERDUE_VIEW_MINUTES + 1} minutes`,
    ]);
    expect(await review(datasetId)).toMatchObject({
      kind: "decided",
      outcome: "action_required",
      reasons: ["review_did_not_report"],
    });
  });

  test("a reported pass over a clear screen and no live fact is a pass", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    expect(await review(datasetId)).toMatchObject({
      kind: "decided",
      gate: "enforced",
      outcome: "pass",
      headline: "Publication review: pass",
      tone: "ok",
      reasons: [],
    });
  });

  test("each way a review ends without a report reads as a reason, never a pass", async () => {
    const cases: Array<[Omit<SeedReview, "requestId" | "datasetId">, string]> = [
      [{ state: "errored", detail: "model_refused" }, "review_could_not_run"],
      [{ state: "declined", detail: "platform_limit" }, "review_limit_reached"],
      [{ state: "unreported" }, "review_did_not_report"],
    ];
    for (const [seed, code] of cases) {
      const { requestId, datasetId } = request();
      seedPublicationReview(db, { ...seed, requestId, datasetId });
      const r = await review(datasetId);
      expect(r.kind).toBe("decided");
      expect(r.outcome).toBe("action_required");
      expect(r.reasons).toEqual([code as ReasonCode]);
    }
  });

  test("a screen that needs an acknowledgment adds its reason, which a clean review does not clear", async () => {
    const { requestId, datasetId } = request({ status: "review" });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    expect(await review(datasetId)).toMatchObject({
      outcome: "action_required",
      reasons: ["identifier_screen_needs_acknowledgment"],
    });
  });

  test("a screen that blocks, waits or has no verdict gives its own reason and starts no review", async () => {
    const waiting = request({ status: "pending" });
    const blocked = request({
      status: "direct-identifiers",
      requestStatus: "blocked",
      blockReason: "identifier_screen_findings",
    });
    const errored = request({ status: "error" });
    expect((await review(waiting.datasetId)).reasons).toEqual(["identifier_screen_pending"]);
    expect((await review(blocked.datasetId)).reasons).toEqual([
      "request_blocked",
      "identifier_screen_blocks",
    ]);
    expect((await review(errored.datasetId)).reasons).toEqual(["identifier_screen_not_run"]);
    for (const d of [waiting, blocked, errored]) {
      expect((await review(d.datasetId)).outcome).not.toBe("pass");
    }
  });

  test("a version row for the reviewed version lowers a stored pass to fail", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    expect((await review(datasetId)).outcome).toBe("pass");
    addVersionRow(datasetId);
    expect(await review(datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["version_already_released"],
    });
  });

  test("a version row of another version does not", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId, "0.9.0");
    expect((await review(datasetId)).outcome).toBe("pass");
  });

  test("a named request after an anonymous release that keeps its version is a hard fail", async () => {
    const datasetId = nextDataset();
    // The earlier anonymous request, and the version row its release left behind.
    request({ datasetId, anonymous: true, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toEqual(["version_kept_after_anonymous_release"]);
  });

  test("the same version after a NAMED release is the ordinary 'already released'", async () => {
    const datasetId = nextDataset();
    request({ datasetId, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    expect((await review(datasetId)).reasons).toEqual(["version_already_released"]);
  });

  test("a named request whose dataset was already published under a name is 'already released', even after an anonymous one", async () => {
    const datasetId = nextDataset();
    request({ datasetId, anonymous: true, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    db.run("UPDATE datasets SET first_published_at = datetime('now') WHERE dataset_id = ?", [
      datasetId,
    ]);
    expect((await review(datasetId)).reasons).toEqual(["version_already_released"]);
  });

  test("an anonymous release that reuses a version is the ordinary 'already released', not the hard one", async () => {
    const { requestId, datasetId } = request({ anonymous: true });
    seedPublicationReview(db, { requestId, datasetId, anonymous: true, state: "reported" });
    addVersionRow(datasetId);
    expect((await review(datasetId)).reasons).toEqual(["version_already_released"]);
  });

  // A review of a dataset whose description sets no Version: the orchestrator publishes
  // `Version || "1.0.0"`, so the live version checks look 1.0.0 up, as the approval will.
  const noVersion = () =>
    goodPublicationReport({
      evidence: evidenceFor(SCREENED_HEAD, false, {
        version: null,
        version_shape: "missing",
        tag: "not_applicable",
      }),
    });

  test("a request with no Version is published as 1.0.0, so a released 1.0.0 is a fail, not just a missing version", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: noVersion() });
    // Nothing released: only the overridable word.
    expect((await review(datasetId)).reasons).toEqual(["version_missing"]);
    addVersionRow(datasetId, "1.0.0");
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toEqual(["version_already_released", "version_missing"]);
    // A release of another version is not the one the approval would publish.
    db.run("DELETE FROM dataset_versions WHERE dataset_id = ?", [datasetId]);
    addVersionRow(datasetId, "2.0.0");
    expect((await review(datasetId)).reasons).toEqual(["version_missing"]);
  });

  test("a named request with no Version after an anonymous release at 1.0.0 is the hard reason", async () => {
    const datasetId = nextDataset();
    request({ datasetId, anonymous: true, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: noVersion() });
    addVersionRow(datasetId, "1.0.0");
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toEqual(["version_kept_after_anonymous_release", "version_missing"]);
    expect(
      (await detail(datasetId)).reasons.find(
        (x) => x.code === "version_kept_after_anonymous_release",
      ),
    ).toMatchObject({ class: "fail", cleared_by: "nothing" });
  });

  test("a malformed Version stays malformed and is not looked up", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      report: goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          version: null,
          version_shape: "malformed",
          tag: "not_applicable",
        }),
      }),
    });
    addVersionRow(datasetId, "1.0.0");
    expect((await review(datasetId)).reasons).toEqual(["version_malformed"]);
  });

  test("a concept DOI no earlier anonymous release reserved is unexpected", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.concept', ezid_status = 'reserved' WHERE dataset_id = ?",
      [datasetId],
    );
    expect(await review(datasetId)).toMatchObject({
      outcome: "action_required",
      reasons: ["doi_state_unexpected"],
    });
  });

  test("the inverse: the DOI an earlier anonymous release left reserved is expected, a public one is not", async () => {
    const datasetId = nextDataset();
    request({ datasetId, anonymous: true, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.concept', ezid_status = 'reserved' WHERE dataset_id = ?",
      [datasetId],
    );
    expect((await review(datasetId)).reasons).toEqual([]);
    db.run("UPDATE datasets SET ezid_status = 'public' WHERE dataset_id = ?", [datasetId]);
    expect((await review(datasetId)).reasons).toEqual(["doi_state_unexpected"]);
  });

  test("a request is not its own predecessor: the first anonymous request's DOI is unexpected too", async () => {
    // Only EARLIER requests count. The anonymous request itself reserved nothing yet.
    const { requestId, datasetId } = request({ anonymous: true });
    seedPublicationReview(db, { requestId, datasetId, anonymous: true, state: "reported" });
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.concept', ezid_status = 'reserved' WHERE dataset_id = ?",
      [datasetId],
    );
    expect((await review(datasetId)).reasons).toEqual(["doi_state_unexpected"]);
  });

  test("a review of another commit, or of the other kind of release, is history and never the outcome", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, head: OTHER_HEAD, state: "reported" });
    seedPublicationReview(db, { requestId, datasetId, anonymous: true, state: "reported" });
    expect(await review(datasetId)).toMatchObject({
      kind: "not_reviewed",
      outcome: "action_required",
      reasons: ["review_not_started"],
      review_id: null,
    });
  });

  test("the outcome is the stricter of the stored verdict and the one re-derived", async () => {
    // A stored fail over a report that no longer shows why: the column still lowers it.
    const failStored = request();
    seedPublicationReview(db, {
      requestId: failStored.requestId,
      datasetId: failStored.datasetId,
      state: "reported",
      verdict: "fail",
    });
    expect(await review(failStored.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["stored_verdict_fail"],
    });

    // A stored pass over a report that fails: the stored column cannot raise it.
    const passStored = request();
    seedPublicationReview(db, {
      requestId: passStored.requestId,
      datasetId: passStored.datasetId,
      state: "reported",
      report: failingReport(),
      verdict: "pass",
    });
    expect(await review(passStored.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["question_failed"],
    });

    // A stored action_required over a clean report is not a pass either.
    const needsPerson = request();
    seedPublicationReview(db, {
      requestId: needsPerson.requestId,
      datasetId: needsPerson.datasetId,
      state: "reported",
      verdict: "action_required",
    });
    expect(await review(needsPerson.datasetId)).toMatchObject({
      outcome: "action_required",
      reasons: ["review_could_not_run"],
    });
  });

  test("a stored report that no longer parses could not be read back: never a pass, and a stored fail stays a fail", async () => {
    const junkPass = request();
    seedPublicationReview(db, {
      requestId: junkPass.requestId,
      datasetId: junkPass.datasetId,
      state: "reported",
      rawReport: '{"v":1,"model":"gpt"}',
      verdict: "pass",
    });
    expect(await review(junkPass.datasetId)).toMatchObject({
      outcome: "action_required",
      reasons: ["review_could_not_run"],
    });
    const junkFail = request();
    seedPublicationReview(db, {
      requestId: junkFail.requestId,
      datasetId: junkFail.datasetId,
      state: "reported",
      rawReport: "not json at all",
      verdict: "fail",
    });
    expect(await review(junkFail.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["stored_verdict_fail", "review_could_not_run"],
    });
  });

  test("a stored report whose evidence is about another commit or release kind could not be read back, and is never a pass", async () => {
    // The write path refuses such a report, and the database has no CHECK that does: a row edited
    // by hand (or written by an older build) must not read as the review of this commit.
    const cases: Array<[string, string, string | number | boolean]> = [
      ["another commit", "$.evidence.head", OTHER_HEAD],
      ["the other kind of release", "$.evidence.anonymous", 1],
    ];
    for (const [name, path, value] of cases) {
      const { requestId, datasetId } = request();
      const id = seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      expect((await review(datasetId)).outcome).toBe("pass");
      db.run("UPDATE publication_reviews SET report = json_set(report, ?, ?) WHERE id = ?", [
        path,
        value,
        id,
      ]);
      const r = await review(datasetId);
      expect({ name, outcome: r.outcome, reasons: r.reasons }).toEqual({
        name,
        outcome: "action_required",
        reasons: ["review_could_not_run"],
      });
      const d = await detail(datasetId);
      expect(d.reasons).toMatchObject([{ code: "review_could_not_run", detail: "report_invalid" }]);
      // Nothing of a report that does not belong to the row is shown as the row's.
      expect(d.review).toMatchObject({ id, questions: null, evidence: null, summary: null });
      expect(d.review?.findings).toEqual([]);
    }
    // A stored fail over such a report stays a fail, as for a report that does not parse.
    const { requestId, datasetId } = request();
    const id = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      verdict: "fail",
    });
    db.run(
      "UPDATE publication_reviews SET report = json_set(report, '$.evidence.head', ?) WHERE id = ?",
      [OTHER_HEAD, id],
    );
    expect((await review(datasetId)).reasons).toEqual([
      "stored_verdict_fail",
      "review_could_not_run",
    ]);
  });

  test("a failed minimum at the reviewed commit shows with the block it caused", async () => {
    const { requestId, datasetId } = request({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      report: goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 5,
        }),
      }),
    });
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toContain("request_blocked");
    expect(r.reasons).toContain("submission_minimum_failed");
  });

  test("only a request in requested is reviewed: a dispatched row of any other request is not a wait", async () => {
    for (const requestStatus of ["blocked", "approving"] as const) {
      const { requestId, datasetId } = request({
        requestStatus,
        blockReason: requestStatus === "blocked" ? "min_requirements_failed" : null,
      });
      seedPublicationReview(db, {
        requestId,
        datasetId,
        state: "dispatched",
        createdMinutesAgo: 2,
      });
      const r = await review(datasetId);
      expect(r.reasons).toContain("review_did_not_report");
      expect(r.reasons).not.toContain("review_running");
      expect(r.kind).toBe("decided");
    }
  });

  test("a request that is over reads its stored review only: no live fact is held against it", async () => {
    for (const requestStatus of ["published", "denied"] as const) {
      const { requestId, datasetId } = request({ requestStatus });
      seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      addVersionRow(datasetId);
      db.run(
        "UPDATE datasets SET concept_doi = '10.82901/nm.done', ezid_status = 'public' WHERE dataset_id = ?",
        [datasetId],
      );
      const r = await review(datasetId);
      expect(r.outcome).toBe("pass");
      expect(r.reasons).toEqual([]);
    }
  });

  test("an approving request is read from its stored review only: what its own run wrote is not held against it", async () => {
    // The approval has already written the version row and the concept DOI of THIS release. Read
    // as live facts they would say "already released" and "unexpected DOI" about a run that is to
    // be resumed, and point at `approve --force` for it.
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.own-run', ezid_status = 'draft' WHERE dataset_id = ?",
      [datasetId],
    );
    expect(await review(datasetId)).toMatchObject({ outcome: "pass", reasons: [] });
    const d = await detail(datasetId);
    expect(d.request_status).toBe("approving");
    expect(d.outcome).toBe("pass");
    expect(d.reasons).toEqual([]);
    expect(d.description.next).not.toContain("--force");
  });

  test("an approving request still shows its stored review: a failed question and a stored fail stand", async () => {
    const failed = request({ requestStatus: "approving" });
    seedPublicationReview(db, {
      requestId: failed.requestId,
      datasetId: failed.datasetId,
      state: "reported",
      report: failingReport(),
    });
    addVersionRow(failed.datasetId);
    expect(await review(failed.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["question_failed"],
    });
    const storedFail = request({ requestStatus: "approving" });
    seedPublicationReview(db, {
      requestId: storedFail.requestId,
      datasetId: storedFail.datasetId,
      state: "reported",
      verdict: "fail",
    });
    expect(await review(storedFail.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["stored_verdict_fail"],
    });
  });

  test("a blocked request has written nothing of an approval, so its live facts are still read", async () => {
    // A request is blocked before any approval step runs (the only walk back from approving is
    // the owner-name check, ahead of the first step), so a version row or a concept DOI on its
    // dataset belongs to an earlier release, which is what the checks look for.
    const { requestId, datasetId } = request({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toEqual(["request_blocked", "version_already_released"]);
  });

  test("every row's reasons are codes of the closed vocabulary, and a non-pass always has one", async () => {
    // A broad sweep of seeded states: no row may be an outcome without a reason.
    const seeds: Array<Partial<SeedScreenedRequest>> = [
      {},
      { status: "review" },
      { status: "pending" },
      { status: "error" },
      { status: "unchecked" },
      { status: "no-recordings" },
      { status: "dates-only" },
      { requestStatus: "blocked", blockReason: "min_requirements_failed" },
      { source: "openneuro" },
    ];
    for (const s of seeds) request(s);
    const { rows } = await listBody();
    expect(rows.length).toBe(seeds.length);
    for (const row of rows) {
      const r = row.publication_review;
      for (const code of r.reasons) expect(REASON_CODES).toContain(code);
      if (r.outcome !== "pass" && r.kind !== "not_applicable") {
        expect(r.reasons.length).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================================

describe("what the list carries", () => {
  test("a row gains one key, and the joined dataset columns and every nonce stay off the wire", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "unreported",
      nonce: NONCE_SENTINEL,
    });
    db.run(
      "UPDATE publication_requests SET prescreen_nonce = ?, identifier_screen_nonce = ? WHERE id = ?",
      ["PRESCREEN-NONCE-SENTINEL", "SCREEN-NONCE-SENTINEL", requestId],
    );
    const { text, rows } = await listBody();
    const row = rows.find((r) => r.dataset_id === datasetId) as ListRow;

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(publication_requests)")
      .all()
      .map((c) => c.name);
    const withheld = ["prescreen_nonce", "identifier_screen_nonce", "identifier_screen_report"];
    const expected = [
      ...columns.filter((c) => !withheld.includes(c)),
      "requested_by_username",
      "requested_by_email",
      "approval_in_flight",
      "identifier_screen",
      "publication_review",
    ].sort();
    expect(Object.keys(row).sort()).toEqual(expected);
    expect(Object.keys(row.publication_review).sort()).toEqual(
      [
        "kind",
        "enabled",
        "gate",
        "outcome",
        "headline",
        "tone",
        "reasons",
        "review_id",
        "head_sha",
      ].sort(),
    );

    // No key anywhere is a nonce, and no nonce's value is anywhere.
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
      }
    };
    walk(JSON.parse(text));
    expect(keys.filter((k) => /nonce/i.test(k))).toEqual([]);
    for (const sentinel of [NONCE_SENTINEL, "PRESCREEN-NONCE-SENTINEL", "SCREEN-NONCE-SENTINEL"]) {
      expect(text).not.toContain(sentinel);
    }
  });

  test("the model's summary and the notes of its findings are not in the list", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: failingReport() });
    const { text } = await listBody();
    expect(text).toContain("Publication review: FAIL");
    expect(text).not.toContain(SUMMARY_SENTINEL);
    expect(text).not.toContain(NOTE_SENTINEL);
  });

  test("a dataset row that is gone reads as a native one, and never breaks the list", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM datasets WHERE dataset_id = ?", [datasetId]);
    expect((await review(datasetId)).outcome).toBe("pass");
  });

  test("a list that cannot read a fact fails loudly, with no SQL in the answer", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const failing = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (/^\s*SELECT .*FROM publication_reviews/s.test(sql))
          throw new Error("D1_ERROR: simulated SQL text");
      }),
    });
    const res = await get("/admin/publish/requests", ADMIN_KEY, failing);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("simulated");
  });
});

// ============================================================================

describe("GET /admin/publish/:id/review", () => {
  test("the detail of a reported review: the outcome, the reasons with their clearers, the record and the standing line", async () => {
    const { requestId, datasetId } = request();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      report: failingReport(),
    });
    const d = await detail(datasetId);
    expect(d).toMatchObject({
      environment: "production",
      enabled: true,
      dataset_id: datasetId,
      request_id: requestId,
      request_status: "requested",
      anonymous: false,
      applies: true,
      gate: "enforced",
      outcome: "fail",
    });
    // The contract's keys and no others, at every level: no row is ever spread onto the wire.
    expect(Object.keys(d).sort()).toEqual(
      [
        "environment",
        "enabled",
        "dataset_id",
        "request_id",
        "request_status",
        "anonymous",
        "applies",
        "gate",
        "outcome",
        "reasons",
        "description",
        "review",
        "history",
        "history_truncated",
      ].sort(),
    );
    expect(Object.keys(d.review ?? {}).sort()).toEqual(
      [
        "id",
        "head_sha",
        "anonymous",
        "state",
        "detail",
        "stored_verdict",
        "model",
        "version",
        "created_at",
        "decided_at",
        "started_by",
        "override",
        "questions",
        "findings",
        "summary",
        "evidence",
      ].sort(),
    );
    expect(Object.keys(d.history[0]).sort()).toEqual(
      ["id", "head_sha", "anonymous", "state", "verdict", "created_at", "decided_at"].sort(),
    );
    expect(Object.keys(d.reasons[0]).sort()).toEqual(
      ["code", "class", "cleared_by", "detail", "sentence", "cure"].sort(),
    );
    expect(d.reasons).toEqual([
      {
        code: "question_failed",
        class: "fail",
        cleared_by: "override",
        detail: "complete_and_honest",
        sentence: REASONS.question_failed.sentence,
        cure: REASONS.question_failed.cure,
      },
    ]);
    expect(d.description.headline).toBe("Publication review: FAIL");
    expect(d.description.tone).toBe("stop");
    expect(d.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
    expect(d.description.next).toBe(`nemar admin publish approve ${datasetId} --force`);

    expect(d.review).toMatchObject({
      id: reviewId,
      head_sha: SCREENED_HEAD,
      anonymous: false,
      state: "reported",
      detail: null,
      stored_verdict: "fail",
      model: "claude-haiku-5-5",
      version: "1.0.0",
      started_by: null,
      override: null,
      questions: {
        complete_and_honest: "fail",
        meets_standards: "pass",
        authors_and_license: "pass",
        name_adequate: "pass",
      },
      // The model's own words are in the detail, and only here.
      summary: SUMMARY_SENTINEL,
    });
    expect(d.review?.findings).toEqual([
      {
        question: "complete_and_honest",
        severity: "blocker",
        code: "readme_mismatch",
        document: "readme",
        note: NOTE_SENTINEL,
      },
    ]);
    expect(d.review?.evidence?.head).toBe(SCREENED_HEAD);
    expect(d.review?.evidence?.summary.recordings).toBe(4);
    expect(d.history).toEqual([
      {
        id: reviewId,
        head_sha: SCREENED_HEAD,
        anonymous: false,
        state: "reported",
        verdict: "fail",
        created_at: expect.any(String),
        decided_at: expect.any(String),
      },
    ]);
    expect(d.history_truncated).toBe(false);
  });

  test("a reason's cure names the dataset, and its detail is a closed word", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "unreported" });
    const d = await detail(datasetId);
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0].code).toBe("review_did_not_report");
    expect(d.reasons[0].cure).toContain(`nemar admin publish start ${datasetId}`);
    expect(d.reasons[0].cure).not.toContain("<dataset>");
    expect(d.review).toMatchObject({
      state: "unreported",
      stored_verdict: null,
      questions: null,
      evidence: null,
    });
    expect(d.review?.findings).toEqual([]);
    expect(d.review?.summary).toBeNull();
  });

  test("a hard reason is cleared by nothing, and the screen's by its acknowledgment", async () => {
    const blocked = request({ requestStatus: "blocked", blockReason: "min_requirements_failed" });
    const hard = (await detail(blocked.datasetId)).reasons.find(
      (r) => r.code === "request_blocked",
    );
    expect(hard).toMatchObject({
      class: "fail",
      cleared_by: "nothing",
      detail: "min_requirements_failed",
    });
    const ack = request({ status: "review" });
    const screen = (await detail(ack.datasetId)).reasons.find(
      (r) => r.code === "identifier_screen_needs_acknowledgment",
    );
    expect(screen).toMatchObject({ class: "unknown", cleared_by: "screen_acknowledgment" });
  });

  test("history is newest first, capped, and says when it was cut", async () => {
    const { requestId, datasetId } = request();
    const ids: number[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 2; i++) {
      // Distinct heads: one row per (request, head, flag). The last is the screened head.
      const head = i === HISTORY_LIMIT + 1 ? SCREENED_HEAD : (i + 1).toString(16).padStart(40, "a");
      ids.push(seedPublicationReview(db, { requestId, datasetId, head, state: "unreported" }));
    }
    const d = await detail(datasetId);
    expect(d.history).toHaveLength(HISTORY_LIMIT);
    expect(d.history_truncated).toBe(true);
    expect(d.history.map((h) => h.id)).toEqual(ids.slice(-HISTORY_LIMIT).reverse());
    // The review in force is the screened head's row, and it is the newest here.
    expect(d.review?.id).toBe(ids.at(-1));
  });

  test("exactly the cap is not truncated", async () => {
    const { requestId, datasetId } = request();
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      seedPublicationReview(db, {
        requestId,
        datasetId,
        head: (i + 1).toString(16).padStart(40, "b"),
        state: "unreported",
      });
    }
    const d = await detail(datasetId);
    expect(d.history).toHaveLength(HISTORY_LIMIT);
    expect(d.history_truncated).toBe(false);
  });

  test("history keeps the other commits' rows as history, not as the review", async () => {
    const { requestId, datasetId } = request();
    const old = seedPublicationReview(db, {
      requestId,
      datasetId,
      head: OTHER_HEAD,
      state: "reported",
    });
    const d = await detail(datasetId);
    expect(d.review).toBeNull();
    expect(d.outcome).toBe("action_required");
    expect(d.reasons.map((r) => r.code)).toEqual(["review_not_started"]);
    expect(d.history.map((h) => h.id)).toEqual([old]);
  });

  test("the override recorded on a review is shown with the reasons it was given for", async () => {
    const { requestId, datasetId } = request();
    const id = seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const admin = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'reviewadmin'")
      .get() as { id: number };
    db.run(
      `UPDATE publication_reviews SET override_by = ?, override_at = datetime('now'), override_reasons = ? WHERE id = ?`,
      [admin.id, JSON.stringify(["question_failed", "not_a_reason", "text_withheld"]), id],
    );
    const d = await detail(datasetId);
    expect(d.review?.override).toEqual({
      by: admin.id,
      at: expect.any(String),
      reasons: ["question_failed", "text_withheld"],
    });
  });

  test("the detail is for the active request: an older denied one is not it", async () => {
    const { requestId, datasetId } = request({ requestStatus: "denied" });
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: failingReport() });
    const current = request({ datasetId });
    seedPublicationReview(db, { requestId: current.requestId, datasetId, state: "unreported" });
    const d = await detail(datasetId);
    expect(d.request_id).toBe(current.requestId);
    expect(d.history).toHaveLength(1);
    expect(d.outcome).toBe("action_required");
  });

  test("not applicable: no outcome, no review, the words that say why", async () => {
    const { datasetId } = request({ source: "openneuro" });
    const d = await detail(datasetId);
    expect(d).toMatchObject({
      applies: false,
      gate: "n/a",
      outcome: null,
      reasons: [],
      review: null,
    });
    expect(d.description.headline).toBe("Publication review: not applicable");
    expect(d.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
  });

  test("with the review off the detail says so, and every description ends with the standing line", async () => {
    const { requestId, datasetId } = request();
    const off = env({ PUBLICATION_REVIEW_ENABLED: undefined });
    const none = await detail(datasetId, off);
    expect(none).toMatchObject({ enabled: false, gate: "off", review: null });
    expect(none.description.headline).toBe(
      "Publication review: not reviewed (the automated review is off)",
    );
    expect(none.description.next).toBeNull();
    expect(none.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const advice = await detail(datasetId, off);
    expect(advice.description.lines).toContain(
      "The automated review is off, so this review is advice and gates nothing.",
    );
    expect(advice.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
  });

  test("the environment is the Worker's own", async () => {
    const { datasetId } = request();
    expect((await detail(datasetId, env({ ENVIRONMENT: "staging" }))).environment).toBe(
      "non-production",
    );
    expect((await detail(datasetId, env({ ENVIRONMENT: "production" }))).environment).toBe(
      "production",
    );
  });

  test("no nonce, no token and no screen finding is anywhere in the detail", async () => {
    const { requestId, datasetId } = request({ status: "review" });
    seedPublicationReview(db, { requestId, datasetId, state: "unreported", nonce: NONCE_SENTINEL });
    db.run(
      "UPDATE publication_requests SET identifier_screen_nonce = 'SCREEN-NONCE-SENTINEL' WHERE id = ?",
      [requestId],
    );
    const res = await get(`/admin/publish/${datasetId}/review`);
    const text = await res.text();
    expect(text).not.toContain(NONCE_SENTINEL);
    expect(text).not.toContain("SCREEN-NONCE-SENTINEL");
    expect(text.toLowerCase()).not.toContain('"nonce"');
  });

  test("404 with no active request; 400 for a malformed id; 403 for a member; 401 with no key", async () => {
    const published = request({ requestStatus: "published" });
    const none = await get(`/admin/publish/${published.datasetId}/review`);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({
      error: `${published.datasetId} has no active publication request.`,
      code: "not_found",
    });
    expect((await get("/admin/publish/nm000999/review")).status).toBe(404);

    for (const bad of ["nm1", "xx12345", "nm100000", "NM000001", "requests", "abc"]) {
      const res = await get(`/admin/publish/${bad}/review`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That is not a dataset id.", code: "bad_dataset" });
    }

    const { datasetId } = request();
    expect((await get(`/admin/publish/${datasetId}/review`, MEMBER_KEY)).status).toBe(403);
    expect((await app.request(`/admin/publish/${datasetId}/review`, {}, env())).status).toBe(401);
  });

  test("a read that fails answers 500 with a fixed sentence and no SQL", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const failing = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (/^\s*SELECT .*FROM publication_reviews/s.test(sql))
          throw new Error("D1_ERROR: simulated SQL text");
      }),
    });
    const res = await get(`/admin/publish/${datasetId}/review`, ADMIN_KEY, failing);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "The publication review could not be read. Try again.",
      code: "internal",
    });
  });
});

// ============================================================================

describe("the view's own helpers", () => {
  test("the sandbox exemption agrees with the screen's, for every kind of id", () => {
    for (const id of [
      "xx000001",
      "xx099999",
      "xx12345",
      "nm000001",
      "on000001",
      "xxabcdef",
      "XX000001",
      "",
    ]) {
      expect(screenExempt(id)).toBe(isScreenExempt(id));
    }
  });

  test("an override's reasons read from a JSON list or a comma list, and unknown words are dropped", () => {
    expect(overrideReasonsOf(null)).toEqual([]);
    expect(overrideReasonsOf(JSON.stringify(["question_failed", "question_failed", "x"]))).toEqual([
      "question_failed",
    ]);
    expect(overrideReasonsOf("question_failed, text_withheld,bogus")).toEqual([
      "question_failed",
      "text_withheld",
    ]);
    expect(overrideReasonsOf('{"a":1}')).toEqual([]);
    expect(overrideReasonsOf("")).toEqual([]);
  });
});
