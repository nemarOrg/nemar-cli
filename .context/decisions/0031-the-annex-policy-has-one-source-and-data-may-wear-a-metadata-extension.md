# ADR 0031: The annex policy has one source, and data may wear a metadata extension

**Status:** accepted
**Date:** 2026-08-25
**Owner:** Seyed Yahya Shirazi

Amends ADR 0015, which stands. This narrows "metadata never annexes" to
"metadata never annexes, except where the extension is lying", and puts the
policy in one place.

## Context

ADR 0015 decided that git-annex takes recognised data extensions or anything over
100 kB, and never takes `.tsv`, `.json`, `.md`, `.txt`, `.yml`, `.yaml`, `README*`,
`LICENSE*`, `CHANGES*`, `.bidsignore`, `.gitignore`, at any size. It also predicted
its own failure mode: *"the exclusion list is extension-based, so a new metadata
format needs adding to it or it silently gets annexed."*

The mirror image happened instead. **Motion-BIDS stores the recording itself as a
headerless `_motion.tsv`** -- one column per channel, names in the sibling
`_channels.tsv` -- and it is the only BIDS continuous-data file specified
uncompressed (`_physio` and `_stim` are required to be `.tsv.gz`, so they annex
already). `exclude=*.tsv` therefore routed entire motion-capture recordings into
plain git.

Two things made it invisible:

1. **The policy existed in five places in three spellings.** `configureLargefiles`
   held the annex expression; `collectFileManifest` held a *different* rule (a local
   extension set, or larger than 100 kB) used to decide which files get handed to
   `git annex add`; `isNeverAnnexedMetadata` restated the exclusions as a regex;
   `scripts/nemar-restore-dataset.sh` held a shell copy; `.context/validated_workflows.md`
   held two prose copies. Nothing checked that any of them agreed.

2. **The two rules disagreed in a way that reported success.** A large
   `_motion.tsv` counted as "data" in the manifest, so the upload plan told the
   user it would go to S3 and handed it to `git annex add` -- which put it in git,
   because the annex expression said `.tsv`. The S3 verification step filters to
   files annex actually took, so nothing failed. A *small* `_motion.tsv` was worse:
   classified as metadata, it never reached `git annex add` at all, and
   `commitChanges` staged it with `git add -A`, which does **not** honour
   `annex.largefiles` in these repos (no `* filter=annex` in `.gitattributes`).

Measured on the live catalogue: `nemarDatasets/on007788`, public, carries **893
`_motion.tsv` files totalling 675 MB as git blobs**, alongside **690 annexed
siblings of the identical type**. The split comes from upstream -- OpenNeuro annexes
on size alone (~1 MB) -- and the import inherits it. A sweep of that dataset plus
eight other imported datasets found **no other category of violation**: outside
`_motion.tsv`, the "git-resident but should be annexed" set is empty.

## Decision

**One module owns the policy: `src/lib/git-annex/policy.ts`.** It renders the
git-annex expression (`buildLargefilesExpression`) and evaluates the same rule in
TypeScript (`shouldAnnex`). `configureLargefiles`, the upload manifest classifier,
and `isNeverAnnexedMetadata` all derive from it; the shell copy in
`scripts/nemar-restore-dataset.sh` is held to it by a test that parses the script.

**"data" in the upload manifest means exactly "git-annex will take this."** The
classifier is no longer an independent guess. This is what makes the plan shown to
the user true, and it is what gets a sub-100 kB recording to `git annex add` at all.

**Data may wear a metadata extension, declared by glob.** `ANNEX_DATA_GLOBS`
currently holds exactly `*_motion.tsv`. Such a glob is emitted into *both* clauses
of the expression, because git-annex ANDs the top-level terms and a bare
`include=*_motion.tsv` loses to `exclude=*.tsv`:

```
(... or include=*_motion.tsv or largerthan=100kb) and (exclude=*.tsv or include=*_motion.tsv) and exclude=*.json and ...
```

**git-annex is the oracle in tests.** `test/annex-policy.test.ts` builds a real
repo, runs the real `configureLargefiles` and `git annex add`, and asserts
`shouldAnnex` agrees with what git-annex did, file by file. A re-implementation of
git-annex's glob semantics asserted against itself is what this ADR exists to
prevent.

**The import path reports; it does not yet normalise.** `findUnannexedData` warns
during `prepare` when a clone carries files NEMAR policy would annex. It stops
there deliberately: the import copies content server-side by *upstream annex key*,
and the manifest cannot express a key sourced from the clone, so annexing a file
without also uploading its content would publish an unresolvable pointer -- worse
than the bloat. Issue #1159 carries the real fix.

## Consequences

- New uploads put motion recordings in S3, at any size. Motion sidecars
  (`_channels.tsv`, `_motion.json`) stay in git, so a metadata-only clone is still
  useful -- ADR 0015's central promise is preserved rather than weakened.
- The upload plan's "Data files: N (will be uploaded to S3)" is now accurate.
  Counts will shift for existing datasets: large `.tsv`/`.json` sidecars used to be
  counted as data and no longer are. No file changes plane as a result -- the old
  classification was already being overruled by the annex expression.
- A future data format that looks like metadata is a one-line addition to
  `ANNEX_DATA_GLOBS`, and both the expression and the predicate follow.
- The shell script can still drift *within a commit that skips tests*, which is the
  residual risk of a copy that cannot import. The test is the mitigation, not a
  guarantee.
- `on007788` is not fixed by this change. It is a live public dataset; migrating
  it moves 675 MB into S3 and rewrites the tree, so it needs its own authorisation.
- The 100 kB threshold is untouched, and so is the gap with OpenNeuro's ~1 MB one.
  The sweep says that gap is currently empty of real files, so this ADR does not
  reconcile it.

## Alternatives considered

- **Add `*_motion.tsv` to the include list only.** The obvious one-line fix, and it
  does nothing: the metadata clause ANDs with the include clause and vetoes it.
  Verified against git-annex 10.20260717 before writing the paired form.
- **Drop `exclude=*.tsv` and rely on the 100 kB threshold.** Would annex large
  `events.tsv` and `participants.tsv`, breaking metadata-only clone and the
  enrichment readers. This is the configuration ADR 0015 already rejected.
- **Adopt OpenNeuro's size-only rule for parity.** Removes the extension logic that
  keeps workflows and sidecars readable, and re-introduces exactly the failure ADR
  0015 was written about. Rejected.
- **Compress motion to `_motion.tsv.gz` on ingest.** Would annex without a policy
  change, but rewrites deposited data, breaks BIDS validation for the motion
  modality, and changes files under a DOI. Rejected.
- **Keep the classifier separate but add motion to both.** Leaves two rules that
  merely happen to agree today, which is the state that produced this bug.

## Receipts

- `src/lib/git-annex/policy.ts` - the policy
- `test/annex-policy.test.ts` - agreement with real git-annex, and the shell sync check
- `test/import-unannexed-data.test.ts` - the detector, against a reproduced upstream split
- ADR 0015 - the decision this amends
- Issue #1158 (this fix), issue #1159 (import normalisation and the `on007788` backfill)
