# ADR 0088: Published datasets are re-screened on a cycle that does not depend on the verdict, and a weekly admin report says what was not screened

**Status:** accepted
**Date:** 2026-10-06
**Owner:** Seyed Yahya Shirazi

Epic #1610, issue #1615.
Builds on ADR 0086 (the screen workflow and its report contract), ADR 0067 (report, never repair; no GitHub issue on a public-facing org; what could not be checked is `unchecked`), ADR 0053 and ADR 0054 (silence is evidence only when there was work; the weekly report arrives whether or not anything is wrong; unknown is not zero), and ADR 0034 and ADR 0035 (derive, do not store; sweep bookkeeping lives in `sweep_stamps`).

## Context

ADR 0086 screens a dataset once, when its publication is requested.
Nothing screens it again.
The scanner improves, a new version is pushed to a dataset that is already public (a new version does not pass through a publication request), and two administrator tools can make a dataset public without the screen.
A dataset that was clean on the day it was published is a claim about that day.

Three facts shaped the design.
The Worker cannot read tens of thousands of headers (ADR 0086 rejected that for the same reason).
The Actions logs of `nemarDatasets/.github` are public, and a screen run's log names the dataset it reads.
And `nemarDatasets` is the org the dev worker shares with production.

## Decision

**A production-only sweep on the 30-minute tick dispatches the ADR 0086 screen workflow for a few published datasets at a time, stores each result as a verdict in `sweep_stamps`, and a weekly admin email states how much of the fleet was screened in the last 28 days, what was not and why, and which datasets carry findings.**

