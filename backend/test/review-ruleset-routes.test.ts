/**
 * The admin routes that put the "NEMAR PR review required" ruleset on dataset repositories, and
 * take it off (ADR 0107): POST /admin/datasets/:id/review-ruleset and
 * POST /admin/datasets/review-ruleset/bulk.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration applied, the real admin
 * router with its real auth (a seeded admin and a seeded owner, each with a hashed token), and a
 * stateful `Bun.serve()` stand-in for api.github.com (helpers/github-rulesets.ts) that holds each
 * repository's rulesets. What is asserted is what a repository holds afterwards, and what the audit
 * log says, not what a function was called with.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import {
  BRANCH_RULESET_NAME,
  REVIEW_RULESET_NAME,
  buildReviewRulesetPayload,
  deriveContexts,
  ensureBranchRuleset,
  ensureReviewRuleset,
} from "../src/services/github";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type RulesetStandIn, startRulesetStandIn } from "./helpers/github-rulesets";

const ADMIN_KEY = "review-ruleset-admin-key-0123456789abcdef0123456789abcdef";
const OWNER_KEY = "review-ruleset-owner-key-0123456789abcdef0123456789abcdef";
const PAT = "ghp_review_ruleset_routes";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let standIn: RulesetStandIn;
let envOverrides: Partial<Bindings> = {};
let adminId = 0;

beforeAll(() => {
  standIn = startRulesetStandIn();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = standIn.url;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  standIn.stop();
});

async function seedAccount(username: string, role: string, key: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES (?, ?, 'x', ?, 'approved', ?, 'cli', 1, 0)`,
    [username, `${username}@example.org`, `${username}-gh`, role],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`seed failed for ${username}`);
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return row.id;
}

beforeEach(async () => {
  db = freshDb();
  standIn.reset();
  envOverrides = {};
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedAccount("revadmin", "admin", ADMIN_KEY);
  await seedAccount("revowner", "owner", OWNER_KEY);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: PAT,
    PR_REVIEW_ENABLED: "1",
    ...envOverrides,
  } as Bindings;
}

interface DatasetOpts {
  status?: string;
  visibility?: string;
  anonymous?: number;
  first_published_at?: string | null;
  github_repo?: string | null;
}

/** A published, public, named dataset unless said otherwise: the kind the Worker reviews. */
function seedDataset(id: string, o: DatasetOpts = {}): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo,
                           status, visibility, anonymous, first_published_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      id,
      `A sufficiently descriptive title for ${id}`,
      adminId,
      o.github_repo === undefined ? `nemarDatasets/${id}` : o.github_repo,
      o.status ?? "active",
      o.visibility ?? "public",
      o.anonymous ?? 0,
      o.first_published_at === undefined ? "2026-01-01 00:00:00" : o.first_published_at,
    ],
  );
}

// biome-ignore lint/suspicious/noExplicitAny: a response body is read field by field
type Json = Record<string, any>;

