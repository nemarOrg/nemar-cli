# NEMAR RFC program

<!--
manager-loop board: state only, history goes to the -log file beside it, specs to the plan and cards.
Write through the helper (manager_board.py set, tick, ask, propose, spend) and run `check` after any hand edit.
The owner owns Parity, Slots, and Budget limits: the manager proposes changes there, never makes them.
These are the defaults; the owner's approval of the plan accepts them.
Step states: outline (not dispatchable), todo, active, review, blocked, owner (waits on the owner), done, dropped.
In Steps and Questions, the first column holds each row's identifier (ID); in Steps, PR holds the pull request (PR) number.
-->

## Now

| Key | Value |
|---|---|
| Plan | .context/rfc-program/plan.md |
| Repo | nemarOrg/nemar-cli, nemarOrg/rfcs, nemarOrg/biosig-zarr, nemarOrg/docs |
| Integration branch | feature/rfc-program (nemar-cli); main (rfcs, biosig-zarr; docs owner-merged) |
| Manager id | mba-claude-sonnet |
| State | running |
| Cadence | 30m with workers running, 60m waiting on people |
| Last tick | 2026-11-21T10:06-08:00 |
| Next tick | 2026-11-21T10:36-08:00 |
| Stop when | every step done, or all remaining work waits on the owner |
| Created | 2026-11-20T09:44-08:00 |

## Parity

| Tier | Claude | Codex | Copilot | Notes |
|---|---|---|---|---|
| worker | Sonnet high | gpt-6-luna max | balanced coding model | routine cards from a detailed plan |
| worker-hard | Sonnet xhigh | gpt-6.1-terra xhigh | balanced reasoning model | protocol, concurrency, security, contract work |
| lead | Opus xhigh | gpt-6.1-sol xhigh | strong reasoning model | default for planning, design, first-level advice |
| frontier | Fable | gpt-6-astra xhigh | strongest model | only when the owner asks, for long-horizon planning, or a frontier trigger the plan lists |
| reviewer | Sonnet high | gpt-6-luna max | balanced coding model | a different model family from the implementer when possible |
| owner | person | person | person | owner steps; never dispatched |

## Slots

| Slot | Platform | Tiers | Max | Can | Notes |
|---|---|---|---|---|---|
| claude-sonnet | Claude | worker, worker-hard, reviewer | 3 | gui, browser | graphical user interface (GUI) or computer use only with the owner's announced consent |
| claude-opus | Claude | lead | 4 | gui, browser |  |
| codex | Codex | worker, worker-hard, lead | 0 | | owner opens this slot; never computer use or visible runs |

## Budget

| Item | Limit | Used | Resets | Notes |
|---|---|---|---|---|
| Agents today | 80 | 0 | daily | implementers, reviewers, advisors spawned; the plan approval covers this limit |
| Agents this wave | 15 | 0 | wave | items x (1 + review panel + 1 delta + fix rounds) + 1 advisor |
| Advisor consults | 3 | 1 | never | lead tier; frontier only when the owner or the plan says |

## Waves

| Wave | Goal | Agents | State | Exit gate |
|---|---|---|---|---|

## Steps

