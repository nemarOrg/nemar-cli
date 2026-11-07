/**
 * POST /users/me/compute-access/request (epic #2021 phase D1, #2022; ADR 0118, the compute-access
 * addendum; ADR 0042's request-once shape for a grant of its own).
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration applied, the REAL `userRoutes`
 * behind the real `authMiddleware` (so both credential paths are the production ones) mounted by
 * `helpers/compute-app.ts`, real hashed API keys, real session issuance, real zod validation. The one
 * external boundary, Resend, is a local `Bun.serve()` (helpers/resend.ts), so services/email.ts builds
 * its real HTML and passes its real delivery fence. No mocks of NEMAR logic.
 *
 * What is pinned:
 *  - each refusal code, in the order the rulebook gives them, with rows that fail TWO checks at once to
 *    prove the order (purpose, terms, inbox, ORCID proof, profile gaps);
 *  - the ORCID proof is an `oauth_identities` row, not the `orcid_verified` flag (ADR 0106), and the
 *    `service` and `test` kinds are exempt (ADR 0048);
 *  - request-once: two concurrent requests mail once (the UPDATE's `changes` decides), a request nobody
 *    was told of is re-mailed by the next call and then not again, and a refused request writes nothing;
 *  - the closed states (denied, revoked, and suspended) answer 409 `access_closed`, an active account
 *    409 `already_active`;
 *  - in the exact production environment the request is 503 `terms_unpublished` while the terms are
 *    unpublished, and not before an already-open request or an active grant is answered;
 *  - the route works whether or not the compute switch is on (it is bookkeeping, no Tapis), and it never
 *    reads or writes `service_access`.
 *
 * MUTATIONS (each applied to the production line, run, and restored; the results are in the PR):
 * swap the ORCID and profile checks; read `orcid_verified` instead of the identity row; drop
 * `AND compute_access = 'none'` from the request UPDATE; set `COMPUTE_TERMS_PUBLISHED` to true; count the
 * purpose in UTF-16 units; drop the notified stamp.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_ACCESS_STATES } from "../../shared/compute-access-state";
import { COMPUTE_TERMS_VERSION } from "../../shared/contract/compute-terms";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings } from "../src/types/bindings";
import { makeComputeApp } from "./helpers/compute-app";
import { freshDb, realD1, yieldingD1 } from "./helpers/d1";
import { sendsTo, withFakeResend } from "./helpers/resend";

const handle = makeComputeApp();
const USER_KEY = "cmpreq-user-key-0123456789abcdef0123456789abcdef";
const ENCRYPTION_KEY = "compute-access-test-encryption-key-0123456789";
/** `@nemar.test` is on DEV_EMAIL_ALLOWLIST below, which is what lets the admin notification reach the
 *  fake Resend so it can be counted at all. */
const USER_EMAIL = "cmpreq-person@nemar.test";
const ADMIN_EMAIL = "cmpreq-admin@nemar.test";
const PURPOSE =
  "Run ICA decompositions on public EEG datasets for a methods comparison, 40 subjects.";
const ORCID = "0000-0002-1825-0097";

let db: Database;
let userId: number;

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    RESEND_API_KEY: "fake-resend-key",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    // Admin notifications are production-only by default (getAdminEmailsForCategory's fence); this
    // suite is about the review card and the retry semantics, so it opts back in deliberately.
    DEV_ADMIN_NOTIFICATIONS: "1",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    WEB_SESSION_COOKIE_DOMAIN: "",
    ...over,
  } as unknown as Bindings;
}

interface Overrides {
  username?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  github_username?: string | null;
  city?: string | null;
  country?: string | null;
  affiliation?: string | null;
  email_verified?: number;
  orcid_verified?: number;
  account_kind?: "person" | "service" | "test";
  service_access?: number;
  compute_access?: string;
  compute_access_requested_at?: string | null;
  compute_access_notified_at?: string | null;
  /** Whether a real ORCID sign-in row exists (the proof); the default is that it does. */
  identity?: boolean;
}

