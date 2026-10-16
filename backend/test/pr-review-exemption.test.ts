/**
 * Who is exempt from the dataset pull-request review (ADR 0107).
 *
 * `isReviewExempt` is asked about a GitHub login and answers from the `users` table alone, so the
 * tests seed real accounts into the real schema (bun:sqlite behind realD1, every migration applied)
 * and ask. The callers that act on the answer (the webhook, the allowance check, the admin queue)
 * are exercised through their own entry points in `pr-review-flow.test.ts` and
 * `pr-review-queue.test.ts`.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_KIND_VALUES } from "../../shared/contract/user";
import {
  REVIEW_EXEMPT_KINDS,
  REVIEW_EXEMPT_ROLES,
  REVIEW_EXEMPT_SQL,
  isReviewExempt,
} from "../src/services/pr-review-exemption";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const REPO = "nm000460";

let db: Database;

beforeEach(() => {
  db = freshDb();
});

function env(): Bindings {
  return { DB: realD1(db) } as Bindings;
}

let nextId = 100;

/** A real account row. Everything not named is what a signed-up, approved person has. */
function seedAccount(o: {
  github: string | null;
  role?: string;
  status?: string;
  kind?: string;
  deleted?: boolean;
}): number {
  const id = nextId++;
  const status = o.status ?? "approved";
  db.run(
    `INSERT INTO users (id, username, email, status, role, email_verified, github_username,
                        account_kind, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${o.deleted ? "datetime('now')" : "NULL"})`,
    [
      id,
      `account-${id}`,
      `account-${id}@example.org`,
      status,
      o.role ?? "member",
      status === "pending" ? 0 : 1,
      o.github,
      o.kind ?? "person",
    ],
  );
  return id;
}

const exempt = (login: string) => isReviewExempt(env(), { login, repo: REPO });

describe("who is exempt from the review", () => {
  test("an approved owner's login is exempt", async () => {
    seedAccount({ github: "owner-gh", role: "owner" });
    expect(await exempt("owner-gh")).toBe(true);
  });

  test("an approved admin's login is exempt, matched without regard to case", async () => {
    seedAccount({ github: "Admin-GH", role: "admin" });
    for (const asked of ["Admin-GH", "admin-gh", "ADMIN-GH", "aDmIn-Gh"]) {
      expect(await exempt(asked), asked).toBe(true);
    }
  });

  test("an approved member's login is not exempt", async () => {
    // The control: the same account in every respect but the role.
    seedAccount({ github: "member-gh", role: "member" });
    expect(await exempt("member-gh")).toBe(false);
  });

  test("an operational service account that holds the role is exempt", async () => {
    seedAccount({ github: "service-gh", role: "admin", kind: "service" });
    expect(await exempt("service-gh")).toBe(true);
  });

  test("a test-kind admin or owner is not exempt", async () => {
    seedAccount({ github: "persona-admin-gh", role: "admin", kind: "test" });
    seedAccount({ github: "persona-owner-gh", role: "owner", kind: "test" });
    expect(await exempt("persona-admin-gh")).toBe(false);
    expect(await exempt("persona-owner-gh")).toBe(false);
  });

  test("a revoked, pending, merely verified or deleted admin is not exempt", async () => {
    seedAccount({ github: "revoked-gh", role: "admin", status: "revoked" });
    seedAccount({ github: "pending-gh", role: "admin", status: "pending" });
    seedAccount({ github: "verified-gh", role: "admin", status: "verified" });
    seedAccount({ github: "deleted-gh", role: "admin", deleted: true });
    for (const login of ["revoked-gh", "pending-gh", "verified-gh", "deleted-gh"]) {
      expect(await exempt(login), login).toBe(false);
    }
  });

  test("an unknown login is not exempt", async () => {
    seedAccount({ github: "owner-gh", role: "owner" });
    expect(await exempt("someone-else")).toBe(false);
    // Nor is a longer or shorter name that merely contains an exempt one.
    expect(await exempt("owner-gh-2")).toBe(false);
    expect(await exempt("owner-g")).toBe(false);
  });

  test("a NEMAR username is not a GitHub login", async () => {
    // An owner whose account names no GitHub login cannot be matched, and a username that happens
    // to be someone's GitHub login does not make that person exempt.
    db.run(
      `INSERT INTO users (id, username, email, status, role, email_verified, github_username)
       VALUES (7, 'ghost-gh', 'ghost@example.org', 'approved', 'owner', 1, NULL)`,
    );
    expect(await exempt("ghost-gh")).toBe(false);
  });

  test("a login that is not shaped like one is never exempt, and is not looked up", async () => {
    // A stored empty handle would match an empty login if the shape were not checked first.
    seedAccount({ github: "", role: "owner" });
    for (const login of ["", " ", "a b", "x[bot]", "-lead", "a".repeat(40), "owner\u0000"]) {
      expect(await exempt(login), JSON.stringify(login)).toBe(false);
    }
  });

  test("every combination of role, kind, status and deletion, against the written rule", async () => {
    // The rule is written out here by hand, not read from the constants the query is built from,
    // so editing one condition of the query (or one list) fails a row of this table.
    const roles = ["owner", "admin", "member"];
    const statuses = ["pending", "verified", "approved", "revoked"];
    const cases: { login: string; expected: boolean }[] = [];
    for (const role of roles) {
      for (const kind of ACCOUNT_KIND_VALUES) {
        for (const status of statuses) {
          for (const deleted of [false, true]) {
            const login = `acct-${role}-${kind}-${status}-${deleted ? "gone" : "live"}`;
            seedAccount({ github: login, role, kind, status, deleted });
            cases.push({
              login,
              expected:
                (role === "owner" || role === "admin") &&
                (kind === "person" || kind === "service") &&
                status === "approved" &&
                !deleted,
            });
          }
        }
      }
    }
    expect(cases.filter((c) => c.expected)).toHaveLength(4);
    for (const c of cases) expect(await exempt(c.login), c.login).toBe(c.expected);
  });
});

