# Publication queue (epic #2182): decide + evidence: log

<!--
Append-only history for the board beside this file.
Written by `manager_board.py log` and `decide`; never rewrite or delete a row.
The manager reads the newest rows through `status`, never the whole file.
-->

## Decisions

| Time | Decision | By | Reason |
|---|---|---|---|
| 2026-11-25T11:12-08:00 | Plan v2 approved with defaults (lead=manager this session, local phase gate, Sonnet/Opus parity, 3 slots, 40 agents/day) | owner |  |
| 2026-11-25T11:12-08:00 | ADR 0139 approved as drafted; accepted on the decide branch | owner |  |
| 2026-11-25T11:22-08:00 | Platform review cap 150 (Q1); in PR #2370 with ADR 0102 amendment | owner |  |
| 2026-11-25T11:22-08:00 | A1 stop: rebuild migration of upstream_repull_screens in A1 (option a); PREFLIGHT_VERSION 2; old ack word kept as alias; formatCoverage moves to the registry | lead |  |
| 2026-11-25T11:22-08:00 | D1: fourth resolver (OpenNeuro GraphQL, PhysioNet API) since registries hold no license for them; README DOIs only for data-repository prefixes; no openapi entry | lead |  |
| 2026-11-25T14:00-08:00 | CP-D1: batch acknowledgment rests on a confirmed public upstream (owner); card D3 written | owner |  |
| 2026-11-25T14:00-08:00 | Empty repos nm000589, nm000978: deny, ask the depositor to re-upload (owner) | owner |  |
| 2026-11-25T14:48-08:00 | A2: companions paired by BIDS basename; header-named files checked in scan(); mismatch = partial/companion-missing; .vmrk/.inf read; no contract change | lead |  |
| 2026-11-25T14:52-08:00 | A2 FP gate: NIRx runs on all public headers found (>=20, count stated); 200-file gate waived for NIRx only; thresholds unchanged | lead |  |
| 2026-11-25T14:56-08:00 | A3: walker logical read cap 20,000; real bounds are source fetches (page cache), bytes and time, declared per reader by A4/A5 | lead |  |

## Log

| Time | Event |
|---|---|
| 2026-11-25T11:12-08:00 | Dispatched D1 (#2361), D2 (#2362), A1 (#2185); D0 next for the lead |
| 2026-11-25T11:15-08:00 | D0: draft PR #2370 into dev (flag + guard test); waits on owner checklist |
| 2026-11-25T11:16-08:00 | CP-D2 done: cards B3, B4, B5 written after ADR 0139 accepted |
| 2026-11-25T11:23-08:00 | PR #2370 reviewed (r1), suggestions fixed |
| 2026-11-25T11:25-08:00 | D2 report: images-only ack empties 1 more request; 349 held by unread formats only; 2 empty repos |
| 2026-11-25T14:02-08:00 | PR #2372 r1 done: fixes sent |
| 2026-11-25T14:03-08:00 | PR #2373 r1 done: settle redesign sent |
| 2026-11-25T14:04-08:00 | D2 merged (#2371 -> 4ae05b17); CP-D1 already answered; D3 waits on D1 |
| 2026-11-25T14:07-08:00 | PR #2374 r1 done: fixes sent (range-ignored, limit safeguard, 3 mutants) |
| 2026-11-25T14:20-08:00 | Local pure tier replaced by remote CI (faster under load); killed local run |
| 2026-11-25T14:35-08:00 | D4 green but conflicting after D1 merge; base merge sent |
| 2026-11-25T14:42-08:00 | A1 merged (#2374 -> 5c3d65d5): A2, A6, A9 ready |
