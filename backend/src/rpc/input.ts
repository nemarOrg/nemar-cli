/**
 * Shape checks for what a service-binding caller sends. The binding is typed
 * on the caller's side only, so at runtime an argument can be anything.
 */

/** Longer than any credential this API issues (a session value is 43
 *  characters, an API key a few more), so anything past it is refused before
 *  it is hashed. */
export const MAX_CREDENTIAL_LENGTH = 512;

/** `value` if it is a non-empty string of at most `max` characters, else null. */
export function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}
