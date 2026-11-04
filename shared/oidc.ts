/**
 * The OpenID Connect provider's fixed vocabulary (epic #2014 phase #2016; ADR 0119).
 *
 * Pure and import-free. The Worker, the CLI and the tests read this one definition; any other
 * repository that needs it transcribes it (as `shared/contract/account-copy.ts` is transcribed by
 * the website), and nothing outside this repository reads this file today.
 *
 * What is here is what a client can come to depend on, so it moves only by a decision: the scope
 * catalogue (ADR 0119 rule 6), the grants and sign-in rules a client is registered with (rules 1
 * and 7), the token prefixes and lifetimes (rule 4), the identifier formats and the endpoint paths
 * (rule 2). The issuer is deliberately NOT here: it is the Worker's `API_BASE_URL`, and nothing
 * derived from a request (`backend/src/services/oidc-config.ts`).
 */

// ---------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------

/** One scope of the catalogue: its name, whether only a machine may hold it, and its claims. */
export interface OidcScopeDefinition {
  readonly name: string;
  /**
   * True for a scope granted only to a client under the client credentials grant, never by a
   * person's consent (ADR 0119 rules 1 and 6). Such a scope is never on a consent screen.
   */
  readonly machineOnly: boolean;
  /**
   * The claims the scope adds to what a client reads, as ADR 0119 rule 6 names them. A scope the
   * ADR gives no claim (`nemar.account` is "account kind, status and tier" with no claim name;
   * the compute scopes are read through the API, never from a token) declares none, and discovery
   * advertises none: the userinfo phase names `nemar.account`'s claims.
   */
  readonly claims: readonly string[];
}

/** The scope catalogue, in the order of ADR 0119 rule 6. */
export const OIDC_SCOPES: readonly OidcScopeDefinition[] = [
  { name: "openid", machineOnly: false, claims: ["sub"] },
  { name: "profile", machineOnly: false, claims: ["name", "given_name", "family_name"] },
  { name: "email", machineOnly: false, claims: ["email", "email_verified"] },
  { name: "orcid", machineOnly: false, claims: ["orcid", "orcid_verified"] },
  { name: "nemar.account", machineOnly: false, claims: [] },
  { name: "offline_access", machineOnly: false, claims: [] },
  { name: "compute.read", machineOnly: false, claims: [] },
  { name: "compute.reserve", machineOnly: false, claims: [] },
  { name: "compute.submit", machineOnly: false, claims: [] },
  { name: "compute.stats", machineOnly: true, claims: [] },
];

/** The names of {@link OIDC_SCOPES}, in the same order. */
export const OIDC_SCOPE_NAMES: readonly string[] = OIDC_SCOPES.map((s) => s.name);

/** True for a string that names a scope of the catalogue, exactly. */
export function isOidcScope(value: unknown): value is string {
  return typeof value === "string" && OIDC_SCOPE_NAMES.includes(value);
}

/** True for a catalogue scope that only a machine may hold (`compute.stats`). */
export function isMachineOnlyScope(name: string): boolean {
  return OIDC_SCOPES.some((s) => s.name === name && s.machineOnly);
}

/**
 * The claims discovery advertises (`claims_supported`): the identity token's own, then each
 * scope's in catalogue order. An advertised list that is shorter than what is served is allowed
 * by the discovery specification; one that names a claim that is never served is not, which is why
 * `nemar.account` is absent until its claims are named.
 */
export function oidcClaimsSupported(): string[] {
  const own = ["iss", "sub", "aud", "exp", "iat", "nonce"];
  const fromScopes = OIDC_SCOPES.flatMap((s) => s.claims).filter((c) => !own.includes(c));
  return [...own, ...fromScopes];
}

// ---------------------------------------------------------------------------------------------
// What a client is registered with
// ---------------------------------------------------------------------------------------------

/** The grants a client may be allowed (ADR 0119 rules 1 and 3). No implicit, no password grant. */
export const OIDC_GRANTS = ["authorization_code", "refresh_token", "client_credentials"] as const;
export type OidcGrant = (typeof OIDC_GRANTS)[number];

