/**
 * BIDS entity filter translator.
 *
 * Converts user-friendly --subjects/--tasks/--runs/--datatypes/--include/
 * --exclude flags on `nemar dataset download` into git-annex matching
 * arguments (--include / --exclude / --or / -( / -)).
 *
 * Each entity group is OR'd internally (e.g. --subjects sub-01,sub-02 ⇒
 * "sub-01 OR sub-02"). Distinct groups are AND'd together by git-annex's
 * default combining (subjects ∩ tasks ∩ runs ∩ datatypes).
 *
 * Why pass through to git-annex instead of parsing BIDS in JS: git-annex
 * already implements glob matching efficiently. The translator just emits
 * the right flags.
 */

export interface BidsFilterOptions {
  /** Comma-separated subjects, e.g. "sub-01,02". Bare values are auto-prefixed. */
  subjects?: string;
  /** Comma-separated sessions, e.g. "ses-pre,post". */
  sessions?: string;
  /** Comma-separated tasks, e.g. "rest,nback". Strip "task-" prefix if present. */
  tasks?: string;
  /** Comma-separated runs, e.g. "1,2". Unpadded values 1-9 expand to both forms. */
  runs?: string;
  /** Comma-separated BIDS datatypes, e.g. "eeg,emg,func". */
  datatypes?: string;
  /** Comma-separated raw glob patterns to include (pass-through). */
  include?: string;
  /** Comma-separated raw glob patterns to exclude (pass-through). */
  exclude?: string;
  /**
   * When true, append excludes for `stimuli/**` and `**\/stimuli/**` so large
   * stimulus files are skipped. Pointer files are still cloned by git, so
   * users can fetch later. Default false (no extra excludes).
   */
  excludeStimuli?: boolean;
  /**
   * When true, append excludes for `derivatives/**` and `**\/derivatives/**`
   * so processed outputs are skipped. Default false (no extra excludes).
   */
  excludeDerivatives?: boolean;
}

export interface BidsFilterResult {
  /** git-annex matching args to insert before path arguments. */
  args: string[];
  /**
   * True if the user specified a positive filter (subjects/tasks/include/etc.)
   * or a user-provided --exclude. Default stimuli/derivatives excludes do NOT
   * set this; callers use it to detect conflicts with --no-data.
   */
  active: boolean;
  /** Human-readable summary lines for the download plan. */
  summary: string[];
}

/** Glob patterns matched against git-annex paths (relative to dataset root). */
const STIMULI_EXCLUDE_PATTERNS = ["stimuli/**", "**/stimuli/**"];
const DERIVATIVES_EXCLUDE_PATTERNS = ["derivatives/**", "**/derivatives/**"];

/**
 * Strip a known prefix from an entity value if present, then re-add it.
 * Lets users write either "sub-01" or "01" interchangeably.
 */
function normalizeEntity(value: string, prefix: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const stripped = trimmed.startsWith(`${prefix}-`) ? trimmed.slice(prefix.length + 1) : trimmed;
  return `${prefix}-${stripped}`;
}

/**
 * Expand a single run value into the canonical forms that should match.
 * Single-digit unpadded values (1..9) expand to both unpadded and 2-digit
 * zero-padded forms so `--runs 1` matches both `run-1` and `run-01`.
 */
function expandRunValue(value: string): string[] {
  const trimmed = value.trim().replace(/^run-/, "");
  if (!trimmed) return [];
  if (/^[1-9]$/.test(trimmed)) return [trimmed, `0${trimmed}`];
  return [trimmed];
}

/**
 * Strip a leading "<prefix>-" from a task/run-style value but do NOT add it back.
 * Used when the prefix is part of the surrounding glob template (e.g.
 * `*_task-${t}_*`).
 */
function stripEntityPrefix(value: string, prefix: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith(`${prefix}-`) ? trimmed.slice(prefix.length + 1) : trimmed;
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a git-annex matching group: a single --include or an OR-joined
 * group wrapped in `-(` / `-)`.
 */
function buildIncludeGroup(patterns: string[]): string[] {
  const unique = Array.from(new Set(patterns)).filter(Boolean);
  if (unique.length === 0) return [];
  if (unique.length === 1) return ["--include", unique[0]];
  const out: string[] = ["-("];
  for (let i = 0; i < unique.length; i++) {
    if (i > 0) out.push("--or");
    out.push("--include", unique[i]);
  }
  out.push("-)");
  return out;
}

/**
 * Translate BIDS filter options into git-annex matching args.
 */
export function buildBidsFilterArgs(opts: BidsFilterOptions): BidsFilterResult {
  const groups: string[][] = [];
  const summary: string[] = [];

  const subjects = splitCsv(opts.subjects).map((v) => normalizeEntity(v, "sub"));
  if (subjects.length > 0) {
    groups.push(subjects.map((s) => `${s}/**`));
    summary.push(`subjects: ${subjects.join(", ")}`);
  }

  const sessions = splitCsv(opts.sessions).map((v) => normalizeEntity(v, "ses"));
  if (sessions.length > 0) {
    groups.push(sessions.map((s) => `**/${s}/**`));
    summary.push(`sessions: ${sessions.join(", ")}`);
  }

  const tasks = splitCsv(opts.tasks).map((v) => stripEntityPrefix(v, "task"));
  if (tasks.length > 0) {
    groups.push(tasks.map((t) => `**/*_task-${t}_*`));
    summary.push(`tasks: ${tasks.join(", ")}`);
  }

  const runs = splitCsv(opts.runs).flatMap(expandRunValue);
  if (runs.length > 0) {
    groups.push(runs.map((r) => `**/*_run-${r}_*`));
    summary.push(`runs: ${runs.join(", ")}`);
  }

  const datatypes = splitCsv(opts.datatypes);
  if (datatypes.length > 0) {
    groups.push(datatypes.map((d) => `**/${d}/**`));
    summary.push(`datatypes: ${datatypes.join(", ")}`);
  }

  const includes = splitCsv(opts.include);
  if (includes.length > 0) {
    groups.push(includes);
    summary.push(`include: ${includes.join(", ")}`);
  }

  const userExcludes = splitCsv(opts.exclude);
  const active = groups.length > 0 || userExcludes.length > 0;

  // Optional default-skip for stimuli/derivatives. These excludes do NOT count
  // toward `active` so callers can apply them without triggering the
  // "filter present" semantics (e.g. the --no-data conflict check).
  const defaultExcludes: string[] = [];
  if (opts.excludeStimuli) {
    defaultExcludes.push(...STIMULI_EXCLUDE_PATTERNS);
    summary.push("skipping stimuli/ (use --stimuli to include)");
  }
  if (opts.excludeDerivatives) {
    defaultExcludes.push(...DERIVATIVES_EXCLUDE_PATTERNS);
    summary.push("skipping derivatives/ (use --derivatives to include)");
  }

  const args: string[] = [];
  for (const group of groups) {
    args.push(...buildIncludeGroup(group));
  }
  for (const exc of defaultExcludes) {
    args.push("--exclude", exc);
  }
  for (const exc of userExcludes) {
    args.push("--exclude", exc);
  }
  if (userExcludes.length > 0) {
    summary.push(`exclude: ${userExcludes.join(", ")}`);
  }

  return { args, active, summary };
}
