/**
 * The data-plane landing (`GET /<id>` as JSON) carries a three-valued `mirror` flag on every
 * version (epic #1046 phase 4b, #1910; ADR 0111, decision 5), derived from the version rows on
 * real SQLite through the real route. The public landing exposes the flag only, never the
 * upstream tag or its basis.
 *
 * `shared/source-snapshot.ts` holds the rule and `test/source-snapshot.unit.test.ts` its truth
 * table; this file holds the wiring, so a landing that forgot to select the two columns, or to
 * pass the dataset id, fails here even though the pure function still passes.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dataRoutes } from "../src/routes/data";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

function seedDataset(db: Database, datasetId: string): void {
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')
     ON CONFLICT (id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox)
     VALUES (?, 1, ?, 'public', 0)`,
  ).run(datasetId, datasetId);
}

function seedVersion(
  db: Database,
  datasetId: string,
  version: string,
  createdAt: string,
  tag: string | null,
  basis: string | null,
): void {
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
     VALUES (?, ?, ?, 'ezid', ?, ?, ?)`,
  ).run(datasetId, version, `10.82901/nemar.${datasetId}.v${version}`, createdAt, tag, basis);
}

interface LandingJson {
  versions: Record<string, unknown>[];
}

async function landing(db: Database, datasetId: string): Promise<LandingJson> {
  const req = new Request(`http://localhost/${datasetId}`, {
    headers: { Accept: "application/json" },
  });
  const res = await dataRoutes.fetch(req, { DB: realD1(db) } as Bindings);
  expect(res.status).toBe(200);
  return (await res.json()) as LandingJson;
}

const flags = (body: LandingJson) =>
  Object.fromEntries(body.versions.map((v) => [v.version as string, v.mirror]));

describe("GET /<id> (JSON): the mirror flag on each version", () => {
  test("an OpenNeuro mirror: true, false, null and null by what each version knows", async () => {
    const db = freshDb();
    seedDataset(db, "on000001");
    seedVersion(db, "on000001", "1.0.0", "2026-01-01 00:00:00", "2.0.2", "doi");
    seedVersion(db, "on000001", "1.0.1", "2026-01-02 00:00:00", "2.0.2", "doi");
    seedVersion(db, "on000001", "2.0.0", "2026-02-01 00:00:00", null, "unknown");
    seedVersion(db, "on000001", "3.0.0", "2026-03-01 00:00:00", null, null);
    seedVersion(db, "on000001", "v4.0.0", "2026-04-01 00:00:00", "5.0.0", "lineage");

    const body = await landing(db, "on000001");

    expect(flags(body)).toEqual({
      "v1.0.0": true,
      "v1.0.1": false, // NEMAR's own correction, whatever it records
      "v2.0.0": null, // tag unknown: not a mirror chip, and not "no"
      "v3.0.0": null, // never examined
      "v4.0.0": true, // a stored `v4.0.0` and a lineage basis
    });
  });

  test("a NEMAR dataset's N.0.0 is false, never null", async () => {
    const db = freshDb();
    seedDataset(db, "nm000200");
    seedVersion(db, "nm000200", "1.0.0", "2026-01-01 00:00:00", null, null);
    // Even a recorded tag does not make a non-mirror a mirror.
    seedVersion(db, "nm000200", "2.0.0", "2026-02-01 00:00:00", "9.9.9", "doi");

    expect(flags(await landing(db, "nm000200"))).toEqual({ "v1.0.0": false, "v2.0.0": false });
  });

  test("the landing exposes the flag only: no tag, no basis, no extra key", async () => {
    const db = freshDb();
    seedDataset(db, "on000001");
    seedVersion(db, "on000001", "1.0.0", "2026-01-01 00:00:00", "2.0.2", "doi");

    const body = await landing(db, "on000001");

    for (const v of body.versions) {
      expect(Object.keys(v).sort()).toEqual(
        ["browse_url", "created_at", "doi", "manifest_url", "mirror", "version"].sort(),
      );
    }
    expect(JSON.stringify(body)).not.toContain("2.0.2");
  });

  test("the DOI withholding of a concealed deposit is untouched by the new columns", async () => {
    const db = freshDb();
    seedDataset(db, "on000001");
    db.run("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'on000001'");
    seedVersion(db, "on000001", "1.0.0", "2026-01-01 00:00:00", "2.0.2", "doi");

    const body = await landing(db, "on000001");

    expect(body.versions[0]?.doi).toBeNull();
    expect(body.versions[0]?.mirror).toBe(true);
  });
});
