# ADR 0118: The compute gateway records every tenant job and keeps the ledger in Expanse service units

**Status:** accepted
**Date:** 2026-11-03
**Owner:** Seyed Yahya Shirazi

Epic #2005, issue #2006.
This Architecture Decision Record (ADR) refines stage 3 of [ADR 0049](0049-compute-runs-in-the-browser-osa-owns-the-runtime-only-hpc-is-gated.md) and keeps [ADR 0040](0040-approval-is-the-single-writer-of-upload-access.md) and [ADR 0042](0042-upload-access-is-requested-once-by-the-person-who-wants-it.md) intact: compute access is its own grant, never `service_access`, and approval is a person's decision.

## Context

ADR 0049 left stage 3, high-performance computing (HPC) submission, as "a NEMAR gateway" without saying who runs a job, who holds its record or how time is counted.
NEMAR now runs jobs on the San Diego Supercomputer Center's (SDSC) Expanse through a Tapis tenant, from three front doors (the command-line interface (CLI), the website, a partner site) and for its own pipelines.
Tapis has no allocations and no idempotency key, signs no webhook, lets a job's owner edit its tags, and a partner site can mint a Tapis token for any username, so the Tapis record alone cannot say who ran what or what it cost.

## Decision

1. **A community account runs every job**, so people need no account of their own in the National Science Foundation's Advanced Cyberinfrastructure Coordination Ecosystem: Services & Support (ACCESS) program, or on Expanse.
2. **NEMAR is the record of every tenant job, whichever front door submitted it**: who ran it, exactly what was submitted, what it cost, what happened and the logs.
3. **The ledger is append-only integer thousandths of an Expanse service unit (SU)**, never floating point.
   One SU is one core-hour with up to 2 GB per core, or one graphics processing unit (GPU) hour.
   A hold precedes every submit, as one conditional insert that checks the person's pool and the platform budget; a refused hold writes nothing.
4. **A charge settles twice.**
   Provisionally from the Tapis record when the job ends, then finally from Expanse's own accounting, as an adjustment; a difference within the owner's policy tolerance is routine and a larger one is reported.
   A failure NEMAR caused is refunded; a user-caused one, including a result upload refused for size or quota, is not.
   For a launcher failure, who caused it is decided by its code and its fixed-word detail together (decision 13).
5. **An unreserved partner job is cancelled and charged to the partner's pool, never to a person**, because a Tapis `owner` is not proof of who ran a job.
6. **Webhooks are hints.**
   NEMAR reads the job back from Tapis before it acts, polls as a backstop, and tags every job `nemar_job:<id>` so a retried submit finds the job instead of submitting twice.
7. **Retention is a policy row, not a constant**: records 7 years, logs 1 year, results 30 days and never fewer than 14.
   Storage is two private Cloudflare R2 buckets, records (locked by prefix) and results (expiring), outside the Amazon Web Services (AWS) account that holds the Open Data buckets.
   Only the Worker reaches them, through bindings, and no storage credential reaches Tapis, a node or the launcher: uploads go to addresses the Worker signs for one file of one job.
8. **`COMPUTE_ENABLED` is a dark switch**: exactly `1` and absent from the wrangler configuration. The switch and the test that pins it arrive in phase A4 (issue #2009); every compute cron runs in production only.
9. **NEMAR reports ACCESS gateway attributes for every tenant job**, once, under a per-account pseudonym that is not the sign-in subject.
10. **Every compute word is declared once**, in `shared/compute-state.ts` (states, failure, refusal, ledger and cancel words), `shared/contract/compute.ts` (the job specification, partition and rate tables, owner policy and launcher file shapes) and `shared/contract/compute-launch.ts` (the launch specification and the launcher's routes, with their JSON Schema, which `nemarOrg/nemar-process` copies byte for byte).
11. **Two digests, named apart.** `spec_digest` is the job row's: the SHA-256 of the exact bytes of `records/<id>/spec.json`. `launch_spec_digest` is the launcher's: the SHA-256 of the exact raw bytes of the `NEMAR_LAUNCH_SPEC` value, which is ASCII-only JSON, hashed before parsing.
12. **Responses are open, requests and documents are closed.** The two responses a launcher reads ignore unknown keys, so one that runs for 48 hours survives the Worker adding a key; the job specification, owner policy, launch specification and the launcher's own files refuse them.
13. **Launcher details are declared and classified, in `shared/compute-state.ts`.**
   `LAUNCHER_DETAILS` maps each of the seven launcher codes to the fixed-word details it may carry, and `PLATFORM_LAUNCHER_DETAILS` is the subset that is a NEMAR, node, runtime or contract fault.
   The rule: a detail is the platform's if and only if a submitter cannot cause it with a valid specification and bundle.
   `isPlatformFailure(code, detail)` follows it: a platform detail is refunded even under `runtime_error`, a submitter detail is charged even under `code_fetch_failed` or `dataset_fetch_failed`, and a missing or undeclared detail leaves the code alone to decide, as before.
   The result refusal details stay as they were.
14. **The launch specification carries the data-plane tag and a digest-named Singularity image file (SIF).**
   `datasets[].version` is the data-plane tag, `latest` or `v<major>.<minor>.<patch>`, which the Worker makes from a job's version with `dataTagForVersion` (`1.0.2` becomes `v1.0.2`; a version with no tag is refused); the job specification keeps accepting what it accepted.
   `image.sif` is exactly `<the 64 hex digits of image.digest>.sif`, a basename relative to `NEMAR_SIF_ROOT`, which is required: the launcher has no fallback and ends `image_missing` when it is unset.
   The JSON Schema cannot compare two fields, so that rule is zod's and the encoder refuses a document that breaks it; the schema says so, and the differential tests list every rule only zod enforces.
   The launcher does not verify the SIF's content hash: the name is all that ties the file to the digest.
15. **The include glob dialect and the entry semantics are part of the contract.**
   An include pattern is matched against manifest paths relative to the dataset root: `**` crosses `/`; `*` and `?` stay inside one path segment; `[abc]`, `[a-c]` and `[!abc]` are classes; matching is case-sensitive; there are no escapes; and a matcher must run in time linear in the pattern length times the path length, with no backtracking and no cap on wildcards.
   A python job with an entry runs `python /code/<entry>` followed by `args`; a command runs as given with `args` appended; an image job with an entry runs `/code/<entry>` directly, which needs the executable bit the bundle packer must preserve; the runtime image must provide `python` on its PATH for the python runtime.
   A bundle archive's member names may carry a leading `./`; absolute names, `..`, links, devices and named pipes (first in, first out, or FIFOs) are refused by the launcher.

## Consequences

- Later phases import these modules instead of declaring their own words, numbers or states, and a test fails when one is added or dropped.
- NEMAR carries a ledger, a record store and retention duties it did not have; the periods are owner policy, so counsel's answer changes a row, not a deploy.
- The rate table (2 GB per core, 92 GB per GPU, preempt at 0.8 with the 1 SU minimum applied after that factor) and the `debug` ceilings are unconfirmed with SDSC and stay marked so until the first charge is compared with Expanse.
- Access, approval and the partner contract are not decided here; they follow ADR 0040 and ADR 0042 in Epics B and D.

## Alternatives considered

- **Per-person Expanse accounts.** Cannot be asked of this audience, and ACCESS does not need them for a community account.
- **The Tapis record as the system of record.** It has no allocation and no stable owner, and a partner can write both owner and tags.
- **Fractional SU in floating point.** A ledger that cannot be summed exactly cannot be reconciled with Expanse's.
