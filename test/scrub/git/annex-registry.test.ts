/**
 * `git-scrub annex-registry`, run as the real program in a real git-annex repository with a real
 * `type=directory` special remote standing in for `nemar-s3`.
 *
 * The expectations come from git-annex itself, read independently of the program: `whereis
 * --key --json` for where a key is, and the key's location log on the `git-annex` branch for
 * whether it is dead. An exit code is not evidence of either, so none is trusted.
 *
 * Skipped when git-annex is unavailable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  HAVE_ANNEX,
  cleanupRoots,
  cli,
  counts,
  git,
  makeRoot,
  sh,
  shAny,
  sha,
  write,
} from "./fixture";

afterAll(cleanupRoots);

const SUITE = HAVE_ANNEX ? describe : describe.skip;

interface Registry {
  repo: string;
  keymapPath: string;
  uuid: string;
  oldKeys: string[];
  newKeys: string[];
  /** A key outside the keymap, present at the remote: it must not be touched. */
  bystander: string;
}

function whereis(repo: string, key: string): string[] {
  // `whereis` exits 1 for a key with zero copies, so the JSON is read, not the exit code.
  const r = shAny(repo, ["git", "annex", "whereis", "--key", key, "--json"]);
  const line = r.out.split("\n").find((l) => l.startsWith("{"));
  if (!line) throw new Error("no whereis json");
  return (JSON.parse(line) as { whereis: { uuid: string }[] }).whereis.map((w) => w.uuid);
}

/** The key's location log as git-annex stored it on the git-annex branch. */
function locationLog(repo: string, key: string): string {
  const path = sh(repo, [
    "git",
    "annex",
    "examinekey",
    "--format=${hashdirlower}${key}.log",
    key,
  ]).trim();
  return shAny(repo, ["git", "show", `git-annex:${path}`]).out;
}

function build(dropLocal: boolean): Registry {
  const root = makeRoot();
  const repo = join(root, "repo");
  const store = join(root, "store");
  sh(root, ["mkdir", "-p", repo, store]);
  git(repo, "init", "-q", "-b", "main");
  sh(repo, ["git", "annex", "init", "--quiet", "clone"]);
  sh(repo, [
    "git",
    "annex",
    "initremote",
    "stand-in",
    "type=directory",
    `directory=${store}`,
    "encryption=none",
  ]);
  const uuid = git(repo, "config", "remote.stand-in.annex-uuid").trim();
  const oldKeys: string[] = [];
  for (let i = 0; i < 3; i++) {
    write(repo, `sub-0${i}/eeg/rec.edf`, `recording-${i}-`.repeat(50));
    sh(repo, ["git", "annex", "add", "--quiet", `sub-0${i}/eeg/rec.edf`]);
    oldKeys.push(sh(repo, ["git", "annex", "lookupkey", `sub-0${i}/eeg/rec.edf`]).trim());
  }
  write(repo, "bystander.edf", "bystander-".repeat(50));
  sh(repo, ["git", "annex", "add", "--quiet", "bystander.edf"]);
  const bystander = sh(repo, ["git", "annex", "lookupkey", "bystander.edf"]).trim();
  git(repo, "commit", "-q", "-m", "data");
  sh(repo, ["git", "annex", "copy", "--quiet", "--to", "stand-in", "."]);
  // A scrub clone has no content of its own: only the special remote holds it.
  if (dropLocal) sh(repo, ["git", "annex", "drop", "--quiet", "."]);
  const newKeys = oldKeys.map((k, i) => k.replace(/--[0-9a-f]{64}/, `--${sha(`scrubbed-${i}`)}`));
  const keymapPath = join(root, "keymap.json");
  write(
    root,
    "keymap.json",
    JSON.stringify(Object.fromEntries(oldKeys.map((k, i) => [k, newKeys[i]]))),
  );
  return { repo, keymapPath, uuid, oldKeys, newKeys, bystander };
}

