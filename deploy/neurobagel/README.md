# NEMAR Neurobagel node on nemaring

This directory runs the stock Neurobagel node for epic #1586 (Phase 3, #1589).
The node is Neurobagel's own `recipes` stack in graph mode: GraphDB, the node API, the federation API and the query tool.
It runs on `nemaring.ucsd.edu` as one Docker Compose project, `nemar-neurobagel`, under hard memory and CPU limits.
It is fed by a loader that pulls artifacts from a private store on a schedule, so nothing is ever pushed to the host.
The decision and its reasons are ADR 0082 (`.context/decisions/`).

Nothing in this directory is a copy of Neurobagel's code.
`bin/nb-install` checks `neurobagel/recipes` out at the tag pinned in `pins.env` and verifies the commit hash.
`docker-compose.nemar.yml` is an overlay merged after recipes' own compose file.

## Contents

| Path | What it is |
| --- | --- |
| `pins.env` | Versions, tracked in git: recipes tag and commit, and every image by tag and digest |
| `.env.example` | The host-local settings template (placeholders only); `.env` is created from it, mode 600, never tracked |
| `docker-compose.nemar.yml` | The overlay: limits, loopback ports, health checks, log caps, the optional tunnel connector |
| `bin/nb` | The one command; every subcommand is a script `bin/nb-<name>` |
| `bin/nb-common.sh` | Shared functions: paths, lock, atomic writes, the compose wrapper, log parsers |
| `tools/build-index.sh` | Writes `index.json` for a directory of artifacts (the executable form of the interface below) |
| `tools/gen-synthetic-jsonld.ts` | Synthetic JSON-LD for footprint measurements; never for a registered or exposed node |
| `config/local_nb_nodes.json` | The one node the local federation API queries: this node, over the internal network |

Runtime directories, all created by the scripts and all untracked: `recipes/` (the checkout), `secrets/`, `data/` (releases), `state/`, `backups/`, `logs/`.

## Commands

| Command | What it does |
| --- | --- |
| `bin/nb install` | First-time setup. Idempotent; starts nothing |
| `bin/nb up` | Starts the stack from nothing and waits until it is loaded and verified |
| `bin/nb down` | Stops this project's containers. Volumes and data are kept |
| `bin/nb status [--json] [--deep]` | One read-only look: health, release, loader and reload history, limits, usage. Exit 0 healthy, 1 degraded, 2 down, 3 on hold |
| `bin/nb load` | Pulls changed artifacts and reloads the graph if (and only if) something changed. Cron runs this |
| `bin/nb reload` | A deliberate, measured, verified reload of the live release, with rollback |
| `bin/nb hold "reason"` / `bin/nb unhold` | Incident mode: take the node out of the federation now, and put it back |
| `bin/nb rollback [--list] [RELEASE]` | Go back to an earlier release, reload it, and freeze the loader |
| `bin/nb guard [--watch N] [--abort-on mem,load,neighbor]` | Resource guard: sample, log, and stop this project (only) on a breach |
| `bin/nb backup [--graph-export]` / `bin/nb restore ARCHIVE` | Back up and restore the inputs and state |
| `bin/nb compose ARGS` | `docker compose` for this project only; it cannot name another project |
| `bin/nb cron-line` | Prints the crontab lines. Installs nothing |

## How it fits together

1. The loader reads `index.json` from the artifact store, compares it with the live release, downloads only what changed, and checks every file against the index (sha256 and size).
2. It assembles a complete new release directory, validates it with the stock initialiser (a throwaway container with no network), and swaps one symlink, `data/current`, to it with one `rename(2)`.
   A failure at any point leaves `data/current` exactly as it was and leaves no residue.
3. A reload then runs under the lock: the stock init container rebuilds the data volume, GraphDB is stopped cleanly and restarted (the stock setup clears the graph and uploads every file plus the vocabulary), the node API is restarted (it reads its dataset metadata once, at start), and the result is verified.
4. Verification asks the node for every dataset with the empty query and requires exactly the datasets of the release, every one marked `records_protected`, and a subject query that returns `protected` instead of participant rows.
5. If any step fails, `data/current` is pointed back at the previous release and that release is loaded instead.
   Content that failed is remembered and not retried for six hours.

