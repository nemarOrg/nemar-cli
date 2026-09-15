/**
 * Recover annexed content the bucket never received (#1396).
 *
 * #1392 was a registration NEMAR lost for content it holds. This is the other
 * half: sixteen datasets whose imports finalized with content that was never
 * transferred, so the bucket has no object to register. `setpresentkey` there
 * would write a claim that is false.
 *
 * The bytes usually still exist somewhere, and the question this module answers
 * is which "somewhere" is trustworthy enough to copy from:
 *
 *  1. **A pinned source.** git-annex records, in `<key>.log.rmet`, the exact S3
 *     version id it saw a key's content at on a versioned remote. That is the
 *     archive's own record of which bytes are this key's, so a copy of that
 *     version cannot pick up a file the upstream has changed since.
 *  2. **A version match.** No pin, but exactly one distinct upstream object (by
 *     ETag) at one of the key's paths has the size the key declares. Weaker --
 *     a path can be rewritten -- so it is only ever used with verification.
 *
 * Nothing is trusted on the strength of where it came from. Every copy that S3
 * can checksum is checked against the key's own hash BEFORE the key is
 * registered, and an object that does not match is deleted rather than left in
 * the bucket looking like content (ADR 0062).
 *
 * The copy is server-side: `CopyObject` moves the bytes inside S3, so recovering
 * hundreds of gigabytes does not depend on the operator's connection. It does
 * mean the credentials must be able to read the SOURCE bucket, which the API's
 * upload credentials cannot -- they are scoped to one dataset prefix in `nemar`
 * (`generateUploadPolicy`). So this reads AWS credentials from the ambient
 * environment, the way `exemplar-clone` does, and says so in the command's help.
 */

import { runCommand } from "./git-annex/run-command.js";
import { annexKeyDeclaredSize } from "./s3-server-copy.js";

/** CopyObject refuses a source above this; bigger objects need a multipart copy. */
export const COPY_OBJECT_LIMIT = 5 * 1024 ** 3;

/** Part size for the multipart path. 10,000 parts caps a copy at ~10 TiB. */
const MULTIPART_PART_SIZE = 1024 ** 3;

/** How long any one aws invocation may take. A 5 GiB server-side copy is slow. */
const AWS_TIMEOUT_MS = 1_800_000;

/** Environment that decides which credentials sign an aws call, unset for clarity. */
const AWS_UNSET = ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3"];

export interface AnnexKeyFacts {
  /** `SHA256E`, `MD5E`, `URL`, ... */
  backend: string;
  /** Bytes, from the key's own `-s<n>` field. */
  size: number;
  /** The content hash, lowercase hex, or null for a backend that carries none. */
  hashHex: string | null;
}

/**
 * Read a key's backend, size and hash.
 *
 * The hash is fixed-width by backend and is NOT delimited from the extension:
 * `SHA256E-s65536--de2f...cc31COR-001` ends in a file called `COR-001` with no
 * dot, so splitting on `.` takes 7 characters of hash with it and every
 * verification silently fails. The width is the thing that is known.
 */
const HASH_WIDTH: Record<string, number> = { SHA256: 64, SHA256E: 64, MD5: 32, MD5E: 32 };

export function parseAnnexKey(key: string): AnnexKeyFacts | null {
  // The size comes from the import path's own reading of a key, so a dataset
  // cannot be judged complete by one rule and recovered by another.
  const size = annexKeyDeclaredSize(key);
  const match = /^([A-Z0-9]+)-s\d+(?:-[SC]\d+)*--(.+)$/.exec(key);
  if (size === null || !match) return null;
  const [, backend, rest] = match;
  const width = HASH_WIDTH[backend];
  const hashHex = width && rest.length >= width ? rest.slice(0, width).toLowerCase() : null;
  return { backend, size, hashHex: hashHex && /^[0-9a-f]+$/.test(hashHex) ? hashHex : null };
}

