/**
 * `git-scrub verify --fresh-clone` (runbook step 14): the PUSHED repository, read from a new
 * clone, with no snapshot to compare against.
 *
 * The whole path is real: the pointer-file fixture is published as a BARE repository (the stand-in
 * for GitHub) with a `nemar-s3` special remote, an operator's clone of it is snapshotted,
 * rewritten, verified, registered (`annex-registry` deriving the remote from the clone), and
 * pushed back; then a fresh clone of the bare repository is verified. A ledger commit on top is
 * tolerated; an old key that survives in a pushed ref, a ledger commit that touches anything else,
 * and a git-annex branch that was never pushed are not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseGitVerified, parseKey } from "../../../scripts/scrub/contract";
import {
  GitScrubError,
  hashDirLower,
  readInputs,
  readS3Plan,
  readSnapshot,
  verifyRewrite,
} from "../../../scripts/scrub/git/git-lib";
import {
  HAVE_ANNEX,
  HAVE_REWRITE_TOOLS,
  KEEP,
  OLD_A,
  OLD_B,
  OLD_C,
  type PointerFixture,
  buildPointerFixture,
  cleanupRoots,
  cli,
  cloneOf,
  counts,
  datasetUrl,
  git,
  s3PlanFor,
  sh,
  write,
} from "./fixture";

afterAll(cleanupRoots);

const SUITE = HAVE_REWRITE_TOOLS && HAVE_ANNEX ? describe : describe.skip;
const DATASET = "nm000999";
const TAGS = ["v1.0.1", "v1.0.2", "v1.1.0"];

/** A valid ledger line for the fixture's dataset. */
const LEDGER_LINE = `${JSON.stringify({
  version: 1,
  at: "2026-10-05T00:00:00.000Z",
  dataset: DATASET,
  action: "history-rewritten",
  versions: TAGS,
  counts: { commits: 8 },
  scanner: "identifier-scan@abcdef1",
  verification: "scanner-clean",
  actor: "someone",
})}\n`;

