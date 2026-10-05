# ADR 0085: A privacy correction scrubs every version in place, and NEMAR keeps the history of each correction

**Status:** accepted
**Date:** 2026-10-04
**Owner:** Seyed Yahya Shirazi

## Context

A researcher reported name-like strings in the EDF/BDF patient headers of a published dataset
(epic #1610). Reading the headers of every public dataset (`scripts/identifier-fleet-scan.ts`)
found the same class in others, always in a dataset that re-shares data other groups
released: the `nm` datasets are conversions of public releases and the `on` datasets are
OpenNeuro mirrors. For the reported dataset a header read from inside the original release was
byte-identical to NEMAR's copy, so the identifiers come from upstream and were public before
NEMAR copied them. That lowers the severity and removes none of the obligation.

The bytes are everywhere a version is: the git history (pointer files and inline JSON), the
S3 objects (public read, a content-addressed key per file, GOVERNANCE Object Lock for 100
years on `<id>/objects/` only, in a versioned bucket), the per-version manifests, and the data
plane. The standing rules pull in different directions. ADR 0006 gives NEMAR's own changes a
minor or patch bump. ADR 0016 leaves tags to CI. The Takedown Procedure withdrew prior versions
and tombstoned the DOI, but a tombstone hides bytes and deletes none, and withdrawing every
version of a dataset with 34 citations breaks every analysis that cites it. A new corrected
version would leave the old ones serving the identifiers. The existing delete paths add delete
markers in a versioned bucket, so they remove nothing.

## Decision

**What gates.** A name, a birth date finer than year, a record number, an age over 89, contact
details and a face gate. An acquisition date alone does not: it is acceptable when nothing in
the dataset ties the recording to an identifiable person (published in the Contributor Terms,
2026-10-04). The scanner reports start dates at review severity and they never block.

**The default remedy is an in-place scrub of every version.** The affected fields are removed
from every version NEMAR serves, and version numbers and DOIs are kept; no new version is
issued. The Contributor Terms and the Takedown Procedure reserve the right to do this and say
how depositors, authors and source archives are told. Withdrawal with deletion of the data is
reserved for a dataset that cannot be scrubbed: a license that forbids modified copies, an
identifier carried in the signal or pervasive (audio, video, many annotations), or an extent
that cannot be bounded. A tombstone alone is never the remedy.

**The scrub replaces keys, it does not edit locked objects.** For EDF and BDF files only
bytes 8 to 88 (patient identification) and 88 to 168 (recording identification) change, and
only when the scanner finds a name, a birth date finer than year, a record number or non-ASCII
text in them; the start date and time, the record count and every byte after offset 256 stay
identical, which is proven byte for byte (`shared/identifier-scrub.ts`). The new content has a
new SHA256E key, so the order is add, verify, switch, delete:

1. restrict the dataset (private with the bucket-policy exclusion), suppress workflow dispatch,
   pause its Zarr queue, and take the uploader's write access away;
2. hash the new content on a host with fast S3 reads (the key needs the whole file), verifying
   the original against its own key in the same pass;
3. assemble each new object server side (a patched first part and `UploadPartCopy` for the rest),
   with explicit GOVERNANCE retention at creation, and verify it (sizes, patched header, sampled
   ranges, retention) and re-hash it from S3;
4. rewrite the git history of every branch and tag with `git-filter-repo` so every tree names
   the new keys and drops or blanks the inline identifiers, record the new keys as present and
   the old keys as dead in the `git-annex` branch, lift the per-repository tag ruleset, force-push,
   and restore the ruleset;
5. regenerate every tag's manifest AFTER the tags move (before, the job rebuilds the old
   manifest from the old tree) and remap `zarr_source_commit` and the index `source_commit`;
6. verify through the public surface that every manifest names only new keys and that downloads
   hash to them;
7. delete the old object versions, and the noncurrent manifest and archive versions, by VersionId
   with the governance bypass, and prove it with an authoritative `ListObjectVersions` showing
   zero versions and zero delete markers;
8. ask GitHub Support to clear cached views and pull-request refs, check for other copies NEMAR
   controls, delete local clones, re-enable dispatch and access, and make the dataset public.

Retention is never shortened with `PutObjectRetention`, which would open an unprotected window.
Nothing is deleted until the public surface has been verified, and deletion is the only
irreversible step.

**Purged keys stay purged.** Every old key goes on a private purge list (a document with a
catalog pointer, not a per-key table, ADR 0036). Import copy, recovery (ADR 0063), key
registration (ADR 0061), the availability count (ADR 0064) and the publish gate refuse a purged
key, and none counts it as missing.

**Authority and a rehearsal.** The owner gives an explicit go for each dataset after a dry run
whose plan is read-only. The bypass is proven on a disposable canary object before any real
object is touched, and the first real scrub is a single dataset.

**NEMAR keeps the history of its corrective actions.** An append-only ledger records, per
dataset, each action (plan, headers scrubbed, files removed, history rewritten, locks applied,
manifests regenerated, old versions deleted, republished), the versions affected, counts, the
scanner version and rules, the verification result and who ran it, with no values and no per-file
lists (ADR 0036). It lives where a history rewrite cannot erase it: a file in the dataset
repository committed after the rewrite, an object under the dataset's S3 prefix, and a count and
pointer on the catalog row. Each corrected version's change log says that a privacy correction
was made, without describing what was removed.

