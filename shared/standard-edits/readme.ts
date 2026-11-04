/**
 * NEMAR's standard edits to a dataset's root README, made at two different times.
 *
 * - **On import** (`ensureReadmeMd` in `src/lib/import-openneuro.ts`, #642): a bare `README` is
 *   renamed to `README.md` so GitHub renders it, any other README is kept, and a dataset with no
 *   README gets a provenance-only stub. {@link decideReadme} is that rule over a list of names, and
 *   {@link readmeProvenanceStub} is the stub's text.
 * - **On publication** (the orchestrator's `update_readme` step): the content of the first README
 *   in {@link PUBLISH_README_ORDER} becomes `README.md` with the concept-DOI badge on top
 *   ({@link planReadmeBadgeCommit}, {@link buildDoiBadge}), and every other README form is
 *   deleted ({@link selectPublishReadmes}).
 *
 * They live in `shared/` because the upstream re-pull's planner (ADR 0111) runs in the CLI and has
 * to tell these edits apart from a contributor's change by making them itself; a copy there would
 * drift from what import and publish do. `ensureReadmeMd` and the orchestrator call these
 * functions, and `backend/src/services/doi.ts` re-exports the badge pair for its existing callers,
 * as it re-exports `applyConceptDoiToDescription` from `shared/standard-edits/description.ts`.
 *
 * Pure: no I/O, and no import from Node or the Worker runtime, so the Worker bundle and the CLI
 * both load it.
 *
 * Note the two moments use different name rules on purpose (they are today's behavior, not a
 * design): import matches README names in any case and with any extension, while publication
 * looks for four exact spellings. Neither is `shared/readme-candidates.ts`'s order, which is the
 * one the submission gate and the reviews read a README by.
 */

// ---------------------------------------------------------------------------------------
// On import (#642)
// ---------------------------------------------------------------------------------------

/**
 * A README file name, in any case, with at most one alphanumeric extension: `README`, `readme`,
 * `Readme.md`, `README.MD`, `README.rst`. Not `READMEx` and not `README.md.bak`.
 *
 * Case-insensitive on purpose: on case-insensitive filesystems (macOS APFS, Windows NTFS)
 * writing the stub to `README.md` would silently overwrite an upstream `Readme.md` that the scan
 * missed. No `g` flag, so `test` keeps no state between calls.
 */
export const README_FILENAME = /^README(\.[A-Za-z0-9]+)?$/i;

/**
 * What the import does with the root README, as {@link decideReadme} decides it.
 *
 * - `renamed`: the bare README named `from` (any case) becomes `README.md`; content untouched.
 * - `kept`: a README with an extension already exists, at `path`; nothing changes.
 * - `created`: no README exists, so {@link readmeProvenanceStub} is written to `README.md`.
 */
export type ReadmeDecision =
  | { kind: "renamed"; from: string; to: "README.md" }
  | { kind: "kept"; path: string }
  | { kind: "created"; path: "README.md" };

/**
 * The import's README rule (#642) over the dataset root.
 *
 * `rootFileNames` are the names of the REGULAR files at the root (a symlink is not one, as
 * `ensureReadmeMd`'s `Dirent.isFile()` sees it), in the order the caller lists them. That order
 * matters in exactly one case: when two README names with an extension are present, the first is
 * the one reported as kept, as `ensureReadmeMd`'s `Array.find` over a directory listing reports
 * it. Nothing is renamed or written in that case, so the dataset itself does not depend on it.
 *
 * - A README with an extension wins over a bare one: it is already renderable, and renaming the
 *   bare one over it would destroy authored content.
 * - Otherwise a bare README, in any case, is renamed to `README.md`.
 * - Otherwise the stub is created.
 */
export function decideReadme(rootFileNames: readonly string[]): ReadmeDecision {
  const readmes = rootFileNames.filter((name) => README_FILENAME.test(name));
  const suffixed = readmes.find((name) => name.includes("."));
  if (suffixed !== undefined) return { kind: "kept", path: suffixed };
  const bare = readmes.find((name) => !name.includes("."));
  if (bare !== undefined) return { kind: "renamed", from: bare, to: "README.md" };
  return { kind: "created", path: "README.md" };
}

/**
 * The provenance-only README the import writes when upstream ships none. Deterministic, so the
 * same dataset always gets the same bytes. Provenance is also encoded in `.nemar/metadata.json`
 * (IsDescribedBy / IsIdenticalTo); the stub is for a visitor browsing the GitHub repository.
 */
