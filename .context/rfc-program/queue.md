# RFC program: queue and collisions

Slots are the default; this program names no waves.
The board's Steps table is in dispatch priority order, and Depends on the board encodes every "after" rule below.

## Slot lists

| Slot | Cards in priority order | Entry condition |
| --- | --- | --- |
| claude-sonnet | V1 | now |
| claude-sonnet | A1 | Q1 to Q7 answered |
| claude-sonnet | R1 | O1 done, Q1 to Q7 answered |
| claude-sonnet | B1 | O2 done, Q8 answered |
| claude-sonnet | B2 | B1 merged, Q11 answered |
| claude-sonnet | R2 | A1 and R1 merged, Q17 answered |
| claude-sonnet | B3 | O4 done, Q12 answered |
| claude-opus | B4 | R1 and B2 merged |
| claude-opus | V2 | checkpoint C2 completed the card |

## Collisions

| Pair | Shared | Rule |
| --- | --- | --- |
| A1, V1 | `feature/rfc-program` in nemar-cli, different files | may run together; the second to merge takes the base in and reruns its gate |
| R1, B4 | nemarOrg/rfcs; B4 needs R1's template and `rfc-check` | B4 after R1 merges |
| R2, B3 | nemarOrg/docs; different pages, but both may touch the sidebar in `astro.config.mjs` | may run together; the second to merge takes the base in and reruns its gate |
| B1, B2 | nemarOrg/biosig-zarr; B2 writes into B1's layout | B2 after B1 merges |
| B4, V2 | nemarOrg/rfcs `README.md` index | V2 after B4 is opened (O5) |
