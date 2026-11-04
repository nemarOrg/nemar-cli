#!/usr/bin/env bun
/**
 * The re-pull's S3 canary (ADR 0111, decision 8): the owner's check, before the first production
 * re-pull, of the copy's S3 calls against the real buckets, which only stand-ins answer otherwise.
 * It runs them through the copy's write guard on a scratch prefix and deletes by version id
 * everything it wrote, on every path. It never locks and never bypasses a lock.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { UPSTREAM_BUCKET } from "../src/lib/fleet-content-recovery.js";
import { UPSTREAM_REGION } from "../src/lib/repull/execute/copy.js";
import {
  type AwsGuardContext,
  RepullWriteRefused,
  guardedAws,
} from "../src/lib/repull/write-guard.js";
import {
  AwsCliError,
  type AwsRunner,
  DEFAULT_TIMEOUT_MS,
  MIB,
  cliCredentialSource,
  createAwsRunner,
  failureWord,
} from "./scrub/s3/s3-lib.js";

/** NEMAR's bucket, the only one the canary writes to. */
export const NEMAR_BUCKET = "nemar";

const CANARY_PREFIX_RE = /^(nm099999|xx(\d{6}))\/repull-canary-[0-9A-Za-z-]{1,64}\/$/;

/** `nm099999/repull-canary-<word>/`, or the same under `xx090001` to `xx099899` (ADR 0068). */
export function isCanaryPrefix(prefix: string): boolean {
  const m = CANARY_PREFIX_RE.exec(prefix);
  if (!m) return false;
  if (m[1] === "nm099999") return true;
  const n = Number(m[2]);
  return n >= 90_001 && n <= 99_899;
}

/** The multipart copy's part size: S3's minimum, so an object just over 10 MiB has three parts. */
export const CANARY_PART_BYTES = 5 * MIB;

/** The multipart source must be over this, so the copy runs as more than one part. */
export const CANARY_MULTIPART_MIN = 10 * MIB;

export interface CanarySource {
  ds: string;
  /** The object's key in upstream's bucket, `<ds>/<path>`. */
  object: string;
  version: string;
}

/** `<ds>/<path>@<versionId>`, or null when it is not one. */
export function parseCanarySource(raw: string): CanarySource | null {
  const at = raw.lastIndexOf("@");
  if (at < 0) return null;
  const object = raw.slice(0, at);
  const version = raw.slice(at + 1);
  const m = /^(ds\d{6})\/(.+)$/.exec(object);
  if (!m || !/^[A-Za-z0-9._-]{1,1024}$/.test(version) || /(^|\/)\.\.?(\/|$)/.test(m[2] as string)) {
    return null;
  }
  return { ds: m[1] as string, object, version };
}

export interface CanaryArgs {
  prefix: string;
  single: CanarySource;
  multipart: CanarySource;
  bucket: string;
  region: string;
}

/** Why the arguments are refused, or null when they are acceptable. */
export function canaryArgsProblem(args: CanaryArgs): string | null {
  if (!isCanaryPrefix(args.prefix)) {
    return "--prefix must be nm099999/repull-canary-<word>/ or xx<090001 to 099899>/repull-canary-<word>/ (a scratch prefix, ending in /; the exemplar fleet is never one)";
  }
  if (args.bucket !== NEMAR_BUCKET) {
    return `--bucket must be ${NEMAR_BUCKET}, NEMAR's bucket`;
  }
  if (args.single.ds !== args.multipart.ds) {
    return "--source and --multipart-source must name objects of the same dataset";
  }
  if (
    args.single.object === args.multipart.object &&
    args.single.version === args.multipart.version
  ) {
    return "--source and --multipart-source must be two objects";
  }
  return null;
}

/** The keys the canary writes, all under its prefix. */
export function canaryKeys(prefix: string): { single: string; multipart: string; staging: string } {
  return {
    single: `${prefix}copy-single`,
    multipart: `${prefix}copy-multipart`,
    staging: `${prefix}staging/repull-canary.json`,
  };
}

/** The calls an `--execute` run makes, in order, for the dry run to print. */
export function canaryCalls(args: CanaryArgs): string[] {
  const k = canaryKeys(args.prefix);
  const src = (s: CanarySource) => `${UPSTREAM_BUCKET}/${s.object}?versionId=${s.version}`;
  return [
    `head-object ${UPSTREAM_BUCKET}/${args.single.object} --version-id ${args.single.version}`,
    `head-object ${UPSTREAM_BUCKET}/${args.multipart.object} --version-id ${args.multipart.version}`,
    `copy-object ${args.bucket}/${k.single} --copy-source ${src(args.single)} --copy-source-if-match <its ETag> --tagging-directive REPLACE`,
    `create-multipart-upload ${args.bucket}/${k.multipart}`,
    `upload-part-copy x N (5 MiB parts) --copy-source ${src(args.multipart)} --copy-source-if-match <its ETag>`,
    `complete-multipart-upload ${args.bucket}/${k.multipart}`,
    `head-object ${args.bucket}/${k.single} and ${args.bucket}/${k.multipart} (sizes; the single copy's ETag)`,
    `put-object ${args.bucket}/${k.staging}, then delete-object it by version id`,
    "delete-object of both copies by version id",
    `list-object-versions ${args.bucket}/${args.prefix} (must be empty: no version, no delete marker)`,
    `list-multipart-uploads ${args.bucket}/${args.prefix} (must be empty: no open upload)`,
  ];
}

