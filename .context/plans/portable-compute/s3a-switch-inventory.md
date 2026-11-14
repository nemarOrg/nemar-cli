# S3a: everything the compute switches open, read from the code (input to Q6)

Card S3a of the portable compute plan, read-only.
It lists every path that `COMPUTE_ENABLED`, `COMPUTE_RUNNERS_ENABLED` and `COMPUTE_PIPELINES_DISPATCH_ENABLED` open, every compute path that runs in production whatever they say, and what each does with no Tapis credential, no ACCESS key and no runtime image.
Abbreviations: Architecture Decision Record (ADR); pull request (PR); Cloudflare's SQLite database (D1); Cloudflare's object store (R2); the NSF program Advanced Cyberinfrastructure Coordination Ecosystem: Services & Support (ACCESS); service unit (SU).

## 1. Head read

| Head | Commit | Role |
|---|---|---|
| `origin/feature/portable-compute-epic` | `02113b1651dbbd5d20d20b8f59448400b07c0f31` | every file and line below, unless a row names another head |
| `origin/dev` | `3a515ce1` | the epic is not merged: 16 commits ahead of `dev`, `dev` 2 ahead of the epic |
| `origin/main` | `25f48b17` (0.10.33) | the source of the production Worker today |
| #2116 (`feature/issue-2021-epic-compute-users`) | `82ddd0a070f52eb5a6938a09bced8c7a2a8ac20d` | section 4 only |
| nemarOrg/nemar-process `main`, `feature/runner-epic` | `d6d80b3`, `13b3a89` | section 5 only |

Every row names a repository-relative path and a line at the epic head, so `git show 02113b16:<path> | sed -n '<line>p'` shows it.

Two configurations are read throughout, both with `COMPUTE_ENABLED=1` and `COMPUTE_RUNNERS_ENABLED=1`, `COMPUTE_PIPELINES_DISPATCH_ENABLED` absent, no `TAPIS_USERNAME`, `TAPIS_PASSWORD` or `TAPIS_SERVICE_TOKEN`, and no `ACCESS_GATEWAY_ATTRIBUTES_KEY` or `ACCESS_RESOURCE_NAME`:

- **A**, the card's: no `COMPUTE_RUNTIME_IMAGE` either.
- **B**, the one S2S and S3 need: `COMPUTE_RUNTIME_IMAGE` set, because a runner run is refused without it like a Tapis run (`backend/src/services/compute-pipeline.ts:618-619` run before the executor branch at `:741`).

Classes: `fails closed` (a refusal word, no write); `fails closed, audit only` (a refusal word and the administrator's `compute.pipeline.run` audit row, nothing else); `history only` (a refusal word, a `refused` stamp and the audit row; no job, no ledger entry); `side effect` (a write outside the path's own job row, named); `open by design` (the runner path S3 is for).

## 2. Gated paths

