/**
 * Support-ticket retention (epic #1893 phase 6a, ADR 0111): the summary route and the purge, through
 * the REAL admin router and its auth middleware against a real migrated database (bun:sqlite behind
 * realD1), with real R2 (Miniflare) for the reprocess check. Tokens are real API keys. No mocks.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { adminRoutes } from "../src/routes/admin";
import { purgeExpiredTickets, retentionDays } from "../src/services/ticket-retention";
import { ingestInboundMessage } from "../src/services/tickets";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { recordingBinding } from "./helpers/cloudflare-email";
import { freshDb, realD1 } from "./helpers/d1";
import { eml } from "./helpers/tickets";

const KEYS = {
  owner: "ret-owner-key-0123456789abcdef0123456789abcdef",
  owner2: "ret-owner2-key-0123456789abcdef0123456789abcdef",
  admin: "ret-admin-key-0123456789abcdef0123456789abcdef",
  agent: "ret-agent-key-0123456789abcdef0123456789abcdef",
};
type Who = keyof typeof KEYS;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ids: Record<Who, number>;
let bucket: R2Bucket;
let mf: Miniflare;
let retention: string | undefined;
let binding: ReturnType<typeof recordingBinding>;

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
    MAIL_RETENTION_DAYS: retention,
  } as Bindings;
}

async function seed(who: Who, role: "owner" | "admin", kind: "person" | "service" = "person") {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, signup_source,
                        email_verified, service_access, account_kind)
     VALUES (?, ?, 'x', ?, 'approved', ?, 'cli', 1, 0, ?)`,
    [`ret-${who}`, `ret-${who}@example.org`, `ret-${who}-gh`, role, kind],
  );
  const row = db.query("SELECT id FROM users WHERE username = ?").get(`ret-${who}`) as {
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
  retention = "730";
  binding = recordingBinding();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  ids = {
    owner: await seed("owner", "owner"),
    owner2: await seed("owner2", "owner"),
    admin: await seed("admin", "admin"),
    agent: await seed("agent", "admin", "service"),
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
    lastAt?: string;
  } = {},
): number {
  seq += 1;
  db.run(
    `INSERT INTO mail_tickets (ref, queue_tag, restricted, excluded_user_id, status, assignee_user_id,
        requester_email, requester_user_id, subject, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ada@sender.example', ?, 'Help with an upload', ?)`,
    [
      `bbbbbbbb${String.fromCharCode(97 + (Math.floor(seq / 26) % 26))}${String.fromCharCode(97 + (seq % 26))}`,
      o.queue ?? "support",
      o.restricted ? 1 : 0,
      o.excluded ?? null,
      o.status ?? "closed",
      o.assignee ?? null,
      ids.admin,
      o.lastAt ?? "2026-10-24 10:00:00",
    ],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}
const row = (id: number) =>
  db
    .query<Record<string, any>, [number]>("SELECT * FROM mail_tickets WHERE id = ?")
    .get(id) as Record<string, any>;
const events = (id: number) =>
  db
    .query<{ kind: string; actor_user_id: number | null; detail: string | null }, [number]>(
      "SELECT kind, actor_user_id, detail FROM mail_ticket_events WHERE ticket_id = ? ORDER BY id",
    )
    .all(id);
const count = (table: string, id: number) =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ticket_id = ?`).get(id) as { n: number }).n;

/** A ticket with every kind of thing a purge must remove, last active at `lastAt`. */
function fullTicket(lastAt: string, status = "closed"): number {
  const t = ticket({ status, lastAt, assignee: ids.admin, excluded: ids.owner2 });
  db.run(
    `INSERT INTO mail_messages (ticket_id, direction, message_id, from_addr, to_addr, subject, text_body, raw_key)
     VALUES (?, 'in', ?, 'ada@sender.example', 'support@nemar.org', 's', 'private words', ?)`,
    [
      t,
      `<m${t}@sender.example>`,
      `inbound/raw/2020/01/01/${String(t).padStart(8, "0")}-1111-4222-8333-444455556666.eml`,
    ],
  );
  db.run(
    `INSERT INTO mail_messages (ticket_id, direction, text_body, author_user_id) VALUES (?, 'note', 'a note', ?)`,
    [t, ids.admin],
  );
  db.run("INSERT INTO mail_reply_keys (ticket_id, idem_key, state) VALUES (?, 'k1', 'sent')", [t]);
  db.run(
    "INSERT INTO mail_ticket_tags (ticket_id, tag) VALUES (?, 'support'), (?, 'ada-private')",
    [t, t],
  );
  db.run(
    `INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail)
     VALUES (?, 'created', NULL, '{"queue":"support"}'), (?, 'assigned', ?, '{"to":7}'), (?, 'note', ?, NULL)`,
    [t, t, ids.admin, t, ids.admin],
  );
  return t;
}

