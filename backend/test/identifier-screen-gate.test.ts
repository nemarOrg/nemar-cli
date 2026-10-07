/**
 * The identifier screen as a hard gate on approval (epic #1610, phase 4).
 *
 * `screenGate` (shared/identifier-screen-report.ts) decides what each state
 * allows; these tests drive the two places an approval starts, the orchestrator
 * (`POST /admin/publish/:id/approve`) and the web dispatch
 * (`POST /admin/publish/:id/approve-dispatch`), plus the block on findings, the
 * depositor's notice and the admin re-run route.
 *
 * Approvals use the golden resume path of publication-approve-golden.test.ts:
 * every step done but the two logged no-ops, so a run the gate lets through
 * reaches `published` without touching an external service, and a refused one
 * provably never marked the request `approving`. The request rows are
 * `requested`, and the runs pass `resume: true` on purpose: a resume of a
 * request that never started is how the import pipeline retries, and it must
 * not be a way around the gate.
 *
 * Real engine only: bun:sqlite behind realD1, the real auth middleware and
 * routes, a Bun.serve stand-in for api.github.com answering the gate's one read
 * (`git/ref/heads/main`) and recording dispatches, and the Resend capture.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { PUBLICATION_STEPS } from "../../shared/publication-steps.js";
import { adminRoutes } from "../src/routes/admin";
import { datasetRoutes } from "../src/routes/datasets";
import webhooks from "../src/routes/webhooks";
import { signIdentifierScreenCallbackToken } from "../src/services/github";
import {
  MAX_SCREENED_UNBLOCKS_PER_SWEEP,
  sweepBlockedBidsValidationRequests,
} from "../src/services/publication-sweep";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { SCREENED_HEAD, cleanScreenReportBody, markScreen } from "./helpers/identifier-screen";
import { type CapturedEmail, type ResendSendBody, asSend, withFakeResend } from "./helpers/resend";

const SECRET = "gate-test-secret";
const ADMIN_KEY = "gate-admin-key-0123456789abcdef0123456789abcdef";
const OWNER_KEY = "gate-owner-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000460";
const ADMIN_EMAIL = "gateadmin@example.org";
const OWNER_EMAIL = "gateowner@example.org";
const MOVED_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const DONE = PUBLICATION_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");

let server: Server;
let mainHead = SCREENED_HEAD;
let refStatus = 200;
let refReads = 0;
let dispatches: { event_type: string; client_payload: Record<string, unknown> }[] = [];
let bidsConclusion = "success";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let envOverrides: Partial<Bindings> = {};
let adminId: number;
let ownerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (req.method === "GET" && /\/git\/ref\/heads\/main$/.test(p)) {
        refReads++;
        if (refStatus !== 200) return new Response("no", { status: refStatus });
        return Response.json({ object: { sha: mainHead } });
      }
      if (req.method === "POST" && p === "/repos/nemarDatasets/.github/dispatches") {
        dispatches.push(await req.json());
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
      if (/\/contents\/dataset_description\.json$/.test(p)) {
        return Response.json({
          encoding: "base64",
          content: btoa(
            JSON.stringify({
              Name: "A sufficiently descriptive dataset title",
              Authors: ["Ada Lovelace"],
              EthicsApprovals: ["Approved by an institutional review board"],
            }),
          ),
        });
      }
      if (/\/contents\/README\.md$/.test(p)) {
        return Response.json({ encoding: "base64", content: btoa("# README") });
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
  mainHead = SCREENED_HEAD;
  refStatus = 200;
  refReads = 0;
  dispatches = [];
  bidsConclusion = "success";
  envOverrides = {};
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_gate_test",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...envOverrides,
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

function seedDataset(id: string, opts: { exemplar?: boolean } = {}) {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           github_repo, is_exemplar)
     VALUES (?, ?, ?, 'active', 'private', 0, ?, ?)`,
    [
      id,
      `A sufficiently descriptive title for ${id}`,
      ownerId,
      `nemarDatasets/${id}`,
      opts.exemplar ? 1 : 0,
    ],
  );
}

/** A request with every step done but the two no-ops, in `status`. */
/** Validation only: an approval that stopped here changed nothing yet. */
const PRE_PUBLICATION = ["ci_check", "enrichment_check"];

