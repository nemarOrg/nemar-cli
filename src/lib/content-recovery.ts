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
 * the bucket looking like content (ADR 0063).
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

/** Errors that mean "this source cannot be read", as opposed to a transfer fault. */
const SOURCE_UNREADABLE = /AccessDenied|NoSuchVersion|NoSuchKey|NotFound|\b40[34]\b|Forbidden/i;

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
 * Undo git-annex's `!`-marked base64 on one metadata value.
 *
 * Returned unchanged when it is not marked, and when the marked payload does
 * not round-trip: a value that merely starts with `!` is worth passing through
 * rather than losing.
 */
function decodeRmetValue(raw: string): string {
  if (!raw.startsWith("!")) return raw;
  const encoded = raw.slice(1);
  // Buffer.from is lenient: it ignores anything outside the alphabet rather
  // than failing, so a value that merely begins with `!` would decode to
  // rubbish. Re-encoding has to reproduce the input for the decode to be real.
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return raw;
  return decoded.toString("utf8");
}

/**
 * Parse one `<key>.log.rmet` body into the pins it still records.
 *
 * The line is `<timestamp>s <uuid>:V <marker><value>`, and the value is
 * `<versionId>#<object path>`. Two pieces of git-annex's encoding have to be
 * honored, and both looked like upstream defects when they were not.
 *
 * The marker is set/unset, not an escape: `+` records that version as a place
 * the content is, `-` RETRACTS one recorded earlier. `ds006110` retracts five,
 * and reading `-d6y2...` as a version id sends S3 a literal leading minus,
 * which returns a bare `InvalidRequest`.
 *
 * A `!` after the marker means the value is base64, which is how git-annex
 * carries a value containing a space. `ds008003`'s two objects live under
 * `derivatives/reCleaned Cluster analysis/`, so both of its pins are encoded;
 * a parser that requires a literal `#` finds no pin at all and reports the key
 * as unpinned, which is what put those 11.5 GB out of reach: the >5 GB path
 * needs a pinned source, because a multipart copy cannot carry a SHA-256.
 *
 * A key keeps several live pins, one per remote and one per time a remote's
 * copy was rewritten; they are returned oldest first, so a caller that wants
 * the current one takes the last.
 */
export function parseRmet(contents: string, remotes: Map<string, RemoteRecord>): PinnedSource[] {
  const entries: Array<{ stamp: number; retracted: boolean; value: string; pin: PinnedSource }> =
    [];
  for (const line of contents.split("\n")) {
    const match = /^(\S+?)s?\s+([0-9a-f-]{36}):V\s+([+-])(\S+)$/.exec(line.trim());
    if (!match) continue;
    const remote = remotes.get(match[2]);
    if (!remote?.bucket) continue;
    const value = decodeRmetValue(match[4]);
    const split = value.indexOf("#");
    if (split <= 0) continue;
    entries.push({
      stamp: Number.parseFloat(match[1]) || 0,
      retracted: match[3] === "-",
      value,
      pin: {
        bucket: remote.bucket,
        object: value.slice(split + 1),
        version: value.slice(0, split),
        remoteName: remote.name,
      },
    });
  }
  // Replay the log in the order it was written, so a later retraction wins over
  // the entry that recorded the version, whatever order the lines arrive in.
  entries.sort((a, b) => a.stamp - b.stamp);
  const live = new Map<string, PinnedSource>();
  for (const entry of entries) {
    if (entry.retracted) live.delete(entry.value);
    else live.set(entry.value, entry.pin);
  }
  return [...live.values()];
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
  /**
   * Other sources to try if the first is refused.
   *
   * A pin can name a version the upstream has since restricted or deleted while
   * the same bytes are still served at that path under a newer version id: for
   * on008462 the pinned version 403s and the current one answers 200 at the same
   * size. A pin is the best identification of a key's content, not a promise
   * that it is still readable, so a refusal falls through rather than ending it.
   */
  alternatives?: RecoverySource[];
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

  const discovered = opts.upstream ? discoverUpstreamSource(facts.size, opts) : null;
  if (pin) {
    entry.source = { ...pin, origin: "pinned", size: facts.size };
    // Not the same object twice: a discovered candidate that IS the pin adds
    // nothing but a second identical refusal.
    if (discovered && discovered.version !== pin.version) entry.alternatives = [discovered];
    return entry;
  }
  if (!opts.upstream) {
    entry.reason = "no upstream remote to recover from";
    return entry;
  }
  if (discovered) {
    entry.source = discovered;
    return entry;
  }
  entry.reason = upstreamRefusalReason(facts.size, opts);
  return entry;
}

