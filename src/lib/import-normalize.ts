/**
 * Bringing an imported clone onto NEMAR's annex policy.
 *
 * The import deliberately inherits upstream's annex layout -- that is what makes
 * the S3 leg a server-side copy by key -- so it inherits upstream's idea of what
 * counts as data too. OpenNeuro decides by size alone (~1 MB), NEMAR by the
 * policy in `git-annex/policy.ts`, and the gap between the two is what left 675 MB
 * of `_motion.tsv` recordings in a public git repo (#1158). `findUnannexedData`
 * reports that gap; this module closes it, in the two places it has to be closed:
 *
 *   - {@link normalizeUnannexedData} annexes the files already in the clone and
 *     uploads their content, so the tree we push names keys that resolve.
 *   - {@link normalizeGitattributes} strips the inherited `annex.largefiles`
 *     attributes, without which NEMAR's policy never governs this repo again --
 *     a `.gitattributes` setting beats both `git annex config` and git config,
 *     so every later add would keep following upstream's rule. See ADR 0057.
 *
 * Both run in the prepare phase, which is the only phase holding a clone whose
 * git-resident content is present on disk.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunkAddTargets, gitAnnexAdd } from "./git-annex/init.js";
import { runCommand } from "./git-annex/run-command.js";
import type { S3Credentials } from "./git-annex/s3-remote.js";
import { copyPathsToAnnexRemote, getAnnexKeysForPaths } from "./git-annex/transfer.js";
import type { ImportManifestItem } from "./s3-server-copy.js";

/** A file that was moved from plain git into the annex, with the key now holding it. */
export interface NormalizedFile {
  path: string;
  key: string;
  size: number;
}

/**
 * Most content this may upload from the prepare host in one import.
 *
 * ADR 0010 keeps the bulk data plane off the runner, and this leg is the one
 * exception: the content is a plain git blob upstream, so it exists nowhere to be
 * server-side copied from by key, and the clone has already pulled every byte
 * anyway. What makes that exception safe is that the volume is bounded by what
 * upstream put in a git repository -- 675 MB for `ds007788`, the worst case the
 * catalogue sweep found, against GitHub's own 5 GB repository advisory. This
 * makes the bound explicit rather than assumed, so a pathological dataset stops
 * here with a legible error instead of at the job's six-hour cap.
 */
export const NORMALIZE_MAX_BYTES = 5 * 1024 ** 3;

export interface NormalizeDataResult {
  /** Manifest entries for the uploaded keys, marked `origin: "local"`. */
  items: ImportManifestItem[];
  files: NormalizedFile[];
  /** Files git-annex reported copying. Lower than `files.length` on a re-run
   *  whose keys the remote already holds, which is not an error. */
  copied: number;
  bytes: number;
}

/**
 * The three gitattributes spellings that set (or unset) an attribute, for the
 * one attribute this module removes. Real OpenNeuro trees only use the `=value`
 * form; the other two are handled so a hand-edited tree cannot slip through.
 */
const LARGEFILES_TOKEN_RE = /^(?:annex\.largefiles(?:=.*)?|-annex\.largefiles|!annex\.largefiles)$/;

/**
 * True for a gitattributes pattern that governs git's own plumbing files rather
 * than dataset content -- `**\/.git*`, `.git*`, `.gitattributes`.
 *
 * Their `annex.largefiles=nothing` is kept. It is not a statement about what
 * NEMAR considers data (the policy module says nothing about `.git*` files), and
 * annexing a `.gitattributes` would replace it with a symlink git-annex then
 * cannot read its own configuration from. DataLad writes this line into every
 * repo it creates, ours included.
 */
export function isGitPlumbingPattern(pattern: string): boolean {
  const last = pattern.split("/").pop() ?? pattern;
  return last.startsWith(".git");
}

