/**
 * Real `POST /admin/datasets/upstream-backfill` route tests (epic #1046 phase 2, #1908; ADR 0111,
 * decision 4), modelled on `zarr-fidelity-sweep-route.test.ts`: real SQLite behind `realD1`
 * carrying every migration, the real auth and admin middleware with seeded tokens, the real route
 * and service. The raw content host is a local `Bun.serve` that logs every request.
 *
 * The properties that matter, each with a test that fails when its line is changed:
 *  - a fetch ERROR writes nothing (the row stays "never examined"), a 404 is `unknown`;
 *  - nothing is overwritten, even when another writer fills a row between the read and the write;
 *  - paging is a keyset, so a row that always errors does not starve the rows behind it;
 *  - a young row, a withdrawn dataset and a non-`on` dataset are never examined;
 *  - a batch where everything is absent is a suspect credential and writes nothing;
 *  - a dry run writes nothing.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamBackfillRoutes } from "../src/routes/admin/upstream-backfill";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1, wrapD1 } from "./helpers/d1";

const ADMIN_KEY = "ubf-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "ubf-member-key-0123456789abcdef0123456789abcdef0";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

// ----------------------------------------------------------------------------
// The raw content host
// ----------------------------------------------------------------------------

interface RawRequest {
  path: string;
  authorization: string | null;
  userAgent: string | null;
}

function startRawHost() {
  const files = new Map<string, { status: number; body: string }>();
  const log: RawRequest[] = [];
  const server: Server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      log.push({
        path,
        authorization: req.headers.get("authorization"),
        userAgent: req.headers.get("user-agent"),
      });
      const entry = files.get(path);
      if (!entry) return new Response("404: Not Found", { status: 404 });
      return new Response(entry.body, { status: entry.status });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    log,
    /** Serve `body` as the description at `v<version>` of `repo`. */
    serve(repo: string, version: string, body: unknown, status = 200) {
      files.set(`/nemarDatasets/${repo}/v${version}/dataset_description.json`, {
        status,
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    },
    reset() {
      files.clear();
      log.length = 0;
    },
    stop: () => server.stop(true),
  };
}

let raw: ReturnType<typeof startRawHost>;
let db: Database;
let app: App;

beforeAll(() => {
  raw = startRawHost();
});
afterAll(() => raw.stop());

function newApp(): App {
  const a: App = new Hono();
  a.use("*", authMiddleware);
  a.use("*", adminMiddleware);
  registerUpstreamBackfillRoutes(a);
  return a;
}

async function seedUsers(): Promise<void> {
  for (const [name, role, key] of [
    ["ubfadmin", "admin", ADMIN_KEY],
    ["ubfmember", "member", MEMBER_KEY],
  ] as const) {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('${name}', '${name}@example.org', 'x', 'approved', '${role}', 1)`,
    );
    const u = db.query<{ id: number }, []>(`SELECT id FROM users WHERE username='${name}'`).get();
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      u?.id ?? 0,
      await hashApiKey(key),
      key.slice(0, 8),
    );
  }
}

beforeEach(async () => {
  db = freshDb();
  raw.reset();
  app = newApp();
  await seedUsers();
});

function env(over: Partial<Bindings> = {}, d1: D1Database = realD1(db)): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: "development",
    GITHUB_RAW_BASE: raw.base,
    GITHUB_ADMIN_PAT: "ubf-test-pat",
    ...over,
  } as Bindings;
}

function call(query = "", key: string | null = ADMIN_KEY, bindings: Bindings = env()) {
  return app.request(
    `/datasets/upstream-backfill${query}`,
    { method: "POST", headers: key ? { Authorization: `Bearer ${key}` } : {} },
    bindings,
  );
}

const OLD = "datetime('now', '-3 hours')";

function seed(
  id: string,
  versions: string[] = ["1.0.0"],
  o: { withdrawn?: boolean; age?: string; repo?: string | null } = {},
): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, withdrawn_at)
     VALUES (?, ?, -1, ?, ?)`,
  ).run(
    id,
    id,
    o.repo === undefined ? `nemarDatasets/${id}` : o.repo,
    o.withdrawn ? "2026-01-01 00:00:00" : null,
  );
  for (const v of versions) {
    db.run(
      `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
       VALUES ('${id}', '${v}', '10.82901/${id}.v${v}', ${o.age ?? OLD})`,
    );
  }
}

