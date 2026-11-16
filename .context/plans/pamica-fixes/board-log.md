# pAMICA same-seed parity: log

<!--
Append-only history for the board beside this file.
Written by `manager_board.py log` and `decide`; never rewrite or delete a row.
The manager reads the newest rows through `status`, never the whole file.
-->

## Decisions

| Time | Decision | By | Reason |
|---|---|---|---|
| 2026-11-14T11:21-08:00 | Same seed means same start: AMICANative(start=pamica) loads pamica's seeded state via load_* (D1); fix_init not ported, filed instead | lead | the shared start already measured 1.6e-6 LL at 100 its; fix_init not needed for parity |
| 2026-11-14T11:21-08:00 | Parity tiers A1, A2, B, C, C32, D1, D2 pre-registered in plan section 5; never loosened | lead | owner goal 2026-11-14: match the Fortran binary on the same seed, when possible |
| 2026-11-14T11:21-08:00 | Rabbit-hole guard: 12 steps max, 40 agents total, 8 per day, 3 advisor consults, 2 rounds per card, parity budget 2 approaches or 6h, deadline 2026-11-28T17:00 | lead | owner instruction 2026-11-14; account weekly limit shared with NEMAR |

## Log

| Time | Event |
|---|---|
| 2026-11-14T11:21-08:00 | pack written by the lead; board initialized; Q1-Q3 recorded; manager not started |
