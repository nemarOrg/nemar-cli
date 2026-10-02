/**
 * The Neurobagel writer's entry points for the flows around it (epic #1586, phase 4; ADR 0084):
 * the hook that publication, import and a new version call, and the daily reconcile.
 *
 * This module WRITES NOTHING. It decides whether to run and hands the work to
 * {@link runNeurobagelWriter}, which is the only module that puts or deletes in the bucket.
 * It sends no mail and dispatches nothing to GitHub.
 *
 * A hook must NEVER fail, block or delay the flow that calls it: with the writer off (the
 * default) it returns before any I/O, the work goes to `waitUntil` and is never awaited by
 * the caller, and every failure, including one thrown synchronously, is caught and logged.
 */

import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import { couldBeFederated } from "./neurobagel-eligibility.js";
import {
  type RunOptions,
  type RunResult,
  neurobagelWriterMode,
  runNeurobagelWriter,
} from "./neurobagel-writer.js";

/** One dataset: the hook's work. Also removes it when it is no longer eligible. */
export function syncNeurobagelDataset(
  env: Bindings,
  datasetId: string,
  trigger: string,
  waitUntil?: (work: Promise<unknown>) => void,
  deps?: RunOptions["deps"],
): Promise<RunResult> {
  return runNeurobagelWriter(env, {
    trigger,
    execute: true,
    only: [datasetId],
    limit: 1,
    waitUntil,
    deps,
  });
}

/**
 * The hook publication, import and a new version call. It must NEVER fail, block or
 * delay the flow that calls it:
 *   - with the writer off (the default) it returns before doing any I/O;
 *   - an id that can never be federated (an `xx` sandbox, a reserved fixture) returns
 *     before any read;
 *   - the work is handed to `waitUntil` and never awaited by the caller;
 *   - every failure, including one thrown synchronously here, is caught and logged.
 *
 * `after` is work the caller has already started and that this sync must follow (the
 * metadata refresh that writes the D1 columns a fingerprint reads). Its failure is the
 * refresh's own business and never stops the sync.
 */
export function scheduleNeurobagelSync(
  env: Bindings,
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
  datasetId: string,
  trigger: string,
  options: { after?: Promise<unknown>; deps?: RunOptions["deps"] } = {},
): void {
  try {
    const mode = neurobagelWriterMode(env);
    if (mode === "disabled") return;
    if (!couldBeFederated(datasetId)) return;
    if (mode === "store_unconfigured") {
      console.warn(`[neurobagel] store_unconfigured: ${trigger} for ${datasetId} did nothing`);
      return;
    }
    const work = (options.after ?? Promise.resolve())
      .catch(() => {})
      .then(() => syncNeurobagelDataset(env, datasetId, trigger, waitUntil, options.deps))
      .then((r) => {
        if (r.status === "error") {
          console.error(`[neurobagel] ${trigger} ${datasetId}: ${r.error}`);
        }
      })
      .catch((err) =>
        console.error(
          `[neurobagel] ${trigger} ${datasetId} failed:`,
          err instanceof Error ? (err.stack ?? err.message) : err,
        ),
      );
    if (waitUntil) waitUntil(work);
  } catch (err) {
    console.error(
      `[neurobagel] could not schedule ${trigger} for ${datasetId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The daily reconcile, the safety net: bounded by `NEUROBAGEL_RECONCILE_MAX`, in the
 * deterministic order of neurobagel-plan.ts. PRODUCTION ONLY and absent from
 * `DEV_CRON_ALLOWLIST` (a new daily job is production-only by default, AGENTS.md):
 * this is the cron fence, and the fence lives HERE so the admin route, which calls
 * `runNeurobagelWriter` directly, still works on staging.
 */
export async function runNeurobagelReconcileCron(
  env: Bindings,
  waitUntil?: (work: Promise<unknown>) => void,
): Promise<RunResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[neurobagel] reconcile skipped (non-production)");
    return null;
  }
  // `waitUntil` is the tick's own, so the data plane's cache writes during a gather outlive
  // the examination of one dataset, as they do for a request.
  return runNeurobagelWriter(env, { trigger: "cron", execute: true, waitUntil });
}
