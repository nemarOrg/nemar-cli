/**
 * Machine clean: when the Worker may take an automatic re-pull pull request on toward its merge
 * (epic #1046 phase 7, #1913; ADR 0111, decision 7, as its Phase 7 amendment builds it).
 *
 * This is the rule and nothing else: a pure function of facts the Worker read at decision time
 * (`backend/src/services/upstream-repull-facts.ts` reads them, from GitHub and from the record). It
 * never reads, never writes and keeps nothing between calls, so a review pass an administrator
 * reset, a screen run again or a head that moved is seen by the next call, and one stage's reading
 * is never carried to the next: the gates and the merge each gather their own facts.
 *
 * The rules are checked in one fixed order and the first that fails is the answer, as a hold word
 * (`REPULL_HOLD_REASONS`). Unknown is never clean (ADR 0053, ADR 0054): every fact has a value for
 * "could not be read" or "is not there", and each of those holds.
 *
 *  1. Production exactly, the open switch, and at the merge stage the merge switch.
 *  2. A record the automatic path made (`origin` automatic, an `on` dataset): a pull request an
 *     administrator opened is never merged by the Worker, and an `xx` re-pull takes the
 *     administrator's path only.
 *  3. No correction: no N.0.1, and the plan's unexplained, conflict and correction counts each
 *     stated and zero, because a count left out is not zero.
 *  4. The dataset is named (anonymous exactly 0; unknown holds as anonymous), not withdrawn, has no
 *     import preparing, copying or finalizing, and is still the mirror the record names.
 *  5. The pull request is the recorded one, read from GitHub: open and unmerged, its number, the
 *     recorded release branch into `main`, from the dataset's own repository (a fork is refused),
 *     not a draft, and opened by the NEMAR App (its login, numeric id and type all match).
 *  6. Its head is the head the stage is about: the recorded head at the gates, and at the merge the
 *     screened head the gates recorded, which must also still be the recorded head.
 *  7. `main` is the commit the record bases on, exactly.
 *  8. BIDS validation and `version-check`, each the App's own check run by name at that head,
 *     completed with `success`. `neutral` and `skipped`, which GitHub counts as passing, are not
 *     green here, and a check another App or a person posted is not read at all.
 *  9. The identifier screen bound to the record says `clear` for that head: never `acknowledge`,
 *     which needs a person and is never machine clean even once a person gave it, never
 *     `unchecked` and never "run it again".
 * 10. An ADR 0107 review is stored for that head and its verdict is `pass`, read as the stricter of
 *     the stored verdict and the one its stored report re-derives.
 * 11. GitHub reports the pull request `clean`; `unknown`, null and every other state wait.
 *
 * The daily merge cap is not a fact read here: it is claimed by the statement that records the
 * claim to merge (ADR 0111, the Phase 6e amendment), atomically with the claim, so a reading taken
 * before it could only be stale. The merge itself, sent with the screened head, is the last check.
 *
 * Imports nothing but the shared constants and types, so it runs the same in the Worker and in a
 * test.
 */

import {
  NEMAR_APP_BOT_LOGIN,
  NEMAR_APP_BOT_TYPE,
  NEMAR_APP_BOT_USER_ID,
  NEMAR_DATASETS_ORG,
} from "./nemar-app.js";
import type { HoldReason, RepullRow } from "./repull-state.js";

/** The two moments the rule is asked: before the gates are recorded, and before the merge. */
export const MACHINE_CLEAN_STAGES = ["gates", "merge"] as const;
export type MachineCleanStage = (typeof MACHINE_CLEAN_STAGES)[number];

/**
 * One check run as read: `absent` when the App posted none of that name at that head, `queued`
 * for every state before it starts (queued, waiting, requested, pending), `unreadable` when GitHub
 * could not be read or answered with something this does not recognize.
 */
export interface CheckFact {
  status: "completed" | "in_progress" | "queued" | "absent" | "unreadable";
  /** GitHub's conclusion of a completed run; null otherwise. */
  conclusion: string | null;
}

/**
 * The identifier screen of the head, as read from the record (`upstream_repull_screens`):
 * `clear`, `acknowledge`, `blocks` and `unchecked` are verdicts, `pending` a run still out,
 * `unreported` one past its deadline, `error` a run with no verdict, `rerun` a commit that needs
 * screening again, `absent` no screen of that head, `exempt` an `xx` dataset, and `unreadable` a
 * record that could not be read or whose stored verdict does not name the head.
 */
