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
| 2026-11-20T11:24-08:00 | Plan approved (owner: 'plan is good, move forward', 2026-11-20); lead pushes feature/rfc-program | owner |  |
| 2026-11-20T11:35-08:00 | #2217: no in-place patch; the biosig-zarr tag rename lands with the version 3 writer via re-conversion; A2's ADR records it (owner confirmed, comment posted 2026-11-20) | owner |  |
| 2026-11-20T12:18-08:00 | New repo nemarOrg/nemar-doi: the registry of every NEMAR DOI with a page at doi.nemar.org; it delegates the nm and on dataset DOIs to nemar-cli, which keeps its own registry; a Fable planner designs and initializes it (separate track, not an RFC program step) | owner |  |
| 2026-11-20T12:18-08:00 | RFC-0002 scope: all nm datasets | owner |  |
| 2026-11-20T12:18-08:00 | Open RFC-0001 as soon as possible: prioritize the B and R chains | owner |  |
| 2026-11-20T12:18-08:00 | Rationale for the 21-day window: AI-assisted review by knowledgeable people is welcome, so RFCs are fast-paced; stated in the rfcs process doc, the A1 ADR and the docs page | owner |  |
| 2026-11-20T12:27-08:00 | Opening an RFC sends a community email to NEMAR account holders (rfcs category, unsubscribe footer); the owner also posts on LinkedIn and the BIDS Google group; N1 drafts all three | owner |  |
| 2026-11-20T12:27-08:00 | New nemar-cli feature (separate epic): mail categories news, rfcs, maintenance, recalls; recalls are mandatory and cannot be unsubscribed; one-click unsubscribe web page plus a section under the website's user settings page | owner |  |
| 2026-11-20T12:49-08:00 | Q8 (B1): Developer Certificate of Origin sign-off, inbound equals outbound | owner |  |
| 2026-11-20T12:49-08:00 | Q9 (B5): conformance test files live in nemarOrg/biosig-zarr; nemar-cli vendors them by digest | owner |  |
| 2026-11-20T12:49-08:00 | Q10 (O5): RFC-0001 opens with text plus schemas and a few real vectors, no packer | owner |  |
| 2026-11-20T12:49-08:00 | Q11 (B2): mint the Zarr convention uuid now, recorded in a biosig-zarr ADR | owner |  |
| 2026-11-20T12:49-08:00 | Q13 (O4): register w3id.org/biosig-zarr now, pointing at nemarOrg/biosig-zarr (perma-id/w3id.org#7250) | owner |  |
| 2026-11-20T12:49-08:00 | Q14 (O4): spec releases get a NEMAR DOI (e.g. nemar.biosig-zarr.v3) through nemar-doi; nemar-process gets nemar.process.vN | owner |  |
| 2026-11-20T12:49-08:00 | Q17 (R2): no counsel review for /policies/rfcs/; it is a process page | owner |  |
| 2026-11-20T12:49-08:00 | Q18 (O5): cite BEP 045 peripheral physiology (bids-specification#2267, bep_045 page), not BEP047 | owner |  |
| 2026-11-20T12:49-08:00 | Q19: claude-opus Max 4; reviewer tier on claude-sonnet (owner applied both to Slots) | owner |  |
| 2026-11-20T12:54-08:00 | Q20: the lead merges origin/dev into feature/rfc-program (merge, no rebase) so ADR 0129 is in the base; A1 keeps 0130, A2 0131 | owner |  |
| 2026-11-20T12:56-08:00 | Mail epic #2260: its minimum slice (P1-P3 plus privacy-policy text) ships to production before RFC-0001 opens; O5 waits on it, and the RFC-0001 email goes out in the rfcs category | owner |  |
| 2026-11-20T13:12-08:00 | Q22: rfcs main ruleset lists repository admins as bypass actors, pull request only | owner |  |
| 2026-11-20T13:15-08:00 | Q21: RFCs category stays Announcement format; people comment under the RFC Discussion; email fallback is support@nemar.org, posted with consent | owner |  |
| 2026-11-20T13:29-08:00 | O1b: the owner asked the manager to apply the rfcs main ruleset itself (overrides the runbook's never-change-a-setting rule for this one act) | owner |  |
| 2026-11-20T13:30-08:00 | P1: the runbook's never-change-a-setting rule is wrong; the manager may apply settings that a merged, reviewed file specifies (e.g. ops/ruleset-main.json) without asking each time; the lead rewrites runbook.md in its session | owner |  |

## Log

| Time | Event |
|---|---|
| 2026-11-20T11:12-08:00 | O1 repo and O2 done by lead on owner's instruction; V1 dispatched; C0 reviews running |
| 2026-11-20T11:27-08:00 | E0: epic #2239; V1 2240, A2 2241, A1 2242, S1 2243, R1 2244, R3 2245, B1 2246, B2 2247, R2 2248, B3 2249, B6 2250, B4 2251, B5 2252, N1 2253, V2 2254; V1 PR 2238 |
| 2026-11-20T12:20-08:00 | Q13 acted on: w3id.org/biosig-zarr registration PR perma-id/w3id.org#7250 (302 to nemarOrg/biosig-zarr), awaiting w3id maintainers |
| 2026-11-20T12:51-08:00 | Session start reconcile: V1 PR 2238 head c8df3be2 fails acceptance (Command: 4, Raw output: 0); prior worker not live; redispatched with send-back; six-script deviation accepted |
| 2026-11-20T12:51-08:00 | Owner answers Q8 Q9 Q10 Q11 Q13 Q14 Q17 Q18 Q19 recorded and closed; B1 B2 R2 O5 B5 Next updated |
| 2026-11-20T12:51-08:00 | Dispatched A2 (claude-opus), A1 and R1 (claude-sonnet); Agents today 4/40 |
| 2026-11-20T12:52-08:00 | V1 r1 fix head 9d82cef1 verified: Command 7, Raw output 28, no empty files, scope clean; review panel dispatched |
| 2026-11-20T12:53-08:00 | A1 stop: index test fails on gap 0129 (verified: 0129 on origin/dev only, epic 48 behind dev, merge clean); Q20 asked; A2 told to take 0131 and stop before push on same failure |
| 2026-11-20T12:54-08:00 | A2 stop: same gap (0129, 0130); local 9ada28f0 ADR 0131; README 0128-line note deviation accepted (follows 0080/0107 convention); its refused test edit not retried |
| 2026-11-20T12:54-08:00 | V1 r1 review in: code lens clean of critical/important, 6 suggestions; tests lens 4 important, 2 suggestions; all accepted, sent back |
| 2026-11-20T12:55-08:00 | Dispatched lead-devmerge (Opus) for Q20 and impl-V1 round 2 (9 items); Agents today 8/40 |
| 2026-11-20T12:59-08:00 | V1 r2 fix head 0f08eb74 verified (Command 35, Raw output 64, no empty, scope clean); new script merge-message-pr-check.ts reproduces q4d byte-identical per worker; delta review dispatched |
| 2026-11-20T13:00-08:00 | V1 merged: PR 2238 squash 2d98bd9b into feature/rfc-program (gate: review converged r2 clean, no CI checks on [skip ci] head, mergeable clean) |
| 2026-11-20T13:01-08:00 | lead-devmerge: merge da3d5838 passed gates but push hit SSL timeout; remote moved to 2d98bd9b; resumed once to redo on current tip. Leftover worktree rfc-devmerge + branch rfc-devmerge-tmp: removal blocked by guard hook, left for owner |
| 2026-11-20T13:03-08:00 | Q20 done: dev merged into feature/rfc-program, 068c1306 (gates green, ADR index 10 pass); leftover worktrees rfc-devmerge, rfc-devmerge2 and branches rfc-devmerge-tmp, rfc-devmerge2-tmp for owner to delete (guard blocks removal); impl-A1 resumed |
| 2026-11-20T13:04-08:00 | A1 PR 2268 head 1acee978 verified: scope 2 files, ADR index 10 pass, nemarOrg/rfcs x4; review dispatched |
| 2026-11-20T13:05-08:00 | A1 r1 review: clean of critical/important; sugg 1 no_change_needed (follows index convention), 2 and 3 sent back as trivial wording fixes |
| 2026-11-20T13:06-08:00 | A1 merged: PR 2268 squash b20b9e93; A2 resumed to merge base and open PR |
| 2026-11-20T13:06-08:00 | R1 rfcs#1 head 9fc912c9 verified: scope ok (+.gitignore, accepted), lint/typecheck/119 tests green, check.ts ok and exits 1 on --root window-22 fixture, rfc-check CI pass. Deviations 1-8 accepted pending review; lead questions (support address, ruleset bypass) to owner |
| 2026-11-20T13:12-08:00 | Q21 answer redirects: owner wants comments under the Discussion and the RFCs category type changed; clarification asked (category format is an owner setting; Q5 support-address path) |
| 2026-11-20T13:15-08:00 | A2 PR 2269 head 7f14f13d verified (3 files, 0128 +1 line, index 10 pass); review dispatched |
| 2026-11-20T13:15-08:00 | R1 r1 review: code lens 5 important, 7 sugg; tests lens 0 crit/imp (32/32 mutations caught), 2 sugg; all sent back with Q21, Q22; clock lag stated in text, cron unchanged per card |
| 2026-11-20T13:16-08:00 | A2 r1 review: clean of critical/important; 2 suggestions sent back to impl-A2 |
| 2026-11-20T13:18-08:00 | A2 merged: PR 2269 squash 0184cb051d77587144f501a327b3928c9da97033 (ADR 0131); B1 unblocked to todo |
| 2026-11-20T13:18-08:00 | Dispatched B1 (claude-sonnet) with Q8, Q9, Q11, Q13, Q14 and tag decisions; Agents today 13/40 |
| 2026-11-20T13:20-08:00 | R1 r1 fixes head a108a99d verified: lint/typecheck/140 tests green, check ok, fixture exit 1, rfc-check CI pass, scope ok; r2 delta review dispatched |
| 2026-11-20T13:21-08:00 | R1 merged: rfcs#1 squash c3a3ccc6 (r2 clean; 2 cosmetic suggestions rejected: table alignment does not affect rendering, inline UTC definition satisfies define-once rule) |
| 2026-11-20T13:21-08:00 | C1a due: owner and lead notified; R3 waits on the lead's card. O1b set owner and asked. R2 dispatched; Agents today 15/40 |
| 2026-11-20T13:29-08:00 | O1b done by manager on owner instruction: ruleset 27763743 active; verified via gh api rulesets |
| 2026-11-20T13:29-08:00 | proposal P1 opened: Owner says a rule is wrong and should be updated clearly; the lead rewrites it in runbook.md (manager cannot edit the runbook) |
| 2026-11-20T13:29-08:00 | R2 docs#127 CI 'test' job fails in ~3s with no failed step; main fails the same way since 2026-11-18 (not the diff); rerun once |
| 2026-11-20T13:30-08:00 | R2 docs#127 head 0d845020 verified (3 files, build ok per worker); deviations accepted: ADR spelled out (docs policy-hygiene), privacy/security routes sentence from ADR 0130 |
| 2026-11-20T13:30-08:00 | B1 biosig-zarr#1 head d75eda45 verified: scope ok (+.gitignore), text.yml links/lint/spelling green; deviations accepted (W3C 2023 text per card's 'current'); lead questions: JSON-only lint path filter (defer to C1/B5), LICENSE relicense sentence |
