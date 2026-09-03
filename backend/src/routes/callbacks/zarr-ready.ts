/**
 * Zarr conversion callback: POST /zarr-ready, called by the Zarr build
 * pipeline to record conversion state on the datasets row (+ best-effort
 * CDN cache purge). Bearer-token authed.
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { z } from "zod";
import { purgeCacheUrls, zarrPurgeTargets } from "../../services/cloudflare.js";
import { isValidDatasetId } from "../../services/datasetId.js";
import { type WebhookRouter, timingSafeEqual } from "../webhooks/shared.js";

/**
 * POST /webhooks/zarr-ready — callback from `scripts/zarr/hallu-zarr.sh`, which
 * lives in THIS repo and runs on the SDSC Hallu cron (ADR 0029 repatriated it
 * from nemarDatasets/.github), once a dataset's Zarr serving copy has been
 * (re)built and synced to `s3://nemar/<id>/zarr/...` (epic #684 / Stream C).
 *
 * Authenticated with the shared `X-Webhook-Token` (NEMAR_WEBHOOK_TOKEN), same
 * as /publish-version-doi. Records the latest-only conversion state on the
 * `datasets` row (status, store count, index ETag, source commit, timestamp)
 * and best-effort purges the small shared cache objects (index.json + each
 * changed store's zarr.json) so the viewer sees added/removed stores promptly;
 * the bulk chunk objects ride the edge TTL + ETag revalidation.
 *
 * Idempotent: replaying a callback re-writes the same row state and re-purges
 * the same URLs (both harmless). Always 200 on a valid token + body so the
 * workflow's fire-and-forget POST doesn't see a retryable error.
 */
interface ZarrReadyBody {
  dataset_id: string;
  // 'converting' is the live in-progress signal the Hallu driver POSTs when it
  // starts a dataset, so the dashboard's "Processing" tile reflects conversions
  // actually running (the cron has no Actions dispatch to set it). 'ready' /
  // 'failed' are the terminal outcomes. See #774.
  status?: "ready" | "failed" | "converting";
  store_count?: number;
  index_etag?: string;
  commit?: string;
  converted?: string[];
  removed?: string[];
  error?: string;
  // Failure detail (#774). The converter now reports these on EVERY callback,
  // including a total failure (status='failed') which previously sent none.
  errors?: number; // recordings that failed this run (0 = clean)
  failed?: string[]; // their source paths
  failure_count?: number; // subset that are TYPED data failures
  // Entries are `{path, code, reason}` as the converter writes them, but nothing
  // here reads a field off one: only the LENGTH is used (the per-entry detail
  // lives in the published index, see `zarrFailureColumns`). Typed as `unknown[]`
  // to match the validator, which checks the array and not the element shape --
  // an element interface here would be a compile-time claim about a cron's JSON
  // that nothing validates and nothing needs.
  data_failures?: unknown[];
  deterministic?: boolean; // all failures are typed data failures (won't retry)
  // Memory-robustness telemetry (epic #1108). Declared here because an
  // undeclared field is silently dropped by this handler's typed read -- the
  // converter was reporting these and nothing was listening.
  pool_breaks?: number; // worker-pool breaks RECOVERED this run; 0 is healthy
  measured_count?: number; // recordings whose peak RAM was actually measured
  calibration?: unknown[]; // per-format measured-vs-projected peak RAM
  // Coverage (#1197, index format v3). `pending_count` is recordings with no
  // store that the converter still expects to convert -- before v3 they were in
  // no published list at all and nothing retried them; `discovered_count` is the
  // raw recordings the walker found, i.e. the denominator that makes "2 of 43"
  // sayable. Both ride in the existing bounded `zarr_data_failures` summary
  // rather than getting columns of their own (ADR 0034: `datasets` stays one
  // table under a column budget; ADR 0036: operational rows carry counts and
  // pointers, not per-file lists).
  pending_count?: number;
  discovered_count?: number;
  /** The subset of `pending_count` never attempted (re-queued without a round). */
  not_attempted_count?: number;
  /** Carried-over stores dropped as non-raw (ADR 0027); operational only. */
  non_raw_dropped?: number;
  /** The catalog read failed, so this wave's provenance nulls are about the run. */
  provenance_fetch_failed?: boolean;
  /** index.json published but manifest.json was not. */
  manifest_upload_failed?: boolean;
  /**
   * Rows in the `<id>/zarr/events.parquet` this run published, or null when it
   * published none (issue #1060). Null covers three cases the converter's own
   * log distinguishes -- the dataset has no events, the node's venv has no
   * pyarrow, or the build/upload failed -- so `events_upload_failed` separates
   * the last one: "no events" and "we could not say what the events are" must
   * not read the same from here.
   *
   * Reported, not persisted. The row count belongs to the published index
   * (`events_row_count`), which is where a consumer reads it; a column here
   * would spend the `datasets` column budget (ADR 0034) on a number that is
   * already served, and the events file has no failure history to summarize the
   * way `zarr_data_failures` does.
   */
  events_row_count?: number | null;
  events_upload_failed?: boolean;
  /**
   * Stores whose events.tsv produced no rows: every onset failed to parse, or
   * the store has no channel group to anchor a sample index to. Each is a
   * per-store `::warning::` on the node; this count is the only off-node
   * signal, and 0 is healthy. Reported, not persisted, for the same reason as
   * `events_row_count`.
   */
  events_stores_without_rows?: number;
}

