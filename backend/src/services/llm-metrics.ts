// LLM enrichment spend metering.
//
// Emits one Cloudflare Analytics Engine data point per enrichment run so the
// observability dashboard can chart token/dollar spend per hour or day (the
// point's automatic timestamp is the time axis; bucket with
// toStartOfInterval(timestamp, ...) on the read side) and rank datasets by
// spend. Mirrors the access-metrics pattern: write-only here, read via the
// account-scoped AE SQL API in the website repo, aggregate with
// SUM(_sample_interval * double) because AE samples under bursts.
//
// The binding is optional (Bindings.ANALYTICS_LLM): recordLlmUsage() no-ops
// when absent, so dev/test and pre-provisioning deploys never have to guard.

import type { Bindings } from "../types/bindings";

export interface LlmUsageEvent {
  /** Public dataset id (nm/on...). AE index + first blob. */
  datasetId: string;
  /** Pipeline outcome discriminator, e.g. "ok" | "failed". */
  outcome: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}

/**
 * Build the AE data point for one enrichment run. Pure for unit testing.
 * Field ordering is a contract the dashboard's read-side SQL depends on:
 *   indexes[0] = dataset_id
 *   blob1      = dataset_id
 *   blob2      = "enrichment" (stream discriminator for future LLM uses)
 *   blob3      = outcome
 *   double1    = calls
 *   double2    = input_tokens
 *   double3    = output_tokens
 *   double4    = est_cost_usd
 */
export function buildLlmUsageDataPoint(event: LlmUsageEvent): AnalyticsEngineDataPoint {
  return {
    indexes: [event.datasetId],
    blobs: [event.datasetId, "enrichment", event.outcome],
    doubles: [event.calls, event.inputTokens, event.outputTokens, event.estCostUsd],
  };
}

/**
 * Emit one spend data point. No-op when the binding is absent or the run made
 * no LLM calls. Never throws: metering must not break enrichment.
 */
export function recordLlmUsage(env: Pick<Bindings, "ANALYTICS_LLM">, event: LlmUsageEvent): void {
  if (!env.ANALYTICS_LLM || event.calls === 0) return;
  try {
    env.ANALYTICS_LLM.writeDataPoint(buildLlmUsageDataPoint(event));
  } catch (err) {
    console.error("[llm-metrics] writeDataPoint failed:", err);
  }
}
