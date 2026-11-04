/**
 * The `mirror` flag of the data plane's version listing, against the CLI's reader of it (epic #1046
 * phase 8, #1914; ADR 0111, decision 5; `shared/contract/data-plane.ts`).
 *
 * The producer is the real landing route (`dataRoutes`) over a real SQLite database built from the
 * migrations, served on a loopback port and read the way the CLI reads it: `getDocument` with
 * `dataPlaneVersionListingSchema`, which is what `fetchVersions` does. The producer is not replaced
 * anywhere. The one fixture is a second loopback server that serves the REAL payload with a single
 * value changed, to stand for a producer that drifted; it is the HTTP condition under test, not a
 * stand-in for the producer's logic.
 *
 * The entry schema ends in `.passthrough()`, so "parse an entry and read `mirror` back" would pass
 * with the declaration deleted. These tests therefore assert what the schema DECLARES (its shape) and
 * what it REJECTS (any value that is not a boolean or null), and each failing case has a control
 * that the same server serves successfully.
 *
 * CI TIER: unit-pure. Offline: an in-process SQLite database and two loopback servers.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dataRoutes } from "../backend/src/routes/data";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { dataPlaneVersionListingSchema } from "../shared/contract/data-plane";
import { DataPlaneUnavailableError, getDocument } from "../src/lib/http-download";

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

/** The CLI's read of a listing, labeled the way `fetchVersions` labels it. */
const read = (url: string, id: string) =>
  getDocument(url, dataPlaneVersionListingSchema, `Dataset ${id}`, () => "absent");

interface RawListing {
  versions: Array<Record<string, unknown> & { version: string }>;
}

/** The mirror flag of each version, keyed by the version as the landing spells it. */
const flagsOf = (listing: { versions: Array<{ version: string; mirror?: unknown }> }) =>
  Object.fromEntries(listing.versions.map((v) => [v.version, v.mirror]));

/** Values a drifted producer might send: every one is neither a boolean nor null. */
const NOT_A_FLAG: unknown[] = ["true", "false", "yes", "null", "", 1, 0, {}, [], ["true"]];

/** Where the drift server keeps each body: the control, then one per bad value, then an older backend's. */
const CONTROL = 0;
const OLDER_BACKEND = NOT_A_FLAG.length + 1;

