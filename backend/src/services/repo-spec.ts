/**
 * D1 glue for `ensureRepoToSpec` (epic #713, phase #717).
 *
 * `backend/src/services/github/branch-protection.ts` is intentionally D1-free: `ensureRepoToSpec`
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
  // Exclude a revoked/tombstoned owner: their account is gone, so reconcile must
  // not re-grant them maintain. (owner_user_id persists even after revoke; the
  // revoke/delete flow removes the GitHub grant, and a null owner here lets the
  // reconcile drop the stale grant instead of re-asserting it.)
  const owner = await db
    .prepare(
      `SELECT u.github_username AS gh
         FROM datasets d JOIN users u ON d.owner_user_id = u.id
        WHERE d.dataset_id = ?
          AND u.deleted_at IS NULL
          AND u.status NOT IN ('revoked', 'revoked_iam_pending')`,
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

/**
 * Mirror a reconcile's GitHub grant-removals into D1 by deleting the matching
 * `dataset_collaborators` rows. MUST be called in its own try/catch separate
 * from the `ensureRepoToSpec` run: at this point the GitHub grants are already
 * gone, so a D1 failure here is a real D1-vs-GitHub divergence that has to be
 * flagged loudly, not folded into the (non-fatal) spec-enforcement catch.
 *
 * `github_username` is matched COLLATE NOCASE (GitHub logins are
 * case-insensitive; the column's stored case may differ from what the API
 * returned).
 */
export async function mirrorReconcileRemovals(
  db: D1Database,
  datasetId: string,
  removed: string[] | undefined,
): Promise<void> {
  const logins = removed ?? [];
  if (logins.length === 0) return;
  try {
    const placeholders = logins.map(() => "?").join(",");
    await db
      .prepare(
        `DELETE FROM dataset_collaborators
           WHERE dataset_id = (SELECT id FROM datasets WHERE dataset_id = ?)
             AND user_id IN (SELECT id FROM users WHERE github_username IN (${placeholders}) COLLATE NOCASE)`,
      )
      .bind(datasetId, ...logins)
      .run();
  } catch (e) {
    console.error(
      `CRITICAL: reconcile removed GitHub grants [${logins.join(", ")}] on ${datasetId} but the D1 dataset_collaborators delete failed - D1 and GitHub are now diverged:`,
      e,
    );
  }
}
