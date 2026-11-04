/**
 * The OpenID Connect client registry (epic #2014 phase #2016; ADR 0119, decision 8): what a client
 * may be registered with, its secret, and what rotating and disabling do.
 *
 * CLIENTS ARE REGISTERED BY THE OWNER AND NO ONE ELSE. Everything here is reached from the owner
 * routes (`routes/admin/oidc.ts`), and every refusal is a fixed word (`code`) plus a sentence that
 * names the field and never echoes what was typed.
 *
 * THE SECRET. 256 random bits as unpadded base64url, shown once, in the response that creates or
 * rotates it, and stored only as its SHA-256 (`hashApiKey`). A secret that is this long and this
 * random needs no slow hash: there is nothing to guess. Verification compares in constant time and
 * honours the previous secret until its grace ends. A disabled client authenticates with neither.
 *
 * FIRST-PARTY (ADR 0119 rule 8, as amended): a client is first-party, and so skips the consent
 * screen, only when EVERY redirect address is on a NEMAR web origin (`isNemarWebOrigin`, which a
 * partner host never is). A client with any other redirect address is third-party and always shows
 * the consent page. {@link firstPartyRefusal} is the one rule, exported so authorization asks the
 * same question at every request, as the ADR requires.
 */

import type { OidcAdminErrorCode } from "../../../shared/contract/oidc-admin.js";
import {
  OIDC_AUDIENCE_MAX_LENGTH,
  OIDC_CLIENT_ID_HEX_LENGTH,
  OIDC_CLIENT_ID_PREFIX,
  OIDC_CLIENT_NAME_MAX_LENGTH,
  OIDC_GRANTS,
  OIDC_MAX_INTROSPECTION_AUDIENCES,
  OIDC_MAX_REDIRECT_URIS,
  OIDC_SECRET_GRACE_HOURS_DEFAULT,
  OIDC_SECRET_GRACE_HOURS_MAX,
  OIDC_URI_MAX_LENGTH,
  isMachineOnlyScope,
  isOidcScope,
} from "../../../shared/oidc.js";
import { isPartnerHost } from "../../../shared/partner-hosts.js";
import { applyEditWithAudit, auditLogStatement } from "../db/audit-log.js";
import { timingSafeEqual } from "../lib/constant-time.js";
import type { Bindings } from "../types/bindings.js";
import { isNemarWebOrigin } from "./cors-origins.js";
import { isNonProductionEnv } from "./environment.js";
import { hashApiKey } from "./token.js";

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

/** A request to register a client, after the route's shape check (types and bounds). */
export interface ClientInput {
  name: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  allowed_grants: string[];
  sign_in_rule: string;
  first_party?: boolean;
  consent_mode?: string;
  backchannel_logout_uri?: string | null;
  audience: string;
  introspection_audiences?: string[];
  cap_open_reservations?: number | null;
  cap_su_per_day?: number | null;
}

/** A refusal of the registry: a fixed word, a sentence, and the field it is about. */
export interface ClientRefusal {
  code: OidcAdminErrorCode;
  message: string;
  field?: string;
}

/** One client as the owner sees it: no secret, no hash. */
export interface ClientView {
  client_id: string;
  name: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  allowed_grants: string[];
  sign_in_rule: string;
  first_party: boolean;
  consent_mode: string;
  backchannel_logout_uri: string | null;
  audience: string;
  introspection_audiences: string[];
  cap_open_reservations: number | null;
  cap_su_per_day: number | null;
  status: string;
  disabled_at: string | null;
  previous_secret_expires_at: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
}

/** What authentication reads of a client: the status and the two hashes, never returned to a caller. */
export interface ClientAuthRow {
  status: string;
  secret_hash: string;
  previous_secret_hash: string | null;
  previous_secret_expires_at: string | null;
}

// ---------------------------------------------------------------------------------------------
// Identifiers and secrets
// ---------------------------------------------------------------------------------------------

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `oc_` plus 24 lowercase hexadecimal characters (96 random bits). */
export function generateClientId(): string {
  return `${OIDC_CLIENT_ID_PREFIX}${randomHex(OIDC_CLIENT_ID_HEX_LENGTH / 2)}`;
}

