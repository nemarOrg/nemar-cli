/**
 * Find content NEMAR does not hold, and put back what can be proven (#1396).
 *
 * The key-registration sweep (#1392) refuses a dataset whose annexed keys the
 * bucket cannot fully account for, and reports it. This is the other side of
 * that refusal: work out, per key, whether the bytes still exist anywhere, copy
 * the ones that do, and leave evidence for the ones that do not.
 *
 * Two things this module deliberately does not do.
 *
 * It does not register anything. Recovery puts objects in the bucket; the
 * location log is then the key-registration sweep's job, run afterwards, so
 * there is exactly one piece of code that writes a presence claim and it is the
 * one that reads the log back (ADR 0061).
 *
 * It does not treat "upstream has a file at this path" as "upstream has this
 * key's content". A path is mutable and an import is months old. Either
 * git-annex's own record pins the source version, or S3's checksum of what it
 * wrote has to match the key, or the key is reported unrecoverable (ADR 0063).
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  type KeyRecoveryOutcome,
  type PinnedSource,
  type RecoveryPlanEntry,
  type UpstreamObjectVersion,
  listUpstreamObjectVersions,
  parseRemoteLog,
  parseRmet,
  planKeyRecovery,
  recoverKey,
} from "./content-recovery.js";
import {
  type ObjectSource,
  REMOTE_NAME,
  cloneForFleetWork,
  mapWithConcurrency,
} from "./fleet-key-registration.js";
import { runCommand } from "./git-annex/run-command.js";
import { listAnnexedKeys } from "./git-annex/transfer.js";
import { isKeyPresentAtDeclaredSize } from "./s3-server-copy.js";

const DATASET_ID_RE = /^[a-z]{2}[0-9]{6}$/;

/** The bucket OpenNeuro exports its datasets to, and the only upstream we read. */
export const UPSTREAM_BUCKET = "openneuro.org";

/**
 * Keys the working tree names, with every path that references each one.
 *
 * The inverse of {@link listAnnexedKeys}, which is path-keyed. Both directions
 * are needed and the mapping is many-to-one: an upstream lookup is by path, and
 * a key stored under two names has two chances of being found there.
 */
export async function annexedKeyPaths(datasetPath: string): Promise<Map<string, string[]>> {
  const byPath = await listAnnexedKeys(datasetPath);
  const paths = new Map<string, string[]>();
  for (const [file, key] of byPath) {
    const list = paths.get(key) ?? [];
    list.push(file);
    paths.set(key, list);
  }
  return paths;
}

/**
 * Whether `git show <ref>:<path>` failed because the PATH is not in the ref.
 *
 * That is an answer -- a branch with no `remote.log` has no special remotes --
 * and it is the only failure of that command which is. Everything else (an
 * invalid ref, a partial-clone fetch failure, a corrupt object, not a
 * repository) is a question that did not get asked, and must not be read as an
 * empty result. Measured against git's own wording:
 *   missing path: `fatal: path 'remote.log' does not exist in 'git-annex'`
 *   missing ref:  `fatal: invalid object name 'no-such-ref'.`
 */
function isPathAbsentFromRef(stderr: string): boolean {
  return /does not exist in/.test(stderr);
}

/** `git cat-file --batch` over many paths, kept as bytes until each body is sliced. */
async function catFileBatch(
  repo: string,
  ref: string,
  paths: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (paths.length === 0) return found;
  const proc = Bun.spawn({
    cmd: ["git", "cat-file", "--batch"],
    cwd: repo,
    stdin: new TextEncoder().encode(paths.map((path) => `${ref}:${path}\n`).join("")),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  const errorText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  // A failed read must not look like "this key has no pin". Every consequence
  // of a missing pin is a verdict: `planKeyRecovery` reports "no upstream object
  // of this key's size", and an oversized key becomes `unrecoverable`. ADR 0064
  // records that a pin-parsing bug of exactly this shape hid 3,186 pins and
  // 11.5 GB of readable content, so this throws like `annexedKeys` does.
  if (exitCode !== 0) {
    throw new Error(
      `git cat-file --batch failed over ${paths.length} record(s): ${errorText.trim() || `exit ${exitCode}`}`,
    );
  }
  // The stream is <sha> <type> <size>\n<size bytes>\n per request, in order. The
  // sizes are BYTE counts, so the walk has to stay on a buffer: decoding first
  // and slicing by character would drift on any non-ASCII object path.
  let cursor = 0;
  for (const path of paths) {
    const newline = out.indexOf(0x0a, cursor);
    // Truncated mid-stream. Silently abandoning the remaining keys leaves an
    // arbitrary suffix of them unpinned, with the verdicts above attached.
    if (newline < 0) {
      throw new Error(
        `git cat-file --batch returned ${found.size} of ${paths.length} record(s); the stream ended early`,
      );
    }
    const header = out.subarray(cursor, newline).toString("utf8").split(" ");
    if (header[1] === "missing") {
      cursor = newline + 1;
      continue;
    }
    const size = Number(header[2]);
    // A header we cannot parse would set the cursor to NaN, after which
    // `indexOf(0x0a, NaN)` restarts from offset 0 and every later key gets
    // another key's body: wrong pins rather than missing ones.
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`git cat-file --batch returned an unparseable header for ${path}`);
    }
    const start = newline + 1;
    found.set(path, out.subarray(start, start + size).toString("utf8"));
    cursor = start + size + 1;
  }
  return found;
}