Participant-level records are never exposed.
`NB_RETURN_AGG=true` is fixed in the overlay, not left to `.env`, and every reload and `nb status --deep` fails if the node returns anything else.

## What is on the host (read-only inspection, 2026-10-01)

nemaring is Ubuntu 24.04.4 with 8 CPUs, 7.7 GiB of RAM, 3.8 GiB of swap, Docker 29.1.3 and Compose 2.40.3.
Two compose projects run: `nemar-infisical` (`/opt/nemar-infisical`) and `nemar-umami` (`/opt/nemar-umami`), each in its own directory owned by the same account, each with its own network and named volumes.

| Container | CPU | Memory | Memory limit |
| --- | --- | --- | --- |
| `infisical-backend` | 0.6% | 790 MiB | none |
| `infisical-db` | 0.0% | 150 MiB | none |
| `infisical-cloudflared` | 0.4% | 27 MiB | none |
| `infisical-redis` | 1.5% | 11 MiB | none |
| `nemar-umami-umami-1` | 0.1% | 250 MiB | 3 GiB |
| `nemar-umami-db-1` | 1.6% | 41 MiB | 1.5 GiB |
| `nemar-umami-cloudflared-1` | 0.5% | 17 MiB | 256 MiB |

Baseline before any change: `free -m` showed 5,381 MiB available and 484 MiB free, load average 0.21, 23 GB of disk free.
Loopback ports 8080 (Infisical) and 3000 (Umami) are in use, so this project uses 18000, 18080 and 13000, checked free with `ss -ltn`.

Patterns observed, from directory listings and `docker ps` only (the compose files and environment of the other projects were not read, as instructed):

- A project lives in `/opt/nemar-<name>/` as its own git repository, with `.env` (mode 600, not tracked), `.env.example` (tracked), `cloudflared/` and `backup/` directories.
- Each project runs its own `cloudflared` container, with no published port, as the public entrance.
- The account's crontab (listed once, read-only) runs an hourly backup of the Infisical database and a Umami job that gets its secrets through a wrapper script.

This project follows the same shape where it can: it has its own compose project, `.env` (mode 600) and `.env.example`, a `backups/` directory, a `cloudflared` service behind a profile, and cron lines printed for a person to install.
It lives under the home directory (`/home/yahya/neurobagel`) because `/opt` is not writable without root.
The tunnel wiring is inferred from `docker ps` and the directory layout; confirm it against the other projects before enabling the `tunnel` profile.
The GraphDB credentials are generated on the host by `nb-install` (random, in a mode 700 directory, mode 600 files) and are never copied anywhere.
They are visible to the containers only as Docker secrets.
One caveat that is Neurobagel's, not this project's: the stock load scripts pass the GraphDB password as a command-line argument inside the container, so it is briefly visible in a process listing of the host.
The password protects a port that is not published, and only the host's administrators can list processes.

## Install

Run these on nemaring as the account that owns the deployment.
Nothing here touches another project.

1. Copy this directory to the host.
   From a checkout of `nemarOrg/nemar-cli`:

   ```bash
   rsync -a --exclude-from=<(printf '%s\n' /.env /secrets/ /recipes/ /data/ /state/ /backups/ /logs/ /scratch/) \
     deploy/neurobagel/ nemaring:/home/yahya/neurobagel/
   ```

2. Install.
   It needs `docker` with Compose 2.24 or later, `git`, `jq`, `curl`, `perl`, `openssl`.

   ```bash
   cd ~/neurobagel
   bin/nb install      # recipes at the pinned tag, .env, GraphDB credentials, first release from Neurobagel's example
   bin/nb up           # pulls the pinned images (about 5 GB), builds the init image, starts, waits, verifies
   bin/nb status --deep
   ```

3. Review `.env`.
   The defaults are the measured ones.
   `COMPOSE_PROFILES=portal` runs the local federation API and query tool (about 0.2 GiB of limits); remove `portal` to free it.
4. Point the loader at the store: set `NB_SOURCE` (and `NB_SOURCE_AUTH_HEADER_FILE` if the store needs a header) in `.env`, then `bin/nb load --dry-run` to see the plan.
5. Install the schedule, if the lead agrees: `bin/nb cron-line` prints three lines (load every 20 minutes, guard every 5, backup nightly) to paste into `crontab -e`.

Reaching the local tools from a laptop:

