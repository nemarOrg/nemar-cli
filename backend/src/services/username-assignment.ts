/**
 * Give a username-less account the ADR 0042 suggestion, at sign-in (#1268,
 * ADR 0045).
 *
 * ADR 0042 built the BATCH path: `POST /admin/users/backfill-usernames` walks
 * the rows whose `username IS NULL` and names them. That closes the 19 accounts
 * that exist today and nothing after them — a web sign-up whose owner abandons
 * onboarding lands right back in the same state, and stays there until an
 * operator remembers to re-run a sweep. This is the LAZY path, and between the
 * two there is no way for an account to keep browsing NEMAR with no handle:
 * the sweep catches the ones already there, sign-in catches the ones arriving.
 *
 * THE RULE, in full:
 *   - the row's username is NULL or blank, and
 *   - the row has a given AND a family name (the ADR 0042 suggestion is first
 *     initial + family name; a name that folds to nothing in ASCII counts as
 *     absent), and
 *   - some variant of that suggestion is free.
 * Anything else leaves the column NULL and says why. Nothing is ever invented
 * from the email local part — ADR 0042 is explicit that a handle the person
 * never chose and cannot recognise as theirs is worse than none.
 *
 * WHY THE CLAIM CANNOT THROW, which is what makes it safe to put inside a
 * sign-in transaction: {@link CLAIM_USERNAME_SQL} is ONE statement whose
 * NOT EXISTS arm is evaluated with the write, so a name that was free when this
 * module scanned it and is taken by the time it writes produces `changes = 0`,
 * not a UNIQUE error. A sign-in that batches it therefore either lands whole or
 * lands whole minus the username — never rolls back over a handle.
 *
 * The audit row carries the event (`username_auto_assigned`); the 0079 column
 * carries the state. Both, because the copy that offers "we picked this, change
 * it if you like" is rendered on every page load and cannot afford to scan an
 * audit log for it.
 */

import { auditLogStatement } from "../db/audit-log";
import { pickAvailableUsername, suggestUsername } from "./username";

/**
 * Where the assignment happened. Written into the audit row's details so an
 * operator can tell the sweep's work from a sign-in's without joining anything.
 */
export type UsernameAssignmentSource =
  | "code_signin"
  | "orcid_signin"
  | "orcid_signup"
  | "admin_backfill";

/**
 * Claim `username` for `id`, but only while the row still has none and the name
 * is still free.
 *
 * Lifted out of routes/admin/user-usernames.ts so the sweep and the three
 * sign-in paths write the same statement — including
 * `username_auto_assigned = 1`, which is the whole reason a caller must not
 * hand-roll this UPDATE.
 *
 * The NOT EXISTS arm makes the check and the write ONE statement, which SQLite
 * and D1 execute atomically, so a lost race reports `changes = 0` rather than
 * raising or, worse, stealing a handle. The username predicate on the row
 * itself is the same idea for the other direction: a row that gained a username
 * between the scan and here keeps it.
 */
export const CLAIM_USERNAME_SQL = `UPDATE users
      SET username = ?, username_auto_assigned = 1, updated_at = datetime('now')
    WHERE id = ?
      AND deleted_at IS NULL
      AND (username IS NULL OR TRIM(username) = '')
      AND NOT EXISTS (
        SELECT 1 FROM users u2 WHERE u2.username = ? COLLATE NOCASE AND u2.id != ?
      )`;

/**
 * Usernames that would collide with `base` or any of its `-N` variants.
 *
 * Deleted rows are NOT excluded: `users.username` is UNIQUE across the whole
 * table, so a row this query cannot see is still a row the write would collide
 * with. The LIKE arm can over-match (`alovelace-institute` looks like a
 * suffixed variant and is not one), which only ever makes the taken set larger
 * and the suggestion later in the sequence, never a collision.
 */
const TAKEN_SQL = `SELECT username FROM users
   WHERE username = ? COLLATE NOCASE OR username LIKE ? ESCAPE '\\'`;

/** What a suggestion attempt produced. `no_base` and `exhausted` are kept apart
 *  because they ask different things: no_base needs a name (or a human), while
 *  exhausted means a base exists and every variant of it is taken, which is an
 *  operational fact worth logging. */
export type UsernamePick =
  | { status: "ok"; username: string; base: string }
  | { status: "no_base" }
  | { status: "exhausted"; base: string };

/**
 * The ADR 0042 suggestion for a name, suffixed past whatever is taken.
 *
 * `reserved` is for a caller handing out several usernames before any of them
 * is written (the sweep's dry run): without it two rows with the same suggested
 * handle would both be promised it.
 */
