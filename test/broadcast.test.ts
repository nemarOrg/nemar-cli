/**
 * Broadcast service unit tests
 *
 * Tests for markdownToEmailHtml() and buildBroadcastHtml() pure functions.
 */

import { describe, expect, test } from "bun:test";
import {
  broadcastRequestSchema,
  buildBroadcastHtml,
  markdownToEmailHtml,
} from "../backend/src/services/broadcast";

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
    const result = markdownToEmailHtml("Use <script> & \"quotes\"");
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
    expect(result).toContain("osc.earth");
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
      expect(result.error.issues.some((i) => /mutually|exactly one/i.test(i.message))).toBe(
        true,
      );
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
