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
10. **Every compute word is declared once**, in `shared/compute-state.ts` (states, failure, refusal, ledger and cancel words), `shared/contract/compute.ts` (the job specification, partition and rate tables, owner policy and launcher file shapes) `shared/contract/compute-launch.ts` (the launch specification and the launcher's routes, with their JSON Schema, which `nemarOrg/nemar-process` copies byte for byte) and `shared/contract/compute-admin.ts` (the allocation routes' error words, request shapes and open response schemas; a module of words and of open schemas only, never of a strict one).
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
   "Totals change only if the entry was written" holds by construction, because there is no second statement to forget.
   No code path updates a total, and a test reads every source file and every migration for one (quoted, schema-qualified, bracketed and conflict-clause spellings of a write included, each proven by a planted string).
   D1 runs the trigger; if it ever stopped, the design stops with it, and the fallback is not application-side updates.
2. **The table refuses what the statement refuses, under every conflict clause.**
   A conflict clause on the OUTER statement (`INSERT OR IGNORE`, `OR FAIL`, `OR REPLACE`) overrides the clause that applies inside a trigger, so an entry whose totals the pool's CHECKs refused would stay in the ledger while the totals did not move.
   Three BEFORE INSERT triggers raise ABORT, which no conflict clause overrides (the two budget triggers of item 5 are the other two of the five that the build added): no total of the pool, or of the budget it names, leaves 0 to 2^53 - 1 (`compute_ledger_totals_in_range`); a hold does not take the pool's or the budget's available below 0 (`compute_ledger_hold_fits`); a release or a charge names a hold of the same job, pool, budget and held amount (`compute_ledger_closes_its_hold`).
   The service's statements say the same as WHERE terms, so a refusal there writes nothing and raises nothing.
3. **A hold is one conditional INSERT.**
   Its WHERE checks the pool not frozen, the pool's available, the budget pool's available, the key unused and any guard the caller adds, so two holds for the last SU cannot both be written and a refused hold writes nothing.
   Freezing applies to the holder's own pool; a frozen budget pool does not refuse a hold.
   A closing entry is one INSERT taken from the hold row: the HELD side of a charge and the whole of a release are the hold's own amount, so a caller cannot misstate them; the CHARGED figure of a settlement is the caller's, capped at the hold, and what the job used above the hold is an `overrun` entry written by the same statement.
   A job has one hold, and a hold is closed once.
4. **Available may be negative; a stored total may not.**
   An `overrun`, or an adjustment of the grant below what is used, makes available negative and refuses new holds until a grant brings it back.
   Every amount is a whole number of milli-SU up to 2^53 - 1, checked before a statement is built and again by `typeof` and range CHECKs; a grant or a positive adjustment that would take a total past it is `would_exceed_limit`, and one request moves at most 2^40 milli-SU.
5. **The table enforces the budget rule where both of the owner's options agree, and leaves the rest to code.**
   Two BEFORE INSERT triggers, and only these.
   `compute_ledger_budget_is_people`: a budget an entry names is the platform `people` pool of the same cpu or gpu word as its pool, and an entry on a platform pool names none; this holds for every kind, a refund and a correction of a charge included, whenever one is named.
   `compute_ledger_budget_required`: a hold, a release, a charge, an overrun and a job's final-settlement adjustment on an account or partner pool MUST name that budget, because the budget records what people consumed and each of these moves it under either option below.
   NEMAR's own pipelines are their own pool, `pipelines`, and count against nothing else.
   A refund, and an adjustment of a charge that names no job, may name the `people` budget or none, and the table does not choose: whether they credit the budget back is the repository owner's open decision, and a code choice, not a schema rule.
   Option A: the `people` budget records consumption only (holds, settlements and overruns), and a refund or a correction moves the person's pool alone.
   Option B: a refund and a correction also credit the budget back, so the budget and the people never disagree.
   Today's code is option B, with an interim rule that is easy to loosen (correcting an account's charge is the owner's; an administrator corrects a grant): an adjustment of the charge of an account's pool moves the `people` budget with it, and a refund of a job takes its whole charge back from the budget as well.
   If the owner chooses option A, the code changes (the refund and the adjustment name no budget) and the migration does not.
