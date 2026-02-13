# API Reference

NEMAR CLI communicates with the NEMAR API. This reference is for advanced users.

## Base URL

```
https://api.osc.earth/nemar
```

## Authentication

All authenticated endpoints require:

```
Authorization: Bearer nemar_your_api_key
```

## Endpoints

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /auth/login | Validate API key |
| POST | /auth/signup | Register new user |
| GET | /auth/me | Get current user |
| POST | /auth/resend-verification | Resend email verification |
| POST | /auth/retrieve-key | Retrieve API key (email + password) |
| POST | /auth/request-key-regeneration | Request key regeneration |
| GET | /auth/confirm-key-regeneration | Confirm key regeneration |

### Datasets

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /datasets | List datasets |
| GET | /datasets/:id | Get dataset details |
| POST | /datasets | Create dataset |
| POST | /datasets/:id/upload | Get upload credentials |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /admin/users | List users |
| GET | /admin/users/pending | List pending approvals |
| POST | /admin/users/:id/approve | Approve user |
| POST | /admin/users/:id/reject | Reject user |
| POST | /admin/datasets/:id/doi/concept | Create concept DOI |

## Error Responses

```json
{
  "error": "Error message",
  "details": ["Additional information"]
}
```

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not found |
| 500 | Server error |