/**
 * Derive the Zarr failure-tracking columns persisted by /webhooks/zarr-ready
 * (#774). A 'ready' run can still be PARTIAL (errors>0 while the index has the
 * stores that converted); a 'failed' run is a total failure. `hadErrors` drives
 * `zarr_failed_at`, so a clean run clears the failure detail and the dashboard
 * can sort/filter recent failures. Defensive against missing/garbage fields so
 * the always-200 callback contract holds.
 *
 * `dataFailuresJson` is a bounded summary -- an entry count plus a pointer --
 * never the entries themselves (#1189). This column used to store the full
 * sanitized `data_failures` array (largest production row: 877 entries,
 * 178 KB), which pushed `datasets` rows past D1's ~100 KB statement limit in
 * the single-INSERT-per-row backup and made it unrestorable (#1188). The
 * per-entry detail (path/code/reason) is owned by the published Zarr index's
 * `failures` list at `<dataset>/zarr/index.json` in the serving bucket
 * (scripts/zarr/generate_zarr.py writes it; purge_non_raw_stores.py rewrites
 * it), which is what `detail_ref` names.
 */
export function zarrFailureColumns(body: {
  errors?: number;
  failure_count?: number;
  deterministic?: boolean;
  data_failures?: unknown;
  pending_count?: number;
  discovered_count?: number;
  events_upload_failed?: boolean;
  manifest_upload_failed?: boolean;
}): {
  errors: number;
  failureCount: number;
  deterministic: 0 | 1;
  dataFailuresJson: string | null;
  hadErrors: boolean;
} {
  const errors =
    typeof body.errors === "number" && Number.isFinite(body.errors)
      ? Math.max(0, Math.trunc(body.errors))
      : 0;
  const dataFailures = Array.isArray(body.data_failures) ? body.data_failures : [];
  const rawFailureCount =
    typeof body.failure_count === "number" && Number.isFinite(body.failure_count)
      ? Math.max(0, Math.trunc(body.failure_count))
      : dataFailures.length;
  // Typed data failures are a SUBSET of total errors; clamp so a converter bug
  // (or a missing failure_count) can never render "3 data failures of 1 error".
  const failureCount = Math.min(rawFailureCount, errors);
  const nonNegative = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  const pending = nonNegative(body.pending_count);
  const discovered = nonNegative(body.discovered_count);
  // A sibling document the converter could not publish leaves the serving copy
  // internally inconsistent until the next run, and until now the ONLY trace of
  // that off-node was a console.warn in the Worker log -- unqueryable, and gone
  // with the log. These are the same additive-key treatment as pending/
  // discovered (ADR 0034: no new column for a fact the bounded summary can
  // carry), and they are written ONLY when true: a later run that publishes both
  // siblings reports them false, the keys are then absent, and the row stops
  // claiming a condition that has cleared.
  const eventsUploadFailed = body.events_upload_failed === true;
  const manifestUploadFailed = body.manifest_upload_failed === true;
  // The summary is written when there is anything to say -- a failure list, OR
  // pending recordings with no failures at all, which is precisely the
  // pending-with-no-failures shape of on008083 (#1197) that used to leave the
  // column NULL and the recordings invisible. `count` alone kept that case
  // silent. An unpublished sibling is also something to say: a run with no
  // failures and no pending recordings that published index.json without its
  // manifest is not a clean run.
  const hasSummary =
    dataFailures.length > 0 || (pending ?? 0) > 0 || eventsUploadFailed || manifestUploadFailed;
  return {
    errors,
    failureCount,
    deterministic: body.deterministic === true ? 1 : 0,
    // `count` is the reported entry count of the index's failures list,
    // deliberately unclamped -- the clamped display count is the separate
    // zarr_failure_count column (failureCount above). Row size is now
    // independent of how many recordings failed.
    //
    // `pending`/`discovered` are additive keys on the same bounded object
    // (#1191 announced the array -> {count, detail_ref} change; adding keys to
    // that object is not a further break, and a consumer reading `count` is
    // unaffected). They are counts, never lists: the per-recording detail lives
    // in the published index that `detail_ref` names.
    dataFailuresJson: hasSummary
      ? JSON.stringify({
          count: dataFailures.length,
          detail_ref: "zarr/index.json",
          ...(pending === null ? {} : { pending }),
          ...(discovered === null ? {} : { discovered }),
          ...(eventsUploadFailed ? { events_upload_failed: true } : {}),
          ...(manifestUploadFailed ? { manifest_upload_failed: true } : {}),
        })
      : null,
    hadErrors: errors > 0,
  };
}

