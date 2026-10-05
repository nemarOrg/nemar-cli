#!/usr/bin/env bun
/**
 * Command line for the corrective-action ledger (ADR 0085, runbook step 13).
 *
 *   ledger-cli.ts append  --file F --dataset nm000186 --action headers-scrubbed \
 *                         --versions v1.0.0,v1.0.1 --counts objects=176,headers=176 \
 *                         --verification scanner-clean+payload-identical+rehash-ok --actor yahya
 *   ledger-cli.ts show    --file F
 *   ledger-cli.ts publish --file F --dataset nm000186 [--execute] [--timeout-sec 120]
 *
 * `append` validates the line (a closed vocabulary, counts only, no free text) and appends it to a
 * local file; the scanner revision is the last commit that touched the scanner unless given.
 * `publish` copies the file to `s3://nemar/<id>/corrections/ledger.jsonl`. It is a dry run unless
 * `--execute`, and it refuses unless the local file is a strict extension of the object already
 * there: the ledger is append-only, and an upload that would drop a line is refused.
 *
 * **What `publish` takes as "no ledger yet".** Only a genuine not-found from S3 (`NoSuchKey`,
 * classified from the CLI's own error line). A 403 is NOT absence on this bucket, and neither is
 * an unreachable endpoint or a 500: each refuses (`remote-ledger-unreadable`), because reading
 * "unknown" as "empty" is what would let an upload replace a longer ledger. The write is
 * conditional on what was read, so a writer that got in between is refused by S3 itself:
 * `--if-none-match '*'` for a first publish, `--if-match <ETag read>` for an extension
 * (`remote-ledger-changed`). Every `aws` call has a timeout.
 *
 * Credentials are the ambient `aws` session. Exit: 0 done, 1 failed, 2 usage, 3 refused (nothing
 * written), 4 written but not proven (the read-back after the put differed from the file, or could
 * not be made: look at the object now).
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "bun";
import type { LedgerEntry } from "./contract";
import { LedgerRefused, appendLedger, ledgerS3Key, readLedger } from "./ledger";
import {
  AwsCliError,
  DEFAULT_TIMEOUT_MS,
  type S3Ctx,
  StageError,
  TempArea,
  createAwsRunner,
  failureWord,
  installSignalCleanup,
  putObjectIfAbsent,
  putObjectIfMatch,
  readWholeWithMeta,
  requireAwsCliVersion,
} from "./s3/s3-lib";

class Usage extends Error {}
class Refused extends Error {}
/** The put was accepted but what reads back is not the file: exit 4, never "done". */
class Unproven extends Error {}

export const EXIT_UNPROVEN = 4;

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
  "timeout-sec": { type: "string" },
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

interface Remote {
  text: string;
  etag: string;
}

/**
 * The ledger object as it is now, or null for a genuine not-found (a first publish). Anything
 * else is a refusal naming the operation and the class, never a guess: a 403 on this bucket
 * also answers for a key that exists.
 */
async function readRemote(ctx: S3Ctx, key: string): Promise<Remote | null> {
  let got: Awaited<ReturnType<typeof readWholeWithMeta>>;
  try {
    got = await readWholeWithMeta(ctx, key);
  } catch (err) {
    if (err instanceof AwsCliError && err.code === "not-found") return null;
    throw new Refused(`remote-ledger-unreadable (${failureWord(err)})`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(got.bytes);
  } catch {
    throw new Refused("remote-ledger-not-utf8");
  }
  return { text, etag: got.etag };
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
    const timeoutSec = v["timeout-sec"] ?? String(DEFAULT_TIMEOUT_MS / 1000);
    if (!/^\d+$/.test(timeoutSec) || Number(timeoutSec) < 1) throw new Usage("bad --timeout-sec");
    const key = ledgerS3Key(dataset);
    const local = readFileSync(file, "utf8");
    await requireAwsCliVersion();
    const tmp = await TempArea.create();
    try {
      const ctx: S3Ctx = {
        aws: createAwsRunner({ region, timeoutMs: Number(timeoutSec) * 1000 }),
        bucket,
        tmp,
      };
      const remote = await readRemote(ctx, key);
      if (remote !== null) {
        // A remote that does not end in a newline ends in a partial line: no whole-line extension
        // of it exists, so it is not a base to build on.
        if (remote.text !== "" && !remote.text.endsWith("\n")) {
          throw new Refused("remote-ledger-partial-line");
        }
        if (!extendsLedger(remote.text, local)) throw new Refused("not-an-append");
      }
      log(
        `${v.execute ? "publish" : "dry run"}: s3://${bucket}/${key} ${
          remote === null
            ? "(new)"
            : `(extends ${remote.text.split("\n").filter(Boolean).length} line(s))`
        } with ${entries.length} line(s)`,
      );
      if (!v.execute) return 0;

      // The bytes that were validated are the bytes that are put, whatever happens to the file.
      const body = tmp.file();
      await writeFile(body, local, { mode: 0o600 });
      const meta = { contentType: "application/x-ndjson" };
      try {
        if (remote === null) await putObjectIfAbsent(ctx, key, body, meta);
        else await putObjectIfMatch(ctx, key, body, meta, remote.etag);
      } catch (err) {
        // The condition failed (412, or 409 for a write in flight), or the object was deleted
        // since it was read (404 on If-Match): someone else wrote, and their version stands.
        if (
          err instanceof AwsCliError &&
          (err.code === "precondition-failed" || err.code === "not-found")
        ) {
          throw new Refused("remote-ledger-changed");
        }
        throw new Error(`put-failed (${failureWord(err)})`);
      } finally {
        await tmp.remove(body);
      }
      let after: Remote | null;
      try {
        after = await readRemote(ctx, key);
      } catch (err) {
        const why = err instanceof Refused ? err.message : failureWord(err);
        throw new Unproven(`read-back-failed-after-write (${why})`);
      }
      if (after === null || after.text !== local)
        throw new Unproven("read-back-differs-after-write");
      log("published and read back identical");
      return 0;
    } finally {
      await tmp.dispose();
    }
  }
  throw new Usage("usage: ledger-cli.ts append|show|publish --file F ...");
}

if (import.meta.main) {
  // Owner-only for every file this process and its children create.
  process.umask(0o077);
  installSignalCleanup("ledger-cli");
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
    if (error instanceof StageError) {
      // The aws CLI version gate: aws-cli-too-old, aws-cli-version-unknown (refusals).
      console.error(error.word);
      process.exit(error.exitCode);
    }
    if (error instanceof Unproven) {
      console.error(error.message);
      process.exit(EXIT_UNPROVEN);
    }
    // put-failed (PutObject:<class>) is a fixed word built here; anything else names no message.
    console.error(
      error instanceof Error && /^put-failed \(/.test(error.message) ? error.message : "failed",
    );
    process.exit(1);
  }
}
