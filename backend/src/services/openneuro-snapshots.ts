/**
 * Read OpenNeuro's snapshot lists for many datasets at once (epic #1046 phase 4a, #1910; ADR 0111).
 *
 * One GraphQL request carries up to {@link OPENNEURO_SNAPSHOT_BATCH} datasets as aliases. The
 * request and the reading of its answer are `shared/openneuro-snapshots.ts`, which the CLI's
 * re-pull plan reads one dataset with, so both read OpenNeuro's answer the same way; they are
 * re-exported here for this module's callers and tests.
 *
 * AN ERROR IS NEVER A VERDICT (ADR 0053, ADR 0054). A non-2xx, a network failure, a timeout and a
 * body that is not JSON are each an `error` read for every id of the batch, which the classifier
 * turns into `unchecked`.
 *
 * OpenNeuro is read politely: batches of 50, sequential, a 20 second timeout, a named
 * `User-Agent`, and no retry inside a call (a rerun of the report is the retry). The recorded
 * request and response this is written against are in `backend/test/fixtures/openneuro-graphql/`.
 */

import {
  buildUpstreamSnapshotQuery,
  parseUpstreamSnapshotBatch,
} from "../../../shared/openneuro-snapshots.js";
import type { UpstreamRead } from "../../../shared/upstream-staleness.js";
import type { Bindings } from "../types/bindings.js";
import { OPENNEURO_GRAPHQL_URL } from "./openneuro-discovery.js";
import { errorMessage } from "./repo-metadata.js";

export {
  type UpstreamSnapshotQuery,
  buildUpstreamSnapshotQuery,
  parseUpstreamSnapshotBatch,
} from "../../../shared/openneuro-snapshots.js";

export const OPENNEURO_SNAPSHOT_BATCH = 50;
export const OPENNEURO_SNAPSHOT_TIMEOUT_MS = 20_000;
/** The most batch-level problems a result carries. */
const MAX_ERRORS = 10;

export interface UpstreamSnapshotsResult {
  reads: Map<string, UpstreamRead>;
  /** HTTP requests sent, one per batch. */
  requests: number;
  /** Batch-level problems (a failed request), at most ten. */
  errors: string[];
}

/**
 * The snapshot lists of `ids` (OpenNeuro `ds` ids), in batches. Never throws: a batch that fails
 * makes every one of its ids an `error` read and adds a line to `errors`.
 */
export async function readUpstreamSnapshots(
  env: Pick<Bindings, "OPENNEURO_GRAPHQL_URL">,
  ids: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<UpstreamSnapshotsResult> {
  const unique = [...new Set(ids)];
  const url = env.OPENNEURO_GRAPHQL_URL ?? OPENNEURO_GRAPHQL_URL;
  const timeoutMs = opts.timeoutMs ?? OPENNEURO_SNAPSHOT_TIMEOUT_MS;
  const result: UpstreamSnapshotsResult = { reads: new Map(), requests: 0, errors: [] };

  for (let at = 0; at < unique.length; at += OPENNEURO_SNAPSHOT_BATCH) {
    const batch = unique.slice(at, at + OPENNEURO_SNAPSHOT_BATCH);
    result.requests++;
    const failBatch = (reason: string) => {
      for (const id of batch) result.reads.set(id, { kind: "error", reason });
      if (result.errors.length < MAX_ERRORS) {
        result.errors.push(`${batch[0]}..${batch[batch.length - 1]}: ${reason}`);
      }
    };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "NEMAR-API",
        },
        body: JSON.stringify(buildUpstreamSnapshotQuery(batch)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        failBatch(`OpenNeuro answered HTTP ${response.status}`);
        continue;
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        failBatch(`OpenNeuro sent a body that is not JSON (${errorMessage(err)})`);
        continue;
      }
      for (const [id, read] of parseUpstreamSnapshotBatch(json, batch)) result.reads.set(id, read);
    } catch (err) {
      failBatch(`OpenNeuro could not be reached (${errorMessage(err)})`);
    }
  }
  return result;
}
