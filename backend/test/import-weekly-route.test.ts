/**
 * Real `POST /admin/imports/weekly-summary` route tests (epic #1306 phase 4, #1312).
 *
 * Modelled on its two siblings under `/admin/imports/`: real bun:sqlite behind
 * realD1, the real auth/admin middleware with seeded hashed tokens, real Hono
 * dispatch.
 *
 * Two route-only decisions justify this file:
 *
 *   1. A dry run FORCES past the once-per-week gate. An operator asking to read the
 *      report should not be told to wait until Monday, and a dry run files nothing.
 *      An apply is still gated, so the once-per-week guarantee is untouched.
 *   2. A report containing unknowns is a 200. Those are the parts that came back
 *      unknown, which the body states as unknown rather than as zero -- that is the
 *      phase's contract, so degrading it to an error would defeat it.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerImportWeeklyRoutes } from "../src/routes/admin/import-weekly";
import type {
  WeeklySummaryResult,
  runWeeklyImportSummary,
} from "../src/services/import-weekly-summary-sweep";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "iwk-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "iwk-member-key-0123456789abcdef0123456789abcdef0";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

let db: Database;

function result(over: Partial<WeeklySummaryResult> = {}): WeeklySummaryResult {
  return {
    applied: false,
    posted: false,
    gateReason: "forced",
    facts: {
      week: "2026-W37",
      windowStart: "2026-09-02T03:00:00.000Z",
      windowEnd: "2026-09-09T03:00:00.000Z",
      importedThisWeek: 9,
      importedTotal: 764,
      coverageStatus: "healthy",
      coverageReason: "nothing outstanding",
      outstanding: 0,
      discovered: 766,
      importedNotInScan: 4,
      autoImportEnabled: true,
      dispatchPhrase: "2 hours ago",
      dispatchLost: false,
      failuresByCause: {},
      openFailureTotal: 0,
      parked: [],
      issuesClosed: 0,
      issuesRelabelled: 0,
      errors: [],
    },
    issue: null,
    closedPrevious: null,
    renderedBody: "# Import summary, 2026-W37",
    ...over,
  };
}

function newApp(
  fn: (
    ...args: Parameters<typeof runWeeklyImportSummary>
  ) => Promise<WeeklySummaryResult> | WeeklySummaryResult,
): { app: App; calls: { apply?: boolean; force?: boolean }[] } {
  const calls: { apply?: boolean; force?: boolean }[] = [];
  const app: App = new Hono();
  app.use("*", authMiddleware);
  app.use("*", adminMiddleware);
  registerImportWeeklyRoutes(app, {
    summary: async (env, opts = {}, deps = {}) => {
      calls.push({ apply: opts.apply, force: opts.force });
      return fn(env, opts, deps);
    },
  });
  return { app, calls };
}

async function seedUsers(database: Database): Promise<void> {
  database.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('iwkadmin', 'iwkadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const admin = database
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='iwkadmin'")
    .get();
  if (!admin) throw new Error("seed: admin insert failed");
  database
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(admin.id, await hashApiKey(ADMIN_KEY), ADMIN_KEY.slice(0, 8));

  database.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('iwkmember', 'iwkmember@example.org', 'x', 'approved', 'member', 1)`,
  );
  const member = database
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='iwkmember'")
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

beforeEach(async () => {
  db = freshDb();
  await seedUsers(db);
});

describe("auth", () => {
  test("a non-admin cannot read it", async () => {
    const { app, calls } = newApp(() => result());
    const res = await post(app, "/imports/weekly-summary", MEMBER_KEY);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("dry run is the default, and it forces past the weekly gate", () => {
  test("a bare POST does not apply, and does force", async () => {
    const { app, calls } = newApp(() => result());
    const res = await post(app, "/imports/weekly-summary");
    expect(res.status).toBe(200);
    expect(calls[0]?.apply).toBe(false);
    // Forced: an operator asking to READ the report should not be made to wait for
    // Monday, and a dry run files nothing.
    expect(calls[0]?.force).toBe(true);
  });

  test("an apply is NOT forced, so the once-per-week guarantee holds", async () => {
    const { app, calls } = newApp(() => result({ applied: true, posted: true }));
    await post(app, "/imports/weekly-summary?apply=1");
    expect(calls[0]?.apply).toBe(true);
    expect(calls[0]?.force).toBe(false);
  });

  test("only apply=1 and apply=true count as an apply", async () => {
    for (const [query, expected] of [
      ["?apply=1", true],
      ["?apply=true", true],
      ["?apply=yes", false],
      ["?apply=0", false],
      ["?apply=", false],
    ] as const) {
      const { app, calls } = newApp(() => result());
      await post(app, `/imports/weekly-summary${query}`);
      expect(calls[0]?.apply).toBe(expected);
    }
  });

  test("the rendered body comes back, so a dry run is reviewable", async () => {
    const { app } = newApp(() =>
      result({ renderedBody: "# Import summary, 2026-W37\ncc @nemarAdmin" }),
    );
    const res = await post(app, "/imports/weekly-summary");
    const body = (await res.json()) as { renderedBody: string };
    expect(body.renderedBody).toContain("@nemarAdmin");
  });
});

describe("apply is production-only", () => {
  for (const environment of ["development", "staging", "test"]) {
    test(`${environment} refuses apply without running`, async () => {
      const { app, calls } = newApp(() => result({ applied: true }));
      const res = await post(app, "/imports/weekly-summary?apply=1", ADMIN_KEY, environment);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining("production-only"),
      });
      expect(calls).toEqual([]);
    });

    test(`${environment} still allows the dry run`, async () => {
      const { app, calls } = newApp(() => result());
      const res = await post(app, "/imports/weekly-summary", ADMIN_KEY, environment);
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
    });
  }

  test("production applies", async () => {
    const { app, calls } = newApp(() => result({ applied: true, posted: true }));
    const res = await post(app, "/imports/weekly-summary?apply=1");
    expect(res.status).toBe(200);
    expect(calls[0]?.apply).toBe(true);
  });
});

describe("a report with unknowns in it is still a successful run", () => {
  /**
   * The contract: unknowns are the report's content, not its failure. Degrading this
   * to a non-2xx would make a monitoring caller unable to tell "some numbers were
   * unreadable" from "the report could not be produced".
   */
  test("errors in facts do not change the status code", async () => {
    const { app } = newApp(() =>
      result({
        facts: {
          ...result().facts,
          importedThisWeek: null,
          errors: [{ stage: "imports", error: "D1 timeout" }],
        },
      }),
    );
    const res = await post(app, "/imports/weekly-summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; facts: { importedThisWeek: number | null } };
    expect(body.ok).toBe(true);
    // And the unknown survives serialisation as null rather than becoming 0.
    expect(body.facts.importedThisWeek).toBeNull();
  });

  test("a gate refusal is a 200 that says why", async () => {
    const { app } = newApp(() =>
      result({ applied: true, posted: false, gateReason: "already posted for 2026-W37" }),
    );
    const res = await post(app, "/imports/weekly-summary?apply=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      posted: false,
      gateReason: "already posted for 2026-W37",
    });
  });
});

describe("a summary that throws", () => {
  test("answers 502, because the service is written not to throw", async () => {
    const { app } = newApp(() => {
      throw new Error("env.DB is undefined");
    });
    const res = await post(app, "/imports/weekly-summary");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("env.DB is undefined"),
    });
  });
});
