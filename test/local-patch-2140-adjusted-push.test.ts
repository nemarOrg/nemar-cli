/**
 * Local patch for nemarOrg/nemar-cli#2140: a push from a git-annex adjusted branch that is
 * refused because the remote main moved is integrated with `git annex merge` and retried; a
 * conflict stops cleanly (paths named, no markers, no MERGE_HEAD, HEAD unchanged). Real git and
 * git-annex against a local bare remote; no network, no NEMAR.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  describeIntegrationFailure,
  integrateRemoteIntoAdjustedBranch,
  pushToGitHub,
} from "../src/lib/git-annex/clone-push";
import { integrateRemoteBeforeValidationStep } from "../src/lib/upload/integrate-remote";

const TMP_DIR = join(tmpdir(), `nemar-2140-${process.pid}-${Date.now()}`);
const ADJ = "adjusted/main(unlocked)";
// A local .nemar/config.json of the shape the upload writes; never sent anywhere.
const CONFIG_FIXTURE = JSON.stringify({
  dataset_id: "nm000000",
  github_url: "https://example.invalid/nm000000",
  ssh_url: "git@example.invalid:nm000000.git",
  s3_prefix: "nm000000",
  s3_config: { bucket: "b", region: "r", public_url: "https://example.invalid" },
  created_at: "2026-11-13T00:00:00.000Z",
});

async function run(cmd: string[], cwd?: string) {
  const proc = spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function ok(cmd: string[], cwd?: string): Promise<string> {
  const r = await run(cmd, cwd);
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function writable(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    try {
      chmodSync(full, st.isDirectory() ? 0o755 : 0o644);
    } catch {}
    if (st.isDirectory()) writable(full);
  }
}

let counter = 0;
function fresh(name: string): string {
  counter++;
  const dir = join(TMP_DIR, `${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 7) % 251;
  return out;
}

/**
 * The upload's layout: a deposit repo on adjusted/main(unlocked) whose adjusted branch was
 * pushed to the bare remote's main (as `nemar dataset upload` does), plus a "bot" clone that
 * can commit to main the way NEMAR's pipeline does.
 */
async function depositWithRemote(name: string) {
  const root = fresh(name);
  const bare = join(root, "remote.git");
  mkdirSync(bare);
  await ok(["git", "init", "-q", "--bare", "-b", "main"], bare);
  const repo = join(root, "deposit");
  mkdirSync(repo);
  await ok(["git", "init", "-q", "-b", "main"], repo);
  await ok(["git", "config", "user.email", "t@example.invalid"], repo);
  await ok(["git", "config", "user.name", "Test"], repo);
  await ok(["git", "annex", "init", "-q", "nemar-deposit"], repo);
  writeFileSync(join(repo, "README.md"), "readme\n");
  writeFileSync(join(repo, "participants.tsv"), "participant_id\nsub-01\n");
  await ok(["git", "add", "."], repo);
  await ok(["git", "commit", "-qm", "init"], repo);
  await ok(["git", "annex", "adjust", "--unlock"], repo);
  writeFileSync(join(repo, "data1.edf"), bytes(20000, 1));
  await ok(["git", "annex", "add", "data1.edf"], repo);
  await ok(["git", "commit", "-qm", "data1"], repo);
  await ok(["git", "remote", "add", "origin", bare], repo);
  const first = await pushToGitHub(repo, "origin");
  if (!first.success) throw new Error(`first push failed: ${first.error}`);

  const bot = join(root, "bot");
  await ok(["git", "clone", "-q", bare, bot]);
  await ok(["git", "config", "user.email", "bot@example.invalid"], bot);
  await ok(["git", "config", "user.name", "nemar-bot"], bot);
  return { root, bare, repo, bot };
}

async function botCommit(bot: string, files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(bot, path, ".."), { recursive: true });
    writeFileSync(join(bot, path), content);
    await ok(["git", "add", path], bot);
  }
  await ok(["git", "commit", "-qm", message], bot);
  await ok(["git", "push", "-q", "origin", "main"], bot);
}

async function repoState(repo: string) {
  const head = (await ok(["git", "rev-parse", "HEAD"], repo)).trim();
  const branch = (await ok(["git", "symbolic-ref", "--short", "HEAD"], repo)).trim();
  const mergeHead =
    (await run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], repo)).exitCode === 0;
  const unmerged = (await ok(["git", "ls-files", "-u"], repo)).trim();
  const status = (await ok(["git", "status", "--porcelain"], repo)).trim();
  const markers = await run(["git", "grep", "-n", "-I", "-E", "^(<<<<<<<|>>>>>>>) "], repo);
  const files = (await ok(["git", "ls-tree", "-r", "--name-only", "HEAD"], repo))
    .trim()
    .split("\n");
  return { head, branch, mergeHead, unmerged, status, markers: markers.exitCode === 0, files };
}

