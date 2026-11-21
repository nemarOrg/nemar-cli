# RFC program: queue and collisions

Slots are the default; this program names no waves.
The board's Steps table is in dispatch priority order, and Depends on the board encodes every "after" rule below.

## Slot lists

| Slot | Cards in priority order | Entry condition |
| --- | --- | --- |
| claude-sonnet | V1 | running since 2026-11-20; its PR waits for O0 |
| claude-opus | A2 | O0 done |
| claude-sonnet | A1 | O0 done |
| claude-sonnet | S1 | O0 done; card revised at C1 to resume the remi:18769 scan, and its step 0 refuses to start while that scan still writes its cache |
| claude-sonnet | R1 | O0 and O1 done |
| claude-sonnet | B1 | A2 merged, Q8 answered |
| claude-sonnet | B2 | B1 merged, Q11 answered |
| claude-sonnet | R2 | A1 and R1 merged, Q17 answered |
| claude-sonnet | B3 | O4 done |
| claude-opus | B6 | O4 done, A2 merged |
| claude-opus | B4 | R1, B2 and A2 merged |
| claude-sonnet | N1 | B4 done, Q15 answered |
| claude-sonnet | R3 | R1 merged; card completed at C1a |
| claude-opus | A3 | none (Q34); its PR merges only once every lower-numbered ADR is on its base |
| claude-opus | B5a | B2 merged, O4 done; card written at C1 round 1 (Q33) |
| claude-opus | B5 | B5a merged, O4d done, B6 done; card completed at C1, rescoped by Q33 |
| claude-opus | SC1 | B6 and O4b done (Q29, proposal P2) |
| claude-opus | B4b | B5 merged into `draft/3.0.0`, O4c and O4d done |
| claude-opus | B7 | Q39 to Q42 answered (Q37/Q38 decided) |
| claude-opus | B7b | B7 merged into `main`, O4e done |
| claude-opus | B4c | B4b done, O4e and O4f done |
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
| SC1, any other docs PR | nemarOrg/docs | may run together; the second to merge takes the base in and reruns its gate |
| B5, B6 | `draft/3.0.0` in nemarOrg/biosig-zarr; B5 edits a few lines of `spec/index.md` | B5 branches from `draft/3.0.0` after B6 is done; no other change lands on `draft/3.0.0` while B5 is open |
| B5a, B5 | `conformance/`, `tools/`, `conformance.yml`, `CHANGELOG.md` | B5 after B5a merges and O4d; B5 merges `main` into its branch first |
| A3, mail epic #2260 | `.context/decisions/` and the ADR index | A3 takes the next free number above the mail epic's 0132 and merges only after every lower number is on its base |
| B4b, B4 | the open draft PR nemarOrg/rfcs#2 | B4b after B4 is done and O4c; it pushes one commit to that PR's branch |
| B7, B7b | biosig-zarr governance files; B7b merges `2.0.2` into `draft/3.0.0` | B7b after B7 merges and O4e; B7b merges the tag `2.0.2` into its branch first |
| B7, any other PR into biosig-zarr `main` | `LICENSE.md`, `GOVERNANCE.md`, `README.md`, `CHANGELOG.md` | no other PR lands on `main` while B7 is open; one that must lands first, and B7 takes `main` in and reruns its gate |
| B7b, any other PR into `draft/3.0.0` | `spec/index.md`, `CHANGELOG.md` | no other change lands on `draft/3.0.0` while B7b is open |
| B4c, B4b | the open draft PR nemarOrg/rfcs#2 | B4c after B4b is done, O4e and O4f; it pushes commits to that PR's branch |
| R3, mail epic #2260 | `backend/src/services/` and `shared/contract/` in nemar-cli, different files | may run together; the second to merge takes the base in and reruns its gate |
