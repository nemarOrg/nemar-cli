/**
 * The sender blocklist and the spam action behind the admin routes (epic #1893 follow-up, ADR 0113).
 *
 * A listed sender is refused at delivery and nothing of the message is stored (see
 * `handleInboundEmail`). What may be listed is decided by `normalizeBlock`: never our own domain,
 * never a shared mailbox provider's domain. Adding is idempotent: a value already listed returns
 * the stored row, with the reason and author it was first given.
 */

import type {
  AddBlockRequest,
  BlockKind,
  BlocklistEntry,
  SpamBlockChoice,
  SpamResponse,
} from "../../../shared/contract/mail-admin";
import {
  MailAdminError,
  type Viewer,
  assertNotPurged,
  liveEventStatement,
  reload,
  requireVisibleTicket,
  supportDomain,
  throwPurged,
} from "./mail-admin";
import { domainOf, normalizeBlock } from "./mail-screening";

const REASON_MAX = 200;
const CURSOR = /^\d{1,12}$/;

/** Our own domains for the block rules: the apex, plus the sending domain when it differs (staging). */
function ownDomains(env: { FROM_EMAIL?: string }): string[] {
  const own = supportDomain(env);
  return own ? [own.toLowerCase()] : [];
}

/** A reason as stored: one trimmed line, at most 200 characters; null when empty. */
function cleanReason(reason: string | null | undefined): string | null {
  const text = (reason ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
  return text === "" ? null : text;
}

export async function listBlocklist(
  db: D1Database,
  opts: { cursor?: string; limit: number },
): Promise<{ entries: BlocklistEntry[]; next_cursor: string | null }> {
  if (opts.cursor !== undefined && !CURSOR.test(opts.cursor)) {
    throw new MailAdminError(400, "bad_request", "That cursor is not valid.");
  }
  const rows = await db
    .prepare(
      `SELECT id, kind, value, reason, created_by, created_at FROM mail_blocklist
        WHERE (?1 IS NULL OR id < ?1) ORDER BY id DESC LIMIT ?2`,
    )
    .bind(opts.cursor === undefined ? null : Number(opts.cursor), opts.limit + 1)
    .all<BlocklistEntry>();
  const all = rows.results ?? [];
  const page = all.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { entries: page, next_cursor: all.length > opts.limit && last ? String(last.id) : null };
}

async function findEntry(
  db: D1Database,
  kind: BlockKind,
  value: string,
): Promise<BlocklistEntry | null> {
  return db
    .prepare(
      "SELECT id, kind, value, reason, created_by, created_at FROM mail_blocklist WHERE kind = ? AND value = ?",
    )
    .bind(kind, value)
    .first<BlocklistEntry>();
}

/** The normalized block for a request, or the refusal as a typed error. */
function validateBlock(
  env: { FROM_EMAIL?: string },
  req: AddBlockRequest,
): { kind: BlockKind; value: string } {
  const norm = normalizeBlock(req.kind, req.value, ownDomains(env));
  if ("refusal" in norm) {
    throw new MailAdminError(
      norm.malformed ? 400 : 422,
      norm.malformed ? "bad_request" : "block_not_allowed",
      norm.refusal,
    );
  }
  return norm;
}

const INSERT_BLOCK =
  "INSERT OR IGNORE INTO mail_blocklist (kind, value, reason, created_by) VALUES (?, ?, ?, ?)";

/** Add one entry, or return the one already there. */
export async function addBlock(
  db: D1Database,
  env: { FROM_EMAIL?: string },
  viewer: Viewer,
  req: AddBlockRequest,
): Promise<{ entry: BlocklistEntry; created: boolean }> {
  const norm = validateBlock(env, req);
  const result = await db
    .prepare(INSERT_BLOCK)
    .bind(norm.kind, norm.value, cleanReason(req.reason), viewer.id)
    .run();
  const entry = await findEntry(db, norm.kind, norm.value);
  if (!entry) throw new MailAdminError(404, "not_found", "The block could not be read back.");
  return { entry, created: (result.meta?.changes ?? 0) > 0 };
}

export async function removeBlock(db: D1Database, id: number): Promise<BlocklistEntry> {
  const entry = await db
    .prepare(
      "SELECT id, kind, value, reason, created_by, created_at FROM mail_blocklist WHERE id = ?",
    )
    .bind(id)
    .first<BlocklistEntry>();
  if (!entry) throw new MailAdminError(404, "not_found", "No such blocklist entry.");
  await db.prepare("DELETE FROM mail_blocklist WHERE id = ?").bind(id).run();
  return entry;
}

/**
 * Whether the ticket's first inbound message was verified: DMARC passed. Anything else (a DMARC
 * failure, no DMARC, no inbound message at all) is unverified, because the From address of such a
 * message may be forged and blocking it would block whoever was impersonated. This is stricter
 * than the spam test, which also accepts an aligned SPF or DKIM pass that the message row does
 * not record.
 */
// Coupling: the block is derived from `requester_email`, which is the From address of the FIRST
// inbound message (ingest sets it from that message and nothing rewrites it), so that message's
// DMARC result is the one that vouches for the address being blocked. If requester_email ever
// changes after creation, this must check the message that supplied the new address.
async function senderVerified(db: D1Database, ticketId: number): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT dmarc FROM mail_messages WHERE ticket_id = ? AND direction = 'in' ORDER BY id LIMIT 1",
    )
    .bind(ticketId)
    .first<{ dmarc: string }>();
  return row?.dmarc === "pass";
}

