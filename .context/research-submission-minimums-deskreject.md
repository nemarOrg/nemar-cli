# Research: bare-minimum submission requirements + OpenNeuro desk-rejection prevalence (2026-06-20)

> **Decision recorded:** [ADR 0014 - Submission minimums are LLM-judged, not regex-gated](decisions/0014-submission-minimums-are-llm-judged-not-regex-gated.md).
> This document holds the measurement that calibrated it.

Companion to a forthcoming **Policy** issue ("bare-minimum requirements for dataset
submission, enforced via prescreen"). Quantifies how many OpenNeuro datasets in NEMAR's
scope would trip proposed desk-rejection categories, to calibrate which checks should
hard-block vs. only flag.

## Method

- Read-only scan of the public OpenNeuro GraphQL API (`openneuro.org/crn/graphql`),
  same endpoint NEMAR's discovery uses (`backend/src/services/openneuro-discovery.ts`).
- Per dataset latest snapshot: `description { Name Authors License EthicsApprovals }`,
  `readme`, `summary { modalities }`.
- In-scope filter = NEMAR_MODALITIES (`eeg, meg, ieeg, emg, nirs, motion`), the exact set
  used by auto-import. A dataset qualifies if ANY modality matches (mixed sets count).
- Script: `/tmp/openneuro-deskreject-scan.mjs`; raw output: `/tmp/openneuro-deskreject-results.json`.
- NOTE: unauthenticated GraphQL returns **public** datasets only (1,777 total) — which is
  exactly the importable population, so the denominator is correct for this purpose.

## Headline numbers

- OpenNeuro public datasets scanned: **1,777**
- In NEMAR scope (ExG / NIRS / Motion): **577** — eeg 428, ieeg 70, meg 59, nirs 26, motion 1.

| Category | Count / 577 | % | Verdict for policy |
|---|---|---|---|
| Inadequate Name (raw heuristic) | 28 | 4.9% | mostly false positives — see below |
| Inadequate Name (genuine) | ~9 | ~1.6% | LLM-judge advisory, not regex gate |
| Missing License | 1 | 0.2% | non-issue on OpenNeuro; still require for native |
| Missing **or** stub README | 59 | 10.2% | biggest hard-reject category; enforceable |
| Missing IRB/ethics (EthicsApprovals) | **396** | **68.6%** | too prevalent to block -> STRONG FLAG only |
| Would hit >=1 hard reject (name/license/readme) | 73 | 12.7% | (name-noisy; README dominates) |
| Fully clean (name+license+readme+ethics) | 159 | 27.6% | |

## Detail / caveats

### Name length floor (DECIDED: minimum 25 characters)
A descriptive title is required, like a journal article title. Deterministic floor chosen =
**25 chars** (user decision 2026-06-20). Impact on the 577 in-scope datasets (OpenNeuro
exempt, so illustrative of strictness only):
- `< 25` chars fail: 170 (29.5%)  <- chosen
- `< 40` chars fail: 274 (47.5%)
- `< 50` chars fail: 330 (57.2%)  <- rejected as too strict (kills good titles)
Length distribution: 0 chars 2; 1-9: 49; 10-24: 119; 25-49: 160; 50-99: 189; 100+: 58.
25 kills codenames (`RS_TMSEEG_Data`, `Rivalry_Tagging`, `PROBE iEEG`, `memoryreplay`) but
keeps concise descriptive titles like `Visual Oddball Task (256 channels)` [34] and
`Single-pulse open-loop TMS-EEG dataset` [38]. The floor is deterministic; semantic quality
(placeholder/author-year/name==id) stays on the LLM judge on top of the floor.

### Name semantics (the noisy one)
- Raw "bad" = 28: missing 2, equals-id 1, author-year 3, "too_short" 22.
- The 22 "too_short" are almost all legitimate project acronyms/codes:
  MEGMEM, MAVIS, PRIOS, Neuma, STRONG, Chisco, STReEF, UV_EEG, ROAMM, EPOC, TX14..TX18...
  -> **false positives.** A length/charset regex cannot distinguish "TX14" (fine) from
  a lazy name.
- Genuinely inadequate (~9): blank ` ` (ds000248, ds003352), name==id (ds007541="ds007541"),
  author-year (ds005121="Siefert2024", ds005929="Motion-Yucel2014", ds006545="Reliability-Dubois2024"),
  placeholder-with-digit my regex missed (DataSet1, DataSet2), "what_are_we_talking_about".
- **Implication:** name quality belongs to the LLM prescreen judge (semantic, "is this a
  descriptive dataset title?"), NOT a deterministic regex desk-reject. The user's examples
  (author-year, bare approval-type names) are real but rare and need judgment.

### License
- Only 1/577 missing. OpenNeuro effectively requires a license at their end, so imports are
  safe. For **native NEMAR** submissions there is no such upstream guarantee -> still a hard
  requirement.

### README
- 38 missing (len 0) + 21 stub (<200 chars) = 59 (10.2%). Examples of len-0 README with a
  real Name: ds001849, ds002001, ds002908 (MEG), ds003483, ds003694 (MEGMEM). Clean,
  deterministic, enforceable; the single biggest concrete gap.

### IRB / ethics
- 396/577 (68.6%) have no `EthicsApprovals` in dataset_description.json. (Some state it in
  the README prose instead, which this scan does not parse — so the true "no ethics info
  anywhere" rate is lower, but still high.)
- **Far too prevalent to desk-reject.** This is the user's "strong flag" case: compute it,
  write it into `.nemar/metadata.json` as a flag, surface a badge on the website, and prompt
  the submitter to add it — do not block.

## Policy implication (feeds the issue)

Tiered, not all-or-nothing:
- **Tier A (hard, blocks NATIVE new submissions; prescreen authoritative):** README present
  & substantive; license declared; Name >= 25 chars (deterministic floor) AND descriptive
  (LLM-judged on top). BIDS-validation is already enforced. README ~10% + name-floor ~30% of
  current OpenNeuro-scope data would fail Tier A today.
- **Tier B (strong flag, never blocks):** missing IRB/ethics -> `flags.irb_missing` in
  `.nemar/metadata.json` + website badge. ~69% today.
- **OpenNeuro imports EXEMPT from Tier A** (trust-upstream; can't retroactively desk-reject
  the existing corpus) but **still get Tier B flags computed** so the IRB badge shows.
