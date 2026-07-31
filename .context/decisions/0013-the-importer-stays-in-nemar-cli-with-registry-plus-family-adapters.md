# ADR 0013: The multi-archive importer stays in nemar-cli, as a registry plus family adapters

**Status:** proposed
**Date:** 2026-07 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

Importing beyond OpenNeuro means roughly 90 candidate archives with wildly different shapes: anonymous HTTP, API tokens, DUA-gated access requiring a human to accept terms, and data that is BIDS-native, BIDS-shaped, or raw and needing conversion. Two structural questions follow: where does that code live, and how is per-archive variation expressed?

## Decision

**Co-located, not a separate service.** The importer stays in `nemar-cli` rather than a `nemar-importer` repo.

**Hybrid adapter layer.** A data-driven `SourceRegistry` (one low-churn, git-reviewed entry per source: auth kind, BIDS status, default license, tier, politeness limits) plus code adapters keyed by archive **family**, not by individual archive.

## Consequences

- The importer reuses the battle-hardened core directly: the `import_jobs` state machine, the retry/blocklist engine, `deleteDatasetCascade`, DOI minting, BIDS validation, and the git-annex/S3 plumbing.
- Crucially it also inherits the **prod-safety fences** — the `scheduled()` prod-only allowlist, the shared-org and shared-`users` blast-radius rules, the ID bands, the exemplar conventions. A separate repo would either duplicate all of that or RPC back into it, doubling the surface where a dev-side job can email 609 real users or cascade-delete a real repo. Import is not compute-isolated from NEMAR's core; it **is** NEMAR's core write path.
- `nemar-cli` grows. Accepted: the alternative is a distributed system whose failure modes are worse than a large module.
- Adapters-per-family keeps sibling archives from duplicating auth and conversion logic, but means a genuinely novel archive still needs code, not config. That is correct — pure config cannot express "log into EBRAINS, accept a per-DUA, download, convert, validate."

## Alternatives considered

- **Separate `nemar-importer` service:** clean separation on paper, but duplicates the safety fences or reaches back over RPC, and the fences are the part most expensive to get wrong. Rejected.
- **Pure config per archive:** cannot express interactive auth or conversion pipelines. Rejected.
- **Code module per archive (~90):** bloats the CLI and duplicates logic across siblings. Rejected.

## Receipts

- `.context/plan-multi-archive-importer.md` (architecture RFC)
- `.context/research-archive-import-candidates.md` (the ~90-source survey)

## Note on status

Marked **proposed**: the RFC is written and the direction agreed, but the registry and adapters are not built. Promote to `accepted` when the first non-OpenNeuro source lands.
