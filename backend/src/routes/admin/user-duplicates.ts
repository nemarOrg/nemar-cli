/**
 * Admin routes: the duplicate-account report and the flag it reports on
 * (#1254, epic #1250; ADR 0043).
 *
 *   GET  /admin/users/duplicates
 *   POST /admin/users/:id/clear-identity-conflict
 *
 * Migration 0077 made an ORCID iD and an email address unique across live
 * accounts, and absorbed the catalog's existing duplicates into a per-row
 * `identity_conflict` flag rather than failing the deploy or deleting anybody.
 * That flag is deliberately invisible to a user, so these two endpoints are the
 * whole operator interface for it: one to SEE the groups, one to clear a flag
 * after a collision is actually resolved.
 *
 * NEITHER ROUTE MERGES OR DELETES ANYTHING. Merging two accounts means moving
 * datasets, DOIs, S3 credentials and a GitHub collaborator set between owners,
 * and getting it wrong is not recoverable; it stays a deliberate manual
 * operation. The self-service fix comes first anyway: the person signs in to
 * the surviving account and changes its email, its GitHub username, or its
 * ORCID link in Settings.
 *
 * Lives in its own domain file rather than in users.ts for the same reason
 * user-names.ts does: one concern, and it keeps out of the way of the account
 * listing work happening in that file.
 *
 * SAFETY (the shared dev/prod users table, AGENTS.md): the report is read-only,
 * the clear route writes one integer on one row plus an audit entry, and
 * neither emails anyone, touches GitHub, S3, or a DOI.
 */

import type {
  DuplicateAccount,
  DuplicateGroup,
  IdentityKind,
} from "../../../../shared/contract/identity.js";
import { auditLogStatement } from "../../db/audit-log";
import { identityRefusal, isUniqueViolationOn } from "../../services/identity";
import type { AdminRouter } from "./shared";

/**
 * Every live account plus the two facts the grouping needs that are not
 * columns on `users`: whether the row holds the `oauth_identities` row for its
 * own iD (which decides who is canonical in an ORCID group, per 0077) and how
 * many non-sandbox datasets it owns (which is what an operator actually weighs
 * when deciding which of two accounts survives).
 *
 * Unpaginated on purpose: `users` is ~600 rows, the grouping is O(n) in the
 * application, and a paged report could split a duplicate group across two
 * pages -- which is the one thing this report must never do.
 */
export const DUPLICATE_CANDIDATES_SQL = `SELECT
       u.id,
       u.username,
       u.email,
       u.github_username,
       u.orcid,
       u.created_at,
       u.identity_conflict,
       CASE WHEN EXISTS (
         SELECT 1 FROM oauth_identities oi
          WHERE oi.user_id = u.id
            AND oi.provider = 'orcid'
            AND oi.provider_subject = u.orcid
       ) THEN 1 ELSE 0 END AS has_oauth_identity,
       (SELECT COUNT(*) FROM datasets d
         WHERE d.owner_user_id = u.id AND d.is_sandbox = 0) AS dataset_count
     FROM users u
    WHERE u.deleted_at IS NULL
    ORDER BY u.id`;

interface CandidateRow {
  id: number;
  username: string | null;
  email: string;
  github_username: string | null;
  orcid: string | null;
  created_at: string;
  identity_conflict: number;
  has_oauth_identity: number;
  dataset_count: number;
}

/**
 * The grouping key for each identifier, or `null` when the row does not carry
 * that identifier at all.
 *
 * Email and GitHub fold case because their uniqueness rules do
 * (`idx_users_email_live_unique` is `COLLATE NOCASE`, and so is
 * `idx_users_github` from 0012). ORCID does NOT fold case, because
 * `idx_users_orcid_live_unique` compares exactly -- migration 0077
 * canonicalises the stored check digit and every write path normalises it, so
 * an exact comparison is complete, and folding here would report a group the
 * index does not consider a collision.
 */
function keyFor(row: CandidateRow, kind: IdentityKind): string | null {
  if (kind === "orcid") {
    const v = row.orcid?.trim();
    return v ? v : null;
  }
  if (kind === "email") {
    const v = row.email?.trim();
    return v ? v.toLowerCase() : null;
  }
  const v = row.github_username?.trim();
  return v ? v.toLowerCase() : null;
}

