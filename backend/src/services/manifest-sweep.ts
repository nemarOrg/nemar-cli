/**
 * Daily backstop for published versions whose S3 manifest never landed (#1130).
 *
 * The version-DOI callback generates and uploads `<id>/version/v<X>.json` after
 * the DOI is minted, but a failure there is caught and the webhook still
 * returns 200 (deliberately: the DOI is already registered, failing the run
 * would not un-mint it). Until now nothing retried, so one GitHub App
 * rate-limit burst on 2026-06-03 left 10 published versions serving
 * "Version not published" on data.nemar.org for 2.5 months.
 *
 * This sweep re-checks recent `dataset_versions` rows against S3 and heals
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
 * to recently created versions. LIMIT 50 bounds the per-run subrequest cost:
 * one unsigned S3 GET per row, plus a signed retry on 403.
 */
export const MANIFEST_SWEEP_QUERY = `SELECT d.dataset_id, dv.version, dv.doi, d.github_repo, d.concept_doi
   FROM datasets d
   JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id
  WHERE d.status = 'active'
    AND d.visibility = 'public'
    AND d.github_repo IS NOT NULL
    AND dv.created_at >= datetime('now', ?)
  ORDER BY dv.created_at DESC
  LIMIT 50`;

interface SweepRow {
  dataset_id: string;
  version: string;
  doi: string;
  github_repo: string;
  concept_doi: string | null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    console.error("[manifest-sweep] candidate query failed:", errText(err));
    return;
  }
  if (rows.length === 0) {
    console.log("[manifest-sweep] no versions inside the window");
    return;
  }

  const s3 = {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };

  const missing: Finding[] = [];
  for (const row of rows) {
    try {
      if ((await getManifest(s3, row.dataset_id, row.version)) !== null) continue;
    } catch (err) {
      // Transient S3/network error, not proof of a missing manifest. Skip
      // rather than regenerate over an object we could not read.
      console.error(
        `[manifest-sweep] presence check failed dataset=${row.dataset_id} version=${row.version}:`,
        errText(err),
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
    console.log(`[manifest-sweep] candidates=${rows.length} missing=0`);
    return;
  }

  let ctx: CheckContext;
  try {
    ctx = { db: env.DB, s3, githubPat: await getDatasetsToken(env) };
  } catch (err) {
    console.error("[manifest-sweep] could not mint datasets token:", errText(err));
    return;
  }

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  for (const finding of missing) {
    const result = await missingManifestCheck.fix(ctx, finding);
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
    `[manifest-sweep] candidates=${rows.length} missing=${missing.length} fixed=${fixed} skipped=${skipped} failed=${failed}`,
  );
}
