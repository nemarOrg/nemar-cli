# /// script
# requires-python = ">=3.11"
# dependencies = ["sentence-transformers>=3", "numpy", "torch"]
# ///
"""Reproduce the relevance calibration in backend/src/services/search-rerank.ts.

    uv run scripts/search-eval/fetch_corpus.py /tmp/eval
    bun scripts/search-eval/dump-texts.ts --corpus /tmp/eval/corpus.json > /tmp/eval/texts.json
    uv run scripts/search-eval/calibrate.py /tmp/eval/corpus.json /tmp/eval/texts.json

It replays the search pipeline on the whole public catalog with the open BAAI weights that
Workers AI serves, for 37 queries: 22 that were used to choose the cutoff rule and 15 that were
frozen before they were run. Each query has a truth set: the datasets whose own name,
description, keywords or tasks match a regex for the topic. The truth sets read the same fields
the cross-encoder reads, so they favor it; what does not depend on that is the held-out gap
between rules.

It prints two tables: the semantic leg under the old and the new embedding text, and the
precision, coverage and list length of each cutoff rule. Rerun it, and revisit the constants in
search-rerank.ts, when the catalog grows by a few hundred datasets or the model changes.
"""

import json
import re
import sqlite3
import sys
from pathlib import Path

import numpy as np
from sentence_transformers import CrossEncoder, SentenceTransformer, models

# --- queries and truth -----------------------------------------------------------------------
TUNING = {
    "bilingual performance study": r"bilingual|multilingual|second.language|\bL2\b",
    "sleep stage classification during overnight recording": r"\bsleep",
    "motor imagery brain-computer interface": r"motor.imagery",
    "epilepsy seizure detection with intracranial electrodes": r"epilep|seizure|ictal",
    "infant EEG development": r"infant|newborn|neonat|toddler",
    "driving simulation and fatigue": r"driving|driver|drowsi",
    "decoding speech from brain signals": r"speech|spoken|articulat|inner.speech|imagined.speech",
    "emotion recognition while listening to music": r"music",
    "resting state eyes closed": r"resting|eyes.closed|eyes.open|\brest\b",
    "children with ADHD": r"adhd|attention.deficit",
    "working memory n-back task": r"working.memory|n-back|nback|sternberg",
    "meditation": r"meditat|mindful",
    "steady state visual evoked potentials": r"ssvep|steady.state",
    "language comprehension N400 sentences": r"n400|sentence|semantic|language.comprehension",
    "Parkinson's disease": r"parkinson",
    "auditory oddball P300": r"oddball|p300|\bp3\b",
    "surface EMG gesture recognition": r"\bemg\b|electromyo",
    "naturalistic movie watching MEG": r"movie|film|naturalistic|forrest",
    "sleep": r"\bsleep",
    "alzheimers dementia": r"alzheimer|dementia",
    "anesthesia consciousness": r"anesthe|anaesthe|propofol|sedat|unconscious",
    "reading aloud Chinese": r"chinese|mandarin",
}
HELD_OUT = {
    "schizophrenia patients EEG": r"schizophren|psychosis|psychotic",
    "face perception N170": r"\bface|n170",
    "gait walking mobile EEG": r"walking|gait|locomot|treadmill",
    "visual attention spatial cueing alpha": r"attention|cueing|spatial",
    "depression mood disorder": r"depress|mood|\bmdd\b",
    "deep brain stimulation subthalamic nucleus": r"deep brain stimulation|subthalamic|\bstn\b|\bdbs\b",
    "reinforcement learning reward feedback": r"reinforcement|reward|feedback|gambling",
    "autism children social": r"autis|\basd\b",
    "pain perception": r"\bpain",
    "mental arithmetic cognitive workload": r"arithmetic|workload|mental.calculation|mental.math",
    "handwriting typing keyboard": r"handwrit|typing|keyboard",
    "fNIRS hemodynamic prefrontal": r"fnirs|nirs|hemodynamic",
    "second language learners": r"second.language|language.learn|foreign.language|bilingual",
    "high gamma electrocorticography": r"ecog|electrocortico|high.gamma",
    "ketamine psychedelic": r"ketamine|psychedelic|\blsd\b|psilocybin",
}

