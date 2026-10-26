/**
 * A `Bun.serve()` stand-in for api.github.com that speaks everything the pull-request review queue
 * and the CLI's approval make: the GraphQL search and the REST reads the Worker makes with the
 * datasets token, and the calls the CLI makes with an administrator's own token (`GET /user`, the
 * pull request, a review, a merge).
 *
 * It answers `GET /user` by token, so an app token is refused as a person's and a bot is not
 * accepted, and it records every request with the token it carried. That record is the property
 * under test: the tests show that the Worker's token never reached a review or a merge endpoint.
 */

import type { Server } from "bun";
import { type NamingRepo, namingResponse } from "../../backend/test/helpers/github-naming";
import { permissionResponse } from "../../backend/test/helpers/github-permission";
import { projectOnto } from "../../backend/test/helpers/graphql-select";

/** The base branch's commit every pull request read names, for the naming rule's comparison. */
export const STANDIN_BASE_SHA = "9".repeat(40);

export const WORKER_TOKEN = "ghp_worker_datasets_token";
export const ADMIN_TOKEN = "gho_admin_own_token";
export const APP_TOKEN = "ghs_app_installation_token";
export const OTHER_TOKEN = "gho_someone_else";
export const BOT_TOKEN = "gho_a_bot_login";
/** A bot by LOGIN whose type claims to be a person, and one by TYPE whose login does not say so, so each guard is tested without the other. */
export const BOT_LOGIN_TOKEN = "gho_a_bot_by_login";
export const BOT_TYPE_TOKEN = "gho_a_bot_by_type";

export interface Seen {
  method: string;
  path: string;
  token: string | null;
  body: Record<string, unknown> | null;
}

export interface PullState {
  /** The pull request's title; "Add subjects" unless a test says otherwise. */
  title?: string;
  state?: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  base?: string;
  sha: string;
  author?: string;
  /** GitHub's numeric id for the author; 501 unless a test says otherwise. */
  authorId?: number;
  /** `author_association` on the pull request ("COLLABORATOR" unless set). */
  assoc?: string;
  mergeableState?: string;
  /** Answer without a `mergeable_state` at all, as an answer that does not carry the field would. */
  omitMergeableState?: boolean;
  /** Served for the first N reads, then `mergeableState`. */
  unknownReads?: number;
  /** Set after the approval is recorded, to simulate a push landing in between. */
  movesToAfterReview?: string;
  /**
   * `mergeableState` once the approval is recorded: a check that turns pending, or a rule the
   * approval itself changes, between the read before an approval and the read before its merge.
   */
  mergeableStateAfterReview?: string;
  /** The head every read AFTER THE FIRST sees: a push that lands between two readers' reads. */
  headAfterFirstRead?: string;
  /** The head branch's name; "add-subjects" unless a test says otherwise. */
  headRef?: string;
  /** The squash merge's commit, once merged (GitHub's `merge_commit_sha`); null before. */
  mergeCommitSha?: string;
  /**
   * What every read made with the administrator's own token AFTER ITS FIRST answers instead: a
   * status (a GitHub that stops answering), a head (a push), a mergeable state (a check that turns
   * pending), or the pull request closed or merged. Counted over that token's reads only, so a read
   * the Worker makes in between does not use it up.
   */
  adminReadsAfterFirst?: {
    status?: number;
    sha?: string;
    mergeableState?: string;
    state?: "open" | "closed";
    merged?: boolean;
  };
}

