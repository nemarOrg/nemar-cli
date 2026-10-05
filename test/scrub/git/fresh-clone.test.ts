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
import { parseGitVerified } from "../../../scripts/scrub/contract";
import { hashDirLower } from "../../../scripts/scrub/git/git-lib";
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
  const verifyFresh = (repo: string, proof = join(fx.root, `proof-${n}.json`)) =>
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
    ]);

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

  test("--fresh-clone takes no --before", async () => {
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
    ]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--fresh-clone takes no --before");
  });

  test("hashDirLower is git-annex's own hashdirlower", () => {
    for (const key of [OLD_A, OLD_B, OLD_C, KEEP]) {
      const want = sh(work, ["git", "annex", "examinekey", "--format=${hashdirlower}", key]);
      expect(hashDirLower(key)).toBe(want.trim());
    }
  });
});
