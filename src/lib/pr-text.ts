/**
 * The words a pull request opened by the CLI carries, and the CHANGES entry that goes with them.
 *
 * `nemar dataset update` and `nemar dataset push --pr` used to write the title and the body
 * themselves when given none: "Update from branch X", an empty body, and a file list that lost the
 * first letter of its first path. The automated pull request review (ADR 0092) now reads that text
 * and fails a pull request whose title or description says nothing, so the CLI stops producing it.
 * The author supplies both. This module refuses what a person could not read as a description of a
 * change, and builds the text the CLI adds around the author's own.
 *
 * **Readable text, and nothing heavier.** There is no hash, signature or approval step. The checks
 * are few and each is exact: an ordinary sentence is never refused, and whether a sentence is TRUE
 * of the change is the review's judgment, not this module's. `findTextProblem` never reads the
 * diff.
 *
 * Everything here is pure except {@link writeChangelogEntry}, which touches only the directory it
 * is given. The git commands whose output the parsers read are named on each parser, and the
 * tests feed them real git output.
 */

import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------
// Readable text
// ---------------------------------------------------------------------------------------------

export type TextKind = "title" | "description";

/** Every way text is refused, as a closed word. */
export const TEXT_PROBLEMS = [
  "empty",
  "machine_output",
  "placeholder",
  "template_field",
  "no_words",
  "too_long",
] as const;
export type TextProblemCode = (typeof TEXT_PROBLEMS)[number];

export interface TextProblem {
  code: TextProblemCode;
  /** Finishes a sentence that begins with the thing checked: "The title" plus this reason. */
  reason: string;
}

/** GitHub refuses a title over 256 characters; the version suffix and some margin come out of it. */
export const MAX_TITLE_LENGTH = 200;

/** A title is one line: every run of whitespace, newlines included, becomes one space. */
export function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Text that stands in for text. Matched against the whole text, lower-cased, with trailing
 * punctuation dropped, so "Save changes to the channel locations" is an ordinary sentence and only
 * "Save changes." is refused.
 */
const STAND_IN_TEXT: readonly RegExp[] = [
  // What this CLI wrote on the author's behalf before the author had to.
  /^save changes$/, // `dataset commit` and `dataset save`
  /^update from branch(?: \S+)?$/, // `dataset push --pr`
  /^update [a-z]{2}\d{6} to v?\d+\.\d+\.\d+$/, // `dataset update`, its title and its commit message
  // What people type to get past a required field.
  /^(?:tbd|tba|todo|fixme|n\/a|na|none|null|undefined|untitled|placeholder)$/,
  /^(?:title|description|message|summary|text|test|testing|asdf|x{3,})$/,
  /^lorem ipsum\b/,
];

/**
 * A template field left where its value belongs. The first three are syntax: the shapes an
 * unfilled template, or a shell that did not expand a variable, leaves behind. The fourth is the
 * one real instance this was written for: a dataset's rename PR was titled with the naming rule
 * "FirstAuthorSurname-year-keyword-paperDOI" instead of the name that rule produces.
 *
 * There is deliberately NO rule for "a long CamelCase word". BIDS field names are CamelCase by
 * specification (`PowerLineFrequency`, `DatasetDOI`, `ReferencesAndLinks`), as are task labels
 * (`task-RestingStateEyesClosed`), and they are the vocabulary of an ordinary dataset update.
 *
 * A bracket asks the reader to write something only when its first word is one that asks (your,
 * insert, enter, describe, write, fill in, replace) and more words follow inside it, and it is not
 * the text of a Markdown link. `<your title here>` and `[describe the change]` are refused;
 * `<Enter>`, `[Replace]`, `[Write-up](url)`, `[your lab](url)` and
 * `sub-<label>_task-<label>_eeg.edf` stay ordinary text.
 */
