/**
 * Constant-time string comparison, consolidated into `lib/constant-time.ts`
 * (issue #1229, phase 2 of epic #1225).
 *
 * `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension to Web
 * Crypto that bun's runtime does not implement. Root `bun test` runs
 * `test/` and `backend/test/` in ONE process, so a polyfill installed by
 * ANY other test file (`helpers/workers-crypto.ts`'s
 * `installWorkersTimingSafeEqual()`, which several sibling suites call) sets
 * `globalThis.crypto.subtle.timingSafeEqual` for the whole process and would
 * silently hand this file's "native absent" cases a native implementation
 * regardless of load order.
 *
 * This file therefore controls that capability explicitly rather than
 * relying on ambient state: it saves the original `timingSafeEqual`
 * descriptor once at load, `delete`s it for the "native absent" cases,
 * reinstalls a REAL constant-time implementation for the "native present"
 * cases, and restores the original in `afterAll`.
 *
 * This is not a mock in the sense .rules/testing.md forbids: it selects
 * which REAL runtime capability is present, and the production code under
 * test (lib/constant-time.ts, webhook-signature.ts, callback-tokens.ts, and
 * the records-ready route) runs completely unmodified in both branches --
 * same argument backend/test/recording-stats-callback.test.ts makes for its
 * own (now-superseded, but still-installed for the coverage it adds)
 * polyfill.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { timingSafeEqual } from "../src/lib/constant-time";
import { registerRecordsReadyRoutes } from "../src/routes/callbacks/records-ready";
import {
  type ManifestCallbackPayload,
  signManifestCallbackToken,
  verifyManifestCallbackToken,
} from "../src/services/github/callback-tokens";
import { verifyGitHubWebhookSignature } from "../src/services/webhook-signature";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { installWorkersTimingSafeEqual } from "./helpers/workers-crypto";

type SubtleWithTiming = SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
};

const subtle = crypto.subtle as SubtleWithTiming;
const ORIGINAL_TIMING_SAFE_EQUAL = subtle.timingSafeEqual;

/** Force the "native absent" branch -- bun's actual out-of-the-box state. */
function makeNativeAbsent(): void {
  subtle.timingSafeEqual = undefined;
}

/**
 * Force the "native present" branch with a REAL constant-time
 * implementation (not a stub): the same one `helpers/workers-crypto.ts`
 * installs for the sibling suites, reused here under explicit control.
 */
function makeNativePresent(): void {
  subtle.timingSafeEqual = undefined;
  installWorkersTimingSafeEqual();
}

afterAll(() => {
  // Reinstall rather than restore the load-time snapshot (#1225 review).
  // Root `bun test` runs test/ and backend/test/ in ONE process, so if this
  // file loads before any sibling that calls installWorkersTimingSafeEqual(),
  // the snapshot is `undefined` and restoring it would strip the capability
  // for the rest of the run -- silently pushing the six sibling suites that
  // exist to exercise the NATIVE branch onto the portable one instead. Both
  // branches are correct, so nothing would fail; the coverage would just
  // quietly stop being what helpers/workers-crypto.ts says it is. The helper
  // is idempotent, so this is safe however this file was reached.
  if (ORIGINAL_TIMING_SAFE_EQUAL) {
    subtle.timingSafeEqual = ORIGINAL_TIMING_SAFE_EQUAL;
  } else {
    installWorkersTimingSafeEqual();
  }
});

const TOKEN = "constant-time-compare-webhook-token";
const DATASET = "on009229";

let db: Database;
let app: Hono<{ Bindings: Bindings }>;

function postRecordsReady(body: Record<string, unknown>, token: string): Promise<Response> {
  return app.request(
    "/records-ready",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
      body: JSON.stringify(body),
    },
    { DB: realD1(db), NEMAR_WEBHOOK_TOKEN: TOKEN, ENVIRONMENT: "test" } as Bindings,
  );
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings }>();
  registerRecordsReadyRoutes(app);
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('ctcowner', 'ctcowner@example.org', 'x', 'approved', 'user', 1)`,
  ).run();
  const owner = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='ctcowner'")
    .get();
  if (!owner) throw new Error("seed: owner insert failed");
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
     VALUES (?, 'Constant-time compare fixture', ?, 'active', 'public')`,
  ).run(DATASET, owner.id);
});

