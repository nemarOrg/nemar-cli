/**
 * The bundle packer (epic #2021 phase D3b, #2024; `src/lib/compute/pack.ts`): real folders on a real disk,
 * the real archive, and Python's own standard-library `tarfile` (3.9, under `uv run --no-project`) reading
 * it back. Nothing is stood in for.
 *
 * What is pinned:
 *  - what is left out (the ignore table) and what is counted as left out;
 *  - a symlink, a FIFO and a file over the file cap are left out, never followed or sent;
 *  - the Worker's caps are refused here, with the Worker's word, by the one shared rule: the file count,
 *    the per-file size, the running total, an unsafe path, a hidden traversal, an entry that is not there;
 *  - the same input makes the same bytes, whatever the clock, the file times or the folder's own name;
 *  - Python reads the archive and finds exactly the manifest's files, sizes, digests and modes.
 * The same refusals by the Worker itself, with the same constants, are `compute-pack-worker.test.ts`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomFillSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_TOTAL_BYTES,
  checkBundleManifest,
} from "../shared/contract/compute-bundle";
import { COMPUTE_SUBMIT_SENTENCES } from "../shared/contract/compute-submit";
import {
  type Collected,
  UnreadablePath,
  collectFile,
  collectFolder,
  gzipDeterministic,
  packCollected,
  parseIgnore,
  refuseCollected,
} from "../src/lib/compute/pack";

const root = mkdtempSync(join(tmpdir(), "nemar-pack-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function folder(files: Record<string, string> = {}): string {
  const dir = join(root, `f${++counter}`);
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

function collect(dir: string): Collected {
  const r = collectFolder(dir);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.collected;
}

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("what is left out", () => {
  test("the ignore table: .git, caches, virtual environments, node_modules, droppings and compiled files", () => {
    const dir = folder({
      "run.py": "print(1)\n",
      "lib/util.py": "x = 1\n",
      "lib/util.pyc": "compiled",
      ".git/config": "[core]",
      ".git/objects/aa/bb": "blob",
      "node_modules/pkg/index.js": "module.exports = 1",
      "__pycache__/run.cpython-312.pyc": "compiled",
      "lib/__pycache__/util.cpython-312.pyc": "compiled",
      ".pytest_cache/README.md": "cache",
      ".mypy_cache/x": "cache",
      ".ruff_cache/x": "cache",
      ".ipynb_checkpoints/x-checkpoint.ipynb": "{}",
      ".venv/lib/site.py": "venv",
      "venv/lib/site.py": "venv",
      "custom-env/pyvenv.cfg": "home = /usr/bin",
      "custom-env/lib/site.py": "venv",
      ".DS_Store": "junk",
      "Thumbs.db": "junk",
      "data/table.csv": "a,b\n",
    });
    const c = collect(dir);
    expect(c.files.map((f) => f.path)).toEqual(["data/table.csv", "lib/util.py", "run.py"]);
    expect(c.skipped.directories).toBe(11);
    expect(c.skipped.ignored).toBe(3);
  });

  test(".nemarignore: names at any depth, anchored paths, folders only, comments, and ** crossing folders", () => {
    const dir = folder({
      ".nemarignore": [
        "# scratch",
        "",
        "*.log",
        "scratch/",
        "/top.txt",
        "docs/*.md",
        "big/**/tmp",
        "secret?.txt",
      ].join("\n"),
      "keep.py": "1",
      "run.log": "x",
      "deep/run.log": "x",
      "scratch/a": "x",
      "deep/scratch/a": "x",
      "top.txt": "x",
      "deep/top.txt": "keep: anchored to the root only",
      "docs/a.md": "x",
      "docs/sub/b.md": "keep: * stays in one folder",
      "big/x/y/tmp": "x",
      "big/tmp": "x",
      "secret1.txt": "x",
      "secret12.txt": "keep: ? is one character",
    });
    expect(collect(dir).files.map((f) => f.path)).toEqual([
      ".nemarignore",
      "deep/top.txt",
      "docs/sub/b.md",
      "keep.py",
      "secret12.txt",
    ]);
  });

  test(".nemarignore errors name the line: negation, classes, a pattern that names nothing", () => {
    expect(parseIgnore("a\n!b\n[ab]\n/\n")).toEqual({
      ok: false,
      problems: [
        ".nemarignore:2: a pattern cannot start with ! (no negation)",
        ".nemarignore:3: a pattern is at most 200 characters with no [ ] classes or backslash",
        ".nemarignore:4: this pattern names nothing",
      ],
    });
    const dir = folder({ ".nemarignore": "!x\n", "a.py": "1" });
    const r = collectFolder(dir);
    expect(r.ok).toBe(false);
  });

  test("a symlink to a file, a symlink to a folder and a FIFO are left out and counted, never followed", () => {
    const dir = folder({ "run.py": "1", "real/data.txt": "x" });
    symlinkSync(join(dir, "real/data.txt"), join(dir, "link.txt"));
    symlinkSync(join(dir, "real"), join(dir, "linkdir"));
    symlinkSync("/etc/hostname", join(dir, "outside"));
    const fifo = Bun.spawnSync(["mkfifo", join(dir, "pipe")]);
    expect(fifo.exitCode).toBe(0);
    const c = collect(dir);
    expect(c.files.map((f) => f.path)).toEqual(["real/data.txt", "run.py"]);
    expect(c.skipped.symlinks).toBe(3);
    expect(c.skipped.special).toBe(1);
  });

  test("a file over the per-file cap is left out and listed; the entry that is over it is not in the bundle", () => {
    const dir = folder({ "run.py": "1" });
    const big = join(dir, "data.bin");
    writeFileSync(big, "");
    truncateSync(big, BUNDLE_MAX_FILE_BYTES + 1);
    const exact = join(dir, "exact.bin");
    writeFileSync(exact, "");
    truncateSync(exact, BUNDLE_MAX_FILE_BYTES);
    const c = collect(dir);
    expect(c.skipped.tooLarge).toEqual([{ path: "data.bin", size: BUNDLE_MAX_FILE_BYTES + 1 }]);
    expect(c.files.map((f) => f.path)).toEqual(["exact.bin", "run.py"]);
    expect(refuseCollected(c, { entry: "data.bin" })?.code).toBe("entry_not_in_bundle");
    expect(refuseCollected(c, { entry: "run.py" })).toBeNull();
  });

  test("a single file is a bundle of that file alone", () => {
    const dir = folder({ "a.py": "1", "b.py": "2" });
    const c = collectFile(join(dir, "a.py"));
    expect(c.files.map((f) => f.path)).toEqual(["a.py"]);
  });
});