/** True for a string that names a grant of {@link OIDC_GRANTS}, exactly. */
export function isOidcGrant(value: unknown): value is OidcGrant {
  return typeof value === "string" && (OIDC_GRANTS as readonly string[]).includes(value);
}

/** Who may sign in to a client (ADR 0119 rule 7). */
export const OIDC_SIGN_IN_RULES = ["active_account", "person_proven_orcid"] as const;
export type OidcSignInRule = (typeof OIDC_SIGN_IN_RULES)[number];

/** True for a string that names a sign-in rule, exactly. */
export function isOidcSignInRule(value: unknown): value is OidcSignInRule {
  return typeof value === "string" && (OIDC_SIGN_IN_RULES as readonly string[]).includes(value);
}

/**
 * How a client that is not first-party is asked for consent: once per set of scopes (`ask_once`, the
 * default) or on every authorization (`always`). A first-party client skips the screen; no client
 * with a redirect address outside NEMAR's own origins ever does.
 */
export const OIDC_CONSENT_MODES = ["ask_once", "always"] as const;
export type OidcConsentMode = (typeof OIDC_CONSENT_MODES)[number];

/** True for a string that names a consent mode, exactly. */
export function isOidcConsentMode(value: unknown): value is OidcConsentMode {
  return typeof value === "string" && (OIDC_CONSENT_MODES as readonly string[]).includes(value);
}

/** The most redirect addresses a client may register. */
export const OIDC_MAX_REDIRECT_URIS = 10;

/** The longest redirect or back-channel logout address, in characters. */
export const OIDC_URI_MAX_LENGTH = 2000;

/** The longest client name, in characters. */
export const OIDC_CLIENT_NAME_MAX_LENGTH = 100;

/**
 * The most scopes a client may be allowed. The catalogue has ten; the table's CHECK allows this many,
 * so a new scope needs no migration while the catalogue stays within it (a test pins that).
 */
export const OIDC_MAX_ALLOWED_SCOPES = 20;

/** The longest audience identifier, in characters. */
export const OIDC_AUDIENCE_MAX_LENGTH = 200;

/** The most introspection audiences a client may name. */
export const OIDC_MAX_INTROSPECTION_AUDIENCES = 10;

/** How long the previous secret stays valid after a rotation when the owner names no time. */
export const OIDC_SECRET_GRACE_HOURS_DEFAULT = 24;

/** The longest a previous secret may stay valid after a rotation. */
export const OIDC_SECRET_GRACE_HOURS_MAX = 168;

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

/** Every client id starts with this. */
export const OIDC_CLIENT_ID_PREFIX = "oc_";

/** Lowercase hexadecimal characters after the prefix (96 random bits). */
export const OIDC_CLIENT_ID_HEX_LENGTH = 24;

const CLIENT_ID_RE = new RegExp(`^${OIDC_CLIENT_ID_PREFIX}[0-9a-f]{${OIDC_CLIENT_ID_HEX_LENGTH}}$`);

/** True for a string of exactly the client id format. */
export function isOidcClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_RE.test(value);
}

/**
 * Every client secret starts with this, so a secret scanner can find one. Tokens are opaque and a
 * secret is checked by its hash only, so the prefix is a convention inside the Worker and nothing
 * else depends on it.
 */
export const OIDC_CLIENT_SECRET_PREFIX = "nmo_cs_";

/** Base64url characters after the prefix: 256 random bits, unpadded. */
export const OIDC_CLIENT_SECRET_BODY_LENGTH = 43;

/** Lowercase hexadecimal characters of a signing key id (64 random bits). */
export const OIDC_KID_HEX_LENGTH = 16;

const KID_RE = new RegExp(`^[0-9a-f]{${OIDC_KID_HEX_LENGTH}}$`);

/** True for a string of exactly the key id format. */
export function isOidcKid(value: unknown): value is string {
  return typeof value === "string" && KID_RE.test(value);
}

