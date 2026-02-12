# EZID API Reference

Complete reference for the EZID REST API (v2).

## Authentication

### HTTP Basic
```
Authorization: Basic base64(username:password)
```

### Session Cookie (alternative)
```bash
# Login (returns session cookie)
curl -u user:pass https://ezid.cdlib.org/login

# Use cookie in subsequent requests
curl -b cookies.txt https://ezid.cdlib.org/id/doi:10.82901/NEMAR.XXX
```

## ANVL Format

A Name-Value Language. Each line is `key: value`. Special characters must be percent-encoded:

| Character | Encoding |
|-----------|----------|
| `%` | `%25` |
| `\n` | `%0A` |
| `\r` | `%0D` |

Lines starting with `#` are comments (upload only). Lines starting with whitespace continue the previous value.

## Endpoints

### Check Server Status
```
GET /status
Response: success: EZID is up
```

### Mint Identifier (create with auto-generated suffix)
```
POST /shoulder/{shoulder}
Content-Type: text/plain

_target: https://nemar.org/datasets/{id}
_status: reserved
_profile: datacite
datacite: {percent-encoded DataCite XML}
```
Response: `success: doi:10.82901/NEMAR.XXXXXX | ark:/xxxxx/xxxxxxxx`

### Get Identifier
```
GET /id/{identifier}
```
Response: ANVL-formatted metadata (all fields).

### Update Identifier
```
POST /id/{identifier}
Content-Type: text/plain

{ANVL key-value pairs to update}
```
Only specified fields are updated. Set value to empty string to delete a field.

### Delete Identifier (reserved only)
```
DELETE /id/{identifier}
```

### Create or Update (atomic)
```
PUT /id/{identifier}?update_if_exists=yes
```
Returns 201 if created, 200 if updated.

## Reserved Metadata Elements

Prefixed with `_`. Updatable ones marked with checkmark:

| Element | Updatable | Description |
|---------|-----------|-------------|
| `_target` | Yes | Landing page URL (defaults to EZID URL) |
| `_profile` | Yes | Metadata profile: `datacite`, `erc`, `dc` |
| `_status` | Yes | `reserved`, `public`, `unavailable` |
| `_owner` | Yes | Identifier owner username |
| `_export` | Yes | Include in external services (`yes`/`no`) |
| `_created` | No | Unix timestamp |
| `_updated` | No | Unix timestamp |
| `_ownergroup` | No | Owner's group |
| `_datacenter` | No | DataCite registration center |

## Status Transitions

| From | To | Notes |
|------|----|-------|
| reserved | public | DOI becomes findable in DataCite |
| public | unavailable | Object removed; tombstone page shown |
| unavailable | public | Restore previously unavailable DOI |

`unavailable` can include a reason: `unavailable | withdrawn by author`

## Error Responses

```
HTTP/1.1 400 BAD REQUEST
error: bad request - {reason}
```

| Code | Meaning |
|------|---------|
| 400 | Bad request (invalid ANVL, missing fields) |
| 401 | Authentication required or failed |
| 403 | Permission denied |
| 404 | Identifier not found |
| 500 | Server error |

## Shoulders (Namespaces)

| Shoulder | Type | Notes |
|----------|------|-------|
| `doi:10.82901/NEMAR.` | Production | NEMAR's prefix; permanent DOIs |
| `doi:10.5072/FK2` | Test | Auto-deleted after 2 weeks |
| `ark:/99999/fk4` | Test ARK | For testing ARK identifiers |

## Batch Download

```
POST /download_request
Content-Type: application/x-www-form-urlencoded

format=csv&owner=nemar-admin&type=doi
```

Response: URL to poll for download file. Downloads retained one week.
