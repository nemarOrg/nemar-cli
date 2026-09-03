# Architecture Decision Records

Architecture Decision Records (ADRs) capture significant decisions that shape the project: choice of stack, structural patterns, trade-offs accepted, alternatives rejected. Tuck them all in here so they are easy to find later.

## Convention

- One file per decision: `NNNN-short-kebab-title.md`, zero-padded to four digits.
- `0000-template.md` is the template; copy it to start a new ADR. Do not edit `0000-template.md` itself.
- Number sequentially. The next ADR after `0007-...` is `0008-...`.
- Status flows `proposed` -> `accepted` -> (later) `superseded by ADR-NNNN`. Never delete an ADR; supersede it.
- An `Amendment YYYY-MM-DD:` block inside an accepted ADR is for a CLARIFICATION that leaves the
  verdict standing -- naming a mechanism the decision always implied, correcting a stale file path,
  recording what the decision turned out to cost. Anything that changes what was decided is a new
  ADR that supersedes this one, not an amendment: an amended verdict is invisible to anyone who
  read the ADR before, and the whole point of the `Status` line is that the verdict is findable.
- Keep each ADR short. If it grows past two screens, you are probably writing a design doc, not a decision.

## When to write an ADR

Write one when a decision:
- Will be hard or expensive to reverse.
- Cuts off other reasonable paths a future contributor might wonder about.
- Has been argued about more than once.
- Embeds a constraint (legal, performance, schedule) that is not obvious from the code.

Do not write one for routine choices that are obvious from reading the code.

## Index

Add new entries here as you create ADRs. **This list is enforced, not decorative:**
`test/adr-index.unit.test.ts` fails the build if an ADR on disk is missing from it, if an entry
points at a file that no longer exists, if the numbering has a gap or duplicate, or if an ADR
carries a `Status` outside `proposed | accepted | superseded by ADR-NNNN`. A superseded ADR must
name a target that exists.

The index is the entry point AGENTS.md tells readers to start from, so an unlisted ADR is an
invisible one — which is why it is checked rather than trusted.

- ADR 0000 - template (do not edit)
- [ADR 0001](0001-dataset-changes-go-through-pull-requests.md) - Published datasets are PR-only; private datasets stay open
- [ADR 0002](0002-access-control-via-github-collaboration.md) - Access control rides on GitHub collaboration, not a NEMAR permission layer
- [ADR 0003](0003-datasets-is-the-single-table-of-record.md) - `datasets` is the single table of record; FTS5 for lexical, id-only Vectorize
- [ADR 0004](0004-d1-backup-to-a-private-repo-hourly.md) - Back up production D1 hourly to a private git repo, in plaintext
- [ADR 0005](0005-availability-is-reported-never-a-precondition-for-serving.md) - Availability is reported, never a precondition for serving
- [ADR 0006](0006-upstream-re-pull-is-a-major-version-bump.md) - Every upstream re-pull is a major version bump
- [ADR 0007](0007-ezid-is-the-sole-doi-provider.md) - EZID is the sole DOI provider; Zenodo is retired
- [ADR 0008](0008-cloudflare-runs-in-the-sccn-account-only.md) - All Cloudflare infrastructure lives in the SCCN account
- [ADR 0009](0009-non-production-d1-is-not-a-production-mirror.md) - Non-production D1 is a fixture set, not a production mirror
- [ADR 0010](0010-imports-use-server-side-s3-copy.md) - Imports use server-side S3 copy, never a client stream

- [ADR 0011](0011-dataset-ids-are-backend-assigned-in-reserved-bands.md) - Dataset IDs are assigned by the backend, in reserved bands
- [ADR 0012](0012-oversized-datasets-skip-the-zip-and-use-direct-download.md) - Oversized datasets skip the zip and steer users to direct download
- [ADR 0013](0013-the-importer-stays-in-nemar-cli-with-registry-plus-family-adapters.md) - The multi-archive importer stays in nemar-cli (proposed)
- [ADR 0014](0014-submission-minimums-are-llm-judged-not-regex-gated.md) - Submission minimums are LLM-judged and advisory; regexes do not gate (**superseded**)
- [ADR 0015](0015-git-annex-annexes-data-only-metadata-stays-in-git.md) - git-annex takes data files only; metadata stays in plain git
- [ADR 0016](0016-release-versioning-is-owned-by-ci.md) - CI owns version bumping and tagging
- [ADR 0017](0017-dataset-visibility-is-filtered-server-side.md) - Dataset visibility is enforced server-side
- [ADR 0018](0018-metadata-must-be-validated-before-a-doi-is-minted.md) - Metadata must reach `validated` before a DOI is minted