// ---------------------------------------------------------------------------------------------
// Signing keys
// ---------------------------------------------------------------------------------------------

/** The one signing algorithm: ECDSA over P-256 with SHA-256. */
export const OIDC_SIGNING_ALG = "ES256";

/** A `next` key signs only once it has been published this long, unless the owner forces it. */
export const OIDC_KEY_MIN_NEXT_AGE_HOURS = 24;

/** A retired key stays in the published set this long. */
export const OIDC_RETIRED_KEY_PUBLISH_DAYS = 7;

/** At most this many retired keys are published, the most recently retired first. */
export const OIDC_RETIRED_KEY_PUBLISH_MAX = 5;

/**
 * How long a client may cache discovery and the key set: their `Cache-Control: max-age`. It bounds
 * how long a client can go on using a key set that predates a rotation or a revocation.
 */
export const OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS = 300;

/**
 * `keys rotate --force` refuses while the next key is younger than this many minutes, unless the
 * owner says it is an emergency: a key that has been published for a moment may not be in the key
 * set a client cached, so a token signed with it can fail verification there for about five minutes
 * (the key set's `Cache-Control: max-age`).
 */
export const OIDC_FORCE_MIN_NEXT_AGE_MINUTES = 6;

/** `OIDC_SECRET` encrypts the private keys at rest: shorter than this and the provider is off. */
export const OIDC_SECRET_MIN_LENGTH = 32;

// ---------------------------------------------------------------------------------------------
// Tokens (ADR 0119 rule 4)
// ---------------------------------------------------------------------------------------------

/** Access tokens are opaque and start with this; API keys start with `nm_`, which does not match. */
export const OIDC_ACCESS_TOKEN_PREFIX = "nmo_at_";

/** Refresh tokens are opaque and start with this. */
export const OIDC_REFRESH_TOKEN_PREFIX = "nmo_rt_";

/** An authorization code is single use and lives this long. */
export const OIDC_AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** An identity token lives 5 minutes. */
export const OIDC_ID_TOKEN_TTL_SECONDS = 5 * 60;

/** An access token lives 15 minutes. */
export const OIDC_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** A refresh token expires after this long without use. */
export const OIDC_REFRESH_TOKEN_IDLE_SECONDS = 30 * 24 * 60 * 60;

/** A refresh token family expires this long after it began, however often it is used. */
export const OIDC_REFRESH_TOKEN_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;

/** A spent refresh token is still accepted this long, for a request that was retried. */
export const OIDC_REFRESH_GRACE_SECONDS = 30;

// ---------------------------------------------------------------------------------------------
// Endpoint paths (ADR 0119 rule 2). The issuer and the host they are served from are the Worker's.
// ---------------------------------------------------------------------------------------------

/** The discovery document, at the issuer's `.well-known` root. */
export const OIDC_DISCOVERY_PATH = "/.well-known/openid-configuration";

/** The signing keys' public set. */
export const OIDC_JWKS_PATH = "/oauth/jwks";

/** The authorization endpoint's path, on the app host (the sign-in cookie lives only there). */
export const OIDC_AUTHORIZE_PATH = "/oauth/authorize";

/** The token endpoint's path, on the issuer. */
export const OIDC_TOKEN_PATH = "/oauth/token";

/** The userinfo endpoint's path, on the issuer. */
export const OIDC_USERINFO_PATH = "/oauth/userinfo";

/** The revocation endpoint's path (RFC 7009), on the issuer. */
export const OIDC_REVOKE_PATH = "/oauth/revoke";

/** The introspection endpoint's path (RFC 7662), on the issuer. */
export const OIDC_INTROSPECT_PATH = "/oauth/introspect";

/**
 * The two documents that live on the issuer host permanently and are exempt from the maintenance
 * mode and from the rate limiter (ADR 0119, Alternatives considered): a client that cannot fetch
 * them during maintenance or a burst cannot validate a token.
 */
export const OIDC_PUBLIC_DOCUMENT_PATHS: readonly string[] = [OIDC_DISCOVERY_PATH, OIDC_JWKS_PATH];