export interface GitHubStandin {
  url: string;
  seen: Seen[];
  /** Pull requests the REST read serves, keyed `dataset#number`. */
  pulls: Record<string, PullState>;
  /**
   * What the naming rule's reads find, per repository (see backend/test/helpers/github-naming.ts):
   * the dataset name is unchanged unless a test says otherwise.
   */
  naming: Record<string, NamingRepo>;
  /** The GraphQL search pages. */
  searchPages: unknown[][];
  /** The `issueCount` the search reports, when a test needs it to differ from the nodes returned. */
  searchTotal: number | null;
  /** What the repository dispatch that hands a review to the workflow answers (204 accepts it). */
  dispatchStatus: number;
  users: Record<string, { id: number; login: string; type: string }>;
  /** When set, the review POST answers this status instead of recording an approval. */
  reviewStatus: number | null;
  /** When set, the review POST records this state instead of APPROVED. */
  reviewState: string | null;
  /** When set, the review POST answers with this commit instead of the one it was asked about. */
  reviewCommit: string | null;
  /** When set, `GET /user` answers this status whatever the token (an outage, a rate limit). */
  userStatus: number | null;
  /** The message body of that answer. */
  userMessage: string;
  mergeStatus: number;
  /** When set, posting a comment answers this status instead of recording it. */
  commentStatus: number | null;
  /** When set, closing a pull request answers this status instead of closing it. */
  closeStatus: number | null;
  /** When set, listing a repository's pull requests answers this status instead of the list. */
  pullsListStatus: number | null;
  /**
   * What opening a pull request (`POST /repos/nemarDatasets/<id>/pulls`) answers, one entry per
   * request, in order, before it answers normally: a status instead of the pull request, and with
   * `applied` the pull request is opened all the same (an answer lost on the way back).
   */
  createPullFaults: Array<{ status: number; applied?: boolean }>;
  /**
   * The commit a branch of a dataset's repository names, for the pull request GitHub opens on it:
   * a test reads its bare origin. Null, or unset, is a branch GitHub does not have (422).
   */
  resolveHead: ((dataset: string, ref: string) => Promise<string | null>) | null;
  /** The comments recorded, in order: `{ dataset, number, body, token }`. */
  comments: Array<{ dataset: string; number: number; body: string; token: string | null }>;
  /**
   * When true, a pull request's head is the commit its branch names NOW (`resolveHead`), on every
   * read and at the merge, which GitHub refuses (409) when the `sha` it was sent is another: a push
   * that lands between a reader's read and its merge. Off unless a suite turns it on.
   */
  liveHeads: boolean;
  /**
   * Makes the merge a merge PUT asks for (`dataset`, `number`, the request body): a squash commit
   * on the bare origin's `main`, say. Returns the merge commit, or null to answer 405 instead.
   */
  onMerge:
    | ((dataset: string, number: number, body: Record<string, unknown>) => Promise<string | null>)
    | null;
  /**
   * Runs when a merge PUT arrives, before GitHub compares its `sha` with the head: a push that lands
   * between the merge's last read of the pull request and the merge itself.
   */
  beforeMerge: ((dataset: string, number: number) => Promise<void>) | null;
  /**
   * Runs when a close (PATCH) arrives, before the pull request is closed: a push or a merge that
   * lands between a reader's look and the close.
   */
  beforeClose: ((dataset: string, number: number) => Promise<void>) | null;
  /** When true, a merge PUT is applied and then answered 502: the answer lost on the way back. */
  lostMergeAnswers: boolean;
  /** The commit a tag names (`GET .../commits/tags/<tag>`, asked as `vnd.github.sha`), or null. */
  resolveTag: ((dataset: string, tag: string) => Promise<string | null>) | null;
  /** GitHub's comparison word for `base...head` (`identical`, `ahead`, ...), or null for 404. */
  compareCommits: ((dataset: string, base: string, head: string) => Promise<string | null>) | null;
  /**
   * When true, the review POST and the merge PUT are APPLIED and answered 200 with a body that is
   * not JSON: the case where a write happened and its answer cannot be read.
   */
  unreadableAnswers: boolean;
  /**
   * Tokens GitHub no longer takes: every request that carries one is answered 401, as an
   * installation token past its hour is. Empty unless a test adds one.
   */
  expiredTokens: Set<string>;
  reset(): void;
  stop(): void;
}

const IDENTITIES: Record<string, { login: string; id: number; type: string } | number> = {
  [ADMIN_TOKEN]: { login: "queueadmin-gh", id: 9001, type: "User" },
  [OTHER_TOKEN]: { login: "someone-else", id: 9002, type: "User" },
  [BOT_TOKEN]: { login: "nemar-bot[bot]", id: 9003, type: "Bot" },
  [BOT_TYPE_TOKEN]: { login: "helper-account", id: 9004, type: "Bot" },
  [BOT_LOGIN_TOKEN]: { login: "odd-account[bot]", id: 9005, type: "User" },
  // An installation token is refused by GET /user.
  [APP_TOKEN]: 403,
};

