/**
 * Plain-HTTP dataset download: the path that needs no git, no git-annex and
 * no GitHub account.
 *
 * `nemar dataset download` normally clones the dataset repository and pulls
 * annexed content through git-annex. That is the right default -- it yields a
 * working repository with history, and `commit`/`push`/`update` operate on it.
 * It is also the wrong tool for three real cases:
 *
 *   1. git-annex is not installed. Today that is a hard exit, which is a poor
 *      answer to "I just want the files".
 *   2. The repository is not readable by the caller even though the DATA is
 *      public. This is the shape a temporarily-anonymous deposit takes.
 *   3. A machine where installing git-annex is impractical: a container, a
 *      login node, a CI runner.
 *
 * In all three the data plane already serves everything needed. This module
 * reads `<api>/data/<id>/<version>/manifest.json` -- one request that returns
 * every file's path, size, checksum and a direct byte URL -- and fetches the
 * selected entries with a bounded worker pool.
 *
 * **What you get is a snapshot, not a repository.** There is no `.git`, so
 * `nemar dataset commit`, `push` and `update` do not work in the result, and
 * `git annex get` cannot fetch anything that was filtered out. Re-running the
 * download with different filters is how you widen the selection. Callers must
 * say so; `printSnapshotCaveat` is the one wording.
 *
 * The data plane is addressed through the configured API origin's `/data`
 * mount rather than `data.nemar.org`, because that mount exists in every
 * environment (production, staging and the workers.dev dev deployment) while
 * the pretty hostname does not. That fixes which ENVIRONMENT is asked, in one
 * place: whichever API the CLI is already pointed at. It does not fix which
 * host serves the bytes -- those come from each entry's `bytes_url`, which
 * today names the data host for annexed files and `raw.githubusercontent.com`
 * for git-tracked ones (nemarOrg/nemar-cli#1403). The presigned `url` on each
 * entry is deliberately ignored in favour of `bytes_url`: `url` expires in
 * about an hour, which a long transfer outlives, while `bytes_url` is durable
 * by contract.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import {
  type DataPlaneManifestEntry,
  dataPlaneManifestSchema,
  dataPlaneVersionListingSchema,
  isMetadataEntry,
} from "../../shared/contract/data-plane.js";
import { getApiUrl } from "./api/client.js";
import { type BidsFilterResult, matchesBidsFilter } from "./bids-filter.js";

export type { DataPlaneManifestEntry } from "../../shared/contract/data-plane.js";
export { isMetadataEntry } from "../../shared/contract/data-plane.js";

/** Upper bound on in-flight requests, and what `-j` is clamped to. */
export const MAX_CONCURRENCY = 16;

/** Where a snapshot records what it is, so a later run can tell. */
export const SNAPSHOT_STAMP_PATH = ".nemar/http-snapshot.json";

/** Where a run leaves the complete list of files it could not fetch. */
export const FAILURE_LIST_PATH = ".nemar/http-download-failures.txt";

export interface HttpDownloadResult {
  filesDownloaded: number;
  filesSkipped: number;
  bytesDownloaded: number;
  /** One per file that could not be fetched, each naming the file. */
  errors: string[];
  /**
   * True when at least one failure was transport, authentication or local I/O
   * rather than evidence that the object is absent upstream.
   *
   * That distinction is the one `classifyGetOutcome` draws on the git-annex
   * path, and it decides the exit code: ADR 0005 makes genuinely absent content
   * a reportable state that still serves, while a dropped connection or a full
   * disk is a failed run whatever the tallies say. Collapsing the two exits 0
   * on a half-finished transfer.
   */
  hadInfrastructureFailure: boolean;
}

export interface VersionListing {
  latest: string;
  versions: string[];
}

/** The data plane's origin: the configured API origin plus its `/data` mount. */
export function dataPlaneBase(): string {
  return `${getApiUrl().replace(/\/+$/, "")}/data`;
}

/**
 * Thrown when the data plane cannot serve this dataset at all. Carries a
 * caller-ready sentence, because every reason is actionable by the user and
 * none of them is a bug worth a stack trace.
 */
export class DataPlaneUnavailableError extends Error {}

/**
 * Fetch and validate one data-plane document.
 *
 * Every failure mode ends as a `DataPlaneUnavailableError` carrying a sentence
 * a user can act on. That includes the body not being JSON at all, which is
 * what a captive portal or an intercepting proxy returns -- exactly the
 * networks this path exists to serve -- and which would otherwise surface as a
 * bare `SyntaxError: Unrecognized token '<'`.
 *
 * The schema is not decoration. This path reads `bytes_url` and
 * `checksum_algorithm` BY NAME, so a rename on the producing side turns into
 * "downloaded 0 files" and a green success line rather than an error. That is
 * the silent-cast failure `request()` in api/client.ts takes a schema to
 * prevent, and the same reasoning applies here.
 */
