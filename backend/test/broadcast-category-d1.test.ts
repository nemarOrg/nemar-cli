/**
 * Category broadcasts (epic #2260 phase 3, ADR 0132): `POST /admin/notify` with a category, the outbox
 * producer, the consumer, and the P2 unsubscribe route, all real, over the real migrated schema.
 * The only stand-ins are the two external boundaries: the `send_email` binding (a recorder that, like
 * the real service, refuses a header Cloudflare does not allow) and the Queue binding.
 *
 * What it holds: each recipient's footer and headers are their own and the link verifies against P2's
 * route (a one-click POST of the very URL in the message changes that account's preference); the
 * preference is re-read immediately before each send, so an opt-out between queueing and sending is a
 * `skipped` outcome, counted, and the row still reaches `done`; a recall is owner-only, needs a
 * reference, a prefix, two headings and a typed confirmation, ignores preferences, reaches revoked
 * accounts, carries no unsubscribe link or header, and publishes a site notice; an unusable
 * MAIL_LINK_SECRET refuses a non-recall before anything is written; the delivery fence applies at
 * enqueue and at send; a dry run returns no addresses outside production; a duplicate send is refused.
 *
 * MUTATIONS (each applied, run, and seen to fail a test below): the consumer's preference re-check is
 * removed; the footer link is signed for another account; the recall refusal for an admin is dropped;
 * the secret check is removed from categorizedSendBlockers; the dry run returns recipients in any
 * environment; communityRecipients widened to `pending`; the footer's List-Unsubscribe header is dropped.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import worker from "../src/index";
import { adminRoutes } from "../src/routes/admin";
import { MailHeaderError, validateMailHeaders } from "../src/services/email";
import { type OutboxEnv, handleOutboxBatch } from "../src/services/email-outbox";
import { __resetMailLinkReportsForTests } from "../src/services/mail-links";
import { saveEmailPreferences } from "../src/services/mail-preferences";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { type BindingMessage, recordingBinding } from "./helpers/cloudflare-email";
import { freshDb, realD1 } from "./helpers/d1";
import { recordingBatch, recordingQueue } from "./helpers/queue-binding";

const OWNER_KEY = "category-owner-key-0123456789abcdef0123456789";
const ADMIN_KEY = "category-admin-key-0123456789abcdef0123456789";
const SECRET = "k".repeat(64);
const API = "https://api-test.nemar.test";
const POSTAL =
  "Swartz Center for Computational Neuroscience, University of California San Diego, 9836 Hopkins Dr, La Jolla, CA 92093";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function seedUser(
  username: string,
  opts: {
    role?: "owner" | "admin" | "member";
    status?: string;
    prefs?: string | null;
    email?: string;
  } = {},
): number {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, email_preferences)
     VALUES (?, ?, 'x', ?, ?, 1, 1, ?)`,
  ).run(
    username,
    opts.email ?? `${username}@nemar.test`,
    opts.status ?? "approved",
    opts.role ?? "member",
    opts.prefs ?? null,
  );
  const id = (
    db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username) as {
      id: number;
    }
  ).id;
  return id;
}

async function seedKeyed(username: string, role: "owner" | "admin", key: string) {
  const id = seedUser(username, { role });
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return id;
}

interface Harness {
  env: Bindings;
  sent: BindingMessage[];
  queue: ReturnType<typeof recordingQueue>;
}

function harness(overrides: Record<string, unknown> = {}): Harness {
  const { binding, sent } = recordingBinding();
  const queue = recordingQueue();
  const env = {
    DB: realD1(db),
    ENVIRONMENT: "development",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: binding,
    EMAIL_OUTBOX: queue.queue,
    FROM_EMAIL: "NEMAR Staging <noreply@staging.nemar.test>",
    API_BASE_URL: API,
    APP_BASE_URL: "https://test.nemar.test",
    MAIL_LINK_SECRET: SECRET,
    ...overrides,
  } as unknown as Bindings;
  return { env, sent, queue };
}

let ownerId: number;
let alice: number;
let bob: number;

beforeEach(async () => {
  __resetMailLinkReportsForTests();
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  ownerId = await seedKeyed("catowner", "owner", OWNER_KEY);
  await seedKeyed("cataadmin", "admin", ADMIN_KEY);
  alice = seedUser("alice");
  bob = seedUser("bob");
});

const post = (key: string, payload: Record<string, unknown>, h: Harness) =>
  app.request(
    "/admin/notify",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    h.env,
  );

const NEWS = { to: "all", category: "news", subject: "Monthly news", body: "Hello **all**" };
const RECALL_BODY = "## What is affected\n\nnm000104 v1.0.0.\n\n## What to do\n\nDelete your copy.";

async function consume(h: Harness, bodies: unknown[] = h.queue.bodies, attempts = 1) {
  const { batch, recorded } = recordingBatch(bodies, attempts);
  const quiet = { e: console.error, w: console.warn };
  console.error = () => {};
  console.warn = () => {};
  try {
    await handleOutboxBatch(batch.messages as never, h.env as unknown as OutboxEnv);
  } finally {
    console.error = quiet.e;
    console.warn = quiet.w;
  }
  return recorded;
}

const rowOf = (id: number) =>
  db
    .query<
      {
        status: string;
        category: string | null;
        recall_reference: string | null;
        queued_count: number;
        delivered_count: number;
        skipped_count: number;
        failure_count: number;
        subject: string;
      },
      [number]
    >("SELECT * FROM broadcast_emails WHERE id = ?")
    .get(id);

const noRows = () =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM broadcast_emails").get()?.n;

/** The unsubscribe URL a message carries in its `List-Unsubscribe` header. */
const headerUrl = (m: BindingMessage): string =>
  /^<(.+)>$/.exec(m.headers?.["List-Unsubscribe"] ?? "")?.[1] ?? "";

