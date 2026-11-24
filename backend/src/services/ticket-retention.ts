/**
 * Support-ticket retention (epic #1893 phase 6a, ADR 0112): after `MAIL_RETENTION_DAYS` days without
 * activity (`last_activity_at`: an inbound message, reply, note, status change, assign or escalate;
 * not a summary), a ticket keeps its summary and its metadata and loses everything else.
 *
 * What a purge does, for each ticket in ONE D1 batch (so a ticket is wholly purged or untouched):
 *   - notes the raw keys of its messages in `mail_purged_raw_keys`, then deletes the messages and
 *     the reply keys;
 *   - clears every event's `detail` (kind, actor and time stay), and adds a `purged` event;
 *   - deletes the tags other than the queue tag (a tag is written by whoever composed the address);
 *   - clears `requester_email` and `subject` to the empty string (both are NOT NULL in 0102), and
 *     nulls the requester and the assignee; `excluded_user_id` is KEPT, so the exclusion still
 *     applies to the summary; open, pending and escalated become `closed` (spam and closed stay as
 *     they are); `summary` and its author and time are kept.
 *
 * It never touches R2 (the bucket's lifecycle rule owns raw deletion) and never sends mail. It
 * reads and writes only this environment's own mail tables, which is why it may run on the
 * non-production daily tick (DEV_CRON_ALLOWLIST).
 *
 * A missing or invalid `MAIL_RETENTION_DAYS` deletes nothing: there is no default that deletes.
 * A re-run finds nothing, because only tickets with `purged_at IS NULL` are selected.
 *
 * Some queues keep their tickets longer (`QUEUE_RETENTION_DAYS`, ADR 0112 amendment of 2026-11-22):
 * a ticket in one of them is purged only once BOTH `MAIL_RETENTION_DAYS` and its queue's period have
 * passed. The governing queue is the ticket's `queue_tag`, which no code path changes after the
 * ticket is created, so it is the queue the ticket was filed in and the queue it is in at purge time.
 * Tags (`mail_ticket_tags`) are written by whoever composed the address and are never read here.
 */

import type { Bindings } from "../types/bindings";
import { LEGAL_PROCESS_QUEUE_TAG } from "./ticket-assignment";

/**
 * Queues whose tickets are kept longer than `MAIL_RETENTION_DAYS`, in days, declared once here and
 * not on the queue row: a row is data an operator can edit or delete, and a deleted row must not
 * shorten a legal record (the same reasoning as RESTRICTED_TAGS). The figure is a floor, never a
 * shortening: a queue's tickets are kept for the longer of this and `MAIL_RETENTION_DAYS`.
 *
 * `legal-process` holds official requests for compute records and is kept 2557 days, seven years
 * (7 x 365 plus the at most two leap days seven years can hold), the period the compute records keep.
 */
export const QUEUE_RETENTION_DAYS: ReadonlyMap<string, number> = new Map([
  [LEGAL_PROCESS_QUEUE_TAG, 2557],
]);

for (const [tag, days] of QUEUE_RETENTION_DAYS) {
  // Both are spliced into SQL below as literals, so hold them to a shape that cannot quote out.
  if (!/^[a-z0-9._-]{1,64}$/.test(tag) || !Number.isInteger(days) || days < 1 || days > 36_500) {
    throw new Error(`ticket-retention: bad QUEUE_RETENTION_DAYS entry ${tag}`);
  }
}

/**
 * The SQL that keeps a ticket whose queue's own period has not passed, measured back from the
 * run's stamp (a `YYYY-MM-DD HH:MM:SS` parameter, so `datetime` writes the same form). It is ANDed
 * onto the general cutoff test, so a queue's period only ever adds to `MAIL_RETENTION_DAYS`.
 */
function queueRetentionSql(stampParam: string): string {
  return [...QUEUE_RETENTION_DAYS]
    .map(
      ([tag, days]) =>
        ` AND NOT (queue_tag = '${tag}' AND last_activity_at >= datetime(${stampParam}, '-${days} days'))`,
    )
    .join("");
}

export type PurgeOutcome =
  | { status: "skipped"; reason: "retention_not_configured" }
  | {
      status: "ok";
      /** The cutoff used: tickets whose last activity is strictly older were purged, except those
       *  of a queue in `QUEUE_RETENTION_DAYS` whose own longer period had not passed. */
      cutoff: string;
      purged: number;
      /** Of `purged`, how many were not closed or spam when purged. */
      purgedOpen: number;
      /** Tickets whose batch threw; they stay unpurged and are tried again on the next run. */
      failed: number;
    };

export interface PurgeOptions {
  /** Tickets read per page (default 200). */
  pageSize?: number;
  /** Pages per run (default 10), so one run is bounded. */
  maxPages?: number;
  /** Stop before the next ticket once this many milliseconds have passed (default 20000). */
  budgetMs?: number;
}

/** `MAIL_RETENTION_DAYS` as a whole number of days from 1 to 36500, else null. */
export function retentionDays(env: Pick<Bindings, "MAIL_RETENTION_DAYS">): number | null {
  const raw = env.MAIL_RETENTION_DAYS;
  if (typeof raw !== "string" || !/^[1-9]\d{0,4}$/.test(raw)) return null;
  const days = Number(raw);
  return days <= 36_500 ? days : null;
}

