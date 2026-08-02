# ADR 0011: Dataset IDs are assigned by the backend, in reserved bands

**Status:** accepted
**Date:** 2026-02 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

A dataset ID is permanent: it appears in the repository name, the S3 prefix, the DOI, and every citation. Letting the CLI or the user choose one invites collisions and squatting, and there is no safe way to rename after a DOI exists. Separately, sandbox training, throwaway CI runs, and curated staging fixtures all need IDs that operational jobs can distinguish from real data by inspection.

## Decision

The **backend** assigns dataset IDs; never the CLI, never the user. IDs are allocated from reserved prefixes and numeric bands that encode their purpose:

| Band | Range | Purpose | Cleanup |
|---|---|---|---|
| Production sandbox | `xx000001`-`xx089999` | real user sandbox training | 14-day cron (prod) |
| Dev ephemeral | `xx090001`-`xx099899` | throwaway dev/e2e | dev cron |
| Dev exemplar fleet | `xx099900`-`xx099999` | curated persistent fixtures | never (`is_exemplar=1`) |

`nm` prefixes native NEMAR submissions, `on` prefixes OpenNeuro mirrors. All IDs stay inside the 0-99999 numeric cap.

## Consequences

- Collisions are impossible and the ID is stable from creation, which is what a DOI requires.
- A cleanup job can tell what it is allowed to delete from the ID alone, without joining other tables. This is load-bearing: the cron that deletes sandbox datasets is fenced by band.
- Bands are a fixed budget. `xx900001` is invalid because it exceeds the cap, and exhausting a band needs a migration rather than a config change.
- The `on` prefix must correspond to its OpenNeuro `ds` number (#1030), so mirror IDs are not freely allocatable — they are derived.

## Alternatives considered

- **User-chosen IDs / slugs:** friendlier citations, but permits squatting and collisions, and a rename after minting breaks the DOI. Rejected.
- **UUIDs:** collision-free without central allocation, but unreadable in citations and carries no purpose signal for cleanup jobs. Rejected.

## Receipts

- `.context/dataset_workflow.md`; AGENTS.md "Dataset ID bands"
- `backend/src/services/datasetId.ts`; #1030 (on/ds correspondence)
