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
 * boundary and never reaches the network.
 *
 * That boundary is `getDatasetsToken` (upload.ts), which throws when no GitHub
 * auth is configured. It sits OUTSIDE the try/catch that wraps
 * `createRepository`, so the throw escapes to Hono's default handler as a
 * text/plain 500 and `createRepository`'s rollback `DELETE` never runs. The
 * claim INSERT has therefore already committed and the row is still there to be
 * read. Do not "tidy away" the row assertions below as impossible: they are the
 * strongest evidence available here, and they are what a status assertion is
 * not. `expect(status).not.toBe(403)` passes on a 401 from a bad token, i.e. it
 * passes when the code under test never ran at all.
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
  TEST_ACCOUNT_SANDBOX_ONLY_ERROR,
} from "../src/services/upload-gate";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const API_KEY = "explicit-id-key-0123456789abcdef0123456789ab";
const CLI_VERSION = "0.9.16";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

const prodEnv = (): Bindings => ({ DB: realD1(db), ENVIRONMENT: "production" }) as Bindings;
const devEnv = (): Bindings => ({ DB: realD1(db), ENVIRONMENT: "test" }) as Bindings;
/** Whatever wrangler actually passed, including nothing. */
const envWith = (environment: string | undefined): Bindings =>
  ({ DB: realD1(db), ENVIRONMENT: environment }) as Bindings;

