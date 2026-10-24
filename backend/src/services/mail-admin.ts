/**
 * The operations behind the support-ticket admin routes (epic #1893 phase 3b, ADR 0111).
 *
 * Every function that touches a ticket takes the viewer and goes through {@link loadVisibleTicket},
 * which puts 3a's `ticketVisibleTo` predicate in the query. A ticket the viewer may not see is
 * indistinguishable from one that does not exist (`not_found`), on reads and writes alike. Nothing
 * here reads the account kind or the username: access is the role and the ticket's exclusion.
 */

import type {
  MailErrorCode,
  SettableStatus,
  TicketEvent,
  TicketMessage,
  TicketStatus,
  TicketSummary,
} from "../../../shared/contract/mail-admin";
import { escapeHtml } from "../lib/escape";
import type { Bindings } from "../types/bindings";
import {
  DevEmailFenceError,
  MailHeaderError,
  isCertainNonDelivery,
  parseMailbox,
  redactAddressIn,
  resolveEmailConfig,
  sendEmail,
} from "./email";
import { isEligibleAssignee, isRestrictedQueue, ticketVisibleTo } from "./ticket-assignment";
import { plainLine } from "./ticket-notify";
import { ticketPlusTag } from "./tickets";

export class MailAdminError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 502 | 503,
    readonly code: MailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MailAdminError";
  }
}

export interface Viewer {
  id: number;
  role: string;
}

/** Row of `mail_tickets` as the routes read it. `excluded_user_id` never leaves the service. */
export interface TicketRow {
  id: number;
  ref: string;
  queue_tag: string;
  restricted: number;
  excluded_user_id: number | null;
  status: TicketStatus;
  assignee_user_id: number | null;
  requester_email: string;
  requester_user_id: number | null;
  subject: string;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  summary: string | null;
  summary_author_user_id: number | null;
  summarized_at: string | null;
  purged_at: string | null;
}

export function toSummary(row: TicketRow): TicketSummary {
  return {
    id: row.id,
    ref: row.ref,
    queue_tag: row.queue_tag,
    restricted: row.restricted === 1,
    status: row.status,
    assignee_user_id: row.assignee_user_id,
    requester_email: row.requester_email,
    requester_user_id: row.requester_user_id,
    subject: row.subject,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message_at: row.last_message_at,
    has_summary: row.summary !== null,
    purged: row.purged_at !== null,
  };
}

/** A purged ticket is read-only: its raw record is gone, so nothing may be added to it. */
function assertNotPurged(ticket: TicketRow): void {
  if (ticket.purged_at !== null) throwPurged();
}

/** A write was refused by its `purged_at IS NULL` gate: the purge claimed the ticket first. */
function throwPurged(): never {
  throw new MailAdminError(
    409,
    "ticket_purged",
    "This ticket was purged under the retention policy and can no longer be changed.",
  );
}

/** The ticket, if `viewer` may see it; else null, which every caller turns into `not_found`. */
export async function loadVisibleTicket(
  db: D1Database,
  viewer: Viewer,
  id: number,
): Promise<TicketRow | null> {
  const vis = ticketVisibleTo(viewer, "t");
  return db
    .prepare(`SELECT t.* FROM mail_tickets t WHERE t.id = ? AND ${vis.sql}`)
    .bind(id, ...vis.binds)
    .first<TicketRow>();
}

export async function requireVisibleTicket(
  db: D1Database,
  viewer: Viewer,
  id: number,
): Promise<TicketRow> {
  const row = await loadVisibleTicket(db, viewer, id);
  if (!row) throw new MailAdminError(404, "not_found", "No such ticket.");
  return row;
}

const LIKE_ESCAPE = /[\\%_]/g;

export interface ListFilters {
  status?: TicketStatus;
  queue?: string;
  assignee?: string;
  q?: string;
  summary?: "missing";
  cursor?: string;
  limit: number;
}

const CURSOR = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|(\d+)$/;

