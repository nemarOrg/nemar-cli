/**
 * Lift, push, restore (`scripts/scrub/github/switch-lib.ts`).
 *
 * A real bare git repository plays the GitHub remote, and a pre-receive hook in it enforces the
 * rulesets the same way GitHub does: it asks a local HTTP server (which speaks the rulesets REST
 * API) whether the tag ruleset or the branch ruleset is active, and refuses a tag update or a
 * non-fast-forward accordingly. So a push that needs the protection lifted really fails without
 * the lift and really succeeds with it, and every test about restoring the protection reads the
 * enforcement back from the same server. Names, SHAs and ids are invented.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  PushFailed,
  RESTORE_ADVICE,
  RestoreFailed,
  type RulesetBody,
  type Snapshot,
  SwitchRefused,
  classifyPushError,
  listRulesets,
  restoreSnapshot,
  switchRefs,
  takeSnapshot,
} from "../../scripts/scrub/github/switch-lib";

const REPO = "nemarDatasets/nm000001";
const READ_ONLY = [
  "id",
  "node_id",
  "source",
  "source_type",
  "created_at",
  "updated_at",
  "_links",
  "current_user_can_bypass",
];

interface Stand {
  url: string;
  rulesets: Map<number, RulesetBody>;
  calls: string[];
  /** Ruleset ids whose PUT is acknowledged but silently not applied. */
  stuck: Set<number>;
  /** Ruleset ids whose PUT is answered with a server error. */
  failPut: Set<number>;
  /** Awaited after each applied PUT; a test uses it to act while the protection is lifted. */
  afterPut: { current: ((id: number, enforcement: string) => Promise<void>) | null };
  stop: () => void;
}

function standIn(bypassBranch: "always" | "never"): Stand {
  const rulesets = new Map<number, RulesetBody>();
  rulesets.set(1, {
    id: 1,
    name: "NEMAR branch protection",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
    current_user_can_bypass: bypassBranch,
    node_id: "n1",
    _links: {},
  });
  rulesets.set(2, {
    id: 2,
    name: "Protect version tags",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "update" }],
    current_user_can_bypass: "never",
    node_id: "n2",
    _links: {},
  });
  const calls: string[] = [];
  const stuck = new Set<number>();
  const failPut = new Set<number>();
  const afterPut: Stand["afterPut"] = { current: null };
  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, not the default: a wildcard bind (`*:port`, IPv6 dual-stack) lets another
    // process on the machine bind 127.0.0.1:<same port> and take every connection the test makes
    // to 127.0.0.1 (measured on macOS: the "404 in 2 ms" and "401" flakes were other local
    // servers answering). A specific bind refuses that second bind (EADDRINUSE).
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const m = /^\/repos\/([^/]+\/[^/]+)\/rulesets(?:\/(\d+))?$/.exec(url.pathname);
      if (url.pathname === "/state") {
        return Response.json({
          branch: rulesets.get(1)?.enforcement,
          tag: rulesets.get(2)?.enforcement,
          branchBypass: rulesets.get(1)?.current_user_can_bypass,
        });
      }
      if (!m) return new Response("not found", { status: 404 });
      if (req.headers.get("authorization") !== "Bearer test-token")
        return new Response("no", { status: 401 });
      if (req.method === "GET" && !m[2]) {
        // Paged as GitHub pages it: the default page is 30 unless `per_page` asks for more.
        const perPage = Math.min(100, Number(url.searchParams.get("per_page") ?? 30));
        const page = Number(url.searchParams.get("page") ?? 1);
        return Response.json(
          [...rulesets.values()]
            .map((r) => ({ id: r.id, name: r.name, target: r.target }))
            .slice((page - 1) * perPage, page * perPage),
        );
      }
      const id = Number(m[2]);
      const current = rulesets.get(id);
      if (!current) return new Response("not found", { status: 404 });
      if (req.method === "GET") return Response.json(current);
      if (req.method === "PUT") {
        const body = (await req.json()) as Record<string, unknown>;
        for (const f of READ_ONLY) {
          if (f in body) return new Response(`unexpected field ${f}`, { status: 422 });
        }
        for (const f of ["name", "target", "enforcement", "rules"]) {
          if (!(f in body)) return new Response(`missing ${f}`, { status: 422 });
        }
        calls.push(`${body.enforcement === "disabled" ? "disable" : "enable"} ${id}`);
        if (failPut.has(id)) return new Response("down", { status: 500 });
        if (stuck.has(id)) return Response.json(current);
        rulesets.set(id, {
          ...current,
          ...(body as object),
          id,
          current_user_can_bypass: current.current_user_can_bypass,
        } as RulesetBody);
        await afterPut.current?.(id, String(body.enforcement));
        return Response.json(rulesets.get(id));
      }
      return new Response("method", { status: 405 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    rulesets,
    calls,
    stuck,
    failPut,
    afterPut,
    stop: () => server.stop(true),
  };
}

/**
 * Every git the TEST runs sees no global or system config, as on a CI runner, which has no
 * identity and no `init.defaultBranch` (so `git init` makes `master`). The developer's own
 * config hid both on a laptop. The tool under test runs with the real environment.
 */
const GIT_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.org",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.org",
  GIT_TERMINAL_PROMPT: "0",
};

const run = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
};

/** Async git: a push runs the hook, which calls back into this process's server, so a sync spawn would deadlock it. */
function gitAsync(
  cwd: string,
  ...args: string[]
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], env: GIT_ENV });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

interface World {
  dir: string;
  remote: string;
  work: string;
  stand: Stand;
  api: Api;
  /** `git-scrub snapshot`'s before.json, taken by the REAL tool before the rewrite. */
  before: string;
  originTips: Record<string, string>;
}

const GIT_SCRUB = join(import.meta.dir, "../../scripts/scrub/git/git-scrub.ts");

/** The switch snapshot the way the CLI takes it: leases from the clone's pre-rewrite tips. */
const snap = (w: World, opts: { acceptDisabled?: boolean } = {}): Promise<Snapshot> =>
  takeSnapshot(w.api, REPO, w.work, "origin", w.originTips, opts);

