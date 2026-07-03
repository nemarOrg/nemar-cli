/**
 * Golden characterization tests for POST /admin/publish/:id/approve (#904).
 *
 * Written against the CURRENT inline handler BEFORE the orchestrator
 * extraction and kept green through every extraction commit: they pin the
 * pre-loop (426 gate, request lookup, all-completed short-circuit, the
 * 'approving' transition), resume filtering, the two no-op steps' recording
 * quirks, the finalize block (visibility self-heal, 'published' write, audit
 * row), and the exact response contract.
 *
 * Real engine only: bun:sqlite behind the realD1 shim, the real auth
 * middleware (seeded users/tokens rows, real SHA-256 key hashing), and the
 * real route via Hono app.request(). The golden path resumes with only
 * `upload_to_zenodo` + `sync_nemar` remaining — both logged no-ops — so no
 * external service is touched (getDatasetsToken resolves from
 * GITHUB_ADMIN_PAT without network).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "golden-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm098765";

const ALL_STEPS = [
  "ci_check",
  "enrichment_check",
  "s3_public_read",
  "repo_public",
  "tag_protect",
  "doi_create",
  "update_metadata",
  "update_readme",
  "create_tag",
  "create_release",
  "upload_to_zenodo",
  "publish_doi",
  "version_doi",
  "s3_lock",
  "sync_nemar",
  "notify_user",
] as const;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;

async function seed(stepsCompleted: readonly string[]): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('goldadmin', 'goldadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const userId = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='goldadmin'")
    .get();
  if (!userId) throw new Error("seed: user insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    userId.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
     VALUES (?, 'Golden Dataset', ?, 'nemarDatasets/${DATASET}', 'private')`,
  ).run(DATASET, userId.id);
  db.query(
    `INSERT INTO publication_requests (dataset_id, status, requested_by, requested_at, steps_completed)
     VALUES (?, 'requested', ?, datetime('now'), ?)`,
  ).run(DATASET, userId.id, JSON.stringify(stepsCompleted));
}

function approve(body: Record<string, unknown>, id = DATASET): Promise<Response> {
  return app.request(
    `/admin/publish/${id}/approve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

function requestRow() {
  return db
    .query<
      {
        status: string;
        approved_by: number | null;
        approved_at: string | null;
        current_step: string | null;
        last_error: string | null;
        steps_completed: string;
      },
      [string]
    >(
      "SELECT status, approved_by, approved_at, current_step, last_error, steps_completed FROM publication_requests WHERE dataset_id = ?",
    )
    .get(DATASET);
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  env = {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "test-pat-never-used-on-this-path",
  } as Bindings;
});

describe("POST /admin/publish/:id/approve (golden characterization)", () => {
  test("golden resume path: only the two no-op steps remain", async () => {
    const done = ALL_STEPS.filter((s) => s !== "upload_to_zenodo" && s !== "sync_nemar");
    await seed(done);

    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.message).toBe("Dataset published successfully");
    expect(body.dataset_id).toBe(DATASET);
    expect(body.status).toBe("published");
    // Quirk pin: the terminal success body reports the STATIC full step
    // list, not the runtime-completed array.
    expect(body.steps_completed).toEqual([...ALL_STEPS]);
    // Only the steps that actually ran this invocation get step_results.
    const results = body.step_results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.step)).toEqual(["upload_to_zenodo", "sync_nemar"]);
    for (const r of results) {
      expect(r.status).toBe("completed");
      expect(r.attempts).toBe(1);
      // Stale-duration quirk: no startStep precedes these no-ops, so
      // duration_ms is elapsed-since-run-start — a number, not undefined.
      expect(typeof r.duration_ms).toBe("number");
      expect(r.error).toBeUndefined();
    }
    // No s3_lock ran this invocation.
    expect(body.s3_lock_total).toBeUndefined();
    expect(body.s3_lock_batch_count).toBeUndefined();
    expect(body.warning).toBeUndefined();

    // D1 finalize effects.
    const row = requestRow();
    expect(row?.status).toBe("published");
    expect(row?.current_step).toBeNull();
    expect(row?.last_error).toBeNull();
    expect(row?.approved_by).not.toBeNull();
    expect(row?.approved_at).not.toBeNull();
    // Quirk pin: D1 steps_completed preserves completion order — the seeded
    // 14 steps first, then the two resumed no-ops appended at the END (it is
    // NOT re-sorted into canonical step order).
    expect(JSON.parse(row?.steps_completed ?? "[]")).toEqual([
      ...done,
      "upload_to_zenodo",
      "sync_nemar",
    ]);

    // Visibility self-heal: repo_public was skipped via resume, so the
    // finalize consistency check flips 'private' -> 'public'.
    const ds = db
      .query<{ visibility: string }, [string]>(
        "SELECT visibility FROM datasets WHERE dataset_id = ?",
      )
      .get(DATASET);
    expect(ds?.visibility).toBe("public");

    // Audit row.
    const audit = db
      .query<{ action: string; resource_id: string; user_id: number }, []>(
        "SELECT action, resource_id, user_id FROM audit_log ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(audit?.action).toBe("dataset_published");
    expect(audit?.resource_id).toBe(DATASET);
  });

  test("all-completed short-circuit: responds published, touches nothing", async () => {
    await seed(ALL_STEPS);

    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      message: "All steps already completed",
      dataset_id: DATASET,
      status: "published",
    });

    // Quirk pin: the short-circuit fires BEFORE the 'approving' transition
    // and performs NO writes — the row stays exactly as seeded.
    const row = requestRow();
    expect(row?.status).toBe("requested");
    expect(row?.approved_by).toBeNull();
    expect(row?.approved_at).toBeNull();
  });

  test("404 when no active publication request exists", async () => {
    await seed(ALL_STEPS); // seeded for a different dataset id than queried
    const res = await approve({ resume: true }, "nm000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("No active publication request found");
  });

  test("426 for pre-0.8.5 CLI sending s3_lock_offset without a continuation token", async () => {
    await seed([]);
    const res = await approve({ resume: true, s3_lock_offset: 100 });
    expect(res.status).toBe(426);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain("Outdated nemar-cli");
  });
});
