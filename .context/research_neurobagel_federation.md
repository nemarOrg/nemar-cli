# Research: Neurobagel federation node and viewer (input to #1586)

> Model-generated research (2026-10-02) with its own verified/inferred labels; not ground truth. Its Cloudflare hosting options and `on`-mirror exclusion are overridden by the epic design note. The architect's plan next to it records which claims were re-verified.

# Neurobagel node at NEMAR, and viewer embedding: research report

Produced by a Sonnet explore agent, probes dated 2026-10-02 (read-only GETs). MODEL OUTPUT, not ground truth. [V] = agent says it verified (cites file/URL), [I] = inference. The existing epic is nemarOrg/nemar-cli#349 (filed 2026-04-24, label P3, no comments, no sub-issues); read it with `gh api repos/nemarOrg/nemar-cli/issues/349 --jq .body`.

# A. Neurobagel node at NEMAR

## A0. Ambiguity
"Federate core" is ambiguous [I]: (i) run NEMAR's own node (n-API plus graph or catalog) and register it in the public federation, or (ii) run the f-API (federation API). The f-API is only needed for a private portal; the public one at query.neurobagel.org federates any node listed in the menu repo. The agent assumed (i).

## A1. Current upstream state [V, via gh api and neurobagel.org]
- Versions and licence: all repos MIT. bagel-cli v0.11.6 (2026-09-16); n-API v0.11.0 (2026-09-14), BREAKING: `/query` removed, AND-queries added; f-API v0.10.0; query-tool v0.17.0; recipes v0.9.1 (2026-06-04); annotation-tool v0.7.8; GraphDB image ontotext/graphdb:10.8.12 (recipes docker-compose.yml). GraphDB Free is proprietary: one core, two concurrent queries, five repos (Ontotext licensing docs, via search snippet only).
- Resources: Neurobagel docs publish no CPU/RAM/disk numbers. NB_GRAPH_MEMORY defaults to 2G. Linux only; Docker >= 20.10.24.
- Two exclusive node modes. Graph mode: subject-level, SPARQL over GraphDB. Catalog mode (NB_CATALOG_MODE; n-API 0.10.0, f-API 0.9.0, query-tool 0.16.0, bagel 0.11.5, recipes 0.9.0): dataset-level only; needs just a data dictionary plus a dataset description per dataset. In catalog mode the n-API answers /datasets from an in-memory dict; crud.py:341-388 returns [] if an imaging-modality, pipeline or session filter is used. So catalog mode CANNOT filter by EEG/MEG.
- Modality vocabulary: the imaging modality vocab has only `eeg` and `meg` for electrophysiology; NO `ieeg`, NO `emg` (communities configs/Neurobagel/imaging_modalities.json). `bagel bids2tsv` silently drops other suffixes. communities#70 (open) plans all BIDS suffixes. planning#377 (open) moves terms from `nidm:` to `bids:`, which will duplicate options on straggler nodes.
- Registration: open a PR adding {NodeName, ApiURL} to node_directory/neurobagel_public_nodes.json in neurobagel/menu; alternatively message the dev team on Discord. Eight nodes listed today. Most recent registration, menu PR #27 (PublicnEUro), opened 08-29, merged 08-31; only review recorded was Copilot's. No vetting criteria, conformance test or version handshake documented. api#511 "make API version discoverable" is open. Approver not shown by the API [I maintainers].
- Dataset card fields (bagel dataset_description_model.py, query-tool ExpandedDetails.tsx): Name, Authors, ReferencesAndLinks, Keywords, RepositoryURL, AccessInstructions, AccessType, AccessEmail, AccessLink. NO DOI field. The first valid URL in ReferencesAndLinks becomes the homepage icon. The card also shows an Access link button and a Repository button.
- Identifiers: bagel mints random uuid4 identifiers (bagel/models.py), so regeneration churns UUIDs unless artifacts are kept.