function hookScript(stand: Stand, slowFile: string, blockRef: string): string {
  return `#!/bin/sh
STATE=$(curl -s ${stand.url}/state)
tag=$(echo "$STATE" | sed -E 's/.*"tag":"([a-z]+)".*/\\1/')
branch=$(echo "$STATE" | sed -E 's/.*"branch":"([a-z]+)".*/\\1/')
bypass=$(echo "$STATE" | sed -E 's/.*"branchBypass":"([a-z]+)".*/\\1/')
ZERO=0000000000000000000000000000000000000000
while read old new ref; do
  if [ "$ref" = "${blockRef}" ]; then echo "blocked ref" >&2; exit 1; fi
  case "$ref" in
    refs/tags/*)
      if [ "$old" != "$ZERO" ] && [ "$tag" = "active" ]; then echo "tag ruleset active" >&2; exit 1; fi ;;
    refs/heads/main)
      if [ "$old" != "$ZERO" ] && [ "$branch" = "active" ] && [ "$bypass" != "always" ]; then
        if ! git merge-base --is-ancestor "$old" "$new" 2>/dev/null; then echo "non-ff, branch ruleset active" >&2; exit 1; fi
      fi ;;
  esac
done
# Held until the test releases it (or two minutes pass), never for a guessed number of seconds:
# under load a fixed sleep can end before the test's signal arrives.
if [ -f ${slowFile} ]; then
  : > ${slowFile}.started
  i=0
  while [ ! -f ${slowFile}.release ] && [ $i -lt 1200 ]; do sleep 0.1; i=$((i+1)); done
fi
exit 0
`;
}

function build(bypassBranch: "always" | "never", blockRef = "refs/none"): World {
  const dir = mkdtempSync(join(tmpdir(), "switch-"));
  const remote = join(dir, "remote.git");
  const work = join(dir, "work");
  const stand = standIn(bypassBranch);
  // `-b main`: the remote's HEAD must name the branch that exists, or a clone of it checks
  // nothing out (a runner's git defaults to `master`).
  run(dir, "init", "--bare", "-q", "-b", "main", "remote.git");
  mkdirSync(work);
  run(work, "init", "-q", "-b", "main");
  run(work, "config", "user.email", "t@example.org");
  run(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "a\n");
  run(work, "add", ".");
  run(work, "commit", "-q", "-m", "A");
  run(work, "tag", "-a", "v1.0.0", "-m", "one");
  writeFileSync(join(work, "b.txt"), "b\n");
  run(work, "add", ".");
  run(work, "commit", "-q", "-m", "B");
  run(work, "tag", "v1.0.1");
  // The clone names the GitHub repository, as a real clone does; `insteadOf` is how git itself
  // reaches the local bare repository that stands in for it, for fetch and push alike.
  run(work, "remote", "add", "origin", `https://github.com/${REPO}`);
  run(work, "config", `url.${remote}.insteadOf`, `https://github.com/${REPO}`);
  run(work, "push", "-q", "origin", "main", "v1.0.0", "v1.0.1");
  writeFileSync(
    join(remote, "hooks", "pre-receive"),
    hookScript(stand, join(dir, "slow"), blockRef),
  );
  chmodSync(join(remote, "hooks", "pre-receive"), 0o755);
  // What the clone knew of the remote before the rewrite, recorded by the real tool.
  const before = join(dir, "before.json");
  const snapshotRun = spawnSync("bun", [GIT_SCRUB, "snapshot", "--repo", work, "--out", before], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  if (snapshotRun.status !== 0) throw new Error(`git-scrub snapshot failed: ${snapshotRun.stdout}`);
  const originTips = (
    JSON.parse(readFileSync(before, "utf8")) as { originTips: Record<string, string> }
  ).originTips;
  // The rewritten history: same shape, different commits, moved tags.
  const treeA = run(work, "rev-parse", "v1.0.0^{tree}");
  const treeB = run(work, "rev-parse", "main^{tree}");
  const a2 = run(work, "commit-tree", treeA, "-m", "A2");
  const b2 = run(work, "commit-tree", treeB, "-p", a2, "-m", "B2");
  run(work, "update-ref", "refs/heads/main", b2);
  run(work, "tag", "-f", "-a", "v1.0.0", a2, "-m", "one again");
  run(work, "tag", "-f", "v1.0.1", b2);
  return {
    dir,
    remote,
    work,
    stand,
    api: { base: stand.url, token: "test-token" },
    before,
    originTips,
  };
}

let world: World;
afterEach(() => {
  world?.stand.stop();
  if (world && existsSyncPath(world.dir)) {
    // Let a push still held in the hook finish before its repository goes.
    writeFileSync(join(world.dir, "slow.release"), "");
    rmSync(world.dir, { recursive: true, force: true });
  }
});

const remoteRef = (w: World, ref: string) => run(w.work, "ls-remote", "origin", ref).split("\t")[0];
const localSha = (w: World, ref: string) => run(w.work, "rev-parse", ref);
const enforcement = (w: World) => ({
  branch: w.stand.rulesets.get(1)?.enforcement,
  tag: w.stand.rulesets.get(2)?.enforcement,
});

describe("the fixture is honest: the hook enforces the rulesets", () => {
  beforeEach(() => {
    world = build("always");
  });

  test("a forced tag move is refused while the tag ruleset is active", async () => {
    const r = await gitAsync(world.work, "push", "--force", "origin", "refs/tags/v1.0.0");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("tag ruleset active");
  });

  test("the same push succeeds once the ruleset is disabled, so the lift is what matters", async () => {
    const body = world.stand.rulesets.get(2) as RulesetBody;
    world.stand.rulesets.set(2, { ...body, enforcement: "disabled" });
    const r = await gitAsync(world.work, "push", "--force", "origin", "refs/tags/v1.0.0");
    expect(r.status).toBe(0);
  });
});

describe("lift, push, restore", () => {
  test("a dry run reads and plans, and changes nothing", async () => {
    world = build("always");
    const snapshot = await snap(world);
    const before = remoteRef(world, "refs/heads/main");
    const report = await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute: false,
    });
    expect(report.executed).toBe(false);
    expect(report.lifted).toEqual([2]);
    expect(report.pushed.sort()).toEqual([
      "refs/heads/main",
      "refs/tags/v1.0.0",
      "refs/tags/v1.0.1",
    ]);
    expect(world.stand.calls).toEqual([]);
    expect(remoteRef(world, "refs/heads/main")).toBe(before);
  });

  test("execute lifts only what blocks, pushes every ref, restores, and the remote equals the rewrite", async () => {
    world = build("always");
    const snapshot = await snap(world);
    const report = await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute: true,
    });
    expect(report.lifted).toEqual([2]);
    expect(report.restored).toEqual([2]);
    expect(world.stand.calls).toEqual(["disable 2", "enable 2"]);
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
    for (const ref of ["refs/heads/main", "refs/tags/v1.0.0", "refs/tags/v1.0.1"]) {
      expect(remoteRef(world, ref), ref).toBe(localSha(world, ref));
    }
  });

  test("a branch ruleset the pusher cannot bypass is lifted too, and restored", async () => {
    world = build("never");
    const snapshot = await snap(world);
    const report = await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute: true,
    });
    expect(report.lifted.sort()).toEqual([1, 2]);
    expect(world.stand.calls.filter((c) => c.startsWith("disable")).sort()).toEqual([
      "disable 1",
      "disable 2",
    ]);
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
    expect(remoteRef(world, "refs/heads/main")).toBe(localSha(world, "refs/heads/main"));
  });

  test("the restore sends no read-only field and the readback matches the snapshot", async () => {
    world = build("always");
    const snapshot = await snap(world);
    await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute: true,
    });
    const live = await listRulesets(world.api, REPO);
    for (const s of snapshot.rulesets)
      expect(live.find((l) => l.id === s.id)?.enforcement).toBe(s.enforcement);
  });
});

