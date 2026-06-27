#!/usr/bin/env bun
/**
 * One-off DOI re-target (epic #837 Phase 2).
 *
 * Re-points every NEMAR EZID DOI's `_target` (the doi.org resolution target)
 * from the retired legacy `nemar.org/dataexplorer/detail?dataset_id=<id>` to the
 * canonical `https://nemar.org/dataset/<id>` (version DOIs: `?v=v<version>`),
 * which the live Cloudflare forwarder redirects to ww2.
 *
 * Deliberately NOT a CLI command or an admin endpoint: a standing "mass-mutate
 * 1,182 production DOIs" capability is a footgun. This is a guarded, run-once
 * ops script. It is committed as a record but is not part of the deployed
 * product.
 *
 * Safety properties:
 *   - dry-run by DEFAULT (no `--execute` => no writes; no EZID creds needed).
 *   - `--execute` requires EZID_USERNAME / EZID_PASSWORD in the env.
 *   - idempotent + resumable: each identifier is read first and skipped when its
 *     `_target` already equals the canonical URL, so a re-run after an
 *     interruption only touches what's left.
 *   - reversible: EZID `_target` is mutable; a mistake can be re-updated.
 *   - `--only <datasetId>` canaries a single dataset (concept + its versions).
 *
 * Scope note: this updates only the `_target`. The DataCite metadata's
 * secondary `IsDescribedBy` related-identifier (also the legacy URL on old
 * records) self-heals on the next enrichment / `nemar admin doi update`, which
 * rebuilds the XML with the canonical URL (Phase 1). Resolution is what matters
 * here, and that is the `_target`.
 *
 * Usage (from repo root):
 *   bun scripts/retarget-dois.ts                                  # dry-run: print the plan (no creds)
 *   EZID_USERNAME=.. EZID_PASSWORD=.. bun scripts/retarget-dois.ts --verify    # read EZID, show current vs new
 *   EZID_USERNAME=.. EZID_PASSWORD=.. bun scripts/retarget-dois.ts --execute   # APPLY
 *   ... --only nm000132                                           # canary one dataset
 *   ... --inventory rows.json                                     # offline raw inventory instead of D1
 *   ... --concurrency 5
 */

import { execFileSync } from "node:child_process";
import { type EzidAuth, getIdentifier, updateIdentifier } from "../backend/src/services/ezid.js";
import { isRetryable } from "../backend/src/services/retry.js";
import { datasetLandingUrl, datasetVersionLandingUrl } from "../shared/datacite-constants.js";

const SCCN_ACCOUNT_ID = "da8d7a2a8680dab01592bbbc6f67f12c";

export interface ConceptRow {
  dataset_id: string;
  ezid_identifier: string;
}
export interface VersionRow {
  dataset_id: string;
  version: string;
  ezid_identifier: string;
}
export interface RawInventory {
  concepts: ConceptRow[];
  versions: VersionRow[];
}

export interface RetargetItem {
  identifier: string;
  target: string;
  kind: "concept" | "version";
  datasetId: string;
  version?: string;
}

/**
 * Pure plan builder: raw D1 rows -> the ordered list of (identifier, new target)
 * updates. The version identifier mirrors how it was minted in admin.ts /
 * doi.ts: `<conceptIdentifier>.V<VERSION>` (version upper-cased). Unit-tested.
 */
