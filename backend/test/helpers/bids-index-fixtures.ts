/**
 * Real manifests for the BIDS index tests (epic #1586 Phase 2, #1588), and the
 * real `GET /<id>/metadata.json` route to serve them through.
 *
 * Every manifest here is a REAL published version manifest, never a generated
 * one. `backend/test/fixtures/bids-index-sessions/provenance.json` records
 * where each came from, when, and the sha256 of the file as committed; the
 * test that reads it recomputes the hash, so a fixture cannot drift from its
 * provenance silently.
 *
 *  - `nm000132`  no session directories at all: every datatype sits directly
 *                under the subject. The one fixture that exercises the
 *                no-session bucket on its own.
 *  - `on004196`  three sessions per subject with different datatypes in each
 *                (`01`: anat, fmap, func; `02`: fmap, func; `EEG`: eeg), so
 *                one session has no eeg and another has nothing but.
 *  - `on006033`  the same subject has eeg in one session and none in the
 *                other (`sub-01` `ses-01` has no eeg, `ses-02` does).
 *  - `on007347`  a MIXED layout: `eeg` under `ses-1`, `ses-2`, ... and `anat`
 *                directly under the subject with no session directory, which
 *                is the case where the no-session bucket sits beside real
 *                sessions.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { dataRoutes } from "../../src/routes/data";
import type { VersionManifest } from "../../src/services/manifest";
import type { Bindings, Variables } from "../../src/types/bindings";
import { freshDb, realD1 } from "./d1";
import { type S3ManifestStandin, startS3ManifestStandin } from "./s3-manifest-standin";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

export interface BidsIndexFixture {
  /** Dataset id the manifest was published under. */
  id: string;
  /** Version tag, with the `v`. */
  version: string;
  /** Path under `backend/test/fixtures/`. */
  file: string;
}

export const BIDS_INDEX_FIXTURES: readonly BidsIndexFixture[] = [
  { id: "nm000132", version: "v1.1.1", file: "manifest-nm000132-v1.1.1.json" },
  { id: "on004196", version: "v1.0.0", file: "bids-index-sessions/manifest-on004196-v1.0.0.json" },
  { id: "on006033", version: "v1.0.0", file: "bids-index-sessions/manifest-on006033-v1.0.0.json" },
  { id: "on007347", version: "v1.0.0", file: "bids-index-sessions/manifest-on007347-v1.0.0.json" },
];

export const BIDS_INDEX_PROVENANCE_FILE = join(FIXTURES, "bids-index-sessions", "provenance.json");

export function fixtureFilePath(fixture: BidsIndexFixture): string {
  return join(FIXTURES, fixture.file);
}

export function fixtureById(id: string): BidsIndexFixture {
  const found = BIDS_INDEX_FIXTURES.find((f) => f.id === id);
  if (!found) throw new Error(`no BIDS index fixture ${id}`);
  return found;
}

/** The manifest exactly as committed (the bytes the S3 stand-in serves). */
export function fixtureText(fixture: BidsIndexFixture): string {
  return readFileSync(fixtureFilePath(fixture), "utf8");
}

export function fixtureManifest(fixture: BidsIndexFixture): VersionManifest {
  return JSON.parse(fixtureText(fixture)) as VersionManifest;
}

/**
 * The real `dataRoutes` app over a real D1 and a real local HTTP server
 * standing in for S3: one public dataset per fixture, each with one published
 * version whose manifest is the fixture, so `GET /<id>/metadata.json` is the
 * production path from request to body.
 */
export interface MetadataJsonHarness {
  s3: S3ManifestStandin;
  db: Database;
  /**
   * Publish one more public dataset with one version whose manifest is `text`,
   * for a manifest that exists only to reach a rule no real one does. The
   * caller picks an id that is not a fixture's.
   */
  serveManifest(id: string, version: string, text: string): void;
  /** `GET /<id>/metadata.json` as text, for byte-level comparison. */
  metadataText(id: string): Promise<string>;
  stop(): void;
}

export function startMetadataJsonHarness(
  fixtures: readonly BidsIndexFixture[] = BIDS_INDEX_FIXTURES,
): MetadataJsonHarness {
  const s3 = startS3ManifestStandin();
  const db = freshDb();
  const serveManifest = (id: string, version: string, text: string): void => {
    db.prepare(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
       VALUES (?, ?, 1, 'active', 'public', 0)`,
    ).run(id, id);
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES (?, ?, ?, 'ezid', '2026-04-04 06:05:15')`,
    ).run(id, version.slice(1), `10.5072/FK2${id}`);
    s3.put(`/${id}/version/${version}.json`, text);
  };
  for (const fixture of fixtures) serveManifest(fixture.id, fixture.version, fixtureText(fixture));
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/", dataRoutes);
  const env = {
    DB: realD1(db),
    ENVIRONMENT: "test",
    DATA_BASE_URL: "https://data.nemar.org",
    S3_ENDPOINT_URL: s3.url,
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "AKIATEST",
    AWS_SECRET_ACCESS_KEY: "secret",
  } as Bindings;
  return {
    s3,
    db,
    serveManifest,
    async metadataText(id: string): Promise<string> {
      const res = await app.request(`https://data.nemar.org/${id}/metadata.json`, {}, env);
      if (res.status !== 200) throw new Error(`metadata.json for ${id} answered ${res.status}`);
      return res.text();
    },
    stop() {
      s3.stop();
      db.close();
    },
  };
}