export interface CanaryStep {
  name: string;
  ok: boolean;
  detail: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function why(err: unknown): string {
  if (err instanceof AwsCliError) return failureWord(err);
  if (err instanceof RepullWriteRefused) return `refused by the write guard (${err.what})`;
  return err instanceof Error ? err.name : "error";
}

/** Run the canary's calls. Every step is reported; the deletes are tried whatever failed before. */
export async function runCanary(
  args: CanaryArgs & { env: Record<string, string | undefined>; out: (line: string) => void },
): Promise<{ ok: boolean; steps: CanaryStep[] }> {
  // The arguments are checked here too, so no caller can skip it; nothing is called when refused.
  const problem = canaryArgsProblem(args);
  if (problem) {
    const refused = { name: "check the arguments", ok: false, detail: problem };
    args.out(`FAILED ${refused.name}: ${refused.detail}`);
    return { ok: false, steps: [refused] };
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.env)) if (v !== undefined) env[k] = v;
  const k = canaryKeys(args.prefix);
  const guard: AwsGuardContext = {
    destBucket: args.bucket,
    prefix: args.prefix,
    stagingKey: k.staging,
    sourceBucket: UPSTREAM_BUCKET,
    sourcePrefix: `${args.single.ds}/`,
    canary: true,
  };
  const credentials = cliCredentialSource({ commandEnv: env });
  const make = (region: string): AwsRunner =>
    guardedAws(createAwsRunner({ region, timeoutMs: DEFAULT_TIMEOUT_MS, env, credentials }), guard);
  const source = make(UPSTREAM_REGION);
  const dest = make(args.region);
  const steps: CanaryStep[] = [];
  const say = (s: CanaryStep) => {
    steps.push(s);
    args.out(`${s.ok ? "ok" : "FAILED"} ${s.name}: ${s.detail}`);
  };
  const attempt = async <T>(name: string, fn: () => Promise<{ value: T; detail: string }>) => {
    try {
      const { value, detail } = await fn();
      say({ name, ok: true, detail });
      return value;
    } catch (err) {
      say({
        name,
        ok: false,
        detail: err instanceof Error && err.name === "CanaryCheck" ? err.message : why(err),
      });
      return undefined;
    }
  };
  const check = (cond: boolean, message: string) => {
    if (!cond) {
      const e = new Error(message);
      e.name = "CanaryCheck";
      throw e;
    }
  };
  const head = async (aws: AwsRunner, bucket: string, key: string, version?: string) => {
    const out = await aws.api("head-object", [
      "--bucket",
      bucket,
      "--key",
      key,
      ...(version ? ["--version-id", version] : []),
    ]);
    const etag = str(out.ETag);
    if (typeof out.ContentLength !== "number" || !etag) {
      throw new AwsCliError("bad-output", "HeadObject");
    }
    return { size: out.ContentLength, etag, versionId: str(out.VersionId) };
  };
  const copySource = (s: CanarySource) => `${UPSTREAM_BUCKET}/${s.object}?versionId=${s.version}`;

  // 1. The two versions, read at their pins.
  const one = await attempt("head the small source at its version", async () => {
    const h = await head(source, UPSTREAM_BUCKET, args.single.object, args.single.version);
    check(h.versionId === args.single.version, "another version, or none, answered");
    return { value: h, detail: `${h.size} bytes, ETag ${h.etag}` };
  });
  const big = await attempt("head the multipart source at its version", async () => {
    const h = await head(source, UPSTREAM_BUCKET, args.multipart.object, args.multipart.version);
    check(h.versionId === args.multipart.version, "another version, or none, answered");
    check(h.size > CANARY_MULTIPART_MIN, `${h.size} bytes is not over 10 MiB`);
    return { value: h, detail: `${h.size} bytes` };
  });

