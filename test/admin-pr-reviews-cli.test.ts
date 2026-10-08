/**
 * `nemar admin pr-reviews` (ADR 0093, following ADR 0092), driven through the real entry point
 * (`bun run src/index.ts ...`) the way its sibling admin CLI suites are.
 *
 * The NEMAR API is the REAL admin and user routers over bun:sqlite with every migration applied,
 * served on a local port and reached through TEST_API_URL. GitHub is a `Bun.serve()` stand-in that
 * answers by who is asking, which is what lets this file say the thing that matters: the review
 * the administrator submits is made with THEIR token, and nothing the Worker holds ever approves.
 * Isolated NEMAR_CONFIG_DIR, no mocks.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server;
 * it touches no live backend and holds no secret, so it also passes offline.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { makePrQueueApp } from "../backend/test/helpers/pr-queue-app";
import {
  type PrSpec,
  SHA_A,
  SHA_B,
  bidsOk,
  prNode,
  seedReview,
  versionOk,
} from "../backend/test/helpers/pr-queue-fixtures";
import type { PrReviewDetail, QueueResponse } from "../shared/contract/pr-review-admin";
import {
  ADMIN_TOKEN,
  APP_TOKEN,
  type GitHubStandin,
  OTHER_TOKEN,
  WORKER_TOKEN,
  startGitHubStandin,
} from "./helpers/github-standin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ADMIN_KEY = "cli-queue-admin-key-0123456789abcdef0123456789abcdef";

let gh: GitHubStandin;
let apiServer: ReturnType<typeof Bun.serve>;
let db: Database;
let configDir: string;
let emptyPath: string;
let envOverrides: Partial<Bindings> = {};
/** Every request the NEMAR API received, `METHOD /path?query`. */
let apiRequests: string[] = [];
let handle: ReturnType<typeof makePrQueueApp>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: WORKER_TOKEN,
    PR_REVIEW_ENABLED: "1",
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
      apiRequests.push(`${req.method} ${url.pathname}${url.search}`);
      return handle(req, env());
    },
  });
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  apiServer.stop(true);
  gh.stop();
});

