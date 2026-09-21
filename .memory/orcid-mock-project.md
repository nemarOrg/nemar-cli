---
name: orcid-mock-project
description: "nemarOrg/orcid-mock (MIT) is the charter-only repo for an ephemeral mock ORCID server (OAuth, OIDC, public record API, JSON users, hosted multi-tenant mode later); not scheduled, start it with the epic workflow from its MVP1 epic issue"
metadata:
  type: project
---

Created 2026-09-08 right after the nemar-cli v0.10.0 release, at Yahya's request ("do we need a mock ORCID api engine ... should we make one for everyone ... MVP1 should be all the low hanging fruits ... host one on CF or on nemar infra for people"). Repo: https://github.com/nemarOrg/orcid-mock, docs only (README, AGENTS.md, .context/plan.md, research.md, ideas.md, fixtures/users.example.json with checksum-valid iDs 0009-0009-0000-00{12,20,39}).

**Decisions already made:** build rather than adopt (no existing ORCID mock; generic OIDC mocks bring a JVM, .NET, or a Duende license); Bun + Hono on a portable `fetch` layer so one codebase runs as a binary, a container, and a Cloudflare Worker; `jose` for RS256; in-memory `Store` interface with Durable Objects for the hosted mode; fixed `PUBLIC_BASE_URL`; MIT; MVP1 is read-only but covers the whole easy surface (identity incl. OIDC, all public v3.0 read endpoints, fixtures and admin, packaging); MVP2 adds member writes, the hosted multi-tenant service, XML, webhooks.

**Open questions recorded in plan.md:** the website's no-mocks policy versus a network stand-in; whether a CI-only dev-worker config may point `ORCID_API_BASE` at it; the legacy password sign-up route; Cloudflare versus nemar hosting.

**How to apply:** when Yahya says to start it, run the epic workflow on the MVP1 epic issue in that repo with the phases listed there; cite ORCID docs for every fidelity claim; adoption in nemar-cli replaces the per-file `Bun.serve` stand-ins in `backend/test`. See [[new-tooling-repos-mit]] and [[orcid-testing-reality]].

**Update 2026-09-08 (later):** the repo is PRIVATE (flipped at Yahya's request, "we will work on that later"), cloned at /Users/yahya/Documents/git/nemar/orcid-mock, and initialized with the project plugin's `init-project` templates: `.rules/` (javascript, git, testing with a note that the mock's own tests drive the real server, code_review, documentation, ci_cd, self_improve; python and serena removed), `.context/decisions/` with ADR 0001 (Bun on a portable fetch layer, in memory) indexed, AGENTS.md rewritten as the project map, CLAUDE.md = `@AGENTS.md`. GitHub labels not installed yet (the skill asks first).
