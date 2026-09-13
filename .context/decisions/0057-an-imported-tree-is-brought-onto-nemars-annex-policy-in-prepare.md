# ADR 0057: An imported tree is brought onto NEMAR's annex policy in prepare, and inherited `.gitattributes` governance is stripped

**Status:** accepted
**Date:** 2026-09-13
**Owner:** Seyed Yahya Shirazi

Completes ADR 0031, which fixed the policy for new uploads and deliberately left the
import path reporting rather than acting. Issue #1159.

## Context

ADR 0031 put the annex policy in one module and declared `*_motion.tsv` data at any
size. That governs a dataset NEMAR initialises. It does not govern an imported one,
for two independent reasons the import had to answer separately.

**The files already in the clone.** `nemar admin import` preserves upstream's annex
layout, because that is what lets the S3 leg be a server-side copy by upstream annex
key. OpenNeuro annexes on size alone (~1 MB), so a `_motion.tsv` under that bar
arrives as a plain git blob and stays one: `ds007788` splits its motion recordings
across both planes, 690 annexed and 893 left in git. `findUnannexedData` reported
this and stopped there, because annexing a file whose content we never upload
publishes a pointer nothing can resolve -- worse than the bloat.

**The rule the repo carries.** This is the part that was not visible when ADR 0031
was written. Upstream ships a `.gitattributes` (`*.tsv text eol=lf
annex.largefiles=largerthan=1mb`, and a dozen more lines), and **a
`.gitattributes` setting outranks both `git annex config` and git config**. So
`configureLargefiles` -- the function that writes ADR 0031's expression, and the
single source of truth the whole ADR is built around -- has no effect on an imported
repo. Measured against git-annex 10.20260901: with upstream's attributes in place and
NEMAR's expression configured, a fresh 50 kB `_motion.tsv` still lands in plain git.
Every one of the imported `on######` datasets carries such a file, so on that entire
cohort the policy was inert, and the next `_motion.tsv` anyone added would have
repeated #1158 exactly.

A third fact shaped the mechanism. `git annex add` only considers files git sees as
new or modified, so on a file committed as a plain blob and unmodified it does
nothing at all -- exit 0, no output, no change -- and `--force-large` does not alter
that: the flag decides which plane a *considered* file goes to, not whether it is
considered. The sketch in #1159 (`git -c annex.largefiles=anything annex add`) would
have failed twice over, silently.

## Decision

**The prepare phase brings the tree onto NEMAR's policy, in one commit, and the
import fails if it cannot.** Prepare is the only phase that can: the copy phase is
pure S3 with no clone, and these keys exist nowhere upstream to copy from. Both
halves land in `src/lib/import-normalize.ts`.

**Files upstream left in git are uncached, force-annexed, and uploaded from the
clone**, in that order -- `git rm --cached`, then `git annex add --force-large`, then
`git annex copy --to nemar-s3` -- and the keys git-annex reports are verified against
the paths before anything is committed. A path with no key aborts the import. The
enabling fact is that a git-resident file's content is always present in the clone,
so no annex fetch is involved.

**This is the one leg of an import whose bytes cross the host, and ADR 0010 still
holds for everything else.** That ADR keeps the bulk data plane server-side because
streaming a 9 TB dataset through a runner cannot finish and because a piped 403
became a valid empty object. Neither applies here: the bytes are already on the host
(the clone pulled them, unavoidably, because they are git blobs), git-annex verifies
its own transfer by hash rather than piping a fetch into a PUT, and the volume is
bounded by what upstream put in a git repository -- 675 MB for `ds007788`, the worst
case in the catalogue. `NORMALIZE_MAX_BYTES` (5 GiB, GitHub's own repository
advisory) makes that bound explicit, so a pathological dataset stops with an error
instead of at the job's six-hour cap.

**Inherited `annex.largefiles` attributes are stripped from every tracked
`.gitattributes`**, root and nested, so the configured expression is what decides
this repo's future adds. Only that one attribute is removed; `text`, `eol`,
`annex.backend` and the rest survive. The single exception is a pattern targeting
git's own plumbing (`**/.git*`): its `annex.largefiles=nothing` is kept, because it
is not a claim about what NEMAR considers data and annexing a `.gitattributes` would
replace it with a symlink git-annex cannot read its own attributes from.

**A manifest item declares where its bytes come from.** `ImportManifestItem.origin`
is `"upstream"` (the default, and what every manifest written before this carries
implicitly) or `"local"`. The copy phase skips `local`; finalize's size verification,
its git-annex key registration, and the empty-manifest publish guard all treat both
kinds as data, because they are.

