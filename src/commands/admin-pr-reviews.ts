/**
 * `nemar admin pr-reviews`: one place to see and manage every dataset pull request waiting for
 * approval (ADR 0093, following ADR 0092).
 *
 *   nemar admin pr-reviews [list]            open pull requests to main, with the automated review
 *   nemar admin pr-reviews show <ds> <pr>    the stored report, in the pull-request comment's words
 *   nemar admin pr-reviews approve <ds> <pr> approve as YOU, with your own GitHub login
 *   nemar admin pr-reviews allow|block|clear <login>   who the automated review is spent on
 *   nemar admin pr-reviews standing <login>  a contributor's record and what it means
 *
 * The list, the report and the contributor controls come from the NEMAR API. The approval does
 * not: it is made from this machine with the GitHub token `gh` holds, because an approval is a
 * person's and the NEMAR App must not approve on one's behalf (see `lib/pr-review-approve.ts`).
 */

import chalk from "chalk";
import { Command } from "commander";
import ora, { type Ora } from "ora";
import {
  type ContributorStanding,
  type PrReviewDetail,
  QUEUE_VERDICTS,
  type QueueEntry,
  type QueueResponse,
  type QueueVerdict,
} from "../../shared/contract/pr-review-admin.js";
import { renderCheck, standingOf } from "../../shared/pr-review.js";
import {
  clearPrReviewAuthor,
  getPrReview,
  getPrReviewAuthor,
  listPrReviews,
  setPrReviewAuthor,
} from "../lib/api/admin.js";
import { getCurrentUser } from "../lib/api/auth.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { openInBrowser } from "../lib/browser.js";
import { isAuthenticated } from "../lib/config.js";
import { confirm } from "../lib/confirm.js";
import {
  MERGE_METHODS,
  type MergeMethod,
  adminGitHubToken,
  approvalGate,
  fetchPullRequest,
  githubApiBase,
  identityMatches,
  manualApprovalCommand,
  mergeWhenClean,
  pullRequestUrl,
  refusalFor,
  submitApproval,
  whoAmI,
} from "../lib/pr-review-approve.js";

const DATASET_ID_RE = /^(nm|xx|on)\d{6}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// ---------------------------------------------------------------------------------------------
// Plain, safe, aligned text
// ---------------------------------------------------------------------------------------------

/**
 * Text that came from the network, made safe for a terminal: control characters (an ESC sequence
 * can rewrite the screen), zero-width and bidirectional-override characters are removed. The
 * server already reduces author-controlled text to plain words; this is the second line, because a
 * terminal should not depend on a server's hygiene alone.
 */
export function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "") : "";
}

function clip(s: string, max: number): string {
  const p = plain(s);
  return p.length > max ? `${p.slice(0, max - 1)}…` : p;
}

