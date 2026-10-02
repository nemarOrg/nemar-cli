# Provenance of the fixtures in this directory

These feed `test/neurobagel-node-deploy.unit.test.ts` (epic #1586, Phase 3, ADR 0082).
Every file is real output or a real upstream file; none is hand-written.

| File | Source | Fetched | sha256 |
| --- | --- | --- | --- |
| `example_synthetic_pheno-bids-derivatives.jsonld` | `neurobagel/recipes` tag `v0.9.1` (commit `9f8db034c9586abbd8c91c4c1216928ceedec312`), `data/example_synthetic_pheno-bids-derivatives.jsonld`, https://raw.githubusercontent.com/neurobagel/recipes/v0.9.1/data/example_synthetic_pheno-bids-derivatives.jsonld | 2026-10-01 | `863ab09e08571ec4cb43c9237ab3e15a5b86823aaf9da1b4c174cd81cd842bd8` |
| `recipes-v0.9.1-docker-compose.yml` | the same tag, `docker-compose.yml` | 2026-10-01 | `52c1ec74b7a89707f6d8138c7e8a97ecd5f5eea0129f93f004eaed69e508dc6f` |
| `graph-setup-first-start.log` | the stock GraphDB setup script's own log (`scripts/logs/DEPLOY.log`, first 84 lines) from the first start of the stack on `nemaring` with GraphDB 10.8.12, 2026-10-02 05:11 UTC. Holds no credential. | 2026-10-02 | recorded in git |
| `graph-setup-upload-failure.log` | the graph container's own output on `nemaring` for one start (2026-10-02 07:01:52 UTC) of a release in which `nm000132.jsonld` carried a JSON-LD `@context` that GraphDB rejects (`{"@version": 9}`). The stock upload script printed `MALFORMED DATA: Could not parse JSON-LD` and `ERROR: Upload failed for these files:` and still exited 0. GraphDB's own log lines and stack traces are filtered out; every line of the stock scripts' output is kept. | 2026-10-02 | recorded in git |
| `init-all-accepted.log` | the stock initialiser's output (`python -m init_data.process_jsonld`, recipes v0.9.1 image build) for 18 real dataset documents, from `nemaring`, 2026-10-02 07:02 UTC | 2026-10-02 | recorded in git |
| `init-one-rejected.log` | the same initialiser on four documents, one with `hasAccessType` set to a value outside the vocabulary: it logs the skip, reports `3/4`, and exits 0 | 2026-10-02 | recorded in git |

The 18 documents behind the two initialiser logs are the Phase 1 goldens (`test/neurobagel/golden/`, PR #1598), copied unchanged.
The loader tests do not need them: they rewrite the identifier and label of the example document to make as many distinct, valid datasets as a test needs, and say so in the test.
