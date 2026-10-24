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
 *  - withdrawn, fixture, catalog and non-OpenNeuro rows stay out and are counted, and the report
 *    itself writes nothing (authentication still stamps tokens.last_used_at).
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import type { UpstreamStatusPage } from "../../shared/upstream-staleness";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { adminRoutes } from "../src/routes/admin";
import { registerUpstreamStatusRoutes } from "../src/routes/admin/upstream-status";
import { hashApiKey } from "../src/services/token";
import {
  MIRROR_BASE,
  MIRROR_POPULATION,
  UPSTREAM_STATUS_ONE_SQL,
  UPSTREAM_STATUS_PAGE_SQL,
  UPSTREAM_STATUS_REMAINING_SQL,
  UPSTREAM_STATUS_TOTALS_SQL,
  runUpstreamFleetSummary,
  runUpstreamStatusPage,
} from "../src/services/upstream-status";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1, wrapD1 } from "./helpers/d1";
import { startOpenNeuroStandin } from "./helpers/openneuro-standin";
import { startRawHost } from "./helpers/raw-mirror-standin";

const ADMIN_KEY = "ups-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "ups-member-key-0123456789abcdef0123456789abcdef0";
const PAT = "ups-test-pat";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

// ----------------------------------------------------------------------------
// The raw content host
// ----------------------------------------------------------------------------

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
    // The one on###### row that is not a managed mirror (the system-owned catalog shadow) is said.
    expect(page.excluded_unmanaged).toBe(1);
  });

  test("an id that only starts like on###### is not a mirror and is not counted as one", async () => {
    seedFleet();
    // source = 'openneuro' and a real owner, so only the id shape keeps them out.
    for (const id of ["on1234567", "onabcdef", "on00000a", "on12345"]) seed(id, at("1.0.0"));
    const page = await body(await call(""));
    expect(page.rows.map((r) => r.dataset_id)).toEqual(POPULATION);
    expect(page.population_total).toBe(POPULATION.length);
    expect(page.excluded_unmanaged).toBe(1);
    const asked = openneuro.log.flatMap((r) => r.ids);
    for (const id of ["ds1234567", "dsabcdef", "ds00000a", "ds12345"]) {
      expect(asked).not.toContain(id);
    }
  });

  test("unmanaged on###### rows are counted whatever makes them unmanaged", async () => {
    seed("on000010", { ...at("1.0.0"), source: "nemar.org" });
    seed("on000011", { ...at("1.0.0"), owner: -1 });
    seed("on000012");
    const page = await body(await call(""));
    expect(page.rows.map((r) => r.dataset_id)).toEqual(["on000012"]);
    expect(page.excluded_unmanaged).toBe(2);
    expect(page.population_total).toBe(1);
  });

  test("an empty fleet is zeros, never null", async () => {
    const page = await body(await call(""));
    expect(page.rows).toEqual([]);
    expect(page.population_total).toBe(0);
    expect(page.withdrawn).toBe(0);
    expect(page.excluded_unmanaged).toBe(0);
    expect(page.ok).toBe(true);
    expect(page.upstream_requests).toBe(0);
    expect(Object.values(page.counts.states).every((n) => n === 0)).toBe(true);
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

  test("a limit above 100 is clamped to 100; the default is 100", async () => {
    for (let i = 0; i < 105; i++) seed(`on${String(100000 + i)}`);
    const clamped = await body(await call("?limit=5000"));
    expect(clamped.rows).toHaveLength(100);
    expect(clamped.next_cursor).toBe("on100099");
    expect(clamped.remaining).toBe(5);
    expect((await body(await call(""))).rows).toHaveLength(100);
    expect((await body(await call("?limit=2"))).rows).toHaveLength(2);
  });

  test("a limit that is not a positive integer is 400, and nothing is read", async () => {
    seedFleet();
    for (const bad of ["abc", "0", "-3", "", "1.5", "1e3", " 5", "5x"]) {
      const res = await call(`?limit=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    }
    expect(openneuro.log).toHaveLength(0);
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
      "?after=xon000001",
      "?after=on0000011",
      "?after=on000001%0A",
      "?dataset=xon000001",
      "?dataset=on0000011",
      "?dataset=on000001%0A",
    ]) {
      expect((await call(q)).status).toBe(400);
    }
    expect(openneuro.log).toHaveLength(0);
  });

  test("dataset together with after is 400", async () => {
    seedFleet();
    const res = await call("?dataset=on003645&after=on000001");
    expect(res.status).toBe(400);
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

describe("upstream-status: in-progress and unknown-tag rows", () => {
  test("preparing, copying and finalizing are each in_progress and never sent to OpenNeuro", async () => {
    seed("on000021", { ...at("1.0.0"), job: { status: "preparing" } });
    seed("on000022", { ...at("1.0.0"), job: { status: "copying" } });
    seed("on000023", { ...at("1.0.0"), job: { status: "finalizing" } });
    seed("on000024", { ...at("1.0.0"), job: { status: "complete" } });
    const rows = byId(await body(await call("")));
    for (const id of ["on000021", "on000022", "on000023"]) {
      expect(rows[id]?.state).toBe("in_progress");
    }
    expect(rows.on000024?.state).not.toBe("in_progress");
    expect(openneuro.log.flatMap((r) => r.ids)).toEqual(["ds000024"]);
  });

  test("an unknown tag older than upstream's latest is probably stale, and still unknown", async () => {
    seed("on003082", {
      versions: [{ version: "1.0.0", tag: null, basis: "unknown", created: "2019-01-01 00:00:00" }],
    });
    const page = await body(await call(""));
    const row = byId(page).on003082;
    expect([row?.state, row?.probably_stale]).toEqual(["unknown", true]);
    expect(page.counts.probably_stale).toBe(1);
    expect(page.counts.stale).toBe(0);
  });

  test("only unknown-tag rows with OpenNeuro down is 200, each row unknown and naming the failure", async () => {
    seed("on003082", {
      versions: [{ version: "1.0.0", tag: null, basis: "unknown", created: "2019-01-01 00:00:00" }],
    });
    seed("on000042", {
      versions: [{ version: "1.0.0", tag: null, basis: "unknown", created: "2019-01-01 00:00:00" }],
    });
    openneuro.synthetic(true);
    openneuro.status(503);
    const res = await call("");
    expect(res.status).toBe(200);
    const page = await body(res);
    expect(page.ok).toBe(true);
    expect(page.errors).toHaveLength(1);
    for (const id of ["on003082", "on000042"]) {
      const row = byId(page)[id];
      expect(row?.state).toBe("unknown");
      expect(row?.probably_stale).toBeNull();
      expect(row?.reason).toContain("OpenNeuro could not be read");
    }
    expect(page.counts.states.unchecked).toBe(0);
  });

  test("an unknown row beside a known one: 502 only when the known one is unchecked too", async () => {
    seed("on003082", {
      versions: [{ version: "1.0.0", tag: null, basis: "unknown", created: "2019-01-01 00:00:00" }],
    });
    seed("on002893", at("2.0.0"));
    openneuro.status(503);
    expect((await call("")).status).toBe(502);
    openneuro.reset();
    expect((await call("")).status).toBe(200);
  });
});

describe("upstream-status: through the real admin router", () => {
  const request = (key: string | null) =>
    adminRoutes.request(
      "/upstream-status",
      { method: "GET", headers: key ? { Authorization: `Bearer ${key}` } : {} },
      env(),
    );

  test("401 without a credential, 403 for a member, 200 for an admin", async () => {
    seedFleet();
    expect((await request(null)).status).toBe(401);
    expect((await request(MEMBER_KEY)).status).toBe(403);
    expect(openneuro.log).toHaveLength(0);
    const res = await request(ADMIN_KEY);
    expect(res.status).toBe(200);
    expect((await body(res)).rows.length).toBe(POPULATION.length);
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
    // No request was made, so none is claimed.
    expect(page.probes.attempted).toBe(0);
  });

  test("a 200 whose body is not a JSON object proves nothing: unverified, never ready or lag", async () => {
    seed("on003645", at("2.0.2"));
    seed("on004362", at("1.0.0"));
    seed("on000001", at("00006"));
    raw.serve("ds003645", "2.1.0", 200, "<html><body>Not found, but 200</body></html>");
    // A 404 at the tag and an HTML 200 at the control read.
    raw.serve("ds004362", "HEAD", 200, "<html>login</html>");
    // A JSON array is not a description either.
    raw.serve("ds000001", "1.0.0", 200, "[]");
    const rows = byId(await body(await call("")));
    expect(rows.on003645?.state).toBe("stale_unverified");
    expect(rows.on003645?.reason).toContain("not a JSON object");
    expect(rows.on004362?.state).toBe("stale_unverified");
    expect(rows.on004362?.reason).toContain("HEAD");
    expect(rows.on004362?.reason).toContain("not a JSON object");
    expect(rows.on000001?.state).toBe("stale_unverified");
  });

  test("probes run at most five at a time, and more than one at a time", async () => {
    openneuro.synthetic(true);
    for (let i = 0; i < 12; i++) {
      const id = `on${String(100 + i).padStart(6, "0")}`;
      seed(id, at("0.9.0"));
      raw.serve(`ds${id.slice(2)}`, "HEAD"); // the control read succeeds: every row is mirror_lag
    }
    raw.delay(40);
    const page = await runUpstreamStatusPage(env());
    expect(page.probes.attempted).toBe(12);
    expect(page.counts.states.mirror_lag).toBe(12);
    expect(raw.maxInFlight()).toBeLessThanOrEqual(5);
    expect(raw.maxInFlight()).toBeGreaterThan(1);
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

  test("every statement the report runs is a SELECT or WITH, apart from authentication's stamp", async () => {
    seedFleet();
    const statements: string[] = [];
    const recording = wrapD1(realD1(db), (sql) => {
      statements.push(sql.replace(/\s+/g, " ").trim());
    });
    expect((await call("", ADMIN_KEY, env({}, recording))).status).toBe(200);
    expect((await call("?dataset=on003645", ADMIN_KEY, env({}, recording))).status).toBe(200);
    expect(statements.length).toBeGreaterThan(3);
    const writes = statements.filter((sql) => !/^(SELECT|WITH)\b/i.test(sql));
    // Authentication, which wraps the route, stamps the token it just used; nothing else writes.
    for (const sql of writes) expect(sql).toMatch(/^UPDATE tokens SET last_used_at\b/i);
    expect(writes.length).toBeLessThanOrEqual(2);
    // The report's own statements are the exported ones.
    expect(statements.some((sql) => sql.startsWith("WITH page AS"))).toBe(true);
    expect(statements.filter((sql) => sql.includes("COUNT(CASE"))).toHaveLength(2);
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

  test("a defect after D1 was read is 500 but is not reported as a database failure", async () => {
    seedFleet();
    // The raw host base is read while probing; a throwing getter is a TypeError in the probe
    // stage, long after every D1 statement of the page has run.
    const broken = env();
    Object.defineProperty(broken, "GITHUB_RAW_BASE", {
      get() {
        throw new TypeError("raw base exploded");
      },
    });
    const res = await call("", ADMIN_KEY, broken);
    expect(res.status).toBe(500);
    const text = ((await res.json()) as { error: string }).error;
    expect(text).toContain("raw base exploded");
    expect(text).toContain("not a database failure");
    expect(text).not.toContain("Failed to read datasets");
  });

  test("a failing remaining-count statement is a database failure too", async () => {
    seedFleet();
    const failing = wrapD1(realD1(db), (sql) => {
      if (sql.includes("SELECT COUNT(*) AS n FROM datasets")) throw new Error("D1_ERROR: gone");
    });
    const res = await call("?limit=2", ADMIN_KEY, env({}, failing));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("Failed to read datasets");
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
      excluded_unmanaged: 1,
    });
  });
});

describe("runUpstreamFleetSummary: the whole fleet in counts, for the weekly report", () => {
  const ids = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => `on${String(from + i).padStart(6, "0")}`);

  test("pages are walked and recounted from the rows: 130 mirrors, 2 pages, none counted twice", async () => {
    for (const id of ids(200000, 130)) seed(id);
    const summary = await runUpstreamFleetSummary(env());
    expect(summary.population).toBe(130);
    expect(summary.examined).toBe(130);
    expect(summary.counts.states.unpublished).toBe(130);
    expect(summary.truncated).toBe(false);
    expect(summary.errors).toEqual([]);
  });

  test("stopping at maxPages is truncated, and says how many were reached", async () => {
    for (const id of ids(200000, 130)) seed(id);
    const summary = await runUpstreamFleetSummary(env(), { maxPages: 1 });
    expect(summary.examined).toBe(100);
    expect(summary.population).toBe(130);
    expect(summary.truncated).toBe(true);
    // Exactly enough pages is not truncated.
    expect((await runUpstreamFleetSummary(env(), { maxPages: 2 })).truncated).toBe(false);
  });

  test("the probe budget is for the whole pass, not for each page", async () => {
    openneuro.synthetic(true);
    for (const id of ids(300000, 5)) {
      seed(id, at("0.9.0"));
      raw.serve(`ds${id.slice(2)}`, "HEAD");
    }
    const summary = await runUpstreamFleetSummary(env(), { probeBudget: 2 });
    expect(summary.counts.states.mirror_lag).toBe(2);
    expect(summary.counts.states.stale_unverified).toBe(3);
    expect(summary.counts.stale).toBe(5);
    // 2 tag reads and 2 control reads; the three left out cost nothing.
    expect(raw.log).toHaveLength(4);
  });

  test("a population that changes between pages is truncated even if every row was reached", async () => {
    for (const id of ids(200000, 130)) seed(id);
    let pages = 0;
    const racing = wrapD1(realD1(db), (sql) => {
      // A mirror appears just as the second page is read: both pages are consistent with
      // themselves, and the pass saw two different fleets.
      if (sql.includes("WITH page AS") && ++pages === 2) seed("on999998");
    });
    const summary = await runUpstreamFleetSummary(env({}, racing));
    expect(summary.examined).toBe(131);
    expect(summary.population).toBe(131);
    expect(summary.truncated).toBe(true);
  });

  test("a mirror withdrawn and another created mid-pass leaves the count unchanged and the set wrong", async () => {
    for (const id of ids(200000, 130)) seed(id);
    let pages = 0;
    const racing = wrapD1(realD1(db), (sql) => {
      if (sql.includes("WITH page AS") && ++pages === 2) {
        // One already-read mirror leaves and one new one arrives past the cursor: the population
        // is 130 at both ends, but the rows reached are not the fleet that exists.
        db.run("UPDATE datasets SET withdrawn_at = datetime('now') WHERE dataset_id = 'on200005'");
        seed("on999998");
      }
    });
    const summary = await runUpstreamFleetSummary(env({}, racing));
    expect(summary.population).toBe(130);
    expect(summary.examined).toBe(131);
    expect(summary.truncated).toBe(true);
  });

  test("exactly the page cap with nothing more to read is not truncated (2,000 mirrors)", async () => {
    db.run("BEGIN");
    for (const id of ids(300000, 2000)) seed(id);
    db.run("COMMIT");
    const summary = await runUpstreamFleetSummary(env());
    expect(summary.population).toBe(2000);
    expect(summary.examined).toBe(2000);
    expect(summary.truncated).toBe(false);
    expect(summary.errors).toEqual([]);
  });

  test("past the 2,000-mirror ceiling the pass is truncated, and says how many it reached", async () => {
    db.run("BEGIN");
    for (const id of ids(300000, 2001)) seed(id);
    db.run("COMMIT");
    const summary = await runUpstreamFleetSummary(env());
    expect(summary.examined).toBe(2000);
    expect(summary.population).toBe(2001);
    expect(summary.truncated).toBe(true);
  });

  test("with 130 stale mirrors over two pages a pass makes at most 25 tag reads and 25 controls", async () => {
    openneuro.synthetic(true);
    for (const id of ids(400000, 130)) {
      seed(id, at("0.9.0"));
      raw.serve(`ds${id.slice(2)}`, "HEAD");
    }
    const summary = await runUpstreamFleetSummary(env());
    expect(summary.counts.states.mirror_lag).toBe(25);
    expect(summary.counts.states.stale_unverified).toBe(105);
    expect(raw.log).toHaveLength(50);
  });

  test("the GitHub token is asked for once per pass, and a failed mint is remembered, not retried per page", async () => {
    openneuro.synthetic(true);
    for (const id of ids(500000, 105)) seed(id, at("0.9.0"));
    const readsOf = async (extra: Partial<Bindings>, rows: number) => {
      let reads = 0;
      const counting = env(extra);
      Object.defineProperty(counting, "GITHUB_ADMIN_PAT", {
        get() {
          reads++;
          return extra.GITHUB_ADMIN_PAT;
        },
      });
      // `rows` mirrors per pass: 5 is one page, 105 is two.
      db.run("UPDATE datasets SET withdrawn_at = NULL");
      db.run(
        `UPDATE datasets SET withdrawn_at = datetime('now') WHERE dataset_id > 'on${500000 + rows - 1}'`,
      );
      await runUpstreamFleetSummary(counting);
      return reads;
    };
    for (const pat of [undefined, "ups-test-pat"]) {
      const onePage = await readsOf({ GITHUB_ADMIN_PAT: pat }, 5);
      const twoPages = await readsOf({ GITHUB_ADMIN_PAT: pat }, 105);
      expect(onePage).toBeGreaterThan(0);
      expect(twoPages).toBe(onePage);
    }
  });

  test("the budget is spent across pages: 105 stale mirrors, budget 3, only 3 are probed", async () => {
    openneuro.synthetic(true);
    for (const id of ids(600000, 105)) {
      seed(id, at("0.9.0"));
      raw.serve(`ds${id.slice(2)}`, "HEAD");
    }
    const summary = await runUpstreamFleetSummary(env(), { probeBudget: 3 });
    expect(summary.counts.states.mirror_lag).toBe(3);
    expect(summary.counts.states.stale_unverified).toBe(102);
    expect(raw.log).toHaveLength(6);
  });

  test("by default a pass probes 25 tags at most", async () => {
    openneuro.synthetic(true);
    for (const id of ids(700000, 30)) {
      seed(id, at("0.9.0"));
      raw.serve(`ds${id.slice(2)}`, "HEAD");
    }
    const summary = await runUpstreamFleetSummary(env());
    expect(summary.counts.states.mirror_lag).toBe(25);
    expect(summary.counts.states.stale_unverified).toBe(5);
  });

  test("a refused page stops the pass at once, and its errors name no dataset", async () => {
    openneuro.synthetic(true);
    for (const id of ids(400000, 101)) seed(id, at("0.9.0"));
    openneuro.status(503);
    const summary = await runUpstreamFleetSummary(env());
    // One page of 100 asks OpenNeuro in two batches of 50; the second page is never started.
    expect(openneuro.log).toHaveLength(2);
    expect(summary.truncated).toBe(true);
    expect(summary.examined).toBe(100);
    expect(summary.counts.states.unchecked).toBe(100);
    expect(summary.errors.length).toBeGreaterThan(0);
    for (const e of summary.errors) expect(e).not.toMatch(/\bds\d{6}\b/);
    expect(summary.errors.some((e) => e.includes("503"))).toBe(true);
  });

  test("a D1 failure throws, so the report records the pass as unknown", async () => {
    seed("on000001");
    const failing = wrapD1(realD1(db), (sql) => {
      if (sql.includes("WITH page AS")) throw new Error("D1_ERROR: gone");
    });
    await expect(runUpstreamFleetSummary(env({}, failing))).rejects.toThrow("gone");
  });
});
