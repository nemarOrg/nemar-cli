/**
 * What actually reaches EZID from the three DOI paths that were untested
 * (#1255 review item 13): the concept metadata refresh, its per-version loop,
 * and the exemplar re-mint.
 *
 * These are the paths that rebuild a DataCite document from live database
 * state. They are the ones where a username could leak into a permanent
 * record, and -- since #1255 -- the ones where a nameless owner could strip
 * an existing DataCurator off a record that already has one. Nothing below
 * asserts on an intermediate helper: each test drives the real Hono route and
 * inspects the bytes the Worker PUT to EZID.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration, the
 * real admin router with real auth middleware and hashed tokens, and two
 * local `Bun.serve()` upstreams standing in for GitHub (via the existing
 * NEMAR_GITHUB_API_URL override) and EZID (via NEMAR_EZID_API_URL, added for
 * this). Both speak the real wire formats -- GitHub's git/trees + blobs JSON,
 * EZID's ANVL -- so the production request/parse path runs end to end.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "attrib-admin-key-0123456789abcdef0123456789abc";
const OWNER_USERNAME = "zqxcurator9";
const DATASET_ID = "nm000282";
const EXEMPLAR_ID = "xx099901";
const ORCID = "0000-0002-1825-0097";

/** Every ANVL body the Worker PUT/POSTed to EZID, newest last. */
let ezidWrites: { path: string; body: string }[] = [];
let servers: ReturnType<typeof Bun.serve>[] = [];
let ghBase: string;
let ezidBase: string;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

const BIDS = JSON.stringify({
  Name: "A dataset with a long enough descriptive name",
  Authors: ["Smith, John"],
  License: "CC0",
});

/** The DataCite XML from the most recent EZID write, or null. */
function lastDataciteXml(): string | null {
  const last = ezidWrites.at(-1);
  if (!last) return null;
  // ANVL escapes newlines as %0A within a value; decode enough to read it.
  const line = last.body.split("\n").find((l) => l.startsWith("datacite:"));
  return line ? decodeURIComponent(line.slice("datacite:".length).trim()) : null;
}

