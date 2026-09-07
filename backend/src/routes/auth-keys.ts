/**
 * Named API key routes (epic #1272 phase 1, #1281; ADR 0047), mounted under
 * the same `/auth` prefix as the other auth routes.
 *
 *   GET    /auth/keys          - list this account's live keys
 *   POST   /auth/keys          - mint a new named key (the paste-key
 *                                 fallback for a headless host that cannot
 *                                 run the device flow's browser half)
 *   DELETE /auth/keys/:id      - revoke a key by row id
 *   DELETE /auth/keys/current  - revoke the key presenting THIS request
 *                                (bearer path only)
 *
 * Every route accepts either credential `resolveActingAccount` accepts (the
 * CLI's bearer token, or the dashboard's `nemar_session` cookie, #1266, ADR
 * 0044) -- but goes one check further than that helper on the cookie half:
 * `resolveActingAccount` deliberately ADMITS a `pending` account on cookies,
 * because the email-change flow needs that (ADR 0044). A pending account
 * holds no API key and must not mint one here (ADR 0040), so this file adds
 * the active-status gate back for its own routes, `inactiveAccountBody`
 * shaped like the bearer path already refuses it.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type {
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeySummary,
} from "../../../shared/contract/device-auth.js";
import { auditLogStatement } from "../db/audit-log";
import { type ActingAccount, resolveActingAccount } from "../middleware/auth";
import { webSessionMiddleware } from "../middleware/webSession";
import { inactiveAccountBody, isActiveAccountStatus } from "../services/account-tier";
import {
  KEY_BY_HASH_SQL,
  KEY_LIST_SQL,
  KEY_MINT_SQL,
  KEY_REVOKE_BY_HASH_SQL,
  KEY_REVOKE_BY_ID_SQL,
  deviceRefusal,
  normalizeMachineName,
} from "../services/device-auth";
import { generateApiKey, hashApiKey } from "../services/token";
import type { Bindings, Variables } from "../types/bindings";

export const authKeysRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

authKeysRoutes.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

type KeysContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * `resolveActingAccount` plus the active-status gate this file needs on the
 * cookie half (see header comment). The bearer half already carries this
 * gate inside `resolveBearerUser`, so re-checking it here would be a no-op
 * for that path -- but it costs nothing to express it once for both.
 */
async function resolveKeysActor(
  c: KeysContext,
): Promise<{ ok: true; actor: ActingAccount } | { ok: false; response: Response }> {
  const resolved = await resolveActingAccount(c);
  if (!resolved.ok) return resolved;
  if (resolved.actor.via === "cookie") {
    const status = c.var.webUser?.status;
    if (!status || !isActiveAccountStatus(status)) {
      return { ok: false, response: c.json(inactiveAccountBody(status ?? "pending"), 403) };
    }
  }
  return resolved;
}

/** SHA-256 of the presenting bearer token, or `null` on the cookie path (a
 *  cookie authenticates no key, so nothing can be "current" for it). */
async function currentKeyHash(c: KeysContext): Promise<string | null> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const raw = authHeader.substring(7);
  if (!raw || raw.length < 32) return null;
  return hashApiKey(raw);
}

// --------------------------------------------------------------------------
// list
// --------------------------------------------------------------------------

authKeysRoutes.get("/keys", webSessionMiddleware, async (c) => {
  const resolved = await resolveKeysActor(c);
  if (!resolved.ok) return resolved.response;
  const actor = resolved.actor;

  const db = c.env.DB;
  const current = await currentKeyHash(c);
  const rows = await db.prepare(KEY_LIST_SQL).bind(actor.id).all<{
    id: number;
    name: string | null;
    prefix: string;
    created_at: string;
    last_used_at: string | null;
    api_key_hash: string;
  }>();

  const keys: ApiKeySummary[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    // Never true on the cookie path: `current` is null there, so this
    // comparison can never match a stored hash.
    current: current !== null && current === r.api_key_hash,
  }));
  const body: ApiKeyListResponse = { keys };
  return c.json(body);
});

// --------------------------------------------------------------------------
// mint
// --------------------------------------------------------------------------

const keyCreateSchema = z.object({ name: z.string().min(1).max(200) });

