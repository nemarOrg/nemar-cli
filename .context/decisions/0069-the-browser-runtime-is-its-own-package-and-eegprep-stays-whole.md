# ADR 0069: The browser runtime is its own package, and eegprep stays whole

**Status:** accepted
**Date:** 2026-09-20
**Owner:** Seyed Yahya Shirazi

## Context

In-browser compute needs a Python runtime that Pyodide can download in seconds.
Measured against the Pyodide 0.29.5 distribution, eegprep's base install is 61 packages and 62.6 MB,
while reading a window of data needs 12 packages and 4.2 MB.
Plotting brings that to 14.0 MB, preprocessing to 30.4 MB, and independent component analysis to 36.3 MB.

The obvious move is to trim eegprep: send mne, pybids, h5py and neo to extras and lazy-import them.
Measuring that plan found two things against it.
Lazy imports save startup time and not download bytes, because micropip installs the declared closure either way,
so only moving a package to an extra actually reduces the download.
And an import-site audit cannot tell which packages are safe to move:
`eeglabio` has no import site anywhere in eegprep and is still load-bearing,
because mne imports it when asked to write an EEGLAB file,
which 12 tests proved on every supported platform after it was removed.
Every candidate would need the same proof, and a package whose default install shrinks
is a package whose existing users get less than they had.

## Decision

eegprep stays whole.
Its default install keeps every dependency it has today, so `pip install eegprep` is unchanged and no existing user is disturbed.
The browser runtime becomes a separate distribution, `eegprep-lean`, built to a download budget rather than trimmed down to one.
It is published from the eegprep repository, not a new one: same source tree, same tests, same maintainers.
eegprep depends on it and re-exports it, so `pip install eegprep` is a superset of what it installs today
and the science code is not forked into two copies that drift.

This project owns the seam between the two: a declared contract, with any divergence in behavior
written down in that contract rather than discovered by a user who hit it.

### Why not `eegprep[lean]`

Because an extra cannot subtract.
`pip install eegprep[lean]` resolves eegprep's own requirements first and then adds whatever `lean` declares,
so an extra by that name would install the whole 62.6 MB and then some, which is the opposite of what it says.
micropip resolves the same way, so the browser gets no relief either.
A genuinely small install needs a distribution whose *base* is small, and that is either a lean eegprep,
which changes what every existing user gets from an unchanged command, or a second name.
This is the second name.

### The tiers are extras, which is what extras are for

The lean distribution is layered by what a session actually does, each tier adding to the one below it,
measured against the Pyodide 0.29.5 distribution:

| install | packages | download | what it buys |
|---|---|---|---|
| `eegprep-lean` | 12 | 4.2 MB | read a window of data |
| `eegprep-lean[plot]` | 22 | 14.0 MB | and draw it, adding matplotlib |
| `eegprep-lean[preprocess]` | 23 | 30.4 MB | and filter and resample it, adding scipy |
| `eegprep-lean[ica]` | 27 | 36.3 MB | and decompose it, adding python-picard |

Plotting is the tier that matters most for pacing, because it is the first thing a person asks for after looking at data
and it costs 9.8 MB. It is deliberately not in the base: a session that only reads pays 4.2 MB,
and matplotlib arrives when a plot is actually asked for.
Extras are additive here, which is exactly right, because every tier genuinely adds to the one beneath it.

## Consequences

The scientific package stops being asked to be two things at once, and its dependency list stops being a budget.
The lean package is free to be aggressive about size, because it never has to satisfy eegprep's full test suite,
and eegprep is free to depend on whatever the science needs.

The cost is a seam, and seams drift.
Two implementations of the same operation can disagree, and the disagreement will surface as a result
that differs between the browser and a workstation, which is the worst kind of bug to chase.
So the contract is the deliverable, not a side effect:
where the two paths implement the same operation, the contract says so and says how they differ,
and where the lean path cannot do something at all it says that too.
Divergence is allowed. Undeclared divergence is not.

There is also a second artifact to release, version and support.

## Alternatives considered

- **Move mne, pybids, h5py and neo to eegprep extras.** The original plan, from the measurements in sccn/eegprep#395. It shrinks the default install, which changes what existing users get from an unchanged command, and every move needs proof that nothing reaches the package through another library. Rejected: the risk lands on the scientific package's users to buy a smaller browser download.
- **Make eegprep lean and publish a large bundle beside it.** Same shrinking of the default install, with the breakage concentrated in one release rather than spread over several. Rejected for the same reason.
- **One repository, two published distributions.** Keeps the science unforked, but the release pipeline carries the split and CI has to prove both. Held in reserve: this is where to go if the seam turns out to be thinner than expected.
- **An `eegprep[lean]` extra.** The name everyone reaches for first, and it cannot work: extras add to a distribution's requirements and never replace them, so the base install arrives before the extra does. Worth stating in full here because it is the proposal that will come back.
- **A separate repository.** Cleanest boundary, and rejected as too clean: the lean runtime and the full package share science code, and a repository boundary is where shared code goes to be copied. One repository, two distributions, keeps them honest.
- **Lazy imports alone.** Does not reduce the download at all, because micropip installs the declared closure whether or not the module is imported. Rejected on measurement.

## Receipts

- sccn/eegprep#395, the per-dependency audit, its four-tier footprint table, and the correction recording that `eeglabio` is reached through mne and is not removable.
- sccn/eegprep#397, which removes sympy, the one dependency the audit found that genuinely had no caller, and fixes the resampling defect that finding exposed.
- `phase/374-extras-split`, already in `epic/324-pyodide-browser`, which moved oct2py, psutil and pyedflib out of the base install. That work stands; this decision is about where the line stops.
- nemarOrg/nemar-cli#1457, the browser lane that needs this runtime.
- OpenScience-Collective/osa `.context/browser-execution-tool-design.md`, which consumes it.
