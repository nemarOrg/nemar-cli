# NEMAR CLI - Development Instructions

> Tool-agnostic project instructions for any coding agent (Codex, Cursor, Copilot, Windsurf, Claude Code, ...). Claude Code reads this via `@AGENTS.md` in `CLAUDE.md`.

## START HERE: Architecture Decision Records

**[`.context/decisions/`](.context/decisions/README.md) records what was decided and why.** Read the
index before designing anything, and before "fixing" something that looks wrong — several of the
oddities in this codebase are deliberate, and the ADR says which.

- **Where an ADR and any other doc disagree, the ADR wins.** Design docs under `.context/` keep the
  analysis; the ADR is the verdict.
- **Never delete an ADR. Supersede it** (see ADR 0019 for what a superseded one looks like).
- **Write a new one** when a decision is expensive to reverse, closes off other reasonable paths, has
  been argued more than once, or encodes a constraint that is not obvious from the code. Copy
  `0000-template.md`, number sequentially, and add it to the index in `README.md` — a test enforces
  that the index and the files on disk agree.

Load-bearing ones to know before touching the relevant area: 0005 (partial data still serves),
0009 (dev D1 is not a prod mirror), 0010 (never client-stream an import), 0012 (archive size policy),
0016 (never hand-bump versions), 0020 (workflow edits hit ~785 repos at once).

## CRITICAL: Live Datasets

**nm000103-nm000107 are LIVE datasets.** Do NOT modify their visibility, S3 data, DOIs, or repo settings during development/testing. They are kept private during dev for maximum control but contain real data.

For E2E testing, use test dataset `nm099999`. It is created on-demand via `POST /admin/datasets/nm099999/reset` (lazy creation if missing). Run the full E2E cycle with:

```bash
nemar admin e2e-test --verbose    # Reset, upload, clone, download, update cycle
nemar admin e2e-test --skip-reset # Reuse existing nm099999 state
```

The E2E test (`src/lib/e2e-test.ts`) runs a 10-step pipeline: reset, prepare fixtures, init git-annex, configure S3/GitHub remotes, upload, push, clone, download+verify, update cycle, cleanup. It uses `test/fixtures/bids-minimal/` as the source BIDS dataset.

Note: `xx`-prefix datasets are blocked from publishing (sandbox check).

## Dataset Deletion

Datasets can be deleted via `DELETE /admin/datasets/:id` or `nemar admin delete-dataset <id>`. Deletion cascades through GitHub repo, S3 objects, and D1 records (`dataset_versions`, `publication_requests`, `datasets`; `dataset_collaborators` auto-cascades via FK).

**Permission model:**
- Unpublished datasets (no DOI, private): admin or owner can delete
- Published datasets (with DOI or public): owner only, requires `force=true`

**Scheduled cleanup** (daily at 3 AM UTC, production only):
- Sandbox (`xx`) datasets: auto-deleted after 14 days
- Stale `nm` datasets: private, no DOI, no active pub requests, inactive 90 days

**Note:** `last_activity_at` must be updated by endpoints that mutate datasets (uploads, version creation, publication requests) to prevent premature staleness. See migration 0011.

## Project Overview
**Purpose:** Command-line interface for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource) dataset management
**Tech Stack:** TypeScript, Bun, Commander.js, DataLad integration
**Repository:** https://github.com/nemarOrg/nemar-cli

### GitHub Organization Structure
- **nemarOrg** - Tooling and infrastructure repos (nemar-cli, nemar-tools, nemar-metadata, neuroschema)
- **nemarDatasets** - Dataset repos only (nm000103, nm000104, etc.)

The backend code (`ORG_NAME = "nemarDatasets"` in `backend/src/services/github.ts`) and publishing scripts intentionally target `nemarDatasets` because that is where dataset repos live. Do not change these to `nemarOrg`.

## Architecture Overview

