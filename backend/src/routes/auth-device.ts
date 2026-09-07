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
 * `/confirm` (decision 1, ADR 0047): `/confirm` only ever flips the row to
 * `confirmed` and records `user_id`. All timestamps this file writes or
 * compares are SQL-side (decision 4; see services/device-auth.ts).
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
  USER_STATUS_FOR_DEVICE_AUTH_SQL,
  accountRefusal,
  deviceRefusal,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  normalizeMachineName,
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
 *  be a pending/confirmed row past `expires_at` (decision 5: expiry is
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

function tokenErrorResponse(
  c: { json: (body: unknown, status: number) => Response },
  error: DeviceGrantError,
  reason?: DeviceAuthRefusalCode,
): Response {
  const message = reason ? DEVICE_AUTH_MESSAGES[reason] : DEVICE_GRANT_MESSAGES[error];
  const body: DeviceTokenError = reason ? { error, reason, message } : { error, message };
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
  // sends no body at all (or `{}`) must still get a code, not a 400.
  const rawBody = await c.req.json().catch(() => ({}));
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
    return tokenErrorResponse(c, "authorization_pending");
  }

  // (2)-(4) `changes === 0`: disambiguate why. `loadFreshRow` observes and
  // stamps expiry along the way, so a row that just crossed `expires_at`
  // reads back as 'expired' here.
  const row = await loadFreshRow(db, DEVICE_ROW_BY_HASH_SQL, hash);
  if (!row) {
    return tokenErrorResponse(c, "invalid_grant", "device_code_unknown");
  }
  if (row.status === "expired") {
    return tokenErrorResponse(c, "expired_token", "device_code_expired");
  }
  if (row.status === "denied") {
    return tokenErrorResponse(c, "access_denied", "device_code_denied");
  }
  if (row.status === "consumed") {
    return tokenErrorResponse(c, "invalid_grant", "device_code_used");
  }
  if (row.status === "pending") {
    // Live and unexpired, so the poll UPDATE above matched zero rows only
    // because it arrived inside the {@link DEVICE_POLL_INTERVAL_SECONDS}
    // floor since the last STAMPED poll -- the floor is not reset (decision
    // 7: a jittery client is not starved).
    return tokenErrorResponse(c, "slow_down");
  }

  // (5) row.status === "confirmed" and not expired: attempt the mint. Never
  // read `last_insert_rowid()` (decision 1) -- the consume statement's
  // `changes` is the only trustworthy signal, gated on `EXISTS` against the
  // hash this route just generated.
  const { apiKey, apiKeyPrefix } = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const results = await db.batch([
    db.prepare(DEVICE_MINT_INSERT_SQL).bind(apiKeyHash, apiKeyPrefix, hash),
    db.prepare(DEVICE_MINT_CONSUME_SQL).bind(apiKeyHash, hash, apiKeyHash),
  ]);
  const consumeChanges = results[1]?.meta?.changes ?? 0;

  if (consumeChanges === 1) {
    const keyRow = await db.prepare(KEY_BY_HASH_SQL).bind(apiKeyHash).first<{
      id: number;
      name: string | null;
      prefix: string;
      created_at: string;
      last_used_at: string | null;
    }>();
    const userRow = await db.prepare(USER_BLOCK_FOR_DEVICE_TOKEN_SQL).bind(row.user_id).first<{
      username: string | null;
      email: string;
      github_username: string | null;
      role: string | null;
      sandbox_completed: number;
      sandbox_dataset_id: string | null;
    }>();

    await auditLogStatement(db, {
      userId: row.user_id,
      action: "device_auth_key_issued",
      resourceType: "device_code",
      resourceId: row.user_code,
      details: JSON.stringify({
        machine_name: row.machine_name,
        prefix: keyRow?.prefix ?? apiKeyPrefix,
        token_id: keyRow?.id ?? null,
      }),
    })
      .run()
      .catch((err) =>
        console.error("[auth-device] failed to write device_auth_key_issued audit row", err),
      );

    const body: DeviceTokenSuccess = {
      api_key: apiKey,
      key: {
        id: keyRow?.id ?? 0,
        name: keyRow?.name ?? null,
        prefix: keyRow?.prefix ?? apiKeyPrefix,
        created_at: keyRow?.created_at ?? "",
        last_used_at: keyRow?.last_used_at ?? null,
        current: true,
      },
      user: {
        username: userRow?.username ?? null,
        email: userRow?.email ?? "",
        github_username: userRow?.github_username ?? null,
        role: userRow?.role || "member",
        sandbox_completed: flag(userRow?.sandbox_completed),
        sandbox_dataset_id: userRow?.sandbox_dataset_id ?? null,
      },
    };
    return c.json(body);
  }

  // (6) `changes === 0`: the row was 'confirmed' a moment ago but the mint
  // still landed nothing. Diagnose why against a fresh read, in the same
  // order a caller would want to hear it: is the code itself now gone
  // (expired/used by a racing poll), then the ACCOUNT (revoked, pending,
  // flagged), then the key cap, then fall back to whatever `refusalForRow`
  // says.
  const freshRow = await loadFreshRow(db, DEVICE_ROW_BY_HASH_SQL, hash);
  if (!freshRow) {
    return tokenErrorResponse(c, "invalid_grant", "device_code_unknown");
  }
  if (freshRow.status === "expired") {
    return tokenErrorResponse(c, "expired_token", "device_code_expired");
  }

  const userId = freshRow.user_id;
  const userStatusRow = userId
    ? await db.prepare(USER_STATUS_FOR_DEVICE_AUTH_SQL).bind(userId).first<{
        status: string;
        deleted_at: string | null;
        identity_conflict: number;
      }>()
    : null;

  let reason: DeviceAuthRefusalCode;
  if (!userStatusRow || userStatusRow.deleted_at) {
    reason = "account_revoked";
  } else {
    const accountIssue = accountRefusal(
      userStatusRow.status,
      flag(userStatusRow.identity_conflict),
    );
    if (accountIssue) {
      reason = accountIssue;
    } else {
      const keyCountRow = await db.prepare(LIVE_KEY_COUNT_SQL).bind(userId).first<{ n: number }>();
      if ((keyCountRow?.n ?? 0) >= MAX_LIVE_API_KEYS) {
        reason = "too_many_keys";
      } else {
        reason = refusalForRow(freshRow) ?? "device_code_used";
      }
    }
  }
  const grantError: DeviceGrantError =
    reason === "device_code_used" ? "invalid_grant" : "access_denied";
  return tokenErrorResponse(c, grantError, reason);
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
  const codeRefusal = refusalForRow(row);
  if (codeRefusal) {
    return refusalResponse(c, codeRefusal);
  }
  // refusalForRow returns null only for a live, pending row -- so `row` is
  // guaranteed non-null past this point.
  const liveRow = row as DeviceCodeRow;

  const identityRow = await c.env.DB.prepare("SELECT identity_conflict FROM users WHERE id = ?")
    .bind(webUser.id)
    .first<{ identity_conflict: number }>();
  const accountCode = accountRefusal(webUser.status, flag(identityRow?.identity_conflict));

  const body: DeviceLookupResponse = {
    user_code: formatUserCode(liveRow.user_code),
    machine_name: liveRow.machine_name,
    requested_at: sqliteUtcToIso(liveRow.created_at),
    expires_in: liveRow.expires_in,
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

    const identityRow = await db
      .prepare("SELECT identity_conflict FROM users WHERE id = ?")
      .bind(webUser.id)
      .first<{ identity_conflict: number }>();
    const accountCode = accountRefusal(webUser.status, flag(identityRow?.identity_conflict));
    if (accountCode) {
      return refusalResponse(c, accountCode);
    }

    const result = await db.prepare(DEVICE_CONFIRM_SQL).bind(webUser.id, userCode).run();
    if ((result.meta?.changes ?? 0) === 0) {
      return refusalResponse(c, await refusalAfterNoChange(db, userCode));
    }

    const confirmedRow = await db
      .prepare(DEVICE_ROW_BY_USER_CODE_SQL)
      .bind(userCode)
      .first<DeviceCodeRow>();
    const machineName = confirmedRow?.machine_name ?? "";

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

    // Any signed-in account may deny (decision 12): the row records no
    // `user_id`, only the audit row names the denier.
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
