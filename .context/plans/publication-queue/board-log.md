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

## Log

| Time | Event |
|---|---|
| 2026-11-25T11:12-08:00 | Dispatched D1 (#2361), D2 (#2362), A1 (#2185); D0 next for the lead |
| 2026-11-25T11:15-08:00 | D0: draft PR #2370 into dev (flag + guard test); waits on owner checklist |
| 2026-11-25T11:16-08:00 | CP-D2 done: cards B3, B4, B5 written after ADR 0139 accepted |
