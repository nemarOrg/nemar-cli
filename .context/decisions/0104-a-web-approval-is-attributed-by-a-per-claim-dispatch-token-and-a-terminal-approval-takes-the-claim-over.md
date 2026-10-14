# ADR 0104: A web approval is attributed by a per-claim dispatch token, and a terminal approval takes the claim over

**Status:** proposed
**Date:** 2026-10-13
**Owner:** Seyed Yahya Shirazi

Epic #1726, Phase 3 (#1730).
Partially supersedes decision 5 of Architecture Decision Record (ADR) 0080 (the web approval executor):
its fork of the approver on the lease, and the acceptance of that fork's cost.
Amends ADR 0102 (the publication review) in its section 9, its section 10 and its "Before it is switched on" list;
ADR 0102 carries the corrections in place and a dated amendment.
Builds on ADR 0080 (the claim, the lease and the dispatch),
ADR 0102 (the approval gate, and the stop-gap this ADR retires),
ADR 0048 (account kinds, which the rejected alternative would have read),
and ADR 0020 (a change to a shared workflow reaches every environment at once).
The analysis behind the choices is in [`.context/publication-review-design.md`](../publication-review-design.md); this ADR is the verdict.

## Context

A click on Approve in the website does not run an approval.
It claims the request (`approval_requested_by`, `approval_dispatched_at`) and dispatches an executor, a workflow that runs `nemar admin publish approve` on a runner under its own administrator key (ADR 0080).
So the Worker sees an administrator key, and nothing in the call says whether it belongs to a web click.
ADR 0080 decision 5 settled that by time: while the claim's lease is live, whoever calls is recorded as the clicker.
It named the cost and accepted it: a person who runs `/approve` at a terminal inside a web run's lease is recorded as the clicker (#1604).

ADR 0102 made that cost larger.
An override of the publication review, and the identifier screen's acknowledgment, are recorded under the approver of record and satisfy a later run only when that run is attributed to the same administrator.
So a terminal approval inside a live web lease could ride on the clicker's recorded decision, and be recorded as the clicker's own act.
Phase 2 added a stop-gap, a refusal of any override sent inside a web approval (`override_inside_web_approval`), so that no override was ever recorded under another administrator's name.
The ride on the clicker's own recorded override stayed, and production was not to be lit until it was fixed.

Five facts, each checked against the code on 2026-10-13, shape the answer.

- **The lease is time, not proof.**
  It says that something is associated with the request, not that this call is the dispatched run.
  A person's terminal inside the lease cannot be told from the executor (#1604),
  and a runner that starts after the lease has lapsed is recorded under its own key, not as the click it was started for.
