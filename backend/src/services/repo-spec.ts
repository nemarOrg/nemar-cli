/**
 * D1 glue for `ensureRepoToSpec` (epic #713, phase #717).
 *
 * `backend/src/services/github.ts` is intentionally D1-free: `ensureRepoToSpec`
 * / `reconcileCollaborators` take the resolved owner + writer GitHub logins.
 * This helper resolves those from the D1 ledger so the routes don't duplicate
 * the query.
 */

export interface RepoCollaborators {
  /** Repo owner's GitHub login (from datasets.owner_user_id), or null. */
  ownerLogin: string | null;
  /** Approved writer GitHub logins (from dataset_collaborators). */
  approvedWriters: string[];
}

/**
 * Resolve the owner + approved-writer GitHub logins for a dataset. Owner comes
 * from datasets.owner_user_id; writers from dataset_collaborators. Tombstoned
 * users and rows without a github_username are excluded.
 */
export async function resolveRepoCollaborators(
  db: D1Database,
  datasetId: string,
): Promise<RepoCollaborators> {
  const owner = await db
    .prepare(
      `SELECT u.github_username AS gh
         FROM datasets d JOIN users u ON d.owner_user_id = u.id
        WHERE d.dataset_id = ? AND u.deleted_at IS NULL`,
    )
    .bind(datasetId)
    .first<{ gh: string | null }>();

  const writers = await db
    .prepare(
      `SELECT u.github_username AS gh
         FROM dataset_collaborators dc
         JOIN datasets d ON dc.dataset_id = d.id
         JOIN users u ON dc.user_id = u.id
        WHERE d.dataset_id = ? AND u.deleted_at IS NULL AND u.github_username IS NOT NULL`,
    )
    .bind(datasetId)
    .all<{ gh: string }>();

  return {
    ownerLogin: owner?.gh ?? null,
    approvedWriters: (writers.results ?? [])
      .map((r) => r.gh)
      .filter((g): g is string => Boolean(g)),
  };
}
