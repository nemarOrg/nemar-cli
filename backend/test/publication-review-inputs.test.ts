/**
 * The publication review's widened inputs and its reproducibility record, Worker side (ADR 0139,
 * decisions 6, 7 and 9; epic #2182, card B4).
 *
 * Through the real routes, on a real bun:sqlite database with every migration, with the harness's
 * GitHub stand-in at the network boundary: `POST /webhooks/publication-review-inputs` answers only
 * the job of a claimed review that has not reported, with the enrichment, the lineage, the note and
 * the screen's coverage counts, and never a finding kind, a finding count or a value; the dispatch
 * payload keeps the review's coordinates only; a stored report carries its record. The rebuilt
 * table is applied on Miniflare's D1 (the `wrangler d1 --local` runtime) with a row in it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { RESOLVER_VERSION } from "../../shared/license-lineage";
import {
  PUBLICATION_PROMPT_VERSION,
  REVIEW_INPUTS,
  parseReviewInputs,
} from "../../shared/publication-review";
import { signPublicationReviewCallbackToken } from "../src/services/github/callback-tokens";
import { coverageOf, readNarrowScreenReport } from "../src/services/publication-review-inputs";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import {
  evidenceFor,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
} from "./helpers/publication-review";
import { CALLBACK_SECRET, PROD_DATASET, createHarness } from "./helpers/publication-review-harness";

const h = createHarness();

const NOTE = "We expanded the README and added the approval number of the ethics board.";

function review(
  o: { claimed?: boolean; anonymous?: boolean; state?: "dispatched" | "reported" } = {},
) {
  const { requestId } = seedScreenedRequest(h.db, {
    datasetId: PROD_DATASET,
    anonymous: o.anonymous,
  });
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId: PROD_DATASET,
    anonymous: o.anonymous,
    state: o.state ?? "dispatched",
    claimed: o.claimed ?? true,
    ...(o.state === "reported"
      ? { report: goodPublicationReport({ evidence: evidenceFor(SCREENED_HEAD, o.anonymous) }) }
      : {}),
  });
  return { requestId, reviewId };
}

async function inputs(reviewId: number, token?: string) {
  const res = await h.app.request(
    "/webhooks/publication-review-inputs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Token": token ?? (await h.tokenFor(reviewId)),
      },
      body: JSON.stringify({ review_id: reviewId, dataset_id: PROD_DATASET }),
    },
    h.env(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Capture what the route logs while `run` runs. */