async function getDocument<T>(
  url: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  what: string,
  notFoundMessage: () => string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new DataPlaneUnavailableError(
      `Could not reach the NEMAR data service at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (response.status === 404) throw new DataPlaneUnavailableError(notFoundMessage());
  if (!response.ok) {
    throw new DataPlaneUnavailableError(`${what} could not be read (HTTP ${response.status}).`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    const contentType = response.headers.get("content-type") ?? "no content-type";
    throw new DataPlaneUnavailableError(
      `${what} did not come back as JSON (${contentType}) from ${url}. A proxy or captive portal may be intercepting the request.`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success || result.data === undefined) {
    throw new DataPlaneUnavailableError(
      `${what} did not match the expected shape. The data service may be mid-deploy, or this CLI may be too old for it; try upgrading.`,
    );
  }
  return result.data;
}

/** Published versions of a dataset, newest first, as the data plane sees them. */
export async function fetchVersions(datasetId: string): Promise<VersionListing> {
  const payload = await getDocument(
    `${dataPlaneBase()}/${datasetId}`,
    dataPlaneVersionListingSchema,
    `Dataset ${datasetId}`,
    () =>
      `Dataset ${datasetId} is not served over HTTP. The data service carries published, public datasets; a private or not-yet-published dataset has to be downloaded with git-annex.`,
  );
  const versions = payload.versions.map((v) => v.version).filter(Boolean);
  if (versions.length === 0) {
    throw new DataPlaneUnavailableError(
      `Dataset ${datasetId} has no published version to download over HTTP. Only published versions are served; use git-annex for an unpublished dataset.`,
    );
  }
  return { latest: payload.latest || versions[0], versions };
}

/**
 * Every file in one published version.
 *
 * A 404 here means something different from a 404 on the version listing, and
 * says so: the caller has just proved the dataset is published, so a missing
 * manifest is an operational gap on our side (manifests are healed through
 * `/admin/manifest/dispatch`), not a statement about visibility. Reporting it
 * as "private or not-yet-published" sends someone off to install git-annex for
 * a public dataset whose only problem is a file nobody has been told is
 * missing.
 */
export async function fetchManifest(
  datasetId: string,
  version: string,
): Promise<DataPlaneManifestEntry[]> {
  const entries = await getDocument(
    `${dataPlaneBase()}/${datasetId}/${version}/manifest.json`,
    dataPlaneManifestSchema,
    `Manifest for ${datasetId} ${version}`,
    () =>
      `${datasetId} ${version} is published, but its file list is missing from the data service. That is a NEMAR-side gap rather than a permission problem: please report it at https://github.com/nemarOrg/nemar-cli/issues. git-annex can still download this dataset meanwhile.`,
  );

  // A manifest that lists files but marks none of them as git-tracked cannot be
  // right: every BIDS dataset carries dataset_description.json in plain git
  // (ADR 0015). Reaching this means `checksum_algorithm` changed meaning, and
  // everything downstream fails silently -- `--no-data` selects nothing, and a
  // filtered download drops every sidecar and still reports success. The
  // guarantee that metadata always survives a filter is only as good as this
  // check, so it is made where it is relied on rather than assumed.
  if (entries.length > 0 && !entries.some(isMetadataEntry)) {
    throw new DataPlaneUnavailableError(
      `Manifest for ${datasetId} ${version} lists ${entries.length} files but marks none as git-tracked metadata, which cannot be right for a BIDS dataset. Refusing to download a tree that would be missing its sidecars; please report this at https://github.com/nemarOrg/nemar-cli/issues.`,
    );
  }
  return entries;
}

export function selectEntries(
  entries: DataPlaneManifestEntry[],
  filter: BidsFilterResult,
  options: { metadataOnly?: boolean } = {},
): DataPlaneManifestEntry[] {
  return entries.filter((entry) => {
    if (options.metadataOnly && !isMetadataEntry(entry)) return false;
    // Metadata is never filtered out by a BIDS entity filter: a subject-scoped
    // download still needs dataset_description.json and the sidecars, or what
    // lands on disk is not a readable BIDS dataset. The git-annex path gets
    // this for free, because those files ride along in the clone rather than
    // being fetched by `git annex get`.
    if (isMetadataEntry(entry)) return true;
    return matchesBidsFilter(entry.path, filter);
  });
}

