/**
 * Queue configuration and away windows for the support-ticket admin routes (epic #1893 phase 3b,
 * ADR 0111). Eligibility is 3a's {@link isEligibleAssignee}: an approved, live admin or owner, and
 * an owner only on a restricted queue.
 */

import type {
  Availability,
  MailQueue,
  PutAvailabilityRequest,
  PutQueueRequest,
  QueueStrategy,
} from "../../../shared/contract/mail-admin";
import { MailAdminError } from "./mail-admin";
import {
  FALLBACK_QUEUE_TAG,
  type MailQueueRow,
  RESTRICTED_TAGS,
  isEligibleAssignee,
  isRestrictedQueue,
  parseRrMembers,
  ticketVisibleTo,
} from "./ticket-assignment";

const QUEUE_TAG = /^[a-z0-9._-]{1,64}$/;
const MAX_RR_MEMBERS = 50;

interface QueueRowWithEscalation extends MailQueueRow {
  escalation_user_id: number | null;
}

function toQueue(row: QueueRowWithEscalation, open: number): MailQueue {
  return {
    tag: row.tag,
    restricted: isRestrictedQueue(row.tag, row),
    strategy: row.strategy,
    assignee_user_id: row.assignee_user_id,
    backup_user_id: row.backup_user_id,
    rr_members: parseRrMembers(row.rr_members),
    escalation_user_id: row.escalation_user_id,
    open_tickets: open,
  };
}

/** Queues the viewer may know exist: every one for an owner, the unrestricted ones for an admin. */
export async function listQueues(
  db: D1Database,
  viewer: { id: number; role: string },
): Promise<MailQueue[]> {
  // The count is of tickets the viewer may see, so it never hints at restricted or excluded ones.
  const vis = ticketVisibleTo(viewer, "t");
  const role = viewer.role;
  const rows = await db
    .prepare(
      `SELECT q.*, (SELECT COUNT(*) FROM mail_tickets t
                     WHERE t.queue_tag = q.tag AND t.status <> 'closed' AND ${vis.sql}) AS open_tickets
         FROM mail_queues q ORDER BY q.tag`,
    )
    .bind(...vis.binds)
    .all<QueueRowWithEscalation & { open_tickets: number }>();
  // A queue's restricted state is its flag or its tag (3a's isRestrictedQueue), so the filter
  // for a non-owner is applied here and not in SQL.
  return (rows.results ?? [])
    .map((r) => toQueue(r, r.open_tickets))
    .filter((q) => role === "owner" || !q.restricted);
}

async function requireEligible(
  db: D1Database,
  userId: number,
  restricted: boolean,
  what: string,
): Promise<void> {
  if (!(await isEligibleAssignee(db, userId, restricted, null))) {
    throw new MailAdminError(
      422,
      "ineligible_assignee",
      restricted
        ? `${what} must be an owner on a restricted queue (account ${userId}).`
        : `${what} must be an approved admin or owner (account ${userId}).`,
    );
  }
}