function seedRequest(
  opts: {
    status?: string;
    dataset?: string;
    blockReason?: string | null;
    steps?: readonly string[];
  } = {},
): number {
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, block_reason, requested_by, requested_at, updated_at, steps_completed)
     VALUES (?, ?, ?, ?, datetime('now', '-3 hours'), datetime('now', '-3 hours'), ?)`,
    [
      opts.dataset ?? DATASET,
      opts.status ?? "requested",
      opts.blockReason ?? null,
      ownerId,
      JSON.stringify(opts.steps ?? DONE),
    ],
  );
  return db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/datasets", datasetRoutes);
  app.route("/webhooks", webhooks);
  adminId = await seedUser("gateadmin", "admin", ADMIN_EMAIL, ADMIN_KEY);
  ownerId = await seedUser("gateowner", "member", OWNER_EMAIL, OWNER_KEY);
  seedDataset(DATASET);
});

function approve(
  body: Record<string, unknown>,
  dataset = DATASET,
  bindings: Bindings = env(),
): Promise<Response> {
  return app.request(
    `/admin/publish/${dataset}/approve`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function dispatchApproval(body?: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/admin/publish/${DATASET}/approve-dispatch`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env(),
  );
}

function requestRow(id: number) {
  return db
    .query<
      {
        status: string;
        block_reason: string | null;
        approval_requested_by: number | null;
        identifier_screen_status: string | null;
        identifier_screen_ack_by: number | null;
        identifier_screen_ack_reason: string | null;
        identifier_screen_ack_at: string | null;
        identifier_screen_nonce: string | null;
      },
      [number]
    >(
      `SELECT status, block_reason, approval_requested_by, identifier_screen_status,
              identifier_screen_ack_by, identifier_screen_ack_reason, identifier_screen_ack_at,
              identifier_screen_nonce
         FROM publication_requests WHERE id = ?`,
    )
    .get(id);
}

async function refusal(res: Response) {
  return (await res.json()) as { error: string; gate: string; headline: string; message: string };
}

function sendsTo(calls: CapturedEmail[], to: string): ResendSendBody[] {
  return calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((b) => b.to.includes(to));
}

const REASON = "Looked at every flagged file; the free text is a device serial.";

// ============================================================================

