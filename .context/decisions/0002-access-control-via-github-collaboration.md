# ADR 0002: Access control rides on GitHub collaboration, not a NEMAR permission layer

**Status:** accepted
**Date:** 2026-02 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

Users need to read and write dataset repositories with per-dataset permissions. NEMAR could either proxy all repository access behind its own API and permission model, or delegate to GitHub's existing collaborator model and stay out of the data path.

## Decision

Users supply a GitHub username at signup and are added as GitHub collaborators on the repositories they may access. They interact with repos using their own GitHub credentials. The NEMAR backend is used only for repo creation, collaborator management, S3 credential issuance, and dataset ID assignment; it is not in the path of ordinary git operations or PR merges.

## Consequences

- No bespoke permission system to write, audit, or keep in sync with GitHub. GitHub is the single source of truth for who can do what, and `affiliation=direct` is how we read it.
- Users must have a GitHub account, which is a real barrier for some depositors.
- Anything GitHub cannot express, we cannot express. Download-only access, for instance, needs a separate mechanism (see #1016, #1013).
- The admin PAT becomes load-bearing for repo/collaborator operations and is a shared rate-limit and blast-radius concern (#432 tracks the App migration).
- Revoking NEMAR access must explicitly cascade to the GitHub collaborator record; the two do not revoke each other.

## Alternatives considered

- **NEMAR-proxied access with its own ACLs:** full control over the permission vocabulary, but puts NEMAR in the data path for every clone and push, and duplicates a model GitHub already enforces well. Rejected as disproportionate.
- **Public-everything, no per-dataset access:** simplest, but unpublished datasets need to be private during preparation and embargo. Rejected.

## Receipts

- `.context/access_control.md`
- `.context/dataset_workflow.md`
- #713 (collaborator truth is `affiliation=direct`), #432 (GitHub App migration)
