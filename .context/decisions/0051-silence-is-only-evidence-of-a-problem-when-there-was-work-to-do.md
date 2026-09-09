# ADR 0051: Silence is only evidence of a problem when there was work to do

**Status:** accepted
**Date:** 2026-09-09
**Owner:** Seyed Yahya Shirazi

## Context

Auto-import was disabled on 2026-07-21 UTC (committed 2026-07-20 local) and stayed off for seven weeks. Every component behaved
correctly. No component's job was to notice that **nothing was happening**. ADR 0049 and ADR 0050
improved how a failure is described and how its tracking issue drains; neither would have detected
this, because there were no failures to describe.

The catalog's own history, read on 2026-09-09, is the shape of the problem:

```
on008768  2026-09-08 22:30   <- 9 imports in 6 hours after #1308 re-enabled the flag
on008257  2026-09-08 16:26
nm000281  2026-08-24 20:54   <- a NEMAR dataset landed MID-OUTAGE
on007763  2026-07-06 02:31   <- the last import before a 64-day gap
```

Two facts from that, both of which constrain the rule:

1. **Catalog growth is not evidence the importer works.** `nm000281` arrived during the outage
   through the ordinary upload path. Anything that keys "is the pipeline alive?" on the catalog
   getting bigger would have read that as health.
2. **`auto_import_dispatch` rows exist only when a dataset was PICKED.** `autoImportTick` returns
   at `if (!picked)` *before* its `INSERT INTO audit_log`. OpenNeuro publishes a few in-scope
   datasets a week against a `*/30` tick, so in a healthy steady state the overwhelming majority of
   ticks write nothing at all and the last dispatch ages without limit.

   The row is written to reserve the slot, which means it lands **before** the hand-off it stands
   for: `getDatasetsToken` and `triggerOpenNeuroOnboard` are eighteen lines later. So a fresh row
   proves the tick ran and chose something, not that GitHub accepted the work. Treating it as proof
   of dispatch leaves a blind spot exactly the size of this epic's founding incident -- if the PAT
   expires or the workflow is renamed, rows keep appearing every 90 minutes while nothing is ever
   imported. That is why the verdict cross-checks the picked id (below) rather than trusting the
   timestamp alone.

Fact 2 is the trap. The obvious rule -- alarm when the last dispatch is older than some threshold
-- would fire on every quiet week. An alarm that fires when nothing is wrong is worse than no
alarm, because it gets muted, and then the real one is muted too.

## Decision

**An alarm requires a backlog. Silence alone is never enough.** Every alarming branch is gated on
the count of in-scope OpenNeuro datasets that NEMAR has never attempted; dispatch age only
converts an existing backlog into an alarm. In steady state with an empty backlog the sweep is
`healthy` no matter how old the last dispatch is.

**A disabled importer with a backlog alarms, and the report names the flag.** `AUTO_IMPORT_ENABLED`
was not `"true"` for the entire outage -- that is exactly what #1308 flipped back -- so a rule that
treated "disabled" as an exemption would have missed the incident this sweep was written for. The
distinction that matters is not enabled-versus-disabled, it is whether anything is accruing:

- off, empty backlog -> `healthy`, and the reason records that it is off (a maintenance window)
- off, backlog at or above the threshold -> `alarm`, kind `disabled`, and the reason says the
  importer is *switched off, not broken*, so the reader goes to the config rather than the pipeline

**Three statuses, not two.** `healthy` (checked, fine), `alarm` (checked, not fine), `unknown`
(could not check). `unknown` is load-bearing: the healthy branch CLOSES the tracking issue, so
rendering a discovery or D1 failure as healthy would close a live alarm and leave nothing behind.
A failed read returns before touching GitHub at all, the route answers 502 for it, and the CLI
exits non-zero. "I do not know" and "everything is fine" are different answers all the way out to
the exit code.

