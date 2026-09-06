/**
 * Username and name self-service on PATCH /auth/profile, plus
 * GET /auth/profile/username-suggestion (ADR 0042, #1253, epic #1250).
 *
 * 19 live accounts have `username = NULL` -- web/ORCID sign-ups, where the
 * column has been NULL by design since migration 0026. They cannot be approved
 * for upload (the review card and `nemar admin approve <username>` are keyed on
 * it) and cannot be addressed anywhere in the product. This is where they get
 * one, and where an account whose ORCID record hides its name can finally type
 * one in (ADR 0041 left that dead end open on purpose, for this phase).
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, real Hono
 * dispatch through webSessionMiddleware, real session issuance via
 * issueSession, real zod validation. No network is involved -- none of these
 * paths calls GitHub (a patch that does not change the handle skips it) -- so
 * there is no external boundary to stand in for.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authWebRoutes } from "../src/routes/auth-web";
import { isUsernameUniqueViolation } from "../src/services/username";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ORIGIN = "https://nemar.org";
const ENCRYPTION_KEY = "profile-username-test-encryption-key-01234";
const ORCID_ID = "0000-0002-1825-0097";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    WEB_SESSION_COOKIE_DOMAIN: "",
  } as unknown as Bindings;
}

interface SeedOptions {
  username?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  status?: string;
  orcid?: string | null;
  orcid_verified?: number;
  deleted?: boolean;
}

/** A web/ORCID-shaped row by default: no username, ORCID verified. */
function seedUser(email: string, options: SeedOptions = {}): number {
  const row = {
    username: null,
    given_name: "Ada",
    family_name: "Lovelace",
    status: "verified",
    orcid: ORCID_ID,
    orcid_verified: 1,
    deleted: false,
    ...options,
  };
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, orcid, orcid_verified, signup_source,
                        city, country, deleted_at)
     VALUES (?, ?, 'x', ?, 'member', 1, ?, ?, ?, ?, 'web', 'San Diego', 'USA', ?)`,
  ).run(
    row.username,
    email,
    row.status,
    row.given_name,
    row.family_name,
    row.orcid,
    row.orcid_verified,
    row.deleted ? "2026-01-01T00:00:00Z" : null,
  );
  const u = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!u) throw new Error(`seed failed for ${email}`);
  return u.id;
}

async function cookieFor(userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, null, null, "orcid");
  return `nemar_session=${cookieIdRaw}`;
}

async function patch(userId: number, body: unknown): Promise<Response> {
  return app.request(
    "/auth/profile",
    {
      method: "PATCH",
      headers: {
        Origin: ORIGIN,
        Cookie: await cookieFor(userId),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env(),
  );
}

async function suggestion(userId: number): Promise<Response> {
  return app.request(
    "/auth/profile/username-suggestion",
    { headers: { Cookie: await cookieFor(userId) } },
    env(),
  );
}

function usernameOf(id: number): string | null {
  return (
    db
      .query<{ username: string | null }, [number]>("SELECT username FROM users WHERE id = ?")
      .get(id)?.username ?? null
  );
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
});

describe("PATCH /auth/profile: username", () => {
  test("sets a username on an account that has none", async () => {
    const id = seedUser("new@example.org");

    const res = await patch(id, { username: "alovelace" });
    expect(res.status).toBe(200);
    expect(usernameOf(id)).toBe("alovelace");
  });

  test("trims, and refuses a format the CLI signup would refuse", async () => {
    const id = seedUser("fmt@example.org");

    expect((await (await patch(id, { username: "ab" })).json()).error).toBe("username_too_short");
    expect((await (await patch(id, { username: "x".repeat(31) })).json()).error).toBe(
      "username_too_long",
    );
    expect((await (await patch(id, { username: "ada lovelace" })).json()).error).toBe(
      "username_charset",
    );
    // An empty string is a refusal, not a clear: the account still needs one.
    expect((await (await patch(id, { username: "   " })).json()).error).toBe("username_too_short");
    expect(usernameOf(id)).toBeNull();

    const ok = await patch(id, { username: "  alovelace  " });
    expect(ok.status).toBe(200);
    expect(usernameOf(id)).toBe("alovelace");
  });

  test("refuses a username another account holds, case-insensitively", async () => {
    seedUser("taken@example.org", { username: "ALovelace" });
    const id = seedUser("mine@example.org");

    // `users.username` is UNIQUE case-SENSITIVELY (migration 0001), so without
    // the explicit COLLATE NOCASE check this write would land and the catalog
    // would hold two accounts one shift key apart.
    const res = await patch(id, { username: "alovelace" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("username_taken");
    expect(usernameOf(id)).toBeNull();
  });

  test("is locked once an admin has approved the account", async () => {
    const id = seedUser("approved@example.org", { username: "alovelace", status: "approved" });

    const res = await patch(id, { username: "adalove" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("username_locked");
    expect(usernameOf(id)).toBe("alovelace");
  });

  test("an approved account with NO username can still set one", async () => {
    // The 19 rows this phase exists for. They are approved and hold NULL, so a
    // lock on the FIELD (rather than on a change) would leave them permanently
    // without a username -- the exact state ADR 0042 exists to end, and the
    // thing `nemar admin approve <username>` needs to address them by.
    const id = seedUser("approved-null@example.org", { username: null, status: "approved" });

    const res = await patch(id, { username: "alovelace" });
    expect(res.status).toBe(200);
    expect(usernameOf(id)).toBe("alovelace");
  });

  test("a whitespace-only username counts as absent for the lock", async () => {
    const id = seedUser("approved-blank@example.org", { username: "   ", status: "approved" });

    expect((await patch(id, { username: "alovelace" })).status).toBe(200);
    expect(usernameOf(id)).toBe("alovelace");
  });

  test("a revoked account cannot reach the profile route at all", async () => {
    // The handler carries a 409 `account_revoked` for a rename, and it is
    // unreachable today: findSessionByCookieId filters `u.status != 'revoked'`,
    // so the middleware answers 401 first. Pinned as the OBSERVABLE behaviour
    // rather than asserted as a 409 that no request can produce.
    const id = seedUser("revoked@example.org", { username: "oldname", status: "revoked" });

    const res = await patch(id, { username: "newname" });
    expect(res.status).toBe(401);
    expect(usernameOf(id)).toBe("oldname");
  });

  test("an approved account can still save its other fields", async () => {
    // The Settings form sends every field on every save, so re-submitting the
    // current username must be a no-op rather than a 409 that blocks the rest
    // of the form.
    const id = seedUser("resave@example.org", { username: "alovelace", status: "approved" });

    const res = await patch(id, { username: "ALOVELACE", city: "Boston" });
    expect(res.status).toBe(200);
    expect(usernameOf(id)).toBe("alovelace");
    expect(
      db.query<{ city: string }, [number]>("SELECT city FROM users WHERE id = ?").get(id)?.city,
    ).toBe("Boston");
  });

  test("a patch that is only a no-op username writes nothing and still answers 200", async () => {
    const id = seedUser("noop@example.org", { username: "alovelace", status: "approved" });

    const res = await patch(id, { username: "alovelace" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // No audit row: nothing changed.
    expect(
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM audit_log WHERE action = ?")
        .get("profile_updated")?.n,
    ).toBe(0);
  });

  test("two simultaneous claims on one free username produce one owner", async () => {
    // The pre-check (COLLATE NOCASE) is strictly stricter than the column's own
    // case-sensitive UNIQUE constraint, so the constraint only ever fires in
    // the window BETWEEN that check and the write. Which of the two refuses
    // this pair depends on how the two handlers interleave, and both answer
    // 409 `username_taken` -- so what is pinned here is the invariant they
    // share: exactly one owner, no 500, and no duplicate in the table.
    const a = seedUser("racer-a@example.org");
    const b = seedUser("racer-b@example.org");

    const [resA, resB] = await Promise.all([
      patch(a, { username: "contested" }),
      patch(b, { username: "contested" }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = resA.status === 409 ? resA : resB;
    expect((await loser.json()).error).toBe("username_taken");
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) as n FROM users WHERE username = ? COLLATE NOCASE",
        )
        .get("contested")?.n,
    ).toBe(1);
  });

  test("the UNIQUE-violation classifier recognises a real constraint error", async () => {
    // The safety net in the PATCH's catch block, fed the ACTUAL error bun:sqlite
    // raises for this table rather than a hand-written string -- a copy would
    // keep passing after SQLite reworded it.
    db.query(
      "INSERT INTO users (username, email, password_hash, status) VALUES ('dup', 'a@example.org', 'x', 'verified')",
    ).run();
    let raised: unknown;
    try {
      db.query(
        "INSERT INTO users (username, email, password_hash, status) VALUES ('dup', 'b@example.org', 'x', 'verified')",
      ).run();
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeDefined();
    expect(isUsernameUniqueViolation(raised)).toBe(true);
    // And it does not swallow a different column's collision, which has its own
    // answer in the same catch block.
    expect(isUsernameUniqueViolation(new Error("UNIQUE constraint failed: users.email"))).toBe(
      false,
    );
  });
});

describe("PATCH /auth/profile: name", () => {
  test("refuses a name edit while a verified ORCID is linked", async () => {
    const id = seedUser("orcid@example.org", { orcid_verified: 1 });

    const res = await patch(id, { given_name: "Augusta", family_name: "Byron" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("name_is_orcid_canonical");
    expect(
      db
        .query<{ given_name: string }, [number]>("SELECT given_name FROM users WHERE id = ?")
        .get(id)?.given_name,
    ).toBe("Ada");
  });

  test("accepts a name edit when no ORCID is linked", async () => {
    // ADR 0041 blocks publishing without a citable name, and an account with no
    // ORCID had no way to supply one at all before this.
    const id = seedUser("noorcid@example.org", {
      orcid: null,
      orcid_verified: 0,
      given_name: null,
      family_name: null,
    });

    const res = await patch(id, { given_name: "Augusta", family_name: "Byron" });
    expect(res.status).toBe(200);
    const row = db
      .query<{ given_name: string; family_name: string }, [number]>(
        "SELECT given_name, family_name FROM users WHERE id = ?",
      )
      .get(id);
    expect(row).toMatchObject({ given_name: "Augusta", family_name: "Byron" });
  });

  test("an unverified ORCID does not make the name canonical", async () => {
    // `orcid_verified = 0` means nothing re-reads that record on sign-in, so
    // there is nothing to overwrite a typed name with.
    const id = seedUser("unverified-orcid@example.org", { orcid_verified: 0 });

    expect((await patch(id, { family_name: "Byron" })).status).toBe(200);
  });

  test("a verified flag with no iD behind it does not lock the name", async () => {
    // A deliberately corrupt shape: `orcid_verified = 1` with no `orcid`.
    // Nothing in the schema prevents it and no production row is known to have
    // it, so only a synthetic fixture can falsify this rule -- which is why it
    // is here rather than "redundant with the test above". The two possible
    // readings of such a row fail in opposite directions: treating the flag
    // alone as canonical locks an account out of the name entry ADR 0041's
    // dead end exists to give it, with no self-service fix. So the gate needs
    // an actual iD, not just the flag.
    const id = seedUser("flag-only@example.org", { orcid: null, orcid_verified: 1 });

    expect((await patch(id, { family_name: "Byron" })).status).toBe(200);
  });

  test("an empty name is refused rather than stored", async () => {
    const id = seedUser("blank@example.org", { orcid: null, orcid_verified: 0 });

    expect((await (await patch(id, { given_name: "  " })).json()).error).toBe(
      "given_name_required",
    );
    expect((await (await patch(id, { family_name: "" })).json()).error).toBe(
      "family_name_required",
    );
  });
});

describe("GET /auth/profile/username-suggestion", () => {
  test("is first initial plus family name, lowercased", async () => {
    const id = seedUser("suggest@example.org");

    const body = await (await suggestion(id)).json();
    expect(body).toEqual({ suggestion: "alovelace", based_on: "name" });
  });

  test("folds accents to ASCII rather than dropping the letter", async () => {
    const id = seedUser("fold@example.org", { given_name: "Émile", family_name: "Ekström" });

    // Not "ekstrm", and not "Éekstrom": the given name's first character is
    // folded before it is taken.
    expect((await (await suggestion(id)).json()).suggestion).toBe("eekstrom");
  });

  test("keeps a hyphenated family name and drops everything else", async () => {
    const id = seedUser("hyphen@example.org", {
      given_name: "Marie",
      family_name: "Curie-Skłodowska",
    });

    // ł has no ASCII base to decompose to, so it folds away entirely.
    expect((await (await suggestion(id)).json()).suggestion).toBe("mcurie-skodowska");
  });

  test("suffixes past a collision, case-insensitively", async () => {
    seedUser("first@example.org", { username: "alovelace" });
    seedUser("second@example.org", { username: "ALovelace-2" });
    const id = seedUser("third@example.org");

    expect((await (await suggestion(id)).json()).suggestion).toBe("alovelace-3");
  });

  test("reports unavailable when there is no family name", async () => {
    // 3 of the 19 production rows are exactly this shape. Nothing is derived
    // from the email local part (ADR 0042).
    const id = seedUser("oneword@example.org", { given_name: "Prince", family_name: null });

    const body = await (await suggestion(id)).json();
    expect(body).toEqual({ suggestion: null, based_on: "unavailable" });
  });

  test("reports unavailable when the name has no ASCII to fold to", async () => {
    const id = seedUser("cjk@example.org", { given_name: "明", family_name: "王" });

    expect((await (await suggestion(id)).json()).suggestion).toBeNull();
  });

  test("a saturated base is reported as exhausted, not as unavailable", async () => {
    // Two different problems with the same empty field: "we cannot build you a
    // default" and "the default we built is taken 50 times over". Only the
    // second is an operational fact, and collapsing them hides it.
    db.query(
      "INSERT INTO users (username, email, password_hash, status) VALUES ('alovelace', 'u1@example.org', 'x', 'approved')",
    ).run();
    for (let n = 2; n <= 50; n++) {
      db.query(
        "INSERT INTO users (username, email, password_hash, status) VALUES (?, ?, 'x', 'approved')",
      ).run(`alovelace-${n}`, `u${n}@example.org`);
    }
    const id = seedUser("saturated@example.org");

    const body = await (await suggestion(id)).json();
    expect(body).toEqual({ suggestion: null, based_on: "exhausted" });
  });

  test("requires a session", async () => {
    const res = await app.request("/auth/profile/username-suggestion", {}, env());
    expect(res.status).toBe(401);
  });

  test("suggests, but does not reserve", async () => {
    // Two accounts asking at the same moment are both told "alovelace"; the
    // PATCH is where one of them loses. Pinned because a reservation table is
    // the obvious "fix" and is deliberately not here.
    const a = seedUser("a@example.org");
    const b = seedUser("b@example.org");

    expect((await (await suggestion(a)).json()).suggestion).toBe("alovelace");
    expect((await (await suggestion(b)).json()).suggestion).toBe("alovelace");
  });
});
