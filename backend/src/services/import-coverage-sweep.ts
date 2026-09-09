/**
 * Import coverage sweep (epic #1306 phase 3, #1311).
 *
 * Diffs OpenNeuro against D1, reads how long it has been since the importer last
 * dispatched anything, and reports one standing issue when the pipeline has
 * stopped keeping up. The decisions and the report bodies are pure and live in
 * `import-coverage.ts`; this module is the bounded I/O around them.
 *
 * **This is the phase that would have caught the 2026-07-20 outage.** Everything
 * else in the epic improves how a failure is described. Nothing else notices that
 * nothing is happening.
 *
 * ## Fail open on the verdict, never into a false all-clear
 *
 * `runZarrFidelitySweep`'s rule, with a sharper edge because there is only one
 * verdict rather than one per row: if discovery or D1 throws, the status is
 * `unknown` and the function returns BEFORE touching GitHub. It must never reach
 * the reporting step on a failed read, because the reporting step's healthy branch
 * CLOSES the issue -- and closing the coverage issue because the sweep could not
 * see is precisely the silent failure this phase exists to prevent. "I do not
 * know" and "everything is fine" have to be different answers all the way out to
 * the exit code.
 *
 * ## Bounded
 *
 * One GraphQL scan (`discoverOpenNeuroDatasets`, itself page-capped and refusing
 * to truncate), three D1 reads, and at most three GitHub calls. No per-dataset
 * work, so there is no limit to clamp and no window to rotate.
 */

import type { Bindings } from "../types/bindings.js";
import { AUTO_IMPORT_GATE_QUERY, parseSqliteUtc } from "./auto-import.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import {
  type GitHubIssue,
  addIssueComment,
  closeIssue,
  createIssue,
  issueLabelNames,
  listOpenIssuesByLabel,
  setIssueLabels,
  updateIssue,
} from "./github.js";
import {
  type ImportCoverageBacklog,
  type ImportCoverageKind,
  type ImportCoverageStatus,
  type ImportCoverageVerdict,
  buildCoverageIssueBody,
  buildCoverageKindChangeComment,
  buildCoverageRecoveryComment,
  decideCoverageVerdict,
  hoursSince,
  partitionBacklog,
} from "./import-coverage.js";
import {
  IMPORT_COVERAGE_ISSUE_LABEL,
  IMPORT_COVERAGE_KIND_LABELS,
  IMPORT_FAILURE_ISSUES_REPO,
  importCoverageIssueTitle,
} from "./import-issue-identity.js";
import {
  type DiscoveredDataset,
  diffNewDatasets,
  discoverOpenNeuroDatasets,
  getActiveImportSourceIds,
  getImportedSourceIds,
} from "./openneuro-discovery.js";

/** `import_jobs` rows keyed by upstream source id, for the partition. */
const BACKLOG_JOBS_QUERY = "SELECT source_id, status, blocklisted FROM import_jobs";

export interface ImportCoverageSweepResult {
  /** False on a dry run: nothing was written to GitHub. */
  applied: boolean;
  status: ImportCoverageStatus;
  kind: ImportCoverageKind | null;
  reason: string;
  enabled: boolean;
  lastDispatchAt: string | null;
  dispatchAgeHours: number | null;
  /** In-scope datasets OpenNeuro reported this run. */
  discovered: number;
  backlog: ImportCoverageBacklog;
  /** What happened to the standing issue. `null` when nothing needed doing or the
   *  verdict was `unknown`. */
  issue: {
    number: number;
    action: "created" | "updated" | "closed" | "unchanged";
    /** Set when the state change landed but its comment did not -- the action
     *  still counts, exactly as in the phase 2 sweep. */
    commentError?: string;
  } | null;
  /**
   * Which stage failed, because they mean different things: `discovery` and `d1`
   * invalidate the verdict entirely, while `report` means the verdict is sound and
   * only the GitHub write failed.
   */
  errors: { stage: "discovery" | "d1" | "report"; error: string }[];
}

/**
 * Injection seams for tests. Every real caller omits them.
 *
 * TRANSPORT only -- the OpenNeuro scan, the GitHub client calls and the token
 * fetch. The diff, the partition, the verdict, the SQL and every report body run
 * for real, so a test exercises the same code production does
 * (`.rules/testing.md`).
 */
