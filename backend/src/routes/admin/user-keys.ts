/**
 * Owner-only key management for non-person account kinds (epic #1272 phase
 * 4, #1284; ADR 0048).
 *
 *   POST   /admin/users/:username/keys      - mint a key for a service/test account
 *   GET    /admin/users/:username/keys      - list a target account's live keys
 *   DELETE /admin/users/:username/keys/:id  - revoke one of a target account's keys
 *
 * The mint runs in the OPPOSITE direction from every other route in this
 * domain: it refuses a `person` target (403 `person_account`) and accepts
 * only `service`/`test`, because a person creates their own keys by signing
 * in (the device flow, or `POST /auth/keys`) -- this route exists BECAUSE
 * those two kinds cannot. `GET`/`DELETE` work for any kind: listing and
 * revoking are administrative record-keeping, not a liveness question, so
 * an owner can still see and clean up a `person` account's keys here too.
 *
 * Reuses the same SQL and helpers `routes/auth-keys.ts` (the self-service
 * mint) does -- `KEY_BY_HASH_SQL`, `KEY_LIST_SQL`, `KEY_ROW_BY_ID_FOR_USER_SQL`,
 * `KEY_REVOKE_BY_ID_SQL`, `buildApiKeySummary`, `normalizeMachineName` -- so
 * the two mint paths cannot drift on what a key row looks like on the wire.
 * The one thing genuinely new here is {@link ADMIN_KEY_MINT_SQL}, which flips
 * the person predicate the other two mints share.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { auditLogStatement } from "../../db/audit-log";
import { ownerMiddleware } from "../../middleware/auth";
import {
  ADMIN_KEY_MINT_SQL,
  ADMIN_KEY_TARGET_SQL,
  type DeviceAuthAccountRow,
  HTTP_STATUS_FOR_REFUSAL,
  KEY_BY_HASH_SQL,
  KEY_LIST_SQL,
  KEY_REVOKE_BY_ID_SQL,
  KEY_ROW_BY_ID_FOR_USER_SQL,
  accountLivenessRefusal,
  buildApiKeySummary,
  deviceRefusal,
  normalizeMachineName,
} from "../../services/device-auth";
import { generateApiKey, hashApiKey } from "../../services/token";
import type { AdminRouter } from "./shared";

interface AdminKeyTargetRow extends DeviceAuthAccountRow {
  id: number;
}

/** Shared by all three routes: the row each one 404s on if it is absent, and
 *  the same row the mint's kind/liveness checks and the list/revoke routes'
 *  scoping both read from -- one lookup, not three that could disagree
 *  about which account a username resolved to. */
async function loadTarget(db: D1Database, username: string): Promise<AdminKeyTargetRow | null> {
  return db.prepare(ADMIN_KEY_TARGET_SQL).bind(username).first<AdminKeyTargetRow>();
}

function keyNotFound(c: { json: (body: unknown, status: number) => Response }): Response {
  return c.json(deviceRefusal("key_not_found"), HTTP_STATUS_FOR_REFUSAL.key_not_found);
}

