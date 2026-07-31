# Architecture Decision Records

Architecture Decision Records (ADRs) capture significant decisions that shape the project: choice of stack, structural patterns, trade-offs accepted, alternatives rejected. Tuck them all in here so they are easy to find later.

## Convention

- One file per decision: `NNNN-short-kebab-title.md`, zero-padded to four digits.
- `0000-template.md` is the template; copy it to start a new ADR. Do not edit `0000-template.md` itself.
- Number sequentially. The next ADR after `0007-...` is `0008-...`.
- Status flows `proposed` -> `accepted` -> (later) `superseded by ADR-NNNN`. Never delete an ADR; supersede it.
- Keep each ADR short. If it grows past two screens, you are probably writing a design doc, not a decision.

## When to write an ADR

Write one when a decision:
- Will be hard or expensive to reverse.
- Cuts off other reasonable paths a future contributor might wonder about.
- Has been argued about more than once.
- Embeds a constraint (legal, performance, schedule) that is not obvious from the code.

Do not write one for routine choices that are obvious from reading the code.

## Index

Add new entries here as you create ADRs:

- ADR 0000 - template (do not edit)
- [ADR 0001](0001-dataset-changes-go-through-pull-requests.md) - Dataset changes go through pull requests; main is sacred
- [ADR 0002](0002-access-control-via-github-collaboration.md) - Access control rides on GitHub collaboration, not a NEMAR permission layer
- [ADR 0003](0003-datasets-is-the-single-table-of-record.md) - `datasets` is the single table of record; FTS5 for lexical, id-only Vectorize
- [ADR 0004](0004-d1-backup-to-a-private-repo-hourly.md) - Back up production D1 hourly to a private git repo, in plaintext
- [ADR 0005](0005-availability-is-reported-never-a-precondition-for-serving.md) - Availability is reported, never a precondition for serving
- [ADR 0006](0006-upstream-re-pull-is-a-major-version-bump.md) - Every upstream re-pull is a major version bump
- [ADR 0007](0007-ezid-is-the-sole-doi-provider.md) - EZID is the sole DOI provider; Zenodo is retired
- [ADR 0008](0008-cloudflare-runs-in-the-sccn-account-only.md) - All Cloudflare infrastructure lives in the SCCN account
- [ADR 0009](0009-non-production-d1-is-not-a-production-mirror.md) - Non-production D1 is a fixture set, not a production mirror
- [ADR 0010](0010-imports-use-server-side-s3-copy.md) - Imports use server-side S3 copy, never a client stream

## Backfill note (2026-07-31)

ADRs 0001-0010 were written retroactively from decisions that had accumulated across
`.context/` design docs, plans, and research notes. Where a decision now lives in an ADR,
the originating document keeps its analysis and points here rather than restating the
choice, so there is exactly one place that says what was decided.

The originals remain the record of *how* a decision was reached; the ADR is the record of
*what* was decided and why. Dates on backfilled ADRs are the original decision dates where
known, not the date they were written down.
