/**
 * The data plane's manifest questions, answered by streaming scans, against
 * the whole-parse functions they replaced (#1502).
 *
 * Every assertion is a PARITY check: the same manifest bytes go through
 * `JSON.parse` and the reference function in `data-router.ts` (`resolveFile`,
 * `Object.hasOwn`, `digestManifest`, `Object.entries`), and through the
 * scanner with the matching query, and the two answers must be identical.
 * Nothing here states an expected answer of its own.
 *
 * The real input is nm000132's published v1.1.1 manifest, every directory
 * and every path in it. It is sorted, ASCII and duplicate-free, so it cannot
 * reach the places where a stream and `Object.entries` disagree (array-index
 * keys, repeated keys, unsorted keys, odd sizes); the small synthetic
 * manifests below exist for exactly those, and each says which rule it pins.
 *
 * The large input is generated in nm000281's measured shape
 * (`helpers/large-manifest.ts`), because the manifest that broke production is
 * 43 MB and not committable. It is served by a real local HTTP server and
 * read through `fetch`, and it is where the memory bound is measured.
 */

import { heapStats } from "bun:jsc";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { type ResolvedFile, digestManifest, resolveFile } from "../src/services/data-router";
import type { VersionManifest } from "../src/services/manifest";
import {
  ContainsPathQuery,
  DigestQuery,
  EntriesQuery,
  EntryCountQuery,
  type ManifestQuery,
  ResolvePathQuery,
  isArrayIndexKey,
} from "../src/services/manifest-queries";
import { scanManifestStream, scanManifestText } from "../src/services/manifest-scan";
import {
  type LargeManifestOptions,
  largeManifestEntryCount,
  largeManifestPaths,
  largeManifestStream,
  largeManifestText,
} from "./helpers/large-manifest";

const FIXTURE_TEXT = readFileSync(
  join(import.meta.dir, "fixtures/manifest-nm000132-v1.1.1.json"),
  "utf8",
);
const FIXTURE: VersionManifest = JSON.parse(FIXTURE_TEXT);

/** Answer `query` from `text` through the scanner, or throw if it did not scan. */
function answerText<T>(text: string, query: ManifestQuery<T>): T {
  const result = scanManifestText(text, query);
  if (result.kind !== "ok") throw new Error(`scan verdict ${result.kind}`);
  return query.finish(result.header);
}

async function answerStream<T>(body: ReadableStream<Uint8Array>, query: ManifestQuery<T>) {
  const result = await scanManifestStream(body, query);
  if (result.kind !== "ok") throw new Error(`scan verdict ${result.kind}`);
  return query.finish(result.header);
}

function bytesStream(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

/** Every directory of a manifest, with and without the slashes a URL carries. */
function directoriesOf(paths: Iterable<string>): string[] {
  const dirs = new Set<string>([""]);
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs];
}

const PATHS_THAT_ARE_NOT_THERE = [
  "nope",
  "sub-001/nope",
  "sub-001/eeg/nope.set",
  "../etc/passwd",
  "sub-001/../sub-002",
  "a//b",
  "__proto__",
  "constructor",
  "sub-001/eeg/",
  "/sub-001/",
  "%2E%2E/x",
];

