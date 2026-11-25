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

## Log

| Time | Event |
|---|---|
| 2026-11-25T11:12-08:00 | Dispatched D1 (#2361), D2 (#2362), A1 (#2185); D0 next for the lead |
| 2026-11-25T11:15-08:00 | D0: draft PR #2370 into dev (flag + guard test); waits on owner checklist |
| 2026-11-25T11:16-08:00 | CP-D2 done: cards B3, B4, B5 written after ADR 0139 accepted |
