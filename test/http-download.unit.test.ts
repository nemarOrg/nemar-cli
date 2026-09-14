/**
 * The plain-HTTP download path: selection, and the worker pool that fetches it.
 *
 * Offline. The pool is exercised against a local `Bun.serve` origin rather
 * than a stubbed `fetch`, so what is under test is the real request, the real
 * stream-to-disk, and the real resume decision.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { buildBidsFilterArgs, matchesBidsFilter } from "../src/lib/bids-filter";
import {
  type DataPlaneEntry,
  downloadEntries,
  isMetadataEntry,
  selectEntries,
} from "../src/lib/http-download";

function entry(path: string, over: Partial<DataPlaneEntry> = {}): DataPlaneEntry {
  return {
    path,
    size: 4,
    checksum_algorithm: path.endsWith(".set") ? "SHA256E" : "git",
    bytes_url: `http://example.invalid/${path}`,
    ...over,
  };
}

describe("selectEntries", () => {
  const manifest = [
    entry("dataset_description.json"),
    entry("participants.tsv"),
    entry("sub-01/eeg/sub-01_task-rest_eeg.json"),
    entry("sub-01/eeg/sub-01_task-rest_eeg.set"),
    entry("sub-02/eeg/sub-02_task-rest_eeg.set"),
    entry("sub-02/eeg/sub-02_task-nback_eeg.set"),
    entry("derivatives/prep/sub-01/sub-01_desc-clean_eeg.set"),
    entry("stimuli/tone.wav", { checksum_algorithm: "SHA256E" }),
  ];

  test("a subject filter keeps that subject's data", () => {
    const selected = selectEntries(manifest, buildBidsFilterArgs({ subjects: "sub-01" })).map(
      (e) => e.path,
    );
    expect(selected).toContain("sub-01/eeg/sub-01_task-rest_eeg.set");
    expect(selected).not.toContain("sub-02/eeg/sub-02_task-rest_eeg.set");
  });

  test("metadata survives every filter", () => {
    // A subject-scoped download that dropped dataset_description.json would
    // not be a readable BIDS dataset. The git-annex path gets this for free
    // (those files ride along in the clone); here it is explicit.
    const selected = selectEntries(manifest, buildBidsFilterArgs({ subjects: "sub-01" })).map(
      (e) => e.path,
    );
    expect(selected).toContain("dataset_description.json");
    expect(selected).toContain("participants.tsv");
  });

  test("--no-data keeps metadata only", () => {
    const selected = selectEntries(manifest, buildBidsFilterArgs({}), { metadataOnly: true });
    expect(selected.every(isMetadataEntry)).toBe(true);
    expect(selected.map((e) => e.path)).toContain("dataset_description.json");
    expect(selected.map((e) => e.path)).not.toContain("sub-01/eeg/sub-01_task-rest_eeg.set");
  });

  test("stimuli and derivatives are skipped by default", () => {
    const filter = buildBidsFilterArgs({ excludeStimuli: true, excludeDerivatives: true });
    const selected = selectEntries(manifest, filter).map((e) => e.path);
    expect(selected).not.toContain("stimuli/tone.wav");
    expect(selected).not.toContain("derivatives/prep/sub-01/sub-01_desc-clean_eeg.set");
  });

  test("a task filter narrows within a subject", () => {
    const selected = selectEntries(manifest, buildBidsFilterArgs({ tasks: "nback" })).map(
      (e) => e.path,
    );
    expect(selected).toContain("sub-02/eeg/sub-02_task-nback_eeg.set");
    expect(selected).not.toContain("sub-02/eeg/sub-02_task-rest_eeg.set");
  });
});

describe("matchesBidsFilter tracks the git-annex args", () => {
  // The point of deriving both from one builder is that a user gets the same
  // files whether or not git-annex happened to be installed. These cases pin
  // the correspondence: every glob the builder emits as an --include has to be
  // one the matcher actually understands.
  const cases: { opts: Parameters<typeof buildBidsFilterArgs>[0]; hit: string; miss: string }[] = [
    { opts: { subjects: "01" }, hit: "sub-01/eeg/x.set", miss: "sub-02/eeg/x.set" },
    {
      opts: { sessions: "pre" },
      hit: "sub-01/ses-pre/eeg/x.set",
      miss: "sub-01/ses-post/eeg/x.set",
    },
    {
      opts: { tasks: "rest" },
      hit: "sub-01/eeg/sub-01_task-rest_eeg.set",
      miss: "sub-01/eeg/sub-01_task-odd_eeg.set",
    },
    {
      opts: { runs: "1" },
      hit: "sub-01/eeg/sub-01_run-1_eeg.set",
      miss: "sub-01/eeg/sub-01_run-2_eeg.set",
    },
    { opts: { datatypes: "eeg" }, hit: "sub-01/eeg/x.set", miss: "sub-01/meg/x.fif" },
    { opts: { include: "sub-03/**" }, hit: "sub-03/eeg/x.set", miss: "sub-01/eeg/x.set" },
    { opts: { exclude: "sourcedata/**" }, hit: "sub-01/eeg/x.set", miss: "sourcedata/raw.bin" },
  ];

  for (const { opts, hit, miss } of cases) {
    test(JSON.stringify(opts), () => {
      const filter = buildBidsFilterArgs(opts);
      // The git-annex path is unchanged: the args are still emitted.
      expect(filter.args.length).toBeGreaterThan(0);
      expect(matchesBidsFilter(hit, filter)).toBe(true);
      expect(matchesBidsFilter(miss, filter)).toBe(false);
    });
  }

  test("an empty filter admits everything", () => {
    const filter = buildBidsFilterArgs({});
    expect(filter.args).toEqual([]);
    expect(matchesBidsFilter("sub-01/eeg/x.set", filter)).toBe(true);
  });

  test("a run filter expands bare and zero-padded forms alike", () => {
    const filter = buildBidsFilterArgs({ runs: "1" });
    expect(matchesBidsFilter("sub-01/eeg/sub-01_run-01_eeg.set", filter)).toBe(true);
  });
});

describe("downloadEntries", () => {
  let server: Server;
  let base: string;
  let workDir: string;
  const served: Record<string, string> = {
    "dataset_description.json": '{"Name":"x"}',
    "sub-01/eeg/a.set": "AAAAAAAA",
    "gone.tsv": "",
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = decodeURIComponent(new URL(req.url).pathname.slice(1));
        if (path === "gone.tsv") return new Response("nope", { status: 404 });
        const body = served[path];
        if (body === undefined) return new Response("nope", { status: 404 });
        return new Response(body);
      },
    });
    base = `http://localhost:${server.port}`;
    workDir = mkdtempSync(join(tmpdir(), "nemar-http-dl-"));
  });

  afterAll(() => {
    server.stop(true);
    rmSync(workDir, { recursive: true, force: true });
  });

  function remote(path: string): DataPlaneEntry {
    return {
      path,
      size: served[path]?.length ?? 0,
      checksum_algorithm: "git",
      bytes_url: `${base}/${path}`,
    };
  }

  test("writes the tree and reports bytes", async () => {
    const out = join(workDir, "ok");
    const result = await downloadEntries(
      [remote("dataset_description.json"), remote("sub-01/eeg/a.set")],
      out,
    );
    expect(result.errors).toEqual([]);
    expect(result.filesDownloaded).toBe(2);
    expect(result.bytesDownloaded).toBe(20);
    expect(readFileSync(join(out, "dataset_description.json"), "utf8")).toBe('{"Name":"x"}');
    expect(readFileSync(join(out, "sub-01/eeg/a.set"), "utf8")).toBe("AAAAAAAA");
  });

  test("a file already present at its declared size is skipped, not refetched", async () => {
    const out = join(workDir, "resume");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "dataset_description.json"), '{"Name":"x"}');
    const before = statSync(join(out, "dataset_description.json")).mtimeMs;

    const result = await downloadEntries([remote("dataset_description.json")], out);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesDownloaded).toBe(0);
    expect(statSync(join(out, "dataset_description.json")).mtimeMs).toBe(before);
  });

  test("a file present at the WRONG size is refetched", async () => {
    // The half-written file an interrupted transfer leaves behind. Skipping it
    // would quietly hand back a truncated dataset.
    const out = join(workDir, "truncated");
    mkdirSync(join(out, "sub-01/eeg"), { recursive: true });
    writeFileSync(join(out, "sub-01/eeg/a.set"), "AAA");

    const result = await downloadEntries([remote("sub-01/eeg/a.set")], out);
    expect(result.filesDownloaded).toBe(1);
    expect(readFileSync(join(out, "sub-01/eeg/a.set"), "utf8")).toBe("AAAAAAAA");
  });

  test("one failure does not abandon the rest", async () => {
    const out = join(workDir, "partial");
    const result = await downloadEntries(
      [remote("dataset_description.json"), remote("gone.tsv"), remote("sub-01/eeg/a.set")],
      out,
    );
    expect(result.filesDownloaded).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("gone.tsv");
    expect(result.errors[0]).toContain("404");
  });

  test("a path escaping the output directory is refused", async () => {
    // The manifest is server-supplied; a `..` in it must not write elsewhere.
    const out = join(workDir, "traversal");
    const result = await downloadEntries(
      [{ path: "../escaped.txt", size: 1, bytes_url: `${base}/dataset_description.json` }],
      out,
    );
    expect(result.filesDownloaded).toBe(0);
    expect(result.errors[0]).toContain("outside the output directory");
  });

  test("concurrency is bounded", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = Bun.serve({
      port: 0,
      async fetch() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(15);
        inFlight--;
        return new Response("0123456789");
      },
    });
    try {
      const files = Array.from({ length: 20 }, (_, i) => ({
        path: `f${i}.bin`,
        size: 10,
        bytes_url: `http://localhost:${slow.port}/f${i}.bin`,
      }));
      await downloadEntries(files, join(workDir, "bounded"), { concurrency: 4 });
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(1);
    } finally {
      slow.stop(true);
    }
  });
});