describe("ResolvePathQuery is resolveFile", () => {
  test("every directory of nm000132, with and without slashes", () => {
    const dirs = directoriesOf(Object.keys(FIXTURE.files));
    expect(dirs.length).toBe(91);
    for (const dir of dirs) {
      for (const raw of [dir, `${dir}/`, `/${dir}`, `//${dir}//`]) {
        expect(answerText(FIXTURE_TEXT, new ResolvePathQuery(raw))).toEqual(
          resolveFile(FIXTURE, raw),
        );
      }
    }
  });

  test("every file of nm000132", () => {
    const paths = Object.keys(FIXTURE.files);
    expect(paths).toHaveLength(1462);
    for (const path of paths) {
      const got = answerText(FIXTURE_TEXT, new ResolvePathQuery(path));
      expect(got).toEqual(resolveFile(FIXTURE, path));
      expect(got.kind).toBe("file");
    }
  });

  test("paths that are absent or invalid", () => {
    for (const raw of PATHS_THAT_ARE_NOT_THERE) {
      expect(answerText(FIXTURE_TEXT, new ResolvePathQuery(raw))).toEqual(
        resolveFile(FIXTURE, raw),
      );
    }
  });

  test("through the byte stream in odd chunks", async () => {
    const bytes = new TextEncoder().encode(FIXTURE_TEXT);
    for (const raw of ["", "sub-001", "sub-001/eeg", "participants.tsv", "nope"]) {
      expect(await answerStream(bytesStream(bytes, 4093), new ResolvePathQuery(raw))).toEqual(
        resolveFile(FIXTURE, raw),
      );
    }
  });

  // Synthetic: no real manifest has array-index names at its root, and
  // `Object.entries` lists those FIRST. That order is invisible unless the
  // stable sort meets a tie, and `localeCompare` ties "1" with "1​"
  // (a zero-width space is ignorable to the collator). So the only document
  // that can tell the two orders apart is one like this.
  test("root array-index names keep Object.entries' order through a sort tie", () => {
    expect("1".localeCompare("1​")).toBe(0);
    const text = JSON.stringify({
      version: "1",
      files: {
        "1​": { size: 1 },
        b: { size: 2 },
        "1": { size: 3 },
        "10": { size: 4 },
        "10/x": { size: 5 },
      },
    });
    const parsed = JSON.parse(text) as VersionManifest;
    const expected = resolveFile(parsed, "");
    const got = answerText(text, new ResolvePathQuery(""));
    expect(got).toEqual(expected);
    // Pin the order itself, so this cannot pass by both sides being wrong.
    if (got.kind !== "directory") throw new Error("expected a directory");
    expect(got.children.map((c) => c.name)).toEqual(["1", "1​", "10", "b"]);
    expect(got.children.find((c) => c.name === "10")).toEqual({
      kind: "file",
      name: "10",
      size: 4,
    });
  });

  test("a repeated path keeps its first position and its last value", () => {
    const text =
      '{"files":{"d/a":{"size":1},"d/b":{"size":2},"d/a":{"size":3},"d/b/c":{"size":4},"d/a/x":{}}}';
    const parsed = JSON.parse(text) as VersionManifest;
    for (const raw of ["", "d", "d/a", "d/b"]) {
      expect(answerText(text, new ResolvePathQuery(raw))).toEqual(resolveFile(parsed, raw));
    }
  });

  test("a file and a directory of the same name: the file wins, in either order", () => {
    for (const text of [
      '{"files":{"x":{"size":1},"x/y":{"size":2}}}',
      '{"files":{"x/y":{"size":2},"x":{"size":1}}}',
    ]) {
      const parsed = JSON.parse(text) as VersionManifest;
      for (const raw of ["", "x"]) {
        expect(answerText(text, new ResolvePathQuery(raw))).toEqual(resolveFile(parsed, raw));
      }
    }
  });

  test("a null entry in the listed directory throws, as resolveFile always did", () => {
    const text = '{"files":{"d/a":null,"e/b":{"size":1}}}';
    const parsed = JSON.parse(text) as VersionManifest;
    expect(() => resolveFile(parsed, "d")).toThrow(TypeError);
    expect(() => answerText(text, new ResolvePathQuery("d"))).toThrow(TypeError);
    // ...and does not throw where resolveFile did not read it.
    expect(answerText(text, new ResolvePathQuery("e"))).toEqual(resolveFile(parsed, "e"));
    expect(answerText(text, new ResolvePathQuery("d/a"))).toEqual(resolveFile(parsed, "d/a"));
  });

  test("a null entry overwritten by a later duplicate does not throw", () => {
    const text = '{"files":{"d/a":null,"d/a":{"size":1}}}';
    const parsed = JSON.parse(text) as VersionManifest;
    expect(answerText(text, new ResolvePathQuery("d"))).toEqual(resolveFile(parsed, "d"));
  });

  test("files as an array, and the last of two files members", () => {
    for (const text of [
      '{"files":[{"size":1},{"size":2}]}',
      '{"files":{"old/x":{"size":1}},"files":{"new/y":{"size":2}}}',
    ]) {
      const parsed = JSON.parse(text) as VersionManifest;
      for (const raw of ["", "0", "old", "new"]) {
        expect(answerText(text, new ResolvePathQuery(raw))).toEqual(resolveFile(parsed, raw));
      }
    }
  });
});

