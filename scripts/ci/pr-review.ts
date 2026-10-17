#!/usr/bin/env bun
/**
 * The pull-request review job's script (ADR 0092, ADR 0107). Run by the central workflow
 * `run-pr-review.yml` in `nemarDatasets/.github`, after the workflow has claimed the review. This
 * step's environment holds a federated Anthropic identity and the one-shot callback token, and no
 * GitHub credential. The repository was fetched by an earlier step, whose read-only token stays in
 * the clone's git config for the lazy blob reads this script's git calls make; this script never
 * reads it, prints it or sends it.
 *
 *   bun run scripts/ci/pr-review.ts review \
 *     --repo-dir DIR --base SHA --head SHA --fetched-head SHA --pr-json FILE \
 *     --review-id N --dataset nmNNNNNN --environment production|dev
 *
 * The callback token comes from the environment (PR_REVIEW_CALLBACK_TOKEN), never argv. A job that
 * fails before this script can report is reported by the workflow's own curl step, which needs
 * nothing installed.
 *
 * **The order of a review.** The facts first, before any model is asked: the naming rule on the
 * title and on a changed dataset name, and whether there is a description at all. Then the screen
 * (stage 1), which sees the pull request's text and the list of changed files, never a file's
 * content, and may stop only spam. A stop ends the run with a screen report, and no file's content
 * is read. Otherwise the content is read and the review (stage 2) answers. Both stages run at max
 * effort and stream, each under {@link STAGE_BUDGETS}; a refusal or a truncation at either is no
 * verdict, which the Worker publishes as a check that does not pass and needs a person.
 *
 * **Nothing in the dispatch is trusted for a decision.** The pull request is re-read from the API
 * (`--pr-json`): it must still be open, still target `main`, and still be at `--head`, and the
 * ref the workflow fetched must be that same commit. The callback goes to an origin chosen from a
 * fixed table by the environment's NAME, so a payload cannot steer the report to a host of its
 * choosing.
 *
 * **The public log carries no value.** `nemarDatasets/.github` is public, so this prints a review
 * id and a fixed word, never a dataset's content, a pull request's text, or the model's output.
 *
 * Exits 0 when the callback was delivered (whatever it said), 1 when it could not be, and 2 for
 * bad arguments or a missing callback token.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { namingProblemOf } from "../../shared/naming-rule";
import {
  type PrReviewReport,
  PrReviewReportError,
  type RunError,
  type StageTokens,
} from "../../shared/pr-review";
import {
  EvidenceError,
  type Listing,
  SHA40,
  type TextFacts,
  buildEvidence,
  buildScreenEvidence,
  gatherContent,
  gatherListing,
} from "./pr-review-evidence";
import {
  REVIEW_MODEL,
  REVIEW_OUTPUT_SCHEMA,
  SCREEN_MODEL,
  SCREEN_OUTPUT_SCHEMA,
  assembleReport,
  buildReviewMessages,
  buildScreenMessages,
  readScreenAnswer,
} from "./pr-review-prompt";

/** The API origin for each environment NAME. A payload never supplies a URL. */
export const CALLBACK_ORIGINS = {
  production: "https://api.nemar.org",
  dev: "https://api-test.nemar.org",
} as const;
export type Environment = keyof typeof CALLBACK_ORIGINS;

const DATASET_ID = /^(nm|xx|on)\d{6}$/;

/** A change this large is not reviewed by a model; a person has to look. */
export const MAX_REVIEWABLE_FILES = 500_000;

/** The two model calls of a review. */
export const STAGES = ["screen", "review"] as const;
export type Stage = (typeof STAGES)[number];

/** Both stages think as long as they need to: thinking cannot be turned off at this effort. */
export const EFFORT = "max" as const;

/**
 * What each stage may spend. `maxTokens` is the output budget, which the model's thinking counts
 * toward; `timeoutMs` bounds each attempt's wait for the response to begin (the SDK's own timeout);
 * `deadlineMs` bounds the whole stage, every attempt and the streamed answer together, through an
 * abort signal, because a stream that has begun is not bounded by the SDK's timeout at all.
 * `maxRetries` is the SDK's retry count for a failure it may retry (a 5xx, a 429, a lost connection).
 * The workflow test keeps the worst case, both deadlines and the callback's retries, inside the job's
 * `timeout-minutes`.
 */
export const STAGE_BUDGETS = {
  screen: {
    model: SCREEN_MODEL,
    maxTokens: 32_000,
    timeoutMs: 90_000,
    deadlineMs: 4 * 60_000,
    maxRetries: 1,
  },
  review: {
    model: REVIEW_MODEL,
    maxTokens: 32_000,
    timeoutMs: 120_000,
    deadlineMs: 11 * 60_000,
    maxRetries: 1,
  },
} as const satisfies Record<
  Stage,
  { model: string; maxTokens: number; timeoutMs: number; deadlineMs: number; maxRetries: number }
