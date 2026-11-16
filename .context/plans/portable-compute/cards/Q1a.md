# Card Q1a: The registry makes `nemar-ica` real, GPU-optional on the CUDA image, with the tuple of the image the owner published

Status: ready
Tier: worker
Timebox: M, 3 hours; escalate at 6 hours
Needs: none
Depends: Q0b, PX-05, Q1c; and the owner's published nemar-process release whose image has both flavors (PX-06) and contains PX-05 and Q1c, given by the manager as two live facts: the CPU and CUDA references by digest and that image's `nemar-recipe version` output
Branch: feature/pc-q1a-ica-registry
Worktree: $WT/nemar-cli-pc-q1a (base origin/feature/portable-compute-epic, containing Q0b)
Plan: .context/plans/portable-compute/plan.md, D6, D12, section 4 (Q1); ADR 0121 (a runner job's partition is a sizing label); `cp2-note-N.md` (on a runner, `resources.gpus` is a ceiling and the runner picks the device)
Review: Sonnet panel

## Goal

`nemar admin compute pipeline run nemar-ica --dataset <id>@<version> --executor runner` makes a GPU-optional runner job on the CUDA image (one GPU as a ceiling the runner may leave unused, sized so the CPU path fits), the registry's expected tuples of `nemar-ica` and `nemar-floor` are exactly what the published image reports and name no device, and a recipe whose image flavor is not configured is refused with a word, never sent with the wrong image.

## Context

- Read `shared/compute-recipes.ts` (after Q0b: `inputs`, `RECIPE_INPUT_EXECUTOR`; the `nemar-ica` placeholder), `backend/src/services/compute-runtime-image.ts` (`readRuntimeImage(env)` reads one `COMPUTE_RUNTIME_IMAGE`), the dispatch's `runtime_unavailable` path in `compute-pipeline.ts`, `backend/src/services/compute-runner-queue.ts` (a claim fits pool, cores, memory and GPUs), `backend/scripts/compute-local-stack.ts` (`--image`), and `test/compute-recipes.unit.test.ts`.
- The live facts' `nemar-recipe version` output names each recipe's version, the eegprep version, the flavor and the `amica15` digest (PX-06 item 5); the registry's `version` and `engine` must equal it or the first finished job holds the tuple (`registry_drift`). Under PX-05's eegprep commit pin (item 9) the eegprep version reads `0.5.0+` and the 40-hexadecimal commit, so both recipes' `engine` is `eegprep@0.5.0+edf694c8344b9c4c68672eac3acf9a819f1462a8` (54 characters, within the stamp's 64): copy it whole, never shorten it.
- Runner jobs are `accounting = 'none'` and refused as `su` (ADR 0121, D6); a runner job's partition only sizes it.
- The owner (2026-11-14): the workstations are shared and their GPU is often busy, so `nemar-ica` is GPU-optional: the Worker still counts `gpus: 1` against the runner's registration (the ceiling), and the runner (card L3) decides just before start whether the job gets the idle GPU or runs on the CPU; the recipe (PX-05, Q1c) records the device. The Worker and its claim are unchanged. Because the CPU is the default path, the job's minutes must fit the CPU run.
- The engine stamp, and so the registry's expected `engine`, never names a device (PX-05 as amended): a GPU run and a CPU run of one tuple are the same product within card Q1g's pre-registered tolerance, and a device in the stamp would hold the tuple as `registry_drift` whenever the runner chose the other device.

## Scope

- `shared/compute-recipes.ts`, `backend/src/services/compute-runtime-image.ts`, `backend/src/types/bindings.ts` (`COMPUTE_RUNTIME_IMAGE_CUDA?: string`), `backend/src/services/compute-pipeline.ts` and `compute-runner-queue.ts` (where the image is read), `backend/scripts/compute-local-stack.ts` (an `--image-cuda` option), `test/compute-recipes.unit.test.ts`, and a new `backend/test/compute-pipeline-flavor.test.ts`.
- Not `backend/wrangler-sccn.toml` (the owner sets `COMPUTE_RUNTIME_IMAGE_CUDA` where `COMPUTE_RUNTIME_IMAGE` is set), the ledger, the switches.

## Decided design

Settled:
1. `ComputeRecipe.flavor: "cpu" | "cuda"`; `nemar-floor` is `cpu`; `nemar-ica` is `cuda`, no longer a placeholder, `inputs: ["bids", "zarr"]`, `executors: ["tapis", "runner"]`, `version` and `engine` from the live facts, `partition: "gpu-shared"`, `nodes: 1`, `cores: 10`, `memoryMb: 32768`, `gpus: 1`, `minutes: 720`, `autoDispatch: false` (if the partition table refuses `memoryMb` 32768 for `gpu-shared`, use its largest allowed value and say so). `nemar-floor`'s `version` and `engine` also follow the live facts. A comment on the `nemar-ica` entry states the rule: on a runner, `gpus` is a ceiling the runner may leave unused (the job then runs on the CPU and its records say so), and `minutes` is sized for the CPU path; card Q1 measures it.
2. `readRuntimeImage(env, flavor)`: `cpu` reads `COMPUTE_RUNTIME_IMAGE` as today, `cuda` reads `COMPUTE_RUNTIME_IMAGE_CUDA`; unset or not digest-pinned is `runtime_unavailable` for that recipe only, with nothing claimed. Every caller that rebuilds a specification (`rebuiltSpec`) reads the flavor of the stamp's recipe.
3. The local stack takes `--image-cuda <reference>` and passes it as `COMPUTE_RUNTIME_IMAGE_CUDA`.
4. A test pins that each registry entry's `version` and `engine` equal the committed copy of the live facts' version output (`test/fixtures/nemar-recipe-version.json`, written from the manager's live fact; it holds versions and digests only), and that `nemar-ica`'s `engine` contains no device field (no `device`, and neither of the whole words `cuda` and `gpu`; a torch build label such as `cu128` is a version, not a device).
The implementer may choose: helper names.

## Acceptance

- `bun test backend/test/compute-pipeline-flavor.test.ts test/compute-recipes.unit.test.ts` passes: a runner dispatch of `nemar-ica` builds a launch specification with the CUDA reference and `resources.gpus` 1; with `COMPUTE_RUNTIME_IMAGE_CUDA` unset it is refused `runtime_unavailable` and writes no stamp while `nemar-floor` still dispatches; a registered runner in pool `gpu` with one GPU claims the job and a `cpu` runner with no GPU does not; the registry equals the fixture.
- Mutations, each failing a test: `cuda` reading `COMPUTE_RUNTIME_IMAGE`; `nemar-ica` left with `gpus: 0`; `-cuda` appended to `nemar-ica`'s `engine`.

## Gates

- `bun run typecheck`, `bun run lint`, `bunx biome check` on the changed files, the Acceptance tests plus `bun test backend/test/compute-pipeline-input.test.ts backend/test/compute-runner-queue.test.ts backend/test/compute-local-stack-runner.test.ts`.
- Full `bun test`: not run, would check: the epic gate.

## Stop conditions

- The live facts are missing, or their version output lacks `nemar-ica`: stop; nothing is guessed.
- The version output's `nemar-ica` engine names a device: stop (a PX-05 defect; the registry never copies it).
- The change needs a binding in `backend/wrangler-sccn.toml`: stop.

## Report

At most 25 lines: PR, head, gates, mutations, the tuples written, deviations, and the owner's one setting (`COMPUTE_RUNTIME_IMAGE_CUDA` to the CUDA reference, where `COMPUTE_RUNTIME_IMAGE` is set).
