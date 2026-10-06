/**
 * Real repositories for the git scrub tests: real `git`, real `git-annex`, real
 * git-filter-repo through `uv`. Nothing here is a stand-in. Every value is invented.
 *
 * Two shapes are built, because production datasets use both: annexed files as `100644` pointer
 * files whose whole content is `/annex/objects/<KEY>` (an unlocked or imported tree), and as
 * `120000` symlinks into `.git/annex/objects/<hashdir>/<KEY>/<KEY>` (a locked tree, made here
 * by a real `git annex add`).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseKey } from "../../../scripts/scrub/contract";
import { FILTER_REPO_REQUIREMENT } from "../../../scripts/scrub/git/git-lib";
import { toolOrFail } from "../helpers/require-tools";

export const CLI = join(import.meta.dir, "../../../scripts/scrub/git/git-scrub.ts");

export const ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@nemar.test",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "author@nemar.test",
  GIT_TERMINAL_PROMPT: "0",
  // Clones here are named for GitHub repositories and reach local sources through `insteadOf`;
  // this keeps any git call that missed the mapping from reaching a real host.
  GIT_ALLOW_PROTOCOL: "file",
};

function probe(cmd: string[]): boolean {
  try {
    return Bun.spawnSync(cmd, { env: ENV, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/** The rewrite needs uv and a resolvable git-filter-repo; tests skip cleanly without them, and fail when NEMAR_REQUIRE_SCRUB_TOOLS=1 (CI). */
export const HAVE_REWRITE_TOOLS =
  toolOrFail("git", probe(["git", "--version"])) &&
  toolOrFail("uv", probe(["uv", "--version"])) &&
  toolOrFail(
    "git-filter-repo via uv",
    probe([
      "uv",
      "run",
      "--quiet",
      "--with",
      FILTER_REPO_REQUIREMENT,
      "python",
      "-c",
      "import git_filter_repo",
    ]),
  );
export const HAVE_ANNEX = toolOrFail("git-annex", probe(["git", "annex", "version"]));

const roots: string[] = [];

export function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nemar-gitscrub-"));
  roots.push(root);
  return root;
}