describe("refusals before anything is touched", () => {
  beforeEach(() => {
    world = build("always");
  });

  test("a remote ref that moved after the snapshot", async () => {
    const snapshot = await snap(world);
    const other = join(world.dir, "other");
    run(world.dir, "clone", "-q", world.remote, other);
    run(other, "config", "user.email", "t@example.org");
    run(other, "config", "user.name", "t");
    writeFileSync(join(other, "c.txt"), "c\n");
    run(other, "add", ".");
    run(other, "commit", "-q", "-m", "enrichment");
    expect((await gitAsync(other, "push", "-q", "origin", "main")).status).toBe(0);
    const moved = remoteRef(world, "refs/heads/main");
    await expect(
      switchRefs({
        api: world.api,
        repo: REPO,
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute: true,
      }),
    ).rejects.toThrow("remote-moved-since-clone (1 ref(s))");
    expect(world.stand.calls).toEqual([]);
    expect(remoteRef(world, "refs/heads/main")).toBe(moved);
  });

  test("a push to the remote after the clone, before the snapshot, refuses the snapshot (I3)", async () => {
    // An uploader pushed while the clone was being hashed and rewritten: the remote no longer
    // holds what the clone knew, and a force-push would erase their commit.
    const other = join(world.dir, "uploader");
    run(world.dir, "clone", "-q", world.remote, other);
    writeFileSync(join(other, "late.txt"), "late\n");
    run(other, "add", ".");
    run(other, "commit", "-q", "-m", "uploaded after the clone");
    expect((await gitAsync(other, "push", "-q", "origin", "main")).status).toBe(0);
    const uploaded = remoteRef(world, "refs/heads/main");
    const error = (await snap(world).catch((e) => e)) as SwitchRefused;
    expect(error).toBeInstanceOf(SwitchRefused);
    expect(error.reason).toBe("remote-moved-since-clone (1 ref(s))");
    // The CLI says the same, writes no snapshot, and exits refused.
    const out = join(world.dir, "snapshot.json");
    const r = await cliRun(world, [
      "snapshot",
      "--repo",
      REPO,
      "--clone",
      world.work,
      "--before",
      world.before,
      "--out",
      out,
    ]).exited;
    expect(r.code, r.stderr).toBe(3);
    expect(r.stderr.trim()).toBe("switch refused: remote-moved-since-clone (1 ref(s))");
    expect(existsSyncPath(out)).toBe(false);
    expect(world.stand.calls).toEqual([]);
    expect(remoteRef(world, "refs/heads/main")).toBe(uploaded);
  });

  test("a head the push does not touch, moved after the snapshot, still refuses the switch (I3)", async () => {
    const snapshot = await snap(world);
    // Someone pushes a git-annex branch: not a ref this switch pushes, but the remote is no
    // longer what the clone knew, so whatever else changed with it is unknown too.
    const other = join(world.dir, "annex-pusher");
    run(world.dir, "clone", "-q", world.remote, other);
    run(other, "checkout", "-q", "--orphan", "git-annex");
    run(other, "commit", "-q", "--allow-empty", "-m", "annex");
    expect((await gitAsync(other, "push", "-q", "origin", "git-annex")).status).toBe(0);
    const error = (await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute: true,
    }).catch((e) => e)) as SwitchRefused;
    expect(error).toBeInstanceOf(SwitchRefused);
    expect(error.reason).toBe("remote-moved-since-clone (1 ref(s))");
    expect(world.stand.calls).toEqual([]);
  });

  test("the leases are the clone's recorded tips (I3)", async () => {
    const snapshot = await snap(world);
    expect(snapshot.refs).toEqual({
      "refs/heads/main": world.originTips["refs/heads/main"],
      "refs/tags/v1.0.0": world.originTips["refs/tags/v1.0.0"],
      "refs/tags/v1.0.1": world.originTips["refs/tags/v1.0.1"],
    });
    // And the recorded tips are what the remote held before the rewrite.
    expect(world.originTips["refs/heads/main"]).toBe(remoteRef(world, "refs/heads/main"));
  });

  test("a ruleset created after the snapshot refuses the switch, and nothing is lifted (T2)", async () => {
    const snapshot = await snap(world);
    world.stand.rulesets.set(3, {
      id: 3,
      name: "Added later",
      target: "tag",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } },
      rules: [{ type: "update" }],
      current_user_can_bypass: "never",
    });
    for (const execute of [false, true]) {
      const error = (await switchRefs({
        api: world.api,
        repo: REPO,
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute,
      }).catch((e) => e)) as SwitchRefused;
      expect(error).toBeInstanceOf(SwitchRefused);
      expect(error.reason).toBe("ruleset-not-in-snapshot");
    }
    expect(world.stand.calls).toEqual([]);
  });

  test("a baseline with a blocking ruleset already off is refused, unless accepted (I5)", async () => {
    const tag = world.stand.rulesets.get(2) as RulesetBody;
    world.stand.rulesets.set(2, { ...tag, enforcement: "disabled" });
    const error = (await snap(world).catch((e) => e)) as SwitchRefused;
    expect(error).toBeInstanceOf(SwitchRefused);
    expect(error.reason).toBe("ruleset-already-lifted");
    const accepted = await snap(world, { acceptDisabled: true });
    expect(accepted.rulesets.find((r) => r.id === 2)?.enforcement).toBe("disabled");
    // A branch ruleset the pusher can bypass does not block, so it being off is not a refusal.
    world.stand.rulesets.set(2, tag);
    const branch = world.stand.rulesets.get(1) as RulesetBody;
    world.stand.rulesets.set(1, { ...branch, enforcement: "disabled" });
    expect((await snap(world)).rulesets.length).toBe(2);
  });

  test("every page of the rulesets is read, and an inherited blocking ruleset is refused up front", async () => {
    // 130 more rulesets, past the default page of 30 and GitHub's maximum page of 100: a list cut
    // at one page would leave rulesets out of the snapshot, and what the snapshot lacks is never
    // restored.
    for (let id = 10; id < 140; id++) {
      world.stand.rulesets.set(id, {
        id,
        name: `later ${id}`,
        target: "branch",
        enforcement: "disabled",
        current_user_can_bypass: "always",
      });
    }
    const snapshot = await snap(world);
    expect(snapshot.rulesets.length).toBe(132);

    // A ruleset the organization owns cannot be lifted through the repository's endpoint.
    const tag = world.stand.rulesets.get(2) as RulesetBody;
    world.stand.rulesets.set(2, { ...tag, source_type: "Organization" });
    const error = (await snap(world).catch((e) => e)) as SwitchRefused;
    expect(error).toBeInstanceOf(SwitchRefused);
    expect(error.reason).toBe("ruleset-not-repository");
    expect(world.stand.calls).toEqual([]);
    // The twin: the same ruleset owned by the repository is the ordinary case.
    world.stand.rulesets.set(2, { ...tag, source_type: "Repository" });
    expect((await snap(world)).rulesets.length).toBe(132);
  });

  test("a usage error leaves no empty snapshot behind, and the admin token goes only to GitHub or this machine", async () => {
    const out = join(world.dir, "usage-snapshot.json");
    // No --before: the process exits 2 before the file is created, so the corrected run is not
    // refused for a file that is already there.
    const missing = await cliRun(world, [
      "snapshot",
      "--repo",
      REPO,
      "--clone",
      world.work,
      "--out",
      out,
    ]).exited;
    expect(missing.code, missing.stderr).toBe(2);
    expect(existsSyncPath(out)).toBe(false);
    const args = [
      "snapshot",
      "--repo",
      REPO,
      "--clone",
      world.work,
      "--before",
      world.before,
      "--out",
      out,
    ];
    const ok = await cliRun(world, args).exited;
    expect(ok.code, ok.stderr).toBe(0);

    // A base that is neither GitHub nor a loopback address would receive the token.
    const elsewhere = await cliRun(world, args, { GITHUB_API_BASE: "https://example.org" }).exited;
    expect(elsewhere.code, elsewhere.stderr).toBe(2);
    expect(elsewhere.stderr).toContain("GITHUB_API_BASE");
    expect(world.stand.calls).toEqual([]);
  });

  test("the CLI never writes a snapshot over an existing file, and a new one is owner-only (I5)", async () => {
    const out = join(world.dir, "snapshot.json");
    writeFileSync(out, "keep me");
    const args = [
      "snapshot",
      "--repo",
      REPO,
      "--clone",
      world.work,
      "--before",
      world.before,
      "--out",
      out,
    ];
    const r = await cliRun(world, args).exited;
    expect(r.code, r.stderr).toBe(3);
    expect(r.stderr.trim()).toBe("switch refused: snapshot-exists");
    expect(readFileSync(out, "utf8")).toBe("keep me");
    rmSync(out);
    const ok = await cliRun(world, args).exited;
    expect(ok.code, ok.stderr).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const disabled = world.stand.rulesets.get(2) as RulesetBody;
    world.stand.rulesets.set(2, { ...disabled, enforcement: "disabled" });
    rmSync(out);
    const lifted = await cliRun(world, args).exited;
    expect(lifted.code).toBe(3);
    expect(lifted.stderr.trim()).toBe("switch refused: ruleset-already-lifted");
    const accepted = await cliRun(world, [...args, "--accept-disabled"]).exited;
    expect(accepted.code, accepted.stderr).toBe(0);
  });

  test("a ruleset whose enforcement changed after the snapshot", async () => {
    const snapshot = await snap(world);
    const tag = world.stand.rulesets.get(2) as RulesetBody;
    world.stand.rulesets.set(2, { ...tag, enforcement: "disabled" });
    await expect(
      switchRefs({
        api: world.api,
        repo: REPO,
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute: true,
      }),
    ).rejects.toThrow("a ruleset changed since the snapshot");
    expect(world.stand.calls).toEqual([]);
  });

  test("a snapshot taken for another repository", async () => {
    const snapshot = await snap(world);
    await expect(
      switchRefs({
        api: world.api,
        repo: "nemarDatasets/nm999999",
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute: true,
      }).catch((e) => (e instanceof SwitchRefused ? e.reason : e)),
    ).resolves.toBe("snapshot-other-repository");
  });
});

