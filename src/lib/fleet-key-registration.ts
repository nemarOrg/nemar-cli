/**
 * Re-register annexed content NEMAR holds but never advertised (#1392).
 *
 * `batchSetKeysPresent` used to run fifty `setpresentkey` processes at once and
 * count every exit-0 as a registration. It is fixed, but the datasets it already
 * lied about are still out there: a fleet sweep found 528 of 600 imported
 * datasets with ZERO keys recorded at `nemar-s3`, 720,896 keys in total, every
 * one of them sitting in the bucket.
 *
 * Those datasets are not broken for a user -- an imported repository carries
 * OpenNeuro's `s3-PUBLIC` remote with `autoenable=true`, so `git annex get`
 * still works. What is broken is that NEMAR does not serve its own copy, so
 * every clone goes to upstream and the archive's independence from OpenNeuro is
 * not real.
 *
 * Two rules this module will not bend:
 *
 *  1. **What the bucket holds is established by listing it, once, with
 *     credentials.** Not by a per-key anonymous HEAD: `s3://nemar` denies
 *     anonymous ListBucket, so S3 answers a missing key with 403 rather than
 *     404, and 403 also means private, expired, or signed without a session
 *     token. One `list-objects-v2` per dataset is both conclusive and cheaper
 *     than 4,177 HEADs.
 *  2. **A dataset the bucket cannot fully account for is left alone.** If any
 *     annexed key has no object, this is not a lost registration, it is content
 *     that was never transferred (#1396), and registering the rest would write
 *     true claims into a repository whose real problem is elsewhere. Reported
 *     and skipped, unless the caller asks otherwise.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { requestUploadCredentials } from "./api/data.js";
import { listS3ObjectKeys } from "./aws-cli.js";
import { cloneDataset, pushToGitHub } from "./git-annex/clone-push.js";
import { runCommand } from "./git-annex/run-command.js";
import { batchSetKeysPresent } from "./git-annex/transfer.js";

/** The name the import gives NEMAR's own S3 special remote. */
export const REMOTE_NAME = "nemar-s3";

/** What the bucket holds for a dataset, as bare keys with the prefix stripped. */
export type ObjectSource = (datasetId: string) => Promise<Set<string>>;

export interface KeyRegistrationState {
  datasetId: string;
  /** NEMAR's remote UUID from the git-annex branch, or null when it has none. */
  remoteUuid: string | null;
  /** Distinct keys the working tree names. */
  annexed: string[];
  /** Of those, the ones the location log already records at NEMAR's remote. */
  registered: string[];
  /** Of those, the ones the bucket actually holds. */
  inBucket: string[];
  /** In the bucket and not in the log: the repair target. */
  toRegister: string[];
  /** Annexed, and no object in the bucket: #1396's shape, not this one's. */
  missingContent: string[];
}

export type KeyRegistrationAction =
  | "compliant"
  | "repaired"
  | "would-repair"
  | "skipped-missing-content"
  | "skipped-no-remote"
  | "failed";

export interface KeyRegistrationOutcome {
  datasetId: string;
  action: KeyRegistrationAction;
  state?: KeyRegistrationState;
  pushed: boolean;
  notes: string[];
  error?: string;
}

/**
 * List a dataset's `objects/` prefix with credentials the API mints for it.
 *
 * Read-only despite the name: upload credentials are what grant access to the
 * prefix, and listing is the cheapest thing they can do.
 */
export function bucketObjectSource(): ObjectSource {
  return async (datasetId) => {
    const creds = await requestUploadCredentials(datasetId);
    return listS3ObjectKeys({
      credentials: creds.credentials,
      bucket: creds.s3.bucket,
      region: creds.s3.region,
      prefix: creds.s3.prefix,
    });
  };
}

/** Distinct keys the tree names, sorted. */
async function annexedKeys(datasetPath: string): Promise<string[]> {
  // `--include '*'` and not `--all`, which `find` rejects.
  const { stdout } = await runCommand(
    ["git", "annex", "find", "--include", "*", "--format=${key}\n"],
    { cwd: datasetPath },
  );
  return [...new Set(stdout.split("\n").filter(Boolean))].sort();
}

