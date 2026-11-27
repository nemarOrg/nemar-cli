/**
 * `GET /admin/datasets/:id/license-lineage` (epic #2182 card D1, ADR 0139 decision 7).
 *
 * The real admin router over an in-memory D1, a local GitHub contents stand-in holding the
 * dataset's files, and the registries' RECORDED responses (test/fixtures/license-lineage/). The
 * registry hosts are routed to that stand-in by origin; any other host is refused and noted, so a
 * test that passed by reaching the real network would fail here.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { DEFAULT_BASES, LINEAGE_COPY } from "../../shared/license-lineage";
import { type StandIn, startStandIn } from "../../test/fixtures/license-lineage/stand-in";
import { adminRoutes } from "../src/routes/admin";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  REVIEW_APP_BINDINGS,
  dropStandInAppToken,
  seedStandInAppToken,
} from "./helpers/github-rulesets";
import { seedUser } from "./helpers/publication-review";

const ADMIN_KEY = "lineage-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "lineage-member-key-0123456789abcdef0123456789abcd";
const TOKEN = "ghs_lineage_test";

/** The repository files the route reads, per repository, and whether reads should fail. */
const repoFiles = new Map<string, Record<string, string>>();
let githubFails = false;
const githubServer = Bun.serve({
  port: 0,
  fetch(req) {
    const m = /^\/repos\/nemarDatasets\/([^/]+)\/contents\/(.+)$/.exec(new URL(req.url).pathname);
    if (githubFails) return new Response("{}", { status: 500 });
    const content = m ? repoFiles.get(m[1])?.[decodeURIComponent(m[2])] : undefined;
    if (content === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ encoding: "base64", content: Buffer.from(content).toString("base64") });
  },
});

let registries: StandIn;
const refused: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://localhost:${githubServer.port}`;
  seedStandInAppToken(TOKEN);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    for (const [name, base] of Object.entries(DEFAULT_BASES)) {
      if (url.origin === new URL(base).origin) {
        const target = `${registries.bases[name as keyof typeof DEFAULT_BASES]}${url.pathname}${url.search}`;
        return realFetch(new Request(target, req));
      }
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return realFetch(req);
    refused.push(url.hostname);
    return Promise.reject(new Error(`this test file does not reach ${url.hostname}`));
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  dropStandInAppToken();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  githubServer.stop(true);
});

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