```bash
ssh -L 13000:127.0.0.1:13000 -L 18080:127.0.0.1:18080 -L 18000:127.0.0.1:18000 nemaring
# query tool http://localhost:13000, federation API http://localhost:18080/docs, node API http://localhost:18000/docs
```

## Artifact store interface (what Phase 4 must provide)

The loader reads one JSON document, `index.json`, and then the files it lists, all relative to one base URL (or directory).
`NB_SOURCE=https://store.example/neurobagel` means `https://store.example/neurobagel/index.json` and `https://store.example/neurobagel/<name>` for each artifact.
`tools/build-index.sh DIR` writes a conforming index for a directory and is the reference implementation.

```json
{
  "schema": "nemar-neurobagel-artifact-index/1",
  "generated_at": "2026-10-02T03:00:00Z",
  "datasets": [
    {
      "id": "nm000132",
      "fingerprint": "sha256:6f1c0e5d9a...",
      "artifacts": [
        {"name": "nm000132.jsonld", "kind": "jsonld", "sha256": "60ead229c05b221f07f6d6578643cf76da77bea9fe175840494dde2897fcde42", "bytes": 41928},
        {"name": "nm000132_annotated.json", "kind": "dictionary", "sha256": "...", "bytes": 1305},
        {"name": "nm000132_dataset_description.json", "kind": "description", "sha256": "...", "bytes": 811}
      ]
    }
  ]
}
```

Rules, all enforced by the loader (the index is refused, with exit code 3 and nothing changed, if any is broken):

- `schema` is exactly `nemar-neurobagel-artifact-index/1`.
- `datasets[].id` is unique and matches `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`.
- Each dataset has one `jsonld` artifact named `<id>.jsonld`, and optionally a `dictionary` named `<id>_annotated.json` and a `description` named `<id>_dataset_description.json`.
  Graph mode loads only the JSON-LD; the other two are kept in the release for catalog mode and for audit.
- Artifact names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and contain no `..`; names are unique across the index; there is no `url` field and no sub-directory.
- `sha256` (64 lowercase hex) is required and is verified for every file; `bytes`, if present, must equal the size; no file may exceed `NB_MAX_ARTIFACT_BYTES` (128 MiB) or be empty.
- `fingerprint` is an opaque non-empty string that must change whenever any artifact of the dataset changes.
  The loader decides what changed by comparing artifact hashes, so a fingerprint that stays the same while content changes is applied and reported as a warning.
- Every `jsonld` file must be a Neurobagel dataset: an `@context`, an `identifier` starting `nb:`, `schemaKey` `Dataset`, a non-empty `hasLabel`, and at least one entry in `hasSamples`.
  No two files may share an identifier; the stock initialiser silently keeps only one.
  The stock validator must accept every file; a file it rejects fails the whole load rather than being skipped.
- Removal is by omission.
  A dataset absent from the index is absent from the next release.
  That is how a dataset that becomes private, withdrawn or deleted leaves the federation, so the producer must drop it from the index at once.
  An index with zero datasets is refused, and so is one that drops more than half of at least ten datasets, unless the operator passes `--allow-mass-removal`.
- Authentication: if the store needs it, put one complete header line (for example `Authorization: Bearer ...`) in a mode 600 file and set `NB_SOURCE_AUTH_HEADER_FILE`.
  The loader hands it to curl with `-H @file`, so the token never appears in a process listing, a log or a state file.
  The loader sends the user agent `nemar-neurobagel-loader/1.0`.
- The loader only reads; it never writes to the store, and it sends no other request than `GET index.json` and `GET <name>`.

## Loading, reloading, holding

`bin/nb load` is safe to run from cron.
When the index matches the live release it makes one small request and exits.
When something changed it fetches only the changed files (unchanged ones are hard-linked from the live release), validates, publishes a release, and reloads.

While the graph reloads the node answers queries with partial or no results.
Any change, one dataset or all of them, costs one full reload, because the stock design clears and reloads the whole graph.
The measured numbers are below; read them before choosing a schedule.

