/**
 * Admin route: give the username-less accounts a username (ADR 0042, #1253).
 *
 * 19 live rows have `username IS NULL`. Every one is a web/ORCID sign-up,
 * where the column has been NULL by design since migration 0026 and nothing
 * has ever filled it. That is now load-bearing rather than cosmetic: an upload
 * request needs a username (it is what the admin review card names and what
 * `nemar admin approve <username>` addresses), the admin listing falls back to
 * printing an email and a numeric id, and the person has no handle to be known
 * by anywhere in the product.
 *
 * Sibling of user-names.ts (#1255), deliberately a SEPARATE endpoint rather
 * than a mode of it: that one fills `given_name`/`family_name` from ORCID and
 * is a precondition of this one, which then derives a handle from those names.
 * Running them as one command would hide which half failed, and the two have
 * different blast radii — this one also mails.
 *
 * DRY RUN BY DEFAULT, and the dry run reports the exact usernames `--apply`
 * would assign, collision suffixes included, so an operator reads the plan
 * before executing it.
 *
 * SAFETY (the shared dev/prod users table, AGENTS.md). Two external effects,
 * both fenced:
 *   - a credential-free GET against ORCID's PUBLIC record API, only for rows
 *     whose own name columns are empty;
 *   - ONE verify-your-email message per row that this run just gave a username
 *     to, issued through `issueEmailVerificationCode`, which outside production
 *     writes nothing and sends nothing for any address that is not a synthetic
 *     test target. No GitHub work is dispatched, no DOI is touched, and the
 *     only writes are `users.username` on rows that had none.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type {
  BackfillUsernameOutcome,
  BackfillVerifyOutcome,
} from "../../../../shared/contract/user.js";
import { auditLogStatement } from "../../db/audit-log";
import { issueEmailVerificationCode } from "../../services/email-verification";
import { fetchOrcidName, orcidPubBase } from "../../services/orcid-auth";
import { suggestUsername } from "../../services/username";
import {
  pickUsernameForName,
  recordUsernameAssignment,
  usernameClaimStatement,
} from "../../services/username-assignment";
import type { Bindings } from "../../types/bindings";
import type { AdminRouter } from "./shared";

/** One row of the verify-retry pass: an account that already has a username
 *  and never received (or never redeemed) its verify-your-email message. */
export interface BackfillVerifyRetry {
  id: number;
  email: string;
  verify: BackfillVerifyOutcome;
}

export interface BackfillUsernameResult {
  id: number;
  email: string;
  orcid: string | null;
  outcome: BackfillUsernameOutcome;
  /** The handle assigned, or the one `--apply` would assign. */
  username?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  /** Only meaningful on `assigned`; `not_attempted` everywhere else. */
  verify?: BackfillVerifyOutcome;
  error?: string;
}

const backfillSchema = z.object({
  /** Write the usernames and send the verification messages. Omitted or false
   *  = report what WOULD happen. */
  apply: z.boolean().optional().default(false),
  /** Users per batch. Each one can cost an ORCID request and an email, so the
   *  batch stays well inside the Worker's subrequest budget. */
  limit: z.number().int().min(1).max(100).optional().default(25),
});

/** Candidates: live accounts with no username. Whitespace counts as absent,
 *  matching every other "is this column filled" predicate in this codebase. */
const CANDIDATES_SQL = `SELECT id, email, orcid, given_name, family_name, email_verified
   FROM users
   WHERE deleted_at IS NULL
     AND (username IS NULL OR TRIM(username) = '')
   ORDER BY id
   LIMIT ?`;