## A2. Delta against #349
| #349 claim | Status today | Evidence |
|---|---|---|
| nm000103-107 private, ship as `restricted` | Stale: public with DOIs | AGENTS.md:149-154; data.nemar.org/ lists them, published 2026-02-23 |
| Include private datasets for discoverability | Contradicted | ADR 0017; ADR 0065:108; ADR 0067:28; `nemarDatasets` is public-facing; the data plane 404s private datasets |
| bagel==0.11.4 | 0.11.6; n-API 0.11.0 breaking | releases |
| Traefik prod compose | Now proxy/node/portal profiles, nginx-proxy plus acme-companion, `configure-nb` wizard | neurobagel.org/user_guide/production_deployment |
| ~2 vCPU/4 GB/20 GB | Not in upstream docs | env-vars page |
| Quebec Parkinson precedent | Replaced by TOSI Neuro (menu #24, 2026-05-21) | menu PRs |
| EMG suffix unverified | Verified unsupported; iEEG too | vocab file; bids_utils.py |
| New since April | Catalog mode | n-API v0.10.0 |
| Clone repos, `ssh hallu` push | Out by owner decision; clones unnecessary | A3 |

## A3. What the data plane serves [VERIFIED live by the agent]
Hosts and paths:
- GET data.nemar.org/ returns a catalog index: 778 datasets (199 `nm`, 579 `on`, no `xx` and no `nm0999xx`).
- GET data.nemar.org/<id>/ landing page. GET data.nemar.org/<id>/<v|latest>/<bids-path> serves files. GET .../manifest.json. GET data.nemar.org/<id>/metadata.json (neuroschema 0.4.1). api.nemar.org/data/... is an alias. zarr.nemar.org serves stores only. (The docs/ repo checkout predates ADR 0066; the live docs page and probes are the reference.)
Which files are reachable by plain GET:
- Git-tracked files are brokered as 200 bytes (ADR 0066; routes/data.ts:803, 32 MB cap). Annexed ones answer 302 to a presigned S3 URL, so `curl -L` is needed.
- Across all 199 `nm` datasets: 187 serve participants.tsv, participants.json and dataset_description.json directly; 6 have no participants.json; 3 have no participants.tsv; 3 have both files annexed (302). ADR 0015 excludes tsv/json from the annex, but inherited .gitattributes and legacy imports break that (ADR 0060).
Manifest limits:
- manifest.json returns 413 above 30,000 entries (agent cites ADR 0072:60); nm000281 returned 413 live. (NOTE: another explorer cited 38,000 from routes/data.ts:487-523; ADR 0072/0074 say the bound is per branch. Verify which.)
- metadata.json still serves it. For nm000103 it is 124 KB. It carries name, authors, license, DOI, demographics{subjects_count, age_min, age_max}, datatypes, tasks, an `anonymous` boolean, and extensions.nemar.bids_index. The bids_index maps subject -> sessions -> datatype -> tasks -> runs. That is what `bagel bids2tsv` + `bagel bids` derive from a BIDS tree. For eeg/meg the datatype key equals the suffix. No pybids needed.

## A4. Transform inputs and annotation
Mechanical for every dataset:
- Dataset fields: Name, Authors (from metadata.json, not depositor files), license, Keywords, AccessType=public, AccessLink=https://nemar.org/dataset/<id>, ReferencesAndLinks[0] = the nemar.org URL, then the DOI.
- Participant id, age and sex (M/F maps to snomed:248153007/248152002; `n/a` is a missing value). `group` healthy/control maps to ncit:C94342. Modality and session availability from bids_index.
Coverage survey of the 193 directly readable participants.tsv files: age in 187; sex in 188; `group` in 148, of which 30 carry diagnosis-like free text (ICH, stroke, ALS, ASD, SCI, knee_pain and others); nearly all the rest are healthy/control/n/a. Assessment columns are rare (nm000103 HBN has p_factor and EHQ; nm000111 has Portuguese free-text diagnoses). Most files are one auto-generated schema (participant_id, age, sex, hand, weight, height, group, species, bci_experience). Needs curation: roughly 30 to 40 datasets. Lost entirely: HED, channel info, events, and iEEG/EMG modality until communities#70 lands. nm000104-107 and nm000281 are EMG.
Where curation can live: not in `datasets` (ADR 0034: budget pinned at 84, cap 97, backend/test/datasets-column-budget.test.ts:40). Best fit is a reviewed declarations file in the repo keyed by dataset id; ADR 0073 (eeglab-fdt-declarations.json) is the precedent [I]. Alternative: a backend-authored `.nemar/neurobagel.json` sidecar, which must follow ADR 0065's writer-side blind and never be written for anonymous deposits.

## A5. Where the transform runs
- T1, TypeScript port. Catalog mode needs no bagel port: about 200 lines (a dictionary with Levels and ValueRange{Min,Max} plus a description file). Graph-mode JSON-LD is about 800-1,200 lines (age formats, missing values, sessions, acquisitions). bagel is about 100 KB of Python, MIT, so a port is licence-clean. Use deterministic uuid5 to keep UUIDs stable. Edge-compatible, fits ADR 0050 (no Pyodide or wasm).
- T2, unmodified `bagel` in GitHub Actions. Dispatch like ADR 0020 (central workflow in nemarDatasets/.github, repository_dispatch, HMAC callback to the Worker); NOT the ADR 0029 hallu pattern. Reads the data plane over HTTPS and posts JSON-LD back through an authenticated admin route so CI holds no S3 credentials. bids2tsv needs a BIDS tree (pybids validate=True), so you would build a zero-byte skeleton from bids_index; whether pybids accepts it is untested [I]. Adds random UUIDs and Python 3.11+.
- T3, query-time transform. Not worthwhile; data changes only on publish, so precompute.
- Agent's pick: T1 for the catalog slice and a Workers node; T2 only if you want stock graph mode with a stock graph store.

## A6. Hosting options (edge only; hallu out)
1. Stock recipes on Cloudflare Containers. [V] GA since 2026-04-13. Max instance 4 vCPU/12 GiB/20 GB disk, linux/amd64. Disk ephemeral; snapshots (<=20 GB, 30 days) only with the durable_object policy; FUSE-to-R2 is slow; default sleep 10 minutes; cold start 1-3 s for small images; billing stops on sleep. One Durable Object per container; no docker-compose or inter-container networking found. The recipes' init_data runs `rm -rf /data/* && process_jsonld` on every start (docker-compose.yml:7-10), so GraphDB would rebuild on each cold start. The f-API gives instance endpoints a 5 s timeout (federation-api crud.get_instances, timeout=5). Verdict: the full GraphDB stack is not realistic. A stateless catalog-mode n-API container is feasible but lacks modality filtering [I]. n-API startup fetches vocabularies from GitHub and may need dummy graph credentials (untested).
2. Workers-native node API. Surface [V]: POST /datasets takes 9 filters (min_age, max_age, sex, diagnosis[], assessment[], image_modal[], pipeline[], and the two session counts); response is a list of 17-field records; num_matching_subjects may be null since f-API 0.9.0. POST /subjects can return the string "protected". GET /assessments, /diagnoses, /imaging-modalities, /pipelines, /pipelines/{term}/versions, each as { "nb:X": [{TermURL, Label}] }. The f-API validates each record with pydantic; a bad node shows as a per-node error (HTTP 207), not a global failure. Upstream broke the contract on 2026-09-14 and earlier for catalog mode, so a custom node must track releases. SPARQL is not needed for these semantics: upstream's own catalog mode is dict-filtering (utility.py:723-790). A compact per-dataset or per-participant index of about 2 MB gzipped fits an isolate. Put it in R2 or S3, not D1 (ADR 0034). The only R2 binding today is NEWS_MEDIA (backend/wrangler-sccn.toml:183), so a new bucket or the existing S3 plumbing is needed. Use metadata.json, never the manifest (ADR 0072). Effort [I]: about 700-1,000 lines for the node, plus transform and contract tests against a real f-API container (NO MOCK rule), roughly 3-5 weeks. Registration needs only the menu PR. No stated posture on third-party node implementations, no conformance suite. Ask in Discord or neurobagel/planning first. Offer an upstream PR adding dataset-level modality to catalog mode; the n-API code comment says those filters "may change in a future release".
3. nemaring.ucsd.edu, fallback only in the explorer's plan (owner override: it became the primary host; see the epic design note). Host specifics are recorded in the gated operations documentation, not in this repository.

## A7. Must never be federated
- Anonymous deposits. nm000284 is live today with anonymous:true, Authors ["Anonymous"], no DOI and no GitHub URL. Gate on `anonymous` from metadata.json, not on visibility (ADR 0065:108). Never construct a RepositoryURL (the website once reinvented it, website/src/pages/dataset/[id].astro:233). Do not copy depositor files, which NEMAR cannot blind (ADR 0067:28).
- Private or unpublished datasets, `xx` sandbox, `nm0999xx` fixtures (ADR 0068).
- `on` mirrors (579 of 778): Neurobagel already has an OpenNeuro node, so they would duplicate it.
- Keep NB_RETURN_AGG=true (the default). Catalog mode forces records_protected.

## A8. Ops and failure modes
Contract drift upstream (breaking releases, vocab namespace change); silent loss of modality for iEEG/EMG datasets; stale JSON after de-anonymization or a version bump; UUID churn; cold-start timeouts; a catalog mode with no modality filter is a weak discovery experience.

## A9. Verdict and smallest slice (agent's)
Feasible at low cost for dataset-level discovery. Cohort-level discovery by modality needs either a custom node or an upstream catalog-mode PR. Smallest slice: (1) script a T1 transform over public non-anonymous `nm` datasets only, emitting *_annotated.json and *_dataset_description.json from metadata.json and participants.json; (2) validate locally with stock recipes in catalog mode for about 5 datasets; (3) then a stateless catalog-mode container on Cloudflare Containers; (4) then the menu PR; (5) decide custom node versus upstream PR afterwards. This slice tests registration, card rendering and link-back first.
The six #349 decisions restated by the agent: hosting = the edge (owner), nemaring fallback; mirror org = no, publish artifacts from the Worker; annotation = mechanical plus a reviewed file, no GitHub App or PRs; LLM provider moot for v1 (curation time only, human review; provider the enrichment pipeline uses not verified); private datasets = reverse the recommendation, exclude private and anonymous; review = keep human review as a reviewed repo file.

# B. Viewer and Neurobagel

## B1. Verified facts
- Framework: Astro 6 SSR islands on Cloudflare Pages (website ADR 0001). The viewer lives inside /dataset/[id] (src/pages/dataset/[id].astro, 2,654 lines).
- Mount API: mountEegViewer(slot, {datasetId, version, filePath, zarrToken}) at src/lib/eeg-viewer/viewer.ts:385. package.json is "private": true. No embed route and no postMessage anywhere in src.
- Data reads: zarrita reads zarr.nemar.org/<id>/zarr/<bids-path>.zarr/ and index.json (src/lib/zarr-base.ts). Annotations are IndexedDB only (website ADR 0013).
- The viewer-phase4-hed worktree is the same viewer on an older base, with three HED-vocab files differing.
- Deep links today: https://nemar.org/dataset/<id>?v=<version>&view=<BIDS entities>. `view` takes sub-01_task-rest_run-1, a filename or a path; tolerates leading zeros; capped at 256 characters (recording-nav.ts:311-356). Built for EBRAINS (website#326, recording-nav.ts:303). The viewer reads only `v` and `view`; no channel, time-window or montage parameter.
- Headers (live, plus website/src/middleware.ts:209,234): `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` on nemar.org and /dataset/*. /dataset/* adds 'unsafe-eval' (website ADR 0009). The data host also sends XFO SAMEORIGIN.
- CORS: zarr.nemar.org returns Access-Control-Allow-Origin only for nemar.org-family and osc.earth origins (backend/src/services/cors-origins.ts:87, routes/zarr-data.ts:75). https://example.com got none. data.nemar.org metadata files returned `*` for a neurobagel.org origin. Allowlisted-origin requests are proxied by the Worker; others are redirected to S3 (zarr-data.ts:2-30; ADR 0049:88-91).
- Query tool: a React SPA on GitHub Pages, so Neurobagel cannot set headers there. Result cards have only Homepage, Access link and Repository hrefs. No viewer field, no iframe slot, no templating.

## B2. Stance
Per the owner: link out, do not transplant.

## B3. Tiers
(a) Link-out: Neurobagel does nothing new. NEMAR sets ReferencesAndLinks[0] to the nemar.org dataset URL and the DOI second. The data model carries dataset-level links only, so a per-recording ?view= is not expressible without a Neurobagel change. Versioned links use ?v= plus the DOI. NEMAR bears the bandwidth; nemar.org is already allowlisted. Anonymous pages already render a withheld-author notice.
(b) Iframe: NEMAR ships an embed-only route with a route-scoped CSP allowing `frame-ancestors https://query.neurobagel.org` (or the chosen origin) and dropping X-Frame-Options on that route only; contentSecurityPolicy(pathname) is already per-path. Needs no site-wide OSA widget, branding and an "Open on nemar.org" link. Origin-allowlist cost is zero (executing origin is still nemar.org; bytes follow the existing proxied path, borne by NEMAR). Neurobagel must add an iframe slot to ExpandedDetails.tsx and a per-dataset or per-node viewer URL field; that crosses four repos: bagel dataset model, recipes init_data, n-API and f-API response models, and query-tool (the f-API drops unknown fields). No postMessage API exists; if added keep it minimal and verify event.origin both ways. Storage partitioning likely isolates annotation IndexedDB inside the iframe [I].
(c) Web component or npm package: NEMAR extracts eeg-viewer from page-entangled code into a versioned package and owns semver and security updates. The host page must allow 'unsafe-eval' and 'wasm-unsafe-eval' (website ADR 0009), a large ask. The executing origin becomes Neurobagel's; it must be added to the zarr allowlist (bytes go through the Worker) and S3 CORS; NEMAR decides per origin (ADR 0049). Branding hard to enforce. Not recommended; it matches the transplant the owner declined.
Cross-tier: the viewer must never surface recording-header text for anonymous datasets (ADR 0067 lists signal_headers as permanently `unchecked`). NEMAR never proxies bulk bytes (.memory/never-proxy-bulk-bytes.md).

## B4. "dot ath" is ambiguous (confirm with owner)
1. "dataset path / data path": a per-dataset viewer or browse URL; lands in bagel dataset model, recipes init_data, n-API DatasetQueryResponse, f-API DatasetsQueryResponse, query-tool DatasetsResult and ExpandedDetails.tsx. No-code stand-in today: AccessLink or RepositoryURL.
2. A dotted or JSON path in a config key: a node-level NB_VIEWER_URL_TEMPLATE in recipes template.env, surfaced via the "node info discoverable" work (api#511).
3. "auth" (mis-heard): Neurobagel's experimental NB_ENABLE_AUTH OAuth. Nothing to add; public viewing needs no auth.
4. A hidden dot-dir on NEMAR's side: a .nemar/neurobagel.json sidecar written by NEMAR.
5. A URL path suffix: a link template with {dataset_id}, {version}, {sub}, {task} placeholders appended to AccessLink.

# Open questions the explorer raised
1. What does "federate core" mean: join the public federation, or run the f-API?
2. What does "dot ath" mean (B4)?
3. Is a catalog-mode first slice acceptable, given it has no modality filter?
4. Should the `on` mirrors be excluded because OpenNeuro is already federated?
5. Is excluding anonymous deposits until de-anonymization acceptable?
6. Where should curated annotations live: reviewed repo file or .nemar/ sidecar?
7. Do you want an upstream PR for dataset-level modality in catalog mode?

# Unresolved
GraphDB Free licence limits (search snippet only); whether the catalog-mode n-API runs without a live graph (not run); whether pybids accepts zero-byte skeleton trees (not run); docker-compose and inter-container support on Cloudflare Containers (FAQ silent); approver identity for menu PRs (API shows merged_by: none); whether any third-party node implementation exists (none found); docs.nemar.org systems-inventory is gated; which LLM provider the enrichment pipeline uses; whether OSA's widget is still live site-wide.
