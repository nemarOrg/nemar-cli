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
 * the plan file's mode and digest, that the default output names no path and no content, the
 * options and their usage errors, the scratch directory's removal on SIGINT, the `xx` mapping
 * through the row's `source_id`, and every preflight refusal the command can reach. And that the
 * run changes nothing: the SQLite tables, the origins' refs and the stand-in's write count are
 * the same before and after.
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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
/** Answer the versions route 404, as a backend without it does. */
let versions404 = false;

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
      if (versions404 && /^\/datasets\/[^/]+\/versions$/.test(url.pathname)) {
        return Response.json({ error: "Not Found" }, { status: 404 });
      }
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

function seed(
  opts: { source?: string; sourceId?: string | null; id?: string; versions?: VersionRow[] } = {},
): void {
  const id = opts.id ?? NEMAR_ID;
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
    [
      id,
      `nemarDatasets/${id}`,
      opts.source ?? "openneuro",
      opts.sourceId === undefined ? UPSTREAM_ID : opts.sourceId,
      CONCEPT_DOI,
    ],
  );
  const versions = opts.versions ?? [{ version: "1.0.0", source_version: TAG_A, basis: "doi" }];
  versions.forEach((v, i) => {
    db.run(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
       VALUES (?, ?, ?, 'ezid', ?, ?, ?)`,
      [
        id,
        v.version,
        `10.82901/nemar.${id}.v${v.version}`,
        `2026-0${i + 1}-01 00:00:00`,
        v.source_version,
        v.basis,
      ],
    );
  });
}

async function setUpAdmin(): Promise<void> {
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
}

beforeEach(async () => {
  db = freshDb();
  gh.reset();
  versions404 = false;
  configDir = mkdtempSync(join(tmpdir(), "nemar-repull-cli-"));
  scratch = join(configDir, "tmp");
  mkdirSync(scratch, { recursive: true });
  await setUpAdmin();
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

type CliOptions = { id?: string; env?: Record<string, string | undefined> };

function childEnvOf(opts: CliOptions): Record<string, string | undefined> {
  return {
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
    ...opts.env,
  };
}

function start(args: string[], opts: CliOptions = {}) {
  return spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "repull", "plan", opts.id ?? NEMAR_ID, ...args],
    cwd: REPO_ROOT,
    env: childEnvOf(opts),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function cli(
  args: string[],
  opts: CliOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = start(args, opts);
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
    // No path, no key, and no file content: not the participants table, not the description.
    for (const word of [
      "sub-01",
      "SHA256E-",
      "participants",
      "dataset_description.json",
      "Repull fixture",
      "HowToAcknowledge",
      "fixture-pipeline",
    ]) {
      expect(`${r.stdout}${r.stderr}`).not.toContain(word);
    }
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

describe("options and usage errors", () => {
  test("--json on a plan that was not made prints the reason as JSON and exits 1", async () => {
    seed();
    const r = await cli(["--to-tag", "9.9.9", "--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ planned: false, reason: "mirror-lag" });
  });

  test("--json with --counts, a --max-fetch-gb that is not a number, and an id that is not one", async () => {
    seed();
    const both = await cli(["--json", "--counts"]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("--json and --counts");
    const gb = await cli(["--max-fetch-gb", "abc"]);
    expect(gb.exitCode).toBe(1);
    expect(`${gb.stdout}${gb.stderr}`).toContain("--max-fetch-gb");
    const negative = await cli(["--max-fetch-gb", "-1"]);
    expect(negative.exitCode).toBe(1);
    const id = await cli([], { id: "NOTANID" });
    expect(id.exitCode).toBe(1);
    expect(`${id.stdout}${id.stderr}`).toContain("is not a dataset id");
    expect(planFiles()).toEqual([]);
  });

  test("--keep-workdir keeps the scratch clones and says where", async () => {
    seed();
    const r = await cli(["--keep-workdir"]);
    expect(r.exitCode).toBe(0);
    const m = /Scratch clones kept at (\S+)/.exec(r.stdout);
    expect(m).not.toBeNull();
    const dir = (m as RegExpExecArray)[1] as string;
    expect(existsSync(join(dir, "nemar.git"))).toBe(true);
    expect(existsSync(join(dir, "upstream.git"))).toBe(true);
    Bun.spawnSync(["chmod", "-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("--bucket-listing reads presence from the bucket", async () => {
    seed();
    const r = await cli(["--bucket-listing", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).copy.presence_basis).toBe("bucket-listing");
  });

  test("without a GitHub token, release-pr is unchecked and the plan is not executable", async () => {
    seed();
    // `gh auth token` answers that nobody is signed in, as it does on a machine without a login.
    const bin = join(configDir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'not logged in to any hosts' >&2\nexit 1\n");
    chmodSync(join(bin, "gh"), 0o755);
    const r = await cli([], { env: { GH_TOKEN: undefined, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.stdout).toContain("No GitHub token");
    expect(r.stdout).toContain("no-token");
    expect(r.exitCode).toBe(3);
    expect(gh.seen.filter((x) => x.path.endsWith("/pulls"))).toEqual([]);
  });

  test("a versions route that answers 404 leaves the rows unknown, not empty", async () => {
    seed();
    versions404 = true;
    const r = await cli(["--json"]);
    expect(r.exitCode).toBe(3);
    const plan = JSON.parse(r.stdout);
    expect(plan.upstream.from_tag_source).toBe("tagged-description");
    expect(plan.preflight.find((c: { name: string }) => c.name === "version")).toMatchObject({
      status: "unchecked",
      code: "rows-unavailable",
    });
  });

  test("SIGINT during a plan removes the scratch directory", async () => {
    seed();
    const proc = start([]);
    const deadline = Date.now() + 60_000;
    while (!readdirSync(scratch).some((f) => f.startsWith("nemar-repull-"))) {
      if (Date.now() > deadline) throw new Error("the plan never made its scratch directory");
      await Bun.sleep(5);
    }
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(130);
    // A git child the plan started can outlive it by a moment; the directory must go.
    const settle = Date.now() + 5_000;
    while (readdirSync(scratch).some((f) => f.startsWith("nemar-repull-")) && Date.now() < settle) {
      await Bun.sleep(50);
    }
    expect(readdirSync(scratch).filter((f) => f.startsWith("nemar-repull-"))).toEqual([]);
    expect(planFiles()).toEqual([]);
  });
});

describe("which upstream dataset a mirror names", () => {
  test("an on id whose row names another ds refuses", async () => {
    seed({ sourceId: "ds000001" });
    const r = await cli([]);
    expect(`${r.stdout}${r.stderr}`).toContain("source-disagrees");
    expect(r.exitCode).toBe(1);
  });

  test("an xx id maps through its row's source_id, and with none it plans nothing", async () => {
    const xx = "xx099999";
    // The same repository under the xx id, so the planner reads it at `<origin base>/xx099999`.
    const link = join(fx.originBase, xx);
    if (!existsSync(link)) symlinkSync(join(fx.originBase, NEMAR_ID), link);
    try {
      seed({ id: xx });
      const mapped = await cli(["--json"], { id: xx });
      expect(mapped.exitCode).toBe(0);
      expect(JSON.parse(mapped.stdout).upstream.ds).toBe(UPSTREAM_ID);
      db = freshDb();
      await setUpAdmin();
      seed({ id: xx, sourceId: null });
      const none = await cli([], { id: xx });
      expect(`${none.stdout}${none.stderr}`).toContain("no-source-id");
      expect(none.exitCode).toBe(1);
    } finally {
      rmSync(link, { force: true });
    }
  });
});
