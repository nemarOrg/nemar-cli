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
   **[Superseded for the refund by the A5 amendment of 2026-11-04 (#2010), item 1: no failure is refunded automatically, whoever caused it. The attribution stays as a flag. The rest of this decision stands.]**
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
   `isPlatformFailure(code, detail)` follows it: a platform detail is refunded even under `runtime_error` **["refunded" superseded by the A5 amendment of 2026-11-04 (#2010), item 1: it is attributed to the platform, flagged, and not refunded]**, a submitter detail is charged even under `code_fetch_failed` or `dataset_fetch_failed`, and a missing or undeclared detail leaves the code alone to decide, as before.
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
   A refund, and an adjustment of a charge that names no job, may name the `people` budget or none, and the table does not choose: whether they credit the budget back is the repository owner's open decision, and a code choice, not a schema rule. **[Decided on 2026-11-04: the owner chose option A, see the end of this item.]**
   Option A: the `people` budget records consumption only (holds, settlements and overruns), and a refund or a correction moves the person's pool alone.
   Option B: a refund and a correction also credit the budget back, so the budget and the people never disagree.
   Today's code is option B, with an interim rule that is easy to loosen (correcting an account's charge is the owner's; an administrator corrects a grant): an adjustment of the charge of an account's pool moves the `people` budget with it, and a refund of a job takes its whole charge back from the budget as well. **[Superseded by the owner decision of 2026-11-04: the code is option A now, see the end of this item.]**
   If the owner chooses option A, the code changes (the refund and the adjustment name no budget) and the migration does not.
   **The owner decision of 2026-11-04 is option A, and the code implements it: the `people` budget records consumption only, so `refundJob` and its statement are deleted (nothing is refunded automatically), a correction that lowers the charge of an account's or a partner's pool names no budget (`adjustPool` refuses one that does) while one that raises it names the budget, and a job's final settlement is the one entry that names the budget and lowers it, because it corrects a figure that was recorded as consumption.**
6. **A key is never shared, and is compared on everything.**
   The keys the Worker writes are made of the job (`job:<id>:hold`, `:final`, `:refund` **[`:refund` retired by the owner decision of 2026-11-04: no refund is written]**) or the hold (`hold:<id>:charge`), so no caller picks one, and a caller's key may not start with `job:` or `hold:`; an administrator's `Idempotency-Key` is stored behind the kind and the actor (`grant:<actor>:<key>`), so two administrators sending the same key each make their own entry.
   A key that finds its entry is a replay only if the request is the same on every field (kind, pool, budget, amounts, job and reason); anything else is a conflict, never a replay.
   A closing step replayed returns its closing entry with `replayed: true` when it is of the requested kind, and `hold_closed` says which kind closed the hold otherwise.
   A hold replayed returns its entry with `replayed: true` only while the hold is open; the same hold asked for again after it was released or settled is `hold_closed` too (with the step that closed it), because a replay would tell the caller a hold is live that its pool no longer holds.
7. **A job's final settlement happens once, even when it changes nothing, and never after a refund.**
   It is an `adjust` entry that carries the job and a charged delta that may be 0 (the only adjustment that may be), whose key `job:<id>:final` records that it happened; a job's charge is the sum of `charged_delta_milli` by `job_id` over its charge, overrun, refund and that adjustment.
   A refund ends a job's charge: a final settlement after one is refused (`refunded`), because it would charge the job again. **[The owner decision of 2026-11-04 removed the refund path: no code writes a refund, and the refusal stays for an entry of that kind, which the table's vocabulary keeps.]**
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
   A bucket lock makes a record for a refused job permanent, so nothing is copied into `records/` before the job's row, which exists only if its hold does, has been read back; a bundle waits in `incoming/`, which a lifecycle rule empties.
   Every record write is create-only, and a record that exists is never rewritten.
   `records_written_at` says the job's records have landed, and phase A5 refuses to submit without it: `createJob` sets it for a job that uploads nothing, and `finalizeBundle` or `finalizeSubmittedFiles` (a partner batch job's own files) sets it after the copy.
   A failed write leaves the job and its hold, is logged by job id and a fixed word, and is finished by a replay of the same key.
3. **D1 job rows carry the account id and fixed words only; identity is in the records bucket only.**
   There is no column for a name, an email, a country, an ORCID iD, an affiliation or a subject, and a test refuses one.
   `identity.json` holds exactly the ORCID iD, name, email, country, affiliation, account id, a null subject and the capture time.
   The words that a later epic may add (a failure code, a detail, a cancel reason, a partition) are checked by shape, never by a list, so adding one never rebuilds the table.
4. **The gateway pseudonym is random and stored.**
   `gw_` and 20 lowercase base32 characters, made on an account's first job, stored in `compute_gateway_users`, copied to every job of that account, never rotated and never reused (triggers refuse a change and a removal until a later phase's narrowly scoped exception, and a third trigger ignores an insert whose account or pseudonym is already stored, because `INSERT OR REPLACE` deletes the conflicting row without firing the delete trigger, recursive triggers being off on D1).
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
10. **A partner's per-file upload is at most 500 files,** whatever the owner's bundle limit (the cap shadows `bundleLimits.maxFiles` with the same refusal word, so the partner contract and the design's section 6 must say 500), because each file is one `CopyObject` and a Worker invocation may make at most 1,000 subrequests; the sizes of the uploaded files are read from one listing before any file is copied, so a file of the wrong size refuses the whole set and copies nothing.
11. **A partner's job is its hold body, kept byte for byte.**
    A partner's request is not a job specification, so `createJob` takes its hold body as the exact text that was sent, reads only the nine small fields a hold needs (a strict schema; the partition tables and the owner's ceilings are the ones every job meets), and skips the specification schema, `launchSpecFits` and the bundle checks.
    `spec_digest` is the SHA-256 of those exact bytes, computed once before the INSERT, and the same text is written as `records/<id>/spec.json` after the commit, so the same fields with other whitespace are another request.
12. **An idempotency key needs an account.**
    The unique index treats NULL accounts as distinct, so a key on a job with no account could be stored and never found, and two calls would take two holds; `createJob` refuses it as a programming error.
    A partner's replay is keyed by the partner contract's own table (#2024, #2025).
13. **A name is judged by the path rule, and a key by the key rules, and both are asked before anything is signed.**
    A submitted file's path is at most 512 characters and holds no traversal in any percent-encoding, however many stray `%` stand beside it; a path that becomes a key of the job (a partner's own files, and an owner's read of one) is also well-formed text and builds an `incoming/` and a `records/` key of at most 1,024 bytes each.
    A manifest path inside an archive builds no key and keeps the 512-character rule.
14. **One copy is at most 5 GiB, whatever the owner's limits say.**
    The contract's bundle limits are not bounded above, and R2 copies (and one presigned PUT takes) at most 5 GiB, so a job, an upload address and a finalize refuse a larger archive or file as `bundle_too_large`.

## Amendment 2026-11-04 (#2010): the job lifecycle is built, and no failure is refunded (phase A5)

Migration `0116_compute_lifecycle.sql`, `backend/src/services/compute-lifecycle.ts`, `compute-verify.ts`, `compute-outputs.ts`, `compute-results.ts`, `compute-advance.ts`, `compute-tokens.ts`, the webhook route `routes/callbacks/tapis.ts`, the launcher's callbacks `routes/callbacks/compute-job-callbacks.ts`, `routes/compute.ts` and `nemar admin compute jobs` build decision 4 ("A charge settles twice") and decision 6 ("Webhooks are hints") of the Decision section above and the lifecycle of design sections 5 to 9.
Numbering: "decision N" in this amendment always means the numbered decision of the Decision section at the top of this record, cited with its name where it matters; "item N" means the numbered item of THIS amendment (the #2007 and #2008 amendments number their own items from 1 as well, and are cited as "the A2 amendment, item N" and "the A3 amendment, item N").
The repository owner's decisions of 2026-11-04 settle three questions, and the first supersedes wording above.

1. **No failure is refunded automatically, whoever caused it.**
   This supersedes the sentence of decision 4 of the Decision section ("A charge settles twice") that says a failure NEMAR caused is refunded, and the word "refunded" in its decision 13 ("Launcher details are declared and classified"); both carry an inline marker now.
   Consumed service units stay consumed.
   A job that never started on the scheduler is RELEASED in full, which is not a refund: nothing was consumed.
   A job that started is charged what the Tapis record says it used (`remoteStarted` to `remoteEnded`, the record's resources, at least one SU, never above the hold; what it used above the hold is an `overrun` entry and the job is flagged `overrun`).
   A job whose Tapis record has no start time is still charged when something shows it ran: Tapis reports FINISHED, or its launcher claimed result bytes or completed an upload; it is charged the minimum (one SU) and flagged `mismatch`.
   A start time that is present but is not a time charges the whole hold and flags `mismatch`, because a record that cannot be read must not give compute away.
   Only a job with no start time, no FINISHED and no launcher claim is released, because a release closes the hold and the ledger then refuses a charge, so a job released after it ran could never be charged.
   `isPlatformFailure(code, detail)` and the detail words of decision 13 of the Decision section stay, as an ATTRIBUTION and not a billing rule: the job row carries `platform_failure` (an information flag, written with the terminal transition) and the administrator's reports show it, so a NEMAR-caused failure can be compensated by a manual grant.
   Nothing in this phase calls `refundJob`, `settleFinal` or `adjustPool`, and no ledger write is driven by the flag. **[`refundJob` was deleted afterwards by the A2 follow-up (#2044), under item 2 below.]**
2. **The `people` budget records consumption only (option A of the A2 amendment, #2007).**
   Only a final settlement figure and the owner's own platform adjustments move it; nothing a person or an administrator does to a person's pool gives budget back.
   No path of this phase credits a budget.
   The A2 statements `refundJob` and `adjustPool` still credit it (the option B they were built with, because the choice is a code choice and the migration allows either); aligning them is a separate change, and neither is called by the lifecycle. **[Superseded by the A2 follow-up (#2044): that change is made, so the code is option A now. `refundJob` is deleted, `adjustPool` refuses a correction that lowers a charge and names the budget, and a job's final settlement is the one entry that names the budget and lowers it. The sentence above described the code as phase A5 found it.]**
3. **NEMAR owns every Tapis job.**
   The Tapis `owner` of every job, whichever front door submitted it, is the NEMAR service identity read from the Tapis configuration (`tapisConfig(env).username`, the identity the credential strategy uses), never a constant in code and never a person; a person exists only in NEMAR's job row and records.
   Nobody but NEMAR and the site's operators can read a Tapis job record, so a person who owns a Tapis job cannot read its token back; the `result.json` exit-number cross-check against the exit code Tapis reports stays as defence in depth.

What the build settled, each a rule and not a description of today:

4. **A submit is idempotent, and its outcome may be unknown.**
   Before any submit the job is searched by its tag (`nemar_job:<id>`): one hit is bound instead of a submit, two are a duplicate (nothing is submitted, the job is flagged `mismatch`), none goes on.
   `unavailable` and `invalid_response` after a submit, a cancel or a subscribe mean the effect may have happened, so the next attempt searches first; a submit is never repeated blind.
   The SHA-256 of the exact `NEMAR_LAUNCH_SPEC` bytes (decision 11 of the Decision section, "Two digests, named apart") is written to the row in a conditional UPDATE BEFORE the call; a retry that finds nothing overwrites it with the digest of the rebuilt text.
   The request names no archive system, asks Tapis not to archive the launch files, and carries the launch specification (and its per-job token) only in the environment variable.
   A 4xx rejection fails the job `tapis_submit_failed` and releases the hold; an unavailable Tapis leaves it `created`; a `created` row past the policy's reservation wait with nothing at Tapis fails `submit_timeout`.
   A job whose launch specification cannot be built (a recipe job that names no entry or command) is failed, not stranded.
   The runtime image of a `python` job is the Worker variable `COMPUTE_RUNTIME_IMAGE`: ONE digest-pinned reference and not JSON, owner-set, absent from the wrangler configuration, validated when it is read, with the digest and the Singularity file name derived from it by the contract's own functions; `GET /admin/compute/status` reports whether it is set, whether it is valid and its digest.
   Every submit sends the memory per node, minutes, nodes and cores: Tapis always passes a memory to the scheduler (its own default is 100 MB), so a job that named none would be limited to that however much it was charged for, and the memory sent is the memory the charge pays for (a whole node's from the rate table, since the partition table has no per-node memory field), clamped to the most the job's queue can schedule (`QUEUE_MAX_MEMORY_MB` in `compute-queues.ts`, declared once and mirrored from the program's Tapis execution system; a whole node's nominal memory is more than Slurm will hand out, and Tapis refuses a request over the queue's limit).
   A submitter takes a lease on the row before it searches or submits (`submit_claimed_at`, five minutes, `SUBMIT_LEASE_MINUTES`), and releases it only if the claim stamp is still its own, so two submitters cannot both reach Tapis and a stalled attempt cannot clear its successor's lease.
   A Tapis job that no row owns (the row ended, or is bound to another Tapis job) is recorded on the row as `orphan_tapis_uuid` before it is cancelled, flagged `mismatch`, and cancelled again by every tick until Tapis confirms; only one orphan is recorded per row.
   A cancel of a row that has no Tapis job yet and whose lease is live leaves its intent recorded for the sweep and ends nothing: a Tapis job may be in flight that no search can see, and ending the row would release a hold for a job that then runs.
   The submitter's bind turns a pending cancel into an orphan cancel, and once the lease ends the sweep's tag search is the authority.
   `limits.max_files` and `limits.max_total_bytes` of the launch specification bound the dataset selection and are named constants (`LAUNCH_DATASET_LIMITS`), never the results limit.
5. **A webhook is a hint, and one function transitions a job.**
   The webhook address carries an HMAC token (domain tag `compute-webhook`, over the job id and the job's `webhook_nonce`, no clock) and the launcher's `job_token` is the same construction under the tag `compute-job`, under the callback secret that signs every other callback; the nonce is cleared one day after the job is terminal, which is when the address stops working.
   The route ignores the body, answers one identical refusal for every failure, reads the job back from Tapis (one attempt, a short ceiling) and calls `applyTapisJob`, which the 30-minute tick, a cancel and an administrator's command call too.
   `applyTapisJob` writes `WHERE id = ? AND state = <from>` along the edges of `COMPUTE_TRANSITIONS`, so a repeated, reordered or concurrent writer changes nothing, and a subscription that cannot be deduplicated is harmless.
6. **A terminal transition and its settlement are one batch.**
   The state UPDATE, the ledger entry (a charge, or a release for a job that never started) gated on the job row having just taken the new state and not being settled, and the stamp of what was settled run in one D1 batch; a retry repairs a terminal row whose `settled_provisional_at` is still NULL.
7. **A Tapis `FINISHED` stands only after the upload is verified.**
   The launcher completed, its three documents parse and carry this job's id, its provenance's `launch_spec_digest` is the one NEMAR stored, its bundle and image digests are the job's, its result reports no failure and its exit number is the one Tapis reports, its manifest is what it declared, and every declared output is in the bucket with the exact size (a SHA-256 is compared only where R2 returns one for the object; where it returns none the output is checked by size alone, and nothing counts how many).
   Otherwise the job fails `result_verification_failed` (or `result_upload_failed` when the launcher never completed), with the reason as a fixed word in `failure_detail`.
   A failed job's code comes from the Worker's own recorded refusal first, then from `result.json` only when it is trusted (this job's id, a matching exit number, a provenance with the stored digest), else from the Tapis condition; a launcher that exits before writing `result.json` takes the Tapis condition.
   The Worker's own cancel record overrules the launcher's `terminated` detail.
   `tapisjob.out` is user output, copied as a log and never parsed.
8. **The launcher's callbacks carry one token and one refusal.**
   `bundle`, `outputs` and `outputs/complete` take the job token in `X-Compute-Job-Token`, never a URL; it stops working when the job is terminal, and every refusal of it is the same `job_not_found`.
   `bundle` signs only the job's own `bundle.tar.gz` from the verified job id.
   `outputs` checks before it signs anything (count, file size, job size, then one conditional UPDATE that claims the bytes against the person's share and the platform's total, both read inside the statement), records a refusal the submitter caused as `failure_detail` while still presigning the launcher's four files, writes `declared.json` through the binding, and is idempotent; an empty follow-up request after a refusal is accepted: the person's share is not applied to the launcher's own files, the platform's total still is, and each launcher file is capped on its own (a document at the outputs-body bound, the log at 16 MiB).
   Before the claim, every output path is also checked as an object key (at most 1,024 bytes of UTF-8, well-formed text), so a path no address can be signed for is `invalid_spec` naming the output and never a claim made for nothing.
   `complete` lists the declared objects (a listing, not a head each) and is idempotent; no address is issued after it.
9. **The records, the links and the mail.**
   After a terminal commit the launcher's files and the logs are copied into the locked records, never overwriting, and a copy that failed is retried by the tick for three days.
   Links are 7-day presigned GETs of a finished job's declared outputs, for the owner only, at most 1,000 at a time (an optional `after` cursor in the request body pages through the rest, and a cursor that is not an output path is `invalid_spec`), renewable while a head finds the objects and `results_expired` once it does not; the mail links to the job's page and never to a file.
   A log is copied up to 5 MiB and the copy records that it was cut; a log that could not be read for any reason but not existing leaves the whole copy owed, so it is never stamped done without it.
10. **Every compute cron is production only.**
    `runComputeAdvanceCron` (ten live rows a tick in rotation, the unreported mark after a day without a good read, the nonce clear, the repairs) and `sweepComputeCancellations` ride the 30-minute tick's production block, are absent from `DEV_CRON_ALLOWLIST`, refuse outside exact production on their own and read no switch; the switch is read only where a job is submitted.
    The rotation is by EXAMINATION and not by success: each row a tick takes is stamped `examined_at` before its step runs, so a row that cannot make progress goes to the back of the line and never holds a slot for good; the live rows Tapis has accepted and the `created` rows each have their own quota of ten, and so do the terminal rows owed a settlement and those owed a copy, so no kind of row can starve another.
11. **Read-only maintenance mode lets a running job finish.**
    The three launcher callbacks (`POST /compute/jobs/<job id>/bundle`, `/outputs` and `/outputs/complete`) stay open in `read-only` mode by an exact pattern, for POST and a well-formed job id only: a job already on a cluster has nowhere to hold its results, and a launcher refused there would fail a job that did nothing wrong.
    The person's own `cancel` and `links` stay blocked like any other write, and `full` mode refuses all three callbacks with everything else.
12. **The webhook token is redacted from this Worker's access log.**
    The Tapis webhook address carries its token in the path, because Tapis does not sign webhooks, so the Worker's access logger and the maintenance refusal line print `/webhooks/tapis/<job id>/[redacted]`.
    The token is bound to the job's nonce, dies a day after the job ends and can only make the Worker read the job back from Tapis, so a leaked one is a nuisance and not a breach.
    This covers what THIS Worker prints; Cloudflare's own request logs record the URL before any of this code runs and are outside it.

Not verified against a real tenant or a real R2, and listed so nobody reads them as facts: whether Tapis takes `archiveFilter.includeLaunchFiles` from the request, what `remoteResultInfo` carries for a failed job, the webhook retry policy, presigned multipart `UploadPart` (the 5 GB per-file cap stands), R2's error on a locked delete, a signed checksum header on a presigned PUT (deferred), the `--gpus` spelling, whether R2 returns a SHA-256 on a listing for an object the launcher uploaded through a presigned PUT (it does only for an object stored with one; where it does not, verification of an output is by size alone), whether Tapis passes a JSON launch specification, quotes and braces included, through an environment variable value to the launcher unaltered, and whether the memory and the other request fields a job asks for are taken from the request as written.

## Amendment 2026-11-04 (#2013): the revocation cascade and the ACCESS attribution are built (phase A8)

Migration `0119_compute_access_reports.sql`, `backend/src/services/compute-release.ts`, `access-attributes.ts`, the two callers named below and the reporter's place on the 30-minute tick build decision 9 ("NEMAR reports ACCESS gateway attributes for every tenant job, once") and the revocation rules of design section 7.
"Item N" means the numbered item of THIS amendment.

1. **Ending an account ends its compute in the same batch as its other credentials, through two callers.**
   `computeReleaseStatements(userId)` is run by `finalizeRevocation` (admin revoke, by username and by id) and by `tombstoneUserCascade` (the owner-only soft delete and the scheduled sweep of the live tests' accounts, which run the same function, so it counts once).
   It is not run by a role demotion, because compute is not an admin's standing and a demoted person keeps an account, a grant and jobs; nor by a key revocation (self-service, the owner's, the emailed regeneration), because a job's identity is the account's and not a key's; nor by logout.
   The caller-count sentences of `services/docs-auth.ts` and `services/ticket-assignment.ts` say so, and a third path that ends a whole account needs these statements too.
   `backend/test/compute-release-cascade.test.ts` and `admin-credential-cascade.test.ts` fail when either caller drops them.
2. **A job ends in SQL only when it provably never reached Tapis; every other live job records the intent.**
   The statements, in order and each keyed by the account: every live job records `cancel_requested_at` and the reason `account_ended`, keeping a reason and a time that were already recorded (the first cause stands, so a person's earlier cancel stays `user`); a job with no Tapis job, no launch specification written and no live submit lease is cancelled, its hold released and the release stamped as its settlement, which is `commitTerminal`'s terminal transition and settlement for a job that never started, in the one batch; every pool of the account is frozen.
   "Provably" is exactly the rule `driveCancel` applies before it ends a row itself (item 4 of the A5 amendment): a submit whose answer was lost writes the launch specification before the call and a Tapis job may exist that no search can see, and a submitter holding the lease may be in flight, so ending such a job in SQL would release a hold for a job that then runs, charged to nobody.
   The Tapis cancel of those jobs is never made in the batch: the retried `sweepComputeCancellations` makes it, and charges what the job used, so the account's pools stay held until Tapis says it is over.
   Every statement ends in a WHERE clause and uses plain `?` placeholders, because `tombstoneUserCascade` called with `onlyIfEmail` appends its mask guard to each statement's text; a test runs each statement alone under a false guard and finds nothing changed.
3. **A frozen pool stays frozen until something unfreezes it, and nothing in this phase does.**
   A hold on a frozen pool is refused `suspended`.
   A re-approval of an account for compute (the compute access phase, Epic D) has to unfreeze its pools; so does an administrator's lifting of a suspension.
   An account that was revoked and then restored by the status column alone stays refused for compute, which is the safe direction.
4. **The report ACCESS is owed is a row made in the batch in which a job's record first shows a Slurm id.**
   `compute_access_reports` has one row per job (the primary key), made by `INSERT OR IGNORE` from the job row in the batch of each of the two writers of `slurm_job_id`: the live transition and the terminal transition of `applyTapisJob`.
   So a replayed read adds no second row and never resets a row that has moved on, and a job the scheduler never saw owes nothing.
   This replaces the empty hook `noteSlurmJobId` of the A5 amendment, which ran after the write and could not be one batch with it.
5. **A report is sent at most once towards ACCESS for every outcome the sender cannot judge, and retried only when the answer shows the request was not processed.**
   The claim is one conditional UPDATE (`pending` to `attempting`, a lease stamp, the attempt counted) made before the POST, so two overlapping ticks or Workers cannot both send; the POST is made between two statements and never inside a batch; the outcome is written only under the sender's own stamp.
   A 2xx is `sent`.
   Only an answer that shows the request was not processed is retried: a 4xx other than 409, 408, 429 and 503; the row is then `pending` again with an hour's delay doubling to a day, and `failed` after eight attempts.
   Every other outcome is one the sender cannot judge, and is treated as no answer: no answer at all (a timeout, a lost or refused connection), a 500, 502 or 504 (a gateway in front of a server that already stored the request answers 502 or 504, and a server answers 500 after the write), every 3xx (303, "created, see other", is the usual reply to a POST that stored something, and a redirect is never followed), 409 (which may turn out to mean "already recorded"), and a sender that died holding its ten-minute lease and may have died before or after the POST.
   Each of these ends the row `failed` with `outcome_unknown`, which nothing in code sends again.
   `sent` and `failed` are final.
   The guarantee is therefore that a report may be LOST and is never doubled; it is not that every job is reported.
   The choice follows the design page, where a second report double-counts a person, and the interface's behaviour on a duplicate is unverified.
   Owner action: ask ACCESS whether `job_attributes` stores one record per (job id, resource), so that a duplicate is ignored; if it does, the one function `classifyAnswer` turns the unknown outcomes into retries and nothing else moves.
6. **ACCESS is told the pseudonym and nothing else about a person.**
   The body is the Slurm job id, the scheduler's submission time, the resource name and the job row's `gateway_user` (the stored `gw_` pseudonym, or `nemar-pipelines`), checked against that shape before it is sent; it never carries a name, an email, an ORCID iD or the sign-in subject.
   A job with no pseudonym (a partner job that maps to no account) ends `failed` with `no_gateway_user` and nothing is sent; a record with no submission time waits, costs no attempt and is looked at again in an hour.
   Outside production the body carries `debug`, which the design says the interface offers for tests.
7. **The key, the resource name and the spelling are the owner's and unverified.**
   The key is the Worker secret `ACCESS_GATEWAY_ATTRIBUTES_KEY` and the resource name `ACCESS_RESOURCE_NAME`, both optional, both absent from every table of `wrangler-sccn.toml` and pinned absent by test; unset, a row stays `pending` with `unconfigured`.
   The key is sent in a header and never logged, stored or put in a job.
   The header name (`ACCESS_KEY_HEADER`), the body field names and the time format (`ACCESS_BODY_FIELDS`, `accessSubmitTime`) and the `debug` field are each one constant, taken from the design page and the phase issue, and none has been seen against the real interface.
8. **The reporter is a production-only cron.**
   `runAccessReportCron` (ten due rows a tick, oldest first, one log line of counts and fixed words only) rides the 30-minute tick's production block, is absent from `DEV_CRON_ALLOWLIST`, refuses outside exact production on its own and reads no switch, because a job that ran is owed its report whether or not compute is on.

Not verified, and listed so nobody reads it as fact: which header carries the key, the body's spelling and time format, whether `debug` is a body field, what the interface answers for a duplicate, and whether it accepts the pseudonymous gateway user.
