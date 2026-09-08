/**
 * Device authorization grant routes (RFC 8628; epic #1272 phase 1, #1281;
 * ADR 0047), mounted under the same `/auth` prefix as the other auth routes.
 *
 *   POST /auth/device/start   - CLI: mint a device code + user code
 *   POST /auth/device/token   - CLI: poll for the API key (RFC 8628 4.2/5.1)
 *   GET  /auth/device/lookup  - browser (session): read what a code names
 *   POST /auth/device/confirm - browser (session): authorize the code
 *   POST /auth/device/deny    - browser (session): decline the code
 *
 * `lookup`/`confirm`/`deny` sit behind the existing web session (#569) and
 * ORCID routes, so every ORCID/identity lesson already in the tree applies
 * unchanged (ADR 0022, 0043, 0044) -- this file never talks to ORCID itself.
 *
 * RFC 8628 section 5.4 phishing note: `machine_name` is CLIENT-SUPPLIED
 * text (from `POST /device/start`'s body), stored and echoed verbatim by
 * `lookup`/`confirm`. Phase 2's website page must escape it and frame the
 * question ("Did you just run `nemar auth login` on <machine>?") rather than
 * present it as trusted context -- this backend does not escape it, because
 * it never renders HTML.
 *
 * The key is minted only when the CLI collects it at `/token`, never at
 * `/confirm` (ADR 0047: mint at collect, never at confirm): `/confirm`
 * only ever flips the row to `confirmed` and records `user_id`. All
 * timestamps this file writes or compares are SQL-side (ADR 0047; see
 * services/device-auth.ts).
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  DEVICE_AUTH_MESSAGES,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_GRANT_MESSAGES,
  DEVICE_POLL_INTERVAL_SECONDS,
  type DeviceAuthRefusalCode,
  type DeviceConfirmResponse,
  type DeviceGrantError,
  type DeviceLookupResponse,
  type DeviceStartResponse,
  type DeviceTokenError,
  type DeviceTokenSuccess,
  MAX_LIVE_API_KEYS,
  formatUserCode,
  normalizeUserCode,
} from "../../../shared/contract/device-auth.js";
import { auditLogStatement } from "../db/audit-log";
import { flag } from "../db/flag";
import { webSessionMiddleware } from "../middleware/webSession";
import { maskEmail } from "../services/auth-code";
import {
  DEVICE_CONFIRM_SQL,
  DEVICE_DENY_SQL,
  DEVICE_INSERT_SQL,
  DEVICE_MINT_CONSUME_SQL,
  DEVICE_MINT_INSERT_SQL,
  DEVICE_POLL_SQL,
  DEVICE_PRUNE_SQL,
  DEVICE_ROW_BY_HASH_SQL,
  DEVICE_ROW_BY_USER_CODE_SQL,
  type DeviceCodeRow,
  HTTP_STATUS_FOR_REFUSAL,
  KEY_BY_HASH_SQL,
  LIVE_KEY_COUNT_SQL,
  USER_BLOCK_FOR_DEVICE_TOKEN_SQL,
  accountRefusal,
  buildApiKeySummary,
  deviceRefusal,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  isLivePending,
  normalizeMachineName,
  readDeviceAuthAccount,
  refusalForRow,
  sqliteUtcToIso,
  stampExpiredOnce,
} from "../services/device-auth";
import { appBase } from "../services/environment";
import { uniqueViolationColumns } from "../services/identity";
import { generateApiKey, hashApiKey } from "../services/token";
import { clientIp, hashIp, isAllowedOrigin } from "../services/web-session";
import type { Bindings, Variables } from "../types/bindings";

export const authDeviceRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Every response from this file is a fresh auth decision, never a cacheable
// document -- including a `slow_down`/`authorization_pending` poll answer, a
// browser could otherwise be served from a shared HTTP cache in front of it.
authDeviceRoutes.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

const MAX_USER_CODE_MINT_ATTEMPTS = 3;

// ------------------------------- helpers --------------------------------

/** Re-read a `device_codes` row by its primary lookup key, stamping it
 *  `expired` (once, best-effort audited) and re-reading if it turns out to
 *  be a pending/confirmed row past `expires_at` (ADR 0047: expiry is
 *  observed, not scheduled). Shared by every route below that needs a
 *  current view of one row. */
