# Provenance of the fixtures in this directory

These feed `backend/test/neurobagel-verify.test.ts` and `neurobagel-verify-checks.test.ts` (epic #1586, Phase 6, the ADR 0067 amendment).
Every file is the unedited body of a real HTTP answer to a plain, unauthenticated GET, sent with the agent `nemar-neurobagel-dev/1.0`.
The tests serve them from a real local HTTP server, and where a test needs a different state (an upstream that has moved, a node that is registered) it changes one value in a parsed copy and says so in the test.
Nothing here is hand-written, and nothing holds a credential.

| File | Source | Fetched (UTC) | sha256 |
| --- | --- | --- | --- |
| `github-release-api.json` | https://api.github.com/repos/neurobagel/api/releases/latest (tag `v0.11.0`, published 2026-09-14) | 2026-10-02 19:59 | `1aa6bc2cc6396ee5b51269f08a8028e06fe19853f20e5f0d83c93fa0b39c2b7d` |
| `github-release-federation-api.json` | https://api.github.com/repos/neurobagel/federation-api/releases/latest (tag `v0.10.0`, published 2026-09-14) | 2026-10-02 19:59 | `29145f6ced74da79b2fede0065f5c62dc79da1027f7bb7788f5b506262b29ea6` |
| `github-release-query-tool.json` | https://api.github.com/repos/neurobagel/query-tool/releases/latest (tag `v0.17.0`, published 2026-09-15) | 2026-10-02 19:59 | `4abe4cabf596445e4611d874b9927149e9615a37fd00543e7fb0a25a98159db0` |
| `github-contents-communities-configs.json` | https://api.github.com/repos/neurobagel/communities/contents/configs/Neurobagel?ref=main | 2026-10-02 19:59 | `e9ade6a6a60d3f7f4e677d8e1525f0699504f9a26478966db5050e7d7d797b1b` |
| `github-contents-communities-config-metadata.json` | https://api.github.com/repos/neurobagel/communities/contents/config_metadata?ref=main | 2026-10-02 19:59 | `5488776a156011ef8f586f4f90f8487c2393703267983841e205d71aee8daaf9` |
| `federation-nodes.json` | https://federate.neurobagel.org/nodes (HTTP 200) | 2026-10-02 19:59 | `f7ae2dfa1bf263419f45923af9b9d1b9f0e5362ac2102139eaee493da475c49d` |
| `federation-diagnoses.json` | https://federate.neurobagel.org/diagnoses (HTTP 207, because two other nodes did not answer: the body's `errors` array names them) | 2026-10-02 19:59 | `0424083b3d52db74f57fd0d71e802a5b56ada6721534d2bd46cf6852d40eb32c` |

Two things these recordings fix that the code depends on.
The repository of the federation API is `federation-api`, with a hyphen, and a request for `federation_api` answers 404.
The federation answers `/diagnoses` with 207 when any node failed, so a verdict must read every 2xx answer and not only 200.

When they were fetched, the pinned release tags in `deploy/neurobagel/pins.env` and the blob hashes pinned in the vocabulary snapshot equalled upstream, so the real files describe a world with no drift.
NEMAR was not registered, so the real node directory does not list it.

The node's own answer to the empty datasets query, for the same tests, is `test/fixtures/neurobagel-node/node-datasets-goldens.json` (its provenance is in that directory).