authKeysRoutes.post(
  "/keys",
  webSessionMiddleware,
  zValidator("json", keyCreateSchema),
  async (c) => {
    const resolved = await resolveKeysActor(c);
    if (!resolved.ok) return resolved.response;
    const actor = resolved.actor;

    const db = c.env.DB;
    const name = normalizeMachineName(c.req.valid("json").name);
    const { apiKey, apiKeyPrefix } = generateApiKey();
    const hash = await hashApiKey(apiKey);

    const result = await db
      .prepare(KEY_MINT_SQL)
      .bind(actor.id, hash, apiKeyPrefix, name, actor.id)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      return c.json(deviceRefusal("too_many_keys"), 409);
    }

    const keyRow = await db.prepare(KEY_BY_HASH_SQL).bind(hash).first<{
      id: number;
      name: string | null;
      prefix: string;
      created_at: string;
      last_used_at: string | null;
    }>();

    await auditLogStatement(db, {
      userId: actor.id,
      action: "api_key_created",
      resourceType: "token",
      resourceId: String(keyRow?.id ?? ""),
      details: JSON.stringify({ name, prefix: keyRow?.prefix ?? apiKeyPrefix, via: actor.via }),
    })
      .run()
      .catch((err) => console.error("[auth-keys] failed to write api_key_created audit row", err));

    const body: ApiKeyCreateResponse = {
      api_key: apiKey,
      key: {
        id: keyRow?.id ?? 0,
        name: keyRow?.name ?? name,
        prefix: keyRow?.prefix ?? apiKeyPrefix,
        created_at: keyRow?.created_at ?? "",
        last_used_at: keyRow?.last_used_at ?? null,
        // A key just minted is never the one that authenticated THIS request.
        current: false,
      },
    };
    return c.json(body);
  },
);

// --------------------------------------------------------------------------
// revoke
// --------------------------------------------------------------------------

authKeysRoutes.delete("/keys/:id", webSessionMiddleware, async (c) => {
  const resolved = await resolveKeysActor(c);
  if (!resolved.ok) return resolved.response;
  const actor = resolved.actor;

  const db = c.env.DB;
  const idParam = c.req.param("id");

  if (idParam === "current") {
    // Only meaningful on the bearer path: a cookie authenticates no key, so
    // there is nothing "current" to revoke.
    if (actor.via !== "token") {
      return c.json(deviceRefusal("key_not_found"), 404);
    }
    const hash = await currentKeyHash(c);
    if (!hash) {
      return c.json(deviceRefusal("key_not_found"), 404);
    }
    const result = await db.prepare(KEY_REVOKE_BY_HASH_SQL).bind(hash, actor.id).run();
    if ((result.meta?.changes ?? 0) === 0) {
      return c.json(deviceRefusal("key_not_found"), 404);
    }
    const row = await db
      .prepare("SELECT id, name, api_key_prefix AS prefix FROM tokens WHERE api_key_hash = ?")
      .bind(hash)
      .first<{ id: number; name: string | null; prefix: string }>();
    await auditLogStatement(db, {
      userId: actor.id,
      action: "api_key_revoked",
      resourceType: "token",
      resourceId: String(row?.id ?? ""),
      details: JSON.stringify({
        name: row?.name ?? null,
        prefix: row?.prefix ?? null,
        via: actor.via,
        self: true,
      }),
    })
      .run()
      .catch((err) => console.error("[auth-keys] failed to write api_key_revoked audit row", err));
    return c.json({ ok: true });
  }

  if (!/^\d+$/.test(idParam)) {
    return c.json(deviceRefusal("key_not_found"), 404);
  }
  const id = Number(idParam);
  const currentHash = await currentKeyHash(c);

  const result = await db.prepare(KEY_REVOKE_BY_ID_SQL).bind(id, actor.id).run();
  if ((result.meta?.changes ?? 0) === 0) {
    return c.json(deviceRefusal("key_not_found"), 404);
  }
  const row = await db
    .prepare("SELECT name, api_key_prefix AS prefix, api_key_hash FROM tokens WHERE id = ?")
    .bind(id)
    .first<{ name: string | null; prefix: string; api_key_hash: string }>();
  const self = currentHash !== null && row?.api_key_hash === currentHash;

  await auditLogStatement(db, {
    userId: actor.id,
    action: "api_key_revoked",
    resourceType: "token",
    resourceId: String(id),
    details: JSON.stringify({
      name: row?.name ?? null,
      prefix: row?.prefix ?? null,
      via: actor.via,
      self,
    }),
  })
    .run()
    .catch((err) => console.error("[auth-keys] failed to write api_key_revoked audit row", err));

  return c.json({ ok: true });
});