/** A description whose own entry names `tag`. */
function describing(id: string, tag: string) {
  return {
    Name: id,
    SourceDatasets: [{ DOI: `10.18112/openneuro.ds${id.slice(2)}.v${tag}` }],
  };
}

function snapshotOf(id: string, version = "1.0.0") {
  return db
    .query<
      { source_version: string | null; source_version_basis: string | null },
      [string, string]
    >(
      "SELECT source_version, source_version_basis FROM dataset_versions WHERE dataset_id = ? AND version = ?",
    )
    .get(id, version);
}

const NOT_EXAMINED = { source_version: null, source_version_basis: null };

interface Body {
  ok: boolean;
  execute: boolean;
  scanned: number;
  recorded: { doi: number; unknown: number };
  not_examined: number;
  unparseable: number;
  absent: number;
  skipped_existing: number;
  errors: { dataset_id: string; version: string; error: string }[];
  suspect_credential: boolean;
  next_cursor: string | null;
  remaining: number;
  counts: { doi: number; lineage: number; unknown: number; not_examined: number };
  unknown_samples: { dataset_id: string; version: string; reason: string }[];
  error?: string;
}

const json = async (res: Response) => (await res.json()) as Body;

// ----------------------------------------------------------------------------

describe("upstream-backfill: who may call it", () => {
  test("no credential is 401, a member is 403, and neither reads anything", async () => {
    seed("on000001");
    raw.serve("on000001", "1.0.0", describing("on000001", "1.0.0"));
    expect((await call("?execute=1", null)).status).toBe(401);
    expect((await call("?execute=1", MEMBER_KEY)).status).toBe(403);
    expect(raw.log).toHaveLength(0);
    expect(snapshotOf("on000001")).toEqual(NOT_EXAMINED);
  });

  test("a malformed `after` is 400", async () => {
    for (const bad of ["on000001", "nm000001@1.0.0", "on000001@1.0", "garbage"]) {
      expect((await call(`?after=${bad}`)).status).toBe(400);
    }
  });
});

