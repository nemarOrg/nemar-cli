/**
 * Admin route: backfill missing researcher names from ORCID (#1255, epic #1250).
 *
 * DOIs cite the uploader by real name, and publishing is blocked for an
 * account whose `given_name`/`family_name` are missing. Most existing
 * accounts predate the signup-time ORCID name lookup, so they carry an ORCID
 * but no name -- which this closes without asking anyone to retype something
 * ORCID already publishes.
 *
 * Lives in its own domain file rather than in users.ts: it is one endpoint
 * with one concern, and keeping it separate keeps it out of the way of the
 * account-listing work happening in that file.
 *
 * DRY RUN BY DEFAULT. `apply: true` is the only thing that writes, and the
 * dry run reports exactly the rows the write would touch, so an operator can
 * read the plan before executing it.
 *
 * SAFETY (the shared dev/prod users table, AGENTS.md): the only external call
 * is a credential-free GET against ORCID's PUBLIC record API. Nothing is
 * emailed, no GitHub work is dispatched, no DOI is touched. The only write is
 * to two name columns, and only for rows that have none.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { auditLogStatement } from "../../db/audit-log";
import { fetchOrcidName, orcidPubBase } from "../../services/orcid-auth";
import type { AdminRouter } from "./shared";

/** Per-user result. `error` never aborts the batch: one unreadable record
 *  must not stop the other 600 from being filled. */
export type BackfillOutcome = "filled" | "would_fill" | "no_public_name" | "lookup_failed";

export interface BackfillUserResult {
  id: number;
  username: string | null;
  email: string;
  orcid: string;
  outcome: BackfillOutcome;
  given_name?: string | null;
  family_name?: string | null;
  error?: string;
}

const backfillSchema = z.object({
  /** Write the names. Omitted or false = report what WOULD be written. */
  apply: z.boolean().optional().default(false),
  /** Users per batch. Each one costs an ORCID request, so the batch is
   *  bounded well inside the Worker's subrequest budget. */
  limit: z.number().int().min(1).max(100).optional().default(25),
});

/** Candidates: live accounts with an ORCID and no citable name. Whitespace
 *  counts as absent, matching `resolveUploaderIdentity`'s trim. */
const CANDIDATES_SQL = `SELECT id, username, email, orcid
   FROM users
   WHERE deleted_at IS NULL
     AND orcid IS NOT NULL AND TRIM(orcid) != ''
     AND (given_name IS NULL OR TRIM(given_name) = ''
          OR family_name IS NULL OR TRIM(family_name) = '')
   ORDER BY id
   LIMIT ?`;

/** Same predicate, counted, so the response can say how much is left. */
const REMAINING_SQL = `SELECT COUNT(*) as n
   FROM users
   WHERE deleted_at IS NULL
     AND orcid IS NOT NULL AND TRIM(orcid) != ''
     AND (given_name IS NULL OR TRIM(given_name) = ''
          OR family_name IS NULL OR TRIM(family_name) = '')`;

export function registerUserNameRoutes(admin: AdminRouter): void {
  /**
   * POST /admin/users/backfill-names - fill NULL researcher names from ORCID
   *
   * Body: `{ apply?: boolean, limit?: number }`. Idempotent: a filled row
   * stops matching the candidate predicate, so re-running walks forward.
   */
  admin.post("/users/backfill-names", zValidator("json", backfillSchema), async (c) => {
    const { apply, limit } = c.req.valid("json");
    const db = c.env.DB;
    const adminUser = c.get("user");

    const candidates = await db
      .prepare(CANDIDATES_SQL)
      .bind(limit)
      .all<{ id: number; username: string | null; email: string; orcid: string }>();

    const pubBase = orcidPubBase(c.env);
    const results: BackfillUserResult[] = [];

    for (const user of candidates.results ?? []) {
      let given: string | null;
      let family: string | null;
      try {
        const name = await fetchOrcidName(user.orcid, pubBase);
        given = name.given;
        family = name.family;
      } catch (err) {
        // A transport or HTTP failure is NOT "this record has no name": the
        // row stays a candidate and the next run retries it.
        results.push({
          id: user.id,
          username: user.username,
          email: user.email,
          orcid: user.orcid,
          outcome: "lookup_failed",
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!given || !family) {
        // Half a name is not citable, so it is not written: a row with
        // given_name set and family_name NULL still blocks publishing, and
        // would look filled to the next operator reading the table.
        results.push({
          id: user.id,
          username: user.username,
          email: user.email,
          orcid: user.orcid,
          outcome: "no_public_name",
          given_name: given,
          family_name: family,
        });
        continue;
      }

      if (apply) {
        // The WHERE re-states the candidate predicate so a name written
        // between the SELECT and here (a concurrent ORCID re-link, another
        // operator's run) is never overwritten by this batch's older read.
        await db
          .prepare(
            `UPDATE users
               SET given_name = ?, family_name = ?
             WHERE id = ?
               AND deleted_at IS NULL
               AND (given_name IS NULL OR TRIM(given_name) = ''
                    OR family_name IS NULL OR TRIM(family_name) = '')`,
          )
          .bind(given, family, user.id)
          .run();
      }

      results.push({
        id: user.id,
        username: user.username,
        email: user.email,
        orcid: user.orcid,
        outcome: apply ? "filled" : "would_fill",
        given_name: given,
        family_name: family,
      });
    }

    const filled = results.filter((r) => r.outcome === "filled").length;

    if (apply && filled > 0) {
      try {
        await auditLogStatement(db, {
          userId: adminUser.id,
          action: "user_names_backfilled",
          resourceType: "user",
          // A batch has no single subject; the ids are in the details.
          resourceId: null,
          details: JSON.stringify({
            filled,
            user_ids: results.filter((r) => r.outcome === "filled").map((r) => r.id),
          }),
        }).run();
      } catch (auditErr) {
        // Non-fatal, but loud: the names are already written.
        console.error("[backfill-names] audit log write failed:", auditErr);
      }
    }

    const remaining = await db.prepare(REMAINING_SQL).first<{ n: number }>();

    return c.json({
      apply,
      scanned: results.length,
      filled,
      would_fill: results.filter((r) => r.outcome === "would_fill").length,
      no_public_name: results.filter((r) => r.outcome === "no_public_name").length,
      lookup_failed: results.filter((r) => r.outcome === "lookup_failed").length,
      // Counted AFTER the writes, so an apply run's value is what is left to
      // do; a dry run's value includes everything it just listed.
      remaining: remaining?.n ?? 0,
      results,
    });
  });
}