export type ScreenFact =
  | "clear"
  | "acknowledge"
  | "blocks"
  | "unchecked"
  | "rerun"
  | "pending"
  | "unreported"
  | "error"
  | "exempt"
  | "absent"
  | "unreadable";

/**
 * The ADR 0107 review of the head, as read from `pr_reviews`: a verdict (`pass`, `fail`,
 * `uncertain`), a review still `running`, one that ended without a verdict (`error`, `declined`,
 * `unreported`), `exempt` (a pull request nobody reviews), `absent` (no review of that head) or
 * `unreadable`.
 */
export type ReviewFact =
  | "pass"
  | "fail"
  | "uncertain"
  | "running"
  | "error"
  | "declined"
  | "unreported"
  | "exempt"
  | "absent"
  | "unreadable";

/** The pull request as GitHub's REST record of it says. */
export interface PullRequestFact {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  number: number;
  authorLogin: string;
  authorId: number;
  authorType: string;
  headRef: string;
  headSha: string;
  /** The head repository's `owner/name`, or null when GitHub names none (a deleted fork). */
  headRepo: string | null;
  baseRepo: string;
  baseRef: string;
  /** GitHub's `mergeable_state`, or null when it has not computed one. */
  mergeableState: string | null;
}

/** The dataset row and its import, as read. `anonymous` is null when the row could not be read. */
export interface DatasetFact {
  anonymous: number | null;
  withdrawn: boolean;
  importInFlight: boolean;
  /** Still recorded as a mirror of the `ds` the re-pull names. */
  mirror: boolean;
}

export type MachineCleanRow = Pick<
  RepullRow,
  | "origin"
  | "dataset_id"
  | "branch"
  | "pr_number"
  | "head_sha"
  | "gates_sha"
  | "base_sha"
  | "patch_version"
  | "counts"
>;

export interface MachineCleanFacts {
  stage: MachineCleanStage;
  switches: { production: boolean; enabled: boolean; merge: boolean };
  dataset: DatasetFact;
  row: MachineCleanRow;
  pr: PullRequestFact | "unreadable";
  mainSha: string | "unreadable";
  checks: { bids: CheckFact; versionCheck: CheckFact };
  screen: ScreenFact;
  review: ReviewFact;
}

export type MachineCleanVerdict = { clean: true } | { clean: false; hold: HoldReason };

/** Every word {@link machineClean} can answer, in the order its rules are checked. */
export const MACHINE_CLEAN_HOLDS = [
  "not-production",
  "switch-off",
  "merge-switch-off",
  "not-automatic",
  "has-corrections",
  "dataset-anonymous",
  "dataset-withdrawn",
  "import-in-flight",
  "dataset-not-mirror",
  "pr-unreadable",
  "pr-closed",
  "pr-mismatch",
  "pr-draft",
  "pr-not-app",
  "head-moved",
  "main-unreadable",
  "main-moved",
  "checks-unreadable",
  "bids-pending",
  "bids-failed",
  "version-check-pending",
  "version-check-failed",
  "screen-pending",
  "screen-unreported",
  "screen-acknowledge",
  "screen-blocks",
  "screen-unchecked",
  "screen-rerun",
  "screen-error",
  "screen-unreadable",
  "screen-exempt",
  "review-absent",
  "review-running",
  "review-not-pass",
  "review-exempt",
  "review-unreadable",
  "not-clean",
] as const satisfies readonly HoldReason[];

/**
 * What each screen fact holds as; `clear` alone is null. A `Record` over the union, so a fact added
 * to {@link ScreenFact} without a word here does not compile. `absent` and `rerun` share a word:
 * both mean the head has to be screened (again).
 */
const SCREEN_HOLDS: Readonly<Record<ScreenFact, HoldReason | null>> = {
  clear: null,
  pending: "screen-pending",
  unreported: "screen-unreported",
  acknowledge: "screen-acknowledge",
  blocks: "screen-blocks",
  unchecked: "screen-unchecked",
  rerun: "screen-rerun",
  absent: "screen-rerun",
  error: "screen-error",
  unreadable: "screen-unreadable",
  exempt: "screen-exempt",
};

/** What each review fact holds as; `pass` alone is null. Every verdict but `pass` is not a pass. */
const REVIEW_HOLDS: Readonly<Record<ReviewFact, HoldReason | null>> = {
  pass: null,
  absent: "review-absent",
  running: "review-running",
  fail: "review-not-pass",
  uncertain: "review-not-pass",
  error: "review-not-pass",
  declined: "review-not-pass",
  unreported: "review-not-pass",
  exempt: "review-exempt",
  unreadable: "review-unreadable",
};

