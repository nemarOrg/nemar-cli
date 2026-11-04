# Compute program: implementation notes

**Snapshot:** read from `dev` at `f7548395` on 2026-11-03, by read-only surveys of the codebase.
Line numbers drift; search for the named symbol when a line no longer matches.
These notes say where the closest existing pattern lives and which rule an implementer is most likely to break.
They bind nobody: where they disagree with an ADR, the ADR wins, and where they disagree with the code, the code is the fact.

This repository is public.
No Tapis tenant name, allocation identifier, account name, host detail or spend figure goes into code, comments, tests, ADRs, `.context` or pull requests.
Those live in the gated docs page `admin/design/compute-gateway` and in secrets.

## 1. Command-line interface

- **Registration.** `src/index.ts` adds groups with `program.addCommand(...)` (around lines 204-209).
  The smallest group template is `src/commands/sandbox.ts`.
  Admin subgroups follow `src/commands/admin-repull.ts` (`new Command("repull")` with `.command(...)` children in sibling files),
  registered by `adminCommand.addCommand(...)` near the end of `src/commands/admin.ts`.
  Do not import `admin.ts` from a subgroup file (import cycle); shared plumbing is `src/lib/admin-command.ts`.
- **Output.** Use `requireSignedIn(json)`, `failWith(...)`, `failMessage(...)` and `say(json)` from `src/lib/admin-command.ts`:
  they exit 1 on failure and keep stdout pure JSON under `--json`.
  Wrap every network-derived string in `plain()` (`src/lib/terminal-text.ts`).
  Every command takes `--json`.
  Help text is a `const X_HELP` template with an "Exit codes:" block; examples show only under `--help-all` (`src/lib/help.ts`).
  `src/lib/help-groups.ts` is optional; if a group is listed there, `test/help-tiers.unit.test.ts` checks the subcommands exist.
- **API client.** New `src/lib/api/compute.ts`, shaped like `src/lib/api/repull.ts`:
  `request<T>(path, init, true, zodSchema)` from `src/lib/api/client.ts`, which adds the bearer key and `X-CLI-Version`.
  Add the module to `MODULE_EXPORTS` in `test/api-export-surface.unit.test.ts`.
  Error bodies use `{ error: <sentence>, code: <word> }`; the CLI reads the word from `err.rawBody.code` (see `repullErrorCode`).
- **Polling.** There is no generic `--wait` helper.
  Copy `pollForDeviceToken` in `src/lib/device-login.ts` (AbortController, SIGINT handler removed in `finally`, abortable sleep, backoff, cap on consecutive 5xx)
  and the injectable `sleep`/`now` of `src/lib/repull/execute/settle.ts` so tests never wait.
- **Uploading a folder.** Do not depend on the AWS CLI or git-annex for compute.
  The backend returns presigned PUT URLs for a declared manifest (path, size), the CLI PUTs with `fetch`, then finalizes.
  Reuse the ignore and size logic of `src/lib/upload/plan.ts` and `src/lib/bids-filter.ts` where it fits.
  Presigning lives in `backend/src/services/s3.ts` (`generatePresignedPutUrls`, `generatePresignedGetUrl`, aws4fetch, path-traversal refusals), but those hardcode the AWS host; compute storage is Cloudflare R2 (owner, 2026-11-04), so compute signs with aws4fetch against the R2 S3 endpoint (region `auto`, presigned URLs at most 7 days) and reaches the buckets through R2 bindings, like the Neurobagel binding in `backend/wrangler-sccn.toml`.
- **Account state cache.** The CLI caches `serviceAccess` in `src/lib/config.ts`; absent means unknown, never "not granted".
  A new wire field is `.optional()` and never defaulted (`shared/contract/user.ts`).

## 2. Backend

- **Framework.** Hono 4, `@hono/zod-validator`, zod 3, raw D1 (`env.DB.prepare(...).bind(...)`, `db.batch([...])`).
  Export SQL as `*_SQL` constants so tests import the real statement.
- **Routers.** `backend/src/index.ts` mounts sub-apps on `api`, which is mounted at both `/` and `/nemar`; add `api.route("/compute", computeRoutes)` beside `/sandbox`.
  User routes follow `backend/src/routes/sandbox.ts` (`routes.use("*", authMiddleware)`).
  Admin routes register into the shared router in `backend/src/routes/admin/index.ts` through a `registerComputeAdminRoutes(admin)` function, and every handler is pinned in `test/admin-route-inventory.unit.test.ts`.
  Webhooks register in `backend/src/routes/webhooks/index.ts`, pinned by `test/webhooks-route-inventory.unit.test.ts`.
  A new top-level router has no inventory test; write one.
