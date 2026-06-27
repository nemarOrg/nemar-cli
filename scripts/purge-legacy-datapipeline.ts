#!/usr/bin/env bun
/**
 * One-off legacy DB purge (epic #837 Phase 4, part A).
 *
 * Deletes NEMAR's own `nm`/`on` dataset records from the retired
 * `nemar.org/dataexplorer` datapipeline tables, so the legacy site stops
 * showing our datasets. The legacy site's own `ds` OpenNeuro catalog is left
 * untouched (we only iterate nm/on ids).
 *
 * Like the DOI re-target, this is a guarded RUN-ONCE script, not a CLI/endpoint.
 * Reuses the slim delete-only client extracted in Phase 3
 * (`backend/src/services/legacy-purge.ts`).
 *
 * Safety: dry-run by DEFAULT; `--execute` requires NEMAR_USERNAME / NEMAR_PASSWORD
 * (the legacy datapipeline creds, in backend/.dev.vars). Idempotent — deleting a
 * dataset_id that isn't in a legacy table is a harmless no-op, so a re-run is safe.
 *
 * Usage (from repo root):
 *   bun scripts/purge-legacy-datapipeline.ts                                   # dry-run: list targets
 *   NEMAR_USERNAME=.. NEMAR_PASSWORD=.. bun scripts/purge-legacy-datapipeline.ts --execute
 *   ... --only nm000132        # single dataset
 *   ... --concurrency 4
 */

import { execFileSync } from "node:child_process";
import {
  LEGACY_TABLES,
  deleteRecords,
  getAccessToken,
} from "../backend/src/services/legacy-purge.js";

const SCCN_ACCOUNT_ID = "da8d7a2a8680dab01592bbbc6f67f12c";

function d1DatasetIds(only?: string): string[] {
  const where = only
    ? `dataset_id = '${only}'`
    : "(dataset_id LIKE 'nm%' OR dataset_id LIKE 'on%')";
  const out = execFileSync(
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
      "--json",
      "--command",
      `SELECT dataset_id FROM datasets WHERE ${where} ORDER BY dataset_id`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: SCCN_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: "" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const match = out.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) throw new Error(`Could not parse D1 JSON from cfman output:\n${out.slice(0, 500)}`);
  const parsed = JSON.parse(match[0]) as Array<{ results?: Array<{ dataset_id: string }> }>;
  return (parsed[0]?.results ?? []).map((r) => r.dataset_id);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function runPool<T>(items: T[], concurrency: number, worker: (it: T) => Promise<void>) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) await worker(items[idx++]);
  });
  await Promise.all(runners);
}

async function main() {
  const execute = flag("--execute");
  const only = arg("--only");
  const concurrency = Number(arg("--concurrency") ?? "4");

  const ids = d1DatasetIds(only);
  console.log(
    `Mode: ${execute ? "EXECUTE" : "DRY-RUN"}${only ? `  only=${only}` : ""}\n` +
      `Datasets to purge from legacy (${LEGACY_TABLES.length} tables each): ${ids.length}\n`,
  );

  if (!execute) {
    for (const id of ids) console.log(`  ${id}`);
    console.log("\nDry-run only. Re-run with --execute (needs NEMAR_USERNAME/NEMAR_PASSWORD).");
    return;
  }

  const username = process.env.NEMAR_USERNAME;
  const password = process.env.NEMAR_PASSWORD;
  if (!username || !password) {
    console.error("NEMAR_USERNAME and NEMAR_PASSWORD must be set for --execute.");
    process.exit(1);
  }
  const { token } = await getAccessToken(username, password);

  const counts = { purged: 0, failed: 0 };
  await runPool(ids, concurrency, async (id) => {
    try {
      for (const table of LEGACY_TABLES) {
        await deleteRecords(token, table, id);
      }
      counts.purged++;
      console.log(`  OK: ${id}`);
    } catch (err) {
      counts.failed++;
      console.error(`  FAIL: ${id} (${err instanceof Error ? err.message : err})`);
    }
  });

  console.log(`\nDone. purged=${counts.purged} failed=${counts.failed}`);
  if (counts.failed > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
