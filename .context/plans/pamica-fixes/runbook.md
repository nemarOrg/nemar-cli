# Runbook: the manager's tick for the pAMICA parity pack

Follow this literally, with the `project:manager-loop` skill.
`<skill>` is that skill's directory; `B` is the absolute path of `board.md` beside this file; `P` is this pack's directory (`.context/plans/pamica-fixes/` in the nemar-cli worktree on branch `docs/portable-compute-board`, the same worktree as the NEMAR board).
The board helper needs Python 3.10 or newer: every helper call is `uv run --no-project --python 3.12 python -I <skill>/scripts/manager_board.py ...`, written below as `mb`.
Where this runbook and the skill disagree, the skill's "Never" list wins, then this runbook.
Your manager id is `mba-claude-sonnet-pamica`.

## What to read

- **First tick of a session, once, in this order:** this runbook; `P/plan.md` sections 0, 3, 4, 5, 7 and 10; `P/START.md`; `mb status B`; your live-facts file (below). Then the first-tick checklist.
- **Every tick:** `mb status B`, and only the events it points to.
- **Never:** the whole `board-log.md`, large CI logs (grep them for `PARITY`, `floor`, `FAILED`, `passed`), or anything under `.context/plans/portable-compute/` (the NEMAR program's board and cards: never read past its status, never write).
- Read a card only to dispatch it.

## First-tick checklist

1. `date`; `mb tick B --manager mba-claude-sonnet-pamica --state running --next 30m`.
2. `mb check B` passes; `mb card P/cards/*.md` prints "ready to dispatch" for every card except `PA-09.md` (an outline, by design).
3. The live-facts file exists and has `PAMICA`, `WT`, `BASE`, `EPIC` (see "Live facts"); create it if not (Setup).
4. Reconcile every `active` or `review` step with its PR and worktree (the PR and the worktree are right; correct the board and log it).
5. Questions Q1 to Q3: open ones are asked (AskUserQuestion), answered ones acted on.
6. Budget rows: "Agents total" below 40, "Agents today" below 8, "Advisor consults" below 3; the date is before the pack deadline 2026-11-28T17:00 Pacific.

## Tools

| Need | How |
|---|---|
| Dispatch a card | Agent tool, `run_in_background: true`, model from Parity for the card's tier, prompt = `P/cards/README.md` + the card verbatim + live facts |
| Message a running worker | SendMessage to its agent id |
| Review | one Opus reviewer per round (`project:pr-review-toolkit`, reviewer tier), with the lens on the card's Review line, on the `claude-opus` slot |
| Ask the owner | `mb ask`, then AskUserQuestion (at most four questions, one recommended option each) |
| Notify | PushNotification, at most one per event class per day |
| Wake | ScheduleWakeup: 1800 s while a worker runs, 3600 s while waiting on people; `stop: true` when the board is `paused` or `done` |
| Read CI | `gh pr checks <n> -R sccn/pAMICA`, and the log command below the table |

CI log command (grep, never read a whole log): `gh run view <id> -R sccn/pAMICA --log | grep -E "PARITY|floor|FAILED|passed|SHA"`.

Slots are one `claude-sonnet` (implementers) and one `claude-opus` (reviews, the lead card PA-08, outline completion, advisor): never two Sonnet or two Opus agents at once.

## Live facts added to every dispatch

From a mode-0600 file in your own scratch directory, never committed: `PAMICA` (the pAMICA primary checkout the owner names in START.md's answers or the session; never edited), `WT` (a directory named `pAMICA-worktrees` beside it), `BASE` (`feature/issue-$EPIC-nemar-parity` when Q1 is A, `dev` when Q1 is B), `EPIC` (the epic issue number).
Add at dispatch: the answers to Q1 to Q3 the card names, `git -C "$PAMICA" ls-remote origin "$BASE"` head, and the open PRs touching the card's Scope (`gh pr list -R sccn/pAMICA --state open`).
Paths and host facts never go into the board, a commit, a PR or an issue.

## Setup (once, before the first dispatch; the owner's approval of the plan accepts every value below)

1. `date`.
2. Commit the pack in the board worktree, only this pack's paths: `git -C <board worktree> add .context/plans/pamica-fixes && git -C <board worktree> commit -m "docs: pamica parity plan pack" -- .context/plans/pamica-fixes`. No push until a checkpoint (then with `[skip ci]`, to `docs/portable-compute-board`).
3. Post the epic issue from `plan.md` Appendix A: write the body to a file in your scratch, run the leak check from `cards/README.md` on it, then `gh issue create -R sccn/pAMICA --title "Epic: same-seed parity with the Fortran reference, and reproducible run records" --body-file <file>`; `mb decide "epic issue #<n>" --by manager`; write `EPIC` into the live-facts file.
4. Ask Q1, Q2 and Q3 in one AskUserQuestion batch (they are already recorded on the board).
5. When Q1 is answered A: `git -C "$PAMICA" fetch origin && git -C "$PAMICA" push origin origin/dev:refs/heads/feature/issue-$EPIC-nemar-parity`; set `BASE`; `mb set B Now "Integration branch" Value=feature/issue-$EPIC-nemar-parity`.
   When answered B: `BASE=dev`; PRs wait for the owner's merge (set the step `owner` after the merge gate passes).
6. `mb card P/cards/*.md`; every card but PA-09 must pass.

## The tick

1. `date`; `mb tick B --manager mba-claude-sonnet-pamica` (first tick of a session: `--state running --next 30m`).
2. First tick of a session: the first-tick checklist.
3. `mb status B`.
4. Collect events: worker reports, `gh pr checks`, review results, owner answers, the dates below.
5. Handle them with the handlers below, in the skill's order.
6. Fill the free slot from the dispatch plan. Before each dispatch: `mb card`, `mb spend B "Agents today"`, `mb spend B "Agents total"`; then dispatch, `mb set` the step `active` with its slot and Started, and add its Agents row.
7. Contribute (the skill's closed checklist). 8. Ask if needed.
9. `mb log` one line per event; commit the board, only this pack's paths (`git ... commit -m "docs: pamica board, <what>" -- .context/plans/pamica-fixes`; on `index.lock`, wait 10 seconds and retry once); `mb tick B --next <cadence>`; ScheduleWakeup.

## Event handlers

**A report arrives.** Verify by observation, in order, stopping at the first failure: the PR's head and base (`gh pr view <n> -R sccn/pAMICA --json headRefOid,baseRefName`); the diff inside the card's Scope (`gh pr diff <n> -R sccn/pAMICA --name-only`); the card's Acceptance (run the local commands yourself in its worktree; read the named CI run's log on the final head and grep the quoted lines); a revert check or negative control per fix; deviations triaged.
Then start the Opus review while CI runs (spend "Agents today" and "Agents total" first; the same for every fix round and advisor). PA-06 and PA-08 get no review agent: their acceptance is checked by you. Send back, inside the round: a value given as measured that was computed, a threshold changed, a test that cannot fail, a PR body replaced instead of extended.

**A review returns.** Every finding gets an outcome per `project:pr-review-toolkit`'s convergence rules; at most two rounds (R4). A finding that would change a pre-registered threshold or the floor rule goes to the advisor, never to a fix.

**The merge gate.** Every review report in with each finding resolved, no accepted Critical open, and `gh pr checks <n> -R sccn/pAMICA` green on the final head (every check, including both `parity` legs once PA-01 has merged).
A PR whose body says it is test-only or CI-only gets `gh pr edit <n> -R sccn/pAMICA --add-label skip-changelog` before the gate is read. Q1 A: `gh pr merge <n> -R sccn/pAMICA --squash --delete-branch` into `$BASE`, never `--admin`; a refused merge is not retried: set the step `owner` and ask. Q1 B: set the step `owner` with Next "owner merges PR <n> into dev".

**PA-01 reaches its step 4 without Q3.** The worker stops and reports the measurement; set PA-01 `blocked` (Next: "Q3"), notify once; on the answer, resume the same worker (or a fresh one with the continuation line) with Q3's answer as a live fact.

**Q3 answered B, or PA-01 reports torch above the larger floor.** One advisor consult (`mb spend B "Advisor consults"`), brief per `references/escalation.md`, with the floor lines from both legs; the verdict goes to the owner as a question; PA-03 still proceeds (its gates do not depend on that test).

**Q2 answered.** `mb decide`, then `mb set B Steps PA-05 State=todo`.

**A parity budget is exhausted (R5).** Expect it in the report: the Appendix B issue number, the docs row and, for a slow tier, the `xfail(strict=True)` marker. Verify the issue text has measured numbers and no host details. The step can still be `done`.

**PA-03 and PA-05 and PA-04 are done.** Set PA-07 `owner`; notify the owner once: "PA-07 is ready: the CUDA commands are in cards/PA-07.md". When the owner pastes the output: `mb decide` the lines; if a threshold is missed, post Appendix B filled with the owner's numbers (plan section 0, item 7); set PA-07 `done`.

**PA-01 to PA-06 and PA-08 are done.** With Q1 A, open the epic PR (never merge it): `gh pr create -R sccn/pAMICA --base dev --head feature/issue-$EPIC-nemar-parity --title "Merge epic #$EPIC: same-seed parity and run records" --body-file <file listing the merged PRs and the tier table from cp-a-note.md>`. Set PA-10 `owner` and notify once with `cards/PA-10.md`.

**PA-10 is done** (the owner reports the release). `mb decide` the version; notify once: "pamica <version> released; NEMAR's pins (eegprep PX-03 successor, nemar-process PX-05 and PX-06) need a bump: that is the NEMAR program's work, not this pack's." CP-B: dispatch the lead (the `claude-opus` slot, budget spent) to complete `cards/PA-09.md` only when `gh pr view 617 -R sccn/eegprep --json state` says `MERGED`; until then PA-09 stays `outline` with that Next.

**A timebox expires.** At the timebox nudge once; at twice the timebox, one advisor consult (R3).

**A worker goes silent.** Implementer 45 minutes without a commit or message (a running CI wait it reported counts as a message), reviewer 20 minutes: nudge once, then redispatch with an inventory.

**A check fails.** Caused by the diff: the worker's two fix rounds, then the advisor with the log. Not caused by the diff (fails on the base, infrastructure, flaky): one `gh run rerun <id> -R sccn/pAMICA --failed`, then file nothing yourself; tell the lead in a `propose`.

**An owner answer arrives.** Act, `mb decide <text> --by owner`, set the question `closed`; if it contradicts a card, the lead corrects the card before dispatch (an Opus dispatch on the `claude-opus` slot, counted in the budget).

**A question passes its "needed by" time unanswered.** Notify once with what waits; no defaults.

**2026-11-21, or PA-03 merged.** Dispatch PA-08 (CP-A) on the `claude-opus` slot.

**2026-11-28T17:00 Pacific (R7).** Dispatch nothing new; for every open step, post nothing yourself: list them in one notification; `mb tick B --state paused`; ScheduleWakeup with `stop: true`.

## Rabbit-hole guard (plan section 7, applied here)

- Never add a Steps row; never dispatch a proposal the lead or owner has not accepted.
- At any Budget limit, stop dispatching and ask; never raise a limit.
- At most two review rounds and two fix rounds per card; then outcomes, not more rounds.
- A parity tier that misses after two approaches or six hours is "not attained", not a new card.
- Stop when every step is `done` or `dropped`, or everything left waits on the owner: `mb tick B --state paused`, one notification naming what waits, ScheduleWakeup `stop: true`.

## Never (the skill's list, plus)

- Never merge into `dev` or `main`, never tag, release or publish, never run `scripts/sync_version.py`, never edit a `version` field, never use `--admin`.
- Never write anything under `.context/plans/portable-compute/` or touch the NEMAR board, its cards or its questions.
- Never download or run an AMICA binary on this machine; Fortran comparisons happen in GitHub Actions or in the owner's PA-07 run.
- Never ssh anywhere; never ask an agent to.
- Never write a host name, user, path or address into the board, a commit, a PR or an issue.
- Never change a pre-registered threshold, the floor rule D4, a card, the plan, the parity or a budget limit.
- Never post an issue yourself other than Appendix A and Appendix B (plan section 0, item 7); implementers post only the texts their cards pre-write.
