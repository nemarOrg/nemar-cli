# CP-2 note, track N (shared workstations), 2026-11-14

Owner: the workstations are not dedicated to this work, so be nimble (pAMICA on the GPU if free, else the CPU); the GPU is usually idle except when developers work (a deadline now); the CPU is uncontested.
Every card below prints "ready to dispatch" and passes the leak check.

## Design

- **CPU first, lenient (L2).** Before each claim and again before start, the runner checks free memory minus a reserve (8 GiB or a tenth of RAM), free scratch, and load per CPU (at most 0.9); a `pause` file stops claims.
  A decline sends no claim, so the Worker counts nothing; a rare shortfall after a claim waits inside the lease, then abandons (one counted claim) and backs off 30 minutes.
  The registration stays the ceiling and the Worker is unchanged; runner and children run at niceness 19 and idle I/O, Docker jobs at `--cpu-shares 2`; no preemption in this version.
- **GPU opportunistic, conservative (L3, PX-05, Q1c).** The CPU is the default path, and no card's acceptance needs a free GPU (Q1 runs with the GPU reserved; Q1g waits for an idle one and may be postponed for days).
  Idle means six samples five seconds apart, each with no compute process, at most 1 GiB used, at most 10 percent utilization, and room for the cap plus 2 GiB.
  The job's GPU memory is capped (half by default); a CUDA out-of-memory error or another process taking memory moves it to the CPU for good, recorded, never failed.
  Anyone reserves the GPU with a file `gpu0` or `gpu-all` in a reservation directory (a shared one the owner creates); W2 documents it.
- **Accounting and provenance.** `nemar-ica` keeps `gpus: 1` as a ceiling the runner may leave unused; the decision reaches the recipe through three launcher-owned variables, with no contract change.
  Every record names the requested and chosen device, the reason, `fallback`, GPU name, cap, engine, torch version and threads; the device never enters the engine stamp (it would hold the tuple as `registry_drift`).
  E1 covers the CPU engine and Q1g's pre-registered 0.999 covers GPU against CPU, so mixed-device datasets stay within tolerance.

## Cards

Amended: **Q1** (CPU path with the GPU reserved; the CPU reference; no QC), **Q1a** (GPU-optional rule, CPU-sized minutes, no device in the engine), **PX-05** (`--ica-device auto`, device fields, torch only in `common/device.py`), **PX-06** (the CUDA image's CPU path smoke-tested), **PX-01** (idle check, `nice` build, busy watch), **S4** (units at `Nice=19`, idle I/O, weights 1), **S2S** (idle check by hand, quarter-RAM registration), **S2D** (L2, priority lines, busy and pause windows), **S0** (machine and GPU reading, starts nothing), **S3** (L2, ON, an eighth section), **W2** (etiquette, inventory line).

| ID | Title | Tier | Needs | Slot | Depends | Timebox | Review |
|---|---|---|---|---|---|---|---|
| L2 | Runner claims only idle capacity, lowest priority | worker-hard | | claude-sonnet | L1 | 6h | Opus, accounting, concurrency |
| L3 | GPU only when clearly idle, else CPU | worker-hard | | claude-sonnet | L2 | 6h | Opus, isolation, accounting |
| Q1c | nemar-ica GPU cap, CPU fallback, provenance | worker-hard | | claude-sonnet | PX-05 | 4h | Sonnet, Opus |
| Q1g | nemar-ica on an idle GPU, agreement, fallbacks | worker | ssh:ws-b,network | operator | Q1, QC; GPU idle | 4h | none |

Board: Q1 depends on Q1a, Q1c, L3, PX-06; S2D adds L2; S3 adds L2 and ON; S4 and PX-06 unblock; S2P round 2 should carry L2 and L3.
Order: S4, PX-06 now; L2 after L1, then L3; Q1c after PX-05 and before the owner's release, then Q1a; after the demo S0, PX-01, S2S; S2D after round 2; Q1, then Q1g when the GPU is idle; W2 now and after S2D, L3, ON; S3 after ON.
Patch note for **PX-03** (running): let `torch.cuda.OutOfMemoryError` propagate from `pop_runica(icatype='pamica')`, chained and never replaced, and record the device in `EEG['etc']['pamica']`.
L1, S1, S1R, S1a, C2W and S3a need nothing.

## The single-tenant assumption

A rootful `docker` group is root on its host: a member can mount `/`, read every account's files and the runner's secret, and forge outputs under a lease.
A job runs as the runner's uid without capabilities and cannot reach the socket, but an escape from a rootful container lands as root.
If other people have accounts on workstation B (likely, since developers work there), a standing, polling runner on a root-equivalent account extends a bad signed image or an escape to every account, which breaks ADR 0122 decision 6's premise.
The owner's login is already in the group (DM-01); what is new is the automated agent.

**ON: which container runtime does the production runner on workstation B use?**
A, Apptainer (Recommended): rootless, D8's primary, GPU through `--nv`, low priority inherited; needs Apptainer (an unprivileged install works where user namespaces are allowed) and cgroup delegation for enforced limits. S3: S2S and S2D repeat once under Apptainer on staging first.
B, rootless Podman after C4: needs Podman, sub-uid ranges and delegation (root steps) and a GPU follow-up. S3: waits for C4 and a Podman staging round.
C, rootful Docker, only if you confirm no other person has an account there or is in its `docker` group (W2 records it). S3: proceeds on today's evidence; residual: an escape or a bad signed image is root on that host.

## Proposed plan and risk changes

- D8 gains the shared-workstation and device rules; ADR 0121 dated note: on a runner `resources.gpus` is a ceiling, the device is recorded and never stamped, a decline is not a claim; ADR 0122 decision 6 awaits ON.
- 2.9: CPU default, GPU bonus, torch only in `common/device.py`; D14: the device is not in the derivative key; section 4: rows L2, L3, Q1c, Q1g.
- Follow-ups without cards: an uncounted runner give-back route (the Worker has `RELEASE_CLAIM_SQL`) if busy abandons spend claims; GPU under Podman or a CUDA SIF after ON.
- New risks (K20 to K24 are proposed twice, by notes S and Q, so the manager numbers these): contention on a shared machine (read at S2D, then weekly); the CPU path overrunning a job's minutes (read at Q1); `nvidia-smi` hiding other accounts' processes (read at S0, Q1g); busy abandons exhausting claims (read at S2D). Note S's rootful-Docker risk reads at ON.
