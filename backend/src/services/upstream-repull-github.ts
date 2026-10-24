/**
 * The GitHub reads a re-pull's Worker routes make with the Worker's own credential (epic #1046
 * phase 6, #1912; ADR 0111, decisions 6 and 7): the recorded pull request, a tag's commit and a
 * comparison. Shared by the transition (the live head before the gates and the claim) and the
 * verified routes (the merge, the release, the release of a claim), so both read GitHub one way.
 *
 * Every failure to read is a refusal (`github-unreadable`, 502): the caller records nothing, so an
 * unread GitHub never stands in for an answer (ADR 0053). A 404 or 422 is an answer, and the
 * caller says what it means. Reads only; nothing here writes to GitHub or mails anyone.
 */

import {
  PULL_REQUEST_COLUMNS,
  type RepullPullRequest,
  type RepullRow,
  SHA_RE,
} from "../../../shared/repull-state.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";
import { HttpError } from "./retry.js";
import type { RepullRefusal } from "./upstream-repull.js";

/** How long one GitHub read may take, so an administrator's request is answered. */
export const REPULL_GITHUB_READ_TIMEOUT_MS = 10_000;

export type GitHubRead =
  | { ok: true; status: number; body: unknown; text: string | null }
  | { ok: false; refusal: RepullRefusal };

export function unreadable(what: string, why: string): RepullRefusal {
  return {
    status: 502,
    code: "github-unreadable",
    message: `GitHub could not be read (${what}: ${why}), so nothing was recorded.`,
  };
}

/** Why a read failed, in words a caller can act on: the transport's own retry time when it gave one. */
function failureWords(err: unknown): string {
  if (err instanceof HttpError) {
    const retry = /retry in \d+s/.exec(err.message)?.[0];
    return retry ? `HTTP ${err.status}, ${retry}` : `HTTP ${err.status}`;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "no answer in time";
  }
  return "no answer";
}

/**
 * One GET against the dataset's repository. A 404 or 422 is an answer; every other failure is a
 * refusal. `accept` asks GitHub for another media type; `vnd.github.sha` answers with the bare
 * commit id as text, which is kept in `text`.
 */
export async function githubRead(
  env: Bindings,
  datasetId: string,
  path: string,
  accept?: string,
): Promise<GitHubRead> {
  let res: Response;
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    const headers = { ...ghHeaders(token), ...(accept ? { Accept: accept } : {}) };
    res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${datasetId}${path}`,
      { headers, signal: AbortSignal.timeout(REPULL_GITHUB_READ_TIMEOUT_MS) },
      { kind: "interactive", maxAttempts: 2, refreshTokenOn401: refresh },
    );
  } catch (err) {
    const why = failureWords(err);
    console.error(`[upstream-repull] GitHub read of ${datasetId}${path} failed (${why})`);
    return { ok: false, refusal: unreadable(path, why) };
  }
  if (res.status === 404 || res.status === 422) {
    return { ok: true, status: res.status, body: null, text: null };
  }
  if (!res.ok) {
    console.error(`[upstream-repull] GitHub answered HTTP ${res.status} for ${datasetId}${path}`);
    return { ok: false, refusal: unreadable(path, `HTTP ${res.status}`) };
  }
  if (accept === "application/vnd.github.sha") {
    const text = (await res.text().catch(() => "")).trim();
    return { ok: true, status: res.status, body: null, text };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, refusal: unreadable(path, "an answer that is not an object") };
  }
  return { ok: true, status: res.status, body, text: null };
}

export interface PullRequestFacts {
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
}

export const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** The fields of GitHub's pull request this reads, each checked for its shape; null when one is off. */
export function pullRequestFacts(body: unknown): PullRequestFacts | null {
  if (!isObject(body) || !isObject(body.head) || !isObject(body.base)) return null;
  const { state, merged, merge_commit_sha: mergeCommitSha } = body;
  const headSha = body.head.sha;
  const headRef = body.head.ref;
  const baseRef = body.base.ref;
  if (typeof state !== "string" || typeof merged !== "boolean") return null;
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) return null;
  if (typeof headRef !== "string" || typeof baseRef !== "string") return null;
  return {
    state,
    merged,
    mergeCommitSha:
      typeof mergeCommitSha === "string" && SHA_RE.test(mergeCommitSha) ? mergeCommitSha : null,
    headSha,
    headRef,
    baseRef,
  };
}

/** The recorded pull request, read from GitHub, and checked to be the one the row names. */
export async function readRecordedPullRequest(
  env: Bindings,
  row: RepullRow,
  pr: RepullPullRequest,
): Promise<{ ok: true; facts: PullRequestFacts } | { ok: false; refusal: RepullRefusal }> {
  const cols = PULL_REQUEST_COLUMNS[pr];
  const number = row[cols.number];
  const read = await githubRead(env, row.dataset_id, `/pulls/${number}`);
  if (!read.ok) return read;
  if (read.status !== 200) {
    return {
      ok: false,
      refusal: {
        status: 409,
        code: "pull-request-missing",
        message: `GitHub has no pull request #${number} on ${row.dataset_id} (or the Worker's token cannot see it).`,
        row,
      },
    };
  }
  const facts = pullRequestFacts(read.body);
  if (!facts) return { ok: false, refusal: unreadable(`pull request #${number}`, "its shape") };
  if (facts.headRef !== row[cols.branch] || facts.baseRef !== "main") {
    return {
      ok: false,
      refusal: {
        status: 409,
        code: "pull-request-mismatch",
        message: `Pull request #${number} is ${facts.headRef} into ${facts.baseRef}, not the recorded ${row[cols.branch]} into main.`,
        row,
      },
    };
  }
  return { ok: true, facts };
}

/**
 * The live pull request, before its gates are recorded and before a claim to merge: GitHub, not
 * the caller, says the head. It must be open, not merged, aimed at `main` from the recorded
 * release branch, with its head at `sha`. An unread GitHub refuses (502); every other mismatch is
 * `head-moved` (409). Nothing is recorded either way.
 */
export async function liveHeadRefusal(
  env: Bindings,
  row: RepullRow,
  pr: RepullPullRequest,
  sha: string,
): Promise<RepullRefusal | null> {
  const read = await readRecordedPullRequest(env, row, pr);
  if (!read.ok) {
    if (read.refusal.status === 502) return { ...read.refusal, row };
    return { status: 409, code: "head-moved", message: read.refusal.message, row };
  }
  const { facts } = read;
  const number = row[PULL_REQUEST_COLUMNS[pr].number];
  if (facts.state !== "open" || facts.merged) {
    return {
      status: 409,
      code: "head-moved",
      message: `Pull request #${number} is ${facts.merged ? "merged" : facts.state}, not open; read it again before going on.`,
      row,
    };
  }
  if (facts.headSha !== sha) {
    return {
      status: 409,
      code: "head-moved",
      message: `Pull request #${number} is at ${facts.headSha.slice(0, 12)}, not ${sha.slice(0, 12)}: its head moved.`,
      row,
    };
  }
  return null;
}