/**
 * The verify-retry population: a web account that HAS a username, has not
 * confirmed its inbox, and has no live code waiting to be redeemed.
 *
 * This exists because the message the assignment pass sends is best-effort,
 * and a row whose send failed used to be unreachable forever: it had a
 * username, so it stopped matching the candidate predicate, and nothing else
 * in the product mails these accounts. The retry is therefore not a
 * convenience -- without it "one message per account" silently becomes "zero"
 * for any account whose one attempt failed.
 *
 * `NOT EXISTS (a live code)` is what keeps a re-run from re-mailing someone
 * who already has a usable code in their inbox, and what makes the pass
 * converge: a successful send writes a code, so the row drops out until that
 * code expires or is used. (Outside production the fence writes no code, so
 * these rows stay listed -- correctly, since nothing was sent.)
 *
 * Scoped to `signup_source = 'web'` deliberately: a CLI account proves its
 * inbox through the signup verification LINK, a different flow with its own
 * resend command, and mailing it a dashboard code would be the wrong message.
 */
const VERIFY_CANDIDATES_SQL = `SELECT id, email
   FROM users
   WHERE deleted_at IS NULL
     AND username IS NOT NULL AND TRIM(username) != ''
     AND signup_source = 'web'
     AND email_verified = 0
     AND NOT EXISTS (
       SELECT 1 FROM auth_codes ac
        WHERE ac.user_id = users.id
          AND ac.used_at IS NULL
          AND ac.expires_at > datetime('now')
     )
   ORDER BY id
   LIMIT ?`;

/** Same predicate, counted, so the response can say how much is left. */
const REMAINING_SQL = `SELECT COUNT(*) as n
   FROM users
   WHERE deleted_at IS NULL
     AND (username IS NULL OR TRIM(username) = '')`;

/**
 * Issue one verify-your-email code and classify the outcome.
 *
 * Shared by both passes so they cannot drift on what counts as sent. Never
 * throws: the caller has usually just written something it is not going to
 * roll back over an undelivered message.
 *
 * `send_failed` is folded into `failed` rather than reported verbatim: this
 * vocabulary tells the operator what to do, and "Resend refused it" and "the
 * call threw" are the same instruction.
 */
async function issueVerification(
  env: Bindings,
  userId: number,
  email: string,
): Promise<BackfillVerifyOutcome> {
  try {
    const issued = await issueEmailVerificationCode(env, userId, email.toLowerCase());
    if (!issued.ok) return issued.error === "rate_limited" ? "rate_limited" : "failed";
    return issued.skipped ? "skipped_fence" : "sent";
  } catch (mailErr) {
    console.error(`[backfill-usernames] verification message failed for id=${userId}`, mailErr);
    return "failed";
  }
}

