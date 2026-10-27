/**
 * A row of `upstream_repulls` that satisfies every stage invariant of migration 0105 for a given
 * status, for the suites that seed the table directly (the migration test and the route test).
 * The production code never builds a row like this: it moves one along its edges.
 *
 * Also the one dispatch seeder of the suites that read `upstream_repull_dispatches` (migration
 * 0112): a row that satisfies every CHECK for its state, written through bun:sqlite by
 * {@link seedDispatch} or through any driver by {@link DISPATCH_INSERT_SQL} and
 * {@link dispatchBinds}. The production code makes these rows by claiming and reporting.
 */

import type { Database } from "bun:sqlite";
import {
  type DispatchStatus,
  REPULL_STATUSES,
  type RepullStatus,
  TERMINAL_STATUSES,
} from "../../../shared/repull-state";

export type Row = Record<string, string | number | null>;

export const SHA = "a".repeat(40);
export const TREE = "b".repeat(40);
export const DIGEST = `sha256:${"0".repeat(64)}`;

const TERMINAL = new Set<string>(TERMINAL_STATUSES);

/** A row that satisfies every CHECK for `status`, with `over` laid on top. */
export function rowAt(status: RepullStatus, over: Row = {}): Row {
  const row: Row = {
    dataset_id: "xx090123",
    upstream_ds: "ds004362",
    from_tag: "1.0.0",
    to_tag: "1.0.1",
    attempt: 1,
    from_version: "1.0.0",
    to_version: "2.0.0",
    plan_digest: DIGEST,
    planner: 1,
    origin: "administrator",
    actor_user_id: 1,
    status,
    base_sha: SHA,
    terminal_at: TERMINAL.has(status) ? "2026-10-24 00:00:00" : null,
  };
  const after = (s: RepullStatus) => REPULL_STATUSES.indexOf(status) >= REPULL_STATUSES.indexOf(s);
  const early = ["planned", "abandoned", "failed", "superseded"];
  if (!early.includes(status)) {
    row.synth_tree = TREE;
    row.synth_sha = SHA;
    row.manifest_digest = DIGEST;
  }
  const hasPr = after("pr_open") && !early.includes(status);
  if (hasPr) Object.assign(row, { branch: "release/v2.0.0", pr_number: 7, head_sha: SHA });
  if (status === "gates_clear") row.gates_sha = SHA;
  if (hasPr && after("merged")) row.merge_sha = SHA;
  if (hasPr && after("released")) row.tag_sha = SHA;
  const patch = ["patch_synthesized", "patch_gates_clear", "patch_merged", "patch_released"];
  if (patch.includes(status)) {
    Object.assign(row, {
      patch_version: "2.0.1",
      patch_branch: "release/v2.0.1",
      patch_pr_number: 8,
      patch_head_sha: SHA,
      patch_base_sha: SHA,
    });
  }
  if (status === "patch_gates_clear") row.patch_gates_sha = SHA;
  if (status === "patch_merged" || status === "patch_released") row.patch_merge_sha = SHA;
  if (status === "patch_released") row.patch_tag_sha = SHA;
  return { ...row, ...over };
}

// ----------------------------------------------------------------------------
// Dispatches
// ----------------------------------------------------------------------------

/**
 * What every live dispatch's one-shot nonce begins with. A suite that proves a nonce leaves no
 * answer asserts the answer does not hold this, whatever number follows it.
 */
export const NONCE_MARK = "zzzz-nonce-sentinel-zzzz-";

export interface DispatchSeed {
  /** The dataset: an `on` id, which is all the table takes. */
  dataset: string;
  status: DispatchStatus;
  /** `finish` for a `finished` dispatch and `open` for the rest, unless named. */
  kind?: "open" | "finish";
  /** The word a refused, failed or not-sent dispatch carries (the table requires one). */
  code?: string | null;
  /** `dispatched_at`, and `reported_at` for a state that was reported. */
  at: string;
  /** 1 for an `opened` or a `finish` dispatch, which the table requires, and none for the rest. */
  repullId?: number | null;
  /** The run's log, for a state that was reported. */
  runUrl?: string | null;
}

export const DISPATCH_INSERT_SQL = `INSERT INTO upstream_repull_dispatches
  (kind, dataset_id, upstream_ds, from_tag, to_tag, repull_id, nonce, status, code,
   workflow_run_url, dispatched_at, reported_at)
  VALUES (?, ?, ?, '1.0.0', '1.0.1', ?, ?, ?, ?, ?, ?, ?)`;

let nonceSeq = 0;

/** The values of {@link DISPATCH_INSERT_SQL} for a seed, a live state holding a fresh nonce. */
export function dispatchBinds(o: DispatchSeed): unknown[] {
  const live = o.status === "dispatched" || o.status === "started";
  const reported = !["dispatched", "dispatch_failed", "unreported"].includes(o.status);
  const kind = o.kind ?? (o.status === "finished" ? "finish" : "open");
  const repullId =
    o.repullId !== undefined ? o.repullId : o.status === "opened" || kind === "finish" ? 1 : null;
  return [
    kind,
    o.dataset,
    `ds${o.dataset.slice(2)}`,
    repullId,
    live ? `${NONCE_MARK}${String(++nonceSeq).padStart(8, "0")}` : null,
    o.status,
    o.code ?? null,
    reported ? (o.runUrl ?? null) : null,
    o.at,
    reported ? o.at : null,
  ];
}

/** A dispatch in bun:sqlite; its id. */
export function seedDispatch(db: Database, o: DispatchSeed): number {
  return Number(
    db.query(DISPATCH_INSERT_SQL).run(...(dispatchBinds(o) as never[])).lastInsertRowid,
  );
}
