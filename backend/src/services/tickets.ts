/**
 * Inbound mail to support tickets (epic #1893 phase 3, #1896, ADR 0110).
 *
 * The raw message in R2 is the record; everything here is a working copy built from it, so a
 * failure at any step leaves the record intact and {@link reprocessRawKey} rebuilds the copy.
 * Processing one raw key twice stores it once: the key is unique on `mail_messages`, a key
 * already stored short-circuits to `duplicate`, and a concurrent second insert that loses the
 * unique constraint is re-checked and reported as `duplicate` too.
 *
 * Threading finds a candidate ticket by the `+t<ref>` plus tag of the recipient, then by
 * `In-Reply-To` and `References` matched against stored Message-IDs (the oldest holder of an id
 * wins). Finding a candidate is not permission to append to it. The message is appended only when
 * ALL of these hold; otherwise it opens a new ticket whose `created` event records the
 * candidate and the reason:
 *   - the message is not spam (DMARC pass, or no DMARC failure plus an aligned SPF or DKIM pass,
 *     from the one Authentication-Results header Cloudflare stamps);
 *   - the candidate is not itself a spam ticket;
 *   - the recipient's queue and the candidate agree on restriction (a security or conduct
 *     address never appends to an unrestricted ticket);
 *   - the From address is the ticket's requester or an address already on the ticket.
 *
 * Tags are descriptive labels taken from the recipient address, which anyone can choose, so they
 * must NEVER feed an access decision: restriction is the queue's (or RESTRICTED_TAGS) and the
 * ticket's `restricted` and `excluded_user_id`, nothing else.
 */

import PostalMime from "postal-mime";
import { htmlToText } from "../lib/html-to-text";
import { clampUtf8Bytes } from "../lib/utf8";
import {
  FALLBACK_QUEUE_TAG,
  isEligibleAssignee,
  isRestrictedQueue,
  resolveAssignee,
} from "./ticket-assignment";

/** The stored body is clamped to this many UTF-8 bytes. */
export const TEXT_BODY_MAX_BYTES = 64 * 1024;
const SUBJECT_MAX_BYTES = 500;
const ADDRESS_MAX_BYTES = 320;
const HEADER_ID_MAX_BYTES = 998;
const TAG_MAX_LENGTH = 64;
/** The most Message-IDs from `References` looked up for one message. */
const MAX_REFERENCE_IDS = 20;

/**
 * The authserv-id Cloudflare Email Routing stamps on the `Authentication-Results` header it adds
 * (observed on real staging mail). Only a header naming this id is read: a sender can put any
 * header, including its own `Authentication-Results`, above or below ours.
 *
 * "The first header with this id" is safe because Cloudflare PREPENDS its trace block: on real
 * staging mail inspected 2026-10-24, its Received, ARC-Authentication-Results, Received-SPF and
 * Authentication-Results all sit above the sender's own Received headers, so nothing the sender
 * wrote can precede ours.
 */
export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

export interface AuthResults {
  spf: string;
  dkim: string;
  dmarc: string;
  /** An SPF or DKIM pass whose domain aligns with the From domain (or names none to check). */
  alignedPass: boolean;
}

export interface InboundTicketInput {
  /** The R2 key of the stored raw message; the idempotency key. */
  rawKey: string;
  raw: ArrayBuffer | Uint8Array;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt: Date;
}

export interface IngestResult {
  outcome: "created" | "threaded" | "duplicate";
  ticketId: number;
  status: string;
  assigneeUserId: number | null;
  spam: boolean;
}

/** A ticket reference as it appears after the `+` of a plus address: `t` and ten base32 characters. */
const REF_TAG = /^t([a-z2-7]{10})$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new short random lowercase base32 ticket reference (50 bits). */
export function newTicketRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let ref = "";
  for (const b of bytes) ref += BASE32[b & 31];
  return ref;
}

