/**
 * ENCRYPTION_KEY provenance check (epic #885, Phase 1 gate).
 *
 * Question: is the ENCRYPTION_KEY in backend/.dev.vars the same value the PRODUCTION
 * Worker uses? Cloudflare will not reveal the prod secret, so we test it indirectly:
 * AES-GCM is authenticated, so decrypting a real prod ciphertext with the wrong key
 * fails on the auth tag rather than returning garbage.
 *
 * Mirrors backend/src/services/encryption.ts exactly:
 *   format: base64(salt[16] + iv[12] + ciphertext||tag)
 *   key:    PBKDF2-SHA256, 100000 iterations -> AES-256-GCM
 *
 * NEVER prints the key, the ciphertext, or the plaintext. Only a verdict and a
 * structural assertion on the decrypted value.
 */
const [, , cipherFile, keyFile] = process.argv;
const encrypted = (await Bun.file(cipherFile).text()).trim();
const encryptionKey = (await Bun.file(keyFile).text()).trim();

async function deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
console.log(`ciphertext blob: ${combined.length} bytes (salt16 + iv12 + ${combined.length - 28} ct)`);
if (combined.length < 29) {
  console.log("VERDICT: malformed blob, cannot test");
  process.exit(2);
}

const salt = combined.slice(0, 16);
const iv = combined.slice(16, 28);
const ciphertext = combined.slice(28);

try {
  const key = await deriveKey(encryptionKey, salt);
  const plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const plaintext = new TextDecoder().decode(plaintextBuf);
  // Structural assertion only. The value itself is never printed.
  const looksLikeAccessKeyId = /^AKIA[0-9A-Z]{16}$/.test(plaintext);
  console.log("VERDICT: MATCH - local .dev.vars ENCRYPTION_KEY decrypts production data");
  console.log(`  auth tag: valid`);
  console.log(`  plaintext length: ${plaintext.length}`);
  console.log(`  matches AWS access-key-id shape: ${looksLikeAccessKeyId}`);
} catch {
  console.log("VERDICT: MISMATCH - local ENCRYPTION_KEY cannot decrypt production data");
  console.log("  AES-GCM auth tag failed. The production key is NOT the local candidate.");
  process.exit(1);
}
