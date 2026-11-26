/**
 * Real git repositories for the `nemar dataset screen` tests (card A9).
 *
 * Every repository is a real one built in a temp directory: real commits, real symlinks, real
 * EDF headers made byte for byte from INVENTED values. An annexed file is laid out the way
 * git-annex lays it out (a symlink into `.git/annex/objects/<xx>/<yy>/<key>/<key>`, or a one-line
 * pointer file), with the object store written directly, so a test can leave a file's content
 * present or absent and nothing is replaced.
 */

import { createHash } from "node:crypto";
import {
  type Dirent,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function put(out: Uint8Array, text: string, start: number, width: number): void {
  out.fill(0x20, start, start + width);
  out.set(new TextEncoder().encode(text).subarray(0, width), start);
}

/** A 256-byte EDF header holding `patient`, dated `start` (dd.mm.yy). */
export function edfHeader(patient = "P01 F X X", start = "01.01.85"): Uint8Array {
  const out = new Uint8Array(256).fill(0x20);
  put(out, "0", 0, 8);
  put(out, patient, 8, 80);
  put(out, "Startdate X X X X", 88, 80);
  put(out, start, 168, 8);
  put(out, "00.00.00", 176, 8);
  put(out, "256", 184, 8);
  put(out, "-1", 236, 8);
  put(out, "1", 244, 8);
  put(out, "0", 252, 4);
  return out;
}

/** A recording: a header and then signal bytes, so it is bigger than any pointer file. */
export function recording(patient?: string, start?: string): Uint8Array {
  const out = new Uint8Array(2000);
  out.set(edfHeader(patient, start));
  return out;
}

/** The name the tests plant in headers and paths; no output may ever carry it. */
export const NAME = "Quillfeather";
export const CLEAN = "P01 F X X";
export const named = (n: number) => `P0${n} F X ${NAME}`;

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString().slice(0, 200)}`);
  }
  return result.stdout.toString().trim();
}

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const scratch: string[] = [];

export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dataset-screen-${label}-`));
  scratch.push(dir);
  return dir;
}

/** Remove every directory this helper made; call it from `afterAll`. */
export function cleanScratch(): void {
  for (const dir of scratch.splice(0)) {
    // git-annex makes its objects and their directories read-only.
    Bun.spawnSync(["chmod", "-R", "u+rwX", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

export class Repo {
  readonly dir: string;

  /** `git: false` makes a plain directory, as a deposit that was never under version control. */
  constructor(label = "repo", options: { git?: boolean } = {}) {
    this.dir = tempDir(label);
    if (options.git === false) return;
    git(this.dir, "init", "-q", "-b", "main");
    git(this.dir, "config", "user.name", "Test");
    git(this.dir, "config", "user.email", "test@example.invalid");
    git(this.dir, "config", "uploadpack.allowFilter", "true");
    git(this.dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  }

  get origin(): string {
    return `file://${this.dir}`;
  }

  file(path: string, content: string | Uint8Array): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return this;
  }

  remove(path: string): this {
    rmSync(join(this.dir, path), { force: true });
    return this;
  }

  /** The key git-annex would give `bytes` stored under a file called `path` (or `keyExt`). */
  keyOf(path: string, bytes: Uint8Array, keyExt?: string): string {
    const ext = keyExt ?? path.slice(path.lastIndexOf("."));
    return `SHA256E-s${bytes.length}--${sha256(bytes)}${ext}`;
  }

  /** Put `bytes` in the object store under `key`, in a hash directory the code must not assume. */
  storeObject(key: string, bytes: Uint8Array): void {
    const path = join(this.dir, ".git", "annex", "objects", "Xz", "Qk", key, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  /**
   * A locked annexed file: a symlink into the object store. `content: false` leaves the object
   * out, as a clone does before `git annex get`.
   */
  annexLink(
    path: string,
    bytes: Uint8Array,
    options: { content?: boolean; keyExt?: string } = {},
  ): string {
    const key = this.keyOf(path, bytes, options.keyExt);
    if (options.content !== false) this.storeObject(key, bytes);
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    const depth = path.split("/").length - 1;
    symlinkSync(`${"../".repeat(depth)}.git/annex/objects/Xz/Qk/${key}/${key}`, full);
    return key;
  }

  /** An unlocked annexed file that is still a pointer: one line naming the key. */
  annexPointer(
    path: string,
    bytes: Uint8Array,
    options: { content?: boolean; keyExt?: string } = {},
  ): string {
    const key = this.keyOf(path, bytes, options.keyExt);
    if (options.content !== false) this.storeObject(key, bytes);
    this.file(path, `/annex/objects/${key}\n`);
    return key;
  }

  commit(message = "c"): string {
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "--allow-empty", "-m", message);
    return git(this.dir, "rev-parse", "HEAD");
  }
}

/**
 * A digest of everything under `dir`, `.git` included: every path, every file's bytes, every
 * link's target. Two digests are equal only when nothing was added, removed, changed or rewritten
 * (an index refresh, a new object, a lock file, a config line).
 */
export function digestTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (rel: string) => {
    const entries: Dirent[] = readdirSync(join(dir, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const full = join(dir, path);
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) {
        hash.update(`L ${path} ${readlinkSync(full)}\n`);
      } else if (stats.isDirectory()) {
        hash.update(`D ${path}\n`);
        walk(path);
      } else {
        hash.update(`F ${path} ${stats.size} ${sha256(readFileSync(full))}\n`);
      }
    }
  };
  walk("");
  return hash.digest("hex");
}