## Consequences

- An imported motion dataset lands with its recordings in S3, and the repo keeps ADR
  0015's metadata-only-clone promise. `on007788` imported today would not have the bug.
- The policy is now actually in force on imported trees, not merely configured. A
  later `nemar dataset update` on an imported dataset follows NEMAR's rule.
- Prepare writes data objects for the first time. It already wrote to the bucket
  (the staging manifest) with the same credentials `configureS3Remote` consumes, so
  this needs no new grant, but the phase is no longer free of the data plane. It also
  configures `nemar-s3` even when the upstream key map is empty, which is the case
  for a dataset whose only data is un-annexed.
- Stripping the attributes changes what future adds do in both directions, not only
  for motion: `phenotype/*.tsv`, which upstream annexes unconditionally, becomes
  metadata under our rule, and a `.bval` over 100 kB becomes data. The sweep behind
  ADR 0031 found no real files in the gap between the two thresholds, and this ADR
  does not reconcile that gap either.
- The import now rewrites a file the depositor wrote. It is repo plumbing rather than
  deposited data, and the import already renames `README` and seeds
  `.nemar/metadata.json`, but it is a real widening of what "the import does not
  modify content" means.
- Two commits now precede the push instead of one. Whichever runs first absorbs the
  root metadata that `ensureRootMetadataUnannexed` staged; both are pushed together.
- **The ~785 datasets imported before this still carry upstream's attributes.** This
  fixes the path, not the catalogue. Backfilling it is a fleet operation with ADR
  0020's blast radius, and it is tracked separately, as is `on007788` itself.

## Alternatives considered

- **`git -c annex.largefiles=anything annex add`** (the sketch in #1159). Does not
  work: the `.gitattributes` setting outranks the config, and the add is a no-op on an
  unmodified tracked file regardless. Verified against git-annex 10.20260901 before
  this ADR was written.
- **Write NEMAR's policy INTO `.gitattributes` instead of stripping it.** Expressible
  per-glob, and it would survive a clone. Rejected: it puts a second spelling of the
  policy in a second place, which is the exact state ADR 0031 exists to prevent, and
  no attribute syntax can express the size-plus-extension expression as one rule.
- **Normalise in the copy phase.** Impossible as designed: that phase holds no clone,
  and its whole point is to be pure S3 and shardable.
- **Server-side copy from the upstream mirror BY PATH, so no bytes cross the host.**
  The strongest alternative, and it is genuinely available: OpenNeuro mirrors the
  whole tree by path, git-resident files included. Verified on 2026-09-13 --
  `s3://openneuro.org/ds007788/sub-01/ses-01/motion/sub-01_ses-01_task-trial05_tracksys-exo_motion.tsv`
  answers 200 at 798,445 bytes, exactly the size of the git blob. Annex locally to
  compute the key, then hand the copy phase a path source, and ADR 0010 is satisfied
  with no new upload leg at all. Rejected because the destination key is the hash of
  the bytes in OUR checkout while the copied object is whatever the mirror holds, and
  finalize's gate compares SIZE, not hash: two byte-different files of equal length
  would publish a key whose content does not hash to it, and the failure would surface
  as a git-annex verification error on some future download. Closing that hole means
  comparing each file's MD5 against the mirror's ETag before trusting the path -- a
  per-file HEAD, a multipart-ETag exception, and a fallback path -- to avoid an upload
  of a few hundred megabytes the clone already performed. Not worth trading a
  certainty for an assumption about a third party's bytes.
- **Upload through the existing manifest as a `sourceUrl` pointing at the clone.**
  Would have avoided a new field, but the copy phase runs on a different machine, so
  the URL would name a path that does not exist there.
- **Annex now, upload later (or never).** Publishes an unresolvable pointer. Rejected
  by ADR 0031 already; the ordering here is what enforces it.
- **Leave the attributes and rely on `configureLargefiles`.** The measured status quo:
  the policy silently does not apply. This is the bug, not an option.

## Receipts

- `src/lib/import-normalize.ts` - both halves, and the `git annex add` no-op note
- `test/import-normalize.test.ts` - the precedence fact as an executable premise
  guard, plus content round-tripped through a real special remote
- `src/lib/s3-server-copy.ts` - `origin`, and `selectShardCopyItems`
- ADR 0031 - the policy this puts in force; ADR 0015 - the policy itself
- ADR 0010 - server-side copy for the bulk data plane, and the bound this leg keeps
- Issue #1158 (the policy fix), issue #1159 (this), `nemarDatasets/on007788`
  `.gitattributes` (the live upstream shape the fixture copies)
