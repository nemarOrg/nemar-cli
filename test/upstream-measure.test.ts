/**
 * `measureStaleMirrors` (epic #1046 phase 4c, #1910) driven directly against the stand-in that
 * serves the REAL recorded file listings: the read loop, its failure handling and the clock.
 * The CLI test (`upstream-status-cli.test.ts`) covers the same code through the entry point; this
 * file pins the parts a spawned process cannot reach cheaply (a stop after consecutive failures
 * that resets on a success, a row with no tags, an injected clock).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UpstreamSnapshot, UpstreamStatusRow } from "../shared/upstream-staleness";
import { measureStaleMirrors } from "../src/lib/upstream-measure";
import { startOpenNeuroFilesStandin } from "./helpers/openneuro-files-standin";

const standin = startOpenNeuroFilesStandin();
afterAll(() => standin.stop());
beforeEach(() => {
  standin.requests.length = 0;
  standin.setRecorded();
});

function staleRow(
  id: string,
  ds: string | null,
  from: string | null,
  to: string | null,
  snapshots: UpstreamSnapshot[] = [],
): UpstreamStatusRow {
  return {
    dataset_id: id,
    ds,
    visibility: "public",
    state: "stale_ready",
    anomaly: null,
    reason: "x",
    recorded: from === null ? null : { version: "1.0.0", tag: from, basis: "doi" },
    upstream: to === null ? null : { latest_tag: to, latest_created: null, snapshots },
    import_status: "complete",
    probably_stale: null,
  };
}

const OK = (id: string) => staleRow(id, "ds003082", "1.0.0", "1.0.1");
// OpenNeuro has no such recording, so the stand-in answers 500: a failed read.
const BAD = (id: string) => staleRow(id, "ds000999", "1.0.0", "1.0.1");

const options = { pauseMs: 0, graphqlUrl: standin.url };

describe("measureStaleMirrors", () => {
  test("a success between failures resets the count: nothing is skipped", async () => {
    const rows = [
      BAD("on000001"),
      OK("on000002"),
      BAD("on000003"),
      OK("on000004"),
      BAD("on000005"),
    ];
    const m = await measureStaleMirrors(rows, { ...options, maxConsecutiveFailures: 2 });
    expect(standin.requests.length).toBe(5);
    expect(m.totals.delta_unknown).toBe(3);
    expect(m.totals.measured).toBe(2);
    expect(m.deltas.every((d) => d.reason === null || !d.reason.includes("in a row"))).toBe(true);
  });

  test("consecutive failures stop the reading and record why for the rest", async () => {
    const rows = [BAD("on000001"), BAD("on000002"), OK("on000003"), OK("on000004")];
    const m = await measureStaleMirrors(rows, { ...options, maxConsecutiveFailures: 2 });
    expect(standin.requests.length).toBe(2);
    expect(m.deltas[2]?.delta).toBeNull();
    expect(m.deltas[2]?.reason).toContain("2 reads in a row failed");
    expect(m.totals.delta_unknown).toBe(4);
    expect(m.complete).toBe(false);
  });

  test("a row that does not name both tags is an unknown delta, asks nothing and is not a read failure", async () => {
    const rows = [
      staleRow("on000001", "ds003082", null, "1.0.1"),
      staleRow("on000002", "ds003082", "1.0.0", null),
      staleRow("on000003", null, "1.0.0", "1.0.1"),
      OK("on000004"),
    ];
    const m = await measureStaleMirrors(rows, { ...options, maxConsecutiveFailures: 1 });
    expect(standin.requests.length).toBe(1);
    expect(m.deltas.slice(0, 3).map((d) => d.reason)).toEqual([
      "the row does not name both tags",
      "the row does not name both tags",
      "the row does not name both tags",
    ]);
    expect(m.totals.delta_unknown).toBe(3);
    expect(m.totals.measured).toBe(1);
  });

  test("the injected clock sets measured_at and the DOI window (real recorded snapshot lists)", async () => {
    const response = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../backend/test/fixtures/openneuro-graphql/graphql-upstream-snapshots.response.json",
        ),
        "utf-8",
      ),
    ) as { data: Record<string, { id: string; snapshots: UpstreamSnapshot[] } | null> };
    const nodes = Object.values(response.data).filter((n) => n !== null);
    const snapshotsOf = (ds: string) => nodes.find((n) => n?.id === ds)?.snapshots ?? [];
    const rows = [
      staleRow("on003645", "ds003645", "2.0.2", "2.1.0", snapshotsOf("ds003645")),
      staleRow("on004362", "ds004362", "1.0.0", "1.0.1", snapshotsOf("ds004362")),
    ];
    const at = (iso: string) => ({ ...options, limit: 0, now: () => Date.parse(iso) });
    const recent = await measureStaleMirrors(rows, at("2026-10-24T12:00:00Z"));
    expect(recent.measured_at).toBe("2026-10-24T12:00:00.000Z");
    expect(recent.doi_volume.per_snapshot).toBe(2);
    const old = await measureStaleMirrors(rows, at("2024-01-01T00:00:00Z"));
    expect(old.doi_volume.per_snapshot).toBe(2);
    expect(old.doi_volume.at_most_every_30_days).toBe(1);
    // limit: 0 reads nothing; both stale mirrors are not measured, not zero.
    expect(standin.requests.length).toBe(0);
    expect(recent.totals.not_measured).toBe(2);
    expect(recent.totals.bytes_to_copy).toBeNull();
  });

  test("progress is reported every ten mirrors", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => OK(`on0003${String(i).padStart(2, "0")}`));
    const lines: string[] = [];
    await measureStaleMirrors(rows, { ...options, onProgress: (l) => lines.push(l) });
    expect(lines).toEqual([
      "measured 10 of 21 stale mirror(s)",
      "measured 20 of 21 stale mirror(s)",
    ]);
  });
});