/** The three plan counts that must each be stated and zero (ADR 0111, decision 6). */
const ZERO_COUNTS = ["unexplained", "conflicts", "corrections"] as const;

const ON_DATASET = /^on\d{6}$/;

const sameRepo = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * A word from a lookup, or the fail-safe when the value is not one the type allows (a caller that
 * cast its way past the type): unknown is never clean.
 */
function lookup<K extends string>(
  table: Readonly<Record<K, HoldReason | null>>,
  value: K,
  failSafe: HoldReason,
): HoldReason | null {
  return Object.hasOwn(table, value) ? table[value] : failSafe;
}

/** One check, as the rule reads it: the App's run, completed with `success`, and nothing else. */
function checkHold(fact: CheckFact, pending: HoldReason, failed: HoldReason): HoldReason | null {
  if (fact.status !== "completed") return pending;
  return fact.conclusion === "success" ? null : failed;
}

const hold = (word: HoldReason): MachineCleanVerdict => ({ clean: false, hold: word });

/** The rule (see the module comment), in its order: the first that fails is the answer. */
export function machineClean(f: MachineCleanFacts): MachineCleanVerdict {
  const { row } = f;

  // 1. The switches.
  if (f.switches.production !== true) return hold("not-production");
  if (f.switches.enabled !== true) return hold("switch-off");
  if (f.stage !== "gates" && f.switches.merge !== true) return hold("merge-switch-off");

  // 2. The automatic path's own record.
  if (row.origin !== "automatic" || !ON_DATASET.test(row.dataset_id)) return hold("not-automatic");

  // 3. Nothing to replay as N.0.1, by the plan's own stated counts.
  if (row.patch_version !== null) return hold("has-corrections");
  for (const key of ZERO_COUNTS) {
    if (row.counts?.[key] !== 0) return hold("has-corrections");
  }

  // 4. The dataset.
  if (f.dataset.anonymous !== 0) return hold("dataset-anonymous");
  if (f.dataset.withdrawn !== false) return hold("dataset-withdrawn");
  if (f.dataset.importInFlight !== false) return hold("import-in-flight");
  if (f.dataset.mirror !== true) return hold("dataset-not-mirror");

  // 5. The recorded pull request, as GitHub says it is.
  if (row.branch === null || row.pr_number === null || row.head_sha === null) {
    return hold("pr-mismatch");
  }
  if (f.pr === "unreadable") return hold("pr-unreadable");
  const pr = f.pr;
  if (pr.state !== "open" || pr.merged !== false) return hold("pr-closed");
  const repo = `${NEMAR_DATASETS_ORG}/${row.dataset_id}`;
  if (
    pr.number !== row.pr_number ||
    pr.headRef !== row.branch ||
    pr.baseRef !== "main" ||
    !sameRepo(pr.baseRepo, repo) ||
    !sameRepo(pr.headRepo, repo)
  ) {
    return hold("pr-mismatch");
  }
  if (pr.draft !== false) return hold("pr-draft");
  if (
    pr.authorLogin !== NEMAR_APP_BOT_LOGIN ||
    pr.authorId !== NEMAR_APP_BOT_USER_ID ||
    pr.authorType !== NEMAR_APP_BOT_TYPE
  ) {
    return hold("pr-not-app");
  }

  // 6. The head the stage is about.
  const expected = f.stage === "gates" ? row.head_sha : row.gates_sha;
  if (expected === null || pr.headSha !== expected) return hold("head-moved");
  if (f.stage !== "gates" && row.gates_sha !== row.head_sha) return hold("head-moved");

  // 7. `main`.
  if (f.mainSha === "unreadable") return hold("main-unreadable");
  if (f.mainSha !== row.base_sha) return hold("main-moved");

  // 8. The two checks, the App's own, at that head.
  const { bids, versionCheck } = f.checks;
  if (bids.status === "unreadable" || versionCheck.status === "unreadable") {
    return hold("checks-unreadable");
  }
  const checks =
    checkHold(bids, "bids-pending", "bids-failed") ??
    checkHold(versionCheck, "version-check-pending", "version-check-failed");
  if (checks !== null) return hold(checks);

  // 9. The screen bound to the record.
  const screen = lookup(SCREEN_HOLDS, f.screen, "screen-unreadable");
  if (screen !== null) return hold(screen);

  // 10. The review of that head.
  const review = lookup(REVIEW_HOLDS, f.review, "review-unreadable");
  if (review !== null) return hold(review);

  // 11. GitHub's own word.
  if (pr.mergeableState !== "clean") return hold("not-clean");

  return { clean: true };
}