describe("ContainsPathQuery is Object.hasOwn", () => {
  test("every nm000132 path, and the absent ones, raw as the tombstone walk passes them", () => {
    const probes = [
      ...Object.keys(FIXTURE.files).filter((_, i) => i % 7 === 0),
      ...PATHS_THAT_ARE_NOT_THERE,
      "sub-001",
      "",
    ];
    for (const path of probes) {
      expect(answerText(FIXTURE_TEXT, new ContainsPathQuery(path))).toBe(
        Object.hasOwn(FIXTURE.files, path),
      );
    }
  });

  test("an own __proto__ entry is found, and only when it is there", () => {
    const text = '{"files":{"__proto__":{"size":1}}}';
    const parsed = JSON.parse(text) as VersionManifest;
    expect(answerText(text, new ContainsPathQuery("__proto__"))).toBe(
      Object.hasOwn(parsed.files, "__proto__"),
    );
    expect(answerText(FIXTURE_TEXT, new ContainsPathQuery("__proto__"))).toBe(false);
  });
});

describe("DigestQuery is digestManifest", () => {
  test("nm000132 takes the streaming path and matches the reference exactly", () => {
    const got = answerText(FIXTURE_TEXT, new DigestQuery());
    // The shortcut must actually apply to a real manifest; a digest that
    // always fell back would pass the parity check and bound nothing.
    expect(got.kind).toBe("digest");
    if (got.kind !== "digest") throw new Error("unreachable");
    expect(got.digest).toEqual(digestManifest(FIXTURE));
    expect(got.digest.files).toBe(1462);
  });

  // Synthetic, each one a way the running totals could silently disagree
  // with Object.values: the real manifests are sorted with integer sizes, so
  // none of them can.
  const FALLBACKS: Record<string, string> = {
    "keys out of order": '{"version":"1","files":{"b":{"size":1},"a":{"size":2}}}',
    "a repeated key (counted once, last value)":
      '{"version":"1","files":{"a":{"size":1},"b":{"size":2},"a":{"size":5}}}',
    "a string size (+ concatenates)": '{"version":"1","files":{"a":{"size":1},"b":{"size":"2"}}}',
    "a fractional size": '{"version":"1","files":{"a":{"size":0.1},"b":{"size":0.2}}}',
    "a negative size": '{"version":"1","files":{"a":{"size":-1},"b":{"size":2}}}',
    "sizes past 2^53": '{"version":"1","files":{"a":{"size":9007199254740991},"b":{"size":2}}}',
    "an entry that is not an object": '{"version":"1","files":{"a":7,"b":{"size":2}}}',
    "files as an array (indices sort as strings)":
      '{"version":"1","files":[{"size":1},{"size":2},{"size":3},{"size":4},{"size":5},{"size":6},{"size":7},{"size":8},{"size":9},{"size":10},{"size":11}]}',
  };
  for (const [label, text] of Object.entries(FALLBACKS)) {
    test(`falls back when it cannot prove itself exact: ${label}`, () => {
      const got = answerText(text, new DigestQuery());
      expect(got.kind).toBe("needs_full_read");
      // The fallback the route then takes: materialize, run the reference.
      const entries = answerText(text, new EntriesQuery(Number.POSITIVE_INFINITY));
      if (entries.kind !== "entries") throw new Error("unreachable");
      const parsed = JSON.parse(text) as VersionManifest;
      const header = { ...parsed, files: undefined };
      expect(digestManifest({ ...header, files: entries.files } as VersionManifest)).toEqual(
        digestManifest(parsed),
      );
    });
  }

  test("a second files member starts the totals over", () => {
    const text = '{"version":"1","files":{"a":{"size":1}},"files":{"b":{"size":2}}}';
    const got = answerText(text, new DigestQuery());
    if (got.kind !== "digest") throw new Error("expected the streaming path");
    expect(got.digest).toEqual(digestManifest(JSON.parse(text)));
  });
});

describe("EntriesQuery is manifest.files, up to a limit", () => {
  test("nm000132 materializes to JSON.parse's object, entry for entry", () => {
    const got = answerText(FIXTURE_TEXT, new EntriesQuery(30_000));
    if (got.kind !== "entries") throw new Error("expected entries");
    expect(Object.entries(got.files)).toEqual(Object.entries(FIXTURE.files));
  });

  test("the limit is inclusive and counts distinct paths", () => {
    expect(answerText(FIXTURE_TEXT, new EntriesQuery(1462)).kind).toBe("entries");
    expect(answerText(FIXTURE_TEXT, new EntriesQuery(1461))).toEqual({
      kind: "over_limit",
      limit: 1461,
    });
    const repeated = '{"files":{"a":{"size":1},"a":{"size":2},"b":{"size":3}}}';
    const got = answerText(repeated, new EntriesQuery(2));
    if (got.kind !== "entries") throw new Error("a repeat must not count twice");
    expect(Object.entries(got.files)).toEqual(Object.entries(JSON.parse(repeated).files));
  });
});

