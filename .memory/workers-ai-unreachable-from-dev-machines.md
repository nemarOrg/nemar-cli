---
name: workers-ai-unreachable-from-dev-machines
description: "Workers AI cannot be called from a dev machine: `wrangler dev` with an AI binding fails with 'Could not create remote preview session' under the cfman SCCN token; calibrate against the open BAAI weights locally instead"
metadata:
  type: project
---

On 2026-10-29, while calibrating the relevance cutoff for ADR 0116, a scratch Worker with only `[ai] binding = "AI"` run through `bunx cfman wrangler --account sccn dev` (with and without `--remote`) started its local server and then failed on the first AI call: `Could not create remote preview session on your account`.
The AI binding always proxies to Cloudflare, and creating that preview session needs a permission the stored SCCN token does not carry.
No other route to the models was taken: the token only reaches Cloudflare through cfman's subprocess, and extracting it to call the REST API by hand would be a credential workaround, not a fix.

**Why:** Cloudflare serves the open BAAI weights (`@cf/baai/bge-small-en-v1.5`, `@cf/baai/bge-reranker-base`), so the same weights run locally give the same ranking, though not byte-identical scores (precision and quantization are Cloudflare's).

**How to apply:** for anything that depends on what those models say, run `scripts/search-eval/` with `uv` (sentence-transformers downloads the weights once, about 1.1 GB), and say plainly that latency and the exact score scale were not measured on Workers AI. The Worker logs `[search] rerank raw scores: ... read as logits|probabilities` and `[search] relevance: ... rerank_ms=` so the first deploy answers both. Do not deploy a scratch Worker to the production account to get around this. See also [[wrangler-via-cfman]].
