# ADR 0041: DOIs cite the uploader by real name, or not at all

**Status:** accepted
**Date:** 2026-09-05
**Owner:** Seyed Yahya Shirazi

> Numbering note: epic #1250 runs phases in parallel. Phase 1 (PR #1258) keeps
> 0040 and merges into the epic branch first, so this one is 0041. Until that
> merge is rebased in, 0040 does not exist on this branch and the ADR index's
> gapless check fails here by construction; it goes green with the rebase.

## Context

Every DOI NEMAR mints names the depositor as a DataCite `DataCurator`
contributor, and until now that name was `users.username` -- a login handle like
`jdoe23`. A handle is not a name: it is not how the person is cited anywhere
else, it does not decompose into the `givenName`/`familyName` parts DataCite
expects, and it cannot be reconciled against an ORCID record. The same string
also drove the ORCID-to-BIDS-Authors match, so an ORCID was attached to an author
only when their handle happened to appear inside the author string.

Migration 0051 added `users.given_name`/`users.family_name` for exactly this,
with ORCID as the canonical source, but nothing downstream read them. Meanwhile
DOIs are permanent (ADR 0007): a record minted with a handle in it stays that way
in DataCite's index, so the cost of getting this wrong does not decay.

## Decision

The DataCite/EZID/Zenodo uploader attribution is built from `given_name` and
`family_name` and from nothing else. When an account has no citable name -- either
part missing -- **no uploader attribution is emitted at all**, and the mint paths
(publication request, admin publish, admin concept-DOI) refuse with the typed
publish-block reason `owner_name_missing` rather than proceeding.

`resolveUploaderIdentity` in `backend/src/services/uploader-identity.ts` is the
only place those two columns become a citable identity, and it returns `null`
for a half-filled name. There is no username fallback anywhere.

## Consequences

- A DOI is either attributed to a person by the name they publish, or not
  attributed to a depositor at all. Both are defensible in a scholarly record;
  citing a login handle is not.
- Publishing gains a precondition that lives on the ACCOUNT rather than the
  dataset, which is a new shape for this codebase. It is reported like any other
  block reason, so the existing `/publish/status` surface renders it unchanged.
- OpenNeuro imports and the exemplar fleet are exempt (`requiresUploaderName`):
  their owner row is a service or admin account, they have no ORCID to backfill
  from, and blocking them would strand imports with no in-product fix.
- Author matching now compares the two name parts independently, so an author
  list written `Given Family` matches as well as `Family, Given`. This is
  strictly better than the old whole-string match, but it is a behaviour change:
  a dataset whose author list names a same-family-name colleague no longer
  suppresses the curator entry.
- Accounts created before signup read ORCID need filling. That is what
  `nemar admin backfill-names` is for; accounts whose ORCID record hides its name
  must supply it themselves.

## Alternatives considered

- **Fall back to the username when no real name exists.** The status quo, and the
  thing this ADR exists to forbid. It fails silently and permanently: nobody
  notices a handle in a DataCite record until it is cited.
- **Fall back to the BIDS `Authors` list.** Attributes the deposit to whoever is
  listed first, which is a different claim from "this person deposited it" and is
  wrong exactly when it matters (a data manager depositing someone else's study).
- **Emit a half name (`givenName` only).** DataCite accepts it, but the record
  then reads as a complete name that happens to be missing a surname, and the
  half is not enough to match against ORCID. `null` is the honest value.
- **Require the name at signup, hard.** Rejected: ORCID may legitimately hide a
  name and a registration is a bad place to fail. The block moves to publish
  time, where the name is actually needed.

## Receipts

- Issue #1255, epic #1250 (phase 5).
- Migration `0051_user_real_name.sql` -- the columns, and ORCID as their source.
- ADR 0007 (EZID is the registrar; DOIs are permanent).
- ADR 0026 (the precedent for a typed, itemised publish-block reason).