describe("the orchestrator's gate (POST /approve)", () => {
  test("a clean screen of the current main passes, and the run completes", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET);
    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    expect(requestRow(id)?.status).toBe("published");
    expect(refReads).toBe(1);
  });

  for (const [label, status, gate] of [
    ["no screen at all (a request that predates it)", null, "rerun"],
    ["a stored value that is not a state", "CLEAN", "rerun"],
    ["a screen still running", "pending", "wait"],
    ["a screen that did not run", "error", "rerun"],
    ["a screen that did not report", "unreported", "rerun"],
    ["direct identifiers", "direct-identifiers", "blocks"],
    ["a screen that needs review, without a reason", "review", "acknowledge"],
    ["recordings not screened, without a reason", "not-screened", "acknowledge"],
  ] as const) {
    test(`refuses ${label}, and the request never starts approving`, async () => {
      const id = seedRequest();
      if (status !== null) {
        db.run("UPDATE publication_requests SET identifier_screen_status = ? WHERE id = ?", [
          status,
          id,
        ]);
      }
      const res = await approve({ resume: true });
      expect(res.status).toBe(409);
      const body = await refusal(res);
      expect(body.error).toBe("identifier_screen_not_clear");
      expect(body.gate).toBe(gate);
      expect(body.headline.startsWith("Identifier screen:")).toBe(true);
      expect(requestRow(id)?.status).toBe("requested");
    });
  }

  test("direct identifiers are refused even with an acknowledgment", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET, { status: "direct-identifiers" });
    const res = await approve({ resume: true, acknowledge_identifier_screen: REASON });
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("blocks");
    expect(requestRow(id)?.identifier_screen_ack_at).toBeNull();
  });

  test("a screen that needs review passes with a reason, recorded and audited", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET, { status: "review" });
    const res = await approve({ resume: true, acknowledge_identifier_screen: `  ${REASON}  ` });
    expect(res.status).toBe(200);
    const row = requestRow(id);
    expect(row?.status).toBe("published");
    expect(row?.identifier_screen_ack_by).toBe(adminId);
    expect(row?.identifier_screen_ack_reason).toBe(REASON);
    expect(row?.identifier_screen_ack_at).not.toBeNull();
    const audit = db
      .query<{ user_id: number; resource_id: string; details: string }, []>(
        "SELECT user_id, resource_id, details FROM audit_log WHERE action = 'identifier_screen_acknowledged'",
      )
      .get();
    expect(audit?.user_id).toBe(adminId);
    expect(audit?.resource_id).toBe(DATASET);
    expect(JSON.parse(audit?.details ?? "{}")).toEqual({
      request_id: id,
      screen_state: "review",
      reason: REASON,
    });
  });

  test("acquisition dates alone pass with no reason, and none is recorded (ADR 0090)", async () => {
    // The warning is words beside the counts: a dataset with dates only is as clear as it was.
    const id = seedRequest();
    markScreen(db, id, DATASET, {
      status: "dates-only",
      findings: { "edf-startdate": 3, "acq-time-dated": 1 },
    });
    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    const row = requestRow(id);
    expect(row?.status).toBe("published");
    expect(row?.identifier_screen_ack_by).toBeNull();
    expect(row?.identifier_screen_ack_reason).toBeNull();
    expect(row?.identifier_screen_ack_at).toBeNull();
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'identifier_screen_acknowledged'",
        )
        .get()?.n,
    ).toBe(0);
  });

  test("dates beside a review finding still need the reason they needed before", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET, {
      status: "review",
      findings: { "tooling-debris": 1, "edf-startdate": 3 },
    });
    const refused = await approve({ resume: true });
    expect(refused.status).toBe(409);
    expect((await refusal(refused)).gate).toBe("acknowledge");
    expect(requestRow(id)?.status).toBe("requested");
    const passed = await approve({ resume: true, acknowledge_identifier_screen: REASON });
    expect(passed.status).toBe(200);
    expect(requestRow(id)?.identifier_screen_ack_reason).toBe(REASON);
  });

  test("dates beside a direct identifier are still refused, with or without a reason", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET, {
      status: "direct-identifiers",
      findings: { "edf-patient-name": 4, "edf-startdate": 4 },
    });
    for (const body of [
      { resume: true },
      { resume: true, acknowledge_identifier_screen: REASON },
    ]) {
      const res = await approve(body);
      expect(res.status).toBe(409);
      expect((await refusal(res)).gate).toBe("blocks");
    }
    expect(requestRow(id)?.status).toBe("requested");
  });

  test("an acknowledgment attaches only to the result it was given for", async () => {
    // The screen's result changes between the gate's read and the write that
    // records the reason (a re-run lands): the reason must not attach to it.
    const id = seedRequest();
    markScreen(db, id, DATASET, { status: "review" });
    const racing = {
      ...env(),
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql.includes("SET identifier_screen_ack_by = ?")) {
          markScreen(db, id, DATASET, { status: "direct-identifiers" });
        }
      }),
    } as Bindings;
    const res = await approve(
      { resume: true, acknowledge_identifier_screen: REASON },
      DATASET,
      racing,
    );
    expect(res.status).toBe(409);
    const row = requestRow(id);
    expect(row?.identifier_screen_ack_at).toBeNull();
    expect(row?.status).toBe("requested");
  });

  test("an acknowledgment outside 10 to 500 characters is refused before the gate", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET, { status: "review" });
    for (const reason of ["too short", "          x", "x".repeat(501)]) {
      const res = await approve({ resume: true, acknowledge_identifier_screen: reason });
      expect(res.status).toBe(400);
    }
    expect(requestRow(id)?.identifier_screen_ack_at).toBeNull();
  });

  test("a clean verdict about a commit main has moved past is refused as stale", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET);
    mainHead = MOVED_HEAD;
    const res = await approve({ resume: true });
    expect(res.status).toBe(409);
    const body = await refusal(res);
    expect(body.gate).toBe("stale");
    expect(body.message).toContain(SCREENED_HEAD.slice(0, 12));
    expect(body.message).toContain(MOVED_HEAD.slice(0, 12));
    expect(requestRow(id)?.status).toBe("requested");
  });

  test("an acknowledged screen of a stale commit is refused too, and the reason is not recorded", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET, { status: "review" });
    mainHead = MOVED_HEAD;
    const res = await approve({ resume: true, acknowledge_identifier_screen: REASON });
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("stale");
    expect(requestRow(id)?.identifier_screen_ack_at).toBeNull();
  });

  test("fails closed when main cannot be read", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET);
    refStatus = 401;
    const res = await approve({ resume: true });
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("unverified");
    expect(requestRow(id)?.status).toBe("requested");
  });

  test("fails closed with no GitHub credential", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET);
    envOverrides = { GITHUB_ADMIN_PAT: undefined } as Partial<Bindings>;
    const res = await approve({ resume: true });
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("unverified");
  });

  test("fails closed on a clean status whose stored report is unreadable", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET);
    db.run("UPDATE publication_requests SET identifier_screen_report = '{oops' WHERE id = ?", [id]);
    const res = await approve({ resume: true });
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("unverified");
  });

  test("a resumed run that has started publishing is not re-gated", async () => {
    // The CLI's S3 Object Lock batches and its retries all resume an approving
    // request; main has moved by then (the run commits the README badge). The
    // fixture has every step done but the two no-ops, s3_public_read included.
    const id = seedRequest({ status: "approving", steps: DONE });
    mainHead = MOVED_HEAD;
    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    expect(requestRow(id)?.status).toBe("published");
    expect(refReads).toBe(0);
  });

  test("a run stopped right after its first mutation resumes ungated, into its next step", async () => {
    // s3_public_read is the first step that changes anything; once it ran the
    // data is public and the run must be able to finish. Its next step,
    // repo_public, fails on the stand-in's 404, which is how this test sees that
    // the run got past the gate without reading main.
    const id = seedRequest({
      status: "approving",
      steps: [...PRE_PUBLICATION, "s3_public_read"],
    });
    mainHead = MOVED_HEAD;
    const res = await approve({ resume: true });
    expect(refReads).toBe(0);
    expect(((await res.json()) as { step?: string }).step).toBe("repo_public");
    expect(requestRow(id)?.status).toBe("approving");
  });

  test("a resumed run that stopped before publishing is gated like a fresh one", async () => {
    // A ci_check failure leaves the row `approving` with nothing changed; the
    // depositor then pushes. The retry must see the new main.
    const id = seedRequest({ status: "approving", steps: PRE_PUBLICATION });
    markScreen(db, id, DATASET);
    mainHead = MOVED_HEAD;
    const res = await approve({ resume: true });
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("stale");
    expect(refReads).toBe(1);
  });

  test("a resumed run that stopped before publishing, with no screen, is refused", async () => {
    const id = seedRequest({ status: "approving", steps: PRE_PUBLICATION });
    const res = await approve({ resume: true });
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("rerun");
    expect(requestRow(id)?.status).toBe("approving");
  });

  test("an acknowledgment recorded by one admin does not carry to another", async () => {
    const OTHER_KEY = "gate-admin2-key-0123456789abcdef0123456789abcdef";
    await seedUser("gateadmin2", "admin", "gateadmin2@example.org", OTHER_KEY);
    const id = seedRequest();
    markScreen(db, id, DATASET, { status: "review" });
    db.run(
      `UPDATE publication_requests SET identifier_screen_ack_by = ?, identifier_screen_ack_at = datetime('now'),
              identifier_screen_ack_reason = ? WHERE id = ?`,
      [adminId, REASON, id],
    );
    const asOther = await app.request(
      `/admin/publish/${DATASET}/approve`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OTHER_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      },
      env(),
    );
    expect(asOther.status).toBe(409);
    expect((await refusal(asOther)).gate).toBe("acknowledge");
    // The admin who gave the reason passes on it.
    const asSelf = await approve({ resume: true });
    expect(asSelf.status).toBe(200);
  });

  test("a sandbox exemplar is not gated", async () => {
    const XX = "xx099960";
    seedDataset(XX, { exemplar: true });
    envOverrides = { ENVIRONMENT: "staging" } as Partial<Bindings>;
    const id = seedRequest({ dataset: XX });
    const res = await approve({ resume: true, sandbox: true }, XX);
    expect(res.status).toBe(200);
    expect(requestRow(id)?.status).toBe("published");
    expect(refReads).toBe(0);
  });
});