async function logged<T>(run: () => Promise<T>): Promise<{ value: T; log: string }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) {
    console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  }
  try {
    return { value: await run(), log: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

describe("POST /webhooks/publication-review-inputs", () => {
  test("a claimed review gets its inputs: the note, the lineage, the coverage counts, the enrichment", async () => {
    const { requestId, reviewId } = review();
    h.db.run("UPDATE publication_requests SET resubmission_note = ? WHERE id = ?", [
      NOTE,
      requestId,
    ]);
    h.db.run(
      `UPDATE datasets SET enrichment_json = ?,
              sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.enrichment_updated_at', '2026-11-20 10:00:00')
        WHERE dataset_id = ?`,
      [
        JSON.stringify({
          version: "2.0",
          title: "Resting EEG",
          description: "Sixty-four channels at rest.",
          authors: { "Ada Lovelace": { orcid: "0000-0002-1825-0097" } },
          methods_description: "never shown",
          modalities: ["eeg"],
        }),
        PROD_DATASET,
      ],
    );
    const { value: res, log } = await logged(() => inputs(reviewId));
    expect(res.status).toBe(200);
    // The job's own parser reads exactly what the route answers.
    const body = parseReviewInputs(res.body);
    expect(body.resubmission_note).toBe(NOTE);
    expect(body.lineage).toMatchObject({
      outcome: "no_upstream_declared",
      sources: [],
      resolver_version: RESOLVER_VERSION,
    });
    expect(body.coverage).toEqual({
      source: "screen_v1",
      formats: { edf: { files: 4, read: 4, partial: 0, failed: 0 } },
    });
    // Only the shown fields; the version-2 `authors` become `creators`.
    expect(body.enrichment).toEqual({
      fields: {
        title: "Resting EEG",
        description: "Sixty-four channels at rest.",
        creators: [{ name: "Ada Lovelace", orcid: "0000-0002-1825-0097", affiliations: null }],
      },
      source: "2026-11-20 10:00:00",
    });
    // The lineage read the repository's description and README.
    const reads = h.calls.filter((c) => c.method === "GET" && c.path.includes("/contents/"));
    expect(reads.map((c) => c.path.split("/").pop())).toEqual([
      "dataset_description.json",
      "README.md",
    ]);
    // Nothing the route served is in the log: the route's own line is ids and a fixed word.
    expect(log).toContain(`[publication-review-inputs] review ${reviewId} (${PROD_DATASET}): ok`);
    for (const served of [NOTE, "Resting EEG", "Sixty-four", "Ada Lovelace", "0000-0002"]) {
      expect(log).not.toContain(served);
    }
  });

  test("an anonymous release is shown no creators", async () => {
    const { reviewId } = review({ anonymous: true });
    h.db.run("UPDATE datasets SET enrichment_json = ? WHERE dataset_id = ?", [
      JSON.stringify({ title: "T", creators: [{ name: "Someone" }], authors: { X: {} } }),
      PROD_DATASET,
    ]);
    const res = await inputs(reviewId);
    expect(res.status).toBe(200);
    expect(parseReviewInputs(res.body).enrichment?.fields).toEqual({ title: "T" });
  });

  test("a review that is not claimed is refused, and so is one that reported or a wrong token", async () => {
    const unclaimed = review({ claimed: false });
    expect(await inputs(unclaimed.reviewId)).toEqual({
      status: 409,
      body: { ok: false, reason: "not_claimed" },
    });
    h.db.run("DELETE FROM publication_reviews");
    h.db.run("DELETE FROM publication_requests");
    const claimed = review();
    const forged = await signPublicationReviewCallbackToken(
      { datasetId: PROD_DATASET, reviewId: claimed.reviewId, nonce: "not-the-nonce" },
      CALLBACK_SECRET,
    );
    expect((await inputs(claimed.reviewId, forged)).status).toBe(401);
    // A stored result clears the nonce: a late inputs call finds nothing to verify.
    const token = await h.tokenFor(claimed.reviewId);
    await h.result(claimed.reviewId, { outcome: "error", error: "model_refused" });
    expect((await inputs(claimed.reviewId, token)).status).toBe(401);
  });

  test("a repository that cannot be read ends the answer: 502, never partial inputs", async () => {
    const { reviewId } = review();
    const saved = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
    const dead = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 503 }) });
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
      `http://127.0.0.1:${dead.port}`;
    try {
      const res = await inputs(reviewId);
      expect(res.status).toBe(502);
      expect(Object.keys(res.body)).toEqual(["error"]);
    } finally {
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = saved;
      dead.stop(true);
    }
  }, 60_000);

  test("a stored note that no longer reads by its own rule ends the answer", async () => {
    const { requestId, reviewId } = review();
    h.db.run("UPDATE publication_requests SET resubmission_note = ? WHERE id = ?", [
      "a note\u0007with a bell",
      requestId,
    ]);
    expect((await inputs(reviewId)).status).toBe(502);
  });

  test("a stored enrichment that does not parse ends the answer: never read as no enrichment", async () => {
    const { reviewId } = review();
    h.db.run("UPDATE datasets SET enrichment_json = ? WHERE dataset_id = ?", [
      '{"title": "cut off',
      PROD_DATASET,
    ]);
    const { value: res, log } = await logged(() => inputs(reviewId));
    expect(res.status).toBe(502);
    expect(log).toContain("stored enrichment does not parse");
    expect(log).not.toContain("cut off");
    // And the job reports what the review then is: no inputs, nothing reviewed.
    await h.result(reviewId, { outcome: "error", error: "inputs_unavailable" });
    expect(h.review(reviewId)).toMatchObject({ state: "errored", detail: "inputs_unavailable" });
  });

  test("the coverage section is counts and format words only, and the dispatch payload did not grow", async () => {
    const { requestId, reviewId } = review();
    // A screen report with findings in it: none of their kinds or counts reaches the inputs.
    const report = JSON.parse(
      h.db
        .query("SELECT identifier_screen_report AS r FROM publication_requests WHERE id = ?")
        .get(requestId)?.r as string,
    );
    report.scan.findings_by_kind = { "edf-patient-name": 12 };
    report.scan.edf_bdf_files_by_kind = { "edf-patient-name": 3 };
    report.scan.unscreened_formats = { ".vhdr": 5 };
    h.db.run("UPDATE publication_requests SET identifier_screen_report = ? WHERE id = ?", [
      JSON.stringify(report),
      requestId,
    ]);
    const res = await inputs(reviewId);
    const text = JSON.stringify(res.body.coverage);
    expect(text).not.toContain("patient");
    expect(text).not.toContain("12");
    expect(parseReviewInputs(res.body).coverage.formats).toEqual({
      ".vhdr": { files: 5, read: 0, partial: 0, failed: 0 },
      edf: { files: 4, read: 4, partial: 0, failed: 0 },
    });

    // The dispatch the Worker sends a review is exactly the coordinates it always was.
    h.db.run("DELETE FROM publication_reviews");
    h.db.run("DELETE FROM publication_requests");
    const { requestId: pendingId } = seedScreenedRequest(h.db, {
      datasetId: PROD_DATASET,
      status: "pending",
    });
    await h.screenResult(pendingId, PROD_DATASET);
    const [dispatch] = h.dispatches();
    expect(Object.keys(dispatch?.client_payload ?? {}).sort()).toEqual([
      "anonymous",
      "callback_token",
      "dataset_id",
      "environment",
      "head_sha",
      "request_id",
      "review_id",
    ]);
  });
});

