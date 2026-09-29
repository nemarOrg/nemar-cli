/**
 * What `nemar admin reindex` prints for one dataset (#1549 follow-up): the
 * warnings the backend attaches to a successful run, and DOIs past the
 * per-run lookup cap, must reach an operator who did not ask for --json.
 */

import { describe, expect, test } from "bun:test";
import { doiLookupWarnings } from "../backend/src/services/dataset-reindex";
import { reindexLines } from "../src/commands/admin";
import type { ReindexResponse } from "../src/lib/api/admin";

const plain = (lines: string[]): string[] =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes
  lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));

describe("reindexLines", () => {
  test("prints the failed-lookup warning and the over-cap count", () => {
    const doi_resolution = { resolved: 12, unresolved: 1, failed: 2, skipped: 3 };
    // The warning text is the backend's own, as runEnrichmentForDataset
    // attaches it and the reindex route passes it through.
    const response: ReindexResponse = {
      dataset_id: "nm000275",
      enrichment: { status: "ok", doi_resolution, warnings: doiLookupWarnings(doi_resolution) },
      sync: { status: "ok", metadata_columns_written: true },
    };
    expect(plain(reindexLines(response))).toEqual([
      "  nm000275     enrich:ok  sync:ok  cols:written",
      "    warning: doi_resolution: 2 of 15 DOI lookup(s) got no registry answer; reindex this dataset again to label them with registry metadata",
      "    DOI lookups: 12 resolved, 1 unresolved, 2 failed",
      "    3 DOI(s) past the per-run lookup cap were not looked up; their relation labels were chosen without registry metadata",
    ]);
  });

  test("failed lookups still say to reindex when the backend sent no warning", () => {
    // A backend from before the lookup warning (#1556) sends the counts alone.
    const response: ReindexResponse = {
      dataset_id: "on002721",
      enrichment: {
        status: "ok",
        doi_resolution: { resolved: 3, unresolved: 0, failed: 2, skipped: 0 },
      },
      sync: { status: "ok", metadata_columns_written: true },
    };
    expect(plain(reindexLines(response))).toEqual([
      "  on002721     enrich:ok  sync:ok  cols:written",
      "    DOI lookups: 3 resolved, 0 unresolved, 2 failed (reindex this dataset again)",
    ]);
  });

  test("a clean run prints no warning and no cap line", () => {
    const response: ReindexResponse = {
      dataset_id: "nm000273",
      enrichment: {
        status: "ok",
        doi_resolution: { resolved: 4, unresolved: 0, failed: 0, skipped: 0 },
      },
      sync: { status: "ok", metadata_columns_written: true },
    };
    expect(plain(reindexLines(response))).toEqual([
      "  nm000273     enrich:ok  sync:ok  cols:written",
      "    DOI lookups: 4 resolved, 0 unresolved, 0 failed",
    ]);
  });
});
