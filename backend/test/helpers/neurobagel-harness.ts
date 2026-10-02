/**
 * A real environment for the Neurobagel writer's tests (epic #1586, phase 4).
 *
 * Nothing here replaces business logic:
 *  - the database is bun:sqlite carrying EVERY production migration (`freshDb`);
 *  - the bucket is Miniflare's R2, the implementation `wrangler dev` runs;
 *  - the S3 manifest objects and the GitHub raw host are one real local HTTP server
 *    (`startS3ManifestStandin`), reached through `S3_ENDPOINT_URL` and
 *    `GITHUB_RAW_BASE`, the origin overrides the data-plane suites already use;
 *  - the data plane is the real `dataRoutes` app, called by the code under test.
 *
 * Only the two network boundaries are substituted (S3 and GitHub), and the server
 * logs every request so a test asserts on what was actually sent.
 *
 * `seedFromFixture` builds a dataset out of REAL documents: nm000132's published
 * manifest and the participants files captured from data.nemar.org in phase 1,
 * whose git blob SHAs equal the manifest's, so the data plane's broker accepts them.
 * The D1 row is seeded so that the route's `metadata.json` carries what the
 * fixture's did, and the writer's output must then equal the phase 1 golden BYTES.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { resetManifestAnswerMemo } from "../../src/services/manifest-source";
import type { Bindings } from "../../src/types/bindings";
import { InMemoryCache } from "./cache";
import { freshDb, realD1 } from "./d1";
import { type S3ManifestStandin, startS3ManifestStandin } from "./s3-manifest-standin";

const REPO_ROOT = join(import.meta.dir, "../../..");
export const FIXTURE_DIR = join(REPO_ROOT, "test/neurobagel/fixtures");
export const GOLDEN_DIR = join(REPO_ROOT, "test/neurobagel/golden");
const MANIFEST_FIXTURE = join(import.meta.dir, "../fixtures/manifest-nm000132-v1.1.1.json");

export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export interface DatasetSeed {
  name?: string;
  license?: string | null;
  subjectCount?: number | null;
  conceptDoi?: string | null;
  enrichmentJson?: string | null;
  versions?: [version: string, createdAt: string][];
  status?: string;
  visibility?: string;
  anonymous?: number;
  firstPublishedAt?: string | null;
  withdrawnAt?: string | null;
  isSandbox?: number;
  isExemplar?: number;
}

export function seedDatasetRow(db: Database, id: string, seed: DatasetSeed = {}): void {
  db.query(
    `INSERT INTO datasets
       (dataset_id, name, owner_user_id, status, visibility, is_sandbox, is_exemplar, anonymous,
        first_published_at, withdrawn_at, license, subject_count, concept_doi, enrichment_json)
     VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    seed.name ?? `Dataset ${id}`,
    seed.status ?? "active",
    seed.visibility ?? "public",
    seed.isSandbox ?? 0,
    seed.isExemplar ?? 0,
    seed.anonymous ?? 0,
    seed.firstPublishedAt === undefined ? "2026-01-02 03:04:05" : seed.firstPublishedAt,
    seed.withdrawnAt ?? null,
    seed.license === undefined ? "CC0-1.0" : seed.license,
    seed.subjectCount === undefined ? 3 : seed.subjectCount,
    seed.conceptDoi === undefined ? `10.82901/nemar.${id}` : seed.conceptDoi,
    seed.enrichmentJson === undefined ? null : seed.enrichmentJson,
  );
  for (const [version, createdAt] of seed.versions ?? [["1.0.0", "2026-01-02 03:04:05"]]) {
    db.query(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES (?, ?, ?, 'ezid', ?)`,
    ).run(id, version, `10.82901/nemar.${id}.v${version}`, createdAt);
  }
}

export interface Harness {
  db: Database;
  standin: S3ManifestStandin;
  mf: Miniflare;
  bucket: R2Bucket;
  /** Bindings for the writer: production-shaped unless overridden. */
  env(over?: Partial<Bindings>): Bindings;
  /** Reset D1, the bucket and the stand-in between tests. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

function installEdgeCache(): void {
  // The Workers Cache API the data plane's manifest and git-file caches and the rate
  // limiter use. A fresh one per test: a manifest copy trusted for 60 seconds must not
  // outlive the test that stored it.
  (globalThis as { caches?: unknown }).caches = { default: new InMemoryCache() };
  resetManifestAnswerMemo();
}

export async function startHarness(): Promise<Harness> {
  installEdgeCache();
  const standin = startS3ManifestStandin();
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2024-12-01",
    r2Buckets: ["NEUROBAGEL"],
  });
  const bucket = (await mf.getR2Bucket("NEUROBAGEL")) as unknown as R2Bucket;
  const harness: Harness = {
    db: freshDb(),
    standin,
    mf,
    bucket,
    env(over = {}) {
      return {
        DB: realD1(harness.db),
        ENVIRONMENT: "test",
        DATA_BASE_URL: "https://data.nemar.org",
        GITHUB_RAW_BASE: standin.url,
        S3_ENDPOINT_URL: standin.url,
        S3_BUCKET: "nemar",
        AWS_REGION: "us-east-2",
        AWS_ACCESS_KEY_ID: "AKIATEST",
        AWS_SECRET_ACCESS_KEY: "secret",
        GITHUB_ADMIN_PAT: "test-pat",
        NEUROBAGEL: bucket,
        NEUROBAGEL_WRITER_ENABLED: "1",
        ...over,
      } as Bindings;
    },
    async reset() {
      installEdgeCache();
      harness.db.close();
      harness.db = freshDb();
      standin.objects.clear();
      standin.log.length = 0;
      let cursor: string | undefined;
      do {
        const listed = await bucket.list({ cursor });
        for (const o of listed.objects) await bucket.delete(o.key);
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    },
    async dispose() {
      (globalThis as { caches?: unknown }).caches = undefined;
      await mf.dispose();
      standin.stop();
    },
  };
  return harness;
}

// ----------------------------------------------------------------------------
// Datasets
// ----------------------------------------------------------------------------

function manifestEntry(bytes: Uint8Array, git: boolean): Record<string, unknown> {
  if (git) {
    const sha = gitBlobSha(bytes);
    return { key: `git:${sha}`, size: bytes.length, checksum: `git:${sha}` };
  }
  const md5 = createHash("md5").update(bytes).digest("hex");
  return {
    key: `MD5E-s${bytes.length}--${md5}.edf`,
    size: bytes.length,
    checksum: `md5:${md5}`,
  };
}

export interface SyntheticOptions extends DatasetSeed {
  /** `participants.tsv` text, or null for a dataset with no table. */
  tsv?: string | null;
  participantsJson?: string | null;
  subjects?: string[];
  /** Serve participants.tsv as an ANNEXED file (the data plane answers 302). */
  annexTsv?: boolean;
  version?: string;
}

