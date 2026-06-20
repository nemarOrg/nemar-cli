/**
 * OpenNeuro dataset import
 *
 * Clones an OpenNeuro dataset, copies data directly from OpenNeuro S3 to
 * NEMAR S3 (server-side, no local download), and creates the corresponding
 * nemarDatasets repo with 'on' prefix ID.
 */

import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import {
  addCi,
  approvePublication,
  getUserCiStatus,
  importDataset,
  reindexDataset,
  requestPublication,
} from "./api.js";
import {
  type S3Credentials,
  batchSetKeysPresent,
  cloneDataset,
  configureGitHubRemote,
  configureS3Remote,
  ensureLocalMainBranch,
  getAnnexWhereisAll,
  getRemoteUuid,
  markInheritedOpenNeuroRemotesIgnored,
  pushToGitHub,
  runCommand,
} from "./git-annex.js";
import {
  type CopyItem,
  type ImportManifest,
  type ImportManifestItem,
  batchServerSideCopy,
  cleanupStaging,
  filterAlreadyCopied,
  keyInShard,
  listExistingObjects,
  parseS3Url,
  readManifestFromS3,
  writeManifestToS3,
} from "./s3-server-copy.js";

const OPENNEURO_ORG = "OpenNeuroDatasets";
const S3_BUCKET = "nemar";
const S3_REGION = "us-east-2";
/** Default parallel server-side copies per shard. Higher than the old 8 because
 *  the runner is no longer the byte bottleneck (copies stay on AWS's backbone). */
const COPY_CONCURRENCY = 16;

interface ImportOptions {
  workDir?: string;
  skipData?: boolean;
  /**
   * If the bounded workflow-run poll times out without seeing a registered
   * BIDS validation run, fall back to skip_ci_check=true at publication time.
   * Off by default: missing validation should fail the import. The OpenNeuro
   * onboarding workflow opts in because OpenNeuro pre-validates BIDS upstream
   * (see nemarOrg/nemar-cli#431).
   */
  trustUpstream?: boolean;
  /**
   * Persist the import manifest (and read it back) via S3 staging, so the
   * prepare/copy/finalize phases can run as separate GitHub Actions jobs that
   * don't share a filesystem. The single-process driver leaves this off and
   * passes the manifest in memory.
   */
  persistStaging?: boolean;
}

/**
 * Outcome of `waitForBidsValidationRun`. Distinguishes three states an
 * operator (and the `--trust-upstream` fallback) must reason about:
 *   - found: a workflow_run registered before the deadline. ci_check at
 *     approval time will evaluate it normally; skipCiCheck must be false.
 *   - timeout: every poll succeeded but no run ever registered. This is
 *     the case `--trust-upstream` is designed to bypass — the deployed
 *     workflow files never produced a run within the budget, likely a
 *     webhook-delivery edge case on a freshly populated repo.
 *   - error: every poll attempt threw (auth, 5xx, network). We never
 *     actually checked validation state, so `--trust-upstream` must NOT
 *     silently approve under this condition — that would reintroduce the
 *     trust-assumption pathology #431 is meant to remove.
 */
type PollOutcome = { kind: "found" } | { kind: "timeout" } | { kind: "error"; lastError: unknown };

/**
 * Bounded wait for a BIDS validation workflow run to register on the freshly
 * deployed CI. Polls `getUserCiStatus` and reports the wait visibly via the
 * supplied spinner so operators understand the pause.
 *
 * Replaces the previous unconditional `skip_ci_check=true` trust assumption
 * (see nemarOrg/nemar-cli#431). Reviewer note: a bare `catch {}` here would
 * mask persistent 4xx/5xx and either mislead the operator on timeout or
 * silently approve a never-validated publication under `--trust-upstream`.
 */
async function waitForBidsValidationRun(
  nemarId: string,
  spinner: ReturnType<typeof ora>,
  maxWaitMs = 120_000,
  pollIntervalMs = 5_000,
): Promise<PollOutcome> {
  const deadline = Date.now() + maxWaitMs;
  let lastError: unknown;
  let sawCleanResponse = false;
  while (Date.now() < deadline) {
    try {
      const status = await getUserCiStatus(nemarId);
      sawCleanResponse = true;
      if (status.bids_validation.present && status.bids_validation.status !== "no_runs") {
        return { kind: "found" };
      }
    } catch (err) {
      lastError = err;
    }
    const remaining = Math.max(0, deadline - Date.now());
    spinner.text = `Waiting for BIDS validation run to register... (${Math.ceil(remaining / 1000)}s left)`;
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
  }
  if (!sawCleanResponse && lastError !== undefined) {
    return { kind: "error", lastError };
  }
  return { kind: "timeout" };
}

/**
 * Pure decision over the (CI deployed, poll outcome, --trust-upstream)
 * matrix. Centralised so it is unit-testable and so the rules stay legible
 * after this function has been re-read in the next post-mortem.
 *
 * Hard rule: if `addCi()` failed we never proceed to publication, regardless
 * of `--trust-upstream`. The flag bypasses validation lookup, not the
 * presence of validation, enrichment, and archive workflows themselves
 * (reviewer note for nemarOrg/nemar-cli#451).
 *
 * Hard rule: if every poll attempt threw we treat the bounded wait as a hard
 * error even under `--trust-upstream` — we never actually observed validation
 * state, which is the same trust hole #431 was meant to close.
 */
export function decideSkipCiCheck(args: {
  ciDeployed: boolean;
  poll: PollOutcome | null;
  trustUpstream: boolean;
}): { skipCiCheck: boolean; abortReason?: string } {
  if (!args.ciDeployed) {
    return {
      skipCiCheck: false,
      abortReason:
        "CI workflows did not deploy. Aborting before approval: --trust-upstream bypasses validation lookup, not workflow deployment. Re-run after fixing the deploy failure, or run `nemar admin ci add <id>` manually before approving.",
    };
  }
  const poll = args.poll;
  if (poll === null || poll.kind === "found") {
    return { skipCiCheck: false };
  }
  if (poll.kind === "error") {
    const msg = poll.lastError instanceof Error ? poll.lastError.message : String(poll.lastError);
    return {
      skipCiCheck: false,
      abortReason: `Every BIDS validation poll attempt failed (last error: ${msg}). Refusing to bypass under --trust-upstream because validation state was never actually observed. Investigate API/auth health and re-run.`,
    };
  }
  if (args.trustUpstream) {
    return { skipCiCheck: true };
  }
  return {
    skipCiCheck: false,
    abortReason:
      "BIDS validation run did not register within the bounded poll window. Re-run with --trust-upstream to bypass (OpenNeuro datasets are pre-validated upstream), or investigate why the deployed CI did not trigger.",
  };
}

