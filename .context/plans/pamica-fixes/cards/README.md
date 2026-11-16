# Worker preamble (sent before every card)

You are implementing one card of the pAMICA parity plan (`.context/plans/pamica-fixes/plan.md` in nemar-cli).
The code lives in the public repository `sccn/pAMICA`.
Read the card in full, then pAMICA's `AGENTS.md`, `.rules/backend_parity.md`, `.rules/testing.md` and `.rules/changelog.md`, then the files the card's Context names, then act.

## Abbreviations used across the cards

Adaptive Mixture Independent Component Analysis (AMICA); continuous integration (CI); pull request (PR); log-likelihood (LL); Apple's Metal Performance Shaders (MPS); Apple's array framework (MLX); NVIDIA's Compute Unified Device Architecture (CUDA); out of memory (OOM); Architecture Decision Record (ADR); JavaScript Object Notation (JSON); electroencephalography (EEG).

## Live facts the manager adds to every dispatch

`$PAMICA` (the pAMICA primary checkout: never edit it), `$WT` (the worktree root), `$BASE` (the branch every PR targets), `$EPIC` (the epic issue number in sccn/pAMICA), the answers to Q1 to Q3 that the card needs, the base head commit, and the open PRs that touch the card's Scope.

## Rules

- One card, one branch, one PR, in the worktree the card names; use absolute paths.
  Create the worktree from the primary checkout: `git -C "$PAMICA" fetch origin && git -C "$PAMICA" worktree add "$WT/<name>" -b <branch> "origin/$BASE"`, then `uv sync --frozen` in it (add `--extra mlx` when the card runs MLX tests).
- The PR targets `$BASE`. Only the manager merges. Never push to `main` or `dev`, never merge, tag, release or publish, never use `--admin`.
- Never force-push and never rebase a pushed branch; to take a newer base, merge it into your branch and rerun the gates.
- **No AMICA binary is downloaded or run on this machine.** Every comparison with the Fortran binary runs in GitHub Actions (the parity workflow after PA-01, or the weekly workflow where a card says so).
  Read results with `gh run view <run id> -R sccn/pAMICA --log` (or `--log-failed`); wait for a run with `gh run watch <run id> -R sccn/pAMICA --exit-status`, for at most 45 minutes, then report what you have.
  Because of this, review round 1 may push at most three times (measure, fix, final); every later round pushes once.
- Stay inside the card's Scope. Anything else goes in your report as a patch note or a proposal; never implement it.
- Real data only (the bundled sample EEG and the binary), no mocks, no synthetic data as the basis of a correctness test (pAMICA `.rules/testing.md`).
  Write each test first and see it fail; prove a local test can fail by mutating the one line it guards, then revert and confirm `git status --porcelain` is clean.
  For binary-gated tests, the card names the negative control that proves the gate can fail.
- Every behavior change lands in every backend that supports it, in the same PR, with a cross-backend test (pAMICA `.rules/backend_parity.md`).
- A user-visible change adds its entry under `## Unreleased` in `docs/changelog.md` (pAMICA `.rules/changelog.md`); for a test-only or CI-only change, say so in the PR body and the manager applies the `skip-changelog` label.
- **Versions are CI's.** Never edit `version` in `pyproject.toml`, never run `scripts/sync_version.py`, never start a commit subject with "Bump version to".
- Run every gate yourself and quote its last lines. A computed value is never reported as measured.
- **Parity budget.** A parity tier the card asks for gets at most two approaches or six hours of your work, whichever comes first.
  Then stop that thread, follow the card's "not attained" path (it names the issue template and the docs row), and continue with the rest of the card.
  A documented "not attained because X" is an acceptable outcome; loosening a pre-registered threshold is not.
- Kill stray `pytest` runs whose working directory is your own worktree before gates (`pgrep -fl pytest`, `lsof -a -d cwd -p <pid>`).
- Scratch scripts get unique names in a private subfolder of your worktree that you do not commit.
- No computer use, no visible graphical runs, no secrets. No ssh to any machine.

## Hard rules of this repository family

- **Public repositories.** No host names, user names, home paths, IP addresses or machine descriptions in code, tests, comments, docs, commits, PRs or issues. A GPU machine is "a Linux workstation with an NVIDIA GPU".
- **Tooling:** uv, ruff and ty for Python; never pip, conda, flake8, black, isort, pylint or mypy.
- **Commits:** atomic, `<type>: <description>` under 50 characters, no emojis, no AI or co-author attribution.
- **PR bodies:** one line per paragraph: what changed, gates run with results, what was not run and why, the card ID, and `Fixes #N` where the card says so.
- **Prose:** American spelling, no em dashes, semantic line breaks (one sentence per line), every abbreviation defined on first use.

## The leak check (every card that writes prose into a repository runs it on each such file)

```bash
f=<file>
grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' "$f" | grep -vx '127\.0\.0\.1'
grep -nE -i '/home/|/data/|/Users/|/scratch/|/private/tmp|/Volumes/' "$f"
grep -oE '[A-Za-z0-9][A-Za-z0-9.-]*\.(edu|com|net|org|io|local|lan|internal)\b' "$f" | sort -u \
  | grep -vxE 'github\.com|pypi\.org|eeglab\.org|doi\.org|openneuro\.org|nemar\.org|docs\.nemar\.org|astral\.sh|pytorch\.org'
```

All three commands must print nothing (the loopback address is the only address allowed).

## Report (your final message, at most 25 lines)

PR number and head commit; each gate with its quoted last lines; the CI run ids you read and the quoted `PARITY` or floor lines; evidence paths; a revert check per fix or test; deviations from the card; questions for the lead; patch notes for other owners; proposals (never implemented); "not run, would check" lines.