/** The one distinct upstream object carrying this key's size, if there is one. */
function discoverUpstreamSource(
  size: number,
  opts: {
    paths: string[];
    upstream?: { bucket: string; prefix: string; index: Map<string, UpstreamObjectVersion[]> };
  },
): RecoverySource | null {
  const upstream = opts.upstream;
  if (!upstream) return null;
  const candidates = opts.paths.flatMap(
    (path) => upstream.index.get(`${upstream.prefix}${path}`)?.filter((v) => v.size === size) ?? [],
  );
  // One path is routinely rewritten with identical bytes, which lists as several
  // versions of one object. Identical ETags are one candidate listed twice, not
  // an ambiguity, so they are collapsed before the count is judged.
  const distinct = new Map(candidates.map((candidate) => [candidate.etag, candidate]));
  if (distinct.size !== 1) return null;
  const [candidate] = distinct.values();
  return {
    bucket: upstream.bucket,
    object: candidate.object,
    version: candidate.version,
    remoteName: "upstream",
    origin: "version-match",
    size,
  };
}

function upstreamRefusalReason(
  size: number,
  opts: {
    paths: string[];
    upstream?: { bucket: string; prefix: string; index: Map<string, UpstreamObjectVersion[]> };
  },
): string {
  const upstream = opts.upstream;
  if (!upstream) return "no upstream remote to recover from";
  const candidates = opts.paths.flatMap(
    (path) => upstream.index.get(`${upstream.prefix}${path}`)?.filter((v) => v.size === size) ?? [],
  );
  const distinct = new Set(candidates.map((candidate) => candidate.etag));
  return distinct.size > 1
    ? `${distinct.size} distinct upstream objects carry this key's size; refusing to guess`
    : "no upstream object of this key's size at any of its paths";
}