### Backend Infrastructure
- **API URL:** `https://api.nemar.org` (canonical production, SCCN account)
- **Workers URL:** `https://nemar-api.sccn-org.workers.dev` (SCCN account fallback for the same worker)
- **Legacy URL:** `https://api.osc.earth/nemar` (retired personal account; sunset complete — old CLIs may still hit it briefly during migration, but it's not a deployment target)
- **Platform:** Cloudflare Workers + D1 (SQLite)
- **Cloudflare account:** SCCN only (personal/`neuromechanist` retired as of 2026-05-18). Use `npx cfman wrangler --account sccn` for all operations.
- **Wrangler config:** `backend/wrangler-sccn.toml` (the only active config; the former personal-account `backend/wrangler.toml` was removed)

### Database backup & disaster recovery (#655 / epic #794)
- D1 (`nemar-db`) is backed up hourly to the **private** repo `nemarOrg/nemar-db-backup`
  (GitHub Actions cron; git history = point-in-time recovery). It is the only stateful CF
  resource backed up; Vectorize is rebuildable (`nemar admin reindex`), Analytics Engine is telemetry.
- **fts5 gotcha:** `wrangler d1 export` refuses any DB with an fts5 virtual table
  (`datasets_fts`). The backup works around it by exporting each real table with `--table` and
  recreating the index from `sqlite_master` on restore. Do NOT expect a plain whole-DB export to work.
- **Restore (DR):** `scripts/restore-remote.sh --target <db> --execute` (guarded, verifies
  sha256 + row counts; refuses prod without `--force-prod`). **Run the Worker locally against a
  real snapshot:** `scripts/run-local.sh --nemar-cli <path>` (loads the backup into a local
  miniflare D1, then `wrangler dev`). Both live in `nemarOrg/nemar-db-backup`.

### Public Browser Sites

**The cutover is done: `https://nemar.org` IS the dataset browser** (Astro SSR, lives in
`nemarOrg/website`). Dataset pages at `nemar.org/dataset/<id>`, versions `?v=v<version>`. Reads
`api.nemar.org` and `data.nemar.org` directly. This is also the canonical DOI landing target
(`datasetLandingUrl` / `datasetVersionLandingUrl` in `shared/datacite-constants.ts`), so DOIs now
resolve straight to the site they name instead of being forwarded.

- **`https://ww2.nemar.org`** — the pre-cutover hostname for the same Astro site. Still resolves;
  treat it as a legacy alias, not a deployment target. Do not use it in new code, docs, or comments.
- **`https://nemar.org/dataexplorer/...`** — **the legacy PHP site is gone.** Its URLs now 301 to
  `nemar.org/dataset/<id>`. Epic #837 had already severed the data coupling (outgoing datapipeline
  push and the incoming 4h catalog pull removed, our `nm`/`on` records purged from its
  `dataexplorer_*` tables, legacy `ds######` shadow rows dropped from our D1); the hostname handover
  completed it.
- **Default in docs/comments:** "the website," "the browser," or "the UI" unqualified means
  `nemar.org`. There is no longer a distinction to draw — if you find a comment contrasting
  ww2 with nemar.org, or calling nemar.org "legacy," it predates the cutover and is wrong.

### S3 Bucket Structure
```
s3://nemar/{datasetId}/
    objects/                     # git-annex content-addressed blobs
    version/                     # version manifests (v1.0.0.json)
    archives/                    # downloadable zip snapshots (v1.0.0.zip)
s3://nemar/staging/pr-{n}/{datasetId}/objects/   # PR staging area
```

### Staging environment (epic #923)

A full parallel stack for exercising cross-cutting changes **before they touch production**.
It is served by the existing dev worker (`nemar-api-dev`), not a new one.

| Surface | Production | Staging |
|---|---|---|
| API | `api.nemar.org` | `api-test.nemar.org` |
| Data plane | `data.nemar.org` | `data-test.nemar.org` |
| Zarr | `zarr.nemar.org` | `zarr-test.nemar.org` |
| Website | `nemar.org` (`nemar-website` Pages) | `test.nemar.org` (`nemar-website-test` Pages) |
| S3 | `s3://nemar` | `s3://nemar-dev` |
| D1 | `nemar-db` | `nemar-db-dev` |

