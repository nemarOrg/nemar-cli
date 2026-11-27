/**
 * Migration 0162_publication_review_license_matcher.sql (ADR 0142; ADR 0139 decision 9 as amended
 * on 2026-11-27) on Miniflare's D1, the implementation `wrangler --local` runs: bun:sqlite is more
 * permissive than the SQLite D1 ships, so a CHECK proven only there is not proven.
 *
 * What is pinned: rows that existed before the migration read back NULL; the column is a reported
 * row's alone (setting it on a dispatched row is refused, and so is moving a row that has it out of
 * `reported`); its length is 1 to 64 (0 and 65 are refused).
 *
 * MUTATIONS (each applied to the migration text, run, and restored): drop `state = 'reported'`
 * from the CHECK; widen the bound to 65; lower the bound to 0.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

const FILE = "0162_publication_review_license_matcher.sql";

let mf: Miniflare;
let d1: Awaited<ReturnType<Miniflare["getD1Database"]>>;

/** Null when the statement ran, else the error's text. */
async function refusal(sql: string, ...binds: unknown[]): Promise<string | null> {
  try {
    await d1
      .prepare(sql)
      .bind(...binds)
      .run();
    return null;
  } catch (err) {
    return String(err);
  }
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  d1 = await mf.getD1Database("DB");
  await applyMigrations(
    d1,
    migrationFiles().filter((f) => f < FILE),
  );
  // Rows already on record: one reported, one dispatched.
  await d1
    .prepare(
      `INSERT INTO publication_reviews
         (id, request_id, dataset_id, head_sha, anonymous, requested_by, state, verdict, report, decided_at)
       VALUES (1, 1, 'nm000901', ?, 0, 1, 'reported', 'pass', '{}', datetime('now'))`,
    )
    .bind("a".repeat(40))
    .run();
  await d1
    .prepare(
      `INSERT INTO publication_reviews
         (id, request_id, dataset_id, head_sha, anonymous, requested_by, state, nonce)
       VALUES (2, 2, 'nm000902', ?, 0, 1, 'dispatched', 'n')`,
    )
    .bind("b".repeat(40))
    .run();
  await applyMigrations(
    d1,
    migrationFiles().filter((f) => f >= FILE),
  );
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("migration 0162 on Miniflare D1", () => {
  test("rows from before the migration read back NULL", async () => {
    const rows = await d1
      .prepare("SELECT id, license_matcher FROM publication_reviews ORDER BY id")
      .all<{ id: number; license_matcher: string | null }>();
    expect(rows.results).toEqual([
      { id: 1, license_matcher: null },
      { id: 2, license_matcher: null },
    ]);
  });

  test("a dispatched row cannot carry it", async () => {
    expect(
      await refusal("UPDATE publication_reviews SET license_matcher = 'unavailable' WHERE id = 2"),
    ).toContain("CHECK");
  });

  test("its length is 1 to 64", async () => {
    const set = "UPDATE publication_reviews SET license_matcher = ? WHERE id = 1";
    expect(await refusal(set, "")).toContain("CHECK");
    expect(await refusal(set, "x".repeat(65))).toContain("CHECK");
    expect(await refusal(set, "x".repeat(64))).toBeNull();
    expect(await refusal(set, "scancode-32.5.0+spdx-3.27")).toBeNull();
  });

  test("a row that has it cannot leave reported", async () => {
    expect(
      await refusal("UPDATE publication_reviews SET license_matcher = 'unavailable' WHERE id = 1"),
    ).toBeNull();
    expect(
      await refusal(
        "UPDATE publication_reviews SET state = 'errored', verdict = NULL, report = NULL, detail = 'workflow_failed' WHERE id = 1",
      ),
    ).toContain("CHECK");
    const row = await d1
      .prepare("SELECT state, license_matcher FROM publication_reviews WHERE id = 1")
      .first<{ state: string; license_matcher: string }>();
    expect(row).toEqual({ state: "reported", license_matcher: "unavailable" });
  });
});