describe("upstream-backfill: dry run, then execute", () => {
  test("a dry run writes nothing and says what it would record, with samples for the unknown", async () => {
    seed("on000001");
    seed("on000002");
    raw.serve("on000001", "1.0.0", describing("on000001", "2.0.2"));
    raw.serve("on000002", "1.0.0", { Name: "no upstream here" });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      ok: true,
      execute: false,
      scanned: 2,
      recorded: { doi: 1, unknown: 1 },
      next_cursor: null,
      remaining: 0,
      counts: { doi: 0, unknown: 0, lineage: 0, not_examined: 2 },
    });
    expect(body.unknown_samples).toEqual([
      expect.objectContaining({ dataset_id: "on000002", version: "1.0.0" }),
    ]);
    expect(snapshotOf("on000001")).toEqual(NOT_EXAMINED);
    expect(snapshotOf("on000002")).toEqual(NOT_EXAMINED);
  });

  test("execute writes the tag with basis doi, and unknown with no tag", async () => {
    seed("on000001");
    seed("on000002");
    raw.serve("on000001", "1.0.0", describing("on000001", "2.0.2"));
    raw.serve("on000002", "1.0.0", { Name: "no upstream here" });
    const body = await json(await call("?execute=1"));
    expect(body).toMatchObject({
      ok: true,
      execute: true,
      recorded: { doi: 1, unknown: 1 },
      counts: { doi: 1, unknown: 1, not_examined: 0 },
    });
    expect(snapshotOf("on000001")).toEqual({
      source_version: "2.0.2",
      source_version_basis: "doi",
    });
    expect(snapshotOf("on000002")).toEqual({
      source_version: null,
      source_version_basis: "unknown",
    });
    expect(body.unknown_samples).toEqual([]);
  });

  test("a dry run lists at most ten unknown samples, whatever the batch holds", async () => {
    for (let i = 1; i <= 14; i++) {
      const id = `on${String(i).padStart(6, "0")}`;
      seed(id);
      raw.serve(id, "1.0.0", { Name: id });
    }
    const body = await json(await call("?limit=20"));
    expect(body.recorded.unknown).toBe(14);
    expect(body.unknown_samples).toHaveLength(10);
  });

  test("it reads each tagged file with the credential, nothing else", async () => {
    seed("on000001", ["1.0.0", "1.0.1"]);
    raw.serve("on000001", "1.0.0", describing("on000001", "1.0.0"));
    raw.serve("on000001", "1.0.1", describing("on000001", "1.0.1"));
    await call("?execute=1");
    expect(raw.log.map((r) => r.path).sort()).toEqual([
      "/nemarDatasets/on000001/v1.0.0/dataset_description.json",
      "/nemarDatasets/on000001/v1.0.1/dataset_description.json",
    ]);
    for (const r of raw.log) {
      expect(r.authorization).toBe("Bearer ubf-test-pat");
      expect(r.userAgent).toBe("NEMAR-API");
    }
    expect(snapshotOf("on000001", "1.0.1")?.source_version).toBe("1.0.1");
  });

  test("a description that is not JSON is unknown, and counted as unparseable", async () => {
    seed("on000001");
    seed("on000002");
    raw.serve("on000001", "1.0.0", "<<not json>>");
    raw.serve("on000002", "1.0.0", describing("on000002", "1.0.0"));
    const body = await json(await call("?execute=1"));
    expect(body.unparseable).toBe(1);
    expect(body.recorded).toEqual({ doi: 1, unknown: 1 });
    expect(snapshotOf("on000001")).toEqual({
      source_version: null,
      source_version_basis: "unknown",
    });
  });
});

