/**
 * End to end, with real git and real git-annex: a dataset on an authenticated NEMAR data host
 * is cloned with `nemar dataset clone --host`, its data files are fetched with
 * `nemar dataset get` through the `git-annex-remote-nemar` special remote, and `git annex fsck`
 * passes (ADR 0114).
 *
 * The data host is a local stand-in (test/helpers/data-host-standin.ts): real HTTP on loopback,
 * smart-HTTP git served by `git http-backend` behind Basic authentication, objects behind a
 * Bearer key, and a second origin that large objects redirect to and that refuses any request
 * carrying `Authorization`. Nothing here reaches a real NEMAR host.
 *
 * What is asserted is where the API key went: to the data host, as Basic for git and as Bearer
 * for objects; never to the second origin; never to a foreign host named by a URL that a
 * writer registered in the repository; never into the clone's config; and never to git's own
 * credential store, which the clone's configuration resets for the data host.
 *
 * Skipped, loudly, when git-annex is not installed, and a failure when `CI` is set (CI's unit-pure
 * job installs it).
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
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
import { join } from "node:path";
import { DataHostStandin, patternBytes } from "./helpers/data-host-standin";
import { type EgressSpy, startEgressSpy } from "./helpers/egress-spy";
import { gitAnnexGate } from "./helpers/git-annex-gate";
import { cliBaseEnv, fakeApiKey, makeConfigDir } from "./helpers/nemar-account";

// git and git-annex children, each starting the CLI: a slow runner needs more than the default 5 seconds.
setDefaultTimeout(60_000);

const SRC = join(import.meta.dir, "..", "src");
const DATASET = "np099999";
const API_KEY = fakeApiKey();

const HAVE_GIT_ANNEX = gitAnnexGate("test/data-host-e2e.test.ts");

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(
  cmd: string[],
  cwd: string | undefined,
  env: Record<string, string>,
): Promise<Run> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, code: await proc.exited };
}

function chmodTreeWritable(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    try {
      chmodSync(full, st.isDirectory() ? 0o755 : 0o644);
    } catch {}
    if (st.isDirectory()) chmodTreeWritable(full);
  }
}

describe.skipIf(!HAVE_GIT_ANNEX)("a dataset on an authenticated data host, end to end", () => {
  let root: string;
  let env: Record<string, string>;
  let host: DataHostStandin;
  let foreign: ReturnType<typeof Bun.serve>;
  let api: ReturnType<typeof Bun.serve>;
  let apiPaths: string[];
  let spy: EgressSpy;
  let cloneResult: Run;
  let globalConfigPath: string;
  let foreignSeen: { path: string; authorization: string | null; cookie: string | null }[];
  let clone: string;
  let configDir: string;
  let trapLog: string;
  const content = {
    small: patternBytes(29, 11),
    big: patternBytes(200 * 1024, 12),
    trap: patternBytes(1500, 13),
  };
  let keys: { small: string; big: string; trap: string };

  async function sh(cmd: string[], cwd?: string, extra: Record<string, string> = {}): Promise<Run> {
    return run(cmd, cwd, { ...env, ...extra });
  }

  async function mustSh(
    cmd: string[],
    cwd?: string,
    extra: Record<string, string> = {},
  ): Promise<Run> {
    const result = await sh(cmd, cwd, extra);
    if (result.code !== 0) {
      throw new Error(
        `${cmd.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }

  const cli = (args: string[], cwd?: string) =>
    sh(["bun", "run", join(SRC, "index.ts"), ...args], cwd);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "nemar-e2e-"));
    spy = startEgressSpy();
    const shims = join(root, "bin");
    mkdirSync(shims);
    for (const [name, entry] of [
      ["nemar", join(SRC, "index.ts")],
      ["git-annex-remote-nemar", join(SRC, "git-annex-remote-nemar.ts")],
    ]) {
      const path = join(shims, name);
      writeFileSync(path, `#!/bin/sh\nexec bun run ${JSON.stringify(entry)} "$@"\n`);
      chmodSync(path, 0o755);
    }

    // A foreign host that a writer registers a URL for: it must never see a credential.
    foreignSeen = [];
    foreign = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        foreignSeen.push({
          path: new URL(req.url).pathname,
          authorization: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
        });
        return new Response(content.trap, {
          headers: { "Content-Length": String(content.trap.byteLength) },
        });
      },
    });

    // The CLI's own API (notices and the like) is somewhere else again, so nothing it is sent
    // can be mistaken for what the foreign host receives.
    apiPaths = [];
    api = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        apiPaths.push(path);
        // The main service does not know this dataset: it is not one of its ids.
        if (path.startsWith("/datasets/")) {
          return Response.json({ error: "Dataset not found" }, { status: 404 });
        }
        return new Response('{"notices":[]}', { headers: { "Content-Type": "application/json" } });
      },
    });

    // The repository on the data host: real annexed files, the special remote declared in
    // the git-annex branch, and a web URL on the foreign host for one more key.
    const source = join(root, "source");
    const gitRoot = join(root, "git-root");
    mkdirSync(source);
    mkdirSync(gitRoot);

    configDir = makeConfigDir(API_KEY, `http://127.0.0.1:${api.port}`);
    trapLog = join(root, "global-helper.log");
    const trap = join(root, "global-helper.sh");
    writeFileSync(trap, `#!/bin/sh\n{ echo "$1"; cat; } >> ${JSON.stringify(trapLog)}\n`);
    chmodSync(trap, 0o755);
    const globalConfig = join(root, "gitconfig");
    writeFileSync(
      globalConfig,
      `[user]\n\tname = Fixture\n\temail = fixture@example.org\n[init]\n\tdefaultBranch = master\n[credential]\n\thelper = !${trap}\n`,
    );
    globalConfigPath = globalConfig;
    env = {
      ...cliBaseEnv(),
      ...spy.env,
      PATH: `${shims}:${process.env.PATH}`,
      HOME: join(root, "home"),
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      NEMAR_CONFIG_DIR: configDir,
      NEMAR_DATA_HOSTS: "",
      // Only the stand-in: a lookup must never reach a real data host from a test.
      NEMAR_DATA_HOSTS_ONLY: "1",
      NEMAR_NO_UPDATE_CHECK: "1",
    };
    mkdirSync(env.HOME);

    await mustSh(["git", "init", "-q", source]);
    await mustSh(["git", "annex", "init", "fixture source"], source);
    writeFileSync(join(source, "small.bin"), content.small);
    writeFileSync(join(source, "big.bin"), content.big);
    writeFileSync(join(source, "trap.bin"), content.trap);
    writeFileSync(join(source, "README.txt"), "A tracked text file.\n");
    await mustSh(["git", "annex", "add", "small.bin", "big.bin", "trap.bin"], source);
    await mustSh(["git", "add", "README.txt"], source);
    await mustSh(["git", "commit", "-q", "-m", "fixture"], source);
    const lookup = async (file: string): Promise<string> =>
      (await mustSh(["git", "annex", "lookupkey", file], source)).stdout.trim();
    keys = {
      small: await lookup("small.bin"),
      big: await lookup("big.bin"),
      trap: await lookup("trap.bin"),
    };

    // The data host serves these objects and the repository's bare copy (below).
    host = new DataHostStandin({
      apiKey: API_KEY,
      datasetId: DATASET,
      gitRoot,
      objects: new Map([
        [keys.small, content.small],
        [keys.big, content.big],
      ]),
    });
    env.NEMAR_DATA_HOSTS = host.origin;

    await mustSh(
      [
        "git",
        "annex",
        "initremote",
        "nemar",
        "type=external",
        "externaltype=nemar",
        "encryption=none",
        "autoenable=true",
        `host=${host.origin}`,
        `dataset=${DATASET}`,
      ],
      source,
    );
    // A second special remote the main service's flow would enable by name; a data host clone
    // must leave it alone.
    mkdirSync(join(root, "s3-standin"));
    await mustSh(
      [
        "git",
        "annex",
        "initremote",
        "nemar-s3",
        "type=directory",
        `directory=${join(root, "s3-standin")}`,
        "encryption=none",
      ],
      source,
    );
    const uuid = (await mustSh(["git", "config", "remote.nemar.annex-uuid"], source)).stdout.trim();
    for (const key of [keys.small, keys.big]) {
      await mustSh(["git", "annex", "setpresentkey", key, uuid, "1"], source);
    }
    // A writer's own trick: a web URL on a host that is not the data host, for a key that has
    // no other copy. git-annex's web remote fetches it, and it must never carry the key.
    await mustSh(
      ["git", "annex", "registerurl", keys.trap, `http://127.0.0.1:${foreign.port}/trap.bin`],
      source,
    );
    await mustSh(["git", "clone", "-q", "--bare", source, join(gitRoot, `${DATASET}.git`)]);

    clone = join(root, "clone");
    // Every test below starts from this clone, so each can run on its own.
    cloneResult = await cli(["dataset", "clone", DATASET, "--host", host.origin, "-o", clone]);
  }, 120_000);

  afterAll(() => {
    // Nothing any command here did reached a host outside this machine.
    expect(spy?.seen).toEqual([]);
    spy?.stop();
    host?.stop();
    foreign?.stop(true);
    api?.stop(true);
    if (root) {
      try {
        chmodTreeWritable(root);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  test("clone --host finds the dataset, clones over the credential helper and enables the special remote", async () => {
    expect(cloneResult.code).toBe(0);
    expect(existsSync(join(clone, "README.txt"))).toBe(true);
    expect(readFileSync(join(clone, "README.txt"), "utf8")).toBe("A tracked text file.\n");

    // The lookup and the git requests were authenticated the way the data host expects.
    expect(host.dataRequests("/api/datasets/")[0].authorization).toBe(`Bearer ${API_KEY}`);
    const gitRequests = host.dataRequests("/git/");
    expect(gitRequests.length).toBeGreaterThan(0);
    // Stock git asks without a credential first and retries with Basic after the 401.
    expect(gitRequests[0].authorization).toBeNull();
    const basic = `Basic ${btoa(`nemar:${API_KEY}`)}`;
    expect(gitRequests.some((r) => r.authorization === basic)).toBe(true);

    // The special remote was declared by the repository and enabled by `git annex init`.
    const remotes = await mustSh(
      ["git", "config", "--get-regexp", "^remote\\..*\\.annex-externaltype$"],
      clone,
    );
    expect(remotes.stdout).toContain("nemar");
  });

  test("the clone's config holds the helper for the data host and not the key", async () => {
    const config = readFileSync(join(clone, ".git", "config"), "utf8");
    expect(config).toContain(`[credential "${host.origin}"]`);
    // Exactly an empty helper, which resets any helper configured for all hosts, and then ours,
    // in that order and once each.
    const helpers = await mustSh(
      ["git", "config", "--local", "--get-all", `credential.${host.origin}.helper`],
      clone,
    );
    expect(helpers.stdout).toBe("\n!nemar auth git-credential\n");
    expect(config).not.toContain(API_KEY);
    expect(config).not.toContain(btoa(`nemar:${API_KEY}`));
    // Nor is it in any other file under .git (logs, remote.log, the branch refs).
    const grep = Bun.spawnSync(["grep", "-r", "-l", API_KEY, join(clone, ".git")]);
    expect(grep.stdout.toString()).toBe("");
  });

  test("get fetches a small object directly and a large one through the redirect, and fsck passes", async () => {
    const before = host.storageSeen.length;
    const result = await cli(["dataset", "get", "small.bin", "big.bin"], clone);
    expect(result.code).toBe(0);
    expect(new Uint8Array(readFileSync(join(clone, "small.bin")))).toEqual(content.small);
    expect(new Uint8Array(readFileSync(join(clone, "big.bin")))).toEqual(content.big);

    // Objects were asked for with the Bearer key, and the large one was redirected to the
    // other origin, which was never sent a credential.
    const objectRequests = host.dataRequests("/o/");
    expect(objectRequests.length).toBeGreaterThan(0);
    expect(objectRequests.every((r) => r.authorization === `Bearer ${API_KEY}`)).toBe(true);
    const storage = host.storageSeen.slice(before);
    expect(storage.length).toBeGreaterThan(0);
    expect(storage.every((r) => r.authorization === null)).toBe(true);
    expect(JSON.stringify(host.storageSeen)).not.toContain(API_KEY);

    const fsck = await sh(["git", "annex", "fsck", "small.bin", "big.bin"], clone);
    expect(fsck.code).toBe(0);
    expect(fsck.stdout + fsck.stderr).not.toContain("failed");

    // The main service's remote is not enabled by a data host clone, though the repository
    // declares one by that name.
    // Trying would also show: `enableremote` on that one fails and the command warns about it.
    expect(result.stdout + result.stderr).not.toContain("S3 remote");
    const s3 = await sh(["git", "config", "--get-regexp", "^remote\\.nemar-s3\\."], clone);
    expect(s3.stdout).toBe("");

    // And git-annex says it came from the data remote.
    const whereis = await mustSh(["git", "annex", "whereis", "big.bin"], clone);
    expect(whereis.stdout).toContain("nemar");
  });

  test("get again finds everything present and makes no further object request", async () => {
    const before = host.dataRequests("/o/").length;
    const result = await cli(["dataset", "get", "small.bin", "big.bin"], clone);
    expect(result.stdout + result.stderr).toContain("already present");
    expect(result.code).toBe(0);
    expect(host.dataRequests("/o/").length).toBe(before);
  });

  test("a URL a writer registered on a foreign host never receives the key", async () => {
    // git-annex's own web remote fetches it (loopback is allowed for this test only); the CLI
    // sets no header for it, so the foreign host sees no credential of any kind.
    const get = await sh(
      ["git", "-c", "annex.security.allowed-ip-addresses=all", "annex", "get", "trap.bin"],
      clone,
    );
    expect(get.code).toBe(0);
    expect(new Uint8Array(readFileSync(join(clone, "trap.bin")))).toEqual(content.trap);
    expect(foreignSeen.length).toBeGreaterThan(0);
    for (const seen of foreignSeen) {
      expect(seen.authorization).toBeNull();
      expect(seen.cookie).toBeNull();
    }
    expect(JSON.stringify(foreignSeen)).not.toContain(API_KEY);
    const fsck = await sh(["git", "annex", "fsck", "trap.bin"], clone);
    expect(fsck.code).toBe(0);
  });

  test("git's own credential store was never offered the key", () => {
    // The global config names a helper that logs every call; the clone's configuration resets
    // the list for the data host, so it must never have been run for it.
    expect(existsSync(trapLog) ? readFileSync(trapLog, "utf8") : "").not.toContain(API_KEY);
    expect(existsSync(trapLog) ? readFileSync(trapLog, "utf8") : "").not.toContain("store");
  });

  test("positive control: without the reset, git's credential store is offered the key", async () => {
    // The same kind of clone, but with only our helper and no empty helper before it, under a
    // global config whose helper logs every call: the trap is shown to catch what the real
    // clone's reset keeps out.
    const log = join(root, "control-helper.log");
    const script = join(root, "control-helper.sh");
    writeFileSync(script, `#!/bin/sh\n{ echo "$1"; cat; } >> ${JSON.stringify(log)}\n`);
    chmodSync(script, 0o755);
    const config = join(root, "control-gitconfig");
    writeFileSync(
      config,
      `[user]\n\tname = Fixture\n\temail = fixture@example.org\n[credential]\n\thelper = !${script}\n`,
    );
    const key = `credential.${host.origin}.helper`;
    const done = await sh(
      [
        "git",
        "clone",
        "-q",
        "-c",
        `${key}=!nemar auth git-credential`,
        `${host.origin}/git/${DATASET}.git`,
        join(root, "control-clone"),
      ],
      undefined,
      { GIT_CONFIG_GLOBAL: config },
    );
    expect(done.code).toBe(0);
    const logged = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(logged).toContain("store");
    expect(logged).toContain(API_KEY);
  });

  test("a clone that is redirected to another origin after it authenticated sends that origin no credential", async () => {
    const redirecting = new DataHostStandin({
      apiKey: API_KEY,
      datasetId: DATASET,
      gitRedirectTo: "storage",
    });
    try {
      // The helper is configured for every host here. git itself keeps the credential tied to
      // the host it started at and curl drops it at a cross-origin redirect, so the helper is
      // not even asked for the second origin; if it were, it answers nothing for it. Either
      // way the second origin gets no credential, which is what is pinned.
      const helper = `!bun run ${join(SRC, "index.ts")} auth git-credential`;
      const done = await sh(
        [
          "git",
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=${helper}`,
          "clone",
          "-q",
          `${redirecting.origin}/git/${DATASET}.git`,
          join(root, "redirected-clone"),
        ],
        undefined,
        { NEMAR_DATA_HOSTS: redirecting.origin },
      );
      expect(done.code).not.toBe(0);
      // It authenticated at the data host, was redirected, and asked the other origin without
      // a credential: that origin saw requests, none with an Authorization header.
      expect(
        redirecting.dataRequests("/git/").some((r) => r.authorization?.startsWith("Basic ")),
      ).toBe(true);
      expect(redirecting.storageSeen.length).toBeGreaterThan(0);
      expect(redirecting.storageSeen.every((r) => r.authorization === null)).toBe(true);
      expect(JSON.stringify(redirecting.storageSeen)).not.toContain(API_KEY);
    } finally {
      redirecting.stop();
    }
  });

  test("without --host, an id the main service does not know is looked up on the data hosts", async () => {
    const second = join(root, "clone-without-host");
    apiPaths.length = 0;
    const result = await cli(["dataset", "clone", DATASET, "-o", second]);
    expect(result.code).toBe(0);
    // The main service was asked first, and said it has no such dataset.
    expect(apiPaths).toContain(`/datasets/${DATASET}`);
    expect(result.stdout + result.stderr).toContain("Found: Fixture dataset");
    expect(readFileSync(join(second, "README.txt"), "utf8")).toBe("A tracked text file.\n");
    const remotes = await mustSh(
      ["git", "config", "--get-regexp", "^remote\\..*\\.annex-externaltype$"],
      second,
    );
    expect(remotes.stdout).toContain("nemar");
  });

  test("an id that neither the main service nor any data host has is simply not found", async () => {
    const before = host.dataRequests("/api/datasets/").length;
    const result = await cli(["dataset", "clone", "np000002", "-o", join(root, "absent")]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("not found");
    expect(host.dataRequests("/api/datasets/").length).toBe(before + 1);
    expect(existsSync(join(root, "absent"))).toBe(false);
  });

  test("an id that is not a data host id is never sent to a data host", async () => {
    const before = host.dataSeen.length;
    const result = await cli(["dataset", "clone", "not-a-dataset-id", "-o", join(root, "bad-id")]);
    expect(result.code).not.toBe(0);
    expect(host.dataSeen.length).toBe(before);
  });

  test("a clone of a dataset the host does not have, or a refused key, is not cloned", async () => {
    const missing = await cli([
      "dataset",
      "clone",
      "np000001",
      "--host",
      host.origin,
      "-o",
      join(root, "missing"),
    ]);
    expect(missing.code).not.toBe(0);
    expect(existsSync(join(root, "missing"))).toBe(false);
    expect(missing.stdout + missing.stderr).toContain("not found");

    const wrongKeyDir = makeConfigDir(fakeApiKey(), `http://127.0.0.1:${api.port}`);
    try {
      const refused = await run(
        [
          "bun",
          "run",
          join(SRC, "index.ts"),
          "dataset",
          "clone",
          DATASET,
          "--host",
          host.origin,
          "-o",
          join(root, "refused"),
        ],
        undefined,
        { ...env, NEMAR_CONFIG_DIR: wrongKeyDir },
      );
      expect(refused.code).not.toBe(0);
      expect(existsSync(join(root, "refused"))).toBe(false);
    } finally {
      rmSync(wrongKeyDir, { recursive: true, force: true });
    }
  });

  test("--host names only a host on the CLI's list: any other is refused before a request", async () => {
    const before = host.dataSeen.length;
    for (const refusedHost of [
      "https://evil.example",
      `${host.origin.replace("127.0.0.1", "localhost")}`,
      "http://example.com",
    ]) {
      const result = await cli([
        "dataset",
        "clone",
        DATASET,
        "--host",
        refusedHost,
        "-o",
        join(root, "nope"),
      ]);
      expect([refusedHost, result.code === 0]).toEqual([refusedHost, false]);
      expect(result.stdout + result.stderr).toContain("not a data host");
    }
    expect(host.dataSeen.length).toBe(before);
    expect(existsSync(join(root, "nope"))).toBe(false);
  });
});
