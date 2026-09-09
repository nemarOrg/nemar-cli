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
 * verdict rather than one per row: if a read fails, the status is `unknown` and
 * the function returns BEFORE touching GitHub. It must never reach the reporting
 * step on a failed read, because the reporting step's healthy branch CLOSES the
 * issue -- and closing the coverage issue because the sweep could not see is
 * precisely the silent failure this phase exists to prevent. "I do not know" and
 * "everything is fine" have to be different answers all the way out to the exit
 * code.
 *
 * A read can fail WITHOUT THROWING, which is the harder half.
 * `discoverOpenNeuroDatasets` refuses a truncated scan, but its `MIN_COVERAGE`
 * guard counts raw edges: if OpenNeuro's snapshot resolver nulls
 * `summary.modalities` fleet-wide, every dataset falls out of the modality filter
 * and the scan returns an empty in-scope set with 100 percent coverage and no
 * error. That would have read as a fully drained backlog and closed a live alarm.
 * So the sweep applies a plausibility floor against its own input -- see
 * {@link implausibleScan}.
 *
 * ## Bounded
 *
 * One GraphQL scan, four D1 reads, and at most four GitHub calls (list, body
 * PATCH, labels, comment; three on the recovery path), plus whatever
 * `getDatasetsToken` needs to mint an installation token on a cold isolate. No
 * per-dataset work, so there is no limit to clamp and no window to rotate.
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
  COVERAGE_DISPATCH_LOST_HOURS,
  type CoverageReportFacts,
  type ImportCoverageBacklog,
  type ImportCoverageKind,
  type ImportCoverageStatus,
  type ImportCoverageVerdict,
  buildCoverageIssueBody,
  buildCoverageKindChangeComment,
  buildCoverageRecoveryComment,
  decideCoverageVerdict,
  dispatchPhrase,
  hoursSince,
  outstandingCount,
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

/** `import_jobs` rows keyed by upstream source id, for the partition. Exported so
 *  a test binds the real SQL rather than a copy (`.rules/testing.md`), like
 *  `IMPORTED_SOURCE_IDS_QUERY` and `ACTIVE_IMPORTS_QUERY` beside it. */
export const BACKLOG_JOBS_QUERY = "SELECT source_id, status, blocklisted FROM import_jobs";

/**
 * The last dispatch row, with the id it named.
 *
 * Predicate-identical to {@link AUTO_IMPORT_GATE_QUERY} and widened by one column:
 * the gate only needs the clock, this also needs to know WHICH dataset was picked,
 * so the hand-off can be cross-checked. A test asserts both queries select the
 * same row, because a drift between them would make the sweep and the importer
 * disagree about when the importer last moved.
 */
export const COVERAGE_LAST_DISPATCH_QUERY =
  "SELECT resource_id, timestamp FROM audit_log WHERE action = 'auto_import_dispatch' ORDER BY id DESC LIMIT 1";

/** What happened to the standing issue. `refreshed` is a body rewrite with no
 *  change of kind, i.e. the routine daily case; `relabelled` is a kind change. */
export type CoverageIssueAction = "created" | "refreshed" | "relabelled" | "closed";

export interface ImportCoverageSweepResult {
  /**
   * Whether `apply` was REQUESTED. Deliberately not a claim that anything was
   * written: an `unknown` verdict returns before touching GitHub, and a healthy
   * run with no open issue has nothing to do. `issue` is the only statement about
   * writes.
   */
  applied: boolean;
  status: ImportCoverageStatus;
  kind: ImportCoverageKind | null;
  reason: string;
  enabled: boolean;
  lastDispatchAt: string | null;
  dispatchAgeHours: number | null;
  /** The dataset the last dispatch row named, or null if there is none. */
  lastDispatchSourceId: string | null;
  /** The last dispatch named a dataset that still has no `import_jobs` row long
   *  after it should have: the hand-off is failing after the audit row is written. */
  dispatchLost: boolean;
  /** In-scope datasets the scan reported. */
  discovered: number;
  /** Already imported as a managed mirror. Also the plausibility floor's baseline. */
  imported: number;
  inFlight: number;
  terminal: number;
  backlog: ImportCoverageBacklog;
  issue: {
    /** null on a dry run that would CREATE, since no number exists yet. */
    number: number | null;
    action: CoverageIssueAction;
    /** Set when a state change landed but its comment did not -- the action still
     *  counts, exactly as in the phase 2 sweep. */
    commentError?: string;
    /** Set when the body rewrite landed but the label write did not. The body IS
     *  changed, so the action still counts; the next run sees a body and labels
     *  that disagree and relabels, which self-heals. */
    labelError?: string;
  } | null;
  /**
   * Which stage failed, because they mean different things: `discovery` and `d1`
   * invalidate the verdict entirely, `report` means the verdict is sound and only
   * the GitHub write failed, and `anomaly` is a data fault worth surfacing that
   * invalidates nothing.
   */
  errors: { stage: "discovery" | "d1" | "report" | "anomaly"; error: string }[];
}

