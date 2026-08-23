/**
 * Daily backstop for published versions whose S3 manifest never landed (#1130).
 *
 * The "row exists, manifest missing" state this heals arises on the LEGACY
 * inline path (MANIFEST_VIA_CENTRAL_WORKFLOW=false): the version-DOI callback
 * inserts the `dataset_versions` row, then generates and uploads
 * `<id>/version/v<X>.json`, and a failure in between is caught while the
 * webhook still returns 200 (deliberately: the DOI is already registered,
 * failing the run would not un-mint it). One GitHub App rate-limit burst on
 * 2026-06-03 left 10 published versions in that state, serving "Version not
 * published" on data.nemar.org for 2.5 months. Under the central-workflow
 * flow the row is only written by /manifest-ready AFTER the manifest is
 * confirmed on S3, so this sweep additionally covers a flag rollback, an
 * S3 object lost after publication, and any future path that leaves a row
 * without its manifest. A dispatch failure under central flow leaves NO
 * `dataset_versions` row (only a failed/stuck manifest_jobs row), which is
 * structurally outside this query — tracked separately as #1136.
 *
 * The sweep re-checks recent `dataset_versions` rows against S3 and heals
 * missing manifests through the existing `missing-manifest` doctor fix
 * (regenerate from the GitHub tag, re-upload). It is bounded to a recency
 * window + LIMIT because a full-catalog pass costs one S3 GET per published
 * version (~800 today) and the daily cron invocation shares the Workers
 * subrequest budget with every other job. Full-catalog detection is the
 * zero-credential probe in nemar-observability; historical backfill is
 * `nemar admin doctor fix missing-manifest`.
 */
import type { Bindings } from "../types/bindings.js";
import { missingManifestCheck } from "./doctor/checks/missing-manifest.js";
import type { CheckContext, Finding } from "./doctor/types.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import { errorMessage } from "./repo-metadata.js";
import { getManifest } from "./s3.js";

/**
 * How far back the sweep looks. A publish-time failure is at most one day
 * old when first swept; the wide window gives a stuck version ~30 retries
 * (one per day) before it ages out and becomes a doctor-endpoint matter.
 */
export const MANIFEST_SWEEP_WINDOW = "-30 days";

/**
 * Candidate query, exported so the test pins the WHERE logic against a real
 * SQLite db. The predicates mirror the missing-manifest doctor check's
 * candidate query (active + public + has a repo to regenerate from), narrowed
 * to recently created versions. The LIMIT bounds the per-run subrequest cost:
 * one unsigned S3 GET per row, plus a signed retry on 403.
 */
export const MANIFEST_SWEEP_LIMIT = 50;

export const MANIFEST_SWEEP_QUERY = `SELECT d.dataset_id, dv.version, dv.doi, d.github_repo, d.concept_doi
   FROM datasets d
   JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id
  WHERE d.status = 'active'
    AND d.visibility = 'public'
    AND d.github_repo IS NOT NULL
    AND dv.created_at >= datetime('now', ?)
  ORDER BY dv.created_at DESC
  LIMIT ${MANIFEST_SWEEP_LIMIT}`;

interface SweepRow {
  dataset_id: string;
  version: string;
  doi: string;
  github_repo: string;
  concept_doi: string | null;
}

/**
 * Daily cron job: detect and heal missing version manifests for recent
 * publications. Loud on any finding: a missing manifest means a published,
 * DOI-bearing dataset is serving "Version not published" to users, so even
 * the fixed-it case logs at error level to leave a visible trail.
 */
