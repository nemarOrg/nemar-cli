# Card S2P: The nemar-process runner epic reaches a green pull request into `dev`

Status: ready
Tier: worker
Timebox: S, 2 hours of work (CI time not counted); escalate at 4 hours
Needs: network
Depends: round 1: S1R (merged into `feature/runner-epic` with a merge commit, so the epic carries `dev`); round 2, dispatched again by the manager: C2, L1 and S4 merged into the epic (C4 too if it merged)
Branch: none for the main pull request (its head is `feature/runner-epic` itself); fix branches `feature/pc-s2p-fix-<n>` into the epic
Worktree: $WT/nemar-process-pc-s2p (detached at origin/feature/runner-epic, for local checks only)
Plan: .context/plans/portable-compute/plan.md, section 4 (S2), section 2.9; nemar-process `docs/release.md`

## Goal

A pull request from `feature/runner-epic` into nemar-process `dev` exists with every required check green on its head, and the report carries the exact owner commands for the merge, the release that follows it, and the image publish that gives staging a signed image with the staging Zarr pair; the card never merges into `dev` or `main`.

## Context

- `dev`'s rules: a pull request, a code-owner review (the owner), and the checks `lint`, `actionlint`, `launcher (python 3.9)`, `launcher (python 3.12)`, `images`, `recipes`, `deploy (tapis definitions and observer)` and `bump-validator`; any merge method is allowed, and this epic lands with a merge commit.
- `bump-validator` fails a pull request that changes the version lines; the epic never edits them.
- `docs/release.md`: a release is the owner's pull request from `dev` into `main`, merged with a merge commit; CI then tags `vX.Y.Z`; publishing the image is a separate dispatch of `image-nemar-python.yml` with that version, which since PX-10 must equal the commit's release.
- Round 1 carries the runner (DM-10, DM-11, DM-18) and S1R; round 2 carries C2, L1 and S4 (and C4 if done), after which the owner also pushes the runner's release tag that S4's workflow signs.

## Scope

- Read-only on everything except the PR's title and body and fix pull requests into the epic (only files a failing required check names).

## Decided design

Settled, in order:
1. Inventory (into the PR body and the report): `git rev-list --left-right --count origin/dev...origin/feature/runner-epic`; `git merge-tree --write-tree --name-only origin/feature/runner-epic origin/dev`; `git diff --stat origin/dev...origin/feature/runner-epic`; that `pyproject.toml` and `uv.lock` version lines are unchanged against the merge base; the round's merged PR numbers.
2. Local checks in the detached worktree: `uv sync --frozen`, `uv lock --check`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run ty check --python-version 3.9 launcher observer runner`, `uv run pytest tests/runner tests/recipes tests/contract -q`, `uv run --no-project --python 3.9 --with pytest --with jsonschema pytest tests/launcher -q`.
3. Open the pull request as a draft: `gh pr create -R nemarOrg/nemar-process --base dev --head feature/runner-epic --draft --title "Runner epic, round <r>: workstation runner into dev" --body-file <file>` (round number in the title); the body has one line per merged phase PR, the inventory, step 2's last lines, and the owner commands. Each paragraph on one line.
4. Do not wait for CI; the manager watches. A failure caused by the diff comes back to you: fix PR into the epic from `feature/pc-s2p-fix-<n>`, squash-merged by the manager, at most two rounds.
5. When every required check is green: `gh pr ready <n> -R nemarOrg/nemar-process`.
The implementer may choose: the body's wording.

Owner commands (in the report verbatim):
- Merge: `gh pr merge <n> -R nemarOrg/nemar-process --merge` (code-owner review first).
- Release (when the owner chooses, normally right after): open `dev` into `main`, merge with a merge commit once `bump-validator`, `release-gate` and `ci` are green; CI tags `vX.Y.Z`.
- Image (round 1, for staging): `gh workflow run image-nemar-python.yml -R nemarOrg/nemar-process --ref main -f version=X.Y.Z` with that release's version; the digest file `nemar-python-X.Y.Z-cpu-digests.json` then names the digest, which is verified as in DM-14 step A3 and set on the dev Worker by the owner (card S2S).
- Runner tag (round 2 only, after S4): the tag S4's workflow names, on the release commit.

## Acceptance

- `gh pr view <n> -R nemarOrg/nemar-process --json baseRefName,headRefName,mergeable` shows base `dev`, head `feature/runner-epic`, `MERGEABLE`; `gh pr checks <n> -R nemarOrg/nemar-process` lists the eight required checks `pass` (verified by the manager after CI).

## Gates

- Step 2's commands with their last lines quoted.
- The `release-gate` workflow (which runs only on pull requests into `main`): not run, would check: the owner's release pull request.

## Stop conditions

- `git merge-tree` reports a conflict, or the version lines differ from the merge base: stop and report.
- Round 1: `git log --oneline origin/feature/runner-epic..origin/dev` lists a commit that is not the bot's `chore: bump version to` (S1R did not bring `dev` in, or `dev` moved with real work since): stop and report; the lead decides whether a fresh merge of `dev` is needed.
- Anything would merge into `dev` or `main`, push a tag or dispatch a workflow: stop; those are the owner's.

## Report

At most 25 lines: PR number, head, round, inventory, step 2's results, fix PRs if any, and the owner commands.
