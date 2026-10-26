/**
 * `nemar admin repull status <id>`: what the record of a dataset's re-pulls says (ADR 0111,
 * decision 3; epic #1046 phase 6). Re-pull routes send no mail, so this is how an administrator
 * reads a re-pull's state: the newest record in full, with its identifier screens and the command
 * that takes it on, and the older ones a line each. Counts, commits and fixed words only; a record
 * never holds a path or a key.
 */

import type { RepullRow } from "../../../shared/repull-state.js";
import { isTerminal } from "../../../shared/repull-state.js";
import type { RepullScreen } from "../api/repull.js";

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : "none");

/** The command that takes a record on from where it is, or null when nothing does. */
export function nextCommand(row: RepullRow): string | null {
  const id = row.dataset_id;
  switch (row.status) {
    case "planned":
    case "prepared":
    case "copied":
    case "registered":
      return "nemar admin repull execute <plan-file>  (the reviewed plan this record was made from)";
    case "pr_open":
      return `nemar admin repull resume ${id}  (the identifier screen and the gates)`;
    case "gates_clear":
      return row.merge_claim_sha
        ? `nemar admin repull merge ${id}  (sends the merge again under the held claim), or resume ${id} once the claim is old enough to expire`
        : `nemar admin repull merge ${id}  (mints one version DOI, v${row.to_version})`;
    case "merged":
      return `nemar admin repull resume ${id}  (the release, the lock, then N.0.1 or the end)`;
    case "released":
      return typeof row.counts.conflicts === "number" && row.counts.conflicts > 0
        ? `nemar admin repull resume ${id} --take-ours <path> or --keep-upstream  (the lock, then N.0.1 or the end; the plan's ${row.counts.conflicts} conflict(s) wait for your decision), or nemar admin repull abandon ${id}  (declines N.0.1)`
        : `nemar admin repull resume ${id}  (the lock, then N.0.1 or the end)`;
    case "patch_synthesized":
      return `nemar admin repull resume ${id}  (N.0.1's identifier screen and gates)`;
    case "patch_gates_clear":
      return row.patch_merge_claim_sha
        ? `nemar admin repull merge ${id}  (sends N.0.1's merge again under the held claim), or resume ${id} once the claim is old enough to expire`
        : `nemar admin repull merge ${id}  (mints one version DOI, v${row.patch_version})`;
    case "patch_merged":
    case "patch_released":
      return `nemar admin repull resume ${id}  (N.0.1's release and the end)`;
    default:
      return isTerminal(row.status) ? null : `nemar admin repull resume ${id}`;
  }
}

/** One record in full, with its screens (newest first). */
export function statusLines(row: RepullRow, screens: RepullScreen[] | null): string[] {
  const lines = [
    `Re-pull #${row.id} of ${row.dataset_id}: ${row.status} (attempt ${row.attempt}, ${row.origin})`,
    `  Upstream ${row.upstream_ds}: ${row.from_tag} -> ${row.to_tag}, as v${row.to_version} (from v${row.from_version})`,
    `  Plan: ${row.plan_digest} (planner ${row.planner})`,
    `  Base: ${short(row.base_sha)}   Commit: ${short(row.synth_sha)}   Tree: ${short(row.synth_tree)}`,
  ];
  if (row.pr_number !== null) {
    lines.push(`  Pull request: #${row.pr_number} of ${row.branch}, head ${short(row.head_sha)}`);
  }
  if (row.gates_sha) lines.push(`  Gates clear at: ${short(row.gates_sha)}`);
  if (row.merge_claim_sha) {
    lines.push(`  Claim to merge: ${short(row.merge_claim_sha)}, made ${row.merge_claimed_at} UTC`);
  }
  if (row.merge_sha) lines.push(`  Merge: ${short(row.merge_sha)}`);
  if (row.tag_sha) lines.push(`  Tag v${row.to_version}: ${short(row.tag_sha)}`);
  if (row.patch_pr_number !== null) {
    lines.push(
      `  N.0.1 pull request: #${row.patch_pr_number} of ${row.patch_branch}, head ${short(row.patch_head_sha)}, base ${short(row.patch_base_sha)}`,
    );
  }
  if (row.patch_gates_sha) lines.push(`  N.0.1 gates clear at: ${short(row.patch_gates_sha)}`);
  if (row.patch_merge_claim_sha) {
    lines.push(
      `  N.0.1 claim to merge: ${short(row.patch_merge_claim_sha)}, made ${row.patch_merge_claimed_at} UTC`,
    );
  }
  if (row.patch_merge_sha) lines.push(`  N.0.1 merge: ${short(row.patch_merge_sha)}`);
  if (row.patch_tag_sha) lines.push(`  Tag v${row.patch_version}: ${short(row.patch_tag_sha)}`);
  if (row.status === "released") {
    lines.push(
      typeof row.counts.locked === "number"
        ? `  Objects locked: ${row.counts.locked}`
        : "  Objects locked: not yet (resume applies the lock)",
    );
  }
  const counts = Object.entries(row.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  if (counts.length > 0) lines.push(`  Counts: ${counts.join(", ")}`);
  if (row.last_error) lines.push(`  Last error: ${row.last_error}`);
  lines.push(`  Created ${row.created_at} UTC, updated ${row.updated_at} UTC`);
  if (screens === null) {
    lines.push("  Identifier screens: an xx dataset is not screened");
  } else {
    for (const s of screens) {
      const ack =
        s.acknowledged_at !== null
          ? `; acknowledged by administrator #${s.acknowledged_by} at ${s.acknowledged_at} UTC`
          : "";
      lines.push(
        `  Identifier screen of ${short(s.sha)} (${s.pr}): ${s.headline} (gate: ${s.gate}${s.waiting ? ", running" : ""}${ack})`,
      );
      for (const l of s.lines) lines.push(`    ${l}`);
    }
  }
  const next = nextCommand(row);
  if (next) lines.push(`  Next: ${next}`);
  return lines;
}

/** An older record, one line. */
export function olderLine(row: RepullRow): string {
  return `  #${row.id}: ${row.from_tag} -> ${row.to_tag}, attempt ${row.attempt}, ${row.status}${row.terminal_at ? ` (${row.terminal_at} UTC)` : ""}`;
}
