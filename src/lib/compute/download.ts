/**
 * Downloading a finished job's results into a folder the person named (epic #2021 phase D3b, #2024).
 *
 * The folder is theirs and the paths and links come from the network, so every decision about what is
 * written is made HERE, on this machine:
 *  - a path must be relative, without `..`, an empty segment, a backslash, a control character or a drive
 *    letter ({@link safeResultPath}); then the destination, and the deepest folder of it that already exists,
 *    must resolve (through any symbolic link) to a place inside the folder; the destination and its
 *    `.part` file must not be symbolic links, so nothing is ever written outside;
 *  - a file already there with the recorded size and SHA-256 is left alone; one that DIFFERS is not
 *    overwritten unless `force`;
 *  - the link must be `https:` (loopback `http:` only, see `store-url.ts`), is fetched with no NEMAR
 *    credential, no redirect followed, a time to connect, a stall timeout between chunks and a total, and
 *    never more bytes than the recorded size;
 *  - bytes go to `<name>.part`, are counted and hashed, and only a file of exactly the recorded size and
 *    SHA-256 is renamed into place; a `.part` this call made is deleted on ANY failure, and one it did not
 *    make (a folder, a link) is never touched.
 * Every failure is a value (`{ status: "failed", reason }`) naming a fixed reason: never a path from the
 * system's error text and never the link, which is a bearer secret.
 */

import { createHash } from "node:crypto";
import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { isSafeComputePath } from "../../../shared/contract/compute.js";
import { isStoreUrlAllowed } from "./store-url.js";

export interface ResultFile {
  path: string;
  size: number;
  sha256: string;
  url: string;
}

export type DownloadResult =
  | { status: "fetched" }
  | { status: "skipped" }
  | { status: "failed"; reason: string };

export interface DownloadOptions {
  /** Replace a file that exists and differs. */
  force?: boolean;
  /** Time to get the response headers. */
  connectMs?: number;
  /** Longest silence between two chunks. */
  stallMs?: number;
  /** The whole download; by default scaled to the size. */
  totalMs?: number;
}

/**
 * Whether a result path may be written under the download folder: relative, no `..`, no empty segment, no
 * backslash or control character, no drive letter.
 */
export function safeResultPath(path: string): boolean {
  return isSafeComputePath(path, 1024) && !/^[A-Za-z]:/.test(path);
}

/**
 * The path claimed earlier by a result whose name is the same file on a case-insensitive (or
 * Unicode-normalizing) disk, or null; records `path` when it is the first of its kind.
 */
export function caseCollision(claimed: Map<string, string>, path: string): string | null {
  const key = path.normalize("NFC").toLowerCase();
  const earlier = claimed.get(key);
  if (earlier === undefined) claimed.set(key, path);
  return earlier ?? null;
}

const fail = (reason: string): DownloadResult => ({ status: "failed", reason });

/** A fixed sentence for a system error, so no path or text of the system's own is ever shown. */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EISDIR":
      return "a folder is in the way";
    case "ENOTDIR":
    case "EEXIST":
      return "a file is in the way of a folder";
    case "ENOSPC":
      return "no space left on the disk";
    case "ENOENT":
      return "a file or folder disappeared";
    case "EROFS":
      return "the disk is read-only";
    default:
      return "the file could not be written";
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const inside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root + sep);

/** The deepest existing ancestor of `path` (a folder), `path` itself included. */
function deepestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

export async function downloadOne(
  dir: string,
  file: ResultFile,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  if (!safeResultPath(file.path)) return fail("the path is not one that may be written");
  if (!isStoreUrlAllowed(file.url)) return fail("the link is not an https address");
  const root = resolve(dir);
  const dest = resolve(root, file.path);
  if (!dest.startsWith(root + sep)) return fail("the path leaves the download folder");
  const part = `${dest}.part`;
  let madePart = false;
  try {
    mkdirSync(root, { recursive: true });
    const realRoot = realpathSync(root);
    // Nothing is created until the deepest folder that exists already resolves inside the folder.
    if (!inside(realRoot, realpathSync(deepestExisting(dirname(dest))))) {
      return fail("the path goes through a symbolic link out of the download folder");
    }
    mkdirSync(dirname(dest), { recursive: true });
    if (!inside(realRoot, realpathSync(dirname(dest)))) {
      return fail("the path goes through a symbolic link out of the download folder");
    }

    const there = lstatOrNull(dest);
    if (there !== null) {
      if (there.isSymbolicLink()) return fail("a symbolic link is in the way");
      if (!there.isFile()) return fail("a folder is in the way");
      if (there.size === file.size && sha256File(dest) === file.sha256)
        return { status: "skipped" };
      if (options.force !== true) return fail("exists and differs; use --force");
    }
    const stale = lstatOrNull(part);
    if (stale !== null && (stale.isSymbolicLink() || !stale.isFile())) {
      return fail("a file named like the temporary file is in the way");
    }

    const total =
      options.totalMs ?? Math.min(24 * 3_600_000, 600_000 + Math.ceil(file.size / 262_144) * 1000);
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), total);
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(),
      options.connectMs ?? 30_000,
    );
    const stall = options.stallMs ?? 60_000;
    const handle = await open(part, "w");
    madePart = true;
    try {
      // No credential of ours goes to the store, and a redirect is an error: the link is the authority.
      const response = await fetch(file.url, { redirect: "error", signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok || response.body === null) return fail(`HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > file.size) {
        return fail("the file is larger than NEMAR said");
      }
      const hash = createHash("sha256");
      let bytes = 0;
      const reader = response.body.getReader();
      for (;;) {
        timer = setTimeout(() => controller.abort(), stall);
        const { done, value } = await reader.read();
        clearTimeout(timer);
        if (done) break;
        bytes += value.length;
        if (bytes > file.size) {
          await reader.cancel().catch(() => undefined);
          return fail("the file is larger than NEMAR said");
        }
        hash.update(value);
        let at = 0;
        while (at < value.length) {
          const { bytesWritten } = await handle.write(value, at, value.length - at);
          if (bytesWritten === 0) throw Object.assign(new Error("short write"), { code: "ENOSPC" });
          at += bytesWritten;
        }
      }
      await handle.close();
      if (bytes !== file.size || hash.digest("hex") !== file.sha256) {
        return fail("the size or checksum did not match");
      }
      if (lstatSync(part).size !== file.size) return fail("the size or checksum did not match");
      renameSync(part, dest);
      madePart = false;
      return { status: "fetched" };
    } catch (error) {
      if (controller.signal.aborted) return fail("the download stalled or took too long");
      // The error text of a failed fetch can name the link, which is a bearer secret: it is not kept.
      return fail(error instanceof TypeError ? "the download failed" : reasonOf(error));
    } finally {
      clearTimeout(timer);
      clearTimeout(totalTimer);
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    return fail(reasonOf(error));
  } finally {
    if (madePart) rmSync(part, { force: true });
  }
}