| State file | Meaning |
| --- | --- |
| `state/pending-reload` | A release is staged and not yet loaded (a reload was disabled, held, or interrupted); the next `nb load` or `nb reload` loads it |
| `state/hold` | Incident mode; no reload runs and the node API stays stopped |
| `state/freeze` | Set by `nb rollback`; the loader fetches nothing until `nb load --thaw` |
| `state/reload-failed` | Content that failed to reload, kept so it is not retried for `NB_KNOWN_BAD_TTL_S` (six hours); `--force` overrides |
| `state/degraded` | A reload and its rollback both failed; `nb status` says so |
| `state/applied.json` | The release that is loaded and verified, and when |
| `state/reload-history.jsonl` | One JSON line per reload, adopt or rollback, with the seconds each phase took and the lowest host memory seen |
| `state/last-load.json` | How the last loader run ended |
| `state/guard.log` | Tab-separated guard samples: time, host available MiB, load, per-container CPU and memory, verdict |

A reload refuses to start unless the host has `NB_MIN_AVAILABLE_MB` available (1800) and aborts, stopping only the graph container and skipping the rollback, if available memory falls below `NB_ABORT_AVAILABLE_MB` (1536) while it runs.

## Resource limits and monitoring

Every container has `mem_limit` equal to `memswap_limit` (no swap), a CPU limit, a pids limit, `no-new-privileges`, and a 30 MiB log cap.
The defaults sum to 2880 MiB, under the epic's 3 GiB ceiling:

| Container | Memory limit | CPUs | Why this much (measured) |
| --- | --- | --- | --- |
| `graph` | 2048 MiB (heap 1.5 GiB) | 2.0 | Peak 1.9 GiB at 50,105 subjects |
| `api` | 512 MiB | 1.0 | 384 MiB was too small: the unrestricted subject query got the process killed; peak 355 MiB |
| `federation` | 128 MiB | 0.5 | Peak 63 MiB |
| `query_federation` | 64 MiB | 0.5 | Peak 12 MiB |
| `cloudflared` (profile `tunnel`) | 128 MiB | 0.5 | Same family as the other projects' connectors, 17 to 27 MiB |
| `init_data` (runs for seconds) | 256 MiB | 1.0 | Peak 30 MiB |

`bin/nb guard` takes one sample (or loops with `--watch N`): host memory available, load average, this project's container usage, and the start time, restart count and health of every other container (state only, never their data or environment).
Breaches: host available memory below 1536 MiB, load average above 6 for six samples, or another container restarting or turning unhealthy since the baseline.
`--abort-on mem,load,neighbor` makes a breach stop THIS project and nothing else; the default is `mem`.
The cron line installed by `bin/nb cron-line` runs it every five minutes with `--abort-on mem`.

The guard keeps a heartbeat (`state/guard-heartbeat`), and `bin/nb status` warns when it is more than 20 minutes old: a guard that has died must not look like a quiet one.
After a change you made on purpose to another container (an Infisical upgrade, say), run `bin/nb guard --baseline`, or the `neighbor` rule will read the restart as a breach.

`bin/nb status` is the read-only check.
It is safe to run from a monitoring job; `--deep` adds the full verification query and should not run every minute.

## Measured footprint

Measured on nemaring on 2026-10-01 and 2026-10-02, alongside Infisical and Umami, with the stock images pinned in `pins.env`.
Memory is `docker stats` sampled every 5 seconds.
No existing container restarted and none became unhealthy at any point, and host available memory never fell below 3.3 GiB (the abort threshold is 1.5 GiB).

### Idle

| State | Graph | API | Federation API | Query tool | CPU (each) |
| --- | --- | --- | --- | --- | --- |
| Neurobagel's example, 1 dataset, 5 subjects | 819 MiB | 80 MiB | 50 MiB | 10 MiB | under 0.5% |
| 800 synthetic datasets, 50,105 subjects, 879,201 statements, 150 s after a reload | 1.35 GiB | 104 MiB | 62 MiB | 8 MiB | under 0.5% |

The graph's memory is the JVM heap's high-water mark; it falls back only when the container restarts, which a reload does.

### Reload, by scale

