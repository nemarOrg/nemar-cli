# Card Q1c: nemar-ica caps its GPU memory, falls back to the CPU when the GPU fills or is contended, and every record says which device ran

Status: ready (after PX-05 merges)
Tier: worker-hard
Timebox: M, 4 hours; escalate at 6 hours
Needs: none
Depends: PX-05 (merged into `feature/runner-epic`); lands before the first nemar-process release that contains `nemar-ica`, otherwise it raises `RECIPE_VERSION` to 1.1.0
Branch: feature/issue-5-ica-device-fallback
Worktree: $WT/nemar-process-pc-q1c (base origin/feature/runner-epic, containing PX-05)
Plan: .context/plans/portable-compute/plan.md, D12, section 2.9 (E1, what each recipe records); nemar-process issue #5; `cp2-note-N.md`
Review: Sonnet panel plus one Opus review (provenance honesty: every per-recording record and the dataset record name the device, its reason and any fallback; a fallback never drops a recording, changes the engine or a parameter, or returns to the GPU; the job never grows past its GPU memory cap; torch is touched only for device facts, never for numerics)

## Goal

When `nemar-ica` runs on CUDA, it never takes more GPU memory than the cap the launcher passed; a CUDA out-of-memory error refits that recording on the CPU with the same parameters; another process taking memory on the GPU moves the remaining recordings to the CPU; and every per-recording record and the dataset record say which device ran each recording, why, and whether it was a fallback, so a GPU run, a CPU run and a mixed run are each fully described and none of them fails because of the GPU.

## Context

- The owner (2026-11-14): the GPU is a bonus and the CPU the default path; protect the people who share the GPU: cap the job's GPU memory, and treat an out-of-memory error or another process on the GPU as a graceful fallback to the CPU, recorded, never as a failure and never by growing into memory someone else started using.
- PX-05 (amended) resolves the device at start (`--ica-device auto` reads `NEMAR_DEVICE`, else probes) and writes `device_requested`, `device`, `device_reason` and `fallback`; this card adds what can happen after the start.
- Launcher-owned variables inside the container (card L3): `NEMAR_DEVICE`, `NEMAR_DEVICE_REASON`, `NEMAR_GPU_MEMORY_MB`. Outside a runner (Tapis, a manual run) none is set unless the operator sets it, and no cap applies without `NEMAR_GPU_MEMORY_MB`.
- Determinism: on the CPU, one seed and one thread count give identical output (PX-05 test 1), so a CPU refit of a recording equals that recording's CPU run in the same image byte for byte; on CUDA that is pAMICA's statement, unmeasured until the pAMICA workstream's PA-07, so PX-05 (amended) records `bit_reproducible` null for a CUDA recording. The GPU and CPU agree within the pre-registered 0.999 matched correlation (card Q1g), and every recording is pAMICA's output with the same seed and settings (its comparison with AMICA, E1, is informational since Q31), so a mixed-device dataset stays within that tolerance recording by recording.
- No machine a worker has holds a GPU: the decision rule and the record shapes are tested here on the CPU; the real out-of-memory and contention paths are proven by card Q1g's operator steps on workstation B (a tiny cap makes a real out-of-memory error). Never imitate a CUDA failure with a stand-in for eegprep, pamica or torch.

## Scope

- `recipes/nemar_process/common/device.py` (created by PX-05 as the only module under `recipes/` that touches torch; extended here with the memory cap, the error class and the contention reading, still never numerics); `recipes/nemar_process/nemar_ica/` (the per-recording loop and the records); `tests/recipes/test_upstream_first.py` only if PX-05's allowance needs widening to the same single module; new `tests/recipes/test_ica_device.py`; `docs/recipes.md` (the device section of `nemar-ica`).
- Not the launcher, the runner, eegprep, the engines' parameters, E1.

## Decided design