describe("upstream-backfill: errors are not verdicts", () => {
  test("a 500 on one row leaves it never examined, is reported, and the others are recorded", async () => {
    seed("on000001");
    seed("on000002");
    raw.serve("on000001", "1.0.0", "boom", 500);
    raw.serve("on000002", "1.0.0", describing("on000002", "1.0.0"));
    const res = await call("?execute=1");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.not_examined).toBe(1);
    expect(body.errors).toEqual([
      expect.objectContaining({
        dataset_id: "on000001",
        version: "1.0.0",
        error: expect.stringContaining("500"),
      }),
    ]);
    expect(snapshotOf("on000001")).toEqual(NOT_EXAMINED);
    expect(snapshotOf("on000002")?.source_version_basis).toBe("doi");
  });

  test("a 404 on one row is unknown, beside a row that has its file", async () => {
    seed("on000001");
    seed("on000002");
    raw.serve("on000002", "1.0.0", describing("on000002", "1.0.0"));
    const body = await json(await call("?execute=1"));
    expect(body.absent).toBe(1);
    expect(snapshotOf("on000001")).toEqual({
      source_version: null,
      source_version_basis: "unknown",
    });
  });

  test("every read failing is a 502 that writes nothing", async () => {
    seed("on000001");
    seed("on000002");
    raw.serve("on000001", "1.0.0", "boom", 500);
    raw.serve("on000002", "1.0.0", "boom", 503);
    const res = await call("?execute=1");
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.errors).toHaveLength(2);
    expect(snapshotOf("on000001")).toEqual(NOT_EXAMINED);
    expect(snapshotOf("on000002")).toEqual(NOT_EXAMINED);
  });

  test("a raw host that cannot be reached is an error, never unknown", async () => {
    seed("on000001");
    seed("on000002");
    const res = await call("?execute=1", ADMIN_KEY, env({ GITHUB_RAW_BASE: "http://127.0.0.1:1" }));
    expect(res.status).toBe(502);
    expect(snapshotOf("on000001")).toEqual(NOT_EXAMINED);
    expect(snapshotOf("on000002")).toEqual(NOT_EXAMINED);
  });

  test("a batch where every description is absent is a suspect credential and writes nothing", async () => {
    seed("on000001");
    seed("on000002");
    seed("on000003");
    const res = await call("?execute=1");
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body).toMatchObject({ ok: false, suspect_credential: true, absent: 3 });
    for (const id of ["on000001", "on000002", "on000003"]) {
      expect(snapshotOf(id)).toEqual(NOT_EXAMINED);
    }
  });

  test("a batch of one absent description is recorded: there is no majority to doubt", async () => {
    seed("on000001");
    const res = await call("?execute=1");
    expect(res.status).toBe(200);
    expect(snapshotOf("on000001")).toEqual({
      source_version: null,
      source_version_basis: "unknown",
    });
  });

  test("no GitHub credential is a 502 that reads and writes nothing", async () => {
    seed("on000001");
    raw.serve("on000001", "1.0.0", describing("on000001", "1.0.0"));
    const res = await call("?execute=1", ADMIN_KEY, env({ GITHUB_ADMIN_PAT: undefined }));
    expect(res.status).toBe(502);
    expect(raw.log).toHaveLength(0);
    expect(snapshotOf("on000001")).toEqual(NOT_EXAMINED);
  });

  test("a database failure while choosing candidates is a 500", async () => {
    seed("on000001");
    const broken = wrapD1(realD1(db), (sql) => {
      if (sql.includes("ORDER BY dv.dataset_id")) throw new Error("D1 unavailable");
    });
    const res = await call("?execute=1", ADMIN_KEY, env({}, broken));
    expect(res.status).toBe(500);
  });
});

describe("upstream-backfill: who is a candidate", () => {
  test("a row under an hour old, a withdrawn dataset, a non-on dataset and a repo-less dataset are skipped", async () => {
    seed("on000001");
    seed("on000002", ["1.0.0"], { age: "datetime('now', '-10 minutes')" });
    seed("on000003", ["1.0.0"], { withdrawn: true });
    seed("nm000004");
    seed("xx000005");
    seed("on000006", ["1.0.0"], { repo: null });
    for (const id of ["on000001", "on000002", "on000003", "nm000004", "xx000005", "on000006"]) {
      raw.serve(id, "1.0.0", describing(`on${id.slice(2)}`, "1.0.0"));
    }
    const body = await json(await call("?execute=1"));
    expect(body.scanned).toBe(1);
    expect(snapshotOf("on000001")?.source_version_basis).toBe("doi");
    for (const id of ["on000002", "on000003", "nm000004", "xx000005", "on000006"]) {
      expect(snapshotOf(id)).toEqual(NOT_EXAMINED);
    }
    expect(raw.log).toHaveLength(1);
  });

  test("a row that has been examined is not examined again, whatever the file now says", async () => {
    seed("on000001");
    raw.serve("on000001", "1.0.0", describing("on000001", "1.0.0"));
    await call("?execute=1");
    raw.serve("on000001", "1.0.0", describing("on000001", "9.9.9"));
    raw.log.length = 0;
    const second = await json(await call("?execute=1"));
    expect(second.scanned).toBe(0);
    expect(second.recorded).toEqual({ doi: 0, unknown: 0 });
    expect(raw.log).toHaveLength(0);
    expect(snapshotOf("on000001")?.source_version).toBe("1.0.0");
  });

  test("a row another writer fills between the read and the write is left as that writer set it", async () => {
    seed("on000001");
    raw.serve("on000001", "1.0.0", describing("on000001", "2.0.2"));
    // The live insert path wins the race: it records a value just before the backfill's write runs.
    const racing = realD1(db);
    const batch = racing.batch.bind(racing);
    racing.batch = ((statements: D1PreparedStatement[]) => {
      db.run(
        "UPDATE dataset_versions SET source_version = '7.7.7', source_version_basis = 'doi' WHERE dataset_id = 'on000001'",
      );
      return batch(statements);
    }) as typeof racing.batch;
    const body = await json(await call("?execute=1", ADMIN_KEY, env({}, racing)));
    expect(body.skipped_existing).toBe(1);
    expect(body.recorded).toEqual({ doi: 0, unknown: 0 });
    expect(snapshotOf("on000001")).toEqual({
      source_version: "7.7.7",
      source_version_basis: "doi",
    });
  });
});

