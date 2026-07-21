/**
 * Characterization tests for createProgressRecorder (#904).
 *
 * Pins the exact pre-extraction semantics of startStep/updateProgress from
 * the approve handler, including the deliberate quirks:
 *  - warn-and-continue is recorded as status:"failed" and EXCLUDED from
 *    `completed` (so the step re-runs on resume), with current_step left
 *    pointing at the warned step until the next startStep;
 *  - ONE shared start-time slot, so an updateProgress with no preceding
 *    startStep inherits the previous step's start (stale duration) or
 *    records 0 when no step ever started;
 *  - both D1 writes swallow their own errors.
 *
 * Real engine: bun:sqlite behind the realD1 shim, full migrations.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createProgressRecorder } from "../src/services/publication-orchestrator";
import { freshDb, realD1 } from "./helpers/d1";

const DATASET = "nm098765";
let db: Database;
let requestId: number;

beforeEach(() => {
  db = freshDb();
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('rec', 'rec@example.org', 'x', 'approved', 'admin', 1)`,
  );
  db.run(
    `INSERT INTO publication_requests (dataset_id, status, requested_by, requested_at, steps_completed)
     VALUES ('${DATASET}', 'approving', 1, datetime('now'), '["ci_check"]')`,
  );
  const row = db.query<{ id: number }, []>("SELECT id FROM publication_requests").get();
  if (!row) throw new Error("seed failed");
  requestId = row.id;
});

function progressRow() {
  return db
    .query<
      { steps_completed: string; current_step: string | null; last_error: string | null },
      [number]
    >("SELECT steps_completed, current_step, last_error FROM publication_requests WHERE id = ?")
    .get(requestId);
}

describe("createProgressRecorder", () => {
  test("startStep writes current_step; success updateProgress completes the step", async () => {
    const rec = createProgressRecorder(realD1(db), requestId, DATASET, ["ci_check"]);

    await rec.startStep("enrichment_check");
    expect(progressRow()?.current_step).toBe("enrichment_check");

    await rec.updateProgress("enrichment_check");
    expect(rec.completed).toEqual(["ci_check", "enrichment_check"]);
    expect(rec.stepResults).toEqual([
      {
        step: "enrichment_check",
        status: "completed",
        attempts: 1,
        duration_ms: expect.any(Number) as unknown as number,
      },
    ]);
    const row = progressRow();
    expect(JSON.parse(row?.steps_completed ?? "")).toEqual(["ci_check", "enrichment_check"]);
    expect(row?.current_step).toBeNull();
    expect(row?.last_error).toBeNull();
  });

  test("failure/warn updateProgress: failed result, NOT completed, current_step stays on the step", async () => {
    const rec = createProgressRecorder(realD1(db), requestId, DATASET, ["ci_check"]);

    await rec.startStep("update_readme");
    await rec.updateProgress("update_readme", "desc write failed", 2);

    // Warn-conflation quirk: the step is recorded failed and excluded from
    // completed, so a resumed run re-executes it even if the flow continued.
    expect(rec.completed).toEqual(["ci_check"]);
    expect(rec.stepResults[0]).toMatchObject({
      step: "update_readme",
      status: "failed",
      attempts: 2,
      error: "desc write failed",
    });
    const row = progressRow();
    expect(JSON.parse(row?.steps_completed ?? "")).toEqual(["ci_check"]);
    expect(row?.current_step).toBe("update_readme");
    expect(row?.last_error).toBe("desc write failed");
  });

  test("no startStep ever: duration_ms is 0 (the no-op-step quirk baseline)", async () => {
    const rec = createProgressRecorder(realD1(db), requestId, DATASET, []);
    await rec.updateProgress("upload_to_zenodo");
    expect(rec.stepResults[0]?.duration_ms).toBe(0);
  });

  test("shared start-time slot: a no-startStep update inherits the previous step's start", async () => {
    const rec = createProgressRecorder(realD1(db), requestId, DATASET, []);
    await rec.startStep("s3_lock");
    await rec.updateProgress("s3_lock");
    // sync_nemar-style no-op: no startStep call; measures from s3_lock's start.
    await rec.updateProgress("sync_nemar");
    const noop = rec.stepResults[1];
    expect(noop?.step).toBe("sync_nemar");
    expect(noop?.duration_ms).toBeGreaterThanOrEqual(rec.stepResults[0]?.duration_ms ?? 0);
  });

  test("arrays have stable identity and the input array is copied", async () => {
    const input: ["ci_check"] = ["ci_check"];
    const rec = createProgressRecorder(realD1(db), requestId, DATASET, input);
    const { completed, stepResults } = rec;
    await rec.updateProgress("enrichment_check");
    // Destructured bindings observe the mutation (same array objects).
    expect(completed).toBe(rec.completed);
    expect(stepResults).toBe(rec.stepResults);
    expect(completed).toEqual(["ci_check", "enrichment_check"]);
    // The caller's input array is not mutated.
    expect(input).toEqual(["ci_check"]);
  });

  test("both writes swallow D1 errors (non-fatal by contract)", async () => {
    const rec = createProgressRecorder(realD1(db), requestId, DATASET, []);
    db.run("DROP TABLE publication_requests");
    // Neither call may throw even though every statement now fails.
    await rec.startStep("ci_check");
    await rec.updateProgress("ci_check");
    await rec.updateProgress("enrichment_check", "boom");
    // In-memory accounting still advances.
    expect(rec.completed).toEqual(["ci_check"]);
    expect(rec.stepResults.map((r) => r.status)).toEqual(["completed", "failed"]);
  });
});
