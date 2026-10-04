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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type RulesetBody,
  SwitchRefused,
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
  const afterPut: Stand["afterPut"] = { current: null };
  const server = Bun.serve({
    port: 0,
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
        return Response.json(
          [...rulesets.values()].map((r) => ({ id: r.id, name: r.name, target: r.target })),
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
    afterPut,
    stop: () => server.stop(true),
  };
}

const run = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
};

/** Async git: a push runs the hook, which calls back into this process's server, so a sync spawn would deadlock it. */
function gitAsync(
  cwd: string,
  ...args: string[]
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
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
}

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
if [ -f ${slowFile} ]; then sleep 6; fi
exit 0
`;
}

function build(bypassBranch: "always" | "never", blockRef = "refs/none"): World {
  const dir = mkdtempSync(join(tmpdir(), "switch-"));
  const remote = join(dir, "remote.git");
  const work = join(dir, "work");
  const stand = standIn(bypassBranch);
  run(dir, "init", "--bare", "-q", "remote.git");
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
  run(work, "remote", "add", "origin", remote);
  run(work, "push", "-q", "origin", "main", "v1.0.0", "v1.0.1");
  writeFileSync(
    join(remote, "hooks", "pre-receive"),
    hookScript(stand, join(dir, "slow"), blockRef),
  );
  chmodSync(join(remote, "hooks", "pre-receive"), 0o755);
  // The rewritten history: same shape, different commits, moved tags.
  const treeA = run(work, "rev-parse", "v1.0.0^{tree}");
  const treeB = run(work, "rev-parse", "main^{tree}");
  const a2 = run(work, "commit-tree", treeA, "-m", "A2");
  const b2 = run(work, "commit-tree", treeB, "-p", a2, "-m", "B2");
  run(work, "update-ref", "refs/heads/main", b2);
  run(work, "tag", "-f", "-a", "v1.0.0", a2, "-m", "one again");
  run(work, "tag", "-f", "v1.0.1", b2);
  return { dir, remote, work, stand, api: { base: stand.url, token: "test-token" } };
}

let world: World;
afterEach(() => {
  world?.stand.stop();
  if (world) rmSync(world.dir, { recursive: true, force: true });
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
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
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
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
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
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
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
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
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
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
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
    ).rejects.toThrow("a remote ref moved since the snapshot");
    expect(world.stand.calls).toEqual([]);
    expect(remoteRef(world, "refs/heads/main")).toBe(moved);
  });

  test("a ruleset whose enforcement changed after the snapshot", async () => {
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
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
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
    await expect(
      switchRefs({
        api: world.api,
        repo: "nemarDatasets/nm999999",
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute: true,
      }),
    ).rejects.toThrow(SwitchRefused);
  });
});

describe("a failure leaves the protection on", () => {
  test("a lift that GitHub acknowledges but does not apply stops before any push", async () => {
    world = build("always");
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
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
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
    await expect(
      switchRefs({
        api: world.api,
        repo: REPO,
        cloneDir: world.work,
        remote: "origin",
        snapshot,
        execute: true,
      }),
    ).rejects.toThrow("git push exited");
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
    expect(world.stand.calls.filter((c) => c.startsWith("enable")).sort()).toEqual([
      "enable 1",
      "enable 2",
    ]);
  });

  test("a remote ref that moves while the protection is lifted is never overwritten, and the protection is restored", async () => {
    world = build("always");
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
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
      }),
    ).rejects.toThrow("git push exited");
    expect(remoteRef(world, "refs/heads/main")).toBe(run(other, "rev-parse", "main"));
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
  });

  test("a restore that GitHub does not apply is reported, never claimed", async () => {
    world = build("always");
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
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
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
    const tag = world.stand.rulesets.get(2) as RulesetBody;
    world.stand.rulesets.set(2, { ...tag, enforcement: "disabled" });
    expect(await restoreSnapshot(world.api, REPO, snapshot, false)).toEqual([2]);
    expect(enforcement(world).tag).toBe("disabled");
    expect(await restoreSnapshot(world.api, REPO, snapshot, true)).toEqual([2]);
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
    expect(await restoreSnapshot(world.api, REPO, snapshot, true)).toEqual([]);
  });

  test("SIGTERM during the push restores the protection before the process exits", async () => {
    world = build("always");
    const snapshotPath = join(world.dir, "snapshot.json");
    const snapshot = await takeSnapshot(world.api, REPO, world.work, "origin");
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    writeFileSync(join(world.dir, "slow"), "x");
    const cli = join(import.meta.dir, "../../scripts/scrub/github/switch.ts");
    const child = spawn(
      "bun",
      [
        "run",
        cli,
        "switch",
        "--repo",
        REPO,
        "--clone",
        world.work,
        "--snapshot",
        snapshotPath,
        "--execute",
      ],
      {
        env: { ...process.env, GITHUB_TOKEN: "test-token", GITHUB_API_BASE: world.stand.url },
        stdio: "ignore",
      },
    );
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    const deadline = Date.now() + 20_000;
    while (enforcement(world).tag !== "disabled" && Date.now() < deadline) await Bun.sleep(25);
    expect(enforcement(world).tag).toBe("disabled");
    child.kill("SIGTERM");
    await exited;
    expect(existsSync(snapshotPath)).toBe(true);
    expect(enforcement(world)).toEqual({ branch: "active", tag: "active" });
  }, 40_000);
});
