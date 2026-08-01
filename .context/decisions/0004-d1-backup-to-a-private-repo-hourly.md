# ADR 0004: Back up production D1 hourly to a private git repo, in plaintext

**Status:** accepted
**Date:** 2026-06-18
**Owner:** Seyed Yahya Shirazi

## Context

D1 (`nemar-db`) is the only stateful Cloudflare resource that cannot be rebuilt from something else: Vectorize is derived and rebuildable via reindex, Analytics Engine is telemetry. It holds user accounts and the dataset catalog, and Cloudflare offers no point-in-time recovery we control.

## Decision

Back up production D1 hourly to the **private** repo `nemarOrg/nemar-db-backup` via GitHub Actions cron. Store plaintext `.sql` and rely on git history for point-in-time recovery, committing only when content changed. Ship a run-local harness that loads a real snapshot into a local miniflare D1. Production only; dev is disposable.

## Consequences

- Git delta-compresses hourly snapshots well, and `git log` is the recovery timeline — no bespoke retention system.
- Dumps contain real user emails and argon2 password hashes, so the backup repo **must** stay private. `nemar-cli` itself is public, which is precisely why the backup cannot live here.
- No encryption at rest beyond repo privacy. Accepted knowingly: an encryption layer would add key management to a disaster-recovery path where simplicity is the point.
- The fts5 table from ADR 0003 breaks whole-database export, so the job exports per-table and recreates the index on restore. Do not expect a plain export to work.
- Restores are guarded (`scripts/restore-remote.sh`): sha256 + row-count verification, and it refuses production without `--force-prod`.

## Alternatives considered

- **Encrypted dumps:** better at rest, but adds key custody to the one path that must work under pressure, and repo privacy already bounds access. Rejected for now.
- **Back up dev too:** dev is reconstructible fixtures by policy (ADR 0009). Rejected as noise.

## Receipts

- `.context/research-d1-backup-655.md` — decisions locked with user 2026-06-18
- #655, epic #794; `nemarOrg/nemar-db-backup`