/** Every href in the message body. */
const hrefs = (m: BindingMessage): string[] =>
  [...(m.html ?? "").matchAll(/href="([^"]+)"/g)].map((x) => x[1] as string);

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const prefsOf = (id: number) =>
  JSON.parse(
    db
      .query<{ email_preferences: string | null }, [number]>(
        "SELECT email_preferences FROM users WHERE id = ?",
      )
      .get(id)?.email_preferences ?? "{}",
  ) as Record<string, unknown>;

describe("each recipient's footer and headers are their own", () => {
  test("exact headers, a visible footer link equal to the header URL, the address, the preferences link", async () => {
    const h = harness();
    const res = await post(ADMIN_KEY, NEWS, h);
    expect(res.status).toBe(200);
    const result = (await res.json()) as { broadcast_id: number; category: string };
    expect(result.category).toBe("news");
    await consume(h);

    const toAlice = h.sent.find((m) => m.to === "alice@nemar.test") as BindingMessage;
    const url = headerUrl(toAlice);
    expect(url).toStartWith(`${API}/mail/unsubscribe/v1.${alice}.news.${result.broadcast_id}.`);
    expect(toAlice.headers).toEqual({
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(hrefs(toAlice)).toContain(url);
    expect(hrefs(toAlice)).toContain("https://test.nemar.test/settings");
    expect(toAlice.html).toContain("Unsubscribe from News mail");
    expect(toAlice.html).toContain(POSTAL);
    expect(toAlice.html).toContain("News mail is turned on for it");
    expect(toAlice.html).toContain("<strong>all</strong>");
  });

  test("two recipients get two different links, each for its own account", async () => {
    const h = harness();
    await post(ADMIN_KEY, NEWS, h);
    await consume(h);
    const urls = new Map(h.sent.map((m) => [m.to, headerUrl(m)]));
    expect(urls.size).toBe(4);
    expect(new Set(urls.values()).size).toBe(4);
    expect(urls.get("alice@nemar.test")).toContain(`/v1.${alice}.news.`);
    expect(urls.get("bob@nemar.test")).toContain(`/v1.${bob}.news.`);
  });

  test("the link in the message verifies against P2's route: a one-click POST turns that account's category off", async () => {
    const h = harness();
    await post(ADMIN_KEY, NEWS, h);
    await consume(h);
    const toBob = h.sent.find((m) => m.to === "bob@nemar.test") as BindingMessage;
    const path = new URL(headerUrl(toBob)).pathname;

    const res = await worker.fetch(
      new Request(`${API}${path}`, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      h.env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "unsubscribed", category: "news" });
    expect(prefsOf(bob)).toMatchObject({ news: false });
    expect(prefsOf(alice).news).not.toBe(false);
  });

  test("the broadcast row carries its category, so P2's tokens verify", async () => {
    const h = harness();
    const result = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { broadcast_id: number };
    expect(rowOf(result.broadcast_id)).toMatchObject({
      category: "news",
      recall_reference: null,
      queued_count: 4,
    });
  });

  test("a recipient who turned the category off is never queued", async () => {
    db.query("UPDATE users SET email_preferences = '{\"news\":false}' WHERE id = ?").run(bob);
    const h = harness();
    const result = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { recipient_count: number };
    expect(result.recipient_count).toBe(3);
    await consume(h);
    expect(h.sent.map((m) => m.to)).not.toContain("bob@nemar.test");
  });

  test("a pending account is in no audience, even with its inbox marked verified", async () => {
    seedUser("pendingpat", { status: "pending" });
    const h = harness();
    const res = await post(ADMIN_KEY, NEWS, h);
    expect(await res.json()).toMatchObject({ recipient_count: 4 });
    await consume(h);
    expect(h.sent.map((m) => m.to)).not.toContain("pendingpat@nemar.test");
  });

  test("the group narrows the audience: admins reach only owners and admins", async () => {
    const h = harness();
    await post(ADMIN_KEY, { ...NEWS, to: "admins" }, h);
    await consume(h);
    expect(h.sent.map((m) => m.to).sort()).toEqual(["cataadmin@nemar.test", "catowner@nemar.test"]);
  });
});

describe("the preference is re-read immediately before each send", () => {
  test("an opt-out between queueing and sending is skipped, counted, and the row still reaches done", async () => {
    const h = harness();
    const result = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { broadcast_id: number };
    expect(h.queue.bodies.length).toBe(4);

    // After the message is queued, bob unsubscribes through the real audited writer.
    const written = await saveEmailPreferences(realD1(db), {
      targetId: bob,
      targetUsername: "bob",
      actorId: bob,
      changes: { news: false },
      via: "link",
    });
    expect(written).toBeTruthy();
    const recorded = await consume(h);

    expect(recorded.every((r) => r.acked && r.retried === null)).toBe(true);
    expect(h.sent.map((m) => m.to).sort()).toEqual([
      "alice@nemar.test",
      "cataadmin@nemar.test",
      "catowner@nemar.test",
    ]);
    expect(rowOf(result.broadcast_id)).toMatchObject({
      status: "done",
      queued_count: 4,
      delivered_count: 3,
      skipped_count: 1,
      failure_count: 0,
    });
  });

  test("a different category's opt-out does not skip this one", async () => {
    const h = harness();
    await post(ADMIN_KEY, NEWS, h);
    await saveEmailPreferences(realD1(db), {
      targetId: bob,
      targetUsername: "bob",
      actorId: bob,
      changes: { rfcs: false, maintenance: false },
      via: "link",
    });
    await consume(h);
    expect(h.sent.map((m) => m.to)).toContain("bob@nemar.test");
  });

  test("an address changed after queueing is skipped: the message was for the old address", async () => {
    const h = harness();
    const result = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { broadcast_id: number };
    db.query("UPDATE users SET email = 'bob-new@nemar.test' WHERE id = ?").run(bob);
    await consume(h);
    expect(h.sent.map((m) => m.to)).not.toContain("bob@nemar.test");
    expect(h.sent.map((m) => m.to)).not.toContain("bob-new@nemar.test");
    expect(rowOf(result.broadcast_id)).toMatchObject({ skipped_count: 1, delivered_count: 3 });
  });

  test("an account deleted after queueing is skipped", async () => {
    const h = harness();
    const result = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { broadcast_id: number };
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(bob);
    await consume(h);
    expect(h.sent.map((m) => m.to)).not.toContain("bob@nemar.test");
    expect(rowOf(result.broadcast_id)).toMatchObject({ status: "done", skipped_count: 1 });
  });

  test("a redelivered skipped message is acked without a second count", async () => {
    const h = harness();
    const result = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { broadcast_id: number };
    await saveEmailPreferences(realD1(db), {
      targetId: bob,
      targetUsername: "bob",
      actorId: bob,
      changes: { news: false },
      via: "link",
    });
    await consume(h);
    await consume(
      h,
      h.queue.bodies.filter((b) => (b as { to: string }).to === "bob@nemar.test"),
    );
    expect(rowOf(result.broadcast_id)?.skipped_count).toBe(1);
  });

  test("a categorized row's message without an account id is never sent unchecked", async () => {
    const h = harness();
    const result = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { broadcast_id: number };
    const stripped = h.queue.bodies.map((b) => {
      const { user_id: _drop, ...rest } = b as Record<string, unknown>;
      return rest;
    });
    await consume(h, stripped);
    expect(h.sent).toEqual([]);
    expect(rowOf(result.broadcast_id)).toMatchObject({ status: "done", failure_count: 4 });
  });

  test("a legacy row (no category) and a legacy message are sent as before: no headers, no category footer", async () => {
    db.query(
      `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, status, queued_count)
       VALUES (?, 'all', 'Old', 'Legacy **body**', 'queued', 1)`,
    ).run(ownerId);
    const h = harness();
    await consume(h, [{ kind: "broadcast", broadcast_id: 1, to: "alice@nemar.test" }]);
    expect(h.sent.length).toBe(1);
    expect("headers" in (h.sent[0] as object)).toBe(false);
    expect(h.sent[0]?.html).not.toContain("Unsubscribe");
    expect(h.sent[0]?.html).not.toContain(POSTAL);
  });

  test("when the link secret vanishes before the send, the message is retried, never sent without its link", async () => {
    const h = harness();
    await post(ADMIN_KEY, NEWS, h);
    const later = { ...h, env: { ...h.env, MAIL_LINK_SECRET: undefined } as unknown as Bindings };
    const recorded = await consume(later, h.queue.bodies.slice(0, 1));
    expect(h.sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ acked: false, retried: { delaySeconds: 60 } });
  });
});

describe("recalls", () => {
  const RECALL = {
    to: "all",
    category: "recall",
    subject: "A dataset has a problem",
    body: RECALL_BODY,
    recall_reference: "nm000104@v1.0.0",
    confirm_recall: "nm000104@v1.0.0",
  };

  function seedDataset(id: string) {
    db.query(
      `INSERT INTO datasets (dataset_id, name, description, authors, owner_user_id, status, visibility, is_sandbox)
       VALUES (?, 'A study', 'd', 'a', ?, 'active', 'public', 0)`,
    ).run(id, ownerId);
  }

  test("an admin who is not an owner is refused, and nothing is written or queued", async () => {
    seedDataset("nm000104");
    const h = harness();
    const res = await post(ADMIN_KEY, RECALL, h);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "owner_only" });
    expect(noRows()).toBe(0);
    expect(h.queue.bodies).toEqual([]);
  });

  test.each([
    ["no reference", { recall_reference: undefined }, 400, "recall_reference_required"],
    [
      "a sentence instead of a reference",
      { recall_reference: "it is bad" },
      400,
      "recall_reference_invalid",
    ],
    [
      "a dataset that does not exist",
      { recall_reference: "nm000999", confirm_recall: "nm000999" },
      404,
      "recall_dataset_not_found",
    ],
    ["no typed confirmation", { confirm_recall: undefined }, 400, "recall_confirmation_required"],
    ["a wrong confirmation", { confirm_recall: "nm000104" }, 400, "recall_confirmation_required"],
    [
      "a body without the headings",
      { body: "Please delete nm000104. What is affected: it. What to do: delete." },
      400,
      "recall_headings_missing",
    ],
    [
      "a body with only one heading",
      { body: "## What is affected\n\nnm000104" },
      400,
      "recall_headings_missing",
    ],
  ])("the owner is refused %s", async (_name, patch, status, code) => {
    seedDataset("nm000104");
    const h = harness();
    const res = await post(OWNER_KEY, { ...RECALL, ...patch }, h);
    expect(res.status).toBe(status as number);
    expect(await res.json()).toMatchObject({ error: code });
    expect(noRows()).toBe(0);
    expect(h.queue.bodies).toEqual([]);
  });

  test("a GitHub issue or advisory URL is an accepted reference, and a dataset need not exist for it", async () => {
    const h = harness();
    const ref = "https://github.com/nemarOrg/nemar-cli/security/advisories/GHSA-abcd-ef12-3456";
    const res = await post(OWNER_KEY, { ...RECALL, recall_reference: ref, confirm_recall: ref }, h);
    expect(res.status).toBe(200);
  });

  test("the recall goes out under the fixed prefix, with the reference stored and a site notice published", async () => {
    seedDataset("nm000104");
    const h = harness();
    const res = await post(OWNER_KEY, RECALL, h);
    expect(res.status).toBe(200);
    const result = (await res.json()) as { broadcast_id: number; notice_id: number };
    expect(rowOf(result.broadcast_id)).toMatchObject({
      category: "recall",
      recall_reference: "nm000104@v1.0.0",
      subject: "[NEMAR recall] A dataset has a problem",
    });
    const notice = db
      .query<{ level: string; scope: string; message: string }, [number]>(
        "SELECT level, scope, message FROM notices WHERE id = ?",
      )
      .get(result.notice_id);
    expect(notice).toMatchObject({ level: "critical", scope: "all" });
    expect(notice?.message).toContain("nm000104@v1.0.0");
    expect(notice?.message).not.toContain("Delete your copy");
  });

  test("a recall message has no List-Unsubscribe headers, no unsubscribe link, no postal address, and says why", async () => {
    seedDataset("nm000104");
    const h = harness();
    await post(OWNER_KEY, RECALL, h);
    await consume(h);
    expect(h.sent.length).toBe(4);
    for (const m of h.sent) {
      expect("headers" in (m as object)).toBe(false);
      expect(m.subject).toBe("[DEV] [NEMAR recall] A dataset has a problem");
      expect(m.html).not.toContain("/mail/unsubscribe/");
      expect(m.html).not.toMatch(/unsubscribe/i);
      expect(m.html).not.toContain(POSTAL);
      expect(m.html).toContain("Recalls cannot be turned off");
      expect(m.html).toContain("https://docs.nemar.org/policies/community-mail");
      expect(m.html).toContain("https://test.nemar.test/settings");
      expect(m.html).toContain("What is affected");
    }
  });

  test("a recall ignores preferences and reaches a revoked account; no other category does", async () => {
    seedDataset("nm000104");
    db.query(
      'UPDATE users SET email_preferences = \'{"news":false,"rfcs":false,"maintenance":false}\' WHERE id = ?',
    ).run(bob);
    seedUser("carol", { status: "revoked" });
    seedUser("dave", { status: "pending" });
    const h = harness();
    await post(OWNER_KEY, RECALL, h);
    await consume(h);
    const to = h.sent.map((m) => m.to);
    expect(to).toContain("bob@nemar.test");
    expect(to).toContain("carol@nemar.test");
    expect(to).not.toContain("dave@nemar.test");

    const h2 = harness();
    await post(ADMIN_KEY, { ...NEWS, subject: "Other" }, h2);
    await consume(h2);
    expect(h2.sent.map((m) => m.to)).not.toContain("carol@nemar.test");
    expect(h2.sent.map((m) => m.to)).not.toContain("bob@nemar.test");
  });

  test("an opt-out recorded after queueing never skips a recall; a deleted account is still skipped", async () => {
    seedDataset("nm000104");
    const h = harness();
    const result = (await (await post(OWNER_KEY, RECALL, h)).json()) as { broadcast_id: number };
    await saveEmailPreferences(realD1(db), {
      targetId: bob,
      targetUsername: "bob",
      actorId: bob,
      changes: { news: false, rfcs: false, maintenance: false },
      via: "link_all",
    });
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(alice);
    await consume(h);
    const to = h.sent.map((m) => m.to);
    expect(to).toContain("bob@nemar.test");
    expect(to).not.toContain("alice@nemar.test");
    expect(rowOf(result.broadcast_id)).toMatchObject({ skipped_count: 1, delivered_count: 3 });
  });

  test("an unusable link secret does not hold back a recall: it carries no link", async () => {
    seedDataset("nm000104");
    const h = harness({ MAIL_LINK_SECRET: undefined });
    const res = await post(OWNER_KEY, RECALL, h);
    expect(res.status).toBe(200);
    await consume(h);
    expect(h.sent.length).toBe(4);
  });

  test("a recall still needs the outbox", async () => {
    seedDataset("nm000104");
    const h = harness({ EMAIL_OUTBOX: undefined });
    const res = await post(OWNER_KEY, RECALL, h);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "outbox_required" });
    expect(noRows()).toBe(0);
  });

  test("a recall reference on any other category is refused", async () => {
    const h = harness();
    const res = await post(ADMIN_KEY, { ...NEWS, recall_reference: "nm000104" }, h);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "recall_fields_not_allowed" });
  });

  test("a recall's dry run needs no confirmation and queues nothing", async () => {
    seedDataset("nm000104");
    const h = harness();
    const res = await post(OWNER_KEY, { ...RECALL, confirm_recall: undefined, dry_run: true }, h);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      dry_run: true,
      category: "recall",
      subject: "[NEMAR recall] A dataset has a problem",
    });
    expect(noRows()).toBe(0);
  });
});

