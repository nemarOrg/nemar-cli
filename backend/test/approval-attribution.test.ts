/**
 * Who a publication is recorded as approved by (ADR 0080).
 *
 * Attribution forks. A terminal approval records the account that called
 * `/approve`, as it always has. A web approval is executed by a workflow that
 * authenticates with its own service key, so recording the caller would name the
 * bot for every one of them; instead the admin who clicked Approve on the
 * website, whom the dispatch route stored in `approval_requested_by`, is the
 * approver, and the executing account is kept as `executed_by` in the audit
 * details.
 *
 * Driven through the real routes, not the helper: `/approve` runs the resume
 * path (only the two logged no-op steps remain, as in
 * publication-approve-golden.test.ts) so no external service is touched, and one
 * case chains the real dispatch route into it. Real engine only: bun:sqlite
 * behind realD1 with every migration applied, the real auth middleware, and a
 * `Bun.serve()` stand-in for api.github.com for the one dispatch.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { PUBLICATION_STEPS } from "../../shared/publication-steps.js";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const EXECUTOR_KEY = "attrib-executor-key-0123456789abcdef0123456789abcdef";
const CLICKER_KEY = "attrib-clicker-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm098765";

// Everything done except the two no-op steps, so a resumed run reaches the
// finalize block (approved_by, the dataset_published audit row) with no network.
const DONE = PUBLICATION_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");

let server: Server;
let dispatched = 0;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;
let ownerId: number;
let executorId: number;
let clickerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      dispatched += 1;
      return new Response(null, { status: 204 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

async function seedAdmin(
  username: string | null,
  email: string,
  key: string | null,
): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES (?, ?, 'x', 'approved', 'admin', 1, 'Test', 'Admin')`,
    [username, email],
  );
  const u = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!u) throw new Error(`seed: ${email} insert failed`);
  if (key) {
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      u.id,
      await hashApiKey(key),
      key.slice(0, 8),
    );
  }
  return u.id;
}

/** A pending request whose approval was (or was not) queued from the web. */
function seedRequest(
  approvalRequestedBy: number | null,
  stepsDone: readonly string[] = DONE,
): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
     VALUES (?, 'Attribution Dataset', ?, ?, 'private')`,
    [DATASET, ownerId, `nemarDatasets/${DATASET}`],
  );
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, steps_completed, approval_requested_by)
     VALUES (?, 'requested', ?, datetime('now'), ?, ?)`,
    [DATASET, ownerId, JSON.stringify(stepsDone), approvalRequestedBy],
  );
}

function approveAs(key: string): Promise<Response> {
  return app.request(
    `/admin/publish/${DATASET}/approve`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resume: true }),
    },
    env,
  );
}

function publishedAudit() {
  const row = db
    .query<{ user_id: number; details: string }, []>(
      "SELECT user_id, details FROM audit_log WHERE action = 'dataset_published'",
    )
    .get();
  return row ? { userId: row.user_id, details: JSON.parse(row.details) } : null;
}

function approvedBy(): number | null {
  return (
    db
      .query<{ approved_by: number | null }, [string]>(
        "SELECT approved_by FROM publication_requests WHERE dataset_id = ?",
      )
      .get(DATASET)?.approved_by ?? null
  );
}

