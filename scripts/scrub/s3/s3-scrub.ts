#!/usr/bin/env bun
/**
 * S3 stages of an in-place privacy scrub of a published dataset (ADR 0085).
 *
 *   plan       --dataset ID --out DIR [--tags v1,v2] [--bucket nemar]
 *   assemble   --dir DIR [--execute] [--concurrency 4]
 *   verify     --dir DIR [--samples 8]
 *   raw-verify --dir DIR [--git-blobs git-blobs.txt]
 *   delete-old --dir DIR --confirm-dataset ID [--execute] [--verified verified.json]
 *              [--hash-verified new-hash-verified.json] [--git-verified git-verified.json]
 *              [--max-delete N]
 *              [--prune-noncurrent <prefix>]... [--max-prune N] [--public-base URL]
 *   zarr       --dir DIR [--execute] [--concurrency 4] [--allow-member NAME]...
 *              [--max-zarr-json N]
 *   drop-archives --dir DIR --confirm-dataset ID [--execute] [--concurrency 4]
 *              [--verified verified.json] [--hash-verified new-hash-verified.json]
 *              [--git-verified git-verified.json]
 *   zarr-public --dataset ID --zarr-verified F [--public-base URL] [--bucket nemar]
 *              [--concurrency 8]
 *   canary     --prefix <nm099999|xx09[0-8]NNN>/canary-<random>/ [--execute] [--multipart] [--batch]
 *              [--bucket nemar]
 *
 * Every subcommand is read-only unless it is given `--execute`; `plan`, `verify`, `raw-verify` and
 * `zarr-public` have no `--execute` because they never write to S3 (`raw-verify` reads no S3 object
 * at all: it compares local files). Common flags: `--region` (default us-east-2),
 * `--timeout-sec` (per `aws` call, default 120; transfers get five times as long).
 *
 * Credentials are the ambient `aws` CLI session. A long-lived `AKIA` key in the environment is
 * refused (docs.nemar.org access policies). Nothing printed or written is a participant value.
 *
 * An `aws` failure no stage accounted for prints `s3-scrub: failed <Op>:<class>` (exit 1).
 *
 * Exit codes: 0 ok; 1 a stage failed; 2 usage; 3 refused (a precondition or proof is missing or
 * stale); 4 unreadable (the plan is incomplete); 5 versions or markers remain after a delete;
 * 129, 130, 143 ended by SIGHUP, SIGINT, SIGTERM (the `aws` children killed, temp files removed).
 *
 * `drop-archives` and `delete-old` evaluate every refusal before they stop: stdout has one
 * `<stage>: refused <word>: <what triggered it>` line per refusal, and the stop line joins every
 * word with `+` (`s3-scrub: archives-not-dropped+history-remains`), which with one refusal is the
 * word alone.
 */

import { parseArgs } from "node:util";
import { ContractError } from "../contract";
import { dropArchivesStage } from "./archives-stage";
import { rawVerifyStage } from "./raw-copies";
import {
  AwsCliError,
  DEFAULT_SAMPLES,
  DEFAULT_TIMEOUT_MS,
  EXIT,
  MAX_COPY_PART_BYTES,
  MIN_PART_BYTES,
  StageError,
  cliCredentialSource,
  failureWord,
  installSignalCleanup,
  requireAwsCliVersion,
} from "./s3-lib";
import {
  type CommonOptions,
  DEFAULT_PUBLIC_BASE,
  type ProofFiles,
  assembleStage,
  canaryStage,
  checkPublicBase,
  deleteOldStage,
  planStage,
  verifyStage,
} from "./s3-stages";
import { zarrPublicStage } from "./zarr-public";
import { DEFAULT_MAX_ZARR_JSON, zarrStage } from "./zarr-stage";

