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
      /**
       * Never null: `okOrUnavailable` is the only constructor of this
       * variant, and a body-less 2xx leaves as `unavailable`. Stated in the
       * type because the caller measures these bytes against the manifest and
       * a nullable stream would push that invariant to a runtime check.
       */
      body: ReadableStream<Uint8Array>;
      /**
       * Upstream's byte count, when it declared one -- which under the
       * Workers runtime is never, on a real raw fetch. See the
       * `Accept-Encoding` comment below and ADR 0066's 2026-09-16 amendment;
       * this field's permanent nullness in production WAS #1419.
       */
      contentLength: number | null;
      source: GitFileSource;
    }
  /**
   * Both sources answered 404 while we held a credential that can see the
   * repo, so the object really is gone.
   */
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

/**
 * A 2xx is not automatically bytes. A body-less success (204/205) would be
 * served as a 200 with a length we took from the manifest, and an incident
 * page from the host in front of GitHub is `text/html` -- neither is the
 * object the manifest describes, and under a cacheable response either one
 * would be pinned downstream.
 */
function okOrUnavailable(response: Response, source: GitFileSource, noBody: string): GitFileFetch {
  const upstreamType = response.headers.get("Content-Type") ?? "";
  if (upstreamType.includes("text/html")) {
    return {
      kind: "unavailable",
      status: 502,
      message: `content host returned an HTML page instead of file bytes (${upstreamType})`,
      retryAfter: null,
    };
  }
  if (!response.body) {
    return { kind: "unavailable", status: 502, message: noBody, retryAfter: null };
  }
  const declared = response.headers.get("Content-Length");
  return {
    kind: "ok",
    body: response.body,
    contentLength: declared === null ? null : Number.parseInt(declared, 10),
    source,
  };
}

/** Map an upstream status onto what this API should answer. */
function unavailableFrom(response: Response, what: string): GitFileFetch {
  // 401/403 is our credential, not the caller's business, and never absence:
  // answering 404 here would tell a user their file is gone because our token
  // expired. 429 keeps its Retry-After so a client can obey it.
  // A GitHub secondary rate limit arrives as a 403 carrying Retry-After.
  // Reporting it as 502 would tell a client "upstream is broken" when the
  // honest answer is "come back in a moment".
  const throttled =
    response.status === 429 || (response.status === 403 && response.headers.has("Retry-After"));
  const status = throttled ? 503 : 502;
  return {
    kind: "unavailable",
    status,
    message: `${what} (HTTP ${response.status})`,
    retryAfter: response.headers.get("Retry-After"),
  };
}

/** A 40-hex git object name, and nothing else, reaches the blobs URL. */
const BLOB_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Isolate-local ceiling on blob-API fallbacks.
 *
 * The fallback is meant to be rare, and nothing makes it rare: a single
 * retagged dataset turns every request for that path into a REST call, the
 * 404 is `no-store`, and the data bucket allows 10,000 requests a minute from
 * one address. That is enough to spend the org's whole hourly `core` budget
 * in well under a minute and take publishing and imports down with it. So the
 * fallback gets its own budget, and when it is gone the answer is "cannot
 * say" rather than a REST call.
 *
 * Isolate-local like `transport.ts`'s rate-limit state, and for the same
 * reason: there is nowhere cheaper to put it. Many isolates each get their
 * own allowance, so this is a dampener, not a hard cap -- it turns an
 * unbounded amplifier into a bounded one.
 */
const BLOB_FALLBACK_PER_WINDOW = 30;
const BLOB_FALLBACK_WINDOW_MS = 60_000;
let blobWindowStart = 0;
let blobWindowCount = 0;

function blobFallbackAllowed(now = Date.now()): boolean {
  if (now - blobWindowStart > BLOB_FALLBACK_WINDOW_MS) {
    blobWindowStart = now;
    blobWindowCount = 0;
  }
  blobWindowCount++;
  return blobWindowCount <= BLOB_FALLBACK_PER_WINDOW;
}

