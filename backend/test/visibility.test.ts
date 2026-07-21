/**
 * Real in-memory D1 tests for services/visibility.ts (epic #967 phase 4,
 * #971, review-fix GROUP 2b: applyDatasetVisibility had zero direct test
 * coverage despite being a new 190-line shared file with 3 callers, and
 * fleet.ts's stage->HTTP-status mapping was a REWRITE of the pre-extraction
 * inline handler, not a verbatim move).
 *
 * Only the early-return branches that need no network are covered here
 * (not_found, no_repo, invalid_repo -- all return before getDatasetsToken is
 * even called): the github/s3/db failure-and-revert branches, and the
 * success path, all require a real GitHub PAT + AWS S3 credentials and are
 * out of reach for the pure/CI tier -- consistent with
 * backend/test/withdraw.test.ts's documented boundary for the same reason.
 * Uses the same credential-less `bareEnv` trick as withdraw.test.ts /
 * withdraw-route.test.ts: if applyDatasetVisibility tried to reach past
 * these branches into getDatasetsToken, it would throw on the missing
 * config, so a clean result here is real evidence these branches never
 * attempt a network call.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applyDatasetVisibility } from "../src/services/visibility";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

function bareEnv(db: Database): Bindings {
  return { DB: realD1(db) } as Bindings;
}

function seedDataset(db: Database, datasetId: string, githubRepo: string | null): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email, github_username, status) VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')",
  ).run();
  db.prepare(
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox, github_repo) VALUES (?, 1, ?, 'public', 0, ?)",
  ).run(datasetId, datasetId, githubRepo);
}

describe("applyDatasetVisibility (network-free early returns)", () => {
  test("not_found: unknown dataset id", async () => {
    const db = freshDb();
    const result = await applyDatasetVisibility(bareEnv(db), "on999999", "private");
    expect(result).toEqual({ ok: false, stage: "not_found", error: "Dataset not found" });
  });

  test("no_repo: dataset has no github_repo", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", null);
    const result = await applyDatasetVisibility(bareEnv(db), "on008115", "private");
    expect(result).toEqual({
      ok: false,
      stage: "no_repo",
      error: "Dataset has no GitHub repository",
    });
  });

  test("invalid_repo: github_repo has no owner/name split", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", "not-a-slash-delimited-repo");
    const result = await applyDatasetVisibility(bareEnv(db), "on008115", "private");
    expect(result).toEqual({
      ok: false,
      stage: "invalid_repo",
      error: "Invalid repository format",
    });
  });

  test("no D1 write occurs on any of the above -- visibility column is untouched", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", null);
    await applyDatasetVisibility(bareEnv(db), "on008115", "private");
    const row = db
      .prepare("SELECT visibility FROM datasets WHERE dataset_id = ?")
      .get("on008115") as { visibility: string };
    expect(row.visibility).toBe("public");
  });
});
