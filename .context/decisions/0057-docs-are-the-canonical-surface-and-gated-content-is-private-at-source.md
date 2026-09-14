# ADR 0057: Docs are the canonical surface, and gated content is private at source

**Status:** accepted
**Date:** 2026-09-13
**Owner:** Seyed Yahya Shirazi

> **The MECHANISM here is superseded by [ADR 0059](0059-one-docs-repo-private-at-source-public-at-the-url.md) (2026-09-13).**
> The decision below stands: docs are the canonical retrieval surface, and admin-only material is
> private at source rather than gated at serving. How that is achieved changed. This ADR chose a
> second, private content repository pulled into the docs build; `nemarOrg/docs` is instead made
> private as a whole, which reaches the same end with no overlay, no build-time pull and no content
> credential. The status stays `accepted` because most of this document is still in force; read
> 0059 before acting on the alternatives section.

## Context

Epic #1336 set out to move agent-facing reference material from this repo's `AGENTS.md` and
`.context/` into `nemarOrg/docs`, on the reasoning that docs content is one `git pull` away for any
agent or person in any of our repos and is also published at `docs.nemar.org`.

Phase 0 built the admin gate and, in doing so, exposed a hole in that reasoning. The gate controls
who is SERVED `docs.nemar.org/admin/*`. It does not control who can read the source, because
`nemarOrg/docs` is public. The rule that was supposed to cover the difference, in the docs repo's
own `AGENTS.md`, says to keep genuinely internal material in `nemar-cli` instead. **`nemar-cli` is
also public.** So that rule was a surface rule wearing the language of a secrecy control, and the
epic's own phase 3, "move the operational runbooks behind the gate", would have moved them from one
public repository to another and called the result gated.

**Calibrate this correctly, because the fix is proportionate to it.** NEMAR is an open project and
its openness is the norm, not an oversight. `.context/` is 97 committed files in this public repo,
including `systems-inventory.md` (SSH host aliases, `/mnt/local` state paths, cron schedules, the
Hallu deploy mechanism, disaster recovery) and `validated_workflows.md`, the two files phase 3
named. Checked at the time of writing: neither holds a credential value, so this is topology and
procedure, not leaked keys, and nothing needs rotating. This is not an incident and should not be
written up as one.

The bar being set is narrower and more useful: **publish good examples, not a recipe for attacking
the platform.** Knowing that a Zarr conversion runs on an SDSC host is fine and worth documenting;
an assembled map of host aliases, exact state paths, cron windows and the deploy mechanism is a
different artifact, and it is the assembly rather than any single fact that earns the move.

The second half of the reasoning also does not survive contact. "One `git pull` away" quietly
assumed repository access is how agents retrieve documentation. It does not have to be. The docs URL
serves that purpose, and serving it that way is what makes a public/private source split possible at
all.

## Decision

`docs.nemar.org` is the canonical retrieval surface for documentation, for humans and agents alike,
and repository access is not part of the retrieval contract.

Three consequences follow, and they are the decision:

1. **Public documentation stays public, deliberately.** The product documentation is a public good
   and its openness is not a defect to be fixed. Nothing here argues for closing it.
2. **Admin-only material is private AT SOURCE**, not merely gated at serving, and it is moved out of
   every public repository that holds it today: `nemar-cli`, `docs`, `website`, and any other. A
   gate in front of a public source is cosmetic. "Admin-only" is judged by the recipe test above,
   not by whether a page feels internal: most design notes and decision records stay public, and
   the things that move are the assembled operational maps.
3. **Agents retrieve over HTTP, so the docs must be machine-readable.** Public pages get a
   markdown representation alongside the HTML, indexed by `llms.txt`. Telling an agent to read a
   URL that only serves HTML is telling it to scrape.

**An admin retrieves gated docs by exchanging a credential, never by presenting one to the docs
edge.** A holder of an admin or owner API key, or a `service` account key (ADR 0048), calls this
backend to mint a short-lived docs-scoped token and presents only that to `docs.nemar.org`. The
long-lived API key never reaches the docs host or its logs. This preserves the property ADR 0056
exists for: a docs credential cannot authenticate the management API, and now the reverse holds too.

**Losing read access must not cost a contributor the ability to report a problem.** Non-admin
contributors keep filing issues and fixes against the public repos. Where a problem is
admin-adjacent and the relevant runbook is not readable, `AGENTS.md` tells them to escalate by
tagging the admin team rather than leaving them stuck. Escalation is the substitute for read access;
silence is not.

## Consequences

- The docs build gains a credential, because it pulls private content at build time, so it can fail
  on token expiry. Absence of that content must be a visible skip that still builds the public site,
  or a fork or outside contributor is blocked from building the docs at all.
- Preview deployments will contain admin content. They sit behind Cloudflare Access, which is the
  one place that application genuinely applies.
- Two statements shipped today become false the day the source moves, and must change in the same
  change, not before: `public/robots.txt` and ADR 0002 in `nemarOrg/docs` both say non-disclosure
  "was never available anyway" because the repository is public. Until the move lands they are
  accurate, which is why they are not being corrected in advance.
- A machine-readable surface is bot-attracting by construction. It needs the same treatment the zarr
  plane already has: cache rules and rate limiting that counts without blocking legitimate clients.
- Public git history keeps the material that is moved, so the move reduces future exposure and not
  past. Accepted deliberately: no credential value is involved, and operational detail of this kind
  ages out on its own. Paths, cron windows and host layouts drift, so a snapshot in history is a
  weaker artifact every month, where a maintained document stays accurate indefinitely. That
  reasoning holds only while nothing secret is in the history; it would not justify leaving a key
  behind.
- An escalation handle has to exist. There are no GitHub teams in `nemarOrg` today, so one must be
  created before `AGENTS.md` can point at it. Pointing at a handle that does not resolve is worse
  than pointing at nothing.
- This supersedes the sorting rule in epic #1336's original framing, where the three buckets were
  publishable, admin-gated, and "must stay in this repo". The third bucket was doing the work of a
  privacy control and cannot: staying in this repo is staying public.

## Alternatives considered

- ~~**Privatize `nemarOrg/docs` entirely.** Rejected:~~ **This is now the decision; see ADR 0059.**
  The rejection below conflated privatizing the REPOSITORY with privatizing the DOCUMENTATION.
  `docs.nemar.org` keeps serving every public page to anyone either way; only the source closes. The
  original reasoning follows, wrong: 53 of its 66 pages are public product
  documentation, and it would break ADRs being linked at their public GitHub paths, which is how
  this epic decided to keep decisions in `nemar-cli` while referencing them from docs.
- **Keep the content rule and move only what is safe to publish.** Rejected as the primary answer
  because it leaves the gate cosmetic and the runbooks public, which is the state this ADR exists to
  end. It remains the right answer for material that does not need to move at all.
- **Let agents present their API key directly to `docs.nemar.org`.** Simpler, one hop, no new route.
  Rejected: it puts a credential that authenticates the management API into the docs edge and its
  logs, undoing the separation ADR 0056 was built to create.
- **Gated docs are human-only.** Considered, and it is the smaller design. Rejected because operator
  agents on Hallu and in CI are exactly the readers these runbooks are written for.