/**
 * Map OpenNeuro dataset ID (ds######) to NEMAR ID (on######).
 */
function mapDatasetId(openneuroId: string): string {
  const match = openneuroId.match(/^ds(\d{6})$/);
  if (!match) {
    throw new Error(
      `Invalid OpenNeuro ID "${openneuroId}". Expected format: ds###### (e.g., ds007262)`,
    );
  }
  return `on${match[1]}`;
}

/**
 * True for dataset-level metadata files that NEMAR policy keeps in git and
 * never annexes. Mirrors the `annex.largefiles` exclusion in the validated
 * upload workflow (`*.tsv|*.json|*.md|*.txt|*.yml|*.yaml`, `README*`,
 * `LICENSE*`, `CHANGES*`, `.bidsignore`, `.gitignore`). Case-insensitive on the
 * name prefixes to match `ensureReadmeMd`'s tolerance.
 */
export function isNeverAnnexedMetadata(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.startsWith("readme") || lower.startsWith("license") || lower.startsWith("changes")) {
    return true;
  }
  if (lower === ".bidsignore" || lower === ".gitignore") return true;
  return /\.(tsv|json|md|txt|yml|yaml)$/.test(lower);
}

/**
 * Find dataset-ROOT metadata files that are git-annex symlinks.
 *
 * Most OpenNeuro datasets keep small metadata in git, but some annex even
 * `dataset_description.json` / `README` / `CHANGES` (e.g. ds007964). A plain
 * clone leaves those as dangling annex symlinks, so reading them fails and the
 * committed tree would carry annex pointers instead of JSON. We scan only the
 * root (bounded fetch; per-subject sidecars stay annexed like data) for
 * symlinks that point into `.git/annex/objects` and match the never-annex
 * policy. Returns the sorted file names. Filesystem errors degrade to [].
 */
export function findAnnexedRootMetadata(datasetPath: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(datasetPath, { withFileTypes: true });
  } catch (err) {
    // A missing dir is a precondition the caller surfaces with a clearer error
    // (readBidsDescription); any other fs failure (e.g. EACCES) should not be
    // silently turned into "no annexed metadata", so re-throw it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw new Error(
      `Cannot scan ${datasetPath} for annexed metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const found: string[] = [];
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    if (!isNeverAnnexedMetadata(e.name)) continue;
    try {
      const target = readlinkSync(join(datasetPath, e.name));
      if (target.includes("annex/objects")) found.push(e.name);
    } catch {
      // Unreadable symlink — skip; a genuinely missing required file surfaces
      // later in readBidsDescription with a precise error.
    }
  }
  return found.sort();
}

/**
 * Distinct, greppable marker for "this import failed because OpenNeuro's own data
 * is unreachable" (objects not anonymously public + no signed login) vs a NEMAR
 * bug. Surfaces in the prepare error + workflow log so these datasets are
 * understood and can be collected into a tracking list. (#808)
 */
export const OPENNEURO_UPSTREAM_MARKER = "[openneuro-upstream-inaccessible]";

/**
 * Public CURRENT-version URL for a root file in an OpenNeuro dataset's S3 mirror.
 * git-annex records a VERSIONED url that anonymous reads can't fetch; the current
 * object by path is what OpenNeuro serves publicly. Exported for tests.
 */
export function openNeuroCurrentUrl(openneuroId: string, relPath: string): string {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `https://s3.amazonaws.com/openneuro.org/${openneuroId}/${encoded}`;
}

/**
 * Fetch the content of any annexed root metadata files from the public
 * OpenNeuro remote and convert them to regular git blobs, so prepare can read
 * `dataset_description.json` and downstream tree-readers (website, enrichment,
 * DataCite) get real JSON rather than an annex pointer. No-op for the common
 * case where the metadata is already committed in git. See #768.
 *
 * Mechanism (#808): fetch each file's CURRENT content by path from OpenNeuro's
 * public S3 mirror and replace the annex symlink with a real blob. We do NOT use
 * `git annex get`: git-annex resolves the key to OpenNeuro's recorded VERSIONED
 * url (`?versionId=...`), which an anonymous reader cannot fetch (it needs
 * `s3:GetObjectVersion`) even when the current object is public -- and NEMAR has
 * no signed OpenNeuro login (the s3-PUBLIC remote is `public=no`, so any signed
 * request uses NEMAR's identity, which OpenNeuro rejects). The current object by
 * path is the canonical metadata OpenNeuro serves; re-blobbing it directly also
 * sidesteps OpenNeuro annex key/content drift (no SHA verification needed).
 * Returns the un-annexed file names. No-op when nothing is annexed.
 *
 * If a file's current object is itself not anonymously readable (e.g. ds007541
 * -> 403), there is no way to fetch it without a signed login, so we throw a
 * distinctly-marked OPENNEURO_UPSTREAM_MARKER error: an OpenNeuro-side problem,
 * not a NEMAR bug, and greppable so these datasets can be listed later.
 */
