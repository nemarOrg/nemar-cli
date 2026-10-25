/**
 * The support-ticket admin routes (epic #1893 phase 3b, ADR 0112), through the REAL admin router
 * and its auth middleware, against a real migrated database (bun:sqlite behind realD1), real R2
 * (Miniflare) for reprocessing, and the recording `send_email` binding at the send boundary. Tokens
 * are real API keys. No mocks of business logic.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { adminRoutes } from "../src/routes/admin";
import { handleInboundEmail } from "../src/services/inbound-mail";
import { buildReferences } from "../src/services/mail-admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { bindingError, headerRefusal, recordingBinding } from "./helpers/cloudflare-email";
import { freshDb, realD1, wrapD1, yieldingD1 } from "./helpers/d1";
import { withFakeResend } from "./helpers/resend";
import { eml } from "./helpers/tickets";

const KEYS = {
  owner: "mail-owner-key-0123456789abcdef0123456789abcdef",
  owner2: "mail-owner2-key-0123456789abcdef0123456789abcdef",
  admin: "mail-admin-key-0123456789abcdef0123456789abcdef",
  agent: "mail-agent-key-0123456789abcdef0123456789abcdef",
  member: "mail-member-key-0123456789abcdef0123456789abcdef",
};
type Who = keyof typeof KEYS;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ids: Record<Who, number>;
let binding: ReturnType<typeof recordingBinding>;
let envOverrides: Partial<Bindings> = {};
let bucket: R2Bucket;
let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default {}", r2Buckets: ["MAIL_INBOUND"] });
  bucket = (await mf.getR2Bucket("MAIL_INBOUND")) as unknown as R2Bucket;
});
afterAll(async () => {
  await mf?.dispose();
}, 30_000);

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    FROM_EMAIL: "NEMAR Archive <noreply@nemar.org>",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: binding.binding,
    RESEND_API_KEY: "resend-key",
    MAIL_INBOUND: bucket,
    ...envOverrides,
  } as Bindings;
}

async function seed(
  who: Who,
  role: "owner" | "admin" | "member",
  kind: "person" | "service" = "person",
) {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, signup_source,
                        email_verified, service_access, account_kind)
     VALUES (?, ?, 'x', ?, ?, ?, 'cli', 1, 0, ?)`,
    [
      `mail-${who}`,
      `mail-${who}@example.org`,
      `mail-${who}-gh`,
      role === "member" ? "verified" : "approved",
      role,
      kind,
    ],
  );
  const row = db.query("SELECT id FROM users WHERE username = ?").get(`mail-${who}`) as {
    id: number;
  };
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(KEYS[who]),
    KEYS[who].slice(0, 8),
  );
  return row.id;
}

beforeEach(async () => {
  db = freshDb();
  binding = recordingBinding();
  envOverrides = {};
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  ids = {
    owner: await seed("owner", "owner"),
    owner2: await seed("owner2", "owner"),
    admin: await seed("admin", "admin"),
    // An agent holds an admin account; nothing below treats it differently from a person's.
    agent: await seed("agent", "admin", "service"),
    member: await seed("member", "member"),
  };
});

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await app.request(
    `/admin/mail${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${KEYS[who]}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

let seq = 0;
function ticket(
  o: {
    queue?: string;
    restricted?: boolean;
    excluded?: number | null;
    status?: string;
    assignee?: number | null;
    subject?: string;
    requester?: string;
    lastAt?: string;
  } = {},
): number {
  seq += 1;
  db.run(
    `INSERT INTO mail_tickets (ref, queue_tag, restricted, excluded_user_id, status, assignee_user_id,
        requester_email, subject, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `aaaaaaaa${String.fromCharCode(97 + (Math.floor(seq / 26) % 26))}${String.fromCharCode(97 + (seq % 26))}`,
      o.queue ?? "support",
      o.restricted ? 1 : 0,
      o.excluded ?? null,
      o.status ?? "open",
      o.assignee ?? null,
      o.requester ?? "ada@sender.example",
      o.subject ?? "Help with an upload",
      o.lastAt ?? "2026-10-24 10:00:00",
    ],
  );
  const id = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  return id;
}
function inbound(ticketId: number, messageId: string, references?: string) {
  db.run(
    `INSERT INTO mail_messages (ticket_id, direction, message_id, references_ids, from_addr, to_addr,
        subject, text_body)
     VALUES (?, 'in', ?, ?, 'ada@sender.example', 'support@nemar.org', 's', 'hello')`,
    [ticketId, messageId, references ?? null],
  );
}
const events = (id: number) =>
  db
    .query<{ kind: string; actor_user_id: number | null; detail: string | null }, [number]>(
      "SELECT kind, actor_user_id, detail FROM mail_ticket_events WHERE ticket_id = ? ORDER BY id",
    )
    .all(id);
const row = (id: number) =>
  db
    .query<Record<string, any>, [number]>("SELECT * FROM mail_tickets WHERE id = ?")
    .get(id) as Record<string, any>;

describe("visibility on every route", () => {
  test("a restricted ticket is a 404 for an admin and an agent admin, on every read and write", async () => {
    const t = ticket({ queue: "security", restricted: true });
    const probes: [string, string, unknown?][] = [
      ["GET", `/tickets/${t}`],
      ["POST", `/tickets/${t}/reply`, { text: "hi" }],
      ["POST", `/tickets/${t}/note`, { text: "n" }],
      ["POST", `/tickets/${t}/assign`, { user_id: ids.owner }],
      ["POST", `/tickets/${t}/status`, { status: "closed" }],
      ["POST", `/tickets/${t}/escalate`, {}],
    ];
    for (const who of ["admin", "agent"] as const) {
      for (const [method, path, body] of probes) {
        const r = await call(who, method, path, body);
        expect([method, path, r.status]).toEqual([method, path, 404]);
        expect(r.body.code).toBe("not_found");
      }
    }
    expect(binding.sent.length).toBe(0);
    expect(events(t)).toEqual([]);
    expect(row(t).status).toBe("open");
    const owner = await call("owner", "GET", `/tickets/${t}`);
    expect(owner.status).toBe(200);
  });

  test("the excluded owner gets 404 for their own exclusion; the other owner does not", async () => {
    const t = ticket({ queue: "conduct", restricted: true, excluded: ids.owner2 });
    for (const [method, path, body] of [
      ["GET", `/tickets/${t}`],
      ["POST", `/tickets/${t}/note`, { text: "n" }],
      ["POST", `/tickets/${t}/status`, { status: "closed" }],
    ] as [string, string, unknown?][]) {
      expect((await call("owner2", method, path, body)).status).toBe(404);
    }
    expect((await call("owner", "POST", `/tickets/${t}/note`, { text: "n" })).status).toBe(200);
    // An excluded account is hidden from an ORDINARY ticket too.
    const ordinary = ticket({ excluded: ids.admin });
    expect((await call("admin", "GET", `/tickets/${ordinary}`)).status).toBe(404);
  });

  test("a member is refused by the admin gate, and an unknown or malformed id is a 404", async () => {
    const t = ticket();
    expect((await call("member", "GET", `/tickets/${t}`)).status).toBe(403);
    expect((await call("member", "GET", "/tickets")).status).toBe(403);
    expect((await call("admin", "GET", "/tickets/99999")).status).toBe(404);
    expect((await call("admin", "GET", "/tickets/abc")).status).toBe(404);
  });

  test("the list leaves out what the caller may not see", async () => {
    const ordinary = ticket({ subject: "ordinary" });
    const restricted = ticket({ queue: "security", restricted: true, subject: "secret" });
    const excluded = ticket({ queue: "conduct", restricted: true, excluded: ids.owner2 });
    const idsOf = async (who: Who) =>
      ((await call(who, "GET", "/tickets")).body.tickets as { id: number }[])
        .map((x) => x.id)
        .sort();
    expect(await idsOf("admin")).toEqual([ordinary]);
    expect(await idsOf("owner")).toEqual([ordinary, restricted, excluded].sort());
    expect(await idsOf("owner2")).toEqual([ordinary, restricted].sort());
  });

  test("the detail carries messages and events and never the raw key or exclusion", async () => {
    const t = ticket({ excluded: ids.admin });
    inbound(t, "<a@x>");
    db.run("UPDATE mail_messages SET raw_key = 'inbound/raw/secret.eml' WHERE ticket_id = ?", [t]);
    const r = await call("owner", "GET", `/tickets/${t}`);
    expect(r.status).toBe(200);
    expect(r.body.messages[0].text_body).toBe("hello");
    expect(JSON.stringify(r.body)).not.toContain("raw_key");
    expect(JSON.stringify(r.body)).not.toContain("secret.eml");
    expect(JSON.stringify(r.body)).not.toContain("excluded");
  });
});

describe("list filters and paging", () => {
  test("default hides spam and closed; a status filter shows them", async () => {
    ticket({ status: "open" });
    ticket({ status: "spam" });
    ticket({ status: "closed" });
    ticket({ status: "pending" });
    const def = (await call("admin", "GET", "/tickets")).body.tickets as { status: string }[];
    expect(def.map((x) => x.status).sort()).toEqual(["open", "pending"]);
    const spam = (await call("admin", "GET", "/tickets?status=spam")).body.tickets;
    expect(spam.length).toBe(1);
    expect((await call("admin", "GET", "/tickets?status=nope")).status).toBe(400);
  });

  test("queue, assignee and q filters", async () => {
    const a = ticket({ queue: "support", assignee: ids.admin, subject: "100% sure_thing" });
    const b = ticket({ queue: "billing", requester: "pat@billing.example", subject: "Invoice" });
    const c = ticket({ queue: "support", assignee: ids.agent, subject: "Other" });
    const list = async (qs: string) =>
      ((await call("admin", "GET", `/tickets?${qs}`)).body.tickets as { id: number }[]).map(
        (x) => x.id,
      );
    expect(await list("queue=billing")).toEqual([b]);
    expect(await list("assignee=me")).toEqual([a]);
    expect(await list(`assignee=${ids.agent}`)).toEqual([c]);
    expect((await list("assignee=none")).sort()).toEqual([b]);
    expect(await list("q=pat%40billing")).toEqual([b]);
    // LIKE wildcards in the search are literal.
    expect(await list(`q=${encodeURIComponent("100%")}`)).toEqual([a]);
    expect(await list(`q=${encodeURIComponent("u_e")}`)).toEqual([]);
    expect((await call("admin", "GET", "/tickets?assignee=x")).status).toBe(400);
  });

  test("keyset paging by last_message_at then id, newest first, without gaps or repeats", async () => {
    const made = [
      ticket({ lastAt: "2026-10-24 10:00:00" }),
      ticket({ lastAt: "2026-10-24 12:00:00" }),
      ticket({ lastAt: "2026-10-24 12:00:00" }),
      ticket({ lastAt: "2026-10-24 09:00:00" }),
      ticket({ lastAt: "2026-10-24 11:00:00" }),
    ];
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r: { body: Record<string, any> } = await call(
        "admin",
        "GET",
        `/tickets?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...(r.body.tickets as { id: number }[]).map((x) => x.id));
      cursor = r.body.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([made[2], made[1], made[4], made[0], made[3]]);
    expect((await call("admin", "GET", "/tickets?cursor=garbage")).status).toBe(400);
  });
});

describe("reply", () => {
  test("sends from support@ with threading headers, then stores the message and the actor", async () => {
    const t = ticket({ subject: "Help with an upload" });
    inbound(t, "<first@sender.example>");
    inbound(t, "<second@sender.example>", "<first@sender.example>");
    const r = await call("agent", "POST", `/tickets/${t}/reply`, {
      text: "Hello\n\nLine <b>two</b>",
    });
    expect(r.status).toBe(200);
    expect(binding.sent.length).toBe(1);
    const sent = binding.sent[0];
    const ref = row(t).ref as string;
    expect(sent.from).toEqual({ email: "support@nemar.org", name: "NEMAR Support" });
    expect(sent.replyTo).toBe(`support+t${ref}@nemar.org`); // a legacy ten-character ref
    expect(sent.to).toBe("ada@sender.example");
    expect(sent.subject).toBe("Re: Help with an upload");
    expect(sent.headers?.["In-Reply-To"]).toBe("<second@sender.example>");
    expect(sent.headers?.References).toBe("<first@sender.example> <second@sender.example>");
    // The platform controls Message-ID: the reply never sets it, and every header it does set
    // passes the Cloudflare allowlist (the recorder refuses the send otherwise).
    expect(Object.keys(sent.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("message-id");
    expect(headerRefusal(sent.headers)).toBeUndefined();
    expect(sent.html).toContain("&lt;b&gt;two&lt;/b&gt;");
    expect(sent.html).not.toContain("<b>two");

    const out = db
      .query("SELECT * FROM mail_messages WHERE ticket_id = ? AND direction = 'out'")
      .get(t) as Record<string, any>;
    expect(out.author_user_id).toBe(ids.agent);
    expect(out.message_id).toBe("<1.recorded@staging.nemar.test>");
    expect(r.body.header_message_id).toBe("<1.recorded@staging.nemar.test>");
    expect(out.from_addr).toBe("support@nemar.org");
    expect(row(t).status).toBe("pending");
    expect(events(t).map((e) => [e.kind, e.actor_user_id])).toEqual([
      ["reply", ids.agent],
      ["status", ids.agent],
    ]);

    // The requester's answer to that reply threads by In-Reply-To onto the same ticket.
    const next = await call("admin", "POST", `/tickets/${t}/reply`, { text: "again" });
    expect(next.status).toBe(200);
    expect(binding.sent[1].headers?.References).toBe(
      "<first@sender.example> <second@sender.example> <1.recorded@staging.nemar.test>",
    );
  });

  test("a word-ref ticket replies to support+t-<ref>@, which threads the answer back", async () => {
    const t = ticket();
    db.run("UPDATE mail_tickets SET ref = 'amber-falcon-river' WHERE id = ?", [t]);
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.status).toBe(200);
    expect(binding.sent[0].replyTo).toBe("support+t-amber-falcon-river@nemar.org");
  });

  test("a provider id that is not a Message-ID is stored as NULL, and the plus-tag still threads", async () => {
    envOverrides = { EMAIL: { send: async () => ({ messageId: "0192-opaque-provider-id" }) } };
    const t = ticket();
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.status).toBe(200);
    expect(r.body.header_message_id).toBeNull();
    const out = db
      .query("SELECT message_id FROM mail_messages WHERE ticket_id = ? AND direction = 'out'")
      .get(t) as { message_id: string | null };
    expect(out.message_id).toBeNull();
    expect(r.body.message_id).toBeGreaterThan(0);
  });

  test("a bare provider id is stored in angle brackets", async () => {
    const bare = { send: async () => ({ messageId: "bare.id@mail.example" }) };
    envOverrides = { EMAIL: bare };
    const t = ticket();
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.body.header_message_id).toBe("<bare.id@mail.example>");
    const out = db
      .query("SELECT message_id FROM mail_messages WHERE ticket_id = ? AND direction = 'out'")
      .get(t) as { message_id: string };
    expect(out.message_id).toBe("<bare.id@mail.example>");
  });

  test("staging derives its domain from FROM_EMAIL and wraps the subject", async () => {
    envOverrides = {
      ENVIRONMENT: "development",
      FROM_EMAIL: "NEMAR Staging <noreply@test.nemar.org>",
      DEV_EMAIL_ALLOWLIST: "ada@sender.example",
    };
    const t = ticket();
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.status).toBe(200);
    expect(binding.sent[0].from).toEqual({
      email: "support@test.nemar.org",
      name: "NEMAR Support",
    });
    expect(binding.sent[0].replyTo).toContain("@test.nemar.org");
    expect(binding.sent[0].subject).toBe("[DEV] Re: Help with an upload");
  });

  test("the dev fence refuses a recipient off the allowlist, and nothing is stored", async () => {
    envOverrides = { ENVIRONMENT: "development", DEV_EMAIL_ALLOWLIST: "someone@else.example" };
    const t = ticket();
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("reply_not_sent");
    expect(JSON.stringify(r.body)).not.toContain("ada@sender");
    expect(binding.sent.length).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM mail_messages").get()).toEqual({ n: 0 });
    expect(events(t)).toEqual([]);
    expect(row(t).status).toBe("open");
  });

  test("a certain non-delivery is a typed error and stores nothing", async () => {
    binding = recordingBinding(() => bindingError("E_RECIPIENT_SUPPRESSED", "suppressed"));
    const t = ticket();
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("reply_not_sent");
    expect(db.query("SELECT COUNT(*) AS n FROM mail_messages").get()).toEqual({ n: 0 });
    expect(events(t)).toEqual([]);
  });

  test("an ambiguous failure records an event with the Message-ID and tells the admin not to resend", async () => {
    binding = recordingBinding(() => bindingError("E_INTERNAL_SERVER_ERROR", "boom"));
    const t = ticket();
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("reply_delivery_unknown");
    expect(db.query("SELECT COUNT(*) AS n FROM mail_messages").get()).toEqual({ n: 0 });
    const [event] = events(t);
    expect(event.kind).toBe("reply_failed");
    expect(event.actor_user_id).toBe(ids.admin);
    const detail = JSON.parse(event.detail ?? "{}");
    expect(detail.delivery).toBe("unknown");
    expect(detail.header_message_id).toBeNull();
    expect(row(t).status).toBe("open");
  });

  test("Resend sends the reply with no Message-ID header when it is the provider", async () => {
    envOverrides = { EMAIL_PROVIDER: "resend", EMAIL: undefined };
    const t = ticket();
    await withFakeResend(async (calls) => {
      const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
      expect(r.status).toBe(200);
      const body = calls[0].body as { headers?: Record<string, string>; reply_to: string };
      // A ticket with no inbound Message-ID has nothing to thread by, and no Message-ID is set.
      expect(body.headers).toBeUndefined();
      expect(body.reply_to).toStartWith("support+t");
    });
  });

  test("control characters in a stored subject never reach a header, and Re: is not doubled", async () => {
    const t = ticket({ subject: "Re: Help\r\nBcc: evil@example.org" });
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.status).toBe(200);
    expect(binding.sent[0].subject).toBe("Re: Help Bcc: evil@example.org");
    expect(binding.sent[0].subject).not.toMatch(/[\r\n]/);
  });

  test("spam cannot be replied to; empty and unknown fields are refused", async () => {
    const spam = ticket({ status: "spam" });
    expect((await call("admin", "POST", `/tickets/${spam}/reply`, { text: "hi" })).body.code).toBe(
      "ticket_is_spam",
    );
    const t = ticket();
    expect((await call("admin", "POST", `/tickets/${t}/reply`, { text: "  " })).status).toBe(400);
    expect(
      (await call("admin", "POST", `/tickets/${t}/reply`, { text: "x", to: "a@b.c" })).status,
    ).toBe(400);
    expect(binding.sent.length).toBe(0);
  });
});

describe("long threads", () => {
  test("References keeps the thread root, the newest ids and In-Reply-To, and fits", async () => {
    const t = ticket();
    for (let i = 0; i < 90; i++) {
      inbound(t, `<m${String(i).padStart(2, "0")}-${"x".repeat(60)}@sender.example>`);
    }
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.status).toBe(200);
    const h = binding.sent[0].headers ?? {};
    expect((h.References ?? "").length).toBeLessThanOrEqual(998);
    const refs = (h.References ?? "").split(" ");
    expect(refs[0]).toStartWith("<m00-");
    expect(refs.at(-1)).toBe(h["In-Reply-To"]);
    const rest = refs.slice(1).map((x) => Number(x.slice(2, 4)));
    expect(rest.at(-1)).toBe(89);
    expect(rest.length).toBeGreaterThan(5);
    // After the root, a contiguous run of the newest ids.
    expect(rest).toEqual(rest.map((_, i) => 89 - (rest.length - 1 - i)));
  });

  test("buildReferences pins the id replied to even when it is not the newest", () => {
    const ids = ["<a@x>", "<b@x>", "<c@x>", "<d@x>"];
    expect(buildReferences(ids, "<b@x>", 17)).toBe("<a@x> <b@x> <d@x>");
    expect(buildReferences(ids, "<b@x>", 11)).toBe("<a@x> <b@x>");
    expect(buildReferences(ids, undefined, 17)).toBe("<a@x> <c@x> <d@x>");
    expect(buildReferences(ids, undefined, 11)).toBe("<a@x> <d@x>");
    expect(buildReferences([], undefined)).toBeUndefined();
  });

  test("a header that cannot be sent is a certain non-delivery and nothing is recorded as maybe sent", async () => {
    const t = ticket();
    inbound(t, `<${"y".repeat(997)}>`);
    const r = await call("admin", "POST", `/tickets/${t}/reply`, { text: "hi" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("reply_not_sent");
    expect(binding.sent.length).toBe(0);
    expect(events(t)).toEqual([]);
    expect(
      db.query("SELECT COUNT(*) AS n FROM mail_messages WHERE direction = 'out'").get(),
    ).toEqual({ n: 0 });
  });
});

describe("reply idempotency and recording faults", () => {
  const send = (who: Who, t: number, key?: string, text = "hi") =>
    app
      .request(
        `/admin/mail/tickets/${t}/reply`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${KEYS[who]}`,
            "Content-Type": "application/json",
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          body: JSON.stringify({ text }),
        },
        env(),
      )
      .then(async (res) => ({
        status: res.status,
        body: (await res.json()) as Record<string, any>,
      }));

  test("a repeat with the same key returns the stored outcome and sends once", async () => {
    const t = ticket();
    const first = await send("agent", t, "k-1");
    const again = await send("agent", t, "k-1", "different text is ignored");
    expect(first.status).toBe(200);
    expect(again).toEqual(first);
    expect(binding.sent.length).toBe(1);
    expect(
      db.query("SELECT COUNT(*) AS n FROM mail_messages WHERE direction = 'out'").get(),
    ).toEqual({ n: 1 });
    // The same key on another ticket is its own reply; no key means no idempotency.
    const other = ticket();
    expect((await send("agent", other, "k-1")).status).toBe(200);
    await send("agent", t);
    await send("agent", t);
    expect(binding.sent.length).toBe(4);
    expect((await send("agent", t, "bad key!")).status).toBe(400);
  });

  test("a duplicate while the first is in flight is 409 reply_in_progress, and a stale one is unknown", async () => {
    const t = ticket();
    db.run(
      "INSERT INTO mail_reply_keys (ticket_id, idem_key, state) VALUES (?, 'k-2', 'pending')",
      [t],
    );
    const busy = await send("agent", t, "k-2");
    expect([busy.status, busy.body.code]).toEqual([409, "reply_in_progress"]);
    db.run(
      "UPDATE mail_reply_keys SET created_at = datetime('now', '-10 minutes') WHERE idem_key = 'k-2'",
    );
    const stale = await send("agent", t, "k-2");
    expect([stale.status, stale.body.code]).toEqual([409, "reply_delivery_unknown"]);
    expect(binding.sent.length).toBe(0);
  });

  test("two simultaneous requests with one key send once", async () => {
    envOverrides = { DB: yieldingD1(realD1(db)) };
    const t = ticket();
    const [a, b] = await Promise.all([send("agent", t, "k-3"), send("agent", t, "k-3")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(binding.sent.length).toBe(1);
  });

  test("an unknown outcome is never re-sent on a retry; a refusal frees the key", async () => {
    binding = recordingBinding(() => bindingError("E_INTERNAL_SERVER_ERROR", "boom"));
    const t = ticket();
    expect((await send("agent", t, "k-4")).body.code).toBe("reply_delivery_unknown");
    const retry = await send("agent", t, "k-4");
    expect([retry.status, retry.body.code]).toEqual([409, "reply_delivery_unknown"]);
    expect(binding.sent.length).toBe(1);

    let refuse = true;
    binding = recordingBinding(() => (refuse ? bindingError("E_RECIPIENT_SUPPRESSED") : undefined));
    const u = ticket();
    expect((await send("agent", u, "k-5")).body.code).toBe("reply_not_sent");
    refuse = false;
    expect((await send("agent", u, "k-5")).status).toBe(200);
    expect(binding.sent.length).toBe(2);
  });

  test("if the event write fails too, the 409 and its clear text still come back", async () => {
    binding = recordingBinding(() => bindingError("E_INTERNAL_SERVER_ERROR", "boom"));
    db.run(
      "CREATE TRIGGER no_failed_events BEFORE INSERT ON mail_ticket_events WHEN NEW.kind = 'reply_failed' BEGIN SELECT RAISE(ABORT, 'disk'); END",
    );
    const t = ticket();
    const r = await send("agent", t, "k-6");
    expect([r.status, r.body.code]).toEqual([409, "reply_delivery_unknown"]);
    expect(r.body.error).toContain("may or may not have gone out");
    expect(events(t)).toEqual([]);
  });

  test("sent but not recorded writes an event naming the Message-ID and refuses a repeat", async () => {
    db.run(
      "CREATE TRIGGER no_out BEFORE INSERT ON mail_messages WHEN NEW.direction = 'out' BEGIN SELECT RAISE(ABORT, 'disk'); END",
    );
    const t = ticket();
    const r = await send("agent", t, "k-7");
    expect([r.status, r.body.code]).toEqual([409, "reply_delivery_unknown"]);
    expect(r.body.error).toContain("Do not send it again");
    expect(binding.sent.length).toBe(1);
    const [event] = events(t);
    expect(event.kind).toBe("reply_failed");
    expect(JSON.parse(event.detail ?? "{}")).toEqual({
      delivery: "sent_unrecorded",
      header_message_id: "<1.recorded@staging.nemar.test>",
    });
    expect((await send("agent", t, "k-7")).status).toBe(409);
    expect(binding.sent.length).toBe(1);
  });
});

describe("note idempotency", () => {
  const post = (who: Who, t: number, kind: "note" | "reply", key?: string, text = "n") =>
    app
      .request(
        `/admin/mail/tickets/${t}/${kind}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${KEYS[who]}`,
            "Content-Type": "application/json",
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          body: JSON.stringify({ text }),
        },
        env(),
      )
      .then(async (res) => ({
        status: res.status,
        body: (await res.json()) as Record<string, any>,
      }));
  const notes = (t: number) =>
    (
      db
        .query("SELECT COUNT(*) AS n FROM mail_messages WHERE ticket_id = ? AND direction = 'note'")
        .get(t) as { n: number }
    ).n;

  test("a repeat with the same key returns the same message id and stores one note", async () => {
    const t = ticket();
    const first = await post("agent", t, "note", "n-1", "once");
    const again = await post("agent", t, "note", "n-1", "different text is ignored");
    expect(first.status).toBe(200);
    expect(first.body.message_id).toBeGreaterThan(0);
    expect(again).toEqual(first);
    expect(notes(t)).toBe(1);
    const events = db
      .query("SELECT COUNT(*) AS n FROM mail_ticket_events WHERE ticket_id = ? AND kind = 'note'")
      .get(t) as { n: number };
    expect(events.n).toBe(1);
    // The same key on another ticket is its own note.
    const other = ticket();
    expect((await post("agent", other, "note", "n-1")).status).toBe(200);
    expect(notes(other)).toBe(1);
    expect(binding.sent.length).toBe(0);
  });

  test("different keys, and no key, store separate notes", async () => {
    const t = ticket();
    const a = await post("agent", t, "note", "n-a");
    const b = await post("agent", t, "note", "n-b");
    const c = await post("agent", t, "note");
    const d = await post("agent", t, "note");
    expect(new Set([a, b, c, d].map((r) => r.body.message_id)).size).toBe(4);
    expect(notes(t)).toBe(4);
  });

  test("a malformed key is refused and stores nothing", async () => {
    const t = ticket();
    expect((await post("agent", t, "note", "bad key!")).status).toBe(400);
    expect((await post("agent", t, "note", "x".repeat(65))).status).toBe(400);
    expect(notes(t)).toBe(0);
  });

  test("note keys and reply keys are separate namespaces", async () => {
    const t = ticket();
    const note = await post("agent", t, "note", "shared");
    const reply = await post("agent", t, "reply", "shared", "a reply");
    expect(reply.status).toBe(200);
    expect(reply.body.message_id).not.toBe(note.body.message_id);
    expect(binding.sent.length).toBe(1);
    // And the other way round: a reply key does not satisfy a note.
    await post("agent", t, "reply", "r-only");
    const n2 = await post("agent", t, "note", "r-only", "fresh note");
    expect(n2.status).toBe(200);
    expect(notes(t)).toBe(2);
    expect(binding.sent.length).toBe(2);
  });

  /** A D1 that runs `between` after the route's reads and just before its batch. */
  const withGap = (between: () => void) => {
    const inner = wrapD1(realD1(db), () => {});
    return {
      ...inner,
      prepare: inner.prepare.bind(inner),
      batch: async (stmts: unknown[]) => {
        between();
        return (inner as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(stmts);
      },
    } as unknown as D1Database;
  };

  test("a race loser replays the winner's id and neither logs nor moves the retention clock", async () => {
    const t = ticket();
    db.run("UPDATE mail_tickets SET last_activity_at = '2026-01-01 00:00:00' WHERE id = ?", [t]);
    let winnerId = 0;
    envOverrides = {
      DB: withGap(() => {
        const r = db.run(
          "INSERT INTO mail_messages (ticket_id, direction, text_body, author_user_id) VALUES (?, 'note', 'winner', ?)",
          [t, ids.agent],
        );
        winnerId = Number(r.lastInsertRowid);
        db.run(
          "INSERT INTO mail_note_keys (ticket_id, idem_key, message_id) VALUES (?, 'race', ?)",
          [t, winnerId],
        );
        db.run(
          "INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id) VALUES (?, 'note', ?)",
          [t, ids.agent],
        );
      }),
    };
    const loser = await post("agent", t, "note", "race", "loser");
    expect(loser.status).toBe(200);
    expect(loser.body.message_id).toBe(winnerId);
    expect(notes(t)).toBe(1);
    expect(
      (
        db
          .query(
            "SELECT COUNT(*) AS n FROM mail_ticket_events WHERE ticket_id = ? AND kind = 'note'",
          )
          .get(t) as { n: number }
      ).n,
    ).toBe(1);
    expect(row(t).last_activity_at).toBe("2026-01-01 00:00:00");
  });

  test("a purge landing between the pre-check and the batch gives 409 with no note and no key", async () => {
    const t = ticket();
    envOverrides = {
      DB: withGap(() => {
        db.run("UPDATE mail_tickets SET purged_at = datetime('now') WHERE id = ?", [t]);
      }),
    };
    const r = await post("agent", t, "note", "n-late", "x");
    expect(r.status).toBe(409);
    expect(notes(t)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM mail_note_keys").get()).toEqual({ n: 0 });
  });

  test("deleting a ticket row cascades its note keys", async () => {
    const t = ticket();
    await post("agent", t, "note", "n-c");
    expect(db.query("SELECT COUNT(*) AS n FROM mail_note_keys").get()).toEqual({ n: 1 });
    db.run("PRAGMA foreign_keys = ON");
    db.run("DELETE FROM mail_tickets WHERE id = ?", [t]);
    expect(db.query("SELECT COUNT(*) AS n FROM mail_note_keys").get()).toEqual({ n: 0 });
  });

  test("a purged ticket refuses a keyed note and stores no key", async () => {
    const t = ticket();
    db.run("UPDATE mail_tickets SET purged_at = datetime('now') WHERE id = ?", [t]);
    expect((await post("agent", t, "note", "n-p")).status).toBe(409);
    expect(db.query("SELECT COUNT(*) AS n FROM mail_note_keys").get()).toEqual({ n: 0 });
  });
});

