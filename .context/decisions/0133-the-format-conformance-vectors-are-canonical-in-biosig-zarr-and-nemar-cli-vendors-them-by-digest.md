# ADR 0133: The format conformance vectors are canonical in biosig-zarr, and nemar-cli vendors them by digest

**Status:** accepted
**Date:** 2026-11-20
**Owner:** Seyed Yahya Shirazi

This Architecture Decision Record (ADR) partially supersedes [ADR 0124](0124-every-reader-is-held-to-one-conformance-suite-and-a-private-read-goes-through-the-readers-own-authorization.md) decision 3, as listed under "What this supersedes".
Epic #2239.

## Context

ADR 0124 decision 3 put the whole conformance suite in nemar-cli, under `shared/contract/zarr-conformance/`, and had every other repository that holds a reader copy it from there.
[ADR 0131](0131-biosig-zarr-has-its-own-home-and-packing-rules-and-its-tag-rename-waits-for-re-conversion.md) then gave the format its own repository, nemarOrg/biosig-zarr, and decision 4 there sends decisions about the specification itself to that repository.
The vectors that test the format are part of the specification: they are written from its text, reviewed through its Request for Comments (RFC) process, and read by readers that have nothing to do with NEMAR.
On 2026-11-20 the owner answered Q9 (the conformance test files live in nemarOrg/biosig-zarr, and nemar-cli vendors them by digest) and Q34 (record that now, as a lead step, not at checkpoint C3).
On the same day the owner ruled on Q33 that the version 2 schemas and vectors go on biosig-zarr `main` and are released as `2.0.1`, and the version 3 ones go on `draft/3.0.0`.

## Decision

1. **The format-level vectors are canonical in nemarOrg/biosig-zarr.**
   Its `schemas/` and `conformance/` (the vectors, `conformance/manifest.json` and the goldens) are where a change to them is made, through that repository's own process, and the only place it is made.
2. **nemar-cli vendors them byte for byte, pinned twice.**
   The copy lives in `shared/contract/zarr-conformance/biosig-zarr/` and is pinned to a biosig-zarr release tag and to the SHA-256 of that tag's `conformance/manifest.json`.
   A drift check fails when the copy differs from what the pin names, so a copy edited in place is a failing check, not a local fix.
   Every other repository that holds a reader (eegprep-lean, EEGDash) vendors from biosig-zarr the same way, not from nemar-cli.
3. **The NEMAR-profile cases stay canonical in nemar-cli.**
   The `nemar` provenance block, NEMAR's other additions to the store root, and the store content digest of ADR 0123 decision 4 with its vectors remain in nemar-cli `shared/contract/zarr-conformance/`, as ADR 0124 decision 3 says, and are copied from there.
4. **This ADR vendors nothing.**
   The first change that vendors the vectors follows it, and names the tag and the manifest digest it pins; no digest is recorded here.

## What this supersedes

In ADR 0124 decision 3, "the suite lives in nemar-cli" and the copy against nemar-cli's, for the format-level vectors only:
they are now canonical in nemarOrg/biosig-zarr, and every reader's repository, nemar-cli included, vendors them from there.
Decision 3's rule that a copy is byte for byte, pinned by digest and checked for drift, and its reason, stand and now govern the vendored copy too.
Everything else in ADR 0124 stands, decisions 1, 2 and 4 to 7 included.

## Consequences

- A format change and its vectors are made once, in biosig-zarr, and reach nemar-cli only when nemar-cli bumps its pin; nemar-cli can lag a release, never fork it.
- The suite a reader runs now has two sources, the vendored format vectors and the NEMAR-profile cases, and a reader of NEMAR stores runs both.
- A disagreement between a vendored vector and a NEMAR reader is fixed in the reader or argued in biosig-zarr, never by editing the copy.
- Readers outside NEMAR get the format vectors without depending on nemar-cli.

## Alternatives considered

- **Keep the format vectors canonical in nemar-cli:** rejected by the owner (Q9); the specification and its tests would live in two repositories, and an outside reader would depend on NEMAR's command-line interface (CLI) repository for the format's tests.
- **Move the NEMAR-profile cases to biosig-zarr too:** rejected; they test NEMAR's profile, not the format, and ADR 0131 decision 4 keeps profile decisions in nemar-cli.
- **Pin by tag alone:** rejected; a tag can be moved, and the manifest digest is what makes the copy checkable.
- **Wait for checkpoint C3:** rejected by the owner (Q34).

## Receipts

- ADR 0124 decision 3, ADR 0123 decision 4, ADR 0131 decision 4.
- RFC program plan, `.context/rfc-program/plan.md` sections 2 to 4, and cards B5a (version 2 vectors on `main`, released as `2.0.1`) and B5 (version 3 vectors on `draft/3.0.0`).
- The owner's answers of 2026-11-20 to Q9, Q33 and Q34.
