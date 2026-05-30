/**
 * Structural assertions on the stale-nm cron SQL in scheduledCleanup (#662).
 *
 * The reset + candidate queries can't run in a Bun unit test (D1 isn't in
 * scope), but their WHERE clauses are the load-bearing safety surface: drop
 * `concept_doi IS NULL` or `visibility = 'private'` and the cron would warn
 * (and eventually flag for deletion) published datasets; drop the
 * already-notified exclusion and a backlog could starve newly-past-deadline
 * rows out of the LIMIT. These tests pin the clauses in place so a future
 * refactor can't silently remove one.
 *
 * Pair with staleness.unit.test.ts (threshold math) and the post-deploy
 * api.test.ts assertions that the migration actually ran.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "backend/src/index.ts"), "utf8");

describe("stale-nm cron query structure", () => {
  test("the reset query clears both tracking columns", () => {
    expect(SRC).toContain("staleness_warn_stage = NULL");
    expect(SRC).toContain("staleness_admin_notified_at = NULL");
  });

  test("the staleness predicate keeps every disqualifier", () => {
    // Present in both the reset NOT(...) block and the candidate WHERE.
    expect(SRC).toContain("d.dataset_id LIKE 'nm%'");
    expect(SRC).toContain("concept_doi IS NULL");
    expect(SRC).toContain("visibility = 'private'");
    // No active publication request.
    expect(SRC).toMatch(/publication_requests WHERE status NOT IN \('published','denied'\)/);
    // Inactivity measured from last activity, falling back to creation.
    expect(SRC).toContain("COALESCE(last_activity_at, created_at) < datetime('now', ?)");
  });

  test("candidates are bounded and most-urgent first", () => {
    expect(SRC).toContain("ORDER BY effective_activity ASC");
    expect(SRC).toMatch(/LIMIT \?/);
  });

  test("already-notified past-deadline rows are excluded so they can't starve the LIMIT", () => {
    // The candidate query carries a NOT(... admin_notified_at IS NOT NULL) guard.
    expect(SRC).toMatch(
      /AND NOT \(\s*COALESCE\(d\.last_activity_at, d\.created_at\) < datetime\('now', \?\)\s*AND d\.staleness_admin_notified_at IS NOT NULL/,
    );
  });

  test("state is advanced only after a delivered notification (handled gate)", () => {
    // Both state UPDATEs must sit behind a `handled` gate, not run
    // unconditionally after a swallowed email error — the regression that
    // would silently advance stage/flag on a failed send. Each path sets
    // `handled` and each UPDATE is guarded by `if (handled)`.
    expect(SRC.match(/if \(handled\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(SRC).toContain("const delivered = await sendStalenessAdminReviewEmail(");
    expect(SRC).toContain("handled = delivered > 0");
  });
});
