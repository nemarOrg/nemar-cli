/**
 * Token generation service
 *
 * Generates secure API keys and verification tokens using Web Crypto API.
 */

/**
 * Generate a secure API key with prefix
 * Format: nm_<base64url-encoded-random-bytes>
 */
export function generateApiKey(): {
  apiKey: string;
  apiKeyPrefix: string;
} {
  // Generate 32 random bytes (256 bits)
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);

  // Convert to base64url (URL-safe base64)
  const base64 = btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const apiKey = `nm_${base64}`;

  // Prefix for display (first 11 chars: "nm_" + 8 chars)
  const apiKeyPrefix = `${apiKey.substring(0, 11)}...`;

  return { apiKey, apiKeyPrefix };
}

/**
 * Hash an API key for storage using SHA-256
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a verification token for email verification
 */
export function generateVerificationToken(): string {
  const randomBytes = new Uint8Array(24);
  crypto.getRandomValues(randomBytes);
  return btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Generate expiration timestamp (default: 24 hours from now)
 */
export function generateExpirationTimestamp(hoursFromNow: number = 24): string {
  const expiresAt = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  return expiresAt.toISOString();
}
