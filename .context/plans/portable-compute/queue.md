# Queue: slots, order and collisions

Slots, not waves; the slot rows are in `runbook.md` Setup step 5 and are accepted with the plan.
`status` dispatches the first ready step that fits a free slot, in the order below; the Depends column is what it enforces.

## Dispatch order and Depends

| Order | Step | Tier | Needs | Depends (board) | Also waits on |
|---|---|---|---|---|---|
| 1 | DM-04 contract | worker-hard | | | |
| 2 | DM-09 launcher environment | worker-hard | | | |
| 3 | DM-12 eegprep-lean recording | worker | network | | |
| 4 | DM-01 probe | worker | ssh:ws-a, ssh:ws-b | | plan approval, Q1 scratch paths |
| 5 | DM-02 dataset | worker | network | | |
| 6 | DM-03 ADRs | worker-hard | | | |
| 7 | DM-05 registry | worker-hard | | DM-04 | |
| 8 | DM-11 runner build | worker-hard | | DM-04, DM-09 | |
| 9 | DM-13 recipe | worker-hard | network | DM-12 | |
| 10 | DM-06 runner jobs | worker-hard | | DM-05 | |
| 11 | DM-08 local stack | worker-hard | | DM-05 | |
| 12 | DM-10 Docker backend | worker-hard | | DM-09, DM-01 | seeded `blocked`; the DM-01 handler sets it `todo` or `dropped` |
| 13 | DM-14 image | worker | ssh:ws-a, ssh:ws-b, network | DM-13, DM-01 | the owner's merge to `main` (path A) or 08:00 (path B); Q12 for workstation steps |
| 14 | DM-19 F2 assets | worker | ssh:ws-a, ssh:ws-b, network | DM-14, DM-02, DM-12 | Q12 for workstation steps |
| 15 | DM-07 runner queue | worker-hard | | DM-06 | |
| 15b | DM-06b Zarr source check | worker-hard | | DM-06, DM-08 | runs beside DM-07 in another Sonnet slot; F1 only |
| 16 | DM-16 demo brief | worker | | DM-19 | updated again if DM-15 finishes |
| 17 | DM-17 stack runner flow | worker-hard | | DM-07, DM-08, DM-06b | |
| 18 | DM-18 runner in CI | worker-hard | | DM-11, DM-17, DM-06b | |
| 19 | DM-15 recorded run (F1) | worker | ssh:ws-a, ssh:ws-b, network | DM-01, DM-02, DM-06b, DM-14, DM-17, DM-18 | Q12; DM-18 green by 2026-11-15T03:00 |
| 20 | PX-01 pAMICA image probe | worker | network | | Docker on the manager's host; never while DM-14 path B or DM-19 uses an image on the same machine |
| 21 | PX-02 signalJourney#6 | worker-hard | network | | push access to signalJourney/signalJourney; the owner merges and releases |
| 22 | PX-03 eegprep `icatype='pamica'` | worker-hard | network | PX-01 | the owner merges into `develop` |
| 23 | REL-1 nemar-process release automation | worker-hard | network | | owner request; base `main`; the owner merges it; the manager then creates `dev` and its first `-dev1` commit as the card says |
| 24 | REL-2 signalJourney release process | worker-hard | network | | owner request; base `main` of signalJourney; the owner merges it and pushes `v0.2.0`; collides with PX-02 on `CHANGELOG.md`, `pyproject.toml` and the workflows if PX-02 is reopened (PX-02's work landed as PR #10, so run REL-2 instead of any PX-02 follow-up) |
| 25 | PX-10 release provenance in every record | worker-hard | network | | owner remark; nemar-process base `dev` (else `main`); collides with PX-05 on `recipes/nemar_process/common/` and with any image-workflow change: PX-05 after PX-10 merges, and no other card edits `image-nemar-python.yml` while PX-10 is open |
| 26+ | outline steps of plan section 4 (PX-04 to PX-09 included) | | | as in the plan | `outline` until their checkpoint |

With three Sonnet slots the first three dispatched are DM-04, DM-09 and DM-12; DM-01 and DM-02 take the operator slot and the next free Sonnet slot (DM-01 first, since it needs the operator slot only).
DM-01, DM-02, DM-14, DM-15 and DM-19 have no PR: "done" is the manager's verification of the quoted gates.

## Collisions

| Pair | Shared | Rule |
|---|---|---|
| DM-05, DM-07 | `backend/src/routes/compute-runners.ts`, `backend/test/compute-route-inventory.test.ts` | DM-07 after DM-05 (Depends, through DM-06) |
| DM-05, DM-06 | `backend/src/services/compute-tenant.ts` is DM-06's only; `backend/src/index.ts` is DM-05's only | DM-06 after DM-05 (Depends) |
| DM-06, DM-07 | `backend/src/services/compute-lifecycle.ts` (DM-06: selections and `jobView`; DM-07: terminal batch and settled stamp) | DM-07 after DM-06 (Depends) |
| DM-08, DM-06 | none in `backend/src`; `backend/test/helpers/*` is DM-08's only | may run together; DM-06 needing a helper change writes a patch note for DM-08 |
| DM-08, DM-17 | `backend/scripts/compute-local-stack.ts` | DM-17 after DM-08 (Depends) |
| DM-06, DM-06b | `backend/src/services/compute-pipeline.ts`, `shared/contract/compute-admin.ts`, `backend/test/compute-runner-jobs.test.ts` | DM-06b after DM-06 (Depends) |
| DM-08, DM-06b | `backend/scripts/compute-local-stack.ts`, `backend/test/compute-local-stack.test.ts` | DM-06b after DM-08 (Depends); DM-06b may add the new helper `backend/test/helpers/github-compare-standin.ts` (no other helper) |
| DM-06b, DM-07 | none: DM-07 owns `compute-runner-queue.ts`, `routes/compute-runners.ts`, `compute-outputs.ts`, `compute-lifecycle.ts`; DM-06b owns `zarr-source-check.ts` and the files above | may run together in two slots; the second to merge takes the base in and reruns its gates |
| DM-06b, DM-17 | `backend/scripts/compute-local-stack.ts` (fixture seeding) | DM-17 after DM-06b (Depends) |
| DM-09, DM-10 | `launcher/nemar_launch/codes.py`, `run.py`, `docs/launcher.md` | DM-10 after DM-09 (Depends) |
| DM-10, DM-18 | `.github/workflows/ci.yml` | may run together; the second to merge takes the base in and reruns its gates |
| DM-11, DM-13 | `pyproject.toml` (DM-11: pytest and ruff settings; DM-13: the `runtime` group) and `uv.lock` (DM-13 only) | may run together; the second to merge takes the base in and reruns `uv lock --check` and its gates |
| DM-11, DM-18 | `tests/contract/` pin files | DM-18 after DM-11 (Depends) |
| PX-01, any card | none: no repository change; it uses Docker and CPU on the manager's host | runs only after DM-19 (Depends); while a demo card's tests run on the same host, the manager waits rather than start it |
| PX-02, any card | none (signalJourney repository) | may run beside anything |
| REL-1, nemar-process cards (DM-10, DM-11, DM-18, PX-05) | `.github/workflows/ci.yml` (REL-1 adds `dev` to its push branches and an `actionlint` job); every later nemar-process PR targets `dev` once it exists | may run together; the second to merge takes the base in and reruns its gates; after `dev` exists, open nemar-process PRs are retargeted to `dev` by the manager (`gh pr edit <n> --base dev`) |
| PX-03, DM-12 | both sccn/eegprep: PX-03 owns `src/eegprep/functions/`, the root `pyproject.toml`; DM-12 owns `packages/eegprep-lean/`; both may change the root `uv.lock` | may run together; whichever the owner merges second takes `develop` in and reruns `uv lock --check` |
| PX-05, DM-11, DM-13 | `pyproject.toml`, `uv.lock`, `recipes/nemar_process/cli.py` | PX-05 (outline) after DM-13 merges (Depends) |
| PX-06, DM-14 | the image and its workflow | PX-06 (outline) only after the demo and the owner's merges to `main` |
| DM-03, the collaborator's reader PR, draft PR #1641 | `.context/decisions/README.md`, `test/adr-index.unit.test.ts`, the next ADR numbers | DM-03 never creates 0120; whichever lands second takes the next free number and the base, and reruns `bun test test/adr-index.unit.test.ts` |
| DM-01, DM-16 | `.context/plans/portable-compute/` | different files |

## Board seeding (Setup step 6)

For each row above, in order: `mb set B Steps <ID> Title="[<title>](cards/<ID>.md)" Tier=<tier> Needs=<needs> State=todo Depends=<depends> Timebox=<card timebox> --new`.
Exceptions: DM-10 `State=blocked` with Next "waits on DM-01's verdict"; DM-14 `State=todo` (its owner waits are in its card and the handlers); outline steps `State=outline`.
Questions: `mb ask B <ID> --question <text> --options "<A (Recommended)> / <B> / <C>" --default none --needed-by <time>` for each pending row of `open-questions.md`; the decided rows are logged with `mb decide <text> --by owner`.