const USAGE = `usage: s3-scrub.ts <plan|assemble|verify|raw-verify|delete-old|zarr|drop-archives|zarr-public|canary> [options]
  plan       --dataset ID --out DIR [--tags v1,v2] [--bucket nemar] [--concurrency 8]
             also records every RAW copy under ID/objects/ (a name that is not an annex key and
             not annex-uuid) with every version and delete marker; the line ends with
             rawCopies=N versions=V markers=M.
  assemble   --dir DIR [--execute] [--concurrency 4] [--max-part-bytes N]
  verify     --dir DIR [--samples 8] [--concurrency 4]
  raw-verify --dir DIR [--git-blobs F]
             for a plan with raw copies: every raw version in raw-hashes.json (hash_stage.py
             raw-hash, for this plan.json) must match, a raw recording an annex key of the plan
             (sha256 and size) and any other raw file a blob in F (default git-blobs.txt in DIR,
             one 40-hex blob id per line, taken from the clone BEFORE the rewrite). Writes
             raw-verified.json only then; otherwise exit 1, counts by reason on the terminal and
             the names in raw-unmatched.json. Reads no S3 object.
  delete-old --dir DIR --confirm-dataset ID [--execute] [--verified F] [--hash-verified F]
             [--git-verified F] [--max-delete N] [--prune-noncurrent PREFIX]... [--max-prune N]
             [--public-base URL]
             --confirm-dataset: the dataset id again, required even for the dry run.
             --git-verified (default git-verified.json in DIR): written by
             \`git-scrub verify --fresh-clone\` over a fresh clone of what was pushed; refused
             unless its mode is fresh-clone, it names this keymap.json and plan.json (and the
             git-plan.json in DIR, when there is one), and the keymap is this assembly's
             (git-proof-missing, git-proof-stale, keymap-mismatch).
             --public-base: where an anonymous HEAD proves the dataset is private
             (default ${DEFAULT_PUBLIC_BASE}); it must answer 403. It must be https and the
             plan's bucket's own S3 endpoint (virtual-hosted or path-style).
             PREFIX is exactly ID/version/, ID/archives/ or ID/zarr/. Every one of ID/version/
             and ID/zarr/ that has history (a noncurrent version or a delete marker) must be
             named, or the run refuses (history-remains); ID/archives/ must already be empty.
             --max-delete N only lowers the plan's own count; a version of an old key that the
             plan did not record is refused whatever N is (version-not-in-plan). The count
             covers the raw copies too: a plan with raw copies deletes every raw version (with
             the bypass) and then every raw delete marker, only behind raw-verified.json for this
             plan (raw-copies-unverified), only while every annex key a raw recording matched
             and this run does not replace is current at its size (raw-duplicate-missing), and
             refuses any raw version or marker it did not record (raw-copy-not-in-plan).
             --max-prune N (default 1000) refuses to prune more noncurrent versions than N. For
             ID/zarr/ expect about one per store root the zarr step rewrote (zarr-plan.json counts
             them, and the dry run prints the exact number) plus any older versions a Zarr
             re-conversion left, so a large dataset needs a larger N than the default.
             Every refusal is evaluated and listed, one line each, and the stop line joins the
             words with +; the bucket is read once the working files agree.
  zarr       --dir DIR [--execute] [--concurrency 4] [--allow-member NAME]...
             [--max-zarr-json N]
             removes the subject and identifier members from every zarr.json under ID/zarr/
             (store roots, and arrays and groups inside stores, at most N documents, default
             ${DEFAULT_MAX_ZARR_JSON}); reads only unless --execute, and writes zarr-verified.json
             only when every document is clean after it. A recording-metadata member that no list
             names refuses the run (unknown-recording-member; names in zarr-unknown-members.json)
             until --allow-member names it. Then \`delete-old --prune-noncurrent ID/zarr/\` removes
             the noncurrent versions.
  drop-archives --dir DIR --confirm-dataset ID [--execute] [--concurrency 4]
             [--verified F] [--hash-verified F] [--git-verified F]
             deletes EVERY version and delete marker under ID/archives/ by version id, with no
             governance bypass, and ends with a listing that must show none. The archive holds the
             original recordings, so it refuses, the dry run too, until every proof is in DIR and
             names this plan, as delete-old checks them: verified.json and new-hash-verified.json
             (this assembled.json), git-verified.json (fresh-clone, this keymap.json and
             plan.json) and zarr-verified.json (this plan.json and zarr-plan.json; no-zarr only
             while no Zarr object is current). Every refusal is listed, and the dry run still
             counts what it would delete. The normal workflow rebuilds the archive afterwards.
             Writes archives-dropped.json. A lock refusal is reported and fails the stage.
  zarr-public --dataset ID --zarr-verified F [--public-base URL] [--bucket nemar]
             [--concurrency 8]
             after the dataset is public again: reads ID/zarr/index.json anonymously (default base
             ${DEFAULT_PUBLIC_BASE}) and the root of every store in the UNION of the index's stores
             and the ones zarr-verified.json (the zarr stage's proof) names, and applies the zarr
             stage's own rule to each. Refused when a store the proof names is not in the index,
             or when there is no store at all and the proof does not say no-zarr. Exit 0 only when
             at least one store was read and every one is clean, or the proof says no-zarr and
             there is none.
  canary     --prefix ID/canary-RANDOM/ [--execute] [--multipart] [--batch] [--bucket nemar]
             ID is nm099999 or a dev ephemeral sandbox id, xx090000 to xx098999; never a live
             dataset, a production sandbox or the exemplar fleet.
common: --region us-east-2  --timeout-sec 120`;

