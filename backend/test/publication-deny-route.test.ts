/**
 * `POST /admin/publish/:id/deny` is lease-gated and conditional, and the final publish write is
 * guarded by the status it expects (#1603, Phase 3 of the publication review, ADR 0080).
 *
 * A denial used to be one unconditional UPDATE after a read, so it overwrote whatever the request
 * had become in between: a run still writing its steps, a request a run had just published, a
 * request an approval had started publishing (the DOI may already be public, and the depositor
 * would be told "denied" for a public dataset). Now the route reads the newest active request,
 * refuses by the shared words (a `request_id` that is not it, a run that started publishing, a
 * run that is in flight) and then denies with ONE conditional write whose terms are the lease
 * predicate and the `updated_at` it read, so a request that moved after the read is refused
 * rather than overwritten, and the answer names the true reason. The depositor's mail goes only
 * after that write has changed a row.
 *
 * The other half is the end of a run: `runPublicationApproval` marks the request `published` last,
 * and that write is now `AND status = 'approving'`. A request closed while the run ran (denied
 * once its lease had lapsed, or blocked again) is not published over: the run answers 409
 * `request_changed` with its own sentence and leaves an audit row of ids and words; a request a
 * concurrent finisher already published is carried on as before.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real admin router
 * behind its real auth middleware, GitHub as a `Bun.serve()` stand-in for the one read of `main`
 * the run makes, and Resend moved to a local server (helpers/resend.ts) with the real mail builder
 * and the real delivery fence, so "no mail" is read off what a real send would have posted. The
 * interleavings land a real write through `interceptingD1` exactly between the route's read and
 * its write; nothing is canned. Ages are SQLite's own `datetime('now', '-N minutes')` and sit well
 * clear of the 15 minute lease and the 60 second grace.
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database and local stand-ins.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { APPROVAL_FINISHED_ON_CLOSED_REQUEST_MESSAGE } from "../../shared/contract/publication.js";
import { PUBLICATION_STEPS } from "../../shared/publication-steps.js";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { mainRefAnswer, markDatasetScreensClean } from "./helpers/identifier-screen";

const ADMIN_KEY = "deny-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000491";
const REQUESTER_EMAIL = "denyrequester@example.org";

// Everything done except the two logged no-op steps, so a resumed run reaches the final write
// with no network beyond the one GitHub read of `main` the identifier-screen gate makes.
const DONE = PUBLICATION_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");

let server: Server;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;
let otherAdminId: number;
let requesterId: number;
let ownerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const ref = mainRefAnswer(req);
      if (ref) return ref;
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
  db.close();
});

/** `production` for the denial's mail (the delivery fence), `test` for a run of the approval. */
function env(d1: D1Database = realD1(db), environment = "production"): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: environment,
    GITHUB_ADMIN_PAT: "ghp_deny_test",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

function seedUser(username: string, role: string, email: string): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1, 'Ada', 'Lovelace')`,
    [username, email, role],
  );
  return db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username)
    ?.id as number;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  ownerId = seedUser("denyowner", "member", "denyowner@example.org");
  requesterId = seedUser("denyrequester", "member", REQUESTER_EMAIL);
  adminId = seedUser("denyadmin", "admin", "denyadmin@example.org");
  otherAdminId = seedUser("denyother", "admin", "denyother@example.org");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
});

interface Seed {
  status?: string;
  steps?: readonly string[];
  /** SQLite modifier for `updated_at`, such as "-16 minutes". Defaults to long ago. */
  updatedAt?: string;
  /** SQLite modifier for the web claim's `approval_dispatched_at`; omitted is no claim. */
  dispatchedAt?: string;
  lastError?: string;
  blockReason?: string;
}

/** A request made by `requesterId`; returns its id. */
function seedRequest(seed: Seed = {}): number {
  const claimed = seed.dispatchedAt !== undefined;
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at, steps_completed,
        approval_requested_by, approval_dispatched_at, last_error, block_reason)
     VALUES (?, ?, ?, datetime('now', '-3 hours'), datetime('now', ?), ?,
             ?, ${claimed ? `datetime('now', '${seed.dispatchedAt}')` : "NULL"}, ?, ?)`,
    [
      DATASET,
      seed.status ?? "requested",
      requesterId,
      seed.updatedAt ?? "-3 hours",
      JSON.stringify(seed.steps ?? []),
      claimed ? adminId : null,
      seed.lastError ?? null,
      seed.blockReason ?? null,
    ],
  );
  return db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
}

