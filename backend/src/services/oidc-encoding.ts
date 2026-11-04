/**
 * The two encoders the OpenID Connect services share (epic #2014 phase #2016): the key service
 * (`oidc-keys.ts`) and the client registry (`oidc-clients.ts`) both make random identifiers and
 * encode bytes for the web, and they do it the same way, in one place.
 */

/** `byteLength` random bytes as `2 * byteLength` lowercase hexadecimal characters. */
export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bytes as base64url, which is the URL-safe alphabet with no padding (RFC 4648, section 5). */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
