/**
 * Daily sweep of the accounts the live integration tests leave behind (#1789).
 *
 * The live-backend suites (`test/auth-device-cli-live.test.ts`, `test/auth-device-flow.test.ts`,
 * `test/auth-passwordless.test.ts`) seed a NEW account per run with a generated address at
 * `@nemar.test` and nothing removes it, so the staging users page filled with hundreds of them
 * and buried the real ones. This sweep tombstones them, with the SAME statements as the
 * owner-only `DELETE /admin/users/by-id/:id` (`tombstoneUserCascade`): the PII mask, the
 * `deleted_at` stamp, every key, session and grant ended.
 *
 * WHY THIS IS SAFE TO RUN ON A DATABASE THAT SHARES REAL PEOPLE (AGENTS.md, "Dev D1 shares
 * production users"). An account is swept only when ALL of these hold, each re-checked in code
 * on the row it names before anything is written:
 *   - the address is exactly one of the three generated shapes at `@nemar.test`
 *     ({@link GENERATED_TEST_ACCOUNT_EMAIL}: anchored, case-sensitive, a closed character set).
 *     The `.test` TLD is reserved (RFC 2606) and can never be a real person's address, and the
 *     seeded fixtures (`test-user@nemar.test` and the rest) match no shape;
 *   - `signup_source = 'web'` (the live tests seed web accounts), `account_kind` is not
 *     `service`, `role` is `member`, no legacy IAM user;
 *   - not already tombstoned, and created more than {@link TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS} days ago;
 *   - it owns nothing: no dataset, no collaboration, no publication request, no pending access
 *     request, no open upload-access request and no granted upload access. An account that
 *     asked for or holds anything somebody might still act on is left for a human.
 *
 * THE DISCRIMINATOR IS NOT `account_kind = 'test'`. The issue proposed it, but the live tests
 * seed through `POST /admin/test-fixtures/seed-web-user` WITHOUT a `kind`, so these accounts are
 * `person` (the column default), and they cannot be `test`: the device flow they exercise
 * refuses every non-`person` account (`services/device-auth.ts`). The address shape is what is
 * true of them and of no real account; `service` is excluded so an operational account can
 * never match, and `person` and `test` both pass so a later change to how the suites seed does
 * not silently stop the sweep.
 *
 * NO NETWORK. The route also removes GitHub collaborators and revokes legacy IAM keys; the
 * `nemarDatasets` org is shared between production and dev, so this sweep does neither. It
 * does not need to: the predicate excludes an account with an IAM user or any collaboration,
 * which leaves nothing for those two steps to do.
 *
 * PRODUCTION: never. The guard is repeated here (fail-closed, so an unset or mistyped
 * `ENVIRONMENT` counts as production) and at the call site in `scheduledCleanup`.
 *
 * BOUNDED. At most {@link TEST_ACCOUNT_SWEEP_BATCH} accounts per run, oldest first, so a backlog
 * clears over several daily runs rather than in one long Worker invocation.
 *
 * It logs counts only, never an address.
 */

import { tombstoneUserCascade } from "../db/user-tombstone.js";
import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";

/** Accounts one run may tombstone. Oldest first; the rest wait for the next daily run. */
export const TEST_ACCOUNT_SWEEP_BATCH = 100;

/** An account younger than this is left alone, so a run in progress is never cut from under. */
export const TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS = 7;

/**
 * Rows one run may READ in total, however many of them the pattern rejects, so a pile of
 * look-alike rows can neither stall the sweep nor make it scan without end.
 */
const SCAN_CAP = TEST_ACCOUNT_SWEEP_BATCH * 10;

/**
 * The three generated shapes, which the live suites build as
 * `<prefix>-<label>-<Date.now()>-<Math.random().toString(36).slice(2, 8)>@nemar.test`:
 * prefix `dcli`, `df` or `pl`; a label of lower-case letters and digits joined by hyphens; a
 * 13-digit millisecond clock; one to six base-36 characters. Anchored at both ends, no `i` and
 * no `m` flag: an upper-case rendering, a trailing newline or a longer domain does not match.
 */
export const GENERATED_TEST_ACCOUNT_EMAIL =
  /^(?:dcli|df|pl)-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{13}-[a-z0-9]{1,6}@nemar\.test$/;