describe("the web dispatch's gate (POST /approve-dispatch)", () => {
  test("refuses a request with no screen before it claims anything or dispatches", async () => {
    const id = seedRequest();
    const res = await dispatchApproval();
    expect(res.status).toBe(409);
    const body = await refusal(res);
    expect(body.error).toBe("identifier_screen_not_clear");
    // Refused on the state, before any GitHub read: the head check would have
    // said "unverified" instead.
    expect(body.gate).toBe("rerun");
    expect(refReads).toBe(0);
    expect(requestRow(id)?.approval_requested_by).toBeNull();
    expect(dispatches).toHaveLength(0);
  });

  test("a stale screen is refused after the claim, and the claim is released", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET);
    mainHead = MOVED_HEAD;
    const res = await dispatchApproval();
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("stale");
    expect(requestRow(id)?.approval_requested_by).toBeNull();
    expect(dispatches).toHaveLength(0);
  });

  test("an acknowledged review is recorded for the clicker and carries to the executor's run", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET, { status: "review" });
    const res = await dispatchApproval({ acknowledge_identifier_screen: REASON });
    expect(res.status).toBe(202);
    expect(dispatches).toHaveLength(1);
    expect(requestRow(id)?.identifier_screen_ack_by).toBe(adminId);
    // The executor calls /approve without a reason: the recorded one stands.
    const run = await approve({ resume: true });
    expect(run.status).toBe(200);
    expect(requestRow(id)?.status).toBe("published");
  });

  test("a review without a reason is refused and nothing is claimed", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET, { status: "review" });
    const res = await dispatchApproval();
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("acknowledge");
    expect(requestRow(id)?.approval_requested_by).toBeNull();
  });

  test("a malformed acknowledgment is a 400", async () => {
    seedRequest();
    const res = await dispatchApproval({ acknowledge_identifier_screen: "short" });
    expect(res.status).toBe(400);
  });

  test("an approving request that has started publishing resumes without the gate", async () => {
    seedRequest({ status: "approving", steps: DONE });
    const res = await dispatchApproval();
    expect(res.status).toBe(202);
    expect(refReads).toBe(0);
  });

  test("an approving request that stopped before publishing is gated, state and head", async () => {
    const id = seedRequest({ status: "approving", steps: PRE_PUBLICATION });
    markScreen(db, id, DATASET);
    mainHead = MOVED_HEAD;
    const res = await dispatchApproval();
    expect(res.status).toBe(409);
    expect((await refusal(res)).gate).toBe("stale");
    expect(dispatches).toHaveLength(0);
    expect(requestRow(id)?.approval_requested_by).toBeNull();
  });
});

