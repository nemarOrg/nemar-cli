# ADR 0082: The Neurobagel node runs stock on nemaring under hard resource limits and is fed by pull

**Status:** accepted
**Date:** 2026-10-02
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1586 puts NEMAR's records into Neurobagel's federated search.
The owner decided that the node is Neurobagel's own, unmodified stack
(the `neurobagel/recipes` compose project in graph mode:
GraphDB, node API, federation API, query tool) on `nemaring.ucsd.edu`.
It is not a Workers implementation of the node API and not Cloudflare Containers.

`nemaring` is shared.
It runs Infisical, the organisation's secrets store, and Umami, with their Postgres, Redis and `cloudflared` containers.
The Infisical backend and database have no memory limit, so a runaway process on the host is a risk to the secrets store.
The host has 8 CPUs, 7.7 GiB of RAM (about 5.3 GiB available when measured), and 23 GB of disk.

Three properties of the stock stack shape the decision (verified at recipes v0.9.1, node API v0.11.0, GraphDB 10.8.12):

- The graph is derived data.
  On every start of the init and graph containers recipes wipes the `/data` volume and the whole graph and loads everything again.
- The node API reads `datasets_metadata.json` once, at start.
  A new release is therefore not live until the API restarts, and it needs GitHub at start to fetch its vocabularies.
- GraphDB Free is licensed for one CPU core (its startup log says `Max CPU cores: 1`).
  The documentation says one query at a time in one table and two in the prose.
  Measured: queries run one at a time.
  It also refuses any group-by or distinct query while less than 250 MB of heap is free.

Measured on `nemaring` on 2026-10-01 and 2026-10-02, with the shipped limits (graph 2048 MiB with a 1.5 GiB heap, API 512 MiB, federation API 128 MiB, query tool 64 MiB):

| Scale | Statements | Reload | Graph peak | Dataset query |
| --- | --- | --- | --- | --- |
| 18 real datasets (Phase 1 goldens), 1,011 subjects | 14,811 | 58 s from a small graph, 83 s from the 50,105-subject one | 1.6 GiB | agrees with ground truth |
| 800 synthetic datasets, 50,105 subjects, shape of a NEMAR record | 879,201 | 3.5 to 4 minutes | 1.9 GiB | 2.0 s |
| 800 synthetic datasets, 50,105 subjects, four times the density | 3,564,819 | 5 minutes | 1.6 GiB | 7 s |

Idle, loaded with 50,105 subjects: graph 1.35 to 1.66 GiB, API 104 to 218 MiB, federation API 43 to 62 MiB, query tool 8 to 9 MiB; across the whole trial host available memory never fell below 3.3 GiB, the load average never passed 3.1, and none of the seven existing containers restarted.
Any change, one dataset or eight hundred, costs one full reload, during which the node answers with partial or no results.

## Decision

The node is one Docker Compose project, `nemar-neurobagel`, that is recipes at a pinned tag with a thin overlay and nothing copied.
The overlay is `deploy/neurobagel/docker-compose.nemar.yml`; versions are pinned by tag and image digest in `pins.env`.

- **Hard limits.**
  Every container has `mem_limit` equal to `memswap_limit` and a CPU limit.
  The stack's limits sum to 2880 MiB with the tunnel connector, under a 3 GiB ceiling.
  If host memory available falls below 1.5 GiB, the guard stops this project and nothing else.
- **No inbound access.**
  Published ports are loopback-only (18000, 18080, 13000; 8080 and 3000 belong to Infisical and Umami), and GraphDB publishes none.
  Exposure is a Cloudflare Tunnel hostname that maps to the node API only, enabled by the lead after approval.
- **Pull, never push.**
  A loader on the host fetches an index and the changed artifacts from the private store, verifies every file, assembles a complete release directory, validates it with the stock initialiser, and swaps one symlink.
  The producer's only obligation is the index interface documented in `deploy/neurobagel/README.md`.
- **Reload is a deliberate operation.**
  It takes a lock, checks memory first, runs the stock init and graph start, restarts the API, verifies that the node serves exactly the release and only protected records, measures every phase, and rolls back to the previous release on any failure.
  `NB_RETURN_AGG=true` is fixed in the overlay and verified on every reload.
- **Taking the node out of the federation is stopping the API container**,
  recorded as a hold flag so that no scheduled run brings it back.
- **Nothing existing on the host is touched.**
  The project name, network and volumes are its own, and every script names the project.
  Secrets are generated on the host into a mode 700 directory and a mode 600 `.env`, the pattern the other projects follow, and are never in git.

How this fits ADR 0025 and ADR 0080: those ADRs say `nemaring` hosts other services and is not an executor, and keep it for genuinely stateful services.
The Neurobagel node is a stateful service, a graph store with a data volume, which is that category.
It executes nothing for the platform: no dispatch from the Worker, no job, no push, and no inbound path.
Its only act is reading artifacts the platform has already published.

## Consequences

- The node's behaviour is Neurobagel's by construction, so contract conformance is not NEMAR's to prove.
  The cost is that NEMAR inherits stock limits: full reload on any change, one query at a time, and heap refusals when the heap is too small.
- The full reload is the number to plan around.
  The loader runs on a schedule but reloads only when the index changed, and a reload is refused while the host is short of memory.
  If the reload window becomes unacceptable the next step is an incremental update path (delete one dataset's statements, upload its file), which departs from stock and is not built.
- A GraphDB heap of 1.5 GiB serves every dataset-level query at 50,105 subjects but refuses the unrestricted subject-level query part of the time.
  A 2 GiB heap refused nothing but needs a 2560 MiB limit and a 512 MiB API, 3.3 GiB in all, which is over the budget and is the lead's call.
- The disk cost is about 5.1 GB of images, a graph repository of 130 to 500 MB that keeps its high-water mark, and a few releases of tens of megabytes.
- Upgrading recipes, an image, or GraphDB is a pull request that changes `pins.env`, with the trial repeated.

## Alternatives considered

- **Cloudflare Containers.** No persistent disk, and recipes wipes and reloads on every start, so every cold start would be a full reload, with GitHub fetched each time.
- **A Workers-native node.** Re-implements the node API contract, so conformance, upstream drift and a malformed record taking down federated queries (federation API `model_validate` with no `try`) become NEMAR's burden.
  The stock node removes that class of risk.
- **Catalog mode on the stock API.** Returns no datasets for any imaging-modality filter, which makes NEMAR invisible to the filter users start with.
- **Push over ssh.** Needs inbound access to the host that holds the secrets store.
- **Joining the Infisical or Umami compose project.** Couples lifecycles and widens the blast radius for no benefit.
- **GraphDB Enterprise.** Licensed per core, and not needed at this scale.

## Receipts

- Epic #1586, phase issue #1589, ADR 0025 and ADR 0080.
- `deploy/neurobagel/README.md`: runbook, interface, and the measured footprint in full.
- `deploy/neurobagel/docker-compose.nemar.yml`, `pins.env`, `bin/`.
- Neurobagel recipes v0.9.1, node API v0.11.0, federation API v0.10.0, query tool v0.17.0, GraphDB 10.8.12 (Docker Hub and GitHub releases, 2026-10-01).
- GraphDB licensing and memory documentation: `graphdb.ontotext.com/documentation/10.8/licensing.html` and `configuring-graphdb-memory.html`.
