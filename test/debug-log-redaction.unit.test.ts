/**
 * Redaction unit tests for the --debug diagnostic bundle (issue #1256,
 * epic #1250 phase 6).
 *
 * These exercise pure functions with no shared module state (no config
 * singleton, no debug-log module flags), so -- unlike the CLI-subprocess
 * tests in debug-log-cli.test.ts -- they're safe to run in-process even
 * though `bun test` shares one process across test/ and backend/test
 * (see MEMORY: bun-test-shared-process-root-and-backend).
 *
 * The literal secrets below (API keys, AWS credentials, emails) are
 * representative sample input for a text-transformation function, not
 * mocked business logic -- no different from testing formatBytesCli with a
 * literal byte count.
 */

import { describe, expect, test } from "bun:test";
import { maskEmail, redactBody, redactHeaders } from "../src/lib/debug-log";

describe("redactHeaders", () => {
  test("redacts Authorization, Cookie, X-Api-Key regardless of case", () => {
    const out = redactHeaders({
      Authorization: "Bearer sk-live-abcdef1234567890",
      cookie: "nemar_session=deadbeef",
      "X-API-KEY": "raw-secret-value",
      "Content-Type": "application/json",
    });
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    expect(out["X-API-KEY"]).toBe("[REDACTED]");
    expect(out["Content-Type"]).toBe("application/json");
  });

  test("leaves unrelated headers untouched", () => {
    const out = redactHeaders({ "X-CLI-Version": "0.9.16" });
    expect(out).toEqual({ "X-CLI-Version": "0.9.16" });
  });
});

describe("maskEmail", () => {
  test("keeps the first character and the domain, masks the rest", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
  });
});

describe("redactBody", () => {
  test("redacts a sensitive JSON key regardless of nesting", () => {
    const raw = JSON.stringify({
      api_key: "sk-live-abcdef1234567890",
      nested: { password: "hunter2", ok: "keep-me" },
    });
    const out = redactBody(raw);
    expect(out).toBeDefined();
    expect(out).not.toContain("sk-live-abcdef1234567890");
    expect(out).not.toContain("hunter2");
    expect(out).toContain('"keep-me"');
    const parsed = JSON.parse(out as string);
    expect(parsed.api_key).toBe("[REDACTED]");
    expect(parsed.nested.password).toBe("[REDACTED]");
  });

  test("masks an email value under an unrelated key", () => {
    const raw = JSON.stringify({ contact: "Reach me at alice@example.com please" });
    const out = redactBody(raw) as string;
    expect(out).not.toContain("alice@example.com");
    expect(out).toContain("a***@example.com");
  });

  test("redacts a Bearer token embedded in a JSON string value", () => {
    const raw = JSON.stringify({ note: "Bearer abcDEF123456.token-part" });
    const out = redactBody(raw) as string;
    expect(out).not.toContain("abcDEF123456.token-part");
    expect(out).toContain("Bearer [REDACTED]");
  });

  test("redacts an AWS access key ID by shape", () => {
    const raw = JSON.stringify({ note: "key is AKIAABCDEFGHIJKLMNOP" });
    const out = redactBody(raw) as string;
    expect(out).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(out).toContain("[REDACTED_AWS_KEY]");
  });

  test("redacts an aws_secret_access_key assignment even under a non-matching JSON key name", () => {
    // The key name itself ("aws_secret_access_key") does not exactly match
    // the JSON-key allowlist (which expects bare "secret"/"access_key"), so
    // this only gets caught by the regex fallback pass -- see debug-log.ts.
    const raw = JSON.stringify({
      aws_secret_access_key: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    });
    const out = redactBody(raw) as string;
    expect(out).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
    expect(out).toContain("[REDACTED]");
  });

  test("falls back to regex scrubbing on a non-JSON body", () => {
    const raw = "user=alice@example.com&token=Bearer abc.def-123";
    const out = redactBody(raw) as string;
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("Bearer abc.def-123");
    expect(out).toContain("a***@example.com");
  });

  test("truncates a body over the byte cap and marks it", () => {
    const raw = JSON.stringify({ blob: "x".repeat(5000) });
    const out = redactBody(raw, 2048) as string;
    expect(out.endsWith("... [truncated]")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(2048 + "... [truncated]".length);
  });

  test("passes through undefined unchanged", () => {
    expect(redactBody(undefined)).toBeUndefined();
  });
});
