/**
 * Pin the candidate-detection SQL for the missing-manifest check.
 *
 * The SQL filters that matter:
 *   - status='active', visibility='public': we should NEVER auto-regenerate
 *     manifests for deleted/private datasets (would leak content)
 *   - github_repo IS NOT NULL: can't regenerate without a repo to fetch from
 *   - JOIN dataset_versions: only datasets that the system thinks are published
 *
 * These predicates are load-bearing for correctness. A refactor that drops
 * one of them would either crash on null repos or leak deleted content
 * through the manifest cache; either failure mode is invisible at runtime
 * until it's already in production, so we pin the SQL string.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "backend/src/services/doctor/checks/missing-manifest.ts",
);
const source = readFileSync(SOURCE_PATH, "utf8");

describe("missing-manifest candidate SQL", () => {
  test("scopes to active + public datasets only", () => {
    expect(source).toMatch(/d\.status\s*=\s*'active'/);
    expect(source).toMatch(/d\.visibility\s*=\s*'public'/);
  });

  test("requires github_repo (can't regenerate without one)", () => {
    expect(source).toMatch(/d\.github_repo IS NOT NULL/);
  });

  test("joins dataset_versions (only published datasets are candidates)", () => {
    expect(source).toMatch(/JOIN dataset_versions dv ON dv\.dataset_id\s*=\s*d\.dataset_id/);
  });

  test("re-checks S3 presence inside fix() before writing", () => {
    // Idempotency guard: a second fix() call (or a parallel job) that
    // observes the manifest already present should return skipped, not
    // re-upload. The pattern is `existing !== null` → return skipped.
    expect(source).toMatch(/existing\s*!==\s*null/);
    expect(source).toMatch(/status:\s*"skipped"/);
  });
});