describe("a send that cannot carry its link is refused before anything is written", () => {
  test.each([
    ["unset", undefined],
    ["shorter than 32 characters", "short-secret"],
    ["blank", "   "],
  ])("MAIL_LINK_SECRET %s", async (_name, secret) => {
    const h = harness({ MAIL_LINK_SECRET: secret });
    const res = await post(ADMIN_KEY, NEWS, h);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "mail_link_secret_unset" });
    expect(noRows()).toBe(0);
    expect(h.queue.bodies).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test("an API_BASE_URL that is not https", async () => {
    const h = harness({ API_BASE_URL: "http://api.nemar.test" });
    const res = await post(ADMIN_KEY, NEWS, h);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "mail_link_base_unusable" });
    expect(noRows()).toBe(0);
  });

  test("no outbox: a categorized send is never run inline", async () => {
    const h = harness({ EMAIL_OUTBOX: undefined });
    const res = await post(ADMIN_KEY, NEWS, h);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "outbox_required" });
    expect(noRows()).toBe(0);
    expect(h.sent).toEqual([]);
  });

  test("the dry run says what would refuse the send", async () => {
    const h = harness({ MAIL_LINK_SECRET: undefined });
    const res = await post(ADMIN_KEY, { ...NEWS, dry_run: true }, h);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dry_run: true, blockers: ["mail_link_secret_unset"] });
  });
});