>;

const STAGE_SCHEMAS: Record<Stage, Record<string, unknown>> = {
  screen: SCREEN_OUTPUT_SCHEMA,
  review: REVIEW_OUTPUT_SCHEMA,
};

/** A shorter deadline for a test of what a stalled stream comes to; production never sets one. */
let deadlineOverrides: Partial<Record<Stage, number>> = {};

export function __setStageDeadlinesForTests(ms: Partial<Record<Stage, number>> | null): void {
  deadlineOverrides = ms ?? {};
}

/** How the callback is retried: the attempts, and the timeout of each. See {@link postCallback}. */
export const CALLBACK_ATTEMPTS = 4;
export const CALLBACK_TIMEOUT_MS = 60_000;

export type ReviewResult =
  | { outcome: "reported"; report: PrReviewReport }
  | { outcome: "error"; error: RunError; diag?: string };

class RunFailure extends Error {
  readonly error: RunError;
  constructor(error: RunError) {
    super(error);
    this.error = error;
  }
}

export interface ReviewArgs {
  repoDir: string;
  base: string;
  head: string;
  fetchedHead: string;
  prJson: string;
}

/** Map anything that went wrong to a fixed word. The error's text is never forwarded. */
export function mapError(e: unknown): RunError {
  if (e instanceof RunFailure) return e.error;
  if (e instanceof EvidenceError) return "evidence_unavailable";
  // Our own evidence block failing the parser is a bug on this side, not the model's doing.
  if (e instanceof PrReviewReportError) {
    return e.code === "bad_evidence" ? "report_invalid" : "model_invalid";
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return "auth_failed";
  }
  // The SDK's federation failures (an identity token it cannot read, an exchange the rule
  // rejects) are plain AnthropicErrors named "Error", not API errors: there is no HTTP response of
  // the messages API yet.
  if (e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)) {
    return "auth_failed";
  }
  if (e instanceof Anthropic.BadRequestError) return "model_invalid";
  // A stage that ran past its deadline is aborted by its signal, which the SDK reports as a user
  // abort: the model did not finish in time, which is the same answer as an unavailable one.
  if (e instanceof Anthropic.APIError) return "model_unavailable";
  return "workflow_failed";
}

/**
 * Why a run failed, in words that are safe in a public log: class names the SDK and this module
 * define, HTTP status numbers, parser codes, and the fixed strings of {@link EvidenceError}. Never
 * the text of an error that could carry pull request content.
 */
export function describeError(e: unknown): string {
  const cls = e instanceof Error ? e.constructor.name : typeof e;
  if (e instanceof Anthropic.APIError) return `${cls} status=${e.status ?? "none"}`;
  if (e instanceof PrReviewReportError) return `${cls} code=${e.code}`;
  if (e instanceof EvidenceError) return `${cls}: ${e.message}`;
  if (e instanceof RunFailure) return `${cls} ${e.error}`;
  return cls;
}

/** What one stage's call came to, for an observer: the calibration's timing and token table. */
export interface StageObservation {
  stage: Stage;
  model: string;
  /** Milliseconds from the request to the end of the answer, or to the failure. */
  ms: number;
  /** The tokens the API said the call used; null when no answer arrived. */
  usage: StageTokens | null;
  /** How the call ended: `ok`, or the run error it became. */
  result: "ok" | RunError;
}

export type StageObserver = (o: StageObservation) => void;

/** What a stage answered: the model's JSON, and what it cost. */
export interface StageAnswer {
  output: unknown;
  usage: StageTokens;
}

/**
 * One call to one stage's model: max effort, a schema-constrained answer, streamed, no tools. The
 * model can read the prompt and write a JSON object; it cannot do anything else. A refusal and a
 * truncation are run errors (`model_refused`, `model_truncated`): no verdict, never a pass.
 */