/** A failure that says nothing about whether the object exists upstream. */
function isInfrastructureFailure(status: number | null): boolean {
  // A thrown fetch or a failed write (status null) is network, DNS or disk:
  // never evidence of absence. Among HTTP statuses only a clean 404 is.
  return status === null ? true : status !== 404;
}

/** Statuses worth trying again: throttling and transient server faults. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

interface FetchOutcome {
  /** Bytes written, or null when the file was already present and correct. */
  written: number | null;
  error?: { message: string; infrastructure: boolean };
}

/**
 * Fetch one file, streaming to disk, with bounded retries.
 *
 * Retries matter more here than for a typical client. Most of a dataset's
 * ENTRIES are git-tracked metadata whose `bytes_url` points at
 * `raw.githubusercontent.com` today, which throttles by address, so a single
 * 429 with no retry turns a 20,000-file download into thousands of permanent
 * failures on a perfectly healthy link.
 *
 * A file already on disk at its declared size is left alone and reported as
 * skipped, which is what makes an interrupted download resumable with no flag.
 * The write is then compared against that same declared size: `Bun.write`
 * returns the true byte count and does NOT throw on a short body, so without
 * this comparison a truncated response, or an intercepting proxy's HTML login
 * page, lands as a healthy file and the run reports success in green.
 *
 * Every error carries `entry.path`. A bare "The socket connection was closed
 * unexpectedly" repeated 800 times tells nobody which subtree is incomplete.
 */
async function fetchOne(
  entry: DataPlaneManifestEntry,
  outputDir: string,
  attempts: number,
): Promise<FetchOutcome> {
  const filePath = join(outputDir, entry.path);

  // A manifest is server-supplied data; a `..` in a path must not be able to
  // write outside the output directory.
  const root = resolve(outputDir);
  const resolved = resolve(filePath);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    return {
      written: null,
      error: {
        message: `${entry.path}: refusing to write outside the output directory`,
        infrastructure: true,
      },
    };
  }

  if (existsSync(filePath)) {
    try {
      if (statSync(filePath).size === entry.size) return { written: null };
    } catch (err) {
      // Fall through and re-fetch, but say why: the write below will fail for
      // the same reason, and a second unexplained error is a bad bug report.
      console.warn(
        chalk.dim(
          `  could not read existing ${entry.path} (${err instanceof Error ? err.message : String(err)}); re-fetching`,
        ),
      );
    }
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let message = `${entry.path}: download failed`;
  let infrastructure = true;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const backoff = (): Promise<void> => Bun.sleep(250 * 2 ** (attempt - 1));

    let response: Response;
    try {
      response = await fetch(entry.bytes_url, { redirect: "follow" });
    } catch (err) {
      message = `${entry.path}: ${err instanceof Error ? err.message : String(err)}`;
      infrastructure = isInfrastructureFailure(null);
      if (attempt < attempts) {
        await backoff();
        continue;
      }
      break;
    }

    if (!response.ok) {
      message = `${entry.path}: HTTP ${response.status}`;
      infrastructure = isInfrastructureFailure(response.status);
      if (isRetryableStatus(response.status) && attempt < attempts) {
        await backoff();
        continue;
      }
      break;
    }

    let written: number;
    try {
      written = await Bun.write(filePath, response);
    } catch (err) {
      message = `${entry.path}: ${err instanceof Error ? err.message : String(err)}`;
      infrastructure = true;
      break;
    }

    if (written === entry.size) return { written };

    // Remove it. Leaving a wrong-sized file behind would still be re-fetched
    // next run (the size check catches it), but it would satisfy any tool or
    // person who reads "the file exists" as "the file is there".
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Best effort; the mismatch reported below is what matters.
    }
    message = `${entry.path}: expected ${entry.size} bytes, received ${written}`;
    infrastructure = true;
    if (attempt < attempts) {
      await backoff();
      continue;
    }
    break;
  }

  return { written: null, error: { message, infrastructure } };
}

/**
 * Download a selected file list into `outputDir` with a bounded worker pool.
 *
 * Failures are collected rather than thrown: a dataset with thousands of files
 * should not lose a two-hour transfer because one object 403s, and the caller
 * decides what a partial result means. The pool is a plain queue over the
 * single-threaded event loop -- `queue.shift()` completes before the first
 * `await`, so no entry is taken twice -- and `concurrency` bounds in-flight
 * requests exactly.
 */
