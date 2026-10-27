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
import { cliBaseEnv, fakeApiKey, makeConfigDir } from "./helpers/nemar-account";

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

/** git-annex's side of INITREMOTE for a bundle, returning the reply. */
async function initremote(bundle: string, host: string): Promise<string> {
  const proc = Bun.spawn(["bun", bundle], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cliBaseEnv(),
      NEMAR_CONFIG_DIR: configDir,
      NEMAR_DATA_HOSTS: "",
      NEMAR_NO_UPDATE_CHECK: "1",
    },
  });
  const stdin = proc.stdin as {
    write: (s: string) => number;
    flush: () => unknown;
    end: () => unknown;
  };
  // The remote asks for each setting, in order; answer them from a script of lines. It does
  // not wait for a reply to anything but GETCONFIG, so sending everything up front is fine.
  stdin.write(`INITREMOTE\nVALUE ${host}\nVALUE np099999\n`);
  stdin.flush();
  stdin.end();
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return out.split("\n").find((line) => line.startsWith("INITREMOTE-")) ?? out;
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
      const proc = Bun.spawn(["bun", join(outdir, "git-annex-remote-nemar.js")], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...cliBaseEnv(),
          NEMAR_CONFIG_DIR: configDir,
          NEMAR_DATA_HOSTS: host.origin,
          NEMAR_NO_UPDATE_CHECK: "1",
        },
      });
      const stdin = proc.stdin as {
        write: (s: string) => number;
        flush: () => unknown;
        end: () => unknown;
      };
      stdin.write(
        `PREPARE\nVALUE ${host.origin}\nVALUE np099999\nCHECKPRESENT ${key}\nTRANSFER RETRIEVE ${key} ${file}\n`,
      );
      stdin.flush();
      stdin.end();
      const [out] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      expect(out).toContain("PREPARE-SUCCESS");
      expect(out).toContain(`CHECKPRESENT-SUCCESS ${key}`);
      expect(out).toContain(`TRANSFER-SUCCESS RETRIEVE ${key}`);
      expect(readFileSync(file, "utf8")).toBe("hello");
      expect(out).not.toContain(API_KEY);
    } finally {
      host.stop();
    }
  });
});
