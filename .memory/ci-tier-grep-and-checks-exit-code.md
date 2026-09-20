---
name: ci-tier-grep-and-checks-exit-code
description: nemar-cli test.yml sorts a test file into the live tier if its TEXT mentions TEST_API_URL/testRequest/runCli( (comments count), where TEST_API_URL beats the config file; and `gh pr checks --watch --fail-fast | grep` masks the exit code, so merges must check $? of gh itself
metadata:
  type: project
---

Two lessons from epic #1250 (2026-09-05):

1. `.github/workflows/test.yml` splits unit-pure from integration-dev by `grep -Eq 'testRequest|TEST_API_URL|runCli\('` over each test file's source. A comment that merely names `TEST_API_URL` moves the file into the live tier, where `TEST_API_URL` is exported and `getApiUrl()` prefers it over the config file, so an offline test that pointed its config at a local `Bun.serve()` silently ran against staging and 404'd (PR #1260 -> fix #1263). An offline test that must be robust in both tiers should set `process.env.TEST_API_URL` to its own server in beforeAll and restore it (guarded, #1175 style) in afterAll.

2. `gh pr checks <n> --watch --fail-fast | grep ... | tail` returns tail's exit status, so a `&&`-chained `gh pr merge` runs even when a job failed (that is how #1260 merged on a red integration-dev). Run the watch standalone, capture `rc=$?`, and merge only when rc is 0.

**How to apply:** before merging a phase PR, run the watch unpiped and branch on its exit code; when writing an offline CLI test, avoid naming the tier tokens in comments unless the test also pins them. See also [[epic-branch-ci-and-purge-lock]] and [[bun-test-shared-process-root-and-backend]].
