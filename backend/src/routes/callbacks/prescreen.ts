/**
 * Publication pre-screen callback: POST /prescreen-result, called by the
 * run-prescreen.yml workflow (issue #666). Authed with a per-request HMAC
 * callback token (PRESCREEN_CALLBACK_SECRET) whose nonce is recovered from
 * the publication_requests row before verification.
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { verifyPrescreenCallbackToken } from "../../services/github.js";
import { getDatasetS3Stats } from "../../services/s3.js";
import type { WebhookRouter } from "../webhooks/shared.js";

// ============================================================================
// Publication pre-screen callback (issue #666)
// ============================================================================

export interface PrescreenCallbackBody {
  dataset_id: string;
  request_id: number;
  // "error" = the workflow could not complete (install/claude/parse failure);
  // the Worker resets the screen so the request falls back to manual review.
  verdict: "pass" | "block" | "error";
  reasons?: string[];
  issue_url?: string;
  workflow_run_id?: string;
}

/** Validate the run-prescreen workflow's callback body. */
export function validatePrescreenCallbackBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.dataset_id !== "string" || !b.dataset_id) {
    return "dataset_id must be a non-empty string";
  }
  if (typeof b.request_id !== "number" || !Number.isInteger(b.request_id)) {
    return "request_id must be an integer";
  }
  if (b.verdict !== "pass" && b.verdict !== "block" && b.verdict !== "error") {
    return "verdict must be 'pass', 'block', or 'error'";
  }
  if (
    b.reasons !== undefined &&
    (!Array.isArray(b.reasons) || b.reasons.some((r) => typeof r !== "string"))
  ) {
    return "reasons must be an array of strings";
  }
  if (b.issue_url !== undefined && b.issue_url !== null && typeof b.issue_url !== "string") {
    return "issue_url must be a string";
  }
  return null;
}

/**
 * Combine the `claude -p` verdict with an independent server-side S3 check.
 * The workflow judges README/metadata/declared-data quality; the Worker has
 * the AWS credentials and is the source of truth for whether the data blobs
 * actually landed. The S3 check is therefore authoritative on the DATA
 * question in BOTH directions:
 *   - empty objects/ prefix -> add a "missing data" block (catches a workflow
 *     that passed but the blobs never uploaded);
 *   - real blobs present -> a "no real data / too small" verdict was a false
 *     negative (e.g. the workflow's git-tree heuristic was annex-blind for
 *     symlink-stored annex content, #753), so strip the data-shortage reasons
 *     and, if that was the ONLY reason to block, downgrade to pass.
 * Non-data reasons (missing README / Name / Authors) the Worker cannot judge,
 * so they always stand. `objectCount` is `undefined` when the page-count cap
 * was hit (i.e. *many* objects), which is emphatically data-present. An S3
 * read error yields `s3 = null` so infra blips never flip the verdict either
 * way. Pure function: no I/O, fully testable.
 */
export interface PrescreenS3Presence {
  totalSize: number;
  objectCount: number | undefined;
}

/**
 * A pre-screen block reason the authoritative S3 data check can refute. Covers
 * the workflow's data-shortage phrasings ("no real data", "too small",
 * "0 annexed files", "binary data ... not found") plus the synthetic storage
 * reason this function adds on an empty prefix.
 */
export function isDataShortageReason(reason: string): boolean {
  // Whole-word `annex`/`0 ... files` (not bare substrings) so a non-data block
  // reason that merely contains those letters isn't silently stripped. `s3` is
  // word-bounded for the same reason. No bare `storage`: the only storage
  // phrasing is the synthetic reason this module adds in the (mutually
  // exclusive) s3Missing branch, which never reaches the stripping path.
  return /no (real )?data|too small|implausibl|\b0 (annexed |data )?files\b|binary data|\bannexed?\b|\bs3\b/i.test(
    reason,
  );
}

/**
 * Decide whether the pre-screen result should be surfaced as an advisory
 * concern. `flagged` only FLAGS (the screen found a gap) -- it never blocks
 * publication (#756); the handler records it as prescreen_status='concern'. The
 * S3-authority logic is unchanged: storage with real blobs refutes a
 * data-shortage reason (and can clear an all-data-shortage flag), an empty
 * prefix adds one.
 */
