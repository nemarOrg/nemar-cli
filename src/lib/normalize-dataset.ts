/**
 * Bringing an EXISTING dataset repository onto NEMAR's annex policy.
 *
 * The import path applies the policy to a tree on its way in (ADR 0057). This is
 * the same operation for a dataset that is already published: `on007788` carries
 * 893 `_motion.tsv` recordings, 675 MB, as plain git blobs because OpenNeuro
 * annexed on size alone and the import inherited that (#1158, #1159), and every
 * dataset imported before that fix still carries upstream's `annex.largefiles`
 * attributes instead of ours (#1374).
 *
 * **It is a forward fix, and for a published dataset that is the only safe shape.**
 * A version manifest addresses a git-resident file by a `git:` key whose download
 * URL is `raw.githubusercontent.com/<repo>/<tag>/<path>` -- `on007788`'s v1.0.0
 * manifest does this for all 893 of them, under a registered version DOI. Rewriting
 * history to evict the blobs would break every one of those URLs. So this adds a
 * commit: HEAD stops carrying data in git, published versions keep resolving exactly
 * as they do today, and the repository does not shrink.
 *
 * Nothing here touches a DOI, a tag, a version manifest, an archive, or S3 objects
 * other than adding the new keys' content.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestUploadCredentials } from "./api/data.js";
import { cloneDataset, pushToGitHub } from "./git-annex/clone-push.js";
import { runCommand } from "./git-annex/run-command.js";
import { configureS3Remote, toS3Credentials } from "./git-annex/s3-remote.js";
import { getRemoteUuid } from "./git-annex/transfer.js";
import { normalizeImportedTree } from "./import-normalize.js";
import { findUnannexedData } from "./import-openneuro.js";

const REMOTE_NAME = "nemar-s3";

export interface NormalizeDatasetPlan {
  datasetId: string;
  datasetPath: string;
  /** Files NEMAR policy calls data that this repository keeps in git. */
  files: Array<{ path: string; size: number }>;
  bytes: number;
  /** Tracked `.gitattributes` files carrying an inherited largefiles rule. */
  attributeFiles: string[];
}

export interface NormalizeDatasetResult {
  plan: NormalizeDatasetPlan;
  /** Keys whose content this run uploaded, for the verification step. */
  keys: string[];
  committed: boolean;
  pushed: boolean;
  notes: string[];
}

/**
 * Clone the dataset and report what normalizing it would change, without touching
 * anything. The clone is full (data in git has to be present to be measured and,
 * later, uploaded), so this costs the repository's size on disk.
 */
export async function planDatasetNormalization(
  datasetId: string,
  options: { workDir?: string } = {},
): Promise<NormalizeDatasetPlan> {
  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), `nemar-normalize-${datasetId}-`));
  const datasetPath = join(workDir, datasetId);

  if (existsSync(join(datasetPath, ".git"))) {
    // Reuse rather than re-clone, so a run interrupted after some of the upload
    // resumes instead of pulling the repository down again. Only a clone that is
    // exactly at origin/main qualifies: normalizing a stale tree would commit a
    // HEAD built on someone else's outdated snapshot.
    await assertCloneMatchesOrigin(datasetPath, datasetId);
  } else {
    const clone = await cloneDataset(`git@github.com:nemarDatasets/${datasetId}.git`, datasetPath, {
      useGitHubToken: true,
    });
    if (!clone.success) {
      throw new Error(`Failed to clone ${datasetId}: ${clone.error}`);
    }
  }

  const files = await findUnannexedData(datasetPath);
  const attributeFiles = await listAttributeFilesWithLargefiles(datasetPath);
  return {
    datasetId,
    datasetPath,
    files,
    bytes: files.reduce((sum, f) => sum + f.size, 0),
    attributeFiles,
  };
}

/**
 * Refuse an existing clone that is not this dataset at its current `origin/main`.
 *
 * A clone left over from an earlier run is worth reusing (the alternative is
 * re-downloading hundreds of megabytes to redo an interrupted upload), but only
 * when it still describes the same starting point. A local commit already made by
 * a previous attempt is allowed: `origin/main` has to be an ancestor of HEAD, not
 * equal to it, or a resumed run could never get past its own commit.
 */
async function assertCloneMatchesOrigin(datasetPath: string, datasetId: string): Promise<void> {
  const remote = await runCommand(["git", "remote", "get-url", "origin"], { cwd: datasetPath });
  if (remote.exitCode !== 0 || !remote.stdout.includes(`/${datasetId}`)) {
    throw new Error(
      `${datasetPath} exists but its origin is not ${datasetId} (${remote.stdout.trim() || "no origin"}). Point --dir somewhere else.`,
    );
  }
  const fetched = await runCommand(["git", "fetch", "origin", "main"], { cwd: datasetPath });
  if (fetched.exitCode !== 0) {
    throw new Error(`Could not fetch origin/main in ${datasetPath}: ${fetched.stderr.trim()}`);
  }
  const ancestor = await runCommand(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"], {
    cwd: datasetPath,
  });
  if (ancestor.exitCode !== 0) {
    throw new Error(
      `${datasetPath} is behind or diverged from origin/main. Delete it and let this re-clone, rather than committing onto a stale tree.`,
    );
  }

  // A clone left dirty by a failed attempt is the dangerous case, not the stale
  // one. Its data files are already annexed in the index, so `findUnannexedData`
  // reports nothing left to move and a re-run would report success having done
  // nothing at all -- the data still in git, the operator told it was migrated.
  // Refuse, and say how to get back to a state this can work from.
  const status = await runCommand(["git", "status", "--porcelain"], { cwd: datasetPath });
  if (status.exitCode !== 0) {
    throw new Error(`Could not read the status of ${datasetPath}: ${status.stderr.trim()}`);
  }
  if (status.stdout.trim() !== "") {
    throw new Error(
      `${datasetPath} has uncommitted changes, most likely a previous attempt that stopped after annexing but before committing. Reset it (git -C ${datasetPath} reset --hard origin/main) or delete it, then re-run: continuing from here would find nothing left to move and report success without migrating anything.`,
    );
  }
}

