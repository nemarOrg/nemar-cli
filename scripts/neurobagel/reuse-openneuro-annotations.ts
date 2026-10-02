/**
 * Convert Neurobagel's published OpenNeuro annotations into curation entries for NEMAR's mirrors
 * (epic #1586, phase 5; ADR 0084).
 *
 *   bun run scripts/neurobagel/reuse-openneuro-annotations.ts --report <file>
 *       measure only: how many of the catalog's `on` datasets would be covered, and at what size
 *   bun run scripts/neurobagel/reuse-openneuro-annotations.ts --out <file> --skip-redundant on000117 ...
 *       write the entries for these datasets as a curation file
 *   bun run scripts/neurobagel/reuse-openneuro-annotations.ts --merge-into shared/neurobagel/curation.json \
 *       --skip-redundant --date 2026-10-02 on000117 ...
 *       merge them into the committed file, leaving every other entry as it is
 *
 * Upstream is https://github.com/neurobagel/openneuro-annotations, MIT licence, pinned to one
 * commit (UPSTREAM in upstream-annotations.ts).
 * Every file is fetched at that commit and its git blob SHA is checked against the commit's tree,
 * so a reuse is of exactly the bytes the pin names.
 * All requests are read-only GETs with a descriptive User-Agent; nothing is posted, nothing is
 * opened on any neurobagel repository.
 *
 * The mirror's participants.tsv and participants.json are fetched from the data plane at its
 * latest version; an entry is kept only if the annotation fits that table
 * (upstream-annotations.ts), and it pins the table's git blob SHA.
 *
 * Options
 *   --out <file>          write the generated entries, as a curation file
 *   --merge-into <file>   merge them into this curation file instead
 *   --report <file>       write the counts as JSON (always printed too)
 *   --cache <dir>         keep fetched documents here and reuse them on the next run
 *   --save-upstream <dir> keep the upstream files the entries came from, with the licence and
 *                         a provenance.json, under <dir>/<short commit>/ (the test fixtures)
 *   --date YYYY-MM-DD     the date written into the evidence (default: today, UTC)
 *   --skip-redundant      leave out a column the mechanical rules already give the same values
 *   --base <url>          the data plane (default https://data.nemar.org)
 *   <on######>...         only these datasets (default: every `on` dataset in the catalog)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../shared/neurobagel/canonical-json";
import { gitBlobShaOfBytes } from "../../shared/neurobagel/git-blob";
import { DEFAULT_BASE, MAX_TABLE_BYTES, fetchDocument, get, listDatasetIds } from "./gather";
import {
  type Conversion,
  type MirrorDocuments,
  UPSTREAM,
  type UpstreamFile,
  convertUpstream,
} from "./upstream-annotations";

const raw = (file: string): string =>
  `https://raw.githubusercontent.com/${UPSTREAM.repo}/${UPSTREAM.commit}/${file}`;

function parseArgs(argv: string[]) {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const valueFlags = new Set([
    "--out",
    "--merge-into",
    "--report",
    "--cache",
    "--save-upstream",
    "--date",
    "--base",
  ]);
  return {
    out: flag("--out"),
    mergeInto: flag("--merge-into"),
    report: flag("--report"),
    cache: flag("--cache"),
    saveUpstream: flag("--save-upstream"),
    date: flag("--date") ?? new Date().toISOString().slice(0, 10),
    base: flag("--base") ?? DEFAULT_BASE,
    skipRedundant: argv.includes("--skip-redundant"),
    ids: argv.filter((a, i) => /^on\d{6}$/.test(a) && !valueFlags.has(argv[i - 1] ?? "")),
  };
}

/** Bytes by URL, kept in `cache` when one is given (the cache is only ever a speed-up). */
async function fetchBytes(url: string, cache: string | undefined): Promise<Uint8Array | null> {
  const file =
    cache === undefined ? null : join(cache, createHash("sha256").update(url).digest("hex"));
  if (file !== null && existsSync(file)) return new Uint8Array(readFileSync(file));
  const response = await get(url);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (file !== null) writeFileSync(file, bytes);
  return bytes;
}

