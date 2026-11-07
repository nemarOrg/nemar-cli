/**
 * The compute gateway's job commands for an administrator (epic #2005 phase A5, #2010; ADR 0118):
 *
 *   POST /admin/compute/jobs/:id/cancel    cancel a job (at Tapis, and release its hold if it never started)
 *   POST /admin/compute/jobs/:id/advance   one step: submit a `created` job, or read the job back from
 *                                          Tapis and apply it, and repair what a finished job is owed
 *   POST /admin/compute/jobs/:id/move-charge  OWNER: move the charge of a job that skipped the reservation
 *                                          from the partner's pool to a person's (phase D4, #2025)
 *
 * `advance` is the way a job advances in development, where no compute cron runs. Both are the same
 * code the webhook, the 30-minute tick and a person's own cancel run (`advanceComputeJob`,
 * `requestComputeCancel`): an administrator has no second path to a job's state.
 *
 * What an administrator is shown is `jobView`: fixed words, numbers and times, `platform_failure` (an
 * INFORMATION flag, so a NEMAR-caused failure can be compensated by a manual grant: nothing is ever
 * refunded automatically) and the four flags. No identity, no specification, no token, no address and
 * no log. Every refusal is `{ error, code }` with the words of `shared/compute-state.ts`. The routes
 * sit behind the admin router's middleware (authentication, the admin role, the cookie-origin guard).
 */

import { z } from "zod";
import {
  COMPUTE_REFUSAL_STATUS,
  COMPUTE_ROUTE_SENTENCES,
} from "../../../../shared/compute-state.js";
import type { ComputeMoveChargeResponse } from "../../../../shared/contract/compute-admin.js";
import { COMPUTE_JOB_ID_RE } from "../../../../shared/contract/compute.js";
import { getJob } from "../../services/compute-jobs.js";
import { moveCharge } from "../../services/compute-ledger.js";
import {
  advanceComputeJob,
  jobView,
  requestComputeCancel,
} from "../../services/compute-lifecycle.js";
import { fieldPath } from "../../services/compute-policy.js";
import { invalidBody, readJson, refuse, requireOwner } from "./compute.js";
import type { AdminRouter } from "./shared.js";

export function registerComputeJobAdminRoutes(admin: AdminRouter): void {
  admin.post("/compute/jobs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!COMPUTE_JOB_ID_RE.test(id)) {
      return c.json(
        { error: COMPUTE_ROUTE_SENTENCES.job_not_found, code: "job_not_found" },
        COMPUTE_REFUSAL_STATUS.job_not_found,
      );
    }
    const result = await requestComputeCancel(c.env, id, "admin");
    if (!result.ok) {
      const code = result.outcome === "job_not_found" ? "job_not_found" : "bad_state";
      return c.json(
        {
          error:
            code === "bad_state"
              ? "The job has already ended."
              : COMPUTE_ROUTE_SENTENCES.job_not_found,
          code,
        },
        COMPUTE_REFUSAL_STATUS[code],
      );
    }
    const job = await getJob(c.env.DB, id);
    return c.json({ ok: true, outcome: result.outcome, job: job ? jobView(job) : null });
  });

  admin.post("/compute/jobs/:id/advance", async (c) => {
    const id = c.req.param("id");
    if (!COMPUTE_JOB_ID_RE.test(id)) {
      return c.json(
        { error: COMPUTE_ROUTE_SENTENCES.job_not_found, code: "job_not_found" },
        COMPUTE_REFUSAL_STATUS.job_not_found,
      );
    }
    const result = await advanceComputeJob(c.env, id);
    if (result.job === null) {
      return c.json(
        { error: COMPUTE_ROUTE_SENTENCES.job_not_found, code: "job_not_found" },
        COMPUTE_REFUSAL_STATUS.job_not_found,
      );
    }
    return c.json({
      ok: true,
      outcome: result.outcome,
      ...(result.submit === undefined ? {} : { submit: result.submit }),
      job: jobView(result.job),
    });
  });

  // The charge of a job that skipped the reservation, which the tenant sweep wrote to the partner's pool
  // `tenant` and never to a person, moved to a person's pool (phase D4, #2025; ADR 0118, the A7 amendment,
  // item 1: "a ledger operation Epic D's partner-pool phase exposes"). OWNER ONLY: it raises a person's
  // charge, which the interim owner rule (the header of ./compute.ts) keeps with the owner. One batch of
  // two `adjust` entries and an audit row (`moveCharge`); a refusal writes nothing. Idempotent by the job:
  // the same move again is a replay, another account is `already_moved`. The people budget is counted once.
  admin.post("/compute/jobs/:id/move-charge", requireOwner, async (c) => {
    const id = c.req.param("id");
    if (!COMPUTE_JOB_ID_RE.test(id)) return refuse(c, "job_not_found");
    const parsed = z
      .object({
        to_account_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        confirm_unproven_owner: z.boolean().optional(),
      })
      .strict()
      .safeParse(await readJson(c));
    if (!parsed.success) {
      return invalidBody(
        c,
        parsed.error.issues.slice(0, 5).map((i) => ({ path: fieldPath(i.path), code: i.code })),
      );
    }
    const result = await moveCharge(c.env.DB, {
      jobId: id,
      toAccountId: parsed.data.to_account_id,
      actorUserId: c.get("user").id,
      confirmUnprovenOwner: parsed.data.confirm_unproven_owner === true,
    });
    if (!result.ok) return refuse(c, result.code);
    const body: ComputeMoveChargeResponse = {
      job_id: id,
      to_account_id: parsed.data.to_account_id,
      pool: result.pool,
      moved_milli: result.movedMilli,
      replayed: result.replayed,
      attributed_account_id: result.attributedAccountId,
      owner_proven: result.attributedAccountId === parsed.data.to_account_id,
    };
    return c.json(body);
  });
}
