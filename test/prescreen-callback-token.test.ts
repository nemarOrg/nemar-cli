/**
 * Unit tests for the publication pre-screen callback HMAC token (issue #666).
 *
 * The Worker signs a one-shot HMAC-SHA256 token over (datasetId, requestId,
 * nonce) at dispatch time and verifies the echoed token on the
 * `/webhooks/prescreen-result` callback. Same handshake as the manifest
 * token; these tests pin the round-trip and the failure modes.
 *
 * Real crypto.subtle round-trip; no mocks per `.rules/testing.md`.
 */

import { describe, expect, test } from "bun:test";

import {
  signPrescreenCallbackToken,
  verifyPrescreenCallbackToken,
} from "../backend/src/services/github";

const SECRET = "test-secret-do-not-use-in-prod";
const PAYLOAD = {
  datasetId: "nm099999",
  requestId: 4242,
  nonce: "11111111-2222-3333-4444-555555555555",
};

describe("signPrescreenCallbackToken", () => {
  test("returns a 64-char lowercase hex digest (SHA-256)", async () => {
    const token = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same payload + secret", async () => {
    const a = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    const b = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    expect(a).toBe(b);
  });

  test("changes when ANY field of the payload changes", async () => {
    const base = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    const diffNonce = await signPrescreenCallbackToken(
      { ...PAYLOAD, nonce: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      SECRET,
    );
    const diffRequest = await signPrescreenCallbackToken({ ...PAYLOAD, requestId: 4243 }, SECRET);
    const diffDataset = await signPrescreenCallbackToken(
      { ...PAYLOAD, datasetId: "nm000999" },
      SECRET,
    );
    expect(base).not.toBe(diffNonce);
    expect(base).not.toBe(diffRequest);
    expect(base).not.toBe(diffDataset);
  });

  test("throws on empty secret -- guards against missing env config", async () => {
    expect(signPrescreenCallbackToken(PAYLOAD, "")).rejects.toThrow(/secret is required/);
  });
});

describe("verifyPrescreenCallbackToken", () => {
  test("round-trips: a freshly-signed token verifies against same payload+secret", async () => {
    const token = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    expect(await verifyPrescreenCallbackToken(token, PAYLOAD, SECRET)).toBe(true);
  });

  test("rejects a token signed against a different requestId", async () => {
    const token = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    expect(await verifyPrescreenCallbackToken(token, { ...PAYLOAD, requestId: 9 }, SECRET)).toBe(
      false,
    );
  });

  test("rejects a token signed against a different datasetId", async () => {
    const token = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    expect(
      await verifyPrescreenCallbackToken(token, { ...PAYLOAD, datasetId: "nm111111" }, SECRET),
    ).toBe(false);
  });

  test("rejects verification with the wrong secret", async () => {
    const token = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    expect(await verifyPrescreenCallbackToken(token, PAYLOAD, "rotated-secret")).toBe(false);
  });

  test("rejects empty token and empty secret", async () => {
    const token = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    expect(await verifyPrescreenCallbackToken("", PAYLOAD, SECRET)).toBe(false);
    expect(await verifyPrescreenCallbackToken(token, PAYLOAD, "")).toBe(false);
  });

  test("rejects a prefix of the valid token -- length check is load-bearing", async () => {
    const token = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    expect(await verifyPrescreenCallbackToken(token.slice(0, 32), PAYLOAD, SECRET)).toBe(false);
  });

  test("rejects a token with one hex char flipped", async () => {
    const token = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    const flipped = `${token.slice(0, -1)}${token.slice(-1) === "0" ? "1" : "0"}`;
    expect(flipped).not.toBe(token);
    expect(await verifyPrescreenCallbackToken(flipped, PAYLOAD, SECRET)).toBe(false);
  });
});
