#!/usr/bin/env bun
/**
 * Fleet identifier screening: apply `shared/identifier-scan.ts` to every public dataset.
 *
 * Read-only and anonymous. It lists the public catalog, reads each dataset's latest
 * manifest through the data plane, then reads only the first 256 bytes of every EDF/BDF
 * straight from the URL the manifest names (public S3), so the Worker serves one
 * manifest per dataset and no recording bytes.
 *
 * **Tri-state, never fail-open.** A manifest that could not be read, a header that could
 * not be fetched, and a format this scanner does not parse are each COUNTED and reported
 * as such. A dataset is only `clean` when every EDF/BDF header was read and none flagged;
 * anything that could not be asked is `unchecked`, which is not clean (ADR 0067).
 *
 * **Output carries no values.** Per-dataset JSON holds kinds, counts, field shapes and
 * distinct-value COUNTS. A raw header value never leaves memory.
 *
 *   bun run scripts/identifier-fleet-scan.ts --out <dir> [--only nm000348,nm000246]
 *        [--concurrency 24] [--datasets 4] [--force]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EDF_HEADER_BYTES,
  type Finding,
  type FindingKind,
  countByKind,
  formatCoverage,
  scanAcqTime,
  scanEdfHeader,
  scanJsonKeys,
  scanPaths,
  scanTableColumns,
  scanTextForLocalPaths,
} from "../shared/identifier-scan";

const UA = "nemar-identifier-scan/1.0 (+https://docs.nemar.org/policies/takedown/)";
const API = process.env.NEMAR_API_BASE ?? "https://api.nemar.org";
const DATA = process.env.NEMAR_DATA_BASE ?? "https://data.nemar.org";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const outDir = arg("out");
if (!outDir) {
  console.error(
    "usage: identifier-fleet-scan.ts --out <dir> [--only ids] [--concurrency N] [--datasets N] [--force]",
  );
  process.exit(2);
}
const only = arg("only")?.split(",").filter(Boolean);
const fileConcurrency = Number(arg("concurrency", "24"));
const datasetConcurrency = Number(arg("datasets", "4"));
const force = process.argv.includes("--force");
mkdirSync(outDir, { recursive: true });

interface ManifestEntry {
  path: string;
  size: number;
  url: string;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw last;
}

/** Read at most `n` bytes from a URL, and stop reading even if the server ignores Range. */
async function readHead(url: string, n: number): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { Range: `bytes=0-${n - 1}`, "User-Agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    got += value.length;
  }
  await reader.cancel();
  const out = new Uint8Array(Math.min(got, n));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - at);
    out.set(c.subarray(0, take), at);
    at += take;
    if (at >= out.length) break;
  }
  return out;
}

