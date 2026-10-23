/**
 * Inbound mail (epic #1893 phase 1, ADR 0110): the Worker's `email()` handler body.
 *
 * Email Routing hands each message addressed to a routed address to the Worker. This phase only
 * lands it: the raw message goes to R2 untouched, and one log line says it arrived. No parsing, no
 * D1, no replies; ticketing comes in a later phase.
 *
 * Two fences keep production out of this path. The `MAIL_INBOUND` bucket is bound only in
 * `[env.dev]`, and the routing rules that deliver here exist only for the staging subdomain; a
 * message that reaches a Worker with no bucket is rejected rather than dropped or accepted into
 * nothing, so the sender gets a bounce.
 */

import { redactRecipient } from "./email";

/** What the handler needs of the Worker's env; structural, like EmailDeliveryEnv. */
export interface InboundMailEnv {
  MAIL_INBOUND?: R2Bucket;
}

/** The SMTP reason a sender sees when this Worker holds no inbound bucket. */
export const INBOUND_REJECT_REASON = "This address does not accept mail";

/** R2 holds 2 KiB of custom metadata per object; each value is clamped well inside that. */
const METADATA_VALUE_MAX = 400;

/** `inbound/raw/YYYY/MM/DD/<uuid>.eml`, the date being the UTC day of receipt. */
export function inboundRawKey(receivedAt: Date, id: string = crypto.randomUUID()): string {
  const iso = receivedAt.toISOString();
  return `inbound/raw/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${id}.eml`;
}

const clamp = (value: string): string => value.slice(0, METADATA_VALUE_MAX);

/**
 * Store one inbound message in `MAIL_INBOUND`, or reject it when there is no bucket. A failed
 * write throws, so Email Routing reports the delivery as failed instead of losing the message.
 */
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: InboundMailEnv,
): Promise<void> {
  const bucket = env.MAIL_INBOUND;
  if (!bucket) {
    message.setReject(INBOUND_REJECT_REASON);
    console.warn(
      `[inbound-mail] rejected a message to ${redactRecipient(message.to)}: MAIL_INBOUND is not bound`,
    );
    return;
  }

  // `raw` is a single-use stream: read it once, whole.
  const raw = await new Response(message.raw).arrayBuffer();
  const receivedAt = new Date();
  const key = inboundRawKey(receivedAt);
  await bucket.put(key, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      envelope_from: clamp(message.from),
      envelope_to: clamp(message.to),
      received_at: receivedAt.toISOString(),
      message_id: clamp(message.headers.get("message-id") ?? ""),
    },
  });
  console.log(
    `[inbound-mail] stored ${key} (${raw.byteLength} bytes) from ${redactRecipient(message.from)} to ${redactRecipient(message.to)}`,
  );
}
