/**
 * The wire shapes of the OpenID Connect provider's owner routes (epic #2014 phase #2016; ADR 0119,
 * decision 8):
 *
 *   POST /admin/oidc/clients                          register a client; shows its secret once
 *   GET  /admin/oidc/clients                          every client
 *   GET  /admin/oidc/clients/:client_id               one client
 *   POST /admin/oidc/clients/:client_id/rotate-secret a new secret, the old one valid for a grace
 *   POST /admin/oidc/clients/:client_id/disable       cut a client off
 *   GET  /admin/oidc/keys                             the signing keys, never their private half
 *   POST /admin/oidc/keys/rotate                      make the first keys, or rotate them
 *   POST /admin/oidc/keys/:kid/revoke                 withdraw a retired key from the key set
 *
 * Owner role, on the issuer's host only. A refusal is `{ error: <sentence>, code: <word> }`; the
 * words are {@link OIDC_ADMIN_ERROR_CODES} and are the API.
 *
 * LENIENT ON PURPOSE. A CLI that was released before a field existed parses these answers, so the
 * response shapes pass unknown keys through and no schema here is closed (the contract tests
 * refuse a closed one). The request shapes are lenient for the same reason, and the Worker refuses
 * an unknown request field at the route (`code: invalid_body`), which a zod schema would do by
 * being closed, and which the contract's no-closed-schema rule does not allow here.
 *
 * Words the Worker may add are plain `string`s in a response (a sign-in rule, a status), so a new
 * word is not a parse failure in an older CLI. The request shapes check the words the owner types,
 * against the same lists the Worker uses.
 */

import { z } from "zod";
import {
  OIDC_AUDIENCE_MAX_LENGTH,
  OIDC_CLIENT_NAME_MAX_LENGTH,
  OIDC_CONSENT_MODES,
  OIDC_GRANTS,
  OIDC_MAX_INTROSPECTION_AUDIENCES,
  OIDC_MAX_REDIRECT_URIS,
  OIDC_SCOPE_NAMES,
  OIDC_SECRET_GRACE_HOURS_MAX,
  OIDC_SIGN_IN_RULES,
  OIDC_URI_MAX_LENGTH,
} from "../oidc.js";

/** The words an owner route refuses with, in `code`. */
export const OIDC_ADMIN_ERROR_CODES = [
  "invalid_body",
  "invalid_client_id",
  "invalid_name",
  "invalid_redirect_uri",
  "duplicate_redirect_uri",
  "invalid_scope",
  "invalid_grant",
  "scope_grant_mismatch",
  "first_party_not_allowed",
  "invalid_logout_uri",
  "invalid_audience",
  "client_not_found",
  "client_disabled",
  "rotation_too_early",
  "rotation_next_too_new",
  "rotation_conflict",
  "key_unreadable",
  "invalid_kid",
  "key_not_found",
  "key_not_revocable",
] as const;

export type OidcAdminErrorCode = (typeof OIDC_ADMIN_ERROR_CODES)[number];

const oneOf = (words: readonly string[], what: string) =>
  z
    .string()
    .refine((v) => words.includes(v), { message: `${what} must be one of: ${words.join(", ")}` });

/** A cap: a whole number, zero or more, or null for none. */
const cap = z.number().int().min(0).nullable().optional();

/** The body of `POST /admin/oidc/clients`. */
export const oidcClientCreateRequestSchema = z.object({
  name: z.string().min(1).max(OIDC_CLIENT_NAME_MAX_LENGTH),
  redirect_uris: z
    .array(z.string().min(1).max(OIDC_URI_MAX_LENGTH))
    .min(1)
    .max(OIDC_MAX_REDIRECT_URIS),
  allowed_scopes: z.array(z.string()).min(1).max(OIDC_SCOPE_NAMES.length),
  allowed_grants: z.array(z.string()).min(1).max(OIDC_GRANTS.length),
  sign_in_rule: oneOf(OIDC_SIGN_IN_RULES, "sign_in_rule"),
  first_party: z.boolean().optional(),
  consent_mode: oneOf(OIDC_CONSENT_MODES, "consent_mode").optional(),
  backchannel_logout_uri: z.string().min(1).max(OIDC_URI_MAX_LENGTH).nullable().optional(),
  audience: z.string().min(1).max(OIDC_AUDIENCE_MAX_LENGTH),
  introspection_audiences: z
    .array(z.string().min(1).max(OIDC_AUDIENCE_MAX_LENGTH))
    .max(OIDC_MAX_INTROSPECTION_AUDIENCES)
    .optional(),
  cap_open_reservations: cap,
  cap_su_per_day: cap,
});
export type OidcClientCreateRequest = z.infer<typeof oidcClientCreateRequestSchema>;

/** The field names the create route accepts; anything else is refused by name. */
export const OIDC_CLIENT_CREATE_FIELDS: readonly string[] = Object.keys(
  oidcClientCreateRequestSchema.shape,
);