/** Flip one hex nibble so the result is a same-length, wrong value. */
function flipHexNibble(hex: string, index: number): string {
  const ch = hex[index];
  const replacement = ch === "0" ? "1" : "0";
  return hex.slice(0, index) + replacement + hex.slice(index + 1);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

/**
 * DELETED reference comparator, pinned here to migrate against -- it is the
 * exact XOR-over-charCodeAt body `auth-code.ts`'s `constantTimeEqualHex` and
 * `webhook-signature.ts`'s `timingSafeEqualHex` both implemented before this
 * phase deleted them in favor of the shared byte-based helper. This is here
 * to PIN the migration (prove the new byte-based helper agrees with the old
 * UTF-16-charCodeAt one on every ASCII input these functions actually see),
 * not to be kept forever.
 */
function deletedXorOverCharCodeAt(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Case 1 & 2: drive the REAL /records-ready route (the smallest callback
 * guarding on the shared helper) through Hono. On the pre-phase-2 code --
 * webhooks/shared.ts's unconditional `crypto.subtle.timingSafeEqual(...)`
 * call, restored verbatim below as the case-1 mutation proof -- the
 * correct-token request 500s under bun whenever native is absent, because
 * the token check throws before the route logic runs. This is the
 * regression this phase exists to fix.
 */
function describeRecordsReadyAuth(branch: string): void {
  describe(`POST /records-ready token check (${branch})`, () => {
    test("accepts the correct token", async () => {
      const res = await postRecordsReady(
        { dataset_id: DATASET, status: "ready", version: "1.0.0" },
        TOKEN,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; dataset_id: string };
      expect(body.ok).toBe(true);
      expect(body.dataset_id).toBe(DATASET);
    });

    test("rejects a wrong token with 401", async () => {
      const res = await postRecordsReady(
        { dataset_id: DATASET, status: "ready", version: "1.0.0" },
        `${TOKEN}-wrong`,
      );
      expect(res.status).toBe(401);
    });
  });
}

/** Case 3: the exported entry point in webhook-signature.ts. */
function describeWebhookSignature(): void {
  describe("verifyGitHubWebhookSignature", () => {
    const secret = "constant-time-compare-github-secret";
    const rawBody = JSON.stringify({ ref: "refs/heads/main", ok: true });

    test("accepts a signature computed with the real HMAC path", async () => {
      const hex = await hmacSha256Hex(secret, rawBody);
      const ok = await verifyGitHubWebhookSignature(rawBody, `sha256=${hex}`, secret);
      expect(ok).toBe(true);
    });

    test("rejects a same-length wrong signature", async () => {
      const hex = await hmacSha256Hex(secret, rawBody);
      const wrong = flipHexNibble(hex, 0);
      expect(wrong.length).toBe(hex.length);
      const ok = await verifyGitHubWebhookSignature(rawBody, `sha256=${wrong}`, secret);
      expect(ok).toBe(false);
    });
  });
}

/** Case 4: the exported entry point in callback-tokens.ts. */
function describeManifestCallbackToken(): void {
  describe("verifyManifestCallbackToken", () => {
    const secret = "constant-time-compare-manifest-secret";
    const payload: ManifestCallbackPayload = {
      datasetId: DATASET,
      version: "1.0.0",
      nonce: "constant-time-compare-nonce",
    };

    test("accepts a token produced by the real signer", async () => {
      const token = await signManifestCallbackToken(payload, secret);
      const ok = await verifyManifestCallbackToken(token, payload, secret);
      expect(ok).toBe(true);
    });

    test("rejects a tampered token", async () => {
      const token = await signManifestCallbackToken(payload, secret);
      const tampered = flipHexNibble(token, 0);
      expect(tampered.length).toBe(token.length);
      const ok = await verifyManifestCallbackToken(tampered, payload, secret);
      expect(ok).toBe(false);
    });
  });
}

/**
 * Case 5: the new helper agrees with the deleted XOR-over-charCodeAt
 * comparators on equal pairs, single-nibble differences, differing
 * lengths, upper vs lower case, and the empty string.
 */
function describeHexEquivalence(): void {
  describe("timingSafeEqual agrees with the deleted XOR-over-charCodeAt comparators", () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["a", "a"],
      ["a", "b"],
      ["deadbeef", "deadbeef"], // equal pair
      ["deadbeef", "deadbeee"], // single-nibble diff at the end
      ["deadbeef", "ceadbeef"], // single-nibble diff at the start
      ["deadbeef", "dead0eef"], // single-nibble diff in the middle
      ["deadbeef", "deadbee"], // differing length (shorter)
      ["deadbeef", "deadbeeff"], // differing length (longer)
      ["DEADBEEF", "deadbeef"], // case sensitivity
      ["deadbeef", "DEADBEEF"], // case sensitivity, reversed operand order
      ["0000000000000000", "0000000000000001"],
    ];

    for (const [a, b] of cases) {
      test(`agrees for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`, () => {
        expect(timingSafeEqual(a, b)).toBe(deletedXorOverCharCodeAt(a, b));
      });
    }
  });
}

describe("native absent (bun's actual out-of-the-box state)", () => {
  beforeEach(makeNativeAbsent);
  describeRecordsReadyAuth("native absent");
  describeWebhookSignature();
  describeManifestCallbackToken();
  describeHexEquivalence();
});

describe("native present (real constant-time implementation installed)", () => {
  beforeEach(makeNativePresent);
  describeRecordsReadyAuth("native present");
  describeWebhookSignature();
  describeManifestCallbackToken();
  describeHexEquivalence();
});
