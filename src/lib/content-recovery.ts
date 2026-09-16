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

import { mapWithConcurrency } from "./fleet-key-registration.js";
import { runCommand } from "./git-annex/run-command.js";
import { annexKeyDeclaredSize } from "./s3-server-copy.js";

/**
 * Errors that mean "this source cannot be read", as opposed to a transfer fault.
 *
 * Anchored the same way `AWS_RETRYABLE` is, and for the same measured reason: a
 * loose `\b40[34]\b` also matches a path echoed in stderr, so a dataset with a
 * `sub-403/` or `run-404` in its tree could have a genuine transfer fault
 * reclassified as an unreadable source and end up filed `unrecoverable`.
 */
const SOURCE_UNREADABLE =
  /\((?:AccessDenied|NoSuchVersion|NoSuchKey|NotFound|Forbidden|InvalidArgument|403|404)\)/i;

/**
 * A 404 from S3: the object is genuinely not there, as opposed to unaskable.
 * Measured against the real CLI, whose message is
 * `An error occurred (404) when calling the HeadObject operation: Not Found`.
 */
const OBJECT_ABSENT = /\((?:404|NoSuchKey|NotFound)\)/i;

/**
 * Upstream answering about the object, rather than the question failing.
 *
 * `InvalidArgument` is in here because that is what S3 actually says for a
 * version id it does not have -- not `NoSuchVersion`, which is what a reader
 * would expect. Measured: a well-formed but absent version on `openneuro.org`
 * returns `An error occurred (InvalidArgument) ... Invalid version id
 * specified`. A recorded pin that draws it is a dead pin, which IS an answer
 * about the source, and getting this wrong would stop the fall-through to the
 * discovered alternative that recovered on003645.
 */
const UPSTREAM_REFUSAL =
  /\((?:403|404|AccessDenied|Forbidden|NoSuchKey|NotFound|NoSuchVersion|InvalidArgument)\)/i;

/** CopyObject refuses a source above this; bigger objects need a multipart copy. */
export const COPY_OBJECT_LIMIT = 5 * 1024 ** 3;

/** Part size for the multipart path. 10,000 parts caps a copy at ~10 TiB. */
const MULTIPART_PART_SIZE = 1024 ** 3;

/**
 * Parts of one object copied at once.
 *
 * Matches the per-KEY concurrency default, which lives in
 * `ContentRecoveryOptions.concurrency` and in the CLI's `--concurrency`, not in
 * this file. Named there rather than "above" so the reference does not rot on
 * the first re-order.
 */
