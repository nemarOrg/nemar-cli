/**
 * Unit tests for the login preflight decision (#851).
 *
 * Pins the bug fix: a stored API key that is no longer valid (expired or
 * revoked server-side, e.g. after `nemar auth regenerate-key`) must be
 * treated as a re-authentication of the SAME account ("stale"), not as the
 * old misleading "Log in with a different account?" path ("active").
 *
 * The probe is tri-state: only a definitive server "invalid" routes to
 * re-auth. An "unknown" result (offline / transient failure) must keep the
 * original multi-account behavior so a network blip never mislabels a good
 * key as dead.
 */

import { describe, expect, test } from "bun:test";
import { decideLoginPreflight } from "../src/commands/auth";

describe("decideLoginPreflight (#851)", () => {
  test("no stored credential → fresh prompt", () => {
    expect(decideLoginPreflight({ hasStoredKey: false })).toEqual({
      kind: "fresh",
    });
  });

  test("stored key still valid → adding another account", () => {
    expect(
      decideLoginPreflight({ hasStoredKey: true, storedKeyState: "valid", username: "bru" }),
    ).toEqual({ kind: "active", username: "bru" });
  });

  test("stored key revoked/expired → re-auth same account, not 'different account?'", () => {
    expect(
      decideLoginPreflight({ hasStoredKey: true, storedKeyState: "invalid", username: "bru" }),
    ).toEqual({ kind: "stale", username: "bru" });
  });

  test("probe could not reach server (offline) → keep multi-account behavior, not 'stale'", () => {
    expect(
      decideLoginPreflight({ hasStoredKey: true, storedKeyState: "unknown", username: "bru" }),
    ).toEqual({ kind: "active", username: "bru" });
  });

  test("missing username falls back to 'unknown' (active)", () => {
    expect(decideLoginPreflight({ hasStoredKey: true, storedKeyState: "valid" })).toEqual({
      kind: "active",
      username: "unknown",
    });
  });

  test("missing username falls back to 'unknown' (stale)", () => {
    expect(decideLoginPreflight({ hasStoredKey: true, storedKeyState: "invalid" })).toEqual({
      kind: "stale",
      username: "unknown",
    });
  });
});
