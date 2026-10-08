# ADR 0093: A metadata file over 10 MiB under sourcedata/, derivatives/ or code/ is annexed

**Status:** proposed
**Date:** 2026-10-08
**Owner:** Bruno Aristimunha

Amends [ADR 0015](0015-git-annex-annexes-data-only-metadata-stays-in-git.md) and
[ADR 0031](0031-the-annex-policy-has-one-source-and-data-may-wear-a-metadata-extension.md),
which stand for the BIDS tree. Narrows "metadata stays in git at any size" to the places where
something reads it as metadata.

## Context

ADR 0015 keeps every `*.tsv`, `*.json`, `*.md`, `*.txt`, `*.yml`, `*.yaml`, `README*`,
`LICENSE*`, `CHANGES*`, `.bidsignore` and `.gitignore` in git, whatever its size. The extension
says nothing about what a file holds under `sourcedata/`, where a deposit keeps the files it was
converted from. `nm000429` (London et al., 2021) keeps 24 Plexon spike-time exports there as
`.txt`: 1,404,570,246 bytes, four of them over GitHub's 100 MiB per-file limit, the largest
164,501,157 bytes. All 24 went into the initial commit as git blobs; the 64 recordings reached S3,
and the push of the metadata to GitHub failed with HTTP 408 on 12 attempts. No resume could
succeed, because the commit itself carried the blobs. The deposit was finished by hand with
`git annex add --force-large` and `nemar dataset push`.

What reads a metadata file from the GitHub checkout decides where it must stay:

- The backend reads `dataset_description.json`, `README*` and `participants.tsv` from GitHub
  (publication checks, enrichment, DOI metadata, Neurobagel), and samples `*_channels.tsv`,
  `*_events.tsv` and sidecar JSON from the BIDS tree (montage, HED, `get_events`, the Zarr
  fidelity sweep).
- The central `run-bids-validation` workflow checks out git only and drops errors located on
  annex pointer files. An annexed sidecar in the BIDS tree would not break CI; it would stop being
  validated, silently.
- The BIDS validator ignores `/sourcedata/`, `/derivatives/` and `/code/` by default, and the
  backend treats the same three prefixes as non-raw (`LEGACY_NON_RAW_PREFIXES`).
- The identifier screen reads an annexed file through S3 as it reads a git file, within the same
  byte limits, so where the file lives does not change what it screens.

## Decision

**A file whose name matches a never-annex glob is annexed when it is under `sourcedata/`,
`derivatives/` or `code/` at the dataset root and is larger than 10 MiB (10,485,760 bytes).**
Everywhere else, metadata stays in git at any size, as before. `_motion.tsv` is data, as before.

The rule is one more clause in `buildLargefilesExpression`, and `shouldAnnex` evaluates the same
rule:

```
(<data terms> or largerthan=100000) and ((<metadata exclusions>) or ((include=sourcedata/* or include=derivatives/* or include=code/*) and largerthan=10485760))
```

The cap is written as an exact byte count. git-annex reads `10mb` as 10,000,000 bytes, and the
directories are matched case-sensitively from the root, as `include=` matches them.
`test/annex-policy.test.ts` checks both against real git-annex.

**10 MiB.** GitHub warns about a file over 50 MiB and refuses one over 100 MiB, but a push can
time out well before either limit, as `nm000429` did. With a 10 MiB cap, 21 of its 24 files are
annexed and 12,214,875 bytes stay in git. With 50 MiB, 12 files (282,536,481 bytes) would stay in
git, and with 100 MiB, 20 files (892,529,110 bytes), which is most of the push that timed out.
A small text file (a note, a parameter file, a conversion report) stays readable on GitHub.

## Consequences

- An upload with large text, tables or JSON under the three directories sends them to S3, and
  the plan counts them as data. Nothing changes in the BIDS tree.
- Nothing already published changes. The policy applies when a file is added.
- Every dataset configured before this reads as "policy" in the fleet sweep, because its
  expression is a different rule (it keeps a 50 MiB `sourcedata/*.txt` in git). Until the sweep is
  applied, `nemar dataset commit` on an existing clone keeps the old behaviour, because the save
  follows the expression in the dataset's `git-annex` branch. `nemar dataset upload` writes the
  current expression before it adds anything. Rolling the fleet forward is an ADR 0020 decision
  for an administrator.
- An import whose upstream kept such a file in git now normalises it into the annex
  (`findUnannexedData`, ADR 0060).
- A metadata file over GitHub's 100 MiB limit in the BIDS tree still goes into git and still
  fails the push. That is not decided here; a preflight check would be the next step.

## Alternatives considered

- **Cap every path.** Would annex a large `events.tsv` or `participants.tsv`, which the backend
  reads from GitHub and the validator would then skip. Rejected for the BIDS tree.
- **Exempt only the root files.** Leaves the per-recording sidecars that the backend samples
  exposed to the same loss. Rejected.
- **Cap at GitHub's 100 MiB or 50 MiB.** Keeps hundreds of megabytes in one push; `nm000429` at
  100 MiB would still push 892 MB. Rejected.
- **Compress large text to `.gz` before upload.** Annexes without a policy change, but rewrites
  deposited files and their names. Rejected; the policy should not depend on the depositor
  knowing this.

## Receipts

- `src/lib/git-annex/policy.ts` - `SIZE_CAPPED_METADATA_DIRS`, `METADATA_GIT_SIZE_CAP_BYTES`
- `test/annex-policy.test.ts` - the cap against real git-annex, including 10,000,001 bytes
- `test/fleet-annex-policy.unit.test.ts` - the pre-cap expression reads as drift
- `nemarDatasets/.github` `run-bids-validation.yml` - checkout and pointer-error filtering
- `bids-validator` `src/files/ignore.ts` - the default ignores
- `nm000429` upload logs: 12 push attempts, HTTP 408