describe("the rule is written once", () => {
  test("the exempt roles are owner and admin, and the exempt kinds are person and service", () => {
    expect([...REVIEW_EXEMPT_ROLES]).toEqual(["owner", "admin"]);
    expect([...REVIEW_EXEMPT_KINDS]).toEqual(["person", "service"]);
    // `test` is a real kind that is deliberately left out.
    expect(ACCOUNT_KIND_VALUES).toContain("test");
    expect([...REVIEW_EXEMPT_KINDS] as string[]).not.toContain("test");
  });

  test("the query is built from those lists, and nothing else decides", () => {
    for (const word of [...REVIEW_EXEMPT_ROLES, ...REVIEW_EXEMPT_KINDS]) {
      expect(REVIEW_EXEMPT_SQL).toContain(`'${word}'`);
    }
    expect(REVIEW_EXEMPT_SQL).not.toContain("'member'");
    expect(REVIEW_EXEMPT_SQL).not.toContain("'test'");
  });

  test("the lookup is a search of the case-insensitive GitHub index, not a scan", () => {
    const plan = db.query(`EXPLAIN QUERY PLAN ${REVIEW_EXEMPT_SQL}`).all("anyone") as {
      detail: string;
    }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain("USING INDEX idx_users_github");
    expect(plan.map((p) => p.detail).join("\n")).not.toMatch(/\bSCAN\b/);
  });

  test("no login is written into the review's code", () => {
    // Who is exempt is data in `users`. A login in the review's source would exempt that name in
    // every environment, including a dev worker that shares production's users.
    const dir = join(import.meta.dir, "../src/services");
    const files = readdirSync(dir).filter((f) => /^pr-review.*\.ts$/.test(f));
    expect(files).toContain("pr-review-exemption.ts");
    expect(files.length).toBeGreaterThanOrEqual(4);
    const offending = files.filter((f) =>
      /nemarAdmin|nemarOwner|test-admin|test-owner/i.test(readFileSync(join(dir, f), "utf8")),
    );
    expect(offending).toEqual([]);
  });
});
