/**
 * What an account is still missing, what each missing field blocks, and where
 * it is set (epic #1250 phase 8, #1268; nemarOrg/website#309, #310).
 *
 * **One matrix, one computation, three readers.** `GET /users/me` and
 * `GET /auth/me` both carry `profile_gaps` computed by {@link computeProfileGaps},
 * and `checkUploadAccessRequest` (backend services/upload-access.ts) builds its
 * `missing` array from the SAME function — which is the point of this module.
 * A request refused for `github_username` and a `nemar auth status` that never
 * mentioned it is the failure this arrangement makes impossible: there is one
 * rule, and both answers are it.
 *
 * The website transcribes the table (its `src/lib/profile-gaps.ts`) rather than
 * importing it, for the reason ./account-copy.ts records, and derives the same
 * list locally when talking to a backend that predates `profile_gaps`. Its
 * derivation and this one are line-for-line the same rules; `test/profile-gaps-
 * matrix.test.ts` here pins every one of the 2^7 field combinations against a
 * fixture copied from that table so a change on either side is loud.
 *
 * **ORCID is not a gap.** The phase-8 matrix lists it as required at CLI signup
 * and as the source of the name, and both are true — but a CLI account cannot
 * exist without one, and a web account holds every tier without one, so an
 * `orcid` entry would name something nothing is waiting on. What an iD changes
 * is WHERE THE NAME IS SET (the `.orcid` set-on variants below), and that is
 * its whole effect on this list.
 *
 * **`why` is in the table and is not derivable.** It is part of the refused-
 * request vocabulary (`missing` on a 400 from
 * `POST /users/me/upload-access/request`), which both surfaces render with
 * these same sentences; nothing is stored until the form is submitted, so no
 * account row can ever be missing it. `email_verified` is the other member of
 * that vocabulary and IS derivable, from `status` / `email_verified`.
 *
 * **Sandbox training is CLI-only** and is deliberately not in the matrix: the
 * website has no such step and mirroring a row it can never render would make
 * the shared table a lie. It is declared separately at the bottom of this file
 * and rendered through the same sentence machinery (ADR 0045).
 */

import { ACCOUNT_COPY, type AccountCopyKey, fillCopy } from "./account-copy.js";
import type { AccountStatus } from "./user.js";

/**
 * What a missing field stops the account from doing.
 *
 * Ordered by how soon the account walks into it: an unverified inbox blocks
 * everything, an upload-access request comes before there is anything to
 * publish. {@link describeProfileGap} names the FIRST of a gap's blocks — the
 * nearest wall, not every wall behind it — which is why the order is part of
 * the data and not incidental.
 */
export type GapBlock = "verified" | "upload_access" | "publication";

/** The fields this contract knows how to describe. A `profile_gaps` entry
 *  naming anything else still renders (see {@link resolveProfileGap}); it just
 *  renders with its own name and no command. */
export type GapField =
  | "email_verified"
  | "username"
  | "given_name"
  | "family_name"
  | "github_username"
  | "city"
  | "country"
  | "why";

/**
 * Which surface can set a field.
 *
 * This is what `set_on` carries on the wire, and it is deliberately the SURFACE
 * and not the prose: "Settings" is a website noun and
 * `nemar auth profile set-github` a CLI one, and neither is something the
 * backend should have to spell for two clients that already know their own
 * vocabulary (they read it out of ./account-copy.ts). What the wire is telling
 * a client is whether the field is reachable from where the reader is standing
 * — a name owned by a verified ORCID record answers `["web"]`, because no CLI
 * command sets it.
 */
export type GapSurface = "web" | "cli";

