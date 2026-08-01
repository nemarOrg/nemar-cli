# ADR 0014: Submission minimums are LLM-judged and advisory; regexes do not gate

**Status:** accepted
**Date:** 2026-06-20
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR needed bare-minimum submission requirements enforceable at publish time. Before setting thresholds, a read-only scan measured how many in-scope OpenNeuro datasets would trip each proposed desk-rejection category: 1,777 public datasets scanned, **577 in NEMAR scope** (eeg 428, ieeg 70, meg 59, nirs 26, motion 1).

The measurement changed the design. A raw regex heuristic flagged 28/577 (4.9%) for an inadequate dataset name, but only ~9 (~1.6%) were genuine — the rest were false positives. Missing license was a non-issue at 1/577 (0.2%). The one genuinely enforceable category was missing or stub README at 59/577 (10.2%).

## Decision

Quality judgments that a regex cannot make reliably — name adequacy above all — are **LLM-judged and advisory**, never a regex hard-gate. Structural, objectively checkable requirements (README present and non-stub, license present for native submissions) can hard-block. The automated prescreen is authoritative for **native** submissions; OpenNeuro mirrors are exempt, since they already passed that archive's own review.

## Consequences

- We do not desk-reject ~19 good datasets to catch ~9 bad ones, which a 4.9% regex gate would have done.
- Calibration is empirical: the thresholds were chosen against a measured population rather than intuition, and can be re-measured if the population shifts.
- An LLM sits in the publish path, so the pipeline inherits its cost, latency, and non-determinism. Its verdicts are advisory precisely because of that.
- Exempting OpenNeuro means two classes of dataset with different bars. Defensible for a mirror, but it must stay explicit or the exemption looks like a bug.

## Alternatives considered

- **Regex/heuristic hard gates on everything:** simple and deterministic, but measured at ~3:1 false positives on the name check. Rejected on the data.
- **Human review of every submission:** highest quality, unaffordable at import scale. Rejected.
- **Apply the same bar to OpenNeuro mirrors:** consistent, but re-litigates another archive's accepted review and would block importing datasets that are already public and citable. Rejected.

## Receipts

- `.context/research-submission-minimums-deskreject.md` — scan of 2026-06-20
- #817; #666 (prescreen)
