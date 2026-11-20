# RFC program: checkpoints

At a checkpoint the lead (Opus) reads only what the row lists, completes the outline cards that are due, updates [`risks.md`](risks.md), and opens one PR to `feature/rfc-program` with a note of at most one page.
The manager runs the skill's anticipation pass at each checkpoint.

| ID | Trigger | Gates | The lead reads | The lead produces |
| --- | --- | --- | --- | --- | --- |
| C0 | before the first tick | every step | this pack | done 2026-11-20: an executability review and a design review, every finding with a disposition in `plan.md`'s appendix |
| C1a | R1 merged | R3 | `PROCESS.md` and the workflows in nemarOrg/rfcs, ADR 0054 | the R3 card (Q7 chose the weekly report line) |
| C1 | B2 merged and Q9, Q10 answered | B5 | `spec/index.md` in biosig-zarr, the answers, `research/biosig-zarr-repo.md` sections 5, 6 and 10 | the B5 card, sized to Q10, or B5 dropped with a reason |
| C2 | V1 merged and O5 done | V2 | `evidence/v1-counts.md` (re-run its commands), the RFC-0001 thread's first week, `research/rfc-mechanics.md` Part B | the V2 card, with the options table filled from measured numbers and Q16's answer |
| C3 | RFC-0001 closes | O6 | the thread, the RFC record, `evidence/s1-catalog.md` | a decision draft for the owner (a written disposition of every comment, the decision, the ADRs: specification decisions in biosig-zarr, rollout decisions in nemar-cli); if accepted, the outline of a follow-through epic in this order: 1 every NEMAR reader (those ADR 0128 lists, eegprep-lean, the index builder in `generate_zarr.py`) refuses a store `format_version` above 2; 2 the biosigIO version 3 writer and reader; 3 the ADR 0123 digest v2; 4 the dataset index records each store's `format_version`; 5 the engine bump and re-conversion, discontinuous sources first; 6 the store-contract and format-stability docs pages; 7 issue 2217 closed as superseded; the owner decides |
| C4 | RFC-0002 closes | none | as C3 | as C3, plus a review of the provisional process ADR (A1) after its first two RFCs |
