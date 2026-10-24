# ADR 0111: Inbound mail becomes support tickets

**Status:** proposed
**Date:** 2026-10-24
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0110 moves NEMAR's mail onto the Cloudflare Email Service and keeps every inbound message, untouched, in R2.
That settled where mail lands and left open what the platform does with it: who sees a message, who answers, what a reply looks like to the sender, and what must never be visible to everyone who administers the platform.
Some mail is routine (an upload question); some is about a vulnerability or a conduct complaint, and a person named in such a report must not be able to read, or be handed, the ticket about them.
Administrators are not all people: an agent may hold an admin account, and the rules below are written so that nothing depends on which it is.

## Decision

**Ticket model.**
A message is a ticket, or a message on an existing ticket.
Five tables hold the working copy: queues, tickets, messages, tags and events, plus an availability table for away windows.
The raw object in R2 is the record and the tables are rebuilt from it: processing a stored key twice stores it once (the key is unique), and an owner-only route reprocesses a key.
If any step after the raw put fails, the failure is logged and the raw object stays, so a message is never lost to a parsing or database fault.
A ticket has a status (`open`, `pending`, `escalated`, `closed`, `spam`), an assignee or none, the requester's address, an optional link to a verified account, and a copy of its queue's `restricted` flag taken at creation.
A queue is chosen by the local part of the address the mail was sent to (`support`, `security`, `conduct`, ...); any other address falls to the fallback queue `*`.
Plus tags other than a ticket reference are kept as tags.

**Threading.**
A reply from NEMAR is sent from `support@<domain>` with reply-to `support+t<ref>@<domain>`, so the requester's answer reaches the ticket by the plus address even if their client drops every header.
Failing that, an inbound message threads by `In-Reply-To` and then `References` against stored Message-IDs.
NEMAR sets its own `Message-ID`, `In-Reply-To` (the latest inbound message) and `References` (the chain) on every reply; the sender accepts only those three header names, with no control characters, so no value can add a header.
The domain comes from `FROM_EMAIL`, so staging replies come from the staging subdomain and production from the apex, each an allowed sender of its own binding.
A ticket reference is 50 random bits, not a secret: it routes, it does not authorize, and a message judged spam is never threaded.

**Spam.**
A message whose sender fails DMARC, or that passes no authentication mechanism at all, is stored with status `spam`: kept, never assigned, never notified, and not replyable.
An admin can mark a ticket spam or restore it.
The account link is set only when DMARC passes and the sender's address is a verified account's address.

**Restricted queues and exclusion.**
`security` and `conduct` are restricted by definition and cannot be unrestricted; the fallback queue can never be restricted.
One predicate decides who may read or act on a ticket and is put in every query of every route: an owner sees every ticket, an admin sees the unrestricted ones, nobody else sees any, and nobody sees a ticket that names them as its excluded account, whatever their role.
A ticket a caller may not see answers 404, never 403, so its existence is not disclosed, and the same predicate guards writes.
Assignment follows the same rule: only an owner who is not the excluded account can hold a restricted ticket, eligibility is rechecked at every assignment, and a stale queue row can only refuse, never widen access.
A queue's restricted flag cannot change while it has tickets that are not closed, because open tickets carry the flag they were created with.
For the same reason a closed or spam ticket whose flag no longer matches its queue's cannot be reopened (409 `restriction_mismatch`); an owner resolves it explicitly.
A queue's open-ticket count, like everything else, counts only tickets the caller may see, and replaying a raw key through the owner reprocess route answers 404 for a ticket the caller may not see.
No rule reads an account's kind or username.

**Administrators are one class.**
A human and an agent holding an admin account have the same access, the same notifications and the same audit trail; every reply and note records the acting account.

**Default assignee, routine replies.**
Ordinary queues resolve by default to the fallback queue's fixed assignee (seeded as the platform's service admin account) when that account exists; otherwise the pool, where any eligible admin takes the ticket.
That account is allowed to send routine replies on its own authority, because a reply that records its actor is attributable and an escalation exists for anything that is not routine.
Restricted queues start unassigned and an owner sets who holds them.

