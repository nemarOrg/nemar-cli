# Portable compute

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
| Plan | .context/plans/portable-compute/plan.md |
| Repo | nemarOrg/nemar-cli |
| Integration branch | feature/portable-compute-epic |
| Manager id | mba-claude-sonnet |
| State | running |
| Cadence | 30m with workers running, 60m waiting on people |
| Last tick | 2026-11-16T14:06-05:00 |
| Next tick | 2026-11-16T14:36-05:00 |
| Stop when | every step done, or all remaining work waits on the owner |
| Created | 2026-11-13T12:11-08:00 |

## Parity

| Tier | Claude | Codex | Copilot | Notes |
|---|---|---|---|---|
| worker | Sonnet high | gpt-6-luna max | balanced coding model | routine cards from a detailed plan |
| worker-hard | Sonnet xhigh | gpt-6.1-terra xhigh | balanced reasoning model | protocol, concurrency, security, contract work |
| lead | Opus xhigh | gpt-6.1-sol xhigh | strong reasoning model | default for planning, design, first-level advice |
| frontier | Fable | gpt-6-astra xhigh | strongest model | only when the owner asks, for long-horizon planning, or a frontier trigger the plan lists |
| reviewer | Sonnet high | gpt-6-luna max | balanced coding model | a different model family from the implementer when possible |

## Slots

| Slot | Platform | Tiers | Max | Can | Notes |
|---|---|---|---|---|---|
| claude-sonnet | Claude | worker, worker-hard | 6 | network | implementers and reviewers |
| claude-opus | Claude | lead | 2 | network | Opus reviews and advice; Max raised 1 to 2 by the owner on 2026-11-14 until the freeze |
| claude-review | Claude | reviewer | 4 | network | PR reviews and delta reviews; exclusive of the four implementer slots (owner, 2026-11-13) |
| operator | Claude | worker | 1 | network, ssh:ws-a, ssh:ws-b | the only slot that may reach a workstation, from a card |
| codex | Codex | worker, worker-hard, lead | 0 | | owner opens this slot |

## Budget

| Item | Limit | Used | Resets | Notes |
|---|---|---|---|---|
| Agents today | 150 | 0 | daily | owner raised to 150 on 2026-11-14 (was 100, raised from 60 at plan approval) |
| Advisor consults | 16 | 13 | never | one is reserved for the frontier consult at CP-F |

## Waves

| Wave | Goal | Agents | State | Exit gate |
|---|---|---|---|---|

## Steps

