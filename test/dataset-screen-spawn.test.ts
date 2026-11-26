/**
 * `nemar dataset screen` through the real CLI entry point (card A9, issue #2184).
 *
 * A real subprocess (`bun run src/index.ts dataset screen ...`) against real git repositories,
 * with an environment built from nothing: an isolated config directory, an empty home, no
 * account, and a counting listener standing in as the HTTP and HTTPS proxy of the child. What is
 * asserted is what a person sees (help, output, exit status) and what the command did to the
 * machine: it changed no byte of the dataset or its `.git`, and it opened no connection.
 *
 * The listener has a positive control: a command that does go to the network (`dataset status`)
 * must reach it, so "zero connections" cannot pass because the counter is broken or the proxy
 * variables are ignored.
 *
 * Own file, because a spawned CLI is a process, not a pure unit.
 *
 * CI TIER: process. It spawns the CLI and git, and listens on a loopback port.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseScreenReport } from "../shared/identifier-screen-report";
import {
  CLEAN,
  NAME,
  Repo,
  cleanScratch,
  digestTree,
  git,
  named,
  recording,
  tempDir,
} from "./helpers/dataset-screen-fixture";
import { type EgressSpy, startEgressSpy } from "./helpers/egress-spy";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const DESCRIPTION = JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" });
const EDF = "sub-01/eeg/sub-01_task-rest_eeg.edf";

let spy: EgressSpy;
beforeAll(() => {
  spy = startEgressSpy();
});
afterEach(() => {
  spy.seen.length = 0;
});
afterAll(() => {
  spy.stop();
  cleanScratch();
});

/**
 * The child's environment, built from nothing: a PATH (git must be found), an empty home and
 * config directory, no account, no update check, and the spy as every proxy.
 */
function childEnv(options: ChildOptions = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: options.path ?? process.env.PATH ?? "",
    HOME: tempDir("home"),
    NEMAR_CONFIG_DIR: options.configDir ?? tempDir("config"),
    NO_COLOR: "1",
    ...spy.env,
  };
  if (options.updateCheck !== true) env.NEMAR_NO_UPDATE_CHECK = "1";
  return env;
}

interface ChildOptions {
  /** Leave the update check on (the child's default), as a person's machine has it. */
  updateCheck?: boolean;
  /** The config directory the child gets; a fresh empty one when absent. */
  configDir?: string;
  /** The child's PATH; this process's when absent. */
  path?: string;
}

