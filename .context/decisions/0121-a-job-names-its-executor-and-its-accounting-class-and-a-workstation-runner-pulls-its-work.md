# ADR 0121: A job names its executor and its accounting class, and a workstation runner pulls its work

**Status:** proposed
**Date:** 2026-11-13
**Owner:** Seyed Yahya Shirazi

This Architecture Decision Record (ADR) refines [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) for executors that are not Tapis, and refines stage 3 of [ADR 0049](0049-compute-runs-in-the-browser-osa-owns-the-runtime-only-hpc-is-gated.md) a second time.
It supersedes nothing.
[ADR 0122](0122-one-oci-image-runs-under-apptainer-or-docker-from-one-digest.md) decides the container.

## Context

ADR 0118 assumes every job runs on Expanse through Tapis, so a job, its ledger entry and its hold are one fact.
NEMAR now wants the same containerized job to run first on a lab workstation, which has no allocation to meter, and later on other clusters.
A workstation sits behind a firewall and must not hold a credential that can reach NEMAR's storage.
Two things must stay true: money is counted only where an allocation exists, and every job, wherever it ran, has the one record ADR 0118 promises.

## Decision

1. **A job names its executor and its accounting class.**
   `compute_jobs.executor` is `tapis` (the default) or `runner`; a runner job also records `runner_backend`, `local` (a workstation) or `slurm` (a cluster scheduler, decided later).
   `compute_jobs.accounting` is `su` (the default) or `none`, and a Tapis job is always `su`: a table CHECK says so.
   Two selector rules, one per concern.
   Executor mechanics select `executor = 'tapis'`: the advance tick, the submit claim, the cancel sweep, the tenant sweep, the admin advance, and every Tapis admission path, including the pipeline admitter of #2121 phase P3 when it lands.
   Money and tenancy select `accounting = 'su'`: the ledger, `tenantGuard`, the pipelines' live cap, the observer's settlement and the ACCESS report.
   Accounting follows the resource, so a runner on an allocated cluster later is `su` without a rewrite.
2. **There is no new state.**
   A waiting runner job is `created` with `runner_claimed_at` NULL; a claim sets `runner_claimed_at`, `runner_id` and a lease and leaves the state `created`.
   The edges used are the existing ones: the runner's `started` heartbeat writes `created -> running`, its `uploading` heartbeat writes `running -> archiving`, and `finished` stands only after `verifyResults`.
   An unstarted lease that expires clears the claim, so no backward edge is needed; a started job whose runner goes silent becomes `unreported`.
   A runner job that gives up ends `failed` with the code `runner_lost` and one of four details: `lease_expired`, `claims_exhausted`, `deadline_exceeded` or `runner_revoked`.
   `submitted` and `queued` are never used by `runner/local`; whether `runner/slurm` uses `queued` is decided when that backend is built.
   The column is deliberately not #2121 phase P3's `admitted_at`, so either migration can land first.
3. **Workstations pull; NEMAR never pushes.**
   `nemar-runner` runs as an unprivileged user, opens no inbound port, polls the Worker over HTTPS and sends `User-Agent: nemar-runner/<version>`.
4. **The protocol is `nemar.runner.v1`: register, exchange, claim, heartbeat, complete.**
   A claim returns a list of up to `free_slots` jobs, each admitted by its own conditional UPDATE with its own 10-minute lease, and the dataset's public eligibility is checked again inside that statement.
   A heartbeat every 60 seconds renews the lease and carries a cancel back.
   A started job's lease is never replaced; an unstarted expired lease releases the claim, at most 3 times, then `runner_lost` `claims_exhausted`.
   The runner stops a job at the job's end time plus a grace, and the Worker fails a started job 15 minutes past its minutes with `runner_lost` `deadline_exceeded` unless its outputs completed.
   The bundle, outputs and outputs-complete calls of a runner job are accepted only under the current lease, and a retried complete answers the same state.
   Execution is at least once and acceptance is at most once; exactly once is not achievable across a partition.
   Exact numbers, words and shapes are declared once in `shared/contract/compute-runner.ts`.
