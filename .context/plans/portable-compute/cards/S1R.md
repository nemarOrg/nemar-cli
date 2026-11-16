# Card S1R: The Zarr recipe's allowlist gains the staging pair, and the runner epic takes `dev` in

Status: ready
Tier: worker-hard
Timebox: S, 3 hours; escalate at 5 hours
Needs: network
Depends: none; it runs before the processing lead's Q0 (its merge of `dev` into the epic is Q0's entry condition, and both touch the Zarr recipe's files)
Branch: feature/pc-s1r-staging-zarr-pair
Worktree: $WT/nemar-process-pc-s1r (base origin/feature/runner-epic)
Plan: .context/plans/portable-compute/plan.md, D12 (the recipe's fixed allowlist), section 4 (S1, S2)
Review: one Opus reviewer; focus: isolation, that no host is ever taken from data, that a data base is accepted only as the pair of the Zarr base the Worker passed, and that the socket fence still refuses every other host

## Goal

`nemar-floor-zarr` accepts NEMAR's staging Zarr host as a `--zarr-base`, and then only the staging data bucket's host as the index's `data_base` and as the one redirect target, so a staging runner job on the fixture `nm099996` can read its own environment's Zarr copy; production behavior is unchanged, and `feature/runner-epic` carries `dev`'s history (release automation, PX-10) from this card on.

## Context

- `recipes/nemar_process/common/zarr_hosts.py` (`ZARR_HOSTS`, `ZARR_DATA_HOSTS`, `ALLOWED_HOSTS`, the socket fence), `recipes/nemar_process/common/zarr_input.py` (`ZarrSource.open`, `GuardedTransport`, the one-redirect rule), `recipes/nemar_process/nemar_floor_zarr/recipe.py` (`--zarr-base`), and `docs/recipes.md` (the rule's prose).
- The staging hosts, by role (their literal names live only in code and its test, never in prose): the staging Zarr host is the `ZARR_HOSTNAME` of `[env.dev.vars]` in nemar-cli's `backend/wrangler-sccn.toml`; the staging data bucket's host is the virtual-hosted S3 name of that table's `S3_BUCKET` in its `AWS_REGION`, the same form as the production entry of `ZARR_DATA_HOSTS`. The staging Zarr host answers `index.json` itself and redirects store reads to that bucket.
- nemar-cli card S1 makes the staging Worker pass its own Zarr host as `--zarr-base`; the two cards are independent and both are needed for a staging job.
- `feature/runner-epic` is 3 commits ahead of and 19 behind nemar-process `dev`, and `git merge-tree --write-tree origin/feature/runner-epic origin/dev` reports no conflict (checked 2026-11-14).

## Scope

- `recipes/nemar_process/common/zarr_hosts.py`, `recipes/nemar_process/common/zarr_input.py`, `recipes/nemar_process/nemar_floor_zarr/recipe.py` (help text only), `docs/recipes.md`, and the tests under `tests/recipes/` that cover the allowlist and the fence.
- `RECIPE_VERSION` or `COMMON_VERSION` only if the repository's own rule says an allowlist change bumps them (read `docs/recipes.md`); never `pyproject.toml`'s version.

## Decided design

Settled:
1. First commit of the branch: `git merge --no-ff origin/dev -m "Merge dev into the runner epic"`, with no other change in that commit; the PR body says so, names that merge commit, and tells the reviewers to read `git diff <the merge commit>..HEAD` (this card's own change). The manager merges this PR into `feature/runner-epic` with `gh pr merge <n> --merge`, NOT `--squash`, so the epic takes `dev`'s history.
2. The allowlist becomes pairs, written in code: `ZARR_HOST_PAIRS = {<production Zarr host>: <production data host>, <staging Zarr host>: <staging data host>}`; `ZARR_HOSTS` and `ZARR_DATA_HOSTS` are derived from it, and `ALLOWED_HOSTS` stays their union for the socket fence.
3. A run is bound to one pair: `--zarr-base` must be `https://` plus a key of the pair map (exactly, no port, no path, no userinfo); the index's `data_base` must be `https://` plus that key's value; the one redirect allowed is to that value. Production base with the staging data host, or the reverse, is refused before any read with the existing refusal for an off-allowlist host.
4. signalJourney already lists the hosts contacted; add the chosen pair's name (`production` or `staging`) to the Zarr input block the recipe records.
5. Tests, against the existing request-recording stand-ins the recipe tests use: each pair accepted; each crossed combination refused; a base with a port, a path, upper case or userinfo refused; the fence refuses a host outside both pairs; production runs produce byte-identical records before and after, except the new pair field.
6. `docs/recipes.md`: the rule now says "a fixed list of host pairs, one per NEMAR environment"; the security argument of plan D12 is restated: the hosts are NEMAR's own and none comes from data.
The implementer may choose: the pair field's key name.

## Acceptance

- `uv run pytest tests/recipes -q` passes; mutations, quoted and reverted: accepting any data host of `ZARR_DATA_HOSTS` regardless of the pair fails the crossed-combination test; allowing a port fails its test.
- `git merge-base --is-ancestor origin/dev HEAD` succeeds, and `git log --first-parent --merges --oneline origin/feature/runner-epic..HEAD` lists exactly one commit, the merge of `dev`.

## Gates

- `uv lock --check`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run ty check --python-version 3.9 launcher observer runner`, `uv run pytest tests/recipes -q`; the leak check of `cards/README.md` on `docs/recipes.md`.
- The image tests (`tests/images`) and the full suite: not run, would check: CI on the PR.

## Stop conditions

- The merge of `origin/dev` conflicts: stop and report the paths (the inventory said none).
- A recipe other than the Zarr-input ones opens a connection after the change: stop.

## Report

At most 25 lines: PR into `feature/runner-epic` with the merge-method instruction, head, gates, the mutations, and the note that the staging image needs a nemar-process release and the owner's image dispatch (card S2P).
