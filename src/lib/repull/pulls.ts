/**
 * The one reader of a dataset repository's pull-request list (ADR 0111; epic #1046 phase 6): the
 * plan's release-pr check, the open of the release pull request, abandon and supersede all read
 * it here, so a page that cannot be read whole is judged the same way everywhere. The caller passes
 * the fetch it may use: the plan passes its read-only guard's.
 *
 * A list is answered only whole: no answer, a status other than 200, a body that is not a list, an
 * entry without a number, a head ref and sha and a base ref, and a page of 100 or more (which one
 * page cannot show complete) are each a failure with its kind, never a short list.
 */

import { NEMAR_ORG } from "./sources.js";

/** One pull request as the list names it. */
export interface ListedPull {
  number: number;
  state: string;
  headRef: string;
  headSha: string;
  /** The head repository's full name, or null when GitHub no longer names it (a deleted fork). */
  headRepo: string | null;
  baseRef: string;
}

/** Why a list could not be read whole. */
export type PullListFailure =
  | { kind: "unreachable"; detail: string }
  | { kind: "status"; status: number }
  | { kind: "unreadable" }
  | { kind: "too-many" };

export type PullList = { ok: true; pulls: ListedPull[] } | ({ ok: false } & PullListFailure);

/** One entry of the list, or null when it does not have the shape GitHub gives. */
export function listedPull(raw: unknown): ListedPull | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const head = (r.head ?? {}) as Record<string, unknown>;
  const base = (r.base ?? {}) as Record<string, unknown>;
  const repo = (head.repo ?? null) as Record<string, unknown> | null;
  if (
    typeof r.number !== "number" ||
    !Number.isSafeInteger(r.number) ||
    r.number <= 0 ||
    typeof head.ref !== "string" ||
    typeof head.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(head.sha) ||
    typeof base.ref !== "string"
  ) {
    return null;
  }
  return {
    number: r.number,
    state: typeof r.state === "string" ? r.state : "",
    headRef: head.ref,
    headSha: head.sha,
    headRepo: repo && typeof repo.full_name === "string" ? repo.full_name : null,
    baseRef: base.ref,
  };
}

/** Why a list could not be read, in words for a message. */
export function pullListWhy(f: PullListFailure): string {
  switch (f.kind) {
    case "unreachable":
      return `GitHub could not be reached (${f.detail})`;
    case "status":
      return `GitHub answered HTTP ${f.status}`;
    case "too-many":
      return "100 or more pull requests are listed, which one page cannot show complete";
    default:
      return "GitHub's list of pull requests was unreadable";
  }
}

/**
 * The pull requests of the dataset's repository in `state` (`head` filters by a branch of the
 * dataset's own repository), on one page of at most 100.
 */
export async function listPulls(args: {
  token: string;
  base: string;
  datasetId: string;
  state: "open" | "all";
  head?: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  userAgent?: string;
}): Promise<PullList> {
  const head = args.head ? `&head=${encodeURIComponent(`${NEMAR_ORG}:${args.head}`)}` : "";
  const url = `${args.base}/repos/${NEMAR_ORG}/${args.datasetId}/pulls?state=${args.state}${head}&per_page=100`;
  let res: Response;
  try {
    res = await (args.fetcher ?? fetch)(url, {
      headers: {
        Authorization: `Bearer ${args.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": args.userAgent ?? "nemar-cli repull",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "unreachable",
      detail: err instanceof Error ? err.name : "fetch failed",
    };
  }
  if (res.status !== 200) return { ok: false, kind: "status", status: res.status };
  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) return { ok: false, kind: "unreadable" };
  if (body.length >= 100) return { ok: false, kind: "too-many" };
  const pulls = body.map(listedPull);
  if (pulls.some((p) => p === null)) return { ok: false, kind: "unreadable" };
  return { ok: true, pulls: pulls as ListedPull[] };
}
