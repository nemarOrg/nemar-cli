/**
 * `GET`/`PUT /admin/email-preferences` after the community categories (epic #2260 phase 1, ADR 0132).
 *
 * The real admin router, the real migrated schema, a real API key per caller: the request goes
 * through `adminMiddleware`, the zod schema, `resolveEmailPrefsTarget`, `saveEmailPreferences` and
 * D1's batch, the way the CLI's request does. Nothing is replaced.
 *
 * What it holds: the three community categories are stored and echoed beside a locked recall;
 * `announcements` and `recall` are refused by name and write nothing; an owner or an admin may turn
 * a community category on OR off for another account (owner decision D8, 2026-11-20) while another
 * account's admin alerts stay the owner's; and every community change leaves a
 * `mail_category_changed` audit row in the same batch as the write.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { COMMUNITY_ONLY_REFUSAL } from "../../shared/contract/mail-categories.js";
import { adminRoutes } from "../src/routes/admin";
import { parseEmailPreferences } from "../src/services/email";
import { saveEmailPreferences } from "../src/services/mail-preferences";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "prefs-route-owner-key-0123456789abcdef012345";
const ADMIN_KEY = "prefs-route-admin-key-0123456789abcdef012345";
const MEMBER_KEY = "prefs-route-member-key-0123456789abcdef01234";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;

async function seed(
  username: string,
  role: "owner" | "admin" | "member",
  key?: string,
  prefs?: string,
) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, email_preferences)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, ?)`,
  ).run(username, `${username}@prefs.test`, role, prefs ?? null);
  if (!key) return;
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!u) throw new Error("seed failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  env = { DB: realD1(db), ENVIRONMENT: "development" } as unknown as Bindings;
  await seed("theowner", "owner", OWNER_KEY);
  await seed("theadmin", "admin", ADMIN_KEY);
  await seed("themember", "member", MEMBER_KEY);
  await seed("otheradmin", "admin");
  await seed("target", "member", undefined, '{"news":false,"rfcs":true,"maintenance":true}');
});

function call(method: "GET" | "PUT", key: string, query = "", body?: unknown) {
  return app.request(
    `/admin/email-preferences${query}`,
    {
      method,
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

function storedPrefs(username: string): string | null {
  return (
    db
      .query<{ email_preferences: string | null }, [string]>(
        "SELECT email_preferences FROM users WHERE username = ?",
      )
      .get(username)?.email_preferences ?? null
  );
}

function audits(action?: string) {
  const rows = db
    .query<{ user_id: number; action: string; resource_id: string; details: string }, []>(
      "SELECT user_id, action, resource_id, details FROM audit_log ORDER BY id",
    )
    .all();
  return action ? rows.filter((r) => r.action === action) : rows;
}

const idOf = (username: string) =>
  db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username)?.id;

describe("reading", () => {
  test("self: the three community categories, the admin alerts and a locked recall", async () => {
    const res = await call("GET", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user_approval: true,
      publication_request: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
      news: true,
      rfcs: true,
      maintenance: true,
      recall: { on: true, locked: true },
      username: "theadmin",
    });
  });

  test("an owner reading another account sees every key", async () => {
    const body = (await (await call("GET", OWNER_KEY, "?user=target")).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      news: false,
      rfcs: true,
      user_approval: true,
      username: "target",
    });
  });

  test("an admin reading another account sees the community categories and the recall only", async () => {
    const res = await call("GET", ADMIN_KEY, "?user=target");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      news: false,
      rfcs: true,
      maintenance: true,
      recall: { on: true, locked: true },
      username: "target",
    });
  });

  test("a member is refused by the admin gate", async () => {
    expect((await call("GET", MEMBER_KEY)).status).toBe(403);
    expect((await call("PUT", MEMBER_KEY, "", { news: false })).status).toBe(403);
    expect(storedPrefs("themember")).toBeNull();
  });
});

describe("a person's own change", () => {
  test("is stored, echoed, and audited once per changed category with via cli", async () => {
    const res = await call("PUT", ADMIN_KEY, "", { news: false, rfcs: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      news: false,
      rfcs: false,
      maintenance: true,
      recall: { on: true, locked: true },
      username: "theadmin",
    });
    expect(parseEmailPreferences(storedPrefs("theadmin"))).toMatchObject({
      news: false,
      rfcs: false,
      maintenance: true,
    });
    const rows = audits("mail_category_changed");
    expect(rows.map((r) => JSON.parse(r.details))).toEqual([
      { category: "news", on: false, via: "self" },
      { category: "rfcs", on: false, via: "self" },
    ]);
    expect(
      rows.every(
        (r) => r.user_id === idOf("theadmin") && r.resource_id === String(idOf("theadmin")),
      ),
    ).toBe(true);
    // Acting on yourself is not "changing someone else's preferences".
    expect(audits("email_preferences_updated")).toEqual([]);
  });

  test("writes no consent row for a value that did not change", async () => {
    const res = await call("PUT", ADMIN_KEY, "", { news: true, maintenance: true });
    expect(res.status).toBe(200);
    expect(audits("mail_category_changed")).toEqual([]);
  });

  test("an admin alert change is stored but is not a community consent record", async () => {
    await call("PUT", ADMIN_KEY, "", { support_tickets: false });
    expect(parseEmailPreferences(storedPrefs("theadmin")).support_tickets).toBe(false);
    expect(audits("mail_category_changed")).toEqual([]);
  });
});

/**
 * A D1 that lands another writer's change just before the first batch it is asked to run, which is
 * where a request's read-then-write is exposed: anything the route read earlier is now stale. The
 * write goes through the real database, so the interleaving is real, only deterministic.
 */