describe("what a group send must name", () => {
  test("a group send without a category is refused with the code an old CLI can print", async () => {
    const h = harness();
    const res = await post(ADMIN_KEY, { to: "all", subject: "x", body: "y" }, h);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "category_required" });
    expect(noRows()).toBe(0);
  });

  test("a category the table does not know is refused by the schema", async () => {
    const h = harness();
    const res = await post(ADMIN_KEY, { ...NEWS, category: "announcements" }, h);
    expect(res.status).toBe(400);
    expect(noRows()).toBe(0);
  });

  test("a per-user send takes no category and stays direct contact: no headers, no category footer", async () => {
    const h = harness();
    const refused = await post(
      ADMIN_KEY,
      { user: "bob", category: "news", subject: "x", body: "y" },
      h,
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "category_not_allowed" });

    db.query("UPDATE users SET email_preferences = '{\"news\":false}' WHERE id = ?").run(bob);
    const ok = await post(ADMIN_KEY, { user: "bob", subject: "Direct", body: "Hi" }, h);
    expect(ok.status).toBe(200);
    await consume(h);
    expect(h.sent.map((m) => m.to)).toEqual(["bob@nemar.test"]);
    expect("headers" in (h.sent[0] as object)).toBe(false);
    expect(h.sent[0]?.html).not.toContain(POSTAL);
  });

  test("the same category and subject within 24 hours is refused unless allow_repeat is set", async () => {
    const h = harness();
    const first = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { broadcast_id: number };
    const again = await post(ADMIN_KEY, NEWS, h);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: "duplicate_send",
      broadcast_id: first.broadcast_id,
    });
    expect(noRows()).toBe(1);

    expect((await post(ADMIN_KEY, { ...NEWS, subject: "Different" }, h)).status).toBe(200);
    expect((await post(ADMIN_KEY, { ...NEWS, allow_repeat: true }, h)).status).toBe(200);
    // Another category with the same subject is another message.
    expect((await post(ADMIN_KEY, { ...NEWS, category: "rfcs" }, h)).status).toBe(200);
  });

  test("a send older than 24 hours no longer blocks", async () => {
    const h = harness();
    const first = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { broadcast_id: number };
    db.query("UPDATE broadcast_emails SET sent_at = datetime('now', '-25 hours') WHERE id = ?").run(
      first.broadcast_id,
    );
    expect((await post(ADMIN_KEY, NEWS, h)).status).toBe(200);
  });
});