/** The plus-address token that threads a reply to ticket `ref`: `support+t<ref>@domain`. */
export function ticketPlusTag(ref: string): string {
  return `t${ref}`;
}

const domainOf = (address: string): string => address.split("@")[1]?.toLowerCase() ?? "";

/** Hosting suffixes under which unrelated tenants share a parent domain. */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  "github.io",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
]);

/**
 * Relaxed alignment by parent/child host matching: equal, or one is a subdomain of the other.
 * There is no public suffix list here, so siblings (`a.example.com` and `b.example.com`) fail
 * closed rather than guess an organisational domain. To keep a shared parent from aligning
 * unrelated parties, the parent must have at least two labels (never `io` or `com`) and must not
 * be a known shared hosting suffix (`github.io`, `pages.dev`, ...); that list is deliberately
 * tiny and best effort. DMARC remains the primary signal.
 */
export function aligned(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  if (a === b) return true;
  const [child, parent] = a.length > b.length ? [a, b] : [b, a];
  if (!child.endsWith(`.${parent}`)) return false;
  return parent.includes(".") && !SHARED_SUFFIXES.has(parent);
}

/**
 * spf, dkim and dmarc results from the FIRST `Authentication-Results` header whose authserv-id is
 * {@link CLOUDFLARE_AUTHSERV_ID}; every other such header is ignored, whatever its position. With
 * none, every result is `none`. An SPF or DKIM pass only sets `alignedPass` when the header gives
 * its domain (`smtp.mailfrom` or `header.d`) and that domain aligns with the From domain; a pass
 * that names no such domain never counts, and `smtp.helo` is never used. DMARC is the primary
 * signal.
 */
export function parseAuthResults(
  headers: { key: string; value: string }[],
  fromAddress = "",
): AuthResults {
  const results: AuthResults = { spf: "none", dkim: "none", dmarc: "none", alignedPass: false };
  const header = headers.find(
    (h) =>
      h.key.toLowerCase() === "authentication-results" &&
      (h.value.split(";")[0] ?? "").trim().toLowerCase() === CLOUDFLARE_AUTHSERV_ID,
  );
  if (!header) return results;
  const fromDomain = domainOf(fromAddress);
  for (const segment of header.value.split(";").slice(1)) {
    const m = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(segment);
    if (!m) continue;
    const name = m[1].toLowerCase() as "spf" | "dkim" | "dmarc";
    const verdict = m[2].toLowerCase();
    if (name === "dmarc") {
      results.dmarc = verdict;
      continue;
    }
    // A pass anywhere for the mechanism wins over a failure of another signature.
    if (verdict === "pass" || results[name] === "none") results[name] = verdict;
    if (verdict !== "pass") continue;
    const prop = name === "spf" ? /smtp\.mailfrom\s*=\s*([^\s;]+)/i : /header\.d\s*=\s*([^\s;]+)/i;
    const named = prop.exec(segment)?.[1]?.replace(/^.*@/, "").toLowerCase();
    // A pass that names no domain (SPF on `smtp.helo` only, DKIM with only `header.i`) cannot be
    // shown to align with From, so it does not count.
    if (named !== undefined && aligned(named, fromDomain)) results.alignedPass = true;
  }
  return results;
}

/**
 * Spam unless DMARC passes, or DMARC did not fail and an SPF or DKIM pass aligns with the From
 * domain.
 */
export function isSpam(auth: AuthResults): boolean {
  if (auth.dmarc === "pass") return false;
  if (auth.dmarc === "fail") return true;
  return !auth.alignedPass;
}

/** `local part` split into its queue tag and the plus tag, both lowercased; "" when absent. */
export function splitRecipient(address: string): { base: string; plus: string } {
  const local = (address.split("@")[0] ?? "").toLowerCase();
  const plusAt = local.indexOf("+");
  return plusAt === -1
    ? { base: local, plus: "" }
    : { base: local.slice(0, plusAt), plus: local.slice(plusAt + 1) };
}