export async function listTickets(
  db: D1Database,
  viewer: Viewer,
  f: ListFilters,
): Promise<{ tickets: TicketSummary[]; next_cursor: string | null }> {
  const vis = ticketVisibleTo(viewer, "t");
  const where = [vis.sql];
  const binds: unknown[] = [...vis.binds];
  if (f.summary === "missing") {
    where.push("t.status = 'closed' AND t.purged_at IS NULL AND t.summary IS NULL");
  }
  if (f.status) {
    where.push("t.status = ?");
    binds.push(f.status);
  } else if (f.summary !== "missing") {
    where.push("t.status NOT IN ('spam', 'closed')");
  }
  if (f.queue) {
    where.push("t.queue_tag = ?");
    binds.push(f.queue);
  }
  if (f.assignee !== undefined) {
    if (f.assignee === "none") where.push("t.assignee_user_id IS NULL");
    else if (f.assignee === "me") {
      where.push("t.assignee_user_id = ?");
      binds.push(viewer.id);
    } else if (/^\d{1,12}$/.test(f.assignee)) {
      where.push("t.assignee_user_id = ?");
      binds.push(Number(f.assignee));
    } else {
      throw new MailAdminError(400, "bad_request", "assignee is me, none or a user id.");
    }
  }
  if (f.q) {
    const like = `%${f.q.replace(LIKE_ESCAPE, "\\$&")}%`;
    where.push("(t.subject LIKE ? ESCAPE '\\' OR t.requester_email LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  if (f.cursor) {
    const m = CURSOR.exec(f.cursor);
    if (!m) throw new MailAdminError(400, "bad_request", "That cursor is not valid.");
    where.push("(t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))");
    binds.push(m[1], m[1], Number(m[2]));
  }
  const rows = await db
    .prepare(
      `SELECT t.* FROM mail_tickets t WHERE ${where.join(" AND ")}
        ORDER BY t.last_message_at DESC, t.id DESC LIMIT ?`,
    )
    .bind(...binds, f.limit + 1)
    .all<TicketRow>();
  const all = rows.results ?? [];
  const page = all.slice(0, f.limit);
  const last = page[page.length - 1];
  return {
    tickets: page.map(toSummary),
    next_cursor: all.length > f.limit && last ? `${last.last_message_at}|${last.id}` : null,
  };
}

export async function ticketDetail(db: D1Database, ticket: TicketRow) {
  const [tags, messages, events] = await Promise.all([
    db
      .prepare("SELECT tag FROM mail_ticket_tags WHERE ticket_id = ? ORDER BY tag")
      .bind(ticket.id)
      .all<{ tag: string }>(),
    db
      .prepare(
        `SELECT id, direction, message_id, from_addr, to_addr, subject, text_body, spf, dkim, dmarc,
                author_user_id, created_at
           FROM mail_messages WHERE ticket_id = ? ORDER BY id`,
      )
      .bind(ticket.id)
      .all<TicketMessage>(),
    db
      .prepare(
        `SELECT id, kind, actor_user_id, detail, created_at
           FROM mail_ticket_events WHERE ticket_id = ? ORDER BY id`,
      )
      .bind(ticket.id)
      .all<{
        id: number;
        kind: string;
        actor_user_id: number | null;
        detail: string | null;
        created_at: string;
      }>(),
  ]);
  return {
    ticket: toSummary(ticket),
    tags: (tags.results ?? []).map((t) => t.tag),
    messages: messages.results ?? [],
    summary: ticket.summary,
    summary_author_user_id: ticket.summary_author_user_id,
    summarized_at: ticket.summarized_at,
    purged_at: ticket.purged_at,
    events: (events.results ?? []).map(
      (e): TicketEvent => ({
        id: e.id,
        kind: e.kind,
        actor_user_id: e.actor_user_id,
        detail: parseDetail(e.detail),
        created_at: e.created_at,
      }),
    ),
  };
}

function parseDetail(detail: string | null): unknown {
  if (detail === null) return null;
  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

function eventStatement(
  db: D1Database,
  ticketId: number,
  kind: string,
  actor: number | null,
  detail: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail) VALUES (?, ?, ?, ?)",
    )
    .bind(ticketId, kind, actor, JSON.stringify(detail));
}