describe("dev safety: the delivery fence and the dry run", () => {
  test("a recipient off the allow-list is withheld at enqueue and never sent", async () => {
    seedUser("outsider", { email: "outsider@example.org" });
    const h = harness();
    const res = await post(ADMIN_KEY, NEWS, h);
    expect(await res.json()).toMatchObject({ recipient_count: 4, suppressed_count: 1 });
    expect(JSON.stringify(h.queue.bodies)).not.toContain("outsider");
    await consume(h);
    expect(h.sent.map((m) => m.to)).not.toContain("outsider@example.org");
  });

  test("the fence also holds at send time: a forged message for an off-list address is a failure, not a send", async () => {
    const outsider = seedUser("outsider", { email: "outsider@example.org" });
    const h = harness();
    const result = (await (await post(ADMIN_KEY, NEWS, h)).json()) as { broadcast_id: number };
    await consume(h, [
      {
        kind: "broadcast",
        broadcast_id: result.broadcast_id,
        to: "outsider@example.org",
        user_id: outsider,
      },
    ]);
    expect(h.sent).toEqual([]);
    expect(rowOf(result.broadcast_id)?.failure_count).toBe(1);
  });

  test("outside production a dry run returns counts and a redacted sample, never an address list", async () => {
    const h = harness();
    const res = await post(ADMIN_KEY, { ...NEWS, dry_run: true }, h);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      dry_run: true,
      category: "news",
      recipient_count: 4,
      deliverable_count: 4,
      counts: { all: 4, admins: 2, members: 2 },
    });
    expect("recipients" in body).toBe(false);
    const sample = body.sample as string[];
    expect(sample.length).toBe(3);
    for (const entry of sample) expect(entry).toMatch(/^.\*\*\*@nemar\.test$/);
    expect(JSON.stringify(body)).not.toContain("alice@");
    expect(noRows()).toBe(0);
  });

  test("an unrecognized environment is not production", async () => {
    const h = harness({ ENVIRONMENT: "prod" });
    const body = (await (await post(ADMIN_KEY, { ...NEWS, dry_run: true }, h)).json()) as Record<
      string,
      unknown
    >;
    expect("recipients" in body).toBe(false);
  });

  test("in production the dry run lists the addresses, as it always did", async () => {
    const h = harness({ ENVIRONMENT: "production" });
    const body = (await (await post(ADMIN_KEY, { ...NEWS, dry_run: true }, h)).json()) as {
      recipients: string[];
    };
    expect(body.recipients.length).toBe(4);
  });

  test("the dry run counts what the fence would withhold", async () => {
    seedUser("outsider", { email: "outsider@example.org" });
    const h = harness();
    const body = (await (await post(ADMIN_KEY, { ...NEWS, dry_run: true }, h)).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ recipient_count: 5, deliverable_count: 4 });
  });
});

