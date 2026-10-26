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

import { isOwnDatasetRepo } from "../../../shared/nemar-app.js";
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

let readTimeoutMs = REPULL_GITHUB_READ_TIMEOUT_MS;

/**
 * Tests only: shorten the read's timeout, so a GitHub that never answers is proven to read as
 * unreadable in milliseconds rather than twice ten seconds. `null` restores the default.
 */
export function __setRepullGitHubReadTimeoutForTests(ms: number | null): void {
  readTimeoutMs = ms ?? REPULL_GITHUB_READ_TIMEOUT_MS;
}

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
      { headers, signal: AbortSignal.timeout(readTimeoutMs) },
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
  /** A draft is not ready to merge; an absent field reads as not a draft. */
  draft: boolean;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
  /** The head's repository, `owner/name`, or null for a deleted fork's: GitHub names none. */
  headRepo: string | null;
  /** The base's repository, `owner/name`. */
  baseRepo: string;
}

export const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The one parser of GitHub's pull request (`pullRequestFactOf` adds the rule's own fields): the
 * fields this reads, each checked for its shape; null when one is off.
 */
export function pullRequestFacts(body: unknown): PullRequestFacts | null {
  if (!isObject(body) || !isObject(body.head) || !isObject(body.base)) return null;
  const { state, merged, merge_commit_sha: mergeCommitSha } = body;
  const headSha = body.head.sha;
  const headRef = body.head.ref;
  const baseRef = body.base.ref;
  if (typeof state !== "string" || typeof merged !== "boolean") return null;
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) return null;
  if (typeof headRef !== "string" || typeof baseRef !== "string") return null;
  // GitHub names both repositories, a deleted fork's head as null; any other shape is not its own.
  const headRepoField = body.head.repo;
  const baseRepoField = body.base.repo;
  const headRepo =
    headRepoField === null
      ? null
      : isObject(headRepoField) && typeof headRepoField.full_name === "string"
        ? headRepoField.full_name
        : undefined;
  if (headRepo === undefined) return null;
  if (!isObject(baseRepoField) || typeof baseRepoField.full_name !== "string") return null;
  return {
    state,
    draft: body.draft === true,
    merged,
    mergeCommitSha:
      typeof mergeCommitSha === "string" && SHA_RE.test(mergeCommitSha) ? mergeCommitSha : null,
    headSha,
    headRef,
    baseRef,
    headRepo,
    baseRepo: baseRepoField.full_name,
  };
}

export type RecordedPullRequest =
  | { ok: true; facts: PullRequestFacts }
  | { ok: false; refusal: RepullRefusal };

/**
 * Whether `facts` are the pull request the row names: the recorded branch into `main`, from and
 * into the dataset's own repository. A fork's branch of the recorded name, a deleted fork's
 * included, is not it (`pull-request-mismatch`), so every path that trusts the record's pull
 * request, the claim to merge first, refuses a fork whoever asks.
 */
function recordedPullRequest(
  facts: PullRequestFacts,
  row: RepullRow,
  pr: RepullPullRequest,
): RecordedPullRequest {
  const cols = PULL_REQUEST_COLUMNS[pr];
  const number = row[cols.number];
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
  if (
    !isOwnDatasetRepo(facts.headRepo, row.dataset_id) ||
    !isOwnDatasetRepo(facts.baseRepo, row.dataset_id)
  ) {
    return {
      ok: false,
      refusal: {
        status: 409,
        code: "pull-request-mismatch",
        message: `Pull request #${number} is not from and into ${ORG_NAME}/${row.dataset_id} itself (its head is ${facts.headRepo ?? "a repository GitHub no longer names"}, its base ${facts.baseRepo}): a fork's pull request is never the re-pull's.`,
        row,
      },
    };
  }
  return { ok: true, facts };
}

/** The recorded pull request, read from GitHub, and checked to be the one the row names. */
export async function readRecordedPullRequest(
  env: Bindings,
  row: RepullRow,
  pr: RepullPullRequest,
): Promise<RecordedPullRequest> {
  const number = row[PULL_REQUEST_COLUMNS[pr].number];
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
  return recordedPullRequest(facts, row, pr);
}

/**
 * The live pull request, before its gates are recorded and before a claim to merge: GitHub, not
 * the caller, says the head. It must be open, not a draft, not merged, aimed at `main` from the
 * recorded release branch of the dataset's own repository, with its head at `sha`. An unread
 * GitHub refuses (502); a draft is `pr-draft` (409), so it takes no unit of the cap; every other
 * mismatch, a fork's head or base included, is `head-moved` (409), its message saying which.
 * Nothing is recorded either way. The read is followed by the UPDATE and then the caller's merge,
 * so it holds only if that merge passes the same `sha` to GitHub, which refuses a moved head.
 * `read` is the pull request as the caller read it moments ago; GitHub is read when it is not given.
 */
export async function liveHeadRefusal(
  env: Bindings,
  row: RepullRow,
  pr: RepullPullRequest,
  sha: string,
  read?: PullRequestFacts,
): Promise<RepullRefusal | null> {
  const got = read
    ? recordedPullRequest(read, row, pr)
    : await readRecordedPullRequest(env, row, pr);
  if (!got.ok) {
    if (got.refusal.status === 502) return { ...got.refusal, row };
    return { status: 409, code: "head-moved", message: got.refusal.message, row };
  }
  const { facts } = got;
  const number = row[PULL_REQUEST_COLUMNS[pr].number];
  if (facts.state !== "open" || facts.merged) {
    return {
      status: 409,
      code: "head-moved",
      message: `Pull request #${number} is ${facts.merged ? "merged" : facts.state}, not open; read it again before going on.`,
      row,
    };
  }
  if (facts.draft) {
    return {
      status: 409,
      code: "pr-draft",
      message: `Pull request #${number} is a draft; mark it ready for review before its gates or its merge.`,
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
