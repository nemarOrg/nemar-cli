/**
 * Inbound mail screening (epic #1893 follow-up, ADR 0113): the sender blocklist refused at
 * delivery, bulk and automatic mail filed quietly, the per-sender hourly cap, and quiet queues.
 *
 * Real postal-mime on real message text, a real migrated database (bun:sqlite behind realD1), real
 * R2 (Miniflare) for the delivery path, the REAL admin router with real API keys for the routes,
 * and the recording `send_email` binding at the send boundary. No mocks of business logic.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { adminRoutes } from "../src/routes/admin";
import { INBOUND_REJECT_REASON, handleInboundEmail } from "../src/services/inbound-mail";
import {
  DEFAULT_SENDER_HOURLY_CAP,
  addressesIn,
  classifyAutomatedMail,
  findBlock,
  normalizeBlock,
  senderHourlyCap,
} from "../src/services/mail-screening";
import { notifyTicketEscalated } from "../src/services/ticket-notify";
import { ingestInboundMessage } from "../src/services/tickets";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { recordingBinding } from "./helpers/cloudflare-email";
import { freshDb, realD1 } from "./helpers/d1";
import { PASS, eml } from "./helpers/tickets";

const KEYS = {
  owner: "scr-owner-key-0123456789abcdef0123456789abcdef",
  admin: "scr-admin-key-0123456789abcdef0123456789abcdef",
  admin2: "scr-admin2-key-0123456789abcdef0123456789abcdef",
};
type Who = keyof typeof KEYS;

let db: Database;
let d1: D1Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ids: Record<Who, number>;
let binding: ReturnType<typeof recordingBinding>;
let bucket: R2Bucket;
let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default {}", r2Buckets: ["MAIL_INBOUND"] });
  bucket = (await mf.getR2Bucket("MAIL_INBOUND")) as unknown as R2Bucket;
});
afterAll(async () => {
  await mf?.dispose();
}, 30_000);

function env(extra: Partial<Bindings> = {}): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: "production",
    FROM_EMAIL: "NEMAR Archive <noreply@nemar.org>",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: binding.binding,
    RESEND_API_KEY: "resend-key",
    MAIL_INBOUND: bucket,
    ...extra,
  } as Bindings;
}

async function seed(who: Who, role: "owner" | "admin") {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, signup_source,
                        email_verified, service_access, account_kind)
     VALUES (?, ?, 'x', ?, 'approved', ?, 'cli', 1, 0, 'person')`,
    [`scr-${who}`, `scr-${who}@example.org`, `scr-${who}-gh`, role],
  );
  const row = db.query("SELECT id FROM users WHERE username = ?").get(`scr-${who}`) as {
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
  d1 = realD1(db);
  binding = recordingBinding();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  ids = {
    owner: await seed("owner", "owner"),
    admin: await seed("admin", "admin"),
    admin2: await seed("admin2", "admin"),
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

let n = 0;
async function ingest(
  o: Parameters<typeof eml>[0] = {},
  opts: { at?: Date; cap?: number; envelopeFrom?: string; to?: string } = {},
) {
  n += 1;
  const to = opts.to ?? "support@nemar.org";
  return ingestInboundMessage(
    d1,
    {
      rawKey: `inbound/raw/2026/10/25/screen-${n}.eml`,
      raw: eml({ ...o, to }),
      envelopeFrom: opts.envelopeFrom ?? "bounce@sender.example",
      envelopeTo: to,
      receivedAt: opts.at ?? new Date(),
    },
    opts.cap === undefined ? {} : { senderHourlyCap: opts.cap },
  );
}

const ticketRow = (id: number) =>
  db.query("SELECT * FROM mail_tickets WHERE id = ?").get(id) as Record<string, any>;
const count = (sql: string) => (db.query(sql).get() as { n: number }).n;

/** The message as the platform hands it to `email()`. */
function platform(
  raw: Uint8Array,
  from: string,
  rejects: string[] = [],
  headerFrom?: string,
): ForwardableEmailMessage {
  const headers = new Headers();
  if (headerFrom) headers.set("from", headerFrom);
  return {
    from,
    to: "support@nemar.org",
    headers,
    rawSize: raw.byteLength,
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    setReject: (reason: string) => {
      rejects.push(reason);
    },
  } as unknown as ForwardableEmailMessage;
}

async function storedKeys(): Promise<string[]> {
  return (await bucket.list({ prefix: "inbound/raw/" })).objects.map((o) => o.key);
}
async function clearBucket() {
  const keys = await storedKeys();
  if (keys.length > 0) await bucket.delete(keys);
}

