/**
 * The compute gateway's READ routes (epic #2021 phase D2, #2023; ADR 0118 and ADR 0119, the addenda of
 * this phase), registered into the `/compute` router by `registerComputeReadRoutes`:
 *
 *   GET /compute/me              the caller's access, pools, limits and queue estimates
 *   GET /compute/me/usage        the caller's net charge by day, app, partition and source
 *   GET /compute/me/jobs         the caller's jobs, newest first, paged
 *   GET /compute/me/jobs/:id     one of the caller's jobs (live ones are refreshed from Tapis when stale)
 *   GET /compute/stats           platform-wide aggregates, for a partner's CLIENT
 *
 * THE CREDENTIAL RULE is `./auth.ts`. A `/compute/me*` route answers for the credential's OWN account
 * and for nobody else's, in EVERY access state (`none`, `requested`, `suspended`, `denied` and `revoked`
 * included, so a partner can say why a launch is refused); it is the submit route (phase D3) that asks
 * `canUseCompute`. `/compute/stats` is a client's, and carries no account, subject, name or email.
 *
 * NO COMPUTE SWITCH IS READ. These are reads of the ledger and the job index, so they work with compute
 * off. The one thing that reaches the network is the refresh of a live job on `GET /me/jobs/:id`, and it
 * is skipped, with `stale: true`, in the read-only maintenance mode (a GET that writes must not write
 * while the platform is frozen for a migration).
 *
 * REFUSALS are `{ error: <sentence>, code: <word> }` with the statuses of `COMPUTE_USER_ERROR_STATUS`.
 * A job that is not the caller's is `job_not_found` (404), the same as an absent one: neither route
 * is an oracle for another person's job id. The responses are `shared/contract/compute-user.ts`.
 */

import type { Context, Hono } from "hono";
import {
  COMPUTE_REFUSAL_STATUS,
  COMPUTE_ROUTE_SENTENCES,
  type ComputeState,
  isComputeState,
  isTerminalComputeState,
} from "../../../../shared/compute-state.js";
import {
  COMPUTE_JOBS_PAGE_DEFAULT,
  COMPUTE_JOBS_PAGE_MAX,
  COMPUTE_USER_ERROR_STATUS,
  COMPUTE_USER_SENTENCES,
  type ComputeStatsResponse,
  type ComputeUserErrorCode,
} from "../../../../shared/contract/compute-user.js";
import { maintenanceRefuses } from "../../middleware/maintenance.js";
import { advanceComputeJob } from "../../services/compute-lifecycle.js";
import { ComputePolicyUnreadable } from "../../services/compute-policy.js";
import {
  type UserJobRecord,
  accountUsage,
  computeMe,
  getUserJob,
  listUserJobs,
  parseCursor,
  parseGroups,
  platformCounts,
  platformUsage,
  resolveWindow,
  userJobView,
} from "../../services/compute-user-reads.js";
import type { Bindings, Variables } from "../../types/bindings.js";
import { computePersonCredential, computeStatsCredential } from "./auth.js";

type Env = { Bindings: Bindings; Variables: Variables };
type Ctx = Context<Env>;

/** A stored Tapis read older than this is read again on `GET /me/jobs/:id`. */
export const JOB_REFRESH_AFTER_MS = 60_000;

/** What `advanceComputeJob` answers when it read the job back from Tapis and applied it. */
const FRESH_OUTCOMES: ReadonlySet<string> = new Set([
  "advanced",
  "refreshed",
  "terminal_committed",
  "terminal",
]);

function sentenceFor(code: ComputeUserErrorCode): string {
  if (code === "job_not_found" || code === "policy_unavailable") {
    return COMPUTE_ROUTE_SENTENCES[code];
  }
  return COMPUTE_USER_SENTENCES[code];
}

function refuse(c: Ctx, code: ComputeUserErrorCode) {
  const status =
    code === "job_not_found" || code === "policy_unavailable"
      ? COMPUTE_REFUSAL_STATUS[code]
      : COMPUTE_USER_ERROR_STATUS[code];
  return c.json({ error: sentenceFor(code), code }, status as 400 | 401 | 403 | 404 | 503);
}

/** The caller's account, from the credential rule. A `/me*` route never runs without a person. */
function callerId(c: Ctx): number | null {
  const credential = c.get("computeCredential");
  return credential?.kind === "user" ? credential.userId : null;
}

/** The decimal digits of a whole number, or null. `Number("1e2")` and `" 5"` are not limits. */
function wholeNumber(text: string): number | null {
  return /^[0-9]{1,9}$/.test(text) ? Number(text) : null;
}

