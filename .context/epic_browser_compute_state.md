# Epic state: in-browser compute

> **STATUS: CURRENT.** The live map of an epic that runs across four repositories.
> Decisions live in [`decisions/`](decisions/README.md); where this document and an ADR disagree,
> the ADR wins. This document holds the state, the order of work, and the questions still open.

**Last verified:** 2026-09-20.

**How to verify a row, and how the first version of this file got it wrong.** Issue state is not
work state. This document's first version reported four eegprep phases as open because their
issues were open, when every phase pull request had already merged into the epic branch and the
issues stay open until the epic lands on `develop`. It then said it had been "verified by querying
each repository", which made a stale reading look rigorous. So every row below names what it was
checked against: **issue state**, **PR state**, or **a file on a branch**. Prefer the last.

## What the epic is

A person looking at a NEMAR dataset should be able to run analysis on it without installing
anything and without the data leaving the browser. The assistant proposes code, the browser
executes it against data it already has, and the result, including figures, goes back to the model
so it can read what it produced and iterate.

Four repositories carry a piece of it. None of them is the whole thing, which is why this file
exists: the pieces were being decided in four issue trackers and one chat transcript.

| Repository | Its piece |
|---|---|
| `OpenScience-Collective/osa` | The assistant: the tool the model calls, the transport that carries code out and results back, the widget the person sees. |
| `sccn/eegprep` | The science: the preprocessing itself, and a runtime small enough to reach a browser. |
| `nemarOrg/nemar-cli` | The data plane and the recipes: what a dataset exposes, and the code the assistant hands out to read it. |
| `nemarOrg/website` | Where a person meets all of it. |

## Decisions already made, and not to be reopened without new evidence

Each of these cost real work to settle. They are recorded so the next session does not re-argue
them from memory, which has already nearly happened twice.

| Decision | Where it is recorded |
|---|---|
| The browser runtime is its own distribution, `eegprep-lean`, published from the eegprep repository. eegprep stays whole and its default install is unchanged. | [ADR 0069](decisions/0069-the-browser-runtime-is-its-own-package-and-eegprep-stays-whole.md) |
| `eegprep[lean]` cannot work: a Python extra adds to a distribution's requirements and never replaces them. Tiers hang off the lean distribution instead. | ADR 0069 |
| The plot tier is not trimmed. matplotlib is 62 percent bundled fonts, a rebuilt wheel saves 2.47 MB, and that does not pay for a maintained wheel plus a declared font divergence. Reopen only at a saving near 8 MB. | ADR 0069 |
| mne, pybids, h5py and neo stay in eegprep. An import-site audit cannot prove a dependency is removable: `eeglabio` has no import site and is still required, because mne imports it to write an EEGLAB file. | sccn/eegprep#395, closed with the reasoning |
| Images ride on a tool result. All four block spellings normalize to one Anthropic image block, and both offered models read a figure returned that way. `image/svg+xml` passes every local layer and fails as a 400 at the endpoint. | OpenScience-Collective/osa#421, merged |
| The transport is two-run continuation: no LangGraph `interrupt()`, no checkpointer. The browser executes between run 1 and run 2 with no request open. | `osa/.context/browser-execution-tool-design.md` |
| No second notebook platform. The marimo and JupyterLite comparison was run on 2026-09-16 and neither is adopted; the notebook surface is an editable re-run panel in the widget against the same warm worker. | osa#423 carries the recovered verdict, still to be written into the design note |

## Current state, per repository

### OpenScience-Collective/osa

Three files carry almost all of this, and a newcomer cannot find them from the issues alone:
`src/api/routers/community.py` (the session store and both chat paths),
`workers/osa-worker/index.js` (the edge: routing, Turnstile, rate limits) and
`frontend/osa-chat-widget.js` (the widget). Every Phase 0 item below touches at least one.

Phase 0 of `.context/browser-execution-tool-design.md` lists six prerequisites that the design
assumed and that do not hold against deployed code. None of Phase 1 works end to end until they
are settled.

| Item | State |
|---|---|
| 1. The 120-second abort is not a constraint under two-run | settled in the note. **Do not raise it.** |
| 2. The resume endpoint 404s at the edge (worker routes by a two-segment matcher) | open, needs a worker route and a deploy to both environments |
| 3. Turnstile makes the resume POST unauthenticatable as designed | open, latent until Turnstile is switched on, fatal that day |
| 4. Rate limits are consumed per resume: one turn with N executions is 1 + N requests | open, needs an exemption or a restated budget |
| 5. No checkpointer, and the graph is compiled per request | open, request-path refactor |
| 6. Conversation state would have two owners | **#422, in progress, this is the current work** |