beforeEach(async () => {
  db = freshDb();
  dispatched = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  env = {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "test-pat",
  } as Bindings;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES ('attribowner', 'attribowner@example.org', 'x', 'approved', 'member', 1, 'Owen', 'Owner')`,
  );
  ownerId = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='attribowner'").get()
    ?.id as number;
  executorId = await seedAdmin("approvebot", "approvebot@example.org", EXECUTOR_KEY);
  clickerId = await seedAdmin("webclicker", "webclicker@example.org", CLICKER_KEY);
});

describe("a terminal approval", () => {
  test("is recorded as approved by the account that called /approve, with the audit row unchanged", async () => {
    seedRequest(null);
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);

    expect(approvedBy()).toBe(executorId);
    const audit = publishedAudit();
    expect(audit?.userId).toBe(executorId);
    // Byte-for-byte what it was before attribution forked: no executed_by key.
    expect(audit?.details).toEqual({ approved_by: "approvebot", steps: [...PUBLICATION_STEPS] });
  });
});

describe("a web-queued approval", () => {
  test("is recorded as approved by the admin who clicked, not the executing key", async () => {
    seedRequest(clickerId);
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);

    expect(approvedBy()).toBe(clickerId);
    const audit = publishedAudit();
    expect(audit?.userId).toBe(clickerId);
    expect(audit?.details).toEqual({
      approved_by: "webclicker",
      executed_by: "approvebot",
      steps: [...PUBLICATION_STEPS],
    });
  });

  test("end to end: the real dispatch route queues it, the real /approve run records the clicker", async () => {
    seedRequest(null);
    const dispatch = await app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      { method: "POST", headers: { Authorization: `Bearer ${CLICKER_KEY}` } },
      env,
    );
    expect(dispatch.status).toBe(202);
    expect(dispatched).toBe(1);

    // What the workflow does next: call /approve with the executor's own key.
    const run = await approveAs(EXECUTOR_KEY);
    expect(run.status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
    expect(publishedAudit()?.userId).toBe(clickerId);
  });

  test("a clicker who is also the caller has no separate executor to record", async () => {
    seedRequest(clickerId);
    const res = await approveAs(CLICKER_KEY);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(clickerId);
    expect(publishedAudit()?.details).toEqual({
      approved_by: "webclicker",
      steps: [...PUBLICATION_STEPS],
    });
  });

  test("a clicker with no username is named by email", async () => {
    // Web-only accounts may have no username until onboarded.
    const nameless = await seedAdmin(null, "nameless@example.org", null);
    seedRequest(nameless);
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(nameless);
    expect(publishedAudit()?.details.approved_by).toBe("nameless@example.org");
  });

  test("a clicker whose account is gone does not fail the publication: the caller stands in", async () => {
    const gone = await seedAdmin("vanished", "vanished@example.org", null);
    seedRequest(gone);
    db.run("DELETE FROM users WHERE id = ?", [gone]);

    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);
    expect(approvedBy()).toBe(executorId);
    expect(publishedAudit()?.userId).toBe(executorId);
  });
});

describe("a failed owner notification", () => {
  // notify_user is non-fatal: the DOI is already minted, so an email failure is
  // audited and the publication stands. A non-production Worker refuses mail to
  // a recipient off its allow-list, and the step treats that refusal as a
  // failure, which reaches the audit row with nothing faked.
  test("is audited under the approver, not the executing key", async () => {
    seedRequest(
      clickerId,
      DONE.filter((s) => s !== "notify_user"),
    );
    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);

    const failed = db
      .query<{ user_id: number }, []>(
        "SELECT user_id FROM audit_log WHERE action = 'notify_user_failed'",
      )
      .get();
    expect(failed?.user_id).toBe(clickerId);
  });
});

describe("the request the run reads", () => {
  test("is the newest active one: an older request's clicker is not used", async () => {
    // An older, since-denied request carries another admin's click. The run acts
    // on the newest ACTIVE request only, so that stale click must not leak in.
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
       VALUES (?, 'Attribution Dataset', ?, ?, 'private')`,
      [DATASET, ownerId, `nemarDatasets/${DATASET}`],
    );
    db.run(
      `INSERT INTO publication_requests
         (dataset_id, status, requested_by, requested_at, steps_completed, approval_requested_by)
       VALUES (?, 'denied', ?, datetime('now', '-2 days'), '[]', ?)`,
      [DATASET, ownerId, clickerId],
    );
    db.run(
      `INSERT INTO publication_requests
         (dataset_id, status, requested_by, requested_at, steps_completed)
       VALUES (?, 'requested', ?, datetime('now'), ?)`,
      [DATASET, ownerId, JSON.stringify(DONE)],
    );

    const res = await approveAs(EXECUTOR_KEY);
    expect(res.status).toBe(200);
    expect(publishedAudit()?.userId).toBe(executorId);
  });
});