describe("note, assign, status", () => {
  test("a note records the actor and sends nothing", async () => {
    const t = ticket();
    expect((await call("agent", "POST", `/tickets/${t}/note`, { text: "internal" })).status).toBe(
      200,
    );
    const note = db.query("SELECT * FROM mail_messages WHERE direction = 'note'").get() as Record<
      string,
      any
    >;
    expect([note.author_user_id, note.text_body]).toEqual([ids.agent, "internal"]);
    expect(events(t)[0]).toMatchObject({ kind: "note", actor_user_id: ids.agent });
    expect(binding.sent.length).toBe(0);
  });

  test("assign checks eligibility for that ticket, including restricted and excluded rules", async () => {
    const t = ticket();
    expect(
      (await call("admin", "POST", `/tickets/${t}/assign`, { user_id: ids.agent })).body.ticket
        .assignee_user_id,
    ).toBe(ids.agent);
    expect(
      (await call("admin", "POST", `/tickets/${t}/assign`, { user_id: ids.member })).body.code,
    ).toBe("ineligible_assignee");
    expect((await call("admin", "POST", `/tickets/${t}/assign`, { user_id: 99999 })).status).toBe(
      422,
    );
    const un = await call("admin", "POST", `/tickets/${t}/assign`, { user_id: null });
    expect(un.body.ticket.assignee_user_id).toBeNull();
    expect(events(t).map((e) => e.kind)).toEqual(["assigned", "unassigned"]);

    const restricted = ticket({ queue: "security", restricted: true, excluded: ids.owner2 });
    expect(
      (await call("owner", "POST", `/tickets/${restricted}/assign`, { user_id: ids.admin })).status,
    ).toBe(422);
    expect(
      (await call("owner", "POST", `/tickets/${restricted}/assign`, { user_id: ids.owner2 }))
        .status,
    ).toBe(422);
    expect(
      (await call("owner", "POST", `/tickets/${restricted}/assign`, { user_id: ids.owner })).status,
    ).toBe(200);
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [ids.agent]);
    expect(
      (await call("admin", "POST", `/tickets/${t}/assign`, { user_id: ids.agent })).status,
    ).toBe(422);
  });

  test("status sets open, pending, closed or spam, with an event; escalated is not settable here", async () => {
    const t = ticket();
    expect(
      (await call("admin", "POST", `/tickets/${t}/status`, { status: "closed" })).body.ticket
        .status,
    ).toBe("closed");
    expect((await call("admin", "POST", `/tickets/${t}/status`, { status: "closed" })).status).toBe(
      200,
    );
    expect(events(t).length).toBe(1);
    expect(
      (await call("admin", "POST", `/tickets/${t}/status`, { status: "escalated" })).status,
    ).toBe(400);
  });
});

