# Risks

| Risk | Observation | Read by | If bad | Decides |
| --- | --- | --- | --- | --- |
| R1: Pure-TS HDF5 cannot parse the queue's real SNIRF writers | A3 against two writers; after release, the count of `partial` SNIRF files in the re-screen | A3 merge; O2 | List the unsupported construct, and add it as a follow-up card. Unread files stay `partial`, never clean. | lead |
| R2: Readers raise many false review findings and the queue does not shrink | The re-screen's "needs review" count by kind | O2 + 1 day | Lead diagnosis card on the top kind | lead, owner |
| R3: Images and documents stay the dominant blocker | A7 report | A7 merge | The owner picks a policy (Q-A8) | owner |
| R4: Automatic denial denies a legitimate dataset | C1 calibration: zero false automatic denials on the labeled sample | C1 | No production enablement | owner |
| R5: Registries rate-limit the license fetches for 350 datasets | B1 live test; the first review batch | C1 | Cache per DOI, and pace the requests | lead |
| R6: Release 1 is delayed behind the pending admin-tree release | Owner release calendar | CP2 | Release when it is free | owner |
| R7: A screen change breaks stored v1 reports in production | A1 v1 parse tests; a staging read of stored reports after the epic reaches `dev` | CP2 | Block the release | lead |