- **The same screen, not the fleet scan.**
  `run-identifier-screen` already takes any `callback_url` and a `request_id` of 0, so the sweep dispatches it unchanged with its own callback (`/webhooks/identifier-sweep-result`) and a token of its own kind (domain tag `identifier-sweep`, over the dataset id and the attempt's nonce, same secret).
  One scanner, one report contract, parsed at the door and again on every read.
  `scripts/identifier-fleet-scan.ts` stays the operator's local tool: it reads the public data plane and samples a manifest it cannot list whole, while the workflow reads every header, the whole history and private datasets.
- **Scope.** Active, public, not withdrawn, and not a well-formed `xx` id (the publication screen's exemption, as a GLOB so a malformed id is screened; the workflow refuses an `xx` id, so such a row ends `workflow-failed` and is reported).
  `on` mirrors are screened like any deposit, and so is an anonymous deposit: its row is public over a private repository, which the workflow's App token clones as it does for a publication request, and the run log names only the id the public catalog already shows.
- **Cadence, and it never depends on the verdict.**
  A dataset is due when it has no verdict on record (no status, a status that is not one, no report object, no time, or a time in the future), when its verdict is more than 21 days old, when its verdict was for an older version than its latest, or when an administrator asked.
  It is not dispatched again within its backoff: 6 hours, which also covers a screen in flight, growing with attempts in a row that produced no verdict (6, 12, 24, 48, then 96 hours), so a dataset whose screen always fails is not run four times a day forever; a verdict resets it, and an administrator's request skips it unless a screen is running.
  The queue takes a request first, then a never-attempted dataset, then a newer version, then the oldest attempt.
  A tick dispatches at most 3, and none while 6 sweep screens are in flight.
  **Re-screening a flagged dataset more often than a clean one is ruled out**: the public run list would then say which datasets are flagged.
  Every input to the cadence is either already public (a version, failed runs) or an operator's choice.
  An incomplete verdict is not retried sooner for the same reason; the per-dataset rescreen is the lever, and there is deliberately no bulk "rescreen everything incomplete" (a burst in the run list would name them).
- **The cycle is 28 days.**
  A dataset counts as screened only when its verdict is at most 28 days old, was dispatched for its current latest version, reads back, and is complete: the scan read everything it can parse (`scan.incomplete` false, whatever it found).
  Everything else is `unchecked`, with the reason kept apart: never screened, a stored result that does not read back, older than the cycle, a newer version not yet screened, or the scan itself incomplete.
  A verdict whose screen cannot parse some recordings' formats (`not-screened`, `clean-edf-only-others-unscreened`) counts as screened, and the report says how many of those there are on a line of their own, so "screened" never reads as "every recording read".
  This is derived from the stamps and the clock each time it is read; nothing stores "covered".
- **Storage is `sweep_stamps` only**, twelve keys under `identifier_sweep_*` (`sweep-stamps.ts`), in two groups that never mix.
  The verdict (status, the report, when, the version its screen was dispatched for, and a finding carried forward) is written only from a scan the parser accepted.
  The report stored is a projection (the verdict, its counts, what it read; no sampling statistics, read-failure classes, distinct-value counts, manifest source, or unparsed-format map, whose keys are a pattern rather than a closed list), parsed again before it is written, so the row stays small (#1188), holds only closed words and counts, and is still a report the contract accepts.
  The attempt (state, error word, when, version, nonce, failures in a row, and an administrator's request) moves on every dispatch and outcome.
  The version recorded with a verdict is the one at dispatch, copied from the attempt, so a version published while a screen ran is not credited to it.
  No column (ADR 0034), every write through `COALESCE(sweep_stamps, '{}')` (ADR 0035).
  The detail route already withholds the raw column from everyone; only admin routes see it.
- **Failures move the attempt and never the verdict.**
  A Worker that cannot dispatch at all (no secret, API base or credential, or no token could be minted) claims nothing that tick and says so in the tick's result, logged at error level: no dataset is held back by a fault that is not its own, and the weekly report shows the sweep dispatching nothing.
  A dataset with no repository records `dispatch-unconfigured`; GitHub refusing a dispatch with a 4xx records `dispatch-failed`.
  A 401, 403 or 404 says the credential cannot reach the central repository at all: that attempt is closed without counting against its dataset, nothing more is claimed that tick, and the tick reports itself blocked, so a broken credential does not run the queue's backoff up dataset by dataset.
  A lost answer (a timeout, a dropped connection, a 5xx) is not a failure yet: GitHub may have started the run, so the attempt stays pending with its nonce.
  One still pending 50 minutes after dispatch (the screen's own deadline) is `unreported`, NULL-safe on a missing dispatch time, and keeps its nonce so a report arriving within 24 hours of the dispatch still lands; after that the nonce answers nothing, and the next dispatch replaces it.
  Each attempt that ends without a verdict is counted once toward the backoff.
  A workflow error word is recorded as such; a body outside the contract, or a scan of another dataset, is `workflow-failed`.
  None of them writes or refreshes a verdict.
  A tick that cannot count the screens in flight dispatches nothing.
  An attempt time in the future (a hand edit or a restore) holds nothing back and a pending attempt with one times out, so it cannot keep an in-flight slot forever.
  A claim is conditional on the scope, the backoff, and stamps that are an object (a JSON array or scalar passes the column's CHECK, and `json_set` on it changes nothing while counting the row as changed), so a dataset that left scope or was taken by a racing tick is not dispatched, and the tick counts it.
- **A finding is not retracted by a screen that read less.**
  A verdict that found something (`direct-identifiers` above `review`) is replaced only by a complete screen or an incomplete one that found at least as much.
  An incomplete screen is stored as the verdict (its time drives the cadence, which stays verdict-free) and carries forward, in its own key, the strongest finding among the verdict it replaced and the finding that verdict was carrying, so an incomplete `review` does not displace a `direct-identifiers`; the report lists the stronger of the two, as found on its own date and not confirmed since.
  A finding whose report no longer reads back is carried as its status alone, and a carried stamp that does not read back at all is still named, with the direct identifiers, because what it held cannot be told.
- **The weekly report is an admin email, not an issue,** under a mail category of its own, `identifier_sweep` (opted in by default, like every category), for the reason ADR 0067 gives `dataset_anonymity` one.
  It covers the ISO week before the one it is sent in and states the cycle as of the send: datasets in scope, screened by verdict (and how many of those have formats the scanner does not parse), unchecked by reason and by what their last attempt came to, incomplete scans by reason, screens dispatched and results stored in the week (a claim that never reached GitHub is not a dispatch), and the queue.
  It lists every dataset whose last finding found direct identifiers, by id with kinds and counts and the date of that screen, whatever its standing now: a finding does not drop out of the report because its screen aged out, a later screen was incomplete, or its stored report no longer reads back (the id is still named, with "kinds do not read back"); datasets needing review follow, the first 50 by id and the rest as a count.
  The words are the publication screen's (`screenStateLabel`, `screenErrorText`, `kindsPhrase`, `SCREEN_NOT_READ` in `shared/identifier-screen-report.ts`); every count goes through the one `count` renderer, and what could not be read is `unknown` and needs attention.
  It needs attention when anything is unknown, when any dataset has direct identifiers, when the sweep dispatched nothing in a week while work was owed and it had been running before the week ended (ADR 0053: only then is silence evidence), when work is owed and nothing was ever dispatched, when any dataset's latest screen in the week did not run or did not report (whatever its verdict's age, so a refused workflow shows before verdicts lapse), and when a screen of an unchecked dataset did not run or report, was incomplete, does not read back, or lapsed out of the cycle.
  Work owed is the due predicate without the backoff, so a sweep whose every dispatch is refused, leaving its datasets in backoff, is not read as one with nothing to do.
  The first report after a deploy covers a week before the sweep's first dispatch, and says so instead of calling the sweep idle.
  A dataset that is only waiting in the queue or being screened is work in progress and needs nobody.
- **Once a week, failing closed.**
  One atomic `INSERT ... SELECT ... WHERE NOT EXISTS` in `audit_log` claims the week only when it has not been sent, no claim is younger than 120 minutes, and fewer than 12 claims that may have mailed someone exist for it.
  A statement that errors claims nothing and sends nothing.
  The `sent` row is written only when an admin received it, with how many were tried and how many received it.
  A send refused outright (a 4xx from Resend, or the dev fence) marks its claim (by row id), which then does not count toward the cap, because retrying it cannot repeat a mail; a later tick retries after the lease, so a broken key costs delay and not the week.
  A send that ended without a definite answer (a 15-second timeout, a dropped connection, a 5xx) may have been delivered, so its claim stays unmarked and counts, like one that delivered and could not write its `sent` row or whose Worker died mid-send; the cap keeps those from becoming a mail every lease all week.
  A week out of claims with nothing sent, and no claim live, is logged at error level on every tick, and `GET /admin/identifier-sweep` shows where the week stands.
- **It reports and never repairs.**
  It writes `sweep_stamps` and its own `audit_log` rows (the weekly claims and sends, an administrator's rescreen request).
  It edits no dataset, files no GitHub issue, and mails no depositor and no requester.
  There is no immediate mail per finding: the weekly report is the guarantee, and the finding was public before the sweep found it.
- **Production only.**
  The tick and the weekly report are wired inside the 30-minute tick's production guard, are absent from `DEV_CRON_ALLOWLIST`, and refuse outside production on their own; the report's mail also goes through `getAdminEmailsForCategory`'s fence.
  `GET /admin/identifier-sweep` renders the report on demand and sends nothing; `POST /admin/identifier-sweep/:id/rescreen` is a D1 write the production tick answers.
  Both are safe on staging.

## Consequences

- Every published dataset comes due again 21 days after its last verdict (and is reported lapsed at 28), a new version within a tick or two of being noticed, and the admins hear every week what that came to.
- **Budgets.**
  Per tick: at most one token mint and three `repository_dispatch` calls against REST `core`, and about twenty D1 statements; per screen, the runner's ranged S3 GETs and git clone spend no REST budget.
  The weekly report is two D1 reads over the in-scope rows and one Resend call per admin.
  Capacity is about 144 dispatches a day; the first pass over roughly 850 public datasets takes about six days, and steady state is about 40 a day.
- **Rollout depends on ADR 0086's.**
  Until the workflow and the script are released, every attempt ends `unreported` or `workflow-failed`, and the report says so; that is the designed degradation.
  There is deliberately no on/off variable (the lesson of `AUTO_IMPORT_ENABLED`, ADR 0053).
  To pause screens, disable `run-identifier-screen.yml`, which pauses the publication screen too, and the report shows the sweep as not reporting.
- The public run list shows that the sweep screened a dataset, never what it found.
  A version change and a failed run already show in public; an administrator's rescreen shows as one more run.
- A dataset that is always incomplete (one that outlasts the deadline, say) stays `unchecked` and keeps the report's attention until a person deals with it; that is the intended pressure, not noise.
- A scrubbed dataset (ADR 0085) is listed as flagged until its next screen; the rescreen route is the lever the runbook can use after making it public again.
- The report counts datasets, not runs: only the latest attempt and verdict per dataset are kept, so "screens dispatched this week" is the number of datasets whose latest screen was dispatched in the week.
- The callback reads its body through the same bounded reader as the publication screen's (`routes/callbacks/bounded-json.ts`), so the two cannot drift.

## Alternatives considered

- **Run the fleet scan on a schedule.** A local tool over the public data plane, sampling where a manifest is too large; it would need a host, a credential to report, and would read less than the workflow does.
- **Screen in the Worker.** Rejected in ADR 0086 for subrequest and CPU limits; the same holds for a fleet.
- **Re-screen flagged or incomplete datasets more often.** Would track remediation faster, and would announce which datasets are flagged to anyone reading the public run list.
- **A side table for the sweep.** A cleaner row shape, and a second home for dataset state that ADR 0035 already decided against for sweep bookkeeping; the stamps need no migration.
- **Add a section to the public weekly import issue.** It would put which datasets carry identifiers, or how many, on the public-facing org.
- **Ride `publication_request` for the mail.** An admin who stops watching publication requests has not asked to stop hearing about identifiers in published datasets.
- **Mail each finding at once.** More mail paths for a finding that was already public; the weekly report is the one channel that is guaranteed to arrive.

## Receipts

- Epic #1610, issue #1615 and its design note; ADR 0086 for the workflow and the contract.
- Rules: `backend/src/services/identifier-sweep.ts` (the numbers, the SQL, the tick, the store, the rescreen, the weekly send), `backend/src/services/identifier-sweep-report.ts` (standing, facts, words), `backend/src/routes/callbacks/identifier-sweep.ts`, `backend/src/routes/admin/identifier-sweep.ts`, `backend/src/services/sweep-stamps.ts`.
- Guards: `backend/test/identifier-sweep.test.ts` (scope, slice, in-flight cap, order, the dispatch and its token, the store and every way it refuses, unreported and late reports, failures that leave the verdict alone, verdict-free cadence, the rescreen, the dev fence), `backend/test/identifier-sweep-report.test.ts` (window, standing, words, attention, unknown, once a week, fail closed, retry and cap, the category, the dev fence), `backend/test/identifier-sweep-d1.test.ts` (the statements on Miniflare D1), `backend/test/cron-sweep-wiring.test.ts` (wired inside the tick's production guard).
