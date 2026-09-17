/**
 * POST /datasets with a NAMED dataset id (ADR 0068, #1432).
 *
 * The allocator can never return a reserved id, so the standing fixtures that
 * live in that band have no other way in through the route that creates
 * everything else. The alternative was a hand-written D1 INSERT, which is the
 * shortcut that produced a fixture nobody could publish.
 *
 * Two properties are worth more than the rest and are what most of this file
 * is about:
 *
 * 1. Naming an id does NOT exempt the caller from any other create-time gate.
 *    A fixture that skipped the account gates would stop exercising them,
 *    which is the opposite of why it exists.
 * 2. `nemarDatasets` is shared between production and dev, so "non-production"
 *    is not on its own a safe fence: a dev caller naming `nm000104` would
 *    reach a LIVE repository. The reserved-band term is what stops that.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, real Hono
 * dispatch through authMiddleware, real hashed tokens. Nothing external is
 * configured, so a request that gets PAST the gates dies at the first external
 * boundary with a 500 and never reaches the network; that 500 is the "allowed"
 * signal, as in the sibling route tests.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import {
  EXPLICIT_ID_ADMIN_ERROR,
  EXPLICIT_ID_NOT_RESERVED_ERROR,
  EXPLICIT_ID_PRODUCTION_ERROR,
  SANDBOX_TRAINING_ERROR,
  SERVICE_ACCESS_ERROR,
} from "../src/services/upload-gate";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const API_KEY = "explicit-id-key-0123456789abcdef0123456789ab";
const CLI_VERSION = "0.9.16";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

const prodEnv = (): Bindings => ({ DB: realD1(db), ENVIRONMENT: "production" }) as Bindings;
const devEnv = (): Bindings => ({ DB: realD1(db), ENVIRONMENT: "test" }) as Bindings;

async function seedUser(opts: {
  role: string;
  service_access: number;
  sandbox_completed: number;
}): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access, sandbox_completed, account_kind)
     VALUES ('fixtureop', 'fixtureop@example.org', 'x', 'fixtureop-gh', 'approved',
             ?, 'cli', 1, ?, ?, 'service')`,
    [opts.role, opts.service_access, opts.sandbox_completed],
  );
  const row = db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'fixtureop'").get();
  if (!row) throw new Error("seed failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(API_KEY),
    API_KEY.slice(0, 8),
  );
}

/** A fully entitled admin: passes every gate that is not about the id. */
const ENTITLED = { role: "admin", service_access: 1, sandbox_completed: 1 };

function create(env: Bindings, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/datasets",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "X-CLI-Version": CLI_VERSION,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
});

describe("POST /datasets: naming an id is fenced three ways", () => {
  test("production refuses a named id, even a reserved one", async () => {
    await seedUser(ENTITLED);
    const res = await create(prodEnv(), { name: "fixture", dataset_id: "nm099998" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...EXPLICIT_ID_PRODUCTION_ERROR });
  });

  test("a non-admin is refused off production", async () => {
    await seedUser({ role: "member", service_access: 1, sandbox_completed: 1 });
    const res = await create(devEnv(), { name: "fixture", dataset_id: "nm099998" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...EXPLICIT_ID_ADMIN_ERROR });
  });

  test("an admin off production cannot name a LIVE production dataset", async () => {
    // The failure this guards: nemarDatasets is shared between environments,
    // so a dev-side create at nm000104 would reach a live repository. Being
    // non-production is not on its own a fence.
    await seedUser(ENTITLED);
    const res = await create(devEnv(), { name: "fixture", dataset_id: "nm000104" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...EXPLICIT_ID_NOT_RESERVED_ERROR });
  });

  test("an admin off production cannot name an ordinary allocatable id", async () => {
    await seedUser(ENTITLED);
    for (const id of ["nm000108", "nm099899", "xx090001", "xx099899"]) {
      const res = await create(devEnv(), { name: `fixture-${id}`, dataset_id: id });
      expect(res.status).toBe(403);
      expect((await res.json()) as unknown).toEqual({ ...EXPLICIT_ID_NOT_RESERVED_ERROR });
    }
  });

  test("a malformed id is refused as not reserved, not accepted as a name", async () => {
    await seedUser(ENTITLED);
    for (const id of ["nm99998", "nm100000", "zz099998", "", "nm099998; DROP TABLE datasets"]) {
      const res = await create(devEnv(), { name: "fixture", dataset_id: id });
      expect(res.status).toBe(403);
    }
    // The table is still there.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM datasets").get()?.n).toBe(0);
  });
});

