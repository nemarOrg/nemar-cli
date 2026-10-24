/**
 * `nemar admin repull plan <id>` (ADR 0111, epic #1046 phase 5, #1911), driven through the real
 * entry point (`bun run src/index.ts admin repull plan ...`) as a subprocess.
 *
 * The NEMAR API is the REAL datasets router over bun:sqlite with every migration applied, served on
 * a local port and reached through TEST_API_URL; the dataset row and its version rows are seeded in
 * SQLite, and the command reads them with its own `fetch()`. GitHub is the `Bun.serve()` stand-in
 * (`test/helpers/github-standin.ts`), the only place the open pull requests can come from. The
 * dataset and its upstream are the real repositories of `test/helpers/repull-fixture.ts`, reached
 * through the planner's absolute-path test bases. No mocks.
 *
 * What is pinned: the exit codes (0 executable, 3 planned but not executable, 1 nothing planned),
 * the plan file's mode and digest, that the default output names no path, and every preflight
 * refusal. And that the run changes nothing: the SQLite tables, the origins' refs and the
 * stand-in's write count are the same before and after.
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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { makeRepullApp } from "../backend/test/helpers/repull-app";
import { readPlanFile } from "../src/lib/repull/digest";
import {
  ADMIN_TOKEN,
  type GitHubStandin,
  WORKER_TOKEN,
  startGitHubStandin,
} from "./helpers/github-standin";
import {
  CONCEPT_DOI,
  NEMAR_ID,
  type RepullFixture,
  TAG_A,
  TAG_B,
  TAG_LEGACY,
  UPSTREAM_ID,
  buildRepullFixture,
  refsOf,
} from "./helpers/repull-fixture";

setDefaultTimeout(240_000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ADMIN_KEY = "cli-repull-admin-key-0123456789abcdef0123456789abcdef";

let gh: GitHubStandin;
let apiServer: ReturnType<typeof Bun.serve>;
let db: Database;
let configDir: string;
let scratch: string;
let fx: RepullFixture;
const handle = makeRepullApp();

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: WORKER_TOKEN,
    API_BASE_URL: "https://api.test.nemar.org",
  } as Bindings;
}

beforeAll(async () => {
  gh = startGitHubStandin();
  // The versions route reads the description through GitHub; the stand-in answers it 404.
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = gh.url;
  apiServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (url.pathname === "/datasets/facets") return Response.json({});
      return handle(req, env());
    },
  });
  fx = await buildRepullFixture();
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  apiServer.stop(true);
  gh.stop();
  fx?.cleanup();
});

type VersionRow = { version: string; source_version: string | null; basis: string | null };

function seed(opts: { source?: string; versions?: VersionRow[] } = {}): void {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
  );
  db.run(
    `INSERT INTO datasets
       (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo,
        first_published_at, source, source_id, concept_doi)
     VALUES (?, 'A sufficiently descriptive fixture title', 1, 'active', 'public', 0, ?,
             '2026-01-01 00:00:00', ?, ?, ?)`,
    [NEMAR_ID, `nemarDatasets/${NEMAR_ID}`, opts.source ?? "openneuro", UPSTREAM_ID, CONCEPT_DOI],
  );
  const versions = opts.versions ?? [{ version: "1.0.0", source_version: TAG_A, basis: "doi" }];
  versions.forEach((v, i) => {
    db.run(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
       VALUES (?, ?, ?, 'ezid', ?, ?, ?)`,
      [
        NEMAR_ID,
        v.version,
        `10.82901/nemar.${NEMAR_ID}.v${v.version}`,
        `2026-0${i + 1}-01 00:00:00`,
        v.source_version,
        v.basis,
      ],
    );
  });
}

beforeEach(async () => {
  db = freshDb();
  gh.reset();
  configDir = mkdtempSync(join(tmpdir(), "nemar-repull-cli-"));
  scratch = join(configDir, "tmp");
  mkdirSync(scratch, { recursive: true });
  db.run(
    `INSERT INTO users (id, username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES (2, 'repulladmin', 'repulladmin@example.org', 'x', 'repulladmin-gh', 'approved', 'admin',
             'cli', 1, 1)`,
  );
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    2,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "repulladmin",
      accounts: { repulladmin: { apiKey: ADMIN_KEY } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...fx.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: `http://127.0.0.1:${apiServer.port}`,
    NEMAR_GITHUB_API_URL: gh.url,
    GH_TOKEN: ADMIN_TOKEN,
    TMPDIR: scratch,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "repull", "plan", NEMAR_ID, ...args],
    cwd: REPO_ROOT,
    env: childEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** Every table's rows, for the "nothing changed" check. */
function dump(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const rows = db.query(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    // The auth middleware stamps a token's last use on every authenticated request; that is the
    // API's bookkeeping for any read, not a write the plan makes.
    out[name] = name === "tokens" ? rows.map(({ last_used_at: _t, ...r }) => r) : rows;
  }
  return out;
}

