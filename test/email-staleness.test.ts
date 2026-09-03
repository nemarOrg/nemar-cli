/**
 * Email-path checks for the staleness notifications (#662).
 *
 * 1. "writes to Resend" — capture the outbound HTTP request (override
 *    globalThis.fetch) so we verify the warning email is addressed and shaped
 *    correctly WITHOUT sending a real message or spending Resend quota.
 * 2. "Resend is connected" — an opt-in connectivity check that hits Resend's
 *    GET /domains (no email is sent, no cost) to confirm the API key works.
 *    Skipped unless RESEND_API_KEY is present in the environment, so normal
 *    local/CI runs never touch the network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  sendStalenessAdminReviewEmail,
  sendStalenessWarningEmail,
} from "../backend/src/services/email";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

// This suite tests the request SHAPE (recipient, subject, body), not the
// #957 non-production delivery fence (services/email.ts's sendEmail) --
// fetch is already fully captured/redirected here, so nothing is ever
// really delivered either way. Declaring ENVIRONMENT="production" as the
// deliveryEnv on every call below opts these calls out of the fence
// (production always bypasses it) so an unfenced send still exercises the
// same code path it always has.
const PROD_ENV = { ENVIRONMENT: "production" };

describe("staleness emails write the right request to Resend", () => {
  const realFetch = globalThis.fetch;
  let captured: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    captured = [];
    // Capture instead of send. Returns a Resend-shaped 200 so the code path
    // that parses the response succeeds.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return new Response(JSON.stringify({ id: "captured-not-sent" }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("owner warning is addressed to the owner with the dataset + days in the subject", async () => {
    await sendStalenessWarningEmail(
      "owner@example.org",
      "nm000111",
      "ISRUC-Sleep",
      7,
      "2026-04-01",
      "test-key",
      "NEMAR <nemar@nemar.org>",
      undefined,
      undefined,
      PROD_ENV,
    );

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.url).toBe(RESEND_EMAILS_URL);
    expect(req.body.from).toBe("NEMAR <nemar@nemar.org>");
    expect(req.body.to).toEqual(["owner@example.org"]);
    expect(String(req.body.subject)).toContain("nm000111");
    expect(String(req.body.subject)).toContain("7 days");
    expect(String(req.body.html)).toContain("ISRUC-Sleep");
    expect(String(req.body.html)).toContain("2026-04-01");
  });

  test("final (1-day) warning uses the urgent 'Final notice' subject", async () => {
    await sendStalenessWarningEmail(
      "owner@example.org",
      "nm000111",
      "ISRUC-Sleep",
      1,
      "2026-04-01",
      "test-key",
      "NEMAR <nemar@nemar.org>",
      undefined,
      undefined,
      PROD_ENV,
    );
    expect(String(captured[0].body.subject)).toContain("Final notice");
    expect(String(captured[0].body.subject)).toContain("1 day");
  });

  test("admin review email fans out to every admin once and reports delivery count", async () => {
    const delivered = await sendStalenessAdminReviewEmail(
      ["admin1@nemar.org", "admin2@nemar.org"],
      "nm000111",
      "ISRUC-Sleep",
      "owner@example.org",
      1,
      "test-key",
      "NEMAR <nemar@nemar.org>",
      undefined,
      undefined,
      PROD_ENV,
    );

    expect(delivered).toBe(2);
    expect(captured).toHaveLength(2);
    expect(captured.map((c) => c.body.to)).toEqual([["admin1@nemar.org"], ["admin2@nemar.org"]]);
    // The dataset id is in the subject so the admin knows what to act on.
    expect(String(captured[0].body.subject)).toContain("nm000111");
    // The action the admin must take is in the body.
    expect(String(captured[0].body.html)).toContain("nemar admin delete-dataset");
  });

  test("admin review email reports zero delivered when every send fails", async () => {
    // Make the captured fetch fail so we exercise the per-recipient catch and
    // the delivered-count return the cron relies on to gate state advancement.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "boom" }), { status: 500 })) as typeof fetch;
    const delivered = await sendStalenessAdminReviewEmail(
      ["admin1@nemar.org"],
      "nm000111",
      "ISRUC-Sleep",
      null,
      null,
      "test-key",
      "NEMAR <nemar@nemar.org>",
      undefined,
      undefined,
      PROD_ENV,
    );
    expect(delivered).toBe(0);
  });
});

describe("Resend connectivity (opt-in)", () => {
  const apiKey = process.env.RESEND_API_KEY;

  // Only runs when a real key is provided. GET /domains validates the key
  // without sending an email, so it is free and safe to run on demand:
  //   RESEND_API_KEY=... bun test test/email-staleness.test.ts
  test.if(Boolean(apiKey))("API key authenticates against Resend (no email sent)", async () => {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
  });
});
