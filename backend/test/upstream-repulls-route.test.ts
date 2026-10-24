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
 * No route here sends mail: the suite has no mail binding and would fail on one.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { REPULL_STATUSES, type RepullStatus, TERMINAL_STATUSES } from "../../shared/repull-state";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../src/routes/admin/upstream-repulls";
import { deleteDatasetCascade } from "../src/services/deletion";
import { hashApiKey } from "../src/services/token";
import { LINEAGE_WRITE_SQL } from "../src/services/upstream-repull";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
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

beforeEach(async () => {
  db = freshDb();
  app = newApp();
  await seedUsers();
});

function env(environment: string | undefined = "test"): Bindings {
  return { DB: realD1(db), ENVIRONMENT: environment } as unknown as Bindings;
}

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  o: { key?: string | null; environment?: string | undefined } = {},
) {
  const key = o.key === undefined ? ADMIN_KEY : o.key;
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const environment = "environment" in o ? o.environment : "test";
  const res = await app.request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env(environment),
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
  const row = rowAt(status, { actor_user_id: adminId, ...over });
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
      { DB: d1, ENVIRONMENT: "test" } as unknown as Bindings,
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

  test("a failed or abandoned attempt that holds a merge sha still blocks the tag", async () => {
    seedMirror("xx090123");
    for (const status of ["failed", "abandoned", "superseded"] as const) {
      db.run("DELETE FROM upstream_repulls");
      seedRow(status, { merge_sha: SHA });
      const res = await call("POST", "/repulls", plan());
      expect([status, res.status, res.body.code]).toEqual([status, 409, "tag-already-pulled"]);
    }
  });

  test("a failed attempt that holds a merge claim blocks the tag: the merge may have been sent", async () => {
    seedMirror("xx090123");
    seedRow("failed", { merge_claimed_at: "2026-10-24 01:00:00" });
    const res = await call("POST", "/repulls", plan());
    expect([res.status, res.body.code]).toEqual([409, "tag-already-pulled"]);
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
      { DB: racing, ENVIRONMENT: "test" } as unknown as Bindings,
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

  test("the screen's states cannot be stated here either, until the screen is bound", async () => {
    const cases: Array<[RepullStatus, RepullStatus, Record<string, unknown>]> = [
      ["pr_open", "gates_clear", { gates_sha: SHA }],
      ["patch_synthesized", "patch_gates_clear", { patch_gates_sha: SHA }],
    ];
    for (const [from, to, fields] of cases) {
      db.run("DELETE FROM upstream_repulls");
      const id = seedRow(from);
      const res = await move(id, { from, to, fields });
      expect([to, res.status, res.body.code]).toEqual([to, 409, "screen-not-built"]);
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
      ["gates_clear", "abandoned", { merge_claimed_at: "2026-10-24 01:00:00" }],
      ["gates_clear", "superseded", { merge_claimed_at: "2026-10-24 01:00:00" }],
      ["patch_gates_clear", "patch_declined", { patch_merge_claimed_at: "2026-10-24 01:00:00" }],
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
    const id = seedRow("gates_clear", { merge_claimed_at: "2026-10-24 01:00:00" });
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
      "field-missing",
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
    await move(id, { from: "prepared", to: "prepared", fields });
    expect(rowOf(id).last_error).toBe("main moved");
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