Other open work: **#423** (write the marimo verdict into the design note), **#406** (shared
`cache_control` marker budget helper, needed before Phase 2 cache work), **#370** (rewrite the
NEMAR assistant config for the full MCP tool surface, which gates the nemar-cli promotion).

Merged: **#421**, which answered whether a figure can ride on a tool result.

### sccn/eegprep

Epic **#324**, "eegprep in the browser (Pyodide) with a small ONNX ICLabel", on branch
`epic/324-pyodide-browser`.

**All six phases are built and merged into the epic branch.** Their issues are open only because
the epic workflow closes them when the epic reaches `develop`, which is the trap described above.

| Phase | Issue | PR into the epic branch | Verified by |
|---|---|---|---|
| 1. oct2py, psutil, pyedflib out of the base install | #374 | #380 merged | PR state |
| 2. Pyodide harness, CI, ICA benchmark gate | #375 | #382 merged | PR state |
| 3. runica float64 products through dgemm | #376 | #385 merged | PR state |
| 4. Export ICLabel to ONNX, native onnxruntime | #377 | #381 merged | PR state |
| 5. Async ICLabel browser execution | #378 | #384 merged | PR state |
| 6. Quantize ICLabel with a frozen parity gate | #379 | #383 merged | PR state |

Phase 6 has shipped rather than being planned: `src/eegprep/plugins/ICLabel/iclabel.onnx` on the
epic branch is **2,932,897 bytes**, int8, and `netICL.mat` (10,815,192 bytes) is excluded from the
wheel rather than deleted from the tree. The roughly 8 MB saving this document previously described
as future work is already realized. Verified by reading the branch.

Phase 5's async entry point is decided and implemented, not open: `iclabel_async` and
`pop_iclabel_async`, with the synchronous names raising under Emscripten. Verified by reading
`src/eegprep/plugins/ICLabel/iclabel.py` on the branch.

**PR #386** (epic to develop) is open and **deliberately held**: do not merge it until something
actually needs it. **PR #387** patches review findings into the epic branch.

**PR #397** is open and green on all five test jobs: it fixes #396, a defect where `pop_resample`
computed a wrong ratio for non-integer sampling rates, 24 of 86 realistic pairs, worst case 117.04 Hz
labeled 128 Hz. It also drops `sympy`, whose only caller was the defect.

New work this decision creates: **`eegprep-lean` does not exist yet.** Its contract is the first
deliverable, per ADR 0069.

#### Browser ICA does not finish, and that is a product constraint

Phase 2's benchmark, recorded on #324 and in `docs/source/pyodide_benchmark.md`: for 64 channels
by 60 seconds at 250 Hz, **runica took 680 seconds under Pyodide** against 467 native, and
**picard took 109 seconds** against 10 native, with neither converging within 512 iterations. The
recorded verdicts were `picard_browser_default_retained=false` and `phase3_recommended=false`,
which is why Phase 3 was narrowed to float64 dgemm only.

The design note's default execution budget is `exec_seconds: 120`. So **ICA cannot complete inside
a browser execution as currently budgeted.** Either the tool gets a per-call budget and the
assistant's prompt says plainly that ICA takes minutes, or ICA is out of the first browser lane and
the prompt says that instead. Neither is written anywhere the prompt will read it, and this is the
single most product-relevant number in the epic. It also strengthens the case for serving
precomputed weights rather than computing them in the browser.

#### ICLabel is backbone capability, not a separate product

Phases 4, 5 and 6 are not "doing the browser". They are the capability that makes it possible to
run ICLabel in a browser at all, built once and used by whatever surface asks for it.

Two consequences that are easy to get wrong, and that the tier tables do not show:

- **It costs nothing in the *Python* download budget, which is not the same as being free.**
  `onnxruntime` has no WebAssembly build, so the browser path goes through ONNX Runtime Web, which
  is JavaScript, and no package tier grows. But ORT Web brings its own runtime:
  `ort-wasm-simd-threaded.wasm` is about **11.2 MB** (the WebGPU build is 21.7 MB), on top of the
  2.9 MB model. That is more than the entire read-and-plot tier, it appears in no table in this
  document or in the design note, and the design note does not mention `onnxruntime-web` at all.
  An earlier version of this section said ICLabel "costs nothing in the Python download budget"
  without that second sentence, which was true and thoroughly misleading.
