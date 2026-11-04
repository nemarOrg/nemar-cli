/**
 * Inbound mail to tickets (epic #1893 phase 3a): real postal-mime on real message text, real D1
 * (bun:sqlite behind realD1, every migration applied), real R2 (Miniflare) for reprocessing and
 * the Worker hookup. No mocks.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { handleInboundEmail } from "../src/services/inbound-mail";
import { TICKET_WORDS } from "../src/services/ticket-words";
import {
  type InboundTicketInput,
  type IngestOptions,
  TEXT_BODY_MAX_BYTES,
  aligned,
  extractMessageIds,
  ingestInboundMessage,
  isSpam,
  newTicketRef,
  parseAuthResults,
  reprocessRawKey,
  splitRecipient,
  ticketPlusTag,
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

function ingest(
  o: EmlOptions = {},
  to = "support@staging.nemar.test",
  at = new Date(),
  options?: IngestOptions,
) {
  n += 1;
  const input: InboundTicketInput = {
    rawKey: `inbound/raw/2026/10/24/test-${n}.eml`,
    raw: eml({ ...o, to: o.to ?? to }),
    envelopeFrom: "bounce@sender.example",
    envelopeTo: to,
    receivedAt: at,
  };
  return ingestInboundMessage(d1, input, options).then((r) => ({ ...r, rawKey: input.rawKey }));
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
  test("only a header with Cloudflare's authserv-id is read, whatever its position", () => {
    const ours = "mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail (p=reject)";
    const forged = "attacker.example; spf=pass; dkim=pass; dmarc=pass";
    const bad = { spf: "fail", dkim: "none", dmarc: "fail", alignedPass: false };
    expect(
      parseAuthResults([
        { key: "Authentication-Results", value: forged },
        { key: "Authentication-Results", value: ours },
      ]),
    ).toEqual(bad);
    expect(
      parseAuthResults([
        { key: "authentication-results", value: ours },
        { key: "Authentication-Results", value: forged },
      ]),
    ).toEqual(bad);
    // Not ours at all: nothing counts, so the message is spam.
    const none = parseAuthResults([{ key: "Authentication-Results", value: forged }]);
    expect(none).toEqual({ spf: "none", dkim: "none", dmarc: "none", alignedPass: false });
    expect(isSpam(none)).toBe(true);
    expect(parseAuthResults([]).dmarc).toBe("none");
    // A lookalike id does not match.
    expect(
      parseAuthResults([
        { key: "Authentication-Results", value: "xmx.cloudflare.net.evil; dmarc=pass" },
      ]).dmarc,
    ).toBe("none");
  });

  test("a dkim pass for another domain does not align with the From domain", () => {
    const hdr = (v: string) => [
      { key: "Authentication-Results", value: `mx.cloudflare.net; ${v}` },
    ];
    expect(
      parseAuthResults(hdr("dkim=pass header.d=other.example"), "ada@sender.example").alignedPass,
    ).toBe(false);
    expect(
      parseAuthResults(hdr("dkim=pass header.d=sender.example"), "ada@sender.example").alignedPass,
    ).toBe(true);
    expect(
      parseAuthResults(hdr("dkim=pass header.d=mail.sender.example"), "ada@sender.example")
        .alignedPass,
    ).toBe(true);
    expect(
      parseAuthResults(hdr("spf=pass smtp.mailfrom=bounce@other.example"), "ada@sender.example")
        .alignedPass,
    ).toBe(false);
    expect(
      parseAuthResults(hdr("spf=pass smtp.mailfrom=sender.example"), "ada@sender.example")
        .alignedPass,
    ).toBe(true);
    // No domain given, or only a helo name / header.i: cannot be shown to align, so unaligned.
    expect(parseAuthResults(hdr("dkim=pass"), "ada@sender.example").alignedPass).toBe(false);
    expect(
      parseAuthResults(hdr("dkim=pass header.i=@sender.example"), "ada@sender.example").alignedPass,
    ).toBe(false);
    expect(
      parseAuthResults(hdr("spf=pass smtp.helo=sender.example"), "ada@sender.example").alignedPass,
    ).toBe(false);
    // Siblings fail closed; a shared parent of one label or a hosting suffix never aligns.
    expect(aligned("a.sender.example", "b.sender.example")).toBe(false);
    expect(aligned("a.io", "b.io")).toBe(false);
    expect(aligned("io", "x.io")).toBe(false);
    expect(aligned("github.io", "alice.github.io")).toBe(false);
    expect(aligned("app.pages.dev", "pages.dev")).toBe(false);
    expect(aligned("mail.sender.example", "sender.example")).toBe(true);
    expect(aligned("sender.example", "sender.example")).toBe(true);
    expect(aligned("github.io", "github.io")).toBe(true);
    // A pass for one signature wins over a failing other one.
    const two = parseAuthResults(
      hdr("dkim=fail header.d=sender.example; dkim=pass header.d=sender.example"),
      "a@sender.example",
    );
    expect(two.dkim).toBe("pass");
  });

  test("spam unless dmarc passes, or dmarc did not fail and an aligned pass exists", () => {
    const a = (dmarc: string, alignedPass: boolean) => ({
      spf: "x",
      dkim: "x",
      dmarc,
      alignedPass,
    });
    expect(isSpam(a("pass", false))).toBe(false);
    expect(isSpam(a("fail", true))).toBe(true);
    expect(isSpam(a("none", true))).toBe(false);
    expect(isSpam(a("none", false))).toBe(true);
  });

  test("recipient split and message ids", () => {
    expect(splitRecipient("Support+T1abc@X.test")).toEqual({ base: "support", plus: "t1abc" });
    expect(splitRecipient("security@x.test")).toEqual({ base: "security", plus: "" });
    expect(extractMessageIds("<a@x>", "<b@x> <a@x>\r\n <c@x>")).toEqual([
      "<a@x>",
      "<b@x>",
      "<c@x>",
    ]);
  });
});

describe("ticket references", () => {
  test("three words from the committed list, joined by dashes", () => {
    const words = new Set(TICKET_WORDS);
    expect(TICKET_WORDS.length).toBe(1295);
    expect(words.size).toBe(TICKET_WORDS.length);
    for (const word of TICKET_WORDS) expect(word).toMatch(/^[a-z]+$/);
    for (let i = 0; i < 200; i++) {
      const ref = newTicketRef();
      expect(ref).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
      for (const word of ref.split("-")) expect(words.has(word)).toBe(true);
    }
  });

  test("every word is reachable and the choice is not obviously skewed", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 20000; i++) {
      for (const word of newTicketRef().split("-")) seen.set(word, (seen.get(word) ?? 0) + 1);
    }
    // 60,000 draws over 1,295 words: mean 46. A modulo-biased or stuck source falls outside this.
    expect(seen.size).toBeGreaterThan(1280);
    expect(Math.max(...seen.values())).toBeLessThan(120);
  });

  test("the plus tag is t-<ref> for a word ref and t<ref> for a legacy one", () => {
    expect(ticketPlusTag("amber-falcon-river")).toBe("t-amber-falcon-river");
    expect(ticketPlusTag("wphdw6vce6")).toBe("twphdw6vce6");
  });

  test("a legacy and a word ref both thread by their plus tag", async () => {
    for (const ref of ["wphdw6vce6", "amber-falcon-river"]) {
      db.run(
        "INSERT INTO mail_tickets (ref, queue_tag, requester_email, subject) VALUES (?, 'support', 'ada@sender.example', 'Help')",
        [ref],
      );
      const id = (db.query("SELECT id FROM mail_tickets WHERE ref = ?").get(ref) as { id: number })
        .id;
      const reply = await ingest(
        { subject: "Re: Help" },
        `support+${ticketPlusTag(ref)}@staging.nemar.test`,
      );
      expect([reply.outcome, reply.ticketId]).toEqual(["threaded", id]);
    }
  });

  test("a collision with an existing ticket retries with a fresh ref and stores everything once", async () => {
    db.run(
      "INSERT INTO mail_tickets (ref, queue_tag, requester_email, subject) VALUES ('amber-falcon-river', 'support', 'other@sender.example', 'Old')",
    );
    const offered: string[] = [];
    const queue = ["amber-falcon-river", "amber-falcon-river", "quiet-otter-lamp"];
    const created = await ingest({ subject: "Collide" }, "support@staging.nemar.test", new Date(), {
      newRef: () => {
        const ref = queue.shift() ?? "never-reached-here";
        offered.push(ref);
        return ref;
      },
    });
    expect(created.outcome).toBe("created");
    expect(offered).toEqual(["amber-falcon-river", "amber-falcon-river", "quiet-otter-lamp"]);
    const row = db.query("SELECT id, ref FROM mail_tickets WHERE id = ?").get(created.ticketId) as {
      id: number;
      ref: string;
    };
    expect(row.ref).toBe("quiet-otter-lamp");
    for (const table of ["mail_messages", "mail_ticket_events"]) {
      const n = db
        .query(`SELECT COUNT(*) AS n FROM ${table} WHERE ticket_id = ?`)
        .get(created.ticketId) as { n: number };
      expect(n.n).toBeGreaterThanOrEqual(1);
    }
    expect((db.query("SELECT COUNT(*) AS n FROM mail_messages").get() as { n: number }).n).toBe(1);
  });

  test("a collision that persists gives up after a bounded number of attempts", async () => {
    db.run(
      "INSERT INTO mail_tickets (ref, queue_tag, requester_email, subject) VALUES ('amber-falcon-river', 'support', 'other@sender.example', 'Old')",
    );
    let calls = 0;
    await expect(
      ingest({}, "support@staging.nemar.test", new Date(), {
        newRef: () => {
          calls++;
          return "amber-falcon-river";
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(5);
    expect((db.query("SELECT COUNT(*) AS n FROM mail_messages").get() as { n: number }).n).toBe(0);
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
    expect(t.ref).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
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
    const reply = await ingest(
      { subject: "Re: x" },
      `support+${ticketPlusTag(ref)}@staging.nemar.test`,
    );
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
        "SELECT detail FROM mail_ticket_events WHERE ticket_id = ? AND kind = 'reopened'",
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
      {
        auth: "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=fail",
        inReplyTo: "<s@sender.example>",
      },
      `support+${ticketPlusTag(ref)}@staging.nemar.test`,
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
      auth: "mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail",
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
    const noDmarc = await ingest({
      auth: "mx.cloudflare.net; spf=pass smtp.mailfrom=sender.example; dkim=pass header.d=sender.example",
      from: "ada@sender.example",
    });
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

const strangerAuth =
  "mx.cloudflare.net; spf=pass smtp.mailfrom=stranger.example; dkim=none; dmarc=none";
const strangerFrom = "Eve <eve@stranger.example>";
const createdDetail = (id: number) =>
  JSON.parse(
    db
      .query<{ detail: string }, [number]>(
        "SELECT detail FROM mail_ticket_events WHERE ticket_id = ? AND kind = 'created'",
      )
      .get(id)?.detail ?? "{}",
  ) as Record<string, unknown>;

describe("restriction is decided before threading and never fails open", () => {
  test("a security message with its queue row deleted is still restricted, in the security queue", async () => {
    db.run("DELETE FROM mail_queues WHERE tag = 'security'");
    const admin = seedUser(db, { role: "admin" });
    db.run("UPDATE mail_queues SET assignee_user_id = ? WHERE tag = '*'", [admin]);
    const r = await ingest({}, "security@staging.nemar.test");
    expect(ticket(r.ticketId)).toMatchObject({
      queue_tag: "security",
      restricted: 1,
      assignee_user_id: null,
    });
    const c = await ingest({}, "conduct@staging.nemar.test");
    expect(ticket(c.ticketId)).toMatchObject({ restricted: 1, assignee_user_id: null });
  });

  test("a restricted recipient never appends to an unrestricted ticket", async () => {
    const first = await ingest({ messageId: "<pub@sender.example>" });
    const ref = ticket(first.ticketId).ref as string;
    const viaRef = await ingest({}, `security+${ticketPlusTag(ref)}@staging.nemar.test`);
    expect(viaRef.outcome).toBe("created");
    expect(ticket(viaRef.ticketId)).toMatchObject({ restricted: 1, queue_tag: "security" });
    expect(createdDetail(viaRef.ticketId)).toMatchObject({
      matched_ticket_id: first.ticketId,
      reason: "restriction_mismatch",
    });
    const viaId = await ingest({ inReplyTo: "<pub@sender.example>" }, "conduct@staging.nemar.test");
    expect(viaId.outcome).toBe("created");
    expect(ticket(viaId.ticketId).restricted).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM mail_messages WHERE ticket_id = ?", first.ticketId),
    ).toBe(1);
  });

  test("an unrestricted recipient may append to a restricted ticket for its own requester", async () => {
    const first = await ingest({}, "security@staging.nemar.test");
    const ref = ticket(first.ticketId).ref as string;
    const reply = await ingest({}, `support+${ticketPlusTag(ref)}@staging.nemar.test`);
    expect(reply).toMatchObject({ outcome: "threaded", ticketId: first.ticketId });
    const stranger = await ingest(
      { from: strangerFrom, auth: strangerAuth },
      `support+${ticketPlusTag(ref)}@staging.nemar.test`,
    );
    expect(stranger.ticketId).not.toBe(first.ticketId);
  });
});

describe("threading needs the sender to be on the ticket", () => {
  test("a stranger with an SPF pass and no DMARC cannot thread by ref or by Message-ID", async () => {
    const first = await ingest({ messageId: "<own@sender.example>" });
    const ref = ticket(first.ticketId).ref as string;
    const byRef = await ingest(
      { from: strangerFrom, auth: strangerAuth },
      `support+${ticketPlusTag(ref)}@staging.nemar.test`,
    );
    expect(byRef.outcome).toBe("created");
    expect(createdDetail(byRef.ticketId)).toMatchObject({
      matched_ticket_id: first.ticketId,
      reason: "sender_not_on_ticket",
    });
    const byId = await ingest({
      from: strangerFrom,
      auth: strangerAuth,
      references: "<own@sender.example>",
    });
    expect(byId.outcome).toBe("created");
    expect(createdDetail(byId.ticketId).reason).toBe("sender_not_on_ticket");
    expect(
      count("SELECT COUNT(*) AS n FROM mail_messages WHERE ticket_id = ?", first.ticketId),
    ).toBe(1);
  });

  test("the requester, in any letter case, and an address already on the ticket can thread", async () => {
    const first = await ingest({ messageId: "<p@sender.example>" });
    const upper = await ingest({ from: "ADA@Sender.Example", inReplyTo: "<p@sender.example>" });
    expect(upper).toMatchObject({ outcome: "threaded", ticketId: first.ticketId });
    // A colleague added by an outgoing message (as phase 3b records a reply and its Cc).
    db.run(
      "INSERT INTO mail_messages (ticket_id, direction, from_addr, to_addr) VALUES (?, 'out', 'support@staging.nemar.test', 'colleague@sender.example')",
      [first.ticketId],
    );
    const colleague = await ingest({
      from: "colleague@sender.example",
      inReplyTo: "<p@sender.example>",
    });
    expect(colleague).toMatchObject({ outcome: "threaded", ticketId: first.ticketId });
  });

  test("the oldest holder of a Message-ID wins, and a repeat is stored without the id", async () => {
    const first = await ingest({ messageId: "<dup@sender.example>" });
    const copy = await ingest({
      from: strangerFrom,
      auth: strangerAuth,
      messageId: "<dup@sender.example>",
    });
    expect(copy.ticketId).not.toBe(first.ticketId);
    const stored = db
      .query<{ message_id: string | null }, [number]>(
        "SELECT message_id FROM mail_messages WHERE ticket_id = ?",
      )
      .get(copy.ticketId);
    expect(stored?.message_id).toBeNull();
    const reply = await ingest({ inReplyTo: "<dup@sender.example>" });
    expect(reply).toMatchObject({ outcome: "threaded", ticketId: first.ticketId });
  });

  test("a spam ticket is never threaded into", async () => {
    const spamTicket = await ingest({ auth: null, messageId: "<sp@sender.example>" });
    expect(spamTicket.status).toBe("spam");
    const ref = ticket(spamTicket.ticketId).ref as string;
    const reply = await ingest(
      { inReplyTo: "<sp@sender.example>" },
      `support+${ticketPlusTag(ref)}@staging.nemar.test`,
    );
    expect(reply.outcome).toBe("created");
    expect(reply.status).toBe("open");
    expect(createdDetail(reply.ticketId)).toMatchObject({
      matched_ticket_id: spamTicket.ticketId,
      reason: "candidate_is_spam",
    });
  });
});

describe("reopening", () => {
  test("a still-eligible assignee is kept", async () => {
    const admin = seedUser(db, { role: "admin" });
    db.run("UPDATE mail_queues SET assignee_user_id = ? WHERE tag = '*'", [admin]);
    const first = await ingest({ messageId: "<k@sender.example>" });
    db.run("UPDATE mail_tickets SET status = 'closed' WHERE id = ?", [first.ticketId]);
    const reply = await ingest({ inReplyTo: "<k@sender.example>" });
    expect(reply).toMatchObject({ status: "open", assigneeUserId: admin });
  });

  test("a released or demoted assignee is replaced through the queue, else the pool", async () => {
    const old = seedUser(db, { role: "admin" });
    const next = seedUser(db, { role: "admin" });
    db.run("UPDATE mail_queues SET assignee_user_id = ? WHERE tag = '*'", [old]);
    const first = await ingest({ messageId: "<d@sender.example>" });
    db.run("UPDATE mail_tickets SET status = 'closed' WHERE id = ?", [first.ticketId]);
    db.run("UPDATE users SET role = 'member' WHERE id = ?", [old]);
    db.run("UPDATE mail_queues SET assignee_user_id = ? WHERE tag = '*'", [next]);
    const reply = await ingest({ inReplyTo: "<d@sender.example>" });
    expect(reply).toMatchObject({ status: "open", assigneeUserId: next });
    expect(ticket(first.ticketId).assignee_user_id).toBe(next);
    const kinds = db
      .query<{ kind: string }, [number]>(
        "SELECT kind FROM mail_ticket_events WHERE ticket_id = ? ORDER BY id",
      )
      .all(first.ticketId)
      .map((e) => e.kind);
    expect(kinds).toEqual(["created", "assigned", "reopened", "assigned"]);

    // Closed again, the new holder is revoked and the queue has nobody: the pool.
    db.run("UPDATE mail_tickets SET status = 'closed' WHERE id = ?", [first.ticketId]);
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [next]);
    const again = await ingest({ inReplyTo: "<d@sender.example>" });
    expect(again).toMatchObject({ status: "open", assigneeUserId: null });
  });

  test("a restricted ticket whose holder is the excluded owner is not handed back to them", async () => {
    const excluded = seedUser(db, { role: "owner" });
    const other = seedUser(db, { role: "owner" });
    db.run(
      "UPDATE mail_queues SET strategy = 'fixed', assignee_user_id = ? WHERE tag = 'conduct'",
      [other],
    );
    const first = await ingest({ messageId: "<x@sender.example>" }, "conduct@staging.nemar.test");
    db.run(
      "UPDATE mail_tickets SET status = 'closed', assignee_user_id = ?, excluded_user_id = ? WHERE id = ?",
      [excluded, excluded, first.ticketId],
    );
    const reply = await ingest({ inReplyTo: "<x@sender.example>" }, "conduct@staging.nemar.test");
    expect(reply.assigneeUserId).toBe(other);
  });
});

describe("robustness", () => {
  test("two concurrent ingests of one raw key store it once and both report success", async () => {
    const input: InboundTicketInput = {
      rawKey: "inbound/raw/2026/10/24/race.eml",
      raw: eml(),
      envelopeFrom: "a@sender.example",
      envelopeTo: "support@staging.nemar.test",
      receivedAt: new Date(),
    };
    const [a, b] = await Promise.all([
      ingestInboundMessage(d1, input),
      ingestInboundMessage(d1, input),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["created", "duplicate"]);
    expect(a.ticketId).toBe(b.ticketId);
    expect(count("SELECT COUNT(*) AS n FROM mail_tickets")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM mail_messages")).toBe(1);
  });

  test("control characters in the subject are replaced before storing", async () => {
    const r = await ingest({ subject: "=?UTF-8?Q?a=0D=0Ab=00c=E2=80=A8d?=" });
    expect(ticket(r.ticketId).subject).toBe("a b c d");
  });

  test("script and style content never reaches the stored body", async () => {
    const r = await ingest({
      html: "<style>p{color:red}</style><script>steal()</script><p>Visible</p>",
    });
    const msg = db
      .query<{ text_body: string }, [number]>(
        "SELECT text_body FROM mail_messages WHERE ticket_id = ?",
      )
      .get(r.ticketId);
    expect(msg?.text_body).toBe("Visible");
  });
});

describe("final review hardening", () => {
  test("an spf pass on smtp.helo with no dmarc and a spoofed From is spam and cannot thread", async () => {
    const first = await ingest({ messageId: "<h@sender.example>" });
    const spoof = await ingest({
      from: "ada@sender.example",
      auth: "mx.cloudflare.net; spf=pass smtp.helo=attacker.example; dkim=none; dmarc=none",
      inReplyTo: "<h@sender.example>",
    });
    expect(spoof).toMatchObject({ outcome: "created", status: "spam" });
    expect(spoof.ticketId).not.toBe(first.ticketId);
  });

  test("a restricted ticket in an unrestricted queue reopens only to an owner or the pool", async () => {
    const admin = seedUser(db, { role: "admin" });
    const owner = seedUser(db, { role: "owner" });
    db.run("UPDATE mail_queues SET assignee_user_id = ? WHERE tag = '*'", [admin]);
    const first = await ingest({ messageId: "<rq@sender.example>" });
    db.run(
      "UPDATE mail_tickets SET restricted = 1, status = 'closed', assignee_user_id = NULL WHERE id = ?",
      [first.ticketId],
    );
    const pool = await ingest({ inReplyTo: "<rq@sender.example>" });
    expect(pool.assigneeUserId).toBeNull(); // the queue's admin is not an owner
    db.run("UPDATE mail_tickets SET status = 'closed' WHERE id = ?", [first.ticketId]);
    db.run("UPDATE mail_queues SET assignee_user_id = ? WHERE tag = '*'", [owner]);
    const owned = await ingest({ inReplyTo: "<rq@sender.example>" });
    expect(owned.assigneeUserId).toBe(owner);
  });

  test("an outgoing To recipient may thread but an inbound to_addr does not make a participant", async () => {
    const first = await ingest({ messageId: "<o@sender.example>" });
    // The inbound message's to_addr is our own address: sending From it is not enough.
    const ours = await ingest({
      from: "support@staging.nemar.test",
      auth: strangerAuth.replace("stranger.example", "staging.nemar.test"),
      inReplyTo: "<o@sender.example>",
    });
    expect(ours.ticketId).not.toBe(first.ticketId);
    db.run(
      "INSERT INTO mail_messages (ticket_id, direction, from_addr, to_addr) VALUES (?, 'note', 'a@x.example', 'noted@sender.example')",
      [first.ticketId],
    );
    const noted = await ingest({ from: "noted@sender.example", inReplyTo: "<o@sender.example>" });
    expect(noted.ticketId).not.toBe(first.ticketId);
  });

  test("a spam message is stored without its Message-ID", async () => {
    const bad = await ingest({ auth: null, messageId: "<forged@sender.example>" });
    const stored = db
      .query<{ message_id: string | null }, [number]>(
        "SELECT message_id FROM mail_messages WHERE ticket_id = ?",
      )
      .get(bad.ticketId);
    expect(stored?.message_id).toBeNull();
    const reply = await ingest({ inReplyTo: "<forged@sender.example>" });
    expect(reply.outcome).toBe("created");
    expect(createdDetail(reply.ticketId).matched_ticket_id).toBeUndefined();
  });

  test("two concurrent replies to a closed ticket write one reopened event", async () => {
    const first = await ingest({ messageId: "<cc@sender.example>" });
    db.run("UPDATE mail_tickets SET status = 'closed' WHERE id = ?", [first.ticketId]);
    await Promise.all([
      ingest({ inReplyTo: "<cc@sender.example>" }),
      ingest({ inReplyTo: "<cc@sender.example>" }),
    ]);
    expect(
      count("SELECT COUNT(*) AS n FROM mail_messages WHERE ticket_id = ?", first.ticketId),
    ).toBe(3);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM mail_ticket_events WHERE ticket_id = ? AND kind = 'reopened'",
        first.ticketId,
      ),
    ).toBe(1);
  });

  test("the stored to_addr is a single line", async () => {
    const r = await ingest({}, "support@staging.nemar.test");
    const raw = eml({ to: "support@staging.nemar.test" });
    const input: InboundTicketInput = {
      rawKey: "inbound/raw/2026/10/24/line.eml",
      raw,
      envelopeFrom: "a@sender.example",
      envelopeTo: "support@staging.nemar.test\r\nBcc: x@y.example",
      receivedAt: new Date(),
    };
    const out = await ingestInboundMessage(d1, input);
    const row = db
      .query<{ to_addr: string }, [number]>("SELECT to_addr FROM mail_messages WHERE ticket_id = ?")
      .get(out.ticketId);
    expect(row?.to_addr).not.toMatch(/[\r\n]/);
    expect(r.outcome).toBe("created");
  });
});