/** The body of `POST /admin/oidc/clients/:client_id/rotate-secret`; an empty body is the default. */
export const oidcClientRotateRequestSchema = z.object({
  graceHours: z.number().int().min(0).max(OIDC_SECRET_GRACE_HOURS_MAX).optional(),
});
export const OIDC_CLIENT_ROTATE_FIELDS: readonly string[] = Object.keys(
  oidcClientRotateRequestSchema.shape,
);

/** The body of `POST /admin/oidc/keys/rotate`; an empty body is not forced. */
export const oidcKeysRotateRequestSchema = z.object({
  force: z.boolean().optional(),
  /** With `force`: rotate even though the next key was published under 6 minutes ago. */
  emergency: z.boolean().optional(),
});
export const OIDC_KEYS_ROTATE_FIELDS: readonly string[] = Object.keys(
  oidcKeysRotateRequestSchema.shape,
);

/**
 * One client as the owner sees it. NO secret and NO hash: the secret is in the answer that creates
 * or rotates it and nowhere else, and a hash is returned by nothing.
 * `previous_secret_expires_at` is set only while a rotation's grace is still running.
 */
export const oidcClientViewSchema = z
  .object({
    client_id: z.string(),
    name: z.string(),
    redirect_uris: z.array(z.string()),
    allowed_scopes: z.array(z.string()),
    allowed_grants: z.array(z.string()),
    sign_in_rule: z.string(),
    first_party: z.boolean(),
    consent_mode: z.string(),
    backchannel_logout_uri: z.string().nullable(),
    audience: z.string(),
    introspection_audiences: z.array(z.string()),
    cap_open_reservations: z.number().nullable(),
    cap_su_per_day: z.number().nullable(),
    status: z.string(),
    disabled_at: z.string().nullable(),
    previous_secret_expires_at: z.string().nullable(),
    created_by: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();
export type OidcClientView = z.infer<typeof oidcClientViewSchema>;

/** `POST /admin/oidc/clients`: 201, the client and its secret, shown this once. */
export const oidcClientCreateResponseSchema = z
  .object({ client: oidcClientViewSchema, client_secret: z.string() })
  .passthrough();
export type OidcClientCreateResponse = z.infer<typeof oidcClientCreateResponseSchema>;

/** `GET /admin/oidc/clients`. */
export const oidcClientListResponseSchema = z
  .object({ clients: z.array(oidcClientViewSchema) })
  .passthrough();
export type OidcClientListResponse = z.infer<typeof oidcClientListResponseSchema>;

/** `GET /admin/oidc/clients/:client_id`. */
export const oidcClientShowResponseSchema = z
  .object({ client: oidcClientViewSchema })
  .passthrough();
export type OidcClientShowResponse = z.infer<typeof oidcClientShowResponseSchema>;

/** `POST /admin/oidc/clients/:client_id/rotate-secret`: the new secret, shown this once. */
export const oidcClientRotateResponseSchema = z
  .object({
    client: oidcClientViewSchema,
    client_secret: z.string(),
    grace_hours: z.number(),
  })
  .passthrough();
export type OidcClientRotateResponse = z.infer<typeof oidcClientRotateResponseSchema>;

/** `POST /admin/oidc/clients/:client_id/disable`: `changed` is false when it already was. */
export const oidcClientDisableResponseSchema = z
  .object({ client: oidcClientViewSchema, changed: z.boolean() })
  .passthrough();
export type OidcClientDisableResponse = z.infer<typeof oidcClientDisableResponseSchema>;

/** One signing key. There is no private member on this shape, by construction. */
export const oidcKeyViewSchema = z
  .object({
    kid: z.string(),
    alg: z.string(),
    state: z.string(),
    created_at: z.string(),
    promoted_at: z.string().nullable(),
    retired_at: z.string().nullable(),
    // Optional: a Worker that predates the revoked state does not send it.
    revoked_at: z.string().nullable().optional(),
    promotable_at: z.string().nullable(),
  })
  .passthrough();
export type OidcKeyView = z.infer<typeof oidcKeyViewSchema>;

/** `GET /admin/oidc/keys`. */
export const oidcKeysResponseSchema = z.object({ keys: z.array(oidcKeyViewSchema) }).passthrough();
export type OidcKeysResponse = z.infer<typeof oidcKeysResponseSchema>;

/** `POST /admin/oidc/keys/rotate`: what happened, and the keys afterwards. */
export const oidcKeysRotateResponseSchema = z
  .object({ action: z.string(), keys: z.array(oidcKeyViewSchema) })
  .passthrough();
export type OidcKeysRotateResponse = z.infer<typeof oidcKeysRotateResponseSchema>;

/** `POST /admin/oidc/keys/:kid/revoke`: `changed` is false when the key already was revoked. */
export const oidcKeyRevokeResponseSchema = z
  .object({ key: oidcKeyViewSchema, changed: z.boolean() })
  .passthrough();
export type OidcKeyRevokeResponse = z.infer<typeof oidcKeyRevokeResponseSchema>;