/** Keys the location log records at this remote, sorted. */
async function keysRecordedAt(datasetPath: string, remoteUuid: string): Promise<string[]> {
  const { stdout } = await runCommand(
    ["git", "annex", "find", "--include", "*", "--in", remoteUuid, "--format=${key}\n"],
    { cwd: datasetPath },
  );
  return [...new Set(stdout.split("\n").filter(Boolean))].sort();
}

/** NEMAR's remote UUID as the git-annex branch records it. */
export async function resolveRemoteUuid(
  datasetPath: string,
  remoteName = REMOTE_NAME,
): Promise<string | null> {
  const { stdout, exitCode } = await runCommand(["git", "show", "git-annex:remote.log"], {
    cwd: datasetPath,
  });
  if (exitCode !== 0) return null;
  for (const line of stdout.split("\n")) {
    if (!line.includes(`name=${remoteName}`)) continue;
    const uuid = line.trim().split(/\s+/)[0];
    if (uuid) return uuid;
  }
  return null;
}

/**
 * Read one dataset's registration state. Touches nothing.
 *
 * `datasetPath` must be a clone that already has the git-annex branch and an
 * initialized annex; `sweepKeyRegistration` arranges that.
 */
export async function scanDatasetKeyRegistration(
  datasetId: string,
  datasetPath: string,
  objects: ObjectSource,
  remoteName = REMOTE_NAME,
): Promise<KeyRegistrationState> {
  const remoteUuid = await resolveRemoteUuid(datasetPath, remoteName);
  const annexed = await annexedKeys(datasetPath);
  if (!remoteUuid) {
    return {
      datasetId,
      remoteUuid: null,
      annexed,
      registered: [],
      inBucket: [],
      toRegister: [],
      missingContent: [],
    };
  }
  const registered = await keysRecordedAt(datasetPath, remoteUuid);
  const held = await objects(datasetId);
  const recorded = new Set(registered);
  const inBucket = annexed.filter((key) => held.has(key));
  return {
    datasetId,
    remoteUuid,
    annexed,
    registered,
    inBucket,
    toRegister: inBucket.filter((key) => !recorded.has(key)),
    missingContent: annexed.filter((key) => !held.has(key)),
  };
}

export interface KeyRegistrationOptions {
  /** Where clones go. Each is removed when its dataset is done. */
  workRoot: string;
  /** Write and push. Without it nothing is changed. */
  apply?: boolean;
  /** Commit locally and push nothing, for a rehearsal. */
  push?: boolean;
  /** Act even on a dataset whose content the bucket cannot fully account for. */
  includeIncomplete?: boolean;
  /** Where to clone from; the org repository by default. */
  originUrl?: string;
  remoteName?: string;
}

/**
 * Repair one dataset, and prove it from the location log before pushing.
 *
 * The order is deliberate: register, re-read the log, and only then push. A push
 * is the irreversible half, and the whole reason this issue exists is that the
 * previous code trusted a return value it never checked.
 */
