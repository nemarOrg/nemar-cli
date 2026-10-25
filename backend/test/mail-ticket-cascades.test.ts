/**
 * Removing a person from admin standing releases their support tickets (epic #1893 phase 3a;
 * AGENTS.md, "Revocation cascades, always"). Three paths, each driven through its real route
 * against a real migrated database: a role demotion, an admin revoke, and a soft delete (which
 * runs tombstoneUserCascade). No mocks.
 *
 * What is released: open tickets go back to the pool (assignee NULL) with an `unassigned`
 * event; closed tickets keep their assignee as history; the person's availability row, every
 * backup reference to them, the queue assignee and backup fields and their rr_members entry go.
 * An owner demoted to admin loses only restricted tickets and restricted-queue references.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { tombstoneUserCascade } from "../src/db/user-tombstone";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { seedUser } from "./helpers/tickets";

const KEY = "mail-cascade-owner-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test", RESEND_API_KEY: "" } as unknown as Bindings;
}

async function seedActor(): Promise<void> {
  const id = seedUser(db, { username: "cascadeactor", role: "owner" });
  await db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(id, await hashApiKey(KEY), KEY.slice(0, 8));
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env(),
  );
}

interface World {
  target: number;
  other: number;
  openTicket: number;
  closedTicket: number;
  restrictedTicket: number;
  othersTicket: number;
}

function seedWorld(targetRole: "admin" | "owner"): World {
  const target = seedUser(db, { username: "mailtarget", role: targetRole });
  const other = seedUser(db, { username: "mailother", role: "owner" });
  const ticket = (ref: string, status: string, restricted: number, assignee: number) => {
    db.run(
      "INSERT INTO mail_tickets (ref, queue_tag, restricted, status, assignee_user_id, requester_email) VALUES (?, 'q', ?, ?, ?, 'a@example.com')",
      [ref, restricted, status, assignee],
    );
    return db.query<{ id: number }, [string]>("SELECT id FROM mail_tickets WHERE ref = ?").get(ref)
      ?.id as number;
  };
  const world = {
    target,
    other,
    openTicket: ticket("openaaaaaa", "open", 0, target),
    closedTicket: ticket("closedaaaa", "closed", 0, target),
    restrictedTicket: ticket("restraaaaa", "open", 1, target),
    othersTicket: ticket("otheraaaaa", "open", 0, other),
  };
  db.run(
    "INSERT INTO mail_availability (user_id, away_from, backup_user_id) VALUES (?, '2026-10-01', ?)",
    [target, other],
  );
  db.run(
    "INSERT INTO mail_availability (user_id, away_from, backup_user_id) VALUES (?, '2026-10-01', ?)",
    [other, target],
  );
  db.run("UPDATE mail_queues SET assignee_user_id = ?, backup_user_id = ? WHERE tag = '*'", [
    target,
    target,
  ]);
  db.run("INSERT INTO mail_queues (tag, strategy, rr_members) VALUES ('rr', 'round_robin', ?)", [
    JSON.stringify([other, target, 999]),
  ]);
  db.run(
    "UPDATE mail_queues SET assignee_user_id = ?, backup_user_id = ?, strategy = 'fixed', rr_members = ? WHERE tag = 'security'",
    [target, target, JSON.stringify([target, other])],
  );
  return world;
}

const assignee = (id: number) =>
  db
    .query<{ assignee_user_id: number | null }, [number]>(
      "SELECT assignee_user_id FROM mail_tickets WHERE id = ?",
    )
    .get(id)?.assignee_user_id;
const queueRow = (tag: string) =>
  db
    .query<
      { assignee_user_id: number | null; backup_user_id: number | null; rr_members: string },
      [string]
    >("SELECT assignee_user_id, backup_user_id, rr_members FROM mail_queues WHERE tag = ?")
    .get(tag);
const events = (id: number) =>
  db
    .query<{ kind: string }, [number]>(
      "SELECT kind FROM mail_ticket_events WHERE ticket_id = ? AND kind = 'unassigned'",
    )
    .all(id).length;
const availabilityOf = (id: number) =>
  db
    .query<{ backup_user_id: number | null }, [number]>(
      "SELECT backup_user_id FROM mail_availability WHERE user_id = ?",
    )
    .get(id);

function expectFullyReleased(w: World) {
  expect(assignee(w.openTicket)).toBeNull();
  expect(assignee(w.restrictedTicket)).toBeNull();
  expect(events(w.openTicket)).toBe(1);
  expect(events(w.restrictedTicket)).toBe(1);
  // Closed is history; another person's ticket is untouched.
  expect(assignee(w.closedTicket)).toBe(w.target);
  expect(events(w.closedTicket)).toBe(0);
  expect(assignee(w.othersTicket)).toBe(w.other);
  expect(availabilityOf(w.target)).toBeNull();
  expect(availabilityOf(w.other)?.backup_user_id).toBeNull();
  for (const tag of ["*", "security"]) {
    expect(queueRow(tag)?.assignee_user_id).toBeNull();
    expect(queueRow(tag)?.backup_user_id).toBeNull();
  }
  expect(JSON.parse(queueRow("rr")?.rr_members ?? "[]")).toEqual([w.other, 999]);
  expect(JSON.parse(queueRow("security")?.rr_members ?? "[]")).toEqual([w.other]);
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedActor();
});

describe("role demotion", () => {
  test("admin to member releases everything", async () => {
    const w = seedWorld("admin");
    expect((await call("POST", "/admin/users/mailtarget/role", { role: "member" })).status).toBe(
      200,
    );
    expectFullyReleased(w);
  });

  test("owner to member releases everything", async () => {
    const w = seedWorld("owner");
    expect((await call("POST", "/admin/users/mailtarget/role", { role: "member" })).status).toBe(
      200,
    );
    expectFullyReleased(w);
  });

  test("owner to admin releases restricted tickets and references only", async () => {
    const w = seedWorld("owner");
    expect((await call("POST", "/admin/users/mailtarget/role", { role: "admin" })).status).toBe(
      200,
    );
    expect(assignee(w.restrictedTicket)).toBeNull();
    expect(events(w.restrictedTicket)).toBe(1);
    expect(assignee(w.openTicket)).toBe(w.target);
    expect(queueRow("security")).toMatchObject({ assignee_user_id: null, backup_user_id: null });
    expect(JSON.parse(queueRow("security")?.rr_members ?? "[]")).toEqual([w.other]);
    expect(queueRow("*")).toMatchObject({ assignee_user_id: w.target, backup_user_id: w.target });
    expect(JSON.parse(queueRow("rr")?.rr_members ?? "[]")).toEqual([w.other, w.target, 999]);
    expect(availabilityOf(w.target)).not.toBeNull();
    expect(availabilityOf(w.other)?.backup_user_id).toBe(w.target);
  });

  test("a promotion releases nothing", async () => {
    seedUser(db, { username: "mailpromo", role: "member" });
    const t = seedUser(db, { username: "mailpromo2", role: "admin" });
    db.run("UPDATE mail_queues SET assignee_user_id = ? WHERE tag = '*'", [t]);
    expect((await call("POST", "/admin/users/mailpromo2/role", { role: "owner" })).status).toBe(
      200,
    );
    expect(queueRow("*")?.assignee_user_id).toBe(t);
  });
});

describe("admin revoke", () => {
  test("releases everything in the revocation batch", async () => {
    const w = seedWorld("admin");
    expect((await call("POST", "/admin/revoke/mailtarget")).status).toBe(200);
    expectFullyReleased(w);
  });
});

describe("soft delete (tombstoneUserCascade)", () => {
  test("releases everything", async () => {
    const w = seedWorld("admin");
    expect((await call("DELETE", `/admin/users/by-id/${w.target}`)).status).toBe(200);
    expectFullyReleased(w);
  });
});

describe("guarded tombstone (the scheduled sweep's form)", () => {
  test("releases everything when the address still matches", async () => {
    const w = seedWorld("admin");
    const email = "mailtarget@example.com";
    const r = await tombstoneUserCascade(realD1(db), w.target, email, email);
    expect(r.tombstoned).toBe(true);
    expectFullyReleased(w);
  });

  test("touches nothing when the address changed since it was read", async () => {
    const w = seedWorld("admin");
    const r = await tombstoneUserCascade(
      realD1(db),
      w.target,
      "x@example.com",
      "changed@example.com",
    );
    expect(r.tombstoned).toBe(false);
    expect(assignee(w.openTicket)).toBe(w.target);
    expect(availabilityOf(w.target)).not.toBeNull();
    expect(queueRow("*")?.assignee_user_id).toBe(w.target);
    expect(JSON.parse(queueRow("rr")?.rr_members ?? "[]")).toEqual([w.other, w.target, 999]);
  });
});

describe("the account link on a ticket", () => {
  const link = (w: World) => {
    db.run("UPDATE mail_tickets SET requester_user_id = ? WHERE id = ?", [
      w.target,
      w.othersTicket,
    ]);
  };
  const row = (id: number) =>
    db
      .query<{ requester_user_id: number | null; requester_email: string }, [number]>(
        "SELECT requester_user_id, requester_email FROM mail_tickets WHERE id = ?",
      )
      .get(id);

  test("a soft delete clears the link and keeps the correspondence address", async () => {
    const w = seedWorld("admin");
    link(w);
    expect((await call("DELETE", `/admin/users/by-id/${w.target}`)).status).toBe(200);
    expect(row(w.othersTicket)).toEqual({
      requester_user_id: null,
      requester_email: "a@example.com",
    });
  });

  test("a revocation or a demotion keeps the account, so keeps the link", async () => {
    const w = seedWorld("admin");
    link(w);
    expect((await call("POST", "/admin/users/mailtarget/role", { role: "member" })).status).toBe(
      200,
    );
    expect(row(w.othersTicket)?.requester_user_id).toBe(w.target);
    expect((await call("POST", "/admin/revoke/mailtarget")).status).toBe(200);
    expect(row(w.othersTicket)?.requester_user_id).toBe(w.target);
  });
});