- **Auth middleware** (`backend/src/middleware/auth.ts`): `authMiddleware` (bearer first, then the session cookie), `adminMiddleware`, `ownerMiddleware`, `cookieOriginGuard` (required on cookie-authenticated writes).
- **Typed refusals.** `backend/src/routes/admin/upstream-repulls.ts` (`RepullRefusal`, `refusalBody`, `invalidBody` with `code: "invalid-body"` that names fields and never echoes values).
- **Migrations.** `backend/src/db/migrations/`, next file per the program's reserved ranges (README).
  Style: `0112_upstream_repull_automatic.sql` (header comment per column, CHECKs that are TRUE or FALSE and never NULL, partial unique indexes for "one live X", fixed-word code columns `NOT GLOB '*[^a-z0-9-]*'`, no foreign key to `datasets` or `users` that cascades).
  D1 rejects SQL that bun:sqlite accepts: keep GLOB patterns at 50 characters or fewer and compound SELECTs under 7 terms, and run `bun run migrations:d1-check` (not concurrently in one worktree).
  Migration test template: `backend/test/upstream-repull-dispatches-migration.test.ts` (bun:sqlite and Miniflare D1 via `test/helpers/miniflare-d1.ts`).
- **State machines.** `shared/repull-state.ts` is the template: import-free, statuses, terminal set, explicit transition table with self-edges, `canTransition`.
  Idempotent transitions: `transitionRepull` / `prepareTransition` in `backend/src/services/upstream-repull.ts` (check `from`, check the edge, conditional write, 409 `stale-status` or `bad-transition`).
- **Atomic claims.** `DISPATCH_OPEN_CLAIM_SQL` and `claimOpenDispatch` in `backend/src/services/upstream-repull-dispatch.ts`:
  one `INSERT ... SELECT ... WHERE (count or balance check)`, on D1's own clock, with a partial unique index for idempotency, `meta.changes` as the winner test, and a refused claim writes nothing.
  The rate-limit counters (`middleware/rateLimit.ts`) are per data centre, undercount and fail open: never use them as a quota.
- **Crons.** `scheduled()` in `backend/src/index.ts`.
  The `"*/30 * * * *"` branch has a production-only block for watchdogs; the daily block uses `prodOnlyJobs`.
  `DEV_CRON_ALLOWLIST` names the only jobs that run outside production; a new job stays off it unless it provably cannot mail a real person, dispatch GitHub work or touch production objects.
  Any exported service function whose name contains "sweep" needs an entry in `backend/test/cron-sweep-wiring.test.ts`.
  Self-fence inside the service with `isExactProduction(env)` (`services/repull-switches.ts`) or `isNonProductionEnv(env)` (`services/environment.ts`).
  Tick template: `runRepullAdvanceCron` in `backend/src/services/upstream-repull-advance.ts` (rows per tick, rotation, per-row try/catch recording only a fixed word and the error class, one log line per tick).
  Watchdog template: `sweepUnreportedDispatches` in `upstream-repull-dispatch.ts`.
- **Switches.** A dark-by-default switch copies `autoRepullEnabled()`: production AND exactly `"1"`, absent from `backend/wrangler-sccn.toml`, pinned by a test like `backend/test/repull-switches-flag.test.ts`.
- **Inbound webhooks.** `routes/webhooks/github.ts` reads the raw body once, verifies before any effect, and answers 200 with `dispatched:false` for an ignored event.
  Dedup is by unique keys on the downstream row, not a delivery-id table.
  For an unsigned sender, copy `routes/callbacks/repull-state.ts`: a bounded body (`readBoundedJsonObject`), a per-dispatch token minted as a domain-tagged HMAC (`services/github/callback-tokens.ts`), the same answer for every token refusal, and a read-back from the source before any transition.
  Hono's `logger()` prints the full URL, so a token in a URL lands in Worker logs: hash it at rest and expire it.
- **Outbound clients.** Token cache template: `services/github-auth.ts` (module-scope cache, refresh lead, shared in-flight promise, failed mint dropped).
  Errors: `HttpError` and `isRetryable` in `services/retry.ts`.
  Test base-URL override read at call time from `globalThis`: `GITHUB_API()` in `services/github/shared.ts`, `EZID_BASE()` in `services/ezid.ts`; add `TAPIS_BASE()` the same way.
- **Secrets and vars.** Optional fields in `backend/src/types/bindings.ts`; the comment block of secret names in `wrangler-sccn.toml`; `[vars]` and `[env.dev.vars]` do not inherit, so every var needs both.
  The owner sets secrets (`bunx cfman wrangler --account sccn secret put <NAME> -c backend/wrangler-sccn.toml [--env dev]`); an agent never does.
  Dev and production use separate Tapis credentials: dev D1 shares real users and the GitHub org.