async function loadFreshRow(
  db: D1Database,
  sql: string,
  key: string,
): Promise<DeviceCodeRow | null> {
  let row = await db.prepare(sql).bind(key).first<DeviceCodeRow>();
  if (row && (row.status === "pending" || row.status === "confirmed") && flag(row.is_expired)) {
    await stampExpiredOnce(db, row);
    row = await db.prepare(sql).bind(key).first<DeviceCodeRow>();
  }
  return row;
}

/** The refusal a browser route (`lookup`/`confirm`/`deny`) answers with when
 *  a mutation's conditional UPDATE affected zero rows: re-read the row
 *  fresh (observing expiry along the way) and map it to a refusal code,
 *  falling back to `device_code_used` for the residual "still pending"
 *  case a race could leave behind. */
async function refusalAfterNoChange(
  db: D1Database,
  userCode: string,
): Promise<DeviceAuthRefusalCode> {
  const row = await loadFreshRow(db, DEVICE_ROW_BY_USER_CODE_SQL, userCode);
  return refusalForRow(row) ?? "device_code_used";
}

function refusalResponse(
  c: { json: (body: unknown, status: number) => Response },
  code: DeviceAuthRefusalCode,
) {
  return c.json(deviceRefusal(code), HTTP_STATUS_FOR_REFUSAL[code]);
}

/** The `deviceLookupResponseSchema.refusal` shape: `{ code, message }`, NOT
 *  `deviceRefusal`'s `{ error, message }` -- the lookup body nests this
 *  under a `refusal` key, so it names the field `code` rather than
 *  redeclaring `error` a second time inside the same JSON object. */
function nestedRefusal(code: DeviceAuthRefusalCode): {
  code: DeviceAuthRefusalCode;
  message: string;
} {
  return { code, message: DEVICE_AUTH_MESSAGES[code] };
}

/** The two "keep polling" outcomes: never a `reason` (there is nothing to
 *  explain -- the code is still live), matching {@link DeviceTokenError}'s
 *  discriminated union. */
function pendingTokenError(
  c: { json: (body: unknown, status: number) => Response },
  error: "authorization_pending" | "slow_down",
): Response {
  const body: DeviceTokenError = { error, message: DEVICE_GRANT_MESSAGES[error] };
  return c.json(body, 400);
}

/** The three terminal outcomes: always a `reason`, the refusal vocabulary's
 *  more specific code -- the type requires it, so a call site cannot omit
 *  one here the way it could when `reason` was merely optional. */
function terminalTokenError(
  c: { json: (body: unknown, status: number) => Response },
  error: "expired_token" | "access_denied" | "invalid_grant",
  reason: DeviceAuthRefusalCode,
): Response {
  const body: DeviceTokenError = { error, reason, message: DEVICE_AUTH_MESSAGES[reason] };
  return c.json(body, 400);
}

// -------------------------------- start ----------------------------------

const deviceStartBodySchema = z.object({
  machine_name: z.string().max(200).optional(),
});

