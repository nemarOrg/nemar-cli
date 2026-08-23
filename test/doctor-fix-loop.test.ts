/**
 * Unit tests for runDoctorFixLoop -- the per-dataset driver behind
 * `nemar admin doctor fix` (#1133 review fix).
 *
 * Guards the two properties the review found unprotected:
 *  1. A dataset healed between enumeration and its fix turn (the narrowed
 *     server-side re-scan returns zero results) is counted as `resolved` and
 *     surfaced through the onDataset hook -- not silently dropped from the
 *     tally, which previously made the final counts disagree with the
 *     "N finding(s) to fix" figure with no explanation.
 *  2. A thrown fixOne records a failed result for that dataset and the loop
 *     continues with the remaining datasets instead of aborting the run.
 *
 * No mocks (per project policy): `fixOne` and the hook are plain
 * dependency-injected functions, mirroring runReauditLoop's test style
 * (test/reaudit-loop.test.ts) -- no network, no real doctor call.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { runDoctorFixLoop } from "../src/commands/admin";
import type { DoctorFixLiveResponse, DoctorFixResult } from "../src/lib/api/admin";

function liveResponse(results: DoctorFixResult[]): DoctorFixLiveResponse {
  return {
    check: "missing-manifest",
    total: results.length,
    fixed: results.filter((r) => r.status === "fixed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}

describe("runDoctorFixLoop", () => {
  test("aggregates per-dataset outcomes in order", async () => {
    const calls: Array<[string, number]> = [];
    const outcome = await runDoctorFixLoop(["nm000213", "nm000225"], (id, index) => {
      calls.push([id, index]);
      return Promise.resolve(
        liveResponse([
          { dataset_id: id, version: "1.0.0", status: id === "nm000213" ? "fixed" : "failed" },
        ]),
      );
    });
    expect(calls).toEqual([
      ["nm000213", 0],
      ["nm000225", 1],
    ]);
    expect(outcome.totals).toEqual({ fixed: 1, skipped: 0, failed: 1, resolved: 0 });
    expect(outcome.results.map((r) => r.dataset_id)).toEqual(["nm000213", "nm000225"]);
  });

  test("a dataset healed in the interim counts as resolved, not silence", async () => {
    const hookCalls: Array<[string, number]> = [];
    const outcome = await runDoctorFixLoop(
      ["nm000181", "nm000204"],
      (id) =>
        Promise.resolve(
          id === "nm000181"
            ? liveResponse([]) // narrowed re-scan found nothing: healed since enumeration
            : liveResponse([{ dataset_id: id, version: "1.0.0", status: "fixed" }]),
        ),
      { onDataset: (id, results) => hookCalls.push([id, results.length]) },
    );
    expect(outcome.totals).toEqual({ fixed: 1, skipped: 0, failed: 0, resolved: 1 });
    // The hook still fires for the resolved dataset (empty results) so the
    // CLI can print an explicit "already resolved" line for it.
    expect(hookCalls).toEqual([
      ["nm000181", 0],
      ["nm000204", 1],
    ]);
    // Resolved datasets contribute no synthetic result rows.
    expect(outcome.results.map((r) => r.dataset_id)).toEqual(["nm000204"]);
  });

  test("a thrown fixOne records a failure and the loop continues", async () => {
    const outcome = await runDoctorFixLoop(["nm000250", "nm000254", "nm000256"], (id) => {
      if (id === "nm000254") return Promise.reject(new Error("network dropped"));
      return Promise.resolve(liveResponse([{ dataset_id: id, version: "1.0.0", status: "fixed" }]));
    });
    expect(outcome.totals).toEqual({ fixed: 2, skipped: 0, failed: 1, resolved: 0 });
    const failed = outcome.results.find((r) => r.dataset_id === "nm000254");
    expect(failed?.status).toBe("failed");
    expect(failed?.message).toContain("network dropped");
    // The dataset after the throw was still processed.
    expect(outcome.results.map((r) => r.dataset_id)).toEqual(["nm000250", "nm000254", "nm000256"]);
  });
});
