# The `eegprep-lean` contract

**Status:** draft. `eegprep-lean` does not exist yet.
**Lives here because** ADR 0069 says this project owns the seam, and because eegprep gitignores
its own `.context/`. The normative parts move into eegprep's `docs/source/` when the package ships.
**Owner:** Seyed Yahya Shirazi
**Mandated by:** [ADR 0069](decisions/0069-the-browser-runtime-is-its-own-package-and-eegprep-stays-whole.md),
which names this contract as the deliverable rather than a side effect.

ADR 0069 decided that eegprep stays whole and the browser runtime becomes a second distribution,
`eegprep-lean`, published from the eegprep repository.
Two distributions that implement the same operation can disagree,
and the disagreement surfaces as a result that differs between a browser and a workstation,
which is the worst kind of bug to chase.
So this document exists before the package does.

**Divergence is allowed. Undeclared divergence is not.**
That is the whole rule. Everything below is either a guarantee or a declared difference.

## What is settled, and what is still open

Settled, and not to be reopened without superseding the decision that settled it:

| | Where |
|---|---|
| eegprep stays whole; `eegprep-lean` is a second distribution from the eegprep repository | ADR 0069 |
| `eegprep[lean]` cannot work, because a Python extra adds to a distribution's requirements and never replaces them | ADR 0069 |
| Tiers are extras of `eegprep-lean`, because every tier genuinely adds to the one beneath it | ADR 0069 |
| The plot tier is not trimmed; a rebuilt matplotlib wheel saves about 2.5 MB and is not worth it below roughly 8 MB | ADR 0069 |
| `eegprep-lean` owns the browser reader, not nemar-cli | decided 2026-09-20; see below |

Open, and named here so they are not settled by accident:

1. The exact package list of the base tier. ADR 0069 measured 12 packages and 4.2 MB; the
   membership has not been written down.
2. Whether `pillow` and `fonttools` are droppable from the plot tier (2.09 MB together).
   Must be proven by running the plotting with them absent, not by reading import sites.
3. What the `[ica]` tier becomes. See "ICA is not a browser capability" below.

### Why `eegprep-lean` owns the reader

The reader is bound to NEMAR's index contract, and NEMAR's index contract is stable and published,
so the coupling is to a declared interface rather than to another team's internals.
The alternative considered was putting the reader in `nemar-cli`, next to the contract it tracks.
That is not available: `nemar-cli` is a TypeScript and Bun package with no Python in it, deliberately,
and a Python reader would be the first.

The consequence is a coupling across a repository boundary, and it is managed the way the index
contract itself says to manage it: read `format_version` first and branch on it, hardcode only
what the schema declares `const`, and re-read anything the contract says may move.

This also answers #1457, which asks for a browser-Python lane in the read recipe
and worries that the widget would otherwise hand-write a reader and keep it in step by hand.
It does not have to. The recipe names `eegprep-lean`, and the reader ships as code with tests
rather than as a snippet in a string.

## What `eegprep-lean` guarantees

### The target is one interpreter, not a range

`eegprep-lean` targets Pyodide. Pyodide 0.29.5 bundles CPython 3.13.2 on `emscripten_4_0_9`,
and a browser cannot be told to run a different one.
So `requires-python`, and the floor of every **compiled** dependency, are a **ceiling** here rather
than a floor: PyPI carries no WebAssembly build, so Pyodide's bundled one is the only one a browser
can have and a floor above it cannot be satisfied.

The test is whether the package publishes a pure-Python wheel, not whether Pyodide bundles it.
A `py3-none-any` wheel means micropip fetches any version straight from PyPI and the bundled build
goes unused, so that floor costs a download and nothing more. Of the packages that matter here,
numpy, scipy, h5py and matplotlib publish none and are genuinely capped; threadpoolctl is bundled
but pure Python and is not.

This inverts the usual reading and it is invisible from the code, which is why
eegprep's `tests/test_browser_dependency_floors.py` (sccn/eegprep#399, corrected in #402) enforces
it for the compiled set, and why `eegprep-lean` inherits the same test.

### Numerical agreement with eegprep

Where `eegprep-lean` and eegprep implement the same operation, they agree to within the tolerance
each operation declares, and the tolerance is part of this contract rather than an implementation
detail. Where they cannot agree, the difference is listed under "Declared divergences".

The mechanism is not a second implementation. Both distributions are built from the eegprep repository's
source tree, so the science code is shared and the seam is in packaging, not in algorithms.
A divergence therefore has to come from a dependency that differs, a tier that is absent, or the
platform itself, and each of those is enumerable.

### Reading a NEMAR dataset

The reader conforms to NEMAR's published index contract
(`https://docs.nemar.org/platform/zarr/index-contract/`), and specifically:

- It reads `format_version` first and branches on it.
  Format v3 is current; older indexes coexist until a dataset reconverts, so a reader that assumes
  v3 is wrong rather than merely unlucky.
- `contract_base` is the only URL it hardcodes.
- `data_base` is re-read from the document on every use, never cached across runs and never
  assumed, because it may move independently of `contract_base`.
- It uses `layout` rather than probing: `level0` is `<zarr>/<group>/0` and `view` is
  `<zarr>/<group>/view/<L>`, both relative to `contract_base`, and both declared `const` in the
  schema, so they may be hardcoded once `format_version` has been checked.
- It applies `scale_offset`: physical values are `digital * scale + offset` from the level-0 array
  attributes. A reader that returns digital counts is wrong in a way no exception reports.
- It treats `store_count` as authoritative over `stores.length`.
- It never falls back to a directory listing. Anonymous `ListBucket` is denied on the serving
  bucket, including at the root, so there is nothing to list and a 403 does not mean absence.

### The browser reader is async, all the way down

