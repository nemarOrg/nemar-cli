/**
 * Device authorization grant wire vocabulary (RFC 8628; epic #1272 phase 1,
 * #1281; ADR 0047).
 *
 * `nemar auth login` cannot receive an OAuth redirect on a headless host, so
 * CLI sign-in follows the same shape `gh auth login` does: the CLI mints a
 * device code (`POST /auth/device/start`), a person authorizes it in the
 * browser they are already signed into (`GET /auth/device/lookup`,
 * `POST /auth/device/{confirm,deny}`, phase 2's website page), and the CLI
 * collects an API key by polling `POST /auth/device/token`. The key is
 * minted only when the CLI collects it -- confirm never sees a plaintext key
 * -- and every key is named for the machine it was issued to.
 *
 * Two closed vocabularies live here because they answer different questions:
 * `deviceGrantErrorSchema` is what the POLLING endpoint answers on HTTP 400
 * (the RFC 8628 section 3.5 error codes, read by the CLI's poll loop), and
 * `deviceAuthRefusalCodeSchema` is why a device code could not be used at
 * all (read by lookup/confirm/deny, and carried as `reason` inside a token
 * error body). They disagree on purpose: `authorization_pending` and
 * `slow_down` are not refusals, they are "keep polling"; a genuine refusal
 * rides `reason` alongside the RFC code that best fits its HTTP semantics.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract), matching
 * shared/contract/identity.ts.
 */

import { z } from "zod";

/** How long a device code stays authorizable (ADR 0047; migration 0081). */
export const DEVICE_CODE_TTL_SECONDS = 600;
/** How often the CLI is told to poll `POST /auth/device/token`. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** Grace window `confirm` extends a near-expiry code by, so a person who
 *  authorizes in the closing seconds of the window is not told "expired" by
 *  the very next poll (ADR 0047: confirm grants a collection grace). */
export const DEVICE_CONFIRM_GRACE_SECONDS = 120;
/** No vowels, no `0`/`O`/`1`/`I`: a person reads this off a screen and types
 *  it, or it is pre-filled into `verification_uri_complete`. 20 letters + 8
 *  digits = 28 symbols, chosen so rejection sampling against a byte can use
 *  a clean `< 252` ceiling (`services/device-auth.ts`). */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const USER_CODE_LENGTH = 8;
export const MACHINE_NAME_MAX_CHARS = 64;
export const DEFAULT_MACHINE_NAME = "unnamed machine";
/** Live (non-revoked, non-expired) API keys one account may hold at once.
 *  Shared by the device mint gate and the named-key routes -- one cap,
 *  wherever a key is created. */
export const MAX_LIVE_API_KEYS = 25;

