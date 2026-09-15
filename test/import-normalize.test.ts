/**
 * Bringing an imported clone onto NEMAR's annex policy (#1159, ADR 0060).
 *
 * The fixture is built the way OpenNeuro actually builds a repo, in two respects
 * that each caught a real defect:
 *
 *  - the largefiles rule arrives as a `.gitattributes` file, copied in shape from
 *    the live `nemarDatasets/on007788`, NOT as a `git annex config` value. A
 *    `.gitattributes` setting outranks the config, which is why NEMAR's policy
 *    never governed an imported tree, and a config-based fixture would test a
 *    repo shape no import ever sees.
 *  - the branch is plain locked `main`, which is what a fresh OpenNeuro clone is
 *    (and what `decideReimportMainReset` requires), rather than the
 *    adjusted-unlock branch `initDataset` leaves behind. One test covers the
 *    unlocked shape explicitly, because an annexed file there is a pointer file
 *    rather than a symlink.
 *
 * git-annex is the oracle throughout: which plane a file landed on is read back
 * with `git annex find`, content arrival is checked by fetching it out of a real
 * `type=directory` special remote, and no test supplies a step production omits.
 *
 * Every test here touches a real repository, so each carries an explicit timeout:
 * the required CI tier runs `bun test` without `--timeout`, where the default is
 * 5 s.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configureLargefiles, gitAnnexAdd } from "../src/lib/git-annex/init";
import { buildLargefilesExpression } from "../src/lib/git-annex/policy";
import { runCommand } from "../src/lib/git-annex/run-command";
import { getAnnexKeysForPaths, listAnnexedKeys } from "../src/lib/git-annex/transfer";
import {
  annexCopyUpload,
  applyNemarAnnexPolicy,
  normalizeImportedTree,
  normalizeUnannexedData,
} from "../src/lib/import-normalize";
import { copyShard, findUnannexedData } from "../src/lib/import-openneuro";
import { annexKeyDeclaredSize } from "../src/lib/s3-server-copy";

/**
 * `nemarDatasets/on007788`'s own `.gitattributes`, trimmed to the lines that
 * decide something here. `*.tsv ... largerthan=1mb` is the line that put 675 MB
 * of motion recordings into a public git repo.
 */
const UPSTREAM_GITATTRIBUTES = `* annex.backend=SHA256E
**/.git* annex.largefiles=nothing
*.bval annex.largefiles=nothing
*.json text eol=lf annex.largefiles=largerthan=1mb
*.tsv text eol=lf annex.largefiles=largerthan=1mb
phenotype/*.tsv annex.largefiles=anything
dataset_description.json annex.largefiles=nothing
README* text eol=lf annex.largefiles=nothing
`;

/** Under upstream's 1 MB bar, so upstream kept it in git. A recording. */
/** The remote these tests copy to is a local directory: no credentials to sign with. */
const inheritUpload = annexCopyUpload({ credentials: "inherit" });

const SMALL_MOTION = "sub-01/motion/sub-01_task-walk_tracksys-imu_motion.tsv";
const SMALL_MOTION_2 = "sub-02/motion/sub-02_task-walk_tracksys-imu_motion.tsv";
/** Over the bar, so upstream annexed it already. Must be left alone. */
const LARGE_MOTION = "sub-01/motion/sub-01_task-long_tracksys-imu_motion.tsv";
/** Metadata, on both rules, whatever its size. Must stay in git. */
const CHANNELS = "sub-01/motion/sub-01_task-walk_tracksys-imu_channels.tsv";

const FIXTURES: Array<{ path: string; size: number }> = [
  { path: SMALL_MOTION, size: 300_000 },
  { path: SMALL_MOTION_2, size: 120_000 },
  { path: LARGE_MOTION, size: 1_500_000 },
  { path: CHANNELS, size: 200_000 },
  { path: "participants.tsv", size: 500 },
  { path: "dataset_description.json", size: 400 },
];

let repoDir: string;
let remoteDir: string;
const scratch: string[] = [];

/** git-annex marks object files read-only; rm needs write+execute on dirs. */
function chmodTreeWritable(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        chmodSync(full, 0o755);
      } catch {}
      chmodTreeWritable(full);
    } else {
      try {
        chmodSync(full, 0o644);
      } catch {}
    }
  }
}

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

