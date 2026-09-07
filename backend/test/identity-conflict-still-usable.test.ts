/**
 * A flagged account still works (#1254, ADR 0043).
 *
 * Migration 0077 absorbs an existing duplicate by setting
 * `users.identity_conflict = 1`, which makes the row invisible to the partial
 * unique indexes. That is the WHOLE effect it is allowed to have. A flagged
 * row must still sign in, still be readable, still own its datasets -- it has
 * lost its claim on an identifier, not its account.
 *
 * Production row 42 is a real person's account, so this is not a hypothetical:
 * if the flag locked people out, the migration would be a silent mass
 * revocation dressed as a constraint.
 *
 * Driven through the REAL entry points -- `POST /auth/login` with a real
 * hashed API token, and `GET /users/me` behind the real `authMiddleware` --
 * rather than a SELECT, because a SELECT cannot notice a middleware that
 * learned to reject the flag.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { authRoutes } from "../src/routes/auth";
import { userRoutes } from "../src/routes/users";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { realD1 } from "./helpers/d1";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0077_identity_uniqueness.sql";
const SHARED_ORCID = "0000-0002-1974-1293";
const FLAGGED_KEY = "nemar_test_key_for_the_flagged_row";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let flaggedId: number;
let canonicalId: number;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
}

function seed(email: string, identityBacked: boolean): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, signup_source,
                        email_verified, orcid, orcid_verified, role, service_access)
     VALUES (?, ?, 'x', ?, 'approved', 'web', 1, ?, 1, 'member', 1)`,
    [email.split("@")[0], email, `${email.split("@")[0]}-gh`, SHARED_ORCID],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  if (identityBacked) {
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      [row.id, SHARED_ORCID],
    );
  }
  return row.id;
}

beforeEach(async () => {
  // Every migration BEFORE 0077, so the duplicate can be seeded pre-flag and
  // flagged by the real migration rather than by the test. The rest are
  // replayed after the flag lands (below).
  db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  // The orphan first (lower id, no identity row) -- the production 42 shape.
  flaggedId = seed("orphan@example.org", false);
  canonicalId = seed("holder@example.org", true);
  db.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8"));
  // ...and then everything AFTER it, so the routes below run against the
  // CURRENT schema rather than a 2026-09 snapshot of it. Splitting the replay
  // around 0077 is what lets the duplicate be seeded pre-flag; stopping there
  // was an accident of how that was written, and it broke the moment
  // `GET /users/me` first selected a column a later migration adds (#1268's
  // `username_auto_assigned`) -- a 500 that says nothing about identity
  // conflicts, which is what this file is supposed to be about.
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f > TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }

  db.run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, 'nemar_te')", [
    flaggedId,
    await hashApiKey(FLAGGED_KEY),
  ]);

  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authRoutes);
  app.route("/users", userRoutes);
});

describe("a row migration 0077 flagged", () => {
  test("is actually flagged, and the other row is not (the fixture's premise)", () => {
    const flag = (id: number) =>
      db
        .query<{ identity_conflict: number }, [number]>(
          "SELECT identity_conflict FROM users WHERE id = ?",
        )
        .get(id)?.identity_conflict;
    expect(flag(flaggedId)).toBe(1);
    expect(flag(canonicalId)).toBe(0);
  });

  test("can still sign in through POST /auth/login", async () => {
    const res = await app.request(
      "/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: FLAGGED_KEY }),
      },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; user: { username: string } };
    expect(body.valid).toBe(true);
    expect(body.user.username).toBe("orphan");
  });

  test("can still read its own account through GET /users/me", async () => {
    const res = await app.request(
      "/users/me",
      { headers: { Authorization: `Bearer ${FLAGGED_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: number; orcid: string | null } };
    expect(user.id).toBe(flaggedId);
    // It still CARRIES the iD for citation. What it lost is the exclusive
    // claim, which lives in the index, not in the column.
    expect(user.orcid).toBe(SHARED_ORCID);
  });

  test("keeps its upload access", async () => {
    // The flag and the upload grant are unrelated decisions (ADR 0040 owns the
    // grant), and a migration about identifiers must not quietly revoke one.
    const res = await app.request(
      "/users/me",
      { headers: { Authorization: `Bearer ${FLAGGED_KEY}` } },
      env(),
    );
    const { user } = (await res.json()) as { user: { service_access: boolean } };
    expect(user.service_access).toBe(true);
  });
});