export function startGitHubStandin(): GitHubStandin {
  const state = {
    seen: [] as Seen[],
    pulls: {} as Record<string, PullState>,
    naming: {} as Record<string, NamingRepo>,
    searchPages: [] as unknown[][],
    searchTotal: null as number | null,
    dispatchStatus: 204,
    users: {} as GitHubStandin["users"],
    reviewStatus: null as number | null,
    pullsListStatus: null as number | null,
    createPullFaults: [] as Array<{ status: number; applied?: boolean }>,
    resolveHead: null as GitHubStandin["resolveHead"],
    reviewState: null as string | null,
    reviewCommit: null as string | null,
    userStatus: null as number | null,
    userMessage: "Server Error",
    mergeStatus: 200,
    commentStatus: null as number | null,
    closeStatus: null as number | null,
    comments: [] as GitHubStandin["comments"],
    unreadableAnswers: false,
    liveHeads: false,
    onMerge: null as GitHubStandin["onMerge"],
    beforeMerge: null as GitHubStandin["beforeMerge"],
    beforeClose: null as GitHubStandin["beforeClose"],
    lostMergeAnswers: false,
    resolveTag: null as GitHubStandin["resolveTag"],
    compareCommits: null as GitHubStandin["compareCommits"],
    expiredTokens: new Set<string>(),
  };
  /** The head a pull request has now: its branch's commit when heads are live. */
  const headOf = async (dataset: string, p: PullState): Promise<string> =>
    state.liveHeads && state.resolveHead
      ? ((await state.resolveHead(dataset, p.headRef ?? "add-subjects")) ?? p.sha)
      : p.sha;
  const reads: Record<string, number> = {};
  const adminReads: Record<string, number> = {};

  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "") || null;
      const body = req.method === "GET" ? null : ((await req.json().catch(() => null)) as never);
      state.seen.push({ method: req.method, path: url.pathname, token, body });
      if (token !== null && state.expiredTokens.has(token)) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }

      if (req.method === "POST" && url.pathname === "/graphql") {
        const after = (body as { variables?: { after?: string | null } } | null)?.variables?.after;
        const index = after ? Number(after) : 0;
        // Only the fields the query asks for, as GitHub sends them.
        return Response.json({
          data: projectOnto(String((body as { query?: unknown } | null)?.query ?? ""), {
            search: {
              issueCount: state.searchTotal ?? state.searchPages.flat().length,
              pageInfo: {
                hasNextPage: index + 1 < state.searchPages.length,
                endCursor: String(index + 1),
              },
              nodes: state.searchPages[index] ?? [],
            },
          }),
        });
      }

      if (req.method === "GET" && url.pathname === "/user") {
        if (state.userStatus !== null) {
          return Response.json({ message: state.userMessage }, { status: state.userStatus });
        }
        const who = token ? IDENTITIES[token] : undefined;
        if (typeof who === "number") {
          return Response.json(
            { message: "Resource not accessible by integration" },
            { status: who },
          );
        }
        return who
          ? Response.json(who)
          : Response.json({ message: "Bad credentials" }, { status: 401 });
      }

      // The re-pull's release reads (a tag's commit, a comparison) when a suite answers them from
      // its bare origin; ahead of the naming rule's comparison, which would answer otherwise.
      const tag = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)\/commits\/tags\/(.+)$/);
      if (req.method === "GET" && tag && state.resolveTag) {
        const sha = await state.resolveTag(tag[1] as string, decodeURIComponent(tag[2] as string));
        if (!sha) return Response.json({ message: "No commit found" }, { status: 422 });
        return req.headers.get("accept") === "application/vnd.github.sha"
          ? new Response(sha, { status: 200 })
          : Response.json({ sha });
      }
      const compare = url.pathname.match(
        /^\/repos\/nemarDatasets\/([^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/,
      );
      if (req.method === "GET" && compare && state.compareCommits) {
        const word = await state.compareCommits(
          compare[1] as string,
          compare[2] as string,
          compare[3] as string,
        );
        return word
          ? Response.json({ status: word })
          : Response.json({ message: "Not Found" }, { status: 404 });
      }
      // The question the review's exemption asks once an account has matched (ADR 0107): an
      // administrator on every dataset, whoever is asked. A test that needs another answer says
      // so in the Worker's own suites (backend/test/pr-review-*.test.ts), where the table lives.
      const permission = req.method === "GET" ? await permissionResponse(url, {}) : null;
      if (permission) return permission;
      // The naming rule's reads on an owner's or administrator's pull request (ADR 0107).
      const named = req.method === "GET" ? await namingResponse(url, state.naming) : null;
      if (named) return named;

      const user = url.pathname.match(/^\/users\/([^/]+)$/);
      if (req.method === "GET" && user) {
        const hit = state.users[user[1].toLowerCase()];
        return hit ? Response.json(hit) : new Response("{}", { status: 404 });
      }

      // What the Worker does when it starts a review: hand it to the central workflow and publish
      // the check and the comment. Recorded in `seen` with the token each carried.
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        return new Response(state.dispatchStatus < 300 ? null : "{}", {
          status: state.dispatchStatus,
        });
      }
      if (/^\/repos\/nemarDatasets\/[^/]+\/check-runs(\/\d+)?$/.test(url.pathname)) {
        return Response.json(
          { id: 7000 + state.seen.length },
          { status: req.method === "POST" ? 201 : 200 },
        );
      }
      if (req.method === "PATCH" && /\/issues\/comments\/\d+$/.test(url.pathname)) {
        return Response.json({ id: 1 });
      }

      const comment = url.pathname.match(
        /^\/repos\/nemarDatasets\/([^/]+)\/issues\/(\d+)\/comments$/,
      );
      if (req.method === "POST" && comment) {
        if (state.commentStatus !== null) {
          return Response.json({ message: "Validation Failed" }, { status: state.commentStatus });
        }
        if (state.unreadableAnswers) return new Response("<html>proxy</html>", { status: 201 });
        const text = (body as { body?: string } | null)?.body ?? "";
        state.comments.push({ dataset: comment[1], number: Number(comment[2]), body: text, token });
        return Response.json({ id: state.comments.length, body: text }, { status: 201 });
      }

      // The list the re-pull plan reads (ADR 0111): the open pull requests of one repository.
      const list = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)\/pulls$/);
      if (req.method === "GET" && list) {
        if (state.pullsListStatus !== null) {
          return Response.json({ message: "Server Error" }, { status: state.pullsListStatus });
        }
        const wanted = url.searchParams.get("state") ?? "open";
        // `head=<owner>:<branch>`, as GitHub filters it.
        const head = url.searchParams.get("head");
        return Response.json(
          await Promise.all(
            Object.entries(state.pulls)
              .filter(
                ([k, p]) =>
                  k.startsWith(`${list[1]}#`) &&
                  (wanted === "all" || (p.state ?? "open") === wanted) &&
                  (head === null || head === `nemarDatasets:${p.headRef ?? "add-subjects"}`),
              )
              .map(async ([k, p]) => ({
                number: Number(k.split("#")[1]),
                state: p.state ?? "open",
                head: {
                  ref: p.headRef ?? "add-subjects",
                  sha: await headOf(list[1] as string, p),
                  repo: { full_name: `nemarDatasets/${list[1]}` },
                },
                base: { ref: p.base ?? "main" },
              })),
          ),
        );
      }
      // Opening a pull request: a head branch of the same repository, into `base`.
      if (req.method === "POST" && list) {
        const fault = state.createPullFaults.shift();
        const b = (body ?? {}) as { title?: string; head?: string; base?: string; body?: string };
        const open = async (): Promise<{ number: number; sha: string } | null> => {
          const sha =
            typeof b.head === "string" && state.resolveHead
              ? await state.resolveHead(list[1] as string, b.head)
              : null;
          if (!sha) return null;
          const taken = Object.keys(state.pulls)
            .filter((k) => k.startsWith(`${list[1]}#`))
            .map((k) => Number(k.split("#")[1]));
          const number = Math.max(0, ...taken) + 1;
          state.pulls[`${list[1]}#${number}`] = {
            sha,
            headRef: b.head as string,
            base: b.base ?? "main",
            title: b.title,
            state: "open",
          };
          return { number, sha };
        };
        if (fault) {
          if (fault.applied) await open();
          return Response.json({ message: "Server Error" }, { status: fault.status });
        }
        const made = await open();
        if (!made) {
          return Response.json(
            { message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] },
            { status: 422 },
          );
        }
        return Response.json(
          {
            number: made.number,
            state: "open",
            title: b.title,
            head: {
              ref: b.head,
              sha: made.sha,
              repo: { full_name: `nemarDatasets/${list[1]}` },
            },
            base: { ref: b.base ?? "main" },
          },
          { status: 201 },
        );
      }

      const pull = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)\/pulls\/(\d+)(\/[a-z]+)?$/);
      if (pull) {
        const key = `${pull[1]}#${pull[2]}`;
        const p = state.pulls[key];
        if (!p) return Response.json({ message: "Not Found" }, { status: 404 });
        if (req.method === "GET" && !pull[3]) {
          reads[key] = (reads[key] ?? 0) + 1;
          if (token === ADMIN_TOKEN) adminReads[key] = (adminReads[key] ?? 0) + 1;
          const adminRead = token === ADMIN_TOKEN ? adminReads[key] : 0;
          const later = adminRead > 1 ? p.adminReadsAfterFirst : undefined;
          if (later?.status) {
            return Response.json({ message: "Server Error" }, { status: later.status });
          }
          const unknown = (p.unknownReads ?? 0) >= reads[key];
          return Response.json({
            number: Number(pull[2]),
            state: later?.state ?? p.state ?? "open",
            merged: later?.merged ?? p.merged ?? false,
            draft: p.draft ?? false,
            mergeable_state: p.omitMergeableState
              ? undefined
              : later?.mergeableState
                ? later.mergeableState
                : unknown
                  ? "unknown"
                  : (p.mergeableState ?? "clean"),
            title: p.title ?? "Add subjects",
            author_association: p.assoc ?? "COLLABORATOR",
            user: { login: p.author ?? "contributor", id: p.authorId ?? 501, type: "User" },
            base: {
              ref: p.base ?? "main",
              sha: STANDIN_BASE_SHA,
              repo: {
                name: pull[1],
                full_name: `nemarDatasets/${pull[1]}`,
                owner: { login: "nemarDatasets" },
              },
            },
            merge_commit_sha: p.mergeCommitSha ?? null,
            head: {
              sha:
                later?.sha ??
                (p.headAfterFirstRead && reads[key] > 1
                  ? p.headAfterFirstRead
                  : await headOf(pull[1] as string, p)),
              ref: p.headRef ?? "add-subjects",
              repo: { full_name: `nemarDatasets/${pull[1]}`, owner: { login: "nemarDatasets" } },
            },
          });
        }
        if (req.method === "PATCH" && !pull[3]) {
          if (state.beforeClose) await state.beforeClose(pull[1] as string, Number(pull[2]));
          if (state.closeStatus !== null) {
            return Response.json({ message: "Validation Failed" }, { status: state.closeStatus });
          }
          if (state.unreadableAnswers) return new Response("<html>proxy</html>", { status: 200 });
          p.state = "closed";
          return Response.json({ number: Number(pull[2]), state: "closed" });
        }
        if (req.method === "POST" && pull[3] === "/reviews") {
          if (state.reviewStatus !== null) {
            return Response.json(
              { message: "Can not approve your own pull request" },
              { status: state.reviewStatus },
            );
          }
          const who = token ? IDENTITIES[token] : undefined;
          const login = typeof who === "object" ? who.login : "unknown";
          const commit = (body as { commit_id?: string } | null)?.commit_id ?? p.sha;
          if (p.movesToAfterReview) p.sha = p.movesToAfterReview;
          if (p.mergeableStateAfterReview) p.mergeableState = p.mergeableStateAfterReview;
          if (state.unreadableAnswers) return new Response("<html>proxy</html>", { status: 200 });
          return Response.json({
            id: 1,
            state: state.reviewState ?? "APPROVED",
            commit_id: state.reviewCommit ?? commit,
            user: { login },
          });
        }
        if (req.method === "PUT" && pull[3] === "/merge") {
          if (state.unreadableAnswers) return new Response("<html>proxy</html>", { status: 200 });
          if (state.beforeMerge) await state.beforeMerge(pull[1] as string, Number(pull[2]));
          const sent = (body as { sha?: unknown } | null)?.sha;
          if (
            state.liveHeads &&
            typeof sent === "string" &&
            sent !== (await headOf(pull[1] as string, p))
          ) {
            // GitHub's answer when the head is not the `sha` the merge was sent with.
            return Response.json(
              { message: "Head branch was modified. Review and try the merge again." },
              { status: 409 },
            );
          }
          let mergeSha = "f".repeat(40);
          if (state.mergeStatus === 200 && state.onMerge) {
            const made = await state.onMerge(pull[1] as string, Number(pull[2]), body ?? {});
            if (made === null) {
              return Response.json({ message: "Pull Request is not mergeable" }, { status: 405 });
            }
            mergeSha = made;
          }
          if (state.mergeStatus === 200) {
            p.merged = true;
            p.state = "closed";
            p.mergeCommitSha = mergeSha;
            if (state.lostMergeAnswers) return new Response("bad gateway", { status: 502 });
          }
          return state.mergeStatus === 200
            ? Response.json({ merged: true, sha: mergeSha })
            : Response.json(
                { message: "Pull Request is not mergeable" },
                { status: state.mergeStatus },
              );
        }
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    get seen() {
      return state.seen;
    },
    get pulls() {
      return state.pulls;
    },
    get naming() {
      return state.naming;
    },
    get searchPages() {
      return state.searchPages;
    },
    set searchPages(v) {
      state.searchPages = v;
    },
    get searchTotal() {
      return state.searchTotal;
    },
    set searchTotal(v) {
      state.searchTotal = v;
    },
    get dispatchStatus() {
      return state.dispatchStatus;
    },
    set dispatchStatus(v) {
      state.dispatchStatus = v;
    },
    get users() {
      return state.users;
    },
    get reviewStatus() {
      return state.reviewStatus;
    },
    set reviewStatus(v) {
      state.reviewStatus = v;
    },
    get reviewState() {
      return state.reviewState;
    },
    set reviewState(v) {
      state.reviewState = v;
    },
    get reviewCommit() {
      return state.reviewCommit;
    },
    set reviewCommit(v) {
      state.reviewCommit = v;
    },
    get userStatus() {
      return state.userStatus;
    },
    set userStatus(v) {
      state.userStatus = v;
    },
    get userMessage() {
      return state.userMessage;
    },
    set userMessage(v) {
      state.userMessage = v;
    },
    get mergeStatus() {
      return state.mergeStatus;
    },
    set mergeStatus(v) {
      state.mergeStatus = v;
    },
    get commentStatus() {
      return state.commentStatus;
    },
    set commentStatus(v) {
      state.commentStatus = v;
    },
    get closeStatus() {
      return state.closeStatus;
    },
    set closeStatus(v) {
      state.closeStatus = v;
    },
    get comments() {
      return state.comments;
    },
    get pullsListStatus() {
      return state.pullsListStatus;
    },
    set pullsListStatus(v) {
      state.pullsListStatus = v;
    },
    get createPullFaults() {
      return state.createPullFaults;
    },
    get resolveHead() {
      return state.resolveHead;
    },
    set resolveHead(v) {
      state.resolveHead = v;
    },
    get unreadableAnswers() {
      return state.unreadableAnswers;
    },
    get liveHeads() {
      return state.liveHeads;
    },
    set liveHeads(v) {
      state.liveHeads = v;
    },
    get onMerge() {
      return state.onMerge;
    },
    get beforeMerge() {
      return state.beforeMerge;
    },
    set beforeMerge(v) {
      state.beforeMerge = v;
    },
    get beforeClose() {
      return state.beforeClose;
    },
    set beforeClose(v) {
      state.beforeClose = v;
    },
    get lostMergeAnswers() {
      return state.lostMergeAnswers;
    },
    set lostMergeAnswers(v) {
      state.lostMergeAnswers = v;
    },
    set onMerge(v) {
      state.onMerge = v;
    },
    get resolveTag() {
      return state.resolveTag;
    },
    set resolveTag(v) {
      state.resolveTag = v;
    },
    get compareCommits() {
      return state.compareCommits;
    },
    set compareCommits(v) {
      state.compareCommits = v;
    },
    set unreadableAnswers(v) {
      state.unreadableAnswers = v;
    },
    get expiredTokens() {
      return state.expiredTokens;
    },
    reset() {
      state.seen.length = 0;
      state.searchPages = [];
      state.searchTotal = null;
      state.dispatchStatus = 204;
      state.reviewStatus = null;
      state.reviewState = null;
      state.reviewCommit = null;
      state.userStatus = null;
      state.userMessage = "Server Error";
      state.mergeStatus = 200;
      state.unreadableAnswers = false;
      state.beforeMerge = null;
      state.beforeClose = null;
      state.lostMergeAnswers = false;
      state.commentStatus = null;
      state.closeStatus = null;
      state.pullsListStatus = null;
      state.createPullFaults.length = 0;
      state.comments.length = 0;
      state.expiredTokens.clear();
      for (const k of Object.keys(state.pulls)) delete state.pulls[k];
      for (const k of Object.keys(state.naming)) delete state.naming[k];
      for (const k of Object.keys(state.users)) delete state.users[k];
      for (const k of Object.keys(reads)) delete reads[k];
      for (const k of Object.keys(adminReads)) delete adminReads[k];
    },
    stop() {
      server.stop(true);
    },
  } as GitHubStandin;
}
