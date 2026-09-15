/**
 * Checked-in target list for dataset withdrawal (epic #967 phase 4, #971).
 *
 * scripts/withdrawn-datasets.json enumerates the 11 datasets published with
 * 0-byte content whose source cannot currently be recovered (see the epic #967
 * incident: real user data was never copied because the copy step didn't
 * verify per-key size, so the publish gate happily minted DOIs for empty
 * uploads). The list is NOT derivable from a live D1 query -- see the phase 4
 * plan -- so it is a checked-in, forensically-sourced constant, mirroring
 * `scripts/exemplar-fleet.json` / `parseExemplarFleet` in exemplar-clone.ts.
 *
 * `nemar admin withdraw --all` / `nemar admin restore --all` load this file;
 * `nemar admin withdraw <id>` (single-id form) also consults it to refuse an
 * id that isn't on the list unless `--force` is passed (fat-finger guard).
 */

import { readFileSync } from "node:fs";

/**
 * Why a dataset is on this list.
 *
 * `recovered` is the outcome, not a cause: the content was copied back and the
 * dataset reinstated, and the entry stays as the record of a withdrawal that
 * should not have happened. Six of the original eleven turned out to be this
 * (#1396). Their filed reason was never measured per dataset -- nine said
 * `upstream_403` and two `no_source` -- and for those six the content was
 * fetchable by OpenNeuro's own advertised route the whole time they sat private
 * with tombstoned DOIs.
 */
export type WithdrawalReason = "upstream_403" | "no_source" | "recovered";

const WITHDRAWAL_REASONS: ReadonlySet<string> = new Set(["upstream_403", "no_source", "recovered"]);

const DATASET_ID_RE = /^(nm|xx|on)\d{6}$/;

export interface WithdrawnDatasetEntry {
  dataset_id: string;
  reason: WithdrawalReason;
  note: string;
  /**
   * Whether the dataset is still down. False for a reinstated one, which keeps
   * its entry as a record but must not be re-targeted by `--all`.
   */
  withdrawn?: boolean;
  /** Share of its DATA keys NEMAR can serve, 0 to 1 (ADR 0064). */
  data_available?: number;
  data_keys_missing?: number;
  data_keys_total?: number;
}

/**
 * Validate a parsed `withdrawn-datasets.json` payload. Pure so the file's
 * shape can be unit-tested without touching disk (mirrors parseExemplarFleet).
 */
export function parseWithdrawnDatasets(raw: unknown): WithdrawnDatasetEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("Withdrawn-datasets file must be a JSON array");
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Withdrawn-datasets entry ${i} is not an object`);
    }
    const {
      dataset_id,
      reason,
      note,
      withdrawn,
      data_available,
      data_keys_missing,
      data_keys_total,
    } = entry as Record<string, unknown>;
    if (typeof dataset_id !== "string" || !DATASET_ID_RE.test(dataset_id)) {
      throw new Error(`Withdrawn-datasets entry ${i}: dataset_id "${dataset_id}" is not valid`);
    }
    if (typeof reason !== "string" || !WITHDRAWAL_REASONS.has(reason)) {
      throw new Error(
        `Withdrawn-datasets entry ${i} (${dataset_id}): reason "${reason}" must be one of ${[...WITHDRAWAL_REASONS].join(", ")}`,
      );
    }
    if (typeof note !== "string" || note.length === 0) {
      throw new Error(`Withdrawn-datasets entry ${i} (${dataset_id}): note is required`);
    }
    if (withdrawn !== undefined && typeof withdrawn !== "boolean") {
      throw new Error(`Withdrawn-datasets entry ${i} (${dataset_id}): withdrawn must be a boolean`);
    }
    if (
      data_available !== undefined &&
      (typeof data_available !== "number" || data_available < 0 || data_available > 1)
    ) {
      throw new Error(
        `Withdrawn-datasets entry ${i} (${dataset_id}): data_available must be between 0 and 1`,
      );
    }
    return {
      dataset_id,
      reason: reason as WithdrawalReason,
      note,
      ...(typeof withdrawn === "boolean" ? { withdrawn } : {}),
      ...(typeof data_available === "number" ? { data_available } : {}),
      ...(typeof data_keys_missing === "number" ? { data_keys_missing } : {}),
      ...(typeof data_keys_total === "number" ? { data_keys_total } : {}),
    };
  });
}

/** Read + parse the withdrawn-datasets file at `path`. */
export function loadWithdrawnDatasets(path: string): WithdrawnDatasetEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to read/parse withdrawn-datasets file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseWithdrawnDatasets(raw);
}

export interface WithdrawTarget {
  datasetId: string;
  reason: string;
}

/**
 * Resolve the withdrawal target list for explicit CLI-supplied ids against
 * the checked-in list: refuse an id that isn't on the list unless `force` is
 * set (guards against a fat-fingered dataset id triggering a real
 * visibility flip + DOI tombstone), and require a reason -- either the
 * explicit override or the list entry's own -- per id. Pure and side-effect
 * free so `nemar admin withdraw <id>`'s guard is unit-testable without
 * Commander or a network call; the CLI action is a thin wrapper around this.
 */
export function resolveWithdrawTargets(
  ids: string[],
  entries: WithdrawnDatasetEntry[],
  opts: { reason?: string; force?: boolean },
): { targets: WithdrawTarget[] } | { error: string } {
  const byId = new Map(entries.map((e) => [e.dataset_id, e]));
  const targets: WithdrawTarget[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry && !opts.force) {
      return {
        error: `${id} is not on the checked-in withdrawn-datasets list. Pass --force to override.`,
      };
    }
    const reason = opts.reason || entry?.reason;
    if (!reason) {
      return { error: `${id}: no --reason given and it has no default entry in the list.` };
    }
    targets.push({ datasetId: id, reason });
  }
  return { targets };
}

/**
 * The entries `--all` should act on: the ones still down.
 *
 * An entry with `withdrawn: false` is a record of a withdrawal that was
 * reversed, kept so the mistake stays visible. Re-targeting it would tombstone
 * a dataset we just reinstated, which is how a forensic list turns into a
 * loaded gun.
 */
export function stillWithdrawn(entries: WithdrawnDatasetEntry[]): WithdrawnDatasetEntry[] {
  return entries.filter((entry) => entry.withdrawn !== false);
}
