# CI/CD Workflow Standards

## Purpose: Automated Quality Gates
**Why CI/CD?** Catch issues before users do.
**Think:** Every pipeline failure is a production bug prevented.
**Goal:** Fast feedback, high confidence, zero surprises.

## Essential Workflows

### 1. Testing (`test.yml`)
**Triggers:** `on: [push, pull_request]` to main branches  
**Jobs (in order):**
- **Lint:** `ruff check` / `eslint` (fails fast)
- **Test:** Real tests only, matrix for versions
- **Build:** Verify compilation if applicable
- **Coverage:** Optional reporting to Codecov

### 2. Documentation (`docs.yml`)
**Triggers:** `on: push: branches: [main]`  
**Jobs:** Build with MkDocs → Deploy to GitHub Pages

### 3. Release (`release.yml`)
**Triggers:** Tag creation or manual  
**Jobs:** Build → Create release → Publish packages

## Minimal Python Example
```yaml
name: CI
on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v4
      with: { python-version: '3.11', cache: 'pip' }
    - run: pip install ruff && ruff check .

  test:
    needs: lint
    runs-on: ubuntu-latest
    strategy:
      matrix: { python-version: ['3.10', '3.11', '3.12'] }
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v4
      with: { python-version: '${{ matrix.python-version }}', cache: 'pip' }
    - run: pip install .[test]
    - run: pytest --cov=src
```

## nemar-cli: long-lived GitHub-token secrets

This repo's CI holds three long-lived GitHub personal access token (PAT) secrets. Only
`GH_TOKEN` is known to have expired without warning (issues #1321 and #1022); neither of the
other two has expired so far, and the daily probe below watches all three. **`GH_TOKEN`**
backs the `e2e-upload` job's real upload flow (accepting collaborator invitations, pushing,
opening PRs) as the user, so it has to stay a classic PAT owned by the `nemarAdmin` GitHub account with `repo` and `workflow`
scopes -- a GitHub App installation token cannot substitute, because `gh api user` 403s for one.
**`AUTO_TAG_PAT`** lets the release automation (`auto-tag.yml`, `auto-bump-dev.yml`,
`sync-dev.yml`) push bump/release commits to protected `main`/`dev` and create GitHub Releases.
**`DOCS_READ_TOKEN`** is the read-only fallback that lets `test.yml` check out the private
`nemarOrg/docs` content tree (ADR 0059). Rotate any of them with
`gh secret set <NAME> --repo nemarOrg/nemar-cli`. `scripts/ci/probe-github-token.ts` checks all
three daily (`.github/workflows/credential-probe.yml`, `--fail-days 14`) and also runs `GH_TOKEN`
specifically as a labeled pre-flight step in `e2e-upload` itself, so a dead credential fails
there instead of as two opaque "Bad credentials (HTTP 401)" test failures.

## Key Practices (Think About Pipeline Flow)
- **Pin versions:** `actions/checkout@v4` (reproducibility)
- **Cache deps:** Speed matters for developer happiness
- **Fail fast:** Lint→Test→Build→Deploy (catch cheap failures first)
- **Matrix testing:** Test all supported versions
- **Secrets:** Never commit credentials
- **Conditional:** Deploy only from protected branches

## Docs-only commits: `[skip ci]`

A commit that changes only documentation (`CHANGELOG.md`, Markdown under `.context/`,
`AGENTS.md`, `.rules/`) may go straight to `dev`, without a pull request, with `[skip ci]` in
its message.
GitHub's marker is per commit: it skips every workflow for that push, including `Auto Bump Dev`
and the dev deploy.

Never use it:

- on a commit that changes code, tests, workflows or configuration;
- as the head commit of a release pull request (`dev` to `main`), or of any pull request with
  required checks: the checks of a skipped head never run and the merge stays blocked, so push a
  real commit on top;
- on `main` or on a commit that gets a tag (`auto-tag.yml` explains why: a skipped push also
  blocks `npm-publish.yml`);
- in a pull request title or body.

## Pipeline Philosophy
**Fast feedback:** Developers should know in <5 min
**Clear failures:** Error messages should guide fixes
**No surprises:** If it passes CI, it works in production

**Ask yourself:**
- Will this catch real issues?
- Is the feedback loop fast enough?
- Are we testing what actually matters?