- **It does cost a model artifact**, and that is where the real megabytes are. The network is about
  2.9 M parameters, roughly 11.6 MB at float32, consistent with the 10.8 MB `netICL.mat` in the
  wheel today. Phase 6 quantizes it to int8 and **ships int8 everywhere, native and browser, as one
  artifact with one set of numbers to validate** (decided on #324). That is a saving of roughly
  8 MB, which is worth putting beside the matplotlib trim rejected in ADR 0069 at 2.47 MB: this is
  the scale at which shrinking something pays for the work it costs.

  **4-bit is under investigation**, against an owner target near 3-4 MB. Note that the arithmetic
  does not obviously agree with the target, since int8 should land near 2.9 MB and int4 near
  1.5 MB, so part of that work is establishing the real numbers and explaining the gap. Viability
  turns on whether ONNX Runtime Web can execute 4-bit today, not on whether ONNX can represent it,
  and on per-class parity rather than aggregate accuracy: a quantization that holds overall
  accuracy while degrading one clinically meaningful class has failed.

**ICA and ICLabel are two capabilities, not two stages of one.** ICA decomposes a recording into
components and is the expensive half; ICLabel classifies components that already exist and is the
cheap half. Keeping them apart is a NEMAR product decision, not a packaging convenience: the
intention is to **serve precomputed ICA weights alongside a dataset**, so that a person in a browser
loads a decomposition rather than computing one, and then chooses whether to run ICLabel over it.

That changes what the browser has to be able to do. On the NEMAR path it needs to read data, read
weights, classify, and plot. Computing ICA in the browser becomes the case for someone working on
their own recording rather than the common path, which lowers the stakes on #376 (`runica` through
`scipy.linalg.blas` under Emscripten) for NEMAR specifically without making it unnecessary in
general.

It also creates work that is in no tracker yet: **the data plane has to serve ICA weights.** See the
nemar-cli section below.

The seam it creates is not size, it is synchrony. `iclabel()` and `pop_iclabel()` are synchronous
and reachable from the GUI menus and from `eegprep-console`, while ONNX Runtime Web returns a
promise that has to be awaited. Phase 5 has to decide what the async entry point is called, and
whether the synchronous `pop_iclabel` raises a clear error under Emscripten rather than silently
blocking. **That is a declared divergence in exactly ADR 0069's sense**, and it belongs in the
`eegprep-lean` contract when that is written: the same call behaves differently on the two paths,
and the contract says so rather than letting a user discover it.

### nemarOrg/nemar-cli

**Precomputed ICA weights are a new data-plane capability with no issue yet.** The intention is to
serve a decomposition alongside a dataset so a browser session loads weights instead of computing
them. See "What is coming" below: this is not near-term work, but it is near enough that the
current design should not foreclose it.

**#1457** is open: `read_window`'s Python recipe emits
`zarr.open("s3://...", storage_options={"anon": True})`, which cannot run in a browser, which is
the lane the recipe exists for. It is downstream of `eegprep-lean` and cannot be finished first.

`dev` is 32 commits ahead of `main`. The promotion is gated on osa#370 shipping with it.

### nemarOrg/website

Nothing in this epic is blocked on the website yet. Adjacent and worth knowing about: **#161**,
in-browser BIDS validation, which is the same "compute in the browser" shape.

## What blocks what

```
osa Phase 0 items 2,3,4,5,6 ─┬─> osa Phase 1 (tool-result contract, resume route)
                             └─> osa Phase 2 (widget, execution, approval UI)

ADR 0069 ─> eegprep-lean contract ─> eegprep-lean package ─> nemar-cli#1457 (recipe targets it)

eegprep epic #324 phase 4 ─> phase 5 (ORT Web, async) ─┬─> ICLabel runs in a browser
                          └─> phase 6 (int8)         ─┘
                                     (independent of the OSA track)

osa#370 ──> nemar-cli dev to main promotion
```

The two tracks meet **twice**, not once, and this document previously showed only the first.

