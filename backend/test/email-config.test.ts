import { describe, expect, test } from "bun:test";
import { DEFAULT_FROM_EMAIL, applyDevWrap, resolveEmailConfig } from "../src/services/email";

describe("resolveEmailConfig", () => {
  test("returns both env values when set", () => {
    const result = resolveEmailConfig({
      FROM_EMAIL: "NEMAR Archive <noreply@nemar.org>",
      REPLY_TO: "info@nemar.org",
    });
    expect(result).toEqual({
      fromEmail: "NEMAR Archive <noreply@nemar.org>",
      replyTo: "info@nemar.org",
      isDev: false,
    });
  });

  test("falls back to DEFAULT_FROM_EMAIL when FROM_EMAIL unset", () => {
    expect(resolveEmailConfig({})).toEqual({
      fromEmail: DEFAULT_FROM_EMAIL,
      replyTo: undefined,
      isDev: false,
    });
  });

  test("uses FROM_EMAIL without replyTo when only FROM_EMAIL set", () => {
    const result = resolveEmailConfig({ FROM_EMAIL: "NEMAR <nemar@osc.earth>" });
    expect(result).toEqual({
      fromEmail: "NEMAR <nemar@osc.earth>",
      replyTo: undefined,
      isDev: false,
    });
  });

  test("flags dev backend when ENVIRONMENT=development", () => {
    expect(resolveEmailConfig({ ENVIRONMENT: "development" }).isDev).toBe(true);
    expect(resolveEmailConfig({ ENVIRONMENT: "DEVELOPMENT" }).isDev).toBe(true);
    expect(resolveEmailConfig({ ENVIRONMENT: "  development  " }).isDev).toBe(true);
    expect(resolveEmailConfig({ ENVIRONMENT: "production" }).isDev).toBe(false);
    expect(resolveEmailConfig({ ENVIRONMENT: "" }).isDev).toBe(false);
    expect(resolveEmailConfig({}).isDev).toBe(false);
  });
});

describe("applyDevWrap", () => {
  test("returns subject and html unchanged when not in dev", () => {
    const result = applyDevWrap("Hello", "<html><body>hi</body></html>", false);
    expect(result.subject).toBe("Hello");
    expect(result.html).toBe("<html><body>hi</body></html>");
  });

  test("prefixes subject with [DEV] and injects banner inside <body> when in dev", () => {
    const result = applyDevWrap("Hello", "<html><body>hi</body></html>", true);
    expect(result.subject).toBe("[DEV] Hello");
    expect(result.html).toContain("DEV BACKEND - NOT PRODUCTION");
    expect(result.html.indexOf("DEV BACKEND")).toBeGreaterThan(result.html.indexOf("<body>"));
    expect(result.html.indexOf("DEV BACKEND")).toBeLessThan(result.html.indexOf("hi"));
  });

  test("falls back to prepending banner when html has no <body>", () => {
    const result = applyDevWrap("Hi", "<p>plain</p>", true);
    expect(result.subject).toBe("[DEV] Hi");
    expect(result.html.startsWith("\n<div")).toBe(true);
    expect(result.html).toContain("DEV BACKEND - NOT PRODUCTION");
    expect(result.html).toContain("<p>plain</p>");
  });

  test("falls back when FROM_EMAIL is empty or whitespace-only", () => {
    expect(resolveEmailConfig({ FROM_EMAIL: "" }).fromEmail).toBe(DEFAULT_FROM_EMAIL);
    expect(resolveEmailConfig({ FROM_EMAIL: "   " }).fromEmail).toBe(DEFAULT_FROM_EMAIL);
    expect(resolveEmailConfig({ FROM_EMAIL: "\t\n" }).fromEmail).toBe(DEFAULT_FROM_EMAIL);
  });

  test("drops replyTo when empty or whitespace-only", () => {
    expect(resolveEmailConfig({ REPLY_TO: "" }).replyTo).toBeUndefined();
    expect(resolveEmailConfig({ REPLY_TO: "   " }).replyTo).toBeUndefined();
  });

  test("trims surrounding whitespace from env values", () => {
    const result = resolveEmailConfig({
      FROM_EMAIL: "  NEMAR <x@y.com>  ",
      REPLY_TO: "  reply@y.com  ",
    });
    expect(result.fromEmail).toBe("NEMAR <x@y.com>");
    expect(result.replyTo).toBe("reply@y.com");
  });
});
