/**
 * The wire shapes of the Neurobagel artifact store's admin routes (epic #1586, phase 4;
 * ADR 0084): `POST /admin/neurobagel/regenerate` and `GET /admin/neurobagel/status`.
 *
 * Types and two numbers only, with no imports, so the Worker that produces these answers
 * and the CLI that prints them read ONE definition and cannot drift: a field the writer
 * adds is a type error in the CLI the same day, not a blank in its output.
 */

/**
 * The most datasets one regenerate call, or one run of the writer, will examine, whatever
 * is asked for. A call runs inline in a single request, so this is a request budget (see
 * ADR 0084, "What a run costs"), not a convenience: a first backfill is several calls.
 */
export const NEUROBAGEL_REGENERATE_MAX = 50;

/** Datasets a daily reconcile examines when `NEUROBAGEL_RECONCILE_MAX` is not set. */
export const NEUROBAGEL_RECONCILE_DEFAULT = 10;

/** What became of one dataset in a run of the writer. */
export type NeurobagelDatasetResult =
  | { id: string; outcome: "unchanged" }
  | { id: string; outcome: "would_write"; reason: string }
  | { id: string; outcome: "written"; fingerprint: string; flags: string[]; wrote: string[] }
  | { id: string; outcome: "refused"; code: string; detail?: string }
  | { id: string; outcome: "error"; error: string }
  | { id: string; outcome: "would_remove" | "removed" };

/** The body of `POST /admin/neurobagel/regenerate`. Omitting `execute` is a dry run. */
export interface NeurobagelRegenerateRequest {
  execute?: boolean;
  /** At most {@link NEUROBAGEL_REGENERATE_MAX} ids. */
  datasets?: string[];
  /** A whole number from 1 to {@link NEUROBAGEL_REGENERATE_MAX}. */
  limit?: number;
  force?: boolean;
}

/** Why a run stopped examining before it had examined everything it planned to. */
export type NeurobagelStopReason =
  /** The run's budget of operations was spent (D1, R2 and HTTP calls); run it again. */
  | "ops_budget"
  /** The index could not be patched after a dataset, so nothing more was written. */
  | "index_patch";

export interface NeurobagelRunResult {
  trigger: string;
  dry_run: boolean;
  status: "ok" | "disabled" | "store_unconfigured" | "error";
  writer_enabled: boolean;
  error?: string;
  /** The catalog's count, null for a run scoped to named datasets (not read, so not zero). */
  eligible: number | null;
  examined: number;
  limit: number;
  /** Work found but not done this run: left for the next one. */
  unexamined: number;
  /** Set when the run stopped early; null when it did everything it planned. */
  stopped: NeurobagelStopReason | null;
  /**
   * Operations this run spent against its budget, and the part of it held back for the
   * closing steps (it grows with the store). HTTP is the writer's own calls plus an estimate
   * for the data plane's.
   */
  ops: {
    spent: number;
    budget: number;
    reserved: number;
    /** Spent when the examination loop ended, before the closing steps. A run that stopped on its budget has `loop + reserved <= budget`. */
    loop: number;
    d1: number;
    r2: number;
    http: number;
  };
  results: NeurobagelDatasetResult[];
  removed: string[];
  removals_pending: number;
  index: {
    changed: boolean;
    written: boolean;
    /** Entries put into the index right after their artifacts, one per dataset written. */
    patched?: number;
    entries: number | null;
    contended?: boolean;
    problems?: string[];
    skipped_incomplete?: string[];
  };
  /** Datasets refused because their data does not say `anonymous: false`. A count, never ids. */
  anonymity_findings: number;
  needs_review: { id: string; flags: string[] }[];
  warnings: string[];
}

export interface NeurobagelRunSummary {
  at: string;
  trigger: string;
  summary: Record<string, unknown>;
}

/** `GET /admin/neurobagel/status`. A null count is unknown, never zero. */
export interface NeurobagelStatus {
  environment: string | null;
  writer: { mode: "enabled" | "disabled" | "store_unconfigured" };
  /** Booleans only: the secret is never read back. */
  read_route: { token_configured: boolean };
  limits: { reconcile_max: number; hard_max: number };
  counts: {
    eligible: number | null;
    written: number | null;
    missing: number | null;
    stale: number | null;
    incomplete: number | null;
    /** In the store but no longer eligible: waiting to be deleted. */
    residue: number | null;
  };
  store: {
    configured: boolean;
    objects: number | null;
    unexpected_objects: number | null;
    total_bytes: number | null;
    over_loader_cap: boolean | null;
  };
  index: {
    present: boolean | null;
    generated_at: string | null;
    entries: number | null;
    matches_store: boolean | null;
  };
  last_run: NeurobagelRunSummary | null;
  last_reconcile: NeurobagelRunSummary | null;
  needs_review: {
    id: string;
    source: "report" | "refusal";
    flags?: string[];
    code?: string;
    /** A refusal only: when it was last confirmed (it is re-recorded once a day while it stands). */
    since?: string;
  }[];
  /** A count, never an identifier. */
  anonymity_findings: number | null;
  /**
   * The latest verification sweep's verdicts (epic #1586, phase 6; ADR 0067's amendment).
   * Null means NO run has been recorded, which is unknown: it is never read as healthy.
   */
  verification: NeurobagelVerification | null;
  warnings: string[];
}

/**
 * One check's verdict (ADR 0053, ADR 0054). `unchecked` means the check is not configured
 * here (no node URL, no federation URL, no store): it is shown as such and is never healthy.
 * `unknown` means the check was configured and could not be answered: never zero, never healthy.
 */
export type NeurobagelVerdict = "healthy" | "alarm" | "unknown" | "unchecked";

/** The verification sweep's four checks, in the order they are reported. */
export const NEUROBAGEL_CHECKS = ["store", "node", "registration", "drift"] as const;
export type NeurobagelCheckName = (typeof NEUROBAGEL_CHECKS)[number];

export interface NeurobagelCheckResult {
  verdict: NeurobagelVerdict;
  /** One sentence. Counts and public upstream tags only: never a dataset id, never participant data. */
  reason: string;
  /** Named counts; a null is unknown, never zero. */
  counts: Record<string, number | null>;
}

/** What one run of the verification sweep concluded. It reports and never repairs. */
export interface NeurobagelVerification {
  /** UTC, ISO 8601. */
  at: string;
  /** `cron` (the daily run) or `admin` (on demand). */
  trigger: string;
  /** True when the sweep itself threw: every check is then `unknown` and `error` says why. */
  failed: boolean;
  error?: string;
  /**
   * The worst verdict among the checks that ran (alarm, then unknown, then healthy), or
   * `unchecked` when none ran. A healthy overall with an unchecked check is a statement
   * about the checks that ran only; read `checks`.
   */
  overall: NeurobagelVerdict;
  checks: Record<NeurobagelCheckName, NeurobagelCheckResult>;
  warnings: string[];
}

/** `POST /admin/neurobagel/verify`: a run, recorded like the daily one, whose heartbeat may not have been written. */
export interface NeurobagelVerifyResult extends NeurobagelVerification {
  heartbeat_written: boolean;
}