/** Paths git-annex holds, straight from git-annex, presence-independent. */
async function annexedPaths(dir: string): Promise<Set<string>> {
  const stdout = await run(["git", "annex", "find", "--include", "*"], dir);
  return new Set(stdout.split("\n").filter(Boolean));
}

/**
 * The mode the COMMITTED tree records for a path: 100644 a plain git blob, 120000
 * an annex link.
 *
 * Read from HEAD rather than the index on purpose. A run that aborts mid-way has
 * already staged its `git annex add`, so the index says 120000 while nothing is
 * committed; HEAD is what the push would carry and therefore what must not change
 * until the content is safely at the remote.
 */
async function headMode(dir: string, path: string): Promise<string> {
  const stdout = await run(["git", "ls-tree", "HEAD", "--", path], dir);
  return stdout.trim().split(" ")[0] ?? "";
}

/** Build an OpenNeuro-shaped clone: upstream's .gitattributes, upstream's split. */
async function buildUpstreamClone(opts: { unlocked?: boolean } = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "nemar-upstream-"));
  scratch.push(dir);
  await run(["git", "init", "-q", "--initial-branch", "main", "."], dir);
  // An identity per repository: the required CI tier configures none, and both
  // `git commit` and `git annex init` need one. Passing here without it would be
  // luck about the machine, not a property of the code.
  await run(["git", "config", "user.email", "test@nemar.test"], dir);
  await run(["git", "config", "user.name", "NEMAR Test"], dir);
  await run(["git", "annex", "init", "--quiet", "upstream"], dir);

  writeFileSync(join(dir, ".gitattributes"), UPSTREAM_GITATTRIBUTES);
  await run(["git", "add", ".gitattributes"], dir);
  await run(["git", "commit", "-qm", "upstream attributes"], dir);
  // After the first commit: `git annex adjust` refuses on an unborn branch, which
  // is also why `initDataset` commits before adjusting.
  if (opts.unlocked) await run(["git", "annex", "adjust", "--unlock"], dir);

  for (const f of FIXTURES) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "x".repeat(f.size));
  }
  const added = await gitAnnexAdd(
    dir,
    FIXTURES.map((f) => f.path),
  );
  if (!added.success) throw new Error(`gitAnnexAdd failed: ${added.error}`);
  await run(["git", "commit", "-qm", "upstream state"], dir);
  return dir;
}

/** A real special remote to copy into, standing in for nemar-s3. */
async function addDirectoryRemote(dir: string, name: string): Promise<string> {
  const store = mkdtempSync(join(tmpdir(), "nemar-remote-"));
  scratch.push(store);
  await run(
    ["git", "annex", "initremote", name, "type=directory", `directory=${store}`, "encryption=none"],
    dir,
  );
  return store;
}

/** The arguments prepare passes, for the cases that do not vary them. */
function treeArgs(overrides: Partial<Parameters<typeof normalizeImportedTree>[0]> = {}) {
  return {
    datasetPath: repoDir,
    nemarId: "on007788",
    bucket: "nemar",
    remoteName: "nemar-s3",
    unannexedData: [] as Array<{ path: string; size: number }>,
    upstreamKeys: new Set<string>(),
    carryOverUnaccountedKeys: false,
    upload: inheritUpload,
    ...overrides,
  };
}

beforeEach(async () => {
  repoDir = await buildUpstreamClone();
  remoteDir = await addDirectoryRemote(repoDir, "nemar-s3");
}, 180_000);

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    chmodTreeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the premise: inherited .gitattributes outranks NEMAR's policy", () => {
  test("upstream's attributes split the recordings across both planes", async () => {
    const annexed = await annexedPaths(repoDir);
    expect(annexed.has(SMALL_MOTION)).toBe(false);
    expect(annexed.has(SMALL_MOTION_2)).toBe(false);
    expect(annexed.has(LARGE_MOTION)).toBe(true);
  }, 60_000);

  test("configuring NEMAR's policy does NOT move a small motion recording", async () => {
    // The fact ADR 0060 rests on, and the reason `--force-large` exists in the
    // normalizer. If a future git-annex reverses the precedence, this fails and
    // the ADR gets revisited; it does not silently become moot.
    expect((await configureLargefiles(repoDir)).success).toBe(true);

    const fresh = "sub-03/motion/sub-03_task-walk_tracksys-imu_motion.tsv";
    mkdirSync(join(repoDir, dirname(fresh)), { recursive: true });
    writeFileSync(join(repoDir, fresh), "y".repeat(50_000));
    expect((await gitAnnexAdd(repoDir, [fresh])).success).toBe(true);

    expect((await annexedPaths(repoDir)).has(fresh)).toBe(false);
  }, 60_000);
});

