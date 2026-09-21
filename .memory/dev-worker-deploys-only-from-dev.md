---
name: dev-worker-deploys-only-from-dev
description: "The dev worker (api-test.nemar.org) deploys only on pushes to `dev`; phase PRs cannot get a green live tier or a staging walk-through until the epic merges, and there is no local wrangler login"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0f33834a-28ae-4fc8-b46d-31227beabe37
  modified: 2026-09-07T06:15:24.144Z
---

`.github/workflows/deploy-backend.yml` deploys `nemar-api-dev` only when `github.ref` is `refs/heads/dev` (production only from `main`); there is no `workflow_dispatch` with a ref input, and `wrangler whoami` on this machine reports "Not logged in" with no `CLOUDFLARE_API_TOKEN` in the environment (checked 2026-09-06 on epic #1272).
The `integration-dev` CI tier runs on PRs into `feature/issue-*-epic-*` branches against the already-deployed dev worker, so a live-tier test for new routes is red (or must skip) until the epic branch reaches `dev`.

**Why:** live tests and the per-phase "staging walk-through with a real ORCID account" both need the phase's code on `api-test.nemar.org`, which only the `dev` branch feeds.

**How to apply:** when a phase adds backend routes, write its live-tier test to probe the route first and skip loudly on a 404 (say why in the file), keep its unit tier as the proof, and schedule the staging walk-through for after the epic merges to `dev`, or ask Yahya to deploy the branch by hand (`npx wrangler deploy --env dev -c wrangler-sccn.toml` from `backend/`). Record the constraint in the epic state file so later phases do not rediscover it. See [[epic-branch-ci-and-purge-lock]] and [[ci-tier-grep-and-checks-exit-code]].

**Correction 2026-09-08:** wrangler IS available through cfman (`bunx cfman wrangler --account sccn ...`); see [[wrangler-via-cfman]]. The "no local wrangler login" claim above only holds for the bare wrangler binary.
