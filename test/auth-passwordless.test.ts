/**
 * E2E tests for the passwordless email-code auth flow (#569, #572, #595).
 *
 * Targets a deployed backend (set TEST_API_URL; defaults to api.nemar.org).
 * In development environments the /auth/code/request endpoint echoes the
 * generated code back in the response body as `dev_code` so live tests
 * can finish the flow without an email inbox. Production responses do
 * NOT include `dev_code`; a dedicated assertion below pins that
 * boundary so a misconfigured deploy can't quietly leak the code.
 *
 * Prod-traffic safeguard: if TEST_API_URL points at api.nemar.org or
 * data.nemar.org, the suite skips itself unless TEST_ALLOW_PROD=1.
 * Although the tests only touch ephemeral email addresses and the
 * passwordless surface, the cookie endpoints set real sessions and
 * the per-email rate-limit table would accumulate junk rows.
 *
 * Seeding: #595 made /auth/code/request a no-op for emails without a
 * users row. To keep the flow tests deterministic, each test that needs
 * a registered email POSTs to `/admin/test-fixtures/seed-web-user` (an
 * admin-token-gated, non-prod-only fixture endpoint) before requesting
 * the code. The seed creates a `signup_source='web'`, `status='pending'`
 * row that exactly mirrors what the legacy INSERT-OR-IGNORE path used
 * to produce, so the rest of the assertions are unchanged.
 */

import { describe, expect, test } from "bun:test";
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
  status?: "pending" | "verified" | "approved" | "revoked",
): Promise<void> {
  const r = await fetch(`${API}/admin/test-fixtures/seed-web-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`,
      ...baseHeaders,
    },
    body: JSON.stringify(status ? { email, status } : { email }),
  });
  if (r.status !== 200) {
    throw new Error(`seedWebUser failed (${r.status}): ${await r.text()}`);
  }
}

function freshEmail(label: string): string {
  // Unique per run so per-email rate limits and code rotation can't
  // leak between tests. The `.test` TLD stays out of the real email
  // reachable space; the dev Workers' Resend config delivers test
  // addresses through Resend's test mode. NOTE: `/code/request` does
  // propagate Resend failures — on a hard send error it rolls back
  // the `auth_codes` row and returns 503, so tests against a
  // mis-configured RESEND_API_KEY will see 503 here, not silent ok.
  return `pl-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nemar.test`;
}

async function postJson(path: string, body: unknown, extra: Record<string, string> = {}) {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...baseHeaders, ...extra },
    body: JSON.stringify(body),
  });
}

interface RequestResponse {
  ok: boolean;
  masked_email: string;
  dev_code?: string;
  dev_skip?: string;
  error?: string;
}

/** Nullable profile fields exposed on /verify and /me since #910. */
interface PublicUserProfile {
  given_name: string | null;
  family_name: string | null;
  orcid: string | null;
  orcid_verified: boolean;
  github_username: string | null;
  city: string | null;
  country: string | null;
  affiliation: string | null;
}

interface VerifyResponse {
  user?: { id: number; email: string; role: string; status: string } & Partial<PublicUserProfile>;
  error?: string;
}

interface MeResponse {
  user:
    | ({ id: number; email: string; role: string; status: string } & Partial<PublicUserProfile>)
    | null;
}

async function requestCode(email: string): Promise<{ status: number; body: RequestResponse }> {
  const r = await postJson("/auth/code/request", { email });
  const body = (await r.json()) as RequestResponse;
  return { status: r.status, body };
}

async function verifyCode(
  email: string,
  code: string,
  remember: boolean,
  origin = ORIGIN,
): Promise<{ status: number; body: VerifyResponse; setCookie: string | null }> {
  const r = await postJson("/auth/code/verify", { email, code, remember }, { Origin: origin });
  const body = (await r.json()) as VerifyResponse;
  return { status: r.status, body, setCookie: r.headers.get("Set-Cookie") };
}

