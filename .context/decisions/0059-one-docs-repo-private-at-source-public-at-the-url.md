# ADR 0059: One docs repo, private at source, public at the URL

**Status:** accepted
**Date:** 2026-09-13
**Owner:** Seyed Yahya Shirazi
**Supersedes:** the mechanism half of ADR 0057, and its rejection of this option

## Context

ADR 0057 decided that admin-only material becomes private at source rather than merely gated at
serving, and chose to do it with a second, private content repository pulled into the docs build.
It considered privatizing `nemarOrg/docs` itself and rejected it, on the grounds that 53 of its 66
pages are public product documentation.

That reasoning conflated two different things, and the conflation is the reason it was wrong.
**Privatizing the repository does not privatize the documentation.** `docs.nemar.org` keeps serving
every public page to anyone, exactly as it does today. What closes is the source, and the source is
not the product.

Weighed against that, the overlay design was carrying real cost for no benefit the single-repo
version does not also deliver: a second repository to create and keep in step, a build-time content
pull, a credential in the docs build that can expire, a build that has to degrade gracefully when
the private half is unreachable, and a permanent split where a page's history lives in one of two
places depending on a classification someone made once.

## Decision

**One docs repository. `nemarOrg/docs` becomes private, and `docs.nemar.org` keeps serving the
public pages publicly.**

Admin-only material is then private at source by construction rather than by an overlay: nothing
has to be moved between repositories, and no build-time pull or content credential exists. The
`.context` runbooks named by ADR 0058 move INTO this repo, and `AGENTS.md`, `.rules/*` and
`.context/` point at `docs.nemar.org` URLs for everything that has moved.

Gated pages stay gated by the same session gate (ADR 0056), and agent retrieval of them still goes
through the credential exchange ADR 0057 describes. Nothing about serving changes.

## Consequences

- **Phase 3 of epic #1336 gets much smaller.** No private repo to create, no build-time pull, no
  content token, no graceful-degradation path. It becomes: flip visibility, move the runbooks in,
  repoint the pointers.
- **Outside contributors can no longer file issues or PRs against documentation source.** This is
  the real cost and it is accepted knowingly: the owner's judgment is that documentation fixes are
  not where outside contribution happens here, and the escalation route ADR 0057 requires
  (`AGENTS.md` tells a non-admin to tag the admin team) covers someone who spots a problem.
- **A CI checkout needs a credential.** `test/docs-links.unit.test.ts` reads that repo's content
  tree and treats a declared-but-missing checkout as a failure rather than a skip, deliberately. The
  workflow now falls back to `DOCS_READ_TOKEN` when set, so the visibility change needs no
  coordinated edit and has no window where CI is red.
- **The docs repo's own ADRs stop being publicly readable.** ADRs about this codebase stay in
  `nemar-cli`, which remains public, so what is lost is that repo's two platform ADRs rather than
  the decision record generally.
- **Two claims become false on the day the flip happens** and must change in the same change:
  `public/robots.txt` and `nemarOrg/docs` ADR 0002 both say non-disclosure "was never available
  anyway" because the repository is public. They are accurate until then.
- Everything already published stays in public git history. Unchanged from ADR 0058's reasoning: no
  credential value is involved and operational detail ages out.

## Alternatives considered

- **The overlay repo from ADR 0057.** Rejected on cost once the conflation above was seen: it buys
  nothing the single private repo does not, and it adds a repository, a build credential, and a
  failure mode.
- **Keep `nemarOrg/docs` public and gate at serving only.** This is what phase 0 shipped, and ADR
  0057 already records why it is not enough: a gate in front of a public source is cosmetic.
- **Split the difference: public repo, private `.context` runbooks left in `nemar-cli`.** Rejected
  because `nemar-cli` is public too, which is the defect ADR 0057 was written to fix.