export interface RemoteRecord {
  uuid: string;
  name: string;
  bucket?: string;
  /** The remote's `fileprefix`, which is where its objects actually live. */
  fileprefix?: string;
}

/** Every special remote the git-annex branch declares, by uuid. */
export function parseRemoteLog(contents: string): Map<string, RemoteRecord> {
  const remotes = new Map<string, RemoteRecord>();
  for (const line of contents.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const uuid = fields[0];
    if (!uuid || fields.length < 2) continue;
    const field = (name: string) =>
      fields.find((f) => f.startsWith(`${name}=`))?.slice(name.length + 1);
    const name = field("name");
    if (!name) continue;
    remotes.set(uuid, { uuid, name, bucket: field("bucket"), fileprefix: field("fileprefix") });
  }
  return remotes;
}

export interface PinnedSource {
  bucket: string;
  object: string;
  version: string;
  remoteName: string;
}

/**
 * Parse one `<key>.log.rmet` body into the pin it records, if any.
 *
 * The line is `<timestamp>s <uuid>:V +<versionId>#<object>`. The `+` is
 * git-annex's escaping marker and is not part of the version id. A key can have
 * several, one per remote and one per time the remote's copy was rewritten; the
 * last line wins, which is how git-annex reads its own append-only logs.
 */
