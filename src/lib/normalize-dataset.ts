/**
 * Bringing an EXISTING dataset repository onto NEMAR's annex policy.
 *
 * The import path applies the policy to a tree on its way in (ADR 0058). This is
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

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestUploadCredentials } from "./api/data.js";
import { cloneDataset, pushToGitHub } from "./git-annex/clone-push.js";
import { runCommand } from "./git-annex/run-command.js";
import { configureS3Remote, toS3Credentials } from "./git-annex/s3-remote.js";
import { batchSetKeysPresent, getRemoteUuid } from "./git-annex/transfer.js";
import { type UploadStrategy, normalizeImportedTree } from "./import-normalize.js";
import { findUnannexedData } from "./import-openneuro.js";
import { isKeyPresentAtDeclaredSize, listExistingObjects } from "./s3-server-copy.js";

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
  options: {
    push?: boolean;
    maxBytes?: number;
    remoteName?: string;
    credentials?: CredentialSource;
    /** Override the upload leg; the tests use it to drive the contract a strategy owes. */
    upload?: UploadStrategy;
  } = {},
): Promise<NormalizeDatasetResult> {
  const remoteName = options.remoteName ?? REMOTE_NAME;
  const { datasetId, datasetPath } = plan;
  let upload: UploadStrategy | undefined = options.upload;

  if (upload) {
    // Supplied by the caller: neither credential path applies.
  } else if (remoteName === REMOTE_NAME && options.credentials === "ambient") {
    // No `enableremote`: that contacts S3 with git-annex's own credential handling,
    // which is the thing being bypassed. The UUID comes from the git-annex branch,
    // where the import recorded it, so keys are registered against the same remote
    // every existing clone already knows.
    const remoteUuid = await resolveSpecialRemoteUuid(datasetPath, remoteName);
    if (!remoteUuid) {
      throw new Error(
        `${datasetId} has no ${remoteName} remote recorded in its git-annex branch, so there is no UUID to register keys against. Was this dataset ever uploaded?`,
      );
    }
    upload = awsCliUpload({
      bucket: "nemar",
      datasetId,
      region: "us-east-2",
      remoteUuid,
      workDir: join(datasetPath, ".."),
    });
  } else if (remoteName === REMOTE_NAME) {
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
    upload,
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
 * Which credentials move the bytes.
 *
 * `"backend"` asks the API to mint STS credentials scoped to this dataset, the way
 * an ordinary upload does. It is the right default and the wrong choice for an
 * imported dataset: those credentials are federated from the Worker's own identity,
 * which has no access to an `on######` prefix, so every request is refused (#1380).
 *
 * `"ambient"` uses whatever the `aws` CLI is configured with on this machine, and
 * moves the content with `aws s3 sync` instead of git-annex's S3 client. The keys
 * are then registered in the location log directly, which is exactly how the
 * import's finalize phase records a server-side copy it did not perform itself.
 */
export type CredentialSource = "backend" | "ambient";

/** The UUID a special remote already has in the git-annex branch, without contacting it. */
export async function resolveSpecialRemoteUuid(
  datasetPath: string,
  remoteName: string,
): Promise<string | null> {
  const { stdout, exitCode } = await runCommand(["git", "show", "git-annex:remote.log"], {
    cwd: datasetPath,
  });
  if (exitCode !== 0) return null;
  for (const line of stdout.split("\n")) {
    if (!line.includes(`name=${remoteName}`)) continue;
    const uuid = line.split(/\s+/)[0];
    if (/^[0-9a-f-]{36}$/.test(uuid)) return uuid;
  }
  return null;
}

/**
 * Move content with the `aws` CLI's own credentials, then record it in the location
 * log and confirm it against the bucket.
 *
 * Three steps, and the order matters the same way it does everywhere else here:
 *
 * 1. Hard-link each key's annex object into a staging directory NAMED by the key,
 *    so one `aws s3 sync` uploads the whole set in parallel and resumes by skipping
 *    what is already there at the right size. Hard links cost no disk and no copy.
 * 2. `setpresentkey` for each key, which is what tells clones the remote has it.
 *    git-annex did not perform this transfer, so nothing else would say so -- this
 *    is the same registration `finalizeImport` does after a server-side copy.
 * 3. List the destination and require every key present AT ITS DECLARED SIZE. This
 *    is the real proof, and it is deliberately not the location log: the log now
 *    contains our own claim, so reading it back would only confirm we wrote it.
 */
export function awsCliUpload(options: {
  bucket: string;
  datasetId: string;
  region: string;
  remoteUuid: string;
  workDir: string;
}): UploadStrategy {
  return async ({ datasetPath, files }) => {
    const staging = join(options.workDir, "upload-staging");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });

    try {
      for (const file of files) {
        const located = await runCommand(["git", "annex", "contentlocation", file.key], {
          cwd: datasetPath,
        });
        if (located.exitCode !== 0 || !located.stdout.trim()) {
          throw new Error(
            `git-annex cannot locate the content it just took for ${file.path} (${file.key}). Not uploading: the key would be registered with nothing behind it.`,
          );
        }
        const link = await runCommand(
          ["ln", join(datasetPath, located.stdout.trim()), join(staging, file.key)],
          {},
        );
        if (link.exitCode !== 0) {
          throw new Error(`Could not stage ${file.key} for upload: ${link.stderr.trim()}`);
        }
      }

      const destination = `s3://${options.bucket}/${options.datasetId}/objects/`;
      const sync = await runCommand(
        [
          "aws",
          "s3",
          "sync",
          staging,
          destination,
          "--region",
          options.region,
          "--size-only",
          "--only-show-errors",
        ],
        {},
      );
      if (sync.exitCode !== 0) {
        throw new Error(
          `aws s3 sync to ${destination} failed: ${(sync.stderr || sync.stdout).trim().slice(0, 600)}. Not committing: the pushed tree would name keys with no content behind them.`,
        );
      }

      const registered = await batchSetKeysPresent(
        datasetPath,
        files.map((f) => f.key),
        options.remoteUuid,
      );
      if (registered.failed > 0) {
        throw new Error(
          `Uploaded ${files.length} object(s) but ${registered.failed} key registration(s) failed. Not committing: clones could not find content that is actually there.`,
        );
      }

      const existing = await listExistingObjects(
        options.bucket,
        `${options.datasetId}/objects/`,
        options.region,
      );
      const missing = files.filter((f) => !isKeyPresentAtDeclaredSize(f.key, existing));
      if (missing.length > 0) {
        throw new Error(
          `${missing.length} of ${files.length} object(s) are absent from ${destination} or the wrong size (${missing
            .slice(0, 3)
            .map((f) => f.path)
            .join(", ")}${missing.length > 3 ? ", ..." : ""}). Not committing.`,
        );
      }

      return { copied: files.length };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
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