describe("the one-click header allowlist", () => {
  const url = `${API}/mail/unsubscribe/v1.1.news.1.${"A".repeat(43)}`;
  const good = {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  test("the exact pair is accepted under canonical names, whatever the input case", () => {
    expect(validateMailHeaders(good)).toEqual(good);
    expect(
      validateMailHeaders({
        "list-unsubscribe": good["List-Unsubscribe"],
        "LIST-UNSUBSCRIBE-POST": good["List-Unsubscribe-Post"],
      }),
    ).toEqual(good);
  });

  test.each([
    ["a mailto URI", { ...good, "List-Unsubscribe": "<mailto:u@nemar.test>" }],
    ["plain HTTP", { ...good, "List-Unsubscribe": `<${url.replace("https", "http")}>` }],
    ["two URIs", { ...good, "List-Unsubscribe": `<${url}>, <mailto:u@nemar.test>` }],
    ["no angle brackets", { ...good, "List-Unsubscribe": url }],
    ["a URI off the unsubscribe path", { ...good, "List-Unsubscribe": "<https://evil.test/x>" }],
    ["a different Post value", { ...good, "List-Unsubscribe-Post": "List-Unsubscribe=Yes" }],
    ["Post without the URI", { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }],
  ])("%s is refused", (_name, headers) => {
    expect(() => validateMailHeaders(headers)).toThrow(MailHeaderError);
  });

  test("no other List-* header is allowed", () => {
    expect(() => validateMailHeaders({ "List-Id": "<news.mail.nemar.org>" })).toThrow(
      MailHeaderError,
    );
  });
});