/** The same shapes as one GLOB per prefix (case-sensitive, anchored): a prefilter only. */
const GLOB_CLOCK = "[0-9]".repeat(13);
const GLOB_PATTERNS = ["dcli", "df", "pl"].map((p) => `${p}-*-${GLOB_CLOCK}-*@nemar.test`);

/**
 * Candidate accounts after `id > ?`, oldest first (ids are AUTOINCREMENT, so id order is
 * creation order). The GLOBs narrow the scan; they are NOT the decision, the regular
 * expression is, and it runs on every row returned.
 */
export const TEST_ACCOUNT_SWEEP_CANDIDATES_SQL = `SELECT id, email FROM users
  WHERE id > ?
    AND deleted_at IS NULL
    AND (${GLOB_PATTERNS.map(() => "email GLOB ?").join(" OR ")})
    AND signup_source = 'web'
    AND account_kind IN ('person', 'test')
    AND COALESCE(role, 'member') = 'member'
    AND aws_iam_username IS NULL
    AND aws_access_key_id_encrypted IS NULL
    AND service_access = 0
    AND upload_access_requested_at IS NULL
    AND created_at < datetime('now', ?)
    AND NOT EXISTS (SELECT 1 FROM datasets d WHERE d.owner_user_id = users.id)
    AND NOT EXISTS (SELECT 1 FROM dataset_collaborators c WHERE c.user_id = users.id)
    AND NOT EXISTS (SELECT 1 FROM publication_requests r WHERE r.requested_by = users.id)
    AND NOT EXISTS (
      SELECT 1 FROM access_requests a WHERE a.user_id = users.id AND a.status = 'pending'
    )
  ORDER BY id
  LIMIT ?`;

export interface TestAccountSweepResult {
  /** False when the production guard refused the run; nothing was read or written. */
  ran: boolean;
  /** Candidate rows read. */
  examined: number;
  tombstoned: number;
  /** Candidates the in-code pattern check rejected. Never written. */
  skipped: number;
  /** Tombstones that failed (the row is left whole; the next run retries it). */
  errors: number;
}

const NOT_RUN: TestAccountSweepResult = {
  ran: false,
  examined: 0,
  tombstoned: 0,
  skipped: 0,
  errors: 0,
};

/**
 * Tombstone up to {@link TEST_ACCOUNT_SWEEP_BATCH} of the live tests' accounts. See the module
 * comment for the predicate and why it cannot reach a real address. Does nothing outside a
 * recognized non-production environment.
 */
export async function sweepCiTestAccounts(
  env: Pick<Bindings, "DB" | "ENVIRONMENT">,
): Promise<TestAccountSweepResult> {
  // Repeated from the call site on purpose: the guarantee must not depend on who calls this.
  if (!isNonProductionEnv(env)) return { ...NOT_RUN };

  const db = env.DB;
  const result: TestAccountSweepResult = { ...NOT_RUN, ran: true };
  const age = `-${TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS} days`;
  const spent = () => result.tombstoned + result.errors;
  let afterId = 0;

  while (spent() < TEST_ACCOUNT_SWEEP_BATCH && result.examined < SCAN_CAP) {
    const page = await db
      .prepare(TEST_ACCOUNT_SWEEP_CANDIDATES_SQL)
      .bind(afterId, ...GLOB_PATTERNS, age, TEST_ACCOUNT_SWEEP_BATCH)
      .all<{ id: number; email: string }>();
    const rows = page.results ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (spent() >= TEST_ACCOUNT_SWEEP_BATCH) break;
      afterId = row.id;
      result.examined++;
      // The decision. Re-verified here, on the row's own address, immediately before the write.
      if (!GENERATED_TEST_ACCOUNT_EMAIL.test(row.email)) {
        result.skipped++;
        continue;
      }
      try {
        await tombstoneUserCascade(db, row.id, row.email);
        result.tombstoned++;
      } catch (err) {
        result.errors++;
        // The id is a non-PII integer; the address is never logged.
        console.error(
          `[test-account-sweep] tombstone failed for id=${row.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  console.log(
    `[test-account-sweep] examined=${result.examined} tombstoned=${result.tombstoned} skipped=${result.skipped} errors=${result.errors}`,
  );
  return result;
}
