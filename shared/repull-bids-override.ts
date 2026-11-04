/**
 * An administrator's merge of an upstream re-pull's pull request over a failed BIDS validation
 * (ADR 0111, the Phase 7g amendment, and the #1983 review amendment): what it rests on, read one
 * way wherever it is asked. The Worker's claim to merge (`bidsOverrideRefusal` in
 * `backend/src/services/upstream-repull-merge.ts`) reads GitHub with the Worker's credential;
 * `resume`'s gates and the merge gate (`src/lib/repull/resume.ts`, `src/lib/repull/merge.ts`) read
 * it with the administrator's own. Each asks this rule.
 *
 * THE FACTS ({@link bidsOverrideFault}), which every reader has:
 *  - the record is an administrator's: the automatic path never merges over a failed check, and its
 *    pull request is merged over one by no one;
 *  - the two checks were read (unknown is never a verdict);
 *  - GitHub reports the pull request `unstable`, a check that is not required failing: `blocked` is
 *    a rule that requires the check, where a merge would be a bypass, which a re-pull never uses;
 *    `clean` needs no override, and every other state is refused as the ordinary gate refuses it;
 *  - BIDS validation, the App's own latest run at the head, completed with `failure`, and
 *    `version-check`, the App's own latest run, completed with `success`.
 *
 * NOTHING ELSE FAILS ({@link othersNotPassing}), read by the two callers that read every check of
 * the head, so that BIDS validation is the one reason GitHub says `unstable`: every other check
 * run, taken as the latest run of each name and App, completed with a conclusion GitHub counts as
 * passing (`success`, `neutral`, `skipped`), and every commit status is `success`; one still running
 * is not passing yet. `resume` records the gates only on the whole rule ({@link bidsOnlyFault}),
 * since nothing reads the facts again at the gates; the merge gate reads this part and leaves the
 * facts to the claim that follows it. The Worker's claim reads only the App's two runs, so this part
 * is the administrator's gate's, as `clean` is for an ordinary merge.
 *
 * Pure: it reads nothing and writes nothing. The check names are `shared/dataset-checks.ts`'s.
 */

import { VERSION_CHECK_NAME, bidsCheckName } from "./dataset-checks.js";
import { NEMAR_APP_ID } from "./nemar-app.js";
import type { CheckFact } from "./repull-machine-clean.js";

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const posInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;

/** GitHub's check-run states before a run completes, which all wait. */
const NOT_STARTED = new Set(["queued", "waiting", "requested", "pending"]);

const UNREADABLE_CHECK: CheckFact = { status: "unreadable", conclusion: null };

/** One run of GitHub's list, its id, status and conclusion checked; the rest as GitHub sent it. */
interface RunRead {
  id: number;
  name: unknown;
  appId: unknown;
  headSha: unknown;
  status: string;
  conclusion: string | null;
}

/**
 * The runs of GitHub's answer to `GET .../commits/<sha>/check-runs`, or `unreadable` when it is not
 * of its shape or does not hold every run GitHub counts: a page past the first is never guessed at.
 */
function runsOf(body: unknown): RunRead[] | "unreadable" {
  if (!isObject(body)) return "unreadable";
  const { total_count: total, check_runs: runs } = body;
  if (typeof total !== "number" || !Array.isArray(runs) || total > runs.length) return "unreadable";
  const out: RunRead[] = [];
  for (const run of runs) {
    if (!isObject(run) || !isObject(run.app) || !posInt(run.id)) return "unreadable";
    if (typeof run.status !== "string") return "unreadable";
    if (run.conclusion !== null && typeof run.conclusion !== "string") return "unreadable";
    out.push({
      id: run.id,
      name: run.name,
      appId: run.app.id,
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
    });
  }
  return out;
}

/**
 * The App's latest run named `name` at `sha` in GitHub's answer to `GET .../commits/<sha>/check-runs`
 * (filtered by name and App, or not), or `absent`. A run of another name, another App or another
 * commit is not read, whatever GitHub returned, so a GitHub that ignored a filter still cannot pass
 * another App's run or a person's. Of the App's runs, the one with the highest id is the latest (a
 * re-run is a new run). An answer that is not of its shape, or a run whose state this does not
 * know, is `unreadable`: unknown is never read as absent or green.
 */
export function checkFactOf(body: unknown, name: string, sha: string): CheckFact {
  const runs = runsOf(body);
  if (runs === "unreadable") return UNREADABLE_CHECK;
  let latest: RunRead | null = null;
  for (const run of runs) {
    if (run.name !== name || run.appId !== NEMAR_APP_ID || run.headSha !== sha) continue;
    if (latest === null || run.id > latest.id) latest = run;
  }
  if (latest === null) return { status: "absent", conclusion: null };
  if (latest.status === "completed") return { status: "completed", conclusion: latest.conclusion };
  if (latest.status === "in_progress") return { status: "in_progress", conclusion: null };
  if (NOT_STARTED.has(latest.status)) return { status: "queued", conclusion: null };
  return UNREADABLE_CHECK;
}