interface ProfileGapDefinition {
  /** Blocks, nearest first. */
  readonly blocks: readonly GapBlock[];
  /** Copy keys. Split out rather than inlined so the sentences stay in
   *  ./account-copy.ts, which is the file the website mirrors. */
  readonly labelKey: AccountCopyKey;
  readonly webKey: AccountCopyKey;
  /** `null` when no CLI command sets it. */
  readonly cliKey: AccountCopyKey | null;
  /** Where a verified ORCID iD moves the "set it in" half. Only the two name
   *  halves have one: with an iD linked the record owns the name and
   *  `PATCH /auth/profile` refuses the edit (`name_is_orcid_canonical`), on
   *  both credentials since ADR 0044. */
  readonly orcidWebKey?: AccountCopyKey;
  /**
   * When this field counts as missing on a given account row, or `null` for a
   * field that is not account state at all.
   *
   * THE RULE LIVES IN THE TABLE, which is the point. {@link computeProfileGaps}
   * used to carry a hand-written if-chain beside this matrix, so adding a row
   * here and forgetting the branch there produced a field that every surface
   * could describe and none could ever raise -- silently, because the matrix
   * and the derivation had no way to disagree out loud. `Record<GapField, ...>`
   * now makes the predicate part of what a row IS, so a new field does not
   * compile until someone has said when it is missing.
   *
   * `null` is the honest spelling of "never raised from a row" and replaces the
   * old `derivable: boolean`: one field rather than two that had to agree, and
   * {@link DERIVABLE_GAP_FIELDS} is derived from it.
   */
  readonly isMissing: ((account: ProfileGapAccount) => boolean) | null;
}

/**
 * The matrix, as data.
 *
 * Order is prompt order, and it is the order every surface renders: the
 * account's own step first (verify), then who you are, then the two
 * export-control fields, then the request text. It is also the order
 * `checkUploadAccessRequest` builds `missing` in, because that function now
 * builds it from here — so a refusal and a status nudge list the same things
 * the same way round by construction rather than by two people agreeing.
 */
export const PROFILE_GAP_MATRIX: Record<GapField, ProfileGapDefinition> = {
  email_verified: {
    // Everything past browsing needs a proved inbox, and the upload-access
    // review itself happens over email (`email_not_verified` is its own
    // refusal, ahead of the profile check).
    blocks: ["verified", "upload_access"],
    labelKey: "gap.field.email_verified.label",
    webKey: "gap.field.email_verified.set_on.web",
    cliKey: "gap.field.email_verified.set_on.cli",
    // `status === "pending"` is the unverified tier; an explicit `false` says
    // the same thing from the newer flag. `undefined`/`null` on an active
    // account is a caller that does not report the flag, NOT an unproved inbox
    // -- treating it as one would show a verify step to accounts with nothing
    // to verify.
    isMissing: (a) => a.status === "pending" || a.email_verified === false,
  },
  username: {
    blocks: ["upload_access"],
    labelKey: "gap.field.username.label",
    webKey: "gap.field.username.set_on.web",
    cliKey: "gap.field.username.set_on.cli",
    // `undefined` is "could not be read" and does NOT raise the gap; see the
    // field's note on ProfileGapAccount.
    isMissing: (a) => a.username !== undefined && isBlank(a.username),
  },
  given_name: {
    // A DOI cites a person (ADR 0041), so the name outlives the request that
    // first asks for it.
    blocks: ["upload_access", "publication"],
    labelKey: "gap.field.given_name.label",
    webKey: "gap.field.given_name.set_on.web",
    cliKey: "gap.field.given_name.set_on.cli",
    orcidWebKey: "gap.field.given_name.set_on.web.orcid",
    // Raised even under a verified ORCID iD. The gap is real either way: the
    // upload-access request refuses with `missing: ["given_name",
    // "family_name"]` whatever owns the name, and publication is blocked with
    // `owner_name_missing`. What the iD changes is where it is set.
    isMissing: (a) => isBlank(a.given_name),
  },
  family_name: {
    blocks: ["upload_access", "publication"],
    labelKey: "gap.field.family_name.label",
    webKey: "gap.field.family_name.set_on.web",
    cliKey: "gap.field.family_name.set_on.cli",
    orcidWebKey: "gap.field.family_name.set_on.web.orcid",
    isMissing: (a) => isBlank(a.family_name),
  },
  github_username: {
    blocks: ["upload_access", "publication"],
    labelKey: "gap.field.github_username.label",
    webKey: "gap.field.github_username.set_on.web",
    cliKey: "gap.field.github_username.set_on.cli",
    isMissing: (a) => isBlank(a.github_username),
  },
  city: {
    blocks: ["upload_access"],
    labelKey: "gap.field.city.label",
    webKey: "gap.field.city.set_on.web",
    cliKey: "gap.field.city.set_on.cli",
    isMissing: (a) => isBlank(a.city),
  },
  country: {
    blocks: ["upload_access"],
    labelKey: "gap.field.country.label",
    webKey: "gap.field.country.set_on.web",
    cliKey: "gap.field.country.set_on.cli",
    isMissing: (a) => isBlank(a.country),
  },
  why: {
    blocks: ["upload_access"],
    labelKey: "gap.field.why.label",
    webKey: "gap.field.why.set_on.web",
    cliKey: "gap.field.why.set_on.cli",
    // `null`, not a predicate that always answers false: nothing is stored
    // until the request form is submitted, so no account ROW can be missing it.
    // It is in the table only so a refusal's `missing: ["why"]` renders.
    isMissing: null,
  },
};

