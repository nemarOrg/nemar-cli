/**
 * `nemar admin upstream-status`: which OpenNeuro mirrors are behind upstream (epic #1046 phase 4b,
 * #1910; ADR 0111, Phase 4a amendment).
 *
 *   nemar admin upstream-status                 every managed mirror, page after page
 *   nemar admin upstream-status --dataset on003645
 *   nemar admin upstream-status --json          the same, as one JSON document
 *
 * READ-ONLY: it calls `GET /admin/upstream-status`, which writes nothing. The pages are walked
 * here and added up by `lib/upstream-status-report.ts` from the rows, not from the pages' counts.
 *
 * EXIT CODES. 0: no row was unchecked and no page failed, whatever the stale count (stale is a
 * finding, not a failure). 0 is NOT "the fleet is clean": unknown-tag and never-examined rows were
 * not compared and still exit 0. 1: a request failed. 2: the pass could not see: any `unchecked` row,
 * any refused (502) page, any page with `errors[]`, `--max-pages` reached, or the population
 * changed while it ran. A 200 does not prove every mirror was compared, so a 200 that carries
 * `errors[]` or `unchecked` rows is a 2 as well.
 */

import chalk from "chalk";
import { Command } from "commander";
import type { UpstreamStatusPage } from "../../shared/upstream-staleness.js";
import { upstreamStatus } from "../lib/api/admin.js";
import { errorDetail } from "../lib/api/errors.js";
import { requireAuth } from "../lib/cli-output.js";
import { markReportedExit } from "../lib/debug-log.js";
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
  .option("--list <n>", "Rows printed per state", "50")
  .option("--json", "Output one JSON document instead of the report")
  .action(
    async (options: {
      limit?: string;
      after?: string;
      dataset?: string;
      maxPages?: string;
      list?: string;
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
