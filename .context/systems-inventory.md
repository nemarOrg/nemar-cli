# Systems inventory — where NEMAR runs, and how to deploy to it

Current reference. Verified against the live hosts on 2026-08-20.

`AGENTS.md` carries a one-screen version of this table; this document is the expansion.
Where a path or cron schedule matters, trust this file over prose elsewhere,
and re-verify on the host before acting on anything load-bearing.

---

## 1. Cloud services

| Service | Production | Staging | Notes |
|---|---|---|---|
| API worker | `api.nemar.org` | `api-test.nemar.org` | Cloudflare Workers. Same codebase, `--env dev` for staging. |
| Data plane | `data.nemar.org` | `data-test.nemar.org` | Serves dataset bytes and QA artifacts out of S3. |
| Zarr plane | `zarr.nemar.org` | `zarr-test.nemar.org` | Serves the Zarr serving copy. |
| Website | `nemar.org` (`nemar-website` Pages) | `test.nemar.org` (`nemar-website-test` Pages) | Astro SSR, lives in `nemarOrg/website`. Staging deploys from that repo's `staging` branch. |
| Database | `nemar-db` (D1) | `nemar-db-dev` (D1) | SQLite. Hourly backup of prod only, to `nemarOrg/nemar-db-backup`. |
| Object storage | `s3://nemar` | `s3://nemar-dev` | us-east-2. |
| Search index | Vectorize | — | Rebuildable with `nemar admin reindex`. Not backed up. |
| DOI registrar | EZID, `10.82901` shoulder | EZID sandbox, `10.5072/FK2` | Staging DOIs purge after ~2 weeks by design. |

**One Cloudflare account: SCCN.** The personal/`neuromechanist` account was retired 2026-05-18.
Every operation goes through `npx cfman wrangler --account sccn`,
and `backend/wrangler-sccn.toml` is the only active config.

Worker fallback hostname: `nemar-api.sccn-org.workers.dev` reaches the same production worker.
`api.osc.earth/nemar` is retired and is not a deployment target.

**Deploy the worker:**

```bash
# production
npx cfman wrangler --account sccn -- deploy -c backend/wrangler-sccn.toml
# staging (also provisions custom domains and registers the dev cron)
npx cfman wrangler --account sccn -- deploy --env dev -c backend/wrangler-sccn.toml
```

`wrangler pages deploy` rejects `-c <path>`,
so a Pages config has to be moved into place as `wrangler.toml` before deploying.

### Worker cron jobs

| Schedule | Environment | Job |
|---|---|---|
| `0 3 * * *` | production only | `scheduledCleanup` — sandbox expiry, stale-dataset email, import recovery |
| `0 3 * * *` | production only | `archiveRetrySweep`, `reconcileReservedVersionDois` |
| `0 3 * * *` | prod + staging | blocked-publication sweep (scoped to `xx09%` off-prod) |
| `0 4 * * *` | staging | the dev trigger, governed by the allowlist in `scheduled()` |

**A new daily job is production-only by default.** See the danger note in `AGENTS.md`
before adding one to the non-prod set.

---

## 2. GitHub

| Org | Holds | Notes |
|---|---|---|
| `nemarOrg` | tooling and infra: `nemar-cli`, `nemar-tools`, `nemar-metadata`, `neuroschema`, `website`, `docs`, `nemar-db-backup` (private) | |
| `nemarDatasets` | dataset repos only (`nm000103`, `on004942`, `xx0999NN`, ...) plus `.github`, the central-workflow repo | **Shared between production and staging.** The org name is hardcoded, not environment-scoped. |

`nemarDatasets/.github` is where the reusable dataset workflows live.
The Zarr converter used to live there too; it moved to `scripts/zarr/` in this repo
because it runs on the Hallu cron, not in Actions (ADR 0029).
It is a separate repository from `nemar-cli` with its own PR cycle,
and a change there reaches roughly 785 dataset repos at once — see ADR 0020.

Third-party: `neuromechanist/biosigio` provides the signal readers and the Zarr exporter
the converter depends on. It publishes to PyPI and has no auto-tag workflow:
a tag push alone only reaches TestPyPI and reports green.
Publishing to PyPI requires cutting a GitHub Release.