- **Email.** User mail template: `sendUploadAccessGrantedEmail` in `backend/src/services/email.ts`, called inside try/catch so mail never fails the action.
  Admin mail goes through `getAdminEmailsForCategory` (production-only fence); a new category touches `EmailPreferences`, `DEFAULT_EMAIL_PREFERENCES` and `parseEmailPreferences` (`!== false` pattern).
  Mail links to a page, never to a file or a result URL.
- **Audit rows.** `auditLogStatement` / `AUDIT_LOG_INSERT_SQL` in `backend/src/db/audit-log.ts`, non-fatal, shape of the event only.
- **Data plane.** A job reads public datasets through `GET <api>/data/<id>/<version>/manifest.json`: entries `{path, size, checksum?, bytes_url, url}` (`shared/contract/data-plane.ts`), at most 38,000 entries (ADR 0095).
  Private datasets are not on the data plane and are out of scope for the first release.

## 3. Accounts, access and cascades (blueprint for compute access)

- **Upload access, the template.** Columns on `users`: `service_access`, `service_access_granted_at/by` (migration `0062`), `upload_access_requested_at`, `upload_access_notified_at` (`0076`).
  Request route `POST /users/me/upload-access/request` in `backend/src/routes/users.ts`: 409 `already_approved`, then the already-requested short-circuit (re-mail when `notified_at` is NULL), then preconditions (`checkUploadAccessRequest` in `services/upload-access.ts`), then a conditional UPDATE whose `meta.changes` decides who mails.
  Approval and revocation in `backend/src/routes/admin/users.ts` (`finalizeApproval`, `finalizeRevocation`), with by-id twins because web accounts have no username.
- **Do not reuse `service_access` for compute.** ADR 0040 pins `status='approved'` if and only if `service_access=1`. Compute gets its own columns.
- **Approval is a person's decision** (ADR 0042: export-control judgement). Approval is the only writer of the grant.
- **Copy and gaps.** Every sentence about access lives in `shared/contract/account-copy.ts` and is transcribed by the website (`test/account-copy-parity.test.ts`); `cli.`-prefixed keys are the CLI's own.
  `GapBlock` in `shared/contract/profile-gaps.ts` gains `"compute_access"`, with `gap.blocks.compute_access` and `gap.blocks.noun.compute_access` copy keys.
- **ORCID.** `users.orcid` and `users.orcid_verified` exist, but ADR 0106 lets an owner set `orcid_verified` without a sign-in.
  "Proven by an ORCID sign-in" means an `oauth_identities` row for provider ORCID.
- **Location.** `users.city`, `users.country` (free text), `users.affiliation` (migration `0052`).
- **Kinds.** `users.account_kind` is `person|service|test` (ADR 0048); only an owner sets it; service accounts get owner-minted keys (`nemar admin keys create`).
- **Cascades.** Credential-ending paths: `finalizeRevocation`, the owner soft delete (`tombstoneUserCascade` in `backend/src/db/user-tombstone.ts`), role demotion, key revocation (`revokeDocsCredentials` in `services/docs-auth.ts`).
  `DOCS_GRANTS_PURGE_SQL` and `PRIVATE_GRANTS_PURGE_SQL` name their callers in docblocks, and those counts are load-bearing: add a line for every new path.
  A network call (a Tapis cancel) never runs inside the batch; record intent in the batch and let a retried sweep do the call, as the GitHub collaborator sweep does.
  `services/test-account-sweep.ts` has its own clear list.
- **Keys have no scopes.** A NEMAR API key carries its user's full authority. OIDC access tokens must be refused by every existing route.
- **CORS and cookie trust.** `isNemarWebOrigin` (`services/cors-origins.ts`) and `isAllowedOrigin` (`services/web-session.ts`, several call sites) both trust `*.nemar.org`.
  The session cookie is `nemar_session`, `Domain=app.nemar.org`, `SameSite=Lax` (`routes/auth-orcid.ts`), without a `__Host-` prefix.
- **Handoff precedents.** Docs (ADR 0056) and private site (ADR 0079): a 60-second hashed code, single use by a DELETE gated on the row, a `state` cookie against login CSRF (ADR 0079 decision 3), RPC exchange for same-account Workers (ADR 0078).

## 4. Tests