export interface ImportCoverageSweepDeps {
  discover?: typeof discoverOpenNeuroDatasets;
  listOpenIssues?: typeof listOpenIssuesByLabel;
  create?: typeof createIssue;
  update?: typeof updateIssue;
  comment?: typeof addIssueComment;
  setLabels?: typeof setIssueLabels;
  close?: typeof closeIssue;
  token?: (env: Bindings) => Promise<string>;
}

export async function runImportCoverageSweep(
  env: Bindings,
  opts: { apply?: boolean; now?: Date } = {},
  deps: ImportCoverageSweepDeps = {},
): Promise<ImportCoverageSweepResult> {
  const discover = deps.discover ?? discoverOpenNeuroDatasets;
  const apply = opts.apply === true;
  const now = opts.now ?? new Date();

  // Only the exact string counts, matching autoImportTick's own test. A
  // misspelled value reads as disabled there, so it must read as disabled here.
  const enabled = env.AUTO_IMPORT_ENABLED === "true";

  const result: ImportCoverageSweepResult = {
    applied: apply,
    status: "unknown",
    kind: null,
    reason: "",
    enabled,
    lastDispatchAt: null,
    dispatchAgeHours: null,
    discovered: 0,
    backlog: { neverAttempted: [], failedTracked: [], blocklisted: [] },
    issue: null,
    errors: [],
  };

  // ---- Read the world. Any failure here invalidates the verdict. ----
  let discovered: DiscoveredDataset[];
  try {
    discovered = await discover();
  } catch (err) {
    // Includes the deliberate refusals: the maxPages cap and the MIN_COVERAGE
    // truncation guard. A truncated scan would understate the backlog, so it is
    // right that it arrives here as "unknown" rather than as a smaller number.
    result.errors.push({ stage: "discovery", error: errText(err) });
    result.reason = "OpenNeuro discovery failed, so coverage could not be determined this run.";
    return result;
  }
  result.discovered = discovered.length;

  let backlog: ImportCoverageBacklog;
  try {
    const imported = await getImportedSourceIds(env.DB);
    const { inFlight, terminal } = await getActiveImportSourceIds(env.DB);
    const diff = diffNewDatasets(discovered, imported, inFlight, terminal).map((d) => d.id);
    backlog = partitionBacklog(diff, await loadBacklogJobs(env));

    // The SAME query the auto-import gate reads, so the sweep and the importer
    // can never disagree about when the last dispatch was.
    const last = await env.DB.prepare(AUTO_IMPORT_GATE_QUERY).first<{ timestamp: string }>();
    result.lastDispatchAt = last?.timestamp ?? null;
    // An unparseable stored timestamp lands as null, i.e. "never" -- which is the
    // conservative direction here: with a backlog it reads as stale and alarms,
    // rather than being silently treated as recent.
    const lastMs = result.lastDispatchAt === null ? null : parseSqliteUtc(result.lastDispatchAt);
    result.dispatchAgeHours = hoursSince(lastMs, now.getTime());
  } catch (err) {
    result.errors.push({ stage: "d1", error: errText(err) });
    result.reason = "D1 read failed, so coverage could not be determined this run.";
    return result;
  }
  result.backlog = backlog;

  const verdict = decideCoverageVerdict({
    enabled,
    dispatchAgeHours: result.dispatchAgeHours,
    backlog,
  });
  result.status = verdict.status;
  result.kind = verdict.kind;
  result.reason = verdict.reason;

  // ---- Report. The verdict is already final; a failure here does not change it. ----
  try {
    result.issue = await reportCoverage(env, result, verdict, { apply, now }, deps);
  } catch (err) {
    result.errors.push({ stage: "report", error: errText(err) });
  }

  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `import_jobs` state for the partition. Throws on a null `results` for the same
 *  reason `getImportedSourceIds` does: an empty map would misreport every tracked
 *  failure as never-attempted, i.e. would INVENT a backlog. */
async function loadBacklogJobs(
  env: Bindings,
): Promise<Map<string, { status: string; blocklisted: boolean }>> {
  const rows = await env.DB.prepare(BACKLOG_JOBS_QUERY).all<{
    source_id: string;
    status: string;
    blocklisted: number | null;
  }>();
  if (!rows.results) {
    throw new Error("loadBacklogJobs: D1 returned null results");
  }
  const out = new Map<string, { status: string; blocklisted: boolean }>();
  for (const r of rows.results) {
    out.set(r.source_id, { status: r.status, blocklisted: r.blocklisted === 1 });
  }
  return out;
}

/** The kind label currently on the issue, or null when it carries none. */
function kindFromLabels(issue: GitHubIssue): ImportCoverageKind | null {
  const labels = new Set(issueLabelNames(issue));
  for (const [kind, label] of Object.entries(IMPORT_COVERAGE_KIND_LABELS)) {
    if (labels.has(label)) return kind as ImportCoverageKind;
  }
  return null;
}

/** The full label set the issue should carry for `kind`, preserving anything this
 *  module does not own -- `setIssueLabels` is a full replace. */
function labelsForKind(issue: GitHubIssue | null, kind: ImportCoverageKind): string[] {
  const owned = new Set<string>(Object.values(IMPORT_COVERAGE_KIND_LABELS));
  const kept = (issue ? issueLabelNames(issue) : []).filter((l) => !owned.has(l));
  return [...new Set([...kept, IMPORT_COVERAGE_ISSUE_LABEL, IMPORT_COVERAGE_KIND_LABELS[kind]])];
}

/**
 * Create, update or close the ONE standing coverage issue.
 *
 * Three rules carried over from phase 2, each earned there:
 *
 *   1. **The body is rewritten, not appended to.** A comment per run is the
 *      unbounded accrual this epic exists to stop, and coverage numbers change
 *      every day. Comments are reserved for a change of `kind`.
 *   2. **The state change goes before its comment** (ADR 0050). `closeIssue` is
 *      idempotent and a closed issue leaves the candidate listing, so the worst
 *      case is a missing explanation rather than a permanent false claim repeated
 *      daily.
 *   3. **An `unknown` verdict touches nothing.** Enforced by the caller returning
 *      early, and asserted again here so a future caller cannot lose it.
 */
async function reportCoverage(
  env: Bindings,
  result: ImportCoverageSweepResult,
  verdict: ImportCoverageVerdict,
  ctx: { apply: boolean; now: Date },
  deps: ImportCoverageSweepDeps,
): Promise<ImportCoverageSweepResult["issue"]> {
  if (verdict.status === "unknown") {
    throw new Error("reportCoverage called with an unknown verdict; the caller must return first");
  }

  const listOpenIssues = deps.listOpenIssues ?? listOpenIssuesByLabel;
  const create = deps.create ?? createIssue;
  const update = deps.update ?? updateIssue;
  const comment = deps.comment ?? addIssueComment;
  const setLabels = deps.setLabels ?? setIssueLabels;
  const close = deps.close ?? closeIssue;
  const token = deps.token ?? getDatasetsToken;

  const pat = await token(env);
  const title = importCoverageIssueTitle();
  const open = await listOpenIssues(IMPORT_FAILURE_ISSUES_REPO, IMPORT_COVERAGE_ISSUE_LABEL, pat);
  const existing = open.find((i) => i.title === title) ?? null;
  const nowIso = ctx.now.toISOString();

  if (verdict.status === "healthy") {
    if (!existing) return null;
    if (!ctx.apply) return { number: existing.number, action: "closed" };
    await close(IMPORT_FAILURE_ISSUES_REPO, existing.number, pat);
    console.log(`[import-coverage] closed ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number}`);
    return {
      number: existing.number,
      action: "closed",
      ...(await commentAfter(
        comment,
        existing.number,
        buildCoverageRecoveryComment(verdict, nowIso),
        pat,
      )),
    };
  }

  // Alarm from here on, so `kind` is set.
  const kind = verdict.kind;
  if (!kind) throw new Error("alarm verdict with no kind");

  const body = buildCoverageIssueBody({
    verdict,
    enabled: result.enabled,
    dispatchAgeHours: result.dispatchAgeHours,
    lastDispatchAt: result.lastDispatchAt,
    discovered: result.discovered,
    backlog: result.backlog,
    nowIso,
  });

  if (!existing) {
    if (!ctx.apply) return { number: 0, action: "created" };
    const created = await create(
      IMPORT_FAILURE_ISSUES_REPO,
      title,
      body,
      labelsForKind(null, kind),
      pat,
    );
    console.log(
      `[import-coverage] filed ${IMPORT_FAILURE_ISSUES_REPO}#${created.number} (${kind})`,
    );
    return { number: created.number, action: "created" };
  }

  const previousKind = kindFromLabels(existing);
  if (!ctx.apply) return { number: existing.number, action: "updated" };

  // Body first: it is the authoritative statement of current state, and it is
  // idempotent, so a failure here leaves a stale body rather than a wrong one.
  await update(IMPORT_FAILURE_ISSUES_REPO, existing.number, { body }, pat);

  if (previousKind === kind) {
    // Same problem as yesterday. The refreshed body is the whole update; a
    // comment here would be one notification per day forever.
    console.log(
      `[import-coverage] refreshed ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number} (${kind}, unchanged)`,
    );
    return { number: existing.number, action: "updated" };
  }

  await setLabels(IMPORT_FAILURE_ISSUES_REPO, existing.number, labelsForKind(existing, kind), pat);
  console.log(
    `[import-coverage] ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number} kind ${previousKind ?? "none"} -> ${kind}`,
  );
  return {
    number: existing.number,
    action: "updated",
    ...(await commentAfter(
      comment,
      existing.number,
      buildCoverageKindChangeComment(previousKind, kind, verdict.reason, nowIso),
      pat,
    )),
  };
}

/** Write the explanation for a state change that already landed. Reported, never
 *  thrown: throwing would un-count an action that really happened. */
async function commentAfter(
  comment: typeof addIssueComment,
  issueNumber: number,
  body: string,
  pat: string,
): Promise<{ commentError?: string }> {
  try {
    await comment(IMPORT_FAILURE_ISSUES_REPO, issueNumber, body, pat);
    return {};
  } catch (err) {
    const msg = errText(err);
    console.error(
      `[import-coverage] state change landed on ${IMPORT_FAILURE_ISSUES_REPO}#${issueNumber} but its comment did not: ${msg}`,
    );
    return { commentError: msg };
  }
}

/**
 * The cron's entry point: apply the changes, and refuse outside production.
 *
 * Same split as `runImportIssueSweepCron`. The raw sweep stays unguarded so the
 * admin route can dry-run it anywhere; this wrapper carries both the `apply` and
 * the environment guard, because `IMPORT_FAILURE_ISSUES_REPO` is hardcoded and
 * `nemarDatasets` is shared with production -- a dev worker applying here would
 * file or close a real issue. The route carries its own guard too.
 *
 * `deps` is threaded through so a test can assert the guard in BOTH directions;
 * without it the production half is unreachable, and a guard whose polarity is
 * inverted would silently return the pipeline to reporting nothing, which is the
 * exact regression this phase exists to prevent.
 */
export async function runImportCoverageSweepCron(
  env: Bindings,
  deps: ImportCoverageSweepDeps = {},
): Promise<ImportCoverageSweepResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[import-coverage] skipped (non-production)");
    return null;
  }
  return runImportCoverageSweep(env, { apply: true }, deps);
}

/** One-line summary for the CLI and the cron log. */
export function importCoverageSweepSummary(result: ImportCoverageSweepResult): string {
  const b = result.backlog;
  return (
    `status=${result.status}${result.kind ? ` kind=${result.kind}` : ""} ` +
    `enabled=${result.enabled} dispatch_age_h=${result.dispatchAgeHours ?? "never"} ` +
    `discovered=${result.discovered} never_attempted=${b.neverAttempted.length} ` +
    `failed_tracked=${b.failedTracked.length} blocklisted=${b.blocklisted.length} ` +
    `issue=${result.issue ? `#${result.issue.number}:${result.issue.action}` : "none"} ` +
    `errors=${result.errors.length}`
  );
}