describe("applyNemarAnnexPolicy", () => {
  test("leaves the repository governed by NEMAR's policy, with no help from the test", async () => {
    // The regression this test exists for: stripping upstream's attributes and
    // stopping there leaves `annex.largefiles` set NOWHERE, and git-annex's
    // default is to annex everything -- so README.md, dataset_description.json
    // and every sidecar would become pointers. Nothing here configures the
    // policy by hand; if the production function stops doing it, this fails.
    const result = await applyNemarAnnexPolicy(repoDir);
    expect(result.changed).toEqual([".gitattributes"]);
    expect(result.stripped).toBe(6);
    expect(result.expression).toBe(buildLargefilesExpression());

    const configured = await run(["git", "annex", "config", "--get", "annex.largefiles"], repoDir);
    expect(configured.trim()).toBe(buildLargefilesExpression());

    await run(["git", "commit", "-qm", "policy"], repoDir);

    const motion = "sub-05/motion/sub-05_task-walk_tracksys-imu_motion.tsv";
    const channels = "sub-05/motion/sub-05_task-walk_tracksys-imu_channels.tsv";
    const readme = "README.md";
    const description = "dataset_description2.json";
    mkdirSync(join(repoDir, dirname(motion)), { recursive: true });
    writeFileSync(join(repoDir, motion), "z".repeat(40_000));
    writeFileSync(join(repoDir, channels), "z".repeat(40_000));
    writeFileSync(join(repoDir, readme), "# dataset\n");
    writeFileSync(join(repoDir, description), '{"Name":"x"}');
    expect((await gitAnnexAdd(repoDir, [motion, channels, readme, description])).success).toBe(
      true,
    );

    const annexed = await annexedPaths(repoDir);
    // Data, whatever its extension says.
    expect(annexed.has(motion)).toBe(true);
    // Metadata a clone has to be able to read, whatever its size.
    expect(annexed.has(channels)).toBe(false);
    expect(annexed.has(readme)).toBe(false);
    expect(annexed.has(description)).toBe(false);
  }, 120_000);

  test("keeps .gitattributes itself out of the annex", async () => {
    // The one largefiles attribute kept. Annexing .gitattributes would replace
    // it with a symlink git-annex cannot read its own attributes from.
    await applyNemarAnnexPolicy(repoDir);
    const kept = readFileSync(join(repoDir, ".gitattributes"), "utf8");
    expect(kept).toContain("**/.git* annex.largefiles=nothing");
  }, 60_000);

  test("stages what it rewrote", async () => {
    await applyNemarAnnexPolicy(repoDir);
    const staged = await run(["git", "diff", "--cached", "--name-only"], repoDir);
    expect(staged.split("\n").filter(Boolean)).toContain(".gitattributes");
  }, 60_000);

  test("strips a nested .gitattributes too", async () => {
    // One left in a subtree governs that subtree, and would reopen the hole there.
    const nested = join(repoDir, "derivatives");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".gitattributes"), "*.tsv annex.largefiles=largerthan=1mb\n");
    await run(["git", "add", "--", "derivatives/.gitattributes"], repoDir);
    await run(["git", "commit", "-qm", "nested attrs"], repoDir);

    const result = await applyNemarAnnexPolicy(repoDir);
    expect(result.changed.sort()).toEqual([".gitattributes", "derivatives/.gitattributes"]);
    expect(readFileSync(join(nested, ".gitattributes"), "utf8").trim()).toBe("");
  }, 120_000);

  test("a tree with no largefiles attributes still gets the policy configured", async () => {
    writeFileSync(join(repoDir, ".gitattributes"), "* annex.backend=SHA256E\n");
    await run(["git", "add", ".gitattributes"], repoDir);
    await run(["git", "commit", "-qm", "plain attrs"], repoDir);

    const result = await applyNemarAnnexPolicy(repoDir);
    expect(result.changed).toEqual([]);
    expect(result.stripped).toBe(0);
    const configured = await run(["git", "annex", "config", "--get", "annex.largefiles"], repoDir);
    expect(configured.trim()).toBe(buildLargefilesExpression());
  }, 60_000);

  test("reports a quoted line it declined to rewrite", async () => {
    writeFileSync(
      join(repoDir, ".gitattributes"),
      '"sub 01/*.tsv" annex.largefiles=largerthan=1mb\n',
    );
    await run(["git", "add", ".gitattributes"], repoDir);
    await run(["git", "commit", "-qm", "quoted attrs"], repoDir);

    const result = await applyNemarAnnexPolicy(repoDir);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("sub 01/*.tsv");
    expect(result.changed).toEqual([]);
  }, 60_000);
});

