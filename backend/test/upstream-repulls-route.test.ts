/**
 * The `/admin/repulls` routes (epic #1046 phase 6, #1912; ADR 0111, decisions 3 and 6), modelled
 * on `upstream-backfill-route.test.ts`: real SQLite behind `realD1` carrying every migration, the
 * real auth and admin middleware with seeded tokens, the real routes and service.
 *
 * The properties that matter, each with a test that fails when its line is changed:
 *  - outside production only an `xx` dataset is re-pulled, and an unset or unknown ENVIRONMENT
 *    counts as outside production;
 *  - an anonymous, withdrawn, mid-import or non-mirror dataset is refused, each by its own code;
 *  - the dataset's own version rows must agree with the plan;
 *  - one open record per dataset, the same plan twice is the same record, and a tag whose earlier
 *    attempt reached its merge is never pulled again;
 *  - a transition takes only the allowed edge from the recorded status, writes only the columns
 *    the edge names, and cannot state a merge, a release or a screen;
 *  - the lineage word is written only for a row that may take it.
 * Mail is pinned by `repull-no-mail-scan.test.ts`, which scans what the re-pull code imports; this
 * suite has no mail binding, so a route that tried to send would fail here only by accident.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  AUTO_MAX_COPY_BYTES,
  REPULL_STATUSES,
  type RepullStatus,
  TERMINAL_STATUSES,
} from "../../shared/repull-state";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../src/routes/admin/upstream-repulls";
import { deleteDatasetCascade } from "../src/services/deletion";
import { hashApiKey } from "../src/services/token";
import {
  LINEAGE_WRITE_SQL,
  REPULL_PAGE_DEFAULT,
  REPULL_PAGE_MAX,
  transitionRepull,
} from "../src/services/upstream-repull";
import {
  claimFinishDispatch,
  claimOpenDispatch,
  storeDispatchReport,
} from "../src/services/upstream-repull-dispatch";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type RepullGitHub, startRepullGitHub } from "./helpers/repull-github-standin";
import { DIGEST, type Row, SHA, rowAt } from "./helpers/repull-rows";

const ADMIN_KEY = "rpl-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "rpl-member-key-0123456789abcdef0123456789abcdef0";

// biome-ignore lint/suspicious/noExplicitAny: a response body read field by field in assertions
type Json = Record<string, any>;

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

let db: Database;
let app: App;
let adminId = 0;

function newApp(): App {
  const a: App = new Hono();
  a.use("*", authMiddleware);
  a.use("*", adminMiddleware);
  registerUpstreamRepullRoutes(a);
  return a;
}

async function seedUsers(): Promise<void> {
  for (const [name, role, key] of [
    ["rpladmin", "admin", ADMIN_KEY],
    ["rplmember", "member", MEMBER_KEY],
  ] as const) {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('${name}', '${name}@example.org', 'x', 'approved', '${role}', 1)`,
    );
    const u = db.query<{ id: number }, []>(`SELECT id FROM users WHERE username='${name}'`).get();
    if (name === "rpladmin") adminId = u?.id ?? 0;
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      u?.id ?? 0,
      await hashApiKey(key),
      key.slice(0, 8),
    );
  }
}

// The gates and the claim read the live pull request on GitHub; the stand-in answers every one
// open at the fixtures' head, so this suite's edges see the head they name.
let gh: RepullGitHub;
beforeAll(() => {
  gh = startRepullGitHub({ defaultHead: SHA });
});
afterAll(() => gh.stop());

beforeEach(async () => {
  db = freshDb();
  app = newApp();
  await seedUsers();
});

/** An `undefined` environment leaves the binding truly unset: the key is absent, not "test". */
function env(
  environment: string | undefined,
  extra: Record<string, string | undefined> = {},
): Bindings {
  const bindings: Record<string, string | D1Database | undefined> = {
    DB: realD1(db),
    GITHUB_ADMIN_PAT: "ghp_repull_route_test",
    ...extra,
  };
  if (environment !== undefined) bindings.ENVIRONMENT = environment;
  return bindings as unknown as Bindings;
}

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  o: {
    key?: string | null;
    environment?: string | undefined;
    bindings?: Record<string, string | undefined>;
  } = {},
) {
  const key = o.key === undefined ? ADMIN_KEY : o.key;
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const environment = "environment" in o ? o.environment : "test";
  const res = await app.request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env(environment, o.bindings),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

// ----------------------------------------------------------------------------
// Seeds
// ----------------------------------------------------------------------------

interface VersionSeed {
  version: string;
  tag?: string | null;
  basis?: string | null;
}

function seedMirror(
  id: string,
  o: {
    ds?: string;
    source?: string | null;
    sourceId?: string | null;
    anonymous?: boolean;
    withdrawn?: boolean;
    importStatus?: string;
    versions?: VersionSeed[];
  } = {},
): void {
  const ds = o.ds ?? "ds099999";
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, withdrawn_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    adminId,
    o.source === undefined ? "openneuro" : o.source,
    o.sourceId === undefined ? ds : o.sourceId,
    o.anonymous ? 1 : 0,
    o.withdrawn ? "2026-01-01 00:00:00" : null,
  );
  for (const v of o.versions ?? [{ version: "1.0.0", tag: "1.0.0", basis: "doi" }]) {
    db.query(
      `INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, v.version, `10.82901/${id}.v${v.version}`, v.tag ?? null, v.basis ?? null);
  }
  if (o.importStatus) {
    db.query(
      "INSERT INTO import_jobs (dataset_id, source, source_id, status) VALUES (?, 'openneuro', ?, ?)",
    ).run(id, ds, o.importStatus);
  }
}

function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataset_id: "xx090123",
    upstream_ds: "ds099999",
    from_tag: "1.0.0",
    to_tag: "1.0.1",
    from_version: "1.0.0",
    to_version: "2.0.0",
    plan_digest: DIGEST,
    planner: 2,
    base_sha: SHA,
    lineage_recordable: false,
    ...over,
  };
}

/** The claim to merge for a seeded gates_clear row, which names the screened head. */
const CLAIM = { merge_claim_sha: SHA };
const PATCH_CLAIM = { patch_merge_claim_sha: SHA };
/** A claim already held on a seeded row, with the time a Worker would have stamped. */
const HELD = { merge_claimed_at: "2026-10-24 01:00:00", merge_claim_sha: SHA };
const PATCH_HELD = { patch_merge_claimed_at: "2026-10-24 01:00:00", patch_merge_claim_sha: SHA };

const rows = () => db.query("SELECT * FROM upstream_repulls ORDER BY id").all() as Row[];
const audits = (action?: string) =>
  db
    .query("SELECT * FROM audit_log WHERE action LIKE 'repull_%' AND (? IS NULL OR action = ?)")
    .all(action ?? null, action ?? null) as Row[];

function snapshotOf(id: string, version = "1.0.0") {
  return db
    .query(
      "SELECT source_version, source_version_basis FROM dataset_versions WHERE dataset_id = ? AND version = ?",
    )
    .get(id, version);
}

function seedRow(status: RepullStatus, over: Row = {}): number {
  // The mirror `seedMirror` records by default, so a step that re-reads the dataset fences finds it.
  const row = rowAt(status, { actor_user_id: adminId, upstream_ds: "ds099999", ...over });
  const cols = Object.keys(row);
  const r = db
    .query(
      `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...(cols.map((c) => row[c]) as never[]));
  return Number(r.lastInsertRowid);
}

// ----------------------------------------------------------------------------
// Access
// ----------------------------------------------------------------------------

describe("who may call", () => {
  test("a member is refused on all four routes, and nothing is written", async () => {
    seedMirror("xx090123");
    const id = seedRow("planned");
    for (const [m, p, b] of [
      ["POST", "/repulls", plan()],
      ["GET", "/repulls", undefined],
      ["GET", `/repulls/${id}`, undefined],
      ["POST", `/repulls/${id}/transition`, { from: "planned", to: "failed", error: "x" }],
    ] as const) {
      expect((await call(m, p, b, { key: MEMBER_KEY })).status).toBe(403);
    }
    expect(rows().map((r) => r.status)).toEqual(["planned"]);
    expect(audits()).toEqual([]);
  });

  test("a request with no key is refused", async () => {
    expect((await call("GET", "/repulls", undefined, { key: null })).status).toBe(401);
    expect((await call("POST", "/repulls", plan(), { key: null })).status).toBe(401);
  });
});

// ----------------------------------------------------------------------------
// The automatic re-pull's switches (epic #1046 phase 7, #1913)
// ----------------------------------------------------------------------------

describe("GET /repulls/switches", () => {
  test("answers before the :id route does, with the four facts and nothing else", async () => {
    const res = await call("GET", "/repulls/switches");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      switches: {
        environment_is_production: false,
        auto_repull_enabled: false,
        auto_repull_merge_enabled: false,
        open_cap: { value: 2, source: "default" },
        merge_cap: { value: 5, source: "default" },
      },
    });
  });

  test("reads what the bindings say, and only exact production honors a switch", async () => {
    const on = {
      AUTO_REPULL_ENABLED: "1",
      AUTO_REPULL_MERGE_ENABLED: "1",
      REPULL_DAILY_OPEN_CAP: "3",
      REPULL_DAILY_MERGE_CAP: "1",
    };
    const prod = await call("GET", "/repulls/switches", undefined, {
      environment: "production",
      bindings: on,
    });
    expect(prod.body.switches).toEqual({
      environment_is_production: true,
      auto_repull_enabled: true,
      auto_repull_merge_enabled: true,
      open_cap: { value: 3, source: "set" },
      merge_cap: { value: 1, source: "set" },
    });
    for (const environment of ["Production", "development", "staging", undefined]) {
      const res = await call("GET", "/repulls/switches", undefined, { environment, bindings: on });
      expect([environment, res.status, res.body.switches]).toEqual([
        environment,
        200,
        {
          environment_is_production: false,
          auto_repull_enabled: false,
          auto_repull_merge_enabled: false,
          open_cap: { value: 3, source: "set" },
          merge_cap: { value: 1, source: "set" },
        },
      ]);
    }
  });

  test("an unreadable cap is reported as unreadable and reads 0, each cap on its own", async () => {
    const res = await call("GET", "/repulls/switches", undefined, {
      bindings: { REPULL_DAILY_OPEN_CAP: "two", REPULL_DAILY_MERGE_CAP: "3" },
    });
    expect(res.body.switches.open_cap).toEqual({ value: 0, source: "unreadable" });
    expect(res.body.switches.merge_cap).toEqual({ value: 3, source: "set" });
    const other = await call("GET", "/repulls/switches", undefined, {
      bindings: { REPULL_DAILY_MERGE_CAP: "21" },
    });
    expect(other.body.switches.open_cap).toEqual({ value: 2, source: "default" });
    expect(other.body.switches.merge_cap).toEqual({ value: 0, source: "unreadable" });
  });

  test("a member is refused, a missing key is refused, and the report carries no secret", async () => {
    expect((await call("GET", "/repulls/switches", undefined, { key: MEMBER_KEY })).status).toBe(
      403,
    );
    expect((await call("GET", "/repulls/switches", undefined, { key: null })).status).toBe(401);
    const res = await app.request(
      "/repulls/switches",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env("production", {
        AUTO_REPULL_ENABLED: "1",
        PRESCREEN_CALLBACK_SECRET: "super-secret-callback-value",
      }),
    );
    const text = await res.text();
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("super-secret-callback-value");
    expect(text).not.toContain(ADMIN_KEY);
    expect(rows()).toEqual([]);
    expect(audits()).toEqual([]);
  });

  test("an id route still answers a number and refuses a word that is not one", async () => {
    expect((await call("GET", "/repulls/notanumber")).status).toBe(400);
    expect((await call("GET", "/repulls/999")).status).toBe(404);
  });
});

// ----------------------------------------------------------------------------
// Create
// ----------------------------------------------------------------------------

