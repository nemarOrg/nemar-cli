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
8. **`COMPUTE_ENABLED` is a dark switch**: exactly `1` and absent from the wrangler configuration. The switch and the test that pins it landed in phase A4 (issue #2009); every compute cron runs in production only.
9. **NEMAR reports ACCESS gateway attributes for every tenant job**, once, under a per-account pseudonym that is not the sign-in subject.
10. **Every compute word is declared once**, in one of these modules:
   `shared/compute-state.ts` (states, failure, refusal, ledger and cancel words);
   `shared/contract/compute.ts` (the job specification, partition and rate tables, owner policy and launcher file shapes);
   `shared/contract/compute-launch.ts` (the launch specification and the launcher's routes, with their JSON Schema, which `nemarOrg/nemar-process` copies byte for byte);
   `shared/contract/compute-admin.ts` (the allocation, reporting, status and pipeline routes' error words, request shapes and open response schemas; a module of words and of open schemas only, never of a strict one);
   `shared/compute-header.ts` (the inline job header a script states its resources in, read by the CLI and the Worker alike);
   `shared/compute-recipes.ts` (the pipeline recipe registry, the stamp states and the recipe's argument words);
   `shared/contract/compute-observation.ts` (the observer's document, with its JSON Schema shared byte for byte with `nemarOrg/nemar-process`);
   `shared/contract/compute-responses.ts` (the open response schemas of a person's cancel and links and of the observer's answer).
11. **Two digests, named apart.** `spec_digest` is the job row's: the SHA-256 of the exact bytes of `records/<id>/spec.json`. `launch_spec_digest` is the launcher's: the SHA-256 of the exact raw bytes of the `NEMAR_LAUNCH_SPEC` value, which is ASCII-only JSON, hashed before parsing.
12. **Responses are open, requests and documents are closed.** The two responses a launcher reads ignore unknown keys, so one that runs for 48 hours survives the Worker adding a key; the job specification, owner policy, launch specification and the launcher's own files refuse them.
13. **Launcher details are declared and classified, in `shared/compute-state.ts`.**
   `LAUNCHER_DETAILS` maps each of the seven launcher codes to the fixed-word details it may carry, and `PLATFORM_LAUNCHER_DETAILS` is the subset that is a NEMAR, node, runtime or contract fault.
   The rule: a detail is the platform's if and only if a submitter cannot cause it with a valid specification and bundle, and a dataset that was eligible when the job was submitted.
   That rests on an eligibility gate at submit, and today the gate runs on the pipeline path only: `resolveRun` in `compute-pipeline.ts` refuses with `dataset_not_eligible` a dataset that is not eligible (ADR 0065 and the pipeline predicate), `version_not_found` or `version_untagged` for a version that is not published or has no data-plane tag, and `too_many_files` for a manifest over 38,000 entries (`PIPELINE_MANIFEST_MAX_ENTRIES`).
   `createJob` does not apply it: it leaves the check to its caller, and no person-facing submit route exists until Epic D3 (#2024).
   So the classification is a REQUIREMENT on that route, which must call the same eligibility check before it creates a job (the hand-off is on #2024), and until it does, `dataset_not_found` and the manifest-too-large case are declared as the platform's only because the one submitter that is reachable, NEMAR's own pipeline, passes the gate; a person's job cannot reach them yet.
   `isPlatformFailure(code, detail)` follows it: a platform detail is refunded even under `runtime_error` **["refunded" superseded by the A5 amendment of 2026-11-04 (#2010), item 1: it is attributed to the platform, flagged, and not refunded]**, a submitter detail is charged even under `code_fetch_failed` or `dataset_fetch_failed`, and a missing or undeclared detail leaves the code alone to decide, as before.
   The result refusal details stay as they were.
   [The platform failure CODES, which `isPlatformFailure` also reads, are now twelve: `tapis_record_lost` is the twelfth (a live job whose Tapis record is gone; "Review fixes of 2026-11-06", item 10). It settles by the row's evidence of use, and a charged lost job is flagged `mismatch`.]
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
   **One secret signs three kinds of token, so it cannot be rotated while a job runs.**
   `PRESCREEN_CALLBACK_SECRET` signs the webhook token, the launcher's `job_token` and the observer's run token (domain-separated by their tags), and the prescreen and pull-request review callbacks as well.
   The job token is written into the job's launch specification once, at submit, and that text is never re-signed.
   Rotating the secret therefore refuses every running job's uploads (the job ends `result_upload_failed` and is charged, as any upload failure is), stops the webhook addresses registered with Tapis (the 30-minute poll remains), and refuses an observer token already minted.
   The safe rotation: switch compute off, let the running jobs drain (none `submitted`, `queued`, `running`, `archiving` or `unreported`), change the secret, mint observer tokens afterwards, switch compute on; for a suspected leak, cancel the running jobs first and accept the cost.
   `.rules/revocation.md`, `compute-tokens.ts` and the binding's comment say the same.
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
    **What each maintenance mode does to the rest of compute** (verified against `middleware/maintenance.ts` and the crons on 2026-11-06; the middleware, and the service-binding entrypoint beside it, are the Worker's only readers of `MAINTENANCE_MODE`; no cron reads it):

    | Surface | `read-only` | `full` |
    |---|---|---|
    | Launcher callbacks (`POST /compute/jobs/<id>/bundle`, `outputs`, `outputs/complete`) | open, by exact shape | 503: the launcher's upload fails and the job ends `result_upload_failed`, charged what it used, with no refund |
    | A person's `cancel` and `links` | 503 | 503 |
    | Tapis webhook (`POST /webhooks/tapis/<job id>/<token>`) | open: it passes the `/webhooks/` allowlist, and it WRITES (the job's state, and its settlement or release in the ledger) | 503; the job's end is then seen by the poll after the mode ends |
    | The observer (`POST /compute/observer`) | 503: a write, not on any allowlist, so the day's settlement waits for a post after the mode ends (its token is good for an hour) | 503 |
    | Administrator routes (`/admin/compute/*`, including the ledger-writing ones: pool grant and adjust, `jobs advance` and `cancel`, the pipeline run, holds, observer mint, the ACCESS re-queue) | open: the `/admin/` prefix is allowlisted, so they write | 503 |
    | Crons (the 30-minute tick, the daily jobs) | run | run |

    The crons do not read `MAINTENANCE_MODE` at all: the advance tick, the cancel sweep, the ACCESS reporter, the tenant sweep and the retention sweep run and write in every mode, which is deliberate for a job already on a cluster and means maintenance does not freeze the ledger.
    Anyone who needs the ledger frozen turns the compute switch off, which stops new holds and submits but not these.
    `LAUNCHER_CALLBACK_RE` is anchored at `/compute`, so the `/nemar/compute/...` spelling of the same route (the API is mounted at `/` and at `/nemar`, and middleware sees the full path) is not matched and is refused in `read-only`; the same is true of the `/admin/`, `/webhooks/` and `/auth/login` allowlists.
    That is not a defect today and the regex is unchanged: the launcher and the Tapis webhook address are built from `API_BASE_URL`, which has no prefix, so no caller uses the `/nemar` spelling, and the miss is in the safe direction (blocked, never opened).
    A deployment whose `API_BASE_URL` gains the `/nemar` prefix has to widen every allowlist at once, not this pattern alone (`.memory/api-mounted-twice-full-path.md`).
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
   It is not run by a role demotion, because compute is not an admin's standing and a demoted person keeps an account, a grant and jobs; nor by a key revocation (self-service, the owner's, the emailed regeneration), because a job's identity is the account's and not a key's (so a stolen key's jobs that were already submitted keep running, and are charged to the account, until the person cancels them or an administrator revokes the account); nor by logout.
   The caller-count sentences of `services/docs-auth.ts` and `services/ticket-assignment.ts` say so, and a third path that ends a whole account needs these statements too.
   `backend/test/compute-release-cascade.test.ts` and `admin-credential-cascade.test.ts` fail when either caller drops them.
2. **A job ends in SQL only when it provably never reached Tapis; every other live job records the intent.**
   The statements, in order and each keyed by the account: every live job records `cancel_requested_at` and the reason `account_ended`, keeping a reason and a time that were already recorded (the first cause stands, so a person's earlier cancel stays `user`); a job with no Tapis job, no launch specification written and no live submit lease is cancelled, its hold released and the release stamped as its settlement, which is `commitTerminal`'s terminal transition and settlement for a job that never started, in the one batch; every pool of the account is frozen.
   "Provably" is exactly the rule `driveCancel` applies before it ends a row itself (item 4 of the A5 amendment): a submit whose answer was lost writes the launch specification before the call and a Tapis job may exist that no search can see, and a submitter holding the lease may be in flight, so ending such a job in SQL would release a hold for a job that then runs, charged to nobody.
   A partner's reservation (`source = 'partner'`, no Tapis job yet) is left alone entirely, by the cascade and by `driveCancel` (and the sweep's list leaves it out, like `CREATED_ROWS_SQL`): NEMAR never writes a launch specification or takes a submit lease for a partner job, so "never reached Tapis" is true of it whether or not the partner has launched its own Tapis job under the reservation, and ending it would release a hold for a job that may be running.
   The reservation is the partner contract's to resolve (an open point for the partner phase); a partner job that has a Tapis job is an ordinary live job, cancelled there because NEMAR owns every Tapis job.
   The Tapis cancel of those jobs is never made in the batch: the retried `sweepComputeCancellations` makes it, and charges what the job used, so the account's pools stay held until Tapis says it is over.
   Every statement ends in a WHERE clause and uses plain `?` placeholders, because `tombstoneUserCascade` called with `onlyIfEmail` appends its mask guard to each statement's text; a test runs each statement alone under a false guard and finds nothing changed.
3. **A frozen pool stays frozen until something unfreezes it, and nothing in this phase does.**
   A hold on a frozen pool is refused `suspended`.
   A re-approval of an account for compute (the compute access phase, Epic D) has to unfreeze its pools; so does an administrator's lifting of a suspension.
   An account that was revoked and then restored by the status column alone stays refused for compute, which is the safe direction.
   Two things will freeze a pool (this cascade and the suspension of compute in Epic D) and they share one bit, so Epic D has to record the freeze cause, or derive `frozen` from the access state, so that lifting one cause does not lift the other.
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
   The tick stops CLAIMING new rows after the first of them (the rows not claimed stay `pending`, with no attempt spent and no lease, for the next tick): the first sign of a deploy's 502, a 500, a redirect from a wrong address or a timeout may be a fault every later row would meet the same way, and a systematic fault therefore loses one report a tick and not ten, which leaves the error-level log line a margin of thirty minutes to be noticed in.
   An answer that proves the request was not processed (a retry) does not stop the tick.
   `sent` and `failed` are final.
   The guarantee is therefore that a report may be LOST and is never doubled; it is not that every job is reported.
   The choice follows the design page, where a second report double-counts a person, and the interface's behaviour on a duplicate is unverified.
   Owner action: ask ACCESS whether `job_attributes` stores one record per (job id, resource), so that a duplicate is ignored; if it does, the one function `classifyAnswer` turns the unknown outcomes into retries and nothing else moves.
6. **ACCESS is told the pseudonym and nothing else about a person.**
   The body is the Slurm job id, the scheduler's submission time, the resource name and the job row's `gateway_user` (the stored `gw_` pseudonym, or `nemar-pipelines`), checked against that shape before it is sent; it never carries a name, an email, an ORCID iD or the sign-in subject.
   A job with no pseudonym (a partner job that maps to no account) ends `failed` with `no_gateway_user` and nothing is sent; a record with no submission time waits, costs no attempt and is looked at again in an hour, and a week after the Slurm id first showed it ends `failed` with `no_submit_time` (a terminal job is never read from Tapis again, so a time that is not there by then will not come, and the row would otherwise come back into the ten-row window every hour for ever).
   Outside production the body carries `debug`, which the design says the interface offers for tests.
7. **The key, the resource name and the spelling are the owner's and unverified.**
   The key is the Worker secret `ACCESS_GATEWAY_ATTRIBUTES_KEY` and the resource name `ACCESS_RESOURCE_NAME`, both optional, both absent from every table of `wrangler-sccn.toml` and pinned absent by test; unset, a row stays `pending` with `unconfigured`.
   A persistent refusal is noticed in hours, not days: a key ACCESS refuses (401, 403) or a wrong base address (404) is retried with a delay doubling from an hour, which is about 79 hours of info-level lines before the eighth attempt fails the row, so every tick logs one error-level line (counts and a fixed word only) whenever a pending row has used three attempts with a retry class, whether or not any row is due.
   `GET /admin/compute/status` and `nemar admin compute status` report the presence of each (never a value), because the reports wait until both are set, and every tick that leaves a row waiting for either logs one error-level line with the count: silence while there is work to do is evidence of nothing (ADR 0053, 0054).
   The key is sent in a header and never logged, stored or put in a job.
   The header name (`ACCESS_KEY_HEADER`), the body field names and the time format (`ACCESS_BODY_FIELDS`, `accessSubmitTime`) and the `debug` field are each one constant, taken from the design page and the phase issue, and none has been seen against the real interface.
8. **The reporter is a production-only cron.**
   `runAccessReportCron` (ten due rows a tick, oldest first, one log line of counts and fixed words only) rides the 30-minute tick's production block, is absent from `DEV_CRON_ALLOWLIST`, refuses outside exact production on its own and reads no switch, because a job that ran is owed its report whether or not compute is on.
   It stops CLAIMING new rows about twenty seconds after it starts (one POST's fifteen and a margin); the rows it did not claim stay `pending` for the next tick, so a run that is killed does not strand a claimed row as `outcome_unknown`.
9. **The two-caller rule is enforced by a source scan, not by prose alone.**
   `COMPUTE_END_CALLERS` (the documented list of the functions that run `computeReleaseStatements`) and `COMPUTE_END_EXCEPTIONS` (the functions that revoke all of an account's keys and its sessions and deliberately leave its compute: the role demotion and the emailed key regeneration, each with its reason) are held to the code by `backend/test/compute-end-callers.test.ts`, on the syntax tree, through aliased and namespace imports and uses that pass the function as a value, and refusing what it cannot follow (a dynamic import, a re-export, a module-level reference).
   "Revokes all of an account's keys and its sessions" means THROUGH THE STATEMENT SHAPES THE SCAN RECOGNISES: `UPDATE tokens SET revoked_at ... WHERE user_id ...` (an equal to a placeholder, an `IN`, a subselect, in either order of the predicates, the table quoted, bracketed or schema-qualified, in any case, and not a one-key revocation by id or hash) and `UPDATE web_sessions SET revoked_at` or `DELETE FROM web_sessions WHERE user_id ...`, inline or in a constant or helper resolved by value, in the module it is imported from.
   A revocation written another way (SQL assembled from parts the scan cannot fold) is not recognised: the scan is a tripwire for the shapes the Worker uses, not a proof that no path ends an account.
   A third path that ends an account (Epic D's suspension) has to run the compute statements or be named an exception, in a reviewed change. Epic B's owner merge command, `oidc end-account`, is not such a path: per ADR 0119 it ends the OIDC holdings only and revokes nothing, and compute ends through the revoke or delete the owner runs after it, which are already listed.

Open points for the phases that follow, recorded so nobody reads them as settled:
- A partner job with no account has no pseudonym and ends `failed` with `no_gateway_user`; the partner contract must supply one for account-less partner jobs (for example per client and Tapis owner).
- The partner contract (phase D4) must define, for a partner reservation (item 2):
  (a) who ends or expires an unlaunched reservation and releases its hold;
  (b) what a person's cancel of a reservation means: today it records the intent and reports success while the row stays `created` with its hold open, and a later partner bind is refused because `BIND_TAPIS_JOB_SQL` requires `cancel_requested_at IS NULL`;
  (c) a partner that launches under the reservation of an ended account runs unchallenged under a frozen pool, because the cascade records no intent on a reservation (it fails open): consider recording the intent so the bind refuses (fail closed);
  (d) a way to list stuck reservations for the reporting phase (the status view does not count them).
- Residuals of the reporter, accepted and recorded so nobody reads them as closed:
  (i) a 503 that a proxy answers after the upstream had processed the request (an upstream reset behind a gateway) would duplicate a report; it is rare, and the checkpoint accepted it;
  (ii) if the runtime stops `waitUntil` work about thirty seconds after `scheduled()` returns, a twenty-second budget plus a fifteen-second POST can exceed it; the reaper then ends the claimed row `outcome_unknown`, so the report is lost and never doubled.
- The reporting phase lists `failed` report rows by word, and an owner-only re-queue requires an explicit acknowledgement that the report is confirmed not recorded at ACCESS.
- The cancel sweep takes the oldest ten rows with a recorded cancel, so a queue of cancels that cannot complete can stall it (pre-existing, phase A5), and staging never cancels at Tapis (phase A5's choice).
- Which headers the interface wants, beyond the key's (for example a resource header), is checked against the real interface when the key is issued.

Not verified, and listed so nobody reads it as fact: which header carries the key, the body's spelling and time format, whether `debug` is a body field, what the interface answers for a duplicate, and whether it accepts the pseudonymous gateway user.

## Amendment 2026-11-04 (#2043): the launch specification travels as base64url (contract follow-up A1c)

The review of the launcher phase found that the launch specification, which travels as ONE scheduler environment value, is not safe to carry as compact JSON.
It read the scheduler as writing an environment value into a file that a shell sources on the compute node, and as quoting a value only conditionally; that reading is unverified (see the list at the end).
On that reading, a value with no space is written bare, so the shell consumes the quotes of the JSON and the launcher reads invalid JSON; and shell-active characters in a user's strings (a command substitution, a backtick, a quote, a backslash) are expanded or break the quoting, outside the container.
Nothing is registered with a tenant and every compute switch is dark, so nothing was exposed.
The repository owner approved the fix on 2026-11-04: base64url without padding.
"Item N" means the numbered item of THIS amendment.

1. **The `NEMAR_LAUNCH_SPEC` value is the launch specification's JSON text in base64url, with no padding.**
   Request for Comments (RFC) 4648 section 5, alphabet `A-Za-z0-9-_` (`SHELL_INERT_ENV_ALPHABET`), no padding and no line break, applied to the bytes of the printable-ASCII JSON text that `encodeLaunchSpec` writes (every byte 0x20 to 0x7e: JSON escapes the control bytes, and `encodeLaunchSpec` escapes DEL and everything from 0x80 up).
   The variable name is unchanged.
   A value made only of that alphabet holds none of the characters a conditional quoter would quote for and none that a shell, a glob or a quoting rule acts on, so how the scheduler quotes is no longer something the launch specification depends on.
   `encodeLaunchSpecEnv(text)` is the wire step, beside `encodeLaunchSpec`, which still returns the JSON text because the text is what is hashed and recorded.
   It returns a branded type, `LaunchSpecEnvValue`, and the Tapis client's input is that type (`SubmitJobInput.launchSpecEnv`), so the compiler stops the text being sent as the value (a plain string is not assignable to it); at run time the client's schema also refuses a text where a value belongs (item 5).
   The brand works in one direction only.
   The value is still a string, so the reverse mistake compiles: passing the value where the text belongs, encoded again or hashed in place of the text.
   The compiler does not catch that; verification does, because a digest over the value is not the launcher's digest of the decoded text, so the job fails closed and the digest and verify tests fail.
   No production code mixes them, and a second brand for the text was weighed and not added: it would touch many test call sites for a mistake that verification already catches.
   A5's builder (`buildLaunch`) calls both, records the digest of the text and sends only the encoded value in `parameterSet.envVariables`.
2. **The JSON text, its 64 KiB cap and both digests are unchanged.**
   `spec_digest` is the SHA-256 of `records/<id>/spec.json`, and `launch_spec_digest` is the SHA-256 of the launch specification's JSON text, which is what the value decodes to; neither is over the encoded value.
   The launcher decodes the value, hashes the TEXT, then parses it, and records that digest in `provenance.json`.
   The Worker's digest, written before the submit, is of the same text, so the check that compares them (item 7 of the A5 amendment) proves what it proved before.
   The golden vector's text and its SHA-256 are unchanged; an encoded golden vector (its string, its length and its SHA-256) is added beside it, with a second vector chosen to hold both `-` and `_` and the characters a shell acts on.
3. **The encoded value is bounded, and the bound is declared once.**
   `LAUNCH_SPEC_ENV_MAX_CHARS` is `ceil(65536 * 4 / 3)`, which is 87,382: base64url without padding spends `ceil(n * 4 / 3)` characters on `n` bytes, so every text within the 64 KiB cap encodes within the bound, and a text of exactly the cap encodes to exactly the bound.
   The encoder checks the cap on the text and nothing else, because a second check of the encoded length could never fire; a test pins the arithmetic instead (`ceil(n * 4 / 3)` only grows, is exactly the bound at 65,536 and one past it at 65,537), and `launchSpecFits` (the Worker's worst case) asks the text cap alone.
   The decoder and the Tapis client's request schema bound the value by the same constant.
4. **The decoder is strict and canonical, and there is no earlier format.**
   `decodeLaunchSpecEnv(value)` returns the text or one of five fixed refusal words (`empty`, `too_long`, `not_base64url`, `bad_length` or `not_printable`) that never holds a part of the value.
   The checks run in this order, and the first to fail names the refusal: the value is a string (an unset environment variable is not one, and is refused with `not_base64url`); it is not empty; it is at most the bound, counted in characters of the value (UTF-16 code units in the reference; for every accepted value that is also its length in bytes, because an accepted value is ASCII); it is made only of the alphabet (so no padding, no `+` or `/`, no whitespace and no line break); its length is not 1 modulo 4; the `=` padding is added back to a multiple of four (one sign for a length of 3 modulo 4, two for a length of 2 modulo 4; a length of 1 modulo 4 was refused before this step) and the value is decoded; it decodes to printable ASCII only, every byte 0x20 to 0x7e; and it is canonical.
   A value is canonical when encoding the decoded text again gives the value back, so the unused trailing bits of its last character are zero and there is one value per text: `QQ` is accepted, and `QR`, which decodes to the same byte, is refused with `not_base64url`.
   The caller then parses the JSON.
   The encoder refuses a text with a byte outside 0x20 to 0x7e (a control byte, DEL or anything from 0x80 up) with a TypeError, and a text over the cap with a RangeError, and no message holds any part of the text.
   The printable rule is one rule for both sides: the launcher drops its separate NUL check (`has_nul`) and uses `not_printable`.
   A raw JSON value, which starts with `{`, is refused: nothing is registered with a tenant, so no earlier format is accepted anywhere.
   The launcher's decoder is required to follow the same rules, with the same words for ASCII values, in the same order.
   For a value that contains a non-ASCII character, `too_long` and `not_base64url` are both conforming answers: neither can be accepted, and a length is counted in different units by different languages (UTF-16 code units, code points, bytes), so the first word can differ.
   The conformance comparison checks accept or refuse for every value, and the word only for ASCII values.
   The length check stays first because it keeps the work bounded.
5. **The Tapis client refuses anything else before a request is built, and a refusal of the job's own data ends the job.**
   The request schema's value passes only when `decodeLaunchSpecEnv` accepts it (one rule, shared with the decoder, and not a second check of the characters), so a raw JSON text, padding, a quote, a space, a newline, a value over the bound, a value that is not canonical and one that does not decode to printable text are each refused with the field's name and never the value.
   The closed one-variable array and `archiveFilter.includeLaunchFiles: false` are unchanged.
   A request refused for the job's own data (the launch value, or a field that comes from the job's row) is wrong the same way on every attempt, so it is a typed error, `SubmitRequestRefused`, with a reason word (`launch_spec_env` or `job_field`).
   `submitLeased` ends such a job `failed` with `tapis_submit_failed` and the detail `invalid_spec`, the code a refused launch specification already carries, and releases the whole hold through the path of a job that never started (released, not refunded), instead of trying again on every tick until the reservation wait runs out.
   The owner is NEMAR's configuration and not the job's data: a bad one stays a plain RangeError and the job waits for the fix, and any other exception keeps the unavailable retry.
   The encoded value holds the per-job token, so it is held to every rule the plain token is: it is not logged, returned or stored.
   The tests that look for a leak look for every form of the token (the plain token, the whole value, and the token's base64url text at each of its three alignments in a group), because the plain token is not a substring of the value, nor of a slice of it.
6. **The hazard is reproduced, not asserted.**
   `test/compute-launch-env-shell.test.ts` implements the scheduler's conditional quoting (`backend/test/helpers/scheduler-launch-file.ts`), writes `export NEMAR_LAUNCH_SPEC=<value>`, sources the file with a real `sh` in a fresh directory and prints the variable back.
   The old value, kept in the test as the negative control, fails the round trip for a specification without a space and for `$(...)`, a backtick, `"` and `\` in a user's string; `$(...)` and a backtick make the shell run what the value holds (the examples are inert: a `touch` of a path in that directory).
   One shape the old value did carry is asserted too, so the detector is seen to tell cases apart.
   The new value comes back exactly for adversarial arguments, a command, environment values and a document of 64 KiB, and no file is made.
   The scheduler's rule is the review's reading of it and is unverified; that is why the launch specification is made independent of it.
7. **What this supersedes.**
   Decision 11 says the digest is "of the exact raw bytes of the `NEMAR_LAUNCH_SPEC` value, which is ASCII-only JSON": read it as the exact bytes of the launch specification's JSON text, which the value decodes to.
   Item 4 of the A5 amendment ("the SHA-256 of the exact `NEMAR_LAUNCH_SPEC` bytes") reads the same way.
   The last clause of the A5 amendment's not-verified paragraph (whether Tapis passes a JSON launch specification, quotes and braces included, through an environment variable unaltered) is no longer the question: the value holds no quote or brace.
   Nothing is removed from this record; the earlier sentences stay as they were written.
8. **Registration stays blocked.**
   No application definition is registered with any tenant, and `COMPUTE_ENABLED` is not turned on anywhere, until the launcher's decoder lands in `nemar-process` (it implements the same format, with the golden vectors and the alphabet pinned on both sides) AND the owner items recorded on the launcher phase's pull request (`nemarOrg/nemar-process#9`) are settled.
   The order is: this change merges into the compute epic branch, then `nemar-process` re-pins the schema file to this merge commit and merges.
   The schema file `shared/contract/compute-launch.schema.json` changes in its descriptions and not its structure: it describes the document, says the document travels as base64url and claims nothing about the scheduler; `nemar-process` copies it byte for byte.

Not verified against a real tenant, and listed so nobody reads it as fact: how the scheduler quotes an environment value (the rule the tests reproduce is a reading of it), and whether Tapis and the scheduler accept an environment value of up to 87,382 characters.

## Amendment 2026-11-05 (#2011): first-party pipeline dispatch is built (phase A6)

"Item N" means the numbered item of THIS amendment.

1. **A recipe is resolved before `createJob`.**
   The job is made from a complete specification: the recipe's name beside the `image` runtime, NEMAR's own runtime image (`COMPUTE_RUNTIME_IMAGE`, one digest-pinned reference), the command `nemar-recipe run <name>`, and arguments that carry the dataset directory (`/data/<id>`), the product directory (`/work/outputs/product`), the dataset identity and the image digest.
   So `spec.json`, `spec_digest` and `launch_spec_digest` describe what ran, and the launch-specification builder never meets a recipe-only specification.
   The arguments are absolute because the command is an argument vector and no shell expands a variable.
   A whole-dataset run names no `--recording`.
   The registry is `shared/compute-recipes.ts`; its numbers are initial, and its version and engine are what the Worker EXPECTS the recipe to report.
2. **One stamp per dataset version, recipe, recipe version and engine** (`compute_pipeline_stamps`, migration 0117).
   A run claims its tuple FIRST, with an insert whose attempt number is read inside the statement, and a partial unique index refuses a second `dispatched` or `succeeded` row for one tuple, so two runs racing for one tuple make one stamp and one job.
   A `failed` or `refused` stamp is history and never blocks a retry.
   The job's idempotency key is made from the tuple and the attempt, so a job whose creation committed and whose link did not is found again by its key instead of being failed.
   A claim never followed by a job is failed after 30 minutes.
   Deleting a dataset deletes its stamps; the job rows and the ledger stay.
3. **The stamp says what ran.**
   It is claimed with the registry's version and engine and, when the job succeeds, rewritten from the recipe's own dataset record (`extensions.nemar.recipe` and `.engine`), read from the results bucket; a record that is absent, unreadable or another recipe's ends the stamp `failed`, and the job is untouched.
   When a job finishes, the sync compares the tuple its record names with the tuple its stamp claimed.
   A difference holds the CLAIMED tuple (a `failed` stamp with the word `tuple_mismatch`, written once per job, before the stamp is rewritten): the registry is out of date or the image is, and dispatching again would run the same datasets over and over under a tuple the table does not name.
   The hold is checked in the shared dispatch path, so a single dispatch, the queue, the daily dispatcher and the dry run all refuse with `registry_drift`, writing nothing.
   The hold does not clear by time.
   It clears when the registry declares another tuple, which is what a version bump is (a bump is never held, because the hold names the old tuple), or when its mismatch rows are deleted: deleting the dataset a row names deletes the row too, because the dataset cascade removes every stamp of the dataset, and the cascade is the rule.
   The next mismatch on any dataset holds the tuple again, so the exposure that a deletion lifts is bounded by the live cap.
   What stays exposed are the jobs already in flight when a mismatch first appears: they were dispatched under the claimed tuple and finish under the same mismatch, so the first mismatch can cost up to the live cap of jobs, each of which is stamped with what it ran.
   A record whose `<package>@<version>` is longer than the stamp's 64-character engine column is unreadable and ends the stamp `failed`.
   A stamp that cannot carry the tuple its record names ends `failed`: as `tuple_already_stamped` when that tuple already holds a live or succeeded stamp, and as `tuple_attempt_taken` when it only has a row (history) with this attempt number. The run may be good in both cases; the word says only that this stamp cannot carry its tuple, and neither word counts toward the cooldown or the cap.
   A tuple whose stamp failed is not a candidate of the queue for 7 days after the failure, nor once it has failed 3 times (both initial, `RETRY_COOLDOWN_DAYS` and `MAX_FAILED_ATTEMPTS`), so datasets that keep failing cannot take the page of every run.
   Only failures a dataset can cause count toward either: the platform's failure codes, a cancel, and the words for the Worker's and the registry's own faults (`NON_DATASET_FAILURE_WORDS`) do not, so transient errors on three days cannot shut a dataset out until its version changes.
   The cooldown and the cap govern the queue and the cron only: an administrator's dispatch of one named dataset bypasses both, and is still refused for a live stamp, a held tuple or an ineligible dataset.
   A placeholder recipe (`nemar-ica`) is refused on every path with `recipe_placeholder`.
4. **The image digest a recipe job passes is checked against the launcher's provenance.**
   `--image-digest` is the caller's claim and the recipe cannot check it.
   `verifyResults` compares the one value the recorded specification passes with the digest `provenance.json` says the launcher ran, and fails the job `result_verification_failed` with `image_digest_mismatch` (flagged for an administrator) on a difference, a missing flag, a malformed value or a second flag.
5. **Eligibility is one predicate, decided from the D1 row on every dispatch** (ADR 0065): active, public, `anonymous = 0` (NULL is unknown, and unknown is not false), first published, not withdrawn, DOI not tombstoned, a version, `eeg` as a whole modality token, and a real `nm` or `on` id outside the reserved fixture band.
   The request names a recipe, a dataset and optionally a version, and nothing else; a body with any other key is refused.
   A version with no data-plane tag, or one whose manifest holds more than 38,000 entries, is refused (`version_untagged`, `too_many_files`) and is never a candidate of the queue.
6. **The daily dispatcher is dark three times over.**
   It returns null outside exact production, does nothing and touches no table until `COMPUTE_ENABLED` and `COMPUTE_PIPELINES_DISPATCH_ENABLED` are both exactly `1`, and is wired only into the production-only daily block.
   It dispatches `autoDispatch` recipes only, within `policy.pipelines.dailyJobCap` less today's pipeline jobs (an administrator's included) and `policy.pipelines.maxLiveJobs` per pool, and a refused hold stops the run for that pool.
   It also stops at 10 jobs a tick, a bound of its own: one dispatch costs about 25 statements and calls and the one sync of the tick 250 to 450 (50 open stamps at 5 to 9 statements and calls each), so a tick is bounded at about 510 in the usual case and 710 at the worst, against the allowance of 1,000 that the daily jobs share, and the owner's cap is a ceiling and not a rate.
7. **A dry run reads only** and works in every environment: it makes no stamp, job, hold or audit row and calls neither Tapis nor a bucket.
   The compute switch is read where new pipeline work would start (the dispatch, the route's live run) and reported by the dry run; the lifecycle still gates in `submitLeased` alone, so a job already on a cluster is never stranded.

Not verified: the figures in the registry (cores, memory, minutes), the 10-job tick bound against a measured subrequest count, and the engine string a real run of the recipe reports (the reader follows the recipe's published record format, not an observed record).

## Amendment 2026-11-05 (#2012): the tenant sweep, the observer, reporting, holds and retention are built (phase A7)

"Item N" means the numbered item of THIS amendment.

1. **A job that skipped the reservation is charged as an `overrun` of the partner pool `tenant`.**
   The issue said "a `charge` entry (no hold)".
   The table refuses a `charge` that closes no hold (`compute_ledger_closes_its_hold`), and a job nobody reserved has none, so the entry is an `overrun`: use charged to the pool without a hold, counted against the `people` budget (the table requires it), with the balance free to go negative, once per job (`job:<id>:unreserved`), for a figure above 0, and only to a partner pool (the statement checks the holder kind).
   It is NEVER written to a person's pool, however clear whose job it was. Moving the charge later is a ledger operation (an `adjust` entry) that Epic D's partner-pool phase exposes; the admin routes reach account and platform pools only, so until then no route moves it.
   The row's `flag_overrun` is NOT set for it (the `unreserved` flag already says what happened).
   The decision is one small statement (`unreservedChargeStatements`); a `charge` kind that closes no hold would need a migration of the ledger's triggers, which the phase did not take.
2. **Expanse's own figure does not correct an unreserved job's charge.**
   A final settlement is `settleFinal`, which corrects a hold's charge; a job that skipped the reservation has no hold.
   The observer still matches such a job's row by its Slurm id and lists it; the figure is read by an administrator. Moving the charge, if it is warranted, is the ledger operation Epic D's partner-pool phase exposes; until then no route moves it.
3. **The tenant sweep** (`sweepTenantJobs`, `live` every 30 minutes and `week` once a day, production only, and only while `COMPUTE_ENABLED` is `1`) lists the tenant with `listType=ALL_JOBS` (five pages of 1,000, newest first as asked with `orderBy=created(desc)`, whose spelling is UNVERIFIED) and filters in code.
   For a Tapis job no row is bound to: a tag `nemar_job:<id>` for a row that has no Tapis job binds the row (the submit race) and cancels nothing; a tag for a row bound to another job, ended, or with a cancel pending is a duplicate, cancelled, the row flagged `mismatch`, never indexed (this is what catches a row's SECOND orphan, which the row's one orphan slot cannot hold); anything else is indexed FIRST (source `partner`, client `tenant`, `spec_digest` the SHA-256 of the Tapis fields read, `unreserved`, or `unattributed` when the owner maps to no active account by the gateway pseudonym), then cancelled, then followed to its end and charged.
   The row is written before the cancel so that a crash between them leaves a row to finish.
   A listing that fails changes nothing.
   A job that skipped the reservation is the sweep's own row: the tick, a read-back, a person's or an administrator's cancel and `jobs advance` leave it alone (`flag_unreserved = 1` is excluded from every generic list and refused by `driveCancel` and `advanceComputeJob`).
   The sweep reads the compute switch (`computeEnabled`), which the source scan of phase A5 had allowed in one place; the scan names the sweep now.
4. **The observer is an unsigned sender with a token for one run.**
   An administrator mints it (`POST /admin/compute/observer-runs`, audited): `<run id>.<HMAC>` under the callback secret with the domain tag `compute-observer` over the run id and the run's own nonce, valid for an hour, never stored.
   `POST /compute/observer` takes the token as `Authorization: Bearer <token>` (the amendment of 2026-11-06 replaced the header `X-Compute-Observer-Token` and the body described here), checks it BEFORE it reads a byte, answers ONE refusal (`403 observer_refused`) for a wrong, expired, reused, unknown or missing token, reads at most 1 MiB, validates the document and every row it maps to to the shape of its column, and only then spends the run with one conditional UPDATE, so two posts racing make one ingest and a body that fails validation does not spend the run.
   The two bounds, 1 MiB and 5,000 rows, are both kept; the longest row is 231 bytes, so 1 MiB admits about 4,500 of them.
5. **Final settlement against Expanse's figure** (`settleObservedRows`, run by the ingest and by the daily sweep): a stored row is matched to the job with its Slurm id; when that job has ended with a provisional `charge` and no final one, `settleFinal` brings the charge to the row's own `charged_milli` or, when it sent none, to the rate table's figure for the allocation it reports (per node: the row's CPUs, memory and GPUs are totals).
   A difference within `settle.toleranceMilli` or `settle.tolerancePercent` of the provisional charge is routine; beyond it `flag_mismatch` is set and the job is STILL settled to Expanse's figure.
   A row whose job has not ended waits and is settled by the next pass; a row that cannot be priced, or that the pools cannot take, flags the job once and is judged (`applied_at`), so it is not tried for ever.
6. **Legal holds** (`compute_legal_holds`): a hold on `job:<id>` or `account:<id>`, owner-only and audited, one active hold per target.
   The retention sweep reads the hold when it chooses and again immediately before it deletes, and the statement that reduces the row carries the hold term as well.
   A hold never keeps a result.
7. **Retention** (`runComputeRetentionSweep`, daily, exact production, no switch): for a terminal job past `retention_until` with no hold it deletes `records/<id>/` and `logs/<id>/` and reduces the row to anonymous counts (null `account_id`, `tapis_owner`, `gateway_user`, `idempotency_key`); an unflagged, unheld job loses its logs after `retention.logsDays`; a flagged job keeps them with its records (design section 9); results are only reconciled (a result still present a day after `retention.resultsDays` is deleted and counted `late`).
   It never changes a lock: ANY refusal of a `records/` or `logs/` key is counted `locked`, whatever its text (the text of R2's refusal is not verified), the job is left whole and stamped (`retention_attempted_at`) to go behind the others, and the next day asks again.
   One audit row of counts, only when something happened, and one log line; nothing per job.
8. **Anonymization of a deleted account's pools and ledger actors** (migration 0130, numbered after the used ranges, 0114 to 0119 and 0120 to 0124; Epic D's range starts at 0131 so that no migration is numbered below an applied higher one): the two triggers that made the pools' identity and the ledger immutable are replaced by themselves plus one narrow exception.
   A deleted account's pool may have its `holder_ref` replaced by `9` and the pool's own id padded to 15 digits (derived from the pool, unique, passing the account shape check), and nothing else about it may change in that statement (not an amount, `frozen`, the word or the kind), and not while it holds SU in an open hold.
   A ledger entry whose `actor_user_id` is a deleted account may have it replaced by 2^53 - 1, with every other column equal, and not while it is an open hold's own entry.
   The ledger's DELETE trigger is NOT replaced: no row is removed.
   THE TOTALS INVARIANT therefore holds by construction: nothing the exception allows changes a delta, a total, a kind or a hold, and the one writer of a total (`compute_ledger_apply`) fires on INSERT only.
   An administrator's idempotency key embeds the actor's number; it is kept, because rewriting a key would change the identity a replay is judged by.
   The sweep anonymizes a pool and an actor only when no job row still carries the account's number (so after the 7 years), no legal hold names the account, and nothing is open.
9. **The five open points of phase A5 for this phase.**
   (a) The two terminal repair lists, the orphan list and the cancel list ROTATE by the last time the list took the row (`examined_at`, and `cancel_attempted_at` for the cancel list), stamped before the step, so ten rows that cannot make progress no longer hold every slot.
   (b) A row has one orphan slot (`orphan_tapis_uuid`): a second orphan is logged (`orphan_slot_taken`) and the row flagged; the tenant sweep cancels any duplicate it lists, which is the net.
   (c) A terminal row whose Tapis record is gone (`not_found`), or has not been readable for a week, is settled without it (released unless something shows it ran, flagged `mismatch`). Where it charged the minimum, the observer's final settlement corrects it; where it released the hold, the observer has no `charge` entry to correct (its candidate query requires one), so a sacct row for that job stays matched but unapplied and only the `mismatch` flag records the use: it is flagged, not charged.
   (d) The cancel sweep is production-only; `advanceComputeJob` now carries out a recorded cancel for a job that has a Tapis job, so a staging Worker, where no cron runs, no longer leaves one for ever.
   (e) NOT CHANGED: the 30-minute tick equals the default `reservationWaitMinutes` (30), so a `created` job gets one retry before it times out.
   It is the owner's policy, not a code constant; a value of at least two ticks (60) gives it two.
10. **ACCESS reports in `failed`** are listed by their fixed word (`jobs access-reports`), counted in the daily sweep's log line (error level while any exist), and re-queued only by the owner, on the explicit statement that the report is CONFIRMED NOT recorded at ACCESS (`POST /admin/compute/access-reports/:jobId/requeue` with `confirmed_not_recorded: true`, and `--confirmed-not-recorded` on the command): an unknown outcome is never resent by code, so a person looked.
11. **Rules the review of the phase added.**
   (a) A `nemar_job:<id>` tag is trusted only on a job the NEMAR service identity owns; a stranger can write any tag, so a foreign job with one is a job that skipped the reservation.
   (b) The sweep's bound-uuid snapshot is read before the per-job reads, so a job a row owns by the time it is read is never flagged or cancelled, and a conflicting insert cancels only when the existing row is the sweep's own.
   (c) Only a 409 means a cancel is over; any other refusal is a failure, logged and asked again.
   (d) A followed unreserved row is closed with nothing charged (flagged `mismatch`) when Tapis no longer has the job, or when no read has found it for 7 days (`TENANT_GIVE_UP_DAYS`), counted from the last good read, so one transient error on an old row does not close it. This differs from phase A5's repair of a terminal row, which settles without the record (a release unless something shows the job ran) after 7 days from its end.
   (e) A stored `sacct` row is replaced by a later one while it is not applied and its state is not ended, and the state is the first word of what `sacct` printed.
   (f) A run whose rows could not be stored is given back (`issued`), and the same token may post again; a settlement that fails after the rows are stored does not fail the post.
   (g) A prefix bigger than one run's pages is `incomplete` and never reduces its row or marks its results reconciled; a capped stage counts the due rows it left (`backlog`) and logs at error level; a refusal is counted `locked` with its class kept, except a programming error (`TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`), which is a failed stage; a refusal more than a day past `retention_until` logs at error level.
   (h) Migration 0130 also pins a pool's `created_at` and `updated_at`.

Not verified: the order of Tapis's job list (`orderBy`), whether the tenant credential lists more than its own and shared jobs (the sweep finds what the service identity can list, and the fallback is the issue's: NEMAR is the only submitter), the text of R2's refusal of a locked key, and the observer's real export (no response of the real posting service was recorded; the bounds and shapes are the issue's).

## Owner decisions, 2026-11-06

The owner approved these five decisions of phase A7 (#2012) as they stand in the code.

1. **D1.** The unreserved usage entry is an `overrun` on the tenant pool, counted against the `people` budget.
2. **D2.** The observer-runs mint stays admin-level, as the issue says. Accepted risk: an administrator who mints a token can post a charged amount that settles a pool without owner authority.
3. **D3.** Migration 0130 keeps the account link (`compute_gateway_users.account_id`) and the `gw_` pseudonym for ever, and the migration 0115 triggers refuse change and delete. A deleted account's pools and ledger actors are anonymized (0130); the pseudonym mapping is not.
4. **D4.** `TENANT_GIVE_UP_DAYS` stays at 7 days; a followed unreserved row closes with nothing charged.
5. **D5.** The 30-minute tick stays equal to the default `reservationWaitMinutes` (30), so a `created` job gets one retry before `submit_timeout`.

## Amendment 2026-11-06: the Worker adopts the observer's document

The integration review of the compute epic found that the Worker and the real observer (`observer/observe.py` in `nemarOrg/nemar-process`) did not speak the same wire: the Worker read the header `X-Compute-Observer-Token` and a strict `{snapshots, sacct}` body of its own design, and the observer posts a `nemar.observation.v1` document with `Authorization: Bearer <token>`.
The owner decided that the Worker adopts the observer's document and the observer is not changed.
This amendment supersedes the wire described in item 4 of the amendment of 2026-11-05, and nothing else of it: the token, the one refusal, the 1 MiB and 5,000-row bounds, the single conditional UPDATE that spends the run, the settlement and the tolerance are as they were.

1. **The document is written once, as a JSON Schema, and shared byte for byte.**
   `shared/contract/compute-observation.schema.json` (draft 2020-12, every object the observer writes closed) is the same file as `observer/schema/observation-v1.schema.json` in nemar-process, the way the launch specification is shared.
   A zod schema in `shared/contract/compute-observation.ts` mirrors it, and `test/compute-observation-contract.unit.test.ts` holds the two to each other on a corpus of valid and invalid documents.
   The schema was derived from what the observer emits, and the two documents the observer itself wrote (`test/fixtures/compute-observation/`) are fixtures on both sides.
   Drift is checked on both sides: nemar-process compares its copies with nemar-cli's at a pinned commit (CI sets `NEMAR_REQUIRE_OBSERVATION_DRIFT=1` and checks the commit out), and nemar-cli compares with a nemar-process checkout when `NEMAR_PROCESS_OBSERVATION_DIR` names one (`NEMAR_REQUIRE_PROCESS_OBSERVATION_DRIFT=1` turns a missing checkout into a failure).
   `test.yml` checks out nemar-process's integration branch (public, sparse, no token) and sets both, so CI compares against that branch's HEAD, not a pinned commit; it does not check that nemar-process's own CI is green or that its pin is current (its advisory job says so).
   A change to the document is made in nemar-cli and copied, never edited in one copy.
2. **The token is `Authorization: Bearer <token>` only.**
   The header `X-Compute-Observer-Token` is not read; a post that carries it alone is the one refusal, like a wrong token.
   Nothing else about the token changed: the one-hour per-run `compute-observer` HMAC, constant-time comparison, identical refusals for a wrong, expired, reused, unknown and missing token, and never logged.
3. **The document is validated, then mapped to the stored rows by a table.**
   `services/compute-observation.ts` holds the table (partition queue figures to `compute_queue_snapshots`; each accounting job to a `compute_sacct_rows` row; `charged_milli` always NULL, so the rate table prices the allocation as it does for any row without a figure of its own).
   The CPU, memory, node and GPU figures are read from `alloc_tres` by one function, `parseAllocTres`, which fails closed: a value it cannot read refuses the post (400 `invalid_post`, the path and the fixed word `malformed_tres`, never the value), the run is not spent and nothing is stored.
   Memory is converted to megabytes with Slurm's powers of 1024 and rounded up; a number with no unit is refused unless it is 0.
   A row with elapsed time and no `cpu` item is refused (`missing_cpu`): an allocation that ran and is not on record would be priced at nothing, which is a guess.
   A row with elapsed time and no `node` item is refused the same way (`missing_node`): the settlement reads no node as one node, which is a guess too.
   A refusal lists at most five paths, and a key the sender chose (a partition, a state, a reason, an allocation item) is printed as `<key>`.
4. **What is skipped is counted, not refused.**
   A partition whose queue was not read (`jobs` is null) is not stored as zero; a row whose job id is not one Slurm job (a pending array `123_[1-5]`), whose partition, state or elapsed time the observer could not read, or whose value is past a column's bound is not a job NEMAR could have submitted as one Slurm job.
   Both are skipped and counted in `skipped` in the answer, so one array on the community account does not stop the rest of the day from settling.
   A `truncated` export says so in the answer (`truncated: true`).
   The rows it lost are NOT on a later export: `sacct -S day -E day+1` selects a job by the day it ran, so a job that began and ended inside the cut day is on no other export and stays at its provisional charge until an administrator moves it.
5. **A mode is never a dry run.** The observer defines `quick` and `daily`; both are live.
   A `quick` document has no `accounting` and no `sources.sacct` (the schema requires both for `daily`), so it stores the queue and settles whatever earlier rows can now be settled.
   Any other `mode`, and a `schema` word that is not exactly `nemar.observation.v1`, is refused like any malformed body.
6. **A decision for the owner to confirm: one unreadable row refuses the whole day.**
   An `alloc_tres` value that `parseAllocTres` cannot read, a row with elapsed time and no `cpu` item, and a row with elapsed time and no `node` item each refuse the entire post (400 `invalid_post`, the run not spent, nothing stored), not just the row.
   That is deliberate and fail closed: a charge that is guessed is a charge to a person's pool, and a post that settles part of a day hides that the rest was refused.
   The cost is that the same document is refused on every retry until the observer or the cluster's text changes, so one row can hold back a whole day of settlement.
   The alternative is to skip and count such a row as the unreadable-partition rows are; it is not taken here, and the owner is asked to confirm the choice.
7. **Open item for the observer-dispatch phase: the row cap and the byte cap differ.**
   The observer cuts its export by bytes only (1 MiB, from the end), and the Worker refuses more than 5,000 rows (partitions and accounting jobs together).
   A busy day of short rows can pass 5,000 jobs inside 1 MiB, and the document is then refused `too_big` on every retry, so that day never settles.
   The observer is not changed here; the dispatch phase has to choose between a row cap in the observer, a larger Worker bound, or accepting the refusal and re-reading the day in parts.
8. **Not verified.** The observer's formats were written from the Slurm manual and the public user guide, not captured from a cluster (nemar-process `docs/unverified.md`), so this schema describes what the observer emits and not what a cluster has been seen to print.
   A quick post is made every 15 minutes and a token is good for one post, so a token per quick run must be minted; that is the operator's procedure and is not decided here.

## Review fixes of 2026-11-06 (implementer A)

The three-reviewer review of the epic's pull request found money loops and silent failures in the compute services.
Each item below says what changed and what was decided; the owner decisions of 2026-11-06 are final.

1. **The Workers subrequest limit for the compute crons is 10,000, not the project's older 1,000.**
   The 1,000-subrequest model used elsewhere in this project is not the compute limit, and the compute crons are NOT restructured and get no shared operation budget.
   The first week's observability counts (the per-tick lines of the advance, cancellation, tenant, pipeline and ACCESS crons) should confirm the larger limit; a count that approaches it is a reason to reopen this, not to guess.
2. **An ACCESS report whose call never left the Worker is retried, not ended `outcome_unknown`.**
   A throw of `fetch` was classified as no answer, and no answer is never resent, so a call the runtime refused before it was made (the invocation's subrequest limit) lost its report for good.
   The runtime gives no code or class for that refusal, only its message, so `throwedBeforeSend` recognizes exactly that message (a closed list) and nothing else.
   A timeout, a reset, a refused or lost connection and every other throw stay unknown and are never resent: a runtime cannot tell them from a reset after the request left, and ACCESS is not known to ignore a duplicate.
   The conservative choice is therefore explicit: only a throw that proves nothing was sent is retried, through the ordinary retry (an attempt is spent, the delay applies, the bound still ends it, the word is `unavailable`), and the tick stops claiming after one, since every later row would meet the same limit.
3. **An observer run is spent before its rows are stored; the re-mint path is manual and is documented.**
   `CLAIM_RUN_SQL` spends the run, then the rows are stored; the run is reopened only when the store throws.
   A worker that is killed between the two leaves a run `ingested` with no rows, and the token is good for one post.
   The recovery is to mint a new run (`POST /admin/compute/observer-runs`) and post again; the stored rows are keyed by Slurm job id and the upsert is idempotent, so a repeated day is safe.
   Nothing is redesigned.
   A run left `ingested` with no stored rows is the signal to look for in the observer-runs listing; the listing is the reporting module's, and the count is not added here.
   The public runbook on docs.nemar.org should carry the same two sentences.
4. **A run that failed AFTER consuming units counts toward the pipeline's cooldown and cap.**
   `result_upload_failed` and `result_verification_failed` (the job ran, then its results could not be taken or checked), `tapis_record_lost`, and any `failed` job whose row was charged above 0, are no longer on the list of failures that are not the dataset's (`NON_DATASET_FAILURE_WORDS`): they count toward the 7-day cooldown and the 3-failure cap like a failure the dataset caused, so the queue no longer sends the same dataset again every day with nothing to stop it.
   A failure before any charge (staging, `tapis_submit_failed`, `submit_timeout`) stays an immediate candidate.
   The charge is read from the stamp's linked job row, in the same SQL that decides the candidates.
5. **The tenant sweep owes the ACCESS report for the jobs it indexes (decision 9).**
   A tenant job that skipped the reservation now gets its pseudonym copied from `compute_gateway_users` when its owner maps to an active account, and a report row in the same batch as the index row (and at its close, for a Slurm id that first shows then), by the statement the lifecycle uses.
   A job whose owner maps to no account has no pseudonym, so its report ends `failed` with `no_gateway_user` and the gap is visible; the partner contract still has to supply a pseudonym for account-less partner jobs.
6. **A cut-off tenant listing needs a person only when a live job could be hiding.**
   The listing is newest first and at most 5,000 jobs.
   A `live` pass raises `needsPerson` for a cut only when the last page it read still held a job that has not ended (`liveMayHide`); a tenant that has simply run more than 5,000 jobs no longer raises it for ever.
   A `week` pass still raises it on any cut, since a job of the week may be missing.
   The line carries `live_may_hide`.
7. **Retention reads the hold between the two prefixes.**
   Stage 1 deletes `records/<id>/` and then `logs/<id>/`.
   A hold placed after the first read and during the first delete now keeps the logs, because the hold is read again between the two; the reducing statement already guarded the row.
8. **A Tapis cancel that failed is counted, and loud while it persists.**
   `driveCancel` and `retryOrphanCancel` return an outcome (`ended`, `pending`, `failed`, `skipped`) instead of nothing.
   The cancel sweep counts `cancel_failed` (a count, never a job id or an account) and logs at error level when it is above 0, so a persistent failure is loud on every tick it persists, and a transient failure the next tick cures is one line.
   `cancel_pending_failed` counts live rows whose recorded cancel is still not carried out an hour after it was asked for (`countCancelPendingFailed`); the status view will carry it once the reporting changes that wire it are merged.
   An orphan's cancel (a Tapis job NEMAR made that no row owns) now clears the record only on a 409, on a 404 that a read of the job confirms, or on a refusal after which a read shows the job has ended (a finished job may be answered with a 400): a 400 or a 403 no longer clears an orphan that is still running (this is the tenant sweep's rule).
9. **A status Tapis reports that NEMAR does not know is treated as an unreadable record.**
   `unknown_status` refreshes nothing, so the row's last good read ages and the job is `unreported` after a day (it used to stay live and silent for ever); the tick counts it as `unknown_status` and logs the status word shortened to 32 characters and reduced to letters and underscores.
   It is not ended as lost: only a record that cannot be read at all is.
10. **A live job whose Tapis record is gone ends `failed` with `tapis_record_lost` (owner decision 1 of 2026-11-06, refined in review).**
    The word is a platform failure code (`PLATFORM_FAILURE_CODES`, so `isPlatformFailure` is true and the attribution follows).
    Only a read that answers 404 can end a job this way; a refused credential, a response that fails its schema and a Tapis that is down for a week each leave the job `unreported` and put an error line in the tick, because a record that is merely unreadable may still be running.
    Two things end it: a row whose last good read of Tapis is more than `UNREADABLE_GIVE_UP_DAYS` (7) days old and whose read answers 404 again; and a job with a cancel recorded whose cancel answers 404 AND whose read-back answers 404, when its last good read is more than a day old (so one wrong-tenant 404 cannot end a job at once).
    A job Tapis has ANSWERED since its last usable read is never lost: a status NEMAR does not know leaves `tapis_synced_at` alone, so the job goes `unreported` after a day as before, and is stored in `tapis_status` (an administrator sees the word), and the stored word that names no known status is what stops the lost-by-age rule.
    That is the clock chosen instead of a new column: no migration.
    What the lost job settles at depends on the row, because a job that ran is never released (a release closes the hold, the ledger then refuses a charge, and the observer corrects only a row that has a `charge` entry):
    - **evidence of a start** (`started_at` set by an earlier read): charged the time from that start to now, capped at the job's own time limit, through `provisionalCharge`, once, capped at the hold, excess to overrun as for any failed job that ran;
    - **other evidence of use** (the launcher's bytes or completed upload, a Slurm id, or the last reported state `running` or `archiving`): the contract's minimum is charged;
    - **no evidence of ever starting**: the hold is released with no charge, once, by the same release statement and gate as any release.
    In every case the row is flagged `mismatch`, leaves the live states (the account's live-job slot is free), and its Tapis uuid is recorded as the row's orphan, so a job that is in fact still running is cancelled by the existing orphan retry as soon as Tapis answers a cancel.
    A released job's later use is FLAGGED for an administrator, not reconciled: the observer cannot repair a released job and the tenant sweep skips a bound row (the repair path above says the same).
    A pipeline stamp that reads the row fails with the same word, which counts toward the pipeline's cooldown (item 4) because the job may have run.
    Recovery before 7 days is unchanged: a good read refreshes the clock.
11. **A copy of the launcher files abandoned after three days is counted.**
    `UNCOPIED_TERMINAL_SQL` stops listing a terminal row three days after it ended, and the failure used to be a log line.
    The tick now flags such a row `mismatch` where it is not flagged already, and reports `copy_abandoned` in its result and its line at error level: the rows that are abandoned whatever their flag (a lost record is born flagged and is abandoned all the same) whose window closed in the last 30 days, so the line is an error on every tick for a month and then stops.
    `countCopyAbandoned` is the running total with no age limit; the status view will carry it once the reporting changes that wire it are merged.
12. **The tick's line says what it did.**
    A tick where Tapis could not be read for a row is a `warn` line (it used to log nothing when nothing else happened); `unknown_status` and a repair that did not finish are `warn`; a failed step and an abandoned copy are `error`.
    `repaired` counts only a repair that finished what was owed (`repairTerminal` returns the real outcome); an attempt that left something owed is `repair_attempted`.
    The pipeline dispatch line adds `synced_later` and `synced_errored` (a sync that could not decide yet, and one that threw) when they are above 0.
13. **Tapis answers that are a proxy's, not Tapis's decision, are transient.**
    A 408 and any 3xx (a redirect is never followed) map to `unavailable`, not `rejected`.
    A submit that met a proxy's 302 or 408 ended the job for ever as `tapis_submit_failed`; it now stays `created` and the next tick looks the job up by its tag.
    400, 405 and 409 stay `rejected`.
14. **A fault reading the owner's policy on the outputs route is `policy_unavailable` (503), not `compute_disabled`.**
    `compute_disabled` says the platform is switched off, which a caller may take as final; the new word is a refusal code of its own with the same status and its own sentence.
    The launcher's reaction to an unknown 503 word is the launcher's (nemar-process) to confirm; the contract declares no retryable word of its own for this.
    `mintResultLinks` still answers `results_expired` for a declared file that is invalid or unreadable: no distinct word is declared for it, so it is left and noted here.
15. **Code that is declared and not wired is marked.**
    The `uploading` state has no writer, and `presignIncomingUploads`, `finalizeBundle` and `finalizeSubmittedFiles` have no caller: Epic D's partner contract wires them, and each now says so in a comment.
    `compute_jobs.legal_hold` is unused (always 0); the hold that counts is a row of `compute_legal_holds`, read by `heldSql`.
    The comment of migration 0115 that said the retention sweep honours the column was wrong and is corrected (comment only).
16. **`GET /admin/compute/pipeline/status` writes, and read-only maintenance mode lets it through.**
    The route syncs the pipeline stamps (`syncPipelineStamps`, a write that finishes stamps whose job ended) before it reads, because the status view must show the state of the jobs and not the state of the last cron.
    A GET that writes is an exception to the rule that read-only mode refuses writes; the middleware admits it because it is a GET.
    The write is the same, idempotent sync the cron makes, it touches only stamps and never a job, a hold or the ledger, and a repeated read changes nothing.
    The route header should say so in a sentence; it is added with the change that owns that route file.

## Amendment 2026-11-06 (#2022): compute access is requested, decided and ended (phase D1)

Migration `0131_compute_access.sql`, `shared/compute-access-state.ts`, `shared/contract/compute-access.ts`, `shared/contract/compute-terms.ts`, `backend/src/services/compute-access.ts`, `backend/src/routes/admin/compute-access.ts`, the request route in `backend/src/routes/users.ts`, `nemar compute request-access` and `nemar admin compute access` build the access half of the user-facing design (epic #2021).
"Item N" means the numbered item of THIS amendment.

1. **Compute access is a grant of its own.**
   `users.compute_access` is `none`, `requested`, `active`, `suspended`, `denied` or `revoked`; nothing in the request route, the decision routes, their service or the migration reads or writes `service_access`, and a source scan holds that (`compute-access-source-scan.test.ts`).
   Approval is an administrator's decision, never a form-completeness check (ADR 0042): there is no automatic grant.
   The edges are `shared/compute-access-state.ts`: none to requested; requested to active or denied; active to suspended or revoked; suspended to active or revoked; denied or revoked to active, by an administrator's grant only.
   `canUseCompute` is true for `active` and nothing else.
2. **A person asks once.**
   `POST /users/me/compute-access/request` answers 409 `already_active` for an active grant and 409 `access_closed` for a request that was answered (`denied`, `revoked`) and for `suspended` (access that was paused is not a request to repeat); an open request answers 200 and is re-mailed only while `compute_access_notified_at` is NULL (as ADR 0042 does for upload access).
   The conditional `UPDATE ... WHERE compute_access = 'none'` is what makes two concurrent requests open one: its `meta.changes` decides who mails.
   Mail is non-fatal and outside the write; the audit row `compute_access_requested` carries the shape (`via`, `why_chars`) and never the prose.
   The stamps are history and a decision never clears them (unlike the upload stamps, which a revocation clears): the open request is the state `requested`, not a stamp that is set.
3. **What a request must carry, in this order:** a purpose of 20 to 1000 characters (counted as the database counts them, in code points); the current terms version; a verified inbox; an ORCID iD **proven by an `oauth_identities` row** for provider `orcid` (not by `users.orcid_verified`, which an owner may set without a sign-in, ADR 0106; the `service` and `test` kinds are exempt, ADR 0048); and the profile gaps that stop compute access, all at once: given name, family name, affiliation, city and country.
   The gaps are the one matrix (`profileGapFields(account, "compute_access")`, ADR 0045), which gained the block `compute_access` and the field `affiliation`; an upload-access request asks for the block `upload_access` only, so its `missing` list did not change.
   The terms version is `COMPUTE_TERMS_VERSION` (`2026-11-draft`) and `COMPUTE_TERMS_PUBLISHED` is false: in the exact production environment a new request is 503 `terms_unpublished` until the owner publishes the terms, after an open request or an active grant has been answered as it is.
   Re-acceptance when the terms version changes is not designed.
4. **An administrator decides; each decision is one batch.**
   `GET /admin/compute/access` and `POST /admin/compute/access/{grant|deny|suspend|revoke}/:username` and `.../by-id/:id` (a web account has no username).
   The flip carries its from-states in the WHERE, the audit row is written only if the flip landed (`changes() > 0`), and every other statement is guarded on the state the flip leaves, so a decision that lost a race changes nothing and answers 409 `stale_state`.
   The reason (at most 500 characters) is on the audit row and is NOT sent to the person; the person is mailed after the commit, and a send that fails leaves the decision standing.
   The routes read no compute switch: they are bookkeeping and work with compute off.
5. **A grant opens the owner's default allocation, once.**
   For each pool word whose `defaultGrantMilli` in the policy in force is above zero, Epic A's grant statement (`GRANT_INSERT_SQL`, the same text with one term appended that the account is `active`) is written with reason `grant`, the administrator as actor and the key `compute_access_grant:<account id>:<pool>`, so a grant after a suspension adds nothing.
   A zero default grants nothing and the response says `policy_default_zero`; an unreadable policy fails closed (503, nothing written); further SU are an administrator's pool grant on request.
   The policy default is read at the grant, so a pool whose default was zero then and is raised later gets it at the next first grant of that word.
6. **The freeze has two causes and one bit, and only a grant lifts it.**
   A pool is frozen by the end of the account (A8 amendment, item 1) and by the end of compute (item 7).
   Item 3 of the A8 amendment asked Epic D to record the cause or derive the bit: it is derived from the access state.
   A grant unfreezes the account's pools (`UNFREEZE_POOLS_SQL`) and is refused (409 `account_not_in_good_standing`) unless the account is not deleted and has status `verified` or `approved`, in the flip itself as well as before the batch, so lifting a compute suspension can never lift the freeze an account revocation put on its pools.
   An account that was revoked and put back stays closed for compute until an administrator grants it.
7. **Suspending or revoking compute ends it in the same batch.**
   Both put `computeReleaseStatements(account)` (A8 item 2: live jobs record `account_ended`, a job that never reached Tapis is canceled with its hold released, every pool is frozen; no network call, the retried sweep cancels at Tapis) and `oidcEndStatements(account, "compute_suspended", { scopePrefix: "compute." })` (only the grants that carry a compute scope end, ADR 0119 rule 12) in the batch, each guarded on the state the flip leaves.
   `endComputeStatements` is the one function; it is the third caller of `computeReleaseStatements` (`COMPUTE_END_CALLERS`) and the seventh of `oidcEndStatements` (`OIDC_END_CALLERS`).
   A role demotion and an API key revocation still end none of it.
8. **The account's own end also ends compute access.**
   `finalizeRevocation` sets every state but `none` to `revoked` in its UPDATE (a `none` account stays `none`: nothing was asked, so nothing is closed); `tombstoneUserCascade`'s mask sets `revoked` for every state and erases `compute_purpose`, keeping the terms version and times.
   The generated test accounts' sweep (`sweepCiTestAccounts`) takes only accounts still at `none`, as it takes only accounts holding no upload grant.
9. **The wire carries the state, optionally.**
   `GET /users/me` and `GET /auth/me` (and every payload built by `publicUser`) report `compute_access`, `compute_access_requested_at` and `compute_access_granted_at`, optional and never defaulted (absence is "this API cannot say"); `compute_access_notified_at` is not on any wire, for the reason `upload_access_notified_at` is not.
   The admin user detail carries the state, the dates, the granter and the terms version; the purpose is read only in the compute access queue.
10. **A new mail category, `compute_requests`,** is opted in by default and production-only like every admin notification.
    The request mail links to the administrator's compute tab (`<APP_BASE_URL>/admin/compute`) and the decision mail to the person's compute page (`<APP_BASE_URL>/compute`); neither links to a file.
11. **A decision binds the state the administrator read.**
    The flip's WHERE carries the observed state (`compute_access = ?`) as well as the list of states the decision may start from, so a decision made on a stale read matches nothing and answers 409 `stale_state`: two administrators who both read `suspended` cannot have a grant land on the `revoked` the other made (which would reopen the account, unfreeze its pools, open the allocation and record the wrong `from` on the audit row).
12. **An administrator does not grant themselves compute access; an owner may.**
    The route answers 409 `self_decision` (and the grant flip says it again, so a caller that skipped the route writes nothing) when the target is the acting `admin`.
    Deny, suspend and revoke of oneself stay allowed: they only take access away.
13. **The request route takes the cookie Origin guard and refuses control characters.**
    A request made with a session cookie must carry a NEMAR Origin (403 `origin_not_allowed`), as every cookie write on the admin router does; a bearer key is not asked for one.
    A purpose with a control character other than newline and tab (NUL above all) is 400 `purpose_required`: SQLite's `length()` stops at the first NUL, so the column's CHECK would count the text short and the write would fail with a 500.
14. **A suspended account is not told its request was answered.**
    It gets the same code, `access_closed`, with its own words (`compute_access.suspended.body`: its access is paused); a denied or revoked account gets `compute_access.closed.body`.
    The message of each refusal is the shared copy, so the website, the CLI and the Worker say one thing.
15. **What submission must check (phase D3, #2024).**
    `canUseCompute(compute_access)` as well as `pool.frozen`.
    The freeze is a second line, not the first: a grant that lands inside `finalizeRevocation`'s two steps (the batch, then the UPDATE that sets `revoked`) can leave a revoked account's pools unfrozen, and a pool made after compute ended by a later `ensurePool` is born unfrozen.
    No D3 code exists yet, so this is a rule to build against, not a tested one.
16. **Recorded choices that are not obvious from the code.**
    - The tombstone mask sets `compute_access = 'revoked'` for an account that never asked, while `finalizeRevocation` leaves `none` alone: a deleted row holds no access and is never read again, so the difference is harmless.
    - `compute_purpose` is kept after a denial or a revocation until the tombstone erases it: it is read only in the administrators' queue (`GET /admin/compute/access`), never in an audit row (the audit carries the character count), a mail or an export.
    - If the stamp of `compute_access_notified_at` fails to write after a send landed, the next call re-sends: at most one duplicate administrator mail, accepted.
    - `unlinkOrcid` (and a relink) does not end compute standing: ORCID is proven at request time only, and a grantee who unlinks keeps access; revoking it is the administrator's act.
    The last is an open product question: if the owner wants compute to follow the proof, the caller to add is `unlinkOrcid`, with `endComputeStatements`.

## Amendment 2026-11-06 (#2023): the person's read routes and the partner's aggregate (phase D2)

`backend/src/routes/compute/{index,auth,read}.ts`, `backend/src/services/compute-user-reads.ts`, `compute-queue-estimates.ts`, `shared/contract/compute-user.ts`, migration `0132_compute_user_indexes.sql` and `nemar compute balance|limits|queue|list|status` build the read half of the user-facing design (epic #2021). "Item N" means the numbered item of THIS amendment. The credential rule is ADR 0119's amendment of the same date.

1. **The routes read and write nothing.** `GET /compute/me`, `/me/usage`, `/me/jobs`, `/me/jobs/:id` and `/stats` call Epic A's services (`accountPools`, `availableMilli`, `getPolicy`) and read the ledger and the job index. No statement of theirs moves a total, and none reads the compute switch (they work with compute off). The one exception is the refresh of item 7.
2. **A person's views are built from narrow column lists.** The job view is `USER_JOB_COLUMNS` and nothing else: no flag (`unreserved`, `unattributed`, `mismatch`, `overrun`), no `platform_failure`, no failure detail, no cancel reason, no Slurm or Tapis identifier, no gateway pseudonym, no hold figure, no client or Tapis owner, no digest, no identity and no purpose. A test pins the exact key list and walks the wire for each seeded value.
3. **A job that is not the caller's is not there.** Every statement carries `account_id` in its WHERE, so a stranger's id, an absent id and a malformed id are one answer, 404 `job_not_found`, which is also what a person's `cancel` and `links` say. A job the tenant sweep indexed (`flag_unreserved = 1`) is nobody's to read: it was a partner's job no reservation covered, charged to the partner's pool, and the person it was matched to was not charged.
4. **`GET /compute/me`.** `access` (state, `requested_at`, `granted_at`, the terms version the person accepted, `current_terms_version`, `terms_published`, and `requests_open`, which is false in the exact production environment while the terms are unpublished), `pools.cpu` and `pools.gpu` (granted, held, charged, available, in whole milli-SU; a pool nobody granted is zeros, which is true), `frozen` (any pool of the account is frozen), `limits` and `queue`. `limits.partitions` lists only the partitions the owner's policy offers to people, `limits.max_live_jobs` is `maxLiveJobsPerPerson` and `limits.results_days` is `retention.resultsDays`. The phase issue named `max_running` and `max_queued`: the owner's policy has one number for jobs created, queued or running together, so the wire has that one number and does not invent a split. An unreadable policy is 503 `policy_unavailable`; the default is never a stand-in for it. That the whole of `/compute/me` fails with the limits, and does not answer the balance without them, is a deliberate choice: a partner that showed a balance beside limits that might be the default would be showing a number the owner did not set, and the balance is one call away on the administrator's routes if an owner needs it while the policy is being repaired.
5. **Usage is the net charge from the ledger.** `GET /compute/me/usage?from=&to=&group=` sums `charged_delta_milli` of the entries that move a charge (`charge`, `overrun`, `adjust`, `refund`), over the account's pools, by day (UTC date of the entry), app, partition and source (the job's words). The window is `[from 00:00:00, to + 1 day 00:00:00)`, both days inclusive, at most 366 days (else 400 `invalid_range`), default the 30 days ending today; `group` is a comma list from the four words, each once (else 400 `invalid_group`), echoed in the fixed order; an absent `group` is one total row. A group whose entries sum to zero has no row, and a negative row is possible (a final settlement below the provisional charge). An administrator's correction names no job, so its group words are `null`; it is in the totals because it moved the pool's charged total, and every grouping therefore sums to the same figure, which equals the pool's charged total when the window covers the account's history.
6. **Queue estimates are the platform's, not a person's.** Per partition offered, the median and the 90th percentile by nearest rank of `remote_submitted_at` to `started_at` over the jobs that started in the last 7 days (newest 2,000), from every front door; fewer than 5 samples give `null` figures and the count. The even-count median is the lower middle sample. The rank rule and the cap are `compute-queue-estimates.ts`, pure and tested. `GET /compute/me` reads the partitions together (`Promise.all`) and reuses each partition's estimate for 30 seconds from the time it was read, in a best-effort cache kept per isolate and per database binding (at most 32 partitions, the oldest read forgotten first); a second isolate only means one more read, and the figure is a 7-day aggregate, so 30 seconds of age is below its resolution.
7. **A live job is refreshed on read, once, and a failure is said.** `GET /me/jobs/:id` calls `advanceComputeJob` only for a job that is not terminal AND has a Tapis job AND whose stored read (`tapis_synced_at`, else `submitted_at`, else `created_at`) is more than 60 seconds old; it never submits a `created` job (that would read the compute switch from a GET). Anything but a successful read-back and apply, an unconfigured Tapis, a Tapis error, a thrown error and the read-only maintenance mode included, serves the stored record with `stale: true`. The list does not refresh. Two bounds keep a Tapis that is down from being asked by every read: the ATTEMPT time of a job is remembered per isolate and per database binding (at most 1,000 jobs, the oldest attempt forgotten first) and a job is attempted at most once in 60 seconds whether the last try worked or not, and reads of one job that arrive together share one attempt. `tapis_synced_at` is not touched by this and keeps its meaning, the last GOOD read, because the lost-by-age clock runs on it. The exception to item 1 is real and wider than a stamp: a refresh from a GET runs `advanceComputeJob`, which can carry out a recorded cancel (`driveCancel`), settle the ledger (a job that ended is charged) and copy the launcher's files to the records bucket, as the webhook and the tick do. It does not report that the job became `finished` (`applyTapisJob`'s `becameFinished` is dropped by `advanceComputeJob`), so a "results are ready" notice cannot be sent from the read; a later notification phase must wire that where the transition is made.
8. **`GET /compute/stats` aggregates in SQL.** Rows `{ day, partition, source, charged_milli, jobs }` from the same ledger statement as item 5 over every entry that names a job (the partner pool's unreserved charges included); `active_people` is the count of distinct accounts that created a job in the window, leaving out NEMAR's pipelines (a service account) and swept jobs; `jobs_by_outcome` counts the jobs created in the window by terminal state, all three listed with zeros. The window and its limits are item 5's. The body has no account id, subject, name, email, pseudonym, Tapis owner or client, and a test walks the JSON for keys and values. No minimum cell size is applied (a count of 1 is served as 1): the route is machine-only and reached by one client credentials client, the figures are aggregates by day, partition and source, and the partner already sees the job records of its own people, so a threshold would hide nothing it does not hold and would make the figures disagree with its own. The three figures have different bases and are described as such in the schema: charge by the day of the ledger entry (pipelines and the partner's unreserved charges included), jobs created by their terminal state (every job, pipelines and swept jobs included), and people (the pipelines account and swept jobs excluded).
9. **Migration `0132_compute_user_indexes.sql`** exists because `EXPLAIN QUERY PLAN` (kept as `backend/test/compute-read-plans.test.ts`, on the real statements) showed scans Epic A's indexes did not cover: the queue estimate scanned `compute_jobs`, the partner's usage scanned the ledger, and the people and outcome counts scanned every job. It adds `compute_jobs_queue_started (partition, started_at)` (partial on the two scheduler stamps), `compute_jobs_created (created_at)` and `compute_ledger_created (created_at)`, and `compute_jobs_account_created_id (account_id, created_at, id)` for the list. A person's own usage and job read were already covered. The list was covered only up to a sort within each second: Epic A's `compute_jobs_account_created` ends in the row number, so ordering by the job id planned `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`; the index ending in the id plans `SEARCH ... USING INDEX compute_jobs_account_created_id (account_id=?)` with no sort, which `compute-read-plans.test.ts` holds.
10. **The list cursor** is `YYYY-MM-DDTHH:MM:SS|<job id>`, opaque to a reader: the last job's creation time and its id, with the id as the tie-breaker (the table's row number is not put on the wire). The order is `(created_at, id)`, a total order, so a job made between two pages is newer than the cursor and neither repeats nor makes the rest skip one, and rows created in the same second page without a gap.
11. **Deviations from the phase issue, recorded.** The job view has no `name` (the specification's name is in the records bucket, and the index row has no column for it; a later phase may add one) and carries `app_id` and `app_version` in its place; `limits` has `max_live_jobs` (item 4); `requests_open` is added to `access`; the pool figures keep the wire names `granted_milli`, `held_milli`, `charged_milli` and `available_milli` that the administrator's contract uses (`ComputePoolViewSchema`), not the `*_milli_su` names the phase issue wrote, so one reader serves both and the website phases transcribe the schema, not the issue; the CLI's person-side functions are `listMyComputeJobs` and `getMyComputeJob` because `listComputeJobs` is the administrator's.


## Amendment 2026-11-06 (#2024): a person submits a job, the server half (phase D3)

`backend/src/routes/compute/jobs.ts` (`registerComputeJobRoutes`), `backend/src/services/compute-submit.ts`, `compute-logs.ts`, `compute-uploads.ts`, `shared/contract/compute-bundle.ts` and `shared/contract/compute-submit.ts` build the Worker half of `nemar compute submit` (epic #2021). The command-line interface (CLI) half is phase D3b, built against those two contract files. "Item N" means the numbered item of THIS amendment.

1. **The routes.**
   `POST /compute/jobs`, `POST /compute/jobs/:id/finalize`, `GET /compute/jobs/:id/logs`, `GET /compute/jobs/:id/results` and `POST /compute/jobs/:id/results/renew` are new; the person's `POST /compute/jobs/:id/cancel` (phase A5) changed (item 10).
   The credential is a CLI key or the session cookie through `authMiddleware`; every write made with a cookie also passes `cookieOriginGuard`.
   An OpenID Connect access token is refused (its `nmo_` prefix): `compute.submit` is granted to no client yet, `oidc-token-allowlist.test.ts` walks every new path with the token, and `COMPUTE_OIDC_ROUTES` is unchanged.
   Every response is `Cache-Control: no-store`: an upload address and a results link are bearer secrets. The Worker's CORS allows the request header `Idempotency-Key` and exposes `X-Nemar-Truncated` and `Idempotent-Replayed` to a NEMAR page (the website's job page reads them). The person's cancel is not `no-store`: its answer holds no secret.
2. **The order of refusal of `POST /compute/jobs`** (the first failing check is the answer; a refusal writes nothing and returns no address):
   (1) compute access, `canUseCompute(users.compute_access)`: `no_compute_access` (never asked, asked, denied, revoked, a deleted account), `suspended`;
   (2) the `Idempotency-Key` header's shape (`invalid_spec`, field `Idempotency-Key`);
   (3) the body and the specification through the contract (`invalid_spec`, fields `spec.*`, `manifest.*` or `body`; a recipe is NEMAR's own and is `invalid_spec` on `spec.recipe`; a dataset version with no data-plane tag and a specification that does not fit the 64 KiB launch specification are `invalid_spec` too; a manifest without a bundle and a bundle without a manifest are `invalid_spec` on `manifest`);
   (4) a repeated key (item 4);
   (5) runtime and mode: `runtime_unavailable` for `matlab` and for a `python` job while `COMPUTE_RUNTIME_IMAGE` is not a valid pinned reference, `registry_not_allowed` for an image whose registry path the owner's `registries` list does not name (a list entry matches the image's path by whole segments: `ghcr.io/team` allows `ghcr.io/team/tool` and not `ghcr.io/teammate/tool`; the default list is empty, so no image runs until the owner lists a registry);
   (6) `partition_not_offered`, then `over_job_limit` (`jobCeilingRefusal`, the one rule `createJob` also applies);
   (7) `over_concurrency` (a read of the same live-job count the hold's guard uses);
   (8) the bundle: `invalid_spec` (shape, path, size, digest; `submittedPathProblem` refuses a traversal hidden in a percent-encoding), `bundle_too_many_files`, `bundle_too_large` (a file over the file cap, the running total over the total cap), `entry_not_in_bundle`, then the archive's own size (`bundle_too_large`);
   (9) the datasets, each in order, through `resolveRun`, the pipelines' own gate: `dataset_not_eligible` (one answer whether the dataset is private, anonymous, unpublished, withdrawn, tombstoned, a sandbox, a fixture, versionless or absent; which term failed is never told), `version_not_found` (404), `version_untagged`, `too_many_files` (more than 38,000 manifest entries);
   (10) the hold, `createJob`: `no_compute_access` or `suspended` again if access ended in between, `insufficient_balance`, `over_concurrency`, `platform_budget_exhausted`.
   Only after the hold commits is an upload address made (item 5). `compute-jobs-submit.test.ts` has one failing request per word and, for each adjacent pair, a request that fails both.
3. **Compute access is read in the hold's own statement (the D1 hand-off, item 15 of that amendment).**
   Step (1) is a read of the account; `createJob` is also given `requireActiveAccess`, which adds the guard `compute_access = 'active' AND deleted_at IS NULL` to the hold's WHERE beside the balance and the live-job limit, and on a refusal reads the account to say `no_compute_access` or `suspended` before any other word.
   The pools' freeze is the second line, not the first; the tests include pools funded and UNfrozen with access `revoked`, `suspended`, `denied` and `none`, and a request whose access ends after the route read it and before the hold.
   Dataset eligibility is the shared gate: `PERSON_EXCEPT_TERMS` sets aside exactly one term of the pipelines' list, `eeg`, because the modality is a property of NEMAR's own EEG recipes and not a privacy rule; a person may read a dataset of any modality, and every privacy and publication term holds.
   With the gate enforced on this route, the premise of decision 13 holds for a person's job too: a submitter cannot cause `dataset_not_found` or `manifest_too_large`, because the dataset was eligible when the job was submitted.
4. **Idempotency uses Epic A's record; no table is added.**
   Epic A already keys a person's job by `(account_id, idempotency_key)` (`compute_jobs_idempotency`, `JOB_BY_KEY_SQL`) and compares the specification's digest (`spec_digest`, the SHA-256 of the exact bytes of the validated specification): that is the scope `user:<id>` and the request hash.
   So migration `0133` is not used here.
   A key that finds a job is answered from that job and nothing in (5) to (9) is asked again, so a repeat does not depend on the dataset still being public: it is `201` with `Idempotent-Replayed: true`, `replayed: true`, the original `job_id`, the job's CURRENT state, and, while the job is still `uploading` with its records unwritten, a FRESH upload address (nothing is stored; an address is signed again).
   A repeat of a job that has moved on has no `upload`; the upload window is the job's own clock, counted from its creation, and is judged wherever it is asked: a repeat after the hour ends a still-`uploading` job on the spot as `upload_expired` (hold released) and is answered with that failed job and no address, whether or not the release has run; a repeat inside the hour gets a fresh address valid for one hour from now, which can outlast the window by up to the rest of the hour but is useless after it (a finalize past the window is refused, item 6). The person submits again with a new key.
   The request hash is canonical: `env`, the one record in a specification, is written in sorted name order before the specification is hashed and recorded (`canonicalJobSpec`), so the same environment in another order is a replay; every other object has the schema's fixed key order.
   The same key with another specification (any field, the `name` included) is `422 idempotency_conflict` and writes nothing. The key is 8 to 128 characters of letters, digits and `. _ : -`.
   The partner contract (phase D4) has no account to key by and adds its own table with the scope `client:<id>`.
5. **The upload address.**
   For a job with a bundle the answer is `201 { job_id, state: "uploading", tag, name, upload }`, where `upload` is `{ url, method: "PUT", headers, expires_at, size }`.
   The CLI sends `PUT url` with exactly `headers` (the signed `x-amz-checksum-sha256`, the archive's SHA-256 in base64) and `Content-Length: size`, the archive's bytes as the body.
   The key is fixed by the Worker, `incoming/<id>/bundle.tar.gz` in the records bucket, never one a person names; the address works until `expires_at` (one hour, `COMPUTE_UPLOAD_SECONDS`) and for that one object; it is issued only after the hold has committed (`presignIncomingUploads` reads the job's row, which exists only with its hold) and only to the job's owner.
   The archive's LENGTH is signed into the address as `content-length` (aws4fetch leaves it out of a signature unless every header is asked for, so the signer asks), and is not handed back in `headers`: the client sets `Content-Length` itself, which a browser must. A store that checks the signature of a signed header then refuses a body of another length. Not verified against the real store: whether R2 enforces the signed checksum header or the signed `content-length` on a presigned PUT (the stand-in does both); so the declared size is ALSO enforced at finalize by the binding's HEAD (item 6). A longer or shorter object is `bundle_incomplete` and is never copied; a LARGER one is deleted (it can only be wrong or hostile), a shorter one is left because the person may still be uploading. The bucket's own rule empties `incoming/` after two days. OPEN: there is no cap on the bytes a person may hold in `incoming/` at once (each address is bound to one object of the declared size, at most `bundleLimits.maxTotalBytes`, and the number of live uploads is bounded by `maxLiveJobsPerPerson`); a per-person incoming byte cap is not designed.
   A bundle job is BORN `uploading`: the state is written by the job's own INSERT in the hold's batch (`bornUploading`), so no window exists in which a bundle job is `created` with a hold and no owner for its release, and the release needs no `created` case. A job whose records could not be written after the hold answers `503 storage_unavailable` WITH `job_id` and a note that a repeat of the `Idempotency-Key` finishes it (the key stays optional; without one the job ends by the window).
   A job without a bundle (an image job) is submitted at once and answers `state: "submitted"`, or `state: "created"` when it could not be sent just now (compute off, Tapis unreachable); the 30-minute backstop submits it.
   `tag` is the Tapis tag `nemar_job:<id>`.
6. **Finalize.**
   `POST /compute/jobs/:id/finalize`, owner only, with the manifest (`{ files: [{ path, size, sha256 }] }`, the same document as `bundle-manifest.json`) as the body.
   In order: a finalize that arrives after the upload window (an hour from the job's creation) ends the job on the spot as `upload_expired` with the hold released and is `409 upload_expired`, whether or not the release has run; a job past the upload is returned unchanged (`200`, `replayed: true`, no body asked); a failed or cancelled job is `409 upload_expired` (the release failed it) or `409 bad_state`; a job with a recorded cancel is `409 bad_state`; the manifest is judged (the owner's limits and the job's `entry`; the same words as submit); then the object is looked at with the binding's HEAD: absent or not exactly the declared size is `409 bundle_incomplete` and NOTHING is copied; then `finalizeBundle` copies `incoming/<id>/bundle.tar.gz` to `records/<id>/submitted/bundle.tar.gz` (after reading the job's row, so after the hold; the copy is IDEMPOTENT, not guaranteed single: a sequential second finalize copies nothing, and two finalizes racing may each ask for the same copy of the same bytes to the same key, which leaves one archive) and writes `records/<id>/bundle-manifest.json`, which now carries each file's `sha256` as the packer gave it; the record is written once, and of two racing finalizes with different manifests exactly one is recorded and the other is `409 bad_state`; then the job is submitted once (the submitter's lease and the tag search).
   The answer is `200 { job_id, state, name, submitted, replayed }`; `submitted` is false when the records are written and the job waits for the backstop (compute off), in which case `state` is still `uploading`.
   The manifest is sent at finalize and not kept from submit because the Worker keeps nothing of the request but the specification (`spec.json`, whose `bundle {size, sha256}` binds the archive); it is checked against the same caps both times. The per-file digests are the packer's claim and are recorded, never re-checked; the ARCHIVE's digest is the SHA-256 of the archive file itself and the launcher verifies it on the node, so the Worker never hashes bytes.
7. **Release of abandoned uploads, and the two clocks.**
   There are two clocks and they do not overlap. BEFORE a finalize the only clock is the upload window, one hour from the job's creation (`COMPUTE_UPLOAD_WINDOW_SECONDS`); AFTER it the clock is the owner's reservation wait (30 minutes by default), measured from the finalize (`records_written_at`), not from the creation. So a finalize at minute 45 is a success, never a `submit_timeout` (a platform failure); a finalize at minute 61 is `upload_expired`.
   `runUploadExpiryCron` (production only, on the 30-minute tick, NOT in `DEV_CRON_ALLOWLIST`, self-fenced, no switch read, ten rows a tick in rotation by the last examination, one log line of counts) fails a job that has been `uploading` with its records unwritten for over an hour: failure code `upload_expired`, the hold released, nothing charged, `platform_failure` 0. The window is also judged on the spot where it is asked (a repeat of the key, a finalize), so it does not depend on the cadence of the tick.
   `upload_expired` is the first member of `SUBMITTER_FAILURE_CODES`: the submitter's, not the platform's. The release leaves alone a job with a Tapis job, a recorded cancel, a partner's job, and a job whose upload was finalized and that waits to be submitted; the statement that ends the job binds `records_written_at IS NULL` itself, so a release working from a stale row loses to a finalize that wrote the records in between.
   Two changes keep the backstop from doing the release's job: `CREATED_ROWS_SQL` no longer lists an `uploading` row with unwritten records, and `submitComputeJob` refuses such a row as `records_not_written` however old it is. A finalized job past the reservation wait (counted from the finalize) fails `submit_timeout` as any job does.
   While compute is off, and while uploads are abandoned, held units occupy the shared `people` budget pool until the window or the wait ends (an hour for an abandoned upload, the reservation wait for a finalized job that cannot be sent); the occupation is bounded by the per-person live-job limit and the per-job ceilings, and is released with no charge.
8. **The compute switch is not read here.**
   Only `submitLeased` reads it (`compute-source-scan.test.ts` holds that). A submission made with compute off takes its hold, answers `201` (`uploading`, or `created` for an image job), and waits; past the reservation wait the backstop fails it `submit_timeout` with the hold released. The log, results, finalize and cancel work with compute off. A test runs each.
9. **The words.**
   New refusal words and statuses (`COMPUTE_REFUSAL_STATUS`): `version_not_found` 404, `version_untagged` 422, `too_many_files` 422, `entry_not_in_bundle` 422, `bundle_incomplete` 409, `idempotency_conflict` 422, `logs_not_available` 404, `upload_expired` 409, `storage_unavailable` 503 (storage or Tapis could not be reached just now). `version_not_found`, `version_untagged` and `too_many_files` moved from the pipelines' own list to the shared one, with the same statuses.
   The issue's `image_digest_required` is not a word (a tag-only image is `invalid_spec` on `spec.image`) and `image_not_allowed` is `registry_not_allowed`, as the driver's amendment of 2026-11-04 says.
   The sentences are `COMPUTE_SUBMIT_SENTENCES`; `insufficient_balance` says the balance is used up and to contact an administrator, and promises no refund.
10. **Cancel, logs, results.**
    Cancel of a job that had finished or failed is `200 { ok, state, outcome: "already_ended", cancelled: false }` (it was a 409 `bad_state`); every other cancel answer gained `cancelled: true`.
    The log is `GET .../logs`: `text/plain` of the FIRST 1 MiB of `tapisjob.out`, `X-Nemar-Truncated: true` when cut, from the records copy once the job's files were copied (read by range) and from Tapis before; `404 logs_not_available` before the job started or when it wrote none; `503 storage_unavailable` when Tapis cannot be reached. The bytes are the job's, returned as they are, and no line of them is ever logged.
    Results are `GET .../results` (and `POST .../results/renew`, the same links made again): `{ expires_at, files: [{ path, size, sha256, url }], total, truncated, next_after, bearer_links: true, notice }`, at most 1,000 files, paged by `?after=<last path>`. The links are seven-day presigned GETs and BEARER links: anyone who holds one can download that file until it expires, and the response says so. `renew` is owner-only and, like the results themselves, needs no compute access (a person can always fetch what they were given); `409 bad_state` for a job that is not finished and verified; `410 results_expired` once the owner's `retention.resultsDays` (30 by default, never under 14) has passed since the job ended, whether or not the bucket's own rule has removed the objects, and once the objects are gone.
11. **Revocation.**
    No new path ends a credential, so the caller counts are unchanged. A presigned address or a results link outlives the key that was used to ask for it, until its own expiry (one hour, seven days); this is the same bearer-link property as phase A5's `links` and the terms say so. An account that ends has its live jobs cancelled and its pools frozen (decision 9), and a finalize of such a job is `bad_state`.
12. **Deviations from the phase issue, recorded.**
    The job `name` is part of the specification (`JobSpecSchema.name`, recorded in `spec.json` and echoed by the answers) and not a column; the user job view is unchanged.
    The idempotency table of the issue is not added (item 4). The caps are the owner's `bundleLimits` (default equal to `compute-bundle.ts`, held by a test); a CLI released before the owner raises them keeps refusing at the constants, which is the safe direction.
    The issue's `results` has a cursor the issue did not mention, because a job may hold 5,000 outputs.
    Not verified: that R2 enforces the signed checksum on a presigned PUT; the Tapis output download's behavior on a large `tapisjob.out`; every Tapis shape (from the published specifications, as phase A4 says).


## Amendment 2026-11-07 (#2024): a person submits a job, the command-line half (phase D3b)

`nemar compute submit|logs|results|cancel` (`src/commands/compute-submit.ts`, `compute-jobs.ts`; the library is `src/lib/compute/`) is the client of the routes of the amendment of 2026-11-06. "Item N" means the numbered item of THIS amendment.

1. **Exit codes.**
   0 done (submitted; with `--wait`, finished), 1 NEMAR refused or could not answer, the job failed or was canceled, or the person is not signed in, 2 refused on this machine before any job data was sent, 3 `--wait` ended with the job still live (Ctrl-C, or NEMAR could not be reached five times running).
   Every failure sentence is on standard error; `--json` standard output is only the answer (the finalize answer, or the submit answer of an image job, or with `--wait` the last read of the job; for `--dry-run` the request that would be sent; for `results` every page of files in one document; for `logs` `{ job_id, truncated, text }`).
   Each command's help has an "Exit codes:" block.
2. **What a job asks for.**
   The parser of the inline header is `shared/compute-header.ts` (phase A1), not a second one on `Bun.TOML.parse`: one subset of TOML, read the same way by the CLI, the Worker and the tests.
   `src/lib/compute/header.ts` finds the block (`# /// nemar` in a `.py`, `% /// nemar` in a `.m`, a folder's `nemar-job.toml`), turns every parser error into `file:line: sentence` (the sentence never quotes the line), reads `--mem` and `--time` with the header's own conversions, and merges key by key: FLAGS, then the script's HEADER, then the folder FILE, then the DEFAULTS (partition `shared`, 1 node, 1 core, no GPU, 1 hour), a list (`datasets`, `args`) replaced whole.
   `env` and `image` are flags only (they are not header keys).
   A dataset needs its version (`nm000104@1.0.2`): the A1 header allows an id alone "for the CLI to resolve", and the CLI does not, because a job recorded against `latest` cannot be run again on the same data and `--dry-run` must work offline.
   `--image` must be `docker://<registry>/<repo>@sha256:<64 hex>`; a tag is refused locally; the owner's registry list is the Worker's (`registry_not_allowed`).
3. **The bundle.**
   One deterministic `bundle.tar.gz` (ustar regular files and folders only, sorted by UTF-8 bytes, owner, group and times zero, mode 0644 or 0755 so the executable bit survives, gzip through `Bun.gzipSync` at level 9 with the header's time and operating-system bytes fixed); the same input is the same bytes whatever the clock or the folder's name, and Python 3.9's `tarfile` reads it back (the test does).
   Left out and counted: `.git`, caches, virtual environments, `node_modules`, editor droppings, `.pyc`, symlinks and special files (never followed: the launcher refuses a link), anything a `.nemarignore` names (a subset of gitignore; a bad line is an error naming it), and any file over the per-file cap (listed, with the advice to put data in a dataset).
   Every number is `shared/contract/compute-bundle.ts` and the rule is its `checkBundleManifest`, applied to the files found before a byte is read and again to the real digests; `compute-pack-worker.test.ts` sends the same bundles to the real route and demands the same word at the same boundary.
   A path ustar cannot hold (one segment over 100 bytes after the prefix split) is refused by name; a percent-encoded traversal is refused as the records bucket refuses it.
4. **The credential scan** (`secret-scan.ts`) reads the exact bytes that are packed, and the name, the arguments and the environment values, before any request, with no override.
   Its rules are `private_key_block`, `aws_access_key_id`, `aws_secret_access_key`, `google_api_key`, `azure_storage_key`, `github_token`, `gitlab_token`, `huggingface_token`, `slack_token`, `nemar_api_key` (`nm_` and 43 base64url characters, held by a test to `generateApiKey`), `nemar_oidc_token` (the prefixes of `shared/oidc.ts`) and `credential_file_name` (`.env` but not `.env.example`, `.netrc`, `id_rsa`, `*.pem`, `*.key`, `.aws/credentials` and the like).
   A finding is a rule name and `path:line`; the value, the matching text and the line are never in a finding, a message or a file.
   A file is read as Latin-1, as UTF-16 (a byte-order mark, or mostly NUL bytes) and with its NUL bytes removed. Not caught, and said so in the help: a token wrapped across lines or assembled by the program, one inside an archive or an encrypted file, and a bare 40-character AWS secret with no field name near it. It is a net, not proof.
   "Nothing was sent" is not claimed: a refusal means no job data left the machine; the optional notice poll and the update check can still run.
5. **The upload.**
   `PUT upload.url` with exactly `upload.headers` and `Content-Length: upload.size`, no NEMAR credential, three retries on a 5xx or no answer (1, 2 and 4 seconds), no retry on a 4xx, a 403 is "expired or refused"; an address already past its time is not used.
   The address and the signed headers are never printed or logged (the debug log's presigned-parameter redaction covers a result link as well; a test reads the real log).
   The `Idempotency-Key` is one random UUID per run, kept across the run's own retries of `POST /compute/jobs` (a 503 `storage_unavailable` after the hold is retried with the same key and finishes the one job) and `finalize`.
   A late finalize is the Worker's `upload_expired` sentence and exit 1; the person submits again (a new run, a new key).
   Running `submit` again is a SECOND job and a second hold: each run has its own key, an interrupted run is not resumed, and a job left waiting for its bundle ends by itself after the hour (or sooner with `cancel`). Only a 503 after the hold is finished by repeating the same key, which the command does itself.
6. **`--wait`** (`wait.ts`) polls `GET /compute/me/jobs/:id` at once and then every 5 seconds, growing by half to 30 while nothing changes, starting over on a change; five consecutive 5xx or network failures end it (exit 3); a 4xx ends it at once (exit 1).
   A 429 is a failed read like a 5xx (its `Retry-After` is waited out, capped at 2 minutes), not a refusal. Each read has a 20-second timeout and the abort signal, so a hung connection cannot ignore Ctrl-C. The wait has a CEILING: the job's own `minutes` from the job view plus 30 minutes (48 hours and 30 minutes before the first read); past it the wait ends with exit 3 and a message, the job untouched.
   Ctrl-C removes its listener, stops waiting and exits 3; a second Ctrl-C while that is being carried out exits at once with 3. It does not cancel, and the module has no way to.
7. **Results.**
   The listing prints no link; `--download <dir>` fetches each file with NO NEMAR credential, checks its size and SHA-256 against the Worker's record, writes through `<file>.part` and deletes a file that does not match (exit 1); a path that is absolute or contains `..` is refused whatever the Worker sent; a file already there with the same size and checksum is left alone.
   `--json` prints the links because it was asked to.
   A file that exists and DIFFERS is not overwritten unless `--force`. Nothing is written outside the folder: the deepest existing folder of each destination must resolve inside it (through symbolic links), and a destination or `.part` that is a link or a folder is a per-file failure that is left alone. Every per-file failure is a `FAILED` line with a fixed reason (never the system's text or the link), a `.part` the call made is deleted on any failure, and two results whose names differ only in case or Unicode form are not both written. A link must be `https:` (loopback `http:` only), is fetched with no redirect, a connect time, a stall time and never more than the recorded bytes. The upload address follows the same rules (https, no redirect) and is not refused by the local clock until it is 5 minutes past its time.
8. **Deviations from the phase issue, recorded.**
   The header parser is the shared one (item 2); a dataset needs its version (item 2); `--dry-run --json` prints the request, not "the Worker's answer", because there is none; `logs --json` wraps the text because the answer is not JSON; `cancel` of an ended job exits 0 (the Worker's 200); `cancel` asks for confirmation on a terminal and needs `--yes` with `--json` or without one; the job ids of `logs`, `results` and `cancel` are checked locally (exit 2, where `status` of phase D2 exits 1).
   Not verified: a real R2 PUT of an archive (the S3 interface is a stand-in built from the specification); a real SIGINT on a terminal (the test sends the signal to the process); Windows paths.

## Amendment 2026-11-07 (#2025): the partner contract, holds, reports, release, the reaper and the move of a charge (phase D4)

Migration `0134_compute_partner.sql`, `backend/src/routes/compute/partner.ts`, `backend/src/services/compute-partner.ts`, `compute-report-verify.ts`, `compute-hold-reaper.ts`, `shared/contract/compute-partner.ts` and `compute-partner-request.ts`, the `moveCharge` operation of `compute-ledger.ts` and `nemar admin compute move-charge` build the partner half of the epic (#2021).
"Item N" means the numbered item of THIS amendment.
The partner (`compute.nemar.org`, run by another institution) is treated as potentially hostile or compromised: it can mint a Tapis token for any username, so a Tapis job's `owner` and its tag prove nothing alone.
Only the bound Tapis uuid and NEMAR's own read of that job prove what ran.

1. **Three routes, one credential.**
   `POST /compute/holds`, `POST /compute/jobs/:id/report` and `DELETE /compute/holds/:id` accept ONE credential: an access token for a person carrying `compute.reserve`, through `oidcBearer` (the amendment of ADR 0119 of the same date lists the refusal words and the audience decision).
   The person is the token's account and the client is the token's client; a reservation is the person's AND the client's, and any job that is not both is `job_not_found`, the same answer as an absent one, on every route.
   Every write needs an `Idempotency-Key` (`^[A-Za-z0-9._:-]{1,64}$`, else 400 `idempotency_key_required`).
2. **Migration 0134 writes only what was absent.**
   Read first and found: the unique index on the bound Tapis uuid exists (`compute_jobs.tapis_uuid TEXT UNIQUE`, 0115), as do the orphan slot, the rotation stamp (`examined_at`), the cancel intent and reason and the four flags; the client's caps exist twice (item 4).
   It adds the table `compute_idempotency_keys (scope, key, request_hash, job_id, created_at)` with the primary key `(scope, key)`, the scope `client:<public client id>`; three columns of `compute_jobs` (`partner_state`: NULL for a reservation, `pending`, `verified`, `mismatch`; `partner_flag`: a fixed word; `partner_verified_at`); and three partial indexes (the client's live jobs, the open reservations, the unverified rows).
   Epic A keys a PERSON's job by `(account_id, idempotency_key)` and compares `spec_digest`; that path is not retrofitted, and a partner's keys never meet a person's.
3. **A reservation is one conditional insert.**
   `createJob` takes a partner's job as its hold body BYTE FOR BYTE (the exact text is `spec.json`, its digest `spec_digest`), for a person's account.
   The hold's own WHERE carries the person's compute access (`requireActiveAccess`), the person's live-job limit, the client's open-reservation cap, the client's UTC-day cap and the balances; the idempotency claim is the batch's last statement, gated on the hold, so two requests with one key make one hold and a request that loses a race writes nothing.
   `HoldGuard` could take the client predicates as it stood, so no second hold path was added: `PartnerJobInput` gained `caps`, `idempotency` and `requireActiveAccess`, and the refusal is classified AFTER the insert (`over_concurrency` before `client_cap_reached`, the order the contract states).
   The order of refusal of `POST /compute/holds`: the person's access (`no_compute_access` for none, requested, denied, revoked and a deleted account; `suspended`), the body (`invalid_spec` naming the field), a repeated key (the original reservation, or `idempotency_conflict`), the owner's ceilings (`partition_not_offered`, `over_job_limit`), the person's live jobs (`over_concurrency`), then the hold (`no_compute_access` or `suspended` again if access ended in between, `insufficient_balance`, `platform_budget_exhausted`, `over_concurrency`, `client_cap_reached`).
   The answer is 201 `{ job_id, hold_id, tag, expires_at }`; `hold_id` is `hold_` and the job's 24 hex digits (never a row number, so it is no oracle), and `expires_at` is the creation plus the owner's `reservationWaitMinutes`.
4. **The client's caps: the owner's policy first, closed by default.**
   The client's record has `cap_open_reservations` and `cap_su_per_day` (NULL means "none set yet", ADR 0119 rule 8) and the owner's policy has `clients[<client id>] = { maxOpenReservations, maxReservedMilliPerDay }`.
   The policy is the source (strict, versioned, audited, set with `nemar admin compute policy set`): a client the policy does not list has NO reservations (`client_cap_reached`), as the policy's other defaults are closed; the client's own record is a second ceiling when it is set, and the smaller of the two stands.
   Open reservations count the client's live partner jobs (running ones included); the day's SU counts every hold taken since UTC midnight, a released one included, so reserving and releasing in a loop does not dodge it.
   No new column or admin command: there are no defaults in code, and zero is what an unlisted client gets.
5. **A report binds, then NEMAR reads the job back (`reportJob`).**
   The job must be the caller's (404 otherwise); then the key (`idempotency_conflict`); a reservation that was refused before is `report_mismatch` again (and the cancel is asked again); an unbound one that ended is `hold_released`, one the person cancelled is `hold_cancelled`, and one whose person's compute ended is `suspended` or `no_compute_access`.
   The declared files are judged first and whole (item 8).
   A bound uuid is a repeat (replay) or `already_bound` (409).
   For a new uuid NEMAR reads the Tapis job (one attempt, 8 seconds): a job Tapis does not have is `tapis_job_not_found` (422) and binds nothing; a job that is NEMAR's own (owned by the NEMAR service identity, or naming another NEMAR job in its tags) or that another row holds as its job or its orphan is `tapis_job_in_use` (409), and is never bound or cancelled on a partner's word; a Tapis that cannot be read binds the row `pending` and answers 202.
   The bind is one conditional UPDATE (a reservation that is `created`, unbound, not cancelled, whose person's compute is `active` in the same statement), with the unique index behind it for a race the pre-check cannot close.
6. **Verification (`checkReport`).**
   The record's owner is the person's Tapis username (`tapisUsernameForSub`: the OIDC `sub` itself, the identity transform; the day the partner names a fixed reversible transform, that one function learns it), the application and its version are the reservation's, the queue is the reservation's partition, the nodes, the cores per node, the minutes and (when the hold named one) the memory do not exceed the hold's, and the record's resources priced for every minute it may run (`suMilliFor`) do not exceed the hold.
   A figure the record does not carry cannot be shown within the hold, so it fails.
   The GPUs are not on the job record, so a GPU count is NOT checked; the price uses the hold's GPUs.
   A match is ONE batch (`pending` to `verified`, the job `submitted`, the ACCESS report owed when a Slurm id shows), after which NEMAR's webhook is subscribed (a Tapis call is never inside a batch); the ordinary lifecycle follows the job from there.
   Until then NOTHING is charged beyond the hold, and no generic path reads, cancels or settles the row (`isUnverifiedPartnerJob` is checked in `advanceComputeJob`, `driveCancel`, `applyTapisJob` and the lists of the tick and of the cancel sweep).
7. **A mismatch is refused, cancelled, flagged and charged to the partner, never to the person.**
   The batch records the intent only (`partner_state = mismatch`, the flag word `owner_mismatch`, `app_mismatch` or `resources_mismatch`, the job flagged `mismatch`, the cancel intent, one audit row `compute.partner.mismatch` of fixed words); the Tapis cancel and the ending are `finishMismatch`'s, run at once and retried by the tick until a read shows the job over.
   A job the record shows is NEMAR's own is never cancelled; one whose record is gone is settled by the row's own evidence (`partnerLostSettlement`), and a job that cannot be shown not to have run is never released with no charge (the `tapis_record_lost` rule).
   The end is ONE batch (`commitPartnerMismatchEnd`): the terminal transition (`cancelled`), the person's hold RELEASED in full, what ran priced by `provisionalCharge` over the record's actual resources as an `overrun` of the partner pool `tenant` (`unreservedChargeStatements`, counted against the `people` budget once), the settled stamp, and the row's pseudonym cleared and its `charged_milli` set to 0.
   The phase issue said to price what ran "with Epic A's settle function" and write an `overrun` entry; `settleStatements` charges the hold's pool, which is the person's, and the epic's own acceptance criterion and decision 5 say no path charges a person for a job NEMAR has not verified.
   The entry is therefore the unreserved overrun of the partner pool, once per job (`job:<id>:unreserved`), and the formula is `provisionalCharge`, unchanged.
8. **A partner's files enter `records/` only after the match.**
   A report's `files` (`{ path, size, sha256 }`, at most 500, the owner's file and total limits, the path rule in any encoding) are judged before anything is bound and refused whole.
   A verified job is given the copy if every declared file is in `incoming/<id>/` at its declared size, else upload addresses (the declared length is signed); a job NEMAR could not read back yet is given addresses and nothing is copied; a refused job gets neither.
   The same report again, once uploaded, copies each file once (`finalizeSubmittedFiles`, wired now: its gate is `partner_state = verified`, in the function itself, because a copy into the locked records cannot be undone) and writes the manifest.
   `presignIncomingUploads` serves a partner's live job in any state and signs the declared length.
9. **Release, a person's cancel, the cascade (the open points (a) to (d) of the A8 amendment).**
   `DELETE /compute/holds/:id` ends a reservation with no Tapis job through the lifecycle's own release (the job `cancelled`, reason `partner_release`, the ledger reason `released`); a repeat is 200; a reservation a Tapis job is bound to (in any state of the verification, or ended) is `hold_bound`.
   The release statement binds "no Tapis job" itself, so a report that bound one in the meantime wins; a release makes no Tapis call.
   (a) The reaper expires an unlaunched reservation (item 10).
   (b) A person's cancel of a reservation still records the intent and leaves the hold open; the reaper resolves it at any age (a Tapis job found under the tag of a cancelled reservation is refused, `hold_ended`), and a report on it is `hold_cancelled`.
   (c) The cascade still fails open on an unbound reservation, and the fail-closed is at the report (a late report of a person whose compute ended is refused, and the token itself ends with the compute grant) and in the reaper and the sweep (a job found under the reservation of a person whose compute ended is refused, `hold_ended`, and charged to the partner).
   (d) A stuck reservation is listed by `nemar admin compute jobs list --state created`, and a refused or ambiguous one by `--flag mismatch`; the job view carries `partner_state` and `partner_flag`.
10. **The hold reaper (`reapExpiredHolds`, the 30-minute tick, production only, not in `DEV_CRON_ALLOWLIST`, reads no switch).**
    Twenty-five rows of each of three lists a tick, in rotation by `examined_at`, stamped before the step.
    Reservations past the owner's wait (or with a cancel recorded) are looked up in Tapis BY THEIR TAG first: no Tapis job that no row accounts for, affirmatively (the search succeeded), releases the hold with the ledger reason `expired` (job `cancelled`, reason `hold_expired`); one is bound and verified like a report, or refused when it is another owner's, the reservation was cancelled or the person's compute ended; several are flagged `ambiguous_tag` and the hold is KEPT (the tenant sweep then accounts for the jobs that skipped the reservation, and the next tick releases); ANY Tapis error keeps the hold, records `tapis_unreachable` and retries.
    NOTHING IS EVER RELEASED ON AN ERROR, and a Tapis call is never inside a batch.
    The same tick verifies `pending` rows (a binding whose job Tapis keeps answering 404 for four hours is withdrawn, back to a reservation) and carries out `mismatch` rows.
11. **The tenant sweep leaves a partner's job under a live reservation to its report.**
    A Tapis job no row is bound to is left alone when its tag names exactly one partner reservation that is unbound, not cancelled, not flagged, not older than the wait plus an hour, and the job's owner is that reservation's Tapis username (`isAwaitingPartnerReport`, counted as `awaiting_report`); otherwise it skipped the reservation, as before.
    A tag proves nothing, so the owner must agree; without this a sweep landing between a launch and its report would cancel a legitimate job and the report would be refused `tapis_job_in_use`.
12. **Moving a charge (`POST /admin/compute/jobs/:id/move-charge`, `nemar admin compute move-charge <job> --to <account id>`, OWNER only).**
    The ledger operation the A7 amendment promised, for a job the tenant sweep charged to the partner pool.
    Two `adjust` entries in ONE batch, with an audit row `compute.charge.move` and the reason `charge_moved`: the first LOWERS the partner pool's charge by the figure of the job's unreserved entry, the second RAISES the person's pool of the same word by that figure, and NEITHER names a budget.
    The budget is counted once because the unreserved entry counted the consumption; `adjustPool` names the budget on a raise (which there is new consumption) and a move is not, so the naive form (the person's raise naming the `people` budget) counts it twice, and the partner's lowering naming it would give budget back.
    The invariants, each tested: both pools move by the same figure; no stored total is negative; the people budget's charged total is the same before and after; a refusal writes nothing and a failure of the second half leaves nothing of the first; the entries' keys are made of the job (`move:<job>:out`, `move:<job>:in`), so a charge moves once (a repeat is a replay, another account is `already_moved`).
    Refused: a job that was reserved (`job_reserved`, the flag is its own term), one with no unreserved charge or not over (`no_unreserved_charge`), an account that is absent, deleted or not in good standing (a verified or approved account), or without a pool of the word (`target_has_no_pool`).
    The job must have been indexed from Tapis by the sweep and be over, so no person is charged for a job NEMAR has not seen and followed to its end; WHO ran it is the owner's evidence, outside the system.
    It is owner-only, not admin-level as the phase issue said, because raising a person's charge is the owner's under the interim rule of `routes/admin/compute.ts` (easy to loosen).
    The person's available may go negative; holds are refused until a grant brings it back.
13. **Lifecycle changes the partner needed.**
    A partner job's Tapis `FINISHED` stands without the launcher's documents (it has no NEMAR launcher; `planFromTapis`), and no "results are ready" mail is sent for it (there are no results in NEMAR's bucket).
    `TerminalPlan.releaseReason` lets the reaper's release carry the ledger reason `expired`.
    The new cancel reasons are `partner_release` and `hold_expired`, the new ledger reason `charge_moved`.
14. **The compute switch is not read here** (`compute-source-scan.test.ts` holds it): with compute off the routes work, a hold is taken and the reaper expires it, as for a person's submission.
15. **Deviations from the phase issue, recorded.**
    The issue's states say `held`: the real word is `created`, and `partner_state` says where the verification is.
    The issue's migration number 0128 is 0134 (the epic's range moved); the unique index it asked for if absent was present.
    The mismatch overrun is on the partner pool and the hold is released (item 7), not an overrun on the person's pool.
    The client's pool identity the issue asked to add is the existing partner pool `tenant` (one partner today); a pool per client would be a change of the A7 sweep as well.
    The route's `files` entries carry a `sha256` as the issue said, recorded as the partner's claim.
    The move of a charge is owner-only (item 12).
16. **Not verified, and listed so nobody reads it as fact.**
    Whether the tenant credential can search by tag and read another owner's job: the stand-in's `shareJob` models an arrangement of the real tenant (the partner shares its jobs with NEMAR's service identity, or the credential is a tenant administrator's); if the search cannot see them, an empty search is not affirmative and the reaper would release a reservation whose job exists (the sweep cannot see it either).
    Which Tapis username the partner gives a person (design question 13): the identity transform of the `sub` is assumed (item 6), and the A7 sweep's mapping of an owner to an account (by the gateway pseudonym) is not the same assumption.
    The GPU count of a partner's job.
    R2's enforcement of a signed content length on a presigned PUT (the size read back at finalize is the bound either way).
    There is no cap on the bytes a partner may hold in `incoming/` at once (each reservation is bounded by 500 files and the owner's limits, a client by its open-reservation cap, and the bucket empties `incoming/` after two days); idempotency rows are not pruned.