describe("the previous denial, as codes", () => {
  /** A denied earlier request of the dataset, then the current request linked to it. */
  function linked(o: { deniedReason: string; withdrawn?: boolean; automated?: boolean }) {
    const { requestId, reviewId } = review();
    const user = h.requestRow(requestId).requested_by as number;
    const previous = h.db
      .query(
        `INSERT INTO publication_requests (dataset_id, requested_by, status, denied_reason, withdrawn_at)
         VALUES (?, ?, 'denied', ?, ?) RETURNING id`,
      )
      .get(PROD_DATASET, user, o.deniedReason, o.withdrawn ? "2026-11-20 10:00:00" : null) as {
      id: number;
    };
    h.db.run("UPDATE publication_requests SET previous_request_id = ? WHERE id = ?", [
      previous.id,
      requestId,
    ]);
    if (o.automated) {
      h.db.run(
        `INSERT INTO audit_log (action, resource_type, resource_id, details)
         VALUES ('auto_deny', 'dataset', ?, ?)`,
        [PROD_DATASET, JSON.stringify({ request_id: previous.id })],
      );
    }
    return reviewId;
  }

  test("an automated denial gives its codes and says it was automated", async () => {
    const reviewId = linked({
      deniedReason: '["question_failed","version_malformed"]',
      automated: true,
    });
    const res = await inputs(reviewId);
    expect(parseReviewInputs(res.body).previous_denial).toEqual({
      automated: true,
      reasons: ["question_failed", "version_malformed"],
    });
  });

  test("an administrator's words give no codes and are never served", async () => {
    const words = "The README does not describe the recordings";
    const reviewId = linked({ deniedReason: words });
    const res = await inputs(reviewId);
    expect(parseReviewInputs(res.body).previous_denial).toEqual({ automated: false, reasons: [] });
    expect(JSON.stringify(res.body)).not.toContain("README does not");
  });

  test("a denial that named a screen code serves none of it", async () => {
    const reviewId = linked({
      deniedReason: '["identifier_screen_blocks","version_malformed"]',
      automated: true,
    });
    const res = await inputs(reviewId);
    expect(parseReviewInputs(res.body).previous_denial).toEqual({
      automated: true,
      reasons: ["version_malformed"],
    });
    expect(JSON.stringify(res.body)).not.toContain("identifier_screen");
  });

  test("a withdrawal is not a denial, and a first request has none", async () => {
    const reviewId = linked({ deniedReason: "question_failed", withdrawn: true });
    expect(parseReviewInputs((await inputs(reviewId)).body).previous_denial).toBeNull();
    h.db.run("UPDATE publication_requests SET previous_request_id = NULL");
    expect(parseReviewInputs((await inputs(reviewId)).body).previous_denial).toBeNull();
  });
});

describe("the coverage counts, read from either screen report version", () => {
  const v2 = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 2,
      scanner: "identifier-scan@abcdef1",
      head: SCREENED_HEAD,
      scan: {
        files: { total: 9, edf_bdf: 2, header_read: 2, header_read_failed: 0 },
        read_by_format: {
          edf: { files: 2, read: 2, partial: 0, failed: 0 },
          brainvision: { files: 5, read: 3, partial: 1, failed: 1 },
        },
        readers: { edf: "1.2.0", brainvision: "0.4.1" },
        findings_by_kind: { "edf-patient-name": 2 },
        ...over,
      },
    });

  test("version 2 is read per reader, and its readers are the record's", () => {
    expect(coverageOf(readNarrowScreenReport(v2()), SCREENED_HEAD)).toEqual({
      source: "screen_v2",
      formats: {
        brainvision: { files: 5, read: 3, partial: 1, failed: 1 },
        edf: { files: 2, read: 2, partial: 0, failed: 0 },
      },
    });
    expect(readNarrowScreenReport(v2())?.readers).toEqual({ edf: "1.2.0", brainvision: "0.4.1" });
  });

  test("a report of another commit, a tally that adds up to more than its files, or none, is no counts", () => {
    expect(coverageOf(readNarrowScreenReport(v2()), "e".repeat(40)).source).toBe("none");
    expect(coverageOf(null, SCREENED_HEAD).source).toBe("none");
    const bad = v2({ read_by_format: { edf: { files: 1, read: 2, partial: 0, failed: 0 } } });
    // The version-2 tallies are refused whole; the version-1 counts still stand.
    expect(coverageOf(readNarrowScreenReport(bad), SCREENED_HEAD).source).toBe("screen_v1");
    expect(readNarrowScreenReport("not json")).toBeNull();
  });
});

