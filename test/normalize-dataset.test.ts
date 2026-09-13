/**
 * Normalizing an EXISTING dataset repository (#1159 part 2, ADR 0058).
 *
 * The dataset-level path around `normalizeImportedTree`: which clones it will reuse,
 * which it refuses, what it reports, and that the published past survives it. The
 * fixture is a bare "origin" plus a clone shaped like `on007788` -- upstream's
 * `.gitattributes`, a tag standing in for a published version, and motion
 * recordings on both sides of upstream's 1 MB bar.
 *
 * `normalizeDatasetRepo` is driven with a `type=directory` remote, so the S3 leg is
 * a real special-remote transfer rather than a stub. The one thing no test here can
 * reach is the credential mint, which needs the backend.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { runCommand } from "../src/lib/git-annex/run-command";
import type { UploadStrategy } from "../src/lib/import-normalize";
import { findUnannexedData } from "../src/lib/import-openneuro";
import {
  normalizeDatasetRepo,
  planDatasetNormalization,
  resolveSpecialRemoteUuid,
} from "../src/lib/normalize-dataset";

const UPSTREAM_GITATTRIBUTES = `* annex.backend=SHA256E
**/.git* annex.largefiles=nothing
*.tsv text eol=lf annex.largefiles=largerthan=1mb
dataset_description.json annex.largefiles=nothing
`;

const SMALL_MOTION = "sub-01/motion/sub-01_task-walk_tracksys-imu_motion.tsv";
const LARGE_MOTION = "sub-01/motion/sub-01_task-long_tracksys-imu_motion.tsv";
const CHANNELS = "sub-01/motion/sub-01_task-walk_tracksys-imu_channels.tsv";

let workDir: string;
let origin: string;
let clone: string;
const scratch: string[] = [];

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

/** git-annex commits to its own branch, so every fixture repo needs an author. */
async function setIdentity(dir: string): Promise<void> {
  await run(["git", "config", "user.email", "test@nemar.test"], dir);
  await run(["git", "config", "user.name", "NEMAR Test"], dir);
}

async function headMode(dir: string, path: string, ref = "HEAD"): Promise<string> {
  const stdout = await run(["git", "ls-tree", ref, "--", path], dir);
  return stdout.trim().split(" ")[0] ?? "";
}

/** A published-looking dataset: upstream attributes, a v1.0.0 tag, a split. */
async function buildOriginAndClone(): Promise<{ origin: string; clone: string }> {
  const root = mkdtempSync(join(tmpdir(), "nemar-ds-"));
  scratch.push(root);
  const source = join(root, "source");
  const bare = join(root, "on999999.git");
  mkdirSync(source, { recursive: true });

  await run(["git", "init", "-q", "--initial-branch", "main", "."], source);
  // An identity per repository, the way the other git-touching suites do it: the
  // required CI tier runs with none configured, and `git annex init` commits to the
  // git-annex branch, so without this the fixture depends on the machine.
  await setIdentity(source);
  await run(["git", "annex", "init", "--quiet", "upstream"], source);
  writeFileSync(join(source, ".gitattributes"), UPSTREAM_GITATTRIBUTES);
  writeFileSync(join(source, "dataset_description.json"), '{"Name":"x"}');
  for (const [path, size] of [
    [SMALL_MOTION, 300_000],
    [LARGE_MOTION, 1_500_000],
    [CHANNELS, 200_000],
  ] as Array<[string, number]>) {
    const abs = join(source, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "x".repeat(size));
  }
  const added = await gitAnnexAdd(source, [
    ".gitattributes",
    "dataset_description.json",
    SMALL_MOTION,
    LARGE_MOTION,
    CHANNELS,
  ]);
  if (!added.success) throw new Error(`gitAnnexAdd: ${added.error}`);
  await run(["git", "commit", "-qm", "dataset"], source);
  await run(["git", "tag", "v1.0.0"], source);

  // `--initial-branch main` on the BARE repo too: without it the bare repo's HEAD
  // follows the machine's `init.defaultBranch`, so on a runner that still defaults to
  // `master` the clone below checks out nothing at all and HEAD does not resolve.
  // The fixture passed locally only because this machine defaults to `main`.
  await run(["git", "init", "-q", "--bare", "--initial-branch", "main", bare], root);
  await run(["git", "remote", "add", "origin", bare], source);
  await run(["git", "push", "-q", "--all", "origin"], source);
  await run(["git", "push", "-q", "--tags", "origin"], source);

  const cloneDir = join(root, "clone");
  await run(["git", "clone", "-q", bare, cloneDir], root);
  await setIdentity(cloneDir);
  await run(["git", "annex", "init", "--quiet", "clone"], cloneDir);
  // The clone needs the content the way a real clone of a git-resident file does:
  // it comes down with the blobs, so nothing to fetch.
  return { origin: bare, clone: cloneDir };
}

async function addDirectoryRemote(dir: string, name: string): Promise<string> {
  const store = mkdtempSync(join(tmpdir(), "nemar-ds-store-"));
  scratch.push(store);
  await run(
    ["git", "annex", "initremote", name, "type=directory", `directory=${store}`, "encryption=none"],
    dir,
  );
  return store;
}

beforeEach(async () => {
  const built = await buildOriginAndClone();
  origin = built.origin;
  clone = built.clone;
  workDir = dirname(clone);
}, 180_000);

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    chmodTreeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("planDatasetNormalization", () => {
  test("reuses a clean clone at origin/main instead of re-cloning", async () => {
    // The clone is already there under <workDir>/<id>; a re-clone would fail on a
    // non-empty directory, and re-downloading a published dataset to redo an
    // interrupted upload is the thing this avoids.
    const reused = join(workDir, "on999999");
    await run(["cp", "-R", clone, reused], workDir);

    const plan = await planDatasetNormalization("on999999", { workDir });
    expect(plan.datasetPath).toBe(reused);
    expect(plan.files.map((f) => f.path)).toEqual([SMALL_MOTION]);
    expect(plan.bytes).toBe(300_000);
    expect(plan.attributeFiles).toEqual([".gitattributes"]);
  }, 180_000);

  test("refuses a clone left dirty by a previous attempt", async () => {
    // The dangerous state, not the merely stale one: the data files are already
    // annexed in the index, so a scan finds nothing left to move and the run would
    // report success having migrated nothing.
    const reused = join(workDir, "on999999");
    await run(["cp", "-R", clone, reused], workDir);
    await run(["git", "rm", "--cached", "--quiet", "--", SMALL_MOTION], reused);
    await gitAnnexAdd(reused, [SMALL_MOTION], {}, { forceLarge: true });

    await expect(planDatasetNormalization("on999999", { workDir })).rejects.toThrow(
      /uncommitted changes/,
    );
  }, 180_000);

  test("refuses a directory that is a different repository", async () => {
    const wrong = join(workDir, "on999999");
    mkdirSync(wrong, { recursive: true });
    await run(["git", "init", "-q", "."], wrong);
    await expect(planDatasetNormalization("on999999", { workDir })).rejects.toThrow(
      /origin is not on999999/,
    );
  }, 120_000);
});

describe("normalizeDatasetRepo", () => {
  test("moves the data, installs the policy, and leaves the published tag resolvable", async () => {
    const store = await addDirectoryRemote(clone, "stand-in");
    expect(store).toBeTruthy();
    const files = await findUnannexedData(clone);
    expect(files.map((f) => f.path)).toEqual([SMALL_MOTION]);

    const result = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files,
        bytes: 300_000,
        attributeFiles: [".gitattributes"],
      },
      { push: true, remoteName: "stand-in" },
    );

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.keys).toHaveLength(1);

    // HEAD carries the recording as an annex link, and metadata as real files.
    expect(await headMode(clone, SMALL_MOTION)).toBe("120000");
    expect(await headMode(clone, CHANNELS)).toBe("100644");
    expect(await headMode(clone, "dataset_description.json")).toBe("100644");

    // The published version still resolves to the blob it was published with:
    // this is what makes a forward fix safe for a dataset whose version manifest
    // addresses git-resident files by their raw.githubusercontent URL.
    expect(await headMode(clone, SMALL_MOTION, "v1.0.0")).toBe("100644");

    // And the push really landed on the origin, both branches.
    const originMain = await run(["git", "ls-tree", "main", "--", SMALL_MOTION], origin);
    expect(originMain.trim().split(" ")[0]).toBe("120000");
    const branches = await run(["git", "branch", "--list", "git-annex"], origin);
    expect(branches).toContain("git-annex");
  }, 240_000);

  test("a second run finds nothing to do and makes no commit", async () => {
    await addDirectoryRemote(clone, "stand-in");
    const files = await findUnannexedData(clone);
    await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files,
        bytes: 300_000,
        attributeFiles: [".gitattributes"],
      },
      { push: false, remoteName: "stand-in" },
    );
    const firstLog = await run(["git", "log", "--oneline"], clone);

    const again = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files: await findUnannexedData(clone),
        bytes: 0,
        attributeFiles: [],
      },
      { push: false, remoteName: "stand-in" },
    );
    expect(again.committed).toBe(false);
    expect(again.notes).toEqual([]);
    expect(await run(["git", "log", "--oneline"], clone)).toBe(firstLog);
  }, 240_000);

  test("does not push when it had nothing to commit", async () => {
    await addDirectoryRemote(clone, "stand-in");
    // Nothing to move and no attributes to strip: a push here would be a no-op at
    // best and a surprise at worst on a live dataset.
    await run(["git", "rm", "-q", "--cached", "--", ".gitattributes"], clone);
    writeFileSync(join(clone, ".gitattributes"), "* annex.backend=SHA256E\n");
    await run(["git", "add", "--", ".gitattributes"], clone);
    await run(["git", "commit", "-qm", "plain attributes"], clone);

    const result = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files: [],
        bytes: 0,
        attributeFiles: [],
      },
      { push: true, remoteName: "stand-in" },
    );
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
  }, 180_000);
});

describe("the upload leg is swappable", () => {
  test("resolveSpecialRemoteUuid reads the UUID out of the git-annex branch", async () => {
    // Needed by the ambient-credential path, which must NOT enable the remote (that
    // contacts S3 with the credential handling being bypassed) yet still has to
    // register keys against the UUID every existing clone already knows.
    await addDirectoryRemote(clone, "stand-in");
    const uuid = await resolveSpecialRemoteUuid(clone, "stand-in");
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);

    const fromGitAnnex = await run(["git", "config", "remote.stand-in.annex-uuid"], clone);
    expect(uuid).toBe(fromGitAnnex.trim());
    expect(await resolveSpecialRemoteUuid(clone, "no-such-remote")).toBeNull();
  }, 180_000);

  test("a strategy that cannot prove the upload stops the migration before the commit", async () => {
    // The contract every strategy owes: throw rather than return when it cannot
    // show the content arrived. A strategy that lies would be committed on top of.
    await addDirectoryRemote(clone, "stand-in");
    const refusing: UploadStrategy = async () => {
      throw new Error("nothing arrived at the remote");
    };

    await expect(
      normalizeDatasetRepo(
        {
          datasetId: "on999999",
          datasetPath: clone,
          files: await findUnannexedData(clone),
          bytes: 300_000,
          attributeFiles: [".gitattributes"],
        },
        { push: true, remoteName: "stand-in", upload: refusing },
      ),
    ).rejects.toThrow(/nothing arrived/);

    const log = await run(["git", "log", "--oneline"], clone);
    expect(log).not.toContain("Apply NEMAR annex policy");
    expect(await headMode(clone, SMALL_MOTION)).toBe("100644");
    const originMain = await run(["git", "ls-tree", "main", "--", SMALL_MOTION], origin);
    expect(originMain.trim().split(" ")[0]).toBe("100644");
  }, 180_000);
});
