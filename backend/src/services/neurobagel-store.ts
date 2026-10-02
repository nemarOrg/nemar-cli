/**
 * The Neurobagel artifact store, READ side (epic #1586, phase 4; ADR 0084).
 *
 * One private R2 bucket (binding `NEUROBAGEL`, `nemar-neurobagel` in production and
 * `nemar-neurobagel-dev` in `[env.dev]`) holds, per eligible dataset, up to three
 * artifacts and, beside them, one `index.json` the node's loader pulls.
 *
 * This module names objects, lists the bucket, and builds the index from that
 * listing. It never writes: the ONLY module that calls `put` or `delete` on the
 * binding is `neurobagel-writer.ts`, and a source scan (neurobagel-source-scan
 * test) fails if another one does.
 *
 * The index format is `deploy/neurobagel/index.schema.json`, the single source of
 * truth the loader, `tools/build-index.sh` and this file all follow; a test
 * validates what {@link buildIndexDocument} builds against that very file and
 * fails if the constants below drift from it.
 *
 * THE INDEX IS DERIVED FROM THE LISTING, not from memory. Every artifact carries its
 * own sha256 as R2 custom metadata (R2 verifies it on write), so the bucket listing
 * alone holds what the index needs, and an index lost, truncated or written by a
 * run that was interrupted is rebuilt exactly by the next run.
 */

import { canonicalJson } from "../../../shared/neurobagel/canonical-json.js";

