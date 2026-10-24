/**
 * The upstream snapshot recorded when a `dataset_versions` row is inserted (epic #1046 phase 2,
 * #1908; ADR 0111, decision 4).
 *
 * Production runs the central manifest flow, so the row that matters is written by the
 * `/webhooks/manifest-ready` callback. It is driven here through the REAL worker with a real HMAC
 * token, real SQLite carrying every migration, and a local HTTP server standing in for the three
 * hosts the flow reaches (the raw content CDN, the GitHub API, S3), which logs every request so a
 * test asserts on what was sent. The admin manifest regeneration path (the other live site) is
 * driven through its real route.
 *
 * The three inline sites (the orchestrator's, the legacy EZID handler's and the Zenodo
 * handler's) are only reachable on the dev flow or not at all, so they are held by a source
 * scan: every INSERT into `dataset_versions` in `backend/src` is the one statement
 * `INSERT_DATASET_VERSION_SQL`, and the scan is proven to fire on a planted violation.
 *
 * What these tests are for, in one line: an insert records a tag only from a description it
 * READ, records `unknown` only for a description that names no single tag, and leaves NULL/NULL
 * whenever it could not read one, without ever failing the callback.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { Hono } from "hono";
import worker from "../src/index";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerDatasetLifecycleRoutes } from "../src/routes/admin/datasets-lifecycle";
import { signManifestCallbackToken } from "../src/services/github/callback-tokens";
import {
  INSERT_DATASET_VERSION_SQL,
  columnsFromDescription,
  snapshotColumnsForInsert,
} from "../src/services/source-snapshot";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { SRC, createTree, foldedStrings, parse, rel } from "./helpers/ts-scan";

const CALLBACK_SECRET = "manifest-callback-secret-0123456789abcdef";
const ADMIN_KEY = "snap-admin-key-0123456789abcdef0123456789abcdef01";
const API = "https://api.nemar.org";
const realFetch = globalThis.fetch;
const quiet = { error: console.error, warn: console.warn, log: console.log };

// ----------------------------------------------------------------------------
// The stand-in server
// ----------------------------------------------------------------------------

interface Logged {
  method: string;
  path: string;
  authorization: string | null;
  userAgent: string | null;
}

/**
 * One local server for the raw content host, the GitHub API and S3. A `dataset_description.json`
 * is served from `descriptions` (path to {status, body}); absent paths are 404. S3 HEAD and PUT
 * answer 200, the GitHub commit and tree endpoints answer an empty repository.
 */
function startStandin() {
  const descriptions = new Map<string, { status: number; body: string }>();
  const log: Logged[] = [];
  let hang = false;
  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      log.push({
        method: req.method,
        path,
        authorization: req.headers.get("authorization"),
        userAgent: req.headers.get("user-agent"),
      });
      if (path.endsWith("/dataset_description.json")) {
        if (hang) return new Promise<Response>(() => {});
        const entry = descriptions.get(path);
        if (!entry) return new Response("404: Not Found", { status: 404 });
        return new Response(entry.body, { status: entry.status });
      }
      if (/^\/repos\/nemarDatasets\/[^/]+\/commits\//.test(path)) {
        return Response.json({ sha: "c".repeat(40), commit: { tree: { sha: "t".repeat(40) } } });
      }
      if (/^\/repos\/nemarDatasets\/[^/]+\/git\/trees\//.test(path)) {
        return Response.json({ sha: "t".repeat(40), tree: [], truncated: false });
      }
      if (req.method === "HEAD" || req.method === "PUT") return new Response(null, { status: 200 });
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    log,
    setHang(on: boolean) {
      hang = on;
    },
    /** Serve a description for `repo` at `v<version>`. */
    describe(repo: string, version: string, body: unknown, status = 200) {
      descriptions.set(`/nemarDatasets/${repo}/v${version}/dataset_description.json`, {
        status,
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    },
    reset() {
      descriptions.clear();
      log.length = 0;
      hang = false;
    },
    rawRequests: () => log.filter((r) => r.path.endsWith("/dataset_description.json")),
    stop: () => server.stop(true),
  };
}

let standin: ReturnType<typeof startStandin>;
let db: Database;

beforeAll(() => {
  standin = startStandin();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = standin.base;
});
afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  standin.stop();
});
beforeEach(() => {
  db = freshDb();
  standin.reset();
  // S3 lives on an amazonaws.com host the code builds itself; send it to the stand-in.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname.endsWith(".amazonaws.com")) {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      return realFetch(`${standin.base}${url.pathname}`, {
        method: input instanceof Request ? input.method : (init?.method ?? "GET"),
        headers,
        body: input instanceof Request ? undefined : init?.body,
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = quiet.error;
  console.warn = quiet.warn;
  console.log = quiet.log;
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_RAW_BASE: standin.base,
    GITHUB_ADMIN_PAT: "snap-test-pat",
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "AKIATEST",
    AWS_SECRET_ACCESS_KEY: "secret",
    MANIFEST_CALLBACK_SECRET: CALLBACK_SECRET,
    ...over,
  } as Bindings;
}

