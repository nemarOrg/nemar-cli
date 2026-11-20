/**
 * The community mail categories, declared once (epic #2260 phase 1, ADR 0132).
 *
 * Community mail is what NEMAR sends to account holders as a group, as opposed to the admin alerts
 * an admin receives about their own work. There are four categories:
 *
 *   news         new features, data and events        a person may turn it off, on by default
 *   rfcs         a new NEMAR RFC is open              a person may turn it off, on by default
 *   maintenance  planned downtime, service changes    a person may turn it off, on by default
 *   recall       stop using, delete or replace        NEVER stored, NEVER switchable, owner-only to send
 *
 * Every rule about a category lives in {@link MAIL_CATEGORY_TABLE} and nowhere else, the arrangement
 * ADR 0032 (facets) and ADR 0045 (account copy) use: the recipients service reads the audience
 * from it, the preference parser reads the stored keys from it, the CLI and the website read the
 * labels from it. A rule written at a call site is a rule that drifts.
 *
 * Zero dependencies beyond the sibling account-copy table, so this file lifts into the standalone
 * contract package with the rest of `shared/contract/`.
 */

import { ACCOUNT_COPY } from "./account-copy.js";

/** The three categories a person may turn off. The order is the order every surface lists them. */
export const COMMUNITY_MAIL_CATEGORIES = ["news", "rfcs", "maintenance"] as const;
export type CommunityMailCategory = (typeof COMMUNITY_MAIL_CATEGORIES)[number];

/** Every category, recalls last. */
export const MAIL_CATEGORIES = [...COMMUNITY_MAIL_CATEGORIES, "recall"] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

/** The category that cannot be turned off, named so a caller never spells the string itself. */
export const RECALL_CATEGORY = "recall" as const;

/** The groups a categorized send may name. A group narrows the audience by role and never widens it. */
export const MAIL_RECIPIENT_GROUPS = ["all", "admins", "members"] as const;
export type MailRecipientGroup = (typeof MAIL_RECIPIENT_GROUPS)[number];

/** Account statuses a category's audience may include (`pending` never does: the inbox is unproved). */
export type MailAudienceStatus = "verified" | "approved" | "revoked";

/** Account kinds a category's audience may include (`test` never does). */
export type MailAudienceKind = "person" | "service";

/** Who may send a category: any admin, or the owner alone. */
export type MailSender = "admin" | "owner";

export interface MailCategoryDefinition {
  readonly id: MailCategory;
  /** False only for a recall: nothing may store or honor an opt-out of it. */
  readonly canBeTurnedOff: boolean;
  /** The value an account that never chose has. Meaningful only when `canBeTurnedOff`. */
  readonly defaultOn: boolean;
  /** Statuses that receive it. Every audience also needs `email_verified = 1` and a live account. */
  readonly statuses: readonly MailAudienceStatus[];
  readonly accountKinds: readonly MailAudienceKind[];
  readonly sender: MailSender;
}

/**
 * The table. Audience rules (epic #2260 plan 4.1, decision D3):
 *
 * - news and rfcs reach persons who proved their inbox (`verified`) or hold base access
 *   (`approved`); maintenance also reaches service accounts, which run on NEMAR;
 * - a recall also reaches `revoked` accounts, because a person whose access ended may still hold the
 *   recalled data or credential;
 * - `pending` and `test` accounts and deleted rows are in no audience.
 */
export const MAIL_CATEGORY_TABLE: Readonly<Record<MailCategory, MailCategoryDefinition>> = {
  news: {
    id: "news",
    canBeTurnedOff: true,
    defaultOn: true,
    statuses: ["verified", "approved"],
    accountKinds: ["person"],
    sender: "admin",
  },
  rfcs: {
    id: "rfcs",
    canBeTurnedOff: true,
    defaultOn: true,
    statuses: ["verified", "approved"],
    accountKinds: ["person"],
    sender: "admin",
  },
  maintenance: {
    id: "maintenance",
    canBeTurnedOff: true,
    defaultOn: true,
    statuses: ["verified", "approved"],
    accountKinds: ["person", "service"],
    sender: "admin",
  },
  recall: {
    id: "recall",
    canBeTurnedOff: false,
    defaultOn: true,
    statuses: ["verified", "approved", "revoked"],
    accountKinds: ["person", "service"],
    sender: "owner",
  },
};

export function isMailCategory(value: unknown): value is MailCategory {
  return typeof value === "string" && (MAIL_CATEGORIES as readonly string[]).includes(value);
}

export function isCommunityMailCategory(value: unknown): value is CommunityMailCategory {
  return (
    typeof value === "string" && (COMMUNITY_MAIL_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * What a preferences response says about recalls: always on, and locked. It is a constant, not a
 * stored value, so there is no row a bug or an admin could flip.
 */
export const RECALL_PREFERENCE = { on: true, locked: true } as const;

/**
 * The shape both the admin and the self-service preference routes answer with for the community
 * categories: the three switchable ones plus the locked recall entry.
 */
export type CommunityMailPreferences = { [K in CommunityMailCategory]: boolean };

/** A category's label, from the account-copy table (the typed key fails to compile if one is absent). */
export function mailCategoryLabel(id: MailCategory): string {
  return ACCOUNT_COPY[`mail.category.${id}.label`];
}

/** A category's one-line description, from the account-copy table. */
export function mailCategoryDescription(id: MailCategory): string {
  return ACCOUNT_COPY[`mail.category.${id}.description`];
}

/** The sentence that says why a recall cannot be turned off. */
export function mailRecallWhy(): string {
  return ACCOUNT_COPY["mail.recall.why"];
}