/** A tag safe to store and match: lowercase letters, digits, dot, underscore, hyphen. */
function cleanTag(tag: string): string | null {
  return tag.length > 0 && tag.length <= TAG_MAX_LENGTH && /^[a-z0-9._-]+$/.test(tag) ? tag : null;
}

/** Message-IDs (with their angle brackets) found in an `In-Reply-To` or `References` value. */
export function extractMessageIds(...values: (string | undefined)[]): string[] {
  const ids: string[] = [];
  for (const value of values) {
    for (const m of (value ?? "").matchAll(/<[^<>\s]+>/g)) {
      if (!ids.includes(m[0])) ids.push(m[0]);
    }
  }
  return ids;
}

/** One line of display text: control characters (CR, LF, NUL, ...) become spaces, runs collapse. */
export function singleLine(value: string): string {
  let out = "";
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    const control = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
    out += control ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** `YYYY-MM-DD HH:MM:SS`, the form SQLite's `datetime('now')` writes. */
function sqlDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

interface TicketHead {
  id: number;
  status: string;
  restricted: number;
  queue_tag: string;
  excluded_user_id: number | null;
  assignee_user_id: number | null;
  requester_email: string;
  purged_at: string | null;
}

const HEAD_COLUMNS =
  "t.id, t.status, t.restricted, t.queue_tag, t.excluded_user_id, t.assignee_user_id, t.requester_email, t.purged_at";

async function findByRef(db: D1Database, plus: string): Promise<TicketHead | null> {
  const m = REF_TAG.exec(plus);
  if (!m) return null;
  return db
    .prepare(`SELECT ${HEAD_COLUMNS} FROM mail_tickets t WHERE t.ref = ?`)
    .bind(m[1])
    .first<TicketHead>();
}

/** The ticket holding the OLDEST stored message with any of `ids`: a later copy cannot steal it. */
async function findByMessageIds(db: D1Database, ids: string[]): Promise<TicketHead | null> {
  const wanted = ids.slice(0, MAX_REFERENCE_IDS);
  if (wanted.length === 0) return null;
  const marks = wanted.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${HEAD_COLUMNS}
         FROM mail_messages m JOIN mail_tickets t ON t.id = m.ticket_id
        WHERE m.message_id IN (${marks}) ORDER BY m.id ASC LIMIT 1`,
    )
    .bind(...wanted)
    .first<TicketHead>();
}

/**
 * Whether `address` is the ticket's requester, wrote one of its messages, or is the To recipient
 * of an outgoing one. An outgoing message's `to_addr` must hold only the staff-chosen To
 * recipient (phase 3b stores exactly the requester there), never Cc or Bcc, and an inbound
 * message's `to_addr` (our own address) is not a participant.
 */
async function isTicketParticipant(
  db: D1Database,
  ticket: TicketHead,
  address: string,
): Promise<boolean> {
  if (address === "") return false;
  if (ticket.requester_email.toLowerCase() === address) return true;
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM mail_messages
        WHERE ticket_id = ?1
          AND (lower(from_addr) = ?2 OR (direction = 'out' AND lower(to_addr) = ?2)) LIMIT 1`,
    )
    .bind(ticket.id, address)
    .first<{ ok: number }>();
  return row !== null;
}

