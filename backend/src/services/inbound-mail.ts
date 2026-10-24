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

import { clampUtf8Bytes } from "../lib/utf8";
import { redactAddressIn, redactRecipient } from "./email";
import { ingestInboundMessage } from "./tickets";

/** What the handler needs of the Worker's env; structural, like EmailDeliveryEnv. */
export interface InboundMailEnv {
  MAIL_INBOUND?: R2Bucket;
  /** When bound, a stored message is also turned into a ticket (phase 3). */
  DB?: D1Database;
}

/** The SMTP reason a sender sees when this Worker holds no inbound bucket. */
export const INBOUND_REJECT_REASON = "This address does not accept mail";

/**
 * R2 holds 2 KiB of custom metadata per object, counting the UTF-8 bytes of keys and values.
 * Each of the three header-derived values is clamped to this many bytes, so the four keys, the
 * 24-byte timestamp and the three values come to under 1.3 KiB.
 */
const METADATA_VALUE_MAX_BYTES = 400;

/** `inbound/raw/YYYY/MM/DD/<uuid>.eml`, the date being the UTC day of receipt. */
export function inboundRawKey(receivedAt: Date, id: string = crypto.randomUUID()): string {
  const iso = receivedAt.toISOString();
  return `inbound/raw/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${id}.eml`;
}

const clamp = (value: string): string => clampUtf8Bytes(value, METADATA_VALUE_MAX_BYTES);

/**
 * Store one inbound message in `MAIL_INBOUND`, or reject it when there is no bucket. A write
 * that fails with its metadata is retried once without it, since the raw message carries the same
 * headers; a write that fails twice throws, so Email Routing reports the delivery as failed
 * instead of losing the message.
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

  // `raw` is a single-use stream: read it once, whole. It is buffered rather than streamed to R2
  // because a failed put with metadata is retried without it, which needs the bytes again; the
  // platform caps a message at 25 MiB, which a Worker holds without strain.
  const raw = await new Response(message.raw).arrayBuffer();
  const receivedAt = new Date();
  const key = inboundRawKey(receivedAt);
  const httpMetadata = { contentType: "message/rfc822" };
  try {
    await bucket.put(key, raw, {
      httpMetadata,
      customMetadata: {
        envelope_from: clamp(message.from),
        envelope_to: clamp(message.to),
        received_at: receivedAt.toISOString(),
        message_id: clamp(message.headers.get("message-id") ?? ""),
      },
    });
  } catch (error) {
    // The raw .eml holds the From, To and Message-ID headers, so a message stored without
    // metadata is still whole; losing it is not.
    console.warn(
      `[inbound-mail] put with metadata failed for ${key} (${error instanceof Error ? error.message : String(error)}); retrying without it`,
    );
    await bucket.put(key, raw, { httpMetadata });
  }
  console.log(
    `[inbound-mail] stored ${key} (${raw.byteLength} bytes) from ${redactRecipient(message.from)} to ${redactRecipient(message.to)}`,
  );

  // Everything below is a working copy of the stored message. The raw object is the record, so a
  // failure here is logged and swallowed: the message is not lost and `reprocessRawKey` rebuilds
  // the ticket. Throwing would only make Email Routing redeliver a message that is already kept.
  if (!env.DB) return;
  try {
    const result = await ingestInboundMessage(env.DB, {
      rawKey: key,
      raw,
      envelopeFrom: message.from,
      envelopeTo: message.to,
      receivedAt,
    });
    console.log(
      `[inbound-mail] ${key} ${result.outcome} ticket ${result.ticketId} (${result.status})`,
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.error(
      `[inbound-mail] ticketing failed for ${key}, raw message kept: ${redactAddressIn(redactAddressIn(text, message.from), message.to)}`,
    );
  }
}