describe("PUT /tickets/:id/summary", () => {
  test("stores the summary, its author and time, and an event with no text", async () => {
    const t = ticket();
    const r = await call("agent", "PUT", `/tickets/${t}/summary`, {
      summary: "  Upload failed on a large file; resolved by a retry.  ",
    });
    expect(r.status).toBe(200);
    expect(r.body.ticket.has_summary).toBe(true);
    expect(r.body.ticket.purged).toBe(false);
    const stored = row(t);
    expect(stored.summary).toBe("Upload failed on a large file; resolved by a retry.");
    expect(stored.summary_author_user_id).toBe(ids.agent);
    expect(stored.summarized_at).toBeTruthy();
    const ev = events(t).filter((e) => e.kind === "summary");
    expect(ev).toEqual([{ kind: "summary", actor_user_id: ids.agent, detail: null }]);
    const detail = await call("admin", "GET", `/tickets/${t}`);
    expect(detail.body.summary).toBe(stored.summary);
    expect(detail.body.summary_author_user_id).toBe(ids.agent);
    expect(detail.body.purged_at).toBeNull();
  });

  test("a later summary replaces the earlier one, and an open ticket may be summarized", async () => {
    const t = ticket({ status: "open" });
    await call("admin", "PUT", `/tickets/${t}/summary`, { summary: "first" });
    const r = await call("owner", "PUT", `/tickets/${t}/summary`, { summary: "second" });
    expect(r.status).toBe(200);
    expect(row(t).summary).toBe("second");
    expect(row(t).summary_author_user_id).toBe(ids.owner);
    expect(events(t).filter((e) => e.kind === "summary").length).toBe(2);
  });

  test("a summary with an email address is refused and nothing is stored", async () => {
    const t = ticket();
    for (const text of ["Contact ada@sender.example later", "mail a.b+c@lab.example.org"]) {
      const r = await call("admin", "PUT", `/tickets/${t}/summary`, { summary: text });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("summary_has_address");
    }
    expect(row(t).summary).toBeNull();
    expect(events(t)).toEqual([]);
  });

  test("length: 1 to 4000 after trim", async () => {
    const t = ticket();
    for (const bad of ["", "   ", "x".repeat(4001)]) {
      const r = await call("admin", "PUT", `/tickets/${t}/summary`, { summary: bad });
      expect([bad.length, r.status, r.body.code]).toEqual([bad.length, 400, "bad_request"]);
    }
    expect(
      (await call("admin", "PUT", `/tickets/${t}/summary`, { summary: "x".repeat(4000) })).status,
    ).toBe(200);
    expect(
      (await call("admin", "PUT", `/tickets/${t}/summary`, { summary: "a", extra: 1 })).status,
    ).toBe(400);
  });

  test("a restricted ticket: an owner may summarize it, an admin and the excluded owner get 404", async () => {
    const t = ticket({ queue: "conduct", restricted: true, excluded: ids.owner2 });
    for (const who of ["admin", "agent", "owner2"] as const) {
      const r = await call(who, "PUT", `/tickets/${t}/summary`, { summary: "x" });
      expect([who, r.status, r.body.code]).toEqual([who, 404, "not_found"]);
    }
    expect(row(t).summary).toBeNull();
    const ok = await call("owner", "PUT", `/tickets/${t}/summary`, {
      summary: "A conduct report was reviewed.",
    });
    expect(ok.status).toBe(200);
    expect(row(t).summary).toBe("A conduct report was reviewed.");
  });

  test("a missing ticket is 404 and a bad id is 404", async () => {
    expect((await call("admin", "PUT", "/tickets/99999/summary", { summary: "x" })).status).toBe(
      404,
    );
    expect((await call("admin", "PUT", "/tickets/abc/summary", { summary: "x" })).status).toBe(404);
  });

  test("a purged ticket is 409 ticket_purged", async () => {
    const t = ticket({ lastAt: "2020-01-01 00:00:00" });
    await purgeExpiredTickets(env(), new Date("2026-10-24T12:00:00Z"));
    const r = await call("owner", "PUT", `/tickets/${t}/summary`, { summary: "late" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ticket_purged");
  });
});

describe("GET /tickets?summary=missing and the new list fields", () => {
  test("lists closed, unpurged tickets with no summary, whatever the default status filter", async () => {
    const noSummary = ticket({ status: "closed" });
    const done = ticket({ status: "closed" });
    const open = ticket({ status: "open" });
    const gone = ticket({ status: "closed", lastAt: "2020-01-01 00:00:00" });
    await call("admin", "PUT", `/tickets/${done}/summary`, { summary: "done" });
    await purgeExpiredTickets(env(), new Date("2026-10-24T12:00:00Z"));
    const r = await call("admin", "GET", "/tickets?summary=missing");
    expect(r.status).toBe(200);
    expect(r.body.tickets.map((t: any) => t.id)).toEqual([noSummary]);
    // Without the filter the default hides closed tickets; with a status it shows them.
    const all = await call("admin", "GET", "/tickets?status=closed&limit=100");
    const byId = Object.fromEntries(all.body.tickets.map((t: any) => [t.id, t]));
    expect(byId[done].has_summary).toBe(true);
    expect(byId[noSummary].has_summary).toBe(false);
    expect(byId[gone].purged).toBe(true);
    expect(byId[noSummary].purged).toBe(false);
    expect((await call("admin", "GET", "/tickets")).body.tickets.map((t: any) => t.id)).toEqual([
      open,
    ]);
    expect((await call("admin", "GET", "/tickets?summary=other")).status).toBe(400);
  });

  test("the filter respects visibility: restricted closed tickets show to owners only", async () => {
    const t = ticket({ queue: "security", restricted: true });
    expect((await call("admin", "GET", "/tickets?summary=missing")).body.tickets).toEqual([]);
    expect(
      (await call("owner", "GET", "/tickets?summary=missing")).body.tickets.map((x: any) => x.id),
    ).toEqual([t]);
  });
});

describe("purgeExpiredTickets", () => {
  const NOW = new Date("2026-10-24T12:00:00Z");
  // 730 days before NOW.
  const CUTOFF = "2024-10-24 12:00:00";

  test("the cutoff is strict: one second older is purged, the cutoff itself and newer are not", async () => {
    const older = ticket({ lastAt: "2024-10-24 11:59:59" });
    const exact = ticket({ lastAt: CUTOFF });
    const newer = ticket({ lastAt: "2024-10-24 12:00:01" });
    const r = await purgeExpiredTickets(env(), NOW);
    expect(r).toMatchObject({ status: "ok", cutoff: CUTOFF, purged: 1 });
    expect(row(older).purged_at).toBeTruthy();
    expect(row(exact).purged_at).toBeNull();
    expect(row(newer).purged_at).toBeNull();
  });

  test("removes the raw record and clears the personal fields; keeps the summary and metadata", async () => {
    const t = fullTicket("2024-01-01 00:00:00");
    const keep = fullTicket("2026-10-01 00:00:00");
    await call("owner", "PUT", `/tickets/${t}/summary`, { summary: "Kept summary." });
    const before = row(t);
    const r = await purgeExpiredTickets(env(), NOW);
    expect(r).toMatchObject({ status: "ok", purged: 1, purgedOpen: 0 });

    expect(count("mail_messages", t)).toBe(0);
    expect(count("mail_reply_keys", t)).toBe(0);
    const tags = db
      .query<{ tag: string }, [number]>("SELECT tag FROM mail_ticket_tags WHERE ticket_id = ?")
      .all(t);
    expect(tags).toEqual([{ tag: "support" }]);

    const after = row(t);
    expect(after.requester_email).toBe("");
    expect(after.subject).toBe("");
    expect(after.requester_user_id).toBeNull();
    expect(after.excluded_user_id).toBeNull();
    expect(after.assignee_user_id).toBeNull();
    expect(after.status).toBe("closed");
    expect(after.purged_at).toBe("2026-10-24 12:00:00");
    expect(after.summary).toBe("Kept summary.");
    expect(after.summary_author_user_id).toBe(ids.owner);
    expect(after.summarized_at).toBe(before.summarized_at);
    expect(after.ref).toBe(before.ref);
    expect(after.queue_tag).toBe(before.queue_tag);
    expect(after.created_at).toBe(before.created_at);
    expect(after.last_message_at).toBe(before.last_message_at);

    const ev = events(t);
    expect(ev.map((e) => e.kind)).toEqual(["created", "assigned", "note", "summary", "purged"]);
    expect(ev.every((e) => e.detail === null)).toBe(true);
    expect(ev[1].actor_user_id).toBe(ids.admin);
    expect(ev[4].actor_user_id).toBeNull();

    // A ticket inside the window is untouched.
    expect(count("mail_messages", keep)).toBe(2);
    expect(row(keep).purged_at).toBeNull();
    expect(events(keep)[0].detail).toBe('{"queue":"support"}');
  });

  test("reads after a purge: kept fields, no messages, events without detail, purged_at", async () => {
    const t = fullTicket("2024-01-01 00:00:00");
    await purgeExpiredTickets(env(), NOW);
    const r = await call("owner", "GET", `/tickets/${t}`);
    expect(r.status).toBe(200);
    expect(r.body.messages).toEqual([]);
    expect(r.body.tags).toEqual(["support"]);
    expect(r.body.purged_at).toBe("2026-10-24 12:00:00");
    expect(r.body.ticket.purged).toBe(true);
    expect(r.body.ticket.requester_email).toBe("");
    expect(r.body.events.map((e: any) => e.detail)).toEqual([null, null, null, null]);
  });

  test("an open or pending ticket past the cutoff is purged too and counted separately", async () => {
    const a = ticket({ status: "open", lastAt: "2023-01-01 00:00:00" });
    const b = ticket({ status: "escalated", lastAt: "2023-01-01 00:00:00" });
    const c = ticket({ status: "closed", lastAt: "2023-01-01 00:00:00" });
    const d = ticket({ status: "spam", lastAt: "2023-01-01 00:00:00" });
    const r = await purgeExpiredTickets(env(), NOW);
    expect(r).toMatchObject({ status: "ok", purged: 4, purgedOpen: 2 });
    for (const id of [a, b, c, d]) expect(row(id).status).toBe("closed");
  });

  test("a restricted ticket stays restricted after the purge", async () => {
    const t = ticket({ queue: "security", restricted: true, lastAt: "2023-01-01 00:00:00" });
    await purgeExpiredTickets(env(), NOW);
    expect(row(t).restricted).toBe(1);
    expect((await call("admin", "GET", `/tickets/${t}`)).status).toBe(404);
    expect((await call("owner", "GET", `/tickets/${t}`)).status).toBe(200);
  });

  test("a re-run finds nothing and writes nothing", async () => {
    const t = fullTicket("2024-01-01 00:00:00");
    await purgeExpiredTickets(env(), NOW);
    const snapshot = JSON.stringify([row(t), events(t)]);
    const again = await purgeExpiredTickets(env(), new Date("2026-10-25T12:00:00Z"));
    expect(again).toMatchObject({ status: "ok", purged: 0, purgedOpen: 0 });
    expect(JSON.stringify([row(t), events(t)])).toBe(snapshot);
  });

  test("a missing or invalid MAIL_RETENTION_DAYS deletes nothing", async () => {
    const t = fullTicket("2000-01-01 00:00:00");
    for (const value of [undefined, "", "0", "-5", "abc", "30.5", " 30", "1e3", "99999", "0730"]) {
      retention = value;
      const r = await purgeExpiredTickets(env(), NOW);
      expect([value, r.status]).toEqual([value, "skipped"]);
    }
    expect(row(t).purged_at).toBeNull();
    expect(count("mail_messages", t)).toBe(2);
  });

  test("retentionDays accepts whole days from 1 to 36500 only", () => {
    expect(retentionDays({ MAIL_RETENTION_DAYS: "730" })).toBe(730);
    expect(retentionDays({ MAIL_RETENTION_DAYS: "30" })).toBe(30);
    expect(retentionDays({ MAIL_RETENTION_DAYS: "36500" })).toBe(36500);
    expect(retentionDays({ MAIL_RETENTION_DAYS: "36501" })).toBeNull();
    expect(retentionDays({})).toBeNull();
  });

  test("a run is bounded by its page size and page count, and the rest follows on the next run", async () => {
    const made = [1, 2, 3, 4, 5].map((i) => ticket({ lastAt: `2023-01-0${i} 00:00:00` }));
    const r1 = await purgeExpiredTickets(env(), NOW, { pageSize: 2, maxPages: 2 });
    expect(r1).toMatchObject({ purged: 4 });
    // Oldest first.
    expect(made.map((id) => row(id).purged_at !== null)).toEqual([true, true, true, true, false]);
    const r2 = await purgeExpiredTickets(env(), NOW, { pageSize: 2, maxPages: 2 });
    expect(r2).toMatchObject({ purged: 1 });
    expect(made.every((id) => row(id).purged_at !== null)).toBe(true);
  });

  test("a zero time budget starts no page", async () => {
    const t = ticket({ lastAt: "2023-01-01 00:00:00" });
    const r = await purgeExpiredTickets(env(), NOW, { budgetMs: 0 });
    expect(r).toMatchObject({ status: "ok", purged: 0 });
    expect(row(t).purged_at).toBeNull();
  });

  test("it sends no mail and touches no R2 object", async () => {
    const key = "inbound/raw/2020/01/01/aaaaaaaa-1111-4222-8333-444455556666.eml";
    await bucket.put(key, eml({ subject: "Old" }));
    const t = fullTicket("2020-01-01 00:00:00");
    await purgeExpiredTickets(env(), NOW);
    expect(row(t).purged_at).toBeTruthy();
    expect(await bucket.head(key)).not.toBeNull();
    expect(binding.sent.length).toBe(0);
  });
});

describe("a purged ticket is read-only", () => {
  test("reply, note, assign, status and escalate are 409 ticket_purged and change nothing", async () => {
    const t = fullTicket("2020-01-01 00:00:00");
    await purgeExpiredTickets(env(), new Date("2026-10-24T12:00:00Z"));
    const snapshot = JSON.stringify([row(t), events(t)]);
    const probes: [string, string, unknown?][] = [
      ["POST", `/tickets/${t}/reply`, { text: "hi" }],
      ["POST", `/tickets/${t}/note`, { text: "n" }],
      ["POST", `/tickets/${t}/assign`, { user_id: ids.owner }],
      ["POST", `/tickets/${t}/status`, { status: "open" }],
      ["POST", `/tickets/${t}/escalate`, {}],
    ];
    for (const [method, path, body] of probes) {
      const r = await call("owner", method, path, body);
      expect([path, r.status, r.body.code]).toEqual([path, 409, "ticket_purged"]);
    }
    expect(JSON.stringify([row(t), events(t)])).toBe(snapshot);
    expect(count("mail_messages", t)).toBe(0);
  });

  test("reprocess of a purged ticket's raw key refuses and does not rebuild it", async () => {
    const key = "inbound/raw/2020/01/01/0b9d8f3e-1111-4222-8333-444455556666.eml";
    await bucket.put(key, eml({ subject: "Old conversation" }), {
      customMetadata: {
        envelope_from: "ada@sender.example",
        envelope_to: "support@nemar.org",
        received_at: "2020-01-01T10:00:00.000Z",
      },
    });
    const made = await call("owner", "POST", "/reprocess", { raw_key: key });
    expect(made.status).toBe(200);
    db.run("UPDATE mail_tickets SET last_message_at = '2020-01-01 10:00:00' WHERE id = ?", [
      made.body.ticket_id,
    ]);
    await purgeExpiredTickets(env(), new Date("2026-10-24T12:00:00Z"));
    const tickets = (db.query("SELECT COUNT(*) AS n FROM mail_tickets").get() as { n: number }).n;
    const again = await call("owner", "POST", "/reprocess", { raw_key: key });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ticket_purged");
    expect((db.query("SELECT COUNT(*) AS n FROM mail_tickets").get() as { n: number }).n).toBe(
      tickets,
    );
    expect(count("mail_messages", made.body.ticket_id)).toBe(0);
  });
});

describe("inbound mail after a purge", () => {
  test("a message to a purged ticket's plus address opens a new ticket and records why", async () => {
    const t = ticket({ lastAt: "2020-01-01 00:00:00" });
    const ref = row(t).ref as string;
    await purgeExpiredTickets(env(), new Date("2026-10-24T12:00:00Z"));
    const result = await ingestInboundMessage(realD1(db), {
      rawKey: "inbound/raw/2026/10/24/3c9d8f3e-1111-4222-8333-444455556666.eml",
      raw: eml({ from: "ada@sender.example", to: `support+t${ref}@nemar.org`, subject: "Again" }),
      envelopeFrom: "ada@sender.example",
      envelopeTo: `support+t${ref}@nemar.org`,
      receivedAt: new Date("2026-10-24T12:00:00Z"),
    });
    expect(result.outcome).toBe("created");
    expect(result.ticketId).not.toBe(t);
    expect(count("mail_messages", t)).toBe(0);
    const created = events(result.ticketId)[0];
    expect(JSON.parse(created.detail ?? "{}")).toMatchObject({
      matched_ticket_id: t,
      reason: "candidate_purged",
    });
  });
});