/** Every known field, in prompt order. */
export const GAP_FIELDS = Object.keys(PROFILE_GAP_MATRIX) as readonly GapField[];

/** The subset {@link computeProfileGaps} can raise from an account row — every
 *  field except `why`, which only a submitted form can be missing. Derived
 *  from the predicates rather than declared beside them, so the two cannot
 *  drift apart. */
export const DERIVABLE_GAP_FIELDS: readonly GapField[] = GAP_FIELDS.filter(
  (field) => PROFILE_GAP_MATRIX[field].isMissing !== null,
);

const GAP_BLOCK_COPY: Record<GapBlock, AccountCopyKey> = {
  verified: "gap.blocks.verified",
  upload_access: "gap.blocks.upload_access",
  publication: "gap.blocks.publication",
};

/** "upload access", "upload access and publication" — for a surface that
 *  REPORTS rather than instructs (the website's admin review card).
 *  Deliberately noun-phrased, not the sentence fragments above. */
const GAP_BLOCK_NOUNS: Record<GapBlock, AccountCopyKey> = {
  verified: "gap.blocks.noun.verified",
  upload_access: "gap.blocks.noun.upload_access",
  publication: "gap.blocks.noun.publication",
};

function isGapBlock(value: unknown): value is GapBlock {
  return value === "verified" || value === "upload_access" || value === "publication";
}

/** Whitespace counts as absent, matching `resolveUploaderIdentity`'s trim
 *  (backend services/uploader-identity.ts): a row holding " " has no city. */
function isBlank(value: string | null | undefined): boolean {
  return (value ?? "").trim().length === 0;
}

/**
 * The account columns the gap rules read.
 *
 * Structural rather than a `Pick<>` of any one wire shape, because four
 * different rows are passed in: the `/users/me` join, the `/auth/me` session
 * row, the upload-access precondition SELECT, and (on the website) an
 * `AdminUserDetail`. Every field is optional so a partial row is expressible;
 * what stops a backend from silently dropping one is that its own row
 * interface names the columns, and the route tests assert the resulting gap.
 */
