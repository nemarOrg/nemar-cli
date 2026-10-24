/**
 * Real `GET /admin/upstream-status` route tests (epic #1046 phase 4a, #1910; ADR 0111), modelled
 * on `upstream-backfill-route.test.ts`: real SQLite behind `realD1` carrying every migration, the
 * real auth and admin middleware with seeded tokens, the real route and service.
 *
 * Two local servers stand in for the outside world and nothing else is replaced:
 *  - OpenNeuro's GraphQL endpoint answers from the REAL recorded response of 2026-10-24
 *    (`helpers/openneuro-standin.ts`), so the seed uses the recorded datasets;
 *  - the raw content host is a `Bun.serve` that logs every request.
 *
 * The properties that matter, each with a test that fails when its line is changed:
 *  - one page reaches every state, and the rows that cannot be compared are never sent to OpenNeuro;
 *  - "mirror lag" is proved with a control read: a 404 at the tag alone is `stale_unverified`;
 *  - a failed OpenNeuro read is `unchecked`, never a verdict, and the route says so with a 502;
 *  - the keyset partitions the population: no row twice, none missing;
 *  - withdrawn, fixture, catalog and non-OpenNeuro rows stay out, and the report writes nothing.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import type { UpstreamStatusPage } from "../../shared/upstream-staleness";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamStatusRoutes } from "../src/routes/admin/upstream-status";
import { hashApiKey } from "../src/services/token";
import {
  MIRROR_BASE,
  MIRROR_POPULATION,
  UPSTREAM_STATUS_ONE_SQL,
  UPSTREAM_STATUS_PAGE_SQL,
  UPSTREAM_STATUS_REMAINING_SQL,
  UPSTREAM_STATUS_TOTALS_SQL,
  runUpstreamStatusPage,
} from "../src/services/upstream-status";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1, wrapD1 } from "./helpers/d1";
import { startOpenNeuroStandin } from "./helpers/openneuro-standin";

const ADMIN_KEY = "ups-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "ups-member-key-0123456789abcdef0123456789abcdef0";
const PAT = "ups-test-pat";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

// ----------------------------------------------------------------------------
// The raw content host
// ----------------------------------------------------------------------------

interface RawRequest {
  path: string;
  authorization: string | null;
}

function startRawHost() {
  const files = new Map<string, number>();
  const log: RawRequest[] = [];
  const server: Server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      log.push({ path, authorization: req.headers.get("authorization") });
      const status = files.get(path);
      if (status === undefined) return new Response("404: Not Found", { status: 404 });
      return new Response(status === 200 ? '{"Name":"x"}' : "error", { status });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    log,
    /** Serve `dataset_description.json` of OpenNeuro's `ds` at `ref` with `status`. */
    serve(ds: string, ref: string, status = 200) {
      files.set(`/OpenNeuroDatasets/${ds}/${ref}/dataset_description.json`, status);
    },
    reset() {
      files.clear();
      log.length = 0;
    },
    stop: () => server.stop(true),
  };
}

let raw: ReturnType<typeof startRawHost>;
let openneuro: ReturnType<typeof startOpenNeuroStandin>;
let db: Database;
let app: App;
let ownerId = 0;

beforeAll(() => {
  raw = startRawHost();
  openneuro = startOpenNeuroStandin();
});
afterAll(() => {
  raw.stop();
  openneuro.stop();
});

function newApp(): App {
  const a: App = new Hono();
  a.use("*", authMiddleware);
  a.use("*", adminMiddleware);
  registerUpstreamStatusRoutes(a);
  return a;
}