/**
 * Which row keeps the identifier, mirroring migration 0077's rules exactly.
 *
 * ORCID: the row holding the `oauth_identities` row, and the lowest id only
 * when none does. That ordering is the whole point in the production case --
 * id 43 can sign in with the iD and carries the ORCID name, id 42 is the
 * orphan the identity row left behind, and picking the lowest id would have
 * crowned the orphan.
 *
 * Email and GitHub: the lowest id. There is no identity row to prefer and no
 * other principled tiebreak; the oldest account is the likelier live one.
 *
 * If this and the migration ever disagree, the report tells an operator to
 * resolve the wrong row -- so the correspondence is asserted directly by the
 * route test against a fixture the migration itself flagged.
 */
function canonicalIdOf(rows: CandidateRow[], kind: IdentityKind): number {
  // AN UNFLAGGED ROW ALWAYS WINS, whatever the per-identifier rule says.
  //
  // The flag is the fact that decides this: a flagged row is invisible to the
  // partial unique indexes, so it does NOT hold the identifier no matter how
  // low its id is. On the compound shape -- one pair colliding on BOTH iD and
  // email, where the ORCID pass flagged the LOWER id because the identity row
  // sits on the higher one -- "lowest id" would mark the flagged row canonical
  // and send an operator to fix the wrong account.
  //
  // Migration 0077's email pass encodes the same precedence in SQL
  // (`m.identity_conflict = 0` inside its MIN), which is why this has to.
  const unflagged = rows.filter((r) => r.identity_conflict === 0);
  const pool = unflagged.length > 0 ? unflagged : rows;

  if (kind === "orcid") {
    const backed = pool.find((r) => r.has_oauth_identity === 1);
    if (backed) return backed.id;
  }
  // Lowest id, over the unflagged rows when there are any and over the whole
  // group when a migration flagged every row in it (possible, and then there
  // is no right answer -- report the migration's rule rather than nothing).
  return pool.reduce((min, r) => (r.id < min ? r.id : min), pool[0].id);
}

function toAccount(row: CandidateRow, canonicalId: number): DuplicateAccount {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    created_at: row.created_at,
    has_oauth_identity: row.has_oauth_identity === 1,
    dataset_count: row.dataset_count,
    identity_conflict: row.identity_conflict,
    canonical: row.id === canonicalId,
  };
}

/** Build every duplicate group across all three identifiers. Exported so the
 *  clear route below and the tests both read the same grouping. */
