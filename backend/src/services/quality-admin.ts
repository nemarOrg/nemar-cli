/**
 * A run's quality as an administrator reads it (ADR 0137 decision 7, epic #2324 phase B3):
 * `GET /admin/compute/pipeline/runs/:stamp/quality` (`routes/admin/compute-pipeline.ts`).
 *
 * Two answers in one:
 *  - WHERE THE RUN'S DERIVATIVE STANDS, one word of `COMPUTE_RUN_QUALITY_STATES`, from ONE D1 statement
 *    (`RUN_QUALITY_SQL`): the stamp, its derivative row (one stamp makes at most one), the skip log's word
 *    when the store decided to make none, whether the dataset passes the quality route's gate now
 *    (`dataset_public`, `QUALITY_DATASET_GATE_SQL`), and whether the row is its dataset and recipe's current
 *    public derivative (B1's `CURRENT_PUBLIC_DERIVATIVE_SQL`, the rule the public route serves by). Every state a
 *    row can be in has a word: a copying, failed, expired, canary or superseded row is answered, never a
 *    500. A row whose date has passed is `expired` before the sync marks it so (the missing-canary case:
 *    its files are deleted or about to be).
 *  - THE RECORDINGS THAT SUCCEEDED, a keyset page of `COMPUTE_RUN_QUALITY_PAGE_SIZE` by path (code-unit
 *    order), from the recordings table stored under the derivative's key (`d/<key>/desc-<label>_recordings.tsv`).
 *    The table is read only when the row is `stored` and its date has not passed, so its files stand whole;
 *    the read is bounded (`TABLE_READ_MAX_BYTES`, the bound reconciliation reads the same table with: a
 *    larger object's body is never read), parsed by the shared reader (`parseRecordingsTable`) and the sorted
 *    list of succeeded paths kept in the edge cache under the derivative's KEY. A derivative's files never
 *    change under its key, so the entry needs no invalidation; it is consulted only after the D1 statement
 *    has said the files stand, so an expired derivative's list is never served from it. A page is then one
 *    D1 statement and one cache match, and no store read.
 *
 * A succeeded path that is not a recording path the quality route takes (its `relativeLocation` pattern and
 * a recording's name) is left out and counted as `unlisted`, so every listed path is one the drill-down can
 * ask the route for; a table that lists one path twice is refused whole (`parseRecordingsTable`'s
 * `duplicate_path`, answered `table_unreadable`), as reconciliation refuses it. The cursor (`after`) is a path of that shape, checked by the route before anything is
 * read; one the list does not hold still pages from where it would sort.
 *
 * The route answers `Cache-Control: no-store` (ADR 0137 decision 7: no administrator answer is cached);
 * the edge-cache entry is the parsed table, never an answer. A log line carries the stamp, the first twelve
 * digits of a key and a fixed word, never a path.
 */

import { parseRecordingsTable } from "../../../shared/compute-checkpoints.js";
import { matchRecording } from "../../../shared/compute-naming.js";
import {
  RECIPE_PRODUCT_OUTPUT_PREFIX,
  recipeRequiredOutputs,
} from "../../../shared/compute-recipes.js";
import {
  COMPUTE_RUN_QUALITY_PAGE_SIZE,
  type ComputeRunQualityRecordingsState,
  type ComputeRunQualityResponse,
  type ComputeRunQualityState,
} from "../../../shared/contract/compute-admin.js";
import { isQualityRecordingPath } from "../../../shared/contract/quality-route.js";
import type { Bindings } from "../types/bindings.js";
import {
  DERIVATIVE_OBJECT_PREFIX,
  TABLE_READ_MAX_BYTES,
  derivativesBound,
} from "./compute-derivatives.js";
import type { ManifestCache } from "./manifest-source.js";
import {
  CURRENT_PUBLIC_DERIVATIVE_SQL,
  QUALITY_DATASET_GATE_SQL,
  QUALITY_PATTERNS,
} from "./quality-documents.js";

