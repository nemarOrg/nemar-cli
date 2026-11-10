/**
 * `nemar compute submit|logs|results|cancel` on this machine only (epic #2021 phase D3b, #2024): everything
 * the commands decide BEFORE they ask NEMAR for anything, driven through the real entry point. The server
 * here is not NEMAR: it only COUNTS the requests it receives (and answers the CLI's notice poll), so a test
 * can say "zero requests reached the server", which is the claim. The commands against the real routes are
 * `compute-user-e2e-cli.test.ts`.
 *
 * THIS IS A PUBLIC REPOSITORY: every credential-shaped fake is assembled at run time from fragments.
 *
 * What is pinned:
 *  - `--dry-run` packs, scans and prints, needs no sign-in, sends NOTHING, and the digest it prints is the
 *    same on every run; `--json` of it is one document;
 *  - a credential in a file, a file name or an argument ends the command with exit 2 before any request,
 *    names the rule and the place and never the value, and `.nemarignore` is the way out;
 *  - every local refusal is exit 2 with nothing sent; a tag-only image, a bad size, a header error naming
 *    its file and line, a folder with no entry, a missing dataset version, too many files;
 *  - each command's help states its exit codes.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { BUNDLE_MAX_FILES } from "../shared/contract/compute-bundle";
import { collectFolder, packCollected } from "../src/lib/compute/pack";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let requests: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    requests.push(`${req.method} ${url.pathname}`);
    return Response.json({ error: "this server only counts", code: "internal" }, { status: 500 });
  },
});
const API = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

let configDir: string;
let work: string;

beforeEach(() => {
  requests = [];
  configDir = mkdtempSync(join(tmpdir(), "nemar-submit-cfg-"));
  work = mkdtempSync(join(tmpdir(), "nemar-submit-work-"));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(args: string[], opts: { signedIn?: boolean; cwd?: string } = {}): Promise<Ran> {
  if (opts.signedIn) {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "t",
        accounts: { t: { apiKey: "local-test-key-0123456789abcdef" } },
      }),
    );
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  })) {
    if (v !== undefined) env[k] = v;
  }
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "compute", ...args],
    cwd: opts.cwd ?? work,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

function put(path: string, text: string): string {
  const abs = join(work, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

const IMAGE = `docker://ghcr.io/example/tool@sha256:${"a".repeat(64)}`;

describe("--dry-run", () => {
  test("prints what would be sent, sends nothing and needs no sign-in", async () => {
    put(
      "run.py",
      ["# /// nemar", "# cores = 4", '# time = "1h30m"', "# ///", "print(1)", ""].join("\n"),
    );
    put("lib/util.py", "x = 1\n");
    const r = await run(["submit", ".", "--entry", "run.py", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Dry run: nothing about the job was sent.");
    expect(r.stdout).toContain("2 files");
    expect(r.stdout).toContain("4 cores");
    expect(r.stdout).toContain("up to 1h 30m");
    expect(r.stdout).toMatch(/Digest: {5}sha256 [0-9a-f]{64}/);
    expect(r.stdout).toContain("cores=header");
    expect(requests).toEqual([]);
  });

  test("the digest is the archive's SHA-256 and is the same on every run", async () => {
    put("run.py", "print(1)\n");
    put("data.csv", "a,b\n");
    const first = JSON.parse(
      (await run(["submit", ".", "--entry", "run.py", "--dry-run", "--json"])).stdout,
    );
    const second = JSON.parse(
      (await run(["submit", ".", "--entry", "run.py", "--dry-run", "--json"])).stdout,
    );
    expect(first.archive.sha256).toBe(second.archive.sha256);
    const collected = collectFolder(work);
    if (!collected.ok) throw new Error("ignore");
    const packed = packCollected(collected.collected, { entry: "run.py" });
    if (!packed.ok) throw new Error("not packed");
    expect(first.archive.sha256).toBe(packed.bundle.sha256);
    expect(first.archive.sha256).toBe(
      createHash("sha256").update(packed.bundle.archive).digest("hex"),
    );
    expect(first.request.spec.bundle).toEqual({
      size: first.archive.size,
      sha256: first.archive.sha256,
    });
    expect(requests).toEqual([]);
  });

  test("--json is one document: the request, the archive and the hold", async () => {
    put("run.py", "print(1)\n");
    const r = await run([
      "submit",
      "run.py",
      "--dry-run",
      "--json",
      "--cores",
      "2",
      "--mem",
      "8G",
      "--",
      "--fast",
      "3",
    ]);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(Object.keys(doc).sort()).toEqual([
      "archive",
      "content_bytes",
      "dry_run",
      "estimated_hold_milli",
      "files",
      "request",
    ]);
    expect(doc.request.spec).toMatchObject({
      name: "run",
      runtime: "python",
      entry: "run.py",
      args: ["--fast", "3"],
      cores: 2,
      memory_mb: 8192,
      partition: "shared",
      minutes: 60,
    });
    expect(doc.request.manifest.files).toHaveLength(1);
    expect(r.stderr).toBe("");
    expect(requests).toEqual([]);
  });

  test("an image job with no code: the command is what follows --, and there is no archive", async () => {
    const r = await run([
      "submit",
      "--image",
      IMAGE,
      "--dry-run",
      "--json",
      "--",
      "run-it",
      "--fast",
    ]);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.archive).toBeNull();
    expect(doc.request.manifest).toBeUndefined();
    expect(doc.request.spec).toMatchObject({
      runtime: "image",
      image: IMAGE,
      command: ["run-it", "--fast"],
    });
    expect(requests).toEqual([]);
  });

  test("flags beat the header, the header beats the folder file, and the dry run says which", async () => {
    put(
      "nemar-job.toml",
      'entry = "run.py"\ncores = 1\nnodes = 1\npartition = "debug"\ntime = "10m"\n',
    );
    put("run.py", "# /// nemar\n# cores = 8\n# nodes = 2\n# ///\nprint(1)\n");
    const r = await run(["submit", ".", "--cores", "16", "--dry-run", "--json"]);
    expect(r.exitCode).toBe(0);
    const spec = JSON.parse(r.stdout).request.spec;
    expect([spec.cores, spec.nodes, spec.partition, spec.minutes]).toEqual([16, 2, "debug", 10]);
    const human = await run(["submit", ".", "--cores", "16", "--dry-run"]);
    expect(human.stdout).toContain("cores=flag");
    expect(human.stdout).toContain("nodes=header");
    expect(human.stdout).toContain("partition=file");
  });
});

describe("a credential never leaves the machine", () => {
  const fake = (parts: string[]) => parts.join("");
  const TOKEN = fake(["gh", "p_", "x".repeat(36)]);

  test("in a file: exit 2, the rule and file:line, never the value, zero requests; .nemarignore is the way out", async () => {
    put("run.py", "print(1)\n");
    put("notes.txt", `first\nsecond\ntoken = ${TOKEN}\n`);
    const r = await run(["submit", ".", "--entry", "run.py"], { signedIn: true });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("notes.txt:3  github_token");
    expect(r.stderr).toContain("there is no override");
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.stdout + r.stderr).not.toContain("x".repeat(20));
    expect(r.stdout).toBe("");
    expect(requests).toEqual([]);
    // also under --dry-run, which is the way to check
    const dry = await run(["submit", ".", "--entry", "run.py", "--dry-run"]);
    expect(dry.exitCode).toBe(2);
    // leaving the file out clears it
    put(".nemarignore", "notes.txt\n");
    const ok = await run(["submit", ".", "--entry", "run.py", "--dry-run"]);
    expect(ok.exitCode).toBe(0);
    expect(requests).toEqual([]);
  });

  test("a credential file name (.env, *.pem) is refused whatever it holds", async () => {
    put("run.py", "print(1)\n");
    put(".env", "HARMLESS=1\n");
    put("certs/server.pem", "not a key\n");
    const r = await run(["submit", ".", "--entry", "run.py"], { signedIn: true });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(".env  credential_file_name");
    expect(r.stderr).toContain("certs/server.pem  credential_file_name");
    expect(requests).toEqual([]);
  });

  test("on the command line (an argument after --, an environment value): refused by place", async () => {
    put("run.py", "print(1)\n");
    const arg = await run(["submit", "run.py", "--", "--token", TOKEN], { signedIn: true });
    expect(arg.exitCode).toBe(2);
    expect(arg.stderr).toContain("argument 2  github_token");
    expect(arg.stdout + arg.stderr).not.toContain(TOKEN);
    const name = await run(["submit", "run.py", "--name", `job ${TOKEN}`], { signedIn: true });
    expect(name.exitCode).toBe(2);
    expect(requests).toEqual([]);
  });

  test("a private key block in the middle of a file", async () => {
    put("run.py", "print(1)\n");
    put("deploy.sh", `echo hi\n${fake(["-----", "BEGIN OPENSSH ", "PRIVATE", " KEY", "-----"])}\n`);
    const r = await run(["submit", ".", "--entry", "run.py"], { signedIn: true });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("deploy.sh:2  private_key_block");
    expect(requests).toEqual([]);
  });
});

describe("a local refusal is exit 2 with nothing sent", () => {
  const cases: Array<[string, string[], string, Record<string, string>?]> = [
    [
      "a tag-only image",
      ["submit", "--image", "docker://ghcr.io/example/tool:latest", "--", "x"],
      "a tag is not a pin",
      undefined,
    ],
    [
      "an image with no docker:// scheme",
      ["submit", "--image", `ghcr.io/example/tool@sha256:${"a".repeat(64)}`, "--", "x"],
      "docker://",
      undefined,
    ],
    [
      "an image with a runtime that is not image",
      ["submit", "--image", IMAGE, "--runtime", "python", "--", "x"],
      "--runtime must be image",
      undefined,
    ],
    ["an image job with no command", ["submit", "--image", IMAGE], "needs the command", undefined],
    [
      "a bad --mem",
      ["submit", "run.py", "--mem", "lots"],
      "--mem is a size like 16G",
      { "run.py": "1" },
    ],
    [
      "a bad --time",
      ["submit", "run.py", "--time", "soon"],
      "--time is a duration",
      { "run.py": "1" },
    ],
    [
      "a non-numeric --cores",
      ["submit", "run.py", "--cores", "many"],
      "--cores is a whole number",
      { "run.py": "1" },
    ],
    [
      "a dataset with no version",
      ["submit", "run.py", "--dataset", "nm000104"],
      "A dataset needs its version",
      { "run.py": "1" },
    ],
    [
      "an --env that is not on the list",
      ["submit", "run.py", "--env", "SECRET_THING=1"],
      "--env names one of",
      { "run.py": "1" },
    ],
    [
      "an --env with no =",
      ["submit", "run.py", "--env", "OMP_NUM_THREADS"],
      "--env is NAME=value",
      { "run.py": "1" },
    ],
    [
      "a partition that does not exist",
      ["submit", "run.py", "--partition", "nowhere"],
      "partition: must be one of",
      { "run.py": "1" },
    ],
    [
      "a GPU partition with no GPU",
      ["submit", "run.py", "--partition", "gpu"],
      "gpus:",
      { "run.py": "1" },
    ],
    ["a folder with no entry", ["submit", "."], "Name the file to run", { "run.py": "1" }],
    [
      "an entry that is not in the folder",
      ["submit", ".", "--entry", "nope.py"],
      "The job's entry is not one of the files in the bundle.",
      { "run.py": "1" },
    ],
    [
      "an entry that leaves the folder",
      ["submit", ".", "--entry", "../run.py"],
      "relative path inside the folder",
      { "run.py": "1" },
    ],
    ["a path that is not there", ["submit", "missing.py"], "no such file or folder", undefined],
    [
      "a file with no known runtime",
      ["submit", "tool.sh"],
      "Say how to run it",
      { "tool.sh": "echo 1" },
    ],
    ["extra operands without --", ["submit", "run.py", "extra"], "after --", { "run.py": "1" }],
    [
      "a header error, naming its file and line",
      ["submit", "run.py"],
      "run.py:2: unknown key",
      { "run.py": "# /// nemar\n# wheels = 4\n# ///\nprint(1)\n" },
    ],
    [
      "a job file error",
      ["submit", ".", "--entry", "run.py"],
      "nemar-job.toml:1:",
      { "run.py": "1", "nemar-job.toml": "cores = 1.5\n" },
    ],
    [
      "a bad .nemarignore",
      ["submit", ".", "--entry", "run.py"],
      ".nemarignore:1:",
      { "run.py": "1", ".nemarignore": "!run.py\n" },
    ],
    [
      "a dataset version with no data-plane tag",
      ["submit", "run.py", "--dataset", "nm000104@abc"],
      "a dataset version is like 1.0.2",
      { "run.py": "1" },
    ],
  ];
  for (const [what, args, expected, files] of cases) {
    test(what, async () => {
      for (const [path, text] of Object.entries(files ?? {})) put(path, text);
      const r = await run(args, { signedIn: true });
      expect([what, r.exitCode]).toEqual([what, 2]);
      expect(r.stderr).toContain(expected);
      expect(r.stdout).toBe("");
      expect(requests).toEqual([]);
    });
  }

  test("more files than the Worker takes is refused with its sentence, listing the largest", async () => {
    put("run.py", "1");
    for (let i = 0; i < BUNDLE_MAX_FILES; i++) put(`d/f${i}.txt`, "x");
    const r = await run(["submit", ".", "--entry", "run.py"], { signedIn: true });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("The code bundle holds more files than the limit allows.");
    expect(requests).toEqual([]);
  }, 60_000);

  test("job ids and options of logs, results and cancel are checked before anything is sent", async () => {
    for (const args of [
      ["logs", "job_nope"],
      ["logs", "job_0123456789abcdef01234567", "--tail", "0"],
      ["logs", "job_0123456789abcdef01234567", "--tail", "many"],
      ["results", "nope"],
      ["cancel", "nope", "--yes"],
      ["cancel", "job_0123456789abcdef01234567"],
      ["cancel", "job_0123456789abcdef01234567", "--json"],
    ]) {
      const r = await run(args, { signedIn: true });
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 2]);
      expect(r.stdout).toBe("");
    }
    expect(requests).toEqual([]);
  });

  test("not signed in is exit 1 and sends nothing", async () => {
    put("run.py", "print(1)\n");
    const r = await run(["submit", "run.py"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr + r.stdout).toContain("Not authenticated");
    for (const args of [
      ["logs", "job_0123456789abcdef01234567"],
      ["results", "job_0123456789abcdef01234567"],
      ["cancel", "job_0123456789abcdef01234567", "--yes"],
    ]) {
      expect((await run(args)).exitCode).toBe(1);
    }
    expect(requests).toEqual([]);
  });
});

describe("a file that cannot be read is a local refusal that names it relatively", () => {
  const unprivileged = process.getuid?.() !== 0;

  test.skipIf(!unprivileged)("an unreadable file", async () => {
    put("run.py", "print(1)\n");
    const secret = put("lib/locked.txt", "x");
    chmodSync(secret, 0o000);
    try {
      const r = await run(["submit", ".", "--entry", "run.py", "--dry-run"], { signedIn: true });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("lib/locked.txt cannot be read.");
      expect(r.stderr).not.toContain(work);
      expect(r.stderr).not.toContain("--debug");
      expect(r.stdout).toBe("");
    } finally {
      chmodSync(secret, 0o644);
    }
    expect(requests).toEqual([]);
  });

  test.skipIf(!unprivileged)("an unreadable subfolder", async () => {
    put("run.py", "print(1)\n");
    put("data/a.csv", "x");
    chmodSync(join(work, "data"), 0o000);
    try {
      const r = await run(["submit", ".", "--entry", "run.py", "--dry-run"], { signedIn: true });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("data cannot be read.");
      expect(r.stderr).not.toContain(work);
      expect(r.stderr).not.toContain("--debug");
    } finally {
      chmodSync(join(work, "data"), 0o755);
    }
  });

  test.skipIf(!unprivileged)("an unreadable script header and job file", async () => {
    const script = put("run.py", "print(1)\n");
    chmodSync(script, 0o000);
    try {
      const r = await run(["submit", "run.py", "--dry-run"], { signedIn: true });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("run.py cannot be read.");
      expect(r.stderr).not.toContain(work);
    } finally {
      chmodSync(script, 0o644);
    }
  });
});

describe("the help says what each exit code means", () => {
  for (const command of ["submit", "logs", "results", "cancel"]) {
    test(`${command} --help-all has an Exit codes block`, async () => {
      const r = await run([command, "--help-all"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Exit codes:");
      expect(r.stdout).toMatch(/\n {2}0 {2}/);
      expect(r.stdout).toMatch(/\n {2}1 {2}/);
      expect(r.stdout).toMatch(/\n {2}2 {2}/);
    });
  }
  test("submit's help names the third code", async () => {
    const r = await run(["submit", "--help-all"]);
    expect(r.stdout).toMatch(/\n {2}3 {2}with --wait/);
    expect(r.stdout).toContain("has no override");
  });
});

describe("the job environment is documented where a person looks (#2092)", () => {
  test("submit's help states where data, code and results are", async () => {
    const r = await run(["submit", "--help-all"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Job environment (under development");
    expect(r.stdout).toContain("/data/<id>");
    expect(r.stdout).toContain("/work/outputs");
    expect(r.stdout).toContain("$NEMAR_OUT");
    expect(r.stdout).toContain("Not promised yet:");
  });

  test("results' and logs' help say what comes back and what the log is", async () => {
    const results = await run(["results", "--help-all"]);
    expect(results.stdout).toContain("only regular files under $NEMAR_OUT (/work/outputs)");
    const logs = await run(["logs", "--help-all"]);
    expect(logs.stdout).toContain("standard output and standard error");
  });

  test("a dry run prints the paths, and the JSON answer is unchanged", async () => {
    put("run.py", "print(1)\n");
    const human = await run(["submit", ".", "--entry", "run.py", "--dry-run"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("Paths:");
    expect(human.stdout).toContain("/data/<id> (read-only)");
    expect(human.stdout).toContain("/work/outputs ($NEMAR_OUT)");
    const json = await run(["submit", ".", "--entry", "run.py", "--dry-run", "--json"]);
    expect(json.stdout).not.toContain("Paths:");
    expect(JSON.parse(json.stdout).dry_run).toBe(true);
  });
});