/**
 * Wire shape of the callback body, validated rather than trusted.
 *
 * The handler used to read fields off an `as ZarrReadyBody` cast, which is a
 * compile-time fiction: the body is JSON from a cron on another host. A field
 * arriving as the wrong type reached D1 as-is (`.bind()` accepts anything) or
 * threw inside the handler and returned 500 -- and a 500 here is the worst
 * outcome available, because the driver's POST is fire-and-forget, so the state
 * is simply lost and the row keeps whatever it had.
 *
 * `.catch(undefined)` per optional field is the point: ONE malformed field is
 * dropped and logged, and everything else in the body is still recorded. Failing
 * the whole callback over, say, a non-numeric `pool_breaks` would discard the
 * store count and the commit along with it. `passthrough()` keeps unknown fields
 * out of the way rather than rejecting them, so a newer converter that sends a
 * field this backend has not learned yet still gets its known fields persisted.
 */
/**
 * Every number in this body is a COUNT -- of stores, recordings, failures, event
 * rows -- so `.int()` is part of the type, not a nicety. Without it a fractional
 * `store_count` validated cleanly and was bound straight into D1, where the
 * column is declared INTEGER (`shared/contract/dataset.ts` says `.int()` too):
 * SQLite stores the REAL as given and every consumer that reads "2.7 stores"
 * inherits a number no counting could have produced. `.catch(undefined)` then
 * makes a fractional value behave like any other malformed field -- dropped,
 * logged by `parseZarrReadyBody`, and the rest of the body still persisted --
 * rather than silently truncated to a value the producer never sent.
 */
const count = z.number().int().finite().nonnegative();
const zarrReadyBodySchema = z
  .object({
    dataset_id: z.string(),
    status: z.enum(["ready", "failed", "converting"]).optional().catch(undefined),
    store_count: count.optional().catch(undefined),
    index_etag: z.string().optional().catch(undefined),
    commit: z.string().optional().catch(undefined),
    converted: z.array(z.string()).optional().catch(undefined),
    removed: z.array(z.string()).optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    errors: count.optional().catch(undefined),
    failed: z.array(z.string()).optional().catch(undefined),
    failure_count: count.optional().catch(undefined),
    data_failures: z.array(z.unknown()).optional().catch(undefined),
    deterministic: z.boolean().optional().catch(undefined),
    pool_breaks: count.optional().catch(undefined),
    measured_count: count.optional().catch(undefined),
    calibration: z.array(z.unknown()).optional().catch(undefined),
    pending_count: count.optional().catch(undefined),
    discovered_count: count.optional().catch(undefined),
    not_attempted_count: count.optional().catch(undefined),
    non_raw_dropped: count.optional().catch(undefined),
    provenance_fetch_failed: z.boolean().optional().catch(undefined),
    manifest_upload_failed: z.boolean().optional().catch(undefined),
    // `nullable` rather than optional-only: the converter sends null when it
    // published no events file, and the reason it published none is what
    // `events_upload_failed` separates (issue #1060).
    events_row_count: count.nullable().optional().catch(undefined),
    events_upload_failed: z.boolean().optional().catch(undefined),
    events_stores_without_rows: count.optional().catch(undefined),
  })
  .passthrough();

