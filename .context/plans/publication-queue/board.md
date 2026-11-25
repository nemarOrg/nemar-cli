# Publication queue (epic #2182)

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
| Integration branch | feature/issue-2182-epic-publication-queue |
| Manager id | - |
| State | paused |
| Cadence | 30m with workers running, 60m waiting on people |
| Last tick | - |
| Next tick | - |
| Stop when | every step done, or all remaining work waits on the owner |
| Created | 2026-11-25T10:55-08:00 |

## Parity

| Tier | Claude | Codex | Copilot | Notes |
|---|---|---|---|---|
| worker-light | Haiku max | gpt-6-luna max | cost-efficient coding model | clear, repeatable cards from a fully specified brief |
| worker | Sonnet 5.5 xhigh | gpt-6-luna max | balanced coding model | owner rule: Sonnet implements from an approved plan |
| worker-hard | Opus 5.5 high | gpt-6.1-terra xhigh | balanced reasoning model | parsers of untrusted input, contracts, auto-deny |
| lead | Opus 5.5 xhigh (this session) | gpt-6.2-sol xhigh | strong reasoning model | default for planning, design, first-level advice |
| frontier | Fable | gpt-6.2-astra xhigh | strongest model | only when the owner asks, for long-horizon planning, or a frontier trigger the plan lists |
| reviewer | Sonnet 5.5 | gpt-6-luna max | balanced coding model | owner rule: Sonnet for PR review agents |

## Slots

| Slot | Platform | Tiers | Max | Can | Notes |
|---|---|---|---|---|---|
| claude-worker | Claude | worker-light, worker, worker-hard | 3 | gui, browser | graphical user interface (GUI) or computer use only with the owner's announced consent |
| claude-opus | Claude | lead | 1 | gui, browser | |
| codex | Codex | worker-light, worker, worker-hard, lead | 0 | | owner opens this slot; never computer use or visible runs |

## Budget

| Item | Limit | Used | Resets | Notes |
|---|---|---|---|---|
| Agents today | 40 | 0 | daily | implementers, reviewers, advisors spawned; the plan approval covers this limit |
| Agents this wave | 15 | 0 | wave | items x (1 + review panel + 1 delta + fix rounds) + 1 advisor |
| Advisor consults | 3 | 0 | never | lead tier; frontier only when the owner or the plan says |

## Waves

| Wave | Goal | Agents | State | Exit gate |
|---|---|---|---|---|

## Steps

| ID | Title | Wave | Tier | Needs | Slot | State | Depends | PR | Review | Started | Timebox | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| O1 | Owner approves the 3 clean requests (nm000630 nm000566 nm000979) |  | owner |  |  | owner |  |  |  |  |  | owner reads each screen and approves |
| A1 | [Coverage contract and reader registry](cards/A1.md) |  | worker-hard |  |  | todo |  |  |  |  | 2d | dispatch |
| A3 | [Pure-TS HDF5 metadata reader](cards/A3.md) |  | worker-hard |  |  | todo |  |  |  |  | 2d | dispatch |
| B1 | [Upstream license lineage](cards/B1.md) |  | worker-hard |  |  | todo |  |  |  |  | 2d | dispatch |
| A7 | [Measure image-or-document blockers](cards/A7.md) |  | worker |  |  | todo |  |  |  |  | 4h | dispatch |
| A4 | [SNIRF and generic HDF5](cards/A4.md) |  | worker-hard |  |  | todo | A1, A3 |  |  |  | 1.5d | after A1 and A3 |
| A2 | [BrainVision and NIRx text headers](cards/A2.md) |  | worker |  |  | todo | A1 |  |  |  | 1d | after A1 |
| A5 | [MAT v5, EEGLAB, Homer .nirs](cards/A5.md) |  | worker-hard |  |  | todo | A1, A3 |  |  |  | 2d | after A1 and A3 |
| A6 | [ZIP archives](cards/A6.md) |  | worker |  |  | todo | A1 |  |  |  | 1d | after A1 |
| A9 | [nemar dataset screen, local reproduction](cards/A9.md) |  | worker |  |  | todo | A1 |  |  |  | 1d | after A1 |
| A8 | Image and document policy change |  | worker |  |  | outline | A7, A1 |  |  |  |  | CP1 after owner answers Q-A8 |
| A10 | docs.nemar.org pages generated from copy tables |  | worker |  |  | outline | A2, A4, A5, A6, A9 |  |  |  |  | CP1 |
| CP2 | Seam review of track A; epic to dev; Release 1; O2 re-screen |  | lead |  |  | owner | A2, A4, A5, A6, A8, A9, A10 |  |  |  |  | owner merges and releases |
| B2 | ADR: auto-deny, model inputs, resubmission note, ready mail |  | lead |  |  | todo |  |  |  |  | 4h | lead drafts; owner approves |
| B3 | Resubmission note on the publication request |  | worker |  |  | outline | B2 |  |  |  |  | CP3 |
| B4 | Review inputs and reproducibility fields |  | worker-hard |  |  | outline | B1, B2 |  |  |  |  | CP3 |
| B5 | Auto-deny as nemarAdmin; ready-to-approve mail |  | worker-hard |  |  | outline | B2, B3, B4 |  |  |  |  | CP3 |
| C1 | Calibration on a labeled queue sample (dev) |  | lead |  |  | outline | B5 |  |  |  |  | CP4 |
| C2 | Release 2; owner enables review in prod (#1732) |  | owner |  |  | outline | C1 |  |  |  |  | owner |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
