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
  buildRedirectUrl,
  renderIndexHtml,
  resolveFile,
  resolveVersion,
} from "../services/data-router";
import { isValidDatasetId } from "../services/datasetId";
import { ORG_NAME } from "../services/github";
import type { ManifestFile, VersionManifest } from "../services/manifest";
import { getManifest } from "../services/s3";
import type { Bindings, Variables } from "../types/bindings";

export const dataRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function s3OptionsFromEnv(env: Bindings) {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

async function loadPublishedDataset(env: Bindings, datasetId: string) {
  if (!isValidDatasetId(datasetId)) return null;
  const row = await env.DB.prepare(
    "SELECT dataset_id, visibility FROM datasets WHERE dataset_id = ?",
  )
    .bind(datasetId)
    .first<{ dataset_id: string; visibility: string }>();
  if (!row || row.visibility !== "public") return null;
  return row;
}

async function loadManifest(
  env: Bindings,
  datasetId: string,
  version: string,
): Promise<VersionManifest | null> {
  const raw = await getManifest(s3OptionsFromEnv(env), datasetId, version);
  if (!raw) return null;
  return JSON.parse(raw) as VersionManifest;
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
  const entries = await Promise.all(
    Object.entries(manifest.files).map(async ([path, file]) => {
      const url = await buildRedirectUrl({
        datasetId,
        version: resolved.version,
        bidsPath: path,
        file,
        s3Options,
        githubOrg: ORG_NAME,
      });
      const checksum = parseChecksum(file.checksum);
      return {
        path,
        size: file.size,
        checksum_algorithm: checksum.algorithm,
        checksum: checksum.value,
        url,
      };
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
      file: result.file as ManifestFile,
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

dataRoutes.get("/:datasetId/:version/manifest.json", (c) => {
  const { datasetId, version } = c.req.param();
  return manifestJsonHandler(c.env, datasetId, version);
});

// Redirect /<id>/<version> -> /<id>/<version>/ so the relative `../` link in
// the rendered index resolves correctly.
dataRoutes.get("/:datasetId/:version", (c) => {
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

// Phase 3 will replace these with a versions listing page; for now, just nudge
// clients to specify a version explicitly.
function datasetRootResponse(datasetId: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>${datasetId}</title>
<body style="font-family:ui-monospace,Menlo,monospace;margin:1.5em;max-width:60em">
<h1 style="font-size:1.05em">${datasetId}</h1>
<p>Append a version to browse files. Examples:</p>
<ul>
  <li><a href="${datasetId}/latest/">${datasetId}/latest/</a></li>
  <li><a href="${datasetId}/latest/manifest.json">${datasetId}/latest/manifest.json</a></li>
</ul>
</body>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

dataRoutes.get("/:datasetId", (c) => datasetRootResponse(c.req.param("datasetId")));
dataRoutes.get("/:datasetId/", (c) => datasetRootResponse(c.req.param("datasetId")));
