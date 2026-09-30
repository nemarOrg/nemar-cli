/**
 * The data-papers pull (ADR 0077): the dashboard's `data-papers.json` manifest
 * into `datasets.data_papers`.
 *
 * Real engines throughout, no mocks: the manifest is served by a real local HTTP
 * server (`startFixtureServer`, or a bare `Bun.serve` where the test needs a
 * response the fixture server cannot produce: no Content-Length, or no answer at
 * all), and the writes go to a real bun:sqlite D1 carrying every production
 * migration (`freshDb`), so the actual `data_papers` column and its `json_valid`
 * CHECK are what the statements run against. The instrument swaps are
 * `console.warn` and `console.error`, to read back what the sync says about a row
 * it refused, and one D1 wrapper that makes a single `batch()` call throw, to
 * prove a failing chunk does not abort the rest (every other statement still runs
 * on the real engine).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DATA_PAPERS_SCHEMA_ID,
  LOOKUP_BATCH_SIZE,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_ROWS,
  UPDATE_BATCH_SIZE,
  fetchAndSyncDataPapers,
  fetchDataPapersManifest,
} from "../src/services/data-papers-sync";
import { freshDb, realD1 } from "./helpers/d1";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server";

const MANIFEST_PATH = "citations/api/data-papers.json";
const OLD_STAMP = "2020-01-01 00:00:00";

const SCI_DATA = {
  doi: "10.1038/s41597-019-0027-4",
  title: "Multi-channel EEG recordings during a sustained-attention driving task",
  year: 2019,
  venue: "Scientific Data",
  judge_model: "claude-sonnet-5-5",
};
const GIGA = {
  doi: "10.1093/gigascience/giz002",
  title: "EEG dataset and OpenBMI toolbox for three BCI paradigms",
  year: 2019,
  venue: "GigaScience",
  judge_model: "claude-sonnet-5-5",
};
// On NEVER_DATA_PAPER_DOIS (shared/never-data-paper.ts): the BIDS specification
// and MNE-Python.
const BIDS_PAPER = { doi: "10.1038/sdata.2016.44", title: "The BIDS specification" };
const MNE_PAPER = { doi: "10.3389/fnins.2013.00267", title: "MEG and EEG data analysis" };
// Not on the list, but the title reads as a BIDS tool paper.
const SPEC_TITLED = {
  doi: "10.1000/not-on-the-list.1",
  title: "EEG-BIDS, an extension to the brain imaging data structure for electroencephalography",
};

let db: Database;
let server: FixtureServer;
let warnings: string[];
let errors: string[];
const originalWarn = console.warn;
const originalError = console.error;
const extraServers: { stop(force?: boolean): void }[] = [];

function manifest(datasets: unknown[], schema: unknown = DATA_PAPERS_SCHEMA_ID): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ schema, last_updated: "2026-09-30T10:00:00Z", datasets }),
  );
}

function publish(datasets: unknown[], schema?: unknown): void {
  server.files.set(MANIFEST_PATH, manifest(datasets, schema));
}

const url = () => `${server.url}/${MANIFEST_PATH}`;
const env = () => ({ DB: realD1(db) });

function stored(id: string): string | null | undefined {
  const row = db.query("SELECT data_papers FROM datasets WHERE dataset_id = ?").get(id) as {
    data_papers: string | null;
  } | null;
  return row === null ? undefined : row.data_papers;
}

function stamp(id: string): string {
  return (
    db.query("SELECT updated_at FROM datasets WHERE dataset_id = ?").get(id) as {
      updated_at: string;
    }
  ).updated_at;
}

function insertDataset(id: string): void {
  db.run(
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, status, updated_at) VALUES (?, -1, ?, 'public', 'active', ?)",
    [id, id, OLD_STAMP],
  );
}

const nmId = (n: number) => `nm${String(n).padStart(6, "0")}`;

beforeEach(() => {
  db = freshDb();
  for (const id of ["nm000275", "nm000273", "nm000153", "on002721"]) insertDataset(id);
  server = startFixtureServer();
  warnings = [];
  errors = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
  server.stop();
  for (const s of extraServers.splice(0)) s.stop(true);
  db.close();
});

describe("fetchAndSyncDataPapers", () => {
  test("stores a list and an empty list; a dataset the manifest omits stays NULL", async () => {
    publish([
      { dataset_id: "nm000275", data_papers: [SCI_DATA] },
      { dataset_id: "on002721", data_papers: [] },
    ]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary).toEqual({
      fetched: 2,
      rejected: 0,
      cleared: 0,
      updated: 2,
      unchanged: 0,
      unknown: 0,
      failedChunks: 0,
    });
    expect(JSON.parse(stored("nm000275") as string)).toEqual([SCI_DATA]);
    expect(stored("on002721")).toBe("[]");
    // Absent from the manifest: "not judged yet", not "no data paper".
    expect(stored("nm000273")).toBeNull();
    expect(stored("nm000153")).toBeNull();
  });

  test("a second run with the same manifest writes nothing", async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());

    const again = await fetchAndSyncDataPapers(env(), url());

    expect(again.updated).toBe(0);
    expect(again.unchanged).toBe(1);
  });

  test("a changed list is rewritten, and updated_at is never touched", async () => {
    publish([{ dataset_id: "nm000273", data_papers: [GIGA] }]);
    await fetchAndSyncDataPapers(env(), url());
    expect(stamp("nm000273")).toBe(OLD_STAMP);

    publish([{ dataset_id: "nm000273", data_papers: [GIGA, SCI_DATA] }]);
    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.updated).toBe(1);
    expect(JSON.parse(stored("nm000273") as string)).toHaveLength(2);
    expect(stamp("nm000273")).toBe(OLD_STAMP);
  });

  test("a valid id the catalog does not have is counted unknown and never inserted", async () => {
    publish([
      { dataset_id: "nm000275", data_papers: [SCI_DATA] },
      { dataset_id: "nm009999", data_papers: [GIGA] },
    ]);
    const before = (db.query("SELECT COUNT(*) AS n FROM datasets").get() as { n: number }).n;

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.unknown).toBe(1);
    expect(summary.updated).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM datasets").get() as { n: number }).n).toBe(before);
    expect(stored("nm009999")).toBeUndefined();
  });

  test("only nm and on ids are ever written: a ds or xx row is rejected, even when the catalog has it", async () => {
    insertDataset("ds009999");
    insertDataset("xx099901");
    publish([
      { dataset_id: "ds009999", data_papers: [GIGA] },
      { dataset_id: "xx099901", data_papers: [GIGA] },
      { dataset_id: "nm000275", data_papers: [SCI_DATA] },
    ]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.rejected).toBe(2);
    expect(summary.updated).toBe(1);
    expect(stored("ds009999")).toBeNull();
    expect(stored("xx099901")).toBeNull();
    expect(warnings.some((w) => w.includes("ds009999"))).toBe(true);
  });

  test("a row missing from a later manifest never clears the stored value", async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());
    const first = stored("nm000275");

    publish([{ dataset_id: "on002721", data_papers: [] }]);
    await fetchAndSyncDataPapers(env(), url());

    expect(stored("nm000275")).toBe(first);
  });

  test("a manifest with another schema id skips the WHOLE manifest and says so", async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }], "nemar-citations/data-papers@2");

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.fetched).toBe(0);
    expect(summary.updated).toBe(0);
    expect(stored("nm000275")).toBeNull();
    expect(warnings.some((w) => w.includes("data-papers@2") && w.includes("whole manifest"))).toBe(
      true,
    );
  });

  test("a manifest with no schema id at all writes nothing", async () => {
    server.files.set(
      MANIFEST_PATH,
      new TextEncoder().encode(
        JSON.stringify({ datasets: [{ dataset_id: "nm000275", data_papers: [SCI_DATA] }] }),
      ),
    );

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.fetched).toBe(0);
    expect(stored("nm000275")).toBeNull();
  });

  test("a string over its cap is truncated and the entry is still stored", async () => {
    publish([
      {
        dataset_id: "nm000275",
        data_papers: [{ ...SCI_DATA, title: "x".repeat(2000) }],
      },
    ]);

    await fetchAndSyncDataPapers(env(), url());

    const list = JSON.parse(stored("nm000275") as string) as { title: string }[];
    expect(list[0].title).toHaveLength(500);
  });
});

describe("a present row that cannot be stored fails closed: the dataset's claim is cleared", () => {
  const TOO_MANY = Array.from({ length: 11 }, (_, i) => ({ doi: `10.1000/paper.${i}` }));
  const FAT = Array.from({ length: 10 }, (_, i) => ({
    doi: `10.1000/fat.${i}`,
    title: "t".repeat(500),
    venue: "v".repeat(200),
  }));

  async function storeThenPublish(id: string, unstorable: unknown): Promise<void> {
    publish([{ dataset_id: id, data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());
    expect(stored(id)).not.toBeNull();
    errors.length = 0;
    publish([{ dataset_id: id, data_papers: unstorable }]);
  }

  test.each([
    ["an invalid DOI", [{ doi: "not-a-doi" }], "entry 0"],
    ["more than 10 papers", TOO_MANY, "more than 10"],
    ["a list over the byte bound", FAT, "bytes"],
    ["a non-array", "10.1000/not-an-array", "not an array"],
    ["a wrong-typed field", [{ doi: "10.1000/x.1", year: "2019" }], "entry 0"],
  ])(
    "%s: the stored list is set to NULL and the row is logged with its id and reason",
    async (_l, bad, reason) => {
      await storeThenPublish("nm000275", bad);

      const summary = await fetchAndSyncDataPapers(env(), url());

      expect(stored("nm000275")).toBeNull();
      expect(summary).toMatchObject({ fetched: 0, rejected: 1, cleared: 1, updated: 0 });
      expect(errors.some((e) => e.includes("nm000275") && e.includes(reason))).toBe(true);
    },
  );

  test("a row with no data_papers key at all is treated as unstorable", async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());
    publish([{ dataset_id: "nm000275" }]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(stored("nm000275")).toBeNull();
    expect(summary.cleared).toBe(1);
  });

  test("an unstorable row for a dataset that is already NULL writes nothing and counts no clear", async () => {
    publish([{ dataset_id: "nm000273", data_papers: [{ doi: "not-a-doi" }] }]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(stored("nm000273")).toBeNull();
    expect(summary).toMatchObject({ rejected: 1, cleared: 0, updated: 0 });
  });

  test("an unstorable row never touches updated_at", async () => {
    await storeThenPublish("nm000275", [{ doi: "not-a-doi" }]);

    await fetchAndSyncDataPapers(env(), url());

    expect(stamp("nm000275")).toBe(OLD_STAMP);
  });

  test("bad rows are cleared and logged while the good rows in the same manifest are stored", async () => {
    publish([
      { dataset_id: "nm000275", data_papers: [SCI_DATA] },
      { dataset_id: "nm000273", data_papers: [GIGA] },
    ]);
    await fetchAndSyncDataPapers(env(), url());
    publish([
      { dataset_id: "nm000275", data_papers: [SCI_DATA, GIGA] },
      { dataset_id: "nm000273", data_papers: [{ doi: "not-a-doi" }] },
      { dataset_id: "on002721", data_papers: [] },
    ]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary).toMatchObject({ fetched: 2, rejected: 1, cleared: 1, updated: 2 });
    expect(JSON.parse(stored("nm000275") as string)).toHaveLength(2);
    expect(stored("nm000273")).toBeNull();
    expect(stored("on002721")).toBe("[]");
  });

  test("a dataset listed twice is ambiguous: neither row is used and nothing is written, not even a clear", async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());
    const first = stored("nm000275");
    publish([
      { dataset_id: "nm000275", data_papers: [{ doi: "not-a-doi" }] },
      { dataset_id: "nm000275", data_papers: [GIGA] },
      { dataset_id: "nm000273", data_papers: [GIGA] },
    ]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary).toMatchObject({ fetched: 1, rejected: 2, cleared: 0 });
    expect(stored("nm000275")).toBe(first);
    expect(JSON.parse(stored("nm000273") as string)).toEqual([GIGA]);
    expect(warnings.some((w) => w.includes("nm000275") && w.includes("more than once"))).toBe(true);
  });
});

describe("ADR 0075's guard is applied by the writer", () => {
  test("a BIDS or MNE DOI and a spec-titled entry are dropped next to a legitimate paper", async () => {
    publish([
      {
        dataset_id: "nm000275",
        data_papers: [BIDS_PAPER, SCI_DATA, MNE_PAPER, SPEC_TITLED],
      },
    ]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.updated).toBe(1);
    const list = JSON.parse(stored("nm000275") as string) as { doi: string }[];
    expect(list.map((p) => p.doi)).toEqual([SCI_DATA.doi]);
    expect(errors.filter((e) => e.includes("nm000275") && e.includes("ADR 0075"))).toHaveLength(3);
  });

  test("a list that the guard empties is refused and clears the claim, never stored as []", async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());
    publish([{ dataset_id: "nm000275", data_papers: [BIDS_PAPER] }]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(stored("nm000275")).toBeNull();
    expect(summary).toMatchObject({ fetched: 0, rejected: 1, cleared: 1 });
  });

  test("a guard-emptied list for a dataset that was NULL stays NULL, not '[]'", async () => {
    publish([{ dataset_id: "nm000273", data_papers: [SPEC_TITLED] }]);

    await fetchAndSyncDataPapers(env(), url());

    expect(stored("nm000273")).toBeNull();
  });

  test("an empty list the producer sent is still stored as [], the guard or not", async () => {
    publish([{ dataset_id: "nm000273", data_papers: [] }]);

    await fetchAndSyncDataPapers(env(), url());

    expect(stored("nm000273")).toBe("[]");
  });
});

describe("batching crosses LOOKUP_BATCH_SIZE and UPDATE_BATCH_SIZE", () => {
  const N = 120;
  const ids = Array.from({ length: N }, (_, i) => nmId(300000 + i));

  test("120 datasets and one unknown id: every row lands, then none is rewritten", async () => {
    expect(N).toBeGreaterThan(LOOKUP_BATCH_SIZE * 2);
    expect(N).toBeGreaterThan(UPDATE_BATCH_SIZE * 10);
    for (const id of ids) insertDataset(id);
    const rows = [
      ...ids.map((id) => ({
        dataset_id: id,
        data_papers: [{ ...GIGA, title: `Paper for ${id}` }],
      })),
      { dataset_id: nmId(399999), data_papers: [GIGA] },
    ];
    publish(rows);

    const first = await fetchAndSyncDataPapers(env(), url());

    expect(first).toMatchObject({ fetched: N + 1, updated: N, unknown: 1, unchanged: 0 });
    for (const id of ids) expect(stored(id)).toContain(`Paper for ${id}`);

    const second = await fetchAndSyncDataPapers(env(), url());

    expect(second).toMatchObject({ fetched: N + 1, updated: 0, unknown: 1, unchanged: N });
  });

  test("one chunk that D1 refuses is logged and counted while the other chunks still write", async () => {
    const n = UPDATE_BATCH_SIZE * 3;
    const some = ids.slice(0, n);
    for (const id of some) insertDataset(id);
    publish(some.map((id) => ({ dataset_id: id, data_papers: [GIGA] })));
    const real = realD1(db);
    let batches = 0;
    const flaky = {
      ...real,
      prepare: real.prepare.bind(real),
      batch: (stmts: unknown[]) => {
        batches++;
        if (batches === 2) throw new Error("D1_ERROR: simulated refusal of one chunk");
        return (real as unknown as { batch(s: unknown[]): unknown }).batch(stmts);
      },
    } as unknown as D1Database;

    const summary = await fetchAndSyncDataPapers({ DB: flaky }, url());

    expect(summary.failedChunks).toBe(1);
    expect(summary.updated).toBe(UPDATE_BATCH_SIZE * 2);
    const written = some.filter((id) => stored(id) !== null);
    expect(written).toHaveLength(UPDATE_BATCH_SIZE * 2);
    expect(errors.some((e) => e.includes("simulated refusal"))).toBe(true);
  });
});

describe("a manifest that is too big is skipped whole", () => {
  beforeEach(async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());
    errors.length = 0;
  });

  test("a declared Content-Length over the bound: D1 untouched and an error logged", async () => {
    const before = stored("nm000275");
    const pad = "x".repeat(MAX_MANIFEST_BYTES);
    server.files.set(MANIFEST_PATH, manifest([{ dataset_id: "nm000275", data_papers: [], pad }]));

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.fetched).toBe(0);
    expect(summary.cleared).toBe(0);
    expect(stored("nm000275")).toBe(before);
    expect(errors.some((e) => e.includes("declares") && e.includes("skipping it whole"))).toBe(
      true,
    );
  });

  test("a streamed body with no Content-Length is abandoned at the bound", async () => {
    const before = stored("nm000275");
    let cancelled = false;
    let sent = 0;
    const chunk = new TextEncoder().encode(`${"x".repeat(64 * 1024)}`);
    const streaming = Bun.serve({
      port: 0,
      fetch() {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            // Far more than the bound: only a reader that stops early finishes.
            if (sent > MAX_MANIFEST_BYTES * 40) return controller.close();
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, { headers: { "Content-Type": "application/json" } });
      },
    });
    extraServers.push(streaming);

    // Probe once to prove the server really sends no Content-Length, then reset
    // the counters so only the sync's own read is measured below.
    const probe = await fetch(`http://localhost:${streaming.port}/`);
    expect(probe.headers.get("content-length")).toBeNull();
    await probe.body?.cancel();
    // The server learns of a client cancel asynchronously: wait for the probe's
    // own cancel to land before resetting, so it cannot be mistaken for the sync's.
    for (let i = 0; i < 60 && !cancelled; i++) await new Promise((r) => setTimeout(r, 50));
    expect(cancelled).toBe(true);
    cancelled = false;
    sent = 0;

    const summary = await fetchAndSyncDataPapers(env(), `http://localhost:${streaming.port}/`);

    expect(summary.fetched).toBe(0);
    expect(stored("nm000275")).toBe(before);
    expect(
      errors.some((e) => e.includes("streams more than") && e.includes("skipping it whole")),
    ).toBe(true);
    for (let i = 0; i < 60 && !cancelled; i++) await new Promise((r) => setTimeout(r, 50));
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(MAX_MANIFEST_BYTES * 10);
  });

  test("exactly MAX_MANIFEST_ROWS rows are accepted, one more skips the whole manifest", async () => {
    const tiny = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ dataset_id: nmId(500000 + i), data_papers: [] }));

    publish(tiny(MAX_MANIFEST_ROWS));
    const atBound = await fetchAndSyncDataPapers(env(), url());
    expect(atBound.fetched).toBe(MAX_MANIFEST_ROWS);
    expect(atBound.unknown).toBe(MAX_MANIFEST_ROWS);

    const before = stored("nm000275");
    publish([{ dataset_id: "nm000275", data_papers: [] }, ...tiny(MAX_MANIFEST_ROWS)]);
    const over = await fetchAndSyncDataPapers(env(), url());

    expect(over.fetched).toBe(0);
    expect(stored("nm000275")).toBe(before);
    expect(errors.some((e) => e.includes(String(MAX_MANIFEST_ROWS + 1)))).toBe(true);
  });
});

describe("when the manifest cannot be read, D1 is left exactly as it was", () => {
  beforeEach(async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());
  });

  test("a 404 from the dashboard", async () => {
    const before = stored("nm000275");

    const summary = await fetchAndSyncDataPapers(env(), `${server.url}/citations/api/missing.json`);

    expect(summary).toMatchObject({ fetched: 0, rejected: 0, cleared: 0, updated: 0 });
    expect(stored("nm000275")).toBe(before);
    expect(warnings.some((w) => w.includes("404"))).toBe(true);
  });

  test("a dashboard that is not reachable at all", async () => {
    const before = stored("nm000275");
    const deadUrl = url();
    server.stop();

    const summary = await fetchAndSyncDataPapers(env(), deadUrl);

    expect(summary.fetched).toBe(0);
    expect(summary.updated).toBe(0);
    expect(stored("nm000275")).toBe(before);
    expect(warnings.some((w) => w.includes("manifest fetch failed"))).toBe(true);
  });

  test("a dashboard that accepts the request and never answers: the injected timeout fires", async () => {
    const before = stored("nm000275");
    const silent = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    extraServers.push(silent);
    const started = Date.now();

    const summary = await fetchAndSyncDataPapers(env(), `http://localhost:${silent.port}/`, {
      timeoutMs: 250,
    });

    expect(Date.now() - started).toBeLessThan(4000);
    expect(summary.fetched).toBe(0);
    expect(stored("nm000275")).toBe(before);
    expect(warnings.some((w) => w.includes("manifest fetch failed"))).toBe(true);
  });

  test("a body that is not JSON", async () => {
    const before = stored("nm000275");
    server.files.set(MANIFEST_PATH, new TextEncoder().encode("<html>maintenance</html>"));

    const manifestResult = await fetchDataPapersManifest(url());

    expect(manifestResult.rows).toHaveLength(0);
    expect(manifestResult.unstorable).toHaveLength(0);
    expect(stored("nm000275")).toBe(before);
  });

  test("each call hands back its own empty manifest, never a shared object", async () => {
    const a = await fetchDataPapersManifest(`${server.url}/citations/api/missing.json`);
    a.rows.push({ dataset_id: "nm000001", papers: [], json: "[]" });
    a.rejected = 7;

    const b = await fetchDataPapersManifest(`${server.url}/citations/api/missing.json`);

    expect(b.rows).toHaveLength(0);
    expect(b.rejected).toBe(0);
  });
});
