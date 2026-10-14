# ADR 0104: A withdrawn publication request is a denied one with `withdrawn_at`

**Status:** accepted
**Date:** 2026-10-14
**Owner:** Seyed Yahya Shirazi

## Context

A depositor could not take a publication request back; only an administrator could end it.
`publication_requests.status` is guarded by a CHECK constraint (`requested`, `approving`, `published`, `denied`, `blocked`), and several readers ask whether a request is finished with `status NOT IN ('published', 'denied')` or `status IN ('requested', 'approving', 'blocked')`: the re-request path, the staleness cron, the dataset delete guard and the publication sweep.

## Decision

1. A withdrawal is stored as `status = 'denied'` with a nullable `withdrawn_at` (migration 0097). `denied_by` and `denied_reason` stay NULL. The CHECK is not widened: that would rebuild a table of about thirty columns, and every reader above would have to learn a sixth status.
2. Anything that must tell the two endings apart reads `withdrawn_at` together with `status = 'denied'`. The status route reports `withdrawn` only for a denied row, so a row revived by a later re-request is not called withdrawn.
3. The owner withdraws with `POST /datasets/:id/publish/withdraw`, one conditional UPDATE that requires `requested` or `blocked` and no approval in flight. The other writers that end or start a request are guarded the same way (the administrator's deny, the orchestrator's mark-approving write), so a withdrawal and an approval or a denial that race cannot both succeed: the loser answers 409 and sends nothing.
4. A writer that ends a request must guard on the request still being active and check the number of rows changed.

## Consequences

- A withdrawal is invisible to every reader that only knows `denied`; the administrator's list and the depositor's status say "withdrawn" from `withdrawn_at`.
- Administrators are not mailed on a withdrawal. A request simply leaves the active list.
- The dataset's staleness clock treats a withdrawn request like a denied one: there is no pending request.
- A future writer of `status` on this table must keep the guard in 4.