const TEMPLATE_FIELDS: readonly RegExp[] = [
  /\{\{[^{}]*\}\}/, // {{title}}
  /\$\{[^{}]*\}/, // ${TITLE}
  /[<[]\s*(?:your|insert|enter|describe|write|fill in|replace)\s+[^<>[\]]+[>\]](?![([])/i, // <your title>
  /\b(?:FirstAuthorSurname|paperDOI)\b/,
];

/** Seven to 64 hex digits holding at least one digit and one letter: a git or checksum digest. */
const DIGEST =
  /^(?:(?:sha\d*|md5|git|commit)[:\s-]*)?(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}$/i;

/** The whole text is one JSON object or array. A JSON string or number is not machine output. */
function isJsonDocument(text: string): boolean {
  if (!/^[[{]/.test(text) || !/[\]}]$/.test(text)) return false;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

function bareForm(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[\s.!:;,]+$/, "")
    .toLowerCase();
}

function quoted(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return `"${flat.length > 60 ? `${flat.slice(0, 57)}...` : flat}"`;
}

/**
 * The first reason `raw` cannot go into a pull request as the title or the description of a
 * change, or null when it can. A missing value is `empty`. Title text is judged as the one line
 * {@link normalizeTitle} makes of it.
 */
export function findTextProblem(kind: TextKind, raw: string | undefined): TextProblem | null {
  const text = kind === "title" ? normalizeTitle(raw ?? "") : (raw ?? "").trim();
  if (text === "") return { code: "empty", reason: "is empty; say in plain words what changed" };
  if (DIGEST.test(text) || isJsonDocument(text)) {
    return {
      code: "machine_output",
      reason: "is a raw hash or JSON; write a sentence that says what changed",
    };
  }
  const bare = bareForm(text);
  if (STAND_IN_TEXT.some((re) => re.test(bare))) {
    return {
      code: "placeholder",
      reason: `is placeholder text (${quoted(text)}); say what actually changed`,
    };
  }
  for (const re of TEMPLATE_FIELDS) {
    const field = text.match(re)?.[0];
    if (field !== undefined) {
      return {
        code: "template_field",
        reason: `still has an unfilled template field (${quoted(field)}); put the real value in its place`,
      };
    }
  }
  if (!/\p{L}{2,}/u.test(text)) {
    return {
      code: "no_words",
      reason: "has no words in it; write a sentence that says what changed",
    };
  }
  if (kind === "title" && text.length > MAX_TITLE_LENGTH) {
    return {
      code: "too_long",
      reason: `is ${text.length} characters; keep the title to one line of at most ${MAX_TITLE_LENGTH} and put the detail in the description`,
    };
  }
  return null;
}

/** One sentence about a refused text: `subject` is what to call it ("The title (--message)"). */
export function describeTextProblem(subject: string, problem: TextProblem): string {
  return `${subject} ${problem.reason}.`;
}

// ---------------------------------------------------------------------------------------------
// Changed files, as git reports them
// ---------------------------------------------------------------------------------------------

export type ChangeKind = "added" | "modified" | "removed";

export interface ChangedFile {
  status: ChangeKind;
  path: string;
}

function kindOf(code: string): ChangeKind {
  if (code.startsWith("A") || code.startsWith("C")) return "added";
  if (code.startsWith("D")) return "removed";
  return "modified";
}

/**
 * The files a commit is about to contain, from `git diff --cached --name-status -z --no-renames`.
 * Every entry is a status, a NUL, a path and a NUL, so a path is never quoted, trimmed or split on
 * a space. A rename or copy carries two paths (the old, then the new); the new one is what exists
 * now, so `--no-renames` is the command to ask for, and this still reads the output of one that
 * was asked without.
 */
export function parseStagedChanges(raw: string): ChangedFile[] {
  const parts = raw.split("\0");
  const out: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i];
    if (!code) {
      i++;
      continue;
    }
    const moved = code.startsWith("R") || code.startsWith("C");
    const path = parts[i + (moved ? 2 : 1)];
    i += moved ? 3 : 2;
    if (path) out.push({ status: kindOf(code), path });
  }
  return out;
}

/**
 * The paths `git status --porcelain -z` reports. The old reading trimmed the whole output before
 * cutting each line at its third character, and a work tree change (` M path`) has a leading space
 * that the trim removed from the FIRST line only, so the first path lost its first letter. Here an
 * entry is `XY`, a space and the path, and a rename's original path follows as an entry of its own.
 */
