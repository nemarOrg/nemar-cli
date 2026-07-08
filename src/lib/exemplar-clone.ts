/**
 * Exemplar dataset cloning (epic #923, Phase 5).
 *
 * Clones a PUBLIC nm/on NEMAR dataset into a staging "exemplar" copy
 * (xx099900-xx099999) so the full publish/DOI/reindex pipeline can be
 * exercised end-to-end on the staging environment without touching a real
 * dataset. Modeled closely on `lib/import-openneuro.ts`'s
 * prepare/copy/finalize split, but simplified: the source is a public
 * NEMAR-owned S3/GitHub repo (not OpenNeuro), and this tool is always a
 * single in-process run (`cloneExemplar`) rather than the sharded
 * multi-job CI shape import-openneuro.ts also supports.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { addCi, createExemplar, reindexDataset } from "./api/admin.js";
import { approvePublication, requestPublication } from "./api/publish.js";
import { cloneDataset, pushToGitHub } from "./git-annex/clone-push.js";
import { configureGitHubRemote } from "./git-annex/github.js";
import { runCommand } from "./git-annex/run-command.js";
import {
  type S3Credentials,
  configureS3Remote,
  markInheritedOpenNeuroRemotesIgnored,
} from "./git-annex/s3-remote.js";
import { batchSetKeysPresent, getRemoteUuid } from "./git-annex/transfer.js";
import { waitForBidsValidationRun } from "./import-openneuro.js";
import {
  type CopyItem,
  batchServerSideCopy,
  filterAlreadyCopied,
  listExistingObjects,
} from "./s3-server-copy.js";

const NEMAR_DATASETS_ORG = "nemarDatasets";
const SOURCE_BUCKET = "nemar";
const DEST_BUCKET = "nemar-dev";
const S3_REGION = "us-east-2";
/** Matches import-openneuro.ts's COPY_CONCURRENCY: server-side copies stay on
 *  AWS's backbone, so the runner is not the byte bottleneck. */
const COPY_CONCURRENCY = 16;

