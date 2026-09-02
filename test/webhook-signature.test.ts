/**
 * Unit tests for the GitHub App webhook HMAC verifier.
 *
 * Pure-helper coverage; the integration with the actual webhook handler
 * is covered in webhook-github-push.test.ts.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { verifyGitHubWebhookSignature } from "../backend/src/services/webhook-signature";

const SECRET = "nemar-test-secret-do-not-use-anywhere-real";

/** Generate the `sha256=<hex>` header value GitHub would send for a body. */
async function sign(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const bytes = new Uint8Array(sig);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return `sha256=${out}`;
}

describe("verifyGitHubWebhookSignature", () => {
  test("accepts a header matching the body's HMAC", async () => {
    const body = '{"ref":"refs/heads/main","commits":[]}';
    const header = await sign(body, SECRET);
    expect(await verifyGitHubWebhookSignature(body, header, SECRET)).toBe(true);
  });

  test("rejects a header signed with a different secret", async () => {
    const body = '{"ref":"refs/heads/main"}';
    const header = await sign(body, "some-other-secret");
    expect(await verifyGitHubWebhookSignature(body, header, SECRET)).toBe(false);
  });

  test("rejects when the body differs from what was signed", async () => {
    const header = await sign('{"a":1}', SECRET);
    expect(await verifyGitHubWebhookSignature('{"a":2}', header, SECRET)).toBe(false);
  });

  test("rejects null header", async () => {
    expect(await verifyGitHubWebhookSignature("anything", null, SECRET)).toBe(false);
  });

  test("rejects undefined header", async () => {
    expect(await verifyGitHubWebhookSignature("anything", undefined, SECRET)).toBe(false);
  });

  test("rejects empty header", async () => {
    expect(await verifyGitHubWebhookSignature("anything", "", SECRET)).toBe(false);
  });

  test("rejects when the prefix is missing", async () => {
    // Valid 64-char hex but no `sha256=` prefix — should not be accepted.
    const body = "x";
    const real = (await sign(body, SECRET)).slice("sha256=".length);
    expect(await verifyGitHubWebhookSignature(body, real, SECRET)).toBe(false);
  });

  test("rejects when the digest length is wrong", async () => {
    expect(await verifyGitHubWebhookSignature("x", "sha256=deadbeef", SECRET)).toBe(false);
  });

  test("rejects when the secret is empty", async () => {
    const body = "x";
    const header = await sign(body, SECRET);
    expect(await verifyGitHubWebhookSignature(body, header, "")).toBe(false);
  });

  test("handles an empty body correctly", async () => {
    const header = await sign("", SECRET);
    expect(await verifyGitHubWebhookSignature("", header, SECRET)).toBe(true);
    // And rejects a different-secret signature over the empty body.
    const bad = await sign("", "another-secret");
    expect(await verifyGitHubWebhookSignature("", bad, SECRET)).toBe(false);
  });

  test("does not throw on garbage header input", async () => {
    // The contract is "return false, never throw", so callers can collapse
    // every negative into a single 401.
    expect(await verifyGitHubWebhookSignature("body", "not-a-real-signature", SECRET)).toBe(false);
    expect(await verifyGitHubWebhookSignature("body", "sha256=zzzzzzzzzzzzzzzzzz", SECRET)).toBe(
      false,
    );
  });
});
