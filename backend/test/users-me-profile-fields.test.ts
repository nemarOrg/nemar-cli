/**
 * `GET /users/me` reports the account's identifier state (#1254, ADR 0043).
 *
 * `nemar auth profile` exists so someone refused a duplicate sign-up has
 * somewhere to look, and it can only say "your email is verified, your ORCID
 * link is not" if this route sends those facts. The CLI test drives the
 * command against a local server, so it pins the RENDERING; this pins the
 * SOURCE. Without it, dropping a field here breaks the command with every
 * CLI test still green.
 *
 * Real engine, no mocks: bun:sqlite behind realD1 with every migration
 * applied, the real Hono route behind the real `authMiddleware`, reached with
 * a real hashed API token.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { userRoutes } from "../src/routes/users";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const API_KEY = "nemar_test_key_for_users_me_profile";
const ORCID = "0000-0002-1825-0097";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
}

interface SeedOpts {
  emailVerified?: 0 | 1;
  orcidVerified?: 0 | 1;
  orcid?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  status?: string;
  serviceAccess?: 0 | 1;
}

async function seed(opts: SeedOpts = {}): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, signup_source,
                        email_verified, orcid, orcid_verified, given_name, family_name,
                        role, service_access)
     VALUES ('harlow', 'harlow@example.org', 'x', 'harlow-gh', ?, 'cli', ?, ?, ?, ?, ?, 'member', ?)`,
    [
      opts.status ?? "approved",
      opts.emailVerified ?? 1,
      opts.orcid === undefined ? ORCID : opts.orcid,
      opts.orcidVerified ?? 1,
      opts.givenName === undefined ? "Ada" : opts.givenName,
      opts.familyName === undefined ? "Lovelace" : opts.familyName,
      opts.serviceAccess ?? 1,
    ],
  );
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'harlow'")
    .get();
  if (!row) throw new Error("seed failed");
  db.run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, 'nemar_te')", [
    row.id,
    await hashApiKey(API_KEY),
  ]);
  return row.id;
}

interface MeBody {
  user: {
    status?: string;
    email_verified?: boolean;
    orcid_verified?: boolean;
    given_name?: string | null;
    family_name?: string | null;
    orcid?: string | null;
    service_access?: boolean;
  };
}

function me(): Promise<Response> {
  return app.request("/users/me", { headers: { Authorization: `Bearer ${API_KEY}` } }, env());
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/users", userRoutes);
});

describe("GET /users/me profile fields", () => {
  test("reports tier, both verification flags, and the name parts", async () => {
    await seed();
    const res = await me();
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as MeBody;
    expect(user.status).toBe("approved");
    expect(user.email_verified).toBe(true);
    expect(user.orcid_verified).toBe(true);
    expect(user.given_name).toBe("Ada");
    expect(user.family_name).toBe("Lovelace");
    expect(user.orcid).toBe(ORCID);
    expect(user.service_access).toBe(true);
  });

  test("the two verification flags are independent", async () => {
    // A verified inbox with an UNVERIFIED iD is the common shape: `users.orcid`
    // is populated by DOI discovery for accounts that never signed in through
    // ORCID (`decideVerifiedFlag`). A single conflated flag would report those
    // iDs as proven.
    //
    // `verified` rather than `pending` because the reverse shape cannot reach
    // this route at all: an unverified email is not an active account status
    // (ADR 0040), so `authMiddleware` 403s before the handler runs.
    await seed({ status: "verified", emailVerified: 1, orcidVerified: 0 });
    const { user } = (await (await me()).json()) as MeBody;
    expect(user.email_verified).toBe(true);
    expect(user.orcid_verified).toBe(false);
    expect(user.status).toBe("verified");
  });

  test("an account with no name or iD reports nulls, not empty strings", async () => {
    await seed({ orcid: null, orcidVerified: 0, givenName: null, familyName: null });
    const { user } = (await (await me()).json()) as MeBody;
    expect(user.given_name).toBeNull();
    expect(user.family_name).toBeNull();
    expect(user.orcid).toBeNull();
    expect(user.orcid_verified).toBe(false);
  });
});
