# Plan: community mail categories, one-click unsubscribe and recalls

Status: draft for the owner, design only (no code, commits, GitHub writes or mail).
Written: 2026-11-20.
Owner request: 2026-11-20.
Grounded in: `nemarOrg/nemar-cli` `origin/dev` at `47a34a1b` (0.10.37-dev0) and `nemarOrg/website` `origin/staging` at `aa9e39f` (0.2.42-dev1).

Abbreviations, each defined once here:
application programming interface (API),
command-line interface (CLI),
Architecture Decision Record (ADR),
NEMAR Request for Comment (RFC, the community process in `nemarOrg/rfcs`),
Internet Engineering Task Force Request for Comments 8058 (RFC 8058, the one-click unsubscribe standard),
Controlling the Assault of Non-Solicited Pornography And Marketing Act (CAN-SPAM),
Federal Trade Commission (FTC),
General Data Protection Regulation (GDPR),
European Union (EU),
DomainKeys Identified Mail (DKIM),
Domain-based Message Authentication, Reporting and Conformance (DMARC),
Sender Policy Framework (SPF),
hash-based message authentication code (HMAC),
Uniform Resource Locator (URL),
Hypertext Transfer Protocol Secure (HTTPS),
JavaScript Object Notation (JSON),
HyperText Markup Language (HTML),
pull request (PR),
continuous integration (CI).

## 1. What the owner asked for

Account holders get community mail in four categories: news, RFCs (a new RFC is open), maintenance announcements, and recalls.
Recalls are mandatory and cannot be unsubscribed.
Every non-recall message carries a footer link that unsubscribes the reader from that category.
There is a public unsubscribe page and an email section in the website's user settings.
The work spans the nemar-cli backend and CLI, and the website.
The first RFC mail (RFC-0001 opening) should use the `rfcs` category if this ships in time.

## 2. Verified facts

Each line below was read on 2026-11-20; paths are on `origin/dev` unless another repository is named.

### 2.1 Today's preference model

- `users.email_preferences` is a nullable TEXT column of JSON; NULL means every notification is on (`backend/src/db/migrations/0015_email_preferences.sql:1-4`).
- `EmailPreferences` has six booleans, five admin alerts plus `announcements` (`backend/src/services/email.ts:287-318`); every default is `true` (`email.ts:320-327`).
- `parseEmailPreferences` reads each key as `!== false`, so a missing key is ON, and corrupt JSON returns all-on with a log line (`email.ts:343-361`).
- `EmailCategory = keyof EmailPreferences`, so `announcements` is today also a legal argument to `getAdminEmailsForCategory`, which falls back to the first admin when all have opted out (`email.ts:416-447`, fallback at `:441`).
- The only preference routes are `GET` and `PUT /admin/email-preferences` (`backend/src/routes/admin/users.ts:1967`, `:1989`), behind `adminMiddleware` (`backend/src/routes/admin/index.ts:57-59`).
  A non-admin account has no way to read or change any preference.
- An owner may edit another account's preferences, an admin only their own (`resolveEmailPrefsTarget`, `routes/admin/users.ts:778-797`); an edit of another account writes an `email_preferences_updated` audit row (`:2019-2028`).
- Deleting an account clears `email_preferences` (`backend/src/db/user-tombstone.ts:82`).
- Every `users` column is classified in `USER_COLUMN_ROLES`, and a test compares it with `PRAGMA table_info(users)` in both directions (`backend/src/services/user-search.ts:60-110`).
- The CLI shows and edits the six keys with `nemar admin email-preferences show|update`, including `--announcements <bool>` (`src/commands/admin.ts:8415-8560`).

### 2.2 Today's broadcast path

- `POST /admin/notify` takes exactly one of `to` (`all`, `admins`, `members`) or `user` (`backend/src/services/broadcast.ts:41-52`; route at `routes/admin/users.ts:2049`).
- A group send selects `status = 'approved' AND deleted_at IS NULL` and keeps rows whose `announcements` is on (`broadcast.ts:131-143`).
  Accounts at `verified` (email proved, no upload access) receive no broadcast today.
- A per-user send ignores preferences by design (`broadcast.ts:147-153`, `routes/admin/users.ts:2043-2047`).
- The mail template's footer is a link to nemar.org and the archive's name, with no unsubscribe link and no postal address (`broadcast.ts:263-285`).
- With `EMAIL_PROVIDER=cloudflare` and the `EMAIL_OUTBOX` queue bound, a send enqueues one message per recipient (`broadcast.ts:499-506`); the message holds `broadcast_id` and `to` only (`broadcast.ts:71-75`).
- The consumer renders the body from the `broadcast_emails` row and calls `sendEmail` with no extra headers (`backend/src/services/email-outbox.ts:176-190`).
- Outcomes are one row per (broadcast, recipient hash), counted once, and the row turns `done` when `delivered + failure + unknown` reaches `queued_count` (`backend/src/services/broadcast-outcomes.ts:36-60`; `migrations/0100_broadcast_queue.sql:23-29`).
  The outcome vocabulary is a CHECK constraint (`delivered`, `failed`, `unknown`, `unqueued`).
- Production and staging both send through the Cloudflare binding (`backend/wrangler-sccn.toml:367`, `:773`), production with Resend as a fallback for limit refusals only (ADR 0110).
- The outbox consumer runs `max_batch_size = 10`, `max_concurrency = 1`, `max_retries = 10` (`wrangler-sccn.toml:534-539`, dev `:674-679`); a limit refusal is retried after `min(300 s x attempts, 3600 s)` (`email-outbox.ts:43-60`).
- Bounces and complaints are stored in `email_delivery_events` for 180 days, and Cloudflare suppresses those recipients itself (ADR 0110; `migrations/0101_email_delivery_events.sql`).
- D1 runs JSON functions in production statements already (`json_insert` in `broadcast-outcomes.ts:52`).

