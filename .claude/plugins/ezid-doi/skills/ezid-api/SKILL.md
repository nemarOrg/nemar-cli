---
name: ezid-api
description: >
  This skill should be used when the user asks about "DOI management", "EZID API",
  "DataCite metadata", "mint a DOI", "create DOI", "update DOI metadata",
  "DOI registration", "DataCite XML", "ANVL format", or any NEMAR dataset DOI operations.
  Provides complete EZID API patterns, DataCite metadata field reference, and
  BIDS-to-DataCite mapping for rich scholarly metadata.
---

# EZID DOI Management for NEMAR

Use the EZID API to register DataCite DOIs for NEMAR datasets with prefix `doi:10.82901/NEMAR.`

## Architecture

- **EZID** = primary DOI provider (rich DataCite metadata via kernel-4 XML)
- **Zenodo** = backup archive only (draft depositions, no public DOI)
- **Backend service**: `backend/src/services/ezid.ts` (API client)
- **DataCite builder**: `backend/src/services/datacite.ts` (XML generation)

## EZID API Basics

- **Base URL**: `https://ezid.cdlib.org`
- **Auth**: HTTP Basic (`Authorization: Basic base64(username:password)`)
- **Format**: ANVL (A Name-Value Language) - `key: value\n` pairs
- **Production shoulder**: `doi:10.82901/NEMAR.`
- **Test shoulder**: `doi:10.5072/FK2` (auto-deleted after 2 weeks)

### Core Operations

| Operation | Method | URL | Auth |
|-----------|--------|-----|------|
| Mint DOI | POST | `/shoulder/{shoulder}` | Required |
| Get DOI | GET | `/id/{identifier}` | Not required |
| Update DOI | POST | `/id/{identifier}` | Required |
| Delete DOI | DELETE | `/id/{identifier}` | Required (reserved only) |
| Server status | GET | `/status` | Not required |

### DOI Status Lifecycle

```
reserved --> public --> unavailable
   |                       |
   v                       v
(deletable)          (tombstone page)
```

- `reserved`: Not advertised, deletable. Use for pre-registration.
- `public`: Registered with DataCite, permanent. Set when publishing dataset.
- `unavailable`: Public but object inaccessible. For retracted datasets.

### ANVL Format

Request bodies use ANVL encoding. Percent-encode these characters:
- `%` -> `%25`
- `\n` -> `%0A`
- `\r` -> `%0D`
- `:` in values (only at start) -> `%3A`

For rich metadata, set the `datacite` ANVL key to full DataCite kernel-4 XML.

## DataCite Metadata Strategy

NEMAR populates ALL 20 DataCite properties (unlike OpenNeuro which leaves most empty).
Read `references/datacite-fields.md` for the complete field reference.
Read `references/metadata-mapping.md` for BIDS-to-DataCite mapping.

### Mandatory Fields (always set)
1. Identifier, 2. Creator, 3. Title, 4. Publisher (always "NEMAR"), 5. PublicationYear, 10. ResourceType (Dataset)

### Recommended Fields (set when available)
6. Subject (keywords), 7. Contributor (NEMAR as HostingInstitution), 8. Date, 12. RelatedIdentifier (paper DOIs), 17. Description, 18. GeoLocation

### Optional Fields (set when available)
9. Language, 11. AlternateIdentifier, 13. Size, 14. Format, 15. Version, 16. Rights, 19. FundingReference

## Testing

Always test against `doi:10.5072/FK2` before production. Test credentials:
- Username: `apitest`
- Password: `ezidapitest2025!`

Read `examples/` for working curl examples. Run `scripts/test-connectivity.sh` to verify API access.

## Code Reference

- EZID service: `backend/src/services/ezid.ts`
- DataCite XML builder: `backend/src/services/datacite.ts`
- Zenodo service (backup): `backend/src/services/zenodo.ts`
- CLI DOI commands: `src/commands/admin.ts` (search for "doiCommand")
- API client: `src/lib/api/admin.ts` (search for "Doi")
- Backend DOI routes: `backend/src/routes/admin/doi.ts`
