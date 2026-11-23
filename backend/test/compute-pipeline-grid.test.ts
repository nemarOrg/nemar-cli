/**
 * The admin pipeline grid (ADR 0134 decision 5, epic #2324 phase 4a): what a run shows as SQL, held equal to
 * the TypeScript rule.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { pipelineRunStatus } from "../../shared/compute-checkpoints";
import { PIPELINE_STAMP_STATES } from "../../shared/compute-recipes";
import { COMPUTE_STATES, type ComputeState } from "../../shared/compute-state";
import { PIPELINE_RUN_STATUS_SQL } from "../src/services/compute-pipeline-progress";

describe("what a run shows, in SQL", () => {
  test("PIPELINE_RUN_STATUS_SQL equals pipelineRunStatus over every stamp state, job state and report age", () => {
    const db = new Database(":memory:");
    // The stamp, its job and its run row stand alone: one row each, joined on nothing, so every
    // combination (no stamp, no job, no run row) is a row the expression reads, as the grid's LEFT JOINs give it.
    const sql = `SELECT ${PIPELINE_RUN_STATUS_SQL} AS status
      FROM (SELECT 1 AS one) x
      LEFT JOIN (SELECT ?1 AS id, ?2 AS state) s ON ?1 IS NOT NULL
      LEFT JOIN (SELECT ?3 AS state) j ON ?3 IS NOT NULL
      LEFT JOIN (SELECT CASE WHEN ?4 IS NULL THEN NULL
                   ELSE datetime('now', '-' || ?4 || ' seconds') END AS reported_at) r ON 1`;
    const stmt = db.prepare(sql);
    let checked = 0;
    const jobs: (ComputeState | null)[] = [null, ...COMPUTE_STATES];
    for (const stampState of [null, ...PIPELINE_STAMP_STATES]) {
      for (const jobState of jobs) {
        for (const age of [null, 60, 600]) {
          const got = (
            stmt.get(stampState === null ? null : 7, stampState, jobState, age) as {
              status: string;
            }
          ).status;
          const now = Math.floor(Date.now() / 1000);
          const want =
            stampState === null
              ? "not_started"
              : pipelineRunStatus({
                  stampState,
                  jobState,
                  reportedAt: age === null ? null : now - age,
                  now,
                });
          expect([stampState, jobState, age, got]).toEqual([stampState, jobState, age, want]);
          checked++;
        }
      }
    }
    expect(checked).toBe((PIPELINE_STAMP_STATES.length + 1) * jobs.length * 3);
    db.close();
  });
});
