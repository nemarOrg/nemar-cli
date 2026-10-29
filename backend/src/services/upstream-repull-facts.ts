/**
 * The facts the machine-clean rule of an automatic re-pull reads (epic #1046 phase 7, #1913;
 * ADR 0111, decision 7): each read from GitHub or from the record at the moment it is asked, and
 * never from an earlier answer. The rule itself is `shared/repull-machine-clean.ts`; this file
 * only reads.
 *
 * WHERE EACH FACT COMES FROM.
 *  - The switches: the Worker's own bindings (`repull-switches.ts`).
 *  - The dataset: its catalog row and its import, by the statement the record's create reads
 *    (`CREATE_FACTS_SQL`), so the two cannot read different columns.
 *  - The pull request: `GET /pulls/<n>`, GitHub's own record of the recorded number.
 *  - `main`: `GET /git/ref/heads/main`.
 *  - BIDS validation and `version-check`: `GET /commits/<head>/check-runs`, asked by name (the
 *    names `deriveContexts` gives the dataset) and for the App's runs only (`app_id`, the latest
 *    run of each), and filtered again here by name, App and head, so a GitHub that ignored a filter
 *    still cannot pass another App's run or a person's. Measured 2026-10-25 on a central-flow
 *    repository (`nm000527#1`): both `Run BIDS Validation` and `version-check` are posted by App
 *    3679074; the dispatching shims' own job runs are GitHub Actions' and are named otherwise.
 *    `deriveContexts` leaves `version-check` unpinned for the rulesets, and its four legacy-inline
 *    repositories post `bids-validation` as GitHub Actions, so such a repository never reads green
 *    here, which is the safe direction (only `on` mirrors are re-pulled automatically).
 *  - The identifier screen: the row of `upstream_repull_screens` for N.0.0's head, read as
 *    `upstream-repull-screen.ts` reads it (its state at read time, `screenGate`, and the stored
 *    report naming that head), but stricter than the screen's own gate: an acknowledgment never
 *    passes here, whoever recorded it, because it needs a person (ADR 0086).
 *  - The review: waived (ADR 0117) when GitHub's pull request, just read, is the record's at the
 *    head the stage is about, by the rule the review itself asks (`shared/repull-review-waiver.ts`),
 *    and then no row is read. Otherwise the `pr_reviews` row of that head, read as ADR 0093's
 *    detail view reads it, the stricter of the stored verdict and the one its stored report
 *    re-derives through `outcomeOfRow`. Either is read again at every stage, and nothing is
 *    carried between stages.
 *
 * UNKNOWN IS NEVER CLEAN. A GitHub answer that is not 200 (404 included), a timeout, a throttle,
 * a shape this does not recognize and a database read that throws each read as `unreadable` (or,
 * for the dataset, as anonymity unknown), and the rule holds on each.
 *
 * NOTHING IS READ THAT CANNOT MATTER. Outside exact production, with the open switch off, at the
 * merge with the merge switch off, and for a record the rule refuses on its own columns (not the
 * automatic path's, a correction to replay) or its dataset (anonymous, withdrawn, an import in
 * flight, no longer the mirror), GitHub is not asked anything: the `nemarDatasets` organization is
 * shared with dev, and every Worker invocation shares one subrequest allowance. Those facts are
 * then left `unreadable`, and the rule's earlier rule is the answer.
 *
 * Reads only; nothing here writes to GitHub or to the database, and nothing mails anyone.
 */

