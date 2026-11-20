# ADR 0130: Community input goes through a time-boxed RFC

**Status:** accepted
**Date:** 2026-11-20
**Owner:** Seyed Yahya Shirazi

## Context

Some NEMAR decisions bind people outside NEMAR: a file format other tools must read, a version rule that changes how a citation reads, a rule for author-owned content.
Until now they were argued in issues and chats, with no fixed place to comment, no end date and no record that a named person answered each objection.
BIDS Extension Proposals (BEPs) show the other failure: an open-ended window lets a proposal stall for years.
Reviews today are often helped by artificial intelligence (AI), and NEMAR welcomes AI-assisted review and contributions when knowledgeable people use the AI and check what it produces.
With that help a careful review fits in three weeks, so NEMAR's Request for Comment (RFC) process is deliberately fast-paced.

## Decision

A decision that needs community input goes through an RFC in one public repository, `nemarOrg/rfcs`, which holds the record and the one number space (`NEMAR RFC 0001`).

1. **Home.** Every comment thread, whether the RFC concerns the organization or one dataset, is a Discussion in `nemarOrg/rfcs`. No dataset repository gets Discussions and the NEMAR GitHub App gets no new permission.
2. **Window.** At most 21 calendar days in Coordinated Universal Time (UTC), with one extension of at most 14 days, granted before the close with a stated reason (35 days at most). At most one RFC is open for comment at a time.
3. **Final comment.** Inside the window, the shepherd posts a summary and a proposed disposition at least 7 days before the close; that post is required to accept.
4. **Who.** Anyone may propose; a NEMAR owner or administrator opens the RFC as its shepherd. The owner decides an organization RFC and answers each objection in writing. NEMAR decides a dataset RFC with the dataset owner's recorded position, and consent for author-owned content.
5. **Comments without a GitHub account** are accepted through the support address and posted with the sender's consent.
6. **Outcome.** An accepted RFC, and a rejected one that closes off a reasonable path, produces an ADR whose header line reads `Decided through NEMAR RFC NNNN (link).`. The ADR wins over the RFC where they disagree. Specification decisions are recorded in the specification's own repository, and NEMAR profile and rollout decisions in nemar-cli, each linking its RFC.
7. **Clock.** A scheduled GitHub Action in `nemarOrg/rfcs` runs the window and feeds a weekly report line.
8. **Licenses.** MIT License for the tooling and Creative Commons Attribution 4.0 International (CC BY 4.0) for the text.

## Consequences

The process is provisional and is reviewed after its first two RFCs.
Community decisions gain a deadline, a public record and a named answer to every objection; a proposer can no longer wait out the discussion.
The cost is one more public repository to keep, and a hard limit that can close an RFC before a late commenter arrives; the extension and the end-of-window summary are the answer to that.
An RFC is not the route for a privacy correction under ADR 0085, a security fix, an internal architecture choice (an ADR alone records those), or an ordinary dataset pull request.

## Alternatives considered

- **Organization Discussions only:** no per-RFC number, no reviewable text, no clock. It loses the record.
- **Discussions on each `nemarDatasets` repository:** rejected by the owner on 2026-11-20. It needs a new App permission, splits the comments across repositories, and a commenter has one place to look instead of many.
- **Open-ended windows, as BEPs have:** the proposal stalls and the community cannot tell when to speak; a fixed window of three weeks, with one extension, is enough for a careful AI-assisted review.

## Receipts

- Owner decisions of 2026-11-20, `.context/rfc-program/plan.md` section 2.
- `nemarOrg/rfcs` (the repository this ADR adopts).