export function registerUserUsernameRoutes(admin: AdminRouter): void {
  /**
   * POST /admin/users/backfill-usernames - give username-less accounts one
   *
   * Body: `{ apply?: boolean, limit?: number }`. Idempotent: a row that gains
   * a username stops matching the candidate predicate, so re-running walks
   * forward rather than re-doing work -- which is also what keeps the
   * verify-your-email message to exactly one per account, ever.
   */
  admin.post("/users/backfill-usernames", zValidator("json", backfillSchema), async (c) => {
    const { apply, limit } = c.req.valid("json");
    const db = c.env.DB;
    const adminUser = c.get("user");

    const candidates = await db.prepare(CANDIDATES_SQL).bind(limit).all<{
      id: number;
      email: string;
      orcid: string | null;
      given_name: string | null;
      family_name: string | null;
      email_verified: number;
    }>();

    /**
     * PASS 1: retry the verify-your-email message for rows that already have a
     * username and never got one that stuck.
     *
     * Deliberately BEFORE the assignment pass, and that ordering is what keeps
     * the two from colliding: a row this run is about to name has no username
     * yet, so it cannot appear here, and a row that appears here was named by
     * an earlier run. No exclusion list is needed, and neither pass can mail
     * the same account twice in one sweep.
     */
    const verifyRetries: BackfillVerifyRetry[] = [];
    const verifyCandidates = await db
      .prepare(VERIFY_CANDIDATES_SQL)
      .bind(limit)
      .all<{ id: number; email: string }>();
    for (const user of verifyCandidates.results ?? []) {
      verifyRetries.push({
        id: user.id,
        email: user.email,
        verify: apply ? await issueVerification(c.env, user.id, user.email) : "not_attempted",
      });
    }

    const pubBase = orcidPubBase(c.env);
    const results: BackfillUsernameResult[] = [];

    /**
     * Usernames this batch has already handed out.
     *
     * Load-bearing for the DRY RUN specifically: two rows with the same
     * suggested handle are in the same batch, nothing is written, so the second
     * row's DB scan cannot see what the first was promised -- and the report
     * would name the same username twice, which is not what `--apply` would
     * then do. An apply run does not need it (the loop is sequential, so the
     * first row's write is already visible to the second row's scan); it is
     * kept there as one behaviour rather than two.
     */
    const reserved = new Set<string>();

    for (const user of candidates.results ?? []) {
      let given = (user.given_name ?? "").trim() || null;
      let family = (user.family_name ?? "").trim() || null;

      // The account's own columns win: #1255's backfill already fills them
      // from ORCID, and re-reading the record for a row that has a name is a
      // request spent to learn what we know. ORCID is consulted only for the
      // gap -- a missing FAMILY name, since that is what a username needs.
      if (!family && user.orcid) {
        try {
          const name = await fetchOrcidName(user.orcid, pubBase);
          given = given ?? name.given;
          family = name.family;
        } catch (err) {
          // Transport or HTTP failure. NOT "this record has no name": the row
          // stays a candidate and the next run retries it.
          results.push({
            id: user.id,
            email: user.email,
            orcid: user.orcid,
            outcome: "lookup_failed",
            verify: "not_attempted",
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }

      // The scan-and-pick is `pickUsernameForName`, shared with the sign-in path
      // (#1268, ADR 0045) so both routes suffix collisions the same way. The
      // suggestion is recomputed here only to tell `single_name` from `no_name`,
      // which is a distinction this report makes and that one has no use for.
      const base = suggestUsername(given, family);
      if (!base) {
        // Two different facts, kept apart because they ask different things of
        // the operator: a one-part name needs a human to pick a handle, no
        // name at all needs `nemar admin backfill-names` first. NEITHER is
        // guessed at from the email local part (ADR 0042) -- the production
        // data has 3 single-name rows, and inventing `jsmith` for someone
        // recorded as "Prince" is a handle they never chose.
        results.push({
          id: user.id,
          email: user.email,
          orcid: user.orcid,
          outcome: given || family ? "single_name" : "no_name",
          given_name: given,
          family_name: family,
          verify: "not_attempted",
        });
        continue;
      }

      const pick = await pickUsernameForName(db, given, family, reserved);
      const username = pick.status === "ok" ? pick.username : null;
      if (!username) {
        results.push({
          id: user.id,
          email: user.email,
          orcid: user.orcid,
          outcome: "conflict",
          given_name: given,
          family_name: family,
          verify: "not_attempted",
          error: `No free variant of '${base}' within the suffix limit`,
        });
        continue;
      }
      reserved.add(username.toLowerCase());

      if (!apply) {
        results.push({
          id: user.id,
          email: user.email,
          orcid: user.orcid,
          outcome: "would_assign",
          username,
          given_name: given,
          family_name: family,
          verify: "not_attempted",
        });
        continue;
      }

      const claimed = await usernameClaimStatement(db, user.id, username).run();
      if ((claimed.meta?.changes ?? 0) === 0) {
        results.push({
          id: user.id,
          email: user.email,
          orcid: user.orcid,
          outcome: "conflict",
          username,
          given_name: given,
          family_name: family,
          verify: "not_attempted",
          error: "Row or username changed between the scan and the write",
        });
        continue;
      }

      // ONE verify-your-email message, and only to a row this run just
      // finished. Two reasons it is gated on `assigned` rather than on every
      // unverified candidate: an assigned row stops being a candidate, so no
      // account can ever be mailed twice by this sweep; and a row we could not
      // finish (single_name, lookup_failed) is one an operator still has to
      // touch by hand, so mailing it now would arrive before there is anything
      // to sign in to.
      //
      // The fence inside issueEmailVerificationCode is what makes this safe to
      // run against the dev deployment at all (AGENTS.md): outside production
      // it writes no code row and sends no mail unless the address is a
      // synthetic test target.
      // Never fatal: the username IS written, and a failed message is picked
      // up by the verify-retry pass on the next run.
      //
      // The per-row audit row goes in first, so the sweep's assignments and the
      // sign-in path's carry the same `username_auto_assigned` action and are
      // told apart by `details.source` rather than by which endpoint ran (the
      // batch summary below is a separate, coarser record).
      await recordUsernameAssignment(db, user.id, username, "admin_backfill");

      const verify: BackfillVerifyOutcome =
        user.email_verified === 1
          ? "already_verified"
          : await issueVerification(c.env, user.id, user.email);

      results.push({
        id: user.id,
        email: user.email,
        orcid: user.orcid,
        outcome: "assigned",
        username,
        given_name: given,
        family_name: family,
        verify,
      });
    }

    const assigned = results.filter((r) => r.outcome === "assigned");
    /** One verify outcome's count across both passes. */
    const countVerify = (outcome: BackfillVerifyOutcome): number =>
      results.filter((r) => r.verify === outcome).length +
      verifyRetries.filter((r) => r.verify === outcome).length;

    if (apply && assigned.length > 0) {
      try {
        await auditLogStatement(db, {
          userId: adminUser.id,
          action: "usernames_backfilled",
          resourceType: "user",
          // A batch has no single subject; the ids are in the details.
          resourceId: null,
          details: JSON.stringify({
            assigned: assigned.length,
            user_ids: assigned.map((r) => r.id),
            verify_sent: countVerify("sent"),
          }),
        }).run();
      } catch (auditErr) {
        // Non-fatal, but loud: the usernames are already written.
        console.error("[backfill-usernames] audit log write failed:", auditErr);
      }
    }

    // Counted AFTER the writes, and deliberately non-fatal, for the reason
    // user-names.ts records: a batch that assigned 25 usernames and then failed
    // to COUNT the rest is a success with an unknown remainder, not a failure.
    let remaining: number | null = null;
    let remainingWarning: string | undefined;
    try {
      const row = await db.prepare(REMAINING_SQL).first<{ n: number }>();
      remaining = row?.n ?? 0;
    } catch (countErr) {
      remainingWarning = `Could not count remaining candidates: ${
        countErr instanceof Error ? countErr.message : String(countErr)
      }`;
      console.error("[backfill-usernames] remaining count failed:", countErr);
    }

    return c.json({
      apply,
      scanned: results.length,
      assigned: assigned.length,
      would_assign: results.filter((r) => r.outcome === "would_assign").length,
      single_name: results.filter((r) => r.outcome === "single_name").length,
      no_name: results.filter((r) => r.outcome === "no_name").length,
      lookup_failed: results.filter((r) => r.outcome === "lookup_failed").length,
      conflict: results.filter((r) => r.outcome === "conflict").length,
      // Counted across BOTH passes: an operator reading the summary wants to
      // know how many people were mailed and how many were not, not which loop
      // tried. A failure used to appear in neither the summary nor the exit
      // code, which is how an undelivered message became invisible.
      verify_sent: countVerify("sent"),
      verify_failed: countVerify("failed"),
      verify_rate_limited: countVerify("rate_limited"),
      verify_skipped_fence: countVerify("skipped_fence"),
      /** Rows the verify-retry pass looked at, whether or not it sent. */
      verify_retried: verifyRetries.length,
      // What is left after this batch; a dry run's value includes everything it
      // just listed. `null` means the count itself failed -- never confuse that
      // with "nothing left".
      remaining,
      ...(remainingWarning ? { warning: remainingWarning } : {}),
      results,
      verify_retries: verifyRetries,
    });
  });
}