/** A small BIDS dataset: an EEG recording per subject and a participants table. */
export function seedSynthetic(h: Harness, id: string, o: SyntheticOptions = {}): void {
  const version = o.version ?? "1.0.0";
  const subjects = o.subjects ?? ["sub-01", "sub-02", "sub-03"];
  const tsv =
    o.tsv === undefined
      ? `participant_id\tage\tsex\n${subjects.map((s, i) => `${s}\t${20 + i}\t${i % 2 ? "F" : "M"}`).join("\n")}\n`
      : o.tsv;
  const pjson =
    o.participantsJson === undefined
      ? JSON.stringify({ age: { Units: "years" }, sex: { Levels: { M: "male", F: "female" } } })
      : o.participantsJson;
  const files: Record<string, unknown> = {};
  const raw = (path: string, text: string): void => {
    const bytes = new TextEncoder().encode(text);
    files[path] = manifestEntry(bytes, true);
    h.standin.put(`/nemarDatasets/${id}/v${version}/${path}`, bytes);
  };
  raw("dataset_description.json", JSON.stringify({ Name: `Dataset ${id}`, BIDSVersion: "1.9.0" }));
  if (tsv !== null) {
    if (o.annexTsv) {
      const bytes = new TextEncoder().encode(tsv);
      files["participants.tsv"] = manifestEntry(bytes, false);
    } else raw("participants.tsv", tsv);
  }
  if (pjson !== null) raw("participants.json", pjson);
  for (const s of subjects) {
    files[`${s}/eeg/${s}_task-rest_eeg.edf`] = manifestEntry(new TextEncoder().encode(s), false);
  }
  h.standin.put(
    `/${id}/version/v${version}.json`,
    JSON.stringify({
      dataset_id: id,
      version,
      doi: `10.82901/nemar.${id}.v${version}`,
      concept_doi: `10.82901/nemar.${id}`,
      created: "2026-01-02T03:04:05.000Z",
      files,
    }),
  );
  seedDatasetRow(h.db, id, {
    subjectCount: subjects.length,
    versions: [[version, "2026-01-02 03:04:05"]],
    enrichmentJson: JSON.stringify({
      version: "1.0",
      authors: { "Ada Lovelace": { affiliation: "Analytical Engines" } },
    }),
    ...o,
  });
}

