/**
 * A `Bun.serve()` stand-in for the api.github.com reads and the one dispatch a re-pull's Worker
 * routes make (epic #1046 phase 6, #1912), installed through NEMAR_GITHUB_API_URL the way the
 * other backend suites install theirs. Not a mock of NEMAR code: every NEMAR component runs, and
 * only GitHub is stood in for, because the organization is shared with production.
 *
 * It answers:
 *  - `GET /repos/nemarDatasets/<id>/pulls/<n>`: an entry of `pulls` (`<id>#<n>`), or, with
 *    `defaultHead` set, an open, unmerged pull request at that head from the release branch the
 *    repull-rows fixtures record (`release/v2.0.0` for #7, `release/v2.0.1` for #8);
 *  - `GET .../commits/tags/<tag>`: the commit in `tags` (`<id>@<tag>`) as a bare id when the
 *    request asks for `application/vnd.github.sha`, as `{ sha }` otherwise; 422 when absent;
 *  - `GET .../compare/<base>...<head>`: `{ status }` from `compares` (`<id>:<base>...<head>`),
 *    `ahead` by default, or that HTTP status when the entry is a number;
 *  - `POST /repos/nemarDatasets/.github/dispatches`: recorded in `dispatches`, answered
 *    `dispatchStatus`.
 * `down` answers every request 503. Every request is recorded in `requests`.
 */

import type { Server } from "bun";

export interface PullAnswer {
  status?: number;
  state?: string;
  merged?: unknown;
  merge_commit_sha?: string | null;
  head?: { sha: string; ref: string };
  base?: { ref: string };
  /** Keys to leave out of the answer, to stand in for a malformed one. */
  omit?: string[];
}

export interface Dispatch {
  event_type: string;
  client_payload: {
    dataset_id: string;
    ref: string;
    request_id: number;
    callback_token: string;
    callback_url: string;
  };
}

export const STANDIN_MERGE_SHA = "1111111111111111111111111111111111111111";

export interface RepullGitHub {
  requests: string[];
  pulls: Record<string, PullAnswer>;
  defaultHead: string | null;
  tags: Record<string, string>;
  compares: Record<string, string | number>;
  dispatches: Dispatch[];
  dispatchStatus: number;
  down: boolean;
  reset(): void;
  stop(): void;
}

export function startRepullGitHub(o: { defaultHead?: string | null } = {}): RepullGitHub {
  const gh: RepullGitHub = {
    requests: [],
    pulls: {},
    defaultHead: o.defaultHead ?? null,
    tags: {},
    compares: {},
    dispatches: [],
    dispatchStatus: 204,
    down: false,
    reset() {
      gh.requests = [];
      gh.pulls = {};
      gh.defaultHead = o.defaultHead ?? null;
      gh.tags = {};
      gh.compares = {};
      gh.dispatches = [];
      gh.dispatchStatus = 204;
      gh.down = false;
    },
    stop() {
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
      server.stop(true);
    },
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      gh.requests.push(`${req.method} ${url.pathname}`);
      if (gh.down) return new Response("unavailable", { status: 503 });
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        const body = (await req.json()) as Dispatch;
        if (gh.dispatchStatus < 300) gh.dispatches.push(body);
        return new Response(gh.dispatchStatus < 300 ? null : '{"message":"refused"}', {
          status: gh.dispatchStatus,
        });
      }
      let m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/pulls\/(\d+)$/.exec(url.pathname);
      if (m) {
        const n = Number(m[2]);
        const a: PullAnswer | undefined =
          gh.pulls[`${m[1]}#${m[2]}`] ??
          (gh.defaultHead
            ? {
                head: { sha: gh.defaultHead, ref: n === 8 ? "release/v2.0.1" : "release/v2.0.0" },
              }
            : undefined);
        if (!a) return json({ message: "Not Found" }, 404);
        if (a.status && a.status !== 200) return json({ message: "no" }, a.status);
        const body: Record<string, unknown> = {
          number: n,
          state: a.state ?? (a.merged === true ? "closed" : "open"),
          merged: a.merged ?? false,
          merge_commit_sha:
            a.merge_commit_sha === undefined ? STANDIN_MERGE_SHA : a.merge_commit_sha,
          head: a.head ?? { sha: gh.defaultHead, ref: "release/v2.0.0" },
          base: a.base ?? { ref: "main" },
        };
        for (const k of a.omit ?? []) delete body[k];
        return json(body);
      }
      m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/commits\/tags\/(.+)$/.exec(url.pathname);
      if (m) {
        const sha = gh.tags[`${m[1]}@${decodeURIComponent(m[2] as string)}`];
        if (!sha) return json({ message: "No commit found" }, 422);
        return req.headers.get("Accept") === "application/vnd.github.sha"
          ? new Response(sha, { status: 200 })
          : json({ sha });
      }
      m =
        /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(
          url.pathname,
        );
      if (m) {
        const answer = gh.compares[`${m[1]}:${m[2]}...${m[3]}`] ?? "ahead";
        return typeof answer === "number"
          ? json({ message: "no" }, answer)
          : json({ status: answer });
      }
      return json({ message: "Not Found" }, 404);
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
  return gh;
}