/** An event row that is written only while the ticket is not purged (a purge may race a reply). */
function liveEventStatement(
  db: D1Database,
  ticketId: number,
  kind: string,
  actor: number | null,
  detail: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail)
       SELECT ?1, ?2, ?3, ?4
        WHERE EXISTS (SELECT 1 FROM mail_tickets WHERE id = ?1 AND purged_at IS NULL)`,
    )
    .bind(ticketId, kind, actor, JSON.stringify(detail));
}

async function reload(db: D1Database, id: number): Promise<TicketSummary> {
  const row = await db
    .prepare("SELECT * FROM mail_tickets WHERE id = ?")
    .bind(id)
    .first<TicketRow>();
  if (!row) throw new MailAdminError(404, "not_found", "No such ticket.");
  return toSummary(row);
}

// ---------------------------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------------------------

/** The domain of FROM_EMAIL: `nemar.org` in production, `test.nemar.org` on staging. */
export function supportDomain(env: { FROM_EMAIL?: string }): string {
  const { fromEmail } = resolveEmailConfig(env);
  const parsed = parseMailbox(fromEmail);
  const address = typeof parsed === "string" ? parsed : parsed.email;
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** `Re: <subject>`, with control characters gone and no second `Re:`. */
export function replySubject(subject: string): string {
  const clean = plainLine(subject, 200);
  if (clean === "") return "Re: (no subject)";
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

/** Plain text as the escaped HTML body of a reply: a paragraph per blank line, `<br>` per break. */
export function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  return `<!DOCTYPE html><html><body style="font-family: sans-serif; line-height: 1.5;">${paragraphs.join("")}</body></html>`;
}

const MAX_REFERENCES = 60;
/** A header value stays within this many characters (the same bound validateMailHeaders enforces). */
const REFERENCES_MAX_CHARS = 998;
/** A reply whose key has been pending this long is treated as having an unknown outcome. */
const PENDING_KEY_STALE_SECONDS = 120;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,64}$/;
const MESSAGE_ID = /^<[^<>\s]+>$/;

/**
 * The `References` value for a reply: the ticket's Message-IDs oldest to newest, trimmed from the
 * middle until it fits `maxChars`. The thread root (the first id) and the id being replied to
 * (`inReplyTo`) are always kept, then the newest others that fit.
 */
export function buildReferences(
  ids: string[],
  inReplyTo: string | undefined,
  maxChars = REFERENCES_MAX_CHARS,
): string | undefined {
  const keep = new Set<number>();
  let length = 0;
  const add = (index: number): boolean => {
    const cost = ids[index].length + (keep.size > 0 ? 1 : 0);
    if (length + cost > maxChars) return false;
    keep.add(index);
    length += cost;
    return true;
  };
  const pinned = inReplyTo === undefined ? -1 : ids.lastIndexOf(inReplyTo);
  // The id replied to comes first, so it wins if the two cannot both fit.
  if (pinned >= 0) add(pinned);
  if (ids.length > 0 && pinned !== 0) add(0);
  for (let i = ids.length - 1; i >= 0; i--) {
    if (i === pinned || i === 0) continue;
    if (!add(i)) break;
  }
  const kept = [...keep].sort((x, y) => x - y).map((i) => ids[i]);
  return kept.length > 0 ? kept.join(" ") : undefined;
}

export interface ReplyOutcome {
  message_id: number;
  header_message_id: string;
  status: TicketStatus;
}

const UNKNOWN_MESSAGE =
  "The mail provider did not confirm the send, so the reply may or may not have gone out. Check with the requester before sending it again.";

/** Best effort: used where the primary failure must still reach the caller with its clear text. */
async function tryRun(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(
      `[mail-admin] ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Send a reply and record it. With an `idempotencyKey` a retry is safe: the key is stored unique
 * per ticket BEFORE anything is sent, a repeat of a sent reply returns its stored outcome without
 * sending, a repeat while the first is still in flight is 409 `reply_in_progress`, and a repeat of
 * a reply whose outcome was unknown is the same 502 again (never a second send). A reply that
 * certainly sent nothing releases its key so the retry can go.
 */
