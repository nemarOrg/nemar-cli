/**
 * A run's quality views as an administrator reads them (ADR 0137 decision 7, epic #2324 phase B3b), for the
 * website's drill-down from the pipeline run page:
 *
 *   GET /admin/compute/pipeline/runs/:stamp/quality/record/<recording path>
 *   GET /admin/compute/pipeline/runs/:stamp/quality/file/<sha256>/<recording path>
 *
 * The same record and file the public route answers (`routes/quality.ts`), of the RUN's derivative rather
 * than its recipe's current public one, so a canary is read before it is promoted. Paths and words are
 * `shared/contract/quality-route.ts`'s (`QUALITY_ADMIN_ROUTE_WORDS`).
 *
 * WHO. The router's middleware (`authMiddleware`, `adminMiddleware`, `cookieOriginGuard`) runs before this
 * handler on every request and resolves the caller's OWN credential from D1 each time, with no cache, so a
 * revoked key or a demoted role loses access at its next request.
 *
 * THE ORDER, on every request:
 *  1. The method (GET only; Hono hands a HEAD to a GET route, and it is refused) and the path, before
 *     anything is read: no `?` anywhere in the URL, the stamp an id, and `rest`, raw from the pathname,
 *     inside the grammar (`qualityAdminRest`: `record/<recording>` or `file/<64 hex>/<recording>`, no `.`
 *     or `..` segment, no encoded `/`, `\` or `.`, and the decoded recording one the public route takes,
 *     by the same shared rule, `isQualityRecordingPath`).
 *  2. ONE D1 statement: the stamp and its derivative (bound to the stamp's dataset). Only a row that is
 *     `stored` and whose `expires_at` has not passed is read, of any retention (canary, catalog or
 *     published, superseded included): a copying row's files are partial and an expired row's are deleted
 *     or about to be. Every other case is a fixed word and no store read.
 *  3. The record and file steps the public route runs (`serveRecordingViews`): the record checked whole
 *     against its own dataset and recording and the row's `quality_plugins`, declared files only, one file
 *     per digest, the size bounds and a re-hash before a byte is served, `nosniff`, and an attachment for a
 *     format the registry does not list.
 *
 * NOTHING HERE IS PUBLIC. There is no dataset gate, because an administrator reads private datasets and
 * concealed deposits (ADR 0065) too; so nothing here may reach a public page or cache. The edge cache is
 * never consulted or written (`cache.match` or `cache.put`), every answer this handler gives, a refusal
 * included, is `Cache-Control: no-store`, and none carries a `Cache-Tag`, an `ETag` or a public address.
 * A refusal from the router's middleware or the rate limiter is not this handler's answer: the website's
 * proxy makes every answer it relays `no-store` (`shared/contract/quality-route.ts`, the proxy's
 * obligations).
 *
 * LOGS. Every line is tagged `[quality-admin]` and leads with `stamp=<id>`; a line about the record or a
 * file then carries the derivative's dataset, the first twelve digits of its key, a fixed word and a
 * reason word (`quality-serve.ts`); a line before the row is read carries the stamp and the word alone.
 * None carries a path.
 */

import { COMPUTE_PIPELINE_STAMP_ID_RE } from "../../../../shared/contract/compute-admin.js";
import {
  QUALITY_ADMIN_ROUTE_WORDS,
  QUALITY_ADMIN_SEGMENT,
  type QualityAdminRouteWord,
  qualityAdminRest,
} from "../../../../shared/contract/quality-route.js";
import { derivativesBound } from "../../services/compute-derivatives.js";
import { type ServedDerivative, serveRecordingViews } from "../../services/quality-serve.js";
import type { AdminRouter } from "./shared.js";

