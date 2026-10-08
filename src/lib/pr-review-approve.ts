/**
 * Approving a dataset pull request as the administrator themselves (ADR 0093).
 *
 * **Why this runs on the administrator's machine and not in the Worker.** An approval is a person
 * vouching for a change, and GitHub records whose. The Worker can act only as the NEMAR App or as
 * the shared datasets token, and either one approving would put the App's name on a judgment it
 * did not make, and would turn the automated review (which the App publishes) into its own
 * approval. The Worker holds no credential for any one administrator, and must not be given one.
 * So the approval is a request from here to GitHub, made with the token the administrator already
 * holds for `gh`, and the only thing the NEMAR API contributes is the automated verdict to show
 * them first.
 *
 * **The token is checked before it is used.** `GET /user` answers for a person's token and refuses
 * a GitHub App installation token (403), which is how a CI or bot credential left in `GH_TOKEN` is
 * stopped from approving "as" someone. The login it names must also be the one the administrator's
 * NEMAR account is linked to. `GITHUB_TOKEN` is deliberately NOT read: in a workflow it is the
 * Actions bot's token.
 *
 * **The approval is pinned to a commit.** It is submitted with `commit_id` set to the head the
 * administrator was shown, so a push that lands in between leaves the approval on the commit they
 * read, and the ruleset's dismiss-stale-reviews does the rest.
 *
 * **Nothing here merges unless asked, and nothing here bypasses.** A merge needs the explicit
 * `merge` step, waits for GitHub to say the pull request is `clean` (every required check
 * passing), and sends the reviewed `sha` so GitHub refuses it if the branch moved. An administrator
 * may be a bypass actor on the ruleset, so `clean` is required rather than assumed: a blocked pull
 * request is reported, never forced through.
 */

import type { QueueVerdict } from "../../shared/contract/pr-review-admin.js";
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
 * and it is honoured ONLY for a loopback address: an environment variable that could send an
 * administrator's token to an arbitrary host would be an exfiltration path, not a test seam.
 */
export function githubApiBase(env: Record<string, string | undefined> = process.env): string {
  const override = env.NEMAR_GITHUB_API_URL?.trim();
  if (!override) return "https://api.github.com";
  try {
    const u = new URL(override);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol === "http:" && loopback) return override.replace(/\/+$/, "");
  } catch {
    // fall through to the real origin
  }
  return "https://api.github.com";
}

// ---------------------------------------------------------------------------------------------
// The token and who it belongs to
// ---------------------------------------------------------------------------------------------

export type TokenResult =
  | { ok: true; token: string; source: "GH_TOKEN" | "gh" }
  | { ok: false; reason: string };

export async function adminGitHubToken(
  env: Record<string, string | undefined> = process.env,
  run: typeof runCommand = runCommand,
): Promise<TokenResult> {
  const fromEnv = env.GH_TOKEN?.trim();
  if (fromEnv) return { ok: true, token: fromEnv, source: "GH_TOKEN" };
  try {
    const { stdout, exitCode, stderr } = await run([
      "gh",
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
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

export type IdentityResult =
  | { ok: true; user: GitHubPerson }
  | { ok: false; kind: "not_a_person" | "unreachable"; reason: string };

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nemar-cli pr-reviews",
    "Content-Type": "application/json",
  };
}

/** Who a token is, if it is a person's. An app, an Actions token or a rejected token is not. */
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
  if (!res.ok) {
    return {
      ok: false,
      kind: "not_a_person",
      reason:
        res.status === 401
          ? "GitHub rejected this token."
          : "This token does not belong to a GitHub user (an app or workflow token cannot approve for you).",
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
 * caller shows the login and asks.
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
  open: boolean;
  merged: boolean;
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
      open: body?.state === "open",
      merged: body?.merged === true,
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
  if (pr.merged) return "This pull request is already merged.";
  if (!pr.open) return "This pull request is closed.";
  if (pr.baseRef !== "main") {
    return `This pull request targets ${sanitizeNote(pr.baseRef, 40) || "another branch"}, not main. The review queue covers pull requests to main.`;
  }
  if (pr.draft) return "This pull request is a draft. Ask the author to mark it ready first.";
  return null;
}

// ---------------------------------------------------------------------------------------------
// What the automated verdict allows
// ---------------------------------------------------------------------------------------------

export type ApprovalGate =
  | { kind: "proceed" }
  /** Allowed after the administrator confirms, with this sentence shown first. */
  | { kind: "confirm"; warning: string }
  /** Refused unless the administrator says `--force`. */
  | { kind: "needs_force"; reason: string };

/**
 * What the automated review's verdict, as it stands for the commit about to be approved, means for
 * approving. A person is the final authority, so nothing is forbidden outright; but an approval
 * that goes against the review's finding needs an explicit `--force`, and one the review did not
 * clear needs a confirmation that says so.
 */
export function approvalGate(input: {
  verdict: QueueVerdict;
  staleVerdict: QueueVerdict | null;
}): ApprovalGate {
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
            : `The automated review read an earlier commit of this pull request (it said: ${input.staleVerdict.replaceAll("_", " ")}), not this one.`,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Writing to GitHub, as the administrator
// ---------------------------------------------------------------------------------------------

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
      reason: `GitHub could not be reached (${err instanceof Error ? err.message : String(err)}).`,
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
      reason: `GitHub could not be reached (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  const answer = (await res.json().catch(() => null)) as { merged?: unknown } | null;
  if (!res.ok || answer?.merged !== true) {
    return { ok: false, status: res.status, reason: why(res.status, answer) };
  }
  return { ok: true };
}
