/**
 * The re-pull's S3 canary (`nemar admin repull canary`, ADR 0111 decision 8; epic #1046 phase 6):
 * the real-bucket check of what the copy step believes about S3, on a scratch prefix, before the
 * first production re-pull. Only stand-ins have answered these calls otherwise.
 *
 * It copies two upstream objects into the scratch prefix by version, through the same write guard
 * the copy uses: a small one with one `copy-object`, and one over 10 MiB as a multipart upload of
 * 5 MiB parts copied with `upload-part-copy`, so the multipart path runs. It heads both copies and
 * compares their sizes with the versions they came from, and the ETag where the source is a
 * single-part object; it writes a staging-shaped key and deletes it; it deletes both copies by
 * version id; and it lists the prefix's versions to show nothing is left, not even a delete marker.
 * It never locks and never bypasses a lock: an object the bucket's default retention locked cannot
 * be deleted by version, and the canary says so.
 *
 * The prefix is refused unless it is `nm099999/repull-canary-<word>/` or
 * `xx<090001..099899>/repull-canary-<word>/`: the standing end-to-end dataset or a dev-ephemeral
 * one, never a dataset's `objects/` or `staging/`, and never the permanent exemplar fleet
 * (`xx099900` to `xx099999`, ADR 0068). The bucket must be NEMAR's. Both are enforced by
 * {@link runCanary} itself, so no caller can skip them. A dry run (the default) makes no call at
 * all and prints the calls it would make. The owner runs it with `--execute` (a real-bucket write).
 *
 * Every object the canary writes is deleted by version id on every path, including when a check of
 * the copy fails; an upload an abort could not close, or one left open, is a failed step.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AwsCliError,
  type AwsRunner,
  DEFAULT_TIMEOUT_MS,
  MIB,
  cliCredentialSource,
  createAwsRunner,
  failureWord,
} from "../../../scripts/scrub/s3/s3-lib.js";
import { UPSTREAM_BUCKET } from "../fleet-content-recovery.js";
import { UPSTREAM_REGION } from "./execute/copy.js";
import { type AwsGuardContext, RepullWriteRefused, guardedAws } from "./write-guard.js";

/** NEMAR's bucket, the only one the canary writes to. */
export const NEMAR_BUCKET = "nemar";

const CANARY_PREFIX_RE = /^(nm099999|xx(\d{6}))\/repull-canary-[0-9A-Za-z-]{1,64}\/$/;

/**
 * Whether `prefix` is a canary scratch prefix: `nm099999/repull-canary-<word>/`, or the same under
 * a dev-ephemeral id `xx090001` to `xx099899`. The top 100 ids of the `xx` prefix are the
 * permanent exemplar fleet (ADR 0068) and are refused.
 */
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
    `copy-object ${args.bucket}/${k.single} --copy-source ${src(args.single)} --copy-source-if-match <its ETag>`,
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