/** nm000132 from its real manifest and the participants files captured in phase 1. */
export function seedFromFixture(h: Harness, id = "nm000132"): { annexKey?: string } {
  const manifestText = readFileSync(MANIFEST_FIXTURE, "utf8");
  h.standin.put(`/${id}/version/v1.1.1.json`, manifestText);
  for (const name of ["participants.tsv", "participants.json"]) {
    h.standin.put(`/nemarDatasets/${id}/v1.1.1/${name}`, readFileSync(join(FIXTURE_DIR, id, name)));
  }
  const metadata = JSON.parse(readFileSync(join(FIXTURE_DIR, id, "metadata.json"), "utf8")) as {
    name: string;
    license: string;
    authors: { name: string; orcid?: string }[];
    keywords: { term: string }[];
    demographics: { subjects_count: number };
    external_links: { dataset_doi: string };
  };
  // v2.0 enrichment, the shape that carries structured keywords: the same authors in
  // the same order, and the same keyword terms.
  const enrichment = {
    version: "2.0",
    license: metadata.license,
    authors: Object.fromEntries(
      metadata.authors.map((a) => [a.name, a.orcid ? { orcid: a.orcid } : {}]),
    ),
    keywords: metadata.keywords,
  };
  seedDatasetRow(h.db, id, {
    name: metadata.name,
    license: metadata.license,
    subjectCount: metadata.demographics.subjects_count,
    conceptDoi: metadata.external_links.dataset_doi,
    enrichmentJson: JSON.stringify(enrichment),
    versions: [
      ["1.0.0", "2026-03-14 12:20:43"],
      ["1.1.0", "2026-04-02 20:15:30"],
      ["1.1.1", "2026-04-04 06:05:15"],
    ],
  });
  return {};
}

export function golden(id: string, name: string): string {
  return readFileSync(join(GOLDEN_DIR, id, name), "utf8");
}

/** Every object key in the bucket, sorted. */
export async function storeKeys(bucket: R2Bucket): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor });
    keys.push(...listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

/**
 * Counts the writes a run makes to the bucket, by wrapping the REAL binding: every call
 * still reaches Miniflare's R2, and the wrapper only records it. Used to prove "a
 * second run writes nothing" and the ordering of writes against deletes.
 */
export function recordWrites(bucket: R2Bucket): {
  bucket: R2Bucket;
  log: { op: "put" | "delete"; key: string }[];
} {
  const log: { op: "put" | "delete"; key: string }[] = [];
  const wrapped = new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return (key: string, ...rest: unknown[]) => {
          log.push({ op: "put", key });
          return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
        };
      }
      if (prop === "delete") {
        return (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) log.push({ op: "delete", key: k });
          return target.delete(keys);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bucket: wrapped as R2Bucket, log };
}
