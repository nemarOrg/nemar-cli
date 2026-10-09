# Remaining real-test requirements for #1642

The copy, resume, and save tests use the real Git and git-annex executables, real
temporary repositories, and git-annex's real `directory` special remote. The Git
wrapper only adds per-command environment variables or records arguments; it never
changes command output or status.

These narrow failure branches had only been exercised by invented command results.
Those tests were removed rather than kept as false confidence:

- Copy-error formatting for successful JSON records paired with a failing exit, and
  for output that is not JSON records, needs a real git-annex invocation that produces
  each output shape. Current captures cover successful copy, partial output, a
  mid-transfer failure, a missing remote, and a many-file failure.
- An unreadable annex location log at a specific post-copy or later hint walk needs a
  real repository/log state that makes that git-annex read fail after setup succeeds.
  The damaged-index case fails closed through real git-annex, but may fail during copy
  rather than the final verification walk; it does not establish every later-walk branch.
- `git annex find` termination and the exact signal/exit text need a real process
  failure. A corrupt-index test covers `git ls-files`; it does not simulate a killed
  git-annex child or a failing `git grep`.
- A failure on a later `git rm --cached` chunk, or a re-add failure after blocked
  tracking recovery, needs a real index or annex write failure at that exact point.
  A persistent real `.git/index.lock` covers the first unstage failure.
- The signal handler's hung-Git timeout, stopping an in-flight Git child, and a signal
  arriving during the final unmark need a real long-running Git operation with a
  controllable lock. Current signal coverage uses a real pre-commit hook and real
  index-lock files, including one that clears during the retry window.
- The save's one-failed-unmark-then-success retry branch needs a real transient lock
  that clears between the two synchronous attempts; the persistent-lock failure and
  next-save recovery are covered with real Git state.
- The sandbox save/push tests exercise `saveAndPush` with a real repository and bare
  origin, but do not drive `sandboxCommand` through dataset creation, finalization, and
  cleanup. That entrypoint calls the real backend and mutates the shared
  `nemarDatasets` GitHub org and S3-backed fixture; there is no safe local real-service
  environment for this path. Do not add a stub API. Close this gap only with an
  isolated staging fixture and an owner-approved run, and verify that a failed
  save/push never finalizes the sandbox.

Do not restore command shims that substitute stdout, stderr, exit codes, or process
signals to close these gaps. Add coverage when a deterministic real Git/git-annex or
OS-level fixture can produce the required condition without changing the command's
result.