beforeEach(async () => {
  registries = startStandIn();
  refused.length = 0;
  repoFiles.clear();
  githubFails = false;
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  const owner = await seedUser(db, "lineage-admin", "admin", ADMIN_KEY);
  await seedUser(db, "lineage-member", "member", MEMBER_KEY);
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo, status, visibility, anonymous, attestation)
     VALUES ('nm000901', 'Lineage fixture', ?, 0, 'nemarDatasets/nm000901', 'active', 'private', 0, ?),
            ('nm000902', 'No repository', ?, 0, NULL, 'active', 'private', 0, NULL)`,
    [
      owner,
      JSON.stringify({ upstream_source: "Mirrored from https://zenodo.org/records/22967622" }),
      owner,
    ],
  );
});

afterEach(() => {
  registries.stop();
  expect(refused).toEqual([]);
});

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test", ...REVIEW_APP_BINDINGS } as Bindings;
}

async function get(path: string, key = ADMIN_KEY) {
  const res = await app.request(
    path,
    { headers: { Authorization: `Bearer ${key}`, "X-CLI-Version": "99.0.0" } },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /admin/datasets/:id/license-lineage", () => {
  test("reads description, enrichment, attestation and README, and combines them", async () => {
    repoFiles.set("nm000901", {
      "dataset_description.json": JSON.stringify({
        Name: "x",
        License: "CC-BY-NC-4.0",
        SourceDatasets: [{ DOI: "10.18112/openneuro.ds003645.v2.0.2" }],
      }),
      ".nemar/metadata.json": JSON.stringify({
        version: "2.0",
        related_identifiers: [
          {
            identifier: "10.5281/zenodo.24539621",
            identifier_type: "DOI",
            relation_type: "IsDerivedFrom",
          },
        ],
      }),
      "README.md": "Also from https://physionet.org/content/eegmmidb/1.0.0/",
    });
    const { status, body } = await get("/admin/datasets/nm000901/license-lineage");
    expect(status).toBe(200);
    expect(body.dataset_id).toBe("nm000901");
    expect(body.target_license).toBe("cc-by-nc");
    const sources = body.sources as Array<{ id: string; origin: string; resolver: string }>;
    expect(sources.map((s) => [s.origin, s.id, s.resolver])).toEqual([
      ["source_datasets", "10.18112/openneuro.ds003645.v2.0.2", "openneuro"],
      ["related_identifiers", "10.5281/zenodo.24539621", "datacite"],
      ["attestation", "10.5281/zenodo.22967622", "datacite"],
      ["readme", "10.13026/c28g6p", "physionet"],
    ]);
    // CC0 + CC BY + CC BY-NC (kept NC) + ODC-By: the NC source is the most restrictive.
    expect(body.outcome).toBe("compatible_nc");
    expect(registries.misses).toEqual([]);
  });

  test("resolves an osf.io source through OSF, asks a failed DataCite again, records resolved_at", async () => {
    // ADR 0142 decision 3: nm000712's source shape, and a transient DataCite failure.
    repoFiles.set("nm000901", {
      "dataset_description.json": JSON.stringify({
        License: "CC-BY-SA-4.0",
        SourceDatasets: [{ URL: "https://osf.io/rmafj/" }],
      }),
    });
    db.run("UPDATE datasets SET attestation = NULL WHERE dataset_id = 'nm000901'");
    registries.override("datacite /dois/10.17605/osf.io/rmafj", { status: 503, times: 1 });
    const before = Date.now();
    const { status, body } = await get("/admin/datasets/nm000901/license-lineage");
    expect(status).toBe(200);
    expect(body.outcome).toBe("compatible_attribution");
    const sources = body.sources as Array<Record<string, unknown>>;
    expect(sources[0]).toMatchObject({ id: "10.17605/osf.io/rmafj", resolver: "osf" });
    expect(Date.parse(body.resolved_at as string)).toBeGreaterThanOrEqual(before - 1000);
    expect(registries.requests.filter((k) => k.includes("datacite"))).toHaveLength(2);
    expect(registries.misses).toEqual([]);
  });

  test("a dataset with no source and no README: no_upstream_declared", async () => {
    repoFiles.set("nm000901", { "dataset_description.json": JSON.stringify({ License: "CC0" }) });
    db.run("UPDATE datasets SET attestation = NULL WHERE dataset_id = 'nm000901'");
    const { status, body } = await get("/admin/datasets/nm000901/license-lineage");
    expect(status).toBe(200);
    expect(body.outcome).toBe("no_upstream_declared");
    expect(LINEAGE_COPY[body.outcome as "no_upstream_declared"]).toBeDefined();
  });

  test("a missing description is 200 unresolved; an unparseable file is 422 naming it", async () => {
    repoFiles.set("nm000901", {});
    const missing = await get("/admin/datasets/nm000901/license-lineage");
    expect(missing.status).toBe(200);
    expect(missing.body.outcome).toBe("unresolved");
    expect((missing.body.inputs as Record<string, string>).dataset_description).toBe("missing");

    repoFiles.set("nm000901", { "dataset_description.json": "{ broken" });
    const broken = await get("/admin/datasets/nm000901/license-lineage");
    expect(broken.status).toBe(422);
    expect((broken.body.sources as Array<{ id: string }>)[0].id).toBe("dataset_description.json");

    repoFiles.set("nm000901", {
      "dataset_description.json": JSON.stringify({ License: "CC0" }),
      ".nemar/metadata.json": "not json",
    });
    const badMeta = await get("/admin/datasets/nm000901/license-lineage");
    expect(badMeta.status).toBe(422);
    expect((badMeta.body.inputs as Record<string, string>).nemar_metadata).toBe("unparseable");
  });

  test("a repository read failure is a 502, never a lineage from missing inputs", async () => {
    githubFails = true;
    const { status } = await get("/admin/datasets/nm000901/license-lineage");
    expect(status).toBe(502);
  });

  test("400 malformed id, 404 unknown dataset, 409 no repository, 403 a non-admin", async () => {
    expect((await get("/admin/datasets/nope/license-lineage")).status).toBe(400);
    expect((await get("/admin/datasets/nm000999/license-lineage")).status).toBe(404);
    expect((await get("/admin/datasets/nm000902/license-lineage")).status).toBe(409);
    expect((await get("/admin/datasets/nm000901/license-lineage", MEMBER_KEY)).status).toBe(403);
  });
});
