/**
 * Bringing an imported clone onto NEMAR's annex policy (#1159, ADR 0057).
 *
 * The fixture is built the way OpenNeuro actually builds a repo: the largefiles
 * rule arrives as a `.gitattributes` file, copied in shape from the live
 * `nemarDatasets/on007788`, NOT as a `git annex config` value. That distinction is
 * the whole reason this code exists -- a `.gitattributes` setting outranks the
 * config `configureLargefiles` writes, so NEMAR's policy never governs an
 * imported tree until the attributes are stripped -- and a fixture that used the
 * config would test a repo shape no import ever sees.
 *
 * git-annex is the oracle throughout: which plane a file landed on is read back
 * with `git annex find`, and content arrival is checked by fetching it out of a
 * real `type=directory` special remote, the same stand-in the S3-remote tests use.
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
import { configureLargefiles, gitAnnexAdd, initDataset } from "../src/lib/git-annex/init";
import { runCommand } from "../src/lib/git-annex/run-command";
import { getAnnexKeysForPaths } from "../src/lib/git-annex/transfer";
import {
  isGitPlumbingPattern,
  normalizeGitattributes,
  normalizeUnannexedData,
  stripLargefilesAttributes,
} from "../src/lib/import-normalize";
import { copyShard, findUnannexedData } from "../src/lib/import-openneuro";
import { annexKeyDeclaredSize, selectShardCopyItems } from "../src/lib/s3-server-copy";

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
const SMALL_MOTION = "sub-01/motion/sub-01_task-walk_tracksys-imu_motion.tsv";
const SMALL_MOTION_2 = "sub-02/motion/sub-02_task-walk_tracksys-imu_motion.tsv";
/** Over the bar, so upstream annexed it already. Must be left alone. */
const LARGE_MOTION = "sub-01/motion/sub-01_task-long_tracksys-imu_motion.tsv";
/** Metadata at any size, on both rules. Must stay in git. */
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

/** Paths git-annex holds, straight from git-annex. */
async function annexedPaths(dir: string): Promise<Set<string>> {
  const stdout = await run(["git", "annex", "find", "--include", "*"], dir);
  return new Set(stdout.split("\n").filter(Boolean));
}

/** Remotes git-annex believes hold this key's content. */
async function whereis(dir: string, path: string): Promise<string> {
  return await run(["git", "annex", "whereis", "--", path], dir);
}

