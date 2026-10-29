/**
 * The second executable, `git-annex-remote-nemar`, as it ships (ADR 0114): declared in
 * package.json, built by the same `bun build` as `nemar`, and carrying the one URL literal that
 * the dev-build step of .github/workflows/npm-publish.yml rewrites, so a dev build of the
 * special remote defaults to the staging data host exactly as `nemar` does.
 *
 * The bundle is built into a temporary directory (not dist/, which another suite builds into)
 * and run as a child process through the protocol.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataHostStandin } from "./helpers/data-host-standin";
import { fakeApiKey, makeConfigDir } from "./helpers/nemar-account";
import { useSessions } from "./helpers/remote-session";

// a bundle build and child processes: a slow runner needs more than the default 5 seconds.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const API_KEY = fakeApiKey();

let outdir: string;
let configDir: string;

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), "nemar-bundle-"));
  configDir = makeConfigDir(API_KEY);
  const build = Bun.spawn(
    [
      "bun",
      "build",
      "src/index.ts",
      "src/git-annex-remote-nemar.ts",
      "--outdir",
      outdir,
      "--target",
      "bun",
      "--minify",
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  expect(await build.exited).toBe(0);
}, 60_000);

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe("packaging", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    scripts: Record<string, string>;
    files: string[];
  };

  test("package.json declares both executables under dist/, which the package ships", () => {
    expect(pkg.bin).toEqual({
      nemar: "dist/index.js",
      "git-annex-remote-nemar": "dist/git-annex-remote-nemar.js",
    });
    expect(pkg.files).toContain("dist");
  });

  test("the build script builds both entry points into dist/", () => {
    expect(pkg.scripts.build).toContain("src/index.ts src/git-annex-remote-nemar.ts");
    expect(pkg.scripts.build).toContain("--outdir dist");
  });

  test("both bundles come out under the names package.json gives them", () => {
    for (const bin of Object.values(pkg.bin)) {
      const name = bin.replace(/^dist\//, "");
      expect(readFileSync(join(outdir, name), "utf8").length).toBeGreaterThan(1000);
    }
  });

  test("the remote's bundle starts with a bun shebang, so it runs when git-annex execs it", () => {
    const first = readFileSync(join(outdir, "git-annex-remote-nemar.js"), "utf8").split("\n")[0];
    expect(first).toBe("#!/usr/bin/env bun");
  });

  test("the dev-build step rewrites the URL literal in both bundles", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "npm-publish.yml"), "utf8");
    expect(workflow).toContain("dist/index.js dist/git-annex-remote-nemar.js");
    for (const name of ["index.js", "git-annex-remote-nemar.js"]) {
      expect(readFileSync(join(outdir, name), "utf8")).toContain("https://api.nemar.org");
    }
  });
});

const open = useSessions();

/** git-annex's side of INITREMOTE for a bundle, returning the reply. */
async function initremote(bundle: string, host: string): Promise<string> {
  const session = open({ entry: bundle, hosts: "", config: configDir });
  expect(await session.next()).toBe("VERSION 1");
  return await session.configure("INITREMOTE", host, "np099999");
}

describe("the built remote", () => {
  test("a production bundle defaults to the production data host", async () => {
    const bundle = join(outdir, "git-annex-remote-nemar.js");
    expect(await initremote(bundle, "https://private.nemar.org")).toBe("INITREMOTE-SUCCESS");
    expect(
      (await initremote(bundle, "https://private-test.nemar.org")).startsWith("INITREMOTE-FAILURE"),
    ).toBe(true);
  });

  test("after the dev-build rewrite it defaults to the staging data host instead", async () => {
    const source = readFileSync(join(outdir, "git-annex-remote-nemar.js"), "utf8");
    const dev = join(outdir, "git-annex-remote-nemar.dev.js");
    // The same substitution the workflow makes.
    writeFileSync(
      dev,
      source.replaceAll("https://api.nemar.org", "https://nemar-api-dev.sccn-org.workers.dev"),
    );
    expect(await initremote(dev, "https://private-test.nemar.org")).toBe("INITREMOTE-SUCCESS");
    expect(
      (await initremote(dev, "https://private.nemar.org")).startsWith("INITREMOTE-FAILURE"),
    ).toBe(true);
  });

  test("it reads an object end to end from a local data host", async () => {
    const key = "SHA256E-s5--0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.bin";
    const body = new TextEncoder().encode("hello");
    const host = new DataHostStandin({
      apiKey: API_KEY,
      datasetId: "np099999",
      objects: new Map([[key, body]]),
    });
    try {
      const file = join(outdir, "fetched.bin");
      const session = open({
        entry: join(outdir, "git-annex-remote-nemar.js"),
        hosts: host.origin,
        config: configDir,
      });
      await session.ready();
      session.send(`CHECKPRESENT ${key}`);
      expect(await session.next()).toBe(`CHECKPRESENT-SUCCESS ${key}`);
      session.send(`TRANSFER RETRIEVE ${key} ${file}`);
      expect((await session.until("TRANSFER-")).line).toBe(`TRANSFER-SUCCESS RETRIEVE ${key}`);
      expect(readFileSync(file, "utf8")).toBe("hello");
      expect(await session.everything()).not.toContain(API_KEY);
    } finally {
      host.stop();
    }
  });
});
