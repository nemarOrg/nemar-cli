/**
 * The OpenID Connect subject of an account (epic #2014 phase #2015; ADR 0119, decision 5).
 *
 * Pure and import-free, so the Worker, the CLI and the tests read one definition.
 *
 * A subject is `nmu_` plus 32 lowercase hexadecimal characters: 128 random bits, assigned when the
 * account row is created (migration 0120), never changed and never reused, and neither the row
 * number nor the email address nor anything a person chose. Its format is fixed before any client
 * trusts it, because a client stores it as the account's name.
 *
 * `nmu_` is a reserved username prefix (`validateUsernameFormat` in the backend), so no person,
 * service or pipeline name can collide with a subject.
 */

/** Every subject starts with this, and no username may. */
export const OIDC_SUBJECT_PREFIX = "nmu_";

/** The number of lowercase hexadecimal characters after the prefix (128 bits). */
export const OIDC_SUBJECT_HEX_LENGTH = 32;

const SUBJECT_RE = new RegExp(`^${OIDC_SUBJECT_PREFIX}[0-9a-f]{${OIDC_SUBJECT_HEX_LENGTH}}$`);

/**
 * True for a string of exactly the subject format. A type guard, so a value that passed is a
 * `string` for the caller; anything else (a number, null, a near miss) is false.
 */
export function isOidcSubject(value: unknown): value is string {
  return typeof value === "string" && SUBJECT_RE.test(value);
}