describe("direct identifiers block the request and tell the depositor", () => {
  async function requestAndReport(
    status: string,
    findings: Record<string, number>,
    beforeReport?: (requestId: number) => void,
  ) {
    const res = await app.request(
      `/datasets/${DATASET}/publish/request`,
      { method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);
    const id = db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
      ?.id as number;
    const report = cleanScreenReportBody(DATASET, SCREENED_HEAD, status);
    (report.scan as Record<string, unknown>).findings_by_kind = findings;
    (report.scan as Record<string, unknown>).edf_bdf_files_flagged = 4;
    beforeReport?.(id);
    const cb = await app.request(
      "/webhooks/identifier-screen-result",
      {
        method: "POST",
        headers: {
          "X-Webhook-Token": dispatches[0].client_payload.callback_token as string,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dataset_id: DATASET, request_id: id, report }),
      },
      env(),
    );
    expect(cb.status).toBe(200);
    return id;
  }

  test("the request is blocked, the admins hear the result, the depositor hears what to fix", async () => {
    await withFakeResend(async (calls) => {
      const id = await requestAndReport("direct-identifiers", { "edf-patient-name": 4 });
      const row = requestRow(id);
      expect(row?.status).toBe("blocked");
      expect(row?.block_reason).toBe("identifier_screen_findings");

      const admin = sendsTo(calls, ADMIN_EMAIL);
      expect(admin).toHaveLength(1);
      expect(admin[0].subject).toEndWith("IDENTIFIER SCREEN: FOUND IDENTIFIERS");

      const owner = sendsTo(calls, OWNER_EMAIL);
      expect(owner).toHaveLength(1);
      expect(owner[0].subject).toBe(
        `Publication on hold: ${DATASET} - identifying information found`,
      );
      expect(owner[0].html).toContain("edf-patient-name x4");
      expect(owner[0].html).toContain(`nemar dataset publish request ${DATASET}`);

      // The status view says why, in the block's own words.
      const status = await app.request(
        `/datasets/${DATASET}/publish/status`,
        { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        env(),
      );
      const s = (await status.json()) as {
        message: string;
        identifier_screen: { headline: string };
      };
      expect(s.message).toContain("identifier screen found");
      expect(s.identifier_screen.headline).toBe("Identifier screen: FOUND IDENTIFIERS");
    });
  });

  test("a finding that lands after the request stopped being active blocks nothing and tells nobody", async () => {
    await withFakeResend(async (calls) => {
      const id = await requestAndReport("direct-identifiers", { "edf-patient-name": 4 }, (rid) =>
        db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [rid]),
      );
      const row = requestRow(id);
      // The result is stored (the gate would refuse it), but a denied request is not reopened as
      // blocked and its depositor gets no notice about a request that no longer exists.
      expect(row?.identifier_screen_status).toBe("direct-identifiers");
      expect(row?.status).toBe("denied");
      expect(row?.block_reason).toBeNull();
      expect(sendsTo(calls, OWNER_EMAIL)).toHaveLength(0);
    });
  });

  test("a finding that needs review does not block", async () => {
    await withFakeResend(async (calls) => {
      const id = await requestAndReport("review", { "edf-patient-freetext": 2 });
      expect(requestRow(id)?.status).toBe("requested");
      expect(sendsTo(calls, OWNER_EMAIL)).toHaveLength(0);
    });
  });

  test("re-requesting the blocked request unblocks it and screens it again", async () => {
    await withFakeResend(async () => {
      const id = await requestAndReport("direct-identifiers", { "edf-patient-name": 4 });
      dispatches = [];
      const res = await app.request(
        `/datasets/${DATASET}/publish/request`,
        { method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
        env(),
      );
      expect(res.status).toBe(200);
      const row = requestRow(id);
      expect(row?.status).toBe("requested");
      expect(row?.block_reason).toBeNull();
      expect(row?.identifier_screen_status).toBe("pending");
      expect(dispatches).toHaveLength(1);
    });
  });

  test("a failed notice is logged without the depositor's or an admin's address", async () => {
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      // Resend refuses every send, so the admin mail and the depositor's notice both fail.
      await withFakeResend(
        async () => {
          await requestAndReport("direct-identifiers", { "edf-patient-name": 4 });
        },
        { status: 500 },
      );
    } finally {
      console.error = realError;
    }
    const text = logged.join("\n");
    // Both failures were logged (the control: an empty log would prove nothing) ...
    expect(text).toContain("Failed to send publication request email to g***@example.org");
    expect(text).toContain("requester notice");
    // ... and neither names an address in full.
    expect(text).not.toContain(OWNER_EMAIL);
    expect(text).not.toContain(ADMIN_EMAIL);
  });

  test("outside production the depositor's notice obeys the delivery fence", async () => {
    envOverrides = { ENVIRONMENT: "staging" } as Partial<Bindings>;
    await withFakeResend(async (calls) => {
      const id = await requestAndReport("direct-identifiers", { "edf-patient-name": 4 });
      expect(requestRow(id)?.status).toBe("blocked");
      expect(calls).toHaveLength(0);
    });
  });

  test("the daily BIDS sweep screens every request it unblocks, up to its cap", async () => {
    const ids: number[] = [];
    for (let i = 0; i < MAX_SCREENED_UNBLOCKS_PER_SWEEP + 2; i++) {
      const id = `nm000${510 + i}`;
      seedDataset(id);
      ids.push(
        seedRequest({ status: "blocked", blockReason: "bids_validation_pending", dataset: id }),
      );
    }
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(MAX_SCREENED_UNBLOCKS_PER_SWEEP);
    expect(result.screened).toBe(MAX_SCREENED_UNBLOCKS_PER_SWEEP);
    expect(dispatches).toHaveLength(MAX_SCREENED_UNBLOCKS_PER_SWEEP);
    const rows = ids.map((id) => requestRow(id));
    const unblocked = rows.filter((r) => r?.status === "requested");
    expect(unblocked).toHaveLength(MAX_SCREENED_UNBLOCKS_PER_SWEEP);
    for (const r of unblocked) expect(r?.identifier_screen_status).toBe("pending");
    // Over the cap: still blocked, never `requested` without a screen.
    expect(rows.filter((r) => r?.status === "blocked")).toHaveLength(2);
  });

  test("the daily BIDS sweep mails at once when a screen it starts cannot start", async () => {
    const OTHER = "nm000462";
    seedDataset(OTHER);
    const id = seedRequest({
      status: "blocked",
      blockReason: "bids_validation_pending",
      dataset: OTHER,
    });
    envOverrides = { PRESCREEN_CALLBACK_SECRET: undefined } as Partial<Bindings>;
    await withFakeResend(async (calls) => {
      await sweepBlockedBidsValidationRequests(env());
      expect(requestRow(id)?.status).toBe("requested");
      expect(requestRow(id)?.identifier_screen_status).toBe("error");
      expect(sendsTo(calls, ADMIN_EMAIL)[0]?.subject).toEndWith("IDENTIFIER SCREEN: DID NOT RUN");
    });
  });

  test("the daily BIDS sweep leaves an identifier block alone", async () => {
    // The control row is blocked on BIDS and its CI is green, so the sweep
    // unblocks it: proof the sweep ran over these rows at all.
    const OTHER = "nm000461";
    seedDataset(OTHER);
    const findings = seedRequest({ status: "blocked", blockReason: "identifier_screen_findings" });
    const control = seedRequest({
      status: "blocked",
      blockReason: "bids_validation_pending",
      dataset: OTHER,
    });
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(requestRow(control)?.status).toBe("requested");
    expect(result.unblocked).toBe(1);
    const row = requestRow(findings);
    expect(row?.status).toBe("blocked");
    expect(row?.block_reason).toBe("identifier_screen_findings");
  });
});