export async function replyToTicket(
  env: Bindings,
  viewer: Viewer,
  ticketId: number,
  text: string,
  idempotencyKey?: string,
): Promise<ReplyOutcome> {
  const db = env.DB;
  const ticket = await requireVisibleTicket(db, viewer, ticketId);
  assertNotPurged(ticket);
  if (ticket.status === "spam") {
    throw new MailAdminError(409, "ticket_is_spam", "A spam ticket cannot be replied to.");
  }
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new MailAdminError(
      400,
      "bad_request",
      "Idempotency-Key is 1 to 64 letters, digits or . _ : -.",
    );
  }

  if (idempotencyKey !== undefined) {
    const claimed = await db
      .prepare(
        "INSERT OR IGNORE INTO mail_reply_keys (ticket_id, idem_key, state) VALUES (?, ?, 'pending')",
      )
      .bind(ticket.id, idempotencyKey)
      .run();
    if ((claimed.meta?.changes ?? 0) === 0) {
      const prior = await db
        .prepare(
          `SELECT state, outcome,
                  created_at < datetime('now', '-${PENDING_KEY_STALE_SECONDS} seconds') AS stale
             FROM mail_reply_keys WHERE ticket_id = ? AND idem_key = ?`,
        )
        .bind(ticket.id, idempotencyKey)
        .first<{ state: string; outcome: string | null; stale: number }>();
      if (prior?.state === "sent" && prior.outcome)
        return JSON.parse(prior.outcome) as ReplyOutcome;
      if (prior && (prior.state === "unknown" || prior.stale === 1)) {
        throw new MailAdminError(502, "reply_delivery_unknown", UNKNOWN_MESSAGE);
      }
      throw new MailAdminError(
        409,
        "reply_in_progress",
        "A reply with this Idempotency-Key is still being sent. Do not send it again.",
      );
    }
  }
  const setKey = (state: "unknown", headerId: string) =>
    idempotencyKey === undefined
      ? Promise.resolve()
      : db
          .prepare(
            "UPDATE mail_reply_keys SET state = ?, header_message_id = ? WHERE ticket_id = ? AND idem_key = ?",
          )
          .bind(state, headerId, ticket.id, idempotencyKey)
          .run();
  const releaseKey = () =>
    idempotencyKey === undefined
      ? Promise.resolve()
      : db
          .prepare("DELETE FROM mail_reply_keys WHERE ticket_id = ? AND idem_key = ?")
          .bind(ticket.id, idempotencyKey)
          .run();

  try {
    return await sendAndRecord(env, viewer, ticket, text, idempotencyKey, setKey);
  } catch (error) {
    // Everything but an unknown outcome means nothing went out: free the key for the retry.
    if (!(error instanceof MailAdminError && error.code === "reply_delivery_unknown")) {
      await tryRun("releasing the reply key", releaseKey);
    }
    throw error;
  }
}

