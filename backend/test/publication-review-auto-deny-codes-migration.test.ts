/**
 * Migration 0164_publication_review_auto_deny_codes.sql (ADR 0139, decisions 1 and 4, as amended on
 * 2026-11-27) on Miniflare's D1, the implementation `wrangler --local` runs: bun:sqlite is more
 * permissive than the SQLite D1 ships, so a CHECK proven only there is not proven.
 *
 * What is pinned: rows that existed before the migration read back NULL; the column is a first
 * run's alone (setting it on a confirming row is refused); its length is 1 to 512 (0 and 513 are
 * refused).
 *
 * MUTATIONS (each applied to the migration text, run, and restored): drop `confirm_of IS NULL`
 * from the CHECK; widen the bound to 513; lower the bound to 0.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

const FILE = "0164_publication_review_auto_deny_codes.sql";

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
  // Rows already on record: a first run that agreed in shadow mode, and its confirming run.
  await d1
    .prepare(
      `INSERT INTO publication_reviews
         (id, request_id, dataset_id, head_sha, anonymous, requested_by, state, verdict, report,
          decided_at, auto_deny_state, auto_deny_at)
       VALUES (1, 1, 'nm000901', ?, 0, 1, 'reported', 'fail', '{}', datetime('now'), 'would_deny',
               datetime('now'))`,
    )
    .bind("a".repeat(40))
    .run();
  await d1
    .prepare(
      `INSERT INTO publication_reviews
         (id, request_id, dataset_id, head_sha, anonymous, requested_by, state, verdict, report,
          decided_at, confirm_of)
       VALUES (2, 1, 'nm000901', ?, 0, 1, 'reported', 'fail', '{}', datetime('now'), 1)`,
    )
    .bind("a".repeat(40))
    .run();
  await applyMigrations(
    d1,
    migrationFiles().filter((f) => f >= FILE),
  );
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("migration 0164 on Miniflare D1", () => {
  test("rows from before the migration read back NULL", async () => {
    const rows = await d1
      .prepare("SELECT id, auto_deny_codes FROM publication_reviews ORDER BY id")
      .all<{ id: number; auto_deny_codes: string | null }>();
    expect(rows.results).toEqual([
      { id: 1, auto_deny_codes: null },
      { id: 2, auto_deny_codes: null },
    ]);
  });

  test("a confirming row cannot carry it", async () => {
    expect(
      await refusal(
        "UPDATE publication_reviews SET auto_deny_codes = 'readme_missing_or_stub' WHERE id = 2",
      ),
    ).toContain("CHECK");
  });

  test("its length is 1 to 512", async () => {
    const set = "UPDATE publication_reviews SET auto_deny_codes = ? WHERE id = 1";
    expect(await refusal(set, "")).toContain("CHECK");
    expect(await refusal(set, "x".repeat(513))).toContain("CHECK");
    expect(await refusal(set, "x".repeat(512))).toBeNull();
    expect(await refusal(set, "readme_missing_or_stub,authors_placeholder")).toBeNull();
    const row = await d1
      .prepare("SELECT auto_deny_codes FROM publication_reviews WHERE id = 1")
      .first<{ auto_deny_codes: string }>();
    expect(row?.auto_deny_codes).toBe("readme_missing_or_stub,authors_placeholder");
  });
});