export interface ProfileGapAccount {
  /**
   * `"pending"` is the unverified tier (ADR 0040).
   *
   * The declared vocabulary rather than `string`, because the rule below turns
   * on one literal and a caller passing the dashboard's collapsed
   * `"active"`/`"pending"` value, or a typo, would silently take the other
   * branch. The four values are the ones `users.status` can hold (a CHECK
   * constraint since migration 0001), which is what every caller reads it from.
   */
  readonly status?: AccountStatus | null;
  readonly email_verified?: boolean | null;
  /**
   * `undefined` means the username could not be READ, which is not the same as
   * a NULL username and does not raise the gap: prompting someone to set a
   * handle they may already have is worse than omitting a line they can still
   * reach from Settings. The website hits that case for real (it resolves the
   * username through a separate fetch that can fail); server-side the column is
   * always in hand, and the rule is kept identical so the two derivations are
   * the same rules rather than nearly the same rules.
   */
  readonly username?: string | null;
  readonly given_name?: string | null;
  readonly family_name?: string | null;
  readonly github_username?: string | null;
  readonly city?: string | null;
  readonly country?: string | null;
  /** Moves the name halves' `set_on` to the ORCID record. */
  readonly orcid_verified?: boolean | null;
}

/** One `profile_gaps` entry, exactly as it goes on the wire. */
export interface ProfileGapEntry {
  readonly field: string;
  readonly blocks: readonly GapBlock[];
  readonly set_on: readonly GapSurface[];
}

/**
 * The same entry as it ARRIVES, before anything has narrowed it.
 *
 * Deliberately loose, and deliberately declared ONCE. Two readers take entries
 * in this shape — {@link resolveWireProfileGaps} and the CLI's `ProfileGapView`
 * (src/lib/account-gaps.ts) — and they were both spelling it inline, alongside
 * two zod schemas describing the same thing (the wire's `profileGapSchema` and
 * the config cache's). Four declarations of one shape is three chances for a
 * relaxation on one side to go unnoticed on another, which is precisely the
 * drift this whole module exists to end.
 *
 * `unknown` rather than the narrow types, because both sources can hand over
 * something older or newer than this build: a backend from before the
 * vocabulary grew, or a config cache written by a different CLI version and
 * round-tripped through JSON. Narrowing is `resolveWireProfileGaps`'s job, and
 * an entry it cannot use is dropped rather than fatal.
 *
 * The two schemas stay schemas — they validate, and a type cannot — but their
 * inferred types are pinned as assignable to this one at their declaration
 * sites, so a schema that tightened past what the readers accept fails to
 * compile.
 */
export interface ProfileGapWireEntry {
  readonly field?: unknown;
  readonly blocks?: unknown;
  readonly set_on?: unknown;
}

/** Compile-time only: fails to compile unless `A` is assignable to `B`.
 *  Used at the two schema declarations to pin them to
 *  {@link ProfileGapWireEntry}. */
export type AssignableTo<B, A extends B> = true;

/** Where a field can be set, given what owns the name on this account. */
export function gapSurfaces(field: string, orcidVerified = false): GapSurface[] {
  const def = Object.hasOwn(PROFILE_GAP_MATRIX, field)
    ? PROFILE_GAP_MATRIX[field as GapField]
    : undefined;
  // An unknown field still has a home: Settings holds the account form.
  if (!def) return ["web"];
  const underOrcid = orcidVerified && def.orcidWebKey !== undefined;
  return underOrcid || def.cliKey === null ? ["web"] : ["web", "cli"];
}

/**
 * Every gap on this account, in matrix order.
 *
 * The one computation. `GET /users/me`, `GET /auth/me` and the upload-access
 * request preconditions all call it, which is what makes them unable to
 * disagree — the property epic #1250 phase 8 exists to establish.
 */
export function computeProfileGaps(account: ProfileGapAccount): ProfileGapEntry[] {
  const orcidVerified = account.orcid_verified === true;
  const entry = (field: GapField): ProfileGapEntry => ({
    field,
    blocks: PROFILE_GAP_MATRIX[field].blocks,
    set_on: gapSurfaces(field, orcidVerified),
  });

  // Iterating the matrix rather than restating it: matrix order IS prompt
  // order, and every rule is a property of the row it belongs to, so a field
  // cannot be described here and un-raisable, or raised in an order the
  // refusal does not share.
  return GAP_FIELDS.filter((field) => PROFILE_GAP_MATRIX[field].isMissing?.(account) === true).map(
    entry,
  );
}