const OPTIONS = {
  dataset: { type: "string" },
  out: { type: "string" },
  dir: { type: "string" },
  tags: { type: "string" },
  bucket: { type: "string" },
  region: { type: "string" },
  prefix: { type: "string" },
  verified: { type: "string" },
  "hash-verified": { type: "string" },
  "git-verified": { type: "string" },
  "max-delete": { type: "string" },
  "max-prune": { type: "string" },
  "confirm-dataset": { type: "string" },
  "public-base": { type: "string" },
  "max-part-bytes": { type: "string" },
  "prune-noncurrent": { type: "string", multiple: true },
  "allow-member": { type: "string", multiple: true },
  "max-zarr-json": { type: "string" },
  "zarr-verified": { type: "string" },
  "git-blobs": { type: "string" },
  concurrency: { type: "string" },
  samples: { type: "string" },
  "timeout-sec": { type: "string" },
  execute: { type: "boolean" },
  multipart: { type: "boolean" },
  batch: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

function usage(msg: string): never {
  throw new StageError(msg, EXIT.usage);
}

function intFlag(v: string | undefined, name: string, dflt: number, min = 0): number {
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min) usage(`bad-${name}`);
  return Number(v);
}

function need(v: string | undefined, name: string): string {
  if (v === undefined || v === "") usage(`missing-${name}`);
  return v;
}

/** The proofs drop-archives and delete-old read, by default in the working directory. */
function proofFiles(v: Values): ProofFiles {
  return {
    verifiedFile: v.verified ?? "verified.json",
    hashVerifiedFile: v["hash-verified"] ?? "new-hash-verified.json",
    gitVerifiedFile: v["git-verified"] ?? "git-verified.json",
  };
}

function common(v: Values, log: (line: string) => void): CommonOptions {
  const region = v.region ?? "us-east-2";
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) usage("bad-region");
  const timeoutSec = intFlag(v["timeout-sec"], "timeout-sec", DEFAULT_TIMEOUT_MS / 1000, 1);
  return {
    region,
    timeoutMs: timeoutSec * 1000,
    // Tests point the CLI at a local stand-in; the CLI itself honors the variable, so this
    // only makes the override explicit.
    endpointUrl: process.env.AWS_ENDPOINT_URL_S3 || undefined,
    // With no key in the environment, every call shares one serialized credential export
    // instead of each `aws` child refreshing the login session itself, and that export accepts
    // only a short-lived (`ASIA`) key. An endpoint override does not lift that: it can name a
    // real S3 endpoint, and a profile with a long-lived key must not slip past the rule.
    credentials: process.env.AWS_ACCESS_KEY_ID ? undefined : cliCredentialSource(),
    log,
  };
}