### 2.3 Headers

- `sendEmail` accepts only `In-Reply-To` and `References` as extra headers and refuses anything else before the fence or a provider (`email.ts:568-581`, `:680`, `:741-761`).
- The Cloudflare path separately allows any `List-*` and `X-*` header (`email.ts:689-718`).
- Cloudflare's header reference (read 2026-11-20) allows `List-Unsubscribe` (HTTPS or mailto URIs, plain HTTP refused, "Always DKIM-signed per RFC 8058") and `List-Unsubscribe-Post`, which must be exactly `List-Unsubscribe=One-Click` and requires an HTTPS `List-Unsubscribe`.

### 2.4 Fences and rules this feature must keep

- Delivery fence: outside `ENVIRONMENT = "production"` a recipient must be on `DEV_EMAIL_ALLOWLIST`, and an unknown environment refuses (`email.ts:229-248`); `sendBroadcast` filters recipients through the same predicate before anything is built (`broadcast.ts:488-497`).
- Admin notification mail is production-only through `isAdminNotificationAllowed` (`email.ts:395-399`).
- AGENTS.md: dev D1 `users` holds roughly 609 real addresses behind live mail credentials; `DEV_EMAIL_ALLOWLIST` holds exact human addresses, never a domain; a new daily cron is production-only by default.
- `.rules/revocation.md`: ending a credential ends everything minted from it, and the callers named in `services/docs-auth.ts` and `services/private-auth.ts` are load-bearing counts.
- ADR 0045: account sentences live in `shared/contract/account-copy.ts`, transcribed to `website/src/lib/account-copy.ts`, with a text drift test on each side; every value is a literal string, placeholders are `{name}`, keys without a `cli.` prefix are mirrored.
- ADR 0103: a new writer of `email_verified` goes through `applyEmailVerification`; this plan writes neither `email_verified` nor `status`.
- ADR 0113: inbound auto-replies, bounces and list mail are filed as `filtered` and never announced, which absorbs the out-of-office replies a broadcast provokes.
- The API is mounted at both `/` and `/nemar` (`backend/src/index.ts:423-424`), so a path-matching middleware must be proven at both.
- `/users/*` runs `authMiddleware`, which accepts the CLI's bearer key and the website's session cookie (`backend/src/routes/users.ts:1-12`, `:43`); the cookie path checks the `Origin` allow-list (`backend/src/middleware/auth.ts:547`).
- HMAC tokens elsewhere are domain-tagged, carry no clock, and take validity from a row, compared in constant time (`backend/src/services/compute-tokens.ts:1-125`; `backend/src/lib/constant-time.ts:22`).
- Reply-to is `support@nemar.org` (`wrangler-sccn.toml:361`), so a reply to community mail becomes a support ticket (ADR 0112).

### 2.5 Website

- `nemarOrg/website`'s default branch is `main`; feature PRs target `staging`, the integration branch, and a merge there does not auto-close issues (checked with `gh api` on 2026-11-20; memory note `website-staging-pr-no-autoclose.md`).
  The brief called `staging` the default branch; it is the integration branch.
- A release runs Prepare release on `staging` before the `staging` to `main` PR (memory note `website-release-prepare-first.md`; website `AGENTS.md` step 8).
- `src/pages/settings.astro` (2,425 lines) has cards for account, ORCID iD, profile, upload access, CLI keys, appearance, privacy (`:844`) and sign out; no card touches mail preferences (a grep for `email_preferences`, `announcements` and `unsubscribe` in `src/` finds none).
- Settings mutations go through same-origin proxies such as `/api/auth/profile` (`settings.astro:1789`; `src/pages/api/auth/profile.ts` calls `forwardAuthMutation`), and the generic `/api/v1/[...path]` proxy forwards the cookie and `Origin` to the API (`src/pages/api/v1/[...path].ts:1-45`).
- Server-side calls go through `apiFetch`, over the API service binding where present, with the visitor in `X-Forwarded-For` (`src/lib/api-fetch.ts:1-25`; nemar-cli ADR 0098).
- The site loads Umami analytics from `analytics.nemar.org` (`src/middleware.ts:80`, `:305`), so a page whose URL holds a token must not load it.
- Hand copies of nemar-cli contracts with drift tests already exist (`mail-admin-contract.ts`, website `AGENTS.md:94`); tests are Vitest (`bun run test`), lint is Biome, type checking is `astro check`.

### 2.6 Policy text in force

- The privacy policy (`https://docs.nemar.org/policies/privacy.md`, effective 2026-11-11, read 2026-11-20) lists the purpose "To contact you about your account and datasets: verification, approval, publication review, and service notices. Non-essential notifications respect your email preferences."
- It names the right to "object to non-essential email, or adjust your notification preferences directly."
  For a non-admin account that second promise has no route behind it today (2.1).
- It says NEMAR does not use personal information for advertising.
- Issue nemarOrg/nemar-cli#1077 (GDPR alignment) is open and holds "Confirm notification emails respect the existing email-preferences settings in all admin notify paths" and a signup-consent item.

### 2.7 External rules, checked 2026-11-20

- FTC, "CAN-SPAM Act: A Compliance Guide for Business": a commercial message must explain how to opt out; the opt-out may require nothing beyond a reply email or a visit to a single web page, no fee and no personal information beyond the address; it must work for at least 30 days after sending and be honored within 10 business days; a menu of choices must include stopping all marketing mail; the message must carry a valid physical postal address; each violating message can draw a penalty of up to $53,088.
- The same guide classes as transactional or relationship content a message that "gives warranty, recall, safety, or security information about a product or service the recipient bought" or that notifies "a change in the terms or features of a membership, subscription, account," and says these categories are read narrowly; such messages are exempt from most provisions.
- The FTC guide does not mention one-click unsubscribe.
  One-click comes from mailbox providers: Gmail's sender guidelines (in effect since 2024-02-01) require marketing and subscribed mail from senders of more than 5,000 messages a day to Gmail accounts to support one-click unsubscribe (RFC 8058) and show a visible unsubscribe link in the body; Gmail's FAQ says transactional mail is excluded, recommends honoring requests within 48 hours, and says a sender that reaches the bulk threshold once is a bulk sender permanently.
  Gmail also asks bulk senders for SPF, DKIM and DMARC (a `p=none` policy is enough) and a spam rate under 0.30% (target under 0.10%).
