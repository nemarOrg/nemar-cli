/**
 * `readLocationLogsAt`: a key's location log read from a git-annex branch with plain git, as the
 * upstream re-pull's planner (ADR 0111) reads dead marks and `nemar-s3` presence from a BARE clone
 * that has no git-annex of its own.
 *
 * git-annex is the oracle and nothing stands in for it. The source repository is built by real
 * `git annex` commands (add, copy to a `type=directory` special remote, drop, dead, registerurl),
 * its git-annex branch is cloned bare, and every expectation comes from git-annex in the source:
 * `whereis --key --json` for who holds a key, and `examinekey` plus `git show` for the log text.
 * The URL key is there because its log is stored under an ESCAPED name (`:` is `&c`, `/` is `%`,
 * `&` is `&a`, `%` is `&s`) while the hash directory is the md5 of the key itself, which a plain
 * read has to reproduce exactly or it answers "no log" for a key git-annex knows. Two branches no
 * git-annex would write are added to the bare clone with `git mktree`: one whose tree names a log
 * by an object the clone does not have (what a partial or blobless clone looks like), and one
 * with no `uuid.log`; both must refuse rather than read as "no log".
 *
 * Skipped when git-annex is unavailable, and failed then in CI (`NEMAR_REQUIRE_SCRUB_TOOLS=1`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ContractError } from "../../../scripts/scrub/contract";
import {
  GitScrubError,
  isDead,
  locationLogs,
  presentIn,
  readLocationLogsAt,
} from "../../../scripts/scrub/git/git-lib";
import { HAVE_ANNEX, cleanupRoots, git, makeRoot, sh, shAny, sha, write } from "./fixture";

afterAll(cleanupRoots);

const SUITE = HAVE_ANNEX ? describe : describe.skip;

/** A key git-annex accepts and whose log holds every character the log's file name escapes. */
const URL_KEY = "URL--http://example.org/a&b%c";
const WEB_UUID = "00000000-0000-0000-0000-000000000001";

interface Fixture {
  source: string;
  bare: string;
  remoteUuid: string;
  sourceUuid: string;
  /** Held by the special remote only (dropped here). */
  remoteOnly: string;
  /** Held both here and at the special remote; an MD5E key. */
  both: string;
  /** No copy anywhere, and marked dead. */
  dead: string;
  /** A well-formed key nothing ever recorded. */
  unknown: string;
  /** A branch with `uuid.log` whose tree names `dead`'s log by an object this clone lacks. */
  partialRef: string;
  /** A branch naming `dead`'s real log but with no `uuid.log`: not a git-annex branch. */
  noUuidRef: string;
}

function whereis(repo: string, key: string): string[] {
  // `whereis` exits 1 for a key with zero copies, so the JSON is read, not the exit code.
  const r = shAny(repo, ["git", "annex", "whereis", "--key", key, "--json"]);
  const line = r.out.split("\n").find((l) => l.startsWith("{"));
  if (!line) throw new Error("no whereis json");
  return (JSON.parse(line) as { whereis: { uuid: string }[] }).whereis.map((w) => w.uuid).sort();
}

/** The key's log as git-annex stored it, for a key whose file name needs no escaping. */
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

function lookupkey(repo: string, path: string): string {
  return sh(repo, ["git", "annex", "lookupkey", path]).trim();
}

/**
 * A commit on `ref` in `repo` whose tree holds `files` (path -> blob oid), and nothing else.
 * `--missing` lets a tree name a blob the repository does not have, which is what a partial or
 * blobless clone looks like to a reader.
 */
function commitTree(repo: string, ref: string, files: Record<string, string>): void {
  const build = (entries: Array<[string[], string]>): string => {
    const lines: string[] = [];
    const dirs = new Map<string, Array<[string[], string]>>();
    for (const [parts, oid] of entries) {
      const [head, ...rest] = parts as [string, ...string[]];
      if (rest.length === 0) lines.push(`100644 blob ${oid}\t${head}`);
      else dirs.set(head, [...(dirs.get(head) ?? []), [rest, oid]]);
    }
    for (const [dir, inner] of dirs) lines.push(`040000 tree ${build(inner)}\t${dir}`);
    return sh(repo, ["git", "mktree", "--missing"], `${lines.join("\n")}\n`).trim();
  };
  const tree = build(Object.entries(files).map(([path, oid]) => [path.split("/"), oid]));
  const commit = sh(repo, ["git", "commit-tree", "-m", "fixture", tree]).trim();
  git(repo, "update-ref", ref, commit);
}