export type VerificationMethod = "checksum" | "etag" | "crc64-of-source" | "size-and-pin";

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
  /** Full-object CRC64 of the copy, when S3 recorded one (the multipart path). */
  crc64?: string | null;
  /** Full-object CRC64 the source carries, for the same object. */
  sourceCrc64?: string | null;
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
  // Above 5 GB the copy is multipart, and a multipart object carries no
  // SHA-256: S3 rejects `--checksum-type FULL_OBJECT` for sha256, offering it
  // only for the CRC algorithms. But OpenNeuro's own large objects DO carry a
  // full-object CRC64, and so does our copy of one, so the two can be compared.
  // That does not tie the bytes to the key's hash; it proves the copy is
  // byte-identical to the version git-annex pinned, which is what the pin is
  // being trusted for. Size alone would pass any object of the right length.
  if (opts.sourceCrc64 && opts.crc64) {
    return opts.sourceCrc64 === opts.crc64
      ? { ok: true, method: "crc64-of-source" }
      : {
          ok: false,
          method: "crc64-of-source",
          detail: `the copy's CRC64 is ${opts.crc64}, the source reads ${opts.sourceCrc64}`,
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

/**
 * `bucket/object?versionId=...`, the shape CopyObject wants, UNENCODED.
 *
 * The AWS CLI percent-encodes the copy source itself, so encoding it here sends
 * `%2520` for a space and S3 answers `NoSuchVersion` for an object that is
 * plainly there. OpenNeuro has directories like `preprocessed data` and
 * `fine-grained pattern`, so this is not a corner: it silently failed every key
 * under them (on004148).
 *
 * The one thing this cannot express is a key containing a literal `?`, which
 * would be read as the start of the version parameter. S3 permits it, nothing in
 * these archives uses it, and the alternative breaks every path with a space.
 */
export function copySourceArgument(source: { bucket: string; object: string; version?: string }) {
  const base = `${source.bucket}/${source.object}`;
  return source.version ? `${base}?versionId=${source.version}` : base;
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
}): Promise<{
  size: number;
  etag: string | null;
  checksumSha256: string | null;
  crc64: string | null;
} | null> {
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
    ChecksumCRC64NVME?: string;
    ChecksumType?: string;
  };
  return {
    size: body.ContentLength ?? 0,
    etag: body.ETag ?? null,
    checksumSha256: body.ChecksumSHA256 ?? null,
    // Only a FULL_OBJECT CRC describes the whole object. A composite one is a
    // hash of part hashes and says nothing about two objects built from
    // different part sizes.
    crc64: body.ChecksumType === "FULL_OBJECT" ? (body.ChecksumCRC64NVME ?? null) : null,
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

/**
 * The source object's full-object CRC64, or null if it carries none.
 *
 * Asked unsigned, like every other question we put to upstream, and only when
 * the copy could not be checksummed any other way, so it costs one HEAD on the
 * >5 GB path and nothing at all elsewhere.
 */
export async function upstreamObjectCrc64(
  source: { bucket: string; object: string; version?: string },
  env?: Record<string, string>,
): Promise<string | null> {
  const args = [
    "s3api",
    "head-object",
    "--no-sign-request",
    "--checksum-mode",
    "ENABLED",
    "--bucket",
    source.bucket,
    "--key",
    source.object,
    "--output",
    "json",
  ];
  if (source.version) args.push("--version-id", source.version);
  const { stdout, exitCode } = await aws(args, env);
  if (exitCode !== 0) return null;
  const body = JSON.parse(stdout || "{}") as {
    ChecksumCRC64NVME?: string;
    ChecksumType?: string;
  };
  return body.ChecksumType === "FULL_OBJECT" ? (body.ChecksumCRC64NVME ?? null) : null;
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
        "above CopyObject's 5 GB limit; a multipart copy cannot carry the key's SHA-256, " +
        "and matching the source's CRC64 would only prove we faithfully copied a guess",
    };
  }
  if (!opts.apply) {
    // A dry run has to ASK, not assume. A recorded source is not a readable one:
    // on004475's keys all carry pins, and every one of those objects is gone, so
    // a plan built from the records alone reports 30 recoverable keys and an
    // apply recovers none. One unsigned HEAD per candidate is what the copy
    // would have found out anyway.
    for (const candidate of [entry.source, ...(entry.alternatives ?? [])]) {
      if (await isUpstreamObjectReadable(candidate, opts.env)) {
        return {
          key: entry.key,
          size: entry.size,
          action: "would-recover",
          origin: candidate.origin,
        };
      }
    }
    return {
      key: entry.key,
      size: entry.size,
      action: "unrecoverable",
      origin,
      detail: "every recorded source for this key is unreadable",
    };
  }

  // Each candidate in turn: the pin first, then whatever discovery found. A pin
  // is the best identification of a key's content, not a promise the object is
  // still readable, and upstream rewrites and re-permissions objects under the
  // same path (on003645's recorded versions are all NoSuchVersion while the
  // right bytes sit at the same paths under newer ids).
  const candidates = [entry.source, ...(entry.alternatives ?? [])];
  const refusals: string[] = [];
  for (const source of candidates) {
    let copied: CopyResult;
    try {
      copied = await copyObjectServerSide({
        source,
        destBucket: opts.destBucket,
        destKey: opts.destKey,
        env: opts.env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      refusals.push(message);
      // Unreadable source: try the next candidate rather than ending here.
      if (SOURCE_UNREADABLE.test(message)) continue;
      return {
        key: entry.key,
        size: entry.size,
        action: "failed",
        origin: source.origin,
        detail: message,
      };
    }

    // Ask the bucket rather than the copy's own answer: a multipart copy reports
    // nothing useful, and this is the same question a later sweep will ask.
    const head = await headObject({ bucket: opts.destBucket, key: opts.destKey, env: opts.env });
    const sha = copied.checksumSha256 ?? head?.checksumSha256;
    // One extra HEAD, and only where it buys something: with no SHA-256 to
    // compare, matching the source's full-object CRC64 is the difference
    // between proving the copy is those bytes and merely counting them.
    const sourceCrc64 = !sha && head?.crc64 ? await upstreamObjectCrc64(source, opts.env) : null;
    const verdict = verifyCopy({
      key: entry.key,
      origin: source.origin,
      checksumSha256: sha,
      etag: copied.etag ?? head?.etag,
      size: head?.size,
      crc64: head?.crc64,
      sourceCrc64,
    });
    if (verdict.ok) {
      return {
        key: entry.key,
        size: entry.size,
        action: "recovered",
        origin: source.origin,
        verification: verdict.method,
      };
    }
    const removed = await deleteObject({
      bucket: opts.destBucket,
      key: opts.destKey,
      env: opts.env,
    });
    return {
      key: entry.key,
      size: entry.size,
      action: "failed",
      origin: source.origin,
      verification: verdict.method,
      detail: `${verdict.detail}; the object was ${removed ? "deleted" : "LEFT IN THE BUCKET (delete failed)"}`,
    };
  }

  // Every candidate refused. Ask the source anonymously: if it will not serve the
  // object to anyone, this key is not a failure to retry, it is content upstream
  // holds and does not publish, and a re-run gets the same answer forever.
  const readable = await isUpstreamObjectReadable(entry.source, opts.env);
  const detail = refusals[refusals.length - 1] ?? "no candidate source could be copied";
  return {
    key: entry.key,
    size: entry.size,
    action: readable ? "failed" : "unrecoverable",
    origin: entry.source.origin,
    detail: readable
      ? detail
      : `upstream will not serve any recorded source for this key: ${detail.slice(0, 160)}`,
  };
}