- RFC 8058 (January 2017, Standards Track): `List-Unsubscribe` must contain one HTTPS URI; `List-Unsubscribe-Post` must be exactly `List-Unsubscribe=One-Click`; a valid DKIM signature must cover both headers; the URI should carry a hard-to-forge component; the one-click POST carries no cookies or authorization, its body is `List-Unsubscribe=One-Click` as `multipart/form-data` or `application/x-www-form-urlencoded`, and the sender must not answer it with a redirect.
- GDPR Article 21(2) and (3): a person may object at any time to processing for direct marketing, after which the data is no longer processed for it; 21(4) requires the right to be presented clearly and separately.
- Directive 2002/58/EC (ePrivacy) Article 13(1) requires prior consent for electronic mail for direct marketing; 13(2) allows mail to existing customers about the sender's own similar products or services, met "in the context of the sale," if they can object easily at collection and in each message.
- Cloudflare Email Service limits: new accounts start with a conservative daily quota raised through a request form, sends to verified destination addresses do not count, and the guidance is to honor opt-outs promptly.
- DNS for `nemar.org` (queried 2026-11-20): DMARC `p=none` with Cloudflare aggregate reports; SPF includes Cloudflare.

### 2.8 Timing

- `nemarOrg/rfcs` was created 2026-11-20 and holds only a README.
- Epic nemarOrg/nemar-cli#2239 (RFC program) puts opening RFC-0001 (owner step O5) behind steps B4, B6, O4b, O1b, S1 and N1 and two open questions; only V1 is in review.
- Its plan says, at O5, "Broadcast mail is production-only and honors the `announcements` preference" (`origin/feature/rfc-program:.context/rfc-program/plan.md:270`); that sentence needs updating if this ships first.

## 3. Inferences and gaps (not verified)

- NEMAR is a non-commercial research archive, so much of its mail may not be a "commercial message" under CAN-SPAM's primary-purpose test; the design complies anyway, because the cost is small and Gmail's rules apply regardless.
  This is not legal advice; decision D11 asks whether the university's privacy office should read the news default and the policy text.
- Whether ePrivacy's existing-customer exception covers a free account is uncertain; the conservative reading treats news as needing consent for accounts created from now on.
- Production's account count is not measured here; dev D1's roughly 609 addresses suggests production is in the high hundreds or low thousands, well under Gmail's 5,000-a-day threshold.
- Cloudflare's own documentation says `List-Unsubscribe` is always DKIM-signed; the plan still measures the `h=` tag on a real staging message, because Gmail ignores one-click headers outside the signature.
- Whether a send to a Cloudflare-suppressed address returns a distinct error code is unknown; the staging canary records what it returns.
- ADR number 0127 is absent on `origin/dev` and from its index; the next free number is 0130 on dev today, but an open branch may hold 0127 or 0130 (ADR-number races, memory note `conflicting-pr-stops-ci.md`).

## 4. Design

### 4.1 The categories, declared once

A new module `shared/contract/mail-categories.ts` declares the community categories as data, the arrangement ADR 0032 and ADR 0045 use elsewhere.

| id | can be turned off | existing accounts | new accounts | who receives it | who may send it |
|---|---|---|---|---|---|
| `news` | yes | carried over from `announcements` | off until chosen (D1) | `person` accounts at `verified` or `approved` | admin |
| `rfcs` | yes | carried over from `announcements` | on | `person` accounts at `verified` or `approved` | admin |
| `maintenance` | yes | carried over from `announcements` | on | `person` and `service` accounts at `verified` or `approved` | admin |
| `recall` | no | always | always | `person` and `service` accounts at `verified`, `approved` or `revoked` (D3) | owner only |

Every audience also requires `deleted_at IS NULL` and `email_verified = 1`, and never includes `pending` or `test` accounts.
The audience rules are one function, `communityRecipients(db, category, group)` in a new `backend/src/services/mail-recipients.ts`, the only place a categorized send selects people.
`--to admins` and `--to members` narrow that audience by role; they never widen it.

Labels and one-line descriptions ("News: new features, data and events") are account sentences, so they go into `shared/contract/account-copy.ts` under `mail.category.<id>.label` and `mail.category.<id>.description`, with `mail.recall.why` for the sentence that explains why recalls cannot be turned off.
The website transcribes them; the website also hand-copies the category table with a drift test, as it does for `mail-admin-contract.ts`.

The admin alerts (`user_approval`, `publication_request`, `dataset_anonymity`, `identifier_sweep`, `support_tickets`) stay as they are.
The type splits into `AdminAlertCategory` and `CommunityMailCategory`, and `getAdminEmailsForCategory` takes only the former, so no community category can reach the first-admin fallback.

### 4.2 Storage and the migration

Storage stays in `users.email_preferences`: one column, one parser, already cleared on deletion, already classified `omit`.
The keys become `news`, `rfcs` and `maintenance`; `recall` is never stored, because nothing may turn it off.
`announcements` is retired as a stored key.

The parser keeps `!== false` for the admin alerts and for `rfcs` and `maintenance`.
For `news` it reads a missing key as the new-account default (off, if D1 goes that way).
That is safe only because the migration writes an explicit `news` value on every existing live row, so "missing" means "created after the migration."

Migration `01NN_mail_categories.sql` (number taken at branch time; 0146 is next on dev today), in outline:

