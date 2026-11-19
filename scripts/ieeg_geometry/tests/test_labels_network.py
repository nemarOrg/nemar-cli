"""Label inference over every electrodes file of two verified track-C datasets.

Marked `network`: files are downloaded once into the cache outside the repository
(`$IEEG_GEOMETRY_CACHE`, default `~/.cache/ieeg_geometry_tests`); CI skips the marker.
Run with `uv run pytest -q -m network tests/test_labels_network.py`.
"""

import http.client
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from ieeg_geometry import labels

pytestmark = pytest.mark.network

CACHE = Path(os.environ.get("IEEG_GEOMETRY_CACHE", Path.home() / ".cache" / "ieeg_geometry_tests"))
RAW = "https://raw.githubusercontent.com/nemarDatasets"
API = "https://api.github.com/repos/nemarDatasets"


def _get(url: str) -> bytes:
    request = urllib.request.Request(url)
    if token := os.environ.get("GITHUB_TOKEN"):
        request.add_header("Authorization", f"Bearer {token}")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=120) as resp:  # noqa: S310 - fixed https URLs
                return resp.read()
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    raise AssertionError("unreachable")


def _dataset(dataset: str, limit: int | None = None) -> Path:
    """Electrodes files (the first `limit` in path order, or all), neighbors and the README."""
    root = CACHE / "labels" / (dataset if limit is None else f"{dataset}-first{limit}")
    done = root / ".complete"
    if not done.exists():
        tree = json.loads(_get(f"{API}/{dataset}/git/trees/HEAD?recursive=1"))["tree"]
        paths = sorted(t["path"] for t in tree)
        electrodes = [p for p in paths if p.endswith("_electrodes.tsv")]
        chosen = electrodes if limit is None else electrodes[:limit]
        folders = {p.rsplit("/", 1)[0] for p in chosen}
        wanted = [
            p
            for p in paths
            if p == "README.md"
            or (
                p.rsplit("/", 1)[0] in folders
                and p.endswith(("_electrodes.tsv", "_channels.tsv", "_coordsystem.json"))
                and (p in chosen or not p.endswith("_electrodes.tsv"))
            )
        ]
        for rel in wanted:
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(_get(f"{RAW}/{dataset}/HEAD/{rel}"))
        done.write_text("\n".join(wanted))
    return root


# (dataset, files to check, or None for all)
TRACK_C = [
    ("on005007", None),
    ("on004370", None),
    ("on006914", 6),
    ("on006233", 6),
    ("on005545", 6),
    ("on005931", 6),
    ("on006107", 6),
    ("on006910", 6),
    ("on004551", 6),
]
EXPECTED_FILES = {"on005007": 42, "on004370": 7}
_OUTCOMES: dict[str, list[tuple[str, str, str | None]]] = {}


@pytest.mark.parametrize(("dataset", "limit"), TRACK_C)
def test_every_electrodes_file_is_labeled_fsaverage(dataset, limit):
    plan = labels.plan_dataset(_dataset(dataset, limit))
    outcome = [(p.electrodes, p.status, p.label) for p in plan.proposals]
    _OUTCOMES[dataset] = outcome
    assert len(outcome) == EXPECTED_FILES.get(dataset, limit), outcome
    bad = [o for o in outcome if o[1:] != (labels.ACCEPTED, "fsaverage")]
    assert not bad, bad
    for p in plan.proposals:
        assert p.attempts[-1].fit is not None and p.attempts[-1].fit.median_mm <= 1.0


def test_track_c_outcome_rates(capsys):
    """Runs after the parametrized test above; prints the counts the PR quotes."""
    total = {labels.ACCEPTED: 0, labels.NEEDS_HUMAN: 0, labels.REJECTED: 0, "other": 0}
    for dataset, outcome in _OUTCOMES.items():
        counts = {}
        for _, status, _ in outcome:
            counts[status] = counts.get(status, 0) + 1
            total[status if status in total else "other"] += 1
        print(f"{dataset}: {len(outcome)} files {counts}")
    n = sum(total.values())
    print(f"all {len(_OUTCOMES)} datasets: {n} files {total}")
    assert n and total[labels.NEEDS_HUMAN] == 0 and total[labels.REJECTED] == 0