/** The stamp and its derivative, with whether its date has passed: `?1` the stamp id. */
export const RUN_VIEW_DERIVATIVE_SQL = `SELECT s.id AS stamp_id,
       cd.key, cd.dataset_id, cd.recipe, cd.version, cd.recipe_version, cd.input, cd.retention, cd.stored_at,
       cd.quality_plugins, cd.state,
       CASE WHEN cd.key IS NOT NULL AND (cd.state = 'expired'
              OR (cd.expires_at IS NOT NULL AND cd.expires_at <= datetime('now'))) THEN 1 ELSE 0 END AS past
  FROM compute_pipeline_stamps s
  LEFT JOIN compute_derivatives cd ON cd.stamp_id = s.id AND cd.dataset_id = s.dataset_id
 WHERE s.id = ?1`;

type RunViewRow =
  | ({ stamp_id: number; state: string; past: number } & ServedDerivative)
  | { stamp_id: number; key: null; state: null; past: number };

/** Why a run's derivative is not read, or null when it is stored and in date. */
export function runViewRefusal(row: RunViewRow): QualityAdminRouteWord | null {
  if (row.key === null) return "derivative_not_keyed";
  if (row.state === "failed") return "derivative_failed";
  if (row.past === 1) return "views_expired";
  if (row.state === "copying") return "derivative_copying";
  if (row.state !== "stored") return "derivative_not_keyed";
  return null;
}

function refuse(word: QualityAdminRouteWord): Response {
  return new Response(JSON.stringify({ error: word }), {
    status: QUALITY_ADMIN_ROUTE_WORDS[word],
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The raw, still-encoded `rest` after `.../runs/<stamp>/quality/`, or null when the path is not shaped so. */
function rawRest(pathname: string, stamp: string): string | null {
  const parts = pathname.split("/");
  const at = parts.findIndex(
    (s, i) =>
      s === "runs" &&
      parts[i - 1] === "pipeline" &&
      parts[i + 1] === stamp &&
      parts[i + 2] === QUALITY_ADMIN_SEGMENT,
  );
  return at < 0 ? null : parts.slice(at + 3).join("/");
}

export function registerQualityViewAdminRoutes(admin: AdminRouter): void {
  admin.get(`/compute/pipeline/runs/:stamp/${QUALITY_ADMIN_SEGMENT}/*`, async (c) => {
    // 1. The method and the path, before anything is read.
    if (c.req.method !== "GET") return refuse("method_not_allowed");
    // Any `?`, a bare one included (which `URL.search` reads as empty), is outside the grammar.
    if (c.req.url.includes("?")) return refuse("recording_path_invalid");
    const url = new URL(c.req.url);
    const stamp = c.req.param("stamp");
    if (!COMPUTE_PIPELINE_STAMP_ID_RE.test(stamp)) return refuse("stamp_not_found");
    const stampId = Number(stamp);
    if (!Number.isSafeInteger(stampId)) return refuse("stamp_not_found");
    const rest = rawRest(url.pathname, stamp);
    const asked = rest === null ? null : qualityAdminRest(rest);
    if (asked === null) return refuse("recording_path_invalid");

    try {
      // 2. The stamp and its derivative, in one statement; only a stored, in-date row is read.
      const row = await c.env.DB.prepare(RUN_VIEW_DERIVATIVE_SQL).bind(stampId).first<RunViewRow>();
      if (row === null) return refuse("stamp_not_found");
      const word = runViewRefusal(row);
      if (word !== null || row.key === null) return refuse(word ?? "derivative_not_keyed");
      const bucket = c.env.COMPUTE_DERIVATIVES;
      if (!derivativesBound(c.env) || bucket === undefined) {
        console.warn(`[quality-admin] stamp=${stampId} store_unavailable`);
        return refuse("quality_unavailable");
      }

      // 3. The record and file steps of the public route, and no cache.
      const served = await serveRecordingViews(bucket, row, asked, {
        tag: "quality-admin",
        context: `stamp=${stampId}`,
      });
      if (!served.ok) return refuse(served.word);
      return new Response(served.bytes, {
        headers: { ...served.headers, "Cache-Control": "no-store" },
      });
    } catch (err) {
      console.error(
        `[quality-admin] stamp=${stampId} quality_unavailable error=${err instanceof Error ? err.name : typeof err}`,
      );
      return refuse("quality_unavailable");
    }
  });
}