/**
 * Render an 8-character user code as `XXXX-XXXX` for display. Input must
 * already be `normalizeUserCode`'s output (exactly 8 alphabet characters);
 * this does not validate.
 */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, USER_CODE_LENGTH)}`;
}

/**
 * Canonical form of a user code a person typed or pasted, or `null` when the
 * input cannot be one.
 *
 * Uppercases, strips everything outside `[A-Z0-9]` (so a pasted `bcdf-ghjk`
 * or `BCDF GHJK` both normalize), then requires exactly
 * {@link USER_CODE_LENGTH} characters, every one of them in
 * {@link USER_CODE_ALPHABET}. A stripped string that is the right length but
 * contains a character `generateUserCode` never produces (a vowel, `0`, `O`,
 * `1`, `I`) is rejected rather than silently accepted -- it cannot be a code
 * this service issued.
 */
export function normalizeUserCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (stripped.length !== USER_CODE_LENGTH) return null;
  for (const ch of stripped) {
    if (!USER_CODE_ALPHABET.includes(ch)) return null;
  }
  return stripped;
}

/**
 * RFC 8628 section 3.5 error codes, answered by `POST /auth/device/token` on
 * HTTP 400. `authorization_pending` and `slow_down` are the CLI's normal
 * "keep polling" states, not failures; the other three are terminal.
 */
export const deviceGrantErrorSchema = z.enum([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
  "invalid_grant",
]);
export type DeviceGrantError = z.infer<typeof deviceGrantErrorSchema>;

/** One sentence per RFC grant error, for a CLI poll loop with no `reason` to
 *  fall back on (the two pending states never carry one). */
export const DEVICE_GRANT_MESSAGES: Record<DeviceGrantError, string> = {
  authorization_pending: "Waiting for you to authorize this machine in the browser.",
  slow_down: "Polling too quickly; the CLI will slow down automatically.",
  expired_token: "The code expired. Run `nemar auth login` again for a new one.",
  access_denied:
    "This sign-in was declined in the browser. Run `nemar auth login` again if that was a mistake.",
  invalid_grant: "That code is no longer valid. Run `nemar auth login` again for a new one.",
};

/**
 * Why a device code (or a key request riding one) could not be used, or why
 * an owner's own key mint was refused (epic #1272 phase 4, #1284; ADR 0048).
 *
 * `service_account` covers BOTH non-person kinds (`service` and `test`): from
 * the sign-in side, "a service account" and "a test persona" are the same
 * fact -- a human is not meant to sign in this way -- and the CLI/website
 * both already parse this as a closed enum, so widening what it means costs
 * nothing a second `test_account` code would not also cost. `person_account`
 * is the mint-side companion, answered only by
 * `POST /admin/users/:username/keys` (routes/admin/user-keys.ts) when an
 * owner targets a `person`: a person creates their own keys by signing in,
 * never through the admin mint.
 */
export const deviceAuthRefusalCodeSchema = z.enum([
  "device_code_unknown",
  "device_code_expired",
  "device_code_used",
  "device_code_denied",
  "account_pending",
  "account_revoked",
  "identity_conflict",
  "service_account",
  "person_account",
  "too_many_keys",
  "key_not_found",
]);
export type DeviceAuthRefusalCode = z.infer<typeof deviceAuthRefusalCodeSchema>;

/** The refusal codes as a plain array, for a runtime membership test, mirroring
 *  {@link IDENTITY_CONFLICT_CODES} in identity.ts. */
export const DEVICE_AUTH_REFUSAL_CODES: readonly string[] = deviceAuthRefusalCodeSchema.options;

/** One sentence plus one next step per refusal code -- what `lookup`,
 *  `confirm`, `deny` and the token endpoint's `reason` field all read from. */
export const DEVICE_AUTH_MESSAGES: Record<DeviceAuthRefusalCode, string> = {
  device_code_unknown:
    "That code was not found. Check the code shown in your terminal, or run `nemar auth login` again for a new one.",
  device_code_expired: "The code expired. Run `nemar auth login` again for a new one.",
  device_code_used: "That code has already been used. Run `nemar auth login` again for a new one.",
  device_code_denied:
    "This sign-in was declined in the browser. Run `nemar auth login` again if that was a mistake.",
  account_pending:
    "Verify your email address first. Check your inbox for the NEMAR verification code, then authorize again.",
  account_revoked:
    "Your NEMAR account access has been revoked. Contact the NEMAR team if you think this is a mistake.",
  identity_conflict:
    "This account shares an identifier with another NEMAR account and cannot sign in until that is resolved. Fix it in Settings on nemar.org or contact the NEMAR team.",
  service_account:
    "This is a service or test account, and it cannot sign in this way. Ask an owner to create a key for it with `nemar admin keys create`.",
  person_account:
    "This account belongs to a person. A person creates their own keys with `nemar auth login` or in Settings on nemar.org.",
  too_many_keys: `This account already has ${MAX_LIVE_API_KEYS} active keys. Revoke one in Settings on nemar.org or with \`nemar auth keys\`, then try again.`,
  key_not_found:
    "That key was not found on this account, or it is already revoked. Run `nemar auth keys` to see the active ones.",
};

/** Every top-level refusal this file's routes answer with: `{ error, message }`,
 *  where `error` carries the refusal CODE (matching the browser-facing
 *  convention `identity.ts` documents). `deviceRefusal()` in
 *  `services/device-auth.ts` builds exactly this shape; phase 2 (the
 *  website confirm page) and phase 3 (the CLI) both import the schema
 *  rather than re-typing `{ error, message }` on their own end of the wire. */
export const deviceRefusalResponseSchema = z
  .object({
    error: deviceAuthRefusalCodeSchema,
    message: z.string(),
  })
  .passthrough();
export type DeviceRefusalResponse = z.infer<typeof deviceRefusalResponseSchema>;

// ---------------------------------------------------------------------------
// Response schemas (.passthrough(), matching userSchema/webUserSchema)
// ---------------------------------------------------------------------------

/** `POST /auth/device/start` on success. */
export const deviceStartResponseSchema = z
  .object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    expires_in: z.number().int(),
    interval: z.number().int(),
  })
  .passthrough();
export type DeviceStartResponse = z.infer<typeof deviceStartResponseSchema>;

