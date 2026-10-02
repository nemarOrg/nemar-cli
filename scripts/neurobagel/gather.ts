/**
 * HTTP gatherer: reads the three documents the NEMAR data plane serves for a
 * dataset and hands them to the Neurobagel transform.
 *
 *   bun run scripts/neurobagel/gather.ts --out <dir> <dataset-id>...
 *   bun run scripts/neurobagel/gather.ts --out <dir> --base https://data-test.nemar.org --metadata-only nm099998
 *   bun run scripts/neurobagel/gather.ts --list            # ids in the public catalog
 *
 * This is the ONLY place in the Neurobagel pipeline that does I/O.
 * The transform (shared/neurobagel) takes plain documents and never fetches.
 *
 * Documents (all public, read-only GETs, no credentials):
 *   <base>/<id>/                              version index, for the latest version tag
 *   <base>/<id>/metadata.json                 identity and structure (ADR 0065: the backend writes
 *                                             and blinds it; depositor files are never an identity source)
 *   <base>/<id>/<latest>/participants.tsv     phenotype table, absent for some datasets
 *   <base>/<id>/<latest>/participants.json    its column descriptions, absent for some datasets
 *
 * A git-annexed file answers 302 to a short-lived presigned object URL.
 * The gatherer follows it and records only that the response was redirected:
 * the presigned URL carries a credential identifier and a signature and must
 * never reach a fixture, a log or a commit.
 * Every body is size-capped; a larger one is reported, not truncated.
 *
 * Nothing whose metadata is not `anonymous: false` is ever written to disk
 * (see {@link refusalToWrite}); the one exception is the declared anonymous control
 * on the dev data host, metadata only.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CanonicalJsonValue, canonicalJson } from "../../shared/neurobagel/canonical-json";

export const DEFAULT_BASE = "https://data.nemar.org";
const USER_AGENT = "nemar-neurobagel-dev/1.0";
const MAX_ATTEMPTS = 4;

/** metadata.json carries the bids_index, so it grows with the subject count. */
export const MAX_METADATA_BYTES = 64 * 1024 * 1024;
/** participants.tsv and participants.json are small; anything larger is not a phenotype table. */
export const MAX_TABLE_BYTES = 8 * 1024 * 1024;

export type DocumentName = "metadata.json" | "participants.tsv" | "participants.json";

/**
 * The one anonymous deposit this repository may hold, and only its public blinded
 * `metadata.json`: the standing negative control on the dev data host (ADR 0068;
 * AGENTS.md).
 * The live anonymous deposit, nm000284, is never fetched into a fixture.
 */
export const ANONYMOUS_CONTROL = {
  base: "https://data-test.nemar.org",
  datasetId: "nm099998",
} as const;

export interface GatheredDocument {
  name: DocumentName;
  /** The data-plane URL requested, never a redirect target. */
  url: string;
  /** HTTP status of the final response; 404 means the dataset has no such file. */
  status: number;
  bytes: Uint8Array<ArrayBuffer> | null;
  sha256: string | null;
  etag: string | null;
  /** True when the data plane answered with a redirect (an annexed file). */
  redirected: boolean;
  /** Set instead of `bytes` when the body exceeded its cap. */
  tooLargeOver: number | null;
  /** True when the document was deliberately not requested (see `metadataOnly`). */
  skipped: boolean;
}

export interface GatherOptions {
  /**
   * Fetch metadata.json only. participants.tsv and participants.json are depositor
   * files, which cannot be blinded (ADR 0067), so the anonymous control is gathered
   * without them.
   */
  metadataOnly?: boolean;
}

export interface GatheredDataset {
  datasetId: string;
  base: string;
  fetchedAt: string;
  latestVersion: string;
  metadata: GatheredDocument;
  participantsTsv: GatheredDocument;
  participantsJson: GatheredDocument;
}

