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

# Temporary PR-review test exception for epic #1671

Owner authorized continuing the dev-sync PR on 2026-10-09 while this test gap stays
documented. `backend/test/pr-review-flow.test.ts` drives a real local D1 schema and
real WebCrypto, but uses synthetic dataset rows, deterministic D1 interleavings for
claim-race coverage, and a `Bun.serve()` GitHub API stand-in;
`test/pr-review-evidence.test.ts` uses real temporary Git repositories and
the real Anthropic SDK against a `Bun.serve()` API stand-in. These suites are retained
as a temporary exception so the PR-review flow remains exercised in CI. They do not
prove behavior against GitHub or Anthropic, and the local stand-ins remain outside the
repository's normal NO MOCKS policy.

The flow fixture marks its rows published with a fixed `first_published_at` so it
reaches the same eligibility predicate used by production. Replace this exception
with isolated, owner-approved GitHub and Anthropic test endpoints before treating
the PR-review flow as real-service acceptance. Until then, report stand-in suite
results separately from real-service verification.

# Remaining real-test requirements for #1455

The inactivity warning is covered at the subprocess boundary with real Bun child
processes: the test verifies the 120-second production constant, output on either
stream resets the interval, later quiet intervals warn again, the child exits normally,
and a warning-callback exception is reported without changing the child's result. The
existing focused annex-add suite continues to exercise list-form `gitAnnexAdd` against
real git-annex repositories.

The full `uploadDataToS3` spinner orchestration and its warning persistence do not have
an end-to-end real-data test. The only checked-in BIDS dataset is explicitly synthetic,
and the NO MOCKS policy forbids using it as a real upload dataset. No suitable
non-synthetic dataset fixture or isolated upload test environment is available in this
checkout. The production wiring was verified by inspection from `uploadDataToS3` and
blocked-file recovery through `trackDataFiles`, list-form `gitAnnexAdd`, and `runCommand`.

Close this gap when an owner-approved non-synthetic dataset and isolated local upload
environment are available. Drive the real upload entry point and verify the warning is
persisted while its spinner continues; do not substitute an invented dataset, mocked
subprocess, or mocked S3 service.
