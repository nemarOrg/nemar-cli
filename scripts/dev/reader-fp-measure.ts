#!/usr/bin/env bun
/**
 * False-positive measurement for a format reader (the owner's merge gate for every reader).
 *
 *   bun scripts/dev/reader-fp-measure.ts --root <dir> [--reader <id>] [--listing <dir>] [--json <out>]
 *
 * Runs the registered readers over every file under `--root` that a reader parses, through the
 * screen's own `readRecordings` (the same limits, timers and companion pairing as the publication
 * screen), and prints the findings per kind per 100 files, the read outcomes and the incomplete
 * reasons. `--reader` keeps one reader's files. Each top-level directory under the root is one
 * dataset (an OpenNeuro accession, say), so the companion pairing sees that dataset's paths.
 * `--listing <dir>` names a directory of `<dataset>.txt` files, one root-relative path per line
 * (the dataset's full file list), so companions that were not downloaded still pair; a dataset
 * whose readers fell short anyway (a partial or failed read) is counted in `incompleteDatasets`.
 *
 * The per-100 denominator is the files the readers counted: a file a reader found to be another
 * format (`not-applicable`) is counted as unscreened and is not in it.
 *
 * **It prints no value.** Only kinds, counts, and the dataset directories that produced a kind,
 * so its output can go in a pull request. The files it reads are the caller's: download public
 * headers into the OS temp directory, run this, and delete them.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  type FormatReader,
  READERS,
  type ReaderId,
  bufferSource,
  cachedSource,
  limitsFor,
  readerFor,
} from "../../shared/identifier-readers";
import { readRecordings } from "../../shared/identifier-report-builder";

interface Measured {
  reader: ReaderId | "all";
  files: number;
  datasets: number;
  read: number;
  partial: number;
  failed: number;
  reasons: Record<string, number>;
  /** Datasets whose recordings did not all read completely (the screen would say `unchecked`). */
  incompleteDatasets: number;
  /** Headers that name a companion other than their own base name (a note). */
  companionNameMismatch: number;
  /** Files a reader found not to be its format, by extension (counted as unscreened). */
  notApplicable: Record<string, number>;
  /** Files whose own read ended `partial`, by the reason the reader gave (companions aside). */
  fileReasons: Record<string, number>;
  failures: Record<string, number>;
  /** Findings per kind, with the severity they carry. */
  kinds: Record<string, { severity: string; findings: number; per100: number; datasets: string[] }>;
}

