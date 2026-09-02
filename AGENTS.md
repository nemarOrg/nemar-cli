# NEMAR CLI — Development Instructions

> Tool-agnostic project instructions for any coding agent (Codex, Cursor, Copilot, Windsurf,
> Claude Code, ...). Claude Code reads this via `@AGENTS.md` in `CLAUDE.md`.

**This file is a map, not a manual.** It names every part of the system in a line or two
and points at the document that expands it. Read the hard rules below in full;
follow a pointer when you are about to touch that area.

| If you need | Go to |
|---|---|
| Why something is built the way it is | [`.context/decisions/`](.context/decisions/README.md) — the ADRs |
| Hosts, paths, crons, deploy procedures | [`.context/systems-inventory.md`](.context/systems-inventory.md) |
| A proven recipe (git-annex, staging, branch protection) | [`.context/validated_workflows.md`](.context/validated_workflows.md) |
| Everything else under `.context/` | [`.context/README.md`](.context/README.md) — annotated map |
| What a CLI command does | `nemar <group> --help` (authoritative) or `docs.nemar.org` |

---

## START HERE: Architecture Decision Records

**[`.context/decisions/`](.context/decisions/README.md) records what was decided and why.**
Read the index before designing anything,
and before "fixing" something that looks wrong —
several of the oddities in this codebase are deliberate, and the ADR says which.

- **Where an ADR and any other doc disagree, the ADR wins.**
  Design docs under `.context/` keep the analysis; the ADR is the verdict.
- **Never delete an ADR. Supersede it** (see ADR 0019 for what a superseded one looks like).
- **Write a new one** when a decision is expensive to reverse, closes off other reasonable paths,
  has been argued more than once, or encodes a constraint that is not obvious from the code.
  Copy `0000-template.md`, number sequentially, and add it to the index in `README.md` —
  a test enforces that the index and the files on disk agree.

