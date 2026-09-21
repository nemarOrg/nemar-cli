---
name: git-stash-shared-across-worktrees
description: In nemar-cli (and any repo with parallel agent worktrees) the git stash stack is shared, so one agent's stash pop takes another agent's work; forbid stash in agent briefs
metadata:
  type: feedback
---

On 2026-09-05, during epic #1250, two implementation agents in sibling worktrees both used `git stash` to get a clean test baseline. The Phase 5 agent's `git stash -u` created nothing (its tree was clean) and its `git stash pop` popped the Phase 1 agent's stash into the Phase 5 worktree; the Phase 1 agent's own pop then conflicted on an unrelated file and it had to recover from unreachable stash commits. Nothing was lost, but only because both agents verified byte-for-byte.

**Why:** the stash stack lives in the shared `.git`, not per worktree, and agents cannot see each other's stashes.

**How to apply:** every parallel-agent brief for this repo says "do not use git stash; use `git diff > file` or a local commit to get a baseline, and `git checkout -- <file>` to restore mutation tests". If a stash pop conflicts in a worktree, check `git stash list` and `git fsck --unreachable | grep commit` before assuming work is gone. See also [[annex-worktree-git-symlink]].

Addendum 2026-09-06: nemar-cli's lint-staged pre-commit hook runs `git stash` internally on every commit (it restores by SHA, so it is usually safe), but two agents committing at the same moment in different worktrees can still race on the shared stack. Stagger commits across agents, and after any concurrent commit burst check `git stash list` still holds the 9 long-lived entries.
