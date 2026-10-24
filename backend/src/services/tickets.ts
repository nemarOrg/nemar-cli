/**
 * Inbound mail to support tickets (epic #1893 phase 3, #1896, ADR 0110).
 *
 * The raw message in R2 is the record; everything here is a working copy built from it, so a
 * failure at any step leaves the record intact and {@link reprocessRawKey} rebuilds the copy.
 * Processing one raw key twice stores it once: the key is unique on `mail_messages`, and a key
 * already stored short-circuits to `duplicate`.
 *
 * Threading, in order: the `+t<ref>` plus tag of the recipient, then `In-Reply-To` and
 * `References` matched against stored Message-IDs, else a new ticket. A message judged spam is
 * never threaded: an unauthenticated sender must not be able to append to a ticket by guessing
 * or forging a header.
 */

import PostalMime from "postal-mime";
import { htmlToText } from "../lib/html-to-text";
import { clampUtf8Bytes } from "./inbound-mail";
import { FALLBACK_QUEUE_TAG, resolveAssignee } from "./ticket-assignment";

/** The stored body is clamped to this many UTF-8 bytes. */
export const TEXT_BODY_MAX_BYTES = 64 * 1024;
const SUBJECT_MAX_BYTES = 500;
const ADDRESS_MAX_BYTES = 320;
const HEADER_ID_MAX_BYTES = 998;
const TAG_MAX_LENGTH = 64;
/** The most Message-IDs from `References` looked up for one message. */
const MAX_REFERENCE_IDS = 20;

export type AuthVerdict = "pass" | "fail" | "none" | string;