| Release | Statements | Init | Graph | API | Verify | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Neurobagel example plus 5 synthetic datasets, about 30 subjects | not counted | 2 s | 38 s | 9 s | 1 s | 50 s |
| 100 synthetic datasets, 7,190 subjects | 126,131 | 1 s | 54 s | 9 s | 6 s | 70 s |
| 18 real datasets (the Phase 1 goldens), 1,011 subjects, from a small graph | 14,811 | 2 s | 45 s | 10 s | 1 s | 58 s |
| 18 real datasets, from the 800-dataset graph (clearing it dominates) | 14,811 | 1 s | 71 s | 9 s | 2 s | 83 s |
| 800 synthetic datasets, 50,105 subjects, shape of a NEMAR record, shipped limits | 879,201 | 3 s | 166 s | 9 s | 55 s | 233 s |
| the same with one dataset changed (staging and validation add 31 s) | 879,201 | 3 s | 168 s | 9 s | 26 s | 206 s |
| 800 synthetic datasets, four times the density, 172 MB of JSON-LD | 3,564,819 | 10 s | 244 s | 10 s | 39 s | 303 s |
| First start of the stack, cold, with Neurobagel's example (5 subjects), including GraphDB's first-time setup | not counted | | 45 s | | | 46 s |

Stopping GraphDB cleanly matters: the stock container ignores SIGTERM, and a plain restart waited out its timeout (60 s) and then killed GraphDB.
`nb-reload` asks the JVM to shut down instead, which removed that wait and the crash recovery on the next start.

### Peak memory during those loads

| Scale | Graph | API | Federation API | Query tool | Host available (lowest) | Load (highest) |
| --- | --- | --- | --- | --- | --- | --- |
| 100 datasets, 1 GiB heap | 899 MiB | 94 MiB | 53 MiB | 12 MiB | 4,250 MiB | 2.2 |
| 800 datasets, 50,105 subjects, 1 GiB heap | 1,027 MiB | 172 MiB | 54 MiB | 11 MiB | 4,087 MiB | 2.4 |
| 800 datasets, 50,105 subjects, shipped limits (1.5 GiB heap) | 1,917 MiB | 355 MiB | 44 MiB | 10 MiB | 3,657 MiB | 2.3 |
| 800 datasets, four times the density, 1.5 GiB heap | 1,566 MiB | 196 MiB | 63 MiB | 12 MiB | 3,819 MiB | 2.9 |
| 18 real datasets (clearing the previous 3.6 million statements) | 1,562 MiB | 141 MiB | 57 MiB | 9 MiB | 3,895 MiB | 2.0 |
| 800 datasets, 2 GiB heap (experiment) | 1,903 MiB | 207 MiB | 63 MiB | 9 MiB | 3,649 MiB | 1.8 |

### Queries at 50,105 subjects, 800 datasets

| Query | Time | Result |
| --- | --- | --- |
| `POST /datasets {}` (the heaviest dataset-level query) | 1.9 to 2.2 s, 14 runs | 800 datasets |
| the same with sex, age range, diagnosis or modality filters | 1.7 to 2.1 s | agrees with ground truth |
| the same at four times the density | 6.7 to 7.4 s | 800 datasets |
| 8 simultaneous `POST /datasets {}` | 6.9 to 13.1 s to finish, one after another | all 200 |
| `POST /subjects {}` (every subject) | 15 to 21 s, or HTTP 500 when GraphDB has under 250 MB of free heap | refused or `protected` |

Queries run one at a time (see the licence section).
Real data, checked against ground truth: the 18 Phase 1 golden JSON-LD files, 1,011 subjects, were loaded by the stock initialiser and GraphDB without any file skipped, and six queries (female, ages 30 to 50, healthy control, EEG, a combined filter, and the empty query) returned exactly the dataset and subject counts computed independently from the files, through the node API and through the local federation API (`nodes_response_status` was `success` each time).
Each dataset's first link, `https://nemar.org/dataset/<id>`, came back as `homepage`, and `access_email` was null.

### Disk

The pinned images are 5.1 GB (node API 1.87 GB, federation API 1.69 GB, GraphDB 1.42 GB, init 0.23 GB, query tool 0.10 GB).
The GraphDB repository is 74 MiB at 7,190 subjects and 132 MiB at 50,105; it keeps its high-water mark, so after the four-times-density test it stayed at 477 to 768 MiB.
A release is 35 MB of JSON-LD for 800 datasets at 50,105 subjects (172 MB at four times the density); `NB_KEEP_RELEASES` (4) are kept for rollback.
Disk free on the host fell from 23 GB to about 18 GB during the trial.

### Estimate at the planned scale

