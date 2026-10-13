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
import { PUBLICATION_STEPS } from "../../shared/publication-steps";
import { adminRoutes } from "../src/routes/admin";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import {
  type SeedScreenedRequest,
  failingReport,
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
