/**
 * Downloading a job's results safely (epic #2021 phase D3b, #2024; `downloadOne` and `safeResultPath` in
 * `src/commands/compute-jobs.ts`): real files written to a real temporary folder from a real HTTP server.
 * The links are bearer links and the paths come from the network, so the folder is the person's and what is
 * written into it is decided here: a path that is absolute or contains `..` is refused, a file that does not
 * match its recorded size and SHA-256 is deleted, an unchanged file is left alone, and no NEMAR credential
 * is sent to the store. Through the real Worker the commands are `compute-user-e2e-cli.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadOne, lastLines, plainLog, safeResultPath } from "../src/commands/compute-jobs";

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
    const body = served.get(new URL(req.url).pathname);
    return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
  },
});
afterAll(() => server.stop(true));

let dir: string;
beforeEach(() => {
  served.clear();
  sentHeaders = [];
  dir = mkdtempSync(join(tmpdir(), "nemar-dl-"));
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
      const out = await downloadOne(dir, {
        path,
        size: 1,
        sha256: sha("x"),
        url: "http://127.0.0.1:1/x",
      });
      expect(out).toBe("the path is not one that may be written");
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(sentHeaders).toEqual([]);
  });
});

describe("a download is verified", () => {
  test("good bytes land in place, nested folders are made, and no NEMAR credential is sent", async () => {
    const f = file("deep/table.csv", "a,b\n1,2\n");
    expect(await downloadOne(dir, f)).toBe("ok");
    expect(readFileSync(join(dir, "deep/table.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(readdirSync(join(dir, "deep"))).toEqual(["table.csv"]);
    expect(sentHeaders[0]?.authorization).toBeUndefined();
    expect(sentHeaders[0]?.["x-cli-version"]).toBeUndefined();
  });

  test("bytes that differ (same length), fewer or more than recorded are deleted and reported", async () => {
    const wrong = file("same.txt", "thE report\n", { sha256: sha("the report\n"), size: 11 });
    expect(await downloadOne(dir, wrong)).toBe("the size or checksum did not match");
    const short = file("short.txt", "abc", { size: 10, sha256: sha("abc") });
    expect(await downloadOne(dir, short)).toBe("the size or checksum did not match");
    const long = file("long.txt", "abcdefghij", { size: 3, sha256: sha("abc") });
    expect(await downloadOne(dir, long)).toBe("the file is larger than NEMAR said");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a file already there with the same size and checksum is left alone; one that differs is replaced", async () => {
    const f = file("r.txt", "the report\n");
    writeFileSync(join(dir, "r.txt"), "the report\n");
    expect(await downloadOne(dir, f)).toBe("skipped");
    expect(sentHeaders).toEqual([]);
    writeFileSync(join(dir, "r.txt"), "old old old\n");
    expect(await downloadOne(dir, f)).toBe("ok");
    expect(readFileSync(join(dir, "r.txt"), "utf8")).toBe("the report\n");
  });

  test("a store that says no, and one that cannot be reached, are reported without the link", async () => {
    const gone = {
      path: "gone.txt",
      size: 1,
      sha256: sha("x"),
      url: `http://127.0.0.1:${server.port}/absent?X-Amz-Signature=abc`,
    };
    expect(await downloadOne(dir, gone)).toBe("HTTP 404");
    const dead = await downloadOne(dir, {
      ...gone,
      url: "http://127.0.0.1:1/x?X-Amz-Signature=abc",
    });
    expect(dead).toBe("the download failed");
    expect(dead).not.toContain("127.0.0.1");
    expect(existsSync(join(dir, "gone.txt.part"))).toBe(false);
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