describe("EntryCountQuery is Object.keys(manifest.files).length", () => {
  test("nm000132 counts exactly, keeping nothing", () => {
    expect(answerText(FIXTURE_TEXT, new EntryCountQuery())).toEqual({
      kind: "count",
      count: Object.keys(FIXTURE.files).length,
    });
  });

  // Synthetic: a repeated key is ONE entry to Object.keys, and only ordered
  // keys prove there is none, so an unordered manifest must not be counted.
  test("keys that do not ascend are reported, not miscounted", () => {
    for (const text of [
      '{"files":{"a":{},"b":{},"a":{}}}',
      '{"files":{"b":{},"a":{}}}',
      '{"files":[{},{},{},{},{},{},{},{},{},{},{}]}',
    ]) {
      expect(answerText(text, new EntryCountQuery())).toEqual({ kind: "unordered" });
    }
    const last = '{"files":{"a":{},"b":{}},"files":{"c":{}}}';
    expect(answerText(last, new EntryCountQuery())).toEqual({
      kind: "count",
      count: Object.keys(JSON.parse(last).files).length,
    });
  });
});

test("isArrayIndexKey is the ECMA-262 array index", () => {
  const cases: [string, boolean][] = [
    ["0", true],
    ["7", true],
    ["4294967294", true],
    ["4294967295", false],
    ["01", false],
    ["-1", false],
    ["1.0", false],
    ["", false],
    ["1e3", false],
    [" 1", false],
  ];
  for (const [key, expected] of cases) {
    // The engine is the oracle: an index key enumerates before a named one.
    const probe = JSON.parse(`{"z":0,${JSON.stringify(key)}:1}`) as Record<string, number>;
    expect(Object.keys(probe)[0] === key).toBe(expected);
    expect(isArrayIndexKey(key)).toBe(expected);
  }
});

// ---------------------------------------------------------------------------
// The large manifest: served over HTTP, and where memory is measured.
// ---------------------------------------------------------------------------

/** nm000281 has 102,532 entries; this is about half again as many. */
const LARGE: LargeManifestOptions = { subjects: 374, runsPerSession: 50 };
const LARGE_ENTRIES = largeManifestEntryCount(LARGE);

/** JS-visible live memory: the JSC heap plus the out-of-heap string storage. */
function liveBytes(): number {
  Bun.gc(true);
  const h = heapStats();
  return h.heapSize + h.extraMemorySize;
}

/**
 * Wrap a query so it samples live memory every `every` keys, DURING the scan.
 * The peak while scanning is the number that matters: a whole-parse path's
 * memory is gone again by the time it returns.
 */
function sampling<T>(inner: ManifestQuery<T>, every: number) {
  let seen = 0;
  const samples: number[] = [];
  const query: ManifestQuery<T> & { samples: number[] } = {
    samples,
    reset: () => inner.reset(),
    key(path) {
      if (++seen % every === 0) samples.push(liveBytes());
      return inner.key(path);
    },
    value: (path, value) => inner.value(path, value),
    finish: (header) => inner.finish(header),
  };
  return query;
}