export const NEUROBAGEL_INDEX_KEY = "index.json";
export const NEUROBAGEL_INDEX_SCHEMA = "nemar-neurobagel-artifact-index/1";
/** Artifacts per dataset, in the order the index lists them (and the reference fingerprint hashes them). */
export const ARTIFACT_KINDS = ["jsonld", "dictionary", "description"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** `x-rules.artifactSuffix` of the schema. */
export const ARTIFACT_SUFFIX: Record<ArtifactKind, string> = {
  jsonld: ".jsonld",
  dictionary: "_annotated.json",
  description: "_dataset_description.json",
};

export const ARTIFACT_CONTENT_TYPE: Record<ArtifactKind, string> = {
  jsonld: "application/ld+json",
  dictionary: "application/json",
  description: "application/json",
};

/** The only dataset ids the store holds: `nm` and `on` (an `xx` or reserved id is never stored). */
const DATASET_ID = "(?:nm|on)\\d{6}";
/** A strict artifact name. Anything that is not exactly this is not served and not indexed. */
export const ARTIFACT_NAME_RE = new RegExp(
  `^(${DATASET_ID})(\\.jsonld|_annotated\\.json|_dataset_description\\.json)$`,
);
export const DATASET_ID_RE = new RegExp(`^${DATASET_ID}$`);

export function artifactName(datasetId: string, kind: ArtifactKind): string {
  return `${datasetId}${ARTIFACT_SUFFIX[kind]}`;
}

export function parseArtifactName(name: string): { datasetId: string; kind: ArtifactKind } | null {
  const m = ARTIFACT_NAME_RE.exec(name);
  if (!m) return null;
  const suffix = m[2];
  const kind = ARTIFACT_KINDS.find((k) => ARTIFACT_SUFFIX[k] === suffix);
  return kind ? { datasetId: m[1] as string, kind } : null;
}

/**
 * R2 custom metadata the writer stamps. Short keys: R2 allows 2 KiB for all of
 * them. `sha256` and `kind` ride on every artifact; the rest only on the JSON-LD,
 * which is written LAST and so is the commit marker of a dataset's set.
 */
export const META = {
  sha256: "sha256",
  kind: "kind",
  /** Input fingerprint, `sha256:` over everything the output depends on. */
  fingerprint: "fp",
  /** The same without the manifest ETag: derivable from D1 alone. */
  rowFingerprint: "rfp",
  manifestEtag: "etag",
  /** Cheap signature of the D1 row, for finding likely-stale datasets in one query. */
  signature: "sig",
  version: "ver",
  transformVersion: "tv",
  /** Comma-separated needs-review flags of the report. */
  flags: "flags",
  generatedAt: "at",
} as const;

export interface StoredArtifact {
  key: string;
  size: number;
  sha256: string;
  kind: ArtifactKind;
  meta: Record<string, string>;
}

export interface StoredDataset {
  id: string;
  jsonld: StoredArtifact | null;
  dictionary: StoredArtifact | null;
  description: StoredArtifact | null;
}

export interface StoreListing {
  datasets: Map<string, StoredDataset>;
  /** Keys that are neither the index nor a strict artifact name. Never served, never indexed. */
  unexpected: string[];
  /** The index object as the listing saw it. */
  index: { etag: string; size: number } | null;
  /**
   * How many objects the listing held in all (the index, artifacts and anything else).
   * A listing that fails part way throws instead of returning: nothing may be inferred
   * from an incomplete one, so there is no flag for it.
   */
  objects: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The most list calls one listing may make. At the 100 objects a call returns in the
 * simulator (see LIST_PAGE_OBJECTS in the writer) that bounds the store at about 10,000
 * objects: roughly 3,300 datasets of three artifacts and the index. Past it the listing
 * FAILS, loudly, rather than returning part of the store.
 */
export const LIST_MAX_PAGES = 100;

/** R2's `include` option, which the installed Workers typings do not declare. */
type ListOptionsWithInclude = NonNullable<Parameters<R2Bucket["list"]>[0]> & {
  include: ("httpMetadata" | "customMetadata")[];
};

/**
 * List the whole bucket, with custom metadata, following the cursor to the end.
 *
 * Throws on any R2 failure: an incomplete listing must never be read as "these
 * datasets are absent", which would delete them or drop them from the index.
 */
export async function listStore(
  bucket: R2Bucket,
  maxPages: number = LIST_MAX_PAGES,
): Promise<StoreListing> {
  const datasets = new Map<string, StoredDataset>();
  const unexpected: string[] = [];
  let index: StoreListing["index"] = null;
  let objects = 0;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    // `include` is a runtime option the installed Workers typings do not declare yet;
    // without it R2 returns no custom metadata and no artifact would be recognized.
    const listed = await bucket.list({
      include: ["customMetadata"],
      cursor,
    } as ListOptionsWithInclude);
    for (const object of listed.objects) {
      objects++;
      if (object.key === NEUROBAGEL_INDEX_KEY) {
        index = { etag: object.etag, size: object.size };
        continue;
      }
      const parsed = parseArtifactName(object.key);
      if (!parsed) {
        unexpected.push(object.key);
        continue;
      }
      const meta = object.customMetadata ?? {};
      const sha = meta[META.sha256];
      if (!sha || !SHA256_HEX.test(sha) || meta[META.kind] !== parsed.kind) {
        // Not written by the writer (or written by an older shape): never indexed.
        unexpected.push(object.key);
        continue;
      }
      const stored = datasets.get(parsed.datasetId) ?? {
        id: parsed.datasetId,
        jsonld: null,
        dictionary: null,
        description: null,
      };
      stored[parsed.kind] = {
        key: object.key,
        size: object.size,
        sha256: sha,
        kind: parsed.kind,
        meta: { ...meta },
      };
      datasets.set(parsed.datasetId, stored);
    }
    if (!listed.truncated) return { datasets, unexpected, index, objects };
    cursor = listed.cursor;
  }
  // Never a truncated listing handed back as if it were whole: that would read as "these
  // datasets are absent" and delete them, or drop them from the index. The run fails loudly
  // instead (its status is `error`, and `status` reports the store as unreadable).
  throw new Error(
    `the Neurobagel store listing did not finish within ${maxPages} pages (${objects} objects so far): the store is larger than this writer can list`,
  );
}

/** The one SHA-256 of this feature: lower-case hex of the digest of `bytes`. */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IndexArtifact {
  name: string;
  kind: ArtifactKind;
  sha256: string;
  bytes: number;
}

export interface IndexDataset {
  id: string;
  /** Reference form: sha256 of the artifacts' own hashes, so it changes whenever any artifact does. */
  fingerprint: string;
  /** The writer's input fingerprint (additive field; the loader ignores unknown keys). */
  input_fingerprint: string;
  artifacts: IndexArtifact[];
}

export interface IndexDocument {
  schema: typeof NEUROBAGEL_INDEX_SCHEMA;
  generated_at: string;
  datasets: IndexDataset[];
}

/**
 * A dataset's index entry from what the listing holds, or null when the set is not
 * complete enough to be indexed: no JSON-LD, or a JSON-LD the writer did not stamp.
 */
export async function indexEntryFor(stored: StoredDataset): Promise<IndexDataset | null> {
  const jsonld = stored.jsonld;
  if (!jsonld || !jsonld.meta[META.fingerprint]) return null;
  const artifacts: IndexArtifact[] = [];
  let hashes = "";
  for (const kind of ARTIFACT_KINDS) {
    const a = stored[kind];
    if (!a || a.size < 1) continue;
    artifacts.push({ name: a.key, kind, sha256: a.sha256, bytes: a.size });
    hashes += a.sha256;
  }
  return {
    id: stored.id,
    fingerprint: `sha256:${await sha256OfBytes(new TextEncoder().encode(hashes))}`,
    input_fingerprint: jsonld.meta[META.fingerprint] as string,
    artifacts,
  };
}

/**
 * The index the store SHOULD hold: every dataset the listing has a complete set for
 * AND that is eligible right now. Removal is by omission, so this is the one place
 * an ineligible dataset leaves the index.
 *
 * `previous` is the index currently stored (parsed), if any. When its entries are
 * identical to the new ones the previous `generated_at` is kept and `changed` is
 * false, so a run that changed nothing writes nothing.
 */
export async function buildIndexDocument(
  listing: StoreListing,
  eligibleIds: ReadonlySet<string>,
  previous: IndexDocument | null,
  now: string,
): Promise<{ document: IndexDocument; changed: boolean; skippedIncomplete: string[] }> {
  const entries: IndexDataset[] = [];
  const skippedIncomplete: string[] = [];
  for (const id of [...listing.datasets.keys()].sort()) {
    if (!eligibleIds.has(id)) continue;
    const entry = await indexEntryFor(listing.datasets.get(id) as StoredDataset);
    if (entry) entries.push(entry);
    else skippedIncomplete.push(id);
  }
  const matchesPrevious =
    previous !== null &&
    previous.schema === NEUROBAGEL_INDEX_SCHEMA &&
    canonicalJson(previous.datasets as never) === canonicalJson(entries as never);
  // No index and nothing to put in one is not a change: an empty first index would say
  // nothing the absence does not, and the loader refuses an empty index anyway.
  const unchanged = matchesPrevious || (previous === null && entries.length === 0);
  return {
    document: {
      schema: NEUROBAGEL_INDEX_SCHEMA,
      generated_at: matchesPrevious && previous ? previous.generated_at : now,
      datasets: entries,
    },
    changed: !unchanged,
    skippedIncomplete,
  };
}

/** The index as stored: compact JSON and a newline. */
export function serializeIndex(document: IndexDocument): string {
  return `${JSON.stringify(document)}\n`;
}

const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/;

/**
 * The rules of `deploy/neurobagel/index.schema.json` that matter to a producer,
 * checked before an index is written: refuse to publish a document the loader
 * would refuse. Returns the problems, empty when the document conforms.
 * (The test suite validates against the schema file itself with a real JSON Schema
 * validator; this is the producer-side guard and is checked against that file too.)
 */
export function indexProblems(document: IndexDocument): string[] {
  const problems: string[] = [];
  if (document.schema !== NEUROBAGEL_INDEX_SCHEMA) problems.push("schema is not the index schema");
  if (!ISO_UTC.test(document.generated_at)) problems.push("generated_at is not a UTC timestamp");
  if (document.datasets.length > 5000) problems.push("more than 5000 datasets");
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const d of document.datasets) {
    if (ids.has(d.id)) problems.push(`duplicate dataset id ${d.id}`);
    ids.add(d.id);
    if (!/^sha256:[0-9a-f]{64}$/.test(d.fingerprint)) problems.push(`${d.id}: bad fingerprint`);
    if (d.artifacts.length < 1 || d.artifacts.length > 3) problems.push(`${d.id}: artifact count`);
    const jsonlds = d.artifacts.filter((a) => a.kind === "jsonld");
    if (jsonlds.length !== 1) problems.push(`${d.id}: needs exactly one jsonld`);
    for (const a of d.artifacts) {
      if (a.name !== `${d.id}${ARTIFACT_SUFFIX[a.kind]}`)
        problems.push(`${a.name}: name is not id + suffix`);
      if (names.has(a.name)) problems.push(`duplicate artifact name ${a.name}`);
      names.add(a.name);
      if (!SHA256_HEX.test(a.sha256)) problems.push(`${a.name}: bad sha256`);
      if (!Number.isInteger(a.bytes) || a.bytes < 1) problems.push(`${a.name}: bad bytes`);
    }
  }
  return problems;
}

/** Parse a stored index, or null when it is absent or not an index of this schema. */
export function parseStoredIndex(text: string): IndexDocument | null {
  try {
    const parsed = JSON.parse(text) as Partial<IndexDocument>;
    if (
      parsed &&
      parsed.schema === NEUROBAGEL_INDEX_SCHEMA &&
      typeof parsed.generated_at === "string" &&
      Array.isArray(parsed.datasets)
    ) {
      return parsed as IndexDocument;
    }
  } catch {
    // not JSON: treated as no usable index, and replaced
  }
  return null;
}

/** The stored index, parsed, with its ETag; null when absent or unusable. */
export async function readStoredIndex(
  bucket: R2Bucket,
): Promise<{ document: IndexDocument | null; etag: string | null }> {
  const object = await bucket.get(NEUROBAGEL_INDEX_KEY);
  if (!object) return { document: null, etag: null };
  return { document: parseStoredIndex(await object.text()), etag: object.etag };
}