/** The upstream files at the pinned commit with their blob SHAs, from the commit's tree. */
async function upstreamTree(cache: string | undefined): Promise<Map<string, string>> {
  const url = `https://api.github.com/repos/${UPSTREAM.repo}/git/trees/${UPSTREAM.commit}?recursive=1`;
  const bytes = await fetchBytes(url, cache);
  if (bytes === null) throw new Error(`the upstream tree ${url} is not there`);
  const tree = JSON.parse(new TextDecoder().decode(bytes)) as {
    truncated: boolean;
    tree: { path: string; type: string; sha: string }[];
  };
  if (tree.truncated)
    throw new Error("the upstream tree is truncated; the listing cannot be trusted");
  return new Map(
    tree.tree
      .filter((e) => e.type === "blob" && /^(ds\d{6}\.json|LICENSE)$/.test(e.path))
      .map((e) => [e.path, e.sha]),
  );
}

type MirrorResult =
  | { documents: MirrorDocuments }
  | { skip: "mirror_has_no_table" | "mirror_not_utf8" | "mirror_no_published_version" };

async function mirrorOf(
  id: string,
  base: string,
  cache: string | undefined,
): Promise<MirrorResult> {
  const indexBytes = await fetchBytes(`${base}/${id}/`, cache);
  const latest =
    indexBytes === null
      ? null
      : (JSON.parse(new TextDecoder().decode(indexBytes)) as { latest?: string | null }).latest;
  if (typeof latest !== "string" || latest === "") return { skip: "mirror_no_published_version" };
  const read = async (name: "participants.tsv" | "participants.json") => {
    const url = `${base}/${id}/${latest}/${name}`;
    const file =
      cache === undefined ? null : join(cache, createHash("sha256").update(url).digest("hex"));
    if (file !== null && existsSync(file)) return new Uint8Array(readFileSync(file));
    const doc = await fetchDocument(name, url, MAX_TABLE_BYTES);
    if (doc.bytes === null) {
      if (doc.status === 404) return null;
      throw new Error(
        `${url}: status ${doc.status}${doc.tooLargeOver ? ", over the size cap" : ""}`,
      );
    }
    if (file !== null) writeFileSync(file, doc.bytes);
    return doc.bytes;
  };
  const [tsv, json] = await Promise.all([read("participants.tsv"), read("participants.json")]);
  if (tsv === null) return { skip: "mirror_has_no_table" };
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    return {
      documents: {
        participantsTsv: decoder.decode(tsv),
        participantsJson: json === null ? null : decoder.decode(json),
        pins: {
          participantsTsv: await gitBlobShaOfBytes(tsv),
          participantsJson: json === null ? null : await gitBlobShaOfBytes(json),
        },
      },
    };
  } catch {
    return { skip: "mirror_not_utf8" };
  }
}

