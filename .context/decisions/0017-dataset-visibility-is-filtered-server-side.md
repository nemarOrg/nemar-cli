# ADR 0017: Dataset visibility is enforced server-side, never by the client

**Status:** accepted
**Date:** 2026-01-27
**Owner:** Seyed Yahya Shirazi

## Context

`nemar dataset list` returned **all** datasets to **all** callers, including private datasets belonging to other users — names, descriptions, owners, and metadata. Unpublished work under embargo was readable by anyone with an account. Classified critical at the time.

## Decision

Visibility is enforced in the API query itself. The backend returns only what the authenticated caller may see: public datasets, plus private datasets they own or collaborate on. The CLI renders whatever it is given and performs no filtering of its own.

## Consequences

- A new client, a raw `curl`, or a stale CLI cannot see more than its caller is entitled to. Filtering in the client would have left the data one HTTP request away.
- Every new list, search, or catalog endpoint inherits the obligation. This is the recurring cost: the FTS5 index, the vector index, and `data.nemar.org` listings each need their own scoping, and getting one wrong reopens the hole.
- Admin views need an explicit, separately authorised path rather than "the same endpoint without the filter."

## Alternatives considered

- **Filter in the CLI:** trivially bypassed — the data has already crossed the wire. Not a security control. Rejected.
- **Separate public and private endpoints:** clear boundary, but doubles the endpoint surface and the drift risk between them. Rejected in favour of one scoped query.

## Receipts

- `.context/security-fix-dataset-visibility.md` — 2026-01-27
- ADR 0002 (GitHub collaboration is the source of truth for who may access what)