describe("escalate", () => {
  test("hands the ticket to the queue's escalation owner, marks it escalated, records and notifies", async () => {
    const put = await call("owner", "PUT", "/queues/support", { escalation_user_id: ids.owner2 });
    expect(put.status).toBe(200);
    const t = ticket({ assignee: ids.admin, subject: "Broken <upload>" });
    const r = await call("admin", "POST", `/tickets/${t}/escalate`, {
      reason: "needs an owner <now>",
    });
    expect(r.status).toBe(200);
    expect(r.body.ticket).toMatchObject({ status: "escalated", assignee_user_id: ids.owner2 });
    expect(events(t).map((e) => [e.kind, e.actor_user_id])).toEqual([
      ["escalated", ids.admin],
      ["assigned", ids.admin],
    ]);
    expect(binding.sent.length).toBe(1);
    expect(binding.sent[0].to).toBe("mail-owner2@example.org");
    expect(binding.sent[0].subject).toBe(
      "[NEMAR support] Escalated " + row(t).ref + ": Broken <upload>",
    );
    expect(binding.sent[0].html).toContain("Broken &lt;upload&gt;");
    expect(binding.sent[0].html).toContain("needs an owner &lt;now&gt;");
    expect(JSON.stringify(binding.sent[0])).not.toContain("ada@sender.example");
    expect((await call("admin", "POST", `/tickets/${t}/escalate`, {})).body.code).toBe(
      "already_escalated",
    );
  });

  test("falls back to the '*' queue's owner; refuses with none, for closed tickets and for ineligible owners", async () => {
    const t = ticket({ queue: "billing" });
    expect((await call("admin", "POST", `/tickets/${t}/escalate`, {})).body.code).toBe(
      "no_escalation_owner",
    );
    await call("owner", "PUT", "/queues/*", { escalation_user_id: ids.owner });
    const closed = ticket({ status: "closed" });
    expect((await call("admin", "POST", `/tickets/${closed}/escalate`)).body.code).toBe(
      "ticket_closed",
    );
    expect((await call("admin", "POST", `/tickets/${t}/escalate`)).status).toBe(200);
    expect(row(t).assignee_user_id).toBe(ids.owner);

    // A restricted ticket that excludes the escalation owner refuses rather than reaching them.
    const hidden = ticket({ queue: "security", restricted: true, excluded: ids.owner });
    await call("owner", "PUT", "/queues/security", { escalation_user_id: ids.owner });
    expect((await call("owner2", "POST", `/tickets/${hidden}/escalate`)).body.code).toBe(
      "escalation_owner_ineligible",
    );
  });

  test("the escalation owner is always an owner", async () => {
    const r = await call("owner", "PUT", "/queues/support", { escalation_user_id: ids.admin });
    expect(r.status).toBe(422);
  });
});

