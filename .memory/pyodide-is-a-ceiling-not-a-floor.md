---
name: pyodide-is-a-ceiling-not-a-floor
description: For a package that must run in the browser, requires-python and dependency floors cap at what Pyodide ships; a floor above it cannot be satisfied
metadata:
  type: project
---

For anything that has to run in the browser, `requires-python` and the floors of **compiled**
dependencies act as a **ceiling**: Pyodide bundles its own WebAssembly build, PyPI has none, so a
floor above the bundled version cannot be satisfied there no matter how reasonable the bump looked.

**The test is whether the package publishes a pure-Python wheel, not whether Pyodide bundles it.**
A `py3-none-any` wheel means micropip can fetch any version straight from PyPI and the bundled
build is simply unused, so the floor costs a download and nothing more.

Verified 2026-09-20 against `https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide-lock.json` and
PyPI:

| | Pyodide 0.29.5 | universal wheel on PyPI | floor is a ceiling |
|---|---|---|---|
| Python | 3.13.2 (`emscripten_4_0_9`) | n/a | yes |
| scipy | 1.14.1 | none | yes |
| numpy | 2.2.5 | none | yes |
| matplotlib | 3.8.4 | none | yes |
| h5py | 3.13.0 | none | yes |
| threadpoolctl | 3.5.0 | `py3-none-any` | **no** |

I originally wrote this entry citing `threadpoolctl>=3.6.0` on `epic/324-pyodide-browser` as a live
broken install. **That was wrong**, and it is the instructive part: the package is bundled by
Pyodide, which made it look identical to the scipy case, but it is pure Python and micropip
installs 3.6.0 from PyPI without complaint. Being in `pyodide-lock.json` says nothing about whether
a different version is reachable.

**Why it matters:** the failure is an install that cannot resolve in the browser, found by a user
rather than by CI, and the bump that caused it will look routine in review. Over-applying the rule
is its own cost: it produces false alarms on pure-Python packages and a guard nobody trusts.

**How to apply:** read the versions out of that release's `pyodide-lock.json` before raising any
floor on a browser-bound package, and never from a changelog. Then check PyPI for a
`py3-none-any` wheel at the version you want, and only treat the floor as a ceiling when there is
none. eegprep enforces this offline in
`tests/test_browser_dependency_floors.py` (sccn/eegprep#399); copy that shape rather than trusting
review. Note that markers are evaluated with `sys_platform == "emscripten"`, so a
`sys_platform != 'darwin'` branch is the one the browser takes. Do not trust
`tools/check_pyodide_base_resolution.py` on the epic branch for this: it matches package names
only and never compares versions (sccn/eegprep#400). See [[retest-a-filed-diagnosis]].
