# Provenance of the fixtures in this directory

These feed `backend/test/neurobagel-verify.test.ts` and `neurobagel-verify-checks.test.ts` (epic #1586, Phase 6, the ADR 0067 amendment).
Every file is a real HTTP answer to a plain, unauthenticated GET, sent with the agent `nemar-neurobagel-dev/1.0`, TRIMMED to the fields the code reads and nothing else (the values are the real ones).
The sha256 below is of the trimmed file as committed.
What was dropped is everything the sweep never reads: for a release, the author, the notes (which name contributors) and the asset list, leaving `tag_name`; for a directory listing, everything but each entry's `path` and `sha`; for the federation's node directory, everything but `NodeName` and `ApiURL`; for its diagnoses, the vocabulary terms, leaving the `errors` entries.
The tests serve them from a real local HTTP server, and where a test needs a different state (an upstream that has moved, a registered node) it changes one value in a parsed copy and says so in the test.
Nothing here is hand-written, and nothing holds a credential.

| File | Source | Fetched (UTC) | sha256 |
| --- | --- | --- | --- |
| `github-release-api.json` | https://api.github.com/repos/neurobagel/api/releases/latest (tag `v0.11.0`, published 2026-09-14) | 2026-10-02 19:59 | `8ebef028b50269d37fce08f10643b8fb2e019c9f784a23b21584f55fb9d5ae76` |
| `github-release-federation-api.json` | https://api.github.com/repos/neurobagel/federation-api/releases/latest (tag `v0.10.0`, published 2026-09-14) | 2026-10-02 19:59 | `782a675156a56fd4e613e35b1c69a3eac84773974313eb6e83f03eba2d714aef` |
| `github-release-query-tool.json` | https://api.github.com/repos/neurobagel/query-tool/releases/latest (tag `v0.17.0`, published 2026-09-15) | 2026-10-02 19:59 | `4443872bca487826189fb21bf96560b7696dc98b9bad1846b316bae7e1316d46` |
| `github-contents-communities-configs.json` | https://api.github.com/repos/neurobagel/communities/contents/configs/Neurobagel?ref=main | 2026-10-02 19:59 | `1b908f4de06151662da89c4ff1b2e77bcaaa3ab479b8714dc144fd6ec7b0f81c` |
| `github-contents-communities-config-metadata.json` | https://api.github.com/repos/neurobagel/communities/contents/config_metadata?ref=main | 2026-10-02 19:59 | `39bc6b04067cd6fae8a782cf42daa715637ad0d5e9679421f32cab358a55d630` |
| `federation-nodes.json` | https://federate.neurobagel.org/nodes (HTTP 200) | 2026-10-02 19:59 | `657511b51040acf0776a0432793536558d6401fd406ec060682f9189acb40b09` |
| `federation-diagnoses.json` | https://federate.neurobagel.org/diagnoses (HTTP 207, because two other nodes did not answer: the body's `errors` array names them) | 2026-10-02 19:59 | `57ab4c6b5628ade67f25eeaeeac81cbd23288da097698e51e782823d4db82a1a` |

Two things these recordings fix that the code depends on.
The repository of the federation API is `federation-api`, with a hyphen, and a request for `federation_api` answers 404.
The federation answers `/diagnoses` with 207 when any node failed, so a verdict must read every 2xx answer and not only 200.

When they were fetched, the pinned release tags in `deploy/neurobagel/pins.env` and the blob hashes pinned in the vocabulary snapshot equalled upstream, so the real files describe a world with no drift.
NEMAR was not registered, so the real node directory does not list it.

The node's own answer to the empty datasets query, for the same tests, is `test/fixtures/neurobagel-node/node-datasets-goldens.json` (its provenance is in that directory).