describe("normalizeUnannexedData", () => {
  test("annexes exactly the recordings upstream left in git", async () => {
    const files = await findUnannexedData(repoDir);
    expect(files.map((f) => f.path).sort()).toEqual([SMALL_MOTION, SMALL_MOTION_2].sort());

    const result = await normalizeUnannexedData({
      datasetPath: repoDir,
      files,
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
      upload: inheritUpload,
    });

    const annexed = await annexedPaths(repoDir);
    expect(annexed.has(SMALL_MOTION)).toBe(true);
    expect(annexed.has(SMALL_MOTION_2)).toBe(true);
    // Metadata is untouched, whatever its size.
    expect(annexed.has(CHANNELS)).toBe(false);
    expect(annexed.has("participants.tsv")).toBe(false);
    expect(result.files).toHaveLength(2);
    expect(result.bytes).toBe(300_000 + 120_000);
  }, 120_000);

  test("uploads the content, byte for byte, to the remote", async () => {
    const files = await findUnannexedData(repoDir);
    const result = await normalizeUnannexedData({
      datasetPath: repoDir,
      files,
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
      upload: inheritUpload,
    });
    expect(result.copied).toBe(2);

    // And the bytes themselves: drop the local copy, then fetch it back from
    // the remote. A pointer with no content behind it cannot survive this.
    await run(["git", "annex", "drop", "--force", "--", SMALL_MOTION], repoDir);
    await run(["git", "annex", "get", "--from", "nemar-s3", "--", SMALL_MOTION], repoDir);
    expect(readFileSync(join(repoDir, SMALL_MOTION), "utf8")).toBe("x".repeat(300_000));
  }, 120_000);

  test("returns manifest items the copy phase skips and finalize can verify", async () => {
    const files = await findUnannexedData(repoDir);
    const result = await normalizeUnannexedData({
      datasetPath: repoDir,
      files,
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
      upload: inheritUpload,
    });

    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.origin).toBe("local");
      // No upstream source exists for these keys -- that is the whole point.
      expect(item.source).toBeNull();
      expect(item.sourceUrl).toBeNull();
      expect(item.destUri).toBe(`s3://nemar/on007788/objects/${item.key}`);
      // Finalize gates the publish on the object's size matching the size the
      // key declares, so a key that declares nothing would sail through.
      expect(annexKeyDeclaredSize(item.key)).not.toBeNull();
    }
    const declared = result.items
      .map((it) => annexKeyDeclaredSize(it.key))
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(declared).toEqual([120_000, 300_000]);
  }, 120_000);

  test("refuses to leave an unresolvable pointer when the upload fails", async () => {
    // Injected for real -- the remote exists and is reachable, and writing to
    // it fails -- rather than by stubbing the copy.
    chmodSync(remoteDir, 0o555);
    const files = await findUnannexedData(repoDir);

    await expect(
      normalizeUnannexedData({
        datasetPath: repoDir,
        files,
        remoteName: "nemar-s3",
        bucket: "nemar",
        nemarId: "on007788",
        upload: inheritUpload,
      }),
    ).rejects.toThrow(/upload to nemar-s3 failed/);

    chmodSync(remoteDir, 0o755);
    // The recording is still the committed tree's own blob, so the pushed tree
    // cannot name a key with no content. (The commit itself lives a level up, in
    // normalizeImportedTree, which has its own test for not making one.)
    expect(await headMode(repoDir, SMALL_MOTION)).toBe("100644");
  }, 120_000);

  test("refuses a path it cannot prove the remote holds", async () => {
    // Exit 0 is not evidence: git-annex prints `copy <path> ok` for a key the
    // remote already had, and says nothing at all for a path it does not
    // consider annexed. So the location log is consulted afterwards. Driven by
    // taking the remote's directory away, which makes the copy fail loudly and
    // the log stay empty -- the state this guard reads.
    const files = await findUnannexedData(repoDir);
    rmSync(remoteDir, { recursive: true, force: true });

    await expect(
      normalizeUnannexedData({
        datasetPath: repoDir,
        files,
        remoteName: "nemar-s3",
        bucket: "nemar",
        nemarId: "on007788",
        upload: inheritUpload,
      }),
    ).rejects.toThrow(/nemar-s3/);

    expect(await headMode(repoDir, SMALL_MOTION)).toBe("100644");
  }, 120_000);

  test("refuses a path that did not annex, rather than manifesting a key for it", async () => {
    // The missing-key guard. Its real trigger is a path that reaches this
    // function already annexed with its content elsewhere -- which is every
    // upstream-annexed file on a real prepare clone, and what a widening of
    // `findUnannexedData` would hand over by mistake. Built for real: normalize
    // it, commit, drop the local content, then ask for it again.
    const files = await findUnannexedData(repoDir);
    await normalizeUnannexedData({
      datasetPath: repoDir,
      files,
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
      upload: inheritUpload,
    });
    await run(["git", "commit", "-qm", "normalized"], repoDir);
    await run(["git", "annex", "drop", "--force", "--", SMALL_MOTION], repoDir);

    await expect(
      normalizeUnannexedData({
        datasetPath: repoDir,
        files: [{ path: SMALL_MOTION, size: 300_000 }],
        remoteName: "nemar-s3",
        bucket: "nemar",
        nemarId: "on007788",
        upload: inheritUpload,
      }),
    ).rejects.toThrow(/no key for/);
  }, 120_000);

  test("annexes a data file the dataset's own .gitignore matches", async () => {
    // Un-caching makes the path untracked for a moment, and an untracked ignored
    // path is skipped by `git annex add` silently, exit 0 -- leaving the file in
    // neither plane. gitignore never applied to it while tracked, so it must not
    // start applying now.
    writeFileSync(join(repoDir, ".gitignore"), "*_motion.tsv\n");
    await run(["git", "add", "--force", "--", ".gitignore"], repoDir);
    await run(["git", "commit", "-qm", "ignore motion"], repoDir);

    const result = await normalizeUnannexedData({
      datasetPath: repoDir,
      files: [{ path: SMALL_MOTION, size: 300_000 }],
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
      upload: inheritUpload,
    });
    expect(result.files).toHaveLength(1);
    expect((await annexedPaths(repoDir)).has(SMALL_MOTION)).toBe(true);
  }, 120_000);

  test("refuses a volume it should not be uploading from the import host", async () => {
    // The bound exists so a pathological dataset fails legibly here instead of
    // at the job's six-hour cap (ADR 0010). Driven at a low limit rather than
    // with a 5 GiB fixture.
    const files = await findUnannexedData(repoDir);
    await expect(
      normalizeUnannexedData({
        datasetPath: repoDir,
        files,
        remoteName: "nemar-s3",
        bucket: "nemar",
        nemarId: "on007788",
        upload: inheritUpload,
        maxBytes: 1000,
      }),
    ).rejects.toThrow(/over the .* GiB this leg will upload/);

    // Nothing moved: the refusal is before the first uncache.
    expect((await annexedPaths(repoDir)).has(SMALL_MOTION)).toBe(false);
  }, 60_000);

  test("no un-annexed data is a no-op, not an empty upload", async () => {
    const result = await normalizeUnannexedData({
      datasetPath: repoDir,
      files: [],
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
      upload: inheritUpload,
    });
    expect(result).toEqual({ items: [], files: [], copied: 0, bytes: 0 });
  }, 60_000);

  test("two paths with identical content yield one manifest item", async () => {
    // The manifest addresses keys, and identical content is one key. A duplicate
    // entry would have finalize verify and register the same key twice.
    const twin = "sub-04/motion/sub-04_task-walk_tracksys-imu_motion.tsv";
    mkdirSync(join(repoDir, dirname(twin)), { recursive: true });
    writeFileSync(join(repoDir, twin), "x".repeat(300_000));
    await run(["git", "add", "--", twin], repoDir);
    await run(["git", "commit", "-qm", "twin"], repoDir);

    const files = await findUnannexedData(repoDir);
    expect(files.map((f) => f.path)).toContain(twin);
    const result = await normalizeUnannexedData({
      datasetPath: repoDir,
      files,
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
      upload: inheritUpload,
    });
    expect(result.files).toHaveLength(3);
    expect(result.items).toHaveLength(2);
  }, 120_000);

  test("works on an adjusted-unlock branch, where an annexed file is no symlink", async () => {
    // The other tree shape in circulation: `initDataset` leaves this one, and a
    // mode check rather than a git-annex query silently misreads every annexed
    // file here as un-annexed data.
    const unlocked = await buildUpstreamClone({ unlocked: true });
    await addDirectoryRemote(unlocked, "nemar-s3");
    const files = await findUnannexedData(unlocked);
    expect(files.map((f) => f.path).sort()).toEqual([SMALL_MOTION, SMALL_MOTION_2].sort());

    const result = await normalizeUnannexedData({
      datasetPath: unlocked,
      files,
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
      upload: inheritUpload,
    });
    expect(result.files).toHaveLength(2);
    expect((await annexedPaths(unlocked)).has(SMALL_MOTION)).toBe(true);
  }, 180_000);
});