export async function downloadEntries(
  entries: DataPlaneManifestEntry[],
  outputDir: string,
  options: {
    concurrency?: number;
    attempts?: number;
    onProgress?: (filesDone: number, filesTotal: number, bytesDone: number) => void;
  } = {},
): Promise<HttpDownloadResult> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, MAX_CONCURRENCY));
  const attempts = Math.max(1, options.attempts ?? 3);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const queue = [...entries];
  const result: HttpDownloadResult = {
    filesDownloaded: 0,
    filesSkipped: 0,
    bytesDownloaded: 0,
    errors: [],
    hadInfrastructureFailure: false,
  };
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      const outcome = await fetchOne(entry, outputDir, attempts);
      if (outcome.error) {
        result.errors.push(outcome.error.message);
        if (outcome.error.infrastructure) result.hadInfrastructureFailure = true;
      } else if (outcome.written === null) {
        result.filesSkipped++;
      } else {
        result.filesDownloaded++;
        result.bytesDownloaded += outcome.written;
      }
      done++;
      options.onProgress?.(done, entries.length, result.bytesDownloaded);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length || 1) }, () => worker()),
  );
  return result;
}

// ===========================================================================
// Snapshot identity: what a directory already holds
// ===========================================================================

/**
 * Three distinct hazards, all of which end in a tree that looks fine and is
 * not:
 *
 *   - **A git-annex clone.** The default output path is `./<dataset-id>`, the
 *     same directory the clone path uses. Unfetched annexed files there are
 *     dangling symlinks, so `existsSync` is false and this path would write
 *     THROUGH them into the annex object store, under a key whose hash no
 *     longer matches its content -- corruption that surfaces only at the next
 *     `git annex fsck`.
 *   - **A different dataset.** Nothing about `-o ./data` stops a second
 *     dataset being poured on top of the first.
 *   - **A different version of the same dataset.** The subtle one.
 *     `dataset_description.json` carries `DatasetVersion`, and "1.0.0" ->
 *     "1.0.1" is byte-identical in length, so the resume check skips it and the
 *     tree becomes a mix of two versions whose only version marker names the
 *     older one. This command's own "re-run to widen the selection" advice is
 *     what triggers it.
 */
export type SnapshotConflict =
  | { kind: "git-repo" }
  | { kind: "other-dataset"; datasetId: string }
  | { kind: "other-version"; version: string };

export interface SnapshotStamp {
  dataset_id: string;
  version: string;
  updated_at: string;
}

export function readSnapshotStamp(outputDir: string): SnapshotStamp | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(outputDir, SNAPSHOT_STAMP_PATH), "utf8"),
    ) as Partial<SnapshotStamp>;
    if (!parsed.dataset_id || !parsed.version) return null;
    return {
      dataset_id: parsed.dataset_id,
      version: parsed.version,
      updated_at: parsed.updated_at ?? "",
    };
  } catch {
    return null;
  }
}

export function writeSnapshotStamp(outputDir: string, datasetId: string, version: string): void {
  const target = join(outputDir, SNAPSHOT_STAMP_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify({ dataset_id: datasetId, version, updated_at: new Date().toISOString() }, null, 2)}\n`,
  );
}

/** What, if anything, stops this download from writing into `outputDir`. */
export function inspectOutputDir(
  outputDir: string,
  datasetId: string,
  version: string,
): SnapshotConflict | null {
  if (!existsSync(outputDir)) return null;
  if (existsSync(join(outputDir, ".git"))) return { kind: "git-repo" };

  const stamp = readSnapshotStamp(outputDir);
  if (!stamp) return null;
  if (stamp.dataset_id !== datasetId) {
    return { kind: "other-dataset", datasetId: stamp.dataset_id };
  }
  if (stamp.version !== version) return { kind: "other-version", version: stamp.version };
  return null;
}

/** Write the complete failure list; returns its path, or null if there is none. */
export function writeFailureList(outputDir: string, errors: string[]): string | null {
  if (errors.length === 0) return null;
  const target = join(outputDir, FAILURE_LIST_PATH);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${errors.join("\n")}\n`);
    return target;
  } catch {
    return null;
  }
}

export function printSnapshotCaveat(outputPath: string): void {
  console.log(chalk.dim("  This is a file snapshot, not a git repository:"));
  console.log(
    chalk.dim("    - 'nemar dataset commit/push/update' need a git-annex clone, not this copy"),
  );
  console.log(
    chalk.dim(`    - to widen the selection, re-run the download into ${outputPath} with`),
  );
  console.log(chalk.dim("      different filters; already-present files are skipped"));
  console.log(
    chalk.dim("    - files are checked against their declared size, but not checksum-verified;"),
  );
  console.log(chalk.dim("      the git-annex path verifies content hashes, this one does not"));
}
