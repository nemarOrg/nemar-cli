/**
 * What a PARTNER's verified job used beyond the hold the person made (epic #2021 phase D4, #2025; ADR 0118,
 * the review rounds of PR #2077). The partner chooses what it launches and the verification cannot see
 * everything the scheduler allocates, so a person is never charged more than they reserved: the person's
 * charge is the hold, and what was used above it is the PARTNER's, an `overrun` of the pool `tenant`
 * (`unreservedChargeStatements`, once per job by its key), counted against the `people` budget, with the job
 * flagged and, when the difference is more than a routine one, a flag word and one audit row.
 *
 * WHO WRITES THE ENTRY. The figure of the observer's final settlement is Expanse's own, so for a job that
 * reaches accounting (it has a Slurm id) the FINAL settlement writes the excess, and the provisional one
 * (`compute-lifecycle.ts`) only caps the person at the hold: a provisional figure built from Tapis's times
 * (a fallback end time, walltime rounding) must never be the partner's bill when a truer one is coming, and
 * the entry is written once per job by its key, so a provisional one could never be corrected (the budget
 * would end above what was truly consumed). A job with NO Slurm id has nothing to correct it, so its
 * provisional settlement writes the excess; and if no final ever arrives for a job that has one, the person
 * is charged the hold (never more) and the partner's excess is not billed. The entry is gated on the
 * person's charge being exactly the hold.
 */

import { COMPUTE_TENANT_POOL_REF } from "../../../shared/compute-state.js";
import type { ComputePool } from "../../../shared/contract/compute.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import { ensurePool, platformPool, unreservedChargeStatements } from "./compute-ledger.js";

/** The audit action of a partner job whose charge to the person was capped at its hold. */
export const PARTNER_CAPPED_ACTION = "compute.partner.final_capped";

/** The flag word of a capped job that used more than a routine difference above its hold. */
export const PARTNER_CAPPED_FLAG = "resources_mismatch";

/** The job is marked: it ran over its hold (information), and a flag word when the difference is not routine. `?1` the job, `?2` 1 to word it. */
export const PARTNER_EXCESS_MARK_SQL = `UPDATE compute_jobs SET flag_overrun = 1,
    flag_mismatch = CASE WHEN ?2 = 1 THEN 1 ELSE flag_mismatch END,
    partner_flag = CASE WHEN ?2 = 1 THEN '${PARTNER_CAPPED_FLAG}' ELSE partner_flag END
  WHERE id = ?1 AND source = 'partner'
    AND EXISTS (SELECT 1 FROM compute_ledger u WHERE u.idempotency_key = 'job:' || ?1 || ':unreserved')`;

/**
 * The gate of the excess entry: the person's charge on the pool of their hold is EXACTLY the hold. The
 * entry is written only after the settlement that capped the person at the hold is in the batch (or already
 * on the ledger), and never for a job whose person was charged anything else. Plain `?`s: the job twice and
 * the hold.
 */
export const PERSON_AT_HOLD_SQL = `(SELECT COALESCE(SUM(c.charged_delta_milli), 0) FROM compute_ledger c
    WHERE c.job_id = ? AND c.pool_id = (SELECT h.pool_id FROM compute_ledger h
                                         WHERE h.kind = 'hold' AND h.job_id = ?)) = ?`;

/**
 * The statements that put `excessMilli` on the partner, for a batch of the caller's own, in the order
 * charge, audit (only if the charge was written and `routine` is false), mark. The charge is gated on
 * {@link PERSON_AT_HOLD_SQL}. `routine` true writes the charge and the information flag only.
 */
export async function partnerExcessStatements(
  db: D1Database,
  input: {
    jobId: string;
    pool: ComputePool;
    client: string | null;
    excessMilli: number;
    routine: boolean;
    /** The hold the person made (`held_milli`): the person must have been charged exactly this. */
    heldMilli: number;
  },
): Promise<D1PreparedStatement[]> {
  const tenant = await ensurePool(db, "partner", COMPUTE_TENANT_POOL_REF, input.pool);
  const people = await platformPool(db, "people", input.pool);
  if (!people) throw new Error("the platform people budget is missing");
  const charge = unreservedChargeStatements(
    db,
    {
      jobId: input.jobId,
      poolId: tenant.id,
      budgetPoolId: people.id,
      chargeMilli: input.excessMilli,
    },
    { sql: PERSON_AT_HOLD_SQL, binds: [input.jobId, input.jobId, input.heldMilli] },
  );
  return [
    ...charge,
    ...(input.routine
      ? []
      : [
          db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
            ...auditLogParams({
              userId: null,
              action: PARTNER_CAPPED_ACTION,
              resourceType: "compute_job",
              resourceId: input.jobId,
              details: JSON.stringify({ flag: PARTNER_CAPPED_FLAG, client: input.client }),
            }),
          ),
        ]),
    db.prepare(PARTNER_EXCESS_MARK_SQL).bind(input.jobId, input.routine ? 0 : 1),
  ];
}
