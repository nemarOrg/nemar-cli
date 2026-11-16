# Portable compute: workstation runners, one container, Zarr in and out

**Status:** revision 2, 2026-11-13 (Friday), after three pack reviews; dispositions in `dispositions.md`.
**Owner:** Seyed Yahya Shirazi.
**Demo:** an NIH brain meeting on Sunday 2026-11-15; the demo freeze is 2026-11-15T06:00 Pacific.
**Repositories:** `nemarOrg/nemar-cli` (control plane, contracts, reader core), `nemarOrg/nemar-process` (launcher, runner, images, recipes), `sccn/eegprep` (numerics and the Python reader), `nemarOrg/docs` (pages, later).

Abbreviations, defined once here: Architecture Decision Record (ADR); command-line interface (CLI); continuous integration (CI); Open Container Initiative (OCI); OCI Registry As Storage (ORAS); Singularity Image Format (SIF); GitHub Container Registry (GHCR); Brain Imaging Data Structure (BIDS); electroencephalography (EEG); magnetoencephalography (MEG); intracranial EEG (iEEG); tab-separated values (TSV); content delivery network (CDN); digital object identifier (DOI); OpenID Connect (OIDC); graphics processing unit (GPU); Structured Query Language (SQL); Transmission Control Protocol (TCP); universally unique identifier (UUID); the NSF program Advanced Cyberinfrastructure Coordination Ecosystem: Services & Support (ACCESS); Cloudflare's SQLite database (D1); Cloudflare's object store (R2); Simple Linux Utility for Resource Management (SLURM); service unit (SU); quality control (QC); high-performance computing (HPC); Model Context Protocol (MCP).

This repository is public.
Workstations are "workstation A" and "workstation B" everywhere in this pack; host names, accounts, ssh aliases, paths and network details live only in the gated docs (`admin/operations/systems-inventory`) and in the operator's private notes, and the manager supplies the aliases at dispatch from the owner's answer.
"The demo workstation" is the one DM-01's rule picks: the machine that does not run the production Zarr conversion cron, unless only that one can run a container (risk K16).

Owner decisions of 2026-11-13 are folded in: Q3 option A (signed CI image after the owner merges to `main`), the serving-copy QC label, Q9 (public data only on runners), and a read-only probe over the existing aliases as the owner's login; creating a directory or installing anything on a workstation still waits on Q12.
The reader work in a collaborator's fork is called "the collaborator's reader epic".

## 0. How the manager uses this plan

