/**
 * The public quality view route (ADR 0137 decisions 6 and 7, epic #2324 phase B2): a recording's quality
 * views and the files they declare, from a recipe's CURRENT PUBLIC derivative only. Paths, words and bounds
 * are `shared/contract/quality-route.ts`'s; the route is mounted on the data plane (`routes/data.ts`, before
 * the version routes, so `quality` is never read as a version).
 *
 * THE ORDER IS THE GUARD (this is a disclosure surface). On every request:
 *  1. The path: the dataset id, the recipe (a registry name), the derivative key and digest (64 hexadecimal
 *     digits) and the recording (a neuroschema `relativeLocation` that names a recording), each checked
 *     before anything is read. Nothing here depends on a dataset, so a refusal reveals none.
 *  2. ONE D1 statement: the dataset row and the derivative together. The dataset must be active, public,
 *     not concealed (`anonymous = 0`, ADR 0065: the standing anonymous deposit is never served), first
 *     published, not withdrawn and not tombstoned (`QUALITY_DATASET_GATE_SQL`). The derivative is bound to
 *     that dataset BY THE ROW (`d.dataset_id = ds.dataset_id`), never by the URL or the record, and must be
 *     the recipe's current public derivative (`CURRENT_PUBLIC_DERIVATIVE_SQL`, B1's rule: stored, `catalog`
 *     or `published`, a superseded `catalog` row and an expired row never, the newest by `stored_at`, the
 *     larger key on a tie). A refused dataset answers exactly as a dataset with no quality does. A file
 *     request naming a public derivative that has since expired answers `views_expired`.
 *  3. The edge cache, under a key that carries the dataset's epoch (`dataset_quality_epochs`, which every
 *     change to a gate column advances) and the derivative key, so an entry is never read before the gate
 *     and never outlives a change of the dataset or of its current derivative.
 *  4. The recording's record (at most 512 KiB), projected and checked whole (`recordingViews`): the
 *     record's integers, its identity (the derivative row's dataset and the recording asked for), every
 *     plugin view's plugin against the `quality` plugins the derivative row recorded for its recipe version
 *     when it was made (`compute_derivatives.quality_plugins`; a row without them serves nothing), the
 *     vendored schema, recording scope and `nemar.record-checks.v1`.
 *  5. For a file: the digest must be one a validated view declares; the object (at most 4 MiB) must be its
 *     declared size and is hashed again before a byte is served.
 * Steps 4 and 5 are `serveRecordingViews` (`services/quality-serve.ts`), which the admin mount
 * (`routes/admin/quality-views.ts`) calls too; only this route caches.
 *
 * Public answers carry `Cache-Control: public, max-age=300`, `Cache-Tag: nemar-dq-<id>` and a strong `ETag`
 * (the SHA-256 of the body's bytes). Every refusal is `no-store` and is never put in the cache. A log line
 * carries the dataset id, the first twelve digits of a key and a fixed word, never a path.
 *
 * WHAT AN UNPUBLISH REACHES, AND WHAT IT DOES NOT. The gate and the epoch take effect at this Worker's next
 * request, and an unpublish, a withdrawal or a concealment also purges the tag `nemar-dq-<id>` from
 * Cloudflare's cache (`purgeQualityCache`, best effort, after the D1 write). A copy already in a browser,
 * or in a shared cache outside Cloudflare, is beyond any of them: it may be served for up to
 * `QUALITY_PUBLIC_MAX_AGE` (300 seconds) after the change. That residual is accepted (ADR 0137 decision 7
 * allows a browser 300 seconds); the bytes it covers were public when they were served.
 */