export function decidePrescreenOutcome(
  verdict: "pass" | "block",
  reasons: string[],
  s3: PrescreenS3Presence | null,
): { flagged: boolean; reasons: string[] } {
  let out = [...reasons];
  let flagged = verdict === "block";

  const s3Missing = !!s3 && s3.totalSize === 0 && s3.objectCount === 0;
  // objectCount === undefined => first-page cap hit => many objects => present.
  const s3Present = !!s3 && (s3.totalSize > 0 || s3.objectCount === undefined);

  if (s3Present) {
    // Storage confirms real blobs: any data-shortage reason is a false
    // negative. Drop those; keep README/metadata reasons. Clear the flag only
    // when it carried data-shortage reason(s) that ALL got stripped -- never
    // silently clear a reasonless or non-data flag.
    const kept = out.filter((r) => !isDataShortageReason(r));
    if (flagged && kept.length === 0 && out.length > 0) flagged = false;
    out = kept;
  } else if (s3Missing) {
    flagged = true;
    if (!out.some((r) => /no data|\bs3\b|storage/i.test(r))) {
      out.push("No data files were found in storage for this dataset.");
    }
  }

  return { flagged, reasons: out };
}

export function registerPrescreenRoutes(webhooks: WebhookRouter): void {
  /**
   * Callback handler for the run-prescreen workflow. The workflow has already
   * judged the dataset and (on block) opened a GitHub issue; this endpoint
   * verifies the HMAC token, runs the independent S3 presence check, and
   * records the outcome on the publication_requests row -- flipping it to
   * 'blocked' (+ emailing the requester) or marking the screen 'passed'.
   *
   * One-shot: gated on prescreen_status='pending', so a replayed callback for
   * an already-resolved request finds no row and 401s.
   */
  webhooks.post("/prescreen-result", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    if (!token) {
      return c.json({ error: "Missing X-Webhook-Token header" }, 401);
    }

    let body: PrescreenCallbackBody;
    try {
      body = (await c.req.json()) as PrescreenCallbackBody;
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const validationError = validatePrescreenCallbackBody(body);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    if (!c.env.PRESCREEN_CALLBACK_SECRET) {
      console.error("[prescreen-result] PRESCREEN_CALLBACK_SECRET is unset; rejecting callback");
      return c.json({ error: "Server misconfigured: PRESCREEN_CALLBACK_SECRET unset" }, 500);
    }

    // Recover the nonce + requester from the in-flight row. Filter on
    // prescreen_status='pending' so a replay against a resolved request can't
    // re-trigger the block/email.
    const request = await c.env.DB.prepare(
      `SELECT pr.id, pr.dataset_id, pr.prescreen_nonce, pr.requested_by,
              u.username AS requested_by_username, u.email AS requested_by_email
         FROM publication_requests pr
         JOIN users u ON pr.requested_by = u.id
        WHERE pr.id = ? AND pr.dataset_id = ? AND pr.prescreen_status = 'pending'
        LIMIT 1`,
    )
      .bind(body.request_id, body.dataset_id)
      .first<{
        id: number;
        dataset_id: string;
        prescreen_nonce: string | null;
        requested_by: number;
        requested_by_username: string;
        requested_by_email: string;
      }>();

    if (!request || !request.prescreen_nonce) {
      console.warn(
        `[prescreen-result] no pending prescreen for request_id=${body.request_id} dataset=${body.dataset_id}`,
      );
      return c.json({ error: "No in-flight pre-screen for this request" }, 401);
    }

    const ok = await verifyPrescreenCallbackToken(
      token,
      { datasetId: body.dataset_id, requestId: request.id, nonce: request.prescreen_nonce },
      c.env.PRESCREEN_CALLBACK_SECRET,
    );
    if (!ok) {
      console.warn(
        `[prescreen-result] callback token mismatch request_id=${body.request_id} dataset=${body.dataset_id}`,
      );
      return c.json({ error: "Invalid callback token" }, 401);
    }

    // verdict="error": the workflow could not complete. Don't block on an
    // infrastructure failure -- reset the screen to NULL so the request falls
    // back to normal admin review (status stays 'requested'). No S3 check, no
    // email. Gated on 'pending' so it's still one-shot.
    if (body.verdict === "error") {
      const res = await c.env.DB.prepare(
        `UPDATE publication_requests
            SET prescreen_status = NULL, prescreen_nonce = NULL,
                prescreen_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND prescreen_status = 'pending'`,
      )
        .bind(request.id)
        .run();
      console.warn(
        `[prescreen-result] dataset=${body.dataset_id} request_id=${request.id} verdict=error; reset to manual review (changes=${res.meta.changes})`,
      );
      return c.json({ ok: true, dataset_id: body.dataset_id, blocked: false, reset: true });
    }

    // Independent server-side S3 presence check. Capped at one page (1000
    // objects) -- we only need to distinguish "empty" from "non-empty", not
    // the full count. A read error leaves s3=null so we trust the workflow.
    let s3: PrescreenS3Presence | null = null;
    try {
      s3 = await getDatasetS3Stats(
        {
          bucket: c.env.S3_BUCKET,
          region: c.env.AWS_REGION,
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        },
        body.dataset_id,
        1,
      );
    } catch (err) {
      console.error(`[prescreen-result] S3 stats failed for ${body.dataset_id} (non-fatal):`, err);
    }

    const { flagged, reasons } = decidePrescreenOutcome(body.verdict, body.reasons ?? [], s3);
    // Audit the S3 override: if the authoritative S3 check changed the workflow's
    // raw verdict (e.g. cleared an annex-blind false flag, #753), record what was
    // dropped so the change is never silent.
    const effectiveVerdict = flagged ? "block" : "pass";
    if (body.verdict !== effectiveVerdict) {
      const stripped = (body.reasons ?? []).filter((r) => !reasons.includes(r));
      console.log(
        `[prescreen-result] S3 override for ${body.dataset_id}: ${body.verdict} -> ${effectiveVerdict}; stripped=${JSON.stringify(stripped)} s3_size=${s3?.totalSize ?? "unknown"}`,
      );
    }
    // `|| null` (not `?? null`): the advisory workflow sends issue_url="" now, and
    // we want NULL in the column, not an empty string.
    const issueUrl = body.issue_url || null;

    let res: D1Result;
    if (flagged) {
      // Advisory (#756): record the concern but DO NOT block. The request stays in
      // the normal admin-review queue; the concern + reasons are surfaced in the
      // publish-status views. No status flip, no block email, no repo issue (the
      // workflow no longer opens one). Real blockers (BIDS) keep status='blocked'.
      res = await c.env.DB.prepare(
        `UPDATE publication_requests
            SET prescreen_status = 'concern', prescreen_reasons = ?, prescreen_issue_url = ?,
                prescreen_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND prescreen_status = 'pending'`,
      )
        .bind(JSON.stringify(reasons), issueUrl, request.id)
        .run();
    } else {
      res = await c.env.DB.prepare(
        `UPDATE publication_requests
            SET prescreen_status = 'passed', prescreen_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id = ? AND prescreen_status = 'pending'`,
      )
        .bind(request.id)
        .run();
    }
    if (res.meta.changes === 0) {
      // One-shot guard: the screen was no longer 'pending' (a duplicate/late
      // callback). Harmless, but log so a double-dispatch is explicable.
      console.warn(
        `[prescreen-result] no-op for ${body.dataset_id} request_id=${request.id}: prescreen_status was not 'pending' (duplicate callback?)`,
      );
    }

    console.log(
      `[prescreen-result] dataset=${body.dataset_id} request_id=${request.id} verdict=${body.verdict} prescreen_status=${flagged ? "concern" : "passed"} s3_objects=${s3 ? (s3.objectCount ?? "capped") : "unknown"}`,
    );

    return c.json({
      ok: true,
      dataset_id: body.dataset_id,
      prescreen_status: flagged ? "concern" : "passed",
    });
  });
}
