# ADR 0018: Metadata must reach `validated` before a DOI is minted

**Status:** accepted
**Date:** 2026-04 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

A DOI is permanent and its DataCite record is public. Under ADR 0007 NEMAR mints directly through EZID, so nothing downstream reviews the metadata before it becomes citable — the quality obligation Zenodo used to absorb is now ours. Bad metadata cannot be recalled, only amended.

## Decision

`.nemar/metadata.json` (v2.0) is the source of truth and moves through three states: **seeded** (extracted from BIDS), **enriched** (LLM-proposed subject terms, restricted to MeSH and validated against NLM), then **validated** (LLM judge). Minting is blocked until the record is `validated`.

## Consequences

- No dataset acquires a permanent identifier carrying metadata nobody checked.
- Publication depends on an external LLM provider and NLM lookups, so an outage delays minting. Accepted: the gate is worth an occasional delay, since the failure it prevents is unfixable.
- Restricting enrichment to NLM-validated MeSH terms keeps the model from inventing plausible-sounding vocabulary — the controlled vocabulary is the guardrail, not the prompt.
- Anything that mints must respect the gate. Recovery and backfill paths are the tempting place to skip it and must not.

## Alternatives considered

- **Mint on publish, fix metadata later:** faster, but the DataCite record is already public and already cited. Rejected.
- **Human review of every record:** highest quality, unaffordable at import scale, and OpenNeuro mirrors arrive faster than any reviewer. Rejected.
- **Free-form LLM keywords:** richer, but unvalidated vocabulary degrades search and looks authoritative while being invented. Rejected in favour of MeSH.

## Receipts

- #154; `backend/src/services/` metadata pipeline
- ADR 0007 (EZID sole provider — the reason this gate exists here)
