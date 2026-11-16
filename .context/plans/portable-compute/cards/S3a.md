# Card S3a: Everything the compute switches open, read from the code, as the input to Q6

Status: ready
Tier: lead
Timebox: M, 4 hours; escalate at 6 hours
Needs: none
Depends: none (read the epic head now; if S2 has merged into `dev` by the time you finish, re-read the files that changed and say which head you read)
Branch: docs/pc-s3a-switch-inventory
Worktree: $WT/nemar-cli-pc-s3a (base origin/feature/portable-compute-epic)
Plan: .context/plans/portable-compute/plan.md, section 4 (S3a, S3), D7; ADR 0118 decision 8, its A1c amendment item 8, its A5 amendment item 10, its P2 amendment item 7; ADR 0121 item 7 and its rollback consequence; open question Q6
Review: one Opus reviewer (not the author); focus: completeness, that no path reachable in production with the switches on and no Tapis secrets fails open or has a side effect outside its own job row

## Goal

One document lists, with file and line, every code path that `COMPUTE_ENABLED`, `COMPUTE_RUNNERS_ENABLED` and `COMPUTE_PIPELINES_DISPATCH_ENABLED` open, and every compute path that runs in production whatever they say, and states for each what happens with no Tapis secrets, no ACCESS keys and no runtime image set; it ends with a verdict for Q6 against the bar below and a probe table that card S3b runs on staging.

## Context

- The bar before the first production switch (advisor, CP-F; the owner's instruction makes it this card's and S3's acceptance): the epic reaches `main` by a normal release with full CI green; every path the switches open without Tapis secrets fails closed on staging (S3b); C2, L1 and S4 done, with the runner from a signed release and limits enforced; staging drills pass on `nm099996` (kill, revoke, lease expiry, cancel) with zero ledger rows and no Tapis tick touching a runner row (S2D); `policy.runners` stored only after the previous production Worker is out of its rollback window; `maxLiveJobs` starts at 2; production runs QC jobs only, with a small cap, before anything else.
- Start from `backend/src/services/compute-switches.ts` (`computeEnabled`, the runners switch), `backend/test/compute-switches-flag.test.ts`, `backend/src/index.ts` (`scheduled()`, `DEV_CRON_ALLOWLIST`, the production block of the 30-minute tick), `backend/src/routes/compute-runners.ts`, the admin compute routes under `backend/src/routes/admin/`, the launcher callback and outputs routes, the Tapis webhook, the observer and ACCESS reporter, retention, and the tenant sweep; `git grep -n "computeEnabled\|COMPUTE_RUNNERS_ENABLED\|COMPUTE_PIPELINES_DISPATCH_ENABLED\|TAPIS_" -- backend/src shared`.
- ADR 0118's A1c amendment item 8 says `COMPUTE_ENABLED` is not turned on anywhere until the launcher's decoder is in nemar-process AND the owner items recorded on nemarOrg/nemar-process#9 are settled; those items are about registering Tapis application definitions and publishing launcher zips. Whether that block binds a runner-only deployment (staging or production) is a question this card must answer, not assume.

## Scope

- One new file, `.context/plans/portable-compute/s3a-switch-inventory.md`, in a docs PR into `feature/portable-compute-epic`; no code change. The leak check of `cards/README.md` on it.

## Decided design

Settled, the document's sections:
1. **Head read**: the commit, and for every row below the file and line on it.
2. **Gated paths**: one table row per route, cron, queue consumer or callback a switch gates: the switch(es), who can reach it (anonymous, a person, an administrator, the owner, a runner, a launcher token), what it writes, and its behavior with no `TAPIS_USERNAME`, `TAPIS_PASSWORD`, `TAPIS_SERVICE_TOKEN`, no ACCESS keys and no `COMPUTE_RUNTIME_IMAGE`: `fails closed` (a refusal word, no write), `fails open`, or `side effect` (say which).
3. **Ungated production paths**: every compute cron or handler that runs in production whatever the switches say (ADR 0118 A5 item 10 says the crons read no switch), with the same columns; say what each does today in production with no compute rows, and what it would do to a runner row (a runner row must never be advanced, cancelled or settled by a Tapis mechanic: `executor = 'tapis'` in each selection, with the line).
4. **What a person reaches**: whether any route a non-administrator can call becomes reachable with `COMPUTE_ENABLED` on, on this head and on #2116's head (`gh pr view 2116 --json headRefOid`), since #2116 may land first.
5. **The registration block**: ADR 0118 A1c item 8 and the nemar-process#9 owner items, each marked settled, unsettled, or Tapis-only (with the evidence); a recommendation, and if the block is read as Tapis-only, a draft of the dated amendment to ADR 0121 (proposed) that says so, as text in this document, not applied.
6. **Rollback**: which policy keys a production Worker from before the epic cannot read (`policy.runners`), the rule for storing it (store only when the production Worker's previous deployment also reads it, so a one-step rollback cannot land on a Worker that fails every compute path closed; ADR 0118 P2 item 7's recovery), and the alternative of a code default of 2 (owner question OQ2 of `cp2-note-S.md`).
7. **Probe table for S3b**: for every gated path in section 2, one literal request against `$STAGING_API` (a `bun run src/index.ts ...` command or a `curl` with the header the route needs), the account it uses (staging administrator, staging owner, anonymous, a revoked runner token), and the expected status and refusal word with the switches on and no Tapis secrets.
8. **Verdict for Q6**: one of "safe with the bar", "safe with these extra conditions" (listed), or "not safe" (the failing paths), and the recommended default for Q6 (the advisor recommends option A with the bar; say whether this reading agrees).
The implementer may choose: table layout.

## Acceptance

- The document exists with the eight sections; every row has a file and line that `git show <head>:<file> | sed -n '<line>p'` confirms (the reviewer samples ten rows and quotes them).
- The probe table has one row per gated path in section 2, and none uses a production host or key.

## Gates

- `bun test test/adr-index.unit.test.ts` (unchanged), and the leak check of `cards/README.md` on the new file, all three commands printing nothing.

## Stop conditions

- A path fails open or writes outside its own job row with the switches on and no Tapis secrets: record it in section 8 as "not safe", and notify the manager at once (it blocks S2S's staging switches, not only production).
- Answering needs a production read (a stored policy, a secret's presence): do not read; write the owner command that would answer it in section 6 or 5.

## Report

At most 25 lines: PR, head read, counts of gated and ungated paths, every `fails open` or `side effect` row, the registration-block recommendation, and the Q6 verdict in one line.
