/**
 * Migration 0163_publication_review_served_metadata.sql (ADR 0142, decision 4) on Miniflare's D1,
 * the implementation `wrangler --local` runs: bun:sqlite is more permissive than the SQLite D1
 * ships, so a CHECK proven only there is not proven.
 *
 * What is pinned: rows that existed before the migration read back NULL; the column is a served
 * row's alone (setting it on a row whose inputs were never served is refused); it holds JSON only;
 * its length is at most 65,536, the number the writer (`SERVED_METADATA_MAX`) keeps under; and the
 * serve's own statement shape (the stamp and the snapshot in one UPDATE) passes on a row being
 * served for the first time.
 *
 * MUTATIONS (each applied to the migration text, run, and restored from a copy): drop
 * `inputs_served_at IS NOT NULL`; drop `json_valid(served_metadata)`; widen the bound to 65537.
 * Each turned a named test red.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { SERVED_METADATA_MAX } from "../src/services/decision-card";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

const FILE = "0163_publication_review_served_metadata.sql";

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
  // Rows already on record: one served and reported, one dispatched and never served.
  await d1
    .prepare(
      `INSERT INTO publication_reviews
         (id, request_id, dataset_id, head_sha, anonymous, requested_by, state, verdict, report,
          decided_at, claimed_at, inputs_served_at)
       VALUES (1, 1, 'nm000901', ?, 0, 1, 'reported', 'pass', '{}', datetime('now'),
               datetime('now'), datetime('now'))`,
    )
    .bind("a".repeat(40))
    .run();
  await d1
    .prepare(
      `INSERT INTO publication_reviews
         (id, request_id, dataset_id, head_sha, anonymous, requested_by, state, nonce, claimed_at)
       VALUES (2, 2, 'nm000902', ?, 0, 1, 'dispatched', 'n', datetime('now'))`,
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

describe("migration 0163 on Miniflare D1", () => {
  test("rows from before the migration read back NULL", async () => {
    const rows = await d1
      .prepare("SELECT id, served_metadata FROM publication_reviews ORDER BY id")
      .all<{ id: number; served_metadata: string | null }>();
    expect(rows.results).toEqual([
      { id: 1, served_metadata: null },
      { id: 2, served_metadata: null },
    ]);
  });

  test("a row whose inputs were never served cannot carry it", async () => {
    expect(
      await refusal("UPDATE publication_reviews SET served_metadata = '{}' WHERE id = 2"),
    ).toContain("CHECK");
  });

  test("it holds JSON only", async () => {
    const set = "UPDATE publication_reviews SET served_metadata = ? WHERE id = 1";
    expect(await refusal(set, "not json")).toContain("CHECK");
    expect(await refusal(set, JSON.stringify({ v: 1 }))).toBeNull();
  });

  test(`its length is at most ${SERVED_METADATA_MAX}`, async () => {
    const set = "UPDATE publication_reviews SET served_metadata = ? WHERE id = 1";
    const of = (n: number) => JSON.stringify("x".repeat(n - 2));
    expect(await refusal(set, of(SERVED_METADATA_MAX))).toBeNull();
    expect(await refusal(set, of(SERVED_METADATA_MAX + 1))).toContain("CHECK");
  });

  test("the serve's statement stamps and snapshots a first serve in one UPDATE", async () => {
    expect(
      await refusal(
        `UPDATE publication_reviews
            SET inputs_served_at = COALESCE(inputs_served_at, datetime('now')), lineage_basis = ?,
                served_metadata = ?
          WHERE id = 2 AND claimed_at IS NOT NULL AND state IN ('dispatched', 'unreported')`,
        "{}",
        JSON.stringify({ v: 1 }),
      ),
    ).toBeNull();
    const row = await d1
      .prepare("SELECT served_metadata FROM publication_reviews WHERE id = 2")
      .first<{ served_metadata: string }>();
    expect(row?.served_metadata).toBe('{"v":1}');
  });
});