/** Exemplar id band, mirrors backend `EXEMPLAR_ID_RE` (routes/admin/exemplar.ts). */
export const EXEMPLAR_ID_RE = /^xx0999\d{2}$/;
/** Source dataset id an exemplar is cloned from, mirrors backend `SOURCE_ID_RE`. */
export const EXEMPLAR_SOURCE_ID_RE = /^(nm|on)\d{6}$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Scrub a cloned dataset's `dataset_description.json` before it becomes an
 * exemplar: prefix the Name with `[TEST COPY]` so it's never mistaken for the
 * real dataset, and drop `DatasetDOI` (the exemplar mints its own sandbox DOI
 * and must never carry the source's real, resolvable DOI). Pure — the caller
 * is responsible for reading/writing the file.
 */
export function scrubDatasetDescription(desc: Record<string, unknown>): Record<string, unknown> {
  const originalName = typeof desc.Name === "string" ? desc.Name : "";
  const { DatasetDOI: _omit, ...rest } = desc;
  return { ...rest, Name: `[TEST COPY] ${originalName}` };
}

/**
 * Rewrite a full bucket-relative S3 key from the source dataset's prefix to
 * the exemplar's prefix, e.g. `nm000132/objects/9f/3a/SHA256E-s1--ab.edf` ->
 * `xx099900/objects/9f/3a/SHA256E-s1--ab.edf`. Works for any sub-prefix
 * (objects/, zarr/, archives/, version/) since only the leading `<id>/`
 * segment changes. Throws if `srcKey` doesn't actually start with
 * `<sourceId>/` (a caller bug, not a runtime data issue).
 */
export function rewriteObjectKeyPrefix(srcKey: string, sourceId: string, xxId: string): string {
  const prefix = `${sourceId}/`;
  if (!srcKey.startsWith(prefix)) {
    throw new Error(`Key "${srcKey}" does not start with expected source prefix "${prefix}"`);
  }
  return `${xxId}/${srcKey.slice(prefix.length)}`;
}

/** One curated fleet entry (`scripts/exemplar-fleet.json`). */
export interface ExemplarFleetEntry {
  xx_id: string;
  source_id: string;
  modality: string;
  note?: string;
}

/**
 * Validate a parsed `exemplar-fleet.json` payload. Pure so the fleet file's
 * shape can be unit-tested without touching disk.
 */
export function parseExemplarFleet(raw: unknown): ExemplarFleetEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("Exemplar fleet file must be a JSON array");
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Fleet entry ${i} is not an object`);
    }
    const { xx_id, source_id, modality, note } = entry as Record<string, unknown>;
    if (typeof xx_id !== "string" || !EXEMPLAR_ID_RE.test(xx_id)) {
      throw new Error(`Fleet entry ${i}: xx_id "${xx_id}" must match xx099900-xx099999`);
    }
    if (typeof source_id !== "string" || !EXEMPLAR_SOURCE_ID_RE.test(source_id)) {
      throw new Error(
        `Fleet entry ${i} (${xx_id}): source_id "${source_id}" must be an nm/on dataset id`,
      );
    }
    if (typeof modality !== "string" || modality.length === 0) {
      throw new Error(`Fleet entry ${i} (${xx_id}): modality is required`);
    }
    if (note !== undefined && typeof note !== "string") {
      throw new Error(`Fleet entry ${i} (${xx_id}): note must be a string when present`);
    }
    return { xx_id, source_id, modality, ...(note !== undefined ? { note } : {}) };
  });
}

/** Read and validate `scripts/exemplar-fleet.json` (or an equivalent path). */
export function loadExemplarFleet(path: string): ExemplarFleetEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to read/parse exemplar fleet file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseExemplarFleet(raw);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveS3Credentials(): S3Credentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in environment for S3 operations",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

function readDatasetDescription(datasetPath: string): Record<string, unknown> {
  const descPath = join(datasetPath, "dataset_description.json");
  if (!existsSync(descPath)) {
    throw new Error(`dataset_description.json not found at ${descPath}`);
  }
  try {
    return JSON.parse(readFileSync(descPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse dataset_description.json at ${descPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Best-effort: drop local version tags inherited from the source clone so
 *  they can never leak into the exemplar's own release history. */
async function stripGitTags(datasetPath: string): Promise<void> {
  const { stdout, exitCode } = await runCommand(["git", "tag", "-l"], { cwd: datasetPath });
  if (exitCode !== 0) return;
  const tags = stdout.trim().split("\n").filter(Boolean);
  if (tags.length === 0) return;
  const del = await runCommand(["git", "tag", "-d", ...tags], { cwd: datasetPath });
  if (del.exitCode !== 0) {
    console.warn(chalk.yellow(`  Warning: failed to strip local tags: ${del.stderr.trim()}`));
  }
}

/** Build the CopyItem list for one dataset sub-prefix (objects/, zarr/, ...),
 *  listing what's already at the source and rewriting each key to its
 *  exemplar destination. Returns [] when the sub-prefix has no objects. */
async function buildExemplarCopyItems(
  sourceId: string,
  xxId: string,
  subPrefix: string,
): Promise<CopyItem[]> {
  const sourcePrefix = `${sourceId}/${subPrefix}`;
  const existing = await listExistingObjects(SOURCE_BUCKET, sourcePrefix, S3_REGION);
  return [...existing.keys()].map((relKey) => {
    const srcKey = `${sourcePrefix}${relKey}`;
    const destKey = rewriteObjectKeyPrefix(srcKey, sourceId, xxId);
    return {
      key: relKey,
      source: { bucket: SOURCE_BUCKET, key: srcKey, region: S3_REGION },
      httpUrl: null,
      destUri: `s3://${DEST_BUCKET}/${destKey}`,
    };
  });
}

/** Copy one sub-prefix's items (resuming past whatever's already at the
 *  destination) and report progress. Throws on any copy failure (resumable
 *  re-run picks up where it left off, matching import-openneuro.ts's
 *  copyShard convention) — callers decide whether that aborts the whole run
 *  or, for `--all`, just this fleet entry. */