- **No mocks of NEMAR logic** (`.rules/testing.md`). Real bun:sqlite with every migration (`freshDb()` and `realD1(db)` in `backend/test/helpers/d1.ts`), the real middleware and routes through `app.fetch`.
- **Outbound services** are a real `Bun.serve()` stand-in plus the `globalThis.NEMAR_*_API_URL` override: `backend/test/helpers/repull-github-standin.ts`, `openneuro-standin.ts`.
  For Tapis, build the stand-in from the request and response examples in Tapis's published OpenAPI specifications (`tapis-project/openapi-jobs`, `openapi-apps`, `openapi-systems`, `openapi-notifications`, `tokens-api`), and say in the test file that no response was recorded from a real tenant yet.
- **CLI tests** spawn the real CLI against a `Bun.serve` of the real route over `freshDb`, with `TEST_API_URL`, a temporary `NEMAR_CONFIG_DIR`, `NEMAR_NO_UPDATE_CHECK=1`, and `GET /notices` answered `{notices: []}` (template: `test/admin-repull-auto-cli.test.ts`).
- **Prove each test fails** by mutating the line it guards.
- `bun test` from the root runs `test/` and `backend/test/` in one process: restore `process.env` and `globalThis` overrides in `afterAll`.

## 5. Tapis, Expanse and ACCESS facts the code depends on

From Tapis v3 documentation and OpenAPI specifications, and the SDSC Expanse user guide, read 2026-11-03. Items marked unverified wait on the tenant operator.

- **Jobs.** `POST /v3/jobs/submit` (required `name`, `appId`, `appVersion`; optional `owner`, `execSystemLogicalQueue`, `nodeCount`, `coresPerNode`, `memoryMB`, `maxMinutes`, `fileInputs`, `parameterSet` with `appArgs`, `containerArgs`, `schedulerOptions`, `envVariables`, `archiveFilter`; `archiveSystemId`, `archiveSystemDir`, `subscriptions`, `tags`, `notes` up to 65,536 bytes).
  `GET /v3/jobs/{uuid}`, `/status`, `/history`, `/output/list/{path}`, `/output/download/{path}`, `POST /{uuid}/cancel`, `GET|POST /v3/jobs/search` (SQL-like, e.g. `tags IN ('x')`), `listType` `MY_JOBS|SHARED_JOBS|ALL_JOBS`, `POST /v3/jobs/subscribe/{uuid}`, hide/unhide, annotations (tags are editable by the owner).
  Statuses: `PENDING`, `PROCESSING_INPUTS`, `STAGING_INPUTS`, `STAGING_JOB`, `SUBMITTING_JOB`, `QUEUED`, `RUNNING`, `ARCHIVING`, `FINISHED`, `CANCELLED`, `FAILED`, `BLOCKED`, `PAUSED`.
  Record fields: `uuid`, `owner`, `createdby`, `status`, `created`, `ended`, `remoteSubmitted`, `remoteStarted`, `remoteEnded`, `remoteJobId` (the Slurm id), `remoteQueue`, resources.
  No idempotency key; no charged SU; tenant-wide listing for an administrator is unverified.
- **Apps.** Runtimes `DOCKER`, `SINGULARITY`, `ZIP`; `jobType` `BATCH` or `FORK`; `locked` versions; `strictFileInputs`; `inputMode` `FIXED|REQUIRED|INCLUDE_ON_DEMAND|INCLUDE_BY_DEFAULT`; ZIP runs `./tapisjob_app.sh` on the host and reads `tapisjob.exitcode`; stdout and stderr go to `tapisjob.out`.
- **Systems.** Static `effectiveUserId` maps every Tapis user to one host account (the community account); logical queues carry `maxNodeCount`, `maxCoresPerNode`, `maxMemoryMB`, `maxMinutes`, `maxJobsPerUser`; S3 systems take a static access key (no session token).
- **Notifications.** Unsigned webhooks, `User-Agent: Tapis/v3`, CloudEvents-shaped, one per status change, `seriesSeqCount` for order, subscription `ttlMinutes` default one week, retry policy undocumented.
- **Auth.** Tokens in `X-Tapis-Token`; no client-credentials grant; `POST /v3/tokens` mints user tokens for a service credential (the Drupal `tapis_auth` pattern); which credential NEMAR gets is a question for the operator.
- **Expanse SU.** 1 SU = 1 core-hour (2 GB per core) or 1 GPU-hour (92 GB per GPU); charged on reservation with a 1 SU minimum; whole `compute` node 128 per hour, whole `gpu` node 4 per hour; `preempt` 0.8 and not refunded; 48-hour limit except preempt (7 days); per-account concurrency caps (for example 24 running GPUs in `gpu-shared`).
- **ACCESS attribution.** `POST https://allocations-api.access-ci.org/acdb/gateway/v2/job_attributes` with `jobid`, `submittime`, `xsederesourcename`, `gatewayuser`; `debug` for tests; the key is shown once.

## 6. Words and contracts shipped in phase A1 (ADR 0118)

