#!/usr/bin/env bun
/**
 * One-off `ds`-shadow deletion (epic #837 Phase 4, part B).
 *
 * Deletes the legacy `ds######` shadow rows (the folded OpenNeuro catalog,
 * owner=SYSTEM) from D1 + Vectorize so the new system stops indexing them.
 * Fixes #748 (search returning these backing-less shadows).
 *
 * PRECONDITION: the incoming catalog-sync MUST be stopped first (the GitHub
 * "Catalog Sync" workflow disabled and/or the /admin/catalog/sync endpoint
 * removed on prod), otherwise the 4h cron re-folds these rows within hours.
 *
 * Guarded RUN-ONCE script, not a CLI/endpoint. Dry-run by DEFAULT (prints
 * counts + writes a snapshot); `--execute` performs the deletes. Snapshots the
 * full `ds` rows to a file first; D1 is also hourly-backed-up (#655) and the
 * datasets are re-importable from OpenNeuro as `on` rows.
 *
 * Usage (from repo root):
 *   bun scripts/delete-ds-rows.ts                          # dry-run: counts + snapshot
 *   bun scripts/delete-ds-rows.ts --execute                # APPLY (D1 + Vectorize)
 *   bun scripts/delete-ds-rows.ts --execute --skip-vectorize
 */

import { execFileSync } from "node:child_process";

const SCCN_ACCOUNT_ID = "da8d7a2a8680dab01592bbbc6f67f12c";
const VECTORIZE_INDEX = "nemar-dataset-index";

// Child tables first (no ON DELETE CASCADE from datasets), then `datasets`
// last (its delete cascades to datasets_fts via trigger and to
// dataset_collaborators / access_requests via FK). import_jobs is intentionally
// preserved (audit trail, see migration 0044).
const DS = "dataset_id LIKE 'ds%'";
export const DELETE_STATEMENTS: ReadonlyArray<{ label: string; sql: string }> = [
  {
    label: "user_s3_permissions",
    sql: `DELETE FROM user_s3_permissions WHERE s3_prefix LIKE 'ds%'`,
  },
  { label: "manifest_jobs", sql: `DELETE FROM manifest_jobs WHERE ${DS}` },
  { label: "publication_requests", sql: `DELETE FROM publication_requests WHERE ${DS}` },
  { label: "dataset_versions", sql: `DELETE FROM dataset_versions WHERE ${DS}` },
  { label: "datasets", sql: `DELETE FROM datasets WHERE ${DS}` },
];

function cfmanD1(sqlOrFlags: string[], capture = true): string {
  return execFileSync(
    "npx",
    [
      "cfman",
      "wrangler",
      "--account",
      "sccn",
      "-c",
      "backend/wrangler-sccn.toml",
      "d1",
      "execute",
      "nemar-db",
      "--remote",
      ...sqlOrFlags,
    ],
    {
      encoding: "utf8",
      stdio: capture ? "pipe" : "inherit",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: SCCN_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: "" },
      maxBuffer: 256 * 1024 * 1024,
    },
  );
}

function d1Json<T>(sql: string): T[] {
  const out = cfmanD1(["--json", "--command", sql]);
  const match = out.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) throw new Error(`Could not parse D1 JSON:\n${out.slice(0, 500)}`);
  const parsed = JSON.parse(match[0]) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

/** Turn a `DELETE FROM <table> WHERE ...` into the matching `SELECT COUNT(*)`. */
export function toCountSql(deleteSql: string): string {
  return deleteSql.replace(/^DELETE FROM (\S+) WHERE/, "SELECT COUNT(*) AS n FROM $1 WHERE");
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const execute = flag("--execute");
  const skipVectorize = flag("--skip-vectorize");

  const ids = d1Json<{ dataset_id: string }>(
    `SELECT dataset_id FROM datasets WHERE ${DS} ORDER BY dataset_id`,
  ).map((r) => r.dataset_id);
  console.log(`Mode: ${execute ? "EXECUTE" : "DRY-RUN"}\nds shadow rows: ${ids.length}\n`);
  if (ids.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  // Per-table counts so the operator sees the blast radius before deleting.
  for (const s of DELETE_STATEMENTS) {
    try {
      const n = d1Json<{ n: number }>(toCountSql(s.sql))[0]?.n ?? 0;
      console.log(`  ${s.label}: ${n} rows`);
    } catch (err) {
      console.warn(`  ${s.label}: count failed (${err instanceof Error ? err.message : err})`);
    }
  }

  // Snapshot the full datasets rows before deleting (belt + suspenders; D1 is
  // also hourly-backed-up). Written to scripts/ts-output next to the run.
  const snapshot = d1Json<Record<string, unknown>>(`SELECT * FROM datasets WHERE ${DS}`);
  const snapPath = "ds-rows-snapshot.json";
  await Bun.write(snapPath, JSON.stringify(snapshot, null, 2));
  console.log(`\nSnapshot of ${snapshot.length} datasets rows -> ${snapPath}`);

  if (!execute) {
    console.log(
      "\nDry-run only. Re-run with --execute. (Ensure the catalog-sync cron is OFF first.)",
    );
    return;
  }

  // D1 deletes, children first.
  for (const s of DELETE_STATEMENTS) {
    try {
      cfmanD1(["--command", s.sql], false);
      console.log(`  deleted: ${s.label}`);
    } catch (err) {
      console.error(`  FAIL ${s.label}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // Vectorize: drop the ds vectors (id == dataset_id). Harmless if absent.
  if (!skipVectorize) {
    try {
      execFileSync(
        "npx",
        [
          "cfman",
          "wrangler",
          "--account",
          "sccn",
          "-c",
          "backend/wrangler-sccn.toml",
          "vectorize",
          "delete-vectors",
          VECTORIZE_INDEX,
          "--ids",
          ...ids,
        ],
        {
          stdio: "inherit",
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: SCCN_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: "" },
        },
      );
      console.log(`  vectorize: enqueued ${ids.length} deletions`);
    } catch (err) {
      console.error(
        `  vectorize delete failed (non-fatal, D1 already done): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Verify nothing remains.
  const remaining =
    d1Json<{ n: number }>(`SELECT COUNT(*) AS n FROM datasets WHERE ${DS}`)[0]?.n ?? -1;
  console.log(`\nDone. remaining ds rows in datasets: ${remaining}`);
  if (remaining !== 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
