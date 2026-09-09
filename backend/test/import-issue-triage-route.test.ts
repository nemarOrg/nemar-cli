/**
 * Real `POST /admin/imports/issue-triage` route tests (epic #1306, issue #1310).
 *
 * Modelled on `zarr-fidelity-sweep-route.test.ts`: real bun:sqlite behind realD1,
 * the real `authMiddleware`/`adminMiddleware` stack with seeded hashed tokens, and
 * real Hono dispatch via `app.request()`.
 *
 * The route owns four decisions no service test can reach, and every one of them
 * is a way for a bad run to read as a good one:
 *
 *   1. `apply` is refused outside production, because the tracker repo is shared
 *      with production rather than environment-scoped.
 *   2. The 502 is measured over ATTEMPTS. Measured over `examined`, the realistic
 *      write outage answered 200 `ok:true`.
 *   3. The audit row is written for an applied run that changed something, and
 *      an audit failure does not convert a successful mutation into a 500.
 *   4. `?limit=abc` must not become a silent zero-work run.
 *
 * The sweep itself is injected. That is a transport substitution one level up
 * rather than a business-logic mock: the service's own decisions are covered in
 * `import-issue-sweep.test.ts` against the real orchestrator, and what is under
 * test here is the route's handling of a result, which needs the result to be
 * arbitrary.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerImportIssueTriageRoutes } from "../src/routes/admin/import-issue-triage";
import type {
  ImportIssueSweepResult,
  runImportIssueSweep,
} from "../src/services/import-issue-sweep";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "iit-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "iit-member-key-0123456789abcdef0123456789abcdef0";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

let db: Database;

/** A result with nothing in it, overridden per test. */
function result(over: Partial<ImportIssueSweepResult> = {}): ImportIssueSweepResult {
  return {
    applied: false,
    openIssues: 0,
    mode: "per-dataset",
    rollups: [],
    rollupsReleased: 0,
    examined: 0,
    attempted: 0,
    closed: 0,
    relabelled: 0,
    kept: 0,
    plan: [],
    errors: [],
    remaining: 0,
    ...over,
  };
}

/** Records the options the route passed through, so the clamp and the dry-run
 *  default are observable end to end. */
function newApp(
  fn: (
    ...args: Parameters<typeof runImportIssueSweep>
  ) => Promise<ImportIssueSweepResult> | ImportIssueSweepResult,
): { app: App; calls: { limit?: number; apply?: boolean }[] } {
  const calls: { limit?: number; apply?: boolean }[] = [];
  const app: App = new Hono();
  app.use("*", authMiddleware);
  app.use("*", adminMiddleware);
  registerImportIssueTriageRoutes(app, {
    sweep: async (env, opts = {}, deps = {}) => {
      calls.push({ limit: opts.limit, apply: opts.apply });
      return fn(env, opts, deps);
    },
  });
  return { app, calls };
}