/** Tracked `.gitattributes` files that still carry an `annex.largefiles` rule. */
async function listAttributeFilesWithLargefiles(datasetPath: string): Promise<string[]> {
  const { stdout, exitCode, stderr } = await runCommand(
    ["git", "grep", "-l", "annex.largefiles", "HEAD", "--", ".gitattributes", "*/.gitattributes"],
    { cwd: datasetPath },
  );
  // git grep exits 1 for "no matches", which is not an error here.
  if (exitCode > 1) {
    throw new Error(`git grep failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^HEAD:/, ""));
}

/**
 * Apply the policy to a planned dataset and push the result.
 *
 * Credentials come from the backend (`POST /datasets/:id/upload-credentials`),
 * scoped to this dataset's `objects/` prefix, the same way an ordinary upload gets
 * them -- no ambient AWS keys, and nothing long-lived on the operator's machine.
 *
 * The order is the import's order, for the same reason: content reaches S3 before
 * the tree that names it is committed, and nothing is pushed until both are done.
 * `remoteName` is enabled rather than created: a published dataset already has
 * `nemar-s3` registered in its git-annex branch, and reusing that UUID is what
 * keeps existing clones able to find the new keys.
 */
export async function normalizeDatasetRepo(
  plan: NormalizeDatasetPlan,
  options: { push?: boolean; maxBytes?: number; remoteName?: string } = {},
): Promise<NormalizeDatasetResult> {
  const remoteName = options.remoteName ?? REMOTE_NAME;
  const { datasetId, datasetPath } = plan;

  // A stand-in remote (a test or a rehearsal) is configured by the caller; the real
  // one is enabled here with credentials minted for this dataset.
  if (remoteName === REMOTE_NAME) {
    const creds = await requestUploadCredentials(datasetId);
    const configured = await configureS3Remote(
      datasetPath,
      {
        name: remoteName,
        bucket: creds.s3.bucket,
        prefix: creds.s3.prefix,
        region: creds.s3.region,
      },
      toS3Credentials(creds.credentials),
    );
    if (!configured.success) {
      throw new Error(`Failed to enable ${remoteName}: ${configured.error}`);
    }
    const uuid = await getRemoteUuid(datasetPath, remoteName);
    if (!uuid) {
      throw new Error(
        `Could not resolve the ${remoteName} UUID after enabling it. Aborting: keys registered against an unknown remote are unfindable for clones.`,
      );
    }
  }

  const normalized = await normalizeImportedTree({
    datasetPath,
    nemarId: datasetId,
    bucket: "nemar",
    remoteName,
    unannexedData: plan.files,
    // Not an import: there is no upstream key set, and nothing to carry over --
    // every key this tree holds is already registered where it belongs.
    upstreamKeys: new Set<string>(),
    carryOverUnaccountedKeys: false,
    maxBytes: options.maxBytes,
  });

  let pushed = false;
  if (options.push && normalized.committed) {
    const push = await pushToGitHub(datasetPath, "origin");
    if (!push.success) {
      throw new Error(
        `Normalized and committed ${datasetId}, but the push failed: ${push.error}. The content is already in S3 and the commit is local; re-run the push from ${datasetPath} rather than redoing the upload.`,
      );
    }
    if (push.warning) {
      throw new Error(
        `Pushed main for ${datasetId} but the git-annex branch did not land: ${push.warning}. Clones cannot find the new keys until it does -- push the git-annex branch from ${datasetPath} before considering this done.`,
      );
    }
    pushed = true;
  }

  return {
    plan,
    keys: (normalized.data?.files ?? []).map((f) => f.key),
    committed: normalized.committed,
    pushed,
    notes: normalized.notes,
  };
}

/**
 * Ask the remote, not the location log, whether it really holds these keys.
 *
 * `git annex fsck --from <remote> --fast` checks each key's presence and size at the
 * remote itself, which is the independent half of the guarantee: the log says what
 * git-annex believes, and this says what the remote confirms. `--fast` skips
 * downloading the content back, so this is cheap for 675 MB.
 */
export async function verifyKeysAtRemote(
  datasetPath: string,
  paths: string[],
  remoteName = REMOTE_NAME,
): Promise<{ ok: boolean; output: string }> {
  if (paths.length === 0) return { ok: true, output: "no keys to verify" };
  const { stdout, stderr, exitCode } = await runCommand(
    [
      "git",
      "annex",
      "fsck",
      "--from",
      remoteName,
      "--fast",
      "--quiet",
      "--",
      ...paths.slice(0, 200),
    ],
    { cwd: datasetPath },
  );
  return { ok: exitCode === 0, output: (stderr || stdout).trim() };
}
