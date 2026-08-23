/**
 * `manifestIntegritySweep()`'s production fence and early exits (#1133).
 *
 * backend/test/manifest-sweep.test.ts covers MANIFEST_SWEEP_QUERY by running the
 * exported SQL string directly. That leaves the exported function that is
 * actually wired into the cron (backend/src/index.ts) untested -- including the
 * guard AGENTS.md makes load-bearing: "a new daily cron job is production-only
 * BY DEFAULT", because dev D1 shares the real `nemarDatasets` org and the fix
 * path spends the shared GitHub App's quota against real repos.
 *
 * An inverted or dropped guard fails in one of two silent ways: the sweep runs
 * its fix path against real repos from the dev worker, or the backstop quietly
 * stops running in production -- which is exactly the 2.5-month-invisible
 * `nm000225` incident this sweep exists to prevent, recurring undetected.
 *
 * Real D1 (bun:sqlite plus the actual migrations), no mocks. Console output is
 * captured to observe which branch ran; that is reading the function's own
 * logging, not substituting for any of its logic.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { manifestIntegritySweep } from "../src/services/manifest-sweep";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

let db: Database;
let logs: string[];
const realLog = console.log;
const realError = console.error;

function envFor(environment: string): Bindings {
  // No S3 or GitHub credentials on purpose: a run that gets past the guard and
  // finds candidates would have to reach for them, so their absence makes an
  // escaped run observable rather than silently succeeding.
  return { DB: realD1(db), ENVIRONMENT: environment } as Bindings;
}

function seedPublishedVersionMissingManifest(datasetId: string): void {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'approved', 'user', 1)`,
  ).run(`${datasetId}owner`, `${datasetId}@example.org`);
  const owner = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(`${datasetId}owner`);
  if (!owner) throw new Error("seed: owner insert failed");
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo, concept_doi)
     VALUES (?, 'Swept', ?, 'active', 'public', ?, '10.82901/concept')`,
  ).run(datasetId, owner.id, `nemarDatasets/${datasetId}`);
  db.query(
    `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
     VALUES (?, 'v1.0.0', '10.82901/version', datetime('now', '-2 days'))`,
  ).run(datasetId);
}

beforeEach(() => {
  db = freshDb();
  logs = [];
  console.log = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
  console.error = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
});

describe("manifestIntegritySweep production fence", () => {
  for (const environment of ["development", "test", "staging"]) {
    test(`skips in ${environment} even with a candidate waiting`, async () => {
      seedPublishedVersionMissingManifest("on000001");
      await manifestIntegritySweep(envFor(environment));
      expect(logs.join("\n")).toContain("skipped (non-production)");
      // It must bail BEFORE looking at candidates; seeing a candidate count
      // would mean it queried real rows on a non-production worker.
      expect(logs.join("\n")).not.toContain("candidates=");
    });
  }

  test("does not skip in production", async () => {
    // The other half of the fence. If this ever logs the skip line, the daily
    // backstop has silently stopped running in the only environment that has it.
    await manifestIntegritySweep(envFor("production"));
    expect(logs.join("\n")).not.toContain("skipped (non-production)");
  });

  test("an unset ENVIRONMENT is treated as production, not as a free pass", async () => {
    await manifestIntegritySweep({ DB: realD1(db) } as Bindings);
    expect(logs.join("\n")).not.toContain("skipped (non-production)");
  });

  test("exits cleanly in production when nothing is in the window", async () => {
    await manifestIntegritySweep(envFor("production"));
    expect(logs.join("\n")).toContain("no versions inside the window");
  });

  test("a version older than the window is not a candidate", async () => {
    seedPublishedVersionMissingManifest("on000002");
    db.query(
      "UPDATE dataset_versions SET created_at = datetime('now', '-400 days') WHERE dataset_id = 'on000002'",
    ).run();
    await manifestIntegritySweep(envFor("production"));
    expect(logs.join("\n")).toContain("no versions inside the window");
  });
});