describe("create", () => {
  test("an xx mirror outside production: 201, a planned row, the actor, one audit row", async () => {
    seedMirror("xx090123");
    const res = await call("POST", "/repulls", plan({ counts: { delta_paths: 4 } }));
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.repull).toMatchObject({
      dataset_id: "xx090123",
      upstream_ds: "ds099999",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      attempt: 1,
      from_version: "1.0.0",
      to_version: "2.0.0",
      status: "planned",
      origin: "administrator",
      actor_user_id: adminId,
      planner: 2,
      counts: { delta_paths: 4 },
      terminal_at: null,
    });
    const a = audits("repull_created");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      user_id: adminId,
      resource_type: "upstream_repull",
      resource_id: String(res.body.repull.id),
    });
    const details = JSON.parse(a[0]?.details as string);
    expect(details).toMatchObject({ dataset_id: "xx090123", to_tag: "1.0.1", lineage_rows: 0 });
    expect(JSON.stringify(details)).not.toContain(SHA);
  });

  test("an on mirror in production is accepted", async () => {
    seedMirror("on099999");
    const res = await call("POST", "/repulls", plan({ dataset_id: "on099999" }), {
      environment: "production",
    });
    expect(res.status).toBe(201);
    expect(res.body.repull.dataset_id).toBe("on099999");
  });

  for (const environment of [
    "test",
    "development",
    "staging",
    "Production",
    "prod",
    "",
    undefined,
  ]) {
    test(`an on mirror is refused when ENVIRONMENT is ${JSON.stringify(environment)}, with nothing written`, async () => {
      seedMirror("on099999");
      const res = await call("POST", "/repulls", plan({ dataset_id: "on099999" }), { environment });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("env-fence");
      expect(rows()).toEqual([]);
      expect(audits()).toEqual([]);
      expect(snapshotOf("on099999")).toEqual({
        source_version: "1.0.0",
        source_version_basis: "doi",
      });
    });
  }

  test("an xx mirror is accepted whatever ENVIRONMENT says", async () => {
    seedMirror("xx090123");
    for (const environment of ["production", "staging", undefined]) {
      db.run("DELETE FROM upstream_repulls");
      const res = await call("POST", "/repulls", plan(), { environment });
      expect(res.status).toBe(201);
    }
  });

  test("a dataset that does not exist is 404", async () => {
    const res = await call("POST", "/repulls", plan());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not-found");
  });

  test("a dataset that is not a mirror of that ds is refused", async () => {
    seedMirror("xx090123", { source: "nemar-exemplar", sourceId: null });
    expect((await call("POST", "/repulls", plan())).body.code).toBe("not-a-mirror");
    db.run("DELETE FROM dataset_versions");
    db.run("DELETE FROM datasets");
    seedMirror("xx090123", { sourceId: "ds000001" });
    expect((await call("POST", "/repulls", plan())).body.code).toBe("not-a-mirror");
    expect(rows()).toEqual([]);
  });

  test("an anonymous dataset is refused with no override", async () => {
    seedMirror("xx090123", { anonymous: true });
    const res = await call("POST", "/repulls", plan({ lineage_recordable: true }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("anonymous-dataset");
    expect(rows()).toEqual([]);
  });

  test("a withdrawn dataset is refused", async () => {
    seedMirror("xx090123", { withdrawn: true });
    const res = await call("POST", "/repulls", plan());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("withdrawn");
  });

  for (const importStatus of ["preparing", "copying", "finalizing"]) {
    test(`an import that is ${importStatus} refuses`, async () => {
      seedMirror("xx090123", { importStatus });
      const res = await call("POST", "/repulls", plan());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("import-in-flight");
    });
  }

  for (const importStatus of ["complete", "failed", "quarantined", "rolled_back"]) {
    test(`an import that is ${importStatus} does not refuse`, async () => {
      seedMirror("xx090123", { importStatus });
      expect((await call("POST", "/repulls", plan())).status).toBe(201);
    });
  }

  test("the same plan twice is the same record, 200, with no second audit row", async () => {
    seedMirror("xx090123");
    const first = await call("POST", "/repulls", plan());
    const second = await call("POST", "/repulls", plan());
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.repull.id).toBe(first.body.repull.id);
    expect(rows()).toHaveLength(1);
    expect(audits("repull_created")).toHaveLength(1);
  });

  test("a record further along is returned for its own plan, so a rerun resumes", async () => {
    seedMirror("xx090123");
    const id = seedRow("pr_open");
    const res = await call("POST", "/repulls", plan());
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.repull).toMatchObject({ id, status: "pr_open" });
  });

  test("a rerun after the merge still finds its record, though the version rows moved on", async () => {
    seedMirror("xx090123", {
      versions: [
        { version: "1.0.0", tag: "1.0.0", basis: "doi" },
        { version: "2.0.0", tag: "1.0.1", basis: "doi" },
      ],
    });
    const id = seedRow("released");
    const res = await call("POST", "/repulls", plan());
    expect([res.status, res.body.created, res.body.repull.id]).toEqual([200, false, id]);
    // A different plan is still refused by the open record, not by the version rows.
    const other = await call("POST", "/repulls", plan({ plan_digest: `sha256:${"1".repeat(64)}` }));
    expect(other.body.code).toBe("repull-in-flight");
  });

  test("another digest for the same tag, or another tag, is repull-in-flight and names the record", async () => {
    seedMirror("xx090123");
    const first = await call("POST", "/repulls", plan());
    const other = await call("POST", "/repulls", plan({ plan_digest: `sha256:${"1".repeat(64)}` }));
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("repull-in-flight");
    expect(other.body.repull.id).toBe(first.body.repull.id);
    expect(other.body.error).toContain(`#${first.body.repull.id}`);
    const tag = await call("POST", "/repulls", plan({ to_tag: "1.0.2" }));
    expect(tag.status).toBe(409);
    expect(tag.body.code).toBe("repull-in-flight");
    expect(rows()).toHaveLength(1);
  });

  test("a request that breaks the shape is 400 and writes nothing", async () => {
    seedMirror("xx090123");
    const bad: Array<[string, Record<string, unknown>]> = [
      ["a to_version that is not the next major", { to_version: "1.1.0" }],
      ["a to_version that skips a major", { to_version: "3.0.0" }],
      ["the same tag on both ends", { to_tag: "1.0.0" }],
      ["the same tag with a v", { to_tag: "v1.0.0" }],
      ["a tag with a slash", { to_tag: "a/b" }],
      ["a tag with a range", { to_tag: "1..2" }],
      ["an upstream_ds that is not a ds", { upstream_ds: "on099999" }],
      ["a digest of the wrong shape", { plan_digest: "sha256:abc" }],
      ["a base_sha of the wrong shape", { base_sha: "HEAD" }],
      ["a counts key that is not declared", { counts: { "sub-01/eeg.edf": 1 } }],
      ["a negative count", { counts: { written: -1 } }],
      ["an unknown field", { origin: "automatic" }],
      ["a lineage_recordable that is not a boolean", { lineage_recordable: "yes" }],
      ["a dataset id that is not valid", { dataset_id: "xx900001" }],
    ];
    for (const [what, over] of bad) {
      const res = await call("POST", "/repulls", plan(over));
      expect([what, res.status]).toEqual([what, 400]);
    }
    expect(rows()).toEqual([]);
  });
});

