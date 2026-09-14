# ADR 0061: A registration is read back from the location log, and a dataset the bucket cannot account for is never partly repaired

**Status:** accepted
**Date:** 2026-09-14
**Owner:** Seyed Yahya Shirazi

## Context

`batchSetKeysPresent` ran fifty `git annex setpresentkey` processes concurrently and counted every exit-0 as a registration. They all exit 0. Their writes to the shared git-annex branch journal do not all survive each other, and nothing afterwards asked whether the registration was actually there.

An `onboard-openneuro` finalize logged `Registered 117 files in git-annex`; the pushed location log recorded none of them; the dataset was then published, public, with a permanent concept DOI and a `v1.0.0` tag. A fleet sweep of all 802 dataset repositories found the same state in **528 of 600 imported datasets**: 720,896 keys sitting in `s3://nemar` that no clone is told about (#1392).

Two facts about this failure shaped what follows. First, it was invisible from outside: the datasets are public, DOI'd, BIDS-green, and their objects serve over HTTP; only a git-annex clone notices, and it notices by quietly fetching from OpenNeuro's remote instead. Second, while measuring it we found a second, different population, datasets whose content is not in the bucket at all (#1396) -- and the cheap repair for the first is actively harmful to the second, because writing the surviving registrations makes a dataset whose real problem is missing content look repaired.

## Decision

**A registration is established by reading the location log back, never by a command's exit code.** `batchSetKeysPresent` writes with one `git annex setpresentkey --batch` process per chunk and then derives its result from `git annex find --in <uuid>` (with `whereis --key` for keys the working tree does not name). Callers abort on the difference. Nothing pushes a git-annex branch until the log has been re-read and confirms every key.

**A dataset with any annexed key the bucket cannot account for is reported and skipped, not partly repaired.** `nemar admin fleet key-registration` establishes what the bucket holds with one `list-objects-v2` per dataset using credentials the API mints, and a dataset with outstanding keys is left exactly as found. `--include-incomplete` exists for when the content is back.

**What the bucket holds is established by listing it, never by a per-key HEAD.** `s3://nemar` denies anonymous `ListBucket`, so S3 answers a missing key with **403, not 404**, and 403 is equally what a private dataset, an expired session, and a signature with no session token return.

## Consequences

- A registration failure is now loud and stops before the irreversible step, so the recoverable state (a local clone) is what is left behind rather than a published lie.
- Verification costs a second read of the location log per chunk. On the largest dataset in the fleet (59,939 keys) that is a few seconds against a transfer measured in hours.
- The sweep cannot repair the 16 datasets in #1396, by design. They need their content transferred first, and this deliberately does not paper over that.
- One `list-objects-v2` per dataset replaces up to 4,177 HEADs, but it requires credentials, so the read-only report is not free of side effects: minting stamps `last_activity_at`. The command says so.
- `setKeyPresent` (one key, trust the exit code) stays exported for single-key use and now carries a comment saying it must not be used for bulk work.

## Alternatives considered

- **Keep the concurrent writers and add a retry.** Rejected: it treats a lost write as a transient failure when it is a design error, and a retry that also trusts exit codes reports success just as confidently.
- **Verify with `git annex fsck --from nemar-s3`.** Rejected, and this is the trap that cost the most: `enableremote` caches the key and secret in `.git/annex/creds/<uuid>` with nowhere to put an STS session token (#1380), so fsck signs without one and gets 403 -- the same 403 a missing object gets. A red fsck would not mean the content is missing and a green one would not mean it is present. `fsck` is also only able to check claims the log already makes, so an upload that moved nothing gives it nothing to examine and a clean exit.
- **Repair the incomplete datasets too, registering whatever is present.** Rejected: every such claim would be true, and the dataset would still be missing content while reading as fixed. A count of "datasets repaired" that includes them is a worse number than one that does not.
- **Probe each key with an anonymous HEAD.** Rejected: ambiguous (see the 403 above) and slower. Where an anonymous probe is unavoidable, a control key the log already records must be probed first to establish that 200 is reachable at all.

## Receipts

- Issue #1392 (the defect, the fleet measurement, and the repair), issue #1396 (the missing-content population), issue #1380 (the session-token trap behind the fsck alternative).
- `src/lib/git-annex/transfer.ts` (`batchSetKeysPresent`), `src/lib/fleet-key-registration.ts`, `src/lib/aws-cli.ts` (`listS3ObjectKeys`).
- Rollout: 519 datasets repaired, 629,620 keys, verified by an independent re-scan that moved fully-registered datasets from 266 to 785 -- a delta matching the repaired count exactly.
