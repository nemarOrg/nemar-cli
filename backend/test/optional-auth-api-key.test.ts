/**
 * `optionalAuthMiddleware`'s bearer path reads keys through the one API-key
 * lookup, `resolveApiKeyUser`, so it refuses exactly what the API refuses.
 *
 * It used to carry its own copy of that SELECT without the `expires_at`
 * predicate, so an EXPIRED key still identified its account on every route
 * behind this middleware (the catalog list with `?mine=true`, the notices
 * feed). Real engine throughout: bun:sqlite behind `realD1` with every
 * migration applied, a real Hono app with the real middleware, real key
 * hashing. No mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { optionalAuthMiddleware } from "../src/middleware/auth";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const KEY = "nm_optional-auth-key-0123456789abcdef0123456";

let db: Database;
let userId: number;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.use("*", optionalAuthMiddleware);
app.get("/probe", (c) =>
  c.json({ user: c.var.user?.username ?? null, attempted: c.var.authAttempted === true }),
);

async function probe(authorization?: string) {
  const res = await app.request(
    "/probe",
    authorization ? { headers: { Authorization: authorization } } : {},
    env(),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { user: string | null; attempted: boolean };
}

async function seedKey(expiresSql = "NULL"): Promise<void> {
  db.run(
    `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, expires_at)
     VALUES (?, ?, ?, ${expiresSql})`,
    [userId, await hashApiKey(KEY), KEY.slice(0, 8)],
  );
}

beforeEach(() => {
  db = freshDb();
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified)
     VALUES ('optional', 'optional@nemar.test', 'x', 'verified', 'member', 'web', 1)`,
  );
  userId =
    db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'optional'").get()?.id ?? 0;
});

describe("optionalAuthMiddleware with an API key", () => {
  test("a live key identifies its account, and its last_used_at is touched", async () => {
    await seedKey();
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: "optional", attempted: true });
    const touched = db
      .query<{ last_used_at: string | null }, [number]>(
        "SELECT last_used_at FROM tokens WHERE user_id = ?",
      )
      .get(userId);
    expect(touched?.last_used_at).not.toBeNull();
  });

  test("an EXPIRED key is ignored, and the attempt is still flagged", async () => {
    await seedKey("datetime('now', '-1 second')");
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: null, attempted: true });
  });

  test("a key whose expiry is still ahead identifies its account", async () => {
    await seedKey("datetime('now', '+1 day')");
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: "optional", attempted: true });
  });

  test("a revoked key is ignored", async () => {
    await seedKey();
    db.run("UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?", [userId]);
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: null, attempted: true });
  });

  test("a key on an inactive account is ignored", async () => {
    await seedKey();
    db.run("UPDATE users SET status = 'pending' WHERE id = ?", [userId]);
    expect(await probe(`Bearer ${KEY}`)).toEqual({ user: null, attempted: true });
  });

  test("a malformed key is ignored, and flagged as an attempt", async () => {
    expect(await probe("Bearer short")).toEqual({ user: null, attempted: true });
  });

  test("no header is anonymous and no attempt", async () => {
    expect(await probe()).toEqual({ user: null, attempted: false });
  });
});