async function readText(url: string, maxBytes: number): Promise<string> {
  const bytes = await readHead(url, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function listPublicDatasets(): Promise<{ id: string; version: string | null }[]> {
  const out: { id: string; version: string | null }[] = [];
  for (let offset = 0; ; offset += 100) {
    const res = await withRetry(() =>
      fetch(`${API}/datasets?limit=100&offset=${offset}`, { headers: { "User-Agent": UA } }),
    );
    if (!res.ok) throw new Error(`catalog list HTTP ${res.status}`);
    const body = (await res.json()) as {
      datasets: { dataset_id: string; latest_version: string | null; visibility: string }[];
      total_count: number;
    };
    for (const d of body.datasets) {
      if (d.visibility === "public") out.push({ id: d.dataset_id, version: d.latest_version });
    }
    if (offset + 100 >= body.total_count || body.datasets.length === 0) break;
  }
  return out;
}

class TooLarge extends Error {
  constructor() {
    super("manifest too large (HTTP 413)");
  }
}

let cachedGithubToken: string | null | undefined;
async function githubToken(): Promise<string | null> {
  if (cachedGithubToken !== undefined) return cachedGithubToken;
  if (process.env.GITHUB_TOKEN) {
    cachedGithubToken = process.env.GITHUB_TOKEN;
    return cachedGithubToken;
  }
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    cachedGithubToken = text === "" ? null : text;
  } catch {
    cachedGithubToken = null;
  }
  return cachedGithubToken;
}

/**
 * Entries for a dataset too large for the data plane's manifest.json, from the raw version
 * manifest in S3 (`<id>/version/<tag>.json`). Needs the `aws` CLI and credentials that can
 * read the bucket; a caller without them falls through to the git tree.
 */
async function s3Manifest(id: string, version: string): Promise<ManifestEntry[]> {
  const proc = Bun.spawn(["aws", "s3", "cp", `s3://nemar/${id}/version/${version}.json`, "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, errText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`aws s3 cp exit ${code}: ${errText.trim().split("\n").pop()}`);
  const doc = JSON.parse(text) as {
    files: Record<string, { key: string; size: number; bytes_url?: string }>;
  };
  return Object.entries(doc.files).map(([path, f]) => ({
    path,
    size: f.size,
    url: f.key.startsWith("git:")
      ? (f.bytes_url ?? "")
      : new URL(`https://nemar.s3.us-east-2.amazonaws.com/${id}/objects/${f.key}`).toString(),
  }));
}

/** Entries for a dataset too large for manifest.json: paths from the git tree, URLs via the data plane. */
async function treeAsManifest(id: string, version: string): Promise<ManifestEntry[]> {
  const token = await githubToken();
  const res = await withRetry(() =>
    fetch(`https://api.github.com/repos/nemarDatasets/${id}/git/trees/${version}?recursive=1`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(120_000),
    }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    truncated: boolean;
    tree: { path: string; type: string; size?: number }[];
  };
  if (body.truncated) throw new Error("tree truncated");
  return body.tree
    .filter((n) => n.type === "blob")
    .map((n) => ({
      path: n.path,
      size: n.size ?? 0,
      url: `${DATA}/${id}/${version}/${n.path.split("/").map(encodeURIComponent).join("/")}`,
    }));
}

/** Findings that name a person: the ones that must not stay public. */
const DIRECT_KINDS = new Set<FindingKind>([
  "edf-patient-name",
  "edf-patient-code",
  "edf-patient-freetext",
  "edf-patient-birthdate",
  "json-identifier-key",
  "participants-identifier-column",
]);
/** Calendar dates finer than year: barred by the Contributor Terms, but not a name. */
const DATE_KINDS = new Set<FindingKind>(["edf-startdate", "edf-recording-startdate"]);

const BIDS_SIDECAR =
  /_(eeg|ieeg|meg|emg|nirs|beh|events|channels|electrodes|coordsystem|scans|physio|stim|photo|T1w|bold)\.(json|tsv)$/;

async function scanDataset(id: string, version: string | null) {
  const result: Record<string, unknown> = { id, version, scanned_at: new Date().toISOString() };
  if (!version) return { ...result, status: "unchecked", reason: "no latest_version" };

  let manifest: ManifestEntry[];
  let manifestSource = "manifest.json";
  try {
    manifest = await withRetry(async () => {
      const res = await fetch(`${DATA}/${id}/${version}/manifest.json`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 413) throw new TooLarge();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ManifestEntry[];
    }, 2);
  } catch (error) {
    // The data plane refuses a manifest above its entry bound (ADR 0072); the git tree
    // lists the same paths, and each file is then read through the data plane's redirect.
    if (!(error instanceof TooLarge)) {
      return { ...result, status: "unchecked", reason: `manifest: ${(error as Error).message}` };
    }
    try {
      manifest = await s3Manifest(id, version);
      manifestSource = "s3-version-manifest";
    } catch (s3Error) {
      try {
        manifest = await treeAsManifest(id, version);
        manifestSource = "git-tree";
      } catch (treeError) {
        return {
          ...result,
          status: "unchecked",
          reason: `manifest too large; s3: ${(s3Error as Error).message}; tree: ${(treeError as Error).message}`,
        };
      }
    }
  }
  result.manifest_source = manifestSource;

  const paths = manifest.map((e) => e.path);
  const findings: Finding[] = [...scanPaths(paths)];
  const coverage = formatCoverage(paths);

  // EDF/BDF headers: every file, 256 bytes each.
  const edf = manifest.filter((e) => /\.(edf|bdf)$/i.test(e.path));
  let readOk = 0;
  let readFailed = 0;
  const flaggedFiles: Partial<Record<FindingKind, number>> = {};
  const patientValues = new Set<string>();
  const flaggedPatientValues = new Set<string>();
  const codeValues = new Set<string>();
  const nameValues = new Set<string>();
  const birthValues = new Set<string>();
  const subjects = new Set<string>();
  let flaggedFileCount = 0;
  await pool(edf, fileConcurrency, async (entry) => {
    try {
      const head = await withRetry(() => readHead(entry.url, EDF_HEADER_BYTES));
      readOk++;
      const found = scanEdfHeader(head);
      const patient = new TextDecoder("latin1")
        .decode(head.subarray(8, 88))
        .replace(/\0/g, " ")
        .trim();
      patientValues.add(patient);
      const parts = patient.split(/\s+/);
      if (parts.length >= 4) {
        codeValues.add(parts[0] as string);
        birthValues.add(parts[2] as string);
        nameValues.add(parts[3] as string);
      }
      subjects.add(/sub-([^/_]+)/.exec(entry.path)?.[1] ?? "?");
      if (found.some((f) => f.severity === "identifier")) {
        flaggedFileCount++;
        flaggedPatientValues.add(patient);
      }
      findings.push(...found);
      for (const kind of new Set(found.map((f) => f.kind))) {
        flaggedFiles[kind] = (flaggedFiles[kind] ?? 0) + 1;
      }
    } catch {
      readFailed++;
    }
  });

  // participants table columns, and the first scans table's acq_time values.
  const side: string[] = [];
  const participants = manifest.find((e) => e.path === "participants.tsv");
  if (participants) {
    try {
      const text = await withRetry(() => readText(participants.url, 16_384));
      findings.push(...scanTableColumns(text.split("\n")[0] ?? ""));
    } catch {
      side.push("participants.tsv");
    }
  }
  const scans = manifest.find((e) => e.path.endsWith("_scans.tsv"));
  if (scans) {
    try {
      const text = await withRetry(() => readText(scans.url, 16_384));
      const rows = text.replace(/^﻿/, "").split("\n");
      const col = (rows[0] ?? "").split("\t").indexOf("acq_time");
      if (col >= 0) {
        for (const row of rows.slice(1, 6))
          findings.push(...scanAcqTime(row.split("\t")[col] ?? ""));
      }
    } catch {
      side.push("scans.tsv");
    }
  }

  // Non-BIDS JSON (acquisition-software exports) and small code/text files.
  const jsons = manifest
    .filter((e) => e.path.endsWith(".json") && e.size <= 65_536)
    .filter((e) => e.path.startsWith("sourcedata/") || !BIDS_SIDECAR.test(e.path))
    .filter((e) => !/(^|\/)(dataset_description|participants|genetic_info)\.json$/.test(e.path))
    .slice(0, 300);
  const texts = manifest
    .filter((e) => /\.(py|m|r|txt|md|ya?ml|xml|iml|cfg|ini)$/i.test(e.path) && e.size <= 65_536)
    .filter((e) => e.path.startsWith("sourcedata/") || e.path.startsWith("code/"))
    .slice(0, 300);
  let sideFailed = 0;
  await pool(jsons, fileConcurrency, async (entry) => {
    try {
      const text = await withRetry(() => readText(entry.url, 65_536));
      findings.push(...scanJsonKeys(JSON.parse(text)));
    } catch {
      sideFailed++;
    }
  });
  await pool(texts, fileConcurrency, async (entry) => {
    try {
      findings.push(...scanTextForLocalPaths(await withRetry(() => readText(entry.url, 65_536))));
    } catch {
      sideFailed++;
    }
  });

  const identifier = findings.filter((f) => f.severity === "identifier");
  const review = findings.filter((f) => f.severity === "review");
  const complete = readFailed === 0 && sideFailed === 0 && side.length === 0;
  const direct = findings.some((f) => DIRECT_KINDS.has(f.kind));
  const dates = findings.some((f) => DATE_KINDS.has(f.kind));
  // A finding already made is never hidden by `unchecked`; `clean` needs every read to succeed.
  let status: string;
  if (direct) status = "direct-identifiers";
  else if (dates) status = "dates-only";
  else if (review.length > 0) status = "review";
  else status = complete ? "clean" : "unchecked";
  return {
    ...result,
    status,
    incomplete: !complete,
    files: {
      total: manifest.length,
      edf_bdf: edf.length,
      header_read: readOk,
      header_read_failed: readFailed,
    },
    edf_bdf_files_flagged: flaggedFileCount,
    distinct_patient_field_values: patientValues.size,
    distinct_subjects_with_edf_bdf: subjects.size,
    distinct_patient_code_subfield: codeValues.size,
    distinct_patient_name_subfield: nameValues.size,
    distinct_patient_birth_subfield: birthValues.size,
    distinct_patient_field_values_in_flagged_files: flaggedPatientValues.size,
    findings_by_kind: countByKind(findings),
    edf_bdf_files_by_kind: flaggedFiles,
    unscreened_formats: coverage.unscreened,
    side_reads_failed: sideFailed + side.length,
    finding_fields: [...new Set(identifier.map((f) => `${f.kind}:${f.field}`))].sort(),
  };
}

const catalog = await listPublicDatasets();
const targets = only ? catalog.filter((d) => only.includes(d.id)) : catalog;
console.error(`public datasets: ${catalog.length}; scanning ${targets.length}`);
let done = 0;
await pool(targets, datasetConcurrency, async ({ id, version }) => {
  const file = join(outDir, `${id}.json`);
  if (!force && existsSync(file)) {
    done++;
    return;
  }
  const t0 = Date.now();
  const record = await scanDataset(id, version);
  writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
  done++;
  const s = record as { status: string; files?: { edf_bdf: number } };
  console.error(
    `[${done}/${targets.length}] ${id} ${version ?? "-"} ${s.status} edf_bdf=${s.files?.edf_bdf ?? "-"} ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
});

// Summary: counts by status, and the identifier-flagged datasets (ids, never values).
const records = targets
  .map((d) => join(outDir, `${d.id}.json`))
  .filter((f) => existsSync(f))
  .map((f) => JSON.parse(readFileSync(f, "utf8")) as { id: string; status: string });
const byStatus: Record<string, string[]> = {};
for (const r of records) {
  const list = byStatus[r.status] ?? [];
  list.push(r.id);
  byStatus[r.status] = list;
}
const summary = Object.fromEntries(
  Object.entries(byStatus).map(([k, v]) => [k, { count: v.length, ids: v }]),
);
writeFileSync(join(outDir, "_summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
console.error(
  Object.entries(byStatus)
    .map(([k, v]) => `${k}=${v.length}`)
    .join("  "),
);