/** The stamp, its derivative, its skip word and the two judgments the word needs: `?1` the stamp id. */
export const RUN_QUALITY_SQL = `SELECT s.id, s.dataset_id, s.version, s.recipe, s.recipe_version, s.input,
       s.state AS stamp_state, k.word AS skip,
       cd.key, cd.state, cd.retention, cd.failure, cd.created_at, cd.stored_at, cd.expires_at,
       cd.superseded_at, cd.serving_index,
       CASE WHEN cd.key IS NOT NULL AND ${CURRENT_PUBLIC_DERIVATIVE_SQL("cd")} THEN 1 ELSE 0 END AS current,
       CASE WHEN cd.key IS NOT NULL AND (cd.state = 'expired'
              OR (cd.expires_at IS NOT NULL AND cd.expires_at <= datetime('now'))) THEN 1 ELSE 0 END AS past,
       CASE WHEN d.dataset_id IS NOT NULL AND ${QUALITY_DATASET_GATE_SQL} THEN 1 ELSE 0 END AS dataset_public
  FROM compute_pipeline_stamps s
  LEFT JOIN datasets d ON d.dataset_id = s.dataset_id
  LEFT JOIN compute_derivatives cd ON cd.stamp_id = s.id
  LEFT JOIN compute_derivative_skips k ON k.stamp_id = s.id
 WHERE s.id = ?1`;

interface RunQualityRow {
  id: number;
  dataset_id: string;
  version: string;
  recipe: string;
  recipe_version: string;
  input: string;
  stamp_state: string;
  skip: string | null;
  key: string | null;
  state: string | null;
  retention: string | null;
  failure: string | null;
  created_at: string | null;
  stored_at: string | null;
  expires_at: string | null;
  superseded_at: string | null;
  serving_index: string | null;
  current: number;
  past: number;
  dataset_public: number;
}

/** The word for where a run's derivative stands, in the order `COMPUTE_RUN_QUALITY_STATES` gives. */
export function runQualityState(row: RunQualityRow): ComputeRunQualityState {
  if (row.key === null) {
    if (row.stamp_state === "dispatched") return "run_in_progress";
    if (row.stamp_state !== "succeeded") return "run_not_succeeded";
    return row.skip !== null ? "not_keyed" : "awaiting_derivative";
  }
  if (row.state === "failed") return "failed";
  if (row.past === 1) return "expired";
  if (row.state === "copying") return "copying";
  if (row.retention === "canary") return "canary";
  if (row.current === 1) return "current";
  if (row.retention === "catalog" && row.superseded_at !== null) return "superseded";
  return "not_current";
}

/** Whether a derivative's files stand whole, so its recordings table may be read. */
const STORED_WORDS: readonly ComputeRunQualityState[] = [
  "canary",
  "current",
  "superseded",
  "not_current",
];

/** Whether a path is a recording path the quality route takes: the shared rule (`isQualityRecordingPath`). */
export const isRecordingPath = isQualityRecordingPath;

/** Where the recordings table of a recipe's run sits under a derivative's key. */
export function storedTablePath(recipe: string): string {
  return recipeRequiredOutputs({ name: recipe }).table.slice(RECIPE_PRODUCT_OUTPUT_PREFIX.length);
}

/** The parsed table as the cache keeps it: the succeeded recording paths, sorted, and those left out. */
interface SucceededList {
  paths: string[];
  unlisted: number;
}

/** How long the edge cache keeps a parsed table: a day (a key's files never change; this only frees room). */
export const RUN_QUALITY_CACHE_SECONDS = 86_400;

/** The Workers Cache API where there is one (`bun test` installs a real in-memory one when a suite needs it). */
function edgeCache(): ManifestCache | null {
  const storage = (globalThis as { caches?: { default?: ManifestCache } }).caches;
  return storage?.default ?? null;
}