async function sendAndRecord(
  env: Bindings,
  viewer: Viewer,
  ticket: TicketRow,
  text: string,
  idempotencyKey: string | undefined,
  setKey: (state: "unknown", headerId: string) => Promise<unknown>,
): Promise<ReplyOutcome> {
  const db = env.DB;
  const domain = supportDomain(env);
  const supportAddress = `support@${domain}`;
  const headerId = `<${crypto.randomUUID()}@${domain}>`;

  const latestIn = await db
    .prepare(
      `SELECT message_id FROM mail_messages
        WHERE ticket_id = ? AND direction = 'in' AND message_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .bind(ticket.id)
    .first<{ message_id: string }>();
  const chain = await db
    .prepare(
      `SELECT message_id FROM mail_messages
        WHERE ticket_id = ? AND direction IN ('in', 'out') AND message_id IS NOT NULL
        ORDER BY id DESC LIMIT ?`,
    )
    .bind(ticket.id, MAX_REFERENCES)
    .all<{ message_id: string }>();
  const root = await db
    .prepare(
      `SELECT message_id FROM mail_messages
        WHERE ticket_id = ? AND direction IN ('in', 'out') AND message_id IS NOT NULL
        ORDER BY id LIMIT 1`,
    )
    .bind(ticket.id)
    .first<{ message_id: string }>();
  const ids = (chain.results ?? [])
    .map((r) => r.message_id)
    .filter((id) => MESSAGE_ID.test(id))
    .reverse();
  // The query holds only the newest messages; the thread's first one is read separately.
  if (root && MESSAGE_ID.test(root.message_id) && !ids.includes(root.message_id)) {
    ids.unshift(root.message_id);
  }
  const headers: Record<string, string> = { "Message-ID": headerId };
  if (latestIn && MESSAGE_ID.test(latestIn.message_id)) {
    headers["In-Reply-To"] = latestIn.message_id;
  }
  const references = buildReferences(ids, headers["In-Reply-To"]);
  if (references) headers.References = references;

  // A purge can have run since the ticket was loaded; nothing has been sent yet, so refuse.
  const live = await db
    .prepare("SELECT purged_at FROM mail_tickets WHERE id = ?")
    .bind(ticket.id)
    .first<{ purged_at: string | null }>();
  if (live?.purged_at) assertNotPurged({ ...ticket, purged_at: live.purged_at });

  const subject = replySubject(ticket.subject);
  const { isDev } = resolveEmailConfig(env);
  const from = `NEMAR Support <${supportAddress}>`;
  const replyTo = `${supportAddress.replace("@", `+${ticketPlusTag(ticket.ref)}@`)}`;

  try {
    await sendEmail(
      ticket.requester_email,
      subject,
      textToHtml(text),
      env.RESEND_API_KEY ?? "",
      from,
      replyTo,
      isDev,
      env,
      undefined,
      headers,
    );
  } catch (error) {
    const reason = redactAddressIn(
      error instanceof Error ? error.message : String(error),
      ticket.requester_email,
    );
    if (isCertainNonDelivery(error)) {
      console.warn(`[mail-admin] reply on ticket ${ticket.id} not sent: ${reason}`);
      throw new MailAdminError(
        502,
        "reply_not_sent",
        error instanceof DevEmailFenceError
          ? "Nothing was sent: this environment does not deliver to that recipient."
          : error instanceof MailHeaderError
            ? "Nothing was sent: the message headers were refused."
            : "Nothing was sent: the mail provider refused the message.",
      );
    }
    // The provider may have accepted it and only the answer was lost. Storing nothing would
    // invite a second send; storing it as sent would claim a delivery nobody saw. So the
    // attempt is recorded as an event naming the Message-ID, the admin is told it is unknown,
    // and the requester's own reply (which carries that id) will thread if it did arrive. The
    // writes are best effort: a failing database must not hide the 502 and its clear text.
    console.error(`[mail-admin] reply on ticket ${ticket.id} outcome unknown: ${reason}`);
    await tryRun("recording the unknown reply", () =>
      eventStatement(db, ticket.id, "reply_failed", viewer.id, {
        delivery: "unknown",
        header_message_id: headerId,
      }).run(),
    );
    await tryRun("marking the reply key unknown", () => setKey("unknown", headerId));
    throw new MailAdminError(502, "reply_delivery_unknown", UNKNOWN_MESSAGE);
  }

  const nextStatus: TicketStatus = ticket.status === "open" ? "pending" : ticket.status;
  const statements = [
    db
      .prepare(
        `INSERT INTO mail_messages (ticket_id, direction, message_id, in_reply_to, references_ids,
            from_addr, to_addr, subject, text_body, author_user_id)
         SELECT ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM mail_tickets WHERE id = ? AND purged_at IS NULL)`,
      )
      .bind(
        ticket.id,
        headerId,
        headers["In-Reply-To"] ?? null,
        headers.References ?? null,
        supportAddress,
        ticket.requester_email,
        subject,
        text.slice(0, 64 * 1024),
        viewer.id,
        ticket.id,
      ),
    db
      .prepare(
        "UPDATE mail_tickets SET last_message_at = datetime('now'), last_activity_at = datetime('now'), updated_at = datetime('now'), status = ? WHERE id = ? AND purged_at IS NULL",
      )
      .bind(nextStatus, ticket.id),
    liveEventStatement(db, ticket.id, "reply", viewer.id, { message_id: headerId }),
  ];
  if (nextStatus !== ticket.status) {
    statements.push(
      liveEventStatement(db, ticket.id, "status", viewer.id, {
        from: ticket.status,
        to: nextStatus,
        reason: "reply",
      }),
    );
  }
  if (idempotencyKey !== undefined) {
    statements.push(
      db
        .prepare(
          `UPDATE mail_reply_keys SET state = 'sent', header_message_id = ?1,
              outcome = json_object('message_id',
                (SELECT id FROM mail_messages WHERE ticket_id = ?2 AND message_id = ?1),
                'header_message_id', ?1, 'status', ?3)
            WHERE ticket_id = ?2 AND idem_key = ?4`,
        )
        .bind(headerId, ticket.id, nextStatus, idempotencyKey),
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    console.error(
      `[mail-admin] reply on ticket ${ticket.id} was sent but not recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
    // The mail went out, so leave a trace that names it (best effort, like the unknown case),
    // and make a repeat of the same key answer 502 and not send again.
    await tryRun("recording the unrecorded reply", () =>
      eventStatement(db, ticket.id, "reply_failed", viewer.id, {
        delivery: "sent_unrecorded",
        header_message_id: headerId,
      }).run(),
    );
    await tryRun("marking the reply key unknown", () => setKey("unknown", headerId));
    throw new MailAdminError(
      502,
      "reply_delivery_unknown",
      "The reply was sent but could not be recorded. Do not send it again.",
    );
  }
  const stored = await db
    .prepare("SELECT id FROM mail_messages WHERE ticket_id = ? AND message_id = ?")
    .bind(ticket.id, headerId)
    .first<{ id: number }>();
  if (!stored) {
    // The purge won the race after the mail went out: the guarded statements wrote nothing. The
    // reply was sent, so report success; the ticket holds no trace of it by design.
    console.warn(`[mail-admin] reply on ticket ${ticket.id} was sent after the ticket was purged`);
  }
  return { message_id: stored?.id ?? 0, header_message_id: headerId, status: nextStatus };
}

