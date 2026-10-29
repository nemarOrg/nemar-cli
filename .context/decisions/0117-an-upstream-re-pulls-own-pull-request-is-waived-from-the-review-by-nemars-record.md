# ADR 0117: An upstream re-pull's own pull request is waived from the review by NEMAR's record

**Status:** proposed
**Date:** 2026-10-29
**Owner:** Seyed Yahya Shirazi

Issue #1998.
Partially supersedes [ADR 0107](0107-dataset-pull-requests-are-screened-on-content-owners-and-administrators-are-exempt-and-the-review-check-is-required.md) (decision 1's rule that `skipped` is the conclusion of the exempt outcome alone, and the queue's words) and [ADR 0111](0111-an-upstream-re-pull-is-a-reviewed-delta-on-a-release-branch.md) (decision 7's bullet that machine clean needs an ADR 0107 review that passed, and the Worker's own start of that review in the Phase 7e and Phase 7f amendments).
Everything else in both stands.
Follows ADR 0053 and ADR 0086 (unknown is never clear) and ADR 0034 (derive, don't store).

## Context

An upstream re-pull of a mirror lands through a pull request from `release/vN.0.0` into `main` of the dataset's own repository (ADR 0111, decision 2).
On such a pull request, opened by an administrator's `nemar admin repull execute`, the `NEMAR PR Review` check ran the ADR 0107 review and concluded "Needs changes".
Its blockers were the rules that protect a dataset from a contributor's change: an original field changed, metadata removed, no CHANGES entry.
In a mirror upstream is the author and wins every conflict (ADR 0111, decision 1), so N.0.0 changes exactly what those rules forbid, and N.0.1 replays NEMAR's own corrections.
The failing check made GitHub report the pull request `unstable`.
`resume` records the gates only on `clean` (or on `unstable` when BIDS validation alone fails), so it never did, and `nemar admin repull merge` refused with `not-ready`; `--force` waives the review only inside the merge gate, which was never reached.
The only way on was a squash merge by hand, past every NEMAR gate.

Why the owner and administrator exemption did not catch it, verified in the code and by a test, not measured on the production rows:
ADR 0107 exempts a delivery only when its `sender` is the author or exempt in their own right, and the intake reads no usable sender from a bot (`nemar-bot[bot]` is not a person's login shape).
Enrichment runs on every push to `release/*` and commits back as the NEMAR App, so the delivery for the head it makes is reviewed.
The existing test "a delivery that names no usable sender is reviewed" pins exactly that, and it is right for every other pull request.
An administrator account whose GitHub login does not match, or whose `admin` role GitHub does not report, would make even the `opened` delivery reviewed; the decision below does not depend on the exemption, so it covers either cause.

## Decision

**The review is waived for the pull request of an open upstream re-pull, at the head NEMAR's own tools recorded for it, decided by the Worker from NEMAR's record and from GitHub's facts about the pull request, never from a branch name or anything the pull request says.**

1. **One rule, `shared/repull-review-waiver.ts`, pure.**
   A pull request is waived exactly when an `upstream_repulls` record is of the same dataset; names it as N.0.0's (`pr_number`) or N.0.1's (`patch_pr_number`); is at a status in which that pull request is open at the recorded head (`pr_open` or `gates_clear`, `patch_synthesized` or `patch_gates_clear`); the pull request is from and into `nemarDatasets/<dataset>` (never a fork); its head branch, where the caller read it, is the record's release branch, and its base, where read, is `main`; and its head is the record's head (`head_sha`, `patch_head_sha`).
   The Worker cannot run git, so it does not decide "moved by enrichment only" a second time: the record's head moves only when a NEMAR tool records it, and the CLI's `resume`, the automatic run's settle and the re-synthesis record a moved head only after `enrichmentOnlySince` (`src/lib/repull/execute/head.ts`, through `acceptsHead`) accepted it.
   The intake, the publisher, the administrator's list and detail, and the machine-clean facts all ask this one function.
2. **A waived head gets one check and no review.**
   The check is `NEMAR PR Review`, the name the review ruleset requires, with the conclusion `skipped` and the title "Waived: upstream re-pull"; its text says the decision is NEMAR's record and not the pull request's, which gates still hold the merge, and that skipped is not a pass.
   No row is written, nothing is dispatched and no model is called.
   It is decided before the exemption, a block and any restart of a stored review, so no delivery, edit, reopening or administrator's start (a `--redo` included) runs the review of such a head; each answers `repull_waived`.
   A head a review already touched keeps its row as the history of that run, and its own check run is updated in place to the waiver, with the comment saying the same; a head with no row gets a new check run and no comment, as an exempt one does.
   When GitHub refuses that update for a reason about the run (any 4xx but a refused credential or a throttle), a NEW run of the same name is posted on the same commit instead, which GitHub and NEMAR's own readers take as the latest of the name, so correcting a failed check does not rest on GitHub letting a completed run's conclusion change.
   A check that does not reach GitHub either way is thrown, so the webhook answers 500 and the delivery can be redelivered, an administrator's start says so, and no audit row is written.
   Every write of the waiver inside a request (a delivery, a start, the record's transition) is bounded to a few seconds.
   Each waiver writes an audit row, `pr_review_waived`, with the record, the head, which pull request and what caused it; the queue never reads it.
3. **A head NEMAR has not recorded yet is reviewed, and the waiver follows the record.**
   The Worker cannot tell enrichment's commit from a stranger's at delivery time, so a head enrichment moved is reviewed until a NEMAR tool records the move.
   Then the record's own transition publishes the waiver for that head at once (best effort, after the edge is written, and only once GitHub shows the pull request at that head), and every later publish of that head's review, the callback of a review still running included and the watchdog's, publishes the waiver instead of the review's verdict.
   A stored review holds no branch, so such a publish reads GitHub's record of the pull request before it waives, and decides on the same facts the intake does; a pull request GitHub cannot show is not waived, the review's own verdict is published (unknown is never a waiver), and the row is left unpublished so the watchdog's republish sweep decides again.
   That sweep counts such a publish as a failed attempt, so it tries five times, about two and a half hours on the 30-minute tick, and then logs that it gave up (`abandoned`); after that the check stays as the review left it until an administrator's start of the pull request, which `resume` names.
   A branch GitHub does not name is read as the empty string, which no record's branch is.
   For the App's pull request, which no delivery reviews, the advance tick publishes the waiver again when everything but GitHub's word holds (`not-clean`) and the App's latest review check at the head is not the waiver, and counts and logs it (`waivers=`, `waivers_failed=`).
   That is at most one publish per row per 30-minute tick, for as long as the hold lasts, and each failure is an error-level line, so a waiver GitHub keeps refusing is seen rather than given up on.
   The record's transition never publishes for a draft, a closed or merged pull request, a fork, a dataset the review may not read, a dataset the other environment's Worker owns, or while the review is switched off.
4. **`skipped` is the conclusion of exactly two outcomes: `exempt` and `waived`.**
   Neither is a review that ran, so neither hides an unknown.
   Not `success`, which reads as a pass, and not `neutral`, which ADR 0092 keeps out of the vocabulary.
   The queue gains the verdict `waived`, derived on every list and detail and never stored; it wins over a review of that head and over `exempt`, is offered to an administrator to merge through the re-pull's gate (`y` in `next` goes through that gate, which says when it waits for `resume`), and is left out of `start --all`.
5. **Every merge gate treats `waived` as allowing, without `--force`, and nothing else is widened.**
   `nemar admin repull merge` and `nemar admin pr-reviews` read the Worker's detail, whose verdict is `waived`, and confirm it with a sentence instead of asking for `--force`.
   The Worker's machine-clean rule reads the review fact `waived` (the pull request as just read is the record's at that head) and passes it, without reading the review's row.
   The identifier screen (`clear` for the Worker, `clear` or acknowledged for an administrator), BIDS validation, `version-check`, GitHub's `clean`, the screened head, the squash trailers and the daily merge cap are unchanged.
   The naming rule is not applied to a waived head: the title is NEMAR's own (`buildReleaseTitle`, checked against the rule before the pull request is opened) and the dataset's name is upstream's, which upstream wins.
6. **The Worker's review of the App's automatic re-pull pull request is retired.**
   The Phase 7e amendment admitted it, through `startRepullPullRequestReview`, so that machine clean could ever find a pass; with the waiver nothing needs one, so the start, the tick's call of it and the intake's `admitRepullBot` are removed, and ADR 0092's "not bots" stands whole again: no bot's pull request is reviewed.
   The App's pull request gets its waived check from its record's transition, and a delivery or an administrator's start of it publishes the waiver again when the rule holds; any other bot's pull request, and the App's at a head the record does not hold, is answered `bot_author` as before.
7. **Findings are recommendations, and no model is run for them.**
   A recorded head is not reviewed, because the review's questions are the ones a mirror cannot satisfy, a run can cost more than a dollar at its ceiling (ADR 0107), and the conclusion must not wait on it.
   What a review of that head found before it was recorded is rendered under "Recommended issues, none filed automatically", with no severity and no word that anything fails, in the check, the comment and `nemar admin pr-reviews show`.
8. **Filing those recommendations as issues is a later step, and not built.**
   It would hook in where the waiver is published (`publishWaived` in `backend/src/services/pr-review.ts`), from the advice report, once per record and finding code.
   Where it files is that step's decision: ADR 0067 and ADR 0088 file nothing on `nemarDatasets` because it is public-facing.

## What a forged pull request can and cannot get

- Only NEMAR's tools write the record: an administrator's routes (admin role) and the automatic run's own dispatch token. A contributor cannot write it.
- A branch named `release/v9.0.0`, from a fork or from the repository itself, is reviewed: no record names its number.
- A fork is reviewed even at a recorded number, and a record of another dataset or at another status (planned, merged, abandoned, superseded, complete, failed) waives nothing.
- A commit pushed onto a re-pull's release branch by anyone with write access is reviewed, because the record does not hold it; `resume` then refuses it (`head-foreign`), and every merge gate merges only the screened head.
- An edit of a waived pull request's title or body changes nothing that gates: the squash message is built by the gate.
- **What it can get: a file under `.nemar/` it writes onto the release branch.** The enrichment-only rule (`enrichmentOnlySince`) checks what a commit changes, never who made it: any regular file under `.nemar/` other than the privacy ledger passes it, so `resume` or the automatic run's settle records such a head and it is waived, where before this decision it needed a review that passed (which no re-pull got).
  Checking who made the commit would be no guard: enrichment's commits carry plain git identities (`nemar-bot <nemar-bot@users.noreply.github.com>` from the central workflow, `nemarAdmin <nemarAdmin@osc.earth>` from the Worker's contents writes), which anyone with push access can write, and the one authenticated identity, the sender of each push delivery, is not recorded.
  What still holds such a head: the identifier screen of the head, BIDS validation (`.nemar/` is ignored by it), the administrator's own merge confirmation, and push access itself, which only the dataset's collaborators and NEMAR hold.
  Whether to add a test on who made each commit to the enrichment-only rule, once the change to that rule in flight elsewhere lands, is the owner's decision.
- **A check run belongs to a commit, not a pull request.** Another pull request at the same commit, a fork's say, shows the same waived check, and its own review (it is not the record's, so it is reviewed) can post a failing run beside it.
  The merge gates read the Worker's verdict for the record's own pull request, not the check, so they are not misled; GitHub's `clean` reads the checks, so such a run can hold the re-pull at `unstable` until the waiver is published again (an administrator's start, or the tick), which makes it the newest run of the name.
