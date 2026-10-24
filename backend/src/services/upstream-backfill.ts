/**
 * The backfill of `dataset_versions.source_version` for the mirrors that existed before the
 * column did (epic #1046 phase 2, #1908; ADR 0111, decision 4).
 *
 * Every row that predates migration 0100 is NULL/NULL, "never examined". For each `on######`
 * version this reads `v<version>/dataset_description.json` through the authenticated raw CDN
 * and records what it says through the same parser the insert path uses
 * (`shared/source-snapshot.ts`): a tag with basis `doi`, or `unknown`.
 *
 * THE RULES THAT MAKE IT SAFE TO RUN AGAINST PRODUCTION
 *   - A fetch ERROR writes nothing. A 5xx, a 429, a network failure or a timeout says nothing
 *     about the content, and recording `unknown` for it would be the forbidden error-as-unknown
 *     (ADR 0053, ADR 0054); the row stays NULL/NULL and the next pass tries it again.
 *   - A 404 is `unknown` ("no description at that tag"), but only for a row older than an
 *     hour: the raw CDN caches a 404 for a few minutes, so a freshly pushed tag can read as
 *     absent when it is not. A younger row is not a candidate.
 *   - GitHub answers 404 for a credential that cannot see the repository. So a batch of two or
 *     more rows that ALL read absent is refused as `suspect_credential` and writes nothing.
 *   - The write is `... WHERE source_version_basis IS NULL`: it never overwrites a recorded
 *     value, so a rerun writes 0 and a live insert that lands first always wins.
 *   - Paging is a KEYSET on `(dataset_id, version)`. Without it a row that always errors would
 *     sit at the head of an offset-free queue forever and starve every row behind it (the
 *     fairness bug the Zarr fidelity sweep had).
 *   - The default is a dry run, and a dry run writes nothing.
 *
 * COST. At most {@link UPSTREAM_BACKFILL_MAX} raw GETs (no REST quota: the CDN returns no
 * `x-ratelimit-*` and spends none of the installation's hourly budget) and one D1 batch per call.
 */

import { openNeuroSourceId } from "../../../shared/source-snapshot.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import { errorMessage } from "./repo-metadata.js";
import { fetchDescriptionAtTag, snapshotFromDescriptionText } from "./source-snapshot.js";

export const UPSTREAM_BACKFILL_DEFAULT = 25;
export const UPSTREAM_BACKFILL_MAX = 50;
/** Rows younger than this are skipped, so a CDN-cached 404 on a fresh tag is never made final. */
export const UPSTREAM_BACKFILL_MIN_AGE = "-1 hour";
const CONCURRENCY = 5;

const ELIGIBLE = `dv.source_version_basis IS NULL
  AND dv.dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]'
  AND d.withdrawn_at IS NULL
  AND d.github_repo IS NOT NULL
  AND dv.created_at < datetime('now', '${UPSTREAM_BACKFILL_MIN_AGE}')`;

/** The rows to examine, in key order, after the cursor. */
export const UPSTREAM_BACKFILL_CANDIDATE_SQL = `SELECT dv.dataset_id, dv.version, d.github_repo
FROM dataset_versions dv JOIN datasets d ON d.dataset_id = dv.dataset_id
WHERE ${ELIGIBLE}
  AND (dv.dataset_id, dv.version) > (?, ?)
ORDER BY dv.dataset_id, dv.version
LIMIT ?`;

/** How many candidates are left after a key. */
export const UPSTREAM_BACKFILL_REMAINING_SQL = `SELECT COUNT(*) AS n
FROM dataset_versions dv JOIN datasets d ON d.dataset_id = dv.dataset_id
WHERE ${ELIGIBLE}
  AND (dv.dataset_id, dv.version) > (?, ?)`;

/** The write: never over a recorded value. */
export const UPSTREAM_BACKFILL_WRITE_SQL = `UPDATE dataset_versions
SET source_version = ?, source_version_basis = ?
WHERE dataset_id = ? AND version = ? AND source_version_basis IS NULL`;

/** Where the pass stands over every `on` version row, whatever this call did. */
export const UPSTREAM_BACKFILL_COUNTS_SQL = `SELECT COALESCE(source_version_basis, 'not_examined') AS basis, COUNT(*) AS n
FROM dataset_versions
WHERE dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]'
GROUP BY 1`;

