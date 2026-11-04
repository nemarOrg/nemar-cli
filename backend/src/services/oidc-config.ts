/**
 * The OpenID Connect provider's configuration and its discovery document (epic #2014 phase
 * #2016; ADR 0119, decision 2).
 *
 * THE ISSUER IS `API_BASE_URL`, TRIMMED OF TRAILING SLASHES, AND NOTHING DERIVED FROM A REQUEST.
 * An identity token carries exactly that `iss`, a client trusts it for as long as it exists, and a
 * value read from the request's `Host` or from a forwarded header would let a caller choose it.
 * Each Worker's issuer is therefore its own `API_BASE_URL`: the production Worker's is the API
 * host's origin, the staging Worker's is its own, and a Worker that is reached under another name
 * answers 404 (`onOidcSurface`) rather than a document naming an issuer it is not.
 *
 * THE PROVIDER IS ON ONLY WITH A SECRET. `OIDC_SECRET` encrypts the private signing keys at rest,
 * so with none (or one under 32 characters) there is nothing safe to sign with and every OIDC
 * surface answers 404, indistinguishable from a route that does not exist.
 *
 * Pure functions of the bindings and a URL: no I/O, so the tables here are unit-testable without
 * instantiating the Worker, as `cors-origins.ts` is.
 */

import {
  OIDC_AUTHORIZE_PATH,
  OIDC_GRANTS,
  OIDC_INTROSPECT_PATH,
  OIDC_JWKS_PATH,
  OIDC_REVOKE_PATH,
  OIDC_SCOPE_NAMES,
  OIDC_SECRET_MIN_LENGTH,
  OIDC_SIGNING_ALG,
  OIDC_TOKEN_PATH,
  OIDC_USERINFO_PATH,
  oidcClaimsSupported,
} from "../../../shared/oidc.js";
import type { Bindings } from "../types/bindings.js";
import { appBase } from "./environment.js";

/** The legacy mount the Worker also answers under (`api.osc.earth/nemar`). Never an OIDC surface. */
const LEGACY_MOUNT = "/nemar";

/** The issuer: `API_BASE_URL` without trailing slashes. Empty only when the binding is unset. */
export function oidcIssuer(env: Pick<Bindings, "API_BASE_URL">): string {
  return (env.API_BASE_URL ?? "").trim().replace(/\/+$/, "");
}

/** True only when `OIDC_SECRET` is set and at least 32 characters. */
export function oidcEnabled(env: Pick<Bindings, "OIDC_SECRET">): boolean {
  return typeof env.OIDC_SECRET === "string" && env.OIDC_SECRET.length >= OIDC_SECRET_MIN_LENGTH;
}

/** The issuer's hostname, or null when `API_BASE_URL` is not a URL. */
function issuerHostname(env: Pick<Bindings, "API_BASE_URL">): string | null {
  try {
    const host = new URL(oidcIssuer(env)).hostname;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * Whether a request is on the OIDC surface: the provider is enabled, the request's own URL names
 * the issuer's host, and its path is not under the legacy `/nemar` mount.
 *
 * The host is read from the request URL, which the platform builds from the route that matched,
 * never from a `Host` header a caller could forge, and it is compared with the host of the issuer
 * (`API_BASE_URL`), not with anything the request says. The data, zarr and MCP hosts are forked
 * before the API app is reached (`resolveHostRoute`), and the legacy mount reaches the same
 * handlers under a prefix: both are refused here, so each OIDC route and each owner route behind
 * `oidcSurface` exists on one host and one path only.
 */
export function onOidcSurface(
  env: Pick<Bindings, "API_BASE_URL" | "OIDC_SECRET">,
  requestUrl: string,
): boolean {
  if (!oidcEnabled(env)) return false;
  const issuerHost = issuerHostname(env);
  if (issuerHost === null) return false;
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return false;
  }
  if (request.pathname === LEGACY_MOUNT || request.pathname.startsWith(`${LEGACY_MOUNT}/`)) {
    return false;
  }
  return request.hostname === issuerHost;
}

/**
 * The discovery document (OpenID Connect Discovery 1.0): what a client reads to find the
 * endpoints, the keys and what NEMAR supports. The authorization endpoint is on the APP host,
 * because the sign-in cookie lives only there (ADR 0119 rule 2); every other endpoint is under the
 * issuer.
 *
 * `claims_supported` lists the claims ADR 0119 names, which for `nemar.account` is none yet.
 * `request_parameter_supported` and `request_uri_parameter_supported` are false: the OpenID Connect
 * default for the second is TRUE, so leaving it out would tell a client it may send a request
 * object by reference.
 */
export function buildDiscoveryDocument(
  env: Pick<Bindings, "API_BASE_URL" | "APP_BASE_URL">,
): Record<string, unknown> {
  const issuer = oidcIssuer(env);
  return {
    issuer,
    authorization_endpoint: `${appBase(env)}${OIDC_AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${OIDC_TOKEN_PATH}`,
    userinfo_endpoint: `${issuer}${OIDC_USERINFO_PATH}`,
    jwks_uri: `${issuer}${OIDC_JWKS_PATH}`,
    revocation_endpoint: `${issuer}${OIDC_REVOKE_PATH}`,
    introspection_endpoint: `${issuer}${OIDC_INTROSPECT_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: [...OIDC_GRANTS],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [OIDC_SIGNING_ALG],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...OIDC_SCOPE_NAMES],
    claims_supported: oidcClaimsSupported(),
    authorization_response_iss_parameter_supported: true,
    backchannel_logout_supported: true,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  };
}
