/**
 * NEMAR API client: the OpenID Connect provider's client registry and signing keys (epic #2014
 * phase #2016; ADR 0119), `/admin/oidc/...`. Owner role, and only on a Worker whose provider is on
 * (`OIDC_SECRET` set) and whose host is the issuer's: anywhere else the routes do not exist.
 *
 * The wire shapes are `shared/contract/oidc-admin.ts`, parsed leniently. A refusal answers
 * `{ error: <sentence>, code: <word> }`: the sentence is `ApiError.message`, and the word is read
 * with {@link oidcErrorCode}, never from `ApiError.code` (which is the body's `error`, the sentence,
 * under this convention).
 */

import {
  type OidcClientCreateRequest,
  type OidcClientCreateResponse,
  type OidcClientDisableResponse,
  type OidcClientListResponse,
  type OidcClientRotateResponse,
  type OidcClientShowResponse,
  type OidcKeysResponse,
  type OidcKeysRotateResponse,
  oidcClientCreateResponseSchema,
  oidcClientDisableResponseSchema,
  oidcClientListResponseSchema,
  oidcClientRotateResponseSchema,
  oidcClientShowResponseSchema,
  oidcKeysResponseSchema,
  oidcKeysRotateResponseSchema,
} from "../../../shared/contract/oidc-admin.js";
import { request } from "./client.js";
import { ApiError } from "./errors.js";

const BASE = "/admin/oidc";

/** `POST /admin/oidc/clients`: the client and its secret, which the Worker shows this once. */
export async function createOidcClient(
  body: OidcClientCreateRequest,
): Promise<OidcClientCreateResponse> {
  return request(
    `${BASE}/clients`,
    { method: "POST", body: JSON.stringify(body) },
    true,
    oidcClientCreateResponseSchema,
  );
}

/** `GET /admin/oidc/clients`: every client, oldest first. No secret, no hash. */
export async function listOidcClients(): Promise<OidcClientListResponse> {
  return request(`${BASE}/clients`, {}, true, oidcClientListResponseSchema);
}

/** `GET /admin/oidc/clients/:client_id`. */
export async function getOidcClient(clientId: string): Promise<OidcClientShowResponse> {
  return request(
    `${BASE}/clients/${encodeURIComponent(clientId)}`,
    {},
    true,
    oidcClientShowResponseSchema,
  );
}

/**
 * `POST /admin/oidc/clients/:client_id/rotate-secret`: a new secret, shown this once, and the old
 * one valid for `graceHours` (the Worker's default is 24; 0 ends it at once).
 */
export async function rotateOidcClientSecret(
  clientId: string,
  graceHours?: number,
): Promise<OidcClientRotateResponse> {
  return request(
    `${BASE}/clients/${encodeURIComponent(clientId)}/rotate-secret`,
    { method: "POST", body: JSON.stringify(graceHours === undefined ? {} : { graceHours }) },
    true,
    oidcClientRotateResponseSchema,
  );
}

/** `POST /admin/oidc/clients/:client_id/disable`: `changed` is false when it already was. */
export async function disableOidcClient(clientId: string): Promise<OidcClientDisableResponse> {
  return request(
    `${BASE}/clients/${encodeURIComponent(clientId)}/disable`,
    { method: "POST", body: "{}" },
    true,
    oidcClientDisableResponseSchema,
  );
}

/** `GET /admin/oidc/keys`: the signing keys and their states. Never the private half. */
export async function listOidcKeys(): Promise<OidcKeysResponse> {
  return request(`${BASE}/keys`, {}, true, oidcKeysResponseSchema);
}

/** `POST /admin/oidc/keys/rotate`: make the first keys, or rotate them (`force` skips the 24 hours). */
export async function rotateOidcKeys(force?: boolean): Promise<OidcKeysRotateResponse> {
  return request(
    `${BASE}/keys/rotate`,
    { method: "POST", body: JSON.stringify(force ? { force: true } : {}) },
    true,
    oidcKeysRotateResponseSchema,
  );
}

/** The closed word of a refusal (`rawBody.code`), when the Worker sent one. */
export function oidcErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const body = error.rawBody as { code?: unknown } | undefined;
  return typeof body?.code === "string" ? body.code : undefined;
}