/**
 * Remove `annex.largefiles` from the attribute lines of a `.gitattributes` file,
 * leaving every other attribute (`text`, `eol`, `annex.backend`, ...) untouched.
 *
 * A line left with no attributes at all is dropped rather than kept as a bare
 * pattern, so the result has no inert leftovers. Comments, blank lines, spacing
 * and the file's final-newline state are preserved, because this rewrites a file
 * a depositor wrote.
 */
export function stripLargefilesAttributes(content: string): {
  content: string;
  stripped: number;
} {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  // A trailing "\n" splits into a final "" that is not a line; hold it aside so
  // it cannot be mistaken for one and re-emitted as an extra blank line.
  if (hadTrailingNewline) lines.pop();

  const out: string[] = [];
  let stripped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    const [pattern, ...attributes] = tokens;
    if (isGitPlumbingPattern(pattern)) {
      out.push(line);
      continue;
    }
    const kept = attributes.filter((a) => !LARGEFILES_TOKEN_RE.test(a));
    const removed = attributes.length - kept.length;
    if (removed === 0) {
      out.push(line);
      continue;
    }
    stripped += removed;
    if (kept.length > 0) out.push([pattern, ...kept].join(" "));
    // else: pattern with nothing left to say -- drop the line.
  }

  const rebuilt = out.join("\n") + (hadTrailingNewline ? "\n" : "");
  return { content: rebuilt, stripped };
}

