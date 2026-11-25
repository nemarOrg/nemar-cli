# Publication queue (epic #2182): decide + evidence

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
| Plan | /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/epic-publication-queue/.context/plans/publication-queue/plan.md |
| Repo | nemarOrg/nemar-cli |
| Integration branch | feature/issue-2182-epic-pq-decide, feature/issue-2182-epic-pq-evidence |
| Manager id | mba-claude-opus |
| State | running |
| Cadence | 30m with workers running, 60m waiting on people |
| Last tick | 2026-11-25T11:12-08:00 |
| Next tick | 2026-11-25T11:42-08:00 |
| Stop when | every step done, or all remaining work waits on the owner |
| Created | 2026-11-25T11:07-08:00 |

## Parity

| Tier | Claude | Codex | Copilot | Notes |
|---|---|---|---|---|
| worker-light | Haiku max | gpt-6-luna max | cost-efficient coding model | clear, repeatable cards from a fully specified brief |
| worker | Sonnet 5.5 xhigh | gpt-6-luna max | balanced coding model | owner rule: Sonnet implements from an approved plan |
| worker-hard | Opus 5.5 high | gpt-6.1-terra xhigh | balanced reasoning model | untrusted-input parsers, contracts, auto-deny |
| lead | Opus 5.5 xhigh (this session) | gpt-6.2-sol xhigh | strong reasoning model | default for planning, design, first-level advice |
| frontier | Fable | gpt-6.2-astra xhigh | strongest model | only when the owner asks, for long-horizon planning, or a frontier trigger the plan lists |
| reviewer | Sonnet 5.5 | gpt-6-luna max | balanced coding model | owner rule: Sonnet for PR review agents |
| owner | person |  |  | owner actions; never dispatched |

## Slots

| Slot | Platform | Tiers | Max | Can | Notes |
|---|---|---|---|---|---|
| claude-worker | Claude | worker-light, worker, worker-hard, reviewer | 3 |  | graphical user interface (GUI) or computer use only with the owner's announced consent |
| claude-opus | Claude | lead | 1 | gui, browser | |
| codex | Codex | worker-light, worker, worker-hard, lead | 0 | | owner opens this slot; never computer use or visible runs |

## Budget

| Item | Limit | Used | Resets | Notes |
|---|---|---|---|---|
| Agents today | 40 | 3 | daily | implementers, reviewers, advisors spawned; the plan approval covers this limit |
| Agents this wave | 15 | 0 | wave | items x (1 + review panel + 1 delta + fix rounds) + 1 advisor |
| Advisor consults | 3 | 0 | never | lead tier; frontier only when the owner or the plan says |

## Waves

| Wave | Goal | Agents | State | Exit gate |
|---|---|---|---|---|

## Steps

| ID | Title | Wave | Tier | Needs | Slot | State | Depends | PR | Review | Started | Timebox | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| O1 | Approve the 3 clean requests (checkpoints.md O1) |  | owner |  |  | owner |  |  |  |  |  | owner runs the O1 commands |
| O3 | 37 blocked on ethics statement: depositor remedy (O3) |  | owner |  |  | owner |  |  |  |  |  | owner tells the depositor |
| D1 | [License lineage](cards/D1.md) |  | worker-hard |  | claude-worker | active |  |  |  | 2026-11-25T11:12 | 2d | implementer running |
| D2 | [Measure every blocker, HEAD+history](cards/D2.md) |  | worker |  | claude-worker | active |  |  |  | 2026-11-25T11:12 | 1d | implementer running |
| A1 | [Coverage contract and registry](cards/A1.md) |  | worker-hard |  | claude-worker | active |  |  |  | 2026-11-25T11:12 | 3d | implementer running |
| D4 | [Quiet paced re-screen](cards/D4.md) |  | worker |  |  | todo |  |  |  |  | 1d | dispatch |
| A3 | [Pure-TS HDF5 metadata reader](cards/A3.md) |  | worker-hard |  |  | todo |  |  |  |  | 2d | dispatch |
| D0 | [Review in prod, shadow 20](cards/D0.md) |  | lead |  |  | owner |  | 2370 |  |  | 4h | draft PR; owner confirms item 7 query, ADR 0105 q, items 5/6/8, cap |
| B2 | ADR 0139 auto-deny (draft on decide branch) |  | lead |  |  | done |  |  |  |  |  | accepted 2026-11-25 |
| A2 | [BrainVision and NIRx](cards/A2.md) |  | worker-hard |  |  | todo | A1 |  |  |  | 1d | after A1 |
| A4 | [SNIRF and generic HDF5](cards/A4.md) |  | worker-hard |  |  | todo | A1, A3 |  |  |  | 1.5d | after A1, A3 |
| A6 | [ZIP archives](cards/A6.md) |  | worker-hard |  |  | todo | A1 |  |  |  | 1d | after A1 |
| A9 | [nemar dataset screen](cards/A9.md) |  | worker |  |  | todo | A1 |  |  |  | 1d | after A1 |
| A5 | [MAT, EEGLAB, Homer .nirs](cards/A5.md) |  | worker-hard |  |  | todo | A1, A4 |  |  |  | 2d | after A4 |
| D3 | Batch acknowledgment by documented group |  | worker-hard |  |  | outline | D2 |  |  |  |  | CP-D1 |
| B3 | [Resubmission note](cards/B3.md) |  | worker |  |  | todo | B2 |  |  |  | 1d | ready (B2 done) |
| B4 | [Review inputs and record](cards/B4.md) |  | worker-hard |  |  | todo | D1, B2 |  |  |  | 2d | after D1 |
| B5 | [Auto-deny and ready mail](cards/B5.md) |  | worker-hard |  |  | todo | B2, B3, B4, D4 |  |  |  | 2.5d | after B3, B4, D4 |
| CPD3 | Seam review; decide epic to dev; release D |  | lead |  |  | outline | D1, D3, D4, B3, B4, B5 |  |  |  |  | CP-D3 |
| C1 | Calibration in prod shadow mode |  | owner |  |  | outline | CPD3, D0 |  |  |  |  | owner labels |
| A10 | docs.nemar.org pages from copy tables |  | worker |  |  | outline | A2, A4, A5, A6, A9 |  |  |  |  | CP-E1 |
| CPE2 | Seam review; evidence epic to dev; release E; O2 |  | lead |  |  | outline | A10 |  |  |  |  | CP-E2 |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|
| Q1 | - | Raise PLATFORM_DAILY_CAP (50 model calls/day) for the queue? At 50/day ~300 requests take ~1 week; ADR 0139 adds a Sonnet call per fail | Keep 50 for the shadow batch, decide after (Recommended) / Raise to 150 now / Make it an env var you set | none | 2026-11-27T17:00 | open |  |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
| D1 | implementer | claude-worker | Opus 5.5 | D1 | 2026-11-25T11:12 | running |
| D2 | implementer | claude-worker | Sonnet 5.5 | D2 | 2026-11-25T11:12 | running |
| A1 | implementer | claude-worker | Opus 5.5 | A1 | 2026-11-25T11:12 | running |
