/**
 * `nemar admin upstream-status`: which OpenNeuro mirrors are behind upstream (epic #1046 phase 4b,
 * #1910; ADR 0111, Phase 4a amendment).
 *
 *   nemar admin upstream-status                 every managed mirror, page after page
 *   nemar admin upstream-status --dataset on003645
 *   nemar admin upstream-status --json          the same, as one JSON document
 *   nemar admin upstream-status --measure       also read what a re-pull of each stale mirror would carry
 *
 * READ-ONLY: it calls `GET /admin/upstream-status`, which writes nothing. The pages are walked
 * here and added up by `lib/upstream-status-report.ts` from the rows, not from the pages' counts.
 * With `--measure` it also POSTs read-only GraphQL queries to OpenNeuro from this machine; it still
 * writes nothing, to NEMAR or to OpenNeuro.
 *
 * EXIT CODES. 0: no row was unchecked and no page failed, whatever the stale count (stale is a
 * finding, not a failure). 0 is NOT "the fleet is clean": unknown-tag and never-examined rows were
 * not compared and still exit 0. 1: a request failed. 2: the pass could not see: any `unchecked` row,
 * any refused (502) page, any page with `errors[]`, `--max-pages` reached, or the population
 * changed while it ran. A 200 does not prove every mirror was compared, so a 200 that carries
 * `errors[]` or `unchecked` rows is a 2 as well.
 *
 * `--measure` (Phase 4c, ADR 0111) reads OpenNeuro's file listings from THIS machine for each stale
 * mirror and adds up what a re-pull would carry (`lib/upstream-measure.ts`). It measures only a
 * COMPLETE pass (no thrown request, no refused page, no `--max-pages` stop, no population change,
 * no `unchecked` row, no `errors[]`: `summary.complete`); otherwise the stale set may be partial,
 * `measurement` is null with the reason, and the exit code is the pass's own (1 or 2). A delta that
 * could not be read is a 2 as well, and an unknown is never a zero. `NEMAR_OPENNEURO_GRAPHQL_URL`
 * moves the OpenNeuro endpoint (for tests).
 */

import chalk from "chalk";
import { Command } from "commander";
import type { UpstreamStatusPage } from "../../shared/upstream-staleness.js";
import { upstreamStatus } from "../lib/api/admin.js";
import { errorDetail } from "../lib/api/errors.js";
import { requireAuth } from "../lib/cli-output.js";
import { markReportedExit } from "../lib/debug-log.js";
import {
  type Measurement,
  measureStaleMirrors,
  renderMeasurement,
} from "../lib/upstream-measure.js";
import {
  type PassScope,
  exitCodeOf,
  renderReport,
  summarizePass,
} from "../lib/upstream-status-report.js";

const PAGE_PAUSE_MS = 250;
const DATASET_RE = /^on\d{6}$/;

/** A positive integer, or null when the text is anything else. */
function positiveInt(text: string | undefined, fallback: number): number | null {
  if (text === undefined) return fallback;
  return /^[0-9]+$/.test(text) && Number.parseInt(text, 10) >= 1 ? Number.parseInt(text, 10) : null;
}

