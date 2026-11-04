/**
 * A manual major version is refused on a mirror (ADR 0006, ADR 0111 decision 5; epic #1046 phase
 * 6, #1912): on an OpenNeuro mirror a major means an upstream re-pull, which only `nemar admin
 * repull` makes. `refuseMirrorMajor` is the rule; `nemar dataset release` (`--type major`,
 * `--version`) and `nemar dataset update --bump major` ask it after the new version is settled and
 * before anything is cloned, branched or pushed. The CLI's rule only: the dataset repositories'
 * `version-check` workflow does not read it (ADR 0020).
 *
 * The spawned cases run the real CLI against the REAL datasets router over bun:sqlite with every
 * migration applied, behind its real auth, on a loopback port named in config.json (the account's
 * apiUrl): the row's `source` and the current version the CLI reads are the Worker's own answers,
 * not a copy of them. GitHub, which the versions route reads the description from, is the
 * `Bun.serve()` stand-in. `git` and `gh` are on PATH as shims that record every call. `gh` answers
 * its version probe and refuses every other call. `git` (`gitShim` below) finds the command past
 * git's own options (`-c`, `-C`, `--git-dir` and the like) and refuses, with exit 128 and without
 * running the real git: clone, fetch, pull, push, ls-remote, archive, request-pull, send-pack,
 * fetch-pack, http-fetch, http-push, svn, p4 and every submodule command; `remote` update, prune,
 * show and set-head; and every `annex` command but `annex version`. It runs every other call with
 * the real git. The CLI runs with no GH_TOKEN or GITHUB_TOKEN in its environment. A refusal shows
 * as no clone, branch, commit or push in the record.
 *
 * CI TIER: unit-pure. Spawns the CLI against loopback servers only; no network.
 */

import type { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { makeRepullApp } from "../backend/test/helpers/repull-app";
import { refuseMirrorMajor } from "../src/lib/version-policy";
import { type GitHubStandin, WORKER_TOKEN, startGitHubStandin } from "./helpers/github-standin";

// A test here runs the CLI from source up to four times, each run bounded by its own 30-second
// `timeout`. 60 seconds, git-credential.test.ts's bound for the same spawn, lets a hung run fail
// on its own limit, with its output, instead of the default five seconds cutting the test short.
setDefaultTimeout(60_000);

describe("refuseMirrorMajor", () => {
  const ask = (datasetId: string, source: string | null, current: string, next: string) =>
    refuseMirrorMajor({ datasetId, source, current, next });

  test("a higher major on an on id, or on a row recorded as an OpenNeuro import, is refused", () => {
    expect(ask("on004362", null, "1.0.1", "2.0.0")).toContain("nemar admin repull plan on004362");
    expect(ask("on004362", "openneuro", "v1.0.0", "3.0.0")).toContain("upstream re-pull");
    expect(ask("xx090123", "openneuro", "1.0.0", "2.0.0")).toContain("upstream re-pull");
  });

  test("a minor, a patch, the same major and a lower one pass; so does a dataset that is not a mirror", () => {
    expect(ask("on004362", null, "1.0.0", "1.1.0")).toBeNull();
    expect(ask("on004362", null, "1.0.0", "1.0.1")).toBeNull();
    expect(ask("on004362", null, "2.0.0", "2.1.0")).toBeNull();
    expect(ask("on004362", null, "2.0.0", "1.9.0")).toBeNull();
    expect(ask("nm000200", null, "1.0.0", "2.0.0")).toBeNull();
    expect(ask("xx090123", "nemar-exemplar", "1.0.0", "2.0.0")).toBeNull();
  });

  test("on a mirror, a version either side cannot read is refused: unknown is never a pass", () => {
    for (const [current, next] of [
      ["", "2.0.0"],
      ["none", "1.0.1"],
      ["1.0", "1.1.0"],
      ["1.0.0", "1.2.3-dev0"],
      ["1.0.0", ""],
    ]) {
      expect(ask("on004362", null, current as string, next as string)).toContain("cannot be read");
      // The remedy: the form a version must have.
      expect(ask("on004362", null, current as string, next as string)).toContain(
        "A version is of the form X.Y.Z",
      );
      expect(ask("xx090123", "openneuro", current as string, next as string)).toContain(
        "cannot be read",
      );
      // Not a mirror: not this rule's to judge.
      expect(ask("nm000200", null, current as string, next as string)).toBeNull();
    }
  });
});

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.ts");
const REAL_GIT = Bun.which("git") as string;
const NO_SUCH_REPO = "nemarOrg/repull-mirror-major-no-such-repo";
const SCRUBBED = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FORCE_COLOR",
  "CLICOLOR_FORCE",
  // No credential for GitHub: the gh shim answers in its place, and the real git reaches no remote.
  "GH_TOKEN",
  "GITHUB_TOKEN",
];

