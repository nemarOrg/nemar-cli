# pAMICA same-seed parity

<!--
manager-loop board: state only, history goes to the -log file beside it, specs to the plan and cards.
Write through the helper (manager_board.py set, tick, ask, propose, spend) and run `check` after any hand edit.
The owner owns Parity, Slots, and Budget limits: the manager proposes changes there, never makes them.
These are the defaults; the owner's approval of the plan accepts them.
Step states: outline (not dispatchable), todo, active, review, blocked, owner (waits on the owner), done, dropped.
In Steps and Questions, the first column holds each row's identifier (ID); in Steps, PR holds the pull request (PR) number.
-->

## Now

| Key | Value |
|---|---|
| Plan | .context/plans/pamica-fixes/plan.md |
| Repo | sccn/pAMICA |
| Integration branch | per Q1: feature/issue-EPIC-nemar-parity (A) or dev (B) |
| Manager id | - |
| State | paused |
| Cadence | 30m with workers running, 60m waiting on people |
| Last tick | - |
| Next tick | - |
| Stop when | every step done, or all remaining work waits on the owner |
| Created | 2026-11-14T11:19-08:00 |

## Parity

| Tier | Claude | Codex | Copilot | Notes |
|---|---|---|---|---|
| worker | Sonnet high | gpt-6-luna max | balanced coding model | routine cards from a detailed plan |
| worker-hard | Sonnet xhigh | gpt-6.1-terra xhigh | balanced reasoning model | protocol, concurrency, security, contract work |
| lead | Opus xhigh | gpt-6.1-sol xhigh | strong reasoning model | default for planning, design, first-level advice |
| frontier | Fable | gpt-6-astra xhigh | strongest model | only when the owner asks, for long-horizon planning, or a frontier trigger the plan lists |
| reviewer | Opus high | gpt-6.1-sol high | strong reasoning model | owner, 2026-11-14: reviews run on the claude-opus slot, one Opus reviewer per round |
| owner | the owner (a person) | - | - | operator and release steps (PA-07, PA-10); no slot takes this tier, so they are never dispatched |

## Slots

| Slot | Platform | Tiers | Max | Can | Notes |
|---|---|---|---|---|---|
| claude-sonnet | Claude | worker, worker-hard | 1 | network, mps | the one implementer (owner, 2026-11-14); no computer use, no visible runs |
| claude-opus | Claude | lead, reviewer | 1 | network, mps | planning, verification design, every review, the advisor (owner, 2026-11-14); shares the account with the NEMAR board |

## Budget

| Item | Limit | Used | Resets | Notes |
|---|---|---|---|---|
| Agents today | 8 | 0 | daily | every dispatch (implementer, reviewer, fix round, lead card, advisor); small because the account's weekly limit is shared with NEMAR |
| Agents total | 40 | 0 | never | the whole pack (rabbit-hole guard R2); at the limit stop and ask |
| Advisor consults | 3 | 0 | never | lead tier (Opus); frontier never unless the owner asks |

## Waves

| Wave | Goal | Agents | State | Exit gate |
|---|---|---|---|---|

## Steps

| ID | Title | Wave | Tier | Needs | Slot | State | Depends | PR | Started | Timebox | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PA-01 | [Parity checks on every PR, green (#369)](cards/PA-01.md) |  | worker-hard | network |  | todo |  |  |  | 8h | dispatch first; step 4 waits for Q3 |
| PA-05 | [did_converge_ and OOM that propagates](cards/PA-05.md) |  | worker-hard | network, mps |  | blocked |  |  |  | 4h | waits for Q2; then set todo |
| PA-02 | [Native shared start and threads (#358)](cards/PA-02.md) |  | worker-hard | network |  | todo | PA-01 |  |  | 6h | after PA-01 merges |
| PA-06 | [File three pre-written issues](cards/PA-06.md) |  | worker | network |  | todo | PA-02 |  |  | 1h | after PA-02 merges; no review agent |
| PA-03 | [Same-seed parity gates per backend (#359)](cards/PA-03.md) |  | worker-hard | network, mps |  | todo | PA-01, PA-02 |  |  | 10h | after PA-01 and PA-02 merge |
| PA-04 | [RUNAMICA15, run_record(), determinism](cards/PA-04.md) |  | worker-hard | network |  | todo | PA-02, PA-05 |  |  | 6h | after PA-02 and PA-05 merge |
| PA-08 | [Checkpoint CP-A (lead)](cards/PA-08.md) |  | lead | network |  | todo | PA-03 |  |  | 2h | after PA-03 merges or on 2026-11-21 |
| PA-07 | [Owner: CUDA parity, determinism, OOM](cards/PA-07.md) |  | owner |  |  | blocked | PA-03, PA-04, PA-05 |  |  | 1h | set owner when deps are done; never dispatched |
| PA-10 | [Owner: epic into dev, minor release](cards/PA-10.md) |  | owner |  |  | blocked | PA-01, PA-02, PA-03, PA-04, PA-05, PA-06, PA-08 |  |  |  | manager opens the epic PR (Q1 A), then set owner; never dispatched |
| PA-09 | [eegprep: E1 as a gate on the shared seed](cards/PA-09.md) |  | worker-hard | network |  | outline | PA-10 |  |  |  | lead completes at CP-B after eegprep PR 617 merges |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|
| Q1 | PA-01 | Who merges pAMICA step PRs? | A (Recommended): manager squash-merges into epic branch feature/issue-N-nemar-parity after the merge gate, no --admin; owner merges epic into dev / B: every PR targets dev, owner merges each | none | 2026-11-16T12:00 | closed | A, the recommended option (owner, 2026-11-14, in the NEMAR session) (owner, 2026-11-14T11:33-08:00) |
| Q2 | PA-05 | How should pamica report convergence honestly? | A (Recommended): add did_converge_ beside converged_, reword converged_ as usable / B: rename converged_ to usable_ and add did_converge_ (breaking) / C: no new flag | none | 2026-11-16T12:00 | closed | A, the recommended option (owner, 2026-11-14, in the NEMAR session) (owner, 2026-11-14T11:33-08:00) |
| Q3 | PA-01 | #369: how should the A-freeze oracle test's noise floor be fixed? | A (Recommended): floor = max(thread floor, build floor shim vs v0.4.0 asset), bound 10x, control >100x / B: keep thread floor, advisor investigates 1.14e-6 / C: xfail strict until PA-03 | none | 2026-11-16T12:00 | closed | A, the recommended option (owner, 2026-11-14, in the NEMAR session) (owner, 2026-11-14T11:33-08:00) |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