describe("queues", () => {
  test("GET hides restricted queues from an admin; PUT is owner only", async () => {
    const asAdmin = (await call("admin", "GET", "/queues")).body.queues as { tag: string }[];
    expect(asAdmin.map((q) => q.tag).sort()).toEqual(["*"]);
    const asOwner = (await call("owner", "GET", "/queues")).body.queues as { tag: string }[];
    expect(asOwner.map((q) => q.tag).sort()).toEqual(["*", "conduct", "security"]);
    expect((await call("admin", "PUT", "/queues/support", { strategy: "pool" })).status).toBe(403);
    expect((await call("member", "PUT", "/queues/support", { strategy: "pool" })).status).toBe(403);
  });

  test("creates and merges a queue and validates its people", async () => {
    const made = await call("owner", "PUT", "/queues/billing", {
      strategy: "round_robin",
      rr_members: [ids.admin, ids.agent, ids.admin],
      backup_user_id: ids.owner,
    });
    expect(made.status).toBe(200);
    expect(made.body.queue).toMatchObject({
      tag: "billing",
      restricted: false,
      strategy: "round_robin",
      rr_members: [ids.admin, ids.agent],
      backup_user_id: ids.owner,
    });
    const merged = await call("owner", "PUT", "/queues/billing", {
      strategy: "fixed",
      assignee_user_id: ids.agent,
    });
    expect(merged.body.queue).toMatchObject({
      strategy: "fixed",
      assignee_user_id: ids.agent,
      rr_members: [ids.admin, ids.agent],
    });
    expect(
      (await call("owner", "PUT", "/queues/billing", { assignee_user_id: ids.member })).body.code,
    ).toBe("ineligible_assignee");
    expect((await call("owner", "PUT", "/queues/billing", { strategy: "random" })).status).toBe(
      400,
    );
    expect((await call("owner", "PUT", "/queues/Bad Tag", {})).status).toBe(400);
  });

  test("restricted queues take owners only, security and conduct stay restricted, the fallback never is", async () => {
    expect((await call("owner", "PUT", "/queues/security", { restricted: false })).body.code).toBe(
      "restricted_locked",
    );
    expect(
      (await call("owner", "PUT", "/queues/security", { assignee_user_id: ids.admin })).body.code,
    ).toBe("ineligible_assignee");
    expect(
      (
        await call("owner", "PUT", "/queues/security", {
          assignee_user_id: ids.owner,
          strategy: "fixed",
        })
      ).status,
    ).toBe(200);
    expect((await call("owner", "PUT", "/queues/*", { restricted: true })).body.code).toBe(
      "fallback_not_restrictable",
    );
    // Restricting a queue that lists a non-owner is refused.
    await call("owner", "PUT", "/queues/legal", { assignee_user_id: ids.admin });
    expect((await call("owner", "PUT", "/queues/legal", { restricted: true })).body.code).toBe(
      "ineligible_assignee",
    );
  });

  test("the restricted flag of a queue with open tickets cannot change", async () => {
    await call("owner", "PUT", "/queues/legal", { restricted: false });
    const t = ticket({ queue: "legal" });
    const busy = await call("owner", "PUT", "/queues/legal", { restricted: true });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe("restricted_flag_busy");
    db.run("UPDATE mail_tickets SET status = 'closed' WHERE id = ?", [t]);
    expect((await call("owner", "PUT", "/queues/legal", { restricted: true })).status).toBe(200);
    // The same flag is not a change.
    ticket({ queue: "legal", restricted: true });
    expect(
      (await call("owner", "PUT", "/queues/legal", { restricted: true, strategy: "pool" })).status,
    ).toBe(200);
  });
});

