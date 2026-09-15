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
 * wrote has to match the key, or the key is reported unrecoverable (ADR 0062).
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
  await proc.exited;
  // The stream is <sha> <type> <size>\n<size bytes>\n per request, in order. The
  // sizes are BYTE counts, so the walk has to stay on a buffer: decoding first
  // and slicing by character would drift on any non-ASCII object path.
  let cursor = 0;
  for (const path of paths) {
    const newline = out.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const header = out.subarray(cursor, newline).toString("utf8").split(" ");
    if (header[1] === "missing") {
      cursor = newline + 1;
      continue;
    }
    const size = Number(header[2]);
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
  const remoteLog = await runCommand(["git", "show", `${ref}:remote.log`], { cwd: datasetPath });
  if (remoteLog.exitCode !== 0) return new Map();
  const remotes = parseRemoteLog(remoteLog.stdout);

  const listing = await runCommand(["git", "ls-tree", "-r", "--name-only", ref], {
    cwd: datasetPath,
  });
  if (listing.exitCode !== 0) return new Map();
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
  const { stdout, exitCode } = await runCommand(["git", "show", `${ref}:remote.log`], {
    cwd: datasetPath,
  });
  if (exitCode === 0) {
    for (const remote of parseRemoteLog(stdout).values()) {
      if (remote.name === remoteName && remote.fileprefix) return remote.fileprefix;
    }
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
  let action: DatasetRecoveryAction;
  if (missing.length === 0) action = "nothing-missing";
  else if (failed > 0) action = "failed";
  else if (would > 0) action = "would-recover";
  else if (recovered > 0) action = unrecoverable > 0 ? "partial" : "recovered";
  else action = "unrecoverable";
  return {
    datasetId,
    action,
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
  const empty = tally(datasetId, [], []);
  if (!DATASET_ID_RE.test(datasetId)) {
    return {
      ...empty,
      action: "failed",
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
    return { ...empty, action: "failed", error: cloned };
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
    // The upstream listing is one call for the whole dataset and is only worth
    // making when some key has no pin of its own.
    let upstream:
      | { bucket: string; prefix: string; index: Map<string, UpstreamObjectVersion[]> }
      | undefined;
    const unpinned = missingKeys.filter((key) => !pins.has(key));
    if (unpinned.length > 0 && datasetId.startsWith("on")) {
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
    return {
      ...empty,
      action: "failed",
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
        action: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    outcomes.push(outcome);
    options.onDataset?.(outcome, ++done, unique.length);
  }
  const counts = {
    "nothing-missing": 0,
    recovered: 0,
    "would-recover": 0,
    partial: 0,
    unrecoverable: 0,
    failed: 0,
  } as Record<DatasetRecoveryAction, number>;
  let recoveredKeys = 0;
  let recoveredBytes = 0;
  for (const outcome of outcomes) {
    counts[outcome.action]++;
    recoveredKeys += outcome.recovered;
    recoveredBytes += outcome.recoveredBytes;
  }
  return { outcomes, tally: counts, recoveredKeys, recoveredBytes };
}
