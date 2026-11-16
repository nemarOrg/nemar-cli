# Card Q1g: When the GPU is idle, one `nemar-ica` job runs on it through the runner, agrees with the CPU reference, and falls back cleanly on a real out-of-memory error and on contention

Status: ready (opportunistic: dispatch only when every Depends item holds; a postponement blocks no other card)
Tier: worker
Timebox: M, 4 hours; escalate at 6 hours
Needs: ssh:ws-b, network
Depends: Q1 (its CPU reference and evidence); the owner's answer to the CP-2 question QC (a GPU-capable Docker on workstation B); entry conditions: not before 2026-11-15T12:00-08:00 and the manager's record that the demo ended, and step 1's GPU idle check passes when the card starts; otherwise the card stops at step 1 having created nothing, and the manager tries again at most once a day
Branch: none (no repository change)
Worktree: $WT/nemar-cli-pc-q1g (base origin/feature/portable-compute-epic containing Q1a, read-only use; evidence in `<operator scratch>/q1g/`)
Plan: .context/plans/portable-compute/plan.md, section 2.9, section 4 (Q1); nemar-process issue #5 (determinism per device; across devices matched components at least 0.999, pre-registered); `cp2-note-N.md`

## Goal

On workstation B, while its GPU is idle and unreserved, the runner grants the GPU to a `nemar-ica` job (device `cuda`, reason `gpu_idle`, cap recorded); the job finishes with schema-valid records; its unmixing matrices match Q1's CPU reference with a matched correlation of at least 0.999 on every recording that ran on the GPU; a manual run with a tiny GPU memory cap falls back to the CPU on a real out-of-memory error and reproduces Q1's CPU product exactly; and a run in which a second process takes GPU memory moves its remaining recordings to the CPU, each recorded.

## Context

