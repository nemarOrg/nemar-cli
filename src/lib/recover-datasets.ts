/**
 * Checked-in target list for dataset recovery (epic #967 phase 5, #972).
 *
 * scripts/recover-datasets.json enumerates the 45 datasets published with
 * 0-byte content in the epic #967 incident (the copy step never verified
 * per-key size, so the publish gate happily minted DOIs for empty uploads)
 * whose OpenNeuro upstream IS accessible today, so they can be re-copied via
 * the hardened import path (Phases 1-3). This is the complement of
 * scripts/withdrawn-datasets.json's 11 unrecoverable datasets (45 + 11 = 56,
 * disjoint; see issue #967). The list is NOT derivable from a live D1
 * query -- it comes from the epic's forensic sweep -- so it is a checked-in
 * constant, mirroring `scripts/withdrawn-datasets.json` / `parseWithdrawnDatasets`.
 *
 * `nemar admin recover --all` / `nemar admin recover status --all` load this
 * file; `nemar admin recover <id>` (explicit-id form) also consults it to
 * refuse an id that isn't on the list unless `--force` is passed (fat-finger
 * guard, same rationale as withdraw).
 */

import { readFileSync } from "node:fs";

const DATASET_ID_RE = /^on\d{6}$/;

export interface RecoverDatasetEntry {
  dataset_id: string;
  note: string;
}

/**
 * Validate a parsed `recover-datasets.json` payload. Pure so the file's
 * shape can be unit-tested without touching disk (mirrors
 * parseWithdrawnDatasets).
 */
export function parseRecoverDatasets(raw: unknown): RecoverDatasetEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("Recover-datasets file must be a JSON array");
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Recover-datasets entry ${i} is not an object`);
    }
    const { dataset_id, note } = entry as Record<string, unknown>;
    if (typeof dataset_id !== "string" || !DATASET_ID_RE.test(dataset_id)) {
      throw new Error(`Recover-datasets entry ${i}: dataset_id "${dataset_id}" is not valid`);
    }
    if (typeof note !== "string" || note.length === 0) {
      throw new Error(`Recover-datasets entry ${i} (${dataset_id}): note is required`);
    }
    return { dataset_id, note };
  });
}

/** Read + parse the recover-datasets file at `path`. */
export function loadRecoverDatasets(path: string): RecoverDatasetEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to read/parse recover-datasets file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseRecoverDatasets(raw);
}

/**
 * Resolve the recovery target ids for explicit CLI-supplied ids against the
 * checked-in list: refuse an id that isn't on the list unless `force` is set
 * (guards against a fat-fingered dataset id triggering a live re-verify +
 * re-dispatch of the OpenNeuro import workflow). Pure and side-effect free
 * so `nemar admin recover <id>`'s guard is unit-testable without Commander
 * or a network call; the CLI action is a thin wrapper around this.
 */
export function resolveRecoverTargets(
  ids: string[],
  entries: RecoverDatasetEntry[],
  opts: { force?: boolean },
): { targets: string[] } | { error: string } {
  const byId = new Set(entries.map((e) => e.dataset_id));
  for (const id of ids) {
    if (!byId.has(id) && !opts.force) {
      return {
        error: `${id} is not on the checked-in recover-datasets list. Pass --force to override.`,
      };
    }
  }
  return { targets: ids };
}