/** The cache key of a derivative's parsed table: its key alone decides its contents. */
export function runQualityCacheKey(origin: string, key: string): Request {
  return new Request(`${origin}/__quality-admin-cache/v1/${key}/recordings`);
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type ListRead =
  | { kind: "ok"; list: SucceededList }
  | { kind: Exclude<ComputeRunQualityRecordingsState, "listed" | "not_stored"> };

/** Read, parse and keep a stored derivative's succeeded recordings, at most one store read. */
async function succeededList(
  env: Bindings,
  stampId: number,
  key: string,
  recipe: string,
  origin: string,
  defer?: (work: Promise<unknown>) => void,
): Promise<ListRead> {
  const cache = edgeCache();
  const cacheKey = runQualityCacheKey(origin, key);
  const short = key.slice(0, 12);
  if (cache !== null) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      try {
        const list = (await hit.json()) as SucceededList;
        if (Array.isArray(list.paths) && typeof list.unlisted === "number") {
          return { kind: "ok", list };
        }
      } catch {
        /* an unreadable entry is read again from the store below */
      }
      console.warn(`[quality-admin] cache_entry_unreadable stamp=${stampId} key=${short}`);
    }
  }
  const bucket = env.COMPUTE_DERIVATIVES;
  if (!derivativesBound(env) || bucket === undefined) return { kind: "store_unavailable" };

  let bytes: Uint8Array;
  try {
    const object = await bucket.get(`${DERIVATIVE_OBJECT_PREFIX}${key}/${storedTablePath(recipe)}`);
    if (object === null) return { kind: "table_missing" };
    // A larger object's body is never read: it is cancelled, so the stream is released at once.
    if (object.size > TABLE_READ_MAX_BYTES) {
      // Best effort: a stream that cannot be cancelled is released by the runtime, and the answer stands.
      try {
        await object.body.cancel();
      } catch {
        /* the runtime releases it */
      }
      return { kind: "table_too_large" };
    }
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch (err) {
    console.error(
      `[quality-admin] store_unavailable stamp=${stampId} key=${short} error=${err instanceof Error ? err.name : typeof err}`,
    );
    return { kind: "store_unavailable" };
  }
  // The size the store stated is the size read, or the object changed under the read.
  if (bytes.byteLength > TABLE_READ_MAX_BYTES) return { kind: "table_too_large" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    console.warn(`[quality-admin] table_unreadable stamp=${stampId} key=${short} reason=utf8`);
    return { kind: "table_unreadable" };
  }

  const table = parseRecordingsTable(text);
  if (!table.ok) {
    console.warn(
      `[quality-admin] table_unreadable stamp=${stampId} key=${short} reason=${table.reason}`,
    );
    return { kind: "table_unreadable" };
  }
  const paths: string[] = [];
  let unlisted = 0;
  for (const row of table.rows) {
    if (row.status !== "succeeded") continue;
    if (!isRecordingPath(row.path)) {
      unlisted++;
      continue;
    }
    paths.push(row.path);
  }
  paths.sort(compareCodeUnits);
  const list: SucceededList = { paths, unlisted };

  if (cache !== null) {
    const entry = new Response(JSON.stringify(list), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${RUN_QUALITY_CACHE_SECONDS}`,
      },
    });
    const write = cache.put(cacheKey, entry).catch((err: unknown) => {
      console.warn(
        `[quality-admin] cache_put_failed stamp=${stampId} key=${short} error=${err instanceof Error ? err.name : typeof err}`,
      );
    });
    if (defer) defer(write);
    else await write;
  }
  return { kind: "ok", list };
}

/** The first index of a sorted list whose path sorts after `after` (binary search). */
export function pageStart(paths: readonly string[], after: string | null): number {
  if (after === null) return 0;
  let lo = 0;
  let hi = paths.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((paths[mid] as string) <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A run's quality: where its derivative stands and a page of its succeeded recordings after `after` (a
 * recording path the caller has checked), or null when there is no such stamp.
 */
export async function runQuality(
  env: Bindings,
  input: {
    stampId: number;
    after: string | null;
    origin: string;
    defer?: (work: Promise<unknown>) => void;
  },
): Promise<ComputeRunQualityResponse | null> {
  const row = await env.DB.prepare(RUN_QUALITY_SQL).bind(input.stampId).first<RunQualityRow>();
  if (row === null) return null;
  const quality = runQualityState(row);

  let recordings: ComputeRunQualityResponse["recordings"] = {
    state: "not_stored",
    succeeded: null,
    unlisted: 0,
    items: [],
    next_after: null,
  };
  if (row.key !== null && STORED_WORDS.includes(quality)) {
    const read = await succeededList(env, row.id, row.key, row.recipe, input.origin, input.defer);
    if (read.kind !== "ok") {
      recordings = { ...recordings, state: read.kind };
    } else {
      const { paths, unlisted } = read.list;
      const start = pageStart(paths, input.after);
      const page = paths.slice(start, start + COMPUTE_RUN_QUALITY_PAGE_SIZE);
      const more = start + page.length < paths.length;
      recordings = {
        state: "listed",
        succeeded: paths.length,
        unlisted,
        items: page.map((path) => ({ path })),
        next_after: more ? (page[page.length - 1] as string) : null,
      };
    }
  }

  return {
    stamp_id: row.id,
    dataset_id: row.dataset_id,
    version: row.version,
    recipe: row.recipe,
    recipe_version: row.recipe_version,
    input: row.input,
    stamp_state: row.stamp_state,
    dataset_public: row.dataset_public === 1,
    quality,
    skip: row.skip,
    derivative:
      row.key === null
        ? null
        : {
            key: row.key,
            state: row.state as string,
            retention: row.retention as string,
            failure: row.failure,
            created_at: row.created_at as string,
            stored_at: row.stored_at,
            expires_at: row.expires_at,
            superseded_at: row.superseded_at,
            serving_index: row.serving_index,
          },
    recordings,
  };
}
