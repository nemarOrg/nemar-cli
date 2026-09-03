# Making NEMAR Datasets Findable and Usable by AI Agents — Research Memo

**Date:** 2026-09-03
**Scope:** nemar.org, data.nemar.org, docs.nemar.org, api.nemar.org, zarr.nemar.org

## Executive summary

The evidence splits into two tiers. Mechanisms riding on infrastructure AI crawlers already fetch and parse — server-rendered schema.org JSON-LD (already shipped), an explicit robots.txt naming every AI crawler token, sitemap.xml with accurate `lastmod`, DataCite/DOI content negotiation, registration in re3data/FAIRsharing/Wikidata — have citable evidence of use by search engines, AI-answer products, and scholarly infrastructure. Advocacy-driven mechanisms — `llms.txt`, a website-root `AGENTS.md` for crawler discovery, markdown negotiation as an AI-uptake play — have **no vendor confirmation of use, and for `llms.txt` an on-the-record denial from Google**. NEMAR's highest-leverage moves: a named-bot robots.txt, a sitemap with real `lastmod`, an OpenAPI document, and re3data/FAIRsharing/Wikidata registration. `llms.txt` and markdown mirrors are cheap no-regret additions, not findability bets; Croissant and a bespoke MCP server should wait for demand.

## 1. How agent products actually find web content

**Verdict:** Every major AI crawler that indexes for later retrieval (GPTBot, ClaudeBot, PerplexityBot, CCBot, meta-externalagent) honors robots.txt and does not execute JavaScript; only Googlebot and Applebot render pages. NEMAR's server-rendered JSON-LD is therefore not just good SEO — it is the only content most AI crawlers can see at all.