describe("availability", () => {
  test("a person sets and clears their own window; the backup must be eligible", async () => {
    const set = await call("agent", "PUT", "/availability", {
      away_from: "2026-10-25T00:00:00Z",
      away_until: "2026-10-30T00:00:00Z",
      backup_user_id: ids.admin,
      note: "conference",
    });
    expect(set.status).toBe(200);
    expect(set.body.availability).toMatchObject({
      user_id: ids.agent,
      backup_user_id: ids.admin,
      note: "conference",
    });
    expect((await call("agent", "GET", "/availability")).body.availability.away_until).toBe(
      "2026-10-30T00:00:00.000Z",
    );
    expect(
      (await call("agent", "PUT", "/availability", { backup_user_id: ids.member })).status,
    ).toBe(422);
    expect(
      (await call("agent", "PUT", "/availability", { backup_user_id: ids.agent })).status,
    ).toBe(422);
    expect((await call("agent", "PUT", "/availability", { away_from: "nonsense" })).status).toBe(
      400,
    );
    expect(
      (
        await call("agent", "PUT", "/availability", {
          away_from: "2026-11-01T00:00:00Z",
          away_until: "2026-10-01T00:00:00Z",
        })
      ).status,
    ).toBe(400);
    const clear = await call("agent", "PUT", "/availability", {
      away_from: null,
      away_until: null,
      backup_user_id: null,
      note: null,
    });
    expect(clear.body.availability.away_from).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM mail_availability").get()).toEqual({ n: 0 });
  });

  test("another person's window is an owner-only read and write", async () => {
    expect((await call("admin", "PUT", `/availability/${ids.agent}`, { note: "x" })).status).toBe(
      403,
    );
    expect((await call("admin", "GET", `/availability/${ids.agent}`)).status).toBe(403);
    const r = await call("owner", "PUT", `/availability/${ids.agent}`, {
      away_until: "2026-12-01T00:00:00Z",
    });
    expect(r.status).toBe(200);
    expect(r.body.availability.user_id).toBe(ids.agent);
    expect(
      (await call("owner", "GET", `/availability/${ids.agent}`)).body.availability.away_until,
    ).toBe("2026-12-01T00:00:00.000Z");
    expect((await call("owner", "PUT", `/availability/${ids.member}`, { note: "x" })).status).toBe(
      422,
    );
  });
});

