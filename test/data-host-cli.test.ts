/**
 * The wiring of `nemar dataset clone` and `nemar dataset get` around authenticated data hosts
 * (ADR 0114), run as the CLI runs: a child process with a stored account, a stand-in for the
 * main service and a stand-in data host, both real HTTP servers on loopback. The full clone
 * with git-annex is test/data-host-e2e.test.ts.
 *
 * Every spawned process goes through a recording proxy (test/helpers/egress-spy.ts), and the
 * suite ends by asserting that nothing asked for a host outside this machine.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataHostStandin } from "./helpers/data-host-standin";
import { type EgressSpy, startEgressSpy } from "./helpers/egress-spy";
import { gitAnnexGate } from "./helpers/git-annex-gate";
import { cliBaseEnv, fakeApiKey, makeConfigDir } from "./helpers/nemar-account";

// CLI children and git-annex: a slow runner needs more than the default 5 seconds.
setDefaultTimeout(60_000);

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const DATASET = "np099999";
const API_KEY = fakeApiKey();

const CAN_RUN = gitAnnexGate("test/data-host-cli.test.ts") && Bun.which("gh") !== null;

describe("the git-annex gate", () => {
  test("a missing git-annex skips locally and fails in CI", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(gitAnnexGate("a suite", { have: false, ci: undefined })).toBe(false);
      expect(gitAnnexGate("a suite", { have: false, ci: "" })).toBe(false);
      expect(gitAnnexGate("a suite", { have: false, ci: "false" })).toBe(false);
      expect(() => gitAnnexGate("a suite", { have: false, ci: "true" })).toThrow("CI is set");
      expect(() => gitAnnexGate("a suite", { have: false, ci: "1" })).toThrow("CI is set");
      expect(gitAnnexGate("a suite", { have: true, ci: "true" })).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});

describe.skipIf(!CAN_RUN)("dataset clone and dataset get around a data host", () => {
  let root: string;
  let spy: EgressSpy;
  let host: DataHostStandin;
  let served: DataHostStandin;
  let api: ReturnType<typeof Bun.serve>;
  let apiMode: "404" | "500" | "known";
  let apiPaths: string[];
  let signedIn: string;
  let signedOut: string;
  let apiDown: string;
  let tools: string;
  const SYSTEM_PATH = "/usr/bin:/bin";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "nemar-cli-wiring-"));
    spy = startEgressSpy();
    apiMode = "404";
    apiPaths = [];
    api = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        apiPaths.push(path);
        if (!path.startsWith("/datasets/")) {
          return new Response('{"notices":[]}', {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (apiMode === "500") return Response.json({ error: "boom" }, { status: 500 });
        if (apiMode === "known") {
          // A dataset the main service holds, with no GitHub repository, so a clone stops
          // before it would reach out.
          return Response.json({
            dataset: { name: "Known here", github_repo: "", visibility: "public" },
          });
        }
        return Response.json({ error: "Dataset not found" }, { status: 404 });
      },
    });
    const apiUrl = `http://127.0.0.1:${api.port}`;
    signedIn = makeConfigDir(API_KEY, apiUrl);
    signedOut = makeConfigDir(null, apiUrl);
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const closedUrl = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    apiDown = makeConfigDir(API_KEY, closedUrl);

    host = new DataHostStandin({ apiKey: API_KEY, datasetId: DATASET });

    // A tiny real repository the second stand-in serves over smart HTTP.
    const gitRoot = join(root, "git-root");
    mkdirSync(gitRoot);
    const source = join(root, "source");
    const identity = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.org",
    };
    for (const cmd of [
      ["git", "init", "-q", source],
      ["git", "-C", source, "commit", "-q", "--allow-empty", "-m", "x"],
      ["git", "clone", "-q", "--bare", source, join(gitRoot, `${DATASET}.git`)],
    ]) {
      const proc = Bun.spawn(cmd, { env: { ...cliBaseEnv(), ...identity }, stderr: "pipe" });
      await proc.exited;
    }
    served = new DataHostStandin({ apiKey: API_KEY, datasetId: DATASET, gitRoot });

    // The few programs a run with a restricted PATH may use.
    // Plus the system directories: git-annex itself runs `security` on macOS, for one.
    tools = join(root, "tools");
    mkdirSync(tools);
    for (const name of ["git", "git-annex", "gh"]) {
      const found = Bun.which(name);
      if (found) symlinkSync(found, join(tools, name));
    }
  }, 60_000);

  afterAll(() => {
    expect(spy?.seen).toEqual([]);
    spy?.stop();
    host?.stop();
    served?.stop();
    api?.stop(true);
    for (const dir of [signedIn, signedOut, apiDown]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function env(config: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...cliBaseEnv(),
      ...spy.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.org",
      NEMAR_CONFIG_DIR: config,
      NEMAR_DATA_HOSTS: host.origin,
      NEMAR_DATA_HOSTS_ONLY: "1",
      NEMAR_NO_UPDATE_CHECK: "1",
      ...extra,
    };
  }

  async function nemar(
    args: string[],
    config: string,
    options: { cwd?: string; extra?: Record<string, string> } = {},
  ): Promise<{ out: string; code: number }> {
    const proc = Bun.spawn([process.execPath, "run", CLI, ...args], {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: env(config, options.extra),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { out: `${stdout}\n${stderr}`, code: await proc.exited };
  }

  async function plain(cmd: string[], cwd?: string): Promise<void> {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env(signedIn) });
    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${stderr}`);
  }

  /** A git-annex repository whose origin is a data host's repository URL. */
  async function dataHostRepo(name: string, declared: boolean): Promise<string> {
    const dir = join(root, name);
    await plain(["git", "init", "-q", dir]);
    await plain(["git", "-C", dir, "remote", "add", "origin", `${host.origin}/git/${DATASET}.git`]);
    await plain(["git", "-C", dir, "annex", "init", "fixture"]);
    if (declared)
      await plain(["git", "-C", dir, "config", "remote.nemar.annex-externaltype", "nemar"]);
    return dir;
  }

  test("positive control: a request to an outside host reaches the spy", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        'await fetch("https://example.invalid/x").catch(() => {}); await fetch("http://example.invalid/y").catch(() => {});',
      ],
      { env: { ...cliBaseEnv(), ...spy.env }, stdout: "pipe", stderr: "pipe" },
    );
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const lines = spy.seen.splice(0);
    expect(lines.some((l) => l.startsWith("CONNECT example.invalid:443"))).toBe(true);
    expect(lines.some((l) => l.includes("http://example.invalid/y"))).toBe(true);
  });

  describe("clone", () => {
    test("signed out, an id the main service does not know is not looked up on a data host", async () => {
      const before = host.dataSeen.length;
      apiMode = "404";
      const result = await nemar(["dataset", "clone", DATASET, "-o", join(root, "so")], signedOut);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("not found");
      expect(host.dataSeen.length).toBe(before);
      expect(existsSync(join(root, "so"))).toBe(false);
    });

    test("--host signed out stops before any request and says to sign in", async () => {
      const before = host.dataSeen.length;
      const result = await nemar(
        ["dataset", "clone", DATASET, "--host", host.origin, "-o", join(root, "so2")],
        signedOut,
      );
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("needs your NEMAR API key");
      expect(result.out).toContain("nemar auth login");
      expect(host.dataSeen.length).toBe(before);
    });

    test("when the main service fails, no data host is asked, and the output says so", async () => {
      const before = host.dataSeen.length;
      apiMode = "500";
      const failed = await nemar(["dataset", "clone", DATASET, "-o", join(root, "f500")], signedIn);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain("Data hosts were not asked");
      const unreachable = await nemar(
        ["dataset", "clone", DATASET, "-o", join(root, "fdown")],
        apiDown,
      );
      expect(unreachable.code).not.toBe(0);
      expect(unreachable.out).toContain("Data hosts were not asked");
      expect(host.dataSeen.length).toBe(before);
      apiMode = "404";
    });

    test("an id the main service knows is never looked up on a data host", async () => {
      const before = host.dataSeen.length;
      apiMode = "known";
      const result = await nemar(
        ["dataset", "clone", DATASET, "-o", join(root, "known")],
        signedIn,
      );
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("no valid GitHub repository");
      expect(host.dataSeen.length).toBe(before);
      apiMode = "404";
    });

    test("an existing output path stops the clone after the lookup and before any git request", async () => {
      const existing = join(root, "already-here");
      mkdirSync(existing);
      const before = host.dataSeen.length;
      const result = await nemar(
        ["dataset", "clone", DATASET, "--host", host.origin, "-o", existing],
        signedIn,
      );
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("Path already exists");
      const requests = host.dataSeen.slice(before);
      expect(requests.map((r) => r.path)).toEqual([`/api/datasets/${DATASET}`]);
    });

    test("a NEMAR_DATA_HOSTS entry that is not an origin is reported and ignored", async () => {
      const result = await nemar(
        ["dataset", "clone", "np000001", "--host", host.origin, "-o", join(root, "ignored")],
        signedIn,
        { extra: { NEMAR_DATA_HOSTS: `http://not-loopback.example,${host.origin}` } },
      );
      expect(result.out).toContain("Ignoring NEMAR_DATA_HOSTS entry http://not-loopback.example");
    });

    test("a refused NEMAR_CREDENTIAL_HELPER stops the clone before git runs", async () => {
      const before = served.dataSeen.length;
      const result = await nemar(
        ["dataset", "clone", DATASET, "--host", served.origin, "-o", join(root, "bad-helper")],
        signedIn,
        { extra: { NEMAR_DATA_HOSTS: served.origin, NEMAR_CREDENTIAL_HELPER: "nemar; rm -rf /" } },
      );
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("NEMAR_CREDENTIAL_HELPER");
      expect(existsSync(join(root, "bad-helper"))).toBe(false);
      expect(served.dataSeen.slice(before).map((r) => r.path)).toEqual([
        `/api/datasets/${DATASET}`,
      ]);
    });

    describe("with an absolute helper and a PATH that has no remote program", () => {
      function helperShim(): string {
        const shim = join(root, "helper-shim");
        writeFileSync(
          shim,
          `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(CLI)} "$@"\n`,
        );
        chmodSync(shim, 0o755);
        return shim;
      }

      test("the clone works and says git-annex could not enable the data remote", async () => {
        const result = await nemar(
          ["dataset", "clone", DATASET, "--host", served.origin, "-o", join(root, "no-path")],
          signedIn,
          {
            extra: {
              NEMAR_DATA_HOSTS: served.origin,
              NEMAR_CREDENTIAL_HELPER: helperShim(),
              PATH: `${tools}:${SYSTEM_PATH}`,
            },
          },
        );
        expect(result.code).toBe(0);
        expect(result.out).toContain("git-annex-remote-nemar is not on your PATH");
      });

      test("with the program on PATH and none declared, it says the dataset declares none", async () => {
        const bin = join(root, "remote-bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "git-annex-remote-nemar"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, "git-annex-remote-nemar"), 0o755);
        const result = await nemar(
          ["dataset", "clone", DATASET, "--host", served.origin, "-o", join(root, "with-path")],
          signedIn,
          {
            extra: {
              NEMAR_DATA_HOSTS: served.origin,
              NEMAR_CREDENTIAL_HELPER: helperShim(),
              PATH: `${bin}:${tools}:${SYSTEM_PATH}`,
            },
          },
        );
        expect(result.code).toBe(0);
        expect(result.out).toContain("does not declare a data remote");
      });
    });
  });

  describe("get", () => {
    test("signed out, it says to sign in and goes no further", async () => {
      const dir = await dataHostRepo("get-signed-out", true);
      const result = await nemar(["dataset", "get"], signedOut, { cwd: dir });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("nemar auth login");
    });

    test("with no data remote declared it says so", async () => {
      const dir = await dataHostRepo("get-undeclared", false);
      const result = await nemar(["dataset", "get"], signedIn, { cwd: dir });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("declares no data remote");
    });

    test("with the remote declared but git-annex-remote-nemar not on PATH it stops and says so", async () => {
      const dir = await dataHostRepo("get-no-program", true);
      const result = await nemar(["dataset", "get"], signedIn, {
        cwd: dir,
        extra: { PATH: `${tools}:${SYSTEM_PATH}` },
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("git-annex-remote-nemar is not on your PATH");
    });
  });
});
