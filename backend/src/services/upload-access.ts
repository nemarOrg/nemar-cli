/**
 * Preconditions for the one-time upload-access request (ADR 0042, #1253).
 *
 * ADR 0040 made admin approval the single writer of `service_access` and left
 * the asking half unbuilt; this is the asking half's rulebook. An admin
 * approving an upload request is performing an export-control review of a
 * person, so the request has to arrive with the person on it: a real name, a
 * username to approve them by, a GitHub account that exists, a location, and a
 * sentence about what they intend to deposit. A request missing any of that is
 * refused HERE rather than mailed to an admin who then has to chase it.
 *
 * Every refusal is `{ error, message, missing }` with a code from a closed
 * vocabulary, because both clients render it: the website turns `missing` into
 * highlighted Settings fields (nemarOrg/website#301) and the CLI prints the
 * same list with where to fix each one. A prose-only 400 would leave both
 * guessing which field was wrong.
 *
 * Pure, so the ordering and the field list are testable without a Worker; the
 * one precondition that is NOT here is GitHub existence, which needs a network
 * call and is checked last by the route (see requestUploadAccess in
 * routes/users.ts).
 */

/** Bounds on the why text, matching CLI signup's `description` (routes/auth.ts)
 *  -- the same column, and the same question, so the same limits. */
export const WHY_MIN_CHARS = 20;
export const WHY_MAX_CHARS = 500;

/**
 * The closed refusal vocabulary. `error` is the machine-readable half and is
 * part of the wire contract with the website; `message` may be reworded freely.
 *
 * `github_username_unverified` is raised by the route, not by the pure check
 * below: it means the handle IS set on the account but GitHub does not resolve
 * it. Kept in the same union so a client switches on one list.
 */
export type UploadAccessErrorCode =
  | "why_required"
  | "email_not_verified"
  | "profile_incomplete"
  | "github_username_unverified"
  | "already_approved";

export interface UploadAccessRefusal {
  error: UploadAccessErrorCode;
  message: string;
  /** The account fields that must be filled in, named exactly as the API
   *  spells them, so a client can map each one to its own form control. Always
   *  present (possibly empty) so the client has one shape to read. */
  missing: string[];
}

/** The account columns the request reads. Deliberately not the whole user row:
 *  these five plus the email flag are the review card's identity half. */
export interface UploadAccessProfile {
  email_verified: number;
  username: string | null;
  given_name: string | null;
  family_name: string | null;
  github_username: string | null;
  city: string | null;
  country: string | null;
}

/** Whitespace counts as absent, matching `resolveUploaderIdentity`'s trim
 *  (services/uploader-identity.ts): a row holding " " has no city. */
function blank(value: string | null | undefined): boolean {
  return (value ?? "").trim().length === 0;
}

/**
 * Check everything that can be decided from the account row plus the submitted
 * text. Returns the refusal to send, or null when the request may proceed to
 * the GitHub existence check.
 *
 * ORDER IS DELIBERATE and is documented here because it is the only thing a
 * caller with several problems at once actually experiences:
 *
 *  1. `why_required` -- the payload the caller JUST typed. Answering it first
 *     means nobody is sent to fix their profile because of a typo in the field
 *     in front of them.
 *  2. `email_not_verified` -- the account's own step, with its own endpoint
 *     (POST /auth/email/verify/request), and nothing else can be acted on
 *     until the inbox works: every message about this request goes there.
 *  3. `profile_incomplete` -- all remaining fields AT ONCE, so a user filling
 *     in a Settings form is not walked through five round trips.
 *
 * GitHub existence is checked by the route after this returns null, because it
 * costs a GitHub API call and there is no point spending one on a request that
 * is already refused.
 */
export function checkUploadAccessRequest(
  profile: UploadAccessProfile,
  why: string,
): UploadAccessRefusal | null {
  const text = why.trim();
  if (text.length < WHY_MIN_CHARS || text.length > WHY_MAX_CHARS) {
    return {
      error: "why_required",
      message: `Describe what you intend to upload in ${WHY_MIN_CHARS}-${WHY_MAX_CHARS} characters`,
      missing: ["why"],
    };
  }

  if (profile.email_verified !== 1) {
    return {
      error: "email_not_verified",
      message:
        "Verify your email address before requesting upload access; the review happens over email",
      missing: ["email_verified"],
    };
  }

  const missing: string[] = [];
  if (blank(profile.username)) missing.push("username");
  if (blank(profile.given_name)) missing.push("given_name");
  if (blank(profile.family_name)) missing.push("family_name");
  if (blank(profile.github_username)) missing.push("github_username");
  if (blank(profile.city)) missing.push("city");
  if (blank(profile.country)) missing.push("country");

  if (missing.length > 0) {
    return {
      error: "profile_incomplete",
      message: `Complete your profile before requesting upload access: ${missing.join(", ")}`,
      missing,
    };
  }

  return null;
}

/** The refusal for a handle that is set on the account but does not resolve on
 *  GitHub. Built here so the route and its test share one spelling. */
export function githubUnverifiedRefusal(handle: string): UploadAccessRefusal {
  return {
    error: "github_username_unverified",
    message: `The GitHub username '${handle}' does not exist; upload access needs a GitHub account we can add to your dataset repository`,
    missing: ["github_username"],
  };
}

/** The 409 for an account that already holds the grant. `missing` is empty
 *  rather than absent so every refusal on this endpoint has one shape. */
export const ALREADY_APPROVED_REFUSAL: UploadAccessRefusal = {
  error: "already_approved",
  message: "This account already has upload access; there is nothing to request",
  missing: [],
};
