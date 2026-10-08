/**
 * Approving a dataset pull request as the administrator themselves (ADR 0093).
 *
 * **Why this runs on the administrator's machine and not in the Worker.** An approval is a person
 * vouching for a change, and GitHub records whose. No Worker code path approves, and the Worker
 * holds nothing that belongs to an individual administrator; the tokens it does hold (the NEMAR App
 * and the datasets token) could submit a review, which is exactly why one must never be made with
 * them: it would put the App's name on a judgment a person made, and turn the automated review
 * (which the App publishes) into its own approval. So the approval is a request from here to
 * GitHub, with the token the administrator already holds, and the only thing the NEMAR API
 * contributes is the automated verdict to show them first.
 *
 * - **The token is checked before it is used.** `GET /user` answers for a person's token and refuses
 *   an App installation token (403), so a CI or bot credential left in `GH_TOKEN` cannot approve "as"
 *   someone. The login it names is also compared with the one the administrator's NEMAR account is
 *   linked to. `gh auth token` is run with `GH_TOKEN` and `GITHUB_TOKEN` removed from its
 *   environment: `gh` itself prefers them to its stored login, and `GITHUB_TOKEN` is the Actions
 *   bot's in a workflow.
 * - **The approval is pinned to a commit.** It is submitted with `commit_id` set to the head the
 *   administrator was shown, so a push that lands in between leaves the approval on the commit they
 *   read.
 * - **A merge is a client-side check, not enforcement.** It is attempted once, only if GitHub
 *   reports the pull request `clean` (or `has_hooks`); it re-asks for a few seconds while GitHub is
 *   still working the state out, does not wait for pending checks, sends the approved `sha`, and
 *   otherwise stops with the approval standing. An administrator can be a bypass actor on the
 *   ruleset, so this does not attempt a merge GitHub reports as blocked; the ruleset is what
 *   enforces, and it is not this code's job to defeat it.
 */

import type { QueueVerdict, ReadVerdict } from "../../shared/contract/pr-review-admin.js";
import { QUEUE_VERDICTS } from "../../shared/contract/pr-review-admin.js";
import { sanitizeNote } from "../../shared/pr-review.js";
import { runCommand } from "./git-annex/run-command.js";

export const DATASETS_ORG = "nemarDatasets";
const REQUEST_TIMEOUT_MS = 20_000;

/** The one place a GitHub URL for a dataset pull request is built. */
export function pullRequestUrl(datasetId: string, prNumber: number): string {
  return `https://github.com/${DATASETS_ORG}/${datasetId}/pull/${prNumber}`;
}

/** The command that does what `approve` does, for an administrator who cannot or would rather not use it. */
export function manualApprovalCommand(datasetId: string, prNumber: number): string {
  return `gh pr review ${prNumber} --repo ${DATASETS_ORG}/${datasetId} --approve`;
}

/**
 * GitHub's API origin. `NEMAR_GITHUB_API_URL` exists so a test can point this at a local stand-in,
 * and it is honoured ONLY for a loopback http address: an environment variable that could send an
 * administrator's token to an arbitrary host would be an exfiltration path, not a test seam. A
 * value that is set and not acceptable is an ERROR, not a fall-through to the real GitHub: a typo
 * must not turn a rehearsal into a real approval.
 */
export function githubApiBase(env: Record<string, string | undefined> = process.env): string {
  const override = env.NEMAR_GITHUB_API_URL?.trim();
  if (!override) return "https://api.github.com";
  try {
    const u = new URL(override);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol === "http:" && loopback) return override.replace(/\/+$/, "");
  } catch {
    // fall through to the error below
  }
  throw new Error(
    "NEMAR_GITHUB_API_URL is set but is not an http://127.0.0.1, http://localhost or http://[::1] address. It is only for tests, so it is refused rather than ignored; unset it to use GitHub.",
  );
}

// ---------------------------------------------------------------------------------------------
// The token and who it belongs to
// ---------------------------------------------------------------------------------------------

export type TokenSource = "GH_TOKEN" | "gh";

export type TokenResult =
  | { ok: true; token: string; source: TokenSource }
  | { ok: false; reason: string };