export async function repairDatasetKeyRegistration(
  datasetId: string,
  objects: ObjectSource,
  options: KeyRegistrationOptions,
): Promise<KeyRegistrationOutcome> {
  const remoteName = options.remoteName ?? REMOTE_NAME;
  const datasetPath = join(options.workRoot, datasetId);
  const notes: string[] = [];
  rmSync(datasetPath, { recursive: true, force: true });

  const url = options.originUrl ?? `https://github.com/nemarDatasets/${datasetId}.git`;
  // `--filter=blob:none` keeps this cheap: the working tree is pointers and the
  // location log is small, and no annexed content is ever wanted here.
  const cloned = await cloneDataset(url, datasetPath, { useGitHubToken: true });
  if (!cloned.success) {
    return { datasetId, action: "failed", pushed: false, notes, error: cloned.error };
  }
  await runCommand(["git", "annex", "init", "--quiet", "fleet-key-registration"], {
    cwd: datasetPath,
  });

  try {
    const state = await scanDatasetKeyRegistration(datasetId, datasetPath, objects, remoteName);
    if (!state.remoteUuid) {
      return {
        datasetId,
        action: "skipped-no-remote",
        state,
        pushed: false,
        notes: [`no ${remoteName} remote in the git-annex branch; nothing to register against`],
      };
    }
    if (state.missingContent.length > 0 && !options.includeIncomplete) {
      return {
        datasetId,
        action: "skipped-missing-content",
        state,
        pushed: false,
        notes: [
          `${state.missingContent.length} of ${state.annexed.length} annexed key(s) have no object in the bucket, so this is missing content (#1396) rather than a lost registration; first: ${state.missingContent[0]}`,
        ],
      };
    }
    if (state.toRegister.length === 0) {
      return { datasetId, action: "compliant", state, pushed: false, notes };
    }
    if (!options.apply) {
      return {
        datasetId,
        action: "would-repair",
        state,
        pushed: false,
        notes: [`${state.toRegister.length} key(s) are in the bucket and not in the log`],
      };
    }

    const result = await batchSetKeysPresent(datasetPath, state.toRegister, state.remoteUuid);
    // Ask the log rather than the helper. It is fixed and it already does this,
    // but a sweep over 529 published repositories is not the place to take a
    // second-hand answer about whether a write landed.
    const after = new Set(await keysRecordedAt(datasetPath, state.remoteUuid));
    const stillMissing = state.toRegister.filter((key) => !after.has(key));
    if (stillMissing.length > 0) {
      return {
        datasetId,
        action: "failed",
        state,
        pushed: false,
        notes,
        error: `registered ${result.success} of ${state.toRegister.length}, and the location log still does not record ${stillMissing.length} of them (first: ${stillMissing[0]}). Nothing pushed.`,
      };
    }
    notes.push(`registered ${state.toRegister.length} key(s), all confirmed in the location log`);

    if (options.push === false) {
      return { datasetId, action: "repaired", state, pushed: false, notes };
    }
    const pushed = await pushToGitHub(datasetPath, "origin", "git-annex");
    if (!pushed.success) {
      return {
        datasetId,
        action: "failed",
        state,
        pushed: false,
        notes,
        error: `the git-annex branch did not push: ${pushed.error}. The registration is local only; re-run to redo it.`,
      };
    }
    return { datasetId, action: "repaired", state, pushed: true, notes };
  } finally {
    rmSync(datasetPath, { recursive: true, force: true });
  }
}

/** Run `work` over `items` with at most `limit` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface KeyRegistrationSweep {
  outcomes: KeyRegistrationOutcome[];
  tally: Record<KeyRegistrationAction, number>;
  /** Keys registered across the whole sweep. */
  keysRegistered: number;
}

export async function sweepKeyRegistration(
  datasetIds: string[],
  objects: ObjectSource,
  options: KeyRegistrationOptions & {
    concurrency?: number;
    onDataset?: (outcome: KeyRegistrationOutcome, done: number, total: number) => void;
  },
): Promise<KeyRegistrationSweep> {
  let done = 0;
  const outcomes = await mapWithConcurrency(
    datasetIds,
    options.concurrency ?? 4,
    async (datasetId) => {
      let outcome: KeyRegistrationOutcome;
      try {
        outcome = await repairDatasetKeyRegistration(datasetId, objects, options);
      } catch (error) {
        outcome = {
          datasetId,
          action: "failed",
          pushed: false,
          notes: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      options.onDataset?.(outcome, ++done, datasetIds.length);
      return outcome;
    },
  );

  const tally = {
    compliant: 0,
    repaired: 0,
    "would-repair": 0,
    "skipped-missing-content": 0,
    "skipped-no-remote": 0,
    failed: 0,
  } as Record<KeyRegistrationAction, number>;
  let keysRegistered = 0;
  for (const outcome of outcomes) {
    tally[outcome.action]++;
    if (outcome.action === "repaired") keysRegistered += outcome.state?.toRegister.length ?? 0;
  }
  return { outcomes, tally, keysRegistered };
}
