---
name: squash-merge-502-may-have-merged
description: `gh pr merge --squash` sometimes answers 502 and has merged anyway; check `gh pr view --json state,mergeCommit` instead of trusting the exit status
metadata:
  type: reference
  recorded: 2026-11-04
  revalidate_after: 2027-01-04
---

A squash merge through `gh pr merge` sometimes fails with a 502 from GitHub even though the merge went through.
Seen during the compute program (2026-11).
Treating the non-zero exit as "not merged" leads to a retry that errors on an already merged pull request, and to bookkeeping (a closed issue, a deleted branch) that disagrees with what GitHub holds.

**What to do:**

- After a failed merge call, read the state before doing anything else: `gh pr view <n> --json state,mergeCommit`.
  `state` is `MERGED` and `mergeCommit` is set when it went through.
- Retry the merge only when the state is still `OPEN`.
- The inverse also holds: a zero exit is not proof the right commit landed; for a release or an epic merge confirm the merge commit on the target branch.
- Related: `.memory/ci-tier-grep-and-checks-exit-code.md` (a piped `gh pr checks` hides its exit status).
