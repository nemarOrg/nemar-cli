# ADR 0007: EZID is the sole DOI provider; Zenodo is retired

**Status:** accepted
**Date:** 2026-04 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR originally minted DOIs through Zenodo, which also meant depositing a copy of the data with Zenodo. That duplicates storage for datasets we already host, and couples our identifier namespace to a third-party archive's retention decisions. UC San Diego has institutional access to EZID, which mints DataCite DOIs under a prefix we control without requiring the bytes to move.

## Decision

EZID is the only DOI provider. All DOIs are minted under the `10.82901/NEMAR.` prefix via `ezid.cdlib.org`, with DataCite kernel-4 XML supplied in the `datacite` field. Zenodo minting is off.

## Consequences

- DOIs point at NEMAR-hosted landing pages and the data stays in one place.
- We own the metadata quality obligation that Zenodo previously absorbed: the `.nemar/metadata.json` pipeline must reach `validated` before a mint is allowed.
- EZID's ANVL encoding requires escaping `%`, newlines, and carriage returns — a real source of silent corruption if forgotten.
- The **sandbox** shoulder (`10.5072/FK2`) purges DOIs after roughly two weeks, so staging/exemplar DOIs lapse by design. D1 remains the source of truth for published state; a lapsed sandbox DOI does not mean the dataset was unpublished.
- Zenodo-era columns (`zenodo_concept_id`, `zenodo_latest_version_id`) remain on the table as historical residue.

## Alternatives considered

- **Stay on Zenodo:** no new metadata obligations, but duplicates storage for data we already host and cedes identifier control. Rejected.
- **Run both:** two DOIs per dataset is worse than none — readers cannot tell which is canonical. Rejected.

## Receipts

- #105; `backend/src/services/ezid.ts`, `datacite.ts`
- `shared/datacite-constants.ts` — `datasetLandingUrl` / `datasetVersionLandingUrl`
- #950 (publisher ROR moved UCSD -> SCCN)
