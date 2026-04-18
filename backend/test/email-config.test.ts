import { describe, expect, test } from "bun:test";
import { DEFAULT_FROM_EMAIL, resolveEmailConfig } from "../src/services/email";

describe("resolveEmailConfig", () => {
  test("returns both env values when set", () => {
    const result = resolveEmailConfig({
      FROM_EMAIL: "NEMAR Archive <noreply@nemar.org>",
      REPLY_TO: "info@nemar.org",
    });
    expect(result).toEqual({
      fromEmail: "NEMAR Archive <noreply@nemar.org>",
      replyTo: "info@nemar.org",
    });
  });

  test("falls back to DEFAULT_FROM_EMAIL when FROM_EMAIL unset", () => {
    expect(resolveEmailConfig({})).toEqual({
      fromEmail: DEFAULT_FROM_EMAIL,
      replyTo: undefined,
    });
  });

  test("uses FROM_EMAIL without replyTo when only FROM_EMAIL set", () => {
    const result = resolveEmailConfig({ FROM_EMAIL: "NEMAR <nemar@osc.earth>" });
    expect(result).toEqual({
      fromEmail: "NEMAR <nemar@osc.earth>",
      replyTo: undefined,
    });
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