export class GatherError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GatherError";
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readCapped(
  response: Response,
  cap: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...headers },
        redirect: "follow",
      });
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        lastError = new GatherError(`GET ${url} -> ${response.status}`, url, response.status);
        const retryAfter = Number(response.headers.get("retry-after"));
        await Bun.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 750,
        );
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      await Bun.sleep(attempt * 750);
    }
  }
  throw lastError instanceof Error ? lastError : new GatherError(`GET ${url} failed`, url, null);
}

async function fetchDocument(
  name: DocumentName,
  url: string,
  cap: number,
): Promise<GatheredDocument> {
  const response = await get(url);
  const base = {
    name,
    url,
    status: response.status,
    etag: response.headers.get("etag"),
    redirected: response.redirected,
  };
  if (response.status === 404) {
    await response.body?.cancel();
    return { ...base, bytes: null, sha256: null, tooLargeOver: null, skipped: false };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GatherError(`GET ${url} -> ${response.status}`, url, response.status);
  }
  const bytes = await readCapped(response, cap);
  if (bytes === null) {
    return { ...base, bytes: null, sha256: null, tooLargeOver: cap, skipped: false };
  }
  return { ...base, bytes, sha256: await sha256Hex(bytes), tooLargeOver: null, skipped: false };
}

/** The ids of every dataset in the public catalog at `base`. */
export async function listDatasetIds(base: string = DEFAULT_BASE): Promise<string[]> {
  const response = await get(`${base}/`);
  if (!response.ok)
    throw new GatherError(`GET ${base}/ -> ${response.status}`, `${base}/`, response.status);
  const body = (await response.json()) as { datasets: { id: string }[] };
  return body.datasets.map((d) => d.id).sort();
}

function skippedDocument(name: DocumentName, url: string): GatheredDocument {
  return {
    name,
    url,
    status: 0,
    bytes: null,
    sha256: null,
    etag: null,
    redirected: false,
    tooLargeOver: null,
    skipped: true,
  };
}

export async function gatherDataset(
  datasetId: string,
  base: string = DEFAULT_BASE,
  options: GatherOptions = {},
): Promise<GatheredDataset> {
  if (!/^[a-z]{2}\d{6}$/.test(datasetId)) throw new Error(`not a dataset id: ${datasetId}`);
  const fetchedAt = new Date().toISOString();
  const indexUrl = `${base}/${datasetId}/`;
  const indexResponse = await get(indexUrl, { Accept: "application/json" });
  if (!indexResponse.ok) {
    throw new GatherError(
      `GET ${indexUrl} -> ${indexResponse.status}`,
      indexUrl,
      indexResponse.status,
    );
  }
  const index = (await indexResponse.json()) as { latest?: string | null };
  if (typeof index.latest !== "string" || index.latest === "") {
    throw new GatherError(`${datasetId} has no published version`, indexUrl, null);
  }
  const latestVersion = index.latest;
  const root = `${base}/${datasetId}`;
  const tsvUrl = `${root}/${latestVersion}/participants.tsv`;
  const jsonUrl = `${root}/${latestVersion}/participants.json`;
  const [metadata, participantsTsv, participantsJson] = await Promise.all([
    fetchDocument("metadata.json", `${root}/metadata.json`, MAX_METADATA_BYTES),
    options.metadataOnly
      ? skippedDocument("participants.tsv", tsvUrl)
      : fetchDocument("participants.tsv", tsvUrl, MAX_TABLE_BYTES),
    options.metadataOnly
      ? skippedDocument("participants.json", jsonUrl)
      : fetchDocument("participants.json", jsonUrl, MAX_TABLE_BYTES),
  ]);
  if (metadata.status === 404) {
    throw new GatherError(`${datasetId} has no metadata.json`, metadata.url, 404);
  }
  return {
    datasetId,
    base,
    fetchedAt,
    latestVersion,
    metadata,
    participantsTsv,
    participantsJson,
  };
}