/** Every tracked `.gitattributes` in the repo, root and nested, repo-relative. */
async function listTrackedGitattributes(datasetPath: string): Promise<string[]> {
  const { stdout, exitCode, stderr } = await runCommand(
    ["git", "ls-files", "-z", "--", ".gitattributes", "*/.gitattributes"],
    { cwd: datasetPath },
  );
  if (exitCode !== 0) {
    throw new Error(`git ls-files failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout.split("\0").filter(Boolean);
}

/**
 * Strip inherited `annex.largefiles` attributes from every tracked
 * `.gitattributes`, so NEMAR's `annex.largefiles` configuration is what decides
 * this repo's future adds.
 *
 * Nested files are included: one left in `derivatives/` would govern that subtree
 * and reopen the same hole there. Rewritten files are staged, not committed --
 * the caller owns the commit.
 *
 * Returns the files it changed and how many attributes it removed.
 */
export async function normalizeGitattributes(
  datasetPath: string,
): Promise<{ changed: string[]; stripped: number }> {
  const changed: string[] = [];
  let stripped = 0;

  for (const rel of await listTrackedGitattributes(datasetPath)) {
    const abs = join(datasetPath, rel);
    // Tracked but absent from the working tree (a sparse or partial checkout):
    // nothing to rewrite, and inventing one would commit a file this checkout
    // cannot see the rest of.
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs, "utf8");
    const result = stripLargefilesAttributes(before);
    if (result.stripped === 0 || result.content === before) continue;
    writeFileSync(abs, result.content);
    changed.push(rel);
    stripped += result.stripped;
  }

  if (changed.length > 0) {
    const { exitCode, stderr } = await runCommand(["git", "add", "--", ...changed], {
      cwd: datasetPath,
    });
    if (exitCode !== 0) {
      throw new Error(`Failed to stage rewritten .gitattributes: ${stderr.trim()}`);
    }
  }
  return { changed, stripped };
}

/**
 * Drop paths from the index while leaving them in the working tree, so git-annex
 * will look at them again.
 *
 * This is the step without which none of this works. `git annex add` only
 * considers files git sees as new or modified, so on a file that is committed as a
 * plain blob and unmodified it does nothing at all -- exit 0, no output, no change
 * -- and `--force-large` does not alter that: the flag decides which plane a
 * considered file goes to, not whether it is considered. Verified against
 * git-annex 10.20260901. Un-caching the path makes it new again, and the resulting
 * commit is a plain typechange on the same path.
 */
async function unstageTrackedPaths(datasetPath: string, paths: string[]): Promise<void> {
  for (const chunk of chunkAddTargets(paths)) {
    const { exitCode, stderr } = await runCommand(
      ["git", "rm", "--cached", "--quiet", "--", ...chunk],
      { cwd: datasetPath },
    );
    if (exitCode !== 0) {
      throw new Error(
        `Failed to uncache ${chunk.length} path(s) from the git index: ${stderr.trim()}`,
      );
    }
  }
}

/**
 * Move files the clone carries as plain git blobs into the annex and upload their
 * content to `remoteName`.
 *
 * The enabling fact is that a git-resident file's content is always present in the
 * clone, so this needs no annex fetch: uncache, add, verify the keys, upload. That
 * order is deliberate. Annexing without uploading publishes a pointer nothing can
 * resolve, which is worse than the bloat this fixes, so neither a path that failed
 * to annex nor a failed upload reaches the commit -- both abort the import.
 *
 * The returned items carry `origin: "local"`: their content is already at the
 * destination, so the copy phase must skip them, while finalize's size
 * verification and key registration must not.
 */
export async function normalizeUnannexedData(args: {
  datasetPath: string;
  files: Array<{ path: string; size: number }>;
  remoteName: string;
  bucket: string;
  nemarId: string;
  credentials?: S3Credentials;
  jobs?: number;
  /** Overridable so the bound itself is testable; production uses the default. */
  maxBytes?: number;
}): Promise<NormalizeDataResult> {
  const { datasetPath, files, remoteName, bucket, nemarId, credentials } = args;
  if (files.length === 0) return { items: [], files: [], copied: 0, bytes: 0 };

  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  const maxBytes = args.maxBytes ?? NORMALIZE_MAX_BYTES;
  if (bytes > maxBytes) {
    throw new Error(
      `${files.length} file(s) totalling ${(bytes / 1024 ** 3).toFixed(1)} GiB need annexing, over the ${(maxBytes / 1024 ** 3).toFixed(1)} GiB this leg will upload from the import host (NORMALIZE_MAX_BYTES, ADR 0010/0057). Import this dataset with the limit deliberately raised, on a host that can finish the upload, rather than discovering it at the job timeout.`,
    );
  }

  const paths = files.map((f) => f.path);
  await unstageTrackedPaths(datasetPath, paths);
  const added = await gitAnnexAdd(datasetPath, paths, {}, { forceLarge: true });
  if (!added.success) {
    throw new Error(`Failed to annex ${paths.length} data file(s): ${added.error}`);
  }

  // The add reports success whether or not it did anything, so ask git-annex what
  // it now holds. A path with no key did not annex -- uncached but skipped,
  // vanished, unreadable -- and the tree would not say what the manifest says.
  const keys = await getAnnexKeysForPaths(datasetPath, paths);
  const missing = paths.filter((p) => !keys.has(p));
  if (missing.length > 0) {
    throw new Error(
      `Annexed ${paths.length} file(s) but git-annex reports no key for ${missing.length} of them (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}). Refusing to continue: the commit would carry data files git-annex does not hold.`,
    );
  }

  const copy = await copyPathsToAnnexRemote(
    datasetPath,
    remoteName,
    paths,
    args.jobs ?? 4,
    credentials,
  );
  if (!copy.success) {
    throw new Error(
      `Annexed ${paths.length} data file(s) but the upload to ${remoteName} failed: ${copy.error}. Not committing: the pushed tree would name keys with no content behind them.`,
    );
  }

  const normalized: NormalizedFile[] = files.map((f) => ({
    path: f.path,
    // biome-ignore lint/style/noNonNullAssertion: every path is in `keys` (checked above)
    key: keys.get(f.path)!,
    size: f.size,
  }));

  // Identical content shares one key, so dedupe: the manifest addresses keys,
  // and a duplicate entry would have finalize verify and register it twice.
  const items = new Map<string, ImportManifestItem>();
  for (const f of normalized) {
    items.set(f.key, {
      key: f.key,
      sourceUrl: null,
      source: null,
      destUri: `s3://${bucket}/${nemarId}/objects/${f.key}`,
      origin: "local",
    });
  }

  return {
    items: [...items.values()],
    files: normalized,
    copied: copy.filesCopied,
    bytes,
  };
}