| ID | Title | Wave | Tier | Needs | Slot | State | Depends | PR | Review | Started | Timebox | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| O0 | Owner approves the plan; lead pushes feature/rfc-program | - | owner | - | - | done | - | - |  | - | - | approved 2026-11-20 |
| V1 | [Measure what RFC-0002 needs](cards/V1.md) | - | worker | - | claude-sonnet | done | - | 2238 | r1 code+comments, tests (2 Sonnet): 0 crit, 4 imp, 7 sugg, all fixed; r2 delta clean | 2026-11-20T11:12-08:00 | 4h | merged 2d98bd9b; feeds C2 (V2 card) |
| E0 | Lead creates the epic issue with /project:epic-dev | - | lead | - | - | done | O0 | - |  | - | - | epic #2239; sub-issues 2240-2254 (map in board-log) |
| O1 | Owner finishes nemarOrg/rfcs Discussions setup | - | owner | - | - | done | - | - |  | - | - | rfcs Discussions, org Discussions and RFCs category verified 2026-11-20 |
| O2 | Owner creates nemarOrg/biosig-zarr, comments on biosigio#179 | - | owner | - | - | done | - | - |  | - | - | repo, README and biosigio#179 comment done 2026-11-20 |
| A2 | [ADR supersedes parts of ADR 0128](cards/A2.md) | - | lead | - | claude-opus | done | O0 | 2269 | r1 code+comments (1 Sonnet, docs-only): 2 sugg fixed + index sync; fix diff verified by manager | 2026-11-20T12:57-08:00 | 4h | merged 0184cb051d77587144f501a327b3928c9da97033; ADR 0131; #2217 to be closed or rescoped by owner |
| A1 | [ADR adopts the RFC process](cards/A1.md) | - | worker | - | claude-sonnet | done | O0 | 2268 | r1 code+comments (1 Sonnet, docs <50 lines): 3 sugg, 2 fixed, 1 no change; fix diff verified by manager | 2026-11-20T12:57-08:00 | 4h | merged b20b9e93 (ADR 0130) |
| S1 | [Back-catalog scan and throughput](cards/S1.md) | - | worker | - | claude-sonnet | active | O0 | - |  | 2026-11-20T16:45-08:00 | 1d | impl-S1 running |
| R1 | [nemarOrg/rfcs process and checks](cards/R1.md) | - | worker-hard | - | claude-sonnet | done | O0, O1 | rfcs#1 | r1 code/errors/types/comments + tests (2 Sonnet): 5 imp, 9 sugg fixed; r2 delta clean, 2 sugg rejected (cosmetic) | 2026-11-20T12:57-08:00 | 2d | merged c3a3ccc6 into rfcs main |
| O1b | Owner applies the main ruleset requiring rfc-check | - | owner | - | - | done | R1 | - |  | - | - | ruleset protect-main 27763743 active, verified (rfc-check required, admins bypass via PR) |
| R3 | [Weekly report shows the RFC clock](cards/R3.md) | - | worker-hard | - | claude-sonnet | done | R1 | 2278 | r1 code+tests (2 Sonnet): 1 imp, 4 sugg fixed; r2 delta clean, 2 sugg rejected (empty-title placeholder: rfc-check requires a title; port-9 test never reaches GitHub) | 2026-11-20T16:45-08:00 | 1d | merged 14d49c8e |
| B1 | [biosig-zarr initialized](cards/B1.md) | - | worker-hard | - | claude-sonnet | done | A2 | biosig-zarr#1 | r1 code/errors + comments (2 Sonnet): 2 imp, 5 sugg fixed, 3 rejected with reason; fix diff verified by manager | 2026-11-20T14:25-08:00 | 1d | merged 5794535df619f7daef8d91d79928c7a803a99e8b (merge commit, keeps DCO sign-offs) |
| B2 | [Spec text moves into biosig-zarr](cards/B2.md) | - | worker | - | claude-sonnet | done | B1 | biosig-zarr#2 | r1 code/errors/tests + comments (2 Sonnet): 0 crit/imp; 2 sugg fixed (link-target check), 1 no change; fix diff verified by manager | 2026-11-20T15:30-08:00 | 1d | merged 36112961471b46de1a96e5cb67f9581772d9146e |
| R2 | [docs page /policies/rfcs/](cards/R2.md) | - | worker | - | claude-sonnet | done | A1, R1 | docs#127 | r1 code+comments (1 Sonnet, docs): 2 sugg fixed; fix diff verified by manager | 2026-11-20T14:50-08:00 | 1d | owner merged docs#127 (2026-11-20T22:15:20Z ee23bf7f) |
| O4 | Owner releases 2.0.0 from B2's merge commit | - | owner | - | - | done | B2 | - |  | - | - | release 2.0.0 on 36112961, isPrerelease false (verified) |
| B3 | [docs format page becomes a pointer](cards/B3.md) | - | worker | - | claude-sonnet | done | O4 | docs#128 | r1 code+comments (1 Sonnet): no PR findings; stop item resolved by Q23 | 2026-11-20T16:05-08:00 | 4h | merged by manager on owner instruction (691d5f4f); CI green after billing fix |
| B6 | [Version 3 text on draft/3.0.0](cards/B6.md) | - | lead | - | claude-opus | done | O4, A2 | biosig-zarr#4 | r1 decisions+technical (2 Sonnet): 7 imp, ~11 sugg fixed; r2 delta clean, 2 sugg fixed, verified by manager | 2026-11-20T16:05-08:00 | 2d | draft waits for the owner: biosig-zarr#4 head 08a990b7 |
| O4b | Owner tags 3.0.0-draft.1 | - | owner | - | - | done | B6 | - |  | - | - | pre-release 3.0.0-draft.1 on 08a990b7, isPrerelease true (verified); compare link 200 |
| B4 | [RFC-0001 text, draft PR](cards/B4.md) | - | lead | - | claude-opus | done | R1, B2, A2 | rfcs#2 | r1 decisions+technical (2 Sonnet): 6 imp, ~13 sugg fixed; r2 delta+seam: 1 imp fixed (aligned to spec), verified by manager | 2026-11-20T16:05-08:00 | 2d | draft waits for the owner: rfcs#2 head b49245f2 (Q36-Q40) |
| B5 | [Version 3 schemas and vectors](cards/B5.md) | - | lead | - | claude-opus | done | B5a, O4d, B6 | biosig-zarr#6 | r1 spec+tools (2 Sonnet): 3 imp, 6 sugg fixed (layer per advisor); r2 delta clean; 1 sugg fixed, verified by manager | 2026-11-20T18:15-08:00 | 3d | merged into draft/3.0.0 (ac6e3124f44e3d7e940fe25430cee4296f755d39) |
| N1 | [RFC-0001 announcement drafts](cards/N1.md) | - | worker | - | claude-sonnet | done | B4 | 2273 | r1 comments (1 Sonnet): 0 crit/imp, 4 sugg fixed or no change; r2 delta clean; 1 sugg (stale card N1 text) to the lead | 2026-11-20T18:45-08:00 | 4h | merged 0585cc96; drafts in owner/announce-0001 for O5 |
| O5 | Owner opens RFC-0001 | - | owner | - | - | blocked | B4, B6, O4b, O1b, S1, N1, B5a, O4d, B5, O4c, B4c | - |  | - | - | owner step; also mail epic #2260 P1-P3 and privacy text in production |
| C3 | Checkpoint: RFC-0001 closed, decision draft, follow-through outline | - | lead | - | - | blocked | O5 | - |  | - | - | when RFC-0001's close instant passes |
| V2 | [RFC-0002 text, draft PR](cards/V2.md) | - | lead | - | - | outline | V1, O5 | - |  | - | 2d | lead completes at C2 (Q16) |
| O6 | Owner opens RFC-0002 after RFC-0001 closes | - | owner | - | - | blocked | V2, C3 | - |  | - | - | one RFC open at a time |
| C4 | Checkpoint: RFC-0002 closed, decision draft, process ADR review | - | lead | - | - | blocked | O6 | - |  | - | - | when RFC-0002's close instant passes |
| A3 | [ADR amends 0124: vectors canonical in biosig-zarr](cards/A3.md) | - | lead | - | claude-opus | blocked | - | 2277 |  | 2026-11-20T16:45-08:00 | 4h | held: ADR 0132 merged into mail epic branch (PR 2270), not yet on dev; waits for that epic to reach dev |
| B5a | [Version 2 schemas and vectors on main](cards/B5a.md) | - | lead | - | claude-opus | done | B2, O4 | biosig-zarr#5 | r1 spec+tools (2 Sonnet): 3 imp, ~10 sugg fixed; r2 delta clean, 1 sugg rejected (docstring is fixed, cannot be empty) | 2026-11-20T16:45-08:00 | 2d | merged 3bd184a9c85a3a9cc646dce94b98520021231650 |
| O4d | Manager releases 2.0.1 on owner say-so | - | owner | - | - | done | B5a | - |  | - | - | release 2.0.1 on 3bd184a9, isPrerelease false (verified) |
| O4c | Manager tags 3.0.0-draft.2 on owner say-so (Q36) | - | owner | - | - | done | B5 | - |  | - | - | pre-release 3.0.0-draft.2 on ac6e3124f44e3d7e940fe25430cee4296f755d39, isPrerelease true (verified) |
| B4b | [RFC-0001 points at 3.0.0-draft.2, license notice](cards/B4b.md) | - | lead | - | claude-opus | done | O4c | rfcs#2 | r1 comments+seam (1 Sonnet): clean; 2 sugg moved to B4c | 2026-11-20T19:55-08:00 | 2h | superseded by B4c (independence notice, draft.3) |
| SC1 | [Store Contract states v3 NEMAR profile](cards/SC1.md) | - | lead | - | claude-opus | done | B6, O4b | docs#129 | r1 code+comments (1 Sonnet): clean, 1 sugg no change needed | 2026-11-20T16:45-08:00 | 4h | merged by manager on owner instruction (f6305f74) |
| B7 | [biosig-zarr main: NEMAR as origin and implementer only](cards/B7.md) | - | lead | - | claude-opus | active | - | - |  | 2026-11-20T19:40-08:00 | 4h | resumed 11-21 10:07 after usage limit; edits uncommitted, gates passed; PR next |
| O4e | Manager releases 2.0.2 on owner say-so (Q37/Q38) | - | owner | - | - | todo | B7 | - |  |  | - | - |
| B7b | [draft/3.0.0 takes 2.0.2, drops NEMAR as decider](cards/B7b.md) | - | lead | - | - | todo | B7, O4e | - |  |  | 3h | - |
| O4f | Manager tags 3.0.0-draft.3 on owner say-so (Q37/Q38) | - | owner | - | - | todo | B7b | - |  |  | - | - |
| B4c | [RFC-0001 on 3.0.0-draft.3, independence notice](cards/B4c.md) | - | lead | - | - | todo | B4b, O4e, O4f | - |  |  | 2h | - |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|
| Q1 | A1 | What does final comment mean? | Inside the window, shepherd summary and proposed disposition at least 7 days before close, required to accept (Recommended) / A separate period after the window | none | 2026-11-24T17:00 | closed | Inside the window, shepherd summary and proposed disposition at least 7 days before close, required to accept (owner, 2026-11-20T10:09-08:00) |
| Q2 | A1 | Who decides an RFC? | Owner for org RFCs, answering each objection in writing; dataset RFCs NEMAR with the dataset owner's recorded position and consent for author-owned content (Recommended) / Owner alone for all | none | 2026-11-24T17:00 | closed | Owner for org RFCs, answering each objection in writing; dataset RFCs NEMAR with the dataset owner's recorded position and consent for author-owned content (owner, 2026-11-20T10:09-08:00) |
| Q3 | A1 | Who may open an RFC? | Anyone proposes; a NEMAR owner or admin opens it as shepherd (Recommended) / Only NEMAR proposes and opens | none | 2026-11-24T17:00 | closed | Anyone proposes; a NEMAR owner or admin opens it as shepherd (owner, 2026-11-20T10:09-08:00) |
| Q4 | A1 | Which RFC outcomes get an ADR? | Accepted, and a rejection that closes off a reasonable path; the ADR names the RFC (Recommended) / Every outcome | none | 2026-11-24T17:00 | closed | Accepted, and a rejection that closes off a reasonable path; the ADR names the RFC (owner, 2026-11-20T10:09-08:00) |
| Q5 | A1 | Accept comments from people without a GitHub account? | Yes, via the support address, posted with consent (Recommended) / No, GitHub only | none | 2026-11-24T17:00 | closed | Yes, via the support address, posted with consent (owner, 2026-11-20T10:09-08:00) |
| Q6 | R1 | Licenses for nemarOrg/rfcs? | MIT for tooling, CC BY 4.0 for text (Recommended) / MIT for tooling, W3C for text to match biosig-zarr | none | 2026-11-24T17:00 | closed | MIT for tooling, CC BY 4.0 for text (owner, 2026-11-20T10:09-08:00) |
| Q7 | R1 | Where does the RFC clock run? | Scheduled Action in nemarOrg/rfcs plus a weekly report line (R3) (Recommended) / Action only / Worker production cron in nemar-cli | none | 2026-11-24T17:00 | closed | Scheduled Action in nemarOrg/rfcs plus a weekly report line (R3) (owner, 2026-11-20T10:09-08:00) |
| Q8 | B1 | Contribution terms for biosig-zarr? | Developer Certificate of Origin sign-off, inbound equals outbound (Recommended) / A contributor license agreement / None stated | none | 2026-11-25T17:00 | closed | Developer Certificate of Origin sign-off, inbound equals outbound (owner, 2026-11-20T11:49-08:00) |
| Q9 | B5 | Canonical home of conformance vectors? | nemarOrg/biosig-zarr, nemar-cli vendors by digest, amending proposed ADR 0124 (Recommended) / nemar-cli, biosig-zarr vendors | none | 2026-12-01T17:00 | closed | Conformance test files live in nemarOrg/biosig-zarr; nemar-cli vendors them by digest (owner, 2026-11-20T12:18-08:00) |
| Q10 | O5 | May RFC-0001 open with no implementation? | Open with text plus schemas and a few real vectors, no packer (Recommended) / Wait for a prototype packer and vectors / Open with text only | none | 2026-12-01T17:00 | closed | Open with text plus schemas and a few real vectors, no packer (owner, 2026-11-20T11:49-08:00) |
| Q11 | B2 | Mint the Zarr convention uuid now, recorded in a biosig-zarr ADR, so the version 3 writer writes it from its first store? | Mint now (Recommended) / Later | none | 2026-11-25T17:00 | closed | Mint now, recorded in a biosig-zarr ADR (owner, 2026-11-20T11:49-08:00) |
| Q12 | B3 | Docs mechanics for the spec page? | Build-time fetch of the pinned tag with digest check and a per-page W3C license notice (Recommended) / Hand-kept copy with the notice | none | 2026-12-01T17:00 | closed | Moot: the owner removed the page and replaced it with a pointer (2026-11-20) |
| Q13 | O4 | Register w3id.org/biosig-zarr as the permanent identifier (a PR to an outside registry, by the owner)? | Yes, pointing at docs.nemar.org for now (Recommended) / Another scheme / Not now | none | 2026-12-15T17:00 | closed | Yes, register w3id.org/biosig-zarr now (lead files the PR, pointing at nemarOrg/biosig-zarr since the docs page becomes a pointer) (owner, 2026-11-20T12:18-08:00) |
| Q14 | O4 | Do biosig-zarr spec releases get a DOI? | Yes, through NEMAR's EZID shoulder, from the first beta tag (Recommended) / Not until 1.0 / Never | none | 2027-01-04T17:00 | closed | Yes: spec releases get a NEMAR DOI, for example nemar.biosig-zarr.v3, issued through the new nemar-doi registry; nemar-process gets nemar.process.vN DOIs the same way (owner, 2026-11-20T12:18-08:00) |
| Q15 | N1 | When RFC-0001 opens, send short notes to: the OME-Zarr RFC-9 authors and the Zarr community, the hdmf-zarr and NWB maintainers, the cited BIDS threads and BEP047, and MNE-Python issue 13429? | All of them (Recommended) / Only Zarr and NWB / None | none | 2027-01-04T17:00 | closed | All of them: N1 drafts notes for OME-Zarr RFC-9 authors and Zarr community, hdmf-zarr and NWB maintainers, BEP 045 / bids-specification#2267 threads, MNE-Python 13429 (owner, 2026-11-20T18:40-08:00) |
| Q16 | V2 | For RFC-0002, what does first party mean? | The dataset's source: authors for nm, upstream for on; NEMAR and community are separate origins (Recommended) / NEMAR is the first party | none | 2027-01-15T17:00 | open |  |
| Q17 | R2 | Does the /policies/rfcs/ page need UC San Diego counsel review before publication? | No, it is a process page (Recommended) / Yes, publish as a draft for counsel | none | 2026-11-27T17:00 | closed | No counsel review; it is a process page (owner, 2026-11-20T11:49-08:00) |
| Q18 | O5 | Link to the BEP047 discussion of EDF's irregular and sparse sampling limit? Not found in PR 2231 or issue 2568. | Supply the link / Cite BIDS issues 1796, 2313, 2463 instead (Recommended) | none | 2026-12-08T17:00 | closed | BEP 045 peripheral physiology (bids-specification#2267, bep_045 page), not BEP047 (owner, 2026-11-20T12:18-08:00) |
| Q19 | B4 | Slots: raise claude-opus Max from 1 to 2 (B4, B6 and A2 are lead cards, and checkpoints and advisor consults need the lead too) and add the reviewer tier to claude-sonnet's tiers? | Both (Recommended) / Opus Max 2 only / Neither | none | 2026-11-24T17:00 | closed | Opus Max 4 (owner, 2026-11-20); reviewer tier added to claude-sonnet per the owner's standing rule that PR review agents use Sonnet (owner, 2026-11-20T11:35-08:00) |
| Q20 | - | ADR 0129 is on dev but not feature/rfc-program (48 behind, merges clean), so the gapless ADR index test fails for A1 (0130) and A2 (0131). How to resolve? | Lead merges origin/dev into feature/rfc-program (Recommended) / Add 129 to TOLERATED_GAPS in the A1 PR, removed when dev merges in / Other | none | 2026-11-21T17:00 | closed | Lead merges origin/dev into feature/rfc-program (owner, 2026-11-20T13:10-08:00) (owner, 2026-11-20T12:54-08:00) |
| Q21 | - | Which support address do RFC comments without a GitHub account go to (PROCESS.md, A1, R2)? No support@ found in nemar-cli; info@nemar.org exists. | support@nemar.org (Recommended) / info@nemar.org / Other | none | 2026-11-21T17:00 | closed | Keep the Announcement category; comments go under the RFC Discussion; email fallback support@nemar.org, posted with consent (owner, 2026-11-20T14:05-08:00) |
| Q22 | - | Should ops/ruleset-main.json (rfcs main, requires rfc-check) list a bypass actor so a broken main can be fixed without editing the ruleset? | Repository admins may bypass via pull request only (Recommended) / No bypass / Org admins always | none | 2026-11-21T17:00 | closed | Repository admins may bypass via pull request only (owner, 2026-11-20T14:00-08:00) |
| Q23 | - | B3 stop: docs platform/zarr/store-contract.md (NEMAR serving contract) restates layout text (attribute tree, dequantization, Level 0). Does it violate K2, or is it NEMAR's own contract that may stay? | Keep it: it is NEMAR's serving contract, B3 merges as is (Recommended) / Lead trims it to link to the spec (new card) / Other | none | 2026-11-22T17:00 | closed | Keep the store contract (NEMAR's own serving contract); B3 merges as is (owner, 2026-11-20T16:30-08:00) |
| Q24 | - | biosig-zarr tools/check-moved-text.ts reads the docs page from main; after B3 it compares against a pointer. Pin its default source to docs commit a474abfe (one small PR) or retire it? | Pin to a474abfe in a small PR (Recommended) / Retire the tool / Leave it | none | 2026-11-22T17:00 | closed | Pin check-moved-text.ts default source to docs commit a474abfe in a small biosig-zarr PR (owner, 2026-11-20T16:30-08:00) |
| Q26 | - | B4 text says RFC-0001 opens with schemas, a few real vectors and the 3.0.0-draft.1 tag in place (Q10). Add B5 to O5's dependencies? | Yes, O5 waits on B5 (Recommended) / No, change the RFC sentence | none | 2026-11-22T17:00 | closed | Yes, O5 waits on B5 (owner, 2026-11-20T17:00-08:00) |
| Q27 | - | biosig-zarr text.yml path filter (card B1) skips PRs touching only tools/** or JSON, so they get no lint. Add tools/**, *.json, package.json, biome.json to the filter? | Yes, small PR (Recommended) / Leave as the card says | none | 2026-11-22T17:00 | closed | Yes, widen biosig-zarr text.yml filter in a small PR (owner, 2026-11-20T17:00-08:00) |
| Q25 | - | Third-party review: EDF+D can encode irregular samples as timestamped zero-duration records; replace RFC-0001's 'EDF cannot' sentence and add the 2.02 s gap reader test. Apply? | Verify, then apply both (Recommended) / Wording only / Neither | none | 2026-11-21T17:00 | closed | First confirm against the EDF+ spec; if it makes sense apply both (owner, 2026-11-20T17:00-08:00) |
| Q28 | - | B6 makes reading version 2 stores a MUST for every version 3 reader (version 1 a SHOULD). D2 only says the back catalog stays readable as v2. Keep the MUST? | Keep MUST, mark it open for comment (Recommended) / Keep MUST, not open / Make it SHOULD | none | 2026-11-22T17:00 | closed | Keep MUST for reading v2, settled (not open); version 1 is expired, so no v1 reading requirement (owner, 2026-11-20T17:45-08:00) |
| Q29 | - | B6 puts NEMAR profile choices for v3 (D5, D7, D11, D12, no timestamped group in index.json) in the spec's NEMAR profile section, which also names the Store Contract as authoritative. Where should they live? | Spec profile section, Store Contract updated at rollout (Recommended) / Store Contract only / Both now | none | 2026-11-22T17:00 | closed | Both now: spec profile section keeps the v3 NEMAR choices, and the docs Store Contract is updated now (new docs card by the lead) (owner, 2026-11-20T17:45-08:00) |
| Q30 | - | Q25 test is ill-defined under B6: a 2.00-2.04 s gap at 10 Hz is shorter than one sample and cannot be written in valid_intervals (grid indices). How should sub-sample gaps be handled? | Test with a gap of at least one sample, plus an RFC question on sub-sample gaps (Recommended) / Lead redesigns gaps in source time / Drop the test | none | 2026-11-21T17:00 | closed | Test with a gap of at least one sample, state sub-sample gaps need the timestamped kind, add an RFC question (owner, 2026-11-20T17:55-08:00) |
| Q31 | - | N1 community notes: mention RFC-9 authors and hdmf-zarr maintainers by GitHub handle (notifies them when posted) or leave them unmentioned? | Leave unmentioned, post in their repos (Recommended) / Mention by handle | none | 2026-11-22T17:00 | closed | Do not post in other projects' repos; RFC-0001 is NEMAR's question for the biosignal community; post on EEGLAB and other venues (owner, 2026-11-20T19:10-08:00) |
| Q32 | - | Which biosignal community venues get an RFC-0001 note (Q31)? | EEGLAB list, MNE Forum, FieldTrip list, Neurostars (Recommended) / EEGLAB list only / Other | none | 2026-11-22T17:00 | closed | EEGLAB mailing list, MNE Forum, Neurostars (owner, 2026-11-20T19:15-08:00) |
| Q33 | - | B5 schemas and vectors: all on draft/3.0.0, or v2 ones ruled editorial and released on main as 2.0.1? | All on draft/3.0.0 (Recommended) / v2 parts on main as 2.0.1 | none | 2026-11-22T17:00 | closed | v2 schemas and vectors are editorial, on main, released as 2.0.1; v3 parts on draft/3.0.0 (owner, 2026-11-20T20:20-08:00) |
| Q34 | - | ADR 0124 amendment (vectors canonical in biosig-zarr, vendored by digest): write at C3 or now after mail ADR 0132 merges? | At C3 (Recommended) / Now, as a lead step | none | 2026-11-22T17:00 | closed | Write the ADR 0124 amendment now, as a lead step (owner, 2026-11-20T20:20-08:00) |
| Q35 | - | The EDF+D header scan (pid 99119, remi:18769) is still running. Let it finish, then dispatch S1, or stop it and dispatch S1 now? | Let it finish (Recommended) / Stop it now | none | 2026-11-22T17:00 | closed | Owner gave the counts so far; scan is actively progressing (13000/16883); let it finish, S1 after (owner, 2026-11-20T20:20-08:00) |
| Q36 | - | O4c (tag 3.0.0-draft.2 after B5): owner runs it, or the manager runs it under the new P1 rule? | Manager runs it on owner say-so (Recommended) / Owner runs it | none | 2026-11-24T17:00 | closed | Manager runs O4c on the owner's say-so under the P1 rule (owner, 2026-11-20T20:20-08:00) |
| Q37 | - | RFC-0001 quotes spec text with the notice 'Copyright (c) 2026 NEMAR contributors', W3C Software and Document License (from biosig-zarr LICENSE.md). Is that the notice you want? | Yes, as in LICENSE.md (Recommended) / A different holder | none | 2026-11-22T17:00 | closed | biosig-zarr is independent of NEMAR; holder 'the biosig-zarr contributors'; reword all, new 2.0.2 and 3.0.0-draft.3 (owner, 2026-11-20T20:35; detail in Decisions) |
| Q39 | - | Who is the biosig-zarr spec editor under independence? | Seyed Yahya Shirazi, personal capacity; rewording ruled editorial (Recommended) / A governance RFC after RFC-0001 / NEMAR's owner stays editor | none | 2026-11-22T17:00 | closed | Seyed Yahya Shirazi, personal capacity; rewording ruled editorial (owner, 2026-11-20T21:25-08:00) |
| Q40 | - | Where are biosig-zarr RFCs decided under independence? | Keep nemarOrg/rfcs; the spec editor decides; RFC-0001 stays NEMAR RFC 0001 (Recommended) / biosig-zarr's own process (moves RFC-0001, delays O5) | none | 2026-11-22T17:00 | closed | Keep nemarOrg/rfcs; the spec editor decides; RFC-0001 stays NEMAR RFC 0001 (owner, 2026-11-20T21:25-08:00) |
| Q41 | - | Where does the biosig-zarr repository live? | Stay in nemarOrg as hosting only; move when a second institution co-maintains (Recommended) / Transfer to its own organization now | none | 2026-11-22T17:00 | closed | Stay in nemarOrg as hosting only; move when a second institution co-maintains (owner, 2026-11-20T21:25-08:00) |
| Q42 | - | Release DOIs for biosig-zarr (Q14 planned NEMAR DOIs)? | Keep nemar-doi as a registration service / Zenodo (lead's pick; note AGENTS.md says EZID not Zenodo for NEMAR) / No DOI before beta | none | 2026-11-22T17:00 | closed | Keep nemar-doi, described as a registration service (owner, 2026-11-20T21:25-08:00) |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|
| P1 | 2026-11-20T13:29-08:00 | Owner says a rule is wrong and should be updated clearly; the lead rewrites it in runbook.md (manager cannot edit the runbook) | owner, 2026-11-20T15:00: 'That is wrong rule, ask an owner to update the rules clearly' | accepted |
| P2 | 2026-11-20T14:40-08:00 | Lead writes a docs card: update /platform/zarr/store-contract/ with the v3 NEMAR profile choices (D5, D7, D11, D12, index.json rule), owner merges | owner answer Q29 'Both now' | accepted |
| P3 | 2026-11-20T15:01-08:00 | Lead updates card N1 Scope text for notes.md to the Q31/Q32 venues (EEGLAB list, MNE Forum, Neurostars) | N1 r2 review: card text predates Q31/Q32 | accepted |

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
| impl-V1 | implementer | claude-sonnet | Sonnet | V1 | 2026-11-20T13:10-08:00 | done |
| impl-A2 | implementer | claude-opus | Opus xhigh | A2 | 2026-11-20T12:57-08:00 | done |
| impl-A1 | implementer | claude-sonnet | Sonnet high | A1 | 2026-11-20T12:57-08:00 | done |
| impl-R1 | implementer | claude-sonnet | Sonnet xhigh | R1 | 2026-11-20T12:57-08:00 | done |
| rev-V1-code | reviewer | claude-sonnet | Sonnet high | V1 | 2026-11-20T13:00-08:00 | done |
| rev-V1-tests | reviewer | claude-sonnet | Sonnet high | V1 | 2026-11-20T13:00-08:00 | done |
| lead-devmerge | lead | claude-opus | Opus xhigh | - | 2026-11-20T13:10-08:00 | done |
| rev-V1-delta | reviewer | claude-sonnet | Sonnet high | V1 | 2026-11-20T13:18-08:00 | done |
| rev-A1 | reviewer | claude-sonnet | Sonnet high | A1 | 2026-11-20T13:30-08:00 | done |
| rev-R1-code | reviewer | claude-sonnet | Sonnet high | R1 | 2026-11-20T13:45-08:00 | done |
| rev-R1-tests | reviewer | claude-sonnet | Sonnet high | R1 | 2026-11-20T13:45-08:00 | done |
| rev-A2 | reviewer | claude-sonnet | Sonnet high | A2 | 2026-11-20T14:08-08:00 | done |
| impl-B1 | implementer | claude-sonnet | Sonnet xhigh | B1 | 2026-11-20T14:25-08:00 | done |
| rev-R1-delta | reviewer | claude-sonnet | Sonnet high | R1 | 2026-11-20T14:40-08:00 | done |
| impl-R2 | implementer | claude-sonnet | Sonnet high | R2 | 2026-11-20T14:50-08:00 | done |
| rev-R2 | reviewer | claude-sonnet | Sonnet high | R2 | 2026-11-20T15:05-08:00 | done |
| rev-B1-code | reviewer | claude-sonnet | Sonnet high | B1 | 2026-11-20T15:05-08:00 | done |
| rev-B1-text | reviewer | claude-sonnet | Sonnet high | B1 | 2026-11-20T15:05-08:00 | done |
| impl-B2 | implementer | claude-sonnet | Sonnet high | B2 | 2026-11-20T15:30-08:00 | done |
| rev-B2-code | reviewer | claude-sonnet | Sonnet high | B2 | 2026-11-20T15:45-08:00 | done |
| rev-B2-text | reviewer | claude-sonnet | Sonnet high | B2 | 2026-11-20T15:45-08:00 | done |
| impl-B4 | implementer | claude-opus | Opus xhigh | B4b | 2026-11-20T19:55-08:00 | done |
| impl-B6 | implementer | claude-opus | Opus xhigh | B6 | 2026-11-20T16:05-08:00 | done |
| impl-B3 | implementer | claude-sonnet | Sonnet high | B3 | 2026-11-20T16:05-08:00 | done |
| rev-B3 | reviewer | claude-sonnet | Sonnet high | B3 | 2026-11-20T16:20-08:00 | done |
| rev-B4-decisions | reviewer | claude-sonnet | Sonnet high | B4 | 2026-11-20T16:45-08:00 | done |
| rev-B4-technical | reviewer | claude-sonnet | Sonnet high | B4 | 2026-11-20T16:45-08:00 | done |
| rev-B6-decisions | reviewer | claude-sonnet | Sonnet high | B6 | 2026-11-20T17:20-08:00 | done |
| rev-B6-technical | reviewer | claude-sonnet | Sonnet high | B6 | 2026-11-20T17:20-08:00 | done |
| rev-B2pin | reviewer | claude-sonnet | Sonnet high | B2 | 2026-11-20T17:25-08:00 | done |
| rev-B4-r2 | reviewer | claude-sonnet | Sonnet high | B4 | 2026-11-20T18:15-08:00 | done |
| rev-B6-r2 | reviewer | claude-sonnet | Sonnet high | B6 | 2026-11-20T18:15-08:00 | done |
| impl-N1 | implementer | claude-sonnet | Sonnet high | N1 | 2026-11-20T18:45-08:00 | done |
| rev-N1 | reviewer | claude-sonnet | Sonnet high | N1 | 2026-11-20T19:00-08:00 | done |
| rev-N1-r2 | reviewer | claude-sonnet | Sonnet high | N1 | 2026-11-20T19:25-08:00 | done |
| lead-C1 | lead | claude-opus | Opus xhigh | C1 | 2026-11-20T19:45-08:00 | done |
| rev-C1 | reviewer | claude-sonnet | Sonnet high | C1 | 2026-11-20T20:10-08:00 | done |
| rev-C1-r2 | reviewer | claude-sonnet | Sonnet high | C1 | 2026-11-20T20:40-08:00 | done |
| impl-S1 | implementer | claude-sonnet | Sonnet high | S1 | 2026-11-20T16:45-08:00 | running |
| impl-R3 | implementer | claude-sonnet | Sonnet xhigh | R3 | 2026-11-20T16:45-08:00 | done |
| impl-A3 | implementer | claude-opus | Opus xhigh | A3 | 2026-11-20T16:45-08:00 | done |
| impl-B5a | implementer | claude-opus | Opus xhigh | B5a | 2026-11-20T16:45-08:00 | done |
| impl-SC1 | implementer | claude-opus | Opus xhigh | SC1 | 2026-11-20T16:45-08:00 | done |
| rev-SC1 | reviewer | claude-sonnet | Sonnet high | SC1 | 2026-11-20T17:05-08:00 | done |
| rev-R3-code | reviewer | claude-sonnet | Sonnet high | R3 | 2026-11-20T17:30-08:00 | done |
| rev-R3-tests | reviewer | claude-sonnet | Sonnet high | R3 | 2026-11-20T17:30-08:00 | done |
| rev-B5a-spec | reviewer | claude-sonnet | Sonnet high | B5a | 2026-11-20T17:30-08:00 | done |
| rev-B5a-tools | reviewer | claude-sonnet | Sonnet high | B5a | 2026-11-20T17:30-08:00 | done |
| rev-B5a-r2 | reviewer | claude-sonnet | Sonnet high | B5a | 2026-11-20T17:50-08:00 | done |
| rev-R3-r2 | reviewer | claude-sonnet | Sonnet high | R3 | 2026-11-20T18:00-08:00 | done |
| impl-B5 | implementer | claude-opus | Opus xhigh | B5 | 2026-11-20T18:15-08:00 | done |
| rev-B5-spec | reviewer | claude-sonnet | Sonnet high | B5 | 2026-11-20T19:00-08:00 | done |
| rev-B5-tools | reviewer | claude-sonnet | Sonnet high | B5 | 2026-11-20T19:00-08:00 | done |
| adv-B5-layer | advisor | claude-opus | Opus xhigh | B5 | 2026-11-20T19:30-08:00 | done |
| rev-2285 | reviewer | claude-sonnet | Sonnet high | B5 | 2026-11-20T19:05-08:00 | done |
| rev-B5-r2 | reviewer | claude-sonnet | Sonnet high | B5 | 2026-11-20T19:40-08:00 | done |
| rev-B4b | reviewer | claude-sonnet | Sonnet high | B4b | 2026-11-20T20:20-08:00 | done |
| lead-indep | lead | claude-opus | Opus xhigh | - | 2026-11-20T20:35-08:00 | running |
| rev-2288 | reviewer | claude-sonnet | Sonnet high | - | 2026-11-20T21:10-08:00 | done |
| ad09993a | reviewer | claude-sonnet | sonnet | PR 2288 r2 | 19:21 | done |
| a8707231 | implementer | claude-opus | Opus xhigh | B7 | 2026-11-20T19:40-08:00 | running |