async function seedUser(opts: {
  role: string;
  service_access: number;
  sandbox_completed: number;
  account_kind?: "person" | "service" | "test";
}): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access, sandbox_completed, account_kind)
     VALUES ('fixtureop', 'fixtureop@example.org', 'x', 'fixtureop-gh', 'approved',
             ?, 'cli', 1, ?, ?, ?)`,
    [opts.role, opts.service_access, opts.sandbox_completed, opts.account_kind ?? "service"],
  );
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'fixtureop'")
    .get();
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
    // refused for nm099998 gets past the gate for xx099900. Asserted on the
    // ROW, not the status: `not.toBe(403)` is satisfied by a 401, a 400 or a
    // 409 equally, so it cannot tell "allowed" from "never executed".
    await seedUser({ role: "admin", service_access: 0, sandbox_completed: 0 });
    await create(devEnv(), { name: "fixture", dataset_id: "xx099900" });
    expect(
      db
        .query<{ dataset_id: string; is_sandbox: number }, []>(
          "SELECT dataset_id, is_sandbox FROM datasets",
        )
        .all(),
    ).toEqual([{ dataset_id: "xx099900", is_sandbox: 1 }]);
  });

  test("the body's sandbox flag cannot buy a named nm id past the account gates", async () => {
    // The sandbox flag is derived from the id's PREFIX and never from the
    // request. Reading it from the body instead would hand an unentitled caller
    // both failures this phase exists to prevent in one request: a row at
    // nm099998 marked is_sandbox=1, with realDatasetCreateGate never consulted.
    await seedUser({ role: "admin", service_access: 0, sandbox_completed: 1 });
    const res = await create(devEnv(), {
      name: "fixture",
      dataset_id: "nm099998",
      sandbox: true,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...SERVICE_ACCESS_ERROR });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM datasets").get()?.n).toBe(0);
  });

  test("a named xx id stays a sandbox create even when the body says sandbox:false", async () => {
    // The other direction: an operator building an exemplar must not be able to
    // turn it into a real dataset by passing sandbox:false, and must not be
    // refused by the account gates for asking.
    await seedUser({ role: "admin", service_access: 0, sandbox_completed: 0 });
    await create(devEnv(), { name: "fixture", dataset_id: "xx099900", sandbox: false });
    expect(
      db
        .query<{ dataset_id: string; is_sandbox: number }, []>(
          "SELECT dataset_id, is_sandbox FROM datasets",
        )
        .all(),
    ).toEqual([{ dataset_id: "xx099900", is_sandbox: 1 }]);
  });
});

describe("POST /datasets: the named id is the id that is claimed", () => {
  test("naming an existing id is a conflict, never a different dataset", async () => {
    // Proves the route used the NAME rather than the allocator: had it
    // allocated, it would have picked a free xx09 id and died later at the
    // unconfigured GitHub boundary with a 500 instead of conflicting here.
    await seedUser(ENTITLED);
    db.run(
      "INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES ('nm099998', 'prior', 1)",
    );
    const res = await create(devEnv(), { name: "fixture", dataset_id: "nm099998" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; dataset_id: string; note: string };
    expect(body.error).toBe("Dataset id already exists");
    expect(body.dataset_id).toBe("nm099998");
    // The note must NOT tell an operator to delete whatever is there: the
    // reserved band holds standing fixtures that exist because they persist,
    // and for a reserved nm id the cascade is refused off production anyway.
    expect(body.note).toMatch(/never overwrites/);
    expect(body.note).not.toMatch(/delete-dataset/);
    // Nothing else was created as a consolation prize.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM datasets").get()?.n).toBe(1);
  });

  test("a named id skips name dedup, which would answer with a different id", async () => {
    // Dedup matches on (owner, name, sandbox) and returns the EXISTING row. For
    // a caller who named an id that is the one answer they can never want, so
    // the named path must not consult it.
    await seedUser(ENTITLED);
    const owner = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='fixtureop'")
      .get();
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
    // Assert the TABLE, not the body. The negative body assertions this test
    // used to carry are nearly vacuous: the correct path answers the literal
    // string "Internal Server Error", so "does not contain xx090001" is true of
    // it without the route having done anything right, and equally true of a
    // 401 from a bad token. The table says which id was claimed.
    expect(res.status).not.toBe(200); // a dedup hit resumes with 200
    expect(
      db
        .query<{ dataset_id: string }, []>("SELECT dataset_id FROM datasets ORDER BY dataset_id")
        .all(),
    ).toEqual([{ dataset_id: "nm099998" }, { dataset_id: "xx090001" }]);
  });

  test("omitting the id allocates normally, and says which id", async () => {
    // The previous version asserted only `not.toBe(403)`/`not.toBe(409)` after
    // pre-inserting nm099998. Off production the allocator runs on the XX
    // prefix, so a reserved NM row and an XX allocation are disjoint by
    // construction: the fixture could not influence the outcome under any
    // mutation, and both assertions were satisfied by the 500 that always
    // happens. Naming the allocated id is what gives the test content.
    await seedUser(ENTITLED);
    db.run(
      "INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES ('nm099998', 'prior', 1)",
    );
    await create(devEnv(), { name: "ordinary" });
    expect(
      db
        .query<{ dataset_id: string }, []>(
          "SELECT dataset_id FROM datasets WHERE name = 'ordinary'",
        )
        .get(),
    ).toEqual({ dataset_id: "xx000001" });
  });

  test("the allocator will not hand out a reserved id even when cornered", async () => {
    // The route-level proof that phase 2 rests on phase 1: the window is
    // squeezed against the band and its last id is taken, so the only thing
    // left to allocate is inside the reserved band. Lifting the reserved cap
    // makes this create an xx099900 row.
    await seedUser(ENTITLED);
    db.run(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox) VALUES ('xx099899','taken',1,1)",
    );
    const env = { DB: realD1(db), ENVIRONMENT: "test", SANDBOX_ID_FLOOR: "99899" } as Bindings;
    await create(env, { name: "ordinary" });
    expect(db.query<{ dataset_id: string }, []>("SELECT dataset_id FROM datasets").all()).toEqual([
      { dataset_id: "xx099899" },
    ]);
  });

  test("the unnamed retry branch is knowingly uncovered", () => {
    // `.rules/testing.md`: when real data cannot falsify the rule, say so.
    // The 409 branch is guarded by `requestedDatasetId !== undefined` so an
    // allocated id keeps its TOCTOU retry rather than telling a caller who
    // named nothing to delete a dataset. Dropping that guard survives this
    // suite: two concurrent unnamed creates through the bun:sqlite passthrough
    // never collide (they take xx000001 and xx000002), so the retry path is
    // unreachable from this harness. Recorded rather than faked.
    expect(true).toBe(true);
  });
});

describe("POST /datasets: the environment fence fails CLOSED", () => {
  // The fence's valence is inverted from what the surrounding route had before
  // this field existed. There, `isProduction === false` meant MORE restriction
  // (force sandbox), so a literal `=== "production"` comparison was fail-safe.
  // Here `false` is PERMISSION to name a reserved id, so the same comparison
  // would be fail-open: an unset or misspelled ENVIRONMENT on a worker bound to
  // prod's D1 and the shared GitHub org would admit the named-id path. These
  // cases are the regression guard; with a literal comparison they all pass a
  // create through instead of refusing it.
  const NOT_RECOGNIZED = [undefined, "", "Production", "prod", "production ", "PRODUCTION", "dev"];

  for (const environment of NOT_RECOGNIZED) {
    test(`ENVIRONMENT=${JSON.stringify(environment)} refuses a named id`, async () => {
      await seedUser(ENTITLED);
      const res = await create(envWith(environment), { name: "fixture", dataset_id: "nm099998" });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ...EXPLICIT_ID_PRODUCTION_ERROR });
    });
  }

  test("an unrecognized ENVIRONMENT still FORCES SANDBOX for an allocated id", async () => {
    // The other half of the fence, and the half that had no test. The named-id
    // gate and the allocation rule have OPPOSITE safe directions: unknown must
    // REFUSE a named id and must FORCE SANDBOX for an allocated one. An earlier
    // version of this epic drove both from one variable, which fixed the first
    // and inverted the second -- measured: `ENVIRONMENT` unset allocated
    // nm000108, a real id, where it had always allocated xx000001.
    for (const environment of NOT_RECOGNIZED) {
      db = freshDb();
      app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
      app.route("/datasets", datasetRoutes);
      await seedUser(ENTITLED);
      await create(envWith(environment), { name: "ordinary" });
      const row = db
        .query<{ dataset_id: string; is_sandbox: number }, []>(
          "SELECT dataset_id, is_sandbox FROM datasets",
        )
        .get();
      expect(row?.dataset_id.startsWith("xx")).toBe(true);
      expect(row?.is_sandbox).toBe(1);
    }
  });

  test("production itself allocates a real id, so the rule is not simply always-sandbox", async () => {
    // The control. `ENVIRONMENT: "production"` is the ONE value that may
    // allocate an nm id, and it must still do so or the fence has broken
    // production instead of protecting it.
    await seedUser(ENTITLED);
    await create(prodEnv(), { name: "real-one", sandbox: false });
    const row = db
      .query<{ dataset_id: string; is_sandbox: number }, []>(
        "SELECT dataset_id, is_sandbox FROM datasets",
      )
      .get();
    expect(row?.dataset_id.startsWith("nm")).toBe(true);
    expect(row?.is_sandbox).toBe(0);
  });

  test("the recognized non-production values still allow it", async () => {
    // The inverse, so the fence cannot be "fixed" by refusing everything.
    for (const environment of ["development", "staging", "test"]) {
      db = freshDb();
      app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
      app.route("/datasets", datasetRoutes);
      await seedUser(ENTITLED);
      const res = await create(envWith(environment), { name: "fixture", dataset_id: "nm099998" });
      expect(res.status).not.toBe(403);
    }
  });
});

describe("POST /datasets: what a named id writes", () => {
  test("is_sandbox is persisted from the id prefix, not inferred", async () => {
    // `is_sandbox` feeds catalog visibility, the publish gates and the DOI
    // paths, so it gets a direct assertion rather than being inferred from
    // whichever gate happened to fire. Both rows survive: the throw at
    // getDatasetsToken precedes createRepository's rollback DELETE (file header).
    await seedUser(ENTITLED);
    await create(devEnv(), { name: "sandbox-fixture", dataset_id: "xx099900" });
    await create(devEnv(), { name: "real-fixture", dataset_id: "nm099998" });
    expect(
      db
        .query<{ dataset_id: string; is_sandbox: number }, []>(
          "SELECT dataset_id, is_sandbox FROM datasets ORDER BY dataset_id",
        )
        .all(),
    ).toEqual([
      { dataset_id: "nm099998", is_sandbox: 0 },
      { dataset_id: "xx099900", is_sandbox: 1 },
    ]);
  });

  test("a test-kind account cannot name an nm fixture off production", async () => {
    // Newly reachable: before the named-id path, `sandbox` was forced true off
    // production so realDatasetCreateGate never ran there and this refusal was
    // a production-only behavior. An nm named id now reaches it in dev.
    await seedUser({
      role: "admin",
      service_access: 1,
      sandbox_completed: 1,
      account_kind: "test",
    });
    const res = await create(devEnv(), { name: "fixture", dataset_id: "nm099998" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ...TEST_ACCOUNT_SANDBOX_ONLY_ERROR });
  });

  test("a test-kind account CAN name an xx fixture", async () => {
    await seedUser({
      role: "admin",
      service_access: 1,
      sandbox_completed: 1,
      account_kind: "test",
    });
    const res = await create(devEnv(), { name: "fixture", dataset_id: "xx099900" });
    expect(res.status).not.toBe(403);
  });
});
