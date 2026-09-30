/**
 * The data-papers pull (ADR 0077): the dashboard's `data-papers.json` manifest
 * into `datasets.data_papers`.
 *
 * Real engines throughout, no mocks: the manifest is served by a real local HTTP
 * server (`startFixtureServer`, a real `Bun.serve`), and the writes go to a real
 * bun:sqlite D1 carrying every production migration (`freshDb`), so the actual
 * `data_papers` column and its `json_valid` CHECK are what the statements run
 * against. The one instrument swap is `console.warn`, to read back what the
 * sync says about a row it refused.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DATA_PAPERS_SCHEMA_ID,
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

let db: Database;
let server: FixtureServer;
let warnings: string[];
const originalWarn = console.warn;

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

beforeEach(() => {
  db = freshDb();
  for (const id of ["nm000275", "nm000273", "nm000153", "on002721"]) {
    db.run(
      "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, status, updated_at) VALUES (?, -1, ?, 'public', 'active', ?)",
      [id, id, OLD_STAMP],
    );
  }
  server = startFixtureServer();
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.warn = originalWarn;
  server.stop();
  db.close();
});

describe("fetchAndSyncDataPapers", () => {
  test("stores a list and an empty list; a dataset the manifest omits stays NULL", async () => {
    publish([
      { dataset_id: "nm000275", data_papers: [SCI_DATA] },
      { dataset_id: "on002721", data_papers: [] },
    ]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary).toEqual({ fetched: 2, rejected: 0, updated: 2, unchanged: 0, unknown: 0 });
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

    expect(again).toEqual({ fetched: 1, rejected: 0, updated: 0, unchanged: 1, unknown: 0 });
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

  test("a dataset the catalog does not have is counted unknown and never inserted", async () => {
    publish([
      { dataset_id: "nm000275", data_papers: [SCI_DATA] },
      { dataset_id: "ds009999", data_papers: [GIGA] },
    ]);
    const before = (db.query("SELECT COUNT(*) AS n FROM datasets").get() as { n: number }).n;

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.unknown).toBe(1);
    expect(summary.updated).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM datasets").get() as { n: number }).n).toBe(before);
    expect(stored("ds009999")).toBeUndefined();
  });

  test("a row missing from a later manifest never clears the stored value", async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());
    const first = stored("nm000275");

    publish([{ dataset_id: "on002721", data_papers: [] }]);
    await fetchAndSyncDataPapers(env(), url());

    expect(stored("nm000275")).toBe(first);
  });

  test("a manifest with another schema id writes nothing and says why", async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }], "nemar-citations/data-papers@2");

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary).toEqual({ fetched: 0, rejected: 0, updated: 0, unchanged: 0, unknown: 0 });
    expect(stored("nm000275")).toBeNull();
    expect(warnings.some((w) => w.includes("data-papers@2"))).toBe(true);
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

  test("a bad row is skipped and logged while the good rows in the same manifest are stored", async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => ({ doi: `10.1000/paper.${i}` }));
    publish([
      { dataset_id: "nm000275", data_papers: [SCI_DATA] },
      { dataset_id: "nm000273", data_papers: [{ doi: "not-a-doi" }] },
      { dataset_id: "nm000153", data_papers: tooMany },
      { dataset_id: "on002721", data_papers: "10.1000/not-an-array" },
      { data_papers: [GIGA] },
    ]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary).toEqual({ fetched: 1, rejected: 4, updated: 1, unchanged: 0, unknown: 0 });
    expect(JSON.parse(stored("nm000275") as string)).toEqual([SCI_DATA]);
    expect(stored("nm000273")).toBeNull();
    expect(stored("nm000153")).toBeNull();
    expect(stored("on002721")).toBeNull();
    expect(warnings.some((w) => w.includes("nm000273") && w.includes("entry 0"))).toBe(true);
    expect(warnings.some((w) => w.includes("nm000153") && w.includes("more than"))).toBe(true);
    expect(warnings.some((w) => w.includes("on002721"))).toBe(true);
    expect(warnings.some((w) => w.includes("no dataset_id"))).toBe(true);
  });

  test("a list over the byte bound is skipped whole, never stored truncated", async () => {
    const fat = Array.from({ length: 10 }, (_, i) => ({
      doi: `10.1000/fat.${i}`,
      title: "t".repeat(500),
      venue: "v".repeat(200),
    }));
    publish([{ dataset_id: "nm000275", data_papers: fat }]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.rejected).toBe(1);
    expect(stored("nm000275")).toBeNull();
    expect(warnings.some((w) => w.includes("nm000275") && w.includes("bytes"))).toBe(true);
  });

  test("a dataset listed twice is skipped entirely, since neither row can be trusted", async () => {
    publish([
      { dataset_id: "nm000275", data_papers: [SCI_DATA] },
      { dataset_id: "nm000275", data_papers: [GIGA] },
      { dataset_id: "nm000273", data_papers: [GIGA] },
    ]);

    const summary = await fetchAndSyncDataPapers(env(), url());

    expect(summary.rejected).toBe(2);
    expect(stored("nm000275")).toBeNull();
    expect(JSON.parse(stored("nm000273") as string)).toEqual([GIGA]);
    expect(warnings.some((w) => w.includes("nm000275") && w.includes("more than once"))).toBe(true);
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

describe("when the manifest cannot be read, D1 is left exactly as it was", () => {
  beforeEach(async () => {
    publish([{ dataset_id: "nm000275", data_papers: [SCI_DATA] }]);
    await fetchAndSyncDataPapers(env(), url());
  });

  test("a 404 from the dashboard", async () => {
    const before = stored("nm000275");

    const summary = await fetchAndSyncDataPapers(env(), `${server.url}/citations/api/missing.json`);

    expect(summary).toEqual({ fetched: 0, rejected: 0, updated: 0, unchanged: 0, unknown: 0 });
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

  test("a body that is not JSON", async () => {
    const before = stored("nm000275");
    server.files.set(MANIFEST_PATH, new TextEncoder().encode("<html>maintenance</html>"));

    const manifestResult = await fetchDataPapersManifest(url());

    expect(manifestResult.rows).toHaveLength(0);
    expect(stored("nm000275")).toBe(before);
  });
});
