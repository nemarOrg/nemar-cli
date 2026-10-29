---
name: cross-encoder-predict-already-applies-sigmoid
description: "sentence-transformers CrossEncoder.predict already returns probabilities for a one-label reranker; applying a sigmoid again squeezes every score into 0.50-0.73 and makes a relevance cutoff keep everything"
metadata:
  type: feedback
---

On 2026-10-29 the first reranker run for ADR 0116 printed 0.541, 0.505, 0.504, 0.503 for every candidate of every query, including the obviously wrong ones. The harness had wrapped `CrossEncoder("BAAI/bge-reranker-base").predict(...)` in a logistic function; `predict` already applies a sigmoid for a model with one output label, so the harness applied it twice: sigmoid(sigmoid(x)) lies in (0.5, 0.73).

**Why:** a doubled sigmoid does not fail; it produces plausible-looking numbers that are nearly flat, and any threshold read from them is wrong.

**How to apply:** read the first scores before tuning on them: a spread that never leaves 0.50 to 0.73 means a second squashing. For raw logits pass `activation_fn=torch.nn.Identity()` to `predict` (`scripts/search-eval/model_outputs.py` does, because Cloudflare documents the binding as returning a raw score). The Worker guards the same trap from the other side: `normalizeRerankScores` treats a set entirely inside [0, 1] as probabilities already.
