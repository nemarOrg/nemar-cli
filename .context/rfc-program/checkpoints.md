# RFC program: checkpoints

At a checkpoint the lead (Opus) reads only what the row lists, completes the outline cards that are due, updates [`risks.md`](risks.md), and opens one PR to `feature/rfc-program` with a note of at most one page.
The manager runs the skill's anticipation pass at each checkpoint.

| ID | Trigger | The lead reads | The lead produces |
| --- | --- | --- | --- |
| C0 | before the first tick | this pack | an executability review (worker tier) and a design review (lead tier) of the pack, every finding with a disposition in `plan.md`'s appendix; `MB card` passes on every non-outline card |
| C1 | B2 merged and Q7, Q9, Q10 answered | `spec/index.md` in biosig-zarr, the answers, `research/biosig-zarr-repo.md` sections 5, 6 and 10, `research/rfc-mechanics.md` section A7 | the B5 card (schemas and vectors, sized to Q10), the R3 card if Q7 chose the weekly report line, or both dropped with a reason |
| C2 | V1 merged and O5 done | `evidence/v1-counts.md`, the RFC-0001 thread's first week, `research/rfc-mechanics.md` Part B | the V2 card, with the options table filled from V1's measured numbers and Q16's answer |
| C3 | RFC-0001 closes | the thread, the RFC record | a decision draft for the owner (disposition, a response to each substantive objection, the ADR or the reason there is none); the owner decides |
| C4 | RFC-0002 closes | as C3 | as C3, plus a review of the provisional process ADR (A1) after its first two RFCs |
