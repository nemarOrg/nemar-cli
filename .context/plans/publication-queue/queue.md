# Slots and collisions

Three implementer slots run in priority order.
A step is ready when every step it depends on is done.

1. A1 (the foundation; it unblocks A2, A4, A5, A6 and A9)
2. A3 (the HDF5 reader; runs beside A1)
3. B1 (license lineage; independent)
4. A7 (measurement; small, no product code)
5. A4 (SNIRF: the largest queue impact, 204 datasets)
6. A2 (BrainVision and NIRx: 86 and about 20 datasets)
7. A5 (MAT, EEGLAB and .nirs: 104, 24 and 12 datasets)
8. A6 (ZIP: 129 datasets)
9. A9 (local reproduction)
10. A8 and A10, after the CP1 completion
11. B3, B4 and B5, after B2

## Collisions

| Pair | Shared | Rule |
| --- | --- | --- |
| A2, A4, A5, A6 | `shared/identifier-readers.ts` registration, the `FindingKind` union, `KIND_COPY` | May run together; the second to merge takes the base in by merge and reruns its gates. |
| A9, B1 | `src/commands/dataset.ts` | May run together; the same rule applies. |
| A4, A5 | A3's `shared/hdf5-meta.ts` | Neither changes it except for a bug fix with its own test. |
| A8, A1 | `scanPaths` in `shared/identifier-scan.ts` | A8 runs after A1 (enforced by Depends). |
