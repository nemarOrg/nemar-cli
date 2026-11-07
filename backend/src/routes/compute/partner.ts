/**
 * The partner's routes (epic #2021 phase D4, #2025; ADR 0118 and ADR 0119, the amendments of this phase),
 * registered into the `/compute` router by `registerComputePartnerRoutes`:
 *
 *   POST   /compute/holds             reserve compute time for a signed-in person: 201
 *   POST   /compute/jobs/:id/report   report the Tapis job launched under the reservation: 200 or 202
 *   DELETE /compute/holds/:id         release a reservation nothing was launched under: 200
 *
 * THE CREDENTIAL is an OpenID Connect access token carrying `compute.reserve`, issued to a PERSON, through
 * `routes/compute/auth.ts` (`computePartnerCredential`): a CLI key or the session cookie is 403
 * `forbidden_credential`, a missing scope 403 `insufficient_scope`, a token whose audience does not name
 * this API 403 `wrong_audience`, and a disabled client or a revoked grant is refused by `oidcBearer`. Every
 * write needs an `Idempotency-Key` (`^[A-Za-z0-9._:-]{1,64}$`, else 400 `idempotency_key_required`).
 *
 * THE CONTRACT, the order of every refusal and the words are `shared/contract/compute-partner.ts` and
 * `services/compute-partner.ts`. Every response is `Cache-Control: no-store`: an upload address is a bearer
 * secret. The routes read no compute switch (`compute-source-scan.test.ts` pins that), and read the body
 * under a bound before anything in it is trusted. Nothing the partner sent is logged.
 */

import type { Context, Hono } from "hono";
import {
  COMPUTE_PARTNER_ERROR_STATUS,
  COMPUTE_PARTNER_IDEMPOTENCY_HEADER,
  COMPUTE_PARTNER_KEY_RE,
  COMPUTE_PARTNER_REPLAYED_HEADER,
  COMPUTE_PARTNER_SENTENCES,
} from "../../../../shared/contract/compute-partner.js";
import {
  COMPUTE_HOLD_BODY_MAX_BYTES,
  COMPUTE_REPORT_BODY_MAX_BYTES,
  ComputeReportRequestSchema,
} from "../../../../shared/contract/compute-partner-request.js";
import {
  type PartnerCaller,
  type PartnerRefusal,
  partnerScope,
  releaseReservation,
  reportJob,
  reserveHold,
} from "../../services/compute-partner.js";
import { ComputePolicyUnreadable, fieldPath } from "../../services/compute-policy.js";
import type { Bindings, Variables } from "../../types/bindings.js";
import { readCapped } from "../callbacks/bounded-json.js";
import { computePartnerCredential } from "./auth.js";
import { NO_STORE } from "./shared.js";

type Env = { Bindings: Bindings; Variables: Variables };
type Ctx = Context<Env>;

/** A refusal in the partner's table: the sentence, the word, and where it applies the field or the mismatch. */
function refusal(c: Ctx, r: PartnerRefusal): Response {
  return c.json(
    {
      error: COMPUTE_PARTNER_SENTENCES[r.code],
      code: r.code,
      ...(r.field === undefined ? {} : { field: r.field }),
      ...(r.mismatch === undefined ? {} : { mismatch: r.mismatch }),
      ...(r.job_id === undefined ? {} : { job_id: r.job_id }),
    },
    COMPUTE_PARTNER_ERROR_STATUS[r.code],
    { ...NO_STORE },
  );
}

const bad = (c: Ctx, code: PartnerRefusal["code"], field?: string): Response =>
  refusal(c, { ok: false, code, ...(field === undefined ? {} : { field }) });

/** The person and the client a verified token names (the credential rule has already run). */
function callerOf(c: Ctx): PartnerCaller {
  const credential = c.get("computeCredential");
  const token = c.get("oidcToken");
  if (credential?.kind !== "user" || token === undefined) {
    // Unreachable behind `computePartnerCredential`; fails closed if a route is ever mounted without it.
    throw new Error("a partner route was reached without its credential");
  }
  return {
    userId: credential.userId,
    clientId: token.client.clientId,
    scope: partnerScope(token.client.clientId),
  };
}

