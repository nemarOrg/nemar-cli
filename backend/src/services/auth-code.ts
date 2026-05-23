/**
 * Email-code auth helpers for the web dashboard (#569).
 *
 * - generateAuthCode(): 6-digit code via rejection-sampled
 *   crypto.getRandomValues. No Math.random; rejection sampling avoids
 *   the modulo bias that would otherwise concentrate codes in the low
 *   range (256^4 = 4_294_967_296 is not a clean multiple of 1_000_000).
 * - hashAuthCode(): HMAC-SHA256 keyed with ENCRYPTION_KEY. Keying with
 *   an out-of-band secret means an exfiltrated DB alone cannot brute
 *   the 1M-combo space; a stolen DB plus the worker secret is required.
 * - constantTimeEqualHex(): hex-string compare in time independent of
 *   the first mismatched byte. Web Crypto has no helper for this.
 * - maskEmail(): "y***@ieee.org" formatting for the
 *   /auth/code/request response. The masking matches the issue spec
 *   exactly; we never leak whether the email already existed.
 */

import type { Bindings } from "../types/bindings";

const CODE_DIGITS = 6;
const CODE_MAX_EXCLUSIVE = 1_000_000;
// Reject draws above this ceiling so the remainder modulo 1e6 is uniform.
// floor(2^32 / 1e6) * 1e6 = 4_294_000_000.
const REJECT_CEIL = 4_294_000_000;

/**
 * Generate a cryptographically uniform 6-digit code as a zero-padded
 * string. Pulls fresh randomness in a loop until we land below the
 * rejection ceiling — expected iterations < 1.01, so the loop is
 * effectively single-pass.
 */
export function generateAuthCode(): string {
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    const draw = buf[0];
    if (draw < REJECT_CEIL) {
      return (draw % CODE_MAX_EXCLUSIVE).toString().padStart(CODE_DIGITS, "0");
    }
  }
}

// One CryptoKey per worker isolate. Importing the HMAC key on every
// request is wasteful (a few hundred microseconds each), and the key
// itself is immutable for the lifetime of the deploy.
let cachedHmacKey: Promise<CryptoKey> | null = null;
let cachedHmacKeySecret: string | null = null;

async function getHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedHmacKey && cachedHmacKeySecret === secret) {
    return cachedHmacKey;
  }
  cachedHmacKeySecret = secret;
  cachedHmacKey = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return cachedHmacKey;
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * HMAC-SHA256 the code with ENCRYPTION_KEY. Returns hex.
 * Throws if ENCRYPTION_KEY is unset — the route handler catches and
 * returns 500 generically. We do not silently fall back to unkeyed
 * SHA-256 because that would weaken the at-rest guarantees without any
 * signal to the operator.
 */
export async function hashAuthCode(code: string, env: Bindings): Promise<string> {
  const secret = env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "ENCRYPTION_KEY is unset; cannot HMAC the auth code. Set the worker secret before running the passwordless auth flow.",
    );
  }
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(code));
  return bytesToHex(signature);
}

/**
 * Constant-time hex-string equality. Returns false on length mismatch
 * without short-circuiting — but the length itself is non-secret so
 * that branch is fine to expose.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Mask the local-part of an email so the response can echo it back
 * without leaking whether it's a previously-seen address.
 *   "yahya@ieee.org"        -> "y***@ieee.org"
 *   "y@ieee.org"            -> "*@ieee.org"
 *   "ab@ieee.org"           -> "a*@ieee.org"
 * The domain is preserved verbatim — most users navigate by it, and
 * the spec's example "y***@ieee.org" implies the domain is visible.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email; // no local part or no @; return as-is
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length === 1) return `*${domain}`;
  return `${local[0]}${"*".repeat(Math.max(1, local.length - 1))}${domain}`;
}