# --- the pipeline, as search-query.ts / dataset-search.ts / search-rerank.ts run it ----------
STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "has",
    "have",
    "how",
    "in",
    "into",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "that",
    "the",
    "their",
    "this",
    "to",
    "was",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "with",
    "during",
    "using",
    "use",
    "via",
    "about",
    "between",
    "after",
    "before",
    "under",
    "over",
    "within",
    "across",
    "than",
    "then",
    "these",
    "those",
    "can",
    "find",
    "show",
    "get",
}
GENERIC_DF_MAX = 0.25
LEG_SIZE = 30
BM25_WEIGHTS = (10, 5, 1, 4, 1, 1)
ENDORSE_MIN, ENDORSE_RELATIVE, AGREE_MIN = 0.10, 0.20, 0.005


def tokens(query: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", query.lower()) if len(t) >= 2]


def rrf(*lists: list[int], k: int = 60) -> list[int]:
    score: dict[int, float] = {}
    for ranked in lists:
        for rank, i in enumerate(ranked):
            score[i] = score.get(i, 0.0) + 1 / (k + rank + 1)
    return sorted(score, key=lambda i: -score[i])


def old_embedding_text(r: dict) -> str:
    """The embedding text this work retired: name, modalities, tasks, authors, README[:1000]."""
    parts = [
        r["name"],
        f"Modalities: {r['modalities']}" if r["modalities"] else "",
        f"Tasks: {r['tasks']}" if r["tasks"] else "",
        f"Authors: {r['authors']}" if r["authors"] else "",
        r["readme"][:1000],
    ]
    return "\n".join(p for p in parts if p)


def main(corpus_path: Path, texts_path: Path) -> None:
    rows = json.loads(corpus_path.read_text())
    new_texts = json.loads(texts_path.read_text())
    ids = [r["id"] for r in rows]
    n = len(rows)

    transformer = models.Transformer("BAAI/bge-small-en-v1.5", max_seq_length=512)
    embedder = SentenceTransformer(
        modules=[
            transformer,
            models.Pooling(transformer.get_embedding_dimension(), pooling_mode="mean"),
            models.Normalize(),
        ]
    )
    reranker = CrossEncoder("BAAI/bge-reranker-base", max_length=512)
    new_vectors = embedder.encode(
        [new_texts[i] for i in ids], batch_size=32, normalize_embeddings=True
    )
    old_vectors = embedder.encode(
        [old_embedding_text(r) for r in rows], batch_size=32, normalize_embeddings=True
    )

    db = sqlite3.connect(":memory:")
    db.execute(
        "CREATE VIRTUAL TABLE f USING fts5(name, description, authors, tasks, modalities, readme)"
    )
    for i, r in enumerate(rows):
        db.execute(
            "INSERT INTO f(rowid,name,description,authors,tasks,modalities,readme) VALUES (?,?,?,?,?,?,?)",
            (
                i,
                r["name"],
                r["description"],
                r["authors"],
                r["tasks"],
                r["modalities"],
                r["readme"],
            ),
        )

    def document_frequency(t: str) -> float:
        return (
            db.execute(
                "SELECT COUNT(*) FROM f WHERE f MATCH ?", (f'"{t}"*',)
            ).fetchone()[0]
            / n
        )

    def informative(query: str) -> list[str]:
        content = [t for t in tokens(query) if t not in STOPWORDS] or tokens(query)
        kept = [t for t in content if document_frequency(t) <= GENERIC_DF_MAX]
        return kept or content

    def lexical(terms: list[str], limit: int, weights=BM25_WEIGHTS) -> list[int]:
        order = f"bm25(f,{','.join(map(str, weights))})" if weights else "bm25(f)"
        match = " OR ".join(f'"{t}"*' for t in terms)
        return [
            x[0]
            for x in db.execute(
                f"SELECT rowid FROM f WHERE f MATCH ? ORDER BY {order} LIMIT ?",
                (match, limit),
            )
        ]

    def truth_set(regex: str) -> set[int]:
        pattern = re.compile(regex, re.IGNORECASE)
        return {
            i
            for i, r in enumerate(rows)
            if pattern.search(
                " ".join(
                    [r["name"], r["description"], " ".join(r["keywords"]), r["tasks"]]
                )
            )
        }

    def r_precision(ranked, truth, cap=30):
        k = min(len(truth), cap)
        return sum(1 for i in ranked[:k] if i in truth) / k

    # --- semantic leg: old text vs new text -------------------------------------------------------
    queries = {**TUNING, **HELD_OUT}
    truths = {q: truth_set(rx) for q, rx in queries.items()}
    query_vectors = {
        q: embedder.encode([q], normalize_embeddings=True)[0] for q in queries
    }
    print("semantic leg, R-precision over all 37 queries")
    for label, vectors in (
        ("old text (README[:1000])", old_vectors),
        ("new text (abstract + keywords)", new_vectors),
    ):
        scores = [
            r_precision(list(np.argsort(-(vectors @ query_vectors[q]))), truths[q])
            for q in queries
            if truths[q]
        ]
        print(f"  {label:34s} {np.mean(scores):.3f}")
    scores = [
        r_precision(lexical(informative(q), 100, None), truths[q])
        for q in queries
        if truths[q]
    ]
    scores_w = [
        r_precision(lexical(informative(q), 100), truths[q])
        for q in queries
        if truths[q]
    ]
    print(
        f"\nlexical leg, R-precision: unweighted bm25 {np.mean(scores):.3f}, column-weighted {np.mean(scores_w):.3f}"
    )

    # --- cutoff rules -----------------------------------------------------------------------------
    def shipped_before(q: str) -> list[int]:
        sims = old_vectors @ query_vectors[q]
        semantic = [int(i) for i in np.argsort(-sims)[:100] if sims[i] >= 0.6]
        match = " OR ".join(f'"{t}"*' for t in tokens(q))
        lex = [
            x[0]
            for x in db.execute(
                "SELECT rowid FROM f WHERE f MATCH ? ORDER BY bm25(f) LIMIT 300",
                (match,),
            )
        ]
        return rrf(semantic, lex)

    def pool_and_scores(q: str):
        terms = informative(q)
        semantic = [
            int(i) for i in np.argsort(-(new_vectors @ query_vectors[q]))[:LEG_SIZE]
        ]
        lex = lexical(terms, LEG_SIZE)
        pool = rrf(semantic, lex)[: 2 * LEG_SIZE]
        p = reranker.predict(
            [(" ".join(terms), new_texts[ids[i]]) for i in pool],
            batch_size=16,
            show_progress_bar=False,
        )
        return pool, [float(x) for x in p], set(semantic) & set(lex)

    def this_rule(pool, p, both):
        floor = max(ENDORSE_MIN, ENDORSE_RELATIVE * max(p))
        return [
            pool[j]
            for j in sorted(range(len(pool)), key=lambda j: -p[j])
            if p[j] >= floor or (pool[j] in both and p[j] >= AGREE_MIN)
        ]

    def best_score_only(pool, p, _both):
        floor = max(0.05, 0.2 * max(p))
        return [
            pool[j]
            for j in sorted(range(len(pool)), key=lambda j: -p[j])
            if p[j] >= floor
        ]

    results: dict[str, dict[str, list]] = {"tuning": {}, "held-out": {}}
    for group, qs in (("tuning", TUNING), ("held-out", HELD_OUT)):
        for q in qs:
            if not truths[q]:
                continue
            pool, p, both = pool_and_scores(q)
            for name, keep in (
                ("shipped before", shipped_before(q)),
                ("fused pool, no cutoff", pool),
                ("best score only", best_score_only(pool, p, both)),
                ("this rule", this_rule(pool, p, both)),
            ):
                hit = sum(1 for i in keep if i in truths[q])
                results[group].setdefault(name, []).append(
                    (
                        hit / len(keep) if keep else 0.0,
                        min(hit / min(len(truths[q]), 30), 1.0),
                        len(keep),
                    )
                )
            print(".", end="", flush=True)
    print("\n")
    for group, by_rule in results.items():
        count = len(next(iter(by_rule.values())))
        print(f"{group} ({count} queries)")
        for name, rows_ in by_rule.items():
            a = np.mean(rows_, axis=0)
            print(
                f"  {name:22s} precision {a[0]:.2f}   coverage {a[1]:.2f}   returned {a[2]:.0f}"
            )


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