---

## 3. SDSC Hallu (`ssh hallu`)

The processing host. It runs three NEMAR cron jobs, all as user `yahya`.
A fourth cron on this host (`hallu_cron_pipeline.sh`, 3 AM) belongs to the unrelated
`dataset_citations` project and is not part of NEMAR.

| Schedule | Script | Cron log |
|---|---|---|
| `0 * * * *` | `~/.local/share/nemar-cli/scripts/hallu-sync.sh` | `/data/qumulo/openneuro/.nm-sync-cron.log` |
| `15 * * * *` | `~/.local/share/nemar-cli/scripts/hallu-qa-sync.sh` | `/data/qumulo/openneuro/.nm-qa-sync-cron.log` |
| `30 * * * *` | `/mnt/local/zarr-state/nemar-cli/scripts/zarr/hallu-zarr.sh` (with `ZARR_JOBS=24`) | `/mnt/local/zarr-state/.nm-zarr-cron.log` |

**There are two `nemar-cli` clones on this host, and only one of them is live.**
Cron runs the scripts out of `/home/yahya/.local/share/nemar-cli`.
A second, much older clone sits at `/data/qumulo/openneuro/nemar-cli`
and is *not* what cron executes; as of 2026-08-20 the two were 300 commits apart.
Earlier documentation named the stale path. Check `crontab -l` rather than assuming.

### 3.1 Dataset sync (`hallu-sync.sh`)

Clones dataset repos with their annex content so pipelines can read them,
and mirrors the downloadable archives.
Data files only; the legacy `nemar.org/dataexplorer` metadata sync was retired in epic #837.

- Data: `/data/qumulo/openneuro/{datasetId}/`
- Archives: `/data/qumulo/openneuro/zip_files/`
- Manifest (synced version per dataset): `/data/qumulo/openneuro/.nm-sync-manifest.json`
- Detailed log: `/data/qumulo/openneuro/.nm-sync.log`
- Discovery: `GET /datasets`, filtered to the `nm` prefix

```bash
ssh hallu ~/.local/share/nemar-cli/scripts/hallu-sync.sh --dataset nm000132 --verbose
```

### 3.2 QA artifact sync (`hallu-qa-sync.sh`)

Mirrors pipeline QA output from `/data/qumulo/openneuro/processed/<id>/`
into `s3://nemar/<id>/qa/`, so the `data.nemar.org` worker can serve it.
Covers `dataqual.json`, histogram figures, and per-file QA.

### 3.3 Zarr conversion (`hallu-zarr.sh`)

**This is the production Zarr conversion engine, and now the only one.** The Actions
path (`run-generate-zarr.yml`, `triggerZarrGeneration`, `ZARR_AUTODISPATCH`) was
retired in #1109; it had been off by default and could not finish a large dataset
inside the 120-minute cap. The converter source is `scripts/zarr/` in this repo.
The cron is what builds every store, and it passes `--clean` unconditionally,
which means every recording in a dataset it visits is reconverted rather than diffed.
**`--clean` does not wipe the prefix first** — it reconciles, removing only the stores
the run did not produce, so a recording that fails to convert keeps its previous copy.
See ADR 0023; the flag does not mean what its name suggests.

All conversion state lives on local NVMe (`/mnt/local`, 954 G), never on NFS,
because SQLite locking over NFS is fragile.

