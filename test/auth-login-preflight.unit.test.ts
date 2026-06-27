/**
 * Unit tests for the login preflight decision (#851).
 *
 * Pins the bug fix: a stored API key that is no longer valid (expired or
 * revoked server-side, e.g. after `nemar auth regenerate-key`) must be
 * treated as a re-authentication of the SAME account ("stale"), not as the
 * old misleading "Log in with a different account?" path ("active").
 */

import { describe, expect, test } from "bun:test";
import { decideLoginPreflight } from "../src/commands/auth";

describe("decideLoginPreflight (#851)", () => {
  test("no stored credential → fresh prompt", () => {
    expect(decideLoginPreflight({ hasStoredKey: false, storedKeyValid: false })).toEqual({
      kind: "fresh",
    });
  });

  test("stored key still valid → adding another account", () => {
    expect(
      decideLoginPreflight({ hasStoredKey: true, storedKeyValid: true, username: "bru" }),
    ).toEqual({ kind: "active", username: "bru" });
  });

  test("stored key revoked/expired → re-auth same account, not 'different account?'", () => {
    expect(
      decideLoginPreflight({ hasStoredKey: true, storedKeyValid: false, username: "bru" }),
    ).toEqual({ kind: "stale", username: "bru" });
  });

  test("missing username falls back to 'unknown'", () => {
    expect(decideLoginPreflight({ hasStoredKey: true, storedKeyValid: true })).toEqual({
      kind: "active",
      username: "unknown",
    });
  });
});
