# /// script
# requires-python = ">=3.11"
# dependencies = ["sentence-transformers>=3", "numpy", "torch"]
# ///
"""Record what the real models say about the fixture catalog, for the search tests.

    bun scripts/search-eval/dump-texts.ts > /tmp/texts.json
    uv run scripts/search-eval/model_outputs.py /tmp/texts.json \
        test/fixtures/search-relevance/cases.json \
        test/fixtures/search-relevance/model-outputs.json

A new case in cases.json needs both strings: `semantic` is the text that is embedded and
`rerank` the text the cross-encoder is asked about. Get them from the production analysis:
`bun scripts/search-eval/dump-texts.ts --analyze "your query"` prints them as `semantic` and
`rerank`.

Cloudflare's `@cf/baai/bge-small-en-v1.5` and `@cf/baai/bge-reranker-base` are believed, not
verified, to serve the open BAAI weights of the same names (precision and quantization are
Cloudflare's), so the numbers recorded here are what those weights say about these exact
texts. The tests replay them in place of the two network calls (the search code
around them -- fusion, the cutoff, hydration, counting -- runs for real). Embedding uses mean
pooling, which is what the Workers AI binding does when `pooling` is not passed. Reranker
scores are recorded as raw logits, because that is what Cloudflare documents the binding as
returning. Each text is recorded with its SHA-256 so a test fails loudly, instead of replaying
stale numbers, when the text builder changes.
"""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import CrossEncoder, SentenceTransformer, models

NEAREST = 100


def main(texts_path: Path, cases_path: Path, out_path: Path) -> None:
    texts: dict[str, str] = json.loads(texts_path.read_text())
    cases: list[dict[str, str]] = json.loads(cases_path.read_text())
    ids = sorted(texts)

    transformer = models.Transformer("BAAI/bge-small-en-v1.5", max_seq_length=512)
    embedder = SentenceTransformer(
        modules=[
            transformer,
            models.Pooling(transformer.get_embedding_dimension(), pooling_mode="mean"),
            models.Normalize(),
        ]
    )
    reranker = CrossEncoder("BAAI/bge-reranker-base", max_length=512)

    doc_vectors = embedder.encode(
        [texts[i] for i in ids], batch_size=32, normalize_embeddings=True
    )
    semantic: dict[str, list] = {}
    rerank: dict[str, dict[str, float]] = {}
    for case in cases:
        query_vector = embedder.encode([case["semantic"]], normalize_embeddings=True)[0]
        cosines = doc_vectors @ query_vector
        order = np.argsort(-cosines)[:NEAREST]
        semantic[case["semantic"]] = [
            [ids[i], round(float(cosines[i]), 4)] for i in order
        ]
        logits = reranker.predict(
            [(case["rerank"], texts[i]) for i in ids],
            batch_size=16,
            show_progress_bar=False,
            activation_fn=torch.nn.Identity(),
        )
        rerank[case["rerank"]] = {i: round(float(x), 3) for i, x in zip(ids, logits)}

    out = {
        "generated_with": {
            "embedding": "BAAI/bge-small-en-v1.5, mean pooling",
            "reranker": "BAAI/bge-reranker-base, raw logits",
        },
        "text_sha256": {i: hashlib.sha256(texts[i].encode()).hexdigest() for i in ids},
        "semantic": semantic,
        "rerank": rerank,
    }
    out_path.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(
        f"{len(ids)} datasets x {len(cases)} cases -> {out_path} ({out_path.stat().st_size // 1024} KiB)"
    )


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