/** A complete requester by default; each test blanks the one thing it is about. */
async function seedRequester(o: Overrides = {}): Promise<number> {
  const row = {
    username: "cmpreq",
    given_name: "Ada",
    family_name: "Rivers",
    github_username: null as string | null,
    city: "San Diego",
    country: "USA",
    affiliation: "Swartz Center",
    email_verified: 1,
    orcid_verified: 1,
    account_kind: "person",
    service_access: 0,
    compute_access: "none",
    compute_access_requested_at: null as string | null,
    compute_access_notified_at: null as string | null,
    ...o,
  };
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, github_username, city, country, affiliation,
                        orcid, orcid_verified, signup_source, service_access, account_kind,
                        compute_access, compute_access_requested_at, compute_access_notified_at)
     VALUES (?, ?, 'x', 'verified', 'member', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, ?)`,
  ).run(
    row.username,
    USER_EMAIL,
    row.email_verified,
    row.given_name,
    row.family_name,
    row.github_username,
    row.city,
    row.country,
    row.affiliation,
    ORCID,
    row.orcid_verified,
    row.service_access,
    row.account_kind,
    row.compute_access,
    row.compute_access_requested_at,
    row.compute_access_notified_at,
  );
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?")
    .get(USER_EMAIL);
  if (!u) throw new Error("seed: requester insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(USER_KEY),
    USER_KEY.slice(0, 8),
  );
  if (o.identity !== false) {
    db.query(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
    ).run(u.id, ORCID);
  }
  userId = u.id;
  return u.id;
}

function seedAdmin(): void {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES ('cmpreqadmin', ?, 'x', 'approved', 'admin', 1, 1)`,
  ).run(ADMIN_EMAIL);
}

interface Body {
  purpose?: string;
  accept_terms_version?: string;
}

const GOOD: Body = { purpose: PURPOSE, accept_terms_version: COMPUTE_TERMS_VERSION };

