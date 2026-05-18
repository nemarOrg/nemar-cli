/**
 * Auto-generated participants.tsv for BIDS datasets that ship without one.
 *
 * BIDS treats participants.tsv as RECOMMENDED rather than REQUIRED, so the
 * bids-validator passes when the file is absent. Downstream tooling that
 * surfaces participant counts (NEMAR catalog `subject_count`, the discover
 * page's "Participants" tile) reads from this file -- without it, the
 * count stays null forever and the reindex sweep can't converge.
 *
 * Two paths land in this trap:
 *   - nm* uploaded via `nemar upload` where the user didn't include
 *     participants.tsv (BIDS validator doesn't fail, dataset gets
 *     published with null subject_count)
 *   - on* imported from OpenNeuro via `--trust-upstream` where the
 *     upstream itself lacks one (e.g. OpenNeuroDatasets/ds005262)
 *
 * The enrichment pipeline (the single place that runs after BOTH paths,
 * including --trust-upstream OpenNeuro import) calls `ensureParticipantsTsv`:
 *   - If the repo already has participants.tsv: returns null (no commit
 *     needed; existing file flows through to subject_count parsing)
 *   - If the repo has sub-* directories at root but no participants.tsv:
 *     builds a placeholder TSV with n/a values and returns it so the
 *     caller can include it in the enrichment commit batch
 *   - If there are no subjects either: returns null (not a BIDS dataset
 *     in the structural sense; auto-generating would be misleading)
 *
 * Pure helpers below; no I/O. The caller owns the commit.
 */

/** Tree entry shape from getTreeAtRef. */
export interface TreeEntry {
  path: string;
  type?: string;
  sha?: string;
}

/**
 * Find every `sub-<id>` directory at the root of the BIDS tree. Returns
 * a sorted, deduplicated list. The participant id includes the `sub-`
 * prefix because that's how BIDS spells it in both the tree and in the
 * participants.tsv `participant_id` column.
 *
 * Looks at any tree entry whose path either equals `sub-X` exactly (a
 * directory entry) or starts with `sub-X/` (any file under that subject).
 * GitHub's `tree?recursive=1` returns both blob and tree entries, so we
 * dedupe on the prefix to get the canonical subject set.
 */
export function enumerateBidsSubjects(tree: ReadonlyArray<TreeEntry>): string[] {
  const subjects = new Set<string>();
  const re = /^(sub-[0-9A-Za-z]+)(?:\/|$)/;
  for (const entry of tree) {
    const m = re.exec(entry.path);
    if (m) subjects.add(m[1]);
  }
  return [...subjects].sort();
}

/**
 * Emit a minimal BIDS-compliant participants.tsv with participant_id,
 * age, and sex columns. Age and sex are `n/a` -- the safe placeholder
 * BIDS recognizes for "not collected / not disclosed". A dataset whose
 * publication later supplies real demographics can replace this file
 * via a follow-up commit; downstream code reads whichever participants.tsv
 * exists at publication time.
 *
 * Throws on empty subjects: callers must check `enumerateBidsSubjects`
 * first so we never emit a header-only file that surfaces as
 * subject_count=0 in the catalog.
 */
export function buildPlaceholderParticipantsTsv(subjects: ReadonlyArray<string>): string {
  if (subjects.length === 0) {
    throw new Error("buildPlaceholderParticipantsTsv: refusing to emit a header-only TSV");
  }
  const header = "participant_id\tage\tsex";
  const rows = subjects.map((s) => `${s}\tn/a\tn/a`);
  return `${[header, ...rows].join("\n")}\n`;
}

export interface EnsureParticipantsTsvResult {
  /**
   * The placeholder content the caller should include in the enrichment
   * commit batch. null when the file is already present OR when the tree
   * has no sub-* directories (not a BIDS dataset shape we can fix up).
   */
  contentToCommit: string | null;
  /**
   * Subjects discovered in the tree, regardless of whether we generated
   * a file. Callers that need the count for subject_count fallback can
   * use this directly.
   */
  subjects: string[];
  /**
   * True iff a participants.tsv already exists in the tree. Lets the
   * caller distinguish "we generated one" from "one was already there"
   * for logging / metrics.
   */
  alreadyPresent: boolean;
}

/**
 * Decide whether to auto-commit a placeholder participants.tsv. Pure;
 * uses only the tree listing the caller already fetched.
 */
export function ensureParticipantsTsv(tree: ReadonlyArray<TreeEntry>): EnsureParticipantsTsvResult {
  const alreadyPresent = tree.some((f) => f.path === "participants.tsv");
  const subjects = enumerateBidsSubjects(tree);
  if (alreadyPresent || subjects.length === 0) {
    return { contentToCommit: null, subjects, alreadyPresent };
  }
  return {
    contentToCommit: buildPlaceholderParticipantsTsv(subjects),
    subjects,
    alreadyPresent: false,
  };
}
