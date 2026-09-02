/**
 * Behavior tests for services/central-manifest.ts (#905, epic #902).
 *
 * The dispatch/mint functions were relocated verbatim from routes/webhooks.ts;
 * these tests pin the D1 bookkeeping and guard paths that run BEFORE any
 * GitHub call, using the real engine (bun:sqlite behind the realD1 shim, full
 * migrations) and a deliberately GitHub-credential-less env: getDatasetsToken
 * throws synchronously ("No GitHub auth configured") with zero network, which
 * exercises the dispatch-failure catch (row flipped to 'failed', error
 * rethrown) exactly as a GitHub outage would. The success path's POST to
 * /dispatches is network-bound and stays covered at the integration tier.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { dispatchCentralManifestJob, mintEzidVersionDoi } from "../src/services/central-manifest";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const DATASET = "nm098765";
const VERSION = "1.0.0";
let db: Database;

function env(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    MANIFEST_CALLBACK_SECRET: "test-callback-secret",
    API_BASE_URL: "https://api.test.invalid",
    ...overrides,
  } as unknown as Bindings;
}

function jobRows() {
  return db
    .query<
      {
        nonce: string;
        doi: string | null;
        concept_doi: string | null;
        doi_provider: string | null;
        status: string;
        request_source: string | null;
        error_message: string | null;
      },
      []
    >(
      `SELECT nonce, doi, concept_doi, doi_provider, status, request_source, error_message
       FROM manifest_jobs ORDER BY id`,
    )
    .all();
}

beforeEach(() => {
  db = freshDb();
});

describe("dispatchCentralManifestJob", () => {
  test("refuses to dispatch without MANIFEST_CALLBACK_SECRET and writes no row", async () => {
    await expect(
      dispatchCentralManifestJob(env({ MANIFEST_CALLBACK_SECRET: undefined }), {
        datasetId: DATASET,
        version: VERSION,
        doi: "10.82901/NEMAR.TEST",
        conceptDoi: null,
        doiProvider: "ezid",
      }),
    ).rejects.toThrow(/MANIFEST_CALLBACK_SECRET is unset/);
    expect(jobRows()).toEqual([]);
  });

  test("fresh insert persists a dispatched row first; failed dispatch flips it to failed and rethrows", async () => {
    await expect(
      dispatchCentralManifestJob(env(), {
        datasetId: DATASET,
        version: VERSION,
        doi: "10.82901/NEMAR.TEST",
        conceptDoi: "10.82901/NEMAR.CONCEPT",
        doiProvider: "ezid",
        requestSource: "admin",
      }),
    ).rejects.toThrow(/No GitHub auth configured/);

    const rows = jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      doi: "10.82901/NEMAR.TEST",
      concept_doi: "10.82901/NEMAR.CONCEPT",
      doi_provider: "ezid",
      status: "failed",
      request_source: "admin",
    });
    expect(rows[0]?.error_message).toStartWith("dispatch failed:");
  });

  test("promoteNonce promotes the accepted row in place, reusing its nonce", async () => {
    db.run(
      `INSERT INTO manifest_jobs (dataset_id, version, nonce, status, request_source)
       VALUES ('${DATASET}', '${VERSION}', 'nonce-accept-1', 'accepted', 'webhook')`,
    );

    await expect(
      dispatchCentralManifestJob(env(), {
        datasetId: DATASET,
        version: VERSION,
        doi: "10.82901/NEMAR.MINTED",
        conceptDoi: null,
        doiProvider: "ezid",
        promoteNonce: "nonce-accept-1",
      }),
    ).rejects.toThrow(/No GitHub auth configured/);

    const rows = jobRows();
    expect(rows).toHaveLength(1); // promoted in place, no second row
    expect(rows[0]).toMatchObject({
      nonce: "nonce-accept-1",
      doi: "10.82901/NEMAR.MINTED",
      status: "failed", // dispatched by the promote, then flipped by the failed dispatch
      request_source: "webhook", // set at accept time, untouched by the promote
    });
  });

  test("promoteNonce throws when the accepted row is gone and neither inserts nor dispatches", async () => {
    await expect(
      dispatchCentralManifestJob(env(), {
        datasetId: DATASET,
        version: VERSION,
        doi: "10.82901/NEMAR.MINTED",
        conceptDoi: null,
        doiProvider: "ezid",
        promoteNonce: "nonce-vanished",
      }),
    ).rejects.toThrow(/promote matched 0 rows/);
    expect(jobRows()).toEqual([]);
  });

  test("promoteNonce does not re-promote a row that already left 'accepted'", async () => {
    db.run(
      `INSERT INTO manifest_jobs (dataset_id, version, nonce, status)
       VALUES ('${DATASET}', '${VERSION}', 'nonce-done-1', 'ready')`,
    );

    await expect(
      dispatchCentralManifestJob(env(), {
        datasetId: DATASET,
        version: VERSION,
        doi: null,
        conceptDoi: null,
        doiProvider: "ezid",
        promoteNonce: "nonce-done-1",
      }),
    ).rejects.toThrow(/promote matched 0 rows/);
    expect(jobRows()[0]?.status).toBe("ready"); // terminal state untouched
  });
});

describe("mintEzidVersionDoi", () => {
  test("throws before any GitHub read when the dataset has no EZID identifier", async () => {
    await expect(
      mintEzidVersionDoi(env(), {
        dataset: {
          id: 1,
          dataset_id: DATASET,
          name: "Test Dataset",
          github_repo: null,
          concept_doi: null,
        },
        repoName: DATASET,
        version: VERSION,
        sandbox: true,
        pat: "unused",
      }),
    ).rejects.toThrow(`Dataset ${DATASET} has no EZID identifier`);
  });
});