export function parseRmet(contents: string, remotes: Map<string, RemoteRecord>): PinnedSource[] {
  const found: PinnedSource[] = [];
  for (const line of contents.split("\n")) {
    const match = /^\S+\s+([0-9a-f-]{36}):V\s+\+?([^#\s]+)#(.+)$/.exec(line.trim());
    if (!match) continue;
    const remote = remotes.get(match[1]);
    if (!remote?.bucket) continue;
    found.push({
      bucket: remote.bucket,
      object: match[3],
      version: match[2],
      remoteName: remote.name,
    });
  }
  return found;
}

export interface UpstreamObjectVersion {
  object: string;
  version: string;
  size: number;
  etag: string;
}

/**
 * Every version of every object under a prefix, current and historical.
 *
 * Historical matters: OpenNeuro deletes a path when a dataset's next version
 * drops the file, and the object survives behind a delete marker. Listing only
 * current objects reports content as gone that is one `versionId` away.
 */
export async function listUpstreamObjectVersions(opts: {
  bucket: string;
  prefix: string;
  /** Sign the request. Off by default: the upstream buckets are public. */
  signed?: boolean;
}): Promise<Map<string, UpstreamObjectVersion[]>> {
  const args = [
    "aws",
    "s3api",
    "list-object-versions",
    "--bucket",
    opts.bucket,
    "--prefix",
    opts.prefix,
    "--output",
    "json",
    "--query",
    "Versions[].[Key,VersionId,Size,ETag]",
    "--page-size",
    "1000",
  ];
  if (!opts.signed) args.push("--no-sign-request");
  const { stdout, stderr, exitCode, timedOut } = await runCommand(args, {
    unsetEnv: AWS_UNSET,
    timeout: AWS_TIMEOUT_MS,
  });
  if (exitCode !== 0 || timedOut) {
    // A partial listing reads as "upstream does not have it", which would file a
    // recoverable dataset as unrecoverable. Refuse rather than under-report.
    throw new Error(
      `listing s3://${opts.bucket}/${opts.prefix} failed: ${
        timedOut ? "timed out" : stderr.trim() || `exit ${exitCode}`
      }`,
    );
  }
  return indexUpstreamVersions(stdout);
}

/** Group `[Key, VersionId, Size, ETag]` rows by object key. */
export function indexUpstreamVersions(stdout: string): Map<string, UpstreamObjectVersion[]> {
  const index = new Map<string, UpstreamObjectVersion[]>();
  const rows = stdout.trim() ? (JSON.parse(stdout) as Array<[string, string, number, string]>) : [];
  for (const [object, version, size, etag] of rows ?? []) {
    const list = index.get(object) ?? [];
    list.push({ object, version, size, etag: (etag ?? "").replace(/"/g, "") });
    index.set(object, list);
  }
  return index;
}

export type RecoveryOrigin = "pinned" | "version-match";

export interface RecoverySource extends PinnedSource {
  origin: RecoveryOrigin;
  size: number;
}

export interface RecoveryPlanEntry {
  key: string;
  size: number;
  /** Where the bytes can be copied from, or absent when nothing accounts for them. */
  source?: RecoverySource;
  /** Why there is no source; the operator's evidence that it is not a bug here. */
  reason?: string;
}

/**
 * Decide where one key's content can be copied from. Pure, and the whole rule.
 *
 * `paths` are the working-tree paths that reference the key, which is how a
 * key is looked up in an upstream that stores files by path rather than by key.
 */
export function planKeyRecovery(opts: {
  key: string;
  paths: string[];
  pins: PinnedSource[];
  upstream?: { bucket: string; prefix: string; index: Map<string, UpstreamObjectVersion[]> };
}): RecoveryPlanEntry {
  const facts = parseAnnexKey(opts.key);
  if (!facts) return { key: opts.key, size: 0, reason: "not a parseable annex key" };
  const entry: RecoveryPlanEntry = { key: opts.key, size: facts.size };

  const pin = opts.pins[opts.pins.length - 1];
  if (pin) {
    entry.source = { ...pin, origin: "pinned", size: facts.size };
    return entry;
  }
  if (!opts.upstream) {
    entry.reason = "no upstream remote to recover from";
    return entry;
  }

  const candidates = opts.paths.flatMap(
    (path) =>
      opts.upstream?.index
        .get(`${opts.upstream.prefix}${path}`)
        ?.filter((v) => v.size === facts.size) ?? [],
  );
  // One path is routinely rewritten with identical bytes, which lists as several
  // versions of one object. Identical ETags are one candidate listed twice, not
  // an ambiguity, so they are collapsed before the count is judged.
  const distinct = new Map(candidates.map((candidate) => [candidate.etag, candidate]));
  if (distinct.size === 1) {
    const [candidate] = distinct.values();
    entry.source = {
      bucket: opts.upstream.bucket,
      object: candidate.object,
      version: candidate.version,
      remoteName: "upstream",
      origin: "version-match",
      size: facts.size,
    };
    return entry;
  }
  entry.reason =
    distinct.size > 1
      ? `${distinct.size} distinct upstream objects carry this key's size; refusing to guess`
      : "no upstream object of this key's size at any of its paths";
  return entry;
}

export type VerificationMethod = "checksum" | "etag" | "size-and-pin";

export interface VerificationVerdict {
  ok: boolean;
  method: VerificationMethod;
  detail?: string;
}

/**
 * Check what S3 says it wrote against what the key says it should be.
 *
 * S3 computes the SHA-256 of a `CopyObject` when asked, so a copy from a source
 * nothing pins is still provable: the destination either hashes to the key or it
 * does not. Only the multipart path cannot do this -- a multipart object's
 * checksum is over the parts, not the content -- and there the pin plus the size
 * is all there is, which is why an unpinned oversized key is refused instead.
 */
export function verifyCopy(opts: {
  key: string;
  origin: RecoveryOrigin;
  checksumSha256?: string | null;
  etag?: string | null;
  size?: number | null;
}): VerificationVerdict {
  const facts = parseAnnexKey(opts.key);
  if (!facts) return { ok: false, method: "checksum", detail: "unparseable key" };

  if (opts.checksumSha256 && facts.backend.startsWith("SHA256") && facts.hashHex) {
    const want = Buffer.from(facts.hashHex, "hex").toString("base64");
    return opts.checksumSha256 === want
      ? { ok: true, method: "checksum" }
      : {
          ok: false,
          method: "checksum",
          detail: `S3 hashed the object to ${opts.checksumSha256}, the key says ${want}`,
        };
  }
  const etag = opts.etag?.replace(/"/g, "");
  if (etag && !etag.includes("-") && facts.backend.startsWith("MD5") && facts.hashHex) {
    return etag === facts.hashHex
      ? { ok: true, method: "etag" }
      : {
          ok: false,
          method: "etag",
          detail: `the object's MD5 is ${etag}, the key says ${facts.hashHex}`,
        };
  }
  if (opts.size !== null && opts.size !== undefined && opts.size !== facts.size) {
    return {
      ok: false,
      method: "size-and-pin",
      detail: `the object is ${opts.size} bytes, the key says ${facts.size}`,
    };
  }
  if (opts.origin !== "pinned") {
    return {
      ok: false,
      method: "size-and-pin",
      detail: "only the size could be checked, and nothing pins this source to this key",
    };
  }
  return { ok: true, method: "size-and-pin" };
}

/** `bucket/url-encoded/object?versionId=...`, the shape CopyObject wants. */
export function copySourceArgument(source: { bucket: string; object: string; version?: string }) {
  const encoded = source.object.split("/").map(encodeURIComponent).join("/");
  const base = `${source.bucket}/${encoded}`;
  return source.version ? `${base}?versionId=${encodeURIComponent(source.version)}` : base;
}

async function aws(args: string[], env?: Record<string, string>) {
  return runCommand(["aws", ...args], {
    env,
    unsetEnv: AWS_UNSET,
    timeout: AWS_TIMEOUT_MS,
  });
}

export interface CopyResult {
  checksumSha256?: string | null;
  etag?: string | null;
  multipart: boolean;
}

/**
 * Copy one object inside S3, asking for a SHA-256 when the size allows it.
 */
export async function copyObjectServerSide(opts: {
  source: RecoverySource;
  destBucket: string;
  destKey: string;
  env?: Record<string, string>;
}): Promise<CopyResult> {
  if (opts.source.size > COPY_OBJECT_LIMIT) {
    return { ...(await multipartCopy(opts)), multipart: true };
  }
  const { stdout, stderr, exitCode } = await aws(
    [
      "s3api",
      "copy-object",
      "--bucket",
      opts.destBucket,
      "--key",
      opts.destKey,
      "--copy-source",
      copySourceArgument(opts.source),
      // A copy carries the source's tags over by default, which means reading
      // them, which is a SEPARATE permission (`s3:GetObjectVersionTagging`).
      // OpenNeuro tags its newer objects `access=public` and grants only
      // GetObject to everyone, so the default directive fails the whole copy
      // with a bare AccessDenied on an object we can read perfectly well.
      // Nothing here wants the source's tags.
      "--tagging-directive",
      "REPLACE",
      "--tagging",
      "",
      "--checksum-algorithm",
      "SHA256",
      "--output",
      "json",
    ],
    opts.env,
  );
  if (exitCode !== 0) {
    throw new Error(`copy-object failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  const body = JSON.parse(stdout || "{}") as {
    CopyObjectResult?: { ChecksumSHA256?: string; ETag?: string };
  };
  return {
    checksumSha256: body.CopyObjectResult?.ChecksumSHA256 ?? null,
    etag: body.CopyObjectResult?.ETag ?? null,
    multipart: false,
  };
}

/** The >5 GB path: one `upload-part-copy` per gigabyte, then complete. */
async function multipartCopy(opts: {
  source: RecoverySource;
  destBucket: string;
  destKey: string;
  env?: Record<string, string>;
}): Promise<{ checksumSha256?: null; etag?: string | null }> {
  const created = await aws(
    [
      "s3api",
      "create-multipart-upload",
      "--bucket",
      opts.destBucket,
      "--key",
      opts.destKey,
      "--output",
      "json",
    ],
    opts.env,
  );
  if (created.exitCode !== 0) {
    throw new Error(
      `create-multipart-upload failed: ${created.stderr.trim() || `exit ${created.exitCode}`}`,
    );
  }
  const uploadId = (JSON.parse(created.stdout || "{}") as { UploadId?: string }).UploadId;
  if (!uploadId) throw new Error("create-multipart-upload returned no UploadId");

  const parts: Array<{ ETag: string; PartNumber: number }> = [];
  try {
    for (
      let offset = 0, part = 1;
      offset < opts.source.size;
      offset += MULTIPART_PART_SIZE, part++
    ) {
      const end = Math.min(offset + MULTIPART_PART_SIZE, opts.source.size) - 1;
      const copied = await aws(
        [
          "s3api",
          "upload-part-copy",
          "--bucket",
          opts.destBucket,
          "--key",
          opts.destKey,
          "--upload-id",
          uploadId,
          "--part-number",
          String(part),
          "--copy-source",
          copySourceArgument(opts.source),
          "--copy-source-range",
          `bytes=${offset}-${end}`,
          "--output",
          "json",
        ],
        opts.env,
      );
      if (copied.exitCode !== 0) {
        throw new Error(
          `upload-part-copy ${part} failed: ${copied.stderr.trim() || `exit ${copied.exitCode}`}`,
        );
      }
      const etag = (JSON.parse(copied.stdout || "{}") as { CopyPartResult?: { ETag?: string } })
        .CopyPartResult?.ETag;
      if (!etag) throw new Error(`upload-part-copy ${part} returned no ETag`);
      parts.push({ ETag: etag, PartNumber: part });
    }
    const completed = await aws(
      [
        "s3api",
        "complete-multipart-upload",
        "--bucket",
        opts.destBucket,
        "--key",
        opts.destKey,
        "--upload-id",
        uploadId,
        "--multipart-upload",
        JSON.stringify({ Parts: parts }),
        "--output",
        "json",
      ],
      opts.env,
    );
    if (completed.exitCode !== 0) {
      throw new Error(
        `complete-multipart-upload failed: ${completed.stderr.trim() || `exit ${completed.exitCode}`}`,
      );
    }
    const body = JSON.parse(completed.stdout || "{}") as { ETag?: string };
    return { checksumSha256: null, etag: body.ETag ?? null };
  } catch (error) {
    // An abandoned multipart upload is billable storage nobody can see. Abort it
    // on the way out, and let the original failure be the one that is reported.
    await aws(
      [
        "s3api",
        "abort-multipart-upload",
        "--bucket",
        opts.destBucket,
        "--key",
        opts.destKey,
        "--upload-id",
        uploadId,
      ],
      opts.env,
    ).catch(() => undefined);
    throw error;
  }
}

/** What the bucket says about an object, for the verification step. */
export async function headObject(opts: {
  bucket: string;
  key: string;
  env?: Record<string, string>;
}): Promise<{ size: number; etag: string | null; checksumSha256: string | null } | null> {
  const { stdout, exitCode } = await aws(
    [
      "s3api",
      "head-object",
      "--bucket",
      opts.bucket,
      "--key",
      opts.key,
      "--checksum-mode",
      "ENABLED",
      "--output",
      "json",
    ],
    opts.env,
  );
  if (exitCode !== 0) return null;
  const body = JSON.parse(stdout || "{}") as {
    ContentLength?: number;
    ETag?: string;
    ChecksumSHA256?: string;
  };
  return {
    size: body.ContentLength ?? 0,
    etag: body.ETag ?? null,
    checksumSha256: body.ChecksumSHA256 ?? null,
  };
}

/**
 * Whether the upstream object can be read AT ALL, asked without credentials.
 *
 * The distinction this draws is the one an operator needs after a refused copy:
 * whether OUR credentials were not enough, or whether the archive holding the
 * only copy does not serve it to anyone. Five of the sixteen datasets are the
 * second case -- the objects are listed, with sizes, and 403 to an anonymous
 * caller, so the content exists upstream and is not public.
 */
export async function isUpstreamObjectReadable(
  source: { bucket: string; object: string; version?: string },
  env?: Record<string, string>,
): Promise<boolean> {
  const args = [
    "s3api",
    "head-object",
    "--no-sign-request",
    "--bucket",
    source.bucket,
    "--key",
    source.object,
  ];
  if (source.version) args.push("--version-id", source.version);
  const { exitCode } = await aws(args, env);
  return exitCode === 0;
}

export async function deleteObject(opts: {
  bucket: string;
  key: string;
  env?: Record<string, string>;
}): Promise<boolean> {
  const { exitCode } = await aws(
    ["s3api", "delete-object", "--bucket", opts.bucket, "--key", opts.key],
    opts.env,
  );
  return exitCode === 0;
}

export type RecoveryAction = "recovered" | "would-recover" | "unrecoverable" | "failed";

export interface KeyRecoveryOutcome {
  key: string;
  size: number;
  action: RecoveryAction;
  origin?: RecoveryOrigin;
  verification?: VerificationMethod;
  detail?: string;
}

/**
 * Copy one key's content in, prove it, and say what happened.
 *
 * On a verification failure the object is deleted. Leaving it would be worse
 * than never copying it: the next registration sweep lists the bucket, finds an
 * object under the key's name, and advertises content that is not the content.
 */
export async function recoverKey(opts: {
  entry: RecoveryPlanEntry;
  destBucket: string;
  destKey: string;
  apply: boolean;
  env?: Record<string, string>;
}): Promise<KeyRecoveryOutcome> {
  const { entry } = opts;
  if (!entry.source) {
    return {
      key: entry.key,
      size: entry.size,
      action: "unrecoverable",
      detail: entry.reason ?? "no source",
    };
  }
  const origin = entry.source.origin;
  if (entry.size > COPY_OBJECT_LIMIT && origin !== "pinned") {
    return {
      key: entry.key,
      size: entry.size,
      action: "unrecoverable",
      origin,
      detail:
        "above CopyObject's 5 GB limit, and a multipart copy cannot be checksummed, so an unpinned source cannot be proven",
    };
  }
  if (!opts.apply) {
    return { key: entry.key, size: entry.size, action: "would-recover", origin };
  }

  let copied: CopyResult;
  try {
    copied = await copyObjectServerSide({
      source: entry.source,
      destBucket: opts.destBucket,
      destKey: opts.destKey,
      env: opts.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A refused copy is two different states wearing one error. Ask the source
    // anonymously: if it will not serve the object to anyone, this key is not a
    // failure to retry, it is content upstream holds and does not publish, and
    // an operator re-running the sweep will get the same 403 forever.
    if (/AccessDenied|\b403\b|Forbidden/i.test(message)) {
      const readable = await isUpstreamObjectReadable(entry.source, opts.env);
      if (!readable) {
        return {
          key: entry.key,
          size: entry.size,
          action: "unrecoverable",
          origin,
          detail: `upstream lists an object for this key but serves it to nobody: s3://${entry.source.bucket}/${entry.source.object} is 403 even unsigned`,
        };
      }
    }
    return { key: entry.key, size: entry.size, action: "failed", origin, detail: message };
  }

  // Ask the bucket rather than the copy's own answer: a multipart copy reports
  // nothing useful, and this is the same question a later sweep will ask.
  const head = await headObject({ bucket: opts.destBucket, key: opts.destKey, env: opts.env });
  const verdict = verifyCopy({
    key: entry.key,
    origin,
    checksumSha256: copied.checksumSha256 ?? head?.checksumSha256,
    etag: copied.etag ?? head?.etag,
    size: head?.size,
  });
  if (!verdict.ok) {
    const removed = await deleteObject({
      bucket: opts.destBucket,
      key: opts.destKey,
      env: opts.env,
    });
    return {
      key: entry.key,
      size: entry.size,
      action: "failed",
      origin,
      verification: verdict.method,
      detail: `${verdict.detail}; the object was ${removed ? "deleted" : "LEFT IN THE BUCKET (delete failed)"}`,
    };
  }
  return {
    key: entry.key,
    size: entry.size,
    action: "recovered",
    origin,
    verification: verdict.method,
  };
}