/** 256 random bits as 43 unpadded base64url characters. Shown once and stored nowhere. */
export function generateClientSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A SQL timestamp (`YYYY-MM-DD HH:MM:SS`, UTC) as epoch milliseconds; NaN when it is not one. */
function sqlUtcMs(stamp: string): number {
  return Date.parse(`${stamp.replace(" ", "T")}Z`);
}

/**
 * Which of a client's secrets a presented one is, if any: `current`, `previous` (a rotation's
 * grace is still running) or null. Both comparisons are made whatever the first says, in constant
 * time, and a disabled client matches neither. An unparseable expiry is an ended grace: it fails
 * closed.
 */
export async function verifyClientSecret(
  row: ClientAuthRow,
  presented: string,
  now: Date = new Date(),
): Promise<"current" | "previous" | null> {
  if (row.status !== "active") return null;
  const presentedHash = await hashApiKey(presented);
  const currentMatches = timingSafeEqual(presentedHash, row.secret_hash);
  const previousLive =
    row.previous_secret_hash !== null &&
    row.previous_secret_expires_at !== null &&
    sqlUtcMs(row.previous_secret_expires_at) > now.getTime();
  // The same work whether or not there is a previous secret to compare with.
  const previousMatches =
    timingSafeEqual(
      presentedHash,
      previousLive ? (row.previous_secret_hash as string) : row.secret_hash,
    ) && previousLive;
  if (currentMatches) return "current";
  return previousMatches ? "previous" : null;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const refuse = (code: OidcAdminErrorCode, message: string, field?: string): ClientRefusal => ({
  code,
  message,
  ...(field ? { field } : {}),
});

/** Whitespace, a backslash, an asterisk or a control character: none belongs in an address. */
const FORBIDDEN_IN_ADDRESS = /[\s\\*\p{Cc}]/u;

/** Characters that never belong in a name or an audience. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Why an address is not acceptable, or null. Exact addresses only: no wildcard, no fragment, no
 * user information. `https` always; `http` only for a loopback host and only outside production
 * (a developer's machine), never for anything else.
 */
function addressProblem(raw: string, allowLoopbackHttp: boolean): string | null {
  if (raw.length === 0 || raw.length > OIDC_URI_MAX_LENGTH) {
    return `is empty or longer than ${OIDC_URI_MAX_LENGTH} characters`;
  }
  if (FORBIDDEN_IN_ADDRESS.test(raw)) {
    return "contains whitespace, a backslash, a wildcard or a control character";
  }
  if (raw.includes("#")) return "has a fragment";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "is not an absolute address";
  }
  if (url.username !== "" || url.password !== "") return "carries user information";
  if (url.hostname === "") return "has no host";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    return allowLoopbackHttp && isLoopbackHost(url.hostname)
      ? null
      : "uses plain http (only a loopback address, and not in production, may)";
  }
  return "is not an https address";
}

/**
 * Whether a client may be first-party: every redirect address on a NEMAR web origin. Returns the
 * refusal, or null when it may. A partner host is named as such, because that is the case the rule
 * exists for; any other host that NEMAR does not run is the same refusal in other words.
 */
export function firstPartyRefusal(redirectUris: readonly string[]): ClientRefusal | null {
  for (const uri of redirectUris) {
    let host: string;
    try {
      host = new URL(uri).hostname;
    } catch {
      return refuse(
        "first_party_not_allowed",
        "A first-party client needs every redirect address on a NEMAR web origin.",
        "first_party",
      );
    }
    if (isPartnerHost(host)) {
      return refuse(
        "first_party_not_allowed",
        "A client with a redirect address on a partner host cannot be first-party: a partner must never skip the consent screen.",
        "first_party",
      );
    }
    if (!isNemarWebOrigin(host)) {
      return refuse(
        "first_party_not_allowed",
        "A client is first-party only when every redirect address is on a NEMAR web origin; one of these is not, so the client is third-party and shows the consent screen.",
        "first_party",
      );
    }
  }
  return null;
}

function checkAudience(value: string, field: string): ClientRefusal | null {
  if (
    value.length === 0 ||
    value.length > OIDC_AUDIENCE_MAX_LENGTH ||
    /\s/.test(value) ||
    CONTROL_OR_FORMAT.test(value)
  ) {
    return refuse(
      "invalid_audience",
      `${field} must be 1 to ${OIDC_AUDIENCE_MAX_LENGTH} characters with no whitespace or control character.`,
      field,
    );
  }
  return null;
}