Load-bearing ones to know before touching the relevant area:
0005 (partial data still serves), 0009 (dev D1 is not a prod mirror),
0010 (never client-stream an import), 0012 (archive size policy),
0016 (never hand-bump versions), 0020 (workflow edits hit ~785 repos at once),
0023 (`--clean` reconciles, it does not wipe), 0027 (Zarr discovery is raw-only),
0028 (MaxShield MEG is filtered or declined),
0029 (the Zarr conversion engine lives here, not in the Actions repo),
0030 (bounded streaming is the default; `.set` is the exception),
0031 (one annex policy module; `_motion.tsv` is data despite the extension),
0032 (facet filters are declared once and report what they exclude),
0033 (the queue stamps which engine converted each dataset; pre-stamp rows are declared current),
0034 (`datasets` stays one table under an enforced column budget; derive, don't store).

---

## Hard rules

### Live datasets

**`nm000103`-`nm000107` are LIVE.** Do NOT modify their visibility, S3 data, DOIs,
or repo settings during development or testing.
They are kept private during dev for maximum control but contain real data.

For end-to-end testing use `nm099999`, created on demand via
`POST /admin/datasets/nm099999/reset` (lazily created if missing):

```bash
nemar admin e2e-test --verbose      # reset, upload, clone, download, update cycle
nemar admin e2e-test --skip-reset   # reuse existing nm099999 state
```

The 10-step pipeline lives in `src/lib/e2e-test.ts` and sources
`test/fixtures/bids-minimal/`. `xx`-prefix datasets are blocked from publishing.

### Dev D1 shares production users and the GitHub org

`nemar-db-dev` no longer mirrors production's dataset catalog — it was purged to the curated
fixtures only (the seven `xx0999NN` exemplars plus the private E2E dataset `nm099999`)
and must stay that way. **Do not re-seed production `nm`/`ds` rows into dev D1.**

But the `users` table was **not** purged: it still holds roughly 609 real email addresses,
and the dev worker holds a live `RESEND_API_KEY`.
The `nemarDatasets` GitHub org is also **shared** between prod and dev, since the org name is
hardcoded rather than environment-scoped.
So a dev-side job that selects users by a generic predicate can still email real people,
and a cascade delete can still destroy a real repo.
The catalog purge removed one blast-radius vector; it did not remove the reason these fences exist.

**A new daily cron job is production-only BY DEFAULT.** The dev cron is governed by a fail-safe
allowlist in `scheduled()`. Before adding a job to the non-prod set, confirm it cannot email a
real user, dispatch GitHub work against `nemarDatasets`, or mutate a real DOI or prod-bucket object.

Authentication against staging never uses production keys: use `TEST_ADMIN_API_KEY` from
`test/.env.test` — it matches the `test-admin` token seeded by `scripts/seed-dev-db.sql` —
with an isolated `NEMAR_CONFIG_DIR`, so the real `~/.config/nemar` is untouched.

### Never hand-bump the version

`package.json` version is owned by CI. Do not edit it, and do **not** run
`./scripts/bump-version.sh` before a dev → main PR — a manual bump desyncs the tag,
the version, and the npm release. See ADR 0016 and the release section below.

### Work in a worktree

Do not edit the primary checkout directly; concurrent sessions share it.
Branch into a worktree first: `git worktree add <path> -b <branch> origin/dev`.

### Dataset ID bands

All inside the 0-99999 cap, so `xx900001` is invalid.

| Band | Range | Purpose | Cleanup |
|---|---|---|---|
| Prod sandbox | `xx000001`-`xx089999` | real user sandbox training | 14-day cron (prod) |
| Dev ephemeral | `xx090001`-`xx099899` | throwaway dev/e2e | dev cron |
| Dev exemplar fleet | `xx099900`-`xx099999` | curated persistent copies | **never** (`is_exemplar=1`) |

**The exemplar fleet is permanent, not ephemeral.** Seven curated `xx0999NN` copies of real public
datasets (`scripts/exemplar-fleet.json`) cover eeg / ieeg / emg / meg / multi-modal / HED,
published with **sandbox** EZID DOIs (`10.5072/FK2`, never the production `10.82901` shoulder).
Their `active`/`public` state lives in D1 and is the source of truth for the staging catalog;
it does not depend on the registrar.
The only thing that lapses is EZID's sandbox shoulder, which purges DOIs after about two weeks,
so re-mint with `nemar admin exemplar remint-dois` only when a resolvable test DOI actually matters.

Two caveats with the clone tool: it reads `AWS_ACCESS_KEY_ID`/`SECRET` from the **ambient
environment** (unlike `e2e-test.ts`, which fetches per-user S3 credentials from the backend),
and session credentials are short-lived, so export them immediately before each run.
Creation is also **not retry-safe** after a partial failure (issue #955):
recover with `nemar admin delete-dataset <id>` then recreate, rather than re-running `create`.

---

## Project overview

**Purpose:** command-line interface for NEMAR (Neuroelectromagnetic Data Archive and Tools
Resource) dataset management.
**Stack:** TypeScript, Bun, Commander.js, DataLad, Cloudflare Workers + D1.
**Repository:** https://github.com/nemarOrg/nemar-cli

Tooling is fixed: **Bun** for JavaScript and TypeScript (never npm or npx),
**Biome** for lint and format (never ESLint or Prettier),
**uv** for anything Python (never pip or conda).

### The parts

| Part | What it is | Expanded in |
|---|---|---|
| CLI (`src/`) | auth, dataset lifecycle, sandbox, admin commands | `nemar --help` |
| Backend (`backend/`) | Cloudflare Worker + D1; the API at `api.nemar.org` | [systems inventory](.context/systems-inventory.md) §1 |
| Website | `nemar.org`, Astro SSR, in `nemarOrg/website` | [systems inventory](.context/systems-inventory.md) §1 |
| Docs site | `docs.nemar.org`, in `nemarOrg/docs` | — |
| Central workflows | `nemarDatasets/.github` — dataset CI, archive, manifest | [systems inventory](.context/systems-inventory.md) §2 |
| Zarr converter | `scripts/zarr/` **in this repo**; runs on the Hallu cron, not Actions (ADR 0029) | [systems inventory](.context/systems-inventory.md) §3 |
| Signal readers | `neuromechanist/biosigio` on PyPI — importers plus the Zarr exporter | [systems inventory](.context/systems-inventory.md) §2 |
| Processing host | SDSC Hallu — dataset sync, QA sync, Zarr conversion | [systems inventory](.context/systems-inventory.md) §3 |
| Test machines | `ssh mcm` (admin), `ssh mba` (regular user) | [systems inventory](.context/systems-inventory.md) §4 |
| Backup / DR | `nemarOrg/nemar-db-backup`, hourly D1 snapshots | [systems inventory](.context/systems-inventory.md) §5 |

**Two GitHub orgs, and the split is deliberate.** `nemarOrg` holds tooling and infrastructure;
`nemarDatasets` holds dataset repos only.
`ORG_NAME = "nemarDatasets"` in `backend/src/services/github.ts` and the publishing scripts
target `nemarDatasets` because that is where dataset repos live. Do not change these to `nemarOrg`.

**The website cutover is done: `nemar.org` IS the dataset browser.** Dataset pages live at
`nemar.org/dataset/<id>`, versions at `?v=v<version>`, and that is the canonical DOI landing
target (`datasetLandingUrl` in `shared/datacite-constants.ts`).
`ww2.nemar.org` is a legacy alias for the same site, not a deployment target.
The legacy PHP `nemar.org/dataexplorer` site is gone and its URLs 301 to `nemar.org/dataset/<id>`.
Epic #837 had already severed the data coupling before the hostname handover:
the outgoing datapipeline push and the incoming 4-hour catalog pull were removed,
our `nm`/`on` records were purged from its `dataexplorer_*` tables,
and the legacy `ds######` shadow rows were dropped from our D1.
"The website", "the browser", or "the UI" unqualified means `nemar.org`;
a comment contrasting ww2 with nemar.org, or calling nemar.org legacy, predates the cutover
and is wrong.

### S3 layout

```
s3://nemar/{datasetId}/
    objects/     # git-annex content-addressed blobs
    version/     # version manifests (v1.0.0.json)
    archives/    # downloadable zip snapshots (v1.0.0.zip)
    qa/          # pipeline QA artifacts, mirrored from Hallu
s3://nemar/staging/pr-{n}/{datasetId}/objects/   # PR staging area
```

### User flow

1. Sign up (username, email, password) → email verification → admin approval
2. Admin approves → system generates API token, S3 credentials, GitHub PAT
3. User uploads → BIDS validation → private GitHub repo + S3 upload
4. Admin creates concept DOI → user can version with new DOIs

### Web dashboard auth (#569)

The CLI keeps password plus API token. The dashboard uses passwordless email codes:
`POST /auth/code/request` (rate limited 1/min, 5/hour; returns `dev_code` only when
`ENVIRONMENT=development|test`, never in production), `POST /auth/code/verify`
(Origin-allow-listed, sets the `nemar_session` HttpOnly cookie), plus `/auth/logout`,
`/auth/me`, and the settings endpoints from epic #1019 —
`PATCH /auth/profile` (#912), `POST /auth/email/change/{request,verify}`
(#911; codes go to the NEW address, bound to the requesting session via
`auth_codes.user_id`, migration 0066), and ORCID re-link via
`POST /auth/orcid/start?mode=relink` (#913, **ADR 0022** — relink intent is
never minted on a GET).
The cookie domain is env-driven via `WEB_SESSION_COOKIE_DOMAIN`, so the website#46 cutover
is a config flip rather than a code change.
Web-only signups land as `signup_source='web'`, `status='pending'`,
with `username`/`github_username`/`password_hash` NULL until admin onboarding fills them in.
Endpoints are defined in `backend/src/routes/auth-web.ts` (with `auth.ts` for the CLI path
and `auth-orcid.ts` for ORCID); read those rather than trusting this summary.

### Dataset deletion

`DELETE /admin/datasets/:id` or `nemar admin delete-dataset <id>`.
Deletion cascades through the GitHub repo, S3 objects, and D1
(`dataset_versions`, `publication_requests`, `datasets`;
`dataset_collaborators` follows via foreign key).

- Unpublished (no DOI, private): admin or owner may delete.
- Published (has a DOI or is public): owner only, and requires `force=true`.

Scheduled cleanup runs daily in production only: sandbox (`xx`) datasets after 14 days,
and stale `nm` datasets that are private, DOI-less, without active publication requests,
and inactive for 90 days.
**`last_activity_at` must be updated by any endpoint that mutates a dataset**
(uploads, version creation, publication requests), or cleanup will consider it stale early.
See migration 0011.

---

## Environment setup

```bash
bun install                                      # dependencies
bun run src/index.ts                             # run the CLI from source
bun test                                         # real tests only, no mocks
bun build src/index.ts --outdir dist --target node
```

---

## Development workflow

1. **Check decisions** — skim `.context/decisions/README.md` for anything binding on the area
2. **Check context** — `.context/plan.md` for current tasks
3. **Branch into a worktree** — `git worktree add <path> -b feature/short-description origin/dev`
4. **Code** — follow `.rules/javascript.md`
5. **Test** — real tests with `bun test`
6. **Commit** — atomic, under 50 characters, no emojis, no co-author tags
7. **PR** — reference the context and the issue
8. **Record the decision** — if the change settled something an ADR should own,
   add one (or supersede the ADR it contradicts) in the same PR

### Epic / multi-phase development (REQUIRED)

For any multi-phase feature — an epic with sub-issues, phased delivery,
or anything spanning more than one PR — drive it with the **`/project:epic-dev`** skill.
Do not hand-roll the epic or sprint flow.
The skill owns epic and sub-issue creation and linking (`gh sub-issue`),
the epic/phase worktree structure, the per-phase plan → implement → PR → `/review-pr` →
squash-merge cycle, and the `.claude/epic.local.md` state file that tracks `current_phase`.

```
/project:epic-dev <description>     # start
/project:epic-dev --next-phase      # advance
/project:epic-dev --resume          # resume mid-phase
/project:epic-dev --finalize        # epic branch -> dev
/project:epic-status                # inspect state
```

Never let GitHub issues/PRs and `.claude/epic.local.md` drift.
Phase PRs squash-merge into the epic branch; the epic branch merges into `dev`.

---

## Release pipeline

**CI owns bump-and-tag so a human cannot desync `package.json`, the tag, and the npm release.**
`dev` always carries an `X.Y.Z-devN` suffix; feature branches merge into `dev`
without touching the version.

1. Open the dev → main PR **as-is**, with the `-devN` suffix intact.
2. On merge to main, `auto-tag.yml` strips the suffix via `bump-version.sh`,
   commits as `nemar-bot`, pushes back to main, and tags `vX.Y.Z`.
   A job-level author guard stops the bot's push from re-triggering the workflow.
3. `npm-publish.yml` fires on the `v*` tag and publishes to npm.
4. `sync-dev.yml` fires on publish success, merges main back into dev with `--no-ff`,
   and advances dev to the next patch `-dev0`.

`[skip ci]` is deliberately absent from the strip commit,
because GitHub's skip marker would also block the tag-push event that `npm-publish.yml` needs.

**When a manual bump does apply:** cutting a minor or major release
(`./scripts/bump-version.sh minor-dev0` on dev, then open the PR),
or tagging an explicit pre-release (`-rc*`, `-alpha*`, `-beta*`),
where auto-tag skips the strip and tags the literal version.
Read `scripts/bump-version.sh` for the exact spellings.
Environments and pre-release checks: [`.context/release-safety-playbook.md`](.context/release-safety-playbook.md).

---

## Core principles

- **Auth and security.** API tokens are tied to a GitHub PAT and per-user S3 credentials;
  revocation must cascade to all linked credentials.
  Never store plaintext passwords (Argon2 or bcrypt).
  Email verification precedes admin review.
- **BIDS validation.** Use the bids-validator library, support per-dataset validation config,
  and require a pass before upload proceeds.
- **DataLad.** git-annex for large files, S3 special remote for content,
  GitHub for metadata and history, semantic versioning for releases.
- **DOIs.** Concept DOI is admin-only; version DOIs are user-creatable once a concept exists.
  EZID is the registrar (ADR 0007 — not Zenodo, whatever `.context/research.md` says).
  DOIs are permanent and require explicit confirmation.
- **Zarr.** A derived, latest-only serving copy, not a source of truth.
  The converter is `scripts/zarr/` **in this repo** and runs on the SDSC Hallu
  cron (`scripts/zarr/hallu-zarr.sh`, hourly at `:30`), never in GitHub Actions —
  Actions cannot finish a large dataset inside the 120-minute cap (ADR 0029).
  **Both halves deploy themselves now**, driver and shell script alike:
  `setup()` resets the Hallu clone to the tracked ref every run, and since #1109
  moved `hallu-zarr.sh` into the checkout, cron invokes the clone's copy
  (`/mnt/local/zarr-state/nemar-cli/scripts/zarr/hallu-zarr.sh`), so that reset
  updates the script too. Hand-placement with `scp` + atomic `mv` is now only for
  bootstrapping a node that has no clone yet — the script has to exist before the
  clone does. The `DRIFT:` warning covers that shape: it fires when the running
  copy is NOT the clone's copy and the two differ, and is a no-op in the normal
  deployment where they are the same file. A stale out-of-clone copy left at the
  old path is inert, not a fallback. Manual recovery for one dataset is
  `hallu-zarr.sh --dataset <id>`.
  A second, independently-stated `--test` instance (own state dir, own AWS
  profile, `api-test.nemar.org`/`nemar-dev`) converts into `zarr-test.nemar.org`
  without touching any of this — see [systems inventory](.context/systems-inventory.md) §3.4.
  "Every run" is load-bearing and used to be a lie during a backfill: a run holds
  the lock until the queue empties, so `setup()` never re-ran and the node sat two
  deploys behind for two days (#1129). The drain now re-checks `origin/$DRIVER_REF`
  between datasets and stops when it moves, so the next tick redeploys.
  Conversion streams by default above 256 MiB, so peak RAM is a read window
  plus one channel rather than the whole recording (ADR 0030). EEGLAB `.set`
  is the one format that cannot: MNE refuses v7.3 files that biosigIO reads,
  and an embedded classic `.set` loads fully even with `preload=False`.
  Discovery and dispatch are raw-only (ADR 0027):
  nothing under `derivatives/`, `sourcedata/`, or `code/` becomes a *new* store.
  Stores published under those trees before that landed are a separate,
  explicitly authorized purge — some are still served until it completes,
  so do not read the rule as a description of what is currently in the bucket.
  A `--clean` rebuild reconciles rather than wiping first (ADR 0023).
  **A widening of discovery reaches the back catalog only through the engine
  stamp** (ADR 0033): `reconcile` re-queues on a version change, and an engine
  upgrade bumps no version, so `zarr_queue.py`'s `ZARR_ENGINE_VERSION` is what
  makes already-converted datasets re-convert. Bump it when discovery widens —
  never when it narrows — and read `migrate_schema`'s note before touching how a
  NULL stamp is interpreted.
  **Bumping it is a two-step procedure, because merging a bump deploys it**
  (`setup()` resets the clone every run, so the next hourly tick would run it):
  preview with `hallu-zarr.sh --preview-engine-bump`, then arm exactly one run
  with `touch $STATE_DIR/.zarr-engine-bump-ack` (the script consumes the file).
  Until then a bump over `--engine-requeue-limit` (25) re-queues **nothing** and
  every reconcile logs `ENGINE BUMP PENDING ACK`; new datasets keep converting
  normally throughout. The cohort stranded before the stamp existed
  (directory-format datasets converted before 2026-08-22, #1172) is recovered by
  `hallu-zarr.sh --backfill-dir-formats`, dry-run by default.

---

## Rules and context

`.rules/` holds the detailed standards: [`javascript.md`](.rules/javascript.md),
[`git.md`](.rules/git.md), [`testing.md`](.rules/testing.md) (**NO MOCK policy**),
[`code_review.md`](.rules/code_review.md), [`documentation.md`](.rules/documentation.md),
[`ci_cd.md`](.rules/ci_cd.md).

`.context/` holds decisions, runbooks, and research —
start from [`.context/README.md`](.context/README.md), which marks what is current
and what is historical. The entries worth knowing by name:
[`decisions/`](.context/decisions/README.md) (binding),
[`systems-inventory.md`](.context/systems-inventory.md) (hosts and deploys),
[`validated_workflows.md`](.context/validated_workflows.md) (proven recipes, with the gotchas),
[`plan.md`](.context/plan.md), [`ideas.md`](.context/ideas.md), [`research.md`](.context/research.md).

---

## CLI commands

`nemar --help` and `nemar <group> --help` are authoritative; this is only the shape.

| Group | Covers |
|---|---|
| `nemar auth` | login, signup, status/whoami, switch, logout, verification, SSH setup, key retrieval and regeneration |
| `nemar dataset` | validate, upload, download, status, list, search, release, update, clone, get, commit, push, drop, ci, manifest |
| `nemar dataset publish` | request, status, resend |
| `nemar dataset` (access) | request-access, access, invite, collaborators |
| `nemar sandbox` | training run, status, reset — required before uploading |
| `nemar admin` | users, approve, revoke, role, notify, s3, repo, ci, doi, publish, revert, make-public, delete-dataset, bulk-delete, reindex, hed-sweep, data-integrity-sweep, doctor, summary, notice, email-preferences, e2e-test |
| `nemar admin import*` | OpenNeuro import, status, rollback, retry, verify, recover (issue #754, epic #967) |
| `nemar admin fleet` | drift, enforce, revalidate — governance across dataset repos (epic #713) |
| `nemar admin exemplar` | create, status, remint-dois — the staging exemplar fleet |
| root shortcuts | `nemar doctor`, `login`, `logout`, `signup`, `register`, `whoami`, `switch` |

`nemar doctor` checks the required external tools: git, git-annex, gh, aws, deno.

---

## External resources

- OpenNeuro CLI: https://github.com/OpenNeuroOrg/openneuro
- BIDS Validator: https://github.com/bids-standard/bids-validator
- DataLad: https://www.datalad.org/
- biosigIO: https://github.com/neuromechanist/biosigio

---

Remember: build maintainable systems. Check `.rules/` for detailed guidance,
and `.context/decisions/` before deciding anything twice.