function seedDataset(id: string): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, concept_doi, visibility)
     VALUES (?, ?, -1, ?, ?, 'public')`,
  ).run(id, `Dataset ${id}`, `nemarDatasets/${id}`, `10.82901/nemar.${id}`);
}

async function seedManifestJob(id: string, version: string, nonce: string): Promise<string> {
  db.query(
    `INSERT INTO manifest_jobs (dataset_id, version, nonce, doi, concept_doi, doi_provider, status, request_source)
     VALUES (?, ?, ?, ?, ?, 'ezid', 'dispatched', 'webhook')`,
  ).run(id, version, nonce, `10.82901/nemar.${id}.v${version}`, `10.82901/nemar.${id}`);
  return signManifestCallbackToken({ datasetId: id, version, nonce }, CALLBACK_SECRET);
}

function manifestReady(token: string, id: string, version: string, bindings: Bindings) {
  const work: Promise<unknown>[] = [];
  const response = worker.fetch(
    new Request(`${API}/webhooks/manifest-ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
      body: JSON.stringify({
        dataset_id: id,
        version,
        manifest_url: "https://example.invalid/m.json",
        summary_url: "https://example.invalid/s.json",
        totals: { files: 1, bytes: 1, annex: 0, git: 1 },
        workflow_run_id: "1",
      }),
    }),
    bindings,
    {
      waitUntil: (p: Promise<unknown>) => {
        work.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  );
  return { response, settle: () => Promise.all(work) };
}

