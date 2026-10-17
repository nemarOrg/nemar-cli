#!/usr/bin/env bun
/**
 * The pull-request review's offline calibration (ADR 0107; the calibration gate the plan names G1).
 *
 * Before the review check is required, someone has to know how its two stages answer real pull
 * requests: how often a legitimate one is stopped or failed, what each stage costs, and how long
 * each takes. This reads named pull requests with `gh` and `git` (read-only), runs the review job's
 * own stage flow on each with the operator's own Anthropic credential, and prints a table.
 *
 *   bun run scripts/ci/pr-review-calibrate.ts --pr nm000153#2 --pr nemarDatasets/nm000456#1
 *   bun run scripts/ci/pr-review-calibrate.ts --prs FILE [--json]
 *
 * FILE holds one pull request per line, `nm000153#2`, optionally followed by the outcome a person
 * expects (`pass`, `fail` or `uncertain`), which adds an agreement column. Blank lines and lines that
 * start with `#` are skipped.
 *
 * **It measures what production does, because it runs what production runs.** Each pull request
 * goes through `reviewPullRequest` in `pr-review.ts`: the same facts, the same screen and review,
 * the same models, budgets and prompts, the same report assembly. Only the dispatch's own checks
 * are left out (the pull request must still be open, at the dispatched commit), because a
 * calibration reads pull requests that were merged or closed long ago. The base is the one GitHub
 * recorded on the pull request, so a merged pull request is judged on what it changed then.
 *
 * **It posts nothing.** It never imports the review's callback poster or the callback origin table,
 * it refuses every argument that names a review, an environment or an origin, and it refuses to run
 * where the review's callback token is set. Its network traffic is `gh api` reads, `git fetch` of a
 * public dataset repository, and the model calls.
 *
 * **The operator's key reaches only the API.** It refuses to run while `ANTHROPIC_BASE_URL` or
 * `ANTHROPIC_AUTH_TOKEN` is set (a shell that points the SDK at a gateway would hand it the key),
 * and says which by name, never by value.
 *
 * **What the table holds.** Closed words, counts, token counts, seconds and an estimate in dollars,
 * never a pull request's text or a word a model wrote, so it can be pasted anywhere.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Criterion,
  type PrReviewReport,
  type RunError,
  type StageTokens,
  type Verdict,
  conclusionOf,
  estimateCostUsd,
  factsOf,
  verdictOf,
} from "../../shared/pr-review";
import {
  STAGE_BUDGETS,
  type StageObservation,
  isFromFork,
  mapError,
  reviewPullRequest,
} from "./pr-review";

/** One pull request to calibrate on, and what a person expects of it, if they said. */
export interface CalibrationTarget {
  dataset: string;
  number: number;
  expected: Verdict | null;
}

/** What one pull request came to, in closed words and numbers. */
export interface CalibrationRow {
  pr: string;
  expected: Verdict | null;
  /** The facts the script decided before any model: closed words, or `none`. */
  facts: string[];
  files: number | null;
  stage: "screen" | "full" | null;
  /** The screen's decision, or what stopped it. */
  screen: "proceed" | "reject" | RunError | null;
  /** The criteria after the facts, in the report's order; null with no report. */
  criteria: Partial<Record<Criterion, string>> | null;
  verdict: Verdict | null;
  check: string | null;
  /** Why no report was made: a run error, or what could not be read before the review began. */
  error: string | null;
  screenTokens: StageTokens | null;
  reviewTokens: StageTokens | null;
  screenSeconds: number | null;
  reviewSeconds: number | null;
  costUsd: number | null;
}

const PR_REF = /^(?:nemarDatasets\/)?((?:nm|xx|on)\d{6})#(\d{1,9})$/;
const SHA40 = /^[0-9a-f]{40}$/;
const VERDICT_WORDS = ["pass", "fail", "uncertain"] as const;

