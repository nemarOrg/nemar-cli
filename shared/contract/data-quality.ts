/**
 * The rules of neuroschema 0.6.0 `dataQuality` that JSON Schema cannot state, declared once for the
 * backend (ADR 0137 decision 8 and its amendment of 2026-11-24, epic #2324 phase B1) and for a renderer
 * that copies this file: the size and count caps, the words a run gives for a view it skipped, the
 * metric-name rule, and `nemar.record-checks.v1`, the cross-field rules of a recording's entry.
 *
 * `shared/contract/neuroschema/views/vectors/record-checks.v1.json` holds the cases every implementation
 * of the record checks reproduces (neuroschema `docs/processing-extensions.md`, Record checks);
 * `test/quality-documents-contract.unit.test.ts` replays them.
 *
 * Pure and import-free: nothing here reads a clock, a database or a network.
 */

/** The largest dataset `dataQuality` document a recipe writes, in bytes (nemar-process `dataquality.MAX_BYTES`). */
export const DATA_QUALITY_MAX_BYTES = 65_536;

/** The most recordings a dataset summary lists in `not_processed` (neuroschema `maxItems`). */
export const NOT_PROCESSED_MAX = 200;

/** The most views, and the most skipped views, of one recording's entry (neuroschema `maxItems`). */
export const DATA_QUALITY_VIEWS_MAX = 32;

/** The largest integer every JSON reader holds exactly (I-JSON, RFC 7493): the cap of every integer. */
export const JSON_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/** The copy each input's quality describes: a dataset directory is the archive, the Zarr input the serving copy. */
export const PROFILE_OF_INPUT = Object.freeze({ bids: "archive", zarr: "serving" } as const);

/**
 * The words neuroschema's `docs/views.md` gives for a view a run did not write for a recording. The
 * schema admits any `failureCode` word beside them, which a renderer shows as it is.
 *
 * Documentation a contract test holds, not a validation allowlist: the backend admits any
 * `failureCode` word in `views_skipped`, and nothing outside the test reads this list.
 */
export const VIEWS_SKIPPED_NEUROSCHEMA_WORDS = [
  "labels_unusable",
  "plugin_failed",
  "step_failed",
  "step_skipped",
  "cap_exceeded",
] as const;

/**
 * The words nemar-process adds for its own views (`OWN_SKIP_REASONS` in `recipes/nemar_process/common/
 * views.py`, nemar-cli #2341): no two-second window of good samples, the three ways a run of the archive
 * finds no row of the serving index, and an index it was handed but cannot use (`serving_index_unusable`,
 * ADR 0141). A plugin's view can be skipped with `cap_exceeded` while its plugin ran. `frame_rotated` is
 * gone since nemar-process#101: eegprep now orients the CTF, 4DBti and KitYokogawa frames, and a nemar-ica
 * recording whose frame it cannot orient fails (detail `iclabel_frame_unoriented`) rather than skipping a view.
 *
 * Like `VIEWS_SKIPPED_NEUROSCHEMA_WORDS`, documentation a contract test holds, not a validation
 * allowlist: a word missing here is still admitted.
 */
export const VIEWS_SKIPPED_NEMAR_PROCESS_WORDS = [
  "no_good_window",
  "no_serving_index",
  "not_in_serving_index",
  "serving_index_stale",
  "serving_index_unusable",
] as const;

/** The plugin a metric name names (`<plugin>:<name>`), or null for a recipe's bare name. */
export function metricPlugin(name: string): string | null {
  const at = name.indexOf(":");
  return at < 0 ? null : name.slice(0, at);
}

/**
 * The first metric name that a recipe may not report, or null: a bare name is the recipe's own, and a
 * `<plugin>:<name>` must name one of the plugins the recipe runs at its `quality` checkpoint (`plugins`).
 */
export function metricNameOutsideRecipe(
  names: Iterable<string>,
  plugins: readonly string[],
): string | null {
  for (const name of names) {
    const plugin = metricPlugin(name);
    if (plugin !== null && !plugins.includes(plugin)) return name;
  }
  return null;
}

/** The words of `nemar.record-checks.v1`. */
export const RECORD_CHECK_WORDS = [
  "metric_producer_mismatch",
  "view_source_mismatch",
  "view_key_repeated",
] as const;
export type RecordCheckWord = (typeof RECORD_CHECK_WORDS)[number];

/** One finding: its word, and where, as a slash path inside the entry. */
export interface RecordFinding {
  word: RecordCheckWord;
  at: string;
}

const objectOf = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const arrayOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * `nemar.record-checks.v1` (neuroschema `records.check_record`): the findings of one recording's entry
 * for the recipe it is keyed by, in document order, the metrics first, then the views, then the views
 * skipped. An empty list passes; any finding refuses the entry, since a view or a metric credited to the
 * wrong producer would mislead.
 *
 * - `metric_producer_mismatch`: a metric `<plugin>:<name>` whose producer is another plugin, or a bare
 *   metric whose producer recipe is not the entry's recipe;
 * - `view_source_mismatch`: a view whose `source` is a recipe other than the entry's (a plugin's view is
 *   the plugin's, and is not checked here);
 * - `view_key_repeated`: a view key an earlier view has, or a key of `views_skipped` that repeats or names
 *   a view the entry declares.
 */
export function recordChecks(recipeId: string, entry: unknown): RecordFinding[] {
  const e = objectOf(entry) ?? {};
  const findings: RecordFinding[] = [];
  for (const [name, metric] of Object.entries(objectOf(e.metrics) ?? {})) {
    const m = objectOf(metric) ?? {};
    const plugin = metricPlugin(name);
    const producer =
      plugin === null ? objectOf(m.recipe)?.name : (objectOf(m.plugin)?.name as unknown);
    if (producer !== (plugin ?? recipeId)) {
      findings.push({ word: "metric_producer_mismatch", at: `metrics/${name}` });
    }
  }
  const keys = new Set<unknown>();
  arrayOf(e.views).forEach((view, index) => {
    const v = objectOf(view) ?? {};
    const recipe = objectOf(objectOf(v.source)?.recipe);
    if (recipe !== null && recipe.name !== recipeId) {
      findings.push({ word: "view_source_mismatch", at: `views/${index}/source` });
    }
    if (keys.has(v.key)) findings.push({ word: "view_key_repeated", at: `views/${index}/key` });
    keys.add(v.key);
  });
  arrayOf(e.views_skipped).forEach((skipped, index) => {
    const key = objectOf(skipped)?.key;
    if (keys.has(key)) {
      findings.push({ word: "view_key_repeated", at: `views_skipped/${index}/key` });
    }
    keys.add(key);
  });
  return findings;
}
