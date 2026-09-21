# ADR 0070: The browser recipe names eegprep-lean and carries no install line

**Status:** accepted
**Date:** 2026-09-21
**Owner:** Seyed Yahya Shirazi

## Context

`read_window` hands the model a `how_to` block of ready-to-run snippets.
Until now it had two lanes, and the one labeled Python could not run where compute runs by
default (ADR 0049):
`zarr.open` is the synchronous API, it starts an IO thread, and Pyodide's main thread cannot
start one.
The failure is `RuntimeError: can't start new thread`, which names neither zarr nor the browser
(OpenScience-Collective/osa#375, nemarOrg/nemar-cli#1457).

A browser lane therefore has to be asynchronous throughout and read HTTPS range requests rather
than `s3://`.
Both of those are exactly what `eegprep-lean` does (ADR 0069), so the lane either names that
package or restates its reader inside a string in this repository.

Two constraints bound how the package reaches the browser.
It is **not** on the Python Package Index, and publishing a second distribution name needs the
eegprep project owner's agreement, so a snippet cannot install it from there.
And `micropip.install(url)` is a browser `fetch`, so any URL it is given must send
`access-control-allow-origin`.
Measured on 2026-09-21: `files.pythonhosted.org`, `raw.githubusercontent.com` and
`cdn.jsdelivr.net` all send `*`, while **GitHub release assets send none**, because a release
download 302s to `release-assets.githubusercontent.com` with a signed URL and no CORS header.
The obvious way to ship a wheel without the Package Index does not work in a browser.

## Decision

The `python_browser` lane names `eegprep-lean` and calls its asynchronous API against the
recipe's `array_path`.
It **carries no install line**: the runtime that executes the snippet pins and installs the
package, and serves the wheel from its own origin, where CORS does not apply.

## Consequences

The reader exists once, in `eegprep-lean`, and this repository publishes the contract it reads
rather than a second implementation of it.
A change to the index contract is followed in one place.

The snippet is not self-contained, which is a real cost: pasted into a bare Pyodide session with
no runtime behind it, it fails at the import.
That is the honest trade, because the alternative is a snippet that claims to install something
the Package Index does not have.

The executing runtime now owns a version pin, and a runtime pinning an old wheel is a divergence
nothing in this repository can see.
That is the obligation this creates, and the lockfile is where it is managed.

`how_to` is `.passthrough()` on both the zod 3 contract and the zod 4 mirror, so adding the lane
breaks no existing client. That same property means a lane added to one copy and not the other is
invisible to an accept/reject drift test, so the parity suite compares the copies' **declared**
lane names directly, and against a written-out list, so dropping a lane from both still fails.

## Alternatives considered

- **Inline a reader in the snippet.** A read-only `zarr.abc.store.Store` over
  `pyodide.http.pyfetch` is about sixty lines and works today with only zarr installed, needing no
  package and no hosting decision. It lost because it is a third hand-written copy of a reader
  bound to the index contract, and the half that drifts is the half a human maintains. That is the
  two-copies problem this epic exists to stop paying, one repository boundary further out.
- **Publish `eegprep-lean` to the Package Index and install it in the snippet.** The cleanest
  snippet, and still the likely end state. It lost for now because publishing a second
  distribution name is the project owner's call and needs a one-time trusted-publisher setup;
  the lane can switch to it later without changing shape.
- **Install from a GitHub release asset.** Ruled out by measurement rather than by preference:
  release assets send no `access-control-allow-origin`, so `micropip.install` of one is blocked in
  a browser.
- **Serve the wheel from a nemar.org host with CORS.** Consistent with the rule that the contract
  is `zarr.nemar.org` and not the redirect behind it, and it would put wheel fetches in the same
  accounting as chunk reads. It lost on cost: it is new public infrastructure, and a same-origin
  asset in the runtime needs none of it.

## Receipts

- nemarOrg/nemar-cli#1457, the issue, including the Pyodide measurements.
- OpenScience-Collective/osa#375, where the threading failure was measured in Chrome.
- ADR 0049 (compute runs in the browser), ADR 0069 (the browser runtime is its own package),
  ADR 0027 (Zarr discovery is raw-only).
- sccn/eegprep#406, #408, #409 (the package), #411 (the wheel build).
- `shared/contract/mcp.ts` and `backend/src/mcp/schemas.ts` carry the lane; both must change
  together, and `backend/test/mcp-schema-parity.test.ts` enforces that.