interface Row {
  id: string;
  /** Why the dataset has no entry, or null when it has one. */
  skip: string | null;
  /** Present once upstream and the mirror were both in hand. */
  conversion: Conversion | null;
  /** The upstream file as fetched, once it was. */
  upstream?: { file: string; blobSha: string; bytes: Uint8Array };
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Keep the upstream files the entries came from, the licence they carry, and where each came from. */
async function saveUpstream(
  args: ReturnType<typeof parseArgs>,
  rows: Row[],
  tree: Map<string, string>,
): Promise<void> {
  const dir = join(args.saveUpstream as string, UPSTREAM.commit.slice(0, 7));
  mkdirSync(dir, { recursive: true });
  const licenseSha = tree.get("LICENSE");
  const license = await fetchBytes(raw("LICENSE"), args.cache);
  if (
    licenseSha === undefined ||
    license === null ||
    (await gitBlobShaOfBytes(license)) !== licenseSha
  ) {
    throw new Error("the upstream LICENSE is missing or does not match the pinned tree");
  }
  writeFileSync(join(dir, "LICENSE"), license);
  const files: Record<string, unknown> = {
    LICENSE: {
      blob_sha: licenseSha,
      bytes: license.length,
      sha256: sha256Hex(license),
      url: raw("LICENSE"),
    },
  };
  for (const row of rows) {
    if (row.skip !== null || row.upstream === undefined) continue;
    writeFileSync(join(dir, row.upstream.file), row.upstream.bytes);
    files[row.upstream.file] = {
      blob_sha: row.upstream.blobSha,
      bytes: row.upstream.bytes.length,
      sha256: sha256Hex(row.upstream.bytes),
      url: raw(row.upstream.file),
    };
  }
  writeFileSync(
    join(dir, "provenance.json"),
    canonicalJson({
      commit: UPSTREAM.commit,
      fetched_at: new Date().toISOString(),
      files,
      license: UPSTREAM.license,
      repo: UPSTREAM.repo,
    } as never),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cache !== undefined) mkdirSync(args.cache, { recursive: true });
  const tree = await upstreamTree(args.cache);
  const catalog = (await listDatasetIds(args.base)).filter((id) => id.startsWith("on"));
  const ids = args.ids.length > 0 ? args.ids : catalog;
  for (const id of ids)
    if (!catalog.includes(id)) throw new Error(`${id} is not an on dataset in the catalog`);

  const rows: Row[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      const id = ids[i];
      const file = `ds${id.slice(2)}.json`;
      const blobSha = tree.get(file);
      if (blobSha === undefined) {
        rows.push({ id, skip: "no_upstream_file", conversion: null });
        continue;
      }
      const upstreamBytes = await fetchBytes(raw(file), args.cache);
      if (upstreamBytes === null)
        throw new Error(`${raw(file)} is listed in the tree but is not there`);
      if ((await gitBlobShaOfBytes(upstreamBytes)) !== blobSha) {
        throw new Error(`${file} does not match the blob SHA the pinned tree lists`);
      }
      const mirror = await mirrorOf(id, args.base, args.cache);
      if ("skip" in mirror) {
        rows.push({ id, skip: mirror.skip, conversion: null });
        continue;
      }
      const source: UpstreamFile = { file, blobSha };
      const outcome = await convertUpstream(
        id,
        JSON.parse(new TextDecoder().decode(upstreamBytes)) as unknown,
        source,
        mirror.documents,
        { date: args.date, skipRedundant: args.skipRedundant },
      );
      rows.push({
        id,
        skip: outcome.skip,
        conversion: outcome,
        upstream: { file, blobSha, bytes: upstreamBytes },
      });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  rows.sort((a, b) => (a.id < b.id ? -1 : 1));

  // The counts.
  const skips: Record<string, number> = {};
  const dropped: Record<string, number> = {};
  const notes: Record<string, number> = {};
  const keptByKind: Record<string, number> = {};
  let kept = 0;
  let redundant = 0;
  const entries: Record<string, unknown> = {};
  const sizes: number[] = [];
  for (const { id, skip, conversion } of rows) {
    if (conversion !== null) {
      for (const [k, n] of Object.entries(conversion.dropped)) dropped[k] = (dropped[k] ?? 0) + n;
      for (const [k, n] of Object.entries(conversion.notes)) notes[k] = (notes[k] ?? 0) + n;
      for (const [k, n] of Object.entries(conversion.keptByKind)) {
        keptByKind[k] = (keptByKind[k] ?? 0) + n;
      }
      redundant += conversion.redundant;
    }
    if (skip !== null) {
      skips[skip] = (skips[skip] ?? 0) + 1;
      continue;
    }
    if (conversion?.entry == null) continue;
    entries[id] = conversion.entry;
    kept += conversion.kept;
    sizes.push(canonicalJson({ [id]: conversion.entry } as never).length);
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  const report = {
    upstream: { commit: UPSTREAM.commit, license: UPSTREAM.license, repo: UPSTREAM.repo },
    options: { skip_redundant: args.skipRedundant },
    catalog_on_datasets: catalog.length,
    considered: ids.length,
    entries: Object.keys(entries).length,
    dataset_skips: Object.fromEntries(Object.entries(skips).sort()),
    columns: {
      kept,
      kept_by_kind: Object.fromEntries(Object.entries(keptByKind).sort()),
      redundant_with_mechanical: redundant,
      dropped_by_reason: Object.fromEntries(Object.entries(dropped).sort()),
    },
    notes: Object.fromEntries(Object.entries(notes).sort()),
    size_bytes: {
      all_entries: total,
      mean_entry: sizes.length === 0 ? 0 : Math.round(total / sizes.length),
      largest_entry: sizes.length === 0 ? 0 : Math.max(...sizes),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (args.report !== undefined) writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

  if (args.saveUpstream !== undefined) await saveUpstream(args, rows, tree);
  if (args.out !== undefined) {
    writeFileSync(args.out, canonicalJson({ datasets: entries, format: 1 } as never));
  }
  if (args.mergeInto !== undefined) {
    const existing = JSON.parse(readFileSync(args.mergeInto, "utf8")) as {
      datasets: Record<string, unknown>;
      format: number;
    };
    for (const [id, entry] of Object.entries(entries)) existing.datasets[id] = entry;
    writeFileSync(args.mergeInto, canonicalJson(existing as never));
  }
}

if (import.meta.main) await main();