async function seedUsers(database: Database): Promise<void> {
  database.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('iitadmin', 'iitadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const admin = database
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='iitadmin'")
    .get();
  if (!admin) throw new Error("seed: admin insert failed");
  database
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(admin.id, await hashApiKey(ADMIN_KEY), ADMIN_KEY.slice(0, 8));

  database.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('iitmember', 'iitmember@example.org', 'x', 'approved', 'member', 1)`,
  );
  const member = database
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='iitmember'")
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
  test("a non-admin cannot triage", async () => {
    const { app, calls } = newApp(() => result());
    const res = await post(app, "/imports/issue-triage", MEMBER_KEY);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("dry run is the default", () => {
  test("a bare POST does not apply", async () => {
    const { app, calls } = newApp(() => result());
    const res = await post(app, "/imports/issue-triage");
    expect(res.status).toBe(200);
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
      await post(app, `/imports/issue-triage${query}`);
      expect(calls[0]?.apply).toBe(expected);
    }
  });
});

describe("apply is production-only", () => {
  /**
   * `IMPORT_FAILURE_ISSUES_REPO` is hardcoded and `nemarDatasets` is shared
   * between production and dev, so a staging apply writes to the production
   * tracker. A `TEST_ADMIN_API_KEY` reaches this route, so the cron wrapper's
   * guard is not enough on its own.
   */
  for (const environment of ["development", "staging", "test"]) {
    test(`${environment} refuses apply without running the sweep`, async () => {
      const { app, calls } = newApp(() => result({ applied: true }));
      const res = await post(app, "/imports/issue-triage?apply=1", ADMIN_KEY, environment);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("production-only") });
      // Nothing ran: the refusal is before the sweep, not after it.
      expect(calls).toEqual([]);
    });

    test(`${environment} still allows the dry run, because reading is the point`, async () => {
      const { app, calls } = newApp(() => result());
      const res = await post(app, "/imports/issue-triage", ADMIN_KEY, environment);
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
    });
  }

  test("production applies", async () => {
    const { app, calls } = newApp(() => result({ applied: true }));
    const res = await post(app, "/imports/issue-triage?apply=1");
    expect(res.status).toBe(200);
    expect(calls[0]?.apply).toBe(true);
  });
});

describe("limit parsing", () => {
  test("a garbage limit is not passed through as NaN", async () => {
    // Losing the isFinite guard makes `slice(0, NaN)` empty, so the run examines
    // nothing, `remaining` serialises as null, and the status is a clean 200.
    const { app, calls } = newApp(() => result());
    const res = await post(app, "/imports/issue-triage?limit=abc");
    expect(res.status).toBe(200);
    expect(calls[0]?.limit).toBeUndefined();
  });

  test("an explicit limit reaches the sweep verbatim, for it to clamp", async () => {
    const { app, calls } = newApp(() => result());
    await post(app, "/imports/issue-triage?limit=7");
    expect(calls[0]?.limit).toBe(7);
  });
});

describe("the 502 is measured over attempts, not over examined", () => {
  /**
   * The realistic write outage: a PAT that lost `issues: write` still lists fine,
   * so keeps succeed and only the writes fail. Measured over `examined` (10 keeps
   * + 5 failed writes = 5 errors of 15 examined) this answered 200 `ok: true`.
   */
  test("every attempted write failing is a 502 even when keeps succeeded", async () => {
    const { app } = newApp(() =>
      result({
        applied: true,
        examined: 15,
        attempted: 5,
        kept: 10,
        errors: Array.from({ length: 5 }, (_, i) => ({
          issue: 100 + i,
          dataset_id: `on00000${i}`,
          stage: "apply" as const,
          error: "HTTP 403 - resource not accessible by integration",
        })),
      }),
    );
    const res = await post(app, "/imports/issue-triage?apply=1");
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      details: { errors: unknown[] };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("All 5 attempted");
    // Carried under `details` so the CLI's ApiError keeps the causes: the message
    // says "see errors[]", so there has to be an errors[] to see.
    expect(body.details.errors).toHaveLength(5);
  });

  test("a comment-stage error is not a failure: its state change landed", async () => {
    const { app } = newApp(() =>
      result({
        applied: true,
        examined: 1,
        attempted: 1,
        closed: 1,
        errors: [
          {
            issue: 105,
            dataset_id: "on006136",
            stage: "comment",
            error: "close landed; explanatory comment failed: HTTP 502",
          },
        ],
      }),
    );
    const res = await post(app, "/imports/issue-triage?apply=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, closed: 1 });
  });

  test("a partial failure is a successful run", async () => {
    const { app } = newApp(() =>
      result({
        applied: true,
        examined: 3,
        attempted: 2,
        closed: 1,
        errors: [{ issue: 1, dataset_id: "on000001", stage: "apply", error: "boom" }],
      }),
    );
    const res = await post(app, "/imports/issue-triage?apply=1");
    expect(res.status).toBe(200);
  });

  /** `attempted > 0` is what keeps an empty candidate set out of the 502 branch;
   *  a bare `errors.length === attempted` would make every empty run a 502. */
  test("an empty candidate set is 200, not 502", async () => {
    const { app } = newApp(() => result({ applied: true }));
    const res = await post(app, "/imports/issue-triage?apply=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, examined: 0 });
  });
});

describe("the audit row", () => {
  test("an applied run that closed something writes exactly one row, excluding keeps", async () => {
    const { app } = newApp(() =>
      result({
        applied: true,
        examined: 2,
        attempted: 1,
        closed: 1,
        kept: 1,
        plan: [
          {
            issueNumber: 105,
            datasetId: "on006136",
            title: "t",
            kind: "close",
            reason: "verified complete",
          },
          {
            issueNumber: 97,
            datasetId: "on005279",
            title: "t",
            kind: "keep",
            reason: "incomplete",
          },
        ],
      }),
    );
    const res = await post(app, "/imports/issue-triage?apply=1");
    expect(res.status).toBe(200);

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("import_issue_triage");
    expect(rows[0]?.resource_id).toBe("on006136");
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({ closed: 1, kept: 1 });
  });

  test("a plan entry that FAILED is not named in the audit row", async () => {
    const { app } = newApp(() =>
      result({
        applied: true,
        examined: 2,
        attempted: 2,
        closed: 1,
        plan: [
          { issueNumber: 105, datasetId: "on006136", title: "t", kind: "close", reason: "r" },
          {
            issueNumber: 106,
            datasetId: "on006137",
            title: "t",
            kind: "close",
            reason: "r",
            failed: true,
          },
        ],
        errors: [{ issue: 106, dataset_id: "on006137", stage: "apply", error: "boom" }],
      }),
    );
    await post(app, "/imports/issue-triage?apply=1");
    expect(auditRows()[0]?.resource_id).toBe("on006136");
  });

  test("a dry run is a read: no audit row", async () => {
    const { app } = newApp(() => result({ examined: 1, closed: 1 }));
    const res = await post(app, "/imports/issue-triage");
    expect(res.status).toBe(200);
    expect(auditRows()).toEqual([]);
  });

  test("an applied run that changed nothing writes no row", async () => {
    const { app } = newApp(() => result({ applied: true, examined: 3, kept: 3 }));
    await post(app, "/imports/issue-triage?apply=1");
    expect(auditRows()).toEqual([]);
  });

  /**
   * The audit write sits OUTSIDE the sweep's try for a reason: it runs after real
   * issues have been closed on GitHub. Converting that into a 500 would tell the
   * operator "nothing happened" while up to `limit` issues are closed and the
   * whole result is discarded.
   */
  test("an audit failure does not discard a run that already closed issues", async () => {
    const { app } = newApp(() => result({ applied: true, examined: 1, attempted: 1, closed: 1 }));
    // Drop the table the audit insert needs, leaving everything else intact.
    db.run("DROP TABLE audit_log");

    const res = await post(app, "/imports/issue-triage?apply=1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; closed: number; audit_failed?: string };
    expect(body.ok).toBe(true);
    expect(body.closed).toBe(1);
    // Reported, not swallowed.
    expect(body.audit_failed).toBeTruthy();
  });
});

describe("a sweep that throws before it can report", () => {
  test("answers 500 without claiming the listing was the cause", async () => {
    const { app } = newApp(() => {
      // getDatasetsToken throwing on a misconfigured App is just as likely as a
      // listing failure, and sending an operator to look at labels instead of
      // credentials is what the old wording did.
      throw new Error("GITHUB_ADMIN_PAT is not configured");
    });
    const res = await post(app, "/imports/issue-triage");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("GITHUB_ADMIN_PAT is not configured");
    expect(body.error).not.toContain("Failed to list");
  });
});
