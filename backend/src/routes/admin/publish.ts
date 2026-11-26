/**
 * Admin routes: publication workflow (list/deny/approve publication requests,
 * S3 Object Lock). The approve route is a thin adapter over the 16-step
 * state machine in services/publication-orchestrator.ts (#904, epic #902);
 * list/deny/s3-lock handlers moved verbatim from routes/admin.ts in #903.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import {
  APPROVAL_DISPATCH_TOKEN_HEADER,
  INVALID_DATASET_ID_MESSAGE,
  REQUEST_MISMATCH_MESSAGE,
} from "../../../../shared/contract/publication.js";
import { screenGate } from "../../../../shared/identifier-screen-report.js";
import { RESTORE_DONE, RESTORE_REFUSAL_TEXT } from "../../../../shared/publication-auto-deny.js";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
  APPROVAL_DISPATCH_ID_RE,
  DENIAL_REASON_MAX_LENGTH,
} from "../../../../shared/publication-limits.js";
import { publishingStanding } from "../../../../shared/publication-steps.js";
import {
  searchLimitProblem,
  substringLikePattern,
} from "../../../../shared/publish-list-search.js";
import { auditLogStatement } from "../../db/audit-log";
import {
  ACTIVE_REQUEST_TAIL_SQL,
  APPROVAL_CLAIM_CLEAR_SQL,
  approvalInFlightSql,
} from "../../services/approval-dispatch";
import { isValidDatasetId } from "../../services/datasetId";
import { resolveEmailConfig, sendPublicationDeniedEmail } from "../../services/email";
import { SCREEN_BATCH_REFUSAL_TEXT, type ScreenBatchRefusal } from "../../services/email";
import { getDatasetsAuth } from "../../services/github-auth";
import { signApprovalDispatchToken } from "../../services/github/callback-tokens";
import {
  DispatchRejectedError,
  approvalDispatchEnvironment,
  triggerApprovePublication,
} from "../../services/github/dispatch";
import {
  RERUN_GUARD_SQL,
  SCREEN_REPORT_DEADLINE_MINUTES,
  hasStartedPublishing,
  isScreenExempt,
  notifyAdminsOfScreen,
  readStoredState,
  recordScreenAcknowledgment,
  screenStateGate,
  screenView,
  startIdentifierScreen,
  verifyScreenHead,
} from "../../services/identifier-screen";
import { restorePublicationRequest } from "../../services/publication-auto-deny";
import { denyPublicationRequest } from "../../services/publication-deny";
import {
  acknowledgeIdentifierScreenSchema,
  approveSchema,
  publicationReviewOverrideSchema,
  runPublicationApproval,
} from "../../services/publication-orchestrator";
import {
  type ReviewGateResult,
  evaluateApprovalReviewGate,
  recordApprovalOverride,
} from "../../services/publication-review-gate";
import { publicationReviewSummaries } from "../../services/publication-review-view";
import { errorMessage } from "../../services/repo-metadata";
import {
  LOCKABLE_KEY_RE,
  OBJECT_LOCK_BATCH_SIZE,
  applyObjectLockBatch,
  lockObjectKeys,
} from "../../services/s3";
import {
  batchClaimGuardSql,
  noteBatchDispatch,
  readScreenBatch,
  settleBatchEntry,
  settleBatchRefusal,
} from "../../services/screen-batch";
import { getS3Config } from "./shared";
import type { AdminRouter } from "./shared";

/** The re-run route's answer for a request whose approval has started publishing. */
const APPROVAL_IN_PROGRESS = {
  error: "approval_in_progress",
  message:
    "An approval of this request has already started publishing, and it passed the identifier screen when it started. Resume it rather than screening again.",
};

/**
 * The optional body of the approve-dispatch route. `request_id` is the request the click was for
 * (#1579, ADR 0105 decision 7): the page names the one it showed, and the route refuses a click
 * for a request that is no longer the one in force. Optional, so the bodyless click every existing
 * caller sends is unchanged.
 */
const dispatchBodySchema = z
  .object({
    acknowledge_identifier_screen: acknowledgeIdentifierScreenSchema.optional(),
    override_publication_review: publicationReviewOverrideSchema.optional(),
    request_id: z.number().int().positive().optional(),
  })
  .strict();

/** The answer for a dispatch of a request the batch already screened and counted. */
const ALREADY_SCREENED = {
  error: "already_screened",
  message: `The batch cannot screen this request again: ${SCREEN_BATCH_REFUSAL_TEXT["already-screened"]}.`,
} as const;

/** The optional body of the screen re-run route: nothing, or exactly a batch id. */
const identifierScreenBodySchema = z
  .object({ batch_id: z.number().int().positive().optional() })
  .strict();

const REQUEST_STATUSES = ["requested", "approving", "blocked", "published", "denied"] as const;

/**
 * The list route's filters. `status` is one status or a comma-separated list
 * (no value means every request); an unknown status is a 400 rather than an
 * empty list, so a typo is never read as "nothing to do".
 */
