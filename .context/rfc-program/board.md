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
| Manager id | - |
| State | paused |
| Cadence | 30m with workers running, 60m waiting on people |
| Last tick | - |
| Next tick | - |
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
| claude-sonnet | Claude | worker, worker-hard | 3 | gui, browser | graphical user interface (GUI) or computer use only with the owner's announced consent |
| claude-opus | Claude | lead | 1 | gui, browser | |
| codex | Codex | worker, worker-hard, lead | 0 | | owner opens this slot; never computer use or visible runs |

## Budget

| Item | Limit | Used | Resets | Notes |
|---|---|---|---|---|
| Agents today | 40 | 0 | daily | implementers, reviewers, advisors spawned; the plan approval covers this limit |
| Agents this wave | 15 | 0 | wave | items x (1 + review panel + 1 delta + fix rounds) + 1 advisor |
| Advisor consults | 3 | 0 | never | lead tier; frontier only when the owner or the plan says |

## Waves

| Wave | Goal | Agents | State | Exit gate |
|---|---|---|---|---|

## Steps

| ID | Title | Wave | Tier | Needs | Slot | State | Depends | PR | Started | Timebox | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|
| V1 | [Measure what RFC-0002 needs](cards/V1.md) | - | worker | - | - | active | - | - | 2026-11-20T11:12-08:00 | 4h | dispatch now |
| O1 | Owner creates nemarOrg/rfcs, Discussions, RFCs category | - | owner | - | - | owner | - | - | - | 1d | owner runs plan.md section 5, O1 |
| O2 | Owner creates nemarOrg/biosig-zarr, comments on biosigio#179 | - | owner | - | - | owner | - | - | - | 1d | owner runs plan.md section 5, O2 |
| A1 | [ADR adopts the RFC process](cards/A1.md) | - | worker | - | - | blocked | - | - | - | 4h | waits on Q1 to Q7 |
| R1 | [nemarOrg/rfcs process and checks](cards/R1.md) | - | worker-hard | - | - | blocked | O1 | - | - | 2d | waits on O1 and Q1 to Q7 |
| O1b | Owner applies the main ruleset requiring rfc-check | - | owner | - | - | blocked | R1 | - | - | 1d | owner step after R1 merges |
| B1 | [biosig-zarr initialized](cards/B1.md) | - | worker-hard | - | - | blocked | O2 | - | - | 1d | waits on O2 and Q8 |
| B2 | [Spec text moves into biosig-zarr](cards/B2.md) | - | worker | - | - | blocked | B1 | - | - | 1d | waits on B1 and Q11 |
| R2 | [docs page /policies/rfcs/](cards/R2.md) | - | worker | - | - | blocked | A1, R1 | - | - | 1d | waits on A1, R1 and Q17; owner merges |
| O4 | Owner tags 2.0.0 | - | owner | - | - | blocked | B2 | - | - | 1d | owner step after B2 merges |
| B3 | [docs renders spec from pinned tag](cards/B3.md) | - | worker-hard | - | - | blocked | O4 | - | - | 1d | waits on O4 and Q12; owner merges |
| B4 | [RFC-0001 text, draft PR](cards/B4.md) | - | lead | - | - | todo | R1, B2 | - | - | 2d | after R1 and B2 merge; PR stays open |
| B5 | [Schemas and first vectors](cards/B5.md) | - | worker-hard | - | - | outline | B2 | - | - | 2d | lead completes at C1 (Q9, Q10) |
| R3 | [Weekly report shows the RFC clock](cards/R3.md) | - | worker | - | - | outline | R1 | - | - | 4h | lead completes or drops at C1 (Q7) |
| O5 | Owner opens RFC-0001 | - | owner | - | - | blocked | B4, O1b | - | - | 1d | owner step; waits on Q15, Q18 |
| V2 | [RFC-0002 text, draft PR](cards/V2.md) | - | lead | - | - | outline | V1, O5 | - | - | 2d | lead completes at C2 (Q16) |
| O6 | Owner opens RFC-0002 | - | owner | - | - | blocked | V2 | - | - | 1d | owner step after V2 |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|
| Q1 | A1 | What does final comment mean? | Inside the window, shepherd summary and proposed disposition at least 7 days before close, required to accept (Recommended) / A separate period after the window | none | 2026-11-24T17:00 | answered | Inside the window, shepherd summary and proposed disposition at least 7 days before close, required to accept (owner, 2026-11-20T10:09-08:00) |
| Q2 | A1 | Who decides an RFC? | Owner for org RFCs, answering each objection in writing; dataset RFCs NEMAR with the dataset owner's recorded position and consent for author-owned content (Recommended) / Owner alone for all | none | 2026-11-24T17:00 | answered | Owner for org RFCs, answering each objection in writing; dataset RFCs NEMAR with the dataset owner's recorded position and consent for author-owned content (owner, 2026-11-20T10:09-08:00) |
| Q3 | A1 | Who may open an RFC? | Anyone proposes; a NEMAR owner or admin opens it as shepherd (Recommended) / Only NEMAR proposes and opens | none | 2026-11-24T17:00 | answered | Anyone proposes; a NEMAR owner or admin opens it as shepherd (owner, 2026-11-20T10:09-08:00) |
| Q4 | A1 | Which RFC outcomes get an ADR? | Accepted, and a rejection that closes off a reasonable path; the ADR names the RFC (Recommended) / Every outcome | none | 2026-11-24T17:00 | answered | Accepted, and a rejection that closes off a reasonable path; the ADR names the RFC (owner, 2026-11-20T10:09-08:00) |
| Q5 | A1 | Accept comments from people without a GitHub account? | Yes, via the support address, posted with consent (Recommended) / No, GitHub only | none | 2026-11-24T17:00 | answered | Yes, via the support address, posted with consent (owner, 2026-11-20T10:09-08:00) |
| Q6 | R1 | Licenses for nemarOrg/rfcs? | MIT for tooling, CC BY 4.0 for text (Recommended) / MIT for tooling, W3C for text to match biosig-zarr | none | 2026-11-24T17:00 | answered | MIT for tooling, CC BY 4.0 for text (owner, 2026-11-20T10:09-08:00) |
| Q7 | R1 | Where does the RFC clock run? | Scheduled Action in nemarOrg/rfcs plus a weekly report line (R3) (Recommended) / Action only / Worker production cron in nemar-cli | none | 2026-11-24T17:00 | answered | Scheduled Action in nemarOrg/rfcs plus a weekly report line (R3) (owner, 2026-11-20T10:09-08:00) |
| Q8 | B1 | Contribution terms for biosig-zarr? | Developer Certificate of Origin sign-off, inbound equals outbound (Recommended) / A contributor license agreement / None stated | none | 2026-11-25T17:00 | open |  |
| Q9 | B5 | Canonical home of conformance vectors? | nemarOrg/biosig-zarr, nemar-cli vendors by digest, amending proposed ADR 0124 (Recommended) / nemar-cli, biosig-zarr vendors | none | 2026-12-01T17:00 | open |  |
| Q10 | O5 | May RFC-0001 open with no implementation? | Open with text plus schemas and a few real vectors, no packer (Recommended) / Wait for a prototype packer and vectors / Open with text only | none | 2026-12-01T17:00 | open |  |
| Q11 | B2 | Mint the Zarr convention uuid now, so the #2217 rename migration writes it once? | Mint now (Recommended) / Later, accept a second pass | none | 2026-11-25T17:00 | open |  |
| Q12 | B3 | Docs mechanics for the spec page? | Build-time fetch of the pinned tag with digest check and a per-page W3C license notice (Recommended) / Hand-kept copy with the notice | none | 2026-12-01T17:00 | open |  |
| Q13 | O4 | Register w3id.org/biosig-zarr as the permanent identifier (a PR to an outside registry, by the owner)? | Yes, pointing at docs.nemar.org for now (Recommended) / Another scheme / Not now | none | 2026-12-15T17:00 | open |  |
| Q14 | O4 | Do biosig-zarr spec releases get a DOI? | Yes, through NEMAR's EZID shoulder, from the first beta tag (Recommended) / Not until 1.0 / Never | none | 2027-01-04T17:00 | open |  |
| Q15 | O5 | Notify the OME-Zarr RFC-9 authors and the Zarr community when RFC-0001 opens? | Yes, a short note linking the thread (Recommended) / No | none | 2027-01-04T17:00 | open |  |
| Q16 | V2 | For RFC-0002, what does first party mean? | The dataset's source: authors for nm, upstream for on; NEMAR and community are separate origins (Recommended) / NEMAR is the first party | none | 2027-01-15T17:00 | open |  |
| Q17 | R2 | Does the /policies/rfcs/ page need UC San Diego counsel review before publication? | No, it is a process page (Recommended) / Yes, publish as a draft for counsel | none | 2026-11-27T17:00 | open |  |
| Q18 | B4 | Link to the BEP047 discussion of EDF's irregular and sparse sampling limit? Not found in PR 2231 or issue 2568. | Supply the link / Cite BIDS issues 1796, 2313, 2463 instead (Recommended) | none | 2026-12-08T17:00 | open |  |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