function planFiles(): string[] {
  const dir = join(configDir, "repull", NEMAR_ID);
  try {
    return readdirSync(dir).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

describe("an executable plan", () => {
  test("exits 0, writes the plan with mode 0600 under its digest, and prints no path", async () => {
    seed();
    const before = {
      db: dump(),
      origin: await refsOf(fx.originRepo),
      upstream: await refsOf(fx.upstreamRepo),
    };
    const r = await cli([]);
    expect(r.stderr).not.toContain("Error");
    expect(r.exitCode).toBe(0);
    const files = planFiles();
    expect(files).toHaveLength(1);
    const path = files[0] as string;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(configDir, "repull", NEMAR_ID)).mode & 0o777).toBe(0o700);
    const read = readPlanFile(readFileSync(path, "utf8"));
    expect(read.file.digest).toBe(read.digest);
    expect(path.endsWith(`${TAG_B}.${read.digest.slice(7, 15)}.json`)).toBe(true);
    expect(read.file.executable).toBe(true);
    expect(r.stdout).toContain(`Digest: ${read.digest}`);
    expect(r.stdout).toContain(`${UPSTREAM_ID} ${TAG_A} -> ${TAG_B}`);
    expect(r.stdout).not.toContain("sub-01");
    expect(r.stdout).not.toContain("SHA256E-");
    expect((read.file.preflight as Array<{ status: string }>).every((c) => c.status === "ok")).toBe(
      true,
    );
    // Nothing was written anywhere: not the API, not GitHub, not either repository.
    expect(dump()).toEqual(before.db);
    expect(await refsOf(fx.originRepo)).toBe(before.origin);
    expect(await refsOf(fx.upstreamRepo)).toBe(before.upstream);
    expect(gh.seen.filter((s) => s.method !== "GET")).toEqual([]);
    expect(gh.seen.filter((s) => s.path === `/repos/nemarDatasets/${NEMAR_ID}/pulls`)).toHaveLength(
      1,
    );
    // The scratch clones are gone.
    expect(readdirSync(scratch).filter((f) => f.startsWith("nemar-repull-"))).toEqual([]);
  });

  test("--json prints the plan itself, --counts Markdown with no path or key", async () => {
    seed();
    const j = await cli(["--json"]);
    expect(j.exitCode).toBe(0);
    const plan = JSON.parse(j.stdout);
    expect(plan.schema).toBe("nemar.repull-plan");
    expect(plan.upstream.to_tag).toBe(TAG_B);
    const c = await cli(["--counts", "--out", join(configDir, "plan.json")]);
    expect(c.exitCode).toBe(0);
    expect(c.stdout).toContain("| delta paths |");
    expect(c.stdout).not.toContain("sub-0");
    expect(c.stdout).not.toContain("SHA256E-");
    expect(statSync(join(configDir, "plan.json")).mode & 0o777).toBe(0o600);
  });
});

describe("preflight refusals", () => {
  async function refused(args: string[], code: string, exit: number) {
    const r = await cli(args);
    expect(`${r.stdout}${r.stderr}`).toContain(code);
    expect(r.exitCode).toBe(exit);
    return r;
  }

  test("a dataset whose row is not an OpenNeuro mirror plans nothing", async () => {
    seed({ source: "nemar" });
    await refused([], "not-a-mirror", 1);
    expect(planFiles()).toEqual([]);
  });

  test("a mirrored tag recorded unknown plans nothing without --from-tag", async () => {
    seed({ versions: [{ version: "1.0.0", source_version: null, basis: "unknown" }] });
    await refused([], "from-tag-unknown", 1);
  });

  test("--from-tag on a mirror recorded unknown is a dry run only (exit 3)", async () => {
    seed({ versions: [{ version: "1.0.0", source_version: null, basis: "unknown" }] });
    await refused(["--from-tag", TAG_A], "from-tag-not-recorded", 3);
    expect(planFiles()).toHaveLength(1);
  });

  test("--from-tag that disagrees with the recorded tag refuses", async () => {
    seed();
    await refused(["--from-tag", TAG_LEGACY], "from-tag-disagrees", 1);
  });

  test("a dataset with no version row was never released", async () => {
    seed({ versions: [] });
    await refused([], "never-released", 1);
  });

  test("a tag not on the GitHub mirror is mirror lag", async () => {
    seed();
    await refused(["--to-tag", "9.9.9"], "mirror-lag", 1);
  });

  test("the mirrored tag itself is nothing to pull, and an older one is not newer", async () => {
    seed();
    await refused(["--to-tag", TAG_A], "nothing-to-pull", 1);
    await refused(["--to-tag", TAG_LEGACY], "not-newer", 1);
  });

  test("version rows that disagree with the tags and main refuse (exit 3)", async () => {
    seed({
      versions: [
        { version: "1.0.0", source_version: TAG_A, basis: "doi" },
        { version: "1.0.1", source_version: TAG_A, basis: "doi" },
      ],
    });
    await refused([], "versions-disagree", 3);
  });

  test("an open release pull request refuses (exit 3)", async () => {
    seed();
    gh.pulls[`${NEMAR_ID}#7`] = { sha: "a".repeat(40), headRef: "release/v2.0.0" };
    await refused([], "release-pr-open", 3);
  });

  test("a GitHub error leaves release-pr unchecked, which is not executable (exit 3)", async () => {
    seed();
    gh.pullsListStatus = 500;
    await refused([], "github-error", 3);
  });

  test("a bucket marker that is not nemar-s3's UUID refuses and names both (exit 3)", async () => {
    seed();
    const marker = join(fx.bucketBase, NEMAR_ID, "objects", "annex-uuid");
    const other = "00000000-0000-4000-8000-000000000000";
    writeFileSync(marker, other);
    try {
      const r = await refused([], "annex-uuid-mismatch", 3);
      expect(r.stdout).toContain(other);
      expect(r.stdout).toContain(fx.nemarUuid);
      rmSync(marker);
      await refused([], "marker-absent", 3);
    } finally {
      writeFileSync(marker, fx.nemarUuid);
    }
  });
});
