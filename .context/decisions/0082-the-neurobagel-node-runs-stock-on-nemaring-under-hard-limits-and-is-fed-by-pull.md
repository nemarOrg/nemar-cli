# ADR 0082: The Neurobagel node runs stock on nemaring under hard resource limits and is fed by pull

**Status:** accepted
**Date:** 2026-10-02
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1586 puts NEMAR's records into Neurobagel's federated search.
The owner decided that the node is Neurobagel's own, unmodified stack
(the `neurobagel/recipes` compose project in graph mode:
GraphDB, node API, federation API, query tool) on the NEMAR application host, `nemaring`.
It is not a Workers implementation of the node API and not Cloudflare Containers.

The host also runs other long-lived services, including the organisation's secrets store.
So the node runs under hard limits: a fault in it must cost the node, never those services.
What the host runs, and how much room it has, is operations documentation (gated), not part of this record.

Three properties of the stock stack shape the decision (verified at recipes v0.9.1, node API v0.11.0, GraphDB 10.8.12):

- The graph is derived data.
  On every start of the init and graph containers recipes wipes the `/data` volume and the whole graph and loads everything again.
- The node API reads `datasets_metadata.json` once, at start.
  A new release is therefore not live until the API restarts, and it needs GitHub at start to fetch its vocabularies.
- GraphDB Free is licensed for one CPU core (its startup log says `Max CPU cores: 1`).
  The documentation says one query at a time in one table and two in the prose.
  Measured: queries run one at a time.
  It also refuses any group-by or distinct query while less than 250 MB of heap is free.

Measured on the deployment host on 2026-10-01 and 2026-10-02, with the shipped limits (graph 2048 MiB with a 1.5 GiB heap, API 512 MiB, federation API 128 MiB, query tool 64 MiB):

| Scale | Statements | Reload | Graph peak | Dataset query |
| --- | --- | --- | --- | --- |
| 18 real datasets (Phase 1 goldens), 1,011 subjects | 14,811 | 58 s from a small graph, 83 s from the 50,105-subject one | 1.6 GiB | agrees with ground truth |
| 800 synthetic datasets, 50,105 subjects, shape of a NEMAR record | 879,201 | 3.5 to 4 minutes | 1.9 GiB | 2.0 s |
| 800 synthetic datasets, 50,105 subjects, four times the density | 3,564,819 | 5 minutes | 1.6 GiB | 7 s |

Idle, loaded with 50,105 subjects and measured 150 seconds after a reload: graph 1.35 GiB, API 104 MiB, federation API 62 MiB, query tool 8 MiB.
No other container on the host restarted or became unhealthy during any measurement.
The full tables, including peaks per scale, are in `deploy/neurobagel/README.md`.
Any change, one dataset or eight hundred, costs one full reload.
The node's API is stopped for the load window (about 175 seconds at 50,105 subjects), so a federated query meets an error from this node instead of partial results.

## Decision

The node is one Docker Compose project, `nemar-neurobagel`, that is recipes at a pinned tag with a thin overlay and nothing copied.
The overlay is `deploy/neurobagel/docker-compose.nemar.yml`; versions are pinned by tag and image digest in `pins.env`.

- **Hard limits.**
  Every container has `mem_limit` equal to `memswap_limit`, a CPU limit, a low `cpu_shares` and an `oom_score_adj` of 500, so the node is the first thing the kernel sacrifices and the first to yield CPU.
  The stack's limits sum to 2880 MiB with the tunnel connector, under a 3 GiB ceiling.
  If host memory available falls below 1.5 GiB, the guard stops this project and nothing else, and the stop is visible: `nb status` reports it and exits non-zero until the operator starts the node again.
- **No inbound access.**
  Published ports are loopback-only, and GraphDB publishes none.
  Exposure is a Cloudflare Tunnel hostname that maps to the node API only, through a connector on a network that holds nothing else, enabled by the lead after approval.
  It is not enabled.
- **Pull, never push.**
  A loader on the host fetches an index and the changed artifacts from the private store, verifies every file against the index and against caps on size and count, assembles a complete release directory, validates it with the stock initialiser, and swaps one symlink.
  The producer's only obligation is the index interface in `deploy/neurobagel/index.schema.json`, explained in `deploy/neurobagel/README.md`.
  The loader, the index builder, the synthetic generator and the README example all take their constants from that one file, and a test fails on drift.
- **Reload is a deliberate operation.**
  It takes a lock, checks memory first, stops the API for the load window, runs the stock init and graph start, restarts the API, verifies that the node serves exactly the release and only protected records, and measures every phase.
  On any failure it returns to the last release that was loaded and verified, not merely the last one published.
  A hold wins over a reload in progress.
  `NB_RETURN_AGG=true` is fixed in the overlay and verified on every reload.