export const CURSOR_RE = /^(on\d{6})@(\d+\.\d+\.\d+)$/;

export interface UpstreamBackfillOptions {
  execute?: boolean;
  limit?: number;
  /** `<dataset_id>@<version>`: examine only rows after this key. */
  after?: string;
}

export interface UpstreamBackfillError {
  dataset_id: string;
  version: string;
  error: string;
}

export interface UpstreamBackfillResult {
  /** False when the call must be treated as failed (every row errored, or a suspect credential). */
  ok: boolean;
  execute: boolean;
  scanned: number;
  /** Rows written (execute), or that would be (dry run). */
  recorded: { doi: number; unknown: number };
  /** Rows whose read failed: nothing was written and the next pass tries them again. */
  not_examined: number;
  /** Rows whose description was not JSON: counted in `recorded.unknown` too. */
  unparseable: number;
  /** Rows whose file did not exist at the tag: counted in `recorded.unknown` too. */
  absent: number;
  /** Rows another writer filled between the read and the write; left as they were. */
  skipped_existing: number;
  errors: UpstreamBackfillError[];
  suspect_credential: boolean;
  /** The key to pass as `after` for the next call, or null when the pass is done. */
  next_cursor: string | null;
  /** Candidates after this call's last row. */
  remaining: number;
  /** Every `on` version row by state, as the database now holds it. */
  counts: { doi: number; lineage: number; unknown: number; not_examined: number };
  /** In a dry run, up to ten rows that would be recorded `unknown`, with the reason. */
  unknown_samples: { dataset_id: string; version: string; reason: string }[];
  error?: string;
}

interface Candidate {
  dataset_id: string;
  version: string;
  github_repo: string;
}

type Examined =
  | {
      kind: "record";
      candidate: Candidate;
      tag: string | null;
      basis: "doi" | "unknown";
      reason: string;
      unparseable: boolean;
      absent: boolean;
    }
  | { kind: "error"; candidate: Candidate; error: string };

/** Run `work` over `items`, at most `width` at a time, keeping the order of the results. */
async function mapBounded<T, R>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return out;
}

export function clampBackfillLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return UPSTREAM_BACKFILL_DEFAULT;
  return Math.min(Math.floor(limit), UPSTREAM_BACKFILL_MAX);
}

async function readCounts(db: D1Database): Promise<UpstreamBackfillResult["counts"]> {
  const rows = await db.prepare(UPSTREAM_BACKFILL_COUNTS_SQL).all<{ basis: string; n: number }>();
  const counts = { doi: 0, lineage: 0, unknown: 0, not_examined: 0 };
  for (const row of rows.results) {
    if (row.basis in counts) counts[row.basis as keyof typeof counts] = row.n;
  }
  return counts;
}

/** Fill in where the pass stands after this call: the cursor, what is left, and the counts. */
async function finish(
  db: D1Database,
  result: UpstreamBackfillResult,
  last: Candidate | undefined,
): Promise<UpstreamBackfillResult> {
  if (last) {
    const left = await db
      .prepare(UPSTREAM_BACKFILL_REMAINING_SQL)
      .bind(last.dataset_id, last.version)
      .first<{ n: number }>();
    result.remaining = left?.n ?? 0;
    result.next_cursor = result.remaining > 0 ? `${last.dataset_id}@${last.version}` : null;
  }
  result.counts = await readCounts(db);
  return result;
}

/**
 * One batch of the backfill. Throws only when the database cannot be read (the route answers
 * 500); everything about the network is reported in the result.
 */
