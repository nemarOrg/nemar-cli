/**
 * `nemar admin users show` and `edit`: turning what an admin typed into one
 * account, and one account into text (ADR 0093).
 *
 * Pure, so the rules are testable without a server. The commands in
 * commands/admin.ts own the I/O.
 */

import chalk from "chalk";
import type { AdminUserDetail, AdminUserEditBody } from "../../shared/contract/admin-user.js";
import type { UserListItem } from "./api/admin.js";

/**
 * How a lookup resolved.
 *
 * `exact` matters for `edit` and not for `show`: one partial hit is fine to
 * LOOK at, but an edit confirmed with `--yes` against an account the admin only
 * half-named is how the wrong person is changed. An exact hit is one where the
 * query IS one of the account's identifiers, not merely a substring of a field.
 * `fuzzy` says the account is a near miss (a typo or an accent away), offered
 * because nothing matched.
 */
export type LookupResolution =
  | { kind: "none" }
  | { kind: "one"; user: UserListItem; exact: boolean; fuzzy: boolean }
  | { kind: "many"; users: UserListItem[]; fuzzy: boolean };

/** The row the search named outright, if exactly one did. The SERVER decides
 *  what "named outright" means (`match_kind: "exact"`), through the same
 *  normalisers that store an email, a handle or an ORCID iD (ADR 0043), so
 *  there is one rule and this file does not carry a second copy of it. */
export function exactHit(users: readonly UserListItem[]): UserListItem | null {
  const hits = users.filter((user) => user.match_kind === "exact");
  return hits.length === 1 ? hits[0] : null;
}

/** Every row is a near miss offered because nothing matched. */
export function allFuzzy(users: readonly UserListItem[]): boolean {
  return users.length > 0 && users.every((user) => user.match_kind === "fuzzy");
}

/**
 * Resolve the rows a search returned to at most one account.
 *
 * Several rows are narrowed to one only when exactly one of them is named
 * outright (searching `ada` returns `ada` and `adalovelace`; the first is what
 * was meant). Two exact hits cannot happen for distinct identifiers, but if a
 * query somehow names two accounts it stays `many` rather than guessing.
 */
export function resolveLookup(users: readonly UserListItem[]): LookupResolution {
  if (users.length === 0) return { kind: "none" };
  const exact = exactHit(users);
  if (exact) return { kind: "one", user: exact, exact: true, fuzzy: false };
  const fuzzy = allFuzzy(users);
  if (users.length === 1) return { kind: "one", user: users[0], exact: false, fuzzy };
  return { kind: "many", users: [...users], fuzzy };
}

/** The CLI flag (Commander's camelCase name) behind each editable field. */
export const EDIT_FLAG_FIELDS = [
  ["givenName", "given_name"],
  ["familyName", "family_name"],
  ["affiliation", "affiliation"],
  ["city", "city"],
  ["country", "country"],
  ["username", "username"],
  ["github", "github_username"],
  ["email", "email"],
] as const;

/** Collect the fields an admin passed as flags. A flag given as `""` is kept:
 *  it is how `affiliation` and the GitHub handle are cleared. */
export function editBodyFromOptions(options: Record<string, unknown>): AdminUserEditBody {
  const body: Record<string, string> = {};
  for (const [flag, field] of EDIT_FLAG_FIELDS) {
    const value = options[flag];
    if (typeof value === "string") body[field] = value;
  }
  return body as AdminUserEditBody;
}

export interface PlannedChange {
  field: keyof AdminUserEditBody;
  from: string | null;
  to: string;
}

/**
 * What an edit will do, as far as the CLI can tell WITHOUT re-implementing the
 * server's normalisation (trimming, lower-casing an email, stripping `@`).
 * It compares the typed value with the stored one exactly; the server then
 * decides what is really a change and reports it, and that report, not this
 * preview, is what the command prints afterwards. A preview that guessed at
 * normalisation would be a second copy of those rules (ADR 0043).
 */
export function planEdit(current: AdminUserDetail, body: AdminUserEditBody): PlannedChange[] {
  const stored = current as unknown as Record<string, unknown>;
  const plan: PlannedChange[] = [];
  for (const [, field] of EDIT_FLAG_FIELDS) {
    const to = body[field];
    if (to === undefined) continue;
    const raw = stored[field];
    const from = typeof raw === "string" ? raw : null;
    if ((from ?? "") === to) continue;
    plan.push({ field, from, to });
  }
  return plan;
}

function show(value: string | null | undefined, whenEmpty = "-"): string {
  return value && value.trim() !== "" ? value : whenEmpty;
}

