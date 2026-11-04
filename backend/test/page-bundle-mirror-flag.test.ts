/**
 * The page bundle's landing (`GET /<id>/page-bundle.json`) carries the same `mirror` flag as the
 * JSON landing, and nothing else from the version row's snapshot columns (epic #1046 phase 4b,
 * #1910; ADR 0111, decision 5). Driven through the real route on real SQLite with a local S3
 * stand-in, like `page-bundle-archive-version.test.ts`: the landing is built from D1 before the S3
 * fan-out, so the empty fixture server does not matter to what is asserted.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server";

let db: Database;
let s3: FixtureServer;

beforeEach(() => {
  db = freshDb();
  s3 = startFixtureServer();
});

afterEach(() => {
  s3.stop();
});

function seed(datasetId: string, versions: [string, string | null, string | null][]): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, 1, 'active', 'public', 0)`,
  ).run(datasetId, datasetId);
  versions.forEach(([version, tag, basis], i) => {
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
       VALUES (?, ?, ?, 'ezid', ?, ?, ?)`,
    ).run(
      datasetId,
      version,
      `10.5072/FK2${datasetId}${version}`,
      `2026-01-0${i + 1} 00:00:00`,
      tag,
      basis,
    );
  });
}

async function landingVersions(datasetId: string): Promise<Record<string, unknown>[]> {
  const hono = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  hono.route("/", dataRoutes);
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
  const res = await hono.request(`https://data.nemar.org/${datasetId}/page-bundle.json`, {}, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    landing: { ok: boolean; data?: { versions: Record<string, unknown>[] } };
  };
  expect(body.landing.ok).toBe(true);
  return body.landing.data?.versions ?? [];
}

describe("page-bundle.json: the landing's versions carry the mirror flag", () => {
  test("true, false and null by what each version of a mirror knows", async () => {
    seed("on000001", [
      ["1.0.0", "2.0.2", "doi"],
      ["1.0.1", "2.0.2", "doi"],
      ["2.0.0", null, "unknown"],
      ["3.0.0", null, null],
    ]);
    const versions = await landingVersions("on000001");
    expect(Object.fromEntries(versions.map((v) => [v.version, v.mirror]))).toEqual({
      "v1.0.0": true,
      "v1.0.1": false,
      "v2.0.0": null,
      "v3.0.0": null,
    });
  });

  test("a NEMAR dataset's versions are false, and no row carries the tag or its basis", async () => {
    seed("nm000200", [["1.0.0", "9.9.9", "doi"]]);
    const versions = await landingVersions("nm000200");
    expect(versions.map((v) => v.mirror)).toEqual([false]);
    for (const v of versions) {
      expect(Object.keys(v).sort()).toEqual(
        ["browse_url", "created_at", "doi", "manifest_url", "mirror", "version"].sort(),
      );
    }
    expect(JSON.stringify(versions)).not.toContain("9.9.9");
  });
});
