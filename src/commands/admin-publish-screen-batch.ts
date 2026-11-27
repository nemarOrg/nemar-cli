/**
 * `nemar admin dataset publish screen-batch`: re-screen many publication requests in one paced batch
 * (epic #2182, card D4; ADR 0086, amendment of 2026-11-25).
 *
 *   nemar admin dataset publish screen-batch [--ids <file> | --status <requested|blocked> | --all-active]
 *                                         [--per-minute <n>] [--apply]
 *
 * A dry run by default: it prints the selection and sends nothing. With `--apply` it creates the
 * batch and dispatches the screens itself, one at a time, `--per-minute` apart (each is a GitHub
 * Actions run). The batch sends no per-request mail to the administrators and none to the
 * depositors; one digest goes to the administrators when it ends. Ctrl-C stops dispatching, and the
 * screens already started still report. The rules are `lib/screen-batch.ts`; this file is the
 * terminal around them.
 */

import { readFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import {
  closeScreenBatch,
  createScreenBatch,
  listPublishRequests,
  rerunIdentifierScreen,
} from "../lib/api/publish.js";
import { markReportedExit } from "../lib/debug-log.js";
import {
  type DispatchResult,
  SCREEN_BATCH_DEFAULT_PER_MINUTE,
  SCREEN_BATCH_MAX_PER_MINUTE,
  SCREEN_BATCH_MAX_SIZE,
  dispatchFailure,
  paceGapMs,
  parseIdsFile,
  parsePerMinute,
  runBatch,
} from "../lib/screen-batch.js";
import { plain } from "../lib/terminal-text.js";

interface Options {
  ids?: string;
  status?: string;
  allActive?: boolean;
  perMinute?: string;
  apply?: boolean;
}

const BATCH_STATUSES = ["requested", "blocked"];
const ACTIVE = ["requested", "blocked", "approving"];

/** A second SIGINT inside this window is the same keypress delivered twice (Bun does that). */
const SIGINT_DEBOUNCE_MS = 500;

interface Selection {
  ids: string[];
  /** Ids asked for that have no open request (an `--ids` file can name any). */
  noOpenRequest: string[];
  /** Ids named (or active) whose request is being approved: left alone. */
  beingApproved: string[];
  rows: Map<string, { status: string; screen: string | null }>;
}

async function select(options: Options): Promise<Selection | null> {
  const chosen = [
    options.ids !== undefined,
    options.status !== undefined,
    options.allActive,
  ].filter(Boolean).length;
  if (chosen !== 1) {
    failMessage(
      "Choose one selection: --ids <file>, --status <requested|blocked> or --all-active.",
      {
        answered: true,
      },
    );
    return null;
  }
  let wanted: string[] | null = null;
  if (options.ids !== undefined) {
    let text: string;
    try {
      text = readFileSync(options.ids, "utf-8");
    } catch {
      failMessage(`Cannot read the --ids file ${plain(options.ids)}.`, { answered: true });
      return null;
    }
    const parsed = parseIdsFile(text);
    if (parsed.invalid.length > 0) {
      failMessage(
        `${parsed.invalid.length} entr${parsed.invalid.length === 1 ? "y" : "ies"} in the --ids file ${parsed.invalid.length === 1 ? "is" : "are"} not a dataset id (like nm000108); the first is on the line starting "${plain(parsed.invalid[0]).slice(0, 12)}". Nothing was sent.`,
        { answered: true },
      );
      return null;
    }
    if (parsed.ids.length === 0) {
      failMessage("The --ids file names no dataset.", { answered: true });
      return null;
    }
    wanted = parsed.ids;
  }
  if (options.status !== undefined && !BATCH_STATUSES.includes(options.status)) {
    failMessage(`--status takes ${BATCH_STATUSES.join(" or ")}; got "${plain(options.status)}".`, {
      answered: true,
    });
    return null;
  }

  const statuses = options.status !== undefined ? [options.status] : ACTIVE;
  const list = await listPublishRequests({ statuses });
  const rows = new Map<string, { status: string; screen: string | null }>();
  // A request being approved is never re-screened by a batch: its approval is running or waiting
  // on the screen it passed. Seen, named, and left out.
  const beingApprovedSet = new Set<string>();
  // Newest first, so the first row of a dataset is its active request.
  const seenIds = new Set<string>();
  for (const r of list.requests) {
    if (seenIds.has(r.dataset_id)) continue;
    seenIds.add(r.dataset_id);
    if (r.status === "approving") {
      beingApprovedSet.add(r.dataset_id);
      continue;
    }
    rows.set(r.dataset_id, {
      status: r.status,
      screen: r.identifier_screen ? plain(r.identifier_screen.headline) : null,
    });
  }
  const ids = wanted ?? [...rows.keys()];
  const beingApproved = wanted
    ? wanted.filter((id) => beingApprovedSet.has(id))
    : [...beingApprovedSet];
  const noOpenRequest = ids.filter((id) => !rows.has(id) && !beingApprovedSet.has(id));
  const open = ids.filter((id) => rows.has(id));
  if (open.length > SCREEN_BATCH_MAX_SIZE) {
    failMessage(
      `${open.length} requests selected; a batch holds at most ${SCREEN_BATCH_MAX_SIZE}. Narrow the selection (--status, or an --ids file). Nothing was sent.`,
      { answered: true },
    );
    return null;
  }
  return { ids: open, noOpenRequest, beingApproved, rows };
}

export function registerScreenBatchCommand(group: Command): void {
  group
    .command("screen-batch")
    .description(
      "Re-run the identifier screen of many publication requests, paced, with one digest",
    )
    .option("--ids <file>", "Dataset ids to screen, one per line (# starts a comment)")
    .option("--status <status>", "Screen every request in this status (requested or blocked)")
    .option(
      "--all-active",
      "Screen every request that is requested or blocked (one being approved is left alone)",
    )
    .option(
      "--per-minute <n>",
      `Screens dispatched per minute (default ${SCREEN_BATCH_DEFAULT_PER_MINUTE}, at most ${SCREEN_BATCH_MAX_PER_MINUTE})`,
    )
    .option("--apply", "Start the batch (without it, only the selection is printed)")
    .addHelpText(
      "after",
      `
Description:
  Re-run the identifier screen of many publication requests, one dispatch at a
  time. Each screen stores the same result a single 'screen' stores, and the gate
  and the automated review start as for a single screen. The batch sends no
  per-request mail to the administrators and no mail to the depositors; when it
  ends the administrators get ONE digest, which names the requests whose state
  changed, the requests the batch blocked (their depositors are not mailed), the
  requests that were already blocked (still blocked, with the new result), the
  requests that could not start or were refused, and the requests that did not report.

  Without --apply nothing is dispatched: the selection and its count are printed.
  With --apply the CLI dispatches the screens itself, --per-minute apart, because
  each is a GitHub Actions run. Ctrl-C stops dispatching; screens already started
  still report, and the digest follows them. A request that was blocked stays
  blocked after its screen, whatever the result, and its depositor is not mailed
  (neither is the depositor of a request the batch blocks; the digest names those).
  A request being approved is left alone.

  A report that arrives after the digest was sent is mailed to the administrators
  on its own, as for any single screen; one that arrives while the digest is being
  sent is named in it as not reported and is not mailed separately.

  The digest is sent when every request has reported, or two hours after the
  last dispatch, whichever comes first. A batch holds at most ${SCREEN_BATCH_MAX_SIZE} requests.

Examples:
  $ nemar admin dataset publish screen-batch --status requested
  $ nemar admin dataset publish screen-batch --ids stale.txt --per-minute 6 --apply`,
    )
    .action(async (options: Options) => {
      if (!requireSignedIn()) return;
      const perMinute = parsePerMinute(options.perMinute);
      if (typeof perMinute !== "number") {
        failMessage(perMinute.problem, { answered: true });
        return;
      }
      const spinner = ora("Reading the publication requests...").start();
      let selection: Selection | null;
      try {
        selection = await select(options);
      } catch (error) {
        failWith(error, spinner, "Failed to read the publication requests");
        return;
      }
      spinner.stop();
      if (!selection) return;

      const gapMs = paceGapMs(perMinute);
      printSelection(selection, perMinute, gapMs, options.apply === true);
      if (selection.ids.length === 0) {
        console.log(chalk.dim("Nothing to screen."));
        return;
      }
      if (!options.apply) {
        console.log(chalk.dim("Dry run: nothing was sent. Add --apply to start the batch."));
        return;
      }
      await applyBatch(selection, gapMs);
    });
}

function printSelection(
  selection: Selection,
  perMinute: number,
  gapMs: number,
  apply: boolean,
): void {
  console.log(
    `${apply ? "Re-screening" : "Would re-screen"} ${selection.ids.length} publication request${selection.ids.length === 1 ? "" : "s"}:`,
  );
  for (const id of selection.ids) {
    const row = selection.rows.get(id);
    console.log(`  ${id}  ${row?.status ?? ""}${row?.screen ? `  ${chalk.dim(row.screen)}` : ""}`);
  }
  if (selection.noOpenRequest.length > 0) {
    console.log(
      chalk.yellow(
        `${selection.noOpenRequest.length} named dataset${selection.noOpenRequest.length === 1 ? " has" : "s have"} no open request and ${selection.noOpenRequest.length === 1 ? "is" : "are"} left out: ${selection.noOpenRequest.map(plain).join(", ")}`,
      ),
    );
  }
  if (selection.beingApproved.length > 0) {
    console.log(
      chalk.yellow(
        `${selection.beingApproved.length} request${selection.beingApproved.length === 1 ? " is" : "s are"} being approved and left alone: ${selection.beingApproved.map(plain).join(", ")}`,
      ),
    );
  }
  const minutes = Math.ceil(((selection.ids.length - 1) * gapMs) / 60_000);
  console.log(
    chalk.dim(
      `Pace: ${perMinute} a minute; dispatching takes about ${Math.max(minutes, 0)} minute${minutes === 1 ? "" : "s"}.`,
    ),
  );
}

async function applyBatch(selection: Selection, gapMs: number): Promise<void> {
  const spinner = ora("Creating the batch...").start();
  let created: Awaited<ReturnType<typeof createScreenBatch>>;
  try {
    created = await createScreenBatch(selection.ids);
  } catch (error) {
    failWith(error, spinner, "Failed to create the batch");
    return;
  }
  spinner.succeed(`Batch ${created.batch_id} created for ${created.total} requests`);
  const skipped = new Set(created.skipped);
  if (skipped.size > 0) {
    console.log(
      chalk.yellow(
        `  Left out by the Worker (no open request, or a sandbox dataset, which is never screened): ${[...skipped].map(plain).join(", ")}`,
      ),
    );
  }
  const ids = selection.ids.filter((id) => !skipped.has(id));

  // Ctrl-C stops dispatching and lets the screens already started report. A second one, later than
  // the debounce, leaves at once; the digest then follows two hours after the last dispatch.
  let stopRequested = false;
  let lastSignalAt = 0;
  let wake: (() => void) | null = null;
  const onSigint = () => {
    const now = Date.now();
    if (!stopRequested) {
      stopRequested = true;
      lastSignalAt = now;
      console.log(
        chalk.yellow("\nStopping: no more screens will be dispatched; started ones still report."),
      );
      wake?.();
      return;
    }
    if (now - lastSignalAt < SIGINT_DEBOUNCE_MS) return;
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  const sleep = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (stopRequested) return resolve(true);
      const timer = setTimeout(() => {
        wake = null;
        resolve(false);
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve(true);
      };
    });

  let outcome: Awaited<ReturnType<typeof runBatch>>;
  try {
    outcome = await runBatch(ids, gapMs, {
      dispatch: async (id): Promise<DispatchResult> => {
        try {
          await rerunIdentifierScreen(id, created.batch_id);
          return { kind: "dispatched" };
        } catch (error) {
          return dispatchFailure(error, plain);
        }
      },
      sleep,
      stopped: () => stopRequested,
      progress: (line) => console.log(`  ${line}`),
    });
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (outcome.stoppedBecause === "interrupted" || outcome.stoppedBecause === "unreachable") {
    // Tell the Worker the rest will not come, so the digest waits only for what was started.
    try {
      await closeScreenBatch(created.batch_id);
    } catch (error) {
      console.log(
        chalk.yellow(
          `  The batch could not be closed (${plain(error instanceof Error ? error.message : "no answer")}); its digest follows two hours after the last dispatch.`,
        ),
      );
    }
  }
  printOutcome(created.batch_id, outcome);
}

function printOutcome(batchId: number, outcome: Awaited<ReturnType<typeof runBatch>>): void {
  console.log("");
  console.log(
    `Batch ${batchId}: ${outcome.dispatched} dispatched, ${outcome.refused} not dispatched, ${outcome.failed} without an answer${
      outcome.remaining.length > 0 ? `, ${outcome.remaining.length} not reached` : ""
    }.`,
  );
  if (outcome.remaining.length > 0) {
    console.log(chalk.dim(`  Not reached: ${outcome.remaining.map(plain).join(", ")}`));
  }
  console.log(
    chalk.dim(
      "  No per-request mail is sent. The administrators get one digest when every screen has reported, or two hours after the last dispatch.",
    ),
  );
  const complete = outcome.refused === 0 && outcome.failed === 0 && outcome.stoppedBecause === null;
  if (!complete) {
    // Some request did not start: the answer is the digest's, not a crash.
    process.exitCode = 1;
    markReportedExit();
  }
}
