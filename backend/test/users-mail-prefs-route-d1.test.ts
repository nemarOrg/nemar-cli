/**
 * `GET`/`PUT /users/me/email-preferences` (epic #2260 phase 4, ADR 0132): an account reads and sets
 * its own community mail categories. Driven through the Worker's own entry point (`worker.fetch`),
 * at BOTH mounts (`/users/...` and `/nemar/users/...`), over the real migrated schema, with a real
 * API key and a real session row. Nothing is replaced.
 *
 * What it holds: a new account reads every category on and a migrated account reads what it stored,
 * beside a locked recall; a PUT turns a category off and back on, and answers what is stored; a
 * recall, an admin alert, an unknown key or a non-boolean value is refused by name and writes
 * nothing; each actual change leaves one `mail_category_changed` row, `via: "cli"` for a key and
 * `via: "settings"` for a cookie, and a PUT that changes nothing (`{}` included) leaves none; a cookie write without a NEMAR Origin is refused while a cookie
 * read needs none; a key needs no Origin; a pending account's session may read and set (the router
 * is mounted above `/users`, whose authMiddleware would refuse it), while the rest of `/users` keeps
 * its own rule; every credential that must not work (revoked, deleted, expired, docs-scoped, a
 * pending or revoked account's key, a non-Bearer header, none) is refused and writes nothing; and
 * every answer carries `Cache-Control: no-store`.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mailRecallWhy } from "../../shared/contract/mail-categories.js";
import worker from "../src/index";
import { hashApiKey } from "../src/services/token";
import { hashCookieId } from "../src/services/web-session";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const MOUNTS = ["", "/nemar"] as const;
const MEMBER_KEY = "self-prefs-member-key-0123456789abcdef0123456";
const MIGRATED_KEY = "self-prefs-migrated-key-0123456789abcdef01234";
const MEMBER_COOKIE = "self-prefs-member-cookie-0123456789abcdef012";
const PENDING_COOKIE = "self-prefs-pending-cookie-0123456789abcdef01";
const NEMAR_ORIGIN = "https://app.nemar.org";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let db: Database;

async function seedUser(
  username: string,
  opts: {
    status?: string;
    prefs?: string | null;
    key?: string;
    cookie?: string;
    sessionExpires?: string;
    scope?: "app" | "docs";
  } = {},
): Promise<number> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, email_preferences)
     VALUES (?, ?, 'x', ?, 'member', ?, 0, ?)`,
  ).run(
    username,
    `${username}@self-prefs.test`,
    opts.status ?? "approved",
    opts.status === "pending" ? 0 : 1,
    opts.prefs ?? null,
  );
  const id = (
    db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username) as {
      id: number;
    }
  ).id;
  if (opts.key) {
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      id,
      await hashApiKey(opts.key),
      opts.key.slice(0, 8),
    );
  }
  if (opts.cookie) {
    db.query(
      `INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at, scope)
       VALUES (?, ?, datetime('now', ?), ?)`,
    ).run(
      id,
      await hashCookieId(opts.cookie),
      opts.sessionExpires ?? "+1 day",
      opts.scope ?? "app",
    );
  }
  return id;
}

let memberId: number;
let pendingId: number;

beforeEach(async () => {
  db = freshDb();
  memberId = await seedUser("member", { key: MEMBER_KEY, cookie: MEMBER_COOKIE });
  // What migration 0146 leaves on an account that had announcements off: explicit false keys.
  await seedUser("migrated", {
    key: MIGRATED_KEY,
    prefs: '{"user_approval":true,"news":false,"rfcs":false,"maintenance":true}',
  });
  pendingId = await seedUser("pending", { status: "pending", cookie: PENDING_COOKIE });
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "development",
    API_BASE_URL: "https://api.nemar.org",
    APP_BASE_URL: NEMAR_ORIGIN,
  } as unknown as Bindings;
}

type Credential = { key: string } | { cookie: string; origin?: string } | null;

function call(
  mount: string,
  method: "GET" | "PUT",
  credential: Credential,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credential && "key" in credential) headers.Authorization = `Bearer ${credential.key}`;
  if (credential && "cookie" in credential) {
    headers.Cookie = `nemar_session=${credential.cookie}`;
    if (credential.origin) headers.Origin = credential.origin;
  }
  return worker.fetch(
    new Request(`https://api.nemar.org${mount}/users/me/email-preferences`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    env(),
    ctx,
  );
}

function stored(id: number): string | null {
  return (
    db
      .query<{ email_preferences: string | null }, [number]>(
        "SELECT email_preferences FROM users WHERE id = ?",
      )
      .get(id)?.email_preferences ?? null
  );
}

function categoryAudits() {
  return db
    .query<{ user_id: number; resource_id: string; details: string }, []>(
      "SELECT user_id, resource_id, details FROM audit_log WHERE action = 'mail_category_changed' ORDER BY id",
    )
    .all()
    .map((row) => ({ ...row, details: JSON.parse(row.details) }));
}

const LOCKED = { on: true, locked: true };

for (const mount of MOUNTS) {
  describe(`${mount || "/"} mount`, () => {
    describe("GET", () => {
      test("a new account reads every category on, beside a locked recall", async () => {
        const res = await call(mount, "GET", { key: MEMBER_KEY });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          news: true,
          rfcs: true,
          maintenance: true,
          recall: LOCKED,
        });
      });

      test("a migrated account reads what it stored, and no admin alert", async () => {
        const res = await call(mount, "GET", { key: MIGRATED_KEY });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          news: false,
          rfcs: false,
          maintenance: true,
          recall: LOCKED,
        });
      });

      test("a session cookie reads without an Origin header", async () => {
        const res = await call(mount, "GET", { cookie: MEMBER_COOKIE });
        expect(res.status).toBe(200);
        expect((await res.json()).news).toBe(true);
      });

      test("a pending account's session may read its categories", async () => {
        const res = await call(mount, "GET", { cookie: PENDING_COOKIE });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          news: true,
          rfcs: true,
          maintenance: true,
          recall: LOCKED,
        });
      });

      test("no credential is a 401, and an unknown key is refused", async () => {
        expect((await call(mount, "GET", null)).status).toBe(401);
        expect(
          (await call(mount, "GET", { key: "nope-not-a-key-0123456789abcdef01234567" })).status,
        ).toBe(401);
      });
    });

    describe("PUT", () => {
      test("turns a category off and back on with a key, and answers what is stored", async () => {
        const off = await call(mount, "PUT", { key: MEMBER_KEY }, { news: false });
        expect(off.status).toBe(200);
        expect(await off.json()).toEqual({
          news: false,
          rfcs: true,
          maintenance: true,
          recall: LOCKED,
        });
        expect(JSON.parse(stored(memberId) ?? "{}")).toEqual({ news: false });

        const on = await call(mount, "PUT", { key: MEMBER_KEY }, { news: true, rfcs: false });
        expect(on.status).toBe(200);
        expect(await on.json()).toEqual({
          news: true,
          rfcs: false,
          maintenance: true,
          recall: LOCKED,
        });
      });

      test("each actual change with a key writes one audit row with via cli; a repeat writes none", async () => {
        await call(mount, "PUT", { key: MEMBER_KEY }, { news: false, maintenance: true });
        // maintenance was already on: only news changed.
        expect(categoryAudits()).toEqual([
          {
            user_id: memberId,
            resource_id: String(memberId),
            details: { category: "news", on: false, via: "cli" },
          },
        ]);

        const again = await call(mount, "PUT", { key: MEMBER_KEY }, { news: false });
        expect(again.status).toBe(200);
        expect(categoryAudits()).toHaveLength(1);

        await call(mount, "PUT", { key: MEMBER_KEY }, { news: true });
        expect(categoryAudits().map((row) => row.details)).toEqual([
          { category: "news", on: false, via: "cli" },
          { category: "news", on: true, via: "cli" },
        ]);
        // A self edit is not an edit of someone else's preferences.
        const crossAccount = db
          .query("SELECT 1 FROM audit_log WHERE action = 'email_preferences_updated'")
          .all();
        expect(crossAccount).toHaveLength(0);
      });

      test("recall is refused by name with the sentence that says why, and nothing is written", async () => {
        const res = await call(mount, "PUT", { key: MEMBER_KEY }, { news: false, recall: false });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: "recall_cannot_be_turned_off",
          field: "recall",
          message: mailRecallWhy(),
        });
        expect(stored(memberId)).toBeNull();
        expect(categoryAudits()).toHaveLength(0);
      });

      for (const alert of [
        "user_approval",
        "publication_request",
        "dataset_anonymity",
        "identifier_sweep",
        "support_tickets",
        "compute_requests",
      ]) {
        test(`the admin alert ${alert} is refused by name`, async () => {
          const res = await call(mount, "PUT", { key: MEMBER_KEY }, { [alert]: false });
          expect(res.status).toBe(400);
          const body = await res.json();
          expect(body.error).toBe("admin_alert_not_self_service");
          expect(body.field).toBe(alert);
          expect(body.message).toContain(alert);
          expect(stored(memberId)).toBeNull();
        });
      }

      test("an unknown key, the retired announcements key included, is refused by name", async () => {
        for (const key of ["announcements", "newsletter"]) {
          const res = await call(mount, "PUT", { key: MEMBER_KEY }, { rfcs: false, [key]: false });
          expect(res.status).toBe(400);
          const body = await res.json();
          expect(body.error).toBe("unknown_mail_preference");
          expect(body.field).toBe(key);
        }
        expect(stored(memberId)).toBeNull();
      });

      test("a non-boolean value and a non-object body are refused", async () => {
        const wrongType = await call(mount, "PUT", { key: MEMBER_KEY }, { news: "off" });
        expect(wrongType.status).toBe(400);
        expect(await wrongType.json()).toMatchObject({
          error: "invalid_mail_preference",
          field: "news",
        });
        for (const body of ["[]", "null", "not json"]) {
          const res = await call(mount, "PUT", { key: MEMBER_KEY }, body);
          expect(res.status).toBe(400);
          expect((await res.json()).error).toBe("invalid_mail_preference");
        }
        expect(stored(memberId)).toBeNull();
      });

      test("a cookie write without a NEMAR Origin is refused and writes nothing", async () => {
        for (const origin of [undefined, "https://evil.example.com"]) {
          const res = await call(mount, "PUT", { cookie: MEMBER_COOKIE, origin }, { news: false });
          expect(res.status).toBe(403);
        }
        expect(stored(memberId)).toBeNull();
        expect(categoryAudits()).toHaveLength(0);
      });

      test("a cookie write from a NEMAR page lands, audited with via settings", async () => {
        const res = await call(
          mount,
          "PUT",
          { cookie: MEMBER_COOKIE, origin: NEMAR_ORIGIN },
          { maintenance: false },
        );
        expect(res.status).toBe(200);
        expect((await res.json()).maintenance).toBe(false);
        expect(categoryAudits().map((row) => row.details)).toEqual([
          { category: "maintenance", on: false, via: "settings" },
        ]);
      });

      test("a pending account's session may set its categories", async () => {
        const res = await call(
          mount,
          "PUT",
          { cookie: PENDING_COOKIE, origin: NEMAR_ORIGIN },
          { news: false },
        );
        expect(res.status).toBe(200);
        expect((await res.json()).news).toBe(false);
        expect(JSON.parse(stored(pendingId) ?? "{}")).toEqual({ news: false });
      });

      test("no credential is refused: 403 without a NEMAR Origin, 401 with one", async () => {
        // resolveActingAccount asks for the Origin before it looks for a session, so a bare
        // request is refused as cross-site, the way every other self-service edit answers it.
        expect((await call(mount, "PUT", null, { news: false })).status).toBe(403);
        const res = await worker.fetch(
          new Request(`https://api.nemar.org${mount}/users/me/email-preferences`, {
            method: "PUT",
            headers: { "content-type": "application/json", Origin: NEMAR_ORIGIN },
            body: JSON.stringify({ news: false }),
          }),
          env(),
          ctx,
        );
        expect(res.status).toBe(401);
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Review round 1: refused credentials, the rest of /users, edge bodies, Cache-Control
// ---------------------------------------------------------------------------------------------

const REVOKED_KEY = "self-prefs-revoked-key-0123456789abcdef01234567";
const PENDING_KEY = "self-prefs-pending-key-0123456789abcdef01234567";
const REVOKED_COOKIE = "self-prefs-revoked-cookie-0123456789abcdef0";
const DELETED_COOKIE = "self-prefs-deleted-cookie-0123456789abcdef0";
const EXPIRED_COOKIE = "self-prefs-expired-cookie-0123456789abcdef0";
const DOCS_COOKIE = "self-prefs-docs-cookie-0123456789abcdef0123";

function raw(
  mount: string,
  path: string,
  method: "GET" | "PUT",
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.nemar.org${mount}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env(),
    ctx,
  );
}

describe("refused credentials", () => {
  const ids: Record<string, number> = {};

  beforeEach(async () => {
    ids.revoked = await seedUser("revokedone", {
      status: "revoked",
      key: REVOKED_KEY,
      cookie: REVOKED_COOKIE,
    });
    ids.pendingKey = await seedUser("pendingkey", { status: "pending", key: PENDING_KEY });
    ids.deleted = await seedUser("deletedone", { cookie: DELETED_COOKIE });
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(ids.deleted);
    ids.expired = await seedUser("expiredone", {
      cookie: EXPIRED_COOKIE,
      sessionExpires: "-1 hour",
    });
    ids.docs = await seedUser("docsone", { cookie: DOCS_COOKIE, scope: "docs" });
  });

  const cookieCases = [
    ["a revoked account's session", REVOKED_COOKIE, "revoked"],
    ["a soft-deleted account's session", DELETED_COOKIE, "deleted"],
    ["an expired session", EXPIRED_COOKIE, "expired"],
    ["a docs-scoped session", DOCS_COOKIE, "docs"],
  ] as const;
  const keyCases = [
    ["a revoked account's key", REVOKED_KEY, "revoked"],
    ["a pending account's key", PENDING_KEY, "pendingKey"],
  ] as const;

  for (const mount of MOUNTS) {
    for (const [name, cookie, who] of cookieCases) {
      test(`${mount || "/"}: ${name} is refused on GET and PUT and writes nothing`, async () => {
        const read = await raw(mount, "/users/me/email-preferences", "GET", {
          Cookie: `nemar_session=${cookie}`,
        });
        expect(read.status).toBe(401);
        // With a NEMAR Origin, so the refusal is the session's and not the Origin rule's.
        const write = await raw(
          mount,
          "/users/me/email-preferences",
          "PUT",
          { Cookie: `nemar_session=${cookie}`, Origin: NEMAR_ORIGIN },
          { news: false },
        );
        expect(write.status).toBe(401);
        expect(stored(ids[who] as number)).toBeNull();
        expect(categoryAudits()).toHaveLength(0);
      });
    }

    for (const [name, key, who] of keyCases) {
      test(`${mount || "/"}: ${name} is a 403 on GET and PUT and writes nothing`, async () => {
        const read = await raw(mount, "/users/me/email-preferences", "GET", {
          Authorization: `Bearer ${key}`,
        });
        expect(read.status).toBe(403);
        const write = await raw(
          mount,
          "/users/me/email-preferences",
          "PUT",
          { Authorization: `Bearer ${key}` },
          { news: false },
        );
        expect(write.status).toBe(403);
        expect(stored(ids[who] as number)).toBeNull();
        expect(categoryAudits()).toHaveLength(0);
      });
    }

    test(`${mount || "/"}: a non-Bearer Authorization header is a 401 and writes nothing`, async () => {
      const header = { Authorization: `Basic ${btoa(`member:${MEMBER_KEY}`)}` };
      expect((await raw(mount, "/users/me/email-preferences", "GET", header)).status).toBe(401);
      const write = await raw(mount, "/users/me/email-preferences", "PUT", header, { news: false });
      expect(write.status).toBe(401);
      expect(stored(memberId)).toBeNull();
    });
  }
});

describe("the rest of /users is not shadowed", () => {
  for (const mount of MOUNTS) {
    test(`${mount || "/"}: /users/me and /users/me/datasets still answer a key`, async () => {
      const auth = { Authorization: `Bearer ${MEMBER_KEY}` };
      const me = await raw(mount, "/users/me", "GET", auth);
      expect(me.status).toBe(200);
      expect((await me.json()).user.username).toBe("member");
      const datasets = await raw(mount, "/users/me/datasets", "GET", auth);
      expect(datasets.status).toBe(200);
    });

    test(`${mount || "/"}: a pending session is still refused on /users/me`, async () => {
      const res = await raw(mount, "/users/me", "GET", {
        Cookie: `nemar_session=${PENDING_COOKIE}`,
      });
      expect(res.status).toBe(403);
    });
  }
});

describe("edge bodies", () => {
  for (const mount of MOUNTS) {
    test(`${mount || "/"}: {} answers the current view and writes nothing`, async () => {
      const res = await call(mount, "PUT", { key: MIGRATED_KEY }, {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        news: false,
        rfcs: false,
        maintenance: true,
        recall: LOCKED,
      });
      expect(categoryAudits()).toHaveLength(0);
    });

    test(`${mount || "/"}: a valid change followed by an unknown key is refused whole`, async () => {
      const res = await call(mount, "PUT", { key: MEMBER_KEY }, { news: false, news2: true });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "unknown_mail_preference", field: "news2" });
      expect(stored(memberId)).toBeNull();
      expect(categoryAudits()).toHaveLength(0);
    });
  }
});

describe("Cache-Control", () => {
  for (const mount of MOUNTS) {
    test(`${mount || "/"}: every answer is no-store, refusals included`, async () => {
      const answers = [
        await call(mount, "GET", { key: MEMBER_KEY }),
        await call(mount, "PUT", { key: MEMBER_KEY }, { news: false }),
        await call(mount, "PUT", { key: MEMBER_KEY }, { recall: false }),
        await call(mount, "GET", null),
      ];
      expect(answers.map((r) => r.status)).toEqual([200, 200, 400, 401]);
      for (const res of answers) expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
  }
});
