/**
 * Inbound mail to tickets (epic #1893 phase 3a): real postal-mime on real message text, real D1
 * (bun:sqlite behind realD1, every migration applied), real R2 (Miniflare) for reprocessing and
 * the Worker hookup. No mocks.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { handleInboundEmail } from "../src/services/inbound-mail";
import {
  type InboundTicketInput,
  TEXT_BODY_MAX_BYTES,
  extractMessageIds,
  ingestInboundMessage,
  isSpam,
  newTicketRef,
  parseAuthResults,
  reprocessRawKey,
  splitRecipient,
} from "../src/services/tickets";
import { freshDb, realD1 } from "./helpers/d1";
import { type EmlOptions, eml, seedUser } from "./helpers/tickets";

let db: Database;
let d1: D1Database;
let n = 0;

beforeEach(() => {
  db = freshDb();
  d1 = realD1(db);
});

function ingest(o: EmlOptions = {}, to = "support@staging.nemar.test", at = new Date()) {
  n += 1;
  const input: InboundTicketInput = {
    rawKey: `inbound/raw/2026/10/24/test-${n}.eml`,
    raw: eml({ ...o, to: o.to ?? to }),
    envelopeFrom: "bounce@sender.example",
    envelopeTo: to,
    receivedAt: at,
  };
  return ingestInboundMessage(d1, input).then((r) => ({ ...r, rawKey: input.rawKey }));
}

const ticket = (id: number) =>
  db
    .query<Record<string, unknown>, [number]>("SELECT * FROM mail_tickets WHERE id = ?")
    .get(id) as Record<string, unknown>;
const tagsOf = (id: number) =>
  db
    .query<{ tag: string }, [number]>(
      "SELECT tag FROM mail_ticket_tags WHERE ticket_id = ? ORDER BY tag",
    )
    .all(id)
    .map((r) => r.tag);
const count = (sql: string, ...p: unknown[]) =>
  (db.query<{ n: number }, never[]>(sql).get(...(p as never[])) as { n: number }).n;

describe("pure helpers", () => {
  test("auth results come from the topmost header only", () => {
    const top = parseAuthResults([
      { key: "Authentication-Results", value: "mx; spf=fail; dkim=none; dmarc=fail (p=reject)" },
      { key: "authentication-results", value: "forged; spf=pass; dkim=pass; dmarc=pass" },
    ]);
    expect(top).toEqual({ spf: "fail", dkim: "none", dmarc: "fail" });
    expect(parseAuthResults([])).toEqual({ spf: "none", dkim: "none", dmarc: "none" });
    expect(
      parseAuthResults([{ key: "Authentication-Results", value: "mx; dkim=fail; dkim=pass" }]).dkim,
    ).toBe("pass");
  });

  test("spam is a dmarc fail or no passing mechanism", () => {
    expect(isSpam({ spf: "pass", dkim: "pass", dmarc: "fail" })).toBe(true);
    expect(isSpam({ spf: "none", dkim: "none", dmarc: "none" })).toBe(true);
    expect(isSpam({ spf: "fail", dkim: "fail", dmarc: "none" })).toBe(true);
    expect(isSpam({ spf: "pass", dkim: "none", dmarc: "none" })).toBe(false);
    expect(isSpam({ spf: "none", dkim: "pass", dmarc: "none" })).toBe(false);
  });

  test("recipient split and message ids", () => {
    expect(splitRecipient("Support+T1abc@X.test")).toEqual({ base: "support", plus: "t1abc" });
    expect(splitRecipient("security@x.test")).toEqual({ base: "security", plus: "" });
    expect(extractMessageIds("<a@x>", "<b@x> <a@x>\r\n <c@x>")).toEqual([
      "<a@x>",
      "<b@x>",
      "<c@x>",
    ]);
    expect(newTicketRef()).toMatch(/^[a-z2-7]{10}$/);
  });
});

describe("a new ticket", () => {
  test("lands in the queue, with message, tags and a created event", async () => {
    const admin = seedUser(db, { role: "admin" });
    db.run("UPDATE mail_queues SET assignee_user_id = ? WHERE tag = '*'", [admin]);
    db.run(
      "INSERT INTO mail_queues (tag, strategy, assignee_user_id) VALUES ('support', 'fixed', ?)",
      [admin],
    );
    const r = await ingest({ subject: "Help", body: "Please help." });
    expect(r.outcome).toBe("created");
    expect(r.assigneeUserId).toBe(admin);
    const t = ticket(r.ticketId);
    expect(t).toMatchObject({
      queue_tag: "support",
      status: "open",
      restricted: 0,
      requester_email: "ada@sender.example",
      subject: "Help",
      assignee_user_id: admin,
    });
    expect(t.ref).toMatch(/^[a-z2-7]{10}$/);
    const msg = db
      .query<Record<string, string>, [number]>("SELECT * FROM mail_messages WHERE ticket_id = ?")
      .get(r.ticketId);
    expect(msg).toMatchObject({
      direction: "in",
      text_body: "Please help.",
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      to_addr: "support@staging.nemar.test",
    });
    expect(tagsOf(r.ticketId)).toEqual(["support"]);
    const kinds = db
      .query<{ kind: string }, [number]>(
        "SELECT kind FROM mail_ticket_events WHERE ticket_id = ? ORDER BY id",
      )
      .all(r.ticketId)
      .map((e) => e.kind);
    expect(kinds).toEqual(["created", "assigned"]);
  });

  test("an unknown local part goes to the fallback queue and keeps its tag", async () => {
    const r = await ingest({}, "billing@staging.nemar.test");
    expect(ticket(r.ticketId).queue_tag).toBe("*");
    expect(tagsOf(r.ticketId)).toEqual(["billing"]);
  });

  test("a plus tag that is not a ticket ref becomes a tag", async () => {
    const r = await ingest({}, "support+datasets@staging.nemar.test");
    expect(tagsOf(r.ticketId)).toEqual(["datasets", "support"]);
  });

  test("a restricted queue marks the ticket restricted and assigns only an owner", async () => {
    const admin = seedUser(db, { role: "admin" });
    const owner = seedUser(db, { role: "owner" });
    db.run(
      "UPDATE mail_queues SET strategy = 'round_robin', rr_members = ? WHERE tag = 'security'",
      [JSON.stringify([admin, owner])],
    );
    const r = await ingest({}, "security@staging.nemar.test");
    expect(ticket(r.ticketId)).toMatchObject({
      restricted: 1,
      queue_tag: "security",
      assignee_user_id: owner,
    });
  });

  test("an html-only body is converted to text", async () => {
    const r = await ingest({ html: "<p>Hello <b>there</b></p><p>Second</p>" });
    const msg = db
      .query<{ text_body: string }, [number]>(
        "SELECT text_body FROM mail_messages WHERE ticket_id = ?",
      )
      .get(r.ticketId);
    expect(msg?.text_body).toContain("Hello there");
    expect(msg?.text_body).toContain("Second");
    expect(msg?.text_body).not.toContain("<");
  });

  test("the body is clamped to 64 KiB of UTF-8", async () => {
    const r = await ingest({ body: "é".repeat(60_000) });
    const msg = db
      .query<{ text_body: string }, [number]>(
        "SELECT text_body FROM mail_messages WHERE ticket_id = ?",
      )
      .get(r.ticketId);
    expect(new TextEncoder().encode(msg?.text_body ?? "").byteLength).toBeLessThanOrEqual(
      TEXT_BODY_MAX_BYTES,
    );
    expect(msg?.text_body).not.toContain("�");
  });
});

describe("threading", () => {
  test("by the plus ref of the recipient, whatever the headers say", async () => {
    const first = await ingest();
    const ref = ticket(first.ticketId).ref as string;
    const reply = await ingest({ subject: "Re: x" }, `support+t${ref}@staging.nemar.test`);
    expect(reply.outcome).toBe("threaded");
    expect(reply.ticketId).toBe(first.ticketId);
    expect(
      count("SELECT COUNT(*) AS n FROM mail_messages WHERE ticket_id = ?", first.ticketId),
    ).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM mail_tickets")).toBe(1);
    // The ref is not a tag.
    expect(tagsOf(first.ticketId)).toEqual(["support"]);
  });

  test("by In-Reply-To", async () => {
    const first = await ingest({ messageId: "<orig@sender.example>" });
    const reply = await ingest({ inReplyTo: "<orig@sender.example>" });
    expect(reply).toMatchObject({ outcome: "threaded", ticketId: first.ticketId });
  });

  test("by References, the latest matching message wins", async () => {
    const a = await ingest({ messageId: "<a@sender.example>" });
    const b = await ingest({ messageId: "<b@sender.example>", subject: "other" });
    expect(b.ticketId).not.toBe(a.ticketId);
    const reply = await ingest({ references: "<zzz@sender.example> <a@sender.example>" });
    expect(reply).toMatchObject({ outcome: "threaded", ticketId: a.ticketId });
  });

  test("a ref-shaped plus tag that matches no ticket opens a new one without tagging it", async () => {
    const r = await ingest({}, "support+tabcdefghij@staging.nemar.test");
    expect(r.outcome).toBe("created");
    expect(tagsOf(r.ticketId)).toEqual(["support"]);
  });

  test("a reply to a closed ticket reopens it and records an event", async () => {
    const first = await ingest({ messageId: "<c@sender.example>" });
    db.run("UPDATE mail_tickets SET status = 'closed' WHERE id = ?", [first.ticketId]);
    const reply = await ingest({ inReplyTo: "<c@sender.example>" });
    expect(reply.status).toBe("open");
    expect(ticket(first.ticketId).status).toBe("open");
    const ev = db
      .query<{ detail: string }, [number]>(
        "SELECT detail FROM mail_ticket_events WHERE ticket_id = ? AND kind = 'status'",
      )
      .get(first.ticketId);
    expect(JSON.parse(ev?.detail ?? "{}")).toEqual({ from: "closed", to: "open", reason: "reply" });
  });

  test("an escalated ticket keeps its status when the requester replies", async () => {
    const first = await ingest({ messageId: "<e@sender.example>" });
    db.run("UPDATE mail_tickets SET status = 'escalated' WHERE id = ?", [first.ticketId]);
    await ingest({ inReplyTo: "<e@sender.example>" });
    expect(ticket(first.ticketId).status).toBe("escalated");
  });
});

describe("spam", () => {
  test("a dmarc failure is kept as spam, unassigned, and never threaded", async () => {
    const admin = seedUser(db, { role: "admin" });
    db.run("UPDATE mail_queues SET assignee_user_id = ? WHERE tag = '*'", [admin]);
    const first = await ingest({ messageId: "<s@sender.example>" });
    const ref = ticket(first.ticketId).ref as string;
    const bad = await ingest(
      { auth: "mx; spf=pass; dkim=pass; dmarc=fail", inReplyTo: "<s@sender.example>" },
      `support+t${ref}@staging.nemar.test`,
    );
    expect(bad).toMatchObject({
      outcome: "created",
      status: "spam",
      spam: true,
      assigneeUserId: null,
    });
    expect(bad.ticketId).not.toBe(first.ticketId);
    expect(
      count("SELECT COUNT(*) AS n FROM mail_messages WHERE ticket_id = ?", first.ticketId),
    ).toBe(1);
  });

  test("no authentication at all is spam", async () => {
    const r = await ingest({ auth: null });
    expect(r.status).toBe("spam");
    expect(ticket(r.ticketId).assignee_user_id).toBeNull();
  });

  test("a forged lower Authentication-Results header does not rescue a failing message", async () => {
    const r = await ingest({
      auth: "mx; spf=fail; dkim=none; dmarc=fail",
      extraHeaders: ["Authentication-Results: forged; spf=pass; dkim=pass; dmarc=pass"],
    });
    expect(r.status).toBe("spam");
  });
});

describe("account link", () => {
  test("set only when dmarc passes and the address is a verified or approved live account", async () => {
    const user = seedUser(db, { role: "member", email: "Ada@Sender.Example" });
    const linked = await ingest({ from: "ada@sender.example" });
    expect(ticket(linked.ticketId).requester_user_id).toBe(user);

    // spf and dkim pass but dmarc does not: not linked.
    const noDmarc = await ingest({ auth: "mx; spf=pass; dkim=pass", from: "ada@sender.example" });
    expect(ticket(noDmarc.ticketId).requester_user_id).toBeNull();
    expect(noDmarc.status).toBe("open");
  });

  test("a pending, revoked or deleted account is not linked", async () => {
    seedUser(db, { role: "member", status: "pending", email: "pending@sender.example" });
    seedUser(db, { role: "member", status: "revoked", email: "revoked@sender.example" });
    const gone = seedUser(db, { role: "member", email: "gone@sender.example" });
    db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [gone]);
    for (const addr of ["pending", "revoked", "gone"]) {
      const r = await ingest({ from: `${addr}@sender.example` });
      expect(ticket(r.ticketId).requester_user_id).toBeNull();
    }
  });
});

describe("idempotence", () => {
  test("the same raw key is stored once", async () => {
    const input: InboundTicketInput = {
      rawKey: "inbound/raw/2026/10/24/once.eml",
      raw: eml(),
      envelopeFrom: "a@sender.example",
      envelopeTo: "support@staging.nemar.test",
      receivedAt: new Date(),
    };
    const a = await ingestInboundMessage(d1, input);
    const b = await ingestInboundMessage(d1, input);
    expect(a.outcome).toBe("created");
    expect(b).toMatchObject({ outcome: "duplicate", ticketId: a.ticketId });
    expect(count("SELECT COUNT(*) AS n FROM mail_tickets")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM mail_messages")).toBe(1);
  });

  test("a threaded message processed twice is stored once", async () => {
    const first = await ingest({ messageId: "<t@sender.example>" });
    const input: InboundTicketInput = {
      rawKey: "inbound/raw/2026/10/24/twice.eml",
      raw: eml({ inReplyTo: "<t@sender.example>" }),
      envelopeFrom: "a@sender.example",
      envelopeTo: "support@staging.nemar.test",
      receivedAt: new Date(),
    };
    await ingestInboundMessage(d1, input);
    expect((await ingestInboundMessage(d1, input)).outcome).toBe("duplicate");
    expect(
      count("SELECT COUNT(*) AS n FROM mail_messages WHERE ticket_id = ?", first.ticketId),
    ).toBe(2);
  });
});

describe("the Worker hookup and reprocess, against real R2", () => {
  let mf: Miniflare;
  let bucket: R2Bucket;
  beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: "export default {}", r2Buckets: ["MAIL_INBOUND"] });
    bucket = (await mf.getR2Bucket("MAIL_INBOUND")) as unknown as R2Bucket;
  });
  afterAll(async () => {
    await mf?.dispose();
  }, 30_000);

  function platform(raw: Uint8Array, from: string, to: string): ForwardableEmailMessage {
    return {
      from,
      to,
      headers: new Headers(),
      rawSize: raw.byteLength,
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
      setReject: () => {},
    } as unknown as ForwardableEmailMessage;
  }

  test("handleInboundEmail stores the raw object and creates the ticket", async () => {
    await handleInboundEmail(
      platform(eml({ subject: "Via worker" }), "a@sender.example", "support@staging.nemar.test"),
      {
        MAIL_INBOUND: bucket,
        DB: d1,
      },
    );
    const row = db
      .query<{ raw_key: string; subject: string }, []>(
        "SELECT m.raw_key, t.subject FROM mail_messages m JOIN mail_tickets t ON t.id = m.ticket_id",
      )
      .get();
    expect(row?.subject).toBe("Via worker");
    expect(await bucket.head(row?.raw_key ?? "")).not.toBeNull();
  });

  test("a ticketing failure leaves the raw object and does not throw", async () => {
    db.run("DROP TABLE mail_messages");
    const before = new Set(
      (await bucket.list({ prefix: "inbound/raw/" })).objects.map((o) => o.key),
    );
    const logged: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => {
      logged.push(a.join(" "));
    };
    try {
      await handleInboundEmail(
        platform(eml(), "secret-sender@sender.example", "support@staging.nemar.test"),
        {
          MAIL_INBOUND: bucket,
          DB: d1,
        },
      );
    } finally {
      console.error = original;
    }
    const added = (await bucket.list({ prefix: "inbound/raw/" })).objects.filter(
      (o) => !before.has(o.key),
    );
    expect(added).toHaveLength(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(added[0].key);
    expect(logged[0]).not.toContain("secret-sender@sender.example");
  });

  test("reprocess rebuilds a ticket from a stored object, once", async () => {
    const raw = eml({ subject: "Rebuild me" });
    await bucket.put("inbound/raw/2026/10/24/rebuild.eml", raw, {
      customMetadata: {
        envelope_from: "a@sender.example",
        envelope_to: "support@staging.nemar.test",
        received_at: "2026-10-24T10:00:00.000Z",
      },
    });
    const first = await reprocessRawKey(d1, bucket, "inbound/raw/2026/10/24/rebuild.eml");
    expect(first.outcome).toBe("created");
    const again = await reprocessRawKey(d1, bucket, "inbound/raw/2026/10/24/rebuild.eml");
    expect(again.outcome).toBe("duplicate");
    expect(count("SELECT COUNT(*) AS n FROM mail_tickets")).toBe(1);
    expect((await reprocessRawKey(d1, bucket, "inbound/raw/none.eml")).outcome).toBe("missing");
    const created = db
      .query<{ created_at: string }, []>("SELECT created_at FROM mail_messages")
      .get();
    expect(created?.created_at).toBe("2026-10-24 10:00:00");
  });

  test("garbage bytes do not throw out of the hookup", async () => {
    const fresh = freshDb();
    await handleInboundEmail(
      platform(
        new Uint8Array([0, 1, 2, 255, 254]),
        "a@sender.example",
        "support@staging.nemar.test",
      ),
      {
        MAIL_INBOUND: bucket,
        DB: realD1(fresh),
      },
    );
  });
});