async function copySubPrefix(
  sourceId: string,
  xxId: string,
  subPrefix: string,
  label: string,
): Promise<string[]> {
  const items = await buildExemplarCopyItems(sourceId, xxId, subPrefix);
  if (items.length === 0) {
    console.log(chalk.dim(`  [${label}] nothing to copy`));
    return [];
  }

  const destExisting = await listExistingObjects(DEST_BUCKET, `${xxId}/${subPrefix}`, S3_REGION);
  const { toCopy, skipped } = filterAlreadyCopied(items, destExisting);
  if (toCopy.length === 0) {
    console.log(chalk.green(`  [${label}] nothing to copy (all ${skipped.length} present)`));
    return items.map((i) => i.key);
  }

  const spinner = ora(`[${label}] copying ${toCopy.length} files...`).start();
  const result = await batchServerSideCopy(toCopy, S3_REGION, COPY_CONCURRENCY, (done, total) => {
    spinner.text = `[${label}] ${done}/${total}`;
  });
  if (result.failed.length > 0) {
    spinner.fail(`[${label}] ${result.failed.length} of ${toCopy.length} files failed`);
    for (const f of result.failed.slice(0, 5)) {
      console.error(chalk.red(`    ${f.key}: ${f.error}`));
    }
    console.error(chalk.red(`Re-run to resume [${label}] (already-copied objects are skipped).`));
    throw new Error(
      `[${label}] ${result.failed.length} of ${toCopy.length} files failed to copy: ${result.failed
        .slice(0, 5)
        .map((f) => `${f.key}: ${f.error}`)
        .join("; ")}`,
    );
  }
  spinner.succeed(`[${label}] copied ${result.copied}, skipped ${skipped.length}`);
  return items.map((i) => i.key);
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export interface PrepareExemplarResult {
  datasetPath: string;
  xxId: string;
  sourceId: string;
  /** uuid of the freshly configured `nemar-s3-dev` remote. */
  nemarS3DevUuid: string;
}

export interface CopyExemplarResult {
  /** Relative object keys (under `<xxId>/objects/`) copied or already
   *  present at the destination — these are what get registered with
   *  git-annex in finalize. Derived-artifact keys (zarr/archives/records)
   *  are copied but not registered (they aren't git-annex content). */
  keys: string[];
}

interface ExemplarPrepareOptions {
  workDir?: string;
  name?: string;
  description?: string;
}

/**
 * Phase 1 (prepare): clone the public source dataset, scrub its
 * dataset_description.json, create the exemplar record + repo, disable the
 * inherited production S3 remote, configure a fresh dev-bucket remote, and
 * push. Does NOT copy data — that's the copy phase.
 */
export async function prepareExemplar(
  xxId: string,
  sourceId: string,
  options: ExemplarPrepareOptions = {},
): Promise<PrepareExemplarResult> {
  if (!EXEMPLAR_ID_RE.test(xxId)) {
    throw new Error(`Invalid exemplar id "${xxId}". Expected xx099900-xx099999.`);
  }
  if (!EXEMPLAR_SOURCE_ID_RE.test(sourceId)) {
    throw new Error(`Invalid source id "${sourceId}". Expected an nm/on dataset id.`);
  }

  const workDir = options.workDir || mkdtempSync(join(tmpdir(), `nemar-exemplar-${xxId}-`));
  const datasetPath = join(workDir, xxId);

  console.log(chalk.cyan(`\n[prepare] ${sourceId} -> ${xxId}\n`));
  console.log(chalk.dim(`Working directory: ${workDir}`));

  // Step 1: Clone the public source dataset (anonymous HTTPS, no auth needed).
  const cloneSpinner = ora(`Cloning ${sourceId}...`).start();
  const sourceUrl = `https://github.com/${NEMAR_DATASETS_ORG}/${sourceId}.git`;
  const cloneResult = await cloneDataset(sourceUrl, datasetPath);
  if (!cloneResult.success) {
    const msg = `Failed to clone: ${cloneResult.error}`;
    cloneSpinner.fail(msg);
    throw new Error(msg);
  }
  cloneSpinner.succeed(`Cloned ${sourceId}`);

  // Step 2: Strip inherited version tags (best-effort, non-fatal).
  await stripGitTags(datasetPath);

  // Step 3: Scrub dataset_description.json (Name -> "[TEST COPY] ...",
  // DatasetDOI removed) and commit. `.nemar/metadata.json` is left as-is.
  const scrubSpinner = ora("Scrubbing dataset_description.json...").start();
  const originalDesc = readDatasetDescription(datasetPath);
  const scrubbedDesc = scrubDatasetDescription(originalDesc);
  writeFileSync(
    join(datasetPath, "dataset_description.json"),
    `${JSON.stringify(scrubbedDesc, null, 2)}\n`,
  );
  const addResult = await runCommand(["git", "add", "dataset_description.json"], {
    cwd: datasetPath,
  });
  if (addResult.exitCode !== 0) {
    const msg = `Failed to stage scrubbed metadata: ${addResult.stderr.trim()}`;
    scrubSpinner.fail(msg);
    throw new Error(msg);
  }
  const commitResult = await runCommand(
    [
      "git",
      "commit",
      "-m",
      `Scrub dataset_description.json for exemplar clone (source: ${sourceId})`,
    ],
    { cwd: datasetPath },
  );
  if (commitResult.exitCode !== 0 && !commitResult.stdout.includes("nothing to commit")) {
    const msg = `Failed to commit scrubbed metadata: ${commitResult.stderr.trim()}`;
    scrubSpinner.fail(msg);
    throw new Error(msg);
  }
  scrubSpinner.succeed("Scrubbed dataset_description.json");

  // Step 4: Create the exemplar record + private nemarDatasets/<xx> repo.
  const displayName =
    options.name || (typeof scrubbedDesc.Name === "string" ? scrubbedDesc.Name : undefined);
  const createSpinner = ora("Creating exemplar dataset record...").start();
  try {
    const result = await createExemplar({
      dataset_id: xxId,
      source_id: sourceId,
      name: displayName,
      description: options.description,
    });
    createSpinner.succeed(`Created ${result.dataset_id} (${result.github_repo})`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("already exists") || msg.includes("409")) {
      createSpinner.warn(`Exemplar ${xxId} already exists, continuing...`);
    } else {
      const failMsg = `Failed to create exemplar: ${msg}`;
      createSpinner.fail(failMsg);
      throw new Error(failMsg);
    }
  }

  // Step 5: The clone inherited the source's PRODUCTION nemar-s3 remote
  // (bucket=nemar). Disable it so it's never selected as an upload target —
  // this tool writes exclusively to the dev bucket configured next.
  await markInheritedOpenNeuroRemotesIgnored(
    datasetPath,
    (remote, err) => {
      console.log(
        chalk.yellow(
          `  Warning: could not mark ${remote} as annex-ignore (${err}). ` +
            `Run 'git config remote.${remote}.annex-ignore true' manually.`,
        ),
      );
    },
    ["nemar-s3"],
  );

  // Step 6: Configure a fresh dev-bucket S3 remote scoped to this exemplar.
  const s3Spinner = ora("Configuring nemar-s3-dev remote...").start();
  const s3Creds = resolveS3Credentials();
  const s3Result = await configureS3Remote(
    datasetPath,
    { name: "nemar-s3-dev", bucket: DEST_BUCKET, prefix: `${xxId}/objects`, region: S3_REGION },
    s3Creds,
  );
  if (!s3Result.success) {
    const msg = `Failed to configure nemar-s3-dev: ${s3Result.error}`;
    s3Spinner.fail(msg);
    throw new Error(msg);
  }
  const nemarS3DevUuid = await getRemoteUuid(datasetPath, "nemar-s3-dev");
  if (!nemarS3DevUuid) {
    const msg = "Failed to get nemar-s3-dev remote UUID";
    s3Spinner.fail(msg);
    throw new Error(msg);
  }
  s3Spinner.succeed("Configured nemar-s3-dev remote");

  // Step 7: Reconfigure origin to the new exemplar repo and push.
  const remoteSpinner = ora("Configuring NEMAR remote...").start();
  const removeResult = await runCommand(["git", "remote", "remove", "origin"], {
    cwd: datasetPath,
  });
  if (removeResult.exitCode !== 0 && !removeResult.stderr.includes("No such remote")) {
    const msg = `Failed to remove source remote: ${removeResult.stderr.trim()}`;
    remoteSpinner.fail(msg);
    throw new Error(msg);
  }
  const exemplarRepoUrl = `git@github.com:${NEMAR_DATASETS_ORG}/${xxId}.git`;
  const remoteResult = await configureGitHubRemote(datasetPath, exemplarRepoUrl, "origin");
  if (!remoteResult.success) {
    const msg = `Failed to configure remote: ${remoteResult.error}`;
    remoteSpinner.fail(msg);
    throw new Error(msg);
  }
  remoteSpinner.succeed("Configured NEMAR remote");

  const pushSpinner = ora(`Pushing to ${NEMAR_DATASETS_ORG}...`).start();
  const pushResult = await pushToGitHub(datasetPath, "origin");
  if (!pushResult.success) {
    const msg = `Failed to push: ${pushResult.error}`;
    pushSpinner.fail(msg);
    throw new Error(msg);
  }
  if (pushResult.warning) {
    const msg = `Pushed main but git-annex branch failed: ${pushResult.warning}. Aborting — the exemplar would be uncloneable.`;
    pushSpinner.fail(msg);
    throw new Error(msg);
  }
  pushSpinner.succeed(`Pushed to ${NEMAR_DATASETS_ORG}`);

  console.log(chalk.green(`[prepare] done: ${xxId}`));
  return { datasetPath, xxId, sourceId, nemarS3DevUuid };
}

/**
 * Phase 2 (copy): server-side copy the source's annexed objects (and,
 * optionally, derived artifacts) from the production bucket to the dev
 * bucket, resuming past objects already present at the destination.
 */
export async function copyExemplarData(
  prep: PrepareExemplarResult,
  options: { includeDerived?: boolean } = {},
): Promise<CopyExemplarResult> {
  const { xxId, sourceId } = prep;
  console.log(chalk.cyan(`\n[copy] ${sourceId} -> ${xxId}\n`));

  const keys = await copySubPrefix(sourceId, xxId, "objects/", "objects");

  if (options.includeDerived) {
    // Best-effort: zarr/archives mirror the objects/ layout one-for-one.
    // records.json lives under version/ (`version/v<X>-records.json`); only
    // that file, not the version manifests alongside it, is copied.
    await copySubPrefix(sourceId, xxId, "zarr/", "zarr");
    await copySubPrefix(sourceId, xxId, "archives/", "archives");
    const versionItems = await buildExemplarCopyItems(sourceId, xxId, "version/");
    const recordsItems = versionItems.filter((i) => i.key.endsWith("-records.json"));
    if (recordsItems.length > 0) {
      const spinner = ora(`[records.json] copying ${recordsItems.length} file(s)...`).start();
      const result = await batchServerSideCopy(recordsItems, S3_REGION, COPY_CONCURRENCY);
      if (result.failed.length > 0) {
        spinner.fail(`[records.json] ${result.failed.length} file(s) failed`);
      } else {
        spinner.succeed(`[records.json] copied ${result.copied}`);
      }
    }
  }

  return { keys };
}

interface ExemplarFinalizeOptions {
  publish?: boolean;
}

/**
 * Phase 3 (finalize): verify the copied objects landed, register them with
 * git-annex against nemar-s3-dev, push the git-annex branch, deploy CI,
 * refresh metadata, and (if requested) request + approve publication with a
 * sandbox DOI.
 */
export async function finalizeExemplar(
  prep: PrepareExemplarResult,
  copyResult: CopyExemplarResult,
  options: ExemplarFinalizeOptions = {},
): Promise<void> {
  const { datasetPath, xxId, sourceId, nemarS3DevUuid } = prep;
  console.log(chalk.cyan(`\n[finalize] ${sourceId} -> ${xxId}\n`));

  if (copyResult.keys.length > 0) {
    const verifySpinner = ora("Verifying copied data...").start();
    const existing = await listExistingObjects(DEST_BUCKET, `${xxId}/objects/`, S3_REGION);
    const missing = copyResult.keys.filter((k) => !existing.has(k));
    if (missing.length > 0) {
      const msg = `${missing.length} of ${copyResult.keys.length} objects missing at s3://${DEST_BUCKET}/${xxId}/objects/. Re-run the copy phase before finalizing.`;
      verifySpinner.fail(msg);
      throw new Error(msg);
    }
    verifySpinner.succeed(`Verified ${copyResult.keys.length} objects present`);

    // Defensive uuid-match guard: confirm the local nemar-s3-dev remote still
    // resolves to the uuid prepare recorded before registering keys against
    // it (mirrors import-openneuro.ts's finalize re-clone guard, adapted for
    // the fact this tool never re-clones — datasetPath is shared in-memory).
    const currentUuid = await getRemoteUuid(datasetPath, "nemar-s3-dev");
    if (currentUuid !== nemarS3DevUuid) {
      const msg = `nemar-s3-dev uuid drifted (prepare=${nemarS3DevUuid} now=${currentUuid}). Aborting before registering keys against the wrong remote.`;
      console.error(chalk.red(msg));
      throw new Error(msg);
    }

    const registerSpinner = ora("Registering files in git-annex...").start();
    const regResult = await batchSetKeysPresent(datasetPath, copyResult.keys, nemarS3DevUuid);
    if (regResult.failed > 0) {
      const msg = `${regResult.failed} of ${copyResult.keys.length} git-annex key registrations failed. Re-run finalize to retry.`;
      registerSpinner.fail(msg);
      throw new Error(msg);
    }
    registerSpinner.succeed(`Registered ${regResult.success} files in git-annex`);

    const pushSpinner = ora("Pushing git-annex branch...").start();
    const pushResult = await pushToGitHub(datasetPath, "origin");
    if (!pushResult.success) {
      const msg = `Failed to push git-annex branch: ${pushResult.error}`;
      pushSpinner.fail(msg);
      throw new Error(msg);
    }
    if (pushResult.warning) {
      const msg = `git-annex branch push failed: ${pushResult.warning}`;
      pushSpinner.fail(msg);
      throw new Error(msg);
    }
    pushSpinner.succeed("Pushed git-annex branch");
  }

  let ciDeployed = false;
  const ciSpinner = ora("Deploying CI workflows...").start();
  try {
    await addCi(xxId);
    ciSpinner.succeed(
      "CI workflows deployed (BIDS validation, LLM enrichment, archive generation)",
    );
    ciDeployed = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ciSpinner.fail(`CI deployment failed: ${msg}`);
    console.log(chalk.dim(`  After fixing the deploy failure, run 'nemar admin ci add ${xxId}'.`));
  }

  if (ciDeployed) {
    const waitSpinner = ora("Waiting for BIDS validation run to register...").start();
    const poll = await waitForBidsValidationRun(xxId, waitSpinner);
    if (poll.kind === "found") {
      waitSpinner.succeed("BIDS validation run registered");
    } else if (poll.kind === "timeout") {
      waitSpinner.warn(
        "BIDS validation run did not register within 120s; continuing (ci_check retries at approval).",
      );
    } else {
      const msg = poll.lastError instanceof Error ? poll.lastError.message : String(poll.lastError);
      waitSpinner.fail(`BIDS validation polls failed: ${msg}`);
    }
  }

  // reindexOk gates publication below: a failed/partial reindex means
  // .nemar/metadata.json may still carry the SOURCE dataset's real identity
  // (title, pipeline_stage) rather than the scrubbed exemplar one, since
  // reindex is what regenerates that file post-clone. Publishing on top of
  // that would expose a public "exemplar" describing the real dataset.
  let reindexOk = false;
  const reindexSpinner = ora("Refreshing metadata + LLM enrichment...").start();
  try {
    const result = await reindexDataset(xxId);
    const enrichmentOk = result.enrichment?.status === "ok";
    const colsOk = result.sync?.metadata_columns_written === true;
    reindexOk = enrichmentOk && colsOk;
    if (reindexOk) {
      reindexSpinner.succeed("Refreshed enrichment + metadata columns");
    } else {
      reindexSpinner.warn(`Partial reindex (run 'nemar admin reindex ${xxId}' to retry)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reindexSpinner.warn(`Reindex failed (non-fatal): ${msg}`);
  }

  if (!options.publish) {
    console.log(
      chalk.green(
        `\nExemplar clone complete: ${sourceId} -> ${xxId} (not published; re-run with --publish).`,
      ),
    );
    return;
  }

  if (!reindexOk) {
    throw new Error(
      `Refusing to publish ${xxId}: metadata reindex did not fully succeed, so .nemar/metadata.json may still carry the source dataset's real identity. Re-run 'nemar admin reindex ${xxId}' until it succeeds, then 'nemar admin publish request/approve ${xxId}' to publish manually.`,
    );
  }

  // Request + approve publication with a sandbox DOI. Mirrors
  // import-openneuro.ts's finalizeImport tail: BIDS validation may still be
  // running right after CI deploy, so retry the request on that specific
  // 422, and retry approve across fresh Worker invocations on transient
  // failures (approvePublication also retries internally; this outer loop
  // covers cases that outlast its budget).
  const REQUEST_MAX_ATTEMPTS = 5;
  const REQUEST_WAIT_MS = 5 * 60_000;
  const pubSpinner = ora("Requesting publication...").start();
  let requested = false;
  for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt++) {
    try {
      await requestPublication(xxId);
      requested = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("BIDS validation is currently running")) {
        const failMsg = `Failed to request publication: ${msg}`;
        pubSpinner.fail(failMsg);
        throw new Error(failMsg);
      }
      if (attempt === REQUEST_MAX_ATTEMPTS) {
        const failMsg = `BIDS validation still running after ${REQUEST_MAX_ATTEMPTS} attempts. Re-run 'nemar admin publish request/approve ${xxId}' once validation completes.`;
        pubSpinner.fail(failMsg);
        throw new Error(failMsg);
      }
      pubSpinner.text = `Waiting for BIDS validation to complete... (attempt ${attempt}/${REQUEST_MAX_ATTEMPTS})`;
      await new Promise((r) => setTimeout(r, REQUEST_WAIT_MS));
    }
  }
  if (requested) pubSpinner.succeed("Publication requested");

  const approveSpinner = ora("Approving publication (sandbox DOI)...").start();
  const APPROVE_MAX_ATTEMPTS = 10;
  let approved = false;
  for (let attempt = 1; attempt <= APPROVE_MAX_ATTEMPTS; attempt++) {
    try {
      await approvePublication(xxId, attempt > 1, /* sandbox */ true);
      approved = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < APPROVE_MAX_ATTEMPTS) {
        approveSpinner.text = `Approving publication... (attempt ${attempt + 1}/${APPROVE_MAX_ATTEMPTS})`;
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        const failMsg = `Failed to approve publication after ${APPROVE_MAX_ATTEMPTS} attempts: ${msg}`;
        approveSpinner.fail(failMsg);
        throw new Error(failMsg);
      }
    }
  }
  if (approved) approveSpinner.succeed("Publication approved (sandbox DOI)");

  console.log(chalk.green(`\nExemplar clone + publish complete: ${sourceId} -> ${xxId}`));
  console.log(chalk.dim(`  GitHub: https://github.com/${NEMAR_DATASETS_ORG}/${xxId}`));
}

/**
 * Single-process driver: prepare -> copy -> finalize, state passed in
 * memory (no S3 staging round-trip — this tool never runs sharded).
 */
export async function cloneExemplar(opts: {
  xxId: string;
  sourceId: string;
  publish?: boolean;
  includeDerived?: boolean;
  workDir?: string;
  name?: string;
  description?: string;
}): Promise<void> {
  const prep = await prepareExemplar(opts.xxId, opts.sourceId, {
    workDir: opts.workDir,
    name: opts.name,
    description: opts.description,
  });
  const copyResult = await copyExemplarData(prep, { includeDerived: opts.includeDerived });
  await finalizeExemplar(prep, copyResult, { publish: opts.publish });
}