- **Taking the node out of the federation is stopping the API container**,
  recorded as a hold flag so that no scheduled run brings it back.
- **Nothing is silent.**
  A failed reload, a failed load, a frozen or stale loader (no successful run for two hours, where a run that finds nothing to do counts), a stale guard heartbeat and a guard abort are each a problem that `nb status` reports with a non-zero exit.
- **The cell-size floor is zero, on purpose.**
  `NB_MIN_CELL_SIZE` is set explicitly to 0 (the stock value) because every federated dataset is public.
  It must be raised before any non-public dataset is ever federated.
- **Nothing existing on the host is touched.**
  The project name, network and volumes are its own, and every script names the project.
  The GraphDB passwords are generated on the host at first install into a mode 700 directory and a mode 600 `.env`, and are never in git.
  NEMAR has no shared pattern for secrets of this kind, so this one is stated here rather than borrowed.
- **Scheduling is not part of this change.**
  `nb cron-line` prints the crontab entries, and none is installed: loads run when a person runs them, and the guard watcher is started by hand and supervised only by its heartbeat check.
  Installing the entries is a separate decision for the owner.

**Principle.**
Compute does not run on NEMAR's servers for users (ADR 0049), and the application host is not an executor for the platform (ADR 0080 says it "hosts other services and stays that way").
This decision adds a rule of its own: the host may run a long-lived, stateful service that only reads artifacts the platform has already published, provided that service executes nothing on the platform's behalf, receives no push and no dispatch, has no inbound path of its own, and runs under hard limits.
The Neurobagel node is that kind of service: a graph store with a data volume, whose only act is reading a private index.
A service that needs more than that (a job runner, a deploy target, a push receiver) is a different decision and needs its own record.

## Consequences

- The node's behaviour is Neurobagel's by construction, so contract conformance is not NEMAR's to prove.
  The cost is that NEMAR inherits stock limits: full reload on any change, one query at a time, and heap refusals when the heap is too small.
- The full reload is the number to plan around.
  The loader polls (every 20 minutes in the printed entry) but reloads only when the index changed, and a reload is refused while the host is short of memory.
  Removal latency, from the index no longer naming a dataset to the node no longer serving it, is the poll interval plus the reload: at most about 25 minutes at 50,000 subjects, and `nb hold` is the answer when that is too slow.
  If the reload window becomes unacceptable the next step is an incremental update path (delete one dataset's statements, upload its file), which departs from stock and is not built.
- A GraphDB heap of 1.5 GiB serves every dataset-level query at 50,105 subjects but refuses the unrestricted subject-level query part of the time.
  A 2 GiB heap refused nothing but needs a 2560 MiB limit and a 512 MiB API, 3.3 GiB in all, which is over the budget and is the lead's call.
- The disk cost is about 5.1 GB of images, a graph repository that was 74 MiB at 7,190 subjects and 132 MiB at 50,105 subjects but keeps its high-water mark (up to 768 MiB after the densest trial), and a few releases of tens of megabytes.
  Backups share the node's disk; an optional hook copies them off the host.
- The node holds no credential for the private store beyond an optional header file the operator provides, mode 600, which the loader hands to curl by file so it appears in no process listing.
- Upgrading recipes, an image, or GraphDB is a pull request that changes `pins.env`, with the trial repeated.

## Alternatives considered

- **Cloudflare Containers.** No persistent disk, and recipes wipes and reloads on every start, so every cold start would be a full reload, with GitHub fetched each time.
- **A Workers-native node.** Re-implements the node API contract, so conformance, upstream drift and a malformed record taking down federated queries (federation API `model_validate` with no `try`) become NEMAR's burden.
  The stock node removes that class of risk.
- **Catalog mode on the stock API.** Returns no datasets for any imaging-modality filter, which makes NEMAR invisible to the filter users start with.
- **Push over ssh.** Needs inbound access to a host that runs other long-lived services.
- **Joining another compose project on the host.** Couples lifecycles and widens the blast radius for no benefit.
- **GraphDB Enterprise.** Licensed per core, and not needed at this scale.

## Receipts

- Epic #1586, phase issue #1589, ADR 0049 and ADR 0080.
- `deploy/neurobagel/README.md`: runbook, interface, and the measured footprint in full.
- `deploy/neurobagel/index.schema.json`, `docker-compose.nemar.yml`, `pins.env`, `bin/`.
- Neurobagel recipes v0.9.1, node API v0.11.0, federation API v0.10.0, query tool v0.17.0, GraphDB 10.8.12 (Docker Hub and GitHub releases, 2026-10-01).
- GraphDB licensing and memory documentation: `graphdb.ontotext.com/documentation/10.8/licensing.html` and `configuring-graphdb-memory.html`.