- An administrator can record a head through the transition route; that is inside the administrators' trust boundary, as their own pull requests are exempt and an organization administrator can merge in the GitHub UI.

## Consequences

- A re-pull no longer needs a hand merge: `resume` records the gates once GitHub reports `clean`, and the merge gates accept the waiver.
- A head enrichment moves still costs one review run before it is recorded, which the screen bounds and the volume line counts; in exchange a commit the record does not hold is never waived (the `.nemar/` residual above is the one way a commit someone else made can come to be held).
- The administrator's tally of an administrator's account can count a failed review of a re-pull head that was later waived. It decides nothing (ADR 0107).
- An existing failed check on a recorded head is corrected by `nemar admin pr-reviews start <dataset> <pr>`, with or without `--redo`, which updates that check run in place or, if GitHub refuses that, posts a new one; `resume` names the review check, or any other check that is why GitHub reports `unstable`.
- The advance tick no longer reads the review's row for a recorded head or starts a review, so a tick costs less.
  Measured over five rows, as the Phase 7f and 7g amendments measured them: at `pr_open`, 62 D1 statements and 25 GitHub requests when each starts its screen (the most), 32 and 20 while each waits, 47 and 25 when each is cleared; past the gates, 32 and 20 while each waits at the merge and 77 and 35 when each is merged.
  `upstream-repull-advance.test.ts` and `upstream-repull-worker-merge.test.ts` pin them; the earlier figures in ADR 0111 are history.
