# ADR 0010: Imports use server-side S3 copy, never a client stream

**Status:** accepted
**Date:** 2026-06-15
**Owner:** Seyed Yahya Shirazi

## Context

OpenNeuro imports streamed every byte through the GitHub Actions runner with `curl <url> | aws s3 cp -`. That forced the whole dataset through a 2-core runner, blew the 6-hour job cap on a 9 TB set, and — critically — **a 403 from the source produced an empty stdout that `aws s3 cp -` happily uploaded as a valid 0-byte object**. That is the #967 empty-PUT bug that published 56 datasets containing nothing.

A code comment had assumed a 403 blocked server-side copy. Testing on 2026-06-15 showed it does not.

## Decision

Import copies run **server-side**: `aws s3 cp s3://openneuro.org/<path> s3://nemar/<id>/objects/<key>`. Bytes never touch the runner. Verified cross-account and cross-region (OpenNeuro us-east-1 to NEMAR us-east-2) with a signed read of the public bucket and matching ETags.

Presence is never sufficient evidence of a successful copy. An object must match the size declared by its git-annex key (`MD5E-s<size>--<hash>`) to count as present.

## Consequences

- Import time stops scaling with runner bandwidth, and the 6-hour cap stops being the binding constraint.
- A failed fetch can no longer be silently converted into a valid empty object, because there is no client-side pipe to truncate.
- The size-vs-key check became reusable well beyond import: the archive builder uses the same rule to reject content that is not what its key describes (ADR 0005).
- OpenNeuro mirrors the full tree by path at `s3://openneuro.org/ds<id>/<path>`, so sources can be addressed by path or by annex-key whereis URL — the copy is not limited to annex keys.
- Cleaning up after the bug required withdrawal and recovery tooling that would not otherwise exist (#977, #978).

## Alternatives considered

- **Keep the client stream, add a size check after upload:** would catch the empty-PUT but leaves the throughput ceiling and burns the transfer twice on failure. Rejected once server-side copy was shown to work.
- **Trust HTTP status alone:** the original design. A 403 with an empty body still exits 0 through a pipe. Rejected — this is the bug.

## Receipts

- `.context/plan-import-robustness.md` — verified 2026-06-15
- `.context/research-openneuro-import-forensics.md`
- Epic #967 (incident + remediation), #973, #976
