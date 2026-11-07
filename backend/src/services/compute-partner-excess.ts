/**
 * What a PARTNER's verified job used beyond the hold the person made (epic #2021 phase D4, #2025; ADR 0118,
 * the review rounds of PR #2077). The partner chooses what it launches and the verification cannot see
 * everything the scheduler allocates, so a person is never charged more than they reserved: the person's
 * charge is the hold, and what was used above it is the PARTNER's, an `overrun` of the pool `tenant`
 * (`unreservedChargeStatements`, once per job by its key), counted against the `people` budget, with the job
 * flagged and, when the difference is more than a routine one, a flag word and one audit row.
 *
 * Both settlements use it: the provisional one (`compute-lifecycle.ts`) and the observer's final one
 * (`compute-observer.ts`). Whichever writes the entry first wins the key; the other adds nothing, so the
 * partner is charged the first figure and never twice. A job with no Slurm id and no final settlement is
 * charged to the person by its provisional settlement only, which never exceeds the hold.
 */

import { COMPUTE_TENANT_POOL_REF } from "../../../shared/compute-state.js";
import type { ComputePool } from "../../../shared/contract/compute.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import { ensurePool, platformPool, unreservedChargeStatements } from "./compute-ledger.js";
import type { HoldGuard } from "./compute-ledger.js";

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
 * The statements that put `excessMilli` on the partner, for a batch of the caller's own, in the order
 * charge, audit (only if the charge was written and `routine` is false), mark. `gate` is ANDed into the
 * charge. `routine` true writes the charge and the information flag only.
 */
export async function partnerExcessStatements(
  db: D1Database,
  input: {
    jobId: string;
    pool: ComputePool;
    client: string | null;
    excessMilli: number;
    routine: boolean;
    gate?: HoldGuard;
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
    input.gate,
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
