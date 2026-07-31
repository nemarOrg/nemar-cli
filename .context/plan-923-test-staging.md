# Staging Environment: test.nemar.org + Exemplar Test-Dataset Fleet

> **Decision recorded:** [ADR 0009 - Non-production D1 is a fixture set, not a production mirror](decisions/0009-non-production-d1-is-not-a-production-mirror.md).
> This document keeps the staging build-out plan.


> **STATUS: HISTORICAL.** Build-out plan for the staging environment, now shipped.
> Current decisions live in [`.context/decisions/`](decisions/README.md); where this document and an ADR disagree, the ADR wins.

## Context

`dev` currently carries a large, unreleased code change, and several other epics
(#896 hardening, #885 secrets, #837 legacy separation) still have work that will
eventually touch **production** paths: S3 bucket policy, Object Lock, DOI minting,
publication orchestration, the data/zarr planes, and the website. Today there is no
safe place to exercise those end-to-end. The `nemar-api-dev` worker exists but
**shares the prod S3 bucket (`nemar`) and the `nemarDatasets` GitHub org with
overlapping dataset-ID allocation**, so it is not safe for realistic publish/DOI/delete
testing — a dev action can clobber real prod data.

**Goal:** a durable staging stack — `test.nemar.org` (website) + `api-test` /
`data-test` / `zarr-test.nemar.org` (the existing dev worker) + a dedicated
`nemar-dev` S3 bucket — hosting a small curated fleet of `xx`-prefixed **exemplar
copies of real datasets**, publishable through the full 16-step pipeline with **test
EZID DOIs** (`doi:10.5072/FK2`). This lets us validate cross-cutting changes before
they ever touch prod.

**Locked decisions (from Q&A):** reuse `nemar-api-dev` (no new `[env.staging]`);
full parallel `-test` domains; dedicated `nemar-dev` bucket; repos stay in
`nemarDatasets` with a partitioned ID range; exemplar data seeded by a new nm→xx
clone tool; DOIs minted on demand via the EZID sandbox shoulder (accept ~2-week
expiry), and the hardcoded `nemar.org` DOI landing URL parameterized.

**Prod-safety is the organizing principle.** Almost every code change is a **no-op or
narrowing** on prod; the *only* substantive new prod behavior is the webhook
forwarder (Phase 5), which is config-gated and outbound-only. A consolidated leak
register is at the end.

**Process:** this is a multi-phase, cross-repo epic — drive it with
**`/project:epic-dev`** (per AGENTS.md), one sub-issue per phase, epic branch off
`dev`. Do **not** hand-roll the sprint flow. See the isolation protocol below —
this epic must NOT clobber the in-flight #885 and #896 epics.

---

## Epic isolation & coordination (do NOT clobber #885 / #896)

**The hazard (verified):** `.claude/*.local.md` state files are **gitignored**
(per-working-copy, not restorable with `git checkout`). `/project:epic-dev` defaults
to writing `.claude/epic.local.md` (SKILL.md step 70). That file **currently holds the
resting #885 secrets-infisical epic** (`current_phase: 1`, waiting on the SDSC VM). A
bare `/project:epic-dev` run would overwrite it and lose #885's state. The named-doc
files already present (`epic-896-arch-hardening.local.md`, `epic-902-decompose.local.md`,
`epic-736.local.md`, `epic-854.local.md`) are the established manual workaround for
parallel epics; #896's notes explicitly say do not overwrite `epic.local.md`.

**State-file protocol for THIS epic:**
1. **Back up first:** copy `.claude/epic.local.md` (the #885 file) to a safe path before
   running epic-dev, because it is gitignored and cannot be restored from git.
2. Run `/project:epic-dev <staging description>` to scaffold the epic + sub-issues.
3. **Immediately rename** the generated `.claude/epic.local.md` →
   `.claude/epic-NNN-test-staging.local.md` (NNN = this epic's issue number), matching the
   #896/#902 convention, and **restore** the #885 backup to `.claude/epic.local.md`.
4. Resume/advance THIS epic by pointing the workflow at the named doc
   (`/project:epic-dev --resume` operates on the state file you place; keep #885's
   `epic.local.md` untouched). Never run a bare start again from this checkout.

**Worktree isolation:** use a **dedicated worktree off `dev`**, mirroring the existing
`../epic-896-arch-hardening` and `../epic-secrets-infisical`:
`git worktree add ../epic-test-staging -b feature/issue-NNN-epic-test-staging dev`.
Keeps `dev` clean and the epic's working files off the other epics' trees. (Phase
worktrees branch off the epic branch, per the epic-dev flow. Note: fresh worktrees do
NOT carry the gitignored `.local.md` files, so the state doc must live where you run the
workflow — keep it consistent.)

**Code/merge coordination (shared backend files):** two in-flight epics edit files this
epic also touches; both branch off `dev`, so landing close together risks conflicts at
the `dev` integration:
- **#896 arch-hardening** (active, `../epic-896-arch-hardening`) touches
  `publication-orchestrator.ts` (DOI reconcile, #900), `data-router.ts` / `dispatch.ts`
  (file_size #895), STS prefix-scoping (#901), and `deploy-backend.yml` (#897). This epic
  edits the **same** `publication-orchestrator.ts` (xx-gate relaxation, Phase 4),
  `data-router.ts` (bytes_url origin, Phase 4), and `dispatch.ts` (bucket param, Phase 5).
  → Sequence: let #896's P0s (#897 deploy-safety, #886 partsize) land first; coordinate
  the shared-file edits and rebase whichever lands second. #896's #901 STS work and this
  epic's Phase 2 AWS/credential changes interact — align on the dev principal scoping.
- **#885 secrets-infisical** (resting) will eventually bring **all** dev-worker secrets
  under Infisical. This epic ADDS new dev secrets/principal (nemar-dev AWS keys,
  `EZID_SANDBOX_*` audit, `DEV_WEBHOOK_MIRROR_URL`). → Feed these into the #885 secret
  inventory (`.context/plan-secrets-infisical-migration.md`) so they're not missed at
  cutover; no blocking dependency either way.

Do NOT run `/project:epic-dev --finalize` for any other epic while this one is active,
and keep each epic's issues/PRs and its named state doc in sync (per AGENTS.md).

---

## Key facts verified during exploration (anchor points)

- Bucket is fully env-driven: every S3 touchpoint reads `env.S3_BUCKET`; **no hardcoded
  `"nemar"` literal** in backend source. `bucket-policy.ts` (public-by-default deny-list,
  `PublicReadExceptPrivate` Sid) is bucket-parameterized. Flipping the bucket is one config line.
- Hostname dispatch is **hardcoded** to `data.nemar.org` / `zarr.nemar.org`
  (`backend/src/index.ts:207-229`) — must be generalized for the `-test` hosts.
- ID cap: `MAX_NUMBER = 99999`, `isValidDatasetId` rejects >99999
  (`backend/src/services/datasetId.ts:13-15,101-106`). So the partition must live **inside**
  that range: `xx090001+`, **not** `xx900001` (which would fail validation everywhere).
- Non-prod already forces every uploaded dataset to `xx` (`routes/datasets/upload.ts:142-157`).
- Hard `xx` publish blockers (literal `startsWith("xx")`): `publication-orchestrator.ts:1957-1967`,
  `routes/datasets/publication.ts:85`, `routes/admin/doi.ts:122,423`,
  `services/dataset-reindex.ts:96-98,443-449`.
- DOI sandbox path is already fully plumbed (`services/doi.ts` `resolveEzidAuth(sandbox)`/
  `resolveShoulder(sandbox)`, `TEST_SHOULDER="doi:10.5072/FK2"`). The **only** hardcode is the
  landing URL (`shared/datacite-constants.ts:200-210`), used as EZID `_target` in ~7 callers.
- `s3_lock` uses Object Lock GOVERNANCE 100-yr retention (`services/s3.ts:826-835`) — Object Lock
  is **creation-time only**, so `nemar-dev` must be created with it (and versioning) enabled.
- Legacy `revokeUserIamAccess` (`routes/admin/users.ts:35`) deletes **global** IAM users
  `nemar-user-<username>` — a dev revoke could delete a prod user's IAM identity unless the dev
  AWS principal has zero `iam:*`.
- Website `PUBLIC_*` base URLs are baked at **build time** (`import.meta.env`, not wrangler runtime
  vars): `src/lib/api-base.ts`, `data-api.ts`, `zarr-base.ts` (the last not in `wrangler.toml`).
  `test.nemar.org` auto-falls into `host.ts` "single" mode (dashboard/auth on one host, no
  redirects). No robots.txt / noindex anywhere in the repo.
- CORS already allows `*.nemar.org` (`index.ts:74`, `zarr-data.ts:40`) — `-test` hosts covered.
- ORCID redirect_uri is registered for `app.nemar.org` only — SSO won't complete on
  `test.nemar.org`; email-code login (`dev_code` in dev responses) covers auth testing.

---

## Gating model (applies across phases)

Two orthogonal mechanisms, used together:

1. **`ENVIRONMENT !== "production"`** — for prod-safety fences (ID partition, on-import block,
   webhook forwarding, cron behavior). Prod is unaffected because it *is* production.
2. **New `is_exemplar` D1 column** (migration `0057`) — for the curated fleet. Needed because
   `stepDoiCreate` rewrites `is_sandbox = sandbox ? 1 : 0` at DOI mint
   (`publication-orchestrator.ts:910/916/934`), so a sandbox-DOI publish would flip
   `is_sandbox` back to 1 and the row would vanish from catalog/search. An orthogonal
   `is_exemplar` flag survives that write, keeps every SQL predicate env-independent (prod never
   has `is_exemplar=1` rows), and gives cleanup a precise exemption.

Publish paths allow an `xx` dataset only when
`dataset_id LIKE 'xx%' AND is_exemplar = 1 AND ENVIRONMENT !== 'production'` (belt and
suspenders). A single helper `backend/src/services/exemplar.ts` (`isExemplarPublishAllowed(env, row)`
+ a shared SQL predicate fragment) prevents the six+ call sites from drifting.

**ID bands (inside the 0–99999 cap):**
| Band | Range | Purpose | Cleanup |
|---|---|---|---|
| Prod sandbox | `xx000001`–`xx089999` | real user sandbox training | 14-day cron (prod) |
| Dev ephemeral sandbox | `xx090001`–`xx099899` | throwaway dev/e2e | dev cron (Phase 7) |
| Dev exemplar fleet | `xx099900`–`xx099999` | curated persistent copies | **never** (`is_exemplar=1`) |

Mechanism: `SANDBOX_ID_FLOOR`/`SANDBOX_ID_CEILING` env vars threaded into
`generateDatasetId` (the gap-fill loop already skips `candidate < start`); prod sets
`CEILING="89999"`, dev sets `FLOOR="90001"`. Exemplar IDs are operator-pinned in the fleet spec.

---

## Phase 1 — Prod-safety foundation (backend; deployable to prod as no-ops)

Everything here is inert or narrowing on prod; promote to `main` **promptly** so prod stops
dispatching against dev-created repos.

- **Migration** `backend/src/db/migrations/0057_dataset_exemplar.sql`:
  `ALTER TABLE datasets ADD COLUMN is_exemplar INTEGER NOT NULL DEFAULT 0;`
- **`datasetId.ts`**: add `{start,max}` opts to `findLowestUnusedNumber`; `{sandboxIdFloor,
  sandboxIdCeiling}` to `generateDatasetId`; export `DEV_SANDBOX_RANGE_RE = /^xx09\d{4}$/` +
  `isDevRangeDatasetId(id)` (reused by Phase 5 forwarder + Phase 7 cron).
- **`routes/datasets/upload.ts`** (~298): pass floor/ceiling from `c.env`. Also make the
  `SANDBOX_MAX_TOTAL_SIZE = 10 MB` cap (`upload.ts:70,178-194`) env-conditional (e.g. 500 MB when
  `ENVIRONMENT !== "production"`) so realistic exemplars/CLI staging uploads aren't blocked; the clone
  tool bypasses this via server-side copy, but direct CLI uploads on staging would hit it.
- **`routes/admin/imports.ts`**: `if (c.env.ENVIRONMENT !== "production") return 403` at the top of
  `POST /admin/datasets/import` (on###### names are deterministic → would collide in the shared org;
  auto-import already double-gated in dev). Document that import-pipeline E2E stays a prod-sandbox activity.
- **`routes/webhooks/github.ts`**: after payload parse, if `isDevRangeDatasetId(repo.name)`, return
  early `{ ok:true, dispatched:false, reason:"dev_range_repo" }` (forward half added in Phase 5).
  Unit-test the boundary: `xx089999`→prod, `xx090000`→dev, `nm090000`→prod, `on090000`→prod.
- **`types/bindings.ts`** + **`wrangler-sccn.toml`**: add `SANDBOX_ID_FLOOR?`/`SANDBOX_ID_CEILING?`
  (and `DEV_WEBHOOK_MIRROR_URL?`, `DATA_HOSTNAME?`, `ZARR_HOSTNAME?`, `DATASET_LANDING_BASE_URL?` now,
  used later). Prod `[vars]`: `SANDBOX_ID_CEILING="89999"`. `[env.dev.vars]`: `SANDBOX_ID_FLOOR="90001"`.
- Unit tests for the generator, webhook gate, import block.

## Phase 2 — Dedicated bucket + AWS + secret hygiene (owner-heavy + one config line)

**Owner actions (AWS):**
- Create `nemar-dev` in `us-east-2` **with Object Lock (+ versioning) enabled**; allow public
  bucket policies (`BlockPublicPolicy=false`, `RestrictPublicBuckets=false`). The worker self-heals
  the `PublicReadExceptPrivate` statement on first publish (optionally seed it with the `staging/*` carve-out).
- Create IAM user `nemar-worker-dev`: `s3:*` on `arn:aws:s3:::nemar-dev[/*]` (incl.
  `PutObjectRetention`, `BypassGovernanceRetention`, `Get/PutBucketPolicy`) + `sts:GetFederationToken`,
  and **zero `iam:*`** (fences the legacy revoke path and every federated session to the dev bucket).

**Owner actions (dev worker secrets, `cfman wrangler ... secret ... --env dev`):**
- Rotate `AWS_ACCESS_KEY_ID`/`SECRET` to the `nemar-worker-dev` keys **in the same window** as the
  `S3_BUCKET` flip below.
- Ensure present: `GITHUB_ADMIN_PAT`/`GITHUB_APP_*`, `ENCRYPTION_KEY`, `RESEND_API_KEY`,
  `GITHUB_WEBHOOK_SECRET` (**must equal** the nemar-publish-bot App secret — Phase 5 re-posts the HMAC),
  `NEMAR_WEBHOOK_TOKEN`, `EZID_SANDBOX_USERNAME/PASSWORD`, `ZENODO_SANDBOX_API_KEY`,
  `MANIFEST_CALLBACK_SECRET`, `PRESCREEN_CALLBACK_SECRET`, `OPENROUTER_API_KEY`.
- Ensure **absent** (defense-in-depth over the code gates): `EZID_USERNAME`, `EZID_PASSWORD`, `ZENODO_API_KEY`.

**Code/config:** flip `[env.dev.vars]` `S3_BUCKET = "nemar-dev"` (the single most important line),
and `MANIFEST_VIA_CENTRAL_WORKFLOW = "false"` so manifests generate **inline in the worker** into
the dev bucket. Rationale: the central manifest workflow (`services/github/dispatch.ts:136-177`)
sends no bucket and the org workflow hardcodes `s3://nemar` — it can't follow the bucket switch
without the Phase 5 payload change. Inline generation is fine for small staging exemplars (the
file-count timeout wall doesn't bite). Phase 5's `s3_bucket` dispatch param is the fuller solution
that also fixes archive/zarr; the inline flip unblocks manifests immediately.

**D1 hygiene (owner + implementer, read-only first):** inventory legacy dev `xx`/`on` rows below the
floor; remove only via **plain D1 row deletes** — **never** `deleteDatasetCascade` /
`nemar admin delete-dataset` (cascade would delete the same-named shared-org repo + S3 prefix).

## Phase 3 — Custom domains + hostname generalization (backend + owner CF)

- **`index.ts:207-229`**: replace the two host literals with
  `const dataHost = (c.env.DATA_HOSTNAME||"data.nemar.org").toLowerCase()` (same for zarr); keep the
  read from `c.req.url` hostname (anti-forged-Host). Explicit vars, not suffix matching.
- **`wrangler-sccn.toml`**: prod `[vars]` set `DATA_HOSTNAME`/`ZARR_HOSTNAME` explicitly (parity).
  `[env.dev]`: `routes` = `api-test` / `data-test` / `zarr-test.nemar.org` (`custom_domain=true`).
  `[env.dev.vars]`: `API_BASE_URL="https://api-test.nemar.org"`, `FRONTEND_URL`/`APP_BASE_URL=
  "https://test.nemar.org"`, `DATA_HOSTNAME="data-test.nemar.org"`, `ZARR_HOSTNAME="zarr-test.nemar.org"`,
  `ZARR_CACHE_BASE_URL="https://zarr-test.nemar.org"` (purge stays inert / URL-scoped, can't touch prod).
- **Web-session cookie (host-aware):** set `WEB_SESSION_COOKIE_DOMAIN="test.nemar.org"` so the
  same-origin-proxy login flow works (the website mirrors `Set-Cookie` from the dev worker, matching
  prod's `app.nemar.org` model). But a `Domain=test.nemar.org` cookie emitted on the `*.workers.dev`
  fallback host is **rejected by browsers**, breaking existing workers.dev dashboard testing. Add
  `resolveCookieDomain(env, requestUrl)` in `services/web-session.ts` — return the configured domain only
  when the request hostname equals it or is a `.nemar.org` subdomain, else `undefined` (host-only). Update
  call sites `routes/auth-web.ts:344,379,402` and `routes/auth-orcid.ts:91-93`. `SameSite=Lax` is fine
  (test↔api-test are same registrable domain).
- **Owner (CF dashboard):** attach the three custom domains to `nemar-api-dev` (auto DNS+TLS on the
  nemar.org zone). Do this **before** the CI deploy so `wrangler deploy --env dev` is a no-op reconcile
  (the dev CF token may lack zone scope). Validate one manual `cfman` deploy if unsure. Register
  `https://test.nemar.org/auth/orcid/callback` on the **sandbox** ORCID app (`orcid-auth.ts:64` already
  picks sandbox.orcid.org for non-prod; keep localhost registered too).

## Phase 4 — Gate relaxation + landing URL (backend)

- **`services/exemplar.ts`** (new): `isExemplarPublishAllowed(env,row)` + exported SQL predicate fragment.
- Relax the five hard `xx` blocks to "block unless exemplar-allowed": `publication-orchestrator.ts:
  1957-1967` (add `is_exemplar` to the row select), `routes/datasets/publication.ts:85` (also except the
  `is_sandbox||` half — v2 re-publish runs after `doi_create` set `is_sandbox=1`), `routes/admin/doi.ts:
  122,423`, `services/dataset-reindex.ts:96-98` (select + throw only for non-exemplar xx) and `:443-449`
  (`buildReindexFilterQuery` base → `AND (dataset_id NOT LIKE 'xx%' OR is_exemplar=1)`, pure SQL).
- **Visibility predicates** include `OR is_exemplar=1`: `routes/datasets/catalog.ts:221,421`,
  `services/dataset-search.ts:137,262,290,351`, `routes/data.ts:1207` (+ `CatalogIndexRow`),
  `services/data-router.ts:1382-1387` (`isPublicCatalogId(id,{isExemplar})`, keep the `nm099999`/shape guards).
- **Cleanup exemption (defensive, prod-only cron today):** `index.ts:283` sandbox-delete query gains
  `AND is_exemplar=0`.
- **Landing URL parameterization:** `shared/datacite-constants.ts` — add optional `baseUrl`
  (default `"https://nemar.org"`, file stays zero-dep). Thread a resolved base
  (`env.FRONTEND_URL` normalized, or a dedicated `DATASET_LANDING_BASE_URL`, defaulting to nemar.org)
  through the callers: `services/doi.ts:193,302`, `publication-orchestrator.ts:1237,1324`,
  `routes/admin/doi.ts:759,767,832`, `services/llm-enrich.ts:378`, `services/enrich-dataset.ts:401`,
  plus `routes/callbacks/version-doi.ts:600` and `services/central-manifest.ts:234`. Dev's
  `FRONTEND_URL` is already `https://test.nemar.org` (Phase 3); prod keeps nemar.org → zero prod diff.
- **Data-plane bytes_url origin:** `DATA_NEMAR_ORIGIN` is hardcoded at `services/data-router.ts:249`
  (feeds `buildBytesUrl`, single caller `routes/data.ts:247`). On staging, served manifests would embed
  `https://data.nemar.org/...` links for dev-bucket-only datasets. Add an optional origin param defaulting
  to the prod constant, resolved from a new optional `[env.dev]` var `DATA_BASE_URL="https://data-test.nemar.org"`
  (prod leaves it unset → identical output).
- Unit tests: `isExemplarPublishAllowed` (all env/flag/prefix combos), reindex filter, `isPublicCatalogId`
  exemplar case.

## Phase 5 — Exemplar creation endpoint + CLI clone tool + webhook forwarder (backend + CLI + cross-repo)

**Creation endpoint** `backend/src/routes/admin/exemplar.ts` (modeled on `imports.ts:45-194`):
- `POST /admin/datasets/exemplar` — `403` if `ENVIRONMENT==="production"`; zod: `dataset_id` matches
  `/^xx099\d{2}$/` (pins the exemplar band), `source_id` matches `/^(nm|on)\d{6}$/`, optional `seed`
  metadata; creates `nemarDatasets/<xx>` repo + inserts row `is_exemplar=1, is_sandbox=0,
  visibility='private', source='nemar-exemplar', source_id=<src>`; GitHub-repo rollback on D1 failure.
- Companion `POST /admin/datasets/:id/exemplar/remint-dois` (idempotent EZID re-mint; identifiers are
  deterministic and `createEzidConceptDoi` tolerates "already exists").
- CLI API client: `createExemplar()`, `remintExemplarDois()` in `src/lib/api/admin.ts`.

**CLI clone tool** `src/lib/exemplar-clone.ts` + `nemar admin exemplar create <xxId>|--all / status /
remint-dois` in `src/commands/admin.ts`, patterned on `src/lib/import-openneuro.ts` (single-process — the
fleet is small), driven by `scripts/exemplar-fleet.json`. Per-exemplar prepare/copy/finalize:
1. **prepare**: anonymous clone of the (public, published) source repo; strip tags; scrub
   `dataset_description.json` (`Name`→`"[TEST COPY] …"`, drop `DatasetDOI`); **keep** `.nemar/metadata.json`
   (source_hash matches → reindex reuses it, skips the LLM); `createExemplar()`; mark inherited prod
   `nemar-s3` remote dead; `initremote` a fresh `nemar-s3-dev` (`bucket=nemar-dev,
   fileprefix=<xx>/objects/`); push main + git-annex branches.
2. **copy**: `listExistingObjects("nemar","<src>/objects/")` → `batchServerSideCopy` **cross-bucket
   same-account** `s3://nemar/<src>/objects/*` → `s3://nemar-dev/<xx>/objects/*` (source public-read;
   resume via `filterAlreadyCopied`). `--include-derived` also copies `zarr/*`, `archives/*`, `records.json`
   with the `<src>→<xx>` prefix rewrite for immediate render coverage.
3. **finalize**: verify listing; `batchSetKeysPresent` against the `nemar-s3-dev` uuid (uuid-match guard);
   push git-annex; `addCi()`; `waitForBidsValidationRun`; `reindexDataset()` (now exemplar-allowed →
   exercises the real metadata-column pipeline).
4. `--publish`: `requestPublication()` + `approvePublication(..., sandbox=true)` (flag already plumbed;
   `stepVersionDoi` auto-detects sandbox from the `10.5072` identifier).

Fleet spec: ~7 small exemplars covering EEG / MEG / iEEG / EMG / HED (`has_hed=1`) / zarr-ready /
archive-ready, sources chosen by smallest-of-modality from the prod catalog (HBN-scale excluded; whole
fleet < ~5–10 GB). **Never writes to source** (respect `LIVE_DATASETS` nm000103-107 read-only).

**Webhook forwarder** (the one substantive prod deploy — keep the PR to exactly this diff):
- `routes/webhooks/github.ts` — inside the Phase 1 dev-range gate, add prod-only, config-gated,
  fire-and-forget mirroring to `c.env.DEV_WEBHOOK_MIRROR_URL` (re-post raw body + original
  `x-hub-signature-256`/`x-github-event`/`x-github-delivery`, `c.executionCtx.waitUntil`, `.catch` log).
  Dev verifies the original HMAC with its own (equal) `GITHUB_WEBHOOK_SECRET`. Outbound-only → cannot
  mutate prod; a dev outage never affects prod latency.
- Prod `[vars]`: `DEV_WEBHOOK_MIRROR_URL="https://api-test.nemar.org/webhooks/github"`.

**Central-workflow env-awareness** (required once the dev bucket splits, else manifest/archive/zarr write to
the wrong bucket): add `s3_bucket` + `callback_base_url` to the `client_payload` in
`backend/src/services/github/dispatch.ts` (manifest = **required**, plus archive/zarr/version-doi), backend
passes `env.S3_BUCKET`/`env.API_BASE_URL`. Spec the matching read-with-prod-default change in the external
`nemarDatasets/.github` workflows (**owner deploys**, backward compatible). Parameterize the five hardcoded
`https://api.nemar.org/webhooks/import-state` literals in `.github/dataset-workflows/onboard-openneuro.yml`
(low urgency; owner copies to the org repo).

## Phase 6 — Website staging (website repo)

Separate Pages project **`nemar-website-test`** (build-time `PUBLIC_*` baking makes shared-project preview
env vars useless anyway; a distinct project makes a `--branch main` cross-deploy structurally impossible;
the existing project's prod branch is the non-obvious `feature/issue-1-epic-nemar-redesign`).
- **New `wrangler.test.toml`**: `name="nemar-website-test"`, `[vars]` documenting the three `-test` bases
  (prevents the prod `wrangler.toml` vars syncing onto the test project).
- **New `.github/workflows/deploy-test.yml`**: `push:[staging]` + `workflow_dispatch`; build with
  `NEMAR_SKIP_OG_GENERATE=1 PUBLIC_API_BASE_URL=https://api-test.nemar.org
  PUBLIC_DATA_BASE_URL=https://data-test.nemar.org PUBLIC_ZARR_BASE_URL=https://zarr-test.nemar.org
  bun run build`; then `wrangler pages deploy dist --project-name nemar-website-test --branch main
  -c wrangler.test.toml`. **Owner:** add `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` repo secrets; create the
  `staging` branch; attach `test.nemar.org` + a new `SESSION_SECRET`.
- Add `PUBLIC_ZARR_BASE_URL` to the main `wrangler.toml` (parity/docs).
- **Noindex** (none exists today): `src/lib/host.ts` add `isProductionHost()`; `src/middleware.ts` set
  `X-Robots-Tag: noindex, nofollow` when `!isProductionHost && !localhost` (also protects `*.pages.dev`);
  new dynamic `src/pages/robots.txt.ts` (`Disallow: /` off-prod, allow-all on prod).
- `AGENTS.md`: document the test project, deploy flow, and the **ORCID limitation** (use email-code +
  `dev_code`).

## Phase 7 — Dev cron, publish the fleet, E2E validation (backend + runbook)

- `[env.dev.triggers] crons = ["0 4 * * *"]` (no `*/30` tick — `AUTO_IMPORT_ENABLED="false"` stays the
  second gate). In `scheduledCleanup`: non-prod sandbox-delete constrained to the ephemeral band
  (`>= 'xx090001' AND < 'xx099900'`, so exemplars + legacy rows are never touched); **skip the
  staleness-warning email block entirely when non-prod** (dev has real `RESEND_API_KEY`). Leave embedding
  drain / archive retry / citation sync running in dev (dev-scoped).
- Run `nemar admin exemplar create --all --publish` against `api-test.nemar.org`.
- Verify per exemplar: 16 steps complete; `concept_doi = doi:10.5072/FK2XX0999NN`; EZID `_target` =
  `https://test.nemar.org/dataset/xx0999NN`; manifest in `nemar-dev`; test.nemar.org browse/search/detail
  render; `data-test` lists + serves; `zarr-test` serves stores. Run one update-cycle (v2 re-publish) to
  prove the `is_sandbox=1` re-publish path.

---

## Verification (end-to-end smoke — validates the epics this staging exists for)

1. `nemar auth login` against `https://api-test.nemar.org`; email-code signup on `test.nemar.org`
   (dev returns `dev_code`).
2. CLI upload of a sandbox dataset → confirm ID `>= xx090001`, repo `nemarDatasets/xx09xxxx`, objects under
   `s3://nemar-dev/…`, **prod bucket untouched** (S3/CloudTrail check).
3. `nemar admin exemplar create xx099900 --publish` → full orchestrator → sandbox EZID DOI →
   `s3_lock` GOVERNANCE retention in `nemar-dev` → public carve-out flips → `data-test.nemar.org/xx099900/`
   serves.
4. Push a README change to an `xx09*` repo → prod logs `dev_range_repo` + mirror success → dev logs
   signature-verified dispatch → enrichment round-trips to dev D1.
5. `curl -sI https://test.nemar.org | grep -i x-robots-tag`; confirm `test.nemar.org/robots.txt` disallows;
   confirm page network calls hit `api-test`/`data-test`.
6. `bun test` (backend + CLI unit tests) green; `/review-pr` on each phase PR and on the epic→dev PR.

---

## Consolidated prod-safety register

| Leak vector | Fence | Phase |
|---|---|---|
| Shared S3 bucket (today's main hazard) | `S3_BUCKET="nemar-dev"` + dev AWS principal that can't address `arn:aws:s3:::nemar` | 2 |
| Shared IAM namespace (`nemar-user-*` revoke) | dev principal has **zero `iam:*`** | 2 |
| Shared GitHub org repo create/delete collisions | ID partition (dev floor 90001 / prod ceiling 89999); on-import 403 in dev; legacy rows via raw deletes only | 1,2 |
| Shared GitHub App (one delivery URL) | prod dev-range gate + outbound-only config-gated `waitUntil` mirror | 1,5 |
| Prod DOI/Zenodo minting from dev | existing `ENVIRONMENT` gates **plus** prod DOI secrets absent from dev | 2,4 |
| Prod cache purge from dev | `ZARR_CACHE_BASE_URL` empty or URL-scoped `zarr-test` | 3 |
| Website cross-deploy | separate Pages project + separate wrangler config; prod deploy command untouched | 6 |
| Search-engine leakage of test content | host-gated `X-Robots-Tag` + dynamic robots.txt | 6 |
| Central workflows writing to prod bucket | `s3_bucket`/`callback_base_url` in dispatch payload | 5 |

## Known limitations (accepted, documented)

- ORCID SSO can't complete on `test.nemar.org` (redirect_uri = app.nemar.org only) — email-code covers auth.
- OpenNeuro import pipeline not E2E-testable in staging (on-name determinism + shared org); blocked with a 403.
- Rate limiting is skipped entirely in dev — staging doesn't validate rate-limit behavior.
- Test EZID (`10.5072/FK2`) DOIs self-delete after ~2 weeks; `remint-dois` refreshes them; resolution
  breakage between refreshes is accepted.
- Any legacy dev-era S3 objects already in the prod bucket are left as documented orphans.

## Critical files
- `backend/wrangler-sccn.toml` — env vars, `[env.dev]` routes/bucket/triggers
- `backend/src/services/datasetId.ts` — ID partition
- `backend/src/index.ts` — hostname dispatch, `scheduledCleanup`
- `backend/src/routes/webhooks/github.ts` — dev-range gate + forwarder
- `backend/src/services/publication-orchestrator.ts` + `routes/admin/doi.ts` + `routes/datasets/publication.ts` + `services/dataset-reindex.ts` — xx block relaxation
- `shared/datacite-constants.ts` — landing URL parameterization
- `backend/src/routes/admin/imports.ts` — model for new `routes/admin/exemplar.ts`
- `src/lib/import-openneuro.ts` — model for new `src/lib/exemplar-clone.ts`
- `website/src/middleware.ts` + `src/lib/host.ts` + new `wrangler.test.toml` / `.github/workflows/deploy-test.yml` / `src/pages/robots.txt.ts`
