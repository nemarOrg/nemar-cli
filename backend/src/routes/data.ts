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
  resolveVersion,
  toVersionTag,
} from "../services/data-router";
import { parseNemarMetadata } from "../services/datacite";
import { isValidDatasetId } from "../services/datasetId";
import { ORG_NAME } from "../services/github";
import type { VersionManifest } from "../services/manifest";
import { type PresignedUrlOptions, getManifest } from "../services/s3";
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
 * GET /<id>/<version>/<path> -> 302 to file bytes, or HTML directory listing.
 */
async function fileOrIndexHandler(
  env: Bindings,
  request: Request,
  datasetId: string,
  versionParam: string,
  rawPath: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  if (!resolved.ok) return notFound("Version not found");

  const manifest = await loadManifest(env, datasetId, resolved.version);
  if (!manifest) return notFound("Version not published");

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

  const result = resolveFile(manifest, rawPath);

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
    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "public, max-age=300",
      },
    });
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
  return Response.redirect(url.toString(), 308);
});

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
async function datasetRootResponse(env: Bindings, request: Request, datasetId: string): Promise<Response> {
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

dataRoutes.get("/:datasetId", (c) => datasetRootResponse(c.env, c.req.raw, c.req.param("datasetId")));
dataRoutes.get("/:datasetId/", (c) => datasetRootResponse(c.env, c.req.raw, c.req.param("datasetId")));
