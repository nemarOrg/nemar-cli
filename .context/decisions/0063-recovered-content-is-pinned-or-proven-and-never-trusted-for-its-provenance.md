# ADR 0063: Recovered content is pinned or proven, and an unproven copy is deleted rather than kept

**Status:** accepted
**Date:** 2026-09-15
**Owner:** Seyed Yahya Shirazi

## Context

Sixteen datasets finalized an import with content that was never transferred: 12,039 annexed keys, about 620 GB, for which `s3://nemar` holds no object (#1396). ADR 0061 decided that the registration sweep leaves those datasets alone, because writing the surviving registrations would make a dataset whose real problem is missing content look repaired. That left the actual repair unspecified.

The bytes mostly still exist, and the obvious repair is to copy them from OpenNeuro. The obvious repair is also how an archive quietly corrupts itself. OpenNeuro's public copy is an **exported tree**: objects live at `dsXXXXXX/<path>`, a path is rewritten whenever a dataset gets a new version, and these imports are months old. A copy keyed on "the file at the path this key used to be at" can bring back a *different* recording, under a key that asserts a specific hash, into a dataset that is public and carries a permanent DOI. Nothing downstream would notice: git-annex verifies content on `get`, but the location log would already be advertising it, and the failure would surface as an integrity error on a user's machine rather than on ours.

Measuring the sixteen also showed that the sources differ in how well they identify content, and that the differences are not cosmetic:

- 1,971 keys have a **pinned** source: git-annex recorded, in `<key>.log.rmet`, the exact S3 version id it saw that key's content at. That is the archive's own record of which bytes are this key's.
- 2,309 keys have no pin, but exactly one distinct upstream object (deduplicated by ETag, because a path rewritten with identical bytes lists as several versions) carries the key's size, sometimes only as a non-current version behind a delete marker.
- 7,759 keys have neither, and for 245 of them OpenNeuro's own location log records the content at no remote at all: upstream does not have it either.

## Decision

**A copy is only allowed from a source that is pinned, or one that is uniquely identified by size after deduplication by ETag.** A path alone is never a source. When several distinct objects carry the key's size, the key is reported rather than guessed at.

**Verification is by content, computed by S3, before the key is registered.** `CopyObject` is asked for a SHA-256 (`--checksum-algorithm SHA256`) and the result is compared against the key's own hash; an MD5E key is verified by the ETag of the single-part copy. This makes the weaker source class safe: a version-matched copy either hashes to the key or it does not.

**An object that does not verify is deleted.** Leaving it is worse than never copying it, because the next registration sweep lists the bucket, finds an object under the key's name, and advertises it.

**Above CopyObject's 5 GB limit, where a multipart copy cannot carry the key's SHA-256, only a pinned source is accepted.** S3 offers a whole-object checksum for a multipart upload (`--checksum-type FULL_OBJECT`) but refuses it for SHA-256, so the key's own hash cannot be recomputed on that path. What is available is a full-object CRC64, which OpenNeuro's large objects already carry: when the copy and the source agree on it, the copy is provably the pinned version's bytes rather than merely an object of the right length, and that is recorded as `crc64-of-source`. It is a check on fidelity, not on identity, so it does not rescue an unpinned source: matching the CRC of an object we guessed at only proves we copied the guess faithfully. An unpinned oversized key is still reported unrecoverable rather than trusted on its size.

**Recovery writes no location log.** It puts objects in the bucket; `nemar admin fleet key-registration` then lists the bucket again and records what is there, so exactly one piece of code writes a presence claim and it is the one that reads the log back (ADR 0061).

## Consequences

- Recovery is provable after the fact: every recovered key was checked against its own hash, and the report says by which method.
- The copy is server-side, so the operator's connection is not in the path of hundreds of gigabytes. The cost is that it needs credentials that can read the source bucket, which the API's upload credentials cannot (`generateUploadPolicy` scopes them to one dataset prefix in `nemar`), so this one command reads the ambient AWS environment and says so in its help.
- Copying with the default tagging directive fails on OpenNeuro's newer objects: they carry `access=public` tags and their bucket policy grants only `s3:GetObject`, so reading the tags is denied and the whole copy returns a bare `AccessDenied` for an object we can read. The copy therefore always sends `--tagging-directive REPLACE`.
- Content that nothing can prove stays missing, and is reported that way. For the 245 keys OpenNeuro also lacks, the honest state of the dataset is incomplete, and saying so is more useful than a repair that invents bytes.

## Alternatives considered

- **Trust the path and copy the current object.** Rejected: it is exactly how a dataset acquires the wrong recording under a right-looking key, and one of the sampled datasets already has a path whose current upstream object differs in size from the key.
- **Fetch through git-annex (`get` from upstream, then `copy --to nemar-s3`), which verifies hashes itself.** Rejected as the default: git-annex caches an S3 remote's credentials with no slot for a session token, so it cannot sign for `nemar-s3` with the credentials this archive issues, and it would move every byte through the operator's machine. It remains the fallback for a source S3 cannot copy from.
- **Verify by downloading each copy and hashing it.** Rejected: it is the same bytes again, for a check S3 already performs during the copy at no cost.
