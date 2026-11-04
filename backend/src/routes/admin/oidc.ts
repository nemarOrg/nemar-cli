/**
 * Admin routes: the OpenID Connect provider's client registry and signing keys (epic #2014 phase
 * #2016; ADR 0119, decision 8). Owner role, behind `oidcSurface`.
 *
 *   POST /admin/oidc/clients                           register a client; its secret is shown once
 *   GET  /admin/oidc/clients                           every client
 *   GET  /admin/oidc/clients/:client_id                one client
 *   POST /admin/oidc/clients/:client_id/rotate-secret  a new secret; `graceHours` (default 24)
 *                                                      keeps the old one valid for that long
 *   POST /admin/oidc/clients/:client_id/disable        cut a client off (the status only; what the
 *                                                      client holds is revoked by phase #2019)
 *   GET  /admin/oidc/keys                              the signing keys, never their private half
 *   POST /admin/oidc/keys/rotate                       make the first keys, or rotate them
 *   POST /admin/oidc/keys/:kid/revoke                  withdraw a retired key from the key set
 *
 * WHO AND WHERE. `ownerMiddleware` first, so a caller is told what they are (401, 403) whether or not
 * the surface exists; then `oidcSurface`, which makes every route 404 unless the provider is on
 * (`OIDC_SECRET`), the request is on the issuer's host and the path is not under the legacy `/nemar`
 * mount. Both are one `use` for the whole prefix, so a route added under `/oidc/` cannot forget
 * either; `test/oidc-admin-routes.test.ts` walks the router's own table to hold it to that.
 *
 * WHAT IS RETURNED. A secret appears once, in the answer that creates or rotates it, with
 * `Cache-Control: no-store`; no hash, no private JSON Web Key and no ciphertext is returned by any
 * route. A refusal is `{ error, code }` (the words are `OIDC_ADMIN_ERROR_CODES`) and names the field
 * and never echoes what was sent. The audit rows hold the shape of an act and none of its content.
 * Nothing here sends mail, calls GitHub or reaches a person.
 *
 * REQUEST BODIES are checked by the contract's lenient zod shapes, and an unknown field is refused by
 * name here, because a closed schema is not allowed under `shared/contract/` (a released CLI parses
 * those files).
 */

import type { Context } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  OIDC_CLIENT_CREATE_FIELDS,
  OIDC_CLIENT_ROTATE_FIELDS,
  OIDC_KEYS_ROTATE_FIELDS,
  type OidcAdminErrorCode,
  oidcClientCreateRequestSchema,
  oidcClientRotateRequestSchema,
  oidcKeysRotateRequestSchema,
} from "../../../../shared/contract/oidc-admin";
import {
  OIDC_CLIENT_ID_HEX_LENGTH,
  OIDC_CLIENT_ID_PREFIX,
  OIDC_FORCE_MIN_NEXT_AGE_MINUTES,
  OIDC_KEY_MIN_NEXT_AGE_HOURS,
  OIDC_KID_HEX_LENGTH,
  isOidcClientId,
  isOidcKid,
} from "../../../../shared/oidc";
import { ownerMiddleware } from "../../middleware/auth";
import {
  createClient,
  disableClient,
  getClient,
  listClients,
  rotateClientSecret,
} from "../../services/oidc-clients";
import { listSigningKeys, revokeSigningKey, rotateSigningKeys } from "../../services/oidc-keys";
import type { Bindings, Variables } from "../../types/bindings";
import { oidcSurface } from "../oidc-discovery";
import type { AdminRouter } from "./shared";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

function refusal(
  c: Ctx,
  status: 400 | 404 | 409,
  code: OidcAdminErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return c.json({ error: message, code, ...extra }, status);
}

/** A field name that is safe to say back: short and plain. Anything else is "?". */
const sayable = (key: string): string => (/^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : "?");

type Parsed<S extends ZodTypeAny> =
  | { ok: true; value: z.infer<S> }
  | { ok: false; response: Response };

/**
 * Read a JSON object body, refuse an unknown field by name, and check the rest against the
 * contract's shape. An empty body is `{}`, so a route whose fields are all optional takes none, and
 * one with required fields refuses by naming them. The refusal names fields and never echoes a value.
 */
