/**
 * `nemar admin rework annex normalize` is a dry run unless `--apply` is given (ADR 0135, the
 * admin tree restructure). Driven through the real entry point against a local fixture: a bare
 * "origin" and a clone of it in the `--dir` the command reuses, so nothing is cloned from GitHub,
 * and a recording Bun.serve stand-in as the account's stored apiUrl. The clone carries an
 * inherited `annex.largefiles` rule, so the plan is never "nothing to do" and the run reaches the
 * point where the default decides whether to stop.
 *
 * Every run passes `--no`, which declines the confirmation that only a writing run asks for, so
 * no run here commits, uploads or pushes whatever the terminal: a run that got past the dry-run
 * stop shows as "Declined.".
 *
 * CI TIER: unit-pure. Hermetic: git on local paths, and the CLI spawned with an environment
 * built from nothing.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { startIsolatedCli } from "./helpers/isolated-cli";

setDefaultTimeout(60_000);

const DATASET = "xx099901";
const cli = startIsolatedCli();
let root: string;
let workDir: string;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.org",
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nemar-annex-normalize-"));
  const origin = join(root, "origin", `${DATASET}.git`);
  const seed = join(root, "seed");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "init", "-b", "main", seed);
  writeFileSync(join(seed, ".gitattributes"), "* annex.largefiles=nothing\n");
  writeFileSync(join(seed, "dataset_description.json"), '{"Name": "fixture"}\n');
  git(seed, "add", ".");
  git(seed, "commit", "-m", "seed");
  git(seed, "push", origin, "main");
  workDir = join(root, "work");
  git(root, "clone", "-b", "main", origin, join(workDir, DATASET));
  // What the command's own clone step does after cloning: the plan reads the annex.
  git(join(workDir, DATASET), "annex", "init", "fixture");
});

afterAll(() => {
  cli.stop();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => cli.reset());

const normalize = (...extra: string[]) =>
  cli.run(["admin", "rework", "annex", "normalize", DATASET, "--dir", workDir, ...extra]);

describe("admin rework annex normalize", () => {
  test("without --apply it plans, stops before any change, and asks nothing", async () => {
    const r = await normalize("--no");
    expect(r.stdout).toContain(`Plan for ${DATASET}`);
    expect(r.stdout).toContain("Dry run: stopping before any change. Re-run with --apply");
    expect(r.stdout).not.toContain("Declined.");
    expect(r.exitCode).toBe(0);
    expect(cli.requests).toEqual([]);
  });

  test("the old --dry-run spelling is still a dry run", async () => {
    const r = await normalize("--dry-run", "--no");
    expect(r.stdout).toContain("Dry run: stopping before any change.");
    expect(r.stdout).not.toContain("Declined.");
  });

  test("--apply goes past the plan to the confirmation (declined by --no)", async () => {
    const r = await normalize("--apply", "--no");
    expect(r.stdout).toContain(`Plan for ${DATASET}`);
    expect(r.stdout).not.toContain("Dry run: stopping");
    expect(r.stdout).toContain("Declined.");
    expect(cli.requests).toEqual([]);
  });

  test("--apply with --dry-run is refused before the clone is touched", async () => {
    const r = await normalize("--apply", "--dry-run");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("pass --apply or --dry-run, not both");
    expect(r.stdout).not.toContain("Plan for");
  });

  test("help names --apply and hides --dry-run", async () => {
    const r = await cli.run(["admin", "rework", "annex", "normalize", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).not.toContain("--dry-run");
  });
});
