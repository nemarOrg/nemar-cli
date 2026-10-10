/**
 * `nemar admin pr-reviews start` (ADR 0092, ADR 0093): review the pull requests that were already
 * open when the automated review was switched on, or start again one whose review ended without a
 * verdict. Driven through the real entry point (`bun run src/index.ts ...`) like its sibling suite.
 *
 * The NEMAR API is the REAL admin router over bun:sqlite with every migration applied, served on a
 * local port and reached through TEST_API_URL. GitHub is a `Bun.serve()` stand-in that answers the
 * search, the pull request reads and the dispatch, check and comment writes, and records every
 * request with the token it carried. Isolated NEMAR_CONFIG_DIR, no mocks.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { makePrQueueApp } from "../backend/test/helpers/pr-queue-app";
import { type PrSpec, SHA_A, prNode, seedReview } from "../backend/test/helpers/pr-queue-fixtures";
import { DAILY_REVIEW_CAP } from "../shared/pr-review";
import { type GitHubStandin, WORKER_TOKEN, startGitHubStandin } from "./helpers/github-standin";

setDefaultTimeout(30_000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ADMIN_KEY = "cli-start-admin-key-0123456789abcdef0123456789abcdef";
const CALLBACK_SECRET = "cli-start-callback-secret";

let gh: GitHubStandin;
let apiServer: ReturnType<typeof Bun.serve>;
let db: Database;
let configDir: string;
let envOverrides: Partial<Bindings> = {};
let handle: ReturnType<typeof makePrQueueApp>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: WORKER_TOKEN,
    PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
    PR_REVIEW_ENABLED: "1",
    API_BASE_URL: "https://api.test.nemar.org",
    ...envOverrides,
  } as Bindings;
}

beforeAll(() => {
  gh = startGitHubStandin();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = gh.url;
  handle = makePrQueueApp();
  apiServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      return handle(req, env());
    },
  });
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  apiServer.stop(true);
  gh.stop();
});

function seedDataset(id: string) {
  db.run(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
  );
  db.run(
    `INSERT INTO datasets
       (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo, first_published_at)
     VALUES (?, ?, 1, 'active', 'public', 0, ?, '2026-01-01 00:00:00')`,
    [id, `A sufficiently descriptive title for ${id}`, `nemarDatasets/${id}`],
  );
}

beforeEach(async () => {
  db = freshDb();
  envOverrides = {};
  gh.reset();
  configDir = mkdtempSync(join(tmpdir(), "nemar-pr-start-cli-"));
  for (const id of ["nm000201", "nm000202", "nm000203", "nm000204", "nm000205"]) seedDataset(id);
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES ('startadmin', 'startadmin@example.org', 'x', 'startadmin-gh', 'approved', 'admin',
             'cli', 1, 1)`,
  );
  const row = db.query("SELECT id FROM users WHERE username = 'startadmin'").get() as {
    id: number;
  };
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "startadmin",
      accounts: { startadmin: { apiKey: ADMIN_KEY } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: `http://127.0.0.1:${apiServer.port}`,
    NEMAR_GITHUB_API_URL: gh.url,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(childEnv)) if (v !== undefined) clean[k] = v;
  const proc = spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: clean,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

const START = ["admin", "pr-reviews", "start"];

/** An open pull request: in the GraphQL search the queue lists, and as GitHub's REST record. */
function openPr(spec: PrSpec & { assoc?: string }) {
  const sha = spec.sha ?? SHA_A;
  gh.searchPages = [[...(gh.searchPages[0] ?? []), prNode({ ...spec, sha })]];
  gh.pulls[`${spec.ds}#${spec.n}`] = {
    sha,
    author: spec.author ?? "contributor",
    authorId: spec.authorId ?? 501,
    assoc: spec.assoc ?? "COLLABORATOR",
    draft: spec.draft ?? false,
  };
}

const dispatches = () =>
  gh.seen.filter(
    (s) => s.method === "POST" && s.path === "/repos/nemarDatasets/.github/dispatches",
  );
const rows = () =>
  db.query("SELECT * FROM pr_reviews ORDER BY id").all() as Array<Record<string, unknown>>;