export async function pickUsernameForName(
  db: D1Database,
  givenName: string | null | undefined,
  familyName: string | null | undefined,
  reserved: Iterable<string> = [],
): Promise<UsernamePick> {
  const base = suggestUsername(givenName, familyName);
  if (!base) return { status: "no_base" };

  const rows = await db
    .prepare(TAKEN_SQL)
    .bind(base, `${base.replace(/[%_\\]/g, "\\$&")}-%`)
    .all<{ username: string | null }>();
  const taken = (rows.results ?? [])
    .map((r) => r.username)
    .filter((u): u is string => typeof u === "string");

  const username = pickAvailableUsername(base, [...taken, ...reserved]);
  return username ? { status: "ok", username, base } : { status: "exhausted", base };
}

/** The account columns the decision reads. */
interface AutoAssignRow {
  username: string | null;
  given_name: string | null;
  family_name: string | null;
}

/** What {@link autoAssignUsername} did, for the caller's log and for tests.
 *  Never an exception: this runs alongside a sign-in that has already
 *  succeeded, and no outcome here is worth failing one over. */
export type UsernameAssignmentOutcome =
  | { status: "assigned"; username: string }
  | { status: "already_set" }
  | { status: "no_name" }
  | { status: "exhausted" }
  | { status: "conflict" }
  | { status: "unavailable" };

/**
 * Assign this account the suggestion, if it needs one and one is available.
 *
 * Used by the two ORCID paths, where the name itself only lands after the
 * response (`refreshUserName` is a public-record fetch and is deliberately not
 * on the critical path), so this runs chained behind it rather than inside the
 * sign-in write. `/auth/code/verify` does NOT call this: it has a transaction
 * of its own and batches {@link CLAIM_USERNAME_SQL} into it directly, so the
 * handle and the session land together.
 *
 * Fails soft and says so. A row that could not be read, a name that folds to
 * nothing, a saturated base — each is reported, none throws, and the account is
 * left exactly as it was for the sweep (or the next sign-in) to pick up.
 */
export async function autoAssignUsername(
  db: D1Database,
  userId: number,
  source: UsernameAssignmentSource,
): Promise<UsernameAssignmentOutcome> {
  try {
    const row = await db
      .prepare(
        "SELECT username, given_name, family_name FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1",
      )
      .bind(userId)
      .first<AutoAssignRow>();
    if (!row) return { status: "unavailable" };
    if ((row.username ?? "").trim() !== "") return { status: "already_set" };

    const pick = await pickUsernameForName(db, row.given_name, row.family_name);
    if (pick.status === "no_base") return { status: "no_name" };
    if (pick.status === "exhausted") {
      // Nobody would otherwise see this: the account simply stays NULL and
      // onboarding asks. A saturated base is an operational fact.
      console.warn(
        `[username-assignment] every variant of "${pick.base}" is taken; user ${userId} keeps a NULL username`,
      );
      return { status: "exhausted" };
    }

    const claim = await usernameClaimStatement(db, userId, pick.username).run();
    if ((claim.meta?.changes ?? 0) === 0) {
      // The row gained a username, or the handle was claimed, between the scan
      // and the write. Not an error: the next sign-in picks the next suffix.
      return { status: "conflict" };
    }
    await recordUsernameAssignment(db, userId, pick.username, source);
    return { status: "assigned", username: pick.username };
  } catch (err) {
    // Never fatal. The caller is a sign-in that has already succeeded, and an
    // account with no username is the state this function exists to improve on,
    // not one it may fail a login over.
    console.error(`[username-assignment] could not assign a username to user ${userId}`, err);
    return { status: "unavailable" };
  }
}

/**
 * The claim on its own, for a caller that wants it inside its own transaction
 * (`/auth/code/verify` batches it with the session insert so the handle and the
 * session land together).
 *
 * Bound, not run. The caller reads `changes` to learn whether the handle
 * actually landed, and only then writes the audit row with
 * {@link recordUsernameAssignment} — the two are deliberately NOT batched
 * together, because a claim that loses its race would otherwise commit an audit
 * row saying a username was assigned when none was.
 */
export function usernameClaimStatement(
  db: D1Database,
  userId: number,
  username: string,
): D1PreparedStatement {
  return db.prepare(CLAIM_USERNAME_SQL).bind(username, userId, username, userId);
}

/**
 * Record that a username was assigned rather than chosen.
 *
 * Outside the claim's transaction and non-fatal, for the reason
 * `upload_access_requested` records: the username HAS landed by the time this
 * runs, and rolling a sign-in back over a failed audit insert is the worse
 * outcome. Loud in the log instead.
 */
export async function recordUsernameAssignment(
  db: D1Database,
  userId: number,
  username: string,
  source: UsernameAssignmentSource,
): Promise<void> {
  try {
    await auditLogStatement(db, {
      userId,
      action: "username_auto_assigned",
      resourceType: "user",
      resourceId: String(userId),
      details: JSON.stringify({ username, source }),
    }).run();
  } catch (err) {
    console.error(
      `AUDIT GAP: username_auto_assigned row not written for id=${userId} (the username "${username}" DID land):`,
      err,
    );
  }
}