/** A dataset's full path list from `<listing>/<dataset>.txt`, or null when there is none. */
function listingOf(listing: string | undefined, dataset: string): string[] | null {
  if (!listing) return null;
  const file = join(listing, `${dataset}.txt`);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Measure the readers over every file under `root`, one dataset per top-level directory. */
export async function measure(
  root: string,
  readers: readonly FormatReader[] = READERS,
  listing?: string,
): Promise<Measured> {
  const all = walk(root).map((full) => relative(root, full).split("\\").join("/"));
  const byDataset = new Map<string, string[]>();
  for (const path of all) {
    const dataset = path.split("/")[0] as string;
    byDataset.set(dataset, [...(byDataset.get(dataset) ?? []), path]);
  }
  const result: Measured = {
    reader: readers.length === 1 ? (readers[0] as FormatReader).id : "all",
    files: 0,
    datasets: 0,
    read: 0,
    partial: 0,
    failed: 0,
    reasons: {},
    incompleteDatasets: 0,
    companionNameMismatch: 0,
    notApplicable: {},
    fileReasons: {},
    failures: {},
    kinds: {},
  };
  for (const [dataset, paths] of byDataset) {
    const entries = paths
      .filter((path) => readerFor(path, readers) !== null)
      .map((path) => ({ path, size: statSync(join(root, path)).size }));
    if (entries.length === 0) continue;
    result.datasets++;
    const outcome = await readRecordings({
      entries,
      paths: listingOf(listing, dataset) ?? paths,
      readers,
      open: (entry) => bufferSource(new Uint8Array(readFileSync(join(root, entry.path)))),
      concurrency: 8,
      now: () => Date.now(),
      datasetTimeMs: 20 * 60_000,
      failureClass: (error) => (error instanceof Error ? error.name : "unknown"),
    });
    result.companionNameMismatch += outcome.companionNameMismatch;
    for (const [ext, n] of Object.entries(outcome.notApplicable)) {
      result.notApplicable[ext] = (result.notApplicable[ext] ?? 0) + n;
    }
    if (outcome.reasons.size > 0) result.incompleteDatasets++;
    for (const reader of readers) {
      const t = outcome.tallies[reader.id];
      result.files += t.files;
      result.read += t.read;
      result.partial += t.partial;
      result.failed += t.failed;
    }
    // The reader's own verdict per file, which the dataset's reasons fold together.
    for (const entry of entries) {
      const reader = readerFor(entry.path, readers) as FormatReader;
      const bytes = new Uint8Array(readFileSync(join(root, entry.path)));
      try {
        const limits = limitsFor(reader, entry.path);
        const r = await reader.scan(cachedSource(bufferSource(bytes), limits), entry.path, limits);
        if (r.coverage === "partial") {
          const key = r.incomplete ?? "unstated";
          result.fileReasons[key] = (result.fileReasons[key] ?? 0) + 1;
        }
      } catch (error) {
        const key = error instanceof Error ? error.name : "unknown";
        result.fileReasons[key] = (result.fileReasons[key] ?? 0) + 1;
      }
    }
    for (const reason of outcome.reasons)
      result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
    for (const [key, n] of Object.entries(outcome.failures)) {
      result.failures[key] = (result.failures[key] ?? 0) + n;
    }
    for (const f of outcome.findings) {
      // A kind can carry two severities (a birth date to the day, or only a year).
      const key = `${f.kind} (${f.severity})`;
      const k = result.kinds[key] ?? {
        severity: f.severity,
        findings: 0,
        per100: 0,
        datasets: [],
      };
      k.findings++;
      if (!k.datasets.includes(dataset)) k.datasets.push(dataset);
      result.kinds[key] = k;
    }
  }
  for (const k of Object.values(result.kinds)) {
    k.per100 = result.files === 0 ? 0 : Math.round((10_000 * k.findings) / result.files) / 100;
  }
  return result;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      reader: { type: "string" },
      listing: { type: "string" },
      json: { type: "string" },
    },
  });
  if (!values.root) {
    console.error(
      "usage: bun scripts/dev/reader-fp-measure.ts --root <dir> [--reader <id>] [--listing <dir>] [--json <out>]",
    );
    process.exit(2);
  }
  const readers = values.reader ? READERS.filter((r) => r.id === values.reader) : READERS;
  if (readers.length === 0) {
    console.error("no registered reader has that id");
    process.exit(2);
  }
  const m = await measure(values.root, readers, values.listing);
  if (values.json) await Bun.write(values.json, `${JSON.stringify(m, null, 2)}\n`);
  console.log(`reader ${m.reader}: ${m.files} files in ${m.datasets} datasets`);
  console.log(`read ${m.read}, partial ${m.partial}, failed ${m.failed}`);
  console.log(`incomplete reasons (datasets): ${JSON.stringify(m.reasons)}`);
  console.log(`datasets with an incomplete read: ${m.incompleteDatasets} of ${m.datasets}`);
  console.log(`companion-name-mismatch notes: ${m.companionNameMismatch}`);
  console.log(`not-applicable (counted unscreened): ${JSON.stringify(m.notApplicable)}`);
  console.log(`partial files by the reader's own reason: ${JSON.stringify(m.fileReasons)}`);
  console.log(`failures: ${JSON.stringify(m.failures)}`);
  console.log("| kind (severity) | findings | per 100 files | datasets |");
  console.log("|---|---|---|---|");
  for (const [kind, k] of Object.entries(m.kinds).sort()) {
    console.log(`| ${kind} | ${k.findings} | ${k.per100} | ${k.datasets.length} |`);
  }
}