function row(id: number): Record<string, unknown> {
  return db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

describe("T4.10 the final publish write is guarded by the status it expects", () => {
  function seedRun(): number {
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
       VALUES (?, 'Deny Dataset', ?, ?, 'private')`,
      [DATASET, ownerId, `nemarDatasets/${DATASET}`],
    );
    const id = seedRequest({
      status: "approving",
      updatedAt: "-16 minutes",
      steps: DONE,
    });
    markDatasetScreensClean(db, DATASET);
    return id;
  }

  /** An environment whose database lands `effect` once, just before the run's final write. */
  function raceBeforeFinalWrite(effect: () => void): Bindings {
    let fired = false;
    return env(
      interceptingD1(realD1(db), (sql) => {
        if (!fired && /UPDATE publication_requests\s+SET status = 'published'/.test(sql)) {
          fired = true;
          effect();
        }
      }),
      "test",
    );
  }

  function approve(bindings: Bindings): Promise<Response> {
    return app.request(
      `/admin/publish/${DATASET}/approve`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      },
      bindings,
    );
  }

  const auditRows = (action: string) =>
    db
      .query<{ user_id: number | null; resource_id: string | null; details: string }, [string]>(
        "SELECT user_id, resource_id, details FROM audit_log WHERE action = ?",
      )
      .all(action);

  test.each([
    {
      label: "denied once its lease had lapsed",
      effect: (id: number) =>
        db.run(
          `UPDATE publication_requests
              SET status = 'denied', denied_by = ?, denied_reason = 'late', denied_at = datetime('now')
            WHERE id = ?`,
          [otherAdminId, id],
        ),
      closedAs: "denied",
    },
    {
      label: "blocked again by a result that arrived mid-run",
      effect: (id: number) =>
        db.run(
          `UPDATE publication_requests
              SET status = 'blocked', block_reason = 'min_requirements_failed'
            WHERE id = ?`,
          [id],
        ),
      closedAs: "blocked",
    },
  ])(
    "a request $label is not published over: 409, an audit row, status kept",
    async ({ effect, closedAs }) => {
      const id = seedRun();
      const res = await approve(raceBeforeFinalWrite(() => effect(id)));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "request_changed",
        message: APPROVAL_FINISHED_ON_CLOSED_REQUEST_MESSAGE,
      });
      const after = row(id);
      expect(after.status).toBe(closedAs);
      expect(after.approved_at).toBeNull();

      // Ids and words only: the request, and the status it was found in.
      const audit = auditRows("approval_finished_on_closed_request");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.resource_id).toBe(DATASET);
      expect(audit[0]?.user_id).toBe(adminId);
      expect(JSON.parse(audit[0]?.details ?? "null")).toEqual({
        request_id: id,
        request_status: closedAs,
      });
      // The run did not report a publication it did not record.
      expect(auditRows("dataset_published")).toHaveLength(0);
    },
  );

  test("a concurrent finisher that already published it is carried on: 200, as today", async () => {
    const id = seedRun();
    const res = await approve(
      raceBeforeFinalWrite(() =>
        db.run(
          `UPDATE publication_requests
              SET status = 'published', approved_at = datetime('now'), approved_by = ?
            WHERE id = ?`,
          [otherAdminId, id],
        ),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; dataset_id: string };
    expect(body.status).toBe("published");
    expect(body.dataset_id).toBe(DATASET);
    expect(row(id).status).toBe("published");
    expect(auditRows("approval_finished_on_closed_request")).toHaveLength(0);
    expect(auditRows("dataset_published")).toHaveLength(1);
  });

  test("a run nothing interrupts still publishes, with the guard in place", async () => {
    const id = seedRun();
    const res = await approve(env(realD1(db), "test"));
    expect(res.status).toBe(200);
    expect(row(id).status).toBe("published");
    expect(row(id).approved_at).not.toBeNull();
    expect(auditRows("approval_finished_on_closed_request")).toHaveLength(0);
  });
});
