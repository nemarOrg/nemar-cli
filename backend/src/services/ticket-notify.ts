/**
 * Mail to the admins about support tickets (epic #1893 phase 3b, ADR 0111).
 *
 * Category `support_tickets`, each admin's own preference, and the same production-only fence as
 * every admin notification ({@link isAdminNotificationAllowed}): a non-production Worker shares the
 * production `users` table, so this sends nothing there unless DEV_ADMIN_NOTIFICATIONS is "1".
 * Unlike getAdminEmailsForCategory there is NO "everyone opted out, send to the first admin"
 * fallback: a restricted ticket must never reach someone who may not see it, and a ticket stream an
 * admin switched off is switched off.
 *
 * Recipients follow the ticket's own rules and not the account kind or username:
 *   - an assigned ticket goes to its assignee;
 *   - an unassigned one to every admin who can work it (owners only when restricted), minus the
 *     account the ticket excludes;
 *   - an escalation to the person it was escalated to.
 * Everything here is best effort: a failure is logged with the address redacted and never reaches
 * the caller, so a ticket is never lost to a mail problem.
 *
 * Stored subjects, queue tags and reasons come from outside, so they are HTML-escaped in the body
 * and stripped of control characters in the subject line. The requester's address is never put in
 * a notification.
 */

import { escapeHtml } from "../lib/escape";
import {
  type AdminNotificationEnv,
  type EmailDeliveryEnv,
  isAdminNotificationAllowed,
  parseEmailPreferences,
  redactAddressIn,
  resolveEmailConfig,
  sendEmail,
} from "./email";

export interface TicketNotifyEnv extends AdminNotificationEnv, EmailDeliveryEnv {
  FROM_EMAIL?: string;
  REPLY_TO?: string;
  RESEND_API_KEY?: string;
}

interface TicketRow {
  id: number;
  ref: string;
  queue_tag: string;
  restricted: number;
  excluded_user_id: number | null;
  status: string;
  assignee_user_id: number | null;
  subject: string;
}

interface Candidate {
  id: number;
  email: string;
  email_preferences: string | null;
}

/** Control characters and the Unicode line separators, built from escapes so no tool rewrites them. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

/** A value safe for a header or a log line: control characters gone, whitespace collapsed, bounded. */
export function plainLine(value: string, max = 200): string {
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

async function recipients(
  db: D1Database,
  ticket: TicketRow,
  to: "assignee_or_pool" | number,
): Promise<Candidate[]> {
  const restricted = ticket.restricted === 1;
  const roles = restricted ? "'owner'" : "'owner', 'admin'";
  const base = `SELECT id, email, email_preferences FROM users
                 WHERE status = 'approved' AND deleted_at IS NULL AND role IN (${roles})
                   AND (? IS NULL OR id <> ?)`;
  const excluded = ticket.excluded_user_id;
  const target = to === "assignee_or_pool" ? ticket.assignee_user_id : to;
  const rows =
    target !== null
      ? await db.prepare(`${base} AND id = ?`).bind(excluded, excluded, target).all<Candidate>()
      : await db.prepare(base).bind(excluded, excluded).all<Candidate>();
  return (rows.results ?? []).filter(
    (r) => parseEmailPreferences(r.email_preferences).support_tickets,
  );
}

async function sendTicketMail(
  env: TicketNotifyEnv,
  people: Candidate[],
  subject: string,
  heading: string,
  ticket: TicketRow,
  extra: string,
): Promise<number> {
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  const html = `<!DOCTYPE html>
<html><body style="font-family: sans-serif; line-height: 1.5; color: #333;">
<h2>${escapeHtml(heading)}</h2>
<p><strong>Ticket:</strong> ${escapeHtml(ticket.ref)} (id ${ticket.id})<br>
<strong>Queue:</strong> ${escapeHtml(ticket.queue_tag)}<br>
<strong>Subject:</strong> ${escapeHtml(plainLine(ticket.subject) || "(no subject)")}</p>
${extra}
<p style="color: #666; font-size: 14px;">Read and answer it through the admin API
(GET /admin/mail/tickets/${ticket.id}). You receive this because the support ticket notification
category is on for your account; change it with <code>nemar admin email-preferences</code>.</p>
</body></html>`;
  let sent = 0;
  for (const person of people) {
    try {
      await sendEmail(
        person.email,
        subject,
        html,
        env.RESEND_API_KEY ?? "",
        fromEmail,
        replyTo,
        isDev,
        env,
      );
      sent += 1;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error(
        `[ticket-notify] send failed for ticket ${ticket.id}: ${redactAddressIn(text, person.email)}`,
      );
    }
  }
  return sent;
}

async function loadTicket(db: D1Database, ticketId: number): Promise<TicketRow | null> {
  return db
    .prepare(
      `SELECT id, ref, queue_tag, restricted, excluded_user_id, status, assignee_user_id, subject
         FROM mail_tickets WHERE id = ?`,
    )
    .bind(ticketId)
    .first<TicketRow>();
}

/**
 * Tell the people who can act that a ticket exists. Spam and closed tickets notify nobody.
 * Returns how many mails were handed to the provider.
 */
export async function notifyTicketCreated(
  env: TicketNotifyEnv,
  db: D1Database,
  ticketId: number,
): Promise<number> {
  try {
    if (!isAdminNotificationAllowed(env)) return 0;
    const ticket = await loadTicket(db, ticketId);
    if (!ticket || ticket.status === "spam" || ticket.status === "closed") return 0;
    const people = await recipients(db, ticket, "assignee_or_pool");
    if (people.length === 0) return 0;
    const assigned = ticket.assignee_user_id !== null;
    return await sendTicketMail(
      env,
      people,
      `[NEMAR support] ${assigned ? "Assigned to you" : "New ticket"} ${ticket.ref}: ${plainLine(ticket.subject, 120) || "(no subject)"}`,
      assigned ? "A support ticket was assigned to you" : "A new support ticket needs an owner",
      ticket,
      "",
    );
  } catch (error) {
    console.error(
      `[ticket-notify] creation notice failed for ticket ${ticketId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}

/** Tell the escalation owner a ticket was handed to them. */
export async function notifyTicketEscalated(
  env: TicketNotifyEnv,
  db: D1Database,
  ticketId: number,
  ownerId: number,
  reason: string | null,
): Promise<number> {
  try {
    if (!isAdminNotificationAllowed(env)) return 0;
    const ticket = await loadTicket(db, ticketId);
    if (!ticket) return 0;
    const people = await recipients(db, ticket, ownerId);
    if (people.length === 0) return 0;
    const why = reason
      ? `<p><strong>Reason:</strong> ${escapeHtml(plainLine(reason, 500))}</p>`
      : "";
    return await sendTicketMail(
      env,
      people,
      `[NEMAR support] Escalated ${ticket.ref}: ${plainLine(ticket.subject, 120) || "(no subject)"}`,
      "A support ticket was escalated to you",
      ticket,
      why,
    );
  } catch (error) {
    console.error(
      `[ticket-notify] escalation notice failed for ticket ${ticketId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}
