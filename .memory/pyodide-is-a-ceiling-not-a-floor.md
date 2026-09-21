---
name: pyodide-is-a-ceiling-not-a-floor
description: For a package that must run in the browser, requires-python and dependency floors cap at what Pyodide ships; a floor above it cannot be satisfied
metadata:
  type: project
---

Pyodide bundles its own build of every compiled scientific package, and micropip has no
WebAssembly build to fall back to. So for anything that has to run in the browser,
`requires-python` and every dependency floor act as a **ceiling**: a floor above the version a
Pyodide release ships cannot be satisfied there, no matter how reasonable the bump looked.

This inverts the usual reading of a floor and is invisible from the code, which is how
`threadpoolctl>=3.6.0` reached `epic/324-pyodide-browser` against a distribution shipping 3.5.0.

Verified 2026-09-20 against `https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide-lock.json`:

| | Pyodide 0.29.5 |
|---|---|
| Python | 3.13.2 (`emscripten_4_0_9`) |
| threadpoolctl | 3.5.0 |
| scipy | 1.14.1 |
| numpy | 2.2.5 |
| matplotlib | 3.8.4 |
| h5py | 3.13.0 |

**Why it matters:** the failure is an install that cannot resolve in the browser, found by a user
rather than by CI, and the bump that caused it will look routine in review.

**How to apply:** read the versions out of that release's `pyodide-lock.json` before raising any
floor on a browser-bound package, and never from a changelog. eegprep enforces this offline in
`tests/test_browser_dependency_floors.py` (sccn/eegprep#399); copy that shape rather than trusting
review. Note that markers are evaluated with `sys_platform == "emscripten"`, so a
`sys_platform != 'darwin'` branch is the one the browser takes. Do not trust
`tools/check_pyodide_base_resolution.py` on the epic branch for this: it matches package names
only and never compares versions (sccn/eegprep#400). See [[retest-a-filed-diagnosis]].