export async function run(argv: string[], log: (line: string) => void): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch {
    usage("bad-arguments");
  }
  const v = parsed.values;
  const [command, ...rest] = parsed.positionals;
  if (v.help || command === undefined) {
    log(USAGE);
    return command === undefined && !v.help ? EXIT.usage : 0;
  }
  if (rest.length > 0) usage("unexpected-argument");
  if (process.env.AWS_ACCESS_KEY_ID?.startsWith("AKIA")) {
    throw new StageError("long-lived-key-in-environment", EXIT.refused);
  }

  // Every command but zarr-public (anonymous fetches, no CLI) and raw-verify (local files only)
  // runs `aws`, and an old CLI ignores the checksum setting the locked writes need.
  if (command !== "zarr-public" && command !== "raw-verify") await requireAwsCliVersion();

  const execute = v.execute === true;
  const opts = common(v, log);
  const concurrency = (dflt: number) => intFlag(v.concurrency, "concurrency", dflt, 1);

  switch (command) {
    case "plan":
      return planStage({
        ...opts,
        dataset: need(v.dataset, "dataset"),
        out: need(v.out, "out"),
        bucket: v.bucket ?? "nemar",
        tags: v.tags ? v.tags.split(",").filter((t) => t !== "") : undefined,
        concurrency: concurrency(8),
      });
    case "assemble": {
      const maxCopyPart = intFlag(v["max-part-bytes"], "max-part-bytes", MAX_COPY_PART_BYTES);
      if (maxCopyPart < MIN_PART_BYTES || maxCopyPart > MAX_COPY_PART_BYTES) {
        usage("bad-max-part-bytes");
      }
      return assembleStage({
        ...opts,
        dir: need(v.dir, "dir"),
        execute,
        concurrency: concurrency(4),
        maxCopyPart,
      });
    }
    case "verify":
      return verifyStage({
        ...opts,
        dir: need(v.dir, "dir"),
        concurrency: concurrency(4),
        samples: intFlag(v.samples, "samples", DEFAULT_SAMPLES, 1),
      });
    case "raw-verify":
      return rawVerifyStage({
        dir: need(v.dir, "dir"),
        gitBlobsFile: v["git-blobs"] ?? "git-blobs.txt",
        log,
      });
    case "delete-old": {
      // Checked against the plan's bucket by the stage (`checkPublicBase`).
      const publicBase = v["public-base"] ?? DEFAULT_PUBLIC_BASE;
      return deleteOldStage({
        ...opts,
        dir: need(v.dir, "dir"),
        confirmDataset: need(v["confirm-dataset"], "confirm-dataset"),
        publicBase,
        execute,
        ...proofFiles(v),
        maxDelete:
          v["max-delete"] === undefined ? undefined : intFlag(v["max-delete"], "max-delete", 0),
        maxPrune: intFlag(v["max-prune"], "max-prune", 1000),
        prune: v["prune-noncurrent"] ?? [],
        concurrency: concurrency(4),
      });
    }
    case "zarr":
      return zarrStage({
        ...opts,
        dir: need(v.dir, "dir"),
        execute,
        concurrency: concurrency(4),
        allowMembers: v["allow-member"] ?? [],
        maxDocs: intFlag(v["max-zarr-json"], "max-zarr-json", DEFAULT_MAX_ZARR_JSON, 1),
      });
    case "drop-archives":
      return dropArchivesStage({
        ...opts,
        dir: need(v.dir, "dir"),
        confirmDataset: need(v["confirm-dataset"], "confirm-dataset"),
        execute,
        concurrency: concurrency(4),
        ...proofFiles(v),
      });
    case "zarr-public": {
      const publicBase = v["public-base"] ?? DEFAULT_PUBLIC_BASE;
      checkPublicBase(publicBase, v.bucket ?? "nemar");
      return zarrPublicStage({
        dataset: need(v.dataset, "dataset"),
        zarrVerifiedFile: need(v["zarr-verified"], "zarr-verified"),
        publicBase,
        timeoutMs: opts.timeoutMs,
        concurrency: concurrency(8),
        log,
      });
    }
    case "canary":
      return canaryStage({
        ...opts,
        bucket: v.bucket ?? "nemar",
        prefix: need(v.prefix, "prefix"),
        execute,
        multipart: v.multipart === true,
        batch: v.batch === true,
      });
    default:
      return usage("unknown-command");
  }
}

if (import.meta.main) {
  // Owner-only for every file this process and its `aws` children create: the temp files can hold
  // raw original bytes, and the working directory holds paths that may be identifying.
  process.umask(0o077);
  installSignalCleanup("s3-scrub");
  const log = (line: string) => console.log(line);
  try {
    process.exit(await run(Bun.argv.slice(2), log));
  } catch (err) {
    if (err instanceof StageError) {
      console.error(`s3-scrub: ${err.word}`);
      if (err.exitCode === EXIT.usage) console.error(USAGE);
      process.exit(err.exitCode);
    }
    if (err instanceof ContractError) {
      console.error(`s3-scrub: ${err.message}`);
      process.exit(EXIT.refused);
    }
    // An `aws` call that failed outside a stage's own accounting: its operation and fixed class
    // (`failureWord`), never the CLI's message.
    if (err instanceof AwsCliError) {
      console.error(`s3-scrub: failed ${failureWord(err)}`);
      process.exit(EXIT.failed);
    }
    // Anything else could carry a message with a value in it (a parse error quotes the text it
    // choked on, a file error names the path): name the class only. SCRUB_S3_DEBUG=1 adds no
    // message and no stack either, only a fixed word that says so.
    const cls = err instanceof Error ? err.name : "error";
    console.error(`s3-scrub: unexpected ${cls}`);
    if (process.env.SCRUB_S3_DEBUG === "1") {
      console.error(`s3-scrub: debug: ${cls}; message and stack withheld`);
    }
    process.exit(EXIT.failed);
  }
}