**Escalation.**
Any administrator who can see a ticket can escalate it: it moves to the queue's escalation owner (the fallback queue's if the queue has none), its status becomes `escalated`, and the owner is notified.
The escalation owner must be an owner, and is rechecked as an owner (whatever the ticket's own restriction) and against its exclusion when used, so a ticket that excludes that owner refuses to escalate rather than reach them.

**Notifications.**
A new category, `support_tickets`, opted in by default, follows the existing admin fence: production only unless `DEV_ADMIN_NOTIFICATIONS` is `1`.
A new non-spam ticket notifies its assignee, or when unassigned every opted-in admin who may see it (owners only for restricted, never the excluded account); an escalation notifies the escalation owner.
There is no "if everyone opted out, tell the first admin" fallback, because that would reach someone the ticket is hidden from.
A notification names the ticket reference and subject, escapes them, and never carries the requester's address.
Notification is best effort and never fails ingest.

**Replies that may not have been sent.**
A reply whose provider refused it certainly sent nothing: the route returns a typed error and stores nothing.
A reply whose outcome is unknown (a timeout, an internal error) records an event naming its Message-ID and returns an error telling the administrator not to resend blindly; the message is not stored as sent.
A reply that was sent but could not be recorded writes the same kind of event, best effort, and the failure to write any such event never hides the error.
A header the sender refuses (an over-long or malformed value) is a certain non-delivery, and `References` is trimmed from its oldest end so a long thread still fits.
A reply may carry an idempotency key, stored unique per ticket before the send, because the default assignee may be an agent that retries after a lost response: a repeat of a sent reply returns its stored outcome without sending, a repeat while one is in flight is refused as in progress, and a repeat after an unknown outcome is refused and never re-sent.
A key still pending after 120 seconds is treated as unknown, so a key left pending by a crash becomes permanently unknown: a retry needs a new key, and nothing is re-sent under the old one.
Key rows are kept until their ticket is deleted.
`References` keeps the thread's first Message-ID, the one being replied to and the newest ids that fit.

**Retention.**
Raw messages live in R2 for two years in production and 30 days on staging, by bucket lifecycle rule.
After the same period only a summary of a ticket is kept (epic #1893 phase 6a, #1943).
`MAIL_RETENTION_DAYS` (a Worker variable in the configuration file: 730 in production, 30 on staging) sets the period; a daily purge takes every ticket whose last message is older than the cutoff.
A missing or invalid value deletes nothing, because there is no default that deletes.

*The summary.* The Worker never calls a model.
A summary is written through `PUT /admin/mail/tickets/:id/summary` by whoever may see the ticket, under the same single visibility predicate as every other ticket route, so a person or an agent holding an admin account writes it from the CLI (`nemar admin mail summarize`), and nothing is keyed on account kind or username.
A restricted ticket (security, conduct) is never visible to an admin account, so it is summarized only by an owner, or not at all; no model reads it.
A summary is 1 to 4,000 characters, describes the request and the outcome, and is refused when it contains an email address; names, account ids and quoted message text are asked for in the contract and the help text, not detected.
A later summary replaces an earlier one, and the event records who wrote it, never the text.

*The purge.* Each ticket is purged in one batch: its messages and reply keys are deleted, every event keeps its kind, actor and time but loses its detail, tags other than the queue tag are deleted, and the requester address and subject are cleared.
`requester_email` and `subject` are NOT NULL in the original table, so they hold the empty string, not NULL; the table is not rebuilt for that.
The requester, exclusion and assignee references are nulled, the status becomes `closed`, `purged_at` is set, the summary is kept, and a `purged` event is added.
Clearing the exclusion means an owner it once excluded can now read the kept summary of that ticket; the summary holds no names by rule, and the exclusion exists to keep a person out of the live conversation.
An open ticket past the cutoff is purged too, since its raw record has expired, and is counted separately in the log.
A purged ticket is read-only (409 `ticket_purged`) and a later message to its address opens a new ticket.
The raw keys of purged messages are kept in `mail_purged_raw_keys` (a random id and a date, nothing about the sender) so reprocessing a raw object that outlived its ticket cannot rebuild the conversation.
The purge never touches R2 and never sends mail; it reads and writes only the mail tables of its own environment, which is why it also runs on the non-production daily tick.

**Cascades.**
Ending a person's admin standing (a demotion, a revocation, a soft delete) releases their open tickets to the pool, clears them from queue assignee, backup, escalation and rotation lists, and clears their away window, in the same batch as the statements that already revoke their credentials.
An owner demoted to admin loses only what is restricted, except that the escalation owner setting is cleared whenever the person stops being an owner, in either case, because that setting is owner-only.

## Consequences

Anyone who can administer the platform can be handed support work without a separate tool, and a reply from the team is traceable to an account.
A restricted report is invisible to administrators who are not owners, including its existence, at the cost that owners carry all security and conduct mail.
A flag that cannot change while tickets are open means an owner has to close or drain a queue before restricting it.
Because a ticket reference only routes, a stranger who learns one can add a message to that ticket from an authenticated sender; the message arrives as an inbound message and is read by a person, never acted on.
Release on demotion goes to the pool and not through the queue strategy, so a person's tickets wait for the next claim instead of being re-dealt automatically.
Production holds the inbound bucket binding from this change, but no routing rule delivers to the Worker until the cutover phase, so nothing is received before then.

## Alternatives considered

- **A separate helpdesk product:** it would own its own accounts, notification and exclusion rules, none of which could follow the platform's roles or its fences.
- **403 for a hidden ticket:** it confirms the ticket exists, which for a conduct report is itself disclosure.
- **Cascading a queue's restricted flag to its open tickets:** simpler to call, but it silently changes who can see tickets already being worked; refusing keeps that decision explicit.
- **Re-dealing a removed person's tickets through the queue strategy on release:** needs strategy code inside a revocation batch; the pool is a safe, deterministic answer.
- **Letting the admin API take any from-address:** the binding restricts senders, and one derived address keeps replies threadable.

## Receipts

- ADR 0110 (the mail platform and the raw record in R2).
- Epic #1893, phase 3, issue #1896.