// ---------------------------------------------------------------------------------------------
// Note, assign, status, escalate
// ---------------------------------------------------------------------------------------------

export async function addNote(
  db: D1Database,
  viewer: Viewer,
  ticketId: number,
  text: string,
): Promise<number> {
  const ticket = await requireVisibleTicket(db, viewer, ticketId);
  assertNotPurged(ticket);
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO mail_messages (ticket_id, direction, text_body, author_user_id)
         SELECT ?1, 'note', ?2, ?3
          WHERE EXISTS (SELECT 1 FROM mail_tickets WHERE id = ?1 AND purged_at IS NULL)`,
      )
      .bind(ticket.id, text.slice(0, 64 * 1024), viewer.id),
    db
      .prepare(
        "UPDATE mail_tickets SET updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ? AND purged_at IS NULL",
      )
      .bind(ticket.id),
    liveEventStatement(db, ticket.id, "note", viewer.id, null),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) throwPurged();
  const row = await db
    .prepare("SELECT MAX(id) AS id FROM mail_messages WHERE ticket_id = ? AND direction = 'note'")
    .bind(ticket.id)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

export async function assignTicket(
  db: D1Database,
  viewer: Viewer,
  ticketId: number,
  userId: number | null,
): Promise<TicketSummary> {
  const ticket = await requireVisibleTicket(db, viewer, ticketId);
  assertNotPurged(ticket);
  if (userId !== null) {
    const ok = await isEligibleAssignee(
      db,
      userId,
      ticket.restricted === 1,
      ticket.excluded_user_id,
    );
    if (!ok) {
      throw new MailAdminError(
        422,
        "ineligible_assignee",
        ticket.restricted === 1
          ? "A restricted ticket can only be held by an owner who is not excluded from it."
          : "That account cannot hold tickets.",
      );
    }
  }
  if (userId === ticket.assignee_user_id) return toSummary(ticket);
  const results = await db.batch([
    db
      .prepare(
        "UPDATE mail_tickets SET assignee_user_id = ?, updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ? AND purged_at IS NULL",
      )
      .bind(userId, ticket.id),
    liveEventStatement(db, ticket.id, userId === null ? "unassigned" : "assigned", viewer.id, {
      from: ticket.assignee_user_id,
      to: userId,
      reason: "manual",
    }),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) throwPurged();
  return reload(db, ticket.id);
}

export async function setTicketStatus(
  db: D1Database,
  viewer: Viewer,
  ticketId: number,
  status: SettableStatus,
): Promise<TicketSummary> {
  const ticket = await requireVisibleTicket(db, viewer, ticketId);
  assertNotPurged(ticket);
  if (ticket.status === status) return toSummary(ticket);
  if (
    (ticket.status === "closed" || ticket.status === "spam") &&
    (status === "open" || status === "pending")
  ) {
    // Reopening puts the ticket back in a queue's hands. Its restricted flag was copied at
    // creation, so if the queue's rule has changed since, refuse rather than quietly keep a
    // ticket under a rule its queue no longer applies (or the reverse).
    const queue = await db
      .prepare("SELECT restricted FROM mail_queues WHERE tag = ?")
      .bind(ticket.queue_tag)
      .first<{ restricted: number }>();
    if (isRestrictedQueue(ticket.queue_tag, queue) !== (ticket.restricted === 1)) {
      throw new MailAdminError(
        409,
        "restriction_mismatch",
        "This ticket's restriction no longer matches its queue's, so it cannot be reopened here.",
      );
    }
  }
  const results = await db.batch([
    db
      .prepare(
        "UPDATE mail_tickets SET status = ?, updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ? AND purged_at IS NULL",
      )
      .bind(status, ticket.id),
    liveEventStatement(db, ticket.id, "status", viewer.id, { from: ticket.status, to: status }),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) throwPurged();
  return reload(db, ticket.id);
}

/** The escalation owner for a queue: its own, else the fallback queue's. */
export async function escalationOwnerFor(db: D1Database, queueTag: string): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT COALESCE(
          (SELECT escalation_user_id FROM mail_queues WHERE tag = ?),
          (SELECT escalation_user_id FROM mail_queues WHERE tag = '*')) AS owner`,
    )
    .bind(queueTag)
    .first<{ owner: number | null }>();
  return row?.owner ?? null;
}

