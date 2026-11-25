/**
 * `nemar admin dataset publish acknowledge-batch` (epic #2182, card D3; ADR 0086, amendment
 * 2026-11-25): the paging and printing around `POST /admin/publish/acknowledge-batch`.
 *
 * The dry run always runs first and is printed in full. With `apply`, only the requests the dry run
 * reported `eligible` are sent back, each with the screen state and commit it showed, so the Worker
 * records an acknowledgment only for what was printed. The Worker caps a call at 20 requests, for
 * its subrequest budget, and this pages at that size.
 */

import { PUBLICATION_DATASET_ID_RE } from "../../shared/publication-limits.js";
import {
  ACK_BATCH_MAX,
  type AckBatchRequest,
  type AckBatchResponse,
  type AckExpected,
  type AckResult,
  UPSTREAM_ACK_COPY,
  ackOutcomeLine,
} from "../../shared/upstream-ack.js";

/** Requests per call: the Worker's cap, which its subrequest budget sets. */
export const ACK_PAGE_SIZE = ACK_BATCH_MAX;

export type AckSelection = { all: true } | { ids: string[] };

/** Sends one call; the command passes the API client, a test the real route. */
export type AckTransport = (body: AckBatchRequest) => Promise<AckBatchResponse>;

/**
 * The dataset ids of an `--ids` file: one per line, blank lines and `#` comments skipped,
 * duplicates dropped. Throws naming the first line that is not a dataset id.
 */
export function parseIdsFile(text: string): string[] {
  const ids: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*/, "").trim();
    if (line === "") continue;
    if (!PUBLICATION_DATASET_ID_RE.test(line)) {
      throw new Error(`line ${i + 1} is not a dataset id (like nm000108)`);
    }
    if (!ids.includes(line)) ids.push(line);
  }
  if (ids.length === 0) throw new Error("the file names no dataset id");
  return ids;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every page of the dry run, in order. */
export async function dryRun(
  send: AckTransport,
  selection: AckSelection,
  pageSize = ACK_PAGE_SIZE,
): Promise<AckResult[]> {
  const size = Math.min(pageSize, ACK_BATCH_MAX);
  const results: AckResult[] = [];
  if ("ids" in selection) {
    for (const page of chunks(selection.ids, size)) {
      results.push(...(await send({ dataset_ids: page })).results);
    }
    return results;
  }
  let after: string | undefined;
  for (;;) {
    const res = await send({ all_requested: true, limit: size, ...(after ? { after } : {}) });
    results.push(...res.results);
    if (res.next === null) return results;
    after = res.next;
  }
}

/** Record the acknowledgments the dry run showed as eligible, page by page. */
export async function applyEligible(
  send: AckTransport,
  dry: AckResult[],
  pageSize = ACK_PAGE_SIZE,
): Promise<AckResult[]> {
  const expect: AckExpected[] = dry.flatMap((r) =>
    r.outcome === "eligible" && r.request_id !== null && r.screen_state && r.screen_head
      ? [
          {
            dataset_id: r.dataset_id,
            request_id: r.request_id,
            screen_state: r.screen_state,
            screen_head: r.screen_head,
          },
        ]
      : [],
  );
  const results: AckResult[] = [];
  for (const page of chunks(expect, Math.min(pageSize, ACK_BATCH_MAX))) {
    results.push(...(await send({ apply: true, expect: page })).results);
  }
  return results;
}

/** The lines printed for one phase: each request, its reason when it has one, then the tally. */
export function resultLines(title: string, results: AckResult[]): string[] {
  const lines = [title];
  for (const r of results) {
    lines.push(`  ${ackOutcomeLine(r)}`);
    if (r.reason) lines.push(`      reason: ${r.reason}`);
  }
  const tally = new Map<string, number>();
  for (const r of results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
  lines.push(
    `  ${results.length} request(s): ${[...tally.entries()].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
  );
  return lines;
}

/** The policy lines printed once, after the dry run. */
export function policyLines(): string[] {
  const p = UPSTREAM_ACK_COPY["public-upstream-acknowledgment"];
  return [`Policy: ${p.statement}`, `Docs: ${p.anchor}`];
}
