/**
 * Preconditions for the one-time upload-access request (ADR 0042, #1253).
 *
 * ADR 0040 made admin approval the single writer of `service_access` and left
 * the asking half unbuilt; this is the asking half's rulebook. An admin
 * approving an upload request is performing an export-control review of a
 * person, so the request has to arrive with the person on it: a real name, a
 * username to approve them by, a verified ORCID iD (#1271; `admin`/`owner`
 * excepted), a GitHub account that exists, a location, and a sentence about
 * what they intend to deposit. A request missing any of that is refused HERE
 * rather than mailed to an admin who then has to chase it.
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

import type { z } from "zod";
import { profileGapFields } from "../../../shared/contract/profile-gaps.js";
import {
  UPLOAD_ACCESS_WHY_MAX_CHARS,
  UPLOAD_ACCESS_WHY_MIN_CHARS,
  type uploadAccessErrorCodeSchema,
} from "../../../shared/contract/user.js";
import { gapRole } from "./profile-gaps";

/** Bounds on the why text. Re-exported from the wire contract so the rule, the
 *  CLI prompt and the website form cannot drift; they match CLI signup's
 *  `description` -- the same column, and the same question. */
export const WHY_MIN_CHARS = UPLOAD_ACCESS_WHY_MIN_CHARS;
export const WHY_MAX_CHARS = UPLOAD_ACCESS_WHY_MAX_CHARS;

/**
 * The closed refusal vocabulary, re-exported from the wire contract so the
 * route, the website and the CLI all read one list (shared/contract/user.ts).
 * `error` is the machine-readable half; `message` may be reworded freely.
 *
 * Two of the five are raised by the route rather than by the pure check below:
 * `github_username_unverified` (the handle is set but GitHub does not resolve
 * it) and `github_unavailable` (GitHub could not be reached at all -- #1052).
 * They are in the same union so a client switches on one list.
 */
export type UploadAccessErrorCode = z.infer<typeof uploadAccessErrorCodeSchema>;

export interface UploadAccessRefusal {
  error: UploadAccessErrorCode;
  message: string;
  /** The account fields that must be filled in, named exactly as the API
   *  spells them, so a client can map each one to its own form control. Always
   *  present (possibly empty) so the client has one shape to read. */
  missing: string[];
}

/**
 * The account columns the request reads. Deliberately not the whole user row:
 * these five plus the two flags are the review card's identity half.
 *
 * Every field is REQUIRED, including the two added for the `orcid_verified` row
 * (#1271). A SELECT that forgets one is then a compile error rather than a
 * silently narrower refusal -- which is the failure mode a gap computed from a
 * partial row has: it reports the fields it was handed and says nothing about
 * the one it was not.
 */
export interface UploadAccessProfile {
  email_verified: number;
  /** Unverified iDs block the request, so an admin reviews a proven record
   *  (#1271). 0/1 INTEGER, migration 0050. */
  orcid_verified: number;
  /** `admin`/`owner` are exempt from the `orcid_verified` row. The RAW column
   *  (migration 0009): anything this build does not recognise is a regular
   *  user, so the exemption fails closed. */
  role: string | null;
  username: string | null;
  given_name: string | null;
  family_name: string | null;
  github_username: string | null;
  city: string | null;
  country: string | null;
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
 *
 * WHERE THE FIELD LIST COMES FROM (#1268, ADR 0045). `missing` is no longer
 * assembled here: it is `profileGapFields` over the same row, the function
 * `/users/me` and `/auth/me` compute their `profile_gaps` with. That is the
 * whole point of phase 8 — a refusal naming `city` and a status command that
 * never mentioned it were two implementations of one rule, and one of them was
 * always going to drift. What stays here is the ORDER OF THE THREE ANSWERS,
 * which is a property of this endpoint and of nothing else.
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

  // The gap list is computed once and then split at `email_verified`, rather
  // than computed twice: the inbox has its own refusal code and its own
  // endpoint, and it comes FIRST in matrix order, so the remaining entries are
  // exactly the profile half in exactly the order the clients render.
  const gaps = profileGapFields({
    email_verified: profile.email_verified === 1,
    // An unverified iD refuses the request by CONSTRUCTION rather than by a
    // check of its own here (#1271): the row is in the matrix, and this list is
    // the matrix's output.
    orcid_verified: profile.orcid_verified === 1,
    role: gapRole(profile.role),
    username: profile.username,
    given_name: profile.given_name,
    family_name: profile.family_name,
    github_username: profile.github_username,
    city: profile.city,
    country: profile.country,
  });

  if (gaps.includes("email_verified")) {
    return {
      error: "email_not_verified",
      message:
        "Verify your email address before requesting upload access; the review happens over email",
      missing: ["email_verified"],
    };
  }

  const missing = gaps;

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

/**
 * The 503 for a GitHub lookup that could not be completed (#1052).
 *
 * `missing` is EMPTY on purpose: nothing about the account is wrong, so a
 * client that renders `missing` as "fields to fix" must render nothing here.
 * The request is retryable as-is, which is what the message says.
 */
export const GITHUB_UNAVAILABLE_REFUSAL: UploadAccessRefusal = {
  error: "github_unavailable",
  message: "GitHub could not be reached; try again in a few minutes",
  missing: [],
};
