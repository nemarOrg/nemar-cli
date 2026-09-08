# ADR 0049: A specific import error is never overwritten by a generic one

**Status:** accepted
**Date:** 2026-09-08
**Owner:** Seyed Yahya Shirazi

## Context

`import_jobs.last_error` is written from four places, and only one of them knows why an
import actually failed:

| writer | message | knows the cause? |
|---|---|---|
| the failing job in `onboard-openneuro.yml` | the CLI's own failure line | yes |
| the workflow's `report` job | `terminal: prepare=... copy=... finalize=...` | no |
| `runImportRecovery` via `markImportStatus` | `quarantined: <reason>` / `auto-rollback: <reason>` | no |
| the 6h stuck-import sweep in `index.ts` | `stuck > 6h (scheduled sweep)` | no |

The three uninformed writers all run **after** the informed one. The `report` job is a
separate job that `needs:` prepare, copy and finalize, and runs on a different runner, so
the tee'd log the failing job wrote does not even exist for it. Recovery and the sweep run
later still. Under plain last-write-wins, the least useful message is therefore guaranteed
to be the one that survives.

That is what happened. Between 2026-07-22 and 2026-09-08 every automated OpenNeuro import
failed, for four distinct causes -- an expired `NEMAR_GITHUB_PAT`, a git-annex bucket
`annex-uuid` collision, a `GH013` branch-protection ruleset, and a rebase conflict -- and
every one of them was recorded in D1 as the same string:
`terminal: prepare=failure copy=failure finalize=failure`. None was diagnosable without
opening Actions logs by hand, and nobody did for seven weeks.

The damage was not only diagnostic. `IMPORT_RETRY_CANDIDATES_QUERY` re-selects a
**quarantined** row only when its `last_error` still contains the literal
`[openneuro-upstream-inaccessible]` marker. Recovery's own
`quarantined: upstream_inaccessible` does not contain that bracketed string, so recovery
destroyed the marker the retry engine depends on and made those datasets permanently
un-retryable. The existing test for that query passed because its fixture was hand-written
as `quarantined: <marker>` -- a string no writer produces -- so it asserted the intent
rather than the behaviour.

A narrower version of this rule already existed twice, hardcoded to that one marker (#808).
It was written as a special case; the general rule was never stated, so the third writer
never got it.

## Decision

A **specific** error message is never overwritten by a **generic** one. `last_error` holds
the best available diagnosis, not the most recent write.

"Generic" is a closed, declared set: null or blank, plus the bookkeeping prefixes the
pipeline writes when it has no diagnosis (`terminal: `, `quarantined: `, `auto-rollback: `,
`stuck > 6h`). Everything else is specific. A specific incoming message always wins, so a
later, better diagnosis still replaces an earlier one.

The rule lives once, in `backend/src/services/import-error.ts`, as a pure function plus the
SQL fragment that expresses the same decision, and all three write sites use it. The upstream
marker stops being a special case and becomes one instance of "specific".

Nothing is lost by not writing the bookkeeping string: `runImportRecovery` already records
its full decision in `audit_log`, which is where it belongs.

## Consequences

Easier: a failure is diagnosable from D1 alone, which is what makes the failure classifier
(`import-failure-cause.ts`) and the tracking issues worth reading. Quarantined
upstream-inaccessible rows stay retryable. The three write sites can no longer drift, because
the predicate is imported rather than retyped.

Harder: `last_error` no longer tells you what the pipeline last *did* to a row -- only why it
failed. Read `audit_log` for the recovery decision. Anyone adding a new writer of a
bookkeeping message must add its prefix to `GENERIC_IMPORT_ERROR_PREFIXES`, or their message
will be treated as a diagnosis and start winning over real ones. That coupling is deliberate
and the constant carries the warning.

The message is bounded to a single truncated line at the source, per ADR 0036: operational
rows carry counts and pointers, not unbounded text. The pointer to the full story is
`workflow_run_url`, already on the row.

## Alternatives considered

- **Keep the marker special case and add more special cases as needed.** What existed. It
  failed exactly as you would expect: the rule was never stated, so the third write site was
  written without it, and the one dependent query broke silently. Special-casing the symptom
  does not generalise to the four causes we now know about.
- **Append rather than replace, keeping a history in the column.** Preserves everything, but
  grows unboundedly in an operational row (against ADR 0036) and makes the `LIKE` predicates
  the retry engine depends on ambiguous.
- **Let the report job post nothing when a specific message already exists.** Cannot work: the
  report job runs on a different runner with no access to the failing job's log, and no
  knowledge of what is already stored. The decision has to be made where the data is, which is
  the database.

## Receipts

- Incident and root cause: epic #1306; the seven-week outage began with #967's disable
- Narrower predecessor: #808, the sticky upstream marker
- The stranding bug this fixes, and its fabricated test fixture:
  `backend/src/services/import-recovery.ts` `markImportStatus`,
  `backend/test/import-retry.test.ts`
- Regression pinned end to end in `backend/test/import-error.test.ts`, driving the real
  `runImportRecovery`
- Message-size bound: ADR 0036