/** Parse a live job's staleness from the stored read time (UTC text) and refresh it from Tapis once. */
async function refreshLiveJob(
  env: Bindings,
  job: UserJobRecord,
  nowMs: number,
): Promise<{ stale: boolean }> {
  // Only a job that is on the cluster is read back; a `created` job has nothing to read, and this route
  // never submits (that would read the compute switch from a GET).
  if (isTerminalComputeState(job.state as ComputeState) || job.tapis_uuid === null)
    return { stale: false };
  const lastGood = job.tapis_synced_at ?? job.submitted_at ?? job.created_at;
  const lastGoodMs = Date.parse(`${lastGood.replace(" ", "T")}Z`);
  if (Number.isFinite(lastGoodMs) && nowMs - lastGoodMs <= JOB_REFRESH_AFTER_MS) {
    return { stale: false };
  }
  if (maintenanceRefuses(env.MAINTENANCE_MODE, "write")) return { stale: true };
  try {
    const advanced = await advanceComputeJob(env, job.id, { nowMs });
    return { stale: !FRESH_OUTCOMES.has(advanced.outcome) };
  } catch (err) {
    // The class of the failure only: a Tapis error may carry an address or a body.
    console.warn(
      `[compute-read] refresh failed job=${job.id} class=${(err as Error)?.name ?? "Error"}`,
    );
    return { stale: true };
  }
}

export function registerComputeReadRoutes(routes: Hono<Env>): void {
  routes.get("/me", computePersonCredential, async (c) => {
    const accountId = callerId(c);
    if (accountId === null) return refuse(c, "forbidden_credential");
    try {
      const body = await computeMe(c.env, accountId);
      c.header("Cache-Control", "private, no-store");
      return c.json(body);
    } catch (err) {
      // The limits cannot be stated without the owner's policy, and the default is not what the owner
      // set: say so, rather than answer figures that may be wrong.
      if (err instanceof ComputePolicyUnreadable) return refuse(c, "policy_unavailable");
      throw err;
    }
  });

  routes.get("/me/usage", computePersonCredential, async (c) => {
    const accountId = callerId(c);
    if (accountId === null) return refuse(c, "forbidden_credential");
    const window = resolveWindow({ from: c.req.query("from"), to: c.req.query("to") }, Date.now());
    if (window === null) return refuse(c, "invalid_range");
    const groupText = c.req.query("group");
    const groups = groupText === undefined ? [] : parseGroups(groupText);
    if (groups === null) return refuse(c, "invalid_group");
    const rows = await accountUsage(c.env.DB, accountId, window, groups);
    c.header("Cache-Control", "private, no-store");
    return c.json({ from: window.from, to: window.to, group: groups, rows });
  });

  routes.get("/me/jobs", computePersonCredential, async (c) => {
    const accountId = callerId(c);
    if (accountId === null) return refuse(c, "forbidden_credential");
    const stateText = c.req.query("state");
    if (stateText !== undefined && !isComputeState(stateText)) return refuse(c, "invalid_state");
    const limitText = c.req.query("limit");
    let limit: number = COMPUTE_JOBS_PAGE_DEFAULT;
    if (limitText !== undefined) {
      const parsed = wholeNumber(limitText);
      if (parsed === null || parsed < 1 || parsed > COMPUTE_JOBS_PAGE_MAX) {
        return refuse(c, "invalid_limit");
      }
      limit = parsed;
    }
    const afterText = c.req.query("after");
    const cursor = afterText === undefined ? undefined : parseCursor(afterText);
    if (cursor === null) return refuse(c, "invalid_cursor");
    const page = await listUserJobs(c.env.DB, accountId, {
      ...(stateText === undefined ? {} : { state: stateText }),
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    c.header("Cache-Control", "private, no-store");
    return c.json(page);
  });

  routes.get("/me/jobs/:id", computePersonCredential, async (c) => {
    const accountId = callerId(c);
    if (accountId === null) return refuse(c, "forbidden_credential");
    const id = c.req.param("id");
    // One answer for an id that cannot be a job, one that is absent and one that is a stranger's: the
    // statement carries the account, so none of them finds a row.
    const found = await getUserJob(c.env.DB, accountId, id);
    if (!found) return refuse(c, "job_not_found");
    const { stale } = await refreshLiveJob(c.env, found, Date.now());
    // Read again: the refresh may have moved the job (and settled it).
    const job = (await getUserJob(c.env.DB, accountId, id)) ?? found;
    c.header("Cache-Control", "private, no-store");
    return c.json({ job: userJobView(job), stale });
  });

  routes.get("/stats", computeStatsCredential, async (c) => {
    const window = resolveWindow({ from: c.req.query("from"), to: c.req.query("to") }, Date.now());
    if (window === null) return refuse(c, "invalid_range");
    const [rows, counts] = await Promise.all([
      platformUsage(c.env.DB, window),
      platformCounts(c.env.DB, window),
    ]);
    const body: ComputeStatsResponse = {
      from: window.from,
      to: window.to,
      by_day_partition_source: rows,
      active_people: counts.active_people,
      jobs_by_outcome: counts.jobs_by_outcome,
    };
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });
}