/**
 * Injection seams for tests. Every real caller omits them.
 *
 * TRANSPORT only -- the OpenNeuro scan, the GitHub client calls and the token
 * fetch. The diff, the partition, the verdict, the SQL and every report body run
 * for real, so a test exercises the same code production does
 * (`.rules/testing.md`). `discover` is the whole scan rather than its `fetchImpl`,
 * matching `ImportIssueSweepDeps.verify` in phase 2; one test supplies the real
 * scan with `fetchImpl` pointed at a local server so the binding itself is pinned.
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

/**
 * Is this scan too small to be a view of OpenNeuro?
 *
 * Every dataset D1 has imported was in scope when it was imported, and OpenNeuro
 * does not un-publish at that scale, so a scan reporting fewer in-scope datasets
 * than we already mirror is a degraded read rather than a drained backlog. The
 * failure direction is deliberately `unknown`, not `alarm`: a false trigger costs
 * an operator a look, whereas trusting the number costs a closed alarm.
 *
 * `imported > 0` keeps it inert on an empty database, so a fresh deployment and
 * the test fixtures are unaffected.
 */
export function implausibleScan(discovered: number, imported: number): boolean {
  return imported > 0 && discovered < imported;
}

export async function runImportCoverageSweep(
  env: Bindings,
  opts: { apply?: boolean; now?: Date } = {},
  deps: ImportCoverageSweepDeps = {},
): Promise<ImportCoverageSweepResult> {
  const discover = deps.discover ?? discoverOpenNeuroDatasets;
  const apply = opts.apply === true;
  const now = opts.now ?? new Date();

  // Only the exact string counts, matching autoImportTick's own gate
  // (`env.AUTO_IMPORT_ENABLED !== "true"`, auto-import.ts). A misspelled value
  // reads as disabled there, so it must read as disabled here or the two would
  // disagree about whether the importer is running.
  const enabled = env.AUTO_IMPORT_ENABLED === "true";
  const enabledBindingPresent = env.AUTO_IMPORT_ENABLED !== undefined;

  const result: ImportCoverageSweepResult = {
    applied: apply,
    status: "unknown",
    kind: null,
    reason: "",
    enabled,
    lastDispatchAt: null,
    dispatchAgeHours: null,
    lastDispatchSourceId: null,
    dispatchLost: false,
    discovered: 0,
    imported: 0,
    inFlight: 0,
    terminal: 0,
    backlog: { neverAttempted: [], untracked: [], tracked: [], blocklisted: [] },
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
    result.imported = imported.size;

    // Before anything is concluded: is the scan even plausible? See implausibleScan.
    if (implausibleScan(discovered.length, imported.size)) {
      result.errors.push({
        stage: "discovery",
        error: `scan returned ${discovered.length} in-scope dataset(s) but D1 holds ${imported.size} imported one(s); refusing to read that as a drained backlog`,
      });
      result.reason =
        "OpenNeuro discovery returned an implausibly small in-scope set, so coverage could not be determined this run.";
      return result;
    }

    const { inFlight, terminal } = await getActiveImportSourceIds(env.DB);
    result.inFlight = inFlight.size;
    result.terminal = terminal.size;
    const diff = diffNewDatasets(discovered, imported, inFlight, terminal).map((d) => d.id);
    const jobs = await loadBacklogJobs(env);
    backlog = partitionBacklog(diff, jobs);

    const last = await env.DB.prepare(COVERAGE_LAST_DISPATCH_QUERY).first<{
      resource_id: string | null;
      timestamp: string;
    }>();
    result.lastDispatchAt = last?.timestamp ?? null;
    result.lastDispatchSourceId = last?.resource_id ?? null;

    const lastMs = result.lastDispatchAt === null ? null : parseSqliteUtc(result.lastDispatchAt);
    if (result.lastDispatchAt !== null && lastMs === null) {
      // The importer treats the same anomaly as console.error-worthy. For the
      // pipeline's own monitor a corrupt central signal must not pass silently --
      // but it does not invalidate the verdict, because null reads as stale, which
      // is the conservative direction.
      result.errors.push({
        stage: "anomaly",
        error: `last auto_import_dispatch timestamp is unparseable: ${JSON.stringify(result.lastDispatchAt)}`,
      });
    }
    result.dispatchAgeHours = hoursSince(lastMs, now.getTime());
    if (result.dispatchAgeHours !== null && result.dispatchAgeHours < 0) {
      result.errors.push({
        stage: "anomaly",
        error: `last auto_import_dispatch is dated ${-result.dispatchAgeHours}h in the future; treating it as unreadable rather than as fresh`,
      });
    }

    // The cross-check the timestamp alone cannot make: the audit row is written
    // BEFORE the GitHub hand-off, so a fresh row proves only that a dataset was
    // picked. If the dataset it names still has no import_jobs row well after the
    // onboard workflow would have created one, the hand-off is evaporating.
    //
    // It must ALSO still be a coverage gap. Requiring only "no import_jobs row"
    // fired for any picked id that is no longer in the diff at all -- withdrawn
    // upstream, or out of scope since -- and neither says anything about the
    // hand-off. Being in `neverAttempted` is the precise statement: we picked it,
    // nothing is tracking it, and it is still missing.
    result.dispatchLost =
      result.lastDispatchSourceId !== null &&
      result.dispatchAgeHours !== null &&
      result.dispatchAgeHours >= COVERAGE_DISPATCH_LOST_HOURS &&
      backlog.neverAttempted.includes(result.lastDispatchSourceId);
  } catch (err) {
    result.errors.push({ stage: "d1", error: errText(err) });
    result.reason = "D1 read failed, so coverage could not be determined this run.";
    return result;
  }
  result.backlog = backlog;

  const verdict = decideCoverageVerdict({
    enabled,
    enabledBindingPresent,
    dispatchAgeHours: result.dispatchAgeHours,
    dispatchLost: result.dispatchLost,
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

/**
 * The kind label(s) currently on the issue.
 *
 * Returns every match, not the first. An issue carrying two kind labels is a state
 * the round trip must not treat as settled: taking the first match could equal the
 * current kind, which would short-circuit to a body-only refresh and leave the
 * contradictory label in place forever.
 */
function kindsFromLabels(issue: GitHubIssue): ImportCoverageKind[] {
  const labels = new Set(issueLabelNames(issue));
  return (Object.entries(IMPORT_COVERAGE_KIND_LABELS) as [ImportCoverageKind, string][])
    .filter(([, label]) => labels.has(label))
    .map(([kind]) => kind);
}

/** The full label set the issue should carry for `kind`, preserving anything this
 *  module does not own -- `setIssueLabels` is a full replace. */
function labelsForKind(issue: GitHubIssue | null, kind: ImportCoverageKind): string[] {
  const owned = new Set<string>(Object.values(IMPORT_COVERAGE_KIND_LABELS));
  const kept = (issue ? issueLabelNames(issue) : []).filter((l) => !owned.has(l));
  return [...new Set([...kept, IMPORT_COVERAGE_ISSUE_LABEL, IMPORT_COVERAGE_KIND_LABELS[kind]])];
}

/**
 * Create, refresh or close the ONE standing coverage issue.
 *
 * Four rules. Two are inherited from phase 2, one CORRECTS it, and one came out of
 * review of this phase:
 *
 *   1. **The body is rewritten, not appended to** -- the opposite of phase 2's
 *      rollup body, which is written once and never rewritten (ADR 0050). The
 *      shapes differ because the content does: a rollup accumulates datasets, so a
 *      rewritten body would lose history, whereas coverage is a single current
 *      state whose numbers change daily. What both share is the rule underneath:
 *      never write a comment per run. Comments here are reserved for a change of
 *      `kind`.
 *   2. **The state change goes before its comment** (ADR 0050, inherited).
 *      `closeIssue` is idempotent and a closed issue leaves the candidate listing,
 *      so the worst case is a missing explanation rather than a permanent false
 *      claim repeated daily.
 *   3. **A DISABLED importer never closes the issue** (review of this phase).
 *      Recovery means the pipeline is working again, and a switched-off importer is
 *      not working. Without this gate, manually importing a few datasets drops the
 *      outstanding count below the threshold and the monitor deletes the only
 *      durable record that the importer is still off -- the incident, re-enacted by
 *      its own alarm.
 *   4. **An `unknown` verdict touches nothing** (inherited). Enforced by the
 *      caller returning early, and asserted again here so a future caller cannot
 *      lose it.
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

  const facts: CoverageReportFacts = {
    enabled: result.enabled,
    dispatchAgeHours: result.dispatchAgeHours,
    lastDispatchAt: result.lastDispatchAt,
    lastDispatchSourceId: result.lastDispatchSourceId,
    discovered: result.discovered,
    imported: result.imported,
    inFlight: result.inFlight,
    terminal: result.terminal,
    backlog: result.backlog,
  };
  const body = buildCoverageIssueBody({ verdict, facts, nowIso });

  if (verdict.status === "healthy") {
    if (!existing) return null;
    // Rule 3: a switched-off importer is not a recovery. Refresh the record and
    // leave it open, so the fact that it is off survives.
    if (!result.enabled) {
      if (!ctx.apply) return { number: existing.number, action: "refreshed" };
      await update(IMPORT_FAILURE_ISSUES_REPO, existing.number, { body }, pat);
      console.log(
        `[import-coverage] kept ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number} open: nothing accruing, but the importer is still off`,
      );
      return { number: existing.number, action: "refreshed" };
    }
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

  if (!existing) {
    if (!ctx.apply) return { number: null, action: "created" };
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

  const priorKinds = kindsFromLabels(existing);
  // Settled only when exactly one kind label is present and it is the current one.
  // Two labels, or none, is a state to correct rather than to trust.
  const settled = priorKinds.length === 1 && priorKinds[0] === kind;
  if (!ctx.apply) return { number: existing.number, action: settled ? "refreshed" : "relabelled" };

  // Body first: it is the authoritative statement of current state, and it is
  // idempotent, so a failure here leaves a stale body rather than a wrong one.
  await update(IMPORT_FAILURE_ISSUES_REPO, existing.number, { body }, pat);

  if (settled) {
    // Same problem as yesterday. The refreshed body is the whole update; a comment
    // here would be one notification per day forever.
    console.log(
      `[import-coverage] refreshed ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number} (${kind}, unchanged)`,
    );
    return { number: existing.number, action: "refreshed" };
  }

  if (priorKinds.length > 1) {
    console.warn(
      `[import-coverage] ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number} carried ${priorKinds.length} kind labels (${priorKinds.join(",")}); forcing the set to ${kind}`,
    );
  }

  // The body already landed, so this action counts even if the label write fails.
  // Reported rather than thrown for exactly that reason: throwing here would lose
  // the record of a write that happened, which is the rule phase 2 established for
  // its own comment step.
  const out: NonNullable<ImportCoverageSweepResult["issue"]> = {
    number: existing.number,
    action: "relabelled",
  };
  try {
    await setLabels(
      IMPORT_FAILURE_ISSUES_REPO,
      existing.number,
      labelsForKind(existing, kind),
      pat,
    );
  } catch (err) {
    out.labelError = errText(err);
    console.error(
      `[import-coverage] body updated on ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number} but its labels did not: ${out.labelError}`,
    );
    return out;
  }
  console.log(
    `[import-coverage] ${IMPORT_FAILURE_ISSUES_REPO}#${existing.number} kind ${priorKinds.join(",") || "none"} -> ${kind}`,
  );
  return {
    ...out,
    ...(await commentAfter(
      comment,
      existing.number,
      buildCoverageKindChangeComment(priorKinds[0] ?? null, kind, verdict.reason, nowIso),
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

/** One-line summary for the cron log. The CLI renders its own output from the HTTP
 *  response and does not call this. */
export function importCoverageSweepSummary(result: ImportCoverageSweepResult): string {
  const b = result.backlog;
  return (
    `status=${result.status}${result.kind ? ` kind=${result.kind}` : ""} ` +
    `enabled=${result.enabled} dispatch=${dispatchPhrase(result.dispatchAgeHours)} ` +
    `dispatch_lost=${result.dispatchLost} ` +
    `discovered=${result.discovered} imported=${result.imported} ` +
    `outstanding=${outstandingCount(b)} (never_attempted=${b.neverAttempted.length} untracked=${b.untracked.length}) ` +
    `tracked=${b.tracked.length} blocklisted=${b.blocklisted.length} ` +
    `issue=${result.issue ? `${result.issue.number === null ? "would" : `#${result.issue.number}`}:${result.issue.action}` : "none"} ` +
    `errors=${result.errors.length}`
  );
}