describe("a large manifest over HTTP", () => {
  let server: Server;
  let base: string;
  let text: string;
  let parsed: VersionManifest;
  let bytesLength = 0;

  beforeAll(() => {
    text = largeManifestText(LARGE);
    const bytes = new TextEncoder().encode(text);
    bytesLength = bytes.length;
    parsed = JSON.parse(text);
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(bytes, { headers: { "Content-Type": "application/json" } }),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  const read = async () => {
    const res = await fetch(`${base}/nm000281/version/v1.0.3.json`);
    return res.body as ReadableStream<Uint8Array>;
  };

  test("is the size the issue measured, and sorted", () => {
    expect(LARGE_ENTRIES).toBe(149_979);
    expect(Object.keys(parsed.files)).toHaveLength(LARGE_ENTRIES);
    // Tens of megabytes: nm000281's is 42.8 MB for 102,532 entries.
    expect(bytesLength).toBeGreaterThan(55_000_000);
  });

  test("every query answers what the whole parse answers", async () => {
    const somePaths = [...largeManifestPaths(LARGE)].filter((_, i) => i % 30_011 === 5);
    const dirs = ["", "sub-000", "sub-373/ses-01", "sub-200/ses-01/emg", "sub-999", "nope/x"];
    for (const raw of [...dirs, ...somePaths]) {
      expect(await answerStream(await read(), new ResolvePathQuery(raw))).toEqual(
        resolveFile(parsed, raw) as ResolvedFile,
      );
    }
    for (const path of [...somePaths, "sub-000/nope"]) {
      expect(await answerStream(await read(), new ContainsPathQuery(path))).toBe(
        Object.hasOwn(parsed.files, path),
      );
    }
    const digest = await answerStream(await read(), new DigestQuery());
    expect(digest).toEqual({ kind: "digest", digest: digestManifest(parsed) });
    expect(await answerStream(await read(), new EntriesQuery(30_000))).toEqual({
      kind: "over_limit",
      limit: 30_000,
    });
    expect(await answerStream(await read(), new EntryCountQuery())).toEqual({
      kind: "count",
      count: Object.keys(parsed.files).length,
    });
  });

  test("a lookup's peak memory stays flat while the manifest grows tenfold", async () => {
    const small: LargeManifestOptions = { subjects: 37, runsPerSession: 50 };
    const target = "sub-020/ses-01/emg/sub-020_ses-01_task-emg2pose_run-07_recording-left_emg.json";

    const measure = async (opts: LargeManifestOptions, raw: string) => {
      const baseline = liveBytes();
      const query = sampling(new ResolvePathQuery(raw), 5000);
      const answer = await answerStream(largeManifestStream(opts), query);
      return { answer, peak: Math.max(...query.samples) - baseline, samples: query.samples.length };
    };

    const tenth = await measure(small, target);
    const full = await measure(LARGE, target);
    expect(tenth.answer.kind).toBe("file");
    expect(full.answer).toEqual(tenth.answer);
    expect(full.samples).toBe(29);

    // Generous: the scan holds one decoded chunk and the answer. A whole
    // parse holds the document (tens of MB of text alone) at these points.
    const BOUND = 8 * 1024 * 1024;
    expect(full.peak).toBeLessThan(BOUND);
    expect(tenth.peak).toBeLessThan(BOUND);
    // And the growth is noise, not proportional: 10x the entries, well under
    // 10% of the manifest's size in extra memory.
    expect(full.peak - tenth.peak).toBeLessThan(bytesLength / 10);
  });

  test("a directory listing's memory follows the listing, not the manifest", async () => {
    const baseline = liveBytes();
    const query = sampling(new ResolvePathQuery("sub-100/ses-01/emg"), 5000);
    const answer = await answerStream(largeManifestStream(LARGE), query);
    if (answer.kind !== "directory") throw new Error("expected a directory");
    expect(answer.children).toHaveLength(400);
    expect(Math.max(...query.samples) - baseline).toBeLessThan(8 * 1024 * 1024);
  });

  test("the metadata digest's memory follows the subjects, not the files", async () => {
    const baseline = liveBytes();
    const query = sampling(new DigestQuery(), 5000);
    const answer = await answerStream(largeManifestStream(LARGE), query);
    expect(answer.kind).toBe("digest");
    expect(Math.max(...query.samples) - baseline).toBeLessThan(8 * 1024 * 1024);
  });

  test("counting the entries for the manifest.json bound keeps nothing", async () => {
    const baseline = liveBytes();
    const query = sampling(new EntryCountQuery(), 5000);
    const answer = await answerStream(largeManifestStream(LARGE), query);
    expect(answer).toEqual({ kind: "count", count: LARGE_ENTRIES });
    expect(Math.max(...query.samples) - baseline).toBeLessThan(8 * 1024 * 1024);
  });

  test("an over-limit manifest.json refusal drops what it had gathered", async () => {
    const baseline = liveBytes();
    const query = sampling(new EntriesQuery(30_000), 5000);
    const answer = await answerStream(largeManifestStream(LARGE), query);
    expect(answer.kind).toBe("over_limit");
    // Samples after the limit was crossed must be back near the baseline:
    // the 30,000 materialized entries are released, not carried to the end.
    const late = query.samples.slice(-10);
    expect(Math.max(...late) - baseline).toBeLessThan(8 * 1024 * 1024);
  });
});