import { VERSION_CHECK_NAME } from "../../../shared/dataset-checks.js";
import { isScreenState, screenGate } from "../../../shared/identifier-screen-report.js";
import { PR_REVIEW_CHECK_NAME, verdictOf } from "../../../shared/pr-review.js";
import { checkFactOf } from "../../../shared/repull-bids-override.js";
import {
  type CheckFact,
  type DatasetFact,
  MACHINE_CLEAN_HOLDS,
  type MachineCleanFacts,
  type MachineCleanStage,
  type PullRequestFact,
  type ReviewFact,
  type ScreenFact,
  machineClean,
} from "../../../shared/repull-machine-clean.js";
import { repullReviewWaiver, subjectOfPull } from "../../../shared/repull-review-waiver.js";
import { type HoldReason, type RepullRow, SHA_RE } from "../../../shared/repull-state.js";
import type { Bindings } from "../types/bindings.js";
import { NEMAR_APP_ID, deriveContexts } from "./github/branch-protection.js";
import { isScreenExempt, readStoredReport } from "./identifier-screen-stored.js";
import { outcomeOfRow } from "./pr-review.js";
import { autoRepullEnabled, autoRepullMergeEnabled, isExactProduction } from "./repull-switches.js";
import { githubRead, isObject, pullRequestFacts } from "./upstream-repull-github.js";
import { readRepullScreen } from "./upstream-repull-screen.js";
import { CREATE_FACTS_SQL, type DatasetFacts } from "./upstream-repull.js";

const posInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;

function said(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : "unknown";
}

// ----------------------------------------------------------------------------
// GitHub
// ----------------------------------------------------------------------------

/**
 * GitHub's pull request as the rule reads it: {@link pullRequestFacts}, the one parser of it, and
 * the fields only the rule reads (the author, the number, `draft` as sent, `mergeable_state`), or
 * `unreadable` when any of them is missing or not of its shape.
 */
export function pullRequestFactOf(body: unknown): PullRequestFact | "unreadable" {
  const pr = pullRequestFacts(body);
  if (pr === null || !isObject(body) || !isObject(body.user)) return "unreadable";
  const { user, draft, number, mergeable_state: mergeable } = body;
  if (pr.state !== "open" && pr.state !== "closed") return "unreadable";
  if (typeof draft !== "boolean" || !posInt(number)) return "unreadable";
  if (typeof user.login !== "string" || !posInt(user.id) || typeof user.type !== "string") {
    return "unreadable";
  }
  if (mergeable !== undefined && mergeable !== null && typeof mergeable !== "string") {
    return "unreadable";
  }
  return {
    state: pr.state,
    merged: pr.merged,
    draft: pr.draft,
    number,
    authorLogin: user.login,
    authorId: user.id,
    authorType: user.type,
    headRef: pr.headRef,
    headSha: pr.headSha,
    headRepo: pr.headRepo,
    baseRepo: pr.baseRepo,
    baseRef: pr.baseRef,
    mergeableState: typeof mergeable === "string" ? mergeable : null,
  };
}

/** The recorded pull request, as GitHub says it is now. */
export async function readPullRequestFact(
  env: Bindings,
  datasetId: string,
  prNumber: number,
): Promise<PullRequestFact | "unreadable"> {
  const read = await githubRead(env, datasetId, `/pulls/${prNumber}`);
  if (!read.ok || read.status !== 200) return "unreadable";
  return pullRequestFactOf(read.body);
}

/** The commit `main` points at, as GitHub says it is now. */
export async function readMainSha(
  env: Bindings,
  datasetId: string,
): Promise<string | "unreadable"> {
  const read = await githubRead(env, datasetId, "/git/ref/heads/main");
  if (!read.ok || read.status !== 200 || !isObject(read.body)) return "unreadable";
  const { ref, object } = read.body;
  if (ref !== "refs/heads/main" || !isObject(object) || object.type !== "commit") {
    return "unreadable";
  }
  return typeof object.sha === "string" && SHA_RE.test(object.sha) ? object.sha : "unreadable";
}

const UNREADABLE_CHECK: CheckFact = { status: "unreadable", conclusion: null };

/**
 * The App's latest run named `name` at `sha`, or `absent`. Asked for that name and App only, and
 * read by `checkFactOf` (`shared/repull-bids-override.ts`), which filters the answer again: a run of
 * another name, another App or another commit is not read, whatever GitHub returned. The same
 * reading is the CLI's, from its own unfiltered read of the head's runs. A failed read, a page that
 * does not hold every run GitHub counts, or a run whose fields are not of their shape, is
 * `unreadable`: unknown is never read as absent or green.
 */
