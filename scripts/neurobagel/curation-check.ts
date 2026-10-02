/**
 * Check every curation entry against the documents it pins (epic #1586, phase 5; ADR 0084).
 *
 *   bun run scripts/neurobagel/curation-check.ts                     # against the captured fixtures
 *   bun run scripts/neurobagel/curation-check.ts --live              # against data.nemar.org now
 *   bun run scripts/neurobagel/curation-check.ts --live nm000158 ... # only these entries
 *
 * Exit status 1 if any entry is not `applied`, with the reason: `stale` (a pinned file has
 * changed, so the entry needs a new review or, for a reused upstream annotation, a regeneration
 * with reuse-openneuro-annotations.ts) or `invalid` (the pinned files are in hand and the entry
 * does not fit them).
 * `--live` makes read-only GETs of the latest version's participants.tsv and participants.json
 * with a descriptive User-Agent, and decodes them as the writer must: UTF-8, byte order mark kept.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bindCuration } from "../../shared/neurobagel/curation-bind";
import type { CurationEntry } from "../../shared/neurobagel/curation-types";
import { parseTsv } from "../../shared/neurobagel/tsv";
import { FIXTURE_ROOT, loadCuration } from "./fixtures-io";
import { DEFAULT_BASE, MAX_TABLE_BYTES, fetchDocument, get } from "./gather";

interface Documents {
  participantsTsv: string | null;
  participantsJson: string | null;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fromFixtures(id: string): Documents {
  const text = (name: string): string | null => {
    const path = join(FIXTURE_ROOT, id, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  return { participantsTsv: text("participants.tsv"), participantsJson: text("participants.json") };
}

async function fromDataPlane(id: string, base: string): Promise<Documents> {
  const response = await get(`${base}/${id}/`, { Accept: "application/json" });
  const index = (await response.json()) as { latest?: string | null };
  if (typeof index.latest !== "string") throw new Error(`${id} has no published version`);
  const read = async (name: "participants.tsv" | "participants.json"): Promise<string | null> => {
    const doc = await fetchDocument(name, `${base}/${id}/${index.latest}/${name}`, MAX_TABLE_BYTES);
    if (doc.bytes === null) {
      if (doc.status === 404) return null;
      throw new Error(`${id} ${name}: status ${doc.status}`);
    }
    return decoder.decode(doc.bytes);
  };
  return {
    participantsTsv: await read("participants.tsv"),
    participantsJson: await read("participants.json"),
  };
}

/** The status of an entry against documents, and what to do about it when it is not applied. */
export async function checkEntry(
  entry: CurationEntry,
  documents: Documents,
): Promise<{ status: string; detail: string }> {
  const parsed = documents.participantsTsv === null ? null : parseTsv(documents.participantsTsv);
  const table = parsed?.ok ? { header: parsed.table.header, rows: parsed.table.rows } : null;
  const result = await bindCuration(entry, documents, table);
  if (result.status === "applied") return { status: "applied", detail: "" };
  if (result.status === "stale") {
    return { status: "stale", detail: `changed since review: ${result.staleFiles.join(", ")}` };
  }
  return { status: "invalid", detail: result.problems.join("; ") };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const only = args.filter((a) => /^(nm|on)\d{6}$/.test(a));
  const entries = [...loadCuration().entries.values()].filter(
    (e) => only.length === 0 || only.includes(e.datasetId),
  );
  let notApplied = 0;
  for (const entry of entries) {
    const documents = live
      ? await fromDataPlane(entry.datasetId, DEFAULT_BASE)
      : fromFixtures(entry.datasetId);
    const { status, detail } = await checkEntry(entry, documents);
    if (status !== "applied") notApplied++;
    console.log(
      `${entry.datasetId}  ${entry.evidence.review.padEnd(18)}  ${status}${detail === "" ? "" : `  ${detail}`}`,
    );
  }
  console.log(
    `\n${entries.length} entries, ${entries.length - notApplied} applied, ${notApplied} not`,
  );
  if (notApplied > 0) process.exit(1);
}

if (import.meta.main) await main();
