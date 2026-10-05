#!/usr/bin/env bun
/**
 * S3 stages of an in-place privacy scrub of a published dataset (ADR 0085).
 *
 *   plan       --dataset ID --out DIR [--tags v1,v2] [--bucket nemar]
 *   assemble   --dir DIR [--execute] [--concurrency 4]
 *   verify     --dir DIR [--samples 8]
 *   delete-old --dir DIR --confirm-dataset ID [--execute] [--verified verified.json]
 *              [--hash-verified new-hash-verified.json] [--max-delete N]
 *              [--prune-noncurrent <prefix>]... [--max-prune N] [--public-base URL]
 *   zarr       --dir DIR [--execute] [--concurrency 4]
 *   canary     --prefix <id>/canary-<random>/ [--execute] [--multipart] [--bucket nemar]
 *
 * Every subcommand is read-only unless it is given `--execute`; `plan` and `verify` have no
 * `--execute` because they never write to S3. Common flags: `--region` (default us-east-2),
 * `--timeout-sec` (per `aws` call, default 120; transfers get five times as long).
 *
 * Credentials are the ambient `aws` CLI session. A long-lived `AKIA` key in the environment is
 * refused (docs.nemar.org access policies). Nothing printed or written is a participant value.
 *
 * Exit codes: 0 ok; 1 a stage failed; 2 usage; 3 refused (a precondition or proof is missing or
 * stale); 4 unreadable (the plan is incomplete); 5 versions or markers remain after a delete.
 */

import { parseArgs } from "node:util";
import { ContractError } from "../contract";
import {
  DEFAULT_SAMPLES,
  DEFAULT_TIMEOUT_MS,
  EXIT,
  MAX_COPY_PART_BYTES,
  MIN_PART_BYTES,
  StageError,
  cliCredentialSource,
} from "./s3-lib";
import {
  type CommonOptions,
  DEFAULT_PUBLIC_BASE,
  assembleStage,
  canaryStage,
  deleteOldStage,
  planStage,
  verifyStage,
} from "./s3-stages";
import { zarrStage } from "./zarr-stage";

const USAGE = `usage: s3-scrub.ts <plan|assemble|verify|delete-old|zarr|canary> [options]
  plan       --dataset ID --out DIR [--tags v1,v2] [--bucket nemar] [--concurrency 8]
  assemble   --dir DIR [--execute] [--concurrency 4] [--max-part-bytes N]
  verify     --dir DIR [--samples 8] [--concurrency 4]
  delete-old --dir DIR --confirm-dataset ID [--execute] [--verified F] [--hash-verified F]
             [--max-delete N] [--prune-noncurrent PREFIX]... [--max-prune N] [--public-base URL]
             --confirm-dataset: the dataset id again, required even for the dry run.
             --public-base: where an anonymous HEAD proves the dataset is private
             (default ${DEFAULT_PUBLIC_BASE}); it must answer 403.
             PREFIX is exactly ID/version/, ID/archives/ or ID/zarr/.
             --max-prune N (default 1000) refuses to prune more noncurrent versions than N. For
             ID/zarr/ expect about one per store root the zarr step rewrote (zarr-plan.json counts
             them, and the dry run prints the exact number) plus any older versions a Zarr
             re-conversion left, so a large dataset needs a larger N than the default.
  zarr       --dir DIR [--execute] [--concurrency 4]
             removes identifier keys from every Zarr store root's attributes; reads only unless
             --execute, and writes zarr-verified.json only when every store is clean after it.
             Then \`delete-old --prune-noncurrent ID/zarr/\` removes the noncurrent versions.
  canary     --prefix ID/canary-RANDOM/ [--execute] [--multipart] [--bucket nemar]
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
  "max-delete": { type: "string" },
  "max-prune": { type: "string" },
  "confirm-dataset": { type: "string" },
  "public-base": { type: "string" },
  "max-part-bytes": { type: "string" },
  "prune-noncurrent": { type: "string", multiple: true },
  concurrency: { type: "string" },
  samples: { type: "string" },
  "timeout-sec": { type: "string" },
  execute: { type: "boolean" },
  multipart: { type: "boolean" },
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
    // Against real S3 with no key in the environment, every call shares one serialized
    // credential export instead of each `aws` child refreshing the login session itself.
    credentials:
      process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ACCESS_KEY_ID
        ? undefined
        : cliCredentialSource(),
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
    case "delete-old": {
      const publicBase = v["public-base"] ?? DEFAULT_PUBLIC_BASE;
      if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(publicBase)) usage("bad-public-base");
      return deleteOldStage({
        ...opts,
        dir: need(v.dir, "dir"),
        confirmDataset: need(v["confirm-dataset"], "confirm-dataset"),
        publicBase,
        execute,
        verifiedFile: v.verified ?? "verified.json",
        hashVerifiedFile: v["hash-verified"] ?? "new-hash-verified.json",
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
      });
    case "canary":
      return canaryStage({
        ...opts,
        bucket: v.bucket ?? "nemar",
        prefix: need(v.prefix, "prefix"),
        execute,
        multipart: v.multipart === true,
      });
    default:
      return usage("unknown-command");
  }
}

if (import.meta.main) {
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
    // Anything else could carry a message with a value in it: name the class only.
    console.error(`s3-scrub: unexpected ${err instanceof Error ? err.name : "error"}`);
    if (process.env.SCRUB_S3_DEBUG === "1" && err instanceof Error) console.error(err.stack);
    process.exit(EXIT.failed);
  }
}
