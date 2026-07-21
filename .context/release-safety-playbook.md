# Release & Promotion Safety Playbook

How a change travels feature -> dev -> production, what is tested at each stage,
and the go/no-go ritual for a `dev -> main` release.
This is the "child instructions" for keeping production safe as NEMAR approaches general release.

## Environments and parity

| Concern | Production | Staging / dev |
|---|---|---|
| API worker | `api.nemar.org` (`nemar-api`) | `api-test.nemar.org` (`nemar-api-dev`) |
| Data plane | `data.nemar.org` | `data-test.nemar.org` |
| Zarr | `zarr.nemar.org` | `zarr-test.nemar.org` |
| Website | `ww2.nemar.org` (`nemar-website` Pages, deploys from `main`) | `test.nemar.org` (`nemar-website-test` Pages, deploys from `staging`) |
| D1 | `nemar-db` | `nemar-db-dev` |
| S3 | `s3://nemar` | `s3://nemar-dev` |
| Catalog | real datasets | the 7 `xx0999NN` exemplars + private `nm099999` only (NOT a prod mirror) |
| Branch | `main` (carries clean `X.Y.Z`) | `dev` (carries `X.Y.Z-devN`) |

Parity is real: the CI job `integration-dev` runs the actual CLI and API tests against the live dev worker,
which is the same code that deploys to prod.
The exemplar fleet lets the full publish / DOI / reindex / zarr pipeline run off-prod.
The gaps are documented at the end.

## Promotion path

1. **Feature branch -> PR to `dev`.**
   `test.yml` runs: `lint` + `unit-pure` (required) and `integration-dev` (soft on dev, drives the live dev worker), plus `e2e-sandbox`, `api-test`, `publish`.
   Merge is squash.
2. **Merge to `dev`** triggers `deploy-backend.yml` (on `backend/**` changes): applies migrations to `nemar-db-dev`, deploys `nemar-api-dev`, then the new **/health smoke** asserts the deployed version is serving.
   Website: push to the `staging` branch triggers `deploy-test.yml` -> `test.nemar.org`.
3. **Exercise on staging** (see next section) before promoting.
4. **`dev -> main` PR** runs `test.yml` with `integration-dev` now **required**.
   Complete the pre-merge checklist below, then regular-merge (`--merge`, never squash).
5. **Merge to `main`** fires the automated release: `auto-tag.yml` strips `-devN` + tags `vX.Y.Z`, `deploy-backend.yml` applies prod migrations + deploys `nemar-api` + runs the **/health smoke**, `npm-publish.yml` publishes on the tag, `sync-dev.yml` merges main back and bumps dev to the next `-dev0`.
   Prod website (`ww2`) deploys from `main` via the Cloudflare Pages Git integration.

## How to test a feature on staging before production

- Point the CLI at the dev worker with an isolated config so the real one is never clobbered:
  `NEMAR_CONFIG_DIR=$(mktemp -d) TEST_API_URL=https://nemar-api-dev.sccn-org.workers.dev`.
  The working dev admin credential is `TEST_ADMIN_API_KEY` from `test/.env.test` (no prod key works against dev).
- Publish/DOI/reindex/zarr flows: use the exemplar fleet (`nemar admin exemplar create|status|remint-dois`) or an ephemeral dev-band id (`xx090001`-`xx099899`).
  Never a prod `nm` id (the repo lives in the shared `nemarDatasets` org).
- Website changes: push to the `staging` branch and check `test.nemar.org`.
  The staging build must set `PUBLIC_API_BASE_URL`/`PUBLIC_DATA_BASE_URL`/`PUBLIC_ZARR_BASE_URL` to the `-test` hosts; all data-plane fetches resolve through `resolveDataBase()` (never hardcode `data.nemar.org`).
- CLI<->backend contract: `shared/contract` is the source of truth; keep the CLI's expected shapes and the backend's responses in sync (version tags in `vX.Y.Z` form via `toVersionTag`).

## Pre-merge checklist: `dev -> main` (the go/no-go)

Do NOT merge until every box is checked.