| Path | What it is |
|---|---|
| `/mnt/local/zarr-state/zarr-queue.db` | the work queue (SQLite) |
| `/mnt/local/zarr-state/nemar-cli/` | clone of `nemarOrg/nemar-cli`; supplies both the Python driver AND (since #1109) `hallu-zarr.sh` itself — `git reset --hard` is the deploy path for both, see below |
| `/mnt/local/zarr-state/.zarr-venv/` | the Python environment biosigio installs into |
| `/mnt/local/zarr-state/.nm-zarr.lock` | single-instance lock |
| `/mnt/local/zarr-state/.nm-zarr.log` | detailed per-recording log (tens of MB; `grep -a`) |
| `/mnt/local/zarr-state/.nm-zarr-cron.log` | one line per dataset start/finish |
| `/mnt/local/zarr-scratch/` | per-dataset scratch, swept on each run |
| `/mnt/local/zarr-state/.zarr-secrets.env` | credentials, mode 600 |

Everything except the secrets is rebuildable, so the whole state directory is disposable.

**Queue state:**

```bash
ssh hallu '/mnt/local/zarr-state/.zarr-venv/bin/python \
  /mnt/local/zarr-state/nemar-cli/scripts/zarr/zarr_queue.py \
  --db /mnt/local/zarr-state/zarr-queue.db stats'
```

#### Deploying a converter change

**Both halves deploy themselves in the normal case, driver and shell script alike.**
This section used to describe a two-halves, hand-placed-script reality
that predated #1109 (which moved `hallu-zarr.sh` into the checkout);
AGENTS.md's Zarr paragraph already carries the corrected description,
and the ground truth below was re-verified against the live crontab, 2026-09-02.

`setup()` runs `git fetch && git reset --hard origin/$ZARR_DRIVER_REF` (default `main`)
on the `nemar-cli` clone every run,
then installs from that clone's `scripts/zarr/requirements.txt`
with `--refresh-package biosigio --upgrade-package biosigio`
so a version bump takes effect rather than resolving against a stale index cache.
Since #1109 moved `hallu-zarr.sh` into the checkout,
cron invokes the CLONE's own copy of the script, not a separately-maintained one.
The live crontab confirms it:

```
30 * * * * mkdir -p /mnt/local/zarr-state && ZARR_JOBS=24 ZARR_DRIVER_REF=main \
  /mnt/local/zarr-state/nemar-cli/scripts/zarr/hallu-zarr.sh \
  >> /mnt/local/zarr-state/.nm-zarr-cron.log 2>&1
```

So the same `git reset --hard` that redeploys the Python driver
also redeploys `hallu-zarr.sh` itself, on the very next hourly tick.

**Hand-placement with `scp` + an atomic rename is now only for bootstrapping a node
that has no clone yet** — the script has to exist before the clone does.
The script compares itself against the clone's own copy each run
and logs `DRIFT:` when they differ;
in the normal (post-#1109) deployment the two paths are the same file,
so this comparison is a no-op.
A stale out-of-clone copy left at an old bootstrap path is inert, not a fallback
(ADR 0029 carries a 2026-09-02 amendment noting exactly this).

Bootstrap recipe, for a node with no clone at all:

```bash
ssh hallu 'mkdir -p /mnt/local/zarr-state'
scp scripts/zarr/hallu-zarr.sh hallu:/mnt/local/zarr-state/hallu-zarr.sh
ssh hallu 'chmod +x /mnt/local/zarr-state/hallu-zarr.sh
           ZARR_DRIVER_REF=main /mnt/local/zarr-state/hallu-zarr.sh --stats'
```

(`--stats` here only to avoid triggering a real reconcile/drain during the recipe walkthrough;
drop it to let `setup()` clone the driver and start the queue for real.)
`setup()` then clones `ZARR_DRIVER_REF` into `/mnt/local/zarr-state/nemar-cli/`,
and every run after that invokes the clone's own copy going forward.

#### The self-deploy is once per process, not once per hour

`setup()` runs at process start, and the drain loop then holds `.nm-zarr.lock`
until the queue is empty. Every hourly cron that fires meanwhile exits on the lock.
So a long drain pins both the driver *and* the biosigio version
to whatever `origin/main` was when that process started.

Verified on 2026-08-20: an instance launched 2026-08-12 04:30 was still running
after 8 days 19 hours, converting on the `#90` driver with biosigio 1.2.2,
while `origin/main` had advanced to `#101` and biosigio to 1.2.4.
Six merged pull requests were live in git and dead in production.

**Merging a converter change is therefore not deploying it.**
Confirm what the running process actually loaded:

```bash
ssh hallu 'ps -eo pid,lstart,etime,cmd | grep -E "hallu-zarr|generate_zarr" | grep -v grep
           git -C /mnt/local/zarr-state/nemar-cli log --oneline -1
           /mnt/local/zarr-state/.zarr-venv/bin/python -c "import biosigio; print(biosigio.__version__)"'
```

If the clone or the version is behind, the current run has to end before the change goes live.
Ending it is safe by design and loses only the in-flight dataset:
the queue is persistent, `reconcile` recovers a stale `inprogress`,
and the next run sweeps orphaned scratch.
Datasets already marked `done` are not reprocessed.

### 3.4 Zarr conversion test instance (`zarr-test.nemar.org`, nemarOrg/nemar-cli#1180, epic #1181 phase 3)

A second, independently-stated invocation of the same `hallu-zarr.sh` — not a fork, not a
separate script — run with `--test`.
It converts real BIDS recordings from `nemar-db-dev`'s catalog into `s3://nemar-dev/<id>/zarr/`,
which `zarr-test.nemar.org` serves,
so a converter change can be observed against a real re-conversion
before it reaches all ~40k production stores.
Before this, the only thing that ever populated `nemar-dev/*/zarr/*`
was the copy phase of `nemar admin exemplar create --include-derived`
— there is no standalone `copy` subcommand;
`--include-derived` is a flag on `create`, and the copy is one internal phase of it —
which cross-bucket-copies bytes prod already produced
and cannot exercise a converter change at all.

**What it converts.**
`reconcile --api-base https://api-test.nemar.org` enqueues exactly what `nemar-db-dev` marks
public — today that is the seven `xx0999NN` exemplar-fleet datasets
(`scripts/exemplar-fleet.json`) plus any dev-range (`xx09*`) upload.
No separate allowlist.

**Verified live, 2026-09-02:**
`hallu-zarr.sh --test --dataset xx099905` (branch `feature/issue-1180-phase3-staging-pipeline`)
cloned metadata from `api-test.nemar.org`,
streamed all 5 raw `.bdf` recordings from `s3://nemar-dev/xx099905/objects/`,
converted, and pushed to `s3://nemar-dev/xx099905/zarr/`.
[`https://zarr-test.nemar.org/xx099905/zarr/index.json`](https://zarr-test.nemar.org/xx099905/zarr/index.json)
served the fresh result immediately:
`store_count: 5`, `updated_utc: 2026-09-02T16:08:31Z`, `source_commit` matching the clone's HEAD.
Prod's `zarr-queue.db` mtime and `.nm-zarr.lock` were unchanged before/after;
`s3://nemar/xx099905/zarr/` (prod bucket, admin credentials) listed zero objects;
`api.nemar.org/datasets/xx099905` 404s (the id exists only in dev).
The webhook callback was skipped exactly as designed —
no `.zarr-secrets.env` exists yet at `/mnt/local/zarr-state-test/`,
the script logged the non-fatal warning,
and `api-test.nemar.org/datasets/xx099905`'s
`zarr_status`/`zarr_store_count`/`zarr_converted_at` stayed `null`
— S3 is the source of truth the viewer reads, and it advanced regardless.

**State is fully separate from prod**, on the same box:

| Path | What it is |
|---|---|
| `/mnt/local/zarr-state-test/zarr-queue.db` | the test instance's work queue (SQLite; own `flock`, never contends with prod's) |
| `/mnt/local/zarr-state-test/nemar-cli/` | clone of `nemarOrg/nemar-cli`, tracking `ZARR_DRIVER_REF=dev` by default |
| `/mnt/local/zarr-state-test/.zarr-venv/` | the test instance's own Python environment |
| `/mnt/local/zarr-state-test/.nm-zarr.lock` | single-instance lock, independent of prod's |
| `/mnt/local/zarr-state-test/.nm-zarr.log` | detailed per-recording log; only the wrapper's own start/done/error lines carry a `[test]` prefix — output redirected into it from the driver and the `nemar` CLI does not |
| `/mnt/local/zarr-state-test/.nm-zarr-cron.log` | one line per dataset start/finish (once the nightly cron below is installed) |
| `/mnt/local/zarr-scratch-test/` | per-dataset scratch, swept on each run, separate from prod's `/mnt/local/zarr-scratch/` |
| `/mnt/local/zarr-state-test/.zarr-secrets.env` | `NEMAR_WEBHOOK_TOKEN` for the dev worker; **not present as of this writing** — the callback is skipped and the script says so loudly, non-fatally |

**Credentials, resolved by `--test` only when the variable is otherwise unset**
(an explicit env var still wins,
and `--test` refuses six prod values outright — see the guard rails in `hallu-zarr.sh`).
Each of the six is normalized for its own kind of value, and only two are case-folded:
`API_BASE` and `TEST_API_URL` go through `_is_prod_api_host`,
which lowercases and strips scheme, path, query, port and a trailing DNS dot;
`STATE_DIR` and `WORK_DIR` are path-normalized (repeated and trailing `/` collapsed,
`realpath` when the directory already exists) but NOT case-folded;
`S3_BUCKET` and `AWS_PROFILE` are plain exact string equality:

| Variable | `--test` default | Notes |
|---|---|---|
| `API_BASE` | `https://api-test.nemar.org` | the Python driver/queue's catalog and webhook base |
| `TEST_API_URL` | `https://api-test.nemar.org` | **a second, separate hook** — the `nemar` CLI binary that `convert_dataset()` shells out to for the metadata clone resolves its own API base independently of `API_BASE` (`src/lib/api/client.ts` `getApiUrl()`); missed by issue #1180's original env-var inventory, found live during this phase's verification |
| `S3_BUCKET` | `nemar-dev` | |
| `ZARR_AWS_PROFILE` | `nemar-zarr-dev` | IAM user `nemar-hallu-zarr-dev`, `s3:Get/Put/Delete` on `nemar-dev/*/zarr/*` + `GetObject` on `nemar-dev/*/objects/*` + `ListBucket`; cannot write to the prod bucket — per the IAM policy as provisioned 2026-09-02 (inline policy `zarr-rw-dev` on user `nemar-hallu-zarr-dev`, no IaC in this repo) |
| `ZARR_STATE_DIR` | `${ZARR_BASE:-/mnt/local}/zarr-state-test` | |
| `ZARR_WORK_DIR` | `${ZARR_BASE:-/mnt/local}/zarr-scratch-test` | |
| `ZARR_DRIVER_REF` | `dev` | tracks the same unreleased branch the rest of staging tracks; the installed cron line below sets it explicitly to `dev` (it pinned the epic branch while epic #1181 was open, flipped back 2026-09-03) |
| `ZARR_JOBS` | `4` | deliberately low — a test instance shares Hallu's cores with the prod backfill and must not contend with it |

**Ops sanity check, no side effects:**
`hallu-zarr.sh --test --print-config` (or plain `--print-config` for the prod defaults)
prints every resolved value and exits 0 before touching the filesystem, network, or lock
— safe to run at any time, from any state dir.

**Run one dataset by hand:**

```bash
ssh hallu '/mnt/local/zarr-state-test/nemar-cli/scripts/zarr/hallu-zarr.sh --test --dataset xx099905'
```

(or `--test --limit 1` to let `reconcile` pick the next queued dataset instead of naming one).
Watch `/mnt/local/zarr-state-test/.nm-zarr.log`;
confirm the fresh store at `https://zarr-test.nemar.org/<id>/zarr/index.json`.

**Bootstrapping a node with no test clone yet**
(same shape as the prod bootstrap in §3.3 — the script has to exist before the clone does):

```bash
ssh hallu 'mkdir -p /mnt/local/zarr-state-test'
scp scripts/zarr/hallu-zarr.sh hallu:/mnt/local/zarr-state-test/hallu-zarr.sh
ssh hallu 'chmod +x /mnt/local/zarr-state-test/hallu-zarr.sh
           ZARR_DRIVER_REF=<branch> /mnt/local/zarr-state-test/hallu-zarr.sh --test --print-config'
```

`setup()` then clones `ZARR_DRIVER_REF` into `/mnt/local/zarr-state-test/nemar-cli/`
on the first real (non-`--print-config`) invocation, same as prod.
Once that clone exists, cron and manual runs alike should invoke the CLONE's copy
(`/mnt/local/zarr-state-test/nemar-cli/scripts/zarr/hallu-zarr.sh --test ...`),
not the hand-placed bootstrap copy,
so `setup()`'s self-deploy keeps it current
— identical reasoning to §3.3's driver/script split.

**Cron — INSTALLED. The line on Hallu, verbatim:**

```
15 3 * * * mkdir -p /mnt/local/zarr-state-test && ZARR_DRIVER_REF=dev /mnt/local/zarr-state-test/nemar-cli/scripts/zarr/hallu-zarr.sh --test >> /mnt/local/zarr-state-test/.nm-zarr-cron.log 2>&1
```

Nightly at 03:15 UTC and off the prod cron's `:30` hourly tick
— deliberately infrequent, since the test catalog is small
and the point is observability, not throughput.

Two parts of that line are not decoration:

- `mkdir -p` runs first so the redirect target's directory exists on a node where
  the state dir has been wiped; `>>` would otherwise fail before the script ran,
  and cron's only trace of it is mail nobody reads.
- **`ZARR_DRIVER_REF` is set EXPLICITLY** even though it matches `--test`'s `dev`
  default, so the ref staging runs is visible in `crontab -l` rather than buried
  in the script. While epic #1181 was open it pinned the epic branch, because
  staging's job then was to prove the epic before `dev` had it; it was flipped
  back to `dev` on 2026-09-03 once the epic merged. **Never leave it on a merged
  branch** — GitHub deletes the branch on merge, `setup()` then FATALs on the
  unresolvable ref, and before that it would pin staging to a commit that stops
  moving while looking perfectly healthy. Edit the crontab by writing the edited
  copy to a file and installing it with `crontab <file>`, never by piping into
  `crontab -` (a failed `sed` in the pipe installs an empty crontab).

**What is NOT shared with prod:**
state directory, lock, queue db, venv, driver clone,
`ZARR_JOBS` (capped to protect prod's cores), S3 bucket, IAM profile, API base,
webhook token/secrets file.
**What IS shared:**
the Hallu box itself and its cores (hence the low `ZARR_JOBS`),
and the `nemar-cli` GitHub repo the driver is cloned from (different ref).

---

## 4. Test machines

| Machine | SSH alias | NEMAR user | Role |
|---|---|---|---|
| yahyas-mcm | `ssh mcm` | yahya | admin |
| yahyas-mba | `ssh mba` | cool-vibers | regular user |

The `nemar` CLI on both needs an interactive zsh shell:

```bash
ssh mba "zsh -i -c 'nemar sandbox'"
ssh mcm "zsh -i -c 'nemar admin users'"
```

---

## 5. Disaster recovery (#655, epic #794)

D1 (`nemar-db`) is backed up hourly to the private repo `nemarOrg/nemar-db-backup`
by a GitHub Actions cron, where git history serves as point-in-time recovery.
It is the only stateful Cloudflare resource that is backed up.

**The fts5 gotcha:** `wrangler d1 export` refuses any database containing an fts5 virtual table,
and `datasets_fts` is one. The backup works around it by exporting each real table with `--table`
and recreating the index from `sqlite_master` on restore.
Do not expect a plain whole-database export to work.

Both recovery tools live in the backup repo, not here:

- `scripts/restore-remote.sh --target <db> --execute` — guarded restore.
  Verifies sha256 and row counts, and refuses production without `--force-prod`.
- `scripts/run-local.sh --nemar-cli <path>` — loads a real snapshot into a local
  miniflare D1 and runs `wrangler dev` against it.

**A restore is only as good as its largest statement.** The backup renders one
INSERT per row and D1 refuses any statement over ~100 KB on restore
(`SQLITE_TOOBIG`), so a single oversized row makes the whole backup
unrestorable — and nothing at backup time detects it (#1188: 15 such
statements, found only by rehearsing a real restore). Row payloads are
therefore bounded at the write path (ADR 0036: counts and pointers, never
inline per-file lists; `AUDIT_DETAILS_MAX_BYTES` in `backend/src/db/audit-log.ts`),
and migration 0074 compacted the rows that had already outgrown the limit.