// ---------------------------------------------------------------------------------------------

describe("classifyAutomatedMail", () => {
  const h = (...pairs: [string, string][]) => pairs.map(([key, value]) => ({ key, value }));

  test("ordinary mail is not filtered", () => {
    expect(classifyAutomatedMail(h(["From", "a@b.example"]), "a@b.example", "a@b.example")).toBe(
      null,
    );
    expect(classifyAutomatedMail(h(["Auto-Submitted", "no"]), "a@b.example")).toBe(null);
    expect(classifyAutomatedMail(h(["Precedence", "first-class"]), "a@b.example")).toBe(null);
  });

  test("bulk: Precedence bulk, list or junk, List-Id, List-Unsubscribe", () => {
    for (const v of ["bulk", "list", "JUNK"]) {
      expect(classifyAutomatedMail(h(["Precedence", v]), "a@b.example")).toBe("bulk");
    }
    expect(classifyAutomatedMail(h(["List-Id", "<news.b.example>"]), "a@b.example")).toBe("bulk");
    expect(
      classifyAutomatedMail(h(["list-unsubscribe", "<mailto:u@b.example>"]), "a@b.example"),
    ).toBe("bulk");
  });

  test("auto_reply: Auto-Submitted other than no, the auto-reply markers", () => {
    expect(classifyAutomatedMail(h(["Auto-Submitted", "auto-replied"]), "a@b.example")).toBe(
      "auto_reply",
    );
    expect(classifyAutomatedMail(h(["Auto-Submitted", "auto-generated"]), "a@b.example")).toBe(
      "auto_reply",
    );
    expect(classifyAutomatedMail(h(["X-Autoreply", "yes"]), "a@b.example")).toBe("auto_reply");
    expect(classifyAutomatedMail(h(["X-Autorespond", "1"]), "a@b.example")).toBe("auto_reply");
    expect(
      classifyAutomatedMail(h(["X-Auto-Response-Suppress", "DR, OOF, AutoReply"]), "a@b.example"),
    ).toBe("auto_reply");
    expect(classifyAutomatedMail(h(["X-Auto-Response-Suppress", "All"]), "a@b.example")).toBe(
      "auto_reply",
    );
    expect(classifyAutomatedMail(h(["Precedence", "auto_reply"]), "a@b.example")).toBe(
      "auto_reply",
    );
    expect(classifyAutomatedMail(h(["X-Auto-Response-Suppress", "DR"]), "a@b.example")).toBe(null);
  });

  test("bounce: empty or <> sender, mailer-daemon or postmaster, multipart/report", () => {
    expect(classifyAutomatedMail([], "")).toBe("bounce");
    expect(classifyAutomatedMail([], "<>")).toBe("bounce");
    expect(classifyAutomatedMail([], "MAILER-DAEMON@b.example")).toBe("bounce");
    expect(classifyAutomatedMail([], "postmaster@b.example")).toBe("bounce");
    expect(classifyAutomatedMail([], "x@b.example", "mailer-daemon@b.example")).toBe("bounce");
    expect(
      classifyAutomatedMail(
        h(["Content-Type", "multipart/report; report-type=delivery-status; boundary=x"]),
        "x@b.example",
      ),
    ).toBe("bounce");
    // The most specific reading wins over a list header on the same message.
    expect(classifyAutomatedMail(h(["List-Id", "<l.b.example>"]), "")).toBe("bounce");
  });
});

describe("senderHourlyCap", () => {
  test("a whole number from 1 to 100000, else the default of 20", () => {
    expect(DEFAULT_SENDER_HOURLY_CAP).toBe(20);
    expect(senderHourlyCap("5")).toBe(5);
    expect(senderHourlyCap(" 100000 ")).toBe(100000);
    for (const bad of [undefined, "", "0", "-3", "abc", "2.5", "100001", "1e3"]) {
      expect(senderHourlyCap(bad)).toBe(20);
    }
  });
});