function build(): Fixture {
  const root = makeRoot();
  const source = join(root, "source");
  const store = join(root, "store");
  const bare = join(root, "bare.git");
  sh(root, ["mkdir", "-p", source, store]);
  git(source, "init", "-q", "-b", "main");
  sh(source, ["git", "annex", "init", "--quiet", "source"]);
  sh(source, [
    "git",
    "annex",
    "initremote",
    "nemar-s3",
    "type=directory",
    `directory=${store}`,
    "encryption=none",
  ]);
  const remoteUuid = git(source, "config", "remote.nemar-s3.annex-uuid").trim();
  const sourceUuid = git(source, "config", "annex.uuid").trim();

  write(source, "sub-01/eeg/remote-only.edf", "remote-only-".repeat(64));
  write(source, "sub-01/eeg/both.set", "both-".repeat(64));
  write(source, "sub-01/eeg/dead.edf", "dead-".repeat(64));
  sh(source, [
    "git",
    "annex",
    "add",
    "--quiet",
    "sub-01/eeg/remote-only.edf",
    "sub-01/eeg/dead.edf",
  ]);
  sh(source, ["git", "annex", "add", "--quiet", "--backend=MD5E", "sub-01/eeg/both.set"]);
  git(source, "commit", "-q", "-m", "data");
  const remoteOnly = lookupkey(source, "sub-01/eeg/remote-only.edf");
  const both = lookupkey(source, "sub-01/eeg/both.set");
  const dead = lookupkey(source, "sub-01/eeg/dead.edf");
  sh(source, ["git", "annex", "copy", "--quiet", "--to", "nemar-s3", "sub-01/eeg/remote-only.edf"]);
  sh(source, ["git", "annex", "copy", "--quiet", "--to", "nemar-s3", "sub-01/eeg/both.set"]);
  sh(source, ["git", "annex", "drop", "--quiet", "sub-01/eeg/remote-only.edf"]);
  sh(source, ["git", "annex", "drop", "--quiet", "--force", "sub-01/eeg/dead.edf"]);
  sh(source, ["git", "annex", "dead", "--quiet", "--key", dead]);
  sh(source, ["git", "annex", "registerurl", URL_KEY, "http://example.org/a&b%c"]);
  // Nothing may sit in the journal: a plain read sees only what the branch has committed.
  sh(source, ["git", "annex", "merge"]);

  sh(root, ["git", "clone", "-q", "--bare", "--no-local", source, bare]);

  // Two branches no git-annex would write, built in the bare clone from git-annex's own paths.
  const deadLog = sh(source, [
    "git",
    "annex",
    "examinekey",
    "--format=${hashdirlower}${key}.log",
    dead,
  ]).trim();
  const uuidLog = git(bare, "rev-parse", "refs/heads/git-annex:uuid.log").trim();
  const deadBlob = git(bare, "rev-parse", `refs/heads/git-annex:${deadLog}`).trim();
  const absentBlob = "0123456789abcdef0123456789abcdef01234567";
  expect(shAny(bare, ["git", "cat-file", "-e", absentBlob]).code).not.toBe(0);
  commitTree(bare, "refs/heads/partial-annex", { "uuid.log": uuidLog, [deadLog]: absentBlob });
  commitTree(bare, "refs/heads/annex-without-uuid", { [deadLog]: deadBlob });
  commitTree(bare, "refs/heads/log-is-a-directory", {
    "uuid.log": uuidLog,
    [`${deadLog}/inner`]: deadBlob,
  });
  return {
    source,
    bare,
    remoteUuid,
    sourceUuid,
    remoteOnly,
    both,
    dead,
    unknown: `SHA256E-s10--${sha("never-recorded")}.edf`,
    partialRef: "refs/heads/partial-annex",
    noUuidRef: "refs/heads/annex-without-uuid",
  };
}