Import these; never declare a second copy of a word, a number or a state.
A migration that has to spell a word in a `CHECK` copies it from here and a test compares the two.

- **Words and states.** `shared/compute-state.ts`, import-free: the ten job states and the only edges between them (forward and self-edges, `unreported` reachable from every live state), `stateFromTapisStatus` (an unknown status is null, never guessed), the launcher and platform failure codes with `isPlatformFailure(code, detail)` and `failureCodeFromTapisCondition`, the refusal codes with `COMPUTE_REFUSAL_STATUS` (the one table of HTTP statuses), and the ledger kinds, sources, kinds, job flags and cancel reasons.
  Every word is snake_case and matches `COMPUTE_WORD_RE`.
- **Money, specification and policy.** `shared/contract/compute.ts` (zod; re-exported from `shared/contract/index.ts`): `JobSpecSchema`, `PARTITIONS`, `RATE_TABLE_V1`, `estimateSuMilli` (the hold, from a specification), `suMilliFor` (a charge, from Tapis's resources and seconds), `parseSuToMilli`, `formatSu`, `ComputePolicySchema` with the frozen `DEFAULT_COMPUTE_POLICY`, and the shapes of the launcher's own files.
  Wire keys of a specification are snake_case (`memory_mb`); keys of the policy are camelCase.
  A partition with a ceiling in the policy is offered to people; one without is for NEMAR's pipelines only.
- **Launcher.** `shared/contract/compute-launch.ts` and `compute-launch.schema.json`: the launch specification `nemar.launch-spec.v1` (`encodeLaunchSpec` writes it within 64 KiB), the bundle, outputs and outputs-response shapes, the results-bucket keys (`resultsOutputKey`, `resultsLauncherKey`) and, in the schema's `$defs`, `result`, `manifest` and `provenance`.
  The schema is shared byte for byte with `nemarOrg/nemar-process`; a test here holds it to the zod schema, and whichever repository merges first writes it.
  In the records bucket the launcher's `manifest.json` is kept as `result-manifest.json` (`RECORDS_RESULT_MANIFEST_FILE`; phase A3 builds the key); on the node and in the results bucket it is `manifest.json`, and there is no `failure.json`.
  The two responses the launcher reads are open (`.passthrough()`, and no `additionalProperties: false` in the schema); every request and every document is closed.
  `encodeLaunchSpec` writes ASCII-only JSON and checks the 64 KiB cap after escaping, and `launchSpecFits(job)` tells the Worker whether a job launches before it takes a hold.
  A valid job specification always fits the 64 KiB and is well formed; the dataset version tag is the one launch rule JobSpecSchema does not enforce, so the Worker and the CLI must run `launchSpecFits` (and refuse with `invalid_spec`, naming the field `datasetVersionWithoutTag` finds, `datasets.<i>.version`) BEFORE the hold.
  Its schema also refuses a lone surrogate in the entry, a command item, an argument or an include pattern (`computeIsWellFormed`), because no process argument can carry one.
  Two digests: the job row's `spec_digest` (SHA-256 of the exact bytes of `records/<id>/spec.json`, phase A3) and the launcher's `launch_spec_digest` (SHA-256 of the exact raw bytes of the `NEMAR_LAUNCH_SPEC` value, hashed before parsing, recorded in `provenance.json` and stored on the job row by phase A5).
- **Launcher details and who pays (phase A1b).** `shared/compute-state.ts` declares `LAUNCHER_DETAILS` (each launcher code with the fixed-word details it may emit) and `PLATFORM_LAUNCHER_DETAILS` (the subset that NEMAR, the node, the runtime or the contract caused, which is refunded).
  `isPlatformFailure(code, detail)`: for a launcher code, a platform detail is a platform failure even under `runtime_error`, and a submitter detail (`unsafe_archive`, `archive_too_large`, `bad_include`, `too_many_files`, `too_many_bytes`, `outputs_unreadable`, `terminated`, `entry_failed`, and the result refusal details) is not one even under `code_fetch_failed` or `dataset_fetch_failed`.
  A missing or undeclared detail keeps the old behaviour: the code alone decides, so a transport word such as `http_500` under a fetch code is still refunded.
  The rule for any new word: platform if and only if a submitter cannot cause it with a valid specification and bundle and a dataset eligible at submit (the Worker refuses, with `dataset_not_eligible`, any dataset not public and published, any version not published and any manifest over 38,000 entries, so `dataset_not_found` and the manifest-too-large case stay the platform's).
  The Worker's own cancel record overrules the launcher's `terminated` detail (the launcher cannot tell a cancel by the person from a Slurm preemption).
  The default for an undeclared `runtime_error` detail is deliberate: charged, the unfavourable direction for a fault NEMAR caused; a launcher change that adds a detail word must land with its entry here in the same pair of pull requests, and the launcher's drift test compares the lists per code.
  Known launcher limitations, the launcher's matter and not changed here: `entry_failed`, `unsafe_archive` raised for an `OSError` creating a member (a node fault: the launcher is to use `disk_error`), and the Worker routes' own refusal code words used as details under the upload codes.
- **Launch specification, as the launcher reads it (phase A1b).** `LAUNCHER_ENV.SIF_ROOT` is `NEMAR_SIF_ROOT`, required: the launcher has no fallback and ends `image_missing` when it is unset.
  `image.sif` is exactly `<64 lowercase hex>.sif`, the basename of the SIF built from the image's digest; the hex of `image.digest` plus `.sif` must equal it, and `image.uri` must end with `@sha256:` and that same hex: two rules only zod enforces (`sifFileNameForDigest` and refinements on `LaunchSpecSchema`), listed apart in the differential tests; the content hash is not verified.
  `datasets[].version` is the data-plane tag (`latest` or `v<major>.<minor>.<patch>`, at most 64 characters, so a bare job version is at most 63: the provenance `staging[].version` the launcher writes holds 64); the Worker's builder calls `dataTagForVersion(version)` (`1.0.2` gives `v1.0.2`, a tag or `latest` is unchanged, anything else is null), and `launchSpecFits` is false for a job whose dataset version has no tag; `datasetVersionWithoutTag(datasets)` returns the first such field as `datasets.<i>.version`, so the Worker and the CLI refuse with `invalid_spec` naming it.
  The `include` dialect: matched against manifest paths relative to the dataset root; `**/` matches zero or more directories (so `a/**/b` matches `a/b`); `**` elsewhere matches any run of characters including `/`; `*` and `?` stay inside one path segment; `[abc]`, `[a-c]` and `[!abc]` are classes; a character class never matches `/`, so like `*` and `?` it stays inside one path segment, and a negated class `[!a]` matches any single character except `a` and `/`; an unterminated `[` is a literal `[`; an empty class `[]` and an inverted range such as `[z-a]` are refused, and `bad_include` is exactly the set of patterns this dialect refuses; case-sensitive; no escapes; a matcher must run in time linear in pattern length times path length (no backtracking); no cap on wildcards.
  `includePatternProblem(pattern)` returns `empty_class`, `inverted_range` or null, and `JobSpecSchema` refuses such a pattern at submit, naming `datasets.<i>.include.<j>`.
  The entry semantics: `runtime: python` with an `entry` runs `python /code/<entry>` followed by `args`; a `command` runs as given with `args` appended; `runtime: image` with an `entry` runs `/code/<entry>` directly (it needs the executable bit, which the bundle packer must preserve); the runtime image must provide `python` on its PATH for the python runtime; a bundle's member names may carry a leading `./`, and absolute names, `..`, links, devices and named pipes (first in, first out, or FIFOs) are refused by the launcher.
  Their texts are `COMPUTE_ENTRY_DESCRIPTION`, `COMPUTE_COMMAND_DESCRIPTION`, `COMPUTE_ARGS_DESCRIPTION` and `COMPUTE_INCLUDE_DESCRIPTION`, carried by zod and, word for word, by the schema.
- **Header.** `shared/compute-header.ts`, import-free: `parseJobHeader` for a `# /// nemar` or `% /// nemar` block or a whole `nemar-job.toml` (a small TOML subset, every refusal a fixed code with its line), and `headerToSpecFields`, which maps `memory`, `time` and `id@version` onto specification fields.

## 7. Ledger and owner policy shipped in phase A2 (ADR 0118, amendment of 2026-11-04)

Call these; never write a second statement that moves a total.

- **Tables** (migration `0114_compute_ledger.sql`): `compute_policy` (one immutable row per version), `compute_pools` (holder kind `account|platform|partner`, holder ref, pool `cpu|gpu`, three totals; the four platform pools `pipelines` and `people`, each cpu and gpu, are seeded) and `compute_ledger` (the eight entry kinds, append-only).
  The trigger `compute_ledger_apply` is the one writer of a pool's totals; a test reads every source file and migration for another.
  The table itself refuses, under every conflict clause, an entry that would take a total outside 0 to 2^53 - 1, a hold that would take available below 0, and a release or charge that does not close its own hold.
  A hold, release, charge, overrun and a job's final-settlement adjustment on an account or partner pool MUST name the platform `people` pool of the same word as its budget (`budgetPoolId`), or the table raises; a budget that is named is always that pool, and an entry on a platform pool names none.
  A refund and an adjustment of a charge that names no job are free: they may name the `people` budget or none, because whether they credit it back is the owner's open decision (below) and a code choice, not a schema rule.
  A job has one hold; a hold is closed once; a job's final settlement is one `adjust` entry that carries the job (its charged delta may be 0).
  Retention and anonymisation of `holder_ref` and `actor_user_id` are phase A7's (#2012), in its own migration with a narrowly scoped exception; nothing here removes a row.
- **Service** (`backend/src/services/compute-ledger.ts`, every statement exported as `*_SQL`): `ensurePool`, `holdStatements` and `placeHold` (the one conditional INSERT, with `extraGuards` for phase A3's job-count guards: boolean SQL with plain `?` placeholders and its values, ANDed into the same WHERE), `releaseHold`, `settleProvisional` (a `charge` and any `overrun` in one statement), `settleFinal` (one `adjust`, once per job, refused after a refund), `refundJob`, `grantPool`, `adjustPool`, `expireUnused` and `availableMilli` (may be negative).
  Each answers `{ ok: false, code }` for a refusal and writes nothing; `ComputeLedgerError` (`invalid_argument`, `idempotency_conflict`, `pool_not_found`) is thrown for what is not a refusal.
  The hold's refusals are `insufficient_balance`, `suspended`, `platform_budget_exhausted` and `guard_refused` (the words of `shared/compute-state.ts`).
  A hold takes no key: its key is the job's (`holdKey(jobId)`), so a hold of the same job again is a replay while the hold is open, a conflict if the request differs, and `hold_closed` (`closedBy` says `released` or `settled`) once the hold was released or settled: a caller must not read a replay as a hold that is live.
  A closing step replayed returns its entry with `replayed: true`; `hold_closed` says which kind closed the hold (`closedBy`).
  The keys the service writes are `holdKey`, `finalKey` and `refundKey` of the job and `hold:<id>:<step>` of the hold; a caller's key may not start with `job:` or `hold:`; an administrator's route stores its header key behind `adminKey(kind, actorId, key)`.
- **Policy** (`compute-policy.ts`): `getPolicy` (strict, default only when there is no row, `ComputePolicyUnreadable` for a row it cannot parse, which a route answers 503) and `putPolicy` (owner, not deleted and active, checked in the statement; strict schema; audit in the same batch).
  A new policy key is added as optional.
- **Routes** (`routes/admin/compute.ts`) and **CLI** (`nemar admin compute policy|pool`): errors are `{ error, code }` with the words and statuses of `shared/contract/compute-admin.ts`, whose response schemas are open.
  Interim owner rule, easy to loosen: an administrator corrects an account's grant, and only an owner corrects its charge or a platform budget.
  The budget semantics of a charge correction and of a refund are the repository owner's decision: option A, the `people` budget records consumption only and a refund or a correction moves the person's pool alone; option B, they also credit the budget back.
  Today's code is option B (both move the budget with the pool), and choosing option A changes the code, not the migration.
  `frozen` has no writer yet: whoever suspends access (phase D, A8) sets it, and a hold reads it (the holder's own pool; a frozen budget pool does not refuse a hold).
- **Not here**: the job table, the job-count guards on a hold (phase A3), the callers of settle (phases A5 and A7), automatic renewal and the default grant at approval (Epic D), mail.

## 8. Job index, records and the two buckets shipped in phase A3 (ADR 0118, amendment of 2026-11-04, #2008)

Call these; never write a second statement that makes a job, and never reach a compute bucket by any other path.

- **Tables** (migration `0115_compute_jobs.sql`): `compute_jobs` (one index row per job: the account id and fixed words only, no foreign key, shape checks for the words a later epic may add) and `compute_gateway_users` (the ACCESS pseudonym, `gw_` and 20 base32 characters, random and stored, never rotated and never reused; the triggers say so).
  Every state, source, kind and pool is an `IN` list that a test compares with `shared/compute-state.ts`; `failure_code`, `failure_detail`, `cancel_reason` and `partition` are checked by shape, so a new word needs no rebuild.
  `state = 'failed'` if and only if a failure code is set.
  `launch_spec_digest` is not here: it is phase A5's migration 0116.
- **`createJob(env, input)`** (`services/compute-jobs.ts`): one batch of the ledger's hold (`holdStatements`, with the person's live-job limit as a guard read inside the same statement), the pseudonym's `INSERT OR IGNORE` and the job's INSERT, the last two gated on `EXISTS` of the hold row, so a refused hold leaves no row, no entry, no pseudonym and no object.
  It validates before any hold exists: the strict schema, the dataset version tags (`datasetVersionWithoutTag`, `launchSpecFits`), the owner's per-job ceilings and the partitions offered to people (not for a pipeline job), and the bundle's size.
  It returns the job, or a refusal word (`invalid_spec` naming the field, `over_job_limit`, `partition_not_offered`, `bundle_too_large`, `insufficient_balance`, `suspended`, `platform_budget_exhausted`, `over_concurrency`, `compute_disabled`).
  It throws `ComputeJobError` for a key reused for another request (`idempotency_conflict`), an argument the table cannot take and a missing platform pool.
  A retried `(account, key)` returns the existing job and finishes its records; two requests with one key racing make one job.
  The routes (#2010, D3, D4) validate what is theirs (the runtime, the registries an image may come from, dataset eligibility) before they call it.
  What it does not do: it moves no state (the `uploading` state and every edge after `created` are phase A5's), submits nothing to Tapis, and applies no pipeline cap (a daily count and a live count per pool are the dispatch phase's, as extra guards).
- **Records** (`services/compute-records.ts`): `records/<id>/identity.json`, `spec.json`, `submitted/bundle.tar.gz` (or `submitted/<path>` per partner file), `bundle-manifest.json`, `result-manifest.json` (the launcher's `manifest.json`, renamed; there is no `failure.json`), `provenance.json`, `result.json`; `logs/<id>/tapisjob.out` and `launcher.log`; `incoming/<id>/bundle.tar.gz` or `incoming/<id>/<path>`.
  The builders are `recordKey`, `submittedKey`, `logKey` and `incomingKey`; the results bucket's keys are the contract's `resultsOutputKey` and `resultsLauncherKey`.
  A record is written once (create-only), after the job's batch has committed, and never rewritten; the bucket's lock is configuration, never code.
  `records_written_at` is set by `createJob` for a job that uploads nothing, and by `finalizeBundle` or `finalizeSubmittedFiles` (a partner batch job's own files) after the copy; phase A5 refuses to submit without it.
- **Uploads**: `presignIncomingUploads` (one-hour PUTs; a bundle job gets one for `bundle.tar.gz`, the size and digest of its recorded specification; a partner gets one per file, at most `PARTNER_FILES_MAX`; traversal in any encoding is refused), then `finalizeBundle` or `finalizeSubmittedFiles` (the declared manifest is validated for the owner's limits and traversal, the uploaded size must match, a mismatch deletes nothing, and only after the job and its hold have been read back is the one `CopyObject` made; idempotent, resumable, and an object already at the destination is never overwritten).
  The addresses are asked again after expiry, and never after the job's records are written.
- **Reads**: `presignBundleRead(env, jobId)` is the launcher's 10-minute address for the job's own bundle and no other key.
  `readRecordObject(env, db, { actor, jobId, name, reason })` is owner-only, takes a reason of 8 to 200 characters, writes the `compute.record.read` audit row before any byte is read, is refused if that write fails, and returns the bytes of a JSON record or a 5-minute presigned GET of one submitted file or log.
- **The S3 interface** (`services/compute-s3.ts`): R2 has no copy and no presigned address through a binding, so `computeS3(env)` (null when anything is missing) signs with aws4fetch, region `auto`, path style.
  The endpoint is `globalThis.NEMAR_COMPUTE_S3_URL` when set, else the Worker secret `COMPUTE_R2_S3_ENDPOINT`; `S3_ENDPOINT_URL` is never read here.
  A key is encoded segment by segment and judged by the contract's own path predicate, never by `assertValidS3Key` (it refuses `a..b.csv` and throws on `100%.txt`).
  An expiry above seven days is refused.
  The checksum header `x-amz-checksum-sha256` is signed for an incoming PUT when a digest is given and is not verified against the real R2; the object's size, read back through the binding, is the bound the Worker relies on.
- **The outputs route's body cap** (`outputsBodyLimitBytes(maxFiles)`, for #2010): the owner's policy lets `maxFiles` reach 100,000 and the launcher caps its own request at 1 MiB, so the Worker derives the cap from `maxFiles` (never below 1 MiB, never above 64 MiB) and does not bound `maxFiles`; the launcher's 1 MiB is the tighter bound today.
- **Test seams**: `backend/test/helpers/compute-s3-standin.ts` is a real server speaking path-style S3 over the same Miniflare R2 buckets the bindings use (it verifies the SigV4 signature and the expiry, enforces the checksum header, and logs every request); `compute-harness.ts` assembles it with the bindings and a production-flagged environment; `compute-seed.ts` seeds users, pools and policies through the real services.
  Miniflare does not enforce bucket lock.
- **Not here**: the routes and the CLI that read records (#2012), the outputs and bundle routes and the job lifecycle (#2010), the results bucket's writer, the retention sweep and the anonymisation of a deleted account's rows (#2012), compute access (Epic D).
