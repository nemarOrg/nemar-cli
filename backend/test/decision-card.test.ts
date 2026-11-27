/**
 * The administrator's decision card through the real routes (ADR 0142, decisions 3 and 4; epic
 * #2449, phase 4), on a real bun:sqlite database with every migration and the harness's GitHub
 * stand-in at the network boundary:
 *
 *  - the inputs serve writes the snapshot of what it served (`served_metadata`, migration 0163) in
 *    the statement that stamps the serve, and the card reads the fields as the review read them,
 *    whatever the enrichment says afterwards;
 *  - a review from before the snapshot shows the fields NEMAR holds now, marked not as reviewed,
 *    with the description read at the reviewed commit;
 *  - a review whose lineage was unresolved gets a lineage resolved again for the card, beside the
 *    review's own, and the card suggests reviewing again when it resolves;
 *  - `GET /admin/publish/:id/review` carries the card as `decision_card` beside the detail.
 *
 * Mutation checks (each applied, run, and restored from a copy): drop `served_metadata = ?` from
 * the serve's UPDATE ("the serve keeps what it served") and drop the `needsFresh` resolution
 * ("an unresolved lineage is resolved again for the card") each turn a named test red, and so does
 * reading every head check as current ("a commit pushed after the screen is stale").
 */

import { describe, expect, test } from "bun:test";
import type { DecisionCard } from "../../shared/contract/decision-card";
import { parseServedMetadata } from "../src/services/decision-card";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import {
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
  v3PublicationReport,
} from "./helpers/publication-review";
import { PROD_DATASET, createHarness } from "./helpers/publication-review-harness";

const h = createHarness();

const ADMIN_KEY = "decision-card-admin-key-0123456789abcdef0123456789";

const ENRICHMENT = {
  version: "2.0",
  title: "Resting EEG in sixty adults",
  description: "Eyes-open and eyes-closed resting EEG, recorded to study alpha power.",
  license: "CC-BY-4.0",
  keywords: [{ term: "EEG" }, { term: "resting state" }],
  funding_references: [{ funder_name: "NIH", award_number: "R01-1" }],
  authors: { "Ada Lovelace": { orcid: "0000-0002-1825-0097" } },
  methods_description: "never on the card",
};

function setEnrichment(doc: Record<string, unknown>): void {
  h.db.run(
    `UPDATE datasets SET enrichment_json = ?,
            sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.enrichment_updated_at', '2026-11-20 10:00:00')
      WHERE dataset_id = ?`,
    [JSON.stringify(doc), PROD_DATASET],
  );
}

async function serve(reviewId: number) {
  const res = await h.app.request(
    "/webhooks/publication-review-inputs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Token": await h.tokenFor(reviewId),
      },
      body: JSON.stringify({ review_id: reviewId, dataset_id: PROD_DATASET }),
    },
    h.env(),
  );
  expect(res.status).toBe(200);
}

async function card(): Promise<DecisionCard> {
  await seedUser(h.db, "decisioncardadmin", "admin", ADMIN_KEY).catch(() => 0);
  const res = await h.app.request(
    `/admin/publish/${PROD_DATASET}/review`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    h.env(),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.dataset_id).toBe(PROD_DATASET);
  expect(body.decision_card).not.toBeNull();
  return body.decision_card as DecisionCard;
}

function servedColumn(reviewId: number): unknown {
  return (h.review(reviewId) as { served_metadata?: unknown }).served_metadata;
}

