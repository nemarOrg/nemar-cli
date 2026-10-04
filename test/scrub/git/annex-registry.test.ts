/**
 * `git-scrub annex-registry`, run as the real program on real git-annex repositories.
 *
 * The shape mirrors the dataset it is for: an origin repository (A) with a `type=directory`
 * special remote standing in for `nemar-s3`, an uploader's own clone (B) that fetched the
 * content from that remote, and the operator's fresh clone (C) where the command runs. A key
 * therefore has TWO holders, the special remote and B, which is what the real dataset has, and
 * git-annex refuses `dead` while either remains.
 *
 * The expectations come from git-annex itself, read independently of the program: `whereis
 * --key --json` for who holds a key, and the key's location log on the `git-annex` branch for
 * whether it is dead. An exit code is not evidence of either, so none is trusted.
 *
 * Skipped when git-annex is unavailable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
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
  /** The operator's fresh clone: where the command runs. */
  repo: string;
  keymapPath: string;
  /** The special remote, and the uploader's clone: the two holders of every old key. */
  remoteUuid: string;
  uploaderUuid: string;
  oldKeys: string[];
  newKeys: string[];
  /** A key outside the keymap held by both: it must not be touched. */
  bystander: string;
}

function whereis(repo: string, key: string): string[] {
  // `whereis` exits 1 for a key with zero copies, so the JSON is read, not the exit code.
  const r = shAny(repo, ["git", "annex", "whereis", "--key", key, "--json"]);
  const line = r.out.split("\n").find((l) => l.startsWith("{"));
  if (!line) throw new Error("no whereis json");
  return (JSON.parse(line) as { whereis: { uuid: string }[] }).whereis.map((w) => w.uuid).sort();
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

function journal(repo: string): string[] {
  return readdirSync(join(repo, ".git", "annex", "journal"));
}

function build(): Registry {
  const root = makeRoot();
  const [a, b, c, store] = ["origin", "uploader", "operator", "store"].map((n) =>
    join(root, n),
  ) as [string, string, string, string];
  sh(root, ["mkdir", "-p", a, store]);

  // A: the published repository. Its content lives only at the special remote.
  git(a, "init", "-q", "-b", "main");
  sh(a, ["git", "annex", "init", "--quiet", "origin"]);
  sh(a, [
    "git",
    "annex",
    "initremote",
    "stand-in",
    "type=directory",
    `directory=${store}`,
    "encryption=none",
  ]);
  const remoteUuid = git(a, "config", "remote.stand-in.annex-uuid").trim();
  const oldKeys: string[] = [];
  for (let i = 0; i < 3; i++) {
    write(a, `sub-0${i}/eeg/rec.edf`, `recording-${i}-`.repeat(50));
    sh(a, ["git", "annex", "add", "--quiet", `sub-0${i}/eeg/rec.edf`]);
    oldKeys.push(sh(a, ["git", "annex", "lookupkey", `sub-0${i}/eeg/rec.edf`]).trim());
  }
  write(a, "bystander.edf", "bystander-".repeat(50));
  sh(a, ["git", "annex", "add", "--quiet", "bystander.edf"]);
  const bystander = sh(a, ["git", "annex", "lookupkey", "bystander.edf"]).trim();
  git(a, "commit", "-q", "-m", "data");
  sh(a, ["git", "annex", "copy", "--quiet", "--to", "stand-in", "."]);
  sh(a, ["git", "annex", "drop", "--quiet", "."]);

  // B: the uploader's own clone. It fetches the content from the special remote, which makes it
  // a second holder, and its record reaches A's git-annex branch the way a push would.
  sh(root, ["git", "clone", "-q", "--no-local", a, b]);
  sh(b, ["git", "annex", "init", "--quiet", "uploader"]);
  sh(b, ["git", "annex", "enableremote", "stand-in", `directory=${store}`]);
  sh(b, ["git", "annex", "get", "--quiet", "."]);
  sh(b, ["git", "annex", "merge"]);
  const uploaderUuid = git(b, "config", "annex.uuid").trim();
  git(a, "fetch", "-q", b, "git-annex:git-annex");

  // C: the operator's fresh clone. It sees both holders through origin's git-annex branch.
  sh(root, ["git", "clone", "-q", "--no-local", a, c]);
  sh(c, ["git", "annex", "init", "--quiet", "operator"]);

  const newKeys = oldKeys.map((k, i) => k.replace(/--[0-9a-f]{64}/, `--${sha(`scrubbed-${i}`)}`));
  write(
    root,
    "keymap.json",
    JSON.stringify(Object.fromEntries(oldKeys.map((k, i) => [k, newKeys[i]]))),
  );
  return {
    repo: c,
    keymapPath: join(root, "keymap.json"),
    remoteUuid,
    uploaderUuid,
    oldKeys,
    newKeys,
    bystander,
  };
}

function registry(fx: Registry, ...extra: string[]): Promise<{ code: number; out: string }> {
  return cli([
    "annex-registry",
    "--repo",
    fx.repo,
    "--keymap",
    fx.keymapPath,
    "--remote-uuid",
    fx.remoteUuid,
    ...extra,
  ]);
}

SUITE("annex-registry on a key with two holders", () => {
  let fx: Registry;

  beforeAll(() => {
    fx = build();
  }, 180_000);

  test("the fixture starts as the tests assume: two holders per old key, none for the new ones", () => {
    const both = [fx.remoteUuid, fx.uploaderUuid].sort();
    for (const key of fx.oldKeys) expect(whereis(fx.repo, key), key).toEqual(both);
    for (const key of fx.newKeys) expect(whereis(fx.repo, key)).toEqual([]);
    expect(whereis(fx.repo, fx.bystander)).toEqual(both);
    // The guard this command works around: with both holders recorded, dead is refused.
    const refused = shAny(fx.repo, ["git", "annex", "dead", "--key", fx.oldKeys[0] as string]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("still known to be present");
  });

  test("a dry run counts and changes nothing", async () => {
    const before = git(fx.repo, "rev-parse", "refs/heads/git-annex").trim();
    const r = await registry(fx);
    expect(r.code).toBe(0);
    expect(counts(r.out, "annex-registry: dry-run")).toEqual({
      oldKeys: 3,
      holdersToRetract: 6,
      newKeys: 3,
      newToRegister: 3,
    });
    expect(git(fx.repo, "rev-parse", "refs/heads/git-annex").trim()).toBe(before);
    expect(journal(fx.repo)).toEqual([]);
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
      fx.remoteUuid,
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
    const c = await cli(["annex-registry", "--repo", fx.repo, "--keymap", fx.keymapPath]);
    expect(c.code).toBe(2);
  });

  test("--execute retracts every holder, kills the old keys, and records the new ones only at the named remote", async () => {
    const r = await registry(fx, "--execute");
    expect(r.out).toContain("annex-registry: ok");
    expect(r.code).toBe(0);
    expect(counts(r.out, "annex-registry: ok")).toMatchObject({
      oldKeys: 3,
      holdersRetracted: 6,
      newKeys: 3,
      newRegistered: 3,
      oldStillHeld: 0,
      oldDead: 3,
      newPresent: 3,
      newForeignHolders: 0,
      deadRefused: 0,
    });

    // Asked of git-annex, not of the program.
    for (const key of fx.oldKeys) {
      expect(whereis(fx.repo, key), key).toEqual([]);
      const log = locationLog(fx.repo, key);
      for (const uuid of [fx.remoteUuid, fx.uploaderUuid]) {
        expect(log, `${key} ${uuid}`).toMatch(new RegExp(` X ${uuid}`));
      }
      expect(log).not.toMatch(/ 1 [0-9a-f-]{36}/);
    }
    for (const key of fx.newKeys) {
      expect(whereis(fx.repo, key), key).toEqual([fx.remoteUuid]);
      expect(locationLog(fx.repo, key)).not.toContain(fx.uploaderUuid);
    }
    // A key outside the keymap is exactly where it was.
    expect(whereis(fx.repo, fx.bystander)).toEqual([fx.remoteUuid, fx.uploaderUuid].sort());
    expect(locationLog(fx.repo, fx.bystander)).not.toContain(" X ");
  }, 120_000);

  test("a second run is a no-op: nothing retracted, nothing recorded, the git-annex branch does not move", async () => {
    const before = git(fx.repo, "rev-parse", "refs/heads/git-annex").trim();
    const r = await registry(fx, "--execute");
    expect(r.out).toContain("annex-registry: ok");
    expect(r.code).toBe(0);
    expect(counts(r.out, "annex-registry: ok")).toMatchObject({
      holdersRetracted: 0,
      newRegistered: 0,
      oldDead: 3,
      newPresent: 3,
    });
    expect(git(fx.repo, "rev-parse", "refs/heads/git-annex").trim()).toBe(before);
    expect(journal(fx.repo)).toEqual([]);
    const dry = await registry(fx);
    expect(counts(dry.out, "annex-registry: dry-run")).toMatchObject({
      holdersToRetract: 0,
      newToRegister: 0,
    });
  }, 120_000);

  test("the output carries counts only, never a key or a uuid", async () => {
    const r = await registry(fx);
    for (const secret of [
      ...fx.oldKeys,
      ...fx.newKeys,
      fx.remoteUuid,
      fx.uploaderUuid,
      sha("scrubbed-0"),
    ]) {
      expect(r.out).not.toContain(secret);
    }
    for (const key of [...fx.oldKeys, ...fx.newKeys]) {
      expect(r.out).not.toContain(key.split("--")[1]?.split(".")[0] as string);
    }
  });
});

SUITE("annex-registry with more than one named remote", () => {
  test("repeated --remote-uuid records the new keys at each named uuid and at no other", async () => {
    const fx = build();
    const r = await cli([
      "annex-registry",
      "--repo",
      fx.repo,
      "--keymap",
      fx.keymapPath,
      "--remote-uuid",
      fx.remoteUuid,
      "--remote-uuid",
      fx.uploaderUuid,
      "--execute",
    ]);
    expect(r.out).toContain("annex-registry: ok");
    expect(counts(r.out, "annex-registry: ok")).toMatchObject({
      newRegistered: 6,
      newPresent: 3,
      newForeignHolders: 0,
    });
    for (const key of fx.newKeys) {
      expect(whereis(fx.repo, key)).toEqual([fx.remoteUuid, fx.uploaderUuid].sort());
    }
    for (const key of fx.oldKeys) expect(whereis(fx.repo, key)).toEqual([]);
  }, 180_000);
});