**Deploy:** `npx cfman wrangler --account sccn -- deploy --env dev -c backend/wrangler-sccn.toml`.
This also provisions the custom domains and registers the dev cron. The website deploys from the
`staging` branch of `nemarOrg/website`; note `wrangler pages deploy` REJECTS `-c <path>`, so the
staging config must be moved into place as `wrangler.toml`.

**Auth:** none of the production account keys work against dev. Use `TEST_ADMIN_API_KEY` from
`test/.env.test` (it matches the `test-admin` token seeded by `scripts/seed-dev-db.sql`), with an
isolated `NEMAR_CONFIG_DIR` so the real `~/.config/nemar` is never clobbered.

#### DANGER: dev D1 shares production users and the GitHub org

**Catalog policy (set 2026-07-20):** `nemar-db-dev` no longer mirrors production's dataset catalog.
It was purged to the curated fixtures ONLY — the seven `xx0999NN` exemplars plus the private E2E
dataset `nm099999` — and must stay that way. **Do NOT re-seed production `nm`/`ds` rows into dev
D1;** the staging catalog is intentionally exemplars-only so both planes present a completely
separate system. (Before the purge it carried ~190 real `nm` rows and ~30 legacy `ds` shadow rows
that #837 had already dropped from prod; those were catalog-only phantoms with no data in
`nemar-dev`.)

The `users` table was NOT purged: it still holds ~609 real email addresses, and the dev worker
holds a live `RESEND_API_KEY`. The `nemarDatasets` GitHub org is also SHARED between prod and dev
(the org name is hardcoded, not env-scoped). So a dev-side job that selects users by a generic
predicate can still email real people, and a cascade delete can still destroy a real repo.
**The prod-safety fences below therefore remain load-bearing** — the dataset purge removed one
blast-radius vector, not the reason the fences exist.

The daily dev cron (`[env.dev.triggers]`, `0 4 * * *`) is governed by a fail-safe allowlist in
`scheduled()`: **a new daily job is production-only BY DEFAULT.** Before adding one to the non-prod
set, confirm it cannot email a real user, dispatch GitHub work against `nemarDatasets`, or mutate a
real DOI or prod-bucket object. `scheduledCleanup` self-narrows outside production: sandbox deletion
is pinned to the dev ephemeral band, and the staleness-email and import-recovery sections are
production-only. `archiveRetrySweep` and `reconcileReservedVersionDois` refuse to run off-prod;
the blocked-publication sweep is SCOPED to `xx09%` rather than disabled, because staging needs it.

#### Dataset ID bands (all inside the 0-99999 cap; `xx900001` is INVALID)

| Band | Range | Purpose | Cleanup |
|---|---|---|---|
| Prod sandbox | `xx000001`-`xx089999` | real user sandbox training | 14-day cron (prod) |
| Dev ephemeral | `xx090001`-`xx099899` | throwaway dev/e2e | dev cron |
| Dev exemplar fleet | `xx099900`-`xx099999` | curated persistent copies | **never** (`is_exemplar=1`) |

#### Exemplar fleet

Seven curated `xx0999NN` copies of real public datasets (`scripts/exemplar-fleet.json`), covering
eeg / ieeg / emg / meg / multi-modal / HED, published with **sandbox** EZID DOIs
(`10.5072/FK2`, never the production `10.82901` shoulder). Manage with
`nemar admin exemplar create|status|remint-dois`.

**They are permanent published fixtures, not ephemeral sandbox rows.** Their `active`/`public`
state lives in D1 and is the source of truth for the staging catalog; it does not depend on the
registrar. The cleanup cron never touches them (`is_exemplar=1` is filtered out AND `xx099900+`
sits above the dev ephemeral band), and `reconcileReservedVersionDois` is prod-only, so nothing
reverts their status. The one thing that lapses is EZID's **sandbox** shoulder, which purges DOIs
after ~2 weeks — the D1 rows stay published regardless, so re-mint with `remint-dois` only when a
resolvable test DOI actually matters.

