# Card P3a: open the geometry pull request and upload the subject surfaces

Status: ready
Tier: worker
Timebox: M, 1.5 days; escalate at 3 days or two failed approaches
Needs: none
Depends: P1 (merged)
Branch: feat/ieeg-geometry-p3a-pr-upload
Worktree: <worktree>-p3a (branch from `origin/epic/ieeg-geometry`)
Plan: plan.md rulings 26 and 27, owner decisions of 2026-11-20; step P3a

## Goal

`python -m ieeg_geometry pr <id>` opens one reviewable pull request on `nemarDatasets/<id>` with exactly the pipeline's outputs, and `python -m ieeg_geometry upload-surfaces <id>` puts the subject surfaces at `s3://nemar/<id>/zarr/geometry/`; `generate_zarr.py --wipe` no longer erases `geometry/`.

## Context

- Read P1 (`pipeline.py`, `fetch.py`, `__main__.py`), the report schema, plan rulings 26 and 27, and ADR 0001 (dataset changes go through pull requests). Existing PR-opening code to learn from, not reuse blindly: `src/lib/repull/execute/pull-request.ts` and `nemar admin revert` in `src/commands/admin.ts` (~3109-3340).
- The owner runs these from their own machine with their own `gh` login and AWS profile; nothing here runs in CI against real datasets.
- `generate_zarr.py --wipe` erases `<id>/zarr/` (~10510-10516); `--clean` already leaves non-store prefixes alone.

## Scope

`scripts/ieeg_geometry/ieeg_geometry/{pr.py,upload.py}` (new), `__main__.py` (two subcommands), tests and fixtures, README; `scripts/zarr/generate_zarr.py` (the wipe exclusion only) and its test. Nothing else.

## Decided design

Settled:
- `pr <id> [--version V] --workdir DIR [--dry-run]`: runs the pipeline with `--apply` on a fresh clone at the dataset's current `main`; refuses if any track errored, if the apply produced no changes, or if anything outside the report's `changes` list differs in the work tree; creates branch `nemar/ieeg-geometry-<pipeline version>`; one commit with a fixed message and the owner's git identity; pushes only that branch; opens the PR with `gh pr create` against `main`, title "Add NEMAR-computed iEEG geometry (pipeline <version>)", body listing every added file with its method and evidence grade, the counts, and links to `https://docs.nemar.org/data/ieeg-geometry/`; prints the PR URL. `--dry-run` does everything except push and open, and prints the body. Never merges, never force-pushes, refuses if the branch already exists on the remote.
- `upload-surfaces <id> --surfaces DIR [--profile P] [--dry-run]`: uploads `geometry/index.json` and the meshes under `s3://nemar/<id>/zarr/geometry/` (boto3 or the `aws` CLI, whichever the repo already uses for Python; say which), uploads meshes before the index, removes keys under that prefix the new index no longer references, never touches any other key, and refuses the protected ids.
- Both subcommands refuse `nm000103`-`nm000107` and `nm099998` (reuse P1's check).
- `--wipe` in `generate_zarr.py` deletes everything under `<id>/zarr/` except the `geometry/` prefix; a test pins it.

The implementer may choose: helper structure; how tests exercise git and `gh` (a local bare repo as the remote and a `gh`-compatible stand-in executable on PATH are fixtures, not mocks; never call the real GitHub or S3 in tests).

## Acceptance

- `uv run --project scripts/ieeg_geometry pytest -q` passes with tests that each fail without the code: the PR flow against a local bare remote (branch, single commit, only reported paths, refusal on extra diffs, existing branch, errored track, protected ids), the body content, the upload plan (order, removals, prefix confinement) against a local stand-in, and the wipe exclusion.
- A `pr --dry-run` on on004370 (network) prints a body you quote in the PR.

## Gates

`cd scripts/ieeg_geometry && uv run ruff check . && uv run ruff format --check . && uv run ty check && uv run pytest -q`, and the zarr test file you change; before every push; then the PR's CI.

## Stop conditions

- Opening the PR needs a token or permission the owner's `gh` login would not have (report it).
- The wipe change needs more than a prefix exclusion.

## Report

Your final message is the report, at most 25 lines: PR number (into `epic/ieeg-geometry`) and head commit hash; gates; CI; the on004370 dry-run body; revert checks; deviations; questions.