  // 2. The copies, by version.
  // The versions the copies were written as, recorded as soon as S3 names them and before any
  // check of the answer, so a copy that fails its check is still deleted by version below.
  let singleVersion: string | undefined;
  let multipartVersion: string | undefined;
  let singleOk: string | undefined;
  let multipartOk: string | undefined;
  if (one) {
    singleOk = await attempt("copy the small source by version", async () => {
      const out = await dest.api(
        "copy-object",
        [
          "--bucket",
          args.bucket,
          "--key",
          k.single,
          "--copy-source",
          copySource(args.single),
          "--copy-source-if-match",
          one.etag,
          "--tagging-directive",
          "REPLACE",
        ],
        { slow: true },
      );
      const v = str(out.VersionId);
      singleVersion = v;
      check(v !== undefined, "the bucket answered no version id (is it versioned?)");
      // S3 names the source version it copied from a versioned bucket; unknown is not the pin.
      const from = str(out.CopySourceVersionId);
      check(from === args.single.version, `copied from version ${from ?? "(not named)"}`);
      return { value: v, detail: `version ${v}, copied from ${from}` };
    });
  }
  if (big) {
    multipartOk = await attempt("copy the multipart source by version, in parts", async () => {
      const created = await dest.api("create-multipart-upload", [
        "--bucket",
        args.bucket,
        "--key",
        k.multipart,
      ]);
      const uploadId = str(created.UploadId);
      check(uploadId !== undefined, "no upload id");
      const parts: Array<{ ETag: string; PartNumber: number }> = [];
      try {
        for (let start = 0, n = 1; start < big.size; start += CANARY_PART_BYTES, n++) {
          const end = Math.min(start + CANARY_PART_BYTES, big.size) - 1;
          const out = await dest.api(
            "upload-part-copy",
            [
              "--bucket",
              args.bucket,
              "--key",
              k.multipart,
              "--upload-id",
              uploadId as string,
              "--part-number",
              String(n),
              "--copy-source",
              copySource(args.multipart),
              "--copy-source-range",
              `bytes=${start}-${end}`,
              "--copy-source-if-match",
              big.etag,
            ],
            { slow: true },
          );
          const etag = str((out.CopyPartResult as Record<string, unknown> | undefined)?.ETag);
          check(etag !== undefined, `part ${n} answered no ETag`);
          const from = str(out.CopySourceVersionId);
          check(
            from === args.multipart.version,
            `part ${n} copied from version ${from ?? "(not named)"}`,
          );
          parts.push({ ETag: etag as string, PartNumber: n });
        }
        const done = await dest.api(
          "complete-multipart-upload",
          [
            "--bucket",
            args.bucket,
            "--key",
            k.multipart,
            "--upload-id",
            uploadId as string,
            "--multipart-upload",
            JSON.stringify({ Parts: parts }),
          ],
          { slow: true },
        );
        const v = str(done.VersionId);
        multipartVersion = v;
        check(v !== undefined, "the bucket answered no version id (is it versioned?)");
        return { value: v, detail: `${parts.length} parts, version ${v}` };
      } catch (err) {
        try {
          await dest.api("abort-multipart-upload", [
            "--bucket",
            args.bucket,
            "--key",
            k.multipart,
            "--upload-id",
            uploadId as string,
          ]);
        } catch {
          // The failure is reported with the upload it left open; the final listing shows it too.
          const e = new Error(
            `${why(err)}; the abort of upload ${uploadId} failed and it stays open`,
          );
          e.name = "CanaryCheck";
          throw e;
        }
        throw err;
      }
    });
  }

  // 3. The copies are the versions they came from.
  if (one && singleOk) {
    await attempt("head the small copy", async () => {
      const h = await head(dest, args.bucket, k.single, singleOk);
      check(h.size === one.size, `${h.size} bytes, not ${one.size}`);
      // A single-part source's ETag is its content's, and a server-side copy keeps it.
      if (!one.etag.includes("-")) check(h.etag === one.etag, `ETag ${h.etag}, not ${one.etag}`);
      return { value: h, detail: `${h.size} bytes, ETag ${h.etag}` };
    });
  }
  if (big && multipartOk) {
    await attempt("head the multipart copy", async () => {
      const h = await head(dest, args.bucket, k.multipart, multipartOk);
      check(h.size === big.size, `${h.size} bytes, not ${big.size}`);
      return { value: h, detail: `${h.size} bytes` };
    });
  }

