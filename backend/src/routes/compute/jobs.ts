/**
 * A person's job routes (epic #2021 phase D3, #2024; ADR 0118, the amendment of this phase), registered
 * into the `/compute` router by `registerComputeJobRoutes`:
 *
 *   POST /compute/jobs                     submit (`Idempotency-Key` optional): 201, an upload address for a bundle
 *   POST /compute/jobs/:id/finalize        the bundle is uploaded: record it and submit: 200
 *   GET  /compute/jobs/:id/logs            plain text, at most 1 MiB (`X-Nemar-Truncated: true` when cut)
 *   GET  /compute/jobs/:id/results         seven-day links to a finished job's outputs (bearer links)
 *   POST /compute/jobs/:id/results/renew   the same links, made again while the objects exist
 *
 * (The person's cancel and links stay in `./index.ts`.) THE CREDENTIAL is a CLI key or the session cookie,
 * through `authMiddleware`; a write made with a cookie also passes `cookieOriginGuard`. An OpenID Connect
 * access token is REFUSED here by `resolveApiKeyUser` (its `nmo_` prefix): `compute.submit` is granted to
 * no client yet, and `test/oidc-token-allowlist.test.ts` holds every one of these paths to that.
 *
 * THE ORDER OF REFUSAL of `POST /compute/jobs` is `services/compute-submit.ts`'s header. The other routes
 * answer for the job's OWNER ONLY: any other account, an administrator included, a job that does not
 * exist and a malformed id are the same 404 `job_not_found`, so no route is an oracle for another
 * person's job id. They need compute access only to START a job (submit); a person can always finalize,
 * cancel, read the log of and fetch the results of what is theirs (a suspension cancels the live jobs).
 *
 * NO ROUTE HERE READS THE COMPUTE SWITCH (`compute-source-scan.test.ts` pins that): a submission made
 * while compute is off takes its hold and waits for the reservation wait, and the log, the results and
 * the finalize work as they always do.
 *
 * EVERY RESPONSE IS `Cache-Control: no-store`: an upload address and a results link are bearer secrets.
 * Nothing a person chose is logged: a log line carries a job id and a fixed word.
 */

import type { Hono } from "hono";
import { COMPUTE_REFUSAL_STATUS } from "../../../../shared/compute-state.js";
import { BUNDLE_BODY_MAX_BYTES } from "../../../../shared/contract/compute-bundle.js";
import {
  COMPUTE_BEARER_NOTICE,
  COMPUTE_IDEMPOTENCY_HEADER,
  COMPUTE_REPLAYED_HEADER,
  COMPUTE_SUBMIT_KEY_RE,
  COMPUTE_TRUNCATED_HEADER,
} from "../../../../shared/contract/compute-submit.js";
import { isSafeComputePath } from "../../../../shared/contract/compute.js";
import { authMiddleware, cookieOriginGuard } from "../../middleware/auth.js";
import { readJobLog } from "../../services/compute-logs.js";
import { ComputePolicyUnreadable } from "../../services/compute-policy.js";
import { mintResultLinks } from "../../services/compute-results.js";
import {
  accessRefusal,
  finalizePersonJob,
  submitPersonJob,
} from "../../services/compute-submit.js";
import type { Bindings, Variables } from "../../types/bindings.js";
import { readBoundedJsonObject } from "../callbacks/bounded-json.js";
import { type ComputeCtx, NO_STORE, ownJob, refuseWith } from "./shared.js";

type Env = { Bindings: Bindings; Variables: Variables };

/** The longest `after` cursor of a results page: a path, as the links route bounds it. */
const CURSOR_MAX = 512;

/** True when the request carries a body worth reading (a declared zero length, or none, is no body). */
const hasBody = (c: ComputeCtx): boolean =>
  c.req.raw.body !== null && c.req.header("Content-Length") !== "0";