function snapshotOf(id: string, version: string) {
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

/** Run the callback to completion for a new `on` dataset and answer the stored snapshot. */
async function publish(id: string, bindings: Bindings = env()) {
  seedDataset(id);
  const token = await seedManifestJob(id, "1.0.0", `nonce-${id}`);
  const { response, settle } = manifestReady(token, id, "1.0.0", bindings);
  const res = await response;
  await settle();
  return { res, snapshot: snapshotOf(id, "1.0.0") };
}

// ----------------------------------------------------------------------------
// Site A: the manifest-ready callback, through the real worker
// ----------------------------------------------------------------------------

describe("the manifest-ready callback records the snapshot it reads", () => {
  test("a description whose own entry names a DOI gives that tag, basis doi", async () => {
    standin.describe("on000020", "1.0.0", {
      Name: "x",
      BIDSVersion: "1.9.0",
      Version: "1.0.0",
      SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds000020.v2.0.2" }],
    });
    const { res, snapshot } = await publish("on000020");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual({ source_version: "2.0.2", source_version_basis: "doi" });
  });

  test("the read goes to the dataset's tagged file with the token, and only there", async () => {
    standin.describe("on000021", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000021.v1.0.1" }],
    });
    await publish("on000021");
    const raw = standin.rawRequests();
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({
      method: "GET",
      path: "/nemarDatasets/on000021/v1.0.0/dataset_description.json",
      authorization: "Bearer snap-test-pat",
      userAgent: "NEMAR-API",
    });
  });

  test("an entry that disagrees with itself is unknown: examined, no tag", async () => {
    standin.describe("on000022", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000022.v2.0.2", Version: "2.0.1" }],
    });
    const { res, snapshot } = await publish("on000022");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual({ source_version: null, source_version_basis: "unknown" });
  });

  test("a description that names no upstream at all is unknown, and NEMAR's own Version is not read", async () => {
    standin.describe("on000023", "1.0.0", { Name: "x", Version: "1.0.0", BIDSVersion: "1.9.0" });
    const { snapshot } = await publish("on000023");
    expect(snapshot).toEqual({ source_version: null, source_version_basis: "unknown" });
  });

  test("a description that is not JSON is unknown", async () => {
    standin.describe("on000024", "1.0.0", "<<not json>>");
    const { res, snapshot } = await publish("on000024");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual({ source_version: null, source_version_basis: "unknown" });
  });

  test("a raw host that answers 500 leaves NULL/NULL and the callback still succeeds", async () => {
    standin.describe("on000025", "1.0.0", "boom", 500);
    const { res, snapshot } = await publish("on000025");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
  });

  test("a 404 right after the tag is NOT examined: the insert never turns absent into unknown", async () => {
    const { res, snapshot } = await publish("on000026");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
    expect(standin.rawRequests()).toHaveLength(1);
  });

  test("a raw host that cannot be reached leaves NULL/NULL and the callback still succeeds", async () => {
    const { res, snapshot } = await publish(
      "on000027",
      env({ GITHUB_RAW_BASE: "http://127.0.0.1:1" }),
    );
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
  });

  test("no GitHub credential at all leaves NULL/NULL, makes no raw request and succeeds", async () => {
    standin.describe("on000028", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000028.v1.0.0" }],
    });
    const { res, snapshot } = await publish("on000028", env({ GITHUB_ADMIN_PAT: undefined }));
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
    expect(standin.rawRequests()).toHaveLength(0);
  });

  test("a raw host that hangs is cut off at the fetch timeout and the callback still succeeds", async () => {
    standin.setHang(true);
    const started = Date.now();
    const { res, snapshot } = await publish("on000029");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
    expect(Date.now() - started).toBeLessThan(5500);
  }, 10_000);

  test("a dataset that is not an on###### mirror makes no raw request and stays NULL/NULL", async () => {
    standin.describe("nm000500", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000500.v1.0.0" }],
    });
    const { res, snapshot } = await publish("nm000500");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
    expect(standin.rawRequests()).toHaveLength(0);
  });

  test("the failed-insert contract is unchanged: a DB failure still answers 500 and leaves the job dispatched", async () => {
    standin.describe("on000030", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000030.v1.0.0" }],
    });
    seedDataset("on000030");
    const token = await seedManifestJob("on000030", "1.0.0", "nonce-30");
    // Remove the table the INSERT writes, so the statement itself fails.
    db.exec("DROP TABLE dataset_versions");
    const { response } = manifestReady(token, "on000030", "1.0.0", env());
    const res = await response;
    expect(res.status).toBe(500);
    expect(
      db.query("SELECT status FROM manifest_jobs WHERE dataset_id = 'on000030'").get(),
    ).toEqual({ status: "dispatched" });
  });
});

// ----------------------------------------------------------------------------
// Site B: admin manifest regeneration, through its real route
// ----------------------------------------------------------------------------