describe("addressesIn and normalizeBlock", () => {
  test("every address of a From value, lowercased; junk gives none", () => {
    expect(addressesIn('"Ada L." <Ada@Sender.Example>')).toEqual(["ada@sender.example"]);
    expect(addressesIn("a@x.example, B <b@y.example>")).toEqual(["a@x.example", "b@y.example"]);
    expect(addressesIn('"fake@decoy.example" <real@sender.example>')).toEqual([
      "real@sender.example",
    ]);
    expect(addressesIn("not an address")).toEqual([]);
    expect(addressesIn(null)).toEqual([]);
    expect(addressesIn("")).toEqual([]);
  });

  test("normalizes, and refuses our domain, shared providers and malformed values", () => {
    expect(normalizeBlock("domain", " @Spam.Example ")).toEqual({
      kind: "domain",
      value: "spam.example",
    });
    expect(normalizeBlock("address", "Bad@Spam.Example")).toEqual({
      kind: "address",
      value: "bad@spam.example",
    });
    // An address at a shared provider is fine; the provider's domain is not.
    expect(normalizeBlock("address", "bad@gmail.com")).toEqual({
      kind: "address",
      value: "bad@gmail.com",
    });
    for (const d of [
      "gmail.com",
      "outlook.com",
      "proton.me",
      "gmx.de",
      "gmx.co.uk",
      "mail.yahoo.com",
      "163.com",
    ]) {
      const r = normalizeBlock("domain", d);
      expect("refusal" in r && !r.malformed).toBe(true);
    }
    for (const v of ["nemar.org", "mail.nemar.org", "support.test.nemar.org"]) {
      const r = normalizeBlock("domain", v);
      expect("refusal" in r && !r.malformed).toBe(true);
    }
    const own = normalizeBlock("address", "someone@nemar.org");
    expect("refusal" in own && !own.malformed).toBe(true);
    const stagingOwn = normalizeBlock("domain", "mail.example.org", ["example.org"]);
    expect("refusal" in stagingOwn).toBe(true);
    // ucsd.edu is not a shared provider.
    expect(normalizeBlock("domain", "ucsd.edu")).toEqual({ kind: "domain", value: "ucsd.edu" });
    for (const [kind, v] of [
      ["domain", "com"],
      ["domain", "not a domain"],
      ["domain", "a@b.example"],
      ["address", "no-at-sign"],
      ["address", "a b@c.example"],
      ["address", "a@localhost"],
      ["other", "x"],
    ] as const) {
      const r = normalizeBlock(kind, v);
      expect("refusal" in r && r.malformed).toBe(true);
    }
  });
});

describe("migration 0111", () => {
  test("the table, the columns and their defaults", () => {
    const cols = (t: string) =>
      (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("mail_blocklist")).toEqual([
      "id",
      "kind",
      "value",
      "reason",
      "created_by",
      "created_at",
    ]);
    expect(cols("mail_tickets")).toContain("filtered");
    expect(cols("mail_queues")).toContain("notify");
    expect(db.query("SELECT notify FROM mail_queues WHERE tag = 'security'").get()).toEqual({
      notify: 1,
    });
    db.run(
      "INSERT INTO mail_blocklist (kind, value, created_by) VALUES ('domain', 'a.example', 1)",
    );
    expect(() =>
      db.run(
        "INSERT INTO mail_blocklist (kind, value, created_by) VALUES ('domain', 'a.example', 2)",
      ),
    ).toThrow();
    // The same text as an address is a different entry, but a value must be lowercase.
    db.run(
      "INSERT INTO mail_blocklist (kind, value, created_by) VALUES ('address', 'a.example', 1)",
    );
    expect(() =>
      db.run(
        "INSERT INTO mail_blocklist (kind, value, created_by) VALUES ('address', 'A@x.example', 1)",
      ),
    ).toThrow();
    expect(() =>
      db.run("INSERT INTO mail_blocklist (kind, value, created_by) VALUES ('ip', 'x', 1)"),
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO mail_tickets (ref, queue_tag, requester_email, filtered) VALUES ('amber-falcon-river', 'support', 'a@example.org', 'junk')",
      ),
    ).toThrow();
  });
});

