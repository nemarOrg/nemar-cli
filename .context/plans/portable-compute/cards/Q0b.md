# Card Q0b: The registry knows one `nemar-floor` with two inputs, and a pipeline stamp records its input and what it read

Status: ready
Tier: worker-hard
Timebox: L, 6 hours; escalate at 12 hours or two failed approaches
Needs: none
Depends: none (the record fields it reads are settled in card Q0, item 4; it may run beside Q0); collides with lead S's S1 on `shared/compute-recipes.ts` (`recipeZarrArguments`) and `compute-pipeline.ts`: the second to merge takes the base in and reruns its gates
Branch: feature/pc-q0b-floor-inputs
Worktree: $WT/nemar-cli-pc-q0b (base origin/feature/portable-compute-epic)
Plan: .context/plans/portable-compute/plan.md, D12, D14, section 4 (Q0); CP-F finding A10; owner decision Q11
Review: Sonnet panel plus one Opus review (concurrency: one live stamp per tuple under the rebuilt unique index; the D1 migration on rows that exist; registry drift now compares the input)

## Goal

The Worker dispatches `nemar-floor` with input `bids` to Tapis and with input `zarr` to a runner from one registry entry, the stamp's claimed tuple includes the input, and a succeeded stamp records the reader, the Zarr engine and the input digest the recipe's record names, so card V1b can key a derivative from the stamp and its record.

## Context

- Read `shared/compute-recipes.ts` (`ComputeRecipe.input`, `executors`, `recipeJobSpec`'s inputs through `recipeArguments` and `recipeZarrArguments`), `backend/src/db/migrations/0117_compute_pipeline_stamps.sql` (the tuple, `compute_pipeline_stamps_live`, `compute_pipeline_stamps_attempt`), `backend/src/services/compute-pipeline.ts` (`CLAIM_STAMP_SQL`, `resolveRun`, `tupleHeld`, the success rewrite from `readRecipeRecord`, `dispatchPipelineJob`'s executor checks), `backend/src/services/compute-runner-queue.ts` (`rebuiltSpec` reads the stamp), `backend/src/routes/admin/compute-pipeline.ts`, `src/commands/admin-compute-pipeline.ts`, `shared/contract/compute-admin.ts`, and every test that names `nemar-floor-zarr` (`git grep -ln nemar-floor-zarr -- backend shared src test`).
- Card Q0's record fields for Zarr input: per dataset record `extensions.nemar.input.kind` (`zarr`), `.zarr_engine_version`, `.input_digest` (`sha256:` and 64 hexadecimal digits), and `extensions.nemar.reader` (`eegprep-lean@<version>+<commit>`); a BIDS record has `extensions.nemar.dataset.source_commit` and no `input` block.
- Migrations: this program takes 0140 to 0149 (0140 is the runners); take the lowest free number from 0141 at the base and run `bun run migrations:d1-check`.
- Lead S's card S2 carries a merge checklist that names `resolveRun(db, id, wanted, except, recipe)`'s parameter order; keep it and append any new parameter last.
- The demo's G2 test files name `nemar-floor-zarr`; changing them here does not touch the demo's evidence, which cites commit 27868ce1.

## Scope