describe("the reproducibility record is stored with the report", () => {
  test("a version-2 report stores its record, and the scanner is the Worker's own copy", async () => {
    const { reviewId } = review();
    const inputsStates = Object.fromEntries(REVIEW_INPUTS.map((i) => [i, "absent"]));
    const digest = "ab".repeat(32);
    const body = goodPublicationReport({
      v: 2,
      evidence: { ...evidenceFor(SCREENED_HEAD), inputs: inputsStates, lineage: null },
      note_answer: "not_asked",
      record: {
        prompt_version: PUBLICATION_PROMPT_VERSION,
        models: [{ model: "claude-haiku-5-5", effort: "high" }],
        input_digest: digest,
        resolver_version: RESOLVER_VERSION,
        enrichment_source: "2026-11-20 10:00:00",
      },
    });
    const res = await h.result(reviewId, { outcome: "reported", report: body });
    expect(res.status).toBe(200);
    expect(h.review(reviewId)).toMatchObject({
      state: "reported",
      scanner_id: "identifier-scan@abcdef1",
      reader_versions: null,
      resolver_version: RESOLVER_VERSION,
      models: JSON.stringify([{ model: "claude-haiku-5-5", effort: "high" }]),
      prompt_version: PUBLICATION_PROMPT_VERSION,
      input_digest: digest,
      enrichment_source: "2026-11-20 10:00:00",
    });
  });

  test("a run error stores no record", async () => {
    const { reviewId } = review();
    await h.result(reviewId, { outcome: "error", error: "inputs_unavailable" });
    expect(h.review(reviewId)).toMatchObject({
      state: "errored",
      detail: "inputs_unavailable",
      scanner_id: null,
      models: null,
      input_digest: null,
    });
  });
});

describe("migration 0152 on Miniflare's D1", () => {
  let mf: Miniflare;
  beforeAll(() => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
      compatibilityDate: "2024-12-01",
      d1Databases: ["DB1"],
    });
  });
  afterAll(async () => {
    await mf?.dispose();
  });

  test("the rebuild keeps every row, takes the new word and holds the record to a reported row", async () => {
    const d1 = (await mf.getD1Database("DB1")) as unknown as D1Database;
    const files = migrationFiles();
    const at = files.indexOf("0152_publication_review_record.sql");
    expect(at).toBeGreaterThan(0);
    await applyMigrations(d1, files.slice(0, at));
    await d1
      .prepare(
        `INSERT INTO publication_reviews (id, request_id, dataset_id, head_sha, anonymous,
           requested_by, state, verdict, report, decided_at)
         VALUES (7, 1, 'nm000471', ?1, 0, 1, 'reported', 'pass', '{}', datetime('now'))`,
      )
      .bind(SCREENED_HEAD)
      .run();
    await applyMigrations(d1, files.slice(at));
    const kept = await d1.prepare("SELECT * FROM publication_reviews WHERE id = 7").first();
    expect(kept).toMatchObject({ id: 7, state: "reported", verdict: "pass", input_digest: null });
    await d1
      .prepare(
        `INSERT INTO publication_reviews (request_id, dataset_id, head_sha, anonymous,
           requested_by, state, detail, decided_at)
         VALUES (2, 'nm000471', ?1, 0, 1, 'errored', 'inputs_unavailable', datetime('now'))`,
      )
      .bind(SCREENED_HEAD)
      .run();
    // A record on a row that did not report is refused.
    await expect(
      d1
        .prepare(
          `INSERT INTO publication_reviews (request_id, dataset_id, head_sha, anonymous,
             requested_by, state, detail, decided_at, input_digest)
           VALUES (3, 'nm000471', ?1, 0, 1, 'errored', 'model_refused', datetime('now'), ?2)`,
        )
        .bind(SCREENED_HEAD, "a".repeat(64))
        .run(),
    ).rejects.toThrow();
    // A new id continues after the kept one.
    const next = await d1
      .prepare("SELECT MAX(id) AS id FROM publication_reviews")
      .first<{ id: number }>();
    expect(next?.id).toBeGreaterThan(7);
  });
});
