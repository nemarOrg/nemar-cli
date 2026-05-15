/**
 * data.nemar.org route (epic #449, phase 1).
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
  buildDatasetMetadata,
  buildRedirectUrl,
  escapeHtml,
  renderIndexHtml,
  resolveFile,
  resolveVersion,
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
  const raw = await getManifest(s3OptionsFromEnv(env), datasetId, version);
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

function notFound(message = "Not found") {
  return new Response(JSON.stringify({ error: message }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
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
 * GET /<id>/<version>/<path> -> 302 to file bytes, or HTML directory listing.
 */
async function fileOrIndexHandler(
  env: Bindings,
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

  const result = resolveFile(manifest, rawPath);
  if (result.kind === "not_found") return notFound("File not found");

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
    const html = renderIndexHtml({
      datasetId,
      version: resolved.version,
      path: result.path,
      entries: result.children,
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
    // Race between the visibility check and the second SELECT (deletion mid-request).
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
      console.warn(
        `[data] metadata.json: corrupt enrichment_json dataset=${datasetId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let latestManifest: VersionManifest | null = null;
  if (versions.length > 0) {
    const latest = versions[0];
    const versionTag = latest.version.startsWith("v") ? latest.version : `v${latest.version}`;
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
  return fileOrIndexHandler(c.env, datasetId, version, rawPath);
});

// Phase 3 will replace these with a versions listing page. For now, gate
// on dataset visibility and HTML-escape the interpolated id so we don't
// reflect arbitrary user input into a `nemar.org`-subdomain HTML response.
async function datasetRootResponse(env: Bindings, datasetId: string): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");
  const safe = escapeHtml(datasetId);
  const href = encodeURIComponent(datasetId);
  const html = `<!doctype html><meta charset="utf-8"><title>${safe}</title>
<body style="font-family:ui-monospace,Menlo,monospace;margin:1.5em;max-width:60em">
<h1 style="font-size:1.05em">${safe}</h1>
<p>Append a version to browse files. Examples:</p>
<ul>
  <li><a href="${href}/latest/">${safe}/latest/</a></li>
  <li><a href="${href}/latest/manifest.json">${safe}/latest/manifest.json</a></li>
</ul>
</body>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

dataRoutes.get("/:datasetId", (c) => datasetRootResponse(c.env, c.req.param("datasetId")));
dataRoutes.get("/:datasetId/", (c) => datasetRootResponse(c.env, c.req.param("datasetId")));
