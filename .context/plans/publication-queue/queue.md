# Slots and collisions

Three implementer slots, filled in priority order.
A step is ready when every step it depends on is done.
Lane D (decide) comes first, because it clears requests.

1. D1: license lineage (decide)
2. D2: blocker measurement (decide; small)
3. A1: the coverage contract (evidence foundation)
4. D4: quiet re-screen (decide)
5. A3: the HDF5 reader (evidence)
6. A2, then A4, A6, A5 and A9, as their dependencies merge
7. D3 after CP-D1; B3, B4 and B5 after CP-D2; A10 after CP-E1

D0 and B2 are lead work: they take the lead slot, not an implementer slot.

## Collisions

| Pair | Shared | Rule |
| --- | --- | --- |
| A2, A4, A5, A6 | `shared/identifier-readers.ts` registration, `FindingKind`, `KIND_COPY`, `test/identifier-fleet.test.ts`, `tsconfig.json` | They may run together; the second to merge merges the base in and reruns its gates. |
| A9, D1 | `src/commands/dataset.ts`, `tsconfig.json` | They are on different epic branches; the conflict is resolved at the second epic's merge into `dev`. |
| D4, B5 | `backend/src/services/identifier-screen.ts`, `email.ts` | B5 waits for D4 (the board's Depends). |
| A4, A5 | A3's `shared/hdf5-meta.ts`; A4 owns `shared/readers/hdf5-incomplete.ts` | A5 depends on A4. |
| A1, D2 | `shared/identifier-scan.ts` (D2 adds one `export`) | They are on different branches; the merge into `dev` resolves it. |