/** Build an OpenNeuro-shaped clone: upstream's .gitattributes, upstream's split. */
async function buildUpstreamClone(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "nemar-upstream-"));
  scratch.push(dir);
  const init = await initDataset(dir);
  if (!init.success) throw new Error(`initDataset failed: ${init.error}`);

  writeFileSync(join(dir, ".gitattributes"), UPSTREAM_GITATTRIBUTES);
  await run(["git", "add", ".gitattributes"], dir);
  await run(["git", "commit", "-m", "upstream attributes"], dir);

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
  await run(["git", "commit", "-m", "upstream state"], dir);
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
  });

  test("configuring NEMAR's policy does NOT move a small motion recording", async () => {
    // This is the fact ADR 0057 rests on, and the reason `--force-large` exists in
    // the normalizer. If a future git-annex reverses the precedence, this test
    // fails and the ADR needs revisiting -- it does not silently become moot.
    const configured = await configureLargefiles(repoDir);
    expect(configured.success).toBe(true);

    const fresh = "sub-03/motion/sub-03_task-walk_tracksys-imu_motion.tsv";
    mkdirSync(join(repoDir, dirname(fresh)), { recursive: true });
    writeFileSync(join(repoDir, fresh), "y".repeat(50_000));
    const added = await gitAnnexAdd(repoDir, [fresh]);
    expect(added.success).toBe(true);

    const annexed = await annexedPaths(repoDir);
    expect(annexed.has(fresh)).toBe(false);
  });
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
    });
    expect(result.copied).toBe(2);

    // git-annex's own account of where the content is.
    expect(await whereis(repoDir, SMALL_MOTION)).toContain("nemar-s3");

    // And the bytes themselves: drop the local copy, then fetch it back from the
    // remote. A pointer with no content behind it cannot survive this.
    await run(["git", "annex", "drop", "--force", "--", SMALL_MOTION], repoDir);
    await run(["git", "annex", "get", "--from", "nemar-s3", "--", SMALL_MOTION], repoDir);
    const restored = readFileSync(join(repoDir, SMALL_MOTION), "utf8");
    expect(restored).toBe("x".repeat(300_000));
  }, 120_000);

  test("returns manifest items the copy phase skips and finalize can verify", async () => {
    const files = await findUnannexedData(repoDir);
    const result = await normalizeUnannexedData({
      datasetPath: repoDir,
      files,
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
    });

    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.origin).toBe("local");
      // No upstream source exists for these keys -- that is the whole point.
      expect(item.source).toBeNull();
      expect(item.sourceUrl).toBeNull();
      expect(item.destUri).toBe(`s3://nemar/on007788/objects/${item.key}`);
      // Finalize gates the publish on the object's size matching the size the key
      // declares, so a key that declares nothing would sail through unverified.
      expect(annexKeyDeclaredSize(item.key)).not.toBeNull();
    }
    const declared = result.items
      .map((it) => annexKeyDeclaredSize(it.key))
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(declared).toEqual([120_000, 300_000]);
  }, 120_000);

  test("refuses to leave an unresolvable pointer when the upload fails", async () => {
    // The failure this ordering exists to prevent: annexed in the tree, absent
    // from the remote. Injected for real -- the remote exists and is reachable,
    // and writing to it fails -- rather than by stubbing the copy.
    chmodSync(remoteDir, 0o555);
    const files = await findUnannexedData(repoDir);

    await expect(
      normalizeUnannexedData({
        datasetPath: repoDir,
        files,
        remoteName: "nemar-s3",
        bucket: "nemar",
        nemarId: "on007788",
      }),
    ).rejects.toThrow(/upload to nemar-s3 failed/);

    // Nothing was committed, so the pushed tree cannot name a key with no content.
    chmodSync(remoteDir, 0o755);
    const log = await run(["git", "log", "--oneline"], repoDir);
    expect(log).not.toContain("annex policy");
    const status = await run(["git", "status", "--porcelain"], repoDir);
    expect(status.trim()).not.toBe("");
  }, 120_000);

  test("refuses a volume it should not be uploading from the import host", async () => {
    // The bound exists so a pathological dataset fails legibly here instead of at
    // the job's six-hour cap (ADR 0010). Driven at a low limit rather than with a
    // 5 GiB fixture.
    const files = await findUnannexedData(repoDir);
    await expect(
      normalizeUnannexedData({
        datasetPath: repoDir,
        files,
        remoteName: "nemar-s3",
        bucket: "nemar",
        nemarId: "on007788",
        maxBytes: 1000,
      }),
    ).rejects.toThrow(/over the .* GiB this leg will upload/);

    // Nothing moved: the refusal is before the first uncache.
    const annexed = await annexedPaths(repoDir);
    expect(annexed.has(SMALL_MOTION)).toBe(false);
  }, 60_000);

  test("no un-annexed data is a no-op, not an empty upload", async () => {
    const result = await normalizeUnannexedData({
      datasetPath: repoDir,
      files: [],
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
    });
    expect(result).toEqual({ items: [], files: [], copied: 0, bytes: 0 });
  });

  test("two paths with identical content yield one manifest item", async () => {
    // The manifest addresses keys, and identical content is one key. A duplicate
    // entry would have finalize verify and register the same key twice.
    const twin = "sub-04/motion/sub-04_task-walk_tracksys-imu_motion.tsv";
    mkdirSync(join(repoDir, dirname(twin)), { recursive: true });
    writeFileSync(join(repoDir, twin), "x".repeat(300_000));
    await run(["git", "add", "--", twin], repoDir);
    await run(["git", "commit", "-m", "twin"], repoDir);

    const files = await findUnannexedData(repoDir);
    expect(files.map((f) => f.path)).toContain(twin);
    const result = await normalizeUnannexedData({
      datasetPath: repoDir,
      files,
      remoteName: "nemar-s3",
      bucket: "nemar",
      nemarId: "on007788",
    });
    expect(result.files).toHaveLength(3);
    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map((i) => i.key)).size).toBe(2);
  }, 120_000);
});

