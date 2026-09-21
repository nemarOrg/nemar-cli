---
name: s3-cors-two-rules-order
description: The nemar bucket CORS has two ordered rules; the read rule must stay first or uploads or Range reads break
metadata: 
  node_type: memory
  type: project
  originSessionId: 9385d577-e7b2-43ad-980d-5e6404097302
  modified: 2026-09-16T19:45:58.123Z
---

The `nemar` S3 bucket (us-east-2) has a two-rule CORS configuration as of 2026-09-16.
Order is load-bearing: S3 applies the FIRST rule matching origin plus method plus headers.

1. `browser-reads` -- GET/HEAD. Origins: `https://nemar.org`, `https://*.nemar.org`, both Pages
   projects plus their preview wildcards, `https://demo.osc.earth`, `http://localhost:*`,
   `http://127.0.0.1:*`. Exposes `ETag, Content-Length, Content-Range, Accept-Ranges,
   Content-Type, Last-Modified`. MaxAge 86400.
2. `website-uploads` -- PUT/GET/HEAD, `https://nemar.org` and `https://app.nemar.org`,
   exposes `ETag` only, MaxAge 3600. This is the pre-existing rule, unchanged.

Put the read rule second and every GET falls into the upload rule, which exposes only `ETag`;
drop the upload rule and the website upload flow's `PUT` preflight fails.

**Why:** `Content-Range` is returned on the wire but is unreadable from browser code unless it is
in `Access-Control-Expose-Headers`. Without it a browser Zarr reader cannot tell a real 206 from a
server that ignored the Range and sent the whole object, which is the silent-wrong-bytes class that
the MCP read_window work already hit once. ADR 0049 puts browser compute on this path, so the
expose list is a correctness requirement, not a convenience.

**How to apply:** Probing the bucket with an origin that matches no rule returns NO CORS headers at
all and a 403 preflight, which reads exactly like "the bucket has no CORS config". It is not.
Always probe with `Origin: https://nemar.org` before concluding anything. CORS never grants access:
private objects still 403 (checked against `xx099907` with a public control).
`zarr.nemar.org` and `mcp.nemar.org` deliberately stay NEMAR-origin-only; browser readers address
`data_base` on S3 directly instead. Related: [[s3-403-is-not-absence]], [[prove-the-inverse-path-too]].
