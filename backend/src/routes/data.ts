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
import {
  type DatasetRowForMetadata,
  type DatasetVersionRow,
  type PublicManifestEntry,
  type VersionPickerEntry,
  buildDatasetMetadata,
  buildLandingPayload,
  buildRedirectUrl,
  diffRemovedSince,
  findLastSeenVersion,
  pickResponseFormat,
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
import { ORG_NAME } from "../services/github";
import type { ManifestFile, VersionManifest } from "../services/manifest";
import {
  type PresignedUrlOptions,
  generatePresignedGetUrl,
  getManifest,
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
    "SELECT dataset_id, visibility FROM datasets WHERE dataset_id = ?",
  )
    .bind(datasetId)
    .first<{ dataset_id: string; visibility: string }>();
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

function notFound(message: string, payload?: FileNotFoundPayload) {
  const body = payload ? { error: message, ...payload } : { error: message };
  return new Response(JSON.stringify(body), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
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
      };
      try {
        const url = await buildRedirectUrl({
          datasetId,
          version: resolved.version,
          bidsPath: path,
          file,
          s3Options,
          githubOrg: ORG_NAME,
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
      return new Response(null, {
        status: 200,
        headers: fileResponseHeaders(result.file, manifest.created, true),
      });
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
    const url = await buildRedirectUrl({
      datasetId,
      version: resolved.version,
      bidsPath: result.path,
      file: result.file,
      s3Options: s3OptionsFromEnv(env),
      githubOrg: ORG_NAME,
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
 * workflow on `nemarOrg/nemar-cli` (Stream A) at S3 key
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
  if (!dataset) return notFound("Dataset not found");

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  if (!resolved.ok) return notFound("Version not found");

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
      headers: { "Content-Type": "application/json" },
    });
  }

  if (raw === null) {
    // Negative-cache 404s briefly so a missing summary (e.g., pre-backfill
    // dataset) doesn't repeatedly thrash S3 from edge caches, but stay
    // short so a freshly-published summary shows up promptly.
    return new Response(JSON.stringify({ error: "Summary not found for this version" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
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
 * GET /<id>/metadata.json -> dataset-level neuroschema v0.3.0 document.
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
    `SELECT dataset_id, name, description, github_repo, concept_doi,
            modalities, subject_count, age_min, age_max,
            file_size, total_files, tasks, enrichment_json
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
      concept_doi: row.concept_doi,
      modalities: row.modalities,
      subject_count: row.subject_count,
      age_min: row.age_min,
      age_max: row.age_max,
      file_size: row.file_size,
      total_files: row.total_files,
      tasks: row.tasks,
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
  const { datasetId } = c.req.param();
  const dataset = await loadPublishedDataset(c.env, datasetId);
  if (!dataset) return notFound("Dataset not found");
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
  const payload = buildLandingPayload({ datasetId, versionRows });

  const accept = request.headers.get("accept");
  const formatParam = new URL(request.url).searchParams.get("format");
  const fmt = pickResponseFormat({ accept, formatParam });

  if (fmt === "json") {
    return new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  const html = renderDatasetLandingHtml(payload);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}

dataRoutes.get("/:datasetId", (c) =>
  datasetRootResponse(c.env, c.req.raw, c.req.param("datasetId")),
);
dataRoutes.get("/:datasetId/", (c) =>
  datasetRootResponse(c.env, c.req.raw, c.req.param("datasetId")),
);