/**
 * `POST /auth/device/token` on HTTP 400. A discriminated union on `error`,
 * so the TYPE itself forces exactly what the two poll outcomes carry:
 * `authorization_pending`/`slow_down` are "keep polling", never `reason`
 * (there is nothing to explain -- the code is still live); the three
 * terminal codes always carry `reason`, the refusal vocabulary's more
 * specific code (ADR 0047: `reason` names the refusal, `error` carries the
 * RFC 8628 code the CLI's retry loop switches on -- they disagree on
 * purpose, which is why `reason` is not spelled `code` like everywhere else
 * on this wire). `routes/auth-device.ts` reaches every branch through one of
 * two helpers, `pendingTokenError`/`terminalTokenError`, so a call site
 * cannot pass a `reason` where the type says there is none, or omit one
 * where the type requires it.
 */
const devicePendingTokenErrorSchema = z.discriminatedUnion("error", [
  z.object({ error: z.literal("authorization_pending"), message: z.string() }).passthrough(),
  z.object({ error: z.literal("slow_down"), message: z.string() }).passthrough(),
]);
const deviceTerminalTokenErrorSchema = z.discriminatedUnion("error", [
  z
    .object({
      error: z.literal("expired_token"),
      reason: deviceAuthRefusalCodeSchema,
      message: z.string(),
    })
    .passthrough(),
  z
    .object({
      error: z.literal("access_denied"),
      reason: deviceAuthRefusalCodeSchema,
      message: z.string(),
    })
    .passthrough(),
  z
    .object({
      error: z.literal("invalid_grant"),
      reason: deviceAuthRefusalCodeSchema,
      message: z.string(),
    })
    .passthrough(),
]);
export const deviceTokenErrorSchema = z.union([
  devicePendingTokenErrorSchema,
  deviceTerminalTokenErrorSchema,
]);
export type DeviceTokenError = z.infer<typeof deviceTokenErrorSchema>;

/** One API key as listed or minted. `current` is true only for the key the
 *  presenting bearer credential itself is (never true on the cookie path). */
export const apiKeySummarySchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable(),
    prefix: z.string(),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    current: z.boolean(),
  })
  .passthrough();
export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;

/** `POST /auth/device/token` on success. `user.username` is nullable: a
 *  brand-new ORCID account has no username until
 *  `refreshNameThenAssignUsername` runs after finalize (ADR 0047: `username` is
 *  nullable because assignment runs after finalize). */
export const deviceTokenSuccessSchema = z
  .object({
    api_key: z.string(),
    key: apiKeySummarySchema,
    user: z
      .object({
        username: z.string().nullable(),
        email: z.string(),
        github_username: z.string().nullable(),
        role: z.string(),
        sandbox_completed: z.boolean(),
        sandbox_dataset_id: z.string().nullable(),
      })
      .passthrough(),
  })
  .passthrough();
export type DeviceTokenSuccess = z.infer<typeof deviceTokenSuccessSchema>;

/** `GET /auth/device/lookup`. `refusal` is null for a code the signed-in
 *  account may still confirm or deny. */
export const deviceLookupResponseSchema = z
  .object({
    user_code: z.string(),
    machine_name: z.string(),
    requested_at: z.string(),
    expires_in: z.number().int(),
    account: z
      .object({
        username: z.string().nullable(),
        email_masked: z.string(),
      })
      .passthrough(),
    refusal: z
      .object({
        code: deviceAuthRefusalCodeSchema,
        message: z.string(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
export type DeviceLookupResponse = z.infer<typeof deviceLookupResponseSchema>;

/** `POST /auth/device/confirm` on success. Never carries the key -- the key
 *  is minted only when the CLI collects it, never at confirm (ADR 0047). */
export const deviceConfirmResponseSchema = z
  .object({
    ok: z.literal(true),
    machine_name: z.string(),
  })
  .passthrough();
export type DeviceConfirmResponse = z.infer<typeof deviceConfirmResponseSchema>;

/** `GET /auth/keys`. */
export const apiKeyListResponseSchema = z
  .object({
    keys: z.array(apiKeySummarySchema),
  })
  .passthrough();
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

/** `POST /auth/keys` on success. */
export const apiKeyCreateResponseSchema = z
  .object({
    api_key: z.string(),
    key: apiKeySummarySchema,
  })
  .passthrough();
export type ApiKeyCreateResponse = z.infer<typeof apiKeyCreateResponseSchema>;
