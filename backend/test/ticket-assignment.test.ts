/**
 * Assignment, visibility and the migration's shape (epic #1893 phase 3a). Real D1 (bun:sqlite
 * behind realD1, every migration applied); no mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isRestrictedQueue,
  resolveAssignee,
  ticketVisibleTo,
} from "../src/services/ticket-assignment";
import { freshDb, realD1 } from "./helpers/d1";
import { seedUser } from "./helpers/tickets";

let db: Database;
let d1: D1Database;
const NOW = new Date("2026-10-24T12:00:00Z");

beforeEach(() => {
  db = freshDb();
  d1 = realD1(db);
});

function queue(tag: string, cols: Record<string, unknown>) {
  const names = ["tag", ...Object.keys(cols)];
  db.run(
    `INSERT OR REPLACE INTO mail_queues (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    [tag, ...Object.values(cols)] as never[],
  );
}

function away(
  userId: number,
  from: string | null,
  until: string | null,
  backup: number | null = null,
) {
  db.run(
    "INSERT INTO mail_availability (user_id, away_from, away_until, backup_user_id) VALUES (?, ?, ?, ?)",
    [userId, from, until, backup],
  );
}

describe("migration 0102", () => {
  test("seeds security and conduct restricted pool queues, and a fallback with no assignee when no default admin exists", () => {
    const rows = db
      .query<Record<string, unknown>, []>("SELECT * FROM mail_queues ORDER BY tag")
      .all();
    expect(rows.map((r) => [r.tag, r.restricted, r.strategy, r.assignee_user_id])).toEqual([
      ["*", 0, "fixed", null],
      ["conduct", 1, "pool", null],
      ["security", 1, "pool", null],
    ]);
  });

  test("the fallback queue is fixed to the default admin account when it exists", () => {
    const id = seedUser(db, { username: "NemarAdmin", role: "admin" });
    db.run("DELETE FROM mail_queues WHERE tag = '*'");
    const sql = readFileSync(
      join(import.meta.dir, "../src/db/migrations/0102_support_tickets.sql"),
      "utf-8",
    );
    db.exec(sql); // idempotent: tables exist, seeds are INSERT OR IGNORE
    expect(
      db
        .query<{ assignee_user_id: number }, []>(
          "SELECT assignee_user_id FROM mail_queues WHERE tag = '*'",
        )
        .get()?.assignee_user_id,
    ).toBe(id);
  });

  test("enum checks, unique ref and unique raw key", () => {
    const ins = (status: string, ref: string) =>
      db.run(
        "INSERT INTO mail_tickets (ref, queue_tag, status, requester_email) VALUES (?, 'support', ?, 'a@example.com')",
        [ref, status],
      );
    expect(() => ins("bogus", "raaaaaaaaa")).toThrow();
    expect(() => ins("open", "short")).toThrow(); // ref must be ten characters
    expect(() => ins("open", "UPPERCASE2")).toThrow(); // and lowercase base32
    expect(() => ins("open", "aaaaaaaaa1")).toThrow(); // 1 is not in the base32 alphabet
    expect(() =>
      db.run(
        "INSERT INTO mail_tickets (ref, queue_tag, requester_email) VALUES ('baaaaaaaaa', '', 'a@example.com')",
      ),
    ).toThrow();
    for (const kind of ["reopened", "restricted", "excluded", "reply_failed"]) {
      db.run(
        "INSERT INTO mail_tickets (ref, queue_tag, requester_email) VALUES ('kaaaaaaaaa', 'q', 'a@example.com') ON CONFLICT DO NOTHING",
      );
      db.run(
        "INSERT INTO mail_ticket_events (ticket_id, kind) VALUES ((SELECT id FROM mail_tickets WHERE ref = 'kaaaaaaaaa'), ?)",
        [kind],
      );
    }
    ins("open", "raaaaaaaaa");
    expect(() => ins("open", "raaaaaaaaa")).toThrow();
    expect(() =>
      db.run("INSERT INTO mail_queues (tag, strategy) VALUES ('x', 'random')"),
    ).toThrow();
    const msg = (key: string) =>
      db.run("INSERT INTO mail_messages (ticket_id, direction, raw_key) VALUES (1, 'in', ?)", [
        key,
      ]);
    msg("k");
    expect(() => msg("k")).toThrow();
    expect(() =>
      db.run("INSERT INTO mail_messages (ticket_id, direction) VALUES (1, 'sideways')"),
    ).toThrow();
  });
});

describe("resolveAssignee: strategies", () => {
  test("fixed returns the assignee; an unknown queue and pool return nobody", async () => {
    const a = seedUser(db, { role: "admin" });
    queue("support", { strategy: "fixed", assignee_user_id: a });
    queue("pooled", { strategy: "pool", assignee_user_id: a });
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBe(a);
    expect(await resolveAssignee(d1, "pooled", {}, NOW)).toBeNull();
    expect(await resolveAssignee(d1, "nope", {}, NOW)).toBeNull();
  });

  test("an ineligible fixed assignee falls to the queue backup, then the pool", async () => {
    const gone = seedUser(db, { role: "admin", status: "revoked" });
    const backup = seedUser(db, { role: "admin" });
    queue("support", { strategy: "fixed", assignee_user_id: gone, backup_user_id: backup });
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBe(backup);
    db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [backup]);
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBeNull();
  });

  test("a member is never eligible", async () => {
    const m = seedUser(db, { role: "member" });
    queue("support", { strategy: "fixed", assignee_user_id: m });
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBeNull();
  });

  test("round robin rotates through the members and persists the cursor", async () => {
    const [a, b, c] = [seedUser(db), seedUser(db), seedUser(db)];
    queue("support", { strategy: "round_robin", rr_members: JSON.stringify([a, b, c]) });
    const got: (number | null)[] = [];
    for (let i = 0; i < 5; i++) got.push(await resolveAssignee(d1, "support", {}, NOW));
    expect(got).toEqual([a, b, c, a, b]);
    expect(
      db
        .query<{ rr_cursor: number }, []>("SELECT rr_cursor FROM mail_queues WHERE tag = 'support'")
        .get()?.rr_cursor,
    ).toBe(5);
  });

  test("round robin skips an ineligible or away-without-backup member", async () => {
    const [a, b, c] = [seedUser(db), seedUser(db, { status: "revoked" }), seedUser(db)];
    away(c, "2026-10-01T00:00:00Z", null);
    queue("support", { strategy: "round_robin", rr_members: JSON.stringify([b, c, a]) });
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBe(a);
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBe(a);
  });

  test("an empty or invalid member list yields the pool", async () => {
    queue("support", { strategy: "round_robin", rr_members: "[]" });
    queue("odd", { strategy: "round_robin", rr_members: "not json" });
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBeNull();
    expect(await resolveAssignee(d1, "odd", {}, NOW)).toBeNull();
  });
});

describe("resolveAssignee: away windows", () => {
  test("away with an eligible backup hands the ticket to the backup", async () => {
    const a = seedUser(db);
    const backup = seedUser(db);
    queue("support", { strategy: "fixed", assignee_user_id: a });
    away(a, "2026-10-20T00:00:00Z", "2026-10-30T00:00:00Z", backup);
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBe(backup);
  });

  test("away without a backup goes to the pool", async () => {
    const a = seedUser(db);
    queue("support", { strategy: "fixed", assignee_user_id: a });
    away(a, "2026-10-20T00:00:00Z", "2026-10-30T00:00:00Z");
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBeNull();
  });

  test("a window that has not started, or has ended, does not apply; an open end does", async () => {
    const a = seedUser(db);
    queue("support", { strategy: "fixed", assignee_user_id: a });
    away(a, "2026-10-25T00:00:00Z", null);
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBe(a); // starts tomorrow
    db.run("DELETE FROM mail_availability");
    away(a, "2026-10-01T00:00:00Z", "2026-10-24 12:00:00");
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBe(a); // until is exclusive
    db.run("DELETE FROM mail_availability");
    away(a, null, "2026-10-25 00:00:00");
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBeNull(); // no start, ends tomorrow
    db.run("DELETE FROM mail_availability");
    away(a, "2026-10-01 00:00:00", null);
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBeNull(); // open-ended
  });

  test("a backup that is itself away or ineligible is not used", async () => {
    const a = seedUser(db);
    const b = seedUser(db);
    queue("support", { strategy: "fixed", assignee_user_id: a });
    away(a, "2026-10-01T00:00:00Z", null, b);
    away(b, "2026-10-01T00:00:00Z", null);
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBeNull();
    db.run("DELETE FROM mail_availability WHERE user_id = ?", [b]);
    db.run("UPDATE users SET role = 'member' WHERE id = ?", [b]);
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBeNull();
  });
});

describe("resolveAssignee: restricted queues", () => {
  test("only an owner qualifies, never an admin", async () => {
    const admin = seedUser(db, { role: "admin" });
    const owner = seedUser(db, { role: "owner" });
    queue("security", {
      restricted: 1,
      strategy: "fixed",
      assignee_user_id: admin,
      backup_user_id: owner,
    });
    expect(await resolveAssignee(d1, "security", {}, NOW)).toBe(owner);
    queue("security", { restricted: 1, strategy: "fixed", assignee_user_id: admin });
    expect(await resolveAssignee(d1, "security", {}, NOW)).toBeNull();
  });

  test("an admin, whatever kind of account, is never assigned a restricted ticket by any strategy", async () => {
    const agent = seedUser(db, { role: "admin", accountKind: "service" });
    const person = seedUser(db, { role: "admin", accountKind: "person" });
    queue("security", {
      restricted: 1,
      strategy: "round_robin",
      rr_members: JSON.stringify([agent, person]),
    });
    for (let i = 0; i < 3; i++) expect(await resolveAssignee(d1, "security", {}, NOW)).toBeNull();
    queue("security", { restricted: 1, strategy: "fixed", assignee_user_id: agent });
    expect(await resolveAssignee(d1, "security", {}, NOW)).toBeNull();
  });

  test("the excluded owner is skipped, and an away owner's backup must be an owner too", async () => {
    const excluded = seedUser(db, { role: "owner" });
    const other = seedUser(db, { role: "owner" });
    const adminBackup = seedUser(db, { role: "admin" });
    queue("conduct", {
      restricted: 1,
      strategy: "round_robin",
      rr_members: JSON.stringify([excluded, other]),
    });
    expect(await resolveAssignee(d1, "conduct", { excludedUserId: excluded }, NOW)).toBe(other);
    expect(await resolveAssignee(d1, "conduct", { excludedUserId: excluded }, NOW)).toBe(other);
    away(other, "2026-10-01T00:00:00Z", null, adminBackup);
    expect(await resolveAssignee(d1, "conduct", { excludedUserId: excluded }, NOW)).toBeNull();
  });
});

describe("ticketVisibleTo", () => {
  function seedTickets() {
    const owner = seedUser(db, { role: "owner" });
    const otherOwner = seedUser(db, { role: "owner" });
    const admin = seedUser(db, { role: "admin" });
    const agent = seedUser(db, { role: "admin", accountKind: "service" });
    const member = seedUser(db, { role: "member" });
    const t = (ref: string, restricted: number, excluded: number | null) =>
      db.run(
        "INSERT INTO mail_tickets (ref, queue_tag, restricted, excluded_user_id, requester_email) VALUES (?, 'q', ?, ?, 'a@example.com')",
        [ref, restricted, excluded],
      );
    t("openaaaaaa", 0, null);
    t("restraaaaa", 1, null);
    t("conductaaa", 1, otherOwner);
    t("openxaaaaa", 0, admin);
    return { owner, otherOwner, admin, agent, member };
  }
  const visible = (viewer: { id: number; role: string }, alias?: string) => {
    const v = ticketVisibleTo(viewer, alias);
    return db
      .query<{ ref: string }, never[]>(
        `SELECT ref FROM mail_tickets ${alias ?? "mail_tickets"} WHERE ${v.sql} ORDER BY ref`,
      )
      .all(...(v.binds as never[]))
      .map((r) => r.ref);
  };

  test("an owner sees everything except tickets that exclude them", () => {
    const u = seedTickets();
    expect(visible({ id: u.owner, role: "owner" })).toEqual([
      "conductaaa",
      "openaaaaaa",
      "openxaaaaa",
      "restraaaaa",
    ]);
    expect(visible({ id: u.otherOwner, role: "owner" })).toEqual([
      "openaaaaaa",
      "openxaaaaa",
      "restraaaaa",
    ]);
  });

  test("an admin, person or agent, sees unrestricted tickets only, and not those excluding them", () => {
    const u = seedTickets();
    expect(visible({ id: u.agent, role: "admin" }, "t")).toEqual(["openaaaaaa", "openxaaaaa"]);
    expect(visible({ id: u.admin, role: "admin" }, "t")).toEqual(["openaaaaaa"]);
  });

  test("a member sees nothing, and a bad alias is refused", () => {
    const u = seedTickets();
    expect(visible({ id: u.member, role: "member" })).toEqual([]);
    expect(() => ticketVisibleTo({ id: 1, role: "owner" }, "t; DROP TABLE x")).toThrow();
  });
});

describe("restricted tags do not depend on the queue row", () => {
  test("security and conduct are restricted with no row, and resolve to nobody", async () => {
    db.run("DELETE FROM mail_queues WHERE tag IN ('security', 'conduct')");
    expect(isRestrictedQueue("security")).toBe(true);
    expect(isRestrictedQueue("conduct", { restricted: 0 })).toBe(true);
    expect(isRestrictedQueue("support", { restricted: 0 })).toBe(false);
    expect(isRestrictedQueue("support", { restricted: 1 })).toBe(true);
    expect(await resolveAssignee(d1, "security", {}, NOW)).toBeNull();
  });

  test("a reserved queue row edited to restricted = 0 still admits owners only", async () => {
    const admin = seedUser(db, { role: "admin" });
    const owner = seedUser(db, { role: "owner" });
    queue("security", {
      restricted: 0,
      strategy: "round_robin",
      rr_members: JSON.stringify([admin, owner]),
    });
    expect(await resolveAssignee(d1, "security", {}, NOW)).toBe(owner);
  });
});

describe("away windows: malformed and offset-bearing values", () => {
  test("an offset-bearing timestamp is compared in UTC", async () => {
    const a = seedUser(db);
    queue("support", { strategy: "fixed", assignee_user_id: a });
    // 15:00+02:00 is 13:00Z, after NOW (12:00Z): still away.
    away(a, "2026-10-01T00:00:00+02:00", "2026-10-24T15:00:00+02:00");
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBeNull();
    db.run("DELETE FROM mail_availability");
    // 13:00+02:00 is 11:00Z, before NOW: the window has ended.
    away(a, "2026-10-01T00:00:00+02:00", "2026-10-24T13:00:00+02:00");
    expect(await resolveAssignee(d1, "support", {}, NOW)).toBe(a);
  });

  test("a malformed value never makes the window apply, and never throws", async () => {
    const a = seedUser(db);
    queue("support", { strategy: "fixed", assignee_user_id: a });
    for (const [from, until] of [
      ["not a date", null],
      [null, "garbage"],
      ["2026-13-45", "2026-99-99"],
      ["", ""],
    ] as const) {
      db.run("DELETE FROM mail_availability");
      away(a, from, until);
      expect(await resolveAssignee(d1, "support", {}, NOW)).toBe(a);
    }
  });
});

describe("concurrent round-robin claims", () => {
  test("simultaneous tickets take distinct turns", async () => {
    const members = [seedUser(db), seedUser(db), seedUser(db)];
    queue("support", { strategy: "round_robin", rr_members: JSON.stringify(members) });
    const got = await Promise.all([0, 1, 2].map(() => resolveAssignee(d1, "support", {}, NOW)));
    expect([...got].sort()).toEqual([...members].sort());
  });
});
