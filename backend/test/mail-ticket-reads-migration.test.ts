/**
 * Migration 0110 (`mail_ticket_reads`, ADR 0112): per-admin read markers for support tickets,
 * against the real migrated schema with foreign keys enforced.
 */

import { describe, expect, test } from "bun:test";
import { freshDb } from "./helpers/d1";

function seed() {
  const db = freshDb();
  db.run("PRAGMA foreign_keys = ON");
  db.run(
    `INSERT INTO mail_tickets (id, ref, queue_tag, requester_email) VALUES
       (1, 'amber-falcon-river', 'support', 'a@example.com'),
       (2, 'amber-falcon-lake', 'support', 'a@example.com')`,
  );
  return db;
}

describe("0110 mail_ticket_reads", () => {
  test("has the columns, the primary key and the ticket index", () => {
    const db = freshDb();
    const cols = db.query("PRAGMA table_info(mail_ticket_reads)").all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.map((c) => c.name)).toEqual(["user_id", "ticket_id", "read_message_id", "read_at"]);
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["user_id", "ticket_id"]);
    expect(cols.every((c) => c.notnull === 1)).toBe(true);
    const idx = db.query("PRAGMA index_list(mail_ticket_reads)").all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain("idx_mail_ticket_reads_ticket");
  });

  test("one row per user and ticket; read_at defaults", () => {
    const db = seed();
    db.run("INSERT INTO mail_ticket_reads (user_id, ticket_id, read_message_id) VALUES (7, 1, 3)");
    db.run("INSERT INTO mail_ticket_reads (user_id, ticket_id, read_message_id) VALUES (8, 1, 3)");
    expect(() =>
      db.run(
        "INSERT INTO mail_ticket_reads (user_id, ticket_id, read_message_id) VALUES (7, 1, 4)",
      ),
    ).toThrow();
    const row = db.query("SELECT read_at FROM mail_ticket_reads WHERE user_id = 7").get() as {
      read_at: string;
    };
    expect(row.read_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  test("rows go with their ticket, and a missing ticket is refused", () => {
    const db = seed();
    db.run("INSERT INTO mail_ticket_reads (user_id, ticket_id, read_message_id) VALUES (7, 1, 3)");
    db.run("INSERT INTO mail_ticket_reads (user_id, ticket_id, read_message_id) VALUES (7, 2, 3)");
    expect(() =>
      db.run(
        "INSERT INTO mail_ticket_reads (user_id, ticket_id, read_message_id) VALUES (7, 99, 1)",
      ),
    ).toThrow();
    db.run("DELETE FROM mail_tickets WHERE id = 1");
    const left = db.query("SELECT ticket_id FROM mail_ticket_reads").all();
    expect(left).toEqual([{ ticket_id: 2 }]);
  });
});