| ID | Title | Wave | Tier | Needs | Slot | State | Depends | PR | Started | Timebox | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|
| DM-04 | [DM-04 contract](cards/DM-04.md) |  | worker-hard |  | claude-sonnet | done |  | 2146 | 2026-11-13T12:20-08:00 |  |  |
| DM-09 | [DM-09 launcher environment](cards/DM-09.md) |  | worker-hard |  | claude-sonnet | done |  | 20 | 2026-11-13T12:20-08:00 |  | fix round verified (head fa45949, e2e 4 pass, zip digest ok); merge when CI on this head is green |
| DM-12 | [DM-12 eegprep-lean recording](cards/DM-12.md) |  | worker | network | claude-review | done |  | 616 | 2026-11-13T12:20-08:00 |  | PR 616 head 0bc892e0 reviewed twice, delta clean; merge is the owner's; DM-13 pins the head commit until then |
| DM-01 | [DM-01 probe](cards/DM-01.md) |  | worker | ssh:ws-a,ssh:ws-b | operator | done |  | 2147 | 2026-11-13T12:20-08:00 |  | CI pending, then merge |
| DM-02 | [DM-02 dataset](cards/DM-02.md) |  | worker | network | claude-sonnet | done |  |  | 2026-11-13T13:50-08:00 |  | dataset nm000274 chosen by the owner |
| DM-03 | [DM-03 ADRs](cards/DM-03.md) |  | worker-hard |  | claude-review | done |  | 2148 | 2026-11-13T13:10-08:00 |  |  |
| DM-05 | [DM-05 registry](cards/DM-05.md) |  | worker-hard |  | claude-sonnet | done | DM-04 | 2149 | 2026-11-13T13:12-08:00 |  |  |
| DM-11 | [DM-11 runner build](cards/DM-11.md) |  | worker-hard |  | claude-sonnet | done | DM-04,DM-09 | 23 | 2026-11-13T13:35-08:00 |  | final round running after PR 21 merged |
| DM-13 | [DM-13 recipe](cards/DM-13.md) |  | worker-hard | network | claude-sonnet | done | DM-12 | 22 | 2026-11-13T13:20-08:00 |  | fix round queued: waits for a free implementer slot |
| DM-06 | [DM-06 runner jobs](cards/DM-06.md) |  | worker-hard |  | claude-sonnet | done | DM-05 | 2152 | 2026-11-13T13:48-08:00 |  |  |
| DM-08 | [DM-08 local stack](cards/DM-08.md) |  | worker-hard |  | claude-sonnet | done | DM-05 | 2151 | 2026-11-13T13:48-08:00 |  |  |
| DM-10 | [DM-10 Docker backend](cards/DM-10.md) |  | worker-hard |  | claude-sonnet | done | DM-09,DM-01 | 21 | 2026-11-13T13:35-08:00 |  | CORRECTION: the merge did not happen (PR 21 is CONFLICTING against runner-epic after DM-13); conflict resolution by its implementer |
| DM-14 | [DM-14 image](cards/DM-14.md) |  | worker | ssh:ws-a,ssh:ws-b,network | operator | done | DM-13,DM-01 |  | 2026-11-13T23:47-08:00 |  | G4 met on workstation B: image pulled by digest sha256:33922cad (equals the recorded digest), smoke test with limits passed, nemar-recipe version assertion ok; Docker path, no SIF |
| DM-19 | [DM-19 F2 assets](cards/DM-19.md) |  | worker | ssh:ws-a,ssh:ws-b,network | operator | done | DM-14,DM-02,DM-12 |  | 2026-11-13T23:52-08:00 |  | F2 assets recorded: manual run on B (4 of 4 stores, 14 s), 5 records validate, reader in mne matches the index, G2 tests and runner and launcher tests recorded; labels in the evidence README |
| DM-07 | [DM-07 runner queue](cards/DM-07.md) |  | worker-hard |  | claude-sonnet | done | DM-06 | 2154 | 2026-11-13T16:20-08:00 |  |  |
| DM-16 | [DM-16 demo brief](cards/DM-16.md) |  | worker |  | claude-sonnet | done | DM-19 | nemar-cli#2159 | 2026-11-14T00:06-08:00 |  | final: brief merged into the epic as 02113b16 (138 lines); no further round |
| DM-17 | [DM-17 stack runner flow](cards/DM-17.md) |  | worker-hard |  | claude-sonnet | done | DM-07,DM-08,DM-06b | 2156 | 2026-11-13T18:30-08:00 |  |  |
| DM-18 | [DM-18 runner in CI](cards/DM-18.md) |  | worker-hard |  | claude-sonnet | done | DM-11,DM-17,DM-06b,DM-10 |  | 2026-11-13T19:00-08:00 |  |  |
| DM-15 | [DM-15 recorded run F1](cards/DM-15.md) |  | worker | ssh:ws-a,ssh:ws-b,network | operator | done | DM-01,DM-02,DM-06b,DM-14,DM-17,DM-18,DM-10 |  | 2026-11-14T00:06-08:00 |  | F1 passed 2026-11-14 00:09: G5 to G8 pass; stack, tunnel and runner registration left running, so the presenter's laptop must stay on until Sunday |
| S1 | [S1 fixture eligible outside production](cards/S1.md) |  | worker-hard |  | claude-sonnet | done | DM-07 | nemar-cli#2164 | 2026-11-14T07:38-08:00 | 4h | merged into the epic (squash 25f3dab9) after Opus review (no Critical or Important) and a test-only fix round; checks green on 39f28c2c |
| S2 | [S2 nemar-cli epic: green PR into dev](cards/S2.md) |  | worker-hard | network | claude-sonnet | done | S1,C2W | nemar-cli#2167 | 2026-11-14T08:52-08:00 | 4h | epic merged into dev with a merge commit (26d1d0e9) on the owner's go-ahead; green run on c31b369a; dev deploy (Auto Bump Dev 43636195770) in progress: rerun failed jobs once if the flaky gate recurs (issue 2174) |
| S3a | [S3a what the compute switches open (input to Q6)](cards/S3a.md) |  | lead |  | claude-opus | done |  | nemar-cli#2165 | 2026-11-14T07:38-08:00 | 4h | merged into the epic (squash 0b351cc2) after the Opus review (1 Important, 7 Suggestions, all applied) and my check of the fix; the owner applies the ADR 0118 amendment draft (Q29) before any dev switch |
| S3 | [S3 production runbook, the owner flips](cards/S3.md) |  | worker | network | claude-sonnet | blocked | S3a,S3b,S2D,L2 |  |  | 2h | OWNER STEP: the owner flips in a reviewed PR; needs the epic in main, OQ2, the owner's answer to Q30 (container runtime), L2; a 72 hour staging soak is proposed |
| S4 | [S4 runner user service from a signed release](cards/S4.md) |  | worker-hard | network | claude-sonnet | done | S1R | nemar-process#33 | 2026-11-14T08:45-08:00 | 8h | merged into the runner epic (squash 6792b61e) after two Opus reviews and three fix rounds; 25 checks green; owner steps: runner tag, tag rule, cosign, lingering, systemctl --user enable (see the log) |
| S5 | [S5 converge the admission paths](cards/S5.md) |  | worker-hard |  | claude-sonnet | blocked | S2 |  |  | 6h | blocked on the other epic's P3 (nemar-cli 2121); Opus review (concurrency) |
| S6 | [S6 runner reporting in reports](cards/S6.md) |  | worker-hard |  | claude-sonnet | done | DM-07 |  | 2026-11-14T15:54-08:00 | 5h | MERGED into dev (merge commit); migration 0142 is on dev |
| C1 | C1 Docker backend if cut (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | CP-2 |
| C2 | [C2 runner verifies cosign before pull or run](cards/C2.md) |  | worker-hard | network | claude-sonnet | done | C2W,S1R | nemar-process#34 | 2026-11-14T09:46-08:00 | 6h | merged into the runner epic (squash 3887973c) after two Opus reviews and four fix rounds; 26 checks green on 2f6a1e63 incl. the real-cosign tests (a wrong repository is refused by the real cosign v3.1.4) |
| V1 | [V1 derivative store ADR and shared contract](cards/V1.md) |  | worker-hard |  | claude-sonnet | done |  |  | 2026-11-14T16:11-08:00 | 4h | MERGED into dev as 7139cf83 (merge commit); ADR 0123 and shared/contract/derivatives.ts are on dev; V1b unblocked once the lead's card amendment lands |
| Q0 | [Q0 one nemar-floor, Zarr records name what they read](cards/Q0.md) |  | worker-hard | network | claude-sonnet | done | S1R | nemar-process#38 | 2026-11-14T11:40-08:00 | 6h | MERGED into feature/runner-epic as a77a10f7 (squash); PX-06b unblocked; Q0b (dev 7e799ef9) and Q0 must deploy together |
| Q1 | [Q1 nemar-ica on a GPU runner, GPU versus CPU](cards/Q1.md) |  | worker | ssh:ws-b,network | operator | blocked | Q1a,Q1c,L3,PX-06 |  |  | 4h | amended by lead N: CPU path with the GPU reserved, the CPU reference for Q1g; no longer needs QC; after the demo and the owner's release image with both flavors |
| Q2 | [Q2 sample masks and QC summary](cards/Q2.md) |  | worker | network | claude-sonnet | done | Q0 | nemar-process#47 | 2026-11-14T19:03-08:00 | 4h | MERGED into feature/runner-epic as a92914c1 (squash, prefixed title); floor is 1.0.1 on the epic: the nemar-cli registry must follow in the same release (P11); PX-05 merges the base in |
| Z0 | Z0 ADR 0123 (plan section 4) |  | lead |  |  | outline |  |  |  |  | paused by the owner on 2026-11-14 (processing and the path to dev and production go first); resume after S3, with the advisor's findings A1 to A5 and A10 as required content of Z0 |
| Z1 | Z1 formats contract (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | paused by the owner on 2026-11-14 (processing and the path to dev and production go first); resume after S3, with the advisor's findings A1 to A5 and A10 as required content of Z0 |
| Z2 | Z2 nemar-zarr image and recipe (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | paused by the owner on 2026-11-14 (processing and the path to dev and production go first); resume after S3, with the advisor's findings A1 to A5 and A10 as required content of Z0 |
| Z3 | Z3 promote at scale (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | paused by the owner on 2026-11-14 (processing and the path to dev and production go first); resume after S3, with the advisor's findings A1 to A5 and A10 as required content of Z0 |
| Z4 | Z4 pipeline stamps (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | paused by the owner on 2026-11-14 (processing and the path to dev and production go first); resume after S3, with the advisor's findings A1 to A5 and A10 as required content of Z0 |
| Z5 | Z5 shadow conversion of 20 (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | paused by the owner on 2026-11-14 (processing and the path to dev and production go first); resume after S3, with the advisor's findings A1 to A5 and A10 as required content of Z0 |
| Z6 | Z6 cutover (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | paused by the owner on 2026-11-14 (processing and the path to dev and production go first); resume after S3, with the advisor's findings A1 to A5 and A10 as required content of Z0 |
| R0 | [R0 reader epic upstream: CI, review, ADR](cards/R0.md) |  | worker-hard | network | claude-sonnet | done |  |  | 2026-11-14T17:15-08:00 | 4h | ADR 0124 MERGED into dev as baaae696; Opus review of her code posted as one comment on #2144 (her head 98d273bd unchanged); Q8 clock: her green Tests run needs her 3 test fixes by 2026-11-23 |
| R1 | [R1 conformance suite, the TypeScript core passes](cards/R1.md) |  | worker-hard | network | claude-sonnet | todo | R0,V1 |  |  | 6h | needs the portable-compute epic merged into the reader epic (plan 2.5); Sonnet review |
| R2 | R2 EEGLAB reads NEMAR Zarr (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | after R0; CP-4 |
| R3 | R3 launch spec v2 zarr inputs (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | after R0, Q0; CP-3 |
| R4 | R4 private reads for jobs (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | after R0, R3; owner Q9; CP-4 |
| R5 | R5 EEGDash and braindecode read (plan section 4) |  | worker |  |  | outline |  |  |  |  | after R1; CP-4 |
| H1 | H1 slurm backend (plan section 4) |  | worker-hard |  |  | outline |  |  |  |  | after DM-18; CP-3 |
| H2 | H2 equivalence across hosts (plan section 4) |  | worker |  |  | outline |  |  |  |  | after H1; CP-4 |
| W1 | [W1 public page platform/portable-processing](cards/W1.md) |  | worker | network | claude-sonnet | todo | S2 |  |  | 2h | after S2 merged; docs deploy needs the replaced pages token |
| W2 | [W2 gated runner runbook and inventory](cards/W2.md) |  | worker | network | claude-sonnet | todo | DM-19 |  |  | 3h | amended by lead N (etiquette, GPU reservation file, inventory line); dispatch now; dispatched again after S2D, L3 and the owner's answer to Q30 |
| DM-06b | [DM-06b commit check in dispatch](cards/DM-06b.md) |  | worker-hard |  | claude-sonnet | done | DM-06,DM-08 | 2153 | 2026-11-13T16:20-08:00 | 4h |  |
| PX-01 | [PX-01 pAMICA probe on workstation B (rewritten)](cards/PX-01.md) |  | worker | ssh:ws-b,network | operator | blocked |  |  |  | 3h | amended by lead N (idle check, nice build, postpone when busy); only after the demo ends 2026-11-15T12:00; Docker only, scratch on the large disk, no sudo |
| PX-02 | [PX-02 signalJourney packaging](cards/PX-02.md) |  | worker-hard | network | claude-sonnet | done |  | 10 | 2026-11-13T18:00-08:00 | 4h | merged; owner: PyPI trusted publisher for the project signalJourney, the pypi environment, the version, a new tag |
| PX-03 | [PX-03 eegprep icatype pamica (edited)](cards/PX-03.md) |  | worker-hard | network | claude-sonnet | done |  | sccn/eegprep#617 | 2026-11-14T07:44-08:00 | 6h | MERGED into eegprep develop as edf694c8 (merge commit, Q34 A); PX-05 still needs Q0, PX-06, PX-04 in |
| PX-04 | [PX-04 eegprep ASR state](cards/PX-04.md) |  | worker-hard | network | claude-sonnet | done |  | sccn/eegprep#621 | 2026-11-14T09:46-08:00 | 4h | merged into eegprep develop (merge commit 73daa6a0) on the owner's Q34 answer; reference run red for a pre-existing develop pin mismatch, quoted in the body; export, API docs and the 386 merge order still open for the lead |
| PX-05 | [PX-05 nemar-ica recipe](cards/PX-05.md) |  | worker-hard | network | claude-sonnet | review | PX-03,PX-04,PX-06,Q0,PX-06b | nemar-process#50 | 2026-11-15T17:36-05:00 | 6h | Fix round sent (no version change: pre-release scheme card V0 follows): fail before the fit, usage_error message, thread tests, docs; merges the base after V0; the lead writes V0 and the Zarr locations note |
| PX-06 | [PX-06 CUDA flavor and amica15](cards/PX-06.md) |  | worker-hard | network | claude-sonnet | done | S1R | nemar-process#36 | 2026-11-14T11:05-08:00 | 6h | MERGED into feature/runner-epic as 85d3e3ec (squash); open: image tag gate P9, launch contract's sif for CUDA (ruling for Q1a) |
| PX-07 | [PX-07 signalJourney 0.2.0 from PyPI](cards/PX-07.md) |  | worker | network | claude-sonnet | done | S1R | nemar-process#37 | 2026-11-14T11:40-08:00 | 2h | MERGED into feature/runner-epic as 3419ae88 (squash); PX-08 now unblocked |
| PX-08 | [PX-08 eegprep-lean pin to the merge commit](cards/PX-08.md) |  | worker | network | claude-sonnet | done | PX-07 |  | 2026-11-14T16:15-08:00 | 2h | MERGED into feature/runner-epic as a415ffc9 (squash); PX-05 now also waits on Q0 and PX-06b |
| PX-09 | [PX-09 resume a budget-cut run (issue 16)](cards/PX-09.md) |  | worker | network | claude-sonnet | done | Q0 | nemar-process#49 | 2026-11-15T18:13-05:00 | 3h | MERGED into feature/runner-epic as 81945df1 (squash, prefixed title); aggregate --resume; no version change |
| L1 | [L1 launcher deadline and parent-death signal](cards/L1.md) |  | worker-hard |  | claude-sonnet | done | DM-10,DM-11 | nemar-process#30 | 2026-11-14T07:44-08:00 | 4h | merged into the runner epic (squash dcc5cbf9) after two Opus reviews and three fix rounds; 26 checks green on c79be71f; PR 32 now also carries it; D4 end-time change for the owner to confirm |
| C4 | [C4 rootless Podman inspected, refusal lifted](cards/C4.md) |  | worker-hard | network | claude-sonnet | todo | DM-10,L1 |  |  | 6h | Opus review (isolation); tested on CI's hosted rootless Podman |
| REL-1 | [REL-1 nemar-process release automation](cards/REL-1.md) |  | worker-hard | network | claude-sonnet | done |  | 25 | 2026-11-13T17:05-08:00 | 6h |  |
| REL-2 | [REL-2 signalJourney release process](cards/REL-2.md) |  | worker-hard | network | claude-sonnet | done |  | signalJourney#11 | 2026-11-13T18:35-08:00 | 6h | signalJourney 0.2.0 is on PyPI and as GitHub release v0.2.0; owner items left: dead docs-deploy token, second-factor and secret-scanning settings |
| PX-10 | [release provenance in every record](cards/PX-10.md) |  | worker-hard | network | claude-sonnet | done |  | nemar-process#28 | 2026-11-13T18:45-08:00 | 6h | merged into nemar-process main as d6d80b3 (squash, head 0ba48e2 matched); a published image still has no build record until the owner cuts a vX.Y.Z tag and publishes |
| S1a | [S1a declare nm099996 dev-owned](cards/S1a.md) |  | worker |  | claude-sonnet | done |  | nemar-cli#2163 | 2026-11-14T07:38-08:00 | 1h | merged into dev by me on the owner's explicit instruction (squash b9c8f4a0); S1F still needs a dev-to-main release (the owner's) and OQ1 (answered yes) |
| S1R | [S1R staging allowlist pair, runner epic takes dev](cards/S1R.md) |  | worker-hard | network | claude-sonnet | done |  | nemar-process#29 | 2026-11-14T07:38-08:00 | 3h | merged into feature/runner-epic as merge commit 064f0741 after Opus review (no Critical or Important) and a comment-only fix round; 26 checks green on the final head de6c914 |
| C2W | [C2W declare image_unverified](cards/C2W.md) |  | worker |  | claude-sonnet | done |  | nemar-cli#2162 | 2026-11-14T07:38-08:00 | 1h | merged into the epic as e04a05c8; C2 must re-pin nemar-process to this merge commit and mirror the word in the launcher codes file for the drift test |
| S2P | [S2P nemar-process runner epic: green PR into dev](cards/S2P.md) |  | worker | network | claude-sonnet | owner | S1R | nemar-process#48 | 2026-11-14T09:01-08:00 | 2h | Round 2 done: DRAFT PR 48 epic into dev (head a9db39d, 0 behind dev, 14 ahead, all checks pass); owner: code-owner review, merge COMMIT, release, image dispatch, runner tag; PR keeps growing |
| S1F | [S1F build the staging fixture nm099996](cards/S1F.md) |  | worker | network | claude-sonnet | todo | S1a |  |  | 3h | needs S1a released to main, the owner's staging keys (OQ1); stops at once on a DOI on the production shoulder |
| S3b | [S3b staging fail-closed probes](cards/S3b.md) |  | worker | network | claude-sonnet | todo | S3a,S2 |  |  | 2h | GATE from the S3a finding: before any staging switch is set, admin compute status --json must show prerequisites.pipelines_pool_granted false on that environment, or S3c (fail closed on an unconfigured Tapis executor) must have landed |
| S0 | [S0 demo teardown](cards/S0.md) |  | worker | ssh:ws-b,network | operator | blocked | DM-15,DM-19 |  |  | 1h | amended by lead N (records machine and GPU state, starts nothing); only after the demo ends 2026-11-15T12:00: revoke the runner, delete local stack state, remove the runner root |
| S2S | [S2S first staging runner job](cards/S2S.md) |  | worker | ssh:ws-b,network | operator | todo | S0,S1F,S2,S2P,S3a |  |  | 3h | amended by lead N (idle check by hand, low priority, quarter-RAM registration); GATE from S3a: pipelines_pool_granted false first, or S3c landed |
| S2D | [S2D staging drills with the signed runner service](cards/S2D.md) |  | worker | ssh:ws-b,network | operator | todo | S2S,C2,L1,L2,S4 |  |  | 4h | cancel, kill, revoke, lease expiry, priority lines, busy and pause windows (amended by lead N); needs a released runner tag, round 2 with L2 and L3, OQ3 |
| Q0b | [Q0b registry one floor with two inputs, stamp records input](cards/Q0b.md) |  | worker-hard |  | claude-sonnet | done |  | nemar-cli#2177 | 2026-11-14T11:40-08:00 | 6h | MERGED into dev as 7e799ef9 (merge commit); deploys with Q0 together; migration 0141 is on dev, S6 uses 0142 |
| V1b | [V1b the derivative store: copy, retention, promote](cards/V1b.md) |  | worker-hard |  | claude-sonnet | todo | V1,Q0b |  |  | 6h | dark until the owner adds the bucket binding; no DOI path; Sonnet and Opus review |
| Q1a | [Q1a nemar-ica in the registry on the CUDA image](cards/Q1a.md) |  | worker |  | claude-sonnet | blocked | Q0b,PX-05,Q1c |  |  | 3h | amended by lead N (GPU-optional, CPU-sized minutes); needs the owner's release image with both flavors (QA, QB) that contains PX-05 and Q1c |
| R1b | [R1b eegprep-lean suite and engine transport](cards/R1b.md) |  | worker-hard | network | claude-sonnet | todo | R1 |  |  | 6h | Sonnet and Opus review |
| S3c | [S3c Tapis run fails closed while Tapis is unconfigured](cards/S3c.md) |  | worker-hard |  | claude-sonnet | done | S3a | nemar-cli#2168 | 2026-11-14T09:09-08:00 | 4h | merged into the epic (squash d6638b95) after the Opus review (no Critical or Important; docblock fix done); follow-ups: status route tapis.configured vs the predicate, CLI run help word; S3b probes P1 P2 now expect 503 tapis_unconfigured |
| L2 | [L2 runner claims only idle capacity at lowest priority](cards/L2.md) |  | worker-hard |  | claude-sonnet | done | L1 | nemar-process#35 | 2026-11-14T09:53-08:00 | 6h | MERGED into feature/runner-epic as 69760ecc (squash); L3 now unblocked |
| L3 | [L3 GPU only when clearly idle, else CPU](cards/L3.md) |  | worker-hard |  | claude-sonnet | done | L2 |  | 2026-11-14T15:54-08:00 | 6h | MERGED into feature/runner-epic as 240980d9 (squash); L4 unblocked; C4 edits the same launcher files later |
| Q1c | [Q1c nemar-ica GPU cap, CPU fallback, provenance](cards/Q1c.md) |  | worker-hard |  | claude-sonnet | todo | PX-05 |  |  | 4h | Sonnet and Opus review (provenance honesty); lands before the first nemar-process release that contains nemar-ica |
| Q1g | [Q1g nemar-ica on an idle GPU, agreement, fallbacks](cards/Q1g.md) |  | worker | ssh:ws-b,network | operator | blocked | Q1 |  |  | 4h | after the demo and Q28 answered; starts only if the GPU is idle; may wait for days without failing anything; no review |
| PX-06b | [PX-06b CUDA image records name the -cuda tag](cards/PX-06b.md) |  | worker-hard | network | claude-sonnet | done | Q0 | nemar-process#45 | 2026-11-14T18:47-08:00 | 3h | MERGED into feature/runner-epic as d8d5f0e5 (squash); build.image_flavor() is on the epic for PX-05 |
| L4 | [L4 Diagnose, then fix, #31 the OOM read](cards/L4.md) |  | worker-hard | network | claude-sonnet | done | L3 |  | 2026-11-14T18:51-08:00 | 4h | Diagnosis delivered (H2 on both images); owner Q42 C: a follow-up card measures memory.events first, then the launcher reads the kernel's count; the lead writes it; meanwhile one rerun per failure |
| PX-06c | [PX-06c Re-lock the runner epic, CPU torch 2.12.1](cards/PX-06c.md) |  | worker-hard | network | claude-sonnet | done |  | nemar-process#44 | 2026-11-14T18:33-08:00 | 3h | MERGED into feature/runner-epic as 45f541cd (MERGE COMMIT, three commits); nemar-process#42 closed by hand; PX-05 now waits only for PX-06b |
| L5 | [L5 Measure the kernel oom_kill count, then read it](cards/L5.md) |  | worker-hard | network | claude-sonnet | done |  |  | 2026-11-15T13:44-05:00 | 5h | Round 1 UNRELIABLE; owner Q43 D: keep rerunning once per failure; no launcher change; nothing further |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|
| Q40 | - | PX-05 pin: pin eegprep to develop commit edf694c8 (it has PR 616 and 621; develop still says 0.5.0) with a +commit suffix on every eegprep version text, so the next image's engine strings, nemar-floor's too, change? | A pin commit with suffix (Recommended) / B wait for your eegprep release, pin that | none | 2026-11-16T12:00-08:00 | closed | A pin eegprep develop commit edf694c8 with a +commit suffix (owner, 2026-11-14T18:10-08:00) |
| Q41 | - | Torch differs by flavor: cuda extra locks 2.12.1+cu129, cpu extra locks 2.15.0+cpu, so PX-05's CPU tests run another torch than nemar-ica's production image. Pin the cpu extra to 2.12.1 too? | A pin cpu to 2.12.1 in the re-lock chore (Recommended) / B leave 2.15.0 | none | 2026-11-16T12:00-08:00 | closed | A pin the cpu extra to torch 2.12.1 in the re-lock chore (owner, 2026-11-14T18:10-08:00) |
| Q42 | - | L4 found #31 is a lost engine event on both CI images (6/300 and 40/300 launches never report the memory kill). A bounded re-read cannot fix it. Which option for the memory-kill test? | C later card: launcher reads the kernel's own oom count, measure first (Recommended) / A test also accepts entry_failed with exit 137 / D keep rerunning | none | 2026-11-17T12:00-08:00 | closed | C: measure first, then a card where the launcher reads the kernel's own oom count; keep rerunning meanwhile (owner, 2026-11-15T13:25-05:00) |
| Q43 | - | L5 round 1 UNRELIABLE: the container's own cgroup is gone 57 to 123 ms before the launcher can read it. Parent system.slice oom_kill delta was exact (1 in 600/600 memory, 0 in 200/200 controls). Options for the #31 memory-kill flake? | D keep rerunning once per failure (Recommended) / C1 parent-group delta / C2 --cgroup-parent per job / A test accepts entry_failed 137 | none | 2026-11-17T12:00-08:00 | closed | D: keep rerunning once per failure; evidence stays on #31; no launcher change (owner, 2026-11-15T17:35-05:00) |
| Q44 | - | PX-05: ICLabel needs scalp locations the Zarr serving copy lacks, so nemar-ica --input zarr always fails at iclabel after the fit. Skip ICLabel with a recorded reason, or fail as the card says? | A skip ICLabel, record the reason, keep the ICA (Recommended) / B fail the recording as the card says | none | 2026-11-17T12:00-08:00 | closed | Neither skip nor remove: ICLabel stays (the owner's ONNX ICLabel is fast and wanted); channel locations should be considered for the Zarr package like events (owner, 2026-11-16T13:58-05:00) |
| Q45 | - | PX-05 adds 4 PARAMETER_TYPES rows and a version helper under common/ with no floor byte change; docs/recipes.md bumps COMMON_VERSION for any common/ change. Bump to 1.0.1 or keep 1.0.0 via the Q35 exception? | A bump 1.0.1 (Recommended: identities move this release anyway) / B keep 1.0.0, widen the Q35 exception | none | 2026-11-17T12:00-08:00 | closed | Not answered as asked: owner objects that nemar-process has not been released, so a 1.0.1 makes no sense; superseded by Q46 (owner, 2026-11-16T14:01-05:00) |
| Q46 | - | Nothing in nemar-process is released (no tag). Image 0.1.0-cpu exists but is it a release? A: no, a demo build: keep COMMON_VERSION and nemar-floor at 1.0.0, revert Q2's 1.0.1, drop P11. B: yes, keep 1.0.1 and bump common | A not a release: no bumps, revert Q2 to 1.0.0 (Recommended) / B 0.1.0-cpu is a release: keep 1.0.1, bump common to 1.0.1 | none | 2026-11-17T12:00-08:00 | closed | A: not a release, nothing is released; no 1.0.1; until the first release iterate pre-release versions such as 1.0.0-b1, bx to track iterations (owner, 2026-11-16T14:04-05:00) |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|
| P2 | 2026-11-13T23:05-08:00 | Post-demo card for the image workflow: the test job also checks the build and version labels, and the sign job refuses to sign when the digest's build record disagrees with the version step | PX-10 review: the release path has only static tests; sign and release jobs are the owner's guarded surface, so PX-10 leaves them unchanged and this needs an owner decision | open |
| P8 | 2026-11-14T09:44-08:00 | Lead: amend PX-05 and the plan 2.9 note from the E1 findings, then decide the eegprep defaults PR | E1 passed at seed 5489 only (the binary seeds from the clock): records and docs say so; a docs note that did_converge is False by construction at defaults; check two amica15-fallback runs agree; float32 caveat | accepted |
| P9 | 2026-11-14T13:08-08:00 | Lead: gate before the first CUDA-flavor release: common/build.py hard-codes IMAGE_FLAVOR=cpu, so CUDA records carry tag <version>-cpu; image_tag must read /opt/nemar/flavor, check_recorded accept -cpu and -cuda | PX-06 Opus review, Important; PX-06 scope forbids common/; only the first release with both flavors waits | accepted |
| P10 | 2026-11-14T16:06-08:00 | Lead: a diagnosis card for nemar-process #31 (docker e2e memory-kill test, exit 13 not 14): six occurrences on five PRs in one day; reruns hide it; find the race in the launcher's OOM read | Contribute rule: the same defect kind twice goes to the lead; it costs a rerun on nearly every runner PR | accepted |
| P11 | 2026-11-15T13:44-05:00 | Card for the nemar-cli Worker registry: nemar-floor moves to 1.0.1 in the same release as the first image carrying Q2 (else every floor stamp ends tuple_mismatch) | Q2 bumps RECIPE_VERSION to 1.0.1 under docs/recipes.md; the Worker registry carries the version; a release-time coupling the owner runs | withdrawn |
| P12 | 2026-11-16T13:58-05:00 | Lead: card so the Zarr input carries the store's electrode_positions into EEG chanlocs (eegprep-lean to_eeg drops them), then nemar-ica on Zarr can run ICLabel | Owner Q44: keep ICLabel. Found 2026-11-16: the converter embeds electrode_positions in the store and the website viewer reads them; the reader drops them | open |

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
| fix-S4-r2 | implementer | claude-sonnet | Sonnet xhigh | S4 | 2026-11-14T10:02-08:00 | done |
| rev-PX-04-sonnet | reviewer | claude-review | Sonnet high | PX-04 | 2026-11-14T10:05-08:00 | done |
| fix-S2-r2 | implementer | claude-sonnet | Sonnet xhigh | S2 | 2026-11-14T10:05-08:00 | done |
| rev-S4-opus2 | reviewer | claude-opus | Opus xhigh | S4 | 2026-11-14T10:17-08:00 | done |
| fix-C2-r1 | implementer | claude-sonnet | Sonnet high | C2 | 2026-11-14T10:22-08:00 | done |
| rev-C2-opus | reviewer | claude-opus | Opus xhigh | C2 | 2026-11-14T10:22-08:00 | done |
| fix-PX-04-r1 | implementer | claude-sonnet | Sonnet xhigh | PX-04 | 2026-11-14T10:22-08:00 | done |
| lead-pamica | lead | claude-opus | Opus xhigh | pamica | 2026-11-14T10:49-08:00 | done |
| fix-PX-03-r3 | implementer | claude-sonnet | Sonnet xhigh | PX-03 | 2026-11-14T10:52-08:00 | done |
| fix-S4-r3 | implementer | claude-sonnet | Sonnet xhigh | S4 | 2026-11-14T10:52-08:00 | done |
| fix-C2-r2 | implementer | claude-sonnet | Sonnet high | C2 | 2026-11-14T10:52-08:00 | done |
| rev-L2-opus | reviewer | claude-opus | Opus xhigh | L2 | 2026-11-14T10:52-08:00 | done |
| rev-2167-sonnet | reviewer | claude-review | Sonnet high | S2 | 2026-11-14T10:54-08:00 | done |
| fix-PX-03-r4 | implementer | claude-sonnet | Sonnet xhigh | PX-03 | 2026-11-14T11:04-08:00 | done |
| impl-PX-06 | implementer | claude-sonnet | Sonnet xhigh | PX-06 | 2026-11-14T11:05-08:00 | done |
| fix-L2-r1 | implementer | claude-sonnet | Sonnet xhigh | L2 | 2026-11-14T11:06-08:00 | done |
| fix-C2-r3 | implementer | claude-sonnet | Sonnet high | C2 | 2026-11-14T11:17-08:00 | done |
| fix-S2-r3 | implementer | claude-sonnet | Sonnet xhigh | S2 | 2026-11-14T11:33-08:00 | done |
| impl-ADR0118 | implementer | claude-sonnet | Sonnet xhigh | ADR-0118 | 2026-11-14T11:33-08:00 | done |
| rev-L2-opus2 | reviewer | claude-opus | Opus xhigh | L2 | 2026-11-14T11:37-08:00 | done |
| rev-C2-opus2 | reviewer | claude-opus | Opus xhigh | C2 | 2026-11-14T11:38-08:00 | done |
| impl-Q0b | implementer | claude-sonnet | Sonnet xhigh | Q0b | 2026-11-14T11:40-08:00 | done |
| impl-Q0 | implementer | claude-sonnet | Sonnet xhigh | Q0 | 2026-11-14T11:40-08:00 | done |
| impl-PX-07 | implementer | claude-sonnet | Sonnet xhigh | PX-07 | 2026-11-14T11:40-08:00 | done |
| fix-C2-r4 | implementer | claude-sonnet | Sonnet high | C2 | 2026-11-14T11:46-08:00 | done |
| fix-L2-r2 | implementer | claude-sonnet | Sonnet xhigh | L2 | 2026-11-14T11:47-08:00 | done |
| fix-PX-03-r5 | implementer | claude-sonnet | Sonnet high | PX-03 | 2026-11-14T12:08-08:00 | done |
| fix-L2-r3 | implementer | claude-sonnet | Sonnet xhigh | L2 | 2026-11-14T12:10-08:00 | done |
| rev-PX-07-sonnet | reviewer | claude-review | Sonnet high | PX-07 | 2026-11-14T12:10-08:00 | done |
| rev-Q0-sonnet | reviewer | claude-review | Sonnet high | Q0 | 2026-11-14T12:13-08:00 | done |
| rev-Q0-opus | reviewer | claude-opus | Opus xhigh | Q0 | 2026-11-14T12:13-08:00 | done |
| rev-Q0b-sonnet | reviewer | claude-review | Sonnet high | Q0b | 2026-11-14T12:15-08:00 | done |
| rev-Q0b-opus | reviewer | claude-opus | Opus xhigh | Q0b | 2026-11-14T12:15-08:00 | done |
| rev-PX-06-sonnet | reviewer | claude-review | Sonnet high | PX-06 | 2026-11-14T12:18-08:00 | done |
| rev-PX-06-opus | reviewer | claude-opus | Opus xhigh | PX-06 | 2026-11-14T12:18-08:00 | done |
| fix-PX-07-r1 | implementer | claude-sonnet | Sonnet high | PX-07 | 2026-11-14T12:20-08:00 | done |
| fix-Q0-r1 | implementer | claude-sonnet | Sonnet xhigh | Q0 | 2026-11-14T13:20-08:00 | done |
| fix-Q0b-r1 | implementer | claude-sonnet | Sonnet xhigh | Q0b | 2026-11-14T13:20-08:00 | done |
| fix-PX-06-r1 | implementer | claude-sonnet | Sonnet xhigh | PX-06 | 2026-11-14T13:20-08:00 | done |
| impl-S6 | implementer | claude-sonnet | Sonnet xhigh | S6 | 2026-11-14T15:55-08:00 | done |
| impl-L3 | implementer | claude-sonnet | Sonnet xhigh | L3 | 2026-11-14T15:55-08:00 | done |
| lead-V1-amend | lead | claude-opus | Opus xhigh | V1 | 2026-11-14T15:55-08:00 | done |
| rev-Q0b-delta | reviewer | claude-review | Sonnet high | Q0b | 2026-11-14T16:05-08:00 | done |
| impl-V1 | implementer | claude-sonnet | Sonnet xhigh | V1 | 2026-11-14T16:20-08:00 | done |
| impl-PX-08 | implementer | claude-sonnet | Sonnet xhigh | PX-08 | 2026-11-14T16:20-08:00 | done |
| rev-V1-opus | reviewer | claude-opus | Opus xhigh | V1 | 2026-11-14T16:40-08:00 | done |
| rev-V1-sonnet | reviewer | claude-review | Sonnet high | V1 | 2026-11-14T16:40-08:00 | done |
| fix-V1-r1 | implementer | claude-sonnet | Sonnet xhigh | V1 | 2026-11-14T17:05-08:00 | done |
| rev-S6-opus | reviewer | claude-opus | Opus xhigh | S6 | 2026-11-14T17:05-08:00 | done |
| lead-cards-amend | lead | claude-opus | Opus xhigh | V1 | 2026-11-14T17:10-08:00 | done |
| impl-R0 | implementer | claude-sonnet | Sonnet xhigh | R0 | 2026-11-14T17:20-08:00 | done |
| lead-px05-amend | lead | claude-opus | Opus xhigh | PX-05 | 2026-11-14T17:20-08:00 | done |
| lead-px06b-f31 | lead | claude-opus | Opus xhigh | PX-06 | 2026-11-14T17:20-08:00 | done |
| fix-V1-serving | implementer | claude-sonnet | Sonnet xhigh | V1 | 2026-11-14T17:30-08:00 | done |
| rev-L3-opus | reviewer | claude-opus | Opus xhigh | L3 | 2026-11-14T17:50-08:00 | done |
| rev-PX-08-sonnet | reviewer | claude-review | Sonnet high | PX-08 | 2026-11-14T17:50-08:00 | done |
| fix-Q0-r2 | implementer | claude-sonnet | Sonnet xhigh | Q0 | 2026-11-14T16:30-08:00 | done |
| rev-Q0-delta | reviewer | claude-review | Sonnet high | Q0 | 2026-11-14T18:05-08:00 | done |
| rev-R0-opus | reviewer | claude-opus | Opus xhigh | R0 | 2026-11-14T18:15-08:00 | done |
| rev-R0-sonnet | reviewer | claude-review | Sonnet high | R0 | 2026-11-14T18:15-08:00 | done |
| fix-PX-08-r1 | implementer | claude-sonnet | Sonnet high | PX-08 | 2026-11-14T18:25-08:00 | done |
| fix-L3-r1 | implementer | claude-sonnet | Sonnet xhigh | L3 | 2026-11-14T18:50-08:00 | done |
| fix-S6-r1 | implementer | claude-sonnet | Sonnet xhigh | S6 | 2026-11-14T18:50-08:00 | done |
| lead-px06c | lead | claude-opus | Opus xhigh | PX-05 | 2026-11-14T19:00-08:00 | done |
| fix-Q0-r3 | implementer | claude-sonnet | Sonnet xhigh | Q0 | 2026-11-14T18:20-08:00 | done |
| impl-PX-06c | implementer | claude-sonnet | Sonnet xhigh | PX-06c | 2026-11-14T18:40-08:00 | done |
| impl-PX-06b | implementer | claude-sonnet | Sonnet xhigh | PX-06b | 2026-11-14T18:45-08:00 | done |
| impl-L4 | implementer | claude-sonnet | Sonnet xhigh | L4 | 2026-11-14T18:55-08:00 | done |
| impl-Q2 | implementer | claude-sonnet | Sonnet high | Q2 | 2026-11-14T19:05-08:00 | done |
| rev-PX-06c-opus | reviewer | claude-opus | Opus xhigh | PX-06c | 2026-11-15T13:40-05:00 | done |
| rev-PX-06c-sonnet | reviewer | claude-review | Sonnet high | PX-06c | 2026-11-15T13:40-05:00 | done |
| rev-PX-06b-opus | reviewer | claude-opus | Opus xhigh | PX-06b | 2026-11-15T13:40-05:00 | done |
| rev-PX-06b-sonnet | reviewer | claude-review | Sonnet high | PX-06b | 2026-11-15T13:40-05:00 | done |
| lead-q2-l5 | lead | claude-opus | Opus xhigh | Q2 | 2026-11-15T13:40-05:00 | done |
| impl-L5 | implementer | claude-sonnet | Sonnet xhigh | L5 | 2026-11-15T14:00-05:00 | done |
| fix-PX-06c-r1 | implementer | claude-sonnet | Sonnet xhigh | PX-06c | 2026-11-15T14:25-05:00 | done |
| fix-PX-06b-r1 | implementer | claude-sonnet | Sonnet xhigh | PX-06b | 2026-11-15T14:50-05:00 | done |
| rev-Q2-sonnet | reviewer | claude-review | Sonnet high | Q2 | 2026-11-15T15:20-05:00 | done |
| impl-PX-05 | implementer | claude-sonnet | Sonnet xhigh | PX-05 | 2026-11-15T15:20-05:00 | done |
| fix-Q2-r1 | implementer | claude-sonnet | Sonnet xhigh | Q2 | 2026-11-15T18:05-05:00 | done |
| impl-PX-09 | implementer | claude-sonnet | Sonnet high | PX-09 | 2026-11-15T18:10-05:00 | done |
| impl-S2P-r2 | implementer | claude-sonnet | Sonnet high | S2P | 2026-11-15T18:35-05:00 | done |
| rev-PX-09-sonnet | reviewer | claude-review | Sonnet high | PX-09 | 2026-11-15T18:50-05:00 | done |
| rev-PX-05-opus | reviewer | claude-opus | Opus xhigh | PX-05 | 2026-11-15T19:10-05:00 | done |
| rev-PX-05-sonnet | reviewer | claude-review | Sonnet high | PX-05 | 2026-11-15T19:10-05:00 | done |
| fix-PX-09-r1 | implementer | claude-sonnet | Sonnet high | PX-09 | 2026-11-15T19:30-05:00 | done |
| lead-version-scheme | lead | claude-opus | Opus xhigh | PX-05 | 2026-11-16T19:40-05:00 | running |
| lead-zarr-locations | lead | claude-opus | Opus xhigh | PX-05 | 2026-11-16T19:40-05:00 | running |