describe("the Worker's caps, refused here with the Worker's word", () => {
  const sizes = (n: number, size = 1): Collected => ({
    files: Array.from({ length: n }, (_, i) => ({
      path: `f${String(i).padStart(5, "0")}.py`,
      abs: "/nonexistent",
      size,
      executable: false,
    })),
    skipped: { symlinks: 0, special: 0, ignored: 0, directories: 0, tooLarge: [] },
    overFileCap: false,
  });

  test("the file count: the cap passes, one more is bundle_too_many_files with the Worker's sentence", () => {
    expect(refuseCollected(sizes(BUNDLE_MAX_FILES))).toBeNull();
    const refusal = refuseCollected(sizes(BUNDLE_MAX_FILES + 1));
    expect(refusal?.code).toBe("bundle_too_many_files");
    expect(refusal?.message).toBe(COMPUTE_SUBMIT_SENTENCES.bundle_too_many_files);
  });

  test("a real folder of 2,001 files stops the walk at the cap and is refused", () => {
    const dir = join(root, "many");
    mkdirSync(dir);
    for (let i = 0; i < BUNDLE_MAX_FILES + 1; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
    const c = collect(dir);
    expect(c.overFileCap).toBe(true);
    expect(refuseCollected(c)?.code).toBe("bundle_too_many_files");
  });

  test("the running total: the cap passes, one byte more is bundle_too_large and names the five largest", () => {
    const at = sizes(4, 25 * 1024 * 1024);
    expect(BUNDLE_MAX_TOTAL_BYTES).toBe(4 * BUNDLE_MAX_FILE_BYTES);
    expect(refuseCollected(at)).toBeNull();
    const over = sizes(5, BUNDLE_MAX_FILE_BYTES);
    (over.files[2] as { size: number }).size = BUNDLE_MAX_FILE_BYTES - 5;
    const refusal = refuseCollected(over);
    expect(refusal?.code).toBe("bundle_too_large");
    expect(refusal?.largest).toHaveLength(5);
    expect(refusal?.largest?.[4]).toEqual({ path: "f00002.py", size: BUNDLE_MAX_FILE_BYTES - 5 });
  });

  test("a path the contract refuses is named; a percent-encoded traversal is refused as the records bucket does", () => {
    const control = sizes(1);
    (control.files[0] as { path: string }).path = "bad\u0007name.py";
    expect(refuseCollected(control)).toMatchObject({
      code: "invalid_spec",
      path: "bad\u0007name.py",
    });
    const back = sizes(1);
    (back.files[0] as { path: string }).path = "a\\b.py";
    expect(refuseCollected(back)?.code).toBe("invalid_spec");
    const long = sizes(1);
    (long.files[0] as { path: string }).path = `${"d/".repeat(120)}x.py`;
    expect(refuseCollected(long)?.code).toBe("invalid_spec");
    for (const hidden of [
      "%2e%2e/x.py",
      "a/%2e%2e/x.py",
      "%2fetc/x.py",
      "%252e%252e/x.py",
      "a%5cb.py",
    ]) {
      const c = sizes(1);
      (c.files[0] as { path: string }).path = hidden;
      expect(refuseCollected(c)).toMatchObject({ code: "invalid_spec", path: hidden });
    }
    const fine = sizes(1);
    (fine.files[0] as { path: string }).path = "100%-sure.py";
    expect(refuseCollected(fine)).toBeNull();
  });

  test("the entry must be one of the files; an empty folder is not a bundle", () => {
    expect(refuseCollected(sizes(2), { entry: "nope.py" })?.code).toBe("entry_not_in_bundle");
    expect(refuseCollected(sizes(2), { entry: "f00001.py" })).toBeNull();
    expect(refuseCollected(sizes(0))?.code).toBe("empty_bundle");
  });

  test("the refusal is the shared rule's: for each case the word is checkBundleManifest's own", () => {
    const cases: Array<[Collected, string | undefined]> = [
      [sizes(BUNDLE_MAX_FILES + 1), undefined],
      [sizes(5, BUNDLE_MAX_FILE_BYTES), undefined],
      [sizes(2), "nope.py"],
    ];
    for (const [c, entry] of cases) {
      const shared = checkBundleManifest(
        c.files.map((f) => ({ path: f.path, size: f.size, sha256: "0".repeat(64) })),
        undefined,
        entry,
      );
      expect(shared.ok).toBe(false);
      expect(refuseCollected(c, entry ? { entry } : {})?.code).toBe(shared.ok ? null : shared.code);
    }
  });

  test("an archive over the cap is refused after it is built (the cap is a parameter of the one rule)", () => {
    const dir = folder({});
    const bytes = new Uint8Array(1500);
    randomFillSync(bytes);
    writeFileSync(join(dir, "random.bin"), bytes);
    writeFileSync(join(dir, "run.py"), "1");
    const limits = { maxTotalBytes: 1600, maxFiles: 10, maxFileBytes: 2000 };
    const r = packCollected(collect(dir), { entry: "run.py", limits });
    expect(r).toMatchObject({
      ok: false,
      reason: "refused",
      refusal: { code: "bundle_too_large" },
    });
  });
});

describe("the archive is deterministic", () => {
  const tree = {
    "run.py": "print('hello')\n",
    "lib/util.py": "x = 1\n",
    "lib/deep/er/mod.py": "y = 2\n",
    "data/table.csv": "a,b\n1,2\n",
  };

  test("the same files make the same bytes: later, with other file times, in another folder", async () => {
    const a = folder(tree);
    const first = packCollected(collect(a), { entry: "run.py" });
    await Bun.sleep(1100);
    for (const p of Object.keys(tree)) {
      const t = new Date(1_500_000_000_000 + Math.floor(Math.random() * 1e9));
      utimesSync(join(a, p), t, t);
    }
    const again = packCollected(collect(a), { entry: "run.py" });
    const b = folder(tree);
    const elsewhere = packCollected(collect(b), { entry: "run.py" });
    for (const r of [first, again, elsewhere]) expect(r.ok).toBe(true);
    if (!first.ok || !again.ok || !elsewhere.ok) return;
    expect(Buffer.from(again.bundle.archive).equals(Buffer.from(first.bundle.archive))).toBe(true);
    expect(Buffer.from(elsewhere.bundle.archive).equals(Buffer.from(first.bundle.archive))).toBe(
      true,
    );
    expect(first.bundle.sha256).toBe(elsewhere.bundle.sha256);
    expect(first.bundle.sha256).toBe(sha(first.bundle.archive));
    expect(first.bundle.size).toBe(first.bundle.archive.length);
  });

  test("the gzip header carries no time and no operating system; a changed byte changes the digest", () => {
    const r = packCollected(collect(folder(tree)), { entry: "run.py" });
    if (!r.ok) throw new Error("not packed");
    const head = r.bundle.archive.subarray(0, 10);
    expect([...head.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect([...head.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(head[9]).toBe(0xff);
    const other = packCollected(collect(folder({ ...tree, "run.py": "print('bye')\n" })), {
      entry: "run.py",
    });
    expect(other.ok && other.bundle.sha256 !== r.bundle.sha256).toBe(true);
  });

  test("gzipDeterministic round-trips", () => {
    const data = new TextEncoder().encode("abc".repeat(1000));
    expect(Buffer.from(Bun.gunzipSync(gzipDeterministic(data))).equals(Buffer.from(data))).toBe(
      true,
    );
  });
});

/** The archive read by Python 3.9's standard library, as JSON on its standard output. */
function readWithPython(archive: Uint8Array): Array<Record<string, unknown>> {
  const path = join(root, `a${++counter}.tar.gz`);
  writeFileSync(path, archive);
  const script = [
    "import hashlib, json, sys, tarfile",
    "out = []",
    "with tarfile.open(sys.argv[1], 'r:gz', encoding='utf-8') as t:",
    "    for m in t:",
    "        d = {'name': m.name, 'size': m.size, 'mode': m.mode, 'uid': m.uid, 'gid': m.gid,",
    "             'uname': m.uname, 'gname': m.gname, 'mtime': m.mtime, 'isreg': m.isreg(), 'isdir': m.isdir()}",
    "        if m.isreg():",
    "            d['sha256'] = hashlib.sha256(t.extractfile(m).read()).hexdigest()",
    "        out.append(d)",
    "print(json.dumps(out))",
  ].join("\n");
  const run = Bun.spawnSync(
    ["uv", "run", "--no-project", "--python", "3.9", "python", "-I", "-c", script, path],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (run.exitCode !== 0) throw new Error(`python failed: ${run.stderr.toString()}`);
  return JSON.parse(run.stdout.toString());
}

describe("Python's tarfile (3.9) reads the archive back", () => {
  test("regular files and folders only, sorted, owner and times zero, the manifest matches the contents", () => {
    const dir = folder({
      "run.py": "print(1)\n",
      "lib/util.py": "x = 1\n",
      "lib/deep/mod.py": "y = 2\n",
      "data/table.csv": "a,b\n",
      "empty.txt": "",
    });
    chmodSync(join(dir, "run.py"), 0o755);
    const r = packCollected(collect(dir), { entry: "run.py" });
    if (!r.ok) throw new Error("not packed");
    const members = readWithPython(r.bundle.archive);

    expect(members.every((m) => m.isreg === true || m.isdir === true)).toBe(true);
    expect(members.map((m) => m.name)).toEqual([
      "data",
      "data/table.csv",
      "empty.txt",
      "lib",
      "lib/deep",
      "lib/deep/mod.py",
      "lib/util.py",
      "run.py",
    ]);
    for (const m of members) {
      expect([m.uid, m.gid, m.mtime, m.uname, m.gname]).toEqual([0, 0, 0, "", ""]);
    }
    expect(members.find((m) => m.name === "run.py")?.mode).toBe(0o755);
    expect(members.find((m) => m.name === "lib/util.py")?.mode).toBe(0o644);
    expect(members.find((m) => m.name === "lib")?.mode).toBe(0o755);

    const regular = members.filter((m) => m.isreg);
    expect(regular.map((m) => ({ path: m.name, size: m.size, sha256: m.sha256 }))).toEqual(
      r.bundle.manifest.files,
    );
    expect(r.bundle.manifest.files.map((f) => f.path)).toEqual(
      [...r.bundle.manifest.files.map((f) => f.path)].sort(),
    );
    expect(r.bundle.contentBytes).toBe(
      "print(1)\n".length + "x = 1\n".length + "y = 2\n".length + "a,b\n".length,
    );
  });

  test("a long path (split over the ustar prefix) and non-ASCII names survive", () => {
    const longDir = `${"d".repeat(50)}/${"e".repeat(50)}/${"f".repeat(50)}`;
    const files = {
      [`${longDir}/${"n".repeat(50)}.py`]: "long\n",
      "résumé/données-ß.py": "utf8\n",
      "run.py": "1",
    };
    const r = packCollected(collect(folder(files)), { entry: "run.py" });
    if (!r.ok) throw new Error("not packed");
    const names = readWithPython(r.bundle.archive)
      .filter((m) => m.isreg)
      .map((m) => m.name);
    expect(names).toEqual(r.bundle.manifest.files.map((f) => f.path));
    expect(names).toContain(`${longDir}/${"n".repeat(50)}.py`);
    expect(names).toContain("résumé/données-ß.py");
  });

  test("a single segment too long for ustar is refused naming the path", () => {
    const dir = folder({ "run.py": "1", [`d/${"x".repeat(120)}.py`]: "1" });
    const r = packCollected(collect(dir), { entry: "run.py" });
    expect(r).toMatchObject({ ok: false, reason: "refused", refusal: { code: "invalid_spec" } });
  });

  test("a file that is read is the file that is packed: the inspector sees the exact bytes", () => {
    const dir = folder({ "run.py": "print(1)\n", "a.txt": "needle" });
    const seen: Array<[string, string]> = [];
    const r = packCollected(collect(dir), {
      entry: "run.py",
      inspect: (path, bytes) => {
        seen.push([path, new TextDecoder().decode(bytes)]);
        return path === "a.txt" ? 1 : 0;
      },
    });
    expect(seen).toEqual([
      ["a.txt", "needle"],
      ["run.py", "print(1)\n"],
    ]);
    expect(r).toEqual({ ok: false, reason: "inspected", inspected: 1 });
  });
});

describe("a file that cannot be read says so by its relative path", () => {
  test("a file that vanishes between listing and reading", () => {
    const dir = folder({ "run.py": "1", "lib/gone.py": "2" });
    const listed = collect(dir);
    unlinkSync(join(dir, "lib/gone.py"));
    let thrown: unknown;
    try {
      packCollected(listed, { entry: "run.py" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnreadablePath);
    expect((thrown as UnreadablePath).path).toBe("lib/gone.py");
    expect((thrown as Error).message).not.toContain(dir);
  });

  test("a folder that is not there, and a file named that is not there", () => {
    expect(() => collectFolder(join(root, "no-such-folder"))).toThrow(UnreadablePath);
    expect(() => collectFile(join(root, "no-such.py"))).toThrow(UnreadablePath);
  });
});