export async function escalateTicket(
  db: D1Database,
  viewer: Viewer,
  ticketId: number,
  reason: string | null,
): Promise<{ ticket: TicketSummary; ownerId: number }> {
  const ticket = await requireVisibleTicket(db, viewer, ticketId);
  assertNotPurged(ticket);
  if (ticket.status === "escalated") {
    throw new MailAdminError(409, "already_escalated", "This ticket is already escalated.");
  }
  if (ticket.status === "closed" || ticket.status === "spam") {
    throw new MailAdminError(409, "ticket_closed", "Reopen the ticket before escalating it.");
  }
  const ownerId = await escalationOwnerFor(db, ticket.queue_tag);
  if (ownerId === null) {
    throw new MailAdminError(
      409,
      "no_escalation_owner",
      "No escalation owner is set for this queue. An owner sets one with PUT /admin/mail/queues/:tag.",
    );
  }
  // Owner role is the setting's own rule; eligibility is rechecked now so a stale value, or a
  // restricted ticket that excludes the owner, refuses instead of widening access.
  if (!(await isEligibleAssignee(db, ownerId, true, ticket.excluded_user_id))) {
    throw new MailAdminError(
      409,
      "escalation_owner_ineligible",
      "The escalation owner cannot hold this ticket. An owner should change the setting.",
    );
  }
  const results = await db.batch([
    db
      .prepare(
        "UPDATE mail_tickets SET status = 'escalated', assignee_user_id = ?, updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ? AND purged_at IS NULL",
      )
      .bind(ownerId, ticket.id),
    liveEventStatement(db, ticket.id, "escalated", viewer.id, { to: ownerId, reason }),
    liveEventStatement(db, ticket.id, "assigned", viewer.id, {
      from: ticket.assignee_user_id,
      to: ownerId,
      reason: "escalation",
    }),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) throwPurged();
  return { ticket: await reload(db, ticket.id), ownerId };
}

// ---------------------------------------------------------------------------------------------
// Summary (kept after the retention purge)
// ---------------------------------------------------------------------------------------------

/** A simple `local@domain.tld`, enough to refuse the common way an address ends up in a summary. */
const ADDRESS_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Whether `text` contains something shaped like an email address. */
export function containsEmailAddress(text: string): boolean {
  // NFKC folds look-alikes such as the full-width at sign into the ASCII one before the test.
  return ADDRESS_IN_TEXT.test(text.normalize("NFKC"));
}

/**
 * Store the summary kept after the purge, replacing an earlier one. The viewer must be able to see
 * the ticket (the same predicate as every route, so a restricted ticket is summarized only by an
 * owner). Records who wrote it and a `summary` event with no text. Refused for a purged ticket and
 * for a text holding an email address.
 */
export async function setTicketSummary(
  db: D1Database,
  viewer: Viewer,
  ticketId: number,
  summary: string,
): Promise<TicketSummary> {
  const ticket = await requireVisibleTicket(db, viewer, ticketId);
  assertNotPurged(ticket);
  if (containsEmailAddress(summary)) {
    throw new MailAdminError(
      400,
      "summary_has_address",
      "The summary contains an email address. Describe the request and the outcome without names, addresses or quoted text.",
    );
  }
  await db.batch([
    db
      .prepare(
        `UPDATE mail_tickets SET summary = ?, summary_author_user_id = ?,
            summarized_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND purged_at IS NULL`,
      )
      .bind(summary, viewer.id, ticket.id),
    db
      .prepare(
        `INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail)
         SELECT ?, 'summary', ?, NULL WHERE changes() > 0`,
      )
      .bind(ticket.id, viewer.id),
  ]);
  const after = await db
    .prepare("SELECT * FROM mail_tickets WHERE id = ?")
    .bind(ticket.id)
    .first<TicketRow>();
  if (!after) throw new MailAdminError(404, "not_found", "No such ticket.");
  // The purge can run between the read and the write; the guarded update then wrote nothing.
  assertNotPurged(after);
  return toSummary(after);
}
