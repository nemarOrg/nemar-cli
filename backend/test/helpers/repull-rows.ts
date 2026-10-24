/**
 * A row of `upstream_repulls` that satisfies every stage invariant of migration 0105 for a given
 * status, for the suites that seed the table directly (the migration test and the route test).
 * The production code never builds a row like this: it moves one along its edges.
 */

import {
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