function withConcurrentWriteBeforeBatch(d1: D1Database, write: () => void): D1Database {
  let fired = false;
  return {
    prepare: (sql: string) => d1.prepare(sql),
    batch: (statements: D1PreparedStatement[]) => {
      if (!fired) {
        fired = true;
        write();
      }
      return d1.batch(statements);
    },
  } as unknown as D1Database;
}

describe("a concurrent write between the read and the save", () => {
  test("is not reverted: only the keys the request names are written", async () => {
    // Another request switches an admin alert off while this one turns news off. A route that read
    // the blob and wrote all of it back would restore support_tickets to true.
    env = {
      ...env,
      DB: withConcurrentWriteBeforeBatch(realD1(db), () =>
        db
          .query(
            `UPDATE users SET email_preferences = '{"support_tickets":false}' WHERE username = 'theadmin'`,
          )
          .run(),
      ),
    } as Bindings;
    const res = await call("PUT", ADMIN_KEY, "", { news: false });
    expect(res.status).toBe(200);
    expect(parseEmailPreferences(storedPrefs("theadmin"))).toMatchObject({
      support_tickets: false,
      news: false,
    });
    // The answer reports what is stored, concurrent write included.
    expect(await res.json()).toMatchObject({ support_tickets: false, news: false });
  });

  test("the audit diffs against the value actually replaced, not a copy read earlier", async () => {
    // By the time the batch runs, news is already off (another writer turned it off), so this
    // request replaces false with false and changes nothing: no consent row may claim on -> off.
    env = {
      ...env,
      DB: withConcurrentWriteBeforeBatch(realD1(db), () =>
        db
          .query(
            `UPDATE users SET email_preferences = '{"news":false}' WHERE username = 'theadmin'`,
          )
          .run(),
      ),
    } as Bindings;
    const res = await call("PUT", ADMIN_KEY, "", { news: false });
    expect(res.status).toBe(200);
    expect(audits("mail_category_changed")).toEqual([]);

    // And the converse: a real change to a key another writer left alone is recorded once.
    const next = await call("PUT", ADMIN_KEY, "", { news: true });
    expect(next.status).toBe(200);
    expect(audits("mail_category_changed").map((r) => JSON.parse(r.details))).toEqual([
      { category: "news", on: true, via: "self" },
    ]);
  });
});

