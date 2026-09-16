/**
 * data.nemar.org route (epic #449).
 *
 * Public, anonymous HTTPS access to every published dataset, BIDS-shaped.
 * The same sub-app is reachable via two paths:
 *
 *   - https://data.nemar.org/<id>/<version>/...        (custom domain, production)
 *   - https://api.nemar.org/data/<id>/<version>/...    (mount, all envs incl. workers.dev dev)
 *
 * Private/unpublished datasets are not exposed here -- those stay on the
 * existing nemar-cli + git-annex flow.
 */

import { Hono } from "hono";
import { recordAccess } from "../services/access-metrics";
import {
  type CatalogIndexBuildResult,
  type CatalogIndexRow,
  type DatasetRowForMetadata,
  type DatasetVersionRow,
  type PublicManifestEntry,
  type VersionPickerEntry,
  buildBytesUrl,
  buildCatalogIndexPayload,
  buildDatasetMetadata,
  buildLandingPayload,
  buildRedirectUrl,
  contentTypeForBidsPath,
  diffRemovedSince,
  findLastSeenVersion,
  pickResponseFormat,
  renderCatalogIndexHtml,
  renderDatasetLandingHtml,
  renderIndexHtml,
  renderTombstone404Html,
  resolveFile,
  resolveQaPath,
  resolveVersion,
  toHttpDate,
  toVersionTag,
} from "../services/data-router";
import { parseNemarMetadata } from "../services/datacite";
import { isValidDatasetId } from "../services/datasetId";
import { resolveDataBaseOrigin } from "../services/environment";
import { ORG_NAME } from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import { fetchGitTrackedFile } from "../services/github/git-file-broker";
import type { ManifestFile, VersionManifest } from "../services/manifest";
import { buildPageBundle } from "../services/page-bundle";
import {
  type PresignedUrlOptions,
  generatePresignedGetUrl,
  getArchiveUrl,
  getManifest,
  headArchive,
  loadRecords,
  loadSummary,
} from "../services/s3";
import type { Bindings, Variables } from "../types/bindings";

export const dataRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function s3OptionsFromEnv(env: Bindings): PresignedUrlOptions {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpointUrl: env.S3_ENDPOINT_URL,
  };
}

/**
 * Resolve a dataset id to its public-readable D1 row. Collapses every
 * reject reason into the same `null` return so the route cannot leak
 * whether a private dataset exists, but emits one structured log line
 * per branch so operators can tell scraping from honest 404s.
 */
async function loadPublishedDataset(env: Bindings, datasetId: string) {
  if (!isValidDatasetId(datasetId)) {
    console.log(`[data] reject: invalid id format datasetId=${datasetId}`);
    return null;
  }
  const row = await env.DB.prepare(
    "SELECT dataset_id, visibility, archive_status, archive_size, archive_skip_reason FROM datasets WHERE dataset_id = ?",
  )
    .bind(datasetId)
    .first<{
      dataset_id: string;
      visibility: string;
      archive_status: string | null;
      archive_size: number | null;
      archive_skip_reason: string | null;
    }>();
  if (!row) {
    console.log(`[data] reject: not in catalog datasetId=${datasetId}`);
    return null;
  }
  if (row.visibility !== "public") {
    console.log(`[data] reject: visibility=${row.visibility ?? "null"} datasetId=${datasetId}`);
    return null;
  }
  return row;
}

async function loadManifest(
  env: Bindings,
  datasetId: string,
  version: string,
): Promise<VersionManifest | null> {
  // getManifest can throw on network/S3 errors. Phase 3 introduces hot
  // call sites (tombstone walk fans out up to 10 fetches per 404,
  // "removed since" footer fetches the prior version on every directory
  // index render) where a transient S3 blip should degrade to "no
  // tombstone hint / no footer" instead of 500ing the whole response.
  // Phase 1 callers only ever fetched the requested version once, so the
  // original "throw kills the request" behavior was acceptable; not so
  // any more.
  let raw: string | null;
  try {
    raw = await getManifest(s3OptionsFromEnv(env), datasetId, version);
  } catch (err) {
    console.error(
      `[data] manifest fetch failed dataset=${datasetId} version=${version}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[data] malformed manifest JSON dataset=${datasetId} version=${version}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("files" in parsed) ||
    typeof (parsed as { files: unknown }).files !== "object" ||
    (parsed as { files: unknown }).files === null
  ) {
    console.error(`[data] manifest missing 'files' object dataset=${datasetId} version=${version}`);
    return null;
  }
  return parsed as VersionManifest;
}

/**
 * Extra fields attached to a file 404. Always includes `version` and
 * `path` so a JSON consumer can self-describe the response without
 * re-parsing the request URL. When the path was removed in a recent
 * prior version, the `reason` + `last_seen_*` fields point the
 * consumer at the URL that still serves the bytes.
 */
interface FileNotFoundPayload {
  version: string;
  path: string;
  reason?: "removed";
  last_seen_version?: string;
  last_seen_url?: string;
}

function notFound(message: string, payload?: FileNotFoundPayload, noStore = false) {
  const body = payload ? { error: message, ...payload } : { error: message };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // The JSON-artifact handlers (summary/records) opt into no-store on their
  // "dataset/version not found" early-exits so those 404s are never CDN-pinned
  // while the version row or artifact is still being written asynchronously
  // after a publish (matching the artifact-not-found path in the same handlers).
  if (noStore) headers["Cache-Control"] = "no-store";
  return new Response(JSON.stringify(body), { status: 404, headers });
}

/**
 * 404 for a file path that takes content negotiation into account.
 *
 * - Accept: text/html -> friendly HTML page, with the last-seen URL when known.
 * - everything else -> JSON, with `reason: "removed"` + `last_seen_*` when known.
 *
 * The "what does an absent path mean?" decision is shared between JSON
 * and HTML callers, so the format pick happens once at the route boundary
 * and the rest of the handler is shape-agnostic.
 */
function fileNotFound(args: {
  request: Request;
  datasetId: string;
  version: string;
  path: string;
  lastSeen: { version: string; href: string } | null;
}): Response {
  const { request, datasetId, version, path, lastSeen } = args;
  const accept = request.headers.get("accept");
  const formatParam = new URL(request.url).searchParams.get("format");
  const fmt = pickResponseFormat({ accept, formatParam });

  if (fmt === "html") {
    const html = renderTombstone404Html({ datasetId, version, path, lastSeen });
    return new Response(html, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (lastSeen) {
    return notFound("File not found", {
      version,
      path,
      reason: "removed",
      last_seen_version: lastSeen.version,
      last_seen_url: lastSeen.href,
    });
  }
  return notFound("File not found", { version, path });
}

function parseChecksum(checksum: string): { algorithm: string; value: string } {
  const colon = checksum.indexOf(":");
  if (colon === -1) return { algorithm: "unknown", value: checksum };
  return { algorithm: checksum.slice(0, colon), value: checksum.slice(colon + 1) };
}

/**
 * GET /<id>/<version>/manifest.json -> public file index with presigned URLs.
 */
async function manifestJsonHandler(
  env: Bindings,
  datasetId: string,
  versionParam: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  if (!resolved.ok) return notFound("Version not found");

  const manifest = await loadManifest(env, datasetId, resolved.version);
  if (!manifest) return notFound("Version not published");

  const s3Options = s3OptionsFromEnv(env);
  const entries: PublicManifestEntry[] = await Promise.all(
    Object.entries(manifest.files).map(async ([path, file]): Promise<PublicManifestEntry> => {
      const checksum = parseChecksum(file.checksum);
      const base = {
        path,
        size: file.size,
        checksum_algorithm: checksum.algorithm,
        checksum: checksum.value,
        bytes_url: buildBytesUrl({
          datasetId,
          version: resolved.version,
          bidsPath: path,
          origin: resolveDataBaseOrigin(env),
        }),
      };
      // A git-tracked file has no presigned form: the Worker streams it from
      // the data plane, so the immediate URL and the durable one are the same
      // route. Annex files keep the 1h presigned S3 URL in `url`.
      if (isGitTrackedFile(file)) {
        return { ...base, url: base.bytes_url };
      }
      try {
        const url = await buildRedirectUrl({
          datasetId,
          version: resolved.version,
          bidsPath: path,
          file,
          s3Options,
        });
        return { ...base, url };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[data] manifest.json buildRedirectUrl failed dataset=${datasetId} version=${resolved.version} path=${path}:`,
          message,
        );
        return { ...base, url: null, error: message };
      }
    }),
  );

  return new Response(JSON.stringify(entries), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
}

