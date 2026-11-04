/**
 * Migration 0109 (`ticket_word_refs`, ADR 0112): mail_tickets is rebuilt so `ref` may be three
 * words as well as the legacy ten base32 characters.
 *
 * Run on two real engines with foreign keys ENFORCED, as D1 does: bun:sqlite, and Miniflare's D1.
 * The rebuild drops the parent of five ON DELETE CASCADE tables, so the point of the test is that
 * nothing cascaded away: every row of every child, every id, the AUTOINCREMENT sequence, each
 * index and the trigger come through, and the new CHECK takes both forms and refuses the rest.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { MIGRATIONS_DIR, applyMigrations } from "./helpers/miniflare-d1";

const FILE = "0109_ticket_word_refs.sql";
const before = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < FILE)
    .sort();

type Row = Record<string, unknown>;
interface Engine {
  run(sql: string, ...params: unknown[]): Promise<void>;
  all(sql: string, ...params: unknown[]): Promise<Row[]>;
  migrate(): Promise<void>;
}

const CHILDREN = [
  "mail_messages",
  "mail_ticket_tags",
  "mail_ticket_events",
  "mail_reply_keys",
  "mail_note_keys",
] as const;

async function seed(e: Engine) {
  const ins = (id: number, ref: string) =>
    e.run(
      `INSERT INTO mail_tickets (id, ref, queue_tag, requester_email, subject, last_message_at)
       VALUES (?, ?, 'support', 'ada@sender.example', 'Help', '2026-10-01 10:00:00')`,
      id,
      ref,
    );
  await ins(1, "wphdw6vce6");
  await ins(2, "abcdefg234");
  await ins(3, "zzzzzzzzzz");
  await e.run(
    `INSERT INTO mail_messages (ticket_id, direction, message_id, text_body, raw_key)
     VALUES (1, 'in', '<a@x.example>', 'hello', 'raw/1'), (1, 'out', NULL, 'reply', NULL),
            (2, 'in', '<b@x.example>', 'hi', 'raw/2')`,
  );
  await e.run("INSERT INTO mail_ticket_tags (ticket_id, tag) VALUES (1, 'support'), (2, 'x')");
  await e.run(
    `INSERT INTO mail_ticket_events (ticket_id, kind, detail)
     VALUES (1, 'created', '{}'), (1, 'reply', '{}'), (2, 'created', '{}')`,
  );
  await e.run(
    "INSERT INTO mail_reply_keys (ticket_id, idem_key, state, outcome) VALUES (1, 'k1', 'sent', '{}')",
  );
  await e.run("INSERT INTO mail_note_keys (ticket_id, idem_key, message_id) VALUES (1, 'n1', 2)");
  // The newest ticket is deleted, so the sequence (3) is ahead of the highest id (2).
  await e.run("DELETE FROM mail_tickets WHERE id = 3");
}

const snapshot = async (e: Engine) => ({
  tickets: await e.all("SELECT * FROM mail_tickets ORDER BY id"),
  children: await Promise.all(CHILDREN.map((t) => e.all(`SELECT * FROM ${t} ORDER BY rowid`))),
  objects: await e.all(
    `SELECT type, name FROM sqlite_master
      WHERE tbl_name IN ('mail_tickets', ${CHILDREN.map((t) => `'${t}'`).join(", ")})
        AND name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name`,
  ),
  seq: await e.all(
    `SELECT name, seq FROM sqlite_sequence WHERE name IN ('mail_tickets', ${CHILDREN.map((t) => `'${t}'`).join(", ")}) ORDER BY name`,
  ),
});

function suite(name: string, make: () => Promise<Engine>, dispose?: () => Promise<void>) {
  describe(name, () => {
    let e: Engine;
    let pre: Awaited<ReturnType<typeof snapshot>>;
    beforeAll(async () => {
      e = await make();
      await seed(e);
      pre = await snapshot(e);
      await e.migrate();
    }, 60_000);
    afterAll(async () => {
      await dispose?.();
    });

    test("every ticket, child row, id, index, trigger and sequence survives", async () => {
      const post = await snapshot(e);
      expect(post.tickets).toEqual(pre.tickets);
      expect(post.children).toEqual(pre.children);
      expect(post.objects).toEqual(pre.objects);
      expect(post.seq).toEqual(pre.seq);
      expect(pre.children.map((r) => r.length)).toEqual([3, 2, 3, 1, 1]);
      expect(post.objects.some((o) => o.name === "mail_tickets_activity_default")).toBe(true);
      expect(post.objects.some((o) => o.name === "idx_mail_tickets_ref")).toBe(true);
    });

    test("the children still point at mail_tickets and still cascade", async () => {
      const fks = await e.all("PRAGMA foreign_key_list(mail_messages)");
      expect(fks.map((f) => f.table)).toEqual(["mail_tickets"]);
      await e.run(
        "INSERT INTO mail_tickets (id, ref, queue_tag, requester_email) VALUES (50, 'tmp-tmp-tmp', 'support', 'q@x.example')",
      );
      await e.run("INSERT INTO mail_ticket_tags (ticket_id, tag) VALUES (50, 't')");
      await e.run("DELETE FROM mail_tickets WHERE id = 50");
      expect(await e.all("SELECT * FROM mail_ticket_tags WHERE ticket_id = 50")).toEqual([]);
      expect((await e.all("SELECT * FROM mail_ticket_tags WHERE ticket_id = 1")).length).toBe(1);
    });

    test("a legacy ref and a word ref both insert; the sequence goes on from the old one", async () => {
      const ins = (ref: string) =>
        e.run(
          "INSERT INTO mail_tickets (ref, queue_tag, requester_email) VALUES (?, 'support', 'z@x.example')",
          ref,
        );
      await e.run(
        "INSERT INTO mail_tickets (ref, queue_tag, requester_email) VALUES (?, 'support', 'z@x.example')",
        `${"a".repeat(30)}-${"b".repeat(30)}-cc`, // 64 characters, the bound itself
      );
      await ins("legacyabc2");
      await ins("amber-falcon-river");
      const rows = await e.all(
        "SELECT id, ref FROM mail_tickets WHERE ref IN ('legacyabc2', 'amber-falcon-river') ORDER BY id",
      );
      // Ticket 3 was deleted before the migration and the id 50 above was used and deleted:
      // neither number is handed out again.
      expect(rows.map((r) => r.ref)).toEqual(["legacyabc2", "amber-falcon-river"]);
      expect(Number(rows[0].id)).toBeGreaterThan(50);
    });

    test("the activity trigger still defaults last_activity_at", async () => {
      const [row] = await e.all(
        "SELECT last_activity_at, last_message_at FROM mail_tickets WHERE ref = 'amber-falcon-river'",
      );
      expect(row.last_activity_at).toBe(row.last_message_at);
    });

    test("a malformed ref is refused and a duplicate stays refused", async () => {
      const bad = [
        "short",
        "UPPERCASE2",
        "aaaaaaaaa1", // 1 is not base32 and has no dashes
        "amber-falcon", // one dash
        "amber-falcon-river-owl", // three dashes
        "-amber-falcon-river",
        "amber-falcon-river-",
        "amber--falcon-river",
        "Amber-falcon-river",
        "amber-falcon-r1ver",
        `${"a".repeat(30)}-${"b".repeat(30)}-ccc`, // 65 characters, one over the bound
        "",
      ];
      for (const ref of bad) {
        let refused = false;
        try {
          await e.run(
            "INSERT INTO mail_tickets (ref, queue_tag, requester_email) VALUES (?, 'support', 'z@x.example')",
            ref,
          );
        } catch {
          refused = true;
        }
        expect({ ref, refused }).toEqual({ ref, refused: true });
      }
      await expect(
        e.run(
          "INSERT INTO mail_tickets (ref, queue_tag, requester_email) VALUES ('wphdw6vce6', 'support', 'z@x.example')",
        ),
      ).rejects.toThrow();
    });
  });
}

suite("0109 on bun:sqlite with foreign keys on", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of before()) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  return {
    async run(sql, ...p) {
      db.query(sql).run(...(p as never[]));
    },
    async all(sql, ...p) {
      return db.query(sql).all(...(p as never[])) as Row[];
    },
    async migrate() {
      db.exec(readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8"));
    },
  };
});

let mf: Miniflare | undefined;
suite(
  "0109 on Miniflare D1",
  async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
      compatibilityDate: "2024-12-01",
      d1Databases: ["DB1"],
    });
    const d1 = (await mf.getD1Database("DB1")) as unknown as D1Database;
    await applyMigrations(d1, before());
    return {
      async run(sql, ...p) {
        await d1
          .prepare(sql)
          .bind(...p)
          .run();
      },
      async all(sql, ...p) {
        return (
          await d1
            .prepare(sql)
            .bind(...p)
            .all<Row>()
        ).results;
      },
      async migrate() {
        await applyMigrations(d1, [FILE]);
      },
    };
  },
  async () => {
    await mf?.dispose();
  },
);