/** `YYYY-MM-DD HH:MM:SS`, the form SQLite's `datetime('now')` writes. */
function sqlDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The statements that purge one ticket, in ONE batch (a transaction). The first is the guarded
 * UPDATE that claims it: it applies only while the ticket is not purged, its last activity is
 * still older than `cutoff` and its queue's own period (`QUEUE_RETENTION_DAYS`, measured back from
 * `stamp`) has passed, so a message, note or action that arrived after the page was read
 * cancels this ticket's purge. Every later statement is gated on that claim (`purged_at` equal to
 * this run's stamp), so a lost claim changes nothing.
 */
export function purgeStatements(
  db: D1Database,
  id: number,
  stamp: string,
  cutoff: string,
): D1PreparedStatement[] {
  const claimed = "EXISTS (SELECT 1 FROM mail_tickets WHERE id = ?1 AND purged_at = ?2)";
  return [
    db
      .prepare(
        `UPDATE mail_tickets SET requester_email = '', subject = '', requester_user_id = NULL,
            assignee_user_id = NULL,
            status = CASE WHEN status IN ('open', 'pending', 'escalated') THEN 'closed' ELSE status END,
            purged_at = ?2, updated_at = ?2
          WHERE id = ?1 AND purged_at IS NULL AND last_activity_at < ?3${queueRetentionSql("?2")}`,
      )
      .bind(id, stamp, cutoff),
    // Chained on the claim: one row only if this run is the one that purged it.
    db
      .prepare(
        `INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail, created_at)
         SELECT ?, 'purged', NULL, NULL, ? WHERE changes() > 0`,
      )
      .bind(id, stamp),
    db
      .prepare(
        `INSERT OR IGNORE INTO mail_purged_raw_keys (raw_key, ticket_id, purged_at)
         SELECT raw_key, ticket_id, ?2 FROM mail_messages
          WHERE ticket_id = ?1 AND raw_key IS NOT NULL AND ${claimed}`,
      )
      .bind(id, stamp),
    db.prepare(`DELETE FROM mail_messages WHERE ticket_id = ?1 AND ${claimed}`).bind(id, stamp),
    db.prepare(`DELETE FROM mail_reply_keys WHERE ticket_id = ?1 AND ${claimed}`).bind(id, stamp),
    db.prepare(`DELETE FROM mail_note_keys WHERE ticket_id = ?1 AND ${claimed}`).bind(id, stamp),
    db
      .prepare(`UPDATE mail_ticket_events SET detail = NULL WHERE ticket_id = ?1 AND ${claimed}`)
      .bind(id, stamp),
    db
      .prepare(
        `DELETE FROM mail_ticket_tags WHERE ticket_id = ?1 AND ${claimed}
            AND tag != (SELECT queue_tag FROM mail_tickets WHERE id = ?1)`,
      )
      .bind(id, stamp),
  ];
}

/** Purge one ticket; true if this call purged it, false if it was no longer eligible. */
export async function purgeOneTicket(
  db: D1Database,
  id: number,
  stamp: string,
  cutoff: string,
): Promise<boolean> {
  const results = await db.batch(purgeStatements(db, id, stamp, cutoff));
  return (results[0]?.meta?.changes ?? 0) > 0;
}

export async function purgeExpiredTickets(
  env: Pick<Bindings, "DB" | "MAIL_RETENTION_DAYS">,
  now: Date = new Date(),
  options: PurgeOptions = {},
): Promise<PurgeOutcome> {
  const days = retentionDays(env);
  if (days === null) {
    console.warn(
      "[ticket-retention] MAIL_RETENTION_DAYS is missing or not a whole number of days; nothing was purged.",
    );
    return { status: "skipped", reason: "retention_not_configured" };
  }
  const pageSize = options.pageSize ?? 200;
  const maxPages = options.maxPages ?? 10;
  const budgetMs = options.budgetMs ?? 20_000;
  const started = Date.now();
  const cutoff = sqlDate(new Date(now.getTime() - days * 86_400_000));
  const stamp = sqlDate(now);
  let purged = 0;
  let purgedOpen = 0;
  let failed = 0;
  // Keyset position: a ticket that failed stays unpurged but is never read again this run.
  let lastActivity = "";
  let lastId = 0;
  let outOfTime = false;

  for (let page = 0; page < maxPages && !outOfTime; page++) {
    const rows = await env.DB.prepare(
      `SELECT id, status, last_activity_at FROM mail_tickets
        WHERE purged_at IS NULL AND last_activity_at < ?1${queueRetentionSql("?5")}
          AND (last_activity_at > ?2 OR (last_activity_at = ?2 AND id > ?3))
        ORDER BY last_activity_at, id LIMIT ?4`,
    )
      .bind(cutoff, lastActivity, lastId, pageSize, stamp)
      .all<{ id: number; status: string; last_activity_at: string }>();
    const tickets = rows.results ?? [];
    if (tickets.length === 0) break;
    for (const ticket of tickets) {
      if (Date.now() - started >= budgetMs) {
        outOfTime = true;
        break;
      }
      lastActivity = ticket.last_activity_at;
      lastId = ticket.id;
      try {
        if (await purgeOneTicket(env.DB, ticket.id, stamp, cutoff)) {
          purged++;
          if (ticket.status !== "closed" && ticket.status !== "spam") purgedOpen++;
        }
      } catch (error) {
        failed++;
        console.error(
          `[ticket-retention] purging ticket ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (tickets.length < pageSize) break;
  }
  console.log(
    `[ticket-retention] purged ${purged} ticket(s), ${purgedOpen} of them not closed or spam, ${failed} failed, cutoff ${cutoff}`,
  );
  return { status: "ok", cutoff, purged, purgedOpen, failed };
}