export const upstreamStatusCommand = new Command("upstream-status")
  .description("Report which OpenNeuro mirrors are behind upstream (read-only)")
  .option("--limit <n>", "Mirrors per page (values above 100 are capped to 100)", "100")
  .option("--after <id>", "Resume after this dataset id, e.g. on000123")
  .option("--dataset <id>", "Examine only this mirror, e.g. on003645")
  .option("--max-pages <n>", "Stop after this many pages", "50")
  .option(
    "--list <n>",
    "Rows printed per state, and per-mirror measurement lines with --measure",
    "50",
  )
  .option(
    "--measure",
    "Also read OpenNeuro's file listings from this machine and total what a re-pull of each stale mirror would carry (only after a complete pass; a delta that cannot be read leaves the byte total unknown and exits 2)",
  )
  .option(
    "--measure-limit <n>",
    "With --measure, measure at most this many stale mirrors (the rest are not measured, so the byte total is unknown, shown as at least)",
  )
  .option("--json", "Output one JSON document instead of the report")
  .action(
    async (options: {
      limit?: string;
      after?: string;
      dataset?: string;
      maxPages?: string;
      list?: string;
      measure?: boolean;
      measureLimit?: string;
      json?: boolean;
    }) => {
      requireAuth();
      const fail = (message: string): never => {
        console.error(chalk.red(message));
        process.exit(1);
      };
      const limit = positiveInt(options.limit, 100);
      const maxPages = positiveInt(options.maxPages, 50);
      const list = positiveInt(options.list, 50);
      if (limit === null) fail("--limit must be a positive integer");
      if (maxPages === null) fail("--max-pages must be a positive integer");
      if (list === null) fail("--list must be a positive integer");
      const measureLimit =
        options.measureLimit === undefined ? undefined : positiveInt(options.measureLimit, 1);
      if (measureLimit === null) fail("--measure-limit must be a positive integer");
      if (options.measureLimit !== undefined && !options.measure) {
        fail("--measure-limit needs --measure");
      }
      if (options.dataset !== undefined && !DATASET_RE.test(options.dataset)) {
        fail("--dataset must look like on003645");
      }
      if (options.after !== undefined && !DATASET_RE.test(options.after)) {
        fail("--after must look like on000123");
      }
      if (options.dataset !== undefined && options.after !== undefined) {
        fail("--dataset and --after cannot be combined");
      }
      const scope: PassScope = options.dataset ? "dataset" : options.after ? "after" : "fleet";

      const pages: UpstreamStatusPage[] = [];
      let cursor = options.after;
      let failure: string | null = null;
      let maxPagesReached = false;
      let stoppedAtRefusal = false;
      for (let n = 0; n < (maxPages as number); n++) {
        let page: UpstreamStatusPage;
        try {
          page = await upstreamStatus({
            limit: limit as number,
            after: cursor,
            dataset: options.dataset,
          });
        } catch (err) {
          failure = errorDetail(err);
          break;
        }
        pages.push(page);
        if (!page.ok) {
          stoppedAtRefusal = true;
          break;
        }
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
        if (n === (maxPages as number) - 1) maxPagesReached = true;
        else await new Promise((resolve) => setTimeout(resolve, PAGE_PAUSE_MS));
      }

      const summary = summarizePass({ pages, scope, maxPagesReached, stoppedAtRefusal });

      // Only a complete pass is measured: after a thrown request, a refused page, a --max-pages stop,
      // a population change, an unchecked row or an errors[] entry the stale set may be partial,
      // and totaling a part of the fleet would read as the whole.
      let measurement: Measurement | null = null;
      let measurementSkipped: string | null = null;
      if (options.measure && failure === null && !summary.complete) {
        measurementSkipped = "the pass did not finish cleanly, so the stale set may be partial";
      } else if (options.measure && failure !== null) {
        measurementSkipped = "the pass failed before it finished";
      }
      if (options.measure && measurementSkipped === null) {
        measurement = await measureStaleMirrors(summary.rows, {
          limit: measureLimit ?? undefined,
          graphqlUrl: process.env.NEMAR_OPENNEURO_GRAPHQL_URL,
          scope,
          onProgress: (line) => console.error(line),
        });
        // A delta that could not be read is a pass that could not see: exit 2, never a zero.
        if (measurement.totals.delta_unknown > 0) {
          summary.could_not_see.push(
            `${measurement.totals.delta_unknown} stale mirror(s) had a delta that could not be read from OpenNeuro`,
          );
          summary.complete = false;
        }
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              examined: summary.examined,
              population: summary.population,
              counts: summary.counts,
              rows: summary.rows,
              errors: summary.errors,
              complete: summary.complete,
              could_not_see: summary.could_not_see,
              ...(options.measure ? { measurement, measurement_skipped: measurementSkipped } : {}),
              failure,
            },
            null,
            2,
          ),
        );
      } else {
        // After a failed first read there is nothing to report: a table of zeros would be a
        // definite-looking claim about a fleet that was never read.
        if (pages.length > 0) {
          for (const line of renderReport(summary, list as number)) console.log(line);
        }
        if (failure) console.error(chalk.red(`Stopped: ${failure}`));
        if (measurementSkipped !== null) {
          console.log("");
          console.log(chalk.yellow(`Not measured: ${measurementSkipped}.`));
        }
        if (measurement !== null) {
          console.log("");
          for (const line of renderMeasurement(measurement, list as number)) console.log(line);
        }
        if (summary.could_not_see.length > 0) {
          console.log("");
          console.log(chalk.yellow("The pass could not see everything:"));
          for (const why of summary.could_not_see) console.log(chalk.yellow(`  ${why}`));
        }
      }

      if (failure !== null) process.exit(1);
      const code = exitCodeOf(summary);
      if (code === 2) {
        markReportedExit();
        process.exit(2);
      }
    },
  );
