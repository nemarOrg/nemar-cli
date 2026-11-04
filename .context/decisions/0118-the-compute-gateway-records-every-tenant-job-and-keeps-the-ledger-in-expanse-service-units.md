# ADR 0118: The compute gateway records every tenant job and keeps the ledger in Expanse service units

**Status:** accepted
**Date:** 2026-11-03
**Owner:** Seyed Yahya Shirazi

Epic #2005, issue #2006.
Refines stage 3 of [ADR 0049](0049-compute-runs-in-the-browser-osa-owns-the-runtime-only-hpc-is-gated.md) and keeps [ADR 0040](0040-approval-is-the-single-writer-of-upload-access.md) and [ADR 0042](0042-upload-access-is-requested-once-by-the-person-who-wants-it.md) intact: compute access is its own grant, never `service_access`, and approval is a person's decision.

## Context

ADR 0049 left stage 3, HPC submission, as "a NEMAR gateway" without saying who runs a job, who holds its record or how time is counted.
NEMAR now runs jobs on SDSC's Expanse through a Tapis tenant, from three front doors (the CLI, the website, a partner site) and for its own pipelines.
Tapis has no allocations and no idempotency key, signs no webhook, lets a job's owner edit its tags, and a partner site can mint a Tapis token for any username, so the Tapis record alone cannot say who ran what or what it cost.

## Decision

1. **A community account runs every job**, so people need no ACCESS or Expanse account of their own.
2. **NEMAR is the record of every tenant job, whichever front door submitted it**: who ran it, exactly what was submitted, what it cost, what happened and the logs.
3. **The ledger is append-only integer thousandths of an Expanse service unit (SU)**, never floating point.
   One SU is one core-hour with up to 2 GB per core, or one GPU-hour.
   A hold precedes every submit, as one conditional insert that checks the person's pool and the platform budget; a refused hold writes nothing.
4. **A charge settles twice.**
   Provisionally from the Tapis record when the job ends, then finally from Expanse's own accounting, as an adjustment; a difference within the owner's policy tolerance is routine and a larger one is reported.
   A failure NEMAR caused is refunded; a user-caused one, including a result upload refused for size or quota, is not.
5. **An unreserved partner job is cancelled and charged to the partner's pool, never to a person**, because a Tapis `owner` is not proof of who ran a job.
6. **Webhooks are hints.**
   NEMAR reads the job back from Tapis before it acts, polls as a backstop, and tags every job `nemar_job:<id>` so a retried submit finds the job instead of submitting twice.
7. **Retention is a policy row, not a constant**: records 7 years, logs 1 year, results 30 days and never fewer than 14.
   Storage is two private Cloudflare R2 buckets, records (locked by prefix) and results (expiring), outside the AWS account that holds the Open Data buckets.
   Only the Worker reaches them, through bindings, and no storage credential reaches Tapis, a node or the launcher: uploads go to addresses the Worker signs for one file of one job.
8. **`COMPUTE_ENABLED` is a dark switch**: exactly `1`, absent from the wrangler configuration and pinned by a test; every compute cron runs in production only.
9. **NEMAR reports ACCESS gateway attributes for every tenant job**, once, under a per-account pseudonym that is not the sign-in subject.
10. **Every compute word is declared once**: states, failure, refusal, ledger and cancel words in `shared/compute-state.ts`; the job specification, partition and rate tables, owner policy and launcher file shapes in `shared/contract/compute.ts`; the launch specification in `shared/contract/compute-launch.ts` and its JSON Schema, which `nemarOrg/nemar-process` copies byte for byte.

## Consequences

- Later phases import these modules instead of declaring their own words, numbers or states, and a test fails when one is added or dropped.
- NEMAR carries a ledger, a record store and retention duties it did not have; the periods are owner policy, so counsel's answer changes a row, not a deploy.
- The rate table (2 GB per core, 92 GB per GPU, preempt at 0.8, a 1 SU minimum) and the `debug` ceilings are unconfirmed with SDSC and stay marked so until the first charge is compared with Expanse.
- Access, approval and the partner contract are not decided here; they follow ADR 0040 and ADR 0042 in Epics B and D.

## Alternatives considered

- **Per-person Expanse accounts.** Cannot be asked of this audience, and ACCESS does not need them for a community account.
- **The Tapis record as the system of record.** It has no allocation and no stable owner, and a partner can write both owner and tags.
- **Fractional SU in floating point.** A ledger that cannot be summed exactly cannot be reconciled with Expanse's.