describe("refusals write nothing", () => {
  test("announcements is retired and named, so an old client learns the replacement", async () => {
    const res = await call("PUT", ADMIN_KEY, "", { announcements: false, news: false });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("announcements_retired");
    expect(body.message).toContain("news, rfcs and maintenance");
    // The refusal is total: the valid key sent beside it is not applied either.
    expect(storedPrefs("theadmin")).toBeNull();
    expect(audits()).toEqual([]);
  });

  test("a recall cannot be set to either value, and the refusal says why", async () => {
    for (const value of [false, true, { on: false }]) {
      const res = await call("PUT", ADMIN_KEY, "", { recall: value });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("recall_cannot_be_turned_off");
      expect(body.message).toContain("Recalls cannot be turned off");
    }
    expect(storedPrefs("theadmin")).toBeNull();
    expect(audits()).toEqual([]);
  });

  test("the retired and locked keys are refused for another account too", async () => {
    expect((await call("PUT", OWNER_KEY, "?user=target", { recall: false })).status).toBe(400);
    expect((await call("PUT", OWNER_KEY, "?user=target", { announcements: true })).status).toBe(
      400,
    );
    expect(storedPrefs("target")).toBe('{"news":false,"rfcs":true,"maintenance":true}');
  });
});

describe("acting for another account (D8)", () => {
  test("an admin may turn a community category OFF, audited as admin, and the actor is recorded", async () => {
    const res = await call("PUT", ADMIN_KEY, "?user=target", { rfcs: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      news: false,
      rfcs: false,
      maintenance: true,
      recall: { on: true, locked: true },
      username: "target",
    });
    expect(parseEmailPreferences(storedPrefs("target")).rfcs).toBe(false);
    const rows = audits("mail_category_changed");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details)).toEqual({ category: "rfcs", on: false, via: "admin" });
    expect(rows[0].user_id).toBe(idOf("theadmin"));
    expect(rows[0].resource_id).toBe(String(idOf("target")));
    expect(audits("email_preferences_updated")).toHaveLength(1);
  });

  test("an admin may also turn one ON for another account", async () => {
    // target stored news:false in the seed.
    const res = await call("PUT", ADMIN_KEY, "?user=target", { news: true });
    expect(res.status).toBe(200);
    expect(parseEmailPreferences(storedPrefs("target")).news).toBe(true);
    expect(audits("mail_category_changed").map((r) => JSON.parse(r.details))).toEqual([
      { category: "news", on: true, via: "admin" },
    ]);
  });

  test("an admin may not change another account's admin alerts, and nothing is written", async () => {
    const res = await call("PUT", ADMIN_KEY, "?user=otheradmin", {
      support_tickets: false,
      news: false,
    });
    expect(res.status).toBe(403);
    const refusal = ((await res.json()) as { error: string }).error;
    expect(refusal).toContain("Only owners");
    // The CLI's --all sends every alert plus the categories; the sentence names the flags that work.
    expect(refusal).toContain("--news, --rfcs and --maintenance");
    expect(storedPrefs("otheradmin")).toBeNull();
    expect(audits()).toEqual([]);
  });

  test("an admin's --all-shaped request for another account is refused whole", async () => {
    const res = await call("PUT", ADMIN_KEY, "?user=target", {
      user_approval: false,
      publication_request: false,
      dataset_anonymity: false,
      identifier_sweep: false,
      support_tickets: false,
      news: false,
      rfcs: false,
      maintenance: false,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(COMMUNITY_ONLY_REFUSAL);
    // Nothing was applied, including the community keys that would have been allowed alone.
    expect(storedPrefs("target")).toBe('{"news":false,"rfcs":true,"maintenance":true}');
  });

  test("an owner may change another account's admin alerts and community categories together", async () => {
    const res = await call("PUT", OWNER_KEY, "?user=otheradmin", {
      support_tickets: false,
      maintenance: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ support_tickets: false, maintenance: false });
    expect(parseEmailPreferences(storedPrefs("otheradmin"))).toMatchObject({
      support_tickets: false,
      maintenance: false,
    });
    expect(audits("mail_category_changed").map((r) => JSON.parse(r.details))).toEqual([
      { category: "maintenance", on: false, via: "admin" },
    ]);
  });

  test("a deleted or unknown target is a 404 that writes nothing", async () => {
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE username = 'target'").run();
    expect((await call("PUT", ADMIN_KEY, "?user=target", { news: true })).status).toBe(404);
    expect((await call("PUT", ADMIN_KEY, "?user=nobody", { news: true })).status).toBe(404);
    expect(audits()).toEqual([]);
  });
});