export async function adminGitHubToken(
  env: Record<string, string | undefined> = process.env,
  run: typeof runCommand = runCommand,
): Promise<TokenResult> {
  const fromEnv = env.GH_TOKEN?.trim();
  if (fromEnv) return { ok: true, token: fromEnv, source: "GH_TOKEN" };
  try {
    const { stdout, exitCode, stderr } = await run(
      ["gh", "auth", "token", "--hostname", "github.com"],
      // `gh` prefers these to the login it stores, which would answer with a token that is not
      // the account `gh auth status` shows. Ask for the stored one.
      { unsetEnv: ["GH_TOKEN", "GITHUB_TOKEN"] },
    );
    if (exitCode === 0 && stdout.trim()) return { ok: true, token: stdout.trim(), source: "gh" };
    return {
      ok: false,
      reason: `gh has no signed-in account for github.com (${stderr.trim().split("\n")[0] || `exit ${exitCode}`}).`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason:
        msg.includes("ENOENT") || msg.includes("not found")
          ? "The GitHub CLI (gh) is not installed."
          : `gh could not be run: ${msg}`,
    };
  }
}

export interface GitHubPerson {
  login: string;
  id: number;
}

/**
 * Why a token was not accepted as a person's: `not_a_person` (an App or workflow token, a bot, or
 * an organisation), `rejected` (GitHub refused it: expired or revoked), or `unreachable` (GitHub did
 * not answer, or answered with an error that says nothing about the token). Only the first calls for
 * the manual fallback; the others are the administrator's to fix or retry.
 */
export type IdentityResult =
  | { ok: true; user: GitHubPerson }
  | { ok: false; kind: "not_a_person" | "rejected" | "unreachable"; reason: string };

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nemar-cli pr-reviews",
    "Content-Type": "application/json",
  };
}

/** Who a token is, if it is a person's. An App or Actions token, a bot, or a rejected token is not. */
export async function whoAmI(token: string, base = githubApiBase()): Promise<IdentityResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/user`, {
      headers: headers(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "unreachable",
      reason: `GitHub could not be reached (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (res.status === 401) {
    return { ok: false, kind: "rejected", reason: "GitHub rejected this token." };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // A 403 that is a rate limit says nothing about the token; the integration-token 403 does.
    if (res.status === 403 && !/rate limit|abuse/i.test(text)) {
      return {
        ok: false,
        kind: "not_a_person",
        reason:
          "This token does not belong to a GitHub user (an app or workflow token cannot approve for you).",
      };
    }
    return {
      ok: false,
      kind: "unreachable",
      reason: `GitHub answered HTTP ${res.status} when asked whose token this is. Try again in a moment.`,
    };
  }
  const u = (await res.json().catch(() => null)) as {
    login?: unknown;
    id?: unknown;
    type?: unknown;
  } | null;
  if (
    typeof u?.login !== "string" ||
    typeof u.id !== "number" ||
    u.type !== "User" ||
    u.login.endsWith("[bot]")
  ) {
    return {
      ok: false,
      kind: "not_a_person",
      reason: "This token does not belong to a GitHub user, so it cannot approve for you.",
    };
  }
  return { ok: true, user: { login: u.login, id: u.id } };
}

/**
 * Whether the GitHub login is the one the administrator's NEMAR account is linked to. `unlinked`
 * means the account names no GitHub login (an ORCID or email account): nothing to compare, so the
 * caller shows the login being used.
 */
export function identityMatches(
  linked: string | null | undefined,
  login: string,
): "match" | "mismatch" | "unlinked" {
  if (!linked) return "unlinked";
  return linked.toLowerCase() === login.toLowerCase() ? "match" : "mismatch";
}

// ---------------------------------------------------------------------------------------------
// The pull request, as GitHub says it is now
// ---------------------------------------------------------------------------------------------

export interface PullRequestFacts {
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseRef: string;
  headSha: string;
  authorLogin: string;
  /** GitHub's own mergeability verdict, which already weighs every required check and review. */
  mergeableState: string;
}

export type FetchResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string };

function why(status: number, body: unknown): string {
  const message =
    typeof body === "object" && body !== null && "message" in body
      ? sanitizeNote((body as { message: unknown }).message, 160)
      : "";
  return message ? `${message} (HTTP ${status})` : `GitHub answered HTTP ${status}.`;
}

