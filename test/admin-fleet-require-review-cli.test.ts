/**
 * `nemar admin fleet require-review` (ADR 0107): put the "NEMAR PR review required" ruleset on the
 * datasets the automated review covers, and take it off the rest. Driven through the real entry
 * point (`bun run src/index.ts ...`) like its sibling suites.
 *
 * The NEMAR API is the REAL admin router over bun:sqlite with every migration applied, served on a
 * local port and reached through TEST_API_URL, with the account a real hashed key. GitHub is a
 * stateful `Bun.serve()` stand-in (backend/test/helpers/github-rulesets.ts) that holds each
 * repository's rulesets, so what is asserted is what a repository holds afterwards. Isolated
 * NEMAR_CONFIG_DIR, no mocks.
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
import { type RulesetStandIn, startRulesetStandIn } from "../backend/test/helpers/github-rulesets";
import { makePrQueueApp } from "../backend/test/helpers/pr-queue-app";

setDefaultTimeout(30_000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const OWNER_KEY = "cli-review-owner-key-0123456789abcdef0123456789abcdef";
const ADMIN_KEY = "cli-review-admin-key-0123456789abcdef0123456789abcdef";
const REVIEW_RULESET = "NEMAR PR review required";

let standIn: RulesetStandIn;
let apiServer: ReturnType<typeof Bun.serve>;
let db: Database;
let configDir: string;
let envOverrides: Partial<Bindings> = {};
let handle: ReturnType<typeof makePrQueueApp>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_cli_review_ruleset",
    PR_REVIEW_ENABLED: "1",
    ...envOverrides,
  } as Bindings;
}

beforeAll(() => {
  standIn = startRulesetStandIn();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = standIn.url;
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
  standIn.stop();
});

async function seedAccount(username: string, role: string, key: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES (?, ?, 'x', ?, 'approved', ?, 'cli', 1, 1)`,
    [username, `${username}@example.org`, `${username}-gh`, role],
  );
  const row = db.query("SELECT id FROM users WHERE username = ?").get(username) as { id: number };
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return row.id;
}

let ownerId = 0;

function seedDataset(
  id: string,
  o: { visibility?: string; first_published_at?: string | null } = {},
): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo,
                           status, visibility, anonymous, first_published_at)
     VALUES (?, ?, ?, 0, ?, 'active', ?, 0, ?)`,
    [
      id,
      `A sufficiently descriptive title for ${id}`,
      ownerId,
      `nemarDatasets/${id}`,
      o.visibility ?? "public",
      o.first_published_at === undefined ? "2026-01-01 00:00:00" : o.first_published_at,
    ],
  );
}

function writeConfig(dir: string, account: string, key: string): void {
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ activeAccount: account, accounts: { [account]: { apiKey: key } } }),
  );
}

beforeEach(async () => {
  db = freshDb();
  standIn.reset();
  envOverrides = {};
  configDir = mkdtempSync(join(tmpdir(), "nemar-review-ruleset-cli-"));
  ownerId = await seedAccount("cliowner", "owner", OWNER_KEY);
  await seedAccount("cliadmin", "admin", ADMIN_KEY);
  writeConfig(configDir, "cliowner", OWNER_KEY);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function cli(
  args: string[],
  dir = configDir,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: dir,
    TEST_API_URL: `http://127.0.0.1:${apiServer.port}`,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(childEnv)) if (v !== undefined) clean[k] = v;
  const proc = spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, "admin", "fleet", "require-review", ...args],
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

const held = (repo: string) => (standIn.rulesets.get(repo) ?? []).map((r) => r.name);

describe("one dataset", () => {
  test("a dry run says what it would do, prints the body with its three bypass actors, and changes nothing", async () => {
    seedDataset("nm000201");

    const r = await cli(["nm000201"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[dry run] would create");
    expect(r.stdout).toContain("nm000201");
    expect(r.stdout).toContain("The body that would be sent to GitHub");
    expect(r.stdout).toContain('"actor_type": "Integration"');
    expect(r.stdout).toContain('"actor_type": "OrganizationAdmin"');
    expect(r.stdout).toContain('"actor_type": "RepositoryRole"');
    expect(r.stdout).toContain('"context": "NEMAR PR Review"');
    expect(r.stdout).toContain("Dry run: nothing was changed. Add --apply to change it.");
    expect(standIn.writes()).toHaveLength(0);
    expect(held("nm000201")).toEqual([]);
  });

  test("--apply puts the ruleset on the repository and says so", async () => {
    seedDataset("nm000201");

    const r = await cli(["nm000201", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("created");
    expect(r.stdout).toContain("Done.");
    expect(r.stdout).not.toContain("Dry run");
    expect(held("nm000201")).toEqual([REVIEW_RULESET]);
  });

  test("a dataset the review does not cover has the ruleset taken off, and the reason is said", async () => {
    seedDataset("nm000202", { visibility: "private" });
    // A ruleset left behind by a dataset that has since gone private.
    standIn.rulesets.set("nm000202", [
      {
        id: 4242,
        name: REVIEW_RULESET,
        source_type: "Repository",
        body: { name: REVIEW_RULESET, target: "branch", enforcement: "active", rules: [] },
      },
    ]);

    const r = await cli(["nm000202", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("removed");
    expect(r.stdout).toContain("not reviewed: private");
    expect(held("nm000202")).toEqual([]);
  });

  test("--json prints the Worker's answer and nothing else", async () => {
    seedDataset("nm000201");

    const r = await cli(["nm000201", "--json"]);

    expect(r.exitCode).toBe(0);
    const answer = JSON.parse(r.stdout);
    expect(answer).toMatchObject({
      dataset_id: "nm000201",
      dry_run: true,
      review_enabled: true,
      intent: "require",
      action: "create",
      applied: false,
    });
    expect(answer.payload.bypass_actors).toHaveLength(3);
  });

  test("--remove --apply is the rollback", async () => {
    seedDataset("nm000201");
    await cli(["nm000201", "--apply"]);
    expect(held("nm000201")).toEqual([REVIEW_RULESET]);

    const r = await cli(["nm000201", "--remove", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("removed");
    expect(held("nm000201")).toEqual([]);
  });

  test("with the review off, --apply is refused in the Worker's words and exits 1; --remove --apply is not", async () => {
    seedDataset("nm000201");
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    const refused = await cli(["nm000201", "--apply"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout + refused.stderr).toContain("PR_REVIEW_ENABLED");
    expect(standIn.writes()).toHaveLength(0);

    const dry = await cli(["nm000201"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("--apply would be refused");

    // Taking it off is not refused for that reason, even where there is nothing to take off.
    const off = await cli(["nm000201", "--remove", "--apply"]);
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toContain("nothing to remove");
  });

  test("with the review off a dataset the Worker does not review is not refused: it is a removal", async () => {
    seedDataset("nm000202", { visibility: "private" });
    standIn.rulesets.set("nm000202", [
      {
        id: 4244,
        name: REVIEW_RULESET,
        source_type: "Repository",
        body: { name: REVIEW_RULESET, target: "branch", enforcement: "active", rules: [] },
      },
    ]);
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    // The dry run does not say --apply would be refused, because it would not be.
    const dry = await cli(["nm000202"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("would remove");
    expect(dry.stdout).not.toContain("would be refused");

    const applied = await cli(["nm000202", "--apply"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("removed");
    expect(held("nm000202")).toEqual([]);
  });

  test("with --json a refusal goes to standard error and standard output stays empty", async () => {
    seedDataset("nm000201");
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    const r = await cli(["nm000201", "--apply", "--json"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("PR_REVIEW_ENABLED");
  });

  test("a standing fixture is refused and exits 1", async () => {
    seedDataset("nm099999");

    const r = await cli(["nm099999", "--apply"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("standing test fixture");
    expect(standIn.calls).toHaveLength(0);
  });

  test("a repository on another default branch is skipped, said so, and nothing is written", async () => {
    seedDataset("nm000201");
    standIn.defaultBranches.set("nm000201", "master");

    const r = await cli(["nm000201", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("skipped");
    expect(r.stdout).toContain("default branch is master, not main");
    expect(r.stdout).toContain("the default branch has to be main first");
    expect(standIn.rulesetWrites()).toHaveLength(0);

    // A dry run does not suggest that --apply would change it.
    const dry = await cli(["nm000201"]);
    expect(dry.stdout).toContain("would skip");
    expect(dry.stdout).toContain("the default branch has to be main first");
    expect(dry.stdout).not.toContain("Add --apply");
  });
});

describe("a page of datasets", () => {
  function seedFleet(): void {
    for (const id of ["nm000301", "nm000302", "nm000303", "nm000304", "nm000305"]) seedDataset(id);
    seedDataset("nm000306", { visibility: "private" });
    seedDataset("on000307");
  }

  test("a dry run lists each dataset, tallies them, and names the next page", async () => {
    seedFleet();

    const r = await cli(["--all", "--prefix", "nm", "--limit", "3"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[dry run] 3 dataset(s) (nm000301 to nm000303)");
    expect(r.stdout).toMatch(/would create\s+nm000301/);
    expect(r.stdout).toMatch(/would create\s+nm000303/);
    expect(r.stdout).toContain("3 would create");
    expect(r.stdout).toContain(
      "Next page: nemar admin fleet require-review --all --prefix nm --limit 3 --after nm000303",
    );
    expect(standIn.writes()).toHaveLength(0);
  });

  test("--apply works through the pages with --after, and the last page names no next one", async () => {
    seedFleet();

    const first = await cli(["--all", "--prefix", "nm", "--limit", "4", "--apply"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("4 created");
    expect(first.stdout).toContain("--after nm000304 --apply");
    expect(held("nm000304")).toEqual([REVIEW_RULESET]);
    expect(held("nm000305")).toEqual([]);

    const second = await cli([
      "--all",
      "--prefix",
      "nm",
      "--limit",
      "4",
      "--after",
      "nm000304",
      "--apply",
    ]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("1 created");
    expect(second.stdout).toMatch(/nothing to remove\s+nm000306/);
    expect(second.stdout).toContain("not reviewed: private");
    expect(second.stdout).not.toContain("Next page");
    expect(held("nm000305")).toEqual([REVIEW_RULESET]);
    expect(held("nm000306")).toEqual([]);
    // The other prefix was not asked about.
    expect(held("on000307")).toEqual([]);
  });

  test("the fixture band is not in a page", async () => {
    seedDataset("nm099899");
    seedDataset("nm099998");
    seedDataset("nm099999");

    const r = await cli(["--all", "--prefix", "nm", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm099899");
    expect(r.stdout).not.toContain("nm099998");
    expect(r.stdout).not.toContain("nm099999");
    expect(held("nm099998")).toEqual([]);
    expect(held("nm099999")).toEqual([]);
  });

  test("an administrator is refused, and says why", async () => {
    seedFleet();
    const adminDir = mkdtempSync(join(tmpdir(), "nemar-review-ruleset-cli-admin-"));
    try {
      writeConfig(adminDir, "cliadmin", ADMIN_KEY);

      const r = await cli(["--all", "--prefix", "nm"], adminDir);

      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("Only the NEMAR owner");
      expect(standIn.calls).toHaveLength(0);
    } finally {
      rmSync(adminDir, { recursive: true, force: true });
    }
  });

  test("a dataset that fails is an error row, the others are done, and the exit code is 1", async () => {
    seedFleet();
    standIn.failNext("GET", /\/repos\/nemarDatasets\/nm000302\/rulesets$/, 403);

    const r = await cli(["--all", "--prefix", "nm", "--limit", "3", "--apply"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/error\s+nm000302: Review ruleset list failed/);
    expect(held("nm000301")).toEqual([REVIEW_RULESET]);
    expect(held("nm000303")).toEqual([REVIEW_RULESET]);
    expect(held("nm000302")).toEqual([]);
  });

  test("--json prints the page as the Worker answered it", async () => {
    seedFleet();

    const r = await cli(["--all", "--prefix", "nm", "--limit", "2", "--json"]);

    expect(r.exitCode).toBe(0);
    const answer = JSON.parse(r.stdout);
    expect(answer).toMatchObject({ dry_run: true, limit: 2, count: 2, next_after: "nm000302" });
    expect(answer.results.map((x: { dataset_id: string }) => x.dataset_id)).toEqual([
      "nm000301",
      "nm000302",
    ]);
    expect(answer.payload.name).toBe(REVIEW_RULESET);
  });

  test("with the review off a live page refuses the datasets that would get the ruleset, row by row, and still takes it off the rest", async () => {
    seedFleet();
    // A ruleset left on the dataset that is now private.
    standIn.rulesets.set("nm000306", [
      {
        id: 4243,
        name: REVIEW_RULESET,
        source_type: "Repository",
        body: { name: REVIEW_RULESET, target: "branch", enforcement: "active", rules: [] },
      },
    ]);
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    const r = await cli(["--all", "--prefix", "nm", "--apply"]);

    // Five rows were refused, so the exit code says the run is not done.
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/error\s+nm000301: .*PR_REVIEW_ENABLED/);
    expect(r.stdout).toMatch(/error\s+nm000305: .*PR_REVIEW_ENABLED/);
    expect(r.stdout).toContain("5 error");
    // The private dataset is a removal, and the review being off did not stop it.
    expect(r.stdout).toMatch(/removed\s+nm000306/);
    expect(r.stdout).toContain("1 removed");
    expect(held("nm000306")).toEqual([]);
    for (const id of ["nm000301", "nm000302", "nm000303", "nm000304", "nm000305"]) {
      expect(held(id), id).toEqual([]);
      expect(
        standIn.calls.filter((c) => c.path.includes(`/repos/nemarDatasets/${id}`)),
        id,
      ).toHaveLength(0);
    }
  });

  test("with the review off a dry run warns only when something on the page would be refused", async () => {
    seedFleet();
    envOverrides = { PR_REVIEW_ENABLED: undefined };

    const mixed = await cli(["--all", "--prefix", "nm"]);
    expect(mixed.exitCode).toBe(0);
    expect(mixed.stdout).toContain(
      "--apply would refuse the 5 dataset(s) that would get the ruleset",
    );

    // Only a dataset the Worker does not review: it is all removals, and nothing would be refused.
    db.run("DELETE FROM datasets WHERE dataset_id != 'nm000306'");
    const removalsOnly = await cli(["--all", "--prefix", "nm"]);
    expect(removalsOnly.exitCode).toBe(0);
    expect(removalsOnly.stdout).not.toContain("would be refused");
    expect(removalsOnly.stdout).not.toContain("--apply would refuse");
  });
});

describe("what is asked for is checked before anything is sent", () => {
  test.each([
    [[], "Name a dataset, or use --all"],
    [["nm000201", "--all"], "Name a dataset OR use --all"],
    [["nm000201", "--prefix", "nm"], "go with --all"],
    [["nm000201", "--after", "nm000100"], "go with --all"],
    [["nm000201", "--limit", "5"], "go with --all"],
    [["--all", "--limit", "51"], "from 1 to 50"],
    [["--all", "--limit", "0"], "from 1 to 50"],
    [["--all", "--limit", "ten"], "from 1 to 50"],
    [["nm20"], "is not a dataset id"],
  ])("%j exits 1 and says %j", async (args, words) => {
    const r = await cli(args as string[]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain(words);
    expect(standIn.calls).toHaveLength(0);
  });

  test("the override the first design had is gone: --force-live is not an option", async () => {
    seedDataset("nm000103");

    const r = await cli(["nm000103", "--apply", "--force-live"]);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unknown option '--force-live'");
    expect(standIn.calls).toHaveLength(0);
  });

  test("a live dataset needs no override: nm000103 is an ordinary dataset", async () => {
    seedDataset("nm000103");

    const r = await cli(["nm000103", "--apply"]);

    expect(r.exitCode).toBe(0);
    expect(held("nm000103")).toEqual([REVIEW_RULESET]);
  });

  test("nobody signed in is told so and exits 1", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "nemar-review-ruleset-cli-empty-"));
    try {
      const r = await cli(["nm000201"], emptyDir);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("Not authenticated");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
