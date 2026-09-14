/**
 * Bringing an EXISTING dataset repository onto NEMAR's annex policy.
 *
 * The import path applies the policy to a tree on its way in (ADR 0060). This is
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
import { headS3Objects, probeS3PrefixAccess } from "./aws-cli.js";
import { cloneDataset, pushToGitHub } from "./git-annex/clone-push.js";
import { runCommand } from "./git-annex/run-command.js";
import { configureS3Remote, toS3Credentials } from "./git-annex/s3-remote.js";
import { batchSetKeysPresent, getRemoteUuid } from "./git-annex/transfer.js";
import {
  type UploadStrategy,
  annexCopyUpload,
  normalizeImportedTree,
  stripLargefilesAttributes,
} from "./import-normalize.js";
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
  /** Keys whose content this run uploaded. */
  keys: string[];
  committed: boolean;
  pushed: boolean;
  notes: string[];
  /** What the remote said about those keys; `null` when there were none to check. */
  verification: KeyPresenceReport | null;
}

/**
 * What the remote holds of what this run uploaded.
 *
 * `unconfirmed` is deliberately separate from `absent`: a question that could not
 * be asked is not an answer that the content is missing, and conflating the two is
 * how #1380 was misdiagnosed for weeks.
 */
export interface KeyPresenceReport {
  present: string[];
  absent: string[];
  unconfirmed: string[];
  /** How the check was made, for the message the operator reads. */
  method: string;
  /** The first failure detail, when anything was absent or unconfirmed. */
  detail?: string;
}

/** Asks the remote whether it holds these keys. */
type RemoteVerifier = (keys: string[]) => Promise<KeyPresenceReport>;

/**
 * Clone the dataset and report what normalizing it would change, without touching
 * anything. The clone is full (data in git has to be present to be measured and,
 * later, uploaded), so this costs the repository's size on disk.
 */
export async function planDatasetNormalization(
  datasetId: string,
  options: {
    workDir?: string;
    /**
     * Where to clone from. Defaults to the dataset's repository in `nemarDatasets`;
     * a caller passes this to normalize a repository that is not there yet, and the
     * fleet tests to drive the real clone-and-push against a local origin.
     */
    originUrl?: string;
  } = {},
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
    const originUrl = options.originUrl ?? `git@github.com:nemarDatasets/${datasetId}.git`;
    const clone = await cloneDataset(originUrl, datasetPath, {
      useGitHubToken: !options.originUrl,
    });
    if (!clone.success) {
      throw new Error(`Failed to clone ${datasetId}: ${clone.error}`);
    }
  }
  await checkoutMain(datasetPath, datasetId);

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

/**
 * Put the clone on `main`, whatever the repository calls its default branch.
 *
 * A plain `git clone` checks out the default branch, and sixteen dataset
 * repositories have theirs set to `git-annex` -- git-annex's own internal log
 * branch, which carries no dataset at all. On such a clone the scan finds no data and
 * no `.gitattributes`, the policy is still configured (that is repository-wide, so it
 * does land), and the push carries the log branch while `main` keeps upstream's
 * attributes: a run that changes nothing and looks like it worked. Measured on
 * `on002720` and `on002721` during the #1374 rollout, where the post-push
 * verification is what caught it.
 *
 * `nemar admin fleet drift` reports these repositories as DEFAULT_BRANCH_OUTLIER
 * (epic #713); this makes the migration immune to the condition rather than waiting
 * for it to be fixed.
 */