```sql
-- Existing live rows: carry announcements into the three categories, explicitly.
UPDATE users
   SET email_preferences = json_remove(json_set(
         CASE WHEN email_preferences IS NOT NULL AND json_valid(email_preferences)
              THEN email_preferences ELSE '{}' END,
         '$.news',        json(CASE WHEN json_valid(email_preferences)
                                     AND json_extract(email_preferences, '$.announcements') IS 0
                                    THEN 'false' ELSE 'true' END),
         '$.rfcs',        json(...same expression...),
         '$.maintenance', json(...same expression...)),
       '$.announcements')
 WHERE deleted_at IS NULL;

ALTER TABLE broadcast_emails ADD COLUMN category TEXT
  CHECK (category IS NULL OR category IN ('news', 'rfcs', 'maintenance', 'recall'));
ALTER TABLE broadcast_emails ADD COLUMN recall_reference TEXT;
ALTER TABLE broadcast_emails ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
-- broadcast_outcomes is rebuilt to add 'skipped' to its CHECK (no inbound foreign keys).
```

A corrupt JSON row already parses as all-on today, so replacing it with explicit keys loses nothing.
`json_extract` returns `0` for JSON `false`, which the `IS 0` test relies on; Bun's SQLite is more lenient than D1 (memory note `bun-test-lenient-vs-workerd.md`), so the migration is also applied with `wrangler d1 migrations apply --local` before review.
Existing `broadcast_emails` rows keep `category` NULL, which means a legacy, uncategorized send.

Every change to a community category writes an audit row in the same batch: action `mail_category_changed`, details `{category, on, via}` with `via` one of `settings`, `cli`, `one_click`, `link`, `link_all`, `admin`, `migration` (the migration writes one summary row with counts, not one row per user).
That is the consent record GDPR expects a controller to be able to show.

### 4.3 Consent rules the code enforces