- Vercel/MERJ analyzed 500M+ GPTBot fetches and found **zero JavaScript execution** by GPTBot, ClaudeBot, or PerplexityBot; they fetch `.js` files but never run them ([Vercel, "The rise of the AI crawler," 2024-12-17](https://vercel.com/blog/the-rise-of-the-ai-crawler)).
- OpenAI: `GPTBot` (training crawl), `OAI-SearchBot` (search/citation crawl), `ChatGPT-User` (live per-request fetch, "not used for crawling the web in an automatic fashion") — all robots.txt-compliant (platform.openai.com/docs/bots).
- Anthropic: `ClaudeBot` (training), `Claude-SearchBot` (search index), `Claude-User` (live fetch) — all three, including the live-fetch agent, honor robots.txt (docs.claude.com crawler policy).
- Perplexity: `PerplexityBot` (indexing) honors robots.txt, but **`Perplexity-User` "generally ignores robots.txt rules"** on live fetches (docs.perplexity.ai). Cloudflare separately documented Perplexity using undeclared, rotating UAs/IPs to fetch pages disallowing `PerplexityBot` (Cloudflare blog, 2025-08).
- `Google-Extended` is not a crawler — a robots.txt token Google evaluates against pages Googlebot already fetched, controlling Gemini training/grounding independently of Search inclusion.
- `bingbot` executes JavaScript (Chromium); its index also backs Yahoo, DuckDuckGo, and Copilot's web grounding. `Applebot-Extended` (Apple Intelligence training) is independently controllable from `Applebot` (Siri/Spotlight).
- `CCBot` is a plain, non-JS GET fetcher whose WARC archive is reused as upstream training data by many labs beyond Common Crawl itself.

**Recommendation for NEMAR:** replace the current `User-agent: * / Allow: /` with an explicit block naming every AI-adjacent bot (harmless under the wildcard, but explicit tokens are what several vendors' own tooling checks for) plus a `Sitemap:` line:

```
User-agent: *
Allow: /

User-agent: GPTBot
User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: ClaudeBot
User-agent: Claude-SearchBot
User-agent: Claude-User
User-agent: PerplexityBot
User-agent: Google-Extended
User-agent: Applebot
User-agent: Applebot-Extended
User-agent: meta-externalagent
User-agent: CCBot
Allow: /

Sitemap: https://nemar.org/sitemap.xml
```
(Stacked `User-agent` lines sharing one `Allow: /` is valid robots.txt syntax.)

## 2. Google Dataset Search and dataset registries

**Verdict:** Google Dataset Search's requirements are well documented and match what NEMAR already emits; there is no evidence any conversational AI product retrieves from it or from re3data/FAIRsharing/DataCite Commons directly, so those registries are worth joining for their own (real, scholarly-infrastructure) value, not as a proven AI-agent channel.

- Google requires few strictly-mandatory fields but rewards `creator` (ORCID/ROR in `sameAs`), `identifier` (DOI), `license` (URL), `keywords`, `isAccessibleForFree`, `temporalCoverage`/`spatialCoverage`, and `distribution` (`DataDownload` with `contentUrl`+`encodingFormat`); text truncates at 5,000 characters ([developers.google.com/search/docs/appearance/structured-data/dataset](https://developers.google.com/search/docs/appearance/structured-data/dataset)). NEMAR's JSON-LD covers nearly all of this.
- No primary source found stating ChatGPT, Claude, Perplexity, or Gemini query Google Dataset Search, DataCite Commons, re3data, FAIRsharing, OpenAIRE, or Wikidata for conversational answers — unverified, not disproven.
- **re3data.org**: free listing via application form; a project team evaluates the site against its schema/handbook, a second reviewer validates before publication ([re3data.org/faq](https://www.re3data.org/faq)).
- **FAIRsharing.org**: curated registry; its ~1,900 repository records cross-link to re3data/SciCrunch and import into OpenAIRE Explore as one de-duplicated record per repository (blog.fairsharing.org).
- **OpenAIRE**: requires re3data registration first ([openaire.eu/validator-registration-guide](https://www.openaire.eu/validator-registration-guide)); open to non-EU repositories passing its compatibility guidelines.
- **DataCite Metadata Schema 4.5/4.6**: `resourceTypeGeneral` is now required; `Subject`, `Contributor`, `Date`, `RelatedIdentifier`, `Description`, `GeoLocation` are recommended for discoverability ([datacite-metadata-schema.readthedocs.io](https://datacite-metadata-schema.readthedocs.io/en/4.6/appendices/appendix-1/resourceTypeGeneral/)).
- **Wikidata**: OpenNeuro has an item, **Q23891141** ("neuroimaging database," 25 statements, verified 2026-09-03) — direct precedent; no NEMAR item found yet.
- **Hugging Face**: dataset cards are a rendered `README.md` plus YAML metadata driving Hub search ([huggingface.co/docs/hub/datasets-cards](https://huggingface.co/docs/hub/datasets-cards)); a documented "card-only, data-stays-elsewhere" pattern was not found — unverified.

**Recommendation for NEMAR:** register the repository (not per-dataset) in re3data, then FAIRsharing and OpenAIRE (re3data is a prerequisite for both); create a Wikidata item mirroring OpenNeuro's shape; audit DataCite records for `resourceTypeGeneral` and the recommended-field set. Don't build an HF mirror yet — unverified, low-confidence.

## 3. Real-world uptake of llms.txt, AGENTS.md, markdown mirrors, and Signposting

**Verdict:** Of the four, only Signposting has confirmed real-world consumers (scholarly-repository software, not AI agents). `llms.txt` has an on-the-record vendor denial. AGENTS.md is strong evidence — but for a different mechanism (coding agents reading a file inside a checked-out repo) than the one in question (a website root discovered by browsing agents).

- **llms.txt**: Ahrefs analyzed 137,210 domains' May 2026 server logs — 28% published a valid `llms.txt`, and **97% of published files received zero requests** that month; GPTBot led AI bots at just 4.51% of requests ([ahrefs.com/blog/llmstxt-study/](https://ahrefs.com/blog/llmstxt-study/), 2026-06-15). Google's John Mueller, asked if referencing it was an endorsement: *"no"* — Search Central now states it "won't harm (nor help)... Google Search ignores them" ([Search Engine Roundtable](https://www.seroundtable.com/google-does-not-endorse-llms-txt-40789.html)). A 10-site Search Engine Land tracking study found no consistent AI-referral effect (searchengineland.com/does-llms-txt-matter-467740, 2026-01-20).
- **AGENTS.md**: the repo-root convention is genuinely adopted — 60k+ open-source projects, backed by OpenAI Codex, Google Jules, Cursor (agents.md), donated (with MCP) to the Linux Foundation's Agentic AI Foundation on 2025-12-09. But this is coding agents reading a file in a git checkout, not a website-root file discovered the way robots.txt is. No evidence found of any browsing/search agent fetching a site-root `AGENTS.md`; the unadopted proposals for that use case go by different names (`webagents.md`, `agents.txt`).
- **Markdown mirrors**: Mintlify documents serving `.md` via URL suffix and `Accept: text/markdown` negotiation, framed as an efficiency claim ("30x more efficient") — but cites no server-log evidence of agents requesting markdown (mintlify.com/blog/context-for-agents, 2026-01-29). No independent uptake data found anywhere.
- **Signposting**: signposting.org lists 30+ real adopters — Zenodo, DSpace 7, InvenioRDM, HAL, Pangaea, CKAN — but every listed consumer is scholarly/library infrastructure, not an AI agent.

**Recommendation for NEMAR:** ship Signposting `Link` headers (`cite-as`, `describedby`) on dataset pages — cheap, and plugs NEMAR into real repository-interop tooling. Ship `llms.txt` and markdown mirrors only as near-zero-cost, no-regret additions — don't report them internally as an AI-findability win, since the best evidence says they aren't being read. Skip a crawler-facing `AGENTS.md` at the site root; it targets a use case with no vendor support (distinct from `nemar-cli`'s own repo-level `AGENTS.md`).

## 4. What makes a dataset page rank / get retrieved

**Verdict:** Server-rendered facts in the first kilobytes matter more for AI crawlers than for Google, since most AI crawlers cannot execute JS at all; sitemap `lastmod` has a direct documented line to Bing/Copilot answer freshness; `rel=canonical` should never point off nemar.org toward OpenNeuro.

- The Vercel/MERJ finding from Q1 is the single most load-bearing point here too: content invisible to a non-JS fetch is invisible to GPTBot, ClaudeBot, and PerplexityBot outright.
- Bing ties `lastmod` directly to AI answers: "freshness signals directly influence how quickly updates are reflected in search results and AI generated answers" ([blogs.bing.com/webmaster](https://blogs.bing.com/webmaster/July-2025/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search), 2025-07-31); Google uses `lastmod` "if it's consistently and verifiably accurate." Both ignore `priority`/`changefreq`.
- Google's crawl-budget guidance (Mueller/Illyes) says budget only becomes a real constraint above ~1M pages/week updated or 10K+/day — NEMAR (hundreds of datasets) is far below this; page speed matters only insofar as "don't be pathologically slow or erroring."
- Google's 2023 duplicate-content guidance **recommends the downstream/republishing site decide on indexing**, not blanket `rel=canonical` to the origin ([developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)). NEMAR isn't byte-identical to OpenNeuro (adds its own DOI, BIDS-validation status, Zarr access, QA outputs) — `sameAs` is the correct link; no dataset page should carry a canonical pointing away from nemar.org.
- DataCite's resolver supports Accept-header negotiation from a DOI to schema.org/JSON-LD, Citeproc JSON, BibTeX, RIS, Codemeta, and JATS, no auth required ([support.datacite.org/docs/datacite-content-resolver](https://support.datacite.org/docs/datacite-content-resolver)) — automatic once metadata is complete, no new NEMAR code needed.
- Weaker, secondary evidence (Search Engine Land, 15-domain study): a self-contained "answer capsule" under a question-framed H2 was present in 72.4% of ChatGPT-cited pages — directionally consistent with a 2–3 sentence summary near the top of each dataset page, but one study, not a vendor spec.

**Recommendation for NEMAR:** add real, event-driven `lastmod` (tied to version/DOI/metadata events, not build time) to sitemap.xml; never emit `rel=canonical` pointing to openneuro.org; keep `sameAs` as the sole cross-repository link; verify DataCite metadata completeness so content negotiation returns rich results by default.

## 5. Machine-usable access: OpenAPI, MCP, plain REST, and Zarr streaming guidance

**Verdict:** OpenAPI is the right near-term investment for `api.nemar.org` — cheap and directly consumable by OpenAI Actions and OpenAPI-aware coding agents. MCP is real and growing fast but suited to stateful/authenticated action-taking, not yet needed by NEMAR's mostly-read API. For Zarr, "stream by default, download when touching most of the array" is the cross-archive consensus.

- OpenAI's Custom GPT Actions consume OpenAPI 3.0.1/3.1.0 specs directly (platform.openai.com/docs/actions/getting-started). A vendor benchmark (APImatic, 2026-08-07) ran Claude Opus against a 13k-line integration task: vanilla agent scored 13.8/24 on a resilience-focused readiness gate, a supplied OpenAPI spec 15.0/24, a "Docs MCP" server 17.2/24 — all completed the basic task; the gap was error-handling/resilience, not core success (apimatic.io/blog — vendor-authored, not neutral).
- MCP adoption is vendor-broad: OpenAI added client support in March 2025; by December 2025 Anthropic donated MCP (and, separately, `AGENTS.md`) to a new Linux-Foundation-hosted Agentic AI Foundation with OpenAI and Block as co-founders (blog.modelcontextprotocol.io, 2025-12-09).
- For NEMAR: given its public surface is mostly search/read/download, an OpenAPI document generated from existing Worker route definitions clears the bar for correct basic usage at a fraction of the cost of a bespoke MCP server; revisit MCP if NEMAR later wants agents to *drive* uploads/validation/publication, not just read.
- **Zarr streaming guidance across comparable archives**: DANDI/PyNWB frames streaming as for reading small pieces of a large remote file (fsspec/remfile/h5py-ros3 tradeoffs, no fixed size threshold; pynwb.readthedocs.io). Pangeo streams by default via `xr.open_zarr(fsspec.get_mapper(...), consolidated=True)` to minimize egress, architectural not size-conditional. NASA's Earthdata Cloud Cookbook gives the most concrete rule: stream in-region (`us-west-2`), download outside it (nasa-openscapes.github.io). Microsoft Planetary Computer resolves a STAC item, signs a short-lived URL, opens with xarray — the **catalog itself** declares `xarray:open_kwargs`, a direct precedent for `index.json` carrying its own `layout`. OpenNeuro itself gives **no** streaming guidance (docs.openneuro.org/user_guide.html) — a differentiation opportunity for NEMAR. Allen Institute's docs are download-oriented; no stream guidance found.

**Recommendation — Zarr guidance for NEMAR's per-dataset card and docs (≤10 lines):**
1. Start at `index.json` under `contract_base`; never hardcode a bucket path.
2. Read per-dataset `data_base`/`s3_uri` from `index.json`, not a guessed prefix.
3. Default to streaming: `zarr.open(store, mode="r")` or `xr.open_zarr(fsspec.get_mapper(data_base), consolidated=True)`.
4. Stream for a slice of channels/time/subjects; download only when touching most of the array (DANDI's framing, not a size cutoff).
5. Use `s3fs`/`fsspec` for S3 URIs, plain HTTPS `fsspec` for `zarr.nemar.org`.
6. Use `HEAD` for existence/metadata checks — never redirected. Plain `GET` with no allowlisted browser `Origin` 302s to S3; follow redirects.
7. Only `index.json` is always proxied/edge-cached; `manifest.json`/`events.parquet` redirect like store objects for non-browser clients.
8. Read the store's `nemar` root attribute (DOI, license, citation, source commit) before reuse.
9. Filter on `has_zarr_verified`, not just `has_zarr`, for agent pipelines.

## 6. Is Croissant worth emitting?

**Verdict:** Worth emitting only as an optional, low-priority interop export judged on concrete discovery gain — not a required target alongside schema.org Dataset and BIDS metadata, and its data model is a real, non-trivial mismatch for raw neurophysiology time-series.

- Croissant extends schema.org with a `cr:` namespace (`http://mlcommons.org/croissant/`) across four layers — Dataset Metadata (reuses `name`/`description`/`license`), Resource, Structure (`RecordSet`/`Field`), Semantic — announced by MLCommons 2024-03-06 with Hugging Face, Google Dataset Search, Kaggle, and OpenML as launch adopters ([mlcommons.org/2024/03/croissant_metadata_announce](https://mlcommons.org/2024/03/croissant_metadata_announce/)). By February 2025, MLCommons reported 700,000+ datasets discoverable via Google Dataset Search through Croissant (mlcommons.org/2025/02/croissant-qa-community). Hugging Face auto-generates it for Hub datasets (huggingface.co/docs/dataset-viewer/en/croissant).
- Marginal cost given NEMAR's existing JSON-LD is real but not zero: the Dataset Metadata Layer reuses fields NEMAR already emits, but the Structure Layer requires authoring `RecordSet`/`Field` declarations for tabular structure (`participants.tsv`, `channels.tsv`, `events.tsv`) — genuine incremental work, not a namespace bolt-on.
- Domain fit is unverified and likely weak for raw signal files: Croissant's `RecordSet` model targets row/column or image+label data; no precedent found for Croissant applied to raw BIDS/EEG/MEG time-series. It plausibly fits NEMAR's tabular sidecars, not the recordings themselves.

**Recommendation for NEMAR:** don't treat Croissant as required. BIDS and HED are the peer standards for this data — schema.org Dataset + BIDS metadata is the canonical card; emit Croissant only for tabular sidecars if a concrete discovery-channel gain (a Hugging Face or Kaggle listing, specifically) is worth pursuing.

## Prioritized artifact table

| Artifact | Evidence strength | Effort | Recommendation |
|---|---|---|---|
| robots.txt naming AI crawler tokens | Strong (vendor docs, every token) | S | Do now |
| sitemap.xml, real event-driven `lastmod` | Strong (Google + Bing tie it to AI-answer freshness) | S | Do now |
| Complete DataCite metadata | Strong (content negotiation is automatic once complete) | S | Do now |
| re3data + FAIRsharing + OpenAIRE registration | Strong for scholarly-infra; no confirmed LLM-agent channel | S–M | Do now |
| Wikidata item for NEMAR | Moderate (precedent: OpenNeuro Q23891141) | S | Do now |
| OpenAPI document for api.nemar.org | Moderate-strong (Actions consume directly; benchmark shows gain) | M | Do now |
| Zarr stream-vs-download guidance | Strong precedent (DANDI/Pangeo/NASA); OpenNeuro has none | S | Do now |
| Never canonicalize to openneuro.org; `sameAs` only | Strong (explicit Google guidance) | S | Do now (policy) |
| Signposting `Link` headers | Strong adoption, but by repository software, not AI agents | S | Do later |
| `llms.txt` | No use evidence; Google denial on record | S | Do later (no-regret) |
| Markdown mirrors / content negotiation | No uptake evidence, capability-only vendor claims | S–M | Do later |
| Croissant, tabular sidecars only | Real but narrow (HF/Kaggle/Google); mismatch for raw signals | M | Do later |
| Site-root `AGENTS.md` for crawler discovery | No evidence; conflates with unrelated repo-root convention | S | Skip |
| Bespoke MCP server for api.nemar.org | Real ecosystem growth, but NEMAR's surface is mostly read-only | L | Skip (for now) |

## What could not be verified

- Whether any conversational AI product queries Google Dataset Search, DataCite Commons, re3data, FAIRsharing, OpenAIRE, or Wikidata as a retrieval source — no primary source either way.
- Whether agentic browsers (Atlas, Comet, Copilot browsing) honor robots.txt differently from their documented "-User" fetchers.
- A documented, low-cost "card-only, data hosted elsewhere" Hugging Face mirroring pattern for a non-HF-hosted archive.
- Numeric MCP adoption figures (SDK downloads, enterprise-team percentages) come from secondary aggregators, not cross-verified against one primary report.
- Any real-world precedent for Croissant applied to BIDS/EEG/MEG/iEEG time-series data — none found either way.