/** The `Idempotency-Key` header, or null when it is absent or not the contract's shape. */
function keyOf(c: Ctx): string | null {
  const key = c.req.header(COMPUTE_PARTNER_IDEMPOTENCY_HEADER);
  return key !== undefined && COMPUTE_PARTNER_KEY_RE.test(key) ? key : null;
}

/**
 * The body as the exact text that was sent, read under a bound before anything in it is trusted: by the
 * declared length and by the bytes that arrive. Invalid UTF-8 is refused (the text is kept byte for byte as
 * the reservation's record, so it must be text). A byte order mark is kept, and then is not JSON.
 */
async function bodyText(c: Ctx, max: number): Promise<{ ok: true; text: string } | Response> {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return bad(c, "invalid_spec", "body");
  let raw: Uint8Array | null;
  try {
    raw = await readCapped(c.req.raw, max);
  } catch {
    return bad(c, "invalid_spec", "body");
  }
  if (raw === null) return bad(c, "invalid_spec", "body");
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw) };
  } catch {
    return bad(c, "invalid_spec", "body");
  }
}

/** A service call, with the policy fault every route shares answered as the contract says. */
async function guarded(c: Ctx, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ComputePolicyUnreadable) return bad(c, "policy_unavailable");
    throw err;
  }
}

async function reserve(c: Ctx): Promise<Response> {
  const key = keyOf(c);
  if (key === null) return bad(c, "idempotency_key_required");
  const caller = callerOf(c);
  const read = await bodyText(c, COMPUTE_HOLD_BODY_MAX_BYTES);
  if (read instanceof Response) return read;
  return guarded(c, async () => {
    const result = await reserveHold(c.env, caller, key, read.text);
    if (!result.ok) return refusal(c, result);
    return c.json(result.body, 201, {
      ...NO_STORE,
      ...(result.replayed ? { [COMPUTE_PARTNER_REPLAYED_HEADER]: "true" } : {}),
    });
  });
}

async function report(c: Ctx): Promise<Response> {
  const key = keyOf(c);
  if (key === null) return bad(c, "idempotency_key_required");
  const caller = callerOf(c);
  const read = await bodyText(c, COMPUTE_REPORT_BODY_MAX_BYTES);
  if (read instanceof Response) return read;
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    return bad(c, "invalid_spec", "body");
  }
  const parsed = ComputeReportRequestSchema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    return bad(c, "invalid_spec", path.length > 0 ? fieldPath(path) : "body");
  }
  return guarded(c, async () => {
    const result = await reportJob(c.env, caller, c.req.param("id") ?? "", key, read.text, parsed.data);
    if (!result.ok) return refusal(c, result);
    return c.json(result.body, result.status, {
      ...NO_STORE,
      ...(result.body.replayed ? { [COMPUTE_PARTNER_REPLAYED_HEADER]: "true" } : {}),
    });
  });
}

async function release(c: Ctx): Promise<Response> {
  const key = keyOf(c);
  if (key === null) return bad(c, "idempotency_key_required");
  const caller = callerOf(c);
  return guarded(c, async () => {
    const result = await releaseReservation(c.env, caller, c.req.param("id") ?? "", key);
    if (!result.ok) return refusal(c, result);
    return c.json(result.body, 200, {
      ...NO_STORE,
      ...(result.body.replayed ? { [COMPUTE_PARTNER_REPLAYED_HEADER]: "true" } : {}),
    });
  });
}

export function registerComputePartnerRoutes(routes: Hono<Env>): void {
  routes.post("/holds", computePartnerCredential, reserve);
  routes.post("/jobs/:id/report", computePartnerCredential, report);
  routes.delete("/holds/:id", computePartnerCredential, release);
}