- `shared/compute-recipes.ts`, `shared/contract/compute-admin.ts` (the dispatch body), a new migration `backend/src/db/migrations/014N_compute_pipeline_stamps_input.sql`, `backend/src/services/compute-pipeline.ts`, `backend/src/services/compute-runner-queue.ts` (`rebuiltSpec` only), `backend/src/routes/admin/compute-pipeline.ts`, `src/commands/admin-compute-pipeline.ts`, the tests that name `nemar-floor-zarr` (renamed to `nemar-floor` with input `zarr`), `backend/test/compute-pipeline-stamps-migration.test.ts`, and a new `backend/test/compute-pipeline-input.test.ts`.
- Not `compute-pipeline-eligibility.ts`, `datasetId.ts` (lead S's S1), `compute-reporting.ts` (S6), the ledger, the switches or `backend/wrangler-sccn.toml`.

## Decided design

Settled:
1. **Registry.** `ComputeRecipe.input` becomes `inputs: readonly RecipeInput[]`; `nemar-floor` lists `["bids", "zarr"]` and `executors: ["tapis", "runner"]` and keeps its other numbers; the `nemar-floor-zarr` entry is removed; `nemar-ica` stays a placeholder with `inputs: ["bids"]`. One table `RECIPE_INPUT_EXECUTOR` allows exactly `bids` with `tapis` and `zarr` with `runner`; `defaultInput(executor)` is `bids` for `tapis` and `zarr` for `runner`. A dispatch names an input or takes the default; an input the recipe does not list, or a pair the table does not allow, is refused `invalid_spec` with `field: "input"`, before any claim.
2. **Migration.** `ALTER TABLE compute_pipeline_stamps ADD COLUMN input TEXT NOT NULL DEFAULT 'bids'` with a named CHECK `input IN ('bids', 'zarr')`; nullable `reader` (at most 128 characters, `NOT GLOB '*[^0-9A-Za-z._+@-]*'`), `input_engine` (the same rule), `input_digest` (NULL, or 71 characters starting `sha256:` followed by lowercase hexadecimal, or 44 characters starting `git:` followed by lowercase hexadecimal; each GLOB at most 50 characters); `UPDATE ... SET input = 'zarr' WHERE recipe = 'nemar-floor-zarr'`, which KEEPS the old name (as merged in PR 2177, 7e799ef9, after the Q0 provenance review): the registry answers `recipe_unknown` for `nemar-floor-zarr`, so an old stamp fails closed and never occupies the live slot of a `nemar-floor` Zarr claim or holds `nemar-floor` on either input, and a stamp's recipe always equals its record's `pipelineInfo.name`, which the old recipe wrote differently; drop and recreate `compute_pipeline_stamps_live` and `compute_pipeline_stamps_attempt` with `input` after `engine`. Every term is TRUE or FALSE, never NULL, as 0117 requires.
3. **Claim.** `CLAIM_STAMP_SQL` binds the input; the live index refuses a second `dispatched` or `succeeded` stamp of the same dataset, version, recipe, recipe version, engine and input; a `bids` and a `zarr` stamp of one dataset version coexist. `resolveRun` gets the input as a new last parameter and runs the Zarr source check only for `zarr`. `rebuiltSpec` reads the input from the stamp.
4. **Success.** Besides today's rewrite of `recipe_version` and `engine`: for `zarr`, `reader`, `input_engine` (`zarr_engine_version`) and `input_digest` are copied from the dataset record when each matches its column rule (a value that does not is left NULL and logged as `stamp_field_refused field=<name>`, never stored); for `bids`, `input_digest` is `git:` and `extensions.nemar.dataset.source_commit` when that is 40 lowercase hexadecimal digits. A record whose `extensions.nemar.input.kind` (absent means `bids`) differs from the stamp's input is a tuple mismatch and holds the tuple (`registry_drift`), as a wrong engine does.
5. **Command line.** `nemar admin compute pipeline run <recipe> --dataset <id>[@<version>] [--executor tapis|runner] [--input bids|zarr]`.
The implementer may choose: helper names, how the record's fields are read (reuse `readRecipeRecord`).

## Acceptance

- `bun test backend/test/compute-pipeline-input.test.ts` passes, against the real routes and services with the existing pipeline fixture helper (its record writer extended with Q0's fields): a runner dispatch of `nemar-floor` claims input `zarr`; two concurrent claims of one tuple and input give one stamp and one job; a `bids` stamp and a `zarr` stamp of one version coexist; `--input bids --executor runner` is refused `invalid_spec` with `field: "input"` and writes nothing; a finished Zarr job's stamp holds `reader`, `input_engine` and `input_digest`; a record whose input kind disagrees holds the tuple.
- `bun test backend/test/compute-pipeline-stamps-migration.test.ts` passes, including a pre-migration `nemar-floor-zarr` row that keeps its name, gets input `zarr` and blocks no `nemar-floor` Zarr claim, and each new CHECK refusing a bad value.
- Mutations, each failing a test: `input` left out of the recreated live index; the pair table allowing `bids` with `runner`; the input-kind comparison removed.

## Gates

- `bun run typecheck`, `bun run lint`, `bun run migrations:d1-check`, `bunx biome check` on the changed files, `bun test backend/test/compute-pipeline-input.test.ts backend/test/compute-pipeline-stamps-migration.test.ts backend/test/compute-pipeline.test.ts backend/test/compute-pipeline-dispatch.test.ts backend/test/compute-pipeline-queue.test.ts backend/test/compute-runner-jobs.test.ts backend/test/compute-runner-queue.test.ts backend/test/compute-local-stack-runner.test.ts backend/test/zarr-source-check.test.ts test/admin-compute-pipeline-cli.test.ts test/compute-recipes.unit.test.ts`.
- Full `bun test`: not run, would check: the epic gate.

## Stop conditions

- D1 refuses the migration's shape (`migrations:d1-check`): stop and report the statement.
- The change needs a file of lead S's cards (eligibility, dataset ids, reporting) or a change of `resolveRun`'s existing parameter order: stop.

## Report

At most 25 lines: PR, head, the migration number taken, gates, mutations, deviations, and patch notes: for nemar-process (the runner pin's test dispatches `nemar-floor` with input `zarr` once its pin passes this merge) and for lead S (the new trailing `resolveRun` parameter).