authDeviceRoutes.post("/device/start", async (c) => {
  const db = c.env.DB;

  // Opportunistic prune, same pattern as cli-start's (auth-orcid.ts): the
  // table cannot outgrow one TTL window's worth of codes plus a day, and
  // needs no cron. Best-effort -- a failed prune must never refuse someone
  // a device code.
  await db
    .prepare(DEVICE_PRUNE_SQL)
    .run()
    .catch((err) => console.error("[auth-device] failed to prune expired device codes", err));

  // Tolerate an empty body: `machine_name` is optional, and a CLI that
  // sends no body at all (or `{}`) must still get a code, not a 400. A
  // NON-empty body that fails to parse is different -- that is a malformed
  // CLI build or a hand-rolled client, and must be visible rather than
  // silently defaulted, so it gets its own 400 and a warning naming why.
  const rawText = (await c.req.text()).trim();
  let rawBody: unknown = {};
  if (rawText.length > 0) {
    try {
      rawBody = JSON.parse(rawText);
    } catch (err) {
      console.warn(
        "[auth-device] /device/start received a non-empty body that is not valid JSON",
        err,
      );
      return c.json({ error: "Invalid request body" }, 400);
    }
  }
  const parsed = deviceStartBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const machineName = normalizeMachineName(parsed.data.machine_name);

  const deviceCode = generateDeviceCode();
  const deviceCodeHash = await hashDeviceCode(deviceCode);

  let userCode: string | null = null;
  for (let attempt = 0; attempt < MAX_USER_CODE_MINT_ATTEMPTS; attempt++) {
    const candidate = generateUserCode();
    try {
      await db.prepare(DEVICE_INSERT_SQL).bind(deviceCodeHash, candidate, machineName).run();
      userCode = candidate;
      break;
    } catch (err) {
      if (uniqueViolationColumns(err).includes("device_codes.user_code")) {
        continue;
      }
      throw err;
    }
  }
  if (!userCode) {
    console.error(
      `[auth-device] could not allocate a unique user_code after ${MAX_USER_CODE_MINT_ATTEMPTS} attempts`,
    );
    return c.json({ error: "Could not start device authorization; try again." }, 500);
  }

  await auditLogStatement(db, {
    userId: null,
    action: "device_auth_started",
    resourceType: "device_code",
    resourceId: userCode,
    details: JSON.stringify({
      machine_name: machineName,
      ip_hash: await hashIp(clientIp(c)),
      cli_version: c.req.header("X-CLI-Version") ?? null,
    }),
  })
    .run()
    .catch((err) =>
      console.error("[auth-device] failed to write device_auth_started audit row", err),
    );

  const base = appBase(c.env);
  const formatted = formatUserCode(userCode);
  const body: DeviceStartResponse = {
    device_code: deviceCode,
    user_code: formatted,
    verification_uri: `${base}/cli/authorize`,
    verification_uri_complete: `${base}/cli/authorize?code=${encodeURIComponent(formatted)}`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  };
  return c.json(body);
});

// -------------------------------- token -----------------------------------

const deviceTokenBodySchema = z.object({
  device_code: z.string().min(32).max(128),
});

