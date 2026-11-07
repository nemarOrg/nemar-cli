/**
 * What a job asks for, from the four places a person can say it (epic #2021 phase D3b, #2024; ADR 0118).
 *
 * The PARSER of the inline header is `shared/compute-header.ts` (epic #2005 phase A1): a deliberately
 * small subset of TOML read by one zero-dependency module the CLI, the Worker and the tests share. This
 * file does not read TOML a second way. It does the CLI's three jobs around it:
 *
 *  1. FIND a header: the `# /// nemar` block of a Python script, the `% /// nemar` block of a MATLAB script,
 *     or a folder's `nemar-job.toml`; and turn each of the parser's errors into a sentence that names the
 *     file and the line (never the text of the line: it is the person's own file, but a sentence that
 *     quotes it could quote a secret).
 *  2. READ the flags (`--mem 16G`, `--time 1h30m`) with the same conversions the header uses, so a flag
 *     and a header say the same thing in the same words, and name the FLAG in an error.
 *  3. MERGE them. THE PRECEDENCE IS FLAGS, THEN THE SCRIPT'S HEADER, THEN THE FOLDER'S FILE, THEN THE
 *     DEFAULTS, key by key: a flag beats a header for that key only, and a list (`datasets`, `args`) is
 *     replaced as a whole and never merged. `mergeSpecFields` is the one place that order is written.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  HEADER_KEYS,
  HEADER_MAX_BYTES,
  type HeaderError,
  type HeaderErrorCode,
  type HeaderFields,
  type HeaderKind,
  type SpecFields,
  headerToSpecFields,
  parseJobHeader,
} from "../../../shared/compute-header.js";

// --- Where the header lives ---------------------------------------------------------------------

/** The folder file's name: the whole file is a header. */
export const FOLDER_JOB_FILE = "nemar-job.toml";

/** The header kind a script's extension says, or null when its extension has no header comment. */
export function headerKindForFile(file: string): Exclude<HeaderKind, "toml"> | null {
  const ext = extname(file).toLowerCase();
  if (ext === ".py") return "python";
  if (ext === ".m") return "matlab";
  return null;
}

/** One sentence per parser error: what is wrong, never the text that is. */
export const HEADER_ERROR_SENTENCES: Readonly<Record<HeaderErrorCode, string>> = {
  unterminated_block: "the nemar block is never closed by a closing line",
  duplicate_block: "a second nemar block; a file has one",
  bad_line: "this line is not `key = value`",
  duplicate_key: "this key is written twice",
  unknown_key: `unknown key; the keys are ${HEADER_KEYS.join(", ")}`,
  unsupported_value: "this value is not one the header takes",
  bad_string: "this string is not closed, or holds an escape or a control character it may not",
  input_too_large: "the file is too large to read a header from",
};

/** `file:line: sentence` for each error, in line order. */
export function describeHeaderErrors(file: string, errors: readonly HeaderError[]): string[] {
  return [...errors]
    .sort((a, b) => a.line - b.line)
    .map((e) => `${file}:${e.line}: ${HEADER_ERROR_SENTENCES[e.code]}`);
}

export type HeaderRead =
  | { ok: true; found: boolean; fields: SpecFields }
  | { ok: false; problems: string[] };

/** Read at most this many bytes of a script: the parser's bound, so a larger script is read by its prefix. */
const SCRIPT_PREFIX_BYTES = HEADER_MAX_BYTES - 1024;

function readPrefix(path: string): string {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const length = Math.min(size, SCRIPT_PREFIX_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    let text = buffer.toString("utf8");
    // A prefix cut mid-line would otherwise read as a block that never closed.
    if (size > length) text = text.slice(0, text.lastIndexOf("\n") + 1);
    return text;
  } finally {
    closeSync(fd);
  }
}

/** The result of the parser, mapped onto specification fields, or the sentences naming `label`. */
export function fieldsFromHeaderText(text: string, kind: HeaderKind, label: string): HeaderRead {
  const parsed = parseJobHeader(text, kind);
  if (!parsed.ok) return { ok: false, problems: describeHeaderErrors(label, parsed.errors) };
  const mapped = headerToSpecFields(parsed.fields, parsed.lines);
  if (!mapped.ok) return { ok: false, problems: describeHeaderErrors(label, mapped.errors) };
  return { ok: true, found: parsed.found, fields: mapped.fields };
}

/** The header block of a script (`.py` or `.m`), read from `path`; `label` is how errors name the file. */
export function readScriptHeader(path: string, label: string): HeaderRead {
  const kind = headerKindForFile(path);
  if (kind === null) return { ok: true, found: false, fields: {} };
  let text: string;
  try {
    text = readPrefix(path);
  } catch {
    return { ok: false, problems: [`${label} cannot be read.`] };
  }
  return fieldsFromHeaderText(text, kind, label);
}

/** The folder's `nemar-job.toml`, if it has one: an absent file is `found: false`, never an error. */
export function readFolderHeader(dir: string): HeaderRead {
  const path = join(dir, FOLDER_JOB_FILE);
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return { ok: true, found: false, fields: {} };
  let text: string;
  try {
    text = readPrefix(path);
  } catch {
    return { ok: false, problems: [`${FOLDER_JOB_FILE} cannot be read.`] };
  }
  return fieldsFromHeaderText(text, "toml", FOLDER_JOB_FILE);
}

// --- The flags ------------------------------------------------------------------------------------