5. **Registration is owner-only, and a revoke ends the runner's work.**
   A registration mints a secret `nmr_` plus 64 hex, shown once and stored as a hash; the secret buys a 15-minute access token `nmra_` plus 64 hex.
   Every other route refuses both prefixes before any lookup (`runner_credential_not_accepted`), as ADR 0119 does for `nmo_`.
   Revoking a registration, in one batch, revokes it, deletes its tokens, releases its unstarted claims and moves its started jobs to `unreported` with the lease cleared, so neither the job token nor the lease can land outputs.
   `runnerEndStatements(userId)` does the same for every registration an owner made, and three callers run it in their own batch: `finalizeRevocation`, `tombstoneUserCascade` and an owner's role demotion.
   A key revocation is deliberately not a caller: a registration is a standing grant of the owner's account that outlives any one key, so rotating a key must not stop a lab's queue, and ending the registration is its own explicit act.
6. **An `accounting = 'none'` job writes no ledger entry, and its usage is measured and labeled.**
   It makes no hold, charge or adjustment, and its terminal batch stamps both settled timestamps with `charged_milli = 0`, so the records copy and the reports treat it as settled.
   Usage is `runner_wall_seconds`, `runner_cpu_seconds` and `runner_max_rss_mb`, shown as "runner-reported core-hours" and never as service units (SU).
   Capacity is a runner guard inside the job's own INSERT: live `accounting = 'none'` runner jobs of the pool must be fewer than `policy.runners.maxLiveJobs[pool]`, default 64 for `cpu` and 8 for `gpu`.
   A runner job's sizing uses an existing partition name as a label only, `shared`, whose ceilings apply, and `estimateSuMilli` is never called for it.
   An `accounting = 'su'` runner job is refused (`runner_accounting_unbuilt`) until the phase that builds its hold, settlement and ACCESS report.
7. **`COMPUTE_RUNNERS_ENABLED` is a third dark switch.**
   It is needed together with `computeEnabled(env)`, stays out of `backend/wrangler-sccn.toml`, is pinned by a flag test and is named in the dark-switch rule of `AGENTS.md`.
8. **A derivative has its own home.**
   Derived outputs are never written into the raw-only serving copy ([ADR 0027](0027-zarr-dispatch-is-raw-only-derivatives-sourcedata-code-excluded.md)) and never committed into the dataset repository, where they would cost a version bump, an irrevocable DOI and a stamp loop.
   Until a derivative store is decided, a demo keeps outputs in a local stack or an operator's scratch and says so.
9. **A result is reproducible from an image digest, a launch specification and an input snapshot, with no runner and no Tapis.**
   Each runner job records its registration's facts (site, trust, capacity) as host facts, so a reader can tell where it ran.

## Consequences

- A workstation runner needs no storage credential and no inbound route, so the attack surface of a lab machine is one outbound HTTPS client.
- Reports must group by executor and accounting class; a runner-reported core-hour is never added to an SU total.
- An `accounting = 'none'` job escapes the ledger's guards by design, so the runner guard, the dark switch, public-data-only eligibility and the owner-only registration are the whole of its budget control.
- Two admission paths (P3's `admitted_at` and `runner_claimed_at`) coexist until a later change converges them.
- This changes ADR 0118 decision 3 and the A3 amendment's item 1 (the job INSERT gated on the hold) for `accounting = 'none'` jobs only, and nothing for `su` jobs, which is why ADR 0118 carries a dated pointer rather than a rewrite.

## Alternatives considered

- **Key money on the executor:** a runner on an allocation would escape the ledger.
- **A table per executor:** forks the records and the reports.
- **A `claimed` state:** widens every CHECK for what a column already says.
- **NEMAR ssh-ing jobs to hosts:** a push surface and stored host credentials.
- **A message broker or a WebSocket push:** a new service for what polling does.
- **A zero-SU hold:** a shape that lies about a budget; a second ledger in core-hours was rejected for the same reason.
- **Exactly-once execution:** impossible across a partition.

## Receipts

- [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md), [ADR 0119](0119-nemar-is-an-openid-connect-provider-and-orcid-stays-the-upstream-identity.md), [ADR 0049](0049-compute-runs-in-the-browser-osa-owns-the-runtime-only-hpc-is-gated.md), [ADR 0027](0027-zarr-dispatch-is-raw-only-derivatives-sourcedata-code-excluded.md).
- The runner contract: `shared/contract/compute-runner.ts` and `shared/compute-state.ts`, declared once (#2146).