/** Commands that can reach a remote, which the git shim refuses wherever they stand. */
const REFUSED_COMMANDS = [
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "archive",
  "request-pull",
  "send-pack",
  "fetch-pack",
  "http-fetch",
  "http-push",
  "svn",
  "p4",
  "submodule",
];
/** The `remote` subcommands that ask the remote itself. */
const REFUSED_REMOTE = ["update", "prune", "show", "set-head"];
/** What the shim writes when the CLI was handed a GitHub token. */
const TOKEN_SEEN = "a GitHub token is in the environment";

/**
 * The git shim: every call recorded in `log`, the command found past git's own options (one that
 * takes a value skips it too), and a call that can reach a remote refused with exit 128 before
 * `realGit` runs. Everything else is handed to `realGit`.
 */
function gitShim(log: string, realGit: string): string {
  return [
    "#!/bin/sh",
    `printf 'git %s\\n' "$*" >> '${log}'`,
    `if [ -n "$GH_TOKEN$GITHUB_TOKEN" ]; then printf '${TOKEN_SEEN}\\n' >> '${log}'; fi`,
    'refuse() { echo "git $*: refused by the test\'s shim, it can reach a remote" >&2; exit 128; }',
    "verb=; sub=; skip=",
    'for arg in "$@"; do',
    '  if [ -n "$skip" ]; then skip=; continue; fi',
    '  if [ -z "$verb" ]; then',
    '    case "$arg" in',
    "      -c|-C|--git-dir|--work-tree|--namespace|--config-env|--super-prefix) skip=1 ;;",
    "      -*) ;;",
    "      *) verb=$arg ;;",
    "    esac",
    "  else",
    '    case "$arg" in -*) ;; *) sub=$arg; break ;; esac',
    "  fi",
    "done",
    'case "$verb" in',
    `  ${REFUSED_COMMANDS.join("|")}) refuse "$@" ;;`,
    `  remote) case "$sub" in ${REFUSED_REMOTE.join("|")}) refuse "$@" ;; esac ;;`,
    '  annex) [ "$sub" = version ] || refuse "$@" ;;',
    "esac",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n");
}

const API_KEY = "mirror-major-owner-key-0123456789abcdef0123456789abcdef";

/** The rows the API holds: two mirrors (an `on` id, an `xx` OpenNeuro import) and a dataset that is not one. */
const ROWS: Record<string, { source: string | null; source_id: string | null }> = {
  on000001: { source: "openneuro", source_id: "ds000001" },
  xx090123: { source: "openneuro", source_id: "ds000123" },
  nm000200: { source: null, source_id: null },
};

let db: Database;
let gh: GitHubStandin;
let backend: ReturnType<typeof Bun.serve>;
let root: string;
let configDir: string;
let shims: string;
let log: string;
const handle = makeRepullApp();

beforeAll(async () => {
  db = freshDb();
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (1, 'mirrorowner', 'mirrorowner@example.org', 'x', 'approved', 'member', 1)`,
  );
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (1, ?, ?)").run(
    await hashApiKey(API_KEY),
    API_KEY.slice(0, 8),
  );
  // No version rows: the versions route's current version is then the description's, which the
  // GitHub stand-in answers 404 for, so the route's own default, v1.0.0.
  for (const [id, row] of Object.entries(ROWS)) {
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo,
                             source, source_id)
       VALUES (?, 'A sufficiently descriptive fixture title', 1, 'active', 'public', ?, ?, ?)`,
      [id, NO_SUCH_REPO, row.source, row.source_id],
    );
  }
  gh = startGitHubStandin();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = gh.url;
  const env = {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: WORKER_TOKEN,
  } as Bindings;
  backend = Bun.serve({
    port: 0,
    fetch(req) {
      // The CLI's notices banner, which no route here serves; answered as the re-pull suites do.
      if (new URL(req.url).pathname === "/notices") return Response.json({ notices: [] });
      return handle(req, env);
    },
  });
});
afterAll(() => {
  backend.stop(true);
  gh.stop();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nemar-mirror-major-"));
  configDir = join(root, "config");
  shims = join(root, "bin");
  log = join(root, "calls.log");
  mkdirSync(configDir);
  mkdirSync(shims);
  writeFileSync(log, "");
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "mirror-major",
      accounts: {
        "mirror-major": {
          apiUrl: `http://127.0.0.1:${backend.port}`,
          apiKey: API_KEY,
        },
      },
    }),
  );
  // git: every call recorded; one that can reach a remote refused, so nothing can reach a real
  // repository. The update case's clone names `nemarDatasets/<id>` on GitHub as its origin, and a
  // regression past the refusal used to push there: a mutation of the detail route showed it.
  writeFileSync(join(shims, "git"), gitShim(log, REAL_GIT));
  // gh: its version probe answered, every other call recorded and refused.
  writeFileSync(
    join(shims, "gh"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 2.60.0"; exit 0; fi\nprintf 'gh %s\\n' "$*" >> '${log}'\nexit 1\n`,
  );
  chmodSync(join(shims, "git"), 0o755);
  chmodSync(join(shims, "gh"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function cli(args: string[], cwd = REPO_ROOT) {
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("TEST_") && !SCRUBBED.includes(k.toUpperCase()),
    ),
  );
  Object.assign(env, {
    NEMAR_CONFIG_DIR: configDir,
    NEMAR_NO_UPDATE_CHECK: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    PATH: `${shims}:${process.env.PATH ?? ""}`,
  });
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, all: `${stdout}\n${stderr}` };
}

