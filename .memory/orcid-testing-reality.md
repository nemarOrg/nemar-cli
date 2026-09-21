---
name: orcid-testing-reality
description: ORCID sandbox is unusable; staging uses the production ORCID app; tests stand in for ORCID with a local Bun.serve via ORCID_API_BASE and seed sessions with seed-web-user
metadata: 
  node_type: memory
  type: project
  originSessionId: 0b1a7f7c-8b12-457d-ab0a-b7f47c6c0ba3
  modified: 2026-09-06T19:47:09.498Z
---

The ORCID sandbox "barely works" (Yahya, 2026-09-06), so nothing in NEMAR is tested against it.
Staging (`api-test.nemar.org`, `test.nemar.org`) carries the PRODUCTION ORCID app credentials
with the test callback registered; see the comment block in `backend/wrangler-sccn.toml`
("ORCID SSO on staging uses the PRODUCTION ORCID app, not sandbox").
Backend route tests reach ORCID's token exchange and public record API through a local
`Bun.serve()` pointed at by the `ORCID_API_BASE` / `ORCID_PUB_API_BASE` bindings
(pattern: `backend/test/identity-refusals-route.test.ts`), and seed a web session with
`POST /admin/test-fixtures/seed-web-user` plus the non-production `dev_code` path.

**Why:** real ORCID is only reachable through a browser redirect on a registered host,
so any flow that depends on it must be split into an ORCID-free core (testable locally,
no mocks) and one manual walk-through on staging with a real ORCID account.

**How to apply:** when planning an ORCID-touching feature (epic nemar-cli#1272, device flow),
design the new endpoints so they sit behind the existing web session and callback,
test them at the HTTP entry points with the stand-in, and reserve real ORCID for one
manual staging run from `ssh mcm` / `ssh mba`. Never propose the sandbox.
Related: [[design-for-90-10-and-headless]], [[bun-test-lenient-vs-workerd]].
