# Card REL-2: signalJourney gets enforced release rules, a changelog check, a TestPyPI-then-PyPI release, and v0.2.0 ready to tag

Status: ready
Tier: worker-hard
Timebox: L, 6 hours; escalate at 12 hours or two failed approaches
Needs: network
Depends: none
Branch: chore/rel-2-release-process
Worktree: $WT/signaljourney-rel2 (base origin/main of signalJourney/signalJourney, head `cc1d5d6`, PR #10 merged)
Plan: .context/plans/portable-compute/plan.md, section 2.9; owner request of 2026-11-13 (night)
Review: Sonnet panel plus one Opus review (release safety: tag and version rules, the publish chain and its permissions, the TestPyPI smoke without dependency confusion, the release title rule)

## Goal

A merged PR leaves signalJourney with release rules that CI enforces, a changelog every code change must update, a tag-driven workflow that publishes to TestPyPI, smoke-installs from it, then publishes to PyPI and creates a GitHub release titled exactly with the tag, a green CI, and version 0.2.0 recorded in code and changelog, so the owner's `v0.2.0` tag push releases it.

## Context

- signalJourney at `origin/main`: `pyproject.toml` (distribution `signalJourney`, `version = "0.0.1"`, `requires-python = ">=3.9"`), `src/signaljourney_validator/__init__.py` (`__version__ = "0.0.1"`), `CHANGELOG.md` (Keep a Changelog, one entry `## [0.1.0] - 2025-08-20`), `.github/workflows/publish.yml` (tag `v*`: tag-on-main check, the version equality check, `uv build`, a wheel smoke, PyPI trusted publishing in environment `pypi`), `.github/workflows/ci.yml` (matrix 3.9 to 3.12 with `actions/setup-python` on `ubuntu-latest`, `pip install`, a Security Scan job whose `safety check --output safety-report.json` is rejected), `CONTRIBUTING.md` (release section), `docs/` (MkDocs, `mkdocs.yml`).
- Models, read only: nemar-cli ADR 0016 and its `auto-tag.yml` and `bump-validator.yml`; nemar-process `scripts/bump_version.py`, `docs/release.md`, `tests/release/`.
- Owner decisions already made: the distribution is `signalJourney`; GitHub environments `pypi` and `testpypi` exist; the owner registers the PyPI and TestPyPI trusted publishers; tags are only `vX.Y.Z`; a release's title is only the tag; the existing `v0.1.0` tag stays on its commit and its release is already retitled `v0.1.0`; the next version is 0.2.0.
- Repository settings (rulesets, environment reviewers) are the owner's: recommend them in the report, never change them.

## Scope

- New `scripts/release_check.py` and `tests/test_release_check.py`; `.github/workflows/publish.yml` (rewritten, same file name, because the trusted publishers are registered against it); `.github/workflows/ci.yml` (fixes and the release checks); new `.github/workflows/changelog.yml`; `pyproject.toml` (dynamic version); `src/signaljourney_validator/__init__.py` (`__version__ = "0.2.0"`); `CHANGELOG.md`; `CONTRIBUTING.md` (release section); new `docs/RELEASING.md` and its `mkdocs.yml` nav entry.

## Decided design

Settled (reason in one line each):
- **One version source:** `__version__` in `src/signaljourney_validator/__init__.py`; `pyproject.toml` declares `dynamic = ["version"]` with `[tool.setuptools.dynamic] version = { attr = "signaljourney_validator.__version__" }`. One edit per release cannot drift.
- **Manual bump with a validator, not a CI-owned bump branch:** a small specification repository releases rarely; a bot token and a `dev` branch would add more moving parts than they remove. The rules below are what make it "proper".
- **`scripts/release_check.py`** (standard library only, Python 3.9 or newer), the one place every rule lives, called by CI and the workflow:
  - `tag <tag>`: the tag matches `^v[0-9]+\.[0-9]+\.[0-9]+$`. The tag equals `v` + `__version__`, which equals the version of the built wheel's metadata (when `--dist dist/` is given) and the newest dated `CHANGELOG.md` entry `## [X.Y.Z] - YYYY-MM-DD`. That entry's body is not empty.
  - `notes <version>`: prints that entry's body for the release notes, and fails when the entry is missing or empty.
  - `changelog --base <sha> --head <sha> [--label <name>]...`: when the diff touches `src/`, `pyproject.toml` or `MANIFEST.in`, `CHANGELOG.md` must change inside `## [Unreleased]` unless a label `no-changelog` is given. Every check also requires that `## [Unreleased]` exists, that the sections use Keep a Changelog headings (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`), and that the `## [0.1.0] - 2025-08-20` section is byte-identical to the base's.
  - `static`: the repository-wide checks (Unreleased present, entries in descending version order, `__version__` equal to the newest dated entry).
- **CHANGELOG.md:** keep `## [Unreleased]` (empty after this PR) above a new `## [0.2.0] - <the date this PR is opened>` entry that says what PR #10 did:
  - the schema packaged inside the wheel and loaded with `importlib.resources`;
  - `SchemaResolutionError` for an unresolved `$ref`;
  - `schema_dir` refused when wrong instead of silently falling back, and the default packaged schema;
  - local refs resolved within their `$id` scope;
  - `requires-python` 3.9;
  - the distribution renamed `signalJourney` (import package and command unchanged);
  - the publish workflow and logging instead of printing.
  The 0.1.0 entry stays exactly as it is.
- **publish.yml** (on push of tags matching `v*`; the first job refuses anything that fails `release_check.py tag`), jobs in order:
  1. `check`: tag on `main`, and `release_check.py tag`.
  2. `build`: `uv build`, the existing wheel smoke, and `release_check.py tag --dist dist/`; it uploads the artifact.
  3. `testpypi`: environment `testpypi`, `id-token: write`, `pypa/gh-action-pypi-publish` with `repository-url: https://test.pypi.org/legacy/`.
  4. `smoke-testpypi`: in a fresh virtual environment, `uv pip install --no-deps --index-url https://test.pypi.org/simple/ signalJourney==X.Y.Z`, then `uv pip install jsonschema click` from PyPI, so no dependency ever comes from TestPyPI. Then `signaljourney-validate validate` on a packaged example, retried up to 5 times at 30 s for index propagation.
  5. `pypi`: environment `pypi`, `id-token: write`.
  6. `release`: `contents: write` only here; `gh release create "$TAG" --title "$TAG" --notes-file notes.md --verify-tag`, with `notes.md` from `release_check.py notes`. If the release already exists (a re-run), `gh release edit "$TAG" --title "$TAG" --notes-file notes.md`.
  Workflow-level `permissions: contents: read`; every `uses:` pinned by commit SHA with a version comment, reusing `publish.yml`'s current pins. A tag that fails any check publishes nothing.
- **ci.yml fixes** (the release gate needs a green CI):
  - Every job `runs-on: ubuntu-24.04`.
  - Python comes from `astral-sh/setup-uv` with `python-version: ${{ matrix.python-version }}` instead of `actions/setup-python`; installs use `uv`, never `pip`.
  - The security job pins `safety` to an exact version and uses that version's documented JSON output option (check `safety check --help` in the job itself). If that version needs an account or key, replace it with `pip-audit` pinned exactly, and say so in the report.
  - A `release-rules` job runs `release_check.py static` and `uv run --with pytest pytest tests/test_release_check.py -q`.
- **changelog.yml** (pull requests into `main`): `release_check.py changelog --base ${{ github.event.pull_request.base.sha }} --head ${{ github.event.pull_request.head.sha }}` with the PR's labels passed as `--label`.
- **First release:** this PR sets `__version__` to 0.2.0 and the changelog. The owner merges it, then pushes `git tag -a v0.2.0 -m v0.2.0 <merge commit> && git push origin v0.2.0` once both trusted publishers are registered against `publish.yml` with environments `testpypi` and `pypi`. TestPyPI, its smoke, PyPI and the GitHub release `v0.2.0` follow.
The implementer may choose: parser internals, test fixtures (temporary copies of the real `CHANGELOG.md` and files).

## Acceptance

- `uv run --with pytest pytest tests/test_release_check.py -q` passes, covering:
  - a good tag; `v0.2`, `0.2.0` and `v0.2.0-rc1` refused;
  - a version mismatch refused in each of the three places;
  - `notes 0.2.0` printing the entry, and `notes 9.9.9` and an empty entry failing;
  - `changelog` failing for a `src/` change without an Unreleased edit, passing with the `no-changelog` label, and passing for a `docs/`-only change;
  - an edit of the 0.1.0 section refused; `static` passing on the real repository.
- `uv run python scripts/release_check.py static` exits 0 on this branch; `uv run python scripts/release_check.py notes 0.2.0` prints the new entry.
- `uv build` builds 0.2.0, and `uv run python scripts/release_check.py tag v0.2.0 --dist dist/` exits 0.
- `actionlint .github/workflows/*.yml` reports nothing, if `actionlint` is available; otherwise "not run, would check: actionlint".
- The CI run on the PR is green on every job, including the 3.9 to 3.12 matrix and the security job: "not run, would check: CI" in your report; the manager reads it.
- Each new test fails under a one-line mutation (listed).

## Gates

- `uv run --with ruff ruff check scripts tests src`, `uv run --with ruff ruff format --check scripts tests`, `uv run --with ty ty check scripts` (zero diagnostics in `scripts/`; report the count elsewhere as a baseline, unchanged), `uv run --with pytest pytest -q`, `uv build`.

## Stop conditions

- A rule here conflicts with an owner decision listed in Context: stop.
- The trusted-publisher setup needs a token secret or another workflow file name: stop and report.
- The existing `v0.1.0` tag or release would be touched by anything: stop.

## Report

At most 25 lines: PR URL, head, gates, mutations, deviations, and the owner's recommended settings:
- a tag ruleset on `v*` (pattern `v[0-9]*.[0-9]*.[0-9]*`, creation limited to maintainers, no update or deletion);
- required reviewers on the `pypi` environment;
- `main` requiring the CI jobs and `changelog`;
- both trusted publishers registered for `publish.yml` with environments `testpypi` and `pypi`.