/** Read `nm000153#2` (or `nemarDatasets/nm000153#2`) and an optional expected outcome. */
export function parseTarget(line: string): CalibrationTarget | null {
  const [ref, expected, ...rest] = line.trim().split(/\s+/);
  if (ref === undefined || rest.length > 0) return null;
  const m = ref.match(PR_REF);
  if (!m?.[1] || !m[2]) return null;
  if (expected !== undefined && !(VERDICT_WORDS as readonly string[]).includes(expected)) {
    return null;
  }
  return { dataset: m[1], number: Number(m[2]), expected: (expected as Verdict) ?? null };
}

/** The review's own arguments, and anything that would name somewhere to post. All refused. */
const REFUSED_FLAGS = new Set([
  "environment",
  "callback-url",
  "callback-token",
  "origin",
  "token",
  "review-id",
  "dataset",
  "repo-dir",
  "base",
  "head",
  "fetched-head",
  "pr-json",
]);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface FetchedPullRequest {
  dir: string;
  base: string;
  head: string;
  pr: Record<string, unknown>;
}

/**
 * Read the pull request with `gh api` and fetch its base and head as git data, the way the
 * workflow does: `git init` and a blob-less `git fetch`, never a checkout, so nothing in the pull
 * request runs. The base is the one GitHub recorded on the pull request.
 */
function fetchPullRequest(t: CalibrationTarget, root: string): FetchedPullRequest {
  const raw = run("gh", ["api", `repos/nemarDatasets/${t.dataset}/pulls/${t.number}`]);
  const pr = JSON.parse(raw) as Record<string, unknown>;
  const base = (pr.base as { sha?: unknown } | undefined)?.sha;
  const head = (pr.head as { sha?: unknown } | undefined)?.sha;
  if (
    typeof base !== "string" ||
    !SHA40.test(base) ||
    typeof head !== "string" ||
    !SHA40.test(head)
  ) {
    throw new Error("the pull request names no base or head commit");
  }
  const dir = join(root, `${t.dataset}-${t.number}`);
  run("git", ["init", "-q", dir]);
  run("git", ["-C", dir, "config", "core.hooksPath", "/dev/null"]);
  // A named promisor remote, as the workflow sets it up, so the blob-less clone fetches a blob the
  // evidence reader asks for when it asks.
  run("git", [
    "-C",
    dir,
    "remote",
    "add",
    "origin",
    `https://github.com/nemarDatasets/${t.dataset}.git`,
  ]);
  run("git", ["-C", dir, "config", "extensions.partialClone", "origin"]);
  run("git", [
    "-C",
    dir,
    "fetch",
    "-q",
    "--no-tags",
    "--filter=blob:none",
    "origin",
    `+refs/pull/${t.number}/head:refs/remotes/pr/head`,
    base,
  ]);
  return { dir, base, head, pr };
}

function sum(tokens: Array<StageTokens | null>): StageTokens | null {
  const present = tokens.filter((t): t is StageTokens => t !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => ({
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }));
}

/** The facts a report decided before any model, as closed words. */
function factWords(report: PrReviewReport): string[] {
  if (report.v !== 2) return [];
  const out: string[] = [];
  if (report.evidence.description_empty) out.push("description_empty");
  if (report.evidence.title_problem) out.push(`title_${report.evidence.title_problem}`);
  if (report.evidence.name_problem) out.push(`name_${report.evidence.name_problem}`);
  return out;
}

/**
 * Calibrate on one pull request. Never throws: what went wrong is a closed word in the row. `read`
 * is where the pull request comes from: GitHub, through `gh` and `git`, unless a test hands it a
 * repository of its own; the review itself is always the job's.
 */