1. **Start prompt** (the host's self-paced loop with no interval; `/loop ` prefix in Claude Code):

   ```text
   You are the manager of NEMAR portable compute, demo track then full program.
   Run one tick of the runbook at <absolute path to .context/plans/portable-compute/runbook.md in the board worktree>, exactly as written, using the project:manager-loop skill.
   The state is the board beside it: <absolute path to board.md>.
   Your manager id is <host>-claude-sonnet, the same on every tick.
   Do not write product code.
   Do not change the plan, a card, a gate, the parity, or a budget limit.
   When the runbook says to stop or to ask, or does not cover what you see, record it on the board, ask the owner with a structured question, and stop that thread of work.
   ```

   Pacing: 20 minutes while any card is `active` before the freeze; afterwards 30 minutes with workers running and 60 waiting on people.
2. **The tick** is `runbook.md`; its Setup section creates the board, the epic branches, and the commit that puts this pack on them.
3. **Precedence.** The owner's later instructions override this plan and are logged with `decide`.
   `AGENTS.md` overrides this plan except for two explicit exceptions, and **approving this plan is the owner's knowing override of `AGENTS.md` on both**:
   (a) `AGENTS.md` says "never hand-roll an epic" and names `/project:epic-dev`; this program is driven by `project:manager-loop` instead, with the board replacing `.claude/epic.local.md` and the manager mirroring each step into its epic issue;
   (b) the demo's control plane runs as a local stack, so nothing in the demo track merges into `dev`.
   Where an ADR and this plan disagree, the ADR wins; this plan proposes ADRs and never edits an accepted one except by a dated pointer amendment or a superseding ADR.
   Approving the plan also approves the one `AGENTS.md` edit it makes (DM-05 adds `COMPUTE_RUNNERS_ENABLED` to the dark-switch hard rule).
4. **Merge authority.** The manager merges, after the merge gate, phase PRs into the two epic branches only: nemar-cli `feature/portable-compute-epic` and nemar-process `feature/runner-epic`, with `gh pr merge <n> --squash --admin`.
   It never merges an epic into `dev` or `main`, anything in `sccn/eegprep` or `nemarOrg/docs`, a release, or anything that publishes; those are the owner's, handed over as exact commands.
5. **Question classes that may take a default at their deadline:** none, unless the owner pre-authorizes one in `open-questions.md` (Q2 and Q4 offer that).
6. **Routing.** Implementers are Sonnet (`worker`, `worker-hard`); reviews are the Sonnet panel of `project:pr-review-toolkit` plus ONE Opus review on every card whose Review line says so.
   Opus is the lead and the default advisor.
   The frontier tier (Fable) is used at checkpoint CP-F (end of the demo track), and on the **frontier trigger**: the lead tier cannot decide a contested architecture finding after one Opus advisor consult, or the same card loops through three failed approaches.
7. **Live facts** added to every dispatch: `$WT` (worktree root), `$NEMAR_CLI`, `$NEMAR_PROCESS`, `$EEGPREP` (primary checkouts, never edited), base heads, open PRs, and the DM-01 and DM-02 findings in public-safe form.

## 1. Goal, scope and the honest verdict

Processing starts on lab workstations with proper queues, and the same containerized job later runs on HPC.
The design already made stays: ADR 0118's gateway, ledger, records, the two digests, `nemar.launch-spec.v1`, the `nemar-launch` launcher, the observer, recipes with signalJourney, and the owner's dark switches.
This plan EXPANDS it: a workstation runner becomes an executor beside Tapis, Zarr conversion becomes a pipeline in nemar-process, and one format with one conformance suite and one credentialed engine serves every reader.

**Honest verdict on the demo.** The control-plane chain DM-04 -> DM-05 -> DM-06 -> DM-07 -> DM-17 -> DM-18 (with DM-06b, the Zarr source check, running beside DM-07) is about 34 hours of implementation, review and merge from Friday 15:00, so a live end-to-end run (G5) before CP-GO (Saturday 18:00) is unlikely.
**The plan of record for Sunday is fallback F2**: labeled components (the recipe container run by hand on the demo workstation on real public data, the reader in mne-python live, the recorded test runs, the architecture).
If the chain lands early enough for one recorded end-to-end run (F1) before 2026-11-15T05:00, the brief adds it, labeled with its time and commits.
Nothing is presented as live that did not run live.

## 2. Architecture (lead decisions)

Each decision: what, why in one line, and the rejected alternative.
ADR 0121 (DM-03) records D1 to D7 and D14's demo rule; ADR 0122 (DM-03) records D8; ADR 0123 (V1) records D14's derivative store (the key, the digests, the retention classes); R0's reader ADR takes the next free number once V1's PR merges (0124 unless a fetch shows otherwise) and records D9 and D11; Z0's ADR (paused) takes the next free number when Z0 resumes and records D10 and D13; D12 needs no ADR.

### 2.1 Executors and accounting

**D1. A job names its executor and its accounting class.**
`compute_jobs.executor` is `tapis` (default) or `runner`; a runner job also records `runner_backend` `local` (workstation) or `slurm` (slurm-direct, phase H).
`compute_jobs.accounting` is `su` (default) or `none`; a Tapis job is always `su` (a CHECK says so).
Executor mechanics (the advance tick, the submit claim, the cancel sweep, the tenant sweep, the admin advance, and #2121 P3's admitter when it lands) select `executor = 'tapis'`; money and tenancy (the ledger, `tenantGuard`, the pipelines' live cap, the observer's settlement, the ACCESS report) select `accounting = 'su'`.
*Why:* accounting follows the resource, not the dispatch mechanism, so a runner on an allocated cluster later is `su` without a rewrite.
*Rejected:* keying money on the executor (a runner on an allocation would escape the ledger), and a table per executor (forks records and reports).

**D2. No new state; a waiting runner job is `created` with `runner_claimed_at` NULL.**
A claim sets `runner_claimed_at`, `runner_id` and a lease and leaves the state `created`; the runner's `started` heartbeat writes `created -> running`, its `uploading` heartbeat `running -> archiving`, and `finished` stands only after `verifyResults`.
An unstarted lease that expires clears the claim (no backward edge needed); a started job whose runner goes silent becomes `unreported`.
The column is deliberately not #2121 P3's `admitted_at`, so either migration can land first; S5 converges them.
For `runner/local`, `submitted` and `queued` are never used; whether a `runner/slurm` job uses `queued` for its time in a SLURM queue is decided at H1.
*Rejected:* a `claimed` state (widens every CHECK for what a column says).

**D3. Workstations pull; NEMAR never pushes.**
`nemar-runner` (nemar-process, Python 3.9 or newer, standard library only) runs as an unprivileged user, opens no port, sends `User-Agent: nemar-runner/<version>`, and polls the Worker over HTTPS.
*Rejected:* NEMAR ssh-ing jobs to hosts (a push surface and stored host credentials), and a message broker (a new service).

**D4. Protocol `nemar.runner.v1`: register, exchange, claim, heartbeat, complete.**

- *Register* (owner only) mints a secret `nmr_` plus 64 hex, shown once, stored as SHA-256, with capacity, `accounting`, `site` (a fixed word) and `trust` (`lab` or `hpc`).
- *Exchange:* the secret and the protocol version buy a 15-minute access token `nmra_` plus 64 hex, hashed at rest.
  `authMiddleware` and `resolveApiKeyUser` refuse both prefixes before any lookup (`runner_credential_not_accepted`), as ADR 0119 does for `nmo_`.
- *Claim:* returns `jobs` with up to `free_slots` entries, each admitted by its own conditional UPDATE (the `claimOpenDispatch` pattern), each with its own 10-minute lease; the dataset's public eligibility is checked again inside the statement; the claim writes `launch_spec_digest` of the launch specification it answers (a re-claim overwrites it from its own specification) and keeps `image_digest`.
- *Heartbeat* every 60 seconds renews the lease and answers `cancel`.
- *Complete* is idempotent for `(job, lease_id)`: the lease is kept after completion, so a retried complete answers the same state.
- *Lease rules:* a started job's lease is never replaced; an unstarted expired lease releases the claim (at most 3 claims, then `failed` `runner_lost` `claims_exhausted`); a started job past its lease is `unreported`, and an `unreported` runner job whose outputs completed is verified like any other, otherwise it fails `runner_lost` `lease_expired` after 60 minutes.
- *Deadline:* the runner sends SIGTERM at `NEMAR_JOB_END_TIME` plus 60 seconds and SIGKILL 30 seconds later; the Worker fails a started job past `started_at` plus its minutes plus 15 minutes with `runner_lost` `deadline_exceeded` unless its outputs completed.
  `sweepRunnerLeases` runs on every claim call (every environment, so the local stack and staging get it whenever a runner polls) and on the production 30-minute tick.
- *Acceptance:* bundle, outputs and outputs-complete calls of a runner job need the current lease (`X-Compute-Lease`); at least once execution, at most once acceptance.
*Rejected:* exactly-once execution (impossible across a partition), and a WebSocket push.

**D5. Runner credentials cascade, and a revoke ends the runner's work.**
Revoking a registration, in one batch: revokes it, deletes its tokens, releases its unstarted claims, and moves its started jobs to `unreported` with the lease cleared, so neither `job_token` nor lease can land outputs; they then follow D4.
`runnerEndStatements(userId)` does the same for every registration an owner made, in the batch of `finalizeRevocation`, `tombstoneUserCascade` and an owner's role demotion; `RUNNER_END_CALLERS` names them and a source-scan test holds the list; a key revocation is deliberately not a caller.

**D6. An `accounting = 'none'` job writes no ledger entry; usage is measured and labeled.**
No hold, charge or adjustment; the terminal batch stamps `settled_provisional_at` and `settled_final_at` with `charged_milli = 0`, so the records copy and the reports treat it as settled; usage is `runner_wall_seconds`, `runner_cpu_seconds` and `runner_max_rss_mb`, shown as "runner-reported core-hours", never as SU.
Capacity is the runner guard inside the job's INSERT: live `accounting = 'none'` runner jobs of the pool fewer than `policy.runners.maxLiveJobs[pool]` (default cpu 64, gpu 8).
`accounting = 'su'` runner jobs are refused (`runner_accounting_unbuilt`) until phase H builds hold, settlement and ACCESS for them.
A runner job's sizing uses an existing partition name as a label only (`shared`, whose ceilings apply), and `estimateSuMilli` is never called for it.
*Rejected:* a zero-SU hold (a shape that lies about a budget), and a second ledger in core-hours.

**D7. A third dark switch, `COMPUTE_RUNNERS_ENABLED`**, needed with `computeEnabled(env)`, absent from `wrangler-sccn.toml`, pinned by the flag test, and named in `AGENTS.md`'s dark-switch rule.

### 2.2 Containers

**D8. One OCI image, pinned by digest, runs under Apptainer (primary) or Docker or Podman (second backend).**
Apptainer is primary on workstations and HPC (rootless, no daemon, already exercised by the launcher's CI); Docker or Podman uses pinned isolation flags; a rootful `docker` group is allowed only on a single-tenant lab machine recorded in the gated inventory.
Resource limits: Docker gets `--cpus` and `--memory` always; Apptainer gets `--cpus` and `--memory` when the runner's `doctor` proved cgroup delegation (`NEMAR_ENFORCE_LIMITS=1`), and otherwise the runner's watchdog enforces wall time and resident memory.
Images are built once in CI and signed **only** from `main` or an `image-nemar-python-v*` tag (the workflow's `SIGNING_IDENTITY`).
Owner decision (Q3, option A): the owner merges nemar-process PR #17 and `feature/runner-epic` (once DM-13 is in it) into `main`, and CI publishes and signs the demo image; the manager never merges to `main`.
If no signed digest verifies by 2026-11-14T08:00, the fallback is an operator-built, unsigned image labeled with its source commit and image id, and after that F2 and F3.

### 2.3 Data and fidelity

**D9. Read what the job needs, keep it only for the job.**
Inputs land only in the job's own directory under the runner root (mode 0700), deleted in a `finally` and swept at runner start; private bytes never enter a shared cache.
The demo recipe streams whole recordings into memory with no dataset download and nothing kept on disk; launcher-staged Zarr inputs (launch specification v2, R3) make the platform, not the recipe, record what was read.

**D13. The Zarr serving copy is lossy, and every derived product names the fidelity it describes.**
The serving copy is int16, and its sampling rate is capped per modality (EEG and MEG at 250 Hz, iEEG and electromyography at 1000 Hz; ADR 0028 and the converter).
QC on it describes the serving copy, not the archived recordings, and the demo says so.
Owner decision (2026-11-13): everything runs on the Zarr serving copy by default (EEG 250 Hz; EMG and iEEG 1 kHz), and the demo carries the plain label above.
Owner refinement (2026-11-14, Q18): 250 Hz is the EEG rate cap of ADR 0028, not a rate every EEG store is resampled to; general statements say "capped at 250 Hz", and only the demo statement in 3.1 names its dataset's serving rate.
A named fidelity profile carried by the index (`serving` now, a native-rate lossless `native` later) stays an option for Z0's ADR, not a demo item; every derived product already states `profile: serving`.

**D14. Derived outputs have their own home.**
A derivative is an addressable object keyed by (source dataset version, recipe, recipe version, engine, input profile, index digest), with its own retention class and optionally its own DOI.
It is never written into the raw-only serving copy (ADR 0027) and never committed into the dataset repository (a version bump, an irrevocable DOI and a stamp loop).
The demo keeps outputs in the local stack's R2 stand-in or the operator's scratch and says so; the durable store is step V1 (Q11).

### 2.4 Zarr conversion becomes a pipeline (phase Z)

**D10.** The converter, its tests, the biosigIO pin and the admission ledger move to nemar-process (`nemar-zarr` image, `nemar-zarr-convert` recipe); the gate, the serving schemas, `/zarr-ready`, CDN purge and the queue state stay in nemar-cli, the state becoming D1 pipeline stamps.
Z0's ADR (the next free number when Z0 resumes) supersedes ADR 0029 and, because the queue moves to D1 and admission moves to runners, also ADR 0033 and ADR 0101, restating their rules where they now live.
The biosigIO pin is mirrored today in `requirements.txt`, `hallu-zarr.sh` (spec, floor, cap), `generate_zarr.py`'s `SUBJECT_INFO_FLOOR` (the subject-info privacy floor, exit 78) and `test_hallu_zarr_config.py`; the drift test covers all of them and the privacy floor survives the move.
Raw input reaches a conversion runner through the data plane's presigned reads (no storage credential); serving writes go through a promote mechanism CP-F chooses against the scale (up to 25,000 stores per dataset, recordings of 100 to 145 GiB, the Worker's 1,000 subrequests per invocation).
Reproducibility contract: a store is reproduced by deterministic reconversion, and the index records the converter image digest and the conversion job id.
No outage: formats contract (Z1), shadow conversions compared with the cron's including the largest datasets (Z5), cutover per dataset (Z6), cron retired last.

### 2.5 Readers (phase R)

**D11. One format, one conformance suite, one credentialed engine.**
Guarantee: a public store is readable by stock zarr-python or xarray with no NEMAR code.
Three readers survive and are held to one conformance suite: the TypeScript core from the collaborator's reader epic (CLI, MCP, local engine), eegprep-lean (Python and Pyodide), and EEGDash's own reader (their team).
The engine's unique job is credential brokering for private data; eegprep-lean gains an engine transport for it.
Owner decision (Q9, 2026-11-13): runners process public data only; private data on runners waits for launcher-staged, no-network private jobs (R3, R4).
The demo does not claim a consolidated reader and does not use the collaborator's reader: it reads public data only, through eegprep-lean, labeled.

**Design goal of the R-track (owner, 2026-11-13):** one reader that reads public AND private data according to the authorization the person (or the job) holds.
The integration point is an authorization-aware Fetcher behind the core's `Fetcher` interface (`(url, init) => Promise<Response>`, which today refuses `Authorization`): for a public dataset it fetches anonymously; for a private one it obtains short-lived access through the person's own credential path (ADR 0114's listed origins, never a key on another origin) in the CLI and engine, or a job-scoped read grant on a runner (R4), and the private tier's access check decides; no shared cache holds private bytes.

**Mechanism, not waiting for the collaborator's PR (nemarOrg/nemar-cli#2144, a draft into `dev`, which cannot merge before the demo; owner, 2026-11-13).**
At CP-2 the manager creates `feature/reader-epic` in nemarOrg/nemar-cli from her PR head exactly (`git fetch origin pull/2144/head:reader-base` then `git push origin reader-base:refs/heads/feature/reader-epic`), keeping her commits intact (no rebase, no squash), so CI with the organization's secrets runs on it (her fork's CI cannot get them, issue #2142).
R-track PRs target `feature/reader-epic`; when R3 or R4 needs the runner work, the manager merges `feature/portable-compute-epic` into `feature/reader-epic` with a merge commit, keeping her `0120` index line and this program's `0121` onward, and deleting `120` from `TOLERATED_GAPS` in that same merge commit (the gap no longer exists in that history).
The demo epic never merges her branch before the demo. Her PR can still land afterwards: Q8.

### 2.6 Recipes

**D12. eegprep is the numerics; recipes annotate.**
`nemar-floor-zarr` is a transition name for nemar-floor's chain on a Zarr input; step Q0 converges it into one `nemar-floor` with the input kind as an argument, on both executors.
For Zarr-input recipes the stamp tuple must grow (Zarr engine version, converter image digest, biosigIO version, reader version, index digest): Q0 adds it; until then the recipe records them in signalJourney.
A Zarr-input recipe may open HTTPS connections only to a fixed allowlist written in the recipe code (the Zarr host and the data bucket host, which the Zarr host redirects every read to); `--zarr-base` and the index's `data_base` must each name an allowlisted host or the recipe refuses before reading; it follows at most one redirect, only to an allowlisted HTTPS host; an audit hook refuses any other host; requests carry no credentials; signalJourney lists the hosts contacted. Every other recipe still opens none.
The security argument: no host is ever taken from data, so a corrupted or malicious index, or a compromised Zarr host, cannot steer a job's reads or connections to an arbitrary host; at worst it can make the recipe refuse or read wrong bytes from NEMAR's own hosts, which `index_sha256` and the recorded hosts expose. The rule lives in nemar-process `docs/recipes.md`; R0's reader ADR restates it when private reads need a no-network container (R3, R4), and ADRs 0121 and 0122 are unchanged.
A recording the QC skipped is a counted refusal in the outputs, never a silent hole; QC ships later as sample-aligned masks (Q2); derived products carry `GeneratedBy` and `SourceDatasets` with the version DOI and a citation string (V1).

### 2.7 What changes in ADR 0118's model

| Item | Change |
|---|---|
| `compute_jobs` | `executor`, `accounting`, `runner_backend`, `runner_id`, `runner_claimed_at`, `lease_id`, `lease_expires_at`, `claim_attempts`, `runner_remote_id`, `runner_wall_seconds`, `runner_cpu_seconds`, `runner_max_rss_mb` |
| New tables | `compute_runners`, `compute_runner_tokens` |
| Words | executors, backends, accounting classes, runner refusals, `runner_lost` with details `lease_expired`, `claims_exhausted`, `deadline_exceeded`, `runner_revoked` |
| Ledger | none for `accounting = 'none'` (D6); a dated pointer amendment to ADR 0118 names ADR 0121 against decision 3 and the A3 amendment's item 1 |
| Unchanged | states, transitions, digests, records, retention, verification, the Tapis lifecycle, ACCESS for `su` jobs |

A result is reproducible from (image digest, launch specification, input snapshot) with no runner and no Tapis; each job records its runner's registration facts (site, trust, capacity) as host facts.

### 2.8 Numbers

ADR 0120 is held for the collaborator's reader epic (DM-03 makes `test/adr-index.unit.test.ts` tolerate the gap); this program takes **0121 onward** in landing order: 0121 and 0122 (DM-03), 0123 (V1), then R0's reader ADR (0124 unless a fetch shows otherwise once V1's PR merges), then Z0's on resumption; draft PR #1641 also takes "the next free number", so whichever lands second renumbers.
Migrations: `dev` is at 0130, #2116 holds 0131, 0132 and 0134, #2121 P3 plans 0136; this program takes **0140 to 0149** and adds no column P3 adds.

### 2.9 The nemar-process continuation track (owner instruction, 2026-11-13): eegprep-lean, pAMICA, signalJourney

**State, read 2026-11-13.** nemar-process `main` is still its initial commit; the C epic `feature/issue-1-epic-process` (draft PR #17 into `main`) holds C1 to C3 and C4a as squash commits: nemar-floor (C3, PR #11, `f99a585`) and nemar-ica's groundwork (C4a, PR #15, `54fa746`: hooks, exits 8 and 9, the matrix writer).
`feature/runner-epic` was cut at the epic's head `ad5f4c6` and is identical to it; nothing has merged into it yet (PR #20, DM-09, is open against it).
C4 itself (issue #5) still needs: ASR with its state saved (`asr_calibrate`/`asr_process`), `pop_reref`, ICA through `eegprep.pop_runica(icatype='pamica')` (absent from eegprep 0.5.0), `pop_iclabel`, weight files written `%.17g`, a CPU fallback `amica15` pinned by digest, a CUDA image flavor (`torch==2.8.0` cu128 for sm_70), signed images and operator steps; issue #16 (resume after a time budget) is open.

**State, read 2026-11-14 (after PX-03 and PX-04).** sccn/eegprep `develop` holds PX-03 (PR 617, merge commit `edf694c8`), PX-04 (PR 621, `73daa6a0`) and eegprep-lean (PR 616, `af914512`); PyPI's newest eegprep is still 0.5.0, eegprep-lean is not on PyPI, and `develop` still says `0.5.0`.
`feature/runner-epic` holds PX-06 (both flavors carry `amica15`; the CUDA flavor's torch is 2.12.1 from cu129, Q33, which replaces the cu128 line above), PX-07, PX-10 and L2.
No eegprep release is decided (the owner's QA remark, 2026-11-14), so nemar-ica pins eegprep at `edf694c8` and every eegprep version text names the commit (`eegprep@0.5.0+<commit>`): the bare `0.5.0` would give two eegprep builds one engine string, one stamp tuple and one derivative key. A later release moves the pin (PX-05 item 9).

**One canonical branch (lead decision).** From now on every nemar-process PR, C4 included, targets `feature/runner-epic`; `feature/issue-1-epic-process` is frozen at `ad5f4c6` and takes no new PR.
Convergence: the owner merges PR #17 into `main` with a merge commit (never a squash: a squash would give `main` copies of commits that `feature/runner-epic` already holds, and the second merge would conflict or duplicate), then `feature/runner-epic` into `main` with a merge commit; if anything did land on the frozen branch, the manager first merges it into `feature/runner-epic` with a merge commit (risk K18, Q13).

**How the parts fit.**
- *Reader:* recipes read NEMAR's Zarr through eegprep-lean (`load_recording`, `to_eeg`, `to_mne_raw`; sccn/eegprep PR #616 into `develop`, the owner's repository and not a blocker; the image pins the PR head commit and moves to the `develop` merge commit afterwards, then to a release). Engine transport and private reads come with the R-track (D11).
- *nemar-floor and nemar-floor-zarr:* QC on BIDS or Zarr input; Q0 converges them into one recipe with the input kind as an argument.
- *nemar-ica (C4):* ASR, re-reference, ICA, ICLabel, all called upstream in eegprep (recipes hold no numerics, `test_upstream_first.py`). ICA uses pAMICA through eegprep's new `icatype='pamica'` (PX-03), not through a recipe import: the recipe never imports pamica or torch.
- *pAMICA as the AMICA engine:* the torch engine (pure wheel, already in the CPU image) runs CPU float64; CUDA float64 runs in the CUDA flavor (PX-06); CPU float64 with one thread is bit-reproducible for a fixed seed on one machine (pamica's promise, as eegprep states and tests it), and pAMICA's README says the same of CUDA float64, unmeasured until the pAMICA workstream's PA-07, so a CUDA record states `bit_reproducible` null. The native `amica15` from pAMICA's release (sha256-checked, at `/opt/amica/amica15`) is the CPU fallback; it reads a `seed` line when its parameter file has one (pAMICA 0.3.1) and otherwise starts from the clock, and nemar-ica writes none (seeding it, and its parity with the torch engine, are the pAMICA workstream's), so a fallback run is not bit-reproducible, and its records say so (PX-05). Threads stay 1 (the recipes' determinism rule) unless PX-01 measures identical output across thread counts, and even then a larger count is reproducible only on the measured host. Memory scales with `block_size` (131072 per issue #5); PX-01 measures it before any recipe card.
- *Equivalence check E1 (pre-registered 2026-11-13 as a gate; informational since the owner's answer to Q31, 2026-11-14):* on EEGLAB's sample `eeglab_data.set`, `n_models=1`, `n_mix=3`, `max_iter=2000`, float64, 1 thread, each engine through `pop_runica` with eegprep's defaults, PX-03's test prints the Hungarian-matched absolute correlations between the sensor-space unmixing rows of pAMICA (seed 5489) and EEGLAB's AMICA (`runamica15`, the binary eegprep ships) and their Amari distance, and asserts nothing about them.
  Reference values, kept from the gate and no longer a pass condition: minimum at least 0.95, median at least 0.99, Amari distance at most 0.05 on the test's scale.
  Why informational: the binary seeds its random start from the clock (`amica15.f90` mixes `system_clock` into a fixed seed and reads no seed from its parameter file), so one PR head (sccn/eegprep#617 at `6439dd27`) with the same deterministic pAMICA printed `min=0.9966 median=1.0000 amari=0.0473` on one macOS run and `min=0.5339 median=0.9842 amari=0.9963` on its rerun; its CI E1 job printed `min=0.9995 median=1.0000 amari=0.0218` on head `55ec52ff` and `min=0.5262 median=0.9365 amari=1.6478` on the final head `53ca8a3d` (merged as `edf694c8`).
  On this 32-channel sample (about 30 frames per squared channel) EEGLAB's AMICA disagrees with itself about as much, and so do two pAMICA seeds (min 0.52, median 0.98, measured 2026-11-14; PR 617 measured min 0.526, median 0.936, Amari 1.51 with eegprep's merged defaults).
  The owner (Q31): "That is the pamica's promise, we accept it as is, but mention that it is done via pamica, and also mention which pipeline of pamica, to make the reproducibility possible".
  So the decomposition is pAMICA's claim, not an agreement with AMICA: every document and record that presents one names pamica as the engine, with its version, backend and pipeline, every setting and the seed, and claims no agreement with AMICA beyond E1's informational line.
  Anchor correction: the "about 0.997 and 0.006" first cited here come from pAMICA's runs with Newton off (its paper, 2000 iterations) or at 100 iterations (its test), with the Amari distance on pAMICA's own scale (both directions averaged, normalized by 2n(n-1)), about 31 times smaller at 32 channels than the scale of eegprep's test.
  Same-seed parity of pAMICA's torch and MPS engines with the Fortran binary pAMICA ships is now the pAMICA workstream's goal (owner, 2026-11-14; plan pack `.context/plans/pamica-fixes/`); once it exists, E1 may return as a gate in eegprep against pAMICA's own shipped binary on the shared seed, by a new owner decision.
- *signalJourney:* one dataset-level document per run (plus the per-recording documents nemar-floor already writes), schema 0.1.0 vendored in `recipes/nemar_process/_vendor/signalJourney/` with its tree SHA-256 and validated through `nemar_process.sj.validator()`; the validator is a git-pinned dependency because signalJourney#6 (package the schema, publish to PyPI) is open. PX-02 fixes #6 upstream; PX-07 then moves the pin to the release and keeps the vendored copy only as a drift reference until the packaged schema's SHA-256 matches. #7 (checksums), #8 (the `nemar` namespace) and #9 (validator gaps) stay upstream items.

**What each recipe records** (in `extensions.nemar`, beside what nemar-floor records today: plan hash, engine, seeds, image digest, output SHA-256): nemar-floor-zarr adds the Zarr input block and the commit attestation (DM-13); nemar-ica adds `EEG['etc']['pamica']` whole, as eegprep writes it (pamica and torch versions, backend `AMICATorchNG`, pipeline `pamica.AMICA(backend='torch').fit`, device, dtype, seed, `n_models`, `n_mix`, `max_iter`, `block_size`, threads, `pcakeep`, rank, the mapped settings, iterations, stop reason, `did_converge` from the stop reason, log-likelihoods; E1, Q31), `reorder`, `bit_reproducible`, the device facts and the GPU's name, the ASR state's SHA-256, ICLabel's version and weights SHA-256, and the input profile; its product is a derivative the platform keys (ADR 0123), never the recipe.

**Verified and unverified.** Verified by reading: the image installs `pamica==0.4.0` as a pure wheel with CPU torch and no compiler; pAMICA's release ships `amica15` binaries with `.sha256`; the schema is vendored by tree SHA-256. Not verified: pAMICA build time and memory in the image, thread determinism, the native binary's glibc fit in `python:3.12-slim` (PX-01); E1 beyond informational runs that disagree from run to run (two macOS and two CI runs of PX-03; EEGLAB's binary is clock-seeded); any GPU run (no GPU host has run one); CUDA out-of-memory handling beyond class names; signalJourney wheels loading packaged schema (PX-02).

**Demo relevance: none.** No PX step is shown on Sunday; PX-01 and PX-02 run now because they touch nothing the F2 path needs (lead ruling of 2026-11-13), PX-03 follows PX-01, and none touches a file of DM-09, DM-11 or DM-13.

## 3. Demo track (Sunday 2026-11-15)

### 3.1 What can be said

Plan of record (F2): "NEMAR's QC recipe, built on eegprep, ran in a container identified by its image digest on a lab workstation over a real public EEG dataset, streaming the recordings from NEMAR's Zarr serving copy with no dataset download and nothing kept on disk, and wrote QC tables with signalJourney provenance; the same recordings open in mne-python. QC ran on NEMAR's Zarr serving copy (EEG capped at 250 Hz, 16-bit; the serving copy of this dataset is at 200 Hz), not on the archived recordings. The pull-based runner and its queue are built and tested against NEMAR's real control-plane code; they are not yet deployed."
If DM-14 took path A, add "built and signed in CI"; under path B say "operator-built from source commit <sha>, unsigned".
If F1 exists, add: "A recorded run shows the runner on the lab workstation claiming the job from NEMAR's control plane, running locally and not deployed, and completing it."
Never say or imply: runs on HPC unchanged, the runner verified a signature, private data, EEGLAB support, EEGDash integration, derivatives published or citable, catalog-scale throughput, built in CI (unless path A happened), a consolidated NEMAR reader, that the EEG was resampled to 250 Hz, or that the archived recordings are at 200 Hz or at any other stated rate (their own rate was not checked).
Input provenance (`index_sha256`, `bytes_read`) is written by the recipe and not verified by the platform; G6 proves schema validity only.

### 3.2 Gates (pre-registered)

| Gate | Literal check | Threshold |
|---|---|---|
| G1 probe | `probe-findings.md` from DM-01, and DM-14's step C1 | a demo workstation is named, and it runs the digest-pinned test container as the owner's login |
| G2 control plane | on the nemar-cli epic head: `bun test backend/test/compute-runner-registry.test.ts backend/test/compute-runner-end-callers.test.ts backend/test/compute-runner-jobs.test.ts backend/test/compute-runner-queue.test.ts backend/test/compute-local-stack-runner.test.ts test/admin-compute-runners-cli.test.ts`, `bun run typecheck`, `bun run lint`, `bun run migrations:d1-check` | all pass |
| G3 runner | `uv run pytest tests/runner -q`, and the CI job of DM-18 running `tests/e2e/test_runner_stack.py` | pass; the CI job ran, not skipped |
| G4 image | path A (plan of record): `crane digest` equals the record's digest and `cosign verify --certificate-identity-regexp '<the workflow's SIGNING_IDENTITY>'` passes; path B (fallback): the image id equals the record's digest and `LABEL.txt` names the source commit | as stated |
| G5 live run | `TEST_API_URL=http://127.0.0.1:8787 bun run src/index.ts admin compute jobs record <job> --json` | `finished`, `executor` `runner`, `runner_backend` `local`, `image_digest` as in G4, within 45 minutes of dispatch |
| G6 provenance | `uv run --group signaljourney python scripts/validate_signaljourney.py <file>` | exit 0 |
| G7 discard | on the demo workstation: `find "$RUNNER_ROOT/jobs" -mindepth 1 | wc -l` | `0`, and `scratch_discarded job=<job>` in the runner log |
| G8 reader | DM-19 step 5's one-liner | `nchan` and `sfreq` equal the index's values |
| F2-a | DM-19: the manual container run on the demo workstation exits 0, its signalJourney passes G6, its output directory is deleted and `test ! -e` confirms | all |
| F2-b | DM-19: G8 on the operator's machine | as G8 |
| F2-c | DM-19: the merged cards' G2 and G3 test runs, recorded | each recorded run passes |

### 3.3 Cut line (dropped first, in order)

1. The Docker backend (DM-10), unless DM-01's verdict for the demo workstation is `docker` or `podman`.
2. The second workstation.
3. The `ssh -R` path: the stack would run on the demo workstation's loopback, which needs Bun installed there (a separate owner decision); without it, F1 is dropped.
4. The signed CI image (Q3, decided A: the owner merges to `main` and CI signs): if no signed digest verifies by 2026-11-14T08:00, the operator-built unsigned image (path B), labeled with source commit and image id; if B is not on the workstation by 2026-11-14T12:00, F3.
5. The live run: F1 (recorded) if it exists by 2026-11-15T05:00, else F2 alone (the plan of record).

Never dropped: `AGENTS.md`'s hard rules, the no-mocks rule, a digest-identified image (except F3, labeled), signalJourney provenance, scratch discard, the labels, and the converter's lock, ledger and scratch left untouched.

### 3.4 Fallbacks

- **F2 (plan of record):** F2-a, F2-b, F2-c and the architecture slide; the manual run is labeled "manual run, not dispatched by NEMAR"; an unsigned image is labeled as such.
- **F1 (only if it exists):** the first G5 pass, recorded end to end and labeled with its time and commits.
- **F3 (if no container ran by 2026-11-14T12:00, or Q12 is not answered yes):** the recipe in a uv environment on the operator's own machine, labeled "on the operator's machine, outside a container".

### 3.5 Schedule (Pacific)

The control-plane chain is about 34 hours (DM-04 4 h, DM-05 6 h, DM-06 6 h, DM-07 8 h, DM-17 2 h, DM-18 2 h, plus review and merge on each), which is why F2 is the plan of record.
DM-06b (4 h plus one Opus review, F1 only) starts when DM-06 merges, beside DM-07 in another Sonnet slot; it lengthens the F1 path only if it is still unmerged when DM-07 merges, by the difference.

| Window | S1 nemar-cli chain | S2 nemar-process | S3 eegprep and docs | Operator, Opus | Owner |
|---|---|---|---|---|---|
| Fri 14:30-15:00 | | | | | approve plan; Q1 scratch paths; Q4; Q12 |
| Fri 15:00-20:00 | DM-04 | DM-09 | DM-12 | DM-01, DM-02 | |
| Fri 20:00-Sat 04:00 | DM-05 | DM-11 | DM-13 (after DM-12), DM-03 | Opus: DM-03, DM-05 | |
| Sat 04:00-08:00 | DM-06 | DM-11 review, DM-10 only if DM-01 says so | DM-08 (after DM-05) | DM-14 path A as soon as CI signs | merge PR #17 and `feature/runner-epic` (with DM-13) to `main` |
| Sat 08:00-12:00 | DM-06 review | | | 08:00: DM-14 path B if A has no verified digest; then DM-19 | |
| Sat 12:00-18:00 | DM-07 | DM-06b (nemar-cli, second slot) | DM-16 draft | Opus: DM-06, DM-11, then DM-06b; F3 at 12:00 if no container ran | |
| Sat 18:00 CP-GO | DM-07 review | | | log the pre-registered reading | |
| Sat 18:00-Sun 01:00 | DM-07 merge, DM-17 | DM-18 | | Opus: DM-07 | |
| Sun 01:00-05:00 | | | DM-16 final | DM-15 only if DM-18 is green by 03:00 (F1); CP-F | 05:00 rehearsal |

## 4. Full program (after the demo)

Outline steps are completed into cards at the checkpoint in the last column.
Hosts: `mgr` the manager's machine, `ws-a` and `ws-b` the workstations, `ci` GitHub Actions, `stg` staging, `prod` production.
Tiers: `w` worker, `wh` worker-hard, `lead`.

| ID | Repo | Goal | Acceptance gate | Depends | Files owned | Host | Tier | Card at |
|---|---|---|---|---|---|---|---|---|
| S1 | nemar-cli | A dev-owned compute fixture `nm099996` (a small public EEG dataset copy with its Zarr) is eligible outside production only | new `backend/test/compute-fixture-eligibility.test.ts` passes, including production refusing `nm099996` | DM-07 | `services/datasetId.ts`, `services/compute-pipeline-eligibility.ts`, `.rules/datasets-and-fixtures.md` | mgr | wh | CP-2 |
| S2 | nemar-cli | The epic reaches `dev`; staging runs a runner job end to end. Merge checklist against epic D (#2116), whichever lands second: `resolveRun(db, id, wanted, except, recipe)` keeps that parameter order with both sides' callers; `CANCEL_PENDING_FAILED_SQL` keeps `AND executor = 'tapis'` at top level, outside the partner OR; the `JOB_INSERT_SQL` pin is re-baselined from D's text; D's `ABANDONED_UPLOADS_SQL` and any new D selection of `created AND tapis_uuid IS NULL` gain `executor = 'tapis'`; then the predicate-regex and source-search tests run | full CI green on the epic PR; `bun test` of the predicate-regex tests passes after the D merge; a staging job on `nm099996` `finished` | S1, Q5 | epic PR | stg, ws-a | w | CP-2 |
| S3a | nemar-cli | Read-only list of everything `COMPUTE_ENABLED` opens in production with no Tapis secrets (person submit, holds, sweeps) | a list with file and line for each path, reviewed by the lead | S2 | none | mgr | lead | CP-2 |
| S3 | owner | Production runs runner jobs on real public datasets | 5 production runner jobs `finished`, zero `runner_lost` | S3a, Q6 | none | prod | owner | CP-3 |
| S4 | nemar-process | Runner as a user service; self-update only to a signed release, with an opt-out for machines of another institution | `uv run pytest tests/runner/test_service.py -q` | DM-18 | `runner/`, `deploy/runner/` | ws-a | wh | CP-2 |
| S5 | nemar-cli | One queue, two admission paths: P3's `admitted_at` and `runner_claimed_at` converge | P3's tests and `compute-runner-queue.test.ts` on one history | #2121 P3 | `compute-jobs.ts`, migration 014x | mgr | wh | CP-3 |
| S6 | nemar-cli | Reports show executor, accounting class, runner and runner-reported usage | new `backend/test/compute-runner-reporting.test.ts` | DM-07 | `compute-reporting.ts`, `src/commands/admin-compute-jobs.ts` | mgr | w | CP-2 |
| C1 | nemar-process | Docker backend if DM-10 was cut | DM-10's gates | DM-09 | DM-10's | ci | wh | CP-2 |
| C2 | nemar-process | The runner pulls the SIF by its ORAS artifact digest (read from the signed digests file of the image's release, so the launch specification is unchanged) and verifies the cosign signature of the OCI digest and of the SIF artifact before first use; `sif_pull` then defaults to true | `uv run pytest tests/runner/test_verify_image.py -q` with a signed and an unsigned image, and a moved tag refused | DM-18 | `runner/nemar_runner/image.py`, `docs/runner.md` | ci | wh | CP-2 |
| C4 | nemar-process | Podman supported: `podman create`, then `container inspect` of `.Mounts` and `.HostConfig.Devices` compared with the declared binds (any extra mount or device fails closed), then `start --attach`; the refusal of DM-10 is lifted only by this step | a launcher end-to-end test on a real rootless Podman host whose `containers.conf` adds a volume and a device: refused; with a clean configuration: runs | DM-10, a Podman host the owner names | `launcher/nemar_launch/run.py`, `docs/launcher.md`, ADR 0122's Podman sentence | named host | wh, Opus review | CP-3 |
| L1 | nemar-process | The launcher enforces `NEMAR_JOB_END_TIME` with its own timer (SIGTERM to the container's session, then SIGKILL after a grace) and starts its container child with `PR_SET_PDEATHSIG` on Linux, so no container outlives a dead launcher | `uv run --no-project --python 3.9 --with pytest --with jsonschema pytest tests/launcher -q` with a real child past its deadline and a SIGKILLed launcher | DM-18 | `launcher/nemar_launch/run.py`, `docs/launcher.md`, `docs/runner.md` | ci | wh, Opus review | CP-2 |
| V1 | nemar-cli, docs | The derivative store of D14 with retention class, citation fields and optional DOI | an ADR item accepted by the owner (Q11), then the card's own gates | Q11 | named by the card from that ADR | mgr | lead | CP-3 |
| Q0 | both | One `nemar-floor` with the input kind as an argument on both executors; the stamp tuple grows for Zarr inputs | `uv run pytest tests/recipes -q`; `bun test backend/test/compute-pipeline-dispatch.test.ts` | DM-07, DM-13 | `shared/compute-recipes.ts`, recipes, migration 014x | mgr | wh | CP-2 |
| Q1 | nemar-process | `nemar-ica` (nemar-process#5) on a GPU runner | its issue's gates; one job `finished` on a GPU runner | Q0 | per #5 | ws-a or ws-b | wh, Opus review | CP-3 |
| Q2 | nemar-process | Per-dataset QC summary and sample-aligned masks | `uv run pytest tests/recipes/test_aggregate.py -q` | Q1 | `recipes/nemar_process/aggregate.py` | ci | w | CP-3 |
| PX-01 | none (probe) | pAMICA in the nemar-python image: build time, compiler and GPU needs, CPU float64 time, memory, thread determinism, the native binary's fit | card PX-01 | none | none | mgr | w | written |
| PX-02 | signalJourney | signalJourney#6: packaged schema, unresolved `$ref` refused, logging, publish workflow | card PX-02 | none | per card | mgr | wh | written |
| PX-03 | sccn/eegprep | `pop_runica(icatype='pamica')`, named as pAMICA's, with the informational check E1 | card PX-03 | PX-01 | per card | mgr | wh, Opus review | written |
| PX-04 | sccn/eegprep | ASR returns and reloads its state (`clean_asr(return_state=True)` or `asr_calibrate` state), so nemar-ica can record it | `uv run --no-sync pytest tests/test_asr_state.py -q`: reloading the state gives `numpy.array_equal` output | DM-19 | eegprep ASR modules | mgr | wh | CP-2 |
| PX-10 | nemar-process | Every record names the nemar-process release (`extensions.nemar.process`), the image tag and digest; the image workflow refuses a version that is not the commit's release | card PX-10 | none | per card | ci | wh, Opus review | written |
| PX-05 | nemar-process | nemar-ica (C4, issue #5) on the nemar-process integration branch (`dev` once REL-1 created it): ASR, re-reference, `icatype='pamica'`, ICLabel, `%.17g` weight files, the recorded fields of section 2.9 | `uv run --frozen --group runtime --extra cpu pytest tests/recipes -q`, and an informational E1R line (printed, never asserted) on one real recording | PX-03, PX-04, PX-10, DM-13 merged | `recipes/nemar_process/nemar_ica/`, `pyproject.toml`, `uv.lock` | ci | wh, Opus review | CP-2 |
| PX-06 | nemar-process | CUDA image flavor and the `amica15` CPU fallback pinned by sha256, both signed from `main` | the image workflow's smoke test of both flavors; `nemar-recipe version` lists pamica and the binary's sha256 | PX-01, PX-05, the owner's merges to `main` | `images/nemar-python/`, the image workflow | ci | wh | CP-2 |
| PX-07 | nemar-process | The validator from the released signalJourney package; the vendored schema kept only as a drift reference | `uv run pytest tests/recipes -q`; a drift test comparing the packaged and vendored schema SHA-256 | PX-02 released by the owner | `pyproject.toml`, `uv.lock`, `recipes/nemar_process/sj.py` | ci | w | CP-3 |
| PX-08 | nemar-process | The eegprep-lean pin moves from PR #616's head to its `develop` merge commit, then to a release | `uv lock --check`; DM-13's network test | #616 merged by the owner | `pyproject.toml`, `uv.lock` | ci | w | CP-2 |
| PX-09 | nemar-process | Resume or replace after a time budget (issue #16) | its issue's three boxes | PX-05 | per #16 | ci | w | CP-3 |
| Z0 | nemar-cli | Z0's ADR, the next free number on resumption (supersedes 0029, 0033, 0101; fidelity profiles; reproducibility contract; promote mechanism) proposed | `bun test test/adr-index.unit.test.ts` | CP-F | `.context/decisions/NNNN-*` (that number) | mgr | lead | CP-F |
| Z1 | nemar-cli | Formats contract file read by the gate and the converter, no behavior change | `bun test test/zarr-gate-superset.unit.test.ts`; `uv run --no-project --with pytest pytest scripts/zarr/test_generate_zarr.py -q` | Z0 | `shared/contract/zarr-formats.json`, `scripts/zarr/generate_zarr.py` | mgr | wh | CP-F |
| Z2 | nemar-process | `nemar-zarr` image and recipe; converter copied with its source commit; pin and privacy-floor drift test over all mirrors | `uv run pytest tests/zarr tests/contract/test_zarr_pin_drift.py -q` | Z1 | `zarr/`, `images/nemar-zarr/` | ci | wh | CP-3 |
| Z3 | nemar-cli | The promote mechanism CP-F chose, at scale | a test promoting 25,000 objects within the subrequest allowance and refusing a digest mismatch | Z0 | named by Z0 | mgr | wh, Opus review | CP-3 |
| Z4 | nemar-cli | ADR 0033's stamp and requeue block as D1 pipeline stamps, seeded "declared current" | `bun test backend/test/zarr-stamps-migration.test.ts`; a 26-row bump blocked without acknowledgement | Z0, Z3 | migration 014x, `compute-pipeline.ts` | mgr | wh, Opus review | CP-3 |
| Z5 | nemar-process | Shadow conversion of 20 datasets including the 3 largest and every format matches the cron's | `uv run python scripts/compare_shadow.py --report`: 20 of 20 identical modulo timestamps | Z2, Z3, Z4 | `scripts/compare_shadow.py` | ws-a | wh | CP-3 |
| Z6 | both | Cutover per dataset, then the cron retired and nemar-cli's converter deleted (gate, schemas and `patch_duration.py` resolved) | 7 days with zero cron conversions and zero pipeline failures the cron would have converted | Z5, Q7 | `scripts/zarr/`, `scripts/patch_duration.py` | ws-a | wh | CP-4 |
| R0 | nemar-cli | `feature/reader-epic` is cut from the collaborator's PR #2144 head (section 2.5 mechanism), CI runs on it in the organization, one Opus review of her code is posted on #2144, R0's reader ADR is proposed (the next free number once V1's PR merges: 0124 unless a fetch shows otherwise) | her test files (`bun test test/zarr-*.test.ts backend/test/zarr-core-*.test.ts`) pass on `feature/reader-epic`; `git merge-base --is-ancestor <her head> origin/feature/reader-epic` succeeds | CP-2 | `.context/decisions/NNNN-*` (that number) only; her files untouched | mgr | lead | CP-2 |
| R1 | sccn/eegprep | eegprep-lean engine transport; one conformance suite for the three readers | `PYTHONPATH=src uv run --no-sync --project ../.. pytest tests/test_engine_transport.py -q` byte-equal to the golden | R0 | `packages/eegprep-lean/` | mgr | wh | CP-3 |
| R2 | sccn/eegprep | EEGLAB reads NEMAR Zarr (`pop_nemarzarr`) | a matlab-batch parity test equal to the golden | R0 | EEGLAB plugin | ci | wh | CP-4 |
| R3 | both | Launch specification v2 `zarr` inputs: the launcher stages and records what is read | both repositories' contract drift tests and a launcher test | R0, Q0 | `compute-launch.ts`, launcher | mgr | wh, Opus review | CP-3 |
| R4 | nemar-cli and the private repo | The design goal: one reader reads public and private data by the authorization the person or job holds, through the authorization-aware Fetcher (D11); for runners, under Q9: a job-scoped grant, launcher-staged inputs, a no-network container, encrypted or memory-backed scratch, per-dataset permission, an access record | tests in both repositories through the real service-binding entrypoint: a person reads a private dataset they may read and is refused one they may not; a key never reaches an unlisted origin | R0, R3, Q9 | named at CP-4 | mgr | wh, Opus review | CP-4 |
| R5 | docs | EEGDash and braindecode can read the stores; fixtures published | docs CI; eegdash/EEGDash#401 linked | R1 | docs | mgr | w | CP-4 |
| H1 | nemar-process | Runner backend `slurm`; `runner_remote_id`; accounting `su` with hold, settlement and ACCESS. Stop condition for the card: DM-07's rule "an expired lease with `started_at` NULL clears the claim" would strand a job that sits `queued` in a SLURM queue (claim cleared, state still `queued`); H1 does not start until the lead has decided how a queued `runner/slurm` job keeps or renews its lease (D2's open point) | `uv run pytest tests/runner/test_slurm_backend.py -q` against a real `slurmctld` in CI | DM-18 | `runner/nemar_runner/slurm.py` | ci | wh, Opus review | CP-3 |
| H2 | both | The same digest gives equivalent outputs on a workstation and a SLURM host | pre-registered tolerance per output with pinned thread counts | H1 | none | ws-a, HPC | w | CP-4 |
| W1 | docs | Public page docs.nemar.org/compute/portable-processing | docs CI; the `.md` mirror serves | S2 | nemarOrg/docs | mgr | w | CP-2 |
| W2 | docs | Gated runbook `admin/operations/workstation-runners` | docs CI; `nemar admin docs admin/operations/workstation-runners` reads it | DM-19 | nemarOrg/docs | mgr | w | CP-2 |

## 5. What I could not verify

1. Every workstation fact (DM-01 probes runtimes, user namespaces, cgroup delegation, SLURM, GPU, scratch, egress, TCP forwarding).
2. That the launcher runs under a runner with only the Tapis and SLURM variables replaced (read in nemar-process, not run).
3. Refuted by review and fixed: the image workflow publishes only from `main` or a tag (Q3).
4. That `zarr.nemar.org` serves eegprep-lean's and the runner's User-Agents (ADR 0049 recorded a 403 for `Python-urllib`).
5. That nemar-floor's steps accept a dictionary built from Zarr, and their memory on whole recordings.
6. Settled by review: eegprep's `origin/develop` is 0.5.0 and tag `v0.5.0` exists.
7. The collaborator's fork contents (read through the GitHub interface, not run).
8. The private tier's access mechanism (read, not run).
9. That the compute test harness runs long-lived outside `bun test` (DM-08 proves it or stops).
10. That D1 accepts the claim statement shape.
11. Confirmed by review: #2116's and P3's migrations add none of this program's columns.
12. Partly refuted by review: `JOB_INSERT_SQL` and `GATEWAY_USER_INSERT_SQL` are gated on the hold row, so DM-06 writes runner statements of its own.
13. Outbound HTTPS from HPC nodes, and whether a site allows a polling agent on a login node.
14. Confirmed by review: the signalJourney validator is a git dependency group with no command line; DM-13 writes the wrapper.
15. Whether an operator-built image's id passes the launcher and verification end to end as `image_digest` (DM-14 option B and DM-17 check it).
