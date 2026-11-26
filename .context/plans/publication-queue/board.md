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
| Agents today | 40 | 36 | daily | implementers, reviewers, advisors spawned; the plan approval covers this limit |
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
| D1 | [License lineage](cards/D1.md) |  | worker-hard |  | claude-worker | done |  | 2372 | r1 panel (code+tests, errors+comments): 3 important + 6 sugg fixed, 1 rejected; r2 delta clean, 2 sugg fixed | 2026-11-25T11:12 | 2d | merged 442ce5ca; flaky CI filed #2377 |
| D2 | [Measure every blocker, HEAD+history](cards/D2.md) |  | worker |  | claude-worker | done |  | 2371 | r1 code+comments (1 reviewer): 0 important, 4 suggestions fixed; no r2 | 2026-11-25T11:12 | 1d | merged 4ae05b17 |
| A1 | [Coverage contract and registry](cards/A1.md) |  | worker-hard |  | claude-worker | done |  | 2374 | r1 panel: 1 important + 7 fixed; r2 delta: 1 important (copy unwired) + 1 sugg sent | 2026-11-25T11:12 | 3d | merged 5c3d65d5 |
| D4 | [Quiet paced re-screen](cards/D4.md) |  | worker |  | claude-worker | done |  | 2373 | r1 panel: 6 important + 7 sugg fixed (settle redesign); r2 delta clean, 2 sugg fixed | 2026-11-25T11:25 | 1d | merged |
| A3 | [Pure-TS HDF5 metadata reader](cards/A3.md) |  | worker-hard |  | claude-worker | done |  | 2378 | r1 panel: 2 important (never-throw, unshuffle hang) + 4 fixed; r2 delta clean, 1 sugg fixed, 2 accepted | 2026-11-25T14:10 | 2d | merged d767b62b |
| D0 | [Review in prod, shadow 20](cards/D0.md) |  | lead |  |  | owner |  | 2370 | r1 code+tests+comments: 0 important, 2 suggestions fixed |  | 4h | draft #2370; owner checklist, then owner merges and releases |
| B2 | ADR 0139 auto-deny (draft on decide branch) |  | lead |  |  | done |  |  |  |  |  | accepted 2026-11-25 |
| A2 | [BrainVision and NIRx](cards/A2.md) |  | worker-hard |  | claude-worker | review | A1 | 2381 | r1 panel: 2 important (regex DoS, not-applicable evasion) + 3 fixed; r2 delta: 2 important evasions fixed, verified by lead with r2 probes (no r3) | 2026-11-25T14:46 | 1d | CI on 7840826a, then merge |
| A4 | [SNIRF and generic HDF5](cards/A4.md) |  | worker-hard |  | claude-worker | review | A1, A3 | 2385 |  | 2026-11-25T15:23 | 1.5d | A1 clipped-page limited fix, then panel |
| A6 | [ZIP archives](cards/A6.md) |  | worker-hard |  |  | todo | A1 |  |  |  | 1d | after A1 |
| A9 | [nemar dataset screen](cards/A9.md) |  | worker |  |  | todo | A1 |  |  |  | 1d | after A1 |
| A5 | [MAT, EEGLAB, Homer .nirs](cards/A5.md) |  | worker-hard |  |  | todo | A1, A4 |  |  |  | 2d | after A4 |
| D3 | [Batch ack on public upstream](cards/D3.md) |  | worker-hard |  | claude-worker | done | D1, D2 | 2380 | r1 panel: 2 important (audit fail-open, item isolation) + 4 + lead (D1 batch txn, no JSON bundle) fixed; r2 delta clean, 2 sugg fixed | 2026-11-25T14:32 | 2d | merged |
| B3 | [Resubmission note](cards/B3.md) |  | worker |  | claude-worker | done | B2 | 2379 | r1 panel: 1 important + 7 fixed; r2 delta clean; 1 sugg rejected | 2026-11-25T14:10 | 1d | merged |
| B4 | [Review inputs and record](cards/B4.md) |  | worker-hard |  | claude-worker | review | D1, B2 | 2382 | r1 panel: 1 important (screen codes) + 5 fixed, lead cap-gap fix; r2 delta clean, 3 sugg fixed | 2026-11-25T14:54 | 2d | last small push, CI, merge |
| B5 | [Auto-deny and ready mail](cards/B5.md) |  | worker-hard |  |  | todo | B2, B3, B4, D4 |  |  |  | 2.5d | after B3, B4, D4 |
| CPD3 | Seam review; decide epic to dev; release D |  | lead |  |  | outline | D1, D3, D4, B3, B4, B5 |  |  |  |  | CP-D3 |
| C1 | Calibration in prod shadow mode |  | owner |  |  | outline | CPD3, D0 |  |  |  |  | owner labels |
| A10 | docs.nemar.org pages from copy tables |  | worker |  |  | outline | A2, A4, A5, A6, A9 |  |  |  |  | CP-E1; include a test that every copy-table anchor exists on the docs page |
| CPE2 | Seam review; evidence epic to dev; release E; O2 |  | lead |  |  | outline | A10 |  |  |  |  | CP-E2 |
| O4 | Empty repos nm000589, nm000978 have publication requests |  | owner |  |  | owner |  |  |  |  |  | owner: nemar admin repo publish deny nm000589 / nm000978 (reason in checkpoints.md) |
| O5 | SNIRF DateOfBirth may block queued conversions |  | owner |  |  | owner |  |  |  |  |  | FP gate: 29/296 public SNIRF files carry day-precision DOB (ds004514, ds004541, ds005963); queued conversions with DOB will block; owner: tell depositor to scrub, and consider notifying OpenNeuro |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|
| Q1 | - | Raise PLATFORM_DAILY_CAP (50 model calls/day) for the queue? At 50/day ~300 requests take ~1 week; ADR 0139 adds a Sonnet call per fail | Keep 50 for the shadow batch, decide after (Recommended) / Raise to 150 now / Make it an env var you set | none | 2026-11-27T17:00 | closed | Raise to 150 now (owner, 2026-11-25T11:22-08:00) |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
| D1 | implementer | claude-worker | Opus 5.5 | D1 | 2026-11-25T11:12 | done |
| D2 | implementer | claude-worker | Sonnet 5.5 | D2 | 2026-11-25T11:12 | done |
| A1 | implementer | claude-worker | Opus 5.5 | A1 | 2026-11-25T11:12 | done |
| rev-2370 | reviewer | claude-worker | Sonnet 5.5 | D0 | 2026-11-25T11:22 | done |
| D4 | implementer | claude-worker | Sonnet 5.5 | D4 | 2026-11-25T11:25 | done |
| rev-2371 | reviewer | claude-worker | Sonnet 5.5 | D2 | 2026-11-25T11:25 | done |
| rev-2372a | reviewer | claude-worker | Sonnet 5.5 | D1 | 2026-11-25T14:01 | done |
| rev-2372b | reviewer | claude-worker | Sonnet 5.5 | D1 | 2026-11-25T14:01 | done |
| rev-2374a | reviewer | claude-worker | Sonnet 5.5 | A1 | 2026-11-25T14:01 | done |
| rev-2374b | reviewer | claude-worker | Sonnet 5.5 | A1 | 2026-11-25T14:01 | done |
| rev-2373a | reviewer | claude-worker | Sonnet 5.5 | D4 | 2026-11-25T14:02 | done |
| rev-2373b | reviewer | claude-worker | Sonnet 5.5 | D4 | 2026-11-25T14:02 | done |
| rev-2372-r2 | reviewer | claude-worker | Sonnet 5.5 | D1 | 2026-11-25T14:10 | done |
| rev-2373-r2 | reviewer | claude-worker | Sonnet 5.5 | D4 | 2026-11-25T14:10 | done |
| A3 | implementer | claude-worker | Opus 5.5 | A3 | 2026-11-25T14:10 | done |
| B3 | implementer | claude-worker | Sonnet 5.5 | B3 | 2026-11-25T14:10 | done |
| rev-2374-r2 | reviewer | claude-worker | Sonnet 5.5 | A1 | 2026-11-25T14:14 | done |
| D3 | implementer | claude-worker | Opus 5.5 | D3 | 2026-11-25T14:32 | done |
| rev-2379a | reviewer | claude-worker | Sonnet 5.5 | B3 | 2026-11-25T14:46 | done |
| rev-2379b | reviewer | claude-worker | Sonnet 5.5 | B3 | 2026-11-25T14:46 | done |
| A2 | implementer | claude-worker | Opus 5.5 | A2 | 2026-11-25T14:46 | done |
| rev-2379-r2 | reviewer | claude-worker | Sonnet 5.5 | B3 | 2026-11-25T14:54 | done |
| B4 | implementer | claude-worker | Opus 5.5 | B4 | 2026-11-25T14:54 | done |
| rev-2378a | reviewer | claude-worker | Sonnet 5.5 | A3 | 2026-11-25T14:56 | done |
| rev-2378b | reviewer | claude-worker | Sonnet 5.5 | A3 | 2026-11-25T14:56 | done |
| rev-2378-r2 | reviewer | claude-worker | Sonnet 5.5 | A3 | 2026-11-25T15:01 | done |
| rev-2380a | reviewer | claude-worker | Sonnet 5.5 | D3 | 2026-11-25T15:23 | done |
| rev-2380b | reviewer | claude-worker | Sonnet 5.5 | D3 | 2026-11-25T15:23 | done |
| A4 | implementer | claude-worker | Opus 5.5 | A4 | 2026-11-25T15:23 | done |
| rev-2380-r2 | reviewer | claude-worker | Sonnet 5.5 | D3 | 2026-11-25T15:32 | done |
| rev-2381a | reviewer | claude-worker | Sonnet 5.5 | A2 | 2026-11-25T15:48 | done |
| rev-2381b | reviewer | claude-worker | Sonnet 5.5 | A2 | 2026-11-25T15:48 | done |
| rev-2382a | reviewer | claude-worker | Sonnet 5.5 | B4 | 2026-11-25T15:58 | done |
| rev-2382b | reviewer | claude-worker | Sonnet 5.5 | B4 | 2026-11-25T15:58 | done |
| rev-2381-r2 | reviewer | claude-worker | Sonnet 5.5 | A2 | 2026-11-25T16:03 | done |
| rev-2382-r2 | reviewer | claude-worker | Sonnet 5.5 | B4 | 2026-11-25T16:09 | done |
