/**
 * Exemplar admin-endpoint tests (epic #923, Phase 5 / #928).
 *
 * Real engine: bun:sqlite behind realD1, the real auth/admin middleware (seeded
 * users/tokens, real SHA-256 key hashing), and the real route via Hono
 * app.request(). Covers the gated/validation/rollback-decision paths that return
 * BEFORE any GitHub/EZID call (403-in-prod, 409-duplicate, zod reject, remint
 * gates). The happy path's repo-create + INSERT is driven once per kind of
 * exemplar against a GitHub stand-in (NEMAR_GITHUB_API_URL) for what the row
 * records; end to end it is validated by the CLI clone tool.
 *
 * No mocks (no-mocks policy, .rules/testing.md): the stand-in is a loopback
 * server that the route's own GitHub client calls, standing in for GitHub only,
 * as backend/test/helpers/repull-github-standin.ts does. No NEMAR code is
 * replaced: every assertion is on the route's answer, the row, the audit log
 * or the request the route sent.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { EXEMPLAR_ID_RE, exemplarSource } from "../src/routes/admin/exemplar";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "exemplar-admin-key-0123456789abcdef0123456789abcdef";
const EXEMPLAR = "xx099900";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('exadmin', 'exadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='exadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function env(environment: string): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: environment,
    GITHUB_ADMIN_PAT: "test-pat-never-used-on-these-paths",
  } as Bindings;
}

function post(path: string, body: unknown, environment: string): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(environment),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("EXEMPLAR_ID_RE", () => {
  test("accepts the xx099900-xx099999 band only", () => {
    expect(EXEMPLAR_ID_RE.test("xx099900")).toBe(true);
    expect(EXEMPLAR_ID_RE.test("xx099999")).toBe(true);
    expect(EXEMPLAR_ID_RE.test("xx09900")).toBe(false); // 7 chars (draft regex bug)
    expect(EXEMPLAR_ID_RE.test("xx090000")).toBe(false); // dev ephemeral band, not exemplar
    expect(EXEMPLAR_ID_RE.test("nm000132")).toBe(false);
    expect(EXEMPLAR_ID_RE.test("xx099900x")).toBe(false);
  });
});

describe("POST /admin/datasets/exemplar", () => {
  const body = { dataset_id: EXEMPLAR, source_id: "nm000132" };

  test("403 in production (staging-only fleet)", async () => {
    const res = await post("/admin/datasets/exemplar", body, "production");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Exemplar creation is disabled in production");
  });

  test("fail-closed: unknown ENVIRONMENT is treated as production -> 403", async () => {
    const res = await post("/admin/datasets/exemplar", body, "");
    expect(res.status).toBe(403);
  });

  test("409 when the dataset already exists (before any GitHub call)", async () => {
    db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES (?, 'existing', 100)",
    ).run(EXEMPLAR);
    const res = await post("/admin/datasets/exemplar", body, "development");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(`Dataset ${EXEMPLAR} already exists`);
  });

  test("400 on an out-of-band dataset_id", async () => {
    const res = await post(
      "/admin/datasets/exemplar",
      { dataset_id: "xx090001", source_id: "nm000132" },
      "development",
    );
    expect(res.status).toBe(400);
  });

  test("400 on anonymous: false (#1407)", async () => {
    // The flag has two states, not three: absent means "not anonymous". An
    // explicit `false` would be a caller trying to say something the column
    // cannot express, and accepting it invites "was anonymous, is not any
    // more" to be read into a row where it is simply untrue.
    const res = await post(
      "/admin/datasets/exemplar",
      { dataset_id: EXEMPLAR, source_id: "nm000132", anonymous: false },
      "development",
    );
    expect(res.status).toBe(400);
  });

  test("400 on anonymous: true, refused by name and before anything is created (#1434)", async () => {
    // The field is still DECLARED, so the schema accepts it and the refusal has
    // to come from the route. Asserting the error code rather than the status
    // is what separates this from the `anonymous: false` case above, which is
    // rejected by zod: both are 400, and only one of them proves the retirement
    // check ran.
    const res = await post(
      "/admin/datasets/exemplar",
      { dataset_id: EXEMPLAR, source_id: "nm000132", anonymous: true },
      "development",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "exemplar_anonymous_retired" });
    // Refused before the GitHub call and before the INSERT, so there is nothing
    // to roll back. A row here would mean the check moved below the create.
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM datasets").get();
    expect(row?.n).toBe(0);
  });

  test("400 on a malformed source_id", async () => {
    const res = await post(
      "/admin/datasets/exemplar",
      { dataset_id: EXEMPLAR, source_id: "not-a-dataset" },
      "development",
    );
    expect(res.status).toBe(400);
  });
});

describe("a mirror rehearsal fixture (mirror, ADR 0111)", () => {
  const mirrorBody = { dataset_id: EXEMPLAR, source_id: "on004362", mirror: "ds004362" };
  const rows = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM datasets").get()?.n;

  test("records what a re-pull reads: source openneuro and the ds the on source mirrors", () => {
    expect(exemplarSource({ source_id: "on004362", mirror: "ds004362" })).toEqual({
      source: "openneuro",
      source_id: "ds004362",
    });
    // An ordinary exemplar is unchanged.
    expect(exemplarSource({ source_id: "nm000132" })).toEqual({
      source: "nemar-exemplar",
      source_id: "nm000132",
    });
  });

  test("a pair that is not an on dataset and the ds it mirrors is refused", () => {
    for (const pair of [
      { source_id: "on004362", mirror: "ds003645" },
      { source_id: "nm000132", mirror: "ds000132" },
      { source_id: "on004362", mirror: "on004362" },
    ]) {
      expect([pair, exemplarSource(pair)]).toEqual([pair, null]);
    }
  });

  test("403 in production, mirror or not, before anything is created", async () => {
    for (const environment of ["production", ""]) {
      const res = await post("/admin/datasets/exemplar", mirrorBody, environment);
      expect(res.status).toBe(403);
    }
    expect(rows()).toBe(0);
  });

  test("an anonymous mirror fixture is refused as every anonymous exemplar is", async () => {
    const res = await post(
      "/admin/datasets/exemplar",
      { ...mirrorBody, anonymous: true },
      "development",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "exemplar_anonymous_retired" });
    expect(rows()).toBe(0);
  });

  test("a mismatched pair is refused before any GitHub call or row", async () => {
    const res = await post(
      "/admin/datasets/exemplar",
      { ...mirrorBody, mirror: "ds003645" },
      "development",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "exemplar_mirror_mismatch" });
    expect(rows()).toBe(0);
  });

  /** A GitHub stand-in that creates the repository, set as the Worker's API for the call. */
  async function withGitHub(fn: (created: string[]) => Promise<void>): Promise<void> {
    const created: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        if (req.method === "POST" && pathname === "/orgs/nemarDatasets/repos") {
          const { name } = (await req.json()) as { name: string };
          created.push(name);
          return Response.json(
            {
              id: 1,
              name,
              full_name: `nemarDatasets/${name}`,
              html_url: `https://github.com/nemarDatasets/${name}`,
              clone_url: `https://github.com/nemarDatasets/${name}.git`,
              ssh_url: `git@github.com:nemarDatasets/${name}.git`,
            },
            { status: 201 },
          );
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      },
    });
    const g = globalThis as { NEMAR_GITHUB_API_URL?: string };
    g.NEMAR_GITHUB_API_URL = `http://127.0.0.1:${server.port}`;
    try {
      await fn(created);
    } finally {
      Reflect.deleteProperty(g, "NEMAR_GITHUB_API_URL");
      server.stop(true);
    }
  }

  const recordedRow = () =>
    db
      .query<{ source: string; source_id: string; is_exemplar: number }, []>(
        "SELECT source, source_id, is_exemplar FROM datasets",
      )
      .get();

  test("a mirror fixture's row records source openneuro and the ds; the answer names the clone source", async () => {
    await withGitHub(async (created) => {
      const res = await post("/admin/datasets/exemplar", mirrorBody, "development");
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        source: "openneuro",
        source_id: "ds004362",
        cloned_from: "on004362",
      });
      expect(created).toEqual([EXEMPLAR]);
    });
    expect(recordedRow()).toEqual({ source: "openneuro", source_id: "ds004362", is_exemplar: 1 });
    const audit = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'exemplar_created'",
      )
      .get();
    expect(JSON.parse(audit?.details ?? "{}")).toMatchObject({
      source_id: "on004362",
      mirror: "ds004362",
    });
  });

  test("an ordinary exemplar's row records nemar-exemplar and the id it was cloned from", async () => {
    await withGitHub(async () => {
      const res = await post(
        "/admin/datasets/exemplar",
        { dataset_id: EXEMPLAR, source_id: "nm000132" },
        "development",
      );
      expect(res.status).toBe(201);
    });
    expect(recordedRow()).toEqual({
      source: "nemar-exemplar",
      source_id: "nm000132",
      is_exemplar: 1,
    });
  });

  test("a mirror that is not an OpenNeuro id is refused by the schema", async () => {
    const res = await post(
      "/admin/datasets/exemplar",
      { ...mirrorBody, mirror: "004362" },
      "development",
    );
    expect(res.status).toBe(400);
    expect(rows()).toBe(0);
  });
});

describe("POST /admin/datasets/:id/exemplar/remint-dois", () => {
  test("403 in production", async () => {
    const res = await post(`/admin/datasets/${EXEMPLAR}/exemplar/remint-dois`, {}, "production");
    expect(res.status).toBe(403);
  });

  test("400 on a non-exemplar id", async () => {
    const res = await post("/admin/datasets/nm000132/exemplar/remint-dois", {}, "development");
    expect(res.status).toBe(400);
  });

  test("404 when the dataset does not exist", async () => {
    const res = await post(`/admin/datasets/${EXEMPLAR}/exemplar/remint-dois`, {}, "development");
    expect(res.status).toBe(404);
  });

  test("400 when the row exists but is not an exemplar", async () => {
    // owner must resolve (the handler JOINs users), so use the seeded admin id.
    const adminId = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='exadmin'")
      .get();
    db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, is_exemplar) VALUES (?, 'x', ?, 0)",
    ).run(EXEMPLAR, adminId?.id ?? 1);
    const res = await post(`/admin/datasets/${EXEMPLAR}/exemplar/remint-dois`, {}, "development");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Not an exemplar dataset");
  });
});
