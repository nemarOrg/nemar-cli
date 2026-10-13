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
  seedScreenedRequest,
  seedUser,
} from "./helpers/publication-review";

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
