#!/usr/bin/env bun
/**
 * Command line for the corrective-action ledger (ADR 0085, runbook step 10).
 *
 *   ledger-cli.ts append  --file F --dataset nm000186 --action headers-scrubbed \
 *                         --versions v1.0.0,v1.0.1 --counts objects=176,headers=176 \
 *                         --verification scanner-clean+payload-identical+rehash-ok --actor yahya
 *   ledger-cli.ts show    --file F
 *   ledger-cli.ts publish --file F --dataset nm000186 [--execute]
 *
 * `append` validates the line (a closed vocabulary, counts only, no free text) and appends it to a
 * local file; the scanner revision is the last commit that touched the scanner unless given.
 * `publish` copies the file to `s3://nemar/<id>/corrections/ledger.jsonl`. It is a dry run unless
 * `--execute`, and it refuses unless the local file is a strict extension of the object already
 * there: the ledger is append-only, and an upload that would drop a line is refused.
 *
 * Credentials are the ambient `aws` session. Exit: 0 done, 1 failed, 2 usage, 3 refused.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawn, spawnSync } from "bun";
import type { LedgerEntry } from "./contract";
import { LedgerRefused, appendLedger, ledgerS3Key, readLedger } from "./ledger";

class Usage extends Error {}
class Refused extends Error {}

const OPTIONS = {
  file: { type: "string" },
  dataset: { type: "string" },
  action: { type: "string" },
  versions: { type: "string" },
  counts: { type: "string" },
  verification: { type: "string" },
  actor: { type: "string" },
  scanner: { type: "string" },
  at: { type: "string" },
  bucket: { type: "string" },
  region: { type: "string" },
  execute: { type: "boolean" },
} as const;

const need = (v: string | undefined, name: string): string => {
  if (!v) throw new Usage(`missing --${name}`);
  return v;
};

/** `k=v,k=v` with numeric values; anything else is refused by the ledger's own guard. */
export function parseCounts(text: string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!text) return counts;
  for (const pair of text.split(",")) {
    const [k, v] = pair.split("=");
    if (!k || v === undefined || v === "" || !/^\d+$/.test(v)) throw new Usage("bad --counts");
    counts[k] = Number(v);
  }
  return counts;
}

function scannerRevision(): string {
  const r = spawnSync(["git", "log", "-1", "--format=%h", "--", "shared/identifier-scan.ts"], {
    cwd: join(import.meta.dir, "../.."),
  });
  const rev = new TextDecoder().decode(r.stdout).trim();
  if (!/^[0-9a-f]{7,40}$/.test(rev))
    throw new Usage("cannot derive the scanner revision; pass --scanner");
  return `identifier-scan@${rev}`;
}

async function aws(args: string[], region: string): Promise<{ code: number; stdout: string }> {
  const proc = spawn({
    cmd: ["aws", "s3api", ...args, "--region", region, "--output", "json"],
    env: { ...process.env, AWS_PAGER: "", AWS_REQUEST_CHECKSUM_CALCULATION: "when_supported" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

/** The ledger object as it is now: its text, or null when there is none (a first publish). */
async function currentRemote(bucket: string, key: string, region: string): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    const out = join(dir, "remote");
    const head = await aws(["head-object", "--bucket", bucket, "--key", key], region);
    if (head.code !== 0) return null;
    const got = await aws(["get-object", "--bucket", bucket, "--key", key, out], region);
    if (got.code !== 0) throw new Refused("remote-ledger-unreadable");
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when `next` is `previous` followed by zero or more whole lines. */
export function extendsLedger(previous: string, next: string): boolean {
  return next.startsWith(previous) && (previous === "" || previous.endsWith("\n"));
}

export async function run(argv: string[], log: (line: string) => void): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch {
    throw new Usage("bad arguments");
  }
  const v = parsed.values;
  const [command] = parsed.positionals;
  const file = need(v.file, "file");
  if (command === "append") {
    const entry: LedgerEntry = {
      version: 1,
      at: v.at ?? new Date().toISOString(),
      dataset: need(v.dataset, "dataset"),
      action: need(v.action, "action") as LedgerEntry["action"],
      versions: (v.versions ?? "").split(",").filter((s) => s !== ""),
      counts: parseCounts(v.counts),
      scanner: v.scanner ?? scannerRevision(),
      verification: need(v.verification, "verification"),
      actor: need(v.actor, "actor"),
    } as LedgerEntry;
    appendLedger(file, entry);
    log(`appended ${entry.action} for ${entry.dataset}`);
    return 0;
  }
  if (command === "show") {
    const entries = readLedger(file);
    for (const e of entries) {
      log(`${e.at} ${e.dataset} ${e.action} ${e.verification} ${JSON.stringify(e.counts)}`);
    }
    return 0;
  }
  if (command === "publish") {
    const dataset = need(v.dataset, "dataset");
    const entries = readLedger(file); // validates every line
    if (entries.length === 0) throw new Refused("ledger-empty");
    if (entries.some((e) => e.dataset !== dataset)) throw new Refused("ledger-other-dataset");
    const bucket = v.bucket ?? "nemar";
    const region = v.region ?? "us-east-2";
    const key = ledgerS3Key(dataset);
    const local = readFileSync(file, "utf8");
    const remote = await currentRemote(bucket, key, region);
    if (remote !== null && !extendsLedger(remote, local)) throw new Refused("not-an-append");
    log(
      `${v.execute ? "publish" : "dry run"}: s3://${bucket}/${key} ${
        remote === null ? "(new)" : `(extends ${remote.split("\n").filter(Boolean).length} line(s))`
      } with ${entries.length} line(s)`,
    );
    if (!v.execute) return 0;
    const put = await aws(
      [
        "put-object",
        "--bucket",
        bucket,
        "--key",
        key,
        "--body",
        file,
        "--content-type",
        "application/x-ndjson",
      ],
      region,
    );
    if (put.code !== 0) throw new Error("put-failed");
    const after = await currentRemote(bucket, key, region);
    if (after !== local) throw new Error("read-back-differs");
    log("published and read back identical");
    return 0;
  }
  throw new Usage("usage: ledger-cli.ts append|show|publish --file F ...");
}

if (import.meta.main) {
  try {
    process.exit(await run(process.argv.slice(2), (l) => console.log(l)));
  } catch (error) {
    if (error instanceof Usage) {
      console.error(error.message);
      process.exit(2);
    }
    if (error instanceof Refused || error instanceof LedgerRefused) {
      console.error(error.message);
      process.exit(3);
    }
    console.error("failed");
    process.exit(1);
  }
}
