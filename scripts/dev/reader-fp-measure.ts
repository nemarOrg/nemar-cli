/**
 * The reader merge gate's false-positive measurement (publication-queue plan, "Reader merge
 * gate"): run one registered reader over public files and count its findings per kind per 100
 * files. Dev-only; CI does not run it.
 *
 *   bun scripts/dev/reader-fp-measure.ts --reader snirf --list files.tsv [--per-dataset 10]
 *     [--concurrency 8] [--url https://s3.amazonaws.com/openneuro.org/] [--json out.json]
 *     [--any-extension]
 *
 * `files.tsv` holds `<dataset>\t<size>\t<key>` lines, as `aws s3 ls --no-sign-request --recursive`
 * gives them after a reshape. Files are read by HTTP range requests through the registry's page
 * cache and limits, exactly as the screen reads them, so nothing is downloaded whole and nothing
 * is written to disk. Output names kinds, counts, dataset ids and byte counts; never a value.
 */

import { parseArgs } from "node:util";
import {
  type FormatReader,
  READERS,
  type RangeSource,
  ReadFailure,
  type ReaderId,
  cachedSource,
} from "../../shared/identifier-readers";

const { values: args } = parseArgs({
  options: {
    reader: { type: "string" },
    list: { type: "string" },
    "per-dataset": { type: "string", default: "10" },
    concurrency: { type: "string", default: "8" },
    url: { type: "string", default: "https://s3.amazonaws.com/openneuro.org/" },
    json: { type: "string" },
    // Read every listed file, whatever its extension (the generic HDF5 reader over SNIRF files).
    "any-extension": { type: "boolean", default: false },
  },
});

const found = READERS.find((r) => r.id === (args.reader as ReaderId));
if (!found || !args.list) {
  console.error("usage: --reader <id> --list <tsv>");
  process.exit(2);
}
const reader: FormatReader = found;
const list: string = args.list;

/** An anonymous HTTP range source. A response that is not 206 is a failed read. */
function httpSource(url: string, size: number): RangeSource {
  return {
    size,
    async read(offset, length) {
      const end = Math.min(size, offset + length) - 1;
      if (end < offset) return new Uint8Array(0);
      const res = await fetch(url, {
        headers: { Range: `bytes=${offset}-${end}`, "User-Agent": "nemar-reader-fp-measure" },
      });
      if (res.status !== 206) throw new ReadFailure(`http-${res.status}`, { status: res.status });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

const rows = (await Bun.file(list).text())
  .trim()
  .split("\n")
  .map((l) => l.split("\t") as [string, string, string])
  .filter(
    ([, , key]) =>
      args["any-extension"] || reader.extensions.some((e) => key.toLowerCase().endsWith(e)),
  );
// Up to N files per dataset, spread across its list, so one large dataset cannot dominate.
const perDataset = Number(args["per-dataset"]);
const byDataset = new Map<string, typeof rows>();
for (const row of rows) byDataset.set(row[0], [...(byDataset.get(row[0]) ?? []), row]);
const picked: typeof rows = [];
for (const list of byDataset.values()) {
  const step = Math.max(1, list.length / perDataset);
  for (let i = 0; i < Math.min(perDataset, list.length); i++) {
    picked.push(list[Math.floor(i * step)] as (typeof rows)[number]);
  }
}

interface FileOutcome {
  dataset: string;
  outcome: "complete" | "partial" | "failed";
  incomplete?: string;
  failure?: string;
  kinds: Record<string, { identifier: number; review: number }>;
  reads: number;
  bytes: number;
  ms: number;
}

const outcomes: FileOutcome[] = [];
let next = 0;
async function worker() {
  while (next < picked.length) {
    const [dataset, size, key] = picked[next++] as (typeof rows)[number];
    const src = cachedSource(httpSource(args.url + key, Number(size)), reader.limits);
    const started = Date.now();
    const o: FileOutcome = { dataset, outcome: "failed", kinds: {}, reads: 0, bytes: 0, ms: 0 };
    try {
      const result = await reader.scan(src, key.slice(dataset.length + 1), reader.limits);
      o.outcome = result.coverage === "complete" && !src.limited ? "complete" : "partial";
      if (o.outcome === "partial") o.incomplete = result.incomplete ?? "limit";
      for (const f of result.findings) {
        const k = o.kinds[f.kind] ?? { identifier: 0, review: 0 };
        k[f.severity]++;
        o.kinds[f.kind] = k;
      }
    } catch (e) {
      o.failure = e instanceof ReadFailure ? e.cls : e instanceof Error ? e.name : "unknown";
    }
    o.reads = src.tally.reads;
    o.bytes = src.tally.bytes;
    o.ms = Date.now() - started;
    outcomes.push(o);
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));

const files = outcomes.length;
const per100 = (n: number) => ((n * 100) / files).toFixed(2);
const kindTotals: Record<string, { identifier: number; review: number; files: number }> = {};
const kindByDataset: Record<string, Record<string, number>> = {};
for (const o of outcomes) {
  for (const [kind, c] of Object.entries(o.kinds)) {
    const t = kindTotals[kind] ?? { identifier: 0, review: 0, files: 0 };
    kindTotals[kind] = t;
    t.identifier += c.identifier;
    t.review += c.review;
    t.files++;
    const d = kindByDataset[kind] ?? {};
    d[o.dataset] = (d[o.dataset] ?? 0) + 1;
    kindByDataset[kind] = d;
  }
}
const count = (pred: (o: FileOutcome) => boolean) => outcomes.filter(pred).length;
const quantile = (xs: number[], q: number) =>
  xs.length === 0 ? 0 : ([...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))] as number);
const bytes = outcomes.filter((o) => o.outcome === "complete").map((o) => o.bytes);
const reads = outcomes.filter((o) => o.outcome === "complete").map((o) => o.reads);

console.log(
  `reader ${reader.id} v${reader.version}: ${files} files from ${byDataset.size} datasets`,
);
console.log(
  `complete ${count((o) => o.outcome === "complete")}, partial ${count((o) => o.outcome === "partial")}, failed ${count((o) => o.outcome === "failed")}`,
);
const tally = (key: "incomplete" | "failure") => {
  const m: Record<string, number> = {};
  for (const o of outcomes) {
    const v = o[key];
    if (v) m[v] = (m[v] ?? 0) + 1;
  }
  return m;
};
console.log("partial by reason:", JSON.stringify(tally("incomplete")));
console.log("failed by class:", JSON.stringify(tally("failure")));
console.log(
  `complete files, bytes fetched p50/p90/max: ${quantile(bytes, 0.5)}/${quantile(bytes, 0.9)}/${Math.max(0, ...bytes)}; fetches p50/p90/max: ${quantile(reads, 0.5)}/${quantile(reads, 0.9)}/${Math.max(0, ...reads)}`,
);
console.log("findings per 100 files (identifier / review), files with the kind, by dataset:");
for (const [kind, t] of Object.entries(kindTotals).sort()) {
  console.log(
    `  ${kind}: ${per100(t.identifier)} / ${per100(t.review)}; files ${t.files}; ${JSON.stringify(kindByDataset[kind])}`,
  );
}
if (args.json) await Bun.write(args.json, JSON.stringify(outcomes, null, 1));