function request(body: Body = GOOD, over: Partial<Bindings> = {}, e?: Bindings): Promise<Response> {
  return handle(
    new Request("http://api.test/users/me/compute-access/request", {
      method: "POST",
      headers: { Authorization: `Bearer ${USER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    e ?? env(over),
  );
}

async function asJson(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

const row = () => db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<string, any>;
const audits = (action: string) =>
  db.query("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action) as Array<{
    user_id: number | null;
    resource_id: string | null;
    details: string | null;
  }>;

beforeEach(() => {
  db = freshDb();
  seedAdmin();
});

describe("the refusals, in the order the rulebook gives them", () => {
  test("a purpose outside 20 to 1000 characters is refused first, naming `purpose`", async () => {
    // The row fails EVERY other check as well (terms, inbox, ORCID proof, profile), so the answer
    // proves the purpose comes first.
    await seedRequester({
      email_verified: 0,
      identity: false,
      given_name: null,
      affiliation: null,
    });
    for (const purpose of ["", "too short", "x".repeat(19), "x".repeat(1001)]) {
      const res = await request({ purpose, accept_terms_version: "wrong" });
      expect(res.status).toBe(400);
      const body = await asJson(res);
      expect(body.error).toBe("purpose_required");
      expect(body.missing).toEqual(["purpose"]);
      expect(typeof body.message).toBe("string");
    }
  });

  test("the purpose bounds are inclusive at both ends, and whitespace does not count", async () => {
    await seedRequester();
    expect((await request({ ...GOOD, purpose: `   ${"x".repeat(19)}   ` })).status).toBe(400);
    const ok = await withFakeResend(() => request({ ...GOOD, purpose: "x".repeat(20) }));
    expect(ok.status).toBe(201);
    db.run(
      "UPDATE users SET compute_access = 'none', compute_access_requested_at = NULL WHERE id = ?",
      [userId],
    );
    expect(
      (await withFakeResend(() => request({ ...GOOD, purpose: "x".repeat(1000) }))).status,
    ).toBe(201);
  });

  test("the purpose is counted in characters, as the database counts them, not in UTF-16 units", async () => {
    // 19 emoji are 38 UTF-16 units and 19 characters: a `.length` check would let them through to a
    // CHECK constraint that refuses them. MUTATION: count `purpose.length` in `purposeLength`.
    await seedRequester();
    const nineteen = "\u{1F9E0}".repeat(19);
    expect(nineteen.length).toBe(38);
    const res = await request({ ...GOOD, purpose: nineteen });
    expect(res.status).toBe(400);
    expect((await asJson(res)).error).toBe("purpose_required");
    const twenty = "\u{1F9E0}".repeat(20);
    expect((await withFakeResend(() => request({ ...GOOD, purpose: twenty }))).status).toBe(201);
    expect(row().compute_purpose).toBe(twenty);
  });

  test("the terms version must be the current one, and comes before the inbox", async () => {
    await seedRequester({ email_verified: 0, identity: false });
    for (const accept_terms_version of [undefined, "", "2026-11", `${COMPUTE_TERMS_VERSION}x`]) {
      const res = await request({ purpose: PURPOSE, accept_terms_version });
      expect(res.status).toBe(400);
      const body = await asJson(res);
      expect(body.error).toBe("terms_not_accepted");
      expect(body.missing).toEqual(["accept_terms_version"]);
    }
  });

  test("an unverified inbox is refused before the ORCID proof and the profile", async () => {
    await seedRequester({ email_verified: 0, identity: false, given_name: null });
    const res = await request();
    expect(res.status).toBe(400);
    const body = await asJson(res);
    expect(body.error).toBe("email_not_verified");
    expect(body.missing).toEqual(["email_verified"]);
  });

  test("an unproven ORCID iD is refused before the profile gaps, naming orcid_verified", async () => {
    // MUTATION: swap the ORCID and profile checks in `checkComputeAccessRequest`, and this row (which
    // fails both) is answered `profile_incomplete`.
    await seedRequester({ identity: false, given_name: null, affiliation: null });
    const res = await request();
    expect(res.status).toBe(400);
    const body = await asJson(res);
    expect(body.error).toBe("orcid_not_proven");
    expect(body.missing).toEqual(["orcid_verified"]);
  });

  test("every profile gap that stops compute is reported at once, in matrix order", async () => {
    await seedRequester({
      given_name: null,
      family_name: "  ",
      city: null,
      country: null,
      affiliation: null,
    });
    const res = await request();
    expect(res.status).toBe(400);
    const body = await asJson(res);
    expect(body.error).toBe("profile_incomplete");
    expect(body.missing).toEqual(["given_name", "family_name", "city", "country", "affiliation"]);
  });

  test("a missing affiliation alone refuses compute (and only compute)", async () => {
    await seedRequester({ affiliation: null });
    const body = await asJson(await request());
    expect(body.error).toBe("profile_incomplete");
    expect(body.missing).toEqual(["affiliation"]);
  });

  test("a username and a GitHub handle are not asked for: they stop upload access, not compute", async () => {
    await seedRequester({ username: null, github_username: null });
    const res = await withFakeResend(() => request());
    expect(res.status).toBe(201);
  });

  test("a refused request writes nothing", async () => {
    await seedRequester({ affiliation: null });
    await request();
    const r = row();
    expect(r.compute_access).toBe("none");
    expect(r.compute_access_requested_at).toBeNull();
    expect(r.compute_purpose).toBeNull();
    expect(r.compute_terms_version).toBeNull();
    expect(r.compute_terms_accepted_at).toBeNull();
    expect(audits("compute_access_requested")).toHaveLength(0);
  });
});

describe("the ORCID proof is a sign-in row, not a flag", () => {
  test("orcid_verified = 1 with no oauth_identities row is refused", async () => {
    // ADR 0106: an owner can set the flag without any sign-in. MUTATION: read `orcid_verified`
    // instead of the identity row in the request route.
    await seedRequester({ orcid_verified: 1, identity: false });
    const res = await request();
    expect(res.status).toBe(400);
    expect((await asJson(res)).error).toBe("orcid_not_proven");
  });

  test("an identity row with the flag at 0 is accepted: the row is the proof", async () => {
    await seedRequester({ orcid_verified: 0, identity: true });
    expect((await withFakeResend(() => request())).status).toBe(201);
  });

  test("a test-kind or service-kind account is exempt (ADR 0048)", async () => {
    for (const kind of ["test", "service"] as const) {
      db = freshDb();
      seedAdmin();
      await seedRequester({ account_kind: kind, orcid_verified: 0, identity: false });
      const res = await withFakeResend(() => request());
      expect([kind, res.status]).toEqual([kind, 201]);
    }
  });

  test("a person-kind account with neither a row nor the flag is refused", async () => {
    await seedRequester({ account_kind: "person", orcid_verified: 0, identity: false });
    expect((await asJson(await request())).error).toBe("orcid_not_proven");
  });
});

describe("a successful request", () => {
  test("stores the state, the stamps, the purpose and the terms, and audits the shape only", async () => {
    await seedRequester();
    const res = await withFakeResend(() => request({ ...GOOD, purpose: `  ${PURPOSE}  ` }));
    expect(res.status).toBe(201);
    expect(await asJson(res)).toEqual({
      ok: true,
      already_requested: false,
      email_sent: true,
      admins_notified: 1,
    });
    const r = row();
    expect(r.compute_access).toBe("requested");
    expect(r.compute_access_requested_at).toBeTruthy();
    expect(r.compute_access_notified_at).toBeTruthy();
    expect(r.compute_purpose).toBe(PURPOSE);
    expect(r.compute_terms_version).toBe(COMPUTE_TERMS_VERSION);
    expect(r.compute_terms_accepted_at).toBeTruthy();
    // Upload access is untouched: a different grant.
    expect(r.service_access).toBe(0);
    expect(r.upload_access_requested_at).toBeNull();

    const [audit] = audits("compute_access_requested");
    expect(audits("compute_access_requested")).toHaveLength(1);
    expect(audit?.user_id).toBe(userId);
    expect(JSON.parse(audit?.details ?? "{}")).toEqual({ via: "cli", why_chars: PURPOSE.length });
    expect(audit?.details).not.toContain("ICA");
  });

  test("mails the admins one review card with every review field and a link to the compute tab", async () => {
    await seedRequester();
    const calls = await withFakeResend(async (captured) => {
      await request(GOOD, { APP_BASE_URL: "https://app.example.test" });
      return captured;
    });
    const sent = sendsTo(calls, ADMIN_EMAIL);
    expect(sent).toHaveLength(1);
    const html = sent[0]?.html ?? "";
    expect(sent[0]?.subject).toBe("[NEMAR] Compute access requested: cmpreq");
    for (const needle of [
      "Ada Rivers",
      USER_EMAIL,
      ORCID,
      "Swartz Center",
      "San Diego",
      "USA",
      PURPOSE,
      COMPUTE_TERMS_VERSION,
      "nemar admin compute access grant cmpreq",
      "https://app.example.test/admin/compute",
    ]) {
      expect([needle, html.includes(needle)]).toEqual([needle, true]);
    }
    // The requester is never mailed: they know they asked.
    expect(sendsTo(calls, USER_EMAIL)).toHaveLength(0);
  });

  test("a username-less account is addressed by id in the card", async () => {
    await seedRequester({ username: null });
    const calls = await withFakeResend(async (captured) => {
      await request();
      return captured;
    });
    const html = sendsTo(calls, ADMIN_EMAIL)[0]?.html ?? "";
    expect(html).toContain(`nemar admin compute access grant --id ${userId}`);
  });

  test("the web (cookie) path works and the audit row says so", async () => {
    const id = await seedRequester();
    const { cookieIdRaw } = await issueSession(env(), id, false, null, null, "orcid");
    const res = await withFakeResend(() =>
      handle(
        new Request("http://api.test/users/me/compute-access/request", {
          method: "POST",
          headers: { Cookie: `nemar_session=${cookieIdRaw}`, "content-type": "application/json" },
          body: JSON.stringify(GOOD),
        }),
        env(),
      ),
    );
    expect(res.status).toBe(201);
    expect(JSON.parse(audits("compute_access_requested")[0]?.details ?? "{}").via).toBe("web");
  });

  test("works with the compute switch off, unset or on: it is bookkeeping", async () => {
    // The request reads no switch (backend/test/compute-source-scan.test.ts pins who may).
    for (const COMPUTE_ENABLED of [undefined, "0", "1"]) {
      db = freshDb();
      seedAdmin();
      await seedRequester();
      const res = await withFakeResend(() => request(GOOD, { COMPUTE_ENABLED }));
      expect([COMPUTE_ENABLED, res.status]).toEqual([COMPUTE_ENABLED, 201]);
    }
  });
});

describe("request-once: idempotency", () => {
  test("two concurrent requests open one request and mail the admins once", async () => {
    // The D1 wrapper yields between statements, as real D1's round trips do, so both requests read
    // `none` before either writes. MUTATION: drop `AND compute_access = 'none'` from
    // COMPUTE_ACCESS_REQUEST_UPDATE_SQL, and both write and both mail.
    await seedRequester();
    const e = env();
    e.DB = yieldingD1(realD1(db));
    const { statuses, calls } = await withFakeResend(async (captured) => {
      const both = await Promise.all([request(GOOD, {}, e), request(GOOD, {}, e)]);
      return { statuses: both.map((r) => r.status).sort(), calls: captured };
    });
    expect(statuses).toEqual([200, 201]);
    expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    expect(audits("compute_access_requested")).toHaveLength(1);
  });

  test("a second request after the first does not mail again", async () => {
    await seedRequester();
    const calls = await withFakeResend(async (captured) => {
      expect((await request()).status).toBe(201);
      const again = await request();
      expect(again.status).toBe(200);
      const body = await asJson(again);
      expect(body.already_requested).toBe(true);
      expect(body.email_sent).toBe(true);
      expect(body.requested_at).toBeTruthy();
      return captured;
    });
    expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
  });

  test("a request nobody was told of is re-mailed by the next call, and then not again", async () => {
    // The first send fails at the provider, so the request is stored with `compute_access_notified_at`
    // NULL; short-circuiting on that row would turn request-once into request-never.
    await seedRequester();
    const first = await withFakeResend(() => request(), { status: 500 });
    expect(first.status).toBe(201);
    expect(await asJson(first)).toEqual({
      ok: true,
      already_requested: false,
      email_sent: false,
      admins_notified: 0,
    });
    expect(row().compute_access).toBe("requested");
    expect(row().compute_access_notified_at).toBeNull();

    const calls = await withFakeResend(async (captured) => {
      const retry = await request();
      expect(retry.status).toBe(200);
      expect(await asJson(retry)).toMatchObject({
        ok: true,
        already_requested: true,
        email_sent: true,
        admins_notified: 1,
      });
      const third = await request();
      expect(await asJson(third)).toMatchObject({ already_requested: true, admins_notified: null });
      return captured;
    });
    // The retry mailed once; the third call mailed nobody. The retry card carries the stored purpose.
    const sent = sendsTo(calls, ADMIN_EMAIL);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.html).toContain(PURPOSE);
    expect(sent[0]?.html).toContain(COMPUTE_TERMS_VERSION);
    expect(row().compute_access_notified_at).toBeTruthy();
  });

  test("an open request is answered before the preconditions: a profile gap does not reopen it", async () => {
    await seedRequester({
      compute_access: "requested",
      compute_access_requested_at: "2026-11-01 00:00:00",
      compute_access_notified_at: "2026-11-01 00:00:01",
      affiliation: null,
    });
    const res = await request();
    expect(res.status).toBe(200);
    expect((await asJson(res)).already_requested).toBe(true);
  });
});

describe("the states a request is answered from", () => {
  test("active answers 409 already_active", async () => {
    await seedRequester({ compute_access: "active" });
    const res = await request();
    expect(res.status).toBe(409);
    expect(await asJson(res)).toMatchObject({ error: "already_active", missing: [] });
  });

  for (const state of ["denied", "revoked", "suspended"]) {
    test(`${state} answers 409 access_closed and writes nothing`, async () => {
      await seedRequester({ compute_access: state });
      const res = await request();
      expect(res.status).toBe(409);
      expect(await asJson(res)).toMatchObject({ error: "access_closed", missing: [] });
      expect(row().compute_access).toBe(state);
      expect(audits("compute_access_requested")).toHaveLength(0);
    });
  }

  test("every one of the six states is answered, none crashes", async () => {
    for (const state of COMPUTE_ACCESS_STATES) {
      db = freshDb();
      seedAdmin();
      await seedRequester({
        compute_access: state,
        compute_access_notified_at: state === "requested" ? "2026-11-01 00:00:00" : null,
      });
      const res = await withFakeResend(() => request());
      expect([state, res.status < 500]).toEqual([state, true]);
    }
  });

  test("a request never touches service_access, in either direction", async () => {
    await seedRequester({ service_access: 1 });
    const res = await withFakeResend(() => request());
    expect(res.status).toBe(201);
    expect(row().service_access).toBe(1);
    db.run("UPDATE users SET service_access = 0, compute_access = 'none' WHERE id = ?", [userId]);
    await withFakeResend(() => request());
    expect(row().service_access).toBe(0);
  });
});

describe("the exact production environment, while the terms are unpublished", () => {
  test("a new request is 503 terms_unpublished and writes nothing", async () => {
    // MUTATION: set COMPUTE_TERMS_PUBLISHED to true in shared/contract/compute-terms.ts.
    await seedRequester();
    const res = await request(GOOD, { ENVIRONMENT: "production" });
    expect(res.status).toBe(503);
    expect(await asJson(res)).toMatchObject({ error: "terms_unpublished", missing: [] });
    expect(row().compute_access).toBe("none");
    expect(audits("compute_access_requested")).toHaveLength(0);
  });

  test("it is the exact word: a production look-alike is not production", async () => {
    await seedRequester();
    for (const ENVIRONMENT of ["Production", "production ", "prod", "staging", "development"]) {
      const res = await withFakeResend(() => request(GOOD, { ENVIRONMENT }));
      expect([ENVIRONMENT, res.status]).toEqual([ENVIRONMENT, 201]);
      db.run(
        "UPDATE users SET compute_access = 'none', compute_access_requested_at = NULL WHERE id = ?",
        [userId],
      );
    }
  });

  test("an active grant and an open request are answered as they are, not as 503", async () => {
    await seedRequester({ compute_access: "active" });
    expect((await request(GOOD, { ENVIRONMENT: "production" })).status).toBe(409);
    db.run(
      "UPDATE users SET compute_access = 'requested', compute_access_notified_at = datetime('now')",
    );
    expect((await request(GOOD, { ENVIRONMENT: "production" })).status).toBe(200);
  });
});

describe("the account payloads carry the state, optionally", () => {
  test("GET /users/me reports compute_access and its dates, and a non-null state is never defaulted", async () => {
    await seedRequester({
      compute_access: "requested",
      compute_access_requested_at: "2026-11-02 10:00:00",
      compute_access_notified_at: "2026-11-02 10:00:01",
    });
    const res = await handle(
      new Request("http://api.test/users/me", { headers: { Authorization: `Bearer ${USER_KEY}` } }),
      env(),
    );
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.user.compute_access).toBe("requested");
    expect(body.user.compute_access_requested_at).toBe("2026-11-02 10:00:00");
    expect(body.user.compute_access_granted_at).toBeNull();
    // The notification stamp is an operational fact and is not on the wire.
    expect(JSON.stringify(body)).not.toContain("notified");
    // The gap list is the one rule: this account lacks a GitHub handle (which stops upload access
    // and publication) and nothing that stops compute access.
    expect(body.user.profile_gaps.map((g: { field: string }) => g.field)).toEqual([
      "github_username",
    ]);
  });
});
