/**
 * The archive-ready webhook applies the size policy BEFORE re-dispatching a
 * failed build (#1514, nm000284 incident).
 *
 * Cause #2 in the issue: `services/github/dispatch.ts`'s dispatcher never
 * consulted `shouldSkipArchive`, even though the row already carries
 * `file_size`/`total_files`. A dataset that failed once and has since grown
 * past the archive-size policy must not be auto-retried into another doomed,
 * oversized build -- it should be recorded as skipped (the SAME statement
 * the webhook's own 'skipped' branch runs) and never dispatched.
 *
 * Cause #2's other half: the dispatch payload now carries `total_bytes`/
 * `total_files` so the workflow's preflight has a fallback when the version
 * manifest isn't publicly fetchable yet (private dataset, anonymous deposit,
 * or a version whose row hasn't landed -- the actual nm000284 cause).
 *
 * Real engine throughout: a real Hono app with `registerArchiveReadyRoutes`,
 * real in-memory D1 (`helpers/d1`'s `realD1`, every migration applied), and a
 * `Bun.serve()` stand-in for `api.github.com` (the house pattern for an HTTP
 * upstream, `manifest-dispatch-bucket-guard.test.ts`). No mocks: the refusal
 * is asserted by what the fake GitHub server did NOT receive, and the
 * in-policy case pins that the same call DOES dispatch, so a gate that
 * refused everything would fail here too.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { registerArchiveReadyRoutes } from "../src/routes/callbacks/archive-ready";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const TOKEN = "test-webhook-token";

function seedUser(db: Database): void {
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')`,
  ).run();
}

function insertDataset(
  db: Database,
  d: {
    dataset_id: string;
    file_size?: number | null;
    total_files?: number | null;
    archive_retry_count?: number;
  },
): void {
  db.prepare(
    `INSERT INTO datasets
       (dataset_id, owner_user_id, name, visibility, is_sandbox,
        file_size, total_files, archive_retry_count)
     VALUES (?, 1, ?, 'public', 0, ?, ?, ?)`,
  ).run(
    d.dataset_id,
    d.dataset_id,
    d.file_size ?? null,
    d.total_files ?? null,
    d.archive_retry_count ?? 0,
  );
}

let server: Server;
let dispatches: Array<{ path: string; body: { client_payload?: Record<string, unknown> } }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      dispatches.push({ path: url.pathname, body: await request.json() });
      return new Response(null, { status: 204 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  dispatches = [];
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

interface WebhookAnswer {
  httpStatus: number;
  ok?: boolean;
  dataset_id?: string;
  status?: string;
  error?: string;
}

async function postArchiveReady(
  db: Database,
  body: Record<string, unknown>,
): Promise<WebhookAnswer> {
  const app = new Hono<{ Bindings: Bindings }>();
  registerArchiveReadyRoutes(app);
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const req = new Request("http://localhost/archive-ready", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Webhook-Token": TOKEN },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(
    req,
    {
      NEMAR_WEBHOOK_TOKEN: TOKEN,
      DB: realD1(db),
      GITHUB_ADMIN_PAT: "test-token",
      S3_BUCKET: "nemar",
      API_BASE_URL: "https://api.nemar.org",
    } as Bindings,
    ctx,
  );
  // The retry dispatch is fire-and-forget via waitUntil; wait for it before
  // asserting on `dispatches` or the row, same as the production caller does
  // (Cloudflare keeps the isolate alive until every waitUntil settles).
  await Promise.all(waitUntilPromises);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ...json, httpStatus: res.status } as WebhookAnswer;
}

describe("POST /archive-ready: 'failed' callback for an over-policy dataset", () => {
  test("is superseded by the size policy: no dispatch, row recorded as skipped", async () => {
    const db = freshDb();
    seedUser(db);
    // The nm000284 shape: 512.4 GiB / 14,922 files, five times over
    // ARCHIVE_MAX_BYTES.
    insertDataset(db, {
      dataset_id: "nm000284",
      file_size: 550_239_019_072,
      total_files: 14_922,
      archive_retry_count: 1,
    });

    const answer = await postArchiveReady(db, {
      dataset_id: "nm000284",
      status: "failed",
      version: "1.0.1",
    });

    expect(answer.httpStatus).toBe(200);
    expect(dispatches).toEqual([]);

    const row = db
      .prepare(
        "SELECT archive_status, archive_skip_reason, archive_retry_count FROM datasets WHERE dataset_id = ?",
      )
      .get("nm000284") as {
      archive_status: string | null;
      archive_skip_reason: string | null;
      archive_retry_count: number;
    };
    expect(row.archive_status).toBeNull();
    expect(row.archive_skip_reason).toContain("exceeds");
    // The skip statement resets the counter, same as the 'skipped' branch.
    expect(row.archive_retry_count).toBe(0);
  });
});

describe("POST /archive-ready: 'failed' callback for an in-policy dataset", () => {
  test("retries as before, and the dispatch payload carries total_bytes/total_files", async () => {
    const db = freshDb();
    seedUser(db);
    insertDataset(db, {
      dataset_id: "nm000010",
      file_size: 5 * 1024 * 1024 * 1024,
      total_files: 200,
      archive_retry_count: 0,
    });

    const answer = await postArchiveReady(db, {
      dataset_id: "nm000010",
      status: "failed",
      version: "1.0.0",
    });

    expect(answer.httpStatus).toBe(200);
    expect(dispatches).toHaveLength(1);
    const payload = dispatches[0].body.client_payload as {
      dataset_id: string;
      version: string;
      total_bytes?: number;
      total_files?: number;
    };
    expect(payload.dataset_id).toBe("nm000010");
    expect(payload.version).toBe("1.0.0");
    expect(payload.total_bytes).toBe(5 * 1024 * 1024 * 1024);
    expect(payload.total_files).toBe(200);

    const row = db
      .prepare("SELECT archive_status, archive_retry_count FROM datasets WHERE dataset_id = ?")
      .get("nm000010") as { archive_status: string | null; archive_retry_count: number };
    expect(row.archive_status).toBe("failed");
    expect(row.archive_retry_count).toBe(1);
  });

  test("an unknown row still 404s before any dispatch is attempted", async () => {
    const db = freshDb();
    seedUser(db);
    const answer = await postArchiveReady(db, {
      dataset_id: "nm012399",
      status: "failed",
      version: "1.0.0",
    });
    expect(answer.httpStatus).toBe(404);
    expect(dispatches).toEqual([]);
  });
});