1. Every non-recall message carries a visible footer link and the RFC 8058 headers for its category, and a send that cannot mint them is refused (no footer, no send).
2. An unsubscribe takes effect in the request that makes it; the outbox consumer re-reads the preference before each send, so a message already queued for that person is skipped (well inside Gmail's 48 hours and the FTC's 10 business days).
3. The link needs no sign-in, no fee and nothing beyond the click (CAN-SPAM's single-page rule); one-click works with no page at all (RFC 8058).
4. The page offers "this category" and "all non-recall mail" (CAN-SPAM's menu rule).
5. Nobody turns a category ON for someone else: the owner and admins may turn one off for another account on request (D8), never on.
6. Non-recall footers carry the postal address the owner supplies (D7).
7. `List-Unsubscribe` carries the HTTPS URI only, no `mailto:`, because inbound mail becomes support tickets and a mailto unsubscribe would open one per click.

### 4.4 Recalls

**Definition (proposed text for the ADR and the docs page).**
A recall tells account holders to stop using, delete or replace something NEMAR distributed or issued, because continuing to use it can cause harm.
It is exactly one of:

- a privacy recall: a dataset version or file that exposed personal or identifying information (a scrub under ADR 0085, an unpublish under ADR 0125);
- an integrity recall: a dataset version or derivative whose content is materially wrong (corrupted files, wrong sampling rate, mislabeled channels or participants) in a way that invalidates analyses, with the affected versions named;
- a security recall: a CLI release, credential or token NEMAR issued that has a defect requiring action (upgrade, rotate a key).

A recall is never: maintenance or downtime, a policy or terms change, news, an RFC, a request for feedback, a reminder, or anything promotional, and it carries no content beyond the recall.

**Guards in code.**

- Only the `owner` role may send `category: "recall"` (403 for an admin).
- A recall needs `recall_reference`: a dataset id with version, a `nemarOrg` issue or security advisory URL, or a ledger entry id; the backend checks its shape and, for a dataset id, that the dataset exists.
- The subject is prefixed `[NEMAR recall]`, and the body must contain the headings "What is affected" and "What to do"; the backend refuses a body without them.
- The CLI previews the audience count and requires typing the reference back (`--confirm-recall <reference>`) in addition to the usual confirmation.
- A recall is also published as a site notice, so the record is public and misuse is visible (D4).
- The recall footer says why it cannot be turned off (`mail.recall.why`) and links the definition on docs.nemar.org; it carries no unsubscribe link and no `List-Unsubscribe` header.

Cloudflare suppresses addresses that bounced or complained (ADR 0110), so a recall cannot reach them either; the recall's status view counts those failures so the owner knows.

### 4.5 Unsubscribe links

**Format.** One path segment, used in both the header and the footer:

```
https://api.nemar.org/mail/unsubscribe/v1.<user id>.<category>.<broadcast id>.<signature>
signature = base64url(HMAC-SHA256(MAIL_LINK_SECRET,
  "mail-unsubscribe\nv1\n<user id>\n<category>\n<broadcast id>\n<lowercased, trimmed address>"))
```

The first line is a domain tag no other token kind uses, the pattern in `services/compute-tokens.ts`.
The address is inside the signature and never in the URL.
The category can only be `news`, `rfcs` or `maintenance`: the signer refuses `recall`, and so does the verifier.

**Verification.** Parse strictly; read the account (`id = ? AND deleted_at IS NULL`) and the broadcast row (`id = ? AND category = ?`); recompute with the account's current address under `MAIL_LINK_SECRET`, then under `MAIL_LINK_SECRET_PREVIOUS` when that is set; compare in constant time.
Every failure gets the same answer (`410`, `link_invalid`), so the route says nothing about which part failed.

**What a valid link can do.** Exactly one write: turn its category off, or, from the page's second button, turn all three community categories off.
It cannot turn anything on, read any other preference, or show more than the category and a masked address (`a***@example.org`).
It is single-purpose, which is why it needs no session.

**Lifetime (D5).** No clock in the token.
A link works while the account is live, its address is unchanged and the broadcast row exists, which meets CAN-SPAM's 30-day minimum and keeps old messages unsubscribable (an expired link pushes people to the spam button, which costs reputation).
Changing the address ends every link sent to the old one with no new code, because the address is in the signature.
Deleting the account ends them too, because the tombstone masks the address and sets `deleted_at`.

**Secrets.** `MAIL_LINK_SECRET` is a new Worker secret, different in dev and production, so a production link presented to staging fails.
Rotating it ends every link in every mailbox at once; `MAIL_LINK_SECRET_PREVIOUS` lets a rotation keep old links working until the owner removes it.
A categorized send with the secret unset is refused (`mail_link_secret_unset`) before anything is queued.

**Revocation rules.**
The link is not a credential: it is minted from a server secret and the account's address, not from an API key or a session, it authenticates no request and opens no session.
So it is not added to the caller counts in `services/docs-auth.ts` or `services/private-auth.ts`, and a key revocation, a role demotion or a sign-out deliberately leaves it working (unsubscribing is always the person's right).
`tombstoneUserCascade` and an email change end it by construction; a test pins both.
A revoked account's links keep working for the same reason; revoked accounts receive only recalls (D3).

**Leaks.** A token in a URL reaches Worker logs and could reach analytics, so: the website page loads no analytics and sends `Referrer-Policy: no-referrer` and `noindex`; the backend logs the route without the token segment.
The worst a leaked link does is turn one category off for one person, who can turn it back on in settings.

### 4.6 Backend routes

| Route | Auth | Does |
|---|---|---|
| `GET /mail/unsubscribe/:token` | the token | No side effect (mail scanners prefetch links). Phase 2: a minimal API-served confirmation page with two buttons. Phase 5: a 303 redirect to `${APP_BASE_URL}/unsubscribe/<token>` once that page is live in production. |
| `GET /mail/unsubscribe/:token/info` | the token | JSON `{category, label, masked_email, on}` for the website page; no side effect. |
| `POST /mail/unsubscribe/:token` | the token | Body `List-Unsubscribe=One-Click` (either content type): turns the token's category off, answers `200`, never a redirect, no cookie read. A form body `scope=all` turns all three off. Idempotent. |
| `GET /users/me/email-preferences` | bearer key or session cookie | The three community categories plus `recall: {on: true, locked: true}`. |
| `PUT /users/me/email-preferences` | bearer key or session cookie (cookie path checks `Origin`) | Sets `news`, `rfcs`, `maintenance`; refuses `recall` and every admin alert. |
| `GET`/`PUT /admin/email-preferences` | admin | Unchanged for admin alerts; the community keys follow 4.3 rule 5 for `?user=`; `announcements` in a PUT is refused with `announcements_retired` naming the new flags. |
| `POST /admin/notify` | admin; owner for `recall` | A group send must name `category`; see 4.7. |
| `GET /admin/notify/:id` | admin | Adds `category`, `recall_reference` and `skipped_count`. |

The new public router mounts at `/mail` and is tested at `/mail/...` and `/nemar/mail/...` (memory note `api-mounted-twice-full-path.md`).
It sits in the rate limiter's unauthenticated bucket (ADR 0098 and 0099); a refusal there must not look like `link_invalid`.

### 4.7 The broadcast path per category

1. `broadcastRequestSchema` gains `category` (required with `to`, refused with `user`) and `recall_reference`.
   A per-user send stays preference-free direct contact.
2. Recipients come from `communityRecipients` (4.1); the existing `getBroadcastRecipients` is retired with the `announcements` key.
3. A categorized send requires the outbox (Cloudflare provider and `EMAIL_OUTBOX` bound) and is refused otherwise (`outbox_required`); production and staging both have it, and one path is one thing to test.
4. A duplicate guard refuses a second send with the same category and subject within 24 hours unless `allow_repeat` is set, against a re-run command mailing everyone twice.
5. Dry run answers counts per audience term and a redacted sample of three; outside production it never returns the address list (dev D1 holds real addresses).
6. Enqueue writes the row with `category` first, then one message per recipient carrying `user_id` as well as `to`.
7. The consumer, per message: reads the account and its preferences; if the account is gone, the address changed, or the category is now off, it records `skipped` and sends nothing; otherwise it signs the link, renders the category footer, and calls `sendEmail` with
   `List-Unsubscribe: <https://api.nemar.org/mail/unsubscribe/...>`,
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
   and `List-Id: <category>.mail.nemar.org` (cheap, and lets people filter).
   A recall gets the recall footer and none of those headers.
8. `ALLOWED_MAIL_HEADERS` grows to those three, with value checks: `List-Unsubscribe` must be exactly one `<https://...>` URI on the API's own origin, and `List-Unsubscribe-Post` exactly the RFC 8058 string.
   The Resend fallback inside `sendEmail` passes the same headers, so a limit fallback keeps one-click.
9. Outcomes gain `skipped` with its own counter in every `DONE_WHEN_COMPLETE` sum, so a row still reaches `done`.
10. A message without `user_id` (queued before the deploy) belongs to a legacy row and is sent as today.

### 4.8 CLI

User commands, under the existing `nemar auth` group:

- `nemar auth mail` (alias `show`): the four categories with on or off, recall shown as always on with `mail.recall.why`.
- `nemar auth mail set <news|rfcs|maintenance> <on|off>`, and `nemar auth mail set all off`.

Admin commands:

- `nemar admin notify --to <all|members|admins> --category <news|rfcs|maintenance|recall> --subject ... --body-file ...`; `--recall-ref <reference>` and `--confirm-recall <reference>` for a recall (owner only); `--allow-repeat`; `--dry-run` prints counts.
- `nemar admin notify --status <id>` shows category, skipped and the rest as today.
- `nemar admin email-preferences show|update` gains `--news`, `--rfcs`, `--maintenance`; `--announcements` is removed and an old flag prints which flags replace it.
  With `--user`, only `false` is accepted for community categories.

### 4.9 Website

- `src/pages/unsubscribe/[token].astro`: public, server-rendered from `GET /mail/unsubscribe/:token/info` through `apiFetch`; shows the category and masked address and two buttons ("Unsubscribe from RFCs", "Unsubscribe from all NEMAR community mail"); never acts on load.
  Each button posts to a dedicated same-origin endpoint `src/pages/api/mail/unsubscribe.ts`, which forwards to `POST /mail/unsubscribe/:token` (with `scope=all` for the second).
  The page loads no analytics, sends `no-referrer` and `noindex`, explains that recalls cannot be turned off, and links `/settings` for everything else.
  An invalid link renders one sentence and the settings link.
- `src/pages/settings.astro`: an "Email" card before "Privacy": three toggles from `GET /users/me/email-preferences` through the `/api/v1` proxy, saved with `PUT`, and a locked "Recalls: always on" row; labels and descriptions from the transcribed account copy.
- `src/lib/account-copy.ts` gets the `mail.*` keys; `src/lib/mail-categories.ts` is the hand copy of the shared category table with `test/mail-categories-drift.test.ts`.
- If D1 makes news opt-in, `src/pages/onboarding.astro` gets one unchecked "Send me NEMAR news" box.

### 4.10 Docs and policy (`nemarOrg/docs`)

- A public page defining the four categories, with the recall definition from 4.4 (the recall footer links it).
- The privacy policy's purposes list adds community mail (news, RFCs, maintenance) and recalls, says how to turn each off, and keeps the "no advertising" sentence true; it must be live before the first categorized send (memory note `no-liability-ethical-responsibility-stance.md`: policy text matches what is built).
- CLI reference pages for `nemar auth mail` and `nemar admin notify --category`, and an admin runbook: dry run, internal canary to `--to admins`, then the real send; and the recall procedure.

### 4.11 Sending limits

- Pace is set by the outbox: batches of 10, one batch at a time, limit refusals deferred 5 to 60 minutes with ten retries; a send to about a thousand people may take hours, and `--status` shows it.
- Before the first large categorized send, the owner confirms the Cloudflare daily quota in the dashboard (ADR 0110 tied production to a raised quota; its current value is not in the repository).
- Policy, not code: at most one news mail a week; RFC mail at an RFC's opening (and optionally one "closes in 3 days" reminder); maintenance as needed; recalls as needed.
- Treat NEMAR as a bulk sender for Gmail now (one-click, DMARC already published, low complaint rate) rather than discovering the threshold later.

### 4.12 Dev-safety rules

1. Every categorized message goes through `sendBroadcast`'s fence at enqueue and `sendEmail`'s fence in the consumer; nothing new bypasses `isEmailDeliveryAllowed`.
2. No new cron. If an RFC reminder job is ever added, it is production-only by default in `scheduled()`.
3. Dry run outside production returns counts, never addresses.
4. Separate `MAIL_LINK_SECRET` per environment; staging links point at `api-test.nemar.org` (`wrangler-sccn.toml:717`, `:722`).
5. The migration also rewrites dev D1's copies of real people's preferences; that sends nothing and touches no production row (AGENTS.md and ADR 0009 forbid re-seeding production `nm` and `ds` rows into dev D1, which this does not do).
6. Tests use `.test` addresses on a fresh database; staging walk-throughs mail only the owner's exact allow-listed address.
7. Owner-only secret writes are handed to the owner as one-line commands (memory note `classifier-blocks-remote-secret-writes.md`).

## 5. Tests and gates

No business logic is replaced.
The Cloudflare `send_email` binding is the recorder in `backend/test/helpers/cloudflare-email.ts` and the queue batch is `helpers/queue-binding.ts`, both external boundaries as in `email-outbox.test.ts`; the database is the real migrated schema (`helpers/d1.ts`, `freshDb` and `realD1`); Resend errors use HTTP fixtures only.

| Test file (new unless noted) | Proves |
|---|---|
| `test/mail-categories.unit.test.ts` | The table: recall cannot be turned off, defaults, audience terms; every category has its account-copy keys. |
| `backend/test/mail-categories-migration-d1.test.ts` | Seeded rows (NULL, `announcements: false`, `true`, corrupt JSON, deleted) end with the right three keys and no `announcements`; legacy broadcast rows read as NULL category. |
| `backend/test/mail-recipients-d1.test.ts` | Status by kind by preference by deletion, per category and group; `pending`, `test` and deleted accounts never appear; revoked only for recall. |
| `backend/test/mail-links.unit.test.ts` | Domain tag; each field tampered fails; recall refused at signing and verifying; address change fails; previous secret verifies; malformed input fails. |
| `backend/test/mail-unsubscribe-route-d1.test.ts` | Through the real app at both mounts: GET changes nothing; one-click POST in both content types answers 200 with no `Location`, no cookie needed; `scope=all`; idempotent; uniform 410; deleted account and changed address refused after `tombstoneUserCascade` and an email change; audit rows. |
| `backend/test/broadcast-category-d1.test.ts` | Exact header strings; footer link equals the header URL and verifies; recall has no header and no link and carries the recall footer; admin recall 403; missing reference or headings refused; unsubscribe between enqueue and consume gives `skipped` and the row reaches `done`; legacy messages unchanged; dev fence suppression; dry run returns no addresses outside production; duplicate guard. |
| `backend/test/email-prefs-target.test.ts` (extended) | `?user=` may turn community categories off, never on; `announcements` refused. |
| `backend/test/users-mail-prefs-route-d1.test.ts` | Bearer and cookie paths, `Origin` check on the cookie path, recall and admin keys refused. |
| `test/account-copy-parity.test.ts` (existing) | The `mail.*` keys match the website's transcription when both checkouts are present. |
| CLI tests for `auth mail` and `admin notify --category` | Argument validation and rendering against a `Bun.serve` stand-in API on a provably fake host (memory note `standin-backend-must-not-name-real-repo.md`). |
| Website `src/lib/mail-prefs-api.test.ts`, `test/mail-categories-drift.test.ts` | Response parsing and the hand copy's drift. |

Mutation checks before each phase's review (memory notes `test-entry-point-not-callee.md`, `mutate-in-the-dangerous-direction.md`): make GET write, drop the recall refusal, widen the audience to `pending`, remove the consumer's re-check, and add a redirect to the POST; each must fail a test, and each mutant must be confirmed applied.

Gates per phase: `bun run typecheck`, `bun run lint`, the targeted test files, `bun test test/adr-index.unit.test.ts` when an ADR moves, and the migration applied with `bunx cfman wrangler --account sccn d1 migrations apply <dev database> --local -c backend/wrangler-sccn.toml`.
The full `bun test` (about 80 minutes) runs only at the epic's merge into `dev`.
Website gates: `bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`.

Real-provider checks, possible only after the epic reaches `dev` (memory note `dev-worker-deploys-only-from-dev.md`):
one categorized send on staging to the owner's allow-listed Gmail address;
read its `DKIM-Signature` and confirm `h=` covers `List-Unsubscribe` and `List-Unsubscribe-Post`;
click Gmail's own Unsubscribe and confirm a `one_click` audit row;
open the footer link and confirm nothing changed until a button is pressed.

## 6. Phases for `/project:epic-dev`

The epic branch comes from `origin/dev`; phase PRs squash-merge into it; the epic merges into `dev`; the release is the usual `dev` to `main` PR with its own review.
Website PRs target `staging` and are closed by hand.

**P1. Categories, storage and migration.**
Goal: categories declared once, stored and parsed, admin alerts split from community mail, the ADR written.
Files: `shared/contract/mail-categories.ts` (new), `shared/contract/account-copy.ts`, `backend/src/db/migrations/01NN_mail_categories.sql` (new), `backend/src/services/email.ts`, `backend/src/services/mail-recipients.ts` (new), `backend/src/services/broadcast-outcomes.ts`, `backend/src/routes/admin/users.ts` (preference schema and `?user=` rule), `src/lib/api/admin.ts`, `src/commands/admin.ts` (`email-preferences`), `.context/decisions/01NN-community-mail-categories-and-recalls.md` plus the index; a website PR to `staging` transcribing the `mail.*` copy keys (ADR 0045's same-breath rule).
Tests: the first three rows of section 5 and the extended prefs-target test.
Gates: section 5 gates plus the local D1 migration.

**P2. Unsubscribe links and the public routes.**
Goal: a signed, single-purpose link that unsubscribes without signing in, by one-click POST or by page.
Files: `backend/src/services/mail-links.ts` (new), `backend/src/routes/mail.ts` (new, with the interim confirmation page), `backend/src/index.ts` (mount), `backend/src/middleware/rateLimit.ts`, `backend/src/types/bindings.ts` (`MAIL_LINK_SECRET`, `MAIL_LINK_SECRET_PREVIOUS`), `backend/wrangler-sccn.toml` (secrets comment only).
Tests: `mail-links.unit.test.ts`, `mail-unsubscribe-route-d1.test.ts`.
Owner step: set both secrets' first value on dev and production (one-liners in the PR body).

**P3. Category broadcasts.**
Goal: `nemar admin notify --category` sends each recipient a footer and headers of their own, honors an unsubscribe until the moment of sending, and enforces the recall rules.
Files: `backend/src/services/broadcast.ts`, `backend/src/services/email.ts` (header allowlist), `backend/src/services/email-outbox.ts`, `backend/src/services/mail-footer.ts` (new), `backend/src/routes/admin/users.ts` (notify and status), `src/lib/api/admin.ts`, `src/commands/admin.ts` (`notify`).
Tests: `broadcast-category-d1.test.ts`, existing `broadcast-queue.test.ts`, `email-outbox.test.ts` and `admin-notify-status-route.test.ts` kept green, CLI `notify` tests.

**P4. Self-service preferences.**
Goal: every account reads and sets its community categories from the CLI and the API, which makes the privacy policy's "adjust your notification preferences directly" true.
Files: `backend/src/routes/users.ts`, `src/lib/api/` (users client), `src/commands/auth.ts` (`auth mail`).
Tests: `users-mail-prefs-route-d1.test.ts`, CLI `auth mail` tests.

**P5. Website: unsubscribe page and settings card.**
Goal: the public page and the settings card; then the API's GET switches to a redirect.
Files (website, PR to `staging`): `src/pages/unsubscribe/[token].astro`, `src/pages/api/mail/unsubscribe.ts`, `src/lib/mail-prefs-api.ts`, `src/lib/mail-categories.ts`, `src/pages/settings.astro`, `src/middleware.ts` (no analytics on `/unsubscribe`), `src/pages/onboarding.astro` if D1 is opt-in; then nemar-cli `backend/src/routes/mail.ts` (GET redirect).
Order: the redirect PR merges only after the website release is in production and `https://app.nemar.org/unsubscribe/<invalid token>` renders its sentence (the trap in memory note `docs-gate-needs-website-in-prod-first.md`).
Tests: website unit and drift tests; the page checked against a preview deploy; the redirect route test.

**P6. Docs and policy.**
Goal: the category and recall pages, the privacy policy update, CLI references and the runbook, live before the first categorized send.
Files: `nemarOrg/docs` pages under `policies/` and the CLI and admin sections.
Gates: docs build; a seams review of docs against `--help` and the account copy (memory note `seams-review-finds-hand-kept-copies.md`).

Dependencies: P2 and P4 need P1; P3 needs P1 and P2; P5 needs P2 (page) and P4 (card); P6 can start with P1.

### 6.1 Minimum shippable slice

P1, P2 and P3, plus the privacy-policy part of P6, released to production with both secrets set.
That sends the RFC-0001 mail as `nemar admin notify --to all --category rfcs`, with one-click headers and a footer link to the API's own confirmation page.
P4 and P5 follow; until then a person can still unsubscribe from any message, and turning a category back on is a support request.
Every link sent before P5 keeps working after it, because the URL in each message is the API's, which then redirects.

### 6.2 If the slice is not in production when RFC-0001 opens

Send through today's path (`nemar admin notify --to all`, approved accounts with `announcements` on), as the RFC plan's O5 already says, and add one sentence to the body: "To stop receiving NEMAR announcements, reply to this message with the word unsubscribe."
Replies arrive as support tickets (ADR 0112), and an owner turns `announcements` off with `nemar admin email-preferences update --user <name> --announcements false`; the migration then carries that choice into all three categories.
Either way, the RFC program's N1 drafts and its O5 sentence should name the path actually used; that edit belongs to epic #2239, not this one.

## 7. Owner decisions

D1. **News for new accounts.** Recommend opt-in (off until the person turns it on, with an unchecked box at onboarding), the conservative reading of ePrivacy Article 13; RFC and maintenance mail stay on by default because they concern the service itself.
D2. **Existing accounts.** Recommend carrying today's `announcements` value into news, RFCs and maintenance, which continues what people already receive; the first news mail after launch says in its first lines how to turn news off.
D3. **Audiences.** Recommend the table in 4.1: community mail to `verified` and `approved` persons (wider than today's approved-only), maintenance also to service accounts, recalls also to service and revoked accounts (a revoked person may still hold recalled data), never `pending`, `test` or deleted.
D4. **Recall definition and sender.** Recommend the definition in 4.4, owner-only sending, a required reference, the fixed headings, typed confirmation, and a site notice for every recall.
D5. **Link lifetime.** Recommend no clock: valid while the account, its address and the broadcast exist, ended by an address change or deletion, with a previous-secret slot for rotation; the alternative is a 365-day expiry.
D6. **One-click scope.** Recommend that one-click turns off only the message's category and the page offers "all non-recall mail" as a second button.
D7. **Postal address.** CAN-SPAM requires one in commercial mail; recommend the lab's university mailing address in every non-recall footer (the owner supplies the exact text).
D8. **Turning someone else's mail off.** Recommend that the owner and admins may turn a community category off for another account (a support request), nobody may turn one on for another, and every such change is audited.
D9. **Shipping order.** Recommend the minimum slice in 6.1 with the API's interim page, and the fallback in 6.2 if RFC-0001 opens first.
D10. **Policy and terms changes.** Recommend sending them as maintenance plus a site notice, not as recalls, even though CAN-SPAM would treat a terms change as transactional; this keeps the mandatory category narrow.
D11. **Legal read.** Recommend asking the university's privacy office to read D1, D2 and the policy text in parallel with P1 to P3, without blocking the `rfcs` and `maintenance` categories.


### 7.1 Owner answers, 2026-11-20 (these override the recommendations above)

- D1: news is a **monthly newsletter, on by default with opt-out**, and can be sent more often when needed. Each issue is an automatic, curated listing of the month at NEMAR (for example new and updated datasets, open RFCs, releases). It is drafted with the Claude API the way the nemarDatasets `.github` PR review already calls it, and a person approves it before it is sent. The owner creates a dedicated API key for it (and a dynamic one for nemarOrg). This adds phase P7.
- D2: accepted.
- D3: accepted.
- D4: accepted.
- D5: accepted (no expiry, previous-secret slot).
- D6: accepted.
- D7: the footer address is "Swartz Center for Computational Neuroscience, University of California San Diego, 9836 Hopkins Dr, La Jolla, CA 92093".
- D8: owner and admins may turn a category **off or on** for another account (as today), and every change is audited.
- D9: the minimum slice (P1, P2, P3 and the privacy-policy part of P6) **ships to production before RFC-0001 opens**; section 6.2's fallback is not used. The RFC program's O5 step waits on it.
- D10: a policy change goes out as a news item; only a major policy change is sent as maintenance plus a site notice.
- D11: no legal review.

**P7. Monthly newsletter.**
Goal: once a month (and on demand), a job assembles the month's NEMAR activity from the database and GitHub (new and updated public datasets, new version DOIs, open and decided RFCs, CLI and platform releases), drafts the issue with the Claude API, and opens it for an admin to approve; approval sends it through the `news` category with P3's footer and headers.
Design: reuse the model client, prompt layout and refusal handling of the nemarDatasets `.github` PR review; the key lives in a dedicated secret the owner creates; nothing is sent without a person's approval; the draft and the data it was built from are stored with the broadcast so an issue can be audited.
Depends: P3. Owner step: create the API key secret.

## 8. Risks and what to measure

- DKIM coverage of the list headers on real Cloudflare mail (staging canary, section 5).
- The Cloudflare daily quota against the audience size (owner reads the dashboard and runs a counts-only dry run).
- Out-of-office floods into support: expected to be filed by ADR 0113; watch the filtered count after the first send.
- Old CLIs: an admin on an old CLI gets `category_required` or `announcements_retired` with the upgrade sentence; admins are few, so no compatibility shim.
- ADR and migration number races with open branches: take numbers at branch time and re-check before merge.

## 9. Out of scope

- Turning a published news post into a mail (`--from-news <slug>`); worth an issue after launch, not needed for any category.
- Showing admin alert toggles in the website settings card; they stay CLI-only.
- Per-dataset recall targeting (NEMAR does not know who downloaded what; recalls go to the whole audience in 4.1).
- Acting on complaint events beyond Cloudflare's own suppression.
