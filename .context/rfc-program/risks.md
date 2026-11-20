# RFC program: pre-registered risks

Each risk has an observation, the date by which it is read, what happens if it reads bad, and who decides.
A decision date is the day on which nobody may keep hoping, not a deadline for the work.

| ID | Risk | Observation | Read by | If bad | Decides |
| --- | --- | --- | --- | --- | --- |
| K1 | The clock stops silently: GitHub disables a scheduled workflow in a public repository after 60 days without activity | `gh run list -R nemarOrg/rfcs -w rfc-clock -L 1` shows a run in the last 2 days | every checkpoint, and 2027-01-31 | run it by hand (`gh workflow run rfc-clock -R nemarOrg/rfcs`), and take R3 (the weekly report line) | owner |
| K2 | The specification text on docs.nemar.org sits under the docs repository's CC BY-NC-ND 4.0 license, which contradicts the decided W3C license | B3's page shows a per-page license notice naming the W3C license | B3 review | B3 does not merge without the notice | owner |
| K3 | RFC-0001 opens with no implementation and draws few concrete comments | count of substantive comments 10 days after O5 | O5 + 10 days | use the one extension with a call to named implementers; or close and reopen after B5 | owner |
| K4 | `.bzx` or `biosig-zarr` collides with an existing name | comments on the naming questions in RFC-0001 | RFC-0001 close | rename before any `.bzx` leaves NEMAR (the last cheap moment) | owner |
| K5 | V1's production read is refused by the permission classifier | V1's report | V1 | the owner runs the read-only query V1 hands over | owner |
| K6 | RFC-0002 accepts a new version grammar while automatic re-pulls are on | the RFC-0002 decision | C4 | the owner turns `AUTO_REPULL_ENABLED` off across the cutover and decides the open re-pull records first (ADR 0111) | owner |
| K7 | An ADR number taken by another open PR | `gh pr list -R nemarOrg/nemar-cli --search ADR` at A1's merge | A1 merge | take the next unused number | manager, mechanically |
| K8 | A 21-day window over the December holidays draws few comments | O5's date | O5 | open RFC-0001 on or after 2027-01-05, or plan the extension in advance | owner |
| K9 | `rfcs` text and biosig-zarr text carry different licenses, so quoting the specification in RFC-0001 needs a notice | Q6's answer | R1 | R1's `LICENSE.md` states how quoted specification text is licensed | owner (Q6) |
| K10 | The docs build's admin-gating and draft-policy checks refuse a fetched page or a `/policies/` page | `bun run build` in R2 and B3 | R2, B3 | the worker stops and reports; the lead decides | lead |