**The scrub is a step in the workflows that bring data in.** The importer's prepare step (ADR 0060)
scrubs identifying fields in place, then the same deterministic screen runs, then the ledger is
written, so a later OpenNeuro import or re-pull is scrubbed again and does not reintroduce what was
corrected. The publication workflow gains `identifier_screen`, a hard gate before
`s3_public_read` that fails closed on a direct finding, and treats an unread header or a recording
format the scanner cannot parse as not screened, which only an explicit, recorded admin
acknowledgement can pass.

## Consequences

- The original bytes are gone from NEMAR for good. Copies others downloaded, forks, and GitHub's
  cached views and pull-request refs are beyond NEMAR; the Takedown Procedure says so.
- The bytes behind a tag and a DOI change. What preserves provenance is the ledger, the change
  log and this ADR, not the version number; a citing analysis still reproduces because the signal
  bytes are identical.
- A mirror diverges from upstream. The provenance text that said sourcedata is byte-for-byte
  unmodified is corrected for any dataset scrubbed, and upstream archives are told.
- Scrubbing re-reads every affected file once (about 345 GB across the first 16 datasets), which is
  why hashing runs on a host with fast S3 reads and assembly never moves the payload.
- Several services must learn the purge list before it can be trusted, and until the publication
  gate and the importer step exist, only byte-identical re-uploads are caught by it.
- Webhooks dispatch a version-DOI run on any non-delete tag push and enrichment on pushes to
  `main`, so dispatch is suppressed for the duration of a rewrite.

## Alternatives considered

- **A new corrected version, with earlier versions withdrawn.** Leaves the identifiers in every
  version until withdrawal, breaks every citation of the earlier versions, and mints an
  irreversible version DOI. Rejected.
- **Tombstone every version.** Hides the bytes and deletes none. Rejected as a remedy.
- **Make the dataset private and stop.** Stops anonymous reads and fixes nothing; kept only as
  the interim step.
- **Scrub the objects but not the git history.** Leaves the inline JSON, file names and every old
  key reachable from old commits and tags. Rejected.
- **Edit the objects at their existing keys.** Impossible: the key is the content hash.
- **A different key backend for scrubbed files, to avoid re-reading them.** Breaks the annex
  policy (ADR 0031) and every reader that assumes SHA256E. Rejected.

## Receipts

- Epic #1610 and phases #1611 to #1618; docs PRs #57, #58 and #59.
- The design review recorded on #1612 (key replacement, delete by VersionId, canary, purge list,
  dispatch suppression, manifests after the tag move).
- `scripts/identifier-fleet-scan.ts` and its results, `shared/identifier-scan.ts`,
  `shared/identifier-scrub.ts`.
- ADRs amended today: 0006, 0010, 0016, 0060, 0061, 0063, 0064, 0067.

## Amendment 2026-10-05 (#1612): the other copies, and what a successful run proves

A review of the Phase 2 tooling and a first read of the real bucket found things the procedure above did not name.

**Two more copies of the identifiers.**
The Zarr serving copy repeats header fields:
every store's root metadata (`<id>/zarr/<path>.zarr/zarr.json`) carries `attributes.recording_metadata.patientcode` and `.birthdate`, copied from the EDF or BDF header by the converter.
Those objects are not Object Locked, so the `zarr` stage removes exactly the identifier keys in place and re-reads every store; the noncurrent versions of every zarr object are then pruned, because the bucket is versioned.
The archive zip under `<id>/archives/` contains the original recordings, so `drop-archives` deletes every version of it and the normal archive workflow regenerates it from the scrubbed tree.
`<tag>-summary.json` and `<tag>-records.json` were checked by key name and hold entities, signal summaries and provenance, no header field; they are not regenerated.

**Verification before deletion is by admin reads.**
Step 6 says to verify through the public surface, but the dataset is private until the old bytes are gone, which is what keeps any old key from being publicly readable.
What is verified before deletion is therefore the pushed refs in a fresh clone, every regenerated manifest and every new object re-hashed from S3, all by an administrator.
The public surface is checked after the dataset is made public again, and a failure there makes it private again; the new objects were verified twice, so the fault would be in a manifest, a cache or a route.

**The irreversible step checks for itself.**
`delete-old` refuses unless the plan is complete and not partial, both proofs name the exact bytes of `assembled.json`, no current manifest names an old key, an anonymous request for an old object is refused (the dataset is private), the Zarr stage has verified, and no archive remains.
A prune prefix is an allow-list (`<id>/version/`, `<id>/archives/`, `<id>/zarr/`), never a deny-list, because a deny-list let the dataset root through in review.

**A successful run is not proof that nothing was missed.**
The plan's keys are the union of every manifest and a listing of `<id>/objects/`, the git plan reads every commit rather than the tag tips, and `verify` requires every EDF and BDF key in any commit to be a new key or one the plan found clean.
The hash stage binds each digest to the patch it was computed for, so a re-plan cannot reuse a stale one.

**The stand-in is not S3.**
On first contact with the real bucket the tools disagreed with their stand-in twice: S3 requires a checksum header on an `UploadPart` of a multipart upload created with Object Lock parameters, and `<id>/version/` holds `<tag>-records.json` beside the manifest.
Both were fixed, and the canary, which runs on the real bucket against a test prefix, is run again after any change to an S3 call.
