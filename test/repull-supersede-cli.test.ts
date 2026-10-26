/**
 * `nemar admin repull execute --supersede` (ADR 0111, decision 3; epic #1046 phase 6, #1912),
 * driven through the real entry point against `repull-pr-world.ts`: a re-pull to tag B (1.1.0) is
 * open at `pr_open` when upstream makes tag C (1.2.0). The real `plan` and `execute` commands, the
 * real API over bun:sqlite through TEST_API_URL in the child's environment; stand-ins for GitHub,
 * OpenNeuro and S3 only. No mocks.
 *
 * The properties, each with a test:
 *  - without the flag, a plan for tag C refuses `repull-in-flight` and changes nothing;
 *  - with it, tag B's pull request is closed, its branch deleted and its record ends `superseded`,
 *    and the tag C record is created, from the same `from_tag`;
 *  - the tag C plan is proved and made again from live sources BEFORE tag B's record is touched: a
 *    plan that went stale supersedes nothing;
 *  - only the record's own release branch and pull request are tolerated in the new plan's
 *    preflight, judged from what that check read: another release branch, another release pull
 *    request, or a list of pull requests not read whole keeps it not executable, and a record
 *    that has pushed nothing yet owns no release branch; with no pull request recorded, exactly
 *    one open pull request of its branch from the dataset's own repository is its own, and a
 *    fork's is never;
 *  - a tag C plan that is not executable for anything else (a submodule, an unpinned key, a second
 *    failing check) is refused with only tag B's own branch and pull request present;
 *  - an automatic record, a record of the same tag or of another `from_tag`, a record past its merge
 *    and a record whose merge claim is held are never superseded, and nothing is written;
 *  - a tag B branch carrying a commit that is not the record's refuses before anything is closed.
 *
 * What only the first production runs can check: that a second release pull request of the same
 * branch name opens on GitHub after the first was closed and its branch deleted, as the stand-in
 * opens it.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import { runCommand } from "../src/lib/git-annex/run-command";
import { defaultPlanPath } from "../src/lib/repull/digest";
import { TAG_A, TAG_B, UPSTREAM_SNAPSHOTS, gitIn } from "./helpers/repull-fixture";
import {
  type RepullWorld,
  type WorldPoint,
  prKey,
  startRepullWorld,
} from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);
const TAG_C = "1.2.0";

let w: RepullWorld;
/** What a test changed outside what restore() puts back, undone after it. */
const undo: Array<() => void> = [];
/**
 * Tag C made and planned once, by the real `plan` (which writes nothing but its file): the point
 * and the plan file the cases that need no other tag C start from (`atTagC`).
 */
let tagCPoint: WorldPoint;
let tagCPlan: string;

beforeAll(async () => {
  if (!awsInstalled) return;
  w = await startRepullWorld();
  await makeTagC();
  tagCPlan = await planC();
  tagCPoint = await w.save();
});
afterAll(() => w?.stop());
afterEach(() => {
  for (const f of undo.splice(0)) f();
});
beforeEach(async () => {
  if (!awsInstalled) return;
  await w.restore();
  w.openNeuro.latest = TAG_B;
  w.openNeuro.snapshots = UPSTREAM_SNAPSHOTS.map((s) => ({ ...s }));
});

const hasRef = async (ref: string) =>
  (await gitIn(w.fx.originRepo, ["for-each-ref", "--format=%(refname)", ref])).trim() !== "";
const patches = () => w.gh.seen.filter((s) => s.method === "PATCH");
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

/** One more tree entry tag C carries: a mode, a path and the entry's object or content. */
type Entry = { mode: string; path: string } & ({ content: string } | { sha: string });

/**
 * Upstream makes tag C on top of tag B (one file more, and `extra` entries), and OpenNeuro names it
 * its latest.
 */