- A publish of a stored review that a record could waive costs one more GitHub read, of the pull request, so the waiver is decided on its branch and repositories as the intake decides it.
- The record's transition answers only after its waiver is published, so a transition that records a head waits for GitHub: one read of the pull request (10 seconds at most) and bounded writes (5 seconds each for the check, a new run if the update is refused, and the comment). The edge is written first, and a waiver that is not published is logged by the record's id and a fixed word.
- An installed CLI older than this change reads the verdict `waived` as one it does not know, which needs `--force`: the safe direction, cured by an upgrade.

## Not yet verified

Measured against stand-ins only, and not verified against GitHub until the first re-pull after the deploy:
that GitHub reports a pull request `clean` when its one check that is not `success` is a `skipped` one (its documentation says a required check treats `skipped` as passing, and says nothing of `mergeable_state` for a check that is not required);
and that GitHub accepts a PATCH of a completed check run from `failure` to `skipped` (its documentation forbids only `stale`).
The second does not decide the fix: a refused update is followed by a new run of the same name.
That the newest run of a name is the one that counts is what this repository's own readers do (`othersNotPassing` and `checkFactOf` take the highest id of a name and App); that GitHub's `mergeable_state` reads it the same way is the same unverified rule ADR 0107 lists for the exempt check.

## Alternatives considered

