# Epic state: in-browser compute

> **STATUS: CURRENT.** The live map of an epic that runs across four repositories.
> Decisions live in [`decisions/`](decisions/README.md); where this document and an ADR disagree,
> the ADR wins. This document holds the state, the order of work, and the questions still open.

**Last verified:** 2026-09-20, by querying each repository rather than from memory.

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

| Phase | Issue | State |
|---|---|---|
| 1. oct2py, psutil, pyedflib out of the base install | #374 | closed, in the epic branch |
| 2. Pyodide harness, CI, ICA benchmark gate | #375 | open |
| 3. runica matmuls through scipy BLAS under Emscripten | #376 | open |
| 4. Export ICLabel to ONNX, native onnxruntime | #377 | closed |
| 5. Browser ICLabel via ONNX Runtime Web | #378 | open |
| 6. Quantize ICLabel to int8 with a parity repo | #379 | open |

**PR #386** (epic to develop) is open and **deliberately held**: do not merge it until something
actually needs it. **PR #387** patches review findings into the epic branch.

**PR #397** is open and green on all five test jobs: it fixes #396, a defect where `pop_resample`
computed a wrong ratio for non-integer sampling rates, 24 of 86 realistic pairs, worst case 117.04 Hz
labeled 128 Hz. It also drops `sympy`, whose only caller was the defect.

New work this decision creates: **`eegprep-lean` does not exist yet.** Its contract is the first
deliverable, per ADR 0069.

### nemarOrg/nemar-cli

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

eegprep epic #324 phases 2,3,5,6 ─> ICLabel in the browser
                                     (independent of the OSA track)

osa#370 ──> nemar-cli dev to main promotion
```

The two tracks, OSA's transport and eegprep's runtime, are independent until the widget needs
something real to run. They meet at the recipe in nemar-cli#1457.

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
4. **Where the ICLabel work meets the lean runtime.** The eegprep epic is building browser ICLabel
   on its own track; ADR 0069 has not been applied to it.

## Working rules that have already earned themselves

- **A verdict in a chat transcript is not a decision.** The marimo comparison was run, recorded
  nowhere, and nearly reversed from memory a week later. Write decisions where they bind.
- **"Declared but not imported" is a hypothesis, not a finding.** Prove a dependency is removable
  by running the suite in an environment that genuinely lacks it.
- **Measure the fixture before blaming the transport.** Four consecutive live-test failures in
  osa#421 looked like broken image transport and were all the test's own fixture.