async function readCheck(
  env: Bindings,
  datasetId: string,
  sha: string,
  name: string,
): Promise<CheckFact> {
  const query = new URLSearchParams({
    check_name: name,
    app_id: String(NEMAR_APP_ID),
    filter: "latest",
    per_page: "100",
  });
  const read = await githubRead(env, datasetId, `/commits/${sha}/check-runs?${query}`);
  if (!read.ok || read.status !== 200) return UNREADABLE_CHECK;
  return checkFactOf(read.body, name, sha);
}

/**
 * The App's latest `NEMAR PR Review` run at `sha` (ADR 0117): read by the advance tick only for a
 * recorded head GitHub holds back, to tell whether its check already says the waiver.
 */
export async function readReviewCheck(
  env: Bindings,
  datasetId: string,
  sha: string,
): Promise<CheckFact> {
  if (!SHA_RE.test(sha)) return UNREADABLE_CHECK;
  return readCheck(env, datasetId, sha, PR_REVIEW_CHECK_NAME);
}

/** BIDS validation and `version-check` at `sha`, the App's own runs, by the dataset's names. */
export async function readCheckFacts(
  env: Bindings,
  datasetId: string,
  sha: string,
): Promise<{ bids: CheckFact; versionCheck: CheckFact }> {
  const [bidsCheck, versionCheck] = deriveContexts(datasetId);
  if (!SHA_RE.test(sha) || !bidsCheck || versionCheck?.context !== VERSION_CHECK_NAME) {
    return { bids: UNREADABLE_CHECK, versionCheck: UNREADABLE_CHECK };
  }
  const [bids, version] = await Promise.all([
    readCheck(env, datasetId, sha, bidsCheck.context),
    readCheck(env, datasetId, sha, versionCheck.context),
  ]);
  return { bids, versionCheck: version };
}

// ----------------------------------------------------------------------------
// The record
// ----------------------------------------------------------------------------

/**
 * The import statuses that mean nothing of the import is running or will be taken up again on its
 * own: it reached `complete`, or it ended (`failed`, `quarantined`, `rolled_back`). The words are
 * `IMPORT_STATUSES` in `import-recovery.ts`, which this file cannot import (it mails), so a test
 * pins that every one of them is either here or held. Any other status holds, `incomplete`
 * included (the retry engine is repairing it), and so does a status the vocabulary does not know:
 * the record's own fence lists the three states that write, and machine clean asks the opposite
 * question, whether the import has settled.
 */
export const SETTLED_IMPORT_STATUSES: ReadonlySet<string> = new Set([
  "complete",
  "failed",
  "quarantined",
  "rolled_back",
]);

/**
 * The dataset row and its import. A row that is not there, or a read that throws, is anonymity
 * unknown (`anonymous` null), which the rule holds as anonymous. An import that has not settled
 * ({@link SETTLED_IMPORT_STATUSES}) is in flight.
 */
export async function readDatasetFact(
  db: D1Database,
  row: Pick<RepullRow, "dataset_id" | "upstream_ds">,
): Promise<DatasetFact> {
  let facts: DatasetFacts | null;
  try {
    facts = await db.prepare(CREATE_FACTS_SQL).bind(row.dataset_id).first<DatasetFacts>();
  } catch (err) {
    console.error(`[repull-facts] ${row.dataset_id}: the dataset was not read (${said(err)})`);
    facts = null;
  }
  if (!facts) return { anonymous: null, withdrawn: true, importInFlight: true, mirror: false };
  return {
    anonymous: typeof facts.anonymous === "number" ? facts.anonymous : null,
    withdrawn: facts.withdrawn_at !== null,
    importInFlight:
      facts.import_status !== null && !SETTLED_IMPORT_STATUSES.has(facts.import_status),
    mirror: facts.source === "openneuro" && facts.source_id === row.upstream_ds,
  };
}

/**
 * The identifier screen of N.0.0's `sha`, bound to the record. An `xx` dataset is `exempt`; no
 * screen of that head is `absent`. A verdict is read as `upstream-repull-screen.ts` reads it (a
 * run past its report deadline is `unreported`), and one whose stored report does not name `sha`
 * is `unreadable`, never `clear`. `review`, `not-screened` and `clean-edf-only-others-unscreened`
 * are `acknowledge`, acknowledged or not.
 */
