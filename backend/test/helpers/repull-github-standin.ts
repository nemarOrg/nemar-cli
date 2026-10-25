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
 *    `dispatchStatus`;
 *  - `GET .../git/ref/heads/main`: the commit in `mainRefs` (`<id>`) as a ref object, or that HTTP
 *    status when the entry is a number; 404 when absent;
 *  - `GET .../commits/<sha>/check-runs`: the runs in `checkRuns` (`<id>@<sha>`), filtered by the
 *    query's `check_name` and `app_id` as GitHub filters them (unless `checkFiltersIgnored`, a
 *    GitHub that ignored them), or that HTTP status when the entry is a number; none when absent;
 *    `checkTotalCount` makes the list claim more runs than it holds (a page that is not all).
 * A pull request entry may also name its `number`, `user`, the head's and base's `repo` and its
 * `mergeable_state`, which are answered only when named. A request whose path holds `slow` is
 * answered `slowMs` late. Error answers on the reads added for the machine-clean facts carry
 * `Retry-After: 0`, so a retry does not wait. `down` answers every request 503. Every request is
 * recorded in `requests`, and with its query in `urls`.
 */

import type { Server } from "bun";

export interface PullAnswer {
  status?: number;
  number?: number;
  state?: string;
  draft?: boolean;
  merged?: unknown;
  merge_commit_sha?: string | null;
  user?: { login: string; id: number; type: string };
  head?: { sha: string; ref: string; repo?: { full_name: string } | null };
  base?: { ref: string; repo?: { full_name: string } };
  mergeable_state?: string | null;
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

/** One check run as GitHub's `check-runs` list carries it (`app_id` is its `app.id`). */
export interface CheckRunAnswer {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app_id: number;
  /** The commit the run is on; the commit asked about when not given. */
  head_sha?: string;
}

export interface RepullGitHub {
  requests: string[];
  pulls: Record<string, PullAnswer>;
  defaultHead: string | null;
  tags: Record<string, string>;
  compares: Record<string, string | number>;
  dispatches: Dispatch[];
  dispatchStatus: number;
  mainRefs: Record<string, string | number>;
  checkRuns: Record<string, CheckRunAnswer[] | number>;
  checkFiltersIgnored: boolean;
  /** The `total_count` the check-runs list claims, when it is not the runs it holds. */
  checkTotalCount: number | null;
  slow: string | null;
  slowMs: number;
  urls: string[];
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
    mainRefs: {},
    checkRuns: {},
    checkFiltersIgnored: false,
    checkTotalCount: null,
    slow: null,
    slowMs: 1_500,
    urls: [],
    down: false,
    reset() {
      gh.requests = [];
      gh.pulls = {};
      gh.defaultHead = o.defaultHead ?? null;
      gh.tags = {};
      gh.compares = {};
      gh.dispatches = [];
      gh.dispatchStatus = 204;
      gh.mainRefs = {};
      gh.checkRuns = {};
      gh.checkFiltersIgnored = false;
      gh.checkTotalCount = null;
      gh.slow = null;
      gh.slowMs = 1_500;
      gh.urls = [];
      gh.down = false;
    },
    stop() {
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
      server.stop(true);
    },
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  /** An error answer a client retries at once. */
  const refuse = (status: number) =>
    new Response(JSON.stringify({ message: "no" }), {
      status,
      headers: { "Content-Type": "application/json", "Retry-After": "0" },
    });
  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      gh.requests.push(`${req.method} ${url.pathname}`);
      gh.urls.push(`${req.method} ${url.pathname}${url.search}`);
      if (gh.slow !== null && url.pathname.includes(gh.slow)) await Bun.sleep(gh.slowMs);
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
          number: a.number ?? n,
          state: a.state ?? (a.merged === true ? "closed" : "open"),
          draft: a.draft ?? false,
          merged: a.merged ?? false,
          merge_commit_sha:
            a.merge_commit_sha === undefined ? STANDIN_MERGE_SHA : a.merge_commit_sha,
          head: a.head ?? { sha: gh.defaultHead, ref: "release/v2.0.0" },
          base: a.base ?? { ref: "main" },
          ...(a.user === undefined ? {} : { user: a.user }),
          ...(a.mergeable_state === undefined ? {} : { mergeable_state: a.mergeable_state }),
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
      m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/git\/ref\/heads\/main$/.exec(url.pathname);
      if (m) {
        const ref = gh.mainRefs[m[1] as string];
        if (ref === undefined) return refuse(404);
        if (typeof ref === "number") return refuse(ref);
        return json({ ref: "refs/heads/main", object: { sha: ref, type: "commit" } });
      }
      m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/commits\/([0-9a-f]{40})\/check-runs$/.exec(
        url.pathname,
      );
      if (m) {
        const sha = m[2] as string;
        const runs = gh.checkRuns[`${m[1]}@${sha}`] ?? [];
        if (typeof runs === "number") return refuse(runs);
        const name = url.searchParams.get("check_name");
        const app = url.searchParams.get("app_id");
        const kept = gh.checkFiltersIgnored
          ? runs
          : runs.filter(
              (r) =>
                (name === null || r.name === name) && (app === null || String(r.app_id) === app),
            );
        return json({
          total_count: gh.checkTotalCount ?? kept.length,
          check_runs: kept.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            head_sha: r.head_sha ?? sha,
            app: { id: r.app_id },
          })),
        });
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