1. **At the recipe** in nemar-cli#1457, which is the obvious one.
2. **At a JavaScript global.** The browser ICLabel path does `from js import eegprep_iclabel_web`
   and expects a host-registered object with a promise-returning `run(...)`. That host is OSA's
   widget: it has to load ONNX Runtime Web, register the global, and get the model bytes to it
   before Python imports anything, while the model lives inside a Python wheel. Who delivers those
   bytes is an open seam on #378 itself. So "a JavaScript runtime dependency" belongs on the list
   of things a community brings, which the design note currently limits to a lockfile, allowlists,
   prompt guidance and an optional Python helper.

## What is coming, and what it constrains now

Not available today, and not this epic's work, but close enough that designing against its absence
would be a mistake.

When NEMAR connects to a supercomputer and runs **first-party pipelines**, their outputs become
products in their own right. Precomputed **ICA weights** are one. **Processed or derived data** is
another. These are intended to be a significant part of what NEMAR offers, not a side effect of
this epic, and people would consume them without ever running the pipeline themselves.

**The precedent for this already exists here, and it is not the obvious one.** The Zarr serving
copy is already a first-party derived artifact: produced by a conversion engine this repository
owns (ADR 0029), stamped with which engine produced it (ADR 0033), versioned, and served on its
own path rather than out of the dataset's git tree. That is the shape a pipeline product needs,
and it already works.

What would be the wrong precedent is ADR 0066's git brokering. That decision is explicit that the
Worker brokers **git-tracked files** and that **the manifest is the capability list**, built from
the dataset's own version document. A supercomputer pipeline output is not git-tracked and has no
manifest entry, so it cannot be served that way without either committing large derived binaries
into every dataset repository or weakening the rule that closes the confused-deputy hole. Neither
is acceptable. Derived products need their own capability list, holding ADR 0066's five rules,
rather than an exception carved into that one.

**What this constrains in the work happening now:**

- The `eegprep-lean` contract should describe reading **a derived artifact**, not specifically ICA
  weights. The first one is weights; the second will not be.
- The recipe surface in nemar-cli#1457 should be able to name a derived product as an input, for
  the same reason.
- Provenance is not optional for these. A decomposition or a preprocessing run is only meaningful
  against the exact dataset version it was computed from, and the engine stamp on Zarr conversions
  is the existing answer to that question in this codebase. Reuse it rather than inventing a second
  provenance story.

## Open questions, not yet decided

1. **Does a figure persist in session history, or only for the continuation?** Raised in osa#422
   and explicitly out of its scope. It is a memory question: 1000 sessions per community, each
   holding a few spectrograms at 430,440 base64 characters, is a different budget from the current
   text-only one. It is also a token question, since every retained figure is re-sent on every
   later turn.
2. **What does `eegprep-lean` guarantee, and where does it deliberately differ from eegprep?**
   ADR 0069 names the contract as the deliverable rather than a side effect. Undeclared divergence
   is the failure mode it exists to prevent.
3. **Whether `pillow` and `fonttools` are droppable from the plot tier** (2.09 MB). Plausible for a
   PNG-only path, and must be proven the `eeglabio` way, by running the plotting with them absent.
4. ~~Whether the `[ica]` tier is right for a browser.~~ **Answered: it is not.** ADR 0069's
   `[ica]` tier adds `python-picard` and its 5.6 MB of scikit-learn for a path Phase 2's benchmark
   gate explicitly rejected as the browser default. The browser ICA that exists is `runica` through
   `scipy.linalg.blas`, and scipy is already in `[preprocess]`. The ADR's tier table needs
   correcting now rather than when `eegprep-lean` is built.
5. **How precomputed ICA weights are versioned against the dataset they came from.** A
   decomposition is only valid for the data it was computed on, and NEMAR datasets are versioned
   and revisable. Getting this wrong means someone classifies components that do not belong to the
   recording they are looking at, silently.

## Working rules that have already earned themselves

- **A verdict in a chat transcript is not a decision.** The marimo comparison was run, recorded
  nowhere, and nearly reversed from memory a week later. Write decisions where they bind.
- **"Declared but not imported" is a hypothesis, not a finding.** Prove a dependency is removable
  by running the suite in an environment that genuinely lacks it.
- **Measure the fixture before blaming the transport.** Four consecutive live-test failures in
  osa#421 looked like broken image transport and were all the test's own fixture.
