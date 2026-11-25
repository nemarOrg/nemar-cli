/**
 * The public unsubscribe routes (epic #2260 phase 2, ADR 0132):
 * `GET`/`POST /mail/unsubscribe/:token` and `GET .../info`, driven through the Worker's own entry
 * point (`worker.fetch`), at BOTH mounts (`/mail/...` and `/nemar/mail/...`), over the real
 * migrated schema. Nothing is replaced.
 *
 * What it holds: the link's GET is a 303 to `${APP_BASE_URL}/unsubscribe/<token>` for any token
 * that parses, reads neither D1 nor the secret (a D1 that throws on any statement proves it), and
 * is the uniform 410 with no Location for anything else (phase 5); /info changes nothing; an
 * RFC 8058 one-click POST changes exactly the token's category, answers 200 JSON, never redirects,
 * needs no cookie or key, and is idempotent. The website page drives the same POST, with
 * `from=page` for one category and `scope=all` for all three. A recall token, another category's
 * token, another account's token, a tampered signature, a rotated secret, a changed address, a
 * deleted account and a missing broadcast all answer the one uniform 410 from /info and the POST
 * and change nothing; an unset or short secret is a 503 there; every change is one audit row from
 * `saveEmailPreferences` with its `via`; and neither a token nor an address is logged.
 *
 * MUTATIONS (each makes a test below fail, and was applied and run): GET calls the writer; the
 * signature check returns true; the address is left out of the signed message; the
 * `deleted_at IS NULL` or the broadcast-row condition is removed; the parser accepts `recall`; the
 * previous secret is not tried; the POST answers a redirect; the secret check is removed; the GET's
 * parse guard is removed (phase 5).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { tombstoneUserCascade } from "../src/db/user-tombstone";
import worker from "../src/index";
import { __resetMailLinkReportsForTests, signMailLinkToken } from "../src/services/mail-links";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { logged } from "./helpers/logs";

const SECRET = "c".repeat(64);
const OLD_SECRET = "d".repeat(64);
const OTHER = "e".repeat(64);
const EMAIL = "reader@links.test";
const MOUNTS = ["", "/nemar"] as const;

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let db: Database;
let userId: number;
let otherId: number;
let newsBroadcast: number;
let rfcsBroadcast: number;
let recallBroadcast: number;

function seedUser(username: string, email: string, prefs: string | null = null): number {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, email_preferences)
     VALUES (?, ?, 'x', 'approved', 'member', 1, 1, ?)`,
  ).run(username, email, prefs);
  return (
    db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username) as {
      id: number;
    }
  ).id;
}

function seedBroadcast(category: string | null): number {
  db.query(
    `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, category)
     VALUES (?, 'all', 'subject', 'body', ?)`,
  ).run(userId, category);
  return (db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
}

function env(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "development",
    API_BASE_URL: "https://api.nemar.org",
    APP_BASE_URL: "https://app.nemar.org",
    MAIL_LINK_SECRET: SECRET,
    ...overrides,
  } as unknown as Bindings;
}

beforeEach(() => {
  __resetMailLinkReportsForTests();
  db = freshDb();
  userId = seedUser("reader", EMAIL);
  otherId = seedUser("bystander", "bystander@links.test");
  newsBroadcast = seedBroadcast("news");
  rfcsBroadcast = seedBroadcast("rfcs");
  recallBroadcast = seedBroadcast("recall");
});

const tokenFor = (
  claims: {
    userId?: number;
    category?: "news" | "rfcs" | "maintenance";
    broadcastId?: number;
  } = {},
  address = EMAIL,
  secret = SECRET,
) =>
  signMailLinkToken(
    {
      userId: claims.userId ?? userId,
      category: claims.category ?? "news",
      broadcastId: claims.broadcastId ?? newsBroadcast,
    },
    address,
    secret,
  );

function call(
  mount: string,
  method: "GET" | "POST",
  token: string,
  opts: { suffix?: string; body?: BodyInit; headers?: Record<string, string>; env?: Bindings } = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.nemar.org${mount}/mail/unsubscribe/${token}${opts.suffix ?? ""}`, {
      method,
      body: opts.body,
      headers: opts.headers,
    }),
    opts.env ?? env(),
    ctx,
  );
}

const ONE_CLICK = "List-Unsubscribe=One-Click";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const post = (mount: string, token: string, body = ONE_CLICK, extra: Record<string, string> = {}) =>
  call(mount, "POST", token, { body, headers: { ...FORM, ...extra } });

function stored(id: number): string | null {
  return (
    db
      .query<{ email_preferences: string | null }, [number]>(
        "SELECT email_preferences FROM users WHERE id = ?",
      )
      .get(id)?.email_preferences ?? null
  );
}

function audits() {
  return db
    .query<{ user_id: number; action: string; resource_id: string; details: string }, []>(
      "SELECT user_id, action, resource_id, details FROM audit_log ORDER BY id",
    )
    .all();
}

/** The whole mutable state a route could touch: every user's preferences row and the audit log. */
function snapshot(): string {
  return JSON.stringify({
    users: db.query("SELECT id, email_preferences FROM users ORDER BY id").all(),
    audit: audits(),
  });
}

