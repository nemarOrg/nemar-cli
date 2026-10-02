# Provenance of the fixtures in this directory

These feed `test/neurobagel-node-deploy.unit.test.ts` (epic #1586, Phase 3, ADR 0082).
Every file is real output or a real upstream file; none is hand-written.
The captured outputs are `.txt` because the repository ignores `*.log`, so they are added with `git add -f`.
All captures come from the trial stack on the deployment host, with the stock images pinned in `deploy/neurobagel/pins.env`, and hold no credential.

| File | Source | Captured | sha256 |
| --- | --- | --- | --- |
| `example_synthetic_pheno-bids-derivatives.jsonld` | `neurobagel/recipes` tag `v0.9.1` (commit `9f8db034c9586abbd8c91c4c1216928ceedec312`), `data/example_synthetic_pheno-bids-derivatives.jsonld`, https://raw.githubusercontent.com/neurobagel/recipes/v0.9.1/data/example_synthetic_pheno-bids-derivatives.jsonld | 2026-10-01 | `863ab09e08571ec4cb43c9237ab3e15a5b86823aaf9da1b4c174cd81cd842bd8` |
| `recipes-v0.9.1-docker-compose.yml` | the same tag, `docker-compose.yml` | 2026-10-01 | `52c1ec74b7a89707f6d8138c7e8a97ecd5f5eea0129f93f004eaed69e508dc6f` |
| `graph-setup-first-start.txt` | the stock GraphDB setup script's own log (`scripts/logs/DEPLOY.log`, first 84 lines) from the first start of the stack with GraphDB 10.8.12 | 2026-10-02 05:11 UTC | `d12940955840a9e961d499ea679cf8bd61dce2bfd18f10ae18f0cf8680a61f34` |
| `graph-setup-upload-failure.txt` | the graph container's own output for one start of a release in which `nm000132.jsonld` carried a JSON-LD `@context` that GraphDB rejects (`{"@version": 9}`). The stock upload script printed `MALFORMED DATA: Could not parse JSON-LD` and `ERROR: Upload failed for these files:` and still exited 0. GraphDB's own log lines and stack traces are filtered out; every line of the stock scripts' output is kept | 2026-10-02 07:01 UTC | `5ec4f9803a77e1f1db4c30db0193db23ada760b1a142d2e69c45d20f72a0aaad` |
| `init-all-accepted.txt` | the stock initialiser's output (`python -m init_data.process_jsonld`, recipes v0.9.1 image build) for 18 real dataset documents | 2026-10-02 07:02 UTC | `321f4a0384de0b13ad096fd1b13cc0cf4c0de4a34fff4f9df89c574e65962845` |
| `init-one-rejected.txt` | the same initialiser on four documents, one with `hasAccessType` set to a value outside the vocabulary: it logs the skip, reports `3/4`, and exits 0 | 2026-10-02 07:02 UTC | `358bec4573bb3d983357ba4e2da93f58af43855d0485ef1a4f21d168afe49b2d` |
| `node-datasets-goldens.json` | the node API's own answer to `POST /datasets` with the empty query, from the node holding the 21 Phase 1 goldens (`test/neurobagel/golden/`): the body of the HTTP 200 response, unedited | 2026-10-02 08:49 UTC | `a8bed3236c2be99df4be07ccb2470f49d13c2c1ee8c95448ad630091f4855ad5` |
| `node-subjects-protected.json` | the node API's answer to a `POST /subjects` query scoped to one dataset, from the shipped node (`NB_RETURN_AGG=true`): `subject_data` is the string `protected` | 2026-10-02 08:49 UTC | `6fbba4f35843f922fb0e92c3cfacfe150c68e62d86631cef2147b59da15af3ea` |
| `node-subjects-unprotected.json` | the same query answered by a node API of the pinned version run with `NB_RETURN_AGG=false` over the same graph, which returns participant rows. It exists to prove that verification fails on such a node | 2026-10-02 08:49 UTC | `139fd100d107ddacd9c1b30bbd1b8003881bddeded5be587110391a936a89bad` |
| `guard-state-before.txt` | the guard's per-container state lines (name, start time, restart count, health, state, tab separated) for the node's four containers, in the form `bin/nb-guard` reads from `docker inspect`. Container names are shortened to `svc-<service>` | 2026-10-02 08:49 UTC | `6b7bc022ab26c095d7bd4198203b3de34a0cae566d9cc0bc81efcaf67eb0000a` |
| `guard-state-after-restart.txt` | the same lines after `query_federation` was restarted for real: its start time changed and nothing else did | 2026-10-02 08:49 UTC | `69d49867c2102ffc615deeed39b06681afb153eb251de6dc8333c86d8edaae17` |

The 18 documents behind the two initialiser logs, and the 21 behind the node answers, are the Phase 1 goldens, copied unchanged.
The loader tests do not need them: they rewrite the identifier and label of the example document to make as many distinct, valid datasets as a test needs, and say so in the test.