/** The calls the shims recorded, but for git's own version probe. */
const calls = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "" && l !== "git --version");

describe("nemar dataset release", () => {
  test("--type major and --version 2.0.0 on a mirror exit 1 before any clone", async () => {
    for (const args of [
      ["on000001", "--type", "major"],
      ["on000001", "--version", "2.0.0"],
      ["xx090123", "--type", "major"],
      ["xx090123", "--version", "3.0.0"],
    ]) {
      writeFileSync(log, "");
      const run = await cli(["dataset", "release", ...args, "--yes"]);
      expect([args.join(" "), run.exitCode]).toEqual([args.join(" "), 1]);
      expect(run.all).toContain("A major version of a mirror means an upstream re-pull");
      expect(run.all).toContain(`nemar admin repull plan ${args[0]}`);
      expect(run.all).not.toContain("Run again with --debug");
      expect([args.join(" "), calls()]).toEqual([args.join(" "), []]);
    }
  });

  test("--type minor on a mirror, and a major on a dataset that is not one, pass the check", async () => {
    for (const args of [
      ["on000001", "--type", "minor"],
      ["nm000200", "--type", "major"],
    ]) {
      writeFileSync(log, "");
      const run = await cli(["dataset", "release", ...args, "--yes"]);
      expect(run.all).not.toContain("upstream re-pull");
      // It went on to clone, which the shim refuses.
      expect(calls().some((c) => c.startsWith("git clone"))).toBe(true);
    }
  });
});

