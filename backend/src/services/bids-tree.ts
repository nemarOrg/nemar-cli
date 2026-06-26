/**
 * BIDS tree helpers — pure path/TSV parsers used by the dataset metadata
 * pipeline (subject/session counts, task labels, participant age stats).
 *
 * Relocated from the deleted nemar-sync.ts (the legacy nemar.org push is gone,
 * but these helpers feed `dataset-metadata-columns.ts`, `enrich-dataset.ts`,
 * and `dataset-reindex.ts`). ZERO I/O; callers supply the tree paths / file content.
 */

interface ParticipantStats {
  count: number;
  ageMin: number | null;
  ageMax: number | null;
}

/**
 * Parse participants.tsv content into a participant count and age range.
 * Rows with `n/a` ages are skipped for the min/max; the count is the row total.
 */
export function parseParticipantsTsv(content: string): ParticipantStats {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { count: 0, ageMin: null, ageMax: null };

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const ageIdx = headers.indexOf("age");
  const rows = lines.slice(1);

  let ageMin: number | null = null;
  let ageMax: number | null = null;

  if (ageIdx >= 0) {
    for (const row of rows) {
      const cols = row.split("\t");
      const raw = cols[ageIdx]?.trim();
      if (!raw || raw === "n/a" || raw === "N/A") continue;
      const age = Number.parseFloat(raw);
      if (!Number.isNaN(age)) {
        ageMin = ageMin === null ? age : Math.min(ageMin, age);
        ageMax = ageMax === null ? age : Math.max(ageMax, age);
      }
    }
  }

  return { count: rows.length, ageMin, ageMax };
}

/**
 * Count BIDS sessions as the number of distinct `ses-<label>` directories in
 * the dataset tree (#657). Session labels are deduplicated globally, so two
 * subjects that both have `ses-01` count it once. A dataset with no `ses-*`
 * layer (single implied session) returns 0; callers decide how to treat that.
 */
export function countSessionDirs(paths: readonly string[]): number {
  const sessions = new Set<string>();
  for (const p of paths) {
    const match = p.match(/\/ses-([^/]+)\//);
    if (match) sessions.add(match[1]);
  }
  return sessions.size;
}

/**
 * Count BIDS subjects as the number of distinct root-level `sub-<label>`
 * directories present in the dataset tree. This is the BIDS-canonical subject
 * set and the correct basis for `subject_count` (#759).
 *
 * The participants.tsv row count is NOT used here because it can be an enrolled
 * roster far larger than the subjects actually released — on005752 had 1859
 * participants.tsv rows but only 251 `sub-*` directories with data. A subject
 * with data but absent from participants.tsv still counts; a roster row with no
 * `sub-*` directory does not. Derivatives (`derivatives/.../sub-*`) are excluded
 * by anchoring the match to the start of the path.
 */
export function countSubjectDirs(paths: readonly string[]): number {
  const subjects = new Set<string>();
  for (const p of paths) {
    const match = p.match(/^sub-([^/]+)\//);
    if (match) subjects.add(match[1]);
  }
  return subjects.size;
}

/**
 * Extract sorted, deduplicated BIDS task labels from a list of file paths.
 * Reads `_task-<label>` segments and stops at `_`, `.`, or `/`.
 */
export function extractTasks(paths: readonly string[]): string[] {
  const tasks = new Set<string>();
  for (const p of paths) {
    const match = p.match(/_task-([^_./]+)/);
    if (match) tasks.add(match[1]);
  }
  return [...tasks].sort();
}
