/**
 * The archive-ready webhook must not let a callback for an OLDER version
 * overwrite the dataset-scoped archive columns with that older zip's
 * numbers (#1514 review, item 10). A retry or a re-dispatch that finishes
 * AFTER a newer build has already gone 'ready' would otherwise clobber
 * `archive_size`/completeness with stale numbers, with nothing in the row
 * to say it happened.
 *
 * The "latest" rule mirrors `PUBLIC_DATASET_VERSIONS_SQL` (data-router.ts):
 * `ORDER BY created_at DESC`. `LATEST_DATASET_VERSION_SQL`, exported from
 * the route module, is the same statement the route runs -- so this test
 * can't drift from what production executes.
 *
 * Real engine throughout: a real Hono app with `registerArchiveReadyRoutes`
 * and real in-memory D1 (`helpers/d1`'s `realD1`, every migration applied).
 * No mocks.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
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

function insertDataset(db: Database, datasetId: string): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox)
     VALUES (?, 1, ?, 'public', 0)`,
  ).run(datasetId, datasetId);
}

function insertVersion(db: Database, datasetId: string, version: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
     VALUES (?, ?, ?, 'ezid', ?)`,
  ).run(datasetId, version, `10.82901/nemar.${datasetId}.v${version}`, createdAt);
}

interface WebhookAnswer {
  httpStatus: number;
  ok?: boolean;
  dataset_id?: string;
  status?: string;
  applied?: boolean;
  reason?: string;
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
  await Promise.all(waitUntilPromises);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ...json, httpStatus: res.status } as WebhookAnswer;
}

function readArchiveRow(db: Database, datasetId: string) {
  return db
    .prepare(
      "SELECT archive_status, archive_size, archive_retry_count FROM datasets WHERE dataset_id = ?",
    )
    .get(datasetId) as {
    archive_status: string | null;
    archive_size: number | null;
    archive_retry_count: number;
  };
}

describe("POST /archive-ready: 'ready' for the dataset's latest version", () => {
  test("applies normally", async () => {
    const db = freshDb();
    seedUser(db);
    insertDataset(db, "nm000284");
    insertVersion(db, "nm000284", "1.0.0", "2026-01-01 00:00:00");
    insertVersion(db, "nm000284", "1.0.1", "2026-02-01 00:00:00");

    const answer = await postArchiveReady(db, {
      dataset_id: "nm000284",
      status: "ready",
      version: "1.0.1",
      size: 12345,
    });

    expect(answer.httpStatus).toBe(200);
    expect(answer.applied).toBeUndefined();
    const row = readArchiveRow(db, "nm000284");
    expect(row.archive_status).toBe("ready");
    expect(row.archive_size).toBe(12345);
  });

  test("a dataset with no dataset_versions row yet still applies (nothing to contradict)", async () => {
    const db = freshDb();
    seedUser(db);
    insertDataset(db, "nm000285");

    const answer = await postArchiveReady(db, {
      dataset_id: "nm000285",
      status: "ready",
      version: "1.0.0",
      size: 999,
    });

    expect(answer.httpStatus).toBe(200);
    expect(answer.applied).toBeUndefined();
    const row = readArchiveRow(db, "nm000285");
    expect(row.archive_status).toBe("ready");
    expect(row.archive_size).toBe(999);
  });

  test("a callback with no version field still applies (nothing to compare)", async () => {
    const db = freshDb();
    seedUser(db);
    insertDataset(db, "nm000286");
    insertVersion(db, "nm000286", "1.0.0", "2026-01-01 00:00:00");

    const answer = await postArchiveReady(db, {
      dataset_id: "nm000286",
      status: "ready",
      size: 777,
    });

    expect(answer.httpStatus).toBe(200);
    expect(answer.applied).toBeUndefined();
    const row = readArchiveRow(db, "nm000286");
    expect(row.archive_status).toBe("ready");
    expect(row.archive_size).toBe(777);
  });

  test("a leading-v callback version applies against a bare stored latest (#1514 review)", async () => {
    const db = freshDb();
    seedUser(db);
    insertDataset(db, "nm000287");
    // Stored bare, as version-doi.ts normalizes before writing.
    insertVersion(db, "nm000287", "1.0.0", "2026-01-01 00:00:00");

    const answer = await postArchiveReady(db, {
      dataset_id: "nm000287",
      status: "ready",
      version: "v1.0.0",
      size: 4242,
    });

    expect(answer.httpStatus).toBe(200);
    expect(answer.applied).toBeUndefined();
    const row = readArchiveRow(db, "nm000287");
    expect(row.archive_status).toBe("ready");
    expect(row.archive_size).toBe(4242);
  });
});

describe("POST /archive-ready: 'ready' for an OLDER version, after the latest is already ready", () => {
  test("does not change archive_size and reports applied=false", async () => {
    const db = freshDb();
    seedUser(db);
    insertDataset(db, "nm000284");
    insertVersion(db, "nm000284", "1.0.0", "2026-01-01 00:00:00");
    insertVersion(db, "nm000284", "1.0.1", "2026-02-01 00:00:00");

    // The latest version (1.0.1) has already been recorded ready.
    const first = await postArchiveReady(db, {
      dataset_id: "nm000284",
      status: "ready",
      version: "1.0.1",
      size: 999_000_000,
    });
    expect(first.httpStatus).toBe(200);

    // A stale retry for the OLDER version (1.0.0) finishes afterward.
    const second = await postArchiveReady(db, {
      dataset_id: "nm000284",
      status: "ready",
      version: "1.0.0",
      size: 5,
    });

    expect(second.httpStatus).toBe(200);
    expect(second.applied).toBe(false);
    expect(second.reason).toContain("not the dataset's latest");

    // The row must still carry the LATEST build's number, not the stale
    // retry's.
    const row = readArchiveRow(db, "nm000284");
    expect(row.archive_status).toBe("ready");
    expect(row.archive_size).toBe(999_000_000);
  });

  test("an unknown dataset still 404s rather than reporting applied=false", async () => {
    const db = freshDb();
    seedUser(db);

    const answer = await postArchiveReady(db, {
      dataset_id: "nm012399",
      status: "ready",
      version: "1.0.0",
      size: 5,
    });

    expect(answer.httpStatus).toBe(404);
  });
});