describe("the admin re-run (POST /admin/publish/:id/identifier-screen)", () => {
  function rerun(dataset = DATASET): Promise<Response> {
    return app.request(
      `/admin/publish/${dataset}/identifier-screen`,
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
  }

  test("dispatches a fresh screen, resets the old result and its acknowledgment, and audits it", async () => {
    const id = seedRequest();
    markScreen(db, id, DATASET, { status: "review" });
    db.run(
      `UPDATE publication_requests SET identifier_screen_ack_by = ?, identifier_screen_ack_at = datetime('now'),
              identifier_screen_ack_reason = 'old' WHERE id = ?`,
      [adminId, id],
    );
    const res = await rerun();
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("pending");
    const row = requestRow(id);
    expect(row?.identifier_screen_status).toBe("pending");
    expect(row?.identifier_screen_ack_by).toBeNull();
    expect(row?.identifier_screen_ack_reason).toBeNull();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].event_type).toBe("run-identifier-screen");
    const audit = db
      .query<{ user_id: number }, []>(
        "SELECT user_id FROM audit_log WHERE action = 'identifier_screen_rerun'",
      )
      .get();
    expect(audit?.user_id).toBe(adminId);

    // Its result is mailed like a new request's.
    await withFakeResend(async (calls) => {
      const token = await signIdentifierScreenCallbackToken(
        { datasetId: DATASET, requestId: id, nonce: row?.identifier_screen_nonce as string },
        SECRET,
      );
      const cb = await app.request(
        "/webhooks/identifier-screen-result",
        {
          method: "POST",
          headers: { "X-Webhook-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({
            dataset_id: DATASET,
            request_id: id,
            report: cleanScreenReportBody(DATASET),
          }),
        },
        env(),
      );
      expect(cb.status).toBe(200);
      expect(sendsTo(calls, ADMIN_EMAIL)[0].subject).toEndWith("IDENTIFIER SCREEN: clean");
    });
  });

  test("a screen pending with no dispatch time is overdue and can be re-run (NULL-safe)", async () => {
    const id = seedRequest();
    db.run(
      `UPDATE publication_requests SET identifier_screen_status = 'pending', identifier_screen_nonce = 'n',
              identifier_screen_dispatched_at = NULL WHERE id = ?`,
      [id],
    );
    const res = await rerun();
    expect(res.status).toBe(202);
    expect(requestRow(id)?.identifier_screen_nonce).not.toBe("n");
    expect(dispatches).toHaveLength(1);
  });

  test("refuses while a screen is running and recent, and allows it once that one is overdue", async () => {
    const id = seedRequest();
    db.run(
      `UPDATE publication_requests SET identifier_screen_status = 'pending', identifier_screen_nonce = 'n',
              identifier_screen_dispatched_at = datetime('now', '-5 minutes') WHERE id = ?`,
      [id],
    );
    const busy = await rerun();
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe("identifier_screen_pending");
    expect(dispatches).toHaveLength(0);
    expect(requestRow(id)?.identifier_screen_nonce).toBe("n");

    db.run(
      "UPDATE publication_requests SET identifier_screen_dispatched_at = datetime('now', '-2 hours') WHERE id = ?",
      [id],
    );
    const res = await rerun();
    expect(res.status).toBe(202);
    expect(requestRow(id)?.identifier_screen_nonce).not.toBe("n");
  });

  test("a screen that cannot start is recorded and mailed, as for a new request", async () => {
    const id = seedRequest();
    envOverrides = { PRESCREEN_CALLBACK_SECRET: undefined } as Partial<Bindings>;
    await withFakeResend(async (calls) => {
      const res = await rerun();
      expect(res.status).toBe(202);
      expect(((await res.json()) as { status: string }).status).toBe("error");
      expect(requestRow(id)?.identifier_screen_status).toBe("error");
      expect(sendsTo(calls, ADMIN_EMAIL)[0].subject).toEndWith("DID NOT RUN");
    });
  });

  test("refuses a sandbox dataset, an approving request and a dataset with no request", async () => {
    const XX = "xx099961";
    seedDataset(XX, { exemplar: true });
    seedRequest({ dataset: XX });
    const sandbox = await rerun(XX);
    expect(sandbox.status).toBe(400);
    expect(((await sandbox.json()) as { error: string }).error).toBe(
      "identifier_screen_not_applicable",
    );

    expect((await rerun()).status).toBe(404);
    seedRequest({ status: "approving", steps: DONE });
    const started = await rerun();
    expect(started.status).toBe(409);
    expect(((await started.json()) as { error: string }).error).toBe("approval_in_progress");
    expect(dispatches).toHaveLength(0);
  });

  test("an approval that stopped before publishing can be screened again", async () => {
    const id = seedRequest({ status: "approving", steps: PRE_PUBLICATION });
    const res = await rerun();
    expect(res.status).toBe(202);
    expect(requestRow(id)?.identifier_screen_status).toBe("pending");
    expect(dispatches).toHaveLength(1);
  });

  test("a claim refused because the request stopped being active is not reported as pending", async () => {
    const id = seedRequest();
    // The request is published between the route's read and its claim.
    const racing = {
      ...env(),
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql.includes("identifier_screen_status = 'pending', identifier_screen_nonce = ?")) {
          db.run("UPDATE publication_requests SET status = 'published' WHERE id = ?", [id]);
        }
      }),
    } as Bindings;
    const res = await app.request(
      `/admin/publish/${DATASET}/identifier-screen`,
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      racing,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
    expect(dispatches).toHaveLength(0);
  });

  test("a clean re-run lifts a block its findings put there; an earlier run's late report is refused", async () => {
    const id = seedRequest({ status: "blocked", blockReason: "identifier_screen_findings" });
    // An earlier run, still out there with its own nonce.
    db.run(
      `UPDATE publication_requests SET identifier_screen_status = 'unreported',
              identifier_screen_nonce = 'earlier-run' WHERE id = ?`,
      [id],
    );
    const earlierToken = await signIdentifierScreenCallbackToken(
      { datasetId: DATASET, requestId: id, nonce: "earlier-run" },
      SECRET,
    );
    expect((await rerun()).status).toBe(202);
    const nonce = requestRow(id)?.identifier_screen_nonce as string;
    expect(nonce).not.toBe("earlier-run");

    const post = (token: string) =>
      app.request(
        "/webhooks/identifier-screen-result",
        {
          method: "POST",
          headers: { "X-Webhook-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({
            dataset_id: DATASET,
            request_id: id,
            report: cleanScreenReportBody(DATASET),
          }),
        },
        env(),
      );
    await withFakeResend(async () => {
      expect((await post(earlierToken)).status).toBe(401);
      const token = await signIdentifierScreenCallbackToken(
        { datasetId: DATASET, requestId: id, nonce },
        SECRET,
      );
      expect((await post(token)).status).toBe(200);
    });
    const row = requestRow(id);
    expect(row?.identifier_screen_status).toBe("clean");
    expect(row?.status).toBe("requested");
    expect(row?.block_reason).toBeNull();
  });

  test("a clean screen does not lift a block that is not the screen's", async () => {
    const id = seedRequest({ status: "blocked", blockReason: "bids_validation_failed" });
    expect((await rerun()).status).toBe(202);
    const nonce = requestRow(id)?.identifier_screen_nonce as string;
    const token = await signIdentifierScreenCallbackToken(
      { datasetId: DATASET, requestId: id, nonce },
      SECRET,
    );
    await withFakeResend(async () => {
      const res = await app.request(
        "/webhooks/identifier-screen-result",
        {
          method: "POST",
          headers: { "X-Webhook-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({
            dataset_id: DATASET,
            request_id: id,
            report: cleanScreenReportBody(DATASET),
          }),
        },
        env(),
      );
      expect(res.status).toBe(200);
    });
    expect(requestRow(id)?.status).toBe("blocked");
    expect(requestRow(id)?.block_reason).toBe("bids_validation_failed");
  });

  test("a cookie request must come from a NEMAR page; a bearer key need not", async () => {
    seedRequest();
    const { cookieIdRaw } = await issueSession(
      env(),
      adminId,
      false,
      "test-agent",
      "127.0.0.1",
      "orcid",
    );
    const withCookie = (origin?: string) =>
      app.request(
        `/admin/publish/${DATASET}/identifier-screen`,
        {
          method: "POST",
          headers: {
            Cookie: `nemar_session=${cookieIdRaw}`,
            ...(origin ? { Origin: origin } : {}),
          },
        },
        env(),
      );
    const foreign = await withCookie("https://evil.example");
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: string }).error).toBe("origin_not_allowed");
    expect((await withCookie()).status).toBe(403);
    expect(dispatches).toHaveLength(0);
    expect((await withCookie("https://app.nemar.org")).status).toBe(202);
    expect(dispatches).toHaveLength(1);
  });
});
