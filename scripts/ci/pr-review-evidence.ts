/**
 * What a pull request changed, read as git data (ADR 0092).
 *
 * Runs inside the central review workflow against a `--no-checkout` clone of the dataset
 * repository. **Nothing is checked out and nothing from the pull request is executed**: the
 * working tree never exists, so no hook, filter, `.gitattributes` driver or script in the pull
 * request can run, and a fork's content is read exactly like a branch's. Every git call passes its
 * arguments as an array (no shell) after the commit ids have been checked against a 40-hex shape,
 * so a path or a branch name is only ever data.
 *
 * The output has two halves with different trust. {@link buildEvidence} is the deterministic
 * account (counts per area, versions, subjects, a file list) that goes into the report whatever
 * the model says. {@link GitFacts} also carries the text the model is shown (patches, commit
 * subjects), all of it attacker-controlled and handled as such by `pr-review-prompt.ts`.
 */

import { execFileSync } from "node:child_process";
import {
  AREAS,
  type Area,
  type AreaCounts,
  type ChangeStatus,
  type ChangedFile,
  MAX_LISTED,
  type ReviewEvidence,
} from "../../shared/pr-review";
import { shouldAnnex } from "../../src/lib/git-annex/policy";

/** At most this many changed files are listed to the model; the counts always cover all of them. */
export const MAX_MODEL_FILES = 400;
/** At most this many files have their content (a diff) shown to the model. */
export const MAX_PATCH_FILES = 12;
/** Characters of one file's diff shown to the model. */
export const MAX_PATCH_FILE_CHARS = 6_000;
/** Characters of diff shown to the model in all. */
export const MAX_PATCH_TOTAL_CHARS = 24_000;
/** Commit subjects shown to the model. */
export const MAX_COMMITS = 30;

const SHA40 = /^[0-9a-f]{40}$/;
const SEMVER = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

/**
 * Where in a dataset a path sits. Recordings are whatever the repository's one annex policy
 * (ADR 0015, ADR 0031) always keeps out of git, so this cannot disagree with how the dataset was
 * built: a `_motion.tsv` is a recording here for the same reason it is annexed there.
 */
export function classifyPath(path: string): Area {
  const root = !path.includes("/");
  if (path === "dataset_description.json") return "dataset_description";
  if (root && /^(readme|changes)(\.[A-Za-z0-9]+)?$/i.test(path)) return "readme_and_changes";
  if (root && /^participants\.(tsv|json)$/.test(path)) return "participants";
  if (path.startsWith("derivatives/")) return "derivatives";
  if (path.startsWith("sourcedata/")) return "sourcedata";
  if (path.startsWith("code/")) return "code";
  if (shouldAnnex(path, 0)) return "recordings";
  if (/\.(json|tsv)$/i.test(path)) return "sidecars";
  return "other";
}

/** The order a reviewer would open things: the files that describe the dataset come first. */
const AREA_PRIORITY: readonly Area[] = [
  "dataset_description",
  "readme_and_changes",
  "participants",
  "sidecars",
  "code",
  "derivatives",
  "sourcedata",
  "other",
  "recordings",
];

// ---------------------------------------------------------------------------------------------
// Reading git
// ---------------------------------------------------------------------------------------------

export interface RawChange {
  status: ChangeStatus;
  path: string;
}

export interface Patch {
  path: string;
  text: string;
  truncated: boolean;
}

export interface GitFacts {
  changes: RawChange[];
  /** Diffs of the files worth reading: a few metadata files, in priority order. */
  patches: Patch[];
  /** Subject lines of the commits being merged. Attacker-controlled. */
  commits: string[];
  versionBefore: string | null;
  versionAfter: string | null;
  subjectsBefore: number | null;
  subjectsAfter: number | null;
  /** True when the change list was longer than {@link MAX_MODEL_FILES}. */
  listCut: boolean;
}

