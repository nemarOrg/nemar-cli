/**
 * Tests for the non-production email delivery fence (issue #957): dev D1 is
 * not purged of the `users` table (roughly 609 real addresses, see
 * AGENTS.md) and the dev worker holds a live RESEND_API_KEY, so a manual
 * send (a per-user transactional email, or `nemar admin notify`'s group
 * broadcast) must not be able to reach a real address outside production.
 *
 * Covers:
 *   - isRecipientAllowlisted / isEmailDeliveryAllowed / redactRecipient:
 *     the pure predicates, exhaustively.
 *   - sendEmail's fence (driven through a real exported wrapper,
 *     sendRevocationEmail -- not a hand-copied re-implementation): a
 *     suppressed send never reaches the network and rejects with
 *     DevEmailFenceError; an allowed send passes the fence and reaches the
 *     real fetch boundary. The Resend host is redirected to a local
 *     Bun.serve() instance rather than mocked, mirroring
 *     zarr-index-v3.test.ts's `getZarrIndex` boundary-redirect pattern --
 *     fetch itself stays real, only its target moves off the live internet.
 *   - sendBroadcast's fence (services/broadcast.ts): the SAME predicate,
 *     applied per-recipient to a batch before any chunk is built, so
 *     `nemar admin notify` -- the highest-blast-radius manual flow -- gets
 *     the identical guarantee as a single transactional send.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sendBroadcast } from "../src/services/broadcast";
import {
  DevEmailFenceError,
  type EmailDeliveryEnv,
  isEmailDeliveryAllowed,
  isRecipientAllowlisted,
  redactRecipient,
  sendRevocationEmail,
} from "../src/services/email";
import { freshDb, realD1 } from "./helpers/d1";

// ---------------------------------------------------------------------------
// isRecipientAllowlisted
// ---------------------------------------------------------------------------

describe("isRecipientAllowlisted", () => {
  test("unset/empty allowlist matches nothing (fail-closed)", () => {
    expect(isRecipientAllowlisted("alice@example.org", undefined)).toBe(false);
    expect(isRecipientAllowlisted("alice@example.org", "")).toBe(false);
    expect(isRecipientAllowlisted("alice@example.org", "   ")).toBe(false);
  });

  test("matches an exact address, case-insensitively", () => {
    expect(isRecipientAllowlisted("alice@example.org", "alice@example.org")).toBe(true);
    expect(isRecipientAllowlisted("Alice@Example.ORG", "alice@example.org")).toBe(true);
    expect(isRecipientAllowlisted("bob@example.org", "alice@example.org")).toBe(false);
  });

  test("matches an @domain suffix entry against any local part", () => {
    expect(isRecipientAllowlisted("anyone@nemar.org", "@nemar.org")).toBe(true);
    expect(isRecipientAllowlisted("ANYONE@NEMAR.ORG", "@nemar.org")).toBe(true);
    expect(isRecipientAllowlisted("anyone@notnemar.org", "@nemar.org")).toBe(false);
  });

  test("an @domain entry does not match a bare substring of the domain", () => {
    // "@nemar.org" must not match "user@sub.nemar.org.evil.com" or similar --
    // domain comparison is exact-suffix-as-whole-domain, not `includes`.
    expect(isRecipientAllowlisted("user@nemar.org.evil.com", "@nemar.org")).toBe(false);
    expect(isRecipientAllowlisted("user@sub.nemar.org", "@nemar.org")).toBe(false);
  });

  test("parses comma-separated entries, trimming whitespace", () => {
    const allowlist = " alice@example.org , @nemar.org ,bob@example.org";
    expect(isRecipientAllowlisted("alice@example.org", allowlist)).toBe(true);
    expect(isRecipientAllowlisted("bob@example.org", allowlist)).toBe(true);
    expect(isRecipientAllowlisted("testAdmin@nemar.org", allowlist)).toBe(true);
    expect(isRecipientAllowlisted("carol@example.org", allowlist)).toBe(false);
  });

  test("ignores empty entries from stray commas", () => {
    expect(isRecipientAllowlisted("alice@example.org", "alice@example.org,,")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isEmailDeliveryAllowed
// ---------------------------------------------------------------------------

describe("isEmailDeliveryAllowed", () => {
  test("production always allows, allowlist or not", () => {
    expect(isEmailDeliveryAllowed("real-user@gmail.com", { ENVIRONMENT: "production" })).toBe(true);
    expect(
      isEmailDeliveryAllowed("real-user@gmail.com", {
        ENVIRONMENT: "PRODUCTION",
        DEV_EMAIL_ALLOWLIST: undefined,
      }),
    ).toBe(true);
  });

  for (const environment of ["development", "staging", "test", "", undefined]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)} requires the allow-list`, () => {
      const env: EmailDeliveryEnv = { ENVIRONMENT: environment, DEV_EMAIL_ALLOWLIST: "@nemar.org" };
      expect(isEmailDeliveryAllowed("someone@nemar.org", env)).toBe(true);
      expect(isEmailDeliveryAllowed("real-user@gmail.com", env)).toBe(false);
    });
  }

  test("a wholly unset env (undefined) refuses -- fails toward restricting, not allowing", () => {
    expect(isEmailDeliveryAllowed("someone@nemar.org", undefined)).toBe(false);
  });

  test("an env with no DEV_EMAIL_ALLOWLIST refuses every recipient outside production", () => {
    expect(isEmailDeliveryAllowed("someone@nemar.org", { ENVIRONMENT: "development" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// redactRecipient
// ---------------------------------------------------------------------------

describe("redactRecipient", () => {
  test("keeps the first character and the full domain", () => {
    expect(redactRecipient("alice@example.org")).toBe("a***@example.org");
  });

  test("falls back to '***' for a string with no (or a leading) @", () => {
    expect(redactRecipient("not-an-email")).toBe("***");
    expect(redactRecipient("@example.org")).toBe("***");
  });
});

// ---------------------------------------------------------------------------
// sendEmail's fence, driven through the real sendRevocationEmail wrapper.
// Redirects api.resend.com to a local Bun.serve() instance so an ALLOWED
// send's fetch is real, not mocked -- only its target moves off the live
// internet, mirroring zarr-index-v3.test.ts's redirect pattern.
// ---------------------------------------------------------------------------

/** Starts a local fake-Resend server and redirects any `api.resend.com`
 *  fetch to it for the duration of `fn`. Every request is recorded (method,
 *  path, parsed JSON body) so a test can assert exactly what reached the
 *  "network" boundary. Always restores the real `fetch` and stops the
 *  server, even if `fn` throws. */