describe("filtered tickets", () => {
  test("a new bulk ticket is open, filtered, unassigned and creates no notice", async () => {
    db.run("UPDATE mail_queues SET strategy = 'fixed', assignee_user_id = ? WHERE tag = '*'", [
      ids.admin,
    ]);
    const r = await ingest({ extraHeaders: ["List-Unsubscribe: <mailto:u@sender.example>"] });
    expect(r).toMatchObject({
      outcome: "created",
      status: "open",
      filtered: "bulk",
      assigneeUserId: null,
    });
    const t = ticketRow(r.ticketId);
    expect(t.filtered).toBe("bulk");
    expect(t.assignee_user_id).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM mail_ticket_events WHERE kind = 'assigned'")).toBe(0);
    const created = db
      .query("SELECT detail FROM mail_ticket_events WHERE kind = 'created'")
      .get() as {
      detail: string;
    };
    expect(JSON.parse(created.detail).filtered).toBe("bulk");
  });

  test("an unfiltered ticket in the same setup is assigned", async () => {
    db.run("UPDATE mail_queues SET strategy = 'fixed', assignee_user_id = ? WHERE tag = '*'", [
      ids.admin,
    ]);
    const r = await ingest();
    expect(r).toMatchObject({ filtered: null, assigneeUserId: ids.admin });
  });

  test("auto-replies and bounces are filed the same way", async () => {
    const auto = await ingest({ extraHeaders: ["Auto-Submitted: auto-replied"] });
    expect(auto.filtered).toBe("auto_reply");
    const bounce = await ingest({}, { envelopeFrom: "" });
    expect(bounce.filtered).toBe("bounce");
    n += 1;
    const dsn = [
      `Authentication-Results: ${PASS}`,
      "From: Mail Delivery <relay@sender.example>",
      "To: support@nemar.org",
      "Subject: Undelivered Mail Returned to Sender",
      `Message-ID: <dsn${n}@sender.example>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="zz"',
      "",
      "--zz",
      "Content-Type: text/plain",
      "",
      "Delivery failed.",
      "--zz--",
      "",
    ].join("\r\n");
    const report = await ingestInboundMessage(d1, {
      rawKey: `inbound/raw/2026/10/25/dsn-${n}.eml`,
      raw: new TextEncoder().encode(dsn),
      envelopeFrom: "relay@sender.example",
      envelopeTo: "support@nemar.org",
      receivedAt: new Date(),
    });
    expect(report.filtered).toBe("bounce");
  });

  test("spam wins over filtered: status spam, no filtered mark", async () => {
    const r = await ingest({ auth: null, extraHeaders: ["Precedence: bulk"] });
    expect(r).toMatchObject({ status: "spam", spam: true, filtered: null });
    expect(ticketRow(r.ticketId).filtered).toBeNull();
  });

  test("a filtered reply threads into a closed ticket without reopening or reassigning it", async () => {
    const first = await ingest({ subject: "Question", messageId: "<root@sender.example>" });
    db.run("UPDATE mail_tickets SET status = 'closed', assignee_user_id = ? WHERE id = ?", [
      ids.admin,
      first.ticketId,
    ]);
    const auto = await ingest({
      subject: "Out of office",
      inReplyTo: "<root@sender.example>",
      extraHeaders: ["Auto-Submitted: auto-replied"],
    });
    expect(auto).toMatchObject({
      outcome: "threaded",
      ticketId: first.ticketId,
      status: "closed",
      filtered: "auto_reply",
    });
    const t = ticketRow(first.ticketId);
    expect(t.status).toBe("closed");
    expect(t.assignee_user_id).toBe(ids.admin);
    expect(t.filtered).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM mail_messages")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM mail_ticket_events WHERE kind = 'reopened'")).toBe(0);
    // A real reply, on the other hand, still reopens it.
    const real = await ingest({ subject: "Re: Question", inReplyTo: "<root@sender.example>" });
    expect(real).toMatchObject({ outcome: "threaded", status: "open", filtered: null });
  });

  test("the list hides filtered tickets by default; only and include show them", async () => {
    const plain = await ingest({ subject: "plain" });
    const bulk = await ingest({
      subject: "newsletter",
      from: "News <news@sender.example>",
      extraHeaders: ["Precedence: bulk"],
    });
    const titles = async (q: string) =>
      ((await call("owner", "GET", `/tickets${q}`)).body.tickets as any[]).map((t) => t.subject);
    expect(await titles("")).toEqual(["plain"]);
    expect(await titles("?filtered=only")).toEqual(["newsletter"]);
    expect((await titles("?filtered=include")).sort()).toEqual(["newsletter", "plain"]);
    const only = (await call("owner", "GET", "/tickets?filtered=only")).body.tickets[0];
    expect(only.filtered).toBe("bulk");
    expect(only.id).toBe(bulk.ticketId);
    expect(
      (await call("owner", "GET", `/tickets/${plain.ticketId}`)).body.ticket.filtered,
    ).toBeNull();
    expect((await call("owner", "GET", "/tickets?filtered=sideways")).status).toBe(400);
    // A closed filtered ticket still shows in the summary queue.
    db.run("UPDATE mail_tickets SET status = 'closed' WHERE id = ?", [bulk.ticketId]);
    const summary = (await call("owner", "GET", "/tickets?summary=missing")).body.tickets;
    expect(summary.map((t: any) => t.id)).toEqual([bulk.ticketId]);
  });

  test("filtered tickets never count in the unread badge", async () => {
    await ingest({ subject: "plain" });
    await ingest({ subject: "bulk", extraHeaders: ["Precedence: list"] });
    expect((await call("admin", "GET", "/unread-count")).body.count).toBe(1);
  });
});

describe("the per-sender hourly cap", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 25, 12, minutes));

  test("at the cap the next message is stored and threaded but filed as rate_limited", async () => {
    db.run("UPDATE mail_queues SET strategy = 'fixed', assignee_user_id = ? WHERE tag = '*'", [
      ids.admin,
    ]);
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await ingest({ subject: `m${i}` }, { cap: 3, at: at(i) }));
    }
    expect(results.map((r) => r.filtered)).toEqual([null, null, null, "rate_limited"]);
    expect(results[3].assigneeUserId).toBeNull();
    expect(ticketRow(results[3].ticketId).filtered).toBe("rate_limited");
    expect(count("SELECT COUNT(*) AS n FROM mail_messages")).toBe(4);
  });

  test("another sender is counted separately, and the window slides", async () => {
    for (let i = 0; i < 2; i++) await ingest({}, { cap: 2, at: at(i) });
    const other = await ingest({ from: "Bo <bo@sender.example>" }, { cap: 2, at: at(3) });
    expect(other.filtered).toBeNull();
    const limited = await ingest({}, { cap: 2, at: at(5) });
    expect(limited.filtered).toBe("rate_limited");
    // 61 minutes after the first two: only one message is still inside the hour.
    const later = await ingest({}, { cap: 2, at: at(62) });
    expect(later.filtered).toBeNull();
  });

  test("a rate-limited reply into an open ticket sends nothing and changes nothing else", async () => {
    const root = await ingest({ messageId: "<r1@sender.example>" }, { cap: 1, at: at(0) });
    db.run("UPDATE mail_tickets SET status = 'pending' WHERE id = ?", [root.ticketId]);
    const reply = await ingest({ inReplyTo: "<r1@sender.example>" }, { cap: 1, at: at(1) });
    expect(reply).toMatchObject({
      outcome: "threaded",
      status: "pending",
      filtered: "rate_limited",
    });
  });

  test("no cap given (a reprocess) means no limit", async () => {
    for (let i = 0; i < 5; i++) expect((await ingest({}, { at: at(i) })).filtered).toBeNull();
  });
});

describe("delivery: the blocklist and the quiet paths, through email()", () => {
  const block = (kind: string, value: string) =>
    db.run("INSERT INTO mail_blocklist (kind, value, created_by) VALUES (?, ?, ?)", [
      kind,
      value,
      ids.owner,
    ]);

  beforeEach(clearBucket);

  async function deliver(
    from: string,
    headerFrom: string | undefined,
    e: Partial<Bindings> = {},
    raw = eml({ from: headerFrom ?? from }),
  ) {
    const rejects: string[] = [];
    await handleInboundEmail(platform(raw, from, rejects, headerFrom), env(e) as never);
    return rejects;
  }

  test("a blocked envelope sender is refused and nothing is stored", async () => {
    block("address", "bad@spam.example");
    const rejects = await deliver("bad@spam.example", undefined);
    expect(rejects).toEqual([INBOUND_REJECT_REASON]);
    expect(await storedKeys()).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM mail_tickets")).toBe(0);
    expect(binding.sent.length).toBe(0);
  });

  test("the header From is checked too, whatever the envelope says", async () => {
    block("address", "bad@spam.example");
    const rejects = await deliver("bounces@relay.example", "Bad <Bad@Spam.Example>");
    expect(rejects).toEqual([INBOUND_REJECT_REASON]);
    expect(await storedKeys()).toEqual([]);
  });

  test("a domain block covers the domain, its subdomains, but not a look-alike", async () => {
    block("domain", "spam.example");
    for (const from of ["x@spam.example", "x@a.b.spam.example"]) {
      expect(await deliver(from, undefined)).toEqual([INBOUND_REJECT_REASON]);
    }
    expect(await storedKeys()).toEqual([]);
    for (const from of ["x@notspam.example", "x@spam.example.org"]) {
      expect(await deliver(from, undefined, {}, eml({ from: "Ada <ada@sender.example>" }))).toEqual(
        [],
      );
    }
    expect((await storedKeys()).length).toBe(2);
  });

  test("an empty envelope sender (a bounce) is not caught by any block", async () => {
    block("domain", "spam.example");
    const rejects = await deliver("", undefined, {}, eml({ from: "Ada <ada@sender.example>" }));
    expect(rejects).toEqual([]);
    expect((await storedKeys()).length).toBe(1);
  });

  test("an unblocked sender is stored and ticketed as before", async () => {
    block("address", "bad@spam.example");
    expect(await deliver("ada@sender.example", "Ada <ada@sender.example>")).toEqual([]);
    expect((await storedKeys()).length).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM mail_tickets")).toBe(1);
  });

  test("a failing blocklist lookup fails open: the message is stored and ticketed", async () => {
    db.run("DROP TABLE mail_blocklist");
    const rejects = await deliver("ada@sender.example", "Ada <ada@sender.example>");
    expect(rejects).toEqual([]);
    expect((await storedKeys()).length).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM mail_tickets")).toBe(1);
  });

  test("findBlock reports which kind matched", async () => {
    block("domain", "spam.example");
    expect(await findBlock(d1, ["x@a.spam.example"])).toEqual({
      kind: "domain",
      value: "spam.example",
    });
    expect(await findBlock(d1, ["x@fine.example", ""])).toBeNull();
    expect(await findBlock(d1, [])).toBeNull();
  });

  test("filtered mail creates a ticket and sends no notice; normal mail does", async () => {
    await deliver(
      "ada@sender.example",
      "Ada <ada@sender.example>",
      {},
      eml({ extraHeaders: ["Precedence: bulk"] }),
    );
    expect(count("SELECT COUNT(*) AS n FROM mail_tickets WHERE filtered = 'bulk'")).toBe(1);
    expect(binding.sent.length).toBe(0);
    await deliver("ada@sender.example", "Ada <ada@sender.example>");
    expect(binding.sent.length).toBeGreaterThan(0);
  });

  test("the hourly cap comes from MAIL_SENDER_HOURLY_CAP", async () => {
    for (let i = 0; i < 3; i++) {
      await deliver("ada@sender.example", "Ada <ada@sender.example>", {
        MAIL_SENDER_HOURLY_CAP: "2",
      });
    }
    expect(
      db
        .query("SELECT filtered FROM mail_tickets ORDER BY id")
        .all()
        .map((r: any) => r.filtered),
    ).toEqual([null, null, "rate_limited"]);
  });

  test("a quiet queue sends no creation notice, and an escalation still goes out", async () => {
    const put = await call("owner", "PUT", "/queues/*", { notify: false });
    expect(put.status).toBe(200);
    expect(put.body.queue.notify).toBe(false);
    await deliver("ada@sender.example", "Ada <ada@sender.example>");
    expect(count("SELECT COUNT(*) AS n FROM mail_tickets")).toBe(1);
    expect(binding.sent.length).toBe(0);
    const t = (db.query("SELECT id FROM mail_tickets").get() as { id: number }).id;
    await notifyTicketEscalated(env(), d1, t, ids.owner, "needs a look");
    expect(binding.sent.length).toBe(1);
    // Turned back on, the queue announces again.
    expect((await call("owner", "PUT", "/queues/*", { notify: true })).body.queue.notify).toBe(
      true,
    );
    await deliver("ada@sender.example", "Ada <ada@sender.example>");
    expect(binding.sent.length).toBeGreaterThan(1);
  });

  test("a queue created without notify announces, and notify is listed", async () => {
    const made = await call("owner", "PUT", "/queues/billing", { restricted: false });
    expect(made.body.queue.notify).toBe(true);
    const list = (await call("owner", "GET", "/queues")).body.queues as any[];
    expect(list.every((q) => typeof q.notify === "boolean")).toBe(true);
    expect((await call("owner", "PUT", "/queues/billing", { notify: "no" })).status).toBe(400);
    // An unrelated change keeps the setting.
    await call("owner", "PUT", "/queues/billing", { notify: false });
    const kept = await call("owner", "PUT", "/queues/billing", { strategy: "pool" });
    expect(kept.body.queue.notify).toBe(false);
  });
});

describe("blocklist routes", () => {
  test("add, list, repeat, remove", async () => {
    const add = await call("admin", "POST", "/blocklist", {
      kind: "domain",
      value: "@Spam.Example",
      reason: "  newsletter\nflood ",
    });
    expect(add.status).toBe(200);
    expect(add.body.created).toBe(true);
    expect(add.body.entry).toMatchObject({
      kind: "domain",
      value: "spam.example",
      reason: "newsletter flood",
      created_by: ids.admin,
    });
    const again = await call("admin2", "POST", "/blocklist", {
      kind: "domain",
      value: "spam.example",
      reason: "other",
    });
    expect(again.body.created).toBe(false);
    expect(again.body.entry).toMatchObject({
      id: add.body.entry.id,
      created_by: ids.admin,
      reason: "newsletter flood",
    });
    await call("admin", "POST", "/blocklist", { kind: "address", value: "x@y.example" });
    const list = await call("admin", "GET", "/blocklist");
    expect(list.body.entries.map((e: any) => e.value)).toEqual(["x@y.example", "spam.example"]);
    const page = await call("admin", "GET", "/blocklist?limit=1");
    expect(page.body.entries.length).toBe(1);
    expect(page.body.next_cursor).not.toBeNull();
    const next = await call("admin", "GET", `/blocklist?limit=1&cursor=${page.body.next_cursor}`);
    expect(next.body.entries.map((e: any) => e.value)).toEqual(["spam.example"]);
    expect(next.body.next_cursor).toBeNull();
    expect((await call("admin", "GET", "/blocklist?cursor=abc")).status).toBe(400);

    const removed = await call("admin", "DELETE", `/blocklist/${add.body.entry.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.removed.value).toBe("spam.example");
    expect((await call("admin", "DELETE", `/blocklist/${add.body.entry.id}`)).status).toBe(404);
    expect((await call("admin", "DELETE", "/blocklist/abc")).status).toBe(404);
    expect(count("SELECT COUNT(*) AS n FROM mail_blocklist")).toBe(1);
  });

  test("our own domain and shared providers are refused with block_not_allowed", async () => {
    for (const [kind, value] of [
      ["domain", "nemar.org"],
      ["domain", "lists.nemar.org"],
      ["address", "someone@nemar.org"],
      ["domain", "gmail.com"],
      ["domain", "gmx.net"],
    ]) {
      const r = await call("admin", "POST", "/blocklist", { kind, value });
      expect([kind, value, r.status, r.body.code]).toEqual([kind, value, 422, "block_not_allowed"]);
    }
    expect(
      (await call("admin", "POST", "/blocklist", { kind: "address", value: "x@gmail.com" })).status,
    ).toBe(200);
    expect(
      (await call("admin", "POST", "/blocklist", { kind: "domain", value: "ucsd.edu" })).status,
    ).toBe(200);
    for (const body of [
      { kind: "domain", value: "nonsense" },
      { kind: "address", value: "nonsense" },
      { kind: "ip", value: "1.2.3.4" },
      { kind: "domain" },
      { kind: "domain", value: "a.example", extra: 1 },
    ]) {
      expect((await call("admin", "POST", "/blocklist", body)).status).toBe(400);
    }
  });

  test("a member cannot reach the routes", async () => {
    db.run("UPDATE users SET role = 'member', status = 'verified' WHERE id = ?", [ids.admin2]);
    expect((await call("admin2", "GET", "/blocklist")).status).toBe(403);
    expect(
      (await call("admin2", "POST", "/blocklist", { kind: "domain", value: "a.example" })).status,
    ).toBe(403);
  });
});

describe("POST /tickets/:id/spam", () => {
  async function ticketFrom(
    from: string,
    o: { queue?: string; restricted?: boolean; excluded?: number } = {},
  ) {
    const to = `${o.queue ?? "support"}@nemar.org`;
    const domain = from.split("@")[1];
    const auth = `mx.cloudflare.net; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;
    const r = await ingest({ from: `Sender <${from}>`, auth }, { to });
    if (o.excluded !== undefined)
      db.run("UPDATE mail_tickets SET excluded_user_id = ? WHERE id = ?", [o.excluded, r.ticketId]);
    return r.ticketId;
  }

  test("marks spam, unassigns, records the actor and blocks the address", async () => {
    const t = await ticketFrom("bad@spam.example");
    db.run("UPDATE mail_tickets SET assignee_user_id = ? WHERE id = ?", [ids.admin, t]);
    const r = await call("admin", "POST", `/tickets/${t}/spam`, {
      block: "address",
      reason: "junk",
    });
    expect(r.status).toBe(200);
    expect(r.body.ticket).toMatchObject({ status: "spam", assignee_user_id: null });
    expect(r.body.block).toMatchObject({
      kind: "address",
      value: "bad@spam.example",
      reason: "junk",
      created_by: ids.admin,
    });
    const events = db
      .query(
        "SELECT kind, actor_user_id, detail FROM mail_ticket_events WHERE ticket_id = ? ORDER BY id",
      )
      .all(t) as { kind: string; actor_user_id: number | null; detail: string }[];
    const status = events.find((e) => e.kind === "status");
    expect(status?.actor_user_id).toBe(ids.admin);
    expect(JSON.parse(status?.detail ?? "{}")).toMatchObject({ to: "spam" });
    expect(events.some((e) => e.kind === "unassigned" && e.actor_user_id === ids.admin)).toBe(true);
    expect(await findBlock(d1, ["bad@spam.example"])).not.toBeNull();
    expect(await findBlock(d1, ["other@spam.example"])).toBeNull();
  });

  test("domain blocks the whole domain; none blocks nothing; both are idempotent", async () => {
    const a = await ticketFrom("a@spam.example");
    const b = await ticketFrom("b@spam.example");
    const first = await call("admin", "POST", `/tickets/${a}/spam`, { block: "domain" });
    expect(first.body.block).toMatchObject({ kind: "domain", value: "spam.example" });
    const second = await call("admin2", "POST", `/tickets/${b}/spam`, { block: "domain" });
    expect(second.body.block.id).toBe(first.body.block.id);
    expect(count("SELECT COUNT(*) AS n FROM mail_blocklist")).toBe(1);
    const c = await ticketFrom("c@other.example");
    const none = await call("admin", "POST", `/tickets/${c}/spam`, { block: "none" });
    expect(none.body.block).toBeNull();
    expect(none.body.ticket.status).toBe("spam");
    expect(count("SELECT COUNT(*) AS n FROM mail_blocklist")).toBe(1);
    // Again on an already-spam ticket: still fine.
    expect((await call("admin", "POST", `/tickets/${c}/spam`, { block: "none" })).status).toBe(200);
  });

  test("a refused block leaves the ticket untouched", async () => {
    const t = await ticketFrom("someone@gmail.com");
    const domain = await call("admin", "POST", `/tickets/${t}/spam`, { block: "domain" });
    expect(domain.status).toBe(422);
    expect(domain.body.code).toBe("block_not_allowed");
    expect(ticketRow(t).status).toBe("open");
    expect((await call("admin", "POST", `/tickets/${t}/spam`, { block: "address" })).status).toBe(
      200,
    );
    const own = await ticketFrom("colleague@nemar.org");
    const refused = await call("admin", "POST", `/tickets/${own}/spam`, { block: "address" });
    expect(refused.body.code).toBe("block_not_allowed");
    expect(ticketRow(own).status).toBe("open");
  });

  test("visibility: a restricted ticket is 404 for an admin and for the excluded owner", async () => {
    const t = await ticketFrom("bad@spam.example", { queue: "security" });
    expect(ticketRow(t).restricted).toBe(1);
    const hidden = await call("admin", "POST", `/tickets/${t}/spam`, { block: "address" });
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe("not_found");
    expect(ticketRow(t).status).toBe("open");
    expect(count("SELECT COUNT(*) AS n FROM mail_blocklist")).toBe(0);

    db.run("UPDATE mail_tickets SET excluded_user_id = ? WHERE id = ?", [ids.owner, t]);
    expect((await call("owner", "POST", `/tickets/${t}/spam`, { block: "address" })).status).toBe(
      404,
    );
    expect(count("SELECT COUNT(*) AS n FROM mail_blocklist")).toBe(0);

    const ordinary = await ticketFrom("x@spam.example");
    db.run("UPDATE mail_tickets SET excluded_user_id = ? WHERE id = ?", [ids.admin, ordinary]);
    expect(
      (await call("admin", "POST", `/tickets/${ordinary}/spam`, { block: "none" })).status,
    ).toBe(404);
  });

  test("bad bodies and a purged ticket", async () => {
    const t = await ticketFrom("bad@spam.example");
    for (const body of [{}, { block: "ip" }, { block: "none", extra: 1 }]) {
      expect((await call("admin", "POST", `/tickets/${t}/spam`, body)).status).toBe(400);
    }
    db.run(
      "UPDATE mail_tickets SET purged_at = datetime('now'), requester_email = '' WHERE id = ?",
      [t],
    );
    const purged = await call("admin", "POST", `/tickets/${t}/spam`, { block: "address" });
    expect(purged.status).toBe(409);
    expect(purged.body.code).toBe("ticket_purged");
    expect((await call("admin", "POST", "/tickets/99999/spam", { block: "none" })).status).toBe(
      404,
    );
  });
});