export function planRetarget(inv: RawInventory): RetargetItem[] {
  const items: RetargetItem[] = [];
  for (const c of inv.concepts) {
    items.push({
      identifier: c.ezid_identifier,
      target: datasetLandingUrl(c.dataset_id),
      kind: "concept",
      datasetId: c.dataset_id,
    });
  }
  for (const v of inv.versions) {
    items.push({
      identifier: `${v.ezid_identifier}.V${v.version.toUpperCase()}`,
      target: datasetVersionLandingUrl(v.dataset_id, v.version),
      kind: "version",
      datasetId: v.dataset_id,
      version: v.version,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// D1 inventory (via cfman) -- or an offline --inventory file
// ---------------------------------------------------------------------------

function d1Query<T>(sql: string): T[] {
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
      sql,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: SCCN_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: "" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // cfman decorates stdout; extract the JSON array wrangler emits.
  const match = out.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!match) throw new Error(`Could not parse D1 JSON from cfman output:\n${out.slice(0, 500)}`);
  const parsed = JSON.parse(match[0]) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

function fetchInventory(only?: string): RawInventory {
  const where = only ? ` AND dataset_id = '${only}'` : "";
  const concepts = d1Query<ConceptRow>(
    `SELECT dataset_id, ezid_identifier FROM datasets WHERE ezid_identifier IS NOT NULL${where} ORDER BY dataset_id`,
  );
  const vWhere = only ? ` AND dv.dataset_id = '${only}'` : "";
  const versions = d1Query<VersionRow>(
    `SELECT dv.dataset_id AS dataset_id, dv.version AS version, d.ezid_identifier AS ezid_identifier
     FROM dataset_versions dv JOIN datasets d ON dv.dataset_id = d.dataset_id
     WHERE d.ezid_identifier IS NOT NULL AND dv.doi IS NOT NULL AND dv.doi LIKE '10.82901%'${vWhere}
     ORDER BY dv.dataset_id, dv.version`,
  );
  return { concepts, versions };
}

// ---------------------------------------------------------------------------
// Concurrency + retry
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Use the project's structural classifier (HttpError.status / status-prefixed
      // message) so a 4xx stops early while a dataset id like "nm000401" never
      // false-matches a "401". Idempotent re-runs recover anything not retried.
      if (!isRetryable(err)) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw new Error(
    `${label} failed after retries: ${lastErr instanceof Error ? lastErr.message : lastErr}`,
  );
}

async function runPool<T>(items: T[], concurrency: number, worker: (it: T) => Promise<void>) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const it = items[idx++];
      await worker(it);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const execute = flag("--execute");
  const verify = flag("--verify");
  const only = arg("--only");
  const inventoryFile = arg("--inventory");
  const concurrency = Number(arg("--concurrency") ?? "5");
  const readsEzid = execute || verify;

  let auth: EzidAuth | null = null;
  if (readsEzid) {
    const username = process.env.EZID_USERNAME;
    const password = process.env.EZID_PASSWORD;
    if (!username || !password) {
      console.error("EZID_USERNAME and EZID_PASSWORD must be set for --verify / --execute.");
      process.exit(1);
    }
    auth = { username, password };
  }

  const inv: RawInventory = inventoryFile
    ? JSON.parse(await Bun.file(inventoryFile).text())
    : fetchInventory(only);
  const plan =
    only && inventoryFile
      ? planRetarget(inv).filter((i) => i.datasetId === only)
      : planRetarget(inv);

  const mode = execute ? "EXECUTE" : verify ? "VERIFY (read-only)" : "DRY-RUN (plan only)";
  const onlyNote = only ? `  only=${only}` : "";
  console.log(
    `Mode: ${mode}${onlyNote}\nPlanned updates: ${plan.length} (${inv.concepts.length} concept + ${inv.versions.length} version)\n`,
  );

  if (!readsEzid) {
    for (const it of plan) console.log(`  ${it.identifier}\n    -> ${it.target}`);
    console.log("\nDry-run only. Re-run with --verify (read EZID) or --execute (apply).");
    return;
  }

  const counts = { updated: 0, alreadyOk: 0, wouldChange: 0, failed: 0, missing: 0 };
  await runPool(plan, concurrency, async (it) => {
    try {
      const current = await withRetry(
        () => getIdentifier(auth, it.identifier),
        `get ${it.identifier}`,
      );
      if (current.target === it.target) {
        counts.alreadyOk++;
        return;
      }
      if (!execute) {
        counts.wouldChange++;
        console.log(`  WOULD: ${it.identifier}\n    ${current.target}\n    -> ${it.target}`);
        return;
      }
      await withRetry(
        () => updateIdentifier(auth as EzidAuth, it.identifier, { target: it.target }),
        `update ${it.identifier}`,
      );
      counts.updated++;
      console.log(`  OK: ${it.identifier} -> ${it.target}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/\b404\b|no such identifier|bad request/i.test(msg)) {
        counts.missing++;
        console.warn(`  MISSING/SKIP: ${it.identifier} (${msg})`);
        return;
      }
      counts.failed++;
      console.error(`  FAIL: ${it.identifier} (${msg})`);
    }
  });

  console.log(
    `\nDone. updated=${counts.updated} alreadyOk=${counts.alreadyOk} wouldChange=${counts.wouldChange} missing=${counts.missing} failed=${counts.failed}`,
  );
  if (counts.failed > 0) process.exit(1);
}

// Only run when invoked directly (so the unit test can import planRetarget).
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