describe("normalizeImportedTree", () => {
  test("one commit carries both halves, and the manifest gets the keys", async () => {
    const result = await normalizeImportedTree(
      treeArgs({ unannexedData: await findUnannexedData(repoDir) }),
    );
    expect(result.committed).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((it) => it.origin === "local")).toBe(true);
    expect(result.notes).toHaveLength(2);

    const log = await run(["git", "log", "--oneline"], repoDir);
    expect(log).toContain("Apply NEMAR annex policy to imported tree");
    // One commit, not two: the tree change and the attribute rewrite ride together.
    expect(log.split("\n").filter((l) => l.includes("Apply NEMAR"))).toHaveLength(1);
    expect(await headMode(repoDir, SMALL_MOTION)).toBe("120000");
    expect(await headMode(repoDir, CHANNELS)).toBe("100644");
    expect((await run(["git", "status", "--porcelain"], repoDir)).trim()).toBe("");
  }, 180_000);

  test("a failed upload leaves no commit and no moved file", async () => {
    chmodSync(remoteDir, 0o555);
    await expect(
      normalizeImportedTree(treeArgs({ unannexedData: await findUnannexedData(repoDir) })),
    ).rejects.toThrow(/upload to nemar-s3 failed/);
    chmodSync(remoteDir, 0o755);

    const log = await run(["git", "log", "--oneline"], repoDir);
    expect(log).not.toContain("Apply NEMAR annex policy");
    expect(await headMode(repoDir, SMALL_MOTION)).toBe("100644");
  }, 180_000);

  test("with no data to move it still puts the policy in force", async () => {
    // The `--skip-data` and metadata-only shape: prepare passes no files, and the
    // repository must still end up governed rather than ungoverned.
    const result = await normalizeImportedTree(treeArgs());
    expect(result.data).toBeNull();
    expect(result.committed).toBe(true);
    expect(result.notes).toEqual(["stripped 6 inherited annex.largefiles attribute(s)"]);
    const configured = await run(["git", "annex", "config", "--get", "annex.largefiles"], repoDir);
    expect(configured.trim()).toBe(buildLargefilesExpression());
    // The data is untouched: that is what --skip-data asked for.
    expect(await headMode(repoDir, SMALL_MOTION)).toBe("100644");
  }, 120_000);

  test("a second run over an already-normalized tree changes nothing", async () => {
    await normalizeImportedTree(treeArgs({ unannexedData: await findUnannexedData(repoDir) }));
    const firstLog = await run(["git", "log", "--oneline"], repoDir);

    const second = await normalizeImportedTree(treeArgs());
    expect(second.committed).toBe(false);
    expect(second.notes).toEqual([]);
    expect(await run(["git", "log", "--oneline"], repoDir)).toBe(firstLog);
    expect((await run(["git", "status", "--porcelain"], repoDir)).trim()).toBe("");
  }, 180_000);

  test("a re-import carries keys no upstream source accounts for into the manifest", async () => {
    // On a re-import, step 4c resets onto origin/main, so the recordings a
    // previous prepare normalized are already annexed and nothing is uploaded.
    // Their keys are in no upstream key set, so without carrying them over
    // finalize would verify and register none of them -- and a dataset whose only
    // data is normalized would meet the empty-manifest publish guard for ever.
    const first = await normalizeImportedTree(
      treeArgs({ unannexedData: await findUnannexedData(repoDir) }),
    );
    const normalizedKeys = first.items.map((it) => it.key).sort();

    // The upstream-annexed file's key is what a real keyUrlMap would carry.
    const upstreamKey = (await getAnnexKeysForPaths(repoDir, [LARGE_MOTION])).get(LARGE_MOTION);
    expect(upstreamKey).toBeDefined();

    const reimport = await normalizeImportedTree(
      treeArgs({
        upstreamKeys: new Set([upstreamKey as string]),
        carryOverUnaccountedKeys: true,
      }),
    );
    expect(reimport.committed).toBe(false);
    expect(reimport.carriedOver.map((it) => it.key).sort()).toEqual(normalizedKeys);
    expect(reimport.carriedOver.every((it) => it.origin === "local")).toBe(true);
    // The upstream key is NOT carried over: the copy phase can fetch that one.
    expect(reimport.carriedOver.map((it) => it.key)).not.toContain(upstreamKey);
  }, 180_000);

  test("a first import carries nothing over, whatever the tree already holds", async () => {
    // Off by default: on a first import an unaccounted key means an upstream
    // whereis that yielded no usable URL, which is reported separately and must
    // not be claimed as already uploaded.
    const result = await normalizeImportedTree(
      treeArgs({ unannexedData: await findUnannexedData(repoDir) }),
    );
    expect(result.carriedOver).toEqual([]);
    expect(result.items).toHaveLength(2);
  }, 180_000);
});