- **A shared secret and a derivable claim already exist.**
  The Worker holds one callback secret that signs its other callback tokens (the manifest's, the pre-screen's, the identifier screen's and its sweep's, and the two reviews'), each under its own domain tag.
  The claim's own columns (the clicker, the instant) are written by the click and cleared by every statement that ends a claim,
  so a token derived from them is revoked by exactly the events that end the claim.
- **The executor is a workflow in the central workflow repository, which this repository does not hold.**
  Whatever the Worker comes to expect, the workflow must be changed to send it, and only the maintainer changes it, in a repository that every environment shares (ADR 0080 decision 3, ADR 0020).
  The change has a rollout, and the rollout has a window.
- **The approval path had five neighbouring faults that the same work touches.**
  A run could act on a request that was denied and filed again since the caller read it (#1579).
  A dispatch for an id the workflow would refuse claimed the lease and held it for fifteen minutes on a run that could not start (#1583).
  A workflow that failed before it called `/approve` held the lease the same way, with nothing to say why (#1582).
  A cookie request with no `Origin` check could approve or deny, and `/deny` was not gated by the lease (#1603, #1584).
  The write that ends an approval did not look at the request's status.
- **Persisting the Object Lock continuation token (#1580) is a different kind of change.**
  It would speed a resumed run, by an amount nobody has measured, at the price of a property a restart from page 1 has today (decision 13).

## Decision

**A web click's claim gets a token that is derived from the claim and proves, on every `/approve` call of its run, that the call belongs to that claim.
The clicker is the approver only for a call that presents a valid token, and every other caller is recorded as themselves.
A terminal approval takes any live claim over.
A token that is stale or expired is refused, never quietly downgraded.**

1. **The token is a keyed hash of the claim's own columns, and nothing is stored.**
   It is a hash-based message authentication code (HMAC) with SHA-256, signed with the callback secret the Worker already holds (`PRESCREEN_CALLBACK_SECRET`).
   The signed message is five lines: the domain tag `approval-dispatch`, the dataset id, the request id, the clicker's id and the claim's own stored `approval_dispatched_at`.
   The tag keeps it from standing for any other kind of callback token, and no other kind's message can begin with it.
   A field that holds a line break is refused by the signer and fails the verifier, because the message is split by lines.
   There is no stored nonce, no column and no migration: releasing, replacing, denying or taking over the claim changes or removes what the token is checked against, and that is its whole revocation.
   The claim is one conditional write that returns the instant it stored, and the token is signed over that value, never over a recomputed clock.
   A Worker with no secret to sign with answers 502 `dispatch_unconfigured` before it claims anything.
2. **The token is a bearer credential for attribution, and for nothing else.**
   Any administrator key that presents it is recorded as the clicker, and rides on the clicker's recorded override and acknowledgment, for as long as the claim stands and its lease is live.
   It authorizes nothing by itself: the call must still authenticate as an administrator and pass every gate.
   It joins no revocation list, because `resolveApprover` re-checks the clicker's role and status at each use.
   The Worker never logs, audits, lists or returns it: it is not stored, the dispatch error text has any copy of it removed,
   the audit rows carry ids and words only, and the command-line interface (CLI) redacts its header in the `--debug` log.
3. **It travels in the dispatch payload and in one header.**
   The click mints it and puts it in the payload as `dispatch_token`, which now has five keys: `dataset_id`, `request_id`, `resume`, `environment` and `dispatch_token`.
   The executor presents it as `X-Approval-Dispatch-Token` on every `/approve` call of the run, one per batch and one per retry, so it cannot be single-use.
   The CLI reads it only from the environment variable `NEMAR_APPROVAL_DISPATCH_TOKEN`, only in `approve` and never in `next`, so a token left in a person's shell cannot turn their walk into an executor's run.
   With the variable set, `approve` refuses `--force` and `--acknowledge-identifier-screen` before it sends anything (decision 5), and says on standard error that the run presents a token.
4. **The approver forks on the proof, in this order, in the prelude of `runPublicationApproval`.**
   A call that carries no token, or an empty or blank header, is its caller's own act whatever claim is on the row and whatever its lease says: the caller is the approver.
   A call whose token verifies, on a request that is `requested` or `approving` whose time-only lease is live (read in the same statement as the request, before this call's own heartbeat), is the click's run:
   the clicker is the approver if they are still an active administrator, and the caller stands in if they are not (the question this ADR leaves open, below).
   A call whose token does not verify is refused and changes nothing:
   409 `dispatch_superseded` when there is no claim, no secret, a mismatch, or a claim that was replaced, released or taken over,
   and 409 `dispatch_expired` when the token is genuine and the lease has lapsed, so a click made long ago is not honored for work done now.
   The lease is asked only after the digest, so a stranger learns nothing about a lease.
   The checks of `/approve` run in this order: the outdated-client refusal, the request read (404), `request_mismatch`, `request_blocked`, the token, the approver, `decision_with_dispatch_token`, the identifier screen's gate, the review's gate, the recording of the override, and the conditional mark.
5. **A call that carries a valid token carries no decision.**
   An override of the review or a screen acknowledgment in the body of such a call is refused, 409 `decision_with_dispatch_token`, and nothing is recorded under anybody.
   Both were recorded at the click, under the clicker's id, and the gates read them there.
   This retires the Phase 2 stop-gap `override_inside_web_approval`, which is removed from the contract.
   Its guarantee is now structural, and stronger: an override or an acknowledgment is recorded only under the credential that sent it, or at the clicker's own dispatch.
6. **A terminal approval takes the claim over.**
   The mark that moves a request to `approving` clears `approval_requested_by` and `approval_dispatched_at` in the same statement, for a call that carried no token.
   It is the last write before any work, so a call that is refused earlier leaves the claim standing.
   The executor the click dispatched then finds no claim, and its next call is 409 `dispatch_superseded`.
   A call that carried a token marks only while `approval_dispatched_at` is still the instant it verified, which closes the gap between the check and the mark;
   zero changes are answered `dispatch_superseded` if the claim moved, and `request_changed` if the request moved under a claim that stands.
   A call already past its mark when the takeover lands finishes, which is the old hazard of two drivers narrowed to one call.
   An executor whose workflow sends no token takes over its own claim the same way.
7. **A run may name the request it is for.**
   `/approve`, `approve-dispatch` and `/deny` take an optional `request_id`, and answer 409 `request_mismatch` when it is not the newest active request,
   right after the request is read and before any gate, any approver resolution or any write, so nothing is recorded for a request nobody looked at (#1579).
   The CLI sends the id of the detail it read on every `approve` call, `next`'s `y` included, and takes `--request-id` for a script, refusing locally when the two disagree.
   A call that carries a token binds the request by the token as well.
   The CLI's `deny` does not send it today, and the website's calls are Phase 4's (#1731).
8. **The dispatch route checks the dataset id for its environment before it claims.**
   The ids are `nm` or `on` and six digits on production, and also `xx` anywhere else (`APPROVAL_DISPATCH_ID_RE` in `shared/publication-limits.ts`).
   Anything else is 400 `invalid_dataset_id`, before the body is read, before any read of the request and before the claim (#1583).
   The workflow cannot import the constant: it states the same rule in its own validate step, and each side's comment says so, so the two are changed together by hand.
9. **A failing executor releases its own claim.**
   `POST /webhooks/approval-release` takes `{ dataset_id, request_id, reason }` and the header, and the token alone authenticates (#1582).
   The reason is one of six closed words (`workflow_failed`, `workflow_cancelled`, `secret_missing`, `install_failed`, `input_rejected`, `preflight_failed`), and an unknown word reads as the first.
   The sentence of the word is stored, never a string the workflow wrote.
   One conditional write, bound to the claim's instant and its clicker, clears the claim and sets `last_error` unless a specific one is already there.
   It leaves `updated_at` alone, because the failed-run grace counts from it.
   It writes the audit row `approval_dispatch_released` (no user, the request id and the reason) and answers 200.
   Every refusal of the credential, whatever the cause, is one 401 with the same bytes, so an answer never tells a caller which requests have a live claim.
   The route does not check the lease: a token releases its own claim for as long as that claim stands.
   The four answers of `/approve` that come after the request is marked and before its step loop (dataset not found, sandbox, no repository, invalid repository) now also write their own sentence to `last_error`, best effort, with their bodies and statuses unchanged.
10. **One Origin rule covers every cookie write on the admin router.**
    `cookieOriginGuard` runs after authentication and the role check.
    A read passes (`GET`, `HEAD`, `OPTIONS`); any other method that is not authenticated by a bearer key needs a NEMAR `Origin`, or it is 403 `origin_not_allowed` (#1603, #1584).
    The rule is phrased as "not a key", so a request whose method of authentication nothing set fails closed.
    It replaces four per-route copies (the dispatch, the screen re-run, the review start and the comment).
    `/approve`'s own stricter rule, that an override is accepted only with an administrator key, stays.
11. **`/deny` is gated by the lease and is one conditional write.**
    It reads the newest active request and refuses, in this order and before any write: 404 for none, 409 `request_mismatch`,
    409 `deny_after_publishing` when the request's completed steps include any beyond the validation-only ones, and 409 `approval_in_flight` when an approval is running (the lease with its failed-run grace).
    The `deny_after_publishing` refusal ignores the request's status on purpose:
    a request filed again keeps its `steps_completed` (follow-up #1766), a request's own completed steps are its own irreversible acts, and the dataset may already be public, so the depositor must not be told it was denied.
    The write is conditional on the lease and on the `updated_at` that was read, so a request that was published, claimed or touched in between is not overwritten.
    A lost write is read again and answered by the true reason.
    The write also clears a lapsed claim.
    The depositor's mail goes only after the write has changed a row.
    A stalled run that has not started publishing can still be denied: nothing is public and nothing is writing.
12. **The write that ends an approval requires that the request is still `approving`.**
    A request closed while its run ran (denied once its lease had lapsed, or blocked again by a late result) is not marked published.
    The run answers 409 `approval_closed_during_run`, a word of its own because `request_changed` means that nothing ran and here the steps have run and cannot be taken back,
    and writes one audit row, `approval_finished_on_closed_request`, of ids and words.
    A request that is already `published` was finished by a concurrent call of the same run, and counts as finished.
    The branch for a resumed run whose steps are all done uses the same write, and refuses any other status where it used to answer `published` and write nothing.
13. **#1580 is deferred.**
    A resumed run restarts the lock listing at page 1, so objects added under `objects/` while the run was stopped are locked too, and `s3_lock` is never run again once complete.
    A saved continuation token would skip whatever was listed before it, which weakens a property the restart has today, and it would need a migration and a new resumability contract.
    The benefit is not measured, which is the first task of the issue when it is taken up.

### Left open, for the maintainer

With a valid token whose clicker is no longer an active administrator (demoted, revoked or deleted),
`resolveApprover` falls back to the caller, as ADR 0080 decided, and a test pins it.
The gate then reads the executor's own decisions, so the click publishes only where it needs none of the clicker's: a review that passes (or is off), a screen that is clear, or a run that has started publishing.
It is recorded as the executor, and the dispatch's own audit row names the clicker by id.
The revocation-cascade rule of AGENTS.md argues for refusing such a click unless the run has already started publishing, because ending a credential has to end what was minted from it.
The maintainer has not decided.
Nothing in this ADR decides it, and the code keeps ADR 0080's behavior until it is decided.

## Rollout

The Worker and the workflow are changed by different people in different repositories, so the order matters.
The workflow is the central workflow repository's `approve-publication.yml`.
The maintainer changes it, and a merge there takes effect for both environments at once.

| Step | What | Why here |
|---|---|---|
| 0 | The callback secret is set on both Workers (checked before this was written: it is). | Without it, `approve-dispatch` answers 502 `dispatch_unconfigured` and no click can be dispatched. |
| 1 | The maintainer applies the workflow edit before Phase 3 reaches `dev`. | Against today's Worker it does nothing: no token is in the payload, so nothing is exported and the release step is skipped. It must be there before the first click that carries a token. |
| 2 | Merge to `dev`, then verify on staging that a web approval is recorded as the clicker, that an acknowledged screen is carried by the token, that a forced early failure is released, and that the audit query joins `approval_dispatched` audit rows to `publication_requests.approved_by`. | This is the verification of ADR 0102's "Before it is switched on", item 7. Any published request whose `approved_by` is not the user of its `approval_dispatched` row (matched on the request id in the row's details) is a web approval the token did not carry. |
| 3 | Production release: the npm `latest` publication should precede the production Worker deploy. | The pipeline does not enforce the order. Hold the deploy until npm shows the version, or accept a window of a few minutes in which production attributes a web approval to the executor. |

The edit the workflow needs:

- A first step, with no `env:` block, masks the token read from the event file. The token must not go into the job-level environment, where the payload's fields land.
- The approve step exports `NEMAR_APPROVAL_DISPATCH_TOKEN` only after the CLI install, the way it exports the administrator key.
- The install matches the environment: `nemar-cli@dev` for the staging backend and `latest` for production. Dev builds are published under the `dev` tag and the runner installs unpinned, so without this a staging run would carry the older CLI, which ignores the variable.
- A step that runs on failure or cancellation calls the release endpoint, reading the token from the event file. A 401 answer means there is nothing to release.
- The token goes through the environment variable and nowhere else. The workflow never passes `--force` or `--acknowledge-identifier-screen`, which the CLI refuses with a token set. It needs no `--request-id`: the token binds the request, and its preflight already checks the newest request.
- Its validate step carries the id rule of decision 8 by hand.

What each combination does:

| Worker | Workflow | CLI on the runner | Result |
|---|---|---|---|
| old | any | any | Today's behavior. No token is in the payload. |
| new | old | any | No token is sent. The executor is recorded as itself and takes over its own claim. The clicker's recorded override and screen acknowledgment are not honored, so those approvals are refused when the review is lit. A failure is never released, and the lease lapses. |
| new | new | old | As the row above, except that the release step runs. The old CLI ignores the variable. |
| new | new | new | The full design. |

A manual `workflow_dispatch` run of the workflow is the executor's own act: it carries no token and takes over any live claim.
Rolling back the Worker alone is safe in every combination.

## Consequences

- **A transition window exists, and it is visible.**
  Between the Worker shipping and the workflow sending the token, a web approval is recorded under the executor's account, which is what ADR 0080 exists to prevent.
  Nothing is published wrongly, and nothing is lost: the approval is attributed to the wrong administrator, and the audit query of step 2 counts the cases.
  Where the review is lit, the same window has the gate refuse an approval that needed the clicker's override or acknowledgment.
- **The executor needs the workflow edit, and nothing in this repository can make it.**
  The Worker does not refuse a call that carries no token, because a person at a terminal carries none.
  An executor that never learns to send it is recorded as itself, and a run that needed the clicker's recorded decision is refused: attribution degrades, and nothing is published wrongly.
- **A web run that sat quiet longer than its lease is now refused,** where ADR 0080 accepted recording it under the executing key.
  A runner queued for more than fifteen minutes fails with `dispatch_expired`, and the page shows a stalled request to click again.
- **The token is a bearer credential, and what it carries is attribution.**
  Any administrator key that holds it can make its call be recorded as the clicker for as long as the claim stands, and can ride on the clicker's recorded decision.
  An administrator who could approve openly gains a way to approve under another administrator's name, not a way to approve what they could not.
  The token sits in the event file of the run, which every step of the workflow can read, in a repository whose logs are public:
  the workflow's first step has to mask it, and a workflow that does not turns the log into a place a token can be read.
- **A leaked token can cancel one run.**
  The release endpoint does not check the lease, so whoever holds a token can release its claim for as long as the claim stands, with no administrator key.
  The cost is one click wasted: the run is refused at its next call, a fixed sentence lands in `last_error`, and nothing is published or lost.
- **The token's resolution is one second, and a stored nonce was not chosen for it.**
  `approval_dispatched_at` is `datetime('now')`, so a claim released and then claimed again by the same administrator in the same second would give a token equal to the first.
  A re-claim is refused while a run is in flight, so it needs the earlier claim released, or stalled after its failure grace of a minute, or lapsed after fifteen.
  Only a release can put two claims in one second, and a release by the dispatch route means the event was never sent.
  What remains is an executor's own release followed within the second by the same administrator's click, and the consequence is two runs holding one valid token, which the takeover and the mark's condition already bound.
- **A demoted clicker's click can still publish** where it needs none of their decisions, recorded as the executor (the open question above).
- **A request that has started publishing can no longer be denied,** and a queued web approval cannot be cancelled by deny.
  A way to withdraw a half-published run, and an administrator's cancel of a queued web approval, are follow-ups.
- **A resumed lock restarts at page 1** until #1580 is taken up with its measurement.
- **Every cookie write on the admin router now needs a NEMAR `Origin`.**
  A server-side caller that sends the session cookie to an unsafe admin route without the header is refused, which is the cost #1584 names, and the website's calls are Phase 4's to check.
  `isAllowedOrigin` admits any NEMAR subdomain and local addresses, so a sibling subdomain would pass: defense in depth, and narrowing it for the admin router is a follow-up.
- **None of this is behind `PUBLICATION_REVIEW_ENABLED`.**
  The token, the takeover, `request_id`, the id rule, the release endpoint, the Origin guard, the deny rules and the guarded final write reach production with the first release after finalization, whatever the flag says.
  The release notes say so.
- **ADR 0080 decision 5 holds in part.** The clicker's re-check, the time-only lease, the claim cleared by the owner-name walk-back and the rule for an unconfirmed dispatch stand.

## Alternatives considered

- **Fork on the caller's account kind (ADR 0048).**
  Honor the clicker only when the caller is a service account.
  It fails silently if the executor's key is not marked as a service account, because every web approval is then recorded under the executor and the clicker's override can no longer carry a run.
  It still mis-attributes a person who uses a service key, it does not bind a run to its request, and the stop-gap refusal would have to stay for service callers, so the hole stays.
- **A stored nonce on the claim.**
  A column, a migration, a place to clear it in every statement that ends a claim, and a strip in the list route.
  It buys exactness only for a same-second re-claim, which the claim's refusal during a run and the takeover already bound, so it was not worth a schema change.
- **A temporary Worker lever for the old fork, to close the transition window.**
  A variable that keeps the lease-based attribution on until the workflow sends the token.
  The window is zero, but a terminal approval inside a lease is mis-attributed for as long as it is on, it has to be set in two files and removed in a later release, and the window it closes is minutes when the order of the Rollout is followed.
- **The administrator key and the token for the release.**
  Stronger, but a missing administrator key is one of the failures the release has to be able to report, and the route would sit under `/admin` where the method of authentication must be a key.
  The token alone is limited to ending one claim early, which is the whole of what it can do.
- **Honor an expired token while its claim stands.**
  A runner delayed by an incident would later publish under a stale click, which is the case ADR 0080's principle, that a click is honored only while its run is live, exists to refuse.
- **Let a terminal approval and the executor coexist.**
  Attribution would flap between two drivers on one request.
  Refusing a terminal approval inside a claim removes the escape for an administrator in a hurry that ADR 0080 keeps.
- **Let `/deny` withdraw a half-published run.**
  The dataset may be public and the depositor would be told it was denied.
- **Keep the per-route Origin checks.**
  Four copies of a rule that every other unsafe route lacked.

## Receipts

- Epic #1726 and this phase, #1730.
  The approval issues #1579, #1580, #1582, #1583, #1584, #1603 and #1604.
  The earlier phases, pull requests #1735, #1762 and #1767.
  Phase 3's own pull request was not open when this was written; its work packages are on the branch `feature/issue-1730-phase3-approval-robustness`.
- ADR 0080 (decisions 2, 3 and 5 and its consequences, corrected in place with an amendment), ADR 0102 (sections 9 and 10, "Before it is switched on", and the Phase 2 amendment, with a Phase 3 amendment),
  ADR 0048 (account kinds), ADR 0020 (workflow edits reach every environment).
- The token: `backend/src/services/github/callback-tokens.ts`, `backend/src/services/approval-dispatch.ts` (`checkApprovalDispatchToken`, `resolveApprover`),
  `backend/src/services/github/dispatch.ts`, `shared/contract/publication.ts`.
- The routes: `backend/src/routes/admin/publish.ts` (approve, approve-dispatch, deny), `backend/src/services/publication-orchestrator.ts` (`runPublicationApproval`),
  `backend/src/routes/callbacks/approval-release.ts`, `backend/src/middleware/auth.ts` (`cookieOriginGuard`), `shared/publication-limits.ts`.
- The CLI: `src/commands/admin-publish-approve.ts`, `src/lib/api/publish.ts`, `src/lib/debug-log.ts`.
- The tests: `backend/test/approval-attribution.test.ts`, `backend/test/approve-dispatch-route.test.ts`, `backend/test/publication-review-gate.test.ts`,
  `test/admin-publish-approve-token-cli.test.ts`.