/** Just the field names, in matrix order — the shape
 *  `checkUploadAccessRequest` puts in `missing`. */
export function profileGapFields(account: ProfileGapAccount): string[] {
  return computeProfileGaps(account).map((gap) => gap.field);
}

/** One gap resolved to everything a surface needs to print it. */
export interface ResolvedProfileGap {
  /** As the API spells it. A string, not {@link GapField}: an entry naming a
   *  field this build has never heard of is rendered, not dropped. */
  readonly field: string;
  readonly label: string;
  readonly blocks: readonly GapBlock[];
  /** Prose that fits "Set it in ___". */
  readonly setOnWeb: string;
  /** The exact CLI command, or null when none sets it. */
  readonly setOnCli: string | null;
  /** False when this build has no definition for `field`. */
  readonly known: boolean;
}

/**
 * Resolve one field name into a renderable gap.
 *
 * An unrecognised field is kept rather than dropped: the vocabulary is closed
 * today, and silently swallowing a value it grows tomorrow would tell someone
 * their request failed for no reason at all. It renders with its own name, the
 * generic Settings destination, and no command.
 */
export function resolveProfileGap(
  field: string,
  options: { readonly orcidVerified?: boolean; readonly blocks?: readonly GapBlock[] } = {},
): ResolvedProfileGap {
  const orcidVerified = options.orcidVerified === true;
  const def = Object.hasOwn(PROFILE_GAP_MATRIX, field)
    ? PROFILE_GAP_MATRIX[field as GapField]
    : undefined;
  if (!def) {
    return {
      field,
      label: field,
      blocks: options.blocks ?? [],
      setOnWeb: ACCOUNT_COPY["gap.set_on.default_web"],
      setOnCli: null,
      known: false,
    };
  }
  const underOrcid = orcidVerified && def.orcidWebKey !== undefined;
  return {
    field,
    blocks: options.blocks ?? def.blocks,
    label: ACCOUNT_COPY[def.labelKey],
    setOnWeb: ACCOUNT_COPY[underOrcid ? (def.orcidWebKey as AccountCopyKey) : def.webKey],
    // No command under a verified iD: `nemar auth profile set-name` is refused
    // for the same reason the web fields are withheld.
    setOnCli: underOrcid || def.cliKey === null ? null : ACCOUNT_COPY[def.cliKey],
    known: true,
  };
}

/** Position in {@link GAP_FIELDS}, or the end for an unknown field. */
function fieldOrder(field: string): number {
  const index = (GAP_FIELDS as readonly string[]).indexOf(field);
  return index === -1 ? GAP_FIELDS.length : index;
}

/**
 * Resolve a bare list of field names — a refused request's `missing` array —
 * into gaps.
 *
 * Order is the caller's, because a refusal's order is the backend's deliberate
 * one and it is already matrix order (`checkUploadAccessRequest` builds it from
 * {@link computeProfileGaps}).
 */
export function resolveProfileGaps(
  fields: readonly string[],
  options: { readonly orcidVerified?: boolean } = {},
): ResolvedProfileGap[] {
  return fields.map((field) => resolveProfileGap(field, { orcidVerified: options.orcidVerified }));
}

/**
 * Resolve wire entries into gaps, re-sorted into matrix order so a backend that
 * emits them in another order still renders the same list.
 *
 * `blocks` is taken from the wire when it sends a usable one, because the
 * backend is the authority on what a field blocks TODAY; the matrix is the
 * fallback, and the two agree by construction. Unknown block values are dropped
 * rather than printed raw, and an entry left with none falls back to the matrix.
 */
export function resolveWireProfileGaps(
  entries: readonly ProfileGapWireEntry[],
  options: { readonly orcidVerified?: boolean } = {},
): ResolvedProfileGap[] {
  return entries
    .filter((entry) => !!entry && typeof entry.field === "string")
    .map((entry) => {
      const blocks = Array.isArray(entry.blocks) ? entry.blocks.filter(isGapBlock) : [];
      return resolveProfileGap(entry.field as string, {
        orcidVerified: options.orcidVerified,
        blocks: blocks.length > 0 ? blocks : undefined,
      });
    })
    .sort((a, b) => fieldOrder(a.field) - fieldOrder(b.field));
}

