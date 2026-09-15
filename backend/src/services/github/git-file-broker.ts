/**
 * Reads one git-tracked dataset file for the data plane to serve itself.
 *
 * The data plane used to 302 these files to `raw.githubusercontent.com`. That
 * carried an unstated precondition -- the repo public, the tag present -- and
 * when it broke, the 302 target 404'd at GitHub with no Worker-side signal.
 * It also meant we could not say how much data we served (a redirect records
 * intent, never delivery), and it cannot work at all for a dataset whose repo
 * is deliberately private, which is the shape an anonymous deposit takes
 * (#1403, epic #1406).
 *
 * So the Worker now fetches the bytes and streams them. Three things decide
 * how:
 *
 * **The raw host, not the REST API.** A blobs-API response carries
 * `x-ratelimit-limit: 5000` on the `core` resource -- an hourly budget per
 * installation that publishing, imports and every sweep also spend. One cold
 * download of a dataset like nm000104 is 4,557 git-tracked files, so routing
 * that through the REST API would exhaust the org's whole quota in a single
 * download and break publishing as a side effect. The raw host returns no
 * `x-ratelimit-*` header at all and serves a private repo when the request
 * carries an installation token (checked against `nemarDatasets/nm099999`:
 * anonymous 404, authenticated 200).
 *
 * **The blobs API is the fallback, and it is the stricter one.** A raw 404
 * means the path is not at that ref: a moved tag, a pruned blob, a rewritten
 * history. The manifest still knows the blob SHA it recorded at publish time,
 * so the retry asks for that object directly and gets exactly the bytes the
 * manifest promised, or an honest absence. It is rare by construction, which
 * is what keeps the REST budget out of the hot path.
 *
 * **A throttle is not an absence.** Only a 404 from both sources means the
 * file is gone; everything else (a refused token, a secondary rate limit, a
 * 5xx, a dropped connection) is reported as unavailable so the caller can
 * answer 5xx rather than telling a user their data does not exist. That is
 * ADR 0005's rule, one level down from where it was written.
 */

import { GITHUB_API, GITHUB_RAW_ORIGIN, ORG_NAME, rawContentUrl } from "./shared.js";
import { githubFetchWithRetry } from "./transport.js";

export type GitFileSource = "raw" | "blob";

export type GitFileFetch =
  | {
      kind: "ok";
      body: ReadableStream<Uint8Array> | null;
      /** Upstream's byte count, when it declared one. */
      contentLength: number | null;
      source: GitFileSource;
    }
  /** Both sources answered an authoritative 404. */
  | { kind: "absent" }
  /** Anything that is not evidence about whether the object exists. */
  | { kind: "unavailable"; status: number; message: string; retryAfter: string | null };

export interface GitFileRequest {
  /** Dataset repo under `nemarDatasets`, taken from the catalog row. */
  repo: string;
  /** Version tag the manifest was generated at. */
  ref: string;
  /** BIDS-relative path, as resolved from the manifest. */
  path: string;
  /** Blob SHA the manifest recorded, without the `git:` prefix. */
  blobSha: string;
  /** Installation token; omit to read anonymously (public repos only). */
  token?: string | null;
  /** Raw content host. Overridden in tests by a local server. The blob
   *  fallback follows `GITHUB_API()`, which has its own test override. */
  rawBase?: string;
}

/** Map an upstream status onto what this API should answer. */
function unavailableFrom(response: Response, what: string): GitFileFetch {
  // 401/403 is our credential, not the caller's business, and never absence:
  // answering 404 here would tell a user their file is gone because our token
  // expired. 429 keeps its Retry-After so a client can obey it.
  const status = response.status === 429 ? 503 : 502;
  return {
    kind: "unavailable",
    status,
    message: `${what} (HTTP ${response.status})`,
    retryAfter: response.headers.get("Retry-After"),
  };
}

export async function fetchGitTrackedFile(req: GitFileRequest): Promise<GitFileFetch> {
  const { repo, ref, path, blobSha, token, rawBase = GITHUB_RAW_ORIGIN } = req;

  const headers: Record<string, string> = { "User-Agent": "NEMAR-API" };
  if (token) headers.Authorization = `Bearer ${token}`;

  // A plain fetch, and NO in-request retry. `githubFetchWithRetry` is built
  // for the REST API: it retries a 429 after the upstream's `Retry-After`,
  // which on a real GitHub throttle is tens of seconds. Sleeping that long
  // inside a user's byte fetch turns a fast 503 into a hang, holds a Worker
  // invocation open, and helps nobody -- every client of this route already
  // retries with backoff (the CLI in src/lib/file-download.ts, rclone,
  // browsers). Fail fast and say why.
  let rawResponse: Response;
  try {
    rawResponse = await fetch(rawContentUrl(rawBase, repo, ref, path), {
      headers,
      redirect: "follow",
    });
  } catch (err) {
    return {
      kind: "unavailable",
      status: 502,
      message: `content host unreachable: ${err instanceof Error ? err.message : String(err)}`,
      retryAfter: null,
    };
  }

  if (rawResponse.ok) {
    const declared = rawResponse.headers.get("Content-Length");
    return {
      kind: "ok",
      body: rawResponse.body,
      contentLength: declared === null ? null : Number.parseInt(declared, 10),
      source: "raw",
    };
  }

  if (rawResponse.status !== 404) {
    return unavailableFrom(rawResponse, `content host refused ${repo}/${ref}`);
  }

  // The path is not at that ref. Ask for the object the manifest named.
  let blobResponse: Response;
  try {
    blobResponse = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/blobs/${blobSha}`,
      {
        headers: {
          ...headers,
          Accept: "application/vnd.github.raw",
        },
      },
      // Same no-sleep rule as above; "interactive" makes the wrapper throw
      // rather than pause when its rate-limit snapshot looks low, and one
      // attempt means no Retry-After sleep. The wrapper is still worth using
      // here because this call DOES spend the REST budget, and it is what
      // records that spend.
      { maxAttempts: 1, kind: "interactive" },
    );
  } catch (err) {
    return {
      kind: "unavailable",
      status: 502,
      message: `blob fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      retryAfter: null,
    };
  }

  if (blobResponse.ok) {
    const declared = blobResponse.headers.get("Content-Length");
    // Worth a line in the log: the manifest and the tag disagree, which means
    // a retag or a rewritten history, and the blob is only still reachable
    // because git has not garbage-collected it yet.
    console.warn(
      `[data] git file served from blob SHA after raw 404 repo=${repo} ref=${ref} path=${path}`,
    );
    return {
      kind: "ok",
      body: blobResponse.body,
      contentLength: declared === null ? null : Number.parseInt(declared, 10),
      source: "blob",
    };
  }

  if (blobResponse.status === 404) return { kind: "absent" };
  return unavailableFrom(blobResponse, `blob fetch refused ${repo}@${blobSha}`);
}