/**
 * The registry's rules, in the order an owner meets them. Null when the input may be registered.
 * `env` is read for one thing: whether a loopback address may use plain http.
 */
export function validateClientInput(
  input: ClientInput,
  env: Pick<Bindings, "ENVIRONMENT">,
): ClientRefusal | null {
  const name = input.name.trim();
  if (
    name.length === 0 ||
    name.length > OIDC_CLIENT_NAME_MAX_LENGTH ||
    CONTROL_OR_FORMAT.test(name)
  ) {
    return refuse(
      "invalid_name",
      `name must be 1 to ${OIDC_CLIENT_NAME_MAX_LENGTH} printable characters.`,
      "name",
    );
  }

  const allowLoopbackHttp = isNonProductionEnv(env);
  if (input.redirect_uris.length === 0 || input.redirect_uris.length > OIDC_MAX_REDIRECT_URIS) {
    return refuse(
      "invalid_body",
      `redirect_uris must hold 1 to ${OIDC_MAX_REDIRECT_URIS} addresses.`,
      "redirect_uris",
    );
  }
  const seenUris = new Set<string>();
  for (const [i, uri] of input.redirect_uris.entries()) {
    const problem = addressProblem(uri, allowLoopbackHttp);
    if (problem) {
      return refuse("invalid_redirect_uri", `redirect_uris[${i}] ${problem}.`, "redirect_uris");
    }
    if (seenUris.has(uri)) {
      return refuse(
        "duplicate_redirect_uri",
        `redirect_uris[${i}] is listed twice.`,
        "redirect_uris",
      );
    }
    seenUris.add(uri);
  }

  const seenScopes = new Set<string>();
  for (const scope of input.allowed_scopes) {
    if (!isOidcScope(scope)) {
      return refuse(
        "invalid_scope",
        "allowed_scopes names a scope that is not in the catalogue.",
        "allowed_scopes",
      );
    }
    if (seenScopes.has(scope)) {
      return refuse("invalid_scope", `allowed_scopes lists ${scope} twice.`, "allowed_scopes");
    }
    seenScopes.add(scope);
  }

  const seenGrants = new Set<string>();
  for (const grant of input.allowed_grants) {
    if (!OIDC_GRANTS.includes(grant)) {
      return refuse(
        "invalid_grant",
        `allowed_grants may hold only: ${OIDC_GRANTS.join(", ")}.`,
        "allowed_grants",
      );
    }
    if (seenGrants.has(grant)) {
      return refuse("invalid_grant", `allowed_grants lists ${grant} twice.`, "allowed_grants");
    }
    seenGrants.add(grant);
  }

  // A machine-only scope is granted only under the client credentials grant, so a client that
  // cannot use that grant can never hold it.
  for (const scope of seenScopes) {
    if (isMachineOnlyScope(scope) && !seenGrants.has("client_credentials")) {
      return refuse(
        "scope_grant_mismatch",
        `${scope} is a machine scope and needs the client_credentials grant.`,
        "allowed_scopes",
      );
    }
  }

  if (input.backchannel_logout_uri !== undefined && input.backchannel_logout_uri !== null) {
    const uri = input.backchannel_logout_uri;
    const problem =
      addressProblem(uri, false) ?? (uri.startsWith("https://") ? null : "is not an https address");
    if (problem) {
      return refuse(
        "invalid_logout_uri",
        `backchannel_logout_uri ${problem}.`,
        "backchannel_logout_uri",
      );
    }
  }

  const audience = checkAudience(input.audience, "audience");
  if (audience) return audience;
  const introspection = input.introspection_audiences ?? [];
  if (introspection.length > OIDC_MAX_INTROSPECTION_AUDIENCES) {
    return refuse(
      "invalid_body",
      `introspection_audiences may hold at most ${OIDC_MAX_INTROSPECTION_AUDIENCES}.`,
      "introspection_audiences",
    );
  }
  for (const value of introspection) {
    const problem = checkAudience(value, "introspection_audiences");
    if (problem) return problem;
  }

  if (input.first_party === true) return firstPartyRefusal(input.redirect_uris);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/**
 * The owner's view of a client. Never the hashes: the previous secret's expiry is read only while
 * its grace is still running (D1's clock), and NULL once it has ended.
 */
const VIEW_COLUMNS = `client_id, name, redirect_uris, allowed_scopes, allowed_grants, sign_in_rule,
  first_party, consent_mode, backchannel_logout_uri, audience, introspection_audiences,
  cap_open_reservations, cap_su_per_day, status, disabled_at,
  CASE WHEN previous_secret_hash IS NOT NULL AND previous_secret_expires_at > datetime('now')
       THEN previous_secret_expires_at END AS previous_secret_expires_at,
  created_by, created_at, updated_at`;

export const LIST_CLIENTS_SQL = `SELECT ${VIEW_COLUMNS} FROM oidc_clients ORDER BY id LIMIT 500`;
export const GET_CLIENT_SQL = `SELECT ${VIEW_COLUMNS} FROM oidc_clients WHERE client_id = ?`;
export const CLIENT_AUTH_SQL = `SELECT status, secret_hash, previous_secret_hash, previous_secret_expires_at
  FROM oidc_clients WHERE client_id = ?`;

interface StoredView
  extends Omit<
    ClientView,
    | "redirect_uris"
    | "allowed_scopes"
    | "allowed_grants"
    | "introspection_audiences"
    | "first_party"
  > {
  redirect_uris: string;
  allowed_scopes: string;
  allowed_grants: string;
  introspection_audiences: string;
  first_party: number;
}

function toView(row: StoredView): ClientView {
  return {
    ...row,
    redirect_uris: JSON.parse(row.redirect_uris) as string[],
    allowed_scopes: JSON.parse(row.allowed_scopes) as string[],
    allowed_grants: JSON.parse(row.allowed_grants) as string[],
    introspection_audiences: JSON.parse(row.introspection_audiences) as string[],
    first_party: row.first_party === 1,
  };
}

export async function listClients(db: D1Database): Promise<ClientView[]> {
  const { results } = await db.prepare(LIST_CLIENTS_SQL).all<StoredView>();
  return (results ?? []).map(toView);
}

export async function getClient(db: D1Database, clientId: string): Promise<ClientView | null> {
  const row = await db.prepare(GET_CLIENT_SQL).bind(clientId).first<StoredView>();
  return row ? toView(row) : null;
}

/** The status and hashes authentication reads. Never put this in a response. */
export async function getClientAuthRow(
  db: D1Database,
  clientId: string,
): Promise<ClientAuthRow | null> {
  return db.prepare(CLIENT_AUTH_SQL).bind(clientId).first<ClientAuthRow>();
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

export const INSERT_CLIENT_SQL = `INSERT INTO oidc_clients
  (client_id, name, secret_hash, redirect_uris, allowed_scopes, allowed_grants, sign_in_rule,
   first_party, consent_mode, backchannel_logout_uri, audience, introspection_audiences,
   cap_open_reservations, cap_su_per_day, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Register a client: validate, make its id and secret, write the row and its audit row in one
 * batch. The secret is returned here and kept nowhere. The audit row holds the shape of the
 * registration (flags, grants, scopes, counts) and none of its content: no name, no address, no
 * audience, no secret.
 */
export async function createClient(
  env: Pick<Bindings, "DB" | "ENVIRONMENT">,
  input: ClientInput,
  actorId: number,
): Promise<
  { ok: true; client: ClientView; secret: string } | { ok: false; refusal: ClientRefusal }
> {
  const refusal = validateClientInput(input, env);
  if (refusal) return { ok: false, refusal };

  const clientId = generateClientId();
  const secret = generateClientSecret();
  const firstParty = input.first_party === true;
  const consentMode = input.consent_mode ?? "ask_once";
  const db = env.DB;
  await db.batch([
    db
      .prepare(INSERT_CLIENT_SQL)
      .bind(
        clientId,
        input.name.trim(),
        await hashApiKey(secret),
        JSON.stringify(input.redirect_uris),
        JSON.stringify(input.allowed_scopes),
        JSON.stringify(input.allowed_grants),
        input.sign_in_rule,
        firstParty ? 1 : 0,
        consentMode,
        input.backchannel_logout_uri ?? null,
        input.audience,
        JSON.stringify(input.introspection_audiences ?? []),
        input.cap_open_reservations ?? null,
        input.cap_su_per_day ?? null,
        actorId,
      ),
    auditLogStatement(db, {
      userId: actorId,
      action: "oidc.client.create",
      resourceType: "oidc_client",
      resourceId: clientId,
      details: JSON.stringify({
        first_party: firstParty,
        sign_in_rule: input.sign_in_rule,
        consent_mode: consentMode,
        grants: input.allowed_grants,
        scopes: input.allowed_scopes,
        redirects: input.redirect_uris.length,
        logout: input.backchannel_logout_uri != null,
      }),
    }),
  ]);
  const client = await getClient(db, clientId);
  if (!client) throw new Error("the client was written and could not be read back");
  return { ok: true, client, secret };
}

/**
 * Replace the secret. The old one stays valid for `graceHours` (0 for none, at most a week) so a
 * client that has not yet been given the new one keeps working; a second rotation inside the grace
 * ends the first secret at once and keeps the one before it. A disabled client's secret cannot be
 * rotated: the update names `status = 'active'`, so there is no read-then-write for a disable to
 * slip between.
 */
export const ROTATE_SECRET_SQL = `UPDATE oidc_clients
  SET previous_secret_hash = CASE WHEN ? > 0 THEN secret_hash END,
      previous_secret_expires_at = CASE WHEN ? > 0 THEN datetime('now', ?) END,
      secret_hash = ?,
      updated_at = datetime('now')
  WHERE client_id = ? AND status = 'active'`;

export async function rotateClientSecret(
  env: Pick<Bindings, "DB">,
  clientId: string,
  graceHours: number | undefined,
  actorId: number,
): Promise<
  | { ok: true; client: ClientView; secret: string; graceHours: number }
  | { ok: false; code: "client_not_found" | "client_disabled" }
> {
  const grace = graceHours ?? OIDC_SECRET_GRACE_HOURS_DEFAULT;
  if (!Number.isInteger(grace) || grace < 0 || grace > OIDC_SECRET_GRACE_HOURS_MAX) {
    throw new RangeError("graceHours is out of range; the route validates it first");
  }
  const db = env.DB;
  const secret = generateClientSecret();
  const changed = await applyEditWithAudit(
    db,
    db
      .prepare(ROTATE_SECRET_SQL)
      .bind(grace, grace, `+${grace} hours`, await hashApiKey(secret), clientId),
    {
      userId: actorId,
      action: "oidc.client.rotate_secret",
      resourceType: "oidc_client",
      resourceId: clientId,
      details: JSON.stringify({ grace_hours: grace }),
    },
  );
  const client = await getClient(db, clientId);
  // The update names `status = 'active'`, so one statement decides; what it did not change is
  // told apart afterwards: no such client, or one that is disabled.
  if (!changed) return { ok: false, code: client ? "client_disabled" : "client_not_found" };
  if (!client) return { ok: false, code: "client_not_found" };
  return { ok: true, client, secret, graceHours: grace };
}

export const DISABLE_CLIENT_SQL = `UPDATE oidc_clients
  SET status = 'disabled', disabled_at = datetime('now'), updated_at = datetime('now')
  WHERE client_id = ? AND status = 'active'`;

/**
 * Cut a client off: the status and the time, nothing else. Revoking what the client holds is the
 * revocation phase's (#2019); here a disabled client simply authenticates with no secret.
 * Idempotent: disabling a disabled client changes nothing and writes no audit row.
 */
export async function disableClient(
  env: Pick<Bindings, "DB">,
  clientId: string,
  actorId: number,
): Promise<
  { ok: true; client: ClientView; changed: boolean } | { ok: false; code: "client_not_found" }
> {
  const db = env.DB;
  const changed = await applyEditWithAudit(db, db.prepare(DISABLE_CLIENT_SQL).bind(clientId), {
    userId: actorId,
    action: "oidc.client.disable",
    resourceType: "oidc_client",
    resourceId: clientId,
    details: null,
  });
  const client = await getClient(db, clientId);
  if (!client) return { ok: false, code: "client_not_found" };
  return { ok: true, client, changed };
}
