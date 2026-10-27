/**
 * `nemar auth git-credential`: the git credential helper for authenticated NEMAR data hosts
 * (src/lib/git-credential.ts, ADR 0114).
 *
 * The pure rule is a table; the command is run as git runs it, a child process reading git's
 * lines on stdin, and then through real `git credential fill`. The property under test is that
 * the key is answered for an allow-listed host and for nothing else, and that nothing but the
 * answer reaches stdout, which git parses.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  asksForDataHost,
  credentialAnswer,
  isGitCredentialInvocation,
  parseCredentialInput,
} from "../src/lib/git-credential";
import { fakeApiKey, makeConfigDir } from "./helpers/nemar-account";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const API_KEY = fakeApiKey();
const PROD = { env: {}, isDevBuild: false };

describe("parseCredentialInput", () => {
  test("reads key=value lines up to the blank line", () => {
    expect(
      parseCredentialInput(
        "protocol=https\nhost=private.nemar.org\npath=git/np099999.git\n\nignored=1\n",
      ),
    ).toEqual({ protocol: "https", host: "private.nemar.org", path: "git/np099999.git" });
  });

  test("keeps an = inside a value, tolerates CRLF, skips lines without a key", () => {
    expect(parseCredentialInput("host=a=b\r\nnokey\n=novalue\nprotocol=https\r\n\r\n")).toEqual({
      host: "a=b",
      protocol: "https",
    });
  });
});

describe("credentialAnswer", () => {
  const get = (protocol: string, host: string) => ({ protocol, host });

  test("an allow-listed host gets the user name nemar and the key as the password", () => {
    expect(credentialAnswer("get", get("https", "private.nemar.org"), API_KEY, PROD)).toBe(
      `username=nemar\npassword=${API_KEY}\n`,
    );
  });

  test("any other host, and http for a listed host, get nothing", () => {
    for (const [protocol, host] of [
      ["https", "github.com"],
      ["https", "api.nemar.org"],
      ["https", "private-test.nemar.org"],
      ["https", "private.nemar.org.evil.example"],
      ["https", "evil.example/private.nemar.org"],
      ["https", "user@private.nemar.org"],
      ["https", "private.nemar.org:8443"],
      ["http", "private.nemar.org"],
      ["ssh", "private.nemar.org"],
      ["https", ""],
      ["", "private.nemar.org"],
    ]) {
      expect([protocol, host, credentialAnswer("get", get(protocol, host), API_KEY, PROD)]).toEqual(
        [protocol, host, ""],
      );
    }
  });

  test("a loopback http host is answered only when the environment lists it", () => {
    const env = { NEMAR_DATA_HOSTS: "http://127.0.0.1:8787" };
    expect(
      credentialAnswer("get", get("http", "127.0.0.1:8787"), API_KEY, { env, isDevBuild: false }),
    ).toBe(`username=nemar\npassword=${API_KEY}\n`);
    expect(
      credentialAnswer("get", get("http", "127.0.0.1:8788"), API_KEY, { env, isDevBuild: false }),
    ).toBe("");
    expect(credentialAnswer("get", get("http", "127.0.0.1:8787"), API_KEY, PROD)).toBe("");
  });

  test("store and erase answer nothing, and so does a get with no key stored", () => {
    const input = get("https", "private.nemar.org");
    expect(credentialAnswer("store", input, API_KEY, PROD)).toBe("");
    expect(credentialAnswer("erase", input, API_KEY, PROD)).toBe("");
    expect(credentialAnswer("unknown-operation", input, API_KEY, PROD)).toBe("");
    expect(credentialAnswer("get", input, undefined, PROD)).toBe("");
    expect(credentialAnswer("get", input, "", PROD)).toBe("");
  });

  test("asksForDataHost names the host cases without needing a key", () => {
    expect(asksForDataHost(get("https", "private.nemar.org"), PROD)).toBe(true);
    expect(asksForDataHost(get("https", "github.com"), PROD)).toBe(false);
  });
});

describe("isGitCredentialInvocation", () => {
  test("recognizes the helper, with or without global flags in front", () => {
    expect(isGitCredentialInvocation(["auth", "git-credential", "get"])).toBe(true);
    expect(isGitCredentialInvocation(["--verbose", "auth", "git-credential", "store"])).toBe(true);
  });

  test("nothing else is the helper", () => {
    expect(isGitCredentialInvocation(["auth", "status"])).toBe(false);
    expect(isGitCredentialInvocation(["dataset", "auth", "git-credential"])).toBe(false);
    expect(isGitCredentialInvocation(["git-credential"])).toBe(false);
    expect(isGitCredentialInvocation([])).toBe(false);
  });
});

describe("as git runs it", () => {
  let configDir: string;
  let signedOutDir: string;
  /** Records any request the CLI makes to "the API" so the helper's silence can be shown. */
  let apiRequests: string[];
  let api: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    apiRequests = [];
    api = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        apiRequests.push(new URL(req.url).pathname);
        return new Response('{"notices":[]}', { headers: { "Content-Type": "application/json" } });
      },
    });
    configDir = makeConfigDir(API_KEY, `http://127.0.0.1:${api.port}`);
    signedOutDir = makeConfigDir(null);
  });

  afterAll(() => {
    api.stop(true);
    rmSync(configDir, { recursive: true, force: true });
    rmSync(signedOutDir, { recursive: true, force: true });
  });

  function env(config: string, hosts = ""): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      NEMAR_CONFIG_DIR: config,
      NEMAR_DATA_HOSTS: hosts,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  async function helper(
    operation: string,
    input: string,
    config = configDir,
    hosts = "",
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const proc = Bun.spawn(["bun", "run", CLI, "auth", "git-credential", operation], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: env(config, hosts),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, code: await proc.exited };
  }

  test("get for the production data host prints exactly the two lines git reads", async () => {
    const out = await helper("get", "protocol=https\nhost=private.nemar.org\n\n");
    expect(out.stdout).toBe(`username=nemar\npassword=${API_KEY}\n`);
    expect(out.code).toBe(0);
  });

  test("get for any other host prints nothing", async () => {
    for (const host of ["github.com", "api.nemar.org", "private.nemar.org.evil.example"]) {
      const out = await helper("get", `protocol=https\nhost=${host}\n\n`);
      expect([host, out.stdout, out.code]).toEqual([host, "", 0]);
    }
    const http = await helper("get", "protocol=http\nhost=private.nemar.org\n\n");
    expect(http.stdout).toBe("");
  });

  test("a loopback test host is answered when NEMAR_DATA_HOSTS lists it", async () => {
    const out = await helper(
      "get",
      "protocol=http\nhost=127.0.0.1:4455\n\n",
      configDir,
      "http://127.0.0.1:4455",
    );
    expect(out.stdout).toBe(`username=nemar\npassword=${API_KEY}\n`);
  });

  test("store and erase print nothing and exit 0", async () => {
    const input = `protocol=https\nhost=private.nemar.org\nusername=nemar\npassword=${API_KEY}\n\n`;
    for (const op of ["store", "erase"]) {
      const out = await helper(op, input);
      expect([op, out.stdout, out.stderr, out.code]).toEqual([op, "", "", 0]);
    }
  });

  test("with no key stored it prints nothing on stdout and says how to sign in on stderr", async () => {
    const out = await helper("get", "protocol=https\nhost=private.nemar.org\n\n", signedOutDir);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nemar auth login");
    expect(out.code).toBe(0);
    // A host that is not a data host gets no hint either: this is git's request for GitHub.
    const other = await helper("get", "protocol=https\nhost=github.com\n\n", signedOutDir);
    expect(other.stderr).toBe("");
  });

  test("it makes no network call of its own: no notices, no update check", async () => {
    apiRequests.length = 0;
    await helper("get", "protocol=https\nhost=private.nemar.org\n\n");
    await helper("store", "protocol=https\nhost=private.nemar.org\n\n");
    expect(apiRequests).toEqual([]);
  });

  test("real git asks it through credential.<origin>.helper and gets the key for the data host only", async () => {
    async function fill(host: string): Promise<{ stdout: string; code: number }> {
      const proc = Bun.spawn(
        [
          "git",
          "-c",
          "credential.helper=",
          "-c",
          `credential.https://${host}.helper=!bun run ${CLI} auth git-credential`,
          "credential",
          "fill",
        ],
        {
          stdin: new TextEncoder().encode(`protocol=https\nhost=${host}\n\n`),
          stdout: "pipe",
          stderr: "pipe",
          env: env(configDir),
        },
      );
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { stdout, code: await proc.exited };
    }
    const dataHost = await fill("private.nemar.org");
    expect(dataHost.code).toBe(0);
    expect(dataHost.stdout).toContain("username=nemar\n");
    expect(dataHost.stdout).toContain(`password=${API_KEY}\n`);
    // Same helper configured for another host: the helper itself refuses, git has nothing to
    // print and with prompts disabled fails.
    const other = await fill("github.com");
    expect(other.code).not.toBe(0);
    expect(other.stdout).not.toContain(API_KEY);
  });
});
