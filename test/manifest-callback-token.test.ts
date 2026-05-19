/**
 * Unit tests for the manifest callback HMAC token used by the
 * centralized manifest workflow (#557 Stream B).
 *
 * The Worker signs a one-shot HMAC-SHA256 token over (datasetId,
 * version, nonce) at dispatch time and verifies the same token on the
 * `/webhooks/manifest-ready` (and `/manifest-failed`) callback. These
 * tests pin the round-trip and the failure modes that matter:
 *
 *   - tampered nonce, version, datasetId, or secret all reject
 *   - empty token / empty secret reject (defense against misconfig)
 *   - constant-time compare doesn't accept a prefix match
 *
 * Real crypto.subtle round-trip; no mocks per `.rules/testing.md`.
 */

import { describe, expect, test } from "bun:test";

import {
  signManifestCallbackToken,
  verifyManifestCallbackToken,
} from "../backend/src/services/github";

const SECRET = "test-secret-do-not-use-in-prod";
const PAYLOAD = {
  datasetId: "nm099999",
  version: "1.0.0",
  nonce: "11111111-2222-3333-4444-555555555555",
};

describe("signManifestCallbackToken", () => {
  test("returns a 64-char lowercase hex digest (SHA-256)", async () => {
    const token = await signManifestCallbackToken(PAYLOAD, SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same payload + secret", async () => {
    const a = await signManifestCallbackToken(PAYLOAD, SECRET);
    const b = await signManifestCallbackToken(PAYLOAD, SECRET);
    expect(a).toBe(b);
  });

  test("changes when ANY field of the payload changes", async () => {
    const base = await signManifestCallbackToken(PAYLOAD, SECRET);
    const diffNonce = await signManifestCallbackToken(
      { ...PAYLOAD, nonce: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      SECRET,
    );
    const diffVersion = await signManifestCallbackToken({ ...PAYLOAD, version: "1.0.1" }, SECRET);
    const diffDataset = await signManifestCallbackToken(
      { ...PAYLOAD, datasetId: "nm000999" },
      SECRET,
    );
    expect(base).not.toBe(diffNonce);
    expect(base).not.toBe(diffVersion);
    expect(base).not.toBe(diffDataset);
  });

  test("changes when the secret changes", async () => {
    const a = await signManifestCallbackToken(PAYLOAD, SECRET);
    const b = await signManifestCallbackToken(PAYLOAD, "different-secret");
    expect(a).not.toBe(b);
  });

  test("throws on empty secret -- guards against missing env config", async () => {
    expect(signManifestCallbackToken(PAYLOAD, "")).rejects.toThrow(/secret is required/);
  });
});

describe("verifyManifestCallbackToken", () => {
  test("round-trips: a freshly-signed token verifies against same payload+secret", async () => {
    const token = await signManifestCallbackToken(PAYLOAD, SECRET);
    expect(await verifyManifestCallbackToken(token, PAYLOAD, SECRET)).toBe(true);
  });

  test("rejects a token signed against a different nonce", async () => {
    const token = await signManifestCallbackToken(PAYLOAD, SECRET);
    const tampered = { ...PAYLOAD, nonce: "00000000-0000-0000-0000-000000000000" };
    expect(await verifyManifestCallbackToken(token, tampered, SECRET)).toBe(false);
  });

  test("rejects a token signed against a different version", async () => {
    const token = await signManifestCallbackToken(PAYLOAD, SECRET);
    const tampered = { ...PAYLOAD, version: "2.0.0" };
    expect(await verifyManifestCallbackToken(token, tampered, SECRET)).toBe(false);
  });

  test("rejects a token signed against a different datasetId", async () => {
    const token = await signManifestCallbackToken(PAYLOAD, SECRET);
    const tampered = { ...PAYLOAD, datasetId: "nm111111" };
    expect(await verifyManifestCallbackToken(token, tampered, SECRET)).toBe(false);
  });

  test("rejects verification with the wrong secret -- HMAC is a one-way function", async () => {
    const token = await signManifestCallbackToken(PAYLOAD, SECRET);
    expect(await verifyManifestCallbackToken(token, PAYLOAD, "rotated-secret")).toBe(false);
  });

  test("rejects empty token", async () => {
    expect(await verifyManifestCallbackToken("", PAYLOAD, SECRET)).toBe(false);
  });

  test("rejects empty secret -- defensive: refuses to verify against missing config", async () => {
    const token = await signManifestCallbackToken(PAYLOAD, SECRET);
    expect(await verifyManifestCallbackToken(token, PAYLOAD, "")).toBe(false);
  });

  test("rejects a prefix of the valid token -- length check is load-bearing", async () => {
    const token = await signManifestCallbackToken(PAYLOAD, SECRET);
    expect(await verifyManifestCallbackToken(token.slice(0, 32), PAYLOAD, SECRET)).toBe(false);
  });

  test("rejects a token with one hex char flipped", async () => {
    const token = await signManifestCallbackToken(PAYLOAD, SECRET);
    // Flip the last hex char; result has the same length but is a
    // different digest. Constant-time compare must still reject.
    const flipped = `${token.slice(0, -1)}${token.slice(-1) === "0" ? "1" : "0"}`;
    expect(flipped).not.toBe(token);
    expect(flipped.length).toBe(token.length);
    expect(await verifyManifestCallbackToken(flipped, PAYLOAD, SECRET)).toBe(false);
  });
});