describe("getAnnexKeysForPaths", () => {
  test("reports keys for annexed paths and nothing for git-resident ones", async () => {
    const keys = await getAnnexKeysForPaths(repoDir, [LARGE_MOTION, SMALL_MOTION, CHANNELS]);
    expect(keys.get(LARGE_MOTION)).toMatch(/^SHA256E-s1500000--/);
    // Still plain git, so git-annex has no key for it -- the absence is the
    // signal normalizeUnannexedData aborts on.
    expect(keys.has(SMALL_MOTION)).toBe(false);
    expect(keys.has(CHANNELS)).toBe(false);
  }, 60_000);

  test("is presence-filtered on purpose, and listAnnexedKeys is not", async () => {
    // Deliberate: the caller is about to upload FROM this clone, so "annexed and
    // held here" is the question, and a content-absent path must read as absent
    // rather than as ready to copy. Do not "fix" this by adding `--include '*'`;
    // a caller that wants every annexed key regardless has listAnnexedKeys.
    await run(["git", "annex", "copy", "--to", "nemar-s3", "--", LARGE_MOTION], repoDir);
    await run(["git", "annex", "drop", "--force", "--", LARGE_MOTION], repoDir);

    expect((await getAnnexKeysForPaths(repoDir, [LARGE_MOTION])).has(LARGE_MOTION)).toBe(false);
    expect((await listAnnexedKeys(repoDir)).has(LARGE_MOTION)).toBe(true);
  }, 120_000);

  test("no paths means no git-annex call and no keys", async () => {
    expect(await getAnnexKeysForPaths(repoDir, [])).toEqual(new Map());
  }, 30_000);
});

describe("copyShard", () => {
  test("a manifest of only locally-uploaded keys does no S3 work at all", async () => {
    // The entry-point check for the filter. Past the empty-shard early return the
    // copy phase lists the destination bucket, so a version that forgot to
    // exclude these keys would leave this test reaching S3 and then calling
    // process.exit -- which in bun's single-process runner takes the whole suite
    // with it. Asserting the two log lines names the behavior instead of
    // accepting any early return. ds099999 keeps even the regression off any real
    // prefix.
    const manifest = {
      openneuroId: "ds099999",
      nemarId: "on099999",
      nemarUuid: "",
      items: [
        {
          key: "SHA256E-s300000--aaa.tsv",
          sourceUrl: null,
          source: null,
          destUri: "s3://nemar/on099999/objects/SHA256E-s300000--aaa.tsv",
          origin: "local" as const,
        },
      ],
    };
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await copyShard("ds099999", { index: 0, count: 1 }, {}, manifest);
    } finally {
      console.log = realLog;
    }
    const output = lines.join("\n");
    expect(output).toContain("1 key(s) already uploaded by prepare");
    expect(output).toContain("empty shard");
  }, 60_000);
});