export function registerUserKeyRoutes(admin: AdminRouter): void {
  const keyCreateSchema = z.object({ name: z.string().trim().min(1).max(200) });

  /**
   * POST /admin/users/:username/keys - mint a key for a non-person account
   * (owner only).
   *
   * Order: 404 (no such account) -> 403 `person_account` (the target IS a
   * person -- they create their own keys) -> the liveness refusal (pending /
   * revoked / identity_conflict, the SAME `accountLivenessRefusal` the
   * device flow's mint diagnosis uses) -> the mint, whose own
   * {@link ADMIN_KEY_MINT_SQL} WHERE clause re-checks every one of those
   * gates at mint time rather than trusting this read (the account can
   * change state between the two, same reasoning as the device flow's mint).
   */
  admin.post(
    "/users/:username/keys",
    ownerMiddleware,
    zValidator("json", keyCreateSchema),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const username = c.req.param("username");
      const db = c.env.DB;
      const adminUser = c.get("user");

      const target = await loadTarget(db, username);
      if (!target) {
        return c.json({ error: "User not found" }, 404);
      }

      if (target.account_kind === "person") {
        return c.json(deviceRefusal("person_account"), HTTP_STATUS_FOR_REFUSAL.person_account);
      }

      const livenessIssue = accountLivenessRefusal(target);
      if (livenessIssue) {
        return c.json(deviceRefusal(livenessIssue), HTTP_STATUS_FOR_REFUSAL[livenessIssue]);
      }

      // The schema already refused an empty-after-trim name with a 400
      // (`.trim().min(1)`); this normalization is cosmetic from here, same
      // as the self-service mint (routes/auth-keys.ts).
      const name = normalizeMachineName(c.req.valid("json").name);
      const { apiKey, apiKeyPrefix } = generateApiKey();
      const hash = await hashApiKey(apiKey);

      // Read-back INSIDE the same batch as the mint, for the same reason
      // every other mint in this codebase does it (routes/auth-device.ts,
      // routes/auth-keys.ts): D1 runs a batch as one transaction, so if
      // anything after it throws, the mint was never committed.
      const results = await db.batch<Record<string, unknown>>([
        db.prepare(ADMIN_KEY_MINT_SQL).bind(target.id, hash, apiKeyPrefix, name, target.id),
        db.prepare(KEY_BY_HASH_SQL).bind(hash),
      ]);
      const mintResult = results[0];
      if ((mintResult?.meta?.changes ?? 0) === 0) {
        // Every OTHER reason this statement's WHERE clause could refuse was
        // already checked above against the same row; what is left is the
        // key cap.
        return c.json(deviceRefusal("too_many_keys"), HTTP_STATUS_FOR_REFUSAL.too_many_keys);
      }

      const keyRow = results[1]?.results?.[0] as
        | {
            id: number;
            name: string | null;
            prefix: string;
            created_at: string;
            last_used_at: string | null;
          }
        | undefined;
      if (!keyRow) {
        // Impossible inside one committed transaction: the INSERT just wrote
        // the row this SELECT reads back by the very hash it inserted.
        console.error(
          `[admin-user-keys] canary: ADMIN_KEY_MINT_SQL committed for user_id=${target.id} but its read-back inside the same batch came back empty`,
        );
        throw new Error("admin key mint committed but its read-back was empty");
      }

      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "api_key_created",
        resourceType: "token",
        resourceId: String(keyRow.id),
        details: JSON.stringify({
          name,
          via: "admin",
          for_user_id: target.id,
          for_username: username,
        }),
      })
        .run()
        .catch((err) =>
          console.error("[admin-user-keys] failed to write api_key_created audit row", err),
        );

      return c.json({
        api_key: apiKey,
        // Minted for another account, so it is never the key that
        // authenticated THIS (the owner's own) request.
        key: buildApiKeySummary(keyRow, false),
      });
    },
  );

  /**
   * GET /admin/users/:username/keys - list a target account's live keys
   * (owner only; any kind).
   */
  admin.get("/users/:username/keys", ownerMiddleware, async (c) => {
    c.header("Cache-Control", "no-store");
    const username = c.req.param("username");
    const db = c.env.DB;

    const target = await loadTarget(db, username);
    if (!target) {
      return c.json({ error: "User not found" }, 404);
    }

    const rows = await db.prepare(KEY_LIST_SQL).bind(target.id).all<{
      id: number;
      name: string | null;
      prefix: string;
      created_at: string;
      last_used_at: string | null;
      api_key_hash: string;
    }>();

    // Never "current": this lists the TARGET account's keys, and none of
    // them is ever the credential authenticating the owner's own request.
    const keys = rows.results.map((r) => buildApiKeySummary(r, false));
    return c.json({ keys });
  });

  /**
   * DELETE /admin/users/:username/keys/:id - revoke one of a target
   * account's keys (owner only; any kind).
   */
  admin.delete("/users/:username/keys/:id", ownerMiddleware, async (c) => {
    c.header("Cache-Control", "no-store");
    const username = c.req.param("username");
    const db = c.env.DB;
    const adminUser = c.get("user");

    const target = await loadTarget(db, username);
    if (!target) {
      return c.json({ error: "User not found" }, 404);
    }

    const idParam = c.req.param("id");
    if (!/^\d+$/.test(idParam)) {
      return keyNotFound(c);
    }
    const id = Number(idParam);

    // Read BEFORE the UPDATE, not after: the pre-read is all the audit row
    // needs, so there is no read left after the write that could turn an
    // already-committed revoke into a 500 (same pattern as auth-keys.ts).
    const preRow = await db.prepare(KEY_ROW_BY_ID_FOR_USER_SQL).bind(id, target.id).first<{
      id: number;
      name: string | null;
      prefix: string;
      api_key_hash: string;
    }>();
    if (!preRow) {
      return keyNotFound(c);
    }

    const result = await db.prepare(KEY_REVOKE_BY_ID_SQL).bind(id, target.id).run();
    if ((result.meta?.changes ?? 0) === 0) {
      return keyNotFound(c);
    }

    await auditLogStatement(db, {
      userId: adminUser.id,
      action: "api_key_revoked",
      resourceType: "token",
      resourceId: String(preRow.id),
      details: JSON.stringify({
        name: preRow.name,
        prefix: preRow.prefix,
        via: "admin",
        for_user_id: target.id,
        for_username: username,
      }),
    })
      .run()
      .catch((err) =>
        console.error("[admin-user-keys] failed to write api_key_revoked audit row", err),
      );

    return c.json({ ok: true });
  });
}
