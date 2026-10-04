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
import { join } from "node:path";
import {
  BINARY,
  CHANGES_TEXT,
  COMPACT_NEW,
  DESCRIPTION_NEW,
  DESCRIPTION_NEW_V2,
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
  anyObjectContains,
  buildPointerFixture,
  buildSymlinkFixture,
  cleanupRoots,
  cli,
  commitAll,
  copyTree,
  counts,
  fileAt,
  git,
  linkAt,
  pointer,
  refTips,
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
      fx.src,
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
    expect(r.code).not.toBe(0);
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

  test("verify fails on an old key in a commit message", async () => {
    const r = await verifyDamaged("message", (repo) => {
      git(repo, "commit", "-q", "--allow-empty", "-m", `mentions ${sha("old-b")}`);
    });
    expect(r.out).toContain("reason=old-key-in-message");
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

  test("verify refuses plan files it cannot parse unless told to accept them", async () => {
    const r = await verifyDamaged("unparseable", () => {}, []);
    expect(r.code).not.toBe(0);
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
    expect(r.code).not.toBe(0);
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

  test("rewrite refuses a remote that is not the one named, and a repository with no origin", async () => {
    await refused(
      "remote",
      () => {},
      ["--expect-remote", "https://example.invalid/nm.git"],
      "refused: remote-mismatch",
    );
    await refused(
      "no-origin",
      (repo) => git(repo, "remote", "remove", "origin"),
      [],
      "refused: no-origin-remote",
    );
  });

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
      expect(r.code).not.toBe(0);
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
      "--before",
      snapshot,
      "--allow-unparseable-json",
    ]);
    expect(v.code).not.toBe(0);
    expect(v.out).toContain("reason=old-key-present");
  });

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
      "--expect-remote",
      fx.src,
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