describe("the remote is checked before anything is lifted, in a dry run too", () => {
  beforeEach(() => {
    world = build("always");
  });

  /** A second clone of the remote, to put something on it the way another person would. */
  function other(): string {
    const dir = join(world.dir, "other");
    run(world.dir, "clone", "-q", world.remote, dir);
    run(dir, "config", "user.email", "t@example.org");
    run(dir, "config", "user.name", "t");
    return dir;
  }

  const attempt = (execute: boolean, snapshot: Awaited<ReturnType<typeof takeSnapshot>>) =>
    switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute,
    });

  test("a head other than main and git-annex refuses, and nothing is lifted", async () => {
    const snapshot = await snap(world);
    const clone = other();
    run(clone, "checkout", "-q", "-b", "dev");
    expect((await gitAsync(clone, "push", "-q", "origin", "dev")).status).toBe(0);
    for (const execute of [false, true]) {
      await expect(attempt(execute, snapshot)).rejects.toThrow("unexpected-remote-head");
    }
    await expect(snap(world)).rejects.toThrow("unexpected-remote-head");
    expect(world.stand.calls).toEqual([]);
    expect(remoteRef(world, "refs/heads/main")).toBe(run(clone, "rev-parse", "origin/main"));
  });

  test("a git-annex head is expected and does not block the switch", async () => {
    const clone = other();
    run(clone, "checkout", "-q", "--orphan", "git-annex");
    run(clone, "commit", "-q", "--allow-empty", "-m", "annex");
    expect((await gitAsync(clone, "push", "-q", "origin", "git-annex")).status).toBe(0);
    // As a clone made after the git-annex branch existed would have recorded it.
    world.originTips["refs/heads/git-annex"] = run(clone, "rev-parse", "git-annex");
    const snapshot = await snap(world);
    const report = await attempt(true, snapshot);
    expect(report.restored).toEqual([2]);
    expect(remoteRef(world, "refs/heads/main")).toBe(localSha(world, "refs/heads/main"));
  });

  test("a tag on the remote that the clone lacks refuses: the rewrite would strand it", async () => {
    const snapshot = await snap(world);
    const clone = other();
    run(clone, "tag", "v9.9.9");
    expect((await gitAsync(clone, "push", "-q", "origin", "v9.9.9")).status).toBe(0);
    for (const execute of [false, true]) {
      await expect(attempt(execute, snapshot)).rejects.toThrow("remote-only-tag");
    }
    expect(world.stand.calls).toEqual([]);
  });

  test("an origin that names another repository, another host, or no repository refuses", async () => {
    const snapshot = await snap(world);
    // Every wrong URL below is mapped to a path that does not exist, so a check that failed to
    // refuse would fail offline instead of reaching a real host.
    const offline = join(world.dir, "no-such-remote.git");
    const wrong = (url: string, push = false): void => {
      run(world.work, "remote", "set-url", ...(push ? ["--push"] : []), "origin", url);
      run(world.work, "config", "--add", `url.${offline}.insteadOf`, url);
    };
    const refuse = async (what: string, set: () => void) => {
      set();
      for (const execute of [false, true]) {
        await expect(attempt(execute, snapshot), what).rejects.toThrow("origin-mismatch");
      }
      await expect(snap(world), what).rejects.toThrow("origin-mismatch");
    };
    await refuse("another dataset", () => wrong("https://github.com/nemarDatasets/nm000002"));
    await refuse("another owner", () => wrong("https://github.com/someone/nm000001"));
    await refuse("another host", () => wrong("https://gitlab.com/nemarDatasets/nm000001"));
    await refuse("a local path", () =>
      run(world.work, "remote", "set-url", "origin", world.remote),
    );
    // A push URL elsewhere sends the push elsewhere even when the fetch URL is right.
    await refuse("a push url", () => {
      run(world.work, "remote", "set-url", "origin", `https://github.com/${REPO}`);
      wrong("https://github.com/nemarDatasets/nm000003", true);
    });
    expect(world.stand.calls).toEqual([]);
  });

  test("the same repository in https, scp and ssh spellings, with or without .git, is accepted", async () => {
    const snapshot = await snap(world);
    for (const url of [
      `https://github.com/${REPO}.git`,
      `https://github.com/${REPO}/`,
      "https://x-access-token:invented@github.com/nemarDatasets/nm000001",
      `git@github.com:${REPO}`,
      `git@github.com:${REPO}.git`,
      `ssh://git@github.com/${REPO}.git`,
      "https://github.com/NEMARDATASETS/NM000001",
    ]) {
      run(world.work, "remote", "set-url", "origin", url);
      run(world.work, "config", `url.${world.remote}.insteadOf`, url);
      const report = await attempt(false, snapshot);
      expect(report.pushed.length, url).toBe(3);
    }
  });
});

