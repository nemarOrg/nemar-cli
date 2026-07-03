/**
 * Central manifest workflow callbacks: POST /manifest-ready and
 * POST /manifest-failed, called by the run-generate-manifest.yml workflow.
 * Authed with a per-job HMAC callback token (MANIFEST_CALLBACK_SECRET) whose
 * nonce is recovered from the manifest_jobs row before verification.
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { refreshMetadataAfterVersionDoi } from "../../services/dataset-reindex.js";
import { verifyManifestCallbackToken } from "../../services/github.js";
import { errorMessage } from "../../services/repo-metadata.js";
import { headVersionArtifact } from "../../services/s3.js";
import type { WebhookRouter } from "../webhooks/shared.js";

/**
 * Validate the manifest_ready / manifest_failed request body shape.
 * Exported so unit tests can pin the validation table without spinning
 * up the webhook harness.
 */
export interface ManifestCallbackBody {
  dataset_id: string;
  version: string;
  manifest_url?: string;
  summary_url?: string;
  totals?: { files?: number; bytes?: number; annex?: number; git?: number };
  workflow_run_id?: string;
  workflow_run_url?: string;
  error_message?: string;
  /** Stream A fix round: workflow echoes back the `skip_canary` dispatch
   *  flag so operators can confirm the canary was disabled on this run.
   *  Optional for back-compat with older Stream A runs that predate the
   *  field. Logged on the manifest-ready handler; not persisted (no
   *  column on manifest_jobs in migration 0025). */
  canary_skipped?: boolean;
}

export function validateManifestCallbackBody(
  body: unknown,
  required: ReadonlyArray<keyof ManifestCallbackBody>,
): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;
  for (const field of required) {
    if (b[field] === undefined || b[field] === null) {
      return `Missing required field: ${field}`;
    }
  }
  if (typeof b.dataset_id !== "string" || !b.dataset_id) {
    return "dataset_id must be a non-empty string";
  }
  if (typeof b.version !== "string" || !b.version) {
    return "version must be a non-empty string";
  }
  return null;
}

