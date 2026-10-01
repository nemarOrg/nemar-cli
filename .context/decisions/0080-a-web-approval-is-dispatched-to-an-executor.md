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
   or a runner. Nothing about `/approve` changes.
2. **`POST /admin/publish/:id/approve-dispatch` is the web entry.**
   It claims the request with one conditional UPDATE, records the clicking admin,
   dispatches `repository_dispatch[approve-publication]` to `nemarDatasets/.github`,
   and answers 202.
   Today the one executor behind it is a workflow in that repository that runs
   `nemar admin publish approve` on a GitHub runner, the same pattern as `onboard-openneuro.yml`.
   `nemaring.ucsd.edu` is not an executor: it hosts other services and stays that way.
   The only code that knows GitHub is `triggerApprovePublication`; the route, the claim and the
   lease are executor-agnostic, so a second executor changes the dispatch and nothing else.
3. **The payload names an environment, never a URL or a credential.**
   `{ dataset_id, request_id, resume, environment }`, where `environment` is `production`
   only for the production Worker and `dev` for everything else, including an unset value.
   The central repository is shared by every environment, so the workflow maps the name to an API
   origin and a secret from a table of its own, and an admin key cannot be steered to a host the payload chose.
4. **A lease keeps it to one run at a time.**
   A request is in flight when it was dispatched within 15 minutes, or is `approving`
   with an `updated_at` within 15 minutes, and can still run (`requested` or `approving`).
   The second clause is what lets a person's terminal run block a web launch,
   since a terminal approval never sets `approval_dispatched_at`.
   One SQL expression (`approvalInFlightSql`) is both the claim's WHERE clause and the list route's
   `approval_in_flight` field, so a page never offers a button the route would refuse
   and no client hard-codes the minutes.
5. **Attribution forks.**
   The orchestrator reads `approval_requested_by` from the request it acts on.
   When it is set, that admin is the approver: `approved_by`, the `dataset_published` audit row and the
   `notify_user_failed` audit row name them, and the executing account is kept as `executed_by` in the
   details. When it is null, which is every terminal approval, the caller is the approver and the
   audit row is byte-identical to what it was.

## Consequences

Closing the page no longer matters: the state is in `publication_requests`,
and `current_step` / `last_error` already say where a run is.
The Worker spends one GitHub call per approval; the loop's cost is on the runner.
The CLI is unaffected.

Harder, and honest about it:

- **A failed run keeps its lease until it lapses.** Nothing in the schema says an executor stopped,
  so a run that dies at minute 3 blocks a web retry until minute 15.
  A terminal approval is not gated by the lease, so an admin in a hurry uses that.
- **A refusal before the step loop leaves no trace on the row.**
  The pre-loop gates (sandbox dataset, an owner with no real name, an outdated client) answer an error
  but write no `last_error`, so a dispatch the workflow's CLI run refuses reads as "queued, then stalled",
  and the reason is in the workflow's log.
- **The latest dispatch owns the attribution.** Each dispatch records who launched it.
  If a web run crashes and a person later resumes it from a terminal, `approval_requested_by` still names
  the original clicker, who did authorize it; `executed_by` names the person who finished it.
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
