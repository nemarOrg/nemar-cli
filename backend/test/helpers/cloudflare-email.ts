// The external boundary for tests of the Cloudflare mail provider (epic #1893, ADR 0110).
//
// Not a mock of the email service: services/email.ts runs unchanged. Only what stands behind
// `env.EMAIL`, the `send_email` binding, is replaced by a recorder, the way `withFakeResend`
// redirects `api.resend.com` to a local server. It exists because the binding's failures carry a
// Cloudflare `.code` that Miniflare's simulator never raises (email-send-binding.test.ts drives
// the simulator for what it does implement).

import type { CloudflareSendEmail } from "../../src/services/email";

export type BindingMessage = Parameters<CloudflareSendEmail["send"]>[0];

// The Cloudflare Email Service's header rules, restated here on purpose (not imported from
// services/email.ts) so a test cannot pass by sharing a mistake with the code under test.
// https://developers.cloudflare.com/email-service/reference/headers/
const API_FIELD_HEADERS = ["from", "to", "cc", "bcc", "subject", "reply-to"];
const ALLOWED_HEADERS = [
  "in-reply-to",
  "references",
  "thread-index",
  "thread-topic",
  "precedence",
  "auto-submitted",
  "content-language",
  "keywords",
  "comments",
  "importance",
  "priority",
  "sensitivity",
  "organization",
  "require-recipient-valid-since",
  "expires",
  "reply-by",
  "archived-at",
];

/** The error the real service raises for a header, or undefined when it accepts all of them. */
export function headerRefusal(headers: Record<string, string> | undefined): Error | undefined {
  for (const name of Object.keys(headers ?? {})) {
    const lower = name.toLowerCase();
    if (API_FIELD_HEADERS.includes(lower)) {
      return bindingError(
        "E_HEADER_USE_API_FIELD",
        `custom header '${name}' must be set through its API field`,
      );
    }
    const ok =
      ALLOWED_HEADERS.includes(lower) ||
      /^x-[a-z0-9\-_]+$/.test(lower) ||
      /^list-[a-z0-9\-]+$/.test(lower);
    if (!ok) {
      return bindingError(
        "E_HEADER_NOT_ALLOWED",
        `custom header '${name}' is not allowed. Only whitelisted headers and X-* headers are accepted.`,
      );
    }
  }
  return undefined;
}

/**
 * A `send_email` binding that records what it is handed and refuses, as the real service does, a
 * message carrying a header the platform controls (`Message-ID`, `Date`, ...): such a send throws
 * and is NOT recorded as accepted work, so a test that sets one fails. `failure`, when given, is
 * called per send with the message and returns what to throw (or undefined to let that send
 * succeed). Each accepted send answers a distinct valid Message-ID.
 */
export function recordingBinding(failure?: (message: BindingMessage) => unknown) {
  const sent: BindingMessage[] = [];
  let counter = 0;
  const binding: CloudflareSendEmail = {
    async send(message) {
      sent.push(message);
      const refused = headerRefusal(message.headers);
      if (refused) throw refused;
      const thrown = failure?.(message);
      if (thrown !== undefined) throw thrown;
      counter += 1;
      return { messageId: `<${counter}.recorded@staging.nemar.test>` };
    },
  };
  return { binding, sent };
}

/** An error the way the binding raises one: an Error with a `code`. */
export function bindingError(code: string | undefined, message = "refused"): Error {
  return Object.assign(new Error(message), code ? { code } : {});
}