export async function putQueue(
  db: D1Database,
  viewer: { id: number; role: string },
  tag: string,
  req: PutQueueRequest,
): Promise<MailQueue> {
  if (tag !== FALLBACK_QUEUE_TAG && !QUEUE_TAG.test(tag)) {
    throw new MailAdminError(
      400,
      "bad_request",
      "A queue tag is lowercase letters, digits, . _ -.",
    );
  }
  const existing = await db
    .prepare("SELECT * FROM mail_queues WHERE tag = ?")
    .bind(tag)
    .first<QueueRowWithEscalation>();

  const restricted = req.restricted ?? (existing ? isRestrictedQueue(tag, existing) : false);
  if (RESTRICTED_TAGS.has(tag) && !restricted) {
    throw new MailAdminError(422, "restricted_locked", `The ${tag} queue is always restricted.`);
  }
  if (tag === FALLBACK_QUEUE_TAG && restricted) {
    throw new MailAdminError(
      422,
      "fallback_not_restrictable",
      "The fallback queue cannot be restricted: it receives mail for every unrouted address.",
    );
  }
  const wasRestricted = existing ? isRestrictedQueue(tag, existing) : false;
  if (existing && restricted !== wasRestricted) {
    // Open tickets copied the flag at creation, so changing the queue's would leave them on
    // the old rule. Refuse rather than rewrite who can see them.
    const open = await db
      .prepare("SELECT COUNT(*) AS n FROM mail_tickets WHERE queue_tag = ? AND status <> 'closed'")
      .bind(tag)
      .first<{ n: number }>();
    if ((open?.n ?? 0) > 0) {
      throw new MailAdminError(
        409,
        "restricted_flag_busy",
        "This queue has tickets that are not closed, so its restricted flag cannot change. Close or move them first.",
      );
    }
  }

  const strategy: QueueStrategy = req.strategy ?? existing?.strategy ?? "pool";
  const assignee =
    req.assignee_user_id !== undefined
      ? req.assignee_user_id
      : (existing?.assignee_user_id ?? null);
  const backup =
    req.backup_user_id !== undefined ? req.backup_user_id : (existing?.backup_user_id ?? null);
  const escalation =
    req.escalation_user_id !== undefined
      ? req.escalation_user_id
      : (existing?.escalation_user_id ?? null);
  const storedMembers = existing ? parseRrMembers(existing.rr_members) : [];
  let members = req.rr_members !== undefined ? req.rr_members : storedMembers;
  members = [...new Set(members)];
  if (members.length > MAX_RR_MEMBERS) {
    throw new MailAdminError(
      400,
      "bad_request",
      `A queue rotation has at most ${MAX_RR_MEMBERS} members.`,
    );
  }

  // Everyone named has to be eligible under the queue's FINAL flag, including people already
  // stored: unrestricting is refused above while tickets are open, but restricting an empty queue
  // must not leave a non-owner listed.
  if (assignee !== null) await requireEligible(db, assignee, restricted, "The assignee");
  if (backup !== null) await requireEligible(db, backup, restricted, "The backup");
  for (const m of members) await requireEligible(db, m, restricted, "A rotation member");
  if (escalation !== null) await requireEligible(db, escalation, true, "The escalation owner");

  const membersChanged = JSON.stringify(members) !== JSON.stringify(storedMembers);
  await db
    .prepare(
      `INSERT INTO mail_queues (tag, restricted, strategy, assignee_user_id, backup_user_id,
          rr_members, rr_cursor, escalation_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
       ON CONFLICT(tag) DO UPDATE SET
         restricted = excluded.restricted,
         strategy = excluded.strategy,
         assignee_user_id = excluded.assignee_user_id,
         backup_user_id = excluded.backup_user_id,
         rr_members = excluded.rr_members,
         rr_cursor = CASE WHEN ? = 1 THEN 0 ELSE mail_queues.rr_cursor END,
         escalation_user_id = excluded.escalation_user_id,
         updated_at = datetime('now')`,
    )
    .bind(
      tag,
      restricted ? 1 : 0,
      strategy,
      assignee,
      backup,
      JSON.stringify(members),
      escalation,
      membersChanged ? 1 : 0,
    )
    .run();
  const [queue] = (await listQueues(db, viewer)).filter((q) => q.tag === tag);
  return queue;
}

// ---------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------

interface AvailabilityRow {
  user_id: number;
  away_from: string | null;
  away_until: string | null;
  backup_user_id: number | null;
  note: string | null;
}

export async function getAvailability(db: D1Database, userId: number): Promise<Availability> {
  const row = await db
    .prepare(
      "SELECT user_id, away_from, away_until, backup_user_id, note FROM mail_availability WHERE user_id = ?",
    )
    .bind(userId)
    .first<AvailabilityRow>();
  return (
    row ?? { user_id: userId, away_from: null, away_until: null, backup_user_id: null, note: null }
  );
}

function instant(value: string | null | undefined, name: string): string | null {
  if (value === null || value === undefined) return null;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) {
    throw new MailAdminError(400, "bad_request", `${name} is not an ISO 8601 instant.`);
  }
  return t.toISOString();
}

/** Set (merge into) one person's away window. The person must be able to hold tickets. */
export async function putAvailability(
  db: D1Database,
  userId: number,
  req: PutAvailabilityRequest,
): Promise<Availability> {
  if (!(await isEligibleAssignee(db, userId, false, null))) {
    throw new MailAdminError(422, "ineligible_assignee", "That account is not an admin or owner.");
  }
  const current = await getAvailability(db, userId);
  const from =
    req.away_from !== undefined ? instant(req.away_from, "away_from") : current.away_from;
  const until =
    req.away_until !== undefined ? instant(req.away_until, "away_until") : current.away_until;
  const backup = req.backup_user_id !== undefined ? req.backup_user_id : current.backup_user_id;
  const note = req.note !== undefined ? req.note : current.note;
  if (from !== null && until !== null && !(from < until)) {
    throw new MailAdminError(400, "bad_request", "away_until must be after away_from.");
  }
  if (backup !== null) {
    if (backup === userId) {
      throw new MailAdminError(422, "ineligible_assignee", "A person cannot be their own backup.");
    }
    await requireEligible(db, backup, false, "The backup");
  }
  if (from === null && until === null && backup === null && !note) {
    await db.prepare("DELETE FROM mail_availability WHERE user_id = ?").bind(userId).run();
    return getAvailability(db, userId);
  }
  await db
    .prepare(
      `INSERT INTO mail_availability (user_id, away_from, away_until, backup_user_id, note, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET away_from = excluded.away_from,
         away_until = excluded.away_until, backup_user_id = excluded.backup_user_id,
         note = excluded.note, updated_at = datetime('now')`,
    )
    .bind(userId, from, until, backup, note ? note.slice(0, 500) : null)
    .run();
  return getAvailability(db, userId);
}