async function makeTagC(content = "A third snapshot.\n", extra: Entry[] = []): Promise<string> {
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
    for (const e of extra) {
      const sha = "sha" in e ? e.sha : await run(["hash-object", "-w", "--stdin"], e.content);
      await run(["update-index", "--add", "--cacheinfo", `${e.mode},${sha},${e.path}`]);
    }
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

/** Tag C made and planned (the default content), from the point `beforeAll` reached once. */
async function atTagC(): Promise<string> {
  await w.restore(tagCPoint);
  w.openNeuro.snapshots = [
    ...UPSTREAM_SNAPSHOTS.map((s) => ({ ...s })),
    { tag: TAG_C, created: "2026-09-01T00:00:00.000Z" },
  ];
  w.openNeuro.latest = TAG_C;
  return tagCPlan;
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
    const plan = await atTagC();
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
    const plan = await atTagC();
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
    const plan = await atTagC();
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
    const plan = await atTagC();
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
    const plan = await atTagC();
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const run = await w.cli(["repull", "execute", plan, "--supersede", "--yes"]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("supersede-automatic");
    expect(rows()).toEqual([expect.objectContaining({ status: "pr_open", to_tag: TAG_B })]);
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });
  /** Refused before anything was written: tag B's record, pull request and branch as they were. */
  async function untouched(run: { exitCode: number; all: string }, code: string): Promise<void> {
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain(code);
    expect(rows()).toEqual([expect.objectContaining({ status: "pr_open", to_tag: TAG_B })]);
    expect(patches()).toEqual([]);
    expect(w.gh.pulls[prKey(w)]?.state ?? "open").toBe("open");
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  }

  const supersede = (plan: string) => w.cli(["repull", "execute", plan, "--supersede", "--yes"]);

  test("another release branch, with no pull request, keeps the plan not executable", async () => {
    const plan = await atTagC();
    await gitIn(w.fx.originRepo, ["update-ref", "refs/heads/release/v1.0.1", w.row().base_sha]);
    const run = await supersede(plan);
    await untouched(run, "not-executable");
    expect(run.all).toContain("release branch(es) other than re-pull");
    // The branch is named, so the administrator knows which to delete.
    expect(run.all).toContain("(release/v1.0.1)");
  });

  /** Tag B's record as a run left it that pushed its branch and opened its pull request, unrecorded. */
  const registeredWithoutPull = () =>
    w.db().run("UPDATE upstream_repulls SET status = 'registered', pr_number = NULL");

  test("with no pull request recorded, the one open pull request of tag B's branch is its own", async () => {
    const pr = w.row().pr_number as number;
    const plan = await atTagC();
    registeredWithoutPull();
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
    expect(c).toMatchObject({ status: "planned", to_tag: TAG_C });
    expect(w.gh.pulls[`${w.fx.datasetId}#${pr}`]?.state).toBe("closed");
  });

  test("with no pull request recorded, a fork's pull request of tag B's branch name is not its own", async () => {
    const plan = await atTagC();
    const fork = (w.row().pr_number as number) + 10;
    registeredWithoutPull();
    w.gh.pulls[`${w.fx.datasetId}#${fork}`] = {
      sha: w.row().head_sha as string,
      headRef: "release/v2.0.0",
      headRepo: "alice/on099999-fork",
      author: "alice",
    };
    const run = await supersede(plan);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("not-executable");
    expect(run.all).toContain(`another release pull request is open (#${fork})`);
    expect(patches()).toEqual([]);
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });

  test("with no pull request recorded, two open pull requests of tag B's branch are not judged", async () => {
    const plan = await atTagC();
    const second = (w.row().pr_number as number) + 10;
    registeredWithoutPull();
    w.gh.pulls[`${w.fx.datasetId}#${second}`] = {
      sha: w.row().head_sha as string,
      headRef: "release/v2.0.0",
    };
    const run = await supersede(plan);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("not-executable");
    expect(run.all).toContain("so which is its own is not known");
    expect(patches()).toEqual([]);
  });

  test("another release pull request, whose branch is gone, keeps the plan not executable", async () => {
    const plan = await atTagC();
    const other = (w.row().pr_number as number) + 10;
    w.gh.pulls[`${w.fx.datasetId}#${other}`] = {
      sha: w.row().base_sha,
      headRef: "release/v1.0.1",
      author: "alice",
    };
    const run = await supersede(plan);
    await untouched(run, "not-executable");
    expect(run.all).toContain(`another release pull request is open (#${other})`);
  });

  test("a second pull request of tag B's branch keeps the plan not executable", async () => {
    const plan = await atTagC();
    const other = (w.row().pr_number as number) + 10;
    w.gh.pulls[`${w.fx.datasetId}#${other}`] = {
      sha: w.row().head_sha as string,
      headRef: "release/v2.0.0",
      author: "alice",
    };
    const run = await supersede(plan);
    await untouched(run, "not-executable");
    expect(run.all).toContain(`another release pull request is open (#${other})`);
  });

  test("a list of 100 open pull requests is not read whole: nothing is superseded", async () => {
    const plan = await atTagC();
    // Tag B's own and 99 more: one page of exactly 100.
    const first = (w.row().pr_number as number) + 1;
    for (let n = first; n < first + 99; n++) {
      w.gh.pulls[`${w.fx.datasetId}#${n}`] = { sha: w.row().base_sha, headRef: `topic-${n}` };
    }
    const run = await supersede(plan);
    await untouched(run, "not-executable");
    expect(run.all).toContain("100 or more");
  });

  const tagCVariants: Array<[string, () => Promise<void>]> = [
    [
      "a submodule (a plan refusal)",
      async () => {
        await makeTagC(undefined, [
          { mode: "160000", path: "code/vendored", sha: w.row().base_sha as string },
        ]);
      },
    ],
    [
      "an annexed file no upstream version is pinned to (an unpinned key)",
      async () => {
        const key = `SHA256E-s5--${"ab".repeat(32)}.bin`;
        await makeTagC(undefined, [
          {
            mode: "120000",
            path: "code/extra.bin",
            content: `../.git/annex/objects/Xx/Yy/${key}/${key}`,
          },
        ]);
      },
    ],
    [
      "a bucket marker that is not NEMAR's nemar-s3 UUID (a second failing check)",
      async () => {
        await makeTagC();
        // The plan reads the marker from the world's bucket directory, which restore() leaves.
        const marker = join(w.fx.bucketBase, `${w.fx.datasetId}/objects/annex-uuid`);
        const was = readFileSync(marker, "utf8");
        writeFileSync(marker, "11111111-2222-3333-4444-555555555555");
        undo.push(() => writeFileSync(marker, was));
      },
    ],
  ];
  for (const [what, make] of tagCVariants) {
    test(`a tag C plan with ${what} is refused with only tag B's own release present`, async () => {
      await make();
      const plan = await planC();
      const run = await supersede(plan);
      await untouched(run, "not-executable");
      expect(run.all).toContain("Not superseded: the plan is not executable for more than");
    });
  }

  test("a record of the same tag is not superseded (supersede-same-tag)", async () => {
    const plan = await atTagC();
    w.db().run("UPDATE upstream_repulls SET to_tag = ?", [TAG_C]);
    const run = await supersede(plan);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("supersede-same-tag");
    expect(patches()).toEqual([]);
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });

  test("a record pulled from another from_tag is not superseded (supersede-from-tag)", async () => {
    const plan = await atTagC();
    w.db().run("UPDATE upstream_repulls SET from_tag = '00001'");
    const run = await supersede(plan);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("supersede-from-tag");
    expect(patches()).toEqual([]);
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });

  test("a record past its merge is released, never superseded (supersede-too-late)", async () => {
    const plan = await atTagC();
    w.db().run(
      "UPDATE upstream_repulls SET status = 'merged', gates_sha = COALESCE(gates_sha, head_sha), merge_sha = base_sha",
    );
    const run = await supersede(plan);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("supersede-too-late");
    expect(rows()).toEqual([expect.objectContaining({ status: "merged", to_tag: TAG_B })]);
    expect(patches()).toEqual([]);
  });

  test("a held merge claim refuses before anything is planned or written (merge-claim-held)", async () => {
    const plan = await atTagC();
    w.db().run(
      "UPDATE upstream_repulls SET merge_claimed_at = '2026-10-25T00:00:00.000Z', merge_claim_sha = head_sha",
    );
    const lists = () => w.gh.seen.filter((x) => x.method === "GET" && x.path.endsWith("/pulls"));
    const before = lists().length;
    const run = await supersede(plan);
    await untouched(run, "merge-claim-held");
    // Refused before the plan was made again: its release-pr check never read the list.
    expect(lists().length).toBe(before);
  });

  test("a record that pushed no branch yet, beside a release branch, keeps the plan not executable", async () => {
    const plan = await atTagC();
    // At `copied` the record has pushed nothing, so release/v2.0.0 is not its own.
    w.db().run("UPDATE upstream_repulls SET status = 'copied'");
    const run = await supersede(plan);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("not-executable");
    expect(run.all).toContain("is copied and pushed no branch");
    expect(patches()).toEqual([]);
    expect(await hasRef("refs/heads/release/v2.0.0")).toBe(true);
  });

  test("tag B's branch carrying a commit that is not the record's refuses before anything is closed", async () => {
    const plan = await atTagC();
    await w.commitOnto("refs/heads/release/v2.0.0", "code/foreign.txt", "Not the record's.\n");
    const run = await supersede(plan);
    await untouched(run, "branch-foreign");
  });
});