describe("nemar admin pr-reviews start <dataset> <pr>", () => {
  test("starts the review of one open pull request, reading it from GitHub itself", async () => {
    openPr({ ds: "nm000201", n: 12, author: "alice", authorId: 42 });

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000201 #12");
    expect(r.stdout).toContain("started");
    expect(dispatches()).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ dataset_id: "nm000201", pr_number: 12, author_id: 42 });
    // The Worker read the pull request with its own token, not the administrator's.
    const read = gh.seen.find((s) => s.method === "GET" && s.path.endsWith("/nm000201/pulls/12"));
    expect(read?.token).toBe(WORKER_TOKEN);
    // The administrator's start is not an approval or a merge.
    expect(
      gh.seen.filter((s) => s.path.endsWith("/reviews") || s.path.endsWith("/merge")),
    ).toHaveLength(0);
  });

  test("says why a pull request was not started, in words", async () => {
    openPr({ ds: "nm000201", n: 12 });
    await cli([...START, "nm000201", "12"]);

    const again = await cli([...START, "nm000201", "12"]);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already has a review");
    expect(dispatches()).toHaveLength(1);
  });

  test("a paused contributor is named, with the command that lifts the pause", async () => {
    db.run(
      "INSERT INTO pr_review_overrides (author_id, author_login, mode) VALUES (42, 'alice', 'block')",
    );
    openPr({ ds: "nm000201", n: 12, author: "alice", authorId: 42 });

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("not started");
    expect(r.stdout).toContain("paused");
    expect(r.stdout).toContain("nemar admin pr-reviews allow alice");
    expect(dispatches()).toHaveLength(0);
  });

  test("a pull request GitHub does not have is an error with a word", async () => {
    const r = await cli([...START, "nm000201", "99"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("does not exist");
    expect(rows()).toHaveLength(0);
  });

  test("the review being off says so and starts nothing", async () => {
    envOverrides = { PR_REVIEW_ENABLED: undefined };
    openPr({ ds: "nm000201", n: 12 });

    const r = await cli([...START, "nm000201", "12"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("off");
    expect(dispatches()).toHaveLength(0);
  });

  test("arguments are checked before the API is asked", async () => {
    expect((await cli([...START, "not-a-dataset", "12"])).exitCode).toBe(1);
    expect((await cli([...START, "nm000201", "twelve"])).exitCode).toBe(1);
    expect((await cli([...START])).exitCode).toBe(1);
    expect((await cli([...START, "nm000201", "12", "--all"])).exitCode).toBe(1);
    expect(gh.seen).toHaveLength(0);
  });

  test("--json prints the Worker's answer and nothing else on stdout", async () => {
    openPr({ ds: "nm000201", n: 12 });

    const r = await cli([...START, "nm000201", "12", "--json"]);

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      dispatched: true,
      reason: "dispatched",
      environment: "production",
    });
  });
});