/** A verified or approved, live account whose address is `email`, else null. */
async function accountForAddress(db: D1Database, email: string): Promise<number | null> {
  if (email === "") return null;
  const row = await db
    .prepare(
      `SELECT id FROM users
        WHERE lower(email) = lower(?) AND status IN ('verified', 'approved') AND deleted_at IS NULL
        LIMIT 1`,
    )
    .bind(email)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function existingByRawKey(db: D1Database, rawKey: string): Promise<IngestResult | null> {
  const existing = await db
    .prepare(
      `SELECT t.id, t.status, t.assignee_user_id FROM mail_messages m
         JOIN mail_tickets t ON t.id = m.ticket_id WHERE m.raw_key = ?`,
    )
    .bind(rawKey)
    .first<{ id: number; status: string; assignee_user_id: number | null }>();
  if (!existing) return null;
  return {
    outcome: "duplicate",
    ticketId: existing.id,
    status: existing.status,
    assigneeUserId: existing.assignee_user_id,
    spam: existing.status === "spam",
  };
}

/**
 * Turn one stored raw message into a ticket, or into a message on an existing ticket. Throws on a
 * parse or database failure; the Worker's `email()` path catches it and keeps the raw object.
 */
export async function ingestInboundMessage(
  db: D1Database,
  input: InboundTicketInput,
): Promise<IngestResult> {
  const already = await existingByRawKey(db, input.rawKey);
  if (already) return already;
  try {
    return await ingestNew(db, input);
  } catch (error) {
    // A concurrent ingest of the same key won the unique raw_key constraint and this batch
    // rolled back whole; that is a duplicate, not a failure.
    const winner = await existingByRawKey(db, input.rawKey).catch(() => null);
    if (winner) return winner;
    throw error;
  }
}

async function ingestNew(db: D1Database, input: InboundTicketInput): Promise<IngestResult> {
  const parsed = await PostalMime.parse(input.raw);
  const fromAddr = singleLine(
    clampUtf8Bytes(
      (parsed.from?.address || input.envelopeFrom || "").toLowerCase(),
      ADDRESS_MAX_BYTES,
    ),
  );
  const auth = parseAuthResults(parsed.headers, fromAddr);
  const spam = isSpam(auth);

  const envelopeTo = input.envelopeTo || parsed.to?.[0]?.address || "";
  const { base, plus } = splitRecipient(envelopeTo);
  const subject = singleLine(clampUtf8Bytes(parsed.subject ?? "", SUBJECT_MAX_BYTES));
  const bodySource = (parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "")).trimEnd();
  const textBody = clampUtf8Bytes(bodySource, TEXT_BODY_MAX_BYTES);
  const rawMessageId = parsed.messageId
    ? clampUtf8Bytes(parsed.messageId.trim(), HEADER_ID_MAX_BYTES)
    : null;
  // The first stored message to carry an id keeps it as the lookup key. A later message that
  // repeats it (a forged or accidental duplicate) is stored with no id, so it can never become
  // the target of a later `In-Reply-To`; the original is still in the raw object.
  const messageId =
    spam ||
    (rawMessageId !== null &&
      (await db
        .prepare("SELECT 1 AS ok FROM mail_messages WHERE message_id = ? LIMIT 1")
        .bind(rawMessageId)
        .first<{ ok: number }>()))
      ? null
      : rawMessageId;
  const inReplyTo = parsed.inReplyTo ? clampUtf8Bytes(parsed.inReplyTo, HEADER_ID_MAX_BYTES) : null;
  const references = parsed.references ? clampUtf8Bytes(parsed.references, 2048) : null;
  const created = sqlDate(input.receivedAt);

  // Tags: the queue tag, plus any plus tag that is not a ticket reference.
  const tags = new Set<string>();
  const baseTag = cleanTag(base);
  if (baseTag) tags.add(baseTag);
  const plusTag = REF_TAG.test(plus) ? null : cleanTag(plus);
  if (plusTag) tags.add(plusTag);

  // The recipient's queue comes first: it decides restriction before any threading. A reserved
  // tag keeps its own tag and stays restricted even when its row is missing.
  const queueFor = async (tag: string) =>
    db
      .prepare("SELECT tag, restricted FROM mail_queues WHERE tag = ?")
      .bind(tag)
      .first<{ tag: string; restricted: number }>();
  const own = baseTag ? await queueFor(baseTag) : null;
  const fallback = own ? null : await queueFor(FALLBACK_QUEUE_TAG);
  const queueTag = own
    ? own.tag
    : baseTag && isRestrictedQueue(baseTag)
      ? baseTag
      : (fallback?.tag ?? FALLBACK_QUEUE_TAG);
  const queueRestricted = isRestrictedQueue(queueTag, own ?? fallback);

  const messageInsert = (ticketIdSql: string, ticketBinds: unknown[]): D1PreparedStatement =>
    db
      .prepare(
        `INSERT INTO mail_messages (ticket_id, direction, message_id, in_reply_to, references_ids,
            from_addr, to_addr, subject, text_body, raw_key, spf, dkim, dmarc, created_at)
         VALUES (${ticketIdSql}, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ...ticketBinds,
        messageId,
        inReplyTo,
        references,
        fromAddr,
        singleLine(clampUtf8Bytes(envelopeTo, ADDRESS_MAX_BYTES)),
        subject,
        textBody,
        input.rawKey,
        auth.spf,
        auth.dkim,
        auth.dmarc,
        created,
      );

  // A candidate is a match by ref or Message-ID; it becomes the target only if it passes every
  // check, and otherwise the reason is recorded on the new ticket.
  let target: TicketHead | null = null;
  let declined: { matched_ticket_id: number; reason: string } | null = null;
  if (!spam) {
    const candidate =
      (await findByRef(db, plus)) ??
      (await findByMessageIds(db, extractMessageIds(parsed.inReplyTo, parsed.references)));
    if (candidate) {
      let reason: string | null = null;
      if (candidate.status === "spam") reason = "candidate_is_spam";
      else if (candidate.purged_at !== null) reason = "candidate_purged";
      else if (queueRestricted && candidate.restricted !== 1) reason = "restriction_mismatch";
      else if (!(await isTicketParticipant(db, candidate, fromAddr)))
        reason = "sender_not_on_ticket";
      if (reason === null) target = candidate;
      else declined = { matched_ticket_id: candidate.id, reason };
    }
  }

  if (target) {
    const statements: D1PreparedStatement[] = [
      messageInsert("?", [target.id]),
      db
        .prepare("UPDATE mail_tickets SET last_message_at = ?, updated_at = ? WHERE id = ?")
        .bind(created, created, target.id),
    ];
    for (const tag of tags) {
      statements.push(
        db
          .prepare("INSERT OR IGNORE INTO mail_ticket_tags (ticket_id, tag) VALUES (?, ?)")
          .bind(target.id, tag),
      );
    }
    let status = target.status;
    let assignee = target.assignee_user_id;
    // A reply to a closed ticket reopens it, and one to a pending ticket (waiting on the
    // requester) puts it back with the team. Escalated tickets keep their status. The holder
    // is kept only if still eligible for THIS ticket (restricted, excluded, role, status);
    // otherwise the queue's strategy picks again, else the pool.
    if (status === "closed" || status === "pending") {
      const keep =
        assignee !== null &&
        (await isEligibleAssignee(db, assignee, target.restricted === 1, target.excluded_user_id));
      let reassigned = false;
      if (!keep) {
        const next = await resolveAssignee(
          db,
          target.queue_tag,
          { excludedUserId: target.excluded_user_id, restricted: target.restricted === 1 },
          input.receivedAt,
        );
        reassigned = next !== assignee;
        assignee = next;
      }
      statements.push(
        db
          .prepare(
            "UPDATE mail_tickets SET status = 'open', assignee_user_id = ?, updated_at = ? WHERE id = ? AND status IN ('closed', 'pending')",
          )
          .bind(assignee, created, target.id),
        db
          .prepare(
            // `changes()` is the guarded UPDATE's row count: a concurrent reply that reopened the
            // ticket first leaves this one with no rows, so no duplicate event.
            "INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail, created_at) SELECT ?, 'reopened', NULL, ?, ? WHERE changes() > 0",
          )
          .bind(target.id, JSON.stringify({ from: status, to: "open", reason: "reply" }), created),
      );
      if (reassigned) {
        statements.push(
          db
            .prepare(
              // Chained on the `reopened` insert above: one row only if that one was written.
              `INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail, created_at)
               SELECT ?, ?, NULL, ?, ? WHERE changes() > 0`,
            )
            .bind(
              target.id,
              assignee === null ? "unassigned" : "assigned",
              JSON.stringify({ to: assignee, reason: "reopen" }),
              created,
            ),
        );
      }
      status = "open";
    }
    await db.batch(statements);
    return {
      outcome: "threaded",
      ticketId: target.id,
      status,
      assigneeUserId: assignee,
      spam: false,
    };
  }

  const requesterUserId =
    !spam && auth.dmarc === "pass" ? await accountForAddress(db, fromAddr) : null;
  const assignee = spam
    ? null
    : await resolveAssignee(db, queueTag, { restricted: queueRestricted }, input.receivedAt);
  const status = spam ? "spam" : "open";
  const ref = newTicketRef();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO mail_tickets (ref, queue_tag, restricted, status, assignee_user_id,
            requester_email, requester_user_id, subject, created_at, updated_at, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ref,
        queueTag,
        queueRestricted ? 1 : 0,
        status,
        assignee,
        fromAddr,
        requesterUserId,
        subject,
        created,
        created,
        created,
      ),
    messageInsert("(SELECT id FROM mail_tickets WHERE ref = ?)", [ref]),
    db
      .prepare(
        `INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail, created_at)
         VALUES ((SELECT id FROM mail_tickets WHERE ref = ?), 'created', NULL, ?, ?)`,
      )
      .bind(ref, JSON.stringify({ queue: queueTag, spam, ...(declined ?? {}) }), created),
  ];
  if (assignee !== null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail, created_at)
           VALUES ((SELECT id FROM mail_tickets WHERE ref = ?), 'assigned', NULL, ?, ?)`,
        )
        .bind(ref, JSON.stringify({ to: assignee, reason: "queue" }), created),
    );
  }
  for (const tag of tags) {
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO mail_ticket_tags (ticket_id, tag) VALUES ((SELECT id FROM mail_tickets WHERE ref = ?), ?)",
        )
        .bind(ref, tag),
    );
  }
  await db.batch(statements);
  const row = await db
    .prepare("SELECT id FROM mail_tickets WHERE ref = ?")
    .bind(ref)
    .first<{ id: number }>();
  return {
    outcome: "created",
    ticketId: row?.id ?? 0,
    status,
    assigneeUserId: assignee,
    spam,
  };
}