describe("the version listing's `mirror` flag, as the CLI reads it", () => {
  let plane: ReturnType<typeof Bun.serve>;
  let planeBase: string;
  let drift: ReturnType<typeof Bun.serve>;
  let driftBase: string;
  let real: RawListing;

  beforeAll(async () => {
    const db = freshDb();
    // An OpenNeuro mirror whose versions cover every value the flag takes, and a dataset that is not one.
    seedDataset(db, "on000001");
    seedVersion(db, "on000001", "1.0.0", "2026-01-01 00:00:00", "2.0.2", "doi");
    seedVersion(db, "on000001", "1.0.1", "2026-01-02 00:00:00", "2.0.2", "doi");
    seedVersion(db, "on000001", "2.0.0", "2026-02-01 00:00:00", null, "unknown");
    seedVersion(db, "on000001", "3.0.0", "2026-03-01 00:00:00", null, null);
    seedVersion(db, "on000001", "v4.0.0", "2026-04-01 00:00:00", "5.0.0", "lineage");
    seedDataset(db, "nm000200");
    seedVersion(db, "nm000200", "1.0.0", "2026-01-01 00:00:00", null, null);
    seedVersion(db, "nm000200", "2.0.0", "2026-02-01 00:00:00", "9.9.9", "doi");

    const env = { DB: realD1(db) } as Bindings;
    plane = Bun.serve({ port: 0, fetch: (req) => dataRoutes.fetch(req, env) });
    planeBase = `http://127.0.0.1:${plane.port}`;

    const res = await fetch(`${planeBase}/on000001`, { headers: { Accept: "application/json" } });
    real = (await res.json()) as RawListing;

    // The real payload, once unchanged (the control), once per bad value in the first version's
    // `mirror`, and once with the key removed from every version, as a backend that predates it sends.
    const served: unknown[] = [];
    served[CONTROL] = real;
    NOT_A_FLAG.forEach((bad, i) => {
      served[i + 1] = {
        ...real,
        versions: real.versions.map((v, at) => (at === 0 ? { ...v, mirror: bad } : v)),
      };
    });
    served[OLDER_BACKEND] = {
      ...real,
      versions: real.versions.map((v) =>
        Object.fromEntries(Object.entries(v).filter(([key]) => key !== "mirror")),
      ),
    };
    drift = Bun.serve({
      port: 0,
      fetch: (req) => Response.json(served[Number(new URL(req.url).pathname.slice(1))]),
    });
    driftBase = `http://127.0.0.1:${drift.port}`;
  });

  afterAll(() => {
    plane.stop(true);
    drift.stop(true);
  });

  test("the real landing of a mirror parses, and each version keeps its three-valued flag", async () => {
    const listing = await read(`${planeBase}/on000001`, "on000001");
    expect(flagsOf(listing)).toEqual({
      "v1.0.0": true,
      "v1.0.1": false, // NEMAR's own correction, whatever it records
      "v2.0.0": null, // tag unknown: not a mirror chip, and not "no"
      "v3.0.0": null, // never examined
      "v4.0.0": true, // a stored `v4.0.0` with a lineage basis
    });
  });

  test("the real landing of a NEMAR dataset parses, and no version of it is a mirror", async () => {
    const listing = await read(`${planeBase}/nm000200`, "nm000200");
    expect(flagsOf(listing)).toEqual({ "v1.0.0": false, "v2.0.0": false });
  });

  test("the real producer sends the key on every version, as a boolean or null and never a tag", async () => {
    for (const id of ["on000001", "nm000200"]) {
      const raw = (await (
        await fetch(`${planeBase}/${id}`, { headers: { Accept: "application/json" } })
      ).json()) as RawListing;
      for (const v of raw.versions) {
        expect([
          id,
          v.version,
          "mirror" in v && (v.mirror === null || typeof v.mirror === "boolean"),
        ]).toEqual([id, v.version, true]);
      }
    }
  });

  test("the reader keeps every other key of an entry (the schema's unknown-key behavior is unchanged)", async () => {
    const listing = await read(`${planeBase}/on000001`, "on000001");
    expect(listing.versions.length).toBe(real.versions.length);
    listing.versions.forEach((entry, i) => {
      expect(Object.keys(entry).sort()).toEqual(Object.keys(real.versions[i] ?? {}).sort());
    });
  });

  test("the schema declares `mirror` as an optional, nullable boolean beside `version`", () => {
    const entry = dataPlaneVersionListingSchema.shape.versions.element;
    expect(Object.keys(entry.shape).sort()).toEqual(["mirror", "version"]);
    expect(entry.shape.mirror.isOptional()).toBe(true);
    expect(entry.shape.mirror.isNullable()).toBe(true);
  });

  test("the control: the unchanged real payload through the drift server parses", async () => {
    const listing = await read(`${driftBase}/${CONTROL}`, "on000001");
    expect(flagsOf(listing)).toEqual(flagsOf(real));
  });

  test("a backend that predates the flag omits the key, and the listing still parses", async () => {
    const listing = await read(`${driftBase}/${OLDER_BACKEND}`, "on000001");
    expect(listing.versions.map((v) => v.version)).toEqual(real.versions.map((v) => v.version));
    for (const v of listing.versions)
      expect([v.version, "mirror" in v]).toEqual([v.version, false]);
  });

  test("a producer that sent a flag that is not a boolean or null fails the CLI's read", async () => {
    for (const [i, bad] of NOT_A_FLAG.entries()) {
      const outcome = await read(`${driftBase}/${i + 1}`, "on000001").catch((e: unknown) => e);
      expect([JSON.stringify(bad), outcome instanceof DataPlaneUnavailableError]).toEqual([
        JSON.stringify(bad),
        true,
      ]);
      // The shape sentence, not a transport failure: the server answered and the reader refused.
      expect((outcome as Error).message).toContain("did not match the expected shape");
    }
  });
});