  // 4. A staging-shaped key, written and deleted by version.
  const stagingVersion = await attempt("write a staging-shaped key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-repull-canary-"));
    try {
      const file = join(dir, "staging.json");
      writeFileSync(file, `${JSON.stringify({ schema: "nemar.repull-canary", version: 1 })}\n`, {
        mode: 0o600,
      });
      const out = await dest.api("put-object", [
        "--bucket",
        args.bucket,
        "--key",
        k.staging,
        "--body",
        file,
        "--content-type",
        "application/json",
      ]);
      const v = str(out.VersionId);
      check(v !== undefined, "the bucket answered no version id");
      return { value: v, detail: `version ${v}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 5. Everything the canary wrote is deleted by version id, so no delete marker is left.
  for (const [name, key, version] of [
    ["delete the staging-shaped key by version", k.staging, stagingVersion],
    ["delete the small copy by version", k.single, singleVersion],
    ["delete the multipart copy by version", k.multipart, multipartVersion],
  ] as const) {
    if (!version) continue;
    await attempt(name, async () => {
      await dest.api("delete-object", [
        "--bucket",
        args.bucket,
        "--key",
        key,
        "--version-id",
        version,
      ]);
      return { value: true, detail: "deleted" };
    });
  }

  // 6. The prefix, listed by version: nothing.
  await attempt("list the prefix's versions", async () => {
    const out = await dest.api("list-object-versions", [
      "--bucket",
      args.bucket,
      "--prefix",
      args.prefix,
      "--max-keys",
      "1000",
      "--no-paginate",
    ]);
    const versions = Array.isArray(out.Versions) ? out.Versions.length : 0;
    const markers = Array.isArray(out.DeleteMarkers) ? out.DeleteMarkers.length : 0;
    check(
      versions === 0 && markers === 0 && out.IsTruncated !== true,
      `${versions} version(s) and ${markers} delete marker(s) are left under the prefix`,
    );
    return { value: true, detail: "empty" };
  });

  // 7. No multipart upload left open under the prefix (an abort that failed leaves one).
  await attempt("list the prefix's open multipart uploads", async () => {
    const out = await dest.api("list-multipart-uploads", [
      "--bucket",
      args.bucket,
      "--prefix",
      args.prefix,
      "--no-paginate",
    ]);
    const open = Array.isArray(out.Uploads) ? out.Uploads.length : 0;
    check(
      open === 0 && out.IsTruncated !== true,
      `${open} multipart upload(s) are left open under the prefix`,
    );
    return { value: true, detail: "none open" };
  });

  return { ok: steps.every((s) => s.ok) && steps.length > 0, steps };
}

const HELP = `Usage: bun run scripts/repull-canary.ts --prefix <prefix> --source <ds>/<path>@<versionId>
  --multipart-source <ds>/<path>@<versionId> [--bucket nemar] [--region us-east-2] [--execute] [--json]

Checks the copy's S3 calls against the real buckets with the ambient short-lived AWS credentials:
a copy by version id, a multipart copy in 5 MiB parts, the copies' sizes and ETag, a staging-shaped
key, and deletes by version id that leave the prefix empty. A dry run (the default) makes no call
and prints the calls --execute makes.

--prefix must be nm099999/repull-canary-<word>/ or xx<090001 to 099899>/repull-canary-<word>/,
never the exemplar fleet (xx099900 to xx099999). --bucket must be nemar. --source is a small
upstream object and --multipart-source one over 10 MiB, of the same dataset.

Exit codes: 0 every step passed (or a dry run); 1 a step failed or the arguments were refused.`;

const OPTIONS = {
  prefix: { type: "string" },
  source: { type: "string" },
  "multipart-source": { type: "string" },
  bucket: { type: "string" },
  region: { type: "string" },
  execute: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean" },
} as const;

const parse = (argv: string[]) => parseArgs({ args: argv, options: OPTIONS, strict: true }).values;

/** The script's entry point; returns its exit code. */
export async function main(argv: string[]): Promise<number> {
  let values: ReturnType<typeof parse>;
  try {
    values = parse(argv);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
    return 1;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const json = values.json === true;
  const out = (line: string) => (json ? console.error(line) : console.log(line));
  if (!values.prefix || !values.source || !values["multipart-source"]) {
    out(`--prefix, --source and --multipart-source are required.\n\n${HELP}`);
    return 1;
  }
  const single = parseCanarySource(values.source);
  const multipart = parseCanarySource(values["multipart-source"]);
  if (!single || !multipart) {
    out(
      "--source and --multipart-source take <ds>/<path>@<versionId>; a version id may hold only letters, digits, '.', '_' and '-'.",
    );
    return 1;
  }
  const args: CanaryArgs = {
    prefix: values.prefix,
    single,
    multipart,
    bucket: values.bucket ?? NEMAR_BUCKET,
    region: values.region ?? "us-east-2",
  };
  const problem = canaryArgsProblem(args);
  if (problem) {
    out(`Refused: ${problem}.`);
    return 1;
  }
  if (!values.execute) {
    if (json) {
      console.log(JSON.stringify({ dry_run: true, calls: canaryCalls(args) }, null, 2));
    } else {
      console.log("Dry run; --execute makes these calls:");
      for (const call of canaryCalls(args)) console.log(`  ${call}`);
    }
    return 0;
  }
  const result = await runCanary({ ...args, env: process.env, out });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.ok ? "The canary passed." : "The canary FAILED; see the steps above.");
  return result.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