function parseListFilters(
  rawStatus: string | undefined,
  rawSearch: string | undefined,
): { statuses: string[]; search: string } | { error: string } {
  const statuses = (rawStatus ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = statuses.filter((s) => !(REQUEST_STATUSES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    return {
      error: `Unknown status: ${unknown.join(", ")}. Use ${REQUEST_STATUSES.join(", ")}.`,
    };
  }
  const search = (rawSearch ?? "").trim();
  // D1 refuses a LIKE pattern over 50 bytes with a 500, which bun:sqlite does not
  // reproduce, so the bound is enforced here (shared/publish-list-search.ts).
  const tooLong = searchLimitProblem(search);
  if (tooLong) return { error: tooLong };
  return { statuses: [...new Set(statuses)], search };
}

export function registerPublishRoutes(admin: AdminRouter): void {
  // ============================================================================
  // Publication Workflow (Admin)
  // ============================================================================

  /**
   * GET /admin/publish/requests - List publication requests
   *
   * `approval_in_flight` is computed per row from the same predicate the
   * dispatch route claims with (services/approval-dispatch.ts), so a client
   * never offers an action the route would refuse and never hard-codes the
   * lease. The new columns `approval_requested_by` and `approval_dispatched_at`
   * ride along in `pr.*`.
   *
   * `publication_review` (ADR 0102) is the review of each request, re-derived now from its stored
   * report and the live facts: the outcome, the headline and the reason codes in the shared
   * words, and no sentence the model wrote. The dataset's columns it needs are joined in under
   * names of their own and withheld from the response below, so the wire gains one key.
   */
  admin.get("/publish/requests", async (c) => {
    const db = c.env.DB;
    const parsed = parseListFilters(c.req.query("status"), c.req.query("search"));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const { statuses, search } = parsed;

    let query = `
    SELECT pr.*, u.username as requested_by_username, u.email as requested_by_email,
           d.name AS dataset_name,
           ${approvalInFlightSql("pr.")} AS approval_in_flight,
           d.dataset_id AS review_ds_id, d.source AS review_ds_source,
           d.is_exemplar AS review_ds_is_exemplar, d.concept_doi AS review_ds_concept_doi,
           d.ezid_status AS review_ds_ezid_status,
           d.first_published_at AS review_ds_first_published_at
    FROM publication_requests pr
    JOIN users u ON pr.requested_by = u.id
    LEFT JOIN datasets d ON d.dataset_id = pr.dataset_id
  `;
    const where: string[] = [];
    const params: string[] = [];

    if (statuses.length > 0) {
      where.push(`pr.status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    // Bound parameters, with the pattern characters escaped, so the text is a
    // literal substring and never a pattern (#1775).
    if (search) {
      const like = substringLikePattern(search);
      where.push(
        "(pr.dataset_id LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like);
    }
    if (where.length > 0) query += ` WHERE ${where.join(" AND ")}`;

    // An exact dataset id comes first, so searching "nm000104" never buries it
    // under a longer id that merely contains it.
    if (search) {
      query += " ORDER BY (LOWER(pr.dataset_id) = LOWER(?)) DESC, pr.requested_at DESC";
      params.push(search);
    } else {
      query += " ORDER BY pr.requested_at DESC";
    }

    const requests = await db
      .prepare(query)
      .bind(...params)
      .all<{
        id: number;
        dataset_id: string;
        status: string;
        requested_at: string;
        requested_by_username: string;
        requested_by_email: string;
        dataset_name: string | null;
        steps_completed: string;
        current_step: string | null;
        last_error: string | null;
        prescreen_status: string | null;
        prescreen_reasons: string | null;
        prescreen_issue_url: string | null;
        approval_requested_by: number | null;
        approval_dispatched_at: string | null;
        approval_in_flight: number;
        prescreen_nonce?: string | null;
        block_reason: string | null;
        anonymous: number | null;
        identifier_screen_status: string | null;
        identifier_screen_nonce?: string | null;
        identifier_screen_report?: string | null;
        identifier_screen_ack_by: number | null;
        identifier_screen_ack_at: string | null;
        review_ds_id: string | null;
        review_ds_source: string | null;
        review_ds_is_exemplar: number | null;
        review_ds_concept_doi: string | null;
        review_ds_ezid_status: string | null;
        review_ds_first_published_at: string | null;
      }>();

    // One clock for the whole list, so two rows are aged by the same instant.
    const nowMs = Date.now();
    // The review of every row, read in a few statements and derived a few rows at a time; a row
    // whose review cannot be read says so for itself and never fails the list (ADR 0102).
    const reviews = await publicationReviewSummaries(
      c.env,
      requests.results.map((r) => ({
        request: {
          id: r.id,
          dataset_id: r.dataset_id,
          status: r.status,
          block_reason: r.block_reason,
          anonymous: r.anonymous,
          identifier_screen_status: r.identifier_screen_status,
          identifier_screen_report: r.identifier_screen_report ?? null,
          identifier_screen_ack_by: r.identifier_screen_ack_by,
          identifier_screen_ack_at: r.identifier_screen_ack_at,
          steps_completed: r.steps_completed ?? null,
        },
        dataset:
          r.review_ds_id === null
            ? null
            : {
                source: r.review_ds_source,
                is_exemplar: r.review_ds_is_exemplar,
                concept_doi: r.review_ds_concept_doi,
                ezid_status: r.review_ds_ezid_status,
                first_published_at: r.review_ds_first_published_at,
                // The detail's field; the summary does not use it.
                total_files: null,
              },
      })),
      nowMs,
    );
    const rows = requests.results.map((r, index) => {
      // `pr.*` puts every column on the wire without naming it. The two
      // callback nonces are credentials (each one verifies a workflow's
      // callback), and the stored screen report is shown ONLY through
      // describeScreen's words below, so all three are withheld here, from
      // everyone (epic #1610 phase 4). The dataset columns the review reads
      // were joined in for it and are not part of the contract either; the
      // dataset's `name` is, as `dataset_name` (the list's `search` matches it
      // and the terminal prints it, #1775).
      const {
        prescreen_nonce: _prescreenNonce,
        identifier_screen_nonce: _screenNonce,
        identifier_screen_report: screenReport,
        review_ds_id: _dsId,
        review_ds_source: _dsSource,
        review_ds_is_exemplar: _dsIsExemplar,
        review_ds_concept_doi: _dsConceptDoi,
        review_ds_ezid_status: _dsEzidStatus,
        review_ds_first_published_at: _dsFirstPublishedAt,
        ...rest
      } = r;
      return {
        ...rest,
        steps_completed: JSON.parse(r.steps_completed || "[]"),
        approval_in_flight: r.approval_in_flight === 1,
        identifier_screen: screenView(r.dataset_id, r.identifier_screen_status, screenReport),
        publication_review: reviews[index],
      };
    });

    return c.json({ requests: rows, count: rows.length });
  });

  /**
   * POST /admin/publish/:id/deny - Deny a publication request (#1603; ADR 0105, decision 11)
   *
   * The newest active request is read, then refused by the shared words, in this order, before any
   * write (a denial that is refused changes nothing and mails nobody):
   *   404                       no active request (the body this route always had)
   *   409 request_mismatch      `request_id` names a request that is not that one: it was denied or
   *                             filed again since the administrator read it (#1579, decision 7)
   *   409 deny_after_publishing a step outside the validation-only ones is done
   *                             (`hasStartedPublishing`) or is the one the run was on when it
   *                             stopped (`current_step`), WHATEVER the status: a request filed again
   *                             after the owner-name walk-back keeps its steps, and the dataset may
   *                             already be public, so the depositor must not be told "denied"
   *   409 approval_in_flight    an approval is running for it (`approvalInFlightSql`, the lease the
   *                             dispatch claim reads): a denial would overwrite a run still writing
   * A stalled run that has not started publishing (the lease lapsed, or a failed run past its
   * grace) can be denied: nothing is public, and nothing is writing.
   *
   * Then ONE conditional write. Its terms are the lease predicate and the `updated_at` that was
   * read, so a request that was published, denied, claimed, or touched by a run between the read
   * and the write is refused rather than overwritten; a lost write is read again and answered with
   * the true reason, by the same rule as the first read. The depositor's mail goes after the write
   * has changed a row, never before. A denial also ends a lapsed web claim
   * (`APPROVAL_CLAIM_CLEAR_SQL`) so a denied request holds none; the dispatch audit row still
   * names the administrator who clicked.
   */
  const denySchema = z.object({
    reason: z
      .string()
      .min(1, "Reason is required")
      .max(DENIAL_REASON_MAX_LENGTH, "Reason too long"),
    request_id: z.number().int().positive().optional(),
  });

  admin.post("/publish/:id/deny", zValidator("json", denySchema), async (c) => {
    const datasetId = c.req.param("id");
    const { reason, request_id: requestId } = c.req.valid("json");
    const adminUser = c.get("user");
    const db = c.env.DB;

    const denied = await denyPublicationRequest(db, {
      datasetId,
      requestId,
      deniedBy: adminUser.id,
      reason,
    });
    if (denied.kind === "refused") return c.json(denied.body, denied.status);
    const request = { requested_by: denied.requestedBy };

    // Notify the requesting user, only now that the denial is recorded
    try {
      const user = await db
        .prepare("SELECT username, email FROM users WHERE id = ?")
        .bind(request.requested_by)
        .first<{ username: string; email: string }>();

      if (user) {
        const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
        await sendPublicationDeniedEmail(
          user.email,
          user.username,
          datasetId,
          reason,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
          c.env,
        );
      }
    } catch (emailError) {
      console.error("Failed to send denial email:", emailError);
    }

    return c.json({
      message: "Publication request denied",
      dataset_id: datasetId,
      reason,
    });
  });

  /**
   * POST /admin/publish/:id/restore - Restore a denied publication request (ADR 0139, decision 4).
   *
   * Sets the dataset's newest request back to `requested` when it was denied (by an administrator
   * or by the automatic denial) and not withdrawn, and no newer request exists; the request then
   * waits for its decision again. `request_id` may name the request the administrator read: it is
   * refused when it is not the newest. One batch writes the request and an audit row
   * (`publication_restore`) together. Admin or owner, like every route of this router. A refusal
   * answers `{ error: <sentence>, code: <word> }`, the review routes' convention, so the CLI prints
   * the sentence:
   *   404 not_found       the dataset has no request
   *   409 not_denied      the newest request is not denied
   *   409 withdrawn       the newest request was withdrawn by its depositor
   *   409 newer_request   `request_id` is not the newest request
   */
  const restoreSchema = z.object({ request_id: z.number().int().positive().optional() }).strict();

  admin.post("/publish/:id/restore", zValidator("json", restoreSchema), async (c) => {
    const datasetId = c.req.param("id");
    if (!isValidDatasetId(datasetId)) {
      return c.json({ error: "invalid_dataset_id", message: INVALID_DATASET_ID_MESSAGE }, 400);
    }
    const { request_id: requestId } = c.req.valid("json");
    const outcome = await restorePublicationRequest(c.env.DB, {
      datasetId,
      adminId: c.get("user").id,
      requestId,
    });
    if (outcome.kind === "refused") {
      return c.json(
        { error: RESTORE_REFUSAL_TEXT[outcome.refusal], code: outcome.refusal },
        outcome.refusal === "not_found" ? 404 : 409,
      );
    }
    return c.json({
      message: RESTORE_DONE,
      dataset_id: datasetId,
      request_id: outcome.requestId,
    });
  });

  /**
   * POST /admin/publish/:id/approve - Approve and run the publication
   * orchestrator. The 16-step state machine lives in
   * services/publication-orchestrator.ts (#904); this route is a thin adapter.
   *
   * The body carries `resume`, `skip_ci_check` and the S3 lock fields as before, and two fields
   * of an approval that is gated: `acknowledge_identifier_screen` (the identifier screen's
   * reason, ADR 0086) and `override_publication_review` (the review shown and the reasons shown,
   * ADR 0102).
   *
   * The body may name the request the run is for, `request_id` (#1579; ADR 0105, decision 7).
   *
   * The header `X-Approval-Dispatch-Token` is the proof that a call belongs to a web click's claim
   * (#1604; ADR 0105, decisions 3 to 6). A call that carries the token of the request's current
   * claim, while that claim's lease is live, is recorded as the administrator who clicked (the
   * caller is kept as `executed_by`); a call with no token (or a blank one) is its caller's own
   * act whatever the lease says, and once it passes every gate its mark takes the claim over, so
   * the executor the click dispatched is refused at its next call. A token that is stale or has
   * lapsed is refused and changes nothing, never downgraded to the caller. A call that carries a
   * valid token may not carry a decision (an override, an acknowledgment or `skip_ci_check: true`;
   * an explicit `false` is no decision): the click recorded the override and the acknowledgment.
   *
   * Refusals, each with a stable code in `error` and a sentence in `message`:
   *   403 origin_not_allowed  an override sent with a session cookie: it is accepted only with
   *                         an API key, and the website records one through approve-dispatch
   *                         (ADR 0102, section 8; ADR 0105, decision 10 keeps this stricter rule).
   *                         (A cookie request with no NEMAR origin never gets this far: the
   *                         router's `cookieOriginGuard` answers it with the same code.)
   *   409 request_mismatch  `request_id` is not the newest active request: it was denied or filed
   *                         again since the caller read it. Answered right after the 404 for no
   *                         request and before everything below, so nothing is recorded.
   *   409 request_blocked   the request is `blocked` and is not a run that started publishing
   *                         (the owner-name walk-back); whatever the flag says
   *   409 identifier_screen_not_clear  the identifier screen does not allow it (ADR 0086)
   *   409 publication_review_not_clear  the review does not allow it, with a `refusal` word and
   *                         the review's words (ADR 0102)
   *   409 dispatch_superseded  the token is not the request's current claim: it was replaced by
   *                         a newer click, released, taken over by an approval at a terminal, or
   *                         is not a token (also: the claim was replaced between the check and
   *                         the mark). Nothing was changed.
   *   409 dispatch_expired  the token is genuine, but its run sat idle past the 15 minute lease
   *   409 decision_with_dispatch_token  a call that carries a valid token sent an override, an
   *                         acknowledgment, a skipped CI check or the sandbox: nothing was
   *                         recorded under anybody (the sandbox is refused, never recorded)
   *   409 request_changed   the request was denied, blocked or withdrawn while the approval was checked:
   *                         nothing ran, and the request is read again
   *   409 approval_closed_during_run  the request was closed (denied, blocked again or filed
   *                         again) while the run ran, or when a resumed run whose steps are all
   *                         done found a request that is not `approving`: the steps HAVE run, the
   *                         request was not marked published, one audit row says so, and the
   *                         repair is by hand (the sentence says how)
   *
   * One refusal is retryable, and is not in the list above because its body is not
   * `{ error: <code>, message }`:
   *   500                   a call that carries a token could not tell why its mark changed
   *                         nothing, because the read that says (the claim's current instant)
   *                         failed: the orchestrator's `CLAIM_READ_FAILED_MESSAGE`. Nothing was
   *                         marked and nothing started, so the caller tries again. Its body is
   *                         `{ error: <sentence> }`, like the other 500s of this route, with no
   *                         code word (ADR 0105, decision 6).
   */
  admin.post("/publish/:id/approve", zValidator("json", approveSchema), async (c) => {
    const body = c.req.valid("json");
    // An override of the publication review is an administrator's own act, and a session cookie
    // rides along with any cross-site request a browser can be made to send, so it is accepted
    // only with an API key (ADR 0102; the one slice of #1603 this phase needs). The website records
    // one through approve-dispatch, which asks for a NEMAR origin. Phrased as "not a token", so an
    // unset `authMethod` fails closed.
    if (body.override_publication_review !== undefined && c.get("authMethod") !== "token") {
      return c.json(
        {
          error: "origin_not_allowed",
          message:
            "An override of the publication review is accepted only with an API key; the website records one through approve-dispatch.",
        },
        403,
      );
    }
    const result = await runPublicationApproval({
      db: c.env.DB,
      env: c.env,
      // Lazy closure: executionCtx is only touched if a step actually
      // schedules background work (test harnesses provide no executionCtx).
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      datasetId: c.req.param("id"),
      adminUser: c.get("user"),
      body,
      // The proof that this call belongs to a web click's claim (#1604). Never logged or echoed.
      dispatchToken: c.req.header(APPROVAL_DISPATCH_TOKEN_HEADER),
    });
    return c.json(result.body as never, (result.status ?? 200) as never);
  });

  /**
   * POST /admin/publish/:id/approve-dispatch - Launch an approval from the web
   * (ADR 0080).
   *
   * Approval is not one request: after the irreversible DOI publish, S3 Object
   * Lock runs in batches the CALLER must keep requesting, so a click cannot run
   * it inside one Worker invocation and the loop is deliberately not moved into
   * the Worker. This route claims the request, records WHO clicked, and hands
   * the run to an executor (a GitHub Actions workflow that drives the CLI)
   * through `repository_dispatch`, then answers 202 straight away. Closing the
   * page cannot matter: the state lives in `publication_requests`.
   *
   * The executor calls `POST /publish/:id/approve` with its own service key and the claim's
   * dispatch token (#1604; ADR 0105, decisions 1 to 3): the token, a MAC over this claim's
   * dataset, request, clicker and instant (`approval_dispatched_at`, as stored), is minted here
   * and handed to the executor in the dispatch payload. The orchestrator records the admin who
   * clicked, rather than the bot, for a call that presents it while the lease is live. `/approve`
   * is the contract for every executor, a terminal included: it also takes the review's override
   * in its body, and answers 403 origin_not_allowed for an override sent with a cookie, and the
   * 409s `request_blocked`, `request_changed`, `approval_closed_during_run`,
   * `dispatch_superseded`, `dispatch_expired`, `decision_with_dispatch_token` and
   * `publication_review_not_clear`, besides the identifier screen's own (see its docblock). The
   * executor sends no override: its run rides on the clicker's, recorded here before the
   * dispatch. The token is never logged, audited, listed or answered.
   *
   * A cookie request must come from a NEMAR origin and a bearer key is not asked: the admin
   * router's `cookieOriginGuard` decides that for every write, before this handler runs.
   *
   * Errors carry a stable code in `error` and a sentence in `message`:
   *   403 origin_not_allowed  a cookie request from a non-NEMAR origin (the router's guard)
   *   404 not_found         no active request for the dataset, or it stopped
   *                         being one (published or denied) before the claim
   *   409 not_dispatchable  the newest active request is `blocked`
   *   409 already_in_flight a run is live (services/approval-dispatch.ts), a
   *                         failed run inside its short grace window included
   *   409 identifier_screen_not_clear  the request's identifier screen does not
   *                         allow approval (epic #1610 phase 4): not run, not
   *                         reported, findings, a review with no reason, or a
   *                         verdict about a commit `main` has moved past
   *   409 publication_review_not_clear  the publication review does not allow
   *                         approval (ADR 0102): the gate refuses before the claim, with
   *                         a `refusal` word and the review's words, and an override that
   *                         is recorded is recorded after the head check (below)
   *   400 invalid_dataset_id  the id is not one the executor's workflow accepts for this
   *                         environment (`APPROVAL_DISPATCH_ID_RE`); refused before the body is
   *                         read and before anything is read or claimed (#1583, decision 8)
   *   400 invalid_body      the optional body is not `{ acknowledge_identifier_screen,
   *                         override_publication_review, request_id }`
   *   409 request_mismatch  the body's `request_id` is not the newest active request: it was
   *                         denied or filed again since the page read it (#1579, decision 7);
   *                         refused before the gates and the claim, so nothing is recorded
   *   502 dispatch_failed   GitHub answered 4xx, or a GitHub token could not be minted, or the
   *                         dispatch token could not be signed: nothing was sent, the claim is
   *                         released
   *   502 dispatch_unconfigured  the Worker has no GitHub credential, or no secret to sign the
   *                         dispatch token with; retrying cannot help. A missing secret is
   *                         answered before the claim (nothing is claimed or sent); a missing
   *                         credential releases the claim
   *   502 dispatch_unconfirmed   the call to GitHub dropped, timed out or was
   *                         answered 5xx: it MAY have started, so the lease is
   *                         KEPT (a retry is a 409 until it lapses) and an
   *                         `approval_dispatch_unconfirmed` audit row is written
   */
  admin.post("/publish/:id/approve-dispatch", async (c) => {
    const datasetId = c.req.param("id");
    const adminUser = c.get("user");
    const db = c.env.DB;
    const environment = approvalDispatchEnvironment(c.env);

    // The id is checked first, for this environment, before the body is read, before any read of
    // the request and before the claim (#1583, ADR 0105 decision 8). The workflow this dispatches
    // accepts only the ids of `APPROVAL_DISPATCH_ID_RE` and fails in its own validation for any
    // other, which would leave the claim's lease held for fifteen minutes on a run that never
    // started.
    if (!APPROVAL_DISPATCH_ID_RE[environment].test(datasetId)) {
      return c.json({ error: "invalid_dataset_id", message: INVALID_DATASET_ID_MESSAGE }, 400);
    }

    // The body is optional; it carries an acknowledgment of the identifier
    // screen (epic #1610 phase 4), the administrator's override of the
    // publication review (ADR 0102) and the request the click was for (#1579). No
    // body, or none that parses as JSON, is the bodyless click every existing
    // caller sends.
    let acknowledgment: string | undefined;
    let override: z.infer<typeof publicationReviewOverrideSchema> | undefined;
    let namedRequestId: number | undefined;
    const rawBody: unknown = await c.req.json().catch(() => undefined);
    if (rawBody !== undefined) {
      const parsed = dispatchBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          {
            error: "invalid_body",
            message: `The only fields this accepts are acknowledge_identifier_screen, a reason of ${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters, override_publication_review, the review shown and the reasons shown, and request_id, the request this click is for.`,
          },
          400,
        );
      }
      acknowledgment = parsed.data.acknowledge_identifier_screen;
      override = parsed.data.override_publication_review;
      namedRequestId = parsed.data.request_id;
    }

    const request = await db
      .prepare(
        `SELECT id, status, last_error, updated_at, identifier_screen_status,
                identifier_screen_report, identifier_screen_ack_at, identifier_screen_ack_by,
                steps_completed ${ACTIVE_REQUEST_TAIL_SQL}`,
      )
      .bind(datasetId)
      .first<{
        id: number;
        status: string;
        last_error: string | null;
        updated_at: string;
        identifier_screen_status: string | null;
        identifier_screen_report: string | null;
        identifier_screen_ack_at: string | null;
        identifier_screen_ack_by: number | null;
        steps_completed: string | null;
      }>();

    if (!request) {
      return c.json({ error: "not_found", message: "No active publication request found" }, 404);
    }
    // The request the click named is not the one in force: it was denied, or filed again, since
    // the page read it (#1579). Refused before the gates and the claim, so nothing the body
    // carries (an acknowledgment, an override) is recorded against the request that replaced it.
    if (namedRequestId !== undefined && namedRequestId !== request.id) {
      return c.json({ error: "request_mismatch", message: REQUEST_MISMATCH_MESSAGE }, 409);
    }
    if (request.status === "blocked") {
      return c.json(
        {
          error: "not_dispatchable",
          message:
            "This request is blocked. Resolve the block before dispatching an approval, or approve it from a terminal.",
        },
        409,
      );
    }

    // A request already `approving` has done part of the work, and some of it
    // cannot be undone: it resumes, it does not start over.
    const resume = request.status === "approving";

    // The identifier screen gate (ADR 0086), by the orchestrator's own rule: it
    // is skipped only for a run that has already started publishing. A run that
    // stopped before that (a failed ci_check leaves the row `approving`) is
    // gated like a fresh one, because the depositor may have pushed since.
    // A blocked request never gets here (refused above), so the reason is not asked.
    const gated = publishingStanding({ ...request, block_reason: null }) !== "publishing";

    // The state half: no network and no claim, so a refused click changes
    // nothing. The head half needs a GitHub token and runs once one is in hand,
    // below. A reason recorded earlier counts only for the admin who gave it.
    let review: ReviewGateResult = { ok: true, state: "off" };
    if (gated) {
      const stateGate = screenStateGate(
        datasetId,
        request,
        acknowledgment !== undefined,
        adminUser.id,
      );
      if (!stateGate.ok) return c.json(stateGate.refusal, 409);
      // The publication review's gate (ADR 0102) is asked next, still before the
      // claim, so a refusal claims nothing and changes nothing. It reads no GitHub
      // and writes nothing: only the OVERRIDE it says to record waits, until the head
      // check below has passed, so it is recorded last, only after every gate has passed.
      // (The screen's acknowledgment is recorded when the screen gate passes,
      // on its own, and stands whether or not the review then refuses.)
      // `requireRow`: the executor that follows reads the clicker's override off the
      // review row, so an override with no row to hold it cannot be carried.
      review = await evaluateApprovalReviewGate(c.env, {
        requestId: request.id,
        datasetId,
        approverId: adminUser.id,
        override,
        requireRow: true,
      });
      if (!review.ok) return c.json(review.body, 409);
    }

    // The claim's token is signed with the callback secret, and the claim is made only when there is
    // one to sign with: a click that cannot be given a token would dispatch a run that is refused
    // at its first call (a token that cannot be checked is never honored) or recorded as the
    // executor's own act, which is exactly what the website's Approve button must not do. So the
    // misconfiguration is answered here, before anything is claimed or sent, and says not to retry.
    const signingSecret = c.env.PRESCREEN_CALLBACK_SECRET;
    if (!signingSecret) {
      console.error(`[approve-dispatch] no signing secret configured for ${datasetId}`);
      return c.json(
        {
          error: "dispatch_unconfigured",
          message:
            "This server has no secret configured to sign web approvals, so an approval cannot be dispatched from the web. Retrying will not help. Approve from a terminal, and ask an administrator to fix the configuration.",
        },
        502,
      );
    }

    // One conditional UPDATE is the claim: D1 runs it atomically, so two
    // simultaneous clicks cannot both see the row idle. `updated_at` is left
    // alone on purpose. It is the orchestrator's progress heartbeat, and
    // bumping it here would make a failed dispatch read as a live run for the
    // whole lease on an `approving` row.
    //
    // `last_error` is cleared: a new attempt begins, and the previous attempt's
    // error is history. It has to be cleared HERE and not only when `/approve`
    // starts, because a failed run's error would otherwise sit on the row
    // between the claim and the executor's first call, and the predicate would
    // read the freshly dispatched run as failed and let a second click through.
    // The release below puts it back if nothing was sent.
    //
    // `RETURNING` hands back the claim's instant exactly as the row now stores it
    // (`datetime('now')`, a string at one second): the token is signed over THAT value, never a
    // recomputed one, because the executor's calls and the release endpoint verify it against the
    // stored column. No row back is a lost claim.
    const claimed = await db
      .prepare(
        `UPDATE publication_requests
           SET approval_requested_by = ?, approval_dispatched_at = datetime('now'),
               last_error = NULL
         WHERE id = ? AND status IN ('requested', 'approving') AND NOT ${approvalInFlightSql()}
         RETURNING approval_dispatched_at AS claimed_at`,
      )
      .bind(adminUser.id, request.id)
      .first<{ claimed_at: string }>();

    if (!claimed) {
      // The claim refuses for two different reasons, and the page must be told
      // the true one. A run may be live (the lease), or the request may have
      // stopped being one that can run in the moments since it was read here:
      // approved by someone else, denied, or blocked. "Already running" for a
      // request that is already published would send the admin looking for a
      // run that does not exist.
      const now = await db
        .prepare("SELECT status FROM publication_requests WHERE id = ?")
        .bind(request.id)
        .first<{ status: string }>();
      if (!now || now.status === "published" || now.status === "denied") {
        return c.json({ error: "not_found", message: "No active publication request found" }, 404);
      }
      if (now.status === "blocked") {
        return c.json(
          {
            error: "not_dispatchable",
            message:
              "This request is blocked. Resolve the block before dispatching an approval, or approve it from a terminal.",
          },
          409,
        );
      }
      return c.json(
        {
          error: "already_in_flight",
          message: "An approval is already running for this dataset.",
        },
        409,
      );
    }
    const claimedAt = claimed.claimed_at;

    // Release the claim so the admin can try again at once rather than wait out
    // the lease. Only ever done for a failure that is DEFINITELY "not sent", so
    // the row goes back to how it was. `AND approval_requested_by = ?` and
    // `AND approval_dispatched_at = ?` make it clear only THIS click's claim: a claim another
    // click made in the meantime, even the same administrator's a moment later, has another
    // instant and another token, and is never undone by this click's failure. The error the claim
    // cleared is restored only while `updated_at` still holds the value read
    // before the claim: `/approve` bumps it as it starts, so a changed `updated_at` means a
    // run began in the meantime (a person's terminal), and restoring the old
    // error over its fresh state would make that live run read as failed after
    // the grace window. If even the release fails the lease lapses by itself,
    // which errs toward refusing a retry, never toward a second run.
    const releaseClaim = async (): Promise<void> => {
      try {
        await db
          .prepare(
            `UPDATE publication_requests
               SET ${APPROVAL_CLAIM_CLEAR_SQL},
                   last_error = CASE WHEN updated_at = ? THEN COALESCE(last_error, ?)
                                     ELSE last_error END
             WHERE id = ? AND approval_requested_by = ? AND approval_dispatched_at = ?`,
          )
          .bind(request.updated_at, request.last_error, request.id, adminUser.id, claimedAt)
          .run();
      } catch (releaseErr) {
        console.error(
          `[approve-dispatch] could not release the claim on request ${request.id}:`,
          errorMessage(releaseErr),
        );
      }
    };

    // Everything from here to the dispatch can throw (a database fault on an acknowledgment or
    // override write, a lookup that rejects): the claim is released on every such exit, so a
    // click that was never sent does not hold the lease for fifteen minutes. From the moment
    // the dispatch is attempted the claim is kept on any throw, because the event may already be
    // queued and releasing would let a second click start a second run beside it.
    let dispatchAttempted = false;
    try {
      // The token the executor presents on every `/approve` call of this run: a MAC over this
      // claim's dataset, request, clicker and instant (#1604, ADR 0105 decision 1). It is handed to
      // the dispatch and to nothing else: never logged, audited, listed or answered. A claim that
      // cannot be signed (the signer refuses a field that holds a line break) was not sent, so it is
      // released.
      let dispatchToken: string;
      try {
        dispatchToken = await signApprovalDispatchToken(
          { datasetId, requestId: request.id, clickerId: adminUser.id, claimedAt },
          signingSecret,
        );
      } catch (err) {
        console.error(
          `[approve-dispatch] could not sign the dispatch token for ${datasetId}:`,
          errorMessage(err),
        );
        await releaseClaim();
        return c.json(
          {
            error: "dispatch_failed",
            message: "The approval could not be started. Nothing was changed; try again.",
          },
          502,
        );
      }

      // 1. A credential. Absent entirely is a configuration fault that retrying
      // cannot fix, so it has its own code; failing to MINT one (an App token
      // request GitHub refused) is transient and is an ordinary failed dispatch.
      // Neither sent anything, so both release.
      let auth: ReturnType<typeof getDatasetsAuth>;
      try {
        auth = getDatasetsAuth(c.env);
      } catch (err) {
        console.error(
          `[approve-dispatch] no GitHub credential for ${datasetId}:`,
          errorMessage(err),
        );
        await releaseClaim();
        return c.json(
          {
            error: "dispatch_unconfigured",
            message:
              "This server has no GitHub credential configured, so an approval cannot be dispatched from the web. Retrying will not help. Approve from a terminal, and ask an administrator to fix the configuration.",
          },
          502,
        );
      }
      let pat: string;
      try {
        pat = auth.kind === "app" ? await auth.getToken() : auth.token;
      } catch (err) {
        console.error(
          `[approve-dispatch] could not obtain a GitHub token for ${datasetId}:`,
          errorMessage(err),
        );
        await releaseClaim();
        return c.json(
          {
            error: "dispatch_failed",
            message: "The approval could not be started. Nothing was changed; try again.",
          },
          502,
        );
      }

      // The identifier screen, content half (epic #1610 phase 4): the screened
      // commit must still be `main`, and a lookup that fails refuses (fail
      // closed). Nothing has been sent, so a refusal releases the claim. A
      // reason given for a screen that needs one is recorded only once this has
      // passed, so it attaches to the verdict the admin was shown.
      if (gated) {
        const headGate = await verifyScreenHead(c.env, datasetId, request, pat);
        if (!headGate.ok) {
          await releaseClaim();
          return c.json(headGate.refusal, 409);
        }
        if (
          acknowledgment !== undefined &&
          screenGate(readStoredState(request.identifier_screen_status)) === "acknowledge"
        ) {
          const recorded = await recordScreenAcknowledgment(db, {
            requestId: request.id,
            datasetId,
            adminUserId: adminUser.id,
            reason: acknowledgment,
            state: request.identifier_screen_status as string,
          });
          if (!recorded) {
            await releaseClaim();
            return c.json(
              {
                error: "identifier_screen_not_clear",
                gate: "wait",
                headline: "Identifier screen: changed",
                message:
                  "The identifier screen's result changed while this approval was being checked. Read it again before approving.",
              },
              409,
            );
          }
        }
        // The override the review gate asked to record, last, now that the screened commit
        // is still `main`: it attaches to content that is still the content being published,
        // and is recorded only after every gate has passed. It can remain on its row, bound to
        // that review, those reasons and its approver, when the dispatch then fails or goes
        // unconfirmed. The screen's acknowledgment above was recorded when its own check passed
        // and does not depend on this one. Still before the dispatch, so the executor's run
        // finds it on the row. A row that moved since the gate read it refuses, and nothing has
        // been sent.
        if (review.ok && review.state === "enforced" && review.record !== null) {
          const recorded = await recordApprovalOverride(c.env, {
            requestId: request.id,
            datasetId,
            approverId: adminUser.id,
            via: "approve-dispatch",
            outcome: review.outcome,
            headSha: review.headSha,
            record: review.record,
          });
          if (!recorded.ok) {
            await releaseClaim();
            return c.json(recorded.body, 409);
          }
        }
      }

      // The audit row for this click's dispatch. A missing row must never change
      // what the admin is told about a run, so a failed write is only logged.
      const audit = async (action: string, extra: Record<string, unknown> = {}): Promise<void> => {
        try {
          await auditLogStatement(db, {
            userId: adminUser.id,
            action,
            resourceType: "dataset",
            resourceId: datasetId,
            details: JSON.stringify({ request_id: request.id, resume, environment, ...extra }),
          }).run();
        } catch (auditErr) {
          console.error(
            `[approve-dispatch] audit write failed (${action}) for ${datasetId}:`,
            errorMessage(auditErr),
          );
        }
      };

      // 2. The dispatch itself. GitHub refusing the request (a 4xx) means nothing
      // was sent: release. Anything else means UNKNOWN: a dropped connection, a
      // timeout, or a 5xx from GitHub's edge, any of which can follow an event that
      // was already queued. Releasing then would let the next click start a second
      // run beside it. KEEP the lease; it lapses on its own if nothing started, and
      // the audit row records that a run may exist that the lease alone would not
      // explain.
      dispatchAttempted = true;
      try {
        await triggerApprovePublication(
          datasetId,
          request.id,
          resume,
          environment,
          pat,
          dispatchToken,
        );
      } catch (err) {
        console.error(`[approve-dispatch] dispatch failed for ${datasetId}:`, errorMessage(err));
        if (err instanceof DispatchRejectedError && err.definitelyNotSent) {
          await releaseClaim();
          return c.json(
            {
              error: "dispatch_failed",
              message: "The approval could not be started. Nothing was changed; try again.",
            },
            502,
          );
        }
        await audit("approval_dispatch_unconfirmed", {
          // The status only: never GitHub's body, which the error text carries.
          reason: err instanceof DispatchRejectedError ? `http_${err.httpStatus}` : "no_answer",
        });
        return c.json(
          {
            error: "dispatch_unconfirmed",
            message:
              "GitHub did not confirm the request. It may have started; check again in a few minutes before trying again.",
          },
          502,
        );
      }

      // The run is already launched; a missing audit row must not report the
      // launch as failed (`audit` only logs).
      await audit("approval_dispatched");

      return c.json(
        { status: "dispatched", dataset_id: datasetId, request_id: request.id, resume },
        202,
      );
    } catch (err) {
      if (!dispatchAttempted) {
        console.error(
          `[approve-dispatch] an unexpected failure after the claim on request ${request.id}:`,
          errorMessage(err),
        );
        await releaseClaim();
      }
      throw err;
    }
  });

  /**
   * POST /admin/publish/:id/identifier-screen - Re-run the identifier screen
   * of the dataset's active request (epic #1610, phase 4).
   *
   * For a screen that did not run, did not report, or read a commit `main`
   * has since moved past: the approval gate refuses all three and names this
   * route. Same dispatch and failure handling as a new request, so the admins
   * are mailed when it reports, or at once when it cannot start. Every screen
   * column is reset in the claim, an earlier acknowledgment included.
   *
   *   202 { status: "pending" | "error", identifier_screen }
   *   400 identifier_screen_not_applicable  a sandbox (xx) dataset
   *   404 not_found             no active request
   *   403 origin_not_allowed    a cookie request from a non-NEMAR origin (the router's guard)
   *   409 approval_in_progress  the request's approval has started publishing;
   *                             it passed the screen when it started
   *   409 identifier_screen_pending  a screen dispatched under
   *                             SCREEN_REPORT_DEADLINE_MINUTES ago has not reported
   *
   * The body is optional (none, or an empty one, is a single screen): `{ batch_id }` makes this one screen of a paced re-screen
   * (`services/screen-batch.ts`, `nemar admin repo publish screen-batch`). The dispatch, the stored
   * result, the gate and the review are the same; what differs is the mail: no per-request mail to
   * the administrators and none to the depositor, because the batch sends one digest that names it.
   * Every answer that means this request will never report (a refusal, a screen that could not
   * start) counts as settled for the batch, once, so a digest is never waiting on it. A single
   * screen of a request that an open batch dispatched settles that batch's entry as screened
   * again outside it.
   *   400 body_invalid                      not JSON, or a key other than `batch_id`, or a bad id
   *   400 not_in_batch                      the dataset is not in the batch
   *   404 screen_batch_not_found
   *   409 screen_batch_closed               its digest has already been sent
   *   409 already_screened                  this batch already screened and counted the request;
   *                                         nothing is settled
   */
  admin.post("/publish/:id/identifier-screen", async (c) => {
    const datasetId = c.req.param("id");
    const adminUser = c.get("user");
    const db = c.env.DB;

    // The optional body: no bytes is no body, and anything else must be exactly `{ batch_id? }`,
    // so a mistyped key is refused and not read as a single screen.
    const rawBody = await c.req.text();
    let batchId: number | null = null;
    if (rawBody.trim() !== "") {
      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        json = undefined;
      }
      const parsed = identifierScreenBodySchema.safeParse(json);
      if (!parsed.success) {
        return c.json(
          {
            error: "body_invalid",
            message: 'The body, when there is one, is {"batch_id": <a positive whole number>}.',
          },
          400,
        );
      }
      batchId = parsed.data.batch_id ?? null;
    }
    let batchRequestId: number | null = null;
    if (batchId !== null) {
      const batch = await readScreenBatch(c.env, batchId);
      if (!batch) {
        return c.json({ error: "screen_batch_not_found", message: "No such screen batch." }, 404);
      }
      if (batch.digestSent) {
        return c.json(
          {
            error: "screen_batch_closed",
            message: "This batch has finished and its digest was sent. Start a new batch.",
          },
          409,
        );
      }
      const entry = batch.selection.find((e) => e[1] === datasetId);
      if (!entry) {
        return c.json({ error: "not_in_batch", message: "This dataset is not in the batch." }, 400);
      }
      batchRequestId = entry[0];
    }
    // The batch is waiting on this dataset: every way out below that is not a dispatch records
    // why, once (`settleBatchRefusal`), and a screen that could not start settles its request
    // (`settleBatchEntry`).
    const refused = async (reason: ScreenBatchRefusal): Promise<void> => {
      if (batchId !== null) await settleBatchRefusal(c.env, batchId, datasetId, reason);
    };

    if (isScreenExempt(datasetId)) {
      return c.json(
        {
          error: "identifier_screen_not_applicable",
          message: "Sandbox (xx) datasets never publish real data and are not screened.",
        },
        400,
      );
    }
    const request = await db
      .prepare(
        `SELECT id, status, steps_completed, identifier_screen_batch_id AS batch,
                identifier_screen_batch_settled_at AS batch_settled ${ACTIVE_REQUEST_TAIL_SQL}`,
      )
      .bind(datasetId)
      .first<{
        id: number;
        status: string;
        steps_completed: string | null;
        batch: number | null;
        batch_settled: string | null;
      }>();
    if (!request) {
      await refused("no-request");
      return c.json({ error: "not_found", message: "No active publication request found" }, 404);
    }
    if (batchRequestId !== null && request.id !== batchRequestId) {
      // The request the batch selected was withdrawn, denied or replaced since.
      await refused("request-changed");
      return c.json(
        {
          error: "batch_request_changed",
          message:
            "The request this batch selected is no longer the dataset's active request, so it was not screened.",
        },
        409,
      );
    }
    if (batchId !== null && request.batch === batchId && request.batch_settled !== null) {
      // This batch already screened the request and counted it: a second dispatch would count it
      // twice, so it is refused and nothing is settled.
      return c.json(ALREADY_SCREENED, 409);
    }
    if (request.status === "approving" && hasStartedPublishing(request.steps_completed)) {
      await refused("publishing-started");
      return c.json(APPROVAL_IN_PROGRESS, 409);
    }
    const dataset = await db
      .prepare("SELECT github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ github_repo: string | null }>();

    let started: Awaited<ReturnType<typeof startIdentifierScreen>>;
    try {
      started = await startIdentifierScreen(
        c.env,
        { requestId: request.id, datasetId, githubRepo: dataset?.github_repo ?? null },
        // A batch's claim also loses to a screen the batch has already counted, atomically: a
        // settle that lands between the read above and this statement cannot be dispatched over.
        batchId === null ? RERUN_GUARD_SQL : `${RERUN_GUARD_SQL}${batchClaimGuardSql(batchId)}`,
        batchId,
      );
    } catch (err) {
      console.error(`[identifier-screen] re-run for ${datasetId} failed:`, errorMessage(err));
      await refused("write-failed");
      return c.json(
        {
          error: "identifier_screen_rerun_failed",
          message: "The screen could not be started: the database refused the write. Try again.",
        },
        500,
      );
    }
    if (started === null) {
      // The claim's guard refused. It has two halves, and the admin must be told
      // the true one: the request may have stopped being active (or started
      // publishing) since it was read, or a recent screen is still running.
      const now = await db
        .prepare(
          `SELECT status, steps_completed, identifier_screen_batch_id AS batch,
                  identifier_screen_batch_settled_at AS batch_settled
             FROM publication_requests WHERE id = ?`,
        )
        .bind(request.id)
        .first<{
          status: string;
          steps_completed: string | null;
          batch: number | null;
          batch_settled: string | null;
        }>();
      if (batchId !== null && now?.batch === batchId && now.batch_settled !== null) {
        // The claim lost to a result this batch had just counted: nothing is settled again.
        return c.json(ALREADY_SCREENED, 409);
      }
      // A repeated call for a request this batch already dispatched finds its screen pending:
      // that screen is still the batch's to wait for, so it is not settled a second time.
      if (batchId === null || now?.batch !== batchId) {
        await refused(
          !now || !["requested", "blocked", "approving"].includes(now.status)
            ? "no-request"
            : now.status === "approving" && hasStartedPublishing(now.steps_completed)
              ? "publishing-started"
              : "screen-running",
        );
      }
      if (!now || !["requested", "blocked", "approving"].includes(now.status)) {
        return c.json({ error: "not_found", message: "No active publication request found" }, 404);
      }
      if (now.status === "approving" && hasStartedPublishing(now.steps_completed)) {
        return c.json(APPROVAL_IN_PROGRESS, 409);
      }
      return c.json(
        {
          error: "identifier_screen_pending",
          message: `A screen of this request was dispatched less than ${SCREEN_REPORT_DEADLINE_MINUTES} minutes ago and has not reported yet. The admins are mailed when it does; if it never does, it is marked unreported and can be re-run then.`,
        },
        409,
      );
    }
    // The screen replaced whatever the request carried: an open batch that had dispatched it
    // (this one on a second dispatch of an unsettled screen excepted) is told it was screened again.
    if (request.batch !== null && request.batch !== batchId) {
      await settleBatchRefusal(
        c.env,
        request.batch,
        datasetId,
        "rescreened",
        request.batch_settled !== null,
      );
    }
    if (batchId !== null) {
      // The digest covers the mail of a screen that could not start, and the batch is no longer
      // waiting on it; a dispatched one reports through the callback, which settles it.
      if (started.kind === "failed") await settleBatchEntry(c.env, batchId, request.id);
      else await noteBatchDispatch(c.env, batchId);
    } else if (started.kind === "failed") {
      await notifyAdminsOfScreen(c.env, request.id);
    }
    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "identifier_screen_rerun",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({
          request_id: request.id,
          outcome: started.kind,
          ...(batchId === null ? {} : { batch_id: batchId }),
        }),
      }).run();
    } catch (auditErr) {
      console.error(
        `[identifier-screen] audit write for the re-run of ${datasetId} failed:`,
        errorMessage(auditErr),
      );
    }

    const row = await db
      .prepare(
        "SELECT identifier_screen_status, identifier_screen_report FROM publication_requests WHERE id = ?",
      )
      .bind(request.id)
      .first<{
        identifier_screen_status: string | null;
        identifier_screen_report: string | null;
      }>();
    return c.json(
      {
        dataset_id: datasetId,
        request_id: request.id,
        status: started.kind === "dispatched" ? "pending" : "error",
        identifier_screen: screenView(
          datasetId,
          row?.identifier_screen_status,
          row?.identifier_screen_report,
        ),
      },
      202,
    );
  });

  /**
   * POST /admin/datasets/:id/s3-lock - Apply S3 Object Lock to dataset
   *
   * Streamed via S3 ListObjectsV2 continuation tokens — see
   * `applyObjectLockBatch` for the per-invocation subrequest contract.
   *
   * With `objects` (at most `OBJECT_LOCK_BATCH_SIZE` annex keys), it locks exactly those objects
   * under `<id>/objects/`, at their current versions, and names each version it locked
   * (`lockObjectKeys`): an upstream re-pull's release locks what its copy and uploads wrote, not
   * the whole prefix (ADR 0111, decision 8). Either way a 403 counts as locked only when the
   * object's retention, read back, is a lock this route sets.
   */
  admin.post("/datasets/:id/s3-lock", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const body = (await c.req.json().catch(() => ({}))) as {
      continuation_token?: string;
      objects?: unknown;
    };

    const dataset = await db
      .prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (body.objects !== undefined) {
      const objects = body.objects;
      if (
        !Array.isArray(objects) ||
        objects.length === 0 ||
        objects.length > OBJECT_LOCK_BATCH_SIZE ||
        body.continuation_token !== undefined ||
        !objects.every((k) => typeof k === "string" && LOCKABLE_KEY_RE.test(k) && !k.includes(".."))
      ) {
        return c.json(
          {
            error: `objects must be 1 to ${OBJECT_LOCK_BATCH_SIZE} annex keys, without a continuation_token`,
          },
          400,
        );
      }
      try {
        const result = await lockObjectKeys(getS3Config(c.env), datasetId, objects as string[]);
        return c.json({
          message: result.failed.length === 0 ? "Objects locked" : "Some objects failed",
          dataset_id: datasetId,
          locked: result.locked,
          failed: result.failed,
          objects: result.objects,
          hasMore: false,
        });
      } catch (err) {
        return c.json({ error: `S3 lock failed: ${errorMessage(err)}` }, 500);
      }
    }

    try {
      const result = await applyObjectLockBatch(
        getS3Config(c.env),
        datasetId,
        body.continuation_token,
      );

      return c.json({
        message: result.failed.length === 0 ? "Batch locked" : "Some objects failed",
        dataset_id: datasetId,
        locked: result.locked,
        failed: result.failed.map((f) => ({ key: f.key, error: f.error })),
        hasMore: result.hasMore,
        continuation_token: result.nextContinuationToken,
      });
    } catch (err) {
      const msg = errorMessage(err);
      return c.json({ error: `S3 lock failed: ${msg}` }, 500);
    }
  });
}
