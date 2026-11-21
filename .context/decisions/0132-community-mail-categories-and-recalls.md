# ADR 0132: Community mail has four categories, and a recall is the one that cannot be turned off

**Status:** accepted
**Date:** 2026-11-20
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR sends mail to account holders as a group: news, a new Request for Comments (RFC) opening, maintenance, and, when it must, a notice that something NEMAR distributed is harmful.
Until now that mail had one switch, `announcements`, readable and settable only by admins (a non-admin account had no route to any preference, although the privacy policy promises "adjust your notification preferences directly"), and the mail carried no unsubscribe link.
The plan is `.context/mail-categories/plan.md` (epic #2260); the owner answered its decisions on 2026-11-20, and those answers are what this ADR records.
The rules NEMAR wants to meet regardless of whether its mail counts as commercial: an easy opt-out in every non-essential message that needs nothing beyond one click (CAN-SPAM, RFC 8058, Gmail's sender rules), a record of each choice (GDPR Article 21), and an honest policy text.

## Decision

**1. Four categories, declared once** in `shared/contract/mail-categories.ts` (the arrangement of ADR 0032 and ADR 0045): `news`, `rfcs`, `maintenance` and `recall`.
Their audience, sender and defaults live in `MAIL_CATEGORY_TABLE` and nowhere else; labels and descriptions are account copy (`mail.category.*`, `mail.recall.why`), mirrored to the website.

**2. Three are switchable and on by default; a recall is not and cannot be.**
`news` is on by default with opt-out (owner decision D1): a monthly curated newsletter, more often when needed, drafted with the Claude API and approved by a person before it is sent (phase P7).
A recall has no stored key, no setter and no route: a preference response reports `recall: {on: true, locked: true}` as a constant, and any request that names `recall` is refused by name.

**3. Storage stays in `users.email_preferences`; `announcements` is retired.**
Migration 0146 carries each live account's `announcements` value into `news`, `rfcs` and `maintenance` explicitly (D2) and writes one summary audit row.
It leaves the stored `announcements` key unchanged, because migrations apply seconds before the worker deploys and the previous worker still reads it (deleting it would let a notify in that window reach every opted-out account); only strict JSON `false` counts as an opt-out, as the parser has always read every key.
Phase P3 removes the last code that read the key (`getBroadcastRecipients`, the uncategorized group send) and refuses a group send without a category (`category_required`), so after P3 nothing in the worker reads or writes `announcements`.
The stored key itself stays until a follow-up migration drops it, shipped in the release AFTER the one that carries this epic: dropping it in the same release would reopen the window above.
The admin alerts (`user_approval`, `publication_request`, `dataset_anonymity`, `identifier_sweep`, `support_tickets`) are a separate type, and `getAdminEmailsForCategory` accepts only those, so a community category can never reach its first-admin fallback.

**4. Audiences (D3).**
`news` and `rfcs` reach `person` accounts at `verified` or `approved`; `maintenance` also reaches `service` accounts; a recall reaches `person` and `service` accounts at `verified`, `approved` or `revoked`, because a person whose access ended may still hold the recalled data.
Every audience needs a live account and a proved inbox, and none includes a `pending` or `test` account or the system account.
One function, `communityRecipients`, is the only place a categorized send selects people; a group (`admins`, `members`) narrows by role and never widens.

**5. A recall (D4)** tells account holders to stop using, delete or replace something NEMAR distributed or issued, because continuing can cause harm; it is a privacy recall, an integrity recall or a security recall, and nothing else.
It is never maintenance, a policy or terms change, news, an RFC, a request for feedback, a reminder or anything promotional.
Only the owner may send one; it needs a reference, a fixed subject prefix and two fixed headings, typed confirmation, and a public site notice.
A policy change goes out as a news item, and only a major one as maintenance plus a site notice (D10).

**6. Every change to a community category is audited.**
`saveEmailPreferences` writes the new value and one `mail_category_changed` row (`{category, on, via}`) in the same batch, so neither can exist without the other. The write is a per-key `json_set` over only the changed keys, and each audit row fires only when the stored value differs, so a concurrent write to another key is never reverted and the record diffs against the value actually replaced.
The owner and any admin may turn a category on or off for another account (D8), audited, with `via` `admin`; another account's admin alerts stay the owner's.

**7. Links and footers (built in P2 and P3, decided here).**
Every non-recall message carries a visible unsubscribe link and the RFC 8058 headers; the link is a signed, single-purpose token with no clock, valid while the account, its address and the broadcast row exist, and it can only turn its own category (or, from the page's second button, all three) off (D5, D6).
It is not a credential: it opens no session, so it is not added to the revocation callers of `docs-auth.ts` and `private-auth.ts`.
The footer carries the postal address the owner supplied (D7).
Phase P3 builds it (`services/mail-footer.ts`, `services/email-outbox.ts`): each recipient's footer names the category, says why they receive it, carries the visible unsubscribe link, a link to manage preferences and the address, and the message carries `List-Unsubscribe` (the same HTTPS URL) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; those two are the only additions to the `sendEmail` header allowlist, each with a value rule, and no `mailto:` form is sent.
The outbox consumer re-reads the account and the preference immediately before each send and records `skipped` for a deleted account, a changed address or a category switched off after queueing; a categorized message is never sent without those checks.
The owner declined a legal review of the defaults and the policy text (D11); the plan records the reasoning and the ordering of the phases.

**8. Sending rules (P3).**
A group send must name a category and goes only through the outbox, never inline (`outbox_required`); the owner-only table entry is enforced at the route.
A send that carries a link is refused before anything is written or queued when `MAIL_LINK_SECRET` is unusable or `API_BASE_URL` is not https.
A recall carries no link, so those two conditions do not hold one back: a safety notice is never blocked by a configuration of the unsubscribe path, which is a deliberate narrowing of "every categorized send".
The same category and subject within 24 hours is refused unless `--allow-repeat` is given.
A dry run answers counts per group and a redacted sample; outside production it never returns addresses.
A recall publishes a `critical` site notice through the existing notices table, so the record is public; the notice names the reference and the subject, never the body, and the owner clears it with `nemar admin notice clear` when the recall is resolved.
A recall reference is a dataset id with an optional version (the dataset must exist) or a `nemarOrg` or `nemarDatasets` issue, pull request or security advisory URL; the plan's "ledger entry id" form is not accepted, because no recall ledger exists to resolve it against.
No `List-Id` header is sent: the owner limited the allowlist extension to the two RFC 8058 headers.

## Consequences

- Any account, not only an admin, can finally be given a preference route; phase P4 adds it and makes the privacy policy's promise true.
- A new category is a table row, two copy keys and a migration for its stored key; every consumer reads the table, so none needs a second edit.
- Existing accounts keep what they had: nobody who opted out of announcements receives a category, and everyone else receives all three.
  `verified` accounts, who received no broadcast before, now receive community mail unless they turn it off; that is the widest change here and it is deliberate (D3).
- An old CLI that sends `announcements` gets `announcements_retired` naming the three flags; admins are few, so there is no shim.
- There is no uncategorized group send any more: an old CLI that omits `--category` gets `category_required` and is told to upgrade.
- A recall cannot reach an address Cloudflare suppressed after a bounce or complaint (ADR 0110); the recall's status view counts those failures so the owner knows.

## Alternatives considered

- **Keep one `announcements` switch and add a link to it.** Rejected: the owner wants RFC and maintenance mail separable from news, and one switch cannot say which kind a person wants to stop.
- **Make news opt-in for new accounts (the plan's recommendation D1).** Rejected by the owner: news is a curated monthly newsletter and stays on by default with opt-out.
- **Store recall as a fourth key that defaults on.** Rejected: any stored key can be written, by a bug or by an admin, and a recall must have no such value to write.
- **Let an admin send a recall.** Rejected: the mandatory category stays narrow by keeping its sender narrow.
- **A new table for preferences.** Rejected: one column, one parser and one deletion path already exist, and the audit rows carry the history.

## Receipts

- Plan: `.context/mail-categories/plan.md`; epic nemarOrg/nemar-cli#2260, phase 1 issue #2261.
- ADR 0032 and ADR 0045 (declare once, mirror the words), ADR 0110 (the Cloudflare mail path and its suppression), ADR 0112 (replies become support tickets), ADR 0113 (list mail and auto-replies are filed quietly).
- External rules read 2026-11-20: Federal Trade Commission, "CAN-SPAM Act: A Compliance Guide for Business"; Internet Engineering Task Force Request for Comments 8058; Gmail sender guidelines; General Data Protection Regulation Article 21.