- **Exempt the App as a sender.** It would pass any commit the App pushes on an administrator's branch, and the App pushes on every dataset; the record is narrower.
- **A rule on the branch name.** Anyone can name a branch `release/v9.0.0`.
- **Run the model and keep its findings advisory.** The conclusion would wait on a run that can take 50 minutes and cost more than a dollar, for findings that are about upstream's own choices.
- **Hold an unrecorded release-branch head without a review until a tool records it.** A stranger's commit there would never be reviewed, which ADR 0107 refuses.
- **A stored `waived` state on `pr_reviews`.** It needs a table rebuild (the state and detail lists are CHECKs) and stores a copy of what the record already says, which can drift from it.
- **`success` or `neutral`.** The first reads as a pass; the second is kept out of the vocabulary by ADR 0092.

## Receipts

- Issue #1998.
- The rule: `shared/repull-review-waiver.ts`; its readers `backend/src/services/pr-review-repull-waiver.ts`, `backend/src/services/pr-review.ts` (`handlePullRequestEvent`, `publishOutcome`, `publishWaived`, `publishRecordedRepullHead`), `backend/src/services/upstream-repull.ts` (`transitionRepull`, `recordedHeadOf`), `backend/src/services/pr-review-queue.ts`, `backend/src/services/upstream-repull-facts.ts` (`reviewWaivedAt`).
- The words: `shared/pr-review.ts` (`conclusionOf`, `recommendationLines`, `REPULL_WAIVED_TITLE`), `shared/contract/pr-review-admin.ts` (`waived`), `shared/repull-machine-clean.ts` (`waived`).
- The CLI: `src/lib/pr-review-approve.ts` (`approvalGate`), `src/commands/admin-pr-reviews.ts` (`waivedLines`), `src/lib/repull/bids-only.ts` (`reviewCheckWords`).
- Tests: `test/repull-review-waiver.unit.test.ts`, `backend/test/pr-review-repull-waiver.test.ts`, `test/pr-review.test.ts`, `test/repull-machine-clean.unit.test.ts`, `backend/test/upstream-repull-facts.test.ts`, `backend/test/upstream-repull-advance.test.ts`, `backend/test/upstream-repull-worker-merge.test.ts`.