Assumptions: about 800 datasets, 30,000 to 100,000 subjects (the epic says tens of thousands), the shape the transform produces.
The real Phase 1 goldens come to 14.6 statements per subject, and the synthetic NEMAR-shaped set to 17.5, so the estimate uses 15 to 18.

| Subjects | Statements | JSON-LD | Graph resident | Reload | Fits the shipped limits |
| --- | --- | --- | --- | --- | --- |
| 30,000 | 0.45 to 0.54 million | about 21 MB | 1.0 to 1.5 GiB | about 3 minutes | yes |
| 50,000 | 0.75 to 0.9 million | about 35 MB | 1.3 to 1.9 GiB | 3.5 to 4 minutes | yes |
| 100,000 | 1.5 to 1.8 million | about 70 MB | 1.6 to 2.0 GiB | about 5 minutes | at the limit; raise the graph limit |

Reload time is roughly 25 s of GraphDB start, a cost proportional to the number of files (about 0.14 s each) and to the size of the graph being cleared, plus 10 to 60 s of API restart and verification.
It was measured linear from 5 to 800 datasets and from 126 thousand to 3.6 million statements.
The memory estimate extrapolates a measured range and is not itself measured above 3.6 million statements.

### GraphDB Free licence

GraphDB runs here as the Free edition: its startup log says `Product: GRAPHDB_LITE`, `Licensee: Freeware`, `Expiry date: none`, `Max CPU cores: 1`.
From Ontotext's documentation (10.8 and 11.x licensing pages, read 2026-10-01):

- Statements are unlimited ("Manage unlimited number of RDF statements"), so the planned 1 to 2 million statements is far inside the limit.
- Concurrency is limited, and the documentation disagrees with itself: the prose says a limit of two concurrent queries, and the 10.8 feature table says one.
  What was measured agrees with the table: eight simultaneous queries finished one after another.
- No cluster or high availability; community support only.

Is that a problem at this scale?
Not for storage or for one user at a time.
Each dataset-level query takes about 2 seconds and queries are served one by one, so sustained throughput is about one query a second.
The Neurobagel federation API waits for every node and puts no timeout on dataset queries, so a queue at this node slows a user's federated query for all nodes.
That risk argues for a Cloudflare rate-limit rule on the hostname (below), not for a different edition.
GraphDB also refuses any group-by or distinct query while less than 250 MB of heap is free; the heap sizing above is what keeps that from affecting dataset-level queries.

## Upgrade

Versions change only by editing `pins.env` in a pull request.

1. Edit `pins.env` (recipes tag and commit, image tags and digests; the commit is the one the tag resolves to).
2. Copy the directory to the host.
3. `bin/nb install` moves the recipes checkout to the new tag and refuses to continue if the commit does not match the pin.
4. `bin/nb down`, `bin/nb compose pull`, `bin/nb up`, then `bin/nb status --deep`.
   The node is out for the length of a first start (about 45 seconds with a small graph, minutes with the full one).
5. Repeat the measurements that matter (reload time, peak memory) before the change is called done.
   GraphDB's repository format can change across minor versions: read its release notes first.

A reminder that recipes' own changelog applies: the node API, the federation API and the query tool are released together, and 2026-09-14 removed a query endpoint across API 0.11.0 and federation API 0.10.0 on the same day.

## Backup and restore

The graph is derived, so the backup is its inputs: `.env`, `secrets/`, the live and rollback releases, the manifests, `state/`, and `pins.env`.
`bin/nb backup` writes `backups/nb-<UTC>.tar.gz` (mode 600, in a mode 700 directory) with a checksum list, and keeps the newest 14.
`--graph-export` adds `nb-graph-<UTC>.nq.gz`, the whole graph as N-Quads, read through GraphDB's own export with no downtime, for forensics or to restore without the artifact store.
**The archive contains the GraphDB passwords.** Copy it off the host only to a place held to the same standard as the secrets store.

To restore on this host or a rebuilt one:

```bash
bin/nb install              # on a new host: recipes, directories (it will not overwrite anything that exists)
bin/nb down                 # restore refuses while this project's containers exist
bin/nb restore backups/nb-<stamp>.tar.gz     # verifies every checksum first; keeps an existing .env and secrets/
bin/nb up                   # loads the restored release into the graph and verifies it
```