async function post(
  path: string,
  body: unknown,
  key = ADMIN_KEY,
): Promise<{ status: number; body: Json }> {
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

const single = (id: string, body: unknown = {}, key = ADMIN_KEY) =>
  post(`/admin/datasets/${id}/review-ruleset`, body, key);
const bulk = (body: unknown = {}, key = OWNER_KEY) =>
  post("/admin/datasets/review-ruleset/bulk", body, key);

const held = (repo: string) => (standIn.rulesets.get(repo) ?? []).map((r) => r.name).sort();
const audits = () =>
  db
    .query<{ action: string; resource_id: string; details: string; user_id: number }, []>(
      "SELECT action, resource_id, details, user_id FROM audit_log WHERE action LIKE 'review_ruleset_%' ORDER BY id",
    )
    .all();

describe("POST /admin/datasets/:id/review-ruleset", () => {
  test("a bare request is a dry run: it reports the payload and writes nothing", async () => {
    seedDataset("nm000201");

    const r = await single("nm000201");

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dataset_id: "nm000201",
      dry_run: true,
      review_enabled: true,
      reviewable: true,
      not_reviewable_because: null,
      intent: "require",
      action: "create",
      applied: false,
    });
    expect(r.body.payload).toStrictEqual(buildReviewRulesetPayload());
    expect(r.body.payload.bypass_actors.map((a: Json) => a.actor_type)).toEqual([
      "Integration",
      "OrganizationAdmin",
      "RepositoryRole",
    ]);
    expect(standIn.writes()).toHaveLength(0);
    expect(held("nm000201")).toEqual([]);
    expect(audits()).toEqual([]);
  });

  test("only an explicit dry_run:false writes, and the audit row names who did it", async () => {
    seedDataset("nm000201");

    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dry_run: false,
      intent: "require",
      action: "create",
      applied: true,
    });
    expect(held("nm000201")).toEqual([REVIEW_RULESET_NAME]);
    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "review_ruleset_applied",
      resource_id: "nm000201",
      user_id: adminId,
    });
    expect(JSON.parse(rows[0].details)).toEqual({ by: "revadmin", action: "create", bulk: false });
  });

  test("applying again updates the same ruleset in place", async () => {
    seedDataset("nm000201");
    await single("nm000201", { dry_run: false });

    const again = await single("nm000201", { dry_run: false });

    expect(again.body).toMatchObject({ action: "update", applied: true });
    expect(held("nm000201")).toEqual([REVIEW_RULESET_NAME]);
  });

  test("a dataset the Worker does not review calls for removal, and is never given the ruleset", async () => {
    const cases: Array<[string, DatasetOpts, string]> = [
      ["nm000211", { visibility: "private" }, "private"],
      ["nm000212", { status: "archived" }, "inactive"],
      ["nm000213", { first_published_at: null }, "unpublished"],
      ["nm000214", { anonymous: 1, first_published_at: null }, "anonymous"],
    ];
    for (const [id, opts, because] of cases) {
      seedDataset(id, opts);
      const r = await single(id, { dry_run: false });
      expect(r.status, id).toBe(200);
      expect(r.body, id).toMatchObject({
        reviewable: false,
        not_reviewable_because: because,
        intent: "remove",
        action: "none",
        applied: false,
      });
      expect(held(id), id).toEqual([]);
    }
    expect(standIn.writes()).toHaveLength(0);
  });

  test("a dataset that stopped being reviewed has the ruleset taken off, and the audit says removed", async () => {
    seedDataset("nm000201", { visibility: "private" });
    await ensureReviewRuleset("nm000201", PAT);
    standIn.calls.length = 0;

    const r = await single("nm000201", { dry_run: false });

    expect(r.body).toMatchObject({ intent: "remove", action: "remove", applied: true });
    expect(held("nm000201")).toEqual([]);
    expect(audits().map((a) => a.action)).toEqual(["review_ruleset_removed"]);
  });

  test("remove:true takes it off a reviewed dataset too, and leaves the branch ruleset", async () => {
    seedDataset("nm000201");
    await ensureBranchRuleset("nm000201", PAT, { checks: deriveContexts("nm000201") });
    await ensureReviewRuleset("nm000201", PAT);

    const r = await single("nm000201", { dry_run: false, remove: true });

    expect(r.body).toMatchObject({ reviewable: true, intent: "remove", action: "remove" });
    expect(held("nm000201")).toEqual([BRANCH_RULESET_NAME]);
  });

  test("a repository whose default branch is not main is skipped, not written", async () => {
    seedDataset("nm000201");
    standIn.defaultBranches.set("nm000201", "master");

    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      intent: "require",
      action: "skip",
      applied: false,
      reason: "default_branch_not_main",
      default_branch: "master",
    });
    expect(standIn.writes()).toHaveLength(0);
    expect(audits()).toEqual([]);
  });

  describe("while the review is off", () => {
    test.each([undefined, "", "0", "true", "yes"])(
      "a live request to require it is refused with review_disabled before GitHub is asked (%j)",
      async (flag) => {
        seedDataset("nm000201");
        envOverrides = { PR_REVIEW_ENABLED: flag };

        const r = await single("nm000201", { dry_run: false });

        expect(r.status).toBe(409);
        expect(r.body.code).toBe("review_disabled");
        expect(r.body.error).toContain("PR_REVIEW_ENABLED");
        expect(standIn.calls).toHaveLength(0);
        expect(audits()).toEqual([]);
      },
    );

    test("the refusal does not depend on what this dataset's row calls for", async () => {
      // A private dataset would only be removed, but the request as typed is a live apply with the
      // review off, and it is refused the same way: the rule does not read the catalog.
      seedDataset("nm000201", { visibility: "private" });
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await single("nm000201", { dry_run: false });

      expect(r.status).toBe(409);
      expect(r.body.code).toBe("review_disabled");
    });

    test("a dry run still answers, and says the review is off", async () => {
      seedDataset("nm000201");
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await single("nm000201");

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ review_enabled: false, intent: "require", action: "create" });
      expect(standIn.writes()).toHaveLength(0);
    });

    test("taking the requirement off is never refused: it is the way out", async () => {
      seedDataset("nm000201");
      await ensureReviewRuleset("nm000201", PAT);
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await single("nm000201", { dry_run: false, remove: true });

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ action: "remove", applied: true, review_enabled: false });
      expect(held("nm000201")).toEqual([]);
    });
  });

  describe("the fixture band nm099900 to nm099999", () => {
    test.each(["nm099999", "nm099998", "nm099997", "nm099950", "nm099900"])(
      "%s is refused whatever is asked, before the catalog or GitHub is read",
      async (id) => {
        seedDataset(id);
        for (const body of [{}, { dry_run: false }, { dry_run: false, remove: true }]) {
          const r = await single(id, body);
          expect(r.status, JSON.stringify(body)).toBe(403);
          expect(r.body.code).toBe("reserved_fixture_id");
        }
        expect(standIn.calls).toHaveLength(0);
        expect(audits()).toEqual([]);
      },
    );

    test("the id just below the band, and the staging exemplars, are ordinary datasets", async () => {
      seedDataset("nm099899");
      seedDataset("xx099900");

      expect((await single("nm099899", { dry_run: false })).status).toBe(200);
      expect((await single("xx099900", { dry_run: false })).status).toBe(200);
      expect(held("nm099899")).toEqual([REVIEW_RULESET_NAME]);
      expect(held("xx099900")).toEqual([REVIEW_RULESET_NAME]);
    });
  });

  test.each(["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"])(
    "%s is an ordinary dataset: no override is asked for, and none is accepted",
    async (id) => {
      seedDataset(id);

      const applied = await single(id, { dry_run: false });
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ action: "create", applied: true });
      expect(held(id)).toEqual([REVIEW_RULESET_NAME]);

      // The override the first design had is gone, and a request that still sends it is refused
      // rather than read as having been honored.
      const forced = await single(id, { dry_run: false, force_live: true });
      expect(forced.status).toBe(400);
    },
  );

  test("a body with a key the route does not know is refused, and nothing is done", async () => {
    seedDataset("nm000201");

    for (const body of [{ force: true }, { dry_run: "false" }, { remove: "yes" }]) {
      const r = await single("nm000201", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(standIn.calls).toHaveLength(0);
  });

  test("an unknown dataset is 404 and a dataset without a repository is 400", async () => {
    expect((await single("nm000299")).status).toBe(404);
    seedDataset("nm000202", { github_repo: null });
    const r = await single("nm000202", { dry_run: false });
    expect(r.status).toBe(400);
    expect(standIn.calls).toHaveLength(0);
  });

  test("a GitHub failure is a 502 with GitHub's answer, nothing is audited, and nothing is kept", async () => {
    seedDataset("nm000201");
    standIn.failNext("POST", /\/rulesets$/, 422);

    const r = await single("nm000201", { dry_run: false });

    expect(r.status).toBe(502);
    expect(r.body.details).toContain("Review ruleset create failed for nm000201");
    expect(held("nm000201")).toEqual([]);
    expect(audits()).toEqual([]);
  });

  test("an administrator may use it, and a member may not", async () => {
    seedDataset("nm000201");
    expect((await single("nm000201", {}, ADMIN_KEY)).status).toBe(200);

    db.run(
      `INSERT INTO users (username, email, password_hash, github_username, status, role,
                          signup_source, email_verified, service_access)
       VALUES ('revmember', 'revmember@example.org', 'x', 'revmember-gh', 'verified', 'member',
               'cli', 1, 0)`,
    );
    const id = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='revmember'")
      .get();
    const key = "review-ruleset-member-key-0123456789abcdef0123456789abcdef";
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      id?.id,
      await hashApiKey(key),
      key.slice(0, 8),
    );
    expect((await single("nm000201", { dry_run: false }, key)).status).toBe(403);
    expect(held("nm000201")).toEqual([]);
  });
});

