# ADR 0131: biosig-zarr has its own home and packing rules, and its tag rename waits for re-conversion

**Status:** accepted
**Date:** 2026-11-20
**Owner:** Seyed Yahya Shirazi

Partially supersedes [ADR 0128](0128-the-zarr-serving-copy-is-not-an-nwb-container.md) on four points, listed under "What this supersedes".
Epic #2239, step #2241.

## Context

This Architecture Decision Record (ADR) follows the owner's decisions of 2026-11-20,
which open the biosig-zarr format to public comment through a Request for Comments (RFC) process, starting with RFC-0001 for the whole format and its single-file `.bzx` form.
Four lines of ADR 0128's Consequences no longer hold.
ADR 0128 put the specification on docs.nemar.org while pre-beta and moved it to a public repository only at beta.
It said the `.bzx` package follows "OME-Zarr RFC-9 packing rules" (Open Microscopy Environment Zarr).
It said the format tag is renamed from `biosigio-zarr` to `biosig-zarr` "with `format_version` unchanged", which issue #2217 planned as a migration whose step 5 patches every existing store's root metadata in place.
That patch contradicts ADR 0128's own rule that embedded metadata "is written in the same pass as the samples and never patched afterward",
and the time and resolution design that RFC-0001 proposes as `format_version` 3 forbids a metadata-only upgrade: the back catalog stays readable as version 2 and is re-converted through an engine version bump.
An ADR is never edited, so this one records the change.

## Decision

1. **The specification has its own repository now.**
   nemarOrg/biosig-zarr exists from 2026-11-20 and holds the whole format, ahead of the "at beta" trigger.
   The specification text no longer lives on docs.nemar.org; that page is replaced by a pointer to the repository.
   The beta criteria themselves, the license model (World Wide Web Consortium (W3C) Software and Document License for text, Apache License 2.0 for schemas, conformance vectors and code),
   and the rule that the format gets its own organization only when a second institution co-maintains it are unchanged.
2. **The `.bzx` packing rules are NEMAR's own.**
   OME-Zarr RFC-9 (the zipped form of OME-Zarr) is prior art that informed them, not a dependency:
   a later change to RFC-9 is not followed, and a change to the packing rules is made through biosig-zarr's own process.
3. **No store's metadata is patched in place, so the tag rename moves to the version 3 writer.**
   The in-place patch step of issue #2217 is withdrawn.
   The format tag changes from `biosigio-zarr` to `biosig-zarr` only when the version 3 writer produces a store,
   through an engine version bump and re-conversion; existing version 2 stores keep `biosigio-zarr` until they are re-converted,
   and readers keep accepting both names, permanently, as the owner decided on #2217 on 2026-11-18.
   ADR 0128's "with `format_version` unchanged" is superseded; its "never patched afterward" stands and now governs this rename too.
4. **Where decisions are recorded.**
   Decisions about the specification itself are recorded in nemarOrg/biosig-zarr's `.context/decisions/`.
   Decisions about NEMAR's profile of the format and its rollout (conversion, serving, readers, re-conversion order) stay in nemar-cli's `.context/decisions/`.
   Each such decision links the RFC that produced it.

## What this supersedes

In ADR 0128's Consequences: the tag rename "with `format_version` unchanged (#2217)";
"it lives on docs.nemar.org while pre-beta, moves to a public repository at beta";
and "(OME-Zarr RFC-9 packing rules)".
Point 4 is new, and has no line in ADR 0128 to replace.
Everything else in ADR 0128 stands, including that the serving copy is not a Neurodata Without Borders (NWB) container, the reasons for it, the one-copy rules and the revisit conditions.

## Consequences

- Issue #2217 is closed or rescoped when this ADR merges, as the owner's comment there of 2026-11-20 says.
- Stores carry the old tag until they are re-converted, so a reader that accepts only `biosig-zarr` would break; none may.
- A specification change and a NEMAR rollout change may need two records in two repositories; the RFC link ties them together.
- RFC-0001 states the independence from RFC-9 as an advantage, and NEMAR now owns every future change to the packing rules, with nobody upstream to share that work.

## Alternatives considered

- **Keep the in-place patch for the name only:** rejected; it is the one-time metadata rewrite that ADR 0128 and the version 3 design forbid, and a store's metadata would no longer be a function of `source_commit` and `engine_version`.
- **Keep the specification on docs.nemar.org until beta:** rejected by the owner; RFC-0001 needs a public home for the text it amends.
- **Track RFC-9 as a dependency:** rejected by the owner; NEMAR would inherit changes made for microscopy images.

## Receipts

- ADR 0128 and issue #2217 (its step 5, and the owner's comment of 2026-11-20).
- RFC program plan, `.context/rfc-program/plan.md` sections 2 and 3, and `board-log.md` Decisions of 2026-11-20.
- OME-Zarr RFC-9: https://ngff.openmicroscopy.org/rfc/9/
- nemarOrg/biosig-zarr; neuromechanist/biosigio#179.