describe("upstream-backfill: paging", () => {
  function seedMany(n: number): string[] {
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) {
      const id = `on${String(i).padStart(6, "0")}`;
      ids.push(id);
      seed(id);
      raw.serve(id, "1.0.0", describing(id, "1.0.0"));
    }
    return ids;
  }

  test("following next_cursor visits every row exactly once, in key order", async () => {
    const ids = seedMany(5);
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const body: Body = await json(await call(`?limit=2${cursor ? `&after=${cursor}` : ""}`));
      // A dry run records nothing, so the rows the cursor passed are visible only in the log.
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    const visited = raw.log.map((r) => r.path.split("/")[2]);
    expect(visited.sort()).toEqual(ids);
  });

  test("a row that always errors does not starve the rows behind it", async () => {
    const ids = seedMany(5);
    raw.serve(ids[0] as string, "1.0.0", "boom", 500);
    let cursor: string | null = null;
    let calls = 0;
    do {
      const body: Body = await json(
        await call(`?execute=1&limit=2${cursor ? `&after=${cursor}` : ""}`),
      );
      cursor = body.next_cursor;
      calls++;
    } while (cursor && calls < 10);
    expect(cursor).toBeNull();
    expect(snapshotOf(ids[0] as string)).toEqual(NOT_EXAMINED);
    for (const id of ids.slice(1)) {
      expect(snapshotOf(id)?.source_version_basis).toBe("doi");
    }
  });

  test("stopping and resuming from the printed cursor finishes the pass", async () => {
    const ids = seedMany(4);
    const first = await json(await call("?execute=1&limit=2"));
    expect(first.scanned).toBe(2);
    expect(first.remaining).toBe(2);
    expect(first.next_cursor).toBe(`${ids[1]}@1.0.0`);
    // Resume with the cursor; the two rows done already are not candidates either way.
    const second = await json(await call(`?execute=1&limit=2&after=${first.next_cursor}`));
    expect(second.scanned).toBe(2);
    expect(second.next_cursor).toBeNull();
    expect(second.counts).toMatchObject({ doi: 4, not_examined: 0 });
  });

  test("limit defaults to 25, is clamped to 50, and a nonsense limit is the default", async () => {
    seedMany(60);
    expect((await json(await call())).scanned).toBe(25);
    expect((await json(await call("?limit=500"))).scanned).toBe(50);
    expect((await json(await call("?limit=0"))).scanned).toBe(25);
    expect((await json(await call("?limit=abc"))).scanned).toBe(25);
    expect((await json(await call("?limit=3"))).scanned).toBe(3);
  });

  test("counts describe every on version row, not only the batch", async () => {
    seed("on000001", ["1.0.0", "2.0.0"]);
    seed("nm000002");
    db.run(
      "UPDATE dataset_versions SET source_version = '3.0.0', source_version_basis = 'lineage' WHERE dataset_id = 'on000001' AND version = '2.0.0'",
    );
    raw.serve("on000001", "1.0.0", describing("on000001", "1.0.0"));
    const body = await json(await call());
    expect(body.counts).toEqual({ doi: 0, lineage: 1, unknown: 0, not_examined: 1 });
  });
});
