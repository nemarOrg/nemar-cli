# ADR 0080: A web approval is dispatched to an executor; the backend route is the contract, and the approver is whoever clicked

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

Approving a publication is not one request.
`POST /admin/publish/:id/approve` runs the sixteen-step orchestrator,
and its S3 Object Lock step (step 14, after the irreversible `publish_doi`)
works in batches of 100 objects: each call locks one page and returns `hasMore`
with a continuation token that the CALLER must send back.
The CLI drives that loop, with retries across fresh Worker invocations and `--resume`.
That is deliberate: running the whole loop inside Cloudflare Workers would cost more
than the platform should spend on it, so the work lives with the caller.

The website's Approve button sent one `{}` and reloaded.
For any dataset over 100 files that stops at `approving`, after the DOI is public:
the repository is public and the DOI published, but nothing is locked,
the catalog is not synced and the owner is not told,
and an `approving` row offers no button to continue from.
(Until the list page was fixed it also crashed on any row, so the button could not be reached.
Fixing the page is what made this reachable.)
"Do not close the page" would not have been a fix: the page is not what finishes the run.

Web approvals are going to matter more, so they need a stable pipeline of their own.
Two constraints shape it.
The backend route has to stay the contract, so that no single executor becomes a dependency of the platform.
And a web click and a terminal approval must both be recorded truthfully,
which a service-key executor would otherwise erase: it would be the "approver" of every web approval.

## Decision

The website does not run an approval. It asks the backend to dispatch one.

1. **`/approve` stays the contract, and the loop stays on the caller's side.**
   An executor is anything that drives `/approve` to completion: a person's terminal,
   or a runner. Its request and response contract is unchanged.
   (The orchestrator now reads `approval_requested_by` from the request it acts on,
   and starts each attempt by clearing `last_error`; neither is visible to a caller.)
2. **`POST /admin/publish/:id/approve-dispatch` is the web entry.**
   It claims the request with one conditional UPDATE, records the clicking admin,
   dispatches `repository_dispatch[approve-publication]` to `nemarDatasets/.github`,
   and answers 202.
   Today the one executor behind it is a workflow in that repository that runs
   `nemar admin publish approve` on a GitHub runner, the same pattern as `onboard-openneuro.yml`.
   `nemaring.ucsd.edu` is not an executor: it hosts other services and stays that way.
   The only code that knows GitHub is `triggerApprovePublication`; the route, the claim and the
   lease are executor-agnostic, so a second executor changes the dispatch and nothing else.
   A cookie request needs a NEMAR `Origin` (`origin_not_allowed`), because the route launches an
   irreversible publication; a bearer key, which a terminal and the workflow use, is not asked for one.
3. **The payload names an environment, never a URL or a credential.**
   `{ dataset_id, request_id, resume, environment }`, where `environment` is `production`
   only for the production Worker and `dev` for everything else, including an unset value.
   The central repository is shared by every environment, so the workflow maps the name to an API
   origin and a secret from a table of its own, and an admin key cannot be steered to a host the payload chose.
