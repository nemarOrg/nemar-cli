// Identifier-screen fixtures for backend tests (epic #1610, phase 4).
//
// The approval gate refuses a request whose screen is not clear, or whose
// screened commit is not the repository's current `main`, so every test that
// approves a request has to say what the screen found and stand in for the one
// GitHub read the gate makes. These helpers write a REAL report (built by the
// production parser, not a hand-shaped row) and answer that read; they do not
// bypass the gate, which runs unchanged.

import type { Database } from "bun:sqlite";
import { parseScreenReport } from "../../../shared/identifier-screen-report";

/** The commit the default clean screen read, and the default `main` head of the stand-ins. */
export const SCREENED_HEAD = "0123456789abcdef0123456789abcdef01234567";

/** A clean scan report of `datasetId` at `head`, as the workflow would post it. */
export function cleanScreenReportBody(
  datasetId: string,
  head: string = SCREENED_HEAD,
  status = "clean",
): Record<string, unknown> {
  return {
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head,
    scan: {
      id: datasetId,
      version: null,
      scanned_at: "2026-10-05T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    },
  };
}

/**
 * Mark a request's screen as finished with `status` (default `clean`) at `head`,
 * already mailed, the way the callback leaves it. The stored report is the
 * parser's output, so it is exactly what production would store.
 */
export function markScreen(
  db: Database,
  requestId: number,
  datasetId: string,
  opts: { status?: string; head?: string; findings?: Record<string, number> } = {},
): void {
  const status = opts.status ?? "clean";
  const body = cleanScreenReportBody(datasetId, opts.head ?? SCREENED_HEAD, status);
  // The counts a finding leaves, when the test cares which kinds the screen found.
  if (opts.findings) (body.scan as Record<string, unknown>).findings_by_kind = opts.findings;
  const report = parseScreenReport(body);
  db.run(
    `UPDATE publication_requests
        SET identifier_screen_status = ?, identifier_screen_report = ?,
            identifier_screen_at = datetime('now'), identifier_screen_emailed_at = datetime('now')
      WHERE id = ?`,
    [status, JSON.stringify(report), requestId],
  );
}

/** Mark every request of `datasetId` clean (for fixtures that seed by dataset). */
export function markDatasetScreensClean(db: Database, datasetId: string, head = SCREENED_HEAD) {
  const ids = db
    .query<{ id: number }, [string]>("SELECT id FROM publication_requests WHERE dataset_id = ?")
    .all(datasetId);
  for (const { id } of ids) markScreen(db, id, datasetId, { head });
}

/**
 * The gate's one GitHub read, `GET /repos/nemarDatasets/<id>/git/ref/heads/main`,
 * answered with `head`; null for any other request, so a stand-in can compose it
 * ahead of its own handling.
 */
export function mainRefAnswer(req: Request, head: string = SCREENED_HEAD): Response | null {
  const url = new URL(req.url);
  if (
    req.method === "GET" &&
    /^\/repos\/nemarDatasets\/[^/]+\/git\/ref\/heads\/main$/.test(url.pathname)
  ) {
    return Response.json({ ref: "refs/heads/main", object: { sha: head, type: "commit" } });
  }
  return null;
}