export function registerManifestCallbackRoutes(webhooks: WebhookRouter): void {
  /**
   * Callback handler for the central manifest workflow (#557, Stream A).
   * Invoked by the GitHub Actions job once both manifest.json and
   * summary.json are uploaded to S3. Validates the HMAC callback token
   * the worker signed at dispatch time, HEAD-checks both S3 artifacts to
   * confirm presence, then INSERTs the dataset_versions row that the
   * legacy in-Worker path used to write inline.
   *
   * Idempotent on the dataset_versions INSERT via OR IGNORE; idempotent
   * on the manifest_jobs row via status='dispatched' -> 'ready' transition
   * gate. Replaying a callback for an already-completed job is a no-op
   * (200 still returned to keep the workflow's exit happy).
   */
  webhooks.post("/manifest-ready", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    if (!token) {
      return c.json({ error: "Missing X-Webhook-Token header" }, 401);
    }

    let body: ManifestCallbackBody;
    try {
      body = (await c.req.json()) as ManifestCallbackBody;
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const validationError = validateManifestCallbackBody(body, [
      "dataset_id",
      "version",
      "manifest_url",
      "summary_url",
      "totals",
      "workflow_run_id",
    ]);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    if (!c.env.MANIFEST_CALLBACK_SECRET) {
      console.error("[manifest-ready] MANIFEST_CALLBACK_SECRET is unset; rejecting callback");
      return c.json({ error: "Server misconfigured: MANIFEST_CALLBACK_SECRET unset" }, 500);
    }

    // Find the in-flight job. Callback token is HMAC over (dataset_id,
    // version, nonce); we must look up the row first to recover the nonce
    // before we can verify the signature. Filter by status='dispatched'
    // so a replay attack against a stale nonce can't reach the INSERT.
    const job = await c.env.DB.prepare(
      `SELECT id, nonce, doi, concept_doi, doi_provider, status
       FROM manifest_jobs
       WHERE dataset_id = ? AND version = ? AND status = 'dispatched'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(body.dataset_id, body.version)
      .first<{
        id: number;
        nonce: string;
        doi: string | null;
        concept_doi: string | null;
        doi_provider: string | null;
        status: string;
      }>();

    if (!job) {
      // No dispatched job for this (dataset, version). Either we've
      // already processed the callback, or the dispatch row was never
      // written. Either way: don't trust the caller; 401.
      console.warn(
        `[manifest-ready] no dispatched manifest_jobs row for dataset=${body.dataset_id} version=${body.version}`,
      );
      return c.json({ error: "No in-flight manifest job for this dataset+version" }, 401);
    }

    const ok = await verifyManifestCallbackToken(
      token,
      { datasetId: body.dataset_id, version: body.version, nonce: job.nonce },
      c.env.MANIFEST_CALLBACK_SECRET,
    );
    if (!ok) {
      console.warn(
        `[manifest-ready] callback token mismatch dataset=${body.dataset_id} version=${body.version}`,
      );
      return c.json({ error: "Invalid callback token" }, 401);
    }

    // HEAD-check both S3 artifacts. The workflow tells us the URLs but we
    // verify by signed HEAD against our own bucket -- the contract is
    // {datasetId}/version/v{X.Y.Z}.json and the sibling -summary.json
    // key, so we don't need to trust the caller's manifest_url/summary_url
    // for the HEAD. (We still record what the caller sent for audit.)
    const s3Opts = {
      bucket: c.env.S3_BUCKET,
      region: c.env.AWS_REGION,
      accessKeyId: c.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    };

    let manifestPresent = false;
    let summaryPresent = false;
    // Capture the error message separately so the 502 body can distinguish
    // "S3 returned 404 (artifact really missing)" from "HEAD itself threw
    // before getting a status (IAM/credentials/network)". Without this the
    // operator-facing body just says "not found" even when the cause is a
    // credential drift, which sends them on the wrong diagnostic trail.
    let manifestHeadError: string | undefined;
    let summaryHeadError: string | undefined;
    try {
      manifestPresent = await headVersionArtifact(s3Opts, body.dataset_id, body.version, "");
    } catch (err) {
      manifestHeadError = err instanceof Error ? err.message : String(err);
      console.error("[manifest-ready] manifest HEAD failed:", err);
    }
    try {
      summaryPresent = await headVersionArtifact(s3Opts, body.dataset_id, body.version, "-summary");
    } catch (err) {
      summaryHeadError = err instanceof Error ? err.message : String(err);
      console.error("[manifest-ready] summary HEAD failed:", err);
    }

    if (!manifestPresent || !summaryPresent) {
      console.error(
        `[manifest-ready] S3 verification failed dataset=${body.dataset_id} version=${body.version} manifest=${manifestPresent} summary=${summaryPresent}`,
      );
      const hadHeadError = manifestHeadError || summaryHeadError;
      return c.json(
        {
          error: hadHeadError
            ? "S3 HEAD check failed (credentials/permissions error -- not a missing artifact)"
            : "S3 artifacts not found",
          manifest_present: manifestPresent,
          summary_present: summaryPresent,
          ...(manifestHeadError && { manifest_head_error: manifestHeadError }),
          ...(summaryHeadError && { summary_head_error: summaryHeadError }),
        },
        502,
      );
    }

    // Insert dataset_versions row (the contract piece that USED to live
    // inline in publish-version-doi). OR IGNORE makes this idempotent if
    // the legacy path already wrote the row (paranoid double-write
    // protection during the soak period).
    //
    // Critical: if this INSERT fails we MUST return 500 BEFORE flipping
    // manifest_jobs.status to 'ready'. Otherwise the row stays missing,
    // the job becomes unreplayable (status != 'dispatched' on retry), and
    // the central workflow has no signal to retry from.
    const provider = job.doi_provider === "zenodo" ? "zenodo" : "ezid";
    if (job.doi) {
      try {
        await c.env.DB.prepare(
          "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, ?)",
        )
          .bind(body.dataset_id, body.version, job.doi, provider)
          .run();
      } catch (err) {
        const dbError = errorMessage(err);
        console.error("[manifest-ready] dataset_versions insert failed:", err);
        return c.json({ error: "Failed to insert dataset_versions row", db_error: dbError }, 500);
      }
    } else {
      console.warn(
        `[manifest-ready] dataset=${body.dataset_id} version=${body.version} has no DOI on the manifest_jobs row; skipping dataset_versions insert`,
      );
    }

    // Mark the job as ready. We do this AFTER the insert so a failed
    // insert leaves the job in 'dispatched' for a retry / manual fix.
    try {
      await c.env.DB.prepare(
        `UPDATE manifest_jobs
         SET status = 'ready', completed_at = datetime('now')
         WHERE id = ? AND status = 'dispatched'`,
      )
        .bind(job.id)
        .run();
    } catch (err) {
      console.error("[manifest-ready] manifest_jobs UPDATE to 'ready' failed:", err);
    }

    // Issue #557: under centralFlow the dataset_versions row + manifest/summary
    // on S3 don't exist when the DOI is minted, so refresh the D1 metadata
    // columns HERE, after the row insert lands. (The legacy nemar.org sync was
    // removed in epic #837.) Background + non-fatal.
    if (job.doi) {
      // Pass body.version so the per-version HED row (#869) is written for exactly
      // this just-published version, not just the latest-by-created_at fallback.
      c.executionCtx.waitUntil(
        refreshMetadataAfterVersionDoi(c.env, body.dataset_id, body.version),
      );
    }

    const fileCount = body.totals?.files ?? 0;
    // canary_skipped echoed back from Stream A so operators can grep
    // confirmation that the dispatch-side skipCanary flag took effect.
    // Absent on older Stream A runs that predate the field.
    const canarySkipped =
      typeof body.canary_skipped === "boolean" ? String(body.canary_skipped) : "(unset)";
    console.log(
      `[manifest-ready] dataset=${body.dataset_id} version=${body.version} totals.files=${fileCount} canary_skipped=${canarySkipped}`,
    );

    return c.json({
      ok: true,
      dataset_id: body.dataset_id,
      version: body.version,
    });
  });

  /**
   * Failure-callback handler for the central manifest workflow. Invoked
   * when the workflow itself failed (build error, S3 upload error, etc.)
   * before it could write artifacts. Updates the manifest_jobs row to
   * status='failed' and records the workflow run URL for operator
   * follow-up. Returns 200 best-effort so the central workflow doesn't
   * see a 4xx and retry on its own.
   */
  webhooks.post("/manifest-failed", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    if (!token) {
      return c.json({ error: "Missing X-Webhook-Token header" }, 401);
    }

    let body: ManifestCallbackBody;
    try {
      body = (await c.req.json()) as ManifestCallbackBody;
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const validationError = validateManifestCallbackBody(body, ["dataset_id", "version"]);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    if (!c.env.MANIFEST_CALLBACK_SECRET) {
      console.error("[manifest-failed] MANIFEST_CALLBACK_SECRET is unset; rejecting callback");
      return c.json({ error: "Server misconfigured: MANIFEST_CALLBACK_SECRET unset" }, 500);
    }

    const job = await c.env.DB.prepare(
      `SELECT id, nonce, status FROM manifest_jobs
       WHERE dataset_id = ? AND version = ? AND status = 'dispatched'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(body.dataset_id, body.version)
      .first<{ id: number; nonce: string; status: string }>();

    if (!job) {
      console.warn(
        `[manifest-failed] no dispatched manifest_jobs row for dataset=${body.dataset_id} version=${body.version}`,
      );
      return c.json({ ok: true, no_job: true });
    }

    const ok = await verifyManifestCallbackToken(
      token,
      { datasetId: body.dataset_id, version: body.version, nonce: job.nonce },
      c.env.MANIFEST_CALLBACK_SECRET,
    );
    if (!ok) {
      console.warn(
        `[manifest-failed] callback token mismatch dataset=${body.dataset_id} version=${body.version}`,
      );
      return c.json({ error: "Invalid callback token" }, 401);
    }

    const errorMsg = body.error_message ?? "unknown error";
    const runUrl = body.workflow_run_url ?? null;
    if (runUrl === null) {
      console.warn(
        `[manifest-failed] dataset=${body.dataset_id} version=${body.version} workflow_run_url=null; operator follow-up will need to grep recent Actions runs manually`,
      );
    }
    try {
      await c.env.DB.prepare(
        `UPDATE manifest_jobs
         SET status = 'failed', error_message = ?, workflow_run_url = ?, completed_at = datetime('now')
         WHERE id = ? AND status = 'dispatched'`,
      )
        .bind(errorMsg, runUrl, job.id)
        .run();
    } catch (err) {
      console.error("[manifest-failed] manifest_jobs UPDATE to 'failed' failed:", err);
    }

    console.error(
      `[manifest-failed] dataset=${body.dataset_id} version=${body.version} error=${errorMsg} run_url=${runUrl ?? "(none)"}`,
    );

    return c.json({ ok: true, dataset_id: body.dataset_id, version: body.version });
  });
}