export async function readScreenFact(
  db: D1Database,
  row: Pick<RepullRow, "id" | "dataset_id">,
  sha: string,
): Promise<ScreenFact> {
  if (isScreenExempt(row.dataset_id)) return "exempt";
  let screen: Awaited<ReturnType<typeof readRepullScreen>>;
  try {
    screen = await readRepullScreen(db, row.id, "n0", sha);
  } catch (err) {
    console.error(`[repull-facts] re-pull ${row.id}: the screen was not read (${said(err)})`);
    return "unreadable";
  }
  if (!screen) return "absent";
  const state = isScreenState(screen.state) ? screen.state : null;
  if (state === null) return "unreadable";
  switch (state) {
    case "pending":
      return "pending";
    case "unreported":
      return "unreported";
    case "error":
      return "error";
    case "unchecked":
      return "unchecked";
    default:
      break;
  }
  const gate = screenGate(state);
  if (gate === "blocks") return "blocks";
  if (gate === "acknowledge") return "acknowledge";
  if (gate !== "clear") return "unreadable";
  return readStoredReport(screen.report)?.head === sha ? "clear" : "unreadable";
}

/** The review row of one head, as {@link readReviewFact} reads it. */
export const REVIEW_OF_HEAD_SQL = `SELECT id, dataset_id, pr_number, state, verdict, detail, report
  FROM pr_reviews WHERE dataset_id = ? AND pr_number = ? AND head_sha = ?`;

interface ReviewOfHead {
  id: number;
  dataset_id: string;
  pr_number: number;
  state: string;
  verdict: string | null;
  detail: string | null;
  report: string | null;
}

/** Higher is stricter: the order ADR 0093's detail view reads two verdicts in. */
const STRICTNESS = { pass: 0, uncertain: 1, fail: 2 } as const;
type Verdict = keyof typeof STRICTNESS;
const isVerdict = (v: unknown): v is Verdict => v === "pass" || v === "uncertain" || v === "fail";

/**
 * The ADR 0107 review of `sha` on pull request `prNumber`. A reported review's verdict is the
 * stricter of the stored column and the verdict its stored report re-derives, so either can lower
 * it and neither can raise it; a stored report that no longer parses is an `error` unless the
 * column says `fail`. No row is `absent`; a review handed to the workflow is `running`.
 */
export async function readReviewFact(
  db: D1Database,
  datasetId: string,
  prNumber: number,
  sha: string,
): Promise<ReviewFact> {
  let row: ReviewOfHead | null;
  try {
    row = await db.prepare(REVIEW_OF_HEAD_SQL).bind(datasetId, prNumber, sha).first<ReviewOfHead>();
  } catch (err) {
    console.error(
      `[repull-facts] ${datasetId}#${prNumber}: the review was not read (${said(err)})`,
    );
    return "unreadable";
  }
  if (!row) return "absent";
  switch (row.state) {
    case "dispatched":
      return "running";
    case "declined":
      return "declined";
    case "errored":
      return "error";
    case "unreported":
      return "unreported";
    case "reported":
      break;
    default:
      return "unreadable";
  }
  const stored = isVerdict(row.verdict) ? row.verdict : null;
  const outcome = outcomeOfRow({
    id: row.id,
    datasetId: row.dataset_id,
    prNumber: row.pr_number,
    state: "reported",
    detail: row.detail,
    report: row.report,
  });
  if (outcome?.kind !== "reported") return stored === "fail" ? "fail" : "error";
  const derived = verdictOf(outcome.report);
  if (stored === null) return derived;
  return STRICTNESS[stored] > STRICTNESS[derived] ? stored : derived;
}

// ----------------------------------------------------------------------------
// All of them
// ----------------------------------------------------------------------------

/** The words of the rules before a given one, in the rule's own order. */
const holdsBefore = (word: (typeof MACHINE_CLEAN_HOLDS)[number]): ReadonlySet<HoldReason> =>
  new Set(MACHINE_CLEAN_HOLDS.slice(0, MACHINE_CLEAN_HOLDS.indexOf(word)));