beforeEach(async () => {
  db = freshDb();
  envOverrides = {};
  apiRequests = [];
  gh.reset();
  configDir = mkdtempSync(join(tmpdir(), "nemar-pr-reviews-cli-"));
  emptyPath = mkdtempSync(join(tmpdir(), "nemar-no-gh-"));
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES ('queueadmin', 'queueadmin@example.org', 'x', 'queueadmin-gh', 'approved', 'admin',
             'cli', 1, 1)`,
  );
  const row = db.query("SELECT id FROM users WHERE username = 'queueadmin'").get() as {
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
      activeAccount: "queueadmin",
      accounts: { queueadmin: { apiKey: ADMIN_KEY } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(emptyPath, { recursive: true, force: true });
});

async function cli(
  args: string[],
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: `http://127.0.0.1:${apiServer.port}`,
    NEMAR_GITHUB_API_URL: gh.url,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    GH_TOKEN: ADMIN_TOKEN,
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
    ...opts.env,
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
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

const PR = ["admin", "pr-reviews"];
const nodes = (...specs: PrSpec[]) => {
  gh.searchPages = [specs.map(prNode)];
};
const seed = (r: Parameters<typeof seedReview>[1]) => seedReview(db, r);
const reviewPosts = () => gh.seen.filter((s) => s.method === "POST" && s.path.endsWith("/reviews"));
const mergePuts = () => gh.seen.filter((s) => s.method === "PUT" && s.path.endsWith("/merge"));

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

describe("nemar admin pr-reviews (list)", () => {
  function seedQueue() {
    nodes(
      { ds: "nm000201", n: 12, author: "alice", authorId: 42, branch: "fix-readme" },
      {
        ds: "nm000202",
        n: 3,
        author: "bob",
        authorId: 43,
        forkOwner: "bobfork",
        branch: "add-subjects",
        checks: [{ ...bidsOk("nm000202"), conclusion: "FAILURE" }, versionOk],
      },
      { ds: "nm000203", n: 4, author: "carol", authorId: 44 },
    );
    seed({
      ds: "nm000201",
      n: 12,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    seed({ ds: "nm000202", n: 3, authorId: 43, login: "bob", state: "reported", verdict: "fail" });
  }

  test("is the default: one line per pull request with everything an administrator asks first", async () => {
    seedQueue();
    const r = await cli(PR);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n");
    const row = (ds: string) => lines.find((l) => l.includes(ds)) ?? "";

    const pass = row("nm000201");
    expect(pass).toMatch(
      /^\* nm000201\s+#12\s+alice\s+branch fix-readme\s+pass\s+ok\s+ok\s+\d+d\s+https:\/\/github\.com\/nemarDatasets\/nm000201\/pull\/12$/,
    );
    const fail = row("nm000202");
    expect(fail).toMatch(
      /^ {2}nm000202\s+#3\s+bob\s+fork bobfork:add-subjects\s+fail\s+FAIL\s+ok\s+\d+d\s+https:\/\//,
    );
    expect(row("nm000203")).toMatch(
      /^\* nm000203\s+#4\s+carol\s+branch update-metadata\s+not reviewed\s+ok\s+ok/,
    );

    // What you can act on first: the pass, then the one nobody has decided for you, then the fail.
    expect(lines.findIndex((l) => l.includes("nm000201"))).toBeLessThan(
      lines.findIndex((l) => l.includes("nm000203")),
    );
    expect(lines.findIndex((l) => l.includes("nm000203"))).toBeLessThan(
      lines.findIndex((l) => l.includes("nm000202")),
    );
    expect(r.stdout).toContain("3 open pull requests, 2 you can act on.");
  });

  test("`list` and no subcommand are the same, and options pass through to the default", async () => {
    seedQueue();
    const bare = await cli([...PR, "--needs-me"]);
    const named = await cli([...PR, "list", "--needs-me"]);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toBe(named.stdout);
    expect(bare.stdout).not.toContain("nm000202"); // a fail is the author's to fix
    expect(bare.stdout).toContain("2 of 3 open pull requests");
  });

  test("filters by verdict, dataset and author, and sends them to the API", async () => {
    seedQueue();
    const byVerdict = await cli([...PR, "--verdict", "fail,not-reviewed"]);
    expect(byVerdict.stdout).toContain("nm000202");
    expect(byVerdict.stdout).toContain("nm000203");
    expect(byVerdict.stdout).not.toContain("nm000201");
    expect(
      apiRequests.some(
        (x) => x.includes("verdict=fail%2Cnot_reviewed") || x.includes("verdict=fail,not_reviewed"),
      ),
    ).toBe(true);

    const repeated = await cli([...PR, "--verdict", "pass", "--verdict", "fail"]);
    expect(repeated.stdout).toContain("nm000201");
    expect(repeated.stdout).toContain("nm000202");
    expect(repeated.stdout).not.toContain("nm000203");

    expect((await cli([...PR, "--dataset", "nm000203"])).stdout).not.toContain("nm000201");
    expect((await cli([...PR, "--author", "ALICE"])).stdout).not.toContain("nm000202");
    const none = await cli([...PR, "--author", "nobody"]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain("No pull requests match (3 open in all).");
  });

  test("a bad filter is refused before anything is asked of the API", async () => {
    for (const args of [
      ["--verdict", "great"],
      ["--dataset", "nm1"],
      ["--author", "-x-"],
    ]) {
      apiRequests = [];
      const r = await cli([...PR, ...args]);
      expect(r.exitCode).toBe(1);
      expect(apiRequests.filter((x) => x.includes("/admin/"))).toHaveLength(0);
    }
  });

  test("--json is the raw response and nothing else on stdout", async () => {
    seedQueue();
    const r = await cli([...PR, "--json"]);
    expect(r.exitCode).toBe(0);
    const q = JSON.parse(r.stdout) as QueueResponse;
    expect(q.entries.map((e) => e.dataset_id)).toEqual(["nm000201", "nm000203", "nm000202"]);
    expect(q.entries[0]).toMatchObject({ verdict: "pass", needs_you: true, bids: "pass" });
  });

  test("works while the review is off, and says so", async () => {
    seedQueue();
    envOverrides = { PR_REVIEW_ENABLED: undefined };
    const r = await cli(PR);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("The automated review is off in this environment");
  });

  test("says what is wrong when the search cannot be read", async () => {
    seedQueue();
    gh.searchPages = [];
    const empty = await cli(PR);
    expect(empty.stdout).toContain("No open pull requests to main.");
  });

  test("a hostile title, branch or login cannot put a control sequence on the terminal", async () => {
    const esc = String.fromCharCode(27);
    nodes({ ds: "nm000201", n: 1, branch: `x${esc}[2Jy`, title: `${esc}[31mred` });
    const r = await cli(PR);
    expect(r.stdout.includes(esc)).toBe(false);
  });

  test("a member is told it needs admin privileges", async () => {
    db.run("UPDATE users SET role = 'member', status = 'verified'");
    const r = await cli(PR);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("requires admin privileges");
  });
});

// ---------------------------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------------------------

function livePull(
  sha = SHA_A,
  over: Partial<{
    state: "open" | "closed";
    draft: boolean;
    base: string;
    merged: boolean;
    mergeableState: string;
  }> = {},
) {
  gh.pulls["nm000201#7"] = { sha, author: "alice", ...over };
}

describe("nemar admin pr-reviews show", () => {
  test("prints the stored report in the words of the pull-request comment", async () => {
    livePull();
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Passes: nothing lost, revision advances, materially better");
    expect(r.stdout).toContain("Adds two subjects and corrects the task description.");
    expect(r.stdout).toContain("| Dataset description | 0 | 1 | 0 |");
    expect(r.stdout).toContain("| Recordings and data files | 2 | 0 | 0 |");
    expect(r.stdout).toContain("Version 1.0.0 to 1.1.0.");
    expect(r.stdout).toContain("Changed files (1 of 3)");
    expect(r.stdout).toContain("changed `dataset_description.json`");
    expect(r.stdout).toContain("Reviewed with claude-haiku-5-5.");
    // HTML wrappers are for GitHub, not for a terminal.
    expect(r.stdout).not.toMatch(/<\/?(details|summary)>/);
    // The report keeps its layout: a table is one row per line, not one run-on line.
    expect(r.stdout).toMatch(/^\| Area \| Added \| Changed \| Removed \|$/m);
    expect(r.stdout).toMatch(/^\| --- \| ---: \| ---: \| ---: \|$/m);
    expect(r.stdout).toMatch(/^\| Dataset description \| 0 \| 1 \| 0 \|$/m);
    expect(r.stdout).toMatch(/^- changed `dataset_description.json`$/m);
    expect(r.stdout).toMatch(/^Changed files \(1 of 3\)$/m);
    // The author's record rides along.
    expect(r.stdout).toContain("0 of 1 decided pull request rejected (0%)");
  });

  test("says plainly when the review read an earlier commit", async () => {
    livePull(SHA_B);
    seed({
      ds: "nm000201",
      n: 7,
      sha: SHA_A,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.stdout).toContain("not reviewed (older commit)");
    expect(r.stdout).toContain("an EARLIER commit");
    expect(r.stdout).toContain("it does not apply to the current commit");
  });

  test("a failing review lists its findings", async () => {
    livePull();
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "fail",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.stdout).toContain("Needs changes");
    expect(r.stdout).toContain("Findings");
  });

  test("a pull request with no review is not reviewed, with the reason it can give", async () => {
    livePull();
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("not reviewed");
    expect(r.stdout).toContain("No automated review has been recorded");

    envOverrides = { PR_REVIEW_ENABLED: undefined };
    const off = await cli([...PR, "show", "nm000201", "7"]);
    expect(off.stdout).toContain("The automated review is off in this environment");
  });

  test("a declined review shows the reason in the comment's words", async () => {
    livePull();
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "declined",
      detail: "contributor_paused",
    });
    const r = await cli([...PR, "show", "nm000201", "7"]);
    expect(r.stdout).toContain("Not reviewed");
    expect(r.stdout).toContain("Automated review is paused for this contributor");
  });

  test("--json is the raw detail", async () => {
    livePull();
    seed({
      ds: "nm000201",
      n: 7,
      authorId: 42,
      login: "alice",
      state: "reported",
      verdict: "pass",
    });
    const r = await cli([...PR, "show", "nm000201", "7", "--json"]);
    const d = JSON.parse(r.stdout) as PrReviewDetail;
    expect(d).toMatchObject({
      dataset_id: "nm000201",
      pr_number: 7,
      verdict: "pass",
      review_current: true,
    });
  });

  test("refuses ids that are not a dataset and a number, and reports a pull request that does not exist", async () => {
    expect((await cli([...PR, "show", "nm1", "7"])).exitCode).toBe(1);
    expect((await cli([...PR, "show", "nm000201", "seven"])).exitCode).toBe(1);
    const missing = await cli([...PR, "show", "nm000201", "99"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout + missing.stderr).toContain("has no pull request #99");
  });
});

// ---------------------------------------------------------------------------------------------
// allow / block / clear / standing
// ---------------------------------------------------------------------------------------------

describe("who is reviewed", () => {
  function seedRecord(rejected: number, passed: number) {
    let n = 100;
    for (let i = 0; i < rejected; i++) {
      seed({
        ds: "nm000301",
        n: n++,
        authorId: 77,
        login: "alice",
        state: "reported",
        verdict: "fail",
      });
    }
    for (let i = 0; i < passed; i++) {
      seed({
        ds: "nm000301",
        n: n++,
        authorId: 77,
        login: "alice",
        state: "reported",
        verdict: "pass",
      });
    }
  }

  test("standing shows the record, the rule, and what it means", async () => {
    gh.users.alice = { id: 77, login: "alice", type: "User" };
    seedRecord(6, 4);
    const r = await cli([...PR, "standing", "alice"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("6 of 10 decided pull requests rejected (60%)");
    expect(r.stdout).toContain("MORE than 5 are rejected AND more than 10%");
    expect(r.stdout).toContain("paused by the record");
    expect(r.stdout).toContain("Decision:  none, the record decides");
  });

  test("allow lifts a pause, says that the record alone would pause them, and clear hands it back", async () => {
    gh.users.alice = { id: 77, login: "alice", type: "User" };
    seedRecord(6, 4);
    const allow = await cli([...PR, "allow", "alice", "--reason", "Vetted by hand"]);
    expect(allow.exitCode).toBe(0);
    expect(allow.stdout).toContain("Allowed alice");
    expect(allow.stdout).toContain("reviewed automatically");
    expect(allow.stdout).toContain("the record alone would pause them; the decision wins");
    expect(allow.stdout).toContain("by queueadmin");
    expect(allow.stdout).toContain("Vetted by hand");
    expect(db.query("SELECT mode, set_by FROM pr_review_overrides").get()).toMatchObject({
      mode: "allow",
    });

    const clear = await cli([...PR, "clear", "alice"]);
    expect(clear.stdout).toContain("Removed the allow for alice");
    expect(clear.stdout).toContain("paused by the record");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });

    const again = await cli([...PR, "clear", "alice"]);
    expect(again.stdout).toContain("had no allow or block");
  });

  test("block pauses a contributor the record would not", async () => {
    gh.users.dave = { id: 88, login: "dave", type: "User" };
    const r = await cli([...PR, "block", "@dave", "--reason", "Spam"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Blocked dave");
    expect(r.stdout).toContain("paused by a maintainer");
    expect(db.query("SELECT mode, author_id FROM pr_review_overrides").get()).toEqual({
      mode: "block",
      author_id: 88,
    });
  });

  test("a login GitHub does not know, and a malformed one, are refused", async () => {
    const unknown = await cli([...PR, "block", "nobody"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stdout + unknown.stderr).toContain("GitHub has no user called nobody");
    expect((await cli([...PR, "allow", "-bad-"])).exitCode).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });

  test("--json on each is the raw response", async () => {
    gh.users.alice = { id: 77, login: "alice", type: "User" };
    const set = JSON.parse((await cli([...PR, "block", "alice", "--json"])).stdout);
    expect(set).toMatchObject({
      previous: null,
      standing: { author_id: 77, standing: { paused: true } },
    });
    const st = JSON.parse((await cli([...PR, "standing", "alice", "--json"])).stdout);
    expect(st.override.mode).toBe("block");
    const cleared = JSON.parse((await cli([...PR, "clear", "alice", "--json"])).stdout);
    expect(cleared.removed).toBe("block");
  });

  test("on the non-production Worker it says it changes nothing in production", async () => {
    envOverrides = { ENVIRONMENT: "staging" };
    gh.users.alice = { id: 77, login: "alice", type: "User" };
    const r = await cli([...PR, "allow", "alice"]);
    expect(r.stdout).toContain("non-production Worker");
    expect(r.stdout).toContain("does not change what production reviews");
  });
});

// ---------------------------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------------------------

describe("nemar admin pr-reviews approve", () => {
  function reviewed(verdict: "pass" | "fail" | "uncertain" = "pass", sha = SHA_A) {
    livePull(SHA_A);
    seed({ ds: "nm000201", n: 7, sha, authorId: 42, login: "alice", state: "reported", verdict });
  }
  const approve = (extra: string[] = [], opts: Parameters<typeof cli>[1] = {}) =>
    cli([...PR, "approve", "nm000201", "7", "--yes", ...extra], opts);

  test("approves as the administrator's own login, on the commit shown, and does not merge", async () => {
    reviewed("pass");
    const r = await approve();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Approve nm000201 #7");
    expect(r.stdout).toContain("Commit:   aaaaaaa");
    expect(r.stdout).toContain("You are:  @queueadmin-gh (linked to your NEMAR account)");
    expect(r.stdout).toContain("Approved nm000201 #7 at aaaaaaa as @queueadmin-gh.");
    expect(r.stdout).toContain("It is not merged.");

    expect(reviewPosts()).toHaveLength(1);
    expect(reviewPosts()[0].token).toBe(ADMIN_TOKEN);
    expect(reviewPosts()[0].body).toMatchObject({ commit_id: SHA_A, event: "APPROVE" });
    expect(mergePuts()).toHaveLength(0);
    // The NEMAR Worker's own token wrote nothing to the pull request.
    expect(
      gh.seen.filter(
        (s) => s.token === WORKER_TOKEN && s.method !== "GET" && s.path !== "/graphql",
      ),
    ).toHaveLength(0);
  });

  test("uses the administrator's message when given one", async () => {
    reviewed("pass");
    await approve(["--message", "Checked the participants table by hand."]);
    expect((reviewPosts()[0].body as { body: string }).body).toBe(
      "Checked the participants table by hand.",
    );
  });

  test("without --yes and without a terminal, nothing is approved", async () => {
    reviewed("pass");
    const r = await cli([...PR, "approve", "nm000201", "7"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("use --yes or --no");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("--dry-run does every check and approves nothing", async () => {
    reviewed("pass");
    const r = await cli([...PR, "approve", "nm000201", "7", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Dry run: nothing was approved.");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("an app token is not accepted as a person, and the way to do it by hand is printed", async () => {
    reviewed("pass");
    const r = await approve([], { env: { GH_TOKEN: APP_TOKEN } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("app or workflow token cannot approve for you");
    expect(r.stdout).toContain("https://github.com/nemarDatasets/nm000201/pull/7");
    expect(r.stdout).toContain("gh pr review 7 --repo nemarDatasets/nm000201 --approve");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("another person's login than the one linked to the NEMAR account is refused", async () => {
    reviewed("pass");
    const r = await approve([], { env: { GH_TOKEN: OTHER_TOKEN } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      "gh is signed in as @someone-else, but your NEMAR account is linked to @queueadmin-gh",
    );
    expect(r.stdout).toContain("gh auth switch");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("an account that names no GitHub login is shown the login being used, and cannot be checked", async () => {
    reviewed("pass");
    db.run("UPDATE users SET github_username = NULL");
    const r = await approve();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "your NEMAR account names no GitHub login, so this cannot be checked",
    );
    expect(reviewPosts()).toHaveLength(1);
  });

  test("with no token at all, it opens nothing and says how to do it as yourself", async () => {
    reviewed("pass");
    const r = await approve([], { env: { GH_TOKEN: undefined, PATH: emptyPath } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Cannot approve from here: The GitHub CLI (gh) is not installed.");
    expect(r.stdout).toContain("https://github.com/nemarDatasets/nm000201/pull/7");
    expect(r.stdout).toContain("gh pr review 7 --repo nemarDatasets/nm000201 --approve");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("a failing review needs --force, and says to read it first", async () => {
    reviewed("fail");
    const refused = await approve();
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("The automated review says this pull request needs changes");
    expect(refused.stdout).toContain("--force");
    expect(reviewPosts()).toHaveLength(0);

    const forced = await approve(["--force"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("Approving anyway (--force).");
    expect(reviewPosts()).toHaveLength(1);
  });

  test("a review still running needs --force too", async () => {
    livePull();
    seed({ ds: "nm000201", n: 7, authorId: 42, login: "alice", state: "dispatched" });
    const refused = await approve();
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("still running");
    expect(reviewPosts()).toHaveLength(0);
  });

  test("an uncertain review, a missing one and a stale one each say so before they are approved", async () => {
    reviewed("uncertain");
    const uncertain = await approve();
    expect(uncertain.exitCode).toBe(0);
    expect(uncertain.stdout).toContain("could not decide whether this is a good change");

    gh.reset();
    db.run("DELETE FROM pr_reviews");
    livePull();
    const missing = await approve();
    expect(missing.stdout).toContain("has not read this commit");

    gh.reset();
    db.run("DELETE FROM pr_reviews");
    reviewed("pass", SHA_B); // reviewed an earlier commit; the pull request is now at SHA_A
    const stale = await approve();
    expect(stale.exitCode).toBe(0);
    expect(stale.stdout).toContain("read an earlier commit of this pull request (it said: pass)");
    expect(stale.stdout).toContain("not reviewed (older commit)");
    // The approval is on the commit the administrator was shown, not the one that was reviewed.
    expect(reviewPosts().pop()?.body).toMatchObject({ commit_id: SHA_A });
  });

  test("the non-production Worker, which cannot see a production review, does not stop an approval", async () => {
    reviewed("pass");
    envOverrides = { ENVIRONMENT: "staging" };
    const r = await approve();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("The NEMAR API has no review to show");
    expect(r.stdout).toContain("has not read this commit");
    expect(reviewPosts()).toHaveLength(1);
  });

  test("a closed, merged, draft or non-main pull request is refused", async () => {
    for (const [over, words] of [
      [{ state: "closed" as const }, "closed"],
      [{ merged: true, state: "closed" as const }, "already merged"],
      [{ draft: true }, "draft"],
      [{ base: "dev" }, "not main"],
    ] as const) {
      gh.reset();
      livePull(SHA_A, over);
      const r = await approve();
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain(words);
      expect(reviewPosts()).toHaveLength(0);
    }
  });

  test("GitHub refusing the approval is reported and nothing is merged", async () => {
    reviewed("pass");
    gh.reviewStatus = 422;
    const r = await approve(["--merge"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not approved: Can not approve your own pull request");
    expect(mergePuts()).toHaveLength(0);
  });

  describe("merging", () => {
    test("happens only with --merge, only on the approved commit, and with the chosen method", async () => {
      reviewed("pass");
      const r = await approve(["--merge", "--method", "squash"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Merged nm000201 #7 (squash).");
      expect(mergePuts()).toHaveLength(1);
      expect(mergePuts()[0].token).toBe(ADMIN_TOKEN);
      expect(mergePuts()[0].body).toEqual({ sha: SHA_A, merge_method: "squash" });
    });

    test("is never done around the ruleset: a blocked pull request stays approved and unmerged", async () => {
      reviewed("pass");
      gh.pulls["nm000201#7"].mergeableState = "blocked";
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Approved nm000201 #7");
      expect(r.stdout).toContain("a required check or review is not satisfied");
      expect(r.stdout).toContain("The approval stands.");
      expect(mergePuts()).toHaveLength(0);
    });

    test("is skipped when the branch moved after the approval", async () => {
      reviewed("pass");
      gh.pulls["nm000201#7"].movesToAfterReview = SHA_B;
      const r = await approve(["--merge"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("changed after it was approved");
      expect(mergePuts()).toHaveLength(0);
    });

    test("an unknown merge method is refused before anything is sent to GitHub", async () => {
      reviewed("pass");
      const r = await approve(["--merge", "--method", "fast-forward"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("is not a merge method");
      expect(gh.seen.filter((s) => s.token === ADMIN_TOKEN)).toHaveLength(0);
    });
  });
});