/** How long ago, in the unit that reads best: `12m`, `5h`, `9d`. */
export function ageOf(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const DETAIL_WORDS: Record<string, string> = {
  contributor_paused: "contributor paused",
  rate_limited: "rate limited",
  daily_limit: "daily limit",
  unreported: "never reported",
};

function detailWord(detail: string): string {
  return DETAIL_WORDS[detail] ?? detail.replaceAll("_", " ");
}

const VERDICT_WORD: Record<QueueVerdict, string> = {
  pass: "pass",
  fail: "fail",
  uncertain: "uncertain",
  not_reviewed: "not reviewed",
  in_progress: "in progress",
  could_not_decide: "could not decide",
};

function verdictColor(v: QueueVerdict): (s: string) => string {
  switch (v) {
    case "pass":
      return chalk.green;
    case "fail":
      return chalk.red;
    case "uncertain":
    case "could_not_decide":
      return chalk.yellow;
    case "in_progress":
      return chalk.cyan;
    default:
      return chalk.dim;
  }
}

/** The verdict as a person reads it, with the closed word behind it when there is one. */
export function verdictText(e: Pick<QueueEntry, "verdict" | "detail" | "review_current">): string {
  const word = VERDICT_WORD[e.verdict];
  if (e.verdict === "not_reviewed" && e.review_current === false) {
    return `${word} (older commit)`;
  }
  return e.detail ? `${word} (${detailWord(e.detail)})` : word;
}

const CHECK_WORD: Record<string, [string, (s: string) => string]> = {
  pass: ["ok", chalk.green],
  fail: ["FAIL", chalk.red],
  pending: ["pending", chalk.yellow],
  missing: ["none", chalk.yellow],
  unknown: ["?", chalk.yellow],
};

function checkCell(state: string, width: number): string {
  const [word, color] = CHECK_WORD[state] ?? ["?", chalk.yellow];
  return color(word.padEnd(width));
}

/** The list, one pull request per line, with a header. Pure, so it is tested without a server. */
export function renderQueue(entries: QueueEntry[], now: number = Date.now()): string[] {
  if (entries.length === 0) return [];
  const rows = entries.map((e) => ({
    e,
    mark: e.needs_you ? "*" : " ",
    ds: plain(e.dataset_id),
    pr: `#${e.pr_number}`,
    author: clip(e.author_login, 20),
    from: clip(e.from_fork ? `fork ${e.head_label}` : `branch ${e.head_label}`, 34),
    verdict: clip(`${verdictText(e)}${e.draft ? " [draft]" : ""}`, 40),
    age: ageOf(e.created_at, now),
  }));
  const w = (f: (r: (typeof rows)[number]) => string, min: number) =>
    Math.max(min, ...rows.map((r) => f(r).length));
  const wPr = w((r) => r.pr, 3);
  const wAuthor = w((r) => r.author, 6);
  const wFrom = w((r) => r.from, 4);
  const wVerdict = w((r) => r.verdict, 7);
  const wAge = w((r) => r.age, 3);
  const header = chalk.dim(
    `  ${"DATASET".padEnd(8)}  ${"PR".padStart(wPr)}  ${"AUTHOR".padEnd(wAuthor)}  ${"FROM".padEnd(wFrom)}  ${"REVIEW".padEnd(wVerdict)}  ${"BIDS".padEnd(7)}  ${"VERSION".padEnd(7)}  ${"AGE".padStart(wAge)}  LINK`,
  );
  const lines = rows.map(
    (r) =>
      `${r.e.needs_you ? chalk.bold.cyan(r.mark) : r.mark} ${r.ds.padEnd(8)}  ${r.pr.padStart(wPr)}  ${r.author.padEnd(wAuthor)}  ${chalk.dim(r.from.padEnd(wFrom))}  ${verdictColor(r.e.verdict)(r.verdict.padEnd(wVerdict))}  ${checkCell(r.e.bids, 7)}  ${checkCell(r.e.version, 7)}  ${r.age.padStart(wAge)}  ${plain(r.e.url)}`,
  );
  return [header, ...lines];
}

/**
 * Markdown from the shared renderer, as terminal text: the same words, no HTML wrapper. Control
 * characters are removed one LINE at a time, because a newline is itself a control character and
 * stripping it from the whole text would run the report together.
 */
export function terminalize(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      plain(line.replace(/\s+$/, ""))
        .replace(/<\/?details>/g, "")
        .replace(/<summary>(.*?)<\/summary>/g, "$1")
        .replace(/^### (.*)$/, (_, t: string) => chalk.bold(t))
        .replace(/\*\*(.+?)\*\*/g, (_, t: string) => chalk.bold(t)),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Contributor standing
// ---------------------------------------------------------------------------------------------

export function standingLines(s: ContributorStanding): string[] {
  const out: string[] = [];
  out.push(
    `${chalk.bold(plain(s.login))} ${chalk.dim(`(GitHub id ${s.author_id}${s.resolved_from === "history" ? ", from the review history" : ""})`)}`,
  );
  const { rejected, decided } = s.tally;
  const pct = decided > 0 ? Math.round((rejected / decided) * 100) : 0;
  out.push(
    `  Record:    ${rejected} of ${decided} decided pull request${decided === 1 ? "" : "s"} rejected${decided > 0 ? ` (${pct}%)` : ""}`,
  );
  out.push(
    chalk.dim(
      `             reviews pause when MORE than ${s.thresholds.rejected_more_than} are rejected AND more than ${s.thresholds.percent_more_than}% of the decided ones`,
    ),
  );
  const byTally = standingOf(s.tally, null);
  if (s.override) {
    const by = s.override.set_by ? ` by ${plain(s.override.set_by)}` : "";
    out.push(
      `  Decision:  ${s.override.mode === "allow" ? chalk.green("allowed") : chalk.red("blocked")}${by} on ${plain(s.override.set_at)}${s.override.reason ? `: ${plain(s.override.reason)}` : ""}`,
    );
    if (s.override.mode === "allow" && byTally.paused) {
      out.push(chalk.dim("             the record alone would pause them; the decision wins"));
    }
  } else {
    out.push("  Decision:  none, the record decides");
  }
  out.push(
    `  Standing:  ${
      s.standing.paused
        ? chalk.red(
            s.standing.because === "maintainer"
              ? "paused by a maintainer: their pull requests need a person"
              : "paused by the record: their pull requests need a person",
          )
        : chalk.green("reviewed automatically")
    }`,
  );
  if (s.recent.length > 0) {
    out.push(
      `  Recent:    ${s.recent
        .map(
          (r) =>
            `${plain(r.dataset_id)}#${r.pr_number} ${r.verdict === "fail" ? chalk.red("fail") : chalk.green("pass")}`,
        )
        .join(", ")}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shared command plumbing
// ---------------------------------------------------------------------------------------------

function requireAuth(): boolean {
  if (!isAuthenticated()) {
    console.log(chalk.red("Error: Not authenticated"));
    console.log(chalk.dim("  Run 'nemar auth login' first"));
    return false;
  }
  return true;
}

function die(message: string, hint?: string): never {
  console.log(chalk.red(message));
  if (hint) console.log(chalk.dim(`  ${hint}`));
  process.exit(1);
}

function failApi(err: unknown, spinner: Ora | null, fallback: string): never {
  const message = err instanceof ApiError ? plain(err.message) : fallback;
  if (spinner) spinner.fail(message);
  else console.log(chalk.red(message));
  if (err instanceof ApiError) {
    if (err.statusCode === 403) console.log(chalk.dim("  This command requires admin privileges"));
  } else {
    console.log(chalk.dim(`  Error details: ${errorDetail(err)}`));
  }
  process.exit(1);
}

function checkDataset(id: string): string {
  if (!DATASET_ID_RE.test(id)) die(`"${plain(id)}" is not a dataset id (like nm000108).`);
  return id;
}

function checkPr(raw: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) {
    die(`"${plain(raw)}" is not a pull request number.`);
  }
  return n;
}

function checkLogin(raw: string): string {
  const login = raw.replace(/^@/, "");
  if (!LOGIN_RE.test(login)) die(`"${plain(raw)}" is not a GitHub login.`);
  return login;
}

function envNote(environment: string): void {
  if (environment !== "production") {
    console.log(
      chalk.yellow(
        "  This is the non-production Worker. It holds its own record and answers only for the datasets it owns; it does not change what production reviews.",
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The command group
// ---------------------------------------------------------------------------------------------

export const prReviewsCommand = new Command("pr-reviews")
  .description("Dataset pull requests waiting for approval, with the automated review (ADR 0092)")
  .addHelpText(
    "after",
    `
One place for every open pull request to main in nemarDatasets. Run with no subcommand to list.

REVIEW column (the automated review of the pull request's CURRENT commit):
  pass              nothing lost, the revision advances, the dataset is materially better
  fail              the review found a problem; the author needs to change something
  uncertain         the review could not decide whether it is a good change
  not reviewed      no review of this commit: the review is off, the contributor is paused or
                    rate limited, or only an older commit was reviewed (shown in brackets)
  in progress       the review is running
  could not decide  the review ended without a verdict (an error, or it never reported)
A verdict is never carried over to a commit it did not read. '*' marks the pull requests you can
act on now: a pass to approve, or one nobody has decided for you.

APPROVING is YOUR act, made with your own GitHub login from this machine, never as the NEMAR
App. It uses the token 'gh' holds (or GH_TOKEN), checks it belongs to the GitHub account linked
to your NEMAR account, and approves the exact commit you were shown. Nothing merges unless you
add --merge, and a merge waits for GitHub to say every required check is satisfied; it never
bypasses the ruleset. If there is no usable token, 'approve' prints the PR link and the
equivalent 'gh pr review --approve' command instead.

The list needs the GitHub search index, which can lag a minute behind a new pull request.
`,
  );

function collectVerdicts(value: string, previous: string[]): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  ];
}

// -- list ---------------------------------------------------------------------------------------

prReviewsCommand
  .command("list", { isDefault: true })
  .description("List open pull requests to main with the latest automated review (default)")
  .option(
    "--verdict <verdict>",
    `Only these verdicts, comma separated or repeated: ${QUEUE_VERDICTS.join(", ").replaceAll("_", "-")}`,
    collectVerdicts,
    [] as string[],
  )
  .option("--dataset <id>", "Only this dataset")
  .option("--author <login>", "Only pull requests opened by this GitHub login")
  .option("--needs-me", "Only what you can act on: passes, and anything a person must decide")
  .option("--json", "Output the raw JSON instead of the table")
  .action(
    async (options: {
      verdict: string[];
      dataset?: string;
      author?: string;
      needsMe?: boolean;
      json?: boolean;
    }) => {
      if (!requireAuth()) process.exit(1);
      const verdicts = options.verdict.map((v) => v.toLowerCase().replaceAll("-", "_"));
      for (const v of verdicts) {
        if (!(QUEUE_VERDICTS as readonly string[]).includes(v)) {
          die(
            `"${plain(v)}" is not a verdict.`,
            `Use: ${QUEUE_VERDICTS.join(", ").replaceAll("_", "-")}`,
          );
        }
      }
      const dataset = options.dataset ? checkDataset(options.dataset) : undefined;
      const author = options.author ? checkLogin(options.author) : undefined;

      const spinner = options.json ? null : ora("Reading open pull requests...").start();
      let q: QueueResponse;
      try {
        q = await listPrReviews({ verdicts, dataset, author, needsMe: options.needsMe });
        spinner?.stop();
      } catch (err) {
        failApi(err, spinner, "Could not read the pull-request queue");
      }
      if (options.json) {
        console.log(JSON.stringify(q, null, 2));
        return;
      }

      const lines = renderQueue(q.entries);
      console.log();
      if (lines.length === 0) {
        console.log(
          q.total_open === 0
            ? chalk.green("No open pull requests to main.")
            : chalk.yellow(`No pull requests match (${q.total_open} open in all).`),
        );
      } else {
        for (const l of lines) console.log(l);
      }
      const needMe = q.entries.filter((e) => e.needs_you).length;
      const shown =
        q.entries.length === q.total_open
          ? `${q.total_open} open`
          : `${q.entries.length} of ${q.total_open} open`;
      console.log();
      console.log(
        `${shown} pull request${q.total_open === 1 ? "" : "s"}, ${chalk.bold(String(needMe))} you can act on.`,
      );
      if (q.truncated) {
        console.log(
          chalk.yellow(
            "  GitHub's search returned fewer pull requests than exist, so this list is incomplete.",
          ),
        );
      }
      if (!q.review_enabled) {
        console.log(
          chalk.dim(
            "  The automated review is off in this environment (PR_REVIEW_ENABLED), so pull requests show as not reviewed.",
          ),
        );
      }
      if (q.skipped.not_owned_here > 0) {
        console.log(
          chalk.dim(
            `  ${q.skipped.not_owned_here} pull request(s) belong to the other environment's Worker and are not listed.`,
          ),
        );
      }
      if (q.skipped.not_a_dataset > 0) {
        console.log(
          chalk.dim(
            `  ${q.skipped.not_a_dataset} pull request(s) in non-dataset repositories ignored.`,
          ),
        );
      }
      envNote(q.environment);
      if (lines.length > 0) {
        console.log(
          chalk.dim(
            "  nemar admin pr-reviews show <dataset> <pr>     read the review\n  nemar admin pr-reviews approve <dataset> <pr>  approve it as yourself",
          ),
        );
      }
    },
  );

// -- show ---------------------------------------------------------------------------------------

function short(sha: string): string {
  return plain(sha).slice(0, 7);
}

prReviewsCommand
  .command("show <dataset> <pr>")
  .description("Show the stored automated review of a pull request, in the comment's own words")
  .option("--json", "Output the raw JSON instead of the report")
  .action(async (datasetArg: string, prArg: string, options: { json?: boolean }) => {
    if (!requireAuth()) process.exit(1);
    const dataset = checkDataset(datasetArg);
    const pr = checkPr(prArg);
    const spinner = options.json ? null : ora("Reading the review...").start();
    let d: PrReviewDetail;
    try {
      d = await getPrReview(dataset, pr);
      spinner?.stop();
    } catch (err) {
      failApi(err, spinner, "Could not read the review");
    }
    if (options.json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }

    console.log();
    console.log(`${chalk.bold(`${dataset} #${pr}`)}  ${chalk.dim(pullRequestUrl(dataset, pr))}`);
    if (d.live) {
      const state = d.live.merged
        ? "merged"
        : d.live.state === "closed"
          ? "closed"
          : d.live.draft
            ? "open, draft"
            : "open";
      console.log(
        `  Author:    ${plain(d.live.author_login)} (${d.live.from_fork ? "fork " : "branch "}${plain(d.live.head_label)})`,
      );
      console.log(`  State:     ${state}, now at ${short(d.live.head_sha)}`);
    } else {
      console.log(
        chalk.yellow("  GitHub could not be read, so the pull request's state is unknown."),
      );
    }
    console.log();

    const color = verdictColor(d.verdict);
    if (!d.review) {
      console.log(`  Review:    ${color("not reviewed")}`);
      console.log(
        chalk.dim(
          d.review_enabled
            ? "             No automated review has been recorded for this pull request."
            : "             The automated review is off in this environment (PR_REVIEW_ENABLED).",
        ),
      );
    } else {
      const which =
        d.review_current === false
          ? chalk.yellow(
              `of ${short(d.review.head_sha)}, an EARLIER commit (the pull request is now at ${short(d.live?.head_sha ?? "")})`,
            )
          : `of ${short(d.review.head_sha)}`;
      console.log(
        `  Review:    ${color(verdictText({ verdict: d.verdict, detail: d.detail, review_current: d.review_current }))} ${chalk.dim(which)}`,
      );
      if (d.review_current === false) {
        console.log(
          chalk.dim(
            `             That review said ${VERDICT_WORD[d.review.verdict]}, and it does not apply to the current commit.`,
          ),
        );
      }
      console.log();
      if (d.review.outcome === null) {
        console.log(
          "The review is still running. It will update the pull request's check when it finishes.",
        );
      } else {
        const r = renderCheck(d.review.outcome);
        console.log(chalk.bold(plain(r.title)));
        console.log();
        console.log(terminalize(r.summary));
        console.log();
        console.log(terminalize(r.text));
      }
    }

    if (d.author) {
      console.log();
      for (const l of standingLines(d.author)) console.log(l);
    }
    if (d.history.length > 1) {
      console.log();
      console.log(chalk.bold("History"));
      for (const h of d.history) {
        console.log(
          `  ${short(h.head_sha)}  ${verdictColor(h.verdict)(VERDICT_WORD[h.verdict].padEnd(16))}  ${chalk.dim(plain(h.created_at))}`,
        );
      }
    }
    envNote(d.environment);
    console.log();
  });

// -- approve ------------------------------------------------------------------------------------

prReviewsCommand
  .command("approve <dataset> <pr>")
  .description("Approve a pull request as YOURSELF (your GitHub login); merges only with --merge")
  .option("--merge", "After approving, merge it if GitHub says it can be merged cleanly")
  .option("--method <method>", `How to merge: ${MERGE_METHODS.join(", ")}`, "merge")
  .option("--message <text>", "The text of your approval")
  .option("--force", "Approve even though the review failed or is still running")
  .option("--dry-run", "Do every check and show what would be approved, but approve nothing")
  .option("-y, --yes", "Do not ask for confirmation")
  .action(
    async (
      datasetArg: string,
      prArg: string,
      options: {
        merge?: boolean;
        method: string;
        message?: string;
        force?: boolean;
        dryRun?: boolean;
        yes?: boolean;
      },
    ) => {
      if (!requireAuth()) process.exit(1);
      const dataset = checkDataset(datasetArg);
      const pr = checkPr(prArg);
      const method = options.method as MergeMethod;
      if (!MERGE_METHODS.includes(method)) {
        die(
          `"${plain(options.method)}" is not a merge method.`,
          `Use: ${MERGE_METHODS.join(", ")}`,
        );
      }
      const url = pullRequestUrl(dataset, pr);
      const base = githubApiBase();

      // 1. Your own GitHub credential. Without one there is no safe way to approve from here.
      const tokenResult = await adminGitHubToken();
      if (!tokenResult.ok) {
        console.log(chalk.yellow(`Cannot approve from here: ${tokenResult.reason}`));
        manualFallback(dataset, pr, url);
        process.exit(1);
      }
      const { token } = tokenResult;

      // 2. Whose it is: a person, and the one this NEMAR account is linked to.
      const me = await whoAmI(token, base);
      if (!me.ok) {
        console.log(chalk.red(me.reason));
        if (me.kind === "not_a_person") manualFallback(dataset, pr, url);
        process.exit(1);
      }
      let linked: string | null;
      try {
        linked = (await getCurrentUser()).github_username ?? null;
      } catch (err) {
        return failApi(err, null, "Could not read your NEMAR account");
      }
      const match = identityMatches(linked, me.user.login);
      if (match === "mismatch") {
        die(
          `gh is signed in as @${me.user.login}, but your NEMAR account is linked to @${plain(linked)}.`,
          "Switch with 'gh auth switch', or set GH_TOKEN to your own token. An approval is recorded under the login that makes it.",
        );
      }

      // 3. The pull request as GitHub says it is right now, through your own token.
      const live = await fetchPullRequest(token, dataset, pr, base);
      if (!live.ok) die(live.reason);
      const refusal = refusalFor(live.value);
      if (refusal) die(refusal);
      const head = live.value.headSha;

      // 4. What the automated review concluded about THIS commit.
      let verdict: QueueVerdict = "not_reviewed";
      let staleVerdict: QueueVerdict | null = null;
      let reviewNote: string | null = null;
      try {
        const d = await getPrReview(dataset, pr);
        if (d.review && d.review.head_sha === head) {
          verdict = d.review.verdict;
        } else if (d.review) {
          staleVerdict = d.review.verdict;
        }
      } catch (err) {
        if (err instanceof ApiError && (err.statusCode === 404 || err.statusCode === 502)) {
          reviewNote = `The NEMAR API has no review to show (${plain(err.message)})`;
        } else {
          return failApi(err, null, "Could not read the automated review");
        }
      }

      const gate = approvalGate({ verdict, staleVerdict });
      if (gate.kind === "needs_force" && !options.force) die(gate.reason);

      console.log();
      console.log(chalk.bold(`Approve ${dataset} #${pr}`));
      console.log(`  Author:   @${plain(live.value.authorLogin)}`);
      console.log(`  Commit:   ${short(head)}`);
      console.log(
        `  Review:   ${verdictColor(verdict)(verdictText({ verdict, detail: null, review_current: staleVerdict === null ? null : false }))}`,
      );
      console.log(
        `  You are:  @${me.user.login} ${match === "match" ? chalk.dim("(linked to your NEMAR account)") : chalk.yellow("(your NEMAR account names no GitHub login, so this cannot be checked)")}`,
      );
      if (reviewNote) console.log(chalk.yellow(`  ${reviewNote}`));
      if (gate.kind === "confirm") console.log(chalk.yellow(`  ${gate.warning}`));
      if (gate.kind === "needs_force") console.log(chalk.yellow("  Approving anyway (--force)."));
      if (options.merge) console.log(`  Then:     merge (${method}) if GitHub says it is clean`);

      if (options.dryRun) {
        console.log();
        console.log(chalk.cyan("Dry run: nothing was approved."));
        return;
      }
      const answer = await confirm(`Approve ${dataset} #${pr} as @${me.user.login}?`, {
        yes: options.yes,
      });
      if (answer !== "confirmed") {
        console.log(chalk.dim("Not approved."));
        process.exit(answer === "declined" ? 0 : 1);
      }

      const text =
        options.message?.slice(0, 2000) ||
        `Approved with nemar admin pr-reviews approve after reading the automated review (${VERDICT_WORD[verdict]}).`;
      const approved = await submitApproval(token, dataset, pr, head, me.user.login, text, base);
      if (!approved.ok) die(`Not approved: ${approved.reason}`);
      console.log(
        chalk.green(`Approved ${dataset} #${pr} at ${short(head)} as @${me.user.login}.`),
      );

      if (!options.merge) {
        console.log(chalk.dim("  It is not merged. Re-run with --merge, or merge it on GitHub."));
        return;
      }
      const merged = await mergeWhenClean(token, dataset, pr, head, method, { base });
      if (!merged.ok) {
        console.log(chalk.yellow(merged.reason));
        process.exit(1);
      }
      console.log(chalk.green(`Merged ${dataset} #${pr} (${method}).`));
    },
  );

/** When there is no safe way to approve from here: where to do it by hand. */
function manualFallback(dataset: string, pr: number, url: string): void {
  console.log();
  console.log("Approve it yourself, as you:");
  console.log(`  ${url}`);
  console.log(`  ${manualApprovalCommand(dataset, pr)}`);
  if (process.stdout.isTTY) openInBrowser(url);
}

// -- allow / block / clear / standing -----------------------------------------------------------

function overrideCommand(mode: "allow" | "block"): void {
  prReviewsCommand
    .command(`${mode} <login>`)
    .description(
      mode === "allow"
        ? "Always review this contributor's pull requests, whatever their record"
        : "Never review this contributor's pull requests automatically; each needs a person",
    )
    .option("--reason <text>", "Why (kept with the decision, in plain words)")
    .option("--json", "Output the raw JSON")
    .action(async (loginArg: string, options: { reason?: string; json?: boolean }) => {
      if (!requireAuth()) process.exit(1);
      const login = checkLogin(loginArg);
      const spinner = options.json ? null : ora(`Setting ${mode} for ${login}...`).start();
      try {
        const r = await setPrReviewAuthor(login, mode, options.reason);
        spinner?.stop();
        if (options.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        console.log(
          mode === "allow"
            ? chalk.green(
                `Allowed ${plain(r.standing.login)}: their pull requests are reviewed whatever their record.`,
              )
            : chalk.red(
                `Blocked ${plain(r.standing.login)}: none of their pull requests is reviewed automatically; each needs a person.`,
              ),
        );
        if (r.previous && r.previous !== mode)
          console.log(chalk.dim(`  (it was ${r.previous} before)`));
        console.log(chalk.dim("  Pull requests they already opened keep the review they have."));
        console.log();
        for (const l of standingLines(r.standing)) console.log(l);
        envNote(r.environment);
      } catch (err) {
        failApi(err, spinner, `Could not ${mode} ${login}`);
      }
    });
}

overrideCommand("allow");
overrideCommand("block");

prReviewsCommand
  .command("clear <login>")
  .description("Remove an allow or block, so the contributor's record decides again")
  .option("--json", "Output the raw JSON")
  .action(async (loginArg: string, options: { json?: boolean }) => {
    if (!requireAuth()) process.exit(1);
    const login = checkLogin(loginArg);
    const spinner = options.json ? null : ora(`Clearing ${login}...`).start();
    try {
      const r = await clearPrReviewAuthor(login);
      spinner?.stop();
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(
        r.removed
          ? chalk.green(
              `Removed the ${r.removed} for ${plain(r.standing.login)}. Their record decides again.`,
            )
          : chalk.dim(`${plain(r.standing.login)} had no allow or block.`),
      );
      console.log();
      for (const l of standingLines(r.standing)) console.log(l);
      envNote(r.environment);
    } catch (err) {
      failApi(err, spinner, `Could not clear ${login}`);
    }
  });

prReviewsCommand
  .command("standing <login>")
  .description(
    "A contributor's rejected-pull-request record, any allow or block, and what it means",
  )
  .option("--json", "Output the raw JSON")
  .action(async (loginArg: string, options: { json?: boolean }) => {
    if (!requireAuth()) process.exit(1);
    const login = checkLogin(loginArg);
    const spinner = options.json ? null : ora(`Reading ${login}...`).start();
    try {
      const s = await getPrReviewAuthor(login);
      spinner?.stop();
      if (options.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      console.log();
      for (const l of standingLines(s)) console.log(l);
      console.log();
    } catch (err) {
      failApi(err, spinner, `Could not read ${login}`);
    }
  });