const prefsOf = (id: number) => JSON.parse(stored(id) ?? "{}") as Record<string, unknown>;

/** A D1 that fails the test on any statement: the redirecting GET must not read or write it. */
const untouchableDb = {
  prepare(sql: string) {
    throw new Error(`the redirecting GET touched D1: ${sql}`);
  },
  batch() {
    throw new Error("the redirecting GET touched D1 (batch)");
  },
  exec(sql: string) {
    throw new Error(`the redirecting GET touched D1: ${sql}`);
  },
} as unknown as D1Database;

describe("the GET redirects to the website page and changes nothing", () => {
  const APP_BASES = [
    ["production", "https://app.nemar.org"],
    ["staging", "https://test.nemar.org"],
  ] as const;

  for (const mount of MOUNTS) {
    for (const [name, base] of APP_BASES) {
      test(`${name} at ${mount || "/"}: 303 to ${base}/unsubscribe/<token>, no-store, no-referrer, no write`, async () => {
        const before = snapshot();
        const token = await tokenFor();
        // The token's alphabet needs no escaping in a path, so it goes into Location as it is.
        expect(encodeURIComponent(token)).toBe(token);
        for (const accept of ["text/html", "application/json", ""]) {
          const res = await call(mount, "GET", token, {
            headers: accept ? { accept } : {},
            env: env({ APP_BASE_URL: base }),
          });
          expect(res.status).toBe(303);
          expect(res.headers.get("location")).toBe(`${base}/unsubscribe/${token}`);
          expect(res.headers.get("cache-control")).toBe("no-store");
          expect(res.headers.get("referrer-policy")).toBe("no-referrer");
          expect(res.headers.get("x-robots-tag")).toContain("noindex");
          expect(res.headers.get("set-cookie")).toBeNull();
          expect(await res.text()).toBe("");
        }
        expect(snapshot()).toBe(before);
      });
    }

    test(`at ${mount || "/"}: a HEAD answers the same redirect`, async () => {
      const token = await tokenFor();
      const res = await worker.fetch(
        new Request(`https://api.nemar.org${mount}/mail/unsubscribe/${token}`, { method: "HEAD" }),
        env(),
        ctx,
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`https://app.nemar.org/unsubscribe/${token}`);
    });
  }

  test("a trailing slash on APP_BASE_URL is not doubled, and an unset one is production's", async () => {
    const token = await tokenFor();
    const slashed = await call("", "GET", token, {
      env: env({ APP_BASE_URL: "https://test.nemar.org/" }),
    });
    expect(slashed.headers.get("location")).toBe(`https://test.nemar.org/unsubscribe/${token}`);
    const unset = await call("/nemar", "GET", token, { env: env({ APP_BASE_URL: undefined }) });
    expect(unset.headers.get("location")).toBe(`https://app.nemar.org/unsubscribe/${token}`);
  });

  test("a query string is not carried into Location", async () => {
    const token = await tokenFor();
    const res = await call("", "GET", token, { suffix: "?next=https://evil.example/" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://app.nemar.org/unsubscribe/${token}`);
  });

  test("reads neither D1 nor the secret: a parsed token is forwarded with the secret unset and with a D1 that throws", async () => {
    const token = await tokenFor();
    for (const bindings of [
      env({ DB: untouchableDb }),
      env({ DB: untouchableDb, MAIL_LINK_SECRET: undefined }),
      env({ DB: untouchableDb, MAIL_LINK_SECRET: "short" }),
    ]) {
      for (const mount of MOUNTS) {
        const res = await call(mount, "GET", token, { env: bindings });
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(`https://app.nemar.org/unsubscribe/${token}`);
      }
    }
  });

  test("a token that parses but is dead (bad signature, unknown account) is forwarded too: the page says so from /info", async () => {
    const before = snapshot();
    const good = await tokenFor();
    const dead = [
      `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`,
      await tokenFor({ userId: 99999 }),
      await tokenFor({}, EMAIL, OTHER),
    ];
    for (const token of dead) {
      const res = await call("", "GET", token);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`https://app.nemar.org/unsubscribe/${token}`);
      expect((await call("", "GET", token, { suffix: "/info" })).status).toBe(410);
    }
    expect(snapshot()).toBe(before);
  });

  test("anything that is not the token format is the uniform 410, with no Location, at both mounts", async () => {
    const before = snapshot();
    const token = await tokenFor();
    const sig = token.split(".").at(-1) as string;
    // Each is the raw path segment as sent; the router decodes it before the route sees it.
    const refused: Record<string, string> = {
      malformed: "not-a-token",
      encoded_slash: `${token.slice(0, 10)}%2F${token.slice(10)}`,
      encoded_question_mark: `${token}%3Fx`,
      encoded_hash: `${token}%23x`,
      encoded_space: `${token}%20`,
      encoded_percent: `${token}%25`,
      encoded_crlf: `${token}%0D%0ALocation:%20https:%2F%2Fevil.example`,
      non_ascii: `${token}%C3%A9`,
      uppercase_version: `V1${token.slice(2)}`,
      recall: `v1.${userId}.recall.${recallBroadcast}.${sig}`,
      unknown_category: `v1.${userId}.weekly.${newsBroadcast}.${sig}`,
      short_signature: token.slice(0, -1),
      long_signature: `${token}A`,
      overlong: `v1.${"1".repeat(200)}.news.1.${sig}`,
      absolute_url: "https:%2F%2Fevil.example",
    };
    for (const mount of MOUNTS) {
      for (const [name, segment] of Object.entries(refused)) {
        const res = await worker.fetch(
          new Request(`https://api.nemar.org${mount}/mail/unsubscribe/${segment}`),
          env(),
          ctx,
        );
        expect(res.status, name).toBe(410);
        expect(res.headers.get("location"), name).toBeNull();
        expect(res.headers.get("cache-control"), name).toBe("no-store");
        expect(await res.json(), name).toEqual({
          error: "link_invalid",
          message: "This unsubscribe link is not valid.",
        });
      }
    }
    // A raw `/` never reaches the token: it makes another path, which no route answers.
    for (const mount of MOUNTS) {
      const res = await call(mount, "GET", token, { suffix: "/https://evil.example" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(snapshot()).toBe(before);
  });

  for (const mount of MOUNTS) {
    test(`the info route at ${mount || "/"} answers JSON and writes nothing, however often it is read`, async () => {
      const before = snapshot();
      const token = await tokenFor({ category: "rfcs", broadcastId: rfcsBroadcast });
      for (let i = 0; i < 3; i++) {
        const res = await call(mount, "GET", token, { suffix: "/info" });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          category: "rfcs",
          label: "Requests for comments",
          masked_email: "r***@links.test",
          on: true,
        });
      }
      expect(snapshot()).toBe(before);
    });
  }

  test("info says when the category is already off", async () => {
    db.query("UPDATE users SET email_preferences = ? WHERE id = ?").run('{"news":false}', userId);
    const token = await tokenFor();
    const info = (await (await call("", "GET", token, { suffix: "/info" })).json()) as {
      on: boolean;
    };
    expect(info.on).toBe(false);
  });
});

describe("the one-click POST", () => {
  for (const mount of MOUNTS) {
    test(`at ${mount || "/"}: turns off only the token's category, answers 200 with no redirect, needs no session`, async () => {
      const res = await post(mount, await tokenFor());
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.redirected).toBe(false);
      expect(await res.json()).toEqual({
        status: "unsubscribed",
        scope: "category",
        category: "news",
      });
      expect(prefsOf(userId)).toEqual({ news: false });
      expect(prefsOf(otherId)).toEqual({});
      expect(audits()).toEqual([
        {
          user_id: userId,
          action: "mail_category_changed",
          resource_id: String(userId),
          details: JSON.stringify({ category: "news", on: false, via: "one_click" }),
        },
      ]);
    });
  }

  test("a multipart body is accepted too", async () => {
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    const res = await call("", "POST", await tokenFor(), { body: form });
    expect(res.status).toBe(200);
    expect(prefsOf(userId)).toEqual({ news: false });
  });

  test("an HTML-accepting client gets the same JSON, still 200, still no redirect", async () => {
    const res = await post("", await tokenFor(), ONE_CLICK, { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      status: "unsubscribed",
      scope: "category",
      category: "news",
    });
  });

  test("twice: the second changes nothing, answers the same, and adds no audit row", async () => {
    const token = await tokenFor();
    const first = await post("", token);
    const afterFirst = snapshot();
    const second = await post("", token);
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());
    expect(snapshot()).toBe(afterFirst);
    expect(audits()).toHaveLength(1);
  });

  test("a cookie or key on the request is not read: a bystander's session changes nothing", async () => {
    const res = await post("", await tokenFor(), ONE_CLICK, {
      cookie: "nemar_session=whatever",
      authorization: "Bearer nm_not-a-key",
    });
    expect(res.status).toBe(200);
    expect(prefsOf(userId)).toEqual({ news: false });
  });

  test("another stored key is left exactly as it was", async () => {
    db.query("UPDATE users SET email_preferences = ? WHERE id = ?").run(
      '{"user_approval":false,"rfcs":false}',
      userId,
    );
    await post("", await tokenFor());
    expect(prefsOf(userId)).toEqual({ user_approval: false, rfcs: false, news: false });
  });

  test("the page's category button is audited as link, its second button as link_all", async () => {
    await post(
      "",
      await tokenFor({ category: "rfcs", broadcastId: rfcsBroadcast }),
      `${ONE_CLICK}&from=page`,
    );
    expect(JSON.parse(audits().at(-1)?.details ?? "{}")).toEqual({
      category: "rfcs",
      on: false,
      via: "link",
    });
    const res = await post("", await tokenFor(), `${ONE_CLICK}&scope=all`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unsubscribed", scope: "all", category: "news" });
    expect(prefsOf(userId)).toEqual({ news: false, rfcs: false, maintenance: false });
    const vias = audits().map((a) => JSON.parse(a.details).via);
    expect(vias).toEqual(["link", "link_all", "link_all"]);
  });

  test("a body that is not the one-click field, an unknown scope and another content type change nothing", async () => {
    const before = snapshot();
    const token = await tokenFor();
    expect((await post("", token, "scope=all")).status).toBe(400);
    expect((await post("", token, "List-Unsubscribe=Yes")).status).toBe(400);
    expect((await post("", token, `${ONE_CLICK}&scope=everything`)).status).toBe(400);
    expect(
      (
        await call("", "POST", token, {
          body: JSON.stringify({ "List-Unsubscribe": "One-Click" }),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(415);
    expect((await post("", token, `${ONE_CLICK}&pad=${"x".repeat(5000)}`)).status).toBe(413);
    expect(snapshot()).toBe(before);
  });

  test("a POST can only turn a category off: nothing in a body turns one on", async () => {
    db.query("UPDATE users SET email_preferences = ? WHERE id = ?").run('{"rfcs":false}', userId);
    await post("", await tokenFor(), `${ONE_CLICK}&rfcs=true&on=true&news=true`);
    expect(prefsOf(userId)).toEqual({ rfcs: false, news: false });
  });
});

describe("every invalid link is one uniform 410 that changes nothing", () => {
  async function refusals(): Promise<Record<string, string>> {
    const good = await tokenFor();
    const [v, user, category, broadcast, sig] = good.split(".") as string[];
    const flipped = `${sig?.slice(0, -1)}${sig?.endsWith("A") ? "B" : "A"}`;
    // A recall token with a VALID signature and a recall broadcast row: the strongest recall case.
    const recallSig = await (async () => {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const mac = await crypto.subtle.sign(
        "HMAC",
        key,
        enc.encode(`mail-unsubscribe\nv1\n${userId}\nrecall\n${recallBroadcast}\n${EMAIL}`),
      );
      return Buffer.from(new Uint8Array(mac)).toString("base64url");
    })();
    return {
      tampered_signature: `${v}.${user}.${category}.${broadcast}.${flipped}`,
      other_category: `${v}.${user}.rfcs.${broadcast}.${sig}`,
      other_account: `${v}.${otherId}.${category}.${broadcast}.${sig}`,
      other_broadcast: `${v}.${user}.${category}.${rfcsBroadcast}.${sig}`,
      missing_broadcast: await tokenFor({ broadcastId: 99999 }),
      broadcast_of_another_category: await tokenFor({ broadcastId: rfcsBroadcast }),
      unknown_account: await tokenFor({ userId: 99999 }),
      recall: `v1.${userId}.recall.${recallBroadcast}.${recallSig}`,
      wrong_secret: await tokenFor({}, EMAIL, OTHER),
      rotated_secret: await tokenFor({}, EMAIL, OLD_SECRET),
      malformed: "not-a-token",
    };
  }

  for (const mount of MOUNTS) {
    test(`at ${mount || "/"}: info and POST alike, and GET for a token that does not parse`, async () => {
      const before = snapshot();
      const bodies = new Set<string>();
      for (const [name, token] of Object.entries(await refusals())) {
        // The GET forwards any token that parses (the website page reads /info); only a token that
        // does not parse is refused there, with this same body.
        const get = await call(mount, "GET", token);
        if (name === "malformed" || name === "recall") {
          expect(get.status, name).toBe(410);
          expect(get.headers.get("location"), name).toBeNull();
          bodies.add(await get.text());
        } else {
          expect(get.status, name).toBe(303);
        }
        for (const res of [
          await call(mount, "GET", token, { suffix: "/info" }),
          await post(mount, token),
          await post(mount, token, `${ONE_CLICK}&scope=all`),
        ]) {
          expect(res.status, name).toBe(410);
          expect(res.headers.get("location"), name).toBeNull();
          bodies.add(await res.text());
        }
      }
      // One body, whichever part failed, so the route says nothing about which.
      expect([...bodies]).toEqual([
        JSON.stringify({ error: "link_invalid", message: "This unsubscribe link is not valid." }),
      ]);
      expect(snapshot()).toBe(before);
    });
  }

  test("the page for a dead link is a sentence, not the JSON", async () => {
    const res = await call("", "GET", "not-a-token", { headers: { accept: "text/html" } });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("This unsubscribe link is not valid.");
  });

  test("a recall is never turned off, and no recall key is ever stored", async () => {
    const refused = (await refusals()).recall as string;
    expect((await post("", refused)).status).toBe(410);
    expect((await post("", refused, `${ONE_CLICK}&scope=all`)).status).toBe(410);
    expect(stored(userId)).toBeNull();
    // And the page's own all-categories button writes the three community keys, never `recall`.
    await post("", await tokenFor(), `${ONE_CLICK}&scope=all`);
    expect(Object.keys(prefsOf(userId)).sort()).toEqual(["maintenance", "news", "rfcs"]);
  });

  test("the rotated secret works while MAIL_LINK_SECRET_PREVIOUS holds it, and stops when it is removed", async () => {
    const old = await tokenFor({}, EMAIL, OLD_SECRET);
    const rotated = env({ MAIL_LINK_SECRET: SECRET, MAIL_LINK_SECRET_PREVIOUS: OLD_SECRET });
    const res = await call("", "POST", old, { body: ONE_CLICK, headers: FORM, env: rotated });
    expect(res.status).toBe(200);
    expect(prefsOf(userId)).toEqual({ news: false });
    db.query("UPDATE users SET email_preferences = NULL WHERE id = ?").run(userId);
    expect((await post("", old)).status).toBe(410);
    expect(stored(userId)).toBeNull();
  });

  test("a changed address ends the link, by the account's current address", async () => {
    const token = await tokenFor();
    db.query("UPDATE users SET email = ? WHERE id = ?").run("moved@links.test", userId);
    expect((await post("", token)).status).toBe(410);
    expect((await call("", "GET", token, { suffix: "/info" })).status).toBe(410);
    expect(stored(userId)).toBeNull();
    // A link minted for the new address works.
    expect((await post("", await tokenFor({}, "moved@links.test"))).status).toBe(200);
  });

  test("a deleted account: the tombstone ends the link", async () => {
    const token = await tokenFor();
    const result = await tombstoneUserCascade(realD1(db), userId, EMAIL);
    expect(result.tombstoned).toBe(true);
    expect((await post("", token)).status).toBe(410);
    expect((await call("", "GET", token, { suffix: "/info" })).status).toBe(410);
    expect(audits().filter((a) => a.action === "mail_category_changed")).toHaveLength(0);
  });

  test("a deleted account is refused by the deletion mark itself, not only by its masked address", async () => {
    const token = await tokenFor();
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(userId);
    expect((await post("", token)).status).toBe(410);
    expect((await call("", "GET", token, { suffix: "/info" })).status).toBe(410);
    expect(stored(userId)).toBeNull();
  });

  test("an account deleted between the read and the write answers the same refusal", async () => {
    const token = await tokenFor();
    const racing = {
      ...realD1(db),
      prepare(sql: string) {
        if (sql.startsWith("INSERT INTO audit_log")) {
          db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(userId);
        }
        return realD1(db).prepare(sql);
      },
      batch: realD1(db).batch.bind(realD1(db)),
    } as unknown as D1Database;
    const res = await call("", "POST", token, {
      body: ONE_CLICK,
      headers: FORM,
      env: env({ DB: racing }),
    });
    expect(res.status).toBe(410);
    expect(stored(userId)).toBeNull();
  });
});

describe("the secret", () => {
  test("unset or too short: info and POST answer 503 and write nothing; the GET still redirects", async () => {
    const token = await tokenFor();
    for (const bindings of [
      env({ MAIL_LINK_SECRET: undefined }),
      env({ MAIL_LINK_SECRET: "short" }),
      env({ MAIL_LINK_SECRET: undefined, MAIL_LINK_SECRET_PREVIOUS: SECRET }),
    ]) {
      const before = snapshot();
      expect((await call("", "GET", token, { env: bindings })).status).toBe(303);
      for (const res of [
        await call("", "GET", token, { suffix: "/info", env: bindings }),
        await call("", "POST", token, { body: ONE_CLICK, headers: FORM, env: bindings }),
        await call("/nemar", "POST", "garbage", { body: ONE_CLICK, headers: FORM, env: bindings }),
      ]) {
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: string }).error).toBe("mail_links_unconfigured");
      }
      expect(snapshot()).toBe(before);
    }
  });
});

describe("logs", () => {
  test("neither the token nor the address is logged by a GET, a POST or a refusal", async () => {
    const token = await tokenFor();
    const bad = `${token.slice(0, -2)}xx`;
    const lines = await logged(async () => {
      await call("", "GET", token);
      await call("/nemar", "GET", token, { suffix: "/info" });
      await post("", token);
      await post("/nemar", bad);
    });
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join("\n");
    expect(text).toContain("/mail/unsubscribe/");
    expect(text).not.toContain(token);
    expect(text).not.toContain(bad);
    expect(text).not.toContain(token.split(".").at(-1) as string);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("links.test");
  });
});

describe("maintenance mode never blocks an opt-out", () => {
  const modes = ["read-only", "full"] as const;

  for (const mode of modes) {
    for (const mount of MOUNTS) {
      test(`${mode} at ${mount || "/"}: the redirect, /info and the one-click POST all work, and the POST writes`, async () => {
        const bindings = env({ MAINTENANCE_MODE: mode });
        const token = await tokenFor();
        // Control: maintenance really is on, so a route outside the allowance is refused.
        const control = await worker.fetch(
          new Request(`https://api.nemar.org${mount}/datasets`, { method: "POST" }),
          bindings,
          ctx,
        );
        expect(control.status).toBe(503);

        expect((await call(mount, "GET", token, { env: bindings })).status).toBe(303);
        expect((await call(mount, "GET", token, { suffix: "/info", env: bindings })).status).toBe(
          200,
        );
        expect(stored(userId)).toBeNull();
        const res = await call(mount, "POST", token, {
          body: ONE_CLICK,
          headers: FORM,
          env: bindings,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("location")).toBeNull();
        expect(prefsOf(userId)).toEqual({ news: false });
        expect(audits().map((a) => JSON.parse(a.details).via)).toEqual(["one_click"]);
      });

      test(`${mode} at ${mount || "/"}: only those exact shapes are open`, async () => {
        const bindings = env({ MAINTENANCE_MODE: mode });
        const token = await tokenFor();
        const before = snapshot();
        const refused: Array<[string, string]> = [
          ["POST", `${mount}/mail/unsubscribe/${token}/info`],
          ["PUT", `${mount}/mail/unsubscribe/${token}`],
          ["DELETE", `${mount}/mail/unsubscribe/${token}`],
          ["POST", `${mount}/mail/unsubscribe/${token}/extra`],
          ["POST", `${mount}/mail/unsubscribe/`],
          ["POST", `${mount}/mail/unsubscribex/${token}`],
          ["POST", `/x${mount}/mail/unsubscribe/${token}`],
          // Spellings that are not the exact shape: a trailing slash, an empty segment before or
          // inside the prefix, and another case.
          ["POST", `${mount}/mail/unsubscribe/${token}/`],
          ["POST", `/${mount}/mail/unsubscribe/${token}`],
          ["POST", `${mount}//mail/unsubscribe/${token}`],
          ["POST", `${mount}/MAIL/unsubscribe/${token}`],
          ["POST", `${mount}/mail/UNSUBSCRIBE/${token}`],
        ];
        // The doubled prefix is a different path only where there is a prefix to double.
        if (mount) refused.push(["POST", `${mount}${mount}/mail/unsubscribe/${token}`]);
        for (const [method, path] of refused) {
          const res = await worker.fetch(
            new Request(`https://api.nemar.org${path}`, {
              method,
              body: method === "POST" || method === "PUT" ? ONE_CLICK : undefined,
              headers: FORM,
            }),
            bindings,
            ctx,
          );
          // `read-only` lets a GET through, but none of these is a GET; the middleware answers 503.
          expect(res.status, `${method} ${path}`).toBe(503);
          expect(((await res.json()) as { error: string }).error).toBe("Service Unavailable");
        }
        expect(snapshot()).toBe(before);
      });
    }

    test(`${mode}: an encoded slash inside the token stays ONE segment, which is not a valid token: the middleware passes it, the route answers 410, nothing is written`, async () => {
      // The middleware reads the path as sent, so `%2F` does not split the segment and the exact shape
      // still holds; the router decodes it into a token that cannot parse. An opt-out is never blocked
      // and this one never writes.
      const bindings = env({ MAINTENANCE_MODE: mode });
      const token = await tokenFor();
      const before = snapshot();
      for (const mount of MOUNTS) {
        const res = await worker.fetch(
          new Request(
            `https://api.nemar.org${mount}/mail/unsubscribe/${token.slice(0, 10)}%2F${token.slice(10)}`,
            { method: "POST", body: ONE_CLICK, headers: FORM },
          ),
          bindings,
          ctx,
        );
        expect(res.status).toBe(410);
        expect(((await res.json()) as { error: string }).error).toBe("link_invalid");
      }
      expect(snapshot()).toBe(before);
    });
  }
});

describe("the POST body is checked before the database or the HMAC", () => {
  /** A D1 that records every statement prepared, passing each through unchanged. */
  function recordingEnv() {
    const inner = realD1(db);
    const statements: string[] = [];
    const recording = {
      prepare(sql: string) {
        statements.push(sql);
        return inner.prepare(sql);
      },
      batch: inner.batch.bind(inner),
    } as unknown as D1Database;
    return { bindings: env({ DB: recording }), statements };
  }

  /** A request body that arrives in chunks, with no Content-Length, the way a chunked client sends it. */
  function chunked(parts: string[], type = FORM["content-type"]) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    return { body: stream, headers: { "content-type": type } };
  }

  async function postChunked(
    mount: string,
    token: string,
    parts: string[],
    bindings: Bindings,
    type?: string,
  ) {
    const { body, headers } = chunked(parts, type);
    return worker.fetch(
      new Request(`https://api.nemar.org${mount}/mail/unsubscribe/${token}`, {
        method: "POST",
        body,
        headers,
        // biome-ignore lint/suspicious/noExplicitAny: Bun's Request takes `duplex` for a stream body
        ...({ duplex: "half" } as any),
      }),
      bindings,
      ctx,
    );
  }

  for (const mount of MOUNTS) {
    test(`at ${mount || "/"}: an oversized chunked body (no Content-Length) is 413, no D1 read, no write`, async () => {
      const { bindings, statements } = recordingEnv();
      const token = await tokenFor();
      const before = snapshot();
      const chunk = "x".repeat(1024);
      const res = await postChunked(
        mount,
        token,
        [`${ONE_CLICK}&pad=`, chunk, chunk, chunk, chunk, chunk],
        bindings,
      );
      expect(res.status).toBe(413);
      expect(statements).toEqual([]);
      expect(snapshot()).toBe(before);
    });
  }

  test("an oversized multipart body, chunked, is 413 too", async () => {
    const { bindings, statements } = recordingEnv();
    const boundary = "----b0und";
    const part = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const res = await postChunked(
      "",
      await tokenFor(),
      [part("List-Unsubscribe", "One-Click"), part("pad", "y".repeat(6000)), `--${boundary}--\r\n`],
      bindings,
      `multipart/form-data; boundary=${boundary}`,
    );
    expect(res.status).toBe(413);
    expect(statements).toEqual([]);
    expect(stored(userId)).toBeNull();
  });

  test("a Content-Length that understates the body does not get it past the cap", async () => {
    const { bindings, statements } = recordingEnv();
    const { body, headers } = chunked([`${ONE_CLICK}&pad=`, "z".repeat(5000)]);
    const res = await worker.fetch(
      new Request(`https://api.nemar.org/mail/unsubscribe/${await tokenFor()}`, {
        method: "POST",
        body,
        headers: { ...headers, "content-length": "27" },
        // biome-ignore lint/suspicious/noExplicitAny: Bun's Request takes `duplex` for a stream body
        ...({ duplex: "half" } as any),
      }),
      bindings,
      ctx,
    );
    expect(res.status).toBe(413);
    expect(statements).toEqual([]);
    expect(stored(userId)).toBeNull();
  });

  test("a body within the cap, sent in chunks, still works", async () => {
    const { bindings } = recordingEnv();
    const res = await postChunked(
      "",
      await tokenFor(),
      ["List-Unsub", "scribe=One-", "Click"],
      bindings,
    );
    expect(res.status).toBe(200);
    expect(prefsOf(userId)).toEqual({ news: false });
  });

  test("an unsupported content type or a missing one-click field is refused before any D1 read", async () => {
    const { bindings, statements } = recordingEnv();
    const token = await tokenFor();
    const wrongType = await call("", "POST", token, {
      body: "{}",
      headers: { "content-type": "application/json" },
      env: bindings,
    });
    expect(wrongType.status).toBe(415);
    const noField = await call("", "POST", token, {
      body: "scope=all",
      headers: FORM,
      env: bindings,
    });
    expect(noField.status).toBe(400);
    expect(statements).toEqual([]);
    expect(stored(userId)).toBeNull();
  });
});

describe("a misconfigured secret is said aloud, once, without the value", () => {
  const LEAKY_SHORT = "short-secret-VALUE-1234";

  test("unset or short MAIL_LINK_SECRET: one error line per window, naming the binding and no value", async () => {
    const token = await tokenFor();
    const lines = await logged(async () => {
      await call("", "GET", token, { suffix: "/info", env: env({ MAIL_LINK_SECRET: undefined }) });
      await call("", "POST", token, {
        body: ONE_CLICK,
        headers: FORM,
        env: env({ MAIL_LINK_SECRET: LEAKY_SHORT }),
      });
      await call("/nemar", "GET", token, {
        suffix: "/info",
        env: env({ MAIL_LINK_SECRET: undefined }),
      });
    });
    const ours = lines.filter((l) => l.includes("[mail-links]"));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toContain("MAIL_LINK_SECRET is unset or shorter than 32 characters");
    expect(lines.join("\n")).not.toContain(LEAKY_SHORT);
  });

  test("a configured secret says nothing", async () => {
    const lines = await logged(async () => {
      await call("", "GET", await tokenFor(), { suffix: "/info" });
    });
    expect(lines.filter((l) => l.includes("[mail-links]"))).toEqual([]);
  });

  test("MAIL_LINK_SECRET_PREVIOUS set but too short: reported, and ignored, without its value", async () => {
    const token = await tokenFor({}, EMAIL, OLD_SECRET);
    const bindings = env({ MAIL_LINK_SECRET_PREVIOUS: LEAKY_SHORT });
    let status = 0;
    const lines = await logged(async () => {
      status = (await call("", "GET", token, { suffix: "/info", env: bindings })).status;
      await call("", "GET", token, { suffix: "/info", env: bindings });
    });
    expect(status).toBe(410);
    const ours = lines.filter((l) => l.includes("[mail-links]"));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toContain("MAIL_LINK_SECRET_PREVIOUS is set but shorter than 32 characters");
    expect(lines.join("\n")).not.toContain(LEAKY_SHORT);
  });

  test("an unset previous secret is not a problem", async () => {
    const lines = await logged(async () => {
      await call("", "GET", await tokenFor(), {
        suffix: "/info",
        env: env({ MAIL_LINK_SECRET_PREVIOUS: "" }),
      });
    });
    expect(lines.filter((l) => l.includes("[mail-links]"))).toEqual([]);
  });
});
