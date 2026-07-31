# ADR 0006: Every upstream re-pull is a major version bump

**Status:** accepted
**Date:** 2026-07-31
**Owner:** Seyed Yahya Shirazi

## Context

561 of NEMAR's ~754 public datasets are OpenNeuro mirrors. Upstream publishes new snapshots over time, and NEMAR also makes its own changes to a mirrored dataset: curation fixes, metadata enrichment, and other automated or reviewed corrections. Both kinds of change would land in the same version string, leaving no way to tell from a version number whether the underlying research data changed or only our annotation of it.

(As of this ADR the re-pull machinery does not exist — discovery filters on dataset id alone, so an imported dataset never re-enters candidacy. Epic #1046 builds it. This ADR fixes the policy the implementation must follow.)

## Decision

Pulling new upstream content bumps the **major** version: `1.0.0` -> `2.0.0`. Minor and patch are reserved for NEMAR's own corrections.

| bump | meaning |
|---|---|
| major | upstream content changed; we re-pulled it |
| minor / patch | NEMAR changed something |

## Consequences

- A version number answers "did the science change?" without consulting a changelog.
- Minor/patch stay free for our corrections, which is the point: we can fix our own metadata without implying upstream revised the data.
- Each of our versions mints a version DOI, so this means **a new version DOI per upstream revision**. That is intended for a mirror, but it makes upstream churn directly visible in DOI-mint volume and should be sized before any automatic re-pull is enabled.
- Major numbers on mirrors will climb faster than a reader might expect, and will not correspond to upstream's own version numbering. The mapping must be recorded (`source_version`) rather than inferred.

## Alternatives considered

- **Mirror upstream's version string verbatim:** loses the ability to express NEMAR-side corrections at all, and collides when upstream and NEMAR both change. Rejected.
- **Minor bump for upstream, patch for ours:** leaves major unused and compresses the distinction into one digit of headroom; a dataset with many upstream revisions and many local fixes would blur. Rejected.

## Receipts

- Epic #1046
- `backend/src/services/openneuro-discovery.ts` — `diffNewDatasets` is id-only today
- Measured drift 2026-07-31: 2/60 sampled mirrors stale (~3%, roughly 15-20 of 561)