describe("admin manifest regeneration records the snapshot when it repairs a stranded row", () => {
  type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

  async function adminApp(): Promise<App> {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('snapadmin', 'snapadmin@example.org', 'x', 'approved', 'admin', 1)`,
    );
    const admin = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='snapadmin'")
      .get();
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      admin?.id ?? 0,
      await hashApiKey(ADMIN_KEY),
      ADMIN_KEY.slice(0, 8),
    );
    const app: App = new Hono();
    app.use("*", authMiddleware);
    app.use("*", adminMiddleware);
    registerDatasetLifecycleRoutes(app);
    return app;
  }

  async function regenerate(id: string) {
    seedDataset(id);
    const app = await adminApp();
    const res = await app.request(
      `/datasets/${id}/manifest/1.0.0`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ doi: `10.82901/nemar.${id}.v1.0.0` }),
      },
      env(),
    );
    return { res, snapshot: snapshotOf(id, "1.0.0") };
  }

  test("a readable description gives its tag", async () => {
    standin.describe("on000040", "1.0.0", {
      SourceDatasets: [{ URL: "https://openneuro.org/datasets/ds000040/versions/1.2.3" }],
    });
    const { res, snapshot } = await regenerate("on000040");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dataset_versions_backfilled: true });
    expect(snapshot).toEqual({ source_version: "1.2.3", source_version_basis: "doi" });
  });

  test("an unreadable description leaves NULL/NULL and still repairs the row", async () => {
    standin.describe("on000041", "1.0.0", "boom", 500);
    const { res, snapshot } = await regenerate("on000041");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dataset_versions_backfilled: true });
    expect(snapshot).toEqual(NOT_EXAMINED);
  });

  test("it reads with the token the route already holds, from the repository the route resolved", async () => {
    standin.describe("on000042", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000042.v1.0.0" }],
    });
    await regenerate("on000042");
    expect(standin.rawRequests()[0]).toMatchObject({
      path: "/nemarDatasets/on000042/v1.0.0/dataset_description.json",
      authorization: "Bearer snap-test-pat",
    });
  });
});

// ----------------------------------------------------------------------------
// The statement and the inline sites
// ----------------------------------------------------------------------------

describe("INSERT_DATASET_VERSION_SQL", () => {
  test("round-trips both columns on real SQLite and does not overwrite an existing row", () => {
    seedDataset("on000050");
    const insert = (tag: string | null, basis: string | null) =>
      db
        .prepare(INSERT_DATASET_VERSION_SQL)
        .run("on000050", "1.0.0", "10.82901/x", "ezid", tag, basis);
    insert("2.0.2", "doi");
    expect(snapshotOf("on000050", "1.0.0")).toEqual({
      source_version: "2.0.2",
      source_version_basis: "doi",
    });
    // A replayed insert for the same version is a silent no-op, in particular not NULL/NULL.
    expect(() => insert(null, null)).not.toThrow();
    expect(snapshotOf("on000050", "1.0.0")).toEqual({
      source_version: "2.0.2",
      source_version_basis: "doi",
    });
  });

  test("an inconsistent snapshot pair raises and drops no row silently", () => {
    seedDataset("on000051");
    const insert = (tag: string | null, basis: string | null) =>
      db
        .prepare(INSERT_DATASET_VERSION_SQL)
        .run("on000051", "1.0.0", "10.82901/y", "ezid", tag, basis);
    for (const [tag, basis] of [
      ["2.0.2", null],
      ["2.0.2", "unknown"],
      [null, "doi"],
      ["2.0.2", "guess"],
    ] as const) {
      expect(() => insert(tag, basis)).toThrow(/CHECK constraint failed/);
    }
    expect(snapshotOf("on000051")).toBeNull();
  });

  test("the callback answers 500 and leaves the job dispatched when the row is refused", async () => {
    // Make the insert's CHECK refuse every row, as an inconsistent pair would.
    db.exec("DROP TABLE dataset_versions");
    db.exec(
      `CREATE TABLE dataset_versions (
         id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL, version TEXT NOT NULL,
         doi TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'ezid',
         source_version TEXT, source_version_basis TEXT CHECK (source_version_basis = 'never'),
         UNIQUE (dataset_id, version))`,
    );
    standin.describe("on000052", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000052.v1.0.0" }],
    });
    seedDataset("on000052");
    const token = await seedManifestJob("on000052", "1.0.0", "nonce-52");
    const { response } = manifestReady(token, "on000052", "1.0.0", env());
    expect((await response).status).toBe(500);
    expect(
      db.query("SELECT status FROM manifest_jobs WHERE dataset_id = 'on000052'").get(),
    ).toEqual({ status: "dispatched" });
  });
});

describe("columnsFromDescription (the inline sites)", () => {
  const withTag = {
    Name: "x",
    BIDSVersion: "1.9.0",
    SourceDatasets: [{ DOI: "10.18112/openneuro.ds000060.v3.1.0" }],
  };

  test("a description that was read gives its tag, or unknown when it names none", () => {
    expect(columnsFromDescription("on000060", withTag, [])).toEqual({
      source_version: "3.1.0",
      source_version_basis: "doi",
    });
    expect(columnsFromDescription("on000060", { Name: "x", BIDSVersion: "1.9.0" }, [])).toEqual({
      source_version: null,
      source_version_basis: "unknown",
    });
  });

  test("a failed read (the readRepoMetadata warning) is not examined, whatever it returned", () => {
    expect(
      columnsFromDescription("on000060", withTag, [
        "BIDS metadata unavailable: HTTP 502. DOI minted with minimal metadata.",
      ]),
    ).toEqual(NOT_EXAMINED);
  });

  test("the { Name } fallback of an absent file is not examined", () => {
    expect(columnsFromDescription("on000060", { Name: "fallback" }, [])).toEqual(NOT_EXAMINED);
    expect(columnsFromDescription("on000060", {}, [])).toEqual(NOT_EXAMINED);
  });

  test("a dataset that is not an on###### mirror is not examined", () => {
    expect(columnsFromDescription("nm000060", withTag, [])).toEqual(NOT_EXAMINED);
    expect(columnsFromDescription("xx000060", withTag, [])).toEqual(NOT_EXAMINED);
  });
});

describe("snapshotColumnsForInsert never throws", () => {
  test("a token that cannot be minted is NULL/NULL", async () => {
    const bindings = env({ GITHUB_ADMIN_PAT: undefined });
    console.warn = () => {};
    expect(await snapshotColumnsForInsert(bindings, "on000070", "1.0.0")).toEqual(NOT_EXAMINED);
  });
});

describe("every INSERT into dataset_versions is the one statement", () => {
  const INSERT_RE = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+dataset_versions\b/i;

  function offenders(tree = createTree()): string[] {
    const found: string[] = [];
    for (const file of tree.walk(SRC)) {
      if (file.endsWith("services/source-snapshot.ts")) continue;
      const sf = parse(tree, file);
      if (foldedStrings(sf).some((s) => INSERT_RE.test(s))) found.push(rel(file));
    }
    return found;
  }

  test("nothing in backend/src writes dataset_versions outside services/source-snapshot.ts", () => {
    expect(offenders()).toEqual([]);
  });

  test("the scan fires on a planted INSERT, including one split across a concatenation", () => {
    const planted = createTree({
      "services/planted.ts":
        'export const SQL = "INSERT INTO dataset_versions (dataset_id) VALUES (?)";',
      "services/planted-split.ts":
        'export const SQL = "INSERT INTO " + "dataset_versions (dataset_id) VALUES (?)";',
    });
    expect(offenders(planted).sort()).toEqual([
      expect.stringContaining("planted-split.ts"),
      expect.stringContaining("planted.ts"),
    ]);
  });

  test("each of the five sites binds the shared statement", () => {
    const sites = [
      "routes/callbacks/manifest.ts",
      "routes/admin/datasets-lifecycle.ts",
      "services/publication-orchestrator.ts",
      "routes/callbacks/version-doi.ts",
    ];
    for (const site of sites) {
      expect(readFileSync(join(SRC, site), "utf8")).toContain("INSERT_DATASET_VERSION_SQL");
    }
    // version-doi.ts holds two sites, the legacy EZID handler and the Zenodo handler.
    const versionDoi = readFileSync(join(SRC, "routes/callbacks/version-doi.ts"), "utf8");
    expect(versionDoi.match(/\.prepare\(INSERT_DATASET_VERSION_SQL\)/g)).toHaveLength(2);
  });
});