/**
 * Validate a parsed callback body, logging every field the producer sent in a
 * shape this backend cannot use. Returns null only when `dataset_id` itself is
 * unusable -- the one field with no sensible default, since it is what the
 * UPDATE keys on.
 */
export function parseZarrReadyBody(raw: unknown): ZarrReadyBody | null {
  const result = zarrReadyBodySchema.safeParse(raw);
  if (!result.success) {
    console.warn(
      `[zarr-ready] unusable body: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    return null;
  }
  // `.catch(undefined)` swallows per-field failures silently, so re-derive which
  // declared fields the producer sent and this backend then dropped. Without
  // this, a converter that starts sending `pool_breaks` as a string looks
  // exactly like one that stopped sending it.
  const source = raw as Record<string, unknown>;
  const dropped = Object.keys(zarrReadyBodySchema.shape).filter(
    (key) =>
      source[key] !== undefined && (result.data as Record<string, unknown>)[key] === undefined,
  );
  if (dropped.length > 0) {
    console.warn(
      `[zarr-ready] dropped malformed field(s) for dataset=${String(source.dataset_id)}: ${dropped.join(", ")}`,
    );
  }
  return result.data as ZarrReadyBody;
}

export function registerZarrReadyRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/zarr-ready", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
    if (!expectedToken) {
      console.error(
        "[zarr-ready] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
      );
      return c.json({ error: "Invalid webhook token" }, 401);
    }
    if (!token || !timingSafeEqual(token, expectedToken)) {
      return c.json({ error: "Invalid webhook token" }, 401);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const parsedBody = parseZarrReadyBody(raw);
    if (!parsedBody) {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const body: ZarrReadyBody = parsedBody;

    if (typeof body.dataset_id !== "string" || !isValidDatasetId(body.dataset_id)) {
      return c.json({ error: "dataset_id must be a valid dataset id" }, 400);
    }
    const status =
      body.status === "failed" ? "failed" : body.status === "converting" ? "converting" : "ready";

    // Persist latest-only conversion state. On failure keep the prior
    // store_count/etag/commit (a failed rebuild shouldn't erase the last good
    // copy's bookkeeping) and only flip the status + stamp converted_at.
    // Failure detail for the observability dashboard (#774). Recorded on BOTH
    // terminal branches: a 'ready' run can be partial (some recordings failed) and
    // a 'failed' run is a total failure. `zarr_failed_at` is stamped only when this
    // run had errors, so a clean run clears the detail.
    const f = zarrFailureColumns(body);
    let changed = 0;
    try {
      if (status === "converting") {
        // In-progress signal (#774): the Hallu driver POSTs this when it starts a
        // dataset so the dashboard "Processing" tile reflects live conversions.
        // Mark zarr_status='pending' (the dashboard's processing state) and clear
        // any prior failure detail -- this is a fresh attempt in flight. Leave the
        // last-good store_count/etag/commit untouched. A terminal ready/failed
        // callback overwrites this when the conversion finishes.
        const result = await c.env.DB.prepare(
          `UPDATE datasets
           SET zarr_status = 'pending',
               zarr_errors = NULL,
               zarr_failure_count = NULL,
               zarr_deterministic = NULL,
               zarr_data_failures = NULL,
               zarr_failed_at = NULL
           WHERE dataset_id = ?`,
        )
          .bind(body.dataset_id)
          .run();
        changed = result.meta.changes ?? 0;
      } else if (status === "ready") {
        // recording_stats_at -> NULL (epic #1144 Phase 2, issue #1146): a
        // reconverted index may carry different duration/count/channel
        // facts, so this dataset must be re-picked by the next
        // recording-stats-sweep. Nulled on THIS branch only -- the 'failed'
        // branch below leaves it (and every stat column) untouched, because
        // a bad rebuild must never erase good numbers already computed from
        // the last good index.
        const result = await c.env.DB.prepare(
          `UPDATE datasets
           SET zarr_status = 'ready',
               zarr_converted_at = datetime('now'),
               zarr_store_count = ?,
               zarr_index_etag = ?,
               zarr_source_commit = ?,
               zarr_errors = ?,
               zarr_failure_count = ?,
               zarr_deterministic = ?,
               zarr_data_failures = ?,
               zarr_pool_breaks = ?,
               zarr_failed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
               sweep_stamps = json_remove(sweep_stamps, '$.recording_stats_at')
           WHERE dataset_id = ?`,
        )
          .bind(
            typeof body.store_count === "number" ? body.store_count : null,
            body.index_etag ?? null,
            body.commit ?? null,
            f.errors,
            f.failureCount,
            f.deterministic,
            f.dataFailuresJson,
            typeof body.pool_breaks === "number" ? body.pool_breaks : null,
            f.hadErrors ? 1 : 0,
            body.dataset_id,
          )
          .run();
        changed = result.meta.changes ?? 0;
      } else {
        // Record failure for the observability dashboard only -- do NOT auto-retry
        // zarr here. Conversion is owned by the hourly Hallu cron (workflow
        // autodispatch is intentionally off), which re-attempts on its own
        // schedule; many zarr failures are the mixed-rate EDF/BDF reader bug
        // (#737) that a re-dispatch wouldn't fix. This is the deliberate contrast
        // with the archive-ready auto-retry (epic #736, Phase 3 decision). Keep
        // the prior store_count/etag/commit (a failed rebuild shouldn't erase the
        // last good copy's bookkeeping) and only flip status + the failure detail.
        // zarr_pool_breaks is recorded here too, not just on the ready path. The
        // driver sends it with either status, and a run that failed outright is
        // the STRONGEST node-pressure signal there is -- dropping it would leave
        // the column stale at the last successful run's value and defeat the
        // point of migration 0069 ("a node under sustained memory pressure looks
        // healthy until it isn't") in exactly the case it was added for.
        const result = await c.env.DB.prepare(
          `UPDATE datasets
           SET zarr_status = 'failed',
               zarr_errors = ?,
               zarr_failure_count = ?,
               zarr_deterministic = ?,
               zarr_data_failures = ?,
               zarr_pool_breaks = ?,
               zarr_failed_at = datetime('now')
           WHERE dataset_id = ?`,
        )
          .bind(
            f.errors,
            f.failureCount,
            f.deterministic,
            f.dataFailuresJson,
            typeof body.pool_breaks === "number" ? body.pool_breaks : null,
            body.dataset_id,
          )
          .run();
        changed = result.meta.changes ?? 0;
      }
    } catch (err) {
      console.error(
        `[zarr-ready] D1 update failed dataset=${body.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: "Failed to record zarr state" }, 500);
    }

    // A callback for a dataset that isn't in D1 (deleted, or never registered)
    // matches zero rows and persists nothing. Surface it as a 404 instead of a
    // 200 that silently drops the state -- mirrors the prescreen-result
    // meta.changes guard. The workflow logs the 404 for an operator to chase.
    if (changed === 0) {
      console.error(`[zarr-ready] UPDATE matched 0 rows dataset=${body.dataset_id} -- not in D1`);
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Best-effort cache purge of the freshness-sensitive shared objects. Wrapped
    // so a malformed `converted` entry (a non-string would make `.trim()` throw)
    // can't break the always-200 contract; purgeCacheUrls itself never throws.
    let purge: Awaited<ReturnType<typeof purgeCacheUrls>> | undefined;
    if (status === "ready") {
      try {
        const targets = zarrPurgeTargets(c.env, body.dataset_id, body.converted ?? []);
        if (targets.length === 0 && !c.env.ZARR_CACHE_BASE_URL) {
          console.warn(
            `[zarr-ready] ZARR_CACHE_BASE_URL unset; cache purge skipped dataset=${body.dataset_id}`,
          );
        }
        purge = await purgeCacheUrls(c.env, targets);
        if (!purge.ok) {
          console.warn(
            `[zarr-ready] cache purge incomplete dataset=${body.dataset_id}: ${purge.detail ?? "unknown"}`,
          );
        }
      } catch (err) {
        console.warn(
          `[zarr-ready] cache purge threw dataset=${body.dataset_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // `not_attempted`, `non_raw_dropped` and `provenance_fetch_failed` are
    // persisted nowhere: the first is a subset of `pending` that the bounded
    // summary does not break out, the second is a per-run operational fact about
    // carried-over stores (ADR 0027), and the third says this wave's stores carry
    // null doi/license/citation/hed_version because the CATALOG READ failed, not
    // because the data lacks them -- which is the difference between "nothing to
    // publish" and "we could not find out". None has a column, so logging them
    // here is the only place any of them is visible to anyone not tailing the
    // conversion node's cron log -- the same reason `pending`/`discovered` are on
    // this line.
    console.log(
      `[zarr-ready] dataset=${body.dataset_id} status=${status} stores=${body.store_count ?? "?"} converted=${body.converted?.length ?? 0} removed=${body.removed?.length ?? 0} purged=${purge?.submitted ?? 0} pool_breaks=${body.pool_breaks ?? "?"} pending=${body.pending_count ?? "?"} discovered=${body.discovered_count ?? "?"} not_attempted=${body.not_attempted_count ?? "?"} non_raw_dropped=${body.non_raw_dropped ?? "?"} provenance_fetch_failed=${body.provenance_fetch_failed ?? "?"} events_rows=${body.events_row_count ?? "none"} events_upload_failed=${body.events_upload_failed ?? false} manifest_upload_failed=${body.manifest_upload_failed ?? false} events_stores_without_rows=${body.events_stores_without_rows ?? "?"}`,
    );

    // A store that has an events.tsv but contributed no rows is data the
    // consumer cannot see is missing: the file simply has no rows for that
    // store. The node logs which stores; this is where the count reaches
    // anyone else.
    if ((body.events_stores_without_rows ?? 0) > 0) {
      console.warn(
        `[zarr-ready] dataset=${body.dataset_id} ${body.events_stores_without_rows} store(s) with an events.tsv produced no event rows (unparseable onsets or no channel group); see the conversion log for which`,
      );
    }

    // A sibling document the converter could not publish leaves the serving copy
    // internally inconsistent until the next run: manifest.json and index.json
    // then disagree about which stores exist, and a missing events.parquet makes
    // a dataset with events indistinguishable from one without. Neither fails
    // the conversion (ADR 0005), and neither has a column -- so this warn is the
    // only place the condition is visible to anyone not tailing the cron log.
    if (body.events_upload_failed || body.manifest_upload_failed) {
      const which = [
        ...(body.events_upload_failed ? ["events.parquet"] : []),
        ...(body.manifest_upload_failed ? ["manifest.json"] : []),
      ].join(" + ");
      console.warn(
        `[zarr-ready] dataset=${body.dataset_id} published index.json WITHOUT ${which}; the next conversion republishes it`,
      );
    }

    // Peak-RAM calibration (#1111) is diagnostic rather than dashboard material,
    // so it is logged rather than given a column -- but it is logged HERE, on the
    // Worker, instead of only in a cron log on one box nobody tails. Only when
    // there is something to say.
    if (body.pool_breaks || (body.calibration?.length ?? 0) > 0) {
      console.log(
        `[zarr-ready] dataset=${body.dataset_id} memory: pool_breaks=${body.pool_breaks ?? 0} measured=${body.measured_count ?? 0} calibration=${JSON.stringify(body.calibration ?? [])}`,
      );
    }

    return c.json({
      ok: true,
      dataset_id: body.dataset_id,
      status,
      ...(purge ? { cache_purge: { ok: purge.ok, submitted: purge.submitted } } : {}),
    });
  });
}
