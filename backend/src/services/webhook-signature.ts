/**
 * GitHub App webhook signature verification.
 *
 * GitHub signs webhook payloads with HMAC-SHA256 and delivers the digest in
 * `X-Hub-Signature-256: sha256=<hex>`. We re-compute the HMAC over the raw
 * request body using the webhook secret configured on the App and compare
 * with a constant-time check — a timing-leak here would let an attacker
 * brute-force the secret byte-by-byte.
 *
 * Used by `POST /webhooks/github` (phase 1 of centralization epic #601,
 * sub-issue #602). Lives next to (not inside) services/github-auth.ts
 * because that file owns App-installation token minting; this file owns
 * the inbound-event direction.
 */

import { timingSafeEqual } from "../lib/constant-time";

/**
 * Verify a GitHub webhook signature.
 *
 * Returns true iff `header` is a well-formed `sha256=<hex>` string AND its
 * HMAC matches the one we compute over `rawBody` with `secret`. Anything
 * else (missing header, malformed prefix, wrong length, mismatched digest,
 * crypto failure) returns false — never throws so callers can collapse
 * every negative into a single 401 response without try/catch noise.
 *
 * `rawBody` MUST be the exact bytes GitHub signed. The caller is responsible
 * for reading the request body once and passing the same string in here that
 * gets parsed for the event payload — re-serializing a parsed JSON object
 * would silently change whitespace and break verification.
 */
export async function verifyGitHubWebhookSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!header || !secret) return false;
  if (!header.startsWith("sha256=")) return false;
  const providedHex = header.slice("sha256=".length);
  // Hex sha256 is exactly 64 characters. Reject other lengths up front so
  // the constant-time compare below operates on equal-length inputs.
  if (providedHex.length !== 64) return false;

  let expectedHex: string;
  try {
    expectedHex = await hmacSha256Hex(secret, rawBody);
  } catch {
    return false;
  }
  return timingSafeEqual(expectedHex, providedHex);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  // Lower-case hex matches GitHub's convention so the comparison can be
  // direct without normalizing on either side.
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}
