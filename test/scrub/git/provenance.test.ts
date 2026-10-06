/**
 * A dataset that mirrors upstream recordings under `sourcedata/` and lists each original's sha256
 * in `sourcedata/sourcedata_provenance.json`, scrubbed purely in place (nothing dropped): the shape
 * of nm000186, on whose first real run `git-scrub verify` failed `old-key-present count=2` on the
 * two versions of that file. ADR 0085 keeps those checksums as upstream provenance, so the plan
 * says so in the file (`privacy_correction`), and verify lets an old hash stand there and nowhere
 * else: only as the `sha256` of a `files` entry, only in a blob that is that file and nothing
 * else in every commit, and only when the file carries the sentence.
 *
 * Real throughout: the plan builder, the rewrite (git-filter-repo through uv), `git-scrub` run as a
 * process, git-annex, and a bare repository as the stand-in for GitHub. Every value is invented.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GitPlanFile, parseGitVerified } from "../../../scripts/scrub/contract";
import { PROVENANCE_MAX_BYTES, provenanceHashUse } from "../../../scripts/scrub/git/git-lib";
import {
  type PlanReport,
  buildGitPlan,
  provenanceNote,
  provenanceReadmeNote,
} from "../../../scripts/scrub/plan/build-git-plan";
import {
  HAVE_ANNEX,
  HAVE_REWRITE_TOOLS,
  MIRROR_DATASET,
  MIRROR_PROVENANCE,
  MIRROR_README,
  MIRROR_TAGS,
  type MirrorFixture,
  anyObjectContains,
  buildMirrorFixture,
  cleanupRoots,
  cli,
  cloneOf,
  commitAll,
  copyTree,
  counts,
  datasetUrl,
  fileAt,
  git,
  mirrorChecksum,
  mirrorEventsChecksum,
  mirrorOriginal,
  mirrorRecording,
  sh,
  sha,
  write,
} from "./fixture";

afterAll(cleanupRoots);

const SUITE = HAVE_REWRITE_TOOLS && HAVE_ANNEX ? describe : describe.skip;
const DATE = "2026-10-06";

// -----------------------------------------------------------------------------------------
// The rule itself, on bytes: where an old hash may sit in the provenance file
// -----------------------------------------------------------------------------------------

describe("provenanceHashUse places every old hash in a provenance blob", () => {
  const A = sha("prov-a");
  const B = sha("prov-b");
  const OLD = new Set([A, B]);
  const NOTE = "2026-10-06: scrubbed in place; the checksums describe the upstream files.";
  const doc = (over: Record<string, unknown> = {}, files?: unknown[]) =>
    JSON.stringify(
      {
        n_files: 2,
        files: files ?? [
          { file: "a.edf", bytes: 1, sha256: A },
          { file: "b.edf", bytes: 2, sha256: B },
        ],
        privacy_correction: NOTE,
        ...over,
      },
      null,
      2,
    );
  const use = (text: string) => provenanceHashUse(new TextEncoder().encode(text), OLD);

  test("kept: every old hash is a files[].sha256 value and the file carries the sentence", () => {
    expect(use(doc())).toEqual({ use: "kept", hashes: new Set([A, B]) });
    // A checksum that is no old key's is neither a hit nor counted as kept.
    const notOld = sha("prov-not-old");
    expect(use(doc({}, [{ sha256: A }, { sha256: notOld }, { sha256: B }]))).toEqual({
      use: "kept",
      hashes: new Set([A, B]),
    });
    // A byte-order mark, capitals and a second `files` key are still the same values.
    expect(use(`\uFEFF${doc()}`).use).toBe("kept");
    expect(use(doc({}, [{ sha256: A.toUpperCase() }])).use).toBe("kept");
    const twice = `{"files": [{"sha256": "${A}"}], "files": [{"sha256": "${B}"}], "privacy_correction": "x"}`;
    expect(use(twice)).toEqual({ use: "kept", hashes: new Set([A, B]) });
  });

  test("unannotated: the same file with no sentence, an empty one, or one that is not text", () => {
    for (const over of [
      { privacy_correction: undefined },
      { privacy_correction: "" },
      { privacy_correction: "  " },
      { privacy_correction: true },
    ]) {
      expect(use(doc(over)), JSON.stringify(over)).toEqual({
        use: "unannotated",
        hashes: new Set([A, B]),
      });
    }
  });

  test("elsewhere: an old hash anywhere but a files[].sha256 value, or a file that is not a JSON object", () => {
    const cases: Record<string, string> = {
      "in the sentence": doc({ privacy_correction: `${NOTE} (was ${A})` }),
      "in another field of an entry": doc({}, [{ file: "a.edf", sha256: A, previous: B }]),
      "nested inside an entry": doc({}, [{ sha256: A, detail: { sha256: B } }]),
      "in another top-level array": doc({ removed: [{ sha256: A }] }),
      "as a key": doc({ [A]: 1 }),
      "inside a longer value": doc({}, [{ sha256: `sha256:${A}` }]),
      "as a whole entry": doc({}, [{ sha256: A }, B]),
      "in a files entry that is not an object": doc({}, [[A]]),
      "files is not an array": doc({ files: { sha256: A } }),
      "a JSON array": JSON.stringify([{ sha256: A }]),
      "not JSON": `{"files": [{"sha256": "${A}"}`,
      "not UTF-8": `{"files": [{"sha256": "${A}"}], "x": "\xe9"}`,
    };
    for (const [name, text] of Object.entries(cases)) {
      const bytes =
        name === "not UTF-8" ? Buffer.from(text, "latin1") : new TextEncoder().encode(text);
      expect(provenanceHashUse(bytes, OLD), name).toEqual({ use: "elsewhere" });
    }
  });

  test("elsewhere, not a crash: nesting JSON.parse accepts but the walk cannot follow", () => {
    // Measured with Bun 1.4.2: JSON.parse reads 50,000 levels; the walk's stack does not.
    const depth = 50_000;
    const deep = doc({ deep: "@" }).replace('"@"', `${"[".repeat(depth)}${"]".repeat(depth)}`);
    expect(() => JSON.parse(deep)).not.toThrow();
    expect(use(deep)).toEqual({ use: "elsewhere" });
  });
});

// -----------------------------------------------------------------------------------------
// Plan, rewrite and verify, as the operator runs them
// -----------------------------------------------------------------------------------------

SUITE("a sourcedata mirror scrubbed in place keeps its upstream checksums (ADR 0085)", () => {
  let fx: MirrorFixture;
  let plan: GitPlanFile;
  let report: PlanReport;
  let before: string;
  let pristine: string;
  let rewriteOut: { code: number; out: string };
  let verifyOut: { code: number; out: string };
  let localProof: string;
  let n = 0;

  const verifyLocal = (repo: string, planPath = fx.planPath) => {
    n += 1;
    return cli([
      "verify",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      planPath,
      "--s3-plan",
      fx.s3PlanPath,
      "--before",
      before,
      "--proof-out",
      join(fx.root, `proof-local-${n}.json`),
    ]);
  };

  /** The rewritten clone, copied, damaged one way, and verified against the same snapshot. */
  async function verifyDamaged(name: string, damage: (repo: string) => void) {
    const repo = join(fx.root, `damaged-${name}`);
    copyTree(fx.clone, repo);
    damage(repo);
    return verifyLocal(repo);
  }

  /** The rewritten provenance file at `ref`, parsed. */
  const provenanceAt = (repo: string, ref: string) =>
    JSON.parse(fileAt(repo, ref, MIRROR_PROVENANCE) as string) as {
      files: { file: string; sha256: string }[];
      privacy_correction?: string;
      [k: string]: unknown;
    };

  beforeAll(async () => {
    fx = buildMirrorFixture();
    pristine = join(fx.root, "pristine");
    copyTree(fx.clone, pristine);
    ({ plan, report } = buildGitPlan(fx.clone, MIRROR_DATASET, DATE, {
      s3PlanPath: fx.s3PlanPath,
    }));
    writeFileSync(fx.planPath, JSON.stringify(plan));
    before = join(fx.root, "before.json");
    rewriteOut = await cli([
      "rewrite",
      "--repo",
      fx.clone,
      "--keymap",
      fx.keymapPath,
      "--plan",
      fx.planPath,
      "--snapshot-out",
      before,
    ]);
    localProof = join(fx.root, "local-proof.json");
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
      before,
      "--proof-out",
      localProof,
    ]);
  }, 180_000);

  test("the plan annotates the provenance file and its README, and drops nothing", () => {
    expect(plan.dropPaths).toEqual([]);
    expect(plan.jsonOps).toEqual({
      [MIRROR_PROVENANCE]: [
        { op: "set", key: "privacy_correction", value: provenanceNote(DATE, "scrubbed-in-place") },
      ],
    });
    expect(plan.appendText[MIRROR_README]).toBe(provenanceReadmeNote(DATE, "scrubbed-in-place"));
    expect(report).toMatchObject({
      dropPaths: 0,
      provenanceEntriesDropped: 0,
      provenanceAnnotated: 1,
      provenanceReadmeAnnotated: 1,
      s3KeysScrubbed: 6,
      orphanKeys: 0,
    });
  });

  test("rewrite and verify pass, and verify counts the upstream checksums it kept", () => {
    expect(rewriteOut.code, rewriteOut.out).toBe(0);
    expect(verifyOut.code, verifyOut.out).toBe(0);
    // Three distinct checksums, in the two versions of the file (v1.0.0's two, and three later);
    // the events file's checksum, in both, is no old key's and is not counted.
    expect(counts(verifyOut.out, "verify: ok")).toMatchObject({
      provenanceHashesKept: 3,
      provenanceBlobsKept: 2,
    });
    const proof = parseGitVerified(readFileSync(localProof, "utf8"));
    expect(proof.counts).toMatchObject({ provenanceHashesKept: 3, provenanceBlobsKept: 2 });
    // Counts only: no checksum and no path on the terminal.
    for (const secret of [mirrorChecksum(1), MIRROR_PROVENANCE, "upstream"]) {
      expect(verifyOut.out).not.toContain(secret);
    }
  });

  test("what was kept, read with plain git: the upstream checksums and the sentence, in every version, and no old key anywhere else", () => {
    for (const ref of [...MIRROR_TAGS, "main"]) {
      const doc = provenanceAt(fx.clone, ref);
      const ns = ref === "v1.0.0" ? [1, 2] : [1, 2, 3];
      expect(
        doc.files.map((f) => f.sha256),
        ref,
      ).toEqual([...ns.map(mirrorChecksum), mirrorEventsChecksum()]);
      expect(doc.privacy_correction, ref).toBe(provenanceNote(DATE, "scrubbed-in-place"));
      expect(
        fileAt(fx.clone, ref, MIRROR_README)?.endsWith(
          provenanceReadmeNote(DATE, "scrubbed-in-place"),
        ),
      ).toBe(true);
    }
    // The positive control: the source holds every old key, the rewrite holds none of them, and
    // a recording's hash, which no provenance file lists, is gone everywhere.
    for (const k of [1, 2, 3]) {
      expect(anyObjectContains(fx.src, mirrorOriginal(k))).toBe(true);
      expect(anyObjectContains(fx.clone, mirrorOriginal(k))).toBe(false);
      expect(anyObjectContains(fx.clone, mirrorRecording(k))).toBe(false);
      expect(anyObjectContains(fx.clone, sha(`mirror-rec-${k}`))).toBe(false);
    }
  });

  test("the defect as found on nm000186: a rewrite from a plan that did not annotate fails provenance-unannotated, and only that", async () => {
    // The plan as the builder made it before the fix: no sentence and no README note
    // (JSON.stringify leaves the undefined member out).
    const unannotated = {
      ...plan,
      jsonOps: undefined,
      appendText: { CHANGES: plan.appendText.CHANGES as string },
    };
    const planPath = join(fx.root, "git-plan-unannotated.json");
    writeFileSync(planPath, JSON.stringify(unannotated));
    const repo = join(fx.root, "unannotated");
    copyTree(pristine, repo);
    const rewritten = await cli([
      "rewrite",
      "--repo",
      repo,
      "--keymap",
      fx.keymapPath,
      "--plan",
      planPath,
    ]);
    expect(rewritten.code, rewritten.out).toBe(0);
    const r = await verifyLocal(repo, planPath);
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("verify: FAIL reason=provenance-unannotated count=2");
    expect(r.out.match(/verify: FAIL/g)).toHaveLength(1);
    expect(counts(r.out, "verify: failed")).toMatchObject({
      provenanceHashesKept: 0,
      provenanceBlobsKept: 0,
    });
  }, 120_000);

  test("an old hash in any other file fails, even in a file shaped exactly like the provenance file", async () => {
    const r = await verifyDamaged("other-file", (repo) => {
      // The provenance file, annotated and all, one field added, at another path.
      write(
        repo,
        "derivatives/provenance.json",
        JSON.stringify({ ...provenanceAt(repo, "main"), copy: true }, null, 2),
      );
      write(repo, "notes.txt", `the original was ${mirrorChecksum(1)}\n`);
      commitAll(repo, "two more files");
    });
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=old-key-present count=2");
    expect(counts(r.out, "verify: failed")).toMatchObject({ provenanceBlobsKept: 2 });
  });

  test("an old hash in the provenance file anywhere but a sha256 value of files fails", async () => {
    const variants: Record<string, (doc: Record<string, unknown>) => void> = {
      sentence: (doc) => {
        doc.privacy_correction = `${doc.privacy_correction} (was ${mirrorChecksum(1)})`;
      },
      "another field": (doc) => {
        (doc.files as Record<string, unknown>[])[0] = {
          ...(doc.files as Record<string, unknown>[])[0],
          previous_sha256: mirrorChecksum(2),
        };
      },
      "another array": (doc) => {
        doc.removed = [{ sha256: mirrorChecksum(1) }];
      },
      "nested in an entry": (doc) => {
        (doc.files as Record<string, unknown>[])[0] = {
          ...(doc.files as Record<string, unknown>[])[0],
          detail: { sha256: mirrorChecksum(3) },
        };
      },
    };
    for (const [name, edit] of Object.entries(variants)) {
      const r = await verifyDamaged(`field-${name.replace(/ /g, "-")}`, (repo) => {
        const doc = provenanceAt(repo, "main");
        edit(doc);
        write(repo, MIRROR_PROVENANCE, `${JSON.stringify(doc, null, 2)}\n`);
        commitAll(repo, `provenance ${name}`);
      });
      expect(r.code, `${name}: ${r.out}`).toBe(4);
      expect(r.out, name).toContain("reason=old-key-present count=1");
      expect(r.out, name).not.toContain("reason=provenance-unannotated");
    }
  }, 120_000);

  test("the provenance blob under a second path fails, though rev-list names it by the provenance path", async () => {
    let blob = "";
    const r = await verifyDamaged("second-path", (repo) => {
      // The very same bytes, so the very same blob, also at a path that sorts after `sourcedata`.
      write(repo, "zz/copy.json", fileAt(repo, "main", MIRROR_PROVENANCE) as string);
      commitAll(repo, "a copy of the provenance file");
      blob = git(repo, "rev-parse", "main:zz/copy.json").trim();
      expect(git(repo, "rev-parse", `main:${MIRROR_PROVENANCE}`).trim()).toBe(blob);
      // The first path rev-list meets the blob at is the provenance path: only a rule over
      // every path the blob has catches it.
      const listed = git(repo, "rev-list", "--objects", "--all")
        .split("\n")
        .find((line) => line.startsWith(`${blob} `));
      expect(listed).toBe(`${blob} ${MIRROR_PROVENANCE}`);
    });
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=old-key-present count=1");
    expect(counts(r.out, "verify: failed")).toMatchObject({ provenanceBlobsKept: 1 });
  });

  test("a root-tree ref, as git-annex writes refs/annex/last-index, keeps the exception", async () => {
    let kind = "";
    const r = await verifyDamaged("root-tree-ref", (repo) => {
      // git-annex 10.20260901 writes `refs/annex/last-index` on this checkout (10.20240129 does
      // on `git status`): a ref to the root tree of the index. Made by hand where it does not.
      git(repo, "checkout", "-q", "main");
      const has = git(repo, "for-each-ref", "--format=%(refname)", "refs/annex/last-index").trim();
      if (has === "")
        git(repo, "update-ref", "refs/annex/last-index", git(repo, "write-tree").trim());
      kind = git(repo, "cat-file", "-t", "refs/annex/last-index").trim();
    });
    expect(kind).toBe("tree");
    expect(r.code, r.out).toBe(0);
    expect(counts(r.out, "verify: ok")).toMatchObject({
      provenanceHashesKept: 3,
      provenanceBlobsKept: 2,
    });
  });

  test("a ref to a subtree, where the provenance blob has another path, fails", async () => {
    const r = await verifyDamaged("subtree-ref", (repo) => {
      // The `sourcedata` tree, where the tip's provenance blob is `sourcedata_provenance.json`.
      git(repo, "tag", "tree-of-sourcedata", "main:sourcedata");
    });
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=old-key-present count=1");
    expect(counts(r.out, "verify: failed")).toMatchObject({ provenanceBlobsKept: 1 });
  });

  test("a ref to a tree that also holds the provenance blob at zz/copy.json fails", async () => {
    const r = await verifyDamaged("tree-second-path", (repo) => {
      const index = join(repo, "..", "tree-second-path.index");
      const withIndex = (...args: string[]) =>
        sh(repo, ["env", `GIT_INDEX_FILE=${index}`, "git", ...args]);
      const blob = git(repo, "rev-parse", `main:${MIRROR_PROVENANCE}`).trim();
      withIndex("read-tree", "main");
      withIndex("update-index", "--add", "--cacheinfo", `100644,${blob},zz/copy.json`);
      git(repo, "update-ref", "refs/annex/last-index", withIndex("write-tree").trim());
    });
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=old-key-present count=1");
    expect(counts(r.out, "verify: failed")).toMatchObject({ provenanceBlobsKept: 1 });
  });

  test("a ref to a blob gives that blob no path, and turns the exception off", async () => {
    const r = await verifyDamaged("blob-ref", (repo) => {
      git(repo, "tag", "provenance-blob", `main:${MIRROR_PROVENANCE}`);
    });
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=old-key-present count=2");
    expect(counts(r.out, "verify: failed")).toMatchObject({
      provenanceHashesKept: 0,
      provenanceBlobsKept: 0,
    });
  });

  test("a path that only resembles the provenance path fails: under a subdirectory, with a suffix, or another file in sourcedata", async () => {
    for (const path of [
      `x/${MIRROR_PROVENANCE}`,
      `${MIRROR_PROVENANCE}.bak`,
      "sourcedata/other.json",
    ]) {
      const r = await verifyDamaged(`look-alike-${path.replace(/[/.]/g, "-")}`, (repo) => {
        // Annotated, checksums only in files[].sha256, and new bytes, so a blob of its own.
        const doc = { ...provenanceAt(repo, "main"), copy: path };
        write(repo, path, `${JSON.stringify(doc, null, 2)}\n`);
        commitAll(repo, `a look-alike at ${path}`);
      });
      expect(r.code, `${path}: ${r.out}`).toBe(4);
      expect(r.out, path).toContain("reason=old-key-present count=1");
      expect(counts(r.out, "verify: failed"), path).toMatchObject({ provenanceBlobsKept: 2 });
    }
  }, 120_000);

  test("only a regular file keeps the checksums: a symlink at the path fails, an executable file does not", async () => {
    const link = await verifyDamaged("symlink-mode", (repo) => {
      // A symlink whose target text is the annotated provenance JSON, at the provenance path.
      const doc = { ...provenanceAt(repo, "main"), link: true };
      const blob = sh(repo, ["git", "hash-object", "-w", "--stdin"], JSON.stringify(doc)).trim();
      git(repo, "update-index", "--cacheinfo", `120000,${blob},${MIRROR_PROVENANCE}`);
      git(repo, "commit", "-q", "-m", "provenance as a symlink");
      expect(git(repo, "ls-tree", "main", MIRROR_PROVENANCE)).toStartWith("120000 blob");
    });
    expect(link.code, link.out).toBe(4);
    expect(link.out).toContain("reason=old-key-present count=1");
    const executable = await verifyDamaged("executable-mode", (repo) => {
      git(repo, "update-index", "--chmod=+x", MIRROR_PROVENANCE);
      git(repo, "commit", "-q", "-m", "provenance made executable");
      expect(git(repo, "ls-tree", "main", MIRROR_PROVENANCE)).toStartWith("100755 blob");
    });
    expect(executable.out).not.toContain("reason=old-key-present");
    expect(counts(executable.out, "verify: failed")).toMatchObject({ provenanceBlobsKept: 2 });
  });

  test(`a provenance blob over ${PROVENANCE_MAX_BYTES} bytes is not read: provenance-too-large`, async () => {
    const r = await verifyDamaged("too-large", (repo) => {
      const doc = { ...provenanceAt(repo, "main"), pad: "x".repeat(PROVENANCE_MAX_BYTES) };
      write(repo, MIRROR_PROVENANCE, `${JSON.stringify(doc, null, 2)}\n`);
      commitAll(repo, "a provenance file over the limit");
    });
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=provenance-too-large count=1");
    expect(r.out).not.toContain("reason=old-key-present");
    expect(counts(r.out, "verify: failed")).toMatchObject({ provenanceBlobsKept: 2 });
  }, 120_000);

  test("a provenance file whose sentence was removed fails provenance-unannotated", async () => {
    const r = await verifyDamaged("sentence-removed", (repo) => {
      const doc = provenanceAt(repo, "main");
      doc.privacy_correction = undefined; // left out by JSON.stringify
      write(repo, MIRROR_PROVENANCE, `${JSON.stringify(doc, null, 2)}\n`);
      commitAll(repo, "sentence removed");
    });
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain("reason=provenance-unannotated count=1");
    expect(r.out).not.toContain("reason=old-key-present");
  });

  // ---- the pushed repository, verified from a fresh clone (runbook step 14) ------------------

  describe("verify --fresh-clone behaves the same", () => {
    let m = 0;
    const fresh = (): string => {
      m += 1;
      const dir = join(fx.root, `fresh-${m}`);
      cloneOf(fx.bare, dir, datasetUrl(MIRROR_DATASET));
      return dir;
    };
    const verifyFresh = (repo: string, proof = join(fx.root, `proof-fresh-${m}.json`)) =>
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
        fx.s3PlanPath,
        "--proof-out",
        proof,
      ]);
    /** Push one commit to a new branch of the "GitHub" repository, verify fresh, then remove it. */
    async function pushedBranch(name: string, damage: (repo: string) => void) {
      const work = fresh();
      damage(work);
      commitAll(work, name);
      git(work, "push", "-q", "origin", `HEAD:refs/heads/${name}`);
      try {
        return await verifyFresh(fresh());
      } finally {
        git(work, "push", "-q", "origin", `:refs/heads/${name}`);
      }
    }

    beforeAll(async () => {
      // Register and push from a copy, so the clone the local tests read keeps its annex branch.
      const work = join(fx.root, "operator-push");
      copyTree(fx.clone, work);
      const reg = await cli([
        "annex-registry",
        "--repo",
        work,
        "--keymap",
        fx.keymapPath,
        "--execute",
      ]);
      if (reg.code !== 0) throw new Error(`annex-registry failed: ${reg.out}`);
      git(work, "push", "-q", "--force", "origin", "refs/heads/main:refs/heads/main");
      git(work, "push", "-q", "--force", "origin", "--tags");
      // As in fresh-clone.test.ts: a local-path remote's git-annex branch may have moved.
      git(work, "fetch", "-q", "origin", "git-annex");
      sh(work, ["git", "annex", "merge", "--quiet"]);
      git(work, "push", "-q", "origin", "refs/heads/git-annex:refs/heads/git-annex");
    }, 180_000);

    test("a fresh clone of what was pushed verifies, keeps the same checksums, and the proof says so", async () => {
      const proof = join(fx.root, "fresh-proof.json");
      const r = await verifyFresh(fresh(), proof);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("verify: ok mode=fresh-clone");
      expect(counts(r.out, "verify: ok")).toMatchObject({
        provenanceHashesKept: 3,
        provenanceBlobsKept: 2,
      });
      const parsed = parseGitVerified(readFileSync(proof, "utf8"));
      expect(parsed.mode).toBe("fresh-clone");
      expect(parsed.counts).toMatchObject({ provenanceHashesKept: 3, provenanceBlobsKept: 2 });
    }, 120_000);

    test("pushed: an old hash in another file fails", async () => {
      const r = await pushedBranch("leak", (repo) => {
        write(repo, "notes.txt", `the original was ${mirrorChecksum(2)}\n`);
      });
      expect(r.code, r.out).toBe(4);
      expect(r.out).toContain("reason=old-key-present count=1");
    }, 120_000);

    test("pushed: a provenance file without its sentence fails provenance-unannotated", async () => {
      const r = await pushedBranch("unannotated", (repo) => {
        const doc = provenanceAt(repo, "HEAD");
        doc.privacy_correction = undefined; // left out by JSON.stringify
        write(repo, MIRROR_PROVENANCE, `${JSON.stringify(doc, null, 2)}\n`);
      });
      expect(r.code, r.out).toBe(4);
      expect(r.out).toContain("reason=provenance-unannotated count=1");
      expect(r.out).not.toContain("reason=old-key-present");
    }, 120_000);
  });
});
