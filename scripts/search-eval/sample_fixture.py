# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Cut a 160-dataset sample of the real catalog for the search tests.

    uv run scripts/search-eval/sample_fixture.py CORPUS_JSON test/fixtures/search-relevance/catalog-sample.json

The tests need a catalog big enough that "how common is this word" means something
(the query analysis ignores document frequency below 100 datasets) and real enough
that the failures they guard against can happen. So: the datasets each fixture query
turns on are always in, and a seeded random draw fills the rest, which keeps word
frequencies close to the full catalog's. READMEs are cut to 1200 characters.
"""

import json
import random
import sys
from pathlib import Path

SIZE = 160
SEED = 7
README_CHARS = 1200

FORCED = {
    # bilingual / speech, and the driving, BCI and study-heavy datasets the old OR-of-words search returned for it
    "bilingual": ["nm000241", "nm000365", "on004718", "on005345", "on005946", "on004015", "nm000228", "nm000259"],
    "driving": ["on004118", "on004120", "on004122", "on004105", "on004123", "on004121", "on004119", "on004106", "nm000275", "on004657"],
    "study-and-performance": ["nm000200", "nm000340", "nm000176", "nm000197", "nm000338", "nm000323", "on004395", "on004602", "on004865", "nm000314", "nm000335", "nm000184", "nm000262"],
    "sleep": ["nm000111", "nm000185", "nm000225", "on005555", "on004348", "on005185", "on005178", "nm000481", "nm000360", "on005207", "on003768"],
    "motor-imagery": ["nm000245", "nm000347", "nm000348", "nm000329", "nm000318", "nm000270", "nm000250", "nm000316", "nm000295", "nm000177"],
    "author-query": ["on001787", "on001971", "on002578", "on002680"],
    "adhd": ["on005863", "on006018", "nm000256", "nm000255", "on005512", "on006260"],
}


def main(corpus_path: Path, out_path: Path) -> None:
    rows = json.loads(corpus_path.read_text())
    by_id = {r["id"]: r for r in rows}
    forced = [i for group in FORCED.values() for i in group]
    missing = [i for i in forced if i not in by_id]
    if missing:
        sys.exit(f"forced ids no longer in the catalog: {missing}")
    rest = sorted(set(by_id) - set(forced))
    random.Random(SEED).shuffle(rest)
    chosen = sorted(set(forced) | set(rest[: SIZE - len(set(forced))]))
    sample = [{**by_id[i], "readme": by_id[i]["readme"][:README_CHARS]} for i in chosen]
    out_path.write_text(json.dumps(sample, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(sample)} datasets, {out_path.stat().st_size // 1024} KiB -> {out_path}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