beforeAll(async () => {
  if ((await run(["git", "annex", "version"])).exitCode !== 0) {
    throw new Error("git-annex is required for this test file");
  }
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    writable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("#2140 adjusted-branch push integrates a moved main", () => {
  test("(A) bot commit on main: push integrates with git annex merge and succeeds", async () => {
    const { repo, bare, bot } = await depositWithRemote("bot-moved");
    await botCommit(
      bot,
      { ".nemar/metadata.json": '{"v":1}\n' },
      "Update NEMAR metadata (pipeline: validated) [skip ci]",
    );
    writeFileSync(join(repo, "data2.edf"), bytes(20000, 2));
    await ok(["git", "annex", "add", "data2.edf"], repo);
    await ok(["git", "commit", "-qm", "data2"], repo);

    const result = await pushToGitHub(repo, "origin");
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);

    const state = await repoState(repo);
    expect(state.branch).toBe(ADJ);
    const remoteMain = (await ok(["git", "--git-dir", bare, "rev-parse", "main"])).trim();
    expect(remoteMain).toBe(state.head);
    expect(state.files).toContain(".nemar/metadata.json");
    expect(state.files).toContain("data2.edf");
    expect(state.files.some((f) => f.includes(".variant-"))).toBe(false);
    // Unlocked pointer files stay files (mode 100644), not symlinks, on main.
    const modes = await ok(["git", "--git-dir", bare, "ls-tree", "main", "data1.edf", "data2.edf"]);
    expect(
      modes
        .split("\n")
        .filter(Boolean)
        .every((l) => l.startsWith("100644")),
    ).toBe(true);
    // The bot's commit is in the pushed history: nothing was overwritten.
    const botTip = (await ok(["git", "rev-parse", "HEAD"], bot)).trim();
    expect(
      (await run(["git", "--git-dir", bare, "merge-base", "--is-ancestor", botTip, "main"]))
        .exitCode,
    ).toBe(0);
  }, 120_000);

  test("(B) conflicting README: clean stop naming the path, nothing changed or pushed", async () => {
    const { repo, bare, bot } = await depositWithRemote("readme-conflict");
    await botCommit(bot, { "README.md": "readme from remote\n" }, "remote edit");
    writeFileSync(join(repo, "README.md"), "readme from deposit\n");
    await ok(["git", "add", "README.md"], repo);
    await ok(["git", "commit", "-qm", "local edit"], repo);
    const before = await repoState(repo);
    const remoteBefore = (await ok(["git", "--git-dir", bare, "rev-parse", "main"])).trim();

    const result = await pushToGitHub(repo, "origin");
    expect(result.success).toBe(false);
    expect(result.error).toContain("README.md");
    expect(result.error).toContain("could not be integrated");

    const after = await repoState(repo);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(ADJ);
    expect(after.mergeHead).toBe(false);
    expect(after.unmerged).toBe("");
    expect(after.status).toBe("");
    expect(after.markers).toBe(false);
    expect((await ok(["git", "--git-dir", bare, "rev-parse", "main"])).trim()).toBe(remoteBefore);
  }, 120_000);

  test("(B2) annexed data changed on both sides: stop, no .variant- files", async () => {
    const { repo, bot } = await depositWithRemote("data-conflict");
    // The bot clone has no annex content; replacing the pointer file in git is a change to
    // the same path on the remote side.
    await botCommit(
      bot,
      {
        "data1.edf":
          "/annex/objects/SHA256E-s5--0000000000000000000000000000000000000000000000000000000000000000.edf\n",
      },
      "remote data edit",
    );
    await ok(["git", "rm", "-q", "--cached", "data1.edf"], repo);
    writeFileSync(join(repo, "data1.edf"), bytes(21000, 3));
    await ok(["git", "annex", "add", "data1.edf"], repo);
    await ok(["git", "commit", "-qm", "local data edit"], repo);
    const before = await repoState(repo);

    const direct = await integrateRemoteIntoAdjustedBranch(repo, "origin", ADJ, "main");
    expect(direct.success).toBe(false);
    if (!direct.success) {
      expect(direct.kind).toBe("conflict");
      expect(direct.conflicts.some((p) => p.startsWith("data1.edf"))).toBe(true);
      expect(describeIntegrationFailure(direct)).toContain("data1.edf");
    }
    const after = await repoState(repo);
    expect(after.head).toBe(before.head);
    expect(after.files.some((f) => f.includes(".variant-"))).toBe(false);
    expect(after.mergeHead).toBe(false);
    expect(after.status).toBe("");
  }, 120_000);

  test("(B3) without the merge-tree pre-check (git < 2.38): git-annex's .variant- resolution is undone", async () => {
    const { root, repo, bot } = await depositWithRemote("variant-rollback");
    await botCommit(
      bot,
      {
        "data1.edf":
          "/annex/objects/SHA256E-s5--0000000000000000000000000000000000000000000000000000000000000000.edf\n",
      },
      "remote data edit",
    );
    await ok(["git", "rm", "-q", "--cached", "data1.edf"], repo);
    writeFileSync(join(repo, "data1.edf"), bytes(21000, 4));
    await ok(["git", "annex", "add", "data1.edf"], repo);
    await ok(["git", "commit", "-qm", "local data edit"], repo);
    const before = await repoState(repo);
    const mainBefore = (await ok(["git", "rev-parse", "refs/heads/main"], repo)).trim();
    // A git that has no `merge-tree --write-tree`: the shim answers that one call with exit 129
    // (git's usage error) and hands every other call to the real git.
    const realGit = (await ok(["bash", "-c", "command -v git"])).trim();
    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    writeFileSync(
      join(shimDir, "git"),
      `#!/usr/bin/env bash\nif [ "$1" = merge-tree ]; then echo "usage: shim" >&2; exit 129; fi\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(shimDir, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath}`;
    let r: Awaited<ReturnType<typeof integrateRemoteIntoAdjustedBranch>>;
    try {
      r = await integrateRemoteIntoAdjustedBranch(repo, "origin", ADJ, "main");
    } finally {
      process.env.PATH = savedPath;
    }
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.kind).toBe("conflict");
      expect(r.error).toContain(".variant-");
      expect(r.error).toContain("unchanged");
    }
    const after = await repoState(repo);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(ADJ);
    expect(after.files.some((f) => f.includes(".variant-"))).toBe(false);
    expect(readdirSync(repo).some((f) => f.includes(".variant-"))).toBe(false);
    expect(after.mergeHead).toBe(false);
    expect(after.status).toBe("");
    expect((await ok(["git", "rev-parse", "refs/heads/main"], repo)).trim()).toBe(mainBefore);
  }, 120_000);

  test("remote tip already in HEAD: up-to-date, nothing changes", async () => {
    const { repo } = await depositWithRemote("up-to-date");
    const before = await repoState(repo);
    const r = await integrateRemoteIntoAdjustedBranch(repo, "origin", ADJ, "main");
    expect(r).toEqual({ success: true, outcome: "up-to-date" });
    expect((await repoState(repo)).head).toBe(before.head);
  }, 120_000);
});