/** The holds the rule decides from the switches and the record's own columns alone. */
const BEFORE_DATASET = holdsBefore("dataset-anonymous");

/** The holds the rule decides before it reads anything from GitHub. */
const BEFORE_GITHUB = holdsBefore("pr-unreadable");

/**
 * Every fact the rule reads for `row` at `stage`, read now. The head the checks, the screen and
 * the review are read at is the one the stage is about: the recorded head at the gates, the
 * screened head (`gates_sha`) at the merge. When the rule would answer from the switches, the
 * record or the dataset alone, GitHub and the screen and review rows are not read and those facts
 * are `unreadable` (see the module comment); `machineClean` on the result is then that earlier
 * answer.
 */
export async function gatherMachineCleanFacts(
  env: Bindings,
  row: RepullRow,
  stage: MachineCleanStage,
): Promise<MachineCleanFacts> {
  const facts: MachineCleanFacts = {
    stage,
    switches: {
      production: isExactProduction(env),
      enabled: autoRepullEnabled(env),
      merge: autoRepullMergeEnabled(env),
    },
    // Unknown until read, which the rule holds on.
    dataset: { anonymous: null, withdrawn: true, importInFlight: true, mirror: false },
    row: {
      origin: row.origin,
      dataset_id: row.dataset_id,
      branch: row.branch,
      pr_number: row.pr_number,
      head_sha: row.head_sha,
      gates_sha: row.gates_sha,
      base_sha: row.base_sha,
      patch_version: row.patch_version,
      counts: row.counts,
    },
    pr: "unreadable",
    mainSha: "unreadable",
    checks: { bids: UNREADABLE_CHECK, versionCheck: UNREADABLE_CHECK },
    screen: "unreadable",
    review: "unreadable",
  };
  // The rule is asked on what is read so far; while its answer is a rule that comes before what
  // would be read next, reading more cannot change it.
  const decided = (before: ReadonlySet<HoldReason>) => {
    const verdict = machineClean(facts);
    return !verdict.clean && before.has(verdict.hold);
  };
  // Nothing is read, the database included, outside exact production or with a switch off.
  if (decided(BEFORE_DATASET)) return facts;
  facts.dataset = await readDatasetFact(env.DB, row);
  if (decided(BEFORE_GITHUB)) return facts;
  // A record with no pull request holds before GitHub could say anything about one.
  if (row.pr_number === null || row.branch === null || row.head_sha === null) return facts;

  const sha = stage === "gates" ? row.head_sha : row.gates_sha;
  const [pr, mainSha, checks] = await Promise.all([
    readPullRequestFact(env, row.dataset_id, row.pr_number),
    readMainSha(env, row.dataset_id),
    sha === null
      ? Promise.resolve({ bids: UNREADABLE_CHECK, versionCheck: UNREADABLE_CHECK })
      : readCheckFacts(env, row.dataset_id, sha),
  ]);
  facts.pr = pr;
  facts.mainSha = mainSha;
  facts.checks = checks;
  if (sha !== null) {
    facts.screen = await readScreenFact(env.DB, row, sha);
    facts.review = reviewWaivedAt(row, pr, sha)
      ? "waived"
      : await readReviewFact(env.DB, row.dataset_id, row.pr_number, sha);
  }
  return facts;
}

/**
 * Whether the review of `sha` is waived (ADR 0117): GitHub's pull request, as just read, is the
 * record's at `sha`, by the rule the review itself asks (`shared/repull-review-waiver.ts`). Then
 * the review's row is not read, because nothing it holds could change the answer: the review does
 * not apply to the head. A pull request that could not be read, or is at another head, is not
 * waived, and the row is read as before.
 */
export function reviewWaivedAt(
  row: RepullRow,
  pr: PullRequestFact | "unreadable",
  sha: string,
): boolean {
  if (pr === "unreadable" || pr.headSha !== sha) return false;
  return repullReviewWaiver(row, subjectOfPull(row.dataset_id, pr.number, pr.headSha, pr)).waived;
}