export async function fetchPullRequest(
  token: string,
  datasetId: string,
  prNumber: number,
  base = githubApiBase(),
): Promise<FetchResult<PullRequestFacts>> {
  let res: Response;
  try {
    res = await fetch(`${base}/repos/${DATASETS_ORG}/${datasetId}/pulls/${prNumber}`, {
      headers: headers(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: `GitHub could not be reached (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reason:
        res.status === 404
          ? `${DATASETS_ORG}/${datasetId} has no pull request #${prNumber}, or your GitHub account cannot see it.`
          : why(res.status, body),
    };
  }
  const head = body?.head as { sha?: unknown } | undefined;
  const baseInfo = body?.base as { ref?: unknown } | undefined;
  const user = body?.user as { login?: unknown } | undefined;
  if (typeof head?.sha !== "string" || !/^[0-9a-f]{40}$/.test(head.sha)) {
    return { ok: false, status: res.status, reason: "GitHub's answer had no head commit." };
  }
  return {
    ok: true,
    value: {
      state: body?.merged === true ? "merged" : body?.state === "open" ? "open" : "closed",
      draft: body?.draft === true,
      baseRef: typeof baseInfo?.ref === "string" ? baseInfo.ref : "",
      headSha: head.sha,
      authorLogin: typeof user?.login === "string" ? user.login : "",
      mergeableState: typeof body?.mergeable_state === "string" ? body.mergeable_state : "unknown",
    },
  };
}

/** Why a pull request cannot be approved at all, or null when it can. */
export function refusalFor(pr: PullRequestFacts): string | null {
  if (pr.state === "merged") return "This pull request is already merged.";
  if (pr.state === "closed") return "This pull request is closed.";
  if (pr.baseRef !== "main") {
    return `This pull request targets ${sanitizeNote(pr.baseRef, 40) || "another branch"}, not main. The review queue covers pull requests to main.`;
  }
  if (pr.draft) return "This pull request is a draft. Ask the author to mark it ready first.";
  return null;
}

// ---------------------------------------------------------------------------------------------
// What the automated verdict allows
// ---------------------------------------------------------------------------------------------

/**
 * A verdict word from the NEMAR API as one this CLI knows. The CLI ships on npm independently of
 * the Worker, so a newer server may say something this version has never heard of; that must read
 * as "needs a person", never crash the gate and never read as a pass.
 */
export function asVerdict(raw: unknown): QueueVerdict {
  return typeof raw === "string" && (QUEUE_VERDICTS as readonly string[]).includes(raw)
    ? (raw as QueueVerdict)
    : "could_not_decide";
}

export type ApprovalGate =
  | { kind: "proceed" }
  /** Allowed after the administrator confirms (`--yes` skips the question), with this sentence shown first. */
  | { kind: "confirm"; warning: string }
  /** Refused unless the administrator says `--force`. */
  | { kind: "needs_force"; reason: string };

/**
 * What the automated review's verdict, as it stands for the commit about to be approved, means for
 * approving. A person is the final authority, so nothing is forbidden outright; but an approval
 * that goes against the review's finding, or that cannot see the review at all, needs an explicit
 * `--force`, and one the review did not clear needs a confirmation that says so.
 *
 * `unread` is why the NEMAR API could not say what the review concluded. That is "unknown", which
 * is never rendered as "not reviewed": a stored rejection could be hiding behind it.
 */
export function approvalGate(input: {
  verdict: QueueVerdict;
  staleVerdict: ReadVerdict | null;
  unread?: string;
}): ApprovalGate {
  if (input.unread) {
    return {
      kind: "needs_force",
      reason: `The automated review could not be read (${input.unread}), so its verdict is unknown. Pass --force to approve without it.`,
    };
  }
  switch (input.verdict) {
    case "pass":
      return { kind: "proceed" };
    case "fail":
      return {
        kind: "needs_force",
        reason:
          "The automated review says this pull request needs changes. Read it with `show`, and pass --force to approve it anyway.",
      };
    case "in_progress":
      return {
        kind: "needs_force",
        reason:
          "The automated review of this commit is still running. Wait for it, or pass --force to approve without it.",
      };
    case "uncertain":
      return {
        kind: "confirm",
        warning: "The automated review could not decide whether this is a good change.",
      };
    case "could_not_decide":
      return { kind: "confirm", warning: "The automated review ended without a verdict." };
    case "not_reviewed":
      return {
        kind: "confirm",
        warning:
          input.staleVerdict === null
            ? "The automated review has not read this commit."
            : `The automated review read a different commit of this pull request (it said: ${input.staleVerdict}), not this one.`,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Writing to GitHub, as the administrator
// ---------------------------------------------------------------------------------------------

/**
 * A failed write. `status` 0 means GitHub did not answer, and for a write that is NOT "it did not
 * happen": the request may have been applied before the connection dropped. Callers say so.
 */
export type WriteResult = { ok: true } | { ok: false; status: number; reason: string };

/** Approve the pull request on the exact commit the administrator was shown. */
export async function submitApproval(
  token: string,
  datasetId: string,
  prNumber: number,
  headSha: string,
  expectedLogin: string,
  body: string,
  base = githubApiBase(),
): Promise<WriteResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/repos/${DATASETS_ORG}/${datasetId}/pulls/${prNumber}/reviews`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ commit_id: headSha, event: "APPROVE", body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: `GitHub did not answer (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  const answer = (await res.json().catch(() => null)) as {
    state?: unknown;
    commit_id?: unknown;
    user?: { login?: unknown };
  } | null;
  if (!res.ok) return { ok: false, status: res.status, reason: why(res.status, answer) };
  // Trust the answer, not the request: the review must be an approval, by this person, of this commit.
  if (
    answer?.state !== "APPROVED" ||
    answer.commit_id !== headSha ||
    typeof answer.user?.login !== "string" ||
    answer.user.login.toLowerCase() !== expectedLogin.toLowerCase()
  ) {
    return {
      ok: false,
      status: res.status,
      reason:
        "GitHub accepted the request but the review it recorded is not the approval that was asked for. Check the pull request.",
    };
  }
  return { ok: true };
}

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** `clean` is GitHub saying every required check and review is satisfied; `has_hooks` is the same with a post-receive hook. */
const MERGEABLE: ReadonlySet<string> = new Set(["clean", "has_hooks"]);

/**
 * A merge that did not happen. `status` mirrors GitHub's codes where GitHub answered (405 not
 * mergeable, 409 the branch moved) and is 405 or 409 here WITHOUT a request having been sent when
 * this code decided not to ask; it is 0 when GitHub did not answer, which, as for the approval, does
 * not prove nothing was merged.
 */
export type MergeResult =
  | { ok: true }
  | { ok: false; status: number; reason: string; mergeableState?: string };

/**
 * Merge the pull request at `headSha`, only if GitHub says it is mergeable WITHOUT a bypass.
 * Mergeability is computed lazily, so an `unknown` is asked about again a few times.
 */
export async function mergeWhenClean(
  token: string,
  datasetId: string,
  prNumber: number,
  headSha: string,
  method: MergeMethod,
  options: { base?: string; sleep?: (ms: number) => Promise<void>; tries?: number } = {},
): Promise<MergeResult> {
  const base = options.base ?? githubApiBase();
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const tries = options.tries ?? 5;

  let state = "unknown";
  for (let i = 0; i < tries; i++) {
    const pr = await fetchPullRequest(token, datasetId, prNumber, base);
    if (!pr.ok) return { ok: false, status: pr.status, reason: pr.reason };
    if (pr.value.headSha !== headSha) {
      return {
        ok: false,
        status: 409,
        reason: "The pull request changed after it was approved, so it was not merged.",
      };
    }
    state = pr.value.mergeableState;
    if (state !== "unknown") break;
    await sleep(1000);
  }
  if (!MERGEABLE.has(state)) {
    const explain: Record<string, string> = {
      blocked: "a required check or review is not satisfied",
      behind: "the branch is behind main",
      dirty: "it has merge conflicts",
      unstable: "a check is failing",
      draft: "it is a draft",
      unknown: "GitHub has not finished working out whether it can merge",
    };
    return {
      ok: false,
      status: 405,
      mergeableState: state,
      reason: `Not merged: GitHub says it cannot be merged cleanly (${explain[state] ?? sanitizeNote(state, 30)}). The approval stands.`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`${base}/repos/${DATASETS_ORG}/${datasetId}/pulls/${prNumber}/merge`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify({ sha: headSha, merge_method: method }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: `GitHub did not answer (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  const answer = (await res.json().catch(() => null)) as { merged?: unknown } | null;
  if (!res.ok || answer?.merged !== true) {
    return { ok: false, status: res.status, reason: why(res.status, answer) };
  }
  return { ok: true };
}