export function parsePorcelainPaths(raw: string): string[] {
  const parts = raw.split("\0");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    out.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The pull request text the CLI builds around the author's
// ---------------------------------------------------------------------------------------------

/** Up to this many files are listed by name; more are summarized by top-level folder. */
export const MAX_NAMED_FILES = 20;
/** The folders a long list names; the rest are counted. */
const MAX_FOLDER_LINES = 10;

const KINDS: readonly ChangeKind[] = ["added", "modified", "removed"];

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function counts(files: readonly ChangedFile[]): string {
  return KINDS.map((kind) => [kind, files.filter((f) => f.status === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
}

function byPath(a: ChangedFile, b: ChangedFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** A path as a Markdown code span; a control character or backtick would end the span early. */
function codeSpan(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is replaced
  return `\`${path.replace(/[\u0000-\u001f\u007f`]/g, "?")}\``;
}

function named(file: ChangedFile): string {
  return `- ${codeSpan(file.path)} (${file.status})`;
}

/**
 * What changed, for a reader. Up to {@link MAX_NAMED_FILES} files are listed by name with what
 * happened to each. A longer list is a total, the files at the dataset root by name (they are the
 * ones that describe the dataset), and each top-level folder with how many files in it changed;
 * never the paths themselves, because a bulk change would bury the sentence the author wrote.
 */
export function summarizeChangedFiles(files: readonly ChangedFile[]): string {
  if (files.length === 0) return "No files changed.";
  if (files.length <= MAX_NAMED_FILES) return [...files].sort(byPath).map(named).join("\n");

  const root = files.filter((f) => !f.path.includes("/")).sort(byPath);
  const folders = new Map<string, ChangedFile[]>();
  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash < 0) continue;
    const folder = f.path.slice(0, slash);
    folders.set(folder, [...(folders.get(folder) ?? []), f]);
  }
  const ranked = [...folders.entries()].sort(
    ([nameA, a], [nameB, b]) => b.length - a.length || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0),
  );

  const lines = [`${plural(files.length, "file")} changed: ${counts(files)}.`, ""];
  for (const f of root.slice(0, MAX_NAMED_FILES)) lines.push(named(f));
  if (root.length > MAX_NAMED_FILES) {
    lines.push(`- and ${plural(root.length - MAX_NAMED_FILES, "more file")} at the dataset root`);
  }
  for (const [folder, inside] of ranked.slice(0, MAX_FOLDER_LINES)) {
    lines.push(`- ${codeSpan(`${folder}/`)}: ${plural(inside.length, "file")} (${counts(inside)})`);
  }
  const rest = ranked.slice(MAX_FOLDER_LINES);
  if (rest.length > 0) {
    const restFiles = rest.reduce((n, [, inside]) => n + inside.length, 0);
    lines.push(`- and ${plural(rest.length, "more folder")} (${plural(restFiles, "file")})`);
  }
  return lines.join("\n");
}

/** The pull request title of an update: the author's title, then the version it releases. */
export function buildUpdateTitle(title: string, version: string): string {
  return `${title} (v${version})`;
}

export interface UpdateBodyInput {
  /** The author's description, already checked. */
  description: string;
  datasetId: string;
  fromVersion: string;
  toVersion: string;
  files: readonly ChangedFile[];
}