export async function runUpstreamBackfill(
  env: Bindings,
  opts: UpstreamBackfillOptions = {},
): Promise<UpstreamBackfillResult> {
  const execute = opts.execute === true;
  const limit = clampBackfillLimit(opts.limit);
  const cursor = opts.after ? CURSOR_RE.exec(opts.after) : null;
  const [afterId, afterVersion] = cursor ? [cursor[1] as string, cursor[2] as string] : ["", ""];

  const candidates = (
    await env.DB.prepare(UPSTREAM_BACKFILL_CANDIDATE_SQL)
      .bind(afterId, afterVersion, limit)
      .all<Candidate>()
  ).results;

  const result: UpstreamBackfillResult = {
    ok: true,
    execute,
    scanned: candidates.length,
    recorded: { doi: 0, unknown: 0 },
    not_examined: 0,
    unparseable: 0,
    absent: 0,
    skipped_existing: 0,
    errors: [],
    suspect_credential: false,
    next_cursor: null,
    remaining: 0,
    counts: { doi: 0, lineage: 0, unknown: 0, not_examined: 0 },
    unknown_samples: [],
  };

  if (candidates.length > 0) {
    let pat: string;
    try {
      pat = await getDatasetsToken(env);
    } catch (err) {
      result.ok = false;
      result.not_examined = candidates.length;
      result.error = `No GitHub credential could be obtained: ${errorMessage(err)}`;
      return finish(env.DB, result, candidates[candidates.length - 1]);
    }

    const examined = await mapBounded(candidates, CONCURRENCY, async (c): Promise<Examined> => {
      const sourceId = openNeuroSourceId(c.dataset_id);
      if (!sourceId) return { kind: "error", candidate: c, error: "not an on###### dataset id" };
      const repo = c.github_repo.split("/")[1] || c.dataset_id;
      const fetched = await fetchDescriptionAtTag(env, repo, c.version, pat);
      if (fetched.kind === "error") return { kind: "error", candidate: c, error: fetched.reason };
      if (fetched.kind === "absent") {
        return {
          kind: "record",
          candidate: c,
          tag: null,
          basis: "unknown",
          reason: "dataset_description.json does not exist at the tag",
          unparseable: false,
          absent: true,
        };
      }
      const { columns, unparseable } = snapshotFromDescriptionText(sourceId, fetched.body);
      return {
        kind: "record",
        candidate: c,
        tag: columns.source_version,
        basis: columns.source_version_basis,
        reason: unparseable
          ? "dataset_description.json is not valid JSON"
          : "no single tag named by the dataset's own SourceDatasets entry",
        unparseable,
        absent: false,
      };
    });

    const records = examined.filter((e): e is Extract<Examined, { kind: "record" }> => {
      return e.kind === "record";
    });
    for (const e of examined) {
      if (e.kind === "error") {
        result.not_examined++;
        result.errors.push({
          dataset_id: e.candidate.dataset_id,
          version: e.candidate.version,
          error: e.error,
        });
      }
    }

    // A credential GitHub cannot see the repositories with answers 404 to every one of them.
    if (
      candidates.length >= 2 &&
      records.length === candidates.length &&
      records.every((r) => r.absent)
    ) {
      result.ok = false;
      result.suspect_credential = true;
      result.absent = records.length;
      result.error = `All ${records.length} descriptions read as absent; the GitHub credential may not see these repositories. Nothing was written.`;
      return finish(env.DB, result, candidates[candidates.length - 1]);
    }
    if (records.length === 0) {
      result.ok = false;
      result.error = `All ${candidates.length} reads failed; see errors[]. Nothing was written.`;
      return finish(env.DB, result, candidates[candidates.length - 1]);
    }

    for (const r of records) {
      if (r.absent) result.absent++;
      if (r.unparseable) result.unparseable++;
      if (r.basis === "doi") result.recorded.doi++;
      else {
        result.recorded.unknown++;
        if (!execute && result.unknown_samples.length < 10) {
          result.unknown_samples.push({
            dataset_id: r.candidate.dataset_id,
            version: r.candidate.version,
            reason: r.reason,
          });
        }
      }
    }

    if (execute) {
      const statements = records.map((r) =>
        env.DB.prepare(UPSTREAM_BACKFILL_WRITE_SQL).bind(
          r.tag,
          r.basis,
          r.candidate.dataset_id,
          r.candidate.version,
        ),
      );
      const written = await env.DB.batch(statements);
      written.forEach((w, i) => {
        if ((w.meta?.changes ?? 0) === 0) {
          const r = records[i] as Extract<Examined, { kind: "record" }>;
          result.skipped_existing++;
          if (r.basis === "doi") result.recorded.doi--;
          else result.recorded.unknown--;
        }
      });
    }
  }

  return finish(env.DB, result, candidates[candidates.length - 1]);
}