6. **A key is never shared, and is compared on everything.**
   The keys the Worker writes are made of the job (`job:<id>:hold`, `:final`, `:refund`) or the hold (`hold:<id>:charge`), so no caller picks one, and a caller's key may not start with `job:` or `hold:`; an administrator's `Idempotency-Key` is stored behind the kind and the actor (`grant:<actor>:<key>`), so two administrators sending the same key each make their own entry.
   A key that finds its entry is a replay only if the request is the same on every field (kind, pool, budget, amounts, job and reason); anything else is a conflict, never a replay.
   A closing step replayed returns its closing entry with `replayed: true` when it is of the requested kind, and `hold_closed` says which kind closed the hold otherwise.
   A hold replayed returns its entry with `replayed: true` only while the hold is open; the same hold asked for again after it was released or settled is `hold_closed` too (with the step that closed it), because a replay would tell the caller a hold is live that its pool no longer holds.
7. **A job's final settlement happens once, even when it changes nothing, and never after a refund.**
   It is an `adjust` entry that carries the job and a charged delta that may be 0 (the only adjustment that may be), whose key `job:<id>:final` records that it happened; a job's charge is the sum of `charged_delta_milli` by `job_id` over its charge, overrun, refund and that adjustment.
   A refund ends a job's charge: a final settlement after one is refused (`refunded`), because it would charge the job again.
8. **The policy write is owner-only in the statement, validated strictly, and audited in the same batch; the read fails closed.**
   `putPolicy` inserts a version only for an account that is an owner, not deleted and in an active status, in that statement, checks the strict schema, and writes the audit row with it.
   `getPolicy` parses a stored row with the same strict schema and answers 503 for one it cannot parse; the default applies only when there is no row.
   A new policy key is therefore added as optional.
   The CLI reads the route's answer with an open schema (`shared/contract/compute-admin.ts`) and checks only what `policy set` sends with the strict one.
9. **What the database cannot prevent, and what guards it instead.**
   `INSERT OR REPLACE` and `REPLACE INTO` rewrite a conflicting row without firing the append-only DELETE trigger, because recursive triggers cannot be enabled on D1, so only the source scan guards against them.
   `DROP TABLE` removes the append-only triggers with the table, and a rebuild of `compute_ledger` must copy its rows before it creates `compute_ledger_apply`, or every total doubles.
**Retention is not decided here.**
The ledger and the policy are append-only and are never removed by a cascade from the account row.
Their retention, and the anonymisation of `holder_ref` and `actor_user_id`, are the job of phase A7 (#2012), which adds its own narrowly scoped exception in its own migration.

## Amendment 2026-11-04 (#2008): the job index and the two buckets are built (phase A3)

Migration `0115_compute_jobs.sql`, `backend/src/services/compute-jobs.ts`, `compute-records.ts` and `compute-s3.ts` build decisions 2, 7 and 9.
What the build settled, each a rule and not a description of today:

1. **A job and its hold are one batch, and the job is gated on the hold.**
   The batch is the ledger's hold statement (the person's live-job limit is a guard read inside that statement, so two requests racing for the last slot cannot both win), then the pseudonym's `INSERT OR IGNORE`, then the job's INSERT, each of the last two written only if the hold row of this job exists.
   A refused hold therefore leaves no job row, no ledger entry, no pseudonym and no object in either bucket, and the reason is read after the refusal and never decided by a second hold.
   A job id has one hold for ever, so a resubmission is a new job; a retried `(account, idempotency key)` returns the existing job, and the same key for another request is an error and never an answer with the first job.
