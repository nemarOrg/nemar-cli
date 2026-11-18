# ADR 0128: The Zarr serving copy is not an NWB container

**Status:** accepted
**Date:** 2026-11-18
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR was asked to adopt Neurodata Without Borders (NWB) on Zarr (`hdmf-zarr`) for its Zarr serving copy.
The serving copy is a derived, lossy, latest-only representation of one raw recording (rate-capped, quantized to `int16` with a per-channel scale and offset, no subject information), generated from the BIDS dataset at `source_commit`; the BIDS dataset is the record.
NWB is designed as the complete archival record of a session and requires session, subject and device context in the file.
The question will come back, from users and from funders, so the answer needs to be written down once.

## Decision

The serving copy is not an NWB container and will not be made NWB-conformant.
Stores embed only derived technical metadata needed to decode and interpret the signal, generated in the same pass as the samples and never edited afterward.
Any NWB output NEMAR ever produces is a stateless export generated on request from the store and the BIDS dataset at `source_commit`, never a second stored copy.

The reasons, in order:

1. **Separate scope.** NWB is a complete archival session record; a store is one recording's normalized signal, and BIDS stays the record. NWB conformance would copy metadata BIDS already holds, and a second copy of mutable metadata drifts.
2. **Technical incompatibility.** Time-first arrays and one conversion factor per series versus channels-first and per-channel scale and offset; typed objects linked by references, a cached schema, compound types on Zarr extension data types, and consolidated metadata that goes stale under in-place re-conversion.
3. **The NWB Zarr specification is not settled.** Its maintainers describe the backend as under development; its latest release changed the on-disk format in a way older readers cannot open; Zarr validation in the NWB tools is incomplete.

## Consequences

- The layout stays NEMAR's own and is specified separately as biosig-zarr (pre-beta page at docs.nemar.org `/formats/biosig-zarr/`), with biosigIO as one exemplar implementation.
- Two NWB ideas are aligned on purpose so conversion stays straightforward: `physical = digital * scale + offset` is NWB's `conversion` and `offset` given per channel, and event columns follow BIDS and HED, which `ndx-hed` maps onto NWB's events table.
- Embedded metadata is limited to what decodes the signal: channel labels, types and units, scale and offset, rates, power line frequency, electrode positions, and the light events group. Participant and session fields, verbatim sidecar JSON, and NWB object identifiers are never embedded.
- Revisit when any two hold: a named consumer needs NWB with a concrete tool that reads it; DANDI accepts Zarr NWB uploads and the NWB Inspector validates Zarr; `hdmf-zarr` drops its under-development status; MNE gains NWB read and write; NWB gains core scalp EEG or MEG types. Revisiting means building the stateless export, not changing the store.

## Alternatives considered

- **Adopt NWB-Zarr as the store format:** rejected for the three reasons above.
- **Store an NWB export alongside each store:** rejected; a second stored copy of metadata that drifts from BIDS.
- **Embed an NWB-shaped hint block in each store:** rejected; another mutable copy, with no reader that consumes it.

## Receipts

- Issue #2216 (`download --zarr`, `.bzx` packages), issue #2217 (format tag rename), neuromechanist/biosigio#179 (biosig-zarr to beta).
- docs.nemar.org Zarr serving copy overview, section "Why this layout, and not NWB or OME-Zarr" (nemarOrg/docs#121).
- hdmf-zarr documentation: https://hdmf-zarr.readthedocs.io/en/stable/