import { matchRecording } from "../../../shared/compute-naming.js";
import { findRecipe } from "../../../shared/compute-recipes.js";
import {
  QUALITY_FILE_SEGMENT,
  QUALITY_PUBLIC_MAX_AGE,
  QUALITY_RECORDING_PATH_MAX,
  QUALITY_RECORD_SEGMENT,
  QUALITY_ROUTE_VERSION,
  QUALITY_ROUTE_WORDS,
  type QualityRouteWord,
  qualityCacheTag,
} from "../../../shared/contract/quality-route.js";
import { derivativesBound } from "../services/compute-derivatives.js";
import { isValidDatasetId } from "../services/datasetId.js";
import type { ManifestCache } from "../services/manifest-source.js";
import {
  CURRENT_PUBLIC_DERIVATIVE_SQL,
  QUALITY_DATASET_GATE_SQL,
  QUALITY_PATTERNS,
} from "../services/quality-documents.js";
import { type ServedDerivative, serveRecordingViews } from "../services/quality-serve.js";
import type { Bindings } from "../types/bindings.js";

const DERIVATIVE_FIELDS = `cd.key, cd.dataset_id, cd.recipe, cd.version, cd.recipe_version, cd.input, cd.retention, cd.stored_at,
       cd.quality_plugins, COALESCE(e.epoch, 0) AS epoch`;

const GATED_FROM = `FROM datasets d
  JOIN compute_derivatives cd ON cd.dataset_id = d.dataset_id AND cd.recipe = ?2
  LEFT JOIN dataset_quality_epochs e ON e.dataset_id = d.dataset_id
 WHERE d.dataset_id = ?1 AND ${QUALITY_DATASET_GATE_SQL}`;

/** The recipe's current public derivative of a dataset that passes the gate: `?1` dataset, `?2` recipe. */
export const QUALITY_CURRENT_SQL = `SELECT ${DERIVATIVE_FIELDS}
  ${GATED_FROM}
   AND ${CURRENT_PUBLIC_DERIVATIVE_SQL("cd")}`;

/**
 * A named derivative of a dataset that passes the gate (`?1` dataset, `?2` recipe, `?3` key), whether it is
 * the current public one, and whether it is a public one that has expired.
 */
export const QUALITY_NAMED_SQL = `SELECT ${DERIVATIVE_FIELDS},
       CASE WHEN ${CURRENT_PUBLIC_DERIVATIVE_SQL("cd")} THEN 1 ELSE 0 END AS current,
       CASE WHEN cd.retention IN ('catalog', 'published')
             AND (cd.state = 'expired' OR (cd.expires_at IS NOT NULL AND cd.expires_at <= datetime('now')))
            THEN 1 ELSE 0 END AS expired
  ${GATED_FROM}
   AND cd.key = ?3`;