2. **Records are written after the commit, never before, and once.**
   A bucket lock makes a record for a refused job permanent, so nothing is copied into `records/` before the job's row, and with it the hold, has been read back; a bundle waits in `incoming/`, which a lifecycle rule empties.
   Every record write is create-only, and a record that exists is never rewritten.
   `records_written_at` says the job's records have landed, and phase A5 refuses to submit without it: `createJob` sets it for a job that uploads nothing, and `finalizeBundle` or `finalizeSubmittedFiles` (a partner batch job's own files) sets it after the copy.
   A failed write leaves the job and its hold, is logged by job id and a fixed word, and is finished by a replay of the same key.
3. **D1 job rows carry the account id and fixed words only; identity is in the records bucket only.**
   There is no column for a name, an email, a country, an ORCID iD, an affiliation or a subject, and a test refuses one.
   `identity.json` holds exactly the ORCID iD, name, email, country, affiliation, account id, a null subject and the capture time.
   The words that a later epic may add (a failure code, a detail, a cancel reason, a partition) are checked by shape, never by a list, so adding one never rebuilds the table.
4. **The gateway pseudonym is random and stored.**
   `gw_` and 20 lowercase base32 characters, made on an account's first job, stored in `compute_gateway_users`, copied to every job of that account, never rotated and never reused (triggers refuse a change and a removal until a later phase's narrowly scoped exception).
   It is not derived from a key, because a derived value would change if the key were rotated; the issue's earlier wording, a derivation from `ENCRYPTION_KEY`, is superseded.
   NEMAR's own pipeline jobs carry the literal `nemar-pipelines`, which is not stored there.
5. **`spec_digest` is the SHA-256 of the exact bytes of `records/<id>/spec.json`,** made once before the INSERT and written after the commit, and it is never the launch specification, which carries a token; the launcher's `launch_spec_digest` is a different column, added by phase A5.
6. **Reading identity or a submitted file is owner-only, reasoned and audited first.**
   The role is read from the database in the audit statement itself, the reason is 8 to 200 characters, the `compute.record.read` row is written before any byte is read, and the read is refused when that write fails.
   A read that then finds nothing still leaves its row, because the attempt is what is audited.
7. **Compute storage is reached by the binding, and by the S3 interface only for what a binding cannot do.**
   A binding has no copy and no presigned address, so a presigned PUT (one hour), a presigned GET (10 minutes for the launcher's own bundle, 5 minutes for an owner's read) and the server-side `CopyObject` are signed with aws4fetch against the account endpoint, path style.
   The endpoint is `globalThis.NEMAR_COMPUTE_S3_URL` when set and otherwise the Worker secret; `S3_ENDPOINT_URL` is never read for compute; an expiry above seven days is refused.
   A key is encoded segment by segment and judged by the contract's own path predicate, never by `assertValidS3Key`, which refuses `a..b.csv` and throws on `100%.txt` and so would fail an upload with a code that refunds the job.
8. **The checksum header is signed for an incoming PUT and is not trusted.**
   `x-amz-checksum-sha256` is signed with the URL when a digest is given; whether R2 enforces it on a presigned PUT has not been checked against the real service, so the size read back through the binding is the bound `finalizeBundle` relies on.
   On an output PUT the header is deferred to epic A, to be decided once it has been verified on R2.
9. **The outputs request's body cap is derived from the owner's `maxFiles`.**
   The policy lets `maxFiles` reach 100,000 and the launcher caps its own request at 1 MiB, so the Worker neither bounds `maxFiles` nor reads less than 1 MiB: it reads at most `8 KiB + maxFiles x 1,700 bytes`, never above 64 MiB.
   The launcher's 1 MiB is the tighter bound today, and raising it is the launcher's change.
10. **A partner's per-file upload is at most 500 files,** whatever the owner's bundle limit, because each file is one `CopyObject` and a Worker invocation may make at most 1,000 subrequests; the sizes of the uploaded files are read from one listing before any file is copied, so a file of the wrong size refuses the whole set and copies nothing.