4. **A lease keeps it to one run at a time.**
   A request is in flight when it can still run (`requested` or `approving`) and either it was
   dispatched within 15 minutes, or it is `approving` with an `updated_at` within 15 minutes.
   The second clause is what lets a person's terminal run block a web launch,
   since a terminal approval never sets `approval_dispatched_at`.
   One SQL expression (`approvalInFlightSql`) is both the claim's WHERE clause and the list route's
   `approval_in_flight` field, so a page never offers a button the route would refuse
   and no client hard-codes the minutes.
   **A run that failed stalls after a grace window, not at once.**
   The orchestrator records a failed step in `last_error`; the run then counts as in flight for 60 seconds
   and as stalled after that, so the page can offer Resume without waiting out the lease.
   Not at once, because the CLI retries a failed step after 10 seconds (up to five times), and an executor
   launched in that wait would run beside the retry about to start; a test holds the grace above the CLI's
   exported retry delay. The dispatch claim and the start of every `/approve` attempt clear `last_error`
   (the previous attempt's error is history), so a restart or a fresh dispatch is in flight again at once,
   and a dispatch that is not sent puts the error back.
5. **Attribution forks, and a click is honored only while its run is live.**
   The orchestrator reads `approval_requested_by` from the request it acts on.
   While the lease is live (the time-only lease, read at the top of `/approve`, before that call's own
   heartbeat bump), that admin is the approver: `approved_by`, the `dataset_published` audit row and the
   `notify_user_failed` audit row name them, and the executing account is kept as `executed_by` in the
   details. Otherwise, which includes every terminal approval, the caller is the approver and the
   audit row is byte-identical to what it was.
   The column is never cleared, so without the lease a run that lapsed and was resumed by a different admin
   at a terminal would be recorded as the original clicker's. Attribution reads the time-only lease rather
   than the failure-aware predicate above, so a failure does not strip the clicker from the retry that
   finishes the run.
6. **A dispatch whose answer is lost keeps the lease.**
   GitHub may have accepted the event and lost only the reply, and releasing the claim then would let the next
   click start a second run. The claim is released only for a failure that is definitely not sent: no
   credential (`dispatch_unconfigured`, and retrying will not help), a token that cannot be minted, or
   GitHub answering non-2xx (`dispatch_failed`). A dropped connection or the 10 second timeout answers
   `dispatch_unconfirmed` and the lease stands until it lapses.

## Consequences

Closing the page no longer matters: the state is in `publication_requests`,
and `current_step` / `last_error` already say where a run is.
The Worker spends one GitHub call per approval; the loop's cost is on the runner.
The CLI's behavior is unchanged.

Harder, and honest about it:

- **A web run that sat quiet longer than the lease before its first `/approve` call is recorded under the
  executing key.** A runner queued for more than 15 minutes, or a dispatch that only starts after a long
  outage, loses the clicker: attribution is honored only while the lease is live. `executed_by` is then
  absent because there is nothing to fork, and the dispatch's own `approval_dispatched` audit row still
  names the clicker by id.
- **A refusal before the step loop does not read as a failure.** The gates after the request flips to
  `approving` behave differently, and only some leave a trace:
  an owner with no real name walks the row back to `blocked` with a `block_reason`;
  the sandbox, no-repository, dataset-not-found and invalid-repository answers (400, 404, 500) return with the
  row left at `approving`, a fresh `updated_at` and no `last_error`, so the page reads "running" for the lease
  although nothing is running; only the 426 outdated-client answer returns before the row is touched.
  The reason is in the workflow's log.
- **A workflow failure the backend cannot see stays invisible.** A missing secret or an install failure means
  `/approve` is never called, so nothing is written and the lease lapses on its own. Closing that needs a
  release or callback endpoint the workflow reports to, the way the pre-screen workflow reports through a
  callback token. This is a follow-up, not part of this change.
- **A dispatch that GitHub never confirmed holds the lease for up to 15 minutes**, so a retry is a 409 until
  it lapses, even when the event was in fact never created. A terminal approval is not gated by the lease,
  so an admin in a hurry uses that.
- **The web path depends on GitHub being able to start a workflow.**
  A refused dispatch releases the claim and answers 502, and the terminal path is the fallback.

## Alternatives considered

- **Run the loop in the Worker** (a longer request, or `waitUntil`). Rejected on cost, which is why the
  loop is on the caller in the first place, and because a single invocation's subrequest budget is exactly
  what the batching exists to respect.
- **A queue or a Durable Object.** New infrastructure on the same platform, with the cost and lock-in
  the decision is trying to avoid.
- **The browser drives the loop**, as the CLI does. It would need the page open for the whole run, which is
  the dependency this removes, and a reload mid-run would be a second driver racing the first.
- **A pull model**, where executors claim queued approvals themselves. It would make executors fully
  interchangeable, and the claim columns would support it unchanged; it is not built because there is one
  executor and a push dispatch already exists in this repository. Revisit when there is a second.
- **Record the executor as the approver.** Simplest, and wrong: every web approval would be attributed to a bot.

## Receipts

- nemarOrg/website#200, "Approve blocks on a 16-step orchestrator; make it non-blocking".
- `shared/publication-steps.ts` for the step order; `backend/src/services/publication-orchestrator.ts` for
  the s3_lock `hasMore` return; `src/lib/api/publish.ts` (`approvePublication`) for the caller's loop.
- `nemarDatasets/.github/.github/workflows/onboard-openneuro.yml`, the precedent for running the CLI on a runner.
- Migration `0090_approval_dispatch.sql`; `backend/src/services/approval-dispatch.ts`.
