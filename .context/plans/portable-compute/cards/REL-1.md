# Card REL-1: nemar-process gets a `dev` branch, CI-owned version bumps, release tags and their tests

Status: ready
Tier: worker-hard
Timebox: L, 6 hours; escalate at 12 hours or two failed approaches
Needs: network
Depends: none
Branch: chore/rel-1-release-automation
Worktree: $WT/nemar-process-rel1 (base origin/main of nemarOrg/nemar-process, whose head is the merge commit `8a4acba`)
Plan: .context/plans/portable-compute/plan.md (owner request of 2026-11-13: "you can do all"); nemar-cli ADR 0016 is the model
Review: Sonnet panel plus one Opus review (release safety: self-retrigger guards, the strip commit, tag namespaces, token permissions, the image publish guard left intact)

## Goal

nemar-process versions itself the way nemar-cli does (ADR 0016): `dev` always carries `X.Y.Z-devN` and CI increments N on every push to `dev`; a merge to `main` makes CI strip the suffix as the bot, tag `vX.Y.Z`, create a GitHub release, and sync `main` back into `dev` at the next patch's `-dev1`; human pull requests never change the version; and tests pin all of it.

## Context

- Read in nemar-cli (any checkout, read only): `.github/workflows/auto-bump-dev.yml`, `auto-tag.yml`, `sync-dev.yml`, `bump-validator.yml`, `test.yml`, `scripts/bump-version.sh`, `.context/decisions/0016-release-versioning-is-owned-by-ci.md`, `.rules/release-and-repull.md`.
- In nemar-process at `origin/main`: `pyproject.toml` (`[project].version = "0.1.0"`, `[tool.uv] package = false`), `uv.lock` (root entry `name = "nemar-process"`, `version = "0.1.0"`, `source = { virtual = "." }`), `.github/workflows/ci.yml` (push on `main` and `feature/**`, every pull request; actions pinned by commit SHA with a version comment), `.github/workflows/image-nemar-python.yml` (publishes only from `main` or an `image-nemar-python-v*` tag and refuses a commit not on `main`), `launcher/nemar_launch/__init__.py` (`__version__ = "0.1.0"`, sent as `nemar-launch/<version>`), `deploy/tapis/apps/nemar-launch.json` (the launcher zip's `launcher_sha256` and the `nemar-launch-v0.1.0` release asset), `deploy/tapis/released-versions.json`, `tests/contract/*-pin.json`, `docs/images.md`.
- Secrets, branch protection and rulesets are the owner's repository settings: never change them; list the recommended settings in the report.

## Scope

- New `scripts/bump_version.py`; new workflows `.github/workflows/auto-bump-dev.yml`, `auto-tag.yml`, `sync-dev.yml`, `bump-validator.yml`, `release-gate.yml`; `.github/workflows/ci.yml` (add `dev` to the push branches and one `actionlint` job); new `tests/release/test_bump_version.py` and `tests/release/test_workflows.py`; `docs/release.md` (new); `README.md` (one link).
- Not `image-nemar-python.yml`, not the launcher, the runner, the recipes, `deploy/`, or any pin file.

## Decided design

Settled (one-line reason each):
- **The version lives in `pyproject.toml` `[project].version` and the root entry of `uv.lock`, and nowhere else.** One source; `uv lock --check` keeps the two equal.
- **The bump never touches `launcher/nemar_launch/__version__`, the runner's version, `RECIPE_VERSION`, `COMMON_VERSION` or any pin.** Each is its own artifact with its own release tag (`nemar-launch-v*`, `image-nemar-python-v*`) or its own place in a stamp tuple; bumping the launcher's would change the launcher zip and break the `launcher_sha256` pin and `build_launcher_zip.py --check`. A test asserts the script's diff names exactly `pyproject.toml` and `uv.lock`.
- **`scripts/bump_version.py <target>`** (standard library; `tomllib` to read, an exact line edit to write, so formatting is kept). It edits the `[project]` `version` line and the `uv.lock` root entry's `version` line textually (no `uv lock`, so it is offline and deterministic), then commits `chore: bump version to <v>` with the configured identity.
  Targets: `devN` sets the suffix on the current base; `X.Y.Z` or `X.Y.Z-devN` sets that exact version; `patch`, `minor`, `major` set the next such version at `-dev1`.
  It refuses, with exit 2 and nothing written: a dirty tree; a malformed target; a version that is not `X.Y.Z` or `X.Y.Z-devN`; going backwards; a `devN` on a version with no suffix. The same target as the current version prints `already at <v>` and exits 0 with no commit (idempotent).
  The commit message never contains `[skip ci]`.
- **auto-bump-dev.yml** (push to `dev`): the job runs only if `github.event.head_commit.author.email != 'nemar-bot@users.noreply.github.com'`, the message does not start with `chore: bump version to`, and it does not contain `[skip-bump]`. It increments `devN` with the script and pushes; a rejected push is a warning, not a failure.
- **auto-tag.yml** (push to `main`, paths `pyproject.toml`): the same author guard. It strips `-devN` with the script and pushes `main` WITHOUT `[skip ci]` (that would suppress the tag push event), then refuses if `vX.Y.Z` already exists. Then: an annotated tag `vX.Y.Z`, push, `gh release create vX.Y.Z --verify-tag --generate-notes` with no assets. The image publish stays the owner's separate dispatch.
- **Tags:** exactly `vX.Y.Z` (`^v[0-9]+\.[0-9]+\.[0-9]+$`), disjoint from `image-nemar-python-v*` and `nemar-launch-v*`; a test asserts no new trigger glob matches those and the image workflow's tag trigger is unchanged.
- **sync-dev.yml** (push of a tag matching `v[0-9]+.[0-9]+.[0-9]+`): the same author guard does not apply (the trigger is a tag). It validates the tag, and if `dev` does not exist it logs a notice and exits 0. Otherwise it merges `origin/main` into `dev` with a merge commit `chore: sync dev with main after vX.Y.Z`; a conflict fails the job for the owner. Then it bumps `dev` to the next patch at `-dev1` unless `dev` is already ahead, and pushes.
- **bump-validator.yml** (every pull request): into `dev`, the version lines of `pyproject.toml` and `uv.lock` must not change (only the bot bumps). Into `main`, the head's version must be `X.Y.Z-devN` and `X.Y.Z` must be greater than the newest `v*` tag.
- **release-gate.yml** (pull requests into `main` only, the stricter set): `uv lock --check`; the full `uv run pytest -q` including the Apptainer end-to-end tests with Apptainer installed as `ci.yml` installs it; `actionlint`; the `tests/release` suite.
- **Tokens:** the three bot workflows check out and push with `secrets.AUTO_TAG_PAT`, the name nemar-cli uses, which the owner creates. `permissions: contents: write` appears only on those three jobs, and every other workflow and job declares `contents: read`. Every `uses:` is pinned by a 40-hex commit SHA with a version comment, reusing the SHAs `ci.yml` already pins. `actionlint` runs from a release binary pinned by version and SHA-256.
- **Bot identity:** `nemar-bot` / `nemar-bot@users.noreply.github.com`, the same as nemar-cli, so one guard expression serves both.
- **First `dev`** (after the owner merges this PR into `main`; the manager does it, ADR 0016's allowed manual first bump):
  - `git -C "$NEMAR_PROCESS" push origin origin/main:refs/heads/dev`.
  - In a worktree on `dev`: `uv run python scripts/bump_version.py 0.1.1-dev1`, then a direct push to `dev` before the owner protects it.
  - auto-bump-dev skips it by its message. If auto-tag tagged `v0.1.0` on this PR's merge (the version stays `0.1.0`, as nemar-cli tags an unsuffixed version as is), that tag is the first release of the merged epics.
The implementer may choose: helper names, the YAML loading library already in the dev group (`pyyaml`), test fixtures (copies of the real `pyproject.toml` and `uv.lock` in a temporary git repository).

## Acceptance

- `uv run pytest tests/release -q` passes. The bump script is run as a subprocess in a temporary git repository holding copies of the real `pyproject.toml` and `uv.lock`, and the tests check:
  - the strip `0.2.0-dev3` to `0.2.0`; `dev4` from `0.2.0-dev3`; `patch`, `minor` and `major` cuts to `-dev1`;
  - every refusal path with nothing written; idempotence (no second commit);
  - the diff names exactly the two files, and no commit message contains `[skip ci]`.
- The workflow tests in `tests/release` pin:
  - the author guard on the three bot jobs, and no `[skip ci]` in `auto-tag.yml`;
  - the trigger branches and tag globs, and that no new glob matches `image-nemar-python-v` or `nemar-launch-v`;
  - `contents: write` only where stated, and every `uses:` pinned by SHA;
  - `image-nemar-python.yml` byte-identical to `origin/main`'s.
- `uv lock --check` passes after a bump made in the temporary repository (the test runs it there).
- `actionlint` on `.github/workflows/*.yml` reports nothing (quote its output).
- Each new test fails under a one-line mutation (listed).

## Gates

- `uv sync --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, `uv run ty check`, `uv lock --check`, `uv run pytest tests/release -q`, `actionlint .github/workflows/*.yml`.
- The full `uv run pytest -q`: not run, would check: CI on the PR.

## Stop conditions

- Anything here would need a change to `image-nemar-python.yml`, a pin file, the launcher or the runner: stop and report.
- A workflow can only work with a branch protection or ruleset change: stop and list the setting in the report; never change one.

## Report

At most 25 lines: PR URL and head; gates with last lines; mutations; deviations; and the recommended owner settings:
- the `AUTO_TAG_PAT` secret (contents write on this repository, allowed to bypass protection for its own commits);
- `main`: pull request required, with the `ci.yml` jobs, `bump-validator` and `release-gate` required;
- `dev`: pull request required, with the `ci.yml` jobs and `bump-validator` required;
- a tag rule on `v*` limited to the bot.
