/**
 * Real `POST /admin/imports/coverage-sweep` route tests (epic #1306 phase 3, #1311).
 *
 * Modelled on `import-issue-triage-route.test.ts`: real bun:sqlite behind realD1,
 * the real `authMiddleware`/`adminMiddleware` stack with seeded hashed tokens, and
 * real Hono dispatch via `app.request()`.
 *
 * The decision this file exists for is the status code. An `alarm` is a
 * SUCCESSFUL run -- the sweep looked and reported the truth -- so it is 200. An
 * `unknown` is not, and answering 200 for it would tell a health check that
 * coverage is fine when in fact nothing could be read. That one confusion is the
 * failure mode the whole phase was written against, so it is pinned here rather
 * than left to the service tests, which cannot see a status code.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerImportCoverageRoutes } from "../src/routes/admin/import-coverage";
import type {
  ImportCoverageSweepResult,
  runImportCoverageSweep,
} from "../src/services/import-coverage-sweep";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "icv-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "icv-member-key-0123456789abcdef0123456789abcdef0";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

let db: Database;

function result(over: Partial<ImportCoverageSweepResult> = {}): ImportCoverageSweepResult {
  return {
    applied: false,
    status: "healthy",
    kind: null,
    reason: "nothing accruing",
    enabled: true,
    lastDispatchAt: "2026-09-09 10:00:00",
    dispatchAgeHours: 2,
    discovered: 764,
    backlog: { neverAttempted: [], failedTracked: [], blocklisted: [] },
    issue: null,
    errors: [],
    ...over,
  };
}

function newApp(
  fn: (
    ...args: Parameters<typeof runImportCoverageSweep>
  ) => Promise<ImportCoverageSweepResult> | ImportCoverageSweepResult,
): { app: App; calls: { apply?: boolean }[] } {
  const calls: { apply?: boolean }[] = [];
  const app: App = new Hono();
  app.use("*", authMiddleware);
  app.use("*", adminMiddleware);
  registerImportCoverageRoutes(app, {
    sweep: async (env, opts = {}, deps = {}) => {
      calls.push({ apply: opts.apply });
      return fn(env, opts, deps);
    },
  });
  return { app, calls };
}

async function seedUsers(database: Database): Promise<void> {
  database.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('icvadmin', 'icvadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const admin = database
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='icvadmin'")
    .get();
  if (!admin) throw new Error("seed: admin insert failed");
  database
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(admin.id, await hashApiKey(ADMIN_KEY), ADMIN_KEY.slice(0, 8));

  database.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('icvmember', 'icvmember@example.org', 'x', 'approved', 'member', 1)`,
  );
  const member = database
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='icvmember'")
    .get();
  if (!member) throw new Error("seed: member insert failed");
  database
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(member.id, await hashApiKey(MEMBER_KEY), MEMBER_KEY.slice(0, 8));
}

function env(environment = "production"): Bindings {
  return { DB: realD1(db), ENVIRONMENT: environment } as Bindings;
}

function post(app: App, path: string, key = ADMIN_KEY, environment?: string): Promise<Response> {
  return app.request(
    `http://local${path}`,
    { method: "POST", headers: { Authorization: `Bearer ${key}` } },
    env(environment),
  );
}

function auditRows(): { action: string; resource_id: string | null; details: string | null }[] {
  return db
    .query<{ action: string; resource_id: string | null; details: string | null }, []>(
      "SELECT action, resource_id, details FROM audit_log ORDER BY id",
    )
    .all();
}

beforeEach(async () => {
  db = freshDb();
  await seedUsers(db);
});

describe("auth", () => {
  test("a non-admin cannot run it", async () => {
    const { app, calls } = newApp(() => result());
    const res = await post(app, "/imports/coverage-sweep", MEMBER_KEY);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("the verdict decides the status code", () => {
  test("healthy is 200", async () => {
    const { app } = newApp(() => result());
    const res = await post(app, "/imports/coverage-sweep");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "healthy" });
  });

  /** An alarm means the sweep worked. Answering non-2xx would make a monitoring
   *  caller unable to distinguish "the pipeline is broken" from "the check is". */
  test("alarm is 200 -- the sweep ran and reported the truth", async () => {
    const { app } = newApp(() =>
      result({
        status: "alarm",
        kind: "silence",
        reason: "5 never attempted and no dispatch for 60 hours",
        backlog: { neverAttempted: ["ds000001"], failedTracked: [], blocklisted: [] },
      }),
    );
    const res = await post(app, "/imports/coverage-sweep");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "alarm", kind: "silence" });
  });

  test("unknown is 502, carrying the stage that failed", async () => {
    const { app } = newApp(() =>
      result({
        status: "unknown",
        reason: "OpenNeuro discovery failed, so coverage could not be determined this run.",
        errors: [{ stage: "discovery", error: "GraphQL 502" }],
      }),
    );
    const res = await post(app, "/imports/coverage-sweep");
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      details: { errors: { stage: string }[] };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("could not be determined");
    // Under `details` so the CLI's ApiError keeps the cause: an operator has to be
    // able to tell an OpenNeuro outage from a D1 one.
    expect(body.details.errors[0]?.stage).toBe("discovery");
  });

  test("a report-stage error does not make the verdict unknown", async () => {
    // The verdict is a read and it succeeded; only the GitHub write failed.
    const { app } = newApp(() =>
      result({
        status: "alarm",
        kind: "backlog",
        errors: [{ stage: "report", error: "HTTP 403" }],
      }),
    );
    const res = await post(app, "/imports/coverage-sweep");
    expect(res.status).toBe(200);
  });
});