describe("normalizeGitattributes", () => {
  test("hands governance back to NEMAR's policy for future adds", async () => {
    const result = await normalizeGitattributes(repoDir);
    expect(result.changed).toEqual([".gitattributes"]);
    expect(result.stripped).toBe(6);

    await run(["git", "commit", "-m", "strip largefiles"], repoDir);
    expect((await configureLargefiles(repoDir)).success).toBe(true);

    // The durable half of the fix: a NEW small motion recording now annexes, and
    // its sidecar still does not. git-annex decides; the test only reads it back.
    const motion = "sub-05/motion/sub-05_task-walk_tracksys-imu_motion.tsv";
    const channels = "sub-05/motion/sub-05_task-walk_tracksys-imu_channels.tsv";
    mkdirSync(join(repoDir, dirname(motion)), { recursive: true });
    writeFileSync(join(repoDir, motion), "z".repeat(40_000));
    writeFileSync(join(repoDir, channels), "z".repeat(40_000));
    const added = await gitAnnexAdd(repoDir, [motion, channels]);
    expect(added.success).toBe(true);

    const annexed = await annexedPaths(repoDir);
    expect(annexed.has(motion)).toBe(true);
    expect(annexed.has(channels)).toBe(false);
  }, 120_000);

  test("keeps .gitattributes itself out of the annex", async () => {
    // The one largefiles attribute that is kept. Annexing .gitattributes would
    // replace it with a symlink git-annex cannot read its own attributes from.
    await normalizeGitattributes(repoDir);
    const kept = readFileSync(join(repoDir, ".gitattributes"), "utf8");
    expect(kept).toContain("**/.git* annex.largefiles=nothing");
  });

  test("stages what it rewrote", async () => {
    await normalizeGitattributes(repoDir);
    const staged = await run(["git", "diff", "--cached", "--name-only"], repoDir);
    expect(staged.split("\n").filter(Boolean)).toContain(".gitattributes");
  });

  test("strips a nested .gitattributes too", async () => {
    // One left in a subtree governs that subtree, and would reopen the same hole
    // there.
    const nested = join(repoDir, "derivatives");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".gitattributes"), "*.tsv annex.largefiles=largerthan=1mb\n");
    await run(["git", "add", "--", "derivatives/.gitattributes"], repoDir);
    await run(["git", "commit", "-m", "nested attrs"], repoDir);

    const result = await normalizeGitattributes(repoDir);
    expect(result.changed.sort()).toEqual([".gitattributes", "derivatives/.gitattributes"]);
    // The nested file said nothing else, so nothing is left of it.
    expect(readFileSync(join(nested, ".gitattributes"), "utf8").trim()).toBe("");
  }, 120_000);

  test("a tree with no largefiles attributes is left alone", async () => {
    writeFileSync(join(repoDir, ".gitattributes"), "* annex.backend=SHA256E\n");
    await run(["git", "add", ".gitattributes"], repoDir);
    await run(["git", "commit", "-m", "plain attrs"], repoDir);

    const result = await normalizeGitattributes(repoDir);
    expect(result).toEqual({ changed: [], stripped: 0 });
    expect(readFileSync(join(repoDir, ".gitattributes"), "utf8")).toBe("* annex.backend=SHA256E\n");
  });
});

describe("stripLargefilesAttributes", () => {
  test("removes only the largefiles attribute, keeping the rest of the line", () => {
    const { content, stripped } = stripLargefilesAttributes(
      "*.tsv text eol=lf annex.largefiles=largerthan=1mb\n",
    );
    expect(content).toBe("*.tsv text eol=lf\n");
    expect(stripped).toBe(1);
  });

  test("drops a line whose only attribute was largefiles", () => {
    const { content, stripped } = stripLargefilesAttributes(
      "* annex.backend=SHA256E\n*.bval annex.largefiles=nothing\n",
    );
    expect(content).toBe("* annex.backend=SHA256E\n");
    expect(stripped).toBe(1);
  });

  test("keeps the git-plumbing line untouched", () => {
    const input = "**/.git* annex.largefiles=nothing\n.gitattributes annex.largefiles=nothing\n";
    const { content, stripped } = stripLargefilesAttributes(input);
    expect(content).toBe(input);
    expect(stripped).toBe(0);
  });

  test("handles the unset spellings as well as the assignment", () => {
    const { content, stripped } = stripLargefilesAttributes(
      "a.tsv -annex.largefiles text\nb.tsv !annex.largefiles text\nc.tsv annex.largefiles text\n",
    );
    expect(content).toBe("a.tsv text\nb.tsv text\nc.tsv text\n");
    expect(stripped).toBe(3);
  });

  test("preserves comments, blank lines and the missing final newline", () => {
    const { content } = stripLargefilesAttributes(
      "# upstream policy\n\n*.tsv annex.largefiles=largerthan=1mb text",
    );
    expect(content).toBe("# upstream policy\n\n*.tsv text");
  });

  test("leaves a file with nothing to strip byte-identical", () => {
    const input = "* annex.backend=MD5E\n**/.git* annex.largefiles=nothing\n";
    expect(stripLargefilesAttributes(input)).toEqual({ content: input, stripped: 0 });
  });
});