export async function callStage(
  stage: Stage,
  system: string,
  user: string,
  observe?: StageObserver,
): Promise<StageAnswer> {
  const budget = STAGE_BUDGETS[stage];
  const started = performance.now();
  let usage: StageTokens | null = null;
  const report = (result: "ok" | RunError) =>
    observe?.({
      stage,
      model: budget.model,
      ms: Math.round(performance.now() - started),
      usage,
      result,
    });
  try {
    // A client given no credentials resolves workload identity federation from the environment
    // (ANTHROPIC_FEDERATION_RULE_ID, _ORGANIZATION_ID, _SERVICE_ACCOUNT_ID, _WORKSPACE_ID and
    // ANTHROPIC_IDENTITY_TOKEN_FILE), exchanges the job's OIDC token, and refreshes it.
    const client = new Anthropic({ maxRetries: budget.maxRetries, timeout: budget.timeoutMs });
    const res = await client.messages
      .stream(
        {
          model: budget.model,
          max_tokens: budget.maxTokens,
          system,
          messages: [{ role: "user", content: user }],
          output_config: {
            effort: EFFORT,
            format: { type: "json_schema", schema: STAGE_SCHEMAS[stage] },
          },
        },
        { signal: AbortSignal.timeout(deadlineOverrides[stage] ?? budget.deadlineMs) },
      )
      .finalMessage();
    usage = { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
    if (res.stop_reason === "refusal") throw new RunFailure("model_refused");
    if (res.stop_reason === "max_tokens") throw new RunFailure("model_truncated");
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new RunFailure("model_invalid");
    let output: unknown;
    try {
      output = JSON.parse(text.text);
    } catch {
      throw new RunFailure("model_invalid");
    }
    report("ok");
    return { output, usage };
  } catch (e) {
    report(mapError(e));
    throw e;
  }
}

interface PullRequestJson {
  state?: unknown;
  title?: unknown;
  body?: unknown;
  author_association?: unknown;
  base?: { ref?: unknown; repo?: { full_name?: unknown } };
  head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
}

/**
 * The facts decided before any model is asked (ADR 0107), from the pull request as the API returns
 * it and from the listing: whether the description is empty, how the title breaks the naming rule,
 * and how the dataset's name breaks it when the pull request changes the name. The rule is the
 * shared one the CLI and the Worker use; nothing here is a judgment.
 */
export function textFactsOf(pr: { title?: unknown; body?: unknown }, listing: Listing): TextFacts {
  const changedName =
    listing.nameAfter !== null && listing.nameAfter !== listing.nameBefore
      ? listing.nameAfter
      : null;
  return {
    descriptionEmpty: typeof pr.body !== "string" || pr.body.trim() === "",
    titleProblem: namingProblemOf(typeof pr.title === "string" ? pr.title : ""),
    nameProblem: changedName === null ? null : namingProblemOf(changedName),
  };
}

/** What the stage flow needs about a pull request: where its commits are, and its own text. */
export interface PullRequestUnderReview {
  repoDir: string;
  /** The tip of `main` the pull request is compared against (through the merge base). */
  base: string;
  head: string;
  /** The pull request as the API returns it: its title, its description, its author's label. */
  pr: { title?: unknown; body?: unknown; author_association?: unknown };
  fromFork: boolean;
}

/**
 * The stage flow, for a pull request whose commits and text are known: the facts first, then the
 * screen, and the review only when the screen let it through. Throws what it meets; {@link
 * runReview} turns that into a fixed word. The calibration runs exactly this, on pull requests that
 * are no longer open, which is why the dispatch's own checks are not part of it.
 */
export async function reviewPullRequest(
  input: PullRequestUnderReview,
  observe?: StageObserver,
): Promise<PrReviewReport> {
  const { repoDir, base, head, pr, fromFork } = input;
  const text = { title: pr.title, body: pr.body };

  // What the screen is shown, with no file's content read but dataset_description.json's.
  const listing = gatherListing(repoDir, base, head);
  if (listing.changes.length > MAX_REVIEWABLE_FILES) throw new RunFailure("too_large");
  // The facts, before any model call.
  const facts = textFactsOf(pr, listing);

  const screenMessages = buildScreenMessages({
    listing,
    pr: text,
    fromFork,
    authorAssociation: typeof pr.author_association === "string" ? pr.author_association : null,
    nonce: randomUUID().replaceAll("-", ""),
  });
  const screen = await callStage("screen", screenMessages.system, screenMessages.user, observe);
  if (readScreenAnswer(screen.output).decision === "reject") {
    return assembleReport(screen.output, null, buildScreenEvidence(listing, facts), {
      screen: screen.usage,
      review: null,
    });
  }

  const all = { ...listing, ...gatherContent(repoDir, listing) };
  const evidence = buildEvidence(all, facts);
  const reviewMessages = buildReviewMessages({
    facts: all,
    evidence,
    pr: text,
    fromFork,
    nonce: randomUUID().replaceAll("-", ""),
  });
  const review = await callStage("review", reviewMessages.system, reviewMessages.user, observe);
  return assembleReport(screen.output, review.output, evidence, {
    screen: screen.usage,
    review: review.usage,
  });
}

/** Review one pull request. Never throws: every failure is a fixed word. */
export async function runReview(args: ReviewArgs, observe?: StageObserver): Promise<ReviewResult> {
  try {
    if (!SHA40.test(args.base) || !SHA40.test(args.head) || !SHA40.test(args.fetchedHead)) {
      throw new RunFailure("evidence_unavailable");
    }
    let pr: PullRequestJson;
    try {
      pr = JSON.parse(readFileSync(args.prJson, "utf8")) as PullRequestJson;
    } catch {
      throw new RunFailure("evidence_unavailable");
    }
    // The pull request moved on, closed, or retargeted since it was dispatched: the review is
    // for a commit nobody will merge.
    if (
      pr.state !== "open" ||
      pr.base?.ref !== "main" ||
      pr.head?.sha !== args.head ||
      args.fetchedHead !== args.head
    ) {
      throw new RunFailure("stale_head");
    }
    const report = await reviewPullRequest(
      { repoDir: args.repoDir, base: args.base, head: args.head, pr, fromFork: isFromFork(pr) },
      observe,
    );
    return { outcome: "reported", report };
  } catch (e) {
    return { outcome: "error", error: mapError(e), diag: describeError(e) };
  }
}

/** Whether the pull request's head lives in another repository; a deleted fork's head reads as one. */
export function isFromFork(pr: {
  base?: { repo?: { full_name?: unknown } };
  head?: { repo?: { full_name?: unknown } | null };
}): boolean {
  return (
    typeof pr.head?.repo?.full_name !== "string" ||
    typeof pr.base?.repo?.full_name !== "string" ||
    pr.head.repo.full_name.toLowerCase() !== pr.base.repo.full_name.toLowerCase()
  );
}

/** The pause before each retry of the callback: 2, 4, then 8 seconds. */
export function callbackBackoffMs(attempt: number): number {
  return 2 ** attempt * 1000;
}

/** POST the result, retrying a network failure or a 5xx. A 4xx will not improve and is not retried. */
export async function postCallback(
  origin: string,
  token: string,
  body: Record<string, unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ delivered: boolean; status: number | null }> {
  let status: number | null = null;
  for (let attempt = 0; attempt < CALLBACK_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(callbackBackoffMs(attempt));
    try {
      const res = await fetch(`${origin}/webhooks/pr-review-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
        body: JSON.stringify(body),
        // The Worker publishes the check and the comment before it answers.
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      status = res.status;
      if (res.ok) return { delivered: true, status };
      if (res.status < 500) return { delivered: false, status };
    } catch {
      status = null;
    }
  }
  return { delivered: false, status };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function need(argv: string[], name: string): string {
  const v = flag(argv, name);
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

/**
 * Run the script. `origins` is the callback table; production code never passes it, and a test
 * points it at a server of its own, which is the only way to run this end to end without sending
 * a report to a real Worker.
 */
export async function main(
  argv: string[],
  origins: Record<Environment, string> = CALLBACK_ORIGINS,
): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd !== "review") {
    console.error("usage: pr-review.ts review ...");
    return 2;
  }
  const dataset = need(rest, "dataset");
  const reviewId = Number(need(rest, "review-id"));
  const environment = need(rest, "environment");
  const token = process.env.PR_REVIEW_CALLBACK_TOKEN;
  if (!DATASET_ID.test(dataset) || !Number.isSafeInteger(reviewId) || reviewId < 1) {
    console.error("bad --dataset or --review-id");
    return 2;
  }
  if (environment !== "production" && environment !== "dev") {
    console.error("bad --environment");
    return 2;
  }
  if (!token) {
    console.error("PR_REVIEW_CALLBACK_TOKEN is unset");
    return 2;
  }

  const result: ReviewResult = await runReview({
    repoDir: need(rest, "repo-dir"),
    base: need(rest, "base"),
    head: need(rest, "head"),
    fetchedHead: need(rest, "fetched-head"),
    prJson: need(rest, "pr-json"),
  });

  const body: Record<string, unknown> = {
    review_id: reviewId,
    dataset_id: dataset,
    outcome: result.outcome,
    ...(result.outcome === "reported" ? { report: result.report } : { error: result.error }),
  };
  const sent = await postCallback(origins[environment], token, body);
  // A review id and fixed words only: this log is public. A report's stage is a fixed word too.
  const stage =
    result.outcome === "reported" && result.report.v === 2 ? ` at ${result.report.stage}` : "";
  console.log(
    `review ${reviewId}: ${result.outcome}${stage}${result.outcome === "error" ? ` (${result.error}${result.diag ? `; ${result.diag}` : ""})` : ""}; callback ${
      sent.delivered ? "delivered" : `not delivered (${sent.status ?? "no response"})`
    }`,
  );
  return sent.delivered ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      // A fixed word: the text of an unexpected error is not ours to put in a public log.
      console.error(`pr-review failed: ${e instanceof Error ? e.constructor.name : "unknown"}`);
      process.exit(1);
    });
}