/**
 * Mark a ticket spam, unassign it, and block its requester as `block` says. The block is derived
 * from the ticket's requester address and validated BEFORE anything changes, so a refused block
 * leaves the ticket as it was; the block insert and the ticket update share one batch, and the
 * insert is gated on the ticket not being purged, so a ticket purged in between leaves no block.
 * The ticket goes through the same visibility check as every route.
 *
 * Blocking acts on the From address, which an unverified message can forge: a domain block is
 * refused for such a sender, and an address block needs `force`.
 */
export async function markTicketSpam(
  db: D1Database,
  env: { FROM_EMAIL?: string },
  viewer: Viewer,
  ticketId: number,
  choice: SpamBlockChoice,
  reason: string | undefined,
  force = false,
): Promise<SpamResponse> {
  const ticket = await requireVisibleTicket(db, viewer, ticketId);
  assertNotPurged(ticket);

  let wanted: { kind: BlockKind; value: string } | null = null;
  if (choice !== "none") {
    // Defence in depth: the visibility predicate already hides a restricted ticket from a
    // non-owner, and a block made from one would reveal what the ticket was about.
    if (ticket.restricted === 1 && viewer.role !== "owner") {
      throw new MailAdminError(
        403,
        "forbidden",
        "Only an owner can block a sender from a restricted ticket.",
      );
    }
    const address = ticket.requester_email.trim().toLowerCase();
    const value = choice === "address" ? address : domainOf(address);
    if (value === "") {
      throw new MailAdminError(
        400,
        "bad_request",
        "This ticket has no requester address to block.",
      );
    }
    wanted = validateBlock(env, { kind: choice, value });
    if (!(await senderVerified(db, ticket.id)) && (choice === "domain" || !force)) {
      throw new MailAdminError(
        422,
        "block_sender_unverified",
        choice === "domain"
          ? "The sender was not verified (DMARC did not pass), so its address may be forged: a domain block is refused. Block the address with force if you are sure."
          : "The sender was not verified (DMARC did not pass), so its address may be forged. Repeat with force to block the address anyway.",
      );
    }
  }

  const statements: D1PreparedStatement[] = [];
  if (wanted) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO mail_blocklist (kind, value, reason, created_by)
           SELECT ?1, ?2, ?3, ?4
            WHERE EXISTS (SELECT 1 FROM mail_tickets WHERE id = ?5 AND purged_at IS NULL)`,
        )
        .bind(wanted.kind, wanted.value, cleanReason(reason), viewer.id, ticket.id),
    );
  }
  statements.push(
    db
      .prepare(
        "UPDATE mail_tickets SET status = 'spam', assignee_user_id = NULL, filtered = NULL, updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ? AND purged_at IS NULL",
      )
      .bind(ticket.id),
    liveEventStatement(db, ticket.id, "status", viewer.id, {
      from: ticket.status,
      to: "spam",
      block: wanted ? { kind: wanted.kind, value: wanted.value } : null,
    }),
  );
  if (ticket.assignee_user_id !== null) {
    statements.push(
      liveEventStatement(db, ticket.id, "unassigned", viewer.id, {
        from: ticket.assignee_user_id,
        to: null,
        reason: "spam",
      }),
    );
  }
  const results = await db.batch(statements);
  if ((results[wanted ? 1 : 0]?.meta?.changes ?? 0) === 0) throwPurged();
  const block = wanted ? await findEntry(db, wanted.kind, wanted.value) : null;
  return { ticket: await reload(db, ticket.id), block };
}