describe("POST /admin/datasets/review-ruleset/bulk", () => {
  function seedFleet(): void {
    seedDataset("nm000301"); // reviewed
    seedDataset("nm000302"); // reviewed
    seedDataset("nm000303", { visibility: "private" });
    seedDataset("nm000304", { first_published_at: null });
    seedDataset("on000305"); // reviewed, imported
  }

  test("only the owner may use it", async () => {
    seedFleet();

    const asAdmin = await bulk({}, ADMIN_KEY);
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.error).toContain("owner");
    expect(standIn.calls).toHaveLength(0);

    expect((await bulk({}, OWNER_KEY)).status).toBe(200);
  });

  test("a bare request is a dry run: each row says what it would do, and nothing is written", async () => {
    seedFleet();
    await ensureReviewRuleset("nm000303", PAT); // a ruleset left on a dataset that is now private
    standIn.calls.length = 0;

    const r = await bulk({});

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dry_run: true, review_enabled: true, remove: false, limit: 25 });
    expect(r.body.payload).toStrictEqual(buildReviewRulesetPayload());
    const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
    expect(byId.nm000301).toMatchObject({ intent: "require", action: "create", applied: false });
    expect(byId.nm000302).toMatchObject({ intent: "require", action: "create", applied: false });
    expect(byId.on000305).toMatchObject({ intent: "require", action: "create", applied: false });
    expect(byId.nm000303).toMatchObject({
      reviewable: false,
      not_reviewable_because: "private",
      intent: "remove",
      action: "remove",
      applied: false,
    });
    expect(byId.nm000304).toMatchObject({
      not_reviewable_because: "unpublished",
      intent: "remove",
      action: "none",
    });
    expect(r.body.results.map((x: Json) => x.dataset_id)).toEqual([
      "nm000301",
      "nm000302",
      "nm000303",
      "nm000304",
      "on000305",
    ]);
    expect(standIn.writes()).toHaveLength(0);
    expect(audits()).toEqual([]);
  });

  test("applying puts the ruleset on the reviewed datasets and takes it off the rest", async () => {
    seedFleet();
    await ensureReviewRuleset("nm000303", PAT);

    const r = await bulk({ dry_run: false });

    expect(r.status).toBe(200);
    expect(held("nm000301")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("nm000302")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("on000305")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("nm000303")).toEqual([]);
    expect(held("nm000304")).toEqual([]);
    // One audit row for each change and none for the dataset that needed nothing.
    expect(audits().map((a) => `${a.action} ${a.resource_id}`)).toEqual([
      "review_ruleset_applied nm000301",
      "review_ruleset_applied nm000302",
      "review_ruleset_removed nm000303",
      "review_ruleset_applied on000305",
    ]);
    expect(JSON.parse(audits()[0].details)).toEqual({
      by: "revowner",
      action: "create",
      bulk: true,
    });
  });

  test("remove takes the ruleset off every dataset it is asked about, reviewed or not", async () => {
    seedFleet();
    await bulk({ dry_run: false });
    expect(held("nm000301")).toEqual([REVIEW_RULESET_NAME]);

    const r = await bulk({ dry_run: false, remove: true });

    expect(r.body).toMatchObject({ remove: true, payload: null });
    expect(held("nm000301")).toEqual([]);
    expect(held("nm000302")).toEqual([]);
    expect(held("on000305")).toEqual([]);
  });

  test("the fixture band is never selected, and the datasets around it are", async () => {
    for (const id of ["nm099899", "nm099900", "nm099950", "nm099997", "nm099998", "nm099999"]) {
      seedDataset(id);
    }
    seedDataset("xx099900");

    const r = await bulk({ dry_run: false });

    const ids = r.body.results.map((x: Json) => x.dataset_id);
    expect(ids).toEqual(["nm099899", "xx099900"]);
    for (const fixture of ["nm099900", "nm099950", "nm099997", "nm099998", "nm099999"]) {
      expect(held(fixture), fixture).toEqual([]);
      expect(
        standIn.calls.filter((c) => c.path.includes(`/repos/nemarDatasets/${fixture}`)),
        fixture,
      ).toHaveLength(0);
    }
    expect(held("nm099899")).toEqual([REVIEW_RULESET_NAME]);
  });

  test("the five datasets an old rule protected are ordinary rows in a batch", async () => {
    for (const id of ["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"]) seedDataset(id);

    const r = await bulk({ dry_run: false });

    expect(r.body.results.map((x: Json) => x.dataset_id)).toEqual([
      "nm000103",
      "nm000104",
      "nm000105",
      "nm000106",
      "nm000107",
    ]);
    for (const id of ["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"]) {
      expect(held(id), id).toEqual([REVIEW_RULESET_NAME]);
    }
  });

  test("pages are bounded and follow one another by id", async () => {
    for (let n = 1; n <= 5; n++) seedDataset(`nm00040${n}`);

    const first = await bulk({ limit: 2 });
    expect(first.body.results.map((x: Json) => x.dataset_id)).toEqual(["nm000401", "nm000402"]);
    expect(first.body).toMatchObject({ limit: 2, count: 2, next_after: "nm000402" });

    const second = await bulk({ limit: 2, after: first.body.next_after });
    expect(second.body.results.map((x: Json) => x.dataset_id)).toEqual(["nm000403", "nm000404"]);
    expect(second.body.next_after).toBe("nm000404");

    const last = await bulk({ limit: 2, after: second.body.next_after });
    expect(last.body.results.map((x: Json) => x.dataset_id)).toEqual(["nm000405"]);
    // A page that is not full is the last one.
    expect(last.body).toMatchObject({ count: 1, next_after: null });
  });

  test("a page is at most 50: more is refused, and so is a limit that is not a count", async () => {
    for (const limit of [51, 100, 0, -1, 2.5, "10"]) {
      const r = await bulk({ limit });
      expect(r.status, String(limit)).toBe(400);
    }
    expect(standIn.calls).toHaveLength(0);
    expect((await bulk({ limit: 50 })).status).toBe(200);
  });

  test("a prefix narrows the page, and something that is not a prefix is refused", async () => {
    seedFleet();

    const on = await bulk({ prefix: "on" });
    expect(on.body.results.map((x: Json) => x.dataset_id)).toEqual(["on000305"]);

    const narrow = await bulk({ prefix: "nm0003" });
    expect(narrow.body.count).toBe(4);

    for (const prefix of ["nm%", "n_", "NM", "nm0000000", "", "../"]) {
      expect((await bulk({ prefix })).status, JSON.stringify(prefix)).toBe(400);
    }
    expect((await bulk({ after: "nm0003" })).status).toBe(400);
  });

  test("a dataset without a repository is not selected", async () => {
    seedDataset("nm000501", { github_repo: null });
    seedDataset("nm000502");

    const r = await bulk({});

    expect(r.body.results.map((x: Json) => x.dataset_id)).toEqual(["nm000502"]);
  });

  test("a repository that fails is an error on its row, and the page goes on", async () => {
    seedFleet();
    standIn.failNext("GET", /\/repos\/nemarDatasets\/nm000302\/rulesets$/, 403);

    const r = await bulk({ dry_run: false });

    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.results.map((x: Json) => [x.dataset_id, x]));
    expect(byId.nm000302.action).toBeNull();
    expect(byId.nm000302.applied).toBe(false);
    expect(byId.nm000302.error).toContain("Review ruleset list failed for nm000302");
    expect(held("nm000301")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("on000305")).toEqual([REVIEW_RULESET_NAME]);
    expect(held("nm000302")).toEqual([]);
    expect(audits().map((a) => a.resource_id)).not.toContain("nm000302");
  });

  test("a repository on another default branch is skipped on its row", async () => {
    seedFleet();
    standIn.defaultBranches.set("nm000301", "master");

    const r = await bulk({ dry_run: false });

    const row = r.body.results.find((x: Json) => x.dataset_id === "nm000301");
    expect(row).toMatchObject({
      action: "skip",
      reason: "default_branch_not_main",
      applied: false,
    });
    expect(held("nm000301")).toEqual([]);
    expect(held("nm000302")).toEqual([REVIEW_RULESET_NAME]);
  });

  describe("while the review is off", () => {
    test("a live request is refused as a whole with review_disabled, before the catalog is read", async () => {
      seedFleet();
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const r = await bulk({ dry_run: false });

      expect(r.status).toBe(409);
      expect(r.body.code).toBe("review_disabled");
      expect(standIn.calls).toHaveLength(0);
      expect(audits()).toEqual([]);
    });

    test("a dry run answers, and so does a live removal", async () => {
      seedFleet();
      await ensureReviewRuleset("nm000301", PAT);
      envOverrides = { PR_REVIEW_ENABLED: undefined };

      const dry = await bulk({});
      expect(dry.status).toBe(200);
      expect(dry.body.review_enabled).toBe(false);

      const off = await bulk({ dry_run: false, remove: true });
      expect(off.status).toBe(200);
      expect(held("nm000301")).toEqual([]);
    });
  });

  test("a body with a key it does not know, the retired override included, is refused", async () => {
    seedFleet();
    for (const body of [{ force_live: true }, { force: true }, { dry_run: "false" }]) {
      expect((await bulk(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(standIn.calls).toHaveLength(0);
  });
});
