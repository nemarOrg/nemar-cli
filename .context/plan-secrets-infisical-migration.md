# Epic: Centralize secret management in self-hosted Infisical

Issue: #885 (relates #440, #432, #325, #314, #332, #306, #13, #629, #476). Drafted 2026-07-01.

## Goal / end state

**Self-hosted Infisical becomes the single source of truth** for every runtime, CI, and
local secret NEMAR uses, and the codebase becomes portable enough that a new contributor
or operator can run the whole system **without hand-editing any `.env`/`.dev.vars` file or
copy-pasting secrets between platforms**. Secrets flow *out* of Infisical into each
consuming platform:

1. **Cloudflare Workers** (prod + dev) -- native **Secret Sync** materializes secrets into
   Cloudflare's own Worker secret store; `env.X` bindings work unchanged, no Worker code
   changes.
2. **GitHub Actions** (hybrid) -- push **Secret Sync -> `nemarDatasets` org secrets** for
   dataset-repo workflows (keep reading `${{ secrets.X }}`); **OIDC pull
   (`infisical/secrets-action`)** for `nemar-cli`'s own CI (nothing stored in GitHub).
3. **AWS** -- Infisical holds backend "owner" + CI keys; assume-role App Connection.
   Per-user IAM + per-request STS federation stay as-is (already short-lived/derived).
4. **Local dev** -- `infisical login && infisical init && infisical run -- bun ...`;
   `.dev.vars` / `test/.env.test` disappear from disk.

### The architectural invariant that prevents "destruction of service"

Infisical offers three delivery modes: SDK/API-at-runtime (couples the app to Infisical),
CLI injection (`infisical run`), and **Secret Sync (push, materialize ahead of time)**.
We use **Secret Sync** for anything on a request path. The Worker reads `env.X` from
Cloudflare bindings; **Infisical is never on the `fetch()` critical path**. Therefore:

- **Infisical down at runtime -> zero effect on live traffic.** The secret already lives
  in Cloudflare/GitHub/AWS.
- **Infisical down at sync time -> destination keeps its last-synced value** (stale but
  functional). (Inferred from the push-materialization model; Infisical docs do not state
  a hard "keeps last value" guarantee, so treat sync-time availability as best-effort.)

We explicitly **forbid the Infisical SDK/API-at-runtime pattern inside the Worker.**

## Decisions locked (owner, 2026-07-01)

- **Self-host Infisical from day one** (Docker: Infisical server + Postgres + Redis).
  Full data control, no per-identity billing. Consequence: **dynamic secrets and
  auto-rotation are Enterprise-licensed on self-hosted**, so this epic does NOT depend on
  them -- rotation stays a manual runbook, and our existing per-user IAM + STS federation
  are unchanged.
- **Hybrid GitHub delivery** (org-secret Secret Sync for dataset workflows; OIDC pull for
  `nemar-cli` CI).