**A fresh dispatch row is not proof of life, so the picked id is cross-checked.** The audit row is
written to reserve the slot, before `getDatasetsToken` and `triggerOpenNeuroOnboard`. If the
datasets PAT expires or the onboard workflow is renamed, rows keep appearing every ~30 minutes
while nothing is imported: the clock looks fresh, so `silence` can never fire, and the backlog
would take weeks to cross its standalone threshold. So the dataset the last row NAMES must have
acquired an `import_jobs` row within `COVERAGE_DISPATCH_LOST_HOURS`; if it has not, and it is still
outstanding, the verdict is `dispatch-lost`. That is the most specific diagnosis available and it
names the two things to check, neither of which is guessable from the symptom.

**Only outstanding datasets count as backlog.** A dataset with an `import_jobs` row is already
tracked -- by its own failure issue (ADR 0050) or by the retry engine's blocklist -- so counting it
would make the alarm permanent on a set nobody intends to import. Blocklisted is checked
explicitly rather than through `status`, because `import-retry.ts` blocklists a row **without**
changing its status, so a status-only partition misses every blocked row.

But "has a row" is not the same as "is tracked". A `complete` row whose `datasets` row was deleted
(`deleteDatasetCascade` leaves `import_jobs` behind) has no tracker at all, and the importer WILL
re-dispatch it, so it is outstanding work. It goes in a separate `untracked` bucket that counts
toward the alarm, and the report names it honestly rather than claiming a failure issue exists.

**Withdrawals are invisible to this sweep, by construction.** Withdrawal stamps
`datasets.withdrawn_at` rather than deleting the row, so a withdrawn dataset still satisfies
`IMPORTED_SOURCE_IDS_QUERY` and never reaches the diff. #1311 mentions withdrawals only in a
measurement row ("known-blocked/withdrawn by #967"), not as a requested bucket -- and a bucket
would be permanently empty anyway, because a withdrawn dataset genuinely was imported.

**Thresholds:**

```
COVERAGE_DISPATCH_STALE_HOURS = 24   // ~48 missed ticks, well outside jitter
COVERAGE_BACKLOG_ALARM        = 5    // ~2 weeks of accrual at the measured 2.7 in-scope/week
COVERAGE_BACKLOG_ALARM_ALONE  = 20   // alarms even if dispatch looks recent: alive but falling behind
```

**One standing issue, rewritten in place.** Coverage is a property of the pipeline, not of a
dataset, so the title is constant and is the dedup key. The body is overwritten every alarming run
and states that it describes the present rather than a history; a comment is written **only when
the kind changes**. A comment per run would be one notification per day forever, which is the
accrual ADR 0050 exists to prevent, one level up. The live kind is read off the issue's own labels
(`coverage-backlog` / `coverage-silence` / `coverage-disabled`) rather than stored, the same
observable-not-flag discipline as `rollupOpen` in ADR 0050.

## Consequences

Easier: the seven-week failure mode is now detectable, and detectable *specifically* -- the report
distinguishes "switched off", "enabled but stalled" and "dispatching but falling behind", which are
three different fixes. `nemar admin import-coverage` answers the question an operator actually asks
during an incident, and its exit code is usable from a script.

Harder: the alarm is deliberately slow. Five never-attempted datasets is roughly two weeks of
accrual, so a stall is caught in days rather than hours. That is the price of an alarm that never
fires on a quiet week, and the trade is right for a pipeline whose normal cadence is weekly.

**Bounded and cheap:** one GraphQL scan, four D1 reads, and at most four GitHub calls (list, body
PATCH, labels, comment -- three on the recovery path).

The scan's page cap and its `MIN_COVERAGE` refusal stop a *pagination* truncation from reading as a
shrinking backlog, but they do NOT cover field-level degradation: `MIN_COVERAGE` measures raw edge
count, and a snapshot resolver that nulls `summary.modalities` fleet-wide makes every dataset fall
out of the modality filter while coverage still reads 100 percent. That returns an empty in-scope
set with no error, which would have read as a drained backlog. So the sweep additionally refuses a
scan that reports fewer in-scope datasets than D1 has already imported -- a plausibility floor
against its own input, since a real OpenNeuro cannot have fewer in-scope datasets than we have
mirrored from it.

No per-dataset work, so there is no batch limit and no window to rotate -- unlike ADR 0050's sweep.