| ID | Path and gate | Switch | Who | Writes when open | With no Tapis credential | Class |
|---|---|---|---|---|---|---|
| G1 | `POST /admin/compute/pipeline/run`, live, one dataset, executor `tapis` (the default, `backend/src/routes/admin/compute-pipeline.ts:298`): gate `backend/src/routes/admin/compute-pipeline.ts:321`, again `backend/src/services/compute-pipeline.ts:594` | `COMPUTE_ENABLED` | an administrator (admin router; not owner-only) | a stamp (`backend/src/services/compute-pipeline.ts:639`), a ledger hold on the `pipelines` pool with the job row (`createJob`, `:661`), the job's records in the records bucket, one submit attempt (`:757`), an audit row | A: `runtime_unavailable` 422 at `backend/src/services/compute-pipeline.ts:619`, before the stamp claim (the route's audit row is the only write). B: `pipelines_account_missing` 503 at `:621` when the service account is absent; else the stamp is claimed and, with the `pipelines` pool ungranted, the hold is refused `insufficient_balance` 409 (`backend/src/services/compute-ledger.ts:548`) and the stamp ended `refused` (`backend/src/services/compute-pipeline.ts:729`); with the pool granted the answer is 201 with `submit: "unconfigured"`, and a hold, a `created` Tapis job and a `dispatched` stamp stay. That hold never times out: `submitComputeJob` returns `unconfigured` at `backend/src/services/compute-lifecycle.ts:1627-1628`, before `submitLeased`'s overdue branch at `:1667`; only `admin compute jobs cancel` ends it (`:1951`, a job with no launch specification ends in SQL and its hold is released) | A: fails closed, audit only. B: history only (pool ungranted); **side effect** (pool granted: ledger hold, pool totals, a live row in the tenant and pipelines counts, records, a stamp that blocks the tuple) |
| G2 | the same route, live, `eligible` (Tapis only: a runner run over `eligible` is refused at `backend/src/routes/admin/compute-pipeline.ts:306`): `:321`, `:358`; the run syncs (`backend/src/services/compute-pipeline.ts:1600`), reads its room (`:1611`) and stops on a word of `STOPS_A_RUN` (`:1527`, `:1627`) | `COMPUTE_ENABLED` | an administrator | as G1, per dataset, at most min(limit, 10, daily room, live room, tenant room) | A: 200, `dispatched: 0`, `stopped_by: "runtime_unavailable"`. B: 200, `stopped_by: "insufficient_balance"` with the pool ungranted; with it granted, up to that minimum of held `created` jobs per call (the shipped live cap is 8 on `cpu`) | A: fails closed, audit only. B: history only, or **side effect** (pool granted) |
| G3 | the same route, live, one dataset, executor `runner`: `backend/src/services/compute-pipeline.ts:607`, after `:594` | both | an administrator | a stamp, a runner job row admitted by the runner guard (`backend/src/services/compute-jobs.ts:900`, `:513`), its records, an audit row; no hold, no ledger entry, no submit (`backend/src/services/compute-pipeline.ts:741`) | A: `runtime_unavailable` 422. B: a waiting runner job (201, `submit: "waiting_for_runner"`); nothing reaches a tenant | A: fails closed, audit only. B: open by design |
| G4 | the daily dispatcher `runComputePipelineDispatchCron`: `backend/src/index.ts:1464`; gate `backend/src/services/compute-pipeline-dispatch.ts:132-133` | `COMPUTE_ENABLED` and `COMPUTE_PIPELINES_DISPATCH_ENABLED`, exact production | the daily cron | as G2 for each `autoDispatch` recipe (today `nemar-floor`, Tapis only) | the second switch absent: `off`, no table touched. If it were set: A ends the run on `runtime_unavailable` (`ENDS_THE_RUN`, `backend/src/services/compute-pipeline-dispatch.ts:78-80`); B with a granted pool leaves up to 10 held jobs a day | fails closed while its switch is absent; **side effect** in B with a grant if it were set |
| G5 | the tenant sweep, `live`: `backend/src/index.ts:1305`; gate `backend/src/services/compute-tenant-sweep.ts:659` | `COMPUTE_ENABLED`, exact production | the 30-minute cron | indexes, cancels and charges tenant jobs no row owns | `tapisAccess` is null: `errors: ["unconfigured"]` and return (`:662-665`), nothing read or written; the line is error level (`needsPerson`, `:741`, `:777`), so 48 error lines a day | fails closed (an error line every tick) |
| G6 | the tenant sweep, `week`: `backend/src/index.ts:1484`; the same gate | `COMPUTE_ENABLED`, exact production | the daily cron | as G5, then the day's reconciliation | as G5; the reconciliation is skipped | fails closed (an error line a day) |
| G7 | the submit itself, `submitLeased` step 5: `backend/src/services/compute-lifecycle.ts:1674` | `COMPUTE_ENABLED` | reached from the 30-minute tick, the Tapis webhook, `admin compute jobs advance` and G1's one attempt | the launch digest, a Tapis job, the bind | never reached: `:1627-1628` return `unconfigured` before the submit lease (`:1631`) and before `:1674` | fails closed |
| G8 | `POST /compute/runners/token`: `backend/src/routes/compute-runners.ts:101-102` | both | a runner holding an `nmr_` secret | an access token row | a missing, unknown or revoked secret: 401 `runner_unknown` (`:105-106`), no write; a valid one: 200 | open by design |
| G9 | `GET /compute/runners/me`: `runnerAccess` `backend/src/routes/compute-runners.ts:91`, route `:124` | both | a runner with an `nmra_` token | nothing | a missing, unknown or revoked token: 401 `runner_unknown` (`:93`, `:96`) | open by design |
| G10 | `POST /compute/runners/claim`: `:91`, `:154`; runs `sweepRunnerLeases` (`:176`) then `claimRunnerJobs` (`:185`, `backend/src/services/compute-runner-queue.ts:282`) | both | a runner with a token | runner job rows only: the claim, its lease, `launch_spec_digest`; the sweep's runner rows | as G9 for a bad token; a valid token with no job answers `jobs: []`; a launch that is not configured (`:289`, `buildLaunch` at `:333`) gives the claim back | open by design |
| G11 | `POST /compute/runners/heartbeat`: `backend/src/routes/compute-runners.ts:91`, `:189` | both | a runner with a token | the claimed job's own row | as G9 for a bad token | open by design |
| G12 | `POST /compute/runners/complete`: `:91`, `:202` | both | a runner with a token | the job's terminal batch with no ledger entry (`NONE_SETTLED_STAMP_SQL`, `backend/src/services/compute-lifecycle.ts:250-255`), its records copy and stamp | as G9 for a bad token | open by design |

Readers that gate nothing: `GET /admin/compute/status` reads `computeEnabled` and the pipelines switch (`backend/src/services/compute-status.ts:166`, `:204-205`) and **does not report the runners switch**; the pipeline dry run reports `compute_enabled` and, for a runner dry run, `runners_enabled` (`backend/src/services/compute-pipeline.ts:1261`, `:1265`), which is the only place the runners switch can be read back.