const MULTIPART_CONCURRENCY = 8;

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
 * carries a value containing a space. `ds008003`'s two OVERSIZED objects live
 * under `derivatives/reCleaned Cluster analysis/`, so their pins are encoded;
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
    // An unparseable stamp becomes 0, which sorts before every real line. That
    // is deliberate, and measured against the alternative of dropping the line:
    // the ONLY case where the two differ is a lone bad-stamp `+` set, where
    // dropping loses the pin. Losing a pin makes readable content look
    // unrecoverable, which is the failure ADR 0064 was written about -- a pin
    // bug of that shape hid 3,186 pins and 11.5 GB -- whereas keeping a pin
    // parsed from an odd line costs at most one wasted copy attempt, because the
    // copy is verified against the key's own hash before anything is registered.
    // In every multi-line case the two behave identically (a retraction sorted
    // to 0 has nothing earlier to undo). git-annex always writes a numeric
    // stamp, so this is a corruption guard, not a routine path.
    const stamp = Number.parseFloat(match[1]) || 0;
    entries.push({
      stamp,
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

/**
 * Where a copy may read from, and on what authority.
 *
 * A union on `origin` rather than one shape with optional fields, so each arm
 * carries exactly the evidence its authority rests on. The pinned arm is a
 * `PinnedSource`, including the `remoteName` the record came from; the
 * version-match arm carries the ETag it was matched on, which is the evidence
 * for that arm and worth having in the JSON report. Previously both were
 * `PinnedSource` and a discovered source filled `remoteName: "upstream"`, a
 * sentinel for a field that only means something for a pin.
 */
export type RecoverySource = SourceCommon &
  (
    | ({ origin: "pinned" } & PinnedSource)
    | {
        origin: "version-match";
        bucket: string;
        object: string;
        version: string;
        /** The ETag the size match was resolved against; the evidence for this arm. */
        etag: string;
      }
  );

interface SourceCommon {
  /**
   * The size the KEY declares, not a size read from the source object.
   *
   * Load-bearing: `multipartRanges` computes the copy's part boundaries from it,
   * so a source object of a different length would be copied to the wrong
   * length. That is safe only because a candidate is admitted in the first place
   * by matching this size (or by being pinned), and because the copy is verified
   * afterwards.
   */
  size: number;
}

/**
 * Where one key's content can be copied from, or why it cannot be.
 *
 * A source XOR a reason XOR nothing to read at all, spelled with explicit
 * `undefined` counterparts so `entry.source` can still be read directly and
 * `entry.reason` narrows to a `string` once the other two are ruled out.
 * `recoverKey` used to need an `?? "no source"` fallback for a state the
 * producer never creates.
 */
export type RecoveryPlanEntry = { key: string; size: number } & (
  | {
      /**
       * The key is the empty file, so there is no source and no copy.
       *
       * Its own arm rather than a `RecoverySource` with blank fields: every
       * other arm exists to say WHERE bytes come from, and this one is the case
       * where that question has no answer because it has no content to fetch.
       */
      empty: true;
      source?: undefined;
      alternatives?: undefined;
      reason?: undefined;
    }
  | {
      empty?: undefined;
      source: RecoverySource;
      /**
       * Other sources to try if the first is refused.
       *
       * A pin can name a version the upstream has since restricted or deleted
       * while the same bytes are still served at that path under a newer version
       * id: for on008462 the pinned version 403s and the current one answers 200
       * at the same size. A pin is the best identification of a key's content,
       * not a promise that it is still readable, so a refusal falls through
       * rather than ending it.
       */
      alternatives?: RecoverySource[];
      reason?: undefined;
    }
  | {
      empty?: undefined;
      source?: undefined;
      alternatives?: undefined;
      /** Why there is no source; the evidence that it is not a bug here. */
      reason: string;
    }
);

/**
 * The content hash of the empty file, by backend.
 *
 * A key declaring `-s0` can only ever be satisfied by zero bytes, and this says
 * whether zero bytes is what the key actually asks for. A `-s0` key whose hash
 * is something else is self-contradictory: no byte string satisfies it, and
 * writing the empty object would be inventing content rather than recovering it.
 */
const EMPTY_CONTENT_HASH: Record<string, string> = {
  SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  SHA256E: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  MD5: "d41d8cd98f00b204e9800998ecf8427e",
  MD5E: "d41d8cd98f00b204e9800998ecf8427e",
};

/**
 * Whether this key is the empty file, and so needs no source at all.
 *
 * There is exactly one byte string of length zero, so a key that declares `-s0`
 * and carries the empty file's hash is content we already have: writing it is a
 * proof, not a guess, and it is the only recovery on this path that rests on no
 * upstream evidence whatsoever.
 *
 * This matters because the recorded sources for such a key are routinely wrong.
 * on006136's empty key carries four pins, all naming OpenNeuro upload temp
 * objects, and all four hold 2,075 bytes of the dataset's README. Copying from
 * the pin was refused by checksum, correctly; the key was recoverable the whole
 * time without reading upstream at all.
 */
export function isEmptyContentKey(facts: AnnexKeyFacts): boolean {
  if (facts.size !== 0) return false;
  const expected = EMPTY_CONTENT_HASH[facts.backend];
  return expected !== undefined && facts.hashHex === expected;
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
  const base = { key: opts.key, size: facts.size };
  // Before any source is considered, and deliberately so: the empty file needs
  // none, and the pins a `-s0` key carries have proven to name other content.
  if (isEmptyContentKey(facts)) return { ...base, empty: true };
  if (facts.size === 0) {
    return {
      ...base,
      reason: "declares zero bytes but not the empty file's hash; no content can satisfy it",
    };
  }
  const pin = opts.pins[opts.pins.length - 1];

  const discovered = opts.upstream ? discoverUpstreamSource(facts.size, opts) : null;
  if (pin) {
    // Not the same object twice: a discovered candidate that IS the pin adds
    // nothing but a second identical refusal.
    const alternatives =
      discovered && discovered.version !== pin.version ? [discovered] : undefined;
    return { ...base, source: { ...pin, origin: "pinned", size: facts.size }, alternatives };
  }
  if (!opts.upstream) return { ...base, reason: "no upstream remote to recover from" };
  if (discovered) return { ...base, source: discovered };
  return { ...base, reason: upstreamRefusalReason(facts.size, opts) };
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
    etag: candidate.etag,
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

/**
 * How a verification refused, which is wider than the methods that can PASS.
 *
 * A refusal can name a check that never ran at all -- there was no readable key
 * to check against, or the bucket never answered -- and saying so is the whole
 * diagnostic value of the field. Passing verdicts cannot use these.
 */
export type VerificationRefusal = VerificationMethod | "unparseable-key" | "unmeasured" | "size";

/**
 * The verdict, discriminated on `ok` so a pass cannot carry an excuse and a
 * refusal cannot omit its reason. `detail` was optional and interpolated
 * unconditionally by the caller, which rendered "undefined; the object was
 * deleted" for any refusal that forgot one.
 */
export type VerificationVerdict =
  | { ok: true; method: VerificationMethod; detail?: string }
  | { ok: false; method: VerificationRefusal; detail: string };

/**
 * Whether this origin ties the source object to this key's content.
 *
 * A pin is git-annex's own record that these bytes ARE this key, so it is the
 * one thing that licenses accepting evidence weaker than a hash: size alone
 * below 5 GB, or a CRC64 match against the source above it. A size-matched
 * candidate we merely found at the right path proves nothing of the sort.
 *
 * Named once because two conditionals 400 lines apart used to spell it out
 * independently, and they have to agree: `verifyCopy` decides what evidence is
 * enough, `recoverKey` decides which candidates may be copied at all. A new
 * `RecoveryOrigin` member fails closed here, into the stricter path.
 */
export function pinsContentToKey(origin: RecoveryOrigin): boolean {
  return origin === "pinned";
}

/**
 * Check what S3 says it wrote against what the key says it should be.
 *
 * S3 computes the SHA-256 of a `CopyObject` when asked, so a copy from a source
 * nothing pins is still provable: the destination either hashes to the key or it
 * does not. The multipart path cannot do that -- a multipart object's checksum
 * is over the parts, not the content -- so above 5 GB the copy is proven by
 * matching the source's full-object CRC64 instead, and only for a pinned
 * source: an unpinned oversized key is refused rather than trusted on size.
 *
 * Every argument is required, including the ones that are legitimately `null`.
 * They used to be optional, and an absent `size` skipped the size comparison
 * instead of failing it, so a pinned multipart copy whose read-back HEAD failed
 * returned `{ok: true, method: "size-and-pin"}` with not one byte compared.
 */
export function verifyCopy(opts: {
  key: string;
  origin: RecoveryOrigin;
  checksumSha256: string | null;
  etag: string | null;
  /** Length the bucket reports, or null when it could not be asked. */
  size: number | null;
  /** Full-object CRC64 of the copy, when S3 recorded one (the multipart path). */
  crc64: string | null;
  /** Full-object CRC64 the source carries, for the same object. */
  sourceCrc64: string | null;
}): VerificationVerdict {
  const facts = parseAnnexKey(opts.key);
  if (!facts) return { ok: false, method: "unparseable-key", detail: "unparseable key" };

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
  // A POSITIVE match, not "fail only on a mismatch". Reaching anything below
  // this line now proves the length was actually compared, which is what makes
  // the `size-and-pin` verdict's name true.
  // `== null` catches undefined too. The type says `number | null`, so a
  // production caller cannot omit it, but a missing size must degrade to the
  // honest refusal rather than to "the object is undefined bytes".
  if (opts.size == null) {
    return {
      ok: false,
      method: "unmeasured",
      detail: "the bucket did not answer for the copy, so nothing about it was checked",
    };
  }
  if (opts.size !== facts.size) {
    return {
      ok: false,
      method: "size",
      detail: `the object is ${opts.size} bytes, the key says ${facts.size}`,
    };
  }
  // Only a pin licenses evidence weaker than a hash, and this refusal has to
  // come BEFORE the CRC64 branch: a CRC64 match against a source we merely
  // found at the right path proves we copied that guess faithfully, not that
  // the bytes are this key's (ADR 0063). Ordered the other way, an unpinned
  // oversized alternative could be copied in and reported `crc64-of-source`.
  if (!pinsContentToKey(opts.origin)) {
    return {
      ok: false,
      method: "size-and-pin",
      detail: "only the size could be checked, and nothing pins this source to this key",
    };
  }
  // A multipart object carries no SHA-256: S3 rejects `--checksum-type
  // FULL_OBJECT` for sha256, offering it only for the CRC algorithms. But
  // OpenNeuro's own large objects DO carry a full-object CRC64, and the copy
  // asks for one, so the two can be compared. That does not tie the bytes to
  // the key's hash; it proves the copy is byte-identical to the version
  // git-annex pinned, which is what the pin is being trusted for.
  if (opts.sourceCrc64 && opts.crc64) {
    return opts.sourceCrc64 === opts.crc64
      ? { ok: true, method: "crc64-of-source" }
      : {
          ok: false,
          method: "crc64-of-source",
          detail: `the copy's CRC64 is ${opts.crc64}, the source reads ${opts.sourceCrc64}`,
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

/**
 * Throttling and the other transients worth a second attempt.
 *
 * `CreateOAuth2Token ... Rate exceeded` is the one measured here: a sweep with
 * eight copies in flight trips the credential endpoint, not S3, and it cost two
 * of `on008065`'s 5,173 keys. Since ADR 0064 a key that fails counts as missing
 * data, and enough of them withdraws a dataset, so a throttle that is not
 * retried can tombstone content that is sitting there readable. Deliberately
 * narrow: `AccessDenied` and `NoSuchVersion` are answers, not hiccups, and
 * retrying them wastes a sweep.
 */
// Anchored on the parenthesized code AWS puts in every message, not a loose
// word match: `\b429\b` also matches a path like `sub-503/x-429.set`, so a
// dataset whose filenames happen to carry those digits would retry an
// AccessDenied forever.
const AWS_RETRYABLE =
  /\((?:429|503|SlowDown|Throttling\w*|ThrottledException|RequestTimeout|RequestTimeoutException|InternalError|ServiceUnavailable)\)|Rate exceeded/i;

/** Whether an `aws` failure is worth another attempt. Exported to be tested. */
export function isRetryableAwsError(stderr: string): boolean {
  return AWS_RETRYABLE.test(stderr);
}

/** How many extra attempts a throttled call gets, and the base backoff. */
const AWS_RETRIES = 4;
const AWS_RETRY_BASE_MS = 750;

async function aws(args: string[], env?: Record<string, string>) {
  let result = await runCommand(["aws", ...args], {
    env,
    unsetEnv: AWS_UNSET,
    timeout: AWS_TIMEOUT_MS,
  });
  for (let attempt = 1; attempt <= AWS_RETRIES; attempt++) {
    if (result.exitCode === 0 || !isRetryableAwsError(result.stderr)) return result;
    // Exponential, with jitter so eight workers throttled at once do not all
    // come back in the same instant and throttle each other again.
    const wait = AWS_RETRY_BASE_MS * 2 ** (attempt - 1) * (1 + Math.random());
    await new Promise((resolve) => setTimeout(resolve, wait));
    result = await runCommand(["aws", ...args], {
      env,
      unsetEnv: AWS_UNSET,
      timeout: AWS_TIMEOUT_MS,
    });
  }
  return result;
}

export interface CopyResult {
  /** null when S3 recorded none; the multipart path never has one. */
  checksumSha256: string | null;
  etag: string | null;
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
  const { stdout, stderr, exitCode, timedOut } = await aws(
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
    // `timedOut` named explicitly: a copy killed at the 30-minute limit is a
    // transfer fault to retry, and stderr is usually empty for it, so without
    // this it reported as a bare `exit 1` that SOURCE_UNREADABLE does not match
    // and the key ended up `failed` with no reason a reader can act on.
    throw new Error(
      `copy-object failed: ${timedOut ? "timed out" : stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  const body = JSON.parse(stdout || "{}") as {
    CopyObjectResult?: { ChecksumSHA256?: string; ETag?: string };
  };
  return {
    checksumSha256: body.CopyObjectResult?.ChecksumSHA256 ?? null,
    // Unquoted at the boundary, like `headObject`, so no comparison downstream
    // has to remember to strip.
    etag: body.CopyObjectResult?.ETag?.replace(/"/g, "") ?? null,
    multipart: false,
  };
}

/**
 * The byte ranges of a multipart copy: contiguous, inclusive, 1-indexed parts.
 *
 * Extracted because it is the arithmetic that can corrupt silently. S3 accepts
 * whatever ranges it is given and stitches them in part order, so an off-by-one
 * on `end` produces an object of the wrong length, and a gap or an overlap
 * produces one of the right length holding the wrong bytes. Neither is visible
 * without hashing the result, and a multipart object carries no SHA-256.
 */
export function multipartRanges(
  size: number,
  partSize: number,
): Array<{ part: number; offset: number; end: number }> {
  const ranges: Array<{ part: number; offset: number; end: number }> = [];
  for (let offset = 0, part = 1; offset < size; offset += partSize, part++) {
    ranges.push({ part, offset, end: Math.min(offset + partSize, size) - 1 });
  }
  return ranges;
}

/** The >5 GB path: one `upload-part-copy` per gigabyte, then complete. */
async function multipartCopy(opts: {
  source: RecoverySource;
  destBucket: string;
  destKey: string;
  env?: Record<string, string>;
}): Promise<{ checksumSha256: null; etag: string | null }> {
  const created = await aws(
    [
      "s3api",
      "create-multipart-upload",
      "--bucket",
      opts.destBucket,
      "--key",
      opts.destKey,
      // ASKED FOR, not hoped for. A multipart object carries no SHA-256, so the
      // full-object CRC64 is the only thing that can prove this copy is the
      // bytes the pin names, and S3 attaches one only when the upload requests
      // it. Without these two flags the verification silently degraded to
      // size-only for every oversized key, which is the verdict this path
      // exists to avoid. SHA256 is not an option here: S3 refuses
      // `FULL_OBJECT` for it and offers it only for the CRC algorithms.
      "--checksum-algorithm",
      "CRC64NVME",
      "--checksum-type",
      "FULL_OBJECT",
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

  // Parts are independent server-side copies, so they run together. Sequentially
  // an oversized object copies at about 6 MiB/s, hours for a single key, while
  // eight single-part copies of ordinary keys sustain 30 MiB/s. The
  // ordering that matters is in the completed parts list, not in the requests.
  const ranges = multipartRanges(opts.source.size, MULTIPART_PART_SIZE);
  try {
    const parts = await mapWithConcurrency(ranges, MULTIPART_CONCURRENCY, async (range) => {
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
          String(range.part),
          "--copy-source",
          copySourceArgument(opts.source),
          "--copy-source-range",
          `bytes=${range.offset}-${range.end}`,
          "--output",
          "json",
        ],
        opts.env,
      );
      if (copied.exitCode !== 0) {
        throw new Error(
          `upload-part-copy ${range.part} failed: ${copied.stderr.trim() || `exit ${copied.exitCode}`}`,
        );
      }
      const etag = (JSON.parse(copied.stdout || "{}") as { CopyPartResult?: { ETag?: string } })
        .CopyPartResult?.ETag;
      if (!etag) throw new Error(`upload-part-copy ${range.part} returned no ETag`);
      return { ETag: etag, PartNumber: range.part };
    });
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
    // An abandoned multipart upload is billable storage nobody can see: 103 of
    // them across this bucket held 5.24 TiB before anyone looked. Abort it on
    // the way out, and let the original failure be the one that is reported.
    //
    // Reached only after every in-flight part has settled: `mapWithConcurrency`
    // waits for its siblings before rejecting, precisely so this abort cannot
    // race a part still being written. A part that landed after the abort would
    // resurrect the upload, and nothing would ever complete or clear it.
    const aborted = await aws(
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
    ).catch(() => ({ exitCode: 1, stderr: "abort-multipart-upload could not be invoked" }));
    // Never silently: an abort that failed is the billable-storage leak this
    // block exists to prevent, and the operator needs the upload id to clear it.
    if (aborted.exitCode !== 0) {
      console.warn(
        [
          `[content-recovery] FAILED to abort multipart upload ${uploadId}`,
          `for ${opts.destBucket}/${opts.destKey}: ${aborted.stderr.trim().slice(0, 300)}.`,
          "It is billable storage invisible to every object listing; clear it with",
          `aws s3api abort-multipart-upload --bucket ${opts.destBucket}`,
          `--key ${opts.destKey} --upload-id ${uploadId}`,
        ].join(" "),
      );
    }
    throw error;
  }
}

/** An object's facts, or why the bucket could not be asked for them. */
export interface HeadObjectAnswer {
  object: {
    size: number;
    etag: string | null;
    checksumSha256: string | null;
    crc64: string | null;
  } | null;
  /** Non-null when the question itself failed, rather than the object being absent. */
  failed: string | null;
}

/**
 * What the bucket says about an object, for the verification step.
 *
 * Tri-state on purpose. This used to return `null` for both "no such object"
 * and "the call failed", and the caller read either as "nothing to compare",
 * which is how a copy whose read-back timed out was reported verified.
 */
export async function headObject(opts: {
  bucket: string;
  key: string;
  env?: Record<string, string>;
}): Promise<HeadObjectAnswer> {
  const { stdout, stderr, exitCode, timedOut } = await aws(
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
  if (exitCode !== 0) {
    const why = timedOut ? "timed out" : stderr.trim() || `exit ${exitCode}`;
    // A 404 is an answer: the object is not there. Anything else is a failed
    // question and must never be scored as an absent object.
    return OBJECT_ABSENT.test(stderr)
      ? { object: null, failed: null }
      : { object: null, failed: why };
  }
  const body = JSON.parse(stdout || "{}") as {
    ContentLength?: number;
    ETag?: string;
    ChecksumSHA256?: string;
    ChecksumCRC64NVME?: string;
    ChecksumType?: string;
  };
  return {
    object: {
      size: body.ContentLength ?? 0,
      // Unquoted here, at the boundary, so the type's value is always unquoted
      // and no downstream comparison has to strip again to be correct.
      etag: body.ETag?.replace(/"/g, "") ?? null,
      checksumSha256: body.ChecksumSHA256 ?? null,
      // Only a FULL_OBJECT CRC describes the whole object. A composite one is a
      // hash of part hashes and says nothing about two objects built from
      // different part sizes.
      crc64: body.ChecksumType === "FULL_OBJECT" ? (body.ChecksumCRC64NVME ?? null) : null,
    },
    failed: null,
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
 *
 * `readable: false` is NOT the same as "upstream refuses it", which is why this
 * returns the reason too. A DNS blip, a throttle that outlived its retries, an
 * expired session or a missing `aws` binary all produce a non-zero exit, and
 * scoring any of them as a verdict about OpenNeuro manufactures exactly the
 * unmeasured `upstream_403` filing that ADR 0064 exists to correct. Only a
 * parsed 403 or 404 is an answer about the source.
 */
export async function isUpstreamObjectReadable(
  source: { bucket: string; object: string; version?: string },
  env?: Record<string, string>,
): Promise<{
  readable: boolean;
  refusedByUpstream: boolean;
  /**
   * The source object's length, or null when the answer did not carry one.
   *
   * Null is "we did not find out", never "zero": the caller compares this to the
   * key's declared size and must not read a missing answer as a contradiction.
   */
  size: number | null;
  detail: string | null;
}> {
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
  const { stdout, stderr, exitCode, timedOut } = await aws(args, env);
  if (exitCode === 0) {
    const body = JSON.parse(stdout || "{}") as { ContentLength?: number };
    const size = typeof body.ContentLength === "number" ? body.ContentLength : null;
    return { readable: true, refusedByUpstream: false, size, detail: null };
  }
  const detail = timedOut ? "timed out" : stderr.trim() || `exit ${exitCode}`;
  return {
    readable: false,
    refusedByUpstream: UPSTREAM_REFUSAL.test(stderr),
    size: null,
    detail,
  };
}

/**
 * Why this source cannot be this key's content, from one HEAD of it.
 *
 * A key declares its content's length, so a source object of another length is
 * not that content, whatever recorded it. This is decisive for a pin as much as
 * for a discovered object: on004624's pin names an object of 6,520,832 bytes for
 * a key declaring 6,488,064, and reporting that key as recoverable overstated
 * the fleet's recoverable content by every such pin.
 *
 * It also closes a real hazard above 5 GB, where the copy is multipart and
 * `multipartRanges` cuts its parts from the KEY's declared size: a pinned source
 * shorter than the key would be copied range by range against a length it does
 * not have.
 *
 * Null when nothing contradicts the key, INCLUDING when the answer carried no
 * length at all. Not finding out is not evidence.
 */
export function sourceSizeRefusal(
  declaredSize: number,
  probe: { size: number | null },
): string | null {
  if (probe.size === null || probe.size === declaredSize) return null;
  return `the source object is ${probe.size} bytes and the key declares ${declaredSize}`;
}

/**
 * The source object's full-object CRC64, or why it could not be read.
 *
 * Asked unsigned, like every other question we put to upstream, and only when
 * the copy could not be checksummed any other way, so it costs one HEAD on the
 * >5 GB path and nothing at all elsewhere.
 *
 * `{crc64: null, failed: null}` means the object genuinely carries none;
 * `failed` means we never found out, which downgrades an oversized copy's proof
 * to size-only and so has to be reported rather than absorbed.
 */
export async function upstreamObjectCrc64(
  source: { bucket: string; object: string; version?: string },
  env?: Record<string, string>,
): Promise<{ crc64: string | null; failed: string | null }> {
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
  const { stdout, stderr, exitCode, timedOut } = await aws(args, env);
  if (exitCode !== 0) {
    return { crc64: null, failed: timedOut ? "timed out" : stderr.trim() || `exit ${exitCode}` };
  }
  const body = JSON.parse(stdout || "{}") as {
    ChecksumCRC64NVME?: string;
    ChecksumType?: string;
  };
  return {
    crc64: body.ChecksumType === "FULL_OBJECT" ? (body.ChecksumCRC64NVME ?? null) : null,
    failed: null,
  };
}

/**
 * Write a zero-byte object, for a key whose content is the empty file.
 *
 * A `PutObject` with no body rather than a copy: there is nothing upstream to
 * copy from, and nothing that would make a copy more trustworthy than writing
 * the zero bytes the key asks for directly.
 */
export async function putEmptyObject(opts: {
  bucket: string;
  key: string;
  env?: Record<string, string>;
}): Promise<{ written: boolean; detail: string | null }> {
  const { stderr, exitCode, timedOut } = await aws(
    ["s3api", "put-object", "--bucket", opts.bucket, "--key", opts.key, "--content-length", "0"],
    opts.env,
  );
  if (exitCode === 0) return { written: true, detail: null };
  return {
    written: false,
    detail: timedOut ? "timed out" : stderr.trim() || `exit ${exitCode}`,
  };
}

/**
 * Delete one object, and say why if it would not go.
 *
 * The reason matters more here than almost anywhere else in this module: this is
 * the call that removes an object which FAILED verification, so a swallowed
 * refusal leaves a right-size, wrong-content object under a real key's name for
 * the next registration sweep to advertise (ADR 0063).
 */
export async function deleteObject(opts: {
  bucket: string;
  key: string;
  env?: Record<string, string>;
}): Promise<{ deleted: boolean; detail: string | null }> {
  const { stderr, exitCode, timedOut } = await aws(
    ["s3api", "delete-object", "--bucket", opts.bucket, "--key", opts.key],
    opts.env,
  );
  if (exitCode === 0) return { deleted: true, detail: null };
  return {
    deleted: false,
    detail: timedOut ? "timed out" : stderr.trim() || `exit ${exitCode}`,
  };
}

export type RecoveryAction = "recovered" | "would-recover" | "unrecoverable" | "failed";

export interface KeyRecoveryOutcome {
  key: string;
  size: number;
  action: RecoveryAction;
  /**
   * Where the content came from. `"empty"` is not a {@link RecoveryOrigin}
   * because it is not a place to read from; it is the absence of one.
   */
  origin?: RecoveryOrigin | "empty";
  /** How a recovered copy was PROVEN. Only ever set on `recovered`. */
  verification?: VerificationMethod | "empty";
  detail?: string;
  /**
   * An object that failed verification and could not be deleted.
   *
   * The one outcome worse than not copying at all (ADR 0063): a right-size,
   * wrong-content object under a real key's name, which the next registration
   * sweep advertises because it checks name and size, never content. Surfaced as
   * a field so the caller can print it rather than bury it in a detail string.
   */
  leftInBucket?: boolean;
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
  if (entry.empty) {
    if (!opts.apply) {
      return { key: entry.key, size: 0, action: "would-recover", origin: "empty" };
    }
    const written = await putEmptyObject({
      bucket: opts.destBucket,
      key: opts.destKey,
      env: opts.env,
    });
    if (!written.written) {
      return {
        key: entry.key,
        size: 0,
        action: "failed",
        origin: "empty",
        detail: written.detail ?? "the bucket refused the write",
      };
    }
    // Read back, for the same reason every other path does: the question a later
    // registration sweep asks is what the BUCKET holds, not what a write claimed.
    const head = await headObject({ bucket: opts.destBucket, key: opts.destKey, env: opts.env });
    if (head.object?.size !== 0) {
      const detail =
        head.object === null
          ? `written, but the bucket then answered ${head.failed ?? "nothing"}`
          : `written, but the bucket read back ${head.object.size} bytes`;
      const removed = await deleteObject({
        bucket: opts.destBucket,
        key: opts.destKey,
        env: opts.env,
      });
      return {
        key: entry.key,
        size: 0,
        action: "failed",
        origin: "empty",
        detail,
        leftInBucket: !removed.deleted,
      };
    }
    return {
      key: entry.key,
      size: 0,
      action: "recovered",
      origin: "empty",
      verification: "empty",
    };
  }
  if (!entry.source) {
    return { key: entry.key, size: entry.size, action: "unrecoverable", detail: entry.reason };
  }
  const origin = entry.source.origin;
  // PER CANDIDATE, not once for `entry.source`. The alternatives are tried when
  // the pin is refused, and an alternative is `version-match` by construction,
  // so judging the oversized rule on the primary's origin let an unpinned
  // oversized object be copied in whenever a pinned primary happened to 403.
  const oversized = (candidate: RecoverySource) =>
    entry.size > COPY_OBJECT_LIMIT && !pinsContentToKey(candidate.origin);
  const OVERSIZED_DETAIL =
    "above CopyObject's 5 GB limit; a multipart copy cannot carry the key's SHA-256, " +
    "and matching the source's CRC64 would only prove we faithfully copied a guess";
  if (oversized(entry.source) && (entry.alternatives ?? []).every(oversized)) {
    return {
      key: entry.key,
      size: entry.size,
      action: "unrecoverable",
      origin,
      detail: OVERSIZED_DETAIL,
    };
  }
  if (!opts.apply) {
    // A dry run has to ASK, not assume. A recorded source is not a readable one:
    // on004475's keys all carry pins, and every one of those objects is gone, so
    // a plan built from the records alone reports 30 recoverable keys and an
    // apply recovers none. One unsigned HEAD per candidate is what the copy
    // would have found out anyway.
    const probeRefusals: string[] = [];
    for (const candidate of [entry.source, ...(entry.alternatives ?? [])]) {
      if (oversized(candidate)) continue;
      const probe = await isUpstreamObjectReadable(candidate, opts.env);
      if (!probe.readable) continue;
      // The same HEAD already answered this, so the length costs nothing extra.
      const wrongSize = sourceSizeRefusal(entry.size, probe);
      if (wrongSize) {
        probeRefusals.push(wrongSize);
        continue;
      }
      return {
        key: entry.key,
        size: entry.size,
        action: "would-recover",
        origin: candidate.origin,
      };
    }
    if (probeRefusals.length > 0) {
      return {
        key: entry.key,
        size: entry.size,
        action: "unrecoverable",
        origin,
        detail: probeRefusals.join("; "),
      };
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
  const candidates = [entry.source, ...(entry.alternatives ?? [])].filter(
    (candidate) => !oversized(candidate),
  );
  const refusals: string[] = [];
  for (const source of candidates) {
    // Ask the source's length before copying it. Below 5 GB this only saves a
    // copy the checksum would refuse anyway; above it, it is the guard, because
    // the multipart path cuts its ranges from the key's declared size and has no
    // checksum to catch a source of another length afterwards.
    const probe = await isUpstreamObjectReadable(source, opts.env);
    if (probe.readable) {
      const wrongSize = sourceSizeRefusal(entry.size, probe);
      if (wrongSize) {
        refusals.push(wrongSize);
        continue;
      }
    }
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
    const sha = copied.checksumSha256 ?? head.object?.checksumSha256 ?? null;
    // One extra HEAD, and only where it buys something: with no SHA-256 to
    // compare, matching the source's full-object CRC64 is the difference
    // between proving the copy is those bytes and merely counting them.
    const sourceCrc64 =
      !sha && head.object?.crc64 ? await upstreamObjectCrc64(source, opts.env) : null;
    // A CRC64 the source was supposed to have and did not answer for is a
    // DOWNGRADE, not a neutral absence: it silently turns an oversized copy's
    // proof back into the size-only verdict this module refuses to rely on.
    if (sourceCrc64?.failed) {
      refusals.push(`could not read the source's CRC64: ${sourceCrc64.failed}`);
    }
    const verdict = verifyCopy({
      key: entry.key,
      origin: source.origin,
      checksumSha256: sha,
      etag: copied.etag ?? head.object?.etag ?? null,
      // null, never undefined: `verifyCopy` refuses an unknown size rather than
      // skipping the comparison, so a failed read-back cannot pass as verified.
      size: head.object?.size ?? null,
      crc64: head.object?.crc64 ?? null,
      sourceCrc64: sourceCrc64?.crc64 ?? null,
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
      // The refusing check belongs in the detail, not in `verification`, which
      // now means "and this is how it was proven". A JSON reader used to see
      // `verification: "checksum"` on a key that FAILED its checksum.
      detail: [
        `refused by ${verdict.method}: ${verdict.detail}`,
        removed.deleted
          ? "the object was deleted"
          : `the object was LEFT IN THE BUCKET (delete failed: ${removed.detail})`,
      ].join("; "),
      origin: source.origin,
      leftInBucket: !removed.deleted,
    };
  }

  // Every candidate refused. Ask the source anonymously: if it will not serve
  // the object to ANYONE, this key is not a failure to retry, it is content
  // upstream holds and does not publish, and a re-run gets the same answer
  // forever. A probe that merely FAILED says nothing of the kind, so only an
  // actual refusal earns `unrecoverable`: filing a network blip as a verdict
  // about OpenNeuro is the unmeasured `upstream_403` mistake ADR 0064 corrects.
  const probe = await isUpstreamObjectReadable(entry.source, opts.env);
  const detail = refusals[refusals.length - 1] ?? "no candidate source could be copied";
  if (probe.refusedByUpstream) {
    return {
      key: entry.key,
      size: entry.size,
      action: "unrecoverable",
      origin: entry.source.origin,
      detail: `upstream will not serve any recorded source for this key (${probe.detail}): ${detail.slice(0, 160)}`,
    };
  }
  return {
    key: entry.key,
    size: entry.size,
    action: "failed",
    origin: entry.source.origin,
    detail: probe.readable
      ? detail
      : `the source could not be probed (${probe.detail}), so whether upstream serves it is unknown: ${detail.slice(0, 160)}`,
  };
}