/**
 * Fetch every published version row for a dataset, newest-first.
 * Returns the same shape used by metadataJsonHandler and the landing
 * page. Empty array means "dataset exists but unpublished" *or* the D1
 * query threw -- callers cannot distinguish, by design.
 *
 * D1 errors are absorbed and returned as an empty array so that
 * presentational features in `fileOrIndexHandler` (version picker,
 * "removed since" footer, tombstone walk) cannot 500 a file redirect
 * that would otherwise succeed. The landing page does need this data
 * to do its job, but degrading to "empty version list" there is still
 * better than a 500 -- the page can render a "no published versions"
 * notice instead.
 */
async function loadVersionRows(env: Bindings, datasetId: string): Promise<DatasetVersionRow[]> {
  try {
    const result = await env.DB.prepare(
      "SELECT version, doi, created_at FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
    )
      .bind(datasetId)
      .all<DatasetVersionRow>();
    return result.results ?? [];
  } catch (err) {
    console.error(
      `[data] dataset_versions query failed dataset=${datasetId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Ceiling on a git-tracked file the Worker will carry. Chosen far above any
 * real BIDS sidecar so it is a guard against an annex-policy slip, not a
 * working limit.
 */
const MAX_BROKERED_FILE_BYTES = 32 * 1024 * 1024;

/** Is this manifest entry carried by git rather than git-annex (ADR 0015)? */
export function isGitTrackedFile(file: ManifestFile): boolean {
  return file.key.startsWith("git:");
}

/**
 * Serve a git-tracked file's bytes from the data plane itself.
 *
 * The visibility gate has already run in the caller, and it runs before this
 * function is ever reached: nothing here mints a token or touches GitHub for
 * a dataset the catalog will not serve. The two identifiers this uses are
 * both ours rather than the caller's -- the repo is the catalog row's
 * `dataset_id`, and the path and blob SHA come from the manifest entry the
 * resolver matched. A request cannot name a repo, a ref or a blob.
 *
 * Nothing caches by blob SHA. The edge caches this response under its request
 * URL, which is dataset- and version-scoped; a SHA-keyed entry would be
 * content-addressed and therefore shared between datasets, so an identical
 * `dataset_description.json` in a private dataset and a public one would be
 * one cache entry and the gate would be bypassed for whoever asked second.
 */
async function streamGitTrackedFile(args: {
  env: Bindings;
  datasetId: string;
  version: string;
  bidsPath: string;
  file: ManifestFile;
  createdIso: string;
}): Promise<Response> {
  const { env, datasetId, version, bidsPath, file, createdIso } = args;

  // Read anonymously when no credential is CONFIGURED: a public repo serves
  // fine without one, and a local or preview deployment with no GitHub App
  // should not lose every metadata file. What must not happen is the
  // anonymous read then being mistaken for proof of absence -- GitHub answers
  // 404, not 403, for a repo the caller cannot see -- so the broker refuses
  // to report `absent` without a credential, and a mint FAILURE (as opposed
  // to no credentials at all) is reported rather than downgraded: during a
  // key rotation every git file in every dataset would otherwise 404 and log
  // itself as a data-integrity event.
  let token: string | null = null;
  try {
    token = await getDatasetsToken(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (env.GITHUB_APP_ID || env.GITHUB_ADMIN_PAT) {
      console.error(
        `[data] git-file broker could not mint a token dataset=${datasetId}: ${message}`,
      );
      return new Response(
        JSON.stringify({ error: "Upstream content host unavailable", dataset_id: datasetId }),
        {
          status: 503,
          headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
        },
      );
    }
    console.warn(`[data] no GitHub credential configured dataset=${datasetId}: ${message}`);
  }

  // git is supposed to carry metadata (ADR 0015), and ADR 0031 records that
  // the annex policy is a judgment call rather than a law of nature. One slip
  // that commits a recording to git would otherwise make this Worker proxy a
  // multi-gigabyte file -- the shape the zarr plane refuses on purpose. The
  // ceiling is far above any real sidecar (the largest measured across the
  // catalog is 283 KB) so it never fires in normal operation, and when it
  // does it names the policy rather than timing out.
  if (file.size > MAX_BROKERED_FILE_BYTES) {
    console.error(
      `[data] git-tracked file exceeds the broker ceiling dataset=${datasetId} path=${bidsPath} size=${file.size}`,
    );
    return new Response(
      JSON.stringify({
        error: "File is too large to serve from git; it should be annexed (ADR 0031)",
        dataset_id: datasetId,
      }),
      { status: 502, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } },
    );
  }

  const outcome = await fetchGitTrackedFile({
    repo: datasetId,
    ref: version,
    path: bidsPath,
    // `key` is what `isGitTrackedFile` matched on; `checksum` carries the
    // same value today, but taking it from the field the branch was
    // decided by is what keeps them from drifting apart.
    blobSha: file.key.replace(/^git:/, ""),
    token,
    // Test seam, and the same shape ORCID_API_BASE uses: unset in production,
    // where the broker's own default (the real raw host) applies.
    rawBase: env.GITHUB_RAW_BASE,
  });

  if (outcome.kind === "absent") {
    // The manifest promised a blob GitHub does not have. That is a
    // data-integrity event, not a routine miss, and the operator needs it
    // named; the caller still gets an ordinary 404.
    console.error(
      `[data] MANIFEST DRIFT: git blob absent dataset=${datasetId} version=${version} path=${bidsPath} sha=${file.checksum}`,
    );
    return notFound("File not found", undefined, true);
  }

  if (outcome.kind === "unavailable") {
    console.error(
      `[data] git-file broker unavailable dataset=${datasetId} version=${version} path=${bidsPath}: ${outcome.message}`,
    );
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    if (outcome.retryAfter) headers.set("Retry-After", outcome.retryAfter);
    return new Response(
      JSON.stringify({ error: "Upstream content host unavailable", dataset_id: datasetId }),
      { status: outcome.status, headers: headers },
    );
  }

  // A size that disagrees with the manifest means the tag moved under us, so
  // these are not the bytes the manifest describes. Refusing is the same rule
  // the CLI applies to a short write (#1402): a wrong-length file that looks
  // healthy is worse than an error.
  //
  // This is the FAST path, not the guarantee: it fires only when upstream
  // declared a length, and workerd strips that header on a real raw fetch
  // (see `sizeCheckedBody`). It buys a clean 502 before the body is read at
  // all when the header survives; the measurement below is what holds when it
  // does not.
  if (outcome.contentLength !== null && outcome.contentLength !== file.size) {
    console.error(
      `[data] SIZE MISMATCH dataset=${datasetId} version=${version} path=${bidsPath} manifest=${file.size} upstream=${outcome.contentLength}`,
    );
    return new Response(JSON.stringify({ error: "Upstream content did not match the manifest" }), {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    });
  }

  // Counted when the bytes are handed to the runtime, not when the client
  // finishes reading them, so an aborted download still counts as a full
  // delivery. Closer than the redirect it replaces (which could only ever
  // record intent), and worth stating rather than overclaiming.
  recordAccess(env, {
    datasetId,
    source: "file",
    detail: `git-${outcome.source}`,
    bytes: file.size,
  });

  const outgoing = await sizeCheckedBody(outcome.body, file.size, bufferCeiling(env), {
    datasetId,
    version,
    bidsPath,
  });
  if (outgoing.kind === "mismatch") {
    console.error(
      `[data] SIZE MISMATCH dataset=${datasetId} version=${version} path=${bidsPath} manifest=${file.size} delivered=${outgoing.measured}`,
    );
    return new Response(JSON.stringify({ error: "Upstream content did not match the manifest" }), {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    });
  }
  if (outgoing.kind === "unreadable") {
    console.error(
      `[data] git-file broker body failed mid-read dataset=${datasetId} version=${version} path=${bidsPath}: ${outgoing.message}`,
    );
    return new Response(
      JSON.stringify({ error: "Upstream content host unavailable", dataset_id: datasetId }),
      { status: 502, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } },
    );
  }
  const headers = new Headers(fileResponseHeaders(file, createdIso, false));
  headers.set("Content-Type", contentTypeForBidsPath(bidsPath));
  // NOT immutable, and not a year. The content at this URL is immutable --
  // it is version-pinned and content-addressed -- but the AUTHORIZATION is
  // not: `applyVisibilityTransition` can take a dataset private, and it
  // purges nothing (per-URL purge caps at 30 URLs and prefix purge is
  // Enterprise-only, services/cloudflare.ts). A year-long `immutable` would
  // leave every shared cache serving a withdrawn dataset's participants and
  // sidecars to other readers, with no recovery and no revalidation. The
  // redirect this replaces bounded that at 300s; so does this.
  headers.set("Cache-Control", "public, max-age=300");
  // The raw host answered `Access-Control-Allow-Origin: *` on exactly these
  // bytes, and bytes_url invites a consumer to persist the URL. Moving the
  // host must not quietly revoke browser access for a notebook or a viewer
  // that is not on a nemar.org origin: this is anonymous public data and the
  // request carries no credentials.
  headers.set("Access-Control-Allow-Origin", "*");
  // A dataset is user-supplied content served from our own origin now. The
  // type is already an inert one from the allowlist; nosniff stops a browser
  // from deciding otherwise, and the sandbox CSP makes it inert even then.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  // Declared only on the buffered branch, where the bytes are in hand and
  // their length has just been checked against the manifest. On the streamed
  // branch it is deliberately absent: a header set on a streamed body does
  // not survive the runtime (workerd sends it chunked and drops the header,
  // measured on the deployed worker), so setting one there would be a claim
  // the response does not carry rather than a fact about it.
  if (!(outgoing.body instanceof ReadableStream)) {
    headers.set("Content-Length", String(outgoing.body.byteLength));
  }
  return new Response(outgoing.body, { status: 200, headers });
}

/**
 * Default size below which a brokered git file is read into memory before it
 * is answered, so the runtime can declare a `Content-Length`.
 *
 * Far above anything real -- the largest git-tracked file measured across the
 * catalog is 283 KB, against the 32 MB ceiling `MAX_BROKERED_FILE_BYTES`
 * enforces -- and far below the 128 MB a Worker holds for all of its
 * concurrent requests, so the buffered branch is what every actual dataset
 * takes and the streamed branch is the escape hatch for a file that should
 * have been annexed.
 */
const DEFAULT_BROKER_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

function bufferCeiling(env: Bindings): number {
  const raw = env.BROKER_BUFFER_MAX_BYTES;
  if (raw === undefined) return DEFAULT_BROKER_BUFFER_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BROKER_BUFFER_MAX_BYTES;
}

type BrokeredBody =
  | { kind: "body"; body: Uint8Array | ReadableStream<Uint8Array> }
  | { kind: "mismatch"; measured: number }
  | { kind: "unreadable"; message: string };

/**
 * Make the body prove the manifest's length before it is answered.
 *
 * WHY THIS BUFFERS, given that streaming is the house default (ADR 0030).
 * Setting `Content-Length` by hand on a streamed `Response` does not survive:
 * workerd sends it chunked and drops the header. Measured against the
 * deployed data plane on 2026-09-16 (`0.10.4-dev17`, the first build that set
 * it): still no `Content-Length` on the response. A body of known byte length
 * is the only shape the runtime will declare a length for, so a length that
 * reaches the client has to be one we already hold.
 *
 * It buys the stronger failure too. A mismatch found in a buffer is a clean
 * 502 before a byte is sent, where a mismatch found mid-stream can only be an
 * aborted transfer. That matters because the check itself is the point: the
 * upstream-header comparison it backstops never once ran in production, so
 * "the tag moved under us and these are not the manifest's bytes" was going
 * unnoticed rather than being caught.
 *
 * Above the ceiling it degrades to the stream with a counter, which cannot
 * declare a length but still refuses to let a short or overrun body finish
 * looking complete.
 */
async function sizeCheckedBody(
  body: ReadableStream<Uint8Array>,
  expected: number,
  ceiling: number,
  where: { datasetId: string; version: string; bidsPath: string },
): Promise<BrokeredBody> {
  if (expected > ceiling) {
    return { kind: "body", body: countedStream(body, expected, where) };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await new Response(body).arrayBuffer());
  } catch (err) {
    return { kind: "unreadable", message: err instanceof Error ? err.message : String(err) };
  }
  if (bytes.byteLength !== expected) return { kind: "mismatch", measured: bytes.byteLength };
  return { kind: "body", body: bytes };
}

/**
 * The streamed fallback for a file too large to hold: count the bytes and
 * error the stream if the total disagrees with the manifest.
 *
 * The response carries no `Content-Length` on this path, because one set here
 * would not survive (see `sizeCheckedBody`). What it does carry is the
 * guarantee that a wrong-length body fails the transfer -- the same signal a
 * short write gives the CLI (`file-download.ts`, #1402) -- rather than
 * arriving looking healthy.
 */
function countedStream(
  body: ReadableStream<Uint8Array>,
  expected: number,
  where: { datasetId: string; version: string; bidsPath: string },
): ReadableStream<Uint8Array> {
  let seen = 0;
  const describe = () =>
    `dataset=${where.datasetId} version=${where.version} path=${where.bidsPath} manifest=${expected} delivered=${seen}`;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        // Refuse the overrun rather than passing bytes beyond the manifest's
        // length: past `expected` the response is already not what the
        // manifest describes, and the extra bytes are what a client would
        // have to discard.
        if (seen > expected) {
          console.error(`[data] SIZE MISMATCH (overrun) ${describe()}`);
          controller.error(new Error("Upstream content did not match the manifest"));
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== expected) {
          console.error(`[data] SIZE MISMATCH (short) ${describe()}`);
          controller.error(new Error("Upstream content did not match the manifest"));
        }
      },
    }),
  );
}

/**
 * Build the rclone-friendly file metadata headers for a manifest entry.
 *
 * `ETag` is the manifest checksum verbatim (`"sha256:<hex>"` for
 * git-annex files, `"git:<sha>"` for inline git content). Content-
 * addressed and stable across re-publications of identical content.
 * RFC 7232 requires the value be quoted, hence the wrapping.
 *
 * `withContentLength` controls whether `Content-Length` is emitted.
 * Per RFC 9110 §8.6 the field describes the message body, not the
 * resource. For a HEAD 200 with no body, `Content-Length: <size>`
 * advertises what a subsequent GET would return -- standard and what
 * every HTTP client (rclone, browsers, curl) expects on HEAD. For a
 * GET 302 with no body, emitting `Content-Length: <size>` is a spec
 * deviation: the message body is empty, the field would describe the
 * redirect target. Some intermediaries can mis-frame a long-`Content-
 * Length` 302 as a hung response, so the GET 302 branch deliberately
 * omits it and relies on the redirect target's S3 GET to advertise
 * size. `Last-Modified` and `ETag` remain on the 302 -- both are
 * valid on redirects per RFC 9110 §8.8.
 */
function fileResponseHeaders(
  file: ManifestFile,
  createdIso: string,
  withContentLength: boolean,
): HeadersInit {
  const base: Record<string, string> = {
    "Last-Modified": toHttpDate(createdIso),
    ETag: `"${file.checksum}"`,
    "Cache-Control": "public, max-age=300",
  };
  if (withContentLength) base["Content-Length"] = String(file.size);
  return base;
}

/**
 * GET /<id>/<version>/<path> -> 302 to file bytes, or HTML directory listing.
 * HEAD /<id>/<version>/<path> -> 200 with file metadata headers (no body),
 * or 200 with text/html content-type (no body) for directories.
 *
 * HEAD lets the rclone HTTP backend resolve every file's size and mtime
 * without following a redirect (rclone's HTTP backend does NOT follow
 * HEAD redirects by default). The tombstone walk is intentionally
 * skipped on HEAD: rclone fans out HEAD across every file it doesn't
 * have locally, and a 10-version walk per missing-path HEAD would
 * balloon a sync against a divergent local copy.
 */
async function fileOrIndexHandler(
  env: Bindings,
  request: Request,
  datasetId: string,
  versionParam: string,
  rawPath: string,
): Promise<Response> {
  const isHead = request.method === "HEAD";

  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  if (!resolved.ok) return notFound("Version not found");

  const manifest = await loadManifest(env, datasetId, resolved.version);
  if (!manifest) return notFound("Version not published");

  const result = resolveFile(manifest, rawPath);

  // HEAD branch: serve from `result` alone -- no D1 round-trip for
  // picker/footer (HEAD doesn't render HTML chrome), no tombstone walk
  // (rclone just needs the 404). Keeps `rclone sync` cheap per file.
  if (isHead) {
    if (result.kind === "file") {
      const headers = new Headers(fileResponseHeaders(result.file, manifest.created, true));
      // A git-tracked file's GET now answers with a content type, so its HEAD
      // has to agree: rclone's HTTP backend probes with HEAD and then GETs,
      // and a HEAD that describes a different response than the GET is how a
      // sync ends up with the wrong expectations.
      if (isGitTrackedFile(result.file)) {
        headers.set("Content-Type", contentTypeForBidsPath(result.path));
      }
      return new Response(null, { status: 200, headers });
    }
    if (result.kind === "directory") {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=60",
        },
      });
    }
    // not_found
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

  // One D1 round-trip for the picker, the "removed since" diff, and the
  // tombstone walk. The query is cheap and used by every render path
  // below; fetching once keeps the handler at a single dataset_versions
  // read per request regardless of how many of those features fire.
  const versionRows = await loadVersionRows(env, datasetId);
  const versionTags = versionRows.map((r) => toVersionTag(r.version));
  const availableVersions: VersionPickerEntry[] = versionTags.map((tag) => ({
    version: tag,
    isCurrent: tag === resolved.version,
  }));

  if (result.kind === "not_found") {
    // Tombstone lookup: walk older versions newest-first looking for the
    // first one that contained this exact path. Cheap when the path
    // never existed (caps out at TOMBSTONE_LOOKBACK fetches) and useful
    // when the path was removed in a recent version.
    const currentIdx = versionTags.indexOf(resolved.version);
    const olderVersions =
      currentIdx === -1 ? versionTags.slice(1) : versionTags.slice(currentIdx + 1);
    const lastSeen = await findLastSeenVersion({
      path: rawPath.replace(/^\/+/, "").replace(/\/+$/, ""),
      olderVersions,
      loadManifest: (v) => loadManifest(env, datasetId, v),
    });
    const urlObj = new URL(request.url);
    const lastSeenHref = lastSeen
      ? `${urlObj.protocol}//${urlObj.host}/${datasetId}/${lastSeen.version}/${rawPath.replace(/^\/+/, "")}`
      : null;
    return fileNotFound({
      request,
      datasetId,
      version: resolved.version,
      path: rawPath,
      lastSeen: lastSeen && lastSeenHref ? { version: lastSeen.version, href: lastSeenHref } : null,
    });
  }

  if (result.kind === "file") {
    // git-tracked bytes are served from here rather than redirected to
    // GitHub (#1403): it is the only way a dataset whose repo is private
    // stays readable, and it is the only way we can count what we delivered.
    if (isGitTrackedFile(result.file)) {
      return streamGitTrackedFile({
        env,
        datasetId: dataset.dataset_id,
        version: resolved.version,
        bidsPath: result.path,
        file: result.file,
        createdIso: manifest.created,
      });
    }
    const url = await buildRedirectUrl({
      datasetId,
      version: resolved.version,
      bidsPath: result.path,
      file: result.file,
      s3Options: s3OptionsFromEnv(env),
    });
    // Surface mtime/ETag on the 302 itself for clients that skip the
    // HEAD step (custom downloaders, conditional GET preflights).
    // Content-Length is deliberately omitted from the 302 -- per RFC
    // 9110 §8.6 it describes the (empty) message body, not the redirect
    // target. The S3 target's GET response carries it accurately.
    const headers = new Headers(fileResponseHeaders(result.file, manifest.created, false));
    headers.set("Location", url);
    return new Response(null, { status: 302, headers });
  }

  if (result.kind === "directory") {
    // JSON content negotiation runs BEFORE the removed-since diff so the
    // JSON path doesn't pay an extra D1 round-trip + manifest fetch it
    // doesn't need. Follows the same `pickResponseFormat` + early-return
    // approach as `qaHandler` and `datasetRootResponse` further down,
    // though `qaHandler` additionally folds HEAD into its JSON branch
    // (HEAD on this directory route stays text/html — see line ~371 —
    // for rclone-style consumers that ignore Accept).
    //
    // Shape note: the QA equivalent carries `truncated` because its
    // resolver is backed by a paged S3 ListObjectsV2. The manifest-
    // backed `resolveFile` here materialises every child up-front, so
    // a `truncated` field would always be false — omitting it
    // deliberately rather than emitting a permanent-`false`.
    //
    // `Vary: "Accept"` is required: HTML and JSON share the same URL,
    // and a shared cache without Vary in its key would mix them. The
    // `?format=` variant sidesteps the issue because the URL differs,
    // but `Accept`-only requests need it.
    //
    // Programmatic consumers (the website's tree UI primarily — see
    // nemarOrg/website#76 for the pivot off summary.json) get the same
    // `result.children` shape the HTML renderer consumes, no parallel
    // serializer to drift out of sync. Issue #636.
    const accept = request.headers.get("accept");
    const formatParam = new URL(request.url).searchParams.get("format");
    const fmt = pickResponseFormat({ accept, formatParam });

    if (fmt === "json") {
      const body = {
        dataset_id: datasetId,
        version: resolved.version,
        path: result.path,
        kind: "directory" as const,
        children: result.children,
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
          Vary: "Accept",
        },
      });
    }

    // Compare this directory's listing against the immediately-prior
    // version. The prior version is the next row in versionTags after
    // the current one (rows are sorted newest-first). Skip the diff
    // when there is no older version, or when the prior manifest
    // isn't available -- the absence of a footer is harmless.
    const currentIdx = versionTags.indexOf(resolved.version);
    let removedSinceNote: { lastSeenVersion: string; names: string[] } | null = null;
    if (currentIdx >= 0 && currentIdx < versionTags.length - 1) {
      const priorVersion = versionTags[currentIdx + 1];
      const priorManifest = await loadManifest(env, datasetId, priorVersion);
      if (priorManifest) {
        const removed = diffRemovedSince(result.children, priorManifest, result.path);
        if (removed.length > 0) {
          removedSinceNote = { lastSeenVersion: priorVersion, names: removed };
        }
      }
    }

    const html = renderIndexHtml({
      datasetId,
      version: resolved.version,
      path: result.path,
      entries: result.children,
      availableVersions,
      removedSinceNote,
    });
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        Vary: "Accept",
      },
    });
  }

  // Exhaustive guard: if a future ResolvedFile arm is added without
  // updating this handler, TypeScript fails the build right here.
  const _exhaustive: never = result;
  throw new Error(`unhandled ResolvedFile kind: ${JSON.stringify(_exhaustive)}`);
}

