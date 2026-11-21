/**
 * The RFC clock in the weekly import report (RFC program card R3, risk K1; ADR 0054).
 *
 * `nemarOrg/rfcs` holds the Requests for Comment (RFCs): the record, the generated index in its
 * `README.md`, and the `rfc-clock` workflow that locks a thread at its close. A scheduled workflow
 * in a public repository is switched off by GitHub after 60 days without repository activity, and
 * a clock that stopped is silent. This module is how the weekly report makes that visible within a
 * week: it lists every RFC that is open or closed awaiting a decision, and says when `rfc-clock`
 * last ran and whether GitHub still has it enabled.
 *
 * ## Three reads of a public repository
 *
 *  1. the README, whose generated index (between two markers) is the record: `rfc-check` refuses a
 *     pull request that leaves it stale, so this module reads it and never the `text/` files, and
 *     never copies the function that derives an RFC's state;
 *  2. the workflow, for its `state` (`active`, or `disabled_inactivity`, `disabled_manually`, ...);
 *  3. the newest run of the workflow, for when it ran and how it ended.
 *
 * Each read is its own try. A read that fails leaves its part `null`, which renders as unknown and
 * asks for attention, never as zero. A README without both markers, or a table this parser cannot
 * read, is a failed read and never an empty list: only the generator's own sentence for an empty
 * list is an empty list.
 *
 * ## The token
 *
 * The repository is public, so the reads need none; the run's installation token is offered first
 * because an authenticated request is not limited as an anonymous one is. A token that cannot be
 * obtained sends the reads without one, and a read the token is refused (401, 403 or 404, which an
 * installation token for another organization can draw on a public repository) is retried once
 * without it.
 *
 * Counts and RFC numbers and titles only: the RFCs are public records in a public repository, and
 * every word printed from GitHub's answer is checked against a closed shape first.
 */

import type {
  RfcClockRun,
  RfcIndexReading,
  RfcListed,
  RfcWeekFacts,
} from "../../../shared/contract/weekly-attention.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import { GITHUB_API } from "./github/shared.js";

export type { RfcClockRun, RfcIndexReading, RfcListed, RfcWeekFacts };

export const RFC_REPO = "nemarOrg/rfcs";
export const RFC_CLOCK_WORKFLOW = "rfc-clock.yml";
export const RFC_INDEX_START = "<!-- rfc-index:start -->";
export const RFC_INDEX_END = "<!-- rfc-index:end -->";
/** The generator's sentence for an index with no record (`generateIndex` in nemarOrg/rfcs). */
export const RFC_INDEX_EMPTY = "No RFC has been proposed yet.";

/** The decision is due within 14 days of the close (PROCESS.md, "The decision"). */
export const RFC_DECISION_DAYS = 14;
/** A clock whose newest run is older than this is not running daily (the cron is daily). */
export const RFC_CLOCK_STALE_HOURS = 48;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const READ_TIMEOUT_MS = 15_000;
const USER_AGENT = "nemar-weekly-report";
const RUN_URL_RE = /^https:\/\/github\.com\/nemarOrg\/rfcs\/actions\/runs\/\d+$/;

/** The index header, as the generator writes it (`HEADER` in nemarOrg/rfcs `src/index-gen.ts`). */
const INDEX_COLUMNS = [
  "Number",
  "Title",
  "Scope",
  "Opened (UTC)",
  "Closes (UTC)",
  "Decision",
  "Thread",
] as const;

const DECISIONS = ["draft", "pending", "accepted", "rejected", "withdrawn"] as const;
type IndexDecision = (typeof DECISIONS)[number];

// ============================================================================
// Pure parsing
// ============================================================================

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function minuteUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16)}:00Z`;
}

/** A word that comes from GitHub or from a record, printed only if it has a plain shape. */
function plainWord(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z_]{0,39}$/.test(value) ? value : null;
}

/**
 * An RFC title for a public report: one line, with no backtick (the report prints it INSIDE a code
 * span, where emphasis, entities, autolinks, escapes and a leading `!` are all literal), no pipe
 * (it is a table cell), and no `@` or `#N` that GitHub could turn into a mention or an issue link
 * were the title ever printed outside a code span.
 */