async function submit(c: ComputeCtx): Promise<Response> {
  const user = c.get("user");
  // 1. Compute access, before the body is read: a person without it is told so, not what is wrong with
  // a specification they may not use.
  const access = await accessRefusal(c.env.DB, user.id);
  if (access !== null) return refuseWith(c, access);
  // 2. The key's shape.
  const rawKey = c.req.header(COMPUTE_IDEMPOTENCY_HEADER);
  if (rawKey !== undefined && !COMPUTE_SUBMIT_KEY_RE.test(rawKey)) {
    return refuseWith(c, "invalid_spec", COMPUTE_IDEMPOTENCY_HEADER);
  }
  const read = await readBoundedJsonObject(c, BUNDLE_BODY_MAX_BYTES);
  if (!read.ok) return refuseWith(c, "invalid_spec", "body", read.status);
  let result: Awaited<ReturnType<typeof submitPersonJob>>;
  try {
    result = await submitPersonJob(c.env, user.id, read.body, rawKey ?? null);
  } catch (err) {
    if (err instanceof ComputePolicyUnreadable) return refuseWith(c, "policy_unavailable");
    throw err;
  }
  if (!result.ok) return refuseWith(c, result.code, result.field, undefined, result.job_id);
  return c.json(result.body, 201, {
    ...NO_STORE,
    ...(result.replayed ? { [COMPUTE_REPLAYED_HEADER]: "true" } : {}),
  });
}

async function finalize(c: ComputeCtx): Promise<Response> {
  const job = await ownJob(c.env, c.req.param("id") ?? "", c.get("user").id);
  if (!job) return refuseWith(c, "job_not_found");
  let body: Record<string, unknown> | null = null;
  if (hasBody(c)) {
    const read = await readBoundedJsonObject(c, BUNDLE_BODY_MAX_BYTES);
    if (!read.ok) return refuseWith(c, "invalid_spec", "body", read.status);
    body = read.body;
  }
  const result = await finalizePersonJob(c.env, job, body);
  if (!result.ok) return refuseWith(c, result.code, result.field);
  return c.json(result.body, 200, { ...NO_STORE });
}

async function logs(c: ComputeCtx): Promise<Response> {
  const job = await ownJob(c.env, c.req.param("id") ?? "", c.get("user").id);
  if (!job) return refuseWith(c, "job_not_found");
  const log = await readJobLog(c.env, job);
  if (!log.ok) return refuseWith(c, log.code);
  // The job's own bytes, as they are: plain text, never sniffed, never cached, never logged.
  return new Response(log.bytes, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...NO_STORE,
      ...(log.truncated ? { [COMPUTE_TRUNCATED_HEADER]: "true" } : {}),
    },
  });
}

async function results(c: ComputeCtx): Promise<Response> {
  const job = await ownJob(c.env, c.req.param("id") ?? "", c.get("user").id);
  if (!job) return refuseWith(c, "job_not_found");
  const after = c.req.query("after") ?? null;
  if (after !== null && !isSafeComputePath(after, CURSOR_MAX)) {
    return refuseWith(c, "invalid_spec", "after");
  }
  const made = await mintResultLinks(c.env, job, after);
  if (!made.ok) return refuseWith(c, made.code, undefined, COMPUTE_REFUSAL_STATUS[made.code]);
  // Bearer links: in this answer and nowhere else, never logged, never mailed.
  return c.json(
    {
      expires_at: made.expires_at,
      files: made.links,
      total: made.total,
      truncated: made.truncated,
      next_after: made.next_after,
      bearer_links: true,
      notice: COMPUTE_BEARER_NOTICE,
    },
    200,
    { ...NO_STORE },
  );
}

export function registerComputeJobRoutes(routes: Hono<Env>): void {
  routes.post("/jobs", authMiddleware, cookieOriginGuard, submit);
  routes.post("/jobs/:id/finalize", authMiddleware, cookieOriginGuard, finalize);
  routes.get("/jobs/:id/logs", authMiddleware, logs);
  routes.get("/jobs/:id/results", authMiddleware, results);
  routes.post("/jobs/:id/results/renew", authMiddleware, cookieOriginGuard, results);
}