## 3. Ungated production paths

ADR 0118's A5 amendment item 10 says the compute crons read no switch.
Production runs `main@25f48b17`, which carries every compute cron below except `sweepRunnerLeases` (`backend/src/index.ts` on `main`: `:1214`, `:1232`, `:1256`, `:1278`, `:1436`, `:1456`, `:1477`).
"Today" is read from that code with no compute rows; no production log was read.

| ID | Path | Fence | Who | Writes | Today in production, no compute rows | Switches on, no Tapis | A runner row |
|---|---|---|---|---|---|---|---|
| U1 | the advance tick `runComputeAdvanceCron`: `backend/src/index.ts:1219`; `backend/src/services/compute-advance.ts:201-202` | exact production, no switch | the 30-minute cron | Tapis rows: submit, state, settlement, copies; nonces of terminal rows | four empty selections, `CLEAR_NONCES_SQL` and `MARK_COPY_ABANDONED_SQL` change no row, one count; no Tapis call, no log line | the same; a `created` Tapis row (G1 in B with a grant) answers `unconfigured` and waits every tick, for ever | never taken: `CREATED_ROWS_SQL` selects `executor = 'tapis'` (`backend/src/services/compute-advance.ts:95`), `BOUND_ROWS_SQL` needs a `tapis_uuid` (`:84-86`), `advanceComputeJob` refuses a runner row (`backend/src/services/compute-lifecycle.ts:2036`); `CLEAR_NONCES_SQL` (`:362-364`) clears a terminal runner row's nonce a day after its end, which changes nothing (the job token already stops at terminal, `backend/src/routes/callbacks/compute-job-callbacks.ts:84`) |
| U2 | the cancel sweep `sweepComputeCancellations`: `backend/src/index.ts:1237`; `backend/src/services/compute-advance.ts:310-311` | exact production, no switch | the 30-minute cron | Tapis cancels, holds released for jobs that never reached Tapis | an empty selection and a count | the same | never taken: `CANCEL_ROWS_SQL` (`backend/src/services/compute-advance.ts:119`); `ORPHAN_ROWS_SQL` (`:104`) reads a column only Tapis paths write; `driveCancel` refuses a runner row (`backend/src/services/compute-lifecycle.ts:1896`) |
| U3 | the runner lease sweep `sweepRunnerLeases`: `backend/src/index.ts:1259`; `backend/src/services/compute-runner-queue.ts:1013` | inside the production block (`backend/src/index.ts:1047`), no switch, no environment check of its own; also run by every claim (G10) | the 30-minute cron | runner rows only: every selection names `executor = 'runner'` (`backend/src/services/compute-runner-queue.ts:724-852`) | absent (the epic adds it) | empty selections | its own work. With either switch turned off a started job cannot heartbeat: `unreported` at lease end, then `runner_lost` `lease_expired` after 60 minutes unless its outputs completed (U6 reads no switch, so outputs still land) |
| U4 | the ACCESS reporter `runAccessReportCron`: `backend/src/index.ts:1283`; `backend/src/services/access-attributes.ts:511-515` | exact production, no switch | the 30-minute cron | report rows, one POST each | no rows, nothing sent | the same; with no key a row stays `pending` (`unconfigured`) | never: a report row is made only for `accounting = 'su'` with a Slurm id (`backend/src/services/access-attributes.ts:145-146`) |
| U5 | the retention sweep `runComputeRetentionSweep`: `backend/src/index.ts:1506`; `backend/src/services/compute-retention.ts:272-273` | exact production, no switch | the daily cron | deletes records and logs past `retention_until`, reduces the row | nothing is due | the same | retention applies to every record, a runner job's included; it is not a Tapis mechanic, and nothing is due for 7 years |
| U6 | the launcher callbacks `bundle`, `outputs`, `outputs/complete`: `backend/src/routes/callbacks/compute-job-callbacks.ts:111`, `:125`, `:151`; token `:73-84` | none; a per-job token, and for a runner row the current lease (`:87`, `:96-102`) | a launcher | its own job only | every request: 404 `job_not_found` | the same | needs the current lease; a revoked runner's job has none |
| U7 | a person's `cancel` and `links`: `backend/src/routes/compute.ts:70`, `:79` | none; a signed-in owner of the job | a person | the job's cancel intent; links | 404 `job_not_found`: no person-owned job exists on this head | the same | a runner job belongs to the pipelines service account, so no person reaches it |
| U8 | the Tapis webhook: `backend/src/routes/callbacks/tapis.ts:41` | none; a token over the job's nonce | Tapis | `advanceComputeJob` | 404 `not_found` for every request | `unreachable`, answered `{ ok: true }` | refused at `backend/src/services/compute-lifecycle.ts:2036` |
| U9 | the observer: `backend/src/routes/callbacks/compute-observer.ts:41`; its token is minted at `backend/src/routes/admin/compute-reporting.ts:290` | none; a one-run token | the observer | observer rows; final settlement | 403 `observer_refused` without a minted token | the same | settles `accounting = 'su'` only (`backend/src/services/compute-observer.ts:186`) |
| U10 | the administrator's compute routes: `backend/src/routes/admin/compute.ts:389` (status), `:397`, `:405` (policy, owner), `:431`, `:455` (pools), `:469`, `:475` (an account's grant and adjustment, admin), `:481`, `:485` (a platform pool's, owner); `backend/src/routes/admin/compute-reporting.ts:109-290`; `backend/src/routes/admin/compute-jobs.ts:35`, `:61`; `backend/src/routes/admin/compute-pipeline.ts:310` (dry run), `:399` (status) | none | administrators; the owner where named | status writes nothing (the token mint answers `unconfigured`; the health call is unauthenticated and goes out only when `TAPIS_BASE_URL` is set, else it answers `unconfigured` too); a policy version (section 6); ledger grants; a cancel; the stamp sync | as written: these are live today | the same | `jobs advance` refuses a runner row (`backend/src/routes/admin/compute-jobs.ts:71`). **A grant to the `pipelines` platform pool (`:481`) is what turns G1 and G2 into a side effect in B** |
| U11 | the runner registry: `backend/src/routes/admin/compute-runners.ts:102`, `:132`, `:141` | none | the owner | a registration; a revoke that ends its work in one batch | absent (the epic adds it) | the same | its own |
| U12 | the revocation cascades: `computeReleaseStatements` (`backend/src/services/compute-release.ts:177`) and `runnerEndStatements` (`backend/src/services/compute-runners.ts:190`, callers `:212`) | none | an administrator's revoke, the owner's delete, an owner's demotion | the account's jobs, holds, pools, registrations | no rows | the same | step 1 records a cancel intent on a runner row too (`backend/src/services/compute-release.ts:110`), carried to its runner; the ending steps select `executor = 'tapis'` (`:99`) |

### 3.1 Every Tapis mechanic and a runner row

| Selection | Where | Executor term | Can it take a runner row? |
|---|---|---|---|
| `CREATED_ROWS_SQL` | `backend/src/services/compute-advance.ts:93-96` | `:95` | no |
| `CANCEL_ROWS_SQL` | `backend/src/services/compute-advance.ts:117-121` | `:119` | no |
| `BOUND_ROWS_SQL` | `backend/src/services/compute-advance.ts:84-86` | none; needs `tapis_uuid IS NOT NULL` | only if a runner row gets a `tapis_uuid`, which only the tenant sweep's bind below can do |
| `ORPHAN_ROWS_SQL` | `backend/src/services/compute-advance.ts:104-105` | none; needs `orphan_tapis_uuid` | no: `SET_ORPHAN_SQL` (`backend/src/services/compute-lifecycle.ts:303`) runs only on Tapis paths |
| `CLAIM_SUBMIT_SQL` | `backend/src/services/compute-lifecycle.ts:279-283` | `:281` | no |
| `UNREPORTED_SQL` | `backend/src/services/compute-lifecycle.ts:356-359` | none; needs a `tapis_uuid` | as `BOUND_ROWS_SQL` |
| `UNSETTLED_TERMINAL_SQL` | `backend/src/services/compute-lifecycle.ts:376-379` | none; needs a hold row (`:378`) | no: a runner job has no hold |
| `UNCOPIED_TERMINAL_SQL`, `MARK_COPY_ABANDONED_SQL`, `CANCEL_PENDING_FAILED_SQL` | `backend/src/services/compute-lifecycle.ts:390-394`, `:425-429`, `:406-410` | `:392`, `:427`, `:408` | no |
| `CLEAR_NONCES_SQL` | `backend/src/services/compute-lifecycle.ts:362-364` | none | yes, a terminal row's nonce; harmless (U1) |
| `submitComputeJob`, `driveCancel`, `advanceComputeJob`, `jobs advance` | `backend/src/services/compute-lifecycle.ts:1615`, `:1896`, `:2036`; `backend/src/routes/admin/compute-jobs.ts:71` | code checks | no |
| the tenant sweep's own rows, `FOLLOW_ROWS_SQL` | `backend/src/services/compute-tenant-sweep.ts:227-230` | `:229` | no |
| **the tenant sweep's tag bind** (`handleUnbound`), with `BIND_TAPIS_JOB_SQL` | `backend/src/services/compute-tenant-sweep.ts:405-432` (bind at `:415`); `backend/src/services/compute-lifecycle.ts:258-262` | **none** | **yes, once Tapis is configured**: a Tapis job owned by NEMAR's service identity and tagged `nemar_job:<a runner job's id>` would move a `created` runner row to `submitted` with a `tapis_uuid`, and a tagged duplicate flags the runner row `mismatch` (`:429`). Unreachable with no Tapis credential (G5); a condition before one is set (section 8) |
| money and tenancy | `backend/src/services/compute-tenant.ts:100`, `backend/src/services/compute-jobs.ts:428`, `backend/src/services/compute-observer.ts:186`, `backend/src/services/access-attributes.ts:146` | `accounting = 'su'` | no |

## 4. What a person reaches

**On this head, `COMPUTE_ENABLED` opens no route a non-administrator can call.**
A person's compute routes are `cancel` and `links` (`backend/src/routes/compute.ts:70`, `:79`): they read no switch (`:30-31`) and answer only the signed-in owner of a job, and no path on this head makes a job a person owns (a pipeline job, Tapis or runner, belongs to the pipelines service account).
A runner credential is refused by every route but the runner routes (`runner_credential_not_accepted`, `backend/src/middleware/auth.ts:368`, `:414`).

**On #2116's head `82ddd0a0`, the switch opens no person route either, but a person can hold a pool whatever the switch says.**
Its person routes (`backend/src/routes/compute/jobs.ts:147-150` there, with `cancel`, `links`, `GET /compute/me*` and the partner's reserve) read no compute switch (`backend/src/routes/compute/jobs.ts:22` there, pinned by its source scan); `POST /compute/jobs` is gated by compute access (`:67`) and the hold.
An account an administrator grants compute access can therefore submit with the switches off or on, and with no Tapis credential a finalized job holds its pool until it is cancelled: #2116 keeps the same order, `tapisAccess` returning `unconfigured` (`backend/src/services/compute-lifecycle.ts:1697-1698` there) before the overdue check is acted on.
So: whichever lands first, no person route depends on the switch; with #2116 merged, no account may be granted compute access while Tapis is absent (section 8, C7).

## 5. The registration block

ADR 0118, amendment of 2026-11-04 (#2043), item 8 (`.context/decisions/0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md:416-419`): "No application definition is registered with any tenant, and `COMPUTE_ENABLED` is not turned on anywhere, until the launcher's decoder lands in `nemar-process` ... AND the owner items recorded on the launcher phase's pull request (`nemarOrg/nemar-process#9`) are settled."

| Item | State | Tapis-only? | Evidence |
|---|---|---|---|
| The launcher's decoder in nemar-process | **settled** | yes (it was the encoding of a value Tapis writes into a launch file a shell sources) | nemar-process#10, merged 2026-11-06; `launcher/nemar_launch/spec.py` decodes base64url on `main` `d6d80b3` and `feature/runner-epic` `13b3a89`; nemar-process `AGENTS.md:49` on `main` says the encoding is no longer an owner item |
| The release-asset procedure (immutable releases, tag rulesets, a reviewed release workflow) for the Tapis application zips | unsettled | yes: the zips are the `containerImage` of the two Tapis applications; a runner runs the signed OCI image of ADR 0122 | nemar-process `AGENTS.md:45` and `docs/operator.md:86-98` on `main`; `deploy/tapis/released-versions.json` is empty |
| Whether the entry scripts delete `tapisjob.env` after the job starts | unsettled | yes: a Tapis launch file; a runner has none | `docs/operator.md:209` on `main` |
| Whether the launcher adds `--no-mount hostfs` | unsettled | **no**: it is the launcher's Apptainer flag set, and a runner drives the same launcher; a Docker-backed runner is unaffected | `launcher/nemar_launch/run.py:236` on `feature/runner-epic` (`--containall --cleanenv --no-home --no-mount bind-paths`, no `hostfs`) |
| Confirmation on a tenant of every behavior marked "from source, to confirm on the tenant" | unsettled | yes | `AGENTS.md:48` on `main`; no tenant exists |

**Finding.**
Read literally, item 8 binds every environment and every executor: "anywhere" has no qualifier, and it was written on 2026-11-04, when `COMPUTE_ENABLED` could only mean Tapis submission.
Read by its purpose, its context and its two conditions, it guards the Tapis go-live: registration with a tenant, and a launch specification reaching a scheduler that writes it into a shell-sourced file.
The code agrees with the second reading: with no Tapis credential, no job, credential or launch value reaches a tenant (G5 to G7: `unconfigured` before any request), and a runner's launch value is the same base64url text, built by `buildLaunch` (`backend/src/services/compute-runner-queue.ts:333`) and decoded by the decoder that has landed.
ADR 0121 does not mention item 8, and an accepted ADR's sentence cannot be read away by an agent: the ADR wins until the owner amends it.
**So item 8 binds staging and production today, runner-only included; it should not, except for `--no-mount hostfs` on an Apptainer runner.**

**Recommendation.**
The owner applies the amendment below to ADR 0121 (proposed) and a one-line pointer in ADR 0118, before any switch is set, staging included; settling the three Tapis-only items is not needed for runners.
The hostfs item is decided for both executors (it is one word in `ISOLATION_FLAGS`); until then the production runner uses Docker, or the item is settled first.

Draft, not applied:

```markdown
## Amendment 2026-11-NN: ADR 0118's registration block and runner-only deployments

ADR 0118's amendment of 2026-11-04 (#2043), item 8, was written when `COMPUTE_ENABLED` could only mean a
Tapis submission. It is read this way from this date:

1. Item 8 blocks the Tapis go-live: registering an application definition with a tenant, setting a Tapis
   credential (`TAPIS_USERNAME`, `TAPIS_PASSWORD` or `TAPIS_SERVICE_TOKEN`) in a Worker where
   `COMPUTE_ENABLED` is `1`, and submitting a job to a tenant. Its first condition (the launcher's decoder in
   nemar-process) is met (nemarOrg/nemar-process#10); the owner items of nemarOrg/nemar-process#9 still
   block all three.
2. `COMPUTE_ENABLED` may be `1`, with `COMPUTE_RUNNERS_ENABLED`, in a Worker that holds no Tapis credential,
   for runner jobs, once a Tapis-executor pipeline run is refused there before any write (card S3c); until
   that lands, only where the `pipelines` pool holds no grant. In such a Worker every path that would reach
   Tapis answers `unconfigured`, and no job, credential or launch value is sent to a tenant.
3. Setting a Tapis credential where `COMPUTE_ENABLED` is `1` is the Tapis go-live: it needs the #9 items
   settled and every Tapis mechanic selecting `executor = 'tapis'`, the tenant sweep's bind of a tagged job
   included.
4. The #9 item on `--no-mount hostfs` is not Tapis-only: it applies to every Apptainer run, a runner's
   included. A runner that drives Apptainer waits for it; one that drives Docker does not.
5. The switches stay the owner's: production ones are set in a reviewed pull request that edits the
   dark-switch test, and ADR 0118 decision 8 and the dark-switch rule of `AGENTS.md` are unchanged.
```

Pointer for ADR 0118, also not applied: "Amendment 2026-11-NN: item 8 of the amendment of 2026-11-04 (#2043) is read as ADR 0121's amendment of 2026-11-NN says; the verdict of this ADR stands."

Owner command that answers whether any switch is already set somewhere (not run here): `env -u TEST_API_URL bun run src/index.ts admin compute status --json` with the owner's production configuration, and the same with `TEST_API_URL=$STAGING_API` and a staging configuration; read `.switches` and `.tapis.configured`.

## 6. Rollback

| Head | `tenant` key | `runners` key | Source |
|---|---|---|---|
| `main` `25f48b17` (production) | no | no | `ComputePolicySchema` at `shared/contract/compute.ts:880` on `main`, strict |
| `dev` `3a515ce1` | yes | no | `shared/contract/compute.ts:932` on `dev` |
| the epic `02113b16` | yes | yes | `shared/contract/compute.ts:943`, `:949` |

The reader is as strict as the writer: a stored policy with a key a Worker does not know is unreadable there, and every reader then fails closed (ADR 0118, A2 amendment item 8; the P2 amendment's item 7 lists them: holds, the launcher's outputs call, the tick's created rows, the dispatcher, retention, the observer's settlement, the tenant sweep).
So a production Worker built from `main` cannot read **`tenant` or `runners`**; the first release that carries the epic also carries P2.
The shipped default carries `tenant` and not `runners` (`DEFAULT_COMPUTE_POLICY`, `shared/contract/compute.ts:1018-1042`, `tenant` at `:1030`), so a `policy show`, edit, `policy set` round trip after that release writes `tenant` even when nobody meant to.

**The rule.**
A policy version holding a key is stored only when every Worker version a rollback could land on reads that key: in practice, when the previous production deployment already carries the release that added the key.
Until then no policy is written at all, or only one from a file without `tenant` and `runners`.
Recovery if it happens anyway: ADR 0118 P2 item 7, a version without the key written by the older Worker's own `policy set`.
Owner commands (not run): `bunx cfman wrangler --account sccn deployments list -c backend/wrangler-sccn.toml` for the previous deployment, and `env -u TEST_API_URL bun run src/index.ts admin compute status --json` for `.prerequisites.policy_set`.

**OQ2 (`cp2-note-S.md`).**
Option A, a code default of `{ cpu: 2, gpu: 0 }` for `RUNNERS_POLICY_DEFAULT` (`shared/contract/compute.ts:1004-1006`), starts `maxLiveJobs` at 2 with no stored key, so the rollback hazard never arises from `runners`; the runner guard admits nothing on `gpu` at 0 (`backend/src/services/compute-jobs.ts:513`, `< ?22`).
It changes ADR 0121 decision 6's "defaults 64 for `cpu` and 8 for `gpu`" (an edit of a proposed ADR) and raising it later is a deploy.
Option B stores `{ cpu: 2, gpu: 0 }` only after a second release with the epic is deployed.
This reading recommends A.

**A rollback across the epic with runner rows live.**
The rollback Worker has no runner routes and no `sweepRunnerLeases`, and its Tapis selections have no executor term (`backend/src/services/compute-advance.ts:93-95`, `:116-120` and `backend/src/services/compute-lifecycle.ts:338-342` on `main`).
With no Tapis credential a `created` runner row answers `unconfigured` there, but its cancel path can end a waiting runner row in SQL and its copy repair can take a terminal runner row (read, not traced further).
Rule for S3's runbook: before any rollback across the epic, turn `COMPUTE_RUNNERS_ENABLED` off and drain until no runner row is live.

## 7. Probe table for S3b

Preconditions, from S3b: S2 (with S1) merged into `dev` and deployed; the dev Worker has `COMPUTE_ENABLED=1` and `COMPUTE_RUNNERS_ENABLED=1` and no Tapis credential.
The expected answers are for configuration B (`COMPUTE_RUNTIME_IMAGE` set, as OQ1 asks) with the configuration A answer beside them; any word refused before the stamp claim (`dataset_not_eligible`, `version_untagged`, `too_many_files`, `registry_drift`, `live_attempt_exists`) also passes and is recorded.
`$S` is a new mode-0700 directory under the operator's scratch; nothing is printed that holds a key, a secret or a token.

Setup, in order:

1. `umask 077; mkdir -p "$S"; printf 'Authorization: Bearer %s\n' "$(cat "$STG_ADMIN_KEY_FILE")" > "$S/admin.hdr"`
2. The owner's isolated configuration, logged in as S1F step 4 does: `NEMAR_CONFIG_DIR="$S/cfg-owner" TEST_API_URL="$STAGING_API"` with the key of `$STG_OWNER_KEY_FILE`.
3. Register: `NEMAR_CONFIG_DIR="$S/cfg-owner" TEST_API_URL="$STAGING_API" bun run src/index.ts admin compute runners register probe-s3b --pool cpu --cores 1 --memory-mb 1024 --gpus 0 --scratch-gb 1 --backend local --runtime docker --arch amd64 --site probe --trust lab --json > "$S/probe.json"`, then `jq -r .secret "$S/probe.json" > "$S/probe.secret"` and `printf 'Authorization: Bearer %s\n' "$(cat "$S/probe.secret")" > "$S/secret.hdr"`.
4. Exchange (open by design, expected 200): `curl -sS -o "$S/token.json" -w '%{http_code}\n' -X POST "$STAGING_API/compute/runners/token" -H @"$S/secret.hdr" -H 'Content-Type: application/json' --data '{"protocol":"nemar.runner.v1","runner_version":"0.1.0"}'`, then `printf 'Authorization: Bearer %s\n' "$(jq -r .access_token "$S/token.json")" > "$S/token.hdr"`.
5. Revoke: `NEMAR_CONFIG_DIR="$S/cfg-owner" TEST_API_URL="$STAGING_API" bun run src/index.ts admin compute runners revoke "$(jq -r .runner_id "$S/probe.json")" --json`; expected `revoked: true`, `already_revoked: false`.

Each probe below is `curl -sS -o "$S/<id>.json" -w '%{http_code}\n'` plus what the row adds; the word is `jq -r .code` for an administrator's route and `jq -r .error` for a runner's.
P0 is the status read the cron rows use.

| Probe | Gated path | Request (after the common prefix) | Account | Expected, switches on, no Tapis | Writes |
|---|---|---|---|---|---|
| P0 | G4 to G7 (precondition) | `"$STAGING_API/admin/compute/status" -H @"$S/admin.hdr"` | staging administrator | 200; `.switches.compute_enabled` true, `.switches.pipelines_dispatch_enabled` false, `.tapis.configured` false, `.tapis.token` `unconfigured`, `.reconciliation.paused` false; record `.runtime_image` and `.prerequisites.pipelines_pool_granted` | none |
| P1 | G1 | `-X POST "$STAGING_API/admin/compute/pipeline/run" -H @"$S/admin.hdr" -H 'Content-Type: application/json' --data '{"recipe":"nemar-floor","dataset":"nm099996"}'` | staging administrator | **Run only if P0 shows `pipelines_pool_granted: false`**, else record "not run: pool granted" and notify the manager. B: 409 `insufficient_balance`. A: 422 `runtime_unavailable`. After S3c: 503 `tapis_unconfigured` | B: a `refused` stamp and an audit row; A: an audit row; ledger unchanged |
| P2 | G2 | as P1 with `--data '{"recipe":"nemar-floor","eligible":true,"limit":1}'` | staging administrator | the same precondition. B: 200, `.dispatched` 0, `.stopped_by` `insufficient_balance` (null when no candidate). A: 200, `.stopped_by` `runtime_unavailable`. After S3c: 503 `tapis_unconfigured` | as P1 |
| P3 | G3 | as P1 with `--data '{"recipe":"nemar-floor-zarr","dataset":"nm099996","executor":"runner","dry_run":true}'` (if Q0b has landed, `nemar-floor` with its input word) | staging administrator | 200; `.config.compute_enabled` true, `.config.runners_enabled` true; `.config.runtime_image` true in B, false in A. The live runner run is S2S's | none |
| P4 | G4 | P0's request | staging administrator | `.switches.pipelines_dispatch_enabled` false (the dispatcher is production-only; no staging request reaches it) | none |
| P5 | G5 | P0's request | staging administrator | `.tapis.configured` false and `.reconciliation.paused` false: the sweep would stop at `unconfigured` (production-only cron) | none |
| P6 | G6 | P0's request | staging administrator | as P5 | none |
| P7 | G7 | P0's request | staging administrator | `.tapis.configured` false: `submitComputeJob` answers `unconfigured` before the switch is read | none |
| P8 | G8 | `-X POST "$STAGING_API/compute/runners/token" -H @"$S/secret.hdr" -H 'Content-Type: application/json' --data '{"protocol":"nemar.runner.v1","runner_version":"0.1.0"}'` | the revoked `probe-s3b` secret | 401 `runner_unknown` (503 `runners_disabled` means the switch is off) | none |
| P9 | G9 | `"$STAGING_API/compute/runners/me" -H @"$S/token.hdr"` | the revoked runner's access token | 401 `runner_unknown` | none |
| P10 | G10 | `-X POST "$STAGING_API/compute/runners/claim" -H @"$S/token.hdr" -H 'Content-Type: application/json' --data '{}'` | the revoked runner's access token | 401 `runner_unknown` | none |
| P11 | G11 | `-X POST "$STAGING_API/compute/runners/heartbeat" -H @"$S/token.hdr" -H 'Content-Type: application/json' --data '{}'` | the revoked runner's access token | 401 `runner_unknown` | none |
| P12 | G12 | `-X POST "$STAGING_API/compute/runners/complete" -H @"$S/token.hdr" -H 'Content-Type: application/json' --data '{}'` | the revoked runner's access token | 401 `runner_unknown` | none |

No probe names a production host or key; only P1 and P2 can dispatch, and only on `nm099996`.

## 8. Verdict for Q6

**Stop condition met under one precondition (the manager was notified on 2026-11-14).**
In configuration B, G1 and G2 (and G4, if its switch were set) write a ledger hold outside the job row when the `pipelines` pool holds a grant, and the hold never times out while Tapis is unconfigured.
Under that precondition this is **not safe**, on staging as in production.
Every other gated path fails closed (G1 and G2 in A, G4 to G7) or is the runner path S3 is for (G3, G8 to G12), and without a Tapis credential no path sends a job, a credential or a launch value to a tenant (the status route's unauthenticated health call goes out only when `TAPIS_BASE_URL` is set).

**Verdict: safe with these extra conditions**, on top of the bar of card S3a:

- **C1.** Card S3c lands before any switch is set (a Tapis-executor run refused before any write while Tapis is unconfigured); until then, `admin compute status --json` shows `prerequisites.pipelines_pool_granted: false` on that environment, and nobody grants the `pipelines` pool.
- **C2.** `COMPUTE_PIPELINES_DISPATCH_ENABLED` stays absent (G4).
- **C3.** The owner applies the section 5 amendment before any switch, staging included.
- **C4.** No Tapis credential is set where `COMPUTE_ENABLED` is `1` until the #9 Tapis items are settled and the tenant sweep's bind selects `executor = 'tapis'` (section 3.1).
- **C5.** The first production runner uses Docker, or `--no-mount hostfs` is decided first for an Apptainer runner.
- **C6.** OQ2 option A (code default 2 and 0), or `policy.runners` stored only under section 6's rule; no rollback across the epic with a live runner row.
- **C7.** With #2116 merged, no account is granted compute access while Tapis is absent.
- **C8.** The owner expects the tenant sweep's error line (`errors=unconfigured`) every 30 minutes and daily while compute is on without Tapis, or the sweep is changed to return quietly when Tapis is unconfigured.

**Recommended default for Q6: option A, decide after S3a, with the bar.**
This reading agrees with the advisor's, with the conditions above added.

Notes for other owners: `GET /admin/compute/status` should report the runners switch (S6 or a follow-up; today only a runner dry run shows it); `BIND_TAPIS_JOB_SQL` and `handleUnbound` should select `executor = 'tapis'` (C4); a `created` Tapis job with no Tapis configuration should time out (the order at `backend/src/services/compute-lifecycle.ts:1624-1628`, also on #2116's head).

Not verified: anything in production or staging (no switch, secret, policy or grant was read; the owner commands are in sections 5 and 6); production's cron behavior is read from `main`'s code, not from its logs; the rollback Worker's handling of runner rows was read, not run.