async function seedUsers(): Promise<void> {
  for (const [name, role, key] of [
    ["upsadmin", "admin", ADMIN_KEY],
    ["upsmember", "member", MEMBER_KEY],
  ] as const) {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('${name}', '${name}@example.org', 'x', 'approved', '${role}', 1)`,
    );
    const u = db.query<{ id: number }, []>(`SELECT id FROM users WHERE username='${name}'`).get();
    if (name === "upsadmin") ownerId = u?.id ?? 0;
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
  openneuro.reset();
  app = newApp();
  await seedUsers();
});

function env(over: Partial<Bindings> = {}, d1: D1Database = realD1(db)): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: PAT,
    GITHUB_RAW_BASE: raw.base,
    OPENNEURO_GRAPHQL_URL: openneuro.url,
    ...over,
  } as Bindings;
}

function call(query = "", key: string | null = ADMIN_KEY, bindings: Bindings = env()) {
  return app.request(
    `/upstream-status${query}`,
    { method: "GET", headers: key ? { Authorization: `Bearer ${key}` } : {} },
    bindings,
  );
}

const body = async (res: Response) => (await res.json()) as UpstreamStatusPage;

// ----------------------------------------------------------------------------
// Seeding
// ----------------------------------------------------------------------------

interface SeedVersion {
  version: string;
  tag?: string | null;
  basis?: "doi" | "lineage" | "unknown" | null;
  created?: string;
}

interface SeedOptions {
  versions?: SeedVersion[];
  owner?: number;
  source?: string;
  sourceId?: string | null;
  withdrawn?: boolean;
  visibility?: "public" | "private";
  job?: { status: string; blocklisted?: boolean; reason?: string };
}

/** A dataset row with its versions and, optionally, its import job. */
function seed(id: string, o: SeedOptions = {}): void {
  const sourceId = o.sourceId === undefined ? `ds${id.slice(2)}` : o.sourceId;
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility, source, source_id, withdrawn_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    o.owner ?? ownerId,
    `nemarDatasets/${id}`,
    o.visibility ?? "public",
    o.source ?? "openneuro",
    sourceId,
    o.withdrawn ? "2026-01-01 00:00:00" : null,
  );
  for (const v of o.versions ?? []) {
    const basis = v.basis === undefined ? (v.tag ? "doi" : null) : v.basis;
    db.query(
      `INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      v.version,
      `10.82901/${id}.v${v.version}`,
      v.tag ?? null,
      basis,
      v.created ?? "2025-06-01 00:00:00",
    );
  }
  if (o.job) {
    db.query(
      `INSERT INTO import_jobs (dataset_id, source, source_id, status, blocklisted, blocklist_reason)
       VALUES (?, 'openneuro', ?, ?, ?, ?)`,
    ).run(id, sourceId ?? "", o.job.status, o.job.blocklisted ? 1 : 0, o.job.reason ?? null);
  }
}

const at = (tag: string): SeedOptions => ({ versions: [{ version: "1.0.0", tag }] });

/**
 * The fleet of the issue: one mirror per state, using the datasets in the recording, plus the
 * rows that must stay out of the report.
 */
function seedFleet(): void {
  seed("on003645", at("2.0.2")); // stale_ready: the tag is on the GitHub mirror
  seed("on004362", at("1.0.0")); // mirror_lag: 404 at the tag, 200 at HEAD
  seed("on000001", at("00006")); // stale_unverified: 404 at the tag and at HEAD
  seed("on002893", at("2.0.0")); // current
  seed("on003082", {
    versions: [{ version: "1.0.0", tag: null, basis: "unknown", created: "2026-03-01 00:00:00" }],
  }); // unknown, not probably stale (upstream's 1.0.1 is from 2021)
  seed("on006903", at("1.0.0")); // upstream_deleted
  seed("on999999", at("1.0.0")); // upstream_absent
  seed("on000002", { versions: [{ version: "1.0.0", tag: null, basis: null }] }); // not_examined
  seed("on000003"); // unpublished
  seed("on000004", { ...at("1.0.0"), job: { status: "copying" } }); // in_progress
  seed("on000005", {
    ...at("1.0.0"),
    job: { status: "failed", blocklisted: true, reason: "upstream_inaccessible" },
  }); // parked
  seed("on000006", { ...at("1.0.0"), sourceId: "ds000007" }); // source_id_mismatch

  // Out of the report.
  seed("on000008", { ...at("1.0.0"), withdrawn: true });
  seed("on000009", { ...at("1.0.0"), owner: -1 }); // a catalog shadow row
  seed("nm000200", { ...at("1.0.0"), source: "nemar.org", sourceId: null });
  seed("xx000001", { ...at("1.0.0"), source: "nemar.org", sourceId: null });
  seed("ds003645", { ...at("1.0.0"), owner: -1 });

  raw.serve("ds003645", "2.1.0");
  raw.serve("ds004362", "HEAD");
  // on000001: nothing at 1.0.0 and nothing at HEAD (the default is 404).
}

