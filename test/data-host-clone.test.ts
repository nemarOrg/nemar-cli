/**
 * The pieces of `nemar dataset clone` and `nemar dataset get` that read from an authenticated
 * NEMAR data host (src/lib/data-host-clone.ts, ADR 0114), against real HTTP servers on
 * loopback and real git repositories. The full clone with git-annex is
 * test/data-host-e2e.test.ts.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialHelperError,
  credentialHelperCommand,
  dataHostCloneUrl,
  declaresNemarRemote,
  detectDataHostClone,
  findDatasetOnDataHosts,
  specialRemoteOnPath,
} from "../src/lib/data-host-clone";
import { type VettedOrigin, allowedDataHosts } from "../src/lib/data-hosts";
import { DataHostStandin } from "./helpers/data-host-standin";
import { cliBaseEnv, fakeApiKey, makeConfigDir } from "./helpers/nemar-account";

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

  /** The list holds exactly these origins (never the real default host), as the CLI builds it. */
  function listing(origins: string[], extraEnv: Record<string, string> = {}) {
    const options = {
      env: { NEMAR_DATA_HOSTS: origins.join(","), NEMAR_DATA_HOSTS_ONLY: "1", ...extraEnv },
      isDevBuild: false,
    };
    return { origins: allowedDataHosts(options), options };
  }
  const lookup = (origins: string[], extraEnv: Record<string, string> = {}) => {
    const { origins: vetted, options } = listing(origins, extraEnv);
    return findDatasetOnDataHosts(DATASET, API_KEY, vetted, options);
  };

  test("the first host that answers 200 wins, and carries the dataset's name", async () => {
    const a = standin();
    const found = await lookup([a.origin]);
    expect(found.found).toEqual({ origin: a.origin, name: "Fixture dataset" });
    expect(a.dataSeen).toEqual([
      { method: "GET", path: `/api/datasets/${DATASET}`, authorization: `Bearer ${API_KEY}` },
    ]);
  });

  test("a 404 is not-here and the next host is asked, in order, until one has it", async () => {
    const empty = standin("np000001");
    const has = standin();
    const later = standin();
    const found = await lookup([empty.origin, has.origin, later.origin]);
    expect(found.found?.origin).toBe(has.origin);
    expect(empty.dataSeen).toHaveLength(1);
    expect(has.dataSeen).toHaveLength(1);
    // The search stops at the first hit: a later host is never sent the key.
    expect(later.dataSeen).toEqual([]);
  });

  test("a refused key is reported as refused, not as missing", async () => {
    const a = standin(DATASET, fakeApiKey());
    expect(await lookup([a.origin])).toEqual({ found: null, refused: [a.origin], unreachable: [] });
  });

  test("a host that is down is unreachable, with the error's code and not its address", async () => {
    const down = standin();
    const origin = down.origin;
    down.stop();
    const result = await lookup([origin]);
    expect(result.found).toBeNull();
    expect(result.unreachable).toHaveLength(1);
    expect(result.unreachable[0].origin).toBe(origin);
    expect(result.unreachable[0].detail).toMatch(/ECONNREFUSED/);
    expect(result.unreachable[0].detail).not.toContain(origin);
  });

  test("a host that accepts and never answers times out, and the timeout can only be shortened", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    try {
      const origin = `http://127.0.0.1:${listener.port}`;
      const started = performance.now();
      const result = await lookup([origin], { NEMAR_DATA_HOST_TIMEOUT_MS: "300" });
      expect(result.unreachable).toEqual([{ origin, detail: "TimeoutError" }]);
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      listener.stop(true);
    }
  });

  test("a 5xx answer is unreachable, with its status", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("down", { status: 503 }),
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      expect((await lookup([origin])).unreachable).toEqual([{ origin, detail: "status 503" }]);
    } finally {
      server.stop(true);
    }
  });

  test("a 200 that is not this dataset is not a hit", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ ok: true, dataset: { id: "np000007", name: "Another" } }),
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const result = await lookup([origin]);
      expect(result.found).toBeNull();
      expect(result.unreachable.map((u) => u.origin)).toEqual([origin]);
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
      const result = await lookup([`http://127.0.0.1:${redirecting.port}`]);
      expect(result.found).toBeNull();
      expect(target.dataSeen).toEqual([]);
    } finally {
      redirecting.stop(true);
    }
  });

  test("an origin the list does not have is refused with an error, and gets no request", async () => {
    const a = standin();
    // Typed as a vetted origin by a caller that skipped the vetting.
    const forged = [a.origin as VettedOrigin];
    await expect(
      findDatasetOnDataHosts(DATASET, API_KEY, forged, { env: {}, isDevBuild: false }),
    ).rejects.toThrow("not on the data host list");
    expect(a.dataSeen).toEqual([]);
  });
});

describe("credentialHelperCommand", () => {
  test("NEMAR_CREDENTIAL_HELPER names the program; the arguments are still added", () => {
    expect(credentialHelperCommand({ NEMAR_CREDENTIAL_HELPER: "my-nemar" })).toBe(
      "!my-nemar auth git-credential",
    );
    const dir = mkdtempSync(join(tmpdir(), "nemar-helper-abs-"));
    try {
      const program = join(dir, "nemar with space");
      writeFileSync(program, "#!/bin/sh\n");
      chmodSync(program, 0o755);
      expect(credentialHelperCommand({ NEMAR_CREDENTIAL_HELPER: program })).toBe(
        `!'${program}' auth git-credential`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("anything else is refused: a command line, a relative path, a missing or plain file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-helper-bad-"));
    try {
      const plain = join(dir, "not-executable");
      writeFileSync(plain, "x");
      chmodSync(plain, 0o644);
      for (const value of [
        "nemar auth git-credential",
        "!nemar",
        "./nemar",
        "bin/nemar",
        "../nemar",
        "nemar;rm",
        "$(id)",
        "a`b`",
        "x'y",
        join(dir, "missing"),
        plain,
        dir,
      ]) {
        expect(() => credentialHelperCommand({ NEMAR_CREDENTIAL_HELPER: value })).toThrow(
          CredentialHelperError,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nemar on the PATH it is given is named by its bare name, so the config survives a reinstall", () => {
    const bin = mkdtempSync(join(tmpdir(), "nemar-which-"));
    try {
      writeFileSync(join(bin, "nemar"), "#!/bin/sh\n");
      chmodSync(join(bin, "nemar"), 0o755);
      expect(credentialHelperCommand({ PATH: `${bin}:/usr/bin:/bin` })).toBe(
        "!nemar auth git-credential",
      );
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("the lookup uses the PATH it is given and not the machine's", () => {
    const empty = mkdtempSync(join(tmpdir(), "nemar-no-nemar-"));
    try {
      // A PATH with no nemar in it: the answer is the running program's own path, whatever
      // this machine has installed.
      expect(credentialHelperCommand({ PATH: empty })).not.toBe("!nemar auth git-credential");
    } finally {
      rmSync(empty, { recursive: true, force: true });
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

describe("specialRemoteOnPath", () => {
  test("looks in the PATH it is given", () => {
    const bin = mkdtempSync(join(tmpdir(), "nemar-remote-path-"));
    try {
      expect(specialRemoteOnPath({ PATH: bin })).toBe(false);
      writeFileSync(join(bin, "git-annex-remote-nemar"), "#!/bin/sh\n");
      chmodSync(join(bin, "git-annex-remote-nemar"), 0o755);
      expect(specialRemoteOnPath({ PATH: bin })).toBe(true);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("repositories", () => {
  let root: string;
  const gitEnv = {
    ...cliBaseEnv(),
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