async function parseBody<S extends ZodTypeAny>(
  c: Ctx,
  schema: S,
  fields: readonly string[],
): Promise<Parsed<S>> {
  const bad = (message: string): Parsed<S> => ({
    ok: false,
    response: refusal(c, 400, "invalid_body", `The request body is not valid: ${message}`),
  });
  const text = await c.req.text();
  let body: unknown;
  if (text.trim() === "") {
    body = {};
  } else {
    try {
      body = JSON.parse(text);
    } catch {
      return bad("it is not JSON.");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("a JSON object is required.");
  }
  const unknown = Object.keys(body).filter((k) => !fields.includes(k));
  if (unknown.length > 0) {
    return bad(`this route does not take: ${unknown.slice(0, 5).map(sayable).join(", ")}.`);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
    return bad(issues.join("; "));
  }
  return { ok: true, value: result.data };
}

/** The client id of the path, or the refusal for one that is not an id. */
function clientIdParam(c: Ctx): { id: string } | { response: Response } {
  const id = c.req.param("client_id") ?? "";
  if (!isOidcClientId(id)) {
    return {
      response: refusal(
        c,
        400,
        "invalid_client_id",
        `That is not a client id (${OIDC_CLIENT_ID_PREFIX} and ${OIDC_CLIENT_ID_HEX_LENGTH} lowercase hex characters).`,
      ),
    };
  }
  return { id };
}

export function registerOidcAdminRoutes(admin: AdminRouter): void {
  admin.use("/oidc/*", ownerMiddleware, oidcSurface, async (c, next) => {
    await next();
    // A secret is in some of these answers; none of them is for a shared cache.
    c.res.headers.set("Cache-Control", "no-store");
  });

  admin.post("/oidc/clients", async (c) => {
    const parsed = await parseBody(c, oidcClientCreateRequestSchema, OIDC_CLIENT_CREATE_FIELDS);
    if (!parsed.ok) return parsed.response;
    const result = await createClient(c.env, parsed.value, c.get("user").id);
    if (!result.ok) {
      return refusal(c, 400, result.refusal.code, result.refusal.message, {
        ...(result.refusal.field ? { field: result.refusal.field } : {}),
      });
    }
    return c.json({ client: result.client, client_secret: result.secret }, 201);
  });

  admin.get("/oidc/clients", async (c) => {
    return c.json({ clients: await listClients(c.env.DB) });
  });

  admin.get("/oidc/clients/:client_id", async (c) => {
    const id = clientIdParam(c);
    if ("response" in id) return id.response;
    const client = await getClient(c.env.DB, id.id);
    if (!client) return refusal(c, 404, "client_not_found", "There is no client with that id.");
    return c.json({ client });
  });

  admin.post("/oidc/clients/:client_id/rotate-secret", async (c) => {
    const id = clientIdParam(c);
    if ("response" in id) return id.response;
    const parsed = await parseBody(c, oidcClientRotateRequestSchema, OIDC_CLIENT_ROTATE_FIELDS);
    if (!parsed.ok) return parsed.response;
    const result = await rotateClientSecret(
      c.env,
      id.id,
      parsed.value.graceHours,
      c.get("user").id,
    );
    if (!result.ok) {
      return result.code === "client_not_found"
        ? refusal(c, 404, "client_not_found", "There is no client with that id.")
        : refusal(
            c,
            409,
            "client_disabled",
            "That client is disabled; its secret cannot be rotated.",
          );
    }
    return c.json({
      client: result.client,
      client_secret: result.secret,
      grace_hours: result.graceHours,
    });
  });

  admin.post("/oidc/clients/:client_id/disable", async (c) => {
    const id = clientIdParam(c);
    if ("response" in id) return id.response;
    const result = await disableClient(c.env, id.id, c.get("user").id);
    if (!result.ok) return refusal(c, 404, "client_not_found", "There is no client with that id.");
    return c.json({ client: result.client, changed: result.changed });
  });

  admin.get("/oidc/keys", async (c) => {
    return c.json({ keys: await listSigningKeys(c.env.DB) });
  });

  admin.post("/oidc/keys/rotate", async (c) => {
    const parsed = await parseBody(c, oidcKeysRotateRequestSchema, OIDC_KEYS_ROTATE_FIELDS);
    if (!parsed.ok) return parsed.response;
    const result = await rotateSigningKeys(c.env, {
      force: parsed.value.force === true,
      emergency: parsed.value.emergency === true,
      actorId: c.get("user").id,
    });
    if (result.ok) return c.json({ action: result.action, keys: result.keys });
    if (result.code === "forced_too_early") {
      return refusal(
        c,
        409,
        "rotation_next_too_new",
        `The next key was published under ${OIDC_FORCE_MIN_NEXT_AGE_MINUTES} minutes ago. A client may not have it in the key set it cached, so tokens signed with it can fail verification there for about five minutes. Wait, or say it is an emergency.`,
      );
    }
    if (result.code === "key_unreadable") {
      return refusal(
        c,
        409,
        "key_unreadable",
        "The key about to sign cannot be read: it was encrypted under a different OIDC_SECRET, so the rotation was not done.",
      );
    }
    if (result.code === "too_early") {
      return refusal(
        c,
        409,
        "rotation_too_early",
        `The next key is not ${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours old yet; it may become current at ${result.promotable_at} UTC. Use --force to rotate now.`,
        { promotable_at: result.promotable_at },
      );
    }
    return refusal(
      c,
      409,
      "rotation_conflict",
      "The keys changed while this rotation ran; read them again.",
    );
  });

  admin.post("/oidc/keys/:kid/revoke", async (c) => {
    const kid = c.req.param("kid") ?? "";
    if (!isOidcKid(kid)) {
      return refusal(
        c,
        400,
        "invalid_kid",
        `That is not a key id (${OIDC_KID_HEX_LENGTH} lowercase hex characters).`,
      );
    }
    const result = await revokeSigningKey(c.env, kid, c.get("user").id);
    if (result.ok) return c.json({ key: result.key, changed: result.changed });
    if (result.code === "key_not_found") {
      return refusal(c, 404, "key_not_found", "There is no signing key with that id.");
    }
    return refusal(
      c,
      409,
      "key_not_revocable",
      "Only a retired key can be revoked. Rotate the keys first, then revoke the key once it is retired.",
    );
  });
}