/** Where the git-annex branch says a key's content sits on a versioned remote. */
export async function readPinnedSources(
  datasetPath: string,
  keys: string[],
  ref = "git-annex",
): Promise<Map<string, PinnedSource[]>> {
  // Both of these THROW rather than return an empty map, for the reason
  // `annexedKeys` does: an empty answer and a failed question look identical
  // downstream, and here the failed question silently strips the pin from every
  // key in the dataset. A missing ref, a partial-clone fetch failure or a
  // corrupt object would then be reported as content upstream does not hold.
  const remoteLog = await runCommand(["git", "show", `${ref}:remote.log`], { cwd: datasetPath });
  if (remoteLog.exitCode !== 0 && !isPathAbsentFromRef(remoteLog.stderr)) {
    throw new Error(
      `could not read ${ref}:remote.log: ${remoteLog.stderr.trim() || `exit ${remoteLog.exitCode}`}`,
    );
  }
  // A branch with no remote.log genuinely has no versioned remotes, so no key
  // has a pin, and an empty map is the right answer rather than a guess.
  const remotes = parseRemoteLog(remoteLog.stdout);

  const listing = await runCommand(["git", "ls-tree", "-r", "--name-only", ref], {
    cwd: datasetPath,
  });
  if (listing.exitCode !== 0) {
    throw new Error(
      `could not list ${ref}: ${listing.stderr.trim() || `exit ${listing.exitCode}`}`,
    );
  }
  const wanted = new Set(keys);
  const rmetPaths: Array<[string, string]> = [];
  for (const path of listing.stdout.split("\n")) {
    if (!path.endsWith(".log.rmet")) continue;
    const key = path.slice(path.lastIndexOf("/") + 1, -".log.rmet".length);
    if (wanted.has(key)) rmetPaths.push([key, path]);
  }
  const bodies = await catFileBatch(
    datasetPath,
    ref,
    rmetPaths.map(([, path]) => path),
  );
  const pins = new Map<string, PinnedSource[]>();
  for (const [key, path] of rmetPaths) {
    const body = bodies.get(path);
    if (!body) continue;
    const parsed = parseRmet(body, remotes);
    if (parsed.length > 0) pins.set(key, parsed);
  }
  return pins;
}

