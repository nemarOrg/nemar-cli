# Card S3c: An administrator's Tapis pipeline run fails closed while Tapis is unconfigured

Status: ready
Tier: worker-hard
Timebox: M, 4 hours; escalate at 6 hours
Needs: none
Depends: none beyond the epic head. S1 has landed (#2164, epic head `25f3dab9`), and every line below is read at that head. It collides on files, not on logic: Q0b edits `backend/src/services/compute-pipeline.ts`, `backend/src/routes/admin/compute-pipeline.ts`, `shared/contract/compute-admin.ts` and `src/commands/admin-compute-pipeline.ts`; S6 edits `shared/contract/compute-admin.ts`. Nothing here touches `backend/src/services/compute-runner-queue.ts`. Whichever merges second takes the base in and reruns its gates.
Branch: feature/pc-s3c-tapis-unconfigured-fail-closed
Worktree: $WT/nemar-cli-pc-s3c (base origin/feature/portable-compute-epic)
Plan: S3a's inventory (`.context/plans/portable-compute/s3a-switch-inventory.md` on PR #2165, branch `docs/pc-s3a-switch-inventory`): rows G1, G2 and G4 of section 2, probes P1 and P2 of section 7, condition C1 of section 8; ADR 0118 decision 10 (every compute word declared once) and its A5 amendment item 4; ADR 0121 decision 1
Review: one Opus reviewer (not the author); focus: authorization and accounting: no path with `COMPUTE_ENABLED` on and no Tapis credential writes a hold, a ledger row, a job row or a stamp; every existing refusal keeps its code and status; the 30-minute tick, the submit, the cancel path and the runner path are unchanged; with Tapis configured every answer is as before, except the one `tapis_configured` key of a Tapis dry run

## Goal

With `COMPUTE_ENABLED` on and no usable Tapis configuration, a pipeline run whose executor is `tapis` (`nemar-floor`, one dataset or `eligible`, from the administrator's route, the daily dispatcher or any other caller of the service) is refused with `tapis_unconfigured` (503) before any stamp, hold, ledger entry, job row, record or audit row is written, and nothing reaches a tenant; a runner run and a run with Tapis configured behave exactly as today.

## Context

- The defect (S3a section 2, G1; S3a cites the lines at `02113b16`, this card at `25f3dab9`): `dispatchPipelineJob` reads the runtime image (`backend/src/services/compute-pipeline.ts:639-640`) and the service account (`:641-642`), claims a stamp (`:666`) and calls `createJob` (`:688`), which takes a hold on the `pipelines` pool; its one submit attempt (`:784`) and every later tick then answer `unconfigured`, because `submitComputeJob` returns at `backend/src/services/compute-lifecycle.ts:1627-1628`, before `submitLeased` acts on the overdue check (`:1667`). The hold never times out; only an administrator's cancel releases it (`:1951`).
- `tapisAccess` (`backend/src/services/compute-lifecycle.ts:517-526`) is the one reading of "Tapis is usable": null when `tapisConfig(env).unconfigured` or when the configured owner fails `TAPIS_OWNER_RE`. It reads configuration only and makes no request.
- The route: `backend/src/routes/admin/compute-pipeline.ts` (executor default `:298`, dry run `:310`, the switch `:321`, a single dataset `:325-356` with its audit row at `:333`, `eligible` from `:358`); its `SENTENCES` table and the compile-time checks below it (`noMissingSentence`, `everyWordHasAStatus`).
- The words: `PipelineRefusal` (`backend/src/services/compute-pipeline.ts:187-208`), `STOPS_A_RUN` (`:1575`), `ENDS_THE_RUN` (`backend/src/services/compute-pipeline-dispatch.ts:78-84`), `COMPUTE_PIPELINE_ONLY_REFUSAL_STATUS` (`shared/contract/compute-admin.ts:530-557`), the dry run's `config` in `ComputePipelineRunResponseSchema` (`shared/contract/compute-admin.ts:647-655`) and `DryRunConfig` (`backend/src/services/compute-pipeline.ts:1182-1191`).
- Callers of `dispatchPipelineJob`: the route (`backend/src/routes/admin/compute-pipeline.ts:326`) and `dispatchEligible` (`backend/src/services/compute-pipeline.ts:1666`), which the route (`:358`) and the daily dispatcher (`runComputePipelineDispatchCron`) call.
- Tests to build on: `backend/test/compute-pipeline-routes.test.ts` (the real admin router through `makeComputeApp` and `startLifecycleFixture`), `backend/test/compute-pipeline.test.ts` (its "what a run refuses, before it writes anything" group), `backend/test/compute-runner-jobs.test.ts` group (d) (a runner run through the real route), the helpers `backend/test/helpers/compute-pipeline-fixture.ts` (`seedPipelinesAccount`, `fundPipelines`, `seedEegDataset`) and `backend/test/helpers/d1.ts` (`freshDb()`). The lifecycle fixture's `env()` is production with compute on, Tapis configured against the stand-in, and `COMPUTE_RUNTIME_IMAGE` set; Tapis is made unusable with `fx.env({ TAPIS_USERNAME: undefined, TAPIS_PASSWORD: undefined, TAPIS_SERVICE_TOKEN: undefined })`, and `fx.tapis.log` records every request the stand-in saw.
- `backend/test/compute-pipeline.test.ts:461-471` expects `submit: "unconfigured"` with `PRESCREEN_CALLBACK_SECRET` unset and Tapis configured: that is the launch's configuration, not Tapis's, and that test stays as it is.
- Until this card lands, an operator or the owner keeps staging and production safe by hand (S3a section 8, C1, the same gate as the S3b and S2S cards): before any compute switch is set on an environment, `admin compute status --json` there shows `prerequisites.pipelines_pool_granted: false` (production: `env -u TEST_API_URL bun run src/index.ts admin compute status --json` as the owner; staging: the same with `TEST_API_URL=$STAGING_API` and a staging configuration), and nobody funds the `pipelines` platform pool on an environment whose Worker has no Tapis credential, neither by a grant (`admin compute pool grant ... --platform pipelines`, `backend/src/routes/admin/compute.ts:481`) nor by the owner's adjustment with `target: "granted"` (`POST /admin/compute/pools/platform/:key/adjust`, `:485`, `:365-366`).

## Scope

- `backend/src/services/compute-lifecycle.ts` (one exported predicate beside `tapisAccess`, nothing else), `backend/src/services/compute-pipeline.ts`, `backend/src/services/compute-pipeline-dispatch.ts` (`ENDS_THE_RUN` only), `backend/src/routes/admin/compute-pipeline.ts`, `shared/contract/compute-admin.ts`, `src/commands/admin-compute-pipeline.ts` (the dry run's needs line only).
- Tests: new `backend/test/compute-pipeline-tapis-unconfigured.test.ts`; one case added to group (d) of `backend/test/compute-runner-jobs.test.ts`; a pinned word list that must gain the new word (for example `backend/test/compute-tenant-ceiling.test.ts`, `test/compute-admin-contract.unit.test.ts`, `test/admin-compute-pipeline-cli.test.ts`), and nothing else in them.
- Not: `createJob`, the ledger, `submitComputeJob`, `submitLeased`, `driveCancel`, the advance tick, the tenant sweep, the runner queue, `compute-switches.ts`, any `computeEnabled(` call site (`backend/test/compute-source-scan.test.ts` passes unchanged), `backend/wrangler-sccn.toml`, an ADR (the owner's amendment drafted in S3a section 5 names this card).

## Decided design

Settled:
1. **The predicate.** `export function tapisSubmitConfigured(env: Bindings): boolean`, defined as `tapisAccess(env, TICK_READ) !== null`, beside `tapisAccess` in `backend/src/services/compute-lifecycle.ts`, with a docblock saying it is the gate's and the submitter's one definition (`submitComputeJob` at `:1627-1628` answers `unconfigured` exactly when it is false). It never makes a request.
2. **The word, declared once.** `tapis_unconfigured: 503` in `COMPUTE_PIPELINE_ONLY_REFUSAL_STATUS`, with a doc comment saying a Tapis-executor run is refused because the Worker has no usable Tapis configuration and nothing was written; the member `"tapis_unconfigured"` in `PipelineRefusal`; the sentence `"Tapis is not configured on this Worker, so a Tapis job cannot be submitted; nothing was written."` in the route's `SENTENCES` (the existing compile-time checks then require both). It joins `STOPS_A_RUN` and `ENDS_THE_RUN` (it is the same for every dataset, recipe and pool).
3. **The service check, so every caller is covered.** In `dispatchPipelineJob`, immediately after the runner-switch check (`backend/src/services/compute-pipeline.ts:628-630`) and before `tupleHeld` (`:632`): `if (executor === "tapis" && !tapisSubmitConfigured(env)) return fail("tapis_unconfigured", datasetId);`. It therefore runs after `compute_disabled`, `recipe_not_automatic`, `recipe_placeholder`, the executor check and `runners_disabled`, which keep their order and codes, and before every read of the dataset and every write. The daily dispatcher and `dispatchEligible` reach it through their first candidate and stop there (`STOPS_A_RUN`, `ENDS_THE_RUN`).
4. **The route check, so the administrator's answer is clean.** In the route, on the line after `if (!computeEnabled(c.env)) return refuse(c, "compute_disabled");` (`backend/src/routes/admin/compute-pipeline.ts:321`): `if (executor === "tapis" && !tapisSubmitConfigured(c.env)) return refuse(c, "tapis_unconfigured");`. A live run, one dataset or `eligible`, is answered 503 before the stamp sync, the dispatch and the audit row, as `compute_disabled` is. A dry run is not refused.
5. **The dry run says it.** `DryRunConfig` gains `tapis_configured?: boolean`, present only in the dry run of a Tapis run (as `runners_enabled` is only in a runner's); the open contract gains `tapis_configured: z.boolean().optional()` in the dry run's `config`; the CLI's needs line adds `Tapis configured` or `Tapis NOT CONFIGURED` for a Tapis dry run, beside `runners on|OFF` for a runner's.
6. **Unchanged by construction, with one exception.** With Tapis configured the predicate is true and every path answers byte for byte as today, except that a Tapis dry run's `config` gains the one key `tapis_configured: true` (item 5; the schema is open, so an older CLI ignores it). A runner run never calls the predicate, and its dry run has no new key. Nothing else reads it.
7. **Tests**, new file `backend/test/compute-pipeline-tapis-unconfigured.test.ts`, over the real admin router and the lifecycle fixture's migrated SQLite and R2 (no mock of NEMAR logic; the Tapis stand-in is the external service). Every case takes a snapshot before and after of: the row counts of `compute_ledger`, `compute_jobs` and `compute_pipeline_stamps`, the `compute.pipeline.run` rows of `audit_log`, every pool's totals, the records bucket's listing, and `fx.tapis.log.length`; "nothing changed" means all equal.
   - (a) P1 of S3a: the `pipelines` pool funded (`fundPipelines`), Tapis unset, `POST /admin/compute/pipeline/run` `{"recipe":"nemar-floor","dataset":"nm000201"}` answers 503 `tapis_unconfigured` with the declared sentence, and nothing changed. Without the fix it answers 201 with `submit: "unconfigured"` and a hold: write this case first and see that.
   - (b) P2 of S3a: two eligible datasets seeded, `{"recipe":"nemar-floor","eligible":true,"limit":2}` answers 503 `tapis_unconfigured`, and nothing changed.
   - (c) the service for callers other than the route: `dispatchPipelineJob` with `actor: { kind: "cron" }` returns `{ ok: false, code: "tapis_unconfigured" }`; `dispatchEligible` over the two datasets returns one result and `stoppedBy: "tapis_unconfigured"`; nothing changed.
   - (d) G4 of S3a: `runComputePipelineDispatchCron` with `COMPUTE_PIPELINES_DISPATCH_ENABLED: "1"` and Tapis unset ends its run with `tapis_unconfigured`; nothing changed.
   - (e) order and dry run: compute off and Tapis unset is still `compute_disabled` 503; a dry run with Tapis unset answers 200 with `config.tapis_configured: false` and writes nothing; with Tapis configured it answers `true`; a runner dry run has no `tapis_configured` key.
   - (f) the predicate: false for the password strategy without `TAPIS_USERNAME`, without `TAPIS_PASSWORD`, for the service strategy without `TAPIS_SERVICE_TOKEN`, and for an owner `TAPIS_OWNER_RE` refuses; true for `fx.env()`.
   - (g) configured is unchanged: the same funded run as (a) with `fx.env()` answers 201 and its job is submitted to the stand-in, as `backend/test/compute-pipeline-routes.test.ts` already pins.
   - In `backend/test/compute-runner-jobs.test.ts` group (d), one case: the same runner run through the real route with Tapis unset answers 201 `waiting_for_runner`, makes a runner job row, and writes no ledger row.
The implementer may choose: the snapshot helper's shape, and the ids of the seeded rows (never `nm000103` to `nm000107`, the live datasets).

## Acceptance

- `bun test backend/test/compute-pipeline-tapis-unconfigured.test.ts backend/test/compute-pipeline-routes.test.ts backend/test/compute-pipeline.test.ts backend/test/compute-pipeline-dispatch.test.ts backend/test/compute-pipeline-caps.test.ts backend/test/compute-runner-jobs.test.ts backend/test/compute-tenant-ceiling.test.ts backend/test/compute-source-scan.test.ts test/compute-admin-contract.unit.test.ts test/admin-compute-pipeline-cli.test.ts` passes.
- Mutations, each one line, each quoted with the failing case and reverted (`git status --porcelain` clean after): the service check deleted fails (c) and (d); the route check deleted fails (a) (an audit row appears) and (b) (200, not 503); the predicate returning `true` fails (a) to (d); `tapis_unconfigured` removed from `STOPS_A_RUN` fails the two-dataset case of (c).
- With Tapis configured, the only change in any answer is the `tapis_configured: true` key of a Tapis dry run's `config` (design item 6), shown by (e) and (g) and by `backend/test/compute-pipeline-routes.test.ts` passing unchanged apart from that key.

## Gates

- `bun run typecheck`, `bun run lint`, the Acceptance tests, and `bun test backend/test/compute-switches-flag.test.ts backend/test/compute-route-inventory.test.ts`.
- The leak check of `cards/README.md` on the PR body and on any new comment block.
- Full `bun test`: not run, would check: the epic gate (card S2), because it takes about 80 minutes.

## Stop conditions

- The check cannot sit before the stamp claim without moving an existing refusal, or without a change in what a run answers with Tapis configured: stop and report.
- A caller of `dispatchPipelineJob` or `dispatchEligible` other than those in Context exists: keep the service check (it covers it), name the caller in the report.
- A test seems to need a mock of NEMAR logic, or a change to `createJob`, the ledger, the submit or the cancel path: stop.

## Report

At most 25 lines: PR into `feature/portable-compute-epic` and head; each gate with its quoted last lines; the four mutations with their failing cases; P1's answer with Tapis unset before the fix (201, `submit: "unconfigured"`) and after it (503 `tapis_unconfigured`), with the snapshot equal; anything left for S3b to re-run (its P1 and P2 now expect 503 `tapis_unconfigured`).