describe("nemar admin pr-reviews start --all", () => {
  function queue() {
    openPr({ ds: "nm000201", n: 1, author: "alice", authorId: 42 });
    openPr({ ds: "nm000202", n: 2, author: "bob", authorId: 43 });
    // Already reviewed: left alone.
    openPr({ ds: "nm000203", n: 3, author: "carol", authorId: 44 });
    seedReview(db, {
      ds: "nm000203",
      n: 3,
      sha: SHA_A,
      authorId: 44,
      state: "reported",
      verdict: "pass",
    });
    // A review that ended in an error: started again.
    openPr({ ds: "nm000204", n: 4, author: "dave", authorId: 45 });
    seedReview(db, {
      ds: "nm000204",
      n: 4,
      sha: SHA_A,
      authorId: 45,
      state: "errored",
      detail: "workflow_failed",
    });
    // A draft: not reviewed.
    openPr({ ds: "nm000205", n: 5, author: "erin", authorId: 46, draft: true });
  }

  test("starts every open pull request without a completed review, and only those", async () => {
    queue();

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(dispatches()).toHaveLength(3);
    const byPr = (n: number) => rows().find((x) => x.pr_number === n);
    expect(byPr(1)).toMatchObject({ state: "dispatched" });
    expect(byPr(2)).toMatchObject({ state: "dispatched" });
    expect(byPr(4)).toMatchObject({ state: "dispatched", detail: null });
    expect(byPr(3)).toMatchObject({ state: "reported" });
    expect(byPr(5)).toBeUndefined();
    expect(r.stdout).toContain("nm000201 #1");
    expect(r.stdout).toContain("nm000204 #4");
    expect(r.stdout).not.toContain("nm000203 #3");
    // A draft is left out before GitHub is asked about it.
    expect(r.stdout).not.toContain("nm000205 #5");
    expect(gh.seen.some((x) => x.path.includes("/nm000205/pulls/"))).toBe(false);
    expect(r.stdout).toMatch(/3 started/);
    expect(r.stdout).toMatch(/1 draft/);
  });

  test("--dry-run lists what would be started and starts nothing", async () => {
    queue();

    const r = await cli([...START, "--all", "--dry-run"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000201 #1");
    expect(r.stdout).toContain("nm000202 #2");
    expect(r.stdout).toContain("nm000204 #4");
    expect(r.stdout).toContain("dry run");
    expect(dispatches()).toHaveLength(0);
    expect(gh.seen.filter((s) => s.path.includes("/pulls/"))).toHaveLength(0);
  });

  test("asks before spending, and a closed stdin is a no", async () => {
    queue();

    const r = await cli([...START, "--all"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("--yes");
    expect(dispatches()).toHaveLength(0);
  });

  test("a contributor who is paused is listed apart, not started and not an error", async () => {
    queue();
    db.run(
      "INSERT INTO pr_review_overrides (author_id, author_login, mode) VALUES (42, 'alice', 'block')",
    );
    seedReview(db, {
      ds: "nm000201",
      n: 1,
      sha: SHA_A,
      authorId: 42,
      login: "alice",
      state: "declined",
      detail: "contributor_paused",
    });

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("the contributor is paused (lift it with 'allow')");
    expect(r.stdout).toContain("alice");
    expect(dispatches()).toHaveLength(2);
    // Listed apart: the Worker is not even asked about it, so nothing is declined a second time.
    expect(gh.seen.some((x) => x.path.includes("/nm000201/pulls/"))).toBe(false);
    expect(rows().filter((x) => x.pr_number === 1)).toHaveLength(1);
  });

  test("a contributor held back by an allowance is started: the administrator chose it", async () => {
    for (let i = 0; i < 3; i++) {
      seedReview(db, {
        ds: "nm000203",
        n: 100 + i,
        sha: `${i}`.repeat(40),
        authorId: 700,
        login: "stranger",
        state: "dispatched",
      });
    }
    openPr({ ds: "nm000201", n: 1, author: "stranger", authorId: 700, assoc: "NONE" });
    seedReview(db, {
      ds: "nm000201",
      n: 1,
      sha: SHA_A,
      authorId: 700,
      login: "stranger",
      state: "declined",
      detail: "rate_limited",
    });

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(dispatches()).toHaveLength(1);
    expect(rows().find((x) => x.pr_number === 1)).toMatchObject({ state: "dispatched" });
  });

  test("stops when the platform's daily pool is spent", async () => {
    queue();
    for (let i = 0; i < DAILY_REVIEW_CAP; i++) {
      seedReview(db, {
        ds: "nm000203",
        n: 1000 + i,
        sha: `${i}`.padStart(40, "b"),
        authorId: 20_000 + i,
        state: "reported",
        verdict: "pass",
        // Inside the day the pool is counted over (a result seeded without a date is old).
        createdAt: new Date().toISOString().slice(0, 19).replace("T", " "),
      });
    }

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("daily");
    expect(dispatches()).toHaveLength(0);
    // The first decline says the pool is spent; the rest are not tried.
    expect(gh.seen.filter((s) => s.method === "GET" && s.path.includes("/pulls/"))).toHaveLength(1);
  });

  test("a pull request that cannot be read is counted and the run goes on", async () => {
    queue();
    Reflect.deleteProperty(gh.pulls, "nm000202#2");

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/1 failed/);
    expect(dispatches()).toHaveLength(2);
  });

  test("the review being off says so before anything else", async () => {
    envOverrides = { PR_REVIEW_ENABLED: undefined };
    queue();

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("off");
    expect(dispatches()).toHaveLength(0);
  });

  test("nothing to start is said, and is not an error", async () => {
    openPr({ ds: "nm000203", n: 3, author: "carol", authorId: 44 });
    seedReview(db, {
      ds: "nm000203",
      n: 3,
      sha: SHA_A,
      authorId: 44,
      state: "reported",
      verdict: "pass",
    });

    const r = await cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Nothing to start");
  });

  test("--json prints one result per pull request", async () => {
    queue();

    const r = await cli([...START, "--all", "--yes", "--json"]);

    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.results).toHaveLength(3);
    expect(out.results.every((x: { dispatched: boolean }) => x.dispatched)).toBe(true);
    expect(out.results.map((x: { reason: string }) => x.reason).sort()).toEqual([
      "dispatched",
      "dispatched",
      "redispatched",
    ]);
    expect(out.failed).toBe(0);
  });
});