SUITE("readLocationLogsAt", () => {
  let fx: Fixture;

  beforeAll(() => {
    fx = build();
  }, 120_000);

  test("the fixture is what the tests assume, as git-annex reports it", () => {
    expect(whereis(fx.source, fx.remoteOnly)).toEqual([fx.remoteUuid]);
    expect(whereis(fx.source, fx.both)).toEqual([fx.remoteUuid, fx.sourceUuid].sort());
    expect(whereis(fx.source, fx.dead)).toEqual([]);
    expect(whereis(fx.source, URL_KEY)).toEqual([WEB_UUID]);
    expect(fx.both.startsWith("MD5E-")).toBe(true);
    expect(git(fx.bare, "rev-parse", "--is-bare-repository").trim()).toBe("true");
  });

  test("in a bare clone, each log is the text git-annex stored, and a key never recorded is empty", async () => {
    const keys = [fx.remoteOnly, fx.both, fx.dead, fx.unknown];
    const logs = await readLocationLogsAt(fx.bare, "refs/heads/git-annex", keys);
    expect(logs).toEqual(keys.map((k) => locationLog(fx.source, k)));
    expect(logs[3]).toBe("");
    for (const log of logs.slice(0, 3)) expect(log.length).toBeGreaterThan(0);
  });

  test("presence and death read from it agree with whereis", async () => {
    const [remoteOnly, both, dead, url] = await readLocationLogsAt(fx.bare, "git-annex", [
      fx.remoteOnly,
      fx.both,
      fx.dead,
      URL_KEY,
    ]);
    expect([...presentIn(remoteOnly as string)].sort()).toEqual(whereis(fx.source, fx.remoteOnly));
    expect([...presentIn(both as string)].sort()).toEqual(whereis(fx.source, fx.both));
    expect(presentIn(dead as string).size).toBe(0);
    expect(isDead(dead as string)).toBe(true);
    expect(isDead(remoteOnly as string)).toBe(false);
    // The escaped file name: a read under the key's own spelling would find nothing here.
    expect([...presentIn(url as string)]).toEqual([WEB_UUID]);
  });

  test("it reads the same logs locationLogs reads through git-annex, in the source", async () => {
    const keys = [fx.remoteOnly, fx.both, fx.dead];
    expect(await readLocationLogsAt(fx.source, "git-annex", keys)).toEqual(
      await locationLogs(fx.source, keys),
    );
  });

  test("a ref that does not resolve refuses instead of answering no log for every key", async () => {
    const err = await readLocationLogsAt(fx.bare, "refs/heads/no-such-branch", [fx.dead]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitScrubError);
    expect((err as GitScrubError).message).toBe("refused: annex-ref-missing");
    expect((err as GitScrubError).detail).toBe("git rev-parse");
  });

  test("a ref or a key that would break the batch read is refused before git runs", async () => {
    for (const ref of ["", "-q", "git-annex:x", "git annex", "git-annex\n"]) {
      const err = await readLocationLogsAt(fx.bare, ref, [fx.dead]).catch((e: unknown) => e);
      expect(err, JSON.stringify(ref)).toBeInstanceOf(ContractError);
    }
    for (const key of ["", `${fx.dead}\nHEAD:README`]) {
      const err = await readLocationLogsAt(fx.bare, "git-annex", [key]).catch((e: unknown) => e);
      expect(err, JSON.stringify(key)).toBeInstanceOf(ContractError);
    }
  });

  test("a ref that resolves but is not a git-annex branch refuses, whatever it names", async () => {
    // HEAD and main are the dataset's own tree: no log is under them, and reading one as
    // "nothing recorded" would call every key absent and nothing dead.
    for (const ref of ["HEAD", "main", "refs/heads/main", fx.noUuidRef]) {
      const err = await readLocationLogsAt(fx.bare, ref, [fx.dead]).catch((e: unknown) => e);
      expect(err, ref).toBeInstanceOf(GitScrubError);
      expect((err as GitScrubError).message, ref).toBe("refused: annex-ref-not-git-annex");
      expect((err as GitScrubError).detail, ref).toBe("git ls-tree");
    }
    // The same log, under a branch that is one, reads.
    expect((await readLocationLogsAt(fx.bare, "git-annex", [fx.dead]))[0]).toBe(
      locationLog(fx.source, fx.dead),
    );
  });

  test("a log the tree names but this clone lacks refuses; a log it does not name is empty", async () => {
    const err = await readLocationLogsAt(fx.bare, fx.partialRef, [fx.dead]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitScrubError);
    expect((err as GitScrubError).message).toBe("refused: annex-log-unreadable");
    expect((err as GitScrubError).detail).toBe("git cat-file");
    // A log path that is a directory is not a log either.
    const dir = await readLocationLogsAt(fx.bare, "refs/heads/log-is-a-directory", [fx.dead]).catch(
      (e: unknown) => e,
    );
    expect((dir as GitScrubError).message).toBe("refused: annex-log-unreadable");
    // Genuinely absent: the branch never recorded these keys, which is an answer, not a failure.
    expect(await readLocationLogsAt(fx.bare, fx.partialRef, [fx.unknown, fx.remoteOnly])).toEqual([
      "",
      "",
    ]);
  });

  test("a key named twice gets the same answer twice, in the order asked", async () => {
    const keys = [URL_KEY, fx.dead, fx.unknown, fx.dead, URL_KEY, fx.unknown, fx.both];
    const once = await readLocationLogsAt(fx.bare, "git-annex", [
      URL_KEY,
      fx.dead,
      fx.unknown,
      fx.both,
    ]);
    const [url, dead, unknown, both] = once;
    expect(await readLocationLogsAt(fx.bare, "git-annex", keys)).toEqual([
      url,
      dead,
      unknown,
      dead,
      url,
      unknown,
      both,
    ]);
    expect(dead).toBe(locationLog(fx.source, fx.dead));
    expect(unknown).toBe("");
  });

  test("no keys is no logs, once the ref is known to exist", async () => {
    expect(await readLocationLogsAt(fx.bare, "git-annex", [])).toEqual([]);
    await expect(readLocationLogsAt(fx.bare, "no-such-ref", [])).rejects.toBeInstanceOf(
      GitScrubError,
    );
  });
});