`--overwrite-config` replaces `.env` and the secrets.
Do not use it on a host whose graph volume already exists: GraphDB's passwords are fixed in the volume on first start, and replacing them locks the node out of its own graph.
If that happens, the only fix is a hard reset: `bin/nb down`, `docker volume rm nemar-neurobagel_graphdb_home` (this project's volume, named explicitly), `bin/nb up`.

This procedure was rehearsed on nemaring: backup, `bin/nb down`, discard `data/` and `state/`, restore, `bin/nb up`, and a deep status check all passed (results in the pull request).

## Rollback

- Automatic: a reload that fails verification restores the previous release and loads it.
  The exit code is 5 and `bin/nb status` reports the newest content as not served.
- Deliberate: `bin/nb rollback --list` shows the releases still on disk, and `bin/nb rollback [RELEASE]` makes one live, reloads it, and freezes the loader so the next scheduled run does not undo the rollback.
  `bin/nb load --thaw` ends the freeze.
- Of the stack itself: restore the previous `pins.env` and run the upgrade steps in reverse.
  The previous images stay in Docker's cache until pruned (do not run `docker system prune` on this host).

## Cloudflare Tunnel (for the lead; nothing here is enabled)

The node has no public path today.
The `tunnel` profile adds a `cloudflared` connector that exposes exactly one thing, the node API, as `http://api:8000` inside the project network.
The connector token and the hostname are the lead's decision; nothing below has been done.

1. In the Cloudflare Zero Trust dashboard, Networks, Tunnels, create a tunnel of type Cloudflared named `nemar-neurobagel` and copy its connector token.
2. Add a public hostname to the tunnel, for example `neurobagel.nemar.org`, with service type HTTP and URL `api:8000`.
   No path, no Access policy (Neurobagel's federation API must reach it unauthenticated), and leave `NB_NAPI_BASE_PATH` empty.
3. On the host, in `.env` only, set `NB_TUNNEL_TOKEN=<token>` and `COMPOSE_PROFILES=portal,tunnel`.
4. Start the connector without touching the running node: `bin/nb compose --profile tunnel up -d --no-deps cloudflared`.
5. Check: `curl -s https://<hostname>/` returns the node API welcome page, `curl -s -X POST -H 'Content-Type: application/json' -d '{}' https://<hostname>/datasets` returns the datasets, and `bin/nb status` shows `cloudflared` healthy.
6. Recommended: a Cloudflare rate-limiting rule on the hostname (the node serves one query at a time), and a rule that blocks `POST /subjects` from outside if nobody needs it: that endpoint is the heaviest and the node returns only `protected` there anyway.

Registration in Neurobagel's federation (the `neurobagel/menu` pull request) is Phase 7, and happens only after the gate in the epic.
Do not register this node before then.

To take the tunnel back down: `bin/nb compose --profile tunnel stop cloudflared`, and remove `tunnel` from `COMPOSE_PROFILES`.

## Incident: take the node out of the federation now

```bash
ssh nemaring
cd ~/neurobagel && bin/nb hold "what happened"
```

That writes `state/hold`, kills the node API container (immediately: it holds no state), and keeps the loader and every reload from bringing it back.
The federation API of Neurobagel marks a node whose API does not answer as failed and returns no records from it.
If the script is not to hand: `docker kill nemar-neurobagel-api-1`.
Checks: `curl -s -o /dev/null -w '%{http_code}' https://<hostname>/` no longer returns 200, and `bin/nb status` says `HOLD`.

Put it back with `bin/nb unhold` (it reloads a staged release first, then starts the API and verifies).

If the cause is a dataset that must not be federated: remove it from the artifact store's index first, so the next load drops it, then `bin/nb load`.
The hold only buys time.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `nb status` says degraded, `the last reload failed` | `state/reload-history.jsonl` has the reason. The previous release is serving. Fix the content in the store; the loader retries in six hours, or run `bin/nb load --force` |
| Reload fails with `the graph reported upload errors` | GraphDB rejected a JSON-LD file (the stock script prints the error and still exits 0). The release was rolled back. Find the file in `logs/last-init.log` and `docker logs nemar-neurobagel-graph-1` |
| Verification says `served datasets differ from the release (missing: ...)` | GraphDB loaded a document with no usable statements, for example a broken `@context`. The identifier is in the message |
| Node API answers 500 for a subject query | GraphDB had under 250 MB of free heap. Dataset queries are unaffected. Retry; raise the heap only after reading the footprint section |
| Node API restarts by itself | The API container hit its 512 MiB limit (an unrestricted subject query at 50k subjects). It comes back in seconds |
| `nb up` refuses: `service graph is already running` | The stock init container rewrites the shared data volume on every `up`, which on a running node could put the API and the graph out of step. Use `nb reload` |
| The node API cannot start | It fetches its vocabularies from GitHub raw at start. Check outbound access to `raw.githubusercontent.com` |
| `nb load` exits 75 | Another loader or reload holds `state/lock.d`. `nb status` and the lock's `what` file say which. A lock whose process died is taken over automatically |
| Host available memory falls | `bin/nb guard` logs it and stops this project below 1.5 GiB. `bin/nb up` starts it again once memory recovers |

## Rehearsals on nemaring (2026-10-02)

Each of these was run for real on the trial stack, with the 18 real Phase 1 datasets or the 800-dataset set loaded.

| Rehearsal | Result |
| --- | --- |
| A release that GraphDB rejects (a dataset with an invalid JSON-LD `@context`; the stock validator and the loader's own checks accept it) | The stock upload script printed the error and exited 0; the reload read it from the log, rolled back to the previous release in 58 s, exited 5, and `nb status` reported the newest content as not served. A second `nb load` refused to retry the content |
| The same dataset with an `@context` of `{}` | GraphDB loaded it as no statements at all, and verification named the missing dataset (799 of 800 served); rolled back |
| `nb hold` | The API was dead 0.6 s after the command; `nb status` exited 3 and said `HOLD` |
| A change arriving while on hold | Staged, validated and published, not loaded, API left stopped |
| `nb unhold` with a staged release | Loaded first, the API started only after the graph held the new release: 52 s, deep check passed |
| `nb rollback` | Previous release live again in 57 s, loader frozen, a following `nb load` fetched nothing, `nb load --thaw` ended the freeze |
| Disaster recovery: backup, `nb down`, discard `data/` and `state/`, `nb restore`, `nb up` | Restored from the archive, up and verified in 43 s, 18 of 18 datasets served |
| Mass removal (800 datasets to 18) | Refused until `--allow-mass-removal` |
| `nb up` on a running node | Refused with exit 8 |
| A reload whose API was OOM-killed by the 384 MiB limit and a heap that refused the heaviest query | Found, and the limits and the verification query were changed (see the footprint section) |

Bugs these rehearsals found and fixed before the pull request: a manifest written empty after a `jq` argument-length failure on 800 datasets, a guard that died silently on a vanished one-off container, an unhold that could not restart a stopped API, a lock leaked by `exec`, a release name that collided when the same content was published twice in one second, and a Docker restart that waited out a 60 s kill timeout.

## Tests

`test/neurobagel-node-deploy.unit.test.ts` (run by `bun test`, and by CI when anything under `deploy/neurobagel` changes) runs the real scripts against real directories and a real HTTP server, and parses real captured output of the stock containers (`test/fixtures/neurobagel-node/`, provenance in `PROVENANCE.md`):

- the loader: first load, no-change run, one changed dataset, removal, sha256 mismatch, missing and truncated artifacts, seven shapes of malformed index plus an unreadable and an empty one, a non-dataset document, a duplicate identifier, mass removal, dry run, authentication
- atomic publication seen by a concurrent reader, the lock (two loaders, a stale lock, a live lock), freeze, known-bad content and its expiry
- seed, backup, restore (byte for byte, damaged archive, configuration kept), retention
- the log parsers against the stock containers' real first-start, upload-failure and initialiser output
- `docker compose config` of the overlay merged over the recipes file it pins: hard limits and no swap on every container, the 3 GiB ceiling, loopback ports that avoid 8080 and 3000, `NB_RETURN_AGG` fixed, profiles, restart policies and health checks (skipped, visibly, where Compose is absent)
- shellcheck over every script (skipped where shellcheck is absent)

What the tests do not reach is Docker itself.
The reload, status and guard commands drive containers, so they were exercised on nemaring; the measurements, the failure-injection run (a release GraphDB rejects, detected and rolled back), the hold and rollback drills and the restore rehearsal are recorded in the pull request.
