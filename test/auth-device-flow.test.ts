/**
 * E2E tests for the device authorization grant (RFC 8628; epic #1272 phase
 * 1, #1281; ADR 0047).
 *
 * Targets a deployed backend (set TEST_API_URL; defaults to api.nemar.org).
 * The dev worker deploys only from `dev` (AGENTS.md release pipeline), so
 * this phase's routes are not guaranteed to be live on whatever backend
 * TEST_API_URL points at until the epic branch reaches dev. This file
 * probes `POST /auth/device/start` first; a 404 means the routes are not
 * deployed yet, and every case below skips itself with a loud console
 * message rather than failing -- this file must not block CI on a deploy
 * that has not happened.
 *
 * Prod-traffic safeguard: matches test/auth-passwordless.test.ts -- if
 * TEST_API_URL points at api.nemar.org or data.nemar.org, the suite skips
 * itself unless TEST_ALLOW_PROD=1.
 *
 * Seeding follows the same pattern as test/auth-passwordless.test.ts:
 * POST /admin/test-fixtures/seed-web-user (admin-token-gated, non-prod-only)
 * creates the account, then POST /auth/code/request + the echoed dev_code +
 * POST /auth/code/verify (with an allow-listed Origin) signs in for real.
 *
 * ENVIRONMENT=development skips `rateLimiter` entirely
 * (middleware/rateLimit.ts), so nothing here asserts a 429 -- including on
 * `/auth/device/token`. ADR 0047's whole reason for keeping that route
 * outside the strict `AUTH_PATHS` bucket is a rate a real 5-second poll
 * loop would trip: 10 polls fit inside the strict bucket's 60-second
 * window, and the 11th would not.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import "./setup";
import { TEST_CONFIG } from "./setup";

const API = TEST_CONFIG.apiUrl;
const ORIGIN = "https://app.nemar.org";
const POINTS_AT_PROD = API.includes("api.nemar.org") || API.includes("data.nemar.org");
const PROD_GUARD_ACTIVE = POINTS_AT_PROD && !process.env.TEST_ALLOW_PROD;

const baseHeaders: Record<string, string> = TEST_CONFIG.bypassToken
  ? { "X-Test-Bypass": TEST_CONFIG.bypassToken }
  : {};

async function seedWebUser(
  email: string,
  status: "pending" | "verified" | "approved" | "revoked",
): Promise<void> {
  const r = await fetch(`${API}/admin/test-fixtures/seed-web-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`,
      ...baseHeaders,
    },
    body: JSON.stringify({ email, status }),
  });
  if (r.status !== 200) {
    throw new Error(`seedWebUser failed (${r.status}): ${await r.text()}`);
  }
}

function freshEmail(label: string): string {
  return `df-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nemar.test`;
}

async function postJson(
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...baseHeaders, ...extra },
    body: JSON.stringify(body),
  });
}

interface CodeRequestResponse {
  ok: boolean;
  dev_code?: string;
  dev_skip?: string;
  error?: string;
}

/** Sign in via the passwordless flow and return the `nemar_session` cookie
 *  header value. Throws if the account cannot complete sign-in. */
async function signIn(email: string): Promise<string> {
  const req = await postJson("/auth/code/request", { email });
  const reqBody = (await req.json()) as CodeRequestResponse;
  if (!reqBody.dev_code) {
    throw new Error(`no dev_code for ${email}: ${JSON.stringify(reqBody)}`);
  }
  const verify = await postJson(
    "/auth/code/verify",
    { email, code: reqBody.dev_code, remember: false },
    { Origin: ORIGIN },
  );
  const setCookie = verify.headers.get("Set-Cookie");
  const m = setCookie?.match(/nemar_session=([^;]+)/);
  if (!m) throw new Error(`sign-in did not set a session cookie for ${email}: ${verify.status}`);
  return `nemar_session=${m[1]}`;
}

interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function startDevice(machineName: string): Promise<DeviceStartResponse> {
  const res = await postJson("/auth/device/start", { machine_name: machineName });
  if (res.status !== 200) {
    throw new Error(`device start failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as DeviceStartResponse;
}

let deviceRoutesDeployed = false;

beforeAll(async () => {
  if (PROD_GUARD_ACTIVE) return;
  const probe = await postJson("/auth/device/start", { machine_name: "deploy-probe" });
  deviceRoutesDeployed = probe.status !== 404;
  if (!deviceRoutesDeployed) {
    console.warn(
      "[auth-device-flow] SKIPPING every case: POST /auth/device/start answered 404. " +
        "The dev worker deploys only from `dev` (AGENTS.md release pipeline), so this " +
        "phase's routes are not live on the backend TEST_API_URL points at yet -- " +
        "expected until the epic branch reaches dev, or until the branch is deployed " +
        "by hand (see the phase plan's Verification section).",
    );
  }
});

describe.skipIf(PROD_GUARD_ACTIVE)("device authorization grant (#1281, ADR 0047)", () => {
  test("the full loop: start, pending, slow_down, lookup, confirm, token, keys", async () => {
    if (!deviceRoutesDeployed) return;
    const email = freshEmail("full-loop");
    await seedWebUser(email, "verified");
    const cookie = await signIn(email);

    const started = await startDevice("e2e-full-loop-machine");
    expect(started.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.verification_uri_complete).toContain(encodeURIComponent(started.user_code));

    const pending = await postJson("/auth/device/token", { device_code: started.device_code });
    expect(pending.status).toBe(400);
    expect(((await pending.json()) as { error: string }).error).toBe("authorization_pending");

    // Immediately after: inside the 5-second poll floor.
    const tooSoon = await postJson("/auth/device/token", { device_code: started.device_code });
    expect(tooSoon.status).toBe(400);
    expect(((await tooSoon.json()) as { error: string }).error).toBe("slow_down");

    const lookupRes = await fetch(
      `${API}/auth/device/lookup?code=${encodeURIComponent(started.user_code)}`,
      { headers: { ...baseHeaders, Cookie: cookie } },
    );
    expect(lookupRes.status).toBe(200);
    const lookupBody = (await lookupRes.json()) as { machine_name: string; refusal: unknown };
    expect(lookupBody.machine_name).toBe("e2e-full-loop-machine");
    expect(lookupBody.refusal).toBeNull();

    const confirmRes = await postJson(
      "/auth/device/confirm",
      { code: started.user_code },
      { Origin: ORIGIN, Cookie: cookie },
    );
    expect(confirmRes.status).toBe(200);

    // No wait needed: once confirmed, the poll floor no longer applies --
    // DEVICE_POLL_SQL only matches `status = 'pending'` rows, so the token
    // route falls straight through to the mint attempt.
    const tokenRes = await postJson("/auth/device/token", { device_code: started.device_code });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      api_key: string;
      key: { name: string | null };
      user: { email: string };
    };
    expect(tokenBody.api_key.startsWith("nm_")).toBe(true);
    expect(tokenBody.key.name).toBe("e2e-full-loop-machine");
    expect(tokenBody.user.email).toBe(email);

    const me = await fetch(`${API}/users/me`, {
      headers: { ...baseHeaders, Authorization: `Bearer ${tokenBody.api_key}` },
    });
    expect(me.status).toBe(200);

    const keysRes = await fetch(`${API}/auth/keys`, {
      headers: { ...baseHeaders, Authorization: `Bearer ${tokenBody.api_key}` },
    });
    expect(keysRes.status).toBe(200);
    const keysBody = (await keysRes.json()) as { keys: { current: boolean }[] };
    expect(keysBody.keys.some((k) => k.current)).toBe(true);

    const revokeRes = await fetch(`${API}/auth/keys/current`, {
      method: "DELETE",
      headers: { ...baseHeaders, Authorization: `Bearer ${tokenBody.api_key}` },
    });
    expect(revokeRes.status).toBe(200);

    const meAfter = await fetch(`${API}/users/me`, {
      headers: { ...baseHeaders, Authorization: `Bearer ${tokenBody.api_key}` },
    });
    expect(meAfter.status).toBe(401);
  });

  test("a pending account cannot confirm", async () => {
    if (!deviceRoutesDeployed) return;
    const email = freshEmail("pending-confirm");
    await seedWebUser(email, "pending");
    const cookie = await signIn(email);
    const started = await startDevice("e2e-pending-machine");
    const res = await postJson(
      "/auth/device/confirm",
      { code: started.user_code },
      { Origin: ORIGIN, Cookie: cookie },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("account_pending");
  });

  test("a revoked account cannot sign in at all, so account_revoked is unreachable here", async () => {
    if (!deviceRoutesDeployed) return;
    // `findSessionByCookieId` filters revoked accounts out of session
    // resolution (services/web-session.ts), so a revoked account never
    // gets far enough to reach `lookup`/`confirm`/`deny`'s account check
    // (ADR 0047: `account_revoked` is unreachable there for exactly this
    // reason) -- it is only reachable at `/auth/device/token`, for an
    // account revoked between confirm and collect (covered by the
    // real-engine route tests, not here). What IS
    // assertable against a live deploy is the precondition: this account
    // cannot obtain a session at all.
    const email = freshEmail("revoked");
    await seedWebUser(email, "revoked");
    const req = await postJson("/auth/code/request", { email });
    const reqBody = (await req.json()) as CodeRequestResponse;
    if (!reqBody.dev_code) {
      // A revoked account may also be refused earlier, at /code/request
      // itself -- an equally valid way to observe "cannot sign in".
      return;
    }
    const verify = await postJson(
      "/auth/code/verify",
      { email, code: reqBody.dev_code, remember: false },
      { Origin: ORIGIN },
    );
    expect(verify.status).not.toBe(200);
  });

  test("deny path", async () => {
    if (!deviceRoutesDeployed) return;
    const email = freshEmail("deny");
    await seedWebUser(email, "verified");
    const cookie = await signIn(email);
    const started = await startDevice("e2e-deny-machine");

    const denyRes = await postJson(
      "/auth/device/deny",
      { code: started.user_code },
      { Origin: ORIGIN, Cookie: cookie },
    );
    expect(denyRes.status).toBe(200);

    const tokenRes = await postJson("/auth/device/token", { device_code: started.device_code });
    expect(tokenRes.status).toBe(400);
    const tokenBody = (await tokenRes.json()) as { error: string; reason?: string };
    expect(tokenBody.error).toBe("access_denied");
    expect(tokenBody.reason).toBe("device_code_denied");
  });

  test("an unknown device code answers invalid_grant/device_code_unknown", async () => {
    if (!deviceRoutesDeployed) return;
    const res = await postJson("/auth/device/token", { device_code: "z".repeat(40) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("invalid_grant");
    expect(body.reason).toBe("device_code_unknown");
  });
});