function git(dir: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function tryGit(dir: string, args: string[]): string | null {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

function requireSha(name: string, value: string): void {
  if (!SHA40.test(value)) throw new EvidenceError(`${name} is not a 40-hex commit id`);
}

/** Parse `git diff --name-status -z --no-renames` output. */
export function parseNameStatus(raw: string): RawChange[] {
  const parts = raw.split("\0");
  const out: RawChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    const path = parts[i + 1];
    if (!code || !path) continue;
    const status: ChangeStatus = code.startsWith("A")
      ? "added"
      : code.startsWith("D")
        ? "removed"
        : "modified";
    out.push({ status, path });
  }
  return out;
}

function versionAt(dir: string, rev: string): string | null {
  const raw = tryGit(dir, ["show", `${rev}:dataset_description.json`]);
  if (raw === null) return null;
  try {
    const v = (JSON.parse(raw) as { Version?: unknown }).Version;
    return typeof v === "string" && SEMVER.test(v) ? v : null;
  } catch {
    return null;
  }
}

function subjectsAt(dir: string, rev: string): number | null {
  const raw = tryGit(dir, ["ls-tree", "-d", "--name-only", rev]);
  return raw === null ? null : raw.split("\n").filter((n) => /^sub-/.test(n)).length;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : { text: text.slice(0, max), truncated: true };
}

/**
 * Read what `headSha` changes relative to the point it branched from `baseSha`.
 *
 * `baseSha` is the tip of `main`; the diff is taken against the merge base, so a pull request
 * is judged on what IT changes and not on what `main` gained since. Throws {@link EvidenceError}
 * when the commits are not present or share no history.
 */
export function gatherGitFacts(dir: string, baseSha: string, headSha: string): GitFacts {
  requireSha("base", baseSha);
  requireSha("head", headSha);
  const mergeBase = tryGit(dir, ["merge-base", baseSha, headSha])?.trim();
  if (!mergeBase || !SHA40.test(mergeBase)) throw new EvidenceError("no merge base");

  const raw = tryGit(dir, ["diff", "--name-status", "-z", "--no-renames", mergeBase, headSha]);
  if (raw === null) throw new EvidenceError("could not list changes");
  const changes = parseNameStatus(raw);

  const wanted = changes
    .filter((c) => {
      const area = classifyPath(c.path);
      return (
        area === "dataset_description" ||
        area === "readme_and_changes" ||
        area === "participants" ||
        (area === "sidecars" && /\.json$/i.test(c.path))
      );
    })
    .sort(
      (a, b) =>
        AREA_PRIORITY.indexOf(classifyPath(a.path)) - AREA_PRIORITY.indexOf(classifyPath(b.path)) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, MAX_PATCH_FILES);

  const patches: Patch[] = [];
  let budget = MAX_PATCH_TOTAL_CHARS;
  for (const c of wanted) {
    if (budget <= 0) break;
    const diff = tryGit(dir, [
      "diff",
      "-U2",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      mergeBase,
      headSha,
      "--",
      c.path,
    ]);
    if (diff === null || diff === "") continue;
    const { text, truncated } = clip(diff, Math.min(MAX_PATCH_FILE_CHARS, budget));
    budget -= text.length;
    patches.push({ path: c.path, text, truncated });
  }

  const log = tryGit(dir, ["log", "--format=%s", `-n${MAX_COMMITS}`, `${mergeBase}..${headSha}`]);
  return {
    changes,
    patches,
    commits: log === null ? [] : log.split("\n").filter(Boolean),
    versionBefore: versionAt(dir, mergeBase),
    versionAfter: versionAt(dir, headSha),
    subjectsBefore: subjectsAt(dir, mergeBase),
    subjectsAfter: subjectsAt(dir, headSha),
    listCut: changes.length > MAX_MODEL_FILES,
  };
}

// ---------------------------------------------------------------------------------------------
// The deterministic account
// ---------------------------------------------------------------------------------------------

function emptyAreas(): Record<Area, AreaCounts> {
  const out = {} as Record<Area, AreaCounts>;
  for (const a of AREAS) out[a] = { added: 0, modified: 0, removed: 0 };
  return out;
}

const STATUS_RANK: Record<ChangeStatus, number> = { removed: 0, modified: 1, added: 2 };

/**
 * The report's evidence block, from git alone. Every change is counted in exactly one area, so
 * the areas add up to `files_changed` by construction (the Worker refuses a report where they do
 * not). The file list is the first {@link MAX_LISTED} a reviewer would open: removals first, then
 * the files that describe the dataset, then the rest, recordings last.
 */
export function buildEvidence(facts: GitFacts): ReviewEvidence {
  const areas = emptyAreas();
  for (const c of facts.changes) {
    const bucket = areas[classifyPath(c.path)];
    if (c.status === "added") bucket.added++;
    else if (c.status === "removed") bucket.removed++;
    else bucket.modified++;
  }
  const listed: ChangedFile[] = [...facts.changes]
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        AREA_PRIORITY.indexOf(classifyPath(a.path)) - AREA_PRIORITY.indexOf(classifyPath(b.path)) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, MAX_LISTED)
    .map((c) => ({ status: c.status, path: c.path }));
  return {
    files_changed: facts.changes.length,
    files_read: facts.patches.length,
    truncated: facts.listCut || facts.patches.some((p) => p.truncated),
    version_before: facts.versionBefore,
    version_after: facts.versionAfter,
    subjects_before: facts.subjectsBefore,
    subjects_after: facts.subjectsAfter,
    areas,
    listed,
  };
}