- [ADR 0019](0019-every-user-gets-push-to-every-repo.md) - Every approved user gets push to every repo (**superseded**)
- [ADR 0020](0020-dataset-automation-runs-from-central-shared-workflows.md) - Dataset automation runs from central shared workflows
- [ADR 0021](0021-the-api-token-is-the-master-credential.md) - The API token is the master credential; revocation cascades
- [ADR 0022](0022-orcid-relink-requires-post-minted-intent.md) - ORCID relink intent is minted only by an authenticated same-origin POST
- [ADR 0023](0023-clean-zarr-rebuilds-reconcile-instead-of-wiping.md) - A `--clean` Zarr rebuild reconciles the serving copy instead of erasing it first
- [ADR 0024](0024-deposit-attestation-is-recorded-not-assumed.md) - Deposit attestation is recorded on the dataset row, never assumed from `--yes`
- [ADR 0025](0025-inference-compute-runs-on-device-mcp-is-a-stateless-broker.md) - Inference compute runs on the user's device; the MCP is a stateless recipe-first broker
- [ADR 0026](0026-mechanical-submission-minimums-hard-gate-native-publication.md) - Mechanical submission minimums hard-gate native publication; adequacy stays LLM-advisory
- [ADR 0027](0027-zarr-dispatch-is-raw-only-derivatives-sourcedata-code-excluded.md) - The Zarr dispatch gate is raw-only; derivatives/sourcedata/code never trigger
- [ADR 0028](0028-maxshield-meg-is-sss-filtered-before-serving-or-declined.md) - MaxShield MEG is Signal-Space Separation filtered before serving, or declined
- [ADR 0029](0029-the-zarr-conversion-engine-lives-with-the-cli.md) - The Zarr conversion engine lives in nemar-cli, not the Actions repo
- [ADR 0030](0030-bounded-streaming-is-the-default-conversion-path.md) - Bounded streaming is the default conversion path; in-memory is the exception
- [ADR 0031](0031-the-annex-policy-has-one-source-and-data-may-wear-a-metadata-extension.md) - The annex policy has one source, and data may wear a metadata extension
- [ADR 0032](0032-facet-filters-are-declared-once-and-report-what-they-exclude.md) - Facet filters are declared once in a shared table, and report what they exclude
- [ADR 0033](0033-the-zarr-queue-stamps-the-engine-that-converted-each-dataset.md) - The Zarr queue stamps the engine that converted each dataset; pre-existing rows are declared current
- [ADR 0034](0034-datasets-stays-one-table-under-a-column-budget.md) - `datasets` stays one table, under an enforced column budget
- [ADR 0035](0035-sweep-stamps-live-in-one-json-column.md) - Sweep bookkeeping stamps live in one JSON column
- [ADR 0036](0036-operational-rows-carry-counts-and-pointers-not-per-file-lists.md) - Operational rows carry counts and pointers, not per-file lists
- [ADR 0037](0037-make-versus-take-is-decided-explicitly-in-both-directions.md) - Make versus take is decided explicitly, in both directions
- [ADR 0038](0038-byte-size-formatting-stays-bespoke.md) - Byte-size formatting stays bespoke; pretty-bytes is declined

## Backfill note (2026-07-31)

ADRs 0001-0021 were written retroactively from decisions that had accumulated across
`.context/` design docs, plans, and research notes. Where a decision now lives in an ADR,
the originating document keeps its analysis and points here rather than restating the
choice, so there is exactly one place that says what was decided.

The originals remain the record of *how* a decision was reached; the ADR is the record of
*what* was decided and why. Dates on backfilled ADRs are the original decision dates where
known, not the date they were written down.