/**
 * The half of the sentence after the label — "is missing: needed to request
 * upload access. Set it in Settings or run `nemar auth profile set-github`."
 *
 * Exported so a surface can link or colour the LABEL and still print one
 * sentence: `label + " " + profileGapTail(gap)` and {@link describeProfileGap}
 * are the same words either way.
 */
export function profileGapTail(gap: ResolvedProfileGap): string {
  const first = gap.blocks[0];
  const blocks = first ? ACCOUNT_COPY[GAP_BLOCK_COPY[first]] : ACCOUNT_COPY["gap.blocks.unknown"];
  // `{label}` is filled with "" here and re-attached by the caller, so the
  // template stays one string in account-copy.ts.
  const need = fillCopy(ACCOUNT_COPY["gap.sentence"], { label: "", blocks }).trimStart();
  const setOn = gap.setOnCli
    ? fillCopy(ACCOUNT_COPY["gap.set_on.both"], { web: gap.setOnWeb, cli: gap.setOnCli })
    : fillCopy(ACCOUNT_COPY["gap.set_on.web"], { web: gap.setOnWeb });
  return `${need} ${setOn}`;
}

/**
 * The one sentence every surface prints for a gap:
 *
 * > GitHub handle is missing: needed to request upload access. Set it in
 * > Settings or run `nemar auth profile set-github`.
 *
 * It names the FIRST block only. A GitHub handle blocks publication as well as
 * the request, but the request is the wall in front of the person reading it;
 * listing the ones behind it makes a longer sentence that helps nobody decide
 * what to do next. The full list stays on `gap.blocks` for callers that want it.
 */
export function describeProfileGap(gap: ResolvedProfileGap): string {
  return `${gap.label} ${profileGapTail(gap)}`;
}

/** "upload access and publication" — the full block list, for a surface that
 *  reports rather than instructs. */
export function describeProfileGapBlocks(gap: ResolvedProfileGap): string {
  const nouns = gap.blocks.map((block) => ACCOUNT_COPY[GAP_BLOCK_NOUNS[block]]);
  if (nouns.length === 0) return "";
  if (nouns.length === 1) return nouns[0];
  return `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
}

/**
 * Sandbox training, the one step that exists in the terminal and nowhere else
 * (ADR 0045).
 *
 * Not a member of {@link PROFILE_GAP_MATRIX} on purpose: that table is the
 * mirrored one, and a row the website can never render would make it a lie
 * about what the two surfaces share. It is rendered through the same
 * {@link describeProfileGap} machinery so the CLI prints one shape of sentence
 * rather than two, and it carries no `blocks` from {@link GapBlock} because
 * what it blocks — a real upload from this machine — is not one of the three
 * things the shared vocabulary names.
 */
export const CLI_SANDBOX_GAP = {
  field: "sandbox",
  label: ACCOUNT_COPY["cli.gap.field.sandbox.label"],
  command: ACCOUNT_COPY["cli.gap.field.sandbox.set_on.cli"],
} as const;

/** "Sandbox training is missing: needed to upload a dataset from the CLI. Run
 *  `nemar sandbox`." Composed from the shared templates, so it reads as one of
 *  the list rather than as an aside bolted onto it. */
export function describeSandboxGap(): string {
  const need = fillCopy(ACCOUNT_COPY["gap.sentence"], {
    label: CLI_SANDBOX_GAP.label,
    blocks: ACCOUNT_COPY["cli.gap.blocks.sandbox"],
  });
  const setOn = fillCopy(ACCOUNT_COPY["cli.gap.set_on.cli_only"], {
    cli: CLI_SANDBOX_GAP.command,
  });
  return `${need} ${setOn}`;
}
