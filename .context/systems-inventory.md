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
| `30 * * * *` | `/data/projects/yahya/nemar/hallu-zarr.sh` (with `ZARR_JOBS=24`) | `/mnt/local/zarr-state/.nm-zarr-cron.log` |

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
| `/mnt/local/zarr-state/nemar-cli/` | clone of `nemarOrg/nemar-cli`; supplies the driver (`git pull` is the deploy path) |
| `/mnt/local/zarr-state/.zarr-venv/` | the Python environment biosigio installs into |
| `/mnt/local/zarr-state/.nm-zarr.lock` | single-instance lock |
| `/mnt/local/zarr-state/.nm-zarr.log` | detailed per-recording log (tens of MB; `grep -a`) |
| `/mnt/local/zarr-state/.nm-zarr-cron.log` | one line per dataset start/finish |
| `/mnt/local/zarr-scratch/` | per-dataset scratch, swept on each run |
| `/data/projects/yahya/nemar/.zarr-secrets.env` | credentials, mode 600 |

Everything except the secrets is rebuildable, so the whole state directory is disposable.

**Queue state:**

```bash
ssh hallu '/mnt/local/zarr-state/.zarr-venv/bin/python \
  /mnt/local/zarr-state/nemar-cli/scripts/zarr/zarr_queue.py \
  --db /mnt/local/zarr-state/zarr-queue.db stats'
```

#### Deploying a converter change

Two halves deploy differently, and the difference has bitten twice.

**The Python driver deploys itself.** `setup()` runs
`git fetch && git reset --hard origin/$ZARR_DRIVER_REF` (default `main`) on the `nemar-cli` clone,
then installs from that clone's `scripts/zarr/requirements.txt`
with `--refresh-package biosigio --upgrade-package biosigio`
so a version bump takes effect rather than resolving against a stale index cache.

**`hallu-zarr.sh` cannot deploy itself,** because it has to exist before the clone does.
It is a hand-placed copy that git never touches.
The script compares itself against the repo copy each run and logs `DRIFT:` when they differ,
but it deliberately does not self-copy: bash reads a script incrementally,
so rewriting the running file mid-run resumes execution at a garbage byte offset.
Deploy with an atomic rename, never an in-place overwrite:

```bash
scp scripts/zarr/hallu-zarr.sh hallu:/data/projects/yahya/nemar/.hallu-zarr.sh.new
ssh hallu 'cd /data/projects/yahya/nemar && bash -n .hallu-zarr.sh.new \
  && cp -p hallu-zarr.sh hallu-zarr.sh.bak-$(date +%Y%m%d) \
  && chmod +x .hallu-zarr.sh.new && mv .hallu-zarr.sh.new hallu-zarr.sh'
```

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