export async function calibrateOne(
  t: CalibrationTarget,
  root: string,
  read: (t: CalibrationTarget, root: string) => FetchedPullRequest = fetchPullRequest,
): Promise<CalibrationRow> {
  const row: CalibrationRow = {
    pr: `${t.dataset}#${t.number}`,
    expected: t.expected,
    facts: [],
    files: null,
    stage: null,
    screen: null,
    criteria: null,
    verdict: null,
    check: null,
    error: null,
    screenTokens: null,
    reviewTokens: null,
    screenSeconds: null,
    reviewSeconds: null,
    costUsd: null,
  };
  let fetched: FetchedPullRequest;
  try {
    fetched = read(t, root);
  } catch {
    row.error = "not_readable";
    return row;
  }
  const observe = (o: StageObservation) => {
    const seconds = Math.round(o.ms / 100) / 10;
    if (o.stage === "screen") {
      row.screenTokens = o.usage;
      row.screenSeconds = seconds;
      if (o.result !== "ok") row.screen = o.result;
    } else {
      // The review runs only after the screen let the pull request through.
      row.screen = "proceed";
      row.reviewTokens = o.usage;
      row.reviewSeconds = seconds;
    }
  };
  try {
    const report = await reviewPullRequest(
      {
        repoDir: fetched.dir,
        base: fetched.base,
        head: fetched.head,
        pr: fetched.pr,
        fromFork: isFromFork(fetched.pr),
      },
      observe,
    );
    row.files = report.evidence.files_changed;
    row.facts = factWords(report);
    if (report.v === 2) {
      row.stage = report.stage;
      row.screen = report.stage === "screen" ? "reject" : "proceed";
    }
    row.criteria = factsOf(report).criteria;
    row.verdict = verdictOf(report);
    row.check = conclusionOf({ kind: "reported", report });
  } catch (e) {
    row.error = mapError(e);
  }
  row.costUsd =
    row.screenTokens === null && row.reviewTokens === null
      ? null
      : estimateCostUsd({
          screen_input: row.screenTokens?.input_tokens ?? 0,
          screen_output: row.screenTokens?.output_tokens ?? 0,
          review_input: row.reviewTokens?.input_tokens ?? 0,
          review_output: row.reviewTokens?.output_tokens ?? 0,
        });
  return row;
}

const SHORT: Record<string, string> = {
  pass: "pass",
  fail: "FAIL",
  unknown: "?",
};

/** The criteria a person reads first, in the column order of the table. */
const COLUMNS: ReadonlyArray<[Criterion, string]> = [
  ["no_degradation", "lost"],
  ["advances_revision", "rev"],
  ["material_improvement", "better"],
  ["clear_title_and_description", "text"],
  ["description_not_misleading", "honest"],
];

function tokens(t: StageTokens | null): string {
  return t === null ? "-" : `${t.input_tokens}/${t.output_tokens}`;
}

