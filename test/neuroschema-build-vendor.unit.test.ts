/**
 * shared/contract/neuroschema/build-vendor.mjs reads every vendored byte from git at the stamped
 * commit, never from the working tree, refuses a dirty checkout before writing anything, and its
 * `--check` mode writes nothing and fails on any difference (ADR 0137, epic #2324 phase N1a).
 *
 * Each test builds a small neuroschema-shaped git repository in a temporary directory and runs a
 * copy of the real script there (the script writes beside itself), so nothing touches the vendored
 * tree.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "../shared/contract/neuroschema/build-vendor.mjs");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const COMMITTED: Record<string, string> = {
  "pyproject.toml": '[project]\nname = "neuroschema"\nversion = "9.8.7"\n',
  "schema/core/dataset.schema.json": JSON.stringify({
    type: "object",
    properties: { a: { $ref: "../definitions/a.schema.json" } },
  }),
  "schema/core/record.schema.json": JSON.stringify({ type: "object" }),
  "schema/definitions/a.schema.json": JSON.stringify({ type: "string", title: "committed" }),
  "views/registry.json": '{"kinds": ["committed"]}\n',
  "views/vectors/v.json": '{"cases": [1, 2]}\n',
  "views/montages/PROVENANCE.json": '{"source": "committed"}\n',
  "examples/views/product/a.tsv": "x\ty\n1\t2\n",
};

function run(cmd: string[], cwd: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
function git(repo: string, ...args: string[]) {
  const r = run(["git", "-c", "commit.gpgsign=false", ...args], repo);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
}

/** A committed fake neuroschema repo and a directory holding a copy of the script. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "nemar-build-vendor-"));
  roots.push(root);
  const repo = join(root, "neuroschema");
  const vendor = join(root, "vendor");
  mkdirSync(repo);
  mkdirSync(vendor);
  for (const [p, text] of Object.entries(COMMITTED)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  copyFileSync(SCRIPT, join(vendor, "build-vendor.mjs"));
  const vendorRun = (...args: string[]) =>
    run(["bun", join(vendor, "build-vendor.mjs"), repo, ...args], root);
  return { repo, vendor, vendorRun };
}

describe("build-vendor.mjs reads git, not the working tree", () => {
  test("a skip-worktree file's working bytes are not vendored: the committed bytes are", () => {
    const { repo, vendor, vendorRun } = setup();
    for (const p of ["views/registry.json", "schema/definitions/a.schema.json"]) {
      git(repo, "update-index", "--skip-worktree", p);
    }
    writeFileSync(join(repo, "views/registry.json"), '{"kinds": ["TAMPERED"]}\n');
    writeFileSync(
      join(repo, "schema/definitions/a.schema.json"),
      JSON.stringify({ type: "string", title: "TAMPERED" }),
    );
    // Guards the guard: git status cannot see the change, so the dirty-tree refusal does not fire.
    expect(git(repo, "status", "--porcelain")).toBe("");

    const r = vendorRun();
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(vendor, "views/registry.json"), "utf8")).toBe(
      COMMITTED["views/registry.json"],
    );
    const bundle = readFileSync(join(vendor, "dataset.bundle.json"), "utf8");
    expect(bundle).toContain('"title": "committed"');
    expect(bundle).not.toContain("TAMPERED");
    expect(JSON.parse(bundle)._provenance.neuroschema_version).toBe("9.8.7");
  });

  test("a line-ending conversion in the working tree is not vendored", () => {
    const { repo, vendor, vendorRun } = setup();
    git(repo, "config", "core.autocrlf", "true");
    rmSync(join(repo, "examples/views/product/a.tsv"));
    git(repo, "checkout", "--", "examples/views/product/a.tsv");
    // Guards the guard: the working copy really has CRLF and git calls it clean.
    expect(readFileSync(join(repo, "examples/views/product/a.tsv"), "utf8")).toContain("\r\n");
    expect(git(repo, "status", "--porcelain")).toBe("");

    const r = vendorRun();
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(vendor, "views/examples/product/a.tsv"), "utf8")).toBe(
      COMMITTED["examples/views/product/a.tsv"],
    );
  });

  test("a visible uncommitted change is refused, and the vendored tree is left untouched", () => {
    const { repo, vendor, vendorRun } = setup();
    expect(vendorRun().code).toBe(0);
    const before = readFileSync(join(vendor, "views/vectors/v.json"));
    writeFileSync(join(repo, "views/vectors/v.json"), '{"cases": []}\n');
    writeFileSync(join(repo, "views/montages/new.json"), "{}\n");

    const r = vendorRun();
    expect(r.code).toBe(1);
    expect(r.err).toContain("uncommitted changes");
    expect(readFileSync(join(vendor, "views/vectors/v.json")).equals(before)).toBe(true);
    expect(existsSync(join(vendor, "views/montages/new.json"))).toBe(false);
    expect(vendorRun("--check").code).toBe(1);
  });
});

describe("build-vendor.mjs --check", () => {
  test("passes on an exact tree and fails, writing nothing, on any difference", () => {
    const { vendor, vendorRun } = setup();
    const missing = vendorRun("--check");
    expect(missing.code).toBe(1);
    expect(existsSync(join(vendor, "dataset.bundle.json"))).toBe(false);
    expect(existsSync(join(vendor, "views"))).toBe(false);

    expect(vendorRun().code).toBe(0);
    const exact = vendorRun("--check");
    expect(exact.code, exact.err).toBe(0);

    const target = join(vendor, "views/vectors/v.json");
    const bytes = readFileSync(target);
    const flipped = Buffer.from(bytes);
    flipped[2] ^= 1;
    writeFileSync(target, flipped);
    const changed = vendorRun("--check");
    expect(changed.code).toBe(1);
    expect(changed.err).toContain("views/vectors/v.json differs");
    expect(readFileSync(target).equals(flipped)).toBe(true);
    writeFileSync(target, bytes);

    writeFileSync(join(vendor, "views/vectors/stale.json"), "{}\n");
    const extra = vendorRun("--check");
    expect(extra.code).toBe(1);
    expect(extra.err).toContain("views/vectors/stale.json is not in the build");
    rmSync(join(vendor, "views/vectors/stale.json"));

    writeFileSync(join(vendor, "dataset.bundle.json"), "{}\n");
    expect(vendorRun("--check").err).toContain("dataset.bundle.json differs");
  });
});
