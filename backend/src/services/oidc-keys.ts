/**
 * The OpenID Connect provider's signing keys (epic #2014 phase #2016; ADR 0119, decisions 2 and
 * 4): generating them, keeping the private half encrypted, publishing the public half as a JSON Web
 * Key Set, signing a token with ES256, and rotating.
 *
 * THE LIFE OF A KEY. Every key is made as `next`, published from that moment so a client has time to
 * fetch it, and becomes `current` (the one that signs) only when it is at least 24 hours old, unless
 * the owner forces it. The key that was `current` becomes `retired` and stays published for seven
 * days, so a token signed just before a rotation still verifies. The first rotation of an empty
 * table makes a `current` and a `next` together; there is no window in which nothing signs once
 * that has happened.
 *
 * THE PRIVATE KEY NEVER LEAVES. It is generated in memory, encrypted with `encrypt()` under
 * `OIDC_SECRET` before it is stored, decrypted only to sign, and returned by nothing: the published
 * set is built from an allow-list of public members, so a private member that reached the public
 * column by any route is still not emitted. A decrypted key is cached for the life of the isolate,
 * keyed by the key's id AND the secret it was decrypted under, so a warm cache is no way around a
 * wrong secret.
 *
 * ROTATION IS ONE BATCH, AND THE TABLE'S INDEXES ARE ITS LOCK. The state is read, a key is made, and
 * the changes go to D1 in one batch (a transaction): retire the current key named in the read,
 * promote the `next` key named in the read, insert the new `next`, and write the audit row. A second
 * rotation that read the same state finds its pinned statements matching nothing, and its insert of
 * a new `next` (or of a first `current`) breaks a partial unique index, so the whole batch is
 * refused, which is reported as `conflict` and leaves the table as the winner made it. The caller
 * reads the keys again. (The two pins are each redundant with the index and necessary together: with
 * the retire and the promote both unpinned, a stale rotation would promote the key the winner had
 * just made, at the age of zero.)
 *
 * Time is D1's (`datetime('now')`), never the Worker's clock, for the same reason as the re-pull
 * dispatch cap: one clock for the rule and the stamps it reads.
 */

import {
  OIDC_KEY_MIN_NEXT_AGE_HOURS,
  OIDC_KID_HEX_LENGTH,
  OIDC_RETIRED_KEY_PUBLISH_DAYS,
  OIDC_SIGNING_ALG,
} from "../../../shared/oidc.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { decrypt, encrypt } from "./encryption.js";
import { oidcEnabled } from "./oidc-config.js";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** `OIDC_SECRET` is unset or too short: nothing safe can be signed or stored. */
export class OidcNotConfiguredError extends Error {
  constructor() {
    super("OIDC_SECRET is not set, or is shorter than 32 characters");
    this.name = "OidcNotConfiguredError";
  }
}

/** There is no `current` key: the keys were never rotated into existence. */
export class NoSigningKeyError extends Error {
  constructor() {
    super("There is no current signing key; run the first key rotation");
    this.name = "NoSigningKeyError";
  }
}

function requireSecret(env: Pick<Bindings, "OIDC_SECRET">): string {
  if (!oidcEnabled(env)) throw new OidcNotConfiguredError();
  return env.OIDC_SECRET as string;
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const textBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------------------------

/** What generating a key yields: its id, its public half, and its private half already encrypted. */
interface GeneratedKey {
  kid: string;
  publicJwk: string;
  encryptedPrivate: string;
}

async function generateKey(secret: string): Promise<GeneratedKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const { x, y, d } = exported;
  if (!x || !y || !d) throw new Error("the key export did not hold x, y and d");
  const kid = randomHex(OIDC_KID_HEX_LENGTH / 2);
  const publicJwk = { kty: "EC", crv: "P-256", x, y, kid, use: "sig", alg: OIDC_SIGNING_ALG };
  const privateJwk = { kty: "EC", crv: "P-256", x, y, d };
  return {
    kid,
    publicJwk: JSON.stringify(publicJwk),
    encryptedPrivate: await encrypt(JSON.stringify(privateJwk), secret),
  };
}