- [ ] **Required checks green** on the `dev -> main` PR: `lint`, `unit-pure`, `integration-dev`.
      Never merge onto a red `integration-dev` baseline (main is stricter than dev; a red here silently blocks the release).
- [ ] **Migrations are additive & idempotent.** Every migration newly landing on `main` must be a safe `ADD COLUMN` / `CREATE INDEX IF NOT EXISTS`, no `DROP`, no `NOT NULL`-without-default on populated tables, no data backfill assuming rows.
      They auto-apply to `nemar-db` BEFORE the code deploys (migrate-then-deploy, concurrency-serialized).
- [ ] **Prod wrangler config completeness.** Every env var / binding the newly-merged backend reads at runtime is declared in the PRODUCTION stanza of `wrangler-sccn.toml` (not only `[env.dev]`).
- [ ] **Deploy path self-consistent.** If `shared/` or the deploy workflow changed, confirm the prod deploy install resolves `shared/` (root `bun install` before backend install).
- [ ] **Env-gating is prod-safe.** All `isNonProductionEnv` / `is_exemplar` carve-outs are fail-CLOSED (`!isNonProductionEnv(env)`, never `env.ENVIRONMENT === "production"`); with `is_exemplar=0` everywhere in prod they behave identically to pre-epic. No staging-only path (exemplar endpoints, webhook forwarder, band deletes) can fire in prod.
- [ ] **Scoped prod-safety review done** (deploy/migration/contract, env fences, cross-epic seams, silent failures). Findings addressed or consciously accepted.
- [ ] **Fresh prod D1 snapshot** confirmed (the hourly/daily backup at `nemarOrg/nemar-db-backup`, or a manual export) so rollback has a floor. Additive migrations lower the need but do it anyway.
- [ ] **Rollback plan understood** (below).
- [ ] **A human is watching the deploy** (see post-merge). Do not merge-and-walk-away.

## Post-merge watch (do not skip)

1. Watch `deploy-backend.yml` on `main`: `gh run list --workflow=deploy-backend.yml --branch main`.
   The release deploys TWICE (pre-strip `-devN`, then the stripped tag) — both must reach the /health smoke green.
2. Confirm `api.nemar.org/health` reports the new `X.Y.Z`.
3. Confirm `auto-tag.yml` created `vX.Y.Z`, `npm-publish.yml` published, `sync-dev.yml` bumped dev to the next `-dev0`.
4. Spot-check a real catalog read (`/datasets`) and a dataset landing page on `ww2.nemar.org`.
5. If the /health smoke goes RED: prod may be on old code (or half-deployed). Investigate immediately; roll back.

## Rollback plan

- **Worker code:** `npx cfman wrangler --account sccn -c backend/wrangler-sccn.toml rollback` (or redeploy the previous tag's commit).
  Fast, no data change.
- **Migrations:** D1 has no down-migrations. The release migrations are ADDITIVE, so rolling back the *code* is safe on its own — old code ignores the new column/index. Only a destructive migration would need the D1 snapshot restore (`scripts/restore-remote.sh` in `nemar-db-backup`, `--force-prod`).
- **The merge itself:** if the release is fundamentally bad, revert the merge commit on `main` and let the pipeline redeploy the prior version; then investigate on `dev`.
- **npm:** a bad published version is corrected forward with a patch release, not unpublished.
- **Website:** redeploy the previous `main`/`staging` Pages deployment from the Cloudflare dashboard or by pushing the prior commit.

## Known pipeline gaps (track these to closure)

- **/health smoke is an alarm, not a hard gate on tagging.** `auto-tag`/`npm-publish`/`sync-dev` are separate workflows not gated on `deploy-backend` success, so a red smoke surfaces a bad prod deploy loudly but does not by itself stop the tag/publish. Watch the smoke.
- **`contract-live` (CLI<->backend contract) is warn-only** until it is flipped to hard-fail. Verify the contract manually on a release that changes wire shapes.
- **D1 backup runs ~daily, not hourly** as older docs claim (`nemarOrg/nemar-db-backup`). Take a manual snapshot before a schema-changing release.
- **No automatic "does this new CLI command have staging coverage" gate.** New CLI features should get an `integration-dev` test that routes to the dev worker.
