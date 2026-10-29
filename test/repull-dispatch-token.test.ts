/**
 * The re-pull dispatch token (epic #1046 phase 7, #1913; ADR 0111, decision 6).
 *
 * The automatic re-pull's run presents this token at the automatic create and at its report
 * callback. It is an HMAC over the dispatch's id, its dataset and its one-shot nonce, signed with
 * the callback secret (PRESCREEN_CALLBACK_SECRET) under a domain tag of its own; single use is the
 * row's nonce (`upstream-repull-dispatch.test.ts`), not the HMAC.
 *
 * What these tests hold: the token binds every field, it is a different message from every other
 * callback kind's (checked in BOTH directions against all eight, because one secret signs them
 * all), and a field that could move a line boundary is refused.
 *
 * Real crypto.subtle round-trips over the real functions; no mocks per `.rules/testing.md`.
 *
 * CI TIER: unit-pure. Hermetic: pure functions and a real WebCrypto, no server, no database.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { isValidDatasetId } from "../backend/src/services/datasetId";
import {
  signRepullDispatchToken as signFromBarrel,
  verifyRepullDispatchToken as verifyFromBarrel,
} from "../backend/src/services/github";
import {
  APPROVAL_DISPATCH_TOKEN_DOMAIN,
  IDENTIFIER_REPULL_TOKEN_DOMAIN,
  IDENTIFIER_SCREEN_TOKEN_DOMAIN,
  IDENTIFIER_SWEEP_TOKEN_DOMAIN,
  PR_REVIEW_TOKEN_DOMAIN,
  PUBLICATION_REVIEW_TOKEN_DOMAIN,
  REPULL_DISPATCH_TOKEN_DOMAIN,
  type RepullDispatchTokenPayload,
  signApprovalDispatchToken,
  signIdentifierRepullCallbackToken,
  signIdentifierScreenCallbackToken,
  signIdentifierSweepCallbackToken,
  signManifestCallbackToken,
  signPrReviewCallbackToken,
  signPrescreenCallbackToken,
  signPublicationReviewCallbackToken,
  signRepullDispatchToken,
  verifyApprovalDispatchToken,
  verifyIdentifierRepullCallbackToken,
  verifyIdentifierScreenCallbackToken,
  verifyIdentifierSweepCallbackToken,
  verifyManifestCallbackToken,
  verifyPrReviewCallbackToken,
  verifyPrescreenCallbackToken,
  verifyPublicationReviewCallbackToken,
  verifyRepullDispatchToken,
} from "../backend/src/services/github/callback-tokens";
import { DISPATCH_TOKEN_RE } from "../shared/repull-state";

const SECRET = "test-secret-do-not-use-in-prod";
const PAYLOAD: RepullDispatchTokenPayload = {
  dispatchId: 4242,
  datasetId: "on004362",
  nonce: "0f4b8e3c-7a1d-4c2e-9b6f-1d2e3f4a5b6c",
};
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("the re-pull dispatch token", () => {
  test("it round-trips, and has the shape the create schema takes", async () => {
    const token = await signRepullDispatchToken(PAYLOAD, SECRET);
    expect(token).toMatch(DISPATCH_TOKEN_RE);
    expect(await verifyRepullDispatchToken(token, PAYLOAD, SECRET)).toBe(true);
  });

  test("it binds every field, and the secret", async () => {
    const token = await signRepullDispatchToken(PAYLOAD, SECRET);
    for (const other of [
      { ...PAYLOAD, dispatchId: PAYLOAD.dispatchId + 1 },
      { ...PAYLOAD, datasetId: "on004363" },
      { ...PAYLOAD, nonce: `${PAYLOAD.nonce.slice(0, -1)}d` },
    ]) {
      expect(await verifyRepullDispatchToken(token, other, SECRET)).toBe(false);
    }
    expect(await verifyRepullDispatchToken(token, PAYLOAD, `${SECRET}x`)).toBe(false);
    expect(await verifyRepullDispatchToken("", PAYLOAD, SECRET)).toBe(false);
    expect(await verifyRepullDispatchToken(token, PAYLOAD, "")).toBe(false);
    await expect(signRepullDispatchToken(PAYLOAD, "")).rejects.toThrow(/secret is required/);
  });

  test("a field that would move a line boundary is refused, and never verifies", async () => {
    // The message is four lines: dataset "on000001\n<nonce>" would otherwise sign what another
    // split of the same bytes signs.
    const smuggled = { ...PAYLOAD, datasetId: `on004362\n${PAYLOAD.nonce}` };
    await expect(signRepullDispatchToken(smuggled, SECRET)).rejects.toThrow(/line break/);
    await expect(signRepullDispatchToken({ ...PAYLOAD, nonce: "a\r\nb" }, SECRET)).rejects.toThrow(
      /line break/,
    );
    const genuine = await signRepullDispatchToken(PAYLOAD, SECRET);
    expect(await verifyRepullDispatchToken(genuine, smuggled, SECRET)).toBe(false);
  });

  test("its domain is its own, and it is not a dataset id", () => {
    expect(REPULL_DISPATCH_TOKEN_DOMAIN).toBe("repull-dispatch");
    expect(isValidDatasetId(REPULL_DISPATCH_TOKEN_DOMAIN)).toBe(false);
    for (const other of [
      APPROVAL_DISPATCH_TOKEN_DOMAIN,
      IDENTIFIER_REPULL_TOKEN_DOMAIN,
      IDENTIFIER_SCREEN_TOKEN_DOMAIN,
      IDENTIFIER_SWEEP_TOKEN_DOMAIN,
      PR_REVIEW_TOKEN_DOMAIN,
      PUBLICATION_REVIEW_TOKEN_DOMAIN,
    ]) {
      expect(other).not.toBe(REPULL_DISPATCH_TOKEN_DOMAIN);
      expect(other.startsWith(REPULL_DISPATCH_TOKEN_DOMAIN)).toBe(false);
      expect(REPULL_DISPATCH_TOKEN_DOMAIN.startsWith(other)).toBe(false);
    }
  });

  test("the services/github barrel re-exports the very functions", () => {
    expect(signFromBarrel).toBe(signRepullDispatchToken);
    expect(verifyFromBarrel).toBe(verifyRepullDispatchToken);
  });
});

describe("domain separation from every other callback token (same secret)", () => {
  const { dispatchId: id, datasetId, nonce } = PAYLOAD;
  const n = String(id);

  /** Every other kind, fed the dispatch's own values in each field position its shape allows. */
  const others: Array<{
    name: string;
    sign: () => Promise<string>;
    verify: (token: string) => Promise<boolean>;
  }> = [
    {
      name: "manifest",
      sign: () => signManifestCallbackToken({ datasetId, version: n, nonce }, SECRET),
      verify: (t) => verifyManifestCallbackToken(t, { datasetId, version: n, nonce }, SECRET),
    },
    {
      // The positions a message without the domain line would share: id, dataset, nonce.
      name: "manifest, shifted",
      sign: () => signManifestCallbackToken({ datasetId: n, version: datasetId, nonce }, SECRET),
      verify: (t) =>
        verifyManifestCallbackToken(t, { datasetId: n, version: datasetId, nonce }, SECRET),
    },
    {
      name: "prescreen",
      sign: () => signPrescreenCallbackToken({ datasetId, requestId: id, nonce }, SECRET),
      verify: (t) => verifyPrescreenCallbackToken(t, { datasetId, requestId: id, nonce }, SECRET),
    },
    {
      name: "identifier-screen",
      sign: () => signIdentifierScreenCallbackToken({ datasetId, requestId: id, nonce }, SECRET),
      verify: (t) =>
        verifyIdentifierScreenCallbackToken(t, { datasetId, requestId: id, nonce }, SECRET),
    },
    {
      name: "identifier-sweep",
      sign: () => signIdentifierSweepCallbackToken({ datasetId, nonce }, SECRET),
      verify: (t) => verifyIdentifierSweepCallbackToken(t, { datasetId, nonce }, SECRET),
    },
    {
      name: "identifier-repull",
      sign: () =>
        signIdentifierRepullCallbackToken(
          { datasetId, repullId: id, pr: "n0", sha: SHA, nonce },
          SECRET,
        ),
      verify: (t) =>
        verifyIdentifierRepullCallbackToken(
          t,
          { datasetId, repullId: id, pr: "n0", sha: SHA, nonce },
          SECRET,
        ),
    },
    {
      name: "pr-review",
      sign: () => signPrReviewCallbackToken({ datasetId, reviewId: id, nonce }, SECRET),
      verify: (t) => verifyPrReviewCallbackToken(t, { datasetId, reviewId: id, nonce }, SECRET),
    },
    {
      name: "publication-review",
      sign: () => signPublicationReviewCallbackToken({ datasetId, reviewId: id, nonce }, SECRET),
      verify: (t) =>
        verifyPublicationReviewCallbackToken(t, { datasetId, reviewId: id, nonce }, SECRET),
    },
    {
      name: "approval-dispatch",
      sign: () =>
        signApprovalDispatchToken(
          { datasetId, requestId: id, clickerId: id, claimedAt: nonce },
          SECRET,
        ),
      verify: (t) =>
        verifyApprovalDispatchToken(
          t,
          { datasetId, requestId: id, clickerId: id, claimedAt: nonce },
          SECRET,
        ),
    },
  ];

  test("a dispatch token opens no other kind of door", async () => {
    const token = await signRepullDispatchToken(PAYLOAD, SECRET);
    expect(await verifyRepullDispatchToken(token, PAYLOAD, SECRET)).toBe(true);
    for (const o of others) expect([o.name, await o.verify(token)]).toEqual([o.name, false]);
  });

  test("no other kind's token opens a dispatch's door", async () => {
    for (const o of others) {
      const token = await o.sign();
      // The control: each is valid where it was minted.
      expect([o.name, await o.verify(token)]).toEqual([o.name, true]);
      expect([o.name, await verifyRepullDispatchToken(token, PAYLOAD, SECRET)]).toEqual([
        o.name,
        false,
      ]);
    }
  });
});
