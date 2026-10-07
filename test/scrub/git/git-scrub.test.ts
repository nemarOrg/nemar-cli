/**
 * The git stage of the privacy scrub, run as the real program on real repositories.
 *
 * Every test drives `git-scrub.ts` as a process (the way an operator runs it), which in turn
 * runs `rewrite_history.py` through `uv run --with git-filter-repo`. The expectations are read
 * back with PLAIN git (`git grep` over `git rev-list --all`, `ls-tree`, `cat-file`) and, for
 * symlinks, from git-annex itself (`examinekey`), never from the program's own helpers. Each
 * check of the rewrite has a twin that proves the verifier is not vacuous: the same repository,
 * damaged in exactly one way, must fail with that way's fixed reason.
 *
 * All values are invented. The CLI must print counts and fixed words only, and a test asserts
 * that no fixture name, key or value appears in its output.
 *
 * Skipped when `uv` or git-filter-repo is unavailable; the symlink tests also need git-annex.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HashScanner } from "../../../scripts/scrub/git/git-lib";
import {
  BINARY,
  CHANGES_TEXT,
  CLI,
  COMPACT_NEW,
  DESCRIPTION_NEW,
  DESCRIPTION_NEW_V2,
  ENV,
  HAVE_ANNEX,
  HAVE_REWRITE_TOOLS,
  KEEP,
  KEYMAP,
  LATIN1_JSON,
  NEW_A,
  NEW_B,
  NEW_C,
  NOT_JSON,
  OLD_A,
  OLD_B,
  OLD_C,
  PARTICIPANTS_NEW,
  PLAN,
  PRIVACY_NOTE,
  PROVENANCE_C3,
  PROVENANCE_SCRUBBED,
  type PointerFixture,
  README_TEXT,
  type SymlinkFixture,
  allCommits,
  annexKey,
  anyObjectContains,
  buildPointerFixture,
  buildSymlinkFixture,
  cleanupRoots,
  cli,
  cloneOf,
  commitAll,
  copyTree,
  counts,
  datasetUrl,
  fileAt,
  git,
  linkAt,
  makeRoot,
  pointer,
  refTips,
  s3PlanFor,
  sh,
  shAny,
  sha,
  treePaths,
  write,
} from "./fixture";

afterAll(cleanupRoots);

const SUITE = HAVE_REWRITE_TOOLS ? describe : describe.skip;
const ANNEX_SUITE = HAVE_REWRITE_TOOLS && HAVE_ANNEX ? describe : describe.skip;

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** `git grep` over every commit of every ref: 0 when something matched, 1 when nothing did. */
function grepAll(repo: string, needle: string): number {
  const revs = git(repo, "rev-list", "--all").split("\n").filter(Boolean);
  return shAny(repo, ["git", "grep", "-F", "-q", needle, ...revs]).code;
}

function commitCounts(repo: string, refs: string[]): Record<string, number> {
  return Object.fromEntries(
    refs.map((r) => [r, Number(git(repo, "rev-list", "--count", r).trim())]),
  );
}

const TAGS = ["v1.0.1", "v1.0.2", "v1.1.0"];
const REFS = ["main", "refs/remotes/origin/main", ...TAGS.map((t) => `refs/tags/${t}`)];

// -----------------------------------------------------------------------------------------
// Pointer-file dataset: the full path through rewrite and verify
// -----------------------------------------------------------------------------------------

describe("the old-key scanner reads blobs in chunks", () => {
  // A supplement to the CLI test below, which cannot choose where a pipe splits a blob: a hash
  // that straddles two chunks must still be found, at every split point.
  const hash = sha("straddle");
  const text = `xx${hash}yy`;
  const bytes = (s: string) => new TextEncoder().encode(s);

  test("a hash split across two or three chunks is found; a near miss is not", () => {
    for (let cut = 1; cut < text.length; cut++) {
      const scanner = new HashScanner(new Set([hash]));
      scanner.push(bytes(text.slice(0, cut)));
      scanner.push(bytes(text.slice(cut)));
      expect(scanner.found, `cut ${cut}`).toBe(true);
    }
    const three = new HashScanner(new Set([hash]));
    for (const part of [text.slice(0, 20), text.slice(20, 50), text.slice(50)]) {
      three.push(bytes(part));
    }
    expect(three.found).toBe(true);
    // Inside a longer run of hex digits, and in capitals.
    for (const embedded of [`abcdef01${hash}23456789`, hash.toUpperCase()]) {
      const scanner = new HashScanner(new Set([hash]));
      scanner.push(bytes(embedded.slice(0, 33)));
      scanner.push(bytes(embedded.slice(33)));
      expect(scanner.found, embedded.length.toString()).toBe(true);
    }
    const miss = new HashScanner(new Set([hash]));
    miss.push(bytes(text.slice(0, 40)));
    miss.push(bytes(`0${text.slice(41)}`));
    expect(miss.found).toBe(false);
  });
});

