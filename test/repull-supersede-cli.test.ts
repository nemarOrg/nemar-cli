/**
 * `nemar admin repull execute --supersede` (ADR 0111, decision 3; epic #1046 phase 6, #1912),
 * driven through the real entry point against `repull-pr-world.ts`: a re-pull to tag B (1.1.0) is
 * open at `pr_open` when upstream makes tag C (1.2.0). The real `plan` and `execute` commands, the
 * real API over bun:sqlite through TEST_API_URL in the child's environment; stand-ins for GitHub,
 * OpenNeuro and S3 only. No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - without the flag, a plan for tag C refuses `repull-in-flight` and changes nothing;
 *  - with it, tag B's pull request is closed, its branch deleted and its record ends `superseded`,
 *    and the tag C record is created, from the same `from_tag`;
 *  - the tag C plan is proved and made again from live sources BEFORE tag B's record is touched: a
 *    plan that went stale supersedes nothing;
 *  - only the record's own release branch and pull request are tolerated in the new plan's
 *    preflight: another release pull request keeps it not executable;
 *  - an automatic record is never superseded.
 *
 * What only the first production runs can check: that a second release pull request of the same
 * branch name opens on GitHub after the first was closed and its branch deleted, as the stand-in
 * opens it.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import { runCommand } from "../src/lib/git-annex/run-command";
import { defaultPlanPath } from "../src/lib/repull/digest";
import { TAG_A, TAG_B, UPSTREAM_SNAPSHOTS, gitIn } from "./helpers/repull-fixture";
import { type RepullWorld, prKey, startRepullWorld } from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);
const TAG_C = "1.2.0";

let w: RepullWorld;

beforeAll(async () => {
  if (awsInstalled) w = await startRepullWorld();
});
afterAll(() => w?.stop());
beforeEach(async () => {
  if (!awsInstalled) return;
  await w.restore();
  w.openNeuro.latest = TAG_B;
  w.openNeuro.snapshots = UPSTREAM_SNAPSHOTS.map((s) => ({ ...s }));
});

const hasRef = async (ref: string) =>
  (await gitIn(w.fx.originRepo, ["for-each-ref", "--format=%(refname)", ref])).trim() !== "";
const rows = () =>
  w
    .db()
    .query("SELECT id, status, to_tag, from_tag, attempt FROM upstream_repulls ORDER BY id")
    .all() as Array<{
    id: number;
    status: string;
    to_tag: string;
    from_tag: string;
    attempt: number;
  }>;

/** Upstream makes tag C on top of tag B (one file more), and OpenNeuro names it its latest. */
async function makeTagC(content = "A third snapshot.\n"): Promise<string> {
  const repo = w.fx.upstreamRepo;
  const dir = mkdtempSync(join(tmpdir(), "nemar-repull-tag-c-"));
  const env = {
    GIT_INDEX_FILE: join(dir, "index"),
    GIT_AUTHOR_NAME: "u",
    GIT_AUTHOR_EMAIL: "u@u",
    GIT_COMMITTER_NAME: "u",
    GIT_COMMITTER_EMAIL: "u@u",
  };
  try {
    const run = async (args: string[], stdin?: string) => {
      const r = await runCommand(["git", ...args], {
        cwd: repo,
        env,
        ...(stdin !== undefined ? { stdin } : {}),
      });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    await run(["read-tree", `refs/tags/${TAG_B}^{commit}`]);
    const blob = await run(["hash-object", "-w", "--stdin"], content);
    await run(["update-index", "--add", "--cacheinfo", `100644,${blob},code/notes-c.txt`]);
    const tree = await run(["write-tree"]);
    const commit = await run([
      "commit-tree",
      tree,
      "-p",
      `refs/tags/${TAG_B}^{commit}`,
      "-m",
      `upstream ${TAG_C}`,
    ]);
    await run(["update-ref", `refs/tags/${TAG_C}`, commit]);
    w.openNeuro.snapshots = [
      ...UPSTREAM_SNAPSHOTS.map((s) => ({ ...s })),
      { tag: TAG_C, created: "2026-09-01T00:00:00.000Z" },
    ];
    w.openNeuro.latest = TAG_C;
    return commit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Plan tag C as `nemar admin repull plan` does; with tag B's pull request open it is not executable. */
async function planC(): Promise<string> {
  const run = await w.cli(["repull", "plan", w.fx.datasetId, "--json"]);
  expect([0, 3]).toContain(run.exitCode);
  // The plan file is flat: its volatile fields, then its body's own.
  const file = JSON.parse(run.stdout) as { digest: string; upstream: { to_tag: string } };
  expect(file.upstream.to_tag).toBe(TAG_C);
  return defaultPlanPath(w.configDir, w.fx.datasetId, TAG_C, file.digest);
}

describe.skipIf(!awsInstalled)("execute --supersede", () => {
  test("without the flag a newer tag's plan refuses repull-in-flight and changes nothing", async () => {
    await makeTagC();
    const plan = await planC();
    const run = await w.cli(["repull", "execute", plan, "--yes"]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("repull-in-flight");
    expect(run.all).toContain("--supersede");
    expect(rows()).toEqual([expect.objectContaining({ status: "pr_open", to_tag: TAG_B })]);
    expect(w.gh.pulls[prKey(w)]?.state ?? "open").toBe("open");
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });

  test("closes tag B's pull request, deletes its branch, ends it superseded, and records tag C", async () => {
    const pr = w.row().pr_number as number;
    await makeTagC();
    const plan = await planC();
    const run = await w.cli([
      "repull",
      "execute",
      plan,
      "--supersede",
      "--until",
      "planned",
      "--yes",
    ]);
    expect(run.exitCode, run.all).toBe(0);
    const [b, c] = rows();
    expect(b).toMatchObject({ status: "superseded", to_tag: TAG_B });
    expect(c).toMatchObject({ status: "planned", to_tag: TAG_C, from_tag: TAG_A, attempt: 1 });
    expect(w.gh.pulls[`${w.fx.datasetId}#${pr}`]?.state).toBe("closed");
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(false);
    expect(run.all).toContain("is superseded");
  });

  test("a plan that went stale supersedes nothing: the plan is proved before tag B's record is touched", async () => {
    await makeTagC();
    const plan = await planC();
    // OpenNeuro re-creates tag C on another commit after the plan was reviewed.
    await gitIn(w.fx.upstreamRepo, ["update-ref", "-d", `refs/tags/${TAG_C}`]);
    await makeTagC("The snapshot made again.\n");
    const run = await w.cli(["repull", "execute", plan, "--supersede", "--yes"]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("plan-stale");
    expect(rows()).toEqual([expect.objectContaining({ status: "pr_open", to_tag: TAG_B })]);
    expect(w.gh.seen.filter((s) => s.method === "PATCH")).toEqual([]);
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });

  test("another release pull request beside tag B's keeps the plan not executable: nothing is superseded", async () => {
    await makeTagC();
    const plan = await planC();
    // An ordinary release pull request of the dataset's own, as `nemar dataset release` opens one.
    await gitIn(w.fx.originRepo, ["update-ref", "refs/heads/release/v1.0.1", w.row().base_sha]);
    w.gh.pulls[`${w.fx.datasetId}#${(w.row().pr_number as number) + 10}`] = {
      sha: w.row().base_sha,
      headRef: "release/v1.0.1",
      author: "alice",
    };
    const run = await w.cli(["repull", "execute", plan, "--supersede", "--yes"]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("not-executable");
    expect(rows()).toEqual([expect.objectContaining({ status: "pr_open", to_tag: TAG_B })]);
    expect(w.gh.seen.filter((s) => s.method === "PATCH")).toEqual([]);
  });

  test("an automatic record is never superseded", async () => {
    await makeTagC();
    const plan = await planC();
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const run = await w.cli(["repull", "execute", plan, "--supersede", "--yes"]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("supersede-automatic");
    expect(rows()).toEqual([expect.objectContaining({ status: "pr_open", to_tag: TAG_B })]);
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });
});