describe("the snapshot of what the review was served", () => {
  test("the serve keeps what it served, and the card shows it after the enrichment changes", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    setEnrichment(ENRICHMENT);
    const reviewId = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "dispatched",
      claimed: true,
    });
    expect(servedColumn(reviewId)).toBeNull();
    await serve(reviewId);
    const snapshot = parseServedMetadata(servedColumn(reviewId));
    expect(snapshot).toEqual({
      v: 1,
      enrichment: {
        title: "Resting EEG in sixty adults",
        description: "Eyes-open and eyes-closed resting EEG, recorded to study alpha power.",
        description_cut: false,
        license: "CC-BY-4.0",
        creators: ["Ada Lovelace"],
        keywords: ["EEG", "resting state"],
        funding: ["NIH (R01-1)"],
      },
      enrichment_source: "2026-11-20 10:00:00",
      // The stand-in's description at the reviewed commit.
      dataset_description: {
        name: "A sufficiently descriptive dataset title",
        license: null,
        authors: ["Ada Lovelace"],
      },
      lineage: {
        outcome: "no_upstream_declared",
        credited: false,
        resolved_at: expect.any(String),
        declared_licenses: [],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("never on the card");

    const posted = await h.result(reviewId, {
      outcome: "reported",
      report: v3PublicationReport({
        lineage: { outcome: "compatible", credited: false, resolved_at: "2026-11-27 12:00:00" },
      }),
    });
    expect(posted.status).toBe(200);
    // The enrichment changes after the review read it; the card keeps the reviewed words.
    setEnrichment({ ...ENRICHMENT, title: "A title written later" });
    const c = await card();
    expect(c.metadata.as_reviewed).toBe(true);
    expect(c.metadata.note).toBeNull();
    expect(c.metadata.enrichment?.title).toBe("Resting EEG in sixty adults");
    expect(c.metadata.version).toBe("1.0.0");
    expect(c.license.license_file).toEqual({
      state: "matches",
      spdx: "CC-BY-4.0",
      additions: false,
      expression: null,
    });
    expect(c.license.lineage).toMatchObject({
      outcome: "compatible",
      resolved_at: "2026-11-27 12:00:00",
    });
    expect(c.license.fresh_lineage).toBeNull();
    expect(c.identifier_screen.headline.length).toBeGreaterThan(0);
    expect(c.next_action.action).toBe("approve");
  });

  test("an anonymous release's snapshot holds no creators and no Authors", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET, anonymous: true });
    setEnrichment(ENRICHMENT);
    const reviewId = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      anonymous: true,
      state: "dispatched",
      claimed: true,
    });
    await serve(reviewId);
    const snapshot = parseServedMetadata(servedColumn(reviewId));
    expect(snapshot?.enrichment?.creators).toEqual([]);
    expect(snapshot?.dataset_description?.authors).toEqual([]);
    expect(String(servedColumn(reviewId))).not.toContain("Ada Lovelace");
  });
});

describe("a review from before the snapshot", () => {
  test("shows what NEMAR holds now, says it is not as reviewed, and reads the description at the commit", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    setEnrichment(ENRICHMENT);
    seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
      report: v3PublicationReport(),
    });
    h.calls = [];
    const c = await card();
    expect(c.metadata.as_reviewed).toBe(false);
    expect(c.metadata.note).toContain("Not as reviewed");
    expect(c.metadata.enrichment?.title).toBe("Resting EEG in sixty adults");
    expect(c.metadata.dataset_description?.name).toBe("A sufficiently descriptive dataset title");
    const reads = h.calls.filter((r) => r.method === "GET" && r.path.includes("/contents/"));
    expect(reads.map((r) => r.path.split("/").pop())).toEqual(["dataset_description.json"]);
  });
});

describe("the lineage resolved again for the card", () => {
  test("an unresolved lineage is resolved again for the card, and resolving suggests a new review", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      head: SCREENED_HEAD,
      state: "reported",
      report: v3PublicationReport({
        lineage: { outcome: "unresolved", credited: false, resolved_at: "2026-11-20 09:00:00" },
      }),
    });
    h.calls = [];
    const c = await card();
    // The review's own, and the card's, each with its time.
    expect(c.license.lineage).toMatchObject({
      outcome: "unresolved",
      resolved_at: "2026-11-20 09:00:00",
    });
    expect(c.license.fresh_lineage?.outcome).toBe("no_upstream_declared");
    expect(Number.isNaN(Date.parse(c.license.fresh_lineage?.resolved_at ?? ""))).toBe(false);
    // The review's unresolved still stands: the cue is never raised by the fresher lineage.
    expect(c.license.cue).toBe("amber");
    expect(c.next_action.action).toBe("review_again");
    const reads = h.calls.filter((r) => r.method === "GET" && r.path.includes("/contents/"));
    expect(reads.map((r) => r.path.split("/").pop())).toEqual([
      "dataset_description.json",
      "README.md",
    ]);
  });
});

describe("the approval's own gates on the card", () => {
  test("a commit pushed after the screen is stale: the card never suggests approve", async () => {
    const pushed = "e".repeat(40);
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET, head: pushed });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      head: pushed,
      state: "reported",
      report: v3PublicationReport({ head: pushed }),
    });
    const c = await card();
    expect(c.identifier_screen.head).toBe("stale");
    expect(c.identifier_screen.head_line).toContain("no longer the repository's main branch");
    expect(c.next_action.action).toBe("rerun_screen");
  });

  test("an approval run holding the request: the card says wait, never approve", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
      report: v3PublicationReport(),
    });
    h.db.run(
      `UPDATE publication_requests SET status = 'approving', approval_requested_by = 1,
              approval_dispatched_at = datetime('now') WHERE id = ?`,
      [requestId],
    );
    const c = await card();
    expect(c.identifier_screen.head).toBe("current");
    expect(c.next_action.action).toBe("wait");
  });
});
