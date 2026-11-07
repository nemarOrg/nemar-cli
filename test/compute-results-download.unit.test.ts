/**
 * Downloading a job's results safely (epic #2021 phase D3b, #2024; `src/lib/compute/download.ts`, and the
 * log helpers of `src/commands/compute-jobs.ts`): real files written to a real temporary folder from a real
 * HTTP server. The links are bearer links and the paths come from the network, so the folder is the
 * person's and what is written into it is decided here: a path that is absolute or contains `..` is
 * refused; nothing is written outside the folder through a symbolic link; a file that does not match its
 * recorded size and SHA-256 is deleted; an unchanged file is left alone and a DIFFERENT one is not
 * overwritten without `force`; a `.part` that is a folder, a link or unwritable is a per-file failure, not a
 * crash; a redirect, a plain-http link, a stalled or oversized body are refused; no NEMAR credential is
 * sent. Through the real Worker the commands are `compute-user-e2e-cli.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastLines, plainLog } from "../src/commands/compute-jobs";
import { caseCollision, downloadOne, safeResultPath } from "../src/lib/compute/download";
import { isStoreUrlAllowed } from "../src/lib/compute/store-url";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const served = new Map<string, string>();
let sentHeaders: Record<string, string>[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    sentHeaders.push(headers);
    const path = new URL(req.url).pathname;
    if (path === "/redirect")
      return Response.redirect(`http://127.0.0.1:${server.port}/ok.txt`, 302);
    if (path === "/stall") {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("abc"));
          // then silence: the body never ends
        },
      });
      return new Response(stream, { headers: { "content-length": "10" } });
    }
    if (path === "/slow-headers") {
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response("late")), 2000),
      );
    }
    const body = served.get(path);
    return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
  },
});
afterAll(() => server.stop(true));

let dir: string;
let outside: string;
beforeEach(() => {
  served.clear();
  sentHeaders = [];
  dir = mkdtempSync(join(tmpdir(), "nemar-dl-"));
  outside = mkdtempSync(join(tmpdir(), "nemar-dl-outside-"));
});

const file = (
  path: string,
  content: string,
  over: Partial<{ size: number; sha256: string }> = {},
) => {
  served.set(`/${path}`, content);
  return {
    path,
    size: over.size ?? Buffer.byteLength(content),
    sha256: over.sha256 ?? sha(content),
    url: `http://127.0.0.1:${server.port}/${path}?X-Amz-Signature=abc`,
  };
};
const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;

describe("which paths may be written", () => {
  test("relative paths are; absolute, .., empty segments, backslashes, control characters and drive letters are not", () => {
    for (const ok of ["a.txt", "deep/er/table.csv", "100%.txt", "résumé.txt", "a b/c.txt"]) {
      expect(safeResultPath(ok)).toBe(true);
    }
    for (const bad of [
      "/etc/passwd",
      "../x",
      "a/../../x",
      "a/./b",
      "a//b",
      "a\\b",
      "C:\\x",
      "C:x",
      "bad\u0007.txt",
      "",
      "a/",
    ]) {
      expect([bad, safeResultPath(bad)]).toEqual([bad, false]);
    }
  });

  test("a refused path writes nothing and asks for nothing", async () => {
    for (const path of ["/abs.txt", "../escape.txt", "a/../../escape.txt"]) {
      const out = await downloadOne(dir, { path, size: 1, sha256: sha("x"), url: at("/x") });
      expect(out).toEqual({ status: "failed", reason: "the path is not one that may be written" });
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(sentHeaders).toEqual([]);
  });
});

describe("a download is verified", () => {
  test("good bytes land in place, nested folders are made, and no NEMAR credential is sent", async () => {
    const f = file("deep/table.csv", "a,b\n1,2\n");
    expect(await downloadOne(dir, f)).toEqual({ status: "fetched" });
    expect(readFileSync(join(dir, "deep/table.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(readdirSync(join(dir, "deep"))).toEqual(["table.csv"]);
    expect(sentHeaders[0]?.authorization).toBeUndefined();
    expect(sentHeaders[0]?.["x-cli-version"]).toBeUndefined();
  });

  test("bytes that differ (same length), fewer or more than recorded are deleted and reported", async () => {
    const wrong = file("same.txt", "thE report\n", { sha256: sha("the report\n"), size: 11 });
    expect(await downloadOne(dir, wrong)).toEqual({
      status: "failed",
      reason: "the size or checksum did not match",
    });
    const short = file("short.txt", "abc", { size: 10, sha256: sha("abc") });
    expect(await downloadOne(dir, short)).toEqual({
      status: "failed",
      reason: "the size or checksum did not match",
    });
    const long = file("long.txt", "abcdefghij", { size: 3, sha256: sha("abc") });
    expect(await downloadOne(dir, long)).toEqual({
      status: "failed",
      reason: "the file is larger than NEMAR said",
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a store that says no, and one that cannot be reached, are reported without the link", async () => {
    const gone = {
      path: "gone.txt",
      size: 1,
      sha256: sha("x"),
      url: at("/absent?X-Amz-Signature=abc"),
    };
    expect(await downloadOne(dir, gone)).toEqual({ status: "failed", reason: "HTTP 404" });
    const dead = await downloadOne(dir, {
      ...gone,
      url: "http://127.0.0.1:1/x?X-Amz-Signature=abc",
    });
    expect(dead).toEqual({ status: "failed", reason: "the download failed" });
    expect(JSON.stringify(dead)).not.toContain("127.0.0.1");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("a file that is already there", () => {
  test("the same size and checksum is left alone and nothing is fetched", async () => {
    const f = file("r.txt", "the report\n");
    writeFileSync(join(dir, "r.txt"), "the report\n");
    expect(await downloadOne(dir, f)).toEqual({ status: "skipped" });
    expect(sentHeaders).toEqual([]);
  });

  test("a different one is NOT overwritten without force, and is replaced with it", async () => {
    const f = file("r.txt", "the report\n");
    writeFileSync(join(dir, "r.txt"), "my own notes\n");
    expect(await downloadOne(dir, f)).toEqual({
      status: "failed",
      reason: "exists and differs; use --force",
    });
    expect(readFileSync(join(dir, "r.txt"), "utf8")).toBe("my own notes\n");
    expect(sentHeaders).toEqual([]);
    expect(await downloadOne(dir, f, { force: true })).toEqual({ status: "fetched" });
    expect(readFileSync(join(dir, "r.txt"), "utf8")).toBe("the report\n");
  });
});

describe("the temporary file and the folder tree", () => {
  test("a folder named like the .part is a per-file failure, left where it is", async () => {
    const f = file("r.txt", "the report\n");
    mkdirSync(join(dir, "r.txt.part"));
    writeFileSync(join(dir, "r.txt.part", "mine.txt"), "keep");
    expect(await downloadOne(dir, f)).toEqual({
      status: "failed",
      reason: "a file named like the temporary file is in the way",
    });
    expect(readFileSync(join(dir, "r.txt.part", "mine.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(dir, "r.txt"))).toBe(false);
  });

  test("an unwritable .part is a per-file failure, not a crash, and is not deleted", async () => {
    const f = file("r.txt", "the report\n");
    writeFileSync(join(dir, "r.txt.part"), "stale");
    chmodSync(join(dir, "r.txt.part"), 0o000);
    try {
      const out = await downloadOne(dir, f);
      if (process.getuid?.() === 0) expect(out.status).toBe("fetched");
      else expect(out).toEqual({ status: "failed", reason: "permission denied" });
    } finally {
      chmodSync(join(dir, "r.txt.part"), 0o644);
    }
    expect(existsSync(join(dir, "r.txt"))).toBe(false);
  });

  test("a stale readable .part is replaced and no .part is left behind", async () => {
    const f = file("r.txt", "the report\n");
    writeFileSync(join(dir, "r.txt.part"), "stale bytes that are longer than the file");
    expect(await downloadOne(dir, f)).toEqual({ status: "fetched" });
    expect(readdirSync(dir)).toEqual(["r.txt"]);
  });

  test("a symbolic link as the .part or as the destination is refused and followed nowhere", async () => {
    const f = file("r.txt", "the report\n");
    const target = join(outside, "victim.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, "r.txt.part"));
    expect((await downloadOne(dir, f)).status).toBe("failed");
    rmSync(join(dir, "r.txt.part"));
    symlinkSync(target, join(dir, "r.txt"));
    expect(await downloadOne(dir, f, { force: true })).toEqual({
      status: "failed",
      reason: "a symbolic link is in the way",
    });
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  test("a result path through a link to somewhere else writes nothing there", async () => {
    const f = file("link/x.txt", "the report\n");
    symlinkSync(outside, join(dir, "link"));
    expect(await downloadOne(dir, f)).toEqual({
      status: "failed",
      reason: "the path goes through a symbolic link out of the download folder",
    });
    expect(readdirSync(outside)).toEqual([]);
    // also when the folder under the link does not exist yet
    const g = file("link/new/y.txt", "x");
    expect((await downloadOne(dir, g)).status).toBe("failed");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a file where a folder is needed fails that file and the next one still downloads", async () => {
    const a = file("a.txt", "one");
    const ab = file("a.txt/b.txt", "two");
    const c = file("c.txt", "three");
    expect((await downloadOne(dir, a)).status).toBe("fetched");
    expect(await downloadOne(dir, ab)).toEqual({
      status: "failed",
      reason: "a file is in the way of a folder",
    });
    expect((await downloadOne(dir, c)).status).toBe("fetched");
  });

  test("a download folder that does not exist yet is made", async () => {
    expect((await downloadOne(join(dir, "new", "out"), file("a.txt", "one"))).status).toBe(
      "fetched",
    );
  });
});

describe("the link", () => {
  test("only https, or http to this machine", () => {
    expect(isStoreUrlAllowed("https://store.example.org/x?X-Amz-Signature=a")).toBe(true);
    expect(isStoreUrlAllowed("http://127.0.0.1:9/x")).toBe(true);
    expect(isStoreUrlAllowed("http://localhost/x")).toBe(true);
    expect(isStoreUrlAllowed("http://store.example.org/x")).toBe(false);
    expect(isStoreUrlAllowed("ftp://store.example.org/x")).toBe(false);
    expect(isStoreUrlAllowed("not a url")).toBe(false);
  });

  test("a plain-http link to another host is refused before anything is fetched", async () => {
    const out = await downloadOne(dir, {
      path: "a.txt",
      size: 1,
      sha256: sha("x"),
      url: "http://store.example.org/a",
    });
    expect(out).toEqual({ status: "failed", reason: "the link is not an https address" });
    expect(sentHeaders).toEqual([]);
  });

  test("a redirect is not followed", async () => {
    served.set("/ok.txt", "the report\n");
    const out = await downloadOne(dir, {
      path: "a.txt",
      size: 11,
      sha256: sha("the report\n"),
      url: at("/redirect"),
    });
    expect(out).toEqual({ status: "failed", reason: "the download failed" });
    expect(sentHeaders.map((h) => h.host)).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a body that stalls is cut off after the stall time and leaves nothing", async () => {
    const out = await downloadOne(
      dir,
      { path: "a.txt", size: 10, sha256: sha("x"), url: at("/stall") },
      { stallMs: 300 },
    );
    expect(out).toEqual({ status: "failed", reason: "the download stalled or took too long" });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("headers that never come are cut off after the connect time", async () => {
    const out = await downloadOne(
      dir,
      { path: "a.txt", size: 4, sha256: sha("late"), url: at("/slow-headers") },
      { connectMs: 200 },
    );
    expect(out).toEqual({ status: "failed", reason: "the download stalled or took too long" });
  });

  test("a body longer than the recorded size is refused (by its declared length, or as soon as it exceeds it)", async () => {
    served.set("/big", "abcdefghij");
    const out = await downloadOne(dir, {
      path: "a.txt",
      size: 3,
      sha256: sha("abc"),
      url: at("/big"),
    });
    expect(out).toEqual({ status: "failed", reason: "the file is larger than NEMAR said" });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("two names for one file on a case-insensitive disk", () => {
  test("the later one is the collision", () => {
    const claimed = new Map<string, string>();
    expect(caseCollision(claimed, "A.txt")).toBeNull();
    expect(caseCollision(claimed, "b.txt")).toBeNull();
    expect(caseCollision(claimed, "a.txt")).toBe("A.txt");
    expect(caseCollision(claimed, "dir/X.csv")).toBeNull();
    expect(caseCollision(claimed, "DIR/x.csv")).toBe("dir/X.csv");
    // composed and decomposed forms of one name
    expect(caseCollision(claimed, "caf\u00e9.txt")).toBeNull();
    expect(caseCollision(claimed, "cafe\u0301.txt")).toBe("caf\u00e9.txt");
  });
});

describe("a log on a terminal", () => {
  test("control, invisible and direction characters go; newline and tab stay", () => {
    expect(plainLog("a\tb\nc\u001b[2J\u0007d\u202ee\u200bf\r\n")).toBe("a\tb\nc[2Jdef\n");
  });

  test("--tail keeps the last n lines and the final newline", () => {
    expect(lastLines("1\n2\n3\n4\n", 2)).toBe("3\n4\n");
    expect(lastLines("1\n2\n3\n4", 2)).toBe("3\n4");
    expect(lastLines("1\n2\n", 10)).toBe("1\n2\n");
    expect(lastLines("", 3)).toBe("");
  });
});