/** Why a merge over a failed BIDS validation may not be made now, in the order the facts are read. */
export type BidsOverrideFault =
  | "automatic"
  | "unreadable"
  | "blocked"
  | "not-unstable"
  | "bids"
  | "version-check";

/**
 * The facts every reader has (see the module comment), in their order: null when they hold.
 * `origin` is the record's; `mergeableState` GitHub's, null when it has computed none; the two
 * checks are the App's own runs at the head, as {@link checkFactOf} reads them.
 */
export function bidsOverrideFault(f: {
  origin: string;
  mergeableState: string | null;
  bids: CheckFact;
  versionCheck: CheckFact;
}): BidsOverrideFault | null {
  if (f.origin !== "administrator") return "automatic";
  if (f.bids.status === "unreadable" || f.versionCheck.status === "unreadable") {
    return "unreadable";
  }
  if (f.mergeableState === "blocked") return "blocked";
  if (f.mergeableState !== "unstable") return "not-unstable";
  if (f.bids.status !== "completed" || f.bids.conclusion !== "failure") return "bids";
  if (f.versionCheck.status !== "completed" || f.versionCheck.conclusion !== "success") {
    return "version-check";
  }
  return null;
}

/** Conclusions GitHub counts as passing, for a check run that is not required. */
const PASSING = new Set(["success", "neutral", "skipped"]);

/** The statuses of GitHub's answer to `GET .../commits/<sha>/status`, or `unreadable`. */
function statusesOf(body: unknown): Array<{ context: string; state: string }> | "unreadable" {
  if (!isObject(body)) return "unreadable";
  const { total_count: total, statuses } = body;
  if (typeof total !== "number" || !Array.isArray(statuses) || total > statuses.length) {
    return "unreadable";
  }
  const out: Array<{ context: string; state: string }> = [];
  for (const s of statuses) {
    if (!isObject(s) || typeof s.context !== "string" || typeof s.state !== "string") {
      return "unreadable";
    }
    out.push({ context: s.context, state: s.state });
  }
  return out;
}

/** What a caller read of a head: GitHub's two answers, unfiltered. */
export interface HeadChecks {
  datasetId: string;
  sha: string;
  /** GitHub's answer to `GET .../commits/<sha>/check-runs`, with no name or App filter. */
  runs: unknown;
  /** GitHub's answer to `GET .../commits/<sha>/status`. */
  statuses: unknown;
}

/**
 * Everything at the head that is not passing beside the App's own BIDS validation and
 * `version-check` runs, which the facts read themselves: the names of the check runs (the latest of
 * each name and App) that did not complete with a passing conclusion, and the contexts of the
 * commit statuses that are not `success`, sorted. Empty when nothing else fails; `unreadable` when
 * either answer is not of its shape, does not hold everything GitHub counts, or names a run
 * without its name or App. The part of the rule the Worker's claim does not read, which the merge
 * gate reads before it claims.
 */
export function othersNotPassing(h: HeadChecks): string[] | "unreadable" {
  const runs = runsOf(h.runs);
  if (runs === "unreadable") return "unreadable";
  const bidsName = bidsCheckName(h.datasetId);
  const latest = new Map<string, RunRead & { name: string }>();
  for (const run of runs) {
    if (run.headSha !== h.sha) continue;
    if (typeof run.name !== "string" || !posInt(run.appId)) return "unreadable";
    const own =
      run.appId === NEMAR_APP_ID && (run.name === bidsName || run.name === VERSION_CHECK_NAME);
    if (own) continue;
    const key = `${run.appId}/${run.name}`;
    const seen = latest.get(key);
    if (seen === undefined || run.id > seen.id) latest.set(key, { ...run, name: run.name });
  }
  const failing: string[] = [];
  for (const run of latest.values()) {
    const passed =
      run.status === "completed" && run.conclusion !== null && PASSING.has(run.conclusion);
    if (!passed) failing.push(run.name);
  }
  const statuses = statusesOf(h.statuses);
  if (statuses === "unreadable") return "unreadable";
  for (const s of statuses) if (s.state !== "success") failing.push(s.context);
  return failing.sort();
}

/** Why a head is not BIDS validation's failure alone: a fact, or what else does not pass. */
export type BidsOnlyFault = { fault: BidsOverrideFault } | { fault: "others"; others: string[] };

/**
 * The whole rule, for a caller that read every check of the head (see the module comment): the
 * facts ({@link bidsOverrideFault}), read from the same unfiltered answer, then nothing else
 * failing ({@link othersNotPassing}). Null when the head fails BIDS validation and nothing else.
 */
export function bidsOnlyFault(
  f: HeadChecks & { origin: string; mergeableState: string | null },
): BidsOnlyFault | null {
  const fault = bidsOverrideFault({
    origin: f.origin,
    mergeableState: f.mergeableState,
    bids: checkFactOf(f.runs, bidsCheckName(f.datasetId), f.sha),
    versionCheck: checkFactOf(f.runs, VERSION_CHECK_NAME, f.sha),
  });
  if (fault !== null) return { fault };
  const others = othersNotPassing(f);
  if (others === "unreadable") return { fault: "unreadable" };
  return others.length > 0 ? { fault: "others", others } : null;
}
