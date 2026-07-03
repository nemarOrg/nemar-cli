/**
 * HMAC callback tokens for GitHub-Actions -> Worker callbacks: per-job
 * manifest tokens and per-request prescreen tokens. Pure WebCrypto; no
 * GitHub API calls. (GitHub App/PAT auth lives in services/github-auth.ts,
 * not here.)
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

// ============================================================================
// Manifest callback HMAC tokens
// ============================================================================
//
// The Worker signs a one-shot HMAC-SHA256 token over {dataset_id, version,
// nonce} with `MANIFEST_CALLBACK_SECRET` and includes it in the dispatch
// `client_payload.callback_token`. The central workflow echoes it back in
// the `X-Webhook-Token` header on `/webhooks/manifest-ready`. The Worker
// re-derives the expected signature and rejects any mismatch with
// constant-time compare.
//
// Single-use is enforced by the `manifest_jobs` row (UNIQUE on
// (dataset_id, version, nonce) + status flip), not by the HMAC itself.
// The HMAC just proves the central workflow saw the dispatch payload.

export interface ManifestCallbackPayload {
  datasetId: string;
  version: string;
  nonce: string;
}

/** Canonical payload encoding -- pinned so signer and verifier agree. */
function encodeManifestCallbackPayload(payload: ManifestCallbackPayload): string {
  return `${payload.datasetId}\n${payload.version}\n${payload.nonce}`;
}

function toHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Sign a manifest callback payload with HMAC-SHA256.
 * Returns a hex-encoded digest. Uses Workers' built-in `crypto.subtle`.
 */
export async function signManifestCallbackToken(
  payload: ManifestCallbackPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error("signManifestCallbackToken: secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodeManifestCallbackPayload(payload)),
  );
  return toHex(signature);
}

/**
 * Constant-time byte-array compare. Cloudflare Workers exposes
 * `crypto.subtle.timingSafeEqual`; standard runtimes (Bun/Node test
 * harness) don't, so we fall back to a manual XOR-accumulate that runs
 * in time proportional to the (equal) length but doesn't short-circuit
 * on a mismatched byte. Both branches reject length mismatches up
 * front to keep the invariant simple.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = (crypto as { subtle: { timingSafeEqual?: typeof crypto.subtle.timingSafeEqual } })
    .subtle;
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Verify a manifest callback token against a claimed payload.
 * Constant-time compare via `crypto.subtle.timingSafeEqual` (Workers)
 * or a portable XOR-accumulate (other runtimes) to defeat timing
 * oracles. Returns true iff the digest matches.
 */
export async function verifyManifestCallbackToken(
  token: string,
  payload: ManifestCallbackPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  // Crypto failures here mean MANIFEST_CALLBACK_SECRET is malformed; surface
  // as 500 (via Hono's default error handler) not 401, so operators can
  // distinguish "broken secret on worker" from "wrong token from caller".
  const expected = await signManifestCallbackToken(payload, secret);
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(token), encoder.encode(expected));
}

// ============================================================================
// Pre-screen callback HMAC tokens (issue #666)
// ============================================================================
//
// Same one-shot HMAC handshake as the manifest callback above, signed over
// {dataset_id, request_id, nonce}. The Worker stores the nonce on the
// publication_requests row at dispatch time and puts the token in the
// dispatch client_payload; the workflow echoes it back in X-Webhook-Token.
// Single-use is enforced by the row's prescreen_status='pending' -> done
// flip, not the HMAC itself.

export interface PrescreenCallbackPayload {
  datasetId: string;
  requestId: number;
  nonce: string;
}

/** Canonical payload encoding -- pinned so signer and verifier agree. */
function encodePrescreenCallbackPayload(payload: PrescreenCallbackPayload): string {
  return `${payload.datasetId}\n${payload.requestId}\n${payload.nonce}`;
}

/** Sign a pre-screen callback payload with HMAC-SHA256 (hex digest). */
export async function signPrescreenCallbackToken(
  payload: PrescreenCallbackPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error("signPrescreenCallbackToken: secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodePrescreenCallbackPayload(payload)),
  );
  return toHex(signature);
}

/** Verify a pre-screen callback token (constant-time). */
export async function verifyPrescreenCallbackToken(
  token: string,
  payload: PrescreenCallbackPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const expected = await signPrescreenCallbackToken(payload, secret);
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(token), encoder.encode(expected));
}