/** The flags that say what a job asks for, as Commander hands them over (strings; the lists are lists). */
export interface SpecFlags {
  name?: string;
  runtime?: string;
  entry?: string;
  dataset?: string[];
  partition?: string;
  nodes?: string;
  cores?: string;
  mem?: string;
  gpus?: string;
  time?: string;
  /** What followed `--`; absent when nothing did. */
  args?: string[];
}

export type FlagRead = { ok: true; fields: SpecFields } | { ok: false; problems: string[] };

const WHOLE_NUMBER_RE = /^[0-9]{1,9}$/;

/** The flags as specification fields, converting `--mem` and `--time` exactly as a header does. */
export function flagsToFields(flags: SpecFlags): FlagRead {
  const problems: string[] = [];
  const header: HeaderFields = {};
  const set = <K extends keyof HeaderFields>(key: K, value: HeaderFields[K]) => {
    header[key] = value;
  };
  if (flags.name !== undefined) set("name", flags.name);
  if (flags.runtime !== undefined) set("runtime", flags.runtime);
  if (flags.entry !== undefined) set("entry", flags.entry);
  if (flags.partition !== undefined) set("partition", flags.partition);
  if (flags.args !== undefined) set("args", flags.args);
  for (const [flag, key] of [
    ["nodes", "nodes"],
    ["cores", "cores"],
    ["gpus", "gpus"],
  ] as const) {
    const raw = flags[flag];
    if (raw === undefined) continue;
    if (!WHOLE_NUMBER_RE.test(raw)) {
      problems.push(`--${flag} is a whole number.`);
      continue;
    }
    set(key, Number(raw));
  }
  if (flags.mem !== undefined) set("memory", flags.mem);
  if (flags.time !== undefined) set("time", flags.time);
  if (flags.dataset !== undefined) set("datasets", flags.dataset);

  // One key at a time, so an error names the flag it came from and not a header line.
  const flagFor: Record<string, string> = {
    memory: "--mem",
    time: "--time",
    datasets: "--dataset",
    nodes: "--nodes",
    cores: "--cores",
    gpus: "--gpus",
  };
  const fields: SpecFields = {};
  for (const key of HEADER_KEYS) {
    if (header[key] === undefined) continue;
    const one = headerToSpecFields({ [key]: header[key] } as HeaderFields);
    if (!one.ok) {
      problems.push(
        key === "memory"
          ? "--mem is a size like 16G, 512M or 1T."
          : key === "time"
            ? "--time is a duration like 2h, 1h30m or 45m."
            : key === "datasets"
              ? "--dataset is a dataset id and version like nm000104@1.0.2."
              : `${flagFor[key] ?? `--${key}`} must be at least 1.`,
      );
      continue;
    }
    Object.assign(fields, one.fields);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, fields };
}

// --- The merge ------------------------------------------------------------------------------------

export type FieldSource = "flag" | "header" | "file" | "default";

export interface SpecSources {
  /** The command line. */
  flags: SpecFields;
  /** The `nemar` block inside the entry script. */
  header: SpecFields;
  /** The folder's `nemar-job.toml`. */
  file: SpecFields;
  /** What a job gets when nobody says: see {@link SPEC_DEFAULTS}. */
  defaults: SpecFields;
}

export interface MergedFields {
  fields: SpecFields;
  /** Which source each field came from, for `--dry-run` to say. */
  from: Partial<Record<keyof SpecFields, FieldSource>>;
}

/** What an unsaid field becomes. A job with no `time` runs for an hour at most. */
export const SPEC_DEFAULTS: Readonly<SpecFields> = Object.freeze({
  partition: "shared",
  nodes: 1,
  cores: 1,
  gpus: 0,
  minutes: 60,
});

/**
 * FLAGS, THEN HEADER, THEN FILE, THEN DEFAULTS, key by key. A list is replaced whole by the first source
 * that has it. This is the only place the order is written; a test lets a header win to show it fails.
 */
export function mergeSpecFields(sources: SpecSources): MergedFields {
  const order: ReadonlyArray<[FieldSource, SpecFields]> = [
    ["flag", sources.flags],
    ["header", sources.header],
    ["file", sources.file],
    ["default", sources.defaults],
  ];
  const fields: Record<string, unknown> = {};
  const from: Record<string, FieldSource> = {};
  const keys = new Set<string>();
  for (const [, source] of order) for (const key of Object.keys(source)) keys.add(key);
  for (const key of keys) {
    for (const [label, source] of order) {
      const value = (source as Record<string, unknown>)[key];
      if (value !== undefined) {
        fields[key] = value;
        from[key] = label;
        break;
      }
    }
  }
  return { fields: fields as SpecFields, from: from as MergedFields["from"] };
}

// --- The default name ----------------------------------------------------------------------------

const NAME_BAD_CHARS_RE = /[^A-Za-z0-9 ._-]+/g;

/**
 * A job name from a file name: the stem, with anything the specification's name pattern refuses turned
 * into `-`, starting with a letter or digit and at most 80 characters. `job` when nothing is left.
 */
export function defaultJobName(file: string): string {
  const stem = basename(file, extname(file)) || basename(file);
  const cleaned = stem.replace(NAME_BAD_CHARS_RE, "-").replace(/^[^A-Za-z0-9]+/, "");
  const name = cleaned.slice(0, 80).replace(/[ ._-]+$/, "");
  return name.length > 0 ? name : "job";
}