describe("POST /datasets: a named id does not exempt any other gate", () => {
  test("an nm fixture still faces the service-access gate", async () => {
    // This is the load-bearing test of the whole phase. The id's PREFIX decides
    // sandbox, so nm099998 is a non-sandbox create and realDatasetCreateGate
    // runs -- exactly as it would for a depositor. If the named-id path had
    // been written to force sandbox, or to skip the account gates "because it
    // is only a fixture", this returns something other than 403.
    await seedUser({ role: "admin", service_access: 0, sandbox_completed: 1 });
    const res = await create(devEnv(), { name: "fixture", dataset_id: "nm099998" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...SERVICE_ACCESS_ERROR });
  });

  test("an nm fixture still faces the CLI sandbox-training gate", async () => {
    // The gate it was most tempting to exempt, since "completed sandbox
    // training" is a human onboarding step and an operator building a fixture
    // is not onboarding. Exempting it is how a fixture stops exercising the
    // thing it exists to exercise, so the operator satisfies the gate instead.
    await seedUser({ role: "admin", service_access: 1, sandbox_completed: 0 });
    const res = await create(devEnv(), { name: "fixture", dataset_id: "nm099998" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...SANDBOX_TRAINING_ERROR });
  });

  test("an xx fixture is a sandbox create, so that gate does not apply to it", async () => {
    // The inverse, which is what proves the sandbox flag is DERIVED from the
    // id rather than hard-coded either way: the same unentitled admin that is
    // refused for nm099998 gets past the gate for xx099900.
    await seedUser({ role: "admin", service_access: 0, sandbox_completed: 0 });
    const res = await create(devEnv(), { name: "fixture", dataset_id: "xx099900" });
    expect(res.status).not.toBe(403);
  });
});

describe("POST /datasets: the named id is the id that is claimed", () => {
  test("naming an existing id is a conflict, never a different dataset", async () => {
    // Proves the route used the NAME rather than the allocator: had it
    // allocated, it would have picked a free xx09 id and died later at the
    // unconfigured GitHub boundary with a 500 instead of conflicting here.
    await seedUser(ENTITLED);
    db.run("INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES ('nm099998', 'prior', 1)");
    const res = await create(devEnv(), { name: "fixture", dataset_id: "nm099998" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; dataset_id: string; note: string };
    expect(body.error).toBe("Dataset id already exists");
    expect(body.dataset_id).toBe("nm099998");
    expect(body.note).toMatch(/delete-dataset/);
    // Nothing else was created as a consolation prize.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM datasets").get()?.n).toBe(1);
  });

  test("a named id skips name dedup, which would answer with a different id", async () => {
    // Dedup matches on (owner, name, sandbox) and returns the EXISTING row. For
    // a caller who named an id that is the one answer they can never want, so
    // the named path must not consult it.
    await seedUser(ENTITLED);
    const owner = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='fixtureop'").get();
    if (!owner) throw new Error("seed failed");
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, visibility, github_repo)
       VALUES ('xx090001', 'fixture', ?, 0, 'private', 'nemarDatasets/xx090001')`,
      [owner.id],
    );
    const res = await create(devEnv(), { name: "fixture", dataset_id: "nm099998" });

    // Both paths end at an unconfigured external boundary, so the STATUS does
    // not distinguish them and an assertion on it proves nothing -- the first
    // version of this test guarded its assertions behind `if (status === 200)`
    // and therefore never ran, surviving a mutation that consulted dedup.
    // The two paths fail at DIFFERENT boundaries and say so: the resume path
    // dies marking S3 private and names the row it found, the named path dies
    // creating the GitHub repository and names nothing.
    // Read as TEXT, not JSON: on the correct path the GitHub auth error
    // propagates to Hono's default handler, which answers "Internal Server
    // Error" in plain text, so `res.json()` throws and the test fails for a
    // reason that has nothing to do with dedup.
    const body = await res.text();
    expect(body).not.toContain("xx090001");
    expect(body).not.toContain("Failed to secure dataset storage");
    expect(body).not.toContain("Resuming existing incomplete dataset");
  });

  test("omitting the id leaves allocation exactly as it was", async () => {
    await seedUser(ENTITLED);
    db.run("INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES ('nm099998', 'prior', 1)");
    // No dataset_id: the allocator runs, is unaffected by the reserved row, and
    // the request proceeds past every gate to the external boundary.
    const res = await create(devEnv(), { name: "ordinary" });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(409);
  });
});