describe("isGitPlumbingPattern", () => {
  test("recognises the spellings DataLad and OpenNeuro write", () => {
    expect(isGitPlumbingPattern("**/.git*")).toBe(true);
    expect(isGitPlumbingPattern(".git*")).toBe(true);
    expect(isGitPlumbingPattern(".gitattributes")).toBe(true);
    expect(isGitPlumbingPattern("sub-01/.gitignore")).toBe(true);
  });

  test("does not swallow dataset content", () => {
    expect(isGitPlumbingPattern("*.tsv")).toBe(false);
    expect(isGitPlumbingPattern("phenotype/*.tsv")).toBe(false);
    expect(isGitPlumbingPattern("dataset_description.json")).toBe(false);
  });
});

describe("getAnnexKeysForPaths", () => {
  test("reports keys for annexed paths and nothing for git-resident ones", async () => {
    const keys = await getAnnexKeysForPaths(repoDir, [LARGE_MOTION, SMALL_MOTION, CHANNELS]);
    expect(keys.get(LARGE_MOTION)).toMatch(/^SHA256E-s1500000--/);
    // Still plain git, so git-annex has no key for it -- the absence is the signal
    // normalizeUnannexedData aborts on.
    expect(keys.has(SMALL_MOTION)).toBe(false);
    expect(keys.has(CHANNELS)).toBe(false);
  });

  test("no paths means no git-annex call and no keys", async () => {
    expect(await getAnnexKeysForPaths(repoDir, [])).toEqual(new Map());
  });
});

describe("copyShard", () => {
  test("a manifest of only locally-uploaded keys does no S3 work at all", async () => {
    // The entry-point check for the filter: `copyShard` reaches for S3 on its very
    // next statement, so a version that forgot to exclude these keys would leave
    // this test trying to server-side copy from a source that does not exist --
    // and failing loudly -- instead of returning. Nothing here can write: the
    // correct path makes no AWS call, and the incorrect one is refused for lack of
    // a source. ds099999 keeps even that off any real prefix.
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
    expect(await copyShard("ds099999", { index: 0, count: 1 }, {}, manifest)).toBeUndefined();
  }, 60_000);
});

describe("selectShardCopyItems", () => {
  const local = (key: string) => ({
    key,
    sourceUrl: null,
    source: null,
    destUri: `s3://nemar/on007788/objects/${key}`,
    origin: "local" as const,
  });
  const upstream = (key: string) => ({
    key,
    sourceUrl: `https://openneuro.org/${key}`,
    source: null,
    destUri: `s3://nemar/on007788/objects/${key}`,
  });

  test("never hands a locally-uploaded key to the copy phase", () => {
    const items = [local("SHA256E-s1--a"), upstream("SHA256E-s2--b"), local("SHA256E-s3--c")];
    const { shardItems, localSkipped } = selectShardCopyItems(items, { index: 0, count: 1 });
    expect(localSkipped).toBe(2);
    expect(shardItems.map((i) => i.key)).toEqual(["SHA256E-s2--b"]);
  });

  test("an item with no origin is upstream, so old manifests still copy", () => {
    const { shardItems, localSkipped } = selectShardCopyItems([upstream("SHA256E-s2--b")], {
      index: 0,
      count: 1,
    });
    expect(localSkipped).toBe(0);
    expect(shardItems).toHaveLength(1);
  });

  test("the shards still partition the upstream keys exactly once", () => {
    const items = [
      upstream("SHA256E-s1--a"),
      upstream("SHA256E-s2--b"),
      upstream("SHA256E-s3--c"),
      upstream("SHA256E-s4--d"),
      local("SHA256E-s5--e"),
    ];
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(
        ...selectShardCopyItems(items, { index: i, count: 3 }).shardItems.map((s) => s.key),
      );
    }
    expect(seen.sort()).toEqual([
      "SHA256E-s1--a",
      "SHA256E-s2--b",
      "SHA256E-s3--c",
      "SHA256E-s4--d",
    ]);
  });
});