const POPULATION = [
  "on000001",
  "on000002",
  "on000003",
  "on000004",
  "on000005",
  "on000006",
  "on002893",
  "on003082",
  "on003645",
  "on004362",
  "on006903",
  "on999999",
];

const byId = (page: UpstreamStatusPage) =>
  Object.fromEntries(page.rows.map((r) => [r.dataset_id, r]));

// ----------------------------------------------------------------------------

describe("upstream-status: who may call it", () => {
  test("no credential is 401, a member is 403, and nothing is read", async () => {
    seedFleet();
    expect((await call("", null)).status).toBe(401);
    expect((await call("", MEMBER_KEY)).status).toBe(403);
    expect(openneuro.log).toHaveLength(0);
    expect(raw.log).toHaveLength(0);
  });

  test("the route answers GET and not POST", async () => {
    const res = await app.request(
      "/upstream-status",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(res.status).toBe(404);
  });
});

describe("upstream-status: one page holds every state", () => {
  test("each seeded mirror gets its state, anomaly and reason", async () => {
    seedFleet();
    const res = await call("");
    expect(res.status).toBe(200);
    const page = await body(res);
    const rows = byId(page);
    expect(Object.keys(rows).sort()).toEqual(POPULATION);

    const verdict = (id: string) => [rows[id]?.state, rows[id]?.anomaly];
    expect(verdict("on003645")).toEqual(["stale_ready", null]);
    expect(verdict("on004362")).toEqual(["mirror_lag", null]);
    expect(verdict("on000001")).toEqual(["stale_unverified", null]);
    expect(verdict("on002893")).toEqual(["current", null]);
    expect(verdict("on003082")).toEqual(["unknown", null]);
    expect(verdict("on006903")).toEqual(["anomaly", "upstream_deleted"]);
    expect(verdict("on999999")).toEqual(["anomaly", "upstream_absent"]);
    expect(verdict("on000002")).toEqual(["not_examined", null]);
    expect(verdict("on000003")).toEqual(["unpublished", null]);
    expect(verdict("on000004")).toEqual(["in_progress", null]);
    expect(verdict("on000005")).toEqual(["parked", null]);
    expect(verdict("on000006")).toEqual(["anomaly", "source_id_mismatch"]);

    expect(rows.on003645?.recorded).toEqual({ version: "1.0.0", tag: "2.0.2", basis: "doi" });
    expect(rows.on003645?.upstream?.latest_tag).toBe("2.1.0");
    expect(rows.on003645?.ds).toBe("ds003645");
    expect(rows.on003645?.visibility).toBe("public");
    expect(rows.on003645?.reason).toContain("2.1.0");
    expect(rows.on003645?.reason).toContain("2.0.2");
    expect(rows.on003082?.probably_stale).toBe(false);
    expect(rows.on003645?.probably_stale).toBeNull();
    expect(rows.on000004?.import_status).toBe("copying");
    // needs_probe is internal and never on the wire.
    for (const row of page.rows) expect("needs_probe" in row).toBe(false);

    expect(page.ok).toBe(true);
    expect(page.counts.stale).toBe(3);
    expect(page.counts.states.anomaly).toBe(3);
    expect(page.counts.states.unchecked).toBe(0);
    expect(page.next_cursor).toBeNull();
    expect(page.remaining).toBe(0);
  });

  test("only the seven rows that need OpenNeuro were sent", async () => {
    seedFleet();
    await call("");
    expect(openneuro.log).toHaveLength(1);
    expect([...(openneuro.log[0]?.ids ?? [])].sort()).toEqual(
      ["ds000001", "ds002893", "ds003082", "ds003645", "ds004362", "ds006903", "ds999999"].sort(),
    );
    expect(openneuro.log[0]?.userAgent).toBe("NEMAR-API");
  });

  test("the raw reads carry the credential and name OpenNeuro's organization", async () => {
    seedFleet();
    await call("");
    expect(raw.log.length).toBeGreaterThan(0);
    for (const request of raw.log) {
      expect(request.authorization).toBe(`Bearer ${PAT}`);
      expect(request.path.startsWith("/OpenNeuroDatasets/")).toBe(true);
    }
    // ds003645: the tag only. ds004362: the tag, then the control. ds000001: the tag, then the control.
    expect(raw.log.map((r) => r.path).sort()).toEqual(
      [
        "/OpenNeuroDatasets/ds000001/1.0.0/dataset_description.json",
        "/OpenNeuroDatasets/ds000001/HEAD/dataset_description.json",
        "/OpenNeuroDatasets/ds003645/2.1.0/dataset_description.json",
        "/OpenNeuroDatasets/ds004362/1.0.1/dataset_description.json",
        "/OpenNeuroDatasets/ds004362/HEAD/dataset_description.json",
      ].sort(),
    );
  });

  test("a 404 at the tag with no control read proving the credential is stale_unverified, not lag", async () => {
    seed("on004362", at("1.0.0"));
    // Nothing at 1.0.1 and nothing at HEAD: the 404 may be the credential's.
    const rows = byId(await body(await call("")));
    expect(rows.on004362?.state).toBe("stale_unverified");
    expect(rows.on004362?.reason).toContain("HEAD");
  });

  test("a probe error is stale_unverified with the status, never lag", async () => {
    seed("on004362", at("1.0.0"));
    raw.serve("ds004362", "1.0.1", 500);
    const rows = byId(await body(await call("")));
    expect(rows.on004362?.state).toBe("stale_unverified");
    expect(rows.on004362?.reason).toContain("500");
  });

  test("an error on the control read is stale_unverified, never lag", async () => {
    seed("on004362", at("1.0.0"));
    raw.serve("ds004362", "HEAD", 500);
    const rows = byId(await body(await call("")));
    expect(rows.on004362?.state).toBe("stale_unverified");
  });

  test("the highest version speaks: a known 1.0.0 and an unexamined 1.0.1 is not_examined", async () => {
    seed("on003645", {
      versions: [
        { version: "1.0.0", tag: "2.1.0" },
        { version: "1.0.1", tag: null, basis: null },
      ],
    });
    const rows = byId(await body(await call("")));
    expect(rows.on003645?.state).toBe("not_examined");
    expect(openneuro.log).toHaveLength(0);
  });

  test("a version recorded at upstream's latest tag is current even if a lower one is stale", async () => {
    seed("on003645", {
      versions: [
        { version: "1.0.0", tag: "2.0.2" },
        { version: "2.0.0", tag: "2.1.0" },
      ],
    });
    const rows = byId(await body(await call("")));
    expect(rows.on003645?.state).toBe("current");
    expect(rows.on003645?.recorded).toEqual({ version: "2.0.0", tag: "2.1.0", basis: "doi" });
  });
});

describe("upstream-status: who is in the population", () => {
  test("withdrawn, catalog, fixture and non-OpenNeuro rows stay out and are counted right", async () => {
    seedFleet();
    const page = await body(await call(""));
    expect(page.rows.map((r) => r.dataset_id)).not.toContain("on000008");
    expect(page.rows.map((r) => r.dataset_id)).not.toContain("on000009");
    expect(page.rows.map((r) => r.dataset_id)).not.toContain("nm000200");
    expect(page.rows.map((r) => r.dataset_id)).not.toContain("xx000001");
    expect(page.rows.map((r) => r.dataset_id)).not.toContain("ds003645");
    expect(page.population_total).toBe(POPULATION.length);
    expect(page.withdrawn).toBe(1);
  });

  test("an empty fleet is zeros, never null", async () => {
    const page = await body(await call(""));
    expect(page.rows).toEqual([]);
    expect(page.population_total).toBe(0);
    expect(page.withdrawn).toBe(0);
    expect(page.ok).toBe(true);
    expect(page.upstream_requests).toBe(0);
    expect(Object.values(page.counts.states).every((n) => n === 0)).toBe(true);
  });

  test("a mirror whose source differs from openneuro is out", async () => {
    seed("on000010", { ...at("1.0.0"), source: "nemar.org" });
    expect((await body(await call(""))).rows).toEqual([]);
  });
});

describe("upstream-status: keyset paging", () => {
  test("limit=3 walks the population and the pages partition it", async () => {
    seedFleet();
    const seen: string[] = [];
    const remaining: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=3${cursor ? `&after=${cursor}` : ""}`;
      const page: UpstreamStatusPage = await body(await call(query));
      expect(page.rows.length).toBeLessThanOrEqual(3);
      seen.push(...page.rows.map((r) => r.dataset_id));
      remaining.push(page.remaining);
      expect(page.population_total).toBe(POPULATION.length);
      cursor = page.next_cursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(10);
    } while (cursor);
    expect(seen).toEqual(POPULATION);
    expect(new Set(seen).size).toBe(POPULATION.length);
    expect(remaining).toEqual([9, 6, 3, 0]);
    expect(pages).toBe(4);
  });

  test("the cursor is exclusive: after=X starts at the row after X", async () => {
    seedFleet();
    const page = await body(await call("?after=on000003"));
    expect(page.rows[0]?.dataset_id).toBe("on000004");
    expect(page.rows.map((r) => r.dataset_id)).not.toContain("on000003");
  });

  test("a cursor past the end gives no rows and no next cursor", async () => {
    seedFleet();
    const page = await body(await call("?after=on999999"));
    expect(page.rows).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(page.remaining).toBe(0);
    expect(page.ok).toBe(true);
  });

  test("the limit is clamped to 100 and a junk limit falls back to the default", async () => {
    for (let i = 0; i < 105; i++) seed(`on${String(100000 + i)}`);
    const clamped = await body(await call("?limit=5000"));
    expect(clamped.rows).toHaveLength(100);
    expect(clamped.next_cursor).toBe("on100099");
    expect(clamped.remaining).toBe(5);
    const junk = await body(await call("?limit=abc"));
    expect(junk.rows).toHaveLength(100);
    const zero = await body(await call("?limit=0"));
    expect(zero.rows).toHaveLength(100);
  });

  test("a page larger than D1's 100 bound parameters never builds an IN list", async () => {
    // 100 mirrors with 2 versions each; the page statement binds two values whatever the size.
    for (let i = 0; i < 100; i++) {
      seed(`on${String(200000 + i)}`, {
        versions: [
          { version: "1.0.0", tag: null, basis: null },
          { version: "1.0.1", tag: null, basis: null },
        ],
      });
    }
    const page = await body(await call("?limit=100"));
    expect(page.rows).toHaveLength(100);
    expect(page.counts.states.not_examined).toBe(100);
  });
});

describe("upstream-status: single dataset and input checks", () => {
  test("after=bad and dataset=bad are 400", async () => {
    for (const q of [
      "?after=bad",
      "?dataset=bad",
      "?after=on12345",
      "?dataset=ds003645",
      "?after=",
    ]) {
      expect((await call(q)).status).toBe(400);
    }
    expect(openneuro.log).toHaveLength(0);
  });

  test("dataset=on000004 is that one row and has no cursor", async () => {
    seedFleet();
    const page = await body(await call("?dataset=on000004"));
    expect(page.rows.map((r) => r.dataset_id)).toEqual(["on000004"]);
    expect(page.rows[0]?.state).toBe("in_progress");
    expect(page.next_cursor).toBeNull();
    expect(page.remaining).toBe(0);
  });

  test("dataset=on003645 asks OpenNeuro about that one dataset only", async () => {
    seedFleet();
    const page = await body(await call("?dataset=on003645"));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.state).toBe("stale_ready");
    expect(openneuro.log[0]?.ids).toEqual(["ds003645"]);
  });

  test("a withdrawn mirror, a fixture and an unknown id are 404", async () => {
    seedFleet();
    for (const id of ["on000008", "on000009", "on555555"]) {
      const res = await call(`?dataset=${id}`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain("managed OpenNeuro mirror");
    }
  });
});

describe("upstream-status: a failed OpenNeuro read is unchecked, never a verdict", () => {
  test("at 503 every queried row is unchecked, the D1-only states are right, and the route is 502", async () => {
    seedFleet();
    openneuro.status(503);
    const res = await call("");
    expect(res.status).toBe(502);
    const page = await body(res);
    expect(page.ok).toBe(false);
    expect(page.error).toBeDefined();
    const rows = byId(page);
    for (const id of ["on003645", "on004362", "on000001", "on002893", "on006903", "on999999"]) {
      expect(rows[id]?.state).toBe("unchecked");
      expect(rows[id]?.reason).toContain("503");
    }
    // The unknown row is not a verdict either way; it stays unknown with no date comparison.
    expect(rows.on003082?.state).toBe("unknown");
    expect(rows.on003082?.probably_stale).toBeNull();
    expect(rows.on000002?.state).toBe("not_examined");
    expect(rows.on000003?.state).toBe("unpublished");
    expect(rows.on000004?.state).toBe("in_progress");
    expect(rows.on000005?.state).toBe("parked");
    expect(rows.on000006?.anomaly).toBe("source_id_mismatch");
    expect(page.counts.states.unchecked).toBe(6);
    expect(page.counts.stale).toBe(0);
    expect(page.errors).toHaveLength(1);
    // Nothing was probed against GitHub for rows OpenNeuro could not describe.
    expect(raw.log).toHaveLength(0);
  });

  test("one failed row among good ones is 200 with that row unchecked", async () => {
    seedFleet();
    openneuro.override("ds002893", { id: "ds000002", latestSnapshot: null, snapshots: [] });
    const res = await call("");
    expect(res.status).toBe(200);
    const page = await body(res);
    expect(byId(page).on002893?.state).toBe("unchecked");
    expect(byId(page).on003645?.state).toBe("stale_ready");
    expect(page.ok).toBe(true);
  });

  test("a fleet with nothing that needs OpenNeuro is 200 even while OpenNeuro is down", async () => {
    seed("on000003");
    openneuro.status(503);
    const res = await call("");
    expect(res.status).toBe(200);
    expect(openneuro.log).toHaveLength(0);
  });
});

describe("upstream-status: the probe budget", () => {
  test("a call probes at most probeBudget stale rows, in dataset order", async () => {
    seedFleet();
    const page = await runUpstreamStatusPage(env(), { probeBudget: 1 });
    expect(page.probes).toEqual({ attempted: 1, budget: 1 });
    // on000001 is first in order: probed, and unverified (no control proves the credential).
    expect(raw.log.map((r) => r.path).every((p) => p.includes("/ds000001/"))).toBe(true);
    const rows = byId(page);
    expect(rows.on000001?.state).toBe("stale_unverified");
    // The rows the budget left out are stale, said plainly, and not claimed ready or lag.
    expect(rows.on003645?.state).toBe("stale_unverified");
    expect(rows.on003645?.reason).toContain("not checked");
    expect(rows.on004362?.state).toBe("stale_unverified");
    expect(page.counts.stale).toBe(3);
  });

  test("a budget of 0 probes nothing", async () => {
    seedFleet();
    const page = await runUpstreamStatusPage(env(), { probeBudget: 0 });
    expect(page.probes.attempted).toBe(0);
    expect(raw.log).toHaveLength(0);
    expect(page.counts.states.stale_unverified).toBe(3);
  });

  test("a credential that cannot be minted makes every probe unverified with the reason", async () => {
    seedFleet();
    const page = await runUpstreamStatusPage(env({ GITHUB_ADMIN_PAT: undefined }));
    const rows = byId(page);
    for (const id of ["on003645", "on004362", "on000001"]) {
      expect(rows[id]?.state).toBe("stale_unverified");
      expect(rows[id]?.reason).toContain("credential");
    }
    expect(raw.log).toHaveLength(0);
  });
});

describe("upstream-status: read-only", () => {
  function snapshotOfTables(): string {
    const dump = (table: string) =>
      JSON.stringify(db.query(`SELECT * FROM ${table} ORDER BY 1, 2`).all());
    return ["datasets", "dataset_versions", "import_jobs", "audit_log"].map(dump).join("\n");
  }

  test("a full pass leaves datasets, versions, import jobs and the audit log untouched", async () => {
    seedFleet();
    const before = snapshotOfTables();
    expect(before.length).toBeGreaterThan(100);
    expect((await call("")).status).toBe(200);
    expect((await call("?limit=3")).status).toBe(200);
    expect((await call("?dataset=on003645")).status).toBe(200);
    openneuro.status(503);
    expect((await call("")).status).toBe(502);
    expect(snapshotOfTables()).toBe(before);
  });
});

describe("upstream-status: a D1 failure", () => {
  test("a failing page statement is 500 and names the tables", async () => {
    seedFleet();
    const failing = wrapD1(realD1(db), (sql) => {
      if (sql.includes("WITH page AS")) throw new Error("D1_ERROR: no such table: import_jobs");
    });
    const res = await call("", ADMIN_KEY, env({}, failing));
    expect(res.status).toBe(500);
    const text = ((await res.json()) as { error: string }).error;
    expect(text).toContain("import_jobs");
    expect(openneuro.log).toHaveLength(0);
  });

  test("a failing totals statement is 500, not a page with a made-up population", async () => {
    seedFleet();
    const failing = wrapD1(realD1(db), (sql) => {
      if (sql.includes("COUNT(CASE")) throw new Error("D1_ERROR: boom");
    });
    expect((await call("", ADMIN_KEY, env({}, failing))).status).toBe(500);
  });
});

describe("upstream-status: the exported statements are the ones that run", () => {
  test("every statement is valid SQL on the production schema and the population is shared", () => {
    expect(MIRROR_POPULATION.startsWith(MIRROR_BASE)).toBe(true);
    seedFleet();
    const page = db.query(UPSTREAM_STATUS_PAGE_SQL).all("", 100) as Array<{ dataset_id: string }>;
    expect(new Set(page.map((r) => r.dataset_id))).toEqual(new Set(POPULATION));
    expect(db.query(UPSTREAM_STATUS_ONE_SQL).all("on003645")).toHaveLength(1);
    expect(db.query(UPSTREAM_STATUS_REMAINING_SQL).get("on000003")).toEqual({ n: 9 });
    expect(db.query(UPSTREAM_STATUS_TOTALS_SQL).get()).toEqual({
      population: POPULATION.length,
      withdrawn: 1,
    });
  });
});