export function rfcReportTitle(raw: string): string {
  const text = Array.from(raw)
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .replace(/[`<>[\]|]/g, "")
    .replace(/@/g, "(at)")
    .replace(/#(?=\d)/g, "no. ")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = Array.from(text).slice(0, 120).join("");
  return clipped.length === text.length ? clipped : `${clipped}...`;
}

/** The cells of one table row, with the generator's `\|` escape undone. */
function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.length < 2) return null;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}

/**
 * The RFCs the README's generated index lists, as of `now`. Throws when the markers are missing or
 * out of order, or when the table is not the one the generator writes: a reading that is not
 * understood is a failed read, never an empty list.
 */
export function parseRfcIndex(readme: string, now: Date): RfcIndexReading {
  const start = readme.indexOf(RFC_INDEX_START);
  const end = readme.indexOf(RFC_INDEX_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("the README has no RFC index between its two markers");
  }
  const body = readme.slice(start + RFC_INDEX_START.length, end).trim();
  if (body === RFC_INDEX_EMPTY) return { listed: [], drafts: 0, decided: 0 };

  const lines = body.split("\n").map((l) => l.trim());
  const header = splitRow(lines[0] ?? "");
  if (
    header === null ||
    header.length !== INDEX_COLUMNS.length ||
    header.some((c, i) => c !== INDEX_COLUMNS[i])
  ) {
    throw new Error("the RFC index table does not have the columns this report reads");
  }
  const rule = splitRow(lines[1] ?? "");
  if (
    rule === null ||
    rule.length !== INDEX_COLUMNS.length ||
    rule.some((c) => !/^:?-+:?$/.test(c))
  ) {
    throw new Error("the RFC index table has no header rule");
  }
  const rows = lines.slice(2);
  if (rows.length === 0)
    throw new Error("the RFC index table has no rows and is not the empty list");

  const out: RfcIndexReading = { listed: [], drafts: 0, decided: 0 };
  const seen = new Set<string>();
  for (const line of rows) {
    const cells = splitRow(line);
    if (cells === null || cells.length !== INDEX_COLUMNS.length) {
      throw new Error("a row of the RFC index table could not be read");
    }
    const [numberCell, title, , opened, closes, decisionCell] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const number = /^\[(\d{4,6})\]\([^)\s]+\)$/.exec(numberCell)?.[1];
    if (number === undefined || seen.has(number)) {
      throw new Error("a row of the RFC index table has no readable, unique number");
    }
    seen.add(number);
    if (!(DECISIONS as readonly string[]).includes(decisionCell)) {
      throw new Error(`RFC ${number} has a decision this report does not know`);
    }
    const decision = decisionCell as IndexDecision;
    if (decision === "draft") {
      out.drafts++;
    } else if (decision !== "pending") {
      out.decided++;
    } else {
      if (!TIMESTAMP_RE.test(opened) || !TIMESTAMP_RE.test(closes)) {
        throw new Error(`RFC ${number} is pending with no readable open and close instants`);
      }
      const closeMs = Date.parse(closes);
      if (Number.isNaN(closeMs)) throw new Error(`RFC ${number} has a close that is not a time`);
      const dueMs = closeMs + RFC_DECISION_DAYS * DAY_MS;
      out.listed.push({
        number,
        title: rfcReportTitle(title),
        phase: now.getTime() >= closeMs ? "closed" : "open",
        closesAt: minuteUtc(closeMs),
        dueBy: minuteUtc(dueMs),
        overdue: now.getTime() > dueMs,
      });
    }
  }
  return out;
}

/** The workflow's `state` from the `actions/workflows` answer. Throws on any other shape. */
export function parseWorkflowState(json: unknown): { state: string } {
  const state = plainWord((json as { state?: unknown } | null)?.state);
  if (state === null) throw new Error("the workflow answer has no readable state");
  return { state };
}

/** The newest run from the `runs?per_page=1` answer; `null` when the workflow has never run. */
export function parseNewestRun(json: unknown): RfcClockRun | null {
  const runs = (json as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error("the workflow runs answer has no list of runs");
  if (runs.length === 0) return null;
  const run = runs[0] as { created_at?: unknown; conclusion?: unknown; html_url?: unknown } | null;
  const createdAt = run?.created_at;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("the newest workflow run has no readable time");
  }
  const url = run?.html_url;
  const conclusion = run?.conclusion;
  return {
    createdAt: new Date(createdAt).toISOString(),
    // A conclusion of a shape this report does not know is "unreadable", which is not a success.
    conclusion:
      conclusion === null || conclusion === undefined
        ? null
        : (plainWord(conclusion) ?? "unreadable"),
    url: typeof url === "string" && RUN_URL_RE.test(url) ? url : null,
  };
}

/**
 * Why a person should look, as phrases, at the report's instant. An unread part is a reason of its
 * own (unknown is not a clean week); a quiet week with nothing open, an active workflow and a
 * recent run that did not fail gives none.
 */
export function rfcAttention(
  parts: Pick<RfcWeekFacts, "index" | "workflow" | "run">,
  now: Date,
): string[] {
  const out: string[] = [];
  if (parts.index === null) {
    out.push("the list of RFCs could not be read");
  } else {
    for (const r of parts.index.listed) {
      if (r.overdue) {
        out.push(`RFC ${r.number} is past its decision due date (${r.dueBy}) with no decision`);
      }
    }
  }
  if (parts.workflow === null) {
    out.push("the state of the RFC clock workflow could not be read");
  } else if (parts.workflow.state !== "active") {
    out.push(`the RFC clock workflow is not active (${parts.workflow.state})`);
  }
  if (parts.run === null) {
    out.push("the last run of the RFC clock could not be read");
  } else if (parts.run.latest === null) {
    out.push("the RFC clock has no recorded run");
  } else {
    const age = now.getTime() - Date.parse(parts.run.latest.createdAt);
    if (age > RFC_CLOCK_STALE_HOURS * HOUR_MS) {
      out.push(`the RFC clock last ran more than ${RFC_CLOCK_STALE_HOURS} hours ago`);
    }
    // Only a run that is still going (null), succeeded or was skipped is not a problem: timed_out,
    // startup_failure, cancelled, action_required, neutral, stale and the like each leave a day
    // without a completed clock.
    const c = parts.run.latest.conclusion;
    if (c === "failure") {
      out.push("the last RFC clock run failed");
    } else if (c !== null && c !== "success" && c !== "skipped") {
      out.push(`the last RFC clock run did not succeed (${c})`);
    }
  }
  return out;
}

// ============================================================================
// The reads
// ============================================================================

export interface RfcGatherDeps {
  /** The token for the installation, or throws. Default: the datasets installation token. */
  token?: (env: Bindings) => Promise<string>;
}

async function readGitHub(path: string, accept: string, token: string | null): Promise<Response> {
  const call = (t: string | null) =>
    fetch(`${GITHUB_API()}${path}`, {
      headers: {
        Accept: accept,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(t === null ? {} : { Authorization: `Bearer ${t}` }),
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  let res = await call(token);
  if (token !== null && (res.status === 401 || res.status === 403 || res.status === 404)) {
    // The repository is public: the token is a courtesy, never a requirement.
    await res.body?.cancel();
    res = await call(null);
  }
  if (!res.ok) {
    await res.body?.cancel();
    const limited =
      (res.status === 403 || res.status === 429) &&
      res.headers.get("x-ratelimit-remaining") === "0";
    throw new Error(`GET ${path} answered ${res.status}${limited ? " (rate limited)" : ""}`);
  }
  return res;
}

const WORKFLOW_PATH = `/repos/${RFC_REPO}/actions/workflows/${RFC_CLOCK_WORKFLOW}`;

export interface RfcGatherResult {
  facts: RfcWeekFacts;
  /** One entry per failed read, for the report's list of failed parts (stage `rfcs`). */
  errors: string[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The three reads, each in its own try. Never throws: a failed read leaves its part `null` and
 * adds an entry to `errors`.
 */
export async function gatherRfcFacts(
  env: Bindings,
  now: Date,
  deps: RfcGatherDeps = {},
): Promise<RfcGatherResult> {
  const errors: string[] = [];
  let token: string | null = null;
  try {
    token = await (deps.token ?? getDatasetsToken)(env);
  } catch {
    // No token: the repository is public, so the reads go out without one.
    token = null;
  }

  let index: RfcIndexReading | null = null;
  try {
    const res = await readGitHub(
      `/repos/${RFC_REPO}/contents/README.md`,
      "application/vnd.github.raw",
      token,
    );
    index = parseRfcIndex(await res.text(), now);
  } catch (err) {
    errors.push(`RFC list: ${errText(err)}`);
  }

  let workflow: RfcWeekFacts["workflow"] = null;
  try {
    const res = await readGitHub(WORKFLOW_PATH, "application/vnd.github+json", token);
    workflow = parseWorkflowState(await res.json());
  } catch (err) {
    errors.push(`RFC clock workflow: ${errText(err)}`);
  }

  let run: RfcWeekFacts["run"] = null;
  try {
    const res = await readGitHub(
      `${WORKFLOW_PATH}/runs?per_page=1`,
      "application/vnd.github+json",
      token,
    );
    run = { latest: parseNewestRun(await res.json()) };
  } catch (err) {
    errors.push(`RFC clock last run: ${errText(err)}`);
  }

  return {
    facts: { index, workflow, run, attention: rfcAttention({ index, workflow, run }, now) },
    errors,
  };
}
