---
name: never-proxy-bulk-bytes
description: Cloudflare's terms restrict serving large files via the CDN, so both NEMAR data planes carry metadata and redirect bulk bytes; proposing to proxy them is a recurring mistake
metadata:
  type: project
---

Cloudflare's Service-Specific Terms require a paid tier "in order to serve video and other large
files via the CDN" and restrict "a disproportionate percentage of ... large files" on Free, Pro and
Business, with Enterprise exempt. NEMAR's bulk data lives in S3, outside Cloudflare, so proxying it
through a Worker at archive scale is exactly what those terms restrict.

**Both data planes already follow the same rule, and it is not an accident:**

| | metadata | bulk bytes |
|---|---|---|
| `data.nemar.org` | git-tracked files proxied, `MAX_BROKERED_FILE_BYTES` = 32 MB (`routes/data.ts`) | archive `302`s to a presigned S3 URL; the Worker "never streams the archive" |
| `zarr.nemar.org` | `index.json` and `catalog.json` proxied, D1-gated | chunks `302` to S3, bytes counted from the `Range` header |

The 32 MB ceiling is documented as "a guard against an annex-policy slip, not a working limit", and
the catalog is 283 KB, so it never fires in normal operation.

**Why it matters:** "put the bytes behind our CDN, it would make accounting easier" is a reasonable
sounding proposal that gets raised repeatedly, and it is wrong twice over. The terms forbid it, and
**the accounting it asks for already exists**: `recordAccess` fires on the redirect path
(`routes/zarr-data.ts`, three call sites) and counts bytes from the `Range` header. sccn/eegprep
issue nemarOrg/nemar-cli#1061 chose the redirect for precisely this reason: "the Worker never
carries the bytes, so there is no terms exposure, but every request is still counted." Moving to R2
was considered and rejected while AWS sponsors the S3 bucket.

**How to apply:** before proposing that anything be proxied rather than redirected, check the size
class. Metadata and contract documents go through the Worker so they can be gated, cached and
counted. Bulk bytes redirect, always. If the goal is observability, look for the existing
`recordAccess` call before building anything. See [[s3-403-is-not-absence]] and
[[data-plane-needs-v-prefix]]. Verified 2026-09-21.