- The owner (2026-11-14): the GPU is usually idle, but busy whenever developers work (a deadline now). The GPU part is a bonus: this card may wait for days without failing the program, because card Q1 (the CPU path) is the recipe's acceptance on a runner.
- Idle means, over six samples five seconds apart: no compute process on the GPU, used memory at most 1,024 MiB, utilization at most 10 percent, and no reservation file; the runner's `gpu-check` (card L3) applies the same rule, and this card checks both.
- Workstation B stays untouched until the Sunday demo ends (about 2026-11-15T12:00 Pacific) and the manager records it; it is shared with other people's work, so the machine idle check of Q1 step 1 also applies.
- Live facts from the manager: as Q1 (`$WS_DEMO`, `$SCRATCH_B`, `$CPU_REF`, `$CUDA_REF`, `$RUNNER_EPIC_COMMIT`), plus `$Q1_EVIDENCE` (Q1's evidence directory with `out/` and `cpu-reference.sha256`) and the CUDA flavor's architecture list from the release's digests record. Set `Q1G_ROOT="$SCRATCH_B/q1g"`.
- Not known: whether `nvidia-smi` lists other accounts' compute processes to the runner's account. If step 1 ever shows memory in use with no compute process listed, record it (counts only) as a finding for L3's rule.
- Q9: public data only; the stack is a local test stack, never staging or production.

## Scope

- Operator commands only. On workstation B: only `$Q1G_ROOT` and the Docker image `$CUDA_REF`; the only GPU processes are this card's own containers, all removed by step 8; no `sudo`, no installs, nothing on the root filesystem.

## Decided design

Settled, in order (record each output under `<operator scratch>/q1g/`):
1. Idle checks. GPU: `ssh "$WS_DEMO" 'for i in 1 2 3 4 5 6; do echo "apps=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader | grep -c .) gpu=$(nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader,nounits | tr -d " ")"; sleep 5; done'`: idle only if all six lines show `apps=0`, used memory at most 1024 and utilization at most 10. Machine: Q1 step 1's command and rule. If either is busy: write `<operator scratch>/q1g/postponed.txt` with the time and the lines, create nothing on workstation B, and report "postponed: GPU busy" or "postponed: workstation B busy" (not a failure).
2. Preflight: `nvidia-smi --query-gpu=name,compute_cap,memory.total,driver_version --format=csv,noheader`; `docker info --format '{{json .Runtimes}}'`; `docker run --rm --gpus 1 "$CUDA_REF" python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0), torch.version.cuda)"` prints `True` and a capability whose `sm_XY` is in the image's architecture list; otherwise stop (QC decides).
3. A fresh local stack (state `<operator scratch>/q1g/stack`) and tunnel as Q1 step 2; the runner as Q1 step 3 with root `$Q1G_ROOT` and NO reservation file; `gpu-check` prints `gpu0: idle`; register `gpu-2` with Q1's numbers.
4. Dispatch `nemar-ica` as Q1 step 4 and run the runner `once`. Gates: the record shows `finished`, executor `runner` and `image_digest` equal to `$CUDA_REF`'s digest; the outputs download; every signalJourney file validates; each `_ica.json` says `device` `cuda`, `device_reason` `gpu_idle`, `fallback` false, the GPU's name, `gpu_memory_cap_mb` equal to half the GPU's memory (L3's default), and the torch and CUDA versions; the runner log shows `device_chosen` with `cuda` and `gpu_idle`. If a person started work on the GPU mid-run, later recordings show `gpu_contended` on `cpu`: record it and go on (step 5 uses only the recordings that ran on `cuda`).
5. Agreement: for every recording that ran on `cuda`, the Hungarian-matched absolute correlations between the rows of its `_unmixing.tsv` and those of Q1's CPU product of the same recording have minimum at least 0.999 (pre-registered); record the minimum and median per recording and both runs' wall times.
6. Real out-of-memory fallback, only if step 1's GPU check passes again (else record the skip and its lines): a manual run of the same image on the first EEG store in the F2-a command form of the demo brief with `nemar-ica`, `--gpus device=` followed by the identifier `gpu-check` printed, and `--env NEMAR_DEVICE=cuda --env NEMAR_DEVICE_REASON=gpu_idle --env NEMAR_GPU_MEMORY_MB=64`, output under `$Q1G_ROOT/oom`; its `_ica.json` says `device` `cpu`, `fallback` true, `device_reason` `cuda_oom`; the SHA-256 of its `_unmixing.tsv` equals that store's line in `cpu-reference.sha256`.
7. Contention fallback, only if step 1's GPU check passes again (else record the skip): the same manual form over two stores with `NEMAR_GPU_MEMORY_MB` set to half the GPU's memory; when its log shows the first recording's fit started, start a holder `docker run -d --name q1g-holder --gpus device=<identifier> "$CUDA_REF" python -c "import torch, time; x = torch.empty(268435456, device='cuda'); time.sleep(3600)"` (1 GiB); after the run, `docker rm --force q1g-holder`; the records show the first recording on `cuda` and the later one on `cpu` with `gpu_contended`, and the dataset record's `fallbacks` names it.
8. Cleanup: `bun run src/index.ts admin compute runners revoke gpu-2`; stop the runner, the tunnel and the stack; delete the stack's state; `ssh "$WS_DEMO" "docker rm --force q1g-holder 2>/dev/null; rm -rf '$Q1G_ROOT'"`; write `<operator scratch>/q1g/README.txt` (commits, digests, job id, times, gate outputs, the agreement numbers, the fallback results or their skips, the label "local stack, not staging or production").
The implementer may choose: nothing else; a failed step stops the card.

## Acceptance

- Step 4's gates and step 5's minimum of at least 0.999 for every recording on `cuda`, each quoted; step 6's equal SHA-256 and `cuda_oom` record, and step 7's `gpu_contended` record, each quoted or recorded as skipped because the GPU was busy (a skipped step is the only part a later dispatch of this card repeats).

## Gates

- `test -s <operator scratch>/q1g/README.txt` and `ssh "$WS_DEMO" "test ! -e '$Q1G_ROOT' && ! docker container inspect q1g-holder >/dev/null 2>&1 && echo clean"` prints `clean`.

## Stop conditions

- Step 1 finds the GPU or the machine busy: stop there, postponed (not a failure).
- Step 2 fails (no GPU runtime in Docker, or the architecture missing from the image): stop; the owner's QC answer decides what follows.
- Step 5's minimum is below 0.999: stop after cleanup and report both matrices' paths; the tolerance is never loosened.
- Step 6's SHA-256 differs from Q1's: stop after cleanup and report both files (a determinism finding for PX-05, the lead's).
- A compute process this card did not start appears on the GPU during steps 4 to 7: finish only the current step, start no other, clean up, and report.
- Anything would touch staging, production, a switch, a live dataset, the converter's directories, the demo image or DM-15's runner root: stop.

## Report

At most 25 lines: commits and digests, step 1's lines, step 2's GPU line, job id, gate outputs, the minimum and median correlation per recording, both wall times, the fallback results or skips, evidence directory.