Settled:
1. **The rule** is a pure function `next_device(current, event)` over the devices `cuda` and `cpu` and the events `start`, `ok`, `cuda_oom` and `gpu_contended`: from `cuda`, `cuda_oom` and `gpu_contended` move to `cpu` for the rest of the job; `cpu` never moves. A move is recorded in the job's `fallbacks` list as the event and the recording's index and label.
2. **The cap.** On `cuda` with `NEMAR_GPU_MEMORY_MB` set, before the first fit: `torch.cuda.set_per_process_memory_fraction(min(1.0, cap_bytes / total_bytes), 0)`; recorded as `gpu_memory_cap_mb` (null without the variable).
3. **Out of memory.** A fit that raises an exception whose cause or context chain holds `torch.cuda.OutOfMemoryError` is followed by `torch.cuda.empty_cache()` and a refit of the same recording on `cpu` with identical parameters (seed, threads, float64, `max_iter`, `block_size`, rank); any other exception fails the recording exactly as PX-05 does. The error is recognized by its class, never by its message.
4. **Contention.** Before each recording's fit on `cuda`: `others = total - free - torch.cuda.memory_reserved(0)` from `torch.cuda.mem_get_info(0)`, compared with the same value measured right after the first CUDA initialization; growth above 256 MiB (a constant, recorded) moves that recording and every later one to `cpu` with `gpu_contended`. A fit in progress is never interrupted (no preemption in this version).
5. **Records.** Each `_ica.json` and its `extensions.nemar` hold `device_requested`, `device`, `device_reason` (the start reason of PX-05, or `cuda_oom` or `gpu_contended`), `fallback` (true when the recording ran on `cpu` under `device_requested` `auto`), `gpu_memory_cap_mb`, the GPU's name when `cuda`, `bit_reproducible` by PX-05 item 6's rule for the device that ran that recording, engine, eegprep, pamica and torch versions, `torch.version.cuda`, threads, dtype, and `image_flavor`; the dataset-level signalJourney record adds `devices` (the recording count per device) and `fallbacks`. The engine stamp never contains the device, so the registry tuple is the same on either device.
6. **Tests on the CPU.** The whole table of `next_device`; a real `torch.cuda.OutOfMemoryError` raised inside another exception is recognized, and a plain `RuntimeError` with an out-of-memory message is not; a run on the 8-channel, 60-second fixture with `NEMAR_DEVICE=cpu` and `NEMAR_DEVICE_REASON=gpu_reserved` writes `device` `cpu`, `fallback` true and `device_reason` `gpu_reserved` in every record and `devices` with only `cpu` in the dataset record, and its engine stamp equals that of a `--ica-device cpu` run; `test_upstream_first.py` fails when torch is imported anywhere else under `recipes/`.
The implementer may choose: the module's helper names, the record fields' order.

## Acceptance

- `uv run --frozen --group runtime --extra cpu pytest tests/recipes -q -m "not network"` passes, including `test_ica_device.py`.
- Mutations, each quoted and reverted: `next_device` lets `cpu` return to `cuda` (the table test fails); the device put into the engine stamp (the stamp test fails); torch imported in `nemar_ica/` (the upstream-first test fails).
- The real out-of-memory and contention paths: "not run, would check: card Q1g's steps 6 and 7 on workstation B".

## Gates

- `uv sync --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run ty check`, `uv lock --check`, the Acceptance command.
- The image workflow's pull-request run: not run, would check: CI on the PR.

## Stop conditions

- eegprep's `pop_runica` with `icatype='pamica'` wraps a CUDA out-of-memory error so that `torch.cuda.OutOfMemoryError` is not in the chain: stop and report it as an upstream item for sccn/eegprep (see PX-03's patch note); never match on message text.
- A step needs numerics in the recipe: stop.
- PX-05 as merged records the device in the engine stamp: stop and report it (a PX-05 defect for the lead).

## Report

At most 25 lines: PR URL and head, gates, mutations, the record fields as written, deviations, and a patch note for Q1a (`nemar-ica` 1.0.0 includes this card, or the version it raised to).