Two caveats when working with the clone tool: it reads `AWS_ACCESS_KEY_ID`/`SECRET` from the
**ambient environment** (unlike `e2e-test.ts`, which fetches per-user S3 credentials from the
backend), and local session credentials are short-lived, so export them immediately before each
run; and creation is **not retry-safe** after a partial failure (issue #955) — recover with
`nemar admin delete-dataset <id>` then recreate, not by re-running `create`.

**Known gaps (cross-repo, `nemarDatasets/.github`):** `run-enrichment.yml` hardcodes
`https://api.nemar.org/webhooks/llm-enrich`, so staging enrichment jobs fail against production's
404 (the prod-safety gate working as designed; the CLI's inline reindex is a separate path and does
work). `run-generate-archive.yml` still hardcodes `s3://nemar`, so archive generation must stay off
for staging until it reads `s3_bucket`. See `.context/phase5-cross-repo-owner-deploys.md`.

### Core Components
1. **Authentication System** - User registration, API tokens, admin approval workflow
2. **Dataset Management** - BIDS validation, DataLad integration, upload/download
3. **Backend Integration** - Cloudflare Workers/D1 for user database, API token management
4. **Storage Integration** - GitHub (metadata), S3 (data files), Zenodo (DOI)

### Web-Dashboard Auth (#569)

CLI keeps password + API-token. Dashboard (currently at `nemar.org`, moving to `app.nemar.org` per nemarOrg/website#46) uses passwordless email-code:

- `POST /auth/code/request` — emails a 6-digit code. Per-email rate limit 1/min, 5/hour (counted from `auth_codes.created_at`). In `ENVIRONMENT=development|test` the response includes `dev_code` so tests can finish without an inbox; production must never see this field.
- `POST /auth/code/verify` — Origin-allow-listed, returns `{ user }`, sets `nemar_session` HttpOnly + Secure + SameSite=Lax cookie.
- `POST /auth/logout` / `GET /auth/me` — cookie-bearing.

Cookie domain is env-driven via `WEB_SESSION_COOKIE_DOMAIN` (prod: `app.nemar.org`, dev: host-only). Flip the prod value at the website#46 cutover; no code change.

Web-only signups land as `signup_source='web'`, `status='pending'`, `username`/`github_username`/`password_hash` all NULL until admin onboarding fills them in (migration 0026 dropped those columns' NOT NULL; existing CLI rows backfilled to `signup_source='cli'`).

### User Flow
1. User signs up (username, email, password) -> email verification -> admin approval
2. Admin approves -> system generates API token, S3 credentials, GitHub PAT
3. User uploads dataset -> BIDS validation -> private GitHub repo + S3 upload
4. Admin creates concept DOI -> user can version with new DOIs

### SDSC Hallu Sync
Datasets are synced to SDSC Hallu (`ssh hallu`) for processing pipelines and downloads.

- **Cron:** `0 * * * *` (hourly) via `/data/qumulo/openneuro/nemar-cli/scripts/hallu-sync.sh`
- **Log:** `/data/qumulo/openneuro/.nm-sync-cron.log` (cron output), `/data/qumulo/openneuro/.nm-sync.log` (detailed)
- **Manifest:** `/data/qumulo/openneuro/.nm-sync-manifest.json` (tracks synced versions per dataset)
- **Data dir:** `/data/qumulo/openneuro/{datasetId}/` (cloned repos with annex data)
- **Zip dir:** `/data/qumulo/openneuro/zip_files/` (downloadable archives from S3)
- **Discovery:** Queries `GET /datasets` API, filters for `nm`-prefix only
- **Manual run:** `ssh hallu /data/qumulo/openneuro/nemar-cli/scripts/hallu-sync.sh --dataset nm000132 --verbose`
- **Note:** This syncs data files only. (The legacy `nemar.org/dataexplorer` metadata sync was retired in epic #837.)

## Environment Setup
```bash
# Install dependencies
bun install

# Run CLI in development
bun run src/index.ts

# Build for distribution
bun build src/index.ts --outdir dist --target node
```

## Test Machines
For development and testing, two machines are used with different NEMAR accounts:

| Machine | SSH Alias | NEMAR User | Role |
|---------|-----------|------------|------|
| yahyas-mcm | `ssh mcm` | yahya | Admin |
| yahyas-mba | `ssh mba` | cool-vibers | Regular user |

**Important:** On both machines, `nemar` CLI requires an interactive zsh shell:
```bash
# From mcm, run commands on mba:
ssh mba "zsh -i -c 'nemar sandbox'"

# From mba, run commands on mcm:
ssh mcm "zsh -i -c 'nemar admin users'"
```

## Development Workflow
1. **Check decisions:** Skim `.context/decisions/README.md` for anything binding on the area you are about to change
2. **Check context:** Review .context/plan.md for current tasks
3. **Branch:** `git checkout -b feature/short-description`
4. **Code:** Follow patterns in .rules/javascript.md
5. **Test:** Real tests only with `bun test`
6. **Commit:** Atomic, <50 chars, no emojis, no co-author tags
7. **PR:** Reference context and issue
8. **Record the decision:** if the change settled something an ADR should own, add one (or supersede the ADR it contradicts) in the same PR

### Epic / multi-phase development (REQUIRED)
For any multi-phase feature (an epic with sub-issues, phased delivery, or anything spanning more than one PR), you MUST drive it with the **`/project:epic-dev`** skill (`project:epic-dev`). Do not hand-roll the epic/sprint flow. The skill owns: epic + sub-issue creation and linking (`gh sub-issue`), the epic/phase git-worktree structure, per-phase plan -> implement -> PR -> `/review-pr` -> squash-merge cycle, and the `.claude/epic.local.md` state file that tracks `current_phase`.

- Start a new epic: `/project:epic-dev <description>`
- Advance to the next phase: `/project:epic-dev --next-phase`
- Resume mid-phase: `/project:epic-dev --resume`
- Finalize (epic -> integration branch): `/project:epic-dev --finalize`

Keep the state file current; never let GitHub issues/PRs and `.claude/epic.local.md` drift. Use `/project:epic-status` to inspect state. Phase PRs squash-merge into the epic branch; the epic branch merges into `dev` (the integration branch) at finalize.

## Version Bumping and Release

**Never edit package.json version manually.** The release pipeline is fully
automated by CI; **do NOT manually run `./scripts/bump-version.sh` before a
dev → main PR**. Manual bumps cause tag/version skew with the automation.

### How releases actually flow

`dev` always carries an `X.Y.Z-devN` suffix (e.g., `0.8.9-dev1`). Feature
branches merge into dev without touching the version.

1. **Open a dev → main PR as-is.** Do not bump the version first.
2. **On merge to main**, `.github/workflows/auto-tag.yml` fires:
   - Detects the `-dev*` suffix in `package.json`.
   - Runs `./scripts/bump-version.sh <stripped>` (e.g., `0.8.9`), commits as `nemar-bot`, and pushes the strip commit back to main.
   - Creates tag `vX.Y.Z` on the strip commit.
   - A job-level `if: head_commit.author.email != 'nemar-bot@...'` guard prevents the bot's push from re-triggering the workflow.
3. **`npm-publish.yml` fires on the `v*` tag push** and publishes to npm with `latest` (or pre-release tag for `-rc*`/`-alpha*`/`-beta*`).
4. **`sync-dev.yml` fires on `npm-publish` success** (only for `vX.Y.Z` head_branch), merges main back into dev with `--no-ff`, and runs `./scripts/bump-version.sh dev0` to advance dev to next-patch `-dev0` (e.g., `0.8.10-dev0`).

The pipeline intentionally owns bump-and-tag so the human can't desync
package.json, the tag, and the npm release. `[skip ci]` is deliberately
NOT used in the strip commit message because GitHub's skip marker would
also block the tag-push event from triggering `npm-publish.yml`.

### When manual bumps DO apply

- **Cutting a minor or major release** (e.g., `0.8.9-devN` → `0.9.0`): on dev, run `./scripts/bump-version.sh minor-dev0` (or the equivalent pre-release form — read `scripts/bump-version.sh` for the exact spelling). Commit, push, then open the dev → main PR. The strip step still handles the suffix.
- **Tagging a pre-release on main** (`-rc*`, `-alpha*`, `-beta*`): merge with that suffix in package.json. The auto-tag step skips the strip and tags the literal version with `--prerelease`.
- **Direct main push** that bumps `package.json` to a clean version (no `-dev*`): `auto-tag.yml` tags the literal version. Rare; usually unwanted.

### Bump Commands (reference for when they apply)

```bash
./scripts/bump-version.sh patch     # 0.2.7-dev0 -> 0.2.8
./scripts/bump-version.sh minor     # 0.2.7-dev0 -> 0.3.0
./scripts/bump-version.sh major     # 0.2.7      -> 1.0.0
./scripts/bump-version.sh dev0      # 0.2.7      -> 0.2.8-dev0
./scripts/bump-version.sh dev1      # 0.2.7-dev0 -> 0.2.7-dev1
./scripts/bump-version.sh 1.0.0     # Set exact version
```

### What the Script Does
1. Updates version in package.json
2. Builds the CLI (`bun run build`)
3. Verifies the built CLI reports correct version
4. Commits the change automatically

If build fails, the script restores the original version.

## Core Principles

### Authentication & Security
- API tokens tied to GitHub PAT and S3 credentials per user
- Token revocation must cascade to all linked credentials
- Never store plaintext passwords; use Argon2 or bcrypt
- Email verification required before admin review

### BIDS Validation
- Use bids-validator library for dataset validation
- Validation must pass before upload proceeds
- Support validation configuration files for dataset-specific rules

### DataLad Integration
- Git-annex for large file management
- S3 special remote for data storage
- GitHub for metadata and version control
- Semantic versioning for releases

### DOI Management
- Concept DOI created by admin only
- Version DOIs can be created by users after concept exists
- Zenodo integration for DOI registration
- DOIs are permanent; require explicit confirmation

## Rules Reference
- `.rules/javascript.md` - TypeScript/Bun standards
- `.rules/git.md` - Commit and branching standards
- `.rules/testing.md` - NO MOCK policy
- `.rules/code_review.md` - PR review process
- `.rules/documentation.md` - Documentation standards
- `.rules/ci_cd.md` - GitHub Actions setup

## Context Files
- **`.context/decisions/` - Architecture Decision Records. Read these first.** One file per
  significant decision, with the alternatives that lost and why. `decisions/README.md` is the
  index and the convention (numbering, statuses, when to write one). Where a design doc below
  and an ADR disagree, **the ADR wins** — the docs keep the analysis, the ADR records the verdict.
  Write a new ADR when a decision is expensive to reverse, closes off other reasonable paths, has
  been argued more than once, or encodes a non-obvious constraint. Never delete one; supersede it.
- `.context/plan.md` - Development phases and tasks
- `.context/ideas.md` - Design decisions and alternatives (exploratory; promote settled ones to an ADR)
- `.context/research.md` - Technical investigations
- `.context/validated_workflows.md` - **Tested and proven workflows** (use these!)
- `.context/prototyping_plan.md` - Prototypes to validate assumptions

## Validated Workflows (Use These!)

The following workflows have been **tested through prototyping** and are proven to work. Always reference `.context/validated_workflows.md` before implementing related features.

### Git-Annex Staging → Final (Validated 2026-01-14)
For PR-based data uploads, use git-annex native copy instead of manual S3 operations:
```bash
# Upload to staging during PR
git annex copy --to staging-s3 <files>

# On PR merge, copy to final (handles bookkeeping automatically)
git annex copy --from staging-s3 --to final-s3 <files>

# Cleanup staging after merge
aws s3 rm --recursive s3://nemar/staging/pr-<NUMBER>/
```
**Key insight:** Don't use `aws s3 cp`; use `git annex copy --from --to` for automatic location tracking.

### GitHub Branch Protection (Validated 2026-01-14)
PR-mandatory workflow using GitHub branch protection:
```bash
# Apply protection (requires public repo or GitHub Team)
gh api -X PUT /repos/nemarDatasets/<repo>/branches/main/protection \
  --input - << 'EOF'
{
  "required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": true},
  "enforce_admins": true,
  "required_status_checks": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF

# Enable auto-merge
gh repo edit nemarDatasets/<repo> --enable-auto-merge
```
**Key insight:** `enforce_admins=true` blocks everyone including org owners; self-approval is not allowed.
**Resolved:** nemarDatasets upgraded to GitHub Team via GitHub Education; private repo branch protection validated.

### GitHub Actions S3 Copy (Validated 2026-01-14)
Automatic S3 staging → final copy on PR merge:
```yaml
# .github/workflows/pr-merge.yml
on:
  pull_request:
    types: [closed]  # Not [merged]! Check merged status in job condition
    branches: [main]

jobs:
  copy-data:
    if: github.event.pull_request.merged == true  # Only on actual merge
    # ... copy staging → final, then cleanup

  cleanup-only:
    if: github.event.pull_request.merged == false  # PR closed without merge
    # ... just cleanup staging
```
**Key insight:** Use `pull_request: [closed]` with `if: merged == true/false` condition; GitHub has no `merged` event.

### Git-Annex in GitHub Actions (Validated 2026-01-14)
Install and use git-annex in GitHub Actions for native operations:
```yaml
- name: Install git-annex
  run: sudo apt-get update && sudo apt-get install -y git-annex

- name: Configure git
  run: |
    git config --global user.email "actions@github.com"
    git config --global user.name "GitHub Actions"
```
**Key insights:**
- `signature=v4` required for S3 initremote in us-east-2
- Git config must be set before any commits
- Enables `git annex copy --from --to` in CI

### Full E2E PR Workflow (Validated 2026-01-14)
Critical configuration for DataLad + GitHub + S3:
```bash
# Configure git-annex to annex data files but NEVER metadata (tsv, json, md, etc.)
git annex config --set annex.largefiles '(include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or largerthan=100kb) and exclude=*.tsv and exclude=*.json and exclude=*.md and exclude=*.txt and exclude=*.yml and exclude=*.yaml and exclude=README* and exclude=LICENSE* and exclude=CHANGES* and exclude=.bidsignore and exclude=.gitignore'

# Push git-annex branch so clones can see remotes
git push origin git-annex
```
**Key insights:**
- Workflow files stored in git-annex = GitHub can't read them (symlinks)
- `aws s3 cp` doesn't update git-annex tracking; use `git annex copy --from --to` or register URLs
- Always push `git-annex` branch for clone compatibility

## CLI Commands
```bash
# Authentication
nemar auth login              # Authenticate with API key
nemar auth signup             # Register new account
nemar auth status             # Check authentication status
nemar auth whoami             # Alias for status
nemar auth switch [username]  # Switch between stored accounts
nemar auth logout             # Remove active account (--all for all)
nemar auth resend-verification # Resend email verification
nemar auth setup-ssh          # Configure SSH for GitHub
nemar auth retrieve-key       # Retrieve API key after approval
nemar auth regenerate-key     # Request new API key

# Dataset Management
nemar dataset validate        # Validate BIDS dataset
nemar dataset upload          # Upload dataset to NEMAR
nemar dataset download        # Download a dataset (NEMAR or OpenNeuro)
nemar dataset status          # Check dataset status
nemar dataset list            # List datasets (--mine for own)
nemar dataset search          # Search datasets (semantic matching)
nemar dataset release         # Create version bump PR
nemar dataset update          # Push local changes via PR
nemar dataset request-access  # Request collaborator access
nemar dataset access          # Review collaborator access requests (owner/admin)
nemar dataset invite          # Invite collaborator
nemar dataset collaborators   # List collaborators
nemar dataset publish request # Request publication
nemar dataset publish status  # Check publication status
nemar dataset publish resend  # Resend publication request to admins
nemar dataset clone           # Clone dataset (metadata only)
nemar dataset get             # Download annexed data files
nemar dataset commit          # Stage and commit changes (alias: save)
nemar dataset push            # Push commits and data
nemar dataset drop            # Free local copies of annexed files
nemar dataset ci              # Check BIDS validation CI status
nemar dataset manifest        # View version manifests

# Sandbox (required before uploading)
nemar sandbox                 # Run sandbox training
nemar sandbox status          # Check training status
nemar sandbox reset           # Reset for re-training

# Admin (requires admin privileges)
nemar admin users             # List users
nemar admin approve           # Approve pending user
nemar admin revoke            # Revoke user access
nemar admin role              # Change user role (owner only)
nemar admin notify            # Email a group or a single user
nemar admin s3 regenerate-iam # Regenerate AWS credentials
nemar admin s3 lock           # Apply S3 Object Lock
nemar admin repo public       # Make repo public
nemar admin repo private      # Make repo private
nemar admin ci check          # Check CI workflow status
nemar admin ci add            # Deploy CI workflows
nemar admin ci sync           # Sync deployed CI workflows to current templates
nemar admin ci validate       # Check GitHub Actions can parse deployed CI workflows
nemar admin doi create        # Create concept DOI
nemar admin doi info          # Get DOI info
nemar admin doi update        # Update DOI metadata
nemar admin doi enrich        # Enrich DOI metadata
nemar admin publish list      # List publication requests
nemar admin publish approve   # Approve and publish dataset
nemar admin publish deny      # Deny publication request
nemar admin revert            # Revert dataset to previous version
nemar admin make-public       # Publish dataset (permanent)
nemar admin delete-dataset    # Delete dataset and all resources
nemar admin bulk-delete       # Delete multiple phantom/orphaned datasets (owner only)
nemar admin reindex <id>      # Refresh enrichment + D1 metadata columns
nemar admin reindex --all     # Bulk; also --missing-metadata, --stale [--older-than N]
nemar admin hed-sweep         # Backfill HED detection (has_hed/hed_version); --reset, --verbose
nemar admin data-integrity-sweep # Audit datasets vs. manifest -> data_complete/bytes_present (#970); --reset, --older-than N, --verbose
nemar admin summary           # summary.json coverage across published versions
nemar admin email-preferences show    # Show email notification preferences
nemar admin email-preferences update  # Update email notification preferences
nemar admin e2e-test          # Run end-to-end test against nm099999

# Admin: OpenNeuro import + quarantine recovery (issue #754; retry engine + blocklist: epic #967 Phase 2, #969)
nemar admin import-openneuro <ids>    # Import OpenNeuro dataset(s) into NEMAR
nemar admin import status [id]        # Show import job state (failed/quarantined first; -s to filter, -b for blocklisted only)
nemar admin import rollback <id>      # Roll back a failed/quarantined import (deletes repo + S3 + D1)
nemar admin import retry <id>         # Reset a failed/quarantined/incomplete import to 'preparing' for re-dispatch (also un-blocklists)
nemar admin import verify <id>        # Force a per-key S3 integrity check now; seeds the retry lane or confirms health

# Admin: recover 0-byte OpenNeuro imports (epic #967 Phase 5, #972)
nemar admin recover [ids...]          # Re-copy imports whose upstream is accessible; dry-run by default, --execute to verify+dispatch
nemar admin recover status [ids...]   # Report data_complete/bytes_present progress for recover targets

# Admin: governance fleet (epic #713)
nemar admin fleet drift               # Report repos off the governance spec
nemar admin fleet enforce [id]        # Bring repos to spec (single or --all; dry-run by default)
nemar admin fleet revalidate [id]     # Re-run BIDS validation on main HEAD, then optionally enforce

# Admin: system notices
nemar admin notice set        # Create a system notice shown to CLI users
nemar admin notice list       # List all notices (including expired)
nemar admin notice clear <id> # Delete a notice by ID

# Root-level shortcuts
nemar doctor                  # Check required tools (git, git-annex, gh, aws, deno)
nemar login                   # Alias for auth login
nemar logout                  # Alias for auth logout
nemar signup                  # Alias for auth signup
nemar register                # Alias for auth signup
nemar whoami                  # Alias for auth status
nemar switch                  # Alias for auth switch
```

## External Resources
- OpenNeuro CLI: https://github.com/OpenNeuroOrg/openneuro
- BIDS Validator: https://github.com/bids-standard/bids-validator
- DataLad: https://www.datalad.org/
- Existing tools: ~/Documents/git/EMG-2-BIDS/tools/

---
Remember: Build maintainable systems. Check .rules/ for detailed guidance.
