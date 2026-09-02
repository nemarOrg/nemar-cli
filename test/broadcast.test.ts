/**
 * Broadcast service unit tests
 *
 * Tests for markdownToEmailHtml(), buildBroadcastHtml(), and sendBroadcast()
 * precondition checks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  broadcastRequestSchema,
  buildBroadcastHtml,
  markdownToEmailHtml,
  sendBroadcast,
} from "../backend/src/services/broadcast";

// ---------------------------------------------------------------------------
// Minimal D1Database stub. The precondition check in sendBroadcast returns
// before any DB call, so this stub is only reached on the happy-path test.
// ---------------------------------------------------------------------------

interface StubD1Result {
  results: unknown[];
  success: boolean;
  meta: object;
}

function makeD1Stub(overrides: Partial<D1Database> = {}): D1Database {
  const stub = {
    prepare: () => ({
      bind: () => ({
        first: () => Promise.resolve({ id: 1 }),
        all: () => Promise.resolve({ results: [], success: true, meta: {} } as StubD1Result),
        run: () => Promise.resolve({ success: true, meta: {} }),
      }),
      first: () => Promise.resolve({ id: 1 }),
      all: () => Promise.resolve({ results: [], success: true, meta: {} } as StubD1Result),
      run: () => Promise.resolve({ success: true, meta: {} }),
    }),
    batch: () => Promise.resolve([]),
    dump: () => Promise.resolve(new ArrayBuffer(0)),
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
    ...overrides,
  } as unknown as D1Database;
  return stub;
}

describe("markdownToEmailHtml", () => {
  test("converts paragraph text", () => {
    const result = markdownToEmailHtml("Hello world");
    expect(result).toContain("<p");
    expect(result).toContain("Hello world");
  });

  test("converts headings", () => {
    const result = markdownToEmailHtml("# Title\n\n## Subtitle\n\n### Small");
    expect(result).toContain("<h1");
    expect(result).toContain("Title");
    expect(result).toContain("<h2");
    expect(result).toContain("Subtitle");
    expect(result).toContain("<h3");
    expect(result).toContain("Small");
  });

  test("converts bold and italic", () => {
    const result = markdownToEmailHtml("This is **bold** and *italic*");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
  });

  test("converts inline code", () => {
    const result = markdownToEmailHtml("Use `nemar upload`");
    expect(result).toContain("<code");
    expect(result).toContain("nemar upload");
  });

  test("converts links with http/https", () => {
    const result = markdownToEmailHtml("Visit [NEMAR](https://nemar.org)");
    expect(result).toContain('<a href="https://nemar.org"');
    expect(result).toContain("NEMAR</a>");
  });

  test("rejects non-http links", () => {
    const result = markdownToEmailHtml("Click [here](javascript:alert(1))");
    expect(result).not.toContain("javascript:");
    expect(result).toContain("here");
  });

  test("converts unordered lists", () => {
    const result = markdownToEmailHtml("- Item one\n- Item two\n- Item three");
    expect(result).toContain("<ul");
    expect(result).toContain("<li");
    expect(result).toContain("Item one");
    expect(result).toContain("Item two");
  });

  test("converts horizontal rules", () => {
    const result = markdownToEmailHtml("Above\n\n---\n\nBelow");
    expect(result).toContain("<hr");
    expect(result).toContain("Above");
    expect(result).toContain("Below");
  });

  test("escapes HTML entities", () => {
    const result = markdownToEmailHtml('Use <script> & "quotes"');
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&quot;quotes&quot;");
    expect(result).not.toContain("<script>");
  });

  test("handles single-line breaks as <br>", () => {
    const result = markdownToEmailHtml("Line one\nLine two");
    expect(result).toContain("Line one<br>");
    expect(result).toContain("Line two");
  });

  test("handles empty input", () => {
    const result = markdownToEmailHtml("");
    expect(result).toBe("");
  });

  test("handles asterisk list markers", () => {
    const result = markdownToEmailHtml("* First\n* Second");
    expect(result).toContain("<ul");
    expect(result).toContain("First");
    expect(result).toContain("Second");
  });
});

describe("buildBroadcastHtml", () => {
  test("wraps content in email template", () => {
    const result = buildBroadcastHtml("Test Subject", "<p>Body</p>");
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("Test Subject");
    expect(result).toContain("<p>Body</p>");
    expect(result).toContain("NEMAR");
    expect(result).toContain("nemar.org");
  });

  test("escapes subject HTML", () => {
    const result = buildBroadcastHtml("<script>alert(1)</script>", "<p>Safe</p>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>alert");
  });
});

describe("broadcastRequestSchema (issue #381)", () => {
  test("accepts group-only request", () => {
    const result = broadcastRequestSchema.safeParse({
      to: "admins",
      subject: "Hello",
      body: "Body",
    });
    expect(result.success).toBe(true);
  });

  test("accepts user-only request", () => {
    const result = broadcastRequestSchema.safeParse({
      user: "alice",
      subject: "Hi Alice",
      body: "Body",
    });
    expect(result.success).toBe(true);
  });

  test("rejects when both 'to' and 'user' are provided", () => {
    const result = broadcastRequestSchema.safeParse({
      to: "admins",
      user: "alice",
      subject: "Hi",
      body: "Body",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /mutually|exactly one/i.test(i.message))).toBe(true);
    }
  });

  test("rejects when neither 'to' nor 'user' is provided", () => {
    const result = broadcastRequestSchema.safeParse({
      subject: "Subj",
      body: "Body",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid group value", () => {
    const result = broadcastRequestSchema.safeParse({
      to: "nobody",
      subject: "Subj",
      body: "Body",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty username", () => {
    const result = broadcastRequestSchema.safeParse({
      user: "",
      subject: "Subj",
      body: "Body",
    });
    expect(result.success).toBe(false);
  });

  test("propagates dry_run flag", () => {
    const result = broadcastRequestSchema.safeParse({
      user: "bob",
      subject: "Subj",
      body: "Body",
      dry_run: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dry_run).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// sendBroadcast precondition: RESEND_API_KEY validation (issue #478)
// ---------------------------------------------------------------------------

describe("sendBroadcast RESEND_API_KEY precondition", () => {
  const baseParams = {
    sentById: 1,
    group: "all" as const,
    subject: "Test",
    bodyMarkdown: "Hello",
    recipients: ["user@example.com"],
  };

  let fakeResend: Server;
  let resendCalls: Request[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    resendCalls = [];
    // Spin up a local server that acts as the Resend batch endpoint.
    fakeResend = Bun.serve({
      port: 0,
      fetch(req) {
        resendCalls.push(req.clone());
        return Response.json({
          data: [{ id: "fake-id-1" }],
        });
      },
    });

    // Intercept fetch calls to api.resend.com and redirect to our fake server.
    originalFetch = globalThis.fetch;
    const fakePort = fakeResend.port;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (url.includes("api.resend.com")) {
        const redirected = url.replace("https://api.resend.com", `http://localhost:${fakePort}`);
        return originalFetch(redirected, init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fakeResend.stop(true);
  });

  test("missing key (undefined-like empty string) returns email_service_unconfigured", async () => {
    const db = makeD1Stub();
    const result = await sendBroadcast(db, "", "from@nemar.org", baseParams);

    expect(result.error).toBe("email_service_unconfigured");
    expect(result.broadcast_id).toBe(-1);
    expect(result.recipient_count).toBe(0);
    expect(result.failure_count).toBe(0);
    // No Resend call should have been made
    expect(resendCalls).toHaveLength(0);
  });

  test("whitespace-only key returns email_service_unconfigured", async () => {
    const db = makeD1Stub();
    const result = await sendBroadcast(db, "   ", "from@nemar.org", baseParams);

    expect(result.error).toBe("email_service_unconfigured");
    expect(result.broadcast_id).toBe(-1);
    expect(resendCalls).toHaveLength(0);
  });

  test("valid key proceeds to call Resend and returns broadcast_id", async () => {
    // The DB stub returns id: 1 from the RETURNING clause.
    const db = makeD1Stub();
    const result = await sendBroadcast(db, "re_valid_key_abc123", "from@nemar.org", baseParams);

    expect(result.error).toBeUndefined();
    expect(result.broadcast_id).toBe(1);
    expect(result.recipient_count).toBe(1);
    // Resend was called exactly once (1 recipient fits in 1 batch)
    expect(resendCalls).toHaveLength(1);
  });
});