describe("#2140 upload integrates origin/main before validation", () => {
  test("existing dataset (.nemar/config.json): integrated before the gates run", async () => {
    const { repo, bot } = await depositWithRemote("prevalidation");
    mkdirSync(join(repo, ".nemar"), { recursive: true });
    // .nemar/ is local state; keep it out of git like the upload does.
    writeFileSync(join(repo, ".git", "info", "exclude"), ".nemar/\n");
    writeFileSync(join(repo, ".nemar", "config.json"), CONFIG_FIXTURE);
    await botCommit(bot, { CHANGES: "1.0.0 bot\n" }, "bot");
    const step = await integrateRemoteBeforeValidationStep(repo, {});
    expect(step.status).toBe("ok");
    if (step.status === "ok") expect(step.value).toBe("integrated");
    expect((await repoState(repo)).files).toContain("CHANGES");
    expect(existsSync(join(repo, "CHANGES"))).toBe(true);
  }, 120_000);

  test("new dataset (no config) and dry run: nothing fetched or merged", async () => {
    const { repo, bot } = await depositWithRemote("prevalidation-skip");
    await botCommit(bot, { CHANGES: "1.0.0 bot\n" }, "bot");
    const before = (await repoState(repo)).head;
    const fresh = await integrateRemoteBeforeValidationStep(repo, {});
    expect(fresh).toEqual({ status: "ok", value: "skipped-new-dataset" });
    mkdirSync(join(repo, ".nemar"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), ".nemar/\n");
    writeFileSync(join(repo, ".nemar", "config.json"), CONFIG_FIXTURE);
    const dry = await integrateRemoteBeforeValidationStep(repo, { dryRun: true });
    expect(dry).toEqual({ status: "ok", value: "skipped-dry-run" });
    expect((await repoState(repo)).head).toBe(before);
  }, 120_000);

  test("conflict before validation: the upload stops (FAIL), tree unchanged", async () => {
    const { repo, bot } = await depositWithRemote("prevalidation-conflict");
    mkdirSync(join(repo, ".nemar"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), ".nemar/\n");
    writeFileSync(join(repo, ".nemar", "config.json"), CONFIG_FIXTURE);
    await botCommit(bot, { "participants.tsv": "participant_id\nsub-02\n" }, "bot");
    writeFileSync(join(repo, "participants.tsv"), "participant_id\nsub-03\n");
    await ok(["git", "add", "participants.tsv"], repo);
    await ok(["git", "commit", "-qm", "local"], repo);
    const before = await repoState(repo);
    const step = await integrateRemoteBeforeValidationStep(repo, {});
    expect(step.status).toBe("fail");
    const after = await repoState(repo);
    expect(after.head).toBe(before.head);
    expect(after.markers).toBe(false);
    expect(after.mergeHead).toBe(false);
    expect(after.status).toBe("");
  }, 120_000);
});