describe("dry run is the default", () => {
  test("a bare POST does not apply", async () => {
    const { app, calls } = newApp(() => result());
    await post(app, "/imports/coverage-sweep");
    expect(calls[0]?.apply).toBe(false);
  });

  test("only apply=1 and apply=true count as an apply", async () => {
    for (const [query, expected] of [
      ["?apply=1", true],
      ["?apply=true", true],
      ["?apply=yes", false],
      ["?apply=0", false],
      ["?apply=", false],
    ] as const) {
      const { app, calls } = newApp(() => result({ applied: expected }));
      await post(app, `/imports/coverage-sweep${query}`);
      expect(calls[0]?.apply).toBe(expected);
    }
  });
});

describe("apply is production-only", () => {
  for (const environment of ["development", "staging", "test"]) {
    test(`${environment} refuses apply without running the sweep`, async () => {
      const { app, calls } = newApp(() => result({ applied: true }));
      const res = await post(app, "/imports/coverage-sweep?apply=1", ADMIN_KEY, environment);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining("production-only"),
      });
      expect(calls).toEqual([]);
    });

    test(`${environment} still allows the dry run`, async () => {
      const { app, calls } = newApp(() => result());
      const res = await post(app, "/imports/coverage-sweep", ADMIN_KEY, environment);
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
    });
  }

  test("production applies", async () => {
    const { app, calls } = newApp(() => result({ applied: true }));
    const res = await post(app, "/imports/coverage-sweep?apply=1");
    expect(res.status).toBe(200);
    expect(calls[0]?.apply).toBe(true);
  });
});

describe("the audit row", () => {
  test("an applied run that changed the issue writes one row", async () => {
    const { app } = newApp(() =>
      result({
        applied: true,
        status: "alarm",
        kind: "disabled",
        issue: { number: 900, action: "created" },
        backlog: { neverAttempted: ["ds000001"], failedTracked: [], blocklisted: [] },
      }),
    );
    const res = await post(app, "/imports/coverage-sweep?apply=1");
    expect(res.status).toBe(200);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("import_coverage_sweep");
    expect(rows[0]?.resource_id).toBe("#900");
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({
      status: "alarm",
      kind: "disabled",
      issue_action: "created",
      never_attempted: 1,
      enabled: true,
    });
  });

  test("a dry run is a read: no audit row", async () => {
    const { app } = newApp(() =>
      result({ status: "alarm", kind: "silence", issue: { number: 900, action: "created" } }),
    );
    await post(app, "/imports/coverage-sweep");
    expect(auditRows()).toEqual([]);
  });

  test("an applied run that touched no issue writes no row", async () => {
    const { app } = newApp(() => result({ applied: true }));
    await post(app, "/imports/coverage-sweep?apply=1");
    expect(auditRows()).toEqual([]);
  });

  /** The audit write is outside the sweep's try for the same reason as in phase 2:
   *  it runs after a real issue has been filed or closed, so turning its failure
   *  into a 500 would report "nothing happened" when something did. */
  test("an audit failure does not discard a run that already changed the issue", async () => {
    const { app } = newApp(() =>
      result({
        applied: true,
        status: "alarm",
        kind: "silence",
        issue: { number: 900, action: "created" },
      }),
    );
    db.run("DROP TABLE audit_log");

    const res = await post(app, "/imports/coverage-sweep?apply=1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; audit_failed?: string };
    expect(body.ok).toBe(true);
    expect(body.audit_failed).toBeTruthy();
  });
});

describe("a sweep that throws", () => {
  test("answers 500, because the sweep is written not to throw", async () => {
    const { app } = newApp(() => {
      throw new Error("env.DB is undefined");
    });
    const res = await post(app, "/imports/coverage-sweep");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("env.DB is undefined"),
    });
  });
});