SUITE("annex-registry in a real git-annex repository", () => {
  let fx: Registry;

  beforeAll(() => {
    fx = build(true);
  }, 120_000);

  test("the fixture starts as the tests assume: the old keys are at the remote, the new ones nowhere", () => {
    for (const key of fx.oldKeys) expect(whereis(fx.repo, key)).toContain(fx.uuid);
    for (const key of fx.newKeys) expect(whereis(fx.repo, key)).toEqual([]);
    expect(whereis(fx.repo, fx.bystander)).toContain(fx.uuid);
  });

  test("a dry run counts and changes nothing", async () => {
    const before = git(fx.repo, "rev-parse", "refs/heads/git-annex").trim();
    const r = await cli([
      "annex-registry",
      "--repo",
      fx.repo,
      "--keymap",
      fx.keymapPath,
      "--remote-uuid",
      fx.uuid,
    ]);
    expect(r.code).toBe(0);
    const c = counts(r.out, "annex-registry: dry-run");
    expect(c).toEqual({ newKeys: 3, oldKeys: 3 });
    expect(git(fx.repo, "rev-parse", "refs/heads/git-annex").trim()).toBe(before);
    for (const key of fx.oldKeys) expect(whereis(fx.repo, key)).toContain(fx.uuid);
    for (const key of fx.newKeys) expect(whereis(fx.repo, key)).toEqual([]);
  });

  test("refuses a repository without git-annex, and a remote that is not a uuid", async () => {
    const plain = join(fx.repo, "..", "plain");
    sh(join(fx.repo, ".."), ["mkdir", "-p", plain]);
    git(plain, "init", "-q", "-b", "main");
    const a = await cli([
      "annex-registry",
      "--repo",
      plain,
      "--keymap",
      fx.keymapPath,
      "--remote-uuid",
      fx.uuid,
    ]);
    expect(a.code).not.toBe(0);
    expect(a.out).toContain("annex-not-initialized");
    const b = await cli([
      "annex-registry",
      "--repo",
      fx.repo,
      "--keymap",
      fx.keymapPath,
      "--remote-uuid",
      "nemar-s3",
    ]);
    expect(b.code).not.toBe(0);
    expect(b.out).toContain("refused: contract");
  });

  test("--execute registers the new keys, retracts the old ones and marks them dead", async () => {
    const r = await cli([
      "annex-registry",
      "--repo",
      fx.repo,
      "--keymap",
      fx.keymapPath,
      "--remote-uuid",
      fx.uuid,
      "--execute",
    ]);
    expect(r.out).toContain("annex-registry: ok");
    expect(r.code).toBe(0);
    expect(counts(r.out, "annex-registry: ok")).toMatchObject({
      newKeys: 3,
      oldKeys: 3,
      newPresent: 3,
      oldRetracted: 3,
      oldDead: 3,
    });

    // Asked of git-annex, not of the program.
    for (const key of fx.newKeys) {
      expect(whereis(fx.repo, key), key).toEqual([fx.uuid]);
      expect(locationLog(fx.repo, key)).toMatch(new RegExp(` 1 ${fx.uuid}`));
    }
    for (const key of fx.oldKeys) {
      expect(whereis(fx.repo, key), key).toEqual([]);
      const log = locationLog(fx.repo, key);
      expect(log).toMatch(new RegExp(` X ${fx.uuid}`));
      expect(log).not.toMatch(new RegExp(` 1 ${fx.uuid}`));
    }
    // A key outside the keymap is exactly where it was.
    expect(whereis(fx.repo, fx.bystander)).toEqual([fx.uuid]);
    expect(locationLog(fx.repo, fx.bystander)).not.toContain(" X ");
  }, 120_000);

  test("a key another repository still records is not killed; the run fails, and succeeds once it is released", async () => {
    // This repository keeps the content locally, so git-annex's own guard ("still known to be
    // present in some locations") refuses `dead`, and `--force` does not lift it. The refusal is
    // counted and fails the run; the command is idempotent, so the operator releases the key
    // and runs it again.
    const held = build(false);
    const args = [
      "annex-registry",
      "--repo",
      held.repo,
      "--keymap",
      held.keymapPath,
      "--remote-uuid",
      held.uuid,
      "--execute",
    ];
    const refused = await cli(args);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("annex-registry: FAILED");
    expect(counts(refused.out, "annex-registry: FAILED")).toMatchObject({
      oldRetracted: 3,
      oldDead: 0,
      deadRefused: 3,
    });
    for (const key of held.oldKeys) expect(locationLog(held.repo, key)).not.toMatch(/ X /);

    sh(held.repo, ["git", "annex", "drop", "--force", "--quiet", "."]);
    const again = await cli(args);
    expect(again.out).toContain("annex-registry: ok");
    expect(again.code).toBe(0);
    for (const key of held.oldKeys) {
      expect(locationLog(held.repo, key)).toMatch(new RegExp(` X ${held.uuid}`));
      expect(whereis(held.repo, key)).toEqual([]);
    }
  }, 120_000);

  test("the output carries counts only, never a key", async () => {
    const r = await cli([
      "annex-registry",
      "--repo",
      fx.repo,
      "--keymap",
      fx.keymapPath,
      "--remote-uuid",
      fx.uuid,
    ]);
    for (const key of [...fx.oldKeys, ...fx.newKeys]) {
      expect(r.out).not.toContain(key);
      expect(r.out).not.toContain(key.split("--")[1]?.split(".")[0] as string);
    }
  });
});
