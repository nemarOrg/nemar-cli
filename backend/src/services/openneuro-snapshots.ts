/**
 * Read OpenNeuro's snapshot lists for many datasets at once (epic #1046 phase 4a, #1910; ADR 0111).
 *
 * One GraphQL request carries up to {@link OPENNEURO_SNAPSHOT_BATCH} datasets as aliases
 * (`a0: dataset(id: $a0) { ... }`), with the ids passed ONLY as variables so an id can never reach
 * the query text. OpenNeuro answers a dataset it cannot serve with `data.aN: null` plus an
 * `errors[]` entry whose `path` is `["aN"]`: `DELETED_DATASET` for a deleted one (the duplicates
 * OpenNeuro retires) and a plain "does not exist" message for a missing one.
 *
 * AN ERROR IS NEVER A VERDICT (ADR 0053, ADR 0054). A non-2xx, a network failure, a timeout, a
 * body that is not JSON, a node that names another dataset, a `snapshots` that is not a list:
 * each is an `error` read, which the classifier turns into `unchecked`. A `snapshots` that is
 * not an array is never read as `[]`, because an empty list would be a statement about upstream.
 *
 * OpenNeuro is read politely: batches of 50, sequential, a 20 second timeout, a named
 * `User-Agent`, and no retry inside a call (a rerun of the report is the retry). The recorded
 * request and response this is written against are in `backend/test/fixtures/openneuro-graphql/`.
 */

import type { UpstreamRead, UpstreamSnapshot } from "../../../shared/upstream-staleness.js";
import type { Bindings } from "../types/bindings.js";
import { OPENNEURO_GRAPHQL_URL } from "./openneuro-discovery.js";
import { errorMessage } from "./repo-metadata.js";

export const OPENNEURO_SNAPSHOT_BATCH = 50;
export const OPENNEURO_SNAPSHOT_TIMEOUT_MS = 20_000;
/** The most batch-level problems a result carries. */
const MAX_ERRORS = 10;

const DELETED_CODE = "DELETED_DATASET";

export interface UpstreamSnapshotQuery {
  query: string;
  variables: Record<string, string>;
}

/** The batched query for `ids`: aliases `a0..aN`, every id a variable, none in the text. */
export function buildUpstreamSnapshotQuery(ids: readonly string[]): UpstreamSnapshotQuery {
  const declarations = ids.map((_, i) => `$a${i}: ID!`).join(", ");
  const selections = ids
    .map(
      (_, i) =>
        `a${i}: dataset(id: $a${i}) { id latestSnapshot { tag created } snapshots { tag created } }`,
    )
    .join(" ");
  const variables: Record<string, string> = {};
  ids.forEach((id, i) => {
    variables[`a${i}`] = id;
  });
  return { query: `query UpstreamSnapshots(${declarations}) { ${selections} }`, variables };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `{ tag, created }` entry, or null when it is not one. `created` may be absent. */
function snapshotOf(value: unknown): UpstreamSnapshot | null {
  if (!isObject(value) || typeof value.tag !== "string" || value.tag === "") return null;
  const created = value.created;
  if (created !== undefined && created !== null && typeof created !== "string") return null;
  return { tag: value.tag, created: typeof created === "string" ? created : null };
}

function readNode(node: Record<string, unknown>, id: string): UpstreamRead {
  if (node.id !== id) {
    return {
      kind: "error",
      reason: `OpenNeuro answered ${String(node.id)} where ${id} was asked`,
    };
  }
  if (!Array.isArray(node.snapshots)) {
    return { kind: "error", reason: `OpenNeuro sent no snapshot list for ${id}` };
  }
  const snapshots: UpstreamSnapshot[] = [];
  for (const entry of node.snapshots) {
    const snapshot = snapshotOf(entry);
    if (!snapshot)
      return { kind: "error", reason: `OpenNeuro sent a malformed snapshot for ${id}` };
    snapshots.push(snapshot);
  }
  let latest: UpstreamSnapshot | null = null;
  if (node.latestSnapshot !== null && node.latestSnapshot !== undefined) {
    latest = snapshotOf(node.latestSnapshot);
    if (!latest) {
      return { kind: "error", reason: `OpenNeuro sent a malformed latest snapshot for ${id}` };
    }
  }
  return { kind: "snapshot", latest, snapshots };
}

/** The `errors[]` entry whose `path` starts at `alias`, if there is one. */
function errorFor(errors: unknown, alias: string): Record<string, unknown> | null {
  if (!Array.isArray(errors)) return null;
  for (const entry of errors) {
    if (isObject(entry) && Array.isArray(entry.path) && entry.path[0] === alias) return entry;
  }
  return null;
}

/**
 * Turn one batch response into a read per id. Pure. `ids[N]` is the dataset asked as alias `aN`.
 * Anything that is not understood is `error`.
 */
export function parseUpstreamSnapshotBatch(
  json: unknown,
  ids: readonly string[],
): Map<string, UpstreamRead> {
  const reads = new Map<string, UpstreamRead>();
  const data = isObject(json) ? json.data : undefined;
  if (!isObject(json) || !isObject(data)) {
    const first = isObject(json) && Array.isArray(json.errors) ? json.errors[0] : undefined;
    const why =
      isObject(first) && typeof first.message === "string"
        ? first.message
        : "the response carried no data";
    for (const id of ids) reads.set(id, { kind: "error", reason: `OpenNeuro: ${why}` });
    return reads;
  }
  ids.forEach((id, i) => {
    const alias = `a${i}`;
    const node = data[alias];
    if (isObject(node)) {
      reads.set(id, readNode(node, id));
      return;
    }
    if (node === null) {
      const err = errorFor(json.errors, alias);
      const message = err && typeof err.message === "string" ? err.message : null;
      const code = err && isObject(err.extensions) ? err.extensions.code : undefined;
      if (message === null) {
        reads.set(id, {
          kind: "error",
          reason: `OpenNeuro sent null for ${id} without saying why`,
        });
      } else if (code === DELETED_CODE) {
        reads.set(id, { kind: "deleted", reason: message });
      } else if (/does not exist/i.test(message)) {
        reads.set(id, { kind: "absent", reason: message });
      } else {
        reads.set(id, { kind: "error", reason: message });
      }
      return;
    }
    reads.set(id, { kind: "error", reason: `OpenNeuro did not answer ${id}` });
  });
  return reads;
}

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