describe("a failure leaves the protection on", () => {
  test("a lift that GitHub acknowledges but does not apply stops before any push", async () => {
    world = build("always");
    const snapshot = await snap(world);
    world.stand.stuck.add(2);
    const before = remoteRef(world, "refs/tags/v1.0.0");
    await expect(
      switchRefs({
        api: world.api,
        repo: REPO,
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute: true,
      }),
    ).rejects.toThrow("did not read back as disabled");
    expect(remoteRef(world, "refs/tags/v1.0.0")).toBe(before);
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
  });

  test("a push that is refused midway still restores every ruleset it lifted", async () => {
    world = build("never", "refs/tags/v1.0.1");
    const snapshot = await snap(world);
    await expect(
      switchRefs({
        api: world.api,
        repo: REPO,
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute: true,
      }).catch((e) => e),
    ).resolves.toBeInstanceOf(PushFailed);
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
    expect(world.stand.calls.filter((c) => c.startsWith("enable")).sort()).toEqual([
      "enable 1",
      "enable 2",
    ]);
  });

  test("a push that fails part way says exactly what was and was not pushed, by a fixed class (I6)", async () => {
    world = build("never", "refs/tags/v1.0.1");
    const snapshot = await snap(world);
    const error = (await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute: true,
    }).catch((e) => e)) as PushFailed;
    expect(error, world.stand.calls.join(" | ")).toBeInstanceOf(PushFailed);
    expect(error.word).toBe("hook-declined");
    // main first, then the tags in order: main and v1.0.0 landed, v1.0.1 was refused.
    expect(error.pushed).toEqual(["refs/heads/main", "refs/tags/v1.0.0"]);
    expect(error.notPushed).toEqual(["refs/tags/v1.0.1"]);
    expect(remoteRef(world, "refs/heads/main")).toBe(localSha(world, "refs/heads/main"));
    expect(remoteRef(world, "refs/tags/v1.0.1")).toBe(world.originTips["refs/tags/v1.0.1"]);
  });

  test("a head or a tag deleted on the remote since the clone is drift, in the snapshot and in the switch", async () => {
    world = build("never");
    // A head the clone knew, then deleted on GitHub: it is in before.json's tips, not on the remote.
    const tips = {
      ...world.originTips,
      "refs/heads/add-sourcedata-original": world.originTips["refs/heads/main"] as string,
    };
    const refused = (await takeSnapshot(world.api, REPO, world.work, "origin", tips).catch(
      (e) => e,
    )) as SwitchRefused;
    expect(refused).toBeInstanceOf(SwitchRefused);
    expect(refused.reason).toBe("remote-moved-since-clone (1 ref(s))");

    const snapshot = await snap(world);
    const gone = (await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot: { ...snapshot, originTips: tips },
      execute: true,
    }).catch((e) => e)) as SwitchRefused;
    expect(gone).toBeInstanceOf(SwitchRefused);
    expect(gone.reason).toBe("remote-moved-since-clone (1 ref(s))");

    // A tag deleted on the remote after the clone is drift too.
    run(world.remote, "update-ref", "-d", "refs/tags/v1.0.0");
    const tagGone = (await snap(world).catch((e) => e)) as SwitchRefused;
    expect(tagGone).toBeInstanceOf(SwitchRefused);
    expect(tagGone.reason).toMatch(/^remote-moved-since-clone/);
    expect(world.stand.calls).toEqual([]);
  });

  test("a switch that stopped part way is finished by running it again, and a ref that moved is still refused", async () => {
    world = build("never", "refs/tags/v1.0.1");
    const snapshot = await snap(world);
    const run1 = (await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute: true,
    }).catch((e) => e)) as PushFailed;
    expect(run1).toBeInstanceOf(PushFailed);
    expect(run1.pushed).toEqual(["refs/heads/main", "refs/tags/v1.0.0"]);

    // The cause is fixed (the hook no longer refuses the tag). Another person pushes a third
    // SHA to the ref the run had not reached: the lease still refuses, and nothing is lifted.
    const hook = join(world.remote, "hooks", "pre-receive");
    const blocked = readFileSync(hook, "utf8");
    writeFileSync(hook, blocked.replace("refs/tags/v1.0.1", "refs/none"));
    // Straight into the bare repository (a fetch runs no receive hook): the ruleset's hook would
    // refuse a tag update by a push, and this is somebody else's, not the switch's.
    const third = run(world.work, "commit-tree", "main^{tree}", "-p", "main", "-m", "someone else");
    run(world.work, "tag", "someone-else", third);
    run(world.remote, "fetch", "-q", world.work, "+refs/tags/someone-else:refs/tags/v1.0.1");
    world.stand.calls.length = 0;
    const refused = (await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute: true,
    }).catch((e) => e)) as SwitchRefused;
    expect(refused).toBeInstanceOf(SwitchRefused);
    expect(refused.reason).toMatch(/^remote-moved-since-clone|a remote ref moved/);
    expect(world.stand.calls).toEqual([]);

    // Put the ref back where the first run left it (the snapshot's SHA) and run again: it pushes
    // only what is left, and every ref ends at the rewrite.
    run(world.work, "tag", "at-the-snapshot", world.originTips["refs/tags/v1.0.1"] as string);
    run(world.remote, "fetch", "-q", world.work, "+refs/tags/at-the-snapshot:refs/tags/v1.0.1");
    const done = await switchRefs({
      api: world.api,
      repo: REPO,
      cloneDir: world.work,
      remote: "origin",
      snapshot,
      execute: true,
    });
    expect(done.pushed).toEqual(["refs/tags/v1.0.1"]);
    for (const ref of ["refs/heads/main", "refs/tags/v1.0.0", "refs/tags/v1.0.1"]) {
      expect(remoteRef(world, ref)).toBe(localSha(world, ref));
    }
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
  }, 60_000);

  test("git's stderr is classed into a fixed word, never kept", () => {
    const cases: Array<[string, string]> = [
      [" ! [rejected]        main -> main (stale info)\nerror: failed to push", "non-fast-forward"],
      [" ! [rejected] main -> main (fetch first)\nhint: Updates were rejected", "non-fast-forward"],
      [" ! [remote rejected] v1 -> v1 (pre-receive hook declined)", "hook-declined"],
      ["remote: error: GH013: Repository rule violations found", "hook-declined"],
      [
        "remote: Permission to x/y.git denied to someone.\nfatal: unable to access 'u': The requested URL returned error: 403",
        "auth",
      ],
      ["fatal: Authentication failed for 'https://github.com/x/y'", "auth"],
      ["fatal: unable to access 'u': Could not resolve host: github.com", "network"],
      ["timed out", "network"],
      ["something else entirely", "other"],
    ];
    for (const [stderr, word] of cases)
      expect(classifyPushError(stderr) as string, stderr).toBe(word);
  });

  test("a remote ref that moves while the protection is lifted is never overwritten, and the protection is restored", async () => {
    world = build("always");
    const snapshot = await snap(world);
    const other = join(world.dir, "other");
    run(world.dir, "clone", "-q", world.remote, other);
    run(other, "config", "user.email", "t@example.org");
    run(other, "config", "user.name", "t");
    writeFileSync(join(other, "late.txt"), "late\n");
    run(other, "add", ".");
    run(other, "commit", "-q", "-m", "landed during the window");
    world.stand.afterPut.current = async (_id, enforcement) => {
      if (enforcement === "disabled") {
        world.stand.afterPut.current = null;
        expect((await gitAsync(other, "push", "-q", "origin", "main")).status).toBe(0);
      }
    };
    await expect(
      switchRefs({
        api: world.api,
        repo: REPO,
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute: true,
      }).catch((e) => (e instanceof PushFailed ? e.word : e)),
    ).resolves.toBe("non-fast-forward");
    expect(remoteRef(world, "refs/heads/main")).toBe(run(other, "rev-parse", "main"));
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
  });

  test("a restore that GitHub does not apply is reported, never claimed", async () => {
    world = build("always");
    const snapshot = await snap(world);
    world.stand.afterPut.current = async (id, enforcement) => {
      if (enforcement === "disabled") world.stand.stuck.add(id);
    };
    await expect(
      switchRefs({
        api: world.api,
        repo: REPO,
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute: true,
      }),
    ).rejects.toThrow("restore failed for ruleset 2");
    expect(enforcement(world).tag).toBe("disabled");
  });

  test("a restore finds a ruleset left disabled by a crash and puts it back", async () => {
    world = build("always");
    const snapshot = await snap(world);
    const tag = world.stand.rulesets.get(2) as RulesetBody;
    world.stand.rulesets.set(2, { ...tag, enforcement: "disabled" });
    expect(await restoreSnapshot(world.api, REPO, snapshot, false)).toEqual([2]);
    expect(enforcement(world).tag).toBe("disabled");
    expect(await restoreSnapshot(world.api, REPO, snapshot, true)).toEqual([2]);
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
    expect(await restoreSnapshot(world.api, REPO, snapshot, true)).toEqual([]);
  });
});

