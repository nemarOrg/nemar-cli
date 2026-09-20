---
name: conflicting-pr-stops-ci
description: A PR that conflicts with its base silently stops running Tests; a stale green or a missing run is not a pass
metadata:
  type: project
---

`test.yml` triggers on `pull_request` for base `main`/`dev`, so GitHub runs it against `refs/pull/<n>/merge`. **When the PR conflicts with its base, that merge ref cannot be built and the Tests workflow simply does not run.** No failure, no skipped entry, no notice: `gh pr checks` just keeps showing the *previous* run's result, and `gh run list` shows only `Publish to npm` (which triggers on push to any branch and so keeps looking healthy).

Two pushes in a row went untested this way, and the stale entry on the PR was a red X from the run *before* the fix. Closing and reopening the PR does not help either.

**Check `mergeable` before trusting any check state**, and when a run is missing, merge the base in rather than re-pushing:

```bash
gh pr view <n> --json mergeable -q .mergeable     # CONFLICTING => no CI is running
gh run list --branch <branch> --json name,event,headSha
```

Related: [[ci-tier-grep-and-checks-exit-code]] for the other way a check can lie about what it covered.

**Long-lived branches also lose ADR-number races.** Dev merged ADRs 0058 and 0059 while a branch was open holding its own 0058; the index test enforces that files and index agree, so the open branch renumbers (file, `# ADR NNNN:` title, index line, and every `ADR 0058` reference in src/ and test/). Check `.context/decisions/` against origin/dev before assuming a number is still free.

**And a conflict resolved badly reaches `dev` intact.** On 2026-09-15 `origin/dev` carried literal
`<<<<<<< HEAD` / `>>>>>>> origin/dev` markers inside `AGENTS.md`, and a `CHANGELOG.md` entry spliced
into the middle of another entry with a duplicate fragment of it left further down. Nothing catches
this: the markers sat in prose, so lint, tsc and every test stayed green. After merging `dev` into a
branch, run `git grep -n '^<<<<<<< ' -- .` and skim the diff of any prose file the merge touched.