async function checkoutMain(datasetPath: string, datasetId: string): Promise<void> {
  const head = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: datasetPath,
  });
  const branch = head.stdout.trim();
  // An adjusted branch (DataLad's unlocked checkout) tracks main and is not an outlier.
  if (branch === "main" || branch.startsWith("adjusted/main")) return;
  // Cloning such a repository checks out git-annex's log files, and `git annex init`
  // then writes to them (uuid.log records this new clone), so git refuses to switch
  // away. Those files are git-annex's own bookkeeping on its own branch, derived from
  // the branch and never ours to keep, so discard them -- and ONLY for that branch,
  // where the working tree means nothing. Any other unexpected branch keeps the
  // refusal, because there the changes could be somebody's work.
  const force = branch === "git-annex" ? ["--force"] : [];
  const checkout = await runCommand(["git", "checkout", ...force, "main"], { cwd: datasetPath });
  if (checkout.exitCode !== 0) {
    throw new Error(
      `${datasetId} is checked out on "${branch}" and switching to main failed: ${checkout.stderr.trim() || `exit ${checkout.exitCode}`}. Its default branch is not main, and this migration only has meaning on main.`,
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
  const candidates = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^HEAD:/, ""));

  // Matching the string is not the same as having something to change. NEMAR's
  // policy KEEPS `**/.git* annex.largefiles=nothing` -- the rule that stops
  // git-annex swallowing git's own metadata -- so a repository the fleet sweep has
  // already brought into compliance still matches the grep. Reporting those as work
  // outstanding would tell an operator to migrate a dataset that is done.
  const files: string[] = [];
  for (const file of candidates) {
    const show = await runCommand(["git", "show", `HEAD:${file}`], { cwd: datasetPath });
    if (show.exitCode !== 0) continue;
    if (stripLargefilesAttributes(show.stdout).stripped > 0) files.push(file);
  }
  return files;
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
  let upload: UploadStrategy;
  // Paired with `upload`, because only the branch that chose the credentials can
  // check the transfer with the same identity that performed it.
  let verify: RemoteVerifier;
  /** Set when the preflight could not prove reachability, to report rather than swallow. */
  let preflight: string | undefined;

  if (options.upload) {
    // Supplied by the caller: neither credential path applies.
    upload = options.upload;
    verify = annexRemoteVerifier(datasetPath, remoteName);
  } else if (plan.files.length === 0) {
    // Nothing to move. The attribute half of the policy is a text change and a
    // commit, so minting credentials and enabling the remote would be setup for
    // work that does not exist -- and that is the ordinary case for #1374's fleet
    // backfill, where 600 imported datasets need the policy and no data moved. A
    // strategy that throws keeps "the plan found no data" checked rather than
    // assumed: if anything does reach it, the run stops instead of quietly
    // committing a tree naming keys nothing uploaded.
    upload = async ({ files }) => {
      throw new Error(
        `${datasetId}: ${files.length} file(s) reached the upload leg although the plan found no data to move. Refusing to continue: no credentials were obtained for this run.`,
      );
    };
    verify = async () => ({ present: [], absent: [], unconfirmed: [], method: "no keys" });
  } else if (remoteName !== REMOTE_NAME) {
    // A remote the caller named itself -- a `type=directory` remote in a test, or
    // a second S3 remote an operator configured with its own credentials. Neither
    // credential path applies; git-annex uses what it already has for that remote.
    upload = annexCopyUpload({ credentials: "inherit" });
    verify = annexRemoteVerifier(datasetPath, remoteName);
  } else if (options.credentials === "ambient") {
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
    // No credentials passed: the same ambient AWS configuration that did the sync.
    verify = s3HeadVerifier({
      bucket: "nemar",
      region: "us-east-2",
      prefix: `${datasetId}/objects`,
    });
  } else {
    const creds = await requestUploadCredentials(datasetId);
    // Ask S3 what these credentials can do before annexing anything. A refusal here
    // is the whole of #1380's symptom, and finding it now costs one HEAD instead of
    // an hour of annexing followed by a failed copy and a dirty clone.
    const probe = await probeS3PrefixAccess({
      credentials: creds.credentials,
      bucket: creds.s3.bucket,
      region: creds.s3.region,
      prefix: creds.s3.prefix,
    });
    if (probe.outcome === "refused") {
      throw new Error(
        `The credentials the API minted for ${datasetId} cannot read s3://${probe.bucket}/${probe.prefix}/: ${probe.detail}. Refusing to start the migration. Check that the API's S3 identity still covers the bucket and that the session policy names this dataset; \`nemar admin s3 credential-check ${datasetId}\` reports both. \`--via-aws-cli\` moves the same content with this machine's own AWS configuration instead.`,
      );
    }
    if (probe.outcome !== "reachable") {
      preflight = `credential preflight inconclusive (${probe.outcome}${probe.detail ? `: ${probe.detail}` : ""})`;
    }
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
    // The same credentials, handed to the transfer. `enableremote` caches the key
    // and secret in `.git/annex/creds/<uuid>` and has nowhere to put the session
    // token, so a copy that inherits the environment instead signs without one and
    // every request comes back 403 (#1380).
    upload = annexCopyUpload({ credentials: toS3Credentials(creds.credentials) });
    // NOT `git annex fsck --from nemar-s3`, which is what this used to do. The
    // `enableremote` above cached the key and secret in `.git/annex/creds/<uuid>`
    // with nowhere to put the session token (#1380), so every later git-annex
    // request to S3 signs without one and comes back 403 -- indistinguishable from
    // a missing object, which makes both a red fsck and a green one meaningless
    // here. The HEAD carries the token.
    verify = s3HeadVerifier({
      credentials: creds.credentials,
      bucket: creds.s3.bucket,
      region: creds.s3.region,
      prefix: creds.s3.prefix,
    });
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

  // Ask the remote what it actually holds BEFORE pushing. A tree that names keys
  // whose content never reached S3 is exactly what stranded on003490 and on005121
  // (#1392): published, permanent DOI, and no clone able to fetch the content. The
  // clone is still here and re-runnable; a pushed lie is not so easily withdrawn.
  const uploadedKeys = (normalized.data?.files ?? []).map((f) => f.key);
  const verification = uploadedKeys.length > 0 ? await verify(uploadedKeys) : null;
  if (verification && verification.present.length !== uploadedKeys.length) {
    const missing = [...verification.absent, ...verification.unconfirmed];
    throw new Error(
      `${datasetId}: the remote confirms ${verification.present.length} of ${uploadedKeys.length} uploaded key(s) (${verification.absent.length} absent, ${verification.unconfirmed.length} unconfirmed, checked by ${verification.method}). NOTHING HAS BEEN PUSHED, so no clone can see a tree naming content that is not there. First unconfirmed: ${missing[0]}${verification.detail ? ` (${verification.detail})` : ""}. The work is intact at ${datasetPath}; re-run with --dir ${datasetPath} to resume the upload rather than starting over.`,
    );
  }

  // A commit is not the only thing worth pushing: `git annex config --set` writes
  // NEMAR's expression to the git-annex branch, which is a different branch and no
  // commit on `main` at all. A dataset whose `.gitattributes` needed nothing but
  // whose policy was never configured changes exactly that one branch, and leaving
  // it unpushed would mean every clone still has no policy.
  let pushed = false;
  const unpushed = options.push ? await unpushedBranches(datasetPath) : [];
  if (unpushed.length > 0) {
    const push = await pushToGitHub(datasetPath, "origin");
    if (!push.success) {
      throw new Error(
        `Normalized ${datasetId} (${unpushed.join(", ")} ahead of origin), but the push failed: ${push.error}. Any content is already in S3 and the work is local; re-run the push from ${datasetPath} rather than redoing the upload.`,
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
    keys: uploadedKeys,
    committed: normalized.committed,
    pushed,
    notes: preflight ? [preflight, ...normalized.notes] : normalized.notes,
    verification,
  };
}

/**
 * Verify by asking S3 directly, with the credentials that moved the bytes.
 *
 * Omitting `credentials` signs with the machine's own AWS configuration, which is
 * what the `--via-aws-cli` path uploaded with.
 */
function s3HeadVerifier(opts: {
  credentials?: { access_key_id: string; secret_access_key: string; session_token: string };
  bucket: string;
  region: string;
  prefix: string;
}): RemoteVerifier {
  return async (keys) => {
    const seen = await headS3Objects({ ...opts, keys });
    const report: KeyPresenceReport = {
      present: seen.filter((k) => k.outcome === "present").map((k) => k.key),
      absent: seen.filter((k) => k.outcome === "absent").map((k) => k.key),
      unconfirmed: seen.filter((k) => k.outcome === "unknown").map((k) => k.key),
      method: `s3 head-object on ${opts.bucket}/${opts.prefix}`,
    };
    report.detail = seen.find((k) => k.detail)?.detail;
    return report;
  };
}

/**
 * Verify with git-annex itself, for a remote whose credentials git-annex holds in
 * full: a `type=directory` remote in a test, or an S3 remote an operator configured
 * with long-lived keys. It is NOT valid for a remote enabled with temporary
 * credentials -- see the comment at the `nemar-s3` branch above.
 *
 * `fsck` alone is not the check. It verifies the claims the location log already
 * makes and drops the ones that are false, so a strategy that uploaded nothing
 * leaves no claim, gives fsck nothing to examine, and gets a clean exit. The log is
 * what to read, and only AFTER fsck has pruned it.
 */
function annexRemoteVerifier(datasetPath: string, remoteName: string): RemoteVerifier {
  return async (keys) => {
    const method = `fsck --from ${remoteName}, then the location log`;
    const fsck = await runCommand(
      ["git", "annex", "fsck", "--from", remoteName, "--fast", "--quiet", "--all"],
      { cwd: datasetPath },
    );
    // `--include '*'` rather than `--all`, which `find` does not accept; it walks
    // the working tree, which is where every key this run uploaded is named.
    const found = await runCommand(
      ["git", "annex", "find", "--include", "*", "--in", remoteName, "--format=${key}\n"],
      { cwd: datasetPath },
    );
    const recorded = new Set(found.exitCode === 0 ? found.stdout.split("\n").filter(Boolean) : []);
    const present = keys.filter((k) => recorded.has(k));
    const rest = keys.filter((k) => !recorded.has(k));
    // A clean fsck means the remote was reachable and the pruned log is the answer,
    // so a key missing from it is genuinely not there. A failed fsck means the log
    // may never have been pruned, and absence cannot be concluded from it.
    const detail = (fsck.stderr || fsck.stdout).trim().split("\n")[0] || undefined;
    return fsck.exitCode === 0
      ? { present, absent: rest, unconfirmed: [], method, detail }
      : { present, absent: [], unconfirmed: rest, method, detail };
  };
}

/**
 * Branches this clone holds at a different commit than `origin` does, of the two
 * a normalization can move: `main` for the tree, `git-annex` for the policy and
 * the location log.
 *
 * A branch the clone does not have is not unpushed; a branch `origin` does not
 * have is.
 */
async function unpushedBranches(datasetPath: string): Promise<string[]> {
  const unpushed: string[] = [];
  for (const branch of ["main", "git-annex"]) {
    const local = await runCommand(
      ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: datasetPath },
    );
    if (local.exitCode !== 0) continue;
    const remote = await runCommand(
      ["git", "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      { cwd: datasetPath },
    );
    if (remote.exitCode !== 0 || local.stdout.trim() !== remote.stdout.trim()) {
      unpushed.push(branch);
    }
  }
  return unpushed;
}

/**
 * Which credentials move the bytes.
 *
 * `"backend"` asks the API to mint STS credentials scoped to this dataset's
 * `objects/` prefix, the way an ordinary upload does, and is the right default:
 * nothing long-lived is needed on the operator's machine. Those credentials do
 * reach an imported dataset's prefix -- the Worker's identity allows the whole
 * bucket and the session policy is what narrows it -- which is what #1380 got
 * wrong; what actually refused every request was this tool handing git-annex a
 * temporary key without its session token.
 *
 * `"ambient"` uses whatever the `aws` CLI is configured with on this machine, and
 * moves the content with `aws s3 sync` instead of git-annex's S3 client. It stays
 * because it is the faster leg for a large migration and the only one available on
 * a host with no NEMAR credentials; the keys are then registered in the location
 * log directly, which is exactly how the import's finalize phase records a
 * server-side copy it did not perform itself.
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
