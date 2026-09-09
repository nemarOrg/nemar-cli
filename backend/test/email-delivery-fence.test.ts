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
 *   - isAdminNotificationAllowed / getAdminEmailsForCategory: a SEPARATE,
 *     stricter fence for admin-facing notification mail (new-user approval,
 *     upload-access/publication requests, import recovery, cron digests).
 *     The dev worker's own admin account is on DEV_EMAIL_ALLOWLIST above (so
 *     staging sign-in codes reach it), which means the recipient-level fence
 *     alone does NOT stop admin notifications from reaching it outside
 *     production -- this fence stops them being generated at all. Real D1
 *     (freshDb/realD1) for getAdminEmailsForCategory's own query.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sendBroadcast } from "../src/services/broadcast";
import {
  type AdminNotificationEnv,
  DevEmailFenceError,
  type EmailDeliveryEnv,
  getAdminEmailsForCategory,
  isAdminNotificationAllowed,
  isEmailDeliveryAllowed,
  isRecipientAllowlisted,
  redactRecipient,
  sendRevocationEmail,
} from "../src/services/email";
import { freshDb, realD1 } from "./helpers/d1";
import { withFakeResend } from "./helpers/resend";

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
// withFakeResend (helpers/resend.ts) redirects api.resend.com to a local
// Bun.serve() instance so an ALLOWED send's fetch is real, not mocked -- only
// its target moves off the live internet.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// isAdminNotificationAllowed -- the pure predicate, exhaustively. Mirrors the
// isEmailDeliveryAllowed block above in shape, but the opt-in is
// DEV_ADMIN_NOTIFICATIONS (exact string "1"), not an allow-list of
// recipients: this fence is about whether admin-notification mail is
// generated at all, not about who it may reach.
// ---------------------------------------------------------------------------

describe("isAdminNotificationAllowed", () => {
  test("production always allows, opt-in or not", () => {
    expect(isAdminNotificationAllowed({ ENVIRONMENT: "production" })).toBe(true);
    expect(
      isAdminNotificationAllowed({ ENVIRONMENT: "PRODUCTION", DEV_ADMIN_NOTIFICATIONS: "0" }),
    ).toBe(true);
  });

  for (const environment of ["development", "staging", "test", "", undefined]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)} requires DEV_ADMIN_NOTIFICATIONS="1"`, () => {
      const env: AdminNotificationEnv = { ENVIRONMENT: environment };
      expect(isAdminNotificationAllowed(env)).toBe(false);
      expect(isAdminNotificationAllowed({ ...env, DEV_ADMIN_NOTIFICATIONS: "1" })).toBe(true);
      // Anything other than the literal "1" stays closed -- "true" is a
      // plausible typo for the same intent and must not accidentally open
      // the fence.
      expect(isAdminNotificationAllowed({ ...env, DEV_ADMIN_NOTIFICATIONS: "true" })).toBe(false);
    });
  }

  test("a wholly unset env (undefined) refuses -- fails toward suppressing, not allowing", () => {
    expect(isAdminNotificationAllowed(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAdminEmailsForCategory -- the chokepoint every admin-notification call
// site funnels through. Real D1 (freshDb/realD1), so a false positive here
// would mean the actual production query disagrees with the fence, not a
// hand-copied re-implementation of either.
// ---------------------------------------------------------------------------

function seedApprovedAdmin(db: Database): void {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, email_verified)
     VALUES ('fenceadmin', 'fenceadmin@nemar.org', 'x', 'fenceadmin-gh', 'approved', 'admin', 1)`,
  );
}

describe("getAdminEmailsForCategory", () => {
  test("production returns the seeded admin addresses", async () => {
    const db = freshDb();
    seedApprovedAdmin(db);
    const emails = await getAdminEmailsForCategory(realD1(db), "user_approval", {
      ENVIRONMENT: "production",
    });
    expect(emails).toEqual(["fenceadmin@nemar.org"]);
  });

  test("development returns [] -- the fence applies before the D1 query runs", async () => {
    const db = freshDb();
    seedApprovedAdmin(db);
    const emails = await getAdminEmailsForCategory(realD1(db), "user_approval", {
      ENVIRONMENT: "development",
    });
    expect(emails).toEqual([]);
  });

  test("an unset ENVIRONMENT returns [] -- fails toward suppressing, not allowing", async () => {
    const db = freshDb();
    seedApprovedAdmin(db);
    const emails = await getAdminEmailsForCategory(realD1(db), "user_approval", {});
    expect(emails).toEqual([]);
  });

  test("development + DEV_ADMIN_NOTIFICATIONS=1 opts back in for a deliberate staging test", async () => {
    const db = freshDb();
    seedApprovedAdmin(db);
    const emails = await getAdminEmailsForCategory(realD1(db), "user_approval", {
      ENVIRONMENT: "development",
      DEV_ADMIN_NOTIFICATIONS: "1",
    });
    expect(emails).toEqual(["fenceadmin@nemar.org"]);
  });
});