/** The nemar-s3 remote's own object prefix, so a copy lands where it looks for it. */
export async function destinationPrefix(
  datasetPath: string,
  datasetId: string,
  remoteName = REMOTE_NAME,
  ref = "git-annex",
): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(["git", "show", `${ref}:remote.log`], {
    cwd: datasetPath,
  });
  // A FAILED read is not the same as a branch that names no such remote. The
  // convention below is a reasonable default for the second; for the first it is
  // a guess, and a wrong prefix sends hundreds of GB somewhere the annex never
  // looks, reported `recovered`, with the next sweep still finding the content
  // missing. Only the "asked, and it is not there" case falls back.
  if (exitCode !== 0 && !isPathAbsentFromRef(stderr)) {
    throw new Error(
      `could not read ${ref}:remote.log to find ${remoteName}'s object prefix: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  for (const remote of parseRemoteLog(stdout).values()) {
    if (remote.name === remoteName && remote.fileprefix) return remote.fileprefix;
  }
  return `${datasetId}/objects/`;
}

export type DatasetRecoveryAction =
  | "nothing-missing"
  | "recovered"
  | "would-recover"
  | "partial"
  | "unrecoverable"
  | "failed";

export interface DatasetRecoveryOutcome {
  datasetId: string;
  action: DatasetRecoveryAction;
  /**
   * Whether the counts below are a measurement at all.
   *
   * False when the dataset could not be examined: a clone failure, a rejected
   * id, a listing that threw. Every count is then 0 because nothing was
   * counted, and a reader who cannot tell that apart from a clean dataset gets
   * the worst possible reading of the worst possible case (ADR 0054: unknown is
   * never rendered as zero). ADR 0064 puts a withdrawal on the other end of
   * these numbers, so it has to be legible.
   */
  measured: boolean;
  /** Annexed keys with no object in the bucket, before anything was done. */
  missing: number;
  missingBytes: number;
  recovered: number;
  recoveredBytes: number;
  unrecoverable: number;
  unrecoverableBytes: number;
  failed: number;
  keys: KeyRecoveryOutcome[];
  error?: string;
}

export interface ContentRecoveryOptions {
  workRoot: string;
  /** Copy. Without it nothing is written and every key reports would-recover. */
  apply?: boolean;
  originUrl?: string;
  remoteName?: string;
  /** Act on at most this many keys, cheapest first. */
  limit?: number;
  /**
   * Copies in flight per dataset.
   *
   * S3 does the copying, so this is not bandwidth here; what it buys is hiding
   * the per-invocation cost of the aws CLI, which is seconds and would otherwise
   * dominate a run of several thousand small keys.
   */
  concurrency?: number;
  /** Credentials for the copy; the ambient environment by default. */
  env?: Record<string, string>;
  onKey?: (outcome: KeyRecoveryOutcome, done: number, total: number) => void;
}

function tally(
  datasetId: string,
  missing: RecoveryPlanEntry[],
  keys: KeyRecoveryOutcome[],
): DatasetRecoveryOutcome {
  const sum = (predicate: (outcome: KeyRecoveryOutcome) => boolean) =>
    keys.filter(predicate).reduce((total, outcome) => total + outcome.size, 0);
  const recovered = keys.filter((k) => k.action === "recovered").length;
  const unrecoverable = keys.filter((k) => k.action === "unrecoverable").length;
  const failed = keys.filter((k) => k.action === "failed").length;
  const would = keys.filter((k) => k.action === "would-recover").length;
  // `keys` holds only the keys this run ACTED on, which `--limit` narrows,
  // while `missing` is the whole plan. Judging completeness on `keys` alone
  // reported 10 of 100 recovered as `recovered`, with a green line in the
  // summary for a dataset still missing 90 keys.
  const untouched = missing.length - keys.length;
  let action: DatasetRecoveryAction;
  if (missing.length === 0) action = "nothing-missing";
  else if (failed > 0) action = "failed";
  else if (would > 0) action = "would-recover";
  else if (recovered > 0) action = unrecoverable > 0 || untouched > 0 ? "partial" : "recovered";
  else action = "unrecoverable";
  return {
    datasetId,
    action,
    measured: true,
    missing: missing.length,
    missingBytes: missing.reduce((total, entry) => total + entry.size, 0),
    recovered,
    recoveredBytes: sum((k) => k.action === "recovered"),
    unrecoverable,
    unrecoverableBytes: sum((k) => k.action === "unrecoverable"),
    failed,
    keys,
  };
}

/**
 * Recover one dataset's missing content.
 *
 * The clone is a full one, not `--filter=blob:none`: this reads a `.log.rmet`
 * per missing key, and a partial clone fetches those one round trip at a time.
 */
export async function recoverDatasetContent(
  datasetId: string,
  objects: ObjectSource,
  options: ContentRecoveryOptions,
): Promise<DatasetRecoveryOutcome> {
  // `unmeasured` and not `empty`: these returns are "we could not look", and
  // the zeros in them are the absence of a measurement, not a clean result.
  const unmeasured = { ...tally(datasetId, [], []), measured: false, action: "failed" as const };
  if (!DATASET_ID_RE.test(datasetId)) {
    return {
      ...unmeasured,
      error: `"${datasetId}" is not a dataset id, and it would become a directory this deletes`,
    };
  }
  const datasetPath = join(options.workRoot, datasetId);
  rmSync(datasetPath, { recursive: true, force: true });
  const url = options.originUrl ?? `https://github.com/nemarDatasets/${datasetId}.git`;
  const cloned = await cloneForFleetWork(url, datasetPath, {
    partial: false,
    description: "fleet-content-recovery",
  });
  if (cloned) {
    rmSync(datasetPath, { recursive: true, force: true });
    return { ...unmeasured, error: cloned };
  }

  try {
    const keyPaths = await annexedKeyPaths(datasetPath);
    const held = await objects(datasetId);
    // Not `held.has(key)`: a zero-byte object left by a failed copy carries the
    // right name and none of the content (#967).
    const missingKeys = [...keyPaths.keys()].filter(
      (key) => !isKeyPresentAtDeclaredSize(key, held),
    );
    if (missingKeys.length === 0) return tally(datasetId, [], []);

    const pins = await readPinnedSources(datasetPath, missingKeys);
    // Always list upstream for an imported dataset, even when every key has a
    // pin. A pin identifies content; it does not promise the object is still
    // readable, and the listing is what a refused pin falls through to:
    // on003645's recorded versions are all gone while the right bytes sit at the
    // same paths under newer ids. One call per dataset.
    let upstream:
      | { bucket: string; prefix: string; index: Map<string, UpstreamObjectVersion[]> }
      | undefined;
    if (datasetId.startsWith("on")) {
      const prefix = `ds${datasetId.slice(2)}/`;
      upstream = {
        bucket: UPSTREAM_BUCKET,
        prefix,
        index: await listUpstreamObjectVersions({ bucket: UPSTREAM_BUCKET, prefix }),
      };
    }

    const planned = missingKeys
      .map((key) =>
        planKeyRecovery({
          key,
          paths: keyPaths.get(key) ?? [],
          pins: pins.get(key) ?? [],
          upstream,
        }),
      )
      // Smallest first: a run that is interrupted or limited has then recovered
      // as many keys as it could rather than as many bytes.
      .sort((a, b) => a.size - b.size);
    const targets = options.limit ? planned.slice(0, options.limit) : planned;

    const prefix = await destinationPrefix(datasetPath, datasetId, options.remoteName);
    let done = 0;
    const outcomes = await mapWithConcurrency(
      targets,
      options.concurrency ?? 8,
      async (entry: RecoveryPlanEntry) => {
        const outcome = await recoverKey({
          entry,
          destBucket: "nemar",
          destKey: `${prefix}${entry.key}`,
          apply: options.apply === true,
          env: options.env,
        });
        options.onKey?.(outcome, ++done, targets.length);
        return outcome;
      },
    );
    return tally(datasetId, planned, outcomes);
  } catch (error) {
    // Anything thrown in here -- a failed pin read, an upstream listing that
    // refused, a truncated cat-file -- means the dataset was not measured. Its
    // zeros must not read as "nothing missing".
    return {
      ...unmeasured,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(datasetPath, { recursive: true, force: true });
  }
}

export interface ContentRecoverySweep {
  outcomes: DatasetRecoveryOutcome[];
  tally: Record<DatasetRecoveryAction, number>;
  recoveredKeys: number;
  recoveredBytes: number;
}

export async function sweepContentRecovery(
  datasetIds: string[],
  objects: ObjectSource,
  options: ContentRecoveryOptions & {
    onDataset?: (outcome: DatasetRecoveryOutcome, done: number, total: number) => void;
  },
): Promise<ContentRecoverySweep> {
  // Sequential on purpose. Every unit of work here is an S3 copy that S3 is
  // doing, so a second dataset in flight buys nothing and makes a partial run
  // harder to reason about.
  const unique = [...new Set(datasetIds)];
  const outcomes: DatasetRecoveryOutcome[] = [];
  let done = 0;
  for (const datasetId of unique) {
    let outcome: DatasetRecoveryOutcome;
    try {
      outcome = await recoverDatasetContent(datasetId, objects, options);
    } catch (error) {
      outcome = {
        ...tally(datasetId, [], []),
        measured: false,
        action: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    outcomes.push(outcome);
    options.onDataset?.(outcome, ++done, unique.length);
  }
  // Annotated, never cast. `as` silences the one compile-time check this union
  // buys: add a member to DatasetRecoveryAction and the cast still compiles,
  // then `counts[action]++` increments undefined and the whole tally is NaN.
  const counts: Record<DatasetRecoveryAction, number> = {
    "nothing-missing": 0,
    recovered: 0,
    "would-recover": 0,
    partial: 0,
    unrecoverable: 0,
    failed: 0,
  };
  let recoveredKeys = 0;
  let recoveredBytes = 0;
  for (const outcome of outcomes) {
    counts[outcome.action]++;
    recoveredKeys += outcome.recovered;
    recoveredBytes += outcome.recoveredBytes;
  }
  return { outcomes, tally: counts, recoveredKeys, recoveredBytes };
}