describe.skipIf(PROD_GUARD_ACTIVE)("passwordless email-code auth (#569)", () => {
  test("happy path: request -> verify -> /me -> logout -> /me null", async () => {
    const email = freshEmail("happy");
    await seedWebUser(email);

    const req = await requestCode(email);
    expect(req.status).toBe(200);
    expect(req.body.ok).toBe(true);
    expect(req.body.masked_email).toMatch(/^[a-z]\*+@nemar\.test$/);
    // Live dev env should echo the code so we can finish the flow.
    expect(typeof req.body.dev_code).toBe("string");
    expect(req.body.dev_code).toMatch(/^\d{6}$/);

    const code = req.body.dev_code as string;
    const v = await verifyCode(email, code, true);
    expect(v.status).toBe(200);
    expect(v.body.user).toBeTruthy();
    expect(v.body.user?.email).toBe(email);
    expect(v.body.user?.status).toBe("pending"); // first-time email -> pending
    expect(v.setCookie).toBeTruthy();

    const cookieAttrs = v.setCookie?.toLowerCase() ?? "";
    expect(cookieAttrs).toContain("httponly");
    expect(cookieAttrs).toContain("secure");
    expect(cookieAttrs).toContain("samesite=lax");
    expect(cookieAttrs).toContain("path=/");

    // Extract the cookie value for subsequent requests.
    const m = v.setCookie?.match(/nemar_session=([^;]+)/);
    expect(m).toBeTruthy();
    const cookieValue = m?.[1] as string;

    const me = await fetch(`${API}/auth/me`, {
      headers: { ...baseHeaders, Cookie: `nemar_session=${cookieValue}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as MeResponse;
    expect(meBody.user?.email).toBe(email);

    // #910: profile fields ride along on /me. A fresh fixture user has
    // no profile, so every field is null and orcid_verified is a real
    // boolean false (not the 0/1 D1 stores).
    const profile = meBody.user as MeResponse["user"] & PublicUserProfile;
    expect(profile.orcid_verified).toBe(false);
    for (const key of [
      "given_name",
      "family_name",
      "orcid",
      "github_username",
      "city",
      "country",
      "affiliation",
    ] as const) {
      expect(profile[key]).toBeNull();
    }

    const logout = await fetch(`${API}/auth/logout`, {
      method: "POST",
      headers: { ...baseHeaders, Origin: ORIGIN, Cookie: `nemar_session=${cookieValue}` },
    });
    expect(logout.status).toBe(200);

    const meAfter = await fetch(`${API}/auth/me`, {
      headers: { ...baseHeaders, Cookie: `nemar_session=${cookieValue}` },
    });
    const meAfterBody = (await meAfter.json()) as MeResponse;
    expect(meAfterBody.user).toBeNull();
  });

  test("non-allowlisted member gets silent-ok without dev_code (#1008)", async () => {
    // A registered member whose email is NOT synthetic (@nemar.test /
    // test@nemar.org) models the mirrored production users in the dev
    // D1. The gate must refuse to issue a code — same 200 shape as an
    // unregistered address, no dev_code, dev_skip explains why.
    const email = `pl-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await seedWebUser(email);
    const req = await requestCode(email);
    expect(req.status).toBe(200);
    expect(req.body.ok).toBe(true);
    expect(req.body.dev_code).toBeUndefined();
    expect(req.body.dev_skip).toBe("not_allowlisted");
  });

  test("re-request rotates: first code stops working, second works", async () => {
    const email = freshEmail("rotate");
    await seedWebUser(email);
    const first = await requestCode(email);
    expect(first.status).toBe(200);
    const firstCode = first.body.dev_code as string;

    // The per-email rate limit is 1/min, so wait briefly past the
    // 60-second window. To avoid a 60s sleep in CI, exploit the fact
    // that the rate-limit window is measured in datetime('now','-1
    // minute') — a SLEEP-free way is to just expect 429 on the
    // immediate re-request and rely on a dedicated test for rotation
    // semantics by using a different email.
    //
    // Instead of waiting, verify rotation semantics by:
    //   1) confirming the first code verifies (happy path coverage)
    //   2) confirming an in-flight code is rotated when /code/request
    //      runs against the same email after passing the rate gate.
    // We sleep for 61s only when explicitly opted in to avoid slow CI.
    if (!process.env.TEST_PASSWORDLESS_ROTATION) {
      // Fast-path coverage: confirm the first code DOES verify.
      const v = await verifyCode(email, firstCode, false);
      expect(v.status).toBe(200);
      return;
    }

    await new Promise((r) => setTimeout(r, 61_000));
    const second = await requestCode(email);
    expect(second.status).toBe(200);
    const secondCode = second.body.dev_code as string;
    expect(secondCode).not.toBe(firstCode);

    // First code is now invalidated.
    const vOld = await verifyCode(email, firstCode, false);
    expect(vOld.status).toBe(401);

    const vNew = await verifyCode(email, secondCode, false);
    expect(vNew.status).toBe(200);
  });

  test("5 wrong attempts invalidates the code", async () => {
    const email = freshEmail("attempts");
    await seedWebUser(email);
    const req = await requestCode(email);
    expect(req.status).toBe(200);
    const realCode = req.body.dev_code as string;

    // Five wrong codes — keep them syntactically valid (6 digits) but
    // guaranteed not to match.
    const wrong = realCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await verifyCode(email, wrong, false);
      expect(r.status).toBe(401);
    }

    // Sixth attempt with the right code is still rejected because
    // the row was marked used_at on attempt 5.
    const r = await verifyCode(email, realCode, false);
    expect(r.status).toBe(401);
  });

  test("verify rejects disallowed Origin", async () => {
    const email = freshEmail("origin");
    await seedWebUser(email);
    const req = await requestCode(email);
    const code = req.body.dev_code as string;
    const r = await verifyCode(email, code, false, "https://evil.example");
    expect(r.status).toBe(403);
  });

  test("verify rejects missing Origin", async () => {
    const email = freshEmail("noorigin");
    await seedWebUser(email);
    const req = await requestCode(email);
    const code = req.body.dev_code as string;
    const r = await fetch(`${API}/auth/code/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...baseHeaders },
      body: JSON.stringify({ email, code, remember: false }),
    });
    expect(r.status).toBe(403);
  });

  test("per-email rate limit: 2 requests within 60s returns 429", async () => {
    const email = freshEmail("ratelimit");
    await seedWebUser(email);
    const first = await requestCode(email);
    expect(first.status).toBe(200);
    const second = await requestCode(email);
    expect(second.status).toBe(429);
  });

  test("/me without cookie returns { user: null }", async () => {
    const r = await fetch(`${API}/auth/me`, { headers: baseHeaders });
    expect(r.status).toBe(200);
    const body = (await r.json()) as MeResponse;
    expect(body.user).toBeNull();
  });

  test("/logout without cookie is idempotent", async () => {
    const r = await fetch(`${API}/auth/logout`, {
      method: "POST",
      headers: { ...baseHeaders, Origin: ORIGIN },
    });
    expect(r.status).toBe(200);
  });

  test("masked email format: first char + N-1 stars + @domain", async () => {
    // Synthetic address — avoids creating live test rows against any
    // real account. Five-char local part exercises the >1-char branch
    // of maskEmail. Doubles as coverage for the #595 unregistered-skip
    // path: this email is never seeded, so the response must still
    // shape-match the success contract even though no row was created.
    const email = `mask-${Date.now()}@example.test`; // local part > 1
    const r = await requestCode(email);
    expect(r.status).toBe(200);
    const masked = r.body.masked_email;
    // First char preserved, rest replaced by stars, domain verbatim.
    expect(masked.startsWith("m")).toBe(true);
    expect(masked).toMatch(/^m\*+@example\.test$/);
    expect(masked.length).toBe(email.length); // same total length
  });

  // -----------------------------------------------------------------
  // #595 — /code/request must not create a phantom user or send an
  // email when the address is not already registered.
  // -----------------------------------------------------------------
  test("unregistered email: 200 + masked, no dev_code, no users row", async () => {
    const email = freshEmail("unreg");

    const r = await requestCode(email);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.masked_email).toMatch(/^[a-z]\*+@nemar\.test$/);
    // Dev-only signal that the gate fired (production response omits
    // dev_skip entirely; dev_code must NEVER be present here).
    expect(r.body.dev_code).toBeUndefined();
    expect(r.body.dev_skip).toBe("unregistered");

    // The verify endpoint should refuse — no code was ever issued.
    const v = await verifyCode(email, "000000", false);
    expect(v.status).toBe(401);

    // Admin-side proof that no row was created. /admin/users supports a
    // status filter; the unregistered email shouldn't appear in ANY
    // status bucket. Scan all four ('pending', 'verified', 'approved',
    // 'revoked') so a future regression that inserts with a different
    // default status would still be caught — the original #595
    // acceptance criterion is `SELECT COUNT(*) WHERE email = ?` = 0,
    // not "no pending row".
    for (const bucket of ["pending", "verified", "approved", "revoked"] as const) {
      const r = await fetch(`${API}/admin/users?status=${bucket}`, {
        headers: { Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`, ...baseHeaders },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { users: Array<{ email: string }> };
      expect(body.users.find((u) => u.email === email)).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------
  // #572 — cookie auth on user-scoped routes.
  // -----------------------------------------------------------------
  test("cookie auth: /datasets?mine=true accepts nemar_session", async () => {
    const email = freshEmail("cookie572");
    // Seed directly as 'approved' so the cookie path in authMiddleware
    // (status='approved' gate) accepts it. The fixture is dev-only so
    // this can't be used to short-circuit production approval.
    await seedWebUser(email, "approved");

    const req = await requestCode(email);
    expect(req.status).toBe(200);
    const code = req.body.dev_code as string;
    expect(typeof code).toBe("string");
    const v = await verifyCode(email, code, true);
    expect(v.status).toBe(200);
    const m = v.setCookie?.match(/nemar_session=([^;]+)/);
    expect(m).toBeTruthy();
    const cookieValue = m?.[1] as string;

    // GET /datasets?mine=true with cookie only (no Authorization
    // header). Pre-#572 this returned 401 "Authentication required to
    // view your datasets" because the bearer-only middleware never saw
    // the cookie.
    const mine = await fetch(`${API}/datasets?mine=true`, {
      headers: { ...baseHeaders, Cookie: `nemar_session=${cookieValue}` },
    });
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as { datasets: unknown[] };
    expect(Array.isArray(mineBody.datasets)).toBe(true);
  });

  test("cookie auth: no cookie + no bearer still 401s /datasets?mine=true", async () => {
    // Negative control for the #572 change: removing the cookie path
    // must not loosen the bearer-only behaviour for completely
    // unauthenticated requests.
    const r = await fetch(`${API}/datasets?mine=true`, { headers: baseHeaders });
    expect(r.status).toBe(401);
  });

  test("cookie auth: pending cookie is rejected on /datasets?mine=true", async () => {
    // The cookie path in `resolveCookieUser` hard-gates on
    // status='approved'. Pending and verified users CAN still get a
    // cookie out of /code/verify (the dashboard uses /auth/me to
    // render the onboarding screen for them), but they must NOT be
    // accepted on user-mutating routes. Without this test, a future
    // refactor that relaxes the gate to also accept 'verified' or
    // 'pending' would land silently.
    const email = freshEmail("cookie572-pending");
    await seedWebUser(email, "pending");

    const req = await requestCode(email);
    expect(req.status).toBe(200);
    const code = req.body.dev_code as string;
    expect(typeof code).toBe("string");
    const v = await verifyCode(email, code, true);
    // /code/verify happily issues a session for a pending user (the
    // dashboard's `/auth/me` reads it to render onboarding) — assert
    // the cookie is set so the next step exercises a real session.
    expect(v.status).toBe(200);
    const m = v.setCookie?.match(/nemar_session=([^;]+)/);
    expect(m).toBeTruthy();
    const cookieValue = m?.[1] as string;

    const mine = await fetch(`${API}/datasets?mine=true`, {
      headers: { ...baseHeaders, Cookie: `nemar_session=${cookieValue}` },
    });
    expect(mine.status).toBe(401);
  });

  test("cookie auth: bearer wins when both bearer and cookie are sent", async () => {
    // The middleware's documented order is "Bearer first, cookie
    // second". Send a valid cookie for user A alongside the existing
    // TEST_USER_API_KEY bearer (user B). The /users/me response must
    // identify user B, NOT user A — proving bearer short-circuits the
    // cookie path. Without this test, a future refactor that falls
    // through to cookie on bearer failure would be undetectable.
    if (!TEST_CONFIG.userApiKey) {
      console.warn("[#572 bearer-wins] TEST_USER_API_KEY unset; skipping bearer-wins assertion");
      return;
    }

    const cookieEmail = freshEmail("cookie572-bearerwins");
    await seedWebUser(cookieEmail, "approved");
    const req = await requestCode(cookieEmail);
    const code = req.body.dev_code as string;
    const v = await verifyCode(cookieEmail, code, true);
    const m = v.setCookie?.match(/nemar_session=([^;]+)/);
    expect(m).toBeTruthy();
    const cookieValue = m?.[1] as string;

    // /users/me uses `authMiddleware` and returns the resolved user's
    // email — perfect identity probe.
    const me = await fetch(`${API}/users/me`, {
      headers: {
        ...baseHeaders,
        Authorization: `Bearer ${TEST_CONFIG.userApiKey}`,
        Cookie: `nemar_session=${cookieValue}`,
      },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { email: string } };
    // Bearer must win — the returned email must NOT be the
    // cookie holder's seeded address.
    expect(meBody.user.email).not.toBe(cookieEmail);
  });
});
