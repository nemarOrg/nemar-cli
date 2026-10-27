/**
 * The pieces of `nemar dataset clone` and `nemar dataset get` that read from an authenticated
 * NEMAR data host (src/lib/data-host-clone.ts, ADR 0114), against real HTTP servers on
 * loopback and real git repositories. The full clone with git-annex is
 * test/data-host-e2e.test.ts.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialHelperCommand,
  dataHostCloneUrl,
  declaresNemarRemote,
  detectDataHostClone,
  findDatasetOnDataHosts,
} from "../src/lib/data-host-clone";
import { DataHostStandin } from "./helpers/data-host-standin";
import { fakeApiKey, makeConfigDir } from "./helpers/nemar-account";

// CLI and git-annex children: a slow runner needs more than the default 5 seconds.
setDefaultTimeout(60_000);

const API_KEY = fakeApiKey();
const DATASET = "np099999";

describe("findDatasetOnDataHosts", () => {
  const stand: DataHostStandin[] = [];
  function standin(datasetId = DATASET, apiKey = API_KEY): DataHostStandin {
    const s = new DataHostStandin({ apiKey, datasetId });
    stand.push(s);
    return s;
  }
  afterAll(() => {
    for (const s of stand) s.stop();
  });

  test("the first host that answers 200 wins, and carries the dataset's name", async () => {
    const a = standin();
    const found = await findDatasetOnDataHosts(DATASET, API_KEY, [a.origin]);
    expect(found.found).toEqual({ origin: a.origin, name: "Fixture dataset" });
    expect(a.dataSeen).toEqual([
      { method: "GET", path: `/api/datasets/${DATASET}`, authorization: `Bearer ${API_KEY}` },
    ]);
  });

  test("a 404 is not-here and the next host is asked, in order, until one has it", async () => {
    const empty = standin("np000001");
    const has = standin();
    const later = standin();
    const lookup = await findDatasetOnDataHosts(DATASET, API_KEY, [
      empty.origin,
      has.origin,
      later.origin,
    ]);
    expect(lookup.found?.origin).toBe(has.origin);
    expect(empty.dataSeen).toHaveLength(1);
    expect(has.dataSeen).toHaveLength(1);
    // The search stops at the first hit: a later host is never sent the key.
    expect(later.dataSeen).toEqual([]);
  });

  test("a refused key is reported as refused, not as missing", async () => {
    const a = standin(DATASET, fakeApiKey());
    const lookup = await findDatasetOnDataHosts(DATASET, API_KEY, [a.origin]);
    expect(lookup).toEqual({ found: null, refused: [a.origin], unreachable: [] });
  });

  test("a host that is down is reported as unreachable", async () => {
    const down = standin();
    const origin = down.origin;
    down.stop();
    const lookup = await findDatasetOnDataHosts(DATASET, API_KEY, [origin]);
    expect(lookup).toEqual({ found: null, refused: [], unreachable: [origin] });
  });

  test("a 200 that is not this dataset is not a hit", async () => {
    // The stand-in only answers its own dataset id; ask it for another id with a 200 body for
    // the wrong dataset by putting the other id in the path of a custom server.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ ok: true, dataset: { id: "np000007", name: "Another" } }),
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const lookup = await findDatasetOnDataHosts(DATASET, API_KEY, [origin]);
      expect(lookup.found).toBeNull();
      expect(lookup.unreachable).toEqual([origin]);
    } finally {
      server.stop(true);
    }
  });

  test("a redirect is never followed with the key: the target sees nothing", async () => {
    const target = standin();
    const redirecting = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { Location: `${target.origin}/api/datasets/${DATASET}` },
        }),
    });
    try {
      const origin = `http://127.0.0.1:${redirecting.port}`;
      const lookup = await findDatasetOnDataHosts(DATASET, API_KEY, [origin]);
      expect(lookup.found).toBeNull();
      expect(target.dataSeen).toEqual([]);
    } finally {
      redirecting.stop(true);
    }
  });
});

describe("credentialHelperCommand", () => {
  test("an override is used as written, with the leading ! git needs", () => {
    expect(
      credentialHelperCommand({ NEMAR_CREDENTIAL_HELPER: "my-nemar auth git-credential" }),
    ).toBe("!my-nemar auth git-credential");
    expect(credentialHelperCommand({ NEMAR_CREDENTIAL_HELPER: "!x y" })).toBe("!x y");
  });

  test("nemar on PATH is named by its bare name, so the config survives a reinstall", () => {
    const bin = mkdtempSync(join(tmpdir(), "nemar-which-"));
    const previous = process.env.PATH;
    try {
      writeFileSync(join(bin, "nemar"), "#!/bin/sh\n");
      Bun.spawnSync(["chmod", "+x", join(bin, "nemar")]);
      process.env.PATH = `${bin}:${previous}`;
      expect(credentialHelperCommand({})).toBe("!nemar auth git-credential");
    } finally {
      process.env.PATH = previous;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("without nemar on PATH it names the running program, quoted", () => {
    // Run as a script, as the CLI is: argv[1] is then the program's own path.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nemar-helper-cmd-")));
    try {
      const script = join(dir, "print-helper.ts");
      const module = join(import.meta.dir, "..", "src", "lib", "data-host-clone");
      writeFileSync(
        script,
        `import { credentialHelperCommand } from ${JSON.stringify(module)};\nconsole.log(credentialHelperCommand({}));\n`,
      );
      const done = Bun.spawnSync([process.execPath, script], {
        env: { PATH: "/nonexistent", HOME: dir },
      });
      const command = done.stdout.toString().trim();
      expect(command).toBe(`!'${process.execPath}' '${script}' auth git-credential`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("repositories", () => {
  let root: string;
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  } as Record<string, string>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nemar-detect-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function repo(name: string, origin?: string, config: [string, string][] = []): string {
    const dir = join(root, name);
    const git = (...args: string[]) => {
      const done = Bun.spawnSync(["git", ...args], { cwd: dir, env: gitEnv });
      if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    };
    Bun.spawnSync(["git", "init", "-q", dir], { env: gitEnv });
    if (origin) git("remote", "add", "origin", origin);
    for (const [key, value] of config) git("config", key, value);
    return dir;
  }

  const production = { env: {}, isDevBuild: false };

  test("a clone of an allowed data host's repository is recognized, with its dataset id", async () => {
    const dir = repo("allowed", dataHostCloneUrl("https://private.nemar.org", DATASET));
    expect(await detectDataHostClone(dir, production)).toEqual({
      origin: "https://private.nemar.org",
      datasetId: DATASET,
    });
  });

  test("a trailing slash and a loopback test host are recognized", async () => {
    const env = { NEMAR_DATA_HOSTS: "http://127.0.0.1:4455" };
    const dir = repo("local", "http://127.0.0.1:4455/git/np000001.git/");
    expect(await detectDataHostClone(dir, { env, isDevBuild: false })).toEqual({
      origin: "http://127.0.0.1:4455",
      datasetId: "np000001",
    });
  });

  test("every other origin is not a data host clone", async () => {
    const cases: [string, string | undefined][] = [
      ["github", "https://github.com/nemarDatasets/nm000104.git"],
      ["ssh", "git@github.com:nemarDatasets/nm000104.git"],
      ["lookalike", "https://private.nemar.org.evil.example/git/np099999.git"],
      ["wrong-host", "https://evil.example/git/np099999.git"],
      ["http", "http://private.nemar.org/git/np099999.git"],
      ["userinfo", "https://user:pw@private.nemar.org/git/np099999.git"],
      ["not-a-dataset-path", "https://private.nemar.org/git/anything.git"],
      ["wrong-prefix-path", "https://private.nemar.org/other/np099999.git"],
      ["deeper-path", "https://private.nemar.org/git/np099999.git/extra"],
      ["no-origin", undefined],
    ];
    for (const [name, url] of cases) {
      const dir = repo(`not-${name}`, url);
      expect([name, await detectDataHostClone(dir, production)]).toEqual([name, null]);
    }
  });

  test("a directory that is not a repository is not a data host clone", async () => {
    expect(await detectDataHostClone(root, production)).toBeNull();
  });

  test("declaresNemarRemote reads the externaltype git-annex wrote for an enabled remote", async () => {
    const withNemar = repo("declares", undefined, [
      ["remote.nemar.annex-externaltype", "nemar"],
      ["remote.nemar.annex-uuid", "00000000-0000-0000-0000-0000000000aa"],
    ]);
    expect(await declaresNemarRemote(withNemar)).toBe(true);
    const other = repo("other-type", undefined, [["remote.other.annex-externaltype", "rclone"]]);
    expect(await declaresNemarRemote(other)).toBe(false);
    expect(await declaresNemarRemote(repo("plain"))).toBe(false);
  });
});

describe("nemar dataset get in a clone from a data host", () => {
  const CLI = join(import.meta.dir, "..", "src", "index.ts");
  const haveAnnex = Bun.spawnSync(["git", "annex", "version", "--raw"]).exitCode === 0;
  let root: string;
  let signedIn: string;
  let signedOut: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nemar-get-"));
    signedIn = makeConfigDir(API_KEY);
    signedOut = makeConfigDir(null);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(signedIn, { recursive: true, force: true });
    rmSync(signedOut, { recursive: true, force: true });
  });

  async function getIn(config: string, name: string, env: Record<string, string> = {}) {
    const dir = join(root, name);
    const base = {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.org",
      NEMAR_CONFIG_DIR: config,
      NEMAR_NO_UPDATE_CHECK: "1",
      ...env,
    };
    for (const cmd of [
      ["git", "init", "-q", dir],
      [
        "git",
        "-C",
        dir,
        "remote",
        "add",
        "origin",
        dataHostCloneUrl("https://private.nemar.org", DATASET),
      ],
      ["git", "-C", dir, "annex", "init", "fixture"],
    ]) {
      const done = Bun.spawnSync(cmd, { env: base });
      if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    }
    const proc = Bun.spawn(["bun", "run", CLI, "dataset", "get"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: base,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { out: stdout + stderr, code: await proc.exited };
  }

  test.skipIf(!haveAnnex)("signed out, it says to sign in and goes no further", async () => {
    const result = await getIn(signedOut, "signed-out");
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("nemar auth login");
  });

  test.skipIf(!haveAnnex)("signed in but with no data remote declared, it says so", async () => {
    const result = await getIn(signedIn, "no-remote");
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("declares no data remote");
  });
});
