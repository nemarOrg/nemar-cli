# ADR 0113: Inbound mail is screened cheaply before it reaches a person

**Status:** accepted
**Date:** 2026-10-25
**Owner:** Seyed Yahya Shirazi

Epic #1893 follow-up (#1899).
Builds on [ADR 0110](0110-email-moves-to-cloudflare-email-service.md) (every inbound message is kept untouched in R2) and [ADR 0112](0112-support-tickets.md) (a message is a ticket, and spam is kept and never announced).

## Context

Once the apex catch-all routes every address to the Worker, the support queue receives whatever the internet sends.
Cloudflare Email Routing does no content filtering.
ADR 0112 already files mail that fails authentication as `spam`, but authenticated junk still opened tickets and sent notices: newsletters and list mail, out-of-office replies, bounces, and a single sender sending a flood.
The maintainer approved four small protections, built together, that need no new service.

## Decision

**1. A sender blocklist, refused at delivery and never stored.**
Before anything is written to R2, the Worker checks the envelope sender and every address of the header `From` against `mail_blocklist`.
An entry is one address, or one domain; a domain entry covers its subdomains (blocking `spam.example` also blocks `a.spam.example`).
A match is rejected with the generic reason the Worker already uses, so the sender learns nothing about the list, and no raw object, ticket or message exists afterwards.
A lookup that fails is logged and the message is stored as usual (fail open): real mail is never lost to a database fault.
Domain blocks are refused for our own domain and its subdomains, for a declared list of shared mailbox providers (and their country variants), where one bad sender is not a bad domain, and for public suffixes such as `co.uk` or `edu.au`, where a block would cover every organisation beneath; an address at a provider may still be blocked, and an address at our own domain never.
Adding is idempotent and returns the stored entry.
Marking a ticket spam from the admin route unassigns it, records the actor, and can block the requester's address or domain in the same transaction; a refused block changes nothing, and a ticket purged in the meantime leaves no block.
Blocking acts on the From address, which an unverified message can forge, so for a sender whose first message did not pass DMARC a domain block is refused and an address block needs an explicit `force`.
A block made from a restricted ticket needs an owner.
That route goes through the same visibility predicate as every other ticket route.

**2. Bulk and automatic mail is filed quietly.**
One pure function reads the headers and the envelope sender: a bounce (empty sender, `mailer-daemon` or `postmaster`, a `multipart/report` content type), an automatic reply (`Auto-Submitted` other than `no`, the auto-reply and auto-respond headers, a suppression header naming all or out-of-office), or bulk and list mail (`Precedence` bulk, list or junk, `List-Id`, `List-Unsubscribe`).
The result is stored on the ticket as `filtered`.
A filtered ticket is stored, open and visible, but never assigned and never announced, is hidden from the default list and from the unread badge, and is listed on request.
A filtered message that threads into an existing ticket is appended and nothing else: no notice, and no reopening, status change or reassignment.
Every one of these headers is chosen by the sender, so filing is a convenience and never a security decision, which is why it hides nothing from a person who looks.
`X-Auto-Response-Suppress` is deliberately not read: help desks set it on genuine messages to stop others replying to them.
Spam still wins: a spam ticket carries no `filtered` mark.
A person taking the ticket clears the mark and records an `unfiltered` event with who and why: replying, adding a note, assigning it to someone, setting a status or escalating it (setting a summary does not).
So does a genuine message, one that passes the classifier and the cap and comes from someone on the ticket, threading into it; that message is announced like a new ticket, because until then nobody was told.
The default list hides filtered tickets only in the default view: asking for a status, an assignee or a search shows them.

**3. A cap per sender address per hour.**
`MAIL_SENDER_HOURLY_CAP` (default 20 when unset or invalid) is the number of inbound messages one lowercased From address may send in the previous hour.
At or above it, a message is stored and threaded as usual and filed as `rate_limited`, like the filtered mail above.
The cap is per address, not per domain, so one noisy sender does not silence a whole institution.
Only messages whose DMARC passed are counted, because the From address of any other message can be forged, and forged mail must not be able to push the real sender over the cap.
A reprocess of an old message applies no cap, because today's traffic says nothing about it.

**4. Quiet queues.**
`mail_queues.notify` (default on) turns off the creation notice for tickets in a queue.
It silences creation notices only: tickets are still created, assigned and listed, and an escalation notice still goes out, because an escalation is a human act.
Setting the fallback queue quiet is the operator's way of running the support address as a log until the volume is understood.

## Consequences

- Blocked mail leaves no trace beyond a redacted log line; the blocklist is the record of what was refused and why.
- A genuine message that looks automatic is filed, not lost: it can be listed with the filtered option, and an administrator sees it in the ticket.
  Once a person acts on a filtered ticket, or a genuine message arrives, it is visible again.
- A domain block is broad by design; the refusals above keep it from reaching our own mail or a shared provider.

## If this is not enough

Content scoring is deliberately not built here.
If authenticated junk still gets through, the next step is an open-source content filter (for example rspamd) on a host we run, in front of the Worker, so that the Worker receives only what it passes.
That is a different decision, with a host to operate, and is not made now.