/** The switch CLI as a real process, with the stand-in API and an isolated environment. */
function cliRun(w: World, args: string[], env: Record<string, string> = {}) {
  const cli = join(import.meta.dir, "../../scripts/scrub/github/switch.ts");
  const child = spawn("bun", ["run", cli, ...args], {
    // No FORCE_COLOR: Bun colors console.error under it, and the tests read the exact words.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "FORCE_COLOR")),
      NO_COLOR: "1",
      GITHUB_TOKEN: "test-token",
      GITHUB_API_BASE: w.stand.url,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, exited, stderr: () => stderr };
}

/** Take the snapshot with the CLI, from the before.json the real git tool wrote. */
async function cliSnapshot(w: World, extra: string[] = []): Promise<string> {
  const path = join(w.dir, "snapshot.json");
  const r = await cliRun(w, [
    "snapshot",
    "--repo",
    REPO,
    "--clone",
    w.work,
    "--before",
    w.before,
    "--out",
    path,
    ...extra,
  ]).exited;
  expect(r.code, r.stderr).toBe(0);
  return path;
}

/** Start `switch --execute` with the push held in the remote's hook, and return once it is held. */
async function startHeldSwitch(w: World, snapshotPath: string) {
  writeFileSync(join(w.dir, "slow"), "x");
  const run = cliRun(w, [
    "switch",
    "--repo",
    REPO,
    "--clone",
    w.work,
    "--snapshot",
    snapshotPath,
    "--execute",
  ]);
  // Generous: the hook holds the push until released, so waiting longer costs nothing.
  const deadline = Date.now() + 60_000;
  while (!existsSyncPath(join(w.dir, "slow.started")) && Date.now() < deadline) await Bun.sleep(25);
  expect(existsSyncPath(join(w.dir, "slow.started")), "the push reached the remote hook").toBe(
    true,
  );
  return run;
}

function existsSyncPath(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

describe("every lifted ruleset gets its turn to be restored", () => {
  const switchNow = (w: World, snapshot: Awaited<ReturnType<typeof takeSnapshot>>) =>
    switchRefs({
      api: w.api,
      repo: REPO,
      cloneDir: w.work,
      remote: "origin",
      snapshot,
      execute: true,
    });

  test("a first restore that fails persistently does not leave the second ruleset disabled, and both are reported", async () => {
    world = build("never");
    const snapshot = await snap(world);
    world.stand.afterPut.current = async (id, enforcement) => {
      if (id === 1 && enforcement === "disabled") world.stand.stuck.add(1);
    };
    const error = (await switchNow(world, snapshot).catch((e) => e)) as RestoreFailed;
    expect(error).toBeInstanceOf(RestoreFailed);
    expect(error.rulesetIds).toEqual([1]);
    expect(error.restored).toEqual([2]);
    expect(error.message).toContain("restore failed for ruleset 1");
    // Ruleset 1 is stuck and said so; ruleset 2, behind it, was still put back.
    expect(enforcement(world)).toEqual({ branch: "disabled", tag: "active" });
    expect(world.stand.calls.filter((c) => c === "enable 1")).toHaveLength(3);
    expect(world.stand.calls).toContain("enable 2");
  });

  test("when every restore fails, one error names every ruleset", async () => {
    world = build("never");
    const snapshot = await snap(world);
    world.stand.afterPut.current = async (id, enforcement) => {
      if (enforcement === "disabled") world.stand.stuck.add(id);
    };
    const error = (await switchNow(world, snapshot).catch((e) => e)) as RestoreFailed;
    expect(error).toBeInstanceOf(RestoreFailed);
    expect(error.rulesetIds).toEqual([1, 2]);
    expect(error.restored).toEqual([]);
    expect(error.message).toContain("restore failed for ruleset 1, 2");
  });

  test("a push that fails and a restore that fails arrive as one error carrying both", async () => {
    world = build("never", "refs/tags/v1.0.1");
    const snapshot = await snap(world);
    world.stand.afterPut.current = async (id, enforcement) => {
      if (id === 2 && enforcement === "disabled") world.stand.stuck.add(2);
    };
    const error = (await switchNow(world, snapshot).catch((e) => e)) as RestoreFailed;
    expect(error).toBeInstanceOf(RestoreFailed);
    expect(error.rulesetIds).toEqual([2]);
    expect(error.restored).toEqual([1]);
    expect(error.pushFailure).toBe("push failed: hook-declined");
    expect(error.message).toContain("restore failed for ruleset 2");
    expect(error.message).toContain("push failed: hook-declined");
  });

  test("a snapshot restore tries every drifted ruleset, even when the first is refused by the server", async () => {
    world = build("always");
    const snapshot = await snap(world);
    for (const id of [1, 2]) {
      const body = world.stand.rulesets.get(id) as RulesetBody;
      world.stand.rulesets.set(id, { ...body, enforcement: "disabled" });
    }
    world.stand.failPut.add(1);
    const error = (await restoreSnapshot(world.api, REPO, snapshot, true).catch(
      (e) => e,
    )) as RestoreFailed;
    expect(error).toBeInstanceOf(RestoreFailed);
    expect(error.rulesetIds).toEqual([1]);
    expect(error.restored).toEqual([2]);
    expect(enforcement(world)).toEqual({ branch: "disabled", tag: "active" });
  });

  test("a signal during the push restores, then exits 143 for SIGTERM, and the snapshot is what the CLI wrote", async () => {
    world = build("always");
    const snapshotPath = await cliSnapshot(world);
    const written = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      repo: string;
      rulesets: { id: number }[];
      refs: Record<string, string | null>;
    };
    expect(written.repo).toBe(REPO);
    expect(written.rulesets.map((r) => r.id)).toEqual([1, 2]);
    expect(Object.keys(written.refs).sort()).toEqual([
      "refs/heads/main",
      "refs/tags/v1.0.0",
      "refs/tags/v1.0.1",
    ]);
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
    const run = await startHeldSwitch(world, snapshotPath);
    expect(enforcement(world).tag).toBe("disabled");
    run.child.kill("SIGTERM");
    const result = await run.exited;
    expect(result.code, result.stderr).toBe(143);
    expect(world.stand.calls).toEqual(["disable 2", "enable 2"]);
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
  }, 90_000);

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    test(`${signal} during the push restores too, then exits ${code} (T3)`, async () => {
      world = build("always");
      const run = await startHeldSwitch(world, await cliSnapshot(world));
      expect(enforcement(world).tag).toBe("disabled");
      run.child.kill(signal);
      const result = await run.exited;
      expect(result.code, result.stderr).toBe(code);
      expect(result.stderr).toContain(`interrupted by ${signal}; protection restored`);
      expect(world.stand.calls).toEqual(["disable 2", "enable 2"]);
      expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
    }, 90_000);
  }

  test("a second signal during the restore is ignored and says so; the restore finishes (I5)", async () => {
    world = build("always");
    const run = await startHeldSwitch(world, await cliSnapshot(world));
    // The restore's PUT is held until the test has sent the second signal.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    world.stand.afterPut.current = async (_id, enforcement) => {
      if (enforcement === "active") {
        started.resolve();
        await release.promise;
      }
    };
    run.child.kill("SIGINT");
    await started.promise;
    run.child.kill("SIGTERM");
    // Give the second signal time to be handled while the restore is still in flight.
    const deadline = Date.now() + 30_000;
    while (!run.stderr().includes("restore in progress") && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    release.resolve();
    const result = await run.exited;
    expect(result.stderr).toContain("restore in progress");
    expect(result.code, result.stderr).toBe(130);
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
  }, 90_000);

  test("a signal during the push exits 5, and says so, when a ruleset cannot be restored", async () => {
    world = build("always");
    const snapshotPath = await cliSnapshot(world);
    world.stand.afterPut.current = async (id, enforcement) => {
      if (enforcement === "disabled") world.stand.stuck.add(id);
    };
    const run = await startHeldSwitch(world, snapshotPath);
    run.child.kill("SIGTERM");
    const result = await run.exited;
    expect(result.code).toBe(5);
    expect(result.stderr.split(RESTORE_ADVICE).length - 1, result.stderr).toBe(1);
    expect(result.stderr).toContain("restore failed for ruleset 2");
    expect(enforcement(world).tag).toBe("disabled");
  }, 90_000);

  test("the command exits 5, naming the push failure and the ruleset, when both fail", async () => {
    world = build("always", "refs/tags/v1.0.1");
    const snapshotPath = await cliSnapshot(world);
    world.stand.afterPut.current = async (id, enforcement) => {
      if (id === 2 && enforcement === "disabled") world.stand.stuck.add(2);
    };
    const result = await cliRun(world, [
      "switch",
      "--repo",
      REPO,
      "--clone",
      world.work,
      "--snapshot",
      snapshotPath,
      "--execute",
    ]).exited;
    expect(result.code).toBe(5);
    // Said once, however many exit paths saw the ruleset lifted.
    expect(result.stderr.split(RESTORE_ADVICE).length - 1, result.stderr).toBe(1);
    expect(result.stderr).toContain("restore failed for ruleset 2");
    expect(result.stderr).toContain("push failed: hook-declined");
  }, 60_000);

  test("the command exits 1, not refused, when only the push fails, and reports refs and advice (I6)", async () => {
    world = build("never", "refs/tags/v1.0.1");
    const snapshotPath = await cliSnapshot(world);
    const result = await cliRun(world, [
      "switch",
      "--repo",
      REPO,
      "--clone",
      world.work,
      "--snapshot",
      snapshotPath,
      "--execute",
    ]).exited;
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toContain("pushed refs/heads/main");
    expect(result.stdout).toContain("pushed tag 1 of 2");
    expect(result.stderr).toContain("switch: push failed: hook-declined");
    expect(result.stderr).toContain("switch: pushed branches=[refs/heads/main] tags=1");
    expect(result.stderr).toContain("switch: NOT pushed branches=[] tags=1");
    expect(result.stderr).toContain("the remote may be half rewritten");
    // Tag names are counted, never printed; git's own words never reach the terminal.
    expect(`${result.stdout}${result.stderr}`).not.toContain("v1.0.1");
    expect(result.stderr).not.toContain("blocked ref");
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
  }, 60_000);
});
