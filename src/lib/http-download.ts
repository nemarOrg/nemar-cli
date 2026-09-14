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
 * the pretty hostname does not. That keeps environment selection in exactly
 * one place: whichever API the CLI is already pointed at.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { getApiUrl } from "./api/client.js";
import { type BidsFilterResult, matchesBidsFilter } from "./bids-filter.js";

/**
 * One file as the data plane describes it.
 *
 * `checksum_algorithm` is `"git"` for files tracked in plain git (every BIDS
 * sidecar, `dataset_description.json`, `participants.tsv`, `README`) and an
 * annex backend name otherwise. That distinction is the only honest way to
 * implement `--no-data`, which means "metadata only": see
 * {@link isMetadataEntry}.
 */
export interface DataPlaneEntry {
  path: string;
  size: number;
  checksum?: string;
  checksum_algorithm?: string;
  bytes_url: string;
}

export interface HttpDownloadResult {
  filesDownloaded: number;
  filesSkipped: number;
  bytesDownloaded: number;
  errors: string[];
}

export interface VersionListing {
  latest: string | null;
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

async function getJson<T>(url: string, what: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new DataPlaneUnavailableError(
      `Could not reach the NEMAR data service (${url}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (response.status === 404) {
    throw new DataPlaneUnavailableError(
      `${what} is not served over HTTP. The data service carries published, public datasets; a private or not-yet-published dataset has to be downloaded with git-annex.`,
    );
  }
  if (!response.ok) {
    throw new DataPlaneUnavailableError(`${what} could not be read (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}

/** Published versions of a dataset, newest first, as the data plane sees them. */
export async function fetchVersions(datasetId: string): Promise<VersionListing> {
  const payload = await getJson<{ latest?: string | null; versions?: { version: string }[] }>(
    `${dataPlaneBase()}/${datasetId}`,
    `Dataset ${datasetId}`,
  );
  const versions = (payload.versions ?? []).map((v) => v.version).filter(Boolean);
  if (versions.length === 0) {
    throw new DataPlaneUnavailableError(
      `Dataset ${datasetId} has no published version to download over HTTP. Only published versions are served; use git-annex for an unpublished dataset.`,
    );
  }
  return { latest: payload.latest ?? versions[0], versions };
}

/** Every file in one published version. */
export async function fetchManifest(datasetId: string, version: string): Promise<DataPlaneEntry[]> {
  const entries = await getJson<DataPlaneEntry[]>(
    `${dataPlaneBase()}/${datasetId}/${version}/manifest.json`,
    `Manifest for ${datasetId} ${version}`,
  );
  if (!Array.isArray(entries)) {
    throw new DataPlaneUnavailableError(
      `Manifest for ${datasetId} ${version} was not a file list; the data service may be mid-deploy.`,
    );
  }
  return entries;
}

/**
 * Is this entry dataset metadata rather than recorded data?
 *
 * The manifest answers this directly: a file tracked in plain git carries
 * `checksum_algorithm: "git"`, and per ADR 0015 git holds metadata only while
 * git-annex holds the data. So this is a reading of the annex policy, not a
 * guess from the file extension -- which matters, because the extension is not
 * reliable in either direction (ADR 0031: `_motion.tsv` is data).
 */
export function isMetadataEntry(entry: DataPlaneEntry): boolean {
  return entry.checksum_algorithm === "git";
}

/**
 * Narrow a manifest to what the user asked for.
 *
 * `metadataOnly` is `--no-data`. Filters come from the same
 * `buildBidsFilterArgs` result the git-annex path hands to `git annex get`,
 * so both paths select the same files.
 */
export function selectEntries(
  entries: DataPlaneEntry[],
  filter: BidsFilterResult,
  options: { metadataOnly?: boolean } = {},
): DataPlaneEntry[] {
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

/**
 * Fetch one file, streaming to disk.
 *
 * A file already on disk at its declared size is left alone and reported as
 * skipped, which is what makes an interrupted download resumable with no flag:
 * re-running the command picks up where it stopped. Size is the only check
 * made here -- the manifest also carries a checksum, and verifying it would
 * mean re-reading every byte already on disk, which costs more than the
 * re-download it would save on the rare corrupt file.
 */
async function fetchOne(entry: DataPlaneEntry, outputDir: string): Promise<number | null> {
  const filePath = join(outputDir, entry.path);

  // A manifest is server-supplied data; a `..` in a path must not be able to
  // write outside the output directory.
  const root = resolve(outputDir);
  const resolved = resolve(filePath);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Refusing to write outside the output directory: ${entry.path}`);
  }

  if (existsSync(filePath)) {
    try {
      if (statSync(filePath).size === entry.size) return null;
    } catch {
      // Unreadable; fall through and re-fetch.
    }
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const response = await fetch(entry.bytes_url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${entry.path}: HTTP ${response.status}`);
  }
  await Bun.write(filePath, response);
  return entry.size;
}

/**
 * Download a selected file list into `outputDir` with a bounded worker pool.
 *
 * Failures are collected rather than thrown: a dataset with thousands of files
 * should not lose a two-hour transfer because one object 403s, and the caller
 * decides whether a partial result is acceptable (`--require-complete` does
 * not accept one). The pool is a plain queue over the single-threaded event
 * loop, so `concurrency` bounds in-flight requests exactly.
 */
export async function downloadEntries(
  entries: DataPlaneEntry[],
  outputDir: string,
  options: {
    concurrency?: number;
    onProgress?: (filesDone: number, filesTotal: number, bytesDone: number) => void;
  } = {},
): Promise<HttpDownloadResult> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const queue = [...entries];
  const result: HttpDownloadResult = {
    filesDownloaded: 0,
    filesSkipped: 0,
    bytesDownloaded: 0,
    errors: [],
  };
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      try {
        const written = await fetchOne(entry, outputDir);
        if (written === null) {
          result.filesSkipped++;
        } else {
          result.filesDownloaded++;
          result.bytesDownloaded += written;
        }
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
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

/** The one wording for what an HTTP download is not. */
export function printSnapshotCaveat(outputPath: string): void {
  console.log(chalk.dim("  This is a file snapshot, not a git repository:"));
  console.log(
    chalk.dim("    - 'nemar dataset commit/push/update' need a git-annex clone, not this copy"),
  );
  console.log(
    chalk.dim(`    - to widen the selection, re-run the download into ${outputPath} with`),
  );
  console.log(chalk.dim("      different filters; already-present files are skipped"));
}
