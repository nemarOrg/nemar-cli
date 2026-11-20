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
| Last tick | 2026-11-20T13:15-08:00 |
| Next tick | 2026-11-20T13:45-08:00 |
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
| Agents today | 40 | 13 | daily | implementers, reviewers, advisors spawned; the plan approval covers this limit |
| Agents this wave | 15 | 0 | wave | items x (1 + review panel + 1 delta + fix rounds) + 1 advisor |
| Advisor consults | 3 | 0 | never | lead tier; frontier only when the owner or the plan says |

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
| A2 | [ADR supersedes parts of ADR 0128](cards/A2.md) | - | lead | - | claude-opus | review | O0 | 2269 |  | 2026-11-20T12:57-08:00 | 4h | r1 review (1 Sonnet, docs-only) on head 7f14f13d |
| A1 | [ADR adopts the RFC process](cards/A1.md) | - | worker | - | claude-sonnet | done | O0 | 2268 | r1 code+comments (1 Sonnet, docs <50 lines): 3 sugg, 2 fixed, 1 no change; fix diff verified by manager | 2026-11-20T12:57-08:00 | 4h | merged b20b9e93 (ADR 0130) |
| S1 | [Back-catalog scan and throughput](cards/S1.md) | - | worker | - | - | blocked | O0 | - |  | - | 1d | waits for the lead's EDF+D scan results (running in the lead session) |
| R1 | [nemarOrg/rfcs process and checks](cards/R1.md) | - | worker-hard | - | claude-sonnet | active | O0, O1 | rfcs#1 |  | 2026-11-20T12:57-08:00 | 2d | r1 fixes (5 important, 9 suggestions) + Q21, Q22; then r2 delta review |
| O1b | Owner applies the main ruleset requiring rfc-check | - | owner | - | - | blocked | R1 | - |  | - | - | owner step after R1 merges |
| R3 | [Weekly report shows the RFC clock](cards/R3.md) | - | worker | - | - | outline | R1 | - |  | - | 4h | lead completes at C1a (R1 merged) |
| B1 | [biosig-zarr initialized](cards/B1.md) | - | worker-hard | - | - | blocked | A2 | - |  | - | 1d | waits on A2 merged (Q8 answered) |
| B2 | [Spec text moves into biosig-zarr](cards/B2.md) | - | worker | - | - | blocked | B1 | - |  | - | 1d | waits on B1 merged (Q11 answered) |
| R2 | [docs page /policies/rfcs/](cards/R2.md) | - | worker | - | - | blocked | A1, R1 | - |  | - | 1d | waits on A1 and R1 merged (Q17 answered); owner merges |
| O4 | Owner releases 2.0.0 from B2's merge commit | - | owner | - | - | blocked | B2 | - |  | - | - | owner step after B2 merges; Q13, Q14 recorded only |
| B3 | [docs format page becomes a pointer](cards/B3.md) | - | worker | - | - | blocked | O4 | - |  | - | 4h | after O4; owner merges |
| B6 | [Version 3 text on draft/3.0.0](cards/B6.md) | - | lead | - | - | blocked | O4, A2 | - |  | - | 2d | after O4 and A2; PR stays open |
| O4b | Owner tags 3.0.0-draft.1 | - | owner | - | - | blocked | B6 | - |  | - | - | owner step after B6 passes its gate |
| B4 | [RFC-0001 text, draft PR](cards/B4.md) | - | lead | - | - | blocked | R1, B2, A2 | - |  | - | 2d | after R1, B2, A2; starts from drafts/0001; PR stays open |
| B5 | [Schemas and first vectors](cards/B5.md) | - | worker-hard | - | - | outline | B2 | - |  | - | 2d | lead completes at C1 when B2 merges (Q9, Q10 answered) |
| N1 | [RFC-0001 announcement drafts](cards/N1.md) | - | worker | - | - | blocked | B4 | - |  | - | 4h | waits on B4 and Q15 |
| O5 | Owner opens RFC-0001 | - | owner | - | - | blocked | B4, B6, O4b, O1b, S1, N1 | - |  | - | - | owner step after B4, B6, O4b, O1b, S1, N1 AND mail epic #2260 slice P1-P3 in production (owner decision 2026-11-20) |
| C3 | Checkpoint: RFC-0001 closed, decision draft, follow-through outline | - | lead | - | - | blocked | O5 | - |  | - | - | when RFC-0001's close instant passes |
| V2 | [RFC-0002 text, draft PR](cards/V2.md) | - | lead | - | - | outline | V1, O5 | - |  | - | 2d | lead completes at C2 (Q16) |
| O6 | Owner opens RFC-0002 after RFC-0001 closes | - | owner | - | - | blocked | V2, C3 | - |  | - | - | one RFC open at a time |
| C4 | Checkpoint: RFC-0002 closed, decision draft, process ADR review | - | lead | - | - | blocked | O6 | - |  | - | - | when RFC-0002's close instant passes |

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
| Q15 | N1 | When RFC-0001 opens, send short notes to: the OME-Zarr RFC-9 authors and the Zarr community, the hdmf-zarr and NWB maintainers, the cited BIDS threads and BEP047, and MNE-Python issue 13429? | All of them (Recommended) / Only Zarr and NWB / None | none | 2027-01-04T17:00 | open |  |
| Q16 | V2 | For RFC-0002, what does first party mean? | The dataset's source: authors for nm, upstream for on; NEMAR and community are separate origins (Recommended) / NEMAR is the first party | none | 2027-01-15T17:00 | open |  |
| Q17 | R2 | Does the /policies/rfcs/ page need UC San Diego counsel review before publication? | No, it is a process page (Recommended) / Yes, publish as a draft for counsel | none | 2026-11-27T17:00 | closed | No counsel review; it is a process page (owner, 2026-11-20T11:49-08:00) |
| Q18 | O5 | Link to the BEP047 discussion of EDF's irregular and sparse sampling limit? Not found in PR 2231 or issue 2568. | Supply the link / Cite BIDS issues 1796, 2313, 2463 instead (Recommended) | none | 2026-12-08T17:00 | closed | BEP 045 peripheral physiology (bids-specification#2267, bep_045 page), not BEP047 (owner, 2026-11-20T12:18-08:00) |
| Q19 | B4 | Slots: raise claude-opus Max from 1 to 2 (B4, B6 and A2 are lead cards, and checkpoints and advisor consults need the lead too) and add the reviewer tier to claude-sonnet's tiers? | Both (Recommended) / Opus Max 2 only / Neither | none | 2026-11-24T17:00 | closed | Opus Max 4 (owner, 2026-11-20); reviewer tier added to claude-sonnet per the owner's standing rule that PR review agents use Sonnet (owner, 2026-11-20T11:35-08:00) |
| Q20 | - | ADR 0129 is on dev but not feature/rfc-program (48 behind, merges clean), so the gapless ADR index test fails for A1 (0130) and A2 (0131). How to resolve? | Lead merges origin/dev into feature/rfc-program (Recommended) / Add 129 to TOLERATED_GAPS in the A1 PR, removed when dev merges in / Other | none | 2026-11-21T17:00 | closed | Lead merges origin/dev into feature/rfc-program (owner, 2026-11-20T13:10-08:00) (owner, 2026-11-20T12:54-08:00) |
| Q21 | - | Which support address do RFC comments without a GitHub account go to (PROCESS.md, A1, R2)? No support@ found in nemar-cli; info@nemar.org exists. | support@nemar.org (Recommended) / info@nemar.org / Other | none | 2026-11-21T17:00 | closed | Keep the Announcement category; comments go under the RFC Discussion; email fallback support@nemar.org, posted with consent (owner, 2026-11-20T14:05-08:00) |
| Q22 | - | Should ops/ruleset-main.json (rfcs main, requires rfc-check) list a bypass actor so a broken main can be fixed without editing the ruleset? | Repository admins may bypass via pull request only (Recommended) / No bypass / Org admins always | none | 2026-11-21T17:00 | closed | Repository admins may bypass via pull request only (owner, 2026-11-20T14:00-08:00) |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
| impl-V1 | implementer | claude-sonnet | Sonnet | V1 | 2026-11-20T13:10-08:00 | done |
| impl-A2 | implementer | claude-opus | Opus xhigh | A2 | 2026-11-20T12:57-08:00 | done |
| impl-A1 | implementer | claude-sonnet | Sonnet high | A1 | 2026-11-20T12:57-08:00 | done |
| impl-R1 | implementer | claude-sonnet | Sonnet xhigh | R1 | 2026-11-20T12:57-08:00 | running |
| rev-V1-code | reviewer | claude-sonnet | Sonnet high | V1 | 2026-11-20T13:00-08:00 | done |
| rev-V1-tests | reviewer | claude-sonnet | Sonnet high | V1 | 2026-11-20T13:00-08:00 | done |
| lead-devmerge | lead | claude-opus | Opus xhigh | - | 2026-11-20T13:10-08:00 | done |
| rev-V1-delta | reviewer | claude-sonnet | Sonnet high | V1 | 2026-11-20T13:18-08:00 | done |
| rev-A1 | reviewer | claude-sonnet | Sonnet high | A1 | 2026-11-20T13:30-08:00 | done |
| rev-R1-code | reviewer | claude-sonnet | Sonnet high | R1 | 2026-11-20T13:45-08:00 | done |
| rev-R1-tests | reviewer | claude-sonnet | Sonnet high | R1 | 2026-11-20T13:45-08:00 | done |
| rev-A2 | reviewer | claude-sonnet | Sonnet high | A2 | 2026-11-20T14:08-08:00 | running |
