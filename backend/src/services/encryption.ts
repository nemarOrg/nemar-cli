/**
 * Encryption service for storing sensitive credentials
 *
 * Uses AES-GCM encryption via Web Crypto API (available in Cloudflare Workers).
 * Credentials are encrypted before storing in the database.
 *
 * Format: base64(salt[16] + iv[12] + ciphertext)
 */

/**
 * Encryption error with meaningful message
 */
export class EncryptionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EncryptionError";
  }
}

/**
 * Derive an encryption key from a secret string and salt
 */
async function deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a string value
 * Returns base64-encoded ciphertext with salt and IV prepended
 */
export async function encrypt(plaintext: string, encryptionKey: string): Promise<string> {
  // Validate inputs
  if (!plaintext || typeof plaintext !== "string") {
    throw new EncryptionError("encrypt: plaintext must be a non-empty string");
  }
  if (!encryptionKey || typeof encryptionKey !== "string") {
    throw new EncryptionError("encrypt: encryptionKey must be a non-empty string");
  }

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    // Generate random salt and IV
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const key = await deriveKey(encryptionKey, salt);

    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);

    // Combine salt + IV + ciphertext and encode as base64
    const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    combined.set(salt);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

    return btoa(String.fromCharCode(...combined));
  } catch (error) {
    throw new EncryptionError(
      `Encryption failed: ${error instanceof Error ? error.message : "unknown error"}`,
      error,
    );
  }
}

/**
 * Decrypt a string value
 * Expects base64-encoded ciphertext with salt and IV prepended
 */
export async function decrypt(encrypted: string, encryptionKey: string): Promise<string> {
  // Validate inputs
  if (!encrypted || typeof encrypted !== "string") {
    throw new EncryptionError("decrypt: encrypted must be a non-empty string");
  }
  if (!encryptionKey || typeof encryptionKey !== "string") {
    throw new EncryptionError("decrypt: encryptionKey must be a non-empty string");
  }

  let combined: Uint8Array;
  try {
    combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  } catch (error) {
    throw new EncryptionError(
      "decrypt: invalid base64 encoding in encrypted data",
      error,
    );
  }

  // Minimum length: 16 (salt) + 12 (iv) + 1 (ciphertext) = 29 bytes
  if (combined.length < 29) {
    throw new EncryptionError(
      "decrypt: encrypted data is too short - possibly corrupted",
    );
  }

  // Extract salt, IV, and ciphertext
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const ciphertext = combined.slice(28);

  try {
    const key = await deriveKey(encryptionKey, salt);

    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);

    return new TextDecoder().decode(plaintext);
  } catch (error) {
    throw new EncryptionError(
      "decrypt: decryption failed - data may be corrupted or encryption key may be incorrect",
      error,
    );
  }
}