/**
 * Rebuild the ticket copy of one stored raw message (the owner reprocess route of phase 3b calls
 * this). Reading the bucket object back gives the same bytes the Worker received; the envelope
 * addresses and receipt time come from the object's metadata, which the put recorded. A key
 * already ticketed is `duplicate`; a key that is not in the bucket is `missing`.
 */
export async function reprocessRawKey(
  db: D1Database,
  bucket: R2Bucket,
  rawKey: string,
): Promise<IngestResult | { outcome: "missing" } | { outcome: "purged" }> {
  const object = await bucket.get(rawKey);
  if (!object) return { outcome: "missing" };
  // The retention purge deleted this message's row; rebuilding it would bring a purged
  // conversation back as a new ticket. The raw object should be gone by now (its lifecycle rule).
  const purged = await db
    .prepare("SELECT 1 AS ok FROM mail_purged_raw_keys WHERE raw_key = ?")
    .bind(rawKey)
    .first<{ ok: number }>();
  if (purged) return { outcome: "purged" };
  const meta = object.customMetadata ?? {};
  const receivedAt = new Date(meta.received_at ?? "");
  return ingestInboundMessage(db, {
    rawKey,
    raw: await object.arrayBuffer(),
    envelopeFrom: meta.envelope_from ?? "",
    envelopeTo: meta.envelope_to ?? "",
    receivedAt: Number.isNaN(receivedAt.getTime()) ? object.uploaded : receivedAt,
  });
}
