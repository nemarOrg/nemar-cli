# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Download the public NEMAR catalog (GET /datasets, GET /datasets/:id) to one JSON file.

The search benchmark, the test fixtures and the relevance-cutoff calibration all start
from this file. Everything it reads is public. Usage:

    uv run scripts/search-eval/fetch_corpus.py OUT_DIR
"""

import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = "https://api.nemar.org"
# api.nemar.org answers the stock urllib user agent with 403.
HEADERS = {"User-Agent": "nemar-search-eval/1.0"}


def get(path: str) -> dict:
    request = urllib.request.Request(f"{API}{path}", headers=HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def main(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    ids: list[str] = []
    offset = 0
    while True:
        page = get(f"/datasets?limit=100&offset={offset}")["datasets"]
        ids += [row["dataset_id"] for row in page]
        if len(page) < 100:
            break
        offset += 100

    def detail(dataset_id: str) -> dict:
        d = get(f"/datasets/{dataset_id}")["dataset"]
        try:
            keywords = [k["term"] for k in json.loads(d.get("enrichment_json") or "{}").get("keywords", []) if isinstance(k, dict) and "term" in k]
        except (ValueError, AttributeError):
            keywords = []
        return {
            "id": d["dataset_id"], "name": d.get("name") or "", "description": d.get("description") or "",
            "authors": d.get("authors") or "", "tasks": d.get("tasks") or "", "modalities": d.get("modalities") or "",
            "readme": d.get("readme") or "", "keywords": keywords, "subject_count": d.get("subject_count"),
        }

    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(detail, ids))
    (out_dir / "corpus.json").write_text(json.dumps(rows))
    print(f"{len(rows)} datasets -> {out_dir / 'corpus.json'}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