dataRoutes.get("/:datasetId/:version/manifest.json", (c) => {
  const { datasetId, version } = c.req.param();
  return manifestJsonHandler(c.env, datasetId, version);
});

/**
 * GET /<id>/<version>/summary.json -> static-passthrough summary artifact
 * (epic #559, PR-1, issue #558).
 *
 * Sibling to manifest.json. Emitted by the central manifest-generation
 * workflow on `nemarDatasets/.github` (Stream A; relocated #564) at S3 key
 * `<id>/version/v<X.Y.Z>-summary.json`. Stream A's writer owns the shape
 * contract; this handler serves the bytes verbatim with no per-request
 * mutation (no presigned URLs, no field rewriting). That's why it gets a
 * long s-maxage: every byte is deterministic from the published version.
 *
 * Cache policy diverges intentionally from manifest.json:
 *  - manifest.json embeds per-request presigned URLs (1h S3 expiry) so it
 *    must stay short-lived (max-age=60).
 *  - summary.json is path-only and immutable for the (datasetId, version)
 *    pair, so it gets s-maxage=86400 with stale-while-revalidate.
 */
async function summaryJsonHandler(
  env: Bindings,
  datasetId: string,
  versionParam: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found", undefined, true);

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  if (!resolved.ok) return notFound("Version not found", undefined, true);

  let raw: string | null;
  try {
    raw = await loadSummary(s3OptionsFromEnv(env), datasetId, resolved.version);
  } catch (err) {
    console.error(
      `[data] summary fetch failed dataset=${datasetId} version=${resolved.version}:`,
      err instanceof Error ? err.message : String(err),
    );
    // 5xx S3 outages, SigV4 failures, IAM drift (403 from loadSummary)
    // must NOT collapse into a cacheable 404. Return an uncached 500 so
    // an operator-side alert fires and the CDN doesn't pin the failure.
    return new Response(JSON.stringify({ error: "Failed to retrieve summary" }), {
      status: 500,
      // Uncached: a transient S3/SigV4/IAM failure must not be CDN-pinned.
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (raw === null) {
    // No negative caching: the primary consumer is the post-publish
    // refresh, where a CDN-cached 404 from before Stream A's workflow
    // wrote the summary would confuse publishers. `no-store` ensures a
    // freshly-published summary becomes visible on the next request.
    return new Response(JSON.stringify({ error: "Summary not found for this version" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(raw, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300, s-maxage=86400, stale-while-revalidate=86400",
    },
  });
}

dataRoutes.get("/:datasetId/:version/summary.json", (c) => {
  const { datasetId, version } = c.req.param();
  return summaryJsonHandler(c.env, datasetId, version);
});

/**
 * GET /<id>/<version>/records.json -> static-passthrough records artifact (#615).
 *
 * Sibling to summary.json. Emitted by the central generate-records workflow
 * on `nemarDatasets/.github` at S3 key `<id>/version/v<X.Y.Z>-records.json`
 * (an array of neuroschema v0.4.0 `record` docs, one per primary signal
 * file). The emitter owns the shape contract; this handler serves the bytes
 * verbatim. Same cache policy as summary.json: immutable per (id, version),
 * so a long s-maxage; a missing artifact is `no-store` 404 (no negative
 * caching) so a freshly-published records.json appears on the next request.
 */
async function recordsJsonHandler(
  env: Bindings,
  datasetId: string,
  versionParam: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found", undefined, true);

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  if (!resolved.ok) return notFound("Version not found", undefined, true);

  let raw: string | null;
  try {
    raw = await loadRecords(s3OptionsFromEnv(env), datasetId, resolved.version);
  } catch (err) {
    console.error(
      `[data] records fetch failed dataset=${datasetId} version=${resolved.version}:`,
      err instanceof Error ? err.message : String(err),
    );
    // 5xx S3 outages, SigV4 failures, IAM drift (403 from loadRecords) must
    // NOT collapse into a cacheable 404. Return an uncached 500 so an
    // operator-side alert fires and the CDN doesn't pin the failure.
    return new Response(JSON.stringify({ error: "Failed to retrieve records" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (raw === null) {
    // No negative caching: records.json is generated asynchronously after
    // the version tag (it can lag the publish, esp. before the records
    // workflow runs). `no-store` ensures a freshly-published records.json
    // becomes visible on the next request rather than serving a pinned 404.
    return new Response(JSON.stringify({ error: "Records not found for this version" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(raw, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300, s-maxage=86400, stale-while-revalidate=86400",
    },
  });
}

dataRoutes.get("/:datasetId/:version/records.json", (c) => {
  const { datasetId, version } = c.req.param();
  return recordsJsonHandler(c.env, datasetId, version);
});

/**
 * GET /<id>/metadata.json -> dataset-level neuroschema v0.4.0 document.
 *
 * Combines the D1 catalog row, the parsed nemar_metadata.json enrichment
 * payload, and (when at least one version exists) a derived BIDS index from
 * the latest version's S3 manifest. Public datasets only; private/unknown
 * collapse to 404 with no existence leak. Partial-enrichment cases never
 * 500: missing inputs degrade to null fields in the response.
 *
 * MUST be registered before `/:datasetId/:version` -- otherwise Hono's
 * param-matching captures `metadata.json` as a version string.
 */
async function metadataJsonHandler(env: Bindings, datasetId: string): Promise<Response> {
  const gate = await loadPublishedDataset(env, datasetId);
  if (!gate) return notFound("Dataset not found");

  const row = await env.DB.prepare(
    `SELECT dataset_id, name, description, github_repo, concept_doi, anonymous,
            modalities, subject_count, age_min, age_max,
            file_size, total_files, tasks, enrichment_json,
            data_complete, bytes_present,
            total_recording_duration, recording_duration_min, recording_duration_max,
            recording_count, recordings_unavailable, recordings_measured,
            channel_count_min, channel_count_max,
            sampling_frequency, power_line_frequency, eeg_reference,
            placement_scheme, electrode_system
     FROM datasets
     WHERE dataset_id = ?`,
  )
    .bind(datasetId)
    .first<DatasetRowForMetadata & { enrichment_json: string | null }>();
  if (!row) {
    // The visibility gate just succeeded, so a null here means the row was
    // deleted (or replaced) between the two reads -- an infra anomaly worth
    // surfacing so it can be correlated with deletion events / D1 replica
    // lag, not a normal traffic pattern.
    console.warn(
      `[data] metadata.json: row disappeared after visibility gate dataset=${datasetId}`,
    );
    return notFound("Dataset not found");
  }

  const versionsResult = await env.DB.prepare(
    "SELECT version, doi, created_at FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
  )
    .bind(datasetId)
    .all<DatasetVersionRow>();
  const versions = versionsResult.results ?? [];

  let parsedEnrichment = null;
  if (row.enrichment_json) {
    try {
      parsedEnrichment = parseNemarMetadata(JSON.parse(row.enrichment_json));
    } catch (err) {
      // Persistent data corruption (pipeline wrote invalid JSON), not a
      // transient issue. Surface at error level so it shows up in any future
      // exception-aggregation pipeline.
      console.error(
        `[data] metadata.json: corrupt enrichment_json dataset=${datasetId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let latestManifest: VersionManifest | null = null;
  if (versions.length > 0) {
    const latest = versions[0];
    const versionTag = toVersionTag(latest.version);
    latestManifest = await loadManifest(env, datasetId, versionTag);
    if (!latestManifest) {
      console.warn(
        `[data] metadata.json: latest manifest unavailable dataset=${datasetId} version=${versionTag}; bids_index will be null`,
      );
    }
  }

  const payload = buildDatasetMetadata({
    row: {
      dataset_id: row.dataset_id,
      name: row.name,
      description: row.description,
      github_repo: row.github_repo,
      anonymous: row.anonymous,
      concept_doi: row.concept_doi,
      modalities: row.modalities,
      subject_count: row.subject_count,
      age_min: row.age_min,
      age_max: row.age_max,
      file_size: row.file_size,
      total_files: row.total_files,
      tasks: row.tasks,
      data_complete: row.data_complete,
      bytes_present: row.bytes_present,
      total_recording_duration: row.total_recording_duration,
      recording_duration_min: row.recording_duration_min,
      recording_duration_max: row.recording_duration_max,
      recording_count: row.recording_count,
      recordings_unavailable: row.recordings_unavailable,
      recordings_measured: row.recordings_measured,
      channel_count_min: row.channel_count_min,
      channel_count_max: row.channel_count_max,
      sampling_frequency: row.sampling_frequency,
      power_line_frequency: row.power_line_frequency,
      eeg_reference: row.eeg_reference,
      placement_scheme: row.placement_scheme,
      electrode_system: row.electrode_system,
    },
    parsedEnrichment,
    versions,
    latestManifest,
    githubOrg: ORG_NAME,
  });

  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
}

dataRoutes.get("/:datasetId/metadata.json", (c) => {
  const { datasetId } = c.req.param();
  return metadataJsonHandler(c.env, datasetId);
});

/**
 * GET /<id>/page-bundle.json?v=<version>
 *
 * One-RTT bundle of everything the dataset detail page needs at SSR time:
 * landing (versions, latest), enriched metadata (neuroschema), summary
 * (path-only, with embedded README at schema 1.1), and the catalog row.
 *
 * Designed for `ww2.nemar.org` to collapse its current 4-parallel SSR +
 * 2-deferred-client fetch waterfall to one. The website still renders the
 * BIDS tree progressively from `summary.paths` (nemarOrg/website#64).
 *
 * Cache policy:
 * - `complete=true` -> long s-maxage (the same dataset+version returns the
 *   same payload until a new publish updates either metadata or summary).
 * - `complete=false` (any upstream failed) -> `no-store` so a transient
 *   blip isn't pinned at the edge with stale-while-revalidate.
 *
 * MUST be registered before any `/:datasetId/:version/*` route (and before
 * the bare `/:datasetId/:version/*` catch-all near the bottom of this file)
 * so Hono doesn't treat `page-bundle.json` as a `:version` param. Same
 * registration-order rule that `metadata.json` and `qa` follow above.
 *
 * Epic #618 / phase 3 (#621).
 */
async function pageBundleHandler(
  env: Bindings,
  datasetId: string,
  versionParam: string | null,
): Promise<Response> {
  const gate = await loadPublishedDataset(env, datasetId);
  if (!gate) return notFound("Dataset not found");

  let bundle: Awaited<ReturnType<typeof buildPageBundle>>;
  try {
    bundle = await buildPageBundle(env, datasetId, versionParam);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[data] page-bundle assembly crashed dataset=${datasetId}:`, msg);
    return new Response(JSON.stringify({ error: "Failed to build page bundle" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  return new Response(JSON.stringify(bundle), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": bundle.complete
        ? "public, max-age=60, s-maxage=300, stale-while-revalidate=86400"
        : "no-store",
    },
  });
}

dataRoutes.get("/:datasetId/page-bundle.json", (c) => {
  const { datasetId } = c.req.param();
  const version = new URL(c.req.url).searchParams.get("v");
  return pageBundleHandler(c.env, datasetId, version);
});

// ===========================================================================
// QA artifact route: /<id>/qa/*  (see #511)
//
// Mirrors `/data/qumulo/openneuro/processed/<id>/` from SDSC Hallu into
// `s3://nemar/<id>/qa/` via `scripts/hallu-qa-sync.sh` (hourly cron). This
// route exposes that tree at `data.nemar.org/<id>/qa/...`:
//
//   GET /<id>/qa/                                 -> directory listing (root)
//   GET /<id>/qa/dataqual.json                    -> 302 to presigned S3 GET
//   GET /<id>/qa/sub-001/                         -> directory listing
//   GET /<id>/qa/sub-001/eeg/foo_icaact.svg       -> 302 to presigned S3 GET
//
// Registered BEFORE `/:datasetId/:version/*` so the Hono router does not
// interpret `qa` as a version param. The QA tree is NOT version-locked --
// it reflects whichever pipeline run last published; the website expects
// `/<id>/qa/...` not `/<id>/<v>/qa/...`. Phase 3 punts per-version QA.
//
// Visibility: same gate as the rest of this sub-app — public datasets
// only. Private/unknown datasets 404 with no existence leak.
//
// Cache-Control: 300s — QA artifacts are stable per pipeline run; 5 min is
// a reasonable client-side cache while leaving the website responsive to
// post-sync refreshes.
// ===========================================================================
async function qaHandler(
  env: Bindings,
  request: Request,
  datasetId: string,
  rawPath: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  const s3 = s3OptionsFromEnv(env);
  let resolved: Awaited<ReturnType<typeof resolveQaPath>>;
  try {
    resolved = await resolveQaPath({ s3Options: s3, datasetId, rawPath });
  } catch (err) {
    console.error(
      `[data] QA resolve crashed dataset=${datasetId} path=${rawPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return notFound("QA path not found");
  }

  if (resolved.kind === "not_found") {
    return notFound("QA path not found");
  }

  const isHead = request.method === "HEAD";

  if (resolved.kind === "file") {
    if (isHead) {
      // Mirror the version-route HEAD semantics: 200 with metadata headers,
      // no presign round-trip required so rclone can size+mtime cheaply.
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Length": String(resolved.size),
          "Last-Modified": toHttpDate(resolved.lastModified),
          ETag: `"${resolved.size}-${resolved.lastModified}"`,
          "Cache-Control": "public, max-age=300",
        },
      });
    }
    // QA files in S3 already have BIDS-shaped keys (the sync mirrors paths
    // directly under `<id>/qa/<bids-path>`), so the presigned URL basename
    // is already the BIDS name. No Content-Disposition override needed
    // here — that fix in #513 only applies to annex-keyed dataset files
    // where the S3 key is content-addressed (`SHA256E-...`).
    const url = await generatePresignedGetUrl(s3, resolved.key, 3600);
    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "public, max-age=300",
        "Last-Modified": toHttpDate(resolved.lastModified),
        ETag: `"${resolved.size}-${resolved.lastModified}"`,
      },
    });
  }

  // Directory listing.
  const accept = request.headers.get("accept");
  const formatParam = new URL(request.url).searchParams.get("format");
  const fmt = pickResponseFormat({ accept, formatParam });

  if (fmt === "json" || isHead) {
    const body = {
      dataset_id: datasetId,
      path: resolved.path,
      kind: "directory" as const,
      children: resolved.children,
      truncated: resolved.truncated,
    };
    return new Response(isHead ? null : JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        Vary: "Accept",
      },
    });
  }

  const html = renderIndexHtml({
    datasetId,
    // The QA tree is not version-locked. Reuse the existing index renderer
    // by passing a synthetic "qa" version label so the breadcrumb reads
    // sensibly to humans. There is no version-picker UI to surface here.
    version: "qa",
    path: resolved.path,
    entries: resolved.children,
    availableVersions: [],
    removedSinceNote: null,
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      Vary: "Accept",
    },
  });
}

dataRoutes.get("/:datasetId/qa", async (c) => {
  // Redirect /<id>/qa -> /<id>/qa/ for trailing-slash consistency with the
  // version route. Pre-check visibility so we don't echo a 308 Location for
  // a private or nonexistent dataset (information disclosure parity with the
  // version-route 308 handler).
  const { datasetId } = c.req.param();
  const dataset = await loadPublishedDataset(c.env, datasetId);
  if (!dataset) return notFound("Dataset not found");
  const url = new URL(c.req.url);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return new Response(null, {
    status: 308,
    headers: { Location: url.toString(), "Cache-Control": "public, max-age=300" },
  });
});

dataRoutes.get("/:datasetId/qa/", (c) => {
  return qaHandler(c.env, c.req.raw, c.req.param("datasetId"), "");
});

dataRoutes.get("/:datasetId/qa/*", (c) => {
  const datasetId = c.req.param("datasetId");
  const prefix = `/${datasetId}/qa/`;
  const idx = c.req.path.indexOf(prefix);
  const rawPath = idx === -1 ? "" : c.req.path.slice(idx + prefix.length);
  return qaHandler(c.env, c.req.raw, datasetId, rawPath);
});

// Redirect /<id>/<version> -> /<id>/<version>/ so the relative `../` link in
// the rendered index resolves correctly. Only redirect when the dataset is
// actually public so we don't echo private/nonexistent ids back in a 308
// Location header.
dataRoutes.get("/:datasetId/:version", async (c) => {
  const { datasetId, version } = c.req.param();
  const dataset = await loadPublishedDataset(c.env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  // Archive zip download: /<id>/<version>.zip -> 302 to the presigned S3
  // archive (stored at <id>/archives/v<version>.zip). The website's
  // archiveZipUrl() links here (nemarOrg/website src/lib/data-api.ts) and
  // expects the Worker to resolve+presign. Without this branch the request
  // falls through to the 308 below, then resolveVersion("v1.0.0.zip") fails
  // the version regex and 404s even though the archive exists. (#670)
  if (version.endsWith(".zip")) {
    const resolved = await resolveVersion(c.env.DB, datasetId, version.slice(0, -4));
    if (!resolved.ok) return notFound("Version not found");
    const s3 = s3OptionsFromEnv(c.env);
    // HEAD first: the archive is generated asynchronously after publish, so a
    // download click in that window would otherwise 302 to a presigned URL
    // that dumps an S3 NoSuchKey XML error. Return a clean 404 instead. A
    // credentials/5xx error throws -> 503. (#670, review)
    let present: boolean;
    try {
      present = await headArchive(s3, datasetId, resolved.version);
    } catch (err) {
      console.error(`[data] archive HEAD failed for ${datasetId} ${resolved.version}:`, err);
      return c.json({ error: "Unable to check archive availability" }, 503);
    }
    if (!present) {
      return notFound(
        "Archive not yet available for this version (generation may still be in progress)",
      );
    }
    const archiveUrl = await getArchiveUrl(s3, datasetId, resolved.version);
    // Count the download (not HEAD probes). bytes=0: the Worker 302s to S3 and
    // never streams the archive, so it can't measure transferred bytes.
    if (c.req.method === "GET") {
      recordAccess(c.env, { datasetId, source: "archive", detail: resolved.version });
    }
    // no-store: the Location carries a presigned, time-limited S3 URL; don't
    // let a CDN serve one shared signed URL to many clients.
    return new Response(null, {
      status: 302,
      headers: { Location: archiveUrl, "Cache-Control": "no-store" },
    });
  }

  const url = new URL(c.req.url);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  // Response.redirect emits no Cache-Control. Without one, downstream
  // caches apply heuristic TTLs (often very long for 308) and a
  // client following the redirect repeatedly would still hit the
  // Worker each time only because the URL changes. Pin to 300s for
  // consistency with the rest of the route's caching matrix.
  return new Response(null, {
    status: 308,
    headers: {
      Location: url.toString(),
      "Cache-Control": "public, max-age=300",
    },
  });
});

// Hono v4 auto-derives HEAD from the registered GET handler -- it
// re-dispatches the original Request (method still "HEAD") through
// this handler and strips the body. The `isHead` branch inside
// `fileOrIndexHandler` reads `request.method` and short-circuits to
// a 200 + metadata headers for files (or 200 + text/html for
// directories) without doing the buildRedirectUrl S3 presign or the
// tombstone walk. So `rclone sync :http:...` can size+mtime+ETag
// every file in one cheap round-trip per file. No explicit HEAD
// route registration is needed.
dataRoutes.get("/:datasetId/:version/*", (c) => {
  const { datasetId, version } = c.req.param();
  // Trailing-slash archive form (/<id>/<version>.zip/) -> redirect to the
  // canonical no-slash URL, which the /:datasetId/:version handler presigns.
  // (#670 -- otherwise resolveVersion("v1.0.0.zip") 404s here.)
  if (version.endsWith(".zip")) {
    return new Response(null, {
      status: 308,
      headers: { Location: `/${datasetId}/${version}`, "Cache-Control": "public, max-age=300" },
    });
  }
  const prefix = `/${datasetId}/${version}/`;
  const idx = c.req.path.indexOf(prefix);
  const rawPath = idx === -1 ? "" : c.req.path.slice(idx + prefix.length);
  return fileOrIndexHandler(c.env, c.req.raw, datasetId, version, rawPath);
});

/**
 * GET /<id> and /<id>/ -> sitemap-style landing page listing every
 * published version of the dataset.
 *
 * Content negotiation: HTML for browsers (Accept: text/html), JSON
 * for everything else. The JSON shape is `LandingPayload` and is the
 * machine entry point for "what versions does this dataset have?".
 *
 * Unknown / private datasets 404 with no existence leak (the same
 * pattern loadPublishedDataset enforces everywhere else). A dataset
 * that exists but has no published versions returns the landing page
 * with an empty version list and an "unpublished" notice (status 200) --
 * the row is real, just not ready to serve files yet.
 */
async function datasetRootResponse(
  env: Bindings,
  request: Request,
  datasetId: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  const versionRows = await loadVersionRows(env, datasetId);
  const payload = buildLandingPayload({
    datasetId,
    versionRows,
    archive: {
      status: dataset.archive_status,
      size: dataset.archive_size,
      skip_reason: dataset.archive_skip_reason,
    },
  });

  const accept = request.headers.get("accept");
  const formatParam = new URL(request.url).searchParams.get("format");
  const fmt = pickResponseFormat({ accept, formatParam });

  // Vary: Accept tells shared caches that the response body depends on
  // the Accept header, so a browser request (HTML) and a machine request
  // (JSON) don't poison each other's cached copy at the same URL.
  if (fmt === "json") {
    return new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        Vary: "Accept",
      },
    });
  }

  const html = renderDatasetLandingHtml(payload);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      Vary: "Accept",
    },
  });
}

dataRoutes.get("/:datasetId", (c) =>
  datasetRootResponse(c.env, c.req.raw, c.req.param("datasetId")),
);
dataRoutes.get("/:datasetId/", (c) =>
  datasetRootResponse(c.env, c.req.raw, c.req.param("datasetId")),
);

/**
 * GET / -> catalog index of every publicly-hosted dataset.
 *
 * SQL filter (`visibility='public' AND dataset_id NOT LIKE 'xx%' AND
 * dataset_id <> 'nm099999'`) mirrors the predicate `loadPublishedDataset`
 * enforces on every per-id route, with `xx*` and the E2E-test id stripped.
 * `buildCatalogIndexPayload` re-asserts the id filter (including a strict
 * `isValidDatasetId` shape check) in pure TS as defense in depth, so a
 * malformed id can never reach the renderer or an `href=` attribute.
 *
 * D1 failure path returns 503 with `Retry-After`, not a 200 with an empty
 * list. The whole response *is* the D1 result here, so silently degrading
 * to "no datasets hosted" would misrepresent system state to humans and
 * starve monitoring of the 5xx signal. The response is not cached, so the
 * next request retries naturally once D1 recovers.
 */
export async function catalogIndexResponse(env: Bindings, request: Request): Promise<Response> {
  const cfRay = request.headers.get("cf-ray") ?? "unknown";
  const accept = request.headers.get("accept");
  const formatParam = new URL(request.url).searchParams.get("format");
  const fmt = pickResponseFormat({ accept, formatParam });

  let rows: CatalogIndexRow[] | null = null;
  try {
    const result = await env.DB.prepare(
      `SELECT
         d.dataset_id,
         d.name,
         d.concept_doi,
         d.is_exemplar,
         (SELECT version FROM dataset_versions dv
            WHERE dv.dataset_id = d.dataset_id
            ORDER BY dv.created_at DESC LIMIT 1) AS latest_version,
         (SELECT created_at FROM dataset_versions dv
            WHERE dv.dataset_id = d.dataset_id
            ORDER BY dv.created_at DESC LIMIT 1) AS latest_published_at
       FROM datasets d
       WHERE d.visibility = 'public'
         AND (d.dataset_id NOT LIKE 'xx%' OR d.is_exemplar = 1)
         AND d.dataset_id <> 'nm099999'
       ORDER BY d.dataset_id`,
    ).all<CatalogIndexRow>();
    rows = result.results ?? [];
  } catch (err) {
    console.error(
      `[data] catalog index D1 query failed cf-ray=${cfRay}:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  }

  if (rows === null) {
    return catalogUnavailableResponse(fmt);
  }

  const built: CatalogIndexBuildResult = buildCatalogIndexPayload({ rows });
  if (built.droppedIds.length > 0) {
    // SQL and TS filters disagree -> schema drift, not a routine case.
    console.warn(
      `[data] catalog index dropped ${built.droppedIds.length} ids that SQL accepted: ${built.droppedIds.join(",")}`,
    );
  }

  if (fmt === "json") {
    return new Response(JSON.stringify(built.payload), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        Vary: "Accept",
      },
    });
  }

  return new Response(renderCatalogIndexHtml(built.payload), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      Vary: "Accept",
    },
  });
}

function catalogUnavailableResponse(fmt: "html" | "json"): Response {
  const baseHeaders = {
    "Retry-After": "30",
    Vary: "Accept",
  };
  if (fmt === "json") {
    return new Response(JSON.stringify({ error: "catalog_unavailable" }), {
      status: 503,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
    });
  }
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>data.nemar.org</title>
<style>body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:1.5em;max-width:60em}h1{font-size:1.1em}.foot{color:#888;font-size:.9em;margin-top:2em}</style>
</head><body>
<h1>Catalog temporarily unavailable</h1>
<p>The dataset catalog could not be loaded right now. Please try again in a few seconds.</p>
<div class="foot">data.nemar.org</div>
</body></html>
`;
  return new Response(html, {
    status: 503,
    headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

dataRoutes.get("/", (c) => catalogIndexResponse(c.env, c.req.raw));