export function readmeProvenanceStub(openneuroId: string, openNeuroDoi: string | null): string {
  const marker = "<!-- nemar:provenance -->";
  const openneuroUrl = `https://openneuro.org/datasets/${openneuroId}`;
  const doiLine = openNeuroDoi ? `\n- DOI: [${openNeuroDoi}](https://doi.org/${openNeuroDoi})` : "";
  return `${marker}\n## Provenance\n\nThis dataset is mirrored on NEMAR from OpenNeuro.\n\n- Source: [${openneuroId}](${openneuroUrl})${doiLine}\n`;
}

// ---------------------------------------------------------------------------------------
// On publication (the orchestrator's update_readme step)
// ---------------------------------------------------------------------------------------

/**
 * The README spellings the publish step looks for at the root, exact case, in the order it takes
 * the content source: an existing `README.md` first, then `README.rst`, `README.txt`, `README`.
 */
export const PUBLISH_README_ORDER = ["README.md", "README.rst", "README.txt", "README"] as const;

/** What the publish step does with the root README files it finds. */
export interface PublishReadmeFiles<T extends { path: string }> {
  /** Every root README found, in {@link PUBLISH_README_ORDER}. */
  found: T[];
  /** The file whose content becomes `README.md`: the first found, or undefined when none is. */
  contentSource: T | undefined;
  /** What the step deletes once `README.md` is written: every found file but `README.md`, in order. */
  remove: T[];
}

/**
 * The publish step's README selection over a repository tree (`path` is the full path, exact
 * case, so `sub-01/README.md` and `readme.md` are not README files here). The first entry with
 * each spelling is the one taken, as `Array.find` takes it.
 */
export function selectPublishReadmes<T extends { path: string }>(
  tree: readonly T[],
): PublishReadmeFiles<T> {
  const found: T[] = [];
  for (const candidate of PUBLISH_README_ORDER) {
    const entry = tree.find((f) => f.path === candidate);
    if (entry) found.push(entry);
  }
  return {
    found,
    contentSource: found[0],
    remove: found.filter((f) => f.path !== "README.md"),
  };
}

/** Decision for the publish orchestrator's update_readme step.
 *  `commit=false` means the README is already correct on disk and the
 *  step should make no GitHub call. `commit=true` means write `content`
 *  to README.md with `message` as the commit subject. */
export type ReadmeBadgePlan =
  | { commit: false; reason: string }
  | { commit: true; content: string; message: string };

/**
 * The README badge for a concept DOI, in the one spelling NEMAR uses.
 *
 * EZID is the sole registrar (ADR 0007, #1182), so it is always the shields.io form;
 * the Zenodo badge went with the `doi_provider` column. Shared with the #1386 repair
 * so a re-badged README matches what publish would have written.
 */
export function buildDoiBadge(conceptDoi: string): string {
  const doiUrl = `https://doi.org/${conceptDoi}`;
  const badgeImg = `https://img.shields.io/badge/DOI-${encodeURIComponent(conceptDoi)}-blue`;
  return `[![DOI](${badgeImg})](${doiUrl})`;
}

/**
 * Decide whether the update_readme step should ship a commit.
 *
 * Skips when the existing README.md already contains a badge whose URL encodes the
 * *current* conceptDoi. Without the DOI match, a stale badge from a re-registered or
 * migrated DOI would be silently kept.
 */
export function planReadmeBadgeCommit(args: {
  readmeContent: string;
  doiBadge: string;
  conceptDoi: string;
  contentSourcePath: string | undefined;
}): ReadmeBadgePlan {
  const { readmeContent, doiBadge, conceptDoi, contentSourcePath } = args;
  const isRename = contentSourcePath !== undefined && contentSourcePath !== "README.md";

  const hasAnyBadge =
    readmeContent.includes("zenodo.org/badge/DOI") ||
    readmeContent.includes("img.shields.io/badge/DOI");

  const encodedDoi = encodeURIComponent(conceptDoi);
  const hasCurrentBadge =
    hasAnyBadge && (readmeContent.includes(conceptDoi) || readmeContent.includes(encodedDoi));

  if (hasCurrentBadge && !isRename) {
    return { commit: false, reason: "badge already points to current concept DOI" };
  }

  const nextContent = hasCurrentBadge ? readmeContent : `${doiBadge}\n\n${readmeContent}`;
  const verb = hasAnyBadge && !hasCurrentBadge ? "Replace stale" : "Add";
  const renameVerb = isRename
    ? `Rename ${contentSourcePath} to README.md and ${verb.toLowerCase()}`
    : verb;

  return {
    commit: true,
    content: nextContent,
    message: `${renameVerb} DOI badge: ${conceptDoi}`,
  };
}