describe("review round 1: reprocess, counts, reopen, ids", () => {
  test("replaying a key of a ticket that excludes the caller is a 404 with no ticket fields", async () => {
    const key = "inbound/raw/2026/10/24/1c9d8f3e-1111-4222-8333-444455556666.eml";
    await bucket.put(key, eml({ subject: "Concealed" }), {
      customMetadata: {
        envelope_from: "ada@sender.example",
        envelope_to: "support@nemar.org",
        received_at: "2026-10-24T10:00:00.000Z",
      },
    });
    const made = await call("owner", "POST", "/reprocess", { raw_key: key });
    expect(made.status).toBe(200);
    db.run("UPDATE mail_tickets SET excluded_user_id = ? WHERE id = ?", [
      ids.owner2,
      made.body.ticket_id,
    ]);
    const replay = await call("owner2", "POST", "/reprocess", { raw_key: key });
    expect(replay.status).toBe(404);
    expect(replay.body.code).toBe("not_found");
    expect(JSON.stringify(replay.body)).not.toContain(String(made.body.ticket_id));
    expect((await call("owner", "POST", "/reprocess", { raw_key: key })).body.outcome).toBe(
      "duplicate",
    );
  });

  test("a ticket created by a reprocess is announced even when the caller cannot see it", async () => {
    db.run("UPDATE mail_queues SET strategy = 'pool', assignee_user_id = NULL WHERE tag = '*'");
    const key = "inbound/raw/2026/10/24/2c9d8f3e-1111-4222-8333-444455556666.eml";
    await bucket.put(key, eml({ subject: "Announce me" }), {
      customMetadata: {
        envelope_from: "ada@sender.example",
        envelope_to: "support@nemar.org",
        received_at: "2026-10-24T10:00:00.000Z",
      },
    });
    // A trigger stands in for an exclusion present at creation: the new ticket excludes the caller.
    db.run(
      "CREATE TRIGGER excl AFTER INSERT ON mail_tickets BEGIN UPDATE mail_tickets SET excluded_user_id = " +
        ids.owner2 +
        " WHERE id = NEW.id; END",
    );
    const r = await call("owner2", "POST", "/reprocess", { raw_key: key });
    expect(r.status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM mail_tickets").get()).toEqual({ n: 1 });
    const to = binding.sent.map((m) => m.to as string);
    expect(to.length).toBeGreaterThan(0);
    expect(to).not.toContain("mail-owner2@example.org");
  });

  test("open_tickets counts only tickets the viewer may see", async () => {
    ticket({ queue: "support" });
    ticket({ queue: "support", excluded: ids.admin });
    ticket({ queue: "support", status: "closed" });
    const count = async (who: Who) =>
      (
        (await call(who, "GET", "/queues")).body.queues as { tag: string; open_tickets: number }[]
      ).find((q) => q.tag === "*");
    ticket({ queue: "*" });
    ticket({ queue: "*", excluded: ids.admin });
    expect((await count("admin"))?.open_tickets).toBe(1);
    expect((await count("owner"))?.open_tickets).toBe(2);
    ticket({ queue: "security", restricted: true });
    const sec = async (who: Who) =>
      (
        (await call(who, "GET", "/queues")).body.queues as { tag: string; open_tickets: number }[]
      ).find((q) => q.tag === "security");
    expect(await sec("admin")).toBeUndefined();
    expect((await sec("owner"))?.open_tickets).toBe(1);
  });

  test("reopening a ticket whose restriction no longer matches its queue is refused", async () => {
    const stale = ticket({ queue: "legal", restricted: true, status: "closed" });
    const r = await call("owner", "POST", `/tickets/${stale}/status`, { status: "open" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("restriction_mismatch");
    expect(row(stale).status).toBe("closed");
    const open = ticket({ queue: "security", restricted: false, status: "spam" });
    expect(
      (await call("owner", "POST", `/tickets/${open}/status`, { status: "open" })).body.code,
    ).toBe("restriction_mismatch");
    // Moving between closed and spam does not put the ticket back in anyone's hands.
    expect(
      (await call("owner", "POST", `/tickets/${stale}/status`, { status: "spam" })).status,
    ).toBe(200);
    expect(
      (await call("owner", "POST", `/tickets/${stale}/status`, { status: "closed" })).status,
    ).toBe(200);
    expect(
      (await call("owner", "POST", `/tickets/${stale}/status`, { status: "pending" })).body.code,
    ).toBe("restriction_mismatch");
    const fine = ticket({ queue: "security", restricted: true, status: "closed" });
    expect(
      (await call("owner", "POST", `/tickets/${fine}/status`, { status: "open" })).status,
    ).toBe(200);
    // Closing never needs the check.
    const live = ticket({ queue: "legal", restricted: true });
    expect(
      (await call("owner", "POST", `/tickets/${live}/status`, { status: "closed" })).status,
    ).toBe(200);
  });

  test("ids in a path are plain digits", async () => {
    const t = ticket();
    expect((await call("admin", "GET", `/tickets/${t}.0`)).status).toBe(404);
    expect((await call("admin", "GET", "/tickets/1e0")).status).toBe(404);
    expect((await call("admin", "GET", "/tickets/%2B1")).status).toBe(404);
    expect((await call("owner", "GET", "/availability/1e0")).status).toBe(400);
    expect((await call("owner", "GET", "/availability/0x1")).status).toBe(400);
  });
});

describe("reprocess", () => {
  const KEY = "inbound/raw/2026/10/24/0b9d8f3e-1111-4222-8333-444455556666.eml";

  test("owner only; rebuilds a ticket from the stored object; a second run is a duplicate", async () => {
    await bucket.put(KEY, eml({ subject: "Recovered" }), {
      customMetadata: {
        envelope_from: "ada@sender.example",
        envelope_to: "support@nemar.org",
        received_at: "2026-10-24T10:00:00.000Z",
      },
    });
    expect((await call("admin", "POST", "/reprocess", { raw_key: KEY })).status).toBe(403);
    const first = await call("owner", "POST", "/reprocess", { raw_key: KEY });
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("created");
    expect(row(first.body.ticket_id).subject).toBe("Recovered");
    expect((await call("owner", "POST", "/reprocess", { raw_key: KEY })).body.outcome).toBe(
      "duplicate",
    );
  });

  test("a missing key is 404, a malformed one 400, and no bucket is 409", async () => {
    const absent = "inbound/raw/2026/10/24/aaaaaaaa-1111-4222-8333-444455556666.eml";
    expect((await call("owner", "POST", "/reprocess", { raw_key: absent })).status).toBe(404);
    expect((await call("owner", "POST", "/reprocess", { raw_key: "../etc/passwd" })).status).toBe(
      400,
    );
    envOverrides = { MAIL_INBOUND: undefined };
    expect((await call("owner", "POST", "/reprocess", { raw_key: KEY })).body.code).toBe(
      "inbound_not_configured",
    );
  });
});

describe("ticket notifications", () => {
  function platform(raw: Uint8Array, to: string): ForwardableEmailMessage {
    return {
      from: "ada@sender.example",
      to,
      headers: new Headers(),
      rawSize: raw.byteLength,
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
      setReject: () => {},
    } as unknown as ForwardableEmailMessage;
  }
  const deliver = (to: string, subject = "Need <help>") =>
    handleInboundEmail(platform(eml({ subject, to }), to), {
      ...env(),
      MAIL_INBOUND: bucket,
    } as never);
  const recipients = () => binding.sent.map((m) => m.to as string).sort();

  test("an unassigned ordinary ticket notifies every opted-in admin, with the subject escaped and no requester address", async () => {
    db.run("UPDATE mail_queues SET assignee_user_id = NULL WHERE tag = '*'");
    db.run(`UPDATE users SET email_preferences = '{"support_tickets":false}' WHERE id = ?`, [
      ids.agent,
    ]);
    await deliver("support@nemar.org");
    expect(recipients()).toEqual(
      ["mail-admin@example.org", "mail-owner2@example.org", "mail-owner@example.org"].sort(),
    );
    const mail = binding.sent[0];
    expect(mail.subject).toStartWith("[NEMAR support] New ticket ");
    expect(mail.subject).toContain("Need <help>");
    expect(mail.html).toContain("Need &lt;help&gt;");
    expect(JSON.stringify(mail)).not.toContain("ada@sender.example");
  });

  test("an assigned ticket notifies only its assignee, and only if opted in", async () => {
    db.run("UPDATE mail_queues SET strategy = 'fixed', assignee_user_id = ? WHERE tag = '*'", [
      ids.agent,
    ]);
    await deliver("support@nemar.org");
    expect(recipients()).toEqual(["mail-agent@example.org"]);
    expect(binding.sent[0].subject).toContain("Assigned to you");
    db.run(`UPDATE users SET email_preferences = '{"support_tickets":false}' WHERE id = ?`, [
      ids.agent,
    ]);
    binding.sent.length = 0;
    await deliver("support@nemar.org");
    expect(recipients()).toEqual([]);
  });

  test("a restricted unassigned ticket reaches owners only, never the excluded one", async () => {
    await deliver("security@nemar.org");
    expect(recipients()).toEqual(["mail-owner2@example.org", "mail-owner@example.org"].sort());
    binding.sent.length = 0;
    const t = ticket({ queue: "security", restricted: true, excluded: ids.owner2 });
    const { notifyTicketCreated } = await import("../src/services/ticket-notify");
    await notifyTicketCreated(env(), realD1(db), t);
    expect(recipients()).toEqual(["mail-owner@example.org"]);
  });

  test("spam notifies nobody, and the fence holds outside production", async () => {
    await handleInboundEmail(platform(eml({ auth: null, subject: "spam" }), "support@nemar.org"), {
      ...env(),
      MAIL_INBOUND: bucket,
    } as never);
    expect(binding.sent.length).toBe(0);
    envOverrides = { ENVIRONMENT: "development", DEV_EMAIL_ALLOWLIST: "@example.org" };
    await deliver("support@nemar.org");
    expect(binding.sent.length).toBe(0);
    envOverrides = {
      ENVIRONMENT: "development",
      DEV_EMAIL_ALLOWLIST: "@example.org",
      DEV_ADMIN_NOTIFICATIONS: "1",
    };
    await deliver("support@nemar.org");
    expect(binding.sent.length).toBeGreaterThan(0);
  });

  test("a failing send never fails ingest", async () => {
    binding = recordingBinding(() => bindingError("E_INTERNAL_SERVER_ERROR", "down"));
    await deliver("support@nemar.org");
    expect(db.query("SELECT COUNT(*) AS n FROM mail_tickets").get()).toEqual({ n: 1 });
  });
});

describe("cascades", () => {
  test("an escalation owner is cleared whenever the person stops being an owner, in either scope", async () => {
    const { mailReleaseStatements } = await import("../src/services/ticket-assignment");
    const esc = (tag: string) =>
      (
        db.query("SELECT escalation_user_id AS e FROM mail_queues WHERE tag = ?").get(tag) as {
          e: number | null;
        }
      ).e;
    for (const scope of ["restricted", "all"] as const) {
      await call("owner", "PUT", "/queues/support", { escalation_user_id: ids.owner2 });
      await call("owner", "PUT", "/queues/security", { escalation_user_id: ids.owner2 });
      expect([esc("support"), esc("security")]).toEqual([ids.owner2, ids.owner2]);
      for (const st of mailReleaseStatements(ids.owner2, scope))
        db.run(st.sql, st.binds as never[]);
      expect([scope, esc("support"), esc("security")]).toEqual([scope, null, null]);
    }
  });

  test("escalation always lands on an owner, even if the stored owner was demoted without the cascade", async () => {
    await call("owner", "PUT", "/queues/support", { escalation_user_id: ids.owner2 });
    db.run("UPDATE users SET role = 'admin' WHERE id = ?", [ids.owner2]);
    const t = ticket();
    expect((await call("admin", "POST", `/tickets/${t}/escalate`)).body.code).toBe(
      "escalation_owner_ineligible",
    );
    expect(row(t).status).toBe("open");
  });
});
