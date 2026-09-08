/**
 * POST /datasets: a `test`-kind account may only create `xx` sandbox
 * datasets on production (epic #1272 phase 4, #1284; ADR 0048).
 *
 * ENVIRONMENT is "production" for most of these deliberately: outside
 * production the route forces `sandbox = true` unconditionally, so the
 * real-dataset gate (and this kind check inside it) never runs at all --
 * a non-production test of the REFUSAL could not fail. The "no restriction
 * off production" case below is what pins that the gate is unreachable
 * there, the same way upload-channel-route.test.ts already does for the
 * other two gates it composes with.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, real
 * Hono dispatch through authMiddleware, real hashed tokens. Nothing
 * external is configured, so a request that gets PAST the gate dies at the
 * first external boundary with a 500 and never reaches the network -- that
 * 500 is the "allowed" signal here, exactly as in the sibling route tests.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import { TEST_ACCOUNT_SANDBOX_ONLY_ERROR } from "../src/services/upload-gate";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const API_KEY = "kind-gate-key-0123456789abcdef0123456789abcdef";
const CLI_VERSION = "0.9.16";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function prodEnv(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "production" } as Bindings;
}

function testEnv(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

async function seedUser(accountKind: "person" | "service" | "test"): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access, sandbox_completed, account_kind)
     VALUES ('kindgateuser', 'kindgateuser@example.org', 'x', 'kindgateuser-gh', 'approved',
             'member', 'cli', 1, 1, 1, ?)`,
    [accountKind],
  );
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'kindgateuser'")
    .get();
  if (!row) throw new Error("seed failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(API_KEY),
    API_KEY.slice(0, 8),
  );
}

function cliHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, "X-CLI-Version": CLI_VERSION };
}

function createDataset(env: Bindings, name: string, sandbox: boolean): Promise<Response> {
  return app.request(
    "/datasets",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...cliHeaders() },
      body: JSON.stringify({ name, sandbox }),
    },
    env,
  );
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
});

describe("POST /datasets: test-kind accounts are sandbox-only on production", () => {
  test("a test-kind account creating a real dataset on production gets 403 test_account_sandbox_only", async () => {
    await seedUser("test");
    const res = await createDataset(prodEnv(), "personas-real-attempt", false);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...TEST_ACCOUNT_SANDBOX_ONLY_ERROR });
  });

  test("a test-kind account creating a SANDBOX dataset on production is not refused by this gate", async () => {
    await seedUser("test");
    const res = await createDataset(prodEnv(), "personas-sandbox-attempt", true);
    // Sandbox creation never reaches realDatasetCreateGate at all (it lives
    // inside `if (!sandbox)`), so the kind refusal cannot fire here -- past
    // it the route dies on the unconfigured GitHub auth (a 500), which is
    // the "allowed past the gate" signal the sibling route tests use too.
    expect(res.status).not.toBe(403);
  });

  test("off production there is no restriction: sandbox is forced regardless of kind", async () => {
    await seedUser("test");
    // The route forces `sandbox = true` outside production before the gate
    // is ever consulted, so a `test`-kind account requesting a "real"
    // dataset here is silently treated as a sandbox request -- the same
    // non-production behavior every account kind gets.
    const res = await createDataset(testEnv(), "personas-nonprod-attempt", false);
    expect(res.status).not.toBe(403);
  });

  test("a person account is unaffected by this gate on production", async () => {
    await seedUser("person");
    const res = await createDataset(prodEnv(), "persons-real-attempt", false);
    expect(res.status).not.toBe(403);
    expect(await res.text()).not.toContain(TEST_ACCOUNT_SANDBOX_ONLY_ERROR.error);
  });

  test("a service-kind account is also unaffected by this gate (kind check is test-only)", async () => {
    await seedUser("service");
    const res = await createDataset(prodEnv(), "service-real-attempt", false);
    expect(res.status).not.toBe(403);
    expect(await res.text()).not.toContain(TEST_ACCOUNT_SANDBOX_ONLY_ERROR.error);
  });
});
