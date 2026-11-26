# Publication queue (epic #2182): decide + evidence: log

<!--
Append-only history for the board beside this file.
Written by `manager_board.py log` and `decide`; never rewrite or delete a row.
The manager reads the newest rows through `status`, never the whole file.
-->

## Decisions

| Time | Decision | By | Reason |
|---|---|---|---|
| 2026-11-25T11:12-08:00 | Plan v2 approved with defaults (lead=manager this session, local phase gate, Sonnet/Opus parity, 3 slots, 40 agents/day) | owner |  |
| 2026-11-25T11:12-08:00 | ADR 0139 approved as drafted; accepted on the decide branch | owner |  |
| 2026-11-25T11:22-08:00 | Platform review cap 150 (Q1); in PR #2370 with ADR 0102 amendment | owner |  |
| 2026-11-25T11:22-08:00 | A1 stop: rebuild migration of upstream_repull_screens in A1 (option a); PREFLIGHT_VERSION 2; old ack word kept as alias; formatCoverage moves to the registry | lead |  |
| 2026-11-25T11:22-08:00 | D1: fourth resolver (OpenNeuro GraphQL, PhysioNet API) since registries hold no license for them; README DOIs only for data-repository prefixes; no openapi entry | lead |  |
| 2026-11-25T14:00-08:00 | CP-D1: batch acknowledgment rests on a confirmed public upstream (owner); card D3 written | owner |  |
| 2026-11-25T14:00-08:00 | Empty repos nm000589, nm000978: deny, ask the depositor to re-upload (owner) | owner |  |
| 2026-11-25T14:48-08:00 | A2: companions paired by BIDS basename; header-named files checked in scan(); mismatch = partial/companion-missing; .vmrk/.inf read; no contract change | lead |  |
| 2026-11-25T14:52-08:00 | A2 FP gate: NIRx runs on all public headers found (>=20, count stated); 200-file gate waived for NIRx only; thresholds unchanged | lead |  |
| 2026-11-25T14:56-08:00 | A3: walker logical read cap 20,000; real bounds are source fetches (page cache), bytes and time, declared per reader by A4/A5 | lead |  |
| 2026-11-25T14:57-08:00 | B4 stop resolved: Worker serves inputs via token-auth POST /publication-review-inputs (claimed review only); script fetches before pre-send; failure = inputs_unavailable; no workflow change; ADR 0139 d7 amended (+redistribution_prohibited, source_is_publication) | lead |  |
| 2026-11-25T15:15-08:00 | D3: exclusion also applied to the screened head's tree at run time (shared classifier); D2 list kept for history; route cap 20; approve CLI check compares ack author | lead |  |
| 2026-11-25T15:22-08:00 | D3: BIDS _photo files make a request ineligible for batch ack (individual look); screen rule unchanged | lead |  |
| 2026-11-25T15:33-08:00 | A4: hdf5-identifier-field (JSON identifier keys on HDF5 fields); day-precision DOB = identifier, year/month = review; name-like only in person fields; elsewhere local-path rule only | lead |  |
| 2026-11-25T15:34-08:00 | A2: name mismatch = informational (non-gating); vmrk limit 16 MiB; age alone no finding, DOB by precision; Notes/Contact local-path+email/phone+person-field names; contract adds coverage not-applicable (Analyze .hdr stays unscreened) | lead |  |
| 2026-11-25T15:49-08:00 | A4: SubjectID identifier only for an all-letter name-like token; letters+digits = review; shared function reused by A5 for EEGLAB subject | lead |  |
| 2026-11-25T16:06-08:00 | B4: inputs_unavailable after the Worker served inputs is rewritten to workflow_failed (counted), via inputs_served_at | lead |  |
| 2026-11-25T16:25-08:00 | A4 deviations accepted (bare 'name' not a person field; rule B in person fields; byte bound on requested bytes; label role removed; extensions kept in OTHER list); SNIRF limits 48 MiB/1,000 fetches/180 s | lead |  |
| 2026-11-25T16:50-08:00 | Shared person-field rule: describing-field exclusion (age, sex, gender, type, info, history, group, notes, remarks, date, contact) and token matching | lead |  |
| 2026-11-25T17:20-08:00 | B5: errored confirming run = confirm_failed (never deny); confirming run excluded from depositor tally, kept in platform cap | lead |  |
| 2026-11-25T17:37-08:00 | Owner raised today's agent limit to 60 (Q2) | owner |  |
| 2026-11-25T18:13-08:00 | A9: index.ts local-only skip accepted; packaged scanner id = identifier-scan@nemar-cli-v<version>; LOCAL_COPY into shared copy; screen in common commands | lead |  |
| 2026-11-25T18:27-08:00 | Owner: license-lineage failures get a known workflow: depositor sends author evidence to support@nemar.org; admin records it linked to the ticket; clears that reason only (card B6, issue #2391) | owner |  |
| 2026-11-25T18:38-08:00 | A5: maxElements 1,000,000 (time cap bounds); event/history name rule = two capitalized name-like words after path removal; all location fields unscanned; ReaderResult.needs = same-dir bare names | lead |  |
| 2026-11-25T18:49-08:00 | A5: EEG.BIDS.* gets no person-field rule (MATLAB layer); shared rule gains 'thing word + name = thing' and 'description' as describing word (one definition) | lead |  |
| 2026-11-25T18:56-08:00 | A6: path kinds inside archives aggregated per kind per archive and exempt from the reader gate; unread inner entries = zip:<ext>; NIRx Name via readSubjectId | lead |  |
| 2026-11-25T18:59-08:00 | A5: P1 event-table columns = event-type rule; P2 shared location-field predicate (path/file/filename/dir/folder/original_*); P3 one finding per kind+field per file; path rule kept on comments and README copy | lead |  |
| 2026-11-25T19:10-08:00 | A5: event tables name rule on 'type' only (other columns unscanned, like events.tsv); setname: no path rule, keeps the two-word name rule | lead |  |
| 2026-11-25T19:15-08:00 | B6: deviations accepted (permission bound to sources, outcome and target license); basis_unrecorded -> start a new review; recording re-derives verdict, mails admins Ready to approve if pass+clear, tells depositor evidence recorded | lead |  |
| 2026-11-25T19:20-08:00 | B6 ticket binding: trust the admin visibly (dry run shows ticket subject and sender, warns if sender is not the depositor, audit records both) | lead |  |
| 2026-11-25T19:55-08:00 | A5 FieldTrip: pwd/cwd location words; skip cfg.version/callinfo/toolbox as provenance; not cfg.previous wholesale, not bare dataset; merge occurrences+entries into one Finding count | lead |  |
| 2026-11-25T20:31-08:00 | A5: a fieldless struct with count > 0 is valid (MATLAB struct()), walks nothing; counts past 2^53 are corrupt | lead |  |
| 2026-11-25T20:43-08:00 | Owner raised today's limit to 66 (Q3) | owner |  |

## Log

| Time | Event |
|---|---|
| 2026-11-25T11:12-08:00 | Dispatched D1 (#2361), D2 (#2362), A1 (#2185); D0 next for the lead |
| 2026-11-25T11:15-08:00 | D0: draft PR #2370 into dev (flag + guard test); waits on owner checklist |
| 2026-11-25T11:16-08:00 | CP-D2 done: cards B3, B4, B5 written after ADR 0139 accepted |
| 2026-11-25T11:23-08:00 | PR #2370 reviewed (r1), suggestions fixed |
| 2026-11-25T11:25-08:00 | D2 report: images-only ack empties 1 more request; 349 held by unread formats only; 2 empty repos |
| 2026-11-25T14:02-08:00 | PR #2372 r1 done: fixes sent |
| 2026-11-25T14:03-08:00 | PR #2373 r1 done: settle redesign sent |
| 2026-11-25T14:04-08:00 | D2 merged (#2371 -> 4ae05b17); CP-D1 already answered; D3 waits on D1 |
| 2026-11-25T14:07-08:00 | PR #2374 r1 done: fixes sent (range-ignored, limit safeguard, 3 mutants) |
| 2026-11-25T14:20-08:00 | Local pure tier replaced by remote CI (faster under load); killed local run |
| 2026-11-25T14:35-08:00 | D4 green but conflicting after D1 merge; base merge sent |
| 2026-11-25T14:42-08:00 | A1 merged (#2374 -> 5c3d65d5): A2, A6, A9 ready |
| 2026-11-25T15:46-08:00 | Incident: A2 ran A4's mutate.py (shared scratchpad name collision) on A4's worktree; A4 asked to verify; preamble now requires per-step scratch dirs |
| 2026-11-25T15:47-08:00 | Incident closed: A4 verified worktree intact (rules and later edits present, 35 tests pass) |
| 2026-11-25T16:47-08:00 | Seam: text-header.ts had its own isPersonField (drifted) and biome errors outside lint scope; A4 consolidates |
| 2026-11-25T18:36-08:00 | CP-D3 seam review: ready-with-fixes (CHANGELOG missing; command wording drift); tests pass except known parallel/compute and stale-website failures |
| 2026-11-25T19:53-08:00 | A5 PR #2395: FP gate mostly within bounds; .mat cfg paths 7.09/100 and .set comments 6.10/100 over; R15 memory risk recorded |
| 2026-11-25T20:20-08:00 | Decide epic PR #2397 into dev opened (mergeable); owner merges |
| 2026-11-25T20:56-08:00 | A5 #2395 merged into evidence |
| 2026-11-25T21:06-08:00 | A10 verified (2398 c99a426d, docs#143 d5e174d); docs#143 waits for owner merge |
