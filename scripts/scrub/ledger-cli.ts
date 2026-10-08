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
 * local file. The scanner revision is the last commit that touched ANY of the files whose rules
 * decided what was removed ({@link SCANNER_RULE_FILES}), unless given.
 *
 * `old-versions-deleted` is not typed, it is read: it needs `--proof W/deleted.json` (the file
 * delete-old writes only after an authoritative listing showed nothing left), takes its counts from
 * it (`--counts` is refused beside it), checks it names this dataset, and records
 * `authoritative-listing-empty+proof-<first 16 hex of its sha256>` as the verification.
 * A `delete-old` run that was interrupted and run again writes `deleted.json` with the counts of
 * the LAST run only (what the first one removed is no longer there to count). The operator adds
 * those, read from the earlier run's own `delete-old: ...` lines, with `--earlier-run-counts`
 * (`versions`, `markers`, `pruned_versions`, `pruned_markers`, and `raw_versions`, `raw_markers`
 * when the proof has raw counts; summed with the proof's, and only beside `--proof`), so the line
 * says what was deleted in all rather than in the last run. A proof whose plan had raw copies
 * carries `rawVersions` and `rawMarkers`, and the line then has `raw_versions` and `raw_markers`.
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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "bun";
import { ContractError, type LedgerEntry, parseDeleted } from "./contract";
import {
  DELETION_VERIFICATION,
  LedgerRefused,
  appendLedger,
  ledgerS3Key,
  parseLedgerText,
  readLedger,
} from "./ledger";
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
  proof: { type: "string" },
  "earlier-run-counts": { type: "string" },
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

/**
 * The files whose rules decided what a scrub removed: the scanner, the header scrub, and the Zarr
 * member lists. A change to any of them is a change of the rules a ledger line ran under.
 */
export const SCANNER_RULE_FILES = [
  "shared/identifier-scan.ts",
  "shared/identifier-scrub.ts",
  "scripts/scrub/s3/zarr-json.ts",
] as const;

/** `identifier-scan@<short sha>` of the last commit in `repoRoot` that touched any rule file. */
export function scannerRevision(repoRoot: string = join(import.meta.dir, "../..")): string {
  const r = spawnSync(["git", "log", "-1", "--format=%h", "--", ...SCANNER_RULE_FILES], {
    cwd: repoRoot,
  });
  const rev = new TextDecoder().decode(r.stdout).trim();
  if (!/^[0-9a-f]{7,40}$/.test(rev))
    throw new Usage("cannot derive the scanner revision; pass --scanner");
  return `identifier-scan@${rev}`;
}

/** Counts and the verification word of an `old-versions-deleted` line, from deleted.json. */
function fromDeletionProof(
  path: string,
  dataset: string,
): { counts: Record<string, number>; verification: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Refused("proof-missing");
  }
  let proof: ReturnType<typeof parseDeleted>;
  try {
    proof = parseDeleted(bytes.toString("utf8"));
  } catch (err) {
    if (err instanceof ContractError || err instanceof SyntaxError) {
      throw new Refused("proof-invalid");
    }
    throw err;
  }
  if (proof.dataset !== dataset) throw new Refused("proof-wrong-dataset");
  const c = proof.counts;
  return {
    counts: {
      keys: c.keys,
      versions: c.versions,
      markers: c.markers,
      pruned_versions: c.prunedVersions,
      pruned_markers: c.prunedMarkers,
      // Only a deletion whose plan had raw copies says how many of them went (the pair, or neither).
      ...(c.rawVersions !== undefined && c.rawMarkers !== undefined
        ? { raw_versions: c.rawVersions, raw_markers: c.rawMarkers }
        : {}),
    },
    verification: `${DELETION_VERIFICATION}+proof-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`,
  };
}

/** The counts of a `delete-old` run that can have an earlier, interrupted run behind it. */
const EARLIER_RUN_COUNT_NAMES = [
  "versions",
  "markers",
  "pruned_versions",
  "pruned_markers",
  "raw_versions",
  "raw_markers",
];
/** The two a proof carries only when its plan had raw copies. */
const RAW_COUNT_NAMES = ["raw_versions", "raw_markers"];

/**
 * Add the counts of an earlier, interrupted run to the proof's. Only the names a run removes
 * (never `keys`, which is the plan's), each a number the operator read from that run's own lines.
 * `raw_versions` and `raw_markers` only when the proof has them: a plan without raw copies deleted
 * none in any run, so a raw count beside such a proof is a mistake, not a sum.
 */
function addEarlierRun(
  counts: Record<string, number>,
  earlier: string | undefined,
): Record<string, number> {
  if (earlier === undefined) return counts;
  const extra = parseCounts(earlier);
  const out = { ...counts };
  for (const [name, n] of Object.entries(extra)) {
    if (!EARLIER_RUN_COUNT_NAMES.includes(name)) throw new Usage("bad --earlier-run-counts");
    if (RAW_COUNT_NAMES.includes(name) && !(name in counts)) {
      throw new Usage("bad --earlier-run-counts: the proof has no raw copies");
    }
    out[name] = (out[name] ?? 0) + n;
  }
  return out;
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
    const dataset = need(v.dataset, "dataset");
    const action = need(v.action, "action") as LedgerEntry["action"];
    let counts: Record<string, number>;
    let verification: string;
    if (action === "old-versions-deleted" || v.verification === DELETION_VERIFICATION) {
      // Read, never typed: the counts and the claim come from the proof delete-old wrote.
      if (action !== "old-versions-deleted") throw new Refused("verification-needs-deletion");
      if (!v.proof) throw new Usage("missing --proof (old-versions-deleted reads deleted.json)");
      if (v.counts) throw new Usage("--counts is read from --proof for old-versions-deleted");
      if (v.verification !== undefined && v.verification !== DELETION_VERIFICATION) {
        throw new Refused("verification-contradicts-proof");
      }
      ({ counts, verification } = fromDeletionProof(v.proof, dataset));
      counts = addEarlierRun(counts, v["earlier-run-counts"]);
    } else {
      if (v.proof) throw new Usage("--proof is only for old-versions-deleted");
      if (v["earlier-run-counts"] !== undefined) {
        throw new Usage("--earlier-run-counts is only for old-versions-deleted");
      }
      counts = parseCounts(v.counts);
      verification = need(v.verification, "verification");
    }
    const entry: LedgerEntry = {
      version: 1,
      at: v.at ?? new Date().toISOString(),
      dataset,
      action,
      versions: (v.versions ?? "").split(",").filter((s) => s !== ""),
      counts,
      scanner: v.scanner ?? scannerRevision(),
      verification,
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
    // Read ONCE: the text that is validated is the text that is put, so a line written to the
    // file between two reads cannot be published unvalidated.
    const local = readFileSync(file, "utf8");
    const entries = parseLedgerText(local); // validates every line
    if (entries.length === 0) throw new Refused("ledger-empty");
    if (entries.some((e) => e.dataset !== dataset)) throw new Refused("ledger-other-dataset");
    const bucket = v.bucket ?? "nemar";
    const region = v.region ?? "us-east-2";
    const timeoutSec = v["timeout-sec"] ?? String(DEFAULT_TIMEOUT_MS / 1000);
    if (!/^\d+$/.test(timeoutSec) || Number(timeoutSec) < 1) throw new Usage("bad --timeout-sec");
    const key = ledgerS3Key(dataset);
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
