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
 * `Bun.serve()` stand-in. `git` and `gh` are on PATH as shims that record every call: `gh` answers
 * its version probe only, and `git` refuses a clone (so nothing can reach a real repository) and
 * runs every other call. A refusal shows as no clone, branch, commit or push in the record.
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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
];

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
  // git: every call recorded; one that reaches a remote refused, so nothing can reach a real
  // repository. The update case's clone names `nemarDatasets/<id>` on GitHub as its origin, and a
  // regression past the refusal used to push there: a mutation of the detail route showed it.
  writeFileSync(
    join(shims, "git"),
    `#!/bin/sh\nprintf 'git %s\\n' "$*" >> '${log}'\ncase "$1" in clone|fetch|pull|push|ls-remote) exit 128;; esac\nexec '${REAL_GIT}' "$@"\n`,
  );
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