authDeviceRoutes.post("/device/token", zValidator("json", deviceTokenBodySchema), async (c) => {
  const db = c.env.DB;
  const { device_code: deviceCode } = c.req.valid("json");
  const hash = await hashDeviceCode(deviceCode);

  // (1) The poll floor + liveness check in one conditional UPDATE. A live,
  // still-pending, floor-respecting poll is `changes === 1` and answered
  // immediately -- no further read needed.
  const pollResult = await db.prepare(DEVICE_POLL_SQL).bind(hash).run();
  if ((pollResult.meta?.changes ?? 0) === 1) {
    return pendingTokenError(c, "authorization_pending");
  }

  // (2)-(4) `changes === 0`: disambiguate why. `loadFreshRow` observes and
  // stamps expiry along the way, so a row that just crossed `expires_at`
  // reads back as 'expired' here.
  const row = await loadFreshRow(db, DEVICE_ROW_BY_HASH_SQL, hash);
  if (!row) {
    return terminalTokenError(c, "invalid_grant", "device_code_unknown");
  }
  if (row.status === "expired") {
    return terminalTokenError(c, "expired_token", "device_code_expired");
  }
  if (row.status === "denied") {
    return terminalTokenError(c, "access_denied", "device_code_denied");
  }
  if (row.status === "consumed") {
    return terminalTokenError(c, "invalid_grant", "device_code_used");
  }
  if (row.status === "pending") {
    // Live and unexpired, so the poll UPDATE above matched zero rows only
    // because it arrived inside the {@link DEVICE_POLL_INTERVAL_SECONDS}
    // floor since the last STAMPED poll -- the floor is not reset (ADR
    // 0047: a jittery client is not starved).
    return pendingTokenError(c, "slow_down");
  }

  // (5) row.status === "confirmed" and not expired: attempt the mint. Never
  // read `last_insert_rowid()` (ADR 0047) -- the consume statement's
  // `changes` is the only trustworthy signal, gated on `EXISTS` against the
  // hash this route just generated.
  //
  // The two read-backs run INSIDE this same batch. D1 (and the `realD1`
  // test double) run a batch as one transaction, so both SELECTs see the
  // INSERT's row, and if anything after the batch throws, nothing in it
  // was ever committed -- the CLI simply polls again for a code that is
  // still perfectly usable, rather than this route minting a key it then
  // fails to hand back.
  const { apiKey, apiKeyPrefix } = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const results = await db.batch<Record<string, unknown>>([
    db.prepare(DEVICE_MINT_INSERT_SQL).bind(apiKeyHash, apiKeyPrefix, hash),
    db.prepare(DEVICE_MINT_CONSUME_SQL).bind(apiKeyHash, hash, apiKeyHash),
    db.prepare(KEY_BY_HASH_SQL).bind(apiKeyHash),
    db.prepare(USER_BLOCK_FOR_DEVICE_TOKEN_SQL).bind(row.user_id),
  ]);

  const consumeResult = results[1];
  if (!consumeResult?.meta) {
    // D1 always returns `meta` for a run statement inside a batch; this is
    // a canary for a driver-shape change, not an expected outcome. Fail
    // safe toward "nothing changed" (a recoverable `slow_down`-shaped
    // retry) rather than crash on the missing property.
    console.error(
      `[auth-device] canary: batch result for DEVICE_MINT_CONSUME_SQL carried no meta (hash prefix ${hash.slice(0, 8)}, user_code=${row.user_code})`,
    );
  }
  const consumeChanges = consumeResult?.meta?.changes ?? 0;

  if (consumeChanges === 1) {
    const keyRow = results[2]?.results?.[0] as
      | {
          id: number;
          name: string | null;
          prefix: string;
          created_at: string;
          last_used_at: string | null;
        }
      | undefined;
    const userRow = results[3]?.results?.[0] as
      | {
          username: string | null;
          email: string;
          github_username: string | null;
          role: string | null;
          sandbox_completed: number;
          sandbox_dataset_id: string | null;
        }
      | undefined;

    if (!keyRow || !userRow) {
      // Impossible inside one committed transaction: the INSERT just wrote
      // the tokens row this SELECT reads back by the very hash it inserted,
      // and `row.user_id` is the same account the mint's WHERE clause just
      // matched. Ship nothing rather than a response built from fillers.
      console.error(
        `[auth-device] canary: mint committed (user_code=${row.user_code}, ` +
          `hash prefix ${hash.slice(0, 8)}, user_id=${row.user_id}) but a read-back inside ` +
          `the same batch came back empty (key=${Boolean(keyRow)}, user=${Boolean(userRow)})`,
      );
      throw new Error("device token mint committed but its read-back was empty");
    }

    await auditLogStatement(db, {
      userId: row.user_id,
      action: "device_auth_key_issued",
      resourceType: "device_code",
      resourceId: row.user_code,
      details: JSON.stringify({
        machine_name: row.machine_name,
        prefix: keyRow.prefix,
        token_id: keyRow.id,
      }),
    })
      .run()
      .catch((err) =>
        console.error("[auth-device] failed to write device_auth_key_issued audit row", err),
      );

    const body: DeviceTokenSuccess = {
      api_key: apiKey,
      key: buildApiKeySummary(keyRow, true),
      user: {
        username: userRow.username,
        email: userRow.email,
        github_username: userRow.github_username,
        role: userRow.role || "member",
        sandbox_completed: flag(userRow.sandbox_completed),
        sandbox_dataset_id: userRow.sandbox_dataset_id,
      },
    };
    return c.json(body);
  }

  // (6) `changes === 0`: the row was 'confirmed' a moment ago but the mint
  // still landed nothing. Diagnose why against a fresh read, in the same
  // order a caller would want to hear it: is the code itself now gone
  // (expired), then the ACCOUNT (revoked, pending, flagged), then the key
  // cap. `denied`/`pending` cannot appear here -- neither transition is
  // reachable once a row is `confirmed` -- so what remains is either the
  // account genuinely gained a problem, or (the `confirmed` fallthrough
  // below) a race this route did not expect.
  const freshRow = await loadFreshRow(db, DEVICE_ROW_BY_HASH_SQL, hash);
  if (!freshRow) {
    return terminalTokenError(c, "invalid_grant", "device_code_unknown");
  }
  if (freshRow.status === "expired") {
    return terminalTokenError(c, "expired_token", "device_code_expired");
  }

  const userId = freshRow.user_id;
  const account = await readDeviceAuthAccount(db, userId);

  if (!account && userId) {
    // `device_codes.user_id REFERENCES users(id) ON DELETE CASCADE` makes
    // a confirmed row naming a user that no longer resolves impossible --
    // deleting the user deletes this row along with it. A canary, not a
    // silent `account_revoked`.
    console.error(
      `[auth-device] canary: confirmed device_codes row user_code=${freshRow.user_code} ` +
        `names user_id=${userId}, which does not resolve to a user`,
    );
  }
  // `accountRefusal(null)` answers `account_revoked`, the same terminal
  // reason the canary case above already fell through to.
  const accountIssue = accountRefusal(account);
  if (accountIssue) {
    return terminalTokenError(c, "access_denied", accountIssue);
  }
  const keyCountRow = await db.prepare(LIVE_KEY_COUNT_SQL).bind(userId).first<{ n: number }>();
  if ((keyCountRow?.n ?? 0) >= MAX_LIVE_API_KEYS) {
    return terminalTokenError(c, "access_denied", "too_many_keys");
  }

  if (freshRow.status === "confirmed") {
    // The row is still confirmed, the account is fine, and the key count is
    // under the cap -- the mint SHOULD have succeeded. This is a raced
    // batch (a concurrent poll's INSERT landed between this poll's first
    // read and its own batch), not a real refusal: answer the CLI's normal
    // "keep waiting" state so the next poll retries a code that is still
    // perfectly usable, rather than a terminal error for it.
    console.error(
      `[auth-device] canary: mint found no reason to refuse user_code=${freshRow.user_code} ` +
        `(hash prefix ${hash.slice(0, 8)}, user_id=${userId}) yet inserted no token row`,
    );
    return pendingTokenError(c, "slow_down");
  }

  // freshRow.status === "consumed": a concurrent poll already won the mint.
  return terminalTokenError(c, "invalid_grant", "device_code_used");
});

