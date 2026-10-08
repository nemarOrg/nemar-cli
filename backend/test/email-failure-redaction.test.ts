/**
 * A failed admin send names no address in full, in a log line or in a stored failure.
 *
 * `sendEmail`'s error text carries the recipient ("Failed to send email from F to R: ..."), so a
 * catch that redacts the address it prints beside the text and then prints the text has logged the
 * address once anyway. Driven through the real senders, with Resend answering 500 from a local
 * server (`withFakeResend`), so the message is the one `sendEmail` really builds.
 */

import { describe, expect, test } from "bun:test";
import {
  type EmailDeliveryEnv,
  redactAddressIn,
  redactRecipient,
  sendAdminNotificationEmail,
  sendExemplarInvariantAlertEmail,
  sendImportQuarantineEmail,
  sendStalenessAdminReviewEmail,
  sendUploadAccessRequestEmail,
} from "../src/services/email";
import { withFakeResend } from "./helpers/resend";

const ADMIN = "Grace.Hopper@example.org";
const PRODUCTION: EmailDeliveryEnv = { ENVIRONMENT: "production" };
const SEND = ["re_test", "NEMAR <noreply@nemar.test>", undefined, false, PRODUCTION] as const;

/** Run `fn` with console.error captured; the lines it printed, each argument as text. */
async function logged(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "),
    );
  };
  try {
    await withFakeResend(
      async () => {
        await fn();
      },
      { status: 500 },
    );
  } finally {
    console.error = real;
  }
  return lines.join("\n");
}

describe("redactAddressIn", () => {
  test("every occurrence goes, whatever its letter case", () => {
    const text = `Failed to send email from F to ${ADMIN}: refused (${ADMIN.toLowerCase()}, ${ADMIN.toUpperCase()})`;
    const out = redactAddressIn(text, ADMIN);
    expect(out.toLowerCase()).not.toContain(ADMIN.toLowerCase());
    expect(out.split(redactRecipient(ADMIN)).length - 1).toBe(3);
  });

  test("an address is matched literally, not as a pattern", () => {
    // `+` and `.` mean something in a pattern; a lookalike must not be redacted, and a `$` in the
    // address must not turn the replacement into a pattern.
    const address = "a.b+c$@example.org";
    expect(redactAddressIn("aXb+c$@example.org and a.b+c$@example.org", address)).toBe(
      `aXb+c$@example.org and ${redactRecipient(address)}`,
    );
    expect(redactAddressIn("nothing here", address)).toBe("nothing here");
    expect(redactAddressIn("keep", "")).toBe("keep");
  });
});

describe("a failed admin send logs and stores no address in full", () => {
  test("the new-account notice", async () => {
    const text = await logged(() =>
      sendAdminNotificationEmail(
        [ADMIN],
        { username: "u", email: "u@example.org", github_username: null, description: "d" },
        ...SEND,
      ),
    );
    expect(text).toContain("Failed to send admin notification to G***@example.org");
    expect(text).toContain("simulated Resend failure");
    expect(text.toLowerCase()).not.toContain(ADMIN.toLowerCase());
  });

  test("the upload-access request, in the log and in the failure it returns", async () => {
    let failures: { recipient: string; error: string }[] = [];
    const text = await logged(async () => {
      const outcome = await sendUploadAccessRequestEmail(
        [ADMIN],
        {
          id: 1,
          username: "u",
          given_name: "G",
          family_name: "H",
          email: "u@example.org",
          orcid: null,
          github_username: "u",
          city: "c",
          country: "k",
          affiliation: null,
          why: "w",
        },
        ...SEND,
      );
      failures = outcome.failures;
    });
    expect(failures).toHaveLength(1);
    // The documented contract of the shape: a failure is safe to log as it stands.
    expect(failures[0]?.recipient).toBe("G***@example.org");
    expect(failures[0]?.error.toLowerCase()).not.toContain(ADMIN.toLowerCase());
    expect(failures[0]?.error).toContain("simulated Resend failure");
    expect(text.toLowerCase()).not.toContain(ADMIN.toLowerCase());
  });

  test("the import quarantine alert", async () => {
    const text = await logged(() =>
      sendImportQuarantineEmail(
        [ADMIN],
        { datasetId: "on000001", sourceId: "s", stage: "x", reason: "r", workflowRunUrl: null },
        ...SEND,
      ),
    );
    expect(text).toContain("Failed to send import-quarantine alert to G***@example.org");
    expect(text.toLowerCase()).not.toContain(ADMIN.toLowerCase());
  });

  test("the staleness review", async () => {
    const text = await logged(() =>
      sendStalenessAdminReviewEmail([ADMIN], "nm000001", "name", null, null, ...SEND),
    );
    expect(text).toContain("Failed to send staleness review email to G***@example.org");
    expect(text.toLowerCase()).not.toContain(ADMIN.toLowerCase());
  });

  test("the exemplar invariant alert", async () => {
    const text = await logged(() => sendExemplarInvariantAlertEmail([ADMIN], 1, ...SEND));
    expect(text).toContain("Failed to send exemplar-invariant alert to G***@example.org");
    expect(text.toLowerCase()).not.toContain(ADMIN.toLowerCase());
  });
});
