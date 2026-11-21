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

/**
 * The refusal an admin who is not an owner gets for naming an admin alert on another account
 * (`PUT /admin/email-preferences?user=`), worded for the CLI flags that produce it: `--all` and
 * the five alert flags all include alerts, so the way forward is the three category flags.
 */
export const COMMUNITY_ONLY_REFUSAL =
  "Only owners can change another account's admin alerts. As an admin you can change another account's mail categories only: use --news, --rfcs and --maintenance, not --all or the alert flags.";

// ---------------------------------------------------------------------------
// Recalls (epic #2260 phase 3, ADR 0132 decision 5)
// ---------------------------------------------------------------------------

/** What every recall subject starts with, so a recall is recognizable before it is opened. */
export const RECALL_SUBJECT_PREFIX = "[NEMAR recall]";

/** The two headings every recall body carries, in this order. A recall has no other required content. */
export const RECALL_REQUIRED_HEADINGS = ["What is affected", "What to do"] as const;

/** The subject a recall goes out under: the owner's words behind the fixed prefix, added once. */
export function recallSubject(subject: string): string {
  const trimmed = subject.trim();
  return trimmed.startsWith(RECALL_SUBJECT_PREFIX)
    ? trimmed
    : `${RECALL_SUBJECT_PREFIX} ${trimmed}`;
}

/**
 * The blocks the mail renderer sees: line endings normalized (CRLF and lone CR become LF, so a body
 * typed on Windows splits like any other), the text trimmed, and split on blank lines. THE one block
 * rule: `markdownToEmailHtml` renders these blocks and {@link missingRecallHeadings} validates them,
 * so a heading the validator accepts is a heading the renderer produces.
 */
export function emailMarkdownBlocks(markdown: string): string[] {
  return markdown
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
}

/**
 * The heading a block renders as, or null. The renderer turns a block into a heading only when the
 * WHOLE block is one line of one to three `#`, a space and text; a heading line followed by text in
 * the same block (no blank line between) is a paragraph, not a heading.
 */
export function emailHeadingBlock(block: string): { level: 1 | 2 | 3; text: string } | null {
  const match = /^(#{1,3})\s+(.+)$/.exec(block);
  if (!match) return null;
  return { level: (match[1] as string).length as 1 | 2 | 3, text: match[2] as string };
}

/**
 * The required headings a recall body lacks. A heading is a block (see {@link emailMarkdownBlocks})
 * that the renderer turns into an `<h1>` to `<h3>` (see {@link emailHeadingBlock}) and whose text is
 * exactly the required words, compared without case. A mention of the words inside a paragraph, a
 * heading line fused to the text under it, and a heading with other words or closing `#` marks are
 * not headings.
 */
export function missingRecallHeadings(body: string): string[] {
  const headings = new Set(
    emailMarkdownBlocks(body)
      .map((block) => emailHeadingBlock(block)?.text.trim().toLowerCase())
      .filter((text): text is string => Boolean(text)),
  );
  return RECALL_REQUIRED_HEADINGS.filter((heading) => !headings.has(heading.toLowerCase()));
}

/** What a recall is about, parsed from `--recall-ref`. */
export type RecallReference =
  | { kind: "dataset"; datasetId: string; version: string | null; text: string }
  | { kind: "github"; url: string; text: string };

const RECALL_DATASET_RE = /^([a-z]{2}\d{6})(?:@v?(\d+\.\d+\.\d+))?$/;
const RECALL_GITHUB_RE =
  /^https:\/\/github\.com\/(?:nemarOrg|nemarDatasets)\/[A-Za-z0-9._-]+\/(?:(?:issues|pull)\/\d{1,9}|security\/advisories\/GHSA(?:-[a-z0-9]{4}){3})$/;

/**
 * Parse a recall reference, or null when it is not one of the two accepted shapes: a dataset id with
 * an optional version (`nm000104`, `nm000104@v1.2.0`), or an issue, pull request or security
 * advisory URL in `nemarOrg` or `nemarDatasets`. Shape only; the backend also checks that a dataset
 * exists. Anything else, a free sentence included, is not a reference: a recall must point at something.
 */
export function parseRecallReference(raw: string): RecallReference | null {
  const text = raw.trim();
  const dataset = RECALL_DATASET_RE.exec(text);
  if (dataset) {
    return { kind: "dataset", datasetId: dataset[1] as string, version: dataset[2] ?? null, text };
  }
  if (RECALL_GITHUB_RE.test(text)) return { kind: "github", url: text, text };
  return null;
}

/** The refusal a malformed `--recall-ref` gets, one sentence naming the accepted shapes. */
export const RECALL_REFERENCE_REFUSAL =
  "A recall needs a reference: a dataset id with an optional version (nm000104 or nm000104@v1.2.0), or a nemarOrg or nemarDatasets issue, pull request or security advisory URL.";
