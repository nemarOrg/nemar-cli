# START: the pAMICA same-seed parity pack

The lead (Opus) wrote this pack on 2026-11-14 and stopped; a separate Sonnet manager runs it.
Goal (the owner's): PyTorch and the Apple GPU paths match the Fortran binary pAMICA ships, started from the same seed, when possible (`plan.md` section 1).

## Before you start (the owner)

1. **Approve the defaults** (the board's tables): slots `claude-sonnet` Max 1 (the implementer) and `claude-opus` Max 1 (planning, verification design, every review, the advisor); budget 8 agents a day, 40 for the whole pack, 3 advisor consults; pack deadline 2026-11-28T17:00 Pacific; 10 steps, cap 12 (`plan.md` section 7).
2. **Timing.** Start after the NEMAR demo freeze (2026-11-15T06:00 Pacific), when the NEMAR board's `claude-opus` returns from Max 2 to Max 1, so both boards together run at most two Opus agents on the shared account. Starting earlier means three.
3. **Optional, not done:** the skill's pack review (one executability and one design reviewer, two agents) before the first tick.
4. When the manager asks, give it the path of your pAMICA checkout; it keeps that in a private file, never in the repository.

## Owner questions (recorded on the board; the manager asks them at Setup; no defaults)

**Q1. Who merges pAMICA step PRs?**
A (recommended): the manager squash-merges each step PR into an epic branch `feature/issue-<epic>-nemar-parity` after the merge gate, never with `--admin`; you merge the epic into `dev` and release. Keeps the chain moving while dependent cards wait on merges.
B: every PR targets `dev` and you merge each one; slower, since PA-02, PA-03 and PA-04 each wait for a merge.

**Q2. How should pamica report convergence honestly?** (`converged_` is true at `max_iter` today.)
A (recommended): add `did_converge_` beside `converged_` and reword `converged_` as "usable"; additive, nothing breaks.
B: rename `converged_` to `usable_` and add `did_converge_`; cleanest name, a breaking change in the next minor release.
C: no new flag; eegprep keeps deriving it from `stop_reason_`.

**Q3. #369: how should the failing oracle test's noise floor be fixed?** (torch 1.14e-6 against a CI floor of 7e-8 to 9e-8; on a development host, 6.6e-7 against 4e-7.)
A (recommended): the floor becomes the larger of the thread floor and the build floor (the shim against the v0.4.0 release asset, from the same start), the bound stays 10 times it, and the pre-change control must still exceed 100 times it; registered before the build floor is measured (`plan.md` D4).
B: keep the thread-only floor and spend one advisor consult investigating 1.14e-6 as a possible real divergence.
C: mark the case `xfail(strict=True)` with #369 until PA-03's same-start gates cover it.

## The start prompt

Start a Claude Code session with a Sonnet model, its working directory the nemar-cli worktree on branch `docs/portable-compute-board` (the one that holds the NEMAR board), and paste:

```text
/loop You are the manager of the pAMICA same-seed parity pack.
Run one tick of the runbook at .context/plans/pamica-fixes/runbook.md (relative to this session's working directory, the nemar-cli worktree on branch docs/portable-compute-board), exactly as written, using the project:manager-loop skill.
The state is the board beside it: .context/plans/pamica-fixes/board.md.
Your manager id is mba-claude-sonnet-pamica, the same on every tick.
Do not write product code.
Do not change the plan, a card, a gate, a pre-registered threshold, the parity, or a budget limit.
Never write under .context/plans/portable-compute/ or touch the NEMAR board, its cards or its questions.
When the runbook says to stop or to ask, or does not cover what you see, record it on the board, ask the owner with a structured question, and stop that thread of work.
```

The manager paces itself: 30 minutes while a worker runs, 60 while it waits on people.
It stops when every step is `done` or `dropped`, when everything left waits on you, or at the pack deadline.
