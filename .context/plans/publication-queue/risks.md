# Risks

| Risk | Observation | Read by | If bad | Decides |
| --- | --- | --- | --- | --- |
| R1: Pure-TS HDF5 cannot parse the queue's real SNIRF writers | A3 against two writers; after release, the count of `partial` SNIRF files in the re-screen | A3 merge; O2 | List the unsupported construct, and add it as a follow-up card. Unread files stay `partial`, never clean. | lead |
| R2: Readers raise many false review findings and the queue does not shrink | The re-screen's "needs review" count by kind | O2 + 1 day | Lead diagnosis card on the top kind | lead, owner |
| R3: Images and documents stay the dominant blocker | D2 report | D2 merge | The owner picks acknowledgment groups (CP-D1) | owner |
| R4: Automatic denial denies a legitimate dataset | C1 calibration: zero false automatic denials on the labeled sample | C1 | No production enablement | owner |
| R5: Registries rate-limit the license fetches for 350 datasets | D1 live test; the first review batch | C1 | Cache per DOI, and pace the requests | lead |
| R6: Release E is delayed behind the pending admin-tree release | Owner release calendar | CP-E2 | Release when it is free | owner |
| R7: A screen change breaks stored v1 reports in production | A1 v1 parse tests; a staging read of stored reports after the epic reaches `dev` | CP-E2 | Block the release | lead |
| R8: The Worker refuses v2 reports during the deploy window | Screens stored as `unreported` after Release E | Release E + 1 hour | Re-screen them with D4 | lead |
| R9: Automatic-deny mail from the dev Worker reaches real addresses | Code path review in B5; the dev allowlist test | B5 merge | Block the merge | lead |
| R10: Model cost of reviewing 363 or more requests twice (Haiku, plus Sonnet on fails) | Per-review cost in the D0 shadow batch | D0 | Owner sets a per-day review cap | owner |
| R11: New readers raise findings across about 900 published datasets in the ADR 0088 weekly re-screen | The first weekly report after Release E | Release E + 7 days | Lead diagnosis card per top kind | lead |
| R12: Mass denial of one depositor (our group's batch) | Shadow would-deny count in C1 | C1 | The owner decides a per-depositor daily cap | owner |
| R13: Approval throughput: each approval runs the orchestrator, mints a DOI (EZID) and writes to GitHub | Time per approval in the D0 batch | D0 | Pace the approvals; the owner decides batch sizes | owner |
| R14: SNIRF reads time out on large files (37 of 296 files hit the 180 s time limit from a home connection) | Count of `partial`/`time` SNIRF files in the first production re-screen | Release E + 1 day | Raise the time cap or the fetch concurrency; the files stay partial, never clean | lead |