/** Exported for tests; production never resets it. */
export function __resetBlobFallbackBudgetForTests(): void {
  blobWindowStart = 0;
  blobWindowCount = 0;
}

export async function fetchGitTrackedFile(req: GitFileRequest): Promise<GitFileFetch> {
  const { repo, ref, path, blobSha, token, rawBase = GITHUB_RAW_ORIGIN } = req;

  const headers: Record<string, string> = {
    "User-Agent": "NEMAR-API",
    // Identity, requested but NOT honored, and the comment is kept to say so.
    // The raw host gzips text by default, and then `Content-Length` describes
    // the COMPRESSED body: 717 against a manifest that records 1353 for the
    // same `dataset_description.json` (measured). Asking for identity WOULD
    // make the number mean what the manifest means -- except the Workers
    // runtime owns `Accept-Encoding`, so this header never reaches GitHub:
    // the raw host gzips anyway and workerd strips `Content-Length` when it
    // decodes. `contentLength` is therefore null on every real raw fetch, and
    // the caller's upstream-header check never fired in production at all
    // (ADR 0066, amendment 2026-09-16, #1419). An earlier version of this
    // comment named that outcome as the thing identity was avoiding, which
    // left a reader believing the length check was armed. It was not.
    // Left in place because it costs nothing and would be correct on a
    // runtime that honored it; the length guarantee lives in
    // `sizeCheckedBody` in routes/data.ts, not here.
    "Accept-Encoding": "identity",
  };
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
    return okOrUnavailable(rawResponse, "raw", `content host returned no body for ${repo}/${ref}`);
  }

  if (rawResponse.status !== 404) {
    return unavailableFrom(rawResponse, `content host refused ${repo}/${ref}`);
  }

  // The path is not at that ref. Ask for the object the manifest named --
  // if the SHA is well formed and the fallback budget has room.
  if (!BLOB_SHA_RE.test(blobSha)) {
    console.error(`[data] manifest blob sha is not a git object name repo=${repo} sha=${blobSha}`);
    return {
      kind: "unavailable",
      status: 502,
      message: `manifest recorded an unusable blob id for ${path}`,
      retryAfter: null,
    };
  }
  if (!blobFallbackAllowed()) {
    console.warn(`[data] blob fallback budget exhausted repo=${repo} ref=${ref} path=${path}`);
    return {
      kind: "unavailable",
      status: 503,
      message: "blob fallback budget exhausted",
      retryAfter: "60",
    };
  }

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
    // transport.ts raises HttpError(503) on the interactive pre-flight
    // throttle; flattening that to 502 would discard the one status it went
    // out of its way to choose.
    const status = (err as { status?: number })?.status === 503 ? 503 : 502;
    return {
      kind: "unavailable",
      status,
      message: `blob fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      retryAfter: null,
    };
  }

  if (blobResponse.ok) {
    // Worth a line in the log: the manifest and the tag disagree, which means
    // a retag or a rewritten history, and the blob is only still reachable
    // because git has not garbage-collected it yet.
    console.warn(
      `[data] git file served from blob SHA after raw 404 repo=${repo} ref=${ref} path=${path}`,
    );
    return okOrUnavailable(
      blobResponse,
      "blob",
      `blob response had no body for ${repo}@${blobSha}`,
    );
  }

  if (blobResponse.status === 404) {
    // Only now is absence honest. GitHub answers 404 -- not 403 -- for a
    // repo the caller cannot see, so without a credential these two 404s are
    // indistinguishable from "the repo is private and our token failed to
    // mint". Reporting that as absence would tell every reader their data is
    // gone during a credential outage, which is the exact inversion of
    // ADR 0005 this path exists to avoid.
    if (!token) {
      return {
        kind: "unavailable",
        status: 502,
        message: `${repo}/${ref}/${path} not readable anonymously, and no credential was available to tell absence from a private repo`,
        retryAfter: null,
      };
    }
    return { kind: "absent" };
  }
  return unavailableFrom(blobResponse, `blob fetch refused ${repo}@${blobSha}`);
}