- Scope = `nemar-cli` (Worker + this repo's CI + local) **and** the `nemarDatasets` org
  secrets its dispatched workflows depend on. Sibling repos are a follow-on.

## Ground truth: full secret inventory (names + wiring only; no values)

Non-secret public config in `backend/wrangler-sccn.toml` `[vars]`/`[env.dev.vars]` is
**not** migrated: `ENVIRONMENT`, `API_BASE_URL`, `FRONTEND_URL`, `APP_BASE_URL`,
`AWS_REGION`, `S3_BUCKET`, `FROM_EMAIL`, `REPLY_TO`, `WEB_SESSION_COOKIE_DOMAIN`,
`MANIFEST_VIA_CENTRAL_WORKFLOW`, `ZARR_CACHE_BASE_URL`, `AUTO_IMPORT_ENABLED`,
`AUTO_IMPORT_MIN_INTERVAL_MIN`, `PRESCREEN_ENABLED`, `MAINTENANCE_MODE`,
`ZARR_AUTODISPATCH`, `IMPORT_AUTO_ROLLBACK`, `ORCID_API_BASE`.

### A. Cloudflare Worker runtime secrets (prod + dev on SCCN account)

| Secret | Consumed by (backend/src) | Purpose | Rotation |
|---|---|---|---|
| `GITHUB_ADMIN_PAT` | `services/github-auth.ts` (fallback) | Legacy GitHub PAT fallback for repo/org API | High |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `services/s3.ts`, `sts.ts`, `iam.ts`, many routes | Backend "owner" creds: S3 ops, STS `GetFederationToken`, per-user IAM provisioning | High |
| `RESEND_API_KEY` | `services/email.ts`, several routes | Transactional email | Med |
| `ENCRYPTION_KEY` | `services/auth-code.ts`, `orcid-auth.ts`, `admin.ts` | AES-GCM key for per-user IAM creds + auth codes in D1. **MUST be byte-identical prod & dev** | **Critical** |
| `EZID_USERNAME` / `EZID_PASSWORD` (+ `EZID_SANDBOX_*`) | `services/doi.ts`, `enrich-dataset.ts` | EZID/DataCite DOI minting | High |
| `ZENODO_API_KEY` (+ `ZENODO_SANDBOX_API_KEY`) | `services/doi.ts` | Zenodo DOI path (EZID is primary) | High/Low |
| `OPENROUTER_API_KEY` | `dataset-reindex.ts`, `enrich-dataset.ts` | LLM metadata enrichment | Med |
| `ORCID_CLIENT_ID` / `ORCID_CLIENT_SECRET` | `services/orcid-auth.ts` | ORCID OAuth SSO confidential client | High |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS` / `..._NEMAR_ORG` | `services/github-auth.ts` | GitHub App JWT -> installation tokens (#432, replaces PAT) | Critical/Low |
| `GITHUB_WEBHOOK_SECRET` | `routes/webhooks.ts` (HMAC + fallback bearer on 6 routes) | GitHub App push HMAC; fallback bearer | High |
| `NEMAR_WEBHOOK_TOKEN` | `routes/webhooks.ts` | Preferred bearer for dataset-workflow callbacks | High |
| `MANIFEST_CALLBACK_SECRET` | `routes/webhooks.ts`, `services/github.ts` | HMAC for central-manifest callback. **Must match `nemarDatasets` org secret** | High |
| `PRESCREEN_CALLBACK_SECRET` | `routes/webhooks.ts`, `routes/datasets.ts` | HMAC for pre-screen verdict callback (dev-only today) | High |
| `CLOUDFLARE_API_TOKEN` | `services/cloudflare.ts` | **Zone.Cache-Purge only** token for zarr cache. **Name collides with the deploy token** | Med |
| `CLOUDFLARE_ZONE_ID` | `services/cloudflare.ts` | SCCN zone id | Low |
| `TEST_BYPASS_TOKEN` | `middleware/rateLimit.ts` | CI rate-limit bypass | Med |

### B. GitHub Actions secrets -- `nemarOrg/nemar-cli` (`.github/workflows/*`)

| Secret | Workflow(s) | Purpose |
|---|---|---|
| `AUTO_TAG_PAT` | `auto-tag.yml`, `auto-bump-dev.yml`, `sync-dev.yml` | Bot push/tag past branch protection |
| `PROD_ADMIN_API_KEY` | `check-summary-drift.yml` | Prod admin API call |
| `CLOUDFLARE_API_TOKEN` (**deploy scope**) | `deploy-backend.yml` | Wrangler deploy + D1 migrations (Workers Scripts + D1 edit) |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-backend.yml` | Account selector |
| `TEST_ADMIN_API_KEY` / `TEST_USER_API_KEY` / `TEST_BYPASS_TOKEN` | `test.yml`, `nightly-tests.yml` | Integration-test identities |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (**CI pool**) | `test.yml` | S3-touching tests |
| `GH_TOKEN` | `test.yml` | git/gh ops in tests |
| `ZENODO_SANDBOX_API_KEY` | `test.yml` | Zenodo sandbox tests |

npm publish uses **OIDC trusted publishing** (`id-token: write`, no `NPM_TOKEN`) -> nothing
to migrate.

### C. GitHub Actions secrets -- `nemarDatasets` org (dataset-repo + dispatched workflows)

Sources: `.github/dataset-workflows/onboard-openneuro.yml` (deployed to
`nemarDatasets/.github`) and the embedded templates in
`backend/src/services/github.ts` `getWorkflowTemplates()` (`nemar admin ci add`/`ci sync`).

| Secret | Referenced in | Purpose |
|---|---|---|
| `NEMAR_ADMIN_API_KEY` | `onboard-openneuro.yml` | Admin login on CI runner for imports |
| `NEMAR_GITHUB_PAT` | `onboard-openneuro.yml` | `GH_TOKEN` for git/gh during import |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (**org pool**) | `onboard-openneuro.yml`, embedded `pr-merge.yml` | S3 on dataset-repo runners |
| `NEMAR_WEBHOOK_TOKEN` | `onboard-openneuro.yml` callbacks | **Must match Worker `NEMAR_WEBHOOK_TOKEN`** |
| `NEMAR_APP_ID` / `NEMAR_APP_PRIVATE_KEY` | embedded `bidsValidation`/`prMerge` templates | Mint App token to dispatch to central repo. **Same App as Worker's `GITHUB_APP_*`** |
| `MANIFEST_CALLBACK_SECRET` | central-manifest callback | **Must match Worker secret** |
| Anthropic/Claude credential (external) | `run-prescreen` workflow (not vendored here) | `claude -p` pre-screen. **Inventory in `nemarDatasets` before Phase 3** |

### D. AWS credential tiers

1. Worker owner keys (secret A) -- S3 + IAM admin + STS federation.
2. `nemar-cli` CI keys (secret B) -- distinct value, same name.
3. `nemarDatasets` org keys (secret C) -- distinct value, same name.
4. Per-user long-lived IAM creds -- minted from tier 1 via `services/iam.ts`, stored
   **encrypted** in D1 (`users.aws_*_encrypted`, decrypted with `ENCRYPTION_KEY`).
   **Not stored in Infisical.**
5. Per-request STS federation -- `services/sts.ts` `GetFederationToken`, issued via
   `/datasets/:id/upload-credentials` + `/download-credentials`, consumed by CLI
   (`src/lib/git-annex.ts`). **Not stored in Infisical.**

Guardrail: `scripts/lib/aws-creds-guard.sh` forbids long-lived `AKIA*` keys in env vars
(must be `~/.aws/credentials` mode 0600); short-lived `ASIA*` STS tokens in env are
tolerated. Preserve this policy post-migration.

### E. Local / test / CLI

- `backend/.dev.vars` (~17 keys). Real keys mirror table A; **confirmed cruft (no
  `Bindings` field, no `backend/src` reference)**: `ADMIN_API_KEY`, `ADMIN_PASSWORD`,
  `NEMAR_ACCESS_TOKEN`, `NEMAR_USERNAME`, `NEMAR_PASSWORD`, `PROD_ADMIN_API_KEY`
  -- confirm with team, do NOT auto-import.
- `test/.env.test`: `TEST_ADMIN_API_KEY`, `TEST_API_URL`, `TEST_BYPASS_TOKEN`,
  `TEST_PASSWORD`, `TEST_USER_API_KEY`.
- CLI account store `src/lib/config.ts` -> `~/.config/nemar/config.json`
  (`NEMAR_CONFIG_DIR` override): only `apiKey`, `apiUrl`, `username`, `email`,
  `githubUsername`, `sandboxCompleted`, `sandboxDatasetId`, `dismissedNoticeIds`. **No AWS
  or GitHub creds persisted** -- GitHub delegated to `gh auth login`, S3 via per-op STS.
  Already clean; nothing to migrate here.
- `cfman` (`~/.config/cfman/tokens.json`) -- external tool token, not vendored.
- `scripts/*.sh` -- rely on ambient `~/.aws/credentials`; `hallu-zarr.sh` uses
  `NEMAR_WEBHOOK_TOKEN`; `backfill-*.sh` use `NEMAR_ADMIN_KEY`.

### Live reconciliation vs deployed Worker secrets (SCCN, verified 2026-07-01)

`wrangler secret list` on the live `nemar-api` (prod) and `nemar-api-dev` (dev) Workers
(SCCN, account `da8d7a2a…`) -- names only. Corrections to the code-derived inventory:

- **prod = 26 secrets, dev = 23.** dev is missing `ORCID_CLIENT_ID`, `ORCID_CLIENT_SECRET`
  (ORCID SSO is prod-only) and `PRESCREEN_ENABLED`.
- **`NEMAR_USERNAME` / `NEMAR_PASSWORD` are LIVE on both Workers but UNREFERENCED in
  `backend/src`** (grep = 0 hits) -> **orphaned** legacy `dataexplorer` datapipeline-sync
  creds, retired by epic #837. **Do NOT migrate; delete** as part of Phase 5 / #837 cleanup.
  (These are the ones the earlier code-only pass mislabeled as `.dev.vars` cruft -- they
  are real deployed secrets, just dead.)
- **`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` are NOT set** on either Worker. The
  wrangler-sccn.toml comments confirm the zarr cache-purge (#684) is intentionally
  "skipped" until they're provisioned. So they are *planned-but-unset* -> Infisical holds
  them once the feature is provisioned; nothing to import today.
- **`PRESCREEN_ENABLED` is set as a prod Worker *secret*** though it is a plain config flag
  (dev carries it as `[env.dev.vars]`). Hygiene: it should be a var, not a secret.
- The four `.dev.vars`-only keys **`ADMIN_API_KEY`, `ADMIN_PASSWORD`, `NEMAR_ACCESS_TOKEN`,
  `PROD_ADMIN_API_KEY` are confirmed absent from both live Workers** -> pure local cruft,
  do not import.
- Everything else matches the code-derived table A exactly (AWS keys, `ENCRYPTION_KEY`,
  EZID +sandbox, `GITHUB_ADMIN_PAT`, all four `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`,
  `MANIFEST_CALLBACK_SECRET`, `NEMAR_WEBHOOK_TOKEN`, `OPENROUTER_API_KEY`,
  `PRESCREEN_CALLBACK_SECRET`, `RESEND_API_KEY`, `TEST_BYPASS_TOKEN`, `ZENODO_API_KEY`
  +sandbox).

### Old personal (neuromechanist) account -- RESOLVED (#332 closed 2026-07-01)

**#332 is closed/done and the personal Cloudflare account (`10f166f3…`) has been deleted.**
No old-account secrets remain to sweep -- this is no longer a dependency of the migration.
(The neuromechanist entry lingering in local cfman config is now a dead token; safe to drop
with `cfman token remove neuromechanist`.) SCCN is the sole account; only the live
`nemar-api` / `nemar-api-dev` Worker secrets (reconciled above) are in scope.

## Target Infisical layout

- Org + one **Secrets Management** project `nemar`; environments `dev`, `prod`.
- Folders: `/backend` (Worker A), `/ci-nemar-cli` (B), `/ci-datasets` (C), `/aws`,
  `/shared` for the must-match values, referenced via `${shared.X}` from consumers.
- Machine identities (keep to a handful to respect any tier limits and blast radius):
  CF sync identity, GitHub org sync identity, `nemar-cli` CI OIDC identity, AWS
  assume-role connection.
- App Connections: **Cloudflare** (API token: Workers Scripts:Edit + Account Settings:Read
  -- note: needs manual rotation, no auto-refresh), **GitHub** (App install: Metadata RO,
  Secrets RW, Environments), **AWS** (assume-role, external-id = org/project id).
- Self-host: Infisical + Postgres + Redis behind a **Cloudflare Tunnel** (`cloudflared`,
  no open inbound port) on `infisical.nemar.org` (SCCN zone); **Postgres backed up** on the
  D1-backup pattern (#655). **Host decided (2026-07-01): a dedicated VM instance on the
  SDSC internet-facing webservices physical server** (isolated from Hallu research compute).
- CF Access split: gate the **dashboard UI** with Cloudflare Access (email/SSO); leave the
  **API path** reachable (protected by Infisical's own machine-identity auth) so GitHub
  Actions OIDC pull + local `infisical run` can reach it. Firewall/origin: only `cloudflared`
  egress needed. Sizing: ~2-4 vCPU / 8 GB RAM / 20-40 GB disk.

## Per-platform sync mechanics (from Infisical docs, 2026)

- **Cloudflare Workers**: one Secret Sync == one Worker `scriptId`. So prod Worker and dev
  Worker each get their own sync (prod<-`prod` env, dev<-`dev` env). Push-on-change.
  Deleting a secret in Infisical deletes it in CF next sync unless "Disable Secret
  Deletion". Manually-set CF secrets under the same key are **overwritten** unless imported
  first. `wrangler dev` locally: use `infisical run -- wrangler dev` (generic injection;
  not an officially documented recipe).
- **GitHub (push)**: Secret Sync to org scope with `Selected Repositories` visibility, via
  a GitHub App connection. Workflows read `${{ secrets.X }}` unchanged.
- **GitHub (pull)**: `infisical/secrets-action` with `auth-method: oidc` (GitHub's native
  OIDC; configure Subject/Audience/Claims on the identity; `permissions: id-token: write`;
  the Identity ID is not secret, safe in YAML). `export-type: env`. Secrets live only for
  the job lifetime; **nothing persisted in GitHub**. (Log-masking of injected vars is
  unconfirmed in docs -- treat as if not masked; avoid echoing.)
- **AWS**: assume-role App Connection (trust Infisical's AWS account + external id).
  Secret Sync to Secrets Manager/SSM available but likely unneeded -- we mostly need
  Infisical to *hold* the owner/CI keys and materialize them into CF/GitHub.
- **Local**: `infisical login` (browser OAuth; `-i` headless) -> `infisical init` writes
  commit-safe `.infisical.json` -> `infisical run --env=dev -- bun run src/index.ts` /
  `... -- bun test`.

## Phases (execute via `/project:epic-dev`)

### Phase 0 -- Stand up self-hosted Infisical (infra; no code cutover)
- Deploy Infisical + Postgres + Redis; TLS via CF Tunnel + Access; monitoring/alerts.
- Postgres backup + restore drill (Infisical is now a stateful SoT).
- Create project/envs/folders, machine identities, App Connections (CF/GitHub/AWS).
- **Sealed offline backup of ALL current secret values** (rollback anchor) before import.

### Phase 1 -- Non-destructive import + reconcile (no cutover)
- Load current values into `dev` + `prod`. Canonicalize must-match pairs into `/shared`;
  wire `${shared.X}` references. Disambiguate `CLOUDFLARE_API_TOKEN` (deploy vs zone-purge)
  and the 3 AWS pools. Confirm-then-drop `.dev.vars` cruft.
- Configure all Secret Syncs **"Import Secrets" + "Disable Secret Deletion"**
  (non-authoritative). **Byte-diff Infisical vs each live destination -> must be identical.**

### Phase 2 -- Cut over Cloudflare Workers (dev first, then prod)
- Dev Worker sync authoritative -> redeploy -> `nemar admin e2e-test` on nm099999.
- **`ENCRYPTION_KEY` round-trip check**: decrypt a known user AWS cred + an auth code on dev.
- Prod Worker sync authoritative -> health-check -> confirm no request-path regression.

### Phase 3 -- Cut over GitHub (hybrid)
- Inventory `nemarDatasets` org secrets (incl. Anthropic prescreen cred).
- Push Secret Sync -> `nemarDatasets` org secrets. Verify with an nm099999 import + a
  manifest/BIDS callback round-trip (`NEMAR_WEBHOOK_TOKEN` + `MANIFEST_CALLBACK_SECRET`).
- Refactor `nemar-cli` CI (`test.yml`, `deploy-backend.yml`, `auto-tag.yml`,
  `nightly-tests.yml`, `check-summary-drift.yml`) to OIDC `infisical/secrets-action`.
  Verify deploy deploys and tests pass.

### Phase 4 -- AWS + local dev
- AWS assume-role connection; keep per-user IAM + STS + `aws-creds-guard.sh` intact.
- Local: `infisical run` flow; delete `.dev.vars`/`test/.env.test`; replace
  `.dev.vars.example` with an Infisical pointer; update `.gitignore`, AGENTS.md, docs.

### Phase 5 -- Decommission + harden
- Remove Infisical-owned manually-set secrets from platforms (only post-authoritative).
- Rotation runbook (manual, dual-phase where feasible). Onboarding doc
  ("clone -> `infisical run` -> go"). Update AGENTS.md/CLAUDE.md/memory; file sibling-repo follow-on.

## Disruption risk register + mitigations

- **R1 Secret Sync destructive by default** -> "Import Secrets" + "Disable Secret Deletion"
  during cutover; byte-diff before authoritative; dev-first.
- **R2 `ENCRYPTION_KEY` mismatch** (all stored user creds + auth codes bricked) -> import
  verbatim, never regenerate, pin, verify decrypt round-trip on dev mirror.
- **R3 Must-match pair drift mid-cutover** (`NEMAR_WEBHOOK_TOKEN`, `MANIFEST_CALLBACK_SECRET`,
  App key) -> one `/shared` secret; cut over both consumers together; callback test on nm099999.
- **R4 `CLOUDFLARE_API_TOKEN` scope confusion** -> two distinct Infisical secrets; keep the
  `env -u CLOUDFLARE_API_TOKEN` guard; never sync the deploy token into the Worker.
- **R5 3 AWS pools collapsed** -> separate Infisical paths per pool; do not merge.
- **R6 CI runtime dependency on Infisical** (OIDC pull + deploy) -> hybrid keeps dataset
  runtime on materialized org secrets; Infisical HA + backup; paused CI is tolerable
  (not user-facing).
- **R7 Self-hosted Infisical availability/DR** -> Postgres backups + restore drill; prod
  runtime survives an outage because secrets are materialized.
- **R8 Importing cruft/dev-only secrets** -> confirm-before-import; skip orphaned `.dev.vars` keys.
- **R9 Cross-repo blind spots** -> inventory `nemarDatasets` org secrets before Phase 3.

## Rollback

Disabling any Secret Sync leaves the **last-materialized** value in CF/GitHub/AWS, so the
platform keeps running on its current secret. The Phase-0 sealed backup allows full manual
restore of any secret. Dev before prod at every step; each go-gate requires explicit owner
sign-off before a prod mutation.

## Verification gates

- P0: Infisical reachable via CF Access; Postgres backup+restore proven; sealed secret backup stored.
- P1: byte-diff Infisical vs live == 0 differences on every synced key; syncs non-authoritative.
- P2: dev + prod Workers healthy post-cutover; `ENCRYPTION_KEY` decrypt round-trip passes;
  `nemar admin e2e-test` green on nm099999.
- P3: nm099999 import + manifest/BIDS callback succeed; `deploy-backend.yml` deploys via OIDC; CI green.
- P4: backend + tests run via `infisical run` with **zero** local secret files on disk.
- P5: no orphaned manually-set secrets on any platform; rotation runbook + onboarding doc merged.

## Open items (owner / follow-on)

- ~~Deployment host for self-hosted Infisical~~ -- **DECIDED 2026-07-01**: dedicated VM on
  the SDSC internet-facing webservices server; CF Tunnel on `infisical.nemar.org`.
- Confirm `NEMAR_APP_*` (org) == `GITHUB_APP_*` (Worker) are the same App/key material
  (cannot be proven via `secret list` -- values aren't exposed; check at the GitHub App / by
  comparing installation IDs).
- Inventory + fold `nemarDatasets` org secrets (esp. the Anthropic prescreen credential).
- ~~Sweep the neuromechanist personal account~~ -- **DONE**: #332 closed, personal account
  deleted 2026-07-01; no old-account secrets remain. Drop the dead cfman token entry.
- **Delete orphaned live secrets** `NEMAR_USERNAME` / `NEMAR_PASSWORD` (dead legacy sync,
  #837) rather than migrate; move `PRESCREEN_ENABLED` from prod secret to a var.
- Sibling-repo follow-on: `nemar-tools`, `website`, `nemar-observability`, `nemar-db-backup`.
- Confirmed pure-cruft `.dev.vars` keys (not on live Worker): `ADMIN_API_KEY`,
  `ADMIN_PASSWORD`, `NEMAR_ACCESS_TOKEN`, `PROD_ADMIN_API_KEY` -- drop, do not import.

## Unverified-from-docs flags (carried from research)

Sync-time "keeps last value if Infisical down" is inferred, not documented; exact sync
cadence (push vs poll) unstated; GitHub Actions log-masking of injected env vars
unconfirmed; self-hosted free-tier limits (identities/projects) read inconsistently on the
pricing page -- confirm against the actual deployed version before counting on limits.