This is a hard constraint, not a preference, and it was measured rather than assumed
(OpenScience-Collective/osa#375, reported in #1457):

- `zarr.open(...)` is the synchronous API. It calls `zarr.core.sync._get_loop()`, which starts an
  IO thread, and Pyodide's main thread raises `RuntimeError: can't start new thread`.
  The traceback names threads, not zarr and not the browser, so this failure does not explain itself.
- `zarr.api.asynchronous.open_group` with `AsyncArray.getitem` works, on the event loop that is
  already running.

So the reader is async end to end, and a synchronous convenience wrapper is **not** offered:
one would have to start a loop, which is the thing that cannot be done.
This is the single largest divergence from eegprep and it is structural.

Transport is a read-only `zarr.abc.store.Store` over `pyodide.http.pyfetch`, mapping
`RangeByteRequest`, `OffsetByteRequest` and `SuffixByteRequest` onto HTTP `Range`.
Suffix ranges work cross-origin, which the sharding codec needs for the shard index.
`s3fs` and `aiohttp` are not used and are not dependencies.

### Installation in the browser

zarr installs as `micropip.install("zarr==3.4.0", deps=False)`.
The `deps=False` is not an optimization: zarr's `numcodecs>=0.14` pin is metadata, and numcodecs
publishes no emscripten wheel at any version, so a normal install fails on a dependency the code
does not need at runtime for these stores.
A pure-Python CRC-32C stands in for `google_crc32c`.

These are exactly the facts that make a hand-written install line in a recipe fragile,
and they belong in `eegprep-lean`'s own lockfile rather than in a snippet.

## The tiers

From ADR 0069, measured against the Pyodide 0.29.5 distribution, each tier adding to the one below it:

| install | packages | download | what it buys |
|---|---|---|---|
| `eegprep-lean` | 12 | 4.2 MB | read a window of data |
| `eegprep-lean[plot]` | 22 | 14.0 MB | and draw it, adding matplotlib |
| `eegprep-lean[preprocess]` | 23 | 30.4 MB | and filter and resample it, adding scipy |

Plotting is deliberately not in the base.
It is the first thing a person asks for after looking at data, and it costs 9.8 MB,
so a session that only reads pays 4.2 MB and matplotlib arrives when a plot is actually asked for.

### ICA is not a browser capability

ADR 0069's fourth tier was `[ica]`, described as adding `python-picard`. That is wrong for a
browser and the ADR already carries the correction. Recorded here because this is the document a
reader of `eegprep-lean` will consult:

- Phase 2's benchmark gate rejected picard as the browser default
  (`picard_browser_default_retained=false`).
- The browser ICA that exists routes `runica` through `scipy.linalg.blas`, and scipy is already
  in `[preprocess]`, so the tier adds nothing a browser uses.
- More decisively, **ICA does not finish**. For 64 channels by 60 seconds at 250 Hz, runica took
  680 seconds under Pyodide against 467 native, and picard 109 seconds against 10 native, with
  neither converging within 512 iterations. The design note's default execution budget is
  `exec_seconds: 120`.

So `eegprep-lean` does not offer ICA in the browser, and a caller asking for it gets a refusal
that says so, rather than a run that exceeds its budget and is killed.
This is the strongest argument for serving precomputed decompositions instead of computing them,
which is the direction NEMAR is going.

## Declared divergences

Every row is a behavior that differs from eegprep on purpose. This table is the deliverable.

| Area | eegprep | `eegprep-lean` | Why |
|---|---|---|---|
| Input | local files, many formats, through mne and neo | one NEMAR Zarr store over HTTP | the format readers are most of the 62.6 MB |
| Reading | synchronous | **async only**, no sync wrapper | Pyodide's main thread cannot start the IO thread zarr's sync API needs |
| ICA | available | **refused**, with a message | does not converge inside a browser execution budget |
| Plotting | always present | `[plot]` extra | 9.8 MB, and only when a plot is asked for |
| Filtering, resampling | always present | `[preprocess]` extra | scipy is 16.4 MB |
| Export | EEGLAB `.set` and others via mne and eeglabio | not offered | writing is not a browser lane; see below |
| Python floor | `>=3.12`, tested on 3.12 and 3.13 | pinned to what Pyodide bundles | a browser runs one interpreter |

Writing is listed as not offered rather than left unsaid, because a user who can read a dataset in
a browser will reasonably expect to save from it, and discovering the absence by hitting it is the
failure mode this contract exists to prevent.

## What would make this contract wrong

Stated plainly so it can be checked rather than believed:

- A Pyodide release that bundles a different CPython. The floors and `requires-python` are pinned
  to 3.13.2 today; the tests named above fail loudly if a floor drifts above what is bundled,
  but a *new* Pyodide is a deliberate migration.
- A new `format_version` of the NEMAR index. The reader branches on it, so a new version is a
  change to make, not a break to discover.
- zarr 3 gaining a working synchronous path under Pyodide, which would remove the largest declared
  divergence.
- ICA converging inside a browser budget, which would reopen the `[ica]` tier.

## Receipts

- ADR 0069, the packaging decision this implements.
- sccn/eegprep#395, the per-dependency audit and the four-tier footprint table.
- sccn/eegprep#399, which pins the floors to what Pyodide 0.29.5 ships and adds
  `tests/test_browser_dependency_floors.py`.
- sccn/eegprep#400, the epic gate that checks package names and not versions.
- #1457, the browser lane that needs this reader.
- OpenScience-Collective/osa#375, where the async-only finding was measured.
- eegprep's `docs/source/pyodide_benchmark.md` and sccn/eegprep#324, for the ICA timings.
- `https://docs.nemar.org/platform/zarr/index-contract/`, the contract the reader conforms to.