describe("nemar dataset update", () => {
  async function clone(datasetId: string): Promise<string> {
    const dir = join(root, datasetId);
    mkdirSync(dir);
    const git = (args: string[]) =>
      Bun.spawnSync([REAL_GIT, ...args], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git(["init", "-q", "--initial-branch", "main"]);
    git(["remote", "add", "origin", `https://github.com/nemarDatasets/${datasetId}.git`]);
    writeFileSync(
      join(dir, "dataset_description.json"),
      `${JSON.stringify({ Name: "x", BIDSVersion: "1.9.0", Version: "1.0.0" }, null, 2)}\n`,
    );
    writeFileSync(join(dir, "participants.tsv"), "participant_id\tage\nsub-01\t30\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    // The change the update would release.
    writeFileSync(join(dir, "participants.tsv"), "participant_id\tage\nsub-01\t2.5\n");
    return dir;
  }

  test("--bump major on a mirror exits 1 before a branch, a commit or a push", async () => {
    for (const id of ["on000001", "xx090123"]) {
      const dir = await clone(id);
      writeFileSync(log, "");
      const run = await cli([
        "dataset",
        "update",
        dir,
        "--bump",
        "major",
        "-m",
        "Correct the participant ages",
        "--description",
        "Ages in participants.tsv were in months; they are now in years.",
        "--yes",
      ]);
      expect([id, run.exitCode]).toEqual([id, 1]);
      expect(run.all).toContain("A major version of a mirror means an upstream re-pull");
      const writes = calls().filter((c) =>
        /^git (checkout|switch|branch|add|commit|push)\b|^gh /.test(c),
      );
      expect([id, writes]).toEqual([id, []]);
      // The working tree is as it was: no version bump written.
      expect(JSON.parse(readFileSync(join(dir, "dataset_description.json"), "utf8")).Version).toBe(
        "1.0.0",
      );
    }
  });
});

describe("the git shim reaches no remote", () => {
  // Here the shim stands in front of a recorder instead of the real git, so a refused call that got
  // through would show in the recorder's record; the calls it allows show that it is reached.
  let dir: string;
  let shim: string;
  let reached: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nemar-git-shim-"));
    reached = join(dir, "reached.log");
    const recorder = join(dir, "real-git");
    writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${reached}'\n`);
    shim = join(dir, "git");
    writeFileSync(shim, gitShim(join(dir, "calls.log"), recorder));
    chmodSync(recorder, 0o755);
    chmodSync(shim, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runShim = (args: string[]) =>
    Bun.spawnSync([shim, ...args], { cwd: dir, env: { PATH: process.env.PATH ?? "" } });
  const realCalls = () =>
    existsSync(reached) ? readFileSync(reached, "utf8").split("\n").filter(Boolean) : [];

  for (const args of [
    ["-c", "key=value", "push", "origin", "main"],
    ["-C", "/tmp", "push", "origin", "main"],
    ["--git-dir=/tmp/x.git", "fetch", "origin"],
    ["--git-dir", "/tmp/x.git", "fetch", "origin"],
    ["-c", "a=b", "-C", "/tmp", "remote", "update"],
    ["remote", "update"],
    ["remote", "-v", "show", "origin"],
    ["remote", "prune", "origin"],
    ["remote", "set-head", "origin", "--auto"],
    ["annex", "sync"],
    ["-C", "/tmp", "annex", "copy", "--to", "origin", "."],
    ["annex", "get", "sub-01"],
    ["submodule", "update", "--init"],
    ["clone", "https://github.com/nemarDatasets/on000001.git"],
    ["fetch"],
    ["pull"],
    ["push"],
    ["ls-remote", "origin"],
  ]) {
    test(`git ${args.join(" ")}: refused, and the real git never runs`, () => {
      const r = runShim(args);
      expect([r.exitCode, r.stderr.toString()]).toEqual([
        128,
        expect.stringContaining("refused by the test's shim"),
      ]);
      expect(realCalls()).toEqual([]);
    });
  }

  test("the calls the CLI makes here before a refusal still reach the real git", () => {
    const allowed = [
      ["--version"],
      ["status", "--porcelain"],
      ["-C", "/tmp", "rev-parse", "--abbrev-ref", "HEAD"],
      ["remote", "get-url", "origin"],
      ["remote", "-v"],
      ["annex", "version"],
    ];
    for (const args of allowed) expect([args, runShim(args).exitCode]).toEqual([args, 0]);
    expect(realCalls()).toEqual(allowed.map((a) => a.join(" ")));
  });

  test("the header names every command the shim refuses", () => {
    const header = readFileSync(import.meta.path, "utf8").split("*/")[0] as string;
    for (const word of [...REFUSED_COMMANDS, ...REFUSED_REMOTE]) {
      expect([word, header.includes(word)]).toEqual([word, true]);
    }
  });

  test("the CLI runs with no GitHub token, whatever the test process holds", async () => {
    const saved = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN];
    process.env.GH_TOKEN = "ghp_mirror_major_must_not_pass";
    process.env.GITHUB_TOKEN = "ghp_mirror_major_must_not_pass";
    try {
      writeFileSync(log, "");
      await cli(["dataset", "release", "on000001", "--type", "major", "--yes"]);
      const record = readFileSync(log, "utf8");
      // The CLI asked git something, so the shim ran and looked.
      expect(record).toContain("git --version");
      expect(record).not.toContain(TOKEN_SEEN);
    } finally {
      for (const [i, key] of (["GH_TOKEN", "GITHUB_TOKEN"] as const).entries()) {
        const value = saved[i];
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});