/** The table, one pull request per line, with a header and a total. Pure. */
export function renderTable(rows: readonly CalibrationRow[]): string[] {
  const cells = rows.map((r) => {
    const answers = r.criteria
      ? COLUMNS.map(([c]) => SHORT[r.criteria?.[c] ?? "unknown"] ?? "?").join(" ")
      : "-";
    const agrees = r.expected === null ? "" : r.verdict === r.expected ? "yes" : "NO";
    return [
      r.pr,
      r.files === null ? "-" : String(r.files),
      r.facts.length > 0 ? r.facts.join(",") : "none",
      r.screen ?? "-",
      answers,
      r.verdict ?? `no verdict (${r.error ?? "unknown"})`,
      r.check ?? "-",
      ...(rows.some((x) => x.expected !== null) ? [r.expected ?? "-", agrees] : []),
      `${tokens(r.screenTokens)} | ${tokens(r.reviewTokens)}`,
      `${r.screenSeconds ?? "-"} | ${r.reviewSeconds ?? "-"}`,
      r.costUsd === null ? "-" : `$${r.costUsd.toFixed(2)}`,
    ];
  });
  const header = [
    "PR",
    "FILES",
    "FACTS",
    "SCREEN",
    `REVIEW (${COLUMNS.map(([, h]) => h).join(" ")})`,
    "VERDICT",
    "CHECK",
    ...(rows.some((x) => x.expected !== null) ? ["EXPECTED", "AGREES"] : []),
    "TOKENS IN/OUT (screen | review)",
    "SECONDS (screen | review)",
    "COST",
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  const line = (c: string[]) =>
    c
      .map((x, i) => x.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const total = rows.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const tokensUsed = sum(rows.flatMap((r) => [r.screenTokens, r.reviewTokens]));
  return [
    line(header),
    ...cells.map(line),
    "",
    `${rows.length} pull request${rows.length === 1 ? "" : "s"}; screen ${STAGE_BUDGETS.screen.model}, review ${STAGE_BUDGETS.review.model}, both at max effort; ${tokensUsed === null ? "no tokens reported" : `${tokensUsed.input_tokens} tokens in, ${tokensUsed.output_tokens} out`}; about $${total.toFixed(2)} at list prices.`,
    "Review columns, after the facts: lost = nothing is lost or broken, rev = the revision advances, better = materially better, text = the title and description say what changed, honest = the description is not misleading. pass, FAIL, or ? for could not tell (or not assessed when the screen stopped it).",
  ];
}

function usage(why: string): number {
  console.error(`pr-review-calibrate: ${why}`);
  console.error(
    "usage: pr-review-calibrate.ts (--pr nm000153#2 ... | --prs FILE) [--json]\n" +
      "       FILE: one pull request per line, optionally followed by pass, fail or uncertain",
  );
  return 2;
}

/** Read the arguments, refuse what would post or leak the key, calibrate, and print. */
export async function calibrateMain(
  argv: readonly string[],
  out: (line: string) => void = (l) => console.log(l),
): Promise<number> {
  if (process.env.PR_REVIEW_CALLBACK_TOKEN) {
    return usage("a review's callback token is set here; calibrate posts nothing and will not run");
  }
  const redirecting = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"].filter(
    (name) => process.env[name] !== undefined,
  );
  if (redirecting.length > 0) {
    return usage(
      `${redirecting.join(" and ")} ${redirecting.length === 1 ? "is" : "are"} set; unset ${redirecting.length === 1 ? "it" : "them"} so the key goes only to the Anthropic API`,
    );
  }
  const targets: CalibrationTarget[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name === null) return usage(`unexpected argument ${JSON.stringify(arg)}`);
    if (REFUSED_FLAGS.has(name)) {
      return usage(`--${name} is refused: calibrate posts nothing and reviews no dispatch`);
    }
    if (name === "json") {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return usage(`--${name} needs a value`);
    i++;
    if (name === "pr") {
      const t = parseTarget(value);
      if (t === null)
        return usage(`${JSON.stringify(value)} is not a pull request like nm000153#2`);
      targets.push(t);
    } else if (name === "prs") {
      let text: string;
      try {
        text = await Bun.file(value).text();
      } catch {
        return usage("the pull request file could not be read");
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "" || line.trim().startsWith("#")) continue;
        const t = parseTarget(line);
        if (t === null)
          return usage(`${JSON.stringify(line.trim())} is not a line like nm000153#2 pass`);
        targets.push(t);
      }
    } else {
      return usage(`unknown argument --${name}`);
    }
  }
  if (targets.length === 0) return usage("name at least one pull request");

  const root = mkdtempSync(join(tmpdir(), "pr-review-calibrate-"));
  try {
    const rows: CalibrationRow[] = [];
    for (const t of targets) rows.push(await calibrateOne(t, root));
    if (json) out(JSON.stringify(rows, null, 2));
    else for (const line of renderTable(rows)) out(line);
    // A run in which no pull request reached a verdict is a failure, whatever the reason.
    return rows.every((r) => r.verdict === null) ? 1 : 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  calibrateMain(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(
        `pr-review-calibrate failed: ${e instanceof Error ? e.constructor.name : "unknown"}`,
      );
      process.exit(1);
    });
}

export { fetchPullRequest };