SUITE("verify --fresh-clone: the pushed repository (I1, I11)", () => {
  let fx: PointerFixture;
  let bare: string;
  let work: string;
  let s3Plan: string;
  let n = 0;

  /** A new clone of the bare "GitHub" repository, named as GitHub would name it. */
  const fresh = (): string => {
    n += 1;
    const dir = join(fx.root, `fresh-${n}`);
    cloneOf(bare, dir, datasetUrl(DATASET));
    return dir;
  };
  const verifyFresh = (
    repo: string,
    proof = join(fx.root, `proof-${n}.json`),
    extra: string[] = [],
  ) =>
    cli([
      "verify",
      "--fresh-clone",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--s3-plan",
      s3Plan,
      "--allow-unparseable-json",
      "--proof-out",
      proof,
      ...extra,
    ]);
  const allow = (...tags: string[]): string[] => tags.flatMap((t) => ["--allow-tag", t]);

  beforeAll(async () => {
    fx = buildPointerFixture();
    // NEMAR's S3 remote, as every dataset repository has one, so registration can derive it.
    const store = join(fx.root, "store");
    sh(fx.root, ["mkdir", "-p", store]);
    sh(fx.src, [
      "git",
      "annex",
      "initremote",
      "nemar-s3",
      "type=directory",
      `directory=${store}`,
      "encryption=none",
    ]);
    bare = join(fx.root, "github.git");
    sh(fx.root, ["git", "clone", "-q", "--bare", "--no-local", fx.src, bare]);
    work = join(fx.root, "operator");
    cloneOf(bare, work, datasetUrl(DATASET));
    sh(work, ["git", "annex", "init", "--quiet", "operator"]);
    s3Plan = join(fx.root, "plan-all-tags.json");
    writeFileSync(
      s3Plan,
      JSON.stringify({
        ...s3PlanFor(DATASET, { scrub: [OLD_A, OLD_B, OLD_C], clean: [KEEP] }),
        tags: TAGS,
      }),
    );

    const before = join(fx.root, "before.json");
    const steps: Array<[string, string[]]> = [
      ["snapshot", ["snapshot", "--repo", work, "--out", before]],
      ["rewrite", ["rewrite", "--repo", work, "--keymap", fx.keymapPath, "--plan", fx.planPath]],
      [
        "verify",
        [
          "verify",
          "--repo",
          work,
          "--keymap",
          fx.keymapPath,
          "--plan",
          fx.planPath,
          "--s3-plan",
          s3Plan,
          "--before",
          before,
          "--allow-unparseable-json",
          "--proof-out",
          join(fx.root, "local-proof.json"),
        ],
      ],
      [
        "annex-registry",
        ["annex-registry", "--repo", work, "--keymap", fx.keymapPath, "--execute"],
      ],
    ];
    for (const [name, args] of steps) {
      const r = await cli(args);
      if (r.code !== 0) throw new Error(`${name} failed: ${r.out}`);
    }
    // The switch's push, then the git-annex branch normally.
    git(work, "push", "-q", "--force", "origin", "refs/heads/main:refs/heads/main");
    git(work, "push", "-q", "--force", "origin", "refs/remotes/origin/side:refs/heads/side");
    git(work, "push", "-q", "--force", "origin", "--tags");
    // Fetch and merge first: the "GitHub" here is a local path, and git-annex 10.20240129
    // (Ubuntu 24.04) writes to the git-annex branch of a local-path remote it works with, so the
    // remote's branch has moved and a plain push is rejected (fetch first). A real GitHub remote
    // is not written to that way; the fetch and merge are harmless there and on 10.20260901.
    git(work, "fetch", "-q", "origin", "git-annex");
    sh(work, ["git", "annex", "merge", "--quiet"]);
    git(work, "push", "-q", "origin", "refs/heads/git-annex:refs/heads/git-annex");
  }, 240_000);

  test("the local verify wrote a proof in local mode, owner-only, naming the exact inputs", () => {
    const proof = parseGitVerified(readFileSync(join(fx.root, "local-proof.json"), "utf8"));
    expect(proof.mode).toBe("local");
    expect(proof.dataset).toBe(DATASET);
    const sha = (p: string) => new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
    expect(proof.keymapSha256).toBe(sha(fx.keymapPath));
    expect(proof.gitPlanSha256).toBe(sha(fx.planPath));
    expect(proof.s3PlanSha256).toBe(sha(s3Plan));
  });

  test("a fresh clone of what was pushed verifies, and the proof says fresh-clone", async () => {
    const repo = fresh();
    const proof = join(fx.root, "fresh-proof.json");
    const r = await verifyFresh(repo, proof);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("verify: ok mode=fresh-clone");
    expect(parseGitVerified(readFileSync(proof, "utf8")).mode).toBe("fresh-clone");
    // No tag was allowed: the line and the proof keep the form they had before --allow-tag.
    expect(r.out).not.toContain("allowedTags");
    expect(readFileSync(proof, "utf8")).not.toContain("allowedTags");
    // There is no local git-annex branch in a fresh clone: the pushed one was read.
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/git-annex").trim()).toBe(
      "",
    );
  }, 120_000);

  test("a ledger commit on top is tolerated; one that touches anything else is not", async () => {
    const repo = fresh();
    write(repo, ".nemar/corrections.jsonl", LEDGER_LINE);
    git(repo, "add", ".nemar/corrections.jsonl");
    git(repo, "commit", "-q", "-m", "Record the privacy correction");
    git(repo, "push", "-q", "origin", "main");
    const ok = await verifyFresh(fresh());
    expect(ok.code, ok.out).toBe(0);
    expect(counts(ok.out, "verify: ok")).toMatchObject({ ledgerCommits: 1 });

    // A second "ledger" commit that also changes another file.
    const again = fresh();
    write(again, ".nemar/corrections.jsonl", `${LEDGER_LINE}${LEDGER_LINE}`);
    write(again, "README", "edited alongside the ledger");
    git(again, "add", ".");
    git(again, "commit", "-q", "-m", "ledger and more");
    git(again, "push", "-q", "origin", "main");
    const proof = join(fx.root, "stale-proof.json");
    writeFileSync(proof, "{}");
    const bad = await verifyFresh(fresh(), proof);
    expect(bad.code, bad.out).toBe(4);
    expect(bad.out).toContain("reason=ledger-commit-not-alone count=1");
    expect(existsSync(proof)).toBe(false);
    // Undo, so later tests see the tolerated state.
    git(again, "reset", "-q", "--hard", "HEAD~1");
    git(again, "push", "-q", "--force", "origin", "main");
  }, 180_000);

  test("a ledger that is not a valid ledger of this dataset fails", async () => {
    const repo = fresh();
    write(repo, ".nemar/corrections.jsonl", LEDGER_LINE.replace(DATASET, "nm000123"));
    git(repo, "add", ".nemar/corrections.jsonl");
    git(repo, "commit", "-q", "-m", "a ledger for another dataset");
    const r = await verifyFresh(repo);
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=ledger-invalid");
  }, 120_000);

  test("an old key that survives in a pushed ref fails, and no proof is left", async () => {
    // Someone pushes the ORIGINAL history under another branch name.
    const leak = fresh();
    git(leak, "fetch", "-q", fx.src, "main:refs/heads/original");
    git(leak, "push", "-q", "origin", "refs/heads/original:refs/heads/original");
    try {
      const proof = join(fx.root, "leak-proof.json");
      writeFileSync(proof, "{}");
      const r = await verifyFresh(fresh(), proof);
      expect(r.code, r.out).toBe(4);
      expect(r.out).toContain("reason=old-key-present");
      expect(r.out).toContain("reason=edf-key-unaccounted");
      expect(existsSync(proof)).toBe(false);
    } finally {
      git(leak, "push", "-q", "origin", ":refs/heads/original");
    }
  }, 120_000);

  test("tag names that are not the S3 plan's fail", async () => {
    const repo = fresh();
    git(repo, "tag", "v9.9.9");
    const r = await verifyFresh(repo);
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=tag-names-not-plan count=1");
  }, 120_000);

  test("--allow-tag accepts a tag the S3 plan lacks, by name, and the proof records it", async () => {
    const repo = fresh();
    git(repo, "tag", "v9.9.9");
    const proof = join(fx.root, "allow-proof.json");
    const without = await verifyFresh(repo, proof);
    expect(without.code, without.out).toBe(4);
    expect(without.out).toContain("reason=tag-names-not-plan count=1");
    expect(existsSync(proof)).toBe(false);

    const ok = await verifyFresh(repo, proof, allow("v9.9.9"));
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("verify: ok mode=fresh-clone allowedTags=1 ");
    // The counts are the ones the plain run prints, plus the one.
    expect(counts(ok.out, "verify: ok")).toMatchObject({
      allowedTags: 1,
      refs: expect.any(Number),
    });
    const parsed = parseGitVerified(readFileSync(proof, "utf8"));
    expect(parsed.mode).toBe("fresh-clone");
    expect(parsed.allowedTags).toEqual(["v9.9.9"]);
    expect(parsed.counts).not.toHaveProperty("allowedTags");
  }, 180_000);

  test("--allow-tag is repeatable; the proof lists the names sorted, without duplicates", async () => {
    const repo = fresh();
    const extra = ["v9.9.9", "v9.10.0-rc1", "v9.9.9-B", "v9.9.9-a"];
    for (const t of extra) git(repo, "tag", t);
    const proof = join(fx.root, "allow-two-proof.json");
    const ok = await verifyFresh(
      repo,
      proof,
      allow("v9.9.9", "v9.10.0-rc1", "v9.9.9-a", "v9.9.9-B", "v9.9.9"),
    );
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("allowedTags=4 ");
    // Sorted by code unit (upper case before lower case, "10" before "9"), which is what the
    // proof's parser requires; a locale-aware sort writes a proof the parser then refuses.
    expect(parseGitVerified(readFileSync(proof, "utf8")).allowedTags).toEqual([
      "v9.10.0-rc1",
      "v9.9.9",
      "v9.9.9-B",
      "v9.9.9-a",
    ]);
    // One of the four alone leaves the other three unplanned.
    const one = await verifyFresh(repo, proof, allow("v9.9.9"));
    expect(one.code, one.out).toBe(4);
    expect(one.out).toContain("reason=tag-names-not-plan count=3");
    expect(one.out).toContain("verify: failed mode=fresh-clone allowedTags=1 ");
  }, 180_000);

  test("an allowed name that is already one of the S3 plan's tags is accepted silently", async () => {
    const repo = fresh();
    const proof = join(fx.root, "allow-planned-proof.json");
    const r = await verifyFresh(repo, proof, allow("v1.0.1"));
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("FAIL");
    expect(parseGitVerified(readFileSync(proof, "utf8")).allowedTags).toEqual(["v1.0.1"]);
  }, 120_000);

  test("an allowed tag the repository does not have is allowed-tag-missing", async () => {
    const proof = join(fx.root, "allow-missing-proof.json");
    writeFileSync(proof, "{}");
    const r = await verifyFresh(fresh(), proof, allow("v8.8.8"));
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=allowed-tag-missing count=1");
    // It is the allowance that is wrong, not the repository's tag names.
    expect(r.out).not.toContain("tag-names-not-plan");
    expect(existsSync(proof)).toBe(false);

    // A name the S3 plan lists is still a tag the repository must have.
    const planned = fresh();
    git(planned, "tag", "-d", "v1.0.1");
    const gone = await verifyFresh(planned, proof, allow("v1.0.1"));
    expect(gone.code, gone.out).toBe(4);
    expect(gone.out).toContain("reason=allowed-tag-missing count=1");
    expect(gone.out).toContain("reason=tag-names-not-plan count=1");

    // The count is of names, not a flag: two missing names are two.
    const two = await verifyFresh(fresh(), proof, allow("v8.8.8", "v8.8.9"));
    expect(two.code, two.out).toBe(4);
    expect(two.out).toContain("reason=allowed-tag-missing count=2");

    // Only a TAG of that name counts: a branch called v8.8.8 does not make the allowance good.
    const branch = fresh();
    git(branch, "branch", "v8.8.8");
    const notATag = await verifyFresh(branch, proof, allow("v8.8.8"));
    expect(notATag.code, notATag.out).toBe(4);
    expect(notATag.out).toContain("reason=allowed-tag-missing count=1");
    expect(notATag.out).not.toContain("tag-names-not-plan");

    // A typo: the extra tag stays unplanned and the name that was typed is missing.
    const typo = fresh();
    git(typo, "tag", "v9.9.9");
    const wrong = await verifyFresh(typo, proof, allow("v9.9.8"));
    expect(wrong.code, wrong.out).toBe(4);
    expect(wrong.out).toContain("reason=tag-names-not-plan count=1");
    expect(wrong.out).toContain("reason=allowed-tag-missing count=1");
    expect(existsSync(proof)).toBe(false);
  }, 240_000);

  test("the allowance is for the name: an allowed tag whose tree holds an old key still fails", async () => {
    // The tag names the ORIGINAL history, as a release that was never rewritten would.
    const repo = fresh();
    git(repo, "fetch", "-q", fx.src, "main");
    git(repo, "tag", "v9.9.9", "FETCH_HEAD");
    const proof = join(fx.root, "allow-old-key-proof.json");
    writeFileSync(proof, "{}");
    const r = await verifyFresh(repo, proof, allow("v9.9.9"));
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=old-key-present");
    expect(r.out).toContain("reason=edf-key-unaccounted");
    // The name is accepted; only the tree is the problem.
    expect(r.out).not.toContain("tag-names-not-plan");
    expect(existsSync(proof)).toBe(false);
  }, 120_000);

  test("an allowed annotated tag is read like any other: an old key in its message still fails", async () => {
    const repo = fresh();
    git(repo, "tag", "-a", "v9.9.9", "-m", `released from ${parseKey(OLD_A).sha256}`);
    const proof = join(fx.root, "allow-annotated-proof.json");
    writeFileSync(proof, "{}");
    const r = await verifyFresh(repo, proof, allow("v9.9.9"));
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=old-key-in-message");
    expect(r.out).not.toContain("tag-names-not-plan");
    expect(existsSync(proof)).toBe(false);
    // The same tag with a clean message is accepted: the message was the only problem.
    git(repo, "tag", "-d", "v9.9.9");
    git(repo, "tag", "-a", "v9.9.9", "-m", "a clean release note");
    const ok = await verifyFresh(repo, proof, allow("v9.9.9"));
    expect(ok.code, ok.out).toBe(0);
  }, 180_000);

  test("--allow-tag takes a version tag and is for --fresh-clone only (usage errors)", async () => {
    const base = ["--repo", work, "--keymap", fx.keymapPath, "--plan", fx.planPath];
    const proof = join(fx.root, "allow-usage-proof.json");
    // A usage error is a run that did not pass: a proof from an earlier run must not outlive it.
    const stale = () => writeFileSync(proof, "{}");
    for (const name of ["main", "1.1.1", "v1.1", "v1.1.1/x", "v1.1.1 ", ""]) {
      stale();
      const r = await cli([
        "verify",
        "--fresh-clone",
        ...base,
        "--s3-plan",
        s3Plan,
        "--proof-out",
        proof,
        "--allow-tag",
        name,
      ]);
      expect(r.code, `${JSON.stringify(name)}: ${r.out}`).toBe(2);
      expect(r.out).toContain("--allow-tag takes a version tag");
      // A name is never echoed back.
      if (name !== "") expect(r.out).not.toContain(name);
      expect(existsSync(proof)).toBe(false);
    }
    // A flag with no value is a usage error too.
    const bare = await cli([
      "verify",
      "--fresh-clone",
      ...base,
      "--s3-plan",
      s3Plan,
      "--allow-tag",
    ]);
    expect(bare.code, bare.out).toBe(2);

    // Local mode compares with the snapshot: the flag means nothing there, so it is refused.
    stale();
    const local = await cli([
      "verify",
      ...base,
      "--s3-plan",
      s3Plan,
      "--before",
      join(fx.root, "before.json"),
      "--proof-out",
      proof,
      "--allow-tag",
      "v1.0.1",
    ]);
    expect(local.code, local.out).toBe(2);
    expect(local.out).toContain("--allow-tag is for --fresh-clone only");
    expect(existsSync(proof)).toBe(false);
  }, 120_000);

  test("the library refuses an allowance in local mode and a name that is no version tag", async () => {
    const { keymap, plan } = readInputs(fx.keymapPath, fx.planPath);
    const base = { repo: work, keymap, plan, s3Plan: readS3Plan(s3Plan) };
    const local = verifyRewrite({
      ...base,
      mode: "local",
      before: readSnapshot(join(fx.root, "before.json")),
      allowTags: ["v1.0.1"],
    });
    await expect(local).rejects.toBeInstanceOf(GitScrubError);
    await expect(local).rejects.toThrow("refused: allow-tag-not-for-local");
    // The CLI checks first, so only a direct call shows that the library does not rely on it.
    for (const name of ["main", "1.1.1", "v1.1", "v1.1.1/x", "v1.1.1\n", "v1.1.1 ", ""]) {
      const named = verifyRewrite({ ...base, mode: "fresh-clone", allowTags: ["v1.0.1", name] });
      await expect(named, JSON.stringify(name)).rejects.toThrow("bad-input: allow-tag-not-semver");
    }
  }, 120_000);

  test("a git-annex branch that does not record the registration fails", async () => {
    // What a fresh clone sees when the registration was never pushed: the git-annex branch as
    // it was published, with the source holding every old key and no new key recorded.
    const repo = fresh();
    const published = git(fx.src, "rev-parse", "refs/heads/git-annex").trim();
    git(repo, "fetch", "-q", fx.src, "refs/heads/git-annex"); // objects only, into FETCH_HEAD
    git(repo, "update-ref", "refs/remotes/origin/git-annex", published);
    const r = await verifyFresh(repo);
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=annex-old-key-held count=3");
    expect(r.out).toContain("reason=annex-new-key-unregistered count=3");
    git(repo, "update-ref", "-d", "refs/remotes/origin/git-annex");
    const none = await verifyFresh(repo);
    expect(none.out).toContain("reason=annex-branch-missing count=1");
  }, 120_000);

  test("--fresh-clone takes no --before, and leaves no earlier proof behind", async () => {
    const proof = join(fx.root, "before-usage-proof.json");
    writeFileSync(proof, "{}");
    const r = await cli([
      "verify",
      "--fresh-clone",
      "--repo",
      work,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--s3-plan",
      s3Plan,
      "--before",
      join(fx.root, "before.json"),
      "--proof-out",
      proof,
    ]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--fresh-clone takes no --before");
    expect(existsSync(proof)).toBe(false);
  });

  test("hashDirLower is git-annex's own hashdirlower", () => {
    for (const key of [OLD_A, OLD_B, OLD_C, KEEP]) {
      const want = sh(work, ["git", "annex", "examinekey", "--format=${hashdirlower}", key]);
      expect(hashDirLower(key)).toBe(want.trim());
    }
  });
});