// ---------------------------------------------------------------------------------------------
// The decrypted-key cache
// ---------------------------------------------------------------------------------------------

interface CachedKey {
  secret: string;
  key: CryptoKey;
}

/**
 * Decrypted signing keys, for the life of the isolate. One entry per key that ever signed in this
 * isolate: a rotation adds one, and rotations are the owner's rare act, so the map stays tiny.
 */
const decryptedKeys = new Map<string, CachedKey>();

async function privateKeyFor(secret: string, kid: string, ciphertext: string): Promise<CryptoKey> {
  const hit = decryptedKeys.get(kid);
  if (hit && hit.secret === secret) return hit.key;
  const jwk = JSON.parse(await decrypt(ciphertext, secret)) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  decryptedKeys.set(kid, { secret, key });
  return key;
}

/** Test seam: how many decrypted keys are held. */
export function __oidcDecryptedKeyCacheSize(): number {
  return decryptedKeys.size;
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

/** The current key's id and its ciphertext. Exported so a test reads the statement that runs. */
export const CURRENT_KEY_SQL =
  "SELECT kid, private_jwk_encrypted FROM oidc_signing_keys WHERE state = 'current'";

/**
 * A compact JSON Web Token signed with the current key, ES256. WebCrypto's ECDSA output is already
 * the JOSE `r || s` form (64 bytes for P-256), so nothing is converted. The header names the key id,
 * which is how a client picks the published key that verifies it.
 *
 * Throws {@link OidcNotConfiguredError} with no usable secret, {@link NoSigningKeyError} with no
 * current key, and an `EncryptionError` when the stored key cannot be decrypted under the secret.
 */
export async function signJwt(
  env: Pick<Bindings, "DB" | "OIDC_SECRET">,
  claims: Record<string, unknown>,
): Promise<string> {
  const secret = requireSecret(env);
  const row = await env.DB.prepare(CURRENT_KEY_SQL).first<{
    kid: string;
    private_jwk_encrypted: string;
  }>();
  if (!row) throw new NoSigningKeyError();
  const key = await privateKeyFor(secret, row.kid, row.private_jwk_encrypted);
  const header = { alg: OIDC_SIGNING_ALG, kid: row.kid, typ: "JWT" };
  const signingInput = `${toBase64Url(textBytes(JSON.stringify(header)))}.${toBase64Url(textBytes(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textBytes(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

// ---------------------------------------------------------------------------------------------
// The published key set
// ---------------------------------------------------------------------------------------------

/**
 * The keys a client may need: the current one, the next one, and any retired one still inside its
 * publication window. The window is D1's clock, bound as a modifier.
 */
export const JWKS_SQL = `SELECT kid, public_jwk FROM oidc_signing_keys
   WHERE state IN ('next', 'current')
      OR (state = 'retired' AND retired_at > datetime('now', ?))
   ORDER BY CASE state WHEN 'current' THEN 0 WHEN 'next' THEN 1 ELSE 2 END, retired_at DESC, kid`;

/** The members of a published key. Anything else on the row, a private member included, is dropped. */
const PUBLIC_MEMBERS = ["kty", "crv", "x", "y"] as const;

/** One published key from its stored public half: the allow-listed members, the row's own id. */
function publishedKey(kid: string, stored: string): Record<string, string> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stored) as Record<string, unknown>;
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const member of PUBLIC_MEMBERS) {
    const value = parsed[member];
    if (typeof value !== "string" || value === "") return null;
    out[member] = value;
  }
  // Every key here is an ES256 signing key, so the constants are the row's, not the JSON's.
  out.use = "sig";
  out.alg = OIDC_SIGNING_ALG;
  out.kid = kid;
  return out;
}

/** How long a built key set is kept for one database object. Rotation clears it at once. */
export const JWKS_MEMO_TTL_MS = 30_000;

/**
 * The key set is served without a rate limit (ADR 0119: a client that cannot fetch it cannot
 * validate a token), so the read it costs is kept for a short time per database object. A rotation
 * through this module clears the entry in the same isolate; another isolate may serve the previous
 * set for up to the window, which is harmless: a `next` key is published at least 24 hours before
 * it signs, and a retired key for seven days after.
 */
const jwksMemo = new WeakMap<object, { at: number; body: string }>();

/** The JSON text of the published key set. `now` is the clock the window is read by. */
export async function jwksDocument(db: D1Database, now: number = Date.now()): Promise<string> {
  const hit = jwksMemo.get(db);
  if (hit && now - hit.at >= 0 && now - hit.at < JWKS_MEMO_TTL_MS) return hit.body;
  const { results } = await db
    .prepare(JWKS_SQL)
    .bind(`-${OIDC_RETIRED_KEY_PUBLISH_DAYS} days`)
    .all<{ kid: string; public_jwk: string }>();
  const keys: Array<Record<string, string>> = [];
  for (const row of results ?? []) {
    const key = publishedKey(row.kid, row.public_jwk);
    if (key) keys.push(key);
    else
      console.error(`[oidc-keys] the public key of ${row.kid} is malformed and is not published`);
  }
  const body = JSON.stringify({ keys });
  jwksMemo.set(db, { at: now, body });
  return body;
}

/** Test seam: forget every cached decrypted key. The key-set cache is per database object. */
export function __resetOidcKeyCachesForTests(): void {
  decryptedKeys.clear();
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

/** One key as the owner sees it. No private member exists on this shape. */
export interface SigningKeyView {
  kid: string;
  alg: string;
  state: string;
  created_at: string;
  promoted_at: string | null;
  retired_at: string | null;
  /** For a `next` key, when it is old enough to sign without force; null for any other state. */
  promotable_at: string | null;
}

/** Every key, current first, then next, then retired newest first. Never the private half. */
export const LIST_KEYS_SQL = `SELECT kid, alg, state, created_at, promoted_at, retired_at,
       CASE WHEN state = 'next' THEN datetime(created_at, '+${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours') END AS promotable_at
  FROM oidc_signing_keys
 ORDER BY CASE state WHEN 'current' THEN 0 WHEN 'next' THEN 1 ELSE 2 END, created_at DESC, kid
 LIMIT 200`;

export async function listSigningKeys(db: D1Database): Promise<SigningKeyView[]> {
  const { results } = await db.prepare(LIST_KEYS_SQL).all<SigningKeyView>();
  return (results ?? []).map((r) => ({ ...r, promotable_at: r.promotable_at ?? null }));
}

// ---------------------------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------------------------

export type RotationResult =
  | { ok: true; action: "bootstrapped" | "rotated" | "next_created"; keys: SigningKeyView[] }
  | { ok: false; code: "too_early"; promotable_at: string }
  | { ok: false; code: "conflict" };

/** The two keys that matter for a rotation, and whether `next` is old enough. */
export const ROTATION_STATE_SQL = `SELECT kid, state, created_at,
       created_at <= datetime('now', '-${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours') AS aged,
       datetime(created_at, '+${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours') AS promotable_at
  FROM oidc_signing_keys WHERE state IN ('next', 'current')`;

export const INSERT_CURRENT_SQL = `INSERT INTO oidc_signing_keys
  (kid, alg, state, public_jwk, private_jwk_encrypted, promoted_at)
  VALUES (?, '${OIDC_SIGNING_ALG}', 'current', ?, ?, datetime('now'))`;

export const INSERT_NEXT_SQL = `INSERT INTO oidc_signing_keys
  (kid, alg, state, public_jwk, private_jwk_encrypted)
  VALUES (?, '${OIDC_SIGNING_ALG}', 'next', ?, ?)`;

export const RETIRE_CURRENT_SQL = `UPDATE oidc_signing_keys
  SET state = 'retired', retired_at = datetime('now') WHERE kid = ? AND state = 'current'`;

/**
 * Promote the `next` key the caller read, if it is still `next`. The age rule is applied once, to
 * the same read that names the key (`ROTATION_STATE_SQL`): a key that was 24 hours old when it was
 * read is still, so no second check is made here.
 */
export const PROMOTE_NEXT_SQL = `UPDATE oidc_signing_keys
  SET state = 'current', promoted_at = datetime('now')
  WHERE kid = ? AND state = 'next'`;

/** A unique-index refusal, as bun:sqlite words it and as D1 does. */
const CONSTRAINT_RE = /UNIQUE constraint failed|SQLITE_CONSTRAINT/i;

interface StateRow {
  kid: string;
  state: "next" | "current";
  aged: number;
  promotable_at: string;
}

/**
 * Rotate the keys once, as the owner asked.
 *
 *   - no `current` and no `next`: make both (`bootstrapped`);
 *   - a `next` key: if it is 24 hours old, or `force` is set, it becomes `current`, the old
 *     `current` becomes `retired`, and a new `next` is made (`rotated`); otherwise nothing changes
 *     and the answer says when it may (`too_early`);
 *   - a `current` key and no `next` (a state only a hand edit can reach): make a `next`
 *     (`next_created`), which changes nothing that signs.
 *
 * `conflict` means another rotation won between the read and the write.
 */
export async function rotateSigningKeys(
  env: Pick<Bindings, "DB" | "OIDC_SECRET">,
  options: { force?: boolean; actorId: number | null },
): Promise<RotationResult> {
  const secret = requireSecret(env);
  const db = env.DB;
  const force = options.force === true;

  const { results } = await db.prepare(ROTATION_STATE_SQL).all<StateRow>();
  const current = (results ?? []).find((r) => r.state === "current");
  const next = (results ?? []).find((r) => r.state === "next");

  if (next && !force && !next.aged) {
    return { ok: false, code: "too_early", promotable_at: next.promotable_at };
  }

  let action: "bootstrapped" | "rotated" | "next_created";
  const statements: D1PreparedStatement[] = [];
  let signingKid: string;
  if (!current && !next) {
    action = "bootstrapped";
    const first = await generateKey(secret);
    const second = await generateKey(secret);
    signingKid = first.kid;
    statements.push(
      db.prepare(INSERT_CURRENT_SQL).bind(first.kid, first.publicJwk, first.encryptedPrivate),
      db.prepare(INSERT_NEXT_SQL).bind(second.kid, second.publicJwk, second.encryptedPrivate),
    );
  } else if (next) {
    action = "rotated";
    const fresh = await generateKey(secret);
    signingKid = next.kid;
    if (current) statements.push(db.prepare(RETIRE_CURRENT_SQL).bind(current.kid));
    statements.push(
      db.prepare(PROMOTE_NEXT_SQL).bind(next.kid),
      db.prepare(INSERT_NEXT_SQL).bind(fresh.kid, fresh.publicJwk, fresh.encryptedPrivate),
    );
  } else {
    action = "next_created";
    const fresh = await generateKey(secret);
    signingKid = (current as StateRow).kid;
    statements.push(
      db.prepare(INSERT_NEXT_SQL).bind(fresh.kid, fresh.publicJwk, fresh.encryptedPrivate),
    );
  }

  // Shape only: what happened, whether it was forced, and the id of the key that signs afterwards
  // (public: it is in every token's header). No key material, no ciphertext.
  statements.push(
    auditLogStatement(db, {
      userId: options.actorId,
      action: "oidc.keys.rotate",
      resourceType: "oidc_signing_key",
      resourceId: signingKid,
      details: JSON.stringify({ action, forced: force }),
    }),
  );

  try {
    await db.batch(statements);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (CONSTRAINT_RE.test(message)) return { ok: false, code: "conflict" };
    throw err;
  }
  jwksMemo.delete(db);
  return { ok: true, action, keys: await listSigningKeys(db) };
}
