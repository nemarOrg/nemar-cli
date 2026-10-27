/**
 * The backfill of `dataset_versions.source_version` for the mirrors that existed before the
 * column did (epic #1046 phase 2, #1908; ADR 0111, decision 4).
 *
 * Every row that predates migration 0104 is NULL/NULL, "never examined". For each `on######`
 * version this reads `dataset_description.json` at the version's tag `v<N.N.N>` through the
 * authenticated raw CDN and records what it says through the same parser the insert path uses
 * (`shared/source-snapshot.ts`): a tag with basis `doi`, or `unknown`.
 *
 * THE RULES THAT MAKE IT SAFE TO RUN AGAINST PRODUCTION
 *   - A fetch ERROR writes nothing. A 5xx, a 429, a network failure, a timeout or a body over
 *     the size cap says nothing about the content, and recording `unknown` for it would be the
 *     forbidden error-as-unknown (ADR 0053, ADR 0054); the row stays NULL/NULL and the next
 *     pass tries it again.
 *   - `unknown` is FINAL: the write never overwrites it and nothing re-examines the row. So a
 *     404 becomes `unknown` only when it is proved to be about the tag and not about the
 *     credential. GitHub answers 404 for a credential that cannot see a repository, so a 404 is
 *     recorded only after a CONTROL READ succeeds: the same repository's `dataset_description.json`
 *     at `main`, with the same credential. If the control read FAILS, the row is counted
 *     `not_examined` as `transient` and the next pass retries it. If the control read is ABSENT
 *     too, the description is missing at the tag and at `main` (or the default branch is not
 *     `main`): the row is `needs_admin`, which no rerun fixes. Nothing is written in either case.
 *     This holds for a batch of any size, including one row.
 *   - A batch in which no row proved the credential (nothing returned content, no 404 was
 *     confirmed by a control read) but at least one 404 was left unconfirmed is refused as
 *     `suspect_credential`, whatever else errored in the same batch.
 *   - A row younger than an hour is not a candidate: the raw CDN caches a 404 for a few
 *     minutes, so a freshly pushed tag can read as absent when it is not.
 *   - A version is a candidate in either spelling D1 holds, `N.N.N` or `vN.N.N`, read as
 *     `mirroredTagOf` reads it (`bareNemarVersion`: one lowercase `v`, then N.N.N), so the rows
 *     the staleness report calls never examined are the rows this pass examines. The ref is always
 *     the canonical tag `v<N.N.N>`, so a `v1.0.0` row never reads `vv1.0.0`; the rows of one
 *     version in its two spellings name that one tag, so it is read once and each row is recorded
 *     from that read; and the cursor carries the row's own spelling, which the route takes back.
 *     Any other value (`vv1.0.0`, `V1.0.0`, a non-semver one) is never a candidate, so it can
 *     neither build a bad tag URL nor produce a cursor the route would refuse.
 *   - The write is `... WHERE source_version_basis IS NULL`: it never overwrites a recorded
 *     value, so a rerun writes 0 and a live insert that lands first always wins. A write result
 *     that carries no change count is an error, never a zero.
 *   - Paging is a KEYSET on `(dataset_id, version)`. Without it a row that always errors would
 *     sit at the head of the queue on every pass and starve every row behind it.
 *   - The default is a dry run, and a dry run writes nothing.
 *
 * COST. Per call at most {@link UPSTREAM_BACKFILL_MAX} raw GETs for the tags, at most one control
 * GET per distinct repository whose tag read was absent, one candidate query, one D1 batch and
 * the count queries. The raw CDN returns no `x-ratelimit-*` and spends none of the installation's
 * hourly REST budget. `counts.not_examined` counts every `on` version row with no basis,
 * including rows whose version is neither spelling of N.N.N and which no pass will ever examine.
 */

import { bareNemarVersion, openNeuroSourceId } from "../../../shared/source-snapshot.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import { errorMessage } from "./repo-metadata.js";
import {
  fetchDescriptionAtRef,
  fetchDescriptionAtTag,
  snapshotFromDescriptionText,
} from "./source-snapshot.js";