beforeAll(() => {
  const gh = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      // getTreeAtRef resolves the ref to a commit first.
      if (url.pathname.includes("/commits/main")) {
        return Response.json({ sha: "commitsha", commit: { tree: { sha: "treesha" } } });
      }
      // Tree listing for the dataset repo.
      if (url.pathname.includes("/git/trees/")) {
        return Response.json({
          tree: [{ path: "dataset_description.json", sha: "descsha", type: "blob" }],
        });
      }
      // Blob content, base64 like the real API.
      if (url.pathname.includes("/git/blobs/descsha")) {
        return Response.json({ content: btoa(BIDS), encoding: "base64" });
      }
      if (url.pathname.endsWith("/contents/dataset_description.json")) {
        return Response.json({ content: btoa(BIDS), encoding: "base64" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const ezid = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? "" : await req.text();
      if (req.method !== "GET") ezidWrites.push({ path: url.pathname, body });
      const id = decodeURIComponent(url.pathname.replace(/^\/id\//, ""));
      // ANVL: a status line, then the record's fields.
      return new Response(
        `success: ${id}\n_status: reserved\n_target: https://nemar.org/dataset/${DATASET_ID}\n_profile: datacite\n_created: 1700000000\n_updated: 1700000000\n`,
        { status: 200, headers: { "Content-Type": "text/plain" } },
      );
    },
  });
  servers = [gh, ezid];
  ghBase = `http://localhost:${gh.port}`;
  ezidBase = `http://localhost:${ezid.port}`;
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = ghBase;
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL = ezidBase;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL = undefined;
  for (const s of servers) s.stop(true);
});

async function seedAdmin() {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES ('attribadmin', 'attribadmin@example.org', 'x', 'approved', 'admin', 1, 'Root', 'Admin')`,
  ).run();
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='attribadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function seedOwner(given: string | null, family: string | null) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, orcid)
     VALUES (?, ?, 'x', 'approved', 'member', 1, ?, ?, ?)`,
  ).run(OWNER_USERNAME, `${OWNER_USERNAME}@example.org`, given, family, ORCID);
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(OWNER_USERNAME);
  if (!u) throw new Error("seed: owner insert failed");
  ownerId = u.id;
}

function seedDataset(
  id: string,
  opts: { conceptDoi?: string | null; isExemplar?: number; isSandbox?: number } = {},
) {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox, visibility,
                           status, concept_doi, is_exemplar, ezid_status)
     VALUES (?, 'Attribution Fixture Dataset', ?, ?, ?, 'public', 'active', ?, ?, 'reserved')`,
  ).run(
    id,
    ownerId,
    `nemarDatasets/${id}`,
    opts.isSandbox ?? 0,
    opts.conceptDoi ?? null,
    opts.isExemplar ?? 0,
  );
}

function seedVersion(id: string, version: string, doi: string) {
  db.query(
    "INSERT INTO dataset_versions (dataset_id, version, doi, created_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(id, version, doi);
}

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "test-pat",
    EZID_USERNAME: "ezid-user",
    EZID_PASSWORD: "ezid-pass",
    EZID_SANDBOX_USERNAME: "ezid-sandbox-user",
    EZID_SANDBOX_PASSWORD: "ezid-sandbox-pass",
    FRONTEND_URL: "https://nemar.org",
  } as Bindings;
}

function post(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  ezidWrites = [];
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/datasets/:id/doi/update (metadata refresh)", () => {
  test("a named owner is cited by real name, and the username never ships", async () => {
    seedOwner("Jane", "Doe");
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282" });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/update`, {
      refresh_metadata: true,
    });
    expect(res.status).toBe(200);

    const xml = lastDataciteXml();
    expect(xml).toContain("DataCurator");
    expect(xml).toContain("Doe, Jane");
    expect(xml).toContain("<givenName>Jane</givenName>");
    expect(xml).toContain(ORCID);
    expect(xml).not.toContain(OWNER_USERNAME);
  });

  test("a nameless owner SKIPS the refresh instead of stripping the curator", async () => {
    // The regression this test exists for: rebuilding from a nameless owner
    // produces a record with no DataCurator, and pushing it deletes the
    // curator from a permanent DOI.
    seedOwner(null, null);
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282" });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/update`, {
      refresh_metadata: true,
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      metadata_refresh: { status: string; reason: string };
    };
    expect(body.metadata_refresh).toEqual({
      status: "skipped",
      reason: "owner_name_missing",
    });
    // Nothing was sent to EZID at all.
    expect(ezidWrites).toHaveLength(0);
  });

  test("the per-version loop is skipped too, so version DOIs keep their curator", async () => {
    seedOwner(null, null);
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282" });
    seedVersion(DATASET_ID, "1.0.0", "10.82901/NEMAR.NM000282.V1.0.0");
    seedVersion(DATASET_ID, "1.1.0", "10.82901/NEMAR.NM000282.V1.1.0");

    await post(`/admin/datasets/${DATASET_ID}/doi/update`, { refresh_metadata: true });

    expect(ezidWrites).toHaveLength(0);
  });

  test("a status-only change still proceeds, and reports the skipped refresh", async () => {
    seedOwner(null, null);
    seedDataset(DATASET_ID, { conceptDoi: "10.82901/NEMAR.NM000282" });

    const res = await post(`/admin/datasets/${DATASET_ID}/doi/update`, {
      refresh_metadata: true,
      status: "public",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata_refreshed: boolean;
      metadata_refresh?: { status: string; reason: string };
    };
    expect(body.metadata_refreshed).toBe(false);
    expect(body.metadata_refresh?.reason).toBe("owner_name_missing");
    // The status write happened; no `datacite` payload rode along with it.
    expect(ezidWrites.length).toBeGreaterThan(0);
    expect(ezidWrites.every((w) => !w.body.includes("datacite:"))).toBe(true);
  });
});

describe("POST /admin/datasets/:id/exemplar/remint-dois", () => {
  test("a named owner is cited by real name, never by username", async () => {
    seedOwner("Jane", "Doe");
    seedDataset(EXEMPLAR_ID, { isExemplar: 1, isSandbox: 1 });

    const res = await post(`/admin/datasets/${EXEMPLAR_ID}/exemplar/remint-dois`, {});
    expect(res.status).toBe(200);

    const xml = lastDataciteXml();
    expect(xml).toContain("DataCurator");
    expect(xml).toContain("Doe, Jane");
    expect(xml).not.toContain(OWNER_USERNAME);
  });

  test("a nameless owner mints with NO DataCurator and no username", async () => {
    // Exemplars are exempt from the block (their owner is a service account
    // on the sandbox shoulder), so this must still mint -- unattributed
    // rather than attributed to a login handle.
    seedOwner(null, null);
    seedDataset(EXEMPLAR_ID, { isExemplar: 1, isSandbox: 1 });

    const res = await post(`/admin/datasets/${EXEMPLAR_ID}/exemplar/remint-dois`, {});
    expect(res.status).toBe(200);

    const xml = lastDataciteXml();
    expect(xml).not.toBeNull();
    expect(xml).not.toContain("DataCurator");
    expect(xml).not.toContain(OWNER_USERNAME);
    // The rest of the record is intact.
    expect(xml).toContain("HostingInstitution");
  });
});