export async function ensureRootMetadataUnannexed(
  datasetPath: string,
  openneuroId: string,
): Promise<string[]> {
  const annexed = findAnnexedRootMetadata(datasetPath);
  if (annexed.length === 0) return [];

  const unreachable: string[] = [];
  for (const file of annexed) {
    const url = openNeuroCurrentUrl(openneuroId, file);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        unreachable.push(`${file} (HTTP ${res.status})`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const dest = join(datasetPath, file);
      rmSync(dest, { force: true }); // drop the annex symlink before writing the blob
      writeFileSync(dest, bytes);
    } catch (err) {
      unreachable.push(`${file} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (unreachable.length > 0) {
    throw new Error(
      `${OPENNEURO_UPSTREAM_MARKER} cannot fetch metadata from OpenNeuro: ${unreachable.join(", ")}. These objects are not anonymously readable and NEMAR has no signed OpenNeuro login. This is an OpenNeuro-side access problem, not a NEMAR import bug.`,
    );
  }

  // The files were annex symlinks; replacing the worktree file + adding with
  // annex.largefiles=nothing converts them to regular git blobs in the index
  // (the repo's largefiles rules can't re-annex them).
  const add = await runCommand(["git", "-c", "annex.largefiles=nothing", "add", ...annexed], {
    cwd: datasetPath,
  });
  if (add.exitCode !== 0) {
    // The files are already regular files on disk; they are just not staged.
    // Give the exact recovery command so a transient failure (e.g. an
    // index.lock) is fixable without re-cloning.
    throw new Error(
      `Failed to stage un-annexed metadata (${annexed.join(", ")}): ${add.stderr.trim()}. The files are already regular files on disk; recover with: git -C ${datasetPath} -c annex.largefiles=nothing add ${annexed.join(" ")}`,
    );
  }
  return annexed;
}

/**
 * Read dataset_description.json from a cloned dataset directory.
 */
function readBidsDescription(datasetPath: string): Record<string, unknown> {
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

/**
 * Resolve S3 credentials from environment variables.
 * In CI, these come from GitHub secrets. Locally, from env.
 */
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

/**
 * Extract the OpenNeuro DOI from dataset_description.json, stripping the "doi:" prefix.
 */
function extractOpenNeuroDoi(bidsDesc: Record<string, unknown>): string | null {
  return typeof bidsDesc.DatasetDOI === "string" ? bidsDesc.DatasetDOI.replace(/^doi:/, "") : null;
}

/**
 * Recording-modality detection from a BIDS dataset tree on disk.
 *
 * Scans the cloned dataset for sub-* directories and inspects each
 * subject/session for BIDS datatype directories (eeg, meg, ieeg, emg, func,
 * anat, dwi, fmap, perf, beh, micr, motion, nirs, pet). Returns the sorted,
 * deduplicated set of datatypes found.
 *
 * Mirrors the server-side `detectModalitiesFromTree` (backend datacite.ts)
 * but works from the filesystem rather than a GitHub tree response. Keeping
 * the two in sync is intentional: the backend D1 columns and the CLI-seeded
 * `.nemar/metadata.json` should agree on modality without one needing to
 * import the other.
 */
const BIDS_DATATYPES = [
  "anat",
  "beh",
  "dwi",
  "eeg",
  "emg",
  "fmap",
  "func",
  "ieeg",
  "meg",
  "micr",
  "motion",
  "nirs",
  "perf",
  "pet",
];

export function detectModalitiesFromDataset(datasetPath: string): string[] {
  // Filesystem-failure paths return [] so an unreadable dataset doesn't abort
  // the entire orchestrator inside seedMetadata. The downstream backend
  // detectModalitiesFromTree pass re-derives this from the GitHub tree.
  const found = new Set<string>();
  let subjects: string[] = [];
  try {
    subjects = readdirSync(datasetPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("sub-"))
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const sub of subjects) {
    const subPath = join(datasetPath, sub);
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(subPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith("ses-")) {
        // ses-*/datatype/
        let sesEntries: Dirent[] = [];
        try {
          sesEntries = readdirSync(join(subPath, e.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const se of sesEntries) {
          if (se.isDirectory() && BIDS_DATATYPES.includes(se.name)) found.add(se.name);
        }
      } else if (BIDS_DATATYPES.includes(e.name)) {
        // sub-*/datatype/ (no session level)
        found.add(e.name);
      }
    }
  }
  return [...found].sort();
}

/**
 * Coerce a BIDS dataset_description.json `Funding` array into the v2 metadata
 * `funding_references` shape. BIDS spec stores Funding as a list of free-text
 * strings; we map each entry to a sparse FundingReferenceEntry with the text
 * in funder_name. LLM enrichment (Stage 2a) can refine these later with NIH
 * grant numbers, ROR IDs, etc.
 */
export function coerceFunding(bidsDesc: Record<string, unknown>): Array<{ funder_name: string }> {
  const raw = bidsDesc.Funding;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((funder_name) => ({ funder_name: funder_name.trim() }));
}

/**
 * Seed .nemar/metadata.json with source information and IsIdenticalTo relation.
 *
 * Phase 2 of #512 expands the seeded fields beyond name/license/authors to
 * cover bids_version, funding, recording_modality, and datatypes so that
 * `data.nemar.org/<id>/metadata.json` returns useful values on freshly
 * imported OpenNeuro datasets before any LLM enrichment runs. Subject count,
 * tasks, ages, file size, and total_files come from the backend D1 metadata-
 * columns block (`computeDatasetMetadataColumns`) which is triggered by the
 * post-import reindex call at the end of importOpenNeuro().
 */
export function seedMetadata(
  datasetPath: string,
  nemarId: string,
  openneuroId: string,
  bidsDesc: Record<string, unknown>,
  openNeuroDoi: string | null,
): void {
  const nemarDir = join(datasetPath, ".nemar");
  if (!existsSync(nemarDir)) {
    mkdirSync(nemarDir, { recursive: true });
  }

  const relatedIdentifiers = openNeuroDoi
    ? [
        {
          identifier: openNeuroDoi,
          identifier_type: "DOI",
          relation_type: "IsIdenticalTo",
        },
      ]
    : [];

  const modalities = detectModalitiesFromDataset(datasetPath);
  const funding = coerceFunding(bidsDesc);

  const metadata: Record<string, unknown> = {
    version: "2.0",
    dataset_id: nemarId,
    source: "openneuro",
    source_id: openneuroId,
    title: (bidsDesc.Name as string) || nemarId,
    authors: Array.isArray(bidsDesc.Authors)
      ? Object.fromEntries((bidsDesc.Authors as string[]).map((a) => [a, {}]))
      : {},
    license: (bidsDesc.License as string) || "CC0",
    dataset_type: (bidsDesc.DatasetType as string) || "raw",
    related_identifiers: relatedIdentifiers,
    pipeline_stage: "seeded",
  };

  // Optional fields only emitted when there's actual content. Suppressing
  // empty arrays/strings keeps the seeded JSON small and makes "this field
  // came from LLM enrichment, not from seeding" diff-friendly.
  if (typeof bidsDesc.BIDSVersion === "string") metadata.bids_version = bidsDesc.BIDSVersion;
  if (modalities.length > 0) metadata.recording_modality = modalities;
  if (modalities.length > 0) metadata.datatypes = modalities;
  if (funding.length > 0) metadata.funding_references = funding;
  if (
    typeof bidsDesc.Acknowledgements === "string" &&
    bidsDesc.Acknowledgements.trim().length > 0
  ) {
    metadata.acknowledgements = bidsDesc.Acknowledgements.trim();
  }

  writeFileSync(join(nemarDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

/**
 * Outcome of {@link ensureReadmeMd} so the caller can stage the right paths.
 *
 * - `renamed`: an upstream `README` (no extension) was renamed to `README.md`
 *   so GitHub renders it. The on-disk move has been done with `renameSync`;
 *   the caller must follow up with `git add README.md README` (or
 *   equivalent) so the index records both the deletion of the old path and
 *   the addition of the new one.
 * - `kept`: an upstream README already had a recognised renderable extension
 *   (`.md`, `.rst`, `.txt`, ...). We do not touch the file or its content.
 * - `created`: no README of any shape existed upstream, so a provenance-only
 *   stub was written to `README.md` as a last-resort fallback. The caller
 *   should `git add README.md`.
 */
export type ReadmeOutcome =
  | { kind: "renamed"; from: "README"; to: "README.md" }
  | { kind: "kept"; path: string }
  | { kind: "created"; path: "README.md" };

/** Detect any README file regardless of case (`README`, `Readme.md`, `readme`).
 *  Case-insensitive on purpose: on case-insensitive filesystems (macOS APFS,
 *  Windows NTFS) `writeFileSync('README.md', ...)` would silently overwrite
 *  an upstream `Readme.md` if we missed it during the scan. The `/i` keeps
 *  the fallback branch from ever clobbering real content. */
const README_FILENAME_REGEX = /^README(\.[A-Za-z0-9]+)?$/i;

/**
 * Decide what to do with the imported repo's README file.
 *
 * Rule (from nemarOrg/nemar-cli#642):
 * - If the upstream ships `README` with no extension, rename it to
 *   `README.md` so GitHub renders it. Do NOT modify the content.
 *   Skipped (treated as `kept`) if a `README.md` already exists alongside
 *   — we never clobber an upstream-authored `.md`.
 * - If the upstream ships `README.md`, `README.rst`, `README.txt`, or any
 *   other suffixed variant, leave it alone. We don't second-guess the
 *   upstream author's choice; provenance is also captured in
 *   `.nemar/metadata.json` via `IsDescribedBy` / `IsIdenticalTo`, and the
 *   browser surfaces it from there.
 * - If no README exists at all, write a small provenance-only stub so the
 *   dataset page still has something to render. OpenNeuro datasets
 *   normally ship a README of some form, so this fallback should be rare.
 *
 * When the upstream contains multiple README variants (e.g., both `README`
 * and `README.md`) we prefer the already-suffixed file: leaving it untouched
 * is always safe; renaming the bare `README` over it could destroy
 * authored content.
 *
 * Pure on filesystem state — no git operations, no network. The caller is
 * responsible for staging the returned paths.
 */
export function ensureReadmeMd(
  datasetPath: string,
  openneuroId: string,
  openNeuroDoi: string | null,
): ReadmeOutcome {
  const entries = readdirSync(datasetPath, { withFileTypes: true });
  const readmeEntries = entries.filter((e) => e.isFile() && README_FILENAME_REGEX.test(e.name));

  // Prefer any README with an extension over bare `README`. Two reasons:
  // (1) a `*.md` / `*.rst` is already renderable and renaming over it would
  //     destroy content; (2) `entries.filter` returns OS-listing order which
  //     is non-deterministic on some filesystems — picking a stable
  //     preference rule removes the order dependence.
  const suffixed = readmeEntries.find((e) => e.name.includes("."));
  if (suffixed) {
    return { kind: "kept", path: suffixed.name };
  }

  const bare = readmeEntries.find((e) => !e.name.includes("."));
  if (bare) {
    // Bare README (any case) — rename to canonical `README.md` so GitHub
    // renders it. The collision case was handled by the `suffixed` branch
    // above; if we get here, no `.md`/`.rst`/etc. exists, so rename is safe.
    renameSync(join(datasetPath, bare.name), join(datasetPath, "README.md"));
    return { kind: "renamed", from: "README", to: "README.md" };
  }

  // No README upstream — write a deterministic provenance-only stub. Provenance
  // is independently encoded in `.nemar/metadata.json` (IsDescribedBy /
  // IsIdenticalTo + source/source_id columns), so the browser can render
  // upstream attribution even without this file. The stub exists so a casual
  // visitor browsing the GitHub repo still sees where the data came from.
  const marker = "<!-- nemar:provenance -->";
  const openneuroUrl = `https://openneuro.org/datasets/${openneuroId}`;
  const doiLine = openNeuroDoi ? `\n- DOI: [${openNeuroDoi}](https://doi.org/${openNeuroDoi})` : "";
  const block = `${marker}\n## Provenance\n\nThis dataset is mirrored on NEMAR from OpenNeuro.\n\n- Source: [${openneuroId}](${openneuroUrl})${doiLine}\n`;
  writeFileSync(join(datasetPath, "README.md"), block);
  return { kind: "created", path: "README.md" };
}

/**
 * Build manifest items from the git-annex whereis map. Each annexed file maps
 * to its OpenNeuro S3 source (parsed for server-side copy) plus the raw http
 * URL (kept for the curl fallback) and the flat NEMAR destination URI. Keys
 * with no usable source at all are skipped (returned count).
 */
function buildManifestItems(
  keyUrlMap: Map<string, string>,
  nemarId: string,
): { items: ImportManifestItem[]; skipped: number } {
  const items: ImportManifestItem[] = [];
  let skipped = 0;
  for (const [key, url] of keyUrlMap) {
    const source = parseS3Url(url);
    const httpUrl = url.startsWith("http") ? url : null;
    if (!source && !httpUrl) {
      skipped++;
      continue;
    }
    items.push({
      key,
      sourceUrl: httpUrl,
      source,
      destUri: `s3://${S3_BUCKET}/${nemarId}/objects/${key}`,
    });
  }
  return { items, skipped };
}

/**
 * Phase 1 (prepare): clone OpenNeuro, create the NEMAR record + repo, build the
 * key->source manifest, configure remotes (recording the nemar-s3 uuid in the
 * git-annex branch), seed metadata, and push `main`. Does NOT copy data or
 * publish — those are the copy/finalize phases. Returns the manifest (also
 * written to S3 staging when `persistStaging`, so a separate copy/finalize job
 * can read it). CI deploy is deferred to finalize (#450: Contents API needs the
 * branch to exist).
 */
export async function prepareImport(
  openneuroId: string,
  options: ImportOptions = {},
): Promise<ImportManifest> {
  const nemarId = mapDatasetId(openneuroId);
  const workDir = options.workDir || mkdtempSync(join(tmpdir(), `nemar-import-${nemarId}-`));
  const datasetPath = join(workDir, nemarId);

  console.log(chalk.cyan(`\n[prepare] ${openneuroId} -> ${nemarId}\n`));
  console.log(chalk.dim(`Working directory: ${workDir}`));

  // Step 1: Clone OpenNeuro dataset
  const cloneSpinner = ora("Cloning OpenNeuro dataset...").start();
  const openneuroUrl = `https://github.com/${OPENNEURO_ORG}/${openneuroId}.git`;
  const cloneResult = await cloneDataset(openneuroUrl, datasetPath);
  if (!cloneResult.success) {
    cloneSpinner.fail(`Failed to clone: ${cloneResult.error}`);
    process.exit(1);
  }
  cloneSpinner.succeed(`Cloned ${openneuroId}`);

  // Ensure local branch is "main" (OpenNeuro repos may use "master" or other names)
  const branchOk = await ensureLocalMainBranch(datasetPath, { yes: true });
  if (!branchOk) {
    console.error(chalk.red("Cannot proceed with import: branch must be named 'main'."));
    process.exit(1);
  }

  // Some OpenNeuro datasets annex their dataset-level metadata
  // (dataset_description.json, README, CHANGES; e.g. ds007964). A plain clone
  // leaves those as dangling annex symlinks, so the read below would fail and
  // the committed tree would carry pointers instead of JSON. Fetch + un-annex
  // the root metadata first so it lands as regular git blobs. No-op for the
  // common case. See #768.
  const metaFixSpinner = ora("Normalizing dataset metadata...").start();
  try {
    const unannexed = await ensureRootMetadataUnannexed(datasetPath, openneuroId);
    if (unannexed.length > 0) {
      metaFixSpinner.succeed(
        `Un-annexed ${unannexed.length} metadata file(s): ${unannexed.join(", ")}`,
      );
    } else {
      metaFixSpinner.stop();
    }
  } catch (err) {
    metaFixSpinner.fail(
      `Failed to normalize annexed metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Read BIDS metadata and extract OpenNeuro DOI once for reuse
  const bidsDesc = readBidsDescription(datasetPath);
  const datasetName = (bidsDesc.Name as string) || openneuroId;
  const openNeuroDoi = extractOpenNeuroDoi(bidsDesc);
  console.log(chalk.dim(`  Dataset: ${datasetName}`));
  if (openNeuroDoi) {
    console.log(chalk.dim(`  OpenNeuro DOI: ${openNeuroDoi}`));
  }

  // Step 2: Create NEMAR dataset record + GitHub repo
  const createSpinner = ora("Creating NEMAR dataset record...").start();
  try {
    // Intentionally do not seed a placeholder description here. OpenNeuro
    // provenance is already encoded by `source: "openneuro"`, `source_id`,
    // and the `on*` dataset_id prefix; the website renders the attribution
    // from those fields. Seeding a placeholder string would overwrite the
    // LLM-enriched description on every metadata.json read (#535).
    const result = await importDataset({
      dataset_id: nemarId,
      name: datasetName,
      source: "openneuro",
      source_id: openneuroId,
    });
    createSpinner.succeed(`Created ${result.dataset_id} (${result.github_repo})`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("already exists") || msg.includes("409")) {
      createSpinner.warn(`Dataset ${nemarId} already exists, continuing...`);
    } else {
      createSpinner.fail(`Failed to create dataset: ${msg}`);
      process.exit(1);
    }
  }

  // Step 3: Enable OpenNeuro S3 remote and build key-to-URL map
  let keyUrlMap = new Map<string, string>();
  if (!options.skipData) {
    const whereisSpinner = ora("Mapping annexed files from OpenNeuro S3...").start();
    // No unsetEnv here (unlike the metadata fetch above): enableremote only
    // records the remote config and getAnnexWhereisAll reads location metadata
    // from the local git-annex branch — neither fetches object CONTENT from S3,
    // so neither signs a GET that the CI IAM boundary would deny (#768). The
    // whole on* fleet imported through this call with CI creds present.
    const enableResult = await runCommand(["git", "annex", "enableremote", "s3-PUBLIC"], {
      cwd: datasetPath,
    });
    if (enableResult.exitCode !== 0) {
      whereisSpinner.fail(`Failed to enable s3-PUBLIC remote: ${enableResult.stderr.trim()}`);
      process.exit(1);
    }

    keyUrlMap = await getAnnexWhereisAll(datasetPath);

    if (keyUrlMap.size === 0) {
      whereisSpinner.warn("No annexed files found, skipping data copy");
    } else {
      whereisSpinner.succeed(`Found ${keyUrlMap.size} annexed files`);
    }
  }

  // Inherited OpenNeuro remotes (`s3-PUBLIC`, `s3-PRIVATE`) must not be
  // selected by future `nemar dataset push` calls. nemar-s3 (created by
  // configureS3Remote below) is the canonical write destination. Runs even
  // when --skip-data because the inherited remotes are present in git config
  // from the upstream clone regardless of whether we built the URL map.
  await markInheritedOpenNeuroRemotesIgnored(datasetPath, (remote, err) => {
    console.log(
      chalk.yellow(
        `  Warning: could not mark ${remote} as annex-ignore (${err}). ` +
          `Future pushes may try to upload to ${remote}; ` +
          `run 'git config remote.${remote}.annex-ignore true' manually.`,
      ),
    );
  });

  // Step 4: Reconfigure git remote to nemarDatasets
  const remoteSpinner = ora("Configuring NEMAR remote...").start();
  const removeResult = await runCommand(["git", "remote", "remove", "origin"], {
    cwd: datasetPath,
  });
  if (removeResult.exitCode !== 0 && !removeResult.stderr.includes("No such remote")) {
    remoteSpinner.fail(`Failed to remove OpenNeuro remote: ${removeResult.stderr.trim()}`);
    process.exit(1);
  }
  const nemarRepoUrl = `git@github.com:nemarDatasets/${nemarId}.git`;
  const remoteResult = await configureGitHubRemote(datasetPath, nemarRepoUrl, "origin");
  if (!remoteResult.success) {
    remoteSpinner.fail(`Failed to configure remote: ${remoteResult.error}`);
    process.exit(1);
  }
  remoteSpinner.succeed("Configured NEMAR remote");

  // Step 5: Configure the NEMAR S3 special remote. This records the nemar-s3
  // uuid in the git-annex branch so the finalize phase (a fresh clone, possibly
  // on another runner) enables the SAME remote and registers keys against the
  // SAME uuid. No data is copied here — that's the copy phase.
  let nemarUuid = "";
  let items: ImportManifestItem[] = [];
  if (!options.skipData && keyUrlMap.size > 0) {
    const s3Spinner = ora("Setting up NEMAR S3 remote...").start();
    const s3Creds = resolveS3Credentials();
    const s3Result = await configureS3Remote(
      datasetPath,
      { name: "nemar-s3", bucket: S3_BUCKET, prefix: `${nemarId}/objects`, region: S3_REGION },
      s3Creds,
    );
    if (!s3Result.success) {
      s3Spinner.fail(`Failed to configure S3 remote: ${s3Result.error}`);
      process.exit(1);
    }
    const uuid = await getRemoteUuid(datasetPath, "nemar-s3");
    if (!uuid) {
      s3Spinner.fail("Failed to get NEMAR S3 remote UUID");
      process.exit(1);
    }
    nemarUuid = uuid;
    s3Spinner.succeed("Configured NEMAR S3 remote");

    const built = buildManifestItems(keyUrlMap, nemarId);
    items = built.items;
    if (built.skipped > 0) {
      console.log(chalk.yellow(`  Skipped ${built.skipped} keys (no usable source URL)`));
    }
    console.log(chalk.dim(`  Prepared ${items.length} files for server-side copy`));
  }

  // Step 6: Seed .nemar/metadata.json and normalize the README extension so
  // GitHub renders it (#642). Content is never modified.
  const metaSpinner = ora("Seeding metadata...").start();
  let readmeOutcome: ReadmeOutcome;
  try {
    seedMetadata(datasetPath, nemarId, openneuroId, bidsDesc, openNeuroDoi);
    readmeOutcome = ensureReadmeMd(datasetPath, openneuroId, openNeuroDoi);
  } catch (err) {
    metaSpinner.fail(
      `Failed to seed metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  // Any metadata un-annexed above (ensureRootMetadataUnannexed) is already
  // staged as a regular blob with annex disabled and is picked up by the
  // pathspec-less `git commit` below. It is deliberately NOT added to
  // pathsToStage: a plain `git add` here would re-annex it per the repo's
  // largefiles policy, undoing the un-annex.
  const pathsToStage = [".nemar/metadata.json"];
  if (readmeOutcome.kind === "renamed") {
    pathsToStage.push("README", "README.md");
  } else if (readmeOutcome.kind === "created") {
    pathsToStage.push("README.md");
  }
  const addResult = await runCommand(["git", "add", ...pathsToStage], { cwd: datasetPath });
  if (addResult.exitCode !== 0) {
    metaSpinner.fail(`Failed to stage metadata: ${addResult.stderr.trim()}`);
    process.exit(1);
  }
  const commitResult = await runCommand(
    ["git", "commit", "-m", `Add NEMAR metadata (imported from OpenNeuro ${openneuroId})`],
    { cwd: datasetPath },
  );
  if (commitResult.exitCode !== 0 && !commitResult.stdout.includes("nothing to commit")) {
    metaSpinner.fail(`Failed to commit metadata: ${commitResult.stderr.trim()}`);
    process.exit(1);
  }
  const readmeNote =
    readmeOutcome.kind === "renamed"
      ? "renamed README -> README.md"
      : readmeOutcome.kind === "kept"
        ? `kept upstream ${readmeOutcome.path}`
        : "wrote provenance stub README.md (no upstream README)";
  metaSpinner.succeed(`Seeded .nemar/metadata.json (${readmeNote})`);

  // Step 7: Push main + the git-annex branch (now carrying the nemar-s3 remote
  // config). Data blobs are copied in the next phase; finalize re-pushes the
  // git-annex branch once keys are registered. A `warning` (main landed but the
  // git-annex branch did not) is a hard fail — the dataset would be uncloneable.
  const pushSpinner = ora("Pushing to nemarDatasets...").start();
  const pushResult = await pushToGitHub(datasetPath, "origin");
  if (!pushResult.success) {
    pushSpinner.fail(`Failed to push: ${pushResult.error}`);
    process.exit(1);
  }
  if (pushResult.warning) {
    pushSpinner.fail(
      `Pushed main but git-annex branch failed: ${pushResult.warning}. Aborting — published dataset would be uncloneable. Investigate the git-annex push failure and re-run.`,
    );
    process.exit(1);
  }
  pushSpinner.succeed("Pushed to nemarDatasets");

  const manifest: ImportManifest = { openneuroId, nemarId, nemarUuid, items };
  if (options.persistStaging) {
    await writeManifestToS3(manifest, S3_BUCKET, S3_REGION);
    console.log(chalk.dim(`  Wrote import manifest to s3://${S3_BUCKET}/${nemarId}/staging/`));
  }
  console.log(chalk.green(`[prepare] done: ${nemarId} (${items.length} files to copy)`));
  return manifest;
}

/**
 * Phase 2 (copy, sharded): server-side copy this shard's slice of the manifest
 * from OpenNeuro S3 to NEMAR S3, resuming past objects already present at the
 * destination. Pure S3 — no git, no filesystem state. Re-running a shard is
 * safe and resumes (already-copied objects are skipped). Exits non-zero on any
 * copy failure with a resumable message.
 */
export async function copyShard(
  openneuroId: string,
  shard: { index: number; count: number },
  options: ImportOptions = {},
  inMemoryManifest?: ImportManifest,
): Promise<void> {
  const nemarId = mapDatasetId(openneuroId);
  const manifest = inMemoryManifest ?? (await readManifestFromS3(nemarId, S3_BUCKET, S3_REGION));
  const tag = `copy ${shard.index}/${shard.count}`;

  if (options.skipData || manifest.items.length === 0) {
    console.log(chalk.dim(`[${tag}] no data to copy`));
    return;
  }

  const shardItems: CopyItem[] = manifest.items
    .filter((it) => keyInShard(it.key, shard.index, shard.count))
    .map((it) => ({ key: it.key, source: it.source, httpUrl: it.sourceUrl, destUri: it.destUri }));

  if (shardItems.length === 0) {
    console.log(chalk.dim(`[${tag}] empty shard`));
    return;
  }

  // Resume: skip objects already present at the destination.
  const existing = await listExistingObjects(S3_BUCKET, `${nemarId}/objects/`, S3_REGION);
  const { toCopy, skipped } = filterAlreadyCopied(shardItems, existing);
  if (skipped.length > 0) {
    console.log(chalk.dim(`[${tag}] skipped ${skipped.length} already present`));
  }
  if (toCopy.length === 0) {
    console.log(chalk.green(`[${tag}] nothing to copy (all ${skipped.length} present)`));
    return;
  }

  const spinner = ora(`[${tag}] copying ${toCopy.length} files...`).start();
  const result = await batchServerSideCopy(toCopy, S3_REGION, COPY_CONCURRENCY, (done, total) => {
    spinner.text = `[${tag}] ${done}/${total}`;
  });

  if (result.fellBack > 0) {
    console.log(
      chalk.yellow(`  ${result.fellBack} objects needed the curl fallback (check S3 permissions)`),
    );
  }
  if (result.failed.length > 0) {
    spinner.fail(`[${tag}] ${result.failed.length} of ${toCopy.length} files failed`);
    for (const f of result.failed.slice(0, 5)) {
      console.error(chalk.red(`    ${f.key}: ${f.error}`));
    }
    if (result.failed.length > 5) {
      console.error(chalk.red(`    ... and ${result.failed.length - 5} more`));
    }
    console.error(chalk.red("Re-run this shard to resume (already-copied objects are skipped)."));
    process.exit(1);
  }
  spinner.succeed(`[${tag}] copied ${result.copied}, skipped ${skipped.length}`);
}

/**
 * Phase 3 (finalize): verify every manifest object landed at the destination
 * (re-listing catches a missing/cancelled copy shard), re-clone, register the
 * copied keys with git-annex against the nemar-s3 remote, push the git-annex
 * branch, deploy CI, and publish. Reuses the publish/approve/reindex tail.
 */
export async function finalizeImport(
  openneuroId: string,
  options: ImportOptions = {},
  inMemoryManifest?: ImportManifest,
): Promise<void> {
  const nemarId = mapDatasetId(openneuroId);
  const manifest = inMemoryManifest ?? (await readManifestFromS3(nemarId, S3_BUCKET, S3_REGION));
  const workDir = options.workDir || mkdtempSync(join(tmpdir(), `nemar-finalize-${nemarId}-`));
  // Distinct from prepare's clone dir so a shared --dir doesn't collide.
  const datasetPath = join(workDir, `${nemarId}-finalize`);

  console.log(chalk.cyan(`\n[finalize] ${openneuroId} -> ${nemarId}\n`));

  const hasData = !options.skipData && manifest.items.length > 0;
  if (hasData) {
    // Verify all data landed by re-listing the destination against the manifest.
    const verifySpinner = ora("Verifying copied data...").start();
    const existing = await listExistingObjects(S3_BUCKET, `${nemarId}/objects/`, S3_REGION);
    const missing = manifest.items.filter((it) => !existing.has(it.key));
    if (missing.length > 0) {
      verifySpinner.fail(
        `${missing.length} of ${manifest.items.length} objects missing at the destination. Re-run the copy phase (a shard likely failed or was cancelled) before finalizing.`,
      );
      process.exit(1);
    }
    verifySpinner.succeed(`Verified ${manifest.items.length} objects present`);

    // Re-clone, enable nemar-s3 (reuses the prepare uuid), register keys, push.
    // useGitHubToken: this runs on a CI runner that has GH_TOKEN (HTTPS App
    // token) but no SSH key, so a raw `git@github.com:` clone of the private
    // NEMAR repo fails with "Permission denied (publickey)" (#768).
    const cloneSpinner = ora("Re-cloning for git-annex finalize...").start();
    const cloneResult = await cloneDataset(
      `git@github.com:nemarDatasets/${nemarId}.git`,
      datasetPath,
      { useGitHubToken: true },
    );
    if (!cloneResult.success) {
      cloneSpinner.fail(`Failed to clone ${nemarId}: ${cloneResult.error}`);
      process.exit(1);
    }
    cloneSpinner.succeed(`Cloned ${nemarId}`);

    const s3Creds = resolveS3Credentials();
    const s3Result = await configureS3Remote(
      datasetPath,
      { name: "nemar-s3", bucket: S3_BUCKET, prefix: `${nemarId}/objects`, region: S3_REGION },
      s3Creds,
    );
    if (!s3Result.success) {
      console.error(chalk.red(`Failed to enable S3 remote: ${s3Result.error}`));
      process.exit(1);
    }
    const nemarUuid = await getRemoteUuid(datasetPath, "nemar-s3");
    if (!nemarUuid) {
      console.error(chalk.red("Failed to get NEMAR S3 remote UUID on finalize clone"));
      process.exit(1);
    }
    // The finalize re-clone must resolve the SAME nemar-s3 uuid prepare created
    // (enableremote reuses it from the pushed git-annex branch). A mismatch would
    // register keys against a remote clones can't discover -> blobs unfindable.
    if (manifest.nemarUuid && nemarUuid !== manifest.nemarUuid) {
      console.error(
        chalk.red(
          `nemar-s3 uuid mismatch (prepare=${manifest.nemarUuid} finalize=${nemarUuid}). Aborting to avoid registering keys against the wrong remote.`,
        ),
      );
      process.exit(1);
    }

    const registerSpinner = ora("Registering files in git-annex...").start();
    const keys = manifest.items.map((it) => it.key);
    const regResult = await batchSetKeysPresent(datasetPath, keys, nemarUuid);
    if (regResult.failed > 0) {
      // Registration is the mechanism by which clones know a blob is in S3.
      // A failure here would leave the data physically present but invisible to
      // git-annex (uncloneable), so it's fatal. Finalize is idempotent — re-run
      // to retry (re-clone, re-register, re-push).
      registerSpinner.fail(
        `${regResult.failed} of ${keys.length} git-annex key registrations failed. Aborting before publish — those blobs would be unfindable for clones. Re-run finalize to retry.`,
      );
      process.exit(1);
    }
    registerSpinner.succeed(`Registered ${regResult.success} files in git-annex`);

    const pushSpinner = ora("Pushing git-annex branch...").start();
    const pushResult = await pushToGitHub(datasetPath, "origin");
    if (!pushResult.success) {
      pushSpinner.fail(`Failed to push git-annex branch: ${pushResult.error}`);
      process.exit(1);
    }
    if (pushResult.warning) {
      pushSpinner.fail(
        `git-annex branch push failed: ${pushResult.warning}. Aborting — published dataset would be uncloneable.`,
      );
      process.exit(1);
    }
    pushSpinner.succeed("Pushed git-annex branch");
  }

  // Step 8: Deploy CI workflows now that remote main exists.
  // addCi failure is fatal: --trust-upstream bypasses validation lookup,
  // not the deployment of validation/enrichment/archive workflows. Missing
  // workflows mean no future safety net (reviewer note for #451).
  let ciDeployedSuccessfully = false;
  const ciSpinner = ora("Deploying CI workflows...").start();
  try {
    await addCi(nemarId);
    ciSpinner.succeed(
      "CI workflows deployed (BIDS validation, LLM enrichment, archive generation)",
    );
    ciDeployedSuccessfully = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ciSpinner.fail(`CI deployment failed: ${msg}`);
    console.log(
      chalk.dim(
        `  After fixing the deploy failure, run 'nemar admin ci add ${nemarId}' and 'nemar admin publish request/approve ${nemarId}' to resume.`,
      ),
    );
  }

  // Step 9: Bounded wait for the BIDS validation workflow run to register
  // (replaces unconditional skip_ci_check=true; see #431). Only run when CI
  // actually deployed; the decision matrix is centralised in decideSkipCiCheck
  // so the post-mortem reading is legible.
  let poll: PollOutcome | null = null;
  if (ciDeployedSuccessfully) {
    const waitSpinner = ora("Waiting for BIDS validation run to register...").start();
    poll = await waitForBidsValidationRun(nemarId, waitSpinner);
    if (poll.kind === "found") {
      waitSpinner.succeed("BIDS validation run registered; deferring to ci_check at approval");
    } else if (poll.kind === "timeout") {
      const note = options.trustUpstream
        ? "trusting upstream OpenNeuro validation (--trust-upstream)"
        : "no --trust-upstream — aborting";
      waitSpinner.warn(`BIDS validation run did not register within 120s; ${note}`);
    } else {
      const msg = poll.lastError instanceof Error ? poll.lastError.message : String(poll.lastError);
      waitSpinner.fail(`All BIDS validation polls failed (last error: ${msg})`);
    }
  }
  const decision = decideSkipCiCheck({
    ciDeployed: ciDeployedSuccessfully,
    poll,
    trustUpstream: options.trustUpstream ?? false,
  });
  if (decision.abortReason) {
    console.error(chalk.red(decision.abortReason));
    process.exit(1);
  }
  const skipCiCheck = decision.skipCiCheck;

  // Step 10: Request and approve publication.
  //
  // The backend's /publish/request rejects with HTTP 422 + a "BIDS
  // validation is currently running" message while the just-deployed
  // validation workflow_run is still in flight. The bounded poll in
  // step 9 only waits for a run to REGISTER, not COMPLETE — so for
  // larger datasets we land here while validation is still running.
  // Retry the request up to 5 times with 5-minute waits (25 min total
  // budget) before giving up. Any other error fails fast.
  const PUBLICATION_REQUEST_MAX_ATTEMPTS = 5;
  const PUBLICATION_REQUEST_WAIT_MS = 5 * 60_000;
  const pubSpinner = ora("Requesting publication...").start();
  let publicationRequested = false;
  for (let attempt = 1; attempt <= PUBLICATION_REQUEST_MAX_ATTEMPTS; attempt++) {
    try {
      await requestPublication(nemarId);
      publicationRequested = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isValidationInProgress = msg.includes("BIDS validation is currently running");
      if (!isValidationInProgress) {
        pubSpinner.fail(`Failed to request publication: ${msg}`);
        process.exit(1);
      }
      if (attempt === PUBLICATION_REQUEST_MAX_ATTEMPTS) {
        pubSpinner.fail(
          `BIDS validation still in progress after ${PUBLICATION_REQUEST_MAX_ATTEMPTS} attempts (~${Math.round((PUBLICATION_REQUEST_MAX_ATTEMPTS * PUBLICATION_REQUEST_WAIT_MS) / 60000)}min). Re-run 'nemar admin publish request/approve ${nemarId}' once validation completes.`,
        );
        process.exit(1);
      }
      pubSpinner.text = `Waiting for BIDS validation to complete... (attempt ${attempt}/${PUBLICATION_REQUEST_MAX_ATTEMPTS}, next retry in 5min)`;
      await new Promise((r) => setTimeout(r, PUBLICATION_REQUEST_WAIT_MS));
    }
  }
  if (publicationRequested) {
    pubSpinner.succeed("Publication requested");
  }

  const approveSpinner = ora("Approving publication...").start();
  const maxRetries = 10;
  let approved = false;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // skipCiCheck is set in step 9 — true only when the bounded
      // workflow_run poll timed out AND --trust-upstream was passed.
      await approvePublication(nemarId, attempt > 1, false, skipCiCheck);
      approved = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        approveSpinner.text = `Approving publication... (attempt ${attempt + 1}/${maxRetries})`;
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        approveSpinner.fail(`Failed to approve publication after ${maxRetries} attempts: ${msg}`);
        process.exit(1);
      }
    }
  }
  if (approved) {
    approveSpinner.succeed("Publication approved");
  }

  // Phase 2 of #512: trigger LLM enrichment + D1 metadata-column population
  // for the freshly imported dataset. Without this, on* datasets stay with
  // NULL modalities/subject_count/tasks/etc in the catalog (the existing
  // post-version-DOI sync skips on* because it can't push to nemar.org).
  //
  // Failure here is logged but non-fatal: the dataset is already published.
  // Operators can re-run with `nemar admin reindex <id>` afterward.
  const reindexSpinner = ora("Refreshing metadata + LLM enrichment...").start();
  try {
    const result = await reindexDataset(nemarId);
    const enrichmentOk = result.enrichment?.status === "ok";
    const colsOk = result.sync?.metadata_columns_written === true;
    if (enrichmentOk && colsOk) {
      reindexSpinner.succeed("Refreshed enrichment + metadata columns");
    } else {
      const parts: string[] = [];
      if (!enrichmentOk) parts.push(`enrichment ${result.enrichment?.status ?? "missing"}`);
      if (!colsOk) parts.push("metadata columns not written");
      reindexSpinner.warn(
        `Partial reindex: ${parts.join(", ")} (run 'nemar admin reindex ${nemarId}' to retry)`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reindexSpinner.warn(
      `Reindex failed (non-fatal): ${msg}. Run 'nemar admin reindex ${nemarId}' to retry.`,
    );
  }

  if (options.persistStaging) {
    await cleanupStaging(nemarId, S3_BUCKET, S3_REGION);
  }

  // Summary
  console.log(chalk.green(`\nImport and publish complete: ${openneuroId} -> ${nemarId}`));
  console.log(chalk.dim(`  GitHub: https://github.com/nemarDatasets/${nemarId}`));
  console.log(chalk.dim(`  Working dir: ${datasetPath}`));
}

/**
 * Single-process import driver — unchanged external behavior. Runs prepare ->
 * copy (one shard = all keys) -> finalize in one process, passing the manifest
 * in memory (no S3 staging round-trip). This is the `--local` path and the
 * shape the test/dev workflow exercises.
 */
export async function importOpenNeuro(
  openneuroId: string,
  options: ImportOptions = {},
): Promise<void> {
  const manifest = await prepareImport(openneuroId, options);
  if (!options.skipData) {
    await copyShard(openneuroId, { index: 0, count: 1 }, options, manifest);
  }
  await finalizeImport(openneuroId, options, manifest);
}
