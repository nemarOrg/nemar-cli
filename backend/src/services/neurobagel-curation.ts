/**
 * The ONE adapter point between the writer and curated annotations (epic #1586:
 * phase 4 here, phase 5 supplies the curation entries and the transform's
 * `curation` input).
 *
 * The contract, which the lead set and the writer enforces:
 *
 *   A dataset id that HAS a curation entry is NEVER converted without it.
 *   If the entry cannot be loaded or is invalid, conversion STOPS for that dataset:
 *   nothing is written, whatever artifact exists is left as it is, and a
 *   needs-review finding is reported. There is no fallback to converting with no
 *   curation, because an entry can exist precisely to WITHDRAW a mechanical
 *   mapping (a "control" arm read as a healthy control): converting without it
 *   would publish a claim the curators removed.
 *
 * A resolver answers one of three things, and there is no fourth:
 *   none    no entry exists for this id (conversion proceeds, un-curated);
 *   entry   an entry exists and loaded (its hash joins the fingerprint);
 *   failed  an entry exists, or whether one does cannot be established (stop).
 *
 * Phase 5 (#1591) adds `shared/neurobagel/curation.ts`. Until it lands there is no
 * curation file, so the default resolver answers `none` for every id; when it lands
 * the wiring is a LAZY dynamic import inside {@link defaultCurationResolver}, on the
 * writer path only: the curation loader brings roughly 850 KB of vocabulary that no
 * request hot path may carry.
 *
 * `applyCuration` is where an entry meets the transform's input. The transform of
 * this branch takes no curation, so an entry it cannot pass is a STOP
 * (`curation_unsupported`), never a silent drop of the entry.
 */

import type { NeurobagelInput } from "../../../shared/neurobagel/index.js";

export type CurationResolution =
  | { kind: "none" }
  | { kind: "entry"; hash: string; entry: unknown }
  | { kind: "failed"; reason: string };

export type CurationResolver = (datasetId: string) => Promise<CurationResolution>;

/** Until phase 5 lands there is no curation file: no dataset has an entry. */
export const defaultCurationResolver: CurationResolver = async () => ({ kind: "none" });

/**
 * Pass a resolved entry to the transform's input, or say that this transform cannot
 * take one. The only function that knows how an entry reaches the transform.
 */
export function applyCuration(
  input: NeurobagelInput,
  resolution: Extract<CurationResolution, { kind: "none" | "entry" }>,
): { kind: "ok"; input: NeurobagelInput } | { kind: "failed"; reason: string } {
  if (resolution.kind === "none") return { kind: "ok", input };
  return {
    kind: "failed",
    reason: "this transform takes no curation entry yet, and an entry exists for the dataset",
  };
}
