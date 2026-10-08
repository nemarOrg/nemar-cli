/**
 * The identifier screen's callback token and dispatch (epic #1610, phase 4).
 *
 * The token shares its key with the pre-screen token (PRESCREEN_CALLBACK_SECRET)
 * and is signed over the same three fields, so the one property that keeps the
 * two apart is the domain tag at the head of the signed message. These tests
 * hold that line in BOTH directions: a pre-screen token must not open the
 * identifier-screen door, and an identifier-screen token must not open the
 * pre-screen one.
 *
 * Real crypto.subtle round-trips and a Bun.serve stand-in for api.github.com;
 * no mocks per `.rules/testing.md`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import {
  signIdentifierScreenCallbackToken,
  signPrescreenCallbackToken,
  triggerIdentifierScreenRun,
  verifyIdentifierScreenCallbackToken,
  verifyPrescreenCallbackToken,
} from "../backend/src/services/github";
import { type FakeGithubServer, startFakeGithub } from "./helpers/fetch-counter";

const SECRET = "test-secret-do-not-use-in-prod";
const PAYLOAD = {
  datasetId: "nm099999",
  requestId: 4242,
  nonce: "11111111-2222-3333-4444-555555555555",
};

describe("signIdentifierScreenCallbackToken / verifyIdentifierScreenCallbackToken", () => {
  test("round-trips, and is a 64-char hex SHA-256 digest", async () => {
    const token = await signIdentifierScreenCallbackToken(PAYLOAD, SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyIdentifierScreenCallbackToken(token, PAYLOAD, SECRET)).toBe(true);
  });

  test("binds every field: another dataset, request or nonce does not verify", async () => {
    const token = await signIdentifierScreenCallbackToken(PAYLOAD, SECRET);
    for (const other of [
      { ...PAYLOAD, datasetId: "nm000999" },
      { ...PAYLOAD, requestId: 4243 },
      { ...PAYLOAD, nonce: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    ]) {
      expect(await verifyIdentifierScreenCallbackToken(token, other, SECRET)).toBe(false);
    }
  });

  test("the wrong secret, an empty token and an empty secret do not verify", async () => {
    const token = await signIdentifierScreenCallbackToken(PAYLOAD, SECRET);
    expect(await verifyIdentifierScreenCallbackToken(token, PAYLOAD, "rotated")).toBe(false);
    expect(await verifyIdentifierScreenCallbackToken("", PAYLOAD, SECRET)).toBe(false);
    expect(await verifyIdentifierScreenCallbackToken(token, PAYLOAD, "")).toBe(false);
  });

  test("signing refuses an empty secret, so a missing Worker secret cannot sign anything", async () => {
    expect(signIdentifierScreenCallbackToken(PAYLOAD, "")).rejects.toThrow(/secret is required/);
  });
});

describe("domain separation from the pre-screen token (same secret, same fields)", () => {
  test("a pre-screen token does not verify as an identifier-screen token", async () => {
    const prescreen = await signPrescreenCallbackToken(PAYLOAD, SECRET);
    // The control: the same token IS valid where it was minted for.
    expect(await verifyPrescreenCallbackToken(prescreen, PAYLOAD, SECRET)).toBe(true);
    expect(await verifyIdentifierScreenCallbackToken(prescreen, PAYLOAD, SECRET)).toBe(false);
  });

  test("an identifier-screen token does not verify as a pre-screen token", async () => {
    const screen = await signIdentifierScreenCallbackToken(PAYLOAD, SECRET);
    expect(await verifyIdentifierScreenCallbackToken(screen, PAYLOAD, SECRET)).toBe(true);
    expect(await verifyPrescreenCallbackToken(screen, PAYLOAD, SECRET)).toBe(false);
  });

  test("the two digests differ for identical inputs", async () => {
    expect(await signIdentifierScreenCallbackToken(PAYLOAD, SECRET)).not.toBe(
      await signPrescreenCallbackToken(PAYLOAD, SECRET),
    );
  });
});

describe("triggerIdentifierScreenRun", () => {
  const DISPATCH_PATH = "/repos/nemarDatasets/.github/dispatches";
  let fake: FakeGithubServer;
  let nextResponse: () => Response = () => new Response(null, { status: 204 });

  beforeAll(() => {
    fake = startFakeGithub({ [`POST ${DISPATCH_PATH}`]: () => nextResponse() });
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = fake.url;
  });

  afterAll(() => {
    fake.stop();
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  });

  beforeEach(() => {
    fake.reset();
    nextResponse = () => new Response(null, { status: 204 });
  });

  test("POSTs run-identifier-screen to the central repo with the documented payload", async () => {
    await triggerIdentifierScreenRun(
      "nm099999",
      "main",
      4242,
      "deadbeef".repeat(8),
      "https://api.nemar.org/webhooks/identifier-screen-result",
      "test-pat",
    );
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].method).toBe("POST");
    expect(fake.calls[0].path).toBe(DISPATCH_PATH);
    expect(JSON.parse(fake.calls[0].body ?? "{}")).toEqual({
      event_type: "run-identifier-screen",
      client_payload: {
        dataset_id: "nm099999",
        ref: "main",
        request_id: 4242,
        callback_token: "deadbeef".repeat(8),
        callback_url: "https://api.nemar.org/webhooks/identifier-screen-result",
      },
    });
  });

  test("throws on a non-2xx answer, naming the status and not GitHub's body", async () => {
    nextResponse = () => new Response("secret-ish body", { status: 422 });
    const err = await triggerIdentifierScreenRun(
      "nm099999",
      "main",
      1,
      "tok",
      "https://x/cb",
      "test-pat",
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Failed to trigger identifier screen run: HTTP 422");
  });
});
