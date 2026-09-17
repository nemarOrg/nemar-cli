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
): Promise<{
  status: number;
  body: { reason?: string; dispatched?: boolean; forwarded?: boolean };
  waitCount: number;
}> {
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
  // Real (capturing) execution context — the forwarder schedules its outbound
  // mirror via waitUntil; a dev outage / unreachable target is .catch'd.
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await app.fetch(req, { GITHUB_WEBHOOK_SECRET: SECRET, ...env } as Bindings, ctx);
  const parsed = (await res.json()) as {
    reason?: string;
    dispatched?: boolean;
    forwarded?: boolean;
  };
  await Promise.allSettled(waited);
  return { status: res.status, body: parsed, waitCount: waited.length };
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

  test("production does NOT gate a prod-range xx (sandbox) repo below the ceiling", async () => {
    // xx012345 is a legitimate prod sandbox repo (< SANDBOX_ID_CEILING 89999);
    // the gate must NOT swallow it — only the xx09NNNN dev band.
    const { status, body } = await post({ ENVIRONMENT: "production" }, inertPush("xx012345"));
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

describe("POST /webhooks/github dev-range forwarder (epic #923, phase 5)", () => {
  test("prod forwards a dev-range delivery when DEV_WEBHOOK_MIRROR_URL is set", async () => {
    const { status, body, waitCount } = await post(
      { ENVIRONMENT: "production", DEV_WEBHOOK_MIRROR_URL: "http://127.0.0.1:1/webhooks/github" },
      readmePush("xx090001"),
    );
    expect(status).toBe(200);
    expect(body.reason).toBe("dev_range_repo");
    expect(body.forwarded).toBe(true);
    expect(waitCount).toBe(1); // the mirror fetch was scheduled fire-and-forget
  });

  test("prod does NOT forward when DEV_WEBHOOK_MIRROR_URL is unset", async () => {
    const { status, body, waitCount } = await post(
      { ENVIRONMENT: "production" },
      readmePush("xx090001"),
    );
    expect(status).toBe(200);
    expect(body.reason).toBe("dev_range_repo");
    expect(body.forwarded).toBeUndefined();
    expect(waitCount).toBe(0);
  });

  test("dev worker never forwards even with the var set (falls through)", async () => {
    const { status, body, waitCount } = await post(
      { ENVIRONMENT: "development", DEV_WEBHOOK_MIRROR_URL: "http://127.0.0.1:1/webhooks/github" },
      inertPush("xx090001"),
    );
    expect(status).toBe(200);
    expect(body.reason).not.toBe("dev_range_repo");
    expect(waitCount).toBe(0);
  });
});

describe("dev OWNS its reserved fixtures (#1440)", () => {
  // The fences key on `isDevOwnedDatasetId`, not `isDevRangeDatasetId`. Before
  // that, the reserved `nm` fixture was refused by the dev worker and claimed
  // by the production one at the same time. GitHub delivers to prod, which
  // forwards dev-owned deliveries to DEV_WEBHOOK_MIRROR_URL (the dev worker
  // never mirrors: the var is absent from [env.dev.vars]), so before this
  // change neither worker acted on nm099998 -- prod claimed it and dev refused
  // it. It is a forward, not a second delivery.

  test("production short-circuits a reserved nm fixture, as it does a dev-range repo", async () => {
    // Without this the prod worker dispatches enrichment / zarr / version-DOI
    // for a repository it has no D1 row for, and the version-DOI path picks
    // its EZID credentials from the DOI string rather than from ENVIRONMENT.
    const { body } = await post({ ENVIRONMENT: "production" }, readmePush("nm099998"));
    expect(body.dispatched).toBe(false);
    expect(body.reason).toBe("dev_range_repo");
  });

  test("production forwards the reserved fixture to the dev mirror too", async () => {
    const { body, waitCount } = await post(
      { ENVIRONMENT: "production", DEV_WEBHOOK_MIRROR_URL: "http://127.0.0.1:1/github" },
      readmePush("nm099998"),
    );
    expect(body.forwarded).toBe(true);
    expect(waitCount).toBe(1);
  });

  test("production still acts on a REAL nm repo", async () => {
    // The control that keeps the fence honest: widening it must not make
    // production ignore actual datasets. An inert push resolves to a
    // no-dispatch decision without a token fetch, and the REASON is what
    // distinguishes "not mine" from "nothing to do".
    const { body } = await post({ ENVIRONMENT: "production" }, inertPush("nm000104"));
    expect(body.reason).not.toBe("dev_range_repo");
  });

  test("the dev worker acts on its own reserved fixture", async () => {
    // The failure this fixes: the dev worker answered
    // prod_range_repo_on_dev_worker for nm099998, so enrichment could never run
    // against the one dataset built to exercise the anonymity surfaces.
    const { body } = await post({ ENVIRONMENT: "development" }, inertPush("nm099998"));
    expect(body.reason).not.toBe("prod_range_repo_on_dev_worker");
  });

  test("the dev worker still refuses a real nm repo", async () => {
    const { body } = await post({ ENVIRONMENT: "development" }, inertPush("nm000104"));
    expect(body.dispatched).toBe(false);
    expect(body.reason).toBe("prod_range_repo_on_dev_worker");
  });

  test("the dev worker refuses nm099999, which production also owns", async () => {
    // nm099999 is deliberately NOT dev-owned: it exists in both catalogs and is
    // maintained through its own reset endpoint. If it were in the set, a dev
    // worker could act on a repository production also uses.
    const { body } = await post({ ENVIRONMENT: "development" }, inertPush("nm099999"));
    expect(body.reason).toBe("prod_range_repo_on_dev_worker");
  });

  test("production does NOT short-circuit nm099999", async () => {
    const { body } = await post({ ENVIRONMENT: "production" }, inertPush("nm099999"));
    expect(body.reason).not.toBe("dev_range_repo");
  });
});