export function buildDuplicateGroups(rows: CandidateRow[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  for (const kind of ["orcid", "email", "github"] as const) {
    const byKey = new Map<string, CandidateRow[]>();
    for (const row of rows) {
      const key = keyFor(row, kind);
      if (key === null) continue;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(row);
      else byKey.set(key, [row]);
    }
    for (const [value, bucket] of byKey) {
      if (bucket.length < 2) continue;
      const canonicalId = canonicalIdOf(bucket, kind);
      groups.push({
        kind,
        value,
        canonical_user_id: canonicalId,
        accounts: bucket.map((r) => toAccount(r, canonicalId)),
      });
    }
  }
  // Stable order so a diff between two runs is meaningful: by identifier
  // (orcid, email, github as listed above), then by the shared value.
  return groups;
}

export function registerUserDuplicateRoutes(admin: AdminRouter): void {
  /**
   * GET /admin/users/duplicates - live accounts sharing an identifier.
   *
   * REGISTRATION ORDER IS LOAD-BEARING. `GET /users/:username` also matches
   * `/users/duplicates`, and this route only wins because
   * `registerUserDuplicateRoutes` runs BEFORE `registerUsersRoutes` in
   * admin/index.ts. Do not reorder them.
   *
   * There is no "static outranks param" rule to fall back on here: this
   * router's path set makes Hono's RegExpRouter throw `UnsupportedPathError`,
   * so it falls back to a router that runs every matching handler in
   * registration order and takes the first response. Registered second, this
   * route would never be reached -- the username lookup would 404 first, which
   * is exactly what happened before the order was fixed.
   */
  admin.get("/users/duplicates", async (c) => {
    try {
      const { results } = await c.env.DB.prepare(DUPLICATE_CANDIDATES_SQL).all<CandidateRow>();
      const rows = results ?? [];
      const groups = buildDuplicateGroups(rows);
      return c.json({
        groups,
        group_count: groups.length,
        // Counted over ALL live rows, not over `groups`: a flag that outlived
        // its collision (someone fixed the other account) shows up here as a
        // number larger than the groups explain, which is precisely the signal
        // that a flag is ready to be cleared.
        flagged_count: rows.filter((r) => r.identity_conflict === 1).length,
      });
    } catch (err) {
      console.error("[admin/user-duplicates] report failed", err);
      return c.json({ error: "Failed to build duplicate report" }, 500);
    }
  });

  /**
   * POST /admin/users/:id/clear-identity-conflict - un-flag a resolved row.
   *
   * Refuses (409) while the collision that earned the flag is still there,
   * naming the rows that still collide. That refusal is not politeness: the
   * partial unique indexes would reject the row the moment it became visible
   * to them, so clearing early would either fail loudly on the UPDATE or --
   * worse, if the collision were on a column the row does not currently write
   * -- leave the catalog one write away from a constraint error nobody
   * expected.
   *
   * Id-keyed, not username-keyed: a web/ORCID row has `username = NULL`
   * (#1012), and the duplicate rows are disproportionately those.
   */
  admin.post("/users/:id/clear-identity-conflict", async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "Invalid user id" }, 400);
    }

    try {
      const { results } = await c.env.DB.prepare(DUPLICATE_CANDIDATES_SQL).all<CandidateRow>();
      const rows = results ?? [];
      const target = rows.find((r) => r.id === id);
      if (!target) {
        // Live rows only, so a tombstoned id lands here too -- correctly: a
        // tombstone is already invisible to both partial indexes and has no
        // flag worth clearing.
        return c.json({ error: "User not found" }, 404);
      }

      // Every group this row is in, minus the ones where it is alone.
      const colliding = buildDuplicateGroups(rows)
        .filter((g) => g.accounts.some((a) => a.id === id))
        .map((g) => ({
          kind: g.kind,
          value: g.value,
          user_ids: g.accounts.filter((a) => a.id !== id).map((a) => a.id),
        }));

      if (colliding.length > 0) {
        return c.json(
          {
            error: "identity_conflict_remains",
            ...identityRefusal("identity_conflict_remains"),
            colliding,
          },
          409,
        );
      }

      if (target.identity_conflict === 0) {
        // Already clear. A no-op, not an error: an operator who resolved the
        // collision by deleting the OTHER row may find this one was never
        // flagged in the first place, and a 409 there would read as a failure.
        return c.json({ ok: true, id, cleared: false });
      }

      // Clearing the flag is what puts the row back INTO the partial unique
      // indexes, so this UPDATE is itself a uniqueness-checked write: a
      // collision that appeared between the SELECT above and here fails right
      // now. That is the same answer the pre-check gives, so it gets the same
      // 409 rather than a generic 500 -- an operator who retries then sees the
      // colliding rows named instead of an opaque failure.
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(
            "UPDATE users SET identity_conflict = 0, updated_at = datetime('now') WHERE id = ?",
          ).bind(id),
          auditLogStatement(c.env.DB, {
            userId: c.get("user")?.id ?? null,
            action: "identity_conflict_cleared",
            resourceType: "user",
            resourceId: String(id),
            details: JSON.stringify({ email: target.email, orcid: target.orcid }),
          }),
        ]);
      } catch (writeErr) {
        if (isUniqueViolationOn(writeErr, "orcid") || isUniqueViolationOn(writeErr, "email")) {
          // Re-read so the response names who it collided with, rather than
          // reporting the empty list the stale pre-check produced.
          const fresh = await c.env.DB.prepare(DUPLICATE_CANDIDATES_SQL).all<CandidateRow>();
          const races = buildDuplicateGroups(fresh.results ?? [])
            .filter((g) => g.accounts.some((a) => a.id === id))
            .map((g) => ({
              kind: g.kind,
              value: g.value,
              user_ids: g.accounts.filter((a) => a.id !== id).map((a) => a.id),
            }));
          return c.json(
            {
              error: "identity_conflict_remains",
              ...identityRefusal("identity_conflict_remains"),
              colliding: races,
            },
            409,
          );
        }
        throw writeErr;
      }
      return c.json({ ok: true, id, cleared: true });
    } catch (err) {
      console.error("[admin/user-duplicates] clear failed", err);
      return c.json({ error: "Failed to clear identity conflict" }, 500);
    }
  });
}