/** A value for the before/after lines: distinguishes "none" from "cleared". */
export function displayEditValue(value: string | null): string {
  if (value === null) return chalk.dim("(none)");
  if (value === "") return chalk.dim("(cleared)");
  return value;
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace("T", " ").slice(0, 16);
}

/** One account's details, one printable line each. */
export function userDetailLines(user: AdminUserDetail): string[] {
  const label = (name: string): string => chalk.dim(`${name}:`.padEnd(15));
  const realName = [user.given_name, user.family_name].filter(Boolean).join(" ");
  const location = [user.city, user.country].filter(Boolean).join(", ");
  const role = user.role || "member";
  const tier =
    user.service_access === undefined || user.service_access === null
      ? "unknown"
      : user.service_access
        ? "upload"
        : "browse";
  const lines: string[] = [];

  lines.push(
    `${chalk.cyan(user.username ?? user.email)}${chalk.dim(` [${role}]  id ${user.id}`)}${
      user.username === null ? chalk.dim("  (no username)") : ""
    }`,
  );
  lines.push(`  ${label("Name")}${show(realName)}`);
  lines.push(
    `  ${label("Email")}${user.email} ${user.email_verified ? chalk.green("(verified)") : chalk.yellow("(unverified)")}`,
  );
  lines.push(`  ${label("GitHub")}${user.github_username ? `@${user.github_username}` : "-"}`);
  lines.push(
    `  ${label("ORCID")}${user.orcid ? `${user.orcid} ${user.orcid_verified ? chalk.green("(verified)") : chalk.yellow("(unverified)")}` : "-"}`,
  );
  lines.push(`  ${label("Affiliation")}${show(user.affiliation)}`);
  lines.push(`  ${label("Location")}${show(location)}`);
  lines.push(`  ${label("Status")}${user.status}`);
  lines.push(
    `  ${label("Upload access")}${tier}${
      user.service_access && user.service_access_granted_at
        ? chalk.dim(
            ` (granted ${formatWhen(user.service_access_granted_at)}${
              user.service_access_granted_by ? ` by id ${user.service_access_granted_by}` : ""
            })`,
          )
        : ""
    }`,
  );
  if (user.upload_access_requested_at) {
    lines.push(`  ${label("Asked")}${formatWhen(user.upload_access_requested_at)} (upload access)`);
  }
  lines.push(`  ${label("Kind")}${user.account_kind ?? "-"}`);
  lines.push(`  ${label("Signed up via")}${show(user.signup_source)}`);
  lines.push(`  ${label("Created")}${formatWhen(user.created_at)}`);
  if (user.approved_at) lines.push(`  ${label("Approved")}${formatWhen(user.approved_at)}`);
  if (user.revoked_at) lines.push(`  ${label("Revoked")}${formatWhen(user.revoked_at)}`);
  lines.push(`  ${label("Last changed")}${formatWhen(user.updated_at)}`);
  lines.push(
    `  ${label("Datasets")}${user.dataset_count ?? "-"}${chalk.dim("   API keys: ")}${user.active_tokens ?? "-"}`,
  );
  lines.push(
    `  ${label("Sign-in")}${
      user.linked_identities && user.linked_identities.length > 0
        ? user.linked_identities.join(", ")
        : "-"
    }`,
  );
  if (user.description) lines.push(`  ${label("Description")}${user.description}`);

  // The conditions worth a line only when true, so a normal account reads clean.
  if (user.identity_conflict) {
    lines.push(
      `  ${chalk.yellow("! Flagged as a duplicate identity: see 'nemar admin duplicates'")}`,
    );
  }
  if (user.username_auto_assigned) {
    lines.push(`  ${chalk.dim("The username was derived from the name, not chosen")}`);
  }
  if (user.deleted_at) {
    lines.push(`  ${chalk.red(`Deleted ${formatWhen(user.deleted_at)} (tombstoned)`)}`);
  }
  return lines;
}

/** A candidate row for the "which one did you mean" list. */
export function candidateLine(user: UserListItem): string {
  const name = [user.given_name, user.family_name].filter(Boolean).join(" ");
  const matched =
    user.matched_in && user.matched_in.length > 0
      ? chalk.dim(`  matched: ${user.matched_in.join(", ")}`)
      : "";
  return `  ${String(user.id).padStart(5)}  ${chalk.cyan(user.username ?? "(no username)")}  ${show(name, "")}  ${chalk.dim(user.email)}${matched}`;
}