async function nemar(args: string[], cwd = REPO_ROOT, options: ChildOptions = {}) {
  const proc = Bun.spawn([process.execPath, "run", CLI_ENTRY, ...args], {
    cwd,
    env: childEnv(options),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, out: `${stdout}\n${stderr}`, code: await proc.exited };
}

function dataset(patient: string, options: { unscreened?: boolean } = {}): Repo {
  const repo = new Repo("spawn");
  repo.file("dataset_description.json", DESCRIPTION).file(EDF, recording(patient));
  if (options.unscreened) repo.file("sub-01/eeg/sub-01_task-rest_eeg.cnt", "Version 3.0\n");
  repo.commit("data");
  return repo;
}

describe("help", () => {
  test("dataset --help lists the command, and its own help says what is and is not read", async () => {
    const list = await nemar(["dataset", "--help"]);
    expect(list.code).toBe(0);
    // One of the commands plain --help leads with, not folded into "More commands".
    expect(list.stdout).toMatch(/\n\s+screen \[options\] \[path\]\s+Screen a dataset/);
    const all = await nemar(["dataset", "--help-all"]);
    expect(all.stdout).toMatch(/screen \[options\] \[path\]\s+Screen a dataset for identifying/);

    const help = await nemar(["dataset", "screen", "--help"]);
    expect(help.code).toBe(0);
    for (const needed of [
      "--committed",
      "--json",
      "Read: the files in the directory",
      "Not read: the server's own copy",
      "'content-absent'",
      "Sends nothing and changes nothing",
    ]) {
      // The help wraps at the terminal's width: compare the words, not the line breaks.
      expect(help.stdout.replace(/\s+/g, " ")).toContain(needed);
    }
    // The longer text, with the exit codes and examples, is behind --help-all like every command's.
    const long = await nemar(["dataset", "screen", "--help-all"]);
    for (const needed of ["What is read:", "What is not read:", "Exit status:", "  3  direct"]) {
      expect(long.stdout).toContain(needed);
    }
  });
});

describe("exit status through the real entry point", () => {
  test("clean is 0, direct identifiers 3, a state a person must look at is 2", async () => {
    const clean = await nemar(["dataset", "screen", dataset(CLEAN).dir, "--committed"]);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain("Identifier screen: clean");

    const direct = await nemar(["dataset", "screen", dataset(named(1)).dir]);
    expect(direct.code).toBe(3);
    expect(direct.stdout).toContain("FOUND IDENTIFIERS");
    expect(direct.stdout).toContain("edf-patient-name x1");

    const partly = await nemar(["dataset", "screen", dataset(CLEAN, { unscreened: true }).dir]);
    expect(partly.code).toBe(2);
    // An answer is not a crash: no "attach the log to an issue" nudge after it.
    expect(partly.out).not.toContain("Run again with --debug");
    expect(direct.out).not.toContain("Run again with --debug");
  });

  test("a run that could not be made is 2 and says why, with no path in it", async () => {
    const plain = tempDir("plain");
    const result = await nemar(["dataset", "screen", plain, "--committed"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--committed needs the top level of a git repository");
    expect(result.out).not.toContain(plain);
  });

  test("a git that cannot start is an error with its cause, never a screen without history", async () => {
    const repo = dataset(named(1));
    const result = await nemar(["dataset", "screen", repo.dir], REPO_ROOT, {
      path: tempDir("nopath"),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("spawn-failed");
    expect(result.out).not.toContain("Identifier screen");
    expect(result.out).not.toContain(repo.dir);
  });

  test("the same holds for a plain directory: a git that fails is not 'no repository'", async () => {
    const plain = new Repo("plain", { git: false });
    plain.file(EDF, recording(named(1)));
    const result = await nemar(["dataset", "screen", plain.dir], REPO_ROOT, {
      path: tempDir("nopath"),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("spawn-failed");
    expect(result.out).not.toContain("Identifier screen");
  });

  test("the path is optional: it defaults to the current directory", async () => {
    const repo = dataset(named(1));
    const result = await nemar(["dataset", "screen"], repo.dir);
    expect(result.code).toBe(3);
  });

  test("--json prints the report alone on stdout, and it validates with the contract's parser", async () => {
    const repo = dataset(named(1), { unscreened: true });
    const result = await nemar(["dataset", "screen", repo.dir, "--committed", "--json"]);
    expect(result.code).toBe(3);
    const report = parseScreenReport(JSON.parse(result.stdout));
    expect(report.version).toBe(2);
    expect(report.scan?.status).toBe("direct-identifiers");
    expect(report.head).toBe(git(repo.dir, "rev-parse", "HEAD"));
    // What the run could not see goes to stderr, so a script's stdout stays a JSON document.
    expect(result.stderr).toContain("Not read here: the server's copy");
  });
});

describe("it changes nothing and sends nothing", () => {
  test("two runs leave every byte of the dataset and its .git as they were, and open no connection", async () => {
    const repo = dataset(named(1), { unscreened: true });
    repo.annexLink("sub-02/eeg/sub-02_task-rest_eeg.edf", recording(CLEAN));
    repo.annexLink("sub-03/eeg/sub-03_task-rest_eeg.edf", recording(CLEAN), { content: false });
    repo.commit("annexed");
    repo.file(EDF, recording(CLEAN)); // an uncommitted change
    const status = git(repo.dir, "status", "--porcelain");
    const tree = git(repo.dir, "rev-parse", "HEAD^{tree}");
    // `git status` refreshes the index; the digest is taken after it.
    const before = digestTree(repo.dir);

    for (const args of [
      ["dataset", "screen", repo.dir],
      ["dataset", "screen", repo.dir, "--committed"],
      ["dataset", "screen", repo.dir],
      ["dataset", "screen", repo.dir, "--committed", "--json"],
    ]) {
      const result = await nemar(args);
      // Real verdicts, not a refusal to run: the checks below would pass on a command that did
      // nothing.
      expect([2, 3]).toContain(result.code);
      expect(result.out).toContain("Identifier screen: ");
    }

    expect(digestTree(repo.dir)).toBe(before);
    expect(git(repo.dir, "status", "--porcelain")).toBe(status);
    expect(git(repo.dir, "rev-parse", "HEAD^{tree}")).toBe(tree);
    // Zero connections, to anywhere: not a notices request, not a version check, not a login.
    expect(spy.seen).toEqual([]);
  });

  test("a directory that is not a repository is left alone too", async () => {
    const plain = new Repo("plain", { git: false });
    plain.file("dataset_description.json", DESCRIPTION).file(EDF, recording(named(1)));
    const before = digestTree(plain.dir);
    const result = await nemar(["dataset", "screen", plain.dir]);
    expect(result.code).toBe(3);
    expect(digestTree(plain.dir)).toBe(before);
    expect(spy.seen).toEqual([]);
  });

  test("with the update check ON and an empty config directory: no connection, and nothing written", async () => {
    const repo = dataset(named(1), { unscreened: true });
    for (const args of [
      ["dataset", "screen", repo.dir],
      ["dataset", "screen", repo.dir, "--committed", "--json"],
      ["dataset", "screen", "--help"],
    ]) {
      const configDir = tempDir("config-empty");
      const result = await nemar(args, REPO_ROOT, { updateCheck: true, configDir });
      expect([0, 2, 3]).toContain(result.code);
      // The update check's request, its cache and its background refresh would each show here.
      expect(spy.seen).toEqual([]);
      expect(readdirSync(configDir)).toEqual([]);
    }
  });

  test("positive control: with the update check on, a command that is not local-only reaches the counter", async () => {
    // Without this, the test above could pass because the update check never runs in a child.
    const result = await nemar(["dataset", "validate", "--help"], REPO_ROOT, { updateCheck: true });
    expect(result.code).toBe(0);
    expect(spy.seen.length).toBeGreaterThan(0);
  });

  test("positive control: a command that does use the network reaches the counter", async () => {
    // Without this, "no connection" could mean the proxy variables are ignored.
    const result = await nemar(["dataset", "status", "nm000104"]);
    expect(result.code).not.toBe(0);
    expect(spy.seen.some((line) => line.startsWith("CONNECT api.nemar.org:443"))).toBe(true);
  });
});

describe("what a run prints", () => {
  test("counts and fixed words only: no value from a header, no path", async () => {
    const repo = new Repo("private");
    repo.file(`sub-${NAME}/eeg/sub-${NAME}_task-rest_eeg.edf`, recording(named(1)));
    repo.file("dataset_description.json", DESCRIPTION).commit("data");
    const result = await nemar(["dataset", "screen", repo.dir]);
    expect(result.code).toBe(3);
    expect(result.out).not.toContain(NAME);
    expect(result.out).not.toContain(repo.dir);
    expect(result.out).not.toContain("sub-Quill");
    // The banner says what was read and what was not.
    expect(result.stdout).toContain("Local identifier screen of the working tree");
    expect(result.stdout).toContain("Nothing was sent and nothing was changed");
    expect(result.stdout).toContain("Not read here: the server's copy");
  });
});