describe("saveEmailPreferences on an account that vanished mid-request", () => {
  test("writes neither the preferences nor any audit row", async () => {
    // A request cannot reach this through the route (the target is resolved live first), so the
    // statements the route runs are driven directly: the update matches no live row, and the
    // audit rows, which are conditional on a live row, must not claim a change that did not happen.
    const id = idOf("target");
    if (id === undefined) throw new Error("seed failed");
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(id);
    const applied = await saveEmailPreferences(realD1(db), {
      targetId: id,
      targetUsername: "target",
      actorId: idOf("theowner") as number,
      changes: { news: true, rfcs: false },
      via: "admin",
    });
    expect(applied).toBe(false);
    expect(audits()).toEqual([]);
    expect(storedPrefs("target")).toBe('{"news":false,"rfcs":true,"maintenance":true}');
  });

  test("an empty change on a deleted account is not-found too, and writes nothing", async () => {
    const id = idOf("target") as number;
    const input = {
      targetId: id,
      targetUsername: "target",
      actorId: idOf("theowner") as number,
      changes: {},
      via: "admin" as const,
    };
    expect(await saveEmailPreferences(realD1(db), input)).toBe(true);
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(id);
    expect(await saveEmailPreferences(realD1(db), input)).toBe(false);
    expect(audits()).toEqual([]);
  });

  test("a column that holds garbage is replaced by an object holding the keys set", async () => {
    db.query("UPDATE users SET email_preferences = '{not json' WHERE username = 'target'").run();
    const applied = await saveEmailPreferences(realD1(db), {
      targetId: idOf("target") as number,
      targetUsername: "target",
      actorId: idOf("target") as number,
      changes: { rfcs: false },
      via: "self",
    });
    expect(applied).toBe(true);
    expect(JSON.parse(storedPrefs("target") as string)).toEqual({ rfcs: false });
  });
});

describe("the uncategorized group send is retired (phase 3)", () => {
  const notify = (payload: Record<string, unknown>) =>
    app.request(
      "/admin/notify",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      env,
    );

  test("a group send without a category is refused", async () => {
    const res = await notify({ to: "all", subject: "Hello", body: "Body", dry_run: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "category_required" });
  });

  test("the retired key decides nothing: only the category's own choice does", async () => {
    // `announcements` no longer exists as a stored key (migration 0146). A row that still carries it
    // (a restore, or the window before the follow-up migration drops it) must not decide anything.
    await seed("allon", "member");
    await seed("newsoff", "member", undefined, '{"news":false}');
    await seed("rfcsoff", "member", undefined, '{"rfcs":false}');
    await seed("legacykey", "member", undefined, '{"announcements":false}');
    const res = await notify({
      to: "all",
      category: "news",
      subject: "Hello",
      body: "Body",
      dry_run: true,
    });
    expect(res.status).toBe(200);
    // The route's env is production-less, so the dry run answers counts; the audience is read from a
    // production-environment dry run of the same request.
    const prod = await app.request(
      "/admin/notify",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          to: "all",
          category: "news",
          subject: "Hello",
          body: "Body",
          dry_run: true,
        }),
      },
      { ...env, ENVIRONMENT: "production" },
    );
    const body = (await prod.json()) as { recipients: string[] };
    expect(body.recipients).toContain("allon@prefs.test");
    expect(body.recipients).toContain("legacykey@prefs.test");
    expect(body.recipients).toContain("rfcsoff@prefs.test");
    expect(body.recipients).not.toContain("newsoff@prefs.test");
    // "target" stored news:false in the seed.
    expect(body.recipients).not.toContain("target@prefs.test");
  });
});