// -------------------------------- lookup -----------------------------------

authDeviceRoutes.get("/device/lookup", webSessionMiddleware, async (c) => {
  const webUser = c.var.webUser;
  if (!webUser) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const db = c.env.DB;
  const userCode = normalizeUserCode(new URL(c.req.url).searchParams.get("code") ?? "");
  if (!userCode) {
    return refusalResponse(c, "device_code_unknown");
  }

  const row = await loadFreshRow(db, DEVICE_ROW_BY_USER_CODE_SQL, userCode);
  if (!isLivePending(row)) {
    // `isLivePending` narrows the ONE case `refusalForRow` answers `null`
    // for; anything else is a refusal, and `refusalForRow` names it -- no
    // `as DeviceCodeRow` cast needed past this point.
    return refusalResponse(c, refusalForRow(row) ?? "device_code_unknown");
  }

  const account = await readDeviceAuthAccount(db, webUser.id);
  const accountCode = accountRefusal(account);

  const body: DeviceLookupResponse = {
    user_code: formatUserCode(row.user_code),
    machine_name: row.machine_name,
    requested_at: sqliteUtcToIso(row.created_at),
    expires_in: row.expires_in,
    account: {
      username: webUser.username,
      email_masked: maskEmail(webUser.email),
    },
    refusal: accountCode ? nestedRefusal(accountCode) : null,
  };
  return c.json(body);
});