SUITE("pointer-file dataset", () => {
  let fx: PointerFixture;
  let snapshot: string;
  let pristine: string;
  let rewriteOut: { code: number; out: string };
  let verifyOut: { code: number; out: string };
  let beforeCounts: Record<string, number>;
  let beforeAnnex: { local: string; origin: string };
  let beforeTips: string;

  beforeAll(async () => {
    fx = buildPointerFixture();
    snapshot = join(fx.root, "before.json");
    pristine = join(fx.root, "pristine");
    copyTree(fx.clone, pristine);
    beforeCounts = commitCounts(fx.clone, REFS);
    beforeAnnex = {
      local: git(fx.clone, "rev-parse", "refs/heads/git-annex").trim(),
      origin: git(fx.clone, "rev-parse", "refs/remotes/origin/git-annex").trim(),
    };
    beforeTips = refTips(fx.clone);
    rewriteOut = await cli([
      "rewrite",
      "--repo",
      fx.clone,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--expect-remote",
      datasetUrl("nm000999"),
      "--snapshot-out",
      snapshot,
    ]);
    // The fixture holds two plan files the rewrite cannot parse on purpose (not JSON, not
    // UTF-8), so the verifier is told to accept them; a later test shows it refuses otherwise.
    verifyOut = await cli([
      "verify",
      "--repo",
      fx.clone,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--s3-plan",
      fx.s3PlanPath,
      "--before",
      snapshot,
      "--allow-unparseable-json",
    ]);
  }, 180_000);

  test("the fixture is what the tests assume: eight commits, and the old keys are in the source", () => {
    expect(Number(git(fx.src, "rev-list", "--count", "main").trim())).toBe(8);
    // The positive control for every `git grep` below: it finds the keys when they are there.
    for (const key of [OLD_A, OLD_B, OLD_C]) expect(grepAll(fx.src, key)).toBe(0);
    expect(treePaths(fx.src, "main")).toContain("sub-02/photo-B.jpg");
  });

  test("rewrite and verify both succeed", () => {
    expect(rewriteOut.out).toContain("rewrite: ok");
    expect(rewriteOut.code).toBe(0);
    expect(verifyOut.out).toContain("verify: ok");
    expect(verifyOut.code).toBe(0);
    // No `sourcedata/sourcedata_provenance.json` here: the provenance exception keeps nothing.
    expect(counts(verifyOut.out, "verify: ok")).toMatchObject({
      provenanceHashesKept: 0,
      provenanceBlobsKept: 0,
    });
  });

  test("the output is counts and fixed words only", () => {
    const c = counts(rewriteOut.out, "rewrite: ok");
    // OLD_A in 8 commits' worth of one blob, OLD_B and OLD_C: three distinct pointer blobs.
    expect(c.blobsRewritten).toBe(3);
    expect(c.jsonBlanked).toBe(5);
    expect(c.jsonUntouched).toBe(2);
    expect(c.jsonOpsApplied).toBe(3);
    expect(c.jsonOpsUntouched).toBe(0);
    expect(c.dropPathsNeverSeen).toBe(1);
    expect(c.commitsSeen).toBe(8);
    expect(c.commitsRewritten).toBe(8);
    expect(c.appended).toBe(16);
    for (const secret of [
      "Alice",
      "photo",
      "never/present",
      "sub-01",
      sha("old-a"),
      sha("old-b"),
      sha("new-a"),
      OLD_A,
    ]) {
      expect(rewriteOut.out).not.toContain(secret);
      expect(verifyOut.out).not.toContain(secret);
    }
  });

  test("tag names and kinds are kept, each on its own commit, and the commit counts match", () => {
    expect(git(fx.clone, "tag", "-l").split("\n").filter(Boolean).sort()).toEqual(TAGS);
    expect(git(fx.clone, "cat-file", "-t", "v1.0.2").trim()).toBe("tag");
    expect(git(fx.clone, "cat-file", "-t", "v1.0.1").trim()).toBe("commit");
    expect(git(fx.clone, "tag", "-l", "-n1", "v1.0.2")).toContain("second release, annotated");
    const tagged = TAGS.map((t) => git(fx.clone, "rev-parse", `${t}^{commit}`).trim());
    expect(new Set(tagged).size).toBe(3);
    expect(commitCounts(fx.clone, REFS)).toEqual(beforeCounts);
    // The tags still point at the commits they described: v1.0.1 has no description change yet.
    expect(fileAt(fx.clone, "v1.0.1", "dataset_description.json")).toBe(DESCRIPTION_NEW);
    expect(fileAt(fx.clone, "v1.0.2", "dataset_description.json")).toBe(DESCRIPTION_NEW_V2);
    expect(refTips(fx.clone)).not.toBe(beforeTips);
  });

  test("an emptied commit is kept: the last commit's tree equals its parent's", () => {
    // c7 only added a dropped image and changed a blanked value, so after the scrub it
    // changes nothing. Pruning it would shorten main; the count test above would catch that.
    expect(git(fx.clone, "rev-parse", "main^{tree}").trim()).toBe(
      git(fx.clone, "rev-parse", "main~1^{tree}").trim(),
    );
  });

  test("no old key survives in any blob of any commit of any ref", () => {
    for (const key of [OLD_A, OLD_B, OLD_C]) {
      expect(grepAll(fx.clone, key), key).toBe(1);
      expect(grepAll(fx.clone, key.split("--")[1]?.split(".")[0] ?? "x"), key).toBe(1);
    }
  });

  test("the new keys stand where the old ones were, in every commit, on both branches of the merge", () => {
    const commits = allCommits(fx.clone);
    expect(commits).toHaveLength(8);
    for (const c of commits) {
      expect(fileAt(fx.clone, c, "sub-01/eeg/sub-01_eeg.edf"), c).toBe(pointer(NEW_A));
      expect(fileAt(fx.clone, c, "sub-01/eeg/sub-01_aux.bdf"), c).toBe(pointer(NEW_B));
      const third = fileAt(fx.clone, c, "sub-03/eeg/sub-03_eeg.bdf");
      if (third !== null) expect(third, c).toBe(pointer(NEW_B));
    }
    const merge = git(fx.clone, "rev-list", "--merges", "main").trim();
    expect(fileAt(fx.clone, `${merge}^2`, "sub-04/eeg/sub-04_eeg.edf")).toBe(pointer(NEW_C));
    expect(fileAt(fx.clone, "main", "sub-04/eeg/sub-04_eeg.edf")).toBe(pointer(NEW_C));
    expect(fileAt(fx.clone, `${merge}^1`, "sub-04/eeg/sub-04_eeg.edf")).toBeNull();
  });

  test("a pointer outside the keymap and an unrelated binary are byte for byte the same objects", () => {
    for (const path of ["sub-02/eeg/sub-02_eeg.edf", "derivatives/blob.bin", "bad.json"]) {
      expect(git(fx.clone, "rev-parse", `main:${path}`).trim(), path).toBe(
        git(fx.src, "rev-parse", `main:${path}`).trim(),
      );
    }
    expect(fileAt(fx.clone, "main", "sub-02/eeg/sub-02_eeg.edf")).toBe(pointer(KEEP));
    expect(fileAt(fx.clone, "main", "derivatives/blob.bin")).toBe(BINARY.toString("latin1"));
  });

  test("dropped paths are gone from every tree, including the oldest commits and the tags", () => {
    for (const c of [...allCommits(fx.clone), ...TAGS]) {
      const paths = treePaths(fx.clone, c);
      for (const dropped of PLAN.dropPaths) expect(paths, `${c} ${dropped}`).not.toContain(dropped);
    }
    // Only the dropped paths went: the tip lost exactly the images.
    expect(treePaths(fx.clone, "main").sort()).toEqual(
      treePaths(fx.src, "main")
        .filter((p) => !PLAN.dropPaths.includes(p))
        .sort(),
    );
  });

  test("blanked keys are empty at every depth, in every commit; look-alikes and layout survive", () => {
    const root = git(fx.clone, "rev-list", "--max-parents=0", "main").trim();
    expect(fileAt(fx.clone, root, "dataset_description.json")).toBe(DESCRIPTION_NEW);
    expect(fileAt(fx.clone, "main", "dataset_description.json")).toBe(DESCRIPTION_NEW_V2);
    for (const c of allCommits(fx.clone)) {
      expect(fileAt(fx.clone, c, "participants.json"), c).toBe(PARTICIPANTS_NEW);
      expect(fileAt(fx.clone, c, "sub-01/compact.json"), c).toBe(COMPACT_NEW);
    }
    // Content that is not UTF-8 JSON is left exactly as it was.
    expect(fileAt(fx.clone, "main", "bad.json")).toBe(NOT_JSON);
    expect(fileAt(fx.clone, "main", "latin1.json")).toBe(LATIN1_JSON.toString("latin1"));
  });

  test("structural edits: the image entries are gone from the provenance file in every commit, and the totals follow", () => {
    for (const c of allCommits(fx.clone)) {
      expect(fileAt(fx.clone, c, "provenance.json"), c).toBe(PROVENANCE_SCRUBBED);
    }
    // The three source revisions differed (two, three and four entries); all became one.
    const oldRevisions = new Set(
      git(fx.src, "rev-list", "main")
        .split("\n")
        .filter(Boolean)
        .map((c) => fileAt(fx.src, c, "provenance.json")),
    );
    expect(oldRevisions.size).toBe(3);
    expect(PROVENANCE_SCRUBBED).toContain(PRIVACY_NOTE);
  });

  test("the appended text is in every commit exactly once, created where the file was absent", () => {
    for (const c of allCommits(fx.clone)) {
      const changes = fileAt(fx.clone, c, "CHANGES") ?? "";
      const readme = fileAt(fx.clone, c, "README") ?? "";
      expect(changes.endsWith(CHANGES_TEXT), c).toBe(true);
      expect(occurrences(changes, CHANGES_TEXT), c).toBe(1);
      expect(readme.endsWith(README_TEXT), c).toBe(true);
      expect(occurrences(readme, README_TEXT), c).toBe(1);
    }
    // c2 had no CHANGES: the append created it. c3 had one with no final newline.
    expect(fileAt(fx.clone, "v1.0.1", "CHANGES")).toBe(CHANGES_TEXT);
    expect(fileAt(fx.clone, "v1.0.2", "CHANGES")).toBe(`1.0.1 initial release\n${CHANGES_TEXT}`);
    const root = git(fx.clone, "rev-list", "--max-parents=0", "main").trim();
    expect(fileAt(fx.clone, root, "README")).toBe(`Test dataset\n${README_TEXT}`);
  });

  test("the git-annex branch and its remote-tracking ref are the same commits as before", () => {
    expect(git(fx.clone, "rev-parse", "refs/heads/git-annex").trim()).toBe(beforeAnnex.local);
    expect(git(fx.clone, "rev-parse", "refs/remotes/origin/git-annex").trim()).toBe(
      beforeAnnex.origin,
    );
  });

  test("origin is still configured, nothing in the object store holds the old keys, and the tree is clean", () => {
    expect(git(fx.clone, "remote").trim()).toBe("origin");
    expect(git(fx.clone, "status", "--porcelain").trim()).toBe("");
    // Reflogs expired and unreachable objects pruned: not even a loose old blob remains.
    const all = git(fx.clone, "cat-file", "--batch-all-objects", "--batch-check").split("\n");
    const blobs = all.filter((l) => l.includes(" blob ")).map((l) => l.split(" ")[0] as string);
    for (const oid of blobs) {
      const body = git(fx.clone, "cat-file", "-p", oid);
      for (const key of [OLD_A, OLD_B, OLD_C]) expect(body.includes(key)).toBe(false);
    }
  });

  test("git-annex's last-index ref, naming the pre-rewrite index, goes with the old history", async () => {
    // What git-annex 10.20240129 (Ubuntu 24.04's) leaves after any `git status`: a ref to the
    // tree of the index as it was. Made by hand here, so the test does not depend on the
    // git-annex version that runs it (10.20260901 writes no such ref).
    const repo = join(fx.root, "last-index");
    copyTree(pristine, repo);
    git(repo, "update-ref", "refs/annex/last-index", git(repo, "write-tree").trim());
    const out = await cli([
      "rewrite",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
    ]);
    expect(out.code, out.out).toBe(0);
    const refs = git(repo, "for-each-ref", "--format=%(refname)").split("\n");
    expect(refs.filter((r) => r.startsWith("refs/annex/"))).toEqual([]);
    const all = git(repo, "cat-file", "--batch-all-objects", "--batch-check").split("\n");
    const blobs = all.filter((l) => l.includes(" blob ")).map((l) => l.split(" ")[0] as string);
    expect(blobs.length).toBeGreaterThan(0);
    for (const oid of blobs) {
      const body = git(repo, "cat-file", "-p", oid);
      for (const key of [OLD_A, OLD_B, OLD_C]) expect(body.includes(key)).toBe(false);
    }
  }, 120_000);

  test("a failure after the refs were rewritten is a failure that says so, not a refusal (I7)", async () => {
    const repo = join(fx.root, "gc-fails");
    copyTree(pristine, repo);
    // Only `git gc` reads this, so everything up to the rewrite works and the cleanup does not.
    git(repo, "config", "gc.packRefs", "notabool");
    const before = git(repo, "rev-parse", "refs/heads/main").trim();
    const r = await cli([
      "rewrite",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
    ]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("failed: cleanup-after-rewrite: the refs WERE rewritten");
    expect(r.out).toContain("git reflog expire --expire=now --all && git gc --prune=now");
    expect(r.out).not.toContain("refused");
    // And it is true: main moved.
    expect(git(repo, "rev-parse", "refs/heads/main").trim()).not.toBe(before);
  }, 120_000);

  test("a relative --report names a file where the operator stands, not inside the clone (I7)", async () => {
    const repo = join(fx.root, "report-relative");
    copyTree(pristine, repo);
    const here = join(fx.root, "operator-cwd");
    sh(fx.root, ["mkdir", "-p", here]);
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        CLI,
        "rewrite",
        "--repo",
        repo,
        "--keymap",
        fx.keymapPath,
        "--plan",
        fx.planPath,
        "--report",
        "report.json",
      ],
      { cwd: here, env: ENV, stdout: "pipe", stderr: "pipe" },
    );
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code, out).toBe(0);
    expect(existsSync(join(here, "report.json"))).toBe(true);
    expect(existsSync(join(repo, "report.json"))).toBe(false);
  }, 120_000);

  test("a second run changes nothing: no commit or ref moves and nothing is appended twice", async () => {
    const again = join(fx.root, "again");
    copyTree(fx.clone, again);
    const tips = refTips(again);
    const out = await cli([
      "rewrite",
      "--repo",
      again,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
    ]);
    expect(out.code).toBe(0);
    const c = counts(out.out, "rewrite: ok");
    expect(c.appended).toBe(0);
    expect(c.appendAlreadyPresent).toBe(16);
    expect(c.blobsRewritten).toBe(0);
    expect(c.commitsRewritten).toBe(0);
    expect(refTips(again)).toBe(tips);
    for (const commit of allCommits(again)) {
      expect(occurrences(fileAt(again, commit, "CHANGES") ?? "", CHANGES_TEXT)).toBe(1);
    }
    const check = await cli([
      "verify",
      "--repo",
      again,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--s3-plan",
      fx.s3PlanPath,
      "--before",
      snapshot,
      "--allow-unparseable-json",
    ]);
    expect(check.out).toContain("verify: ok");
  }, 120_000);

  // ---- the verifier is not vacuous: the same repository, damaged one way at a time ----------

  async function verifyDamaged(
    name: string,
    damage: (repo: string) => void,
    extra: string[] = ["--allow-unparseable-json"],
    s3PlanPath: string = fx.s3PlanPath,
  ): Promise<{ code: number; out: string }> {
    const repo = join(fx.root, `damaged-${name}`);
    copyTree(fx.clone, repo);
    damage(repo);
    return cli([
      "verify",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--s3-plan",
      s3PlanPath,
      "--before",
      snapshot,
      ...extra,
    ]);
  }

  test("verify fails on an old key left in a commit that is not a tip", async () => {
    const r = await verifyDamaged("stale", (repo) => {
      // A branch whose TIP is clean (the rewritten tree) but whose parent is an original
      // commit. Only a scan of every reachable object finds the old keys behind it.
      git(repo, "fetch", "-q", fx.src, "main:refs/heads/old-main");
      const oldRoot = git(repo, "rev-list", "--max-parents=0", "old-main").trim();
      const tree = git(repo, "rev-parse", "main^{tree}").trim();
      const stale = git(repo, "commit-tree", tree, "-p", oldRoot, "-m", "stale").trim();
      git(repo, "update-ref", "refs/heads/stale", stale);
      git(repo, "update-ref", "-d", "refs/heads/old-main");
      expect(git(repo, "ls-tree", "-r", "--name-only", "stale")).not.toContain("photo-A");
    });
    expect(r.code).toBe(4);
    expect(r.out).toContain("reason=old-key-present");
    expect(r.out).toContain("reason=dropped-path-present");
  });

  test("verify fails on an old key written into a new blob", async () => {
    const r = await verifyDamaged("newblob", (repo) => {
      write(repo, "notes.txt", `see ${OLD_A}\n`);
      commitAll(repo, "leak");
    });
    expect(r.out).toContain("reason=old-key-present");
  });

  test("verify finds an old key inside blobs larger than a pipe buffer", async () => {
    const r = await verifyDamaged("bigblob", (repo) => {
      // One blob of hex-looking filler and one of plain text, the key placed to straddle a
      // 64 KiB read in each. Two blobs, so the count says both were found.
      const hex = "0123456789abcdef".repeat(20000);
      const text = "the quick brown fox jumps over the lazy dog ".repeat(7000);
      const key = sha("old-c");
      write(repo, "big-hex.dat", `${hex.slice(0, 65506)}${key}${hex.slice(65506)}`);
      write(repo, "big-text.dat", `${text.slice(0, 65506)}${key}${text.slice(65506)}`);
      commitAll(repo, "big");
    });
    expect(r.out).toContain("reason=old-key-present count=2");
  });

  test("verify fails on an old key in a commit message", async () => {
    const r = await verifyDamaged("message", (repo) => {
      git(repo, "commit", "-q", "--allow-empty", "-m", `mentions ${sha("old-b")}`);
    });
    expect(r.out).toContain("reason=old-key-in-message");
  });

  test("verify fails on an old key in an annotated tag's message, and only there (T9)", async () => {
    const r = await verifyDamaged("tag-message", (repo) => {
      // A clean commit, tagged with a message that names an old key: only the tag object holds it.
      git(repo, "tag", "-a", "v9.9.9", "-m", `release notes ${sha("old-c")}`, "main");
    });
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=old-key-in-message count=1");
    expect(r.out).not.toContain("reason=old-key-present");
  });

  test("a failed git command names the command from a closed list, never its stderr (I8)", async () => {
    const notARepo = join(fx.root, "not-a-repo");
    sh(fx.root, ["mkdir", "-p", notARepo]);
    const r = await cli([
      "verify",
      "--repo",
      notARepo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--s3-plan",
      fx.s3PlanPath,
      "--before",
      snapshot,
    ]);
    expect(r.code, r.out).toBe(1);
    expect(r.out.trim()).toBe("failed: git-command-failed (git for-each-ref)");
  });

  test("verify fails when a tag is gone, or the kind of a tag changed", async () => {
    const gone = await verifyDamaged("tag-gone", (repo) => git(repo, "tag", "-d", "v1.0.1"));
    expect(gone.out).toContain("reason=tag-names-changed");
    expect(gone.out).toContain("reason=refs-missing");
    const kind = await verifyDamaged("tag-kind", (repo) => {
      const commit = git(repo, "rev-parse", "v1.0.2^{commit}").trim();
      git(repo, "tag", "-d", "v1.0.2");
      git(repo, "tag", "v1.0.2", commit);
    });
    expect(kind.out).toContain("reason=tag-kind-changed");
  });

  test("verify fails when a ref lost a commit", async () => {
    const r = await verifyDamaged("count", (repo) =>
      git(repo, "update-ref", "refs/heads/main", "main~1"),
    );
    expect(r.out).toContain("reason=commit-count-changed");
  });

  test("verify fails when a dropped path comes back", async () => {
    const r = await verifyDamaged("drop", (repo) => {
      write(repo, "sub-01/photo-A.jpg", "again");
      commitAll(repo, "photo returns");
    });
    expect(r.out).toContain("reason=dropped-path-present");
  });

  test("verify fails when a blanked key is non-empty in some commit", async () => {
    const r = await verifyDamaged("blank", (repo) => {
      write(repo, "participants.json", '{"Participant Name": "Bob"}\n');
      commitAll(repo, "name returns");
    });
    expect(r.out).toContain("reason=blank-key-not-empty");
  });

  test("verify fails when a structural edit is undone: an entry back, a wrong total, a lost note", async () => {
    const entry = await verifyDamaged("ops-entry", (repo) => {
      write(repo, "provenance.json", PROVENANCE_C3);
      commitAll(repo, "provenance regressed");
    });
    expect(entry.out).toContain("reason=json-ops-not-applied");
    const total = await verifyDamaged("ops-total", (repo) => {
      write(repo, "provenance.json", PROVENANCE_SCRUBBED.replace('"n_files": 1', '"n_files": 9'));
      commitAll(repo, "wrong count");
    });
    expect(total.out).toContain("reason=json-ops-not-applied");
    const note = await verifyDamaged("ops-note", (repo) => {
      write(repo, "provenance.json", PROVENANCE_SCRUBBED.replace(PRIVACY_NOTE, "edited"));
      commitAll(repo, "note changed");
    });
    expect(note.out).toContain("reason=json-ops-not-applied");
  });

  test("verify fails when the appended text is missing, or doubled", async () => {
    const missing = await verifyDamaged("append-missing", (repo) => {
      git(repo, "rm", "-q", "CHANGES");
      git(repo, "commit", "-q", "-m", "drop changes");
    });
    expect(missing.out).toContain("reason=append-missing");
    const doubled = await verifyDamaged("append-doubled", (repo) => {
      write(repo, "CHANGES", `${fileAt(repo, "main", "CHANGES")}${CHANGES_TEXT}`);
      commitAll(repo, "append again");
    });
    expect(doubled.out).toContain("reason=append-duplicated");
  });

  test("verify fails when a tip has a path the snapshot does not account for", async () => {
    const r = await verifyDamaged("tip", (repo) => {
      write(repo, "extra.txt", "x");
      commitAll(repo, "extra");
    });
    expect(r.out).toContain("reason=tip-paths-mismatch");
  });

  test("verify fails when the git-annex branch moved", async () => {
    const r = await verifyDamaged("annex", (repo) => {
      git(repo, "update-ref", "refs/heads/git-annex", "main");
    });
    expect(r.out).toContain("reason=annex-branch-changed");
  });

  // ---- every EDF/BDF key is accounted for: a NEW key, or one the S3 plan read and found clean ----

  const STRANGER = annexKey("stranger", 4096, ".edf");

  test("verify fails on an EDF key the S3 plan never saw, in a commit that is not a tip", async () => {
    const r = await verifyDamaged("edf-stranger", (repo) => {
      write(repo, "sub-05/eeg/sub-05_eeg.edf", pointer(STRANGER));
      commitAll(repo, "stranger arrives");
      git(repo, "rm", "-q", "sub-05/eeg/sub-05_eeg.edf");
      git(repo, "commit", "-q", "-m", "stranger leaves");
    });
    expect(r.code).toBe(4);
    expect(r.out).toContain("reason=edf-key-unaccounted count=1");
    // Only that: the keys the rewrite produced and the clean one are accounted for.
    expect(r.out).not.toContain("reason=old-key-present");
  });

  test("a key that only a merge's own result carries is found", async () => {
    const r = await verifyDamaged("edf-merge", (repo) => {
      git(repo, "checkout", "-q", "-b", "side2");
      write(repo, "side2.txt", "s");
      commitAll(repo, "side two");
      git(repo, "checkout", "-q", "main");
      write(repo, "main-only.txt", "m");
      commitAll(repo, "main only");
      git(repo, "merge", "-q", "--no-commit", "--no-ff", "side2");
      write(repo, "sub-09/eeg/sub-09_eeg.edf", pointer(annexKey("stranger-m", 512, ".edf")));
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "merge with an extra recording");
      git(repo, "rm", "-q", "sub-09/eeg/sub-09_eeg.edf");
      git(repo, "commit", "-q", "-m", "recording removed again");
    });
    expect(r.out).toContain("reason=edf-key-unaccounted count=1");
  });

  test("a BDF path in capitals is an EDF path, and a key no pointer rewrote is still unaccounted", async () => {
    const r = await verifyDamaged("edf-capitals", (repo) => {
      write(repo, "sub-06/eeg/SUB-06_EEG.BDF", pointer(annexKey("stranger-b", 2048, ".BDF")));
      commitAll(repo, "stranger in capitals");
    });
    expect(r.out).toContain("reason=edf-key-unaccounted count=1");
  });

  test("an OLD key left at an EDF path is unaccounted, not merely present", async () => {
    const r = await verifyDamaged("edf-old", (repo) => {
      write(repo, "sub-01/eeg/sub-01_eeg.edf", pointer(OLD_A));
      commitAll(repo, "old key returns");
    });
    expect(r.out).toContain("reason=edf-key-unaccounted count=1");
    expect(r.out).toContain("reason=old-key-present");
  });

  test("a clean key counts only when the S3 plan lists it as read and clean", async () => {
    const missing = join(fx.root, "plan-without-keep.json");
    await Bun.write(
      missing,
      JSON.stringify(s3PlanFor("nm000999", { scrub: [OLD_A, OLD_B, OLD_C], clean: [] })),
    );
    const never = await verifyDamaged("plan-missing", () => {}, undefined, missing);
    expect(never.out).toContain("reason=edf-key-unaccounted count=1");
    const unread = join(fx.root, "plan-unreadable.json");
    await Bun.write(
      unread,
      JSON.stringify(
        s3PlanFor("nm000999", { scrub: [OLD_A, OLD_B, OLD_C], clean: [], unreadable: [KEEP] }),
      ),
    );
    const unchecked = await verifyDamaged("plan-unreadable", () => {}, undefined, unread);
    expect(unchecked.out).toContain("reason=edf-key-unaccounted count=1");
    const ok = await verifyDamaged("plan-ok", () => {});
    expect(ok.code).toBe(0);
  });

  test("an EDF path that holds content, not a pointer, fails: its header is in the history", async () => {
    const r = await verifyDamaged("edf-inline", (repo) => {
      write(repo, "sub-07/eeg/sub-07_eeg.edf", Buffer.alloc(4096, 0x20));
      write(repo, "sub-08/eeg/sub-08_eeg.bdf", "tiny, but not a pointer");
      commitAll(repo, "inline recordings");
    });
    expect(r.out).toContain("reason=edf-path-not-a-pointer count=2");
    expect(r.out).not.toContain("reason=edf-key-unaccounted");
  });

  test("verify refuses an S3 plan from another dataset, and needs one", async () => {
    const other = join(fx.root, "plan-other-dataset.json");
    await Bun.write(
      other,
      JSON.stringify(s3PlanFor("nm000123", { scrub: [OLD_A, OLD_B, OLD_C], clean: [KEEP] })),
    );
    const r = await verifyDamaged("plan-dataset", () => {}, undefined, other);
    expect(r.code).toBe(3);
    expect(r.out).toContain("refused: s3-plan-dataset-mismatch");
    const none = await cli([
      "verify",
      "--repo",
      fx.clone,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--before",
      snapshot,
    ]);
    expect(none.code).toBe(2);
    expect(none.out).toContain("missing --s3-plan");
  });

  test("verify refuses plan files it cannot parse unless told to accept them", async () => {
    const r = await verifyDamaged("unparseable", () => {}, []);
    expect(r.code).toBe(4);
    expect(r.out).toContain("reason=json-unparseable count=16");
  });

  // ---- rewrite refuses what it must not touch -------------------------------------------

  async function refused(
    name: string,
    damage: (repo: string) => void,
    args: string[],
    word: string,
  ): Promise<void> {
    const repo = join(fx.root, `refuse-${name}`);
    copyTree(pristine, repo);
    damage(repo);
    const tips = refTips(repo);
    const r = await cli([
      "rewrite",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      ...args,
    ]);
    expect(r.code).toBe(3);
    expect(r.out).toContain(word);
    expect(refTips(repo), "refused means untouched").toBe(tips);
  }

  test("rewrite refuses a clone with a commit origin does not have", async () => {
    await refused(
      "unpushed",
      (repo) => git(repo, "commit", "-q", "--allow-empty", "-m", "local only"),
      [],
      "refused: branch-not-matching-origin",
    );
  });

  test("rewrite refuses a dirty working tree", async () => {
    await refused(
      "dirty",
      (repo) => write(repo, "README", "edited, not committed"),
      [],
      "refused: working-tree-not-clean",
    );
  });

  test("rewrite refuses a clone with a stash, whose commits would keep the old history (T9)", async () => {
    await refused(
      "stash",
      (repo) => {
        write(repo, "README", "stashed edit");
        git(repo, "stash", "-q");
      },
      [],
      "refused: has-stash",
    );
  });

  test("rewrite refuses an origin that is not the plan's dataset, with or without a flag, and a repository with no origin", async () => {
    // No flag: the expected remote is derived from the plan's dataset (nm000999), so an origin
    // naming any other repository is refused without anyone having to name it.
    await refused(
      "other-dataset",
      (repo) => git(repo, "remote", "set-url", "origin", datasetUrl("nm000123")),
      [],
      "refused: remote-mismatch",
    );
    await refused(
      "other-host",
      (repo) => git(repo, "remote", "set-url", "origin", "https://example.invalid/nm000999.git"),
      [],
      "refused: remote-mismatch",
    );
    // A push URL elsewhere is an origin elsewhere.
    await refused(
      "push-url",
      (repo) => git(repo, "remote", "set-url", "--push", "origin", datasetUrl("nm000123")),
      [],
      "refused: remote-mismatch",
    );
    // A flag cannot name a different target than the plan's, even a perfectly good one.
    await refused(
      "flag",
      () => {},
      ["--expect-remote", datasetUrl("nm000123")],
      "refused: expect-remote-mismatch",
    );
    await refused(
      "flag-local",
      () => {},
      ["--expect-remote", fx.src],
      "refused: expect-remote-mismatch",
    );
    await refused(
      "no-origin",
      (repo) => git(repo, "remote", "remove", "origin"),
      [],
      "refused: no-origin-remote",
    );
  });

  test("a keymap from another dataset is refused before anything changes: all foreign, and one foreign entry", async () => {
    const foreign = { [annexKey("other-a", 1024, ".edf")]: annexKey("other-b", 1024, ".edf") };
    const allForeign = join(fx.root, "keymap-foreign.json");
    await Bun.write(allForeign, JSON.stringify(foreign));
    const mixed = join(fx.root, "keymap-mixed.json");
    await Bun.write(mixed, JSON.stringify({ ...KEYMAP, ...foreign }));
    for (const [name, keymapPath] of [
      ["foreign", allForeign],
      ["mixed", mixed],
    ] as const) {
      const repo = join(fx.root, `refuse-keymap-${name}`);
      copyTree(pristine, repo);
      const tips = refTips(repo);
      const r = await cli([
        "rewrite",
        "--repo",
        repo,
        "--keymap",
        keymapPath,
        "--plan",
        fx.planPath,
      ]);
      expect(r.code, name).toBe(3);
      expect(r.out, name).toContain("refused: keymap-key-never-seen");
      expect(refTips(repo), "refused means untouched").toBe(tips);
      expect(r.out).not.toContain(sha("other-a"));
    }
  });

  test("an origin spelled as scp or ssh, with or without .git, is the same repository", async () => {
    for (const [name, url] of [
      ["scp", "git@github.com:nemarDatasets/nm000999.git"],
      ["ssh", "ssh://git@github.com/NEMARDATASETS/nm000999"],
    ] as const) {
      const repo = join(fx.root, `spelling-${name}`);
      copyTree(pristine, repo);
      git(repo, "remote", "set-url", "origin", url);
      const r = await cli([
        "rewrite",
        "--repo",
        repo,
        "--keymap",
        fx.keymapPath,
        "--plan",
        fx.planPath,
      ]);
      expect(r.out, name).toContain("rewrite: ok");
      expect(r.code, name).toBe(0);
    }
  }, 120_000);

  test("rewrite refuses to touch a git-annex ref", async () => {
    await refused("annex-ref", () => {}, ["--refs", "refs/heads/git-annex"], "bad-input");
  });

  test("rewrite and verify refuse a keymap or plan that fails the contract", async () => {
    const badKeymap = join(fx.root, "bad-keymap.json");
    await Bun.write(badKeymap, JSON.stringify({ "MD5E-s1--abc.bdf": NEW_A }));
    const badPlan = join(fx.root, "bad-plan.json");
    await Bun.write(
      badPlan,
      JSON.stringify({ ...PLAN, dropPaths: ["CHANGES"], appendText: { CHANGES: "x\n" } }),
    );
    const badOps = join(fx.root, "bad-ops.json");
    await Bun.write(
      badOps,
      JSON.stringify({
        ...PLAN,
        jsonOps: { "provenance.json": [{ op: "recount", array: "files" }] },
      }),
    );
    const dropAndEdit = join(fx.root, "drop-and-edit.json");
    await Bun.write(dropAndEdit, JSON.stringify({ ...PLAN, dropPaths: ["provenance.json"] }));
    const repo = join(fx.root, "refuse-contract");
    copyTree(pristine, repo);
    const tips = refTips(repo);
    const a = await cli(["rewrite", "--repo", repo, "--keymap", badKeymap, "--plan", fx.planPath]);
    const b = await cli(["rewrite", "--repo", repo, "--keymap", fx.keymapPath, "--plan", badPlan]);
    const c = await cli([
      "verify",
      "--repo",
      repo,
      "--keymap",
      badKeymap,
      "--plan",
      fx.planPath,
      "--s3-plan",
      fx.s3PlanPath,
      "--before",
      snapshot,
    ]);
    const d = await cli(["rewrite", "--repo", repo, "--keymap", fx.keymapPath, "--plan", badOps]);
    const e = await cli([
      "rewrite",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      dropAndEdit,
    ]);
    for (const r of [a, b, c, d, e]) {
      expect(r.code).toBe(3);
      expect(r.out).toContain("refused: contract");
    }
    expect(refTips(repo)).toBe(tips);
  });

  test("restricting --refs leaves the tags on the old history, and verify catches it", async () => {
    const repo = join(fx.root, "refs-only-main");
    copyTree(pristine, repo);
    const r = await cli([
      "rewrite",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--refs",
      "refs/heads/main",
      "refs/remotes/origin/main",
    ]);
    expect(r.code).toBe(0);
    // The tags kept their old commits, so the old keys are still reachable through them.
    expect(grepAll(repo, OLD_A)).toBe(0);
    const v = await cli([
      "verify",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--s3-plan",
      fx.s3PlanPath,
      "--before",
      snapshot,
      "--allow-unparseable-json",
    ]);
    expect(v.code).toBe(4);
    expect(v.out).toContain("reason=old-key-present");
  });

  test("snapshot, before.json and the rewrite report are owner-only, even over a looser existing file", async () => {
    const loose = (name: string): string => {
      const path = join(fx.root, name);
      writeFileSync(path, "stale", { mode: 0o644 });
      chmodSync(path, 0o644);
      expect(statSync(path).mode & 0o777).toBe(0o644);
      return path;
    };
    const mode = (path: string): number => statSync(path).mode & 0o777;
    const snap = loose("snap-loose.json");
    expect((await cli(["snapshot", "--repo", pristine, "--out", snap])).code).toBe(0);
    expect(mode(snap)).toBe(0o600);
    // The snapshot a rewrite takes first, and the report it leaves, over looser files; the
    // report that was there is kept beside the new one, and is tightened too.
    const repo = join(fx.root, "modes");
    copyTree(pristine, repo);
    const before = loose("before-loose.json");
    const report = loose("report-loose.json");
    const r = await cli([
      "rewrite",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--snapshot-out",
      before,
      "--report",
      report,
    ]);
    expect(r.code, r.out).toBe(0);
    expect(mode(before)).toBe(0o600);
    expect(mode(report)).toBe(0o600);
    expect(mode(`${report}.prev1`)).toBe(0o600);
  }, 120_000);

  test("snapshot records counts, tags and the git-annex refs, never contents", async () => {
    const out = join(fx.root, "snap2.json");
    const r = await cli(["snapshot", "--repo", pristine, "--out", out]);
    expect(r.code).toBe(0);
    const s = JSON.parse(await Bun.file(out).text()) as {
      refs: Record<string, { commits: number; tipPaths: string[] }>;
      tags: Record<string, string>;
      annexRefs: Record<string, string>;
    };
    expect(Object.keys(s.tags).sort()).toEqual(TAGS);
    expect(s.tags["v1.0.2"]).toBe("tag");
    expect(s.refs["refs/heads/main"]?.commits).toBe(8);
    expect(s.refs["refs/heads/main"]?.tipPaths).toContain("late/photo-C.png");
    expect(Object.keys(s.annexRefs).sort()).toEqual([
      "refs/heads/git-annex",
      "refs/remotes/origin/git-annex",
    ]);
    expect(JSON.stringify(s)).not.toContain("Alice");
    expect(JSON.stringify(s)).not.toContain(OLD_A);
  });

  test("the keymap's three new keys all exist after the rewrite, and none is invented", () => {
    const newKeys = Object.values(KEYMAP);
    for (const key of newKeys) expect(grepAll(fx.clone, key), key).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------
// Symlink dataset: a real locked annex tree
// -----------------------------------------------------------------------------------------

ANNEX_SUITE("symlink dataset (real git annex add)", () => {
  let fx: SymlinkFixture;
  let snapshot: string;
  let rewriteOut: { code: number; out: string };
  let verifyOut: { code: number; out: string };
  let beforeTags: string;
  let beforeCounts: Record<string, number>;
  let beforeAnnex: string;

  /** What git-annex itself says the symlink target for `key` is, below `prefix`. */
  function target(repo: string, prefix: string, key: string): string {
    const mid = sh(repo, [
      "git",
      "annex",
      "examinekey",
      "--format=${hashdirmixed}${key}/${key}",
      key,
    ]).trim();
    return `${prefix}${mid}`;
  }

  beforeAll(async () => {
    fx = buildSymlinkFixture();
    snapshot = join(fx.root, "before.json");
    beforeTags = git(fx.clone, "tag", "-l");
    beforeCounts = commitCounts(fx.clone, ["main", "refs/tags/v1", "refs/tags/v2", "refs/tags/v3"]);
    beforeAnnex = git(fx.clone, "rev-parse", "refs/heads/git-annex").trim();
    rewriteOut = await cli([
      "rewrite",
      "--repo",
      fx.clone,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--snapshot-out",
      snapshot,
    ]);
    verifyOut = await cli([
      "verify",
      "--repo",
      fx.clone,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--s3-plan",
      fx.s3PlanPath,
      "--before",
      snapshot,
    ]);
  }, 180_000);

  test("rewrite and verify succeed on symlinks", () => {
    expect(rewriteOut.out).toContain("rewrite: ok");
    expect(verifyOut.out).toContain("verify: ok");
    expect(counts(rewriteOut.out, "rewrite: ok").symlinkNonStandardShape).toBe(0);
  });

  test("every symlink to a scrubbed key points at the new key, twice, in git-annex's own hash directory", () => {
    const commits = allCommits(fx.clone);
    let checked = 0;
    for (const [oldKey, newKey] of Object.entries(fx.keymap)) {
      for (const path of fx.paths[oldKey] ?? []) {
        for (const c of commits) {
          const now = linkAt(fx.clone, c, path);
          if (now === null) continue;
          const prefix = /^(.*\.git\/annex\/objects\/)/.exec(now)?.[1];
          expect(prefix, "still an annex symlink").toBeDefined();
          expect(now, `${c} ${path}`).toBe(target(fx.clone, prefix as string, newKey));
          expect(now.endsWith(`/${newKey}/${newKey}`)).toBe(true);
          checked++;
        }
      }
    }
    // a.edf in 7 commits, c.edf in 6, top.bdf in 5 of the 7
    expect(checked).toBeGreaterThan(10);
  });

  test("the oracle is sound: the source's own symlinks match git-annex's hash directory for the old key", () => {
    const [oldKey] = Object.keys(fx.keymap) as [string];
    const path = (fx.paths[oldKey] ?? [])[0] as string;
    const old = linkAt(fx.src, "main", path) as string;
    const prefix = /^(.*\.git\/annex\/objects\/)/.exec(old)?.[1] as string;
    expect(old).toBe(target(fx.src, prefix, oldKey));
  });

  test("the unscrubbed key's symlinks are the same objects, and no old key is left anywhere", () => {
    expect(git(fx.clone, "rev-parse", "main:sub-03/eeg/d.edf").trim()).toBe(
      git(fx.src, "rev-parse", "main:sub-03/eeg/d.edf").trim(),
    );
    for (const oldKey of Object.keys(fx.keymap)) {
      // `git grep` skips symlinks, so these scan every reachable object directly. The source is
      // the positive control: the scan finds the key where it is.
      expect(anyObjectContains(fx.src, oldKey)).toBe(true);
      expect(anyObjectContains(fx.clone, oldKey)).toBe(false);
      expect(anyObjectContains(fx.clone, oldKey.split("--")[1]?.split(".")[0] as string)).toBe(
        false,
      );
    }
  });

  test("verify accounts for symlinks too: a key the plan never saw fails, a link to a stranger fails", async () => {
    const verifyWith = async (name: string, plan: object, damage: (repo: string) => void) => {
      const repo = join(fx.root, `damaged-${name}`);
      copyTree(fx.clone, repo);
      damage(repo);
      const planPath = join(fx.root, `plan-${name}.json`);
      await Bun.write(planPath, JSON.stringify(plan));
      return cli([
        "verify",
        "--repo",
        repo,
        "--keymap",
        fx.keymapPath,
        "--plan",
        fx.planPath,
        "--s3-plan",
        planPath,
        "--before",
        snapshot,
      ]);
    };
    // The plan that does not list the unscrubbed key (one key, linked from two paths).
    const noClean = await verifyWith(
      "no-clean",
      s3PlanFor("nm000998", { scrub: Object.keys(fx.keymap), clean: [] }),
      () => {},
    );
    expect(noClean.out).toContain("reason=edf-key-unaccounted count=1");
    // A real annex symlink to a key the plan never heard of.
    const stranger = await verifyWith(
      "stranger",
      JSON.parse(await Bun.file(fx.s3PlanPath).text()) as object,
      (repo) => {
        write(repo, "extra/stranger.edf", "stranger-content-".repeat(20));
        sh(repo, ["git", "annex", "add", "--quiet", "extra/stranger.edf"]);
        git(repo, "commit", "-q", "-m", "stranger");
      },
    );
    expect(stranger.out).toContain("reason=edf-key-unaccounted count=1");
    const fine = await verifyWith(
      "fine",
      JSON.parse(await Bun.file(fx.s3PlanPath).text()) as object,
      () => {},
    );
    expect(fine.code).toBe(0);
  }, 120_000);

  test("tags, counts, the dropped image, the appended text and the git-annex branch", () => {
    expect(git(fx.clone, "tag", "-l")).toBe(beforeTags);
    expect(git(fx.clone, "cat-file", "-t", "v2").trim()).toBe("tag");
    expect(
      commitCounts(fx.clone, ["main", "refs/tags/v1", "refs/tags/v2", "refs/tags/v3"]),
    ).toEqual(beforeCounts);
    for (const c of allCommits(fx.clone)) {
      expect(treePaths(fx.clone, c)).not.toContain("sub-01/photo.jpg");
      const changes = fileAt(fx.clone, c, "CHANGES") ?? "";
      expect(occurrences(changes, "1.0.1\n  - scrubbed\n"), c).toBe(1);
    }
    expect(git(fx.clone, "rev-parse", "refs/heads/git-annex").trim()).toBe(beforeAnnex);
  });
});

SUITE("an executable pointer file (mode 100755) is rewritten like any other (T9)", () => {
  test("the new key replaces the old one and the mode is kept", async () => {
    const root = makeRoot();
    const src = join(root, "src");
    sh(root, ["mkdir", "-p", src]);
    git(src, "init", "-q", "-b", "main");
    write(src, "sub-01/eeg/sub-01_eeg.edf", pointer(OLD_A));
    chmodSync(join(src, "sub-01/eeg/sub-01_eeg.edf"), 0o755);
    write(src, "README", "x");
    commitAll(src, "one");
    git(src, "tag", "v1.0.0");
    expect(git(src, "ls-tree", "main", "sub-01/eeg/sub-01_eeg.edf")).toStartWith("100755 blob");
    const clone = join(root, "clone");
    cloneOf(src, clone, datasetUrl("nm000999"));
    const keymap = join(root, "keymap.json");
    const plan = join(root, "git-plan.json");
    writeFileSync(keymap, JSON.stringify({ [OLD_A]: NEW_A }));
    writeFileSync(
      plan,
      JSON.stringify({
        version: 1,
        dataset: "nm000999",
        dropPaths: [],
        blankJsonKeys: {},
        appendText: {},
      }),
    );
    const r = await cli(["rewrite", "--repo", clone, "--keymap", keymap, "--plan", plan]);
    expect(r.code, r.out).toBe(0);
    for (const ref of ["main", "v1.0.0"]) {
      expect(git(clone, "ls-tree", ref, "sub-01/eeg/sub-01_eeg.edf")).toStartWith("100755 blob");
      expect(fileAt(clone, ref, "sub-01/eeg/sub-01_eeg.edf")).toBe(pointer(NEW_A));
    }
    expect(anyObjectContains(clone, OLD_A)).toBe(false);
  }, 120_000);
});