describe("create: a concurrent create wins the slot between the read and the write", () => {
  /** A D1 that, just before the INSERT is prepared, lets another create in. */
  function racing(winner: Row): D1Database {
    const real = realD1(db);
    let done = false;
    return {
      ...real,
      prepare(sql: string) {
        if (sql.startsWith("INSERT INTO upstream_repulls") && !done) {
          done = true;
          const cols = Object.keys(winner);
          db.query(
            `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          ).run(...(cols.map((c) => winner[c]) as never[]));
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
  }

  const post = (d1: D1Database, body: Record<string, unknown>) =>
    app.request(
      "/repulls",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      {
        DB: d1,
        ENVIRONMENT: "test",
        GITHUB_ADMIN_PAT: "ghp_repull_route_test",
      } as unknown as Bindings,
    );

  test("the same plan: the winner's record is returned, 200, and nothing is half written", async () => {
    seedMirror("xx090123");
    const res = await post(
      racing(rowAt("planned", { dataset_id: "xx090123", actor_user_id: adminId })),
      plan(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).created).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(audits()).toEqual([]);
  });

  test("another plan: repull-in-flight, and the lineage write rolled back with the insert", async () => {
    seedMirror("xx090123");
    const winner = rowAt("planned", {
      dataset_id: "xx090123",
      actor_user_id: adminId,
      plan_digest: `sha256:${"2".repeat(64)}`,
    });
    const res = await post(racing(winner), plan({ lineage_recordable: true }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).code).toBe("repull-in-flight");
    expect(rows()).toHaveLength(1);
    expect(snapshotOf("xx090123")).toEqual({
      source_version: "1.0.0",
      source_version_basis: "doi",
    });
  });
});

describe("create: the dataset's own version rows must agree with the plan", () => {
  const refused = async (over: Record<string, unknown> = {}) => {
    const res = await call("POST", "/repulls", plan(over));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("version-facts-disagree");
    expect(rows()).toEqual([]);
  };

  test("a from_version that is not the highest row is refused", async () => {
    seedMirror("xx090123", {
      versions: [
        { version: "1.0.0", tag: "1.0.0", basis: "doi" },
        { version: "1.1.0", tag: "1.0.0", basis: "doi" },
      ],
    });
    await refused();
  });

  test("the highest row is found by number, not by string", async () => {
    seedMirror("xx090123", {
      versions: [
        { version: "9.0.0", tag: "1.0.0", basis: "doi" },
        { version: "10.0.0", tag: "1.0.0", basis: "doi" },
      ],
    });
    await refused({ from_version: "9.0.0", to_version: "10.0.0" });
    const ok = await call(
      "POST",
      "/repulls",
      plan({ from_version: "10.0.0", to_version: "11.0.0" }),
    );
    expect(ok.status).toBe(201);
  });

  test("a v-spelled row counts, in the highest position and below it", async () => {
    seedMirror("xx090123", {
      versions: [
        { version: "v1.0.0", tag: "1.0.0", basis: "doi" },
        { version: "0.9.0", tag: "0.9.0", basis: "doi" },
      ],
    });
    expect((await call("POST", "/repulls", plan())).status).toBe(201);
  });

  test("a dataset with no version row is refused", async () => {
    seedMirror("xx090123", { versions: [] });
    await refused();
  });

  test("a from_tag that is not the recorded one is refused", async () => {
    seedMirror("xx090123", { versions: [{ version: "1.0.0", tag: "0.9.0", basis: "doi" }] });
    await refused();
  });

  test("a recorded tag that differs only by a leading v is the same tag", async () => {
    seedMirror("xx090123", { versions: [{ version: "1.0.0", tag: "v1.0.0", basis: "doi" }] });
    expect((await call("POST", "/repulls", plan())).status).toBe(201);
  });

  test("an unknown tag is never re-pulled, whatever the plan says", async () => {
    seedMirror("xx090123", { versions: [{ version: "1.0.0", tag: null, basis: "unknown" }] });
    await refused({ lineage_recordable: true });
  });

  test("a row never examined needs a plan that establishes the lineage", async () => {
    seedMirror("xx090123", { versions: [{ version: "1.0.0", tag: null, basis: null }] });
    await refused({ lineage_recordable: false });
    const ok = await call("POST", "/repulls", plan({ lineage_recordable: true }));
    expect(ok.status).toBe(201);
  });
});

describe("create: attempts", () => {
  test("a new attempt is allowed after abandoned, failed or superseded, and numbered", async () => {
    seedMirror("xx090123");
    let expected = 1;
    for (const status of ["abandoned", "failed", "superseded"] as const) {
      const first = await call("POST", "/repulls", plan());
      expect(first.body.repull.attempt).toBe(expected);
      db.run(
        `UPDATE upstream_repulls SET status = '${status}', terminal_at = datetime('now') WHERE id = ${first.body.repull.id}`,
      );
      expected++;
    }
    const last = await call("POST", "/repulls", plan());
    expect(last.status).toBe(201);
    expect(last.body.repull.attempt).toBe(4);
  });

  test("an attempt that reached its merge blocks the tag, however it ended", async () => {
    seedMirror("xx090123");
    for (const status of ["complete", "patch_declined"] as const) {
      db.run("DELETE FROM upstream_repulls");
      seedRow(status);
      const res = await call("POST", "/repulls", plan());
      expect([status, res.status, res.body.code]).toEqual([status, 409, "tag-already-pulled"]);
    }
  });

  test("a failed, abandoned or superseded attempt that holds a merge sha blocks the whole dataset", async () => {
    seedMirror("xx090123");
    for (const status of ["failed", "abandoned", "superseded"] as const) {
      db.run("DELETE FROM upstream_repulls");
      seedRow(status, { merge_sha: SHA });
      for (const to_tag of ["1.0.1", "1.0.9"]) {
        const res = await call("POST", "/repulls", plan({ to_tag }));
        expect([status, to_tag, res.status, res.body.code]).toEqual([
          status,
          to_tag,
          409,
          "merge-unreconciled",
        ]);
      }
    }
    expect(rows().map((r) => r.status)).toEqual(["superseded"]);
  });

  test("a failed attempt that recorded a claim through the API blocks the dataset, for any tag", async () => {
    seedMirror("xx090123");
    const id = seedRow("gates_clear");
    const claim = await move(id, { from: "gates_clear", to: "gates_clear", fields: CLAIM });
    expect(claim.status).toBe(200);
    const failed = await move(id, {
      from: "gates_clear",
      to: "failed",
      error: "merge answer lost",
    });
    expect(failed.status).toBe(200);
    for (const to_tag of ["1.0.1", "1.0.2"]) {
      const res = await call("POST", "/repulls", plan({ to_tag }));
      expect([to_tag, res.status, res.body.code]).toEqual([to_tag, 409, "merge-unreconciled"]);
      expect(res.body.error).toContain(`#${id}`);
    }
    expect(rows()).toHaveLength(1);
  });

  test("the claim or merge of N.0.1 blocks the dataset too", async () => {
    seedMirror("xx090123");
    for (const over of [PATCH_HELD, { patch_merge_sha: SHA }]) {
      db.run("DELETE FROM upstream_repulls");
      seedRow("failed", over);
      const res = await call("POST", "/repulls", plan({ to_tag: "1.0.2" }));
      expect([JSON.stringify(over), res.status, res.body.code]).toEqual([
        JSON.stringify(over),
        409,
        "merge-unreconciled",
      ]);
    }
  });

  test("a finished merge does not block the dataset: complete and patch_declined are reconciled", async () => {
    seedMirror("xx090123");
    for (const status of ["complete", "patch_declined"] as const) {
      db.run("DELETE FROM upstream_repulls");
      seedRow(status, { patch_merge_sha: null });
      const res = await call("POST", "/repulls", plan({ to_tag: "1.0.2" }));
      expect([status, res.status]).toEqual([status, 201]);
    }
  });

  test("a failed attempt that was merged and tagged is reconciled, but its tag stays pulled", async () => {
    seedMirror("xx090123");
    seedRow("failed", { merge_sha: SHA, tag_sha: SHA });
    const other = await call("POST", "/repulls", plan({ to_tag: "1.0.2" }));
    expect(other.status).toBe(201);
    db.run("DELETE FROM upstream_repulls");
    seedRow("failed", { merge_sha: SHA, tag_sha: SHA });
    const same = await call("POST", "/repulls", plan());
    expect([same.status, same.body.code]).toEqual([409, "tag-already-pulled"]);
  });

  test("a failed attempt with a merge or claim and no tag, or with anything of N.0.1, is not reconciled", async () => {
    seedMirror("xx090123");
    const shapes: Array<[string, Row]> = [
      ["a merge sha and no tag", { merge_sha: SHA }],
      ["a claim and no tag", HELD],
      ["a merge, a tag and a patch claim", { merge_sha: SHA, tag_sha: SHA, ...PATCH_HELD }],
      ["a merge, a tag and a patch merge", { merge_sha: SHA, tag_sha: SHA, patch_merge_sha: SHA }],
    ];
    for (const [what, over] of shapes) {
      db.run("DELETE FROM upstream_repulls");
      seedRow("failed", over);
      const res = await call("POST", "/repulls", plan({ to_tag: "1.0.2" }));
      expect([what, res.status, res.body.code]).toEqual([what, 409, "merge-unreconciled"]);
    }
  });

  test("a failed attempt that never claimed or merged frees the dataset", async () => {
    seedMirror("xx090123");
    seedRow("failed");
    expect((await call("POST", "/repulls", plan())).status).toBe(201);
  });

  test("tags are compared and stored without a leading v", async () => {
    seedMirror("xx090123");
    const res = await call("POST", "/repulls", plan({ from_tag: "v1.0.0", to_tag: "v1.0.1" }));
    expect(res.status).toBe(201);
    expect(res.body.repull).toMatchObject({ from_tag: "1.0.0", to_tag: "1.0.1" });
    db.run(
      "UPDATE upstream_repulls SET status = 'complete', terminal_at = datetime('now'), synth_tree = 'b', synth_sha = 'b', branch = 'release/v2.0.0', pr_number = 1, head_sha = 'a', merge_sha = 'a', tag_sha = 'a'",
    );
    const again = await call("POST", "/repulls", plan({ to_tag: "v1.0.1" }));
    expect([again.status, again.body.code]).toEqual([409, "tag-already-pulled"]);
  });

  test("another tag is free after a finished attempt at this one", async () => {
    seedMirror("xx090123");
    seedRow("complete");
    const res = await call("POST", "/repulls", plan({ to_tag: "1.0.2" }));
    expect(res.status).toBe(201);
    expect(res.body.repull.attempt).toBe(1);
  });
});

describe("create: the lineage word", () => {
  test("a recordable plan upgrades a doi row for the same tag, and says so in the audit row", async () => {
    seedMirror("xx090123");
    const res = await call("POST", "/repulls", plan({ lineage_recordable: true }));
    expect(res.status).toBe(201);
    expect(snapshotOf("xx090123")).toEqual({
      source_version: "1.0.0",
      source_version_basis: "lineage",
    });
    expect(JSON.parse(audits("repull_created")[0]?.details as string)).toMatchObject({
      lineage_recordable: true,
      lineage_rows: 1,
    });
  });

  test("a recordable plan upgrades a row never examined", async () => {
    seedMirror("xx090123", { versions: [{ version: "1.0.0", tag: null, basis: null }] });
    await call("POST", "/repulls", plan({ lineage_recordable: true }));
    expect(snapshotOf("xx090123")).toEqual({
      source_version: "1.0.0",
      source_version_basis: "lineage",
    });
  });

  test("a plan that is not recordable writes nothing", async () => {
    seedMirror("xx090123");
    await call("POST", "/repulls", plan({ lineage_recordable: false }));
    expect(snapshotOf("xx090123")).toEqual({
      source_version: "1.0.0",
      source_version_basis: "doi",
    });
  });

  test("only the from-version is upgraded, in either spelling", async () => {
    seedMirror("xx090123", {
      versions: [
        { version: "0.9.0", tag: "1.0.0", basis: "doi" },
        { version: "v1.0.0", tag: "1.0.0", basis: "doi" },
      ],
    });
    await call("POST", "/repulls", plan({ lineage_recordable: true }));
    expect(snapshotOf("xx090123", "v1.0.0")).toEqual({
      source_version: "1.0.0",
      source_version_basis: "lineage",
    });
    expect(snapshotOf("xx090123", "0.9.0")).toEqual({
      source_version: "1.0.0",
      source_version_basis: "doi",
    });
  });

  test("the statement itself never overwrites a row it should not, whatever calls it", () => {
    seedMirror("xx090123", { versions: [{ version: "1.0.0", tag: null, basis: "unknown" }] });
    seedMirror("xx090124", { versions: [{ version: "1.0.0", tag: "0.9.0", basis: "doi" }] });
    seedMirror("xx090125", { versions: [{ version: "1.0.0", tag: "0.9.0", basis: "lineage" }] });
    for (const id of ["xx090123", "xx090124", "xx090125"]) {
      const before = snapshotOf(id);
      db.query(LINEAGE_WRITE_SQL).run("1.0.0", id, "1.0.0");
      expect(snapshotOf(id)).toEqual(before);
    }
  });
});

// ----------------------------------------------------------------------------
// Read
// ----------------------------------------------------------------------------

describe("read", () => {
  test("GET one, 404 for none, 400 for a bad id", async () => {
    seedMirror("xx090123");
    const made = await call("POST", "/repulls", plan());
    const one = await call("GET", `/repulls/${made.body.repull.id}`);
    expect(one.status).toBe(200);
    expect(one.body.repull.id).toBe(made.body.repull.id);
    expect((await call("GET", "/repulls/999")).status).toBe(404);
    for (const bad of ["0", "-1", "1.5", "abc", "01"]) {
      expect((await call("GET", `/repulls/${bad}`)).status).toBe(400);
    }
  });

  test("the list pages by keyset, newest first, and filters", async () => {
    seedRow("complete", { dataset_id: "xx090121" });
    seedRow("abandoned", { dataset_id: "xx090122", to_tag: "1.0.1" });
    seedRow("planned", { dataset_id: "xx090122", to_tag: "1.0.2", attempt: 2 });
    seedRow("planned", { dataset_id: "xx090123" });
    const all = await call("GET", "/repulls");
    expect(all.body.repulls.map((r: Row) => r.id)).toEqual([4, 3, 2, 1]);
    const page1 = await call("GET", "/repulls?limit=2");
    expect(page1.body.repulls.map((r: Row) => r.id)).toEqual([4, 3]);
    expect(page1.body.next_after).toBe(3);
    const page2 = await call("GET", `/repulls?limit=2&after=${page1.body.next_after}`);
    expect(page2.body.repulls.map((r: Row) => r.id)).toEqual([2, 1]);
    const open = await call("GET", "/repulls?open=1");
    expect(open.body.repulls.map((r: Row) => r.id)).toEqual([4, 3]);
    const ds = await call("GET", "/repulls?dataset=xx090122");
    expect(ds.body.repulls.map((r: Row) => r.id)).toEqual([3, 2]);
    expect((await call("GET", "/repulls?dataset=xx090122&open=true")).body.repulls).toHaveLength(1);
  });

  test("a bad query is 400, and a limit past 50 is refused rather than clamped", async () => {
    for (const q of ["limit=0", "limit=51", "limit=x", "open=maybe", "after=x", "dataset=bad"]) {
      expect([q, (await call("GET", `/repulls?${q}`)).status]).toEqual([q, 400]);
    }
  });
});

// ----------------------------------------------------------------------------
// Transition
// ----------------------------------------------------------------------------

const move = (id: number, body: Record<string, unknown>, o?: Parameters<typeof call>[3]) =>
  call("POST", `/repulls/${id}/transition`, body, o);

const rowOf = (id: number) =>
  db.query("SELECT * FROM upstream_repulls WHERE id = ?").get(id) as Row;

describe("transition: the path N.0.0 takes through this route", () => {
  test("planned to pr_open, each step audited, counts merged and never replaced", async () => {
    seedMirror("xx090123");
    const id = (await call("POST", "/repulls", plan({ counts: { delta_paths: 4 } }))).body.repull
      .id;

    const prepared = await move(id, {
      from: "planned",
      to: "prepared",
      fields: {
        synth_tree: "b".repeat(40),
        synth_sha: "c".repeat(40),
        manifest_digest: DIGEST,
        counts: { written: 3 },
      },
    });
    expect(prepared.status).toBe(200);
    expect(prepared.body.repull).toMatchObject({
      status: "prepared",
      synth_sha: "c".repeat(40),
      counts: { delta_paths: 4, written: 3 },
    });

    expect(
      (await move(id, { from: "prepared", to: "copied", fields: { counts: { copied: 9 } } }))
        .status,
    ).toBe(200);
    expect((await move(id, { from: "copied", to: "registered" })).status).toBe(200);
    const open = await move(id, {
      from: "registered",
      to: "pr_open",
      fields: { branch: "release/v2.0.0", pr_number: 12, head_sha: "d".repeat(40) },
    });
    expect(open.body.repull).toMatchObject({
      status: "pr_open",
      pr_number: 12,
      counts: { delta_paths: 4, written: 3, copied: 9 },
      terminal_at: null,
    });
    expect(audits("repull_transition")).toHaveLength(4);
    const last = JSON.parse(audits("repull_transition").at(-1)?.details as string);
    expect(last).toEqual({
      dataset_id: "xx090123",
      from: "registered",
      to: "pr_open",
      fields: ["branch", "pr_number", "head_sha"],
    });
  });

  test("a step that repeats sends the stage again, and the pull request does not change", async () => {
    const id = seedRow("pr_open");
    const again = {
      branch: "release/v2.0.0",
      pr_number: 7,
      head_sha: "e".repeat(40),
    };
    const ok = await move(id, { from: "pr_open", to: "pr_open", fields: again });
    expect(ok.status).toBe(200);
    expect(rowOf(id).head_sha).toBe("e".repeat(40));
    const other = await move(id, {
      from: "pr_open",
      to: "pr_open",
      fields: { ...again, pr_number: 8 },
    });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("immutable-field");
    expect(rowOf(id).pr_number).toBe(7);
  });

  test("going back from gates_clear clears the gates sha", async () => {
    const id = seedRow("gates_clear", { gates_sha: "f".repeat(40) });
    const res = await move(id, {
      from: "gates_clear",
      to: "pr_open",
      fields: { branch: "release/v2.0.0", pr_number: 7, head_sha: "e".repeat(40) },
    });
    expect(res.status).toBe(200);
    expect(rowOf(id)).toMatchObject({
      status: "pr_open",
      gates_sha: null,
      head_sha: "e".repeat(40),
    });
  });
});

describe("transition: what is refused", () => {
  test("a stale from is 409 with the row unchanged and no audit row", async () => {
    const id = seedRow("prepared");
    const before = rowOf(id);
    const res = await move(id, {
      from: "planned",
      to: "prepared",
      fields: { synth_tree: SHA, synth_sha: SHA, manifest_digest: DIGEST },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale-status");
    expect(res.body.repull.status).toBe("prepared");
    expect(rowOf(id)).toEqual(before);
    expect(audits()).toEqual([]);
  });

  test("a compare-and-set that loses the race leaves the row as the winner wrote it", async () => {
    // The row is read at planned, then moved to abandoned by another writer before the update
    // runs: the update's own WHERE status = ? must refuse it.
    const id = seedRow("planned");
    const real = realD1(db);
    let moved = false;
    const racing = {
      ...real,
      prepare(sql: string) {
        if (sql.startsWith("UPDATE upstream_repulls") && !moved) {
          moved = true;
          db.run(
            `UPDATE upstream_repulls SET status = 'abandoned', terminal_at = datetime('now') WHERE id = ${id}`,
          );
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const res = await app.request(
      `/repulls/${id}/transition`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "planned",
          to: "prepared",
          fields: { synth_tree: SHA, synth_sha: SHA, manifest_digest: DIGEST },
        }),
      },
      {
        DB: racing,
        ENVIRONMENT: "test",
        GITHUB_ADMIN_PAT: "ghp_repull_route_test",
      } as unknown as Bindings,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Json;
    expect(body.code).toBe("stale-status");
    expect(body.error).toContain("moved before this write");
    expect(rowOf(id).status).toBe("abandoned");
    expect(rowOf(id).synth_sha).toBeNull();
    expect(audits("repull_transition")).toEqual([]);
  });

  test("an edge that does not exist is bad-transition, for every pair from a terminal row", async () => {
    for (const status of TERMINAL_STATUSES) {
      db.run("DELETE FROM upstream_repulls");
      const id = seedRow(status);
      for (const to of REPULL_STATUSES) {
        const res = await move(id, { from: status, to, error: "x" });
        expect([status, to, res.status, res.body.code]).toEqual([
          status,
          to,
          409,
          "bad-transition",
        ]);
      }
      expect(rowOf(id).status).toBe(status);
    }
  });

  test("a skipped step is bad-transition", async () => {
    const id = seedRow("planned");
    const res = await move(id, { from: "planned", to: "copied" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("bad-transition");
  });

  test("a merge, a release and their patch twins cannot be stated here", async () => {
    const cases: Array<[RepullStatus, RepullStatus, Record<string, unknown>]> = [
      ["gates_clear", "merged", { merge_sha: SHA }],
      ["merged", "released", { tag_sha: SHA }],
      ["patch_gates_clear", "patch_merged", { patch_merge_sha: SHA }],
      ["patch_merged", "patch_released", { patch_tag_sha: SHA }],
    ];
    for (const [from, to, fields] of cases) {
      db.run("DELETE FROM upstream_repulls");
      const id = seedRow(from, from === "merged" ? { merge_sha: SHA } : {});
      const before = rowOf(id);
      const res = await move(id, { from, to, fields });
      expect([to, res.status, res.body.code]).toEqual([to, 409, "use-verified-route"]);
      expect(rowOf(id)).toEqual(before);
    }
  });

  test("the screen's states cannot be stated here: the screen bound to the row must pass", async () => {
    // An `on` dataset in production with no screen recorded: the Worker reads the screen itself,
    // so stating the gates sha is not enough (the screen's own suite covers a passing screen).
    seedMirror("on099999");
    const cases: Array<[RepullStatus, RepullStatus, Record<string, unknown>]> = [
      ["pr_open", "gates_clear", { gates_sha: SHA }],
      ["patch_synthesized", "patch_gates_clear", { patch_gates_sha: SHA }],
    ];
    for (const [from, to, fields] of cases) {
      db.run("DELETE FROM upstream_repulls");
      const id = seedRow(from, { dataset_id: "on099999" });
      const res = await move(id, { from, to, fields }, { environment: "production" });
      expect([to, res.status, res.body.code]).toEqual([to, 409, "screen-not-clear"]);
      expect(rowOf(id).status).toBe(from);
    }
  });

  test("a column outside the edge's list is 400, including one that is a real column", async () => {
    const id = seedRow("planned");
    for (const fields of [
      { merge_sha: SHA },
      { status: "released" },
      { terminal_at: "2026-01-01 00:00:00" },
      { actor_user_id: 1 },
      { synth_tree: SHA, synth_sha: SHA, manifest_digest: DIGEST, tag_sha: SHA },
      { "synth_tree = 'x', status": "y" },
    ]) {
      const res = await move(id, { from: "planned", to: "prepared", fields });
      expect([JSON.stringify(Object.keys(fields)), res.status, res.body.code]).toEqual([
        JSON.stringify(Object.keys(fields)),
        400,
        "field-not-allowed",
      ]);
    }
    expect(rowOf(id).status).toBe("planned");
  });

  test("a missing required column is 400", async () => {
    const id = seedRow("planned");
    for (const missing of ["synth_tree", "synth_sha", "manifest_digest"]) {
      const fields: Record<string, unknown> = {
        synth_tree: SHA,
        synth_sha: SHA,
        manifest_digest: DIGEST,
      };
      delete fields[missing];
      const res = await move(id, { from: "planned", to: "prepared", fields });
      expect([missing, res.status, res.body.code]).toEqual([missing, 400, "field-missing"]);
    }
    const bare = await move(id, { from: "planned", to: "prepared" });
    expect(bare.body.code).toBe("field-missing");
  });

  test("a badly shaped value is 400", async () => {
    const id = seedRow("registered", {});
    const base = { branch: "release/v2.0.0", pr_number: 12, head_sha: SHA };
    for (const [key, value] of [
      ["head_sha", "HEAD"],
      ["head_sha", SHA.toUpperCase()],
      ["pr_number", 0],
      ["pr_number", "12"],
      ["branch", "main"],
      ["branch", "release/v3.0.0"],
    ] as const) {
      const res = await move(id, {
        from: "registered",
        to: "pr_open",
        fields: { ...base, [key]: value },
      });
      expect([key, value, res.status, res.body.code]).toEqual([key, value, 400, "field-invalid"]);
    }
    const counts = await move(id, {
      from: "registered",
      to: "pr_open",
      fields: { ...base, counts: { path: 1 } },
    });
    expect(counts.body.code).toBe("field-invalid");
    expect(rowOf(id).status).toBe("registered");
  });

  test("a closing edge is refused while a merge claim is held, for either pull request", async () => {
    const cases: Array<[RepullStatus, RepullStatus, Row]> = [
      ["gates_clear", "abandoned", HELD],
      ["gates_clear", "superseded", HELD],
      ["patch_gates_clear", "patch_declined", PATCH_HELD],
    ];
    for (const [from, to, over] of cases) {
      db.run("DELETE FROM upstream_repulls");
      const id = seedRow(from, over);
      const res = await move(id, { from, to });
      expect([to, res.status, res.body.code]).toEqual([to, 409, "merge-claim-held"]);
      expect(rowOf(id).status).toBe(from);
    }
    // failed is not a closing of the pull request: nothing is closed, so a held claim does not block it
    db.run("DELETE FROM upstream_repulls");
    const id = seedRow("gates_clear", HELD);
    expect(
      (await move(id, { from: "gates_clear", to: "failed", error: "tag-mismatch" })).status,
    ).toBe(200);
  });
});

describe("transition: closing a record", () => {
  test("abandoned sets terminal_at and frees the dataset's slot", async () => {
    seedMirror("xx090123");
    const id = (await call("POST", "/repulls", plan())).body.repull.id;
    const res = await move(id, { from: "planned", to: "abandoned" });
    expect(res.status).toBe(200);
    expect(res.body.repull.terminal_at).not.toBeNull();
    const again = await call("POST", "/repulls", plan());
    expect(again.status).toBe(201);
    expect(again.body.repull.attempt).toBe(2);
  });

  test("failed needs a reason, and the reason is kept", async () => {
    const id = seedRow("copied");
    expect((await move(id, { from: "copied", to: "failed" })).body.code).toBe("field-missing");
    expect((await move(id, { from: "copied", to: "failed", error: "   " })).body.code).toBe(
      "invalid-body",
    );
    const ok = await move(id, {
      from: "copied",
      to: "failed",
      error: "[tag-mismatch] the tag is on another commit",
    });
    expect(ok.body.repull).toMatchObject({
      status: "failed",
      last_error: "[tag-mismatch] the tag is on another commit",
    });
    expect(ok.body.repull.terminal_at).not.toBeNull();
  });

  test("a specific error is not overwritten by a generic one, and a specific one replaces it", async () => {
    const id = seedRow("prepared");
    const fields = { synth_tree: SHA, synth_sha: SHA, manifest_digest: DIGEST };
    await move(id, {
      from: "prepared",
      to: "prepared",
      fields,
      error: "scrub refused: a flagged header",
    });
    expect(rowOf(id).last_error).toBe("scrub refused: a flagged header");
    await move(id, {
      from: "prepared",
      to: "prepared",
      fields,
      error: "terminal: prepare=failure",
    });
    expect(rowOf(id).last_error).toBe("scrub refused: a flagged header");
    await move(id, { from: "prepared", to: "prepared", fields, error: "main moved" });
    expect(rowOf(id).last_error).toBe("main moved");
    // A prepared self-edge with no error records the whole stage again: the step succeeded.
    await move(id, { from: "prepared", to: "prepared", fields });
    expect(rowOf(id).last_error).toBeNull();
  });

  test("N.0.1 opens from released with all five patch columns, on the branch of its own version", async () => {
    const id = seedRow("released");
    const fields = {
      patch_version: "2.0.1",
      patch_branch: "release/v2.0.1",
      patch_pr_number: 9,
      patch_head_sha: SHA,
      patch_base_sha: SHA,
    };
    const wrong = await move(id, {
      from: "released",
      to: "patch_synthesized",
      fields: { ...fields, patch_branch: "release/v2.0.0" },
    });
    expect(wrong.body.code).toBe("field-invalid");
    const wrongVersion = await move(id, {
      from: "released",
      to: "patch_synthesized",
      fields: { ...fields, patch_version: "2.1.0", patch_branch: "release/v2.1.0" },
    });
    expect(wrongVersion.body.code).toBe("field-invalid");
    const ok = await move(id, { from: "released", to: "patch_synthesized", fields });
    expect(ok.status).toBe(200);
    expect(ok.body.repull.status).toBe("patch_synthesized");
    const declined = await move(id, { from: "patch_synthesized", to: "patch_declined" });
    expect(declined.status).toBe(200);
    expect(declined.body.repull.terminal_at).not.toBeNull();
  });

  test("an unknown record is 404, a bad id 400, a malformed body 400", async () => {
    expect((await move(999, { from: "planned", to: "failed", error: "x" })).status).toBe(404);
    expect(
      (await call("POST", "/repulls/abc/transition", { from: "planned", to: "failed" })).status,
    ).toBe(400);
    const id = seedRow("planned");
    expect((await move(id, { from: "planned", to: "done" })).status).toBe(400);
    expect((await move(id, { from: "planned", to: "failed", extra: 1 })).status).toBe(400);
  });

  test("outside production a record of an on dataset cannot be moved either", async () => {
    const id = seedRow("planned", { dataset_id: "on099999" });
    const res = await move(id, { from: "planned", to: "abandoned" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("env-fence");
    expect(rowOf(id).status).toBe("planned");
    const prod = await move(
      id,
      { from: "planned", to: "abandoned" },
      { environment: "production" },
    );
    expect(prod.status).toBe(200);
  });
});

// ----------------------------------------------------------------------------
// Delete
// ----------------------------------------------------------------------------

describe("deleting a dataset", () => {
  test("the cascade removes its re-pull records and no other dataset's", async () => {
    seedMirror("xx090123");
    seedMirror("xx090124", { versions: [{ version: "1.0.0", tag: "1.0.0", basis: "doi" }] });
    seedRow("abandoned", { dataset_id: "xx090123" });
    seedRow("planned", { dataset_id: "xx090123", attempt: 2 });
    seedRow("planned", { dataset_id: "xx090124" });
    const result = await deleteDatasetCascade(
      realD1(db),
      { ENVIRONMENT: "test" } as unknown as Bindings,
      "xx090123",
      { skipS3: true },
    );
    expect(result.steps.d1.success).toBe(true);
    // No GitHub credential is bound here, so the repository step failed before any request.
    expect(result.steps.github.success).toBe(false);
    expect(rows().map((r) => r.dataset_id)).toEqual(["xx090124"]);
    expect(db.query("SELECT dataset_id FROM datasets").all()).toEqual([{ dataset_id: "xx090124" }]);
  });
});

// ----------------------------------------------------------------------------
// Interleaved writers
// ----------------------------------------------------------------------------

/** A D1 that runs `action` once, just before the first statement starting with `startsWith`. */
function interleaved(startsWith: string, action: () => void): D1Database {
  const real = realD1(db);
  let done = false;
  return {
    ...real,
    prepare(sql: string) {
      if (!done && sql.startsWith(startsWith)) {
        done = true;
        action();
      }
      return real.prepare(sql);
    },
    batch: real.batch.bind(real),
  } as unknown as D1Database;
}

async function callOn(d1: D1Database, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {
      DB: d1,
      ENVIRONMENT: "test",
      GITHUB_ADMIN_PAT: "ghp_repull_route_test",
    } as unknown as Bindings,
  );
  return { status: res.status, body: (await res.json()) as Json };
}

describe("transition: two writers that read the same row", () => {
  const again = (head: string) => ({
    branch: "release/v2.0.0",
    pr_number: 7,
    head_sha: head,
  });

  test("a repeated status applies once: the second writer is told the row moved", async () => {
    const id = seedRow("pr_open");
    const other = "e".repeat(40);
    const d1 = interleaved("UPDATE upstream_repulls", () =>
      db.run(
        `UPDATE upstream_repulls SET head_sha = '${other}', revision = revision + 1 WHERE id = ${id}`,
      ),
    );
    const res = await callOn(d1, "POST", `/repulls/${id}/transition`, {
      from: "pr_open",
      to: "pr_open",
      fields: again("f".repeat(40)),
    });
    expect([res.status, res.body.code]).toEqual([409, "stale-status"]);
    expect(rowOf(id)).toMatchObject({ head_sha: other, revision: 1 });
    expect(audits("repull_transition")).toEqual([]);
  });

  test("a claim set after the row was read stops the close that read it", async () => {
    const id = seedRow("gates_clear");
    const d1 = interleaved("UPDATE upstream_repulls", () =>
      db.run(
        `UPDATE upstream_repulls SET merge_claimed_at = '2026-10-24 01:00:00', merge_claim_sha = '${SHA}', revision = revision + 1 WHERE id = ${id}`,
      ),
    );
    const res = await callOn(d1, "POST", `/repulls/${id}/transition`, {
      from: "gates_clear",
      to: "abandoned",
    });
    expect([res.status, res.body.code]).toEqual([409, "stale-status"]);
    expect(rowOf(id)).toMatchObject({
      status: "gates_clear",
      merge_claimed_at: "2026-10-24 01:00:00",
    });
  });

  test("every write bumps the revision, an error-only one included", async () => {
    seedMirror("xx090123");
    const id = (await call("POST", "/repulls", plan())).body.repull.id;
    expect(rowOf(id).revision).toBe(0);
    await move(id, { from: "planned", to: "planned", error: "scrub refused" });
    expect(rowOf(id).revision).toBe(1);
    const fields = { synth_tree: SHA, synth_sha: SHA, manifest_digest: DIGEST };
    await move(id, { from: "planned", to: "prepared", fields });
    await move(id, { from: "prepared", to: "prepared", fields });
    await move(id, { from: "prepared", to: "copied" });
    expect(rowOf(id).revision).toBe(4);
    // A refused write changes nothing, the revision included.
    await move(id, { from: "copied", to: "merged", fields: { merge_sha: SHA } });
    await move(id, { from: "prepared", to: "copied" });
    expect(rowOf(id).revision).toBe(4);
  });

  test("a dataset deleted between the read and the write answers 404, not a 500", async () => {
    const id = seedRow("planned");
    const d1 = interleaved("UPDATE upstream_repulls", () =>
      db.run(`DELETE FROM upstream_repulls WHERE id = ${id}`),
    );
    const res = await callOn(d1, "POST", `/repulls/${id}/transition`, {
      from: "planned",
      to: "abandoned",
    });
    expect([res.status, res.body.code]).toEqual([404, "not-found"]);
    expect(rows()).toEqual([]);
  });

  test("two writers one after the other both apply, each on the revision the last left", async () => {
    const id = seedRow("pr_open");
    const env2 = {
      DB: realD1(db),
      ENVIRONMENT: "test",
      GITHUB_ADMIN_PAT: "ghp_repull_route_test",
    } as unknown as Bindings;
    const a = await transitionRepull(env2, { id: adminId }, id, {
      from: "pr_open",
      to: "pr_open",
      fields: again("1".repeat(40)),
    });
    const b = await transitionRepull(env2, { id: adminId }, id, {
      from: "pr_open",
      to: "pr_open",
      fields: again("2".repeat(40)),
    });
    expect("row" in a && "row" in b).toBe(true);
    expect(rowOf(id)).toMatchObject({ head_sha: "2".repeat(40), revision: 2 });
  });
});

// ----------------------------------------------------------------------------
// The claim to merge
// ----------------------------------------------------------------------------

describe("transition: the claim to merge", () => {
  // The claim re-reads the dataset fences, so the record's dataset must exist and be a mirror.
  beforeEach(() => seedMirror("xx090123"));

  test("it is recorded through the API on gates_clear, and nothing else changes", async () => {
    const id = seedRow("gates_clear");
    const before = rowOf(id);
    const res = await move(id, { from: "gates_clear", to: "gates_clear", fields: CLAIM });
    expect(res.status).toBe(200);
    expect(res.body.repull).toMatchObject({ status: "gates_clear", ...CLAIM, revision: 1 });
    const after = rowOf(id);
    for (const key of Object.keys(before)) {
      if (["merge_claimed_at", "merge_claim_sha", "revision", "updated_at"].includes(key)) continue;
      expect([key, after[key]]).toEqual([key, before[key]]);
    }
    expect(JSON.parse(audits("repull_transition")[0]?.details as string)).toMatchObject({
      from: "gates_clear",
      to: "gates_clear",
      fields: ["merge_claim_sha"],
    });
  });

  test("the time is the Worker's own: stamped on the claim, whatever a request says", async () => {
    const id = seedRow("gates_clear");
    const before = db.query("SELECT datetime('now') AS t").get() as { t: string };
    const res = await move(id, { from: "gates_clear", to: "gates_clear", fields: CLAIM });
    const after = db.query("SELECT datetime('now') AS t").get() as { t: string };
    const stamped = res.body.repull.merge_claimed_at as string;
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(stamped >= before.t && stamped <= after.t).toBe(true);
    // A time in the request is refused, backdated, far ahead or well formed, and nothing is written.
    for (const sent of ["2000-01-01 00:00:00", "2999-01-01 00:00:00", "2026-10-24 01:00:00"]) {
      db.run("UPDATE upstream_repulls SET merge_claimed_at = NULL, merge_claim_sha = NULL");
      const refused = await move(id, {
        from: "gates_clear",
        to: "gates_clear",
        fields: { ...CLAIM, merge_claimed_at: sent },
      });
      expect([sent, refused.status, refused.body.code]).toEqual([sent, 400, "field-not-allowed"]);
      expect(rowOf(id).merge_claimed_at).toBeNull();
    }
  });

  test("N.0.1's claim is stamped the same way", async () => {
    const id = seedRow("patch_gates_clear");
    const refused = await move(id, {
      from: "patch_gates_clear",
      to: "patch_gates_clear",
      fields: { ...PATCH_CLAIM, patch_merge_claimed_at: "2999-01-01 00:00:00" },
    });
    expect(refused.body.code).toBe("field-not-allowed");
    const ok = await move(id, {
      from: "patch_gates_clear",
      to: "patch_gates_clear",
      fields: PATCH_CLAIM,
    });
    expect(ok.body.repull.patch_merge_claimed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(ok.body.repull.merge_claimed_at).toBeNull();
  });

  test("it must name the screened head, and nothing else", async () => {
    const id = seedRow("gates_clear");
    const cases: Array<[string, Record<string, unknown>, number, string]> = [
      ["another head", { ...CLAIM, merge_claim_sha: "9".repeat(40) }, 400, "field-invalid"],
      ["no sha", {}, 400, "field-missing"],
      ["a badly shaped sha", { merge_claim_sha: "HEAD" }, 400, "field-invalid"],
      ["a time", { ...CLAIM, merge_claimed_at: "2026-10-24 01:00:00" }, 400, "field-not-allowed"],
      ["a head field", { ...CLAIM, head_sha: SHA }, 400, "field-not-allowed"],
      ["a patch claim", { ...CLAIM, patch_merge_claim_sha: SHA }, 400, "field-not-allowed"],
    ];
    for (const [what, fields, status, code] of cases) {
      const res = await move(id, { from: "gates_clear", to: "gates_clear", fields });
      expect([what, res.status, res.body.code]).toEqual([what, status, code]);
    }
    expect(rowOf(id).merge_claimed_at).toBeNull();
  });

  test("it cannot be recorded twice, or by an edge that is not the claim edge", async () => {
    const id = seedRow("gates_clear");
    const first = await move(id, { from: "gates_clear", to: "gates_clear", fields: CLAIM });
    expect(first.status).toBe(200);
    const stamped = first.body.repull.merge_claimed_at as string;
    const twice = await move(id, {
      from: "gates_clear",
      to: "gates_clear",
      fields: CLAIM,
    });
    expect([twice.status, twice.body.code]).toEqual([409, "merge-claim-held"]);
    expect(rowOf(id).merge_claimed_at).toBe(stamped);

    const open = seedRow("pr_open", { dataset_id: "xx090124" });
    const res = await move(open, {
      from: "pr_open",
      to: "pr_open",
      fields: { ...CLAIM, branch: "release/v2.0.0", pr_number: 7, head_sha: SHA },
    });
    expect([res.status, res.body.code]).toEqual([400, "field-not-allowed"]);
    expect(rowOf(open).merge_claimed_at).toBeNull();
    // A state with no claim edge at all is not an edge.
    const copied = seedRow("copied", { dataset_id: "xx090125" });
    const none = await move(copied, { from: "copied", to: "copied", fields: CLAIM });
    expect([none.status, none.body.code]).toEqual([409, "bad-transition"]);
  });

  test("while it is held the head cannot move and the pull request cannot be closed, but failed is allowed", async () => {
    const refused: Array<[RepullStatus, Record<string, unknown>]> = [
      ["pr_open", { fields: { branch: "release/v2.0.0", pr_number: 7, head_sha: "e".repeat(40) } }],
      ["abandoned", {}],
      ["superseded", {}],
    ];
    for (const [to, extra] of refused) {
      db.run("DELETE FROM upstream_repulls");
      const id = seedRow("gates_clear");
      await move(id, { from: "gates_clear", to: "gates_clear", fields: CLAIM });
      const before = rowOf(id);
      const res = await move(id, { from: "gates_clear", to, ...extra });
      expect([to, res.status, res.body.code]).toEqual([to, 409, "merge-claim-held"]);
      expect(rowOf(id)).toEqual(before);
    }
    db.run("DELETE FROM upstream_repulls");
    const id = seedRow("gates_clear");
    await move(id, { from: "gates_clear", to: "gates_clear", fields: CLAIM });
    const failed = await move(id, {
      from: "gates_clear",
      to: "failed",
      error: "the merge answer was lost",
    });
    expect(failed.status).toBe(200);
    expect(failed.body.repull).toMatchObject({ status: "failed", ...CLAIM });
  });

  test("N.0.1 has the same claim, with the same refusals", async () => {
    const id = seedRow("patch_gates_clear");
    const bad = await move(id, {
      from: "patch_gates_clear",
      to: "patch_gates_clear",
      fields: { ...PATCH_CLAIM, patch_merge_claim_sha: "9".repeat(40) },
    });
    expect(bad.body.code).toBe("field-invalid");
    const mixed = await move(id, {
      from: "patch_gates_clear",
      to: "patch_gates_clear",
      fields: CLAIM,
    });
    expect(mixed.body.code).toBe("field-not-allowed");
    const ok = await move(id, {
      from: "patch_gates_clear",
      to: "patch_gates_clear",
      fields: PATCH_CLAIM,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.repull).toMatchObject({ status: "patch_gates_clear", ...PATCH_CLAIM });
    expect(
      (await move(id, { from: "patch_gates_clear", to: "patch_gates_clear", fields: PATCH_CLAIM }))
        .body.code,
    ).toBe("merge-claim-held");
    const head = {
      patch_version: "2.0.1",
      patch_branch: "release/v2.0.1",
      patch_pr_number: 8,
      patch_head_sha: "e".repeat(40),
      patch_base_sha: SHA,
    };
    const moved = await move(id, {
      from: "patch_gates_clear",
      to: "patch_synthesized",
      fields: head,
    });
    expect([moved.status, moved.body.code]).toEqual([409, "merge-claim-held"]);
    const declined = await move(id, { from: "patch_gates_clear", to: "patch_declined" });
    expect([declined.status, declined.body.code]).toEqual([409, "merge-claim-held"]);
    expect(
      (await move(id, { from: "patch_gates_clear", to: "failed", error: "lost" })).status,
    ).toBe(200);
  });

  test("before a claim, going back from gates_clear is allowed", async () => {
    const id = seedRow("gates_clear");
    const res = await move(id, {
      from: "gates_clear",
      to: "pr_open",
      fields: { branch: "release/v2.0.0", pr_number: 7, head_sha: "e".repeat(40) },
    });
    expect(res.status).toBe(200);
  });
});

describe("transition: the edges that record one thing", () => {
  test("planned records why a step could not finish, and only that", async () => {
    const id = seedRow("planned");
    expect((await move(id, { from: "planned", to: "planned" })).body.code).toBe("field-missing");
    const fields = await move(id, {
      from: "planned",
      to: "planned",
      error: "x",
      fields: { counts: { written: 1 } },
    });
    expect(fields.body.code).toBe("field-not-allowed");
    const ok = await move(id, {
      from: "planned",
      to: "planned",
      error: "scrub refused: a flagged header",
    });
    expect(ok.body.repull).toMatchObject({
      status: "planned",
      last_error: "scrub refused: a flagged header",
      revision: 1,
      terminal_at: null,
    });
  });

  test("released records the count of locked objects, and only counts", async () => {
    const id = seedRow("released");
    expect((await move(id, { from: "released", to: "released" })).body.code).toBe("field-missing");
    const tag = await move(id, {
      from: "released",
      to: "released",
      fields: { counts: { locked: 3 }, tag_sha: SHA },
    });
    expect(tag.body.code).toBe("field-not-allowed");
    const ok = await move(id, {
      from: "released",
      to: "released",
      fields: { counts: { locked: 3 } },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.repull).toMatchObject({
      status: "released",
      counts: { locked: 3 },
      tag_sha: SHA,
      revision: 1,
    });
    // The state itself is still not stated here.
    const merged = seedRow("merged", { dataset_id: "xx090124" });
    const into = await move(merged, { from: "merged", to: "released", fields: { tag_sha: SHA } });
    expect(into.body.code).toBe("use-verified-route");
  });
});

describe("transition: last_error", () => {
  const fields = { synth_tree: SHA, synth_sha: SHA, manifest_digest: DIGEST };

  test("an edge into another open status clears it, because the step has since succeeded", async () => {
    const id = seedRow("planned", { last_error: "scrub refused: a flagged header" });
    const res = await move(id, { from: "planned", to: "prepared", fields });
    expect(res.body.repull.last_error).toBeNull();
  });

  test("an edge that repeats a status, or ends the row, keeps it", async () => {
    const id = seedRow("pr_open", { last_error: "main moved" });
    const head = { branch: "release/v2.0.0", pr_number: 7, head_sha: SHA };
    expect(
      (await move(id, { from: "pr_open", to: "pr_open", fields: head })).body.repull.last_error,
    ).toBe("main moved");
    const failed = await move(id, {
      from: "pr_open",
      to: "failed",
      error: "terminal: prepare=failure",
    });
    expect(failed.body.repull.last_error).toBe("main moved");
  });

  test("a prepared self-edge with no error clears it: it records the whole stage again", async () => {
    const id = seedRow("prepared", { last_error: "[prepare-not-reproducible] another tree" });
    const cleared = await move(id, { from: "prepared", to: "prepared", fields });
    expect(cleared.body.repull.last_error).toBeNull();
    // With an error of its own it records that one, under ADR 0051's rule as before.
    const again = await move(id, { from: "prepared", to: "prepared", fields, error: "main moved" });
    expect(again.body.repull.last_error).toBe("main moved");
  });

  test("a new error on a forward edge is stored as sent", async () => {
    const id = seedRow("planned", { last_error: "an old specific error" });
    const res = await move(id, {
      from: "planned",
      to: "prepared",
      fields,
      error: "terminal: prepare=failure",
    });
    expect(res.body.repull.last_error).toBe("terminal: prepare=failure");
  });

  test("a blank error is refused on every edge, and never stored", async () => {
    const id = seedRow("planned");
    for (const error of ["", "   ", "\n\t "]) {
      for (const [from, to] of [
        ["planned", "planned"],
        ["planned", "prepared"],
        ["planned", "abandoned"],
      ] as const) {
        const res = await move(id, { from, to, fields: to === "prepared" ? fields : {}, error });
        expect([JSON.stringify(error), from, to, res.status, res.body.code]).toEqual([
          JSON.stringify(error),
          from,
          to,
          400,
          "invalid-body",
        ]);
      }
    }
    expect(rowOf(id).last_error).toBeNull();
    // The service refuses it too, for a caller that is not the route.
    const direct = await transitionRepull(
      {
        DB: realD1(db),
        ENVIRONMENT: "test",
        GITHUB_ADMIN_PAT: "ghp_repull_route_test",
      } as unknown as Bindings,
      { id: adminId },
      id,
      {
        from: "planned",
        to: "planned",
        error: "  ",
      },
    );
    expect(direct).toMatchObject({ status: 400, code: "field-invalid" });
    expect(rowOf(id).last_error).toBeNull();
  });

  test("an error is trimmed before it is stored", async () => {
    const id = seedRow("planned");
    const res = await move(id, { from: "planned", to: "planned", error: "  main moved  " });
    expect(res.body.repull.last_error).toBe("main moved");
  });
});

describe("the shape of a refusal", () => {
  test("a malformed body is { error, code: invalid-body } on both writes, and echoes no value", async () => {
    seedMirror("xx090123");
    const id = seedRow("planned");
    const create = await call(
      "POST",
      "/repulls",
      plan({ base_sha: "secret-value-123", origin: "x" }),
    );
    expect(create.status).toBe(400);
    expect(create.body.code).toBe("invalid-body");
    expect(typeof create.body.error).toBe("string");
    expect(create.body.error).toContain("base_sha");
    expect(create.body.error).not.toContain("secret-value-123");
    const move1 = await move(id, { from: "planned", to: "nonsense" });
    expect([move1.status, move1.body.code]).toEqual([400, "invalid-body"]);
    const move2 = await call("POST", `/repulls/${id}/transition`, "not json at all" as never);
    expect(move2.status).toBe(400);
    expect(move2.body.code).toBe("invalid-body");
  });

  test("a bad id or query is { error, code } too", async () => {
    const cases: Array<[string, string]> = [
      ["/repulls?limit=51", "invalid-query"],
      ["/repulls?open=maybe", "invalid-query"],
      ["/repulls?after=x", "invalid-query"],
      ["/repulls?dataset=bad", "invalid-query"],
      ["/repulls/abc", "invalid-id"],
    ];
    for (const [path, code] of cases) {
      const res = await call("GET", path);
      expect([path, res.status, res.body.code]).toEqual([path, 400, code]);
    }
    expect(
      (await call("POST", "/repulls/abc/transition", { from: "planned", to: "failed" })).body.code,
    ).toBe("invalid-id");
  });

  test("the migration hint is attached to a missing table or column only", async () => {
    // Authentication runs on the same database, so only the re-pull table fails.
    const throwing = (message: string): D1Database => {
      const real = realD1(db);
      return {
        ...real,
        prepare(sql: string) {
          if (sql.includes("upstream_repulls")) throw new Error(message);
          return real.prepare(sql);
        },
        batch: real.batch.bind(real),
      } as unknown as D1Database;
    };
    const missing = await callOn(
      throwing("D1_ERROR: no such table: upstream_repulls"),
      "GET",
      "/repulls/1",
    );
    expect(missing.status).toBe(500);
    expect(missing.body.error).toContain("is migration 0105 applied?");
    const column = await callOn(
      throwing("D1_ERROR: no such column: revision"),
      "GET",
      "/repulls/1",
    );
    expect(column.body.error).toContain("is migration 0105 applied?");
    const other = await callOn(throwing("D1_ERROR: boom"), "GET", "/repulls/1");
    expect(other.status).toBe(500);
    expect(other.body.error).toContain("boom");
    expect(other.body.error).not.toContain("migration");
    seedMirror("xx090123");
    const create = await callOn(throwing("D1_ERROR: boom"), "POST", "/repulls", plan());
    expect(create.status).toBe(500);
    expect(create.body.error).not.toContain("migration");
  });

  test("next_after appears exactly when a page is full, at the default size", async () => {
    // The documented sizes: a list of this size is a full page.
    expect([REPULL_PAGE_DEFAULT, REPULL_PAGE_MAX]).toEqual([25, 50]);
    for (let i = 1; i <= REPULL_PAGE_DEFAULT; i++) {
      seedRow("abandoned", { attempt: i });
    }
    const full = await call("GET", "/repulls");
    expect(full.body.repulls).toHaveLength(REPULL_PAGE_DEFAULT);
    expect(full.body.next_after).toBe(full.body.repulls.at(-1).id);
    const wider = await call("GET", "/repulls?limit=50");
    expect(wider.body.repulls).toHaveLength(REPULL_PAGE_DEFAULT);
    expect(wider.body.next_after).toBeNull();
  });
});

describe("create: the lineage write and the race", () => {
  test("a stored v-spelled tag is upgraded, and the response and audit row say so", async () => {
    seedMirror("xx090123", { versions: [{ version: "v1.0.0", tag: "v1.0.0", basis: "doi" }] });
    const res = await call("POST", "/repulls", plan({ lineage_recordable: true }));
    expect(res.status).toBe(201);
    expect(res.body.lineage_rows).toBe(1);
    expect(snapshotOf("xx090123", "v1.0.0")).toEqual({
      source_version: "1.0.0",
      source_version_basis: "lineage",
    });
    expect(JSON.parse(audits("repull_created")[0]?.details as string)).toMatchObject({
      lineage_rows: 1,
      prior_basis: ["doi"],
    });
  });

  test("the response counts what was written: none when the plan did not assert it", async () => {
    seedMirror("xx090123");
    expect((await call("POST", "/repulls", plan())).body.lineage_rows).toBe(0);
    db.run("DELETE FROM upstream_repulls");
    db.run("DELETE FROM audit_log");
    const asserted = await call("POST", "/repulls", plan({ lineage_recordable: true }));
    expect(asserted.body.lineage_rows).toBe(1);
    // A rerun of the same plan returns the record and upgrades nothing.
    const rerun = await call("POST", "/repulls", plan({ lineage_recordable: true }));
    expect([rerun.status, rerun.body.lineage_rows]).toEqual([200, 0]);
  });

  test("a row never examined records its prior state as unexamined", async () => {
    seedMirror("xx090123", { versions: [{ version: "1.0.0", tag: null, basis: null }] });
    await call("POST", "/repulls", plan({ lineage_recordable: true }));
    expect(JSON.parse(audits("repull_created")[0]?.details as string).prior_basis).toEqual([
      "unexamined",
    ]);
  });

  function raceThenFinish(winner: Row, finish: () => void): D1Database {
    const real = realD1(db);
    let inserted = false;
    let factsReads = 0;
    return {
      ...real,
      prepare(sql: string) {
        if (!inserted && sql.startsWith("INSERT INTO upstream_repulls")) {
          inserted = true;
          const cols = Object.keys(winner);
          db.query(
            `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          ).run(...(cols.map((c) => winner[c]) as never[]));
        }
        if (sql.includes("FROM datasets d LEFT JOIN import_jobs")) {
          factsReads++;
          if (factsReads === 2) finish();
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
  }

  test("a winner that went terminal before the re-read leaves the next attempt free", async () => {
    seedMirror("xx090123");
    const winner = rowAt("planned", { dataset_id: "xx090123", actor_user_id: adminId });
    const d1 = raceThenFinish(winner, () =>
      db.run("UPDATE upstream_repulls SET status = 'abandoned', terminal_at = datetime('now')"),
    );
    const res = await callOn(d1, "POST", "/repulls", plan());
    expect([res.status, res.body.created, res.body.repull.attempt]).toEqual([201, true, 2]);
    expect(rows().map((r) => r.status)).toEqual(["abandoned", "planned"]);
  });

  test("a winner that merged before the re-read blocks the tag, not a 500", async () => {
    seedMirror("xx090123");
    const winner = rowAt("planned", { dataset_id: "xx090123", actor_user_id: adminId });
    const d1 = raceThenFinish(winner, () => {
      db.run("DELETE FROM upstream_repulls");
      seedRow("complete");
    });
    const res = await callOn(d1, "POST", "/repulls", plan());
    expect([res.status, res.body.code]).toEqual([409, "tag-already-pulled"]);
  });

  test("a second collision is a real fault and is a 500", async () => {
    seedMirror("xx090123");
    const real = realD1(db);
    let inserts = 0;
    let factsReads = 0;
    const insertWinner = (attempt: number) => {
      const winner = rowAt("planned", { dataset_id: "xx090123", actor_user_id: adminId, attempt });
      const cols = Object.keys(winner);
      db.query(
        `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ).run(...(cols.map((c) => winner[c]) as never[]));
    };
    const collidesTwice = {
      ...real,
      prepare(sql: string) {
        if (sql.startsWith("INSERT INTO upstream_repulls")) insertWinner(++inserts);
        if (sql.includes("FROM datasets d LEFT JOIN import_jobs") && ++factsReads === 2) {
          db.run("UPDATE upstream_repulls SET status = 'abandoned', terminal_at = datetime('now')");
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const res = await callOn(collidesTwice, "POST", "/repulls", plan());
    expect(res.status).toBe(500);
    expect(inserts).toBe(2);
  });
});

// ----------------------------------------------------------------------------
// The automatic create (epic #1046 phase 7, #1913; ADR 0111, decision 6)
// ----------------------------------------------------------------------------

describe("create: the automatic path", () => {
  const AUTO = "on099991";
  const SECRET = "repull-route-dispatch-secret";
  const ON = { AUTO_REPULL_ENABLED: "1", PRESCREEN_CALLBACK_SECRET: SECRET };
  const prod = (extra: Record<string, string | undefined> = {}) => ({
    environment: "production",
    bindings: { ...ON, ...extra },
  });
  const CLEAN = { delta_paths: 3, unexplained: 0, conflicts: 0, corrections: 0, copy_bytes: 4096 };

  async function claim(datasetId = AUTO, over: Record<string, unknown> = {}) {
    const c = await claimOpenDispatch(env("production", ON), {
      datasetId,
      upstreamDs: "ds099999",
      fromTag: "1.0.0",
      toTag: "1.0.1",
      ...over,
    });
    if (!("id" in c)) throw new Error(`refused: ${c.refused}`);
    return c;
  }

  function autoPlan(c: { id: number; token: string }, over: Record<string, unknown> = {}) {
    return plan({
      dataset_id: AUTO,
      counts: CLEAN,
      dispatch_id: c.id,
      dispatch_token: c.token,
      ...over,
    });
  }

  const dispatchOf = (id: number) =>
    db.query("SELECT * FROM upstream_repull_dispatches WHERE id = ?").get(id) as Row;

  /** {@link callOn} as the production Worker with the automatic path on. */
  async function callOnProd(d1: D1Database, body: unknown) {
    const res = await app.request(
      "/repulls",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      {
        DB: d1,
        ENVIRONMENT: "production",
        GITHUB_ADMIN_PAT: "ghp_repull_route_test",
        ...ON,
      } as unknown as Bindings,
    );
    return { status: res.status, body: (await res.json()) as Json };
  }

  /** Nothing about the record was written: no row, no create audit, the dispatch unlinked. */
  function nothingRecorded(dispatchId: number) {
    expect(rows()).toEqual([]);
    expect(audits("repull_created")).toEqual([]);
    expect(dispatchOf(dispatchId)).toMatchObject({ repull_id: null, status: "dispatched" });
  }

  test("a live dispatch's create is automatic, linked to its dispatch, and audited as such", async () => {
    seedMirror(AUTO);
    const c = await claim();
    const res = await call("POST", "/repulls", autoPlan(c), prod());
    expect(res.status).toBe(201);
    expect(res.body.repull).toMatchObject({
      dataset_id: AUTO,
      origin: "automatic",
      actor_user_id: adminId,
      status: "planned",
      counts: CLEAN,
      hold_reason: null,
      hold_since: null,
    });
    // The dispatch stays live (the run reports `opened` later), and now names its record.
    expect(dispatchOf(c.id)).toMatchObject({ repull_id: res.body.repull.id, status: "dispatched" });
    expect(dispatchOf(c.id).nonce).not.toBeNull();
    const [audit] = audits("repull_created");
    expect(JSON.parse(audit?.details as string)).toMatchObject({
      origin: "automatic",
      dispatch_id: c.id,
    });
    expect(audit?.details).not.toContain(c.token);

    // The same run asking again gets the same record, and nothing more is written.
    const again = await call("POST", "/repulls", autoPlan(c), prod());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, repull: { id: res.body.repull.id } });
    expect(audits("repull_created")).toHaveLength(1);
  });

  test("an administrator's create is still the administrator's, and cannot state an origin", async () => {
    seedMirror(AUTO);
    const stated = await call(
      "POST",
      "/repulls",
      plan({ dataset_id: AUTO, origin: "automatic" }),
      prod(),
    );
    expect(stated).toMatchObject({ status: 400, body: { code: "invalid-body" } });
    const res = await call("POST", "/repulls", plan({ dataset_id: AUTO }), prod());
    expect(res.status).toBe(201);
    expect(res.body.repull.origin).toBe("administrator");
    expect(JSON.parse(audits("repull_created")[0]?.details as string)).toMatchObject({
      origin: "administrator",
    });
  });

  test("dispatch fields come together, in the token's shape", async () => {
    seedMirror(AUTO);
    const c = await claim();
    for (const body of [
      plan({ dataset_id: AUTO, counts: CLEAN, dispatch_id: c.id }),
      plan({ dataset_id: AUTO, counts: CLEAN, dispatch_token: c.token }),
      autoPlan(c, { dispatch_token: c.token.toUpperCase() }),
      autoPlan(c, { dispatch_token: `${c.token}0` }),
      autoPlan(c, { dispatch_id: 0 }),
    ]) {
      const res = await call("POST", "/repulls", body, prod());
      expect(res).toMatchObject({ status: 400, body: { code: "invalid-body" } });
      expect(JSON.stringify(res.body)).not.toContain(c.token);
    }
    nothingRecorded(c.id);
  });

  for (const environment of ["Production", "development", "staging", "test", undefined]) {
    test(`ENVIRONMENT ${JSON.stringify(environment)} is auto-production-only, before every other check`, async () => {
      seedMirror(AUTO);
      const c = await claim();
      const res = await call("POST", "/repulls", autoPlan(c), {
        environment,
        bindings: ON,
      });
      expect(res).toMatchObject({ status: 403, body: { code: "auto-production-only" } });
      nothingRecorded(c.id);
    });
  }

  test("the switch turned off stops a run before its first write", async () => {
    seedMirror(AUTO);
    const c = await claim();
    for (const value of [undefined, "true", "0"]) {
      const res = await call("POST", "/repulls", autoPlan(c), prod({ AUTO_REPULL_ENABLED: value }));
      expect([value, res.status, res.body.code]).toEqual([value, 409, "auto-repull-off"]);
    }
    nothingRecorded(c.id);
  });

  test("only an on mirror is re-pulled automatically", async () => {
    seedMirror("xx090123");
    const c = await claim();
    const res = await call("POST", "/repulls", autoPlan(c, { dataset_id: "xx090123" }), prod());
    expect(res).toMatchObject({ status: 403, body: { code: "auto-on-only" } });
    nothingRecorded(c.id);
  });

  test("the dispatch must carry the Worker's token over a live dispatch, and name this plan", async () => {
    seedMirror(AUTO);
    seedMirror("on099992");
    const c = await claim();
    const other = await claim("on099992");
    const cases: Array<[string, Record<string, unknown>, number, string]> = [
      ["no such dispatch", autoPlan(c, { dispatch_id: 999_999 }), 401, "dispatch-token"],
      ["a token of zeros", autoPlan(c, { dispatch_token: "0".repeat(64) }), 401, "dispatch-token"],
      [
        "another dispatch's token",
        autoPlan(c, { dispatch_token: other.token }),
        401,
        "dispatch-token",
      ],
      [
        "another dataset's dispatch",
        autoPlan(other, { dataset_id: AUTO }),
        409,
        "dispatch-mismatch",
      ],
      ["another to_tag", autoPlan(c, { to_tag: "1.0.2" }), 409, "dispatch-mismatch"],
      ["another from_tag", autoPlan(c, { from_tag: "0.9.0" }), 409, "dispatch-mismatch"],
      ["another ds", autoPlan(c, { upstream_ds: "ds099998" }), 409, "dispatch-mismatch"],
    ];
    for (const [name, body, status, code] of cases) {
      const res = await call("POST", "/repulls", body, prod());
      expect([name, res.status, res.body.code]).toEqual([name, status, code]);
    }
    // A tag spelled with a leading v is the same tag.
    expect((await call("POST", "/repulls", autoPlan(c, { to_tag: "v1.0.1" }), prod())).status).toBe(
      201,
    );
  });

  test("a dispatch that ended writes nothing, and a finish dispatch creates nothing", async () => {
    seedMirror(AUTO);
    const c = await claim();
    expect(
      await storeDispatchReport(env("production", ON), c.token, {
        dispatch_id: c.id,
        dataset_id: AUTO,
        phase: "refused",
        code: "auto-not-clean-plan",
      }),
    ).toMatchObject({ status: 200 });
    const ended = await call("POST", "/repulls", autoPlan(c), prod());
    expect(ended).toMatchObject({ status: 401, body: { code: "dispatch-token" } });
    expect(rows()).toEqual([]);

    // A finish dispatch, of a merged automatic row of another dataset, is not a create's.
    seedMirror("on099992");
    const merged = seedRow("merged", { dataset_id: "on099992", origin: "automatic" });
    const finish = await claimFinishDispatch(env("production", ON), {
      id: merged,
      dataset_id: "on099992",
      origin: "automatic",
      status: "merged",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    });
    if (!("id" in finish)) throw new Error(`refused: ${finish.refused}`);
    const res = await call(
      "POST",
      "/repulls",
      autoPlan(finish, { dataset_id: "on099992" }),
      prod(),
    );
    expect(res).toMatchObject({ status: 409, body: { code: "dispatch-mismatch" } });
    expect(rows().map((r) => r.id)).toEqual([merged]);
  });

  test("an unknown dispatch, an ended one and a wrong token are one answer, and no answer names a status", async () => {
    seedMirror(AUTO);
    const live = await claim();
    seedMirror("on099992");
    const ended = await claim("on099992");
    expect(
      await storeDispatchReport(env("production", ON), ended.token, {
        dispatch_id: ended.id,
        dataset_id: "on099992",
        phase: "failed",
        code: "runner-failed",
      }),
    ).toMatchObject({ status: 200 });
    const answers = [
      await call("POST", "/repulls", autoPlan(live, { dispatch_id: 999_999 }), prod()),
      await call(
        "POST",
        "/repulls",
        autoPlan(ended, { dataset_id: "on099992", dispatch_token: ended.token }),
        prod(),
      ),
      await call("POST", "/repulls", autoPlan(live, { dispatch_token: "0".repeat(64) }), prod()),
      await call("POST", "/repulls", autoPlan(live, { dispatch_token: ended.token }), prod()),
    ];
    for (const a of answers) expect(a).toEqual(answers[0] as (typeof answers)[number]);
    expect(answers[0]?.status).toBe(401);
    expect(answers[0]?.body.code).toBe("dispatch-token");
    // No status word and no id in the message.
    expect(JSON.stringify(answers[0]?.body)).not.toMatch(
      /dispatched|started|failed|unreported|#\d|999999/,
    );
    nothingRecorded(live.id);
  });

  test("a Worker with no callback secret answers 503 at the create, and writes nothing", async () => {
    seedMirror(AUTO);
    const c = await claim();
    for (const secret of [undefined, ""]) {
      const res = await call(
        "POST",
        "/repulls",
        autoPlan(c),
        prod({ PRESCREEN_CALLBACK_SECRET: secret }),
      );
      expect([secret, res.status, res.body.code]).toEqual([secret, 503, "dispatch-unconfigured"]);
    }
    nothingRecorded(c.id);
  });

  test("a dispatch that ends between the check and the insert creates nothing and links nothing", async () => {
    seedMirror(AUTO);
    const c = await claim();
    const end = () =>
      db.run(
        "UPDATE upstream_repull_dispatches SET status = 'unreported', nonce = NULL WHERE id = ?",
        [c.id],
      );
    const res = await callOnProd(interleaved("INSERT INTO upstream_repulls", end), autoPlan(c));
    expect(res).toMatchObject({ status: 401, body: { code: "dispatch-token" } });
    // The batch rolled back whole: no record, no create audit, no lineage write, no link.
    expect(rows()).toEqual([]);
    expect(audits("repull_created")).toEqual([]);
    expect(dispatchOf(c.id)).toMatchObject({ repull_id: null, status: "unreported", nonce: null });
  });

  test("a dispatch that ends before it is linked to a record it found links nothing", async () => {
    seedMirror(AUTO);
    const c = await claim();
    const id = seedRow("planned", {
      dataset_id: AUTO,
      origin: "automatic",
      planner: 2,
      upstream_ds: "ds099999",
    });
    const end = () =>
      db.run(
        "UPDATE upstream_repull_dispatches SET status = 'unreported', nonce = NULL WHERE id = ?",
        [c.id],
      );
    const res = await callOnProd(
      interleaved("UPDATE upstream_repull_dispatches SET repull_id", end),
      autoPlan(c),
    );
    expect(res).toMatchObject({ status: 401, body: { code: "dispatch-token" } });
    expect(dispatchOf(c.id)).toMatchObject({ repull_id: null, status: "unreported" });
    expect(rows().map((r) => r.id)).toEqual([id]);
  });

  test("the plan must be this planner's, with zero unexplained paths, conflicts and corrections stated", async () => {
    seedMirror(AUTO);
    const c = await claim();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["planner 1", { planner: 1 }, "auto-planner-version"],
      ["planner 3", { planner: 3 }, "auto-planner-version"],
      ["one unexplained path", { counts: { ...CLEAN, unexplained: 1 } }, "auto-not-clean-plan"],
      ["one conflict", { counts: { ...CLEAN, conflicts: 1 } }, "auto-not-clean-plan"],
      ["one correction", { counts: { ...CLEAN, corrections: 1 } }, "auto-not-clean-plan"],
      [
        "unexplained left out",
        { counts: { delta_paths: 3, conflicts: 0, corrections: 0, copy_bytes: 1 } },
        "auto-not-clean-plan",
      ],
      [
        "corrections left out",
        { counts: { delta_paths: 3, unexplained: 0, conflicts: 0, copy_bytes: 1 } },
        "auto-not-clean-plan",
      ],
      ["no counts at all", { counts: undefined }, "auto-not-clean-plan"],
      [
        "the copy's size left out",
        { counts: { delta_paths: 3, unexplained: 0, conflicts: 0, corrections: 0 } },
        "auto-copy-too-large",
      ],
      [
        "one byte over the bound",
        { counts: { ...CLEAN, copy_bytes: AUTO_MAX_COPY_BYTES + 1 } },
        "auto-copy-too-large",
      ],
    ];
    for (const [name, over, code] of cases) {
      // `counts: undefined` is left out of the JSON, so the body carries no counts at all.
      const res = await call("POST", "/repulls", autoPlan(c, over), prod());
      expect([name, res.status, res.body.code]).toEqual([name, 409, code]);
    }
    nothingRecorded(c.id);
    // Exactly the bound is taken.
    const at = await call(
      "POST",
      "/repulls",
      autoPlan(c, { counts: { ...CLEAN, copy_bytes: AUTO_MAX_COPY_BYTES } }),
      prod(),
    );
    expect(at.status).toBe(201);
  });

  test("an administrator never takes over a dispatched run's record, nor a run an administrator's", async () => {
    seedMirror(AUTO);
    const c = await claim();
    const auto = await call("POST", "/repulls", autoPlan(c), prod());
    expect(auto.status).toBe(201);
    const admin = await call("POST", "/repulls", plan({ dataset_id: AUTO, counts: CLEAN }), prod());
    expect(admin).toMatchObject({
      status: 409,
      body: { code: "repull-in-flight", repull: { id: auto.body.repull.id, origin: "automatic" } },
    });

    db.run("DELETE FROM upstream_repulls");
    db.run("DELETE FROM upstream_repull_dispatches");
    const mine = await call("POST", "/repulls", plan({ dataset_id: AUTO, counts: CLEAN }), prod());
    expect(mine.status).toBe(201);
    // A first dispatch is not even claimed for a dataset with an open record ...
    expect(
      await claimOpenDispatch(env("production", ON), {
        datasetId: AUTO,
        upstreamDs: "ds099999",
        fromTag: "1.0.0",
        toTag: "1.0.1",
      }),
    ).toEqual({ refused: "open-row" });
    // ... and a dispatch claimed before the administrator's record opened does not take it over.
    db.run("DELETE FROM upstream_repulls");
    const early = await claim();
    expect(
      (await call("POST", "/repulls", plan({ dataset_id: AUTO, counts: CLEAN }), prod())).status,
    ).toBe(201);
    const run = await call("POST", "/repulls", autoPlan(early), prod());
    expect(run).toMatchObject({ status: 409, body: { code: "repull-in-flight" } });
    expect(dispatchOf(early.id)).toMatchObject({ repull_id: null });
  });

  test("a run finds the automatic record its dispatch belongs to, and only that one", async () => {
    seedMirror(AUTO);
    // A dispatch claimed before an automatic record of the same plan opened (its own create's
    // answer was lost): the record is returned, and the dispatch is linked to it.
    const c = await claim();
    const id = seedRow("planned", {
      dataset_id: AUTO,
      origin: "automatic",
      planner: 2,
      upstream_ds: "ds099999",
    });
    const found = await call("POST", "/repulls", autoPlan(c), prod());
    expect(found).toMatchObject({ status: 200, body: { created: false, repull: { id } } });
    expect(dispatchOf(c.id)).toMatchObject({ repull_id: id });

    // A resume dispatch takes its own record ...
    db.run("UPDATE upstream_repull_dispatches SET status = 'unreported', nonce = NULL");
    const resume = await claim(AUTO, { repullId: id });
    const resumed = await call("POST", "/repulls", autoPlan(resume), prod());
    expect(resumed).toMatchObject({ status: 200, body: { repull: { id } } });
    // ... and, once that record has ended, creates no other ...
    db.run(
      "UPDATE upstream_repulls SET status = 'failed', terminal_at = datetime('now'), last_error = 'x'",
    );
    const gone = await call("POST", "/repulls", autoPlan(resume), prod());
    expect(gone).toMatchObject({ status: 409, body: { code: "dispatch-mismatch" } });
    expect(rows()).toHaveLength(1);
    // ... nor takes over another automatic record of the very same plan that opened since.
    const next = seedRow("planned", {
      dataset_id: AUTO,
      origin: "automatic",
      planner: 2,
      upstream_ds: "ds099999",
      attempt: 2,
    });
    const other = await call("POST", "/repulls", autoPlan(resume), prod());
    expect(other).toMatchObject({
      status: 409,
      body: { code: "repull-in-flight", repull: { id: next } },
    });
    expect(dispatchOf(resume.id)).toMatchObject({ repull_id: id });
  });
});