export function cleanupRoots(): void {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (!dir || !existsSync(dir)) continue;
    Bun.spawnSync(["chmod", "-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a command, return stdout as text, throw on a non-zero exit. */
export function sh(cwd: string, cmd: string[], input?: string): string {
  const r = Bun.spawnSync(cmd, {
    cwd,
    env: ENV,
    stdout: "pipe",
    stderr: "pipe",
    ...(input === undefined ? {} : { stdin: new TextEncoder().encode(input) as Uint8Array }),
  });
  if (r.exitCode !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (${r.exitCode}): ${r.stderr.toString().slice(0, 400)}`,
    );
  }
  return r.stdout.toString();
}

/** Run a command and return stdout, stderr and the exit code without throwing. */
export function shAny(cwd: string, cmd: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

export function git(repo: string, ...args: string[]): string {
  return sh(repo, ["git", ...args]);
}

/** One CLI invocation as a real process, the way an operator runs it. */
export async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

/** `a=1 b=2` pairs from a CLI line, as numbers. */
export function counts(out: string, prefix: string): Record<string, number> {
  const line = out.split("\n").find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`no ${prefix} line in output`);
  const result: Record<string, number> = {};
  for (const m of line.matchAll(/(\w+)=(\d+)/g)) result[m[1] as string] = Number(m[2]);
  return result;
}

export function write(repo: string, path: string, content: string | Uint8Array): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function commitAll(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
}

export function sha(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

export function annexKey(label: string, size: number, ext: string): string {
  return `SHA256E-s${size}--${sha(label)}${ext}`;
}

export function pointer(key: string): string {
  return `/annex/objects/${key}\n`;
}

/** Every commit reachable from the refs that a rewrite covers, oldest last. */
export function allCommits(repo: string): string[] {
  return git(repo, "rev-list", ...nonAnnexRefs(repo))
    .split("\n")
    .filter(Boolean);
}

export function treePaths(repo: string, commit: string): string[] {
  return git(repo, "ls-tree", "-r", "--name-only", "-z", commit).split("\0").filter(Boolean);
}

/** The bytes of `commit:path` as a latin1 string, or null when the path is absent. */
export function fileAt(repo: string, commit: string, path: string): string | null {
  const r = Bun.spawnSync(["git", "-C", repo, "cat-file", "blob", `${commit}:${path}`], {
    env: ENV,
    stdout: "pipe",
    stderr: "ignore",
  });
  return r.exitCode === 0 ? r.stdout.toString("latin1") : null;
}

/** A symlink's target as git stores it: the blob content. */
export function linkAt(repo: string, commit: string, path: string): string | null {
  return fileAt(repo, commit, path);
}

/** The refs a rewrite covers: every ref except the git-annex branches and remote HEADs. */
export function nonAnnexRefs(repo: string): string[] {
  return git(repo, "for-each-ref", "--format=%(refname)")
    .split("\n")
    .filter(Boolean)
    .filter((r) => r.split("/").pop() !== "git-annex" && !r.endsWith("/HEAD"));
}

/**
 * True when any object reachable from a non-annex ref (commit, tree, blob, symlink target)
 * contains `needle`. `git grep` is not used for this because it skips symlinks. The git-annex
 * branch is excluded: its trees carry key names by design, and `annex-registry` handles them.
 */
export function anyObjectContains(repo: string, needle: string): boolean {
  const oids = git(repo, "rev-list", "--objects", ...nonAnnexRefs(repo))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[0] as string);
  const r = Bun.spawnSync(["git", "-C", repo, "cat-file", "--batch"], {
    env: ENV,
    stdin: new TextEncoder().encode(`${oids.join("\n")}\n`) as Uint8Array,
    stdout: "pipe",
    stderr: "ignore",
    maxBuffer: 512 * 1024 * 1024,
  });
  return r.stdout.includes(Buffer.from(needle));
}

/**
 * Every ref and the object it names, except git-annex's own caches under `refs/annex/`: git-annex
 * 10.20240129 (Ubuntu 24.04's) writes `refs/annex/last-index` whenever its filter runs, which a
 * `git status` does, so it moves on a refusal too and says nothing about what the rewrite touched.
 */
export function refTips(repo: string): string {
  return git(repo, "for-each-ref", "--format=%(refname) %(objectname)")
    .split("\n")
    .filter((line) => !line.startsWith("refs/annex/"))
    .join("\n");
}

/**
 * A clone of `source`. With `originUrl` the clone names the GitHub repository it stands for, as a
 * real clone of a dataset does, and git itself reaches the local source through `insteadOf`, so
 * `git remote get-url`-style reads give the GitHub name and every fetch and push still work.
 */
export function cloneOf(source: string, dest: string, originUrl?: string): void {
  sh(dirname(dest), ["git", "clone", "-q", "--no-local", source, dest]);
  if (originUrl) {
    git(dest, "remote", "set-url", "origin", originUrl);
    git(dest, "config", `url.${source}.insteadOf`, originUrl);
  }
}

/** The repository a dataset's clone is of: `nemarDatasets/<id>` on GitHub. */
export function datasetUrl(dataset: string): string {
  return `https://github.com/nemarDatasets/${dataset}`;
}

export function copyTree(from: string, to: string): void {
  sh(dirname(to), ["cp", "-R", from, to]);
}

// ---------------------------------------------------------------------------------------
// The pointer-file dataset
// ---------------------------------------------------------------------------------------

export const SIZE = 1048576;
export const OLD_A = annexKey("old-a", SIZE, ".edf");
export const NEW_A = annexKey("new-a", SIZE, ".edf");
export const OLD_B = annexKey("old-b", 2097152, ".bdf");
export const NEW_B = annexKey("new-b", 2097152, ".bdf");
export const OLD_C = annexKey("old-c", 4096, ".edf");
export const NEW_C = annexKey("new-c", 4096, ".edf");
/** Not in the keymap: its pointers must come through byte for byte. */
export const KEEP = annexKey("keep", 512, ".edf");

export const KEYMAP = { [OLD_A]: NEW_A, [OLD_B]: NEW_B, [OLD_C]: NEW_C };

export const DESCRIPTION_OLD = `{
  "Name": "Test dataset",
  "SubjectName": "Alice Example",
  "SubjectNames": ["keep", "me"],
  "Authors": [
    {
      "first_name": "A",
      "Subject-Name": "Bob Example",
      "details": {
        "SUBJECT NAME": "Carol Example",
        "SubjectID": "sub-01"
      }
    }
  ],
  "Notes": {"subject_name": {"first": "Dan", "last": "Example"}}
}
`;
export const DESCRIPTION_NEW = `{
  "Name": "Test dataset",
  "SubjectName": "",
  "SubjectNames": ["keep", "me"],
  "Authors": [
    {
      "first_name": "A",
      "Subject-Name": "",
      "details": {
        "SUBJECT NAME": "",
        "SubjectID": "sub-01"
      }
    }
  ],
  "Notes": {"subject_name": ""}
}
`;
/** The later revision of the file adds one field and must come out blanked the same way. */
export const DESCRIPTION_OLD_V2 = DESCRIPTION_OLD.replace(
  '"Name": "Test dataset",',
  '"Name": "Test dataset",\n  "BIDSVersion": "1.9.0",',
);
export const DESCRIPTION_NEW_V2 = DESCRIPTION_NEW.replace(
  '"Name": "Test dataset",',
  '"Name": "Test dataset",\n  "BIDSVersion": "1.9.0",',
);
export const PARTICIPANTS_OLD =
  '{\n\t"Participant Name": "Bob",\n\t"Age": {\n\t\t"Description": "age in years"\n\t},\n\t"participantname_note": "keep"\n}\n';
export const PARTICIPANTS_NEW =
  '{\n\t"Participant Name": "",\n\t"Age": {\n\t\t"Description": "age in years"\n\t},\n\t"participantname_note": "keep"\n}\n';
export const COMPACT_OLD = '{"a":1,"PartName":"X","list":[1,2,{"partname":"Y"}],"n":null}';
export const COMPACT_NEW = '{"a":1,"PartName":"","list":[1,2,{"partname":""}],"n":null}';
export const NOT_JSON = '{"SubjectName": "unterminated';
/** Latin-1, not UTF-8: left alone and counted. */
export const LATIN1_JSON = Buffer.from('{"SubjectName": "caf\xe9"}', "latin1");

const PROV_EEG = { file: "sub-01/eeg/sub-01_eeg.edf", bytes: 1048576 };
const PROV_A = { file: "sub-01/photo-A.jpg", bytes: 100 };
const PROV_B = { file: "sub-02/photo-B.jpg", bytes: 200 };
const PROV_C = { file: "late/photo-C.png", bytes: 300 };
function provenance(files: { file: string; bytes: number }[], extra: object = {}): string {
  const total = files.reduce((n, f) => n + f.bytes, 0);
  return `${JSON.stringify({ dataset: "nm000999", n_files: files.length, total_bytes: total, files, ...extra }, null, 2)}\n`;
}
/** The provenance file as the dataset's three revisions have it: it lists the images. */
export const PROVENANCE_C1 = provenance([PROV_A, PROV_EEG]);
export const PROVENANCE_C3 = provenance([PROV_A, PROV_B, PROV_EEG]);
export const PROVENANCE_C7 = provenance([PROV_A, PROV_B, PROV_EEG, PROV_C]);
export const PRIVACY_NOTE = "2026-10-04: files that identify a person were removed.";
/** What every revision must become: the images' entries gone, the count and total recomputed. */
export const PROVENANCE_SCRUBBED = provenance([PROV_EEG], { privacy_correction: PRIVACY_NOTE });

export const CHANGES_TEXT = "1.1.1\n  - removed identifying content\n";
export const README_TEXT = "\nA privacy scrub was applied.\n";

export const PLAN = {
  version: 1,
  dataset: "nm000999",
  dropPaths: [
    "sub-01/photo-A.jpg", // c1 through c5: the oldest commits carry it
    "sub-02/photo-B.jpg", // c2 to the tip
    "late/photo-C.png", // the tip only
    "never/present.jpg", // in no commit
  ],
  blankJsonKeys: {
    "dataset_description.json": ["subjectname"],
    "participants.json": ["participantname"],
    "sub-01/compact.json": ["partname"],
    "bad.json": ["subjectname"],
    "latin1.json": ["subjectname"],
  },
  appendText: { CHANGES: CHANGES_TEXT, README: README_TEXT },
  jsonOps: {
    "provenance.json": [
      {
        op: "drop-array-entries",
        array: "files",
        matchField: "file",
        matchValues: ["sub-01/photo-A.jpg", "sub-02/photo-B.jpg", "late/photo-C.png"],
      },
      {
        op: "recount",
        array: "files",
        countKey: "n_files",
        sumKey: "total_bytes",
        sumField: "bytes",
      },
      { op: "set", key: "privacy_correction", value: PRIVACY_NOTE },
    ],
  },
};

/**
 * The S3 stage's `plan.json` for a dataset, as the contract has it: every key it read, the ones
 * that need a scrub, and the ones it found clean. `unreadable` keys are listed as not checked.
 */
export function s3PlanFor(
  dataset: string,
  keys: { scrub: string[]; clean: string[]; unreadable?: string[] },
): object {
  const entry = (oldKey: string, needsScrub: boolean, status: "read" | "unreadable") => ({
    oldKey,
    size: parseKey(oldKey).size,
    needsScrub,
    versionIds: [],
    reasons: needsScrub ? ["patient-name"] : [],
    status,
  });
  const all = [
    ...keys.scrub.map((k) => entry(k, true, "read")),
    ...keys.clean.map((k) => entry(k, false, "read")),
    ...(keys.unreadable ?? []).map((k) => entry(k, false, "unreadable")),
  ];
  return {
    version: 1,
    dataset,
    bucket: "nemar-fixture",
    tags: ["v1.0.1"],
    createdAt: "2026-10-04T00:00:00.000Z",
    keys: all,
    totals: {
      keys: all.length,
      needScrub: keys.scrub.length,
      bytesToHash: all.filter((e) => e.needsScrub).reduce((n, e) => n + e.size, 0),
      unreadable: keys.unreadable?.length ?? 0,
    },
  };
}

export const BINARY = Buffer.concat([
  Buffer.from([0, 1, 2, 255, 254, 0]),
  Buffer.from("SHA256E-s9--not-a-key"),
  Buffer.from([0, 0, 7]),
]);

export interface PointerFixture {
  root: string;
  /** The published repository, left untouched as the oracle for "before". */
  src: string;
  /** A fresh clone, with git-annex initialized in it. */
  clone: string;
  keymapPath: string;
  planPath: string;
  /** The S3 plan: OLD_A, OLD_B and OLD_C need a scrub, KEEP was read and is clean. */
  s3PlanPath: string;
  /** Commit ids in `src`, by name. */
  commits: Record<string, string>;
  uuid: string;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Eight commits, a merge, three tags, the same pointer in several commits, and every file
 * kind the rewrite must treat differently. Commit names in the comments are used by the tests.
 */
export function buildPointerFixture(): PointerFixture {
  const root = makeRoot();
  const src = join(root, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  const commits: Record<string, string> = {};

  // c1
  write(src, "dataset_description.json", DESCRIPTION_OLD);
  write(src, "participants.json", PARTICIPANTS_OLD);
  write(src, "sub-01/compact.json", COMPACT_OLD);
  write(src, "sub-01/eeg/sub-01_eeg.edf", pointer(OLD_A));
  write(src, "sub-01/eeg/sub-01_aux.bdf", pointer(OLD_B));
  write(src, "sub-02/eeg/sub-02_eeg.edf", pointer(KEEP));
  write(src, "sub-01/photo-A.jpg", "jpeg-bytes-A");
  write(src, "derivatives/blob.bin", BINARY);
  write(src, "bad.json", NOT_JSON);
  write(src, "latin1.json", LATIN1_JSON);
  write(src, "README", "Test dataset");
  write(src, "provenance.json", PROVENANCE_C1);
  commits.c1 = commitAll(src, "c1");

  // c2: the same pointer content again under a new path; a second image; tag v1.0.1
  write(src, "sub-03/eeg/sub-03_eeg.bdf", pointer(OLD_B));
  write(src, "sub-02/photo-B.jpg", "jpeg-bytes-B");
  commits.c2 = commitAll(src, "c2");
  git(src, "tag", "v1.0.1");

  // c3: CHANGES appears, the description changes; annotated tag v1.0.2
  write(src, "CHANGES", "1.0.1 initial release");
  write(src, "dataset_description.json", DESCRIPTION_OLD_V2);
  write(src, "provenance.json", PROVENANCE_C3);
  commits.c3 = commitAll(src, "c3");
  git(src, "tag", "-a", "v1.0.2", "-m", "second release, annotated");

  // a side branch adds a pointer that only the merge's second parent carries
  git(src, "checkout", "-q", "-b", "side");
  write(src, "sub-04/eeg/sub-04_eeg.edf", pointer(OLD_C));
  commits.side = commitAll(src, "side");
  git(src, "checkout", "-q", "main");

  // c4 on main, then the merge
  write(src, "README", "Test dataset, edited");
  commits.c4 = commitAll(src, "c4");
  git(src, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  commits.c5 = git(src, "rev-parse", "HEAD").trim();

  // c6: the first image is deleted; tag v1.1.0
  git(src, "rm", "-q", "sub-01/photo-A.jpg");
  git(src, "commit", "-q", "-m", "c6");
  commits.c6 = git(src, "rev-parse", "HEAD").trim();
  git(src, "tag", "v1.1.0");

  // c7: a third image that exists only at the tip, and a participants change
  write(src, "late/photo-C.png", "png-bytes-C");
  write(src, "participants.json", PARTICIPANTS_OLD.replace("Bob", "Bobby"));
  write(src, "provenance.json", PROVENANCE_C7);
  commits.c7 = commitAll(src, "c7");

  // A real annex branch, with real location logs for the old keys.
  sh(src, ["git", "annex", "init", "--quiet", "origin-copy"]);
  const uuid = git(src, "config", "annex.uuid").trim();
  sh(
    src,
    ["git", "annex", "setpresentkey", "--batch"],
    `${[OLD_A, OLD_B, OLD_C, KEEP].map((k) => `${k} ${uuid} 1`).join("\n")}\n`,
  );

  const clone = join(root, "clone");
  cloneOf(src, clone, datasetUrl("nm000999"));
  sh(clone, ["git", "annex", "init", "--quiet", "clone"]);

  const keymapPath = join(root, "keymap.json");
  const planPath = join(root, "git-plan.json");
  writeJson(keymapPath, KEYMAP);
  writeJson(planPath, PLAN);
  const s3PlanPath = join(root, "plan.json");
  writeJson(s3PlanPath, s3PlanFor("nm000999", { scrub: [OLD_A, OLD_B, OLD_C], clean: [KEEP] }));
  return { root, src, clone, keymapPath, planPath, s3PlanPath, commits, uuid };
}

// ---------------------------------------------------------------------------------------
// The symlink dataset
// ---------------------------------------------------------------------------------------

export interface SymlinkFixture {
  root: string;
  src: string;
  clone: string;
  keymapPath: string;
  planPath: string;
  /** The S3 plan: the two keys in the keymap need a scrub, the third was read and is clean. */
  s3PlanPath: string;
  /** old key -> new key, and the paths each key is linked from. */
  keymap: Record<string, string>;
  paths: Record<string, string[]>;
}

/**
 * A real locked annex tree: every file is added by `git annex add`, so every symlink target and
 * its hash directory is whatever git-annex itself wrote.
 */
export function buildSymlinkFixture(): SymlinkFixture {
  const root = makeRoot();
  const src = join(root, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  sh(src, ["git", "annex", "init", "--quiet", "origin-copy"]);
  const add = (path: string, content: string): string => {
    write(src, path, content);
    sh(src, ["git", "annex", "add", "--quiet", path]);
    return sh(src, ["git", "annex", "lookupkey", path]).trim();
  };

  const keyX = add("sub-01/eeg/a.edf", "content-X-".repeat(100));
  const keyY = add("sub-01/eeg/b.edf", "content-Y-".repeat(150));
  git(src, "commit", "-q", "-m", "c1");
  // the same content under a second name: one key, two symlinks
  add("sub-02/eeg/c.edf", "content-X-".repeat(100));
  write(src, "sub-01/photo.jpg", "jpeg");
  git(src, "add", "sub-01/photo.jpg");
  git(src, "commit", "-q", "-m", "c2");
  git(src, "tag", "v1");
  const keyZ = add("top.bdf", "content-Z-".repeat(300));
  git(src, "commit", "-q", "-m", "c3");
  git(src, "tag", "-a", "v2", "-m", "annotated");
  git(src, "rm", "-q", "-f", "sub-01/eeg/b.edf");
  git(src, "commit", "-q", "-m", "c4");
  // Y returns under another name
  add("sub-03/eeg/d.edf", "content-Y-".repeat(150));
  git(src, "commit", "-q", "-m", "c5");
  git(src, "rm", "-q", "-f", "sub-01/photo.jpg");
  git(src, "commit", "-q", "-m", "c6");
  git(src, "tag", "v3");
  write(src, "CHANGES", "1.0 first\n");
  commitAll(src, "c7");

  const withNew = (old: string, label: string): string => {
    const m = /^SHA256E-s(\d+)--[0-9a-f]{64}(\.[a-z]+)$/.exec(old);
    if (!m) throw new Error("unexpected key shape");
    return `SHA256E-s${m[1]}--${sha(label)}${m[2]}`;
  };
  // X and Z are scrubbed, Y is not.
  const keymap = { [keyX]: withNew(keyX, "new-x"), [keyZ]: withNew(keyZ, "new-z") };
  const clone = join(root, "clone");
  cloneOf(src, clone, datasetUrl("nm000998"));
  sh(clone, ["git", "annex", "init", "--quiet", "clone"]);
  const keymapPath = join(root, "keymap.json");
  const planPath = join(root, "git-plan.json");
  writeJson(keymapPath, keymap);
  writeJson(planPath, {
    version: 1,
    dataset: "nm000998",
    dropPaths: ["sub-01/photo.jpg"],
    blankJsonKeys: {},
    appendText: { CHANGES: "1.0.1\n  - scrubbed\n" },
  });
  const s3PlanPath = join(root, "plan.json");
  writeJson(s3PlanPath, s3PlanFor("nm000998", { scrub: [keyX, keyZ], clean: [keyY] }));
  return {
    root,
    src,
    clone,
    keymapPath,
    planPath,
    s3PlanPath,
    keymap,
    paths: { [keyX]: ["sub-01/eeg/a.edf", "sub-02/eeg/c.edf"], [keyZ]: ["top.bdf"] },
  };
}

// ---------------------------------------------------------------------------------------
// A sourcedata mirror: the shape of nm000186
// ---------------------------------------------------------------------------------------

export const MIRROR_DATASET = "nm000997";
export const MIRROR_TAGS = ["v1.0.0", "v1.1.0"];
export const MIRROR_PROVENANCE = "sourcedata/sourcedata_provenance.json";
export const MIRROR_README = "sourcedata/README_sourcedata_provenance.md";

/** Subject n's BIDS recording, and the upstream original that `sourcedata/` mirrors for it. */
export const mirrorRecording = (n: number): string => annexKey(`mirror-rec-${n}`, 2048 + n, ".edf");
export const mirrorOriginal = (n: number): string => annexKey(`mirror-orig-${n}`, 1024 + n, ".edf");
/** The checksum the provenance file lists for original n: the sha256 in that original's key. */
export const mirrorChecksum = (n: number): string => sha(`mirror-orig-${n}`);

/**
 * A mirrored upstream file the scrub leaves alone (its content identifies nobody), so its checksum
 * in the provenance file is not an old key's: nm000186's file lists such entries too.
 */
export const MIRROR_EVENTS = "onset\tduration\ttrial_type\n0.5\t1.0\tstimulus\n";
export const mirrorEventsChecksum = (): string =>
  createHash("sha256").update(MIRROR_EVENTS).digest("hex");

/** The provenance file as an upstream mirror carries it: every original, with its sha256. */
export function mirrorProvenance(ns: number[]): string {
  const files = [
    ...ns.map((n) => ({
      file: `upstream/rec-${n}.edf`,
      bytes: 1024 + n,
      sha256: mirrorChecksum(n),
    })),
    {
      file: "upstream/events.tsv",
      bytes: Buffer.byteLength(MIRROR_EVENTS),
      sha256: mirrorEventsChecksum(),
    },
  ];
  const total = files.reduce((t, f) => t + f.bytes, 0);
  return `${JSON.stringify({ source: "an upstream release", n_files: files.length, total_bytes: total, files }, null, 2)}\n`;
}

export interface MirrorFixture {
  root: string;
  src: string;
  /** The stand-in for GitHub: a bare repository with a `nemar-s3` special remote recorded. */
  bare: string;
  /** The operator's clone of `bare`, with git-annex initialized; the plan is built from it. */
  clone: string;
  keymapPath: string;
  /** Every old key needs a scrub: three recordings and the three originals they mirror. */
  s3PlanPath: string;
  /** Where the test writes the git plan the real builder made. */
  planPath: string;
  keymap: Record<string, string>;
}

/**
 * Three subjects over three commits and two tags. Each has a BIDS recording and, under
 * `sourcedata/upstream/`, the upstream original it was converted from, and the provenance file
 * lists each original's sha256: two versions of it, one at `v1.0.0` (two originals) and one at
 * `v1.1.0` and the tip (three), as nm000186 has two. Each version also lists an upstream events
 * file the scrub leaves alone, whose checksum is no old key's. No file under `sourcedata/` is an
 * image or a document, so the scrub drops nothing: every key is scrubbed in place.
 */
export function buildMirrorFixture(): MirrorFixture {
  const root = makeRoot();
  const src = join(root, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  const subject = (n: number): void => {
    write(src, `sub-0${n}/eeg/sub-0${n}_eeg.edf`, pointer(mirrorRecording(n)));
    write(src, `sourcedata/upstream/rec-${n}.edf`, pointer(mirrorOriginal(n)));
  };
  write(src, "dataset_description.json", '{\n  "Name": "Mirror dataset"\n}\n');
  write(src, "README", "Mirror dataset\n");
  write(src, "CHANGES", "1.0.0 initial release\n");
  subject(1);
  subject(2);
  write(src, "sourcedata/upstream/events.tsv", MIRROR_EVENTS);
  write(src, MIRROR_PROVENANCE, mirrorProvenance([1, 2]));
  write(src, MIRROR_README, "The files under sourcedata/ are the upstream files, unmodified.\n");
  commitAll(src, "c1");
  git(src, "tag", "v1.0.0");
  subject(3);
  write(src, MIRROR_PROVENANCE, mirrorProvenance([1, 2, 3]));
  commitAll(src, "c2");
  git(src, "tag", "-a", "v1.1.0", "-m", "second release, annotated");
  write(src, "README", "Mirror dataset, edited\n");
  commitAll(src, "c3");

  const oldKeys = [1, 2, 3].flatMap((n) => [mirrorRecording(n), mirrorOriginal(n)]);
  sh(src, ["git", "annex", "init", "--quiet", "origin-copy"]);
  const uuid = git(src, "config", "annex.uuid").trim();
  sh(
    src,
    ["git", "annex", "setpresentkey", "--batch"],
    `${oldKeys.map((k) => `${k} ${uuid} 1`).join("\n")}\n`,
  );
  // After the location logs, as in fresh-clone.test.ts: `initremote` commits the git-annex
  // journal, so the bare clone below carries the logs `annex-registry` retracts.
  const store = join(root, "store");
  mkdirSync(store);
  sh(src, [
    "git",
    "annex",
    "initremote",
    "nemar-s3",
    "type=directory",
    `directory=${store}`,
    "encryption=none",
  ]);
  const bare = join(root, "github.git");
  sh(root, ["git", "clone", "-q", "--bare", "--no-local", src, bare]);
  const clone = join(root, "clone");
  cloneOf(bare, clone, datasetUrl(MIRROR_DATASET));
  sh(clone, ["git", "annex", "init", "--quiet", "operator"]);

  const keymap = Object.fromEntries(
    oldKeys.map((k) => {
      const m = /^SHA256E-s(\d+)--[0-9a-f]{64}(\.edf)$/.exec(k) as RegExpExecArray;
      return [k, `SHA256E-s${m[1]}--${sha(`new-${k}`)}${m[2]}`];
    }),
  );
  const keymapPath = join(root, "keymap.json");
  writeJson(keymapPath, keymap);
  const s3PlanPath = join(root, "plan.json");
  writeJson(s3PlanPath, {
    ...(s3PlanFor(MIRROR_DATASET, { scrub: oldKeys, clean: [] }) as Record<string, unknown>),
    tags: MIRROR_TAGS,
  });
  return {
    root,
    src,
    bare,
    clone,
    keymapPath,
    s3PlanPath,
    planPath: join(root, "git-plan.json"),
    keymap,
  };
}
