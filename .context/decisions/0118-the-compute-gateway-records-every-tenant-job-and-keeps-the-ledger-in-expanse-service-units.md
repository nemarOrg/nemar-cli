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
   The rule: a detail is the platform's if and only if a submitter cannot cause it with a valid specification and bundle, and a dataset that was eligible when the job was submitted.
   The Worker refuses at submit, with its own refusal `dataset_not_eligible`, any dataset that is not public and published, any version that is not published, and any manifest over 38,000 entries; so `dataset_not_found` and the manifest-too-large case cannot be a submitter's doing and stay declared as the platform's.
   `isPlatformFailure(code, detail)` follows it: a platform detail is refunded even under `runtime_error`, a submitter detail is charged even under `code_fetch_failed` or `dataset_fetch_failed`, and a missing or undeclared detail leaves the code alone to decide, as before.
   The result refusal details stay as they were.
   The Worker's own cancel record overrules the launcher's `terminated` detail, because the launcher cannot tell a cancel by the person from a Slurm preemption.
   The default for an undeclared `runtime_error` detail is deliberate: it is charged, which is the unfavourable direction for a fault NEMAR caused.
   So a launcher change that adds a detail word lands with its entry here, in both repositories, in the same pair of pull requests, and the launcher's drift test compares its `LAUNCHER_DETAILS` with this list for each code at a pinned commit.
14. **The launch specification carries the data-plane tag and a digest-named Singularity image file (SIF).**
   `datasets[].version` is the data-plane tag, `latest` or `v<major>.<minor>.<patch>`, which the Worker makes from a job's version with `dataTagForVersion` (`1.0.2` becomes `v1.0.2`) at most 64 characters, the limit of the provenance `staging[].version` the launcher writes; the job specification keeps accepting what it accepted, so the dataset version tag is the one launch rule `JobSpecSchema` does not enforce, and the Worker and the CLI run `launchSpecFits` before the hold and refuse a job whose version has none with `invalid_spec`, naming the field `datasetVersionWithoutTag` finds.
   `image.sif` is exactly `<the 64 hex digits of image.digest>.sif`, a basename relative to `NEMAR_SIF_ROOT`, which is required: the launcher has no fallback and ends `image_missing` when it is unset.
   `image.uri` ends with `@sha256:<the hex of image.digest>`, because the digest names the file that runs.
   The JSON Schema cannot compare two fields, so these two rules are zod's and the encoder refuses a document that breaks either; the schema says so, and the differential tests list every rule only zod enforces.
   The launcher does not verify the SIF's content hash: the name is all that ties the file to the digest.
15. **The include glob dialect and the entry semantics are part of the contract.**
   An include pattern is matched against manifest paths relative to the dataset root: `**/` matches zero or more directories (so `a/**/b` matches `a/b`); `**` elsewhere matches any run of characters including `/`; `*` and `?` stay inside one path segment; `[abc]`, `[a-c]` and `[!abc]` are classes; a character class never matches `/`, so like `*` and `?` it stays inside one path segment, and a negated class `[!a]` matches any single character except `a` and `/`; an unterminated `[` is a literal `[`; an empty class `[]` and an inverted range such as `[z-a]` are refused, and `bad_include` is exactly the set of patterns this dialect refuses; matching is case-sensitive; there are no escapes; and a matcher must run in time linear in the pattern length times the path length, with no backtracking and no cap on wildcards.
   `includePatternProblem` is that refusal as a pure function, and `JobSpecSchema` applies it, so such a pattern is refused at submit with `invalid_spec`, naming `datasets.<i>.include.<j>`, and is never charged.
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

## Amendment 2026-11-04 (#2007): the allocation ledger and the owner policy are built (phase A2)

Migration `0114_compute_ledger.sql`, `backend/src/services/compute-ledger.ts`, `compute-policy.ts`, `backend/src/routes/admin/compute.ts` and `nemar admin compute policy|pool` build decision 3 and the policy of decision 7.
What the build settled, each a rule and not a description of today:

1. **The ledger is the only writer of a pool's totals, and the writer is a trigger.**
   `compute_ledger_apply` (AFTER INSERT) adds an entry's granted, held and charged deltas to its pool's row, and its held and charged deltas to the row of its budget pool.
   "Totals change only if the entry was written" holds by construction, because there is no second statement to forget, and an entry the totals refuse (a stored total may never be negative) is not written either: the entry and the totals are one statement.
   No code path updates a total, and a test reads every source file and every migration for one.
   D1 runs the trigger; if it ever stopped, the design stops with it, and the fallback is not application-side updates.
2. **A hold is one conditional INSERT.**
   Its WHERE checks the pool not frozen, the pool's available, the budget pool's available, the key unused and any guard the caller adds, so two holds for the last SU cannot both be written and a refused hold writes nothing.
   A hold is closed once, by a release or a charge, in one INSERT taken from the hold row itself (the amounts are the hold's); a settlement's charge and its overrun are one statement.
   A job has one hold.
3. **Available may be negative; a stored total may not.**
   An `overrun`, or an adjustment of the grant below what is used, makes available negative and refuses new holds until a grant brings it back; the pool CHECKs refuse a negative total.
   Every amount is a whole number of milli-SU up to 2^53 - 1, checked before a statement is built and again by `typeof` and range CHECKs.
4. **A budget is a platform pool of the same word.**
   A person's or a partner's hold is also counted against the platform `people` pool of the same cpu or gpu word (NEMAR's own pipelines are their own pool, `pipelines`), and a trigger refuses any other budget.
   A correction of a person's charge moves the budget with it.
5. **A key is never shared.**
   An administrator's `Idempotency-Key` is stored behind `grant:` or `adjust:`, and the keys the Worker writes for a job are made of the job or the hold (`hold:<id>:charge`, `job:<id>:final`), so none can collide with another and each step happens once.
   A key reused for a different request is a conflict, never a replay.
6. **The policy write is owner-only in the statement, validated strictly, and audited in the same batch; the read fails closed.**
   `putPolicy` inserts a version only for an account that is an owner in that statement, checks the strict schema, and writes the audit row with it.
   `getPolicy` parses a stored row with the same strict schema and answers 503 for one it cannot parse; the default applies only when there is no row.
   A new policy key is therefore added as optional.
   The CLI reads the route's answer with an open schema (`shared/contract/compute-admin.ts`) and checks only what `policy set` sends with the strict one.
