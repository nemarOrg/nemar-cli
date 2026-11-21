/**
 * `GET`/`PUT /users/me/email-preferences` (epic #2260 phase 4, ADR 0132): an account reads and sets
 * its own community mail categories. Driven through the Worker's own entry point (`worker.fetch`),
 * at BOTH mounts (`/users/...` and `/nemar/users/...`), over the real migrated schema, with a real
 * API key and a real session row. Nothing is replaced.
 *
 * What it holds: a new account reads every category on and a migrated account reads what it stored,
 * beside a locked recall; a PUT turns a category off and back on, and answers what is stored; a
 * recall, an admin alert, an unknown key or a non-boolean value is refused by name and writes
 * nothing; each actual change leaves one `mail_category_changed` row with `via: "self"`, and a PUT
 * that changes nothing leaves none; a cookie write without a NEMAR Origin is refused while a cookie
 * read needs none; a key needs no Origin; a pending account's session may read and set (the router
 * is mounted above `/users`, whose authMiddleware would refuse it); no credential is a 401.
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
  opts: { status?: string; prefs?: string | null; key?: string; cookie?: string } = {},
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
       VALUES (?, ?, datetime('now', '+1 day'), 'app')`,
    ).run(id, await hashCookieId(opts.cookie));
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

      test("each actual change writes one audit row with via self; a repeat writes none", async () => {
        await call(mount, "PUT", { key: MEMBER_KEY }, { news: false, maintenance: true });
        // maintenance was already on: only news changed.
        expect(categoryAudits()).toEqual([
          {
            user_id: memberId,
            resource_id: String(memberId),
            details: { category: "news", on: false, via: "self" },
          },
        ]);

        const again = await call(mount, "PUT", { key: MEMBER_KEY }, { news: false });
        expect(again.status).toBe(200);
        expect(categoryAudits()).toHaveLength(1);

        await call(mount, "PUT", { key: MEMBER_KEY }, { news: true });
        expect(categoryAudits().map((row) => row.details)).toEqual([
          { category: "news", on: false, via: "self" },
          { category: "news", on: true, via: "self" },
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

      test("a cookie write from a NEMAR page lands", async () => {
        const res = await call(
          mount,
          "PUT",
          { cookie: MEMBER_COOKIE, origin: NEMAR_ORIGIN },
          { maintenance: false },
        );
        expect(res.status).toBe(200);
        expect((await res.json()).maintenance).toBe(false);
        expect(categoryAudits().map((row) => row.details)).toEqual([
          { category: "maintenance", on: false, via: "self" },
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