interface DerivativeRead extends ServedDerivative {
  epoch: number;
  current?: number;
  expired?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function refuse(word: QualityRouteWord): Response {
  return new Response(JSON.stringify({ error: word }), {
    status: QUALITY_ROUTE_WORDS[word],
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * The public headers of an answer: browser cache, the dataset's tag and a strong `ETag`, the SHA-256 of the
 * exact bytes of the body.
 */
function publicHeaders(datasetId: string, sha256: string): Record<string, string> {
  return {
    "Cache-Control": `public, max-age=${QUALITY_PUBLIC_MAX_AGE}`,
    "Cache-Tag": qualityCacheTag(datasetId),
    ETag: `"${sha256}"`,
  };
}

/** The Workers Cache API where there is one (`bun test` installs a real in-memory one when a suite needs it). */
function edgeCache(): ManifestCache | null {
  const storage = (globalThis as { caches?: { default?: ManifestCache } }).caches;
  return storage?.default ?? null;
}

/** The recording a path names, decoded segment by segment, or null when it is not one this route takes. */
export function recordingOf(segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  let path: string;
  try {
    path = segments.map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return null;
  }
  if (path.length > QUALITY_RECORDING_PATH_MAX) return null;
  if (!QUALITY_PATTERNS.relativeLocation.test(path)) return null;
  if (matchRecording(path.slice(path.lastIndexOf("/") + 1)) === null) return null;
  return path;
}

type QualityRequest =
  | { kind: "record"; recipe: string; recording: string }
  | { kind: "file"; recipe: string; key: string; sha256: string; recording: string };

/** The request a path after `/<id>/quality/` names, or the word it is refused with. */
export function parseQualityPath(segments: readonly string[]): QualityRequest | QualityRouteWord {
  const [version, recipe, kind, ...rest] = segments;
  if (version !== QUALITY_ROUTE_VERSION || recipe === undefined || findRecipe(recipe) === null) {
    return "quality_not_found";
  }
  if (kind === QUALITY_RECORD_SEGMENT) {
    const recording = recordingOf(rest);
    return recording === null ? "recording_path_invalid" : { kind: "record", recipe, recording };
  }
  if (kind === QUALITY_FILE_SEGMENT) {
    const [key, sha256, ...path] = rest;
    const recording = recordingOf(path);
    if (key === undefined || sha256 === undefined || !HEX64.test(key) || !HEX64.test(sha256)) {
      return "recording_path_invalid";
    }
    return recording === null
      ? "recording_path_invalid"
      : { kind: "file", recipe, key, sha256, recording };
  }
  return "quality_not_found";
}

/**
 * Answer one quality request. `datasetId` is the URL's; `segments` the raw path segments after
 * `/<id>/quality/`. `defer` hands the cache write to `waitUntil` where there is an execution context.
 */
export async function qualityHandler(
  env: Bindings,
  request: Request,
  datasetId: string,
  segments: readonly string[],
  defer?: (work: Promise<unknown>) => void,
): Promise<Response> {
  // 1. The path, before anything is read.
  if (!isValidDatasetId(datasetId)) return refuse("quality_not_found");
  const asked = parseQualityPath(segments);
  if (typeof asked === "string") return refuse(asked);
  const bucket = env.COMPUTE_DERIVATIVES;
  if (!derivativesBound(env) || bucket === undefined) return refuse("quality_not_found");

  // 2. The dataset and the derivative, in one statement.
  let row: DerivativeRead | null;
  if (asked.kind === "record") {
    row = await env.DB.prepare(QUALITY_CURRENT_SQL)
      .bind(datasetId, asked.recipe)
      .first<DerivativeRead>();
  } else {
    row = await env.DB.prepare(QUALITY_NAMED_SQL)
      .bind(datasetId, asked.recipe, asked.key)
      .first<DerivativeRead>();
    if (row !== null && row.current !== 1) {
      return refuse(row.expired === 1 ? "views_expired" : "quality_not_found");
    }
  }
  if (row === null) return refuse("quality_not_found");

  // 3. The edge cache, keyed by the dataset's epoch and the derivative.
  const cache = edgeCache();
  const tail =
    asked.kind === "record"
      ? `${QUALITY_RECORD_SEGMENT}/${asked.recording}`
      : `${QUALITY_FILE_SEGMENT}/${asked.sha256}/${asked.recording}`;
  const cacheKey = new Request(
    `${new URL(request.url).origin}/__quality-cache/${QUALITY_ROUTE_VERSION}/${datasetId}/e${row.epoch}/${row.key}/${tail
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  );
  if (cache !== null) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      // The Workers Cache API strips `Cache-Tag` from what it stores, so the tag is set again: a browser or
      // an outer cache keeps the answer under the dataset's tag, which an unpublish purges.
      const answer = new Response(hit.body, hit);
      answer.headers.set("Cache-Tag", qualityCacheTag(datasetId));
      return answer;
    }
  }

  // 4 and 5. The record, checked whole, and a declared file, read again and hashed (`quality-serve.ts`,
  // the steps the admin mount runs too).
  const served = await serveRecordingViews(bucket, row, asked, "quality");
  if (!served.ok) return refuse(served.word);
  const response = new Response(served.bytes, {
    headers: { ...served.headers, ...publicHeaders(datasetId, served.sha256) },
  });

  if (cache !== null) {
    const write = cache.put(cacheKey, response.clone()).catch((err: unknown) => {
      console.warn(
        `[quality] cache_put_failed dataset=${datasetId} error=${err instanceof Error ? err.name : typeof err}`,
      );
    });
    if (defer) defer(write);
    else await write;
  }
  return response;
}
