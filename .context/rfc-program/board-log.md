# NEMAR RFC program: log

<!--
Append-only history for the board beside this file.
Written by `manager_board.py log` and `decide`; never rewrite or delete a row.
The manager reads the newest rows through `status`, never the whole file.
-->

## Decisions

| Time | Decision | By | Reason |
|---|---|---|---|
| 2026-11-20T09:45-08:00 | One public repo nemarOrg/rfcs holds the record and one number space; every thread, dataset RFCs included, is a Discussion there; no per-dataset Discussions, no App permission change | owner | 2026-11-20 answer |
| 2026-11-20T09:45-08:00 | Window at most 21 calendar days; one extension of at most 14 days, before close, with a reason (35 days max); applies to RFC-0001 (not six weeks) | owner | 2026-11-20 answer |
| 2026-11-20T09:45-08:00 | Create nemarOrg/biosig-zarr now for the whole format via /project:init-project; amend biosigio#179; license W3C text, Apache 2.0 schemas/vectors/code | owner | 2026-11-20 answer |
| 2026-11-20T09:45-08:00 | RFC-0001 is one RFC for the whole biosig-zarr format with .bzx as its single-file form, with a section on why the two are named separately and the package items put up for comment | owner | 2026-11-20 answer |
| 2026-11-20T09:45-08:00 | OME-Zarr RFC-9 is prior art, not a dependency; NEMAR packing rules do not follow RFC-9 changes, stated as an advantage | owner | 2026-11-20 answer |
| 2026-11-20T09:45-08:00 | RFC-0001 has a Why not NWB on Zarr section naming hdmf-zarr with its link, calling it a great tool, then the reasons it does not fit (BIDS file-beside-sidecars, human low-frequency biosignals), grounded in ADR 0128 | owner | 2026-11-20 addition |
| 2026-11-20T09:45-08:00 | RFC-0001 adds a requirement and a comment question for irregular and sparse time series (EDF cannot represent them; the draft has one uniform axis, open question 9) | owner | 2026-11-20 addition |
| 2026-11-20T09:45-08:00 | RFC-0001 adds an explicit sample resolution field (bit depth, integer or float) with its relation to dtype, scale and offset; the draft has only dtype as storage type | owner | 2026-11-20 addition |
| 2026-11-20T09:45-08:00 | RFC-0002 is not pre-decided: problem plus options with measured costs (origin per version and upstream tag, revisit re-pull major bump, +N or other grammar); after RFC-0001 and a read-only DOI count | owner | 2026-11-20 answer |
| 2026-11-20T09:45-08:00 | RFC-0001 text lives in nemarOrg/rfcs at text/0001-biosig-zarr.md; biosig-zarr has no rfc/ directory | lead | one number space |
| 2026-11-20T09:45-08:00 | A draft RFC is a PR that takes its number at creation; merging it with opened_at set opens it, so only the owner merges RFC text PRs | lead | simplest owner step |
| 2026-11-20T09:45-08:00 | B2 moves the spec text with no normative change; the resolution, irregular-sampling and RFC-9-independence changes are proposed in RFC-0001 (B4) | lead | keeps the move verifiable word for word |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D1 reader safety: format_version 3, required group kind, structural refusal for non-uniform groups, refuse unapplied start_time/valid_intervals/missing_value | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D2 back catalog stays readable as v2; re-convert via engine bump, possibly-discontinuous sources first; never metadata-only upgrade; reconcile nemar-cli#2217 with ADR 0128 | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D3 gaps on the grid via valid_intervals, source_time null allowed | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D4 reserved missing code per dtype, null allowed for bit-exact; NEMAR profile always reserves | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D5 jittered streams kept as measured (timestamped) by default; regularize only on request | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D6 add int32 and float64 storage per group; NEMAR stays int16 | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D7 bit-exact copy allowed in the format; NEMAR decides after measuring how many qualify | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D8 required per-channel derivation list | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D9 source fields source_sample_type, source_adc_bits, source_step, source_offset, source_digital_range | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D10 onset_source_basis | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D11 define ADR 0123 digest v2 before any derivative keys on a v3 store | owner |  |
| 2026-11-20T10:09-08:00 | RFC-0001 proposes (research/irregular-and-resolution-design.md): D12 epoched sources refused in NEMAR profile for now; community question | owner |  |
| 2026-11-20T10:19-08:00 | RFC-0001 ends with a History of the format section: dated format_version table (1, 2, proposed 3) and the store count (owner: more than 230,000), measured at writing time | owner |  |
| 2026-11-20T10:21-08:00 | Spec tags: the moved text is tagged 2.0.0 (format version 2 as served, no normative change); RFC-0001's text is 3.0.0-draft.1 when it opens, 3.0.0 only if accepted. 2.0.0-draft.1 was stale | owner |  |
| 2026-11-20T11:17-08:00 | Create a public epic issue via /project:epic-dev for the RFC program; the manager loop drives the steps | owner |  |
| 2026-11-20T11:17-08:00 | Relicensing: the owner relicenses the spec text to the agreed licenses (W3C for text, Apache 2.0 for schemas, vectors and code); LICENSE records it was relicensed from CC BY-NC-ND 4.0 with the date. The format page is REMOVED from docs.nemar.org and replaced by a short pointer to nemarOrg/biosig-zarr (no rendered copy, no pinned-tag fetch); Q12 is moot | owner |  |
| 2026-11-20T11:17-08:00 | 2.0.0 is a full release (not pre-release); its notes list the four Proposed parts (biosig-zarr tag in stores, .bzx, generated_by, conformance classes) as not yet implemented | owner |  |
| 2026-11-20T11:17-08:00 | Rule: at most one RFC open for comment at a time (rfc-check enforces it). RFC-0002 opens only after RFC-0001 closes | owner |  |
| 2026-11-20T11:24-08:00 | C0 review applied: new steps O0, E0, A2, S1, B6, O4b, N1, C3, C4; B3 is a pointer page; Q12 moot; Q19 asks the owner about Slots | lead |  |
| 2026-11-20T11:24-08:00 | Q1: | owner |  |
| 2026-11-20T11:24-08:00 | Q2: | owner |  |
| 2026-11-20T11:24-08:00 | Q3: | owner |  |
| 2026-11-20T11:24-08:00 | Q4: | owner |  |
| 2026-11-20T11:24-08:00 | Q5: | owner |  |
| 2026-11-20T11:24-08:00 | Q6: | owner |  |
| 2026-11-20T11:24-08:00 | Q7: | owner |  |

## Log

| Time | Event |
|---|---|
| 2026-11-20T11:12-08:00 | O1 repo and O2 done by lead on owner's instruction; V1 dispatched; C0 reviews running |
