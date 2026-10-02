/**
 * `exchangePrivateGrant` and `revokePrivateSession`: the two writing methods
 * of the service-binding entrypoint (ADR 0078), and the private site's half of
 * the session handoff (ADR 0079). The grant half is `POST /auth/private/grant`
 * in `routes/auth-private.ts`; the SQL is `services/private-auth.ts`.
 *
 * MAINTENANCE MODE IS MIRRORED HERE BY HAND. RPC bypasses the HTTP middleware
 * stack, so `maintenanceMode` never sees these calls. Both methods are writes,
 * so in `read-only` and `full` they answer `unavailable` instead of writing,
 * which is what `POST /auth/docs/exchange` and `/auth/logout` get from the
 * middleware in the same modes (`maintenanceRefuses`, the middleware's own
 * rule).
 */

import type {
  ExchangePrivateGrantResult,
  RevokePrivateSessionResult,
} from "../../../shared/contract/private-site.js";
import { PRIVATE_SESSION_TTL_SECONDS } from "../../../shared/contract/private-site.js";
import { maintenanceRefuses } from "../middleware/maintenance";
import { hashGrantCode } from "../services/docs-auth";
import {
  PRIVATE_MINT_CONSUME_SQL,
  PRIVATE_MINT_INSERT_SQL,
  PRIVATE_REVOKE_ONE_SQL,
  grantState,
} from "../services/private-auth";
import {
  type BackgroundContext,
  generateCookieId,
  hashCookieId,
  hashIp,
} from "../services/web-session";
import type { Bindings } from "../types/bindings";
import { MAX_CREDENTIAL_LENGTH, boundedString } from "./input";
import { resolveSessionPrincipal } from "./principal";

/** The same bound `POST /auth/docs/exchange` puts on a code. */
const MAX_CODE_LENGTH = 256;

/** Diagnostics only, so bounded rather than refused: a longer user agent is
 *  cut, and an address longer than any IPv6 spelling is dropped. */
const MAX_USER_AGENT_LENGTH = 512;
const MAX_CLIENT_IP_LENGTH = 64;

/**
 * Trade a one-time grant code for a private-site session.
 *
 * Unauthenticated by design, like the docs exchange: only the holder of the
 * code can spend it, it lives sixty seconds, and it mints only with the
 * `state` of the browser that asked for it. The mint re-checks the account
 * inside the inserting statement, so this function's own job is small: hash
 * the code and the state, run the batch, report whether anything was created.
 *
 * Every refusal is a value. The one throw is after the grant is spent: a
 * session that was minted and then does not resolve is a fault, not a refusal
 * (see below).
 */
export async function exchangePrivateGrant(
  env: Bindings,
  request: unknown,
  ctx?: BackgroundContext,
): Promise<ExchangePrivateGrantResult> {
  if (maintenanceRefuses(env.MAINTENANCE_MODE, "write")) return { ok: false, error: "unavailable" };

  const fields = (typeof request === "object" && request !== null ? request : {}) as {
    code?: unknown;
    state?: unknown;
    userAgent?: unknown;
    clientIp?: unknown;
  };
  const code = boundedString(fields.code, MAX_CODE_LENGTH);
  // A missing or malformed state is the same answer as a mismatched one: the
  // mint below requires the hash to match, and a caller holding a stolen code
  // learns nothing from which of the two it got wrong.
  const state = grantState(fields.state);
  if (code === null || state === null) return { ok: false, error: "invalid_grant" };

  const codeHash = await hashGrantCode(code);
  const sessionValue = generateCookieId();
  const cookieIdHash = await hashCookieId(sessionValue);
  // The visitor as the private site saw them, recorded for diagnostics only.
  // The address is hashed with the same helper every other session row uses,
  // and never stored as sent.
  const userAgent =
    typeof fields.userAgent === "string" && fields.userAgent.length > 0
      ? fields.userAgent.slice(0, MAX_USER_AGENT_LENGTH)
      : null;
  const ipHash = await hashIp(boundedString(fields.clientIp, MAX_CLIENT_IP_LENGTH));

  const results = await env.DB.batch([
    env.DB.prepare(PRIVATE_MINT_INSERT_SQL).bind(
      cookieIdHash,
      PRIVATE_SESSION_TTL_SECONDS,
      userAgent,
      ipHash,
      codeHash,
      await hashGrantCode(state),
    ),
    env.DB.prepare(PRIVATE_MINT_CONSUME_SQL).bind(codeHash, cookieIdHash),
  ]);

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    // One answer for a code that never existed, one already spent, one
    // expired, and one whose account stopped qualifying. Splitting them would
    // tell a caller holding a stolen code which kind of dead end it is.
    return { ok: false, error: "invalid_grant" };
  }

  // Read the session back through the function every later `resolvePrincipal`
  // uses, so this answer cannot disagree with the next one for the same value.
  const resolved = await resolveSessionPrincipal(env, sessionValue, ctx);
  if (!resolved.ok) {
    // The mint just gated on the same account rule, so this is a fault (the
    // account changed in the microseconds between, or its role column holds
    // an unrecognised value), not a refusal the caller can act on. Thrown, so
    // the caller fails closed. The row is left to expire: its value was never
    // disclosed, so nobody holds it.
    throw new Error(`private session minted but did not resolve (${resolved.error})`);
  }

  return {
    ok: true,
    session: sessionValue,
    maxAgeSeconds: PRIVATE_SESSION_TTL_SECONDS,
    principal: resolved.principal,
  };
}

/**
 * End one private-site session. Idempotent, and it can touch nothing but a
 * `scope = 'private'` row: handed an app or docs session value, it changes
 * nothing, so the private site's sign-out can never sign anyone out of
 * anything else.
 *
 * `ok: true` means no live private-site session holds this value any more. It
 * does not mean a row was ended: an unknown or already-revoked value is also
 * `ok: true`, because the caller's goal (that value no longer works) holds.
 */
export async function revokePrivateSession(
  env: Bindings,
  request: unknown,
): Promise<RevokePrivateSessionResult> {
  if (maintenanceRefuses(env.MAINTENANCE_MODE, "write")) return { ok: false, error: "unavailable" };

  const value = boundedString(
    typeof request === "object" && request !== null
      ? (request as { value?: unknown }).value
      : undefined,
    MAX_CREDENTIAL_LENGTH,
  );
  // Nothing to end is already the end state.
  if (value === null) return { ok: true };

  await env.DB.prepare(PRIVATE_REVOKE_ONE_SQL)
    .bind(await hashCookieId(value))
    .run();
  return { ok: true };
}
