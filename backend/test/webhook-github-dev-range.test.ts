/**
 * Route-level test for the dev-range short-circuit in POST /webhooks/github
 * (epic #923, phase 1 / #930).
 *
 * The production worker must NOT dispatch enrichment/zarr/version-DOI runs
 * against staging repos (xx09NNNN) that live in the shared nemarDatasets org —
 * they have no prod D1 row and the central-workflow callbacks would 404. The
 * gate short-circuits only when ENVIRONMENT === "production"; the dev worker
 * (which will receive forwarded deliveries in phase 5) must fall through and
 * dispatch normally.
 *
 * Real Hono app + real WebCrypto HMAC signature (no mocks). Payloads are crafted
 * so the non-short-circuit cases resolve to a no-dispatch decision BEFORE any
 * GitHub token fetch or outbound trigger, so the test makes no network calls.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerGithubWebhookRoutes } from "../src/routes/webhooks/github";
import type { Bindings } from "../src/types/bindings";

const SECRET = "test-webhook-secret";

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
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

async function post(
  env: Partial<Bindings>,
  payload: unknown,
): Promise<{ status: number; body: { reason?: string; dispatched?: boolean } }> {
  const app = new Hono<{ Bindings: Bindings }>();
  registerGithubWebhookRoutes(app);
  const body = JSON.stringify(payload);
  const req = new Request("http://localhost/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": "test-delivery",
      "X-Hub-Signature-256": await sign(body, SECRET),
    },
    body,
  });
  const res = await app.fetch(req, { GITHUB_WEBHOOK_SECRET: SECRET, ...env } as Bindings);
  return {
    status: res.status,
    body: (await res.json()) as { reason?: string; dispatched?: boolean },
  };
}

/** A main-branch push touching README.md — WOULD dispatch enrichment (needs a
 *  GitHub token / network) unless something short-circuits earlier. */
function readmePush(repoName: string) {
  return {
    ref: "refs/heads/main",
    repository: { name: repoName, owner: { login: "nemarDatasets" } },
    commits: [{ modified: ["README.md"] }],
    head_commit: { modified: ["README.md"] },
    deleted: false,
  };
}

/** A main-branch push touching only a non-trigger path — resolves to a
 *  no-dispatch decision with no token fetch. */
function inertPush(repoName: string) {
  return {
    ref: "refs/heads/main",
    repository: { name: repoName, owner: { login: "nemarDatasets" } },
    commits: [{ modified: ["participants.tsv"] }],
    head_commit: { modified: ["participants.tsv"] },
    deleted: false,
  };
}

describe("POST /webhooks/github dev-range gate", () => {
  test("production short-circuits a dev-range repo before dispatch", async () => {
    // README push would dispatch (network) if not gated; asserting the
    // dev_range_repo reason proves the gate fired first.
    const { status, body } = await post({ ENVIRONMENT: "production" }, readmePush("xx090001"));
    expect(status).toBe(200);
    expect(body.dispatched).toBe(false);
    expect(body.reason).toBe("dev_range_repo");
  });

  test("production does NOT gate a real prod repo (falls through to decision)", async () => {
    const { status, body } = await post({ ENVIRONMENT: "production" }, inertPush("nm000123"));
    expect(status).toBe(200);
    expect(body.dispatched).toBe(false);
    expect(body.reason).not.toBe("dev_range_repo");
  });

  test("non-production does NOT short-circuit a dev-range repo", async () => {
    // dev worker: falls through; inert payload means no dispatch, but crucially
    // the reason is the decision reason, not dev_range_repo.
    const { status, body } = await post({ ENVIRONMENT: "development" }, inertPush("xx090001"));
    expect(status).toBe(200);
    expect(body.dispatched).toBe(false);
    expect(body.reason).not.toBe("dev_range_repo");
  });
});
