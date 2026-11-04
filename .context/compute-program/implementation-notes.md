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
