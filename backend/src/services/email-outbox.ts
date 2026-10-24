/**
 * Announcement outbox consumer (epic #1893 phase 2, ADR 0110).
 *
 * `nemar admin notify` on the Cloudflare provider enqueues one {@link BroadcastOutboxMessage}
 * per recipient (services/broadcast.ts). This module sends each through `sendEmail`, so the
 * dev fence, the [DEV] wrap and the provider selection apply exactly as for any other mail,
 * and records the outcome on the `broadcast_emails` row.
 *
 * The one rule that shapes everything: a send whose outcome is unknown is NEVER retried. A
 * timeout or an internal error may have been accepted by the provider with only the answer
 * lost, and a retry would deliver the announcement twice. Only a Cloudflare rate or daily
 * limit, which says nothing was delivered, is retried, later.
 */

import type { BroadcastEnv, BroadcastOutboxMessage } from "./broadcast";
import { buildBroadcastHtml, markdownToEmailHtml } from "./broadcast";
import {
  BROADCAST_SEND_TIMEOUT_MS,
  CLOUDFLARE_LIMIT_CODES,
  EmailRejectedError,
  isCertainNonDelivery,
  redactAddressIn,
  redactRecipient,
  resolveEmailConfig,
  sendEmail,
} from "./email";

/** Seconds before a rate-limited message is tried again. */
export const OUTBOX_LIMIT_RETRY_DELAY_SECONDS = 300;
/** Seconds before a message is retried after the audit row could not be read (nothing was sent). */
const ROW_READ_RETRY_DELAY_SECONDS = 60;

export function isBroadcastOutboxMessage(body: unknown): body is BroadcastOutboxMessage {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    b.kind === "broadcast" &&
    typeof b.broadcast_id === "number" &&
    Number.isInteger(b.broadcast_id) &&
    typeof b.to === "string" &&
    b.to !== ""
  );
}

interface BroadcastRow {
  subject: string;
  body_markdown: string;
}

/** What {@link handleOutboxBatch} needs of the Worker env: the bindings that send and the DB. */
export type OutboxEnv = BroadcastEnv & {
  DB: D1Database;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  REPLY_TO?: string;
};

/** `status` turns `done` in the same statement that records the last outcome. */
const DONE_WHEN_COMPLETE = (outcomeSum: string) =>
  `status = CASE WHEN status = 'queued' AND ${outcomeSum} >= queued_count THEN 'done' ELSE status END`;

const DELIVERED_SQL = `UPDATE broadcast_emails
   SET delivered_count = delivered_count + 1,
       ${DONE_WHEN_COMPLETE("delivered_count + 1 + failure_count + unknown_count")}
 WHERE id = ?`;

const UNKNOWN_SQL = `UPDATE broadcast_emails
   SET unknown_count = unknown_count + 1,
       ${DONE_WHEN_COMPLETE("delivered_count + failure_count + unknown_count + 1")}
 WHERE id = ?`;

const FAILED_SQL = `UPDATE broadcast_emails
   SET failure_count = failure_count + 1,
       failed_recipients = json_insert(COALESCE(failed_recipients, '[]'), '$[#]', ?),
       ${DONE_WHEN_COMPLETE("delivered_count + failure_count + 1 + unknown_count")}
 WHERE id = ?`;

/**
 * Process one batch of broadcast messages, one at a time (the queue is configured with
 * `max_concurrency = 1`, and the sequential sends are what paces them under the provider's
 * rate limit). Every message is acked or retried; this function does not throw for a
 * per-message problem.
 */
export async function handleOutboxBatch(
  messages: ReadonlyArray<Message<BroadcastOutboxMessage>>,
  env: OutboxEnv,
): Promise<void> {
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  const rows = new Map<number, BroadcastRow | null>();

  for (const message of messages) {
    const { broadcast_id: id, to } = message.body;
    const who = redactRecipient(to);

    let row = rows.get(id);
    if (row === undefined) {
      try {
        row =
          (await env.DB.prepare("SELECT subject, body_markdown FROM broadcast_emails WHERE id = ?")
            .bind(id)
            .first<BroadcastRow>()) ?? null;
      } catch (error) {
        // Nothing was sent, so a retry cannot duplicate.
        console.error(
          `[email-outbox] could not read broadcast ${id}; retrying:`,
          error instanceof Error ? error.message : String(error),
        );
        message.retry({ delaySeconds: ROW_READ_RETRY_DELAY_SECONDS });
        continue;
      }
      rows.set(id, row);
    }
    if (!row) {
      console.error(`[email-outbox] broadcast ${id} not found; dropping message for ${who}`);
      message.ack();
      continue;
    }

    const html = buildBroadcastHtml(row.subject, markdownToEmailHtml(row.body_markdown));
    let outcome: "delivered" | "failed" | "unknown";
    try {
      await sendEmail(
        to,
        row.subject,
        html,
        env.RESEND_API_KEY ?? "",
        fromEmail,
        replyTo,
        isDev,
        env,
        BROADCAST_SEND_TIMEOUT_MS,
      );
      outcome = "delivered";
    } catch (error) {
      if (
        error instanceof EmailRejectedError &&
        error.code !== undefined &&
        CLOUDFLARE_LIMIT_CODES.has(error.code)
      ) {
        console.warn(`[email-outbox] ${error.code} for broadcast ${id}; retrying in 300s`);
        message.retry({ delaySeconds: OUTBOX_LIMIT_RETRY_DELAY_SECONDS });
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[email-outbox] broadcast ${id} to ${who}:`, redactAddressIn(reason, to));
      outcome = isCertainNonDelivery(error) ? "failed" : "unknown";
    }

    // The outcome is recorded once. If this write fails the mail may already be out, so the
    // message is acked regardless: a retry would send it again.
    try {
      if (outcome === "delivered") await env.DB.prepare(DELIVERED_SQL).bind(id).run();
      else if (outcome === "unknown") await env.DB.prepare(UNKNOWN_SQL).bind(id).run();
      else await env.DB.prepare(FAILED_SQL).bind(who, id).run();
    } catch (error) {
      console.error(
        `[email-outbox] could not record ${outcome} for broadcast ${id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    message.ack();
  }
}