**No new schema.** The dispatch signal is the audit row the importer already writes, read through
the importer's own `AUTO_IMPORT_GATE_QUERY` so the two cannot disagree about when the last dispatch
was. ADR 0034 and 0035 are satisfied without a column or a stamp: the verdict is fleet-level, so
`audit_log` plus the GitHub issue is the whole durable state.

**A DISABLED importer never closes the issue.** Recovery means the pipeline is working again, and a
switched-off importer is not working. Without this, manually importing a few datasets drops the
outstanding count below the threshold and the monitor closes the only durable record that the
importer is still off -- the founding incident, re-enacted by its own alarm. The record is refreshed
and left open instead.

**Production-only, and not on the dev-cron allowlist.** It files and closes a real issue on the
shared `nemarDatasets` org, so `runImportCoverageSweepCron` carries an `isNonProductionEnv` refusal
and the admin route refuses `apply` outside production independently. The dry run stays available
everywhere, because reading production's coverage from staging is useful and harmless.

Whoever changes the thresholds should know they were set from a measured accrual rate, not chosen
round (the 19-in-seven-weeks figure is #1311's own measurement table): re-measure before moving
them, and note the values are pinned literally in
`backend/test/import-coverage-decisions.test.ts` precisely so a change has to come here first.

**One calibration risk to settle with the first production dry run.** At measurement time the
outstanding count would have included the 19 accrued datasets plus however many of #1311's "23
older, absent for other reasons" carry no `import_jobs` row -- plausibly above
`COVERAGE_BACKLOG_ALARM_ALONE`. If so the first run alarms `backlog` and cannot reach "fewer than 5
outstanding", so the issue would never close on its own: the muting risk this ADR is most worried
about, arriving on day one. Run the dry run before the cron does and read the partition.

## Alternatives considered

- **Alarm on dispatch age alone.** What #1311 literally specifies, and it false-alarms permanently:
  a no-candidate tick writes no audit row, so a healthy quiet week is indistinguishable from a
  stall by that signal. Declined; this is the central design correction of the phase.
- **Never alarm on a disabled importer.** Also #1311's literal text ("a disabled importer is
  reported but not alarmed"). Declined because the importer was disabled for the whole outage, so
  the rule would exempt precisely the incident it was written for. Reported-not-alarmed is kept for
  the case where nothing is accruing.
- **Alarm on any disabled importer.** Simpler, and fires during deliberate maintenance windows when
  nothing is accruing. Declined: same muting problem as dispatch-age-alone.
- **Count catalog growth, or successful imports per week.** Declined on the evidence: `nm000281`
  landed mid-outage, and the import rate is far too bursty for a rate check -- nine in six hours
  during catch-up against zero in a normal quiet week.
- **A per-dataset issue for each never-attempted dataset.** Declined: it is one systemic problem,
  and ADR 0050's rollup exists precisely because per-dataset filing floods a shared repo.
- **Store the last-known coverage verdict in D1** to detect transitions. Declined per ADR 0034
  (derive, don't store): the issue's own labels already carry the live kind, and a stored flag
  drifts against the document it describes.

## Receipts

- Issue #1311 (phase 3 of epic #1306); the outage and the classifier are ADR 0049; the tracking
  issue's own lifecycle is ADR 0050
- Rules: `backend/src/services/import-coverage.ts` (pure), applied by `import-coverage-sweep.ts`
- The dispatch-row gap this turns on: `if (!picked)` in `backend/src/services/auto-import.ts`,
  ahead of the `auto_import_dispatch` insert
- Reused unchanged: `discoverOpenNeuroDatasets`, `getImportedSourceIds` (and its
  `owner_user_id != -1` guard against the 2026-06-20 stall), `diffNewDatasets`,
  `AUTO_IMPORT_GATE_QUERY`, `parseSqliteUtc`
- Fail-open-on-the-read precedent: `backend/src/services/zarr-fidelity-sweep.ts` (issue #1068)
- Mutate-before-comment, and the one-issue-updated-in-place rule: ADR 0050
- Counts-and-pointers report shape: ADR 0036
- Operator entry point: `POST /admin/imports/coverage-sweep`, `nemar admin import-coverage`
  (dry run by default; `apply` production-only)