async function withFakeResend<T>(
  fn: (calls: Array<{ path: string; body: unknown }>) => Promise<T>,
): Promise<T> {
  const calls: Array<{ path: string; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/emails/batch") {
        const items = Array.isArray(body) ? body : [];
        return new Response(JSON.stringify({ data: items.map(() => ({ id: "batch-ok" })) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "email-ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.resend.com") {
      const local = new URL(url.pathname + url.search, `http://127.0.0.1:${server.port}`);
      return realFetch(new Request(local, req));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    server.stop(true);
  }
}

describe("sendEmail delivery fence (via sendRevocationEmail)", () => {
  test("SUPPRESSED: non-production + non-allowlisted recipient rejects with DevEmailFenceError and never reaches the network", async () => {
    await withFakeResend(async (calls) => {
      const env: EmailDeliveryEnv = {
        ENVIRONMENT: "development",
        DEV_EMAIL_ALLOWLIST: "@nemar.org",
      };
      await expect(
        sendRevocationEmail(
          "real-user@gmail.com",
          "realuser",
          "fake-resend-key",
          "NEMAR <noreply@nemar.org>",
          undefined,
          false,
          env,
        ),
      ).rejects.toBeInstanceOf(DevEmailFenceError);
      expect(calls.length).toBe(0);
    });
  });

  test("SUPPRESSED: an unset deliveryEnv also refuses (fails closed, not open)", async () => {
    await withFakeResend(async (calls) => {
      await expect(
        sendRevocationEmail(
          "real-user@gmail.com",
          "realuser",
          "fake-resend-key",
          "NEMAR <noreply@nemar.org>",
        ),
      ).rejects.toBeInstanceOf(DevEmailFenceError);
      expect(calls.length).toBe(0);
    });
  });

  test("ALLOWED: an allow-listed recipient on a non-production env passes the fence and reaches the network", async () => {
    await withFakeResend(async (calls) => {
      const env: EmailDeliveryEnv = {
        ENVIRONMENT: "development",
        DEV_EMAIL_ALLOWLIST: "@nemar.org",
      };
      await sendRevocationEmail(
        "testAdmin@nemar.org",
        "testAdmin",
        "fake-resend-key",
        "NEMAR <noreply@nemar.org>",
        undefined,
        false,
        env,
      );
      expect(calls.length).toBe(1);
      expect(calls[0].path).toBe("/emails");
      const sent = calls[0].body as { to: string[] };
      expect(sent.to).toEqual(["testAdmin@nemar.org"]);
    });
  });

  test("ALLOWED: production bypasses the allow-list entirely", async () => {
    await withFakeResend(async (calls) => {
      const env: EmailDeliveryEnv = { ENVIRONMENT: "production" };
      await sendRevocationEmail(
        "real-user@gmail.com",
        "realuser",
        "fake-resend-key",
        "NEMAR <noreply@nemar.org>",
        undefined,
        false,
        env,
      );
      expect(calls.length).toBe(1);
      const sent = calls[0].body as { to: string[] };
      expect(sent.to).toEqual(["real-user@gmail.com"]);
    });
  });
});

// ---------------------------------------------------------------------------
// sendBroadcast's fence (services/broadcast.ts) -- the highest-blast-radius
// manual flow (`nemar admin notify`, up to a whole recipient group in one
// call). Real D1 (bun:sqlite behind realD1, every migration applied) for
// the broadcast_emails audit write; the Resend batch endpoint is redirected
// exactly like the sendEmail tests above.
// ---------------------------------------------------------------------------

function seedSender(db: Database): number {
  db.prepare(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('broadcastadmin', 'broadcastadmin@nemar.org', 'x', 'approved', 'admin', 1)`,
  ).run();
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'broadcastadmin'")
    .get();
  if (!row) throw new Error("seed: sender insert failed");
  return row.id;
}

describe("sendBroadcast delivery fence", () => {
  test("a mixed batch sends only to allow-listed recipients; suppressed ones are counted, not attempted", async () => {
    const db = freshDb();
    const sentById = seedSender(db);
    const env: EmailDeliveryEnv = { ENVIRONMENT: "development", DEV_EMAIL_ALLOWLIST: "@nemar.org" };

    await withFakeResend(async (calls) => {
      const result = await sendBroadcast(
        realD1(db),
        "fake-resend-key",
        "NEMAR <noreply@nemar.org>",
        {
          sentById,
          group: "admins",
          subject: "Test broadcast",
          bodyMarkdown: "Hello",
          recipients: [
            "testAdmin@nemar.org",
            "real-user-1@gmail.com",
            "testOwner@nemar.org",
            "real-user-2@yahoo.com",
          ],
        },
        undefined,
        false,
        env,
      );

      expect(result.suppressed_count).toBe(2);
      expect(result.recipient_count).toBe(2);
      expect(result.failure_count).toBe(0);
      expect(result.failed_recipients).toEqual([]);

      // Exactly one batch call, to only the two allow-listed recipients.
      expect(calls.length).toBe(1);
      expect(calls[0].path).toBe("/emails/batch");
      const sentTo = (calls[0].body as Array<{ to: string[] }>).map((item) => item.to[0]);
      expect(sentTo.sort()).toEqual(["testAdmin@nemar.org", "testOwner@nemar.org"]);
    });
  });

  test("an all-suppressed batch makes zero network calls and reports the full count as suppressed", async () => {
    const db = freshDb();
    const sentById = seedSender(db);
    const env: EmailDeliveryEnv = { ENVIRONMENT: "development", DEV_EMAIL_ALLOWLIST: "@nemar.org" };

    await withFakeResend(async (calls) => {
      const result = await sendBroadcast(
        realD1(db),
        "fake-resend-key",
        "NEMAR <noreply@nemar.org>",
        {
          sentById,
          group: "all",
          subject: "Test broadcast",
          bodyMarkdown: "Hello",
          recipients: ["real-user-1@gmail.com", "real-user-2@yahoo.com"],
        },
        undefined,
        false,
        env,
      );

      expect(calls.length).toBe(0);
      expect(result.suppressed_count).toBe(2);
      expect(result.recipient_count).toBe(0);
    });
  });

  test("production sends a broadcast to every recipient, suppressed_count 0", async () => {
    const db = freshDb();
    const sentById = seedSender(db);
    const env: EmailDeliveryEnv = { ENVIRONMENT: "production" };

    await withFakeResend(async (calls) => {
      const result = await sendBroadcast(
        realD1(db),
        "fake-resend-key",
        "NEMAR <noreply@nemar.org>",
        {
          sentById,
          group: "all",
          subject: "Test broadcast",
          bodyMarkdown: "Hello",
          recipients: ["real-user-1@gmail.com", "real-user-2@yahoo.com"],
        },
        undefined,
        false,
        env,
      );

      expect(result.suppressed_count).toBe(0);
      expect(result.recipient_count).toBe(2);
      expect(calls.length).toBe(1);
    });
  });
});