export const UPSTREAM_BACKFILL_DEFAULT = 25;
export const UPSTREAM_BACKFILL_MAX = 50;
/** Rows younger than this are skipped, so a CDN-cached 404 on a fresh tag is never made final. */
export const UPSTREAM_BACKFILL_MIN_AGE = "-1 hour";
const CONCURRENCY = 5;

/**
 * The stored version without one leading lowercase `v`, as `bareNemarVersion` strips it, in SQL.
 * GLOB, not `=` or LIKE, because GLOB is case-sensitive: `V1.0.0` keeps its `V` and is no
 * candidate, and `vv1.0.0` keeps one `v`, which the shape below refuses.
 */
const BARE_VERSION =
  "(CASE WHEN dv.version GLOB 'v*' THEN substr(dv.version, 2) ELSE dv.version END)";

/** The three GLOBs together are `^\d+\.\d+\.\d+$` on the bare version: digits and two dots. */
const ELIGIBLE = `dv.source_version_basis IS NULL
  AND dv.dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]'
  AND d.withdrawn_at IS NULL
  AND d.github_repo IS NOT NULL
  AND ${BARE_VERSION} NOT GLOB '*[^0-9.]*'
  AND ${BARE_VERSION} GLOB '[0-9]*.[0-9]*.[0-9]*'
  AND ${BARE_VERSION} NOT GLOB '*.*.*.*'
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

/** `<dataset_id>@<version>`, the version in the row's own spelling, which the keyset compares. */
export const CURSOR_RE = /^(on\d{6})@(v?\d+\.\d+\.\d+)$/;

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
  /**
   * Why the row was not recorded. `transient`: a failed read, a failed control read or an
   * unreadable write result, which a rerun can fix. `needs_admin`: the description is absent at
   * the tag AND at `main` (or the default branch is not `main`), which a rerun never fixes.
   */
  kind: "transient" | "needs_admin";
}

export interface UpstreamBackfillResult {
  /** False when the call must be treated as failed (every row errored, or a suspect credential). */
  ok: boolean;
  execute: boolean;
  scanned: number;
  /** Rows written (execute), or that would be (dry run). */
  recorded: { doi: number; unknown: number };
  /**
   * Rows that were not recorded, each listed in `errors` with its `kind`: `transient` rows are
   * retried by the next pass, `needs_admin` rows (no description at the tag or at `main`) never
   * recover on their own.
   */
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

/** What the read of one tag came to, for every row that names it. */
type Reading =
  | {
      kind: "record";
      tag: string | null;
      basis: "doi" | "unknown";
      reason: string;
      unparseable: boolean;
      absent: boolean;
    }
  | { kind: "error"; error: string }
  /** The tag read was absent and the control read did not show the credential sees the repo. */
  | {
      kind: "unconfirmed";
      error: string;
      cause: "transient" | "needs_admin";
    };

/** One candidate row and what the read of its tag came to. */
type Examined = Reading & { candidate: Candidate };

/** Run `work` over `items`, at most `width` at a time, keeping the order of the results. */
export async function mapBounded<T, R>(
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

    // One control read per repository, shared by every row of it that reads absent.
    const controls = new Map<string, Promise<Awaited<ReturnType<typeof fetchDescriptionAtRef>>>>();
    const controlOf = (repo: string) => {
      let read = controls.get(repo);
      if (!read) {
        read = fetchDescriptionAtRef(env, repo, "main", pat);
        controls.set(repo, read);
      }
      return read;
    };

    // The description at the tag `v<bare>` of the candidate's repository.
    const readTag = async (c: Candidate, bare: string): Promise<Reading> => {
      const sourceId = openNeuroSourceId(c.dataset_id);
      if (!sourceId) return { kind: "error", error: "not an on###### dataset id" };
      const repo = c.github_repo.split("/")[1] || c.dataset_id;
      const fetched = await fetchDescriptionAtTag(env, repo, bare, pat);
      if (fetched.kind === "error") return { kind: "error", error: fetched.reason };
      if (fetched.kind === "absent") {
        const control = await controlOf(repo);
        if (control.kind !== "content") {
          return {
            kind: "unconfirmed",
            cause: control.kind === "absent" ? "needs_admin" : "transient",
            error:
              control.kind === "absent"
                ? "dataset_description.json is absent at the tag and at main, so the 404 may be the credential's; not recorded"
                : `dataset_description.json is absent at the tag and the control read of main failed (${control.reason}); not recorded`,
          };
        }
        return {
          kind: "record",
          tag: null,
          basis: "unknown",
          reason:
            "dataset_description.json does not exist at the tag (the control read of main succeeded)",
          unparseable: false,
          absent: true,
        };
      }
      const { columns, unparseable } = snapshotFromDescriptionText(sourceId, fetched.body);
      return {
        kind: "record",
        tag: columns.source_version,
        basis: columns.source_version_basis,
        reason: unparseable
          ? "dataset_description.json is not valid JSON"
          : "no single tag named by the dataset's own SourceDatasets entry",
        unparseable,
        absent: false,
      };
    };

    // One read per tag: the rows of one version in its two spellings (`1.0.0`, `v1.0.0`) name the
    // same tag, so they are read together and each is recorded from that one read.
    const reads = new Map<string, Promise<Reading>>();
    const examined = await mapBounded(candidates, CONCURRENCY, async (c): Promise<Examined> => {
      const bare = bareNemarVersion(c.version);
      // The candidate query and `bareNemarVersion` read one shape; a row they disagree on is
      // reported, never read.
      if (bare === null) return { kind: "error", candidate: c, error: "not a NEMAR version" };
      const key = `${c.dataset_id}@${bare}`;
      let read = reads.get(key);
      if (!read) {
        read = readTag(c, bare);
        reads.set(key, read);
      }
      return { ...(await read), candidate: c };
    });

    const records = examined.filter((e): e is Extract<Examined, { kind: "record" }> => {
      return e.kind === "record";
    });
    let unconfirmed = 0;
    for (const e of examined) {
      if (e.kind === "record") continue;
      if (e.kind === "unconfirmed") unconfirmed++;
      result.not_examined++;
      result.errors.push({
        dataset_id: e.candidate.dataset_id,
        version: e.candidate.version,
        error: e.error,
        kind: e.kind === "unconfirmed" ? e.cause : "transient",
      });
    }

    // No row proved that the credential can see these repositories, and at least one 404 is
    // unconfirmed: the likeliest cause is the credential, whatever else errored beside it.
    if (records.length === 0 && unconfirmed > 0) {
      result.ok = false;
      result.suspect_credential = true;
      result.error = `${unconfirmed} description(s) read as absent and no read in this batch proved the GitHub credential can see these repositories. Nothing was written.`;
      return finish(env.DB, result, candidates[candidates.length - 1]);
    }
    if (records.length === 0) {
      result.ok = false;
      result.error = `All ${candidates.length} reads failed; see errors[]. Nothing was written.`;
      return finish(env.DB, result, candidates[candidates.length - 1]);
    }

    const noteRecorded = (r: Extract<Examined, { kind: "record" }>) => {
      if (r.absent) result.absent++;
      if (r.unparseable) result.unparseable++;
      if (r.basis === "doi") result.recorded.doi++;
      else result.recorded.unknown++;
    };

    if (!execute) {
      for (const r of records) {
        noteRecorded(r);
        if (r.basis !== "doi" && result.unknown_samples.length < 10) {
          result.unknown_samples.push({
            dataset_id: r.candidate.dataset_id,
            version: r.candidate.version,
            reason: r.reason,
          });
        }
      }
    } else {
      const statements = records.map((r) =>
        env.DB.prepare(UPSTREAM_BACKFILL_WRITE_SQL).bind(
          r.tag,
          r.basis,
          r.candidate.dataset_id,
          r.candidate.version,
        ),
      );
      const written = await env.DB.batch(statements);
      records.forEach((r, i) => {
        const changes = written[i]?.meta?.changes;
        if (typeof changes !== "number") {
          // The write may or may not have happened; a missing count is never read as zero.
          result.errors.push({
            dataset_id: r.candidate.dataset_id,
            version: r.candidate.version,
            error: "the write result carried no change count; whether it landed is unknown",
            kind: "transient",
          });
        } else if (changes === 0) {
          result.skipped_existing++;
        } else {
          noteRecorded(r);
        }
      });
    }
  }

  return finish(env.DB, result, candidates[candidates.length - 1]);
}
