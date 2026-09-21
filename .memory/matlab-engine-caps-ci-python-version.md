---
name: matlab-engine-caps-ci-python-version
description: Adding a Python version to eegprep's CI matrix fails on MathWorks' engine, not on eegprep; the pinned MATLAB release decides which Pythons are testable
metadata:
  type: project
---

Each MATLAB release ships one Python engine build covering a fixed set of Python versions.
eegprep's CI pins R2024b, which stops at 3.12, so adding 3.13 to the matrix failed at the
"Install Python MATLAB Engine" step with:

```
OSError: MATLAB Engine for Python supports Python version 3.9, 3.10, 3.11, and 3.12,
but your version of Python is 3.13
```

`uv sync` had already succeeded on 3.13. Nothing about eegprep or its dependencies was wrong.

**Why it matters:** the job goes red on a version bump and the obvious reading is that the new
Python broke the package. It did not, and chasing that reading wastes the whole investigation.
Verified 2026-09-20 on sccn/eegprep#399.

**How to apply:** when a new matrix entry fails, check *which step* failed before reading the
error as a code problem; `gh api repos/<owner>/<repo>/actions/jobs/<id>` gives step-level
conclusions while the run is still in progress and `--log` refuses. The fix is to let the engine
install fail and fall through to the plain pytest step, which the workflow already does when the
engine will not start, rather than encoding a MATLAB-to-Python compatibility table in CI. That way
it starts working by itself when a newer MATLAB release covers the version.