export async function manifestIntegritySweep(env: Bindings): Promise<void> {
  // Production only (epic #923 Phase 7). The fix path reads the dataset repo
  // tree via the shared nemarDatasets GitHub App and uploads to the env-bound
  // bucket; on the dev worker that would burn shared App quota against real
  // repos. The daily cron already excludes this outside production; the guard
  // is repeated here so a future caller inherits the same safety.
  if (isNonProductionEnv(env)) {
    console.log("[manifest-sweep] skipped (non-production)");
    return;
  }

  let rows: SweepRow[];
  try {
    const res = await env.DB.prepare(MANIFEST_SWEEP_QUERY)
      .bind(MANIFEST_SWEEP_WINDOW)
      .all<SweepRow>();
    rows = res.results ?? [];
  } catch (err) {
    console.error("[manifest-sweep] candidate query failed:", errorMessage(err));
    return;
  }
  if (rows.length === 0) {
    console.log("[manifest-sweep] no versions inside the window");
    return;
  }
  if (rows.length >= MANIFEST_SWEEP_LIMIT) {
    // The slice is `ORDER BY created_at DESC LIMIT n`, so hitting the cap means
    // older-but-still-in-window versions were not looked at THIS run and will
    // keep being crowded out while the burst stays inside the window. Silent
    // truncation would read as "everything in the window is fine".
    console.error(
      `[manifest-sweep] candidate slice hit the ${MANIFEST_SWEEP_LIMIT}-row cap; older versions inside the window were not checked this run`,
    );
  }

  const s3 = {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };

  const missing: Finding[] = [];
  // Counted separately from `missing`. Both branches below `continue`, so the
  // summary could not tell "checked all N, every manifest present" apart from
  // "N threw and were skipped" -- and an S3 outage during the tick would print a
  // reassuring `missing=0` having verified nothing. That is the same shape as the
  // incident this backstop exists for: a real problem behind a healthy-looking
  // signal.
  let checkFailures = 0;
  for (const row of rows) {
    try {
      if ((await getManifest(s3, row.dataset_id, row.version)) !== null) continue;
    } catch (err) {
      // Transient S3/network error, not proof of a missing manifest. Skip
      // rather than regenerate over an object we could not read.
      checkFailures++;
      console.error(
        `[manifest-sweep] presence check failed dataset=${row.dataset_id} version=${row.version}:`,
        errorMessage(err),
      );
      continue;
    }
    missing.push({
      dataset_id: row.dataset_id,
      version: row.version,
      details: { doi: row.doi, github_repo: row.github_repo, concept_doi: row.concept_doi },
    });
  }
  if (missing.length === 0) {
    // Loud when a check failed, even though nothing was found missing: "missing=0
    // after 40 of 50 checks errored" is not a clean bill of health, and reporting
    // it as one is how a silent regression survives a daily backstop.
    if (checkFailures > 0) {
      console.error(
        `[manifest-sweep] candidates=${rows.length} missing=0 check_failures=${checkFailures} -- this run did NOT verify every candidate; treat missing=0 as inconclusive`,
      );
      return;
    }
    console.log(`[manifest-sweep] candidates=${rows.length} missing=0 check_failures=0`);
    return;
  }

  let ctx: CheckContext;
  try {
    ctx = { db: env.DB, s3, githubPat: await getDatasetsToken(env) };
  } catch (err) {
    console.error("[manifest-sweep] could not mint datasets token:", errorMessage(err));
    return;
  }

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  for (const finding of missing) {
    // Per-finding guard, matching archiveRetrySweep's per-row style: fix()'s
    // own pre-write getManifest re-check can throw on a transient S3 5xx,
    // and one bad finding must not abort the rest of the day's run (or
    // swallow the summary line below).
    let result: Awaited<ReturnType<typeof missingManifestCheck.fix>>;
    try {
      result = await missingManifestCheck.fix(ctx, finding);
    } catch (err) {
      result = { status: "failed", message: errorMessage(err) };
    }
    if (result.status === "fixed") {
      fixed++;
      console.error(
        `[manifest-sweep] healed missing manifest dataset=${finding.dataset_id} version=${finding.version}`,
      );
    } else if (result.status === "skipped") {
      skipped++;
    } else {
      failed++;
      console.error(
        `[manifest-sweep] fix FAILED dataset=${finding.dataset_id} version=${finding.version}: ${result.message ?? "unknown"}`,
      );
    }
  }
  console.error(
    `[manifest-sweep] candidates=${rows.length} missing=${missing.length} fixed=${fixed} skipped=${skipped} failed=${failed} check_failures=${checkFailures}`,
  );
}