// -------------------------------- confirm -----------------------------------

const deviceCodeBodySchema = z.object({
  code: z.string().min(1).max(64),
});

authDeviceRoutes.post(
  "/device/confirm",
  webSessionMiddleware,
  zValidator("json", deviceCodeBodySchema),
  async (c) => {
    if (!isAllowedOrigin(c.req.header("Origin"))) {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    const webUser = c.var.webUser;
    if (!webUser) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const db = c.env.DB;
    const userCode = normalizeUserCode(c.req.valid("json").code);
    if (!userCode) {
      return refusalResponse(c, "device_code_unknown");
    }

    const account = await readDeviceAuthAccount(db, webUser.id);
    const accountCode = accountRefusal(account);
    if (accountCode) {
      return refusalResponse(c, accountCode);
    }

    // Read BEFORE the UPDATE, not after: `machine_name` never changes once
    // a row exists, so this pre-read is all the audit row and the response
    // need. Answering `refusalForRow` here, before attempting the UPDATE,
    // means a decorative POST-update read can never turn an already
    // committed confirm into a 500 -- there is no read left after the write
    // that anything could fail on.
    const preRow = await loadFreshRow(db, DEVICE_ROW_BY_USER_CODE_SQL, userCode);
    if (!isLivePending(preRow)) {
      return refusalResponse(c, refusalForRow(preRow) ?? "device_code_unknown");
    }
    const machineName = preRow.machine_name;

    const result = await db.prepare(DEVICE_CONFIRM_SQL).bind(webUser.id, userCode).run();
    if ((result.meta?.changes ?? 0) === 0) {
      // Lost a race between the pre-read above and this UPDATE (a
      // concurrent deny/expiry/confirm landed in between) -- re-read fresh
      // rather than trust the row this request already saw.
      return refusalResponse(c, await refusalAfterNoChange(db, userCode));
    }

    await auditLogStatement(db, {
      userId: webUser.id,
      action: "device_auth_confirmed",
      resourceType: "device_code",
      resourceId: userCode,
      details: JSON.stringify({ machine_name: machineName }),
    })
      .run()
      .catch((err) =>
        console.error("[auth-device] failed to write device_auth_confirmed audit row", err),
      );

    const body: DeviceConfirmResponse = { ok: true, machine_name: machineName };
    return c.json(body);
  },
);

// --------------------------------- deny ------------------------------------

authDeviceRoutes.post(
  "/device/deny",
  webSessionMiddleware,
  zValidator("json", deviceCodeBodySchema),
  async (c) => {
    if (!isAllowedOrigin(c.req.header("Origin"))) {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    const webUser = c.var.webUser;
    if (!webUser) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const db = c.env.DB;
    const userCode = normalizeUserCode(c.req.valid("json").code);
    if (!userCode) {
      return refusalResponse(c, "device_code_unknown");
    }

    // Any signed-in account may deny (ADR 0047: deny records no `user_id`
    // on the row itself, only the audit row names the denier).
    const result = await db.prepare(DEVICE_DENY_SQL).bind(userCode).run();
    if ((result.meta?.changes ?? 0) === 0) {
      return refusalResponse(c, await refusalAfterNoChange(db, userCode));
    }

    await auditLogStatement(db, {
      userId: webUser.id,
      action: "device_auth_denied",
      resourceType: "device_code",
      resourceId: userCode,
    })
      .run()
      .catch((err) =>
        console.error("[auth-device] failed to write device_auth_denied audit row", err),
      );

    return c.json({ ok: true });
  },
);