/** The pull request body of an update: the author's words first, then the facts the CLI knows. */
export function buildUpdateBody(input: UpdateBodyInput): string {
  return [
    input.description.trim(),
    `Bumps ${input.datasetId} from ${input.fromVersion} to ${input.toVersion}.`,
    `### Changed files\n\n${summarizeChangedFiles(input.files)}`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// CHANGES
// ---------------------------------------------------------------------------------------------

/** The names the review recognizes as a change log (scripts/ci/pr-review-evidence.ts). */
const CHANGELOG_FILE = /^(CHANGES|CHANGELOG)(\.(md|txt|rst))?$/i;

/** What may stand before a version at the start of a heading line: spaces, `#`, `[`, `v`, `version`. */
const HEADING_LEAD = String.raw`^[ \t#\[]*(?:(?:v|version|release):?[ \t]*)?`;
const ANY_VERSION_HEADING = new RegExp(`${HEADING_LEAD}\\d+\\.\\d+\\.\\d+`, "i");

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `text` already has a heading for `version`. The same line shape the review looks for
 * (`hasHeadingFor` in scripts/ci/pr-review-evidence.ts): a line that starts with the version after
 * any spaces, `#` marks or `[` and an optional `v`, `version` or `release`. A bullet that merely
 * starts with the number is not a heading, and neither is `1.0.1-beta` or `1.0.10` for `1.0.1`.
 * test/pr-text.unit.test.ts runs the review's own reader over what is written here.
 */
export function hasChangelogHeading(text: string, version: string): boolean {
  const heading = new RegExp(
    `${HEADING_LEAD}${escapeRegExp(version)}(?![0-9A-Za-z_-]|\\.[0-9])`,
    "i",
  );
  return text.split(/\r?\n/).some((line) => heading.test(line));
}

/**
 * `existing` with an entry for `version` added. Newest first, as BIDS and CPAN change logs are
 * kept: the entry goes above the first version heading already there (so a title line above the
 * entries stays above them), or at the top of a file that has none. The caller checks
 * {@link hasChangelogHeading} first: an author who wrote the entry already keeps it.
 *
 *     1.0.1 2026-10-16
 *
 *       - The author's title.
 *
 * `item` is the author's own title, written as they wrote it.
 */
export function addChangelogEntry(
  existing: string | null,
  version: string,
  item: string,
  isoDate: string,
): string {
  const heading = `${version} ${isoDate}`;
  const bullet = `  - ${item}`;
  if (existing === null || existing.trim() === "") return `${heading}\n\n${bullet}\n`;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const first = lines.findIndex((line) => ANY_VERSION_HEADING.test(line));
  const at = first < 0 ? 0 : first;
  return [...lines.slice(0, at), heading, "", bullet, "", ...lines.slice(at)].join(eol);
}

export type ChangelogOutcome = "created" | "added" | "present";

export interface ChangelogWrite {
  /** The change log's name at the dataset root. */
  file: string;
  outcome: ChangelogOutcome;
}

/** One line for the author about what happened to the change log. */
export function describeChangelogWrite(write: ChangelogWrite, version: string): string {
  switch (write.outcome) {
    case "created":
      return `Created ${write.file} with an entry for ${version}`;
    case "added":
      return `Added an entry for ${version} to ${write.file}`;
    case "present":
      return `${write.file} already has an entry for ${version}; left as it is`;
  }
}

function changelogRank(name: string): [number, number, string] {
  return [/^changes/i.test(name) ? 0 : 1, name.includes(".") ? 1 : 0, name];
}

/**
 * Write the entry for `version` into the dataset's change log: `CHANGES`, `CHANGES.md` and the like
 * if there is one, a new `CHANGES` (the BIDS name) if there is none. Throws when a name the review
 * would read as a change log is there but is not a regular file (a directory, a symbolic link into
 * the annex): writing through it, or beside it, would leave the review reading something else.
 */
export function writeChangelogEntry(
  dir: string,
  version: string,
  item: string,
  isoDate: string,
): ChangelogWrite {
  const candidates = readdirSync(dir).filter((name) => CHANGELOG_FILE.test(name));
  const regular = candidates
    .filter((name) => lstatSync(join(dir, name)).isFile())
    .sort((a, b) => {
      const [ra, rb] = [changelogRank(a), changelogRank(b)];
      return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0);
    });
  const blocked = candidates.find((name) => !regular.includes(name));
  if (regular.length === 0 && blocked !== undefined) {
    throw new Error(`${blocked} exists but is not a regular file, so the entry cannot be added`);
  }

  const texts = regular.map((name) => readFileSync(join(dir, name), "utf8"));
  const primary = regular[0];
  // The review reads every change log at the root as one text, so an entry in any of them counts.
  if (primary !== undefined && texts.some((text) => hasChangelogHeading(text, version))) {
    return { file: primary, outcome: "present" };
  }
  const file = primary ?? "CHANGES";
  writeFileSync(join(dir, file), addChangelogEntry(texts[0] ?? null, version, item, isoDate));
  return { file, outcome: primary === undefined ? "created" : "added" };
}

/** Today as `YYYY-MM-DD` on the author's own calendar. */
export function localIsoDate(now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}