export interface AuthResults {
  spf: string;
  dkim: string;
  dmarc: string;
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

/**
 * spf, dkim and dmarc results from the TOPMOST `Authentication-Results` header. Cloudflare adds
 * its own on receipt, above anything the sender supplied, so a header lower down (which the
 * sender could have forged) is never read. A mechanism the header does not mention is `none`.
 */
export function parseAuthResults(headers: { key: string; value: string }[]): AuthResults {
  const header = headers.find((h) => h.key.toLowerCase() === "authentication-results");
  const results: AuthResults = { spf: "none", dkim: "none", dmarc: "none" };
  if (!header) return results;
  for (const name of ["spf", "dkim", "dmarc"] as const) {
    // The first occurrence is the one the receiver evaluated; later dkim=... entries are
    // additional signatures. A `pass` anywhere for dkim counts, so prefer it.
    const matches = [
      ...header.value.matchAll(new RegExp(`(?:^|[\\s;])${name}\\s*=\\s*([a-z]+)`, "gi")),
    ].map((m) => m[1].toLowerCase());
    if (matches.length === 0) continue;
    results[name] = matches.includes("pass") ? "pass" : matches[0];
  }
  return results;
}

/** Spam: a DMARC failure, or no authentication mechanism passed at all. */
export function isSpam(auth: AuthResults): boolean {
  if (auth.dmarc === "fail") return true;
  return auth.spf !== "pass" && auth.dkim !== "pass" && auth.dmarc !== "pass";
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

/** `YYYY-MM-DD HH:MM:SS`, the form SQLite's `datetime('now')` writes. */
function sqlDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

interface TicketHead {
  id: number;
  status: string;
  restricted: number;
  assignee_user_id: number | null;
}

async function findByRef(db: D1Database, plus: string): Promise<TicketHead | null> {
  const m = REF_TAG.exec(plus);
  if (!m) return null;
  return db
    .prepare("SELECT id, status, restricted, assignee_user_id FROM mail_tickets WHERE ref = ?")
    .bind(m[1])
    .first<TicketHead>();
}

async function findByMessageIds(db: D1Database, ids: string[]): Promise<TicketHead | null> {
  const wanted = ids.slice(0, MAX_REFERENCE_IDS);
  if (wanted.length === 0) return null;
  const marks = wanted.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT t.id, t.status, t.restricted, t.assignee_user_id
         FROM mail_messages m JOIN mail_tickets t ON t.id = m.ticket_id
        WHERE m.message_id IN (${marks}) ORDER BY m.id DESC LIMIT 1`,
    )
    .bind(...wanted)
    .first<TicketHead>();
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

/**
 * Turn one stored raw message into a ticket, or into a message on an existing ticket. Throws on a
 * parse or database failure; the Worker's `email()` path catches it and keeps the raw object.
 */
export async function ingestInboundMessage(
  db: D1Database,
  input: InboundTicketInput,
): Promise<IngestResult> {
  const existing = await db
    .prepare(
      `SELECT t.id, t.status, t.assignee_user_id FROM mail_messages m
         JOIN mail_tickets t ON t.id = m.ticket_id WHERE m.raw_key = ?`,
    )
    .bind(input.rawKey)
    .first<{ id: number; status: string; assignee_user_id: number | null }>();
  if (existing) {
    return {
      outcome: "duplicate",
      ticketId: existing.id,
      status: existing.status,
      assigneeUserId: existing.assignee_user_id,
      spam: existing.status === "spam",
    };
  }

  const parsed = await PostalMime.parse(input.raw);
  const auth = parseAuthResults(parsed.headers);
  const spam = isSpam(auth);

  const envelopeTo = input.envelopeTo || parsed.to?.[0]?.address || "";
  const { base, plus } = splitRecipient(envelopeTo);
  const fromAddr = clampUtf8Bytes(
    (parsed.from?.address || input.envelopeFrom || "").toLowerCase(),
    ADDRESS_MAX_BYTES,
  );
  const subject = clampUtf8Bytes((parsed.subject ?? "").trim(), SUBJECT_MAX_BYTES);
  const bodySource = (parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "")).trimEnd();
  const textBody = clampUtf8Bytes(bodySource, TEXT_BODY_MAX_BYTES);
  const messageId = parsed.messageId
    ? clampUtf8Bytes(parsed.messageId.trim(), HEADER_ID_MAX_BYTES)
    : null;
  const inReplyTo = parsed.inReplyTo ? clampUtf8Bytes(parsed.inReplyTo, HEADER_ID_MAX_BYTES) : null;
  const references = parsed.references ? clampUtf8Bytes(parsed.references, 2048) : null;
  const created = sqlDate(input.receivedAt);

  // Tags: the queue tag, plus any plus tag that is not a ticket reference.
  const tags = new Set<string>();
  const baseTag = cleanTag(base);
  if (baseTag) tags.add(baseTag);
  const plusTag = REF_TAG.test(plus) ? null : cleanTag(plus);
  if (plusTag) tags.add(plusTag);

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
        clampUtf8Bytes(envelopeTo, ADDRESS_MAX_BYTES),
        subject,
        textBody,
        input.rawKey,
        auth.spf,
        auth.dkim,
        auth.dmarc,
        created,
      );

  const target = spam
    ? null
    : ((await findByRef(db, plus)) ??
      (await findByMessageIds(db, extractMessageIds(parsed.inReplyTo, parsed.references))));

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
    // A reply to a closed ticket reopens it, and one to a pending ticket (waiting on the
    // requester) puts it back with the team. Escalated and spam tickets keep their status.
    if (status === "closed" || status === "pending") {
      statements.push(
        db
          .prepare(
            "UPDATE mail_tickets SET status = 'open', updated_at = ? WHERE id = ? AND status IN ('closed', 'pending')",
          )
          .bind(created, target.id),
        db
          .prepare(
            "INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail, created_at) VALUES (?, 'status', NULL, ?, ?)",
          )
          .bind(target.id, JSON.stringify({ from: status, to: "open", reason: "reply" }), created),
      );
      status = "open";
    }
    await db.batch(statements);
    return {
      outcome: "threaded",
      ticketId: target.id,
      status,
      assigneeUserId: target.assignee_user_id,
      spam: false,
    };
  }

  // A new ticket. Queue: the recipient's own if it has one, else the fallback.
  const queue = await db
    .prepare("SELECT tag, restricted FROM mail_queues WHERE tag = ?")
    .bind(baseTag ?? FALLBACK_QUEUE_TAG)
    .first<{ tag: string; restricted: number }>();
  const queueRow = queue ??
    (await db
      .prepare("SELECT tag, restricted FROM mail_queues WHERE tag = ?")
      .bind(FALLBACK_QUEUE_TAG)
      .first<{ tag: string; restricted: number }>()) ?? { tag: FALLBACK_QUEUE_TAG, restricted: 0 };

  const requesterUserId =
    !spam && auth.dmarc === "pass" ? await accountForAddress(db, fromAddr) : null;
  const assignee = spam ? null : await resolveAssignee(db, queueRow.tag, {}, input.receivedAt);
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
        queueRow.tag,
        queueRow.restricted,
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
      .bind(ref, JSON.stringify({ queue: queueRow.tag, spam }), created),
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
): Promise<IngestResult | { outcome: "missing" }> {
  const object = await bucket.get(rawKey);
  if (!object) return { outcome: "missing" };
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
