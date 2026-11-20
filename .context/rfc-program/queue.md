# RFC program: queue and collisions

Slots are the default; this program names no waves.
The board's Steps table is in dispatch priority order, and Depends on the board encodes every "after" rule below.

## Slot lists

| Slot | Cards in priority order | Entry condition |
| --- | --- | --- |
| claude-sonnet | V1 | running since 2026-11-20; its PR waits for O0 |
| claude-opus | A2 | O0 done |
| claude-sonnet | A1 | O0 done |
| claude-sonnet | S1 | O0 done |
| claude-sonnet | R1 | O0 and O1 done |
| claude-sonnet | B1 | A2 merged, Q8 answered |
| claude-sonnet | B2 | B1 merged, Q11 answered |
| claude-sonnet | R2 | A1 and R1 merged, Q17 answered |
| claude-sonnet | B3 | O4 done |
| claude-opus | B6 | O4 done, A2 merged |
| claude-opus | B4 | R1, B2 and A2 merged |
| claude-sonnet | N1 | B4 done, Q15 answered |
| claude-opus | V2 | checkpoint C2 completed the card |

## Collisions

| Pair | Shared | Rule |
| --- | --- | --- |
| A1, V1 | `feature/rfc-program` in nemar-cli, different files | may run together; the second to merge takes the base in and reruns its gate |
| R1, B4 | nemarOrg/rfcs; B4 needs R1's template and `rfc-check` | B4 after R1 merges |
| B1, B2 | nemarOrg/biosig-zarr; B2 writes into B1's layout | B2 after B1 merges |
| B4, V2 | nemarOrg/rfcs `README.md` index | V2 after B4 is opened (O5) |
| A1, A2 | `.context/decisions/README.md` index and ADR numbers | may run together; the second to merge takes the base in, takes the next free number, and reruns its gate |
| V1, S1 | `.context/rfc-program/evidence/`, different files | may run together |
| B2, B6 | `spec/index.md`; B6 branches from tag `2.0.0` | B6 after O4 |
| B3, R2 | nemarOrg/docs | may run together; the second to merge takes the base in and reruns its gate |
