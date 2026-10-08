/**
 * A `Bun.serve()` stand-in for api.github.com that speaks everything the pull-request review queue
 * and the CLI's approval make: the GraphQL search and the REST reads the Worker makes with the
 * datasets token, and the calls the CLI makes with an administrator's own token (`GET /user`, the
 * pull request, a review, a merge).
 *
 * It answers by WHO is asking, because that is the property under test: a Worker token must never be
 * the one that approves, and an app token must not be accepted as a person. Every request is
 * recorded with the token it carried.
 */

import type { Server } from "bun";

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
  state?: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  base?: string;
  sha: string;
  author?: string;
  mergeableState?: string;
  /** Served for the first N reads, then `mergeableState`. */
  unknownReads?: number;
  /** Set after the approval is recorded, to simulate a push landing in between. */
  movesToAfterReview?: string;
}

export interface GitHubStandin {
  url: string;
  seen: Seen[];
  /** Pull requests the REST read serves, keyed `dataset#number`. */
  pulls: Record<string, PullState>;
  /** The GraphQL search pages. */
  searchPages: unknown[][];
  users: Record<string, { id: number; login: string; type: string }>;
  /** When set, the review POST answers this status instead of recording an approval. */
  reviewStatus: number | null;
  /** When set, the review POST records this state instead of APPROVED. */
  reviewState: string | null;
  mergeStatus: number;
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
    searchPages: [] as unknown[][],
    users: {} as GitHubStandin["users"],
    reviewStatus: null as number | null,
    reviewState: null as string | null,
    mergeStatus: 200,
  };
  const reads: Record<string, number> = {};

  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "") || null;
      const body = req.method === "GET" ? null : ((await req.json().catch(() => null)) as never);
      state.seen.push({ method: req.method, path: url.pathname, token, body });

      if (req.method === "POST" && url.pathname === "/graphql") {
        const after = (body as { variables?: { after?: string | null } } | null)?.variables?.after;
        const index = after ? Number(after) : 0;
        return Response.json({
          data: {
            search: {
              issueCount: state.searchPages.flat().length,
              pageInfo: {
                hasNextPage: index + 1 < state.searchPages.length,
                endCursor: String(index + 1),
              },
              nodes: state.searchPages[index] ?? [],
            },
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/user") {
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

      const user = url.pathname.match(/^\/users\/([^/]+)$/);
      if (req.method === "GET" && user) {
        const hit = state.users[user[1].toLowerCase()];
        return hit ? Response.json(hit) : new Response("{}", { status: 404 });
      }

      const pull = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)\/pulls\/(\d+)(\/[a-z]+)?$/);
      if (pull) {
        const key = `${pull[1]}#${pull[2]}`;
        const p = state.pulls[key];
        if (!p) return Response.json({ message: "Not Found" }, { status: 404 });
        if (req.method === "GET" && !pull[3]) {
          reads[key] = (reads[key] ?? 0) + 1;
          const unknown = (p.unknownReads ?? 0) >= reads[key];
          return Response.json({
            number: Number(pull[2]),
            state: p.state ?? "open",
            merged: p.merged ?? false,
            draft: p.draft ?? false,
            mergeable_state: unknown ? "unknown" : (p.mergeableState ?? "clean"),
            title: "Add subjects",
            user: { login: p.author ?? "contributor", id: 501, type: "User" },
            base: { ref: p.base ?? "main" },
            head: {
              sha: p.sha,
              ref: "add-subjects",
              repo: { full_name: `nemarDatasets/${pull[1]}`, owner: { login: "nemarDatasets" } },
            },
          });
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
          return Response.json({
            id: 1,
            state: state.reviewState ?? "APPROVED",
            commit_id: commit,
            user: { login },
          });
        }
        if (req.method === "PUT" && pull[3] === "/merge") {
          return state.mergeStatus === 200
            ? Response.json({ merged: true, sha: "f".repeat(40) })
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
    get searchPages() {
      return state.searchPages;
    },
    set searchPages(v) {
      state.searchPages = v;
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
    get mergeStatus() {
      return state.mergeStatus;
    },
    set mergeStatus(v) {
      state.mergeStatus = v;
    },
    reset() {
      state.seen.length = 0;
      state.searchPages = [];
      state.reviewStatus = null;
      state.reviewState = null;
      state.mergeStatus = 200;
      for (const k of Object.keys(state.pulls)) delete state.pulls[k];
      for (const k of Object.keys(state.users)) delete state.users[k];
      for (const k of Object.keys(reads)) delete reads[k];
    },
    stop() {
      server.stop(true);
    },
  } as GitHubStandin;
}