function documentProvenance(doc: GatheredDocument): CanonicalJsonValue {
  return {
    absent: doc.status === 404,
    bytes: doc.bytes?.length ?? null,
    etag: doc.etag,
    redirected: doc.redirected,
    sha256: doc.sha256,
    skipped: doc.skipped,
    status: doc.status,
    too_large_over_bytes: doc.tooLargeOver,
    url: doc.url,
  };
}

/** What a fixture's provenance.json records: where each byte came from, and when. */
export function provenanceOf(gathered: GatheredDataset): CanonicalJsonValue {
  return {
    base: gathered.base,
    dataset_id: gathered.datasetId,
    documents: {
      "metadata.json": documentProvenance(gathered.metadata),
      "participants.json": documentProvenance(gathered.participantsJson),
      "participants.tsv": documentProvenance(gathered.participantsTsv),
    },
    fetched_at: gathered.fetchedAt,
    latest_version: gathered.latestVersion,
  };
}

/**
 * Why a gathered document set must NOT be written to disk, or null when it may be.
 *
 * Anything whose metadata does not say `anonymous: false` is refused, because its
 * depositor files cannot be blinded and a fixture is committed to a public repository.
 * The single exception is the declared control on the dev data host, and then only its
 * metadata.json: a participants file of an anonymous deposit is never written.
 */
export function refusalToWrite(gathered: GatheredDataset): string | null {
  const bytes = gathered.metadata.bytes;
  if (bytes === null) return `${gathered.datasetId} has no metadata.json to check`;
  let anonymous: unknown;
  try {
    anonymous = (JSON.parse(new TextDecoder().decode(bytes)) as { anonymous?: unknown }).anonymous;
  } catch {
    return `${gathered.datasetId} metadata.json is not JSON`;
  }
  if (anonymous === false) return null;
  const isControl =
    gathered.datasetId === ANONYMOUS_CONTROL.datasetId && gathered.base === ANONYMOUS_CONTROL.base;
  if (!isControl) {
    return `${gathered.datasetId} at ${gathered.base} is not anonymous: false, so no document of it is written`;
  }
  if (gathered.participantsTsv.bytes !== null || gathered.participantsJson.bytes !== null) {
    return `${gathered.datasetId} is anonymous: only its metadata.json may be written, not its participants files`;
  }
  return null;
}

/** Write the documents exactly as served, plus provenance.json, into `<outDir>/<id>/`. */
export function writeFixture(gathered: GatheredDataset, outDir: string): string {
  const refusal = refusalToWrite(gathered);
  if (refusal !== null) throw new GatherError(refusal, gathered.metadata.url, null);
  const dir = join(outDir, gathered.datasetId);
  mkdirSync(dir, { recursive: true });
  for (const doc of [gathered.metadata, gathered.participantsTsv, gathered.participantsJson]) {
    if (doc.bytes) writeFileSync(join(dir, doc.name), doc.bytes);
  }
  writeFileSync(join(dir, "provenance.json"), canonicalJson(provenanceOf(gathered)));
  return dir;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const base = flag("--base") ?? DEFAULT_BASE;
  if (args.includes("--list")) {
    console.log((await listDatasetIds(base)).join("\n"));
    return;
  }
  const out = flag("--out");
  const ids = args.filter(
    (a, i) => /^[a-z]{2}\d{6}$/.test(a) && args[i - 1] !== "--out" && args[i - 1] !== "--base",
  );
  const metadataOnly = args.includes("--metadata-only");
  if (!out || ids.length === 0) {
    console.error(
      "usage: gather.ts --out <dir> [--base <url>] [--metadata-only] <dataset-id>... | --list [--base <url>]",
    );
    process.exit(2);
  }
  for (const id of ids) {
    const gathered = await gatherDataset(id, base, { metadataOnly });
    const dir = writeFixture(gathered, out);
    const sizes = [gathered.metadata, gathered.participantsTsv, gathered.participantsJson]
      .map((d) => `${d.name}=${d.bytes?.length ?? d.status}`)
      .join(" ");
    console.log(`${id} ${gathered.latestVersion} -> ${dir} (${sizes})`);
  }
}

if (import.meta.main) await main();
